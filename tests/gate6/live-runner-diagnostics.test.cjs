#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");
const { CANDIDATE_SELECTION_VERSION } = require("../../scripts/lib/gate6-context-escalation.cjs");
const { PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.diagnostics",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix diagnostics fixture.",
  candidateFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  })
});

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
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

function providerRequest(maxCompletionTokens = 256) {
  return runner.buildProviderRequest({
    config: { endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture-model", maxCompletionTokens },
    task,
    contextResult: { strategy: "C_synthetic_context", context: JSON.stringify({ strategy: "C_synthetic_context", evidence: [] }) },
    phase: "single"
  });
}

function providerResult(output = validOutput(), overrides = {}) {
  return {
    kind: "ok",
    output,
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    latencyMs: 3,
    responseHash: `sha256:${"b".repeat(64)}`,
    providerRequestId: "fixture-request",
    finishReason: "stop",
    ...overrides
  };
}

function diagnostic(result, maxCompletionTokens = 256) {
  return runner.classifyLiveModelOutputDiagnostic({ result, task, maxCompletionTokens });
}

function baseTrace(phase = "single", strategy = "C_synthetic_context") {
  return {
    phase, strategy, contextBytes: 100, contextHash: `sha256:${"7".repeat(64)}`,
    tokens: 18, latencyMs: 3, responseHash: `sha256:${"8".repeat(64)}`,
    providerRequestId: "request-id", modelOutputValid: true
  };
}

function rawReport({ maxCompletionTokens = 256, traces = [], sampleStrategy = null } = {}) {
  const strategy = sampleStrategy ?? (traces.length > 1 ? "CE_escalating_context" : traces[0]?.strategy ?? "C_synthetic_context");
  return {
    schemaVersion: "gate6-live-run/v1", executionClass: "live", researchStatus: "diagnostic_live_smoke", promotionEligible: false,
    sourceCommit: SHA, tasksetVersion: "gate6-taskset/v1", tasksetHash: `sha256:${"1".repeat(64)}`,
    benchmarkSemanticsHash: `sha256:${"2".repeat(64)}`, repositoryManifestHash: `sha256:${"3".repeat(64)}`,
    preconditionAttestationHash: `sha256:${"4".repeat(64)}`, oracleScorerVersion: "gate6-oracle-scorer/v1",
    receiptVersion: "gate6-simulated-harness-receipt/v3", model: "fixture-model", endpointClass: "openai_compatible",
    temperature: 0, maxCompletionTokens, repetitions: 1, taskCount: 1, strategyCount: 1, sampleCount: 1,
    expectedFullSampleCount: 504, filters: { taskLimit: 1, taskId: null, strategy }, observations: [], receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`,
    sampleOutcomes: traces.length === 0 ? [] : [{
      taskId: task.taskId, strategy, repetition: 1, failureCode: "MODEL_OUTPUT_INVALID", failureDomain: "model",
      providerFailureCode: null, modelCapabilityFailure: true, acceptancePassed: false, escalated: traces.length > 1,
      escalationReasons: [], initialContextBytes: 100, incrementalEscalationContextBytes: traces.length > 1 ? 100 : 0,
      totalContextBytes: traces.length > 1 ? 200 : 100, providerTrace: traces
    }], comparativeReport: null, aggregates: {}, reportHash: `sha256:${"6".repeat(64)}`
  };
}

function diagnosticRecord(phase, strategy, value) {
  return { phase, strategy, diagnostic: value };
}

async function providerCase(body, maxCompletionTokens = 256) {
  const provider = runner.createOpenAICompatibleProvider({
    endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture-model", apiKey: "fixture-key", maxCompletionTokens
  }, { fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
  return provider.execute({ request: providerRequest(maxCompletionTokens) });
}

async function main() {
  await test("valid JSON + valid contract -> NONE", () => {
    const value = diagnostic(providerResult());
    assert.equal(value.jsonParsed, true);
    assert.equal(value.localContractValid, true);
    assert.equal(value.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.NONE);
  });

  await test("malformed JSON -> JSON_PARSE_FAILED", async () => {
    const result = await providerCase({
      choices: [{ finish_reason: "stop", message: { content: "{malformed" } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
    const value = diagnostic(result);
    assert.equal(result.kind, "model_output_invalid");
    assert.equal(value.jsonParsed, false);
    assert.equal(value.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED);
  });

  await test("missing content -> CONTENT_MISSING", async () => {
    const result = await providerCase({ choices: [{ finish_reason: "stop", message: {} }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } });
    assert.equal(diagnostic(result).localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.CONTENT_MISSING);
  });

  await test("top-level/schema/selection/proposal failures stay distinct", () => {
    assert.equal(diagnostic(providerResult({ ...validOutput(), extra: true })).localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID);
    const schema = validOutput(); schema.schemaVersion = "gate6-live-model-output/v999";
    assert.equal(diagnostic(providerResult(schema)).localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SCHEMA_VERSION_INVALID);
    const selection = validOutput(); selection.selection.candidateFiles = ["src/main.js", "src/main.js"];
    assert.equal(diagnostic(providerResult(selection)).localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    const proposal = validOutput(); proposal.proposal.edits[0].expectedContentHash = "not-a-hash";
    assert.equal(diagnostic(providerResult(proposal)).localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
  });

  await test("finish reason and independent token counts are recorded", async () => {
    const result = await providerCase({
      choices: [{ finish_reason: "length", message: { content: JSON.stringify(validOutput()) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    }, 7);
    const value = diagnostic(result, 7);
    assert.equal(value.finishReason, "length");
    assert.equal(value.inputTokens, 11);
    assert.equal(value.outputTokens, 7);
    assert.equal(value.totalTokens, 18);
    assert.equal(value.completionBudgetReached, true);
    assert.equal(value.terminationClassification, "output_token_limit");
  });

  await test("token equality is diagnostic only and unknown finish stays unknown", () => {
    const value = diagnostic(providerResult(validOutput(), { finishReason: null, usage: { inputTokens: 2, outputTokens: 256, totalTokens: 258 } }), 256);
    assert.equal(value.completionBudgetReached, true);
    assert.equal(value.terminationClassification, "unknown");
  });

  await test("diagnostics never relax strict validator", () => {
    const output = validOutput(); output.proposal.extra = true;
    assert.equal(diagnostic(providerResult(output)).localContractValid, false);
    assert.equal(runner.normalizeLiveModelOutput(output, task), null);
  });

  await test("raw model content stays absent while responseHash remains", () => {
    const trace = baseTrace();
    const report = runner.augmentReport(rawReport({ traces: [trace] }), runner.STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("single", "C_synthetic_context", diagnostic(providerResult()))
    ]);
    assert.equal(JSON.stringify(report).includes("RAW_MODEL_CONTENT_SENTINEL"), false);
    assert.equal(report.sampleOutcomes[0].providerTrace[0].responseHash, trace.responseHash);
    assert.equal(report.providerTraceSchemaVersion, runner.PROVIDER_TRACE_SCHEMA_VERSION);
  });

  await test("diagnostic-only changes do not alter experiment identity", () => {
    const trace = baseTrace();
    const source = rawReport({ traces: [trace] });
    const first = diagnostic(providerResult());
    const second = { ...first, finishReason: "length", terminationClassification: "output_token_limit" };
    const a = runner.augmentReport(source, runner.STRUCTURED_OUTPUT_MODE, [diagnosticRecord("single", "C_synthetic_context", first)]);
    const b = runner.augmentReport(source, runner.STRUCTURED_OUTPUT_MODE, [diagnosticRecord("single", "C_synthetic_context", second)]);
    assert.equal(a.experimentConfigHash, b.experimentConfigHash);
    assert.notEqual(a.reportHash, b.reportHash);
  });

  await test("changing maxCompletionTokens changes experiment identity", () => {
    assert.notEqual(runner.augmentReport(rawReport({ maxCompletionTokens: 2048 })).experimentConfigHash,
      runner.augmentReport(rawReport({ maxCompletionTokens: 4096 })).experimentConfigHash);
  });

  await test("CE initial C and escalated E keep independent diagnostics", () => {
    const traces = [baseTrace("ce_initial_c", "C_synthetic_context"), baseTrace("ce_escalated_e", "E_bounded_workspace_boundary")];
    const initial = diagnostic(providerResult(validOutput(), { finishReason: "stop" }), 2048);
    const expanded = diagnostic(providerResult(validOutput(), { finishReason: "length", usage: { inputTokens: 100, outputTokens: 2048, totalTokens: 2148 } }), 2048);
    const report = runner.augmentReport(rawReport({ traces }), runner.STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("ce_initial_c", "C_synthetic_context", initial),
      diagnosticRecord("ce_escalated_e", "E_bounded_workspace_boundary", expanded)
    ]);
    assert.equal(report.sampleOutcomes[0].providerTrace[0].finishReason, "stop");
    assert.equal(report.sampleOutcomes[0].providerTrace[1].finishReason, "length");
    assert.equal(report.sampleOutcomes[0].providerTrace[1].completionBudgetReached, true);
  });

  await test("stable projection normalizes volatile telemetry and preserves categories", () => {
    const trace = baseTrace();
    const report = runner.augmentReport(rawReport({ traces: [trace] }), runner.STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("single", "C_synthetic_context", diagnostic(providerResult()))
    ]);
    const projected = runner.stableProjection(report).sampleOutcomes[0].providerTrace[0];
    assert.equal(projected.inputTokens, 0);
    assert.equal(projected.outputTokens, 0);
    assert.equal(projected.totalTokens, 0);
    assert.equal(projected.responseHash, null);
    assert.equal(projected.providerRequestId, null);
    assert.equal(projected.finishReason, "stop");
    assert.equal(projected.jsonParsed, true);
    assert.equal(projected.localContractValid, true);
    assert.equal(projected.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.NONE);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
