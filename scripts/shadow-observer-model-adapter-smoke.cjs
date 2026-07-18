const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");

async function check(name, fn) {
  try {
    await fn();
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
  const adapterPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/shadow-observer-model-adapter.js`
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
  const {
    buildShadowObserverMessages,
    parseShadowObserverCompletionContent,
    runShadowObserverModel
  } = await import(adapterPath.href);
  const { appendAgentEvent, canonicalizeJson, createAgentEventLedger } = await import(ledgerPath.href);
  const { buildRunAccountabilityTrace } = await import(tracePath.href);
  const runtimeIndex = await import(indexPath.href);

  const objectiveHash = `sha256:${"a".repeat(64)}`;
  const hashPattern = /^sha256:[0-9a-f]{64}$/;

  function makeTrace(eventCount = 4, runId = "shadow-adapter-run") {
    const specs = [
      { actor: "planner", action: "plan.created", filesProposed: ["a.ts"], decision: "planned" },
      { actor: "coder", action: "patch.drafted", filesProposed: ["a.ts"], decision: "drafted" },
      { actor: "deterministic_verifier", action: "patch.verified", filesRead: ["a.ts"], decision: "approved" },
      { actor: "execution_verifier", action: "execution.verified", filesRead: ["a.ts"], decision: "temp_validation_passed" }
    ];
    while (specs.length < eventCount) {
      specs.splice(specs.length - 1, 0, {
        actor: "coder",
        action: `patch.rechecked:${specs.length}`,
        filesProposed: ["a.ts"],
        decision: "drafted"
      });
    }
    let ledger = createAgentEventLedger({ runId, objectiveHash });
    const base = Date.parse("2026-07-14T07:00:00.000Z");
    for (let index = 0; index < Math.min(eventCount, specs.length); index += 1) {
      const spec = specs[index];
      ledger = appendAgentEvent(ledger, {
        actor: spec.actor,
        action: spec.action,
        startedAt: new Date(base + index * 1000).toISOString(),
        finishedAt: new Date(base + index * 1000 + 50).toISOString(),
        inputArtifactHashes: [],
        outputArtifactHashes: [],
        filesRead: spec.filesRead ?? [],
        filesProposed: spec.filesProposed ?? [],
        decision: spec.decision,
        reasonCodes: []
      });
    }
    const traceResult = buildRunAccountabilityTrace(ledger);
    assert.ok(traceResult.trace, JSON.stringify(traceResult));
    return traceResult.trace;
  }

  const trace = makeTrace();

  function observationDraft(targetTrace = trace, overrides = {}) {
    return {
      observationVersion: "1",
      runId: targetTrace.runId,
      traceHash: targetTrace.traceHash,
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

  function shadowFinding(targetTrace = trace, overrides = {}) {
    return {
      code: "advisory_risk",
      severity: "warning",
      message: "Bounded trace evidence warrants attention.",
      evidenceEventIds: [targetTrace.events[0].eventId],
      evidenceFilePaths: [],
      evidenceTraceFindingCodes: [],
      ...overrides
    };
  }

  function completionResponse(content, usage) {
    return {
      choices: [{ message: { content } }],
      ...(usage === undefined ? {} : { usage })
    };
  }

  function assertDecision(result, decision, issueCode) {
    assert.equal(result.decision, decision, JSON.stringify(result.issues));
    if (issueCode !== undefined) {
      assert.ok(result.issues.some((issue) => issue.code === issueCode), JSON.stringify(result.issues));
    }
  }

  let scenario = { status: 200, body: "{}", delayMs: 0 };
  let requestCount = 0;
  const requestBodies = [];
  const requestHeaders = [];
  const server = http.createServer((request, response) => {
    requestCount += 1;
    requestHeaders.push(request.headers);
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
      if (current.delayMs > 0) setTimeout(send, current.delayMs);
      else send();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const baseConfig = { endpoint, modelId: "qwen-shadow" };

  async function runScenario(rawBody, options = {}) {
    scenario = {
      status: options.status ?? 200,
      body: typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody),
      delayMs: options.delayMs ?? 0
    };
    const before = requestCount;
    const result = await runShadowObserverModel(
      options.trace ?? trace,
      { ...baseConfig, ...(options.config ?? {}) }
    );
    return { result, calls: requestCount - before, body: scenario.body };
  }

  try {
    await check("request messages are canonical, bounded-accountability-only, and advisory", async () => {
      const messages = buildShadowObserverMessages(trace);
      assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
      const payload = JSON.parse(messages[1].content);
      assert.equal(messages[1].content, canonicalizeJson(payload));
      assert.equal(payload.trace.traceHash, trace.traceHash);
      assert.ok(payload.trace.events.some((event) => event.eventId === trace.events[0].eventId));
      assert.equal("observationHash" in payload.outputContract, false);
      assert.equal(messages[1].content.includes("observationHash"), false);
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
          "evidenceEventIds",
          "evidenceFilePaths",
          "evidenceTraceFindingCodes"
        ]
      );
      assert.deepEqual(
        payload.outputContract.findingContract.optionalFields,
        ["actor"]
      );
      assert.equal(
        payload.outputContract.findingContract.invalidFieldAliases.includes(
          "description"
        ),
        true
      );
      assert.equal(
        payload.outputContract.validOutputExample.runId,
        trace.runId
      );
      assert.equal(
        payload.outputContract.validOutputExample.traceHash,
        trace.traceHash
      );
      assert.equal(
        payload.outputContract.validOutputExample.riskScore,
        10
      );
      assert.equal(
        "useOnlyWhenTraceSupportsLowRiskContinue" in
          payload.outputContract.validOutputExample,
        false
      );
      assert.deepEqual(
        Object.keys(payload.outputContract.validOutputExample).sort(),
        payload.outputContract.requiredFields.slice().sort()
      );
      const forbiddenKeys = new Set([
        "sourceContent", "proposedContent", "patch", "diff", "stdout", "stderr",
        "environment", "plannerPrompt", "coderPrompt", "secret", "credential"
      ]);
      const inspect = (value) => {
        if (typeof value !== "object" || value === null) return;
        for (const [key, child] of Object.entries(value)) {
          assert.equal(forbiddenKeys.has(key), false, key);
          inspect(child);
        }
      };
      inspect(payload);
      assert.match(messages[0].content, /passive Shadow Observer/i);
      assert.match(messages[0].content, /Do not alter the plan or approve/i);
      assert.match(messages[0].content, /Do not write or modify code/i);
      assert.match(messages[0].content, /exactly one JSON object/i);
      assert.match(messages[0].content, /advisory evidence only/i);
      assertDeepFrozen(messages);
    });

    await check("valid OpenAI-compatible response completes and retains no raw output", async () => {
      const content = JSON.stringify(observationDraft());
      const { result, calls } = await runScenario(
        completionResponse(content, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      );
      assertDecision(result, "shadow_observer_completed");
      assert.equal(calls, 1);
      assert.equal(result.called, true);
      assert.equal(result.summary.responseReceived, true);
      assert.equal(result.summary.responseParsed, true);
      assert.equal(result.summary.shadowValidationCompleted, true);

      const requestBody = JSON.parse(
        requestBodies[requestBodies.length - 1]
      );

      assert.equal(
        requestBody.response_format.type,
        "json_object"
      );

      assert.equal(
        requestBody.response_format.schema.additionalProperties,
        false
      );

      assert.equal(
        "oneOf" in requestBody.response_format.schema,
        false
      );

      assert.deepEqual(
        requestBody.response_format.schema.properties.runId.enum,
        [trace.runId]
      );

      assert.deepEqual(
        requestBody.response_format.schema.properties.traceHash.enum,
        [trace.traceHash]
      );

      assert.equal(
        requestBody.response_format.schema
          .properties.findings.items.properties
          .evidenceTraceFindingCodes.maxItems,
        0
      );

      assert.ok(result.observation);
      assert.match(result.observation.observationHash, hashPattern);
      assert.match(result.responseContentHash, hashPattern);
      assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      assert.equal(result.summary.findingCount, 0);
      assert.equal(result.summary.riskLevel, "low");
      assert.equal(result.summary.recommendation, "continue");
      const forbiddenResultKeys = new Set(["content", "messages", "upstreamResponse", "requestBody"]);
      const inspect = (value) => {
        if (typeof value !== "object" || value === null) return;
        for (const [key, child] of Object.entries(value)) {
          assert.equal(forbiddenResultKeys.has(key), false, key);
          inspect(child);
        }
      };
      inspect(result);
    });

    await check("strict and complete fenced completion formats parse", async () => {
      const object = observationDraft();
      const json = JSON.stringify(object);
      assert.deepEqual(parseShadowObserverCompletionContent(json), object);
      assert.deepEqual(parseShadowObserverCompletionContent(`\n\`\`\`json\n${json}\n\`\`\`\n`), object);
      assert.deepEqual(parseShadowObserverCompletionContent(`\`\`\`\n${json}\n\`\`\``), object);
      for (const content of [`\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\``]) {
        const { result } = await runScenario(completionResponse(content));
        assertDecision(result, "shadow_observer_completed");
      }
    });

    await check("prose, multiple, unsupported, and partial fences are rejected", async () => {
      const json = JSON.stringify(observationDraft());
      const cases = [
        `before\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`json\n${json}\n\`\`\`\nafter`,
        `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`javascript\n${json}\n\`\`\``,
        `\`\`\`json\n${json}`
      ];
      for (const content of cases) {
        assert.throws(() => parseShadowObserverCompletionContent(content));
        const { result } = await runScenario(completionResponse(content));
        assertDecision(result, "shadow_observer_failed", "malformed_shadow_completion_json");
      }
    });

    await check("medium, high, and critical W.4 observations are preserved", async () => {
      const cases = [
        observationDraft(trace, {
          riskLevel: "medium", riskScore: 35, recommendation: "request_repair",
          findings: [shadowFinding()]
        }),
        observationDraft(trace, {
          riskLevel: "high", riskScore: 60, recommendation: "request_replan",
          findings: [shadowFinding(trace, { severity: "high" })]
        }),
        observationDraft(trace, {
          riskLevel: "critical", riskScore: 90, recommendation: "terminate",
          findings: [shadowFinding(trace, { severity: "critical" })]
        })
      ];
      for (const draft of cases) {
        const { result } = await runScenario(completionResponse(JSON.stringify(draft)));
        assertDecision(result, "shadow_observer_completed");
        assert.equal(result.observation.riskLevel, draft.riskLevel);
        assert.equal(result.observation.recommendation, draft.recommendation);
      }
    });

    await check("W.4 valid, review, and invalid outcomes map deterministically", async () => {
      const firstId = trace.events[0].eventId;
      const secondId = trace.events[1].eventId;
      const duplicate = shadowFinding(trace, { evidenceEventIds: [firstId, secondId] });
      const duplicateReordered = shadowFinding(trace, { evidenceEventIds: [secondId, firstId, firstId] });
      const reviewDraft = observationDraft(trace, {
        riskLevel: "medium",
        riskScore: 35,
        recommendation: "request_repair",
        findings: [duplicate, duplicateReordered]
      });
      const review = (await runScenario(completionResponse(JSON.stringify(reviewDraft)))).result;
      assertDecision(review, "shadow_observer_needs_review", "shadow_observation_validation_needs_review");
      assert.equal(review.validationDecision, "shadow_observation_needs_review");
      assert.ok(review.observation);

      const invalidDrafts = [
        observationDraft(trace, { findings: [shadowFinding(trace, { evidenceEventIds: ["unknown:event"] })] }),
        observationDraft(trace, { runId: "wrong-run" }),
        observationDraft(trace, { traceHash: `sha256:${"b".repeat(64)}` }),
        observationDraft(trace, { riskLevel: "low", riskScore: 10, recommendation: "terminate" })
      ];
      for (const draft of invalidDrafts) {
        const result = (await runScenario(completionResponse(JSON.stringify(draft)))).result;
        assertDecision(result, "shadow_observer_failed", "shadow_observation_validation_failed");
        assert.equal(result.validationDecision, "shadow_observation_invalid");
        assert.equal(result.observation, null);
      }
    });

    await check("trace integrity and event bounds prevent endpoint calls", async () => {
      const tampered = clone(trace);
      tampered.resources.totalTokens += 1;
      const beforeTamper = requestCount;
      const tamperedResult = await runShadowObserverModel(tampered, baseConfig);
      assertDecision(tamperedResult, "shadow_observer_failed", "shadow_trace_integrity_mismatch");
      assert.equal(tamperedResult.called, false);
      assert.equal(requestCount, beforeTamper);

      const exact = await runShadowObserverModel(trace, { ...baseConfig, maxTraceEvents: trace.events.length });
      assert.equal(exact.called, true);
      const beforeOver = requestCount;
      const over = await runShadowObserverModel(trace, { ...baseConfig, maxTraceEvents: trace.events.length - 1 });
      assertDecision(over, "shadow_observer_needs_review", "shadow_trace_event_limit_exceeded");
      assert.equal(over.called, false);
      assert.equal(requestCount, beforeOver);
    });

    await check("prompt exact bound calls once and lower bound prevents the call", async () => {
      const promptChars = buildShadowObserverMessages(trace).reduce((total, message) => total + message.content.length, 0);
      scenario = { status: 200, body: JSON.stringify(completionResponse(JSON.stringify(observationDraft()))), delayMs: 0 };
      const exactBefore = requestCount;
      const exact = await runShadowObserverModel(trace, { ...baseConfig, maxPromptChars: promptChars });
      assertDecision(exact, "shadow_observer_completed");
      assert.equal(requestCount - exactBefore, 1);
      const overBefore = requestCount;
      const over = await runShadowObserverModel(trace, { ...baseConfig, maxPromptChars: promptChars - 1 });
      assertDecision(over, "shadow_observer_needs_review", "shadow_prompt_size_limit_exceeded");
      assert.equal(over.called, false);
      assert.equal(requestCount, overBefore);
    });

    await check("HTTP errors and each request use at most one call", async () => {
      for (const status of [400, 500]) {
        const { result, calls } = await runScenario("SENSITIVE_BODY_MUST_NOT_LEAK", { status });
        assertDecision(result, "shadow_observer_failed", "shadow_upstream_http_error");
        assert.equal(calls, 1);
        assert.equal(JSON.stringify(result).includes("SENSITIVE_BODY_MUST_NOT_LEAK"), false);
      }
      const emptySuccess = await runScenario("", { status: 204 });
      assertDecision(
        emptySuccess.result,
        "shadow_observer_failed",
        "invalid_shadow_upstream_response"
      );
      assert.equal(emptySuccess.calls, 1);
    });

    await check("timeout aborts the one request without endpoint leakage", async () => {
      const { result, calls } = await runScenario(
        completionResponse(JSON.stringify(observationDraft())),
        { delayMs: 100, config: { timeoutMs: 20 } }
      );
      assertDecision(result, "shadow_observer_failed", "shadow_upstream_timeout");
      assert.equal(calls, 1);
    });

    await check("upstream response shapes and completion JSON are strict", async () => {
      const upstreamCases = [
        ["not-json", "invalid_shadow_upstream_response"],
        [JSON.stringify(1), "invalid_shadow_upstream_response"],
        [{}, "invalid_shadow_upstream_response"],
        [{ choices: [] }, "invalid_shadow_upstream_response"],
        [{ choices: [{}] }, "invalid_shadow_upstream_response"],
        [{ choices: [{ message: {} }] }, "missing_shadow_completion_content"],
        [{ choices: [{ message: { content: 1 } }] }, "missing_shadow_completion_content"]
      ];
      for (const [body, code] of upstreamCases) {
        const { result } = await runScenario(body);
        assertDecision(result, "shadow_observer_failed", code);
      }
      for (const content of ["not-json", "[]", "1", "{} trailing"]) {
        const { result } = await runScenario(completionResponse(content));
        assertDecision(result, "shadow_observer_failed", "malformed_shadow_completion_json");
        assert.match(result.responseContentHash, hashPattern);
      }
    });

    await check("response body character limits are enforced before parsing", async () => {
      const content = JSON.stringify(observationDraft());
      const body = JSON.stringify(completionResponse(content));
      const exact = (await runScenario(body, { config: { maxResponseChars: body.length } })).result;
      assertDecision(exact, "shadow_observer_completed");
      assert.equal(exact.summary.responseChars, body.length);

      const sentinel = "OVERSIZED_RAW_OUTPUT_MUST_NOT_LEAK".repeat(20);
      const oversizedBody = JSON.stringify(completionResponse(sentinel));
      const oversized = (
        await runScenario(oversizedBody, { config: { maxResponseChars: oversizedBody.length - 1 } })
      ).result;
      assertDecision(oversized, "shadow_observer_needs_review", "shadow_response_size_limit_exceeded");
      assert.equal(oversized.observation, null);
      assert.equal(JSON.stringify(oversized).includes("OVERSIZED_RAW_OUTPUT_MUST_NOT_LEAK"), false);
    });

    await check("valid, absent, and malformed upstream usage map without losing observation", async () => {
      const content = JSON.stringify(observationDraft());
      const valid = (await runScenario(completionResponse(content, {
        prompt_tokens: 7, completion_tokens: 3, total_tokens: 10
      }))).result;
      assertDecision(valid, "shadow_observer_completed");
      assert.deepEqual(valid.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });

      const absent = (await runScenario(completionResponse(content))).result;
      assertDecision(absent, "shadow_observer_completed");
      assert.equal(absent.usage, null);

      const invalidUsages = [
        { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
        { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
        { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER + 1 }
      ];
      for (const usage of invalidUsages) {
        const result = (await runScenario(completionResponse(content, usage))).result;
        assertDecision(result, "shadow_observer_needs_review", "invalid_shadow_upstream_usage");
        assert.ok(result.observation);
        assert.equal(result.usage, null);
      }
    });

    await check("configuration validation rejects unsafe or excessive values", async () => {
      const invalidConfigs = [
        { ...baseConfig, endpoint: "bad" },
        { ...baseConfig, endpoint: "http://local\nhost/x" },
        { ...baseConfig, endpoint: "ftp://localhost/x" },
        { ...baseConfig, endpoint: "http://user:pass@localhost/x" },
        { ...baseConfig, endpoint: "http://localhost/x#fragment" },
        { ...baseConfig, modelId: "" },
        { ...baseConfig, modelId: " bad" },
        { ...baseConfig, timeoutMs: 0 },
        { ...baseConfig, timeoutMs: 300001 },
        { ...baseConfig, maxTraceEvents: 0 },
        { ...baseConfig, maxPromptChars: 500001 },
        { ...baseConfig, maxResponseChars: 100001 },
        { ...baseConfig, fetchImpl: 1 }
      ];
      for (const config of invalidConfigs) {
        await assert.rejects(runShadowObserverModel(trace, config), TypeError);
      }
    });

    await check("content hash tracks exact raw completion while observation hash tracks normalization", async () => {
      const compact = JSON.stringify(observationDraft());
      const spaced = `  ${compact}\n`;
      const fenced = `\`\`\`json\n${compact}\n\`\`\``;
      const results = [];
      for (const content of [compact, compact, spaced, fenced]) {
        results.push((await runScenario(completionResponse(content))).result);
      }
      for (const result of results) assertDecision(result, "shadow_observer_completed");
      assert.equal(results[0].responseContentHash, results[1].responseContentHash);
      assert.notEqual(results[0].responseContentHash, results[2].responseContentHash);
      assert.notEqual(results[0].responseContentHash, results[3].responseContentHash);
      assert.equal(results[0].observation.observationHash, results[2].observation.observationHash);
      assert.equal(results[0].observation.observationHash, results[3].observation.observationHash);
    });

    await check("adapter is pure, deeply frozen, and semantically repeatable", async () => {
      const mutableTrace = clone(trace);
      const config = { ...baseConfig };
      const traceSnapshot = JSON.stringify(mutableTrace);
      const configSnapshot = JSON.stringify(config);
      const content = JSON.stringify(observationDraft(mutableTrace));
      const first = (await runScenario(completionResponse(content), { trace: mutableTrace })).result;
      const second = (await runScenario(completionResponse(content), { trace: mutableTrace })).result;
      assert.equal(JSON.stringify(mutableTrace), traceSnapshot);
      assert.equal(JSON.stringify(config), configSnapshot);
      assert.equal(Object.isFrozen(mutableTrace), false);
      assert.equal(Object.isFrozen(config), false);
      assertDeepFrozen(first);
      const semantic = (result) => {
        const copy = clone(result);
        delete copy.summary.durationMs;
        return copy;
      };
      assert.deepEqual(semantic(first), semantic(second));
    });

    await check("serialized request contains no prohibited sentinel data", async () => {
      const sentinels = [
        "SOURCE_CODE_SENTINEL",
        "PROPOSED_PATCH_SENTINEL",
        "PLANNER_PROMPT_SENTINEL",
        "CODER_PROMPT_SENTINEL",
        "SECRET_SENTINEL",
        "ENVIRONMENT_SENTINEL",
        "STDOUT_SENTINEL",
        "STDERR_SENTINEL"
      ];
      scenario = {
        status: 200,
        body: JSON.stringify(completionResponse(JSON.stringify(observationDraft()))),
        delayMs: 0
      };
      const beforeBodies = requestBodies.length;
      await runShadowObserverModel(trace, baseConfig);
      const body = requestBodies[beforeBodies];
      for (const sentinel of sentinels) assert.equal(body.includes(sentinel), false);
      const parsed = JSON.parse(body);
      assert.equal(parsed.temperature, 0);
      assert.equal(parsed.stream, false);
      assert.equal(parsed.model, "qwen-shadow");
      assert.deepEqual(Object.keys(parsed).sort(), ["messages", "model", "response_format", "stream", "temperature"]);
      const headers = requestHeaders[requestHeaders.length - 1];
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers.accept, "application/json");
      assert.equal(headers.authorization, undefined);
    });

    await check("runtime index exports W.5 adapter API", async () => {
      assert.equal(runtimeIndex.buildShadowObserverMessages, buildShadowObserverMessages);
      assert.equal(runtimeIndex.parseShadowObserverCompletionContent, parseShadowObserverCompletionContent);
      assert.equal(runtimeIndex.runShadowObserverModel, runShadowObserverModel);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await check("connection failure returns one bounded request failure", async () => {
    const result = await runShadowObserverModel(trace, {
      endpoint,
      modelId: "qwen-shadow",
      timeoutMs: 1000
    });
    assertDecision(result, "shadow_observer_failed", "shadow_upstream_request_failed");
    assert.equal(result.called, true);
  });

  console.log("shadow observer model adapter smoke passed");
})();
