const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "temporary-workspace-execution-verifier-fixture-suite.cjs"
);
const fixturePrefix = "phase-v-temp-exec-fixture-";

function fixtureDirectories() {
  return fs
    .readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(fixturePrefix))
    .map((entry) => entry.name)
    .sort();
}

function runSuite() {
  const fixtureDirectoriesBefore = fixtureDirectories();
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false
  });
  const fixtureDirectoriesAfter = fixtureDirectories();
  const report = JSON.parse(result.stdout);

  return { fixtureDirectoriesAfter, fixtureDirectoriesBefore, report, result };
}

function caseById(report, caseId) {
  const testCase = report.cases.find((candidate) => candidate.caseId === caseId);
  assert.ok(testCase, `Missing fixture case: ${caseId}`);
  return testCase;
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

check("fixture suite exits successfully", () => {
  assert.equal(suiteRun.result.status, 0, suiteRun.result.stderr || suiteRun.result.stdout);
});

check("JSON and Markdown reports exist", () => {
  const { report } = suiteRun;
  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);

  const jsonReport = JSON.parse(fs.readFileSync(report.jsonPath, "utf8"));
  const markdownReport = fs.readFileSync(report.markdownPath, "utf8");
  assert.equal(jsonReport.suiteName, report.suiteName);
  assert.ok(markdownReport.includes("Temporary Workspace Execution Verifier Fixture Suite"));
});

check("suiteName is correct", () => {
  assert.equal(
    suiteRun.report.suiteName,
    "phase-v-temporary-workspace-execution-verifier-fixture-suite"
  );
});

check("suite has at least 20 cases and all pass", () => {
  assert.ok(suiteRun.report.total >= 20, String(suiteRun.report.total));
  assert.equal(suiteRun.report.ok, true);
  assert.equal(suiteRun.report.passed, suiteRun.report.total);
  assert.equal(suiteRun.report.failed, 0);
  assert.ok(suiteRun.report.cases.every((testCase) => testCase.passed));
});

check("all three decisions are observed", () => {
  const { report } = suiteRun;
  assert.ok(report.tempValidationPassedCases > 0);
  assert.ok(report.tempValidationFailedCases > 0);
  assert.ok(report.tempValidationNeedsReviewCases > 0);
  assert.equal(report.allExpectedDecisionsObserved, true);
});

check("timeout fixture fails", () => {
  const testCase = caseById(suiteRun.report, "temp-validation-failed-timeout");
  assert.equal(testCase.actualDecision, "temp_validation_failed");
  assert.equal(testCase.timedOutCommands, 1);
  assert.ok(testCase.issueCodes.includes("validation_command_timeout"));
});

check("unexpected non-zero fixture fails", () => {
  const testCase = caseById(
    suiteRun.report,
    "temp-validation-failed-unexpected-non-zero"
  );
  assert.equal(testCase.actualDecision, "temp_validation_failed");
  assert.equal(testCase.failedCommands, 1);
  assert.ok(testCase.issueCodes.includes("validation_command_failed"));
});

check("executable launch failure fixture fails", () => {
  const testCase = caseById(suiteRun.report, "temp-validation-failed-launch");
  assert.equal(testCase.actualDecision, "temp_validation_failed");
  assert.equal(testCase.failedCommands, 1);
  assert.ok(testCase.issueCodes.includes("validation_command_launch_failed"));
});

check("passing fixture captures stdout", () => {
  const testCase = caseById(
    suiteRun.report,
    "temp-validation-passed-single-command"
  );
  assert.equal(testCase.actualDecision, "temp_validation_passed");
  assert.deepEqual(testCase.stdout, ["fixture-stdout"]);
});

check("workspace outside temp root needs review", () => {
  const testCase = caseById(
    suiteRun.report,
    "temp-validation-needs-review-workspace-outside-temp-root"
  );
  assert.equal(testCase.actualDecision, "temp_validation_needs_review");
  assert.ok(testCase.issueCodes.includes("workspace_outside_temp_root"));
  assert.equal(testCase.commandCount, 0);
  assert.equal(testCase.workspaceOutsideTempRoot, true);
  assert.equal(testCase.workspaceDeletedAfterRun, true);
});

check("unsafe executable needs review", () => {
  const testCase = caseById(
    suiteRun.report,
    "temp-validation-needs-review-unsafe-executable"
  );
  assert.equal(testCase.actualDecision, "temp_validation_needs_review");
  assert.ok(testCase.issueCodes.includes("unsafe_executable"));
});

check("unsafe environment key needs review", () => {
  const testCase = caseById(
    suiteRun.report,
    "temp-validation-needs-review-unsafe-environment-key"
  );
  assert.equal(testCase.actualDecision, "temp_validation_needs_review");
  assert.ok(testCase.issueCodes.includes("unsafe_environment_key"));
});

check("stdout and stderr truncation fixtures need review", () => {
  for (const caseId of [
    "temp-validation-needs-review-stdout-truncation",
    "temp-validation-needs-review-stderr-truncation"
  ]) {
    const testCase = caseById(suiteRun.report, caseId);
    assert.equal(testCase.actualDecision, "temp_validation_needs_review");
    assert.equal(testCase.truncatedOutputs, 1);
    assert.ok(testCase.issueCodes.includes("validation_output_truncated"));
  }
});

check("no temporary fixture directories remain after execution", () => {
  assert.deepEqual(
    suiteRun.fixtureDirectoriesAfter,
    suiteRun.fixtureDirectoriesBefore
  );
});

console.log("temporary workspace execution verifier fixture suite test passed");
