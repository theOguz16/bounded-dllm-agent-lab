const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");

async function check(name, fn) {
  try { await fn(); console.log(`[ok] ${name}`); }
  catch (error) { console.error(`[fail] ${name}`); throw error; }
}
function clone(value) { return structuredClone(value); }
function assertDeepFrozen(value, seen = new Set()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value); assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

(async () => {
  const runtime = await import(pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  ).href);
  const {
    appendAgentEvent, buildAdminAgentMessages, buildRunAccountabilityTrace,
    canonicalizeJson, createAgentEventLedger, evaluateDeterministicGovernance,
    hashCanonicalJson, parseAdminAgentCompletionContent, runAdminAgentModel,
    validateShadowObservation
  } = runtime;
  const hashPattern = /^sha256:[0-9a-f]{64}$/;
  const objectiveHash = hashCanonicalJson({ objective: "admin-adapter-smoke" });
  const artifactHash = hashCanonicalJson({ artifact: "bounded" });

  function makeTrace(eventCount = 5, runId = "admin-adapter-run") {
    const core = [
      ["planner", "planner.plan", [], ["src/a.ts"], "planner_valid", []],
      ["coder", "coder.patch", ["src/a.ts"], ["src/a.ts"], "coder_valid", []],
      ["deterministic_verifier", "verifier.check", ["src/a.ts"], [], "approve", []],
      ["temp_workspace_apply", "temp.apply", ["src/a.ts"], ["src/a.ts"], "temp_apply_ready", []],
      ["execution_verifier", "execution.verify", ["src/a.ts"], [], "temp_validation_passed", ["temp_workspace_cleanup_performed"]]
    ];
    while (core.length < eventCount) core.splice(core.length - 2, 0,
      ["coder", `coder.recheck:${core.length}`, ["src/a.ts"], ["src/a.ts"], "coder_valid", []]);
    let ledger = createAgentEventLedger({ runId, objectiveHash });
    const base = Date.parse("2026-07-14T08:00:00.000Z");
    for (const [index, spec] of core.slice(0, eventCount).entries()) ledger = appendAgentEvent(ledger, {
      actor: spec[0], action: spec[1], filesRead: spec[2], filesProposed: spec[3],
      decision: spec[4], reasonCodes: spec[5],
      startedAt: new Date(base + index * 100).toISOString(),
      finishedAt: new Date(base + index * 100 + 10).toISOString(),
      inputArtifactHashes: [artifactHash], outputArtifactHashes: [artifactHash]
    });
    const built = buildRunAccountabilityTrace(ledger, {
      expectedRunId: ledger.runId, expectedObjectiveHash: ledger.objectiveHash,
      expectedRootHash: ledger.rootHash, expectedEventCount: ledger.eventCount
    });
    assert.ok(built.trace, JSON.stringify(built)); return built.trace;
  }

  function observationFor(targetTrace, options = {}) {
    const riskLevel = options.riskLevel ?? "low";
    const findings = options.findings ?? (riskLevel === "low" ? [] : [{
      code: options.findingCode ?? "shadow_advisory", severity: riskLevel === "critical" ? "critical" : riskLevel === "high" ? "high" : "warning",
      message: options.message ?? "RAW_SHADOW_MESSAGE_SENTINEL",
      evidenceEventIds: [targetTrace.events[0].eventId], evidenceFilePaths: ["src/a.ts"],
      evidenceTraceFindingCodes: []
    }]);
    const validated = validateShadowObservation(targetTrace, {
      observationVersion: "1", runId: targetTrace.runId, traceHash: targetTrace.traceHash,
      riskLevel, riskScore: { low: 10, medium: 35, high: 60, critical: 90 }[riskLevel],
      confidenceScore: 90, findings, observedScopeDrift: false,
      observedPlanPatchMismatch: false, observedRepairLoop: false,
      observedSuspiciousRoleBehavior: false, observedEvidenceConflict: false,
      recommendation: options.recommendation ?? (riskLevel === "high" ? "escalate" : riskLevel === "critical" ? "terminate" : "continue"),
      rationaleCodes: ["bounded_shadow_evidence"]
    });
    assert.ok(validated.observation, JSON.stringify(validated)); return validated.observation;
  }

  function rehashGovernance(value, mutate) {
    const copy = clone(value); mutate(copy); copy.policyHash = hashCanonicalJson(copy.policy);
    delete copy.governanceHash; copy.governanceHash = hashCanonicalJson(copy); return copy;
  }
  function rehashTrace(value, mutate) {
    const copy = clone(value); mutate(copy); delete copy.traceHash;
    copy.traceHash = hashCanonicalJson(copy); return copy;
  }

  const trace = makeTrace();
  const observation = observationFor(trace);
  const passed = evaluateDeterministicGovernance(trace, observation).assessment;
  assert.equal(passed.decision, "governance_passed");

  function governanceVariant(decision) {
    const settings = {
      governance_repair_required: ["execution_outcome", "governance_execution_failed", "high", "repair", "medium"],
      governance_replan_required: ["planned_scope_consistency", "governance_unplanned_files_proposed", "high", "replan", "medium"],
      governance_escalation_required: ["total_token_limit", "governance_total_token_limit_exceeded", "high", "escalate", "high"],
      governance_terminated: ["forbidden_proposed_paths", "governance_forbidden_proposed_path", "critical", "terminate", "critical"]
    };
    if (decision === "governance_passed") return passed;
    const [ruleId, reasonCode, severity, effect, riskClass] = settings[decision];
    return rehashGovernance(passed, (value) => {
      value.decision = decision; value.riskClass = riskClass;
      value.triggeredRuleIds = [ruleId]; value.reasonCodes = [reasonCode];
      value.ruleResults = value.ruleResults.map((rule) => rule.ruleId === ruleId
        ? { ...rule, triggered: true, reasonCode, severity, effect,
          eventIds: [trace.events[0].eventId], filePaths: ["src/a.ts"] } : rule);
      value.issues = [{ code: reasonCode, message: "GOVERNANCE_ISSUE_MESSAGE_SENTINEL",
        severity, effect, eventIds: [trace.events[0].eventId], filePaths: ["src/a.ts"],
        traceFindingCodes: [], shadowFindingCodes: [] }];
    });
  }

  function finding(overrides = {}) {
    return {
      code: "admin_evidence", severity: "warning", message: "Bounded Admin evidence.",
      governanceRuleIds: [], governanceReasonCodes: [], governanceIssueCodes: [],
      traceFindingCodes: [], shadowFindingCodes: [], evidenceEventIds: [trace.events[0].eventId],
      evidenceFilePaths: [], ...overrides
    };
  }
  function draft(governance = passed, adminDecision = "admin_auto_approved", targetObservation = observation, overrides = {}) {
    const risk = {
      admin_auto_approved: ["low", 10], admin_repair_required: ["medium", 35],
      admin_replan_required: ["medium", 35], admin_human_escalation_required: ["high", 60],
      admin_run_terminated: ["critical", 90]
    }[adminDecision];
    let findings = [];
    if (adminDecision === "admin_repair_required") findings = [finding({ governanceRuleIds: ["execution_outcome"] })];
    if (adminDecision === "admin_replan_required") findings = [finding({ governanceRuleIds: ["planned_scope_consistency"] })];
    if (adminDecision === "admin_human_escalation_required") findings = [finding()];
    if (adminDecision === "admin_run_terminated") findings = [finding({ severity: "critical" })];
    if (governance.decision !== "governance_passed" && findings.length) findings[0] = {
      ...findings[0], governanceRuleIds: [governance.triggeredRuleIds[0], ...findings[0].governanceRuleIds],
      governanceIssueCodes: [governance.issues[0].code]
    };
    return {
      decisionVersion: "1", runId: trace.runId, traceHash: trace.traceHash,
      observationHash: targetObservation?.observationHash ?? null,
      governanceHash: governance.governanceHash, decision: adminDecision,
      riskLevel: risk[0], riskScore: risk[1], confidenceScore: 90,
      findings, rationaleCodes: ["bounded_admin_review"], ...overrides
    };
  }
  function completionResponse(content, usage) {
    return { choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) };
  }
  function assertDecision(result, decision, code) {
    assert.equal(result.decision, decision, JSON.stringify(result.issues));
    if (code) assert.ok(result.issues.some((item) => item.code === code), JSON.stringify(result.issues));
  }

  let scenario = { status: 200, body: "{}", delayMs: 0 };
  let requestCount = 0;
  const requestBodies = [];
  const requestHeaders = [];
  const server = http.createServer((request, response) => {
    requestCount += 1; requestHeaders.push(request.headers);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      const current = scenario;
      const send = () => {
        if (response.destroyed) return;
        response.statusCode = current.status;
        response.setHeader("Content-Type", "application/json");
        response.end(current.body);
      };
      if (current.delayMs) setTimeout(send, current.delayMs); else send();
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const baseConfig = { endpoint, modelId: "qwen-admin" };

  async function runScenario(contentOrBody, options = {}) {
    const body = options.rawBody === true ? contentOrBody : completionResponse(
      typeof contentOrBody === "string" ? contentOrBody : JSON.stringify(contentOrBody),
      options.usage
    );
    scenario = {
      status: options.status ?? 200,
      body: typeof body === "string" ? body : JSON.stringify(body),
      delayMs: options.delayMs ?? 0
    };
    const before = requestCount;
    const result = await runAdminAgentModel(
      options.trace ?? trace, options.observation === undefined ? observation : options.observation,
      options.governance ?? passed, { ...baseConfig, ...(options.config ?? {}) }
    );
    return { result, calls: requestCount - before };
  }

  try {
    await check("request is canonical, exact, bounded, authoritative, and omits raw messages", async () => {
      const highObservation = observationFor(trace, { riskLevel: "high", message: "RAW_SHADOW_MESSAGE_SENTINEL" });
      const highGovernance = evaluateDeterministicGovernance(trace, highObservation).assessment;
      const messages = buildAdminAgentMessages(trace, highObservation, highGovernance);
      assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
      const payload = JSON.parse(messages[1].content);
      assert.equal(messages[1].content, canonicalizeJson(payload));
      assert.equal(payload.task, "admin_evaluate_governed_change");
      assert.equal(payload.bindings.runId, trace.runId);
      assert.equal(payload.bindings.traceHash, trace.traceHash);
      assert.equal(payload.bindings.observationHash, highObservation.observationHash);
      assert.equal(payload.bindings.governanceHash, highGovernance.governanceHash);
      assert.deepEqual(payload.governanceDecisionMatrix.governance_terminated, ["admin_run_terminated"]);
      assert.deepEqual(
        payload.outputContract.riskScoreBands,
        {
          low: { minimum: 0, maximum: 24 },
          medium: { minimum: 25, maximum: 49 },
          high: { minimum: 50, maximum: 74 },
          critical: { minimum: 75, maximum: 100 }
        }
      );
      assert.deepEqual(
        payload.outputContract.findingContract.requiredFields,
        [
          "code",
          "severity",
          "message",
          "governanceRuleIds",
          "governanceReasonCodes",
          "governanceIssueCodes",
          "traceFindingCodes",
          "shadowFindingCodes",
          "evidenceEventIds",
          "evidenceFilePaths"
        ]
      );
      assert.equal(
        payload.outputContract.findingContract.invalidFieldAliases.includes(
          "effect"
        ),
        true
      );
      assert.equal(
        payload.outputContract.findingContract.invalidFieldAliases.includes(
          "eventIds"
        ),
        true
      );
      assert.equal(
        payload.outputContract.findingContract.invalidFieldAliases.includes(
          "filePaths"
        ),
        true
      );
      assert.deepEqual(
        payload.outputContract.findingShapeExample.evidenceEventIds,
        [trace.events[0].eventId]
      );
      assert.ok(payload.trace.events.some((event) => event.eventId === trace.events[0].eventId));
      assert.ok(payload.governance.ruleResults.some((rule) => rule.ruleId === "execution_outcome"));
      assert.ok(payload.governance.ruleResults.some((rule) => rule.reasonCode === "governance_execution_failed"));
      const serialized = messages.map((message) => message.content).join("\n");
      for (const sentinel of ["adminDecisionHash", "SOURCE_CONTENT_SENTINEL", "PATCH_CONTENT_SENTINEL",
        "PLANNER_PROMPT_SENTINEL", "CODER_PROMPT_SENTINEL", "RAW_SHADOW_MESSAGE_SENTINEL",
        "GOVERNANCE_ISSUE_MESSAGE_SENTINEL", "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENV_SECRET_SENTINEL"])
        assert.equal(serialized.includes(sentinel), false, sentinel);
      assert.match(messages[0].content, /hard authority/i);
      assert.match(messages[0].content, /cannot weaken deterministic governance/i);
      assert.match(messages[0].content, /not repository-apply authorization/i);
      assertDeepFrozen(messages);
    });

    await check("valid governance-pass auto approval completes with immutable bounded evidence", async () => {
      const content = JSON.stringify(draft());
      const { result, calls } = await runScenario(content, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      assertDecision(result, "admin_agent_completed"); assert.equal(calls, 1);
      assert.equal(result.called, true); assert.equal(result.summary.requestStarted, true);
      assert.equal(result.summary.responseReceived, true); assert.equal(result.summary.responseParsed, true);
      assert.equal(result.summary.adminValidationCompleted, true);
      assert.equal(result.validationDecision, "admin_decision_valid"); assert.ok(result.adminDecision);
      assert.match(result.adminDecision.adminDecisionHash, hashPattern);
      assert.match(result.responseContentHash, hashPattern);
      assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      assert.equal(result.summary.governanceDecision, "governance_passed");
      assert.equal(result.summary.finalAdminDecision, "admin_auto_approved");
      assert.equal(result.summary.riskLevel, "low"); assert.equal(result.summary.recommendationStrength, "auto");
      assert.equal(JSON.stringify(result).includes(content), false); assertDeepFrozen(result);
    });

    await check("repair, replan, escalation, termination, and stricter passed choices map through W.8", async () => {
      const pairs = [
        ["governance_repair_required", "admin_repair_required"],
        ["governance_replan_required", "admin_replan_required"],
        ["governance_escalation_required", "admin_human_escalation_required"],
        ["governance_terminated", "admin_run_terminated"]
      ];
      for (const [governanceDecision, adminDecision] of pairs) {
        const governance = governanceVariant(governanceDecision);
        const result = (await runScenario(JSON.stringify(draft(governance, adminDecision)), { governance })).result;
        assertDecision(result, "admin_agent_completed"); assert.equal(result.summary.finalAdminDecision, adminDecision);
      }
      for (const adminDecision of ["admin_repair_required", "admin_replan_required", "admin_human_escalation_required", "admin_run_terminated"]) {
        const result = (await runScenario(JSON.stringify(draft(passed, adminDecision)))).result;
        assertDecision(result, "admin_agent_completed");
      }
    });

    await check("governance weakening and output binding failures are hard failures", async () => {
      for (const [governanceDecision, adminDecision] of [
        ["governance_repair_required", "admin_auto_approved"],
        ["governance_replan_required", "admin_repair_required"],
        ["governance_escalation_required", "admin_replan_required"],
        ["governance_terminated", "admin_human_escalation_required"]
      ]) {
        const governance = governanceVariant(governanceDecision);
        const result = (await runScenario(JSON.stringify(draft(governance, adminDecision)), { governance })).result;
        assertDecision(result, "admin_agent_failed", "admin_decision_validation_failed");
      }
      for (const [field, value] of [
        ["runId", "wrong"], ["traceHash", `sha256:${"a".repeat(64)}`],
        ["observationHash", `sha256:${"b".repeat(64)}`], ["governanceHash", `sha256:${"c".repeat(64)}`]
      ]) {
        const result = (await runScenario(JSON.stringify(draft(passed, "admin_auto_approved", observation, { [field]: value })))).result;
        assertDecision(result, "admin_agent_failed", "admin_decision_validation_failed");
      }
    });

    await check("W.8 non-fatal review returns its normalized immutable decision", async () => {
      const one = finding({ governanceRuleIds: ["execution_outcome"], evidenceEventIds: [trace.events[0].eventId, trace.events[1].eventId] });
      const two = { ...one, governanceRuleIds: [...one.governanceRuleIds].reverse(), evidenceEventIds: [...one.evidenceEventIds].reverse() };
      const content = JSON.stringify(draft(passed, "admin_repair_required", observation, { findings: [one, two] }));
      const result = (await runScenario(content)).result;
      assertDecision(result, "admin_agent_needs_review", "admin_decision_validation_needs_review");
      assert.equal(result.validationDecision, "admin_decision_needs_review"); assert.ok(result.adminDecision);
      assert.equal(result.adminDecision.findings.length, 1); assert.equal(JSON.stringify(result).includes(content), false);
    });

    await check("all preflight integrity and binding failures make zero requests", async () => {
      const cases = [];
      const badTrace = clone(trace); badTrace.resources.totalTokens += 1;
      cases.push([badTrace, observation, passed, "admin_adapter_trace_integrity_mismatch"]);
      const badObservation = clone(observation); badObservation.riskScore += 1;
      cases.push([trace, badObservation, passed, "admin_adapter_observation_integrity_mismatch"]);
      const wrongObservation = clone(observation); wrongObservation.traceHash = `sha256:${"d".repeat(64)}`;
      delete wrongObservation.observationHash; wrongObservation.observationHash = hashCanonicalJson(wrongObservation);
      cases.push([trace, wrongObservation, passed, "admin_adapter_observation_trace_mismatch"]);
      const badPolicy = clone(passed); badPolicy.policy.maxRepairCount += 1;
      cases.push([trace, observation, badPolicy, "admin_adapter_policy_hash_mismatch"]);
      const badGovernance = clone(passed); badGovernance.riskClass = "high";
      cases.push([trace, observation, badGovernance, "admin_adapter_governance_integrity_mismatch"]);
      const wrongTrace = rehashGovernance(passed, (value) => { value.traceHash = `sha256:${"e".repeat(64)}`; });
      cases.push([trace, observation, wrongTrace, "admin_adapter_governance_trace_mismatch"]);
      const wrongObs = rehashGovernance(passed, (value) => { value.observationHash = null; });
      cases.push([trace, observation, wrongObs, "admin_adapter_governance_observation_mismatch"]);
      for (const [targetTrace, targetObservation, governance, code] of cases) {
        const before = requestCount;
        const result = await runAdminAgentModel(targetTrace, targetObservation, governance, baseConfig);
        assertDecision(result, "admin_agent_failed", code); assert.equal(result.called, false); assert.equal(requestCount, before);
      }
    });

    await check("null Shadow observation stays null and remains exactly bound", async () => {
      const governance = evaluateDeterministicGovernance(trace, null, { ...passed.policy, requireShadowObservation: false }).assessment;
      const input = draft(governance, "admin_auto_approved", null, { observationHash: null, governanceHash: governance.governanceHash });
      const beforeBodies = requestBodies.length;
      const result = (await runScenario(JSON.stringify(input), { observation: null, governance })).result;
      assertDecision(result, "admin_agent_completed");
      const body = JSON.parse(requestBodies[beforeBodies]);
      assert.equal(JSON.parse(body.messages[1].content).shadowObservation, null);
      assert.equal(result.adminDecision.observationHash, null);
    });

    await check("event and prompt limits allow equality, block excess, and never truncate", async () => {
      scenario = { status: 200, body: JSON.stringify(completionResponse(JSON.stringify(draft()))), delayMs: 0 };
      const exactEvents = await runAdminAgentModel(trace, observation, passed, { ...baseConfig, maxTraceEvents: trace.events.length });
      assertDecision(exactEvents, "admin_agent_completed");
      const beforeEvents = requestCount;
      const overEvents = await runAdminAgentModel(trace, observation, passed, { ...baseConfig, maxTraceEvents: trace.events.length - 1 });
      assertDecision(overEvents, "admin_agent_needs_review", "admin_trace_event_limit_exceeded");
      assert.equal(overEvents.called, false); assert.equal(requestCount, beforeEvents);
      const promptChars = buildAdminAgentMessages(trace, observation, passed).reduce((sum, message) => sum + message.content.length, 0);
      const exactPrompt = await runAdminAgentModel(trace, observation, passed, { ...baseConfig, maxPromptChars: promptChars });
      assertDecision(exactPrompt, "admin_agent_completed");
      const beforePrompt = requestCount;
      const overPrompt = await runAdminAgentModel(trace, observation, passed, { ...baseConfig, maxPromptChars: promptChars - 1 });
      assertDecision(overPrompt, "admin_agent_needs_review", "admin_prompt_size_limit_exceeded");
      assert.equal(overPrompt.called, false); assert.equal(requestCount, beforePrompt);
      assert.equal(JSON.parse(buildAdminAgentMessages(trace, observation, passed)[1].content).trace.events.length, trace.events.length);
    });

    await check("HTTP errors, timeout, and every invocation use at most one request", async () => {
      for (const status of [400, 500]) {
        const { result, calls } = await runScenario("SENSITIVE_HTTP_BODY", { rawBody: true, status });
        assertDecision(result, "admin_agent_failed", "admin_upstream_http_error"); assert.equal(calls, 1);
        assert.equal(JSON.stringify(result).includes("SENSITIVE_HTTP_BODY"), false);
      }
      const timeout = await runScenario(JSON.stringify(draft()), { delayMs: 100, config: { timeoutMs: 20 } });
      assertDecision(timeout.result, "admin_agent_failed", "admin_upstream_timeout"); assert.equal(timeout.calls, 1);
    });

    await check("completion parser accepts exact JSON and complete supported fences only", async () => {
      const object = draft(); const json = JSON.stringify(object);
      for (const content of [json, `\n\`\`\`json\n${json}\n\`\`\`\n`, `\`\`\`\n${json}\n\`\`\``]) {
        assert.deepEqual(parseAdminAgentCompletionContent(content), object);
        assertDecision((await runScenario(content)).result, "admin_agent_completed");
      }
      const rejected = [
        `before ${json}`, `${json} after`, `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`javascript\n${json}\n\`\`\``, `\`\`\`json\n${json}`, "", "[]", "1", "{"
      ];
      for (const content of rejected) {
        assert.throws(() => parseAdminAgentCompletionContent(content));
        assertDecision((await runScenario(content)).result, "admin_agent_failed", "malformed_admin_completion_json");
      }
    });

    await check("upstream response shape is strict", async () => {
      const cases = [
        ["not-json", "invalid_admin_upstream_response"], [JSON.stringify(1), "invalid_admin_upstream_response"],
        [JSON.stringify({}), "invalid_admin_upstream_response"],
        [JSON.stringify({ choices: [] }), "invalid_admin_upstream_response"],
        [JSON.stringify({ choices: [{}] }), "invalid_admin_upstream_response"],
        [JSON.stringify({ choices: [{ message: {} }] }), "missing_admin_completion_content"],
        [JSON.stringify({ choices: [{ message: { content: 1 } }] }), "missing_admin_completion_content"]
      ];
      for (const [body, code] of cases) assertDecision((await runScenario(body, { rawBody: true })).result, "admin_agent_failed", code);
    });

    await check("response body character bound is exact and oversized content never leaks", async () => {
      const body = JSON.stringify(completionResponse(JSON.stringify(draft())));
      const exact = (await runScenario(body, { rawBody: true, config: { maxResponseChars: body.length } })).result;
      assertDecision(exact, "admin_agent_completed"); assert.equal(exact.summary.responseChars, body.length);
      const sentinel = "OVERSIZED_ADMIN_OUTPUT_SENTINEL".repeat(30);
      const oversizedBody = JSON.stringify(completionResponse(sentinel));
      const oversized = (await runScenario(oversizedBody, { rawBody: true, config: { maxResponseChars: oversizedBody.length - 1 } })).result;
      assertDecision(oversized, "admin_agent_needs_review", "admin_response_size_limit_exceeded");
      assert.equal(oversized.adminDecision, null); assert.equal(JSON.stringify(oversized).includes("OVERSIZED_ADMIN_OUTPUT_SENTINEL"), false);
    });

    await check("usage is exact; malformed usage reviews without discarding a valid decision", async () => {
      const content = JSON.stringify(draft());
      const valid = (await runScenario(content, { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })).result;
      assertDecision(valid, "admin_agent_completed"); assert.deepEqual(valid.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      const absent = (await runScenario(content)).result;
      assertDecision(absent, "admin_agent_completed"); assert.equal(absent.usage, null);
      for (const usage of [
        { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
        { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
        { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 }
      ]) {
        const result = (await runScenario(content, { usage })).result;
        assertDecision(result, "admin_agent_needs_review", "invalid_admin_upstream_usage");
        assert.equal(result.usage, null); assert.ok(result.adminDecision);
      }
    });

    await check("exact completion hashing differs while normalized Admin hash remains stable", async () => {
      const compact = JSON.stringify(draft());
      const contents = [compact, compact, ` ${compact}\n`, `\`\`\`json\n${compact}\n\`\`\``];
      const results = [];
      for (const content of contents) results.push((await runScenario(content)).result);
      assert.equal(results[0].responseContentHash, results[1].responseContentHash);
      assert.notEqual(results[0].responseContentHash, results[2].responseContentHash);
      assert.notEqual(results[0].responseContentHash, results[3].responseContentHash);
      assert.equal(results[0].adminDecision.adminDecisionHash, results[2].adminDecision.adminDecisionHash);
      assert.equal(results[0].adminDecision.adminDecisionHash, results[3].adminDecision.adminDecisionHash);
    });

    await check("configuration validation rejects every unsafe form", async () => {
      const invalid = [
        { ...baseConfig, endpoint: "" }, { ...baseConfig, endpoint: "bad" },
        { ...baseConfig, endpoint: "ftp://localhost/x" },
        { ...baseConfig, endpoint: "http://user:pass@localhost/x" },
        { ...baseConfig, endpoint: "http://localhost/x#fragment" },
        { ...baseConfig, modelId: "" }, { ...baseConfig, modelId: " bad" },
        { ...baseConfig, timeoutMs: 0 }, { ...baseConfig, timeoutMs: 300001 },
        { ...baseConfig, maxTraceEvents: 0 }, { ...baseConfig, maxTraceEvents: 1.5 },
        { ...baseConfig, maxPromptChars: 750001 }, { ...baseConfig, maxResponseChars: 100001 },
        { ...baseConfig, fetchImpl: 1 }
      ];
      for (const config of invalid) await assert.rejects(runAdminAgentModel(trace, observation, passed, config), TypeError);
    });

    await check("adapter is pure, deeply frozen, repeatable, and leaks no prohibited data", async () => {
      const mutableTrace = clone(trace), mutableObservation = clone(observation), mutableGovernance = clone(passed);
      const config = { ...baseConfig };
      const before = [mutableTrace, mutableObservation, mutableGovernance, config].map((value) => JSON.stringify(value));
      const content = JSON.stringify(draft());
      const first = (await runScenario(content, { trace: mutableTrace, observation: mutableObservation, governance: mutableGovernance, config })).result;
      const second = (await runScenario(content, { trace: mutableTrace, observation: mutableObservation, governance: mutableGovernance, config })).result;
      assert.deepEqual([mutableTrace, mutableObservation, mutableGovernance, config].map((value) => JSON.stringify(value)), before);
      assertDeepFrozen(first);
      const semantic = (value) => { const copy = clone(value); delete copy.summary.durationMs; return copy; };
      assert.deepEqual(semantic(first), semantic(second));
      const body = requestBodies.at(-1); const resultText = JSON.stringify(first);
      for (const sentinel of ["SOURCE_CODE_SENTINEL", "PATCH_CONTENT_SENTINEL", "PLANNER_PROMPT_SENTINEL",
        "CODER_PROMPT_SENTINEL", "RAW_SHADOW_MESSAGE_SENTINEL", "GOVERNANCE_ISSUE_MESSAGE_SENTINEL",
        "STDOUT_SENTINEL", "STDERR_SENTINEL", "ENDPOINT_SECRET_SENTINEL", "API_KEY_SENTINEL", "ENV_SECRET_SENTINEL"])
        assert.equal(body.includes(sentinel) || resultText.includes(sentinel), false, sentinel);
      const request = JSON.parse(body);
      assert.deepEqual(Object.keys(request).sort(), ["messages", "model", "stream", "temperature"]);
      assert.equal(request.model, "qwen-admin"); assert.equal(request.temperature, 0); assert.equal(request.stream, false);
      const headers = requestHeaders.at(-1);
      assert.equal(headers["content-type"], "application/json"); assert.equal(headers.accept, "application/json");
      assert.equal(headers.authorization, undefined);
    });

    await check("runtime index exports the complete W.9 value API", async () => {
      assert.equal(runtime.buildAdminAgentMessages, buildAdminAgentMessages);
      assert.equal(runtime.parseAdminAgentCompletionContent, parseAdminAgentCompletionContent);
      assert.equal(runtime.runAdminAgentModel, runAdminAgentModel);
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }

  await check("connection failure is bounded and performs no retry", async () => {
    const result = await runAdminAgentModel(trace, observation, passed, { endpoint, modelId: "qwen-admin", timeoutMs: 1000 });
    assertDecision(result, "admin_agent_failed", "admin_upstream_request_failed"); assert.equal(result.called, true);
  });

  console.log("admin agent model adapter smoke passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
