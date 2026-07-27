#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

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

console.log(JSON.stringify({
  ok: true,
  gate: result.gate,
  checks: {
    currentStatePresent: result.currentStatePresent,
    guidedEvidenceClassified: result.guidedEvidenceClassified,
    answerLeakageDocumented: result.answerLeakageDocumented,
    guidedQualityClaimsBlocked: result.guidedQualityClaimsBlocked
  }
}, null, 2));
