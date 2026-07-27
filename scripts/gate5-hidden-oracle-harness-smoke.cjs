#!/usr/bin/env node

const assert = require("node:assert/strict");

function sorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function exactSet(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const {
    createAcceptanceCriteriaContract,
    createOpenAICompatiblePlannerMinimalityProvider,
    createPreventiveMinimalityPolicy,
    hashCanonicalJson
  } = runtime;

  const objectiveHash = hashCanonicalJson({ task: "Change compute through the existing service boundary." });
  const authorityHash = hashCanonicalJson({ authority: "gate5-fixture" });
  const policyHash = hashCanonicalJson({ policy: "gate5-hidden-oracle" });
  const acceptance = createAcceptanceCriteriaContract({
    taskId: "task.gate5.hidden-oracle",
    objectiveHash,
    criteria: [{
      id: "service_test",
      description: "The existing service test must remain required.",
      required: true,
      evidence: { kind: "test", commandId: "test.service" }
    }]
  });
  const minimalityPolicy = createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "gate5.hidden-oracle",
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
    maxPlannedFiles: 3,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });

  const providerVisibleContext = {
    version: "1",
    taskId: "task.gate5.hidden-oracle",
    objectiveHash,
    acceptanceContractHash: acceptance.contractHash,
    authorityHash,
    policyHash,
    limits: {
      maxSeedFiles: 2,
      maxRequiredSymbols: 2,
      maxRequiredTests: 1,
      maxExpansionAttempts: 1
    },
    allowedChangeFiles: ["src/service.ts", "tests/service.test.ts"],
    forbiddenFiles: ["package.json"],
    minimalityPolicy,
    taskContext: {
      task: "Change compute through the existing service boundary.",
      candidateFiles: [
        { path: "src/index.ts", symbols: ["run"], role: "public entrypoint" },
        { path: "src/service.ts", symbols: ["compute"], role: "implementation" },
        { path: "src/types.ts", symbols: ["Input"], role: "type definition" },
        { path: "tests/service.test.ts", symbols: [], role: "test" }
      ],
      repositoryHints: { installedDependencies: ["typescript"] }
    }
  };

  const evaluatorOnlyOracle = Object.freeze({
    seedFiles: ["src/service.ts"],
    requiredSymbols: ["compute"],
    requiredTestFiles: ["tests/service.test.ts"],
    plannedFiles: ["src/service.ts"]
  });

  const providerDraft = {
    proposal: {
      proposalVersion: "1",
      taskId: providerVisibleContext.taskId,
      objectiveHash,
      acceptanceContractHash: acceptance.contractHash,
      authorityHash,
      policyHash,
      seedFiles: ["src/service.ts"],
      seedRationales: [{ path: "src/service.ts", reason: "Contains the existing compute implementation." }],
      requiredSymbols: ["compute"],
      requiredTestFiles: ["tests/service.test.ts"],
      maxExpansionAttempts: 1
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
      newAbstractions: []
    }
  };

  let capturedRequest = null;
  const adapter = createOpenAICompatiblePlannerMinimalityProvider({
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    model: "fixture-model",
    maxAttempts: 1,
    fetchImpl: async (_url, init) => {
      capturedRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(providerDraft) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await adapter.invoke(providerVisibleContext);
  assert(capturedRequest);

  const providerPayload = JSON.parse(capturedRequest.messages[1].content);
  const serializedPayload = JSON.stringify(providerPayload);
  assert.equal(Object.hasOwn(providerPayload, "requiredOutcome"), false);
  assert.equal(Object.hasOwn(providerPayload, "oracle"), false);
  assert.equal(serializedPayload.includes("evaluatorOnlyOracle"), false);
  assert.equal(serializedPayload.includes(JSON.stringify(evaluatorOnlyOracle)), false);

  const proposal = result.output.proposal;
  const minimality = result.output.minimalityPlan;
  const metrics = Object.freeze({
    seedFilesExact: exactSet(proposal.seedFiles, evaluatorOnlyOracle.seedFiles),
    requiredSymbolsExact: exactSet(proposal.requiredSymbols, evaluatorOnlyOracle.requiredSymbols),
    requiredTestFilesExact: exactSet(proposal.requiredTestFiles, evaluatorOnlyOracle.requiredTestFiles),
    plannedFilesExact: exactSet(minimality.plannedFiles.map((entry) => entry.path), evaluatorOnlyOracle.plannedFiles)
  });
  const passed = Object.values(metrics).every(Boolean);
  assert.equal(passed, true);

  console.log(JSON.stringify({
    ok: true,
    decision: "gate5_hidden_oracle_harness_ready",
    evidenceClass: "unguided_live_selection",
    providerVisibleOracleLeakage: false,
    metrics
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
