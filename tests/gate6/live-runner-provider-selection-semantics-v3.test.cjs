#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");
const {
  CANDIDATE_SELECTION_VERSION,
  validateCandidateSelection
} = require("../../scripts/lib/gate6-context-escalation.cjs");
const { PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const PRIVATE_SENTINEL = "GATE6_STEP18_PRIVATE_ORACLE_SENTINEL";
const V2 = "gate6-live-provider-prompt/v2";
const V3 = "gate6-live-provider-prompt/v3";

const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.provider-selection-semantics-v3",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix the public fixture and preserve regression coverage.",
  candidateFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  }),
  privateOracleSentinel: PRIVATE_SENTINEL
});

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

function request() {
  return runner.buildProviderRequest({
    config: {
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      maxCompletionTokens: 4096
    },
    task,
    contextResult: {
      strategy: "C_synthetic_context",
      context: JSON.stringify({
        strategy: "C_synthetic_context",
        summaries: [
          { path: "src/main.js", kind: "implementation", summary: "public implementation evidence", symbols: ["calculate"] },
          { path: "test/main.test.js", kind: "test", summary: "public test evidence", symbols: [] }
        ]
      })
    },
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

function reportIdentity() {
  return {
    schemaVersion: "gate6-live-run/v1",
    sourceCommit: SHA,
    tasksetVersion: "gate6-taskset/v1",
    tasksetHash: `sha256:${"1".repeat(64)}`,
    benchmarkSemanticsHash: `sha256:${"2".repeat(64)}`,
    repositoryManifestHash: `sha256:${"3".repeat(64)}`,
    preconditionAttestationHash: `sha256:${"4".repeat(64)}`,
    model: "fixture-model",
    endpointClass: "openai_compatible",
    temperature: 0,
    maxCompletionTokens: 4096,
    repetitions: 1,
    taskCount: 1,
    strategyCount: 4,
    filters: { taskLimit: 1, taskId: null, strategy: null }
  };
}

async function main() {
  await test("providerPromptVersion=v3", () => {
    assert.equal(runner.LIVE_PROVIDER_PROMPT_VERSION, V3);
    assert.equal(instruction().providerPromptVersion, V3);
  });

  await test("prompt explicitly defines implementation and test selection semantics", () => {
    const rules = instruction().rules.join("\n");
    assert.match(rules, /candidateFiles means implementation\/source files only\./);
    assert.match(rules, /candidateTestFiles means regression\/test files only\./);
    assert.match(rules, /candidateFiles and candidateTestFiles MUST be disjoint\./);
    assert.match(rules, /Never place the same path in both arrays\./);
    assert.match(rules, /Do not use candidateFiles as an umbrella list containing every selected file\./);
    assert.match(rules, /If a selected path is a test file, put it only in candidateTestFiles\./);
    assert.match(rules, /If a selected path is an implementation\/source file, put it only in candidateFiles\./);
    assert.match(rules, /Both arrays must contain only paths from the public candidate universe\./);
  });

  await test("prompt explicitly scopes symbols and public file-kind evidence", () => {
    const rules = instruction().rules.join("\n");
    assert.match(rules, /candidateSymbols should identify implementation symbols relevant to candidateFiles\./);
    assert.match(rules, /candidateTestAnchors should identify test anchors relevant to candidateTestFiles\./);
    assert.match(rules, /Use public resolved-context file-kind evidence/);
  });

  await test("hidden oracle sentinel does not leak", () => {
    assert.equal(JSON.stringify(request()).includes(PRIVATE_SENTINEL), false);
  });

  await test("canonical validator still accepts disjoint selection and rejects overlap", () => {
    const selection = validOutput().selection;
    assert.ok(validateCandidateSelection(selection, task));
    const overlap = structuredClone(selection);
    overlap.candidateFiles = ["src/main.js", "test/main.test.js"];
    assert.equal(validateCandidateSelection(overlap, task), null);
  });

  await test("overlap remains MODEL_OUTPUT_INVALID with no sanitizer or post-processing", () => {
    const output = validOutput();
    output.selection.candidateFiles = ["src/main.js", "test/main.test.js"];
    const before = structuredClone(output);
    assert.equal(runner.normalizeLiveModelOutput(output, task), null);
    assert.deepEqual(output, before);
  });

  await test("structured output transport remains json_object", () => {
    assert.deepEqual(request().body.response_format, { type: "json_object" });
    assert.equal(Object.hasOwn(request().body.response_format, "json_schema"), false);
  });

  await test("v2 and v3 produce different experimentConfigHash", () => {
    const report = reportIdentity();
    const v2 = runner.createLiveExperimentConfig(report, runner.STRUCTURED_OUTPUT_MODE, V2);
    const v3 = runner.createLiveExperimentConfig(report, runner.STRUCTURED_OUTPUT_MODE, V3);
    assert.notEqual(runner.hashLiveExperimentConfig(v2), runner.hashLiveExperimentConfig(v3));
  });

  await test("old v2 checkpoint identity is rejected in v3", () => {
    const report = reportIdentity();
    const samplePlanHash = `sha256:${"9".repeat(64)}`;
    const v2Config = runner.createLiveExperimentConfig(report, runner.STRUCTURED_OUTPUT_MODE, V2);
    const v3Config = runner.createLiveExperimentConfig(report, runner.STRUCTURED_OUTPUT_MODE, V3);
    const oldV2 = runner.checkpoint.createCheckpointIdentity({
      reportIdentity: { ...report, providerPromptVersion: V2 },
      experimentConfigHash: runner.hashLiveExperimentConfig(v2Config),
      samplePlanHash,
      structuredOutputMode: runner.STRUCTURED_OUTPUT_MODE,
      providerPromptVersion: V2
    });
    const currentV3 = runner.checkpoint.createCheckpointIdentity({
      reportIdentity: { ...report, providerPromptVersion: V3 },
      experimentConfigHash: runner.hashLiveExperimentConfig(v3Config),
      samplePlanHash,
      structuredOutputMode: runner.STRUCTURED_OUTPUT_MODE,
      providerPromptVersion: V3
    });
    assert.throws(
      () => runner.checkpoint.assertIdentityMatch(oldV2, currentV3),
      /GATE6_CHECKPOINT_IDENTITY_MISMATCH/
    );
  });

  await test("model output invalid does not trigger retry or repair provider calls", async () => {
    let calls = 0;
    const provider = runner.createOpenAICompatibleProvider({
      endpoint: "http://fixture.invalid/v1/chat/completions",
      model: "fixture-model",
      apiKey: "fixture-key",
      maxCompletionTokens: 4096
    }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "{malformed" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const result = await provider.execute({ request: request() });
    assert.equal(result.kind, "model_output_invalid");
    assert.equal(calls, 1);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
