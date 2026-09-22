const assert = require("node:assert/strict");
const fs = require("node:fs");

const evidence = JSON.parse(fs.readFileSync(
  "docs/results/P7_8_RELATIVE_IMPORT_EVIDENCE.json",
  "utf8"
));

assert.equal(evidence.schemaVersion, "p7-8-relative-import-evidence/v1");
assert.equal(evidence.historicalArtifact.detailCompleteness, "aggregate_failure_code_only");
assert.match(evidence.historicalArtifact.sha256, /^[a-f0-9]{64}$/);
assert.equal(evidence.classification, "resolver_bug");
assert.equal(evidence.cases.length, 3);
assert.equal(new Set(evidence.cases.map((item) => item.taskId)).size, 3);

for (const item of evidence.cases) {
  assert.match(item.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(item.sourceFileSha256, /^[a-f0-9]{64}$/);
  assert(item.sourceFile.length > 0);
  assert(item.specifier.startsWith("../dist/"));
  assert.equal(item.previousRejectionReason, "target_not_found");
  assert(item.previousCandidates.length >= 4);
  assert(!item.previousCandidates.includes(item.resolvedTarget));
  assert(!item.resolvedTarget.startsWith("dist/"));
  assert.equal(item.postFixDecision, "repo_intelligence_ready");
}

assert.deepEqual(evidence.safetyAssertions, {
  traversalRejected: true,
  symlinkRejected: true,
  generatedDistIgnored: true,
  missingCheckedInSourceBlocked: true,
  readableRepositoryUnchanged: true,
  invalidImportStillBlocked: true
});

console.log("P7.8 relative-import evidence smoke passed");
