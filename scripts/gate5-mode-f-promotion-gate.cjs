#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const EVIDENCE_SCHEMA = "gate5-mode-f-live-evidence/v1";
const DECISION_SCHEMA = "gate5-mode-f-promotion-decision/v1";
const MODE_E = "E_bounded_workspace_boundary";
const MODE_F = "F_adaptive_compressed_boundary";

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name}_invalid`);
  return value;
}

function nonNegativeNumber(value, name) {
  const number = finiteNumber(value, name);
  if (number < 0) fail(`${name}_invalid`);
  return number;
}

function validateAggregate(entry, mode) {
  if (!entry || entry.mode !== mode) fail(`${mode}_aggregate_missing`);
  const sampleCount = finiteNumber(entry.sampleCount, `${mode}_sampleCount`);
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) fail(`${mode}_sampleCount_invalid`);
  const strictOracleSuccessRate = finiteNumber(
    entry.strictOracleSuccessRate,
    `${mode}_strictOracleSuccessRate`
  );
  if (strictOracleSuccessRate < 0 || strictOracleSuccessRate > 1) {
    fail(`${mode}_strictOracleSuccessRate_invalid`);
  }
  return {
    mode,
    sampleCount,
    strictOracleSuccessRate,
    averageContextBytes: nonNegativeNumber(entry.averageContextBytes, `${mode}_averageContextBytes`),
    totalScopeDriftFiles: nonNegativeNumber(entry.totalScopeDriftFiles, `${mode}_totalScopeDriftFiles`)
  };
}

function evaluatePromotion(evidence) {
  if (!evidence || evidence.schemaVersion !== EVIDENCE_SCHEMA) fail("evidence_schema_invalid");
  if (!Array.isArray(evidence.aggregates)) fail("evidence_aggregates_invalid");

  const byMode = new Map(evidence.aggregates.map((entry) => [entry?.mode, entry]));
  const e = validateAggregate(byMode.get(MODE_E), MODE_E);
  const f = validateAggregate(byMode.get(MODE_F), MODE_F);
  if (e.sampleCount !== f.sampleCount) fail("mode_sample_counts_not_comparable");

  const liveEvidence = evidence.researchStatus === "observed_live_result" &&
    evidence.executionClass === "live_adaptive_compressed_boundary";
  const sameOrBetterStrictSuccess = f.strictOracleSuccessRate >= e.strictOracleSuccessRate;
  const lessContext = f.averageContextBytes < e.averageContextBytes;
  const noExtraScopeDrift = f.totalScopeDriftFiles <= e.totalScopeDriftFiles;
  const promotionEligible = liveEvidence && sameOrBetterStrictSuccess && lessContext && noExtraScopeDrift;

  const reasons = [];
  if (!liveEvidence) reasons.push("live_observed_evidence_required");
  if (!sameOrBetterStrictSuccess) reasons.push("strict_success_regressed");
  if (!lessContext) reasons.push("context_not_reduced");
  if (!noExtraScopeDrift) reasons.push("scope_drift_increased");

  return {
    schemaVersion: DECISION_SCHEMA,
    experimentId: "gate5-mode-f-c-e-f",
    evidenceHash: typeof evidence.evidenceHash === "string" ? evidence.evidenceHash : null,
    sourceCommit: typeof evidence.sourceCommit === "string" ? evidence.sourceCommit : null,
    liveEvidence,
    comparison: {
      baselineMode: MODE_E,
      candidateMode: MODE_F,
      sampleCount: e.sampleCount,
      strictOracleSuccessRate: { baseline: e.strictOracleSuccessRate, candidate: f.strictOracleSuccessRate },
      averageContextBytes: { baseline: e.averageContextBytes, candidate: f.averageContextBytes },
      totalScopeDriftFiles: { baseline: e.totalScopeDriftFiles, candidate: f.totalScopeDriftFiles }
    },
    criteria: {
      sameOrBetterStrictSuccess,
      lessContext,
      noExtraScopeDrift
    },
    promotionEligible,
    decision: promotionEligible ? "promote_language_evidence_resolver" : "do_not_promote",
    reasons
  };
}

function main() {
  const evidencePath = argument("--evidence");
  if (!evidencePath) fail("--evidence_required");
  const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
  const decision = evaluatePromotion(evidence);
  const outputPath = argument("--output");
  if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(decision, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (process.argv.includes("--require-eligible") && !decision.promotionEligible) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`MODE_F_PROMOTION_GATE=FAIL\nerror=${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { evaluatePromotion };
