const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "phase-q-verifier-suite-report.cjs");
const { buildSummary } = require(scriptPath);

function runSuite(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-q-verifier-suite-"));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_Q_VERIFIER_SUITE_REQUIRED: "0",
      PHASE_Q_WORKER_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      ...env
    },
    encoding: "utf8"
  });
  const report = JSON.parse(result.stdout);

  return {
    result,
    report,
    tempDir
  };
}

function syntheticChildren(finalDecision) {
  return {
    deterministicVerifierGate: {
      command: "npm run test:deterministic-verifier-gate",
      exitCode: 0,
      ok: true
    },
    verifierNegativeFixtures: {
      command: "npm run report:verifier-negative-fixture-suite",
      exitCode: 0,
      reportPath: "reports/verifier-negative-fixture-suite/synthetic.json",
      ok: true,
      status: "completed",
      total: 6,
      passed: 6,
      failed: 0,
      approveCases: 1,
      needsReviewCases: 3,
      rejectCases: 2,
      allExpectedDecisionsObserved: true
    },
    orchestrator: {
      command: "npm run worker:orchestrator-smoke",
      exitCode: 0,
      reportPath: "reports/worker-backed-orchestrator-smoke/synthetic.json",
      status: "completed",
      ok: true,
      configured: true,
      finalDecision,
      plannerValidationOk: true,
      coderValidationOk: true,
      verifierCalled: true,
      verifierDecision: finalDecision.replace("_by_deterministic_verifier", "").replace("approved", "approve"),
      verifierIssueCount: finalDecision === "approved_by_deterministic_verifier" ? 0 : 1
    }
  };
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

check("suite runs with no endpoint", () => {
  const { result, report } = runSuite({});

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "partial");
});

check("suite creates JSON and Markdown report", () => {
  const { report } = runSuite({});

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);
  assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("Phase Q Verifier Suite Report"));
});

check("suiteName is phase-q-verifier-suite-report", () => {
  const { report } = runSuite({});

  assert.equal(report.suiteName, "phase-q-verifier-suite-report");
});

check("configured false when no endpoint is provided", () => {
  const { report } = runSuite({});

  assert.equal(report.configured, false);
});

check("deterministic verifier gate child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.deterministicVerifierGate);
  assert.equal(report.children.deterministicVerifierGate.command, "npm run test:deterministic-verifier-gate");
});

check("verifier negative fixtures child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.verifierNegativeFixtures);
  assert.equal(report.children.verifierNegativeFixtures.command, "npm run report:verifier-negative-fixture-suite");
});

check("orchestrator child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.orchestrator);
  assert.equal(report.children.orchestrator.command, "npm run worker:orchestrator-smoke");
});

check("negative fixture suite ok true", () => {
  const { report } = runSuite({});

  assert.equal(report.children.verifierNegativeFixtures.ok, true);
});

check("negative fixture suite observes approve needs_review and reject", () => {
  const { report } = runSuite({});

  assert.equal(report.children.verifierNegativeFixtures.approveCases > 0, true);
  assert.equal(report.children.verifierNegativeFixtures.needsReviewCases > 0, true);
  assert.equal(report.children.verifierNegativeFixtures.rejectCases > 0, true);
  assert.equal(report.children.verifierNegativeFixtures.allExpectedDecisionsObserved, true);
});

check("readyForRunPodLiveValidation is false when no endpoint is configured", () => {
  const { report } = runSuite({});

  assert.equal(report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails when no endpoint is configured", () => {
  const { result, report } = runSuite({ PHASE_Q_VERIFIER_SUITE_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("synthetic completed configured verifier-approved summary is ready for live validation only when negative fixtures passed", () => {
  const summary = buildSummary(syntheticChildren("approved_by_deterministic_verifier"), true);

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.verifierApproved, true);
  assert.equal(summary.negativeFixtureSuitePassed, true);
});

check("synthetic completed configured verifier-needs-review summary is ready for live validation only when negative fixtures passed", () => {
  const summary = buildSummary(syntheticChildren("needs_review_by_deterministic_verifier"), true);

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.verifierNeedsReview, true);
  assert.equal(summary.negativeFixtureSuitePassed, true);
});

check("synthetic completed configured verifier-rejected summary is ready for live validation only when negative fixtures passed", () => {
  const summary = buildSummary(syntheticChildren("rejected_by_deterministic_verifier"), true);

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.verifierRejected, true);
  assert.equal(summary.negativeFixtureSuitePassed, true);
});

check("synthetic completed configured summary is not ready when negative fixtures missed decisions", () => {
  const children = syntheticChildren("approved_by_deterministic_verifier");
  children.verifierNegativeFixtures.allExpectedDecisionsObserved = false;
  children.verifierNegativeFixtures.rejectCases = 0;

  const summary = buildSummary(children, true);

  assert.equal(summary.negativeFixtureAllExpectedDecisionsObserved, false);
  assert.equal(summary.readyForRunPodLiveValidation, false);
});

console.log("phase-q verifier suite report test passed");
