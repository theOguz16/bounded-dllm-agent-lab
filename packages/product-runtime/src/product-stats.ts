export const PRODUCT_STATS_VERSION = "product-stats/v1" as const;

export type ProductStatsArmObservation = Readonly<{
  taskSucceeded: boolean | null;
  controlPassed: boolean | null;
  behaviorSatisfied: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  exposedBytes: number | null;
  durationMs: number | null;
  scopeViolationCount: number | null;
  humanAccepted: boolean | null;
}>;

export type ProductStatsComparisonObservation = Readonly<{
  comparable: boolean;
  normal: ProductStatsArmObservation;
  bounded: ProductStatsArmObservation;
}>;

export type ProductStatsArmAggregate = Readonly<{
  taskSuccessRate: number | null;
  controlPassRate: number | null;
  behaviorSuccessRate: number | null;
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  medianExposedBytes: number | null;
  medianDuration: number | null;
  scopeViolationRate: number | null;
  humanAcceptanceRate: number | null;
}>;

export type ProductStatsDelta = ProductStatsArmAggregate;

export type ProductStats = Readonly<{
  schemaVersion: typeof PRODUCT_STATS_VERSION;
  sampleCount: number;
  comparableRuns: number;
  normal: ProductStatsArmAggregate;
  bounded: ProductStatsArmAggregate;
  delta: ProductStatsDelta;
}>;

function assertNullableBoolean(value: unknown, field: string): asserts value is boolean | null {
  if (value !== null && typeof value !== "boolean") {
    throw new TypeError(`Product stats ${field} must be boolean or null.`);
  }
}

function assertNullableNonNegativeNumber(
  value: unknown,
  field: string
): asserts value is number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    throw new TypeError(`Product stats ${field} must be a finite non-negative number or null.`);
  }
}

function validateArm(value: ProductStatsArmObservation, field: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Product stats ${field} must be an object.`);
  }
  assertNullableBoolean(value.taskSucceeded, `${field}.taskSucceeded`);
  assertNullableBoolean(value.controlPassed, `${field}.controlPassed`);
  assertNullableBoolean(value.behaviorSatisfied, `${field}.behaviorSatisfied`);
  assertNullableNonNegativeNumber(value.inputTokens, `${field}.inputTokens`);
  assertNullableNonNegativeNumber(value.outputTokens, `${field}.outputTokens`);
  assertNullableNonNegativeNumber(value.exposedBytes, `${field}.exposedBytes`);
  assertNullableNonNegativeNumber(value.durationMs, `${field}.durationMs`);
  assertNullableNonNegativeNumber(value.scopeViolationCount, `${field}.scopeViolationCount`);
  assertNullableBoolean(value.humanAccepted, `${field}.humanAccepted`);
}

function rate(values: readonly (boolean | null)[]): number | null {
  const observed = values.filter((value): value is boolean => value !== null);
  if (observed.length === 0) return null;
  return observed.filter(Boolean).length / observed.length;
}

function median(values: readonly (number | null)[]): number | null {
  const observed = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (observed.length === 0) return null;
  const middle = Math.floor(observed.length / 2);
  return observed.length % 2 === 1
    ? observed[middle]!
    : (observed[middle - 1]! + observed[middle]!) / 2;
}

function aggregate(
  values: readonly ProductStatsArmObservation[]
): ProductStatsArmAggregate {
  return Object.freeze({
    taskSuccessRate: rate(values.map((value) => value.taskSucceeded)),
    controlPassRate: rate(values.map((value) => value.controlPassed)),
    behaviorSuccessRate: rate(values.map((value) => value.behaviorSatisfied)),
    medianInputTokens: median(values.map((value) => value.inputTokens)),
    medianOutputTokens: median(values.map((value) => value.outputTokens)),
    medianExposedBytes: median(values.map((value) => value.exposedBytes)),
    medianDuration: median(values.map((value) => value.durationMs)),
    scopeViolationRate: rate(
      values.map((value) =>
        value.scopeViolationCount === null ? null : value.scopeViolationCount > 0
      )
    ),
    humanAcceptanceRate: rate(values.map((value) => value.humanAccepted))
  });
}

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : right - left;
}

function delta(
  normal: ProductStatsArmAggregate,
  bounded: ProductStatsArmAggregate
): ProductStatsDelta {
  return Object.freeze({
    taskSuccessRate: difference(normal.taskSuccessRate, bounded.taskSuccessRate),
    controlPassRate: difference(normal.controlPassRate, bounded.controlPassRate),
    behaviorSuccessRate: difference(normal.behaviorSuccessRate, bounded.behaviorSuccessRate),
    medianInputTokens: difference(normal.medianInputTokens, bounded.medianInputTokens),
    medianOutputTokens: difference(normal.medianOutputTokens, bounded.medianOutputTokens),
    medianExposedBytes: difference(normal.medianExposedBytes, bounded.medianExposedBytes),
    medianDuration: difference(normal.medianDuration, bounded.medianDuration),
    scopeViolationRate: difference(normal.scopeViolationRate, bounded.scopeViolationRate),
    humanAcceptanceRate: difference(normal.humanAcceptanceRate, bounded.humanAcceptanceRate)
  });
}

/**
 * Aggregate Product Comparison observations without imputing missing evidence.
 *
 * Only comparable runs contribute to normal/bounded statistics. Nullable fields
 * are omitted from that metric's denominator rather than being interpreted as
 * failures or zeroes. Deltas are always bounded - normal in the metric's native
 * unit (rates therefore produce fractional percentage-point differences).
 */
export function aggregateProductStats(
  observations: readonly ProductStatsComparisonObservation[]
): ProductStats {
  if (!Array.isArray(observations)) {
    throw new TypeError("Product stats observations must be an array.");
  }

  for (const [index, observation] of observations.entries()) {
    if (
      observation === null ||
      typeof observation !== "object" ||
      Array.isArray(observation) ||
      typeof observation.comparable !== "boolean"
    ) {
      throw new TypeError(`Product stats observation ${index} is invalid.`);
    }
    validateArm(observation.normal, `observations[${index}].normal`);
    validateArm(observation.bounded, `observations[${index}].bounded`);
  }

  const comparable = observations.filter((observation) => observation.comparable);
  const normal = aggregate(comparable.map((observation) => observation.normal));
  const bounded = aggregate(comparable.map((observation) => observation.bounded));

  return Object.freeze({
    schemaVersion: PRODUCT_STATS_VERSION,
    sampleCount: observations.length,
    comparableRuns: comparable.length,
    normal,
    bounded,
    delta: delta(normal, bounded)
  });
}
