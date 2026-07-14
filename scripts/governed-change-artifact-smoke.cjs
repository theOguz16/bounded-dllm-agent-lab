#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    GOVERNED_CHANGE_ARTIFACT_VERSION,
    appendAgentEvent,
    buildGovernedChangeArtifact,
    buildRunAccountabilityTrace,
    evaluateDeterministicGovernance,
    evaluateRiskBasedApprovalRoute,
    hashCanonicalJson,
    validateAdminDecision,
    validateShadowObservation,
    verifyGovernedChangeArtifactFreshness
  } = runtime;

  const checks = [];
  function check(name, operation) {
    operation();
    checks.push(name);
    console.log(`[ok] ${name}`);
  }

  const hash = (label) => hashCanonicalJson({ label });
  const clone = (value) => structuredClone(value);
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const time = (sequence) => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();

  function draft(sequence, actor, action, options = {}) {
    return {
      actor,
      action,
      startedAt: time(sequence),
      finishedAt: time(sequence + 1),
      inputArtifactHashes: options.inputs ?? [],
      outputArtifactHashes: options.outputs ?? [],
      filesRead: options.filesRead ?? [],
      filesProposed: options.filesProposed ?? [],
      decision: options.decision ?? null,
      reasonCodes: options.reasonCodes ?? []
    };
  }

  function appendAll(ledger, drafts) {
    return drafts.reduce((current, event) => appendAgentEvent(current, event), ledger);
  }

  function adminDraft(trace, observation, governance, decision, options = {}) {
    const profiles = {
      admin_auto_approved: ["low", 10],
      admin_repair_required: ["medium", 35],
      admin_replan_required: ["medium", 35],
      admin_human_escalation_required: ["high", 60],
      admin_run_terminated: ["critical", 90]
    };
    const [defaultRisk, defaultScore] = profiles[decision];
    const riskLevel = options.riskLevel ?? defaultRisk;
    const riskScore = options.riskScore ?? defaultScore;
    const findingNeeded = decision !== "admin_auto_approved";
    const ruleForDecision = {
      admin_repair_required: "execution_outcome",
      admin_replan_required: "planned_scope_consistency"
    }[decision];
    const governanceRuleId = governance.triggeredRuleIds[0] ?? ruleForDecision;
    const finding = {
      code: "bounded_admin_finding",
      severity: decision === "admin_run_terminated" || riskLevel === "critical"
        ? "critical"
        : decision === "admin_human_escalation_required"
          ? "high"
          : "warning",
      message: "RAW_ADMIN_COMPLETION_SENTINEL",
      governanceRuleIds: governanceRuleId ? [governanceRuleId] : [],
      governanceReasonCodes: governance.reasonCodes.slice(0, 1),
      governanceIssueCodes: governance.issues.slice(0, 1).map((issue) => issue.code),
      traceFindingCodes: [],
      shadowFindingCodes: [],
      evidenceEventIds: [trace.events[0].eventId],
      evidenceFilePaths: trace.files.allProposedFiles.slice(0, 1)
    };
    return {
      decisionVersion: "1",
      runId: trace.runId,
      traceHash: trace.traceHash,
      observationHash: observation?.observationHash ?? null,
      governanceHash: governance.governanceHash,
      decision,
      riskLevel,
      riskScore,
      confidenceScore: 90,
      findings: findingNeeded ? [finding] : [],
      rationaleCodes: ["bounded_admin_evidence"]
    };
  }

  function semanticForGovernance(decision) {
    return {
      governance_passed: "admin_auto_approved",
      governance_repair_required: "admin_repair_required",
      governance_replan_required: "admin_replan_required",
      governance_escalation_required: "admin_human_escalation_required",
      governance_terminated: "admin_run_terminated"
    }[decision];
  }

  function makeFixture(options = {}) {
    const seed = options.seed ?? "clean";
    const runId = options.runId ?? `governed-${seed}`;
    const objectiveHash = hash(`${seed}:objective`);
    const changedFiles = options.changedFiles ?? ["src/a.ts"];
    const plannerFiles = options.plannerFiles ?? changedFiles;
    const changeKind = options.changeKind ?? "repair_draft";
    const phaseVFinalDecision = options.phaseVFinalDecision ?? "temp_validation_passed";
    const planHash = hash(`${seed}:plan`);
    const coderHash = hash(`${seed}:coder-mutation`);
    const verifierHash = hash(`${seed}:verifier`);
    const remaskHash = hash(`${seed}:remask`);
    const mutationHash = options.mutationHash ?? (changeKind === "repair_draft"
      ? hash(`${seed}:repair-mutation`)
      : coderHash);
    const repairVerifierHash = hash(`${seed}:repair-verifier`);
    const patchDryRunResultHash = options.patchDryRunResultHash ?? hash(`${seed}:patch-dry-run`);
    const temporaryApplyResultHash = options.temporaryApplyResultHash ?? hash(`${seed}:temp-apply`);
    const executionVerificationResultHash = options.executionVerificationResultHash ??
      hash(`${seed}:execution`);
    const cleanupCodes = options.cleanupCodes ?? ["temp_workspace_cleanup_performed"];

    let sequence = 0;
    const next = (actor, action, eventOptions) =>
      draft(sequence += 2, actor, action, eventOptions);
    const drafts = [
      next("planner", "planner.plan", {
        outputs: [planHash],
        filesProposed: plannerFiles,
        decision: "plan_ready"
      }),
      next("coder", "coder.patch_draft", {
        inputs: [planHash],
        outputs: [coderHash],
        filesRead: changedFiles,
        filesProposed: options.sourceFiles ?? changedFiles,
        decision: "patch_draft_ready"
      }),
      next("deterministic_verifier", "deterministic_verifier.evaluate", {
        inputs: [coderHash],
        outputs: [verifierHash],
        filesRead: changedFiles,
        decision: "approve"
      })
    ];
    if (changeKind === "repair_draft") {
      drafts.push(
        next("masker", "masker.remask", {
          inputs: [coderHash],
          outputs: [remaskHash],
          filesRead: changedFiles,
          decision: "remask_ready"
        }),
        next("repairer", "repairer.repair_draft", {
          inputs: [remaskHash],
          outputs: [mutationHash],
          filesRead: changedFiles,
          filesProposed: options.sourceFiles ?? changedFiles,
          decision: "repair_draft_ready"
        }),
        next("repair_verifier", "repair_verifier.evaluate", {
          inputs: [mutationHash],
          outputs: [repairVerifierHash],
          filesRead: changedFiles,
          decision: "approve"
        })
      );
    }
    drafts.push(
      next("patch_dry_run", "patch_dry_run.evaluate", {
        inputs: [mutationHash],
        outputs: [patchDryRunResultHash],
        filesRead: changedFiles,
        filesProposed: changedFiles,
        decision: "ready_to_apply"
      }),
      next("temp_workspace_apply", "temp_workspace_apply.apply", {
        inputs: [patchDryRunResultHash],
        outputs: [temporaryApplyResultHash],
        filesRead: changedFiles,
        filesProposed: options.applyFiles ?? changedFiles,
        decision: "temp_apply_ready"
      }),
      next("execution_verifier", "execution_verifier.validate", {
        inputs: [temporaryApplyResultHash],
        outputs: [executionVerificationResultHash],
        filesRead: changedFiles,
        decision: phaseVFinalDecision,
        reasonCodes: cleanupCodes
      })
    );
    if (options.duplicateMutationSource) {
      drafts.splice(2, 0, next(
        changeKind === "repair_draft" ? "repairer" : "coder",
        changeKind === "repair_draft" ? "repairer.repair_draft" : "coder.patch_draft",
        { outputs: [mutationHash], filesProposed: changedFiles, decision: "duplicate" }
      ));
    }
    options.mutatePreDrafts?.(drafts, {
      mutationHash,
      patchDryRunResultHash,
      temporaryApplyResultHash,
      executionVerificationResultHash
    });

    let preLedger = runtime.createAgentEventLedger({ runId, objectiveHash });
    preLedger = appendAll(preLedger, drafts);
    const traceResult = buildRunAccountabilityTrace(preLedger, {
      expectedRunId: runId,
      expectedObjectiveHash: objectiveHash,
      expectedRootHash: preLedger.rootHash,
      expectedEventCount: preLedger.eventCount
    });
    assert.ok(traceResult.trace, JSON.stringify(traceResult));
    let trace = traceResult.trace;
    if (options.mutateTrace) {
      trace = clone(trace);
      options.mutateTrace(trace);
      delete trace.traceHash;
      trace.traceHash = hashCanonicalJson(trace);
    }

    let observation = null;
    if (options.shadowMode !== "null") {
      const traceHasError = trace.findings.some((finding) => finding.severity === "error");
      const traceHasWarning = trace.findings.some((finding) => finding.severity === "warning");
      const shadowRisk = options.shadowRisk ??
        (traceHasError ? "high" : traceHasWarning ? "medium" : "low");
      const citedTraceError = trace.findings.find((finding) => finding.severity === "error");
      const shadowFindings = citedTraceError ? [{
        code: "bounded_trace_risk",
        severity: "high",
        message: "Bounded trace risk evidence.",
        evidenceEventIds: [],
        evidenceFilePaths: [],
        evidenceTraceFindingCodes: [citedTraceError.code]
      }] : [];
      const observationResult = validateShadowObservation(trace, {
        observationVersion: "1",
        runId,
        traceHash: trace.traceHash,
        riskLevel: shadowRisk,
        riskScore: shadowRisk === "medium" ? 35
          : shadowRisk === "high" ? 60
            : shadowRisk === "critical" ? 90 : 10,
        confidenceScore: 90,
        findings: shadowFindings,
        observedScopeDrift: false,
        observedPlanPatchMismatch: false,
        observedRepairLoop: false,
        observedSuspiciousRoleBehavior: false,
        observedEvidenceConflict: false,
        recommendation: options.shadowRecommendation ??
          (traceHasError ? "request_replan" : "continue"),
        rationaleCodes: ["bounded_shadow_evidence"]
      });
      assert.equal(observationResult.decision, "shadow_observation_valid", JSON.stringify(observationResult));
      observation = observationResult.observation;
    }

    const governanceResult = evaluateDeterministicGovernance(
      trace,
      observation,
      options.governancePolicy
    );
    assert.ok(governanceResult.assessment, JSON.stringify(governanceResult));
    const governance = governanceResult.assessment;

    let admin = null;
    if (options.adminMode !== "null") {
      const adminSemantic = options.adminSemantic ?? semanticForGovernance(governance.decision);
      const adminResult = validateAdminDecision(
        trace,
        observation,
        governance,
        adminDraft(trace, observation, governance, adminSemantic, options.adminRisk ?? {})
      );
      assert.equal(adminResult.decision, "admin_decision_valid", JSON.stringify(adminResult));
      admin = adminResult.adminDecision;
    }

    const shadowStageDecision = options.shadowStageDecision ??
      (observation === null ? "shadow_not_called" : "shadow_observer_completed");
    const shadowValidationDecision = has(options, "shadowValidationDecision")
      ? options.shadowValidationDecision
      : observation === null ? null : "shadow_observation_valid";
    const adminStageDecision = options.adminStageDecision ??
      (admin === null ? "admin_not_called" : "admin_agent_completed");
    const adminValidationDecision = has(options, "adminValidationDecision")
      ? options.adminValidationDecision
      : admin === null ? null : "admin_decision_valid";
    const routerResult = evaluateRiskBasedApprovalRoute({
      phaseVFinalDecision,
      trace,
      shadow: {
        stageDecision: shadowStageDecision,
        validationDecision: shadowValidationDecision,
        observation
      },
      governance,
      admin: {
        stageDecision: adminStageDecision,
        validationDecision: adminValidationDecision,
        decision: admin
      }
    }, options.routerPolicy);
    assert.equal(routerResult.decision, "approval_route_valid", JSON.stringify(routerResult));
    const router = routerResult.assessment;

    const auditDrafts = [];
    if (observation !== null || options.includeFailedShadowEvent) {
      auditDrafts.push(next("shadow_observer", "shadow_observer.observe", {
        inputs: [trace.traceHash],
        outputs: observation ? [observation.observationHash] : [],
        filesRead: trace.files.allProposedFiles,
        decision: shadowStageDecision
      }));
    }
    auditDrafts.push(next("deterministic_governor", "deterministic_governor.evaluate", {
      inputs: [
        trace.traceHash,
        governance.policyHash,
        ...(observation ? [observation.observationHash] : [])
      ],
      outputs: [governance.governanceHash],
      filesRead: trace.files.allProposedFiles,
      decision: governance.decision,
      reasonCodes: governance.reasonCodes
    }));
    if (admin !== null || options.includeFailedAdminEvent) {
      auditDrafts.push(next("admin_agent", "admin_agent.evaluate", {
        inputs: [
          trace.traceHash,
          governance.governanceHash,
          ...(observation ? [observation.observationHash] : [])
        ],
        outputs: admin ? [admin.adminDecisionHash] : [],
        filesRead: trace.files.allProposedFiles,
        decision: admin?.decision ?? adminStageDecision
      }));
    }
    auditDrafts.push(next("approval_router", "approval_router.evaluate", {
      inputs: [
        trace.traceHash,
        governance.governanceHash,
        router.policyHash,
        ...(observation ? [observation.observationHash] : []),
        ...(admin ? [admin.adminDecisionHash] : [])
      ],
      outputs: [router.routeHash],
      filesRead: trace.files.allProposedFiles,
      decision: router.route,
      reasonCodes: router.reasonCodes
    }));
    options.mutateAuditDrafts?.(auditDrafts, {
      trace,
      observation,
      governance,
      admin,
      router
    });
    let finalLedger = appendAll(preLedger, auditDrafts);
    if (options.appendAfterRouter) {
      finalLedger = appendAgentEvent(finalLedger, next("planner", "planner.after_router", {
        decision: "unexpected"
      }));
    }

    const input = {
      finalLedger,
      finalLedgerAnchors: {
        expectedRunId: runId,
        expectedObjectiveHash: objectiveHash,
        expectedRootHash: finalLedger.rootHash,
        expectedEventCount: finalLedger.eventCount
      },
      preShadowTrace: trace,
      shadowObservation: observation,
      governanceAssessment: governance,
      adminDecision: admin,
      approvalRouterAssessment: router,
      change: {
        changeKind,
        mutationHash,
        changedFiles: options.suppliedFiles ?? changedFiles,
        patchDryRunResultHash,
        temporaryApplyResultHash,
        executionVerificationResultHash
      }
    };
    return {
      input,
      finalLedger,
      preLedger,
      trace,
      observation,
      governance,
      admin,
      router,
      hashes: {
        mutationHash,
        patchDryRunResultHash,
        temporaryApplyResultHash,
        executionVerificationResultHash
      }
    };
  }

  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash: artifact.change.executionVerificationResultHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash,
      governanceHash: artifact.evidence.governanceHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash,
      routeHash: artifact.evidence.routeHash,
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }

  const clean = makeFixture();
  const cleanInputBefore = clone(clean.input);
  const cleanResult = buildGovernedChangeArtifact(clean.input);

  check("clean auto-continue evidence builds a ready governed artifact", () => {
    assert.equal(GOVERNED_CHANGE_ARTIFACT_VERSION, "1");
    assert.equal(cleanResult.decision, "governed_change_artifact_ready");
    assert.ok(cleanResult.artifact);
    assert.equal(cleanResult.artifact.applyEligibility.eligible, true);
    assert.deepEqual(cleanResult.artifact.applyEligibility.reasonCodes, []);
    assert.match(cleanResult.artifact.governedArtifactHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(cleanResult.summary.finalLedgerValid, true);
    assert.equal(cleanResult.summary.finalLedgerAnchored, true);
    assert.equal(cleanResult.summary.preShadowPrefixVerified, true);
    assert.equal(cleanResult.summary.preShadowTraceIntegrityVerified, true);
    assert.equal(cleanResult.summary.shadowObservationVerified, true);
    assert.equal(cleanResult.summary.governanceVerified, true);
    assert.equal(cleanResult.summary.adminDecisionVerified, true);
    assert.equal(cleanResult.summary.routerAssessmentVerified, true);
    assert.equal(cleanResult.summary.mutationSourceVerified, true);
    assert.equal(cleanResult.summary.patchDryRunChainVerified, true);
    assert.equal(cleanResult.summary.temporaryApplyChainVerified, true);
    assert.equal(cleanResult.summary.executionVerificationChainVerified, true);
    assert.equal(cleanResult.summary.changedFilesMatchedMutation, true);
    assert.equal(cleanResult.summary.changedFilesMatchedTemporaryApply, true);
    assert.equal(cleanResult.summary.changedFilesMatchedTrace, true);
    assert.equal(cleanResult.summary.cleanupSuccessObserved, true);
    assert.equal(cleanResult.summary.cleanupFailureObserved, false);
    assert.equal(cleanResult.summary.governedArtifactHashValid, true);
  });

  check("clean repair artifact derives every exact stage event binding", () => {
    const artifact = cleanResult.artifact;
    assert.deepEqual(clean.finalLedger.events.map((event) => event.actor), [
      "planner", "coder", "deterministic_verifier", "masker", "repairer",
      "repair_verifier", "patch_dry_run", "temp_workspace_apply",
      "execution_verifier", "shadow_observer", "deterministic_governor",
      "admin_agent", "approval_router"
    ]);
    assert.deepEqual(
      Object.values(artifact.change.stageEvents).filter(Boolean),
      clean.finalLedger.events.slice(-5).map((event) => event.eventId).length > 0
        ? [
            clean.preLedger.events.find((event) => event.actor === "repairer").eventId,
            clean.preLedger.events.find((event) => event.actor === "patch_dry_run").eventId,
            clean.preLedger.events.find((event) => event.actor === "temp_workspace_apply").eventId,
            clean.preLedger.events.find((event) => event.actor === "execution_verifier").eventId,
            clean.finalLedger.events.find((event) => event.actor === "shadow_observer").eventId,
            clean.finalLedger.events.find((event) => event.actor === "deterministic_governor").eventId,
            clean.finalLedger.events.find((event) => event.actor === "admin_agent").eventId,
            clean.finalLedger.events.at(-1).eventId
          ]
        : []
    );
    assert.equal(clean.finalLedger.events.at(-1).actor, "approval_router");
    assert.equal(clean.finalLedger.rootHash, clean.finalLedger.events.at(-1).eventHash);
  });

  check("artifact builder is pure and deeply freezes only returned data", () => {
    assert.deepEqual(clean.input, cleanInputBefore);
    assert.equal(Object.isFrozen(clean.input), false);
    assert.equal(Object.isFrozen(clean.input.change), false);
    assert.equal(Object.isFrozen(cleanResult), true);
    assert.equal(Object.isFrozen(cleanResult.issues), true);
    assert.equal(Object.isFrozen(cleanResult.summary), true);
    assert.equal(Object.isFrozen(cleanResult.artifact), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.change), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.change.changedFiles), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.change.stageEvents), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.evidence), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.decisions), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.applyEligibility), true);
    assert.equal(Object.isFrozen(cleanResult.artifact.applyEligibility.reasonCodes), true);
    const mutableInput = clone(clean.input);
    const mutableBefore = clone(mutableInput);
    const mutableResult = buildGovernedChangeArtifact(mutableInput);
    assert.equal(mutableResult.decision, "governed_change_artifact_ready");
    assert.deepEqual(mutableInput, mutableBefore);
    assert.equal(Object.isFrozen(mutableInput.finalLedger), false);
    assert.equal(Object.isFrozen(mutableInput.preShadowTrace), false);
    assert.equal(Object.isFrozen(mutableInput.shadowObservation), false);
    assert.equal(Object.isFrozen(mutableInput.governanceAssessment), false);
    assert.equal(Object.isFrozen(mutableInput.adminDecision), false);
    assert.equal(Object.isFrozen(mutableInput.approvalRouterAssessment), false);
  });

  const direct = makeFixture({ seed: "direct", changeKind: "coder_patch_draft" });
  const directResult = buildGovernedChangeArtifact(direct.input);
  check("direct coder path binds the coder mutation source", () => {
    assert.equal(directResult.decision, "governed_change_artifact_ready");
    const sourceId = directResult.artifact.change.stageEvents.mutationSourceEventId;
    assert.equal(direct.finalLedger.events.find((event) => event.eventId === sourceId).actor, "coder");
  });

  const reordered = makeFixture({
    seed: "files-order",
    changedFiles: ["src/a.ts", "src/b.ts"],
    suppliedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"]
  });
  const reorderedResult = buildGovernedChangeArtifact(reordered.input);
  check("changed files normalize duplicates and insertion order", () => {
    assert.equal(reorderedResult.decision, "governed_change_artifact_ready");
    assert.deepEqual(reorderedResult.artifact.change.changedFiles, ["src/a.ts", "src/b.ts"]);
  });

  const blockedFixtures = [
    makeFixture({ seed: "repair-route", phaseVFinalDecision: "temp_validation_failed" }),
    makeFixture({
      seed: "replan-route",
      changedFiles: ["src/a.ts", "src/b.ts"],
      governancePolicy: {
        ...runtime.DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
        maxProposedFiles: 1
      }
    }),
    makeFixture({ seed: "human-route", phaseVFinalDecision: "temp_validation_needs_review" }),
    makeFixture({ seed: "terminate-route", changedFiles: [".git/config"] })
  ];
  const blockedResults = blockedFixtures.map((fixture) =>
    buildGovernedChangeArtifact(fixture.input));
  check("all non-auto workflow routes build immutable blocked artifacts", () => {
    assert.deepEqual(
      blockedResults.map((result) => result.artifact.decisions.workflowRoute),
      ["repair_required", "replan_required", "human_required", "terminated"]
    );
    for (const result of blockedResults) {
      assert.equal(result.decision, "governed_change_artifact_blocked");
      assert.ok(result.artifact);
      assert.equal(result.artifact.applyEligibility.eligible, false);
      assert.ok(result.artifact.applyEligibility.reasonCodes.includes(
        "governed_change_route_not_auto_continue"
      ));
    }
  });

  const strictFixtures = [
    makeFixture({ seed: "shadow-review", shadowStageDecision: "shadow_observer_needs_review",
      shadowValidationDecision: "shadow_observation_needs_review" }),
    makeFixture({ seed: "shadow-failed", shadowMode: "null", shadowStageDecision: "shadow_observer_failed",
      shadowValidationDecision: "shadow_observation_invalid", includeFailedShadowEvent: true }),
    makeFixture({ seed: "shadow-missing", shadowMode: "null" }),
    makeFixture({ seed: "admin-review", adminStageDecision: "admin_agent_needs_review",
      adminValidationDecision: "admin_decision_needs_review" }),
    makeFixture({ seed: "admin-failed", adminMode: "null", adminStageDecision: "admin_agent_failed",
      adminValidationDecision: "admin_decision_invalid", includeFailedAdminEvent: true }),
    makeFixture({ seed: "admin-missing", adminMode: "null" }),
    makeFixture({ seed: "admin-repair", adminSemantic: "admin_repair_required" }),
    makeFixture({ seed: "admin-replan", adminSemantic: "admin_replan_required" }),
    makeFixture({ seed: "admin-human", adminSemantic: "admin_human_escalation_required" }),
    makeFixture({ seed: "admin-terminate", adminSemantic: "admin_run_terminated" }),
    makeFixture({ seed: "cleanup-missing", cleanupCodes: [] }),
    makeFixture({ seed: "cleanup-failed", cleanupCodes: ["temp_workspace_cleanup_failed"] })
  ];
  check("valid non-permissive prerequisites remain blocked rather than invalid", () => {
    for (const fixture of strictFixtures) {
      const result = buildGovernedChangeArtifact(fixture.input);
      assert.equal(result.decision, "governed_change_artifact_blocked", JSON.stringify(result));
      assert.ok(result.artifact);
      assert.equal(result.artifact.applyEligibility.eligible, false);
    }
    assert.ok(strictFixtures.some((fixture) => fixture.router.riskClass === "medium"));
    assert.ok(strictFixtures.some((fixture) => fixture.router.riskClass === "high"));
    assert.ok(strictFixtures.some((fixture) => fixture.router.riskClass === "critical"));
    assert.deepEqual(
      blockedResults.map((result) => result.artifact.evidence.routerPolicyHash)
        .every((value) => /^sha256:[0-9a-f]{64}$/.test(value)),
      true
    );
    assert.deepEqual(
      blockedResults.map((result) => result.artifact.decisions.workflowRoute),
      ["repair_required", "replan_required", "human_required", "terminated"]
    );
    assert.deepEqual(
      blockedFixtures.map((fixture) => fixture.router.riskClass),
      ["high", "high", "high", "critical"]
    );
    for (const result of blockedResults) {
      assert.ok(result.artifact.applyEligibility.reasonCodes.includes(
        "governed_change_governance_not_passed"
      ));
      assert.ok(result.artifact.applyEligibility.reasonCodes.includes(
        "governed_change_governance_has_triggered_rules"
      ));
      assert.ok(result.artifact.applyEligibility.reasonCodes.includes(
        "governed_change_governance_has_issues"
      ));
    }
  });

  check("failed Shadow and Admin attempts may retain bounded completion hashes", () => {
    const shadowContentHash = hash("failed-shadow-content");
    const adminContentHash = hash("failed-admin-content");
    const fixture = makeFixture({
      seed: "failed-attempt-content-hashes",
      shadowMode: "null",
      shadowStageDecision: "shadow_observer_failed",
      shadowValidationDecision: "shadow_observation_invalid",
      includeFailedShadowEvent: true,
      adminMode: "null",
      adminStageDecision: "admin_agent_failed",
      adminValidationDecision: "admin_decision_invalid",
      includeFailedAdminEvent: true,
      mutateAuditDrafts(events) {
        events.find((event) => event.actor === "shadow_observer")
          .outputArtifactHashes = [shadowContentHash];
        events.find((event) => event.actor === "admin_agent")
          .outputArtifactHashes = [adminContentHash];
      }
    });
    const result = buildGovernedChangeArtifact(fixture.input);
    assert.equal(result.decision, "governed_change_artifact_blocked", JSON.stringify(result));
    assert.ok(result.artifact.change.stageEvents.shadowObserverEventId);
    assert.ok(result.artifact.change.stageEvents.adminAgentEventId);
  });

  check("cleanup absence and failure produce exact blocked evidence", () => {
    const missing = buildGovernedChangeArtifact(strictFixtures.at(-2).input);
    const failed = buildGovernedChangeArtifact(strictFixtures.at(-1).input);
    assert.ok(missing.artifact.applyEligibility.reasonCodes.includes(
      "governed_change_cleanup_success_missing"
    ));
    assert.ok(failed.artifact.applyEligibility.reasonCodes.includes(
      "governed_change_cleanup_failure_observed"
    ));
    assert.equal(failed.summary.cleanupFailureObserved, true);
  });

  const conflictingCleanup = makeFixture({
    seed: "cleanup-conflict",
    cleanupCodes: ["temp_workspace_cleanup_performed", "temp_workspace_cleanup_failed"]
  });
  check("contradictory cleanup evidence invalidates the artifact", () => {
    const result = buildGovernedChangeArtifact(conflictingCleanup.input);
    assert.equal(result.decision, "governed_change_artifact_invalid");
    assert.equal(result.artifact, null);
    assert.ok(result.issues.some((issue) =>
      issue.code === "governed_change_conflicting_cleanup_evidence"));
  });

  check("all four final-ledger anchors are mandatory and authoritative", () => {
    const mutations = [
      (input) => { input.finalLedgerAnchors.expectedRunId = "wrong-run"; },
      (input) => { input.finalLedgerAnchors.expectedObjectiveHash = hash("wrong-objective"); },
      (input) => { input.finalLedgerAnchors.expectedRootHash = hash("wrong-root"); },
      (input) => { input.finalLedgerAnchors.expectedEventCount -= 1; }
    ];
    for (const mutate of mutations) {
      const input = clone(clean.input);
      mutate(input);
      const result = buildGovernedChangeArtifact(input);
      assert.equal(result.decision, "governed_change_artifact_invalid");
      assert.equal(result.artifact, null);
      assert.ok(result.issues.some((issue) =>
        issue.code === "governed_change_final_ledger_anchor_mismatch"));
    }
    const replacement = makeFixture({ seed: "complete-ledger-replacement" });
    const replacedInput = clone(clean.input);
    replacedInput.finalLedger = replacement.finalLedger;
    const replacedResult = buildGovernedChangeArtifact(replacedInput);
    assert.equal(replacedResult.decision, "governed_change_artifact_invalid");
    assert.ok(replacedResult.issues.some((issue) =>
      issue.code === "governed_change_final_ledger_anchor_mismatch"));
  });

  check("pre-Shadow prefix and trace integrity mismatches invalidate", () => {
    const prefixCount = clone(clean.input);
    prefixCount.preShadowTrace.ledgerEventCount -= 1;
    assert.equal(buildGovernedChangeArtifact(prefixCount).decision,
      "governed_change_artifact_invalid");
    const prefixRoot = clone(clean.input);
    prefixRoot.preShadowTrace.ledgerRootHash = hash("wrong-prefix");
    assert.equal(buildGovernedChangeArtifact(prefixRoot).decision,
      "governed_change_artifact_invalid");
    const traceMutation = clone(clean.input);
    traceMutation.preShadowTrace.resources.totalTokens += 1;
    const result = buildGovernedChangeArtifact(traceMutation);
    assert.equal(result.decision, "governed_change_artifact_invalid");
    assert.ok(result.issues.some((issue) =>
      issue.code === "governed_change_trace_integrity_mismatch"));
    const anotherRun = makeFixture({ seed: "another-prefix" });
    const anotherTrace = clone(clean.input);
    anotherTrace.preShadowTrace = anotherRun.trace;
    assert.ok(buildGovernedChangeArtifact(anotherTrace).issues.some((issue) =>
      issue.code === "governed_change_pre_shadow_prefix_mismatch"));
  });

  check("Shadow, governance, Admin, and router reproduction reject mutations", () => {
    const cases = [
      ["shadowObservation", (value) => { value.riskScore += 1; }],
      ["governanceAssessment", (value) => { value.reasonCodes.push("mutated"); }],
      ["governanceAssessment", (value) => { value.ruleResults[0].triggered = true; }],
      ["governanceAssessment", (value) => { value.policy.maxProposedFiles -= 1; }],
      ["adminDecision", (value) => { value.riskScore += 1; }],
      ["adminDecision", (value) => { value.findings.push({}); }],
      ["adminDecision", (value) => { value.governanceHash = hash("other-governance"); }],
      ["approvalRouterAssessment", (value) => { value.route = "human_required"; }],
      ["approvalRouterAssessment", (value) => { value.triggeredRuleIds.push("mutated"); }],
      ["approvalRouterAssessment", (value) => {
        value.shadowStageDecision = "shadow_observer_needs_review";
      }],
      ["approvalRouterAssessment", (value) => {
        value.shadowValidationDecision = "shadow_observation_needs_review";
      }],
      ["approvalRouterAssessment", (value) => {
        value.policy.routeShadowFailureToHuman = false;
      }],
      ["approvalRouterAssessment", (value) => { value.routeHash = hash("wrong-route"); }]
    ];
    for (const [field, mutate] of cases) {
      const input = clone(clean.input);
      mutate(input[field]);
      const result = buildGovernedChangeArtifact(input);
      assert.equal(result.decision, "governed_change_artifact_invalid", field);
      assert.equal(result.artifact, null);
    }
  });

  check("null and non-null Shadow/Admin expectations cannot be crossed", () => {
    const missingShadow = clone(clean.input);
    missingShadow.shadowObservation = null;
    assert.equal(buildGovernedChangeArtifact(missingShadow).decision,
      "governed_change_artifact_invalid");
    const nullShadowFixture = makeFixture({ seed: "null-shadow-binding", shadowMode: "null" });
    const unexpectedShadow = clone(nullShadowFixture.input);
    unexpectedShadow.shadowObservation = clean.observation;
    assert.equal(buildGovernedChangeArtifact(unexpectedShadow).decision,
      "governed_change_artifact_invalid");
    const missingAdmin = clone(clean.input);
    missingAdmin.adminDecision = null;
    assert.equal(buildGovernedChangeArtifact(missingAdmin).decision,
      "governed_change_artifact_invalid");
    const reviewObservation = clone(clean.observation);
    reviewObservation.observationVersion = "2";
    delete reviewObservation.observationHash;
    reviewObservation.observationHash = hashCanonicalJson(reviewObservation);
    const reviewInput = clone(clean.input);
    reviewInput.shadowObservation = reviewObservation;
    assert.ok(buildGovernedChangeArtifact(reviewInput).issues.some((issue) =>
      issue.code === "governed_change_shadow_verification_failed"));
  });

  const chainCases = [
    ["source-missing", (drafts, values) => {
      const source = drafts.find((event) => event.actor === "repairer");
      source.outputArtifactHashes = [hash("other-source")];
    }, "governed_change_mutation_hash_mismatch"],
    ["patch-input", (drafts) => {
      drafts.find((event) => event.actor === "patch_dry_run").inputArtifactHashes = [];
    }, "governed_change_patch_dry_run_chain_mismatch"],
    ["patch-output", (drafts) => {
      drafts.find((event) => event.actor === "patch_dry_run").outputArtifactHashes = [];
    }, "governed_change_patch_dry_run_chain_mismatch"],
    ["apply-input", (drafts) => {
      drafts.find((event) => event.actor === "temp_workspace_apply").inputArtifactHashes = [];
    }, "governed_change_temporary_apply_chain_mismatch"],
    ["apply-output", (drafts) => {
      drafts.find((event) => event.actor === "temp_workspace_apply").outputArtifactHashes = [];
    }, "governed_change_temporary_apply_chain_mismatch"],
    ["execution-input", (drafts) => {
      drafts.find((event) => event.actor === "execution_verifier").inputArtifactHashes = [];
    }, "governed_change_execution_chain_mismatch"],
    ["execution-output", (drafts) => {
      drafts.find((event) => event.actor === "execution_verifier").outputArtifactHashes = [];
    }, "governed_change_execution_chain_mismatch"]
  ];
  check("every mutation-chain link is independently required", () => {
    for (const [seed, mutatePreDrafts, code] of chainCases) {
      const fixture = makeFixture({ seed, mutatePreDrafts });
      const result = buildGovernedChangeArtifact(fixture.input);
      assert.equal(result.decision, "governed_change_artifact_invalid", seed);
      assert.ok(result.issues.some((issue) => issue.code === code), seed);
    }
    const ambiguous = makeFixture({ seed: "ambiguous-source", duplicateMutationSource: true });
    const ambiguousResult = buildGovernedChangeArtifact(ambiguous.input);
    assert.ok(ambiguousResult.issues.some((issue) =>
      issue.code === "governed_change_mutation_source_ambiguous"));
    const outOfOrder = makeFixture({
      seed: "out-of-order-chain",
      mutatePreDrafts(drafts) {
        const patchIndex = drafts.findIndex((event) => event.actor === "patch_dry_run");
        const patch = drafts.splice(patchIndex, 1)[0];
        const repairIndex = drafts.findIndex((event) => event.actor === "repairer");
        drafts.splice(repairIndex, 0, patch);
      }
    });
    const outOfOrderResult = buildGovernedChangeArtifact(outOfOrder.input);
    assert.ok(outOfOrderResult.issues.some((issue) =>
      issue.code === "governed_change_stage_sequence_mismatch"));
  });

  check("every changed-file binding is independently required", () => {
    const source = makeFixture({ seed: "source-files", sourceFiles: ["src/b.ts"] });
    const apply = makeFixture({ seed: "apply-files", applyFiles: ["src/b.ts"] });
    const supplied = clone(clean.input);
    supplied.change.changedFiles = ["src/b.ts"];
    const results = [
      buildGovernedChangeArtifact(source.input),
      buildGovernedChangeArtifact(apply.input),
      buildGovernedChangeArtifact(supplied)
    ];
    assert.ok(results[0].issues.some((issue) =>
      issue.code === "governed_change_mutation_file_mismatch"));
    assert.ok(results[1].issues.some((issue) =>
      issue.code === "governed_change_temporary_apply_file_mismatch"));
    assert.ok(results[2].issues.some((issue) =>
      issue.code === "governed_change_mutation_file_mismatch"));
    const traceFiles = makeFixture({
      seed: "trace-files",
      mutateTrace(trace) {
        trace.files.temporaryAppliedFiles = ["src/b.ts"];
      }
    });
    assert.ok(buildGovernedChangeArtifact(traceFiles.input).issues.some((issue) =>
      issue.code === "governed_change_trace_file_mismatch"));
  });

  check("suspicious exact paths are preserved in blocked artifacts", () => {
    const result = blockedResults.at(-1);
    assert.deepEqual(result.artifact.change.changedFiles, [".git/config"]);
    assert.equal(result.artifact.decisions.workflowRoute, "terminated");
  });

  const auditCases = [
    ["shadow-output", (events) => {
      events.find((event) => event.actor === "shadow_observer").outputArtifactHashes = [];
    }, "governed_change_shadow_event_binding_mismatch"],
    ["governor-output", (events) => {
      events.find((event) => event.actor === "deterministic_governor").outputArtifactHashes = [];
    }, "governed_change_governor_event_binding_mismatch"],
    ["admin-output", (events) => {
      events.find((event) => event.actor === "admin_agent").outputArtifactHashes = [];
    }, "governed_change_admin_event_binding_mismatch"],
    ["router-output", (events) => {
      events.find((event) => event.actor === "approval_router").outputArtifactHashes = [];
    }, "governed_change_router_event_binding_mismatch"]
  ];
  check("every final audit event must bind its exact output hash", () => {
    for (const [seed, mutateAuditDrafts, code] of auditCases) {
      const fixture = makeFixture({ seed, mutateAuditDrafts });
      const result = buildGovernedChangeArtifact(fixture.input);
      assert.equal(result.decision, "governed_change_artifact_invalid");
      assert.ok(result.issues.some((issue) => issue.code === code));
    }
    const extra = makeFixture({ seed: "router-not-final", appendAfterRouter: true });
    const extraResult = buildGovernedChangeArtifact(extra.input);
    assert.ok(extraResult.issues.some((issue) =>
      issue.code === "governed_change_router_event_not_final"));
  });

  check("artifact hashes are deterministic and cover every artifact field", () => {
    const repeated = buildGovernedChangeArtifact(clone(clean.input));
    assert.equal(repeated.artifact.governedArtifactHash,
      cleanResult.artifact.governedArtifactHash);
    const roundTrip = buildGovernedChangeArtifact(JSON.parse(JSON.stringify(clean.input)));
    assert.equal(roundTrip.artifact.governedArtifactHash,
      cleanResult.artifact.governedArtifactHash);
    const { governedArtifactHash, ...material } = cleanResult.artifact;
    assert.equal(hashCanonicalJson(material), governedArtifactHash);
    const changed = clone(cleanResult.artifact);
    changed.applyEligibility.reasonCodes = ["governed_change_cleanup_success_missing"];
    changed.applyEligibility.eligible = false;
    const { governedArtifactHash: ignored, ...changedMaterial } = changed;
    assert.notEqual(hashCanonicalJson(changedMaterial), governedArtifactHash);
    const variants = [
      makeFixture({ seed: "clean", mutationHash: hash("changed-mutation-only") }),
      makeFixture({ seed: "clean", changedFiles: ["src/a.ts", "src/b.ts"] }),
      makeFixture({ seed: "clean", patchDryRunResultHash: hash("changed-dry-run-only") }),
      makeFixture({ seed: "clean", executionVerificationResultHash: hash("changed-exec-only") }),
      makeFixture({ seed: "clean", shadowRisk: "medium" }),
      makeFixture({ seed: "clean", adminSemantic: "admin_repair_required" }),
      makeFixture({ seed: "clean", phaseVFinalDecision: "temp_validation_failed" }),
      makeFixture({
        seed: "clean",
        governancePolicy: {
          ...runtime.DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
          maxTotalTokens: runtime.DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY.maxTotalTokens + 1
        }
      }),
      makeFixture({
        seed: "clean",
        routerPolicy: {
          ...runtime.DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY,
          routeMissingAdminToHuman: false
        }
      }),
      makeFixture({ seed: "different-final-ledger" })
    ];
    for (const variant of variants) {
      const result = buildGovernedChangeArtifact(variant.input);
      assert.ok(result.artifact, JSON.stringify(result));
      assert.notEqual(result.artifact.governedArtifactHash, governedArtifactHash);
    }
  });

  const currentSnapshot = freshnessFrom(cleanResult.artifact);
  const current = verifyGovernedChangeArtifactFreshness(
    cleanResult.artifact,
    currentSnapshot
  );
  check("a matching ready artifact is current and handoff-eligible", () => {
    assert.equal(current.decision, "governed_change_current");
    assert.equal(current.artifactIntegrityVerified, true);
    assert.match(current.currentSnapshotHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(current.staleFields, []);
    assert.deepEqual(current.reasonCodes, []);
    assert.equal(current.handoffEligible, true);
    assert.equal(current.summary.snapshotCurrent, true);
  });

  check("a matching blocked artifact remains current but cannot hand off", () => {
    const blocked = blockedResults[0].artifact;
    const result = verifyGovernedChangeArtifactFreshness(blocked, freshnessFrom(blocked));
    assert.equal(result.decision, "governed_change_current");
    assert.equal(result.handoffEligible, false);
    assert.equal(result.summary.artifactApplyEligible, false);
  });

  const staleCases = {
    runId: ["changed-run", "governed_change_run_changed"],
    objectiveHash: [hash("changed-objective"), "governed_change_objective_changed"],
    mutationHash: [hash("changed-mutation"), "governed_change_mutation_changed"],
    changedFiles: [["src/changed.ts"], "governed_change_changed_files_changed"],
    patchDryRunResultHash: [hash("changed-dry-run"), "governed_change_patch_dry_run_changed"],
    temporaryApplyResultHash: [hash("changed-apply"), "governed_change_temporary_apply_changed"],
    executionVerificationResultHash: [hash("changed-execution"), "governed_change_execution_verification_changed"],
    preShadowTraceHash: [hash("changed-trace"), "governed_change_trace_changed"],
    observationHash: [hash("changed-observation"), "governed_change_observation_changed"],
    governanceHash: [hash("changed-governance"), "governed_change_governance_changed"],
    adminDecisionHash: [hash("changed-admin"), "governed_change_admin_decision_changed"],
    routeHash: [hash("changed-route"), "governed_change_route_changed"],
    governancePolicyHash: [hash("changed-governance-policy"), "governed_change_governance_policy_changed"],
    routerPolicyHash: [hash("changed-router-policy"), "governed_change_router_policy_changed"],
    finalLedgerRootHash: [hash("changed-ledger-root"), "governed_change_final_ledger_root_changed"],
    finalLedgerEventCount: [currentSnapshot.finalLedgerEventCount - 1, "governed_change_final_ledger_count_changed"],
    phaseVFinalDecision: ["temp_validation_failed", "governed_change_phase_v_decision_changed"],
    workflowRoute: ["human_required", "governed_change_workflow_route_changed"]
  };
  check("every freshness field has an exact stale-field and reason mapping", () => {
    for (const [field, [value, reasonCode]] of Object.entries(staleCases)) {
      const snapshot = clone(currentSnapshot);
      snapshot[field] = value;
      const result = verifyGovernedChangeArtifactFreshness(cleanResult.artifact, snapshot);
      assert.equal(result.decision, "governed_change_stale", field);
      assert.deepEqual(result.staleFields, [field]);
      assert.deepEqual(result.reasonCodes, [reasonCode]);
      assert.equal(result.handoffEligible, false);
    }
    const multiple = clone(currentSnapshot);
    multiple.workflowRoute = "human_required";
    multiple.mutationHash = hash("multiple-stale-mutation");
    multiple.runId = "multiple-stale-run";
    const multipleResult = verifyGovernedChangeArtifactFreshness(
      cleanResult.artifact,
      multiple
    );
    assert.deepEqual(multipleResult.staleFields, ["mutationHash", "runId", "workflowRoute"]);
    assert.deepEqual(multipleResult.reasonCodes, [
      "governed_change_mutation_changed",
      "governed_change_run_changed",
      "governed_change_workflow_route_changed"
    ]);
  });

  check("freshness output is deeply immutable without freezing inputs", () => {
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.staleFields), true);
    assert.equal(Object.isFrozen(current.reasonCodes), true);
    assert.equal(Object.isFrozen(current.summary), true);
    assert.equal(Object.isFrozen(currentSnapshot), false);
    assert.equal(Object.isFrozen(cleanResult.artifact), true);
    const mutableArtifact = clone(cleanResult.artifact);
    const mutableSnapshot = clone(currentSnapshot);
    verifyGovernedChangeArtifactFreshness(mutableArtifact, mutableSnapshot);
    assert.equal(Object.isFrozen(mutableArtifact), false);
    assert.equal(Object.isFrozen(mutableSnapshot), false);
  });

  check("artifact mutation without rehashing fails freshness integrity", () => {
    const artifact = clone(cleanResult.artifact);
    artifact.decisions.workflowRoute = "human_required";
    const result = verifyGovernedChangeArtifactFreshness(artifact, currentSnapshot);
    assert.equal(result.decision, "governed_change_freshness_invalid");
    assert.equal(result.artifactIntegrityVerified, false);
    assert.deepEqual(result.reasonCodes, ["governed_change_artifact_integrity_mismatch"]);
    assert.equal(result.handoffEligible, false);
    const reorderedArtifact = clone(reorderedResult.artifact);
    reorderedArtifact.change.changedFiles.reverse();
    const reorderedSnapshot = freshnessFrom(reorderedResult.artifact);
    const reorderedFreshness = verifyGovernedChangeArtifactFreshness(
      reorderedArtifact,
      reorderedSnapshot
    );
    assert.equal(reorderedFreshness.decision, "governed_change_freshness_invalid");
  });

  check("invalid current snapshots fail closed without throwing", () => {
    for (const snapshot of [null, undefined, 1, [], new Date(), new Map(), { ...currentSnapshot,
      mutationHash: "bad" }]) {
      const result = verifyGovernedChangeArtifactFreshness(cleanResult.artifact, snapshot);
      assert.equal(result.decision, "governed_change_freshness_invalid");
      assert.equal(result.artifactIntegrityVerified, true);
      assert.deepEqual(result.reasonCodes, ["governed_change_current_snapshot_invalid"]);
    }
  });

  check("malformed builder structures never throw and return null artifacts", () => {
    class Custom {}
    const cyclic = {}; cyclic.self = cyclic;
    let getterInvoked = false;
    const accessor = clone(clean.input);
    Object.defineProperty(accessor, "change", { get() {
      getterInvoked = true;
      throw new Error("getter invoked");
    } });
    const symbol = clone(clean.input); symbol[Symbol("hidden")] = true;
    const inherited = Object.create(clean.input);
    const missing = clone(clean.input); delete missing.change;
    const unknown = { ...clone(clean.input), patch: "PATCH_CONTENT_SENTINEL" };
    const unknownSecretKey = clone(clean.input);
    unknownSecretKey.API_KEY_SENTINEL = true;
    const sparse = clone(clean.input); sparse.change.changedFiles = new Array(2);
    const tooMany = clone(clean.input);
    tooMany.change.changedFiles = Array.from({ length: 1001 }, (_, index) => `src/${index}.ts`);
    const control = clone(clean.input); control.change.changedFiles = ["src/a\n.ts"];
    const malformedHash = clone(clean.input); malformedHash.change.mutationHash = "sha256:BAD";
    for (const input of [null, undefined, 1, [], new Custom(), new Date(), new Map(),
      new Set(), cyclic, accessor, symbol, inherited, missing, unknown, unknownSecretKey,
      sparse, control, malformedHash]) {
      const result = buildGovernedChangeArtifact(input);
      assert.equal(result.decision, "governed_change_artifact_invalid");
      assert.equal(result.artifact, null);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(JSON.stringify(result).includes("API_KEY_SENTINEL"), false);
    }
    assert.equal(getterInvoked, false);
    const bounded = buildGovernedChangeArtifact(tooMany);
    assert.equal(bounded.decision, "governed_change_artifact_needs_review");
    assert.equal(bounded.artifact, null);
  });

  check("artifact and results contain no raw-content sentinels", () => {
    const serialized = JSON.stringify({ cleanResult, current });
    for (const sentinel of [
      "SOURCE_CODE_SENTINEL", "PATCH_CONTENT_SENTINEL", "DIFF_CONTENT_SENTINEL",
      "OBJECTIVE_TEXT_SENTINEL", "PLANNER_PROMPT_SENTINEL", "CODER_PROMPT_SENTINEL",
      "REPAIR_PROMPT_SENTINEL", "SHADOW_PROMPT_SENTINEL", "ADMIN_PROMPT_SENTINEL",
      "RAW_SHADOW_COMPLETION_SENTINEL", "RAW_ADMIN_COMPLETION_SENTINEL",
      "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENDPOINT_SENTINEL", "API_KEY_SENTINEL",
      "ENVIRONMENT_SECRET_SENTINEL", "/tmp/temporary-workspace-sentinel"
    ]) assert.equal(serialized.includes(sentinel), false, sentinel);
  });

  check("runtime index exports the complete W.13 value API", () => {
    assert.equal(runtime.GOVERNED_CHANGE_ARTIFACT_VERSION, "1");
    assert.equal(typeof runtime.buildGovernedChangeArtifact, "function");
    assert.equal(typeof runtime.verifyGovernedChangeArtifactFreshness, "function");
  });

  assert.ok(checks.length >= 25);
  console.log(`governed change artifact smoke passed (${checks.length} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
