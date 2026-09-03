#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  LIVE_MODEL_OUTPUT_VERSION,
  LOCAL_VALIDATION_FAILURE_CODES,
  PROVIDER_TRACE_SCHEMA_VERSION,
  STRUCTURED_OUTPUT_MODE,
  augmentReport,
  classifyLiveModelOutputDiagnostic,
  createOpenAICompatibleProvider,
  normalizeLiveModelOutput,
  stableProjection
} = require("../../scripts/gate6-live-runner.cjs");
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
        expectedContentHash: HASH,
        oldText: "before",
        newText: "after"
      }],
      summary: "Apply fixture edit."
    }
  };
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
  return classifyLiveModelOutputDiagnostic({ result, task, maxCompletionTokens });
}

function rawReportFixture({ maxCompletionTokens = 256, traces = [] } = {}) {
  return {
    schemaVersion: "gate6-live-run/v1",
    executionClass: "live",
    researchStatus: "diagnostic_live_smoke",
    promotionEligible: false,
    sourceCommit: SHA,
    tasksetVersion: "gate6-taskset/v1",
    tasksetHash: `sha256:${"1".repeat(64)}`,
    benchmarkSemanticsHash: `sha256:${"2".repeat(64)}`,
    repositoryManifestHash: `sha256:${"3".repeat(64)}`,
    preconditionAttestationHash: `sha256:${"4".repeat(64)}`,
    oracleScorerVersion: "gate6-oracle-scorer/v1",
    receiptVersion: "gate6-simulated-harness-receipt/v3",
    model: "fixture-model",
    endpointClass: "openai_compatible",
    temperature: 0,
    maxCompletionTokens,
    repetitions: 1,
    taskCount: 1,
    strategyCount: 1,
    sampleCount: 1,
    expectedFullSampleCount: 504,
    filters: { taskLimit: 1, taskId: null, strategy: "C_synthetic_context" },
    observations: [],
    receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`,
    sampleOutcomes: traces.length === 0 ? [] : [{
      taskId: task.taskId,
      strategy: traces[0].strategy,
      repetition: 1,
      failureCode: "MODEL_OUTPUT_INVALID",
      failureDomain: "model",
      providerFailureCode: null,
      modelCapabilityFailure: true,
      acceptancePassed: false,
      escalated: traces.length > 1,
      escalationReasons: [],
      initialContextBytes: 100,
      incrementalEscalationContextBytes: traces.length > 1 ? 100 : 0,
      totalContextBytes: traces.length > 1 ? 200 : 100,
      providerTrace: traces
    }],
    comparativeReport: null,
    aggregates: {},
    reportHash: `sha256:${"6".repeat(64)}`
  };
}

function baseTrace(phase = "single", strategy = "C_synthetic_context") {
  return {
    phase,
    strategy,
    contextBytes: 100,
    contextHash: `sha256:${"7".repeat(64)}`,
    tokens: 18,
    latencyMs: 3,
    responseHash: `sha256:${"8".repeat(64)}`,
    providerRequestId: "request-id",
    modelOutputValid: true
  };
}

function diagnosticRecord(phase, strategy, value) {
  return { phase, strategy, diagnostic: value };
}

async function main() {
  await test("valid JSON + valid contract -> localValidationFailureCode=NONE", () => {
    const value = diagnostic(providerResult());
    assert.equal(value.jsonParsed, true);
    assert.equal(value.localContractValid, true);
    assert.equal(value.localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.NONE);
  });

  await test("malformed JSON -> JSON_PARSE_FAILED", async () => {
    const provider = createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 256
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{malformed" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }), { status: 200 })
    });
    const result = await provider.execute({ request: { endpoint: "http://fixture.invalid", body: {} } });
    const value = diagnostic(result);
    assert.equal(result.kind, "model_output_invalid");
    assert.equal(value.jsonParsed, false);
    assert.equal(value.localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED);
  });

  await test("missing content -> CONTENT_MISSING", async () => {
    const provider = createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 256
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }
      }), { status: 200 })
    });
    const result = await provider.execute({ request: { endpoint: "http://fixture.invalid", body: {} } });
    assert.equal(diagnostic(result).localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.CONTENT_MISSING);
  });

  await test("wrong top-level keys -> TOP_LEVEL_SHAPE_INVALID", () => {
    const output = { ...validOutput(), extra: true };
    assert.equal(diagnostic(providerResult(output)).localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID);
  });

  await test("wrong live schemaVersion -> TOP_LEVEL_SCHEMA_VERSION_INVALID", () => {
    const output = validOutput();
    output.schemaVersion = "gate6-live-model-output/v999";
    assert.equal(diagnostic(providerResult(output)).localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SCHEMA_VERSION_INVALID);
  });

  await test("invalid candidate selection -> SELECTION_INVALID", () => {
    const output = validOutput();
    output.selection.candidateFiles = ["src/main.js", "src/main.js"];
    assert.equal(diagnostic(providerResult(output)).localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
  });

  await test("invalid proposal -> PROPOSAL_INVALID", () => {
    const output = validOutput();
    output.proposal.edits[0].expectedContentHash = "not-a-hash";
    assert.equal(diagnostic(providerResult(output)).localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
  });

  await test("finish_reason=length recorded as output-token termination", async () => {
    const provider = createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 7
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: JSON.stringify(validOutput()) } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }), { status: 200 })
    });
    const result = await provider.execute({ request: { endpoint: "http://fixture.invalid", body: {} } });
    const value = diagnostic(result, 7);
    assert.equal(value.finishReason, "length");
    assert.equal(value.terminationClassification, "output_token_limit");
    assert.equal(value.completionBudgetReached, true);
  });

  await test("input/output/total tokens independently recorded", () => {
    const value = diagnostic(providerResult());
    assert.equal(value.inputTokens, 11);
    assert.equal(value.outputTokens, 7);
    assert.equal(value.totalTokens, 18);
  });

  await test("completionTokens == maxCompletionTokens -> completionBudgetReached=true", () => {
    const value = diagnostic(providerResult(validOutput(), {
      usage: { inputTokens: 2, outputTokens: 256, totalTokens: 258 }
    }), 256);
    assert.equal(value.completionBudgetReached, true);
    assert.equal(value.terminationClassification, "normal");
  });

  await test("unknown finish reason does not claim truncation", () => {
    const value = diagnostic(providerResult(validOutput(), {
      finishReason: null,
      usage: { inputTokens: 2, outputTokens: 256, totalTokens: 258 }
    }), 256);
    assert.equal(value.completionBudgetReached, true);
    assert.equal(value.terminationClassification, "unknown");
  });

  await test("diagnostic classifier does not relax strict validator", () => {
    const output = validOutput();
    output.proposal.extra = true;
    assert.equal(diagnostic(providerResult(output)).localContractValid, false);
    assert.equal(normalizeLiveModelOutput(output, task), null);
  });

  await test("raw model content absent from final report while responseHash retained", () => {
    const trace = baseTrace();
    const report = augmentReport(rawReportFixture({ traces: [trace] }), STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("single", "C_synthetic_context", diagnostic(providerResult()))
    ]);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("RAW_MODEL_CONTENT_SENTINEL"), false);
    assert.equal(report.sampleOutcomes[0].providerTrace[0].responseHash, trace.responseHash);
    assert.equal(report.providerTraceSchemaVersion, PROVIDER_TRACE_SCHEMA_VERSION);
  });

  await test("experiment identity unchanged by diagnostic-only instrumentation", () => {
    const trace = baseTrace();
    const base = rawReportFixture({ traces: [trace] });
    const firstDiagnostic = diagnostic(providerResult());
    const secondDiagnostic = { ...firstDiagnostic, finishReason: "length", terminationClassification: "output_token_limit" };
    const first = augmentReport(base, STRUCTURED_OUTPUT_MODE, [diagnosticRecord("single", "C_synthetic_context", firstDiagnostic)]);
    const second = augmentReport(base, STRUCTURED_OUTPUT_MODE, [diagnosticRecord("single", "C_synthetic_context", secondDiagnostic)]);
    assert.equal(first.experimentConfigHash, second.experimentConfigHash);
    assert.notEqual(first.reportHash, second.reportHash);
  });

  await test("changing maxCompletionTokens changes experiment identity", () => {
    const first = augmentReport(rawReportFixture({ maxCompletionTokens: 2048 }));
    const second = augmentReport(rawReportFixture({ maxCompletionTokens: 4096 }));
    assert.notEqual(first.experimentConfigHash, second.experimentConfigHash);
  });

  await test("CE initial C and escalated E have independent diagnostics", () => {
    const strategy = "CE_escalating_context";
    const traces = [
      baseTrace("ce_initial_c", "C_synthetic_context"),
      baseTrace("ce_escalated_e", "E_bounded_workspace_boundary")
    ];
    const initial = diagnostic(providerResult(validOutput(), { finishReason: "stop" }), 2048);
    const expanded = diagnostic(providerResult(validOutput(), {
      finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 2048, totalTokens: 2148 }
    }), 2048);
    const report = augmentReport(rawReportFixture({ traces }), STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("ce_initial_c", "C_synthetic_context", initial),
      diagnosticRecord("ce_escalated_e", "E_bounded_workspace_boundary", expanded)
    ]);
    const providerTrace = report.sampleOutcomes[0].providerTrace;
    assert.equal(providerTrace[0].finishReason, "stop");
    assert.equal(providerTrace[0].completionBudgetReached, false);
    assert.equal(providerTrace[1].finishReason, "length");
    assert.equal(providerTrace[1].completionBudgetReached, true);
    assert.equal(providerTrace[1].terminationClassification, "output_token_limit");
    assert.equal(report.sampleOutcomes[0].strategy, strategy);
  });

  await test("stable projection normalizes volatile counts but preserves categorical diagnostics", () => {
    const trace = baseTrace();
    const report = augmentReport(rawReportFixture({ traces: [trace] }), STRUCTURED_OUTPUT_MODE, [
      diagnosticRecord("single", "C_synthetic_context", diagnostic(providerResult()))
    ]);
    const projected = stableProjection(report);
    const projectedTrace = projected.sampleOutcomes[0].providerTrace[0];
    assert.equal(projectedTrace.inputTokens, 0);
    assert.equal(projectedTrace.outputTokens, 0);
    assert.equal(projectedTrace.totalTokens, 0);
    assert.equal(projectedTrace.responseHash, null);
    assert.equal(projectedTrace.providerRequestId, null);
    assert.equal(projectedTrace.finishReason, "stop");
    assert.equal(projectedTrace.jsonParsed, true);
    assert.equal(projectedTrace.localContractValid, true);
    assert.equal(projectedTrace.localValidationFailureCode, LOCAL_VALIDATION_FAILURE_CODES.NONE);
    assert.equal(projectedTrace.completionBudgetReached, false);
    assert.equal(projectedTrace.terminationClassification, "normal");
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
