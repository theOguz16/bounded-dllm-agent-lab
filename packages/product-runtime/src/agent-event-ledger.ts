import { createHash } from "node:crypto";

export const AGENT_EVENT_LEDGER_VERSION = "1" as const;

export type AgentRole =
  | "planner"
  | "coder"
  | "deterministic_verifier"
  | "masker"
  | "repairer"
  | "repair_verifier"
  | "patch_dry_run"
  | "temp_workspace_apply"
  | "execution_verifier"
  | "shadow_observer"
  | "deterministic_governor"
  | "admin_invocation_policy"
  | "admin_agent"
  | "approval_router";

export type AgentTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentEventDraft = {
  actor: AgentRole;
  action: string;
  startedAt: string;
  finishedAt: string;
  inputArtifactHashes: string[];
  outputArtifactHashes: string[];
  filesRead: string[];
  filesProposed: string[];
  decision: string | null;
  reasonCodes: string[];
  tokenUsage?: AgentTokenUsage;
};

export type AgentEvent = {
  eventVersion: "1";
  eventId: string;
  runId: string;
  sequence: number;
  actor: AgentRole;
  action: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputArtifactHashes: readonly string[];
  outputArtifactHashes: readonly string[];
  filesRead: readonly string[];
  filesProposed: readonly string[];
  decision: string | null;
  reasonCodes: readonly string[];
  tokenUsage?: Readonly<AgentTokenUsage>;
  previousEventHash: string | null;
  eventHash: string;
};

export type AgentEventLedger = {
  ledgerVersion: "1";
  runId: string;
  objectiveHash: string;
  events: readonly AgentEvent[];
  eventCount: number;
  rootHash: string;
};

const AGENT_ROLES = new Set<AgentRole>([
  "planner",
  "coder",
  "deterministic_verifier",
  "masker",
  "repairer",
  "repair_verifier",
  "patch_dry_run",
  "temp_workspace_apply",
  "execution_verifier",
  "shadow_observer",
  "deterministic_governor",
  "admin_invocation_policy",
  "admin_agent",
  "approval_router"
]);

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const MAX_EVENTS = 1000;

function unsupported(message: string): never {
  throw new TypeError(`Unsupported canonical JSON value: ${message}`);
}

function canonicalizeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        return unsupported("numbers must be finite");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return unsupported(`${typeof value} is not supported`);
  }

  if (ancestors.has(value)) {
    return unsupported("cyclic objects are not supported");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          return unsupported("sparse arrays are not supported");
        }
      }

      return `[${value.map((item) => canonicalizeValue(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported("only plain objects are supported");
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return unsupported("symbol object keys are not supported");
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          return unsupported("accessor properties are not supported");
        }
        return `${JSON.stringify(key)}:${canonicalizeValue(descriptor.value, ancestors)}`;
      });

    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, new WeakSet<object>());
}

export function hashCanonicalJson(value: unknown): string {
  const canonicalJson = canonicalizeJson(value);
  return `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}

function eventHashMaterial(event: Omit<AgentEvent, "eventHash">): Record<string, unknown> {
  return {
    eventVersion: event.eventVersion,
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    actor: event.actor,
    action: event.action,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    inputArtifactHashes: event.inputArtifactHashes,
    outputArtifactHashes: event.outputArtifactHashes,
    filesRead: event.filesRead,
    filesProposed: event.filesProposed,
    decision: event.decision,
    reasonCodes: event.reasonCodes,
    ...(event.tokenUsage === undefined ? {} : { tokenUsage: event.tokenUsage }),
    previousEventHash: event.previousEventHash
  };
}

export function computeAgentEventHash(
  event: Omit<AgentEvent, "eventHash">
): string {
  return hashCanonicalJson(eventHashMaterial(event));
}

export function computeEmptyLedgerRootHash(
  runId: string,
  objectiveHash: string
): string {
  return hashCanonicalJson({
    ledgerVersion: AGENT_EVENT_LEDGER_VERSION,
    runId,
    objectiveHash,
    events: []
  });
}

function assertIdentifier(value: unknown, name: string, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${name} must be a non-empty identifier of at most ${maximum} characters matching ${IDENTIFIER_PATTERN.source}.`
    );
  }
}

function assertHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(`${name} must match sha256:<64 lowercase hexadecimal characters>.`);
  }
}

function normalizeTimestamp(value: unknown, name: string): { iso: string; milliseconds: number } {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a valid ISO-8601 string.`);
  }

  const match = ISO_8601_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(`${name} must be a valid ISO-8601 date-time with a timezone.`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new TypeError(`${name} must be a valid ISO-8601 date-time.`);
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new TypeError(`${name} must contain a valid ISO-8601 timezone offset.`);
    }
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${name} must produce a finite timestamp.`);
  }

  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizeHashArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  if (value.length > 64) {
    throw new RangeError(`${name} must contain at most 64 entries.`);
  }

  for (const [index, hash] of value.entries()) {
    assertHash(hash, `${name}[${index}]`);
  }
  return [...new Set(value as string[])].sort();
}

function normalizeFileArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  if (value.length > 128) {
    throw new RangeError(`${name} must contain at most 128 entries.`);
  }

  for (const [index, file] of value.entries()) {
    if (
      typeof file !== "string" ||
      file.length === 0 ||
      file.length > 512 ||
      file.trim() !== file ||
      ASCII_CONTROL_PATTERN.test(file)
    ) {
      throw new TypeError(
        `${name}[${index}] must be a non-empty, bounded string without leading/trailing whitespace or ASCII control characters.`
      );
    }
  }
  return [...new Set(value as string[])].sort();
}

function normalizeDecision(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    ASCII_CONTROL_PATTERN.test(value)
  ) {
    throw new TypeError(
      "decision must be null or a non-empty string of at most 128 characters without leading/trailing whitespace or ASCII control characters."
    );
  }
  return value;
}

function normalizeReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("reasonCodes must be an array.");
  }
  if (value.length > 64) {
    throw new RangeError("reasonCodes must contain at most 64 entries.");
  }
  for (const [index, reasonCode] of value.entries()) {
    assertIdentifier(reasonCode, `reasonCodes[${index}]`, 128);
  }
  return [...new Set(value as string[])].sort();
}

function normalizeTokenUsage(value: unknown): AgentTokenUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("tokenUsage must be an object when present.");
  }

  const usage = value as Record<string, unknown>;
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
      throw new TypeError(`tokenUsage.${field} must be a non-negative safe integer.`);
    }
  }

  const inputTokens = usage.inputTokens as number;
  const outputTokens = usage.outputTokens as number;
  const totalTokens = usage.totalTokens as number;
  if (totalTokens !== inputTokens + outputTokens) {
    throw new TypeError("tokenUsage.totalTokens must equal inputTokens + outputTokens.");
  }
  return { inputTokens, outputTokens, totalTokens };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneAgentEvent(event: AgentEvent): AgentEvent {
  return {
    eventVersion: event.eventVersion,
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    actor: event.actor,
    action: event.action,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    inputArtifactHashes: [...event.inputArtifactHashes],
    outputArtifactHashes: [...event.outputArtifactHashes],
    filesRead: [...event.filesRead],
    filesProposed: [...event.filesProposed],
    decision: event.decision,
    reasonCodes: [...event.reasonCodes],
    ...(event.tokenUsage === undefined ? {} : { tokenUsage: { ...event.tokenUsage } }),
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash
  };
}

export function createAgentEventLedger(input: {
  runId: string;
  objectiveHash: string;
}): AgentEventLedger {
  assertIdentifier(input?.runId, "runId", 128);
  assertHash(input?.objectiveHash, "objectiveHash");

  const ledger: AgentEventLedger = {
    ledgerVersion: AGENT_EVENT_LEDGER_VERSION,
    runId: input.runId,
    objectiveHash: input.objectiveHash,
    events: [],
    eventCount: 0,
    rootHash: computeEmptyLedgerRootHash(input.runId, input.objectiveHash)
  };
  return deepFreeze(ledger) as AgentEventLedger;
}

export function appendAgentEvent(
  ledger: AgentEventLedger,
  draft: AgentEventDraft
): AgentEventLedger {
  if (ledger.events.length >= MAX_EVENTS) {
    throw new RangeError(`Agent event ledger cannot contain more than ${MAX_EVENTS} events.`);
  }
  if (!AGENT_ROLES.has(draft.actor)) {
    throw new TypeError(`actor must be one of: ${[...AGENT_ROLES].join(", ")}.`);
  }
  assertIdentifier(draft.action, "action", 128);

  const startedAt = normalizeTimestamp(draft.startedAt, "startedAt");
  const finishedAt = normalizeTimestamp(draft.finishedAt, "finishedAt");
  if (finishedAt.milliseconds < startedAt.milliseconds) {
    throw new TypeError("finishedAt must be equal to or after startedAt.");
  }

  const inputArtifactHashes = normalizeHashArray(
    draft.inputArtifactHashes,
    "inputArtifactHashes"
  );
  const outputArtifactHashes = normalizeHashArray(
    draft.outputArtifactHashes,
    "outputArtifactHashes"
  );
  const filesRead = normalizeFileArray(draft.filesRead, "filesRead");
  const filesProposed = normalizeFileArray(draft.filesProposed, "filesProposed");
  const decision = normalizeDecision(draft.decision);
  const reasonCodes = normalizeReasonCodes(draft.reasonCodes);
  const tokenUsage = normalizeTokenUsage(draft.tokenUsage);

  const previousEvent = ledger.events.at(-1);
  const sequence = previousEvent === undefined ? 1 : previousEvent.sequence + 1;
  const eventWithoutHash: Omit<AgentEvent, "eventHash"> = {
    eventVersion: AGENT_EVENT_LEDGER_VERSION,
    eventId: `${ledger.runId}:event:${String(sequence).padStart(6, "0")}`,
    runId: ledger.runId,
    sequence,
    actor: draft.actor,
    action: draft.action,
    startedAt: startedAt.iso,
    finishedAt: finishedAt.iso,
    durationMs: finishedAt.milliseconds - startedAt.milliseconds,
    inputArtifactHashes,
    outputArtifactHashes,
    filesRead,
    filesProposed,
    decision,
    reasonCodes,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    previousEventHash: previousEvent?.eventHash ?? null
  };
  const event: AgentEvent = {
    ...eventWithoutHash,
    eventHash: computeAgentEventHash(eventWithoutHash)
  };
  const events = [...ledger.events.map(cloneAgentEvent), event];
  const result: AgentEventLedger = {
    ledgerVersion: AGENT_EVENT_LEDGER_VERSION,
    runId: ledger.runId,
    objectiveHash: ledger.objectiveHash,
    events,
    eventCount: ledger.eventCount + 1,
    rootHash: event.eventHash
  };

  return deepFreeze(result) as AgentEventLedger;
}
