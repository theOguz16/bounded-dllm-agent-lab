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
  emptyGovernedChangeArtifactReport,
  emptyGovernedChangeFreshnessReport,
  emptyControlledApplyHandoffReport,
  emptyControlledApplyHandoffVerificationReport,
  fixture,
  run,
  setActiveGovernedChange,
  verifyAndCleanupTemporaryWorkspace
} = require(scriptPath);

const handoffTarget = {
  repositoryIdentityHash: `sha256:${"1".repeat(64)}`,
  baseRevisionHash: `sha256:${"2".repeat(64)}`,
  worktreeStateHash: `sha256:${"3".repeat(64)}`
};

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
  assert.ok(markdown.includes("## Governed Change Artifact"));
  assert.ok(markdown.includes("## Governed Change Freshness"));
  assert.ok(markdown.includes("## Controlled Apply Handoff"));
  assert.ok(markdown.includes("## Controlled Apply Handoff Verification"));
  assert.ok(markdown.includes("Handoff eligibility is evidence only."));
  assert.ok(markdown.includes("No repository application or handoff was executed."));
  assert.ok(markdown.includes("No repository application was executed."));
  assert.ok(markdown.includes("No consumption key was persisted or reserved."));
  assert.ok(markdown.includes("a durable external consumption registry."));
});

check("skipped report has suiteName phase-p-worker-backed-orchestrator-smoke", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-backed-orchestrator-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("W.12 skipped report creates no ledger or governed stages", () => {
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
  assert.equal(report.governance.evaluated, false);
  assert.equal(report.governance.decision, null);
  assert.equal(report.governance.assessment, null);
  assert.equal(report.governance.eventAppended, false);
  assert.equal(report.adminAgent.configured, false);
  assert.equal(report.adminAgent.called, false);
  assert.equal(report.adminAgent.adapterDecision, null);
  assert.equal(report.adminAgent.decision, null);
  assert.equal(report.adminAgent.eventAppended, false);
  assert.equal(report.governanceStageDecision, "governance_not_evaluated");
  assert.equal(report.adminStageDecision, "admin_not_called");
  assert.equal(report.accountability.postGovernanceTrace, null);
  assert.equal(report.accountability.postAdminTrace, null);
  assert.equal(report.approvalRouter.evaluated, false);
  assert.equal(report.approvalRouter.required, false);
  assert.equal(report.approvalRouter.requiredSatisfied, true);
  assert.equal(report.approvalRouter.validationDecision, null);
  assert.equal(report.approvalRouter.route, null);
  assert.equal(report.approvalRouter.assessment, null);
  assert.equal(report.approvalRouter.eventAppended, false);
  assert.equal(report.approvalRouterStageDecision, "approval_route_not_evaluated");
  assert.equal(report.workflowRoute, null);
  assert.equal(report.accountability.postRouterTrace, null);
  assert.deepEqual(report.governedChangeArtifact, emptyGovernedChangeArtifactReport());
  assert.deepEqual(report.governedChangeFreshness, emptyGovernedChangeFreshnessReport());
  assert.deepEqual(report.controlledApplyHandoff, emptyControlledApplyHandoffReport());
  assert.deepEqual(report.controlledApplyHandoffVerification,
    emptyControlledApplyHandoffVerificationReport());
  assert.equal(report.governedChangeArtifactStageDecision,
    "governed_change_artifact_not_built");
  assert.equal(report.governedChangeFreshnessStageDecision,
    "governed_change_freshness_not_verified");
  assert.equal(report.controlledApplyHandoffStageDecision,
    "controlled_apply_handoff_not_built");
  assert.equal(report.controlledApplyHandoffVerificationStageDecision,
    "controlled_apply_handoff_not_verified");
});

check("W.16 required mode is not applicable to a skipped run", () => {
  const { report } = runSmoke({
    WORKER_ORCHESTRATOR_REQUIRED: "0",
    WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
    WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH:
      handoffTarget.repositoryIdentityHash,
    WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH:
      handoffTarget.baseRevisionHash,
    WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH:
      handoffTarget.worktreeStateHash
  });
  assert.equal(report.controlledApplyHandoff.applicable, false);
  assert.equal(report.controlledApplyHandoff.required, false);
  assert.equal(report.controlledApplyHandoff.requiredSatisfied, true);
  assert.equal(report.status, "skipped");
});

check("W.14 active mutation selection follows the mutation sent to patch dry-run", () => {
  const context = {
    governedChange: {
      changeKind: null,
      mutation: null,
      mutationHash: null,
      changedFiles: [],
      patchDryRunResultHash: null,
      temporaryApplyResultHash: null,
      executionVerificationResultHash: null
    }
  };
  const coderMutation = { touchedFiles: [
    "packages/example/src/index.ts",
    "packages/example/src/index.ts"
  ] };
  const repairMutation = { touchedFiles: ["packages/example/src/repair.ts"] };
  assert.equal(setActiveGovernedChange(context, "repair_draft", repairMutation,
    "sha256:repair"), true);
  assert.equal(setActiveGovernedChange(context, "coder_patch_draft", coderMutation,
    "sha256:coder"), true);
  assert.equal(context.governedChange.changeKind, "coder_patch_draft");
  assert.equal(context.governedChange.mutation, coderMutation);
  assert.equal(context.governedChange.mutationHash, "sha256:coder");
  assert.deepEqual(context.governedChange.changedFiles,
    ["packages/example/src/index.ts"]);
  assert.equal(setActiveGovernedChange(context, "repair_draft", repairMutation,
    "sha256:repair-again"), true);
  assert.equal(context.governedChange.changeKind, "repair_draft");
  assert.equal(context.governedChange.mutationHash, "sha256:repair-again");
  assert.equal(setActiveGovernedChange(context, "masker_called", coderMutation,
    "sha256:invented"), false);
  assert.equal(context.governedChange.changeKind, "repair_draft");
  assert.equal(setActiveGovernedChange(context, "coder_patch_draft", coderMutation,
    "sha256:coder-final"), true);
  assert.equal(context.governedChange.changeKind, "coder_patch_draft");
  assert.equal(context.governedChange.mutationHash, "sha256:coder-final");
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

async function runW16ConfigurationChecks() {
  const names = [
    "WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH",
    "WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH",
    "WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH"
  ];
  await withTemporaryEnvironment({
    [names[0]]: undefined,
    [names[1]]: undefined,
    [names[2]]: undefined,
    WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: undefined,
    WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: undefined
  }, async () => {
    const config = configFromEnv().handoff;
    check("W.16 absent target and consumption status remain safely unconfigured", () => {
      assert.equal(config.targetConfigured, false);
      assert.equal(config.targetIncomplete, false);
      assert.equal(config.target, null);
      assert.equal(config.consumptionStatus, "unknown");
      assert.equal(config.consumptionStatusExternallySupplied, false);
      assert.equal(config.consumptionStatusValid, true);
      assert.equal(config.required, false);
    });
  });
  await withTemporaryEnvironment({
    [names[0]]: "",
    [names[1]]: handoffTarget.baseRevisionHash,
    [names[2]]: handoffTarget.worktreeStateHash,
    WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "invalid-status",
    WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
  }, async () => {
    const config = configFromEnv().handoff;
    check("W.16 explicit empty and invalid status use presence semantics", () => {
      assert.equal(config.targetConfigured, false);
      assert.equal(config.targetIncomplete, true);
      assert.equal(config.target, null);
      assert.equal(config.consumptionStatus, "unknown");
      assert.equal(config.consumptionStatusExternallySupplied, true);
      assert.equal(config.consumptionStatusValid, false);
      assert.equal(config.required, true);
    });
  });
  await withTemporaryEnvironment({
    [names[0]]: handoffTarget.repositoryIdentityHash,
    [names[1]]: handoffTarget.baseRevisionHash,
    [names[2]]: handoffTarget.worktreeStateHash,
    WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "not_consumed"
  }, async () => {
    const config = configFromEnv().handoff;
    check("W.16 complete target retains only the three opaque hashes", () => {
      assert.equal(config.targetConfigured, true);
      assert.equal(config.targetIncomplete, false);
      assert.deepEqual(config.target, handoffTarget);
      assert.equal(config.consumptionStatus, "not_consumed");
      assert.equal(config.consumptionStatusExternallySupplied, true);
    });
  });
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

  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "http://shadow.example/v1",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: "shadow-model",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: undefined,
    WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "2345",
    WORKER_ORCHESTRATOR_ADMIN_MAX_TRACE_EVENTS: "88",
    WORKER_ORCHESTRATOR_ADMIN_MAX_PROMPT_CHARS: "9999",
    WORKER_ORCHESTRATOR_ADMIN_MAX_RESPONSE_CHARS: "11111"
  }, async () => {
    const fallback = configFromEnv();
    check("W.10 Admin configuration falls back to Shadow and maps exact limits", () => {
      assert.equal(fallback.admin.upstreamUrl, "http://shadow.example/v1");
      assert.equal(fallback.admin.modelId, "shadow-model");
      assert.equal(fallback.admin.timeoutMs, 2345);
      assert.equal(fallback.admin.maxTraceEvents, 88);
      assert.equal(fallback.admin.maxPromptChars, 9999);
      assert.equal(fallback.admin.maxResponseChars, 11111);
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: undefined,
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: undefined
  }, async () => {
    const fallback = configFromEnv();
    check("W.10 Admin configuration falls back to worker when Admin and Shadow are absent", () => {
      assert.equal(fallback.admin.upstreamUrl, "http://worker.example/v1");
      assert.equal(fallback.admin.modelId, "worker-model");
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "http://shadow.example/v1",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: "shadow-model",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: "",
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: ""
  }, async () => {
    const explicit = configFromEnv();
    check("W.10 explicitly empty Admin configuration prevents fallback", () => {
      assert.equal(explicit.admin.upstreamUrl, "");
      assert.equal(explicit.admin.modelId, "");
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: "",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: undefined,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: undefined
  }, async () => {
    const explicitShadow = configFromEnv();
    check("W.10 explicitly empty Shadow fallback prevents worker fallback for Admin", () => {
      assert.equal(explicitShadow.admin.upstreamUrl, "");
      assert.equal(explicitShadow.admin.modelId, "");
    });
  });
  await withTemporaryEnvironment({
    WORKER_ORCHESTRATOR_UPSTREAM_URL: "http://worker.example/v1",
    WORKER_ORCHESTRATOR_MODEL_ID: "worker-model",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "http://shadow.example/v1",
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: "shadow-model",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: "http://admin.example/v1",
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: "admin-model"
  }, async () => {
    const explicit = configFromEnv();
    check("W.10 Admin-specific URL and model have highest priority", () => {
      assert.equal(explicit.admin.upstreamUrl, "http://admin.example/v1");
      assert.equal(explicit.admin.modelId, "admin-model");
    });
  });

  const requests = [];
  let shadowCompletion = null;
  let workerScenario = "valid";
  let shadowScenario = "valid";
  let shadowRecommendation = "continue";
  let shadowRiskOverride = null;
  let adminScenario = "valid";
  let usageScenario = "valid";
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const userContent = body.messages.find((message) => message.role === "user").content;
      let shadowPayload = null;
      let adminPayload = null;
      try {
        const parsed = JSON.parse(userContent);
        if (parsed.task === "shadow_observe_accountability_trace") shadowPayload = parsed;
        if (parsed.task === "admin_evaluate_governed_change") adminPayload = parsed;
      } catch {
        // Worker role prompts are deliberately not canonical JSON payloads.
      }
      requests.push({
        body,
        shadow: shadowPayload !== null,
        admin: adminPayload !== null
      });

      if (adminPayload !== null) {
        if (adminScenario === "http_failure") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (adminScenario === "timeout") {
          setTimeout(() => {
            if (!response.writableEnded) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end("{}");
            }
          }, 100);
          return;
        }
        const governanceDecision = adminPayload.governance.decision;
        const profiles = {
          governance_passed: ["admin_auto_approved", "low", 10, "info"],
          governance_repair_required: ["admin_repair_required", "medium", 35, "warning"],
          governance_replan_required: ["admin_replan_required", "medium", 35, "warning"],
          governance_escalation_required: ["admin_human_escalation_required", "high", 60, "high"],
          governance_terminated: ["admin_run_terminated", "critical", 90, "critical"]
        };
        let [decision, riskLevel, riskScore, severity] = profiles[governanceDecision];
        if (adminPayload.shadowObservation &&
            adminPayload.shadowObservation.riskLevel === "critical" &&
            decision === "admin_human_escalation_required") {
          riskLevel = "critical";
          riskScore = 90;
        }
        if (adminScenario === "weak_auto") {
          decision = "admin_auto_approved";
          riskLevel = "low";
          riskScore = 10;
          severity = "info";
        }
        if (adminScenario === "weak_repair") {
          decision = "admin_repair_required";
          riskLevel = "medium";
          riskScore = 35;
          severity = "warning";
        }
        if (adminScenario === "strong_human") {
          decision = "admin_human_escalation_required";
          riskLevel = "high";
          riskScore = 60;
          severity = "high";
        }
        if (adminScenario === "strong_terminate") {
          decision = "admin_run_terminated";
          riskLevel = "critical";
          riskScore = 90;
          severity = "critical";
        }
        const ruleForDecision = {
          admin_repair_required: "execution_outcome",
          admin_replan_required: "planned_scope_consistency"
        }[decision];
        const triggeredRule = adminPayload.governance.ruleResults.find((rule) =>
          adminPayload.governance.triggeredRuleIds.includes(rule.ruleId));
        const evidenceRule = adminPayload.governance.ruleResults.find((rule) =>
          rule.ruleId === ruleForDecision) || triggeredRule || adminPayload.governance.ruleResults[0];
        const evidenceEventId = adminPayload.trace.events[0].eventId;
        const evidenceFile = adminPayload.trace.files.allProposedFiles[0];
        const needsFinding = decision !== "admin_auto_approved";
        const finding = {
          code: "admin_governed_evidence",
          severity,
          message: "Bounded governed workflow evidence.",
          governanceRuleIds: [
            ...new Set([evidenceRule.ruleId, ...(triggeredRule ? [triggeredRule.ruleId] : [])])
          ],
          governanceReasonCodes: triggeredRule ? [triggeredRule.reasonCode] : [],
          governanceIssueCodes: adminPayload.governance.issues.length > 0
            ? [adminPayload.governance.issues[0].code]
            : [],
          traceFindingCodes: [],
          shadowFindingCodes: [],
          evidenceEventIds: [evidenceEventId],
          evidenceFilePaths: evidenceFile ? [evidenceFile] : []
        };
        const adminDecision = {
          decisionVersion: "1",
          runId: adminScenario === "wrong_run" ? "wrong-run" : adminPayload.bindings.runId,
          traceHash: adminScenario === "wrong_trace_hash"
            ? `sha256:${"c".repeat(64)}`
            : adminPayload.bindings.traceHash,
          observationHash: adminScenario === "wrong_observation_hash"
            ? `sha256:${"d".repeat(64)}`
            : adminPayload.bindings.observationHash,
          governanceHash: adminScenario === "wrong_governance_hash"
            ? `sha256:${"e".repeat(64)}`
            : adminPayload.bindings.governanceHash,
          decision,
          riskLevel,
          riskScore,
          confidenceScore: 90,
          findings: needsFinding ? [finding] : [],
          rationaleCodes: ["bounded_admin_evaluation"]
        };
        if (adminScenario === "needs_review") {
          const duplicate = {
            ...finding,
            governanceRuleIds: [...finding.governanceRuleIds],
            evidenceEventIds: [
              adminPayload.trace.events[0].eventId,
              adminPayload.trace.events[1].eventId
            ]
          };
          adminDecision.decision = "admin_repair_required";
          adminDecision.riskLevel = "medium";
          adminDecision.riskScore = 35;
          duplicate.governanceRuleIds = ["execution_outcome"];
          adminDecision.findings = [
            duplicate,
            {
              ...duplicate,
              governanceRuleIds: [...duplicate.governanceRuleIds].reverse(),
              evidenceEventIds: [...duplicate.evidenceEventIds].reverse()
            }
          ];
        }
        const content = adminScenario === "malformed"
          ? "RAW_ADMIN_COMPLETION_SENTINEL"
          : JSON.stringify(adminDecision);
        const body = adminScenario === "oversized"
          ? "X".repeat(40000)
          : JSON.stringify({
            choices: [{ message: { content } }],
            ...(usageScenario === "missing" ? {} : {
              usage: usageScenario === "invalid"
                ? { prompt_tokens: -1, completion_tokens: 8, total_tokens: 7 }
                : { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 }
            })
          });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }

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
        let recommendationProfile = {
          continue: { riskLevel: "low", riskScore: 10, severity: null },
          request_repair: { riskLevel: "low", riskScore: 10, severity: "info" },
          request_replan: { riskLevel: "low", riskScore: 10, severity: "info" },
          escalate: { riskLevel: "critical", riskScore: 90, severity: "critical" },
          terminate: { riskLevel: "critical", riskScore: 90, severity: "critical" }
        }[shadowRecommendation];
        let effectiveRecommendation = shadowRecommendation;
        if (shadowRiskOverride !== null) {
          recommendationProfile = {
            medium: { riskLevel: "medium", riskScore: 35, severity: "warning" },
            high: { riskLevel: "high", riskScore: 60, severity: "high" },
            critical: { riskLevel: "critical", riskScore: 90, severity: "critical" }
          }[shadowRiskOverride];
          effectiveRecommendation = shadowRiskOverride === "medium"
            ? "continue"
            : shadowRiskOverride === "high"
              ? "request_repair"
              : "escalate";
        }
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
          recommendation: effectiveRecommendation,
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
      if (workerScenario === "patch_noop" && role === "remask") {
        mutation = {
          ...workerMutation("remask"),
          claims: [{
            ...workerMutation("remask").claims[0],
            proposedPatch: fixture.fileContents["packages/example/src/index.ts"]
          }]
        };
      }
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
    WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH:
      handoffTarget.repositoryIdentityHash,
    WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH:
      handoffTarget.baseRevisionHash,
    WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH:
      handoffTarget.worktreeStateHash,
    WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "not_consumed",
    WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "0",
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
      const shadowEvent = report.accountability.ledger.events.find((event) =>
        event.actor === "shadow_observer");
      assert.ok(shadowEvent);
      assert.ok(shadowEvent.inputArtifactHashes.includes(
        report.accountability.preShadowTraceHash
      ));
      assert.ok(shadowEvent.outputArtifactHashes.includes(
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

    check("W.10 successful path preserves Phase V and appends governed audit stages", () => {
      assert.equal(requests.filter((request) => request.admin).length, 1);
      assert.equal(report.finalDecision, "temp_validation_passed");
      assert.equal(report.governance.evaluated, true);
      assert.equal(report.governance.decision, "governance_passed");
      assert.equal(report.governanceStageDecision, "governance_passed");
      assert.match(report.governance.policyHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(report.governance.governanceHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(report.governance.eventAppended, true);
      assert.equal(report.adminAgent.called, true);
      assert.equal(report.adminAgent.adapterDecision, "admin_agent_completed");
      assert.equal(report.adminAgent.validationDecision, "admin_decision_valid");
      assert.equal(report.adminAgent.decision, "admin_auto_approved");
      assert.match(report.adminAgent.adminDecisionHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(report.adminAgent.eventAppended, true);
      assert.equal(report.accountability.postGovernanceLedgerVerificationDecision,
        "ledger_valid");
      assert.equal(report.accountability.postAdminLedgerVerificationDecision, "ledger_valid");
      assert.ok(report.accountability.postGovernanceTrace);
      assert.ok(report.accountability.postAdminTrace);
      assert.deepEqual(report.accountability.ledger.events.map((event) => event.actor), [
        "planner", "coder", "deterministic_verifier", "masker", "repairer",
        "repair_verifier", "patch_dry_run", "temp_workspace_apply",
        "execution_verifier", "shadow_observer", "deterministic_governor", "admin_agent",
        "approval_router"
      ]);
      assert.equal(report.accountability.ledger.events.at(-1).actor, "approval_router");
      assert.equal(report.accountability.ledger.events.at(-1).eventId,
        "worker-orchestrator:phase-p-orchestrator-safe-helper:event:000013");
      assert.equal(report.accountability.ledger.rootHash,
        report.accountability.ledger.events.at(-1).eventHash);
      assert.equal(report.accountability.eventCountAfterGovernance, 11);
      assert.equal(report.accountability.eventCountAfterAdmin, 12);
      assert.equal(report.accountability.eventCountAfterRouter, 13);
      assert.notEqual(report.accountability.ledgerRootHashAfterAdmin,
        report.accountability.ledger.rootHash);
      assert.equal(report.accountability.ledgerRootHashAfterRouter,
        report.accountability.ledger.rootHash);
      assert.equal(report.orchestratorDecision.governanceEvaluated, true);
      assert.equal(report.orchestratorDecision.governanceDecision,
        "governance_passed");
      assert.equal(report.orchestratorDecision.adminAgentCalled, true);
      assert.equal(report.orchestratorDecision.adminDecision,
        "admin_auto_approved");
      assert.equal(report.orchestratorDecision.postAdminTraceHash,
        report.accountability.postAdminTraceHash);
      assert.equal(report.shadowObserver.observation.traceHash,
        report.accountability.preShadowTraceHash);
      assert.equal(report.governance.traceHash, report.accountability.preShadowTraceHash);
      assert.equal(report.governance.observationHash, report.shadowObserver.observationHash);
      assert.equal(report.adminAgent.adminDecision.traceHash,
        report.accountability.preShadowTraceHash);
      assert.equal(report.adminAgent.adminDecision.observationHash,
        report.shadowObserver.observationHash);
      assert.equal(report.adminAgent.adminDecision.governanceHash,
        report.governance.governanceHash);
      assert.notEqual(report.accountability.preShadowTraceHash,
        report.accountability.postShadowTraceHash);
      assert.notEqual(report.accountability.postShadowTraceHash,
        report.accountability.postGovernanceTraceHash);
      assert.notEqual(report.accountability.postGovernanceTraceHash,
        report.accountability.postAdminTraceHash);
      assert.notEqual(report.accountability.postAdminTraceHash,
        report.accountability.postRouterTraceHash);
    });

    check("W.12 successful path appends a valid auto-continue router audit", () => {
      assert.equal(requests.length, 5);
      assert.equal(report.approvalRouter.evaluated, true);
      assert.equal(report.approvalRouter.required, true);
      assert.equal(report.approvalRouter.requiredSatisfied, true);
      assert.equal(report.approvalRouter.validationDecision, "approval_route_valid");
      assert.equal(report.approvalRouterStageDecision, "approval_route_valid");
      assert.equal(report.approvalRouter.route, "auto_continue");
      assert.equal(report.workflowRoute, "auto_continue");
      assert.equal(report.approvalRouter.riskClass, "low");
      assert.equal(report.approvalRouter.autoContinueEligible, true);
      assert.equal(report.approvalRouter.deterministicAuthorityPreserved, true);
      assert.match(report.approvalRouter.policyHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(report.approvalRouter.routeHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(report.approvalRouter.eventAppended, true);
      assert.equal(report.accountability.postRouterLedgerVerificationDecision,
        "ledger_valid");
      assert.ok(report.accountability.postRouterTrace);
      assert.equal(report.orchestratorDecision.approvalWorkflowRoute, "auto_continue");
      assert.equal(report.orchestratorDecision.approvalRouteHash,
        report.approvalRouter.routeHash);
      assert.equal(report.accountability.ledger.events.filter((event) =>
        event.actor === "planner").length, 1);
      assert.equal(report.accountability.ledger.events.filter((event) =>
        event.actor === "repairer").length, 1);
    });

    check("W.14 successful path builds and immediately verifies the exact governed change", () => {
      const events = report.accountability.ledger.events;
      const repairer = events.find((event) => event.actor === "repairer");
      const patchDryRun = events.find((event) => event.actor === "patch_dry_run");
      const temporaryApply = events.find((event) => event.actor === "temp_workspace_apply");
      const executionVerifier = events.find((event) => event.actor === "execution_verifier");
      const artifact = report.governedChangeArtifact.artifact;
      assert.equal(report.governedChangeArtifact.evaluated, true);
      assert.equal(report.governedChangeArtifact.required, true);
      assert.equal(report.governedChangeArtifact.requiredSatisfied, true);
      assert.equal(report.governedChangeArtifact.decision,
        "governed_change_artifact_ready");
      assert.equal(report.governedChangeArtifactStageDecision,
        "governed_change_artifact_ready");
      assert.equal(report.governedChangeArtifact.artifactBuilt, true);
      assert.equal(report.governedChangeArtifact.applyEligible, true);
      assert.equal(report.governedChangeArtifact.changeKind, "repair_draft");
      assert.ok(repairer.outputArtifactHashes.includes(
        report.governedChangeArtifact.mutationHash));
      assert.ok(patchDryRun.inputArtifactHashes.includes(
        report.governedChangeArtifact.mutationHash));
      assert.deepEqual(artifact.change.changedFiles, repairer.filesProposed);
      assert.deepEqual(artifact.change.changedFiles, temporaryApply.filesProposed);
      assert.equal(artifact.change.patchDryRunResultHash,
        patchDryRun.outputArtifactHashes[0]);
      assert.equal(artifact.change.temporaryApplyResultHash,
        temporaryApply.outputArtifactHashes[0]);
      assert.equal(artifact.change.executionVerificationResultHash,
        executionVerifier.outputArtifactHashes[0]);
      assert.equal(artifact.evidence.finalLedgerRootHash,
        report.accountability.ledger.rootHash);
      assert.equal(artifact.evidence.finalLedgerEventCount,
        report.accountability.ledger.eventCount);
      assert.equal(report.governedChangeFreshness.evaluated, true);
      assert.equal(report.governedChangeFreshness.decision,
        "governed_change_current");
      assert.equal(report.governedChangeFreshness.artifactIntegrityVerified, true);
      assert.equal(report.governedChangeFreshness.snapshotCurrent, true);
      assert.equal(report.governedChangeFreshness.handoffEligible, true);
      assert.match(report.governedChangeFreshness.currentSnapshotHash,
        /^sha256:[0-9a-f]{64}$/);
      assert.equal(report.orchestratorDecision.governedChangeArtifactEvaluated, true);
      assert.equal(report.orchestratorDecision.governedChangeArtifactRequired, true);
      assert.equal(report.orchestratorDecision.governedChangeArtifactRequiredSatisfied,
        true);
      assert.equal(report.orchestratorDecision.governedChangeArtifactDecision,
        "governed_change_artifact_ready");
      assert.equal(report.orchestratorDecision.governedChangeKind, "repair_draft");
      assert.equal(report.orchestratorDecision.governedChangeArtifactHash,
        artifact.governedArtifactHash);
      assert.equal(report.orchestratorDecision.governedChangeFreshnessDecision,
        "governed_change_current");
      assert.equal(report.orchestratorDecision.governedChangeHandoffEligible, true);
      assert.equal(report.orchestratorDecision.governedChangeStaleFieldCount, 0);
      assert.equal(events.length, 13);
      assert.equal(events.at(-1).actor, "approval_router");
      assert.equal(events.at(-1).action, "approval_router.evaluate");
      assert.equal(events.at(-1).eventHash, report.accountability.ledger.rootHash);
      assert.equal(report.status, "completed");
      assert.equal(report.ok, true);
    });

    check("W.16 successful repair path builds and verifies an unexecuted handoff", () => {
      const handoff = report.controlledApplyHandoff.handoff;
      const artifact = report.governedChangeArtifact.artifact;
      const events = report.accountability.ledger.events;
      assert.equal(report.controlledApplyHandoff.evaluated, true);
      assert.equal(report.controlledApplyHandoff.applicable, true);
      assert.equal(report.controlledApplyHandoff.configured, true);
      assert.equal(report.controlledApplyHandoff.required, false);
      assert.equal(report.controlledApplyHandoff.requiredSatisfied, true);
      assert.equal(report.controlledApplyHandoff.decision,
        "controlled_apply_handoff_ready");
      assert.equal(report.controlledApplyHandoffStageDecision,
        "controlled_apply_handoff_ready");
      assert.equal(report.controlledApplyHandoff.handoffBuilt, true);
      assert.equal(report.controlledApplyHandoff.mutationHash,
        artifact.change.mutationHash);
      assert.equal(report.controlledApplyHandoff.changedFileCount,
        artifact.change.changedFiles.length);
      assert.equal(report.controlledApplyHandoff.governedArtifactHash,
        artifact.governedArtifactHash);
      assert.equal(report.controlledApplyHandoff.currentSnapshotHash,
        report.governedChangeFreshness.currentSnapshotHash);
      assert.deepEqual(handoff.target, handoffTarget);
      assert.equal(report.controlledApplyHandoff.repositoryIdentityHash,
        handoffTarget.repositoryIdentityHash);
      assert.equal(report.controlledApplyHandoff.baseRevisionHash,
        handoffTarget.baseRevisionHash);
      assert.equal(report.controlledApplyHandoff.worktreeStateHash,
        handoffTarget.worktreeStateHash);
      assert.match(report.controlledApplyHandoff.constraintsHash,
        /^sha256:[0-9a-f]{64}$/);
      assert.match(report.controlledApplyHandoff.consumptionKey,
        /^sha256:[0-9a-f]{64}$/);
      assert.match(report.controlledApplyHandoff.handoffHash,
        /^sha256:[0-9a-f]{64}$/);
      assert.equal(report.controlledApplyHandoff.externalConsumptionRegistryRequired,
        true);
      assert.equal(report.controlledApplyHandoff.applyExecuted, false);
      assert.equal(report.controlledApplyHandoff.registryWritten, false);
      assert.equal(report.controlledApplyHandoff.rollbackPrepared, false);
      assert.equal(report.controlledApplyHandoffVerification.evaluated, true);
      assert.equal(report.controlledApplyHandoffVerification.decision,
        "controlled_apply_handoff_current");
      assert.equal(report.controlledApplyHandoffVerificationStageDecision,
        "controlled_apply_handoff_current");
      assert.equal(report.controlledApplyHandoffVerification.consumptionStatus,
        "not_consumed");
      assert.equal(report.controlledApplyHandoffVerification
        .consumptionStatusExternallySupplied, true);
      assert.equal(report.controlledApplyHandoffVerification.executionEligible, true);
      assert.equal(events.length, 13);
      assert.equal(events.at(-1).actor, "approval_router");
      assert.equal(events.at(-1).action, "approval_router.evaluate");
      assert.equal(events.at(-1).eventHash, report.accountability.ledger.rootHash);
      assert.equal(report.orchestratorDecision.controlledApplyHandoffDecision,
        "controlled_apply_handoff_ready");
      assert.equal(report.orchestratorDecision
        .controlledApplyHandoffVerificationDecision,
      "controlled_apply_handoff_current");
      assert.equal(report.orchestratorDecision.controlledApplyHandoffExecutionEligible,
        true);
      assert.equal(report.orchestratorDecision.controlledApplyApplyExecuted, false);
      assert.equal(report.orchestratorDecision.controlledApplyRegistryWritten, false);
      assert.equal(report.orchestratorDecision.controlledApplyRollbackPrepared, false);
    });

    let handoffInputCalls = 0;
    let handoffVerificationCalls = 0;
    let retainedHandoffMutation = null;
    let singleHandoffEvaluation;
    try {
      fixture.controlledApplyHandoffInputMutation = (input) => {
        handoffInputCalls += 1;
        retainedHandoffMutation = input.mutation;
        return input;
      };
      fixture.controlledApplyHandoffVerificationInputMutation = (input) => {
        handoffVerificationCalls += 1;
        assert.strictEqual(input.mutation, retainedHandoffMutation);
        return input;
      };
      singleHandoffEvaluation = await execute();
    } finally {
      delete fixture.controlledApplyHandoffInputMutation;
      delete fixture.controlledApplyHandoffVerificationInputMutation;
    }
    check("W.16 planner and verifier are each invoked once", () => {
      assert.equal(handoffInputCalls, 1);
      assert.equal(handoffVerificationCalls, 1);
      assert.equal(singleHandoffEvaluation.controlledApplyHandoff.decision,
        "controlled_apply_handoff_ready");
    });

    const missingTargetHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH: undefined,
      WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: undefined,
      WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH: undefined
    });
    const partialTargetHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH:
        handoffTarget.repositoryIdentityHash,
      WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: undefined,
      WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH: undefined
    });
    check("W.16 missing and partial optional target configuration do not build", () => {
      assert.equal(missingTargetHandoff.controlledApplyHandoff.applicable, true);
      assert.equal(missingTargetHandoff.controlledApplyHandoff.configured, false);
      assert.deepEqual(missingTargetHandoff.controlledApplyHandoff.issueCodes,
        ["controlled_apply_target_not_configured"]);
      assert.equal(missingTargetHandoff.controlledApplyHandoff.evaluated, false);
      assert.equal(missingTargetHandoff.status, "completed");
      assert.equal(partialTargetHandoff.controlledApplyHandoff.configured, false);
      assert.deepEqual(partialTargetHandoff.controlledApplyHandoff.issueCodes,
        ["controlled_apply_target_configuration_incomplete"]);
      assert.equal(partialTargetHandoff.controlledApplyHandoff.evaluated, false);
      assert.equal(partialTargetHandoff.status, "completed");
    });

    const invalidTargetValues = [
      ["WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH", "bad"],
      ["WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH", "sha256:abcd"],
      ["WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH",
        `sha256:${"A".repeat(64)}`],
      ["WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH", repoRoot]
    ];
    const invalidTargetReports = [];
    for (const [name, value] of invalidTargetValues) {
      invalidTargetReports.push(await execute({ [name]: value }));
    }
    check("W.16 complete but malformed target hashes are delegated to W.15", () => {
      for (const candidate of invalidTargetReports) {
        assert.equal(candidate.controlledApplyHandoff.configured, true);
        assert.equal(candidate.controlledApplyHandoff.evaluated, true);
        assert.equal(candidate.controlledApplyHandoff.decision,
          "controlled_apply_handoff_invalid");
        assert.equal(candidate.controlledApplyHandoff.handoff, null);
        assert.equal(candidate.controlledApplyHandoffVerification.evaluated, false);
        assert.equal(candidate.controlledApplyHandoff.applyExecuted, false);
        assert.equal(candidate.status, "completed");
        assert.ok(!JSON.stringify(candidate).includes(repoRoot));
      }
    });

    const consumedHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "already_consumed"
    });
    const unknownHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "unknown"
    });
    const absentStatusHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: undefined
    });
    const invalidStatusHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "not-trusted"
    });
    check("W.16 external consumption states cannot imply availability", () => {
      assert.equal(consumedHandoff.controlledApplyHandoff.handoffBuilt, true);
      assert.equal(consumedHandoff.controlledApplyHandoffVerification.decision,
        "controlled_apply_handoff_consumed");
      assert.equal(consumedHandoff.controlledApplyHandoffVerification.executionEligible,
        false);
      for (const candidate of [unknownHandoff, absentStatusHandoff]) {
        assert.equal(candidate.controlledApplyHandoffVerification.consumptionStatus,
          "unknown");
        assert.equal(candidate.controlledApplyHandoffVerification.decision,
          "controlled_apply_handoff_verification_invalid");
        assert.equal(candidate.controlledApplyHandoffVerification.executionEligible,
          false);
      }
      assert.equal(absentStatusHandoff.controlledApplyHandoffVerification
        .consumptionStatusExternallySupplied, false);
      assert.equal(invalidStatusHandoff.controlledApplyHandoffVerification
        .consumptionStatus, "unknown");
      assert.equal(invalidStatusHandoff.controlledApplyHandoffVerification
        .executionEligible, false);
      assert.ok(invalidStatusHandoff.controlledApplyHandoff.issueCodes.includes(
        "controlled_apply_consumption_status_invalid"));
      assert.ok(invalidStatusHandoff.controlledApplyHandoffVerification.reasonCodes
        .includes("controlled_apply_consumption_status_invalid"));
      for (const candidate of [consumedHandoff, unknownHandoff, absentStatusHandoff,
        invalidStatusHandoff]) {
        assert.equal(candidate.status, "completed");
      }
    });

    const requiredHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
    });
    const requiredMissingHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
      WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH: undefined,
      WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: undefined,
      WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH: undefined
    });
    const requiredConsumedHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "already_consumed"
    });
    const requiredPartialHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
      WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: undefined
    });
    const requiredInvalidTargetHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
      WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: "invalid"
    });
    const requiredUnknownHandoff = await execute({
      WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
      WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "unknown"
    });
    check("W.16 required mode succeeds only for a current available handoff", () => {
      assert.equal(requiredHandoff.controlledApplyHandoff.required, true);
      assert.equal(requiredHandoff.controlledApplyHandoff.requiredSatisfied, true);
      assert.equal(requiredHandoff.status, "completed");
      for (const candidate of [requiredMissingHandoff, requiredPartialHandoff,
        requiredInvalidTargetHandoff, requiredConsumedHandoff,
        requiredUnknownHandoff]) {
        assert.equal(candidate.controlledApplyHandoff.required, true);
        assert.equal(candidate.controlledApplyHandoff.requiredSatisfied, false);
        assert.equal(candidate.status, "failed_required_controlled_apply_handoff");
        assert.equal(candidate.ok, false);
        assert.ok(fs.existsSync(candidate.jsonPath));
        assert.ok(fs.existsSync(candidate.markdownPath));
      }
    });

    let mutationMismatch;
    try {
      fixture.controlledApplyHandoffInputMutation = (input) => ({
        ...input,
        mutation: { ...input.mutation, confidence: 0.8 }
      });
      mutationMismatch = await execute({
        WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
      });
    } finally {
      delete fixture.controlledApplyHandoffInputMutation;
    }
    let staleTarget;
    try {
      fixture.controlledApplyHandoffVerificationInputMutation = (input) => ({
        ...input,
        currentTarget: {
          ...input.currentTarget,
          worktreeStateHash: `sha256:${"4".repeat(64)}`
        }
      });
      staleTarget = await execute({
        WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
      });
    } finally {
      delete fixture.controlledApplyHandoffVerificationInputMutation;
    }
    let tamperedHandoff;
    try {
      fixture.controlledApplyHandoffMutation = (handoff) => ({
        ...handoff,
        handoffHash: `sha256:${"5".repeat(64)}`
      });
      tamperedHandoff = await execute({
        WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
      });
    } finally {
      delete fixture.controlledApplyHandoffMutation;
    }
    let ledgerMutationDetected;
    try {
      fixture.controlledApplyHandoffInputMutation = (input, _runtime, context) => {
        context.ledger = {
          ...context.ledger,
          eventCount: context.ledger.eventCount + 1
        };
        return input;
      };
      ledgerMutationDetected = await execute({
        WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
      });
    } finally {
      delete fixture.controlledApplyHandoffInputMutation;
    }
    check("W.16 rejects mutation mismatch, target staleness, and handoff tampering", () => {
      assert.equal(mutationMismatch.controlledApplyHandoff.decision,
        "controlled_apply_handoff_invalid");
      assert.ok(mutationMismatch.controlledApplyHandoff.issueCodes.includes(
        "controlled_apply_mutation_hash_mismatch"));
      assert.equal(staleTarget.controlledApplyHandoffVerification.decision,
        "controlled_apply_handoff_stale");
      assert.ok(staleTarget.controlledApplyHandoffVerification.staleFields.includes(
        "worktreeStateHash"));
      assert.equal(staleTarget.controlledApplyHandoffVerification.executionEligible,
        false);
      assert.equal(tamperedHandoff.controlledApplyHandoffVerification.decision,
        "controlled_apply_handoff_verification_invalid");
      assert.equal(tamperedHandoff.controlledApplyHandoffVerification.executionEligible,
        false);
      for (const candidate of [mutationMismatch, staleTarget, tamperedHandoff]) {
        assert.equal(candidate.controlledApplyHandoff.required, true);
        assert.equal(candidate.controlledApplyHandoff.requiredSatisfied, false);
        assert.equal(candidate.status, "failed_required_controlled_apply_handoff");
      }
    });
    check("W.16 detects any final-ledger anchor mutation", () => {
      assert.ok(ledgerMutationDetected.controlledApplyHandoff.issueCodes.includes(
        "controlled_apply_final_ledger_mutated"));
      assert.equal(ledgerMutationDetected.controlledApplyHandoff.requiredSatisfied,
        false);
      assert.equal(ledgerMutationDetected.status,
        "failed_required_controlled_apply_handoff");
      assert.equal(ledgerMutationDetected.accountability.ledger.events.at(-1).actor,
        "approval_router");
      assert.equal(ledgerMutationDetected.accountability.ledger.events.at(-1).action,
        "approval_router.evaluate");
    });

    let artifactInputCalls = 0;
    let freshnessSnapshotCalls = 0;
    let singleEvaluationReport;
    try {
      fixture.governedChangeArtifactInputMutation = (input) => {
        artifactInputCalls += 1;
        return input;
      };
      fixture.governedChangeFreshnessSnapshotMutation = (snapshot) => {
        freshnessSnapshotCalls += 1;
        return snapshot;
      };
      singleEvaluationReport = await execute();
    } finally {
      delete fixture.governedChangeArtifactInputMutation;
      delete fixture.governedChangeFreshnessSnapshotMutation;
    }
    check("W.14 artifact and freshness evaluation each occur exactly once", () => {
      assert.equal(artifactInputCalls, 1);
      assert.equal(freshnessSnapshotCalls, 1);
      assert.equal(singleEvaluationReport.governedChangeArtifact.decision,
        "governed_change_artifact_ready");
      assert.equal(singleEvaluationReport.governedChangeFreshness.decision,
        "governed_change_current");
    });

    const governedWrongHash = (label) => `sha256:${label.repeat(64).slice(0, 64)}`;
    const activeHashCorruptions = [];
    try {
      for (const field of [
        "mutationHash",
        "patchDryRunResultHash",
        "temporaryApplyResultHash",
        "executionVerificationResultHash"
      ]) {
        fixture.governedChangeActiveStateMutation = (state) => ({
          ...state,
          changedFiles: [...state.changedFiles],
          [field]: governedWrongHash(field[0])
        });
        activeHashCorruptions.push([field, await execute()]);
      }
    } finally {
      delete fixture.governedChangeActiveStateMutation;
    }
    check("W.14 exact active stage hash corruptions fail closed", () => {
      for (const [field, candidate] of activeHashCorruptions) {
        assert.equal(candidate.governedChangeArtifact.required, true, field);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, false, field);
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_invalid", field);
        assert.equal(candidate.governedChangeArtifact.artifact, null, field);
        assert.equal(candidate.governedChangeFreshness.evaluated, false, field);
        assert.equal(candidate.status, "failed_required_governed_change_artifact", field);
        assert.equal(candidate.accountability.ledger.events.at(-1).actor,
          "approval_router", field);
      }
    });

    let changedFileMismatch;
    try {
      fixture.governedChangeActiveStateMutation = (state) => ({
        ...state,
        changedFiles: ["packages/example/src/other.ts"]
      });
      changedFileMismatch = await execute();
    } finally {
      delete fixture.governedChangeActiveStateMutation;
    }
    check("W.14 changed files must exactly match the retained mutation source", () => {
      assert.equal(changedFileMismatch.governedChangeArtifact.decision,
        "governed_change_artifact_invalid");
      assert.ok(changedFileMismatch.governedChangeArtifact.issueCodes.includes(
        "governed_change_mutation_file_mismatch"));
      assert.equal(changedFileMismatch.governedChangeArtifact.requiredSatisfied, false);
      assert.equal(changedFileMismatch.governedChangeFreshness.evaluated, false);
    });

    let missingActiveState;
    try {
      fixture.governedChangeActiveStateMutation = (state) => ({
        ...state,
        mutation: null,
        mutationHash: null,
        changedFiles: []
      });
      missingActiveState = await execute();
    } finally {
      delete fixture.governedChangeActiveStateMutation;
    }
    check("W.14 missing active mutation is attempted without inventing evidence", () => {
      assert.equal(missingActiveState.governedChangeArtifact.evaluated, true);
      assert.equal(missingActiveState.governedChangeArtifact.required, true);
      assert.equal(missingActiveState.governedChangeArtifact.requiredSatisfied, false);
      assert.equal(missingActiveState.governedChangeArtifact.mutationHash, null);
      assert.equal(missingActiveState.governedChangeArtifact.artifact, null);
      assert.deepEqual(missingActiveState.governedChangeArtifact.issueCodes,
        ["governed_change_active_mutation_unavailable"]);
      assert.equal(missingActiveState.governedChangeFreshness.evaluated, false);
      assert.equal(missingActiveState.governedChangeFreshness.handoffEligible, false);
    });

    const anchorCorruptions = [];
    const anchorMutators = {
      expectedRootHash: (input) => ({
        ...input,
        finalLedgerAnchors: {
          ...input.finalLedgerAnchors,
          expectedRootHash: governedWrongHash("a")
        }
      }),
      expectedEventCount: (input) => ({
        ...input,
        finalLedgerAnchors: {
          ...input.finalLedgerAnchors,
          expectedEventCount: input.finalLedgerAnchors.expectedEventCount - 1
        }
      }),
      expectedRunId: (input) => ({
        ...input,
        finalLedgerAnchors: {
          ...input.finalLedgerAnchors,
          expectedRunId: "wrong-run"
        }
      }),
      expectedObjectiveHash: (input) => ({
        ...input,
        finalLedgerAnchors: {
          ...input.finalLedgerAnchors,
          expectedObjectiveHash: governedWrongHash("b")
        }
      }),
      postAdminLedger: (input) => {
        const finalLedger = structuredClone(input.finalLedger);
        finalLedger.events = finalLedger.events.slice(0, -1);
        finalLedger.eventCount = finalLedger.events.length;
        finalLedger.rootHash = finalLedger.events.at(-1).eventHash;
        return {
          ...input,
          finalLedger,
          finalLedgerAnchors: {
            expectedRunId: finalLedger.runId,
            expectedObjectiveHash: finalLedger.objectiveHash,
            expectedRootHash: finalLedger.rootHash,
            expectedEventCount: finalLedger.eventCount
          }
        };
      },
      routerEventNotFinal: (input) => {
        const finalLedger = structuredClone(input.finalLedger);
        const last = finalLedger.events.length - 1;
        [finalLedger.events[last - 1], finalLedger.events[last]] =
          [finalLedger.events[last], finalLedger.events[last - 1]];
        return { ...input, finalLedger };
      }
    };
    try {
      for (const [field, mutate] of Object.entries(anchorMutators)) {
        fixture.governedChangeArtifactInputMutation = mutate;
        anchorCorruptions.push([field, await execute()]);
      }
    } finally {
      delete fixture.governedChangeArtifactInputMutation;
    }
    check("W.14 final-ledger anchor corruptions invalidate the artifact", () => {
      for (const [field, candidate] of anchorCorruptions) {
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_invalid", field);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, false, field);
        assert.equal(candidate.governedChangeArtifact.artifact, null, field);
        assert.equal(candidate.accountability.ledger.eventCount, 13, field);
        assert.equal(candidate.accountability.ledger.events.at(-1).actor,
          "approval_router", field);
      }
    });

    const staleReports = [];
    const staleValues = {
      mutationHash: governedWrongHash("c"),
      changedFiles: ["packages/example/src/changed.ts"],
      executionVerificationResultHash: governedWrongHash("d"),
      governanceHash: governedWrongHash("e"),
      routeHash: governedWrongHash("f"),
      finalLedgerRootHash: governedWrongHash("0"),
      workflowRoute: "human_required"
    };
    try {
      for (const [field, value] of Object.entries(staleValues)) {
        fixture.governedChangeFreshnessSnapshotMutation = (snapshot) => ({
          ...snapshot,
          [field]: value
        });
        staleReports.push([field, await execute()]);
      }
    } finally {
      delete fixture.governedChangeFreshnessSnapshotMutation;
    }
    check("W.14 independently retained stale evidence prevents handoff", () => {
      for (const [field, candidate] of staleReports) {
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_ready", field);
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_stale", field);
        assert.deepEqual(candidate.governedChangeFreshness.staleFields, [field], field);
        assert.equal(candidate.governedChangeFreshness.handoffEligible, false, field);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, false, field);
        assert.equal(candidate.status, "failed_required_governed_change_artifact", field);
      }
    });

    let artifactIntegrityFailure;
    try {
      fixture.governedChangeArtifactMutation = (artifact) => {
        const clone = JSON.parse(JSON.stringify(artifact));
        clone.decisions.workflowRoute = "human_required";
        return clone;
      };
      artifactIntegrityFailure = await execute();
    } finally {
      delete fixture.governedChangeArtifactMutation;
    }
    check("W.14 artifact tampering fails immediate integrity verification", () => {
      assert.equal(artifactIntegrityFailure.governedChangeArtifact.artifactBuilt, true);
      assert.equal(artifactIntegrityFailure.governedChangeFreshness.decision,
        "governed_change_freshness_invalid");
      assert.equal(artifactIntegrityFailure.governedChangeFreshness.artifactIntegrityVerified,
        false);
      assert.equal(artifactIntegrityFailure.governedChangeFreshness.handoffEligible, false);
      assert.equal(artifactIntegrityFailure.governedChangeArtifact.requiredSatisfied, false);
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
      assert.equal(byActor.deterministic_governor.action,
        "deterministic_governor.evaluate");
      assert.ok(byActor.deterministic_governor.inputArtifactHashes.includes(
        report.accountability.preShadowTraceHash));
      assert.ok(byActor.deterministic_governor.inputArtifactHashes.includes(
        report.shadowObserver.observationHash));
      assert.ok(byActor.deterministic_governor.inputArtifactHashes.includes(
        report.governance.policyHash));
      assert.deepEqual(byActor.deterministic_governor.outputArtifactHashes,
        [report.governance.governanceHash]);
      assert.equal(byActor.deterministic_governor.decision,
        report.governance.decision);
      assert.deepEqual(byActor.deterministic_governor.reasonCodes,
        report.governance.reasonCodes);
      assert.deepEqual(byActor.deterministic_governor.filesProposed, []);
      assert.equal(byActor.deterministic_governor.tokenUsage, undefined);
      assert.equal(byActor.admin_agent.action, "admin_agent.evaluate");
      assert.ok(byActor.admin_agent.inputArtifactHashes.includes(
        report.accountability.preShadowTraceHash));
      assert.ok(byActor.admin_agent.inputArtifactHashes.includes(
        report.shadowObserver.observationHash));
      assert.ok(byActor.admin_agent.inputArtifactHashes.includes(
        report.governance.governanceHash));
      assert.ok(byActor.admin_agent.outputArtifactHashes.includes(
        report.adminAgent.adminDecisionHash));
      assert.ok(byActor.admin_agent.outputArtifactHashes.includes(
        report.adminAgent.responseContentHash));
      assert.equal(byActor.admin_agent.decision, report.adminAgent.decision);
      assert.deepEqual(byActor.admin_agent.filesProposed, []);
      assert.deepEqual(byActor.admin_agent.tokenUsage,
        { inputTokens: 13, outputTokens: 8, totalTokens: 21 });
      assert.equal(byActor.approval_router.action, "approval_router.evaluate");
      for (const hash of [
        report.accountability.preShadowTraceHash,
        report.shadowObserver.observationHash,
        report.governance.governanceHash,
        report.adminAgent.adminDecisionHash,
        report.approvalRouter.policyHash
      ]) assert.ok(byActor.approval_router.inputArtifactHashes.includes(hash));
      assert.deepEqual(byActor.approval_router.outputArtifactHashes,
        [report.approvalRouter.routeHash]);
      assert.equal(byActor.approval_router.decision, "auto_continue");
      assert.deepEqual(byActor.approval_router.reasonCodes,
        report.approvalRouter.reasonCodes);
      const expectedRouterFiles = [...new Set([
        ...report.approvalRouter.assessment.issues.flatMap((issue) => issue.filePaths),
        ...report.approvalRouter.assessment.ruleResults.flatMap((rule) => rule.filePaths)
      ])];
      assert.deepEqual(byActor.approval_router.filesRead, expectedRouterFiles);
      assert.deepEqual(byActor.approval_router.filesProposed, []);
      assert.equal(byActor.approval_router.tokenUsage, undefined);
      assert.equal(report.approvalRouter.traceHash,
        report.accountability.preShadowTraceHash);
      assert.equal(report.approvalRouter.observationHash,
        report.shadowObserver.observationHash);
      assert.equal(report.approvalRouter.governanceHash,
        report.governance.governanceHash);
      assert.equal(report.approvalRouter.adminDecisionHash,
        report.adminAgent.adminDecisionHash);
      for (const laterHash of [
        report.accountability.postShadowTraceHash,
        report.accountability.postGovernanceTraceHash,
        report.accountability.postAdminTraceHash,
        report.accountability.postRouterTraceHash
      ]) assert.notEqual(report.approvalRouter.traceHash, laterHash);
    });

    check("W.6 reports contain bounded evidence and no Shadow raw output or environment values", () => {
      const ledgerJson = JSON.stringify(report.accountability.ledger);
      const traceJson = JSON.stringify({
        pre: report.accountability.preShadowTrace,
        postShadow: report.accountability.postShadowTrace,
        postGovernance: report.accountability.postGovernanceTrace,
        postAdmin: report.accountability.postAdminTrace,
        postRouter: report.accountability.postRouterTrace,
        router: report.approvalRouter.assessment
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
      assert.ok(!reportJson.includes("helperReady"));
      assert.ok(!reportJson.includes("return value + 1"));
      assert.ok(!markdown.includes(endpoint));
      assert.ok(!markdown.includes("WORKER_MODEL_SENTINEL"));
      assert.ok(!markdown.includes(shadowCompletion));
      assert.ok(!markdown.includes("helperReady"));
      assert.ok(!markdown.includes("return value + 1"));
      assert.ok(markdown.includes("## Agent Event Ledger"));
      assert.ok(markdown.includes("## Accountability Trace"));
      assert.ok(markdown.includes("## Shadow Observer"));
      assert.ok(markdown.includes("## Post-Shadow Audit State"));
      assert.ok(markdown.includes("## Deterministic Governance"));
      assert.ok(markdown.includes("## Admin Agent"));
      assert.ok(markdown.includes("## Post-Governance Audit State"));
      assert.ok(markdown.includes("## Post-Admin Audit State"));
      assert.ok(markdown.includes("## Risk-Based Approval Router"));
      assert.ok(markdown.includes("## Post-Router Final Audit State"));
      assert.ok(!reportJson.includes("You are an evidence-bound Admin Agent"));
      assert.ok(!markdown.includes("You are an evidence-bound Admin Agent"));
      assert.ok(!reportJson.includes("ADMIN_MODEL_SENTINEL"));
      assert.ok(!markdown.includes("ADMIN_MODEL_SENTINEL"));
      assert.ok(!reportJson.includes("ROUTE_EXECUTION_COMMAND_SENTINEL"));
      assert.ok(!markdown.includes("ROUTE_EXECUTION_COMMAND_SENTINEL"));
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
        assert.equal(partial.governance.evaluated, false);
        assert.equal(partial.governanceStageDecision, "governance_not_evaluated");
        assert.equal(partial.governance.eventAppended, false);
        assert.equal(partial.adminAgent.called, false);
        assert.equal(partial.adminStageDecision, "admin_not_called");
        assert.equal(partial.adminAgent.eventAppended, false);
        assert.equal(partial.approvalRouter.evaluated, false);
        assert.equal(partial.approvalRouter.required, false);
        assert.equal(partial.approvalRouter.requiredSatisfied, true);
        assert.equal(partial.approvalRouterStageDecision,
          "approval_route_not_evaluated");
        assert.equal(partial.workflowRoute, null);
        assert.equal(partial.approvalRouter.eventAppended, false);
        assert.equal(partial.accountability.postRouterTrace, null);
        assert.equal(partial.accountability.eventCountAfterRouter,
          partial.accountability.ledger.eventCount);
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
        assert.equal(failed.governance.evaluated, true);
        assert.equal(failed.governance.decision, "governance_escalation_required");
        assert.equal(failed.governance.traceHash,
          failed.accountability.preShadowTraceHash);
        assert.equal(failed.governance.observationHash, null);
        assert.equal(failed.adminAgent.called, true);
        assert.equal(failed.adminAgent.decision,
          "admin_human_escalation_required");
        assert.equal(failed.accountability.postAdminLedgerVerificationDecision,
          "ledger_valid");
      }
      assert.ok(timeout.shadowObserver.issueCodes.includes("shadow_upstream_timeout"));
      assert.equal(httpFailure.status, "failed_required_shadow");
      assert.equal(timeout.status, "failed_required_shadow");
      assert.equal(reviewedShadow.workflowRoute, "human_required");
      for (const failed of [wrongRun, wrongHash, unknownEvidence, malformed, httpFailure, timeout]) {
        assert.equal(failed.approvalRouter.validationDecision, "approval_route_valid");
        assert.equal(failed.workflowRoute, "human_required");
        assert.equal(failed.approvalRouter.requiredSatisfied, true);
        assert.equal(failed.governedChangeArtifact.decision,
          "governed_change_artifact_blocked");
        assert.ok(failed.governedChangeArtifact.artifact);
        assert.equal(failed.governedChangeArtifact.artifact.evidence.observationHash, null);
        assert.equal(failed.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(failed.governedChangeFreshness.handoffEligible, false);
      }
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
      assert.equal(missingShadowConfiguration.governance.decision,
        "governance_escalation_required");
      assert.equal(missingShadowConfiguration.adminAgent.configured, false);
      assert.equal(missingShadowConfiguration.adminAgent.called, false);
      assert.equal(boundedReviewWithoutObservation.shadowObserver.decision,
        "shadow_observer_needs_review");
      assert.equal(boundedReviewWithoutObservation.shadowObserver.observation, null);
      assert.equal(boundedReviewWithoutObservation.shadowObserver.eventAppended, true);
      assert.equal(boundedReviewWithoutObservation.status, "failed_required_shadow");
      assert.equal(boundedReviewWithoutObservation.governance.decision,
        "governance_escalation_required");
      assert.equal(boundedReviewWithoutObservation.governance.observationHash, null);
      assert.equal(boundedReviewWithoutObservation.adminAgent.called, true);
      assert.equal(boundedReviewWithoutObservation.adminAgent.adminDecision.observationHash,
        null);
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.called, false);
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.decision,
        "shadow_observer_needs_review");
      assert.equal(boundedPreflightWithoutRequest.shadowObserver.eventAppended, false);
      assert.equal(boundedPreflightWithoutRequest.accountability.eventCountAfterShadow, 9);
      assert.equal(boundedPreflightWithoutRequest.accountability.postShadowTrace, null);
      assert.equal(boundedPreflightWithoutRequest.governance.decision,
        "governance_escalation_required");
      assert.equal(boundedPreflightWithoutRequest.governance.observationHash, null);
      assert.equal(boundedPreflightWithoutRequest.adminAgent.called, true);
      assert.equal(boundedPreflightWithoutRequest.adminAgent.adminDecision.observationHash,
        null);
      assert.equal(reviewedShadow.status, "completed");
      assert.equal(reviewedShadow.governance.observationHash,
        reviewedShadow.shadowObserver.observationHash);
      assert.equal(reviewedShadow.adminAgent.called, true);
      assert.ok(reviewedShadow.adminAgent.adminDecision);
      assert.equal(plannerInvalid.status, "completed");
    });

    const missingShadowWithAdmin = await execute({
      WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "0",
      WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: endpoint,
      WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: "ADMIN_MODEL_SENTINEL"
    });
    check("W.10 missing Shadow still governs and calls separately configured Admin with null", () => {
      assert.equal(missingShadowWithAdmin.shadowObserver.called, false);
      assert.equal(missingShadowWithAdmin.governance.decision,
        "governance_escalation_required");
      assert.equal(missingShadowWithAdmin.governance.observationHash, null);
      assert.equal(missingShadowWithAdmin.adminAgent.called, true);
      assert.equal(missingShadowWithAdmin.adminAgent.decision,
        "admin_human_escalation_required");
      assert.equal(missingShadowWithAdmin.adminAgent.adminDecision.observationHash, null);
      assert.equal(missingShadowWithAdmin.workflowRoute, "human_required");
      assert.equal(missingShadowWithAdmin.approvalRouter.requiredSatisfied, true);
      assert.equal(missingShadowWithAdmin.governedChangeArtifact.decision,
        "governed_change_artifact_blocked");
      assert.equal(missingShadowWithAdmin.governedChangeArtifact.artifact.evidence.observationHash,
        null);
      assert.equal(missingShadowWithAdmin.governedChangeFreshness.decision,
        "governed_change_current");
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
      recommendationReports.push(await execute({
        WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1"
      }));
    }
    shadowRecommendation = "continue";

    check("W.6 every Shadow recommendation remains advisory", () => {
      assert.deepEqual(
        recommendationReports.map((candidate) => candidate.shadowObserver.recommendation),
        ["continue", "request_repair", "request_replan", "escalate", "terminate"]
      );
      assert.deepEqual(
        recommendationReports.map((candidate) => candidate.governance.decision),
        [
          "governance_passed",
          "governance_repair_required",
          "governance_replan_required",
          "governance_escalation_required",
          "governance_escalation_required"
        ]
      );
      assert.deepEqual(
        recommendationReports.map((candidate) => candidate.adminAgent.decision),
        [
          "admin_auto_approved",
          "admin_repair_required",
          "admin_replan_required",
          "admin_human_escalation_required",
          "admin_human_escalation_required"
        ]
      );
      assert.deepEqual(
        recommendationReports.map((candidate) => candidate.workflowRoute),
        ["auto_continue", "repair_required", "replan_required", "human_required",
          "human_required"]
      );
      for (const [index, candidate] of recommendationReports.entries()) {
        assert.equal(candidate.finalDecision, "temp_validation_passed");
        assert.equal(candidate.approvalRouter.requiredSatisfied, true);
        assert.equal(candidate.shadowObserver.decision, "shadow_observer_completed");
        assert.equal(candidate.governedChangeArtifact.required, true);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, true);
        assert.ok(candidate.governedChangeArtifact.artifact);
        assert.equal(candidate.governedChangeArtifact.decision, index === 0
          ? "governed_change_artifact_ready"
          : "governed_change_artifact_blocked");
        assert.equal(candidate.governedChangeArtifact.applyEligible, index === 0);
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(candidate.governedChangeFreshness.handoffEligible, index === 0);
        assert.equal(candidate.controlledApplyHandoff.applicable, index === 0);
        assert.equal(candidate.controlledApplyHandoff.evaluated, index === 0);
        assert.equal(candidate.controlledApplyHandoff.decision, index === 0
          ? "controlled_apply_handoff_ready"
          : null);
        assert.equal(candidate.controlledApplyHandoffVerification.evaluated,
          index === 0);
        assert.equal(candidate.controlledApplyHandoffVerification.executionEligible,
          index === 0);
        assert.equal(candidate.controlledApplyHandoff.required, index === 0);
        assert.equal(candidate.controlledApplyHandoff.requiredSatisfied, true);
        assert.equal(candidate.status, "completed");
        assert.equal(candidate.ok, true);
      }
    });

    const precedenceValidationCommands = fixture.validationCommands;
    let phaseRepairGovernanceReplan;
    let phaseRepairGovernanceHuman;
    try {
      fixture.validationCommands = [{
        id: "w12-precedence-failure",
        executable: "node",
        args: ["-e", "process.exit(11)"],
        timeoutMs: 10000,
        expectedExitCodes: [0]
      }];
      shadowRecommendation = "request_replan";
      phaseRepairGovernanceReplan = await execute();
      shadowRecommendation = "escalate";
      phaseRepairGovernanceHuman = await execute();
    } finally {
      fixture.validationCommands = precedenceValidationCommands;
      shadowRecommendation = "continue";
    }
    adminScenario = "strong_human";
    shadowRecommendation = "request_replan";
    const governanceReplanAdminHuman = await execute();
    adminScenario = "strong_terminate";
    shadowRecommendation = "continue";
    const governancePassedAdminTerminate = await execute();
    adminScenario = "valid";
    shadowRecommendation = "continue";

    check("W.12 mixed evidence preserves explicit route precedence", () => {
      assert.equal(phaseRepairGovernanceReplan.finalDecision,
        "temp_validation_failed");
      assert.equal(phaseRepairGovernanceReplan.governance.decision,
        "governance_replan_required");
      assert.equal(phaseRepairGovernanceReplan.workflowRoute, "replan_required");
      assert.equal(phaseRepairGovernanceHuman.finalDecision,
        "temp_validation_failed");
      assert.equal(phaseRepairGovernanceHuman.governance.decision,
        "governance_escalation_required");
      assert.equal(phaseRepairGovernanceHuman.workflowRoute, "human_required");
      assert.equal(governanceReplanAdminHuman.governance.decision,
        "governance_replan_required");
      assert.equal(governanceReplanAdminHuman.adminAgent.decision,
        "admin_human_escalation_required");
      assert.equal(governanceReplanAdminHuman.workflowRoute, "human_required");
      assert.equal(governancePassedAdminTerminate.governance.decision,
        "governance_passed");
      assert.equal(governancePassedAdminTerminate.adminAgent.decision,
        "admin_run_terminated");
      assert.equal(governancePassedAdminTerminate.workflowRoute, "terminated");
      for (const candidate of [
        phaseRepairGovernanceReplan,
        phaseRepairGovernanceHuman,
        governanceReplanAdminHuman,
        governancePassedAdminTerminate
      ]) {
        assert.equal(candidate.approvalRouter.validationDecision,
          "approval_route_valid");
        assert.equal(candidate.approvalRouter.requiredSatisfied, true);
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_blocked");
        assert.ok(candidate.governedChangeArtifact.artifact);
        assert.equal(candidate.governedChangeArtifact.applyEligible, false);
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(candidate.governedChangeFreshness.handoffEligible, false);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, true);
        assert.equal(candidate.controlledApplyHandoff.applicable, false);
        assert.equal(candidate.controlledApplyHandoff.evaluated, false);
        assert.equal(candidate.controlledApplyHandoff.required, false);
        assert.equal(candidate.controlledApplyHandoff.requiredSatisfied, true);
        assert.equal(candidate.controlledApplyHandoffVerification.evaluated, false);
        assert.equal(candidate.controlledApplyHandoffVerification.executionEligible,
          false);
        assert.equal(candidate.status, "completed");
        assert.equal(candidate.ok, true);
      }
    });

    let weakenedAdminRouterReport;
    let reviewedAutoRouterReport;
    try {
      shadowRecommendation = "request_replan";
      fixture.approvalRouterInputMutation = (input, runtime) => {
        const copy = structuredClone(input);
        copy.admin.decision.decision = "admin_repair_required";
        copy.admin.decision.riskLevel = "medium";
        copy.admin.decision.riskScore = 35;
        delete copy.admin.decision.adminDecisionHash;
        copy.admin.decision.adminDecisionHash = runtime.hashCanonicalJson(
          copy.admin.decision
        );
        return copy;
      };
      weakenedAdminRouterReport = await execute();

      shadowRecommendation = "continue";
      fixture.approvalRouterInputMutation = (input) => {
        const copy = structuredClone(input);
        copy.admin.stageDecision = "admin_agent_needs_review";
        copy.admin.validationDecision = "admin_decision_needs_review";
        return copy;
      };
      reviewedAutoRouterReport = await execute();
    } finally {
      delete fixture.approvalRouterInputMutation;
      shadowRecommendation = "continue";
    }

    check("W.12 router enforces deterministic authority and defensive review", () => {
      assert.equal(weakenedAdminRouterReport.governance.decision,
        "governance_replan_required");
      assert.equal(weakenedAdminRouterReport.approvalRouter.adminDecision,
        "admin_repair_required");
      assert.equal(weakenedAdminRouterReport.approvalRouter.validationDecision,
        "approval_route_invalid");
      assert.equal(weakenedAdminRouterReport.workflowRoute, null);
      assert.equal(weakenedAdminRouterReport.approvalRouter.requiredSatisfied, false);
      assert.equal(weakenedAdminRouterReport.status,
        "failed_required_approval_router");
      assert.ok(weakenedAdminRouterReport.approvalRouter.issueCodes.includes(
        "approval_router_deterministic_authority_violation"
      ));
      assert.equal(weakenedAdminRouterReport.approvalRouter.eventAppended, true);

      assert.equal(reviewedAutoRouterReport.approvalRouter.adminStageDecision,
        "admin_agent_needs_review");
      assert.equal(reviewedAutoRouterReport.approvalRouter.adminDecision,
        "admin_auto_approved");
      assert.equal(reviewedAutoRouterReport.approvalRouter.validationDecision,
        "approval_route_valid");
      assert.equal(reviewedAutoRouterReport.workflowRoute, "human_required");
      assert.equal(reviewedAutoRouterReport.approvalRouter.requiredSatisfied, true);
      assert.equal(reviewedAutoRouterReport.status, "completed");
      assert.equal(reviewedAutoRouterReport.ok, true);
    });

    const shadowRiskReports = [];
    for (const riskLevel of ["medium", "high", "critical"]) {
      shadowRiskOverride = riskLevel;
      shadowRiskReports.push(await execute());
    }
    shadowRiskOverride = null;
    check("W.10 medium, high, and critical Shadow risk escalate without deterministic termination", () => {
      assert.deepEqual(shadowRiskReports.map((candidate) =>
        candidate.shadowObserver.riskLevel), ["medium", "high", "critical"]);
      for (const candidate of shadowRiskReports) {
        assert.equal(candidate.governance.decision,
          "governance_escalation_required");
        assert.notEqual(candidate.governance.decision, "governance_terminated");
        assert.equal(candidate.adminAgent.decision,
          "admin_human_escalation_required");
        assert.equal(candidate.finalDecision, "temp_validation_passed");
        assert.equal(candidate.workflowRoute, "human_required");
        assert.equal(candidate.approvalRouter.requiredSatisfied, true);
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
      assert.equal(failedExecution.workflowRoute, "repair_required");
      assert.equal(reviewedExecution.finalDecision, "temp_validation_needs_review");
      assert.equal(reviewedExecution.workflowRoute, "human_required");
      for (const candidate of [failedExecution, reviewedExecution]) {
        assert.equal(candidate.tempWorkspaceExecution.cleanupPerformed, true);
        assert.equal(candidate.shadowObserver.called, true);
        assert.equal(candidate.shadowObserver.decision, "shadow_observer_completed");
        assert.equal(candidate.shadowObserver.eventAppended, true);
        assert.equal(candidate.accountability.postShadowLedgerVerificationDecision,
          "ledger_valid");
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_blocked");
        assert.ok(candidate.governedChangeArtifact.artifact);
        assert.equal(candidate.governedChangeArtifact.applyEligible, false);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, true);
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(candidate.governedChangeFreshness.handoffEligible, false);
        assert.equal(candidate.controlledApplyHandoff.applicable, false);
        assert.equal(candidate.controlledApplyHandoff.evaluated, false);
        assert.equal(candidate.controlledApplyHandoff.required, false);
        assert.equal(candidate.controlledApplyHandoff.requiredSatisfied, true);
        assert.equal(candidate.controlledApplyHandoffVerification.evaluated, false);
      }
      assert.equal(failedExecution.governance.decision,
        "governance_repair_required");
      assert.equal(failedExecution.adminAgent.decision, "admin_repair_required");
      assert.equal(failedExecution.finalDecision, "temp_validation_failed");
      assert.equal(reviewedExecution.governance.decision,
        "governance_escalation_required");
      assert.equal(reviewedExecution.adminAgent.decision,
        "admin_human_escalation_required");
      assert.equal(reviewedExecution.finalDecision, "temp_validation_needs_review");
    });

    const originalCleanupEvidenceMode = fixture.cleanupEvidenceMode;
    let cleanupMissing;
    let cleanupFailed;
    let cleanupConflicting;
    try {
      fixture.cleanupEvidenceMode = "missing";
      cleanupMissing = await execute();
      fixture.cleanupEvidenceMode = "failed";
      cleanupFailed = await execute();
      fixture.cleanupEvidenceMode = "conflicting";
      cleanupConflicting = await execute();
    } finally {
      fixture.cleanupEvidenceMode = originalCleanupEvidenceMode;
    }
    check("W.10 cleanup evidence is classified without changing Phase V", () => {
      assert.deepEqual([
        cleanupMissing.governance.decision,
        cleanupFailed.governance.decision,
        cleanupConflicting.governance.decision
      ], [
        "governance_escalation_required",
        "governance_escalation_required",
        "governance_terminated"
      ]);
      assert.deepEqual([
        cleanupMissing.adminAgent.decision,
        cleanupFailed.adminAgent.decision,
        cleanupConflicting.adminAgent.decision
      ], [
        "admin_human_escalation_required",
        "admin_human_escalation_required",
        "admin_run_terminated"
      ]);
      for (const candidate of [cleanupMissing, cleanupFailed, cleanupConflicting]) {
        assert.equal(candidate.finalDecision, "temp_validation_passed");
        assert.equal(candidate.accountability.postAdminLedgerVerificationDecision,
          "ledger_valid");
      }
      assert.deepEqual([
        cleanupMissing.workflowRoute,
        cleanupFailed.workflowRoute,
        cleanupConflicting.workflowRoute
      ], ["human_required", "human_required", "terminated"]);
      for (const candidate of [cleanupMissing, cleanupFailed]) {
        assert.equal(candidate.approvalRouter.requiredSatisfied, true);
        assert.equal(candidate.governedChangeArtifact.required, true);
        assert.equal(candidate.governedChangeArtifact.requiredSatisfied, true);
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_blocked");
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(candidate.status, "completed");
        assert.equal(candidate.ok, true);
        assert.equal(candidate.accountability.ledger.events.at(-1).actor,
          "approval_router");
      }
      assert.equal(cleanupConflicting.approvalRouter.requiredSatisfied, true);
      assert.equal(cleanupConflicting.governedChangeArtifact.required, true);
      assert.equal(cleanupConflicting.governedChangeArtifact.requiredSatisfied, false);
      assert.equal(cleanupConflicting.governedChangeArtifact.decision,
        "governed_change_artifact_invalid");
      assert.equal(cleanupConflicting.status,
        "failed_required_governed_change_artifact");
      assert.equal(cleanupConflicting.ok, false);
      assert.equal(cleanupConflicting.accountability.ledger.events.at(-1).actor,
        "approval_router");
    });

    adminScenario = "weak_auto";
    const terminatedWeakening = await (async () => {
      const previous = fixture.cleanupEvidenceMode;
      try {
        fixture.cleanupEvidenceMode = "conflicting";
        return await execute();
      } finally {
        fixture.cleanupEvidenceMode = previous;
      }
    })();
    const repairWeakening = await (async () => {
      const previousCommands = fixture.validationCommands;
      try {
        fixture.validationCommands = [{
          id: "w10-repair-weakening",
          executable: "node",
          args: ["-e", "process.exit(9)"],
          timeoutMs: 10000,
          expectedExitCodes: [0]
        }];
        return await execute();
      } finally {
        fixture.validationCommands = previousCommands;
      }
    })();
    adminScenario = "weak_repair";
    shadowRecommendation = "request_replan";
    const replanWeakening = await execute();
    adminScenario = "valid";
    shadowRecommendation = "continue";

    check("W.10 deterministic authority rejects all weakening attempts but audits them", () => {
      assert.equal(terminatedWeakening.governance.decision, "governance_terminated");
      assert.equal(repairWeakening.governance.decision, "governance_repair_required");
      assert.equal(replanWeakening.governance.decision, "governance_replan_required");
      for (const candidate of [terminatedWeakening, repairWeakening, replanWeakening]) {
        assert.equal(candidate.adminAgent.adapterDecision, "admin_agent_failed");
        assert.equal(candidate.adminAgent.validationDecision, "admin_decision_invalid");
        assert.ok(candidate.adminAgent.issueCodes.includes(
          "admin_decision_validation_failed"));
        assert.equal(candidate.adminAgent.eventAppended, true);
        const adminEvent = candidate.accountability.ledger.events.find((event) =>
          event.actor === "admin_agent");
        assert.ok(adminEvent);
        assert.equal(adminEvent.decision,
          "admin_agent_failed");
        assert.equal(candidate.accountability.postAdminLedgerVerificationDecision,
          "ledger_valid");
      }
      assert.equal(terminatedWeakening.workflowRoute, "terminated");
      assert.equal(repairWeakening.workflowRoute, "human_required");
      assert.equal(replanWeakening.workflowRoute, "human_required");
    });

    adminScenario = "needs_review";
    const adminReviewed = await execute();
    adminScenario = "wrong_run";
    const adminWrongRun = await execute();
    adminScenario = "wrong_trace_hash";
    const adminWrongTrace = await execute();
    adminScenario = "wrong_observation_hash";
    const adminWrongObservation = await execute();
    adminScenario = "wrong_governance_hash";
    const adminWrongGovernance = await execute();
    adminScenario = "malformed";
    const adminMalformed = await execute();
    adminScenario = "http_failure";
    const adminHttpFailure = await execute();
    adminScenario = "timeout";
    const adminTimeout = await execute({ WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "10" });
    adminScenario = "oversized";
    const adminOversized = await execute({
      WORKER_ORCHESTRATOR_ADMIN_MAX_RESPONSE_CHARS: "1000"
    });
    adminScenario = "valid";

    check("W.10 Admin adapter outcomes are bounded and every attempted call is audited", () => {
      assert.equal(adminReviewed.adminAgent.adapterDecision,
        "admin_agent_needs_review");
      assert.equal(adminReviewed.adminAgent.validationDecision,
        "admin_decision_needs_review");
      assert.ok(adminReviewed.adminAgent.adminDecision);
      assert.equal(adminOversized.adminAgent.adapterDecision,
        "admin_agent_needs_review");
      assert.equal(adminOversized.adminAgent.adminDecision, null);
      const failed = [
        adminWrongRun, adminWrongTrace, adminWrongObservation,
        adminWrongGovernance, adminMalformed, adminHttpFailure, adminTimeout
      ];
      for (const candidate of failed) {
        assert.equal(candidate.adminAgent.adapterDecision, "admin_agent_failed");
      }
      for (const candidate of [adminReviewed, ...failed, adminOversized]) {
        assert.equal(candidate.adminAgent.called, true);
        assert.equal(candidate.adminAgent.eventAppended, true);
        assert.equal(candidate.accountability.postAdminLedgerVerificationDecision,
          "ledger_valid");
        assert.ok(candidate.accountability.ledger.events.some((event) =>
          event.actor === "admin_agent"));
        assert.equal(JSON.stringify(candidate).includes("RAW_ADMIN_COMPLETION_SENTINEL"),
          false);
      }
      assert.equal(adminReviewed.workflowRoute, "human_required");
      assert.equal(adminReviewed.approvalRouter.validationDecision,
        "approval_route_valid");
      for (const candidate of failed) {
        assert.equal(candidate.workflowRoute, "human_required");
        assert.equal(candidate.approvalRouter.validationDecision,
          "approval_route_valid");
      }
      for (const candidate of [adminReviewed, ...failed]) {
        assert.equal(candidate.governedChangeArtifact.decision,
          "governed_change_artifact_blocked");
        assert.ok(candidate.governedChangeArtifact.artifact);
        assert.equal(candidate.governedChangeFreshness.decision,
          "governed_change_current");
        assert.equal(candidate.governedChangeFreshness.handoffEligible, false);
      }
      assert.equal(adminOversized.governedChangeArtifact.evaluated, false);
      assert.equal(adminOversized.governedChangeArtifact.required, false);
      assert.equal(adminOversized.governedChangeFreshness.evaluated, false);
      assert.ok(adminMalformed.adminAgent.issueCodes.includes(
        "malformed_admin_completion_json"));
      assert.ok(adminHttpFailure.adminAgent.issueCodes.includes(
        "admin_upstream_http_error"));
      assert.ok(adminTimeout.adminAgent.issueCodes.includes("admin_upstream_timeout"));
      assert.ok(adminOversized.adminAgent.issueCodes.includes(
        "admin_response_size_limit_exceeded"));
    });

    const routerInvalidMutations = [
      (input) => {
        const copy = structuredClone(input);
        copy.phaseVFinalDecision = "temp_validation_failed";
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.trace.resources.totalTokens += 1;
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.shadow.observation.riskScore += 1;
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.governance.riskClass = "high";
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.admin.decision.riskScore += 1;
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.shadow.stageDecision = "shadow_not_called";
        return copy;
      },
      (input) => {
        const copy = structuredClone(input);
        copy.admin.stageDecision = "admin_not_called";
        return copy;
      },
      (input, runtime) => {
        const copy = structuredClone(input);
        copy.governance.observationHash = `sha256:${"a".repeat(64)}`;
        delete copy.governance.governanceHash;
        copy.governance.governanceHash = runtime.hashCanonicalJson(copy.governance);
        copy.admin.decision.governanceHash = copy.governance.governanceHash;
        delete copy.admin.decision.adminDecisionHash;
        copy.admin.decision.adminDecisionHash = runtime.hashCanonicalJson(copy.admin.decision);
        return copy;
      },
      (input, runtime) => {
        const copy = structuredClone(input);
        copy.admin.decision.governanceHash = `sha256:${"b".repeat(64)}`;
        delete copy.admin.decision.adminDecisionHash;
        copy.admin.decision.adminDecisionHash = runtime.hashCanonicalJson(copy.admin.decision);
        return copy;
      }
    ];
    const routerInvalidReports = [];
    try {
      for (const mutation of routerInvalidMutations) {
        fixture.approvalRouterInputMutation = mutation;
        routerInvalidReports.push(await execute());
      }
    } finally {
      delete fixture.approvalRouterInputMutation;
    }

    check("W.12 invalid router results are audited before required failure", () => {
      for (const candidate of routerInvalidReports) {
        assert.equal(candidate.finalDecision, "temp_validation_passed");
        assert.equal(candidate.shadowStageDecision, "shadow_observer_completed");
        assert.equal(candidate.governanceStageDecision, "governance_passed");
        assert.equal(candidate.adminStageDecision, "admin_agent_completed");
        assert.equal(candidate.approvalRouter.evaluated, true);
        assert.equal(candidate.approvalRouter.validationDecision,
          "approval_route_invalid");
        assert.equal(candidate.approvalRouter.route, null);
        assert.equal(candidate.workflowRoute, null);
        assert.equal(candidate.approvalRouter.assessment, null);
        assert.equal(candidate.approvalRouter.routeHash, null);
        assert.equal(candidate.approvalRouter.requiredSatisfied, false);
        assert.equal(candidate.status, "failed_required_approval_router");
        assert.equal(candidate.ok, false);
        assert.equal(candidate.approvalRouter.eventAppended, true);
        assert.equal(candidate.accountability.postRouterLedgerVerificationDecision,
          "ledger_valid");
        assert.ok(candidate.accountability.postRouterTrace);
        const event = candidate.accountability.ledger.events.at(-1);
        assert.equal(event.actor, "approval_router");
        assert.equal(event.action, "approval_router.evaluate");
        assert.equal(event.decision, "approval_route_invalid");
        assert.deepEqual(event.outputArtifactHashes, []);
        assert.deepEqual(event.reasonCodes, candidate.approvalRouter.issueCodes);
        assert.deepEqual(event.filesProposed, []);
        assert.ok(fs.existsSync(candidate.jsonPath));
        assert.ok(fs.existsSync(candidate.markdownPath));
        assert.deepEqual(candidate.governedChangeArtifact,
          emptyGovernedChangeArtifactReport());
        assert.deepEqual(candidate.governedChangeFreshness,
          emptyGovernedChangeFreshnessReport());
      }
    });

    let routerNeedsReview;
    try {
      fixture.approvalRouterInputMutation = (input) => {
        const copy = structuredClone(input);
        copy.governance.ruleResults = new Array(100001).fill(null);
        return copy;
      };
      routerNeedsReview = await execute();
    } finally {
      delete fixture.approvalRouterInputMutation;
    }

    check("W.12 bounded router review is audited without route execution", () => {
      assert.equal(routerNeedsReview.approvalRouter.validationDecision,
        "approval_route_needs_review");
      assert.equal(routerNeedsReview.approvalRouter.route, null);
      assert.equal(routerNeedsReview.workflowRoute, null);
      assert.equal(routerNeedsReview.approvalRouter.assessment, null);
      assert.equal(routerNeedsReview.approvalRouter.requiredSatisfied, false);
      assert.equal(routerNeedsReview.status, "failed_required_approval_router");
      assert.equal(routerNeedsReview.approvalRouter.eventAppended, true);
      assert.equal(routerNeedsReview.accountability.ledger.events.at(-1).decision,
        "approval_route_needs_review");
      assert.equal(routerNeedsReview.accountability.postRouterLedgerVerificationDecision,
        "ledger_valid");
      assert.ok(routerNeedsReview.accountability.postRouterTrace);
      assert.ok(fs.existsSync(routerNeedsReview.jsonPath));
      assert.ok(fs.existsSync(routerNeedsReview.markdownPath));
      assert.deepEqual(routerNeedsReview.governedChangeArtifact,
        emptyGovernedChangeArtifactReport());
      assert.deepEqual(routerNeedsReview.governedChangeFreshness,
        emptyGovernedChangeFreshnessReport());
    });

    const requiredValid = await execute({ WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1" });
    adminScenario = "needs_review";
    const requiredReviewed = await execute({ WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1" });
    adminScenario = "malformed";
    const requiredFailed = await execute({ WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1" });
    adminScenario = "oversized";
    const requiredNullReview = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
      WORKER_ORCHESTRATOR_ADMIN_MAX_RESPONSE_CHARS: "1000"
    });
    adminScenario = "valid";
    const requiredMissing = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
      WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: ""
    });
    const requiredNotCalled = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
      WORKER_ORCHESTRATOR_ADMIN_MAX_TRACE_EVENTS: "1"
    });
    workerScenario = "planner_invalid";
    const requiredNotApplicable = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1"
    });
    workerScenario = "coder_invalid";
    const requiredCoderBlocked = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1"
    });
    workerScenario = "verifier_reject";
    const requiredVerifierBlocked = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
      WORKER_ORCHESTRATOR_FORCE_REMASK: "0"
    });
    workerScenario = "patch_noop";
    const requiredPatchBlocked = await execute({
      WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1"
    });
    workerScenario = "valid";

    check("W.10 Admin required mode distinguishes usable evidence and applicability", () => {
      for (const candidate of [requiredValid, requiredReviewed]) {
        assert.equal(candidate.adminAgent.requiredSatisfied, true);
        assert.equal(candidate.status, "completed");
        assert.ok(candidate.adminAgent.adminDecision);
      }
      for (const candidate of [
        requiredFailed, requiredNullReview, requiredMissing, requiredNotCalled
      ]) {
        assert.equal(candidate.adminAgent.requiredSatisfied, false);
        assert.equal(candidate.status, "failed_required_admin");
        assert.equal(candidate.ok, false);
      }
      assert.equal(requiredMissing.adminAgent.configured, false);
      assert.equal(requiredMissing.adminAgent.called, false);
      assert.ok(requiredMissing.accountability.ledger.events.some((event) =>
        event.actor === "deterministic_governor"));
      assert.equal(requiredMissing.accountability.ledger.events.at(-1).actor,
        "approval_router");
      assert.equal(requiredMissing.approvalRouter.validationDecision,
        "approval_route_valid");
      assert.equal(requiredMissing.workflowRoute, "human_required");
      assert.equal(requiredMissing.approvalRouter.requiredSatisfied, true);
      assert.ok(requiredMissing.accountability.postGovernanceTrace);
      assert.equal(requiredMissing.accountability.postAdminTrace, null);
      assert.equal(requiredNotCalled.adminAgent.called, false);
      assert.equal(requiredNotCalled.adminAgent.adapterDecision,
        "admin_agent_needs_review");
      assert.equal(requiredNotCalled.adminAgent.eventAppended, false);
      for (const candidate of [
        requiredNotApplicable, requiredCoderBlocked,
        requiredVerifierBlocked, requiredPatchBlocked
      ]) {
        assert.equal(candidate.governance.evaluated, false);
        assert.equal(candidate.adminAgent.called, false);
        assert.equal(candidate.adminAgent.requiredSatisfied, true);
        assert.equal(candidate.status, "completed");
      }
      assert.equal(requiredPatchBlocked.patchDryRun.called, true);
      assert.equal(requiredPatchBlocked.tempWorkspaceExecution.called, false);
    });
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

runExecutionIntegrationChecks()
  .then(runW16ConfigurationChecks)
  .then(runW6IntegrationChecks)
  .then(() => {
    console.log("worker-backed orchestrator smoke test passed");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
