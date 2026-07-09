const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "phase-s-repair-verification-suite-report.cjs");
const { buildOrchestratorEnv, buildSummary } = require(scriptPath);

function runSuite(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-s-repair-suite-"));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_S_REPAIR_SUITE_REQUIRED: "0",
      PHASE_S_FORCE_REMASK: "0",
      PHASE_S_WORKER_UPSTREAM_URL: "",
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
    repairDraftVerifierGate: {
      command: "npm run test:repair-draft-verifier-gate",
      exitCode: 0,
      ok: true
    },
    repairDraftVerifierFixtures: {
      command: "npm run report:repair-draft-verifier-negative-fixture-suite",
      exitCode: 0,
      reportPath: "reports/repair-draft-verifier-negative-fixture-suite/synthetic.json",
      ok: true,
      total: 12,
      passed: 12,
      failed: 0,
      approveCases: 1,
      needsReviewCases: 7,
      rejectCases: 4,
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
      remaskRepairability: null,
      remaskValidationOk: null,
      repairDraftChecksOk: null,
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
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
      "Phase S Repair Verification Suite Report"
    )
  );
});

check("suiteName is phase-s-repair-verification-suite-report", () => {
  const { report } = runSuite({});

  assert.equal(report.suiteName, "phase-s-repair-verification-suite-report");
});

check("configured false when no endpoint is provided", () => {
  const { report } = runSuite({});

  assert.equal(report.configured, false);
});

check("repairDraftVerifierGate child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.repairDraftVerifierGate);
  assert.equal(
    report.children.repairDraftVerifierGate.command,
    "npm run test:repair-draft-verifier-gate"
  );
});

check("repairDraftVerifierFixtures child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.repairDraftVerifierFixtures);
  assert.equal(
    report.children.repairDraftVerifierFixtures.command,
    "npm run report:repair-draft-verifier-negative-fixture-suite"
  );
});

check("orchestrator child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.orchestrator);
  assert.equal(report.children.orchestrator.command, "npm run worker:orchestrator-smoke");
});

check("fixture suite ok true", () => {
  const { report } = runSuite({});

  assert.equal(report.children.repairDraftVerifierFixtures.ok, true);
});

check("fixture suite observes approve needs_review and reject", () => {
  const { report } = runSuite({});

  assert.equal(report.children.repairDraftVerifierFixtures.approveCases > 0, true);
  assert.equal(report.children.repairDraftVerifierFixtures.needsReviewCases > 0, true);
  assert.equal(report.children.repairDraftVerifierFixtures.rejectCases > 0, true);
  assert.equal(report.children.repairDraftVerifierFixtures.allExpectedDecisionsObserved, true);
});

check("readyForRunPodLiveValidation is false when no endpoint is configured", () => {
  const { report } = runSuite({});

  assert.equal(report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails when no endpoint is configured", () => {
  const { result, report } = runSuite({ PHASE_S_REPAIR_SUITE_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("shared Phase S worker env maps to orchestrator env", () => {
  const env = buildOrchestratorEnv(
    {
      PHASE_S_WORKER_UPSTREAM_URL: "http://127.0.0.1:9999/v1/chat/completions",
      PHASE_S_WORKER_MODEL_ID: "qwen-repair-test",
      PHASE_S_WORKER_TIMEOUT_MS: "12345"
    },
    true
  );

  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "qwen-repair-test");
  assert.equal(env.WORKER_ORCHESTRATOR_TIMEOUT_MS, "12345");
  assert.equal(env.WORKER_ORCHESTRATOR_REQUIRED, "1");
});

check("shared Phase S worker env does not override existing worker env", () => {
  const env = buildOrchestratorEnv(
    {
      PHASE_S_WORKER_UPSTREAM_URL: "http://shared.example/v1/chat/completions",
      PHASE_S_WORKER_MODEL_ID: "shared-model",
      PHASE_S_WORKER_TIMEOUT_MS: "12345",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://orchestrator.example/v1/chat/completions",
      WORKER_ORCHESTRATOR_MODEL_ID: "orchestrator-model"
    },
    false
  );

  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://orchestrator.example/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "orchestrator-model");
  assert.equal(env.WORKER_ORCHESTRATOR_TIMEOUT_MS, "12345");
});

check("PHASE_S_FORCE_REMASK maps to WORKER_ORCHESTRATOR_FORCE_REMASK", () => {
  const env = buildOrchestratorEnv({ PHASE_S_FORCE_REMASK: "1" }, false);

  assert.equal(env.WORKER_ORCHESTRATOR_FORCE_REMASK, "1");
});

check("synthetic completed configured approve path is ready in non-forced mode", () => {
  const summary = buildSummary(syntheticChildren("approved_by_deterministic_verifier"), true);

  assert.equal(summary.readyForRunPodLiveValidation, true);
});

check("synthetic completed configured repair_approved path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("repair_approved_by_deterministic_verifier", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalRepairDecisionObserved, true);
  assert.equal(summary.repairVerifierApproved, true);
});

check("synthetic completed configured repair_needs_review path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("repair_needs_review_by_deterministic_verifier", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "needs_review",
        repairVerifierIssueCount: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalRepairDecisionObserved, true);
  assert.equal(summary.repairVerifierNeedsReview, true);
});

check("synthetic completed configured repair_rejected path is ready", () => {
  const summary = buildSummary(
    syntheticChildren("repair_rejected_by_deterministic_verifier", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "reject",
        repairVerifierIssueCount: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalRepairDecisionObserved, true);
  assert.equal(summary.repairVerifierRejected, true);
});

check("synthetic completed configured patch_ready_to_apply summary is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0,
        patchDryRunCalled: true,
        patchDryRunDecision: "ready_to_apply",
        patchDryRunIssueCount: 0,
        patchDryRunChangedFiles: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
  assert.equal(summary.patchDryRunCalled, true);
  assert.equal(summary.patchDryRunDecisionObserved, true);
});

check("synthetic completed configured patch_dry_run_needs_review summary is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_dry_run_needs_review", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0,
        patchDryRunCalled: true,
        patchDryRunDecision: "needs_review",
        patchDryRunIssueCount: 1,
        patchDryRunChangedFiles: 0
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
  assert.equal(summary.patchDryRunDecision, "needs_review");
});

check("synthetic completed configured patch_dry_run_rejected summary is ready", () => {
  const summary = buildSummary(
    syntheticChildren("patch_dry_run_rejected", {
      orchestrator: {
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0,
        patchDryRunCalled: true,
        patchDryRunDecision: "reject",
        patchDryRunIssueCount: 1,
        patchDryRunChangedFiles: 1
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalPatchDryRunDecisionObserved, true);
  assert.equal(summary.patchDryRunDecision, "reject");
});

check("synthetic forced repair_approved summary is ready", () => {
  const summary = buildSummary(
    syntheticChildren("repair_approved_by_deterministic_verifier", {
      orchestrator: {
        forceRemask: true,
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.finalRepairDecisionObserved, true);
  assert.equal(summary.repairVerifierCalled, true);
});

check("forced remask patch_ready_to_apply summary is ready and includes patchDryRunCalled true", () => {
  const summary = buildSummary(
    syntheticChildren("patch_ready_to_apply", {
      orchestrator: {
        forceRemask: true,
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0,
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
  assert.equal(summary.finalRepairOrPatchDecisionObserved, true);
  assert.equal(summary.patchDryRunCalled, true);
});

check("forced remask with repairVerifier approve but patchDryRunCalled false is not ready when patch dry-run fields are expected", () => {
  const summary = buildSummary(
    syntheticChildren("repair_approved_by_deterministic_verifier", {
      orchestrator: {
        forceRemask: true,
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve",
        repairVerifierIssueCount: 0,
        patchDryRunCalled: false,
        patchDryRunDecision: null,
        patchDryRunIssueCount: 0,
        patchDryRunChangedFiles: null
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.patchDryRunFieldsPresent, true);
  assert.equal(summary.patchDryRunCalled, false);
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
    syntheticChildren("repair_approved_by_deterministic_verifier", {
      orchestrator: {
        remaskRequested: false,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: true,
        repairVerifierDecision: "approve"
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
    syntheticChildren("repair_approved_by_deterministic_verifier", {
      orchestrator: {
        remaskRequested: true,
        remaskValidationOk: true,
        repairDraftChecksOk: true,
        repairVerifierCalled: false,
        repairVerifierDecision: null
      }
    }),
    true,
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, false);
  assert.equal(summary.repairVerifierCalled, false);
});

console.log("phase-s repair verification suite report test passed");
