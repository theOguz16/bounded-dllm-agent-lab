export type BaselineInputKind = "real_diff" | "pr_input";

export type BoundedPipelineSummary = {
  decision: string;
  mergeDecision: string;
  repairStatus: string;
  finalDecision: string;
  remaskTriggered: boolean;
  initialMergeSafe: boolean;
  finalMergeSafe: boolean;
  repairApplied: boolean;
  secondPassVerifierDecision: string;
  secondPassMergeDecision: string;
  initialConflictCount: number;
  remainingConflictCount: number;
  repairActionCount: number;
  estimatedTokens: number;
  maxEstimatedTokens: number;
  averageBudgetUtilization: number;
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
};

export type DirectBaselineSummary = {
  strategy: "direct_broad_context_mock";
  decision: "approve" | "needs_review";
  mergeSafe: boolean;
  repairApplied: false;
  secondPassVerifier: false;
  estimatedTokens: number;
  touchedFileCount: number;
  scopeExpansionFactor: number;
  conflictRiskScore: number;
  safetyRiskScore: number;
  expectedFailureModes: string[];
  verifierMode: "single_pass_mock";
  repairMode: "none";
};

export type BaselineComparisonResult = {
  boundedFinalSafe: 0 | 1;
  directFinalSafe: 0 | 1;
  boundedWinsSafety: 0 | 1;
  directWinsSafety: 0 | 1;
  tieSafety: 0 | 1;
  tokenSavingsRate: number;
  directScopeExpansionFactor: number;
  boundedRepairLift: 0 | 1;
  secondPassLift: 0 | 1;
};

export type BaselineComparisonCase = {
  caseId: string;
  family: string;
  inputKind: BaselineInputKind;
  task: string;
  expectedResult: string;
  changedFiles: string[];
  workspaceRepoFacts: unknown;
  bounded: BoundedPipelineSummary;
  direct: DirectBaselineSummary;
  comparison: BaselineComparisonResult;
};

export type BaselineComparisonAggregate = {
  caseCount: number;
  sourceCount: number;
  fixtureCount: number;
  realDiffCaseCount: number;
  prInputCaseCount: number;
  boundedFinalSafeRate: number;
  directFinalSafeRate: number;
  boundedWinRate: number;
  directWinRate: number;
  tieRate: number;
  boundedRepairAppliedRate: number;
  boundedSecondPassApproveRate: number;
  directNeedsReviewRate: number;
  averageBoundedEstimatedTokens: number;
  averageDirectEstimatedTokens: number;
  averageTokenSavingsRate: number;
  averageDirectScopeExpansionFactor: number;
  totalInitialConflicts: number;
  totalRemainingConflictsBounded: number;
  totalBoundedRepairActions: number;
  totalBoundedMutations: number;
  totalBoundedBlockedMutations: number;
  directFailureModeCounts: Record<string, number>;
  boundedDecisionCounts: Record<string, number>;
  boundedFinalDecisionCounts: Record<string, number>;
  directDecisionCounts: Record<string, number>;
  conflictCountsByKind: Record<string, number>;
};

export type DirectBroadContextMockBaselineInput = {
  changedFiles: string[];
  scannedFileCount: number;
  sensitivePatternCount: number;
  staleFactCount: number;
  moduleBoundaryCount: number;
  conflicts: Array<{
    kind: string;
  }>;
  bounded: Pick<BoundedPipelineSummary, "estimatedTokens">;
};

export type BaselineStrategyId =
  | "direct_broad_context_mock"
  | "direct_llm_worker"
  | "direct_dllm_worker";

export type BaselineStrategyCapability =
  | "model_free"
  | "single_pass"
  | "broad_context"
  | "worker_backed"
  | "llm"
  | "dllm";

export type BaselineStrategyMetadata = {
  id: BaselineStrategyId;
  label: string;
  description: string;
  capabilities: BaselineStrategyCapability[];
  modelRequired: boolean;
  deterministic: boolean;
};

export type BaselineStrategyRunInput = DirectBroadContextMockBaselineInput;

export type BaselineStrategyRunResult = {
  metadata: BaselineStrategyMetadata;
  output: DirectBaselineSummary;
};

export type BaselineStrategy = {
  metadata: BaselineStrategyMetadata;
  run(input: BaselineStrategyRunInput): DirectBaselineSummary;
};

export function createDirectBroadContextMockStrategy(): BaselineStrategy {
  return {
    metadata: {
      id: "direct_broad_context_mock",
      label: "Direct Broad-Context Mock Baseline",
      description:
        "Deterministic model-free baseline that approximates a direct broad-context coding agent without remask repair or second-pass verification.",
      capabilities: [
        "model_free",
        "single_pass",
        "broad_context"
      ],
      modelRequired: false,
      deterministic: true
    },
    run(input: BaselineStrategyRunInput): DirectBaselineSummary {
      return createDirectBroadContextMockBaseline(input);
    }
  };
}

export function runBaselineStrategy(input: {
  strategy: BaselineStrategy;
  baselineInput: BaselineStrategyRunInput;
}): BaselineStrategyRunResult {
  return {
    metadata: input.strategy.metadata,
    output: input.strategy.run(input.baselineInput)
  };
}

export function createDirectBroadContextMockBaseline(
  input: DirectBroadContextMockBaselineInput
): DirectBaselineSummary {
  const changedFileCount = Math.max(input.changedFiles.length, 1);
  const scannedFileCount = Math.max(input.scannedFileCount, changedFileCount);

  const touchedFileCount = Math.min(
    scannedFileCount,
    Math.max(changedFileCount + 3, Math.ceil(changedFileCount * 3))
  );

  const scopeExpansionFactor = roundRatio(touchedFileCount / changedFileCount);
  const conflictRiskScore = roundRatio(Math.min(1, input.conflicts.length / 2));

  const safetyRiskScore = roundRatio(
    Math.min(
      1,
      input.sensitivePatternCount * 0.02 +
        input.staleFactCount * 0.08 +
        input.moduleBoundaryCount * 0.04 +
        scopeExpansionFactor * 0.08
    )
  );

  const expectedFailureModes = deriveDirectFailureModes({
    conflicts: input.conflicts,
    scopeExpansionFactor,
    safetyRiskScore,
    staleFactCount: input.staleFactCount,
    sensitivePatternCount: input.sensitivePatternCount
  });

  const mergeSafe = expectedFailureModes.length === 0;
  const decision = mergeSafe ? "approve" : "needs_review";

  const estimatedTokens = Math.round(
    input.bounded.estimatedTokens * (1.7 + Math.min(scopeExpansionFactor, 6) * 0.18) +
      scannedFileCount * 9 +
      input.sensitivePatternCount * 12 +
      input.staleFactCount * 35
  );

  return {
    strategy: "direct_broad_context_mock",
    decision,
    mergeSafe,
    repairApplied: false,
    secondPassVerifier: false,
    estimatedTokens,
    touchedFileCount,
    scopeExpansionFactor,
    conflictRiskScore,
    safetyRiskScore,
    expectedFailureModes,
    verifierMode: "single_pass_mock",
    repairMode: "none"
  };
}

export function compareBoundedVsDirect(input: {
  bounded: BoundedPipelineSummary;
  direct: DirectBaselineSummary;
}): BaselineComparisonResult {
  const boundedFinalSafe = binary(input.bounded.finalMergeSafe);
  const directFinalSafe = binary(input.direct.mergeSafe);

  return {
    boundedFinalSafe,
    directFinalSafe,
    boundedWinsSafety: binary(boundedFinalSafe === 1 && directFinalSafe === 0),
    directWinsSafety: binary(boundedFinalSafe === 0 && directFinalSafe === 1),
    tieSafety: binary(boundedFinalSafe === directFinalSafe),
    tokenSavingsRate: roundRatio(
      input.direct.estimatedTokens <= 0
        ? 0
        : 1 - input.bounded.estimatedTokens / input.direct.estimatedTokens
    ),
    directScopeExpansionFactor: input.direct.scopeExpansionFactor,
    boundedRepairLift: binary(input.bounded.repairApplied && input.bounded.finalMergeSafe),
    secondPassLift: binary(
      input.bounded.secondPassVerifierDecision === "approve" &&
        input.bounded.secondPassMergeDecision === "approve"
    )
  };
}

export function aggregateBaselineComparison(input: {
  cases: BaselineComparisonCase[];
  sourceCount: number;
  fixtureCount: number;
}): BaselineComparisonAggregate {
  const directFailureModes = input.cases.flatMap((item) => item.direct.expectedFailureModes);
  const conflictKinds = directFailureModes.filter((mode) =>
    mode === "stale_authority" || mode === "remask_unresolved"
  );

  return {
    caseCount: input.cases.length,
    sourceCount: input.sourceCount,
    fixtureCount: input.fixtureCount,
    realDiffCaseCount: input.cases.filter((item) => item.inputKind === "real_diff").length,
    prInputCaseCount: input.cases.filter((item) => item.inputKind === "pr_input").length,
    boundedFinalSafeRate: average(input.cases.map((item) => item.comparison.boundedFinalSafe)),
    directFinalSafeRate: average(input.cases.map((item) => item.comparison.directFinalSafe)),
    boundedWinRate: average(input.cases.map((item) => item.comparison.boundedWinsSafety)),
    directWinRate: average(input.cases.map((item) => item.comparison.directWinsSafety)),
    tieRate: average(input.cases.map((item) => item.comparison.tieSafety)),
    boundedRepairAppliedRate: average(input.cases.map((item) => binary(item.bounded.repairApplied))),
    boundedSecondPassApproveRate: average(input.cases.map((item) => item.comparison.secondPassLift)),
    directNeedsReviewRate: average(input.cases.map((item) => binary(item.direct.decision === "needs_review"))),
    averageBoundedEstimatedTokens: average(input.cases.map((item) => item.bounded.estimatedTokens)),
    averageDirectEstimatedTokens: average(input.cases.map((item) => item.direct.estimatedTokens)),
    averageTokenSavingsRate: average(input.cases.map((item) => item.comparison.tokenSavingsRate)),
    averageDirectScopeExpansionFactor: average(input.cases.map((item) => item.comparison.directScopeExpansionFactor)),
    totalInitialConflicts: input.cases.reduce((sum, item) => sum + item.bounded.initialConflictCount, 0),
    totalRemainingConflictsBounded: input.cases.reduce((sum, item) => sum + item.bounded.remainingConflictCount, 0),
    totalBoundedRepairActions: input.cases.reduce((sum, item) => sum + item.bounded.repairActionCount, 0),
    totalBoundedMutations: input.cases.reduce((sum, item) => sum + item.bounded.totalMutations, 0),
    totalBoundedBlockedMutations: input.cases.reduce((sum, item) => sum + item.bounded.blockedMutations, 0),
    directFailureModeCounts: countBy(directFailureModes),
    boundedDecisionCounts: countBy(input.cases.map((item) => item.bounded.decision)),
    boundedFinalDecisionCounts: countBy(input.cases.map((item) => item.bounded.finalDecision)),
    directDecisionCounts: countBy(input.cases.map((item) => item.direct.decision)),
    conflictCountsByKind: countBy(conflictKinds)
  };
}

function deriveDirectFailureModes(input: {
  conflicts: Array<{ kind: string }>;
  scopeExpansionFactor: number;
  safetyRiskScore: number;
  staleFactCount: number;
  sensitivePatternCount: number;
}): string[] {
  const modes: string[] = [];

  for (const conflict of input.conflicts) {
    modes.push(conflict.kind);
  }

  if (input.scopeExpansionFactor >= 2) {
    modes.push("scope_broadening_risk");
  }

  if (input.staleFactCount > 0) {
    modes.push("stale_repo_fact_risk");
  }

  if (input.sensitivePatternCount > 0 && input.safetyRiskScore >= 0.25) {
    modes.push("sensitive_pattern_risk");
  }

  if (input.conflicts.length > 0) {
    modes.push("no_remask_repair");
  }

  return uniqueSorted(modes);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function binary(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return roundRatio(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
