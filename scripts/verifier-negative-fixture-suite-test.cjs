const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "verifier-negative-fixture-suite.cjs");

function runSuite() {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      PHASE_Q_WORKER_UPSTREAM_URL: ""
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
  assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("Verifier Negative Fixture Suite"));
});

check("suiteName is phase-q-verifier-negative-fixture-suite", () => {
  const { report } = suiteRun;

  assert.equal(report.suiteName, "phase-q-verifier-negative-fixture-suite");
});

check("ok true", () => {
  const { report } = suiteRun;

  assert.equal(report.ok, true);
});

check("total >= 6", () => {
  const { report } = suiteRun;

  assert.ok(report.summary.total >= 6, String(report.summary.total));
});

check("approve needs_review reject are all observed", () => {
  const { report } = suiteRun;

  assert.equal(report.summary.approveCases > 0, true);
  assert.equal(report.summary.needsReviewCases > 0, true);
  assert.equal(report.summary.rejectCases > 0, true);
  assert.equal(report.summary.allExpectedDecisionsObserved, true);
});

check("forbidden-file fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "verifier-reject-forbidden-file");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("forbidden_file_touch"));
});

check("unsafe-patch fixture rejects", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "verifier-reject-unsafe-patch-content");

  assert.equal(testCase.actualDecision, "reject");
  assert.ok(testCase.issueCodes.includes("unsafe_patch_content"));
});

check("low-confidence fixture needs_review", () => {
  const { report } = suiteRun;
  const testCase = caseById(report, "verifier-needs-review-low-confidence");

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

console.log("verifier negative fixture suite test passed");
