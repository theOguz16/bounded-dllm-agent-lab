const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "phase-u-temporary-workspace-apply-suite-report.cjs"
);
const { buildOrchestratorEnv, buildSummary } = require(scriptPath);

function runSuite(env = {}) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_U_TEMP_APPLY_SUITE_REQUIRED: "0",
      PHASE_U_FORCE_REMASK: "0",
      PHASE_U_WORKER_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      ...env
    },
    encoding: "utf8"
  });

  return {
    result,
    report: JSON.parse(result.stdout)
  };
}

function syntheticChildren(finalDecision, overrides = {}) {
  return {
    tempWorkspaceApplyGate: {
      command: "npm run test:temporary-workspace-apply-gate",
      exitCode: 0,
      ok: true
    },
    tempWorkspaceApplyFixtures: {
      command: "npm run report:temporary-workspace-apply-fixture-suite",
      exitCode: 0,
      reportPath: "reports/temporary-workspace-apply-fixture-suite/synthetic.json",
      ok: true,
      total: 19,
      passed: 19,
      failed: 0,
      tempApplyReadyCases: 2,
      tempApplyNeedsReviewCases: 7,
      tempApplyRejectedCases: 10,
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
      finalDecision,
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
      tempWorkspaceApplyDecision: finalDecision,
      tempWorkspaceApplyIssueCount: finalDecision === "temp_apply_ready" ? 0 : 1,
      tempWorkspaceApplyChangedFiles: finalDecision === "temp_apply_ready" ? 1 : 0,
      tempWorkspaceApplyCleanedUp: true,
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

check("suite runs with no endpoint", () => {
  assert.equal(noEndpoint.result.status, 0, noEndpoint.result.stderr || noEndpoint.result.stdout);
  assert.equal(noEndpoint.report.ok, true);
  assert.equal(noEndpoint.report.status, "skipped");
});

check("suite creates JSON and Markdown report", () => {
  assert.ok(fs.existsSync(noEndpoint.report.jsonPath), noEndpoint.report.jsonPath);
  assert.ok(fs.existsSync(noEndpoint.report.markdownPath), noEndpoint.report.markdownPath);
  const markdown = fs.readFileSync(noEndpoint.report.markdownPath, "utf8");
  assert.ok(markdown.includes("Phase U Temporary Workspace Apply Suite Report"));
  assert.ok(markdown.includes("Ready for RunPod live validation: false"));
});

check("suiteName is phase-u-temporary-workspace-apply-suite-report", () => {
  assert.equal(noEndpoint.report.suiteName, "phase-u-temporary-workspace-apply-suite-report");
});

check("configured false without endpoint", () => {
  assert.equal(noEndpoint.report.configured, false);
});

check("gate child exists", () => {
  assert.ok(noEndpoint.report.children.tempWorkspaceApplyGate);
  assert.equal(noEndpoint.report.children.tempWorkspaceApplyGate.ok, true);
});

check("fixture child exists and is successful", () => {
  const fixtures = noEndpoint.report.children.tempWorkspaceApplyFixtures;
  assert.ok(fixtures);
  assert.equal(fixtures.ok, true);
  assert.equal(fixtures.allExpectedDecisionsObserved, true);
});

check("fixture suite observes all three temp apply decisions", () => {
  const fixtures = noEndpoint.report.children.tempWorkspaceApplyFixtures;
  assert.ok(fixtures.tempApplyReadyCases > 0);
  assert.ok(fixtures.tempApplyNeedsReviewCases > 0);
  assert.ok(fixtures.tempApplyRejectedCases > 0);
});

check("orchestrator child exists", () => {
  assert.ok(noEndpoint.report.children.orchestrator);
  assert.equal(noEndpoint.report.children.orchestrator.status, "skipped");
});

check("readiness is false without endpoint", () => {
  assert.equal(noEndpoint.report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails without endpoint", () => {
  const { result, report } = runSuite({ PHASE_U_TEMP_APPLY_SUITE_REQUIRED: "1" });
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("shared Phase U worker env maps to orchestrator env", () => {
  const mapped = buildOrchestratorEnv({
    PHASE_U_WORKER_UPSTREAM_URL: "https://worker.example/v1/chat/completions",
    PHASE_U_WORKER_MODEL_ID: "phase-u-model",
    PHASE_U_WORKER_TIMEOUT_MS: "34567"
  }, false);
  assert.equal(mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL, "https://worker.example/v1/chat/completions");
  assert.equal(mapped.WORKER_ORCHESTRATOR_MODEL_ID, "phase-u-model");
  assert.equal(mapped.WORKER_ORCHESTRATOR_TIMEOUT_MS, "34567");
});

check("existing worker env is not overridden", () => {
  const mapped = buildOrchestratorEnv({
    PHASE_U_WORKER_UPSTREAM_URL: "https://phase-u.example",
    PHASE_U_WORKER_MODEL_ID: "phase-u-model",
    PHASE_U_WORKER_TIMEOUT_MS: "1000",
    PHASE_U_FORCE_REMASK: "1",
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "https://existing.example",
    WORKER_ORCHESTRATOR_MODEL_ID: "existing-model",
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "2000",
    WORKER_ORCHESTRATOR_FORCE_REMASK: "0"
  }, false);
  assert.equal(mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL, "https://existing.example");
  assert.equal(mapped.WORKER_ORCHESTRATOR_MODEL_ID, "existing-model");
  assert.equal(mapped.WORKER_ORCHESTRATOR_TIMEOUT_MS, "2000");
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "0");
});

check("existing empty worker env is not overridden", () => {
  const mapped = buildOrchestratorEnv({
    PHASE_U_WORKER_UPSTREAM_URL: "https://phase-u.example",
    PHASE_U_FORCE_REMASK: "1",
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
    WORKER_ORCHESTRATOR_FORCE_REMASK: ""
  }, false);
  assert.equal(mapped.WORKER_ORCHESTRATOR_UPSTREAM_URL, "");
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "");
});

check("PHASE_U_FORCE_REMASK maps correctly", () => {
  const mapped = buildOrchestratorEnv({ PHASE_U_FORCE_REMASK: "1" }, false);
  assert.equal(mapped.WORKER_ORCHESTRATOR_FORCE_REMASK, "1");
});

for (const finalDecision of [
  "temp_apply_ready",
  "temp_apply_needs_review",
  "temp_apply_rejected"
]) {
  check(`synthetic ${finalDecision} is ready`, () => {
    const summary = buildSummary(syntheticChildren(finalDecision), true, false);
    assert.equal(summary.readyForRunPodLiveValidation, true);
    assert.equal(summary.finalTempApplyDecisionObserved, true);
  });
}

check("forced temp_apply_ready is ready", () => {
  const summary = buildSummary(syntheticChildren("temp_apply_ready"), true, true);
  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.tempWorkspaceApplyReady, true);
});

for (const [name, overrides] of [
  ["remaskRequested", { remaskRequested: false }],
  ["repairVerifierCalled", { repairVerifierCalled: false }],
  ["patchDryRunCalled", { patchDryRunCalled: false }],
  ["tempWorkspaceApplyCalled", { tempWorkspaceApplyCalled: false }]
]) {
  check(`forced mode without ${name} is not ready`, () => {
    const summary = buildSummary(
      syntheticChildren("temp_apply_ready", { orchestrator: overrides }),
      true,
      true
    );
    assert.equal(summary.readyForRunPodLiveValidation, false);
  });
}

check("forced mode requires patchDryRunDecision ready_to_apply", () => {
  const summary = buildSummary(
    syntheticChildren("temp_apply_ready", {
      orchestrator: { patchDryRunDecision: "needs_review" }
    }),
    true,
    true
  );
  assert.equal(summary.readyForRunPodLiveValidation, false);
});

console.log("phase-u temporary workspace apply suite report test passed");
