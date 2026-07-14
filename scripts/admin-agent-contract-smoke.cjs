const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function check(name, fn) {
  try { fn(); console.log(`[ok] ${name}`); }
  catch (error) { console.error(`[fail] ${name}`); throw error; }
}

async function main() {
  const runtime = await import(pathToFileURL(path.join(
    process.cwd(), "dist", "packages", "product-runtime", "src", "index.js"
  )).href);
  const {
    ADMIN_DECISION_VERSION, appendAgentEvent, buildRunAccountabilityTrace,
    createAgentEventLedger, evaluateDeterministicGovernance, hashCanonicalJson,
    validateAdminDecision, validateShadowObservation
  } = runtime;

  assert.equal(ADMIN_DECISION_VERSION, "1");
  const objectiveHash = hashCanonicalJson({ objective: "admin-smoke" });
  const artifactHash = hashCanonicalJson({ artifact: "bounded" });

  function makeTrace(runId = "admin-smoke-run") {
    let ledger = createAgentEventLedger({ runId, objectiveHash });
    const specs = [
      ["planner", "planner.plan", [], ["src/a.ts"], "planner_valid", []],
      ["coder", "coder.patch_draft", ["src/a.ts"], ["src/a.ts"], "coder_valid", []],
      ["deterministic_verifier", "deterministic_verifier.patch_draft", ["src/a.ts"], [], "approve", []],
      ["temp_workspace_apply", "temp_workspace_apply.apply", ["src/a.ts"], ["src/a.ts"], "temp_apply_ready", []],
      ["execution_verifier", "execution_verifier.validate", ["src/a.ts"], [], "temp_validation_passed", ["temp_workspace_cleanup_performed"]]
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
    assert.ok(result.trace);
    return result.trace;
  }

  function makeObservation(trace, riskLevel = "low", recommendation = "continue") {
    const findings = riskLevel === "low" ? [] : [{
      code: riskLevel === "critical" ? "critical_shadow_risk" : "shadow_risk",
      severity: riskLevel === "critical" ? "critical" : riskLevel === "high" ? "high" : "warning",
      message: "Bounded Shadow evidence.", evidenceEventIds: [trace.events[0].eventId],
      evidenceFilePaths: ["src/a.ts"], evidenceTraceFindingCodes: []
    }];
    const result = validateShadowObservation(trace, {
      observationVersion: "1", runId: trace.runId, traceHash: trace.traceHash,
      riskLevel, riskScore: { low: 10, medium: 35, high: 60, critical: 90 }[riskLevel],
      confidenceScore: 90, findings, observedScopeDrift: false,
      observedPlanPatchMismatch: false, observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false, observedEvidenceConflict: false,
      recommendation, rationaleCodes: ["bounded_evidence"]
    });
    assert.ok(result.observation, JSON.stringify(result));
    return result.observation;
  }

  function rehashTrace(trace, mutate) {
    const copy = structuredClone(trace); mutate(copy); delete copy.traceHash;
    copy.traceHash = hashCanonicalJson(copy); return copy;
  }

  function rehashGovernance(governance, mutate) {
    const copy = structuredClone(governance); mutate(copy);
    copy.policyHash = hashCanonicalJson(copy.policy); delete copy.governanceHash;
    copy.governanceHash = hashCanonicalJson(copy); return copy;
  }

  const trace = makeTrace();
  const observation = makeObservation(trace);
  const passed = evaluateDeterministicGovernance(trace, observation).assessment;
  assert.equal(passed.decision, "governance_passed");

  function governanceVariant(decision) {
    const configs = {
      governance_passed: null,
      governance_repair_required: ["execution_outcome", "governance_execution_failed", "high", "repair"],
      governance_replan_required: ["planned_scope_consistency", "governance_unplanned_files_proposed", "high", "replan"],
      governance_escalation_required: ["total_token_limit", "governance_total_token_limit_exceeded", "high", "escalate"],
      governance_terminated: ["forbidden_proposed_paths", "governance_forbidden_proposed_path", "critical", "terminate"]
    };
    if (!configs[decision]) return passed;
    const [ruleId, reasonCode, severity, effect] = configs[decision];
    return rehashGovernance(passed, (value) => {
      value.decision = decision;
      value.riskClass = decision === "governance_terminated" ? "critical" :
        decision === "governance_escalation_required" ? "high" : "medium";
      value.triggeredRuleIds = [ruleId]; value.reasonCodes = [reasonCode];
      value.ruleResults = value.ruleResults.map((rule) => rule.ruleId === ruleId
        ? { ...rule, triggered: true, reasonCode, severity, effect,
          eventIds: [trace.events[0].eventId], filePaths: ["src/a.ts"] }
        : rule);
      value.issues = [{ code: reasonCode, message: "Bounded governance issue.", severity,
        effect, eventIds: [trace.events[0].eventId], filePaths: ["src/a.ts"],
        traceFindingCodes: [], shadowFindingCodes: [] }];
    });
  }

  function finding(overrides = {}) {
    return {
      code: "admin_evidence", severity: "warning", message: "Bounded Admin evidence.",
      governanceRuleIds: [], governanceReasonCodes: [], governanceIssueCodes: [],
      traceFindingCodes: [], shadowFindingCodes: [],
      evidenceEventIds: [trace.events[0].eventId], evidenceFilePaths: [], ...overrides
    };
  }

  function draft(governance = passed, decision = "admin_auto_approved", overrides = {}) {
    const risks = {
      admin_auto_approved: ["low", 10], admin_repair_required: ["medium", 35],
      admin_replan_required: ["medium", 35], admin_human_escalation_required: ["high", 60],
      admin_run_terminated: ["critical", 90]
    };
    let findings = [];
    if (decision === "admin_repair_required") findings = [finding({ governanceRuleIds: ["execution_outcome"] })];
    if (decision === "admin_replan_required") findings = [finding({ governanceRuleIds: ["planned_scope_consistency"] })];
    if (decision === "admin_human_escalation_required") findings = [finding()];
    if (decision === "admin_run_terminated") findings = [finding({ severity: "critical" })];
    if (governance.decision !== "governance_passed" && findings.length) {
      findings[0] = { ...findings[0], governanceRuleIds: [governance.triggeredRuleIds[0], ...findings[0].governanceRuleIds], governanceIssueCodes: [governance.issues[0].code] };
    }
    return {
      decisionVersion: "1", runId: trace.runId, traceHash: trace.traceHash,
      observationHash: observation.observationHash, governanceHash: governance.governanceHash,
      decision, riskLevel: risks[decision][0], riskScore: risks[decision][1],
      confidenceScore: 90, findings, rationaleCodes: ["bounded_admin_review"], ...overrides
    };
  }

  check("valid auto approval is hash-bound and deeply frozen", () => {
    const input = draft();
    const result = validateAdminDecision(trace, observation, passed, input);
    assert.equal(result.decision, "admin_decision_valid", JSON.stringify(result));
    assert.equal(result.adminDecision.governanceDecision, "governance_passed");
    assert.match(result.adminDecision.adminDecisionHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.issues), true);
    assert.equal(Object.isFrozen(result.summary), true); assert.equal(Object.isFrozen(result.adminDecision), true);
    assert.equal(Object.isFrozen(result.adminDecision.findings), true);
    assert.equal(Object.isFrozen(result.adminDecision.rationaleCodes), true);
  });

  const governanceDecisions = ["governance_passed", "governance_repair_required", "governance_replan_required", "governance_escalation_required", "governance_terminated"];
  const adminDecisions = ["admin_auto_approved", "admin_repair_required", "admin_replan_required", "admin_human_escalation_required", "admin_run_terminated"];
  const allowed = {
    governance_passed: adminDecisions,
    governance_repair_required: adminDecisions.slice(1),
    governance_replan_required: adminDecisions.slice(2),
    governance_escalation_required: adminDecisions.slice(3),
    governance_terminated: adminDecisions.slice(4)
  };

  check("all 25 governance-to-Admin matrix combinations enforce exact authority", () => {
    for (const governanceDecision of governanceDecisions) {
      const governance = governanceVariant(governanceDecision);
      for (const adminDecision of adminDecisions) {
        const input = draft(governance, adminDecision);
        const result = validateAdminDecision(trace, observation, governance, input);
        assert.equal(result.decision === "admin_decision_valid", allowed[governanceDecision].includes(adminDecision), `${governanceDecision}/${adminDecision}: ${JSON.stringify(result.issues)}`);
      }
    }
  });

  check("valid repair, replan, escalation, and termination preserve governance", () => {
    for (let index = 1; index < governanceDecisions.length; index++) {
      const governance = governanceVariant(governanceDecisions[index]);
      const result = validateAdminDecision(trace, observation, governance, draft(governance, adminDecisions[index]));
      assert.equal(result.decision, "admin_decision_valid", JSON.stringify(result));
      assert.equal(result.summary.deterministicAuthorityPreserved, true);
    }
  });

  check("binding mismatches and package reuse invalidate", () => {
    for (const [field, value, code] of [
      ["runId", "other", "admin_run_id_mismatch"], ["traceHash", `sha256:${"a".repeat(64)}`, "admin_trace_hash_mismatch"],
      ["observationHash", `sha256:${"b".repeat(64)}`, "admin_observation_hash_mismatch"],
      ["governanceHash", `sha256:${"c".repeat(64)}`, "admin_governance_hash_mismatch"]
    ]) {
      const result = validateAdminDecision(trace, observation, passed, draft(passed, "admin_auto_approved", { [field]: value }));
      assert.equal(result.decision, "admin_decision_invalid"); assert.ok(result.issues.some((item) => item.code === code));
    }
    const otherTrace = makeTrace("other-run");
    assert.equal(validateAdminDecision(otherTrace, observation, passed, draft()).decision, "admin_decision_invalid");
    const otherObservation = makeObservation(trace, "medium", "continue");
    assert.equal(validateAdminDecision(trace, otherObservation, passed, draft()).decision, "admin_decision_invalid");
    const otherGovernance = governanceVariant("governance_repair_required");
    assert.equal(validateAdminDecision(trace, observation, otherGovernance, draft()).decision, "admin_decision_invalid");
  });

  check("trace, Shadow, policy, governance, and governance bindings are independently verified", () => {
    const badTrace = structuredClone(trace); badTrace.resources.totalTokens += 1;
    assert.ok(validateAdminDecision(badTrace, observation, passed, draft()).issues.some((i) => i.code === "admin_trace_integrity_mismatch"));
    const badObservation = structuredClone(observation); badObservation.riskScore += 1;
    assert.ok(validateAdminDecision(trace, badObservation, passed, draft()).issues.some((i) => i.code === "admin_shadow_observation_integrity_mismatch"));
    const badPolicy = structuredClone(passed); badPolicy.policy.maxRepairCount += 1;
    assert.ok(validateAdminDecision(trace, observation, badPolicy, draft()).issues.some((i) => i.code === "admin_governance_policy_hash_mismatch"));
    const badGovernance = structuredClone(passed); badGovernance.riskClass = "high";
    assert.ok(validateAdminDecision(trace, observation, badGovernance, draft()).issues.some((i) => i.code === "admin_governance_integrity_mismatch"));
    const wrongTrace = rehashGovernance(passed, (value) => { value.traceHash = `sha256:${"d".repeat(64)}`; });
    assert.ok(validateAdminDecision(trace, observation, wrongTrace, draft()).issues.some((i) => i.code === "admin_governance_trace_mismatch"));
    const wrongObs = rehashGovernance(passed, (value) => { value.observationHash = null; });
    assert.ok(validateAdminDecision(trace, observation, wrongObs, draft()).issues.some((i) => i.code === "admin_governance_observation_mismatch"));
  });

  check("all evidence namespaces accept known and reject unknown values", () => {
    const gov = governanceVariant("governance_escalation_required");
    const known = finding({
      governanceRuleIds: [gov.triggeredRuleIds[0]], governanceReasonCodes: [gov.reasonCodes[0]],
      governanceIssueCodes: [gov.issues[0].code], shadowFindingCodes: [],
      evidenceEventIds: [trace.events[0].eventId], evidenceFilePaths: ["src/a.ts"]
    });
    assert.equal(validateAdminDecision(trace, observation, gov, draft(gov, "admin_human_escalation_required", { findings: [known] })).decision, "admin_decision_valid");
    const cases = [
      ["governanceRuleIds", "unknown_rule", "unknown_admin_governance_rule_id"],
      ["governanceReasonCodes", "unknown_reason", "unknown_admin_governance_reason_code"],
      ["governanceIssueCodes", "unknown_issue", "unknown_admin_governance_issue_code"],
      ["traceFindingCodes", "unknown_trace", "unknown_admin_trace_finding_code"],
      ["shadowFindingCodes", "unknown_shadow", "unknown_admin_shadow_finding_code"],
      ["evidenceEventIds", "unknown_event", "unknown_admin_evidence_event_id"],
      ["evidenceFilePaths", "unknown/file", "unknown_admin_evidence_file_path"]
    ];
    for (const [field, value, code] of cases) {
      const result = validateAdminDecision(trace, observation, gov, draft(gov, "admin_human_escalation_required", { findings: [{ ...known, [field]: [value] }] }));
      assert.ok(result.issues.some((item) => item.code === code), `${field}: ${JSON.stringify(result.issues)}`);
    }
    const traceWithFinding = rehashTrace(trace, (value) => value.findings.push({
      code: "bounded_trace_note", message: "Bounded trace note.", severity: "info",
      eventIds: [value.events[0].eventId], filePaths: ["src/a.ts"]
    }));
    const shadowDraft = {
      observationVersion: "1", runId: traceWithFinding.runId, traceHash: traceWithFinding.traceHash,
      riskLevel: "high", riskScore: 60, confidenceScore: 90,
      findings: [{ code: "bounded_shadow_note", severity: "high", message: "Bounded Shadow note.",
        evidenceEventIds: [traceWithFinding.events[0].eventId], evidenceFilePaths: ["src/a.ts"],
        evidenceTraceFindingCodes: ["bounded_trace_note"] }],
      observedScopeDrift: false, observedPlanPatchMismatch: false, observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false, observedEvidenceConflict: false,
      recommendation: "escalate", rationaleCodes: ["bounded_evidence"]
    };
    const shadowWithFinding = validateShadowObservation(traceWithFinding, shadowDraft).observation;
    const governanceWithFindings = evaluateDeterministicGovernance(traceWithFinding, shadowWithFinding).assessment;
    const evidenceDraft = draft(governanceWithFindings, "admin_human_escalation_required", {
      traceHash: traceWithFinding.traceHash, observationHash: shadowWithFinding.observationHash,
      governanceHash: governanceWithFindings.governanceHash,
      findings: [finding({
        governanceRuleIds: [governanceWithFindings.triggeredRuleIds[0]],
        governanceIssueCodes: [governanceWithFindings.issues[0].code],
        traceFindingCodes: ["bounded_trace_note"], shadowFindingCodes: ["bounded_shadow_note"],
        evidenceEventIds: [traceWithFinding.events[0].eventId], evidenceFilePaths: ["src/a.ts"]
      })]
    });
    assert.equal(validateAdminDecision(traceWithFinding, shadowWithFinding, governanceWithFindings, evidenceDraft).decision, "admin_decision_valid");
  });

  check("risk boundaries, band mismatches, inherited minima, and higher risk are enforced", () => {
    for (const [riskLevel, scores] of Object.entries({ low: [0, 24], medium: [25, 49], high: [50, 74], critical: [75, 100] })) {
      for (const riskScore of scores) {
        const decision = riskLevel === "low" ? "admin_auto_approved" : riskLevel === "medium" ? "admin_repair_required" : riskLevel === "high" ? "admin_human_escalation_required" : "admin_run_terminated";
        assert.notEqual(validateAdminDecision(trace, observation, passed, draft(passed, decision, { riskLevel, riskScore })).decision, "admin_decision_invalid");
      }
    }
    assert.ok(validateAdminDecision(trace, observation, passed, draft(passed, "admin_auto_approved", { riskScore: 25 })).issues.some((i) => i.code === "admin_risk_level_score_mismatch"));
    const escalation = governanceVariant("governance_escalation_required");
    assert.ok(validateAdminDecision(trace, observation, escalation, draft(escalation, "admin_human_escalation_required", { riskLevel: "medium", riskScore: 35 })).issues.some((i) => i.code === "admin_understates_governance_risk"));
    const highObservation = makeObservation(trace, "high", "escalate");
    const highGovernance = evaluateDeterministicGovernance(trace, highObservation).assessment;
    const highDraft = { ...draft(highGovernance, "admin_human_escalation_required"), observationHash: highObservation.observationHash };
    assert.equal(validateAdminDecision(trace, highObservation, highGovernance, highDraft).summary.riskLevelValid, true);
  });

  check("decision-specific evidence and severity constraints reject unsupported combinations", () => {
    const noFindings = { findings: [] };
    for (const decision of adminDecisions.slice(1)) assert.equal(validateAdminDecision(trace, observation, passed, draft(passed, decision, noFindings)).decision, "admin_decision_invalid");
    assert.ok(validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: [finding()] })).issues.some((i) => i.code === "admin_repair_without_repair_evidence"));
    assert.ok(validateAdminDecision(trace, observation, passed, draft(passed, "admin_replan_required", { findings: [finding()] })).issues.some((i) => i.code === "admin_replan_without_replan_evidence"));
    assert.ok(validateAdminDecision(trace, observation, passed, draft(passed, "admin_run_terminated", { findings: [finding({ severity: "warning" })] })).issues.some((i) => i.code === "admin_termination_without_critical_evidence"));
    assert.ok(validateAdminDecision(trace, observation, passed, draft(passed, "admin_auto_approved", { findings: [finding({ severity: "warning" })] })).issues.some((i) => i.code === "admin_auto_approval_not_permitted"));
  });

  check("findings normalize, deduplicate for review, and enforce bounds", () => {
    const base = finding({ governanceRuleIds: ["execution_outcome", "execution_outcome"], evidenceEventIds: [trace.events[1].eventId, trace.events[0].eventId] });
    const reordered = { ...base, governanceRuleIds: [...base.governanceRuleIds].reverse(), evidenceEventIds: [...base.evidenceEventIds].reverse() };
    const duplicate = validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: [base, reordered] }));
    assert.equal(duplicate.decision, "admin_decision_needs_review"); assert.equal(duplicate.adminDecision.findings.length, 1);
    assert.equal(validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: Array(33).fill(base) })).decision, "admin_decision_needs_review");
    const maximum = Array.from({ length: 32 }, (_, index) => ({ ...base, code: `admin_evidence_${index}` }));
    assert.equal(validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: maximum })).decision, "admin_decision_valid");
    const sparse = []; sparse.length = 1;
    assert.equal(validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: sparse })).decision, "admin_decision_invalid");
    for (const bad of [
      finding({ code: "x".repeat(129) }), finding({ code: "bad code" }),
      finding({ message: "x".repeat(501) }), finding({ message: "bad\u0000message" }),
      finding({ evidenceEventIds: [] })
    ]) assert.equal(validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: [bad] })).decision, "admin_decision_invalid");
  });

  check("structure attacks never throw and strict objects reject unsafe shapes", () => {
    const attacks = [null, undefined, "x", 1, true, [], function () {}, Symbol("x"), 1n,
      new (class Attack {})(), new Date(), new Map(), new Set()];
    const cyclic = {}; cyclic.self = cyclic; attacks.push(cyclic);
    for (const attack of attacks) assert.doesNotThrow(() => {
      const result = validateAdminDecision(trace, observation, passed, attack);
      assert.notEqual(result.decision, "admin_decision_valid");
    });
    const accessor = draft(); Object.defineProperty(accessor, "decision", { get() { throw new Error("must not run"); } });
    assert.doesNotThrow(() => validateAdminDecision(trace, observation, passed, accessor));
    const symbol = draft(); symbol[Symbol("secret")] = "sentinel";
    assert.equal(validateAdminDecision(trace, observation, passed, symbol).decision, "admin_decision_invalid");
    const unknown = { ...draft(), rawOutput: "sentinel" };
    assert.equal(validateAdminDecision(trace, observation, passed, unknown).decision, "admin_decision_invalid");
    const missing = draft(); delete missing.decision;
    assert.equal(validateAdminDecision(trace, observation, passed, missing).decision, "admin_decision_invalid");
    const inherited = Object.create(draft());
    assert.equal(validateAdminDecision(trace, observation, passed, inherited).decision, "admin_decision_invalid");
    const badFinding = finding(); Object.defineProperty(badFinding, "message", { get() { throw new Error("must not run"); } });
    assert.doesNotThrow(() => validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { findings: [badFinding] })));
  });

  check("hash is canonical, complete, deterministic, and sensitive to decisions", () => {
    const first = validateAdminDecision(trace, observation, passed, draft()).adminDecision;
    const second = validateAdminDecision(trace, observation, passed, {
      findings: [], confidenceScore: 90, rationaleCodes: ["bounded_admin_review"],
      riskScore: 10, riskLevel: "low", decision: "admin_auto_approved",
      governanceHash: passed.governanceHash, observationHash: observation.observationHash,
      traceHash: trace.traceHash, runId: trace.runId, decisionVersion: "1"
    }).adminDecision;
    assert.equal(first.adminDecisionHash, second.adminDecisionHash);
    const { adminDecisionHash, ...material } = first;
    assert.equal(adminDecisionHash, hashCanonicalJson(material));
    const repairA = validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required")).adminDecision;
    const repairB = validateAdminDecision(trace, observation, passed, draft(passed, "admin_repair_required", { riskScore: 36 })).adminDecision;
    assert.notEqual(first.adminDecisionHash, repairA.adminDecisionHash);
    assert.notEqual(repairA.adminDecisionHash, repairB.adminDecisionHash);
    const messageChanged = draft(passed, "admin_repair_required"); messageChanged.findings[0].message = "Another bounded summary.";
    assert.notEqual(repairA.adminDecisionHash, validateAdminDecision(trace, observation, passed, messageChanged).adminDecision.adminDecisionHash);
    assert.notEqual(first.adminDecisionHash, validateAdminDecision(trace, observation, passed, draft(passed, "admin_auto_approved", { rationaleCodes: ["changed"] })).adminDecision.adminDecisionHash);
    const changedPolicyGovernance = evaluateDeterministicGovernance(trace, observation, { ...passed.policy, maxRepairCount: passed.policy.maxRepairCount + 1 }).assessment;
    const changedPolicyDraft = draft(changedPolicyGovernance, "admin_auto_approved", { governanceHash: changedPolicyGovernance.governanceHash });
    assert.notEqual(first.adminDecisionHash, validateAdminDecision(trace, observation, changedPolicyGovernance, changedPolicyDraft).adminDecision.adminDecisionHash);
    const changedObservation = structuredClone(observation);
    changedObservation.rationaleCodes = ["changed_observation"];
    delete changedObservation.observationHash;
    changedObservation.observationHash = hashCanonicalJson(changedObservation);
    const changedObservationGovernance = evaluateDeterministicGovernance(trace, changedObservation).assessment;
    const changedObservationDraft = draft(changedObservationGovernance, "admin_auto_approved", {
      observationHash: changedObservation.observationHash, governanceHash: changedObservationGovernance.governanceHash
    });
    assert.notEqual(first.adminDecisionHash, validateAdminDecision(trace, changedObservation, changedObservationGovernance, changedObservationDraft).adminDecision.adminDecisionHash);
  });

  check("validation is pure, deeply immutable, and leaks no raw sentinel content", () => {
    const input = draft(); const before = [trace, observation, passed, input].map((value) => JSON.stringify(value));
    const result = validateAdminDecision(trace, observation, passed, input);
    assert.deepEqual([trace, observation, passed, input].map((value) => JSON.stringify(value)), before);
    assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.issues), true);
    for (const findingValue of result.adminDecision.findings) {
      assert.equal(Object.isFrozen(findingValue), true);
      for (const [field] of [["governanceRuleIds"], ["evidenceEventIds"], ["evidenceFilePaths"]]) assert.equal(Object.isFrozen(findingValue[field]), true);
    }
    const serialized = JSON.stringify(result);
    for (const sentinel of ["SOURCE_SENTINEL", "PATCH_SENTINEL", "PLANNER_PROMPT", "CODER_PROMPT", "RAW_SHADOW", "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENDPOINT_SENTINEL", "API_KEY_SENTINEL", "ENV_SECRET_SENTINEL"]) assert.equal(serialized.includes(sentinel), false);
  });

  check("future version reviews safely and null observation binds exactly", () => {
    const future = validateAdminDecision(trace, observation, passed, draft(passed, "admin_auto_approved", { decisionVersion: "2" }));
    assert.equal(future.decision, "admin_decision_needs_review"); assert.equal(future.adminDecision, null);
    const noShadowGovernance = evaluateDeterministicGovernance(trace, null, { ...passed.policy, requireShadowObservation: false }).assessment;
    const noShadowDraft = { ...draft(noShadowGovernance), observationHash: null, governanceHash: noShadowGovernance.governanceHash };
    assert.equal(validateAdminDecision(trace, null, noShadowGovernance, noShadowDraft).decision, "admin_decision_valid");
  });

  console.log("Admin Agent contract smoke tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
