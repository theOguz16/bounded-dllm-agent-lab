#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function canonicalize(value, ancestors = new WeakSet()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Unsupported canonical JSON type: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON must be acyclic.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain.");
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hashCanonicalJson(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function classifyAg3cLiveEvidence(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Classification input must be a plain object.");
  }
  const expectedOutcomeVisibleToProvider = input.expectedOutcomeVisibleToProvider === true;
  const evaluationMode = expectedOutcomeVisibleToProvider
    ? "guided_contract_conformance"
    : "unguided_hidden_oracle";
  const sourcePassed = input.sourceDecision === "ag3c_live_combined_planner_minimality_validation_passed";
  const tokenUsageObserved = input.liveTokenUsageObserved === true;

  const material = {
    classificationVersion: "1",
    phase: "AG.3c-live",
    sourceReportPath: input.sourceReportPath,
    sourceReportHash: input.sourceReportHash,
    evaluationMode,
    expectedOutcomeVisibleToProvider,
    claims: {
      contractConformanceObserved: sourcePassed,
      plannerSelectionIndependenceObserved: sourcePassed && !expectedOutcomeVisibleToProvider,
      plannerSelectionQualityObserved: sourcePassed && !expectedOutcomeVisibleToProvider,
      coderPatchQualityObserved: false,
      tokenUsageObserved,
      tokenSavingsObserved: false,
      latencyClaimAllowed: false,
      infrastructureCostObserved: false
    },
    allowedClaim: expectedOutcomeVisibleToProvider
      ? "Qwen2.5-Coder-7B completed the declared guided live contract-conformance cases through the AG.3c adapter, validation, graph-audit, minimality, and evidence pipeline."
      : "The provider completed an unguided hidden-oracle planner/minimality evaluation; task-level quality still requires the declared benchmark metrics.",
    forbiddenClaims: [
      "The planner independently selected the correct minimum repository scope.",
      "AG.3c demonstrated coder patch quality.",
      "AG.3c demonstrated token savings.",
      "AG.3c demonstrated general planner or model quality."
    ],
    nextEvidenceRequired: "Run an unguided hidden-oracle planner/minimality benchmark where expected seed files, symbols, tests, and planned files are not visible to the provider."
  };

  return Object.freeze({
    ...material,
    classificationHash: hashCanonicalJson(material)
  });
}

function main() {
  const sourceReportPath = process.env.AG3C_SOURCE_REPORT_PATH
    ?? "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_LIVE.json";
  const outputPath = process.env.AG3C_CLASSIFICATION_REPORT_PATH
    ?? "reports/ag/AG3C_LIVE_EVIDENCE_CLASSIFICATION.json";
  const source = JSON.parse(fs.readFileSync(sourceReportPath, "utf8"));
  const classification = classifyAg3cLiveEvidence({
    sourceReportPath,
    sourceReportHash: source.reportHash,
    sourceDecision: source.decision,
    liveTokenUsageObserved: source.liveTokenUsageObserved,
    expectedOutcomeVisibleToProvider: true
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(classification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ path: outputPath, classificationHash: classification.classificationHash }, null, 2));
}

module.exports = { classifyAg3cLiveEvidence, hashCanonicalJson };

if (require.main === module) main();
