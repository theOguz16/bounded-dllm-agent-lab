const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "temporary-workspace-apply-fixture-suite.cjs"
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
      "Temporary Workspace Apply Fixture Suite"
    )
  );
});

check("suiteName is phase-u-temporary-workspace-apply-fixture-suite", () => {
  const { report } = suiteRun;

  assert.equal(report.suiteName, "phase-u-temporary-workspace-apply-fixture-suite");
});

check("ok true", () => {
  const { report } = suiteRun;

  assert.equal(report.ok, true);
});

check("total >= 15", () => {
  const { report } = suiteRun;

  assert.ok(report.total >= 15, String(report.total));
});

check("temp_apply_ready, temp_apply_needs_review, temp_apply_rejected are all observed", () => {
  const { report } = suiteRun;

  assert.equal(report.tempApplyReadyCases > 0, true);
  assert.equal(report.tempApplyNeedsReviewCases > 0, true);
  assert.equal(report.tempApplyRejectedCases > 0, true);
  assert.equal(report.allExpectedDecisionsObserved, true);
});

check("valid cleanup true fixture has cleanedUp true", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-true");

  assert.equal(testCase.cleanedUp, true);
});

check("valid cleanup true fixture has tempWorkspacePathExistsAfterRun false", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-true");

  assert.equal(testCase.tempWorkspacePathExistsAfterRun, false);
});

check("valid cleanup false fixture has cleanedUp false", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-false");

  assert.equal(testCase.cleanedUp, false);
});

check("valid cleanup false fixture has tempWorkspacePathExistsAfterRun true", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-false");

  assert.equal(testCase.tempWorkspacePathExistsAfterRun, true);
});

check("valid fixture has appliedFileCount >= 1", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-true");

  assert.ok(testCase.appliedFileCount >= 1, String(testCase.appliedFileCount));
});

check("valid fixture has changedFiles >= 1", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-ready-valid-cleanup-true");

  assert.ok(testCase.changedFiles >= 1, String(testCase.changedFiles));
});

check("forbidden-file fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-reject-forbidden-file");

  assert.equal(testCase.actualDecision, "temp_apply_rejected");
  assert.ok(testCase.issueCodes.includes("forbidden_file_touch"));
});

check("parent traversal fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-reject-unsafe-parent-traversal-path");

  assert.equal(testCase.actualDecision, "temp_apply_rejected");
  assert.ok(testCase.issueCodes.includes("unsafe_file_path"));
});

check(".git path fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-reject-git-path");

  assert.equal(testCase.actualDecision, "temp_apply_rejected");
  assert.ok(testCase.issueCodes.includes("unsafe_file_path"));
});

check("repair verifier not approved rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-reject-repair-verifier-not-approved");

  assert.equal(testCase.actualDecision, "temp_apply_rejected");
  assert.ok(testCase.issueCodes.includes("repair_verifier_not_approved"));
});

check("patch dry-run not ready rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-reject-patch-dry-run-not-ready");

  assert.equal(testCase.actualDecision, "temp_apply_rejected");
  assert.ok(testCase.issueCodes.includes("patch_dry_run_not_ready"));
});

check("missing original file content needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-needs-review-missing-original-file-content");

  assert.equal(testCase.actualDecision, "temp_apply_needs_review");
  assert.ok(testCase.issueCodes.includes("missing_original_file_content"));
});

check("no-op fixture needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-needs-review-no-op-patch");

  assert.equal(testCase.actualDecision, "temp_apply_needs_review");
  assert.ok(testCase.issueCodes.includes("no_op_patch"));
});

check("proposedPatch too large needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "temp-apply-needs-review-proposed-patch-too-large");

  assert.equal(testCase.actualDecision, "temp_apply_needs_review");
  assert.ok(testCase.issueCodes.includes("proposed_patch_too_large"));
});

console.log("temporary workspace apply fixture suite test passed");
