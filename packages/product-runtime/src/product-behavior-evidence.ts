export const PRODUCT_BEHAVIOR_EVIDENCE_VERSION =
  "product-behavior-evidence/v1" as const;

export type ProductBehaviorCriterionEvidence = Readonly<{
  criterionId: string;
  evidenceId: string;
  checkHash: string;
  passed: boolean;
}>;

export type ProductBehaviorEvidence = Readonly<{
  schemaVersion: typeof PRODUCT_BEHAVIOR_EVIDENCE_VERSION;
  taskId: string;
  sourceCommitSha: string;
  candidateTreeHash: string;
  catalogHash: string;
  criteria: readonly ProductBehaviorCriterionEvidence[];
}>;

export type ProductBehaviorEvaluation = Readonly<{
  behaviorSatisfied: boolean | null;
  criterionCount: number;
  passedCriterionCount: number;
}>;

export class ProductBehaviorEvidenceError extends Error {
  readonly code = "product_behavior_evidence_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "ProductBehaviorEvidenceError";
  }
}

const ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new ProductBehaviorEvidenceError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain data object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some((item) => !("value" in item))) {
    return fail(`${label} must contain data properties only.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

/**
 * Evaluates only trusted hidden-acceptance evidence. General test status is
 * intentionally absent from this contract. Missing evidence stays unknown.
 */
export function evaluateProductBehaviorEvidence(
  value: unknown | null
): ProductBehaviorEvaluation {
  if (value === null) {
    return Object.freeze({ behaviorSatisfied: null, criterionCount: 0, passedCriterionCount: 0 });
  }
  const input = record(value, "Behavior evidence");
  exact(input, ["schemaVersion", "taskId", "sourceCommitSha", "candidateTreeHash", "catalogHash", "criteria"], "Behavior evidence");
  if (input.schemaVersion !== PRODUCT_BEHAVIOR_EVIDENCE_VERSION) fail("Behavior evidence version is unsupported.");
  if (typeof input.taskId !== "string" || !ID.test(input.taskId)) fail("Behavior evidence taskId is invalid.");
  if (typeof input.sourceCommitSha !== "string" || !SHA40.test(input.sourceCommitSha)) fail("Behavior evidence sourceCommitSha is invalid.");
  if (typeof input.candidateTreeHash !== "string" || !HASH.test(input.candidateTreeHash) ||
      typeof input.catalogHash !== "string" || !HASH.test(input.catalogHash)) fail("Behavior evidence hashes are invalid.");
  if (!Array.isArray(input.criteria) || input.criteria.length === 0 || input.criteria.length > 32) {
    fail("Behavior evidence criteria must be a non-empty bounded array.");
  }
  const seenCriteria = new Set<string>();
  const seenEvidence = new Set<string>();
  const criteria = input.criteria.map((item, index) => {
    const criterion = record(item, `Behavior evidence criterion ${index}`);
    exact(criterion, ["criterionId", "evidenceId", "checkHash", "passed"], `Behavior evidence criterion ${index}`);
    if (typeof criterion.criterionId !== "string" || !ID.test(criterion.criterionId) || seenCriteria.has(criterion.criterionId)) fail("Behavior criterion id is invalid or duplicated.");
    if (typeof criterion.evidenceId !== "string" || !ID.test(criterion.evidenceId) || seenEvidence.has(criterion.evidenceId)) fail("Behavior evidence id is invalid or duplicated.");
    if (typeof criterion.checkHash !== "string" || !HASH.test(criterion.checkHash)) fail("Behavior criterion checkHash is invalid.");
    if (typeof criterion.passed !== "boolean") fail("Behavior criterion passed must be boolean.");
    seenCriteria.add(criterion.criterionId);
    seenEvidence.add(criterion.evidenceId);
    return Object.freeze({
      criterionId: criterion.criterionId,
      evidenceId: criterion.evidenceId,
      checkHash: criterion.checkHash,
      passed: criterion.passed
    }) as ProductBehaviorCriterionEvidence;
  });
  const passedCriterionCount = criteria.filter((criterion) => criterion.passed).length;
  return Object.freeze({
    behaviorSatisfied: passedCriterionCount === criteria.length,
    criterionCount: criteria.length,
    passedCriterionCount
  });
}
