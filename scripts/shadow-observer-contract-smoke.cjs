const assert = require("node:assert/strict");
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertDeepFrozen(value, seen = new Set()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

(async () => {
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/shadow-observer-contract.js`
  );
  const ledgerPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/agent-event-ledger.js`
  );
  const tracePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/run-accountability-trace.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const { SHADOW_OBSERVATION_VERSION, validateShadowObservation } = await import(contractPath.href);
  const { appendAgentEvent, createAgentEventLedger, hashCanonicalJson } = await import(ledgerPath.href);
  const { buildRunAccountabilityTrace } = await import(tracePath.href);
  const runtimeIndex = await import(indexPath.href);

  const hashA = `sha256:${"a".repeat(64)}`;
  const hashPattern = /^sha256:[0-9a-f]{64}$/;

  function buildLedger(specs, runId = "shadow-run") {
    let ledger = createAgentEventLedger({ runId, objectiveHash: hashA });
    const base = Date.parse("2026-07-13T07:00:00.000Z");
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const start = base + index * 1000;
      ledger = appendAgentEvent(ledger, {
        actor: spec.actor,
        action: spec.action ?? `${spec.actor}.called`,
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date(start + (spec.durationMs ?? 50)).toISOString(),
        inputArtifactHashes: [],
        outputArtifactHashes: [],
        filesRead: spec.filesRead ?? [],
        filesProposed: spec.filesProposed ?? [],
        decision: spec.decision ?? null,
        reasonCodes: [],
        ...(spec.tokenUsage === undefined ? {} : { tokenUsage: spec.tokenUsage })
      });
    }
    return ledger;
  }

  function cleanSpecs(overrides = {}) {
    const specs = [
      { actor: "planner", action: "plan.created", filesProposed: ["a.ts", "repair.ts"], decision: "planned" },
      { actor: "coder", action: "patch.drafted", filesProposed: ["a.ts"], decision: "drafted" },
      { actor: "repairer", action: "repair.drafted", filesProposed: ["repair.ts"], decision: "repaired" },
      { actor: "deterministic_verifier", action: "patch.verified", filesRead: ["a.ts", "repair.ts"], decision: "approved" },
      { actor: "temp_workspace_apply", action: "workspace.applied", filesProposed: ["a.ts", "repair.ts"], decision: "temp_apply_ready" },
      { actor: "execution_verifier", action: "execution.verified", filesRead: ["a.ts", "repair.ts"], decision: "temp_validation_passed" }
    ];
    for (const [indexText, patch] of Object.entries(overrides)) {
      const index = Number(indexText);
      specs[index] = { ...specs[index], ...patch };
    }
    return specs;
  }

  function traceFrom(specs, runId) {
    const result = buildRunAccountabilityTrace(buildLedger(specs, runId));
    assert.ok(result.trace, JSON.stringify(result));
    return result.trace;
  }

  const cleanTrace = traceFrom(cleanSpecs());
  const infoTrace = traceFrom(cleanSpecs({ 5: { filesRead: ["a.ts", "repair.ts", "../outside.ts"] } }), "shadow-info");
  const warningTrace = traceFrom(cleanSpecs({
    0: { filesProposed: ["a.ts", "repair.ts"] },
    1: { filesProposed: ["a.ts", "extra.ts"] },
    4: { filesProposed: ["a.ts", "repair.ts", "extra.ts"] }
  }), "shadow-warning");
  const errorTrace = traceFrom(cleanSpecs({
    4: { filesProposed: ["a.ts", "repair.ts", "never-proposed.ts"] }
  }), "shadow-error");

  function baseDraft(trace = cleanTrace, overrides = {}) {
    return {
      observationVersion: "1",
      runId: trace.runId,
      traceHash: trace.traceHash,
      riskLevel: "low",
      riskScore: 10,
      confidenceScore: 90,
      findings: [],
      observedScopeDrift: false,
      observedPlanPatchMismatch: false,
      observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false,
      observedEvidenceConflict: false,
      recommendation: "continue",
      rationaleCodes: ["trace_consistent"],
      ...overrides
    };
  }

  function finding(overrides = {}, trace = cleanTrace) {
    return {
      code: "advisory_risk",
      severity: "warning",
      message: "Bounded accountability evidence warrants attention.",
      evidenceEventIds: [trace.events[0].eventId],
      evidenceFilePaths: [],
      evidenceTraceFindingCodes: [],
      ...overrides
    };
  }

  function assertDecision(result, decision, issueCode) {
    assert.equal(result.decision, decision, JSON.stringify(result.issues));
    if (issueCode !== undefined) {
      assert.ok(result.issues.some((issue) => issue.code === issueCode), JSON.stringify(result.issues));
    }
    if (decision === "shadow_observation_invalid") assert.equal(result.observation, null);
  }

  const lowResult = validateShadowObservation(cleanTrace, baseDraft());

  check("valid low-risk observation is trace-bound, hashed, and frozen", () => {
    assert.equal(SHADOW_OBSERVATION_VERSION, "1");
    assertDecision(lowResult, "shadow_observation_valid");
    assert.ok(lowResult.observation);
    assert.match(lowResult.observation.observationHash, hashPattern);
    assert.equal(lowResult.observation.traceHash, cleanTrace.traceHash);
    assert.equal(lowResult.observation.findings.length, 0);
    assert.equal(lowResult.summary.traceIntegrityVerified, true);
    assert.equal(lowResult.summary.observationHashValid, true);
    assertDeepFrozen(lowResult);
  });

  check("valid medium, high, and critical observations pass", () => {
    const medium = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
      riskLevel: "medium",
      riskScore: 35,
      recommendation: "request_repair",
      findings: [finding()]
    }));
    assertDecision(medium, "shadow_observation_valid");

    const high = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
      riskLevel: "high",
      riskScore: 60,
      recommendation: "request_replan",
      findings: [finding({ severity: "high", evidenceFilePaths: ["a.ts"] })]
    }));
    assertDecision(high, "shadow_observation_valid");

    const critical = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
      riskLevel: "critical",
      riskScore: 90,
      recommendation: "terminate",
      findings: [finding({ severity: "critical" })]
    }));
    assertDecision(critical, "shadow_observation_valid");
  });

  check("all recommendations have valid evidence-aware examples", () => {
    const cases = [
      ["continue", "low", 10, []],
      ["request_repair", "medium", 35, [finding()]],
      ["request_replan", "high", 60, [finding({ severity: "high" })]],
      ["escalate", "critical", 80, [finding({ severity: "critical" })]],
      ["terminate", "critical", 90, [finding({ severity: "critical" })]]
    ];
    for (const [recommendation, riskLevel, riskScore, findings] of cases) {
      assertDecision(
        validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { recommendation, riskLevel, riskScore, findings })),
        "shadow_observation_valid"
      );
    }
  });

  check("runId and traceHash binding rejects reuse and mismatches", () => {
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { runId: "different-run" })),
      "shadow_observation_invalid",
      "shadow_run_id_mismatch"
    );
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { traceHash: `sha256:${"b".repeat(64)}` })),
      "shadow_observation_invalid",
      "shadow_trace_hash_mismatch"
    );
    const secondTrace = traceFrom(cleanSpecs({ 1: { decision: "different_draft" } }), "second-shadow-run");
    assertDecision(
      validateShadowObservation(secondTrace, baseDraft(cleanTrace)),
      "shadow_observation_invalid",
      "shadow_run_id_mismatch"
    );
    const changedSameRun = traceFrom(cleanSpecs({ 1: { decision: "changed_same_run" } }), cleanTrace.runId);
    assertDecision(
      validateShadowObservation(changedSameRun, baseDraft(cleanTrace)),
      "shadow_observation_invalid",
      "shadow_trace_hash_mismatch"
    );
  });

  check("trace mutation and inconsistent supplied trace hashes are rejected first", () => {
    const mutated = clone(cleanTrace);
    mutated.resources.totalTokens += 1;
    assertDecision(
      validateShadowObservation(mutated, baseDraft(cleanTrace)),
      "shadow_observation_invalid",
      "trace_integrity_mismatch"
    );
    const badHash = clone(cleanTrace);
    badHash.traceHash = `sha256:${"c".repeat(64)}`;
    assertDecision(
      validateShadowObservation(badHash, baseDraft(cleanTrace)),
      "shadow_observation_invalid",
      "trace_integrity_mismatch"
    );
  });

  check("event evidence normalizes and actor attribution must match", () => {
    const plannerId = cleanTrace.events[0].eventId;
    const coderId = cleanTrace.events[1].eventId;
    const draft = baseDraft(cleanTrace, {
      findings: [finding({
        actor: "planner",
        evidenceEventIds: [coderId, plannerId, plannerId]
      })]
    });
    const result = validateShadowObservation(cleanTrace, draft);
    assertDecision(result, "shadow_observation_valid");
    assert.deepEqual(result.observation.findings[0].evidenceEventIds, [plannerId, coderId].sort());

    const mismatch = clone(draft);
    mismatch.findings[0].actor = "admin_agent";
    assertDecision(
      validateShadowObservation(cleanTrace, mismatch),
      "shadow_observation_invalid",
      "finding_actor_evidence_mismatch"
    );
    const unknown = clone(draft);
    unknown.findings[0].evidenceEventIds = ["unknown:event:000001"];
    assertDecision(
      validateShadowObservation(cleanTrace, unknown),
      "shadow_observation_invalid",
      "unknown_evidence_event_id"
    );
  });

  check("all trace file-evidence sources can be cited exactly", () => {
    const allowed = [
      cleanTrace.files.plannedFiles[0],
      cleanTrace.files.coderProposedFiles[0],
      cleanTrace.files.repairProposedFiles[0],
      cleanTrace.files.temporaryAppliedFiles[0],
      cleanTrace.files.executionReadFiles[0]
    ];
    const result = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
      findings: [finding({ evidenceEventIds: [], evidenceFilePaths: [...allowed].reverse().concat(allowed[0]) })]
    }));
    assertDecision(result, "shadow_observation_valid");
    assert.deepEqual(result.observation.findings[0].evidenceFilePaths, [...new Set(allowed)].sort());

    const suspicious = "../outside.ts";
    const suspiciousResult = validateShadowObservation(infoTrace, baseDraft(infoTrace, {
      findings: [finding({ evidenceEventIds: [], evidenceFilePaths: [suspicious] }, infoTrace)]
    }));
    assertDecision(suspiciousResult, "shadow_observation_valid");
    assert.deepEqual(suspiciousResult.observation.findings[0].evidenceFilePaths, [suspicious]);

    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ evidenceEventIds: [], evidenceFilePaths: ["not-in-trace.ts"] })]
      })),
      "shadow_observation_invalid",
      "unknown_evidence_file_path"
    );
  });

  check("trace-finding evidence normalizes and enforces deterministic severity", () => {
    const warningCode = warningTrace.findings.find((entry) => entry.severity === "warning").code;
    const warningResult = validateShadowObservation(warningTrace, baseDraft(warningTrace, {
      riskLevel: "medium",
      riskScore: 35,
      recommendation: "request_repair",
      findings: [finding({
        evidenceEventIds: [],
        evidenceTraceFindingCodes: [warningCode, warningCode]
      }, warningTrace)]
    }));
    assertDecision(warningResult, "shadow_observation_valid");
    assert.deepEqual(warningResult.observation.findings[0].evidenceTraceFindingCodes, [warningCode]);

    const errorCode = errorTrace.findings.find((entry) => entry.severity === "error").code;
    const errorResult = validateShadowObservation(errorTrace, baseDraft(errorTrace, {
      riskLevel: "high",
      riskScore: 60,
      recommendation: "request_repair",
      findings: [finding({ evidenceEventIds: [], evidenceTraceFindingCodes: [errorCode] }, errorTrace)]
    }));
    assertDecision(errorResult, "shadow_observation_valid");

    assertDecision(
      validateShadowObservation(warningTrace, baseDraft(warningTrace, {
        riskLevel: "medium",
        riskScore: 35,
        recommendation: "request_repair",
        findings: [finding({ evidenceEventIds: [], evidenceTraceFindingCodes: ["unknown_trace_code"] }, warningTrace)]
      })),
      "shadow_observation_invalid",
      "unknown_trace_finding_code"
    );
  });

  check("cited warning and error trace findings reject understated risk", () => {
    const warningCode = warningTrace.findings.find((entry) => entry.severity === "warning").code;
    assertDecision(
      validateShadowObservation(warningTrace, baseDraft(warningTrace, {
        findings: [finding({ evidenceEventIds: [], evidenceTraceFindingCodes: [warningCode] }, warningTrace)]
      })),
      "shadow_observation_invalid",
      "shadow_severity_evidence_mismatch"
    );
    const errorCode = errorTrace.findings.find((entry) => entry.severity === "error").code;
    assertDecision(
      validateShadowObservation(errorTrace, baseDraft(errorTrace, {
        riskLevel: "medium",
        riskScore: 35,
        recommendation: "request_repair",
        findings: [finding({ evidenceEventIds: [], evidenceTraceFindingCodes: [errorCode] }, errorTrace)]
      })),
      "shadow_observation_invalid",
      "shadow_severity_evidence_mismatch"
    );
  });

  check("every observation flag must exactly match its dedicated finding", () => {
    const pairs = [
      ["observedScopeDrift", "scope_drift"],
      ["observedPlanPatchMismatch", "plan_patch_mismatch"],
      ["observedRepairLoop", "repair_loop"],
      ["observedSuspiciousRoleBehavior", "suspicious_role_behavior"],
      ["observedEvidenceConflict", "evidence_conflict"]
    ];
    for (const [flag, code] of pairs) {
      const valid = baseDraft(cleanTrace, {
        [flag]: true,
        findings: [finding({ code, severity: "info" })]
      });
      assertDecision(validateShadowObservation(cleanTrace, valid), "shadow_observation_valid");

      const trueWithoutFinding = baseDraft(cleanTrace, { [flag]: true });
      assertDecision(
        validateShadowObservation(cleanTrace, trueWithoutFinding),
        "shadow_observation_invalid",
        "observation_flag_finding_mismatch"
      );
      const findingWithoutTrue = baseDraft(cleanTrace, {
        findings: [finding({ code, severity: "info" })]
      });
      assertDecision(
        validateShadowObservation(cleanTrace, findingWithoutTrue),
        "shadow_observation_invalid",
        "observation_flag_finding_mismatch"
      );
    }
  });

  check("findings are sorted by canonical severity and content order", () => {
    const findings = [
      finding({ code: "z_info", severity: "info" }),
      finding({ code: "z_warning", severity: "warning" }),
      finding({ code: "z_high", severity: "high" }),
      finding({ code: "z_critical", severity: "critical" })
    ];
    const result = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
      riskLevel: "critical",
      riskScore: 90,
      recommendation: "escalate",
      findings
    }));
    assertDecision(result, "shadow_observation_valid");
    assert.deepEqual(
      result.observation.findings.map((entry) => entry.severity),
      ["critical", "high", "warning", "info"]
    );
  });

  check("risk score band boundaries are accepted", () => {
    for (const score of [0, 24]) {
      assertDecision(validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { riskScore: score })), "shadow_observation_valid");
    }
    for (const score of [25, 49]) {
      assertDecision(validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { riskLevel: "medium", riskScore: score })), "shadow_observation_valid");
    }
    for (const score of [50, 74]) {
      assertDecision(validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        riskLevel: "high", riskScore: score, recommendation: "request_replan",
        findings: [finding({ severity: "high" })]
      })), "shadow_observation_valid");
    }
    for (const score of [75, 100]) {
      assertDecision(validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        riskLevel: "critical", riskScore: score, recommendation: "escalate",
        findings: [finding({ severity: "critical" })]
      })), "shadow_observation_valid");
    }
  });

  check("mismatched risk bands and invalid scores are rejected", () => {
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { riskScore: 25 })),
      "shadow_observation_invalid",
      "risk_level_score_mismatch"
    );
    for (const riskScore of [-1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assertDecision(
        validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { riskScore })),
        "shadow_observation_invalid",
        "invalid_shadow_risk_score"
      );
    }
    for (const confidenceScore of [-1, 101, 1.5, NaN, Infinity]) {
      assertDecision(
        validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { confidenceScore })),
        "shadow_observation_invalid",
        "invalid_shadow_confidence_score"
      );
    }
  });

  check("risk-level recommendation contradictions are rejected", () => {
    const cases = [
      ["low", 10, "terminate"],
      ["medium", 35, "terminate"],
      ["high", 60, "continue"],
      ["critical", 90, "continue"],
      ["critical", 90, "request_repair"],
      ["critical", 90, "request_replan"]
    ];
    for (const [riskLevel, riskScore, recommendation] of cases) {
      assertDecision(
        validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
          riskLevel, riskScore, recommendation,
          findings: [finding({ severity: riskLevel === "critical" ? "critical" : "high" })]
        })),
        "shadow_observation_invalid",
        "risk_recommendation_mismatch"
      );
    }
  });

  check("recommendations requiring evidence reject unsupported output", () => {
    const cases = [
      ["medium", 35, "request_repair"],
      ["high", 60, "request_replan"],
      ["medium", 35, "escalate"]
    ];
    for (const [riskLevel, riskScore, recommendation] of cases) {
      assertDecision(
        validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { riskLevel, riskScore, recommendation })),
        "shadow_observation_invalid",
        "recommendation_without_evidence"
      );
    }
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        riskLevel: "high", riskScore: 60, recommendation: "terminate",
        findings: [finding({ severity: "high" })]
      })),
      "shadow_observation_invalid",
      "recommendation_without_evidence"
    );
  });

  check("deterministic trace findings cannot be understated", () => {
    assertDecision(validateShadowObservation(infoTrace, baseDraft(infoTrace)), "shadow_observation_valid");
    assertDecision(
      validateShadowObservation(warningTrace, baseDraft(warningTrace)),
      "shadow_observation_invalid",
      "shadow_understates_trace_risk"
    );
    for (const riskLevel of ["low", "medium"]) {
      const riskScore = riskLevel === "low" ? 10 : 35;
      assertDecision(
        validateShadowObservation(errorTrace, baseDraft(errorTrace, { riskLevel, riskScore })),
        "shadow_observation_invalid",
        "shadow_understates_trace_risk"
      );
    }
    assertDecision(
      validateShadowObservation(errorTrace, baseDraft(errorTrace, {
        riskLevel: "high", riskScore: 60, recommendation: "continue",
        findings: [finding({ severity: "high" }, errorTrace)]
      })),
      "shadow_observation_invalid",
      "shadow_understates_trace_risk"
    );
  });

  check("unsupported future version needs review with no observation", () => {
    const result = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { observationVersion: "2" }));
    assertDecision(result, "shadow_observation_needs_review", "unsupported_shadow_observation_version");
    assert.equal(result.observation, null);
  });

  check("malformed primitive and object attacks never throw", () => {
    class ShadowLike {}
    const cyclic = {};
    cyclic.self = cyclic;
    for (const input of [
      null, undefined, "x", 1, true, [], () => {}, Symbol("x"), 1n,
      cyclic, new ShadowLike(), new Date(), new Map(), new Set()
    ]) {
      let result;
      assert.doesNotThrow(() => { result = validateShadowObservation(cleanTrace, input); });
      assertDecision(result, "shadow_observation_invalid");
    }
  });

  check("uncatchable proxy inspection failures safely require review", () => {
    const proxy = new Proxy({}, { ownKeys() { throw new Error("blocked"); } });
    let result;
    assert.doesNotThrow(() => { result = validateShadowObservation(cleanTrace, proxy); });
    assertDecision(result, "shadow_observation_needs_review", "validation_exception");
    assert.equal(result.observation, null);
  });

  check("top-level accessors, symbols, inheritance, unknown and missing fields are rejected", () => {
    const accessor = baseDraft();
    let invoked = false;
    delete accessor.runId;
    Object.defineProperty(accessor, "runId", { enumerable: true, get() { invoked = true; throw new Error("getter"); } });
    assertDecision(validateShadowObservation(cleanTrace, accessor), "shadow_observation_invalid", "shadow_observation_accessor_property");
    assert.equal(invoked, false);

    const symbol = baseDraft();
    symbol[Symbol("hidden")] = true;
    assertDecision(validateShadowObservation(cleanTrace, symbol), "shadow_observation_invalid", "shadow_observation_symbol_property");

    assertDecision(
      validateShadowObservation(cleanTrace, Object.create(baseDraft())),
      "shadow_observation_invalid",
      "invalid_shadow_observation_object"
    );
    const unknown = baseDraft();
    unknown.extra = true;
    assertDecision(validateShadowObservation(cleanTrace, unknown), "shadow_observation_invalid", "unknown_shadow_observation_field");
    const missing = baseDraft();
    delete missing.riskLevel;
    assertDecision(validateShadowObservation(cleanTrace, missing), "shadow_observation_invalid", "missing_shadow_observation_field");
    const suppliedHash = baseDraft();
    suppliedHash.observationHash = hashA;
    assertDecision(validateShadowObservation(cleanTrace, suppliedHash), "shadow_observation_invalid", "unknown_shadow_observation_field");
  });

  check("finding structure attacks and sparse arrays are rejected without getters", () => {
    const sparse = baseDraft();
    sparse.findings = [];
    sparse.findings.length = 1;
    assertDecision(validateShadowObservation(cleanTrace, sparse), "shadow_observation_invalid", "sparse_findings_array");

    const accessorFinding = baseDraft();
    const rawFinding = finding();
    let invoked = false;
    delete rawFinding.code;
    Object.defineProperty(rawFinding, "code", { enumerable: true, get() { invoked = true; throw new Error("getter"); } });
    accessorFinding.findings = [rawFinding];
    assertDecision(validateShadowObservation(cleanTrace, accessorFinding), "shadow_observation_invalid", "shadow_finding_accessor_property");
    assert.equal(invoked, false);

    const symbolFinding = baseDraft();
    const withSymbol = finding();
    withSymbol[Symbol("hidden")] = true;
    symbolFinding.findings = [withSymbol];
    assertDecision(validateShadowObservation(cleanTrace, symbolFinding), "shadow_observation_invalid", "shadow_finding_symbol_property");

    const unknownFinding = baseDraft();
    unknownFinding.findings = [{ ...finding(), extra: true }];
    assertDecision(validateShadowObservation(cleanTrace, unknownFinding), "shadow_observation_invalid", "unknown_shadow_finding_field");

    const inheritedFinding = baseDraft();
    inheritedFinding.findings = [Object.create(finding())];
    assertDecision(validateShadowObservation(cleanTrace, inheritedFinding), "shadow_observation_invalid", "invalid_shadow_finding");
  });

  check("finding count bound stops processing beyond 32", () => {
    const exact = baseDraft(cleanTrace, {
      findings: Array.from({ length: 32 }, (_, index) => finding({ code: `bounded_${index}` }))
    });
    assertDecision(validateShadowObservation(cleanTrace, exact), "shadow_observation_valid");

    let inspected = 0;
    const over = baseDraft();
    over.findings = Array(33).fill(null);
    Object.defineProperty(over.findings, "0", {
      enumerable: true,
      configurable: true,
      get() { inspected += 1; throw new Error("must not inspect"); }
    });
    const result = validateShadowObservation(cleanTrace, over);
    assertDecision(result, "shadow_observation_needs_review", "too_many_shadow_findings");
    assert.equal(result.observation, null);
    assert.equal(inspected, 0);
  });

  check("evidence and rationale array bounds are enforced", () => {
    const eventId = cleanTrace.events[0].eventId;
    const warningCode = warningTrace.findings.find((entry) => entry.severity === "warning").code;
    const cases = [
      [cleanTrace, "evidenceEventIds", Array(64).fill(eventId), "shadow_observation_valid"],
      [cleanTrace, "evidenceEventIds", Array(65).fill(eventId), "shadow_observation_invalid"],
      [cleanTrace, "evidenceFilePaths", Array(64).fill("a.ts"), "shadow_observation_valid"],
      [cleanTrace, "evidenceFilePaths", Array(65).fill("a.ts"), "shadow_observation_invalid"],
      [warningTrace, "evidenceTraceFindingCodes", Array(32).fill(warningCode), "shadow_observation_valid"],
      [warningTrace, "evidenceTraceFindingCodes", Array(33).fill(warningCode), "shadow_observation_invalid"]
    ];
    for (const [trace, field, values, expected] of cases) {
      const shadowFinding = finding({
        evidenceEventIds: [],
        evidenceFilePaths: [],
        evidenceTraceFindingCodes: [],
        [field]: values
      }, trace);
      const isWarningTrace = trace === warningTrace;
      const draft = baseDraft(trace, {
        ...(isWarningTrace ? { riskLevel: "medium", riskScore: 35, recommendation: "request_repair" } : {}),
        findings: [shadowFinding]
      });
      assertDecision(validateShadowObservation(trace, draft), expected);
    }

    const exactRationales = baseDraft(cleanTrace, {
      rationaleCodes: Array.from({ length: 32 }, (_, index) => `reason_${index}`)
    });
    assertDecision(validateShadowObservation(cleanTrace, exactRationales), "shadow_observation_valid");
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        rationaleCodes: Array.from({ length: 33 }, (_, index) => `reason_${index}`)
      })),
      "shadow_observation_invalid",
      "too_many_shadow_rationale_codes"
    );
  });

  check("maximum finding code and message lengths are exact", () => {
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ code: "a".repeat(128), message: "m".repeat(500) })]
      })),
      "shadow_observation_valid"
    );
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ code: "a".repeat(129) })]
      })),
      "shadow_observation_invalid",
      "invalid_shadow_finding_code"
    );
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ message: "m".repeat(501) })]
      })),
      "shadow_observation_invalid",
      "invalid_shadow_finding_message"
    );
  });

  check("invalid finding enums and unsupported findings are rejected", () => {
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ severity: "error" })]
      })),
      "shadow_observation_invalid",
      "invalid_shadow_finding_severity"
    );
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({ actor: "unknown_actor" })]
      })),
      "shadow_observation_invalid",
      "invalid_shadow_finding_actor"
    );
    assertDecision(
      validateShadowObservation(cleanTrace, baseDraft(cleanTrace, {
        findings: [finding({
          evidenceEventIds: [],
          evidenceFilePaths: [],
          evidenceTraceFindingCodes: []
        })]
      })),
      "shadow_observation_invalid",
      "finding_without_evidence"
    );
  });

  check("duplicate normalized findings need review and remain buildable", () => {
    const firstId = cleanTrace.events[0].eventId;
    const secondId = cleanTrace.events[1].eventId;
    const first = finding({ evidenceEventIds: [firstId, secondId], evidenceFilePaths: ["a.ts", "repair.ts"] });
    const second = finding({ evidenceEventIds: [secondId, firstId, firstId], evidenceFilePaths: ["repair.ts", "a.ts"] });
    const result = validateShadowObservation(cleanTrace, baseDraft(cleanTrace, { findings: [first, second] }));
    assertDecision(result, "shadow_observation_needs_review", "duplicate_shadow_finding");
    assert.ok(result.observation);
    assert.equal(result.observation.findings.length, 1);
  });

  check("observation hashing is normalized, deterministic, and complete", () => {
    const firstId = cleanTrace.events[0].eventId;
    const secondId = cleanTrace.events[1].eventId;
    const input = baseDraft(cleanTrace, {
      riskLevel: "high",
      riskScore: 60,
      recommendation: "request_replan",
      findings: [finding({
        severity: "high",
        evidenceEventIds: [secondId, firstId],
        evidenceFilePaths: ["repair.ts", "a.ts"]
      })],
      rationaleCodes: ["z_reason", "a_reason", "z_reason"]
    });
    const first = validateShadowObservation(cleanTrace, input);
    const repeated = validateShadowObservation(cleanTrace, input);
    assertDecision(first, "shadow_observation_valid");
    assert.equal(first.observation.observationHash, repeated.observation.observationHash);

    const reordered = {};
    for (const key of Object.keys(input).reverse()) reordered[key] = input[key];
    reordered.findings = input.findings.map((entry) => {
      const output = {};
      for (const key of Object.keys(entry).reverse()) output[key] = entry[key];
      output.evidenceEventIds = [...entry.evidenceEventIds].reverse();
      output.evidenceFilePaths = [...entry.evidenceFilePaths].reverse();
      return output;
    });
    reordered.rationaleCodes = [...input.rationaleCodes].reverse();
    assert.equal(
      validateShadowObservation(cleanTrace, reordered).observation.observationHash,
      first.observation.observationHash
    );

    const { observationHash, ...material } = first.observation;
    assert.equal(observationHash, hashCanonicalJson(material));
    const variants = [
      { ...input, findings: [finding({ ...input.findings[0], message: "Changed bounded message." })] },
      { ...input, findings: [finding({ ...input.findings[0], severity: "warning" })] },
      { ...input, recommendation: "escalate" },
      { ...input, riskScore: 61 }
    ];
    for (const variant of variants) {
      const result = validateShadowObservation(cleanTrace, variant);
      assertDecision(result, "shadow_observation_valid");
      assert.notEqual(result.observation.observationHash, observationHash);
    }
    const secondTrace = traceFrom(cleanSpecs({ 1: { decision: "alternate" } }), cleanTrace.runId);
    const secondObservation = validateShadowObservation(secondTrace, {
      ...input,
      runId: secondTrace.runId,
      traceHash: secondTrace.traceHash,
      findings: [finding({ severity: "high" }, secondTrace)]
    });
    assertDecision(secondObservation, "shadow_observation_valid");
    assert.notEqual(secondObservation.observation.observationHash, observationHash);
  });

  check("validator is pure and deeply freezes every returned structure", () => {
    const trace = clone(cleanTrace);
    const raw = baseDraft(trace, { findings: [finding({}, trace)] });
    const traceSnapshot = JSON.stringify(trace);
    const rawSnapshot = JSON.stringify(raw);
    const result = validateShadowObservation(trace, raw);
    assertDecision(result, "shadow_observation_valid");
    assert.equal(JSON.stringify(trace), traceSnapshot);
    assert.equal(JSON.stringify(raw), rawSnapshot);
    assert.equal(Object.isFrozen(trace), false);
    assert.equal(Object.isFrozen(raw), false);
    assertDeepFrozen(result);

    const invalid = validateShadowObservation(cleanTrace, {});
    assert.ok(invalid.issues.length > 0);
    assert.ok(invalid.issues.every(Object.isFrozen));
  });

  check("runtime index exports W.4 API", () => {
    assert.equal(runtimeIndex.SHADOW_OBSERVATION_VERSION, "1");
    assert.equal(runtimeIndex.validateShadowObservation, validateShadowObservation);
  });

  console.log("shadow observer contract smoke passed");
})();
