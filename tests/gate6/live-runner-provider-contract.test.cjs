#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const runner = require("../../scripts/gate6-live-runner.cjs");
const core = require("../../scripts/gate6-live-runner-core.cjs");
const verifier = require("../../scripts/lib/gate6-verifier-provenance.cjs");
const { CANDIDATE_SELECTION_VERSION } = require("../../scripts/lib/gate6-context-escalation.cjs");
const { PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const ROOT = path.resolve(__dirname, "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const PRIVATE_SENTINEL = "GATE6_STEP15_PRIVATE_FIXTURE_VALUE";
const TASKSET_HASH = "sha256:e3e1e93b662fbd6ec0600787c462601a00540c4b56dd8fa72338882fad13f071";
const SEMANTICS_HASH = "sha256:07209fc1b4c923ab2432b7745e9c722651887bac454518a53d2a2ae18e9b6262";
const PRECONDITION_HASH = "sha256:334d7893325c912ab916215131cf4d440152bc1bc7ae0da9575cdef77068c8ac";

const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.provider-contract-v2",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix the provider contract fixture.",
  candidateFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  }),
  privateFixtureValue: PRIVATE_SENTINEL
});

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

function request() {
  return runner.buildProviderRequest({
    config: { endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture-model", maxCompletionTokens: 4096 },
    task,
    contextResult: { strategy: "C_synthetic_context", context: JSON.stringify({ strategy: "C_synthetic_context", evidence: [] }) },
    phase: "single"
  });
}

function instruction() {
  return JSON.parse(request().body.messages.find((message) => message.role === "user").content);
}

function validOutput() {
  return {
    schemaVersion: runner.LIVE_MODEL_OUTPUT_VERSION,
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
      edits: [{ path: "src/main.js", expectedContentHash: HASH, oldText: "before", newText: "after" }],
      summary: "Apply fixture edit."
    }
  };
}

function rawReport() {
  return {
    schemaVersion: "gate6-live-run/v1", executionClass: "live", researchStatus: "diagnostic_live_smoke", promotionEligible: false,
    sourceCommit: SHA, tasksetVersion: "gate6-taskset/v1", tasksetHash: TASKSET_HASH,
    benchmarkSemanticsHash: SEMANTICS_HASH, repositoryManifestHash: `sha256:${"3".repeat(64)}`,
    preconditionAttestationHash: PRECONDITION_HASH, oracleScorerVersion: "gate6-oracle-scorer/v1",
    receiptVersion: "gate6-simulated-harness-receipt/v3", model: "fixture-model", endpointClass: "openai_compatible",
    temperature: 0, maxCompletionTokens: 4096, repetitions: 1, taskCount: 1, strategyCount: 4, sampleCount: 4,
    expectedFullSampleCount: 504, filters: { taskLimit: 1, taskId: null, strategy: null }, observations: [], receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`, sampleOutcomes: [], comparativeReport: null, aggregates: {},
    reportHash: `sha256:${"6".repeat(64)}`
  };
}

async function main() {
  await test("response_format stays json_object without json_schema transport", () => {
    assert.deepEqual(request().body.response_format, { type: "json_object" });
    assert.equal(Object.hasOwn(request().body.response_format, "json_schema"), false);
  });

  await test("prompt exposes canonical Gate 6 output contract", () => {
    assert.deepEqual(instruction().outputContract, core.liveOutputJsonSchema().schema);
    assert.equal(instruction().providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
  });

  await test("top-level selection and proposal contracts are explicit", () => {
    const schema = instruction().outputContract;
    assert.deepEqual(schema.required, ["schemaVersion", "selection", "proposal"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schemaVersion.const, runner.LIVE_MODEL_OUTPUT_VERSION);
    assert.equal(schema.properties.selection.properties.schemaVersion.const, CANDIDATE_SELECTION_VERSION);
    assert.equal(schema.properties.proposal.properties.schemaVersion.const, PROPOSAL_VERSION);
  });

  await test("prompt forbids wrapper fields and requires compact output", () => {
    const rules = instruction().rules.join("\n");
    for (const field of ["analysis", "reasoning", "result", "output", "answer", "metadata", "explanation", "markdown"]) assert.ok(rules.includes(field));
    assert.match(rules, /Do not repeat repository context/i);
    assert.match(rules, /Keep summary concise/i);
    assert.match(rules, /minimal replacement span/i);
  });

  await test("structural example is task-independent and versioned", () => {
    const example = instruction().structuralExample;
    assert.deepEqual(Object.keys(example).sort(), ["proposal", "schemaVersion", "selection"]);
    assert.equal(example.schemaVersion, runner.LIVE_MODEL_OUTPUT_VERSION);
    assert.equal(example.selection.schemaVersion, CANDIDATE_SELECTION_VERSION);
    assert.equal(example.proposal.schemaVersion, PROPOSAL_VERSION);
    assert.equal(JSON.stringify(example).includes(task.taskId), false);
  });

  await test("private fixture data never leaks through provider prompt", () => {
    assert.equal(JSON.stringify(request()).includes(PRIVATE_SENTINEL), false);
  });

  await test("strict validator still rejects extra fields with no sanitizer", () => {
    assert.equal(runner.normalizeLiveModelOutput({ ...validOutput(), analysis: "extra" }, task), null);
  });

  await test("observedTopLevelKeys contains sorted key names only", () => {
    const diagnostic = runner.classifyLiveModelOutputDiagnostic({
      result: {
        kind: "ok", output: { ...validOutput(), analysis: PRIVATE_SENTINEL },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, latencyMs: 1,
        responseHash: `sha256:${"b".repeat(64)}`, providerRequestId: "fixture", finishReason: "stop"
      }, task, maxCompletionTokens: 4096
    });
    assert.equal(diagnostic.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID);
    assert.deepEqual(diagnostic.observedTopLevelKeys, ["analysis", "proposal", "schemaVersion", "selection"]);
    assert.equal(JSON.stringify(diagnostic).includes(PRIVATE_SENTINEL), false);
  });

  await test("providerPromptVersion is report and experiment identity", () => {
    const report = runner.augmentReport(rawReport());
    assert.equal(report.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.equal(report.experimentConfig.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    const v1 = runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, "gate6-live-provider-prompt/v1");
    const v2 = runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.notEqual(runner.hashLiveExperimentConfig(v1), runner.hashLiveExperimentConfig(v2));
  });

  await test("checkpoint identity binds prompt version and rejects old version", () => {
    const report = rawReport();
    const identityInput = {
      sourceCommit: report.sourceCommit, tasksetVersion: report.tasksetVersion, tasksetHash: report.tasksetHash,
      benchmarkSemanticsHash: report.benchmarkSemanticsHash, repositoryManifestHash: report.repositoryManifestHash,
      preconditionAttestationHash: report.preconditionAttestationHash, model: report.model, endpointClass: report.endpointClass,
      providerPromptVersion: runner.LIVE_PROVIDER_PROMPT_VERSION, temperature: report.temperature,
      maxCompletionTokens: report.maxCompletionTokens, repetitions: report.repetitions, filters: structuredClone(report.filters)
    };
    const current = runner.checkpoint.createCheckpointIdentity({
      reportIdentity: identityInput,
      experimentConfigHash: runner.hashLiveExperimentConfig(runner.createLiveExperimentConfig(report)),
      samplePlanHash: `sha256:${"9".repeat(64)}`,
      structuredOutputMode: runner.STRUCTURED_OUTPUT_MODE,
      providerPromptVersion: runner.LIVE_PROVIDER_PROMPT_VERSION
    });
    assert.equal(current.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.throws(
      () => runner.checkpoint.assertIdentityMatch({ ...current, providerPromptVersion: "gate6-live-provider-prompt/v1" }, current),
      /GATE6_CHECKPOINT_IDENTITY_MISMATCH/
    );
  });

  await test("frozen taskset and benchmark hashes stay unchanged", () => {
    const frozen = verifier.loadFrozenBenchmark(ROOT);
    assert.equal(frozen.tasksetReport.tasksetHash, TASKSET_HASH);
    assert.equal(frozen.semantics.benchmarkSemanticsHash, SEMANTICS_HASH);
    assert.equal(frozen.tasksetReport.preconditionAttestationHash, PRECONDITION_HASH);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
