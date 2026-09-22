#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classifyProviderFailure } = require("./dogfood-provider-budget.cjs");

const repoRoot = path.resolve(__dirname, "../..");
const canonicalRunner = path.join(repoRoot, "benchmarks/product-v1/dogfood-runner.cjs");
const suitePath = path.join(repoRoot, "benchmarks/product-v1/dogfood-v1.json");
const CHECKPOINT_SCHEMA_VERSION = "product-dogfood-resume-checkpoint/v1";
// Coarse outer kill switch only. The canonical per-task runner owns the
// authoritative comparison phase budgets and must be allowed to finish first.
const CHILD_TIMEOUT_MS = 60 * 60 * 1000;
const PHASE_BUDGETS_MS = Object.freeze({ discovery: 180_000, agent: 300_000,
  validationCommand: 120_000, taskEnvelope: CHILD_TIMEOUT_MS });

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const args = {
    live: false,
    resume: false,
    output: null,
    stopFile: null,
    model: process.env.BOUNDED_CODEX_MODEL || process.env.CODEX_MODEL || null
  };
  for (const arg of argv) {
    if (arg === "--live") {
      args.live = true;
      continue;
    }
    if (arg === "--resume") {
      args.resume = true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      args.output = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--stop-file=")) {
      args.stopFile = path.resolve(arg.slice("--stop-file=".length));
      continue;
    }
    if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length).trim();
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function progress(message) {
  process.stderr.write(`[DOGFOOD] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || CHILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}${result.error ? `: ${result.error}` : ""}`);
  }
}

function repositoryHeadSha() {
  const result = run("git", ["rev-parse", "HEAD"], { timeout: 10_000 });
  requireSuccess(result, "runner repository head");
  return result.stdout.trim().toLowerCase();
}

function loadSuiteTasks() {
  const suite = readJson(suitePath);
  assert.equal(suite.schemaVersion, "product-dogfood-suite/v1");
  assert.equal(suite.suiteId, "product-v1-first-20-real-dogfood");
  const taskset = readJson(path.join(repoRoot, suite.taskFile));
  assert.equal(taskset.schemaVersion, "product-dogfood-taskset/v1");
  assert.equal(taskset.suiteId, suite.suiteId);
  assert.equal(Array.isArray(taskset.tasks), true);
  assert.equal(taskset.tasks.length, 20);
  assert.equal(new Set(taskset.tasks.map((task) => task.taskId)).size, 20);
  return { suite, tasks: taskset.tasks };
}

function checkpointPath(output) {
  return `${output}.checkpoint.json`;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function runIdentityHash({ suite, tasks, model, runnerHeadSha }) {
  return sha256(JSON.stringify({
    suiteId: suite.suiteId,
    model,
    reasoningEffort: suite.comparison.reasoningEffort,
    runnerHeadSha,
    comparison: suite.comparison,
    phaseBudgetsMs: PHASE_BUDGETS_MS,
    tasks: tasks.map((task) => ({ taskId: task.taskId, commitSha: task.commitSha,
      validationCommands: task.validationCommands, armOrder: armOrder(task) }))
  }));
}

function providerTaskText(task) {
  return [task.objective, "", "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`), "",
    "Validation commands:", ...task.validationCommands.map((command) => `- ${command}`)].join("\n");
}

function armOrder(task) {
  const digest = crypto.createHash("sha256").update(providerTaskText(task), "utf8").digest("hex");
  return Number.parseInt(digest.slice(-1), 16) % 2 === 0
    ? ["baseline", "bounded"] : ["bounded", "baseline"];
}

function frozenExecutionContract({ suite, tasks, model }) {
  return {
    model,
    reasoningEffort: suite.comparison.reasoningEffort,
    phaseBudgetsMs: PHASE_BUDGETS_MS,
    networkPolicy: suite.comparison.networkPolicy,
    retryPolicy: "none",
    costAccountingPhases: ["discovery", "planner", "coder", "repair", "validation"],
    taskOrder: tasks.map((task) => task.taskId),
    tasks: tasks.map((task) => ({ taskId: task.taskId, commitSha: task.commitSha,
      validationCommands: task.validationCommands, armOrder: armOrder(task) }))
  };
}

function createCheckpoint({ suite, tasks, model, runnerHeadSha, startedAt, results, inFlightTaskId }) {
  const completedPairCount = results.filter((entry) => entry.pairCompleted).length;
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    runIdentityHash: runIdentityHash({ suite, tasks, model, runnerHeadSha }),
    runnerHeadSha,
    startedAt,
    updatedAt: new Date().toISOString(),
    model,
    reasoningEffort: suite.comparison.reasoningEffort,
    taskCount: tasks.length,
    completedPairCount,
    expectedAgentRuns: tasks.length * 2,
    completedAgentRuns: completedPairCount * 2,
    completedAgentPairs: completedPairCount,
    retryPolicy: "none",
    promptMutationAfterFailure: false,
    hiddenHintInjection: false,
    frozenExecution: frozenExecutionContract({ suite, tasks, model }),
    inFlightTaskId,
    results
  };
}

function validateResumeCheckpoint(checkpoint, context) {
  const { suite, tasks, model, runnerHeadSha } = context;
  assert.equal(checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint), true,
    "resume checkpoint must be an object");
  assert.equal(checkpoint.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.equal(checkpoint.suiteId, suite.suiteId);
  assert.equal(checkpoint.runnerHeadSha, runnerHeadSha,
    "resume requires the exact same repository HEAD");
  assert.equal(checkpoint.model, model, "resume model must match the original run");
  assert.equal(checkpoint.reasoningEffort, suite.comparison.reasoningEffort);
  assert.equal(checkpoint.taskCount, tasks.length);
  assert.equal(checkpoint.expectedAgentRuns, tasks.length * 2);
  assert.equal(checkpoint.retryPolicy, "none");
  assert.equal(checkpoint.promptMutationAfterFailure, false);
  assert.equal(checkpoint.hiddenHintInjection, false);
  assert.equal(
    checkpoint.runIdentityHash,
    runIdentityHash({ suite, tasks, model, runnerHeadSha }),
    "resume checkpoint does not match the current frozen run"
  );
  assert.equal(Array.isArray(checkpoint.results), true);
  assert.equal(typeof checkpoint.startedAt, "string");
  assert.equal(checkpoint.results.length <= tasks.length, true);

  if (checkpoint.failedTaskId !== undefined || checkpoint.failure !== undefined) {
    throw new Error(
      `cannot resume: previous task ${checkpoint.failedTaskId || "unknown"} failed; ` +
      "retryPolicy=none forbids a second invocation"
    );
  }

  if (checkpoint.inFlightTaskId !== null) {
    throw new Error(
      `cannot resume: previous run stopped during ${checkpoint.inFlightTaskId}; ` +
      "re-running that task would violate retryPolicy=none"
    );
  }

  for (let index = 0; index < checkpoint.results.length; index += 1) {
    const entry = checkpoint.results[index];
    assert.equal(entry.taskId, tasks[index].taskId, "resume results must be an exact task-order prefix");
    assert.equal(entry.attempt, 1);
    assert.equal(entry.retryCount, 0);
    assert.equal(entry.hiddenHintsInjected, false);
    assert.equal(entry.promptMutatedAfterFailure, false);
    assert.equal(entry.pairCompleted, true,
      `cannot resume: ${entry.taskId} does not have two terminal arm invocations`);
    if (entry.failure !== null) {
      assert.equal(["infrastructure", "agent", "acceptance"].includes(entry.failure?.domain), true,
        `${entry.taskId}: invalid failure domain`);
    }
  }

  return {
    startedAt: checkpoint.startedAt,
    results: checkpoint.results.slice()
  };
}

function parseChildReport(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start + 1));
    } catch {
      return null;
    }
  }
}

function validateChildReport(report, task, suite, model, accountAlias) {
  assert.equal(report && typeof report === "object" && !Array.isArray(report), true);
  assert.equal(report.schemaVersion, "product-dogfood-live-run/v1");
  assert.equal(report.suiteId, suite.suiteId);
  assert.equal(report.model, model);
  assert.equal(report.accountAlias, accountAlias);
  assert.equal(report.reasoningEffort, suite.comparison.reasoningEffort);
  assert.equal(report.taskCount, 1);
  assert.equal(report.expectedAgentRuns, 2);
  assert.equal(report.retryPolicy, "none");
  assert.equal(report.promptMutationAfterFailure, false);
  assert.equal(report.hiddenHintInjection, false);
  assert.equal(Array.isArray(report.results), true);
  assert.equal(report.results.length, 1);

  const entry = report.results[0];
  assert.equal(entry.taskId, task.taskId);
  assert.equal(entry.attempt, 1);
  assert.equal(entry.retryCount, 0);
  assert.equal(entry.hiddenHintsInjected, false);
  assert.equal(entry.promptMutatedAfterFailure, false);
  assert.equal(entry.pairCompleted, true, `${task.taskId}: pair did not complete`);
  if (entry.failure !== null) {
    assert.equal(["infrastructure", "agent", "acceptance"].includes(entry.failure?.domain), true,
      `${task.taskId}: invalid failure domain`);
  }
  assert.ok(entry.result && typeof entry.result === "object");
  assert.equal(entry.result.comparable, true, `${task.taskId}: result is not comparable`);
  assert.deepEqual(entry.result.identityMismatchFields, []);
  assert.ok(entry.result.normal && entry.result.bounded);
  return entry;
}

function finalReport({ suite, tasks, model, accountAlias, startedAt, results }) {
  const completedPairCount = results.filter((entry) => entry.pairCompleted).length;
  return {
    schemaVersion: "product-dogfood-live-run/v1",
    suiteId: suite.suiteId,
    startedAt,
    completedAt: new Date().toISOString(),
    model,
    accountAlias,
    reasoningEffort: suite.comparison.reasoningEffort,
    taskCount: tasks.length,
    completedPairCount,
    expectedAgentRuns: tasks.length * 2,
    completedAgentRuns: completedPairCount * 2,
    completedAgentPairs: completedPairCount,
    retryPolicy: "none",
    promptMutationAfterFailure: false,
    hiddenHintInjection: false,
    frozenExecution: frozenExecutionContract({ suite, tasks, model }),
    results
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { suite, tasks } = loadSuiteTasks();

  if (!args.live) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "check",
      schemaVersion: "product-dogfood-resumable-run-plan/v1",
      suiteId: suite.suiteId,
      taskCount: tasks.length,
      model: args.model,
      checkpointing: true,
      resume: true,
      safeStopBetweenTasks: true,
      canonicalRunner: path.relative(repoRoot, canonicalRunner),
      liveProviderCalls: false
    }, null, 2)}\n`);
    return;
  }

  if (!args.output) {
    throw new Error("resumable live dogfood requires --output");
  }
  if (!args.model) {
    throw new Error("resumable live dogfood requires --model or BOUNDED_CODEX_MODEL/CODEX_MODEL");
  }
  if (args.model !== "gpt-5.6-luna") {
    throw new Error("resumable live dogfood requires exactly gpt-5.6-luna; fallback is forbidden");
  }
  const accountAlias = process.env.DOGFOOD_ACCOUNT_ALIAS?.trim();
  if (!accountAlias || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(accountAlias)) {
    throw new Error("resumable live dogfood requires a stable non-secret DOGFOOD_ACCOUNT_ALIAS");
  }
  if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY && !process.env.CODEX_HOME) {
    throw new Error("resumable live dogfood requires Codex authentication configuration");
  }
  if (!fs.existsSync(canonicalRunner)) {
    throw new Error(`canonical dogfood runner missing: ${canonicalRunner}`);
  }
  if (fs.existsSync(args.output)) {
    throw new Error(`refusing to overwrite existing final artifact: ${args.output}`);
  }

  const runnerHeadSha = repositoryHeadSha();
  const checkpointFile = checkpointPath(args.output);
  let startedAt = new Date().toISOString();
  let results = [];

  if (args.resume) {
    if (!fs.existsSync(checkpointFile)) {
      throw new Error(`resume checkpoint missing: ${checkpointFile}`);
    }
    const resumed = validateResumeCheckpoint(readJson(checkpointFile), {
      suite,
      tasks,
      model: args.model,
      runnerHeadSha
    });
    startedAt = resumed.startedAt;
    results = resumed.results;
    progress(`RESUME ${results.length}/${tasks.length}`);
  } else {
    if (fs.existsSync(checkpointFile)) {
      throw new Error(`checkpoint already exists: ${checkpointFile}; use --resume or remove it intentionally`);
    }
    atomicWriteJson(checkpointFile, createCheckpoint({
      suite,
      tasks,
      model: args.model,
      runnerHeadSha,
      startedAt,
      results,
      inFlightTaskId: null
    }));
  }

  for (let index = results.length; index < tasks.length; index += 1) {
    const task = tasks[index];

    if (args.stopFile && fs.existsSync(args.stopFile)) {
      progress(`STOP requested before ${index + 1}/${tasks.length}; checkpoint preserved`);
      return;
    }

    atomicWriteJson(checkpointFile, createCheckpoint({
      suite,
      tasks,
      model: args.model,
      runnerHeadSha,
      startedAt,
      results,
      inFlightTaskId: task.taskId
    }));

    progress(`START ${index + 1}/${tasks.length} ${task.taskId}`);
    const child = run(process.execPath, [
      canonicalRunner,
      "--live",
      `--model=${args.model}`,
      `--task-id=${task.taskId}`
    ], { env: { ...process.env, BOUNDED_CODEX_INVOCATION_JOURNAL_PATH: `${checkpointFile}.invocations.sqlite` } });

    const childReport = parseChildReport(child.stdout);
    if (child.error || child.status !== 0 || !childReport) {
      const reportedFailure = childReport?.results?.[0]?.failure;
      const reportedDomain = ["infrastructure", "agent", "acceptance"].includes(reportedFailure?.domain)
        ? reportedFailure.domain
        : null;
      atomicWriteJson(checkpointFile, {
        ...createCheckpoint({
          suite,
          tasks,
          model: args.model,
          runnerHeadSha,
          startedAt,
          results,
          inFlightTaskId: null
        }),
        failedTaskId: task.taskId,
        failure: {
          domain: reportedDomain ?? (child.error || child.signal || child.status === null ? "infrastructure" : "agent"),
          code: reportedFailure?.code ?? (child.error || child.signal || child.status === null
            ? "dogfood_child_infrastructure_failure"
            : "dogfood_agent_execution_failure"),
          exitCode: child.status,
          signal: child.signal,
          processError: child.error,
          stdoutHash: sha256(child.stdout),
          stderrHash: sha256(child.stderr)
        },
        providerFailureClass: classifyProviderFailure({
          code: reportedFailure?.code,
          diagnosticCode: reportedFailure?.diagnosticCode
        }),
        providerCircuit: ["auth", "quota"].includes(classifyProviderFailure({ code: reportedFailure?.code, diagnosticCode: reportedFailure?.diagnosticCode }))
          ? "stopped_no_further_invocations" : "stopped_on_task_failure"
      });
      throw new Error(`${task.taskId} failed; checkpoint preserved and retry is forbidden`);
    }

    const entry = validateChildReport(childReport, task, suite, args.model, accountAlias);
    results.push(entry);
    progress(`DONE ${index + 1}/${tasks.length} ${task.taskId}`);

    atomicWriteJson(checkpointFile, createCheckpoint({
      suite,
      tasks,
      model: args.model,
      runnerHeadSha,
      startedAt,
      results,
      inFlightTaskId: null
    }));
    progress(`SAVED ${results.length}/${tasks.length}`);
  }

  const report = finalReport({ suite, tasks, model: args.model, accountAlias, startedAt, results });
  atomicWriteJson(args.output, report);
  fs.rmSync(checkpointFile, { force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = { createCheckpoint, validateResumeCheckpoint, loadSuiteTasks };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
