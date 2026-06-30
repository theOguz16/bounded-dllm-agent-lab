import {
  BaselineStrategyUnavailableError,
  createDirectBroadContextMockStrategy,
  createDirectDllmWorkerPlaceholderStrategy,
  createDirectLlmWorkerPlaceholderStrategy,
  getBaselineStrategyById,
  listBaselineStrategies,
  runBaselineStrategy,
  type BaselineStrategy,
  type BaselineStrategyId,
  type BaselineStrategyRunInput
} from "../../../packages/baseline-core/src/index.js";

type StrategySmokeResult = {
  strategyId: BaselineStrategyId;
  modelRequired: boolean;
  deterministic: boolean;
  capabilityCount: number;
  runMode: "executed" | "unavailable";
  outputDecision: string | null;
  unavailableReason: string | null;
};

const sampleInput: BaselineStrategyRunInput = {
  changedFiles: [
    "apps/cli/src/baseline-comparison-report.ts",
    "packages/baseline-core/src/index.ts",
    "package.json"
  ],
  scannedFileCount: 188,
  sensitivePatternCount: 20,
  staleFactCount: 3,
  moduleBoundaryCount: 2,
  conflicts: [
    { kind: "stale_authority" },
    { kind: "remask_unresolved" }
  ],
  bounded: {
    estimatedTokens: 3800
  }
};

const strategies = [
  createDirectBroadContextMockStrategy(),
  createDirectLlmWorkerPlaceholderStrategy(),
  createDirectDllmWorkerPlaceholderStrategy()
];

const results = strategies.map((strategy) => evaluateStrategy(strategy));
const failures = validateSmoke(results);

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        smokeName: "baseline-strategy-contract-smoke",
        failures,
        results
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      smokeName: "baseline-strategy-contract-smoke",
      strategyCount: strategies.length,
      modelFreeCount: results.filter((result) => !result.modelRequired).length,
      workerBackedPlaceholderCount: results.filter((result) => result.modelRequired).length,
      executedCount: results.filter((result) => result.runMode === "executed").length,
      unavailableCount: results.filter((result) => result.runMode === "unavailable").length,
      results
    },
    null,
    2
  )
);

function evaluateStrategy(strategy: BaselineStrategy): StrategySmokeResult {
  try {
    const result = runBaselineStrategy({
      strategy,
      baselineInput: sampleInput
    });

    return {
      strategyId: strategy.metadata.id,
      modelRequired: strategy.metadata.modelRequired,
      deterministic: strategy.metadata.deterministic,
      capabilityCount: strategy.metadata.capabilities.length,
      runMode: "executed",
      outputDecision: result.output.decision,
      unavailableReason: null
    };
  } catch (error) {
    if (error instanceof BaselineStrategyUnavailableError) {
      return {
        strategyId: strategy.metadata.id,
        modelRequired: strategy.metadata.modelRequired,
        deterministic: strategy.metadata.deterministic,
        capabilityCount: strategy.metadata.capabilities.length,
        runMode: "unavailable",
        outputDecision: null,
        unavailableReason: error.reason
      };
    }

    throw error;
  }
}

function validateSmoke(results: StrategySmokeResult[]): string[] {
  const failures: string[] = [];
  const registered = listBaselineStrategies();

  if (registered.length !== 3) {
    failures.push(`Expected 3 registered baseline strategies, received ${registered.length}.`);
  }

  for (const id of [
    "direct_broad_context_mock",
    "direct_llm_worker",
    "direct_dllm_worker"
  ] as const) {
    if (!getBaselineStrategyById(id)) {
      failures.push(`Expected getBaselineStrategyById to resolve ${id}.`);
    }
  }

  const mock = results.find((result) => result.strategyId === "direct_broad_context_mock");
  const llm = results.find((result) => result.strategyId === "direct_llm_worker");
  const dllm = results.find((result) => result.strategyId === "direct_dllm_worker");

  if (!mock) failures.push("Missing direct_broad_context_mock result.");
  if (!llm) failures.push("Missing direct_llm_worker result.");
  if (!dllm) failures.push("Missing direct_dllm_worker result.");

  if (mock && mock.modelRequired) {
    failures.push("direct_broad_context_mock must not require a model.");
  }

  if (mock && mock.runMode !== "executed") {
    failures.push("direct_broad_context_mock should execute locally.");
  }

  if (mock && mock.outputDecision !== "needs_review") {
    failures.push(`Expected mock output decision needs_review, received ${mock.outputDecision}.`);
  }

  for (const worker of [llm, dllm]) {
    if (!worker) continue;

    if (!worker.modelRequired) {
      failures.push(`${worker.strategyId} must require a model.`);
    }

    if (worker.deterministic) {
      failures.push(`${worker.strategyId} must not be deterministic.`);
    }

    if (worker.runMode !== "unavailable") {
      failures.push(`${worker.strategyId} should be unavailable until worker endpoint is configured.`);
    }

    if (worker.unavailableReason !== "worker_not_configured") {
      failures.push(`${worker.strategyId} should fail with worker_not_configured.`);
    }
  }

  return failures;
}
