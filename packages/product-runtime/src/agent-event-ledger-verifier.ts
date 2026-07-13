import {
  AGENT_EVENT_LEDGER_VERSION,
  appendAgentEvent,
  canonicalizeJson,
  computeEmptyLedgerRootHash,
  createAgentEventLedger,
  type AgentEvent,
  type AgentEventDraft,
  type AgentEventLedger,
  type AgentRole,
  type AgentTokenUsage
} from "./agent-event-ledger.js";

/**
 * A valid internal hash chain proves consistency, not authorship or permanence.
 * An attacker who can replace every event and the root can create another
 * internally consistent ledger. Detecting complete replacement requires a
 * trusted external root/artifact hash, signed record, or equivalent anchor.
 * A later Phase W governed change artifact binds the ledger root externally.
 */

export type LedgerVerificationDecision =
  | "ledger_valid"
  | "ledger_invalid"
  | "ledger_needs_review";

export type LedgerVerificationIssueSeverity = "warning" | "error";

export type LedgerVerificationIssue = {
  code: string;
  message: string;
  severity: LedgerVerificationIssueSeverity;
  field?: string;
  eventIndex?: number;
  eventSequence?: number;
  eventId?: string;
};

export type AgentEventLedgerVerificationOptions = {
  expectedRunId?: string;
  expectedObjectiveHash?: string;
  expectedRootHash?: string;
  expectedEventCount?: number;
};

export type AgentEventLedgerVerificationResult = {
  decision: LedgerVerificationDecision;
  issues: readonly LedgerVerificationIssue[];
  verifiedLedger: AgentEventLedger | null;
  summary: {
    ledgerVersionSupported: boolean;
    inputIsLedgerObject: boolean;
    declaredEventCount: number | null;
    actualEventCount: number;
    verifiedEventCount: number;
    firstInvalidEventIndex: number | null;
    runIdValid: boolean;
    objectiveHashValid: boolean;
    eventCountMatches: boolean;
    sequencesValid: boolean;
    eventIdsValid: boolean;
    eventVersionsSupported: boolean;
    eventRunIdsConsistent: boolean;
    eventHashesValid: boolean;
    previousHashesValid: boolean;
    rootHashValid: boolean;
    normalizationValid: boolean;
    noUnknownFields: boolean;
    noDuplicateEventIds: boolean;
    externalRunIdAnchorProvided: boolean;
    externalRunIdAnchorMatched: boolean | null;
    externalObjectiveHashAnchorProvided: boolean;
    externalObjectiveHashAnchorMatched: boolean | null;
    externalRootHashAnchorProvided: boolean;
    externalRootHashAnchorMatched: boolean | null;
    externalEventCountAnchorProvided: boolean;
    externalEventCountAnchorMatched: boolean | null;
    internallyConsistent: boolean;
    externallyAnchored: boolean;
    externalAnchorsMatched: boolean;
    boundedVerificationCompleted: boolean;
  };
};

type MutableSummary = AgentEventLedgerVerificationResult["summary"];
type IssueContext = Pick<
  LedgerVerificationIssue,
  "field" | "eventIndex" | "eventSequence" | "eventId"
>;

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_EVENTS = 1000;
const LEDGER_FIELDS = [
  "ledgerVersion",
  "runId",
  "objectiveHash",
  "events",
  "eventCount",
  "rootHash"
] as const;
const REQUIRED_EVENT_FIELDS = [
  "eventVersion",
  "eventId",
  "runId",
  "sequence",
  "actor",
  "action",
  "startedAt",
  "finishedAt",
  "durationMs",
  "inputArtifactHashes",
  "outputArtifactHashes",
  "filesRead",
  "filesProposed",
  "decision",
  "reasonCodes",
  "previousEventHash",
  "eventHash"
] as const;
const EVENT_FIELDS = [...REQUIRED_EVENT_FIELDS, "tokenUsage"] as const;
const TOKEN_USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens"] as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validateOptions(options: AgentEventLedgerVerificationOptions | undefined): {
  expectedRunId?: string;
  expectedObjectiveHash?: string;
  expectedRootHash?: string;
  expectedEventCount?: number;
} {
  if (options === undefined) {
    return {};
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Ledger verification options must be an object when provided.");
  }

  const validated: AgentEventLedgerVerificationOptions = {};
  if (options.expectedRunId !== undefined) {
    createAgentEventLedger({
      runId: options.expectedRunId,
      objectiveHash: `sha256:${"0".repeat(64)}`
    });
    validated.expectedRunId = options.expectedRunId;
  }
  if (options.expectedObjectiveHash !== undefined) {
    createAgentEventLedger({
      runId: "anchor-validation",
      objectiveHash: options.expectedObjectiveHash
    });
    validated.expectedObjectiveHash = options.expectedObjectiveHash;
  }
  if (options.expectedRootHash !== undefined) {
    createAgentEventLedger({
      runId: "anchor-validation",
      objectiveHash: options.expectedRootHash
    });
    validated.expectedRootHash = options.expectedRootHash;
  }
  if (options.expectedEventCount !== undefined) {
    if (
      !Number.isSafeInteger(options.expectedEventCount) ||
      options.expectedEventCount < 0 ||
      options.expectedEventCount > MAX_EVENTS
    ) {
      throw new TypeError(
        `expectedEventCount must be a non-negative safe integer no greater than ${MAX_EVENTS}.`
      );
    }
    validated.expectedEventCount = options.expectedEventCount;
  }
  return validated;
}

function initialSummary(
  options: ReturnType<typeof validateOptions>
): MutableSummary {
  const runProvided = options.expectedRunId !== undefined;
  const objectiveProvided = options.expectedObjectiveHash !== undefined;
  const rootProvided = options.expectedRootHash !== undefined;
  const countProvided = options.expectedEventCount !== undefined;

  return {
    ledgerVersionSupported: false,
    inputIsLedgerObject: false,
    declaredEventCount: null,
    actualEventCount: 0,
    verifiedEventCount: 0,
    firstInvalidEventIndex: null,
    runIdValid: false,
    objectiveHashValid: false,
    eventCountMatches: false,
    sequencesValid: false,
    eventIdsValid: false,
    eventVersionsSupported: false,
    eventRunIdsConsistent: false,
    eventHashesValid: false,
    previousHashesValid: false,
    rootHashValid: false,
    normalizationValid: false,
    noUnknownFields: true,
    noDuplicateEventIds: true,
    externalRunIdAnchorProvided: runProvided,
    externalRunIdAnchorMatched: runProvided ? false : null,
    externalObjectiveHashAnchorProvided: objectiveProvided,
    externalObjectiveHashAnchorMatched: objectiveProvided ? false : null,
    externalRootHashAnchorProvided: rootProvided,
    externalRootHashAnchorMatched: rootProvided ? false : null,
    externalEventCountAnchorProvided: countProvided,
    externalEventCountAnchorMatched: countProvided ? false : null,
    internallyConsistent: false,
    externallyAnchored: runProvided || objectiveProvided || rootProvided || countProvided,
    externalAnchorsMatched: !(runProvided || objectiveProvided || rootProvided || countProvided),
    boundedVerificationCompleted: false
  };
}

function inspectExactObject(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  issue: (
    code: string,
    message: string,
    severity: LedgerVerificationIssueSeverity,
    context?: IssueContext
  ) => void,
  codes: {
    invalidInput: string;
    invalidObject: string;
    unknownField: string;
    accessor: string;
    symbol: string;
    missingField: string;
  },
  context: IssueContext = {}
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issue(codes.invalidInput, "The value is not an object.", "error", context);
    return null;
  }
  if (Array.isArray(value)) {
    issue(codes.invalidObject, "An array cannot be used as this object.", "error", context);
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    issue(codes.invalidObject, "Only a plain object is accepted.", "error", context);
    return null;
  }

  const allowed = new Set(allowedFields);
  const present = new Set<string>();
  const output: Record<string, unknown> = {};

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      issue(codes.symbol, "Symbol-keyed properties are not accepted.", "error", context);
      continue;
    }
    present.add(key);
    const fieldContext = { ...context, field: key };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      issue(codes.invalidObject, "A property could not be inspected safely.", "error", fieldContext);
      continue;
    }
    if (!("value" in descriptor)) {
      issue(codes.accessor, "Accessor properties are not accepted.", "error", fieldContext);
      continue;
    }
    if (!allowed.has(key)) {
      issue(codes.unknownField, "The object contains an unknown field.", "error", fieldContext);
      continue;
    }
    output[key] = descriptor.value;
  }

  for (const field of requiredFields) {
    if (!present.has(field)) {
      issue(codes.missingField, "The object is missing a required field.", "error", {
        ...context,
        field
      });
    }
  }
  return output;
}

function readDenseArray(
  value: unknown,
  maximum: number,
  onInvalid: () => void
): unknown[] | null {
  if (!Array.isArray(value)) {
    onInvalid();
    return null;
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    onInvalid();
    return null;
  }
  const length = lengthDescriptor.value as number;
  const output: unknown[] = [];

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      onInvalid();
      return null;
    }
  }

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      onInvalid();
      return null;
    }
    output.push(descriptor.value);
  }
  return output;
}

function tokenUsageFromRaw(
  value: unknown,
  issue: (
    code: string,
    message: string,
    severity: LedgerVerificationIssueSeverity,
    context?: IssueContext
  ) => void,
  context: IssueContext
): AgentTokenUsage | null {
  const raw = inspectExactObject(
    value,
    TOKEN_USAGE_FIELDS,
    TOKEN_USAGE_FIELDS,
    issue,
    {
      invalidInput: "event_normalization_mismatch",
      invalidObject: "event_normalization_mismatch",
      unknownField: "unknown_event_field",
      accessor: "event_accessor_property",
      symbol: "event_symbol_property",
      missingField: "event_normalization_mismatch"
    },
    { ...context, field: "tokenUsage" }
  );
  if (raw === null) {
    return null;
  }
  return {
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    totalTokens: raw.totalTokens as number
  };
}

function eventDraftMaterial(event: AgentEvent | Record<string, unknown>): Record<string, unknown> {
  return {
    actor: event.actor,
    action: event.action,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    inputArtifactHashes: event.inputArtifactHashes,
    outputArtifactHashes: event.outputArtifactHashes,
    filesRead: event.filesRead,
    filesProposed: event.filesProposed,
    decision: event.decision,
    reasonCodes: event.reasonCodes,
    ...(
      event.tokenUsage === undefined
        ? {}
        : { tokenUsage: event.tokenUsage }
    )
  };
}

export function verifyAgentEventLedger(
  input: unknown,
  options?: AgentEventLedgerVerificationOptions
): AgentEventLedgerVerificationResult {
  const anchors = validateOptions(options);
  const summary = initialSummary(anchors);
  const issues: LedgerVerificationIssue[] = [];
  let reconstructedLedger: AgentEventLedger | null = null;
  let internalProblem = false;

  const issue = (
    code: string,
    message: string,
    severity: LedgerVerificationIssueSeverity,
    context: IssueContext = {},
    internal = true
  ): void => {
    issues.push({ code, message, severity, ...context });
    if (internal) {
      internalProblem = true;
    }
    if (context.eventIndex !== undefined && summary.firstInvalidEventIndex === null) {
      summary.firstInvalidEventIndex = context.eventIndex;
    }
  };

  const finish = (): AgentEventLedgerVerificationResult => {
    const hasError = issues.some((entry) => entry.severity === "error");
    const hasWarning = issues.some((entry) => entry.severity === "warning");
    const decision: LedgerVerificationDecision = hasError
      ? "ledger_invalid"
      : hasWarning || !summary.internallyConsistent || !summary.boundedVerificationCompleted
        ? "ledger_needs_review"
        : "ledger_valid";
    const verifiedLedger =
      decision === "ledger_valid" &&
      summary.internallyConsistent &&
      summary.boundedVerificationCompleted &&
      summary.externalAnchorsMatched
        ? reconstructedLedger
        : null;
    return deepFreeze({
      decision,
      issues,
      verifiedLedger,
      summary
    }) as AgentEventLedgerVerificationResult;
  };

  try {
    const rawLedger = inspectExactObject(
      input,
      LEDGER_FIELDS,
      LEDGER_FIELDS,
      issue,
      {
        invalidInput: "invalid_ledger_input",
        invalidObject: "invalid_ledger_object",
        unknownField: "unknown_ledger_field",
        accessor: "ledger_accessor_property",
        symbol: "ledger_symbol_property",
        missingField: "missing_ledger_field"
      }
    );
    if (rawLedger === null) {
      return finish();
    }
    summary.inputIsLedgerObject = true;
    if (issues.some((entry) => entry.severity === "error")) {
      summary.noUnknownFields = !issues.some((entry) =>
        ["unknown_ledger_field", "ledger_symbol_property"].includes(entry.code)
      );
    }

    if (rawLedger.ledgerVersion === AGENT_EVENT_LEDGER_VERSION) {
      summary.ledgerVersionSupported = true;
    } else if (typeof rawLedger.ledgerVersion === "string") {
      issue(
        "unsupported_ledger_version",
        "The ledger version is not supported by this verifier.",
        "warning"
      );
    } else {
      issue(
        "unsupported_ledger_version",
        "The ledger version is malformed.",
        "error"
      );
    }

    if (typeof rawLedger.eventCount === "number" && Number.isSafeInteger(rawLedger.eventCount)) {
      summary.declaredEventCount = rawLedger.eventCount;
    }
    if (
      !Number.isSafeInteger(rawLedger.eventCount) ||
      (rawLedger.eventCount as number) < 0
    ) {
      issue("invalid_event_count", "eventCount must be a non-negative safe integer.", "error", {
        field: "eventCount"
      });
    } else if ((rawLedger.eventCount as number) > MAX_EVENTS) {
      issue(
        "too_many_events",
        "The declared event count exceeds the bounded verification limit.",
        "warning",
        { field: "eventCount" }
      );
    }

    let rawEvents: unknown[] | null = null;
    if (!Array.isArray(rawLedger.events)) {
      issue("events_not_array", "events must be an array.", "error", { field: "events" });
    } else {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(rawLedger.events, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        issue("events_not_array", "The events array length is invalid.", "error", {
          field: "events"
        });
      } else {
        summary.actualEventCount = lengthDescriptor.value as number;
        if (summary.actualEventCount > MAX_EVENTS) {
          issue(
            "too_many_events",
            "The actual event count exceeds the bounded verification limit.",
            "warning",
            { field: "events" }
          );
        } else {
          rawEvents = readDenseArray(rawLedger.events, MAX_EVENTS, () => {
            issue(
              "sparse_events_array",
              "The events array must be dense and contain only indexed data properties.",
              "error",
              { field: "events" }
            );
          });
        }
      }
    }

    if (
      summary.declaredEventCount !== null &&
      summary.declaredEventCount === summary.actualEventCount
    ) {
      summary.eventCountMatches = true;
    } else if (
      Number.isSafeInteger(rawLedger.eventCount) &&
      (rawLedger.eventCount as number) >= 0
    ) {
      issue("event_count_mismatch", "eventCount does not match events.length.", "error", {
        field: "eventCount"
      });
    }

    try {
      createAgentEventLedger({
        runId: rawLedger.runId as string,
        objectiveHash: `sha256:${"0".repeat(64)}`
      });
      summary.runIdValid = true;
    } catch {
      issue("invalid_run_id", "The ledger runId is invalid.", "error", { field: "runId" });
    }
    try {
      createAgentEventLedger({
        runId: "ledger-verification",
        objectiveHash: rawLedger.objectiveHash as string
      });
      summary.objectiveHashValid = true;
    } catch {
      issue("invalid_objective_hash", "The ledger objectiveHash is invalid.", "error", {
        field: "objectiveHash"
      });
    }
    if (typeof rawLedger.rootHash !== "string" || !HASH_PATTERN.test(rawLedger.rootHash)) {
      issue("invalid_root_hash", "The ledger rootHash is invalid.", "error", {
        field: "rootHash"
      });
    }

    if (anchors.expectedRunId !== undefined) {
      summary.externalRunIdAnchorMatched = rawLedger.runId === anchors.expectedRunId;
      if (!summary.externalRunIdAnchorMatched) {
        issue(
          "external_run_id_anchor_mismatch",
          "The ledger runId does not match the trusted external anchor.",
          "error",
          { field: "runId" },
          false
        );
      }
    }
    if (anchors.expectedObjectiveHash !== undefined) {
      summary.externalObjectiveHashAnchorMatched =
        rawLedger.objectiveHash === anchors.expectedObjectiveHash;
      if (!summary.externalObjectiveHashAnchorMatched) {
        issue(
          "external_objective_hash_anchor_mismatch",
          "The ledger objectiveHash does not match the trusted external anchor.",
          "error",
          { field: "objectiveHash" },
          false
        );
      }
    }
    if (anchors.expectedRootHash !== undefined) {
      summary.externalRootHashAnchorMatched = rawLedger.rootHash === anchors.expectedRootHash;
      if (!summary.externalRootHashAnchorMatched) {
        issue(
          "external_root_hash_anchor_mismatch",
          "The ledger rootHash does not match the trusted external anchor.",
          "error",
          { field: "rootHash" },
          false
        );
      }
    }
    if (anchors.expectedEventCount !== undefined) {
      summary.externalEventCountAnchorMatched =
        rawLedger.eventCount === anchors.expectedEventCount;
      if (!summary.externalEventCountAnchorMatched) {
        issue(
          "external_event_count_anchor_mismatch",
          "The ledger eventCount does not match the trusted external anchor.",
          "error",
          { field: "eventCount" },
          false
        );
      }
    }
    summary.externalAnchorsMatched = [
      summary.externalRunIdAnchorMatched,
      summary.externalObjectiveHashAnchorMatched,
      summary.externalRootHashAnchorMatched,
      summary.externalEventCountAnchorMatched
    ].every((matched) => matched === null || matched === true);

    if (
      !summary.ledgerVersionSupported ||
      rawEvents === null ||
      summary.actualEventCount > MAX_EVENTS ||
      !summary.runIdValid ||
      !summary.objectiveHashValid
    ) {
      return finish();
    }

    reconstructedLedger = createAgentEventLedger({
      runId: rawLedger.runId as string,
      objectiveHash: rawLedger.objectiveHash as string
    });
    summary.sequencesValid = true;
    summary.eventIdsValid = true;
    summary.eventVersionsSupported = true;
    summary.eventRunIdsConsistent = true;
    summary.eventHashesValid = true;
    summary.previousHashesValid = true;
    summary.normalizationValid = true;

    const seenEventIds = new Set<string>();
    const seenEventHashes = new Set<string>();
    const safeEvents: Record<string, unknown>[] = [];
    let reconstructionCompleted = true;
    let reconstructionAvailable = true;

    for (let index = 0; index < rawEvents.length; index += 1) {
      const rawValue = rawEvents[index];
      const baseContext: IssueContext = { eventIndex: index };
      const errorsBeforeEvent = issues.filter((entry) => entry.severity === "error").length;
      const rawEvent = inspectExactObject(
        rawValue,
        EVENT_FIELDS,
        REQUIRED_EVENT_FIELDS,
        issue,
        {
          invalidInput: "invalid_event_object",
          invalidObject: "invalid_event_object",
          unknownField: "unknown_event_field",
          accessor: "event_accessor_property",
          symbol: "event_symbol_property",
          missingField: "missing_event_field"
        },
        baseContext
      );
      if (rawEvent === null) {
        summary.normalizationValid = false;
        reconstructionCompleted = false;
        reconstructionAvailable = false;
        continue;
      }

      const eventContext: IssueContext = {
        eventIndex: index,
        ...(Number.isSafeInteger(rawEvent.sequence)
          ? { eventSequence: rawEvent.sequence as number }
          : {}),
        ...(typeof rawEvent.eventId === "string" &&
        rawEvent.eventId.length <= 160 &&
        /^[A-Za-z0-9._:-]+$/.test(rawEvent.eventId)
          ? { eventId: rawEvent.eventId }
          : {})
      };

      if (rawEvent.eventVersion !== AGENT_EVENT_LEDGER_VERSION) {
        summary.eventVersionsSupported = false;
        if (typeof rawEvent.eventVersion === "string") {
          issue(
            "unsupported_event_version",
            "The event version is not supported by this verifier.",
            "warning",
            { ...eventContext, field: "eventVersion" }
          );
        } else {
          issue(
            "unsupported_event_version",
            "The event version is malformed.",
            "error",
            { ...eventContext, field: "eventVersion" }
          );
        }
      }

      const expectedSequence = index + 1;
      if (!Number.isSafeInteger(rawEvent.sequence) || (rawEvent.sequence as number) <= 0) {
        summary.sequencesValid = false;
        issue(
          "invalid_event_sequence",
          "The event sequence must be a positive safe integer.",
          "error",
          { ...eventContext, field: "sequence" }
        );
      } else if (rawEvent.sequence !== expectedSequence) {
        summary.sequencesValid = false;
        issue(
          "event_sequence_mismatch",
          "The event sequence does not match its array position.",
          "error",
          { ...eventContext, field: "sequence" }
        );
      }

      const expectedEventId = `${rawLedger.runId}:event:${String(expectedSequence).padStart(6, "0")}`;
      if (typeof rawEvent.eventId !== "string" || rawEvent.eventId.length === 0) {
        summary.eventIdsValid = false;
        issue("invalid_event_id", "The event ID is invalid.", "error", {
          ...eventContext,
          field: "eventId"
        });
      } else {
        if (rawEvent.eventId !== expectedEventId) {
          summary.eventIdsValid = false;
          issue("event_id_mismatch", "The event ID is not the deterministic expected ID.", "error", {
            ...eventContext,
            field: "eventId"
          });
        }
        if (seenEventIds.has(rawEvent.eventId)) {
          summary.noDuplicateEventIds = false;
          issue("duplicate_event_id", "The ledger contains a duplicate event ID.", "error", {
            ...eventContext,
            field: "eventId"
          });
        }
        seenEventIds.add(rawEvent.eventId);
      }

      if (rawEvent.runId !== rawLedger.runId) {
        summary.eventRunIdsConsistent = false;
        issue("event_run_id_mismatch", "The event runId does not match the ledger runId.", "error", {
          ...eventContext,
          field: "runId"
        });
      }

      if (typeof rawEvent.eventHash === "string" && HASH_PATTERN.test(rawEvent.eventHash)) {
        if (seenEventHashes.has(rawEvent.eventHash)) {
          issue(
            "duplicate_event_hash",
            "The ledger contains a duplicate event hash and requires review.",
            "warning",
            { ...eventContext, field: "eventHash" }
          );
        }
        seenEventHashes.add(rawEvent.eventHash);
      } else {
        summary.eventHashesValid = false;
        issue("event_hash_mismatch", "The event hash is malformed.", "error", {
          ...eventContext,
          field: "eventHash"
        });
      }

      const expectedPreviousHash =
        index === 0
          ? null
          : (safeEvents[index - 1]?.eventHash as unknown);
      if (rawEvent.previousEventHash !== expectedPreviousHash) {
        summary.previousHashesValid = false;
        issue(
          "event_previous_hash_mismatch",
          "The event previous hash does not match the preceding supplied event hash.",
          "error",
          { ...eventContext, field: "previousEventHash" }
        );
      }

      const readEventArray = (field: string, maximum: number): unknown[] | null =>
        readDenseArray(rawEvent[field], maximum, () => {
          summary.normalizationValid = false;
          issue(
            "event_normalization_mismatch",
            "An event array field is malformed, sparse, or exceeds its bound.",
            "error",
            { ...eventContext, field }
          );
        });

      const inputArtifactHashes = readEventArray("inputArtifactHashes", 64);
      const outputArtifactHashes = readEventArray("outputArtifactHashes", 64);
      const filesRead = readEventArray("filesRead", 128);
      const filesProposed = readEventArray("filesProposed", 128);
      const reasonCodes = readEventArray("reasonCodes", 64);
      let tokenUsage: AgentTokenUsage | undefined;
      let tokenUsageValid = true;
      if (Object.prototype.hasOwnProperty.call(rawEvent, "tokenUsage")) {
        const inspected = tokenUsageFromRaw(rawEvent.tokenUsage, issue, eventContext);
        if (inspected === null) {
          tokenUsageValid = false;
          summary.normalizationValid = false;
        } else {
          tokenUsage = inspected;
        }
      }

      const safeEvent: Record<string, unknown> = {
        eventVersion: rawEvent.eventVersion,
        eventId: rawEvent.eventId,
        runId: rawEvent.runId,
        sequence: rawEvent.sequence,
        actor: rawEvent.actor,
        action: rawEvent.action,
        startedAt: rawEvent.startedAt,
        finishedAt: rawEvent.finishedAt,
        durationMs: rawEvent.durationMs,
        inputArtifactHashes,
        outputArtifactHashes,
        filesRead,
        filesProposed,
        decision: rawEvent.decision,
        reasonCodes,
        ...(Object.prototype.hasOwnProperty.call(rawEvent, "tokenUsage")
          ? { tokenUsage }
          : {}),
        previousEventHash: rawEvent.previousEventHash,
        eventHash: rawEvent.eventHash
      };
      safeEvents.push(safeEvent);

      if (
        rawEvent.eventVersion !== AGENT_EVENT_LEDGER_VERSION ||
        inputArtifactHashes === null ||
        outputArtifactHashes === null ||
        filesRead === null ||
        filesProposed === null ||
        reasonCodes === null ||
        !tokenUsageValid
      ) {
        reconstructionCompleted = false;
        reconstructionAvailable = false;
        continue;
      }

      if (!reconstructionAvailable) {
        reconstructionCompleted = false;
        continue;
      }

      const draft: AgentEventDraft = {
        actor: rawEvent.actor as AgentRole,
        action: rawEvent.action as string,
        startedAt: rawEvent.startedAt as string,
        finishedAt: rawEvent.finishedAt as string,
        inputArtifactHashes: inputArtifactHashes as string[],
        outputArtifactHashes: outputArtifactHashes as string[],
        filesRead: filesRead as string[],
        filesProposed: filesProposed as string[],
        decision: rawEvent.decision as string | null,
        reasonCodes: reasonCodes as string[],
        ...(tokenUsage === undefined ? {} : { tokenUsage })
      };

      let expectedEvent: AgentEvent;
      try {
        const nextLedger = appendAgentEvent(reconstructedLedger, draft);
        expectedEvent = nextLedger.events[nextLedger.events.length - 1];
        reconstructedLedger = nextLedger;
      } catch {
        summary.normalizationValid = false;
        reconstructionCompleted = false;
        reconstructionAvailable = false;
        issue(
          "event_normalization_mismatch",
          "The event cannot be reconstructed under the W.1 contract.",
          "error",
          eventContext
        );
        continue;
      }

      try {
        if (
          canonicalizeJson(eventDraftMaterial(safeEvent)) !==
          canonicalizeJson(eventDraftMaterial(expectedEvent))
        ) {
          summary.normalizationValid = false;
          issue(
            "event_normalization_mismatch",
            "The supplied event is not in canonical W.1 normalized form.",
            "error",
            eventContext
          );
        }
      } catch {
        summary.normalizationValid = false;
        issue(
          "event_normalization_mismatch",
          "The supplied event material cannot be compared canonically.",
          "error",
          eventContext
        );
      }

      if (rawEvent.durationMs !== expectedEvent.durationMs) {
        issue(
          "event_duration_mismatch",
          "The event duration does not match its normalized timestamps.",
          "error",
          { ...eventContext, field: "durationMs" }
        );
      }
      if (rawEvent.previousEventHash !== expectedEvent.previousEventHash) {
        summary.previousHashesValid = false;
        if (
          !issues.some(
            (entry) =>
              entry.code === "event_previous_hash_mismatch" && entry.eventIndex === index
          )
        ) {
          issue(
            "event_previous_hash_mismatch",
            "The event previous hash does not match the reconstructed chain.",
            "error",
            { ...eventContext, field: "previousEventHash" }
          );
        }
      }
      if (rawEvent.eventHash !== expectedEvent.eventHash) {
        summary.eventHashesValid = false;
        if (
          !issues.some(
            (entry) => entry.code === "event_hash_mismatch" && entry.eventIndex === index
          )
        ) {
          issue(
            "event_hash_mismatch",
            "The event hash does not match the reconstructed event hash.",
            "error",
            { ...eventContext, field: "eventHash" }
          );
        }
      }

      const errorsAfterEvent = issues.filter((entry) => entry.severity === "error").length;
      const warningForEvent = issues.some(
        (entry) => entry.severity === "warning" && entry.eventIndex === index
      );
      if (
        errorsAfterEvent === errorsBeforeEvent &&
        !warningForEvent &&
        canonicalizeJson(safeEvent) === canonicalizeJson(expectedEvent)
      ) {
        summary.verifiedEventCount += 1;
      }
    }

    summary.boundedVerificationCompleted = true;

    if (
      reconstructionCompleted &&
      typeof rawLedger.rootHash === "string" &&
      HASH_PATTERN.test(rawLedger.rootHash)
    ) {
      const expectedRoot =
        rawEvents.length === 0
          ? computeEmptyLedgerRootHash(rawLedger.runId as string, rawLedger.objectiveHash as string)
          : reconstructedLedger.rootHash;
      if (rawLedger.rootHash === expectedRoot) {
        summary.rootHashValid = true;
      } else {
        issue(
          "ledger_root_hash_mismatch",
          "The ledger root hash does not match the reconstructed chain root.",
          "error",
          { field: "rootHash" }
        );
      }
    }

    if (reconstructionCompleted && safeEvents.length === rawEvents.length) {
      const safeLedger = {
        ledgerVersion: rawLedger.ledgerVersion,
        runId: rawLedger.runId,
        objectiveHash: rawLedger.objectiveHash,
        events: safeEvents,
        eventCount: rawLedger.eventCount,
        rootHash: rawLedger.rootHash
      };
      try {
        if (canonicalizeJson(safeLedger) !== canonicalizeJson(reconstructedLedger)) {
          issue(
            "reconstructed_ledger_mismatch",
            "The complete supplied ledger does not match the reconstructed ledger.",
            "error"
          );
        }
      } catch {
        issue(
          "reconstructed_ledger_mismatch",
          "The complete supplied ledger cannot be compared canonically.",
          "error"
        );
      }
    }

    summary.noUnknownFields = !issues.some((entry) =>
      [
        "unknown_ledger_field",
        "unknown_event_field",
        "ledger_symbol_property",
        "event_symbol_property"
      ].includes(entry.code)
    );
    summary.internallyConsistent =
      !internalProblem &&
      summary.ledgerVersionSupported &&
      summary.inputIsLedgerObject &&
      summary.eventCountMatches &&
      summary.sequencesValid &&
      summary.eventIdsValid &&
      summary.eventVersionsSupported &&
      summary.eventRunIdsConsistent &&
      summary.eventHashesValid &&
      summary.previousHashesValid &&
      summary.rootHashValid &&
      summary.normalizationValid &&
      summary.noUnknownFields &&
      summary.noDuplicateEventIds;
    return finish();
  } catch {
    issue(
      "verification_exception",
      "The ledger could not be inspected safely.",
      "error"
    );
    return finish();
  }
}
