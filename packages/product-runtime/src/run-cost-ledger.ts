import { hashCanonicalJson } from "./agent-event-ledger.js";

export const RUN_COST_LEDGER_VERSION = "1" as const;
export const RUN_COST_BENCHMARK_VERSION = "1" as const;

export type CostStrategy =
  | "direct_large_context"
  | "fixed_bounded_context"
  | "adaptive_bounded_context";

export type CostOperation =
  | "planner"
  | "coder"
  | "verifier"
  | "remask"
  | "repair"
  | "shadow"
  | "admin"
  | "expansion";

export type CostRunOutcome =
  | "accepted_patch"
  | "human_review"
  | "rejected"
  | "failed";

export type UsageUnavailableReason =
  | "provider_usage_missing"
  | "provider_usage_unsupported"
  | "provider_call_failed"
  | "not_a_model_call";

export type ObservedTokenUsage = {
  status: "observed";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerResponseHash: string;
  providerRequestId: string | null;
};

export type EstimatedTokenUsage = {
  status: "estimated";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatorId: string;
  sourceArtifactHash: string;
};

export type UnavailableTokenUsage = {
  status: "unavailable";
  reason: UsageUnavailableReason;
  providerResponseHash: string | null;
};

export type TokenUsageEvidence =
  | ObservedTokenUsage
  | EstimatedTokenUsage
  | UnavailableTokenUsage;

export type ProviderPriceSnapshot = {
  snapshotVersion: "1";
  snapshotId: string;
  providerId: string;
  modelId: string;
  currency: "USD";
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
  capturedAt: string;
  sourceKind:
    | "provider_published"
    | "operator_configured";
  sourceHash: string;
};

export type RunCostInvocationInput = {
  invocationId: string;
  eventId: string;
  eventHash: string;
  operation: CostOperation;
  strategy: CostStrategy;
  providerId: string;
  modelId: string;
  attempt: number;
  usage: TokenUsageEvidence;
  priceSnapshotId: string | null;
};

export type RunCostLedgerInput = {
  ledgerVersion: "1";
  evidenceClass:
    | "deterministic_fixture"
    | "observed_run";
  observationSource:
    | "fixture"
    | "live_provider_call";
  observationReceiptHash: string;
  runId: string;
  taskSetHash: string;
  sourceLedgerRootHash: string;
  strategy: CostStrategy;
  outcome: CostRunOutcome;
  acceptedPatchCount: number;
  pricingSnapshots:
    readonly ProviderPriceSnapshot[];
  invocations:
    readonly RunCostInvocationInput[];
};

export type InvocationCostStatus =
  | "observed"
  | "estimated"
  | "unavailable";

export type RunCostInvocation = {
  invocationId: string;
  eventId: string;
  eventHash: string;
  operation: CostOperation;
  strategy: CostStrategy;
  providerId: string;
  modelId: string;
  attempt: number;
  isRetry: boolean;
  usage: TokenUsageEvidence;
  priceSnapshotId: string | null;
  costStatus: InvocationCostStatus;
  costNanoUsd: number | null;
  invocationHash: string;
};

export type TokenCostTotals = {
  invocationCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costNanoUsd: number;
};

export type CostOperationAggregate = {
  operation: CostOperation;
  observed: TokenCostTotals;
  estimated: TokenCostTotals;
  unavailableInvocationCount: number;
  retryInvocationCount: number;
};

export type RunCostLedger = {
  ledgerVersion: "1";
  evidenceClass:
    | "deterministic_fixture"
    | "observed_run";
  observationSource:
    | "fixture"
    | "live_provider_call";
  observationReceiptHash: string;
  releaseClaimEligible: boolean;
  runId: string;
  taskSetHash: string;
  sourceLedgerRootHash: string;
  strategy: CostStrategy;
  outcome: CostRunOutcome;
  acceptedPatchCount: number;
  providerModelSetHash: string;
  pricingSnapshotSetHash: string;
  pricingSnapshots:
    readonly ProviderPriceSnapshot[];
  invocations:
    readonly RunCostInvocation[];
  operationAggregates:
    readonly CostOperationAggregate[];
  totals: {
    observed: TokenCostTotals;
    estimated: TokenCostTotals;
    unavailableInvocationCount: number;
    unpricedObservedInvocationCount: number;
    unpricedEstimatedInvocationCount: number;
    retryInvocationCount: number;
    retryObservedTokens: number;
    remaskObservedTokens: number;
    expansionObservedTokens: number;
    shadowAdminObservedTokens: number;
    fullObservedCoverage: boolean;
    costPerAcceptedPatchNanoUsd:
      number | null;
  };
  ledgerHash: string;
};

export type BuildRunCostLedgerResult = {
  decision:
    | "run_cost_ledger_ready"
    | "run_cost_ledger_invalid";
  ledger: RunCostLedger | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    invocationCount: number;
    observedInvocationCount: number;
    estimatedInvocationCount: number;
    unavailableInvocationCount: number;
    fullObservedCoverage: boolean;
    releaseClaimEligible: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type OpenAiCompatibleUsageResult = {
  decision:
    | "provider_usage_observed"
    | "provider_usage_unavailable"
    | "provider_usage_invalid";
  usage: TokenUsageEvidence | null;
  errors: readonly string[];
};

export type RunCostBenchmarkInput = {
  benchmarkVersion: "1";
  benchmarkId: string;
  evidenceClass:
    | "deterministic_fixture"
    | "observed_run";
  taskSetHash: string;
  runs: readonly RunCostLedgerInput[];
};

export type StrategyCostAggregate = {
  strategy: CostStrategy;
  runCount: number;
  acceptedPatchCount: number;
  observed: TokenCostTotals;
  estimated: TokenCostTotals;
  unavailableInvocationCount: number;
  fullObservedRunCount: number;
  releaseEligibleRunCount: number;
  costPerAcceptedPatchNanoUsd:
    number | null;
};

export type RunCostBenchmarkReport = {
  reportVersion: "1";
  benchmarkId: string;
  evidenceClass:
    | "deterministic_fixture"
    | "observed_run";
  taskSetHash: string;
  sameProviderModelSet: boolean;
  samePricingSnapshotSet: boolean;
  allStrategiesPresent: boolean;
  releaseClaimEligible: boolean;
  sourceInputHash: string;
  ledgers: readonly RunCostLedger[];
  strategyAggregates:
    readonly StrategyCostAggregate[];
  comparisons: {
    fixedVsDirectObservedTokenSavingsRate:
      number | null;
    adaptiveVsDirectObservedTokenSavingsRate:
      number | null;
    fixedVsDirectObservedCostSavingsRate:
      number | null;
    adaptiveVsDirectObservedCostSavingsRate:
      number | null;
  };
  reportHash: string;
};

export type BuildRunCostBenchmarkResult = {
  decision:
    | "run_cost_benchmark_ready"
    | "run_cost_benchmark_invalid";
  report: RunCostBenchmarkReport | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    runCount: number;
    strategyCount: number;
    sameProviderModelSet: boolean;
    samePricingSnapshotSet: boolean;
    allStrategiesPresent: boolean;
    releaseClaimEligible: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type VerifyRunCostLedgerResult = {
  decision:
    | "run_cost_ledger_current"
    | "run_cost_ledger_invalid";
  integrityVerified: boolean;
  sourceInputMatched: boolean;
  releaseClaimEligible: boolean;
  errors: readonly string[];
};

export type VerifyRunCostBenchmarkResult = {
  decision:
    | "run_cost_benchmark_current"
    | "run_cost_benchmark_invalid";
  integrityVerified: boolean;
  sourceInputMatched: boolean;
  releaseClaimEligible: boolean;
  errors: readonly string[];
};

type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ASCII_CONTROL =
  /[\u0000-\u001f\u007f]/;
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const STRATEGIES:
  readonly CostStrategy[] = [
    "direct_large_context",
    "fixed_bounded_context",
    "adaptive_bounded_context"
  ];
const OPERATIONS:
  readonly CostOperation[] = [
    "planner",
    "coder",
    "verifier",
    "remask",
    "repair",
    "shadow",
    "admin",
    "expansion"
  ];
const OUTCOMES:
  readonly CostRunOutcome[] = [
    "accepted_patch",
    "human_review",
    "rejected",
    "failed"
  ];
const UNAVAILABLE_REASONS:
  readonly UsageUnavailableReason[] = [
    "provider_usage_missing",
    "provider_usage_unsupported",
    "provider_call_failed",
    "not_a_model_call"
  ];
const MAX_INVOCATIONS = 10_000;
const MAX_SNAPSHOTS = 1_000;
const MAX_TOKENS = 1_000_000_000;
const MAX_PRICE_NANO_USD = 1_000_000_000;
const MAX_TOTAL_NANO_USD =
  Number.MAX_SAFE_INTEGER;

const INPUT_FIELDS = new Set([
  "ledgerVersion",
  "evidenceClass",
  "observationSource",
  "observationReceiptHash",
  "runId",
  "taskSetHash",
  "sourceLedgerRootHash",
  "strategy",
  "outcome",
  "acceptedPatchCount",
  "pricingSnapshots",
  "invocations"
]);
const SNAPSHOT_FIELDS = new Set([
  "snapshotVersion",
  "snapshotId",
  "providerId",
  "modelId",
  "currency",
  "inputNanoUsdPerToken",
  "outputNanoUsdPerToken",
  "capturedAt",
  "sourceKind",
  "sourceHash"
]);
const INVOCATION_FIELDS = new Set([
  "invocationId",
  "eventId",
  "eventHash",
  "operation",
  "strategy",
  "providerId",
  "modelId",
  "attempt",
  "usage",
  "priceSnapshotId"
]);
const OBSERVED_USAGE_FIELDS = new Set([
  "status",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "providerResponseHash",
  "providerRequestId"
]);
const ESTIMATED_USAGE_FIELDS = new Set([
  "status",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "estimatorId",
  "sourceArtifactHash"
]);
const UNAVAILABLE_USAGE_FIELDS = new Set([
  "status",
  "reason",
  "providerResponseHash"
]);
const BENCHMARK_FIELDS = new Set([
  "benchmarkVersion",
  "benchmarkId",
  "evidenceClass",
  "taskSetHash",
  "runs"
]);

class CostLedgerFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function exactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string
): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !==
        Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new CostLedgerFailure(
      "run_cost_structure_invalid",
      `${label} must be a plain object.`
    );
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  for (
    const [key, descriptor]
    of Object.entries(descriptors)
  ) {
    if (
      !fields.has(key) ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new CostLedgerFailure(
        "run_cost_structure_invalid",
        `${label} contains an unknown or accessor field.`
      );
    }
  }
  return value as PlainRecord;
}

function assertAcyclic(
  value: unknown,
  active = new WeakSet<object>(),
  visited = new WeakSet<object>()
): void {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return;
  }
  if (active.has(value)) {
    throw new CostLedgerFailure(
      "run_cost_cycle_detected",
      "Run-cost input must be acyclic."
    );
  }
  if (visited.has(value)) {
    return;
  }
  active.add(value);
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new CostLedgerFailure(
        "run_cost_structure_invalid",
        "Accessor properties are not supported."
      );
    }
    assertAcyclic(
      descriptor.value,
      active,
      visited
    );
  }
  active.delete(value);
  visited.add(value);
}

function requireId(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value) ||
    ASCII_CONTROL.test(value)
  ) {
    throw new CostLedgerFailure(
      "run_cost_identifier_invalid",
      `${field} is invalid.`
    );
  }
  return value;
}

function requireHash(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    !HASH.test(value)
  ) {
    throw new CostLedgerFailure(
      "run_cost_hash_invalid",
      `${field} must be a SHA-256 hash.`
    );
  }
  return value;
}

function requireNullableId(
  value: unknown,
  field: string
): string | null {
  if (value === null) {
    return null;
  }
  return requireId(value, field);
}

function requireInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new CostLedgerFailure(
      "run_cost_numeric_invalid",
      `${field} is invalid.`
    );
  }
  return value as number;
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  const normalized =
    requireInteger(value, field, maximum);
  if (normalized === 0) {
    throw new CostLedgerFailure(
      "run_cost_numeric_invalid",
      `${field} must be positive.`
    );
  }
  return normalized;
}

function normalizeTimestamp(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    !ISO_8601.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new CostLedgerFailure(
      "run_cost_timestamp_invalid",
      `${field} must be an ISO-8601 timestamp.`
    );
  }
  return new Date(
    Date.parse(value)
  ).toISOString();
}

function normalizeTokenTriplet(
  record: PlainRecord,
  label: string
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = requireInteger(
    record.inputTokens,
    `${label}.inputTokens`,
    MAX_TOKENS
  );
  const outputTokens = requireInteger(
    record.outputTokens,
    `${label}.outputTokens`,
    MAX_TOKENS
  );
  const totalTokens = requireInteger(
    record.totalTokens,
    `${label}.totalTokens`,
    MAX_TOKENS
  );
  if (
    totalTokens !==
      inputTokens + outputTokens
  ) {
    throw new CostLedgerFailure(
      "run_cost_token_total_mismatch",
      `${label}.totalTokens must equal input + output.`
    );
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function normalizeUsage(
  value: unknown,
  label: string
): TokenUsageEvidence {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new CostLedgerFailure(
      "run_cost_usage_invalid",
      `${label} must be an object.`
    );
  }
  const status =
    (value as PlainRecord).status;

  if (status === "observed") {
    const record = exactRecord(
      value,
      OBSERVED_USAGE_FIELDS,
      label
    );
    return {
      status: "observed",
      ...normalizeTokenTriplet(
        record,
        label
      ),
      providerResponseHash: requireHash(
        record.providerResponseHash,
        `${label}.providerResponseHash`
      ),
      providerRequestId:
        record.providerRequestId === null
          ? null
          : requireId(
              record.providerRequestId,
              `${label}.providerRequestId`
            )
    };
  }

  if (status === "estimated") {
    const record = exactRecord(
      value,
      ESTIMATED_USAGE_FIELDS,
      label
    );
    return {
      status: "estimated",
      ...normalizeTokenTriplet(
        record,
        label
      ),
      estimatorId: requireId(
        record.estimatorId,
        `${label}.estimatorId`
      ),
      sourceArtifactHash: requireHash(
        record.sourceArtifactHash,
        `${label}.sourceArtifactHash`
      )
    };
  }

  if (status === "unavailable") {
    const record = exactRecord(
      value,
      UNAVAILABLE_USAGE_FIELDS,
      label
    );
    if (
      !UNAVAILABLE_REASONS.includes(
        record.reason as
          UsageUnavailableReason
      )
    ) {
      throw new CostLedgerFailure(
        "run_cost_usage_invalid",
        `${label}.reason is invalid.`
      );
    }
    return {
      status: "unavailable",
      reason:
        record.reason as
          UsageUnavailableReason,
      providerResponseHash:
        record.providerResponseHash === null
          ? null
          : requireHash(
              record.providerResponseHash,
              `${label}.providerResponseHash`
            )
    };
  }

  throw new CostLedgerFailure(
    "run_cost_usage_invalid",
    `${label}.status is invalid.`
  );
}

function normalizeSnapshot(
  value: unknown,
  index: number
): ProviderPriceSnapshot {
  const record = exactRecord(
    value,
    SNAPSHOT_FIELDS,
    `pricingSnapshots[${index}]`
  );
  if (
    record.snapshotVersion !== "1" ||
    record.currency !== "USD" ||
    (
      record.sourceKind !==
        "provider_published" &&
      record.sourceKind !==
        "operator_configured"
    )
  ) {
    throw new CostLedgerFailure(
      "run_cost_price_snapshot_invalid",
      "A price snapshot is invalid."
    );
  }
  return {
    snapshotVersion: "1",
    snapshotId: requireId(
      record.snapshotId,
      `pricingSnapshots[${index}].snapshotId`
    ),
    providerId: requireId(
      record.providerId,
      `pricingSnapshots[${index}].providerId`
    ),
    modelId: requireId(
      record.modelId,
      `pricingSnapshots[${index}].modelId`
    ),
    currency: "USD",
    inputNanoUsdPerToken:
      requireInteger(
        record.inputNanoUsdPerToken,
        `pricingSnapshots[${index}].inputNanoUsdPerToken`,
        MAX_PRICE_NANO_USD
      ),
    outputNanoUsdPerToken:
      requireInteger(
        record.outputNanoUsdPerToken,
        `pricingSnapshots[${index}].outputNanoUsdPerToken`,
        MAX_PRICE_NANO_USD
      ),
    capturedAt: normalizeTimestamp(
      record.capturedAt,
      `pricingSnapshots[${index}].capturedAt`
    ),
    sourceKind:
      record.sourceKind as
        ProviderPriceSnapshot["sourceKind"],
    sourceHash: requireHash(
      record.sourceHash,
      `pricingSnapshots[${index}].sourceHash`
    )
  };
}

function normalizeInvocation(
  value: unknown,
  index: number
): RunCostInvocationInput {
  const record = exactRecord(
    value,
    INVOCATION_FIELDS,
    `invocations[${index}]`
  );
  if (
    !OPERATIONS.includes(
      record.operation as CostOperation
    ) ||
    !STRATEGIES.includes(
      record.strategy as CostStrategy
    )
  ) {
    throw new CostLedgerFailure(
      "run_cost_invocation_invalid",
      "A run-cost invocation is invalid."
    );
  }
  return {
    invocationId: requireId(
      record.invocationId,
      `invocations[${index}].invocationId`
    ),
    eventId: requireId(
      record.eventId,
      `invocations[${index}].eventId`
    ),
    eventHash: requireHash(
      record.eventHash,
      `invocations[${index}].eventHash`
    ),
    operation:
      record.operation as CostOperation,
    strategy:
      record.strategy as CostStrategy,
    providerId: requireId(
      record.providerId,
      `invocations[${index}].providerId`
    ),
    modelId: requireId(
      record.modelId,
      `invocations[${index}].modelId`
    ),
    attempt: requirePositiveInteger(
      record.attempt,
      `invocations[${index}].attempt`,
      1_000
    ),
    usage: normalizeUsage(
      record.usage,
      `invocations[${index}].usage`
    ),
    priceSnapshotId:
      requireNullableId(
        record.priceSnapshotId,
        `invocations[${index}].priceSnapshotId`
      )
  };
}

function validateLedgerInput(
  value: unknown
): RunCostLedgerInput {
  assertAcyclic(value);
  const record = exactRecord(
    value,
    INPUT_FIELDS,
    "run-cost ledger input"
  );
  if (
    record.ledgerVersion !== "1" ||
    (
      record.evidenceClass !==
        "deterministic_fixture" &&
      record.evidenceClass !==
        "observed_run"
    ) ||
    (
      record.observationSource !==
        "fixture" &&
      record.observationSource !==
        "live_provider_call"
    ) ||
    !STRATEGIES.includes(
      record.strategy as CostStrategy
    ) ||
    !OUTCOMES.includes(
      record.outcome as CostRunOutcome
    ) ||
    !Array.isArray(
      record.pricingSnapshots
    ) ||
    !Array.isArray(record.invocations) ||
    record.pricingSnapshots.length >
      MAX_SNAPSHOTS ||
    record.invocations.length >
      MAX_INVOCATIONS
  ) {
    throw new CostLedgerFailure(
      "run_cost_input_invalid",
      "Run-cost ledger input is invalid."
    );
  }

  if (
    (
      record.evidenceClass ===
        "deterministic_fixture" &&
      record.observationSource !==
        "fixture"
    ) ||
    (
      record.evidenceClass ===
        "observed_run" &&
      record.observationSource !==
        "live_provider_call"
    )
  ) {
    throw new CostLedgerFailure(
      "run_cost_observation_source_mismatch",
      "Evidence class and observation source must match."
    );
  }

  const pricingSnapshots =
    record.pricingSnapshots.map(
      normalizeSnapshot
    );
  const snapshotIds =
    pricingSnapshots.map(
      (entry) => entry.snapshotId
    );
  if (
    new Set(snapshotIds).size !==
      snapshotIds.length
  ) {
    throw new CostLedgerFailure(
      "run_cost_price_snapshot_duplicate",
      "Price snapshot IDs must be unique."
    );
  }

  const invocations =
    record.invocations.map(
      normalizeInvocation
    );
  const invocationIds =
    invocations.map(
      (entry) => entry.invocationId
    );
  const eventIds =
    invocations.map(
      (entry) => entry.eventId
    );
  if (
    new Set(invocationIds).size !==
      invocationIds.length ||
    new Set(eventIds).size !==
      eventIds.length
  ) {
    throw new CostLedgerFailure(
      "run_cost_invocation_duplicate",
      "Invocation and event IDs must be unique."
    );
  }

  const strategy =
    record.strategy as CostStrategy;
  if (
    invocations.some(
      (entry) =>
        entry.strategy !== strategy
    )
  ) {
    throw new CostLedgerFailure(
      "run_cost_strategy_mismatch",
      "Every invocation must match the run strategy."
    );
  }

  const acceptedPatchCount =
    requireInteger(
      record.acceptedPatchCount,
      "acceptedPatchCount",
      1_000_000
    );
  const outcome =
    record.outcome as CostRunOutcome;
  if (
    (outcome === "accepted_patch" &&
      acceptedPatchCount === 0) ||
    (outcome !== "accepted_patch" &&
      acceptedPatchCount !== 0)
  ) {
    throw new CostLedgerFailure(
      "run_cost_outcome_mismatch",
      "acceptedPatchCount must match the run outcome."
    );
  }

  return {
    ledgerVersion: "1",
    evidenceClass:
      record.evidenceClass as
        RunCostLedgerInput["evidenceClass"],
    observationSource:
      record.observationSource as
        RunCostLedgerInput["observationSource"],
    observationReceiptHash:
      requireHash(
        record.observationReceiptHash,
        "observationReceiptHash"
      ),
    runId: requireId(
      record.runId,
      "runId"
    ),
    taskSetHash: requireHash(
      record.taskSetHash,
      "taskSetHash"
    ),
    sourceLedgerRootHash:
      requireHash(
        record.sourceLedgerRootHash,
        "sourceLedgerRootHash"
      ),
    strategy,
    outcome,
    acceptedPatchCount,
    pricingSnapshots:
      [...pricingSnapshots].sort(
        (left, right) =>
          left.snapshotId.localeCompare(
            right.snapshotId
          )
      ),
    invocations:
      [...invocations].sort(
        (left, right) =>
          left.invocationId.localeCompare(
            right.invocationId
          )
      )
  };
}

function safeAdd(
  left: number,
  right: number,
  code =
    "run_cost_total_overflow"
): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(result) ||
    result > MAX_TOTAL_NANO_USD
  ) {
    throw new CostLedgerFailure(
      code,
      "Run-cost accounting overflowed."
    );
  }
  return result;
}

function safeMultiply(
  left: number,
  right: number
): number {
  const result = left * right;
  if (
    !Number.isSafeInteger(result) ||
    result > MAX_TOTAL_NANO_USD
  ) {
    throw new CostLedgerFailure(
      "run_cost_total_overflow",
      "Run-cost accounting overflowed."
    );
  }
  return result;
}

function emptyTotals(): TokenCostTotals {
  return {
    invocationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costNanoUsd: 0
  };
}

function addUsage(
  totals: TokenCostTotals,
  usage:
    | ObservedTokenUsage
    | EstimatedTokenUsage,
  costNanoUsd: number
): void {
  totals.invocationCount += 1;
  totals.inputTokens = safeAdd(
    totals.inputTokens,
    usage.inputTokens
  );
  totals.outputTokens = safeAdd(
    totals.outputTokens,
    usage.outputTokens
  );
  totals.totalTokens = safeAdd(
    totals.totalTokens,
    usage.totalTokens
  );
  totals.costNanoUsd = safeAdd(
    totals.costNanoUsd,
    costNanoUsd
  );
}

function calculateCost(
  usage:
    | ObservedTokenUsage
    | EstimatedTokenUsage,
  snapshot: ProviderPriceSnapshot
): number {
  return safeAdd(
    safeMultiply(
      usage.inputTokens,
      snapshot.inputNanoUsdPerToken
    ),
    safeMultiply(
      usage.outputTokens,
      snapshot.outputNanoUsdPerToken
    )
  );
}

function roundRatio(
  numerator: number,
  denominator: number
): number | null {
  if (denominator === 0) {
    return null;
  }
  return Number(
    (numerator / denominator).toFixed(6)
  );
}

function roundIntegerDivision(
  numerator: number,
  denominator: number
): number | null {
  if (denominator === 0) {
    return null;
  }
  return Math.round(
    numerator / denominator
  );
}

function ledgerCore(
  ledger: RunCostLedger
): Omit<RunCostLedger, "ledgerHash"> {
  const {
    ledgerHash: _,
    ...core
  } = ledger;
  return core;
}

function reportCore(
  report: RunCostBenchmarkReport
): Omit<
  RunCostBenchmarkReport,
  "reportHash"
> {
  const {
    reportHash: _,
    ...core
  } = report;
  return core;
}

function tokenCostTotalsFromRuns(
  runs: readonly RunCostLedger[],
  key: "observed" | "estimated"
): TokenCostTotals {
  const result = emptyTotals();
  for (const run of runs) {
    const totals = run.totals[key];
    result.invocationCount = safeAdd(
      result.invocationCount,
      totals.invocationCount
    );
    result.inputTokens = safeAdd(
      result.inputTokens,
      totals.inputTokens
    );
    result.outputTokens = safeAdd(
      result.outputTokens,
      totals.outputTokens
    );
    result.totalTokens = safeAdd(
      result.totalTokens,
      totals.totalTokens
    );
    result.costNanoUsd = safeAdd(
      result.costNanoUsd,
      totals.costNanoUsd
    );
  }
  return result;
}

export function normalizeOpenAiCompatibleUsage(
  input: {
    response: unknown;
    providerResponseHash: string;
    providerRequestId?: string | null;
  }
): OpenAiCompatibleUsageResult {
  try {
    const responseHash =
      requireHash(
        input.providerResponseHash,
        "providerResponseHash"
      );

    if (
      input.response === null ||
      typeof input.response !== "object" ||
      Array.isArray(input.response)
    ) {
      return deepFreeze({
        decision:
          "provider_usage_invalid",
        usage: null,
        errors: [
          "provider_usage_response_invalid"
        ]
      });
    }

    const usage =
      (input.response as PlainRecord)
        .usage;
    if (usage === undefined) {
      return deepFreeze({
        decision:
          "provider_usage_unavailable",
        usage: {
          status: "unavailable",
          reason:
            "provider_usage_missing",
          providerResponseHash:
            responseHash
        },
        errors: []
      });
    }
    if (
      usage === null ||
      typeof usage !== "object" ||
      Array.isArray(usage)
    ) {
      return deepFreeze({
        decision:
          "provider_usage_invalid",
        usage: null,
        errors: [
          "provider_usage_shape_invalid"
        ]
      });
    }

    const record =
      usage as PlainRecord;
    const inputTokens =
      record.prompt_tokens ??
      record.promptTokens;
    const outputTokens =
      record.completion_tokens ??
      record.completionTokens;
    const totalTokens =
      record.total_tokens ??
      record.totalTokens;

    const normalized =
      normalizeTokenTriplet(
        {
          inputTokens,
          outputTokens,
          totalTokens
        },
        "provider.usage"
      );

    return deepFreeze({
      decision:
        "provider_usage_observed",
      usage: {
        status: "observed",
        ...normalized,
        providerResponseHash:
          responseHash,
        providerRequestId:
          input.providerRequestId ===
            undefined ||
          input.providerRequestId ===
            null
            ? null
            : requireId(
                input.providerRequestId,
                "providerRequestId"
              )
      },
      errors: []
    });
  } catch (error) {
    const failure =
      error instanceof CostLedgerFailure
        ? error
        : new CostLedgerFailure(
            "provider_usage_exception",
            "Provider usage normalization failed."
          );
    return deepFreeze({
      decision: "provider_usage_invalid",
      usage: null,
      errors: [failure.code]
    });
  }
}

export function buildRunCostLedger(
  rawInput: RunCostLedgerInput
): BuildRunCostLedgerResult {
  try {
    const input =
      validateLedgerInput(rawInput);
    const snapshots = new Map(
      input.pricingSnapshots.map(
        (snapshot) => [
          snapshot.snapshotId,
          snapshot
        ] as const
      )
    );

    const observed = emptyTotals();
    const estimated = emptyTotals();
    const operationState =
      new Map<
        CostOperation,
        {
          observed: TokenCostTotals;
          estimated: TokenCostTotals;
          unavailableInvocationCount: number;
          retryInvocationCount: number;
        }
      >();
    for (const operation of OPERATIONS) {
      operationState.set(operation, {
        observed: emptyTotals(),
        estimated: emptyTotals(),
        unavailableInvocationCount: 0,
        retryInvocationCount: 0
      });
    }

    let unavailableInvocationCount = 0;
    let unpricedObservedInvocationCount = 0;
    let unpricedEstimatedInvocationCount = 0;
    let retryInvocationCount = 0;
    let retryObservedTokens = 0;
    let remaskObservedTokens = 0;
    let expansionObservedTokens = 0;
    let shadowAdminObservedTokens = 0;

    const invocations:
      RunCostInvocation[] = [];

    for (
      const invocation
      of input.invocations
    ) {
      const snapshot =
        invocation.priceSnapshotId === null
          ? undefined
          : snapshots.get(
              invocation.priceSnapshotId
            );
      if (
        invocation.priceSnapshotId !== null &&
        snapshot === undefined
      ) {
        throw new CostLedgerFailure(
          "run_cost_price_snapshot_missing",
          "An invocation references a missing price snapshot."
        );
      }
      if (
        snapshot !== undefined &&
        (
          snapshot.providerId !==
            invocation.providerId ||
          snapshot.modelId !==
            invocation.modelId
        )
      ) {
        throw new CostLedgerFailure(
          "run_cost_price_snapshot_mismatch",
          "Invocation provider/model does not match its price snapshot."
        );
      }

      const isRetry =
        invocation.attempt > 1;
      if (isRetry) {
        retryInvocationCount += 1;
        operationState.get(
          invocation.operation
        )!.retryInvocationCount += 1;
      }

      let costStatus:
        InvocationCostStatus;
      let costNanoUsd: number | null;

      if (
        invocation.usage.status ===
          "unavailable"
      ) {
        costStatus = "unavailable";
        costNanoUsd = null;
        unavailableInvocationCount += 1;
        operationState.get(
          invocation.operation
        )!.unavailableInvocationCount += 1;
      } else {
        const cost =
          snapshot === undefined
            ? 0
            : calculateCost(
                invocation.usage,
                snapshot
              );
        costNanoUsd =
          snapshot === undefined
            ? null
            : cost;
        costStatus =
          costNanoUsd === null
            ? "unavailable"
            : invocation.usage.status;

        if (
          invocation.usage.status ===
            "observed"
        ) {
          addUsage(
            observed,
            invocation.usage,
            cost
          );
          addUsage(
            operationState.get(
              invocation.operation
            )!.observed,
            invocation.usage,
            cost
          );
          if (snapshot === undefined) {
            unpricedObservedInvocationCount +=
              1;
          }
          if (isRetry) {
            retryObservedTokens = safeAdd(
              retryObservedTokens,
              invocation.usage.totalTokens
            );
          }
          if (
            invocation.operation ===
              "remask"
          ) {
            remaskObservedTokens = safeAdd(
              remaskObservedTokens,
              invocation.usage.totalTokens
            );
          }
          if (
            invocation.operation ===
              "expansion"
          ) {
            expansionObservedTokens = safeAdd(
              expansionObservedTokens,
              invocation.usage.totalTokens
            );
          }
          if (
            invocation.operation ===
              "shadow" ||
            invocation.operation ===
              "admin"
          ) {
            shadowAdminObservedTokens =
              safeAdd(
                shadowAdminObservedTokens,
                invocation.usage.totalTokens
              );
          }
        } else {
          addUsage(
            estimated,
            invocation.usage,
            cost
          );
          addUsage(
            operationState.get(
              invocation.operation
            )!.estimated,
            invocation.usage,
            cost
          );
          if (snapshot === undefined) {
            unpricedEstimatedInvocationCount +=
              1;
          }
        }
      }

      const material = {
        invocationId:
          invocation.invocationId,
        eventId: invocation.eventId,
        eventHash: invocation.eventHash,
        operation: invocation.operation,
        strategy: invocation.strategy,
        providerId: invocation.providerId,
        modelId: invocation.modelId,
        attempt: invocation.attempt,
        isRetry,
        usage: invocation.usage,
        priceSnapshotId:
          invocation.priceSnapshotId,
        costStatus,
        costNanoUsd
      };
      invocations.push({
        ...material,
        invocationHash:
          hashCanonicalJson(material)
      });
    }

    const fullObservedCoverage =
      invocations.length > 0 &&
      invocations.every(
        (entry) =>
          entry.usage.status ===
            "observed" &&
          entry.costStatus ===
            "observed"
      );

    const releaseClaimEligible =
      input.evidenceClass ===
        "observed_run" &&
      input.observationSource ===
        "live_provider_call" &&
      fullObservedCoverage &&
      input.acceptedPatchCount > 0;

    const operationAggregates =
      OPERATIONS.map(
        (operation) => {
          const state =
            operationState.get(
              operation
            )!;
          return {
            operation,
            observed: state.observed,
            estimated: state.estimated,
            unavailableInvocationCount:
              state.unavailableInvocationCount,
            retryInvocationCount:
              state.retryInvocationCount
          };
        }
      ).filter(
        (entry) =>
          entry.observed.invocationCount >
            0 ||
          entry.estimated.invocationCount >
            0 ||
          entry.unavailableInvocationCount >
            0
      );

    const providerModelSetHash =
      hashCanonicalJson(
        [...new Set(
          invocations.map(
            (entry) =>
              `${entry.providerId}\0${entry.modelId}`
          )
        )].sort()
      );
    const pricingSnapshotSetHash =
      hashCanonicalJson(
        input.pricingSnapshots
      );

    const material = {
      ledgerVersion: "1" as const,
      evidenceClass:
        input.evidenceClass,
      observationSource:
        input.observationSource,
      observationReceiptHash:
        input.observationReceiptHash,
      releaseClaimEligible,
      runId: input.runId,
      taskSetHash: input.taskSetHash,
      sourceLedgerRootHash:
        input.sourceLedgerRootHash,
      strategy: input.strategy,
      outcome: input.outcome,
      acceptedPatchCount:
        input.acceptedPatchCount,
      providerModelSetHash,
      pricingSnapshotSetHash,
      pricingSnapshots:
        input.pricingSnapshots,
      invocations,
      operationAggregates,
      totals: {
        observed,
        estimated,
        unavailableInvocationCount,
        unpricedObservedInvocationCount,
        unpricedEstimatedInvocationCount,
        retryInvocationCount,
        retryObservedTokens,
        remaskObservedTokens,
        expansionObservedTokens,
        shadowAdminObservedTokens,
        fullObservedCoverage,
        costPerAcceptedPatchNanoUsd:
          fullObservedCoverage
            ? roundIntegerDivision(
                observed.costNanoUsd,
                input.acceptedPatchCount
              )
            : null
      }
    };

    const ledger: RunCostLedger = {
      ...material,
      ledgerHash:
        hashCanonicalJson(material)
    };

    return deepFreeze({
      decision:
        "run_cost_ledger_ready",
      ledger,
      errors: [],
      summary: {
        inputValid: true,
        invocationCount:
          invocations.length,
        observedInvocationCount:
          observed.invocationCount,
        estimatedInvocationCount:
          estimated.invocationCount,
        unavailableInvocationCount,
        fullObservedCoverage,
        releaseClaimEligible,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  } catch (error) {
    const failure =
      error instanceof CostLedgerFailure
        ? error
        : new CostLedgerFailure(
            "run_cost_ledger_exception",
            "Run-cost ledger failed closed."
          );
    return deepFreeze({
      decision:
        "run_cost_ledger_invalid",
      ledger: null,
      errors: [failure.code],
      summary: {
        inputValid: false,
        invocationCount: 0,
        observedInvocationCount: 0,
        estimatedInvocationCount: 0,
        unavailableInvocationCount: 0,
        fullObservedCoverage: false,
        releaseClaimEligible: false,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  }
}

function buildStrategyAggregate(
  strategy: CostStrategy,
  runs: readonly RunCostLedger[]
): StrategyCostAggregate {
  const selected =
    runs.filter(
      (run) => run.strategy === strategy
    );
  const acceptedPatchCount =
    selected.reduce(
      (sum, run) =>
        safeAdd(
          sum,
          run.acceptedPatchCount
        ),
      0
    );
  const observed =
    tokenCostTotalsFromRuns(
      selected,
      "observed"
    );
  const estimated =
    tokenCostTotalsFromRuns(
      selected,
      "estimated"
    );
  const fullObservedRunCount =
    selected.filter(
      (run) =>
        run.totals.fullObservedCoverage
    ).length;

  return {
    strategy,
    runCount: selected.length,
    acceptedPatchCount,
    observed,
    estimated,
    unavailableInvocationCount:
      selected.reduce(
        (sum, run) =>
          safeAdd(
            sum,
            run.totals
              .unavailableInvocationCount
          ),
        0
      ),
    fullObservedRunCount,
    releaseEligibleRunCount:
      selected.filter(
        (run) =>
          run.releaseClaimEligible
      ).length,
    costPerAcceptedPatchNanoUsd:
      selected.length > 0 &&
      fullObservedRunCount ===
        selected.length &&
      acceptedPatchCount > 0
        ? roundIntegerDivision(
            observed.costNanoUsd,
            acceptedPatchCount
          )
        : null
  };
}

function savingsRate(
  baseline: number,
  candidate: number
): number | null {
  if (baseline <= 0) {
    return null;
  }
  return roundRatio(
    baseline - candidate,
    baseline
  );
}

export function buildRunCostBenchmark(
  rawInput: RunCostBenchmarkInput
): BuildRunCostBenchmarkResult {
  try {
    assertAcyclic(rawInput);
    const record = exactRecord(
      rawInput,
      BENCHMARK_FIELDS,
      "run-cost benchmark input"
    );
    if (
      record.benchmarkVersion !== "1" ||
      (
        record.evidenceClass !==
          "deterministic_fixture" &&
        record.evidenceClass !==
          "observed_run"
      ) ||
      !Array.isArray(record.runs) ||
      record.runs.length === 0 ||
      record.runs.length > 10_000
    ) {
      throw new CostLedgerFailure(
        "run_cost_benchmark_input_invalid",
        "Run-cost benchmark input is invalid."
      );
    }
    const benchmarkId =
      requireId(
        record.benchmarkId,
        "benchmarkId"
      );
    const taskSetHash =
      requireHash(
        record.taskSetHash,
        "taskSetHash"
      );
    const evidenceClass =
      record.evidenceClass as
        RunCostBenchmarkInput["evidenceClass"];

    const ledgers:
      RunCostLedger[] = [];
    for (
      const [index, run]
      of (
        record.runs as
          readonly RunCostLedgerInput[]
      ).entries()
    ) {
      if (
        run.evidenceClass !==
          evidenceClass ||
        run.taskSetHash !== taskSetHash
      ) {
        throw new CostLedgerFailure(
          "run_cost_benchmark_run_mismatch",
          `Run ${index} does not match benchmark evidence/task set.`
        );
      }
      const built =
        buildRunCostLedger(run);
      if (built.ledger === null) {
        throw new CostLedgerFailure(
          "run_cost_benchmark_run_invalid",
          `Run ${index} is invalid.`
        );
      }
      ledgers.push(built.ledger);
    }

    const runIds =
      ledgers.map(
        (run) => run.runId
      );
    if (
      new Set(runIds).size !==
        runIds.length
    ) {
      throw new CostLedgerFailure(
        "run_cost_benchmark_run_duplicate",
        "Benchmark run IDs must be unique."
      );
    }
    ledgers.sort(
      (left, right) =>
        left.runId.localeCompare(
          right.runId
        )
    );

    const providerModelHashes =
      new Set(
        ledgers.map(
          (run) =>
            run.providerModelSetHash
        )
      );
    const pricingHashes =
      new Set(
        ledgers.map(
          (run) =>
            run.pricingSnapshotSetHash
        )
      );
    const sameProviderModelSet =
      providerModelHashes.size === 1;
    const samePricingSnapshotSet =
      pricingHashes.size === 1;

    const strategyAggregates =
      STRATEGIES.map(
        (strategy) =>
          buildStrategyAggregate(
            strategy,
            ledgers
          )
      );
    const allStrategiesPresent =
      strategyAggregates.every(
        (entry) => entry.runCount > 0
      );

    const direct =
      strategyAggregates.find(
        (entry) =>
          entry.strategy ===
            "direct_large_context"
      )!;
    const fixed =
      strategyAggregates.find(
        (entry) =>
          entry.strategy ===
            "fixed_bounded_context"
      )!;
    const adaptive =
      strategyAggregates.find(
        (entry) =>
          entry.strategy ===
            "adaptive_bounded_context"
      )!;

    const allRunsReleaseEligible =
      ledgers.every(
        (run) =>
          run.releaseClaimEligible
      );
    const releaseClaimEligible =
      evidenceClass ===
        "observed_run" &&
      allStrategiesPresent &&
      sameProviderModelSet &&
      samePricingSnapshotSet &&
      allRunsReleaseEligible;

    const material = {
      reportVersion: "1" as const,
      benchmarkId,
      evidenceClass,
      taskSetHash,
      sameProviderModelSet,
      samePricingSnapshotSet,
      allStrategiesPresent,
      releaseClaimEligible,
      sourceInputHash:
        hashCanonicalJson({
          benchmarkVersion: "1",
          benchmarkId,
          evidenceClass,
          taskSetHash,
          ledgerHashes:
            ledgers.map(
              (run) => run.ledgerHash
            )
        }),
      ledgers,
      strategyAggregates,
      comparisons: {
        fixedVsDirectObservedTokenSavingsRate:
          allStrategiesPresent
            ? savingsRate(
                direct.observed.totalTokens,
                fixed.observed.totalTokens
              )
            : null,
        adaptiveVsDirectObservedTokenSavingsRate:
          allStrategiesPresent
            ? savingsRate(
                direct.observed.totalTokens,
                adaptive.observed.totalTokens
              )
            : null,
        fixedVsDirectObservedCostSavingsRate:
          allStrategiesPresent
            ? savingsRate(
                direct.observed.costNanoUsd,
                fixed.observed.costNanoUsd
              )
            : null,
        adaptiveVsDirectObservedCostSavingsRate:
          allStrategiesPresent
            ? savingsRate(
                direct.observed.costNanoUsd,
                adaptive.observed.costNanoUsd
              )
            : null
      }
    };

    const report:
      RunCostBenchmarkReport = {
        ...material,
        reportHash:
          hashCanonicalJson(material)
      };

    return deepFreeze({
      decision:
        "run_cost_benchmark_ready",
      report,
      errors: [],
      summary: {
        inputValid: true,
        runCount: ledgers.length,
        strategyCount:
          strategyAggregates.filter(
            (entry) =>
              entry.runCount > 0
          ).length,
        sameProviderModelSet,
        samePricingSnapshotSet,
        allStrategiesPresent,
        releaseClaimEligible,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  } catch (error) {
    const failure =
      error instanceof CostLedgerFailure
        ? error
        : new CostLedgerFailure(
            "run_cost_benchmark_exception",
            "Run-cost benchmark failed closed."
          );
    return deepFreeze({
      decision:
        "run_cost_benchmark_invalid",
      report: null,
      errors: [failure.code],
      summary: {
        inputValid: false,
        runCount: 0,
        strategyCount: 0,
        sameProviderModelSet: false,
        samePricingSnapshotSet: false,
        allStrategiesPresent: false,
        releaseClaimEligible: false,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  }
}

export function verifyRunCostLedger(
  input: RunCostLedgerInput,
  ledger: RunCostLedger
): VerifyRunCostLedgerResult {
  const built =
    buildRunCostLedger(input);
  const integrityVerified =
    HASH.test(ledger.ledgerHash) &&
    ledger.ledgerHash ===
      hashCanonicalJson(
        ledgerCore(ledger)
      );
  const sourceInputMatched =
    built.ledger !== null &&
    built.ledger.ledgerHash ===
      ledger.ledgerHash;
  if (
    !integrityVerified ||
    !sourceInputMatched
  ) {
    return deepFreeze({
      decision:
        "run_cost_ledger_invalid",
      integrityVerified,
      sourceInputMatched,
      releaseClaimEligible: false,
      errors: [
        "run_cost_ledger_verification_mismatch"
      ]
    });
  }
  return deepFreeze({
    decision:
      "run_cost_ledger_current",
    integrityVerified: true,
    sourceInputMatched: true,
    releaseClaimEligible:
      ledger.releaseClaimEligible,
    errors: []
  });
}

export function verifyRunCostBenchmark(
  input: RunCostBenchmarkInput,
  report: RunCostBenchmarkReport
): VerifyRunCostBenchmarkResult {
  const built =
    buildRunCostBenchmark(input);
  const integrityVerified =
    HASH.test(report.reportHash) &&
    report.reportHash ===
      hashCanonicalJson(
        reportCore(report)
      );
  const sourceInputMatched =
    built.report !== null &&
    built.report.reportHash ===
      report.reportHash;
  if (
    !integrityVerified ||
    !sourceInputMatched
  ) {
    return deepFreeze({
      decision:
        "run_cost_benchmark_invalid",
      integrityVerified,
      sourceInputMatched,
      releaseClaimEligible: false,
      errors: [
        "run_cost_benchmark_verification_mismatch"
      ]
    });
  }
  return deepFreeze({
    decision:
      "run_cost_benchmark_current",
    integrityVerified: true,
    sourceInputMatched: true,
    releaseClaimEligible:
      report.releaseClaimEligible,
    errors: []
  });
}
