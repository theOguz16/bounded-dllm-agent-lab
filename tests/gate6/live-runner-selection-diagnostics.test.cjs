#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");
const {
  CANDIDATE_SELECTION_VERSION,
  validateCandidateSelection
} = require("../../scripts/lib/gate6-context-escalation.cjs");

const C = runner.SELECTION_VALIDATION_FAILURE_CODES;
const D = runner.SELECTION_VALIDATION_FAILURE_DETAIL_CODES;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.selection-diagnostics",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix diagnostics fixture.",
  candidateFiles: Object.freeze(["src/main.js", "src/other.js", "test/main.test.js", "test/other.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  })
});

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

function validSelection() {
  return {
    schemaVersion: CANDIDATE_SELECTION_VERSION,
    candidateFiles: ["src/main.js"],
    candidateSymbols: ["calculate"],
    candidateTestFiles: ["test/main.test.js"],
    candidateTestAnchors: ["calculate regression"]
  };
}

function validOutput(selection = validSelection()) {
  return {
    schemaVersion: runner.LIVE_MODEL_OUTPUT_VERSION,
    selection,
    proposal: {
      schemaVersion: "gate6-simulated-proposal/v1",
      action: "patch",
      edits: [{ path: "src/main.js", expectedContentHash: HASH, oldText: "before", newText: "after" }],
      summary: "Apply fixture edit."
    }
  };
}

function classify(selection) {
  return runner.classifyCandidateSelectionDiagnostic(selection, task);
}

function modelDiagnostic(selection) {
  return runner.classifyLiveModelOutputDiagnostic({
    result: {
      kind: "ok",
      output: validOutput(selection),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      responseHash: HASH,
      providerRequestId: null,
      finishReason: "stop"
    },
    task,
    maxCompletionTokens: 4096
  });
}

function expect(selection, code, detailCode = null) {
  const value = classify(selection);
  assert.equal(value.selectionValidationFailureCode, code);
  assert.equal(value.selectionValidationFailureDetailCode, detailCode);
  return value;
}

function rawReport(traces = []) {
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
    maxCompletionTokens: 4096,
    repetitions: 1,
    taskCount: 1,
    strategyCount: 1,
    sampleCount: traces.length === 0 ? 0 : 1,
    expectedFullSampleCount: 504,
    filters: { taskLimit: 1, taskId: null, strategy: "CE_escalating_context" },
    observations: [],
    receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`,
    sampleOutcomes: traces.length === 0 ? [] : [{
      taskId: task.taskId,
      strategy: "CE_escalating_context",
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

function trace(phase, strategy) {
  return {
    phase,
    strategy,
    contextBytes: 100,
    contextHash: `sha256:${"7".repeat(64)}`,
    tokens: 2,
    latencyMs: 1,
    responseHash: `sha256:${"8".repeat(64)}`,
    providerRequestId: null,
    modelOutputValid: false
  };
}

function record(phase, strategy, diagnostic) {
  return { phase, strategy, diagnostic };
}

async function parseFailureResult(content) {
  const provider = runner.createObservedOpenAICompatibleProvider({
    endpoint: "http://fixture.invalid/v1/chat/completions",
    model: "fixture-model",
    apiKey: "fixture-key",
    maxCompletionTokens: 4096
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200 })
  });
  return provider.execute({ request: { endpoint: "http://fixture.invalid/v1/chat/completions", body: {} } });
}

async function main() {
  await test("exact valid selection -> SELECTION_VALID", () => {
    const value = expect(validSelection(), C.SELECTION_VALID);
    assert.equal(value.selectionSchemaVersionValid, true);
    assert.equal(value.candidateFileCount, 1);
    assert.equal(value.candidateSymbolCount, 1);
    assert.equal(value.candidateTestFileCount, 1);
    assert.equal(value.candidateTestAnchorCount, 1);
  });

  await test("missing/extra key -> SELECTION_SHAPE_INVALID", () => {
    const missing = validSelection(); delete missing.candidateSymbols;
    expect(missing, C.SELECTION_SHAPE_INVALID);
    expect({ ...validSelection(), extra: true }, C.SELECTION_SHAPE_INVALID);
  });

  await test("wrong schema version", () => {
    expect({ ...validSelection(), schemaVersion: "gate6-candidate-selection/v999" }, C.SELECTION_SCHEMA_VERSION_INVALID);
  });

  await test("duplicate candidate file", () => {
    const selection = validSelection(); selection.candidateFiles = ["src/main.js", "src/main.js"];
    const value = expect(selection, C.CANDIDATE_FILES_INVALID, D.DUPLICATE);
    assert.equal(value.duplicateCount, 1);
  });

  await test("invalid relative path", () => {
    const selection = validSelection(); selection.candidateFiles = ["src/../main.js"];
    expect(selection, C.CANDIDATE_FILES_INVALID, D.INVALID_PATH);
  });

  await test("implementation file outside candidate universe", () => {
    const selection = validSelection(); selection.candidateFiles = ["private/secret.js"];
    const value = expect(selection, C.CANDIDATE_FILE_OUTSIDE_UNIVERSE, D.OUTSIDE_CANDIDATE_UNIVERSE);
    assert.equal(value.outsideUniverseCount, 1);
  });

  await test("test file outside candidate universe", () => {
    const selection = validSelection(); selection.candidateTestFiles = ["private/secret.test.js"];
    expect(selection, C.CANDIDATE_TEST_FILE_OUTSIDE_UNIVERSE, D.OUTSIDE_CANDIDATE_UNIVERSE);
  });

  await test("duplicate symbol", () => {
    const selection = validSelection(); selection.candidateSymbols = ["calculate", "calculate"];
    expect(selection, C.CANDIDATE_SYMBOLS_INVALID, D.DUPLICATE);
  });

  await test("duplicate test anchor", () => {
    const selection = validSelection(); selection.candidateTestAnchors = ["regression", "regression"];
    expect(selection, C.CANDIDATE_TEST_ANCHORS_INVALID, D.DUPLICATE);
  });

  await test("implementation/test overlap", () => {
    const selection = validSelection(); selection.candidateTestFiles = ["src/main.js"];
    const value = expect(selection, C.IMPLEMENTATION_TEST_FILE_OVERLAP);
    assert.equal(value.implementationTestOverlapCount, 1);
  });

  await test("too many files", () => {
    const selection = validSelection(); selection.candidateFiles = Array.from({ length: 33 }, () => "src/main.js");
    expect(selection, C.CANDIDATE_FILES_INVALID, D.TOO_MANY_ITEMS);
  });

  await test("too many symbols", () => {
    const selection = validSelection(); selection.candidateSymbols = Array.from({ length: 65 }, (_, index) => `symbol${index}`);
    expect(selection, C.CANDIDATE_SYMBOLS_INVALID, D.TOO_MANY_ITEMS);
  });

  await test("non-array and invalid strings remain safely classified", () => {
    const nonArray = validSelection(); nonArray.candidateTestFiles = "test/main.test.js";
    expect(nonArray, C.CANDIDATE_TEST_FILES_INVALID, D.NON_ARRAY);
    const invalidString = validSelection(); invalidString.candidateTestAnchors = ["  "];
    expect(invalidString, C.CANDIDATE_TEST_ANCHORS_INVALID, D.EMPTY_OR_INVALID_STRING);
  });

  await test("diagnostic VALID iff canonical validator accepts", () => {
    const cases = [];
    cases.push(validSelection());
    const missing = validSelection(); delete missing.candidateFiles; cases.push(missing);
    cases.push({ ...validSelection(), schemaVersion: "wrong" });
    const duplicateFile = validSelection(); duplicateFile.candidateFiles = ["src/main.js", "src/main.js"]; cases.push(duplicateFile);
    const badPath = validSelection(); badPath.candidateFiles = ["../src/main.js"]; cases.push(badPath);
    const outside = validSelection(); outside.candidateFiles = ["outside.js"]; cases.push(outside);
    const duplicateSymbol = validSelection(); duplicateSymbol.candidateSymbols = ["x", "x"]; cases.push(duplicateSymbol);
    const overlap = validSelection(); overlap.candidateTestFiles = ["src/main.js"]; cases.push(overlap);
    const tooMany = validSelection(); tooMany.candidateSymbols = Array.from({ length: 65 }, (_, index) => `s${index}`); cases.push(tooMany);
    for (const selection of cases) {
      const diagnosticValid = classify(selection).selectionValidationFailureCode === C.SELECTION_VALID;
      const canonicalValid = validateCandidateSelection(selection, task) !== null;
      assert.equal(diagnosticValid, canonicalValid);
    }
  });

  await test("diagnostic cannot relax normative validator", () => {
    const selection = validSelection(); selection.candidateFiles = ["private/secret.js"];
    assert.notEqual(classify(selection).selectionValidationFailureCode, C.SELECTION_VALID);
    assert.equal(validateCandidateSelection(selection, task), null);
    assert.equal(runner.normalizeLiveModelOutput(validOutput(selection), task), null);
    const value = modelDiagnostic(selection);
    assert.equal(value.localContractValid, false);
    assert.equal(value.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
  });

  await test("raw paths are not leaked through diagnostic report", () => {
    const selection = validSelection(); selection.candidateFiles = ["private/RAW_PATH_SENTINEL.js"];
    const serialized = JSON.stringify(classify(selection));
    assert.equal(serialized.includes("RAW_PATH_SENTINEL"), false);
    assert.equal(serialized.includes("private/"), false);
  });

  await test("JSON parse diagnostics expose shape signals without raw content", async () => {
    const raw = "  {\"RAW_CONTENT_SENTINEL\":true";
    const result = await parseFailureResult(raw);
    const value = runner.classifyLiveModelOutputDiagnostic({ result, task, maxCompletionTokens: 4096 });
    assert.equal(result.kind, "model_output_invalid");
    assert.equal(value.localValidationFailureCode, runner.LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED);
    assert.equal(value.contentLengthBytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(value.contentStartsWithObject, true);
    assert.equal(value.contentEndsWithObject, false);
    assert.equal(JSON.stringify(value).includes("RAW_CONTENT_SENTINEL"), false);
  });

  await test("CE phases receive independent selection diagnostics", () => {
    const initialSelection = validSelection(); initialSelection.candidateFiles = ["private/initial.js"];
    const escalatedSelection = validSelection(); escalatedSelection.candidateSymbols = ["x", "x"];
    const traces = [
      trace("ce_initial_c", "C_synthetic_context"),
      trace("ce_escalated_e", "E_bounded_workspace_boundary")
    ];
    const report = runner.augmentReport(rawReport(traces), runner.STRUCTURED_OUTPUT_MODE, [
      record("ce_initial_c", "C_synthetic_context", modelDiagnostic(initialSelection)),
      record("ce_escalated_e", "E_bounded_workspace_boundary", modelDiagnostic(escalatedSelection))
    ]);
    assert.equal(report.sampleOutcomes[0].providerTrace[0].selectionValidationFailureCode, C.CANDIDATE_FILE_OUTSIDE_UNIVERSE);
    assert.equal(report.sampleOutcomes[0].providerTrace[1].selectionValidationFailureCode, C.CANDIDATE_SYMBOLS_INVALID);
    assert.equal(report.sampleOutcomes[0].providerTrace[0].outsideUniverseCount, 1);
    assert.equal(report.sampleOutcomes[0].providerTrace[1].duplicateCount, 1);
  });

  await test("existing experimentConfigHash unchanged by diagnostic-only instrumentation", () => {
    const phase = "single";
    const strategy = "C_synthetic_context";
    const tracesA = [trace(phase, strategy)];
    const tracesB = [trace(phase, strategy)];
    const good = modelDiagnostic(validSelection());
    const badSelection = validSelection(); badSelection.candidateSymbols = ["x", "x"];
    const bad = modelDiagnostic(badSelection);
    const a = runner.augmentReport(rawReport(tracesA), runner.STRUCTURED_OUTPUT_MODE, [record(phase, strategy, good)]);
    const b = runner.augmentReport(rawReport(tracesB), runner.STRUCTURED_OUTPUT_MODE, [record(phase, strategy, bad)]);
    assert.equal(a.providerPromptVersion, "gate6-live-provider-prompt/v2");
    assert.equal(a.experimentConfigHash, b.experimentConfigHash);
    assert.notEqual(a.reportHash, b.reportHash);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
