#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../..");
const resumableRunner = path.join(__dirname, "dogfood-resumable-runner.cjs");
const POST_FIX_SCHEMA = "product-dogfood-post-fix-regression/v1";
const RUN_KIND = "post-fix-regression-v1";

function parseArgs(argv) {
  const args = {
    live: false,
    resume: false,
    output: null,
    stopFile: null,
    model: process.env.BOUNDED_CODEX_MODEL || process.env.CODEX_MODEL || null
  };
  for (const arg of argv) {
    if (arg === "--live") args.live = true;
    else if (arg === "--resume") args.resume = true;
    else if (arg.startsWith("--output=")) args.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--stop-file=")) args.stopFile = path.resolve(arg.slice("--stop-file=".length));
    else if (arg.startsWith("--model=")) args.model = arg.slice("--model=".length).trim();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function repositoryHeadSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error("post-fix runner repository HEAD is unavailable");
  return String(result.stdout).trim().toLowerCase();
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validateRawEvidence(raw) {
  assert.equal(raw && typeof raw === "object" && !Array.isArray(raw), true);
  assert.equal(raw.schemaVersion, "product-dogfood-live-run/v1");
  assert.equal(raw.suiteId, "product-v1-first-20-real-dogfood");
  assert.equal(raw.taskCount, 20);
  assert.equal(raw.completedPairCount, 20);
  assert.equal(raw.expectedAgentRuns, 40);
  assert.equal(raw.completedAgentRuns, 40);
  assert.equal(raw.completedAgentPairs, 20);
  assert.equal(raw.retryPolicy, "none");
  assert.equal(raw.promptMutationAfterFailure, false);
  assert.equal(raw.hiddenHintInjection, false);
  assert.equal(Array.isArray(raw.results), true);
  assert.equal(raw.results.length, 20);
  for (const entry of raw.results) {
    assert.equal(entry.attempt, 1);
    assert.equal(entry.retryCount, 0);
    assert.equal(entry.hiddenHintsInjected, false);
    assert.equal(entry.promptMutatedAfterFailure, false);
    assert.equal(entry.pairCompleted, true);
    assert.equal(entry.failure, null);
    assert.equal(entry.result?.comparable, true);
    assert.deepEqual(entry.result?.identityMismatchFields, []);
    assert.equal(entry.result?.comparisonRuntimeVersion, "canonical-bounded-compare/v1");
  }
}

function checkPlan(args) {
  return {
    ok: true,
    mode: "check",
    schemaVersion: "product-dogfood-post-fix-run-plan/v1",
    runKind: RUN_KIND,
    sourceSuiteId: "product-v1-first-20-real-dogfood",
    taskCount: 20,
    expectedAgentRuns: 40,
    model: args.model,
    resumable: true,
    dependencyPreparation: "explicit_pre_model_linux_snapshot",
    comparisonRuntimeVersion: "canonical-bounded-compare/v1",
    overwritesPilotEvidence: false,
    productClaimBenchmark: false,
    liveProviderCalls: false
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.live) {
    process.stdout.write(`${JSON.stringify(checkPlan(args), null, 2)}\n`);
    return;
  }
  if (!args.output) throw new Error("post-fix live regression requires --output");
  if (!args.model) throw new Error("post-fix live regression requires --model or BOUNDED_CODEX_MODEL/CODEX_MODEL");
  if (fs.existsSync(args.output)) throw new Error(`refusing to overwrite post-fix artifact: ${args.output}`);

  const rawOutput = `${args.output}.raw.json`;
  const childArgs = [
    resumableRunner,
    "--live",
    `--model=${args.model}`,
    `--output=${rawOutput}`
  ];
  if (args.resume) childArgs.push("--resume");
  if (args.stopFile) childArgs.push(`--stop-file=${args.stopFile}`);

  const child = spawnSync(process.execPath, childArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      BOUNDED_COMPARE_PREPARE_DEPENDENCIES: "1"
    },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || (child.status !== 0 && child.status !== null)) {
    if (child.stdout) process.stdout.write(child.stdout);
    process.exitCode = child.status ?? 1;
    return;
  }

  if (!fs.existsSync(rawOutput)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: "product-dogfood-post-fix-regression-paused/v1",
      runKind: RUN_KIND,
      paused: true,
      resumable: true,
      rawEvidencePending: path.basename(rawOutput),
      checkpoint: path.basename(`${rawOutput}.checkpoint.json`)
    }, null, 2)}\n`);
    return;
  }

  const rawBytes = fs.readFileSync(rawOutput);
  const raw = JSON.parse(rawBytes.toString("utf8"));
  validateRawEvidence(raw);
  const envelope = {
    schemaVersion: POST_FIX_SCHEMA,
    runKind: RUN_KIND,
    sourceSuiteId: raw.suiteId,
    runtimeHeadSha: repositoryHeadSha(),
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    model: raw.model,
    reasoningEffort: raw.reasoningEffort,
    taskCount: raw.taskCount,
    completedPairCount: raw.completedPairCount,
    expectedAgentRuns: raw.expectedAgentRuns,
    completedAgentRuns: raw.completedAgentRuns,
    completedAgentPairs: raw.completedAgentPairs,
    retryPolicy: raw.retryPolicy,
    promptMutationAfterFailure: raw.promptMutationAfterFailure,
    hiddenHintInjection: raw.hiddenHintInjection,
    comparisonRuntimeVersion: "canonical-bounded-compare/v1",
    dependencyPreparation: "explicit_pre_model_linux_snapshot",
    rawEvidenceFile: path.basename(rawOutput),
    rawEvidenceSha256: sha256(rawBytes),
    overwritesPilotEvidence: false,
    productClaimBenchmark: false
  };
  atomicWriteJson(args.output, envelope);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
