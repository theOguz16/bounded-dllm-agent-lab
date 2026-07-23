const fsp = require("node:fs/promises");
const path = require("node:path");

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function requiredIncludes(actual, expected, label) {
  for (const item of expected) {
    if (!actual.includes(item)) {
      throw new Error(`${label} is missing required item: ${item}`);
    }
  }
}

async function main() {
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

  const {
    createOpenAICompatiblePlannerProvider,
    verifyOpenAICompatiblePlannerRunEvidence
  } = adapterApi;
  const { validateBoundedPlannerProposal } = plannerApi;
  const { createAcceptanceCriteriaContract } = acceptanceApi;
  const { hashCanonicalJson } = ledgerApi;

  const endpoint = process.env.AG2B_PLANNER_ENDPOINT
    ?? "http://127.0.0.1:8000/v1/chat/completions";
  const model = process.env.AG2B_PLANNER_MODEL ?? "qwen2.5-coder-7b";
  const apiKey = process.env.AG2B_PLANNER_API_KEY;
  const responseFormat = process.env.AG2B_RESPONSE_FORMAT ?? "json_object";
  const timeoutMs = Number(process.env.AG2B_TIMEOUT_MS ?? "120000");
  const maxAttempts = Number(process.env.AG2B_MAX_ATTEMPTS ?? "2");
  const inputRate = envNumber("AG2B_INPUT_USD_PER_MILLION");
  const outputRate = envNumber("AG2B_OUTPUT_USD_PER_MILLION");
  if ((inputRate === null) !== (outputRate === null)) {
    throw new Error("Both AG2B input and output comparison rates must be set together.");
  }
  const pricing = inputRate === null
    ? undefined
    : {
        inputUsdPerMillionTokens: inputRate,
        outputUsdPerMillionTokens: outputRate
      };

  const authorityHash = hashCanonicalJson({
    authority: "ag2b-live-planner-validation",
    version: "1"
  });
  const policyHash = hashCanonicalJson({
    policy: "ag2b-live-bounded-proposal",
    maxSeedFiles: 2,
    maxRequiredSymbols: 3,
    maxRequiredTests: 1,
    maxExpansionAttempts: 1
  });
  const limits = {
    maxSeedFiles: 2,
    maxRequiredSymbols: 3,
    maxRequiredTests: 1,
    maxExpansionAttempts: 1
  };

  const cases = [
    {
      id: "planner_contract_primary_file",
      task: "Identify the minimal implementation seed for changing bounded planner proposal validation.",
      candidates: [
        {
          path: "packages/product-runtime/src/bounded-planner-proposal-contract.ts",
          symbols: [
            "createBoundedPlannerProposal",
            "validateBoundedPlannerProposal",
            "runBoundedPlannerTaskFlow"
          ],
          role: "primary implementation"
        },
        {
          path: "packages/product-runtime/src/task-to-seed-implementation-contract.ts",
          symbols: ["createTaskToSeedImplementationContract"],
          role: "downstream contract"
        },
        {
          path: "scripts/ag2a-bounded-planner-proposal-contract-smoke.cjs",
          symbols: [],
          role: "required regression test"
        }
      ],
      expected: {
        seedFiles: ["packages/product-runtime/src/bounded-planner-proposal-contract.ts"],
        requiredSymbols: ["validateBoundedPlannerProposal"],
        requiredTestFiles: ["scripts/ag2a-bounded-planner-proposal-contract-smoke.cjs"]
      }
    },
    {
      id: "planner_provider_adapter_file",
      task: "Identify the minimal implementation seed for changing the OpenAI-compatible planner provider adapter.",
      candidates: [
        {
          path: "packages/product-runtime/src/openai-compatible-planner-provider.ts",
          symbols: [
            "createOpenAICompatiblePlannerProvider",
            "verifyOpenAICompatiblePlannerRunEvidence"
          ],
          role: "primary implementation"
        },
        {
          path: "packages/product-runtime/src/bounded-planner-proposal-contract.ts",
          symbols: ["createBoundedPlannerProposal"],
          role: "validated downstream contract"
        },
        {
          path: "scripts/ag2b-openai-compatible-planner-provider-smoke.cjs",
          symbols: [],
          role: "required regression test"
        }
      ],
      expected: {
        seedFiles: ["packages/product-runtime/src/openai-compatible-planner-provider.ts"],
        requiredSymbols: ["createOpenAICompatiblePlannerProvider"],
        requiredTestFiles: ["scripts/ag2b-openai-compatible-planner-provider-smoke.cjs"]
      }
    }
  ];

  const results = [];
  for (const testCase of cases) {
    const taskId = `task.ag2b.live.${testCase.id}`;
    const objectiveHash = hashCanonicalJson({ task: testCase.task });
    const acceptance = createAcceptanceCriteriaContract({
      taskId,
      objectiveHash,
      criteria: [
        {
          id: "planner_selection",
          description: "The planner must select the required minimal seed, symbol, and regression test.",
          required: true,
          evidence: { kind: "human_review", reviewKey: `ag2b.${testCase.id}` }
        }
      ]
    });
    const context = {
      version: "1",
      taskId,
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash,
      limits,
      forbiddenFiles: [],
      taskContext: {
        task: testCase.task,
        candidateFiles: testCase.candidates,
        requiredOutcome: {
          instruction: "Include every listed required item. You may include one additional candidate only when strictly necessary.",
          ...testCase.expected,
          maxExpansionAttempts: 1
        }
      }
    };
    const adapter = createOpenAICompatiblePlannerProvider({
      endpoint,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      timeoutMs,
      maxAttempts,
      retryDelayMs: 250,
      maxOutputTokens: 2_048,
      temperature: 0,
      maxResponseBytes: 1_000_000,
      maxTaskContextBytes: 250_000,
      responseFormat,
      ...(pricing === undefined ? {} : { pricing })
    });

    try {
      const invocation = await adapter.invoke(context);
      const validation = validateBoundedPlannerProposal({
        rawProposal: invocation.proposal,
        taskId,
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        limits,
        forbiddenFiles: []
      });
      if (validation.decision !== "planner_proposal_ready") {
        throw new Error(`Bounded proposal validation returned ${validation.decision}.`);
      }
      requiredIncludes(invocation.proposal.seedFiles, testCase.expected.seedFiles, "seedFiles");
      requiredIncludes(
        invocation.proposal.requiredSymbols,
        testCase.expected.requiredSymbols,
        "requiredSymbols"
      );
      requiredIncludes(
        invocation.proposal.requiredTestFiles,
        testCase.expected.requiredTestFiles,
        "requiredTestFiles"
      );
      if (!verifyOpenAICompatiblePlannerRunEvidence(invocation.evidence)) {
        throw new Error("Provider run evidence integrity verification failed.");
      }
      results.push({
        caseId: testCase.id,
        decision: "passed",
        proposalHash: invocation.proposal.proposalHash,
        seedFiles: invocation.proposal.seedFiles,
        requiredSymbols: invocation.proposal.requiredSymbols,
        requiredTestFiles: invocation.proposal.requiredTestFiles,
        evidence: invocation.evidence,
        failureCode: null
      });
    } catch (error) {
      const evidence = adapter.getLastRunEvidence();
      results.push({
        caseId: testCase.id,
        decision: "failed",
        proposalHash: null,
        seedFiles: [],
        requiredSymbols: [],
        requiredTestFiles: [],
        evidence,
        failureCode: evidence?.failureCode ?? "live_case_validation_failed",
        errorMessage: error instanceof Error ? error.message : "Live validation failed."
      });
    }
  }

  const passedCaseCount = results.filter((entry) => entry.decision === "passed").length;
  const runs = results.map((entry) => entry.evidence).filter(Boolean);
  const totalAttempts = runs.reduce((sum, run) => sum + run.attemptCount, 0);
  const totalInputTokens = runs.reduce((sum, run) => sum + run.knownInputTokens, 0);
  const totalOutputTokens = runs.reduce((sum, run) => sum + run.knownOutputTokens, 0);
  const totalTokens = runs.reduce((sum, run) => sum + run.knownTotalTokens, 0);
  const knownCosts = runs.map((run) => run.knownCostUsd).filter((value) => value !== null);
  const comparisonCostUsd = knownCosts.length === 0
    ? null
    : Number(knownCosts.reduce((sum, value) => sum + value, 0).toFixed(12));
  const reportCore = {
    evidenceVersion: "1",
    phase: "AG.2b-live",
    evidenceClass: "observed_run",
    decision: passedCaseCount === cases.length
      ? "ag2b_live_planner_validation_passed"
      : "ag2b_live_planner_validation_failed",
    provider: {
      model,
      endpointIdentityHash: runs[0]?.endpointIdentityHash ?? null,
      responseFormat,
      maxAttempts
    },
    caseCount: cases.length,
    passedCaseCount,
    failedCaseCount: cases.length - passedCaseCount,
    totalAttempts,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    pricingSource: pricing === undefined ? "not_configured" : "operator_configured_rates",
    comparisonCostUsd,
    infrastructureCostObserved: false,
    liveModelQualityObserved: true,
    liveTokenUsageObserved: runs.some((run) => run.usageAvailableAttemptCount > 0),
    cases: results
  };
  const report = {
    ...reportCore,
    reportHash: hashCanonicalJson(reportCore)
  };
  const reportPath = process.env.AG2B_LIVE_REPORT_PATH
    ?? "reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER_LIVE.json";
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    decision: report.decision,
    path: reportPath,
    reportHash: report.reportHash,
    caseCount: report.caseCount,
    passedCaseCount: report.passedCaseCount,
    totalAttempts: report.totalAttempts,
    totalTokens: report.totalTokens,
    pricingSource: report.pricingSource,
    comparisonCostUsd: report.comparisonCostUsd,
    infrastructureCostObserved: false
  }, null, 2));
  if (passedCaseCount !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
