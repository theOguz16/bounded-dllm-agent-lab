export type ProductReadinessInput = {
  decisionAccuracy: number;
  missedBlockerRate: number;
  falsePositiveRate: number;
  expectedFindingCoverage: number;
  policyQualityScore: number;
};

export type ProductReadinessResult = {
  score: number;
  grade: "not_ready" | "pilot_candidate" | "product_candidate";
  blockers: string[];
};

export function computeProductReadiness(input: ProductReadinessInput): ProductReadinessResult {
  const score = Number((
    input.decisionAccuracy * 0.3 +
    (1 - input.missedBlockerRate) * 0.3 +
    (1 - input.falsePositiveRate) * 0.15 +
    input.expectedFindingCoverage * 0.15 +
    input.policyQualityScore * 0.1
  ).toFixed(4));
  const blockers = [
    input.missedBlockerRate > 0 ? "missed_blockers_present" : "",
    input.decisionAccuracy < 0.9 ? "decision_accuracy_below_90_percent" : "",
    input.policyQualityScore < 0.75 ? "policy_quality_not_strong" : ""
  ].filter(Boolean);

  return {
    score,
    grade: blockers.length > 0
      ? "not_ready"
      : score >= 0.95
        ? "product_candidate"
        : "pilot_candidate",
    blockers
  };
}

export function formatReadiness(readiness: ProductReadinessResult): string {
  return `${Math.round(readiness.score * 1000) / 10}% (${readiness.grade})`;
}
