#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_PAIR_COUNT = 20;
const EXPECTED_AGENT_RUNS = 40;

function validateLiveEvidence(report) {
  assert.equal(report && typeof report === "object" && !Array.isArray(report), true, "live evidence must be an object");
  assert.equal(report.schemaVersion, "product-dogfood-live-run/v1");
  assert.equal(report.suiteId, "product-v1-first-20-real-dogfood");
  assert.equal(report.taskCount, EXPECTED_PAIR_COUNT);
  assert.equal(report.completedPairCount, EXPECTED_PAIR_COUNT);
  assert.equal(report.expectedAgentRuns, EXPECTED_AGENT_RUNS);
  assert.equal(report.completedAgentPairs, EXPECTED_PAIR_COUNT);
  assert.equal(report.retryPolicy, "none");
  assert.equal(report.promptMutationAfterFailure, false);
  assert.equal(report.hiddenHintInjection, false);
  assert.equal(Array.isArray(report.results), true);
  assert.equal(report.results.length, EXPECTED_PAIR_COUNT);
  assert.equal(new Set(report.results.map((entry) => entry.taskId)).size, EXPECTED_PAIR_COUNT);

  for (const entry of report.results) {
    assert.equal(entry.attempt, 1, `${entry.taskId}: attempt must stay frozen at 1`);
    assert.equal(entry.retryCount, 0, `${entry.taskId}: retries are forbidden`);
    assert.equal(entry.hiddenHintsInjected, false, `${entry.taskId}: hidden hints are forbidden`);
    assert.equal(entry.promptMutatedAfterFailure, false, `${entry.taskId}: prompt mutation is forbidden`);
    assert.equal(entry.pairCompleted, true, `${entry.taskId}: Normal/Bounded pair is incomplete`);
    assert.equal(entry.failure, null, `${entry.taskId}: completed pair must not carry a failure`);
    assert.ok(entry.result && typeof entry.result === "object", `${entry.taskId}: comparison result missing`);
    assert.equal(entry.result.comparable, true, `${entry.taskId}: comparison identity is not comparable`);
    assert.deepEqual(entry.result.identityMismatchFields, [], `${entry.taskId}: comparison identity mismatch`);
    assert.ok(entry.result.normal && typeof entry.result.normal === "object", `${entry.taskId}: Normal arm missing`);
    assert.ok(entry.result.bounded && typeof entry.result.bounded === "object", `${entry.taskId}: Bounded arm missing`);
  }

  return Object.freeze({
    ok: true,
    completedPairCount: EXPECTED_PAIR_COUNT,
    expectedAgentRuns: EXPECTED_AGENT_RUNS,
    allPairsComparable: true,
    retries: 0,
    promptMutationAfterFailure: false,
    hiddenHintInjection: false
  });
}

function validFixture() {
  return {
    schemaVersion: "product-dogfood-live-run/v1",
    suiteId: "product-v1-first-20-real-dogfood",
    taskCount: EXPECTED_PAIR_COUNT,
    completedPairCount: EXPECTED_PAIR_COUNT,
    expectedAgentRuns: EXPECTED_AGENT_RUNS,
    completedAgentPairs: EXPECTED_PAIR_COUNT,
    retryPolicy: "none",
    promptMutationAfterFailure: false,
    hiddenHintInjection: false,
    results: Array.from({ length: EXPECTED_PAIR_COUNT }, (_, index) => ({
      taskId: `fixture-${String(index + 1).padStart(2, "0")}`,
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: true,
      failure: null,
      result: {
        comparable: true,
        identityMismatchFields: [],
        normal: {},
        bounded: {}
      }
    }))
  };
}

function selfTest() {
  const valid = validFixture();
  assert.equal(validateLiveEvidence(valid).ok, true);

  const mutations = [
    (report) => { report.completedPairCount = 19; },
    (report) => { report.expectedAgentRuns = 38; },
    (report) => { report.results[0].attempt = 2; },
    (report) => { report.results[0].retryCount = 1; },
    (report) => { report.results[0].pairCompleted = false; },
    (report) => { report.results[0].result.comparable = false; },
    (report) => { report.results[0].result.identityMismatchFields = ["modelId"]; },
    (report) => { report.results[0].hiddenHintsInjected = true; },
    (report) => { report.results[0].promptMutatedAfterFailure = true; }
  ];

  for (const mutate of mutations) {
    const candidate = JSON.parse(JSON.stringify(valid));
    mutate(candidate);
    assert.throws(() => validateLiveEvidence(candidate));
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: "product-dogfood-live-evidence/v1",
    completedPairCount: EXPECTED_PAIR_COUNT,
    expectedAgentRuns: EXPECTED_AGENT_RUNS,
    failClosedMutationsChecked: mutations.length
  }, null, 2)}\n`);
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") {
    selfTest();
    return;
  }

  const inputArg = argv.find((arg) => arg.startsWith("--input="));
  if (!inputArg || argv.length !== 1) {
    throw new Error("usage: dogfood-live-gate.cjs --input=<live-evidence.json> | --self-test");
  }

  const inputPath = path.resolve(inputArg.slice("--input=".length));
  if (!fs.existsSync(inputPath)) {
    throw new Error(`live evidence artifact missing: ${inputPath}`);
  }
  const report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = validateLiveEvidence(report);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
