#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    ADMIN_INVOCATION_POLICY_VERSION,
    DEFAULT_ADMIN_INVOCATION_POLICY,
    DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
    appendAgentEvent,
    buildRunAccountabilityTrace,
    createAgentEventLedger,
    evaluateAdminInvocationPolicy,
    evaluateDeterministicGovernance,
    hashCanonicalJson,
    validateShadowObservation
  } = runtime;
  let checks = 0;
  const check = (name, operation) => {
    operation();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const objectiveHash = hashCanonicalJson({ objective: "admin-invocation" });
  const artifactHash = hashCanonicalJson({ artifact: "bounded" });

  function makeTrace(
    executionDecision = "temp_validation_passed",
    plannedFile = "src/a.ts",
    proposedFile = plannedFile
  ) {
    const plannedFiles = Array.isArray(plannedFile) ? plannedFile : [plannedFile];
    const proposedFiles = Array.isArray(proposedFile) ? proposedFile : [proposedFile];
    let ledger = createAgentEventLedger({ runId: "admin-invocation-run", objectiveHash });
    const specs = [
      ["planner", "planner.plan", [], plannedFiles, "planner_valid", []],
      ["coder", "coder.patch_draft", plannedFiles, proposedFiles, "coder_valid", []],
      ["deterministic_verifier", "deterministic_verifier.patch_draft",
        proposedFiles, [], "approve", []],
      ["temp_workspace_apply", "temp_workspace_apply.apply",
        proposedFiles, proposedFiles, "temp_apply_ready", []],
      ["execution_verifier", "execution_verifier.validate", proposedFiles, [],
        executionDecision, ["temp_workspace_cleanup_performed"]]
    ];
    const base = Date.parse("2026-07-16T08:00:00.000Z");
    for (const [index, spec] of specs.entries()) {
      ledger = appendAgentEvent(ledger, {
        actor: spec[0], action: spec[1], filesRead: spec[2], filesProposed: spec[3],
        decision: spec[4], reasonCodes: spec[5],
        startedAt: new Date(base + index * 100).toISOString(),
        finishedAt: new Date(base + index * 100 + 10).toISOString(),
        inputArtifactHashes: [artifactHash], outputArtifactHashes: [artifactHash]
      });
    }
    const result = buildRunAccountabilityTrace(ledger, {
      expectedRunId: ledger.runId,
      expectedObjectiveHash: ledger.objectiveHash,
      expectedRootHash: ledger.rootHash,
      expectedEventCount: ledger.eventCount
    });
    assert.ok(result.trace);
    return result.trace;
  }

  function observationFor(trace, options = {}) {
    const riskLevel = options.riskLevel ?? "low";
    const recommendation = options.recommendation ?? "continue";
    const draft = {
      observationVersion: "1",
      runId: trace.runId,
      traceHash: trace.traceHash,
      riskLevel,
      riskScore: options.riskScore ??
        (riskLevel === "low" ? 10 : riskLevel === "medium" ? 35 : riskLevel === "high" ? 60 : 90),
      confidenceScore: options.confidenceScore ?? 90,
      findings: options.findings ?? (riskLevel === "low" ? [] : [{
        code: "semantic_risk",
        severity: riskLevel === "medium" ? "warning" : riskLevel,
        message: "Bounded semantic risk.",
        evidenceEventIds: [trace.events[0].eventId],
        evidenceFilePaths: [],
        evidenceTraceFindingCodes: []
      }]),
      observedScopeDrift: options.observedScopeDrift ?? false,
      observedPlanPatchMismatch: false,
      observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false,
      observedEvidenceConflict: false,
      recommendation,
      rationaleCodes: ["bounded_evidence"]
    };
    const validated = validateShadowObservation(trace, draft);
    assert.ok(validated.observation, JSON.stringify(validated));
    return { observation: validated.observation, validationDecision: validated.decision };
  }

  function fixture(options = {}) {
    const trace = options.trace ?? makeTrace(options.phase);
    const shadow = options.noObservation
      ? { stageDecision: "shadow_not_called", validationDecision: null, observation: null }
      : { stageDecision: options.shadowStage ?? "shadow_observer_completed",
          ...observationFor(trace, options.observation) };
    if (Object.prototype.hasOwnProperty.call(options, "shadowValidationDecision")) {
      shadow.validationDecision = options.shadowValidationDecision;
    }
    const governance = evaluateDeterministicGovernance(
      trace,
      shadow.observation,
      options.governancePolicy
    ).assessment;
    assert.ok(governance);
    return {
      phaseVFinalDecision: options.phase ?? "temp_validation_passed",
      trace,
      shadow,
      governance
    };
  }

  const cleanInput = fixture();
  const clean = evaluateAdminInvocationPolicy(cleanInput);
  check("default conditional clean path skips Admin without synthesizing approval", () => {
    assert.equal(ADMIN_INVOCATION_POLICY_VERSION, "1");
    assert.equal(DEFAULT_ADMIN_INVOCATION_POLICY.mode, "conditional");
    assert.equal(clean.decision, "admin_invocation_policy_valid", JSON.stringify(clean));
    assert.equal(clean.assessment.decision, "admin_invocation_skipped");
    assert.equal(clean.assessment.skipKind, "clean_path");
    assert.equal(clean.assessment.autoContinueWithoutAdminEligible, true);
    assert.equal(clean.summary.cleanPath, true);
    assert.match(clean.assessment.policyHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(clean.assessment.assessmentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal("adminDecision" in clean.assessment, false);
  });

  const medium = evaluateAdminInvocationPolicy(fixture({
    observation: { riskLevel: "medium", recommendation: "request_repair" }
  }));
  check("conditional elevated Shadow evidence requires Admin", () => {
    assert.equal(medium.assessment.decision, "admin_invocation_required");
    assert.ok(medium.assessment.triggerCodes.includes("admin_invocation_shadow_risk_elevated"));
    assert.ok(medium.assessment.triggerCodes.includes(
      "admin_invocation_shadow_repair_recommendation"));
  });

  const failed = fixture({ phase: "temp_validation_failed" });
  const repair = evaluateAdminInvocationPolicy(failed);
  check("conditional governance repair requires Admin", () => {
    assert.equal(failed.governance.decision, "governance_repair_required");
    assert.equal(repair.assessment.decision, "admin_invocation_required");
    assert.ok(repair.assessment.triggerCodes.includes("admin_invocation_governance_repair"));
  });

  const replanInput = fixture({
    trace: makeTrace(
      "temp_validation_passed",
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts", "src/b.ts"]
    ),
    governancePolicy: {
      ...DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
      maxProposedFiles: 1
    }
  });
  const replan = evaluateAdminInvocationPolicy(replanInput);
  check("conditional governance replan requires Admin", () => {
    assert.equal(replanInput.governance.decision, "governance_replan_required");
    assert.equal(replan.assessment.decision, "admin_invocation_required");
    assert.ok(replan.assessment.triggerCodes.includes("admin_invocation_governance_replan"));
  });

  const escalationWithObservationInput = fixture({
    phase: "temp_validation_needs_review"
  });
  const escalationWithObservation = evaluateAdminInvocationPolicy(
    escalationWithObservationInput
  );
  check("conditional governance escalation with observation requires Admin", () => {
    assert.equal(escalationWithObservationInput.governance.decision,
      "governance_escalation_required");
    assert.equal(escalationWithObservation.assessment.decision,
      "admin_invocation_required");
    assert.ok(escalationWithObservation.assessment.triggerCodes.includes(
      "admin_invocation_governance_escalation"));
  });

  const shadowReviewInput = fixture({
    shadowStage: "shadow_observer_needs_review",
    shadowValidationDecision: "shadow_observation_needs_review"
  });
  const shadowReview = evaluateAdminInvocationPolicy(shadowReviewInput);
  check("conditional Shadow needs-review with observation requires Admin", () => {
    assert.equal(shadowReview.assessment.decision, "admin_invocation_required");
    assert.ok(shadowReview.assessment.triggerCodes.includes(
      "admin_invocation_shadow_needs_review"));
  });

  const escalationInput = fixture({ phase: "temp_validation_needs_review", noObservation: true });
  const escalation = evaluateAdminInvocationPolicy(escalationInput);
  check("escalation without observation skips for insufficient semantic evidence", () => {
    assert.equal(escalationInput.governance.decision, "governance_escalation_required");
    assert.equal(escalation.assessment.decision, "admin_invocation_skipped");
    assert.equal(escalation.assessment.skipKind, "insufficient_semantic_evidence");
    assert.equal(escalation.assessment.autoContinueWithoutAdminEligible, false);
  });

  const disabledClean = evaluateAdminInvocationPolicy(cleanInput, {
    ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: "disabled"
  });
  const alwaysClean = evaluateAdminInvocationPolicy(cleanInput, {
    ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: "always"
  });
  check("disabled and always modes preserve their exact semantics", () => {
    assert.equal(disabledClean.assessment.skipKind, "disabled");
    assert.equal(disabledClean.assessment.autoContinueWithoutAdminEligible, true);
    assert.equal(alwaysClean.assessment.decision, "admin_invocation_required");
    assert.ok(alwaysClean.assessment.reasonCodes.includes("admin_invocation_always_mode"));
    assert.notEqual(alwaysClean.assessment.assessmentHash, clean.assessment.assessmentHash);
  });

  const disabledNonClean = evaluateAdminInvocationPolicy(fixture({
    observation: { riskLevel: "medium", recommendation: "request_repair" }
  }), {
    ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: "disabled"
  });
  check("disabled non-clean evidence skips without auto-continuation eligibility", () => {
    assert.equal(disabledNonClean.assessment.decision, "admin_invocation_skipped");
    assert.equal(disabledNonClean.assessment.skipKind, "disabled");
    assert.equal(disabledNonClean.assessment.autoContinueWithoutAdminEligible, false);
  });

  const terminatedInput = fixture({ trace: makeTrace("temp_validation_passed", ".git/config") });
  const terminated = ["disabled", "conditional", "always"].map((mode) =>
    evaluateAdminInvocationPolicy(terminatedInput, {
      ...DEFAULT_ADMIN_INVOCATION_POLICY, mode
    }));
  check("deterministic termination skips Admin in every mode", () => {
    assert.equal(terminatedInput.governance.decision, "governance_terminated");
    for (const result of terminated) {
      assert.equal(result.assessment.decision, "admin_invocation_skipped");
      assert.equal(result.assessment.skipKind, "deterministic_hard_stop");
    }
  });

  const tampered = structuredClone(cleanInput);
  tampered.governance.governanceHash = hashCanonicalJson({ tampered: true });
  const invalid = evaluateAdminInvocationPolicy(tampered);
  check("tampered evidence cannot produce a trusted assessment", () => {
    assert.equal(invalid.decision, "admin_invocation_policy_invalid");
    assert.equal(invalid.assessment, null);
  });

  for (const value of [null, 1, "bad", [], new Date(), new Map(), new Set()]) {
    const result = evaluateAdminInvocationPolicy(value);
    assert.equal(result.decision, "admin_invocation_policy_invalid");
  }
  check("malformed runtime evidence returns invalid without throwing", () => {});

  const callerPolicy = { ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: "conditional" };
  const repeated = evaluateAdminInvocationPolicy(cleanInput, callerPolicy);
  check("evaluation is deterministic, pure, and deeply frozen", () => {
    assert.equal(repeated.assessment.assessmentHash, clean.assessment.assessmentHash);
    assert.equal(Object.isFrozen(repeated), true);
    assert.equal(Object.isFrozen(repeated.assessment), true);
    assert.equal(Object.isFrozen(callerPolicy), false);
    assert.equal(Object.isFrozen(cleanInput), false);
  });

  assert.throws(() => evaluateAdminInvocationPolicy(cleanInput, {
    ...DEFAULT_ADMIN_INVOCATION_POLICY,
    cleanPathMaximumShadowRiskScore: 25
  }), TypeError);
  assert.throws(() => evaluateAdminInvocationPolicy(cleanInput, {
    ...DEFAULT_ADMIN_INVOCATION_POLICY,
    mode: "conditional",
    extra: true
  }), TypeError);
  check("trusted policy relaxation and unknown fields throw TypeError", () => {});

  console.log(`admin invocation policy smoke passed (${checks} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
