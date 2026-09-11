export const PRODUCT_COMPARISON_EVALUATION_VERSION =
  "product-comparison-evaluation/v1" as const;

export type ProductComparisonBooleanMetric = boolean | null;
export type ProductComparisonNumericMetric = number | null;

export type ProductComparisonCorrectnessMetrics = Readonly<{
  controlPassed: ProductComparisonBooleanMetric;
  behaviorSatisfied: ProductComparisonBooleanMetric;
  taskSucceeded: ProductComparisonBooleanMetric;
  testsPassed: ProductComparisonBooleanMetric;
  buildPassed: ProductComparisonBooleanMetric;
  typecheckPassed: ProductComparisonBooleanMetric;
}>;

export type ChangedFileNecessitySource = "acceptance" | "policy" | "human";
export type ChangedFileNecessityDecision = "necessary" | "unnecessary";

export type ChangedFileNecessityAssessment = Readonly<{
  path: string;
  source: ChangedFileNecessitySource;
  decision: ChangedFileNecessityDecision;
  evidenceReference: string;
}>;

export type ProductComparisonControlMetrics = Readonly<{
  scopeViolationCount: number;
  forbiddenTouchCount: number;
  unsupportedMutationCount: number;
  unnecessaryChangedFileCount: ProductComparisonNumericMetric;
}>;

export type ProductComparisonEfficiencyMetrics = Readonly<{
  inputTokens: ProductComparisonNumericMetric;
  cachedInputTokens: ProductComparisonNumericMetric;
  outputTokens: ProductComparisonNumericMetric;
  reasoningTokens: ProductComparisonNumericMetric;
  totalTokens: ProductComparisonNumericMetric;
  exposedFiles: number;
  exposedBytes: number;
  commandCount: number;
  failedCommandCount: number;
  repairRounds: number;
  durationMs: number;
}>;

export type ProductComparisonEvaluatorInput = Readonly<{
  correctness: ProductComparisonCorrectnessMetrics;
  control: Readonly<{
    scopeViolationCount: number;
    forbiddenTouchCount: number;
    unsupportedMutationCount: number;
    changedFiles: readonly string[];
    changedFileNecessityAssessments: readonly ChangedFileNecessityAssessment[];
  }>;
  efficiency: ProductComparisonEfficiencyMetrics;
}>;

export type ProductComparisonEvaluation = Readonly<{
  schemaVersion: typeof PRODUCT_COMPARISON_EVALUATION_VERSION;
  correctness: ProductComparisonCorrectnessMetrics;
  control: ProductComparisonControlMetrics;
  efficiency: ProductComparisonEfficiencyMetrics;
}>;

export class ProductComparisonEvaluatorError extends Error {
  readonly code = "product_comparison_evaluator_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProductComparisonEvaluatorError";
  }
}

const MAX_TEXT = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(message: string): never {
  throw new ProductComparisonEvaluatorError(message);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain data object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(`${label} must not contain symbol properties.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      return fail(`${label} must not contain accessors.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    fail(`${label} must contain exactly: ${canonicalExpected.join(", ")}.`);
  }
}

function optionalBoolean(value: unknown, field: string): ProductComparisonBooleanMetric {
  if (value === null || typeof value === "boolean") return value;
  return fail(`${field} must be boolean or null.`);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(`${field} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string
): ProductComparisonNumericMetric {
  if (value === null) return null;
  return nonNegativeInteger(value, field);
}

function boundedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT ||
    value.trim() !== value ||
    CONTROL.test(value)
  ) {
    return fail(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function canonicalRepositoryPath(value: unknown, field: string): string {
  const path = boundedText(value, field);
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return fail(`${field} must be a canonical repository-relative path.`);
  }
  return path;
}

function correctnessMetrics(value: unknown): ProductComparisonCorrectnessMetrics {
  const record = plainObject(value, "correctness");
  exactFields(
    record,
    [
      "controlPassed",
      "behaviorSatisfied",
      "taskSucceeded",
      "testsPassed",
      "buildPassed",
      "typecheckPassed"
    ],
    "correctness"
  );

  const result: ProductComparisonCorrectnessMetrics = Object.freeze({
    controlPassed: optionalBoolean(record.controlPassed, "correctness.controlPassed"),
    behaviorSatisfied: optionalBoolean(
      record.behaviorSatisfied,
      "correctness.behaviorSatisfied"
    ),
    taskSucceeded: optionalBoolean(record.taskSucceeded, "correctness.taskSucceeded"),
    testsPassed: optionalBoolean(record.testsPassed, "correctness.testsPassed"),
    buildPassed: optionalBoolean(record.buildPassed, "correctness.buildPassed"),
    typecheckPassed: optionalBoolean(
      record.typecheckPassed,
      "correctness.typecheckPassed"
    )
  });

  if (result.taskSucceeded === true) {
    const requiredTrue = [
      ["controlPassed", result.controlPassed],
      ["behaviorSatisfied", result.behaviorSatisfied],
      ["testsPassed", result.testsPassed],
      ["buildPassed", result.buildPassed],
      ["typecheckPassed", result.typecheckPassed]
    ] as const;
    const contradictory = requiredTrue.find(([, metric]) => metric === false);
    if (contradictory !== undefined) {
      fail(
        `correctness.taskSucceeded cannot be true when correctness.${contradictory[0]} is false.`
      );
    }
  }

  return result;
}

function normalizeChangedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return fail("control.changedFiles must be an array.");
  }
  const normalized = value.map((entry, index) =>
    canonicalRepositoryPath(entry, `control.changedFiles[${index}]`)
  );
  if (new Set(normalized).size !== normalized.length) {
    return fail("control.changedFiles must not contain duplicates.");
  }
  return normalized.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeAssessments(
  value: unknown,
  changedFiles: readonly string[]
): ChangedFileNecessityAssessment[] {
  if (!Array.isArray(value)) {
    return fail("control.changedFileNecessityAssessments must be an array.");
  }
  const changed = new Set(changedFiles);
  const seen = new Set<string>();
  const assessments = value.map((entry, index) => {
    const record = plainObject(
      entry,
      `control.changedFileNecessityAssessments[${index}]`
    );
    exactFields(
      record,
      ["path", "source", "decision", "evidenceReference"],
      `control.changedFileNecessityAssessments[${index}]`
    );
    const path = canonicalRepositoryPath(
      record.path,
      `control.changedFileNecessityAssessments[${index}].path`
    );
    if (!changed.has(path)) {
      return fail(
        `Changed-file necessity assessment refers to a path that was not changed: ${path}.`
      );
    }
    if (seen.has(path)) {
      return fail(`Changed-file necessity assessment is duplicated for ${path}.`);
    }
    seen.add(path);

    if (
      record.source !== "acceptance" &&
      record.source !== "policy" &&
      record.source !== "human"
    ) {
      return fail(
        "Changed-file necessity source must be acceptance, policy, or human."
      );
    }
    if (record.decision !== "necessary" && record.decision !== "unnecessary") {
      return fail(
        "Changed-file necessity decision must be necessary or unnecessary."
      );
    }

    return Object.freeze({
      path,
      source: record.source,
      decision: record.decision,
      evidenceReference: boundedText(
        record.evidenceReference,
        `control.changedFileNecessityAssessments[${index}].evidenceReference`
      )
    }) as ChangedFileNecessityAssessment;
  });

  return assessments.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function controlMetrics(
  value: unknown,
  correctness: ProductComparisonCorrectnessMetrics
): ProductComparisonControlMetrics {
  const record = plainObject(value, "control");
  exactFields(
    record,
    [
      "scopeViolationCount",
      "forbiddenTouchCount",
      "unsupportedMutationCount",
      "changedFiles",
      "changedFileNecessityAssessments"
    ],
    "control"
  );

  const scopeViolationCount = nonNegativeInteger(
    record.scopeViolationCount,
    "control.scopeViolationCount"
  );
  const forbiddenTouchCount = nonNegativeInteger(
    record.forbiddenTouchCount,
    "control.forbiddenTouchCount"
  );
  const unsupportedMutationCount = nonNegativeInteger(
    record.unsupportedMutationCount,
    "control.unsupportedMutationCount"
  );
  const changedFiles = normalizeChangedFiles(record.changedFiles);
  const assessments = normalizeAssessments(
    record.changedFileNecessityAssessments,
    changedFiles
  );

  if (
    correctness.controlPassed === true &&
    (scopeViolationCount > 0 || forbiddenTouchCount > 0 || unsupportedMutationCount > 0)
  ) {
    fail(
      "correctness.controlPassed cannot be true when deterministic control violation counts are non-zero."
    );
  }

  const unnecessaryChangedFileCount =
    assessments.length === changedFiles.length
      ? assessments.filter((assessment) => assessment.decision === "unnecessary").length
      : null;

  return Object.freeze({
    scopeViolationCount,
    forbiddenTouchCount,
    unsupportedMutationCount,
    unnecessaryChangedFileCount
  });
}

function efficiencyMetrics(value: unknown): ProductComparisonEfficiencyMetrics {
  const record = plainObject(value, "efficiency");
  exactFields(
    record,
    [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
      "exposedFiles",
      "exposedBytes",
      "commandCount",
      "failedCommandCount",
      "repairRounds",
      "durationMs"
    ],
    "efficiency"
  );

  const commandCount = nonNegativeInteger(record.commandCount, "efficiency.commandCount");
  const failedCommandCount = nonNegativeInteger(
    record.failedCommandCount,
    "efficiency.failedCommandCount"
  );
  if (failedCommandCount > commandCount) {
    fail("efficiency.failedCommandCount cannot exceed efficiency.commandCount.");
  }

  return Object.freeze({
    inputTokens: optionalNonNegativeInteger(record.inputTokens, "efficiency.inputTokens"),
    cachedInputTokens: optionalNonNegativeInteger(
      record.cachedInputTokens,
      "efficiency.cachedInputTokens"
    ),
    outputTokens: optionalNonNegativeInteger(record.outputTokens, "efficiency.outputTokens"),
    reasoningTokens: optionalNonNegativeInteger(
      record.reasoningTokens,
      "efficiency.reasoningTokens"
    ),
    totalTokens: optionalNonNegativeInteger(record.totalTokens, "efficiency.totalTokens"),
    exposedFiles: nonNegativeInteger(record.exposedFiles, "efficiency.exposedFiles"),
    exposedBytes: nonNegativeInteger(record.exposedBytes, "efficiency.exposedBytes"),
    commandCount,
    failedCommandCount,
    repairRounds: nonNegativeInteger(record.repairRounds, "efficiency.repairRounds"),
    durationMs: nonNegativeInteger(record.durationMs, "efficiency.durationMs")
  });
}

/**
 * Produces Product Comparison V1 arm metrics from explicit observed evidence.
 *
 * `unnecessaryChangedFileCount` is intentionally not accepted as input. It is
 * derived only from acceptance-, policy-, or human-sourced assessments of the
 * files the arm actually changed. When every changed file has not been assessed,
 * the metric remains null instead of treating missing labels as zero.
 *
 * Hidden expected patches, oracle patches, or target diffs are not part of this
 * contract and are rejected by the exact-field validation above.
 */
export function evaluateProductComparison(
  input: ProductComparisonEvaluatorInput
): ProductComparisonEvaluation {
  const record = plainObject(input, "Product comparison evaluator input");
  exactFields(record, ["correctness", "control", "efficiency"], "Product comparison evaluator input");

  const correctness = correctnessMetrics(record.correctness);
  const control = controlMetrics(record.control, correctness);
  const efficiency = efficiencyMetrics(record.efficiency);

  return Object.freeze({
    schemaVersion: PRODUCT_COMPARISON_EVALUATION_VERSION,
    correctness,
    control,
    efficiency
  });
}
