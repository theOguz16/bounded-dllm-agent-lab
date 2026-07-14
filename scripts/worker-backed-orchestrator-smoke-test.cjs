const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "worker-backed-orchestrator-smoke.cjs");
const {
  buildForcedRemaskVerifierResult,
  configFromEnv,
  decide,
  emptyRemaskReport,
  emptyPatchDryRunReport,
  emptyRepairVerifierReport,
  fixture,
  run,
  verifyAndCleanupTemporaryWorkspace
} = require(scriptPath);

function runSmoke(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-orchestrator-smoke-"));
  const outDir = path.join(tempDir, "reports");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_OUT_DIR: outDir,
      ...env
    },
    encoding: "utf8",
    shell: false
  });

  const report = JSON.parse(result.stdout);

  return {
    result,
    report,
    outDir
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

check("missing endpoint produces skipped report by default", () => {
  const { result, report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("missing endpoint fails when WORKER_ORCHESTRATOR_REQUIRED=1", () => {
  const { result, report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed_required_endpoint_missing");
});

check("script creates JSON and Markdown report", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);

  const saved = JSON.parse(fs.readFileSync(report.jsonPath, "utf8"));
  const markdown = fs.readFileSync(report.markdownPath, "utf8");

  assert.equal(saved.jsonPath, report.jsonPath);
  assert.ok(markdown.includes("Worker-Backed Orchestrator Smoke"));
  assert.ok(markdown.includes("Status: skipped"));
  assert.ok(markdown.includes("Final decision: skipped"));
  assert.ok(markdown.includes("## Verifier"));
  assert.ok(markdown.includes("Verifier called: false"));
  assert.ok(markdown.includes("## Remask"));
  assert.ok(markdown.includes("Remask requested: false"));
  assert.ok(markdown.includes("## Repair Verifier"));
  assert.ok(markdown.includes("Repair verifier called: false"));
  assert.ok(markdown.includes("## Patch Dry Run"));
  assert.ok(markdown.includes("Patch dry run called: false"));
  assert.ok(markdown.includes("## Temporary Workspace Execution Verification"));
});

check("skipped report has suiteName phase-p-worker-backed-orchestrator-smoke", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-backed-orchestrator-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("W.6 skipped report creates no ledger, trace, or Shadow stage", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });
  assert.equal(report.accountability.ledgerCreated, false);
  assert.equal(report.accountability.ledger, null);
  assert.equal(report.accountability.preShadowTrace, null);
  assert.equal(report.accountability.postShadowTrace, null);
  assert.equal(report.shadowObserver.configured, false);
  assert.equal(report.shadowObserver.called, false);
  assert.equal(report.shadowObserver.decision, null);
  assert.equal(report.shadowObserver.eventAppended, false);
  assert.equal(report.shadowStageDecision, "shadow_not_called");
});

check("no live network call is required", () => {
  const { result, report } = runSmoke({
    WORKER_ORCHESTRATOR_REQUIRED: "0",
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "1"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.configured, false);
  assert.equal(report.planner.latencyMs, null);
  assert.equal(report.coder.latencyMs, null);
});

check("skipped report has planner.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.planner.called, false);
});

check("skipped report has coder.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.coder.called, false);
});

check("skipped report has verifier.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.verifier.called, false);
});

check("skipped report has remask.called false and remask.requested false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.remask.called, false);
  assert.equal(report.remask.requested, false);
});

check("skipped report has repairVerifier.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.repairVerifier.called, false);
  assert.equal(report.repairVerifier.decision, null);
});

check("skipped report has patchDryRun.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.patchDryRun.called, false);
  assert.equal(report.patchDryRun.decision, null);
});

check("skipped report has tempWorkspaceApply.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.tempWorkspaceApply.called, false);
  assert.equal(report.tempWorkspaceApply.decision, null);
  assert.equal(report.orchestratorDecision.tempWorkspaceApplyCalled, false);
});

check("skipped report has tempWorkspaceExecution.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.tempWorkspaceExecution.called, false);
  assert.equal(report.tempWorkspaceExecution.decision, null);
  assert.equal(report.tempWorkspaceExecution.cleanupAttempted, false);
  assert.equal(report.orchestratorDecision.tempWorkspaceExecutionCalled, false);
});

check("default mode has forceRemask false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.forceRemask, false);
  assert.equal(report.orchestratorDecision.forcedRemask, false);
});

check("forced remask mode does not alter skipped endpoint behavior", () => {
  const { result, report } = runSmoke({
    WORKER_ORCHESTRATOR_FORCE_REMASK: "1",
    WORKER_ORCHESTRATOR_REQUIRED: "0"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.status, "skipped");
  assert.equal(report.finalDecision, "skipped");
  assert.equal(report.forceRemask, true);
  assert.equal(report.planner.called, false);
  assert.equal(report.verifier.called, false);
  assert.equal(report.remask.called, false);
});

check("planner validation failure maps to blocked_before_coder", () => {
  const decision = decide({ ok: false }, { ok: false });

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.match(decision.reason, /planner validation failure/);
});

check("planner validation failure has remask.called false", () => {
  const decision = decide({ ok: false }, { ok: false });
  const remask = emptyRemaskReport();
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.equal(remask.called, false);
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.remaskRequested, undefined);
});

check("planner validation failure has repairVerifier.called false", () => {
  const decision = decide({ ok: false }, { ok: false });
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("planner validation failure has patchDryRun.called false", () => {
  const decision = decide({ ok: false }, { ok: false });
  const patchDryRun = emptyPatchDryRunReport();

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.equal(patchDryRun.called, false);
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("forced remask mode does not run if planner validation fails", () => {
  const decision = decide({ ok: false }, { ok: false }, null, null, null, {
    forcedRemask: true
  });
  const remask = emptyRemaskReport();

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.equal(remask.called, false);
  assert.equal(decision.forcedRemask, undefined);
});

check("coder validation failure maps to blocked_before_verifier", () => {
  const decision = decide({ ok: true }, { ok: false });

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.match(decision.reason, /coder validation failure/);
});

check("coder validation failure has remask.called false", () => {
  const decision = decide({ ok: true }, { ok: false });
  const remask = emptyRemaskReport();
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.equal(remask.called, false);
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.remaskRequested, undefined);
});

check("coder validation failure has repairVerifier.called false", () => {
  const decision = decide({ ok: true }, { ok: false });
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("coder validation failure has patchDryRun.called false", () => {
  const decision = decide({ ok: true }, { ok: false });
  const patchDryRun = emptyPatchDryRunReport();

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.equal(patchDryRun.called, false);
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("forced remask mode does not run if coder validation fails", () => {
  const decision = decide({ ok: true }, { ok: false }, null, null, null, {
    forcedRemask: true
  });
  const remask = emptyRemaskReport();

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.equal(remask.called, false);
  assert.equal(decision.forcedRemask, undefined);
});

check("forced remask mode can produce forced verifier finding", () => {
  const result = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });

  assert.equal(result.decision, "needs_review");
  assert.equal(result.finding.role, "verifier");
  assert.equal(result.finding.target, "verifierFinding");
  assert.equal(result.finding.summary, "Forced repairable verifier finding for remask path smoke.");
  assert.equal(result.issues[0].code, "missing_proposed_patch");
  assert.deepEqual(result.finding.touchedFiles, ["packages/example/src/index.ts"]);
});

check("forced remask mode requests remask for repairable issue", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: ["packages/example/src/index.ts"],
        confidence: 1
      },
      issues: []
    },
    null,
    { forcedRemask: true }
  );

  assert.equal(decision.finalDecision, "remask_requested");
  assert.equal(decision.remaskRequested, true);
  assert.equal(decision.forcedRemask, true);
});

check("approved verifier result maps to approved_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );

  assert.equal(decision.finalDecision, "approved_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "approve");
  assert.equal(decision.verifierIssueCount, 0);
});

check("approved verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );
  const remask = emptyRemaskReport();

  assert.equal(remask.called, false);
  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, null);
});

check("initial approve path does not call repairVerifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "approved_by_deterministic_verifier");
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("initial approve path does not call patchDryRun", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );

  assert.equal(decision.finalDecision, "approved_by_deterministic_verifier");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("needs_review verifier result maps to needs_review_by_deterministic_verifier without remask request", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "low_confidence", message: "low" }] }
  );

  assert.equal(decision.finalDecision, "needs_review_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "needs_review");
  assert.equal(decision.verifierIssueCount, 1);
});

check("needs_review repairable verifier result requests remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "low_confidence", message: "low" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    }
  );

  assert.equal(decision.remaskRequested, true);
  assert.equal(decision.remaskRepairability, "repairable");
});

check("needs_review repairable verifier result maps finalDecision to remask_requested", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    }
  );

  assert.equal(decision.finalDecision, "remask_requested");
});

check("needs_review repairable path can map to repair_draft_ready when remask validation/checks pass", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    }
  );

  assert.equal(decision.finalDecision, "repair_draft_ready");
  assert.equal(decision.remaskValidationOk, true);
  assert.equal(decision.repairDraftChecksOk, true);
});

check("successful remask repairDraft approve maps to repair_approved_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "approve",
        ok: true,
        issueCount: 0,
        issues: [],
        finding: { role: "verifier", target: "verifierFinding", summary: "approved" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_approved_by_deterministic_verifier");
  assert.equal(decision.repairVerifierCalled, true);
  assert.equal(decision.repairVerifierDecision, "approve");
  assert.equal(decision.repairVerifierIssueCount, 0);
});

check("repairVerifier approve calls patchDryRun", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "approve",
        ok: true,
        issueCount: 0,
        issues: [],
        finding: { role: "verifier", target: "verifierFinding", summary: "approved" }
      },
      patchDryRun: {
        called: true,
        decision: "ready_to_apply",
        ok: true,
        issueCount: 0,
        issues: [],
        summary: { totalFiles: 1, changedFiles: 1, unchangedFiles: 0, totalAddedLines: 1, totalRemovedLines: 0 },
        previews: []
      }
    }
  );

  assert.equal(decision.patchDryRunCalled, true);
  assert.equal(decision.patchDryRunDecision, "ready_to_apply");
  assert.equal(decision.patchDryRunIssueCount, 0);
  assert.equal(decision.patchDryRunChangedFiles, 1);
});

check("patch dry-run ready_to_apply maps to patch_ready_to_apply", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: { called: true, decision: "approve", ok: true, issueCount: 0, issues: [], finding: {} },
      patchDryRun: {
        called: true,
        decision: "ready_to_apply",
        ok: true,
        issueCount: 0,
        issues: [],
        summary: { totalFiles: 1, changedFiles: 1, unchangedFiles: 0, totalAddedLines: 1, totalRemovedLines: 0 },
        previews: []
      }
    }
  );

  assert.equal(decision.finalDecision, "patch_ready_to_apply");
});

function tempApplyDecisionFixture(decision) {
  return {
    called: true,
    decision,
    ok: decision === "temp_apply_ready",
    issueCount: decision === "temp_apply_ready" ? 0 : 1,
    changedFiles: decision === "temp_apply_ready" ? 1 : 0,
    cleanedUp: decision === "temp_apply_ready" ? false : true,
    tempWorkspacePath:
      decision === "temp_apply_ready" ? path.join(os.tmpdir(), "decision-fixture") : null
  };
}

function tempExecutionDecisionFixture(decision, overrides = {}) {
  return {
    called: true,
    decision,
    ok: decision === "temp_validation_passed",
    issueCount: decision === "temp_validation_passed" ? 0 : 1,
    commandCount: 1,
    passedCommands: decision === "temp_validation_passed" ? 1 : 0,
    failedCommands: decision === "temp_validation_failed" ? 1 : 0,
    timedOutCommands: 0,
    cleanupPerformed: true,
    ...overrides
  };
}

check("patch dry-run ready_to_apply calls tempWorkspaceApply and maps temp_apply_ready", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    { repairability: "repairable", remaskRequest: {}, issues: [] },
    { called: true, validation: { ok: true }, repairDraftChecks: { ok: true } },
    {
      repairVerifier: { called: true, decision: "approve", issueCount: 0 },
      patchDryRun: { called: true, decision: "ready_to_apply", issueCount: 0, summary: { changedFiles: 1 } },
      tempWorkspaceApply: tempApplyDecisionFixture("temp_apply_ready")
    }
  );

  assert.equal(decision.finalDecision, "temp_apply_ready");
  assert.equal(decision.tempWorkspaceApplyCalled, true);
  assert.equal(decision.tempWorkspaceApplyCleanedUp, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

for (const executionDecision of [
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]) {
  check(`${executionDecision} maps final decision`, () => {
    const decision = decide(
      { ok: true },
      { ok: true },
      { decision: "needs_review", issues: [{ code: "missing_proposed_patch" }] },
      { repairability: "repairable", remaskRequest: {}, issues: [] },
      { called: true, validation: { ok: true }, repairDraftChecks: { ok: true } },
      {
        repairVerifier: { called: true, decision: "approve", issueCount: 0 },
        patchDryRun: {
          called: true,
          decision: "ready_to_apply",
          issueCount: 0,
          summary: { changedFiles: 1 }
        },
        tempWorkspaceApply: tempApplyDecisionFixture("temp_apply_ready"),
        tempWorkspaceExecution: tempExecutionDecisionFixture(executionDecision)
      }
    );

    assert.equal(decision.finalDecision, executionDecision);
    assert.equal(decision.tempWorkspaceExecutionCalled, true);
    assert.equal(decision.tempWorkspaceExecutionDecision, executionDecision);
    assert.equal(decision.tempWorkspaceExecutionCommandCount, 1);
    assert.equal(decision.tempWorkspaceExecutionCleanupPerformed, true);
  });
}

for (const tempDecision of ["temp_apply_needs_review", "temp_apply_rejected"]) {
  check(`temp workspace apply ${tempDecision} maps final decision`, () => {
    const decision = decide(
      { ok: true },
      { ok: true },
      { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
      { repairability: "repairable", remaskRequest: {}, issues: [] },
      { called: true, validation: { ok: true }, repairDraftChecks: { ok: true } },
      {
        repairVerifier: { called: true, decision: "approve", issueCount: 0 },
        patchDryRun: { called: true, decision: "ready_to_apply", issueCount: 0, summary: { changedFiles: 1 } },
        tempWorkspaceApply: tempApplyDecisionFixture(tempDecision)
      }
    );

    assert.equal(decision.finalDecision, tempDecision);
    assert.equal(decision.tempWorkspaceApplyCalled, true);
    assert.equal(decision.tempWorkspaceExecutionCalled, false);
  });
}

check("patch dry-run needs_review maps to patch_dry_run_needs_review", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: { called: true, decision: "approve", ok: true, issueCount: 0, issues: [], finding: {} },
      patchDryRun: {
        called: true,
        decision: "needs_review",
        ok: false,
        issueCount: 1,
        issues: [{ code: "no_op_patch", message: "no-op" }],
        summary: { totalFiles: 1, changedFiles: 0, unchangedFiles: 1, totalAddedLines: 0, totalRemovedLines: 0 },
        previews: []
      }
    }
  );

  assert.equal(decision.finalDecision, "patch_dry_run_needs_review");
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("patch dry-run reject maps to patch_dry_run_rejected", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: { called: true, decision: "approve", ok: true, issueCount: 0, issues: [], finding: {} },
      patchDryRun: {
        called: true,
        decision: "reject",
        ok: false,
        issueCount: 1,
        issues: [{ code: "unsafe_repair_patch_content", message: "unsafe" }],
        summary: { totalFiles: 1, changedFiles: 1, unchangedFiles: 0, totalAddedLines: 1, totalRemovedLines: 1 },
        previews: []
      }
    }
  );

  assert.equal(decision.finalDecision, "patch_dry_run_rejected");
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("repairDraft verifier needs_review maps to repair_needs_review_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "needs_review",
        ok: false,
        issueCount: 1,
        issues: [{ code: "required_issue_code_not_addressed", message: "missing" }],
        finding: { role: "verifier", target: "verifierFinding", summary: "needs review" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_needs_review_by_deterministic_verifier");
  assert.equal(decision.repairVerifierCalled, true);
  assert.equal(decision.repairVerifierDecision, "needs_review");
  assert.equal(decision.repairVerifierIssueCount, 1);
});

check("repairVerifier needs_review does not call patchDryRun", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "needs_review",
        ok: false,
        issueCount: 1,
        issues: [{ code: "required_issue_code_not_addressed", message: "missing" }],
        finding: { role: "verifier", target: "verifierFinding", summary: "needs review" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_needs_review_by_deterministic_verifier");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("repairDraft verifier reject maps to repair_rejected_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "reject",
        ok: false,
        issueCount: 1,
        issues: [{ code: "unsafe_repair_patch_content", message: "unsafe" }],
        finding: { role: "verifier", target: "verifierFinding", summary: "reject" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_rejected_by_deterministic_verifier");
  assert.equal(decision.repairVerifierCalled, true);
  assert.equal(decision.repairVerifierDecision, "reject");
  assert.equal(decision.repairVerifierIssueCount, 1);
});

check("repairVerifier reject does not call patchDryRun", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      repairVerifier: {
        called: true,
        decision: "reject",
        ok: false,
        issueCount: 1,
        issues: [{ code: "unsafe_repair_patch_content", message: "unsafe" }],
        finding: { role: "verifier", target: "verifierFinding", summary: "reject" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_rejected_by_deterministic_verifier");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("forced remask mode maps successful remask validation/checks to repair_draft_ready", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: ["packages/example/src/index.ts"],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    { forcedRemask: true }
  );

  assert.equal(decision.finalDecision, "repair_draft_ready");
  assert.equal(decision.forcedRemask, true);
  assert.equal(decision.remaskValidationOk, true);
  assert.equal(decision.repairDraftChecksOk, true);
});

check("forced remask mode can reach repair_approved_by_deterministic_verifier", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: ["packages/example/src/index.ts"],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      forcedRemask: true,
      repairVerifier: {
        called: true,
        decision: "approve",
        ok: true,
        issueCount: 0,
        issues: [],
        finding: { role: "verifier", target: "verifierFinding", summary: "approved" }
      }
    }
  );

  assert.equal(decision.finalDecision, "repair_approved_by_deterministic_verifier");
  assert.equal(decision.forcedRemask, true);
  assert.equal(decision.repairVerifierCalled, true);
});

check("forced remask mode can reach patch_ready_to_apply", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: ["packages/example/src/index.ts"],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: true, issues: [] }
    },
    {
      forcedRemask: true,
      repairVerifier: {
        called: true,
        decision: "approve",
        ok: true,
        issueCount: 0,
        issues: [],
        finding: { role: "verifier", target: "verifierFinding", summary: "approved" }
      },
      patchDryRun: {
        called: true,
        decision: "ready_to_apply",
        ok: true,
        issueCount: 0,
        issues: [],
        summary: { totalFiles: 1, changedFiles: 1, unchangedFiles: 0, totalAddedLines: 1, totalRemovedLines: 0 },
        previews: []
      }
    }
  );

  assert.equal(decision.finalDecision, "patch_ready_to_apply");
  assert.equal(decision.forcedRemask, true);
  assert.equal(decision.patchDryRunCalled, true);
});

check("forced remask mode can reach temp_validation_passed", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    { repairability: "repairable", remaskRequest: {}, issues: [] },
    { called: true, validation: { ok: true }, repairDraftChecks: { ok: true } },
    {
      forcedRemask: true,
      repairVerifier: { called: true, decision: "approve", issueCount: 0 },
      patchDryRun: { called: true, decision: "ready_to_apply", issueCount: 0, summary: { changedFiles: 1 } },
      tempWorkspaceApply: tempApplyDecisionFixture("temp_apply_ready"),
      tempWorkspaceExecution: tempExecutionDecisionFixture("temp_validation_passed")
    }
  );

  assert.equal(decision.finalDecision, "temp_validation_passed");
  assert.equal(decision.tempWorkspaceApplyCleanedUp, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, true);
  assert.equal(decision.tempWorkspaceExecutionCleanupPerformed, true);
});

check("needs_review repairable path can map to remask_repair_failed when remask validation fails", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: false, blocked: true, issues: [{ code: "invalid_json", message: "bad" }], mutation: null },
      repairDraftChecks: { ok: false, issues: [] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.remaskValidationOk, false);
  assert.equal(decision.repairDraftChecksOk, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("remask validation failure has repairVerifier.called false", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: false, blocked: true, issues: [{ code: "invalid_json", message: "bad" }], mutation: null },
      repairDraftChecks: { ok: false, issues: [] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.repairVerifierCalled, false);
});

check("remask validation failure has patchDryRun.called false", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: false, blocked: true, issues: [{ code: "invalid_json", message: "bad" }], mutation: null },
      repairDraftChecks: { ok: false, issues: [] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("forced remask mode maps failed remask validation/checks to remask_repair_failed", () => {
  const forcedVerifier = buildForcedRemaskVerifierResult({
    touchedFiles: ["packages/example/src/index.ts"]
  });
  const decision = decide(
    { ok: true },
    { ok: true },
    forcedVerifier,
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: ["packages/example/src/index.ts"],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: false, blocked: true, issues: [{ code: "invalid_json", message: "bad" }], mutation: null },
      repairDraftChecks: { ok: false, issues: [] }
    },
    { forcedRemask: true }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.forcedRemask, true);
  assert.equal(decision.remaskValidationOk, false);
  assert.equal(decision.repairDraftChecksOk, false);
});

check("needs_review repairable path can map to remask_repair_failed when repairDraft checks fail", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: false, issues: [{ code: "missing_proposed_patch", message: "missing" }] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.remaskValidationOk, true);
  assert.equal(decision.repairDraftChecksOk, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("repairDraftChecks failure has repairVerifier.called false", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: false, issues: [{ code: "missing_proposed_patch", message: "missing" }] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.repairVerifierCalled, false);
});

check("repairDraftChecks failure has patchDryRun.called false", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: { role: "verifier", target: "remaskRequest", summary: "request", claims: [], touchedFiles: [], confidence: 1 },
      issues: []
    },
    {
      called: true,
      validation: { ok: true, blocked: false, issues: [], mutation: { role: "remask", target: "repairDraft" } },
      repairDraftChecks: { ok: false, issues: [{ code: "missing_proposed_patch", message: "missing" }] }
    }
  );

  assert.equal(decision.finalDecision, "remask_repair_failed");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

check("needs_review non-repairable verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] },
    {
      repairability: "not_repairable",
      remaskRequest: null,
      issues: [{ code: "unsafe_or_forbidden_issue", message: "unsafe" }]
    }
  );
  const remask = emptyRemaskReport();

  assert.equal(remask.called, false);
  assert.equal(decision.finalDecision, "needs_review_by_deterministic_verifier");
  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, "not_repairable");
});

check("rejected verifier result maps to rejected_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );

  assert.equal(decision.finalDecision, "rejected_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "reject");
  assert.equal(decision.verifierIssueCount, 1);
});

check("rejected verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );
  const remask = emptyRemaskReport();

  assert.equal(remask.called, false);
  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, null);
});

check("initial reject path does not call repairVerifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );
  const repairVerifier = emptyRepairVerifierReport();

  assert.equal(decision.finalDecision, "rejected_by_deterministic_verifier");
  assert.equal(repairVerifier.called, false);
  assert.equal(decision.repairVerifierCalled, false);
});

check("initial reject path does not call patchDryRun", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );

  assert.equal(decision.finalDecision, "rejected_by_deterministic_verifier");
  assert.equal(decision.patchDryRunCalled, false);
  assert.equal(decision.tempWorkspaceApplyCalled, false);
  assert.equal(decision.tempWorkspaceExecutionCalled, false);
});

function createAppliedWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-execution-"));
  const appliedFile = path.join(workspace, fixture.allowedFiles[0]);
  fs.mkdirSync(path.dirname(appliedFile), { recursive: true });
  fs.writeFileSync(appliedFile, fixture.fileContents[fixture.allowedFiles[0]]);
  return workspace;
}

function readyTempApplyReport(workspace) {
  return {
    called: true,
    decision: "temp_apply_ready",
    tempWorkspacePath: workspace,
    cleanedUp: false
  };
}

function trustedValidationConfig(commands = fixture.validationCommands) {
  return {
    validationCommands: commands,
    validationAllowedExecutables: fixture.validationAllowedExecutables,
    validationEnvironment: fixture.validationEnvironment
  };
}

async function runExecutionIntegrationChecks() {
  const verifierPath = pathToFileURL(
    path.join(
      repoRoot,
      "dist",
      "packages",
      "product-runtime",
      "src",
      "temporary-workspace-execution-verifier.js"
    )
  );
  const { verifyTemporaryWorkspaceExecution } = await import(verifierPath.href);

  check("non-ready temporary workspace apply outcomes do not call execution verifier", () => {
    let calls = 0;
    const verifier = () => {
      calls += 1;
      throw new Error("execution verifier should not be called");
    };

    for (const tempWorkspaceApply of [
      { called: false, decision: null, tempWorkspacePath: null, cleanedUp: null },
      {
        called: true,
        decision: "temp_apply_needs_review",
        tempWorkspacePath: null,
        cleanedUp: true
      },
      {
        called: true,
        decision: "temp_apply_rejected",
        tempWorkspacePath: null,
        cleanedUp: true
      },
      {
        called: true,
        decision: "temp_apply_ready",
        tempWorkspacePath: "",
        cleanedUp: false
      },
      {
        called: true,
        decision: "temp_apply_ready",
        tempWorkspacePath: os.tmpdir(),
        cleanedUp: true
      }
    ]) {
      const result = verifyAndCleanupTemporaryWorkspace(
        tempWorkspaceApply,
        trustedValidationConfig(),
        verifier
      );
      assert.equal(result.called, false);
      assert.equal(result.cleanupAttempted, false);
    }

    assert.equal(calls, 0);
  });

  check("temp_apply_ready calls execution verifier with trusted fixture configuration", () => {
    const workspace = createAppliedWorkspace();
    let capturedContext = null;
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig(),
      (context) => {
        capturedContext = context;
        assert.equal(fs.existsSync(workspace), true);
        return verifyTemporaryWorkspaceExecution(context);
      }
    );

    assert.equal(result.called, true);
    assert.equal(result.decision, "temp_validation_passed");
    assert.equal(capturedContext.commands, fixture.validationCommands);
    assert.equal(capturedContext.allowedExecutables, fixture.validationAllowedExecutables);
    assert.equal(capturedContext.environment, fixture.validationEnvironment);
    assert.equal(result.cleanupPerformed, true);
    assert.equal(fs.existsSync(workspace), false);
  });

  check("failed execution cleans temporary workspace", () => {
    const workspace = createAppliedWorkspace();
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig([
        {
          id: "trusted-failure",
          executable: "node",
          args: ["-e", "process.exit(7)"],
          timeoutMs: 10000,
          expectedExitCodes: [0]
        }
      ]),
      verifyTemporaryWorkspaceExecution
    );

    assert.equal(result.decision, "temp_validation_failed");
    assert.equal(result.failedCommands, 1);
    assert.equal(result.cleanupPerformed, true);
    assert.equal(fs.existsSync(workspace), false);
  });

  check("needs_review execution cleans temporary workspace", () => {
    const workspace = createAppliedWorkspace();
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig([
        {
          id: "trusted-truncation",
          executable: "node",
          args: ["-e", "process.stdout.write('x'.repeat(64))"],
          timeoutMs: 10000,
          expectedExitCodes: [0]
        }
      ]),
      verifyTemporaryWorkspaceExecution,
      { maxOutputChars: 8 }
    );

    assert.equal(result.decision, "temp_validation_needs_review");
    assert.equal(result.truncatedOutputs, 1);
    assert.equal(result.cleanupPerformed, true);
    assert.equal(fs.existsSync(workspace), false);
  });

  check("timed-out execution cleans temporary workspace", () => {
    const workspace = createAppliedWorkspace();
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig([
        {
          id: "trusted-timeout",
          executable: "node",
          args: ["-e", "setTimeout(()=>{},5000)"],
          timeoutMs: 20,
          expectedExitCodes: [0]
        }
      ]),
      verifyTemporaryWorkspaceExecution
    );

    assert.equal(result.decision, "temp_validation_failed");
    assert.equal(result.timedOutCommands, 1);
    assert.equal(result.cleanupPerformed, true);
    assert.equal(fs.existsSync(workspace), false);
  });

  check("execution verifier exception still cleans temporary workspace", () => {
    const workspace = createAppliedWorkspace();
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig(),
      () => {
        throw new Error("forced verifier exception");
      }
    );

    assert.equal(result.decision, "temp_validation_needs_review");
    assert.ok(
      result.issues.some((issue) => issue.code === "temp_validation_execution_exception")
    );
    assert.equal(result.cleanupPerformed, true);
    assert.equal(fs.existsSync(workspace), false);
  });

  check("cleanup failure maps passing execution to temp_validation_needs_review", () => {
    const workspace = createAppliedWorkspace();

    try {
      const result = verifyAndCleanupTemporaryWorkspace(
        readyTempApplyReport(workspace),
        trustedValidationConfig(),
        verifyTemporaryWorkspaceExecution,
        {
          removeWorkspace() {
            throw new Error("forced cleanup failure");
          }
        }
      );

      assert.equal(result.decision, "temp_validation_needs_review");
      assert.equal(result.cleanupAttempted, true);
      assert.equal(result.cleanupPerformed, false);
      assert.match(result.cleanupError, /forced cleanup failure/);
      assert.ok(result.issues.some((issue) => issue.code === "temp_workspace_cleanup_failed"));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  check("execution verification leaves real repository fixture unchanged", () => {
    const realFixturePath = path.join(repoRoot, "package.json");
    const before = fs.readFileSync(realFixturePath, "utf8");
    const workspace = createAppliedWorkspace();
    const result = verifyAndCleanupTemporaryWorkspace(
      readyTempApplyReport(workspace),
      trustedValidationConfig(),
      verifyTemporaryWorkspaceExecution
    );
    const after = fs.readFileSync(realFixturePath, "utf8");

    assert.equal(result.decision, "temp_validation_passed");
    assert.equal(after, before);
  });
}

function workerMutation(role) {
  if (role === "planner") {
    return {
      role: "planner",
      target: "plan",
      summary: "Plan the bounded helper change.",
      claims: [{
        type: "planned_step",
        description: "Modify only packages/example/src/index.ts."
      }],
      touchedFiles: ["packages/example/src/index.ts"],
      confidence: 0.9
    };
  }
  if (role === "coder") {
    return {
      role: "coder",
      target: "patchDraft",
      summary: "Draft the bounded helper change.",
      claims: [{
        type: "patch_draft",
        file: "packages/example/src/index.ts",
        description: "Add the bounded helper."
      }],
      touchedFiles: ["packages/example/src/index.ts"],
      confidence: 0.9
    };
  }
  return {
    role: "remask",
    target: "repairDraft",
    summary: "Repair only the missing proposed patch.",
    claims: [{
      type: "repair_draft",
      file: "packages/example/src/index.ts",
      description: "Supply the bounded proposed patch.",
      proposedPatch: [
        "export function addOne(value: number): number {",
        "  return value + 1;",
        "}",
        "",
        "export const helperReady = true;",
        ""
      ].join("\n"),
      addressesIssueCodes: ["missing_proposed_patch"]
    }],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.9
  };
}

async function withTemporaryEnvironment(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runW6IntegrationChecks() {
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: undefined,
    WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "1234",
    WORKER_ORCHESTRATOR_SHADOW_MAX_TRACE_EVENTS: "77",
    WORKER_ORCHESTRATOR_SHADOW_MAX_PROMPT_CHARS: "8888",
    WORKER_ORCHESTRATOR_SHADOW_MAX_RESPONSE_CHARS: "9999"
  }, async () => {
    const fallback = configFromEnv();
    check("W.6 absent Shadow environment values fall back and limits map exactly", () => {
      assert.equal(fallback.shadow.upstreamUrl, "http://worker.example/v1");
      assert.equal(fallback.shadow.modelId, "worker-model");
      assert.equal(fallback.shadow.timeoutMs, 1234);
      assert.equal(fallback.shadow.maxTraceEvents, 77);
      assert.equal(fallback.shadow.maxPromptChars, 8888);
      assert.equal(fallback.shadow.maxResponseChars, 9999);
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: ""
  }, async () => {
    const explicitEmpty = configFromEnv();
    check("W.6 intentionally empty Shadow environment values are not overridden", () => {
      assert.equal(explicitEmpty.shadow.upstreamUrl, "");
      assert.equal(explicitEmpty.shadow.modelId, "");
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "http://shadow.example/v1",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: "shadow-model"
  }, async () => {
    const explicit = configFromEnv();
    check("W.6 explicit Shadow URL and model remain distinct from worker configuration", () => {
      assert.equal(explicit.shadow.upstreamUrl, "http://shadow.example/v1");
      assert.equal(explicit.shadow.modelId, "shadow-model");
      assert.equal(explicit.upstreamUrl, "http://worker.example/v1");
      assert.equal(explicit.modelId, "worker-model");
    });
  });

  const requests = [];
  let shadowCompletion = null;
  let workerScenario = "valid";
  let shadowScenario = "valid";
  let shadowRecommendation = "continue";
  let usageScenario = "valid";
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const userContent = body.messages.find((message) => message.role === "user").content;
      let shadowPayload = null;
      try {
        const parsed = JSON.parse(userContent);
        if (parsed.task === "shadow_observe_accountability_trace") shadowPayload = parsed;
      } catch {
        // Worker role prompts are deliberately not canonical JSON payloads.
      }
      requests.push({ body, shadow: shadowPayload !== null });

      if (shadowPayload !== null) {
        const trace = shadowPayload.trace;
        if (shadowScenario === "http_failure") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (shadowScenario === "timeout") {
          setTimeout(() => {
            if (!response.writableEnded) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end("{}");
            }
          }, 100);
          return;
        }
        const recommendationProfile = {
          continue: { riskLevel: "low", riskScore: 10, severity: null },
          request_repair: { riskLevel: "medium", riskScore: 35, severity: "warning" },
          request_replan: { riskLevel: "high", riskScore: 60, severity: "high" },
          escalate: { riskLevel: "critical", riskScore: 90, severity: "critical" },
          terminate: { riskLevel: "critical", riskScore: 90, severity: "critical" }
        }[shadowRecommendation];
        const finding = recommendationProfile.severity === null ? null : {
          code: "advisory_risk",
          severity: recommendationProfile.severity,
          message: "Bounded trace evidence warrants attention.",
          evidenceEventIds: [trace.events[0].eventId],
          evidenceFilePaths: [],
          evidenceTraceFindingCodes: []
        };
        const observation = {
          observationVersion: "1",
          runId: shadowScenario === "wrong_run" ? "wrong-run" : trace.runId,
          traceHash: shadowScenario === "wrong_hash"
            ? `sha256:${"b".repeat(64)}`
            : trace.traceHash,
          riskLevel: recommendationProfile.riskLevel,
          riskScore: recommendationProfile.riskScore,
          confidenceScore: 90,
          findings: finding === null ? [] : [finding],
          observedScopeDrift: false,
          observedPlanPatchMismatch: false,
          observedRepairLoop: false,
          observedSuspiciousRoleBehavior: false,
          observedEvidenceConflict: false,
          recommendation: shadowRecommendation,
          rationaleCodes: ["trace_consistent"]
        };
        if (shadowScenario === "unknown_evidence") {
          observation.riskLevel = "medium";
          observation.riskScore = 35;
          observation.recommendation = "request_repair";
          observation.findings = [{
            code: "advisory_risk",
            severity: "warning",
            message: "Unknown evidence fixture.",
            evidenceEventIds: ["unknown:event"],
            evidenceFilePaths: [],
            evidenceTraceFindingCodes: []
          }];
        }
        if (shadowScenario === "needs_review") {
          observation.riskLevel = "medium";
          observation.riskScore = 35;
          observation.recommendation = "request_repair";
          const duplicate = {
            code: "advisory_risk",
            severity: "warning",
            message: "Bounded trace evidence warrants attention.",
            evidenceEventIds: [trace.events[0].eventId, trace.events[1].eventId],
            evidenceFilePaths: [],
            evidenceTraceFindingCodes: []
          };
          observation.findings = [
            duplicate,
            { ...duplicate, evidenceEventIds: [...duplicate.evidenceEventIds].reverse() }
          ];
        }
        shadowCompletion = shadowScenario === "malformed"
          ? "not-json"
          : JSON.stringify(observation);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: shadowCompletion } }],
          ...(usageScenario === "missing" ? {} : {
            usage: usageScenario === "invalid"
              ? { prompt_tokens: -1, completion_tokens: 7, total_tokens: 6 }
              : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
          })
        }));
        return;
      }

      const system = body.messages.find((message) => message.role === "system").content;
      const role = system.includes("planner role")
        ? "planner"
        : system.includes("coder role")
          ? "coder"
          : "remask";
      let mutation = workerMutation(role);
      if (workerScenario === "planner_invalid" && role === "planner") mutation = {};
      if (workerScenario === "coder_invalid" && role === "coder") mutation = {};
      if (workerScenario === "verifier_reject" && role === "coder") {
        mutation = {
          ...workerMutation("coder"),
          claims: [{
            type: "patch_draft",
            file: "packages/example/src/index.ts",
            description: "Unsafe fixture content for deterministic rejection.",
            proposedPatch: "process.env.SECRET"
          }]
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(mutation) } }],
        ...(usageScenario === "missing" ? {} : {
          usage: usageScenario === "invalid"
            ? { prompt_tokens: 1.5, completion_tokens: 3, total_tokens: 4.5 }
            : { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        })
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-orchestrator-w6-"));
  const execute = (overrides = {}) => withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: endpoint,
    WORKER_ORCHESTRATOR_MODEL_ID: "WORKER_MODEL_SENTINEL",
    WORKER_ORCHESTRATOR_FORCE_REMASK: "1",
    WORKER_ORCHESTRATOR_REQUIRED: "1",
    WORKER_ORCHESTRATOR_OUT_DIR: outDir,
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: undefined,
    WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1",
    ...overrides
  }, () => run());

  try {
    const report = await execute();

    check("W.6 forced path records the exact pre-Shadow actor sequence", () => {
      assert.deepEqual(
        report.accountability.ledger.events.slice(0, 9).map((event) => event.actor),
        [
          "planner",
          "coder",
          "deterministic_verifier",
          "masker",
          "repairer",
          "repair_verifier",
          "patch_dry_run",
          "temp_workspace_apply",
          "execution_verifier"
        ]
      );
      assert.deepEqual(
        report.accountability.ledger.events.map((event) => event.sequence),
        report.accountability.ledger.events.map((_, index) => index + 1)
      );
      assert.deepEqual(
        report.accountability.ledger.events.slice(0, 9).map((event) => event.action),
        [
          "planner.plan",
          "coder.patch_draft",
          "deterministic_verifier.patch_draft",
          "masker.repair_scope",
          "repairer.repair_draft",
          "repair_verifier.repair_draft",
          "patch_dry_run.evaluate",
          "temp_workspace_apply.apply",
          "execution_verifier.validate"
        ]
      );
    });

    check("W.6 ledger chain and pre-Shadow trace are complete", () => {
      const events = report.accountability.ledger.events;
      for (let index = 1; index < events.length; index += 1) {
        assert.equal(events[index].previousEventHash, events[index - 1].eventHash);
      }
      assert.equal(report.accountability.eventCountBeforeShadow, 9);
      assert.equal(events[8].eventHash, report.accountability.ledgerRootHashBeforeShadow);
      assert.equal(events.at(-1).eventHash, report.accountability.ledger.rootHash);
      assert.equal(events[0].eventId,
        "worker-orchestrator:phase-p-orchestrator-safe-helper:event:000001");
      assert.equal(report.accountability.preShadowLedgerVerificationDecision, "ledger_valid");
      assert.equal(report.accountability.phaseVExecutionObserved, true);
      assert.equal(report.accountability.phaseVExecutionCompleted, true);
      assert.equal(report.accountability.preShadowTrace.repairActivity.remaskCount, 1);
      assert.equal(report.accountability.preShadowTrace.repairActivity.repairCount, 1);
      assert.deepEqual(report.accountability.preShadowTrace.files.temporaryAppliedFiles,
        ["packages/example/src/index.ts"]);
      assert.deepEqual(report.accountability.preShadowTrace.files.executionReadFiles,
        ["packages/example/src/index.ts"]);
      assert.deepEqual(report.accountability.preShadowTrace.files.plannedFiles,
        ["packages/example/src/index.ts"]);
      assert.deepEqual(report.accountability.preShadowTrace.files.coderProposedFiles,
        ["packages/example/src/index.ts"]);
      assert.deepEqual(report.accountability.preShadowTrace.files.repairProposedFiles,
        ["packages/example/src/index.ts"]);
    });

    check("W.6 Shadow integration appends advisory evidence without changing Phase V", () => {
      assert.equal(requests.filter((request) => request.shadow).length, 1);
      assert.equal(report.shadowObserver.configured, true);
      assert.equal(report.shadowObserver.called, true);
      assert.equal(report.shadowObserver.decision, "shadow_observer_completed");
      assert.equal(report.shadowObserver.validationDecision, "shadow_observation_valid");
      assert.equal(report.shadowObserver.requiredSatisfied, true);
      assert.equal(report.shadowObserver.eventAppended, true);
      assert.equal(report.accountability.eventCountAfterShadow, 10);
      assert.equal(report.accountability.ledger.events.at(-1).actor, "shadow_observer");
      assert.ok(report.accountability.ledger.events.at(-1).inputArtifactHashes.includes(
        report.accountability.preShadowTraceHash
      ));
      assert.ok(report.accountability.ledger.events.at(-1).outputArtifactHashes.includes(
        report.shadowObserver.observationHash
      ));
      assert.equal(report.accountability.postShadowLedgerVerificationDecision, "ledger_valid");
      assert.ok(report.accountability.postShadowTrace);
      assert.ok(report.accountability.postShadowTrace.findings.some((finding) =>
        finding.code === "pre_governance_trace_contains_governance_roles" &&
        finding.severity === "info"));
      assert.notEqual(report.accountability.preShadowTraceHash,
        report.accountability.postShadowTraceHash);
      assert.equal(report.shadowObserver.observation.traceHash,
        report.accountability.preShadowTraceHash);
      assert.equal(report.finalDecision, "temp_validation_passed");
      assert.equal(report.shadowStageDecision, "shadow_observer_completed");
    });

    check("W.6 artifact chain links every adjacent bounded stage", () => {
      const byActor = Object.fromEntries(
        report.accountability.ledger.events.map((event) => [event.actor, event])
      );
      assert.ok(byActor.coder.inputArtifactHashes.some((hash) =>
        byActor.planner.outputArtifactHashes.includes(hash)));
      assert.ok(byActor.deterministic_verifier.inputArtifactHashes.some((hash) =>
        byActor.coder.outputArtifactHashes.includes(hash)));
      assert.ok(byActor.repairer.inputArtifactHashes.some((hash) =>
        byActor.masker.outputArtifactHashes.includes(hash)));
      assert.ok(byActor.patch_dry_run.inputArtifactHashes.some((hash) =>
        byActor.repairer.outputArtifactHashes.includes(hash)));
      assert.ok(byActor.temp_workspace_apply.inputArtifactHashes.some((hash) =>
        byActor.patch_dry_run.outputArtifactHashes.includes(hash)));
      assert.ok(byActor.execution_verifier.inputArtifactHashes.some((hash) =>
        byActor.temp_workspace_apply.outputArtifactHashes.includes(hash)));
      assert.deepEqual(byActor.planner.tokenUsage,
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
      assert.deepEqual(byActor.coder.tokenUsage,
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
      assert.deepEqual(byActor.repairer.tokenUsage,
        { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
      assert.equal(byActor.execution_verifier.tokenUsage, undefined);
      assert.deepEqual(byActor.shadow_observer.tokenUsage,
        { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    });

    check("W.6 reports contain bounded evidence and no Shadow raw output or environment values", () => {
      const ledgerJson = JSON.stringify(report.accountability.ledger);
      const traceJson = JSON.stringify({
        pre: report.accountability.preShadowTrace,
        post: report.accountability.postShadowTrace
      });
      const reportJson = fs.readFileSync(report.jsonPath, "utf8");
      const markdown = fs.readFileSync(report.markdownPath, "utf8");
      assert.ok(!ledgerJson.includes("helperReady"));
      assert.ok(!ledgerJson.includes("return value + 1"));
      assert.ok(!ledgerJson.includes("stdout"));
      assert.ok(!ledgerJson.includes("stderr"));
      assert.ok(!traceJson.includes("helperReady"));
      assert.ok(!traceJson.includes("return value + 1"));
      assert.ok(!ledgerJson.includes("You are the planner role"));
      assert.ok(!traceJson.includes("You are the planner role"));
      assert.ok(!reportJson.includes(endpoint));
      assert.ok(!reportJson.includes("WORKER_MODEL_SENTINEL"));
      assert.ok(!reportJson.includes(shadowCompletion));
      assert.ok(!markdown.includes(endpoint));
      assert.ok(!markdown.includes("WORKER_MODEL_SENTINEL"));
      assert.ok(!markdown.includes(shadowCompletion));
      assert.ok(markdown.includes("## Agent Event Ledger"));
      assert.ok(markdown.includes("## Accountability Trace"));
      assert.ok(markdown.includes("## Shadow Observer"));
      assert.ok(markdown.includes("## Post-Shadow Audit State"));
    });

    const shadowCallsBeforePartialRuns = requests.filter((entry) => entry.shadow).length;
    workerScenario = "planner_invalid";
    const plannerInvalid = await execute();
    workerScenario = "coder_invalid";
    const coderInvalid = await execute();
    workerScenario = "verifier_reject";
    const verifierReject = await execute({ WORKER_ORCHESTRATOR_FORCE_REMASK: "0" });
    workerScenario = "valid";

    check("W.6 partial paths produce valid bounded ledgers without calling Shadow", () => {
      assert.equal(plannerInvalid.finalDecision, "blocked_before_coder");
      assert.equal(plannerInvalid.accountability.ledger.eventCount, 1);
      assert.deepEqual(plannerInvalid.accountability.ledger.events.map((event) => event.actor),
        ["planner"]);
      assert.equal(coderInvalid.finalDecision, "blocked_before_verifier");
      assert.deepEqual(coderInvalid.accountability.ledger.events.map((event) => event.actor),
        ["planner", "coder"]);
      assert.equal(verifierReject.finalDecision, "rejected_by_deterministic_verifier");
      assert.deepEqual(verifierReject.accountability.ledger.events.map((event) => event.actor),
        ["planner", "coder", "deterministic_verifier"]);
      for (const partial of [plannerInvalid, coderInvalid, verifierReject]) {
        assert.equal(partial.accountability.preShadowLedgerVerificationDecision, "ledger_valid");
        assert.equal(partial.accountability.preShadowTraceDecision, "trace_needs_review");
        assert.equal(partial.shadowObserver.called, false);
        assert.equal(partial.shadowStageDecision, "shadow_not_called");
        assert.equal(partial.shadowObserver.requiredSatisfied, true);
      }
      assert.equal(requests.filter((entry) => entry.shadow).length,
        shadowCallsBeforePartialRuns);
    });

    shadowScenario = "needs_review";
    const reviewedShadow = await execute();
    shadowScenario = "wrong_run";
    const wrongRun = await execute({ WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0" });
    shadowScenario = "wrong_hash";
    const wrongHash = await execute({ WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0" });
    shadowScenario = "unknown_evidence";
    const unknownEvidence = await execute({ WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0" });
    shadowScenario = "malformed";
    const malformed = await execute({ WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0" });
    shadowScenario = "http_failure";
    const httpFailure = await execute();
    shadowScenario = "timeout";
    const timeout = await execute({
      WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "10"
    });
    shadowScenario = "valid";

    check("W.6 Shadow review and failure outcomes append auditable events", () => {
      assert.equal(reviewedShadow.shadowObserver.decision,
        "shadow_observer_needs_review");
      assert.ok(reviewedShadow.shadowObserver.observation);
      assert.equal(reviewedShadow.shadowObserver.requiredSatisfied, true);
      for (const failed of [wrongRun, wrongHash, unknownEvidence, malformed, httpFailure, timeout]) {
        assert.equal(failed.shadowObserver.decision, "shadow_observer_failed");
        assert.equal(failed.shadowObserver.eventAppended, true);
        assert.equal(failed.accountability.postShadowLedgerVerificationDecision, "ledger_valid");
        assert.ok(failed.accountability.postShadowTrace);
        assert.equal(failed.finalDecision, "temp_validation_passed");
      }
      assert.ok(timeout.shadowObserver.issueCodes.includes("shadow_upstream_timeout"));
      assert.equal(httpFailure.status, "failed_required_shadow");
      assert.equal(timeout.status, "failed_required_shadow");
    });

    const missingShadowConfiguration = await execute({
      WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: ""
    });
    const boundedReviewWithoutObservation = await execute({
      WORKER_ORCHESTRATOR_SHADOW_MAX_RESPONSE_CHARS: "1"
    });
    const boundedPreflightWithoutRequest = await execute({
      WORKER_ORCHESTRATOR_SHADOW_MAX_TRACE_EVENTS: "1",
      WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0"
    });

    check("W.6 required mode enforces only eligible terminal Shadow paths", () => {
      assert.equal(missingShadowConfiguration.finalDecision, "temp_validation_passed");
      assert.equal(missingShadowConfiguration.status, "failed_required_shadow");
      assert.equal(missingShadowConfiguration.shadowObserver.called, false);
      assert.equal(missingShadowConfiguration.shadowObserver.requiredSatisfied, false);
      assert.equal(boundedReviewWithoutObservation.shadowObserver.decision,
        "shadow_observer_needs_review");
      assert.equal(boundedReviewWithoutObservation.shadowObserver.observation, null);
      assert.equal(boundedReviewWithoutObservation.shadowObserver.eventAppended, true);
      assert.equal(boundedReviewWithoutObservation.status, "failed_required_shadow");
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.called, false);
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.decision,
        "shadow_observer_needs_review");
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.eventAppended, false);
      assert.equal(boundedPreflightWithoutRequest.accountability.eventCountAfterShadow, 9);
      assert.equal(boundedPreflightWithoutRequest.accountability.postShadowTrace, null);
      assert.equal(reviewedShadow.status, "completed");
      assert.equal(plannerInvalid.status, "completed");
    });

    const recommendationReports = [];
    for (const recommendation of [
      "continue",
      "request_repair",
      "request_replan",
      "escalate",
      "terminate"
    ]) {
      shadowRecommendation = recommendation;
      recommendationReports.push(await execute());
    }
    shadowRecommendation = "continue";

    check("W.6 every Shadow recommendation remains advisory", () => {
      assert.deepEqual(
        recommendationReports.map((candidate) => candidate.shadowObserver.recommendation),
        ["continue", "request_repair", "request_replan", "escalate", "terminate"]
      );
      for (const candidate of recommendationReports) {
        assert.equal(candidate.finalDecision, "temp_validation_passed");
        assert.equal(candidate.shadowObserver.decision, "shadow_observer_completed");
      }
    });

    usageScenario = "missing";
    const missingUsage = await execute();
    usageScenario = "invalid";
    const invalidUsage = await execute();
    usageScenario = "valid";

    check("W.6 token usage is recorded only when valid and never guessed", () => {
      for (const event of missingUsage.accountability.ledger.events) {
        assert.equal(event.tokenUsage, undefined);
      }
      for (const event of invalidUsage.accountability.ledger.events) {
        assert.equal(event.tokenUsage, undefined);
      }
      assert.equal(missingUsage.shadowObserver.decision, "shadow_observer_completed");
      assert.equal(invalidUsage.shadowObserver.decision, "shadow_observer_needs_review");
      assert.ok(invalidUsage.shadowObserver.observation);
      assert.ok(invalidUsage.shadowObserver.issueCodes.includes(
        "invalid_shadow_upstream_usage"));
      assert.equal(invalidUsage.shadowObserver.requiredSatisfied, true);
    });

    const originalValidationCommands = fixture.validationCommands;
    let failedExecution;
    let reviewedExecution;
    try {
      fixture.validationCommands = [{
        id: "w6-terminal-failure",
        executable: "node",
        args: ["-e", "process.exit(7)"],
        timeoutMs: 10000,
        expectedExitCodes: [0]
      }];
      failedExecution = await execute();
      fixture.validationCommands = [{
        id: "w6-terminal-review",
        executable: "node",
        args: ["-e", "process.stdout.write('x'.repeat(21000))"],
        timeoutMs: 10000,
        expectedExitCodes: [0]
      }];
      reviewedExecution = await execute();
    } finally {
      fixture.validationCommands = originalValidationCommands;
    }

    check("W.6 Shadow runs after failed and needs-review terminal execution cleanup", () => {
      assert.equal(failedExecution.finalDecision, "temp_validation_failed");
      assert.equal(reviewedExecution.finalDecision, "temp_validation_needs_review");
      for (const candidate of [failedExecution, reviewedExecution]) {
        assert.equal(candidate.tempWorkspaceExecution.cleanupPerformed, true);
        assert.equal(candidate.shadowObserver.called, true);
        assert.equal(candidate.shadowObserver.decision, "shadow_observer_completed");
        assert.equal(candidate.shadowObserver.eventAppended, true);
        assert.equal(candidate.accountability.postShadowLedgerVerificationDecision,
          "ledger_valid");
      }
    });
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

runExecutionIntegrationChecks()
  .then(runW6IntegrationChecks)
  .then(() => {
    console.log("worker-backed orchestrator smoke test passed");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
