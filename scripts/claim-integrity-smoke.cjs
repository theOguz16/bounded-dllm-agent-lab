#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  collectForbiddenClaims,
  stripPolicyExamples
} = require("./verify-claim-integrity.cjs");

const run = spawnSync(process.execPath, ["scripts/verify-claim-integrity.cjs"], {
  cwd: process.cwd(),
  encoding: "utf8"
});

assert.equal(run.status, 0, run.stderr || run.stdout);
const result = JSON.parse(run.stdout);
assert.equal(result.ok, true);
assert.equal(result.gate, "claim_integrity");
assert.equal(result.currentStatePresent, true);
assert.equal(result.guidedEvidenceClassified, true);
assert.equal(result.answerLeakageDocumented, true);
assert.equal(result.guidedQualityClaimsBlocked, true);
assert.equal(result.errorCount, 0);

const policyExample = [
  "Preferred:",
  "",
  "> Provider-reported token usage was observed.",
  "",
  "Prohibited:",
  "",
  "> AG.3c proved token savings."
].join("\n");

assert.equal(
  collectForbiddenClaims("docs/EVIDENCE_CLAIMS.md", policyExample).length,
  0,
  "prohibited documentation examples must not be treated as active project claims"
);

const activeClaim = "AG.3c proved token savings across the evaluated workflow.";
const activeFindings = collectForbiddenClaims("README.md", activeClaim);
assert.equal(activeFindings.length, 1);
assert.equal(activeFindings[0].ruleId, "guided_token_savings_claim");

const currentStateExample = [
  "## Prohibited Current Claims",
  "",
  "- is production-ready;",
  "",
  "## Next Work",
  "",
  "Continue the prototype."
].join("\n");
assert.equal(stripPolicyExamples("docs/CURRENT_STATE.md", currentStateExample).includes("production-ready"), false);

console.log(JSON.stringify({
  ok: true,
  gate: result.gate,
  checks: {
    currentStatePresent: result.currentStatePresent,
    guidedEvidenceClassified: result.guidedEvidenceClassified,
    answerLeakageDocumented: result.answerLeakageDocumented,
    guidedQualityClaimsBlocked: result.guidedQualityClaimsBlocked,
    prohibitedExamplesIgnored: true,
    activeForbiddenClaimsDetected: true
  }
}, null, 2));
