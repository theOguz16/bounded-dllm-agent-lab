#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const suitePath = path.join(repoRoot, "benchmarks/product-v1/dogfood-v1.json");
const cliPath = path.join(repoRoot, "dist/apps/cli/src/index.js");
const DEFAULT_TASK_TIMEOUT_MS = 8 * 60 * 1000;

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function parseArgs(argv) {
  const args = {
    live: false,
    output: null,
    model: process.env.BOUNDED_CODEX_MODEL || process.env.CODEX_MODEL || null,
    taskId: null
  };
  for (const arg of argv) {
    if (arg === "--live") {
      args.live = true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      args.output = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length).trim();
      continue;
    }
    if (arg.startsWith("--task-id=")) {
      args.taskId = arg.slice("--task-id=".length).trim();
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || DEFAULT_TASK_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
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

function providerTaskText(task) {
  return [
    task.objective,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Validation commands:",
    ...task.validationCommands.map((command) => `- ${command}`)
  ].join("\n");
}

function validateSuiteShape(suite, tasks) {
  assert.equal(suite.schemaVersion, "product-dogfood-suite/v1");
  assert.equal(suite.suiteId, "product-v1-first-20-real-dogfood");
  assert.equal(tasks.length, 20);
  assert.equal(new Set(tasks.map((task) => task.taskId)).size, 20);

  const expectedCategories = ["bug_fix", "behavior_change", "regression_test", "small_multi_file"];
  for (const category of expectedCategories) {
    assert.equal(Array.isArray(suite.categories[category]), true);
    assert.equal(suite.categories[category].length, 5);
  }
  const listed = expectedCategories.flatMap((category) => suite.categories[category]);
  assert.equal(new Set(listed).size, 20);
  assert.deepEqual([...listed].sort(), tasks.map((task) => task.taskId).sort());

  assert.equal(suite.comparison.normalArm, "baseline");
  assert.equal(suite.comparison.boundedArm, "bounded");
  assert.equal(suite.comparison.freshWorkspacePerArm, true);
  assert.equal(suite.comparison.freshSourceCheckoutPerTask, true);
  assert.equal(suite.comparison.sameTask, true);
  assert.equal(suite.comparison.sameCommit, true);
  assert.equal(suite.comparison.sameModel, true);
  assert.equal(suite.comparison.sameReasoning, true);
  assert.equal(suite.comparison.sameValidation, true);
  assert.equal(suite.comparison.reasoningEffort, "medium");
  assert.equal(suite.comparison.networkPolicy, "disabled");
  assert.equal(suite.comparison.retryOnArmFailure, false);
  assert.equal(suite.comparison.mutatePromptAfterFailure, false);
  assert.equal(suite.comparison.injectHiddenHints, false);
}

function parseCliJson(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function redactedFailure(result) {
  return {
    exitCode: result.status,
    signal: result.signal,
    processError: result.error,
    stdoutHash: sha256(result.stdout),
    stderrHash: sha256(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr)
  };
}

function cloneFixedTask(task, root) {
  const checkout = path.join(root, "source");
  const clone = run("git", [
    "clone",
    "--quiet",
    "--no-checkout",
    `https://github.com/${task.repo}.git`,
    checkout
  ], { timeout: 120_000 });
  requireSuccess(clone, `clone ${task.taskId}`);

  const checkoutResult = run("git", ["checkout", "--quiet", "--detach", task.commitSha], {
    cwd: checkout,
    timeout: 60_000
  });
  requireSuccess(checkoutResult, `checkout ${task.taskId}`);

  const head = run("git", ["rev-parse", "HEAD"], { cwd: checkout, timeout: 10_000 });
  requireSuccess(head, `head ${task.taskId}`);
  assert.equal(head.stdout.trim().toLowerCase(), task.commitSha);
  return checkout;
}

function initializeBounded(checkout, env) {
  const result = run(process.execPath, [cliPath, "init", "--json"], {
    cwd: checkout,
    env,
    timeout: 60_000
  });
  requireSuccess(result, "bounded init");
}

async function loadTasks() {
  const runtime = await import(
    pathToFileURL(path.join(repoRoot, "dist/packages/product-runtime/src/product-task-contract.js")).href
  );
  const suite = readJson(suitePath);
  const taskset = readJson(path.join(repoRoot, suite.taskFile));
  assert.equal(taskset.schemaVersion, "product-dogfood-taskset/v1");
  assert.equal(taskset.suiteId, suite.suiteId);
  const tasks = taskset.tasks.map((task) => runtime.parseProductTask(task));
  validateSuiteShape(suite, tasks);
  return { suite, tasks };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { suite, tasks: allTasks } = await loadTasks();
  const tasks = args.taskId
    ? allTasks.filter((task) => task.taskId === args.taskId)
    : allTasks;
  if (args.taskId && tasks.length !== 1) {
    throw new Error(`unknown task id: ${args.taskId}`);
  }

  if (!args.live) {
    const plan = {
      ok: true,
      mode: "check",
      schemaVersion: "product-dogfood-run-plan/v1",
      suiteId: suite.suiteId,
      taskCount: allTasks.length,
      distribution: Object.fromEntries(
        Object.entries(suite.categories).map(([key, value]) => [key, value.length])
      ),
      comparison: suite.comparison,
      liveProviderCalls: false
    };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  if (!args.model) {
    throw new Error("live dogfood requires --model or BOUNDED_CODEX_MODEL/CODEX_MODEL");
  }
  if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY && !process.env.CODEX_HOME) {
    throw new Error("live dogfood requires Codex authentication configuration");
  }
  if (!fs.existsSync(cliPath)) {
    throw new Error("live dogfood requires a built CLI");
  }

  const startedAt = new Date().toISOString();
  const results = [];
  const baseEnv = {
    ...process.env,
    BOUNDED_CODEX_MODEL: args.model
  };

  for (const task of tasks) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-dogfood-"));
    const prompt = providerTaskText(task);
    const record = {
      taskId: task.taskId,
      sourceCommitSha: task.commitSha,
      taskHash: sha256(prompt),
      validationHash: sha256(JSON.stringify(task.validationCommands)),
      model: args.model,
      reasoningEffort: suite.comparison.reasoningEffort,
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: false,
      result: null,
      failure: null
    };

    try {
      const checkout = cloneFixedTask(task, tempRoot);
      initializeBounded(checkout, baseEnv);

      // Exactly one comparison invocation per task. The comparison runner creates
      // one fresh Normal workspace and one fresh Bounded workspace. There is no
      // retry, prompt mutation, or evaluator/oracle input on either arm.
      const compare = run(process.execPath, [
        cliPath,
        "compare",
        "codex",
        "--task",
        prompt,
        "--json"
      ], {
        cwd: checkout,
        env: baseEnv,
        timeout: DEFAULT_TASK_TIMEOUT_MS
      });

      const parsed = parseCliJson(compare.stdout);
      if (compare.error || compare.status !== 0 || !parsed) {
        record.failure = redactedFailure(compare);
      } else {
        assert.equal(parsed.task, prompt);
        assert.equal(parsed.model, args.model);
        assert.equal(parsed.reasoning, suite.comparison.reasoningEffort);
        assert.equal(parsed.networkPolicy, suite.comparison.networkPolicy);
        assert.equal(parsed.sourceRepositoryUnchanged, true);
        assert.equal(parsed.comparable, true);
        assert.deepEqual(parsed.identityMismatchFields, []);
        assert.ok(parsed.normal && parsed.bounded);
        record.pairCompleted = true;
        record.result = parsed;
      }

      const headAfter = run("git", ["rev-parse", "HEAD"], { cwd: checkout, timeout: 10_000 });
      requireSuccess(headAfter, `post-run head ${task.taskId}`);
      assert.equal(headAfter.stdout.trim().toLowerCase(), task.commitSha);
    } catch (error) {
      record.failure = {
        code: "dogfood_task_infrastructure_failure",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    results.push(record);
  }

  const completedPairCount = results.filter((entry) => entry.pairCompleted).length;
  const report = {
    schemaVersion: "product-dogfood-live-run/v1",
    suiteId: suite.suiteId,
    startedAt,
    completedAt: new Date().toISOString(),
    model: args.model,
    reasoningEffort: suite.comparison.reasoningEffort,
    taskCount: results.length,
    completedPairCount,
    expectedAgentRuns: results.length * 2,
    completedAgentRuns: completedPairCount * 2,
    completedAgentPairs: completedPairCount,
    retryPolicy: "none",
    promptMutationAfterFailure: false,
    hiddenHintInjection: false,
    results
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);

  if (completedPairCount !== results.length) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});