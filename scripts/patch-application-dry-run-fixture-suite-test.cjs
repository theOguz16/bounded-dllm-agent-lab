const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "patch-application-dry-run-fixture-suite.cjs"
);

function runSuite() {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_REMASK_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      PHASE_R_WORKER_UPSTREAM_URL: ""
    },
    encoding: "utf8"
  });
  const report = JSON.parse(result.stdout);

  return {
    result,
    report
  };
}

function caseById(report, caseId) {
  return report.cases.find((testCase) => testCase.caseId === caseId);
}

function check(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

const suiteRun = runSuite();

check("suite runs without live endpoint", () => {
  const { result, report } = suiteRun;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.status, "completed");
});

check("suite creates JSON and Markdown report", () => {
  const { report } = suiteRun;

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);
  assert.ok(
    fs.readFileSync(report.markdownPath, "utf8").includes(
      "Patch Application Dry-Run Fixture Suite"
    )
  );
});

check("suiteName is phase-t-patch-application-dry-run-fixture-suite", () => {
  const { report } = suiteRun;

  assert.equal(report.suiteName, "phase-t-patch-application-dry-run-fixture-suite");
});

check("ok true", () => {
  const { report } = suiteRun;

  assert.equal(report.ok, true);
});

check("total >= 15", () => {
  const { report } = suiteRun;

  assert.ok(report.total >= 15, String(report.total));
});

check("ready_to_apply needs_review reject are all observed", () => {
  const { report } = suiteRun;

  assert.equal(report.readyToApplyCases > 0, true);
  assert.equal(report.needsReviewCases > 0, true);
  assert.equal(report.rejectCases > 0, true);
  assert.equal(report.allExpectedDecisionsObserved, true);
});

check("valid fixture has previewCount >= 1", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-ready-valid-approved-repair-draft");

  assert.ok(testCase.previewCount >= 1, String(testCase.previewCount));
});

check("valid fixture has changedFiles >= 1", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-ready-valid-approved-repair-draft");

  assert.ok(testCase.changedFiles >= 1, String(testCase.changedFiles));
});

check("forbidden-file fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-reject-forbidden-file");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("forbidden_file_touch"));
});

check("unsafe-patch fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-reject-unsafe-proposed-patch");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("unsafe_repair_patch_content"));
});

check("no-op fixture needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-needs-review-no-op-patch");

  assert.equal(testCase.actualDecision, "needs_review");
  assert.ok(testCase.issueCodes.includes("no_op_patch"));
});

check("missing repair verifier approval rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(
    report,
    "patch-dry-run-reject-missing-repair-verifier-approval"
  );

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("missing_repair_verifier_approval"));
});

check("repair verifier needs_review rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-reject-repair-verifier-needs-review");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("repair_verifier_not_approved"));
});

check("missing original file content needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(
    report,
    "patch-dry-run-needs-review-missing-original-file-content"
  );

  assert.equal(testCase.actualDecision, "needs_review");
  assert.ok(testCase.issueCodes.includes("missing_original_file_content"));
});

check("proposedPatch too large needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "patch-dry-run-needs-review-proposed-patch-too-large");

  assert.equal(testCase.actualDecision, "needs_review");
  assert.ok(testCase.issueCodes.includes("proposed_patch_too_large"));
});

console.log("patch application dry-run fixture suite test passed");
