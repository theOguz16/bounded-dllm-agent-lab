import {
  computeAgentEventHash,
  computeEmptyLedgerRootHash,
  type AgentEvent,
  type AgentEventLedger,
  type AgentRole
} from "./agent-event-ledger.js";
import {
  buildRunCostLedger,
  type CostOperation,
  type CostRunOutcome,
  type CostStrategy,
  type ProviderPriceSnapshot,
  type RunCostLedger,
  type RunCostInvocationInput,
  type TokenUsageEvidence
} from "./run-cost-ledger.js";

export const AGENT_EVENT_COST_BINDING_VERSION = "1" as const;

export type AgentEventCostObservation = {
  observationVersion: "1";
  eventId: string;
  operation: CostOperation;
  providerId: string;
  modelId: string;
  attempt: number;
  usage: TokenUsageEvidence;
  priceSnapshotId: string | null;
};

export type BuildRunCostLedgerFromAgentEventsInput = {
  bindingVersion: "1";
  evidenceClass:
    | "deterministic_fixture"
    | "observed_run";
  observationSource:
    | "fixture"
    | "live_provider_call";
  observationReceiptHash: string;
  taskSetHash: string;
  strategy: CostStrategy;
  outcome: CostRunOutcome;
  acceptedPatchCount: number;
  agentLedger: AgentEventLedger;
  pricingSnapshots:
    readonly ProviderPriceSnapshot[];
  observations:
    readonly AgentEventCostObservation[];
};

export type BuildRunCostLedgerFromAgentEventsResult = {
  decision:
    | "agent_event_cost_binding_ready"
    | "agent_event_cost_binding_invalid";
  ledger: RunCostLedger | null;
  errors: readonly string[];
  summary: {
    agentLedgerIntegrityVerified: boolean;
    observationCount: number;
    tokenBearingEventCount: number;
    allTokenEventsBound: boolean;
    releaseClaimEligible: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

type PlainRecord = Record<string, unknown>;

const HASH =
  /^sha256:[0-9a-f]{64}$/;
const SAFE_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
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
const OBSERVATION_FIELDS = new Set([
  "observationVersion",
  "eventId",
  "operation",
  "providerId",
  "modelId",
  "attempt",
  "usage",
  "priceSnapshotId"
]);
const INPUT_FIELDS = new Set([
  "bindingVersion",
  "evidenceClass",
  "observationSource",
  "observationReceiptHash",
  "taskSetHash",
  "strategy",
  "outcome",
  "acceptedPatchCount",
  "agentLedger",
  "pricingSnapshots",
  "observations"
]);

class BindingFailure extends Error {
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
    throw new BindingFailure(
      "agent_event_cost_structure_invalid",
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
      throw new BindingFailure(
        "agent_event_cost_structure_invalid",
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
    throw new BindingFailure(
      "agent_event_cost_cycle_detected",
      "Agent-event cost input must be acyclic."
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
      throw new BindingFailure(
        "agent_event_cost_structure_invalid",
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
    !SAFE_ID.test(value)
  ) {
    throw new BindingFailure(
      "agent_event_cost_identifier_invalid",
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
    throw new BindingFailure(
      "agent_event_cost_hash_invalid",
      `${field} must be a SHA-256 hash.`
    );
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  field: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 1_000
  ) {
    throw new BindingFailure(
      "agent_event_cost_numeric_invalid",
      `${field} is invalid.`
    );
  }
  return value as number;
}

function validateAgentLedger(
  ledger: AgentEventLedger
): void {
  if (
    ledger === null ||
    typeof ledger !== "object" ||
    Array.isArray(ledger) ||
    ledger.ledgerVersion !== "1" ||
    !Array.isArray(ledger.events) ||
    ledger.eventCount !==
      ledger.events.length ||
    !HASH.test(ledger.objectiveHash) ||
    !HASH.test(ledger.rootHash)
  ) {
    throw new BindingFailure(
      "agent_event_cost_ledger_invalid",
      "Agent event ledger is invalid."
    );
  }

  let previousHash:
    string | null = null;

  for (
    const [index, event]
    of ledger.events.entries()
  ) {
    if (
      event.eventVersion !== "1" ||
      event.runId !== ledger.runId ||
      event.sequence !== index + 1 ||
      event.eventId !==
        `${ledger.runId}:event:${String(
          index + 1
        ).padStart(6, "0")}` ||
      event.previousEventHash !==
        previousHash
    ) {
      throw new BindingFailure(
        "agent_event_cost_ledger_invalid",
        "Agent event sequence or linkage is invalid."
      );
    }
    const {
      eventHash,
      ...material
    } = event;
    if (
      !HASH.test(eventHash) ||
      computeAgentEventHash(material) !==
        eventHash
    ) {
      throw new BindingFailure(
        "agent_event_cost_ledger_invalid",
        "Agent event hash is invalid."
      );
    }
    previousHash = eventHash;
  }

  const expectedRoot =
    ledger.events.length === 0
      ? computeEmptyLedgerRootHash(
          ledger.runId,
          ledger.objectiveHash
        )
      : ledger.events.at(-1)!.eventHash;

  if (ledger.rootHash !== expectedRoot) {
    throw new BindingFailure(
      "agent_event_cost_ledger_invalid",
      "Agent event ledger root hash is invalid."
    );
  }
}

function operationAllowedForActor(
  actor: AgentRole,
  operation: CostOperation
): boolean {
  const mapping:
    Readonly<
      Record<
        AgentRole,
        readonly CostOperation[]
      >
    > = {
    planner: ["planner", "expansion"],
    coder: ["coder"],
    deterministic_verifier: [],
    masker: ["remask"],
    repairer: ["repair"],
    repair_verifier: ["verifier"],
    patch_dry_run: [],
    temp_workspace_apply: [],
    execution_verifier: [],
    shadow_observer: ["shadow"],
    deterministic_governor: [],
    admin_invocation_policy: [],
    admin_agent: ["admin"],
    approval_router: []
  };
  return mapping[actor].includes(
    operation
  );
}

function tokenUsageMatches(
  event: AgentEvent,
  usage: TokenUsageEvidence
): boolean {
  if (
    usage.status === "unavailable"
  ) {
    return event.tokenUsage === undefined;
  }
  return (
    event.tokenUsage !== undefined &&
    event.tokenUsage.inputTokens ===
      usage.inputTokens &&
    event.tokenUsage.outputTokens ===
      usage.outputTokens &&
    event.tokenUsage.totalTokens ===
      usage.totalTokens
  );
}

function validateObservation(
  value: unknown,
  index: number
): AgentEventCostObservation {
  const record = exactRecord(
    value,
    OBSERVATION_FIELDS,
    `observations[${index}]`
  );
  if (
    record.observationVersion !== "1" ||
    !OPERATIONS.includes(
      record.operation as CostOperation
    ) ||
    record.usage === null ||
    typeof record.usage !== "object" ||
    Array.isArray(record.usage)
  ) {
    throw new BindingFailure(
      "agent_event_cost_observation_invalid",
      "An agent-event cost observation is invalid."
    );
  }
  return {
    observationVersion: "1",
    eventId: requireId(
      record.eventId,
      `observations[${index}].eventId`
    ),
    operation:
      record.operation as CostOperation,
    providerId: requireId(
      record.providerId,
      `observations[${index}].providerId`
    ),
    modelId: requireId(
      record.modelId,
      `observations[${index}].modelId`
    ),
    attempt: requirePositiveInteger(
      record.attempt,
      `observations[${index}].attempt`
    ),
    usage:
      record.usage as TokenUsageEvidence,
    priceSnapshotId:
      record.priceSnapshotId === null
        ? null
        : requireId(
            record.priceSnapshotId,
            `observations[${index}].priceSnapshotId`
          )
  };
}

export function buildRunCostLedgerFromAgentEvents(
  rawInput:
    BuildRunCostLedgerFromAgentEventsInput
): BuildRunCostLedgerFromAgentEventsResult {
  try {
    assertAcyclic(rawInput);
    const record = exactRecord(
      rawInput,
      INPUT_FIELDS,
      "agent-event cost binding input"
    );
    if (
      record.bindingVersion !== "1" ||
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
      ![
        "direct_large_context",
        "fixed_bounded_context",
        "adaptive_bounded_context"
      ].includes(record.strategy as string) ||
      ![
        "accepted_patch",
        "human_review",
        "rejected",
        "failed"
      ].includes(record.outcome as string) ||
      !Array.isArray(
        record.pricingSnapshots
      ) ||
      !Array.isArray(
        record.observations
      )
    ) {
      throw new BindingFailure(
        "agent_event_cost_input_invalid",
        "Agent-event cost binding input is invalid."
      );
    }

    const agentLedger =
      record.agentLedger as
        AgentEventLedger;
    validateAgentLedger(agentLedger);

    const observations =
      record.observations.map(
        validateObservation
      );
    const observationEventIds =
      observations.map(
        (entry) => entry.eventId
      );
    if (
      new Set(
        observationEventIds
      ).size !==
        observationEventIds.length
    ) {
      throw new BindingFailure(
        "agent_event_cost_observation_duplicate",
        "An event may have at most one cost observation."
      );
    }

    const eventMap = new Map(
      agentLedger.events.map(
        (event) => [
          event.eventId,
          event
        ] as const
      )
    );

    const invocations:
      RunCostInvocationInput[] = [];

    for (
      const [index, observation]
      of observations.entries()
    ) {
      const event =
        eventMap.get(
          observation.eventId
        );
      if (event === undefined) {
        throw new BindingFailure(
          "agent_event_cost_event_missing",
          "A cost observation references a missing event."
        );
      }
      if (
        !operationAllowedForActor(
          event.actor,
          observation.operation
        )
      ) {
        throw new BindingFailure(
          "agent_event_cost_role_mismatch",
          "Cost operation does not match the agent role."
        );
      }
      if (
        !tokenUsageMatches(
          event,
          observation.usage
        )
      ) {
        throw new BindingFailure(
          "agent_event_cost_usage_mismatch",
          "Cost observation token usage does not match the agent event."
        );
      }

      invocations.push({
        invocationId:
          `${agentLedger.runId}:cost:${String(
            index + 1
          ).padStart(6, "0")}`,
        eventId: event.eventId,
        eventHash: event.eventHash,
        operation:
          observation.operation,
        strategy:
          record.strategy as CostStrategy,
        providerId:
          observation.providerId,
        modelId: observation.modelId,
        attempt: observation.attempt,
        usage: observation.usage,
        priceSnapshotId:
          observation.priceSnapshotId
      });
    }

    const tokenBearingEventIds =
      agentLedger.events
        .filter(
          (event) =>
            event.tokenUsage !==
              undefined
        )
        .map(
          (event) => event.eventId
        );
    const observedEventSet =
      new Set(
        observations
          .filter(
            (entry) =>
              entry.usage.status !==
                "unavailable"
          )
          .map(
            (entry) => entry.eventId
          )
      );
    const allTokenEventsBound =
      tokenBearingEventIds.every(
        (eventId) =>
          observedEventSet.has(eventId)
      );
    if (!allTokenEventsBound) {
      throw new BindingFailure(
        "agent_event_cost_token_event_unbound",
        "Every token-bearing agent event must have a cost observation."
      );
    }

    const built =
      buildRunCostLedger({
        ledgerVersion: "1",
        evidenceClass:
          record.evidenceClass as
            BuildRunCostLedgerFromAgentEventsInput["evidenceClass"],
        observationSource:
          record.observationSource as
            BuildRunCostLedgerFromAgentEventsInput["observationSource"],
        observationReceiptHash:
          requireHash(
            record.observationReceiptHash,
            "observationReceiptHash"
          ),
        runId: agentLedger.runId,
        taskSetHash:
          requireHash(
            record.taskSetHash,
            "taskSetHash"
          ),
        sourceLedgerRootHash:
          agentLedger.rootHash,
        strategy:
          record.strategy as CostStrategy,
        outcome:
          record.outcome as CostRunOutcome,
        acceptedPatchCount:
          Number(
            record.acceptedPatchCount
          ),
        pricingSnapshots:
          record.pricingSnapshots as
            readonly ProviderPriceSnapshot[],
        invocations
      });

    if (built.ledger === null) {
      throw new BindingFailure(
        "agent_event_cost_ledger_build_invalid",
        built.errors[0] ??
          "run_cost_ledger_invalid"
      );
    }

    return deepFreeze({
      decision:
        "agent_event_cost_binding_ready",
      ledger: built.ledger,
      errors: [],
      summary: {
        agentLedgerIntegrityVerified: true,
        observationCount:
          observations.length,
        tokenBearingEventCount:
          tokenBearingEventIds.length,
        allTokenEventsBound: true,
        releaseClaimEligible:
          built.ledger
            .releaseClaimEligible,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  } catch (error) {
    const failure =
      error instanceof BindingFailure
        ? error
        : new BindingFailure(
            "agent_event_cost_binding_exception",
            "Agent-event cost binding failed closed."
          );
    return deepFreeze({
      decision:
        "agent_event_cost_binding_invalid",
      ledger: null,
      errors: [failure.code],
      summary: {
        agentLedgerIntegrityVerified: false,
        observationCount: 0,
        tokenBearingEventCount: 0,
        allTokenEventsBound: false,
        releaseClaimEligible: false,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  }
}
