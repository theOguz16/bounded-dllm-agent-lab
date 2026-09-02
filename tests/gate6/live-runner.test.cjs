#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  DIAGNOSTIC_STATUS,
  LIVE_MODEL_OUTPUT_VERSION,
  Gate6LiveRunnerError,
  assertUniqueSampleIdentities,
  calculateExpectedSampleCount,
  runCli,
  runGate6LiveBenchmark,
  stableProjection
} = require("../../scripts/gate6-live-runner.cjs");
const {
  CANDIDATE_SELECTION_VERSION
} = require("../../scripts/lib/gate6-context-escalation.cjs");
const {
  PROPOSAL_VERSION,
  providerFailure
} = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");
const { sha256 } = require("../../scripts/lib/gate6-simulated-workspace.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HIDDEN_SENTINEL = "GATE6_HIDDEN_ORACLE_SENTINEL";
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.calculate-regression",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix calculate regression with regression coverage.",
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
  behavioralChecks: Object.freeze([HIDDEN_SENTINEL])
});

function frozenFixture() {
  return Object.freeze({
    tasksetReport: Object.freeze({
      schemaVersion: "gate6-taskset/v1",
      tasksetHash: "sha256:" + "1".repeat(64),
      repositoryManifestHash: "sha256:" + "2".repeat(64),
      preconditionAttestationHash: "sha256:" + "3".repeat(64)
    }),
    semantics: Object.freeze({ benchmarkSemanticsHash: "sha256:" + "4".repeat(64) }),
    tasks: Object.freeze([task]),
    oracles: Object.freeze([oracle]),
    repositoryManifest: Object.freeze({ schemaVersion: "gate6-repositories/v1", repositories: [] })
  });
}

function preflightFixture(overrides = {}) {
  return Object.freeze({
    sourceCommit: SHA,
    frozen: frozenFixture(),
    freezeDocument: Object.freeze({ schemaVersion: "fixture", attestations: [] }),
    ...overrides
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
        workspaceId: `live-fixture-${counter}`,
        root: process.cwd(),
        async read(filePath) {
          if (!files.has(filePath)) throw new Error("ENOENT");
          return files.get(filePath);
        },
        async write(filePath, content) { files.set(filePath, content); },
        async changedFiles() {
          return [...baseline.keys()].filter((filePath) => baseline.get(filePath) !== files.get(filePath)).sort();
        },
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
        async rollback() {
          files.clear();
          for (const [filePath, content] of baseline) files.set(filePath, content);
          return true;
        },
        async assertOriginalRepositoryUnchanged() { return true; },
        async dispose() { return true; }
      };
    }
  });
}

function validSelection(overrides = {}) {
  return {
    schemaVersion: CANDIDATE_SELECTION_VERSION,
    candidateFiles: ["src/main.js"],
    candidateSymbols: ["calculate"],
    candidateTestFiles: ["test/main.test.js"],
    candidateTestAnchors: ["calculate regression"],
    ...overrides
  };
}

function validProposal() {
  const before = "export function calculate__GATE6_FAULT(value){return value + 1;}\n";
  return {
    schemaVersion: PROPOSAL_VERSION,
    action: "patch",
    edits: [{
      path: "src/main.js",
      expectedContentHash: sha256(before),
      oldText: "calculate__GATE6_FAULT",
      newText: "calculate"
    }],
    summary: "Restore calculate export."
  };
}

function liveOutput(selection = validSelection()) {
  return {
    schemaVersion: LIVE_MODEL_OUTPUT_VERSION,
    selection,
    proposal: validProposal()
  };
}

function fakeProvider(options = {}) {
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      if (options.inspect) options.inspect(input);
      if (options.providerFailure) throw providerFailure("FIXTURE_PROVIDER_DOWN", "fixture provider down");
      if (options.modelInvalid) {
        return {
          kind: "model_output_invalid",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          latencyMs: options.latencyMs ?? 7,
          responseHash: "sha256:" + "a".repeat(64),
          providerRequestId: "fixture-invalid"
        };
      }
      const output = typeof options.output === "function" ? options.output(input, calls.length) : liveOutput();
      return {
        kind: "ok",
        output,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        latencyMs: options.latencyMs ?? 7,
        responseHash: "sha256:" + String(calls.length).padStart(64, "b").slice(-64),
        providerRequestId: `fixture-${calls.length}`
      };
    }
  };
}

function dependencies(provider, overrides = {}) {
  return {
    provider,
    providerConfig: Object.freeze({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 256
    }),
    preflight: async () => preflightFixture(),
    externalPreflight: async () => true,
    workspaceFactory: makeWorkspaceFactory(),
    relevantTestRunner: async ({ workspace }) => ({
      passed: (await workspace.read("src/main.js")).includes("function calculate(value)")
    }),
    acceptanceRunner: async ({ workspace }) => ({
      passed: (await workspace.read("src/main.js")).includes("function calculate(value)")
    }),
    ...overrides
  };
}

async function smoke(provider = fakeProvider(), optionOverrides = {}, dependencyOverrides = {}) {
  return runGate6LiveBenchmark({
    live: true,
    taskLimit: 1,
    repetitions: 1,
    ...optionOverrides
  }, dependencies(provider, dependencyOverrides));
}

async function main() {
  await test("1 task × 4 strategies × 1 repetition smoke run", async () => {
    const provider = fakeProvider();
    const temporary = mkdtempSync(path.join(tmpdir(), "gate6-live-cli-test-"));
    const output = path.join(temporary, "smoke.json");
    try {
      const report = await runCli([
        "node",
        "scripts/gate6-live-runner.cjs",
        "--live",
        "--task-limit=1",
        "--repetitions=1",
        `--output=${output}`
      ], dependencies(provider));
      const written = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(report.sampleCount, 4);
      assert.equal(written.sampleCount, 4);
      assert.equal(report.taskCount, 1);
      assert.equal(report.strategyCount, 4);
      assert.equal(report.observations.length, 4);
      assert.equal(report.receipts.length, 4);
      assert.equal(report.researchStatus, DIAGNOSTIC_STATUS);
      assert.equal(report.promotionEligible, false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  await test("full expected sample count calculation is 504", () => {
    assert.equal(calculateExpectedSampleCount(42, 4, 3), 504);
  });

  await test("task-limit cannot be presented as full benchmark", async () => {
    const report = await smoke(fakeProvider());
    assert.equal(report.researchStatus, DIAGNOSTIC_STATUS);
    assert.equal(report.promotionEligible, false);
  });

  await test("duplicate sample identity fails closed", () => {
    const sample = { task, strategy: "C_synthetic_context", repetition: 1 };
    assert.throws(
      () => assertUniqueSampleIdentities([sample, sample]),
      (error) => error instanceof Gate6LiveRunnerError && error.code === "GATE6_LIVE_DUPLICATE_SAMPLE_IDENTITY"
    );
  });

  await test("provider failure remains provider-domain failure", async () => {
    const report = await smoke(fakeProvider({ providerFailure: true }), { strategy: "C_synthetic_context" });
    assert.equal(report.sampleCount, 1);
    assert.equal(report.sampleOutcomes[0].failureDomain, "provider");
    assert.equal(report.sampleOutcomes[0].modelCapabilityFailure, false);
    assert.equal(report.sampleOutcomes[0].providerFailureCode, "FIXTURE_PROVIDER_DOWN");
  });

  await test("malformed provider JSON becomes model output failure", async () => {
    const report = await smoke(fakeProvider({ modelInvalid: true }), { strategy: "C_synthetic_context" });
    assert.equal(report.sampleOutcomes[0].failureCode, "MODEL_OUTPUT_INVALID");
    assert.equal(report.sampleOutcomes[0].failureDomain, "model");
    assert.equal(report.sampleOutcomes[0].modelCapabilityFailure, true);
  });

  await test("CE escalation uses deterministic policy", async () => {
    const provider = fakeProvider({
      output(input) {
        if (input.phase === "ce_initial_c") {
          return liveOutput(validSelection({
            candidateFiles: [],
            candidateSymbols: [],
            candidateTestFiles: [],
            candidateTestAnchors: []
          }));
        }
        return liveOutput();
      }
    });
    const report = await smoke(provider, { strategy: "CE_escalating_context" });
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(provider.calls.map((call) => call.phase), ["ce_initial_c", "ce_escalated_e"]);
    assert.equal(report.sampleOutcomes[0].escalated, true);
    assert.ok(report.sampleOutcomes[0].escalationReasons.length > 0);
    assert.equal(report.observations[0].escalation.escalated, true);
    assert.ok(report.observations[0].escalation.incrementalContextBytes > 0);
  });

  await test("observation is derived from receipt/oracle results", async () => {
    const report = await smoke(fakeProvider(), { strategy: "E_bounded_workspace_boundary" });
    const observation = report.observations[0];
    const receipt = report.receipts[0];
    assert.equal(observation.strictOracleSuccess, true);
    assert.equal(observation.exactSymbolSuccess, true);
    assert.equal(observation.symbolTruePositiveCount, 1);
    assert.equal(observation.endToEndAccepted, true);
    assert.equal(observation.testsPassed, true);
    assert.equal(receipt.oracleVerification.strictOracleSuccess, observation.strictOracleSuccess);
    assert.equal(receipt.derivedOutcome.endToEndAccepted, observation.endToEndAccepted);
  });

  await test("hidden oracle sentinel never reaches provider payload", async () => {
    let inspected = 0;
    const provider = fakeProvider({
      inspect(input) {
        inspected += 1;
        const serialized = JSON.stringify(input.request.body);
        assert.equal(serialized.includes(HIDDEN_SENTINEL), false);
        assert.equal(serialized.includes("requiredImplementationFiles"), false);
        assert.equal(serialized.includes("behavioralChecks"), false);
      }
    });
    await smoke(provider);
    assert.equal(inspected, provider.calls.length);
    assert.ok(inspected >= 4);
  });

  await test("frozen source/taskset/semantics mismatch fails before provider call", async () => {
    const provider = fakeProvider();
    await assert.rejects(
      () => runGate6LiveBenchmark({ live: true, taskLimit: 1, repetitions: 1 }, dependencies(provider, {
        preflight: async () => { throw new Gate6LiveRunnerError("GATE6_LIVE_FROZEN_MISMATCH", "fixture"); }
      })),
      (error) => error.code === "GATE6_LIVE_FROZEN_MISMATCH"
    );
    assert.equal(provider.calls.length, 0);
  });

  await test("output is deterministic except measured timing/provider content", async () => {
    const first = await smoke(fakeProvider({ latencyMs: 7 }));
    const second = await smoke(fakeProvider({ latencyMs: 19 }));
    assert.deepEqual(stableProjection(first), stableProjection(second));
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
