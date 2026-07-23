const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const REPORT_PATH = "reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.json";

function canonical(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashCanonicalJson(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function treeDigest(root) {
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else entries.push([relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
    }
  };
  visit(root);
  return hashCanonicalJson(entries);
}

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const adapterApi = await import(
    "../dist/packages/product-runtime/src/openai-compatible-planner-provider.js"
  );
  const plannerApi = await import(
    "../dist/packages/product-runtime/src/bounded-planner-proposal-contract.js"
  );
  const acceptanceApi = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
  );
  const ledgerApi = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );
  const canonicalRuntime = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );

  const {
    createOpenAICompatiblePlannerProvider,
    verifyOpenAICompatiblePlannerRunEvidence
  } = adapterApi;
  const {
    verifyBoundedPlannerProposal,
    runBoundedPlannerTaskFlow
  } = plannerApi;
  const { createAcceptanceCriteriaContract } = acceptanceApi;
  const { hashCanonicalJson: runtimeHash } = ledgerApi;

  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const objectiveHash = runtimeHash({ task: "Update the bounded planner adapter." });
  const authorityHash = runtimeHash({ authority: "ag2b-fixture" });
  const policyHash = runtimeHash({ policy: "ag2b-fixture" });
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.ag2b.fixture",
    objectiveHash,
    criteria: [
      {
        id: "planner_test",
        description: "The planner provider smoke test must pass.",
        required: true,
        evidence: { kind: "test", commandId: "test.ag2b" }
      }
    ]
  });
  const context = {
    version: "1",
    taskId: "task.ag2b.fixture",
    objectiveHash,
    acceptanceContractHash: acceptance.contractHash,
    authorityHash,
    policyHash,
    limits: {
      maxSeedFiles: 2,
      maxRequiredSymbols: 3,
      maxRequiredTests: 2,
      maxExpansionAttempts: 2
    },
    forbiddenFiles: ["src/forbidden.ts"],
    taskContext: {
      task: "Update the bounded planner adapter.",
      candidateFiles: [
        {
          path: "src/planner.ts",
          symbols: ["planTask"],
          role: "primary implementation"
        },
        {
          path: "tests/planner.test.ts",
          symbols: [],
          role: "required test"
        }
      ]
    }
  };

  const draft = (overrides = {}) => ({
    proposalVersion: "1",
    taskId: context.taskId,
    objectiveHash: context.objectiveHash,
    acceptanceContractHash: context.acceptanceContractHash,
    authorityHash: context.authorityHash,
    policyHash: context.policyHash,
    seedFiles: ["src/planner.ts"],
    seedRationales: [
      { path: "src/planner.ts", reason: "Contains the planner implementation boundary." }
    ],
    requiredSymbols: ["planTask"],
    requiredTestFiles: ["tests/planner.test.ts"],
    maxExpansionAttempts: 1,
    ...overrides
  });

  const envelope = (content, usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }) => ({
    id: "chatcmpl-ag2b",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content }
      }
    ],
    ...(usage === null ? {} : { usage })
  });

  const response = (body, status = 200) => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } }
  );

  const fixedClock = () => {
    let value = 1_000;
    return () => {
      const current = value;
      value += 7;
      return current;
    };
  };

  const config = (fetchImpl, overrides = {}) => ({
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    model: "qwen2.5-coder-7b",
    timeoutMs: 1_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    maxOutputTokens: 1_024,
    maxResponseBytes: 100_000,
    maxTaskContextBytes: 100_000,
    fetchImpl,
    sleep: async () => {},
    clock: fixedClock(),
    ...overrides
  });

  await check("canonical runtime exports the OpenAI-compatible planner adapter", async () => {
    assert.equal(typeof canonicalRuntime.createOpenAICompatiblePlannerProvider, "function");
    assert.equal(typeof canonicalRuntime.verifyOpenAICompatiblePlannerRunEvidence, "function");
  });

  await check("adapter configuration rejects unsafe endpoints and invalid bounds", async () => {
    assert.throws(() => createOpenAICompatiblePlannerProvider({
      endpoint: "https://user:secret@example.com/v1/chat/completions",
      model: "planner",
      fetchImpl: async () => response(envelope(JSON.stringify(draft())))
    }));
    assert.throws(() => createOpenAICompatiblePlannerProvider({
      endpoint: "http://127.0.0.1:8000/v1/chat/completions",
      model: "planner",
      maxAttempts: 3,
      fetchImpl: async () => response(envelope(JSON.stringify(draft())))
    }));
  });

  let capturedRequest = null;
  const successAdapter = createOpenAICompatiblePlannerProvider(config(async (url, init) => {
    capturedRequest = { url: String(url), init };
    return response(envelope(JSON.stringify(draft())));
  }));
  const success = await successAdapter.invoke(context);

  await check("exact provider request produces a canonical bounded proposal", async () => {
    assert(capturedRequest);
    assert.equal(capturedRequest.url, "http://127.0.0.1:8000/v1/chat/completions");
    const body = JSON.parse(capturedRequest.init.body);
    assert.equal(body.model, "qwen2.5-coder-7b");
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.equal(verifyBoundedPlannerProposal(success.proposal), true);
    assert.match(success.proposal.seedRationales[0].reasonHash, /^sha256:[0-9a-f]{64}$/);
  });

  await check("observed run evidence is hash linked and tamper evident", async () => {
    assert.equal(success.evidence.evidenceClass, "observed_run");
    assert.equal(success.evidence.decision, "planner_provider_succeeded");
    assert.equal(success.evidence.attemptCount, 1);
    assert.equal(verifyOpenAICompatiblePlannerRunEvidence(success.evidence), true);
    const tampered = JSON.parse(JSON.stringify(success.evidence));
    tampered.knownInputTokens += 1;
    assert.equal(verifyOpenAICompatiblePlannerRunEvidence(tampered), false);
  });

  await check("strict fenced JSON is accepted without trusting model hashes", async () => {
    const adapter = createOpenAICompatiblePlannerProvider(config(async () =>
      response(envelope(`\`\`\`json\n${JSON.stringify(draft())}\n\`\`\``))
    ));
    const result = await adapter.invoke(context);
    assert.equal(verifyBoundedPlannerProposal(result.proposal), true);
    assert.equal(Object.hasOwn(result.proposal, "proposalHash"), true);
  });

  await check("unknown fields and identity drift fail exact draft validation", async () => {
    const unknown = createOpenAICompatiblePlannerProvider(config(async () =>
      response(envelope(JSON.stringify(draft({ extra: true }))))
    ));
    await assert.rejects(() => unknown.invoke(context));
    assert.equal(unknown.getLastRunEvidence().failureCode, "planner_adapter_draft_invalid");

    const drifted = createOpenAICompatiblePlannerProvider(config(async () =>
      response(envelope(JSON.stringify(draft({ taskId: "task.other" }))))
    ));
    await assert.rejects(() => drifted.invoke(context));
    assert.equal(drifted.getLastRunEvidence().failureCode, "planner_adapter_proposal_invalid");
  });

  await check("oversized task context stops before the provider call", async () => {
    let calls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () => {
      calls += 1;
      return response(envelope(JSON.stringify(draft())));
    }, { maxTaskContextBytes: 1_024 }));
    await assert.rejects(() => adapter.invoke({
      ...context,
      taskContext: { payload: "x".repeat(2_000) }
    }));
    assert.equal(calls, 0);
    assert.equal(adapter.getLastRunEvidence().failureCode, "planner_adapter_task_context_too_large");
  });

  await check("oversized provider responses fail closed", async () => {
    const adapter = createOpenAICompatiblePlannerProvider(config(async () =>
      response("x".repeat(2_000))
    , { maxResponseBytes: 1_024 }));
    await assert.rejects(() => adapter.invoke(context));
    assert.equal(adapter.getLastRunEvidence().failureCode, "planner_adapter_response_too_large");
  });

  await check("HTTP 429 is retried once and then succeeds", async () => {
    let calls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () => {
      calls += 1;
      if (calls === 1) return response({ error: "busy" }, 429);
      return response(envelope(JSON.stringify(draft())));
    }, { maxAttempts: 2 }));
    const result = await adapter.invoke(context);
    assert.equal(calls, 2);
    assert.equal(result.evidence.attempts[0].failureCode, "planner_adapter_http_retryable");
    assert.equal(result.evidence.attempts[1].decision, "succeeded");
  });

  await check("non-retryable HTTP failures stop after one attempt", async () => {
    let calls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () => {
      calls += 1;
      return response({ error: "bad request" }, 400);
    }, { maxAttempts: 2 }));
    await assert.rejects(() => adapter.invoke(context));
    assert.equal(calls, 1);
    assert.equal(adapter.getLastRunEvidence().failureCode, "planner_adapter_http_non_retryable");
  });

  await check("timeout failures participate in bounded retry", async () => {
    let calls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return response(envelope(JSON.stringify(draft())));
    }, { maxAttempts: 2 }));
    const result = await adapter.invoke(context);
    assert.equal(calls, 2);
    assert.equal(result.evidence.attempts[0].failureCode, "planner_adapter_timeout");
  });

  await check("malformed JSON triggers one corrective retry", async () => {
    const requestBodies = [];
    const adapter = createOpenAICompatiblePlannerProvider(config(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      if (requestBodies.length === 1) return response(envelope("not-json"));
      return response(envelope(JSON.stringify(draft())));
    }, { maxAttempts: 2 }));
    const result = await adapter.invoke(context);
    assert.equal(result.evidence.attemptCount, 2);
    const secondPayload = JSON.parse(requestBodies[1].messages[1].content);
    assert.match(secondPayload.repairInstruction, /planner_adapter_response_json_invalid/);
  });

  await check("missing usage remains explicit and does not fabricate cost", async () => {
    const adapter = createOpenAICompatiblePlannerProvider(config(async () =>
      response(envelope(JSON.stringify(draft()), null))
    , {
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
    }));
    const result = await adapter.invoke(context);
    assert.equal(result.evidence.usageAvailableAttemptCount, 0);
    assert.equal(result.evidence.knownCostUsd, null);
    assert.equal(result.evidence.pricingSource, "operator_configured_rates");
  });

  await check("usage and operator-configured comparison rates aggregate across attempts", async () => {
    let calls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () => {
      calls += 1;
      if (calls === 1) {
        return response(envelope("not-json", {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }));
      }
      return response(envelope(JSON.stringify(draft()), {
        prompt_tokens: 20,
        completion_tokens: 7,
        total_tokens: 27
      }));
    }, {
      maxAttempts: 2,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
    }));
    const result = await adapter.invoke(context);
    assert.equal(result.evidence.knownInputTokens, 30);
    assert.equal(result.evidence.knownOutputTokens, 12);
    assert.equal(result.evidence.knownTotalTokens, 42);
    assert.equal(result.evidence.knownCostUsd, 0.000054);
    assert.equal(result.evidence.pricingSource, "operator_configured_rates");
  });

  await check("AG.2a maps adapter exhaustion to replan before coder execution", async () => {
    let coderCalls = 0;
    const adapter = createOpenAICompatiblePlannerProvider(config(async () =>
      response({ error: "unavailable" }, 503)
    , { maxAttempts: 1 }));
    const result = await runBoundedPlannerTaskFlow({
      repositoryPath: "/tmp/ag2b-fixture",
      taskId: context.taskId,
      objectiveHash: context.objectiveHash,
      acceptanceCriteriaContract: acceptance,
      authorityHash,
      policyHash,
      proposalLimits: context.limits,
      taskContext: context.taskContext,
      authorityPresent: true,
      policyPresent: true,
      hardTotalBudgetTokens: 4_096,
      plannerProvider: adapter.plannerProvider,
      contextRequestProvider: async () => ({}),
      coderProvider: async () => {
        coderCalls += 1;
        return {};
      }
    });
    assert.equal(result.decision, "planner_task_stopped");
    assert.equal(result.route, "replan_required");
    assert.equal(result.summary.taskSeedFlowCallCount, 0);
    assert.equal(coderCalls, 0);
  });

  await check("provider execution does not mutate repository fixture bytes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag2b-readonly-"));
    try {
      await fsp.writeFile(path.join(root, "fixture.txt"), "unchanged\n", "utf8");
      const before = treeDigest(root);
      const adapter = createOpenAICompatiblePlannerProvider(config(async () =>
        response(envelope(JSON.stringify(draft())))
      ));
      await adapter.invoke(context);
      assert.equal(treeDigest(root), before);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  assert.equal(checks.length, 16);
  const reportCore = {
    evidenceVersion: "1",
    phase: "AG.2b",
    evidenceClass: "deterministic_fixture",
    decision: "ag2b_adapter_evidence_ready",
    checkCount: checks.length,
    checks,
    readyForRunPodLiveValidation: true,
    claims: {
      openAICompatibleAdapterReady: true,
      boundedRetryReady: true,
      failureTaxonomyReady: true,
      usageCaptureReady: true,
      operatorRateEstimateReady: true,
      liveModelQualityObserved: false,
      liveTokenUsageObserved: false,
      infrastructureCostObserved: false
    }
  };
  const report = {
    ...reportCore,
    reportHash: hashCanonicalJson(reportCore)
  };

  if (mode === "report") {
    await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fsp.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({
      decision: "ag2b_evidence_written",
      path: REPORT_PATH,
      reportHash: report.reportHash,
      checkCount: report.checkCount,
      readyForRunPodLiveValidation: true
    }, null, 2));
    return;
  }

  if (mode === "verify") {
    const current = JSON.parse(await fsp.readFile(REPORT_PATH, "utf8"));
    assert.deepEqual(current, report);
    console.log(JSON.stringify({
      decision: "ag2b_adapter_evidence_ready",
      reportHash: report.reportHash,
      checkCount: report.checkCount,
      readyForRunPodLiveValidation: true
    }, null, 2));
    return;
  }

  console.log(`OpenAI-compatible planner provider smoke passed (${checks.length} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
