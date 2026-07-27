#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const { ABLATION_MODES, createComparativeEvidenceReport } = runtime;

  const observations = ABLATION_MODES.map((mode, index) => ({
    taskId: "task.fixture.1",
    repositoryId: "repo.fixture",
    mode,
    modelId: "fixture-model",
    providerId: "fixture-provider",
    promptTokens: 100 + index,
    completionTokens: 20 + index,
    latencyMs: 50 + index,
    taskSucceeded: true,
    scopeDriftCount: 0,
    forbiddenTouchCount: 0,
    verifierDecision: "approve",
    oracleLeakageDetected: false
  }));

  const report = createComparativeEvidenceReport(observations);
  assert.equal(report.version, "comparative-evidence/v1");
  assert.equal(report.evidenceClass, "comparative_benchmark");
  assert.equal(report.comparable, true);
  assert.equal(report.comparisonFailureReasons.length, 0);
  assert.equal(report.modes.length, 5);
  assert(Object.isFrozen(report));

  const missingMode = createComparativeEvidenceReport(observations.slice(0, 4));
  assert.equal(missingMode.comparable, false);
  assert(missingMode.comparisonFailureReasons.some((reason) => reason.includes("missing_mode")));

  const leaked = createComparativeEvidenceReport(observations.map((entry, index) => index === 0
    ? { ...entry, oracleLeakageDetected: true }
    : entry));
  assert.equal(leaked.comparable, false);
  assert(leaked.comparisonFailureReasons.some((reason) => reason.includes("oracle_leakage")));

  console.log(JSON.stringify({
    ok: true,
    decision: "gate5_ablation_evidence_schema_ready",
    modeCount: report.modes.length,
    comparable: report.comparable
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
