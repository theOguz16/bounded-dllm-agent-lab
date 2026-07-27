#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  classifyAg3cLiveEvidence,
  hashCanonicalJson
} = require("./ag3c-live-evidence-classification.cjs");

const source = {
  sourceReportPath: "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_LIVE.json",
  sourceReportHash: "sha256:b7f8817bfffe26dc97447478c8088e84911f8a750df88b7b766b830968222940",
  sourceDecision: "ag3c_live_combined_planner_minimality_validation_passed",
  liveTokenUsageObserved: true
};

const guided = classifyAg3cLiveEvidence({
  ...source,
  expectedOutcomeVisibleToProvider: true
});

assert.equal(guided.evaluationMode, "guided_contract_conformance");
assert.equal(guided.claims.contractConformanceObserved, true);
assert.equal(guided.claims.plannerSelectionIndependenceObserved, false);
assert.equal(guided.claims.plannerSelectionQualityObserved, false);
assert.equal(guided.claims.coderPatchQualityObserved, false);
assert.equal(guided.claims.tokenUsageObserved, true);
assert.equal(guided.claims.tokenSavingsObserved, false);
const { classificationHash, ...guidedMaterial } = guided;
assert.equal(
  classificationHash,
  hashCanonicalJson(guidedMaterial),
  "classification hash must be reproducible"
);

const unguided = classifyAg3cLiveEvidence({
  ...source,
  expectedOutcomeVisibleToProvider: false
});

assert.equal(unguided.evaluationMode, "unguided_hidden_oracle");
assert.equal(unguided.claims.plannerSelectionIndependenceObserved, true);
assert.equal(unguided.claims.plannerSelectionQualityObserved, true);
assert.equal(unguided.claims.coderPatchQualityObserved, false);
assert.equal(unguided.claims.tokenSavingsObserved, false);

const failed = classifyAg3cLiveEvidence({
  ...source,
  sourceDecision: "ag3c_live_combined_planner_minimality_validation_failed",
  expectedOutcomeVisibleToProvider: false
});
assert.equal(failed.claims.contractConformanceObserved, false);
assert.equal(failed.claims.plannerSelectionQualityObserved, false);

console.log(JSON.stringify({
  ok: true,
  guidedMode: guided.evaluationMode,
  guidedPlannerQualityObserved: guided.claims.plannerSelectionQualityObserved,
  unguidedMode: unguided.evaluationMode,
  unguidedPlannerQualityObserved: unguided.claims.plannerSelectionQualityObserved
}, null, 2));
