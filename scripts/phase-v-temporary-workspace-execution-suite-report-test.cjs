const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "phase-v-temporary-workspace-execution-suite-report.cjs"
);
const { buildOrchestratorEnv, buildSummary, determineStatus } = require(scriptPath);

function runSuite(env = {}) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_V_EXECUTION_SUITE_REQUIRED: "0",
      PHASE_V_FORCE_REMASK: "0",
      PHASE_V_WORKER_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      ...env
    },
    encoding: "utf8",
    shell: false
  });

  return {
    result,
    report: JSON.parse(result.stdout)
  };
}

function syntheticChildren(executionDecision, overrides = {}) {
  return {
    executionVerifier: {
      command: "npm run test:temporary-workspace-execution-verifier",
      exitCode: 0,
      ok: true
    },
    executionVerifierFixtures: {
      command: "npm run report:temporary-workspace-execution-verifier-fixture-suite",
      exitCode: 0,
      reportPath:
        "reports/temporary-workspace-execution-verifier-fixture-suite/synthetic.json",
      ok: true,
      total: 24,
      passed: 24,
      failed: 0,
      tempValidationPassedCases: 3,
      tempValidationFailedCases: 3,
      tempValidationNeedsReviewCases: 18,
      allExpectedDecisionsObserved: true
    },
    orchestrator: {
      command: "npm run worker:orchestrator-smoke",
      exitCode: 0,
      reportPath: "reports/worker-backed-orchestrator-smoke/synthetic.json",
      status: "completed",
      ok: true,
      configured: true,
      forceRemask: false,
      finalDecision: executionDecision,
      plannerValidationOk: true,
      coderValidationOk: true,
      verifierCalled: true,
      verifierDecision: "needs_review",
      remaskRequested: true,
      repairVerifierCalled: true,
      repairVerifierDecision: "approve",
      patchDryRunCalled: true,
      patchDryRunDecision: "ready_to_apply",
      tempWorkspaceApplyCalled: true,
      tempWorkspaceApplyDecision: "temp_apply_ready",
      tempWorkspaceApplyChangedFiles: 1,
      tempWorkspaceExecutionCalled: true,
      tempWorkspaceExecutionDecision: executionDecision,
      tempWorkspaceExecutionIssueCount:
        executionDecision === "temp_validation_passed" ? 0 : 1,
      tempWorkspaceExecutionCommandCount: 1,
      tempWorkspaceExecutionPassedCommands:
        executionDecision === "temp_validation_passed" ? 1 : 0,
      tempWorkspaceExecutionFailedCommands:
        executionDecision === "temp_validation_failed" ? 1 : 0,
      tempWorkspaceExecutionTimedOutCommands: 0,
      tempWorkspaceExecutionCleanupPerformed: true,
      ...overrides.orchestrator
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

const noEndpoint = runSuite();

check("suite runs without endpoint", () => {
  assert.equal(
    noEndpoint.result.status,
    0,
    noEndpoint.result.stderr || noEndpoint.result.stdout
  );
  assert.equal(noEndpoint.report.ok, true);
  assert.equal(noEndpoint.report.status, "skipped");
});

check("JSON and Markdown reports are created", () => {
  assert.ok(fs.existsSync(noEndpoint.report.jsonPath), noEndpoint.report.jsonPath);
  assert.ok(
    fs.existsSync(noEndpoint.report.markdownPath),
    noEndpoint.report.markdownPath
  );

  const saved = JSON.parse(fs.readFileSync(noEndpoint.report.jsonPath, "utf8"));
  const markdown = fs.readFileSync(noEndpoint.report.markdownPath, "utf8");
  assert.equal(saved.suiteName, noEndpoint.report.suiteName);
  for (const heading of [
    "# Phase V Temporary Workspace Execution Suite",
    "## Suite Status",
    "## Configuration",
    "## Execution Verifier",
    "## Execution Fixture Suite",
    "## Orchestrator",
    "## Temporary Workspace Apply",
    "## Temporary Workspace Execution",
    "## Cleanup",
    "## Live Readiness",
    "## Child Report Paths"
  ]) {
    assert.ok(markdown.includes(heading), heading);
  }
});

check("suiteName is correct", () => {
  assert.equal(
    noEndpoint.report.suiteName,
    "phase-v-temporary-workspace-execution-suite-report"
  );
});

check("configured false without endpoint", () => {
  assert.equal(noEndpoint.report.configured, false);
});

check("execution verifier child exists", () => {
  const child = noEndpoint.report.children.executionVerifier;
  assert.ok(child);
  assert.equal(child.command, "npm run test:temporary-workspace-execution-verifier");
  assert.equal(child.ok, true);
});

check("fixture child exists", () => {
  const child = noEndpoint.report.children.executionVerifierFixtures;
  assert.ok(child);
  assert.equal(
    child.command,
    "npm run report:temporary-workspace-execution-verifier-fixture-suite"
  );
});

check("orchestrator child exists", () => {
  const child = noEndpoint.report.children.orchestrator;
  assert.ok(child);
  assert.equal(child.command, "npm run worker:orchestrator-smoke");
  assert.equal(child.status, "skipped");
});

check("fixture suite ok true", () => {
  assert.equal(noEndpoint.report.children.executionVerifierFixtures.ok, true);
});

check("all three execution decisions are observed", () => {
  const fixtures = noEndpoint.report.children.executionVerifierFixtures;
  assert.ok(fixtures.tempValidationPassedCases > 0);
  assert.ok(fixtures.tempValidationFailedCases > 0);
  assert.ok(fixtures.tempValidationNeedsReviewCases > 0);
  assert.equal(fixtures.allExpectedDecisionsObserved, true);
  assert.equal(
    noEndpoint.report.summary.executionFixtureAllExpectedDecisionsObserved,
    true
  );
});

check("readiness false without endpoint", () => {
  assert.equal(noEndpoint.report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails without endpoint", () => {
  const { result, report } = runSuite({
    PHASE_V_EXECUTION_SUITE_REQUIRED: "1"
  });
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("shared Phase V env maps correctly", () => {
  const mapped = buildOrchestratorEnv(
    {
      PHASE_V_WORKER_UPSTREAM_URL: "https://worker.example/v1/chat/completions",
      PHASE_V_WORKER_MODEL_ID: "phase-v-model",
      PHASE_V_WORKER_TIMEOUT_MS: "45678"
    },
    true
  );
  assert.equal(
    mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL,
    "https://worker.example/v1/chat/completions"
  );
  assert.equal(mapped.WORKER_ORCHESTRATOR_MODEL_ID, "phase-v-model");
  assert.equal(mapped.WORKER_ORCHESTRATOR_TIMEOUT_MS, "45678");
  assert.equal(mapped.WORKER_ORCHESTRATOR_REQUIRED, "1");
});

check("existing worker env is not overridden", () => {
  const mapped = buildOrchestratorEnv(
    {
      PHASE_V_WORKER_UPSTREAM_URL: "https://phase-v.example",
      PHASE_V_WORKER_MODEL_ID: "phase-v-model",
      PHASE_V_WORKER_TIMEOUT_MS: "1000",
      PHASE_V_FORCE_REMASK: "1",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "https://existing.example",
      WORKER_ORCHESTRATOR_MODEL_ID: "existing-model",
      WORKER_ORCHESTRATOR_TIMEOUT_MS: "2000",
      WORKER_ORCHESTRATOR_FORCE_REMASK: "0"
    },
    false
  );
  assert.equal(mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL, "https://existing.example");
  assert.equal(mapped.WORKER_ORCHESTRATOR_MODEL_ID, "existing-model");
  assert.equal(mapped.WORKER_ORCHESTRATOR_TIMEOUT_MS, "2000");
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "0");
});

check("intentionally empty worker env is not overridden", () => {
  const mapped = buildOrchestratorEnv(
    {
      PHASE_V_WORKER_UPSTREAM_URL: "https://phase-v.example",
      PHASE_V_WORKER_MODEL_ID: "phase-v-model",
      PHASE_V_WORKER_TIMEOUT_MS: "1000",
      PHASE_V_FORCE_REMASK: "1",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_MODEL_ID: "",
      WORKER_ORCHESTRATOR_TIMEOUT_MS: "",
      WORKER_ORCHESTRATOR_FORCE_REMASK: ""
    },
    false
  );
  assert.equal(mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL, "");
  assert.equal(mapped.WORKER_ORCHESTRATOR_MODEL_ID, "");
  assert.equal(mapped.WORKER_ORCHESTRATOR_TIMEOUT_MS, "");
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "");
});

check("PHASE_V_FORCE_REMASK maps correctly", () => {
  const mapped = buildOrchestratorEnv({ PHASE_V_FORCE_REMASK: "1" }, false);
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "1");
});

check("status maps completed, skipped, required skip, and child failure", () => {
  const completed = syntheticChildren("temp_validation_passed");
  assert.equal(determineStatus(completed, false), "completed");

  const skipped = syntheticChildren("temp_validation_passed", {
    orchestrator: { status: "skipped" }
  });
  assert.equal(determineStatus(skipped, false), "skipped");
  assert.equal(determineStatus(skipped, true), "failed");

  for (const childName of [
    "executionVerifier",
    "executionVerifierFixtures",
    "orchestrator"
  ]) {
    const failed = syntheticChildren("temp_validation_passed");
    failed[childName].exitCode = 1;
    assert.equal(determineStatus(failed, false), "failed");
  }
});

for (const existingDecision of [
  "approved_by_deterministic_verifier",
  "rejected_by_deterministic_verifier",
  "needs_review_by_deterministic_verifier",
  "remask_requested",
  "repair_draft_ready",
  "remask_repair_failed",
  "repair_approved_by_deterministic_verifier",
  "repair_needs_review_by_deterministic_verifier",
  "repair_rejected_by_deterministic_verifier",
  "patch_ready_to_apply",
  "patch_dry_run_needs_review",
  "patch_dry_run_rejected",
  "temp_apply_ready",
  "temp_apply_needs_review",
  "temp_apply_rejected"
]) {
  check(`existing final decision ${existingDecision} remains accepted`, () => {
    const summary = buildSummary(
      syntheticChildren(existingDecision),
      true,
      false
    );
    assert.equal(summary.readyForRunPodLiveValidation, true);
  });
}

for (const decision of [
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]) {
  check(`synthetic ${decision} is ready`, () => {
    const summary = buildSummary(syntheticChildren(decision), true, false);
    assert.equal(summary.readyForRunPodLiveValidation, true);
    assert.equal(summary.finalExecutionDecisionObserved, true);
  });
}

check("forced temp_validation_passed is ready", () => {
  const summary = buildSummary(
    syntheticChildren("temp_validation_passed"),
    true,
    true
  );
  assert.equal(summary.readyForRunPodLiveValidation, true);
});

for (const [name, overrides] of [
  ["remaskRequested", { remaskRequested: false }],
  ["repairVerifierCalled", { repairVerifierCalled: false }],
  ["repair verifier approve", { repairVerifierDecision: "needs_review" }],
  ["patchDryRunCalled", { patchDryRunCalled: false }],
  ["patchDryRunDecision ready_to_apply", { patchDryRunDecision: "needs_review" }],
  ["tempWorkspaceApplyCalled", { tempWorkspaceApplyCalled: false }],
  ["temp_apply_ready", { tempWorkspaceApplyDecision: "temp_apply_needs_review" }],
  ["tempWorkspaceExecutionCalled", { tempWorkspaceExecutionCalled: false }],
  [
    "execution cleanup performed",
    { tempWorkspaceExecutionCleanupPerformed: false }
  ],
  ["finalDecision to match execution decision", { finalDecision: "temp_validation_failed" }]
]) {
  check(`forced mode requires ${name}`, () => {
    const summary = buildSummary(
      syntheticChildren("temp_validation_passed", {
        orchestrator: overrides
      }),
      true,
      true
    );
    assert.equal(summary.readyForRunPodLiveValidation, false);
  });
}

console.log("phase-v temporary workspace execution suite report test passed");
