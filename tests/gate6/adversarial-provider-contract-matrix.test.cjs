#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const runner = require("../../scripts/gate6-live-runner.cjs");
const { validateCandidateSelection } = require("../../scripts/lib/gate6-context-escalation.cjs");
const { PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SOURCE = "abcdef\n";
const task = Object.freeze({
  schemaVersion: "gate6-task/v1", taskId: "fixture.adversarial-provider-contract", repositoryId: "fixture/repo",
  commitSha: COMMIT, taskClass: "bugfix_with_regression", difficulty: "medium",
  objective: "Exercise adversarial provider contract cases.",
  candidateFiles: Object.freeze(["src/a.js", "test/a.test.js", "forbidden/x.js", "other/x.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**", "forbidden/**", "other/**"]),
    forbiddenInspectionPaths: Object.freeze(["forbidden/**"]),
    allowedChangePaths: Object.freeze(["src/**", "test/**", "forbidden/**"])
  })
});
const snapshot = Object.freeze({
  repositoryId: task.repositoryId, commitSha: task.commitSha,
  files: Object.freeze([
    Object.freeze({ path: "src/a.js", content: SOURCE }),
    Object.freeze({ path: "test/a.test.js", content: "test\n" }),
    Object.freeze({ path: "forbidden/x.js", content: "forbidden\n" }),
    Object.freeze({ path: "other/x.js", content: "other\n" })
  ])
});

function validProposal() {
  return { schemaVersion: PROPOSAL_VERSION, action: "patch",
    edits: [{ path: "src/a.js", expectedContentHash: sha256(SOURCE), oldText: "abc", newText: "ABC" }],
    summary: "Apply fixture patch." };
}
function validSelection() {
  return { schemaVersion: "gate6-candidate-selection/v1", candidateFiles: ["src/a.js"], candidateSymbols: ["fixture"],
    candidateTestFiles: ["test/a.test.js"], candidateTestAnchors: ["fixture regression"] };
}
function validOutput() { return { schemaVersion: runner.LIVE_MODEL_OUTPUT_VERSION, selection: validSelection(), proposal: validProposal() }; }
function request() {
  return runner.buildProviderRequest({
    config: { endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture-model", maxCompletionTokens: 4096 }, task,
    contextResult: { strategy: "E_bounded_workspace_boundary", context: JSON.stringify({ strategy: "E_bounded_workspace_boundary", files: snapshot.files }) },
    phase: "single"
  });
}
function diagnostic(output, finishReason = "stop", outputTokens = 10) {
  return runner.classifyLiveModelOutputDiagnostic({
    result: { kind: "ok", output, usage: { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens }, finishReason,
      contentLengthBytes: 100, contentStartsWithObject: true, contentEndsWithObject: true },
    task, maxCompletionTokens: 4096
  });
}
function okResult(output) {
  return { kind: "ok", output: structuredClone(output), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, latencyMs: 1,
    responseHash: sha256(JSON.stringify(output)), providerRequestId: "fixture-request", finishReason: "stop" };
}
function invalidTransportResult() {
  return { kind: "model_output_invalid", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, latencyMs: 1,
    responseHash: sha256("invalid"), providerRequestId: "fixture-request", finishReason: "stop", diagnosticFailureCode: "JSON_PARSE_FAILED" };
}
async function oneProviderCall(providerResult) {
  let calls = 0; let observedRequest = null;
  const records = [];
  const wrapped = runner.wrapProviderWithCanonicalContract(Object.freeze({ async execute(input) {
    calls += 1; observedRequest = input.request; return structuredClone(providerResult);
  } }), records);
  const result = await wrapped.execute({ request: request(), task, strategy: "E_bounded_workspace_boundary", phase: "single" });
  return { calls, result, records, observedRequest };
}
function test(name, fn) { return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`)); }

async function main() {
  await test("adversarial top-level selection and proposal matrix matches strict local contract", () => {
    const cases = [["valid", validOutput(), runner.LOCAL_VALIDATION_FAILURE_CODES.NONE]];
    const add = (name, mutate, expected) => { const x = validOutput(); mutate(x); cases.push([name, x, expected]); };
    add("extra top", (x) => { x.extra = true; }, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID);
    add("missing top", (x) => { delete x.proposal; }, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID);
    add("wrong top schema", (x) => { x.schemaVersion = "wrong"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SCHEMA_VERSION_INVALID);
    add("selection schema", (x) => { x.selection.schemaVersion = "wrong"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("selection overlap", (x) => { x.selection.candidateTestFiles = ["src/a.js"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("candidate outside", (x) => { x.selection.candidateFiles = ["src/outside.js"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("test outside", (x) => { x.selection.candidateTestFiles = ["test/outside.js"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("duplicate candidate", (x) => { x.selection.candidateFiles = ["src/a.js", "src/a.js"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("duplicate symbol", (x) => { x.selection.candidateSymbols = ["fixture", "fixture"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("duplicate anchor", (x) => { x.selection.candidateTestAnchors = ["fixture", "fixture"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("invalid candidate path", (x) => { x.selection.candidateFiles = ["../bad.js"]; }, runner.LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID);
    add("proposal schema", (x) => { x.proposal.schemaVersion = "wrong"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("proposal action", (x) => { x.proposal.action = "repair"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("missing edits", (x) => { delete x.proposal.edits; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("non-array edits", (x) => { x.proposal.edits = "bad"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("invalid edit object", (x) => { x.proposal.edits[0].extra = true; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("invalid hash", (x) => { x.proposal.edits[0].expectedContentHash = "bad"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("invalid proposal path", (x) => { x.proposal.edits[0].path = "../a.js"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    add("malformed no_change", (x) => { x.proposal.action = "no_change"; }, runner.LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID);
    for (const [name, output, expected] of cases) {
      const row = diagnostic(output); assert.equal(row.localValidationFailureCode, expected, name);
      assert.equal(row.localContractValid, expected === runner.LOCAL_VALIDATION_FAILURE_CODES.NONE, name);
    }
  });

  await test("selection diagnostic equivalence matrix stays canonical", () => {
    const variants = [
      validSelection(), { ...validSelection(), extra: true }, (() => { const x = validSelection(); delete x.candidateFiles; return x; })(),
      { ...validSelection(), schemaVersion: "wrong" }, { ...validSelection(), candidateFiles: "bad" },
      { ...validSelection(), candidateFiles: Array.from({ length: 33 }, (_, i) => `src/${i}.js`) },
      { ...validSelection(), candidateSymbols: [""] }, { ...validSelection(), candidateSymbols: ["x", "x"] },
      { ...validSelection(), candidateFiles: ["../bad.js"] }, { ...validSelection(), candidateFiles: ["src/outside.js"] },
      { ...validSelection(), candidateTestFiles: ["src/a.js"] }, { ...validSelection(), candidateTestAnchors: ["fixture", "fixture"] }
    ];
    for (const selection of variants) {
      const canonical = validateCandidateSelection(selection, task) !== null;
      const classified = runner.classifyCandidateSelectionDiagnostic(selection, task).selectionValidationFailureCode === runner.SELECTION_VALIDATION_FAILURE_CODES.SELECTION_VALID;
      assert.equal(classified, canonical);
    }
  });

  await test("proposal policy matrix distinguishes scope authority forbidden duplicate overlap and conflict", () => {
    const make = (edit) => ({ ...validProposal(), edits: [edit] });
    const cases = [
      [make({ ...validProposal().edits[0], path: "src/outside.js" }), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_PATH_OUTSIDE_CANDIDATE_UNIVERSE],
      [make({ path: "other/x.js", expectedContentHash: sha256("other\n"), oldText: "other", newText: "OTHER" }), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_AUTHORITY_VIOLATION],
      [make({ path: "forbidden/x.js", expectedContentHash: sha256("forbidden\n"), oldText: "forbidden", newText: "FORBIDDEN" }), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_FORBIDDEN_PATH],
      [{ ...validProposal(), edits: [validProposal().edits[0], validProposal().edits[0]] }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_DUPLICATE_EDIT],
      [{ ...validProposal(), edits: [validProposal().edits[0], { ...validProposal().edits[0], oldText: "bc", newText: "BC" }] }, runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_OVERLAPPING_EDIT],
      [make({ ...validProposal().edits[0], expectedContentHash: sha256("wrong") }), runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_CONFLICT_INVALID]
    ];
    for (const [proposal, expected] of cases) assert.equal(runner.classifyProposalDiagnostic(proposal, task, snapshot).proposalValidationFailureCode, expected);
  });

  await test("invalid transport selection proposal overlap and authority never trigger repair or retry", async () => {
    for (const raw of ["```json\n{}\n```", "before {}", "{} after", "{bad"]) {
      const before = raw; const row = await oneProviderCall(invalidTransportResult());
      assert.equal(row.calls, 1); assert.equal(row.result.kind, "model_output_invalid"); assert.equal(raw, before); assert.equal(row.records.length, 1);
    }
    const invalidOutputs = [];
    const overlap = validOutput(); overlap.selection.candidateTestFiles = ["src/a.js"]; invalidOutputs.push(overlap);
    const badProposal = validOutput(); badProposal.proposal.edits[0].expectedContentHash = "bad"; invalidOutputs.push(badProposal);
    const authority = validOutput(); authority.proposal.edits[0] = { path: "other/x.js", expectedContentHash: sha256("other\n"), oldText: "other", newText: "OTHER" }; invalidOutputs.push(authority);
    for (const output of invalidOutputs) {
      const original = structuredClone(output); const row = await oneProviderCall(okResult(output));
      assert.equal(row.calls, 1); assert.deepEqual(row.result.output, original); assert.deepEqual(output, original);
      assert.deepEqual(row.observedRequest.body.response_format, { type: "json_object" });
    }
  });

  await test("finish_reason length and completion budget remain diagnostics only", () => {
    const row = diagnostic(validOutput(), "length", 4096);
    assert.equal(row.finishReason, "length"); assert.equal(row.completionBudgetReached, true);
    assert.equal(row.terminationClassification, "output_token_limit"); assert.equal(row.localContractValid, true);
  });
}

main().catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
