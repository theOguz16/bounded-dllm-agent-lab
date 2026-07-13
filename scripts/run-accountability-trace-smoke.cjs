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
  const tracePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/run-accountability-trace.js`
  );
  const ledgerPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/agent-event-ledger.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const { RUN_ACCOUNTABILITY_TRACE_VERSION, buildRunAccountabilityTrace } = await import(tracePath.href);
  const { appendAgentEvent, canonicalizeJson, createAgentEventLedger, hashCanonicalJson } = await import(ledgerPath.href);
  const runtimeIndex = await import(indexPath.href);

  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const hashPattern = /^sha256:[0-9a-f]{64}$/;
  const roleOrder = [
    "planner",
    "coder",
    "deterministic_verifier",
    "masker",
    "repairer",
    "repair_verifier",
    "patch_dry_run",
    "temp_workspace_apply",
    "execution_verifier",
    "shadow_observer",
    "deterministic_governor",
    "admin_agent",
    "approval_router"
  ];

  function buildLedger(specs, options = {}) {
    let ledger = createAgentEventLedger({
      runId: options.runId ?? "run-w3",
      objectiveHash: options.objectiveHash ?? hashA
    });
    const baseMs = Date.parse("2026-07-13T07:00:00.000Z");
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const startedMs = spec.startedMs ?? baseMs + index * 2000;
      const durationMs = spec.durationMs ?? 100;
      ledger = appendAgentEvent(ledger, {
        actor: spec.actor,
        action: spec.action ?? `${spec.actor}.called`,
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date(startedMs + durationMs).toISOString(),
        inputArtifactHashes: spec.inputArtifactHashes ?? [],
        outputArtifactHashes: spec.outputArtifactHashes ?? [],
        filesRead: spec.filesRead ?? [],
        filesProposed: spec.filesProposed ?? [],
        decision: spec.decision ?? null,
        reasonCodes: spec.reasonCodes ?? [],
        ...(spec.tokenUsage === undefined ? {} : { tokenUsage: spec.tokenUsage })
      });
    }
    return ledger;
  }

  function completedSpecs(executionDecision = "temp_validation_passed", overrides = {}) {
    const specs = [
      { actor: "planner", action: "plan.created", decision: "plan_ready", filesProposed: ["a.ts", "b.ts"], durationMs: 100, tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { actor: "coder", action: "patch.drafted", decision: "patch_ready", filesProposed: ["a.ts", "b.ts"], durationMs: 200, tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
      { actor: "deterministic_verifier", action: "patch.verified", decision: "needs_repair", filesRead: ["a.ts", "b.ts"], durationMs: 50 },
      { actor: "masker", action: "repair.remasked", decision: "remask_ready", durationMs: 40 },
      { actor: "repairer", action: "repair.drafted", decision: "repair_ready", filesProposed: ["b.ts"], durationMs: 60, tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      { actor: "repair_verifier", action: "repair.verified", decision: "repair_approved", durationMs: 70 },
      { actor: "patch_dry_run", action: "patch.dry_run", decision: "ready_to_apply", durationMs: 80 },
      { actor: "temp_workspace_apply", action: "workspace.applied", decision: "temp_apply_ready", filesProposed: ["a.ts", "b.ts"], durationMs: 90 },
      { actor: "execution_verifier", action: "execution.verified", decision: executionDecision, filesRead: ["a.ts", "b.ts"], durationMs: 110, tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    ];
    for (const [indexText, patch] of Object.entries(overrides)) {
      const index = Number(indexText);
      specs[index] = { ...specs[index], ...patch };
    }
    return specs;
  }

  function assertDecision(result, decision, findingCode) {
    assert.equal(result.decision, decision, JSON.stringify({ issues: result.issues, findings: result.findings }));
    if (findingCode !== undefined) {
      assert.ok(result.findings.some((finding) => finding.code === findingCode), JSON.stringify(result.findings));
    }
  }

  function traceFor(specs, options) {
    return buildRunAccountabilityTrace(buildLedger(specs), options);
  }

  const completedLedger = buildLedger(completedSpecs());
  const completed = buildRunAccountabilityTrace(completedLedger);

  check("valid completed Phase V trace is ready", () => {
    assert.equal(RUN_ACCOUNTABILITY_TRACE_VERSION, "1");
    assertDecision(completed, "trace_ready");
    assert.equal(completed.summary.ledgerValid, true);
    assert.ok(completed.trace);
    assert.match(completed.trace.traceHash, hashPattern);
    assert.equal(completed.summary.traceHashValid, true);
    assert.equal(completed.trace.phaseVExecutionObserved, true);
    assert.equal(completed.trace.phaseVExecutionCompleted, true);
    assert.deepEqual(completed.trace.rolesCalled, roleOrder.slice(0, 9));
    assert.deepEqual(completed.trace.files.plannedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(completed.trace.files.allProposedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(completed.trace.files.temporaryAppliedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(completed.trace.files.unplannedProposedFiles, []);
    assert.deepEqual(completed.trace.files.appliedButUnproposedFiles, []);
    assert.equal(completed.trace.files.scopeExpansionFactor, 1);
    assert.equal(completed.trace.repairActivity.repairCount, 1);
    assert.equal(completed.trace.repairActivity.remaskCount, 1);
    assert.equal(completed.trace.decisions.finalExecutionDecision, "temp_validation_passed");
    assert.equal(completed.trace.resources.totalDurationMs, 800);
    assert.equal(completed.trace.resources.totalTokens, 45);
    assert.equal(completed.trace.resources.eventsWithTokenUsage, 4);
    assert.equal(completed.trace.resources.eventsWithoutTokenUsage, 5);
    assert.equal(completed.trace.resources.longestEventId, "run-w3:event:000002");
    assert.equal(completed.trace.resources.longestEventDurationMs, 200);
    assert.equal(completed.trace.resources.wallClockSpanMs, 16110);
    assert.deepEqual(completed.findings, []);
  });

  check("terminal failure and needs-review outcomes remain structurally ready", () => {
    for (const decision of ["temp_validation_failed", "temp_validation_needs_review"]) {
      const result = traceFor(completedSpecs(decision));
      assertDecision(result, "trace_ready");
      assert.equal(result.trace.phaseVExecutionCompleted, true);
      assert.equal(result.trace.decisions.finalExecutionDecision, decision);
    }
  });

  check("invalid and needs-review ledger decisions propagate without a trace", () => {
    const invalid = clone(completedLedger);
    invalid.rootHash = hashB;
    const invalidResult = buildRunAccountabilityTrace(invalid);
    assertDecision(invalidResult, "trace_invalid");
    assert.equal(invalidResult.trace, null);
    assert.equal(invalidResult.findings.length, 0);
    assert.equal(invalidResult.summary.ledgerInvalid, true);

    const future = clone(completedLedger);
    future.ledgerVersion = "2";
    const reviewResult = buildRunAccountabilityTrace(future);
    assertDecision(reviewResult, "trace_needs_review");
    assert.equal(reviewResult.trace, null);
    assert.equal(reviewResult.findings.length, 0);
    assert.equal(reviewResult.summary.ledgerNeedsReview, true);
  });

  check("external root options are passed through W.2", () => {
    const matched = buildRunAccountabilityTrace(completedLedger, { expectedRootHash: completedLedger.rootHash });
    const repeatedMatch = buildRunAccountabilityTrace(completedLedger, { expectedRootHash: completedLedger.rootHash });
    assertDecision(matched, "trace_ready");
    assert.equal(matched.trace.externallyAnchored, true);
    assert.equal(matched.trace.externalAnchorsMatched, true);
    assert.equal(matched.trace.traceHash, repeatedMatch.trace.traceHash);
    assert.notEqual(matched.trace.traceHash, completed.trace.traceHash);

    const mismatch = buildRunAccountabilityTrace(completedLedger, { expectedRootHash: hashB });
    assertDecision(mismatch, "trace_invalid");
    assert.ok(mismatch.issues.some((issue) => issue.code === "external_root_hash_anchor_mismatch"));
  });

  check("invalid trusted options throw TypeError", () => {
    assert.throws(
      () => buildRunAccountabilityTrace(completedLedger, { expectedRootHash: "bad" }),
      TypeError
    );
  });

  check("empty ledger builds a review trace with empty resources", () => {
    const result = buildRunAccountabilityTrace(createAgentEventLedger({ runId: "empty-run", objectiveHash: hashA }));
    assertDecision(result, "trace_needs_review", "empty_run_trace");
    assert.ok(result.trace);
    for (const code of [
      "missing_planner_event",
      "missing_coder_event",
      "missing_deterministic_verifier_event",
      "missing_execution_verifier_event",
      "execution_terminal_decision_missing"
    ]) assert.ok(result.findings.some((finding) => finding.code === code));
    assert.equal(result.trace.resources.firstStartedAt, null);
    assert.equal(result.trace.resources.lastFinishedAt, null);
    assert.equal(result.trace.resources.wallClockSpanMs, 0);
    assert.equal(result.trace.resources.longestEventId, null);
    assert.equal(result.trace.resources.longestEventDurationMs, 0);
  });

  check("incrementally incomplete ledgers retain trusted traces and findings", () => {
    const cases = [
      [[{ actor: "planner", decision: "planned" }], ["missing_coder_event", "missing_deterministic_verifier_event", "missing_execution_verifier_event"]],
      [[{ actor: "planner" }, { actor: "coder" }], ["missing_deterministic_verifier_event", "missing_execution_verifier_event"]],
      [[{ actor: "planner" }, { actor: "coder" }, { actor: "deterministic_verifier" }], ["missing_execution_verifier_event"]]
    ];
    for (const [specs, codes] of cases) {
      const result = traceFor(specs);
      assertDecision(result, "trace_needs_review");
      assert.ok(result.trace);
      for (const code of codes) assert.ok(result.findings.some((finding) => finding.code === code));
    }
  });

  check("execution events without a terminal final decision require review", () => {
    for (const decision of [null, "unknown_execution_state"]) {
      const specs = completedSpecs();
      specs[8] = { ...specs[8], decision };
      const result = traceFor(specs);
      assertDecision(result, "trace_needs_review", "execution_terminal_decision_missing");
      assert.equal(result.trace.phaseVExecutionObserved, true);
      assert.equal(result.trace.phaseVExecutionCompleted, false);
    }
  });

  check("planner and proposal file unions are deduplicated and sorted", () => {
    const specs = completedSpecs();
    specs.splice(2, 0, { actor: "coder", filesProposed: ["b.ts", "a.ts"], decision: "patch_ready" });
    const result = traceFor(specs);
    assert.deepEqual(result.trace.files.plannedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(result.trace.files.coderProposedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(result.trace.files.allProposedFiles, ["a.ts", "b.ts"]);
  });

  check("proposal without planner scope creates both scope warnings", () => {
    const specs = completedSpecs("temp_validation_passed", {
      0: { filesProposed: [] },
      1: { filesProposed: ["unplanned.ts"] },
      4: { filesProposed: [] },
      7: { filesProposed: ["unplanned.ts"] }
    });
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "proposed_files_without_plan");
    assert.ok(result.findings.some((finding) => finding.code === "unplanned_files_proposed"));
    assert.deepEqual(result.trace.files.unplannedProposedFiles, ["unplanned.ts"]);
    assert.equal(result.trace.files.scopeExpansionFactor, null);
  });

  check("coder and repairer unplanned files are attributed", () => {
    const specs = completedSpecs("temp_validation_passed", {
      1: { filesProposed: ["a.ts", "coder-extra.ts"] },
      4: { filesProposed: ["b.ts", "repair-extra.ts"] },
      7: { filesProposed: ["a.ts", "b.ts", "coder-extra.ts", "repair-extra.ts"] }
    });
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "unplanned_files_proposed");
    assert.deepEqual(result.trace.files.unplannedProposedFiles, ["coder-extra.ts", "repair-extra.ts"]);
    assert.deepEqual(
      result.findings.find((finding) => finding.code === "unplanned_files_proposed").filePaths,
      ["coder-extra.ts", "repair-extra.ts"]
    );
  });

  check("temporary apply scope mismatch is an error finding", () => {
    const specs = completedSpecs("temp_validation_passed", {
      7: { filesProposed: ["a.ts", "b.ts", "never-proposed.ts"] }
    });
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "temporary_apply_scope_mismatch");
    assert.equal(result.findings.find((finding) => finding.code === "temporary_apply_scope_mismatch").severity, "error");
    assert.deepEqual(result.trace.files.appliedButUnproposedFiles, ["never-proposed.ts"]);
  });

  check("scope expansion factors preserve exact ratios", () => {
    const cases = [
      [["a.ts", "b.ts"], ["a.ts", "b.ts"], 1],
      [["a.ts", "b.ts"], ["a.ts", "b.ts", "c.ts"], 1.5],
      [[], [], 1],
      [[], ["a.ts"], null]
    ];
    for (const [planned, proposed, expected] of cases) {
      const specs = completedSpecs("temp_validation_passed", {
        0: { filesProposed: planned },
        1: { filesProposed: proposed },
        4: { filesProposed: [] },
        7: { filesProposed: proposed }
      });
      assert.equal(traceFor(specs).trace.files.scopeExpansionFactor, expected);
    }
  });

  check("suspicious paths remain exact and informational only", () => {
    const suspicious = ["../outside.ts", "/absolute/path.ts", ".git/config", "folder\\windows-path.ts"];
    const specs = completedSpecs("temp_validation_passed", { 8: { filesRead: suspicious } });
    const result = traceFor(specs);
    assertDecision(result, "trace_ready", "suspicious_path_evidence_observed");
    assert.deepEqual(result.trace.files.executionReadFiles, [...suspicious].sort());
    assert.deepEqual(
      result.findings.find((finding) => finding.code === "suspicious_path_evidence_observed").filePaths,
      [...suspicious].sort()
    );
  });

  check("decision chronology, null exclusion, and final non-null decisions are preserved", () => {
    const specs = completedSpecs();
    specs.splice(3, 0,
      { actor: "deterministic_verifier", action: "verify.again", decision: null },
      { actor: "deterministic_verifier", action: "verify.final", decision: "approved" }
    );
    const result = traceFor(specs);
    assert.deepEqual(result.trace.decisions.deterministicVerifierDecisions, ["needs_repair", "approved"]);
    assert.equal(result.trace.decisions.finalDeterministicVerifierDecision, "approved");
    const role = result.trace.roleActivity.find((entry) => entry.actor === "deterministic_verifier");
    assert.deepEqual(role.decisions, ["needs_repair", "approved"]);
    assert.deepEqual(role.actions, ["patch.verified", "verify.again", "verify.final"]);
  });

  check("repeated identical execution decisions do not conflict", () => {
    const specs = completedSpecs();
    specs.push({ actor: "execution_verifier", action: "execution.rechecked", decision: "temp_validation_passed" });
    const result = traceFor(specs);
    assertDecision(result, "trace_ready");
    assert.deepEqual(result.trace.decisions.executionDecisions, ["temp_validation_passed", "temp_validation_passed"]);
    assert.deepEqual(result.trace.decisions.uniqueExecutionDecisions, ["temp_validation_passed"]);
    assert.equal(result.trace.decisions.executionDecisionConflict, false);
  });

  check("distinct execution decisions create conflict error", () => {
    const specs = completedSpecs();
    specs.push({ actor: "execution_verifier", action: "execution.rechecked", decision: "temp_validation_failed" });
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "conflicting_execution_decisions");
    assert.equal(result.trace.decisions.executionDecisionConflict, true);
    assert.deepEqual(result.trace.decisions.uniqueExecutionDecisions, ["temp_validation_failed", "temp_validation_passed"]);
    assert.equal(result.trace.decisions.finalExecutionDecision, "temp_validation_failed");
  });

  check("repair, remask, transitions, and governance activity are counted", () => {
    const specs = completedSpecs();
    specs.splice(5, 0,
      { actor: "repairer", action: "repair.again", filesProposed: ["b.ts"] },
      { actor: "repairer", action: "repair.again", filesProposed: ["b.ts"] }
    );
    specs.push({ actor: "shadow_observer", action: "shadow.observed" });
    const result = traceFor(specs);
    assertDecision(result, "trace_ready", "pre_governance_trace_contains_governance_roles");
    assert.equal(result.trace.repairActivity.repairCount, 3);
    assert.equal(result.trace.repairActivity.remaskCount, 1);
    assert.equal(result.trace.repairActivity.governanceRoleCallCount, 1);
    assert.equal(result.trace.repairActivity.repeatedActorTransitions, 2);
  });

  check("more than three repairs and remasks create warnings", () => {
    const specs = completedSpecs();
    specs.splice(4, 0,
      { actor: "masker" }, { actor: "masker" }, { actor: "masker" },
      { actor: "repairer", filesProposed: ["a.ts"] },
      { actor: "repairer", filesProposed: ["a.ts"] },
      { actor: "repairer", filesProposed: ["a.ts"] }
    );
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "high_repair_count");
    assert.ok(result.findings.some((finding) => finding.code === "high_remask_count"));
    assert.equal(result.trace.repairActivity.repairCount, 4);
    assert.equal(result.trace.repairActivity.remaskCount, 4);
  });

  check("resource totals, wall span, and lowest-sequence longest tie are deterministic", () => {
    const specs = completedSpecs("temp_validation_passed", {
      0: { durationMs: 200 },
      1: { durationMs: 200 }
    });
    const result = traceFor(specs);
    assert.equal(result.trace.resources.totalDurationMs, 900);
    assert.equal(result.trace.resources.totalInputTokens, 35);
    assert.equal(result.trace.resources.totalOutputTokens, 10);
    assert.equal(result.trace.resources.totalTokens, 45);
    assert.equal(result.trace.resources.longestEventId, "run-w3:event:000001");
    assert.equal(result.trace.resources.firstStartedAt, "2026-07-13T07:00:00.000Z");
    assert.equal(result.trace.resources.lastFinishedAt, "2026-07-13T07:00:16.110Z");
  });

  check("safe-integer resource overflow creates an error review trace", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const specs = completedSpecs("temp_validation_passed", {
      0: { tokenUsage: { inputTokens: maximum, outputTokens: 0, totalTokens: maximum } },
      1: { tokenUsage: { inputTokens: maximum, outputTokens: 0, totalTokens: maximum } },
      4: { tokenUsage: undefined },
      8: { tokenUsage: undefined }
    });
    const result = traceFor(specs);
    assertDecision(result, "trace_needs_review", "resource_total_overflow");
    assert.equal(result.findings.find((finding) => finding.code === "resource_total_overflow").severity, "error");
    assert.equal(Number.isSafeInteger(result.trace.resources.totalTokens), true);
    assert.equal(result.trace.resources.totalTokens, Number.MAX_SAFE_INTEGER);
  });

  check("all roles have one canonical summary and rolesCalled is canonical", () => {
    const specs = [
      { actor: "execution_verifier", decision: "temp_validation_passed" },
      { actor: "planner" },
      { actor: "coder" },
      { actor: "deterministic_verifier" }
    ];
    const result = traceFor(specs);
    assert.deepEqual(result.trace.roleActivity.map((entry) => entry.actor), roleOrder);
    assert.equal(result.trace.roleActivity.length, roleOrder.length);
    const unused = result.trace.roleActivity.find((entry) => entry.actor === "admin_agent");
    assert.equal(unused.callCount, 0);
    assert.equal(unused.firstSequence, null);
    assert.equal(unused.lastSequence, null);
    assert.deepEqual(unused.decisions, []);
    assert.deepEqual(unused.actions, []);
    assert.deepEqual(result.trace.rolesCalled, ["planner", "coder", "deterministic_verifier", "execution_verifier"]);
  });

  check("trace hash includes every trace field except itself", () => {
    const { traceHash, ...material } = completed.trace;
    assert.equal(traceHash, hashCanonicalJson(material));
    const changedFindings = {
      ...material,
      findings: [{
        code: "synthetic_hash_sensitivity",
        message: "Synthetic hash sensitivity finding.",
        severity: "info",
        eventIds: [],
        filePaths: []
      }]
    };
    assert.notEqual(traceHash, hashCanonicalJson(changedFindings));
  });

  check("trace building and hashing are deterministic across serialization", () => {
    const first = buildRunAccountabilityTrace(completedLedger);
    const second = buildRunAccountabilityTrace(completedLedger);
    const parsed = buildRunAccountabilityTrace(clone(completedLedger));
    assert.equal(canonicalizeJson(first), canonicalizeJson(second));
    assert.equal(first.trace.traceHash, second.trace.traceHash);
    assert.equal(first.trace.traceHash, parsed.trace.traceHash);

    const reordered = {};
    for (const key of Object.keys(clone(completedLedger)).reverse()) reordered[key] = clone(completedLedger)[key];
    reordered.events = reordered.events.map((event) => {
      const output = {};
      for (const key of Object.keys(event).reverse()) output[key] = event[key];
      return output;
    });
    assert.equal(buildRunAccountabilityTrace(reordered).trace.traceHash, first.trace.traceHash);
  });

  check("decision, file, token, ledger root, and findings affect trace hashes", () => {
    const variants = [
      completedSpecs("temp_validation_failed"),
      completedSpecs("temp_validation_passed", { 0: { filesProposed: ["a.ts", "b.ts", "c.ts"] }, 1: { filesProposed: ["a.ts", "b.ts", "c.ts"] }, 7: { filesProposed: ["a.ts", "b.ts", "c.ts"] } }),
      completedSpecs("temp_validation_passed", { 0: { tokenUsage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } } }),
      completedSpecs("temp_validation_passed", { 8: { filesRead: ["a.ts", "b.ts", "/absolute/path.ts"] } })
    ];
    const hashes = variants.map((specs) => traceFor(specs).trace.traceHash);
    for (const hash of hashes) assert.notEqual(hash, completed.trace.traceHash);
    assert.equal(new Set(hashes).size, hashes.length);
    const differentRoot = buildLedger(completedSpecs(), { runId: "another-run" });
    assert.notEqual(differentRoot.rootHash, completedLedger.rootHash);
    assert.notEqual(buildRunAccountabilityTrace(differentRoot).trace.traceHash, completed.trace.traceHash);
  });

  check("finding order and finding evidence arrays are canonical", () => {
    const specs = completedSpecs("temp_validation_passed", {
      0: { filesProposed: ["b.ts"] },
      1: { filesProposed: ["z.ts", "a.ts"] },
      7: { filesProposed: ["never.ts"] },
      8: { filesRead: ["../z.ts", "/a.ts"] }
    });
    specs.push({ actor: "admin_agent" });
    const result = traceFor(specs);
    const ranks = { error: 0, warning: 1, info: 2 };
    const rankList = result.findings.map((finding) => ranks[finding.severity]);
    assert.deepEqual(rankList, [...rankList].sort((a, b) => a - b));
    for (const finding of result.findings) {
      assert.deepEqual(finding.eventIds, [...new Set(finding.eventIds)].sort());
      assert.deepEqual(finding.filePaths, [...new Set(finding.filePaths)].sort());
    }
  });

  check("builder is pure and all returned structures are deeply frozen", () => {
    const raw = clone(completedLedger);
    const options = { expectedRunId: raw.runId, expectedRootHash: raw.rootHash };
    const rawSnapshot = JSON.stringify(raw);
    const optionsSnapshot = JSON.stringify(options);
    const ledgerSnapshot = JSON.stringify(completedLedger);
    const result = buildRunAccountabilityTrace(raw, options);
    assert.equal(JSON.stringify(raw), rawSnapshot);
    assert.equal(JSON.stringify(options), optionsSnapshot);
    assert.equal(JSON.stringify(completedLedger), ledgerSnapshot);
    assert.equal(Object.isFrozen(raw), false);
    assert.equal(Object.isFrozen(options), false);
    assertDeepFrozen(result);
    assert.ok(Object.isFrozen(completedLedger));
  });

  check("malformed inputs propagate safely without builder crashes", () => {
    const accessor = {};
    Object.defineProperty(accessor, "runId", { enumerable: true, get() { throw new Error("getter"); } });
    const cyclic = {};
    cyclic.self = cyclic;
    for (const input of [null, undefined, "x", 1, [], {}, accessor, cyclic]) {
      let result;
      assert.doesNotThrow(() => { result = buildRunAccountabilityTrace(input); });
      assert.ok(["trace_invalid", "trace_needs_review"].includes(result.decision));
      assert.equal(result.trace, null);
    }
  });

  check("trace contains no sensitive raw-content fields", () => {
    const forbidden = new Set([
      "objectiveText", "prompt", "modelOutput", "chainOfThought", "sourceContent",
      "patchContent", "diff", "environment", "stdout", "stderr", "secret", "credential"
    ]);
    const visit = (value) => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbidden.has(key), false, key);
        visit(child);
      }
    };
    visit(completed.trace);
  });

  check("product-runtime index exports W.3 runtime API", () => {
    assert.equal(runtimeIndex.RUN_ACCOUNTABILITY_TRACE_VERSION, "1");
    assert.equal(runtimeIndex.buildRunAccountabilityTrace, buildRunAccountabilityTrace);
  });

  console.log("run accountability trace smoke passed");
})();
