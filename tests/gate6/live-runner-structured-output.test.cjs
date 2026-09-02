#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  LIVE_MODEL_OUTPUT_VERSION,
  STRUCTURED_OUTPUT_MODE,
  augmentReport,
  buildProviderRequest,
  createOpenAICompatibleProvider,
  normalizeLiveModelOutput
} = require("../../scripts/gate6-live-runner.cjs");
const {
  CANDIDATE_SELECTION_VERSION
} = require("../../scripts/lib/gate6-context-escalation.cjs");
const {
  PROPOSAL_VERSION
} = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.structured-output",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix the structured output fixture.",
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
      summary: "Apply the bounded fixture edit."
    }
  };
}

function request() {
  return buildProviderRequest({
    config: {
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      maxCompletionTokens: 256
    },
    task,
    contextResult: {
      strategy: "C_synthetic_context",
      context: JSON.stringify({ strategy: "C_synthetic_context", evidence: [] })
    },
    phase: "single"
  });
}

function rawReportFixture() {
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
    maxCompletionTokens: 256,
    repetitions: 1,
    taskCount: 1,
    strategyCount: 4,
    sampleCount: 4,
    expectedFullSampleCount: 504,
    filters: { taskLimit: 1, taskId: null, strategy: null },
    observations: [],
    receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`,
    sampleOutcomes: [],
    comparativeReport: null,
    aggregates: {},
    reportHash: `sha256:${"6".repeat(64)}`
  };
}

async function main() {
  await test("live provider request uses response_format.type=json_object", () => {
    const built = request();
    assert.deepEqual(built.body.response_format, { type: "json_object" });
    assert.equal("json_schema" in built.body.response_format, false);
  });

  await test("valid Gate 6 model JSON passes local strict validator", () => {
    assert.ok(normalizeLiveModelOutput(validOutput(), task));
  });

  await test("extra top-level field becomes model output invalid", () => {
    assert.equal(normalizeLiveModelOutput({ ...validOutput(), extra: true }, task), null);
  });

  await test("extra nested proposal field becomes model output invalid", () => {
    const value = validOutput();
    value.proposal.extra = true;
    assert.equal(normalizeLiveModelOutput(value, task), null);
  });

  await test("invalid expectedContentHash becomes model output invalid", () => {
    const value = validOutput();
    value.proposal.edits[0].expectedContentHash = "not-a-hash";
    assert.equal(normalizeLiveModelOutput(value, task), null);
  });

  await test("wrong schemaVersion becomes model output invalid", () => {
    const value = validOutput();
    value.schemaVersion = "gate6-live-model-output/v999";
    assert.equal(normalizeLiveModelOutput(value, task), null);
  });

  await test("duplicate and invalid candidate paths remain rejected locally", () => {
    const duplicate = validOutput();
    duplicate.selection.candidateFiles = ["src/main.js", "src/main.js"];
    assert.equal(normalizeLiveModelOutput(duplicate, task), null);
    const outside = validOutput();
    outside.selection.candidateFiles = ["../private.js"];
    assert.equal(normalizeLiveModelOutput(outside, task), null);
  });

  await test("structuredOutputMode is recorded in raw report and experiment config", () => {
    const report = augmentReport(rawReportFixture());
    assert.equal(report.structuredOutputMode, STRUCTURED_OUTPUT_MODE);
    assert.equal(report.experimentConfig.structuredOutputMode, STRUCTURED_OUTPUT_MODE);
    assert.match(report.experimentConfigHash, /^sha256:[0-9a-f]{64}$/);
  });

  await test("structuredOutputMode contributes to experiment identity and report hash", () => {
    const first = augmentReport(rawReportFixture(), STRUCTURED_OUTPUT_MODE);
    const second = augmentReport(rawReportFixture(), "fixture_other_structured_output_mode");
    assert.notEqual(first.experimentConfigHash, second.experimentConfigHash);
    assert.notEqual(first.reportHash, second.reportHash);
  });

  await test("malformed provider JSON remains model output invalid", async () => {
    const provider = createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 256
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "{malformed" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    const result = await provider.execute({ request: request() });
    assert.equal(result.kind, "model_output_invalid");
  });

  await test("provider HTTP 400 remains provider-domain failure with no fallback retry", async () => {
    let calls = 0;
    let observedBody;
    const provider = createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 256
    }, {
      fetchImpl: async (_input, init) => {
        calls += 1;
        observedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ error: { message: "failed to parse grammar" } }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
    });
    let captured;
    try { await provider.execute({ request: request() }); }
    catch (error) { captured = error; }
    assert.ok(captured);
    assert.equal(captured.code, "PROVIDER_FAILURE");
    assert.equal(captured.domain, "provider");
    assert.equal(captured.providerFailureCode, "GATE6_PROVIDER_HTTP_400");
    assert.equal(calls, 1);
    assert.deepEqual(observedBody.response_format, { type: "json_object" });
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
