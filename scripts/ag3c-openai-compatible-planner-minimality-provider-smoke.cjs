const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPORT_PATH = "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER.json";

function envelope(content, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    ...(usage === null ? {} : { usage })
  });
}

function jsonResponse(content, options = {}) {
  const body = options.rawEnvelope ?? envelope(content, options.usage === undefined
    ? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    : options.usage);
  return new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
}

async function main() {
  const mode = process.argv.includes("--report")
    ? "report"
    : process.argv.includes("--verify")
      ? "verify"
      : "test";

  const adapterApi = await import(
    "../dist/packages/product-runtime/src/openai-compatible-planner-minimality-provider.js"
  );
  const integrationApi = await import(
    "../dist/packages/product-runtime/src/planner-minimality-integration.js"
  );
  const minimalityApi = await import(
    "../dist/packages/product-runtime/src/preventive-minimality-contract.js"
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
    createOpenAICompatiblePlannerMinimalityProvider,
    verifyOpenAICompatiblePlannerMinimalityRunEvidence
  } = adapterApi;
  const { runPlannerMinimalityBoundCoderFlow } = integrationApi;
  const { createPreventiveMinimalityPolicy } = minimalityApi;
  const { createAcceptanceCriteriaContract } = acceptanceApi;
  const { hashCanonicalJson } = ledgerApi;

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  const fixture = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ag3c-adapter-"));
    roots.push(root);
    const files = {
      "src/index.ts": [
        'import { compute } from "./service.js";',
        'export { compute } from "./service.js";',
        'export function run(value: Input): number { return compute(value); }',
        'import type { Input } from "./types.js";'
      ].join("\n") + "\n",
      "src/service.ts": [
        'import type { Input } from "./types.js";',
        'export function compute(value: Input): number { return value.amount * 2; }'
      ].join("\n") + "\n",
      "src/types.ts": "export type Input = { amount: number };\n",
      "tests/service.test.ts": [
        'import { compute } from "../src/service.js";',
        'void compute({ amount: 2 });'
      ].join("\n") + "\n",
      "package.json": JSON.stringify({
        type: "module",
        dependencies: { typescript: "^5.6.3" }
      }, null, 2) + "\n"
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
    }
    return { root, files };
  };

  const evidenceFor = (files, paths) => paths.map((file) => {
    const content = files[file];
    const bytes = Buffer.from(content, "utf8");
    return {
      path: file,
      source: "ag3c_fixture",
      content,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: file === "src/service.ts" ? ["compute"] : []
    };
  });

  const objectiveHash = hashCanonicalJson({ task: "Change compute through the existing service boundary." });
  const authorityHash = hashCanonicalJson({ authority: "ag3c-fixture" });
  const policyHash = hashCanonicalJson({ policy: "bounded-context-ag3c" });
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.ag3c.fixture",
    objectiveHash,
    criteria: [{
      id: "service_test",
      description: "The existing service test must pass.",
      required: true,
      evidence: { kind: "test", commandId: "test.service" }
    }]
  });
  const limits = {
    maxSeedFiles: 2,
    maxRequiredSymbols: 3,
    maxRequiredTests: 1,
    maxExpansionAttempts: 1
  };
  const minimalityPolicy = createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "ag3c.default",
    preferExistingCode: true,
    preferStandardLibrary: true,
    preferNativePlatform: true,
    preferInstalledDependencies: true,
    newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true,
    newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: "human_review",
    unrequestedAbstractionBehavior: "human_review",
    unrequestedRefactorBehavior: "replan",
    highRiskBehavior: "disabled",
    maxPlannedFiles: 4,
    maxNewDependencies: 2,
    maxNewAbstractions: 2
  });
  const context = {
    version: "1",
    taskId: "task.ag3c.fixture",
    objectiveHash,
    acceptanceContractHash: acceptance.contractHash,
    authorityHash,
    policyHash,
    limits,
    allowedChangeFiles: ["src/service.ts", "tests/service.test.ts"],
    forbiddenFiles: [],
    minimalityPolicy,
    taskContext: {
      task: "Change compute through the existing service boundary.",
      candidateFiles: [
        { path: "src/service.ts", symbols: ["compute"], role: "primary implementation" },
        { path: "tests/service.test.ts", symbols: [], role: "required test" }
      ],
      repositoryHints: { installedDependencies: ["typescript"] }
    }
  };
  const validDraft = (overrides = {}) => ({
    proposal: {
      proposalVersion: "1",
      taskId: context.taskId,
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash,
      seedFiles: ["src/service.ts"],
      seedRationales: [{ path: "src/service.ts", reason: "Existing compute implementation boundary." }],
      requiredSymbols: ["compute"],
      requiredTestFiles: ["tests/service.test.ts"],
      maxExpansionAttempts: 1,
      ...(overrides.proposal ?? {})
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [{
        path: "src/service.ts",
        changeKind: "bugfix",
        requested: true,
        justification: null
      }],
      newDependencies: [],
      newAbstractions: [],
      ...(overrides.minimalityPlan ?? {})
    },
    ...(overrides.top ?? {})
  });

  const first = await fixture();
  try {
    await check("canonical runtime exports the combined OpenAI-compatible adapter", async () => {
      assert.equal(typeof canonicalRuntime.createOpenAICompatiblePlannerMinimalityProvider, "function");
      assert.equal(typeof canonicalRuntime.verifyOpenAICompatiblePlannerMinimalityRunEvidence, "function");
    });

    await check("adapter configuration rejects unsafe endpoints and invalid bounds", async () => {
      assert.throws(() => createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "file:///tmp/model", model: "fixture"
      }));
      assert.throws(() => createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions?secret=x", model: "fixture"
      }));
      assert.throws(() => createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions", model: "fixture", maxAttempts: 3
      }));
    });

    let capturedBody = null;
    const exactAdapter = createOpenAICompatiblePlannerMinimalityProvider({
      endpoint: "http://127.0.0.1:8000/v1/chat/completions",
      model: "fixture-model",
      maxAttempts: 1,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return jsonResponse(JSON.stringify(validDraft()));
      }
    });
    const exact = await exactAdapter.invoke(context);

    await check("exact provider response produces canonical proposal and minimality drafts", async () => {
      assert.equal(exact.output.proposal.proposalVersion, "1");
      assert.match(exact.output.proposal.proposalHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(exact.output.proposal.seedRationales[0].reasonHash.startsWith("sha256:"), true);
      assert.equal(exact.output.minimalityPlan.planVersion, "1");
      assert.equal(exact.output.minimalityPlan.plannedFiles[0].path, "src/service.ts");
      assert.equal(Object.isFrozen(exact.output), true);
    });

    await check("one provider request carries the exact combined schema and minimality policy", async () => {
      assert(capturedBody);
      assert.equal(capturedBody.messages.length, 2);
      assert.match(capturedBody.messages[0].content, /top-level object must contain exactly proposal and minimalityPlan/);
      const payload = JSON.parse(capturedBody.messages[1].content);
      assert.equal(payload.taskId, context.taskId);
      assert.equal(payload.minimalityPolicy.policyHash, minimalityPolicy.policyHash);
      assert.deepEqual(payload.allowedChangeFiles, context.allowedChangeFiles);
    });

    await check("observed run evidence is hash linked and tamper evident", async () => {
      assert.equal(verifyOpenAICompatiblePlannerMinimalityRunEvidence(exact.evidence), true);
      assert.equal(exact.evidence.decision, "planner_minimality_provider_succeeded");
      assert.equal(exact.evidence.proposalHash, exact.output.proposal.proposalHash);
      assert.match(exact.evidence.minimalityDraftHash, /^sha256:[0-9a-f]{64}$/);
      const tampered = JSON.parse(JSON.stringify(exact.evidence));
      tampered.knownTotalTokens += 1;
      assert.equal(verifyOpenAICompatiblePlannerMinimalityRunEvidence(tampered), false);
    });

    await check("strict fenced JSON is accepted without trusting model hashes", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        fetchImpl: async () => jsonResponse("```json\n" + JSON.stringify(validDraft()) + "\n```")
      });
      const result = await adapter.invoke(context);
      assert.match(result.output.proposal.proposalHash, /^sha256:/);
    });

    await check("model-supplied hashes and unknown fields trigger one corrective retry", async () => {
      let calls = 0;
      const invalid = validDraft({ proposal: { proposalHash: `sha256:${"a".repeat(64)}` } });
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 2,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(JSON.stringify(calls === 1 ? invalid : validDraft()));
        }
      });
      const result = await adapter.invoke(context);
      assert.equal(calls, 2);
      assert.equal(result.evidence.attempts[0].failureCode, "planner_minimality_adapter_draft_invalid");
      assert.equal(result.evidence.attempts[1].decision, "succeeded");
    });

    await check("malformed JSON triggers one corrective retry", async () => {
      let calls = 0;
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 2,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(calls === 1 ? "{bad" : JSON.stringify(validDraft()));
        }
      });
      const result = await adapter.invoke(context);
      assert.equal(result.evidence.attemptCount, 2);
      assert.equal(result.evidence.attempts[0].failureCode, "planner_minimality_adapter_response_json_invalid");
    });

    await check("HTTP 429 is retried once and then succeeds", async () => {
      let calls = 0;
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 2,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse("rate limited", { status: 429 })
            : jsonResponse(JSON.stringify(validDraft()));
        }
      });
      const result = await adapter.invoke(context);
      assert.equal(result.evidence.attemptCount, 2);
      assert.equal(result.evidence.attempts[0].failureCode, "planner_minimality_adapter_http_retryable");
    });

    await check("non-retryable HTTP failures stop after one attempt", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 2,
        fetchImpl: async () => jsonResponse("bad request", { status: 400 })
      });
      await assert.rejects(adapter.invoke(context));
      assert.equal(adapter.getLastRunEvidence().attemptCount, 1);
      assert.equal(adapter.getLastRunEvidence().failureCode, "planner_minimality_adapter_http_non_retryable");
    });

    await check("timeout failures participate in bounded retry", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        timeoutMs: 100,
        fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        })
      });
      await assert.rejects(adapter.invoke(context));
      assert.equal(adapter.getLastRunEvidence().failureCode, "planner_minimality_adapter_timeout");
    });

    await check("oversized task context stops before the network call", async () => {
      let calls = 0;
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        maxTaskContextBytes: 1024,
        fetchImpl: async () => { calls += 1; return jsonResponse(JSON.stringify(validDraft())); }
      });
      await assert.rejects(adapter.invoke({ ...context, taskContext: { huge: "x".repeat(10_000) } }));
      assert.equal(calls, 0);
      assert.equal(adapter.getLastRunEvidence().failureCode, "planner_minimality_adapter_task_context_too_large");
    });

    await check("oversized provider responses fail closed", async () => {
      const huge = JSON.stringify({ choices: [{ message: { content: "x".repeat(2_000) } }] });
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        maxResponseBytes: 1024,
        fetchImpl: async () => new Response(huge, { status: 200 })
      });
      await assert.rejects(adapter.invoke(context));
      assert.equal(adapter.getLastRunEvidence().failureCode, "planner_minimality_adapter_response_too_large");
    });

    await check("missing usage stays explicit and does not fabricate cost", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
        fetchImpl: async () => jsonResponse(JSON.stringify(validDraft()), { usage: null })
      });
      const result = await adapter.invoke(context);
      assert.equal(result.evidence.usageAvailableAttemptCount, 0);
      assert.equal(result.evidence.knownCostUsd, null);
    });

    await check("usage and operator-configured rates aggregate deterministically", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
        fetchImpl: async () => jsonResponse(JSON.stringify(validDraft()), {
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
        })
      });
      const result = await adapter.invoke(context);
      assert.equal(result.evidence.knownCostUsd, 0.002);
      assert.equal(result.evidence.pricingSource, "operator_configured_rates");
    });

    await check("identity drift exhausts bounded retries without producing output", async () => {
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 2,
        fetchImpl: async () => jsonResponse(JSON.stringify(validDraft({ proposal: { taskId: "task.other" } })))
      });
      await assert.rejects(adapter.invoke(context));
      assert.equal(adapter.getLastRunEvidence().attemptCount, 2);
      assert.equal(adapter.getLastRunEvidence().outputHash, null);
    });

    await check("combined adapter reaches exactly one planner and one coder call", async () => {
      let fetchCalls = 0;
      let coderCalls = 0;
      let observedContext = null;
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        fetchImpl: async () => {
          fetchCalls += 1;
          return jsonResponse(JSON.stringify(validDraft()));
        }
      });
      const result = await runPlannerMinimalityBoundCoderFlow({
        repositoryPath: first.root,
        taskId: context.taskId,
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        proposalLimits: limits,
        minimalityPolicy,
        allowedChangeFiles: context.allowedChangeFiles,
        forbiddenFiles: [],
        taskContext: context.taskContext,
        initialEvidence: evidenceFor(first.files, [
          "src/service.ts", "src/types.ts", "tests/service.test.ts"
        ]),
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 8192,
        reservedOutputTokens: 512,
        plannerMinimalityProvider: adapter.plannerMinimalityProvider,
        contextRequestProvider: async () => { throw new Error("Complete evidence must not expand."); },
        coderProvider: async (coderContext) => {
          coderCalls += 1;
          observedContext = coderContext;
          return { kind: "patch", files: ["src/service.ts"] };
        }
      });
      assert.equal(result.decision, "planner_minimality_task_completed", JSON.stringify(result));
      assert.equal(result.route, "coder_executed");
      assert.equal(fetchCalls, 1);
      assert.equal(coderCalls, 1);
      assert.equal(result.summary.plannerProviderCallCount, 1);
      assert.equal(result.summary.coderProviderCallCount, 1);
      assert(observedContext.baseContext.taskContext.taskContext.minimality.receiptHash);
    });

    await check("installed dependency declarations are replanned before coder", async () => {
      let coderCalls = 0;
      const dependencyDraft = validDraft({
        minimalityPlan: {
          newDependencies: [{
            name: "typescript",
            requested: false,
            purpose: "Already installed compiler API.",
            justification: "Needed for AST access.",
            standardLibraryConsidered: true,
            nativePlatformConsidered: true,
            existingDependenciesConsidered: [],
            whyExistingInsufficient: null
          }]
        }
      });
      const adapter = createOpenAICompatiblePlannerMinimalityProvider({
        endpoint: "http://127.0.0.1:8000/v1/chat/completions",
        model: "fixture",
        maxAttempts: 1,
        fetchImpl: async () => jsonResponse(JSON.stringify(dependencyDraft))
      });
      const result = await runPlannerMinimalityBoundCoderFlow({
        repositoryPath: first.root,
        taskId: context.taskId,
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        proposalLimits: limits,
        minimalityPolicy,
        allowedChangeFiles: context.allowedChangeFiles,
        forbiddenFiles: [],
        taskContext: context.taskContext,
        authorityPresent: true,
        policyPresent: true,
        hardTotalBudgetTokens: 8192,
        plannerMinimalityProvider: adapter.plannerMinimalityProvider,
        contextRequestProvider: async () => ({}),
        coderProvider: async () => { coderCalls += 1; return {}; }
      });
      assert.equal(result.route, "replan_required");
      assert.equal(coderCalls, 0);
      assert(result.issues.some((entry) => entry.code === "minimality_installed_dependency_should_be_reused"));
    });

    await check("provider execution does not mutate repository fixture bytes", async () => {
      for (const [relative, content] of Object.entries(first.files)) {
        assert.equal(await fsp.readFile(path.join(first.root, relative), "utf8"), content);
      }
    });

    const reportCore = {
      evidenceClass: "deterministic_fixture",
      phase: "AG.3c",
      decision: "ag3c_openai_compatible_planner_minimality_adapter_evidence_ready",
      checkCount: checks.length,
      checks,
      readyForRunPodLiveValidation: true,
      claims: {
        combinedProviderAdapterImplemented: true,
        singleModelCallContractVerified: true,
        coderIntegrationVerifiedWithFixtureProvider: true,
        observedLiveModelQuality: false,
        observedCoderPatchQuality: false,
        observedTokenSavings: false,
        observedInfrastructureCost: false
      }
    };
    const report = { ...reportCore, reportHash: hashCanonicalJson(reportCore) };

    if (mode === "report") {
      await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
      await fsp.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
      process.stdout.write(JSON.stringify({
        decision: "ag3c_openai_compatible_planner_minimality_adapter_evidence_written",
        path: REPORT_PATH,
        reportHash: report.reportHash,
        checkCount: checks.length,
        readyForRunPodLiveValidation: true
      }, null, 2) + "\n");
    } else if (mode === "verify") {
      const stored = JSON.parse(await fsp.readFile(REPORT_PATH, "utf8"));
      assert.deepEqual(stored, report);
      process.stdout.write(JSON.stringify({
        decision: report.decision,
        reportHash: report.reportHash,
        checkCount: checks.length,
        readyForRunPodLiveValidation: true
      }, null, 2) + "\n");
    } else {
      process.stdout.write(`AG.3c combined adapter smoke passed (${checks.length} checks)\n`);
    }
  } finally {
    await Promise.all(roots.map((entry) => fsp.rm(entry, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
