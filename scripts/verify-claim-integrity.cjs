#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

const requiredFiles = [
  "docs/CURRENT_STATE.md",
  "docs/EVIDENCE_CLAIMS.md",
  "docs/results/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.md",
  "docs/results/AG3C_LIVE_EVIDENCE_CLASSIFICATION.md",
  "reports/ag/AG3C_LIVE_EVIDENCE_CLASSIFICATION.json"
];

const textFilesToCheck = [
  "README.md",
  "docs/ROADMAP.md",
  "docs/CURRENT_STATE.md",
  "docs/EVIDENCE_CLAIMS.md",
  "docs/results/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.md",
  "docs/results/AG3C_LIVE_EVIDENCE_CLASSIFICATION.md"
];

const forbiddenPatterns = [
  {
    id: "guided_planner_quality_claim",
    pattern: /AG\.3c[^\n]{0,120}(proved|proves|validated|demonstrated)[^\n]{0,80}(independent )?planner[- ]selection quality/gi
  },
  {
    id: "guided_token_savings_claim",
    pattern: /AG\.3c[^\n]{0,120}(proved|proves|validated|demonstrated)[^\n]{0,80}token savings/gi
  },
  {
    id: "production_ready_claim",
    pattern: /\b(production[- ]ready|enterprise[- ]grade autonomous|fully autonomous software engineering platform)\b/gi
  }
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const errors = [];

for (const file of requiredFiles) {
  if (!exists(file)) errors.push({ code: "required_file_missing", file });
}

if (errors.length === 0) {
  const currentState = read("docs/CURRENT_STATE.md");
  const claimRules = read("docs/EVIDENCE_CLAIMS.md");
  const classificationDoc = read("docs/results/AG3C_LIVE_EVIDENCE_CLASSIFICATION.md");
  const classification = JSON.parse(read("reports/ag/AG3C_LIVE_EVIDENCE_CLASSIFICATION.json"));

  if (!currentState.includes("single current-state source")) {
    errors.push({ code: "current_state_not_declared_canonical", file: "docs/CURRENT_STATE.md" });
  }

  for (const evidenceClass of [
    "deterministic_fixture",
    "guided_live_contract",
    "unguided_live_selection",
    "coder_patch_observation",
    "comparative_benchmark",
    "external_validation"
  ]) {
    if (!claimRules.includes(evidenceClass)) {
      errors.push({ code: "evidence_class_missing", evidenceClass });
    }
  }

  if (classification.evaluationMode !== "guided_contract_conformance") {
    errors.push({ code: "ag3c_not_classified_guided" });
  }
  if (classification.expectedOutcomeVisibleToProvider !== true) {
    errors.push({ code: "answer_leakage_not_recorded" });
  }
  if (classification.claims?.plannerSelectionQualityObserved !== false) {
    errors.push({ code: "guided_quality_claim_not_blocked" });
  }
  if (classification.claims?.tokenSavingsObserved !== false) {
    errors.push({ code: "guided_token_savings_claim_not_blocked" });
  }
  if (!classificationDoc.includes("answer leakage") && !classificationDoc.includes("expected outcome")) {
    errors.push({ code: "classification_document_does_not_explain_leakage" });
  }

  for (const file of textFilesToCheck) {
    if (!exists(file)) continue;
    const content = read(file);
    for (const rule of forbiddenPatterns) {
      const matches = [...content.matchAll(rule.pattern)];
      for (const match of matches) {
        errors.push({
          code: "forbidden_claim",
          ruleId: rule.id,
          file,
          excerpt: match[0].slice(0, 220)
        });
      }
    }
  }
}

const result = {
  ok: errors.length === 0,
  gate: "claim_integrity",
  currentStatePresent: exists("docs/CURRENT_STATE.md"),
  guidedEvidenceClassified: errors.every((entry) => entry.code !== "ag3c_not_classified_guided"),
  answerLeakageDocumented: errors.every((entry) => !["answer_leakage_not_recorded", "classification_document_does_not_explain_leakage"].includes(entry.code)),
  guidedQualityClaimsBlocked: errors.every((entry) => !["guided_quality_claim_not_blocked", "guided_token_savings_claim_not_blocked"].includes(entry.code)),
  errorCount: errors.length,
  errors
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
