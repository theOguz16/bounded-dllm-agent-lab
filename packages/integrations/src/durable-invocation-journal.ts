import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentOutputRedactor } from "./agent-output-redaction.js";
import type { AgentProviderFailureClass, AgentWorkerOutcome } from "./agent-adapter.js";

/** One transactional authority for a provider invocation, never a retry queue. */
export const DURABLE_INVOCATION_JOURNAL_VERSION = "durable-invocation-journal/v3" as const;
export type InvocationState = "prepared" | "started" | "completed" | "failed" | "outcome_unknown";
export type InvocationStage = "discovery" | "planner" | "coder" | "repair" | "baseline";
export type InvocationRetryDecision = Readonly<{
  decisionId: string;
  supersedesRunId: string;
  newRunId: string;
  stage: InvocationStage;
  taskHash: string;
  model: string;
}>;
export type InvocationCrashRecoveryAuthority = Readonly<{
  invocationKey: string;
  recoveryId: string;
  ownerPid: number;
}>;
export type InvocationIdentity = Readonly<{
  runId: string;
  stage: InvocationStage;
  task: string;
  model: string;
  deadlineAt: number;
  retryDecision?: InvocationRetryDecision;
}>;
export type InvocationRecord = Readonly<{
  version: typeof DURABLE_INVOCATION_JOURNAL_VERSION;
  invocationKey: string;
  runId: string;
  stage: InvocationStage;
  taskHash: string;
  model: string;
  state: InvocationState;
  preparedAt: number;
  startedAt: number | null;
  deadlineAt: number;
  abortRequestedAt: number | null;
  workerExitedAt: number | null;
  exitSignal: string | null;
  terminalAt: number | null;
  sessionEvidence: "unknown" | "present" | "absent";
  invocationOccurred: boolean | null;
  failureCode: string | null;
  failureDetail: string | null;
  providerFailureClass?: AgentProviderFailureClass;
  providerHttpStatus?: number | null;
  workerOutcome?: AgentWorkerOutcome;
  workerExitCode?: number | null;
  terminalTurnObserved?: boolean | null;
  retryDecisionId: string | null;
  supersedesRunId: string | null;
  recoveryId?: string;
  ownerPid?: number;
  workerDiagnostic?: Readonly<Record<string, unknown>> | null;
}>;

export class InvocationJournalError extends Error {
  constructor(readonly code: "invocation_replay_forbidden" | "invocation_journal_unavailable" |
    "invocation_journal_inside_source_repository", message: string) {
    super(message);
    this.name = "InvocationJournalError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const STAGES: readonly InvocationStage[] = ["discovery", "planner", "coder", "repair", "baseline"];
const TERMINAL: readonly InvocationState[] = ["completed", "failed", "outcome_unknown"];
const SAFE_DIAGNOSTIC_CODES = new Set([
  "agent_command_budget_exceeded", "agent_event_budget_exceeded",
  "agent_model_call_budget_exceeded", "agent_output_limit", "agent_protocol_invalid",
  "agent_provider_call_budget_exceeded", "agent_repair_budget_exceeded", "agent_timeout",
  "authentication_failed", "codex_aborted", "codex_command_timing_partial",
  "codex_command_timing_unavailable", "codex_event_ignored", "codex_item_ignored",
  "codex_item_pending_details", "codex_partial_stream", "codex_provider_message_redacted",
  "codex_usage_unavailable", "invocation_journal_unavailable", "invocation_replay_forbidden",
  "provider_outcome_ambiguous", "provider_overloaded", "provider_stream_error_unknown",
  "usage_limit_exceeded", "worker_termination_failed"
]);
const SAFE_FAILURE_CODES = new Set([...SAFE_DIAGNOSTIC_CODES, "process_interrupted"]);
function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function safeCode(value: string | null): string | null {
  return typeof value === "string" && SAFE_FAILURE_CODES.has(value) ? value : null;
}
function safeDiagnosticCodes(values: readonly string[] | undefined): string | null {
  if (!values) return null;
  const codes = [...new Set(values.filter((value) => SAFE_DIAGNOSTIC_CODES.has(value)))].slice(0, 32);
  return codes.length === 0 ? null : codes.join(";");
}
function ownerStillAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function safeWorkerDiagnostic(value: Readonly<Record<string, unknown>> | null | undefined):
  Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  const fallback = { version: "worker-failure-diagnostic/v1", serializationTruncated: true };
  const eventTypes = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed",
    "error", "item.started", "item.updated", "item.completed"]);
  const parserStatuses = new Set(["completed", "failed", "partial", "aborted", "agent_protocol_invalid"]);
  const formats = new Set(["empty", "unstructured", "worker_error_envelope"]);
  const errorNames = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError"]);
  const nonnegative = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0;
  const pathField = (entry: unknown) => typeof entry === "string" && isAbsolute(entry) &&
    entry.length <= 256 && !/[\r\n\0]/.test(entry);
  if (value.version !== "worker-failure-diagnostic/v1" || !pathField(value.executable) ||
      !pathField(value.cwd) || !Array.isArray(value.args) || value.args.length > 4 ||
      !value.args.every(pathField) || typeof value.argsTruncated !== "boolean" ||
      !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
      !(value.exitSignal === null || typeof value.exitSignal === "string" && /^SIG[A-Z0-9]+$/.test(value.exitSignal)) ||
      typeof value.stdoutEmpty !== "boolean" || typeof value.stderrEmpty !== "boolean" ||
      !["", "[UNSAFE_STDERR_CONTENT_OMITTED]"].includes(value.stderrExcerpt as string) ||
      !formats.has(value.stderrFormat as string) ||
      !(value.workerErrorName === null || errorNames.has(value.workerErrorName as string)) ||
      !(value.workerErrorStatus === null || Number.isSafeInteger(value.workerErrorStatus) &&
        (value.workerErrorStatus as number) >= 100 && (value.workerErrorStatus as number) <= 599) ||
      typeof value.stderrTruncated !== "boolean" || !nonnegative(value.stdoutLineCount) ||
      !nonnegative(value.recognizedEventCount) || !nonnegative(value.unknownEventCount) ||
      !Array.isArray(value.eventTypes) || !value.eventTypes.every((entry) => eventTypes.has(entry)) ||
      typeof value.threadStarted !== "boolean" || typeof value.turnStarted !== "boolean" ||
      typeof value.turnCompleted !== "boolean" || typeof value.turnFailed !== "boolean" ||
      typeof value.errorEvent !== "boolean" || !nonnegative(value.malformedLineCount) ||
      !(value.lastRecognizedEventType === null || eventTypes.has(value.lastRecognizedEventType as string)) ||
      !parserStatuses.has(value.parserStatus as string) ||
      typeof value.terminalTurnObserved !== "boolean" ||
      typeof value.serializationTruncated !== "boolean") return fallback;
  const fields = ["version", "executable", "args", "argsTruncated", "cwd", "exitCode", "exitSignal",
    "stdoutEmpty", "stderrEmpty", "stderrExcerpt", "stderrFormat", "workerErrorName",
    "workerErrorStatus", "stderrTruncated", "stdoutLineCount", "recognizedEventCount",
    "unknownEventCount", "eventTypes", "threadStarted", "turnStarted", "turnCompleted",
    "turnFailed", "errorEvent", "malformedLineCount", "lastRecognizedEventType",
    "parserStatus", "terminalTurnObserved", "serializationTruncated"];
  const selected = Object.fromEntries(fields.map((field) => [field, value[field]]));
  const sanitized = createAgentOutputRedactor().redactValue(selected) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(sanitized)) <= 4_096 ? sanitized : fallback;
}
function assertIdentity(input: InvocationIdentity): void {
  if (!ID.test(input.runId) || !STAGES.includes(input.stage) || !MODEL.test(input.model) ||
    typeof input.task !== "string" || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) {
    throw new InvocationJournalError("invocation_journal_unavailable", "Invalid provider invocation identity.");
  }
  if (input.retryDecision !== undefined &&
      (!ID.test(input.retryDecision.decisionId) || !ID.test(input.retryDecision.supersedesRunId) ||
       !ID.test(input.retryDecision.newRunId) || !HASH.test(input.retryDecision.taskHash) ||
       !STAGES.includes(input.retryDecision.stage) || !MODEL.test(input.retryDecision.model) ||
       input.retryDecision.supersedesRunId === input.runId ||
       input.retryDecision.newRunId !== input.runId ||
       input.retryDecision.stage !== input.stage ||
       input.retryDecision.model !== input.model ||
       input.retryDecision.taskHash !== hash(input.task))) {
    throw new InvocationJournalError("invocation_replay_forbidden", "Invalid explicit invocation retry decision.");
  }
}
function keyOf(input: Pick<InvocationIdentity, "runId" | "stage">): string {
  return hash(JSON.stringify([input.runId, input.stage]));
}
function checkedRow(row: unknown, expectedKey: string): InvocationRecord {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("Invalid journal row.");
  const value = row as { record_json?: unknown; record_hash?: unknown };
  if (typeof value.record_json !== "string" || typeof value.record_hash !== "string" ||
      hash(value.record_json) !== value.record_hash) throw Error("Journal record integrity mismatch.");
  const record: unknown = JSON.parse(value.record_json);
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      (record as InvocationRecord).version !== DURABLE_INVOCATION_JOURNAL_VERSION ||
      (record as InvocationRecord).invocationKey !== expectedKey ||
      !["prepared", "started", ...TERMINAL].includes((record as InvocationRecord).state)) {
    throw Error("Journal record version or identity mismatch.");
  }
  return Object.freeze(record as InvocationRecord);
}

export function createDurableInvocationJournal(file: string, now: () => number = Date.now) {
  if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0")) {
    throw new InvocationJournalError("invocation_journal_unavailable", "Journal path must be absolute.");
  }
  const path = resolve(file);
  const parent = dirname(path);
  const ownedReservations = new Set<string>();
  const openDatabase = (): DatabaseSync => {
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // Never follow a symlink at the database path. The directory is resolved once.
      realpathSync(parent);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe journal file.");
      }
      const db = new DatabaseSync(path);
      try {
        chmodSync(path, 0o600);
        db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        db.exec(`CREATE TABLE IF NOT EXISTS provider_invocations (
          invocation_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          UNIQUE(run_id, stage)
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS invocation_retry_authorizations (
          decision_id TEXT PRIMARY KEY,
          supersedes_run_id TEXT NOT NULL,
          new_run_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          task_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          consumed_at INTEGER,
          UNIQUE(supersedes_run_id, stage)
        )`);
      } catch (error) { db.close(); throw error; }
      return db;
    } catch {
      throw new InvocationJournalError("invocation_journal_unavailable", "Durable provider journal could not be opened.");
    }
  };
  const transaction = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = openDatabase();
    try {
      db.exec("BEGIN IMMEDIATE");
      try { const value = fn(db); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError("invocation_journal_unavailable", "Durable provider journal transaction failed.");
    } finally { db.close(); }
  };
  const get = (db: DatabaseSync, key: string): InvocationRecord | null => {
    const row = db.prepare("SELECT record_json, record_hash FROM provider_invocations WHERE invocation_key = ?").get(key);
    return row ? checkedRow(row, key) : null;
  };
  const store = (db: DatabaseSync, record: InvocationRecord): void => {
    const json = JSON.stringify(record);
    const outcome = db.prepare("UPDATE provider_invocations SET record_json = ?, record_hash = ? WHERE invocation_key = ?")
      .run(json, hash(json), record.invocationKey);
    if (outcome.changes !== 1) throw Error("Journal update lost its reservation.");
  };
  const transition = (key: string, expected: readonly InvocationState[], mutate: (row: InvocationRecord) => InvocationRecord): InvocationRecord =>
    transaction((db) => {
      const row = get(db, key);
      if (!row || !expected.includes(row.state)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Provider invocation cannot transition or be replayed.");
      const next = Object.freeze(mutate(row));
      store(db, next);
      return next;
    });
  return Object.freeze({
    authorizeRetry(decision: InvocationRetryDecision): void {
      if (!ID.test(decision.decisionId) || !ID.test(decision.supersedesRunId) ||
          !ID.test(decision.newRunId) || decision.newRunId === decision.supersedesRunId ||
          !STAGES.includes(decision.stage) || !HASH.test(decision.taskHash) ||
          !MODEL.test(decision.model)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Invalid explicit retry authorization.");
      transaction((db) => {
        const prior = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE run_id = ? AND stage = ?")
          .get(decision.supersedesRunId, decision.stage) as { invocation_key: string } | undefined;
        const record = prior ? checkedRow(prior, prior.invocation_key) : null;
        if (!record || record.state !== "outcome_unknown" ||
            record.taskHash !== decision.taskHash || record.model !== decision.model) {
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Retry authorization must match a persisted ambiguous invocation.");
        }
        const inserted = db.prepare(`INSERT OR IGNORE INTO invocation_retry_authorizations
          (decision_id, supersedes_run_id, new_run_id, stage, task_hash, model, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
          decision.decisionId, decision.supersedesRunId, decision.newRunId,
          decision.stage, decision.taskHash, decision.model);
        if (inserted.changes !== 1) throw new InvocationJournalError(
          "invocation_replay_forbidden", "Retry authorization already exists.");
      });
    },
    reserve(input: InvocationIdentity): InvocationRecord {
      assertIdentity(input);
      const reservation = transaction((db) => {
        const key = keyOf(input);
        const taskHash = hash(input.task);
        const current = get(db, key);
        if (current) {
          // A losing claimant never owns this reservation and must not change it.
          // Interrupted attempts are made terminal only by explicit recovery.
          return null;
        }
        const prior = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE stage = ?")
          .all(input.stage)
          .map((row) => checkedRow(row, (row as { invocation_key: string }).invocation_key))
          .filter((record) => record.taskHash === taskHash && record.runId !== input.runId);
        if (prior.length > 0) {
          const decision = input.retryDecision;
          const matched = decision && prior.find((record) =>
            record.runId === decision.supersedesRunId && record.state === "outcome_unknown" &&
            record.model === decision.model && record.taskHash === decision.taskHash);
          const authorization = decision ? db.prepare(`SELECT * FROM invocation_retry_authorizations
            WHERE decision_id = ?`).get(decision.decisionId) as Record<string, unknown> | undefined : null;
          if (!matched || !authorization || authorization.consumed_at !== null ||
              authorization.supersedes_run_id !== decision.supersedesRunId ||
              authorization.new_run_id !== input.runId || authorization.stage !== input.stage ||
              authorization.task_hash !== taskHash || authorization.model !== input.model) {
            throw new InvocationJournalError(
              "invocation_replay_forbidden",
              "A new run requires an unused explicit authorization bound to the ambiguous prior invocation."
            );
          }
        } else if (input.retryDecision !== undefined) {
          throw new InvocationJournalError(
            "invocation_replay_forbidden",
            "Explicit retry decision does not identify a persisted prior invocation."
          );
        }
        const record: InvocationRecord = Object.freeze({
          version: DURABLE_INVOCATION_JOURNAL_VERSION, invocationKey: key, runId: input.runId,
          stage: input.stage, taskHash: hash(input.task), model: input.model,
          state: "prepared", preparedAt: now(), startedAt: null, deadlineAt: input.deadlineAt,
          abortRequestedAt: null, workerExitedAt: null, exitSignal: null, terminalAt: null,
          sessionEvidence: "unknown", invocationOccurred: null, failureCode: null,
          failureDetail: null,
          retryDecisionId: input.retryDecision?.decisionId ?? null,
          supersedesRunId: input.retryDecision?.supersedesRunId ?? null,
          recoveryId: randomUUID(), ownerPid: process.pid
        });
        const json = JSON.stringify(record);
        db.prepare("INSERT INTO provider_invocations (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)")
          .run(key, input.runId, input.stage, json, hash(json));
        if (input.retryDecision) db.prepare(`UPDATE invocation_retry_authorizations
          SET consumed_at = ? WHERE decision_id = ? AND consumed_at IS NULL`)
          .run(now(), input.retryDecision.decisionId);
        return record;
      });
      if (reservation === null) throw new InvocationJournalError("invocation_replay_forbidden", "Provider invocation already reserved; no automatic replay.");
      ownedReservations.add(reservation.invocationKey);
      return reservation;
    },
    start(key: string): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      return transition(key, ["prepared"], (row) => ({ ...row, state: "started", startedAt: now() }));
    },
    finish(key: string, state: "completed" | "failed" | "outcome_unknown", details: Readonly<{
      failureCode?: string | null;
      diagnosticCodes?: readonly string[];
      abortRequestedAt?: number | null;
      workerExitedAt?: number | null;
      exitSignal?: string | null;
      sessionEvidence?: InvocationRecord["sessionEvidence"];
      providerFailureClass?: AgentProviderFailureClass;
      providerHttpStatus?: number | null;
      workerOutcome?: AgentWorkerOutcome;
      workerExitCode?: number | null;
      terminalTurnObserved?: boolean | null;
      workerDiagnostic?: Readonly<Record<string, unknown>> | null;
    }> = {}): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      const finished = transition(key, ["started"], (row) => ({ ...row, state, terminalAt: now(),
        failureCode: safeCode(details.failureCode ?? null),
        failureDetail: safeDiagnosticCodes(details.diagnosticCodes),
        abortRequestedAt: details.abortRequestedAt ?? null,
        workerExitedAt: details.workerExitedAt ?? null,
        exitSignal: details.exitSignal ?? null,
        sessionEvidence: details.sessionEvidence ?? "unknown",
        providerFailureClass: details.providerFailureClass ?? "unknown",
        providerHttpStatus: details.providerHttpStatus ?? null,
        workerOutcome: details.workerOutcome ?? "unknown",
        workerExitCode: details.workerExitCode ?? null,
        terminalTurnObserved: details.terminalTurnObserved ?? null,
        invocationOccurred: state === "completed" ? true : null,
        ...(details.workerDiagnostic === undefined ? {} :
          { workerDiagnostic: safeWorkerDiagnostic(details.workerDiagnostic) })
      }));
      ownedReservations.delete(key);
      return finished;
    },
    recover(key: string): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      const recovered = transaction((db) => {
        const row = get(db, key);
        if (!row) throw new InvocationJournalError("invocation_journal_unavailable", "Missing invocation reservation is not evidence of no charge.");
        if (TERMINAL.includes(row.state)) throw new InvocationJournalError(
          "invocation_replay_forbidden", "Terminal invocation cannot be recovered again.");
        const unknown = Object.freeze({ ...row, state: "outcome_unknown" as const,
          terminalAt: now(), failureCode: "process_interrupted" });
        store(db, unknown);
        return unknown;
      });
      ownedReservations.delete(key);
      return recovered;
    },
    recoverCrashed(authority: InvocationCrashRecoveryAuthority): InvocationRecord {
      if (!authority || typeof authority !== "object" || !HASH.test(authority.invocationKey) ||
          !ID.test(authority.recoveryId) || !Number.isSafeInteger(authority.ownerPid) ||
          authority.ownerPid <= 0) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Invalid crash-recovery authority.");
      return transaction((db) => {
        const row = get(db, authority.invocationKey);
        if (!row || TERMINAL.includes(row.state) || row.recoveryId !== authority.recoveryId ||
            row.ownerPid !== authority.ownerPid || ownerStillAlive(authority.ownerPid)) {
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Crash recovery requires the matching claim and a terminated owner process.");
        }
        const unknown = Object.freeze({ ...row, state: "outcome_unknown" as const,
          terminalAt: now(), failureCode: "process_interrupted" });
        store(db, unknown);
        return unknown;
      });
    },
    read(key: string): InvocationRecord | null { return transaction((db) => get(db, key)); }
  });
}
