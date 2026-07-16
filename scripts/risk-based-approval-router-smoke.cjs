const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function check(name, fn) {
  try { fn(); console.log(`[ok] ${name}`); }
  catch (error) { console.error(`[fail] ${name}`); throw error; }
}

const RULE_ORDER = [
  "trace_integrity", "phase_v_binding", "shadow_observation_integrity",
  "shadow_observation_trace_binding", "shadow_stage_consistency", "shadow_stage_health",
  "governance_policy_integrity", "governance_integrity", "governance_trace_binding",
  "governance_observation_binding", "governance_route", "admin_invocation_integrity",
  "admin_decision_integrity",
  "admin_trace_binding", "admin_observation_binding", "admin_governance_binding",
  "admin_governance_decision_binding", "admin_stage_consistency", "admin_stage_health",
  "admin_route", "phase_v_outcome", "auto_continue_eligibility",
  "deterministic_authority"
];

async function main() {
  const runtime = await import(pathToFileURL(path.join(
    process.cwd(), "dist", "packages", "product-runtime", "src", "index.js"
  )).href);
  const {
    RISK_BASED_APPROVAL_ROUTER_VERSION,
    DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY,
    appendAgentEvent,
    buildRunAccountabilityTrace,
    createAgentEventLedger,
    DEFAULT_ADMIN_INVOCATION_POLICY,
    evaluateDeterministicGovernance,
    evaluateAdminInvocationPolicy,
    evaluateRiskBasedApprovalRoute,
    hashCanonicalJson,
    validateAdminDecision,
    validateShadowObservation
  } = runtime;

  const artifactHash = hashCanonicalJson({ artifact: "router-bounded" });
  const objectiveHash = hashCanonicalJson({ objective: "router-smoke" });

  function makeTrace(decision = "temp_validation_passed", runId = "router-smoke-run") {
    let ledger = createAgentEventLedger({ runId, objectiveHash });
    const specs = [
      ["planner", "planner.plan", [], ["src/a.ts"], "planner_valid", []],
      ["coder", "coder.patch_draft", ["src/a.ts"], ["src/a.ts"], "coder_valid", []],
      ["deterministic_verifier", "deterministic_verifier.patch_draft", ["src/a.ts"], [], "approve", []],
      ["temp_workspace_apply", "temp_workspace_apply.apply", ["src/a.ts"], ["src/a.ts"], "temp_apply_ready", []],
      ["execution_verifier", "execution_verifier.validate", ["src/a.ts"], [], decision,
        ["temp_workspace_cleanup_performed"]]
    ];
    for (const [index, spec] of specs.entries()) {
      ledger = appendAgentEvent(ledger, {
        actor: spec[0], action: spec[1], filesRead: spec[2], filesProposed: spec[3],
        decision: spec[4], reasonCodes: spec[5],
        startedAt: new Date(Date.parse("2026-07-14T08:00:00.000Z") + index * 100).toISOString(),
        finishedAt: new Date(Date.parse("2026-07-14T08:00:00.010Z") + index * 100).toISOString(),
        inputArtifactHashes: [artifactHash], outputArtifactHashes: [artifactHash]
      });
    }
    const result = buildRunAccountabilityTrace(ledger, {
      expectedRunId: ledger.runId, expectedObjectiveHash: ledger.objectiveHash,
      expectedRootHash: ledger.rootHash, expectedEventCount: ledger.eventCount
    });
    assert.ok(result.trace, JSON.stringify(result));
    return result.trace;
  }

  function makeObservation(trace, riskLevel = "low", recommendation = "continue") {
    const findings = riskLevel === "low" ? [] : [{
      code: `${riskLevel}_shadow_risk`,
      severity: riskLevel === "critical" ? "critical" : riskLevel === "high" ? "high" : "warning",
      message: "RAW_SHADOW_COMPLETION_SENTINEL",
      evidenceEventIds: [trace.events[0].eventId], evidenceFilePaths: ["src/a.ts"],
      evidenceTraceFindingCodes: []
    }];
    const result = validateShadowObservation(trace, {
      observationVersion: "1", runId: trace.runId, traceHash: trace.traceHash,
      riskLevel, riskScore: { low: 10, medium: 35, high: 60, critical: 90 }[riskLevel],
      confidenceScore: 90, findings, observedScopeDrift: false,
      observedPlanPatchMismatch: false, observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false, observedEvidenceConflict: false,
      recommendation, rationaleCodes: ["bounded_shadow_evidence"]
    });
    assert.ok(result.observation, JSON.stringify(result));
    return result.observation;
  }

  function rehash(value, hashField, mutate) {
    const copy = structuredClone(value);
    mutate(copy);
    delete copy[hashField];
    copy[hashField] = hashCanonicalJson(copy);
    return copy;
  }

  function governanceVariant(base, decision) {
    const configs = {
      governance_repair_required: ["execution_outcome", "governance_execution_failed", "high", "repair", "medium"],
      governance_replan_required: ["planned_scope_consistency", "governance_unplanned_files_proposed", "high", "replan", "medium"],
      governance_escalation_required: ["total_token_limit", "governance_total_token_limit_exceeded", "high", "escalate", "high"],
      governance_terminated: ["forbidden_proposed_paths", "governance_forbidden_proposed_path", "critical", "terminate", "critical"]
    };
    return rehash(base, "governanceHash", (copy) => {
      copy.decision = decision;
      if (decision === "governance_passed") {
        copy.riskClass = "low"; copy.triggeredRuleIds = []; copy.reasonCodes = []; copy.issues = [];
        copy.ruleResults = copy.ruleResults.map((rule) => ({ ...rule, triggered: false,
          eventIds: [], filePaths: [], traceFindingCodes: [], shadowFindingCodes: [] }));
        return;
      }
      const [ruleId, reasonCode, severity, effect, riskClass] = configs[decision];
      copy.riskClass = riskClass; copy.triggeredRuleIds = [ruleId]; copy.reasonCodes = [reasonCode];
      copy.ruleResults = copy.ruleResults.map((rule) => rule.ruleId === ruleId
        ? { ...rule, triggered: true, reasonCode, severity, effect,
          eventIds: ["router-smoke-run:event:000001"], filePaths: ["src/a.ts"] }
        : { ...rule, triggered: false });
      copy.issues = [{ code: reasonCode, message: "GOVERNANCE_PROSE_SENTINEL", severity,
        effect, eventIds: ["router-smoke-run:event:000001"], filePaths: ["src/a.ts"],
        traceFindingCodes: [], shadowFindingCodes: [] }];
    });
  }

  function adminDraft(trace, observation, governance, decision) {
    const profiles = {
      admin_auto_approved: ["low", 10], admin_repair_required: ["medium", 35],
      admin_replan_required: ["medium", 35], admin_human_escalation_required: ["high", 60],
      admin_run_terminated: ["critical", 90]
    };
    let [riskLevel, riskScore] = profiles[decision];
    if (observation?.riskLevel === "critical" &&
        decision === "admin_human_escalation_required") {
      riskLevel = "critical"; riskScore = 90;
    }
    const findingNeeded = decision !== "admin_auto_approved";
    const finding = {
      code: "bounded_admin_finding",
      severity: decision === "admin_run_terminated" || riskLevel === "critical" ? "critical" :
        decision === "admin_human_escalation_required" ? "high" : "warning",
      message: "RAW_ADMIN_COMPLETION_SENTINEL",
      governanceRuleIds: governance.triggeredRuleIds.length ? [governance.triggeredRuleIds[0]] :
        decision === "admin_repair_required" ? ["execution_outcome"] :
        decision === "admin_replan_required" ? ["planned_scope_consistency"] : [],
      governanceReasonCodes: governance.reasonCodes.length ? [governance.reasonCodes[0]] : [],
      governanceIssueCodes: governance.issues.length ? [governance.issues[0].code] : [],
      traceFindingCodes: [], shadowFindingCodes: [],
      evidenceEventIds: [trace.events[0].eventId], evidenceFilePaths: ["src/a.ts"]
    };
    return {
      decisionVersion: "1", runId: trace.runId, traceHash: trace.traceHash,
      observationHash: observation?.observationHash ?? null,
      governanceHash: governance.governanceHash, decision, riskLevel, riskScore,
      confidenceScore: 90, findings: findingNeeded ? [finding] : [],
      rationaleCodes: ["bounded_admin_evidence"]
    };
  }

  function makeAdmin(trace, observation, governance, decision = "admin_auto_approved") {
    const result = validateAdminDecision(
      trace, observation, governance, adminDraft(trace, observation, governance, decision)
    );
    assert.notEqual(result.decision, "admin_decision_invalid", JSON.stringify(result));
    assert.ok(result.adminDecision, JSON.stringify(result));
    return result.adminDecision;
  }

  function makeInput(options = {}) {
    const phaseVFinalDecision = options.phaseVFinalDecision ?? "temp_validation_passed";
    const trace = options.trace ?? makeTrace(phaseVFinalDecision);
    const observation = Object.prototype.hasOwnProperty.call(options, "observation")
      ? options.observation : makeObservation(trace, options.shadowRisk ?? "low",
        options.shadowRecommendation ?? "continue");
    const evaluated = evaluateDeterministicGovernance(trace, observation).assessment;
    assert.ok(evaluated);
    const governance = options.governance ?? governanceVariant(
      evaluated, options.governanceDecision ?? evaluated.decision
    );
    const invocationResult = evaluateAdminInvocationPolicy({
      phaseVFinalDecision,
      trace,
      shadow: {
        stageDecision: options.shadowStage ?? "shadow_observer_completed",
        validationDecision: Object.prototype.hasOwnProperty.call(options, "shadowValidation")
          ? options.shadowValidation : "shadow_observation_valid",
        observation
      },
      governance
    }, { ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: options.invocationMode ?? "always" });
    const fallbackInvocation = invocationResult.assessment === null
      ? evaluateAdminInvocationPolicy({
        phaseVFinalDecision, trace,
        shadow: observation === null
          ? { stageDecision: "shadow_not_called", validationDecision: null, observation: null }
          : { stageDecision: "shadow_observer_completed",
            validationDecision: "shadow_observation_valid", observation },
        governance
      }, { ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: options.invocationMode ?? "always" }).assessment
      : null;
    const invocation = options.invocation ?? invocationResult.assessment ?? fallbackInvocation;
    assert.ok(invocation, JSON.stringify({ options, invocationResult }));
    const invocationSkipped = invocation.decision === "admin_invocation_skipped";
    const adminDecision = Object.prototype.hasOwnProperty.call(options, "adminDecision")
      ? options.adminDecision
      : invocationSkipped ? null
      : makeAdmin(trace, observation, governance, options.adminSemanticDecision ??
        ({ governance_passed: "admin_auto_approved",
          governance_repair_required: "admin_repair_required",
          governance_replan_required: "admin_replan_required",
          governance_escalation_required: "admin_human_escalation_required",
          governance_terminated: "admin_run_terminated" })[governance.decision]);
    return {
      phaseVFinalDecision, trace,
      shadow: {
        stageDecision: options.shadowStage ?? "shadow_observer_completed",
        validationDecision: Object.prototype.hasOwnProperty.call(options, "shadowValidation")
          ? options.shadowValidation : "shadow_observation_valid",
        observation
      },
      governance,
      admin: {
        invocation,
        stageDecision: options.adminStage ?? (invocationSkipped
          ? "admin_skipped_by_policy" : "admin_agent_completed"),
        validationDecision: Object.prototype.hasOwnProperty.call(options, "adminValidation")
          ? options.adminValidation : invocationSkipped ? null : "admin_decision_valid",
        decision: adminDecision
      }
    };
  }

  function refreshInvocation(input, mode = "always") {
    const result = evaluateAdminInvocationPolicy({
      phaseVFinalDecision: input.phaseVFinalDecision,
      trace: input.trace,
      shadow: input.shadow,
      governance: input.governance
    }, { ...DEFAULT_ADMIN_INVOCATION_POLICY, mode });
    assert.ok(result.assessment, JSON.stringify(result));
    input.admin.invocation = result.assessment;
  }

  const cleanInput = makeInput();
  const clean = evaluateRiskBasedApprovalRoute(cleanInput);

  check("clean complete low-risk evidence auto-continues", () => {
    assert.equal(RISK_BASED_APPROVAL_ROUTER_VERSION, "2");
    assert.equal(clean.assessment.adminResolutionKind, "model_decision");
    assert.equal(clean.decision, "approval_route_valid");
    assert.equal(clean.route, "auto_continue");
    assert.equal(clean.assessment.riskClass, "low");
    assert.equal(clean.assessment.triggeredRuleIds.length, 0);
    assert.equal(clean.summary.autoContinueEligible, true);
    assert.equal(clean.summary.deterministicAuthorityPreserved, true);
    assert.equal(clean.summary.routeHashValid, true);
    const material = structuredClone(clean.assessment); delete material.routeHash;
    assert.equal(hashCanonicalJson(material), clean.assessment.routeHash);
  });

  check("verified conditional clean-path skip auto-continues without an Admin decision", () => {
    const input = makeInput({ invocationMode: "conditional" });
    assert.equal(input.admin.invocation.decision, "admin_invocation_skipped");
    assert.equal(input.admin.invocation.skipKind, "clean_path");
    assert.equal(input.admin.stageDecision, "admin_skipped_by_policy");
    assert.equal(input.admin.decision, null);
    const result = evaluateRiskBasedApprovalRoute(input);
    assert.equal(result.decision, "approval_route_valid");
    assert.equal(result.route, "auto_continue");
    assert.equal(result.assessment.adminResolutionKind, "verified_policy_skip");
    assert.equal(result.assessment.adminDecisionHash, null);
  });

  check("invocation claims are mandatory, bound, and cannot contradict Admin execution", () => {
    const missing = makeInput();
    delete missing.admin.invocation;
    assert.equal(evaluateRiskBasedApprovalRoute(missing).decision, "approval_route_invalid");

    const tampered = structuredClone(makeInput());
    tampered.admin.invocation.decision = "admin_invocation_skipped";
    assert.equal(evaluateRiskBasedApprovalRoute(tampered).decision, "approval_route_invalid");

    const wrongBinding = structuredClone(makeInput());
    wrongBinding.admin.invocation = rehash(
      wrongBinding.admin.invocation,
      "assessmentHash",
      (value) => { value.traceHash = hashCanonicalJson({ wrong: "trace" }); }
    );
    assert.equal(evaluateRiskBasedApprovalRoute(wrongBinding).decision,
      "approval_route_invalid");

    const wrongGovernanceBinding = structuredClone(makeInput());
    wrongGovernanceBinding.admin.invocation = rehash(
      wrongGovernanceBinding.admin.invocation,
      "assessmentHash",
      (value) => { value.governanceHash = hashCanonicalJson({ wrong: "governance" }); }
    );
    assert.equal(evaluateRiskBasedApprovalRoute(wrongGovernanceBinding).decision,
      "approval_route_invalid");

    const skippedButCalled = structuredClone(makeInput({ invocationMode: "conditional" }));
    skippedButCalled.admin.stageDecision = "admin_agent_completed";
    skippedButCalled.admin.validationDecision = "admin_decision_valid";
    skippedButCalled.admin.decision = cleanInput.admin.decision;
    assert.equal(evaluateRiskBasedApprovalRoute(skippedButCalled).decision,
      "approval_route_invalid");

    const falseAlwaysSkip = structuredClone(makeInput({ invocationMode: "conditional" }));
    falseAlwaysSkip.admin.invocation.policy.mode = "always";
    falseAlwaysSkip.admin.invocation.policyHash = hashCanonicalJson(
      falseAlwaysSkip.admin.invocation.policy
    );
    delete falseAlwaysSkip.admin.invocation.assessmentHash;
    falseAlwaysSkip.admin.invocation.assessmentHash = hashCanonicalJson(
      falseAlwaysSkip.admin.invocation
    );
    assert.equal(evaluateRiskBasedApprovalRoute(falseAlwaysSkip).decision,
      "approval_route_invalid");
  });

  check("route hashes bind invocation mode and assessment evidence", () => {
    const conditional = evaluateRiskBasedApprovalRoute(makeInput({
      invocationMode: "conditional"
    })).assessment;
    assert.notEqual(conditional.routeHash, clean.assessment.routeHash);
    assert.notEqual(conditional.adminInvocationAssessmentHash,
      clean.assessment.adminInvocationAssessmentHash);
  });

  check("Phase V terminal outcomes map without being weakened", () => {
    for (const [decision, route] of [
      ["temp_validation_passed", "auto_continue"],
      ["temp_validation_failed", "repair_required"],
      ["temp_validation_needs_review", "human_required"]
    ]) {
      const input = makeInput({ phaseVFinalDecision: decision,
        governanceDecision: decision === "temp_validation_failed"
          ? "governance_repair_required" : decision === "temp_validation_needs_review"
            ? "governance_escalation_required" : "governance_passed" });
      assert.equal(evaluateRiskBasedApprovalRoute(input).route, route);
    }
    const defensive = makeInput({ phaseVFinalDecision: "temp_validation_failed",
      governanceDecision: "governance_passed", adminSemanticDecision: "admin_auto_approved" });
    assert.equal(evaluateRiskBasedApprovalRoute(defensive).route, "repair_required");
  });

  check("all deterministic governance effects map exactly", () => {
    const expected = {
      governance_passed: "auto_continue", governance_repair_required: "repair_required",
      governance_replan_required: "replan_required",
      governance_escalation_required: "human_required", governance_terminated: "terminated"
    };
    for (const [governanceDecision, route] of Object.entries(expected)) {
      const result = evaluateRiskBasedApprovalRoute(makeInput({ governanceDecision }));
      assert.equal(result.route, route, governanceDecision);
      assert.equal(result.assessment.governanceDecision, governanceDecision);
    }
  });

  check("all valid Admin semantic effects map exactly", () => {
    const expected = {
      admin_auto_approved: "auto_continue", admin_repair_required: "repair_required",
      admin_replan_required: "replan_required",
      admin_human_escalation_required: "human_required", admin_run_terminated: "terminated"
    };
    for (const [adminSemanticDecision, route] of Object.entries(expected)) {
      const result = evaluateRiskBasedApprovalRoute(makeInput({ adminSemanticDecision }));
      assert.equal(result.route, route, adminSemanticDecision);
    }
  });

  check("effect precedence is terminate > human > replan > repair > none", () => {
    assert.equal(evaluateRiskBasedApprovalRoute(makeInput({ phaseVFinalDecision: "temp_validation_failed",
      governanceDecision: "governance_replan_required" })).route, "replan_required");
    assert.equal(evaluateRiskBasedApprovalRoute(makeInput({ phaseVFinalDecision: "temp_validation_failed",
      governanceDecision: "governance_escalation_required" })).route, "human_required");
    assert.equal(evaluateRiskBasedApprovalRoute(makeInput({ governanceDecision: "governance_replan_required",
      adminSemanticDecision: "admin_human_escalation_required" })).route, "human_required");
    assert.equal(evaluateRiskBasedApprovalRoute(makeInput({
      adminSemanticDecision: "admin_run_terminated" })).route, "terminated");
  });

  check("missing and reviewed adapter stages route conservatively", () => {
    const cases = [
      [{ adminStage: "admin_not_called", adminValidation: null, adminDecision: null }, "human_required"],
      [{ adminStage: "admin_agent_needs_review", adminValidation: "admin_decision_needs_review" }, "human_required"],
      [{ adminStage: "admin_agent_needs_review", adminValidation: "admin_decision_needs_review", adminDecision: null }, "human_required"],
      [{ adminStage: "admin_agent_failed", adminValidation: "admin_decision_invalid", adminDecision: null }, "human_required"],
      [{ shadowStage: "shadow_observer_needs_review", shadowValidation: "shadow_observation_needs_review" }, "human_required"],
      [{ shadowStage: "shadow_observer_needs_review", shadowValidation: "shadow_observation_needs_review", observation: null,
        governanceDecision: "governance_escalation_required" }, "human_required"],
      [{ shadowStage: "shadow_observer_failed", shadowValidation: "shadow_observation_invalid", observation: null,
        governanceDecision: "governance_escalation_required" }, "human_required"],
      [{ shadowStage: "shadow_not_called", shadowValidation: null, observation: null,
        governanceDecision: "governance_escalation_required" }, "human_required"]
    ];
    for (const [options, route] of cases) {
      const result = evaluateRiskBasedApprovalRoute(makeInput(options));
      assert.equal(result.decision, "approval_route_valid", JSON.stringify(result.issues));
      assert.equal(result.route, route);
    }
  });

  check("missing Admin cannot auto-continue while default auto requirements remain enabled", () => {
    const input = makeInput({ adminStage: "admin_not_called", adminValidation: null, adminDecision: null });
    const custom = { ...DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY,
      routeMissingAdminToHuman: false };
    const result = evaluateRiskBasedApprovalRoute(input, custom);
    assert.equal(result.route, "human_required");
    assert.ok(result.assessment.triggeredRuleIds.includes("auto_continue_eligibility"));
  });

  check("contradictory Shadow and Admin stage states invalidate", () => {
    const cases = [
      { shadowStage: "shadow_not_called", shadowValidation: null },
      { shadowStage: "shadow_observer_completed", shadowValidation: null },
      { shadowStage: "shadow_observer_completed", shadowValidation: "shadow_observation_valid", observation: null },
      { shadowStage: "shadow_observer_failed", shadowValidation: "shadow_observation_invalid" },
      { adminStage: "admin_not_called", adminValidation: null },
      { adminStage: "admin_agent_completed", adminValidation: null },
      { adminStage: "admin_agent_completed", adminValidation: "admin_decision_valid", adminDecision: null },
      { adminStage: "admin_agent_failed", adminValidation: "admin_decision_invalid" }
    ];
    for (const options of cases) {
      if (options.shadowStage === "shadow_not_called" || options.shadowStage === "shadow_observer_failed") {
        options.observation = makeObservation(cleanInput.trace);
      }
      if (options.adminStage === "admin_not_called" || options.adminStage === "admin_agent_failed") {
        options.adminDecision = cleanInput.admin.decision;
      }
      const result = evaluateRiskBasedApprovalRoute(makeInput(options));
      assert.equal(result.decision, "approval_route_invalid", JSON.stringify(options));
      assert.equal(result.route, null);
    }
  });

  check("Phase V binding and completion are independently enforced", () => {
    const mismatch = structuredClone(cleanInput); mismatch.phaseVFinalDecision = "temp_validation_failed";
    assert.ok(evaluateRiskBasedApprovalRoute(mismatch).issues.some((issue) =>
      issue.code === "approval_router_phase_v_trace_mismatch"));
    for (const field of ["phaseVExecutionObserved", "phaseVExecutionCompleted"]) {
      const input = structuredClone(cleanInput);
      input.trace[field] = false; delete input.trace.traceHash;
      input.trace.traceHash = hashCanonicalJson(input.trace);
      input.shadow.observation = rehash(input.shadow.observation, "observationHash", (value) => {
        value.traceHash = input.trace.traceHash;
      });
      input.governance = rehash(input.governance, "governanceHash", (value) => {
        value.traceHash = input.trace.traceHash;
        value.observationHash = input.shadow.observation.observationHash;
      });
      input.admin.decision = rehash(input.admin.decision, "adminDecisionHash", (value) => {
        value.traceHash = input.trace.traceHash;
        value.observationHash = input.shadow.observation.observationHash;
        value.governanceHash = input.governance.governanceHash;
      });
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.ok(result.issues.some((issue) =>
        issue.code === "approval_router_phase_v_execution_not_completed"));
    }
    for (const bad of [null, "future_execution_decision"]) {
      const input = structuredClone(cleanInput);
      input.trace.decisions.finalExecutionDecision = bad; delete input.trace.traceHash;
      input.trace.traceHash = hashCanonicalJson(input.trace);
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.ok(result.issues.some((issue) => issue.code === "approval_router_phase_v_decision_invalid"));
    }
  });

  check("each evidence hash is recomputed independently", () => {
    const cases = [
      ["trace", (input) => { input.trace.resources.totalTokens += 1; }, "approval_router_trace_integrity_mismatch"],
      ["observation", (input) => { input.shadow.observation.riskScore += 1; }, "approval_router_observation_integrity_mismatch"],
      ["governance policy", (input) => { input.governance.policy.maxRepairCount += 1; }, "approval_router_governance_policy_hash_mismatch"],
      ["governance", (input) => { input.governance.riskClass = "high"; }, "approval_router_governance_integrity_mismatch"],
      ["Admin", (input) => { input.admin.decision.riskScore += 1; }, "approval_router_admin_integrity_mismatch"]
    ];
    for (const [name, mutate, code] of cases) {
      const input = structuredClone(cleanInput); mutate(input);
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.equal(result.decision, "approval_route_invalid", name);
      assert.ok(result.issues.some((issue) => issue.code === code), `${name}: ${JSON.stringify(result.issues)}`);
    }
  });

  check("rehashed malformed risk evidence still fails structural verification", () => {
    const cases = [
      [(input) => { input.shadow.observation = rehash(input.shadow.observation,
        "observationHash", (value) => { value.riskLevel = "future"; }); },
        "approval_router_observation_integrity_mismatch"],
      [(input) => { input.governance = rehash(input.governance,
        "governanceHash", (value) => { value.riskClass = "future"; }); },
        "approval_router_governance_integrity_mismatch"],
      [(input) => { input.admin.decision = rehash(input.admin.decision,
        "adminDecisionHash", (value) => { value.riskScore = 99; }); },
        "approval_router_admin_integrity_mismatch"]
    ];
    for (const [mutate, code] of cases) {
      const input = structuredClone(cleanInput); mutate(input);
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.equal(result.decision, "approval_route_invalid");
      assert.ok(result.issues.some((issue) => issue.code === code));
    }
  });

  check("all cross-layer bindings are independently enforced", () => {
    const hash = (character) => `sha256:${character.repeat(64)}`;
    const cases = [
      [(input) => { input.shadow.observation = rehash(input.shadow.observation, "observationHash",
        (value) => { value.traceHash = hash("a"); }); }, "approval_router_observation_trace_mismatch"],
      [(input) => { input.governance = rehash(input.governance, "governanceHash",
        (value) => { value.traceHash = hash("b"); }); }, "approval_router_governance_trace_mismatch"],
      [(input) => { input.governance = rehash(input.governance, "governanceHash",
        (value) => { value.observationHash = hash("c"); }); }, "approval_router_governance_observation_mismatch"],
      [(input) => { input.admin.decision = rehash(input.admin.decision, "adminDecisionHash",
        (value) => { value.traceHash = hash("d"); }); }, "approval_router_admin_trace_mismatch"],
      [(input) => { input.admin.decision = rehash(input.admin.decision, "adminDecisionHash",
        (value) => { value.observationHash = hash("e"); }); }, "approval_router_admin_observation_mismatch"],
      [(input) => { input.admin.decision = rehash(input.admin.decision, "adminDecisionHash",
        (value) => { value.governanceHash = hash("f"); }); }, "approval_router_admin_governance_mismatch"],
      [(input) => { input.admin.decision = rehash(input.admin.decision, "adminDecisionHash",
        (value) => { value.governanceDecision = "governance_repair_required"; }); },
        "approval_router_admin_governance_decision_mismatch"]
    ];
    for (const [mutate, code] of cases) {
      const input = structuredClone(cleanInput); mutate(input);
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.equal(result.decision, "approval_route_invalid");
      assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
    }
  });

  check("validated Admin evidence cannot weaken deterministic governance", () => {
    const input = makeInput({ governanceDecision: "governance_replan_required" });
    input.admin.decision = rehash(input.admin.decision, "adminDecisionHash", (value) => {
      value.decision = "admin_repair_required";
      value.riskLevel = "medium"; value.riskScore = 35;
    });
    const result = evaluateRiskBasedApprovalRoute(input);
    assert.equal(result.decision, "approval_route_invalid");
    assert.ok(result.issues.some((issue) =>
      issue.code === "approval_router_deterministic_authority_violation"));
  });

  check("governance termination survives every Admin outcome", () => {
    const terminated = makeInput({ governanceDecision: "governance_terminated" });
    const baseline = evaluateRiskBasedApprovalRoute(terminated);
    assert.equal(baseline.route, "terminated");
    assert.equal(terminated.admin.invocation.skipKind, "deterministic_hard_stop");
    assert.equal(terminated.admin.decision, null);
    const semantics = [
      "admin_auto_approved", "admin_repair_required", "admin_replan_required",
      "admin_human_escalation_required", "admin_run_terminated"
    ];
    for (const semantic of semantics) {
      const input = structuredClone(terminated);
      input.admin.stageDecision = "admin_agent_completed";
      input.admin.validationDecision = "admin_decision_valid";
      input.admin.decision = rehash(cleanInput.admin.decision, "adminDecisionHash", (value) => {
        value.governanceHash = input.governance.governanceHash;
        value.governanceDecision = "governance_terminated";
        value.decision = semantic;
        const risk = semantic === "admin_auto_approved" ? ["low", 10] :
          semantic === "admin_human_escalation_required" ? ["high", 60] : ["medium", 35];
        value.riskLevel = risk[0]; value.riskScore = risk[1];
      });
      const result = evaluateRiskBasedApprovalRoute(input);
      assert.equal(result.decision, "approval_route_invalid", semantic);
      assert.equal(result.route, null);
    }
  });

  check("every default auto-continuation requirement fails closed", () => {
    const fixtures = [
      { shadowStage: "shadow_not_called", shadowValidation: null, observation: null,
        governanceDecision: "governance_passed" },
      { shadowStage: "shadow_observer_needs_review",
        shadowValidation: "shadow_observation_needs_review" },
      { governanceDecision: "governance_repair_required" },
      { adminStage: "admin_not_called", adminValidation: null, adminDecision: null },
      { adminStage: "admin_agent_needs_review", adminValidation: "admin_decision_needs_review" },
      { adminSemanticDecision: "admin_repair_required" }
    ];
    for (const options of fixtures) {
      const result = evaluateRiskBasedApprovalRoute(makeInput(options));
      assert.notEqual(result.route, "auto_continue", JSON.stringify(options));
    }
    const triggeredGovernance = makeInput();
    triggeredGovernance.governance = rehash(triggeredGovernance.governance, "governanceHash", (value) => {
      const rule = value.ruleResults.find((candidate) => candidate.ruleId === "shadow_risk_level");
      rule.triggered = true; rule.reasonCode = "governance_shadow_medium_risk";
      value.triggeredRuleIds = [rule.ruleId]; value.reasonCodes = [rule.reasonCode];
    });
    refreshInvocation(triggeredGovernance);
    triggeredGovernance.admin.decision = rehash(
      triggeredGovernance.admin.decision, "adminDecisionHash",
      (value) => { value.governanceHash = triggeredGovernance.governance.governanceHash; }
    );
    const triggered = evaluateRiskBasedApprovalRoute(triggeredGovernance);
    assert.equal(triggered.route, "human_required");
    assert.ok(triggered.assessment.triggeredRuleIds.includes("auto_continue_eligibility"));
    const issueGovernance = makeInput();
    issueGovernance.governance = rehash(issueGovernance.governance, "governanceHash", (value) => {
      value.issues = [{ code: "bounded_governance_issue", message: "IGNORED_PROSE",
        severity: "info", effect: "none", eventIds: [], filePaths: [],
        traceFindingCodes: [], shadowFindingCodes: [] }];
    });
    refreshInvocation(issueGovernance);
    issueGovernance.admin.decision = rehash(issueGovernance.admin.decision, "adminDecisionHash",
      (value) => { value.governanceHash = issueGovernance.governance.governanceHash; });
    assert.equal(evaluateRiskBasedApprovalRoute(issueGovernance).route, "human_required");
  });

  check("risk class is promoted without weakening route", () => {
    const routes = [
      [makeInput({ governanceDecision: "governance_repair_required" }), "medium"],
      [makeInput({ governanceDecision: "governance_replan_required" }), "medium"],
      [makeInput({ governanceDecision: "governance_escalation_required" }), "high"],
      [makeInput({ governanceDecision: "governance_terminated" }), "critical"]
    ];
    for (const [input, minimum] of routes) {
      assert.ok({ low: 0, medium: 1, high: 2, critical: 3 }[
        evaluateRiskBasedApprovalRoute(input).assessment.riskClass] >=
        { low: 0, medium: 1, high: 2, critical: 3 }[minimum]);
    }
    const criticalShadow = makeInput({ shadowRisk: "critical", shadowRecommendation: "terminate",
      governanceDecision: "governance_escalation_required" });
    const result = evaluateRiskBasedApprovalRoute(criticalShadow);
    assert.equal(result.route, "human_required");
    assert.equal(result.assessment.riskClass, "critical");
  });

  check("custom policy is exact, hash-sensitive, and caller-owned", () => {
    const base = { ...DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY };
    const copy = { ...base };
    const input = makeInput({ adminStage: "admin_not_called", adminValidation: null, adminDecision: null });
    const first = evaluateRiskBasedApprovalRoute(input, base);
    const second = evaluateRiskBasedApprovalRoute(input, copy);
    assert.equal(first.assessment.policyHash, second.assessment.policyHash);
    assert.deepEqual(base, copy); assert.equal(Object.isFrozen(base), false);
    for (const field of Object.keys(base).filter((field) => field !== "policyVersion")) {
      const changed = { ...base, [field]: !base[field] };
      const result = evaluateRiskBasedApprovalRoute(input, changed);
      assert.notEqual(result.assessment?.policyHash ?? result.decision, first.assessment.policyHash, field);
    }
    for (const [overrides, stageOptions] of [
      [{ routeShadowNeedsReviewToHuman: false }, { shadowStage: "shadow_observer_needs_review", shadowValidation: "shadow_observation_needs_review" }],
      [{ routeShadowFailureToHuman: false }, { shadowStage: "shadow_observer_failed", shadowValidation: "shadow_observation_invalid", observation: null,
        governanceDecision: "governance_passed" }],
      [{ routeAdminNeedsReviewToHuman: false }, { adminStage: "admin_agent_needs_review", adminValidation: "admin_decision_needs_review" }],
      [{ routeAdminFailureToHuman: false }, { adminStage: "admin_agent_failed", adminValidation: "admin_decision_invalid", adminDecision: null }],
      [{ routeMissingAdminToHuman: false }, { adminStage: "admin_not_called", adminValidation: null, adminDecision: null }]
    ]) {
      const policy = { ...base, ...overrides };
      const result = evaluateRiskBasedApprovalRoute(makeInput(stageOptions), policy);
      assert.equal(result.decision, "approval_route_valid");
      assert.equal(result.route, "human_required");
      assert.ok(result.assessment.triggeredRuleIds.includes("auto_continue_eligibility"));
      const disabledRule = Object.keys(overrides)[0].startsWith("routeShadow")
        ? "shadow_stage_health" : "admin_stage_health";
      assert.equal(result.assessment.ruleResults.find((rule) =>
        rule.ruleId === disabledRule).triggered, false);
    }
    for (const invalid of [
      { ...base, unknown: true },
      Object.fromEntries(Object.entries(base).filter(([field]) => field !== "routeAdminFailureToHuman")),
      { ...base, routeAdminFailureToHuman: "true" },
      new (class PolicyFixture { constructor() { Object.assign(this, base); } })()
    ]) assert.throws(() => evaluateRiskBasedApprovalRoute(cleanInput, invalid), TypeError);
    const accessorPolicy = { ...base };
    Object.defineProperty(accessorPolicy, "routeAdminFailureToHuman", {
      enumerable: true, get() { throw new Error("policy getter"); }
    });
    assert.throws(() => evaluateRiskBasedApprovalRoute(cleanInput, accessorPolicy), TypeError);
    const symbolPolicy = { ...base }; symbolPolicy[Symbol("secret")] = true;
    assert.throws(() => evaluateRiskBasedApprovalRoute(cleanInput, symbolPolicy), TypeError);
    const future = { ...base, policyVersion: "3" };
    assert.equal(evaluateRiskBasedApprovalRoute(cleanInput, future).decision,
      "approval_route_needs_review");
  });

  check("route and policy hashes are deterministic and evidence-sensitive", () => {
    const repeated = evaluateRiskBasedApprovalRoute(cleanInput);
    const roundTrip = evaluateRiskBasedApprovalRoute(JSON.parse(JSON.stringify(cleanInput)));
    assert.equal(repeated.assessment.routeHash, clean.assessment.routeHash);
    assert.equal(roundTrip.assessment.routeHash, clean.assessment.routeHash);
    const variants = [
      makeInput({ phaseVFinalDecision: "temp_validation_failed", governanceDecision: "governance_repair_required" }),
      makeInput({ shadowStage: "shadow_observer_needs_review", shadowValidation: "shadow_observation_needs_review" }),
      makeInput({ governanceDecision: "governance_replan_required" }),
      makeInput({ adminSemanticDecision: "admin_human_escalation_required" })
    ];
    for (const variant of variants) {
      assert.notEqual(evaluateRiskBasedApprovalRoute(variant).assessment.routeHash,
        clean.assessment.routeHash);
    }
    const changedPolicy = { ...DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY,
      routeMissingAdminToHuman: false };
    assert.notEqual(evaluateRiskBasedApprovalRoute(cleanInput, changedPolicy).assessment.routeHash,
      clean.assessment.routeHash);
  });

  check("validator-normalized evidence array order leaves route hash unchanged", () => {
    const trace = cleanInput.trace;
    const observation = cleanInput.shadow.observation;
    const governance = cleanInput.governance;
    const firstDraft = adminDraft(trace, observation, governance, "admin_repair_required");
    firstDraft.findings[0].evidenceEventIds = [trace.events[1].eventId, trace.events[0].eventId];
    firstDraft.findings[0].governanceRuleIds = ["execution_outcome", "execution_outcome"];
    const secondDraft = structuredClone(firstDraft);
    secondDraft.findings[0].evidenceEventIds.reverse();
    secondDraft.findings[0].governanceRuleIds.reverse();
    const firstAdmin = validateAdminDecision(trace, observation, governance, firstDraft).adminDecision;
    const secondAdmin = validateAdminDecision(trace, observation, governance, secondDraft).adminDecision;
    assert.ok(firstAdmin); assert.ok(secondAdmin);
    assert.equal(firstAdmin.adminDecisionHash, secondAdmin.adminDecisionHash);
    const firstInput = structuredClone(cleanInput); firstInput.admin.decision = firstAdmin;
    const secondInput = structuredClone(cleanInput); secondInput.admin.decision = secondAdmin;
    assert.equal(evaluateRiskBasedApprovalRoute(firstInput).assessment.routeHash,
      evaluateRiskBasedApprovalRoute(secondInput).assessment.routeHash);
  });

  check("canonical rule set, triggered order, evidence arrays, and reasons are normalized", () => {
    const result = evaluateRiskBasedApprovalRoute(makeInput({
      phaseVFinalDecision: "temp_validation_failed",
      governanceDecision: "governance_escalation_required",
      adminSemanticDecision: "admin_run_terminated"
    }));
    assert.deepEqual(result.assessment.ruleResults.map((rule) => rule.ruleId), RULE_ORDER);
    assert.equal(new Set(result.assessment.ruleResults.map((rule) => rule.ruleId)).size,
      RULE_ORDER.length);
    assert.deepEqual(result.assessment.triggeredRuleIds,
      RULE_ORDER.filter((id) => result.assessment.ruleResults.find((rule) => rule.ruleId === id).triggered));
    assert.deepEqual(result.issues.map((issue) => issue.code),
      result.assessment.triggeredRuleIds.map((id) =>
        result.assessment.ruleResults.find((rule) => rule.ruleId === id).reasonCode));
    assert.deepEqual(result.assessment.reasonCodes,
      [...new Set(result.assessment.reasonCodes)].sort());
    for (const rule of result.assessment.ruleResults) {
      for (const field of ["eventIds", "filePaths", "traceFindingCodes", "shadowFindingCodes",
        "governanceRuleIds", "governanceReasonCodes", "adminFindingCodes"]) {
        assert.deepEqual(rule[field], [...new Set(rule[field])].sort());
      }
    }
  });

  check("evaluation is pure and every returned layer is deeply frozen", () => {
    const input = structuredClone(cleanInput);
    const before = JSON.stringify(input);
    const policy = { ...DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY };
    const policyBefore = JSON.stringify(policy);
    const result = evaluateRiskBasedApprovalRoute(input, policy);
    assert.equal(JSON.stringify(input), before); assert.equal(JSON.stringify(policy), policyBefore);
    assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(policy), false);
    const visit = (value) => {
      if (value && typeof value === "object") {
        assert.equal(Object.isFrozen(value), true);
        for (const child of Object.values(value)) visit(child);
      }
    };
    visit(result);
  });

  check("malformed and adversarial structures fail without throwing", () => {
    const malformed = [null, undefined, "x", 1, true, [], () => {}, Symbol("x"), 1n,
      new Date(), new Map(), new Set(), new (class Fixture {})()];
    const cyclic = {}; cyclic.self = cyclic; malformed.push(cyclic);
    for (const value of malformed) {
      assert.doesNotThrow(() => {
        const result = evaluateRiskBasedApprovalRoute(value);
        assert.ok(["approval_route_invalid", "approval_route_needs_review"].includes(result.decision));
      });
    }
    let getterCalled = false;
    const accessor = structuredClone(cleanInput);
    Object.defineProperty(accessor, "trace", { enumerable: true,
      get() { getterCalled = true; throw new Error("getter"); } });
    assert.equal(evaluateRiskBasedApprovalRoute(accessor).decision, "approval_route_invalid");
    assert.equal(getterCalled, false);
    const symbolInput = structuredClone(cleanInput); symbolInput[Symbol("secret")] = true;
    assert.ok(evaluateRiskBasedApprovalRoute(symbolInput).issues.some((issue) =>
      issue.code === "approval_router_symbol_property"));
    const unknown = { ...structuredClone(cleanInput), unknown: true };
    assert.ok(evaluateRiskBasedApprovalRoute(unknown).issues.some((issue) =>
      issue.code === "unknown_approval_router_field"));
    const missing = structuredClone(cleanInput); delete missing.admin;
    assert.ok(evaluateRiskBasedApprovalRoute(missing).issues.some((issue) =>
      issue.code === "missing_approval_router_field"));
    for (const field of ["shadow", "admin"]) {
      const bad = structuredClone(cleanInput); bad[field] = [];
      assert.equal(evaluateRiskBasedApprovalRoute(bad).decision, "approval_route_invalid");
    }
  });

  check("bounded output contains no raw finding prose or sensitive sentinels", () => {
    const result = evaluateRiskBasedApprovalRoute(makeInput({
      shadowRisk: "high", shadowRecommendation: "escalate",
      governanceDecision: "governance_escalation_required",
      adminSemanticDecision: "admin_human_escalation_required"
    }));
    const serialized = JSON.stringify(result);
    for (const sentinel of [
      "RAW_SHADOW_COMPLETION_SENTINEL", "RAW_ADMIN_COMPLETION_SENTINEL",
      "GOVERNANCE_PROSE_SENTINEL", "SOURCE_CODE_SENTINEL", "PATCH_CONTENT_SENTINEL",
      "PLANNER_PROMPT_SENTINEL", "CODER_PROMPT_SENTINEL", "REPAIR_PROMPT_SENTINEL",
      "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENDPOINT_SENTINEL", "API_KEY_SENTINEL",
      "ENVIRONMENT_SECRET_SENTINEL"
    ]) assert.equal(serialized.includes(sentinel), false, sentinel);
  });

  check("runtime exports the complete W.17 router value API", () => {
    assert.equal(runtime.RISK_BASED_APPROVAL_ROUTER_VERSION, "2");
    assert.equal(typeof runtime.DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY, "object");
    assert.equal(typeof runtime.evaluateRiskBasedApprovalRoute, "function");
    assert.equal(Object.isFrozen(runtime.DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY), true);
  });

  console.log("risk-based approval router smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
