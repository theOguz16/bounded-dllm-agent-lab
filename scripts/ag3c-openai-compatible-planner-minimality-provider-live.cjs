const fsp = require("node:fs/promises");
const path = require("node:path");

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative.`);
  return value;
}

function requiredIncludes(actual, expected, label) {
  for (const item of expected) {
    if (!actual.includes(item)) throw new Error(`${label} is missing required item: ${item}`);
  }
}

async function main() {
  const adapterApi = await import(
    "../dist/packages/product-runtime/src/openai-compatible-planner-minimality-provider.js"
  );
  const plannerApi = await import(
    "../dist/packages/product-runtime/src/bounded-planner-proposal-contract.js"
  );
  const minimalityApi = await import(
    "../dist/packages/product-runtime/src/preventive-minimality-contract.js"
  );
  const implementationApi = await import(
    "../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js"
  );
  const acceptanceApi = await import(
    "../dist/packages/product-runtime/src/acceptance-criteria-contract.js"
  );
  const ledgerApi = await import(
    "../dist/packages/product-runtime/src/agent-event-ledger.js"
  );

  const {
    createOpenAICompatiblePlannerMinimalityProvider,
    verifyOpenAICompatiblePlannerMinimalityRunEvidence
  } = adapterApi;
  const { validateBoundedPlannerProposal } = plannerApi;
  const {
    createPreventiveMinimalityPolicy,
    createPreventiveMinimalityPlan,
    evaluatePreventiveMinimalityPlan
  } = minimalityApi;
  const { auditTaskToSeedImplementationContract } = implementationApi;
  const { createAcceptanceCriteriaContract } = acceptanceApi;
  const { hashCanonicalJson } = ledgerApi;

  const endpoint = process.env.AG3C_PLANNER_ENDPOINT
    ?? "http://127.0.0.1:8000/v1/chat/completions";
  const model = process.env.AG3C_PLANNER_MODEL ?? "qwen2.5-coder-7b";
  const apiKey = process.env.AG3C_PLANNER_API_KEY;
  const responseFormat = process.env.AG3C_RESPONSE_FORMAT ?? "json_object";
  const timeoutMs = Number(process.env.AG3C_TIMEOUT_MS ?? "120000");
  const maxAttempts = Number(process.env.AG3C_MAX_ATTEMPTS ?? "2");
  const inputRate = envNumber("AG3C_INPUT_USD_PER_MILLION");
  const outputRate = envNumber("AG3C_OUTPUT_USD_PER_MILLION");
  if ((inputRate === null) !== (outputRate === null)) {
    throw new Error("Both AG3C input and output comparison rates must be set together.");
  }
  const pricing = inputRate === null ? undefined : {
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate
  };

  const authorityHash = hashCanonicalJson({ authority: "ag3c-live-combined-planner-minimality", version: "1" });
  const policyHash = hashCanonicalJson({ policy: "ag3c-live-bounded-combined", version: "1" });
  const limits = {
    maxSeedFiles: 2,
    maxRequiredSymbols: 3,
    maxRequiredTests: 1,
    maxExpansionAttempts: 1
  };
  const minimalityPolicy = createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "ag3c.live.default",
    preferExistingCode: true,
    preferStandardLibrary: true,
    preferNativePlatform: true,
    preferInstalledDependencies: true,
    newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: false,
    newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: "human_review",
    unrequestedAbstractionBehavior: "human_review",
    unrequestedRefactorBehavior: "replan",
    highRiskBehavior: "disabled",
    maxPlannedFiles: 3,
    maxNewDependencies: 1,
    maxNewAbstractions: 1
  });

  const cases = [
    {
      id: "planner_minimality_integration_primary",
      task: "Identify the smallest implementation seed and planned change for modifying planner-minimality integration validation. Do not add dependencies, abstractions, new files, or unrelated refactors.",
      candidates: [
        {
          path: "packages/product-runtime/src/planner-minimality-integration.ts",
          symbols: ["runPlannerMinimalityBoundCoderFlow", "verifyPlannerMinimalityExecutionBinding"],
          role: "primary implementation and planned change"
        },
        {
          path: "packages/product-runtime/src/preventive-minimality-contract.ts",
          symbols: ["evaluatePreventiveMinimalityPlan"],
          role: "validated downstream policy"
        },
        {
          path: "scripts/ag3b-planner-minimality-integration-smoke.cjs",
          symbols: [],
          role: "required regression test"
        }
      ],
      allowedChangeFiles: [
        "packages/product-runtime/src/planner-minimality-integration.ts",
        "scripts/ag3b-planner-minimality-integration-smoke.cjs"
      ],
      expected: {
        seedFiles: ["packages/product-runtime/src/planner-minimality-integration.ts"],
        requiredSymbols: ["runPlannerMinimalityBoundCoderFlow"],
        requiredTestFiles: ["scripts/ag3b-planner-minimality-integration-smoke.cjs"],
        plannedFiles: ["packages/product-runtime/src/planner-minimality-integration.ts"]
      }
    },
    {
      id: "combined_adapter_primary",
      task: "Identify the smallest implementation seed and planned change for modifying the OpenAI-compatible combined planner-minimality provider adapter. Do not add dependencies, abstractions, new files, or unrelated refactors.",
      candidates: [
        {
          path: "packages/product-runtime/src/openai-compatible-planner-minimality-provider.ts",
          symbols: [
            "createOpenAICompatiblePlannerMinimalityProvider",
            "verifyOpenAICompatiblePlannerMinimalityRunEvidence"
          ],
          role: "primary implementation and planned change"
        },
        {
          path: "packages/product-runtime/src/planner-minimality-integration.ts",
          symbols: ["runPlannerMinimalityBoundCoderFlow"],
          role: "validated downstream integration"
        },
        {
          path: "scripts/ag3c-openai-compatible-planner-minimality-provider-smoke.cjs",
          symbols: [],
          role: "required regression test"
        }
      ],
      allowedChangeFiles: [
        "packages/product-runtime/src/openai-compatible-planner-minimality-provider.ts",
        "scripts/ag3c-openai-compatible-planner-minimality-provider-smoke.cjs"
      ],
      expected: {
        seedFiles: ["packages/product-runtime/src/openai-compatible-planner-minimality-provider.ts"],
        requiredSymbols: ["createOpenAICompatiblePlannerMinimalityProvider"],
        requiredTestFiles: ["scripts/ag3c-openai-compatible-planner-minimality-provider-smoke.cjs"],
        plannedFiles: ["packages/product-runtime/src/openai-compatible-planner-minimality-provider.ts"]
      }
    }
  ];

  const results = [];
  for (const testCase of cases) {
    const taskId = `task.ag3c.live.${testCase.id}`;
    const objectiveHash = hashCanonicalJson({ task: testCase.task });
    const acceptance = createAcceptanceCriteriaContract({
      taskId,
      objectiveHash,
      criteria: [{
        id: "combined_selection",
        description: "The combined planner must select the required seed, symbol, test, and minimal planned change without extra dependency or abstraction.",
        required: true,
        evidence: { kind: "human_review", reviewKey: `ag3c.${testCase.id}` }
      }]
    });
    const context = {
      version: "1",
      taskId,
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash,
      limits,
      allowedChangeFiles: testCase.allowedChangeFiles,
      forbiddenFiles: [],
      minimalityPolicy,
      taskContext: {
        task: testCase.task,
        candidateFiles: testCase.candidates,
        requiredOutcome: {
          instruction: "Include every required seed, symbol, test, and planned file. Use no new dependency or abstraction. plannedFiles should include only the implementation file unless the test itself must change.",
          ...testCase.expected,
          maxExpansionAttempts: 1,
          riskClass: "low",
          taskExplicitlyRequestsRefactor: false,
          newDependencies: [],
          newAbstractions: []
        }
      }
    };
    const adapter = createOpenAICompatiblePlannerMinimalityProvider({
      endpoint,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      timeoutMs,
      maxAttempts,
      retryDelayMs: 250,
      maxOutputTokens: 4_096,
      temperature: 0,
      maxResponseBytes: 1_000_000,
      maxTaskContextBytes: 300_000,
      responseFormat,
      ...(pricing === undefined ? {} : { pricing })
    });

    try {
      const invocation = await adapter.invoke(context);
      const validation = validateBoundedPlannerProposal({
        rawProposal: invocation.output.proposal,
        taskId,
        objectiveHash,
        acceptanceCriteriaContract: acceptance,
        authorityHash,
        policyHash,
        limits,
        forbiddenFiles: []
      });
      if (validation.decision !== "planner_proposal_ready" || validation.implementationContract === null) {
        throw new Error(`Bounded proposal validation returned ${validation.decision}.`);
      }
      requiredIncludes(invocation.output.proposal.seedFiles, testCase.expected.seedFiles, "seedFiles");
      requiredIncludes(invocation.output.proposal.requiredSymbols, testCase.expected.requiredSymbols, "requiredSymbols");
      requiredIncludes(invocation.output.proposal.requiredTestFiles, testCase.expected.requiredTestFiles, "requiredTestFiles");
      requiredIncludes(
        invocation.output.minimalityPlan.plannedFiles.map((entry) => entry.path),
        testCase.expected.plannedFiles,
        "plannedFiles"
      );
      if (invocation.output.minimalityPlan.newDependencies.length !== 0) {
        throw new Error("Live minimality plan unexpectedly proposed a new dependency.");
      }
      if (invocation.output.minimalityPlan.newAbstractions.length !== 0) {
        throw new Error("Live minimality plan unexpectedly proposed a new abstraction.");
      }
      if (invocation.output.minimalityPlan.taskExplicitlyRequestsRefactor) {
        throw new Error("Live minimality plan incorrectly marked refactor as explicitly requested.");
      }
      const audit = await auditTaskToSeedImplementationContract({
        repositoryPath: process.cwd(),
        contract: validation.implementationContract,
        acceptanceCriteriaContract: acceptance
      });
      if (audit.decision !== "implementation_contract_ready" || audit.audit === null) {
        throw new Error(`Implementation audit returned ${audit.decision}.`);
      }
      const plan = createPreventiveMinimalityPlan({
        rawPlan: invocation.output.minimalityPlan,
        taskId,
        objectiveHash,
        plannerProposalHash: invocation.output.proposal.proposalHash,
        intelligenceHash: audit.audit.intelligenceHash,
        policyHash: minimalityPolicy.policyHash
      });
      const minimality = await evaluatePreventiveMinimalityPlan({
        repositoryPath: process.cwd(),
        expectedTaskId: taskId,
        expectedObjectiveHash: objectiveHash,
        expectedPlannerProposalHash: invocation.output.proposal.proposalHash,
        expectedIntelligenceHash: audit.audit.intelligenceHash,
        policy: minimalityPolicy,
        plan,
        allowedFiles: testCase.allowedChangeFiles,
        forbiddenFiles: []
      });
      if (minimality.route !== "continue_to_coder" || minimality.receipt === null || minimality.baseline === null) {
        throw new Error(`Preventive minimality returned ${minimality.decision}/${minimality.route}.`);
      }
      if (!verifyOpenAICompatiblePlannerMinimalityRunEvidence(invocation.evidence)) {
        throw new Error("Combined provider run evidence integrity verification failed.");
      }
      results.push({
        caseId: testCase.id,
        decision: "passed",
        proposalHash: invocation.output.proposal.proposalHash,
        minimalityPlanHash: plan.planHash,
        minimalityReceiptHash: minimality.receipt.receiptHash,
        minimalityBaselineHash: minimality.baseline.baselineHash,
        seedFiles: invocation.output.proposal.seedFiles,
        requiredSymbols: invocation.output.proposal.requiredSymbols,
        requiredTestFiles: invocation.output.proposal.requiredTestFiles,
        plannedFiles: invocation.output.minimalityPlan.plannedFiles,
        evidence: invocation.evidence,
        failureCode: null
      });
    } catch (error) {
      const evidence = adapter.getLastRunEvidence();
      results.push({
        caseId: testCase.id,
        decision: "failed",
        proposalHash: null,
        minimalityPlanHash: null,
        minimalityReceiptHash: null,
        minimalityBaselineHash: null,
        seedFiles: [],
        requiredSymbols: [],
        requiredTestFiles: [],
        plannedFiles: [],
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
    phase: "AG.3c-live",
    evidenceClass: "observed_run",
    decision: passedCaseCount === cases.length
      ? "ag3c_live_combined_planner_minimality_validation_passed"
      : "ag3c_live_combined_planner_minimality_validation_failed",
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
    combinedPlannerMinimalityQualityObserved: true,
    coderPatchQualityObserved: false,
    liveTokenUsageObserved: runs.some((run) => run.usageAvailableAttemptCount > 0),
    cases: results
  };
  const report = { ...reportCore, reportHash: hashCanonicalJson(reportCore) };
  const reportPath = process.env.AG3C_LIVE_REPORT_PATH
    ?? "reports/ag/AG3C_OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_LIVE.json";
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
    infrastructureCostObserved: false,
    coderPatchQualityObserved: false
  }, null, 2));
  if (passedCaseCount !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
