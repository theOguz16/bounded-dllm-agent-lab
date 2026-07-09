const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "phase-t-patch-dry-run-suite-report.cjs");
const { buildOrchestratorEnv, buildSummary } = require(scriptPath);

function runSuite(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-t-patch-suite-"));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_T_PATCH_DRY_RUN_SUITE_REQUIRED: "0",
      PHASE_T_FORCE_REMASK: "0",
      PHASE_T_WORKER_UPSTREAM_URL: "",
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

function syntheticChildren(finalDecision, overrides = {}) {
  return {
    patchDryRunGate: {
      command: "npm run test:patch-application-dry-run-gate",
      exitCode: 0,
      ok: true
    },
    patchDryRunFixtures: {
      command: "npm run report:patch-application-dry-run-fixture-suite",
      exitCode: 0,
      reportPath: "reports/patch-application-dry-run-fixture-suite/synthetic.json",
      ok: true,
      total: 18,
      passed: 18,
      failed: 0,
      readyToApplyCases: 1,
      needsReviewCases: 11,
      rejectCases: 6,
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
      verifierDecision: finalDecision === "approved_by_deterministic_verifier" ? "approve" : "needs_review",
      verifierIssueCount: finalDecision === "approved_by_deterministic_verifier" ? 0 : 1,
      remaskRequested: false,
      remaskValidationOk: null,
      repairDraftChecksOk: null,
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
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

check("suite runs with no endpoint", () => {
  const { result, report } = runSuite({});

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("suite creates JSON and Markdown report", () => {
  const { report } = runSuite({});

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);
  assert.ok(
    fs.readFileSync(report.markdownPath, "utf8").includes(
      "Phase T Patch Dry-Run Suite Report"
    )
  );
});

check("suiteName is phase-t-patch-dry-run-suite-report", () => {
  const { report } = runSuite({});

  assert.equal(report.suiteName, "phase-t-patch-dry-run-suite-report");
});

check("configured false when no endpoint is provided", () => {
  const { report } = runSuite({});

  assert.equal(report.configured, false);
});

check("patchDryRunGate child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.patchDryRunGate);
  assert.equal(
    report.children.patchDryRunGate.command,
    "npm run test:patch-application-dry-run-gate"
  );
});

check("patchDryRunFixtures child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.patchDryRunFixtures);
  assert.equal(
    report.children.patchDryRunFixtures.command,
    "npm run report:patch-application-dry-run-fixture-suite"
  );
});

check("orchestrator child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.orchestrator);
  assert.equal(report.children.orchestrator.command, "npm run worker:orchestrator-smoke");
});

check("fixture suite ok true", () => {
  const { report } = runSuite({});

  assert.equal(report.children.patchDryRunFixtures.ok, true);
});

check("fixture suite observes ready_to_apply needs_review reject", () => {
  const { report } = runSuite({});

  assert.equal(report.children.patchDryRunFixtures.readyToApplyCases > 0, true);
  assert.equal(report.children.patchDryRunFixtures.needsReviewCases > 0, true);
  assert.equal(report.children.patchDryRunFixtures.rejectCases > 0, true);
  assert.equal(report.children.patchDryRunFixtures.allExpectedDecisionsObserved, true);
});

check("readyForRunPodLiveValidation is false when no endpoint is configured", () => {
  const { report } = runSuite({});

  assert.equal(report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails when no endpoint is configured", () => {
  const { result, report } = runSuite({ PHASE_T_PATCH_DRY_RUN_SUITE_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("shared Phase T worker env maps to orchestrator env", () => {
  const env = buildOrchestratorEnv(
    {
      PHASE_T_WORKER_UPSTREAM_URL: "http://127.0.0.1:9999/v1/chat/completions",
      PHASE_T_WORKER_MODEL_ID: "qwen-patch-test",
      PHASE_T_WORKER_TIMEOUT_MS: "12345"
    },
    true
  );

  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "qwen-patch-test");
  assert.equal(env.WORKER_ORCHESTRATOR_TIMEOUT_MS, "12345");
  assert.equal(env.WORKER_ORCHESTRATOR_REQUIRED, "1");
});

check("shared Phase T worker env does not override existing worker env", () => {
  const env = buildOrchestratorEnv(
    {
      PHASE_T_WORKER_UPSTREAM_URL: "http://shared.example/v1/chat/completions",
      PHASE_T_WORKER_MODEL_ID: "shared-model",
      PHASE_T_WORKER_TIMEOUT_MS: "12345",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://orchestrator.example/v1/chat/completions",
      WORKER_ORCHESTRATOR_MODEL_ID: "orchestrator-model"
    },
    false
  );

  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://orchestrator.example/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "orchestrator-model");
  assert.equal(env.WORKER_ORCHESTRATOR_TIMEOUT_MS, "12345");
});

check("PHASE_T_FORCE_REMASK maps to WORKER_ORCHESTRATOR_FORCE_REMASK", () => {
  const env = buildOrchestratorEnv({ PHASE_T_FORCE_REMASK: "1" }, false);

  assert.equal(env.WORKER_ORCHESTRATOR_FORCE_REMASK, "1");
});

check("synthetic completed configured approve path is ready in non-forced mode", () => {
  const summary = buildSummary(syntheticChildren("approved_by_deterministic_verifier"), true);

  assert.equal(summary.readyForRunPodLiveValidation, true);
});

check("synthetic completed configured patch_ready_to_apply path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        remaskRequested: true,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: true,
        patchDryRunDecision: "ready_to_apply",
        patchDryRunIssueCount: 0,
        patchDryRunChangedFiles: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.patchDryRunReadyToApply, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
});

check("synthetic completed configured patch_dry_run_needs_review path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_dry_run_needs_review", {
      orchestrator: {
        remaskRequested: true,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: true,
        patchDryRunDecision: "needs_review",
        patchDryRunIssueCount: 1,
        patchDryRunChangedFiles: 0
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.patchDryRunNeedsReview, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
});

check("synthetic completed configured patch_dry_run_rejected path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_dry_run_rejected", {
      orchestrator: {
        remaskRequested: true,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: true,
        patchDryRunDecision: "reject",
        patchDryRunIssueCount: 1,
        patchDryRunChangedFiles: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.patchDryRunRejected, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
});

check("synthetic forced patch_ready_to_apply summary is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        forceRemask: true,
        remaskRequested: true,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: true,
        patchDryRunDecision: "ready_to_apply",
        patchDryRunIssueCount: 0,
        patchDryRunChangedFiles: 1
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.patchDryRunCalled, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
});

check("synthetic forced approve path without remask is not ready", () => {
  const summary = buildSummary(
    syntheticChildren("approved_by_deterministic_verifier", {
      orchestrator: {
        verifierDecision: "approve",
        remaskRequested: false
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.remaskRequested, false);
});

check("forced mode requires remaskRequested true", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        remaskRequested: false,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: true,
        patchDryRunDecision: "ready_to_apply"
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.remaskRequested, false);
});

check("forced mode requires repairVerifierCalled true", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        remaskRequested: true,
        repairVerifierCalled: false,
        repairVerifierDecision: null,
        patchDryRunCalled: true,
        patchDryRunDecision: "ready_to_apply"
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.repairVerifierCalled, false);
});

check("forced mode requires patchDryRunCalled true", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        remaskRequested: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        patchDryRunCalled: false,
        patchDryRunDecision: null
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.patchDryRunCalled, false);
});

console.log("phase-t patch dry-run suite report test passed");
