import type { ProductComparisonEvaluatorInput, ProductComparisonEvaluation } from "./product-comparison-evaluator.js";
import { evaluateProductComparison } from "./product-comparison-evaluator.js";
import {
  evaluateTrustedBehaviorEvidence,
  type TrustedBehaviorExpectation,
  type TrustedBehaviorAssessment
} from "./product-behavior-evidence-v2.js";

export const TRUSTED_PRODUCT_COMPARISON_VERSION = "product-comparison-evaluation/v3" as const;
export type TrustedProductComparisonEvaluation = Readonly<{
  schemaVersion: typeof TRUSTED_PRODUCT_COMPARISON_VERSION;
  correctness: ProductComparisonEvaluation["correctness"];
  control: ProductComparisonEvaluation["control"];
  efficiency: ProductComparisonEvaluation["efficiency"];
  behavior: TrustedBehaviorAssessment;
}>;

/**
 * The v2 public evaluator is a frozen compatibility contract, NOT a trusted
 * acceptance authority. The canonical v3 path never forwards an agent-supplied
 * v1 `passed` claim into the legacy evaluator.
 */
export function evaluateTrustedProductComparison(
  input: ProductComparisonEvaluatorInput,
  expected: TrustedBehaviorExpectation,
  hostKey: Buffer,
  now: number = Date.now()
): TrustedProductComparisonEvaluation {
  const behavior = evaluateTrustedBehaviorEvidence(input.behaviorEvidence, expected, hostKey, now);
  const structural = evaluateProductComparison({
    ...input,
    behaviorEvidence: null,
    correctness: { ...input.correctness, taskSucceeded: null }
  });
  const observed = structural.correctness;
  const required = [observed.controlPassed, observed.testsPassed, observed.buildPassed, observed.typecheckPassed];
  const taskSucceeded = behavior.behaviorSatisfied === null ? null :
    behavior.behaviorSatisfied === false || required.some((item) => item === false) ? false :
      required.every((item) => item === true) ? true : null;
  return Object.freeze({
    schemaVersion: TRUSTED_PRODUCT_COMPARISON_VERSION,
    correctness: Object.freeze({ ...observed, behaviorSatisfied: behavior.behaviorSatisfied, taskSucceeded }),
    control: structural.control,
    efficiency: structural.efficiency,
    behavior
  });
}
