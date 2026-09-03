#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  LIVE_MODEL_OUTPUT_VERSION,
  STRUCTURED_OUTPUT_MODE,
  checkpoint,
  runGate6LiveBenchmark,
  stableProjection
} = require("../../scripts/gate6-live-runner.cjs");
const verifier = require("../../scripts/lib/gate6-verifier-provenance.cjs");
const { CANDIDATE_SELECTION_VERSION } = require("../../scripts/lib/gate6-context-escalation.cjs");
const { PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");
const { sha256 } = require("../../scripts/lib/gate6-simulated-workspace.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.checkpoint-resume",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix checkpoint fixture with regression coverage.",
  candidateFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  })
});
const oracle = Object.freeze({
  schemaVersion: "gate6-oracle/v1",
  taskId: task.taskId,
  requiredImplementationFiles: Object.freeze(["src/main.js"]),
  requiredTestFiles: Object.freeze(["test/main.test.js"]),
  requiredSymbols: Object.freeze(["calculate"]),
  requiredTestAnchors: Object.freeze(["calculate regression"]),
  allowedTouchedFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  forbiddenFiles: Object.freeze([]),
  behavioralChecks: Object.freeze([])
});

function frozenFixture(overrides = {}) {
  return Object.freeze({
    tasksetReport: Object.freeze({
      schemaVersion: "gate6-taskset/v1",
      tasksetHash: overrides.tasksetHash ?? "sha256:" + "1".repeat(64),
      repositoryManifestHash: "sha256:" + "2".repeat(64),
      preconditionAttestationHash: "sha256:" + "3".repeat(64)
    }),
    semantics: Object.freeze({ benchmarkSemanticsHash: overrides.benchmarkSemanticsHash ?? "sha256:" + "4".repeat(64) }),
    tasks: Object.freeze([task]),
    oracles: Object.freeze([oracle]),
    repositoryManifest: Object.freeze({ schemaVersion: "gate6-repositories/v1", repositories: [] })
  });
}

function preflightFixture(overrides = {}) {
  return Object.freeze({
    sourceCommit: overrides.sourceCommit ?? SHA,
    frozen: frozenFixture(overrides),
    freezeDocument: Object.freeze({ schemaVersion: "fixture", attestations: [] })
  });
}

function makeWorkspaceFactory() {
  let counter = 0;
  return Object.freeze({
    async create({ task: currentTask }) {
      counter += 1;
      const baseline = new Map([
        ["src/main.js", "export function calculate__GATE6_FAULT(value){return value + 1;}\n"],
        ["test/main.test.js", "calculate regression\n"]
      ]);
      const files = new Map(baseline);
      return {
        workspaceId: `checkpoint-fixture-${counter}`,
        root: process.cwd(),
        async read(filePath) { if (!files.has(filePath)) throw new Error("ENOENT"); return files.get(filePath); },
        async write(filePath, content) { files.set(filePath, content); },
        async changedFiles() { return [...baseline.keys()].filter((filePath) => baseline.get(filePath) !== files.get(filePath)).sort(); },
        async contentFingerprint() {
          const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, content]) => ({
            path: filePath,
            state: "present",
            byteLength: Buffer.byteLength(content),
            contentHash: sha256(content)
          }));
          return { schemaVersion: "fixture-fingerprint/v1", hash: sha256(JSON.stringify(entries)), files: entries };
        },
        async repositorySnapshot() {
          return {
            schemaVersion: "gate6-repository-snapshot/v1",
            repositoryId: currentTask.repositoryId,
            commitSha: currentTask.commitSha,
            files: currentTask.candidateFiles.map((filePath) => ({ path: filePath, content: files.get(filePath) }))
          };
        },
        async rollback() { files.clear(); for (const [filePath, content] of baseline) files.set(filePath, content); return true; },
        async assertOriginalRepositoryUnchanged() { return true; },
        async dispose() { return true; }
      };
    }
  });
}

function validOutput() {
  const before = "export function calculate__GATE6_FAULT(value){return value + 1;}\n";
  return {
    schemaVersion: LIVE_MODEL_OUTPUT_VERSION,
    selection: {
      schemaVersion: CANDIDATE_SELECTION_VERSION,
      candidateFiles: ["src/main.js"],
      candidateSymbols: ["calculate"],
      candidateTestFiles: ["test/main.test.js"],
      candidateTestAnchors: ["calculate regression"]
    },
    proposal: {
      schemaVersion: PROPOSAL_VERSION,
      action: "patch",
      edits: [{
        path: "src/main.js",
        expectedContentHash: sha256(before),
        oldText: "calculate__GATE6_FAULT",
        newText: "calculate"
      }],
      summary: "Restore calculate export."
    }
  };
}

function fakeProvider() {
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      return {
        kind: "ok",
        output: validOutput(),
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        latencyMs: 7,
        responseHash: "sha256:" + String(calls.length).padStart(64, "a").slice(-64),
        providerRequestId: `checkpoint-${calls.length}`
      };
    }
  };
}

function dependencies(provider, overrides = {}) {
  return {
    provider,
    providerConfig: Object.freeze({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: overrides.model ?? "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: overrides.maxCompletionTokens ?? 256
    }),
    preflight: async () => preflightFixture(overrides),
    externalPreflight: async () => true,
    workspaceFactory: makeWorkspaceFactory(),
    relevantTestRunner: async ({ workspace }) => ({ passed: (await workspace.read("src/main.js")).includes("function calculate(value)") }),
    acceptanceRunner: async ({ workspace }) => ({ passed: (await workspace.read("src/main.js")).includes("function calculate(value)") }),
    ...(overrides.dependencies ?? {})
  };
}

async function run(provider, options = {}, dependencyOverrides = {}) {
  return runGate6LiveBenchmark({
    live: true,
    taskLimit: 1,
    repetitions: 1,
    ...options
  }, dependencies(provider, dependencyOverrides));
}

function readJson(filePath) { return JSON.parse(readFileSync(filePath, "utf8")); }
function writeJson(filePath, value) { writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function rehashCheckpoint(value) {
  const copy = structuredClone(value);
  delete copy.checkpointHash;
  return { ...copy, checkpointHash: verifier.hashCanonical(copy) };
}

function receiptSemanticProjection(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receiptHash;
  delete copy.harnessReportHash;
  if (copy.harnessReport) delete copy.harnessReport.workspaceId;
  return copy;
}

async function makeTwoSampleCheckpoint(directory) {
  const checkpointPath = path.join(directory, "checkpoint.json");
  const provider = fakeProvider();
  let writes = 0;
  await assert.rejects(
    run(provider, { checkpoint: checkpointPath }, {
      dependencies: {
        checkpointWriteHooks: {
          beforeRename({ tempPath, checkpointPath: destination }) {
            writes += 1;
            if (writes === 2) {
              renameSync(tempPath, destination);
              throw new Error("fixture crash after atomic rename");
            }
          }
        }
      }
    }),
    /fixture crash after atomic rename/
  );
  assert.equal(provider.calls.length, 2);
  return { checkpointPath, provider };
}

async function main() {
  await test("checkpoint after each fully completed sample", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-each-"));
    try {
      const checkpointPath = path.join(directory, "checkpoint.json");
      const provider = fakeProvider();
      await run(provider, { checkpoint: checkpointPath, strategy: "C_synthetic_context" });
      const document = readJson(checkpointPath);
      assert.equal(document.completedSamples.length, 1);
      assert.equal(document.completedSamples[0].taskId, task.taskId);
      assert.equal(document.researchStatus, checkpoint.CHECKPOINT_STATUS);
      assert.equal(document.promotionEligible, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("interrupted 4-sample run resumes remaining samples only", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-resume-"));
    try {
      const { checkpointPath, provider: first } = await makeTwoSampleCheckpoint(directory);
      const second = fakeProvider();
      const report = await run(second, { checkpoint: checkpointPath, resumeFrom: checkpointPath });
      assert.equal(first.calls.length, 2);
      assert.equal(second.calls.length, 3);
      assert.deepEqual(second.calls.map((call) => call.phase), ["single", "ce_initial_c", "ce_escalated_e"]);
      assert.equal(report.resumedFromCheckpoint, true);
      assert.equal(report.checkpointResumeCount, 1);
      assert.deepEqual(report.sampleOutcomes.map((row) => row.strategy), [
        "C_synthetic_context",
        "E_bounded_workspace_boundary",
        "F_adaptive_compressed_boundary",
        "CE_escalating_context"
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("completed sample provider calls are not repeated", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-calls-"));
    try {
      const { checkpointPath, provider: first } = await makeTwoSampleCheckpoint(directory);
      const restoredStrategies = readJson(checkpointPath).completedSamples.map((row) => row.strategy);
      const second = fakeProvider();
      await run(second, { checkpoint: checkpointPath, resumeFrom: checkpointPath });
      assert.deepEqual(first.calls.map((call) => call.strategy), restoredStrategies);
      for (const restored of restoredStrategies) assert.equal(second.calls.some((call) => call.strategy === restored), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("uninterrupted and resumed runs have equivalent canonical non-volatile evidence", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-equivalence-"));
    try {
      const uninterrupted = await run(fakeProvider());
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      const resumed = await run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath });
      const left = stableProjection(uninterrupted);
      const right = stableProjection(resumed);
      assert.deepEqual(left.observations, right.observations);
      assert.deepEqual(left.receipts.map(receiptSemanticProjection), right.receipts.map(receiptSemanticProjection));
      assert.deepEqual(left.sampleOutcomes, right.sampleOutcomes);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("duplicate sample in checkpoint rejected", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-duplicate-"));
    try {
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      const document = readJson(checkpointPath);
      document.completedSamples.push(structuredClone(document.completedSamples[0]));
      writeJson(checkpointPath, rehashCheckpoint(document));
      await assert.rejects(run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath }), /GATE6_CHECKPOINT_DUPLICATE_SAMPLE/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("corrupted checkpoint hash rejected", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-hash-"));
    try {
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      const document = readJson(checkpointPath);
      document.checkpointHash = "sha256:" + "0".repeat(64);
      writeJson(checkpointPath, document);
      await assert.rejects(run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath }), /GATE6_CHECKPOINT_HASH_MISMATCH/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("sourceCommit, model, maxCompletionTokens, taskset and semantics mismatches reject resume", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-identity-"));
    try {
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      for (const override of [
        { sourceCommit: "f".repeat(40) },
        { model: "other-model" },
        { maxCompletionTokens: 4096 },
        { tasksetHash: "sha256:" + "9".repeat(64) },
        { benchmarkSemanticsHash: "sha256:" + "8".repeat(64) }
      ]) {
        await assert.rejects(
          run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath }, override),
          /GATE6_CHECKPOINT_IDENTITY_MISMATCH/
        );
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("experimentConfigHash and structuredOutputMode mismatches reject fail-closed", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-config-"));
    try {
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      for (const [field, value] of [
        ["experimentConfigHash", "sha256:" + "7".repeat(64)],
        ["structuredOutputMode", `${STRUCTURED_OUTPUT_MODE}-tampered`]
      ]) {
        const document = readJson(checkpointPath);
        document.identity[field] = value;
        writeJson(checkpointPath, rehashCheckpoint(document));
        await assert.rejects(run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath }), /GATE6_CHECKPOINT_IDENTITY_MISMATCH/);
        const fresh = await makeTwoSampleCheckpoint(directory);
        if (fresh.checkpointPath !== checkpointPath) throw new Error("unexpected path");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("tampered observation, receipt and authority claim rejected", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-tamper-"));
    try {
      const mutations = [
        (sample) => { sample.observation.strictOracleSuccess = !sample.observation.strictOracleSuccess; },
        (sample) => { sample.receipt.receiptHash = "sha256:" + "0".repeat(64); },
        (sample) => { sample.observation.authorityViolation = true; }
      ];
      for (const mutate of mutations) {
        const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
        const document = readJson(checkpointPath);
        mutate(document.completedSamples[0]);
        writeJson(checkpointPath, rehashCheckpoint(document));
        await assert.rejects(run(fakeProvider(), { checkpoint: checkpointPath, resumeFrom: checkpointPath }), /GATE6_CHECKPOINT_/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("partial checkpoint cannot become full_live_candidate", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-partial-"));
    try {
      const { checkpointPath } = await makeTwoSampleCheckpoint(directory);
      const document = readJson(checkpointPath);
      assert.equal(document.researchStatus, "incomplete_live_checkpoint");
      assert.equal(document.promotionEligible, false);
      assert.equal(document.completedSamples.length, 2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("atomic-write interruption leaves previous valid checkpoint usable", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-atomic-"));
    try {
      const checkpointPath = path.join(directory, "checkpoint.json");
      const identity = {
        sourceCommit: SHA,
        tasksetVersion: "gate6-taskset/v1",
        tasksetHash: "sha256:" + "1".repeat(64),
        benchmarkSemanticsHash: "sha256:" + "2".repeat(64),
        repositoryManifestHash: "sha256:" + "3".repeat(64),
        preconditionAttestationHash: "sha256:" + "4".repeat(64),
        model: "fixture-model",
        endpointClass: "openai_compatible",
        structuredOutputMode: STRUCTURED_OUTPUT_MODE,
        temperature: 0,
        maxCompletionTokens: 256,
        repetitions: 1,
        filters: { taskLimit: 1, taskId: null, strategy: null },
        experimentConfigHash: "sha256:" + "5".repeat(64),
        samplePlanHash: "sha256:" + "6".repeat(64)
      };
      const first = checkpoint.createCheckpoint({ identity, completedSamples: [], checkpointResumeCount: 0 });
      checkpoint.atomicWriteCheckpoint(checkpointPath, first);
      const second = checkpoint.createCheckpoint({ identity, completedSamples: [], checkpointResumeCount: 1 });
      assert.throws(() => checkpoint.atomicWriteCheckpoint(checkpointPath, second, { beforeRename() { throw new Error("atomic fixture"); } }), /atomic fixture/);
      assert.deepEqual(checkpoint.readCheckpoint(checkpointPath), first);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await test("checkpoint/resume path does not alter experimentConfigHash", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gate6-checkpoint-experiment-"));
    try {
      const normal = await run(fakeProvider(), { strategy: "C_synthetic_context" });
      const checkpointPath = path.join(directory, "checkpoint.json");
      const withCheckpoint = await run(fakeProvider(), { strategy: "C_synthetic_context", checkpoint: checkpointPath });
      const resumed = await run(fakeProvider(), { strategy: "C_synthetic_context", checkpoint: checkpointPath, resumeFrom: checkpointPath });
      assert.equal(normal.experimentConfigHash, withCheckpoint.experimentConfigHash);
      assert.equal(normal.experimentConfigHash, resumed.experimentConfigHash);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
