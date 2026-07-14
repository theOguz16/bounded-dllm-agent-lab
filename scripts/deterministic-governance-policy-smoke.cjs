const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function check(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

const RULE_ORDER = [
  "trace_integrity",
  "shadow_observation_integrity",
  "shadow_observation_trace_binding",
  "shadow_observation_required",
  "external_trace_anchor",
  "execution_observed",
  "execution_terminal",
  "execution_outcome",
  "cleanup_integrity",
  "forbidden_proposed_paths",
  "forbidden_applied_paths",
  "suspicious_read_or_plan_paths",
  "applied_scope_consistency",
  "planned_scope_consistency",
  "proposed_scope_without_plan",
  "scope_expansion_limit",
  "planned_file_limit",
  "proposed_file_limit",
  "temporary_applied_file_limit",
  "repair_count_limit",
  "remask_count_limit",
  "total_token_limit",
  "total_duration_limit",
  "wall_clock_limit",
  "resource_accounting_integrity",
  "classified_trace_errors",
  "classified_trace_planning_warnings",
  "classified_trace_execution_warnings",
  "classified_trace_loop_warnings",
  "unclassified_trace_error",
  "unclassified_trace_warning",
  "shadow_recommendation",
  "shadow_risk_level",
  "shadow_critical_finding",
  "shadow_high_finding",
  "deterministic_authority"
];

async function main() {
  const runtimeUrl = pathToFileURL(path.join(
    process.cwd(), "dist", "packages", "product-runtime", "src", "index.js"
  ));
  const runtime = await import(runtimeUrl.href);
  const {
    DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
    DETERMINISTIC_GOVERNANCE_VERSION,
    appendAgentEvent,
    buildRunAccountabilityTrace,
    createAgentEventLedger,
    evaluateDeterministicGovernance,
    hashCanonicalJson,
    validateShadowObservation
  } = runtime;

  const objectiveHash = hashCanonicalJson({ objective: "governance-smoke" });
  const artifactHash = hashCanonicalJson({ artifact: "bounded" });

  function makeTrace(executionDecision = "temp_validation_passed") {
    let ledger = createAgentEventLedger({
      runId: "governance-smoke-run",
      objectiveHash
    });
    const specs = [
      {
        actor: "planner", action: "planner.plan", filesRead: [],
        filesProposed: ["src/a.ts"], decision: "planner_valid", reasonCodes: []
      },
      {
        actor: "coder", action: "coder.patch_draft", filesRead: ["src/a.ts"],
        filesProposed: ["src/a.ts"], decision: "coder_valid", reasonCodes: [],
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      },
      {
        actor: "deterministic_verifier", action: "deterministic_verifier.patch_draft",
        filesRead: ["src/a.ts"], filesProposed: [], decision: "approve", reasonCodes: []
      },
      {
        actor: "temp_workspace_apply", action: "temp_workspace_apply.apply",
        filesRead: ["src/a.ts"], filesProposed: ["src/a.ts"],
        decision: "temp_apply_ready", reasonCodes: []
      },
      {
        actor: "execution_verifier", action: "execution_verifier.validate",
        filesRead: ["src/a.ts"], filesProposed: [], decision: executionDecision,
        reasonCodes: ["temp_workspace_cleanup_performed"]
      }
    ];
    const base = Date.parse("2026-07-14T08:00:00.000Z");
    for (const [index, spec] of specs.entries()) {
      ledger = appendAgentEvent(ledger, {
        ...spec,
        startedAt: new Date(base + index * 100).toISOString(),
        finishedAt: new Date(base + index * 100 + 10).toISOString(),
        inputArtifactHashes: [artifactHash],
        outputArtifactHashes: [artifactHash]
      });
    }
    const anchors = {
      expectedRunId: ledger.runId,
      expectedObjectiveHash: ledger.objectiveHash,
      expectedRootHash: ledger.rootHash,
      expectedEventCount: ledger.eventCount
    };
    const result = buildRunAccountabilityTrace(ledger, anchors);
    assert.ok(result.trace, JSON.stringify(result));
    assert.equal(result.trace.externallyAnchored, true);
    assert.equal(result.trace.externalAnchorsMatched, true);
    assert.equal(result.trace.findings.length, 0, JSON.stringify(result.trace.findings));
    return result.trace;
  }

  function rehashTrace(trace, mutate) {
    const copy = JSON.parse(JSON.stringify(trace));
    mutate(copy);
    delete copy.traceHash;
    copy.traceHash = hashCanonicalJson(copy);
    return copy;
  }

  function makeObservation(trace, options = {}) {
    const riskLevel = options.riskLevel ?? "low";
    const recommendation = options.recommendation ?? "continue";
    const severity = options.severity ?? (
      riskLevel === "critical" ? "critical" : riskLevel === "high" ? "high" : "warning"
    );
    const needsFinding = riskLevel !== "low" || options.includeFinding === true;
    const draft = {
      observationVersion: "1",
      runId: trace.runId,
      traceHash: trace.traceHash,
      riskLevel,
      riskScore: riskLevel === "low" ? 10 : riskLevel === "medium" ? 35 :
        riskLevel === "high" ? 60 : 90,
      confidenceScore: 90,
      findings: options.findings ?? (needsFinding ? [{
        code: options.findingCode ?? "advisory_risk",
        severity,
        message: options.message ?? "Bounded advisory finding.",
        evidenceEventIds: options.evidenceEventIds ?? [trace.events[0].eventId],
        evidenceFilePaths: options.evidenceFilePaths ?? [],
        evidenceTraceFindingCodes: options.evidenceTraceFindingCodes ?? []
      }] : []),
      observedScopeDrift: false,
      observedPlanPatchMismatch: false,
      observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false,
      observedEvidenceConflict: false,
      recommendation,
      rationaleCodes: ["bounded_evidence"]
    };
    const validated = validateShadowObservation(trace, draft);
    assert.ok(validated.observation, JSON.stringify(validated));
    return validated.observation;
  }

  function customPolicy(overrides = {}) {
    return { ...DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY, ...overrides };
  }

  function rule(result, id) {
    return result.assessment.ruleResults.find((candidate) => candidate.ruleId === id);
  }

  function noShadowPolicy(overrides = {}) {
    return customPolicy({ requireShadowObservation: false, ...overrides });
  }

  const cleanTrace = makeTrace();
  const cleanObservation = makeObservation(cleanTrace);
  const clean = evaluateDeterministicGovernance(cleanTrace, cleanObservation);

  check("clean anchored execution and low-risk Shadow evidence pass", () => {
    assert.equal(clean.decision, "governance_passed");
    assert.equal(clean.assessment.riskClass, "low");
    assert.equal(clean.assessment.triggeredRuleIds.length, 0);
    assert.match(clean.assessment.policyHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(clean.assessment.governanceHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(clean.summary.traceIntegrityVerified, true);
    assert.equal(clean.summary.observationIntegrityVerified, true);
    assert.equal(clean.summary.observationBoundToTrace, true);
    assert.equal(clean.summary.executionPassed, true);
    assert.equal(clean.summary.cleanupEvidenceObserved, true);
  });

  check("execution outcomes map to pass, repair, and escalation", () => {
    const failedTrace = makeTrace("temp_validation_failed");
    const reviewTrace = makeTrace("temp_validation_needs_review");
    const failed = evaluateDeterministicGovernance(failedTrace, makeObservation(failedTrace));
    const reviewed = evaluateDeterministicGovernance(reviewTrace, makeObservation(reviewTrace));
    assert.equal(failed.decision, "governance_repair_required");
    assert.equal(failed.assessment.riskClass, "high");
    assert.equal(rule(failed, "execution_outcome").effect, "repair");
    assert.equal(reviewed.decision, "governance_escalation_required");
    assert.equal(rule(reviewed, "execution_outcome").reasonCode,
      "governance_execution_needs_review");
  });

  check("missing, nonterminal, unknown, and conflicting execution evidence block", () => {
    const missing = rehashTrace(cleanTrace, (trace) => {
      trace.phaseVExecutionObserved = false;
      trace.phaseVExecutionCompleted = false;
      trace.decisions.finalExecutionDecision = null;
    });
    const unknown = rehashTrace(cleanTrace, (trace) => {
      trace.phaseVExecutionCompleted = false;
      trace.decisions.finalExecutionDecision = "future_execution_decision";
    });
    const conflict = rehashTrace(cleanTrace, (trace) => {
      trace.findings.push({
        code: "conflicting_execution_decisions", message: "fixture", severity: "error",
        eventIds: [trace.events.at(-1).eventId], filePaths: []
      });
    });
    const missingResult = evaluateDeterministicGovernance(missing, null, noShadowPolicy());
    const unknownResult = evaluateDeterministicGovernance(unknown, null, noShadowPolicy());
    const conflictResult = evaluateDeterministicGovernance(conflict, null, noShadowPolicy());
    assert.equal(missingResult.decision, "governance_escalation_required");
    assert.equal(rule(missingResult, "execution_observed").triggered, true);
    assert.equal(rule(missingResult, "execution_terminal").triggered, true);
    assert.equal(unknownResult.decision, "governance_escalation_required");
    assert.equal(rule(unknownResult, "execution_terminal").triggered, true);
    assert.equal(conflictResult.decision, "governance_terminated");
  });

  check("cleanup missing and failure escalate while conflicting evidence terminates", () => {
    const cleanupVariant = (codes) => rehashTrace(cleanTrace, (trace) => {
      trace.events.find((event) => event.actor === "execution_verifier").reasonCodes = codes;
    });
    const missing = evaluateDeterministicGovernance(cleanupVariant([]), null, noShadowPolicy());
    const failed = evaluateDeterministicGovernance(
      cleanupVariant(["temp_workspace_cleanup_failed"]), null, noShadowPolicy()
    );
    const conflict = evaluateDeterministicGovernance(cleanupVariant([
      "temp_workspace_cleanup_performed", "temp_workspace_cleanup_failed"
    ]), null, noShadowPolicy());
    assert.equal(missing.decision, "governance_escalation_required");
    assert.equal(failed.decision, "governance_escalation_required");
    assert.equal(failed.assessment.riskClass, "critical");
    assert.equal(conflict.decision, "governance_terminated");
    assert.equal(rule(conflict, "cleanup_integrity").reasonCode,
      "governance_conflicting_cleanup_evidence");
  });

  check("external anchor requirements distinguish missing and mismatched anchors", () => {
    const absent = rehashTrace(cleanTrace, (trace) => {
      trace.externallyAnchored = false;
      trace.externalAnchorsMatched = true;
    });
    const mismatch = rehashTrace(cleanTrace, (trace) => {
      trace.externallyAnchored = true;
      trace.externalAnchorsMatched = false;
    });
    assert.equal(evaluateDeterministicGovernance(absent, null, noShadowPolicy()).decision,
      "governance_escalation_required");
    assert.equal(evaluateDeterministicGovernance(mismatch, null, noShadowPolicy()).decision,
      "governance_terminated");
    assert.equal(evaluateDeterministicGovernance(absent, null, noShadowPolicy({
      requireExternalTraceAnchor: false
    })).decision, "governance_passed");
  });

  check("missing Shadow escalates and integrity or binding mismatches terminate", () => {
    const missing = evaluateDeterministicGovernance(cleanTrace, null);
    const mutatedHash = { ...cleanObservation, observationHash: `sha256:${"a".repeat(64)}` };
    const wrongBindingDraft = { ...cleanObservation, traceHash: `sha256:${"b".repeat(64)}` };
    delete wrongBindingDraft.observationHash;
    wrongBindingDraft.observationHash = hashCanonicalJson(wrongBindingDraft);
    const tamperedTrace = { ...cleanTrace, traceHash: `sha256:${"c".repeat(64)}` };
    assert.equal(missing.decision, "governance_escalation_required");
    assert.equal(evaluateDeterministicGovernance(cleanTrace, mutatedHash).decision,
      "governance_terminated");
    assert.equal(evaluateDeterministicGovernance(cleanTrace, wrongBindingDraft).decision,
      "governance_terminated");
    assert.equal(evaluateDeterministicGovernance(tamperedTrace, null).decision,
      "governance_terminated");
  });

  check("every Shadow recommendation and risk level maps without model termination authority", () => {
    const cases = [
      ["continue", "low", "none"],
      ["request_repair", "medium", "repair"],
      ["request_replan", "high", "replan"],
      ["escalate", "critical", "escalate"],
      ["terminate", "critical", "escalate"]
    ];
    for (const [recommendation, riskLevel, recommendationEffect] of cases) {
      const observation = makeObservation(cleanTrace, { recommendation, riskLevel });
      const result = evaluateDeterministicGovernance(cleanTrace, observation);
      assert.equal(rule(result, "shadow_recommendation").effect, recommendationEffect);
      if (recommendation === "continue") {
        assert.equal(result.decision, "governance_passed");
      } else if (recommendation === "request_repair") {
        assert.equal(rule(result, "shadow_recommendation").triggered, true);
      } else {
        assert.notEqual(result.decision, "governance_terminated");
      }
    }
    for (const riskLevel of ["low", "medium", "high", "critical"]) {
      const recommendation = riskLevel === "low" ? "continue" :
        riskLevel === "medium" ? "request_repair" :
          riskLevel === "high" ? "request_replan" : "escalate";
      const result = evaluateDeterministicGovernance(
        cleanTrace, makeObservation(cleanTrace, { riskLevel, recommendation })
      );
      assert.equal(rule(result, "shadow_risk_level").triggered, riskLevel !== "low");
      if (riskLevel === "critical") assert.notEqual(result.decision, "governance_terminated");
    }
  });

  check("deterministic forbidden paths and execution failures cannot be weakened by Shadow", () => {
    const forbidden = rehashTrace(cleanTrace, (trace) => {
      trace.files.allProposedFiles = ["../outside.ts"];
      trace.files.coderProposedFiles = ["../outside.ts"];
      trace.files.proposedFileCount = 1;
    });
    const forbiddenResult = evaluateDeterministicGovernance(forbidden, makeObservation(forbidden));
    const failedTrace = makeTrace("temp_validation_failed");
    const failedResult = evaluateDeterministicGovernance(failedTrace, makeObservation(failedTrace));
    assert.equal(forbiddenResult.decision, "governance_terminated");
    assert.equal(rule(forbiddenResult, "deterministic_authority").triggered, false);
    assert.equal(failedResult.decision, "governance_repair_required");
  });

  check("forbidden path classifier retains every exact original path", () => {
    const paths = [
      "../outside.ts", "/absolute/path.ts", "C:\\absolute\\file.ts",
      "\\\\server\\share.ts", ".git/config", "folder/.git/config",
      "folder\\windows-path.ts"
    ];
    const trace = rehashTrace(cleanTrace, (candidate) => {
      candidate.files.allProposedFiles = [...paths, "normal/path.ts"];
      candidate.files.proposedFileCount = paths.length + 1;
    });
    const result = evaluateDeterministicGovernance(trace, null, noShadowPolicy());
    assert.equal(result.decision, "governance_terminated");
    assert.deepEqual(rule(result, "forbidden_proposed_paths").filePaths, [...paths].sort());

    const readOnly = rehashTrace(cleanTrace, (candidate) => {
      candidate.files.plannedFiles = ["../read-only.ts"];
      candidate.files.executionReadFiles = ["/absolute/read.ts"];
    });
    const readResult = evaluateDeterministicGovernance(readOnly, null, noShadowPolicy());
    assert.equal(readResult.decision, "governance_escalation_required");
    assert.deepEqual(rule(readResult, "suspicious_read_or_plan_paths").filePaths,
      ["../read-only.ts", "/absolute/read.ts"].sort());
  });

  check("scope inconsistencies and expansion map to replan or termination", () => {
    const unplanned = rehashTrace(cleanTrace, (trace) => {
      trace.files.unplannedProposedFiles = ["src/extra.ts"];
    });
    const applied = rehashTrace(cleanTrace, (trace) => {
      trace.files.appliedButUnproposedFiles = ["src/extra.ts"];
    });
    const noPlan = rehashTrace(cleanTrace, (trace) => {
      trace.files.plannedFiles = [];
      trace.files.plannedFileCount = 0;
      trace.files.scopeExpansionFactor = null;
    });
    const equal = rehashTrace(cleanTrace, (trace) => {
      trace.files.scopeExpansionFactor = 2;
    });
    const above = rehashTrace(cleanTrace, (trace) => {
      trace.files.scopeExpansionFactor = 2.01;
    });
    assert.equal(evaluateDeterministicGovernance(unplanned, null, noShadowPolicy()).decision,
      "governance_replan_required");
    assert.equal(evaluateDeterministicGovernance(applied, null, noShadowPolicy()).decision,
      "governance_terminated");
    assert.equal(evaluateDeterministicGovernance(noPlan, null, noShadowPolicy()).decision,
      "governance_replan_required");
    assert.equal(evaluateDeterministicGovernance(equal, null, noShadowPolicy()).decision,
      "governance_passed");
    assert.equal(evaluateDeterministicGovernance(above, null, noShadowPolicy()).decision,
      "governance_replan_required");
  });

  check("file, repair, remask, and resource limits allow equality and block excess", () => {
    const fields = [
      ["plannedFileCount", "maxPlannedFiles", "planned_file_limit", "governance_replan_required"],
      ["proposedFileCount", "maxProposedFiles", "proposed_file_limit", "governance_replan_required"],
      ["temporaryAppliedFileCount", "maxTemporaryAppliedFiles", "temporary_applied_file_limit",
        "governance_escalation_required"]
    ];
    for (const [field, policyField, ruleId, decision] of fields) {
      const equal = rehashTrace(cleanTrace, (trace) => { trace.files[field] = 1; });
      const above = rehashTrace(cleanTrace, (trace) => { trace.files[field] = 2; });
      const policy = noShadowPolicy({ [policyField]: 1 });
      assert.equal(rule(evaluateDeterministicGovernance(equal, null, policy), ruleId).triggered, false);
      assert.equal(evaluateDeterministicGovernance(above, null, policy).decision, decision);
    }
    for (const [field, policyField, ruleId] of [
      ["repairCount", "maxRepairCount", "repair_count_limit"],
      ["remaskCount", "maxRemaskCount", "remask_count_limit"]
    ]) {
      const equal = rehashTrace(cleanTrace, (trace) => { trace.repairActivity[field] = 1; });
      const above = rehashTrace(cleanTrace, (trace) => { trace.repairActivity[field] = 2; });
      const policy = noShadowPolicy({ [policyField]: 1 });
      assert.equal(rule(evaluateDeterministicGovernance(equal, null, policy), ruleId).triggered, false);
      assert.equal(evaluateDeterministicGovernance(above, null, policy).decision,
        "governance_escalation_required");
    }
    for (const [field, policyField, ruleId] of [
      ["totalTokens", "maxTotalTokens", "total_token_limit"],
      ["totalDurationMs", "maxTotalDurationMs", "total_duration_limit"],
      ["wallClockSpanMs", "maxWallClockSpanMs", "wall_clock_limit"]
    ]) {
      const equal = rehashTrace(cleanTrace, (trace) => { trace.resources[field] = 100; });
      const above = rehashTrace(cleanTrace, (trace) => { trace.resources[field] = 101; });
      const policy = noShadowPolicy({ [policyField]: 100 });
      assert.equal(rule(evaluateDeterministicGovernance(equal, null, policy), ruleId).triggered, false);
      assert.equal(evaluateDeterministicGovernance(above, null, policy).decision,
        "governance_escalation_required");
    }
  });

  check("classified and future W.3 findings use deterministic mappings", () => {
    const cases = [
      ["temporary_apply_scope_mismatch", "error", "governance_terminated"],
      ["conflicting_execution_decisions", "error", "governance_terminated"],
      ["resource_total_overflow", "error", "governance_terminated"],
      ["proposed_files_without_plan", "warning", "governance_replan_required"],
      ["unplanned_files_proposed", "warning", "governance_replan_required"],
      ["missing_planner_event", "warning", "governance_replan_required"],
      ["missing_coder_event", "warning", "governance_replan_required"],
      ["missing_deterministic_verifier_event", "warning", "governance_replan_required"],
      ["missing_execution_verifier_event", "warning", "governance_escalation_required"],
      ["execution_terminal_decision_missing", "warning", "governance_escalation_required"],
      ["high_repair_count", "warning", "governance_escalation_required"],
      ["high_remask_count", "warning", "governance_escalation_required"],
      ["future_error", "error", "governance_escalation_required"],
      ["future_warning", "warning", "governance_escalation_required"],
      ["informational_only", "info", "governance_passed"]
    ];
    for (const [code, severity, expected] of cases) {
      const trace = rehashTrace(cleanTrace, (candidate) => {
        candidate.findings = [{
          code, severity, message: "ignored prose", eventIds: [candidate.events[0].eventId],
          filePaths: ["src/a.ts"]
        }];
      });
      const result = evaluateDeterministicGovernance(trace, null, noShadowPolicy());
      assert.equal(result.decision, expected, code);
    }
  });

  check("high and critical Shadow findings escalate with normalized bounded evidence", () => {
    for (const severity of ["high", "critical"]) {
      const riskLevel = severity;
      const recommendation = severity === "high" ? "request_replan" : "escalate";
      const observation = makeObservation(cleanTrace, {
        riskLevel, recommendation, severity,
        evidenceEventIds: [cleanTrace.events[1].eventId, cleanTrace.events[0].eventId,
          cleanTrace.events[1].eventId],
        evidenceFilePaths: ["src/a.ts", "src/a.ts"]
      });
      const result = evaluateDeterministicGovernance(cleanTrace, observation);
      const target = rule(result, severity === "high" ? "shadow_high_finding" :
        "shadow_critical_finding");
      assert.equal(target.triggered, true);
      assert.deepEqual(target.eventIds, [cleanTrace.events[0].eventId, cleanTrace.events[1].eventId]);
      assert.deepEqual(target.filePaths, ["src/a.ts"]);
      assert.notEqual(result.decision, "governance_terminated");
    }
    const info = makeObservation(cleanTrace, {
      includeFinding: true, severity: "info", findingCode: "informational_shadow"
    });
    const infoResult = evaluateDeterministicGovernance(cleanTrace, info);
    assert.equal(infoResult.decision, "governance_passed");
    assert.deepEqual(rule(infoResult, "shadow_risk_level").shadowFindingCodes,
      ["informational_shadow"]);
  });

  check("multiple Shadow findings normalize set evidence and exclude messages from rules", () => {
    const finding = (code, message, eventIds) => ({
      code,
      severity: "high",
      message,
      evidenceEventIds: eventIds,
      evidenceFilePaths: ["src/a.ts", "src/a.ts"],
      evidenceTraceFindingCodes: []
    });
    const forward = makeObservation(cleanTrace, {
      riskLevel: "high",
      recommendation: "request_replan",
      findings: [
        finding("second_risk", "SECOND_MESSAGE", [cleanTrace.events[1].eventId]),
        finding("first_risk", "FIRST_MESSAGE", [
          cleanTrace.events[1].eventId, cleanTrace.events[0].eventId,
          cleanTrace.events[1].eventId
        ])
      ]
    });
    const reordered = makeObservation(cleanTrace, {
      riskLevel: "high",
      recommendation: "request_replan",
      findings: [
        finding("first_risk", "FIRST_MESSAGE", [
          cleanTrace.events[0].eventId, cleanTrace.events[1].eventId
        ]),
        finding("second_risk", "SECOND_MESSAGE", [cleanTrace.events[1].eventId])
      ]
    });
    assert.equal(forward.observationHash, reordered.observationHash);
    const first = evaluateDeterministicGovernance(cleanTrace, forward);
    const second = evaluateDeterministicGovernance(cleanTrace, reordered);
    assert.equal(first.assessment.governanceHash, second.assessment.governanceHash);
    assert.deepEqual(rule(first, "shadow_high_finding").shadowFindingCodes,
      ["first_risk", "second_risk"]);
    assert.ok(!JSON.stringify(first.assessment.ruleResults).includes("FIRST_MESSAGE"));

    const changedMessage = makeObservation(cleanTrace, {
      riskLevel: "high",
      recommendation: "request_replan",
      findings: [finding("first_risk", "CHANGED_MESSAGE", [cleanTrace.events[0].eventId])]
    });
    const baselineMessage = makeObservation(cleanTrace, {
      riskLevel: "high",
      recommendation: "request_replan",
      findings: [finding("first_risk", "BASELINE_MESSAGE", [cleanTrace.events[0].eventId])]
    });
    const changed = evaluateDeterministicGovernance(cleanTrace, changedMessage);
    const baseline = evaluateDeterministicGovernance(cleanTrace, baselineMessage);
    assert.deepEqual(changed.assessment.ruleResults, baseline.assessment.ruleResults);
    assert.notEqual(changed.assessment.governanceHash, baseline.assessment.governanceHash);
  });

  check("effect precedence and risk classes are canonical", () => {
    const failed = makeTrace("temp_validation_failed");
    assert.equal(evaluateDeterministicGovernance(failed, makeObservation(failed)).assessment.riskClass,
      "high");
    const repairReplan = rehashTrace(failed, (trace) => {
      trace.files.unplannedProposedFiles = ["src/extra.ts"];
    });
    assert.equal(evaluateDeterministicGovernance(repairReplan, null, noShadowPolicy()).decision,
      "governance_replan_required");
    const escalated = rehashTrace(repairReplan, (trace) => { trace.resources.totalTokens = 2_000_000; });
    assert.equal(evaluateDeterministicGovernance(escalated, null, noShadowPolicy()).decision,
      "governance_escalation_required");
    const terminated = rehashTrace(escalated, (trace) => {
      trace.files.allProposedFiles = ["../outside.ts"];
    });
    const terminatedResult = evaluateDeterministicGovernance(terminated, null, noShadowPolicy());
    assert.equal(terminatedResult.decision, "governance_terminated");
    assert.equal(terminatedResult.assessment.riskClass, "critical");
  });

  check("custom policy normalization is pure, strict, and hash-sensitive", () => {
    const copied = { ...DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY };
    const copiedBefore = JSON.stringify(copied);
    const same = evaluateDeterministicGovernance(cleanTrace, cleanObservation, copied);
    assert.equal(same.assessment.policyHash, clean.assessment.policyHash);
    const reversedPolicy = Object.fromEntries(Object.entries(copied).reverse());
    assert.equal(evaluateDeterministicGovernance(cleanTrace, cleanObservation, reversedPolicy)
      .assessment.policyHash, clean.assessment.policyHash);
    assert.equal(JSON.stringify(copied), copiedBefore);
    assert.equal(Object.isFrozen(copied), false);
    const changed = evaluateDeterministicGovernance(cleanTrace, cleanObservation, {
      ...copied, maxPlannedFiles: 21
    });
    assert.notEqual(changed.assessment.policyHash, clean.assessment.policyHash);
    const relaxedExecution = evaluateDeterministicGovernance(
      makeTrace("temp_validation_failed"), null,
      noShadowPolicy({ requireSuccessfulExecutionForPass: false })
    );
    assert.equal(relaxedExecution.decision, "governance_passed");
    const twoPlanned = rehashTrace(cleanTrace, (trace) => {
      trace.files.plannedFileCount = 2;
    });
    assert.equal(evaluateDeterministicGovernance(twoPlanned, null, noShadowPolicy({
      maxPlannedFiles: 3
    })).decision, "governance_passed");
    const noCleanupTrace = rehashTrace(cleanTrace, (trace) => {
      trace.events.at(-1).reasonCodes = [];
    });
    assert.equal(evaluateDeterministicGovernance(noCleanupTrace, null, noShadowPolicy({
      requireCleanupEvidenceForPass: false
    })).decision, "governance_passed");
    const noExecution = rehashTrace(noCleanupTrace, (trace) => {
      trace.phaseVExecutionObserved = false;
      trace.phaseVExecutionCompleted = false;
      trace.decisions.finalExecutionDecision = null;
    });
    assert.equal(evaluateDeterministicGovernance(noExecution, null, noShadowPolicy({
      requireExecutionTerminalDecision: false,
      requireSuccessfulExecutionForPass: false,
      requireCleanupEvidenceForPass: false
    })).decision, "governance_passed");

    const invalidPolicies = [
      null,
      { ...copied, policyVersion: "2" },
      { ...copied, unexpected: true },
      Object.fromEntries(Object.entries(copied).filter(([key]) => key !== "maxRepairCount")),
      { ...copied, requireShadowObservation: 1 },
      { ...copied, maxPlannedFiles: 0 },
      { ...copied, maxRepairCount: 1.5 },
      { ...copied, maxTotalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...copied, maxScopeExpansionFactor: 0.5 },
      { ...copied, maxScopeExpansionFactor: Number.NaN },
      { ...copied, maxScopeExpansionFactor: Infinity },
      Object.assign(Object.create({ inherited: true }), copied),
      { ...copied, [Symbol("unexpected")]: true }
    ];
    for (const policy of invalidPolicies) {
      assert.throws(() => evaluateDeterministicGovernance(cleanTrace, cleanObservation, policy),
        TypeError);
    }
  });

  check("policy and governance hashes are exactly reproducible and evidence-sensitive", () => {
    const repeated = evaluateDeterministicGovernance(cleanTrace, cleanObservation);
    assert.equal(repeated.assessment.governanceHash, clean.assessment.governanceHash);
    assert.equal(repeated.assessment.policyHash,
      hashCanonicalJson(repeated.assessment.policy));
    const { governanceHash, ...material } = repeated.assessment;
    assert.equal(governanceHash, hashCanonicalJson(material));
    const roundTrip = evaluateDeterministicGovernance(
      JSON.parse(JSON.stringify(cleanTrace)), JSON.parse(JSON.stringify(cleanObservation))
    );
    assert.equal(roundTrip.assessment.governanceHash, governanceHash);
    const changedTrace = rehashTrace(cleanTrace, (trace) => { trace.resources.totalDurationMs += 1; });
    const changedTraceResult = evaluateDeterministicGovernance(
      changedTrace, makeObservation(changedTrace)
    );
    assert.notEqual(changedTraceResult.assessment.governanceHash, governanceHash);
    const changedObservation = makeObservation(cleanTrace, {
      includeFinding: true, severity: "info", findingCode: "new_information"
    });
    assert.notEqual(evaluateDeterministicGovernance(cleanTrace, changedObservation)
      .assessment.governanceHash, governanceHash);
    assert.notEqual(evaluateDeterministicGovernance(cleanTrace, cleanObservation, customPolicy({
      maxWallClockSpanMs: 900_001
    })).assessment.governanceHash, governanceHash);
  });

  check("every rule appears once in canonical order and triggered views retain that order", () => {
    assert.deepEqual(clean.assessment.ruleResults.map((candidate) => candidate.ruleId), RULE_ORDER);
    assert.equal(new Set(RULE_ORDER).size, RULE_ORDER.length);
    const combined = rehashTrace(cleanTrace, (trace) => {
      trace.files.unplannedProposedFiles = ["src/extra.ts"];
      trace.resources.totalTokens = 2_000_000;
      trace.files.allProposedFiles = ["../outside.ts"];
    });
    const result = evaluateDeterministicGovernance(combined, null, noShadowPolicy());
    const expected = result.assessment.ruleResults
      .filter((candidate) => candidate.triggered).map((candidate) => candidate.ruleId);
    assert.deepEqual(result.assessment.triggeredRuleIds, expected);
    assert.deepEqual(result.assessment.issues.map((issue) => issue.code),
      result.assessment.ruleResults.filter((candidate) => candidate.triggered)
        .map((candidate) => candidate.reasonCode));
    assert.deepEqual(result.assessment.reasonCodes,
      [...new Set(result.assessment.reasonCodes)].sort());
  });

  check("results are deeply frozen without freezing caller inputs", () => {
    const trace = JSON.parse(JSON.stringify(cleanTrace));
    const observation = JSON.parse(JSON.stringify(cleanObservation));
    const policy = { ...DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY };
    const before = JSON.stringify({ trace, observation, policy });
    const result = evaluateDeterministicGovernance(trace, observation, policy);
    assert.equal(JSON.stringify({ trace, observation, policy }), before);
    assert.equal(Object.isFrozen(trace), false);
    assert.equal(Object.isFrozen(observation), false);
    assert.equal(Object.isFrozen(policy), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.assessment), true);
    assert.equal(Object.isFrozen(result.assessment.policy), true);
    assert.equal(Object.isFrozen(result.issues), true);
    assert.equal(Object.isFrozen(result.issues[0] ?? result.assessment.ruleResults), true);
    assert.equal(Object.isFrozen(result.assessment.ruleResults), true);
    assert.equal(Object.isFrozen(result.assessment.ruleResults[0]), true);
    assert.equal(Object.isFrozen(result.assessment.ruleResults[0].eventIds), true);
    assert.equal(Object.isFrozen(result.summary), true);
    const issueResult = evaluateDeterministicGovernance(cleanTrace, null);
    assert.equal(Object.isFrozen(issueResult.issues[0]), true);
    assert.equal(Object.isFrozen(issueResult.issues[0].eventIds), true);
    assert.equal(Object.isFrozen(issueResult.assessment.triggeredRuleIds), true);
    assert.equal(Object.isFrozen(issueResult.assessment.reasonCodes), true);
    assert.equal(Object.isFrozen(DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY), true);
  });

  check("Shadow messages and prohibited sentinel data never enter governance output", () => {
    const sentinelObservation = makeObservation(cleanTrace, {
      riskLevel: "critical",
      recommendation: "escalate",
      severity: "critical",
      message: "SOURCE_SENTINEL PATCH_SENTINEL PROMPT_SENTINEL RAW_MODEL_SENTINEL " +
        "STDOUT_SENTINEL STDERR_SENTINEL ENDPOINT_SENTINEL ENV_SECRET_SENTINEL"
    });
    const serialized = JSON.stringify(evaluateDeterministicGovernance(
      cleanTrace, sentinelObservation
    ));
    for (const sentinel of [
      "SOURCE_SENTINEL", "PATCH_SENTINEL", "PROMPT_SENTINEL", "RAW_MODEL_SENTINEL",
      "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENDPOINT_SENTINEL", "ENV_SECRET_SENTINEL"
    ]) assert.ok(!serialized.includes(sentinel), sentinel);
  });

  check("malformed and tampered runtime evidence terminates without unsafe continuation", () => {
    for (const trace of [null, {}, { traceHash: "bad" }, new Proxy({}, {
      get() { throw new Error("blocked getter"); }
    })]) {
      const result = evaluateDeterministicGovernance(trace, null, noShadowPolicy());
      assert.equal(result.decision, "governance_terminated");
      assert.ok(result.assessment);
      assert.equal(rule(result, "trace_integrity").triggered, true);
    }
    const malformedObservation = evaluateDeterministicGovernance(cleanTrace, {},
      DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY);
    assert.equal(malformedObservation.decision, "governance_terminated");
    assert.equal(rule(malformedObservation, "shadow_observation_integrity").triggered, true);
    assert.equal(rule(malformedObservation, "trace_integrity").triggered, false);
  });

  check("runtime index exports the complete W.7 value API", () => {
    assert.equal(DETERMINISTIC_GOVERNANCE_VERSION, "1");
    assert.equal(DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY.policyVersion, "1");
    assert.equal(typeof evaluateDeterministicGovernance, "function");
  });

  console.log("deterministic governance policy smoke passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
