import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { createAgentOutputRedactor } from "./agent-output-redaction.js";

export const DURABLE_INVOCATION_JOURNAL_VERSION = "durable-invocation-journal/v1" as const;

export type InvocationState =
  | "prepared"
  | "started"
  | "completed"
  | "failed"
  | "outcome_unknown";

export type InvocationIdentity = Readonly<{
  runId: string;
  taskId: string;
  arm: string;
  stage: string;
  invocationId: string;
}>;

export type InvocationErrorDetail = Readonly<{
  code: string;
  message: string;
  retryable: boolean | null;
}>;

export type InvocationRecord = Readonly<{
  version: typeof DURABLE_INVOCATION_JOURNAL_VERSION;
  identity: InvocationIdentity;
  state: InvocationState;
  preparedAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  abortRequestedAt: string | null;
  exitedAt: string | null;
  terminalAt: string | null;
  sessionEvidence: "present" | "absent" | "unknown";
  invocationOccurred: boolean | null;
  error: InvocationErrorDetail | null;
  explicitRetryDecisionId: string | null;
  supersedesRunId: string | null;
}>;

export type InvocationJournal = Readonly<{
  prepare(identity: InvocationIdentity, options?: Readonly<{
    deadlineAt?: string | null;
    explicitRetryDecisionId?: string | null;
    supersedesRunId?: string | null;
  }>): InvocationRecord;
  start(identity: InvocationIdentity): InvocationRecord;
  complete(identity: InvocationIdentity, options?: Readonly<{
    exitedAt?: string | null;
    sessionEvidence?: InvocationRecord["sessionEvidence"];
  }>): InvocationRecord;
  fail(identity: InvocationIdentity, error: InvocationErrorDetail, options?: Readonly<{
    exitedAt?: string | null;
    sessionEvidence?: InvocationRecord["sessionEvidence"];
  }>): InvocationRecord;
  markOutcomeUnknown(identity: InvocationIdentity, options?: Readonly<{
    abortRequestedAt?: string | null;
    exitedAt?: string | null;
    error?: InvocationErrorDetail | null;
    sessionEvidence?: InvocationRecord["sessionEvidence"];
  }>): InvocationRecord;
  recover(identity: InvocationIdentity): InvocationRecord;
  read(identity: InvocationIdentity): InvocationRecord | null;
  canInvoke(identity: InvocationIdentity): boolean;
}>;

const terminalStates = new Set<InvocationState>(["completed", "failed", "outcome_unknown"]);
const redactor = createAgentOutputRedactor();

function assertPart(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${name} must be a non-empty string of at most 256 characters.`);
  }
}

function validateIdentity(identity: InvocationIdentity): void {
  assertPart("runId", identity.runId);
  assertPart("taskId", identity.taskId);
  assertPart("arm", identity.arm);
  assertPart("stage", identity.stage);
  assertPart("invocationId", identity.invocationId);
}

function key(identity: InvocationIdentity): string {
  validateIdentity(identity);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function sameIdentity(left: InvocationIdentity, right: InvocationIdentity): boolean {
  return key(left) === key(right);
}

function sanitizeError(error: InvocationErrorDetail | null | undefined): InvocationErrorDetail | null {
  if (error == null) return null;
  assertPart("error.code", error.code);
  return Object.freeze({
    code: error.code,
    message: redactor.redactText(String(error.message)).slice(0, 4_096),
    retryable: typeof error.retryable === "boolean" ? error.retryable : null
  });
}

function durableWrite(path: string, record: InvocationRecord, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, exclusive ? "wx" : "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function createDurableInvocationJournal(options: Readonly<{
  directory: string;
  now?: () => Date;
}>): InvocationJournal {
  if (!options.directory) throw new TypeError("Invocation journal directory is required.");
  const now = options.now ?? (() => new Date());
  const pathFor = (identity: InvocationIdentity): string => join(options.directory, `${key(identity)}.json`);

  const read = (identity: InvocationIdentity): InvocationRecord | null => {
    const path = pathFor(identity);
    if (!existsSync(path)) return null;
    const record = JSON.parse(readFileSync(path, "utf8")) as InvocationRecord;
    if (record.version !== DURABLE_INVOCATION_JOURNAL_VERSION || !sameIdentity(record.identity, identity)) {
      throw new Error("Invocation journal record identity or version mismatch.");
    }
    return Object.freeze(record);
  };

  const replace = (identity: InvocationIdentity, mutate: (record: InvocationRecord) => InvocationRecord): InvocationRecord => {
    const current = read(identity);
    if (current === null) throw new Error("Invocation must be prepared before transition.");
    const next = mutate(current);
    durableWrite(pathFor(identity), next);
    return Object.freeze(next);
  };

  const prepare: InvocationJournal["prepare"] = (identity, prepareOptions = {}) => {
    const existing = read(identity);
    if (existing !== null) return existing;
    if (prepareOptions.supersedesRunId !== undefined && prepareOptions.supersedesRunId !== null) {
      assertPart("supersedesRunId", prepareOptions.supersedesRunId);
      if (prepareOptions.supersedesRunId === identity.runId || !prepareOptions.explicitRetryDecisionId) {
        throw new Error("A retry requires an explicit decision and a new runId.");
      }
    }
    const preparedAt = now().toISOString();
    const record: InvocationRecord = Object.freeze({
      version: DURABLE_INVOCATION_JOURNAL_VERSION,
      identity: Object.freeze({ ...identity }),
      state: "prepared",
      preparedAt,
      startedAt: null,
      deadlineAt: prepareOptions.deadlineAt ?? null,
      abortRequestedAt: null,
      exitedAt: null,
      terminalAt: null,
      sessionEvidence: "unknown",
      invocationOccurred: null,
      error: null,
      explicitRetryDecisionId: prepareOptions.explicitRetryDecisionId ?? null,
      supersedesRunId: prepareOptions.supersedesRunId ?? null
    });
    durableWrite(pathFor(identity), record, true);
    return record;
  };

  return Object.freeze({
    prepare,
    start(identity) {
      return replace(identity, (record) => {
        if (record.state !== "prepared") throw new Error(`Cannot start invocation from ${record.state}.`);
        return { ...record, state: "started", startedAt: now().toISOString(), invocationOccurred: true };
      });
    },
    complete(identity, completeOptions = {}) {
      return replace(identity, (record) => {
        if (record.state !== "started") throw new Error(`Cannot complete invocation from ${record.state}.`);
        const terminalAt = now().toISOString();
        return { ...record, state: "completed", exitedAt: completeOptions.exitedAt ?? terminalAt,
          terminalAt, sessionEvidence: completeOptions.sessionEvidence ?? record.sessionEvidence };
      });
    },
    fail(identity, error, failOptions = {}) {
      return replace(identity, (record) => {
        if (record.state !== "started") throw new Error(`Cannot fail invocation from ${record.state}.`);
        const terminalAt = now().toISOString();
        return { ...record, state: "failed", exitedAt: failOptions.exitedAt ?? terminalAt,
          terminalAt, sessionEvidence: failOptions.sessionEvidence ?? record.sessionEvidence,
          error: sanitizeError(error) };
      });
    },
    markOutcomeUnknown(identity, unknownOptions = {}) {
      return replace(identity, (record) => {
        if (terminalStates.has(record.state)) return record;
        const terminalAt = now().toISOString();
        return { ...record, state: "outcome_unknown", abortRequestedAt: unknownOptions.abortRequestedAt ?? record.abortRequestedAt,
          exitedAt: unknownOptions.exitedAt ?? record.exitedAt, terminalAt,
          sessionEvidence: unknownOptions.sessionEvidence ?? record.sessionEvidence,
          error: sanitizeError(unknownOptions.error) };
      });
    },
    recover(identity) {
      const record = read(identity);
      if (record === null) throw new Error("Missing journal record is not evidence that no invocation occurred.");
      if (terminalStates.has(record.state)) return record;
      return this.markOutcomeUnknown(identity, {
        error: { code: "process_interrupted", message: "Process ended before a durable terminal outcome was recorded.", retryable: false }
      });
    },
    read,
    canInvoke(identity) {
      return read(identity) === null;
    }
  });
}
