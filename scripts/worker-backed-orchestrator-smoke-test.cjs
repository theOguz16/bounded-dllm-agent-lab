const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "worker-backed-orchestrator-smoke.cjs");
const {
  buildForcedRemaskVerifierResult,
  decide,
  emptyRemaskReport,
  emptyPatchDryRunReport,
  emptyRepairVerifierReport
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
    encoding: "utf8"
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
});

check("skipped report has suiteName phase-p-worker-backed-orchestrator-smoke", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-backed-orchestrator-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.configured, false);
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
    cleanedUp: true
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
  assert.equal(decision.tempWorkspaceApplyCleanedUp, true);
});

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

check("forced remask mode can reach temp_apply_ready", () => {
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
      tempWorkspaceApply: tempApplyDecisionFixture("temp_apply_ready")
    }
  );

  assert.equal(decision.finalDecision, "temp_apply_ready");
  assert.equal(decision.tempWorkspaceApplyCleanedUp, true);
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
});

console.log("worker-backed orchestrator smoke test passed");
