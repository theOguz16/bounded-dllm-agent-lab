const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "repair-draft-verifier-negative-fixture-suite.cjs"
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
      "RepairDraft Verifier Negative Fixture Suite"
    )
  );
});

check("suiteName is phase-s-repair-draft-verifier-negative-fixture-suite", () => {
  const { report } = suiteRun;

  assert.equal(report.suiteName, "phase-s-repair-draft-verifier-negative-fixture-suite");
});

check("ok true", () => {
  const { report } = suiteRun;

  assert.equal(report.ok, true);
});

check("total >= 10", () => {
  const { report } = suiteRun;

  assert.ok(report.total >= 10, String(report.total));
});

check("approve needs_review reject are all observed", () => {
  const { report } = suiteRun;

  assert.equal(report.approveCases > 0, true);
  assert.equal(report.needsReviewCases > 0, true);
  assert.equal(report.rejectCases > 0, true);
  assert.equal(report.allExpectedDecisionsObserved, true);
});

check("forbidden-file fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "repair-draft-reject-forbidden-file");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("forbidden_file_touch"));
});

check("unsafe-patch fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "repair-draft-reject-unsafe-patch-content");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("unsafe_repair_patch_content"));
});

check("required issue code not addressed needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(
    report,
    "repair-draft-needs-review-required-issue-code-not-addressed"
  );

  assert.equal(testCase.actualDecision, "needs_review");
  assert.ok(testCase.issueCodes.includes("required_issue_code_not_addressed"));
});

check("low-confidence fixture needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "repair-draft-needs-review-low-confidence");

  assert.equal(testCase.actualDecision, "needs_review");
  assert.ok(testCase.issueCodes.includes("low_confidence"));
});

check("every finding has role verifier", () => {
  const { report } = suiteRun;

  assert.equal(report.cases.every((testCase) => testCase.findingRole === "verifier"), true);
});

check("every finding has target verifierFinding", () => {
  const { report } = suiteRun;

  assert.equal(
    report.cases.every((testCase) => testCase.findingTarget === "verifierFinding"),
    true
  );
});

console.log("repairDraft verifier negative fixture suite test passed");
