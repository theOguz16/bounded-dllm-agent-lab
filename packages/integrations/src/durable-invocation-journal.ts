import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One transactional authority for a provider invocation, never a retry queue. */
export const DURABLE_INVOCATION_JOURNAL_VERSION = "durable-invocation-journal/v2" as const;
export type InvocationState = "prepared" | "started" | "completed" | "failed" | "outcome_unknown";
export type InvocationStage = "discovery" | "planner" | "coder" | "repair" | "baseline";
export type InvocationIdentity = Readonly<{
  runId: string;
  stage: InvocationStage;
  task: string;
  model: string;
  deadlineAt: number;
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
}>;

export class InvocationJournalError extends Error {
  constructor(readonly code: "invocation_replay_forbidden" | "invocation_journal_unavailable", message: string) {
    super(message);
    this.name = "InvocationJournalError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STAGES: readonly InvocationStage[] = ["discovery", "planner", "coder", "repair", "baseline"];
const TERMINAL: readonly InvocationState[] = ["completed", "failed", "outcome_unknown"];
function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function safeCode(value: string | null): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/.test(value) ? value : null;
}
function assertIdentity(input: InvocationIdentity): void {
  if (!ID.test(input.runId) || !STAGES.includes(input.stage) || !MODEL.test(input.model) ||
    typeof input.task !== "string" || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) {
    throw new InvocationJournalError("invocation_journal_unavailable", "Invalid provider invocation identity.");
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
    reserve(input: InvocationIdentity): InvocationRecord {
      assertIdentity(input);
      const reservation = transaction((db) => {
        const key = keyOf(input);
        const current = get(db, key);
        if (current) {
          if (current.state === "prepared" || current.state === "started") {
            store(db, Object.freeze({ ...current, state: "outcome_unknown", terminalAt: now(),
              failureCode: "process_interrupted" }));
          }
          return null;
        }
        const record: InvocationRecord = Object.freeze({
          version: DURABLE_INVOCATION_JOURNAL_VERSION, invocationKey: key, runId: input.runId,
          stage: input.stage, taskHash: hash(input.task), model: input.model,
          state: "prepared", preparedAt: now(), startedAt: null, deadlineAt: input.deadlineAt,
          abortRequestedAt: null, workerExitedAt: null, exitSignal: null, terminalAt: null,
          sessionEvidence: "unknown", invocationOccurred: null, failureCode: null
        });
        const json = JSON.stringify(record);
        db.prepare("INSERT INTO provider_invocations (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)")
          .run(key, input.runId, input.stage, json, hash(json));
        return record;
      });
      if (reservation === null) throw new InvocationJournalError("invocation_replay_forbidden", "Provider invocation already reserved; no automatic replay.");
      return reservation;
    },
    start(key: string): InvocationRecord {
      return transition(key, ["prepared"], (row) => ({ ...row, state: "started", startedAt: now() }));
    },
    finish(key: string, state: "completed" | "failed" | "outcome_unknown", details: Readonly<{
      failureCode?: string | null;
      abortRequestedAt?: number | null;
      workerExitedAt?: number | null;
      exitSignal?: string | null;
      sessionEvidence?: InvocationRecord["sessionEvidence"];
    }> = {}): InvocationRecord {
      return transition(key, ["started"], (row) => ({ ...row, state, terminalAt: now(),
        failureCode: safeCode(details.failureCode ?? null),
        abortRequestedAt: details.abortRequestedAt ?? null,
        workerExitedAt: details.workerExitedAt ?? null,
        exitSignal: details.exitSignal ?? null,
        sessionEvidence: details.sessionEvidence ?? "unknown",
        invocationOccurred: state === "completed" ? true : null
      }));
    },
    recover(key: string): InvocationRecord {
      return transaction((db) => {
        const row = get(db, key);
        if (!row) throw new InvocationJournalError("invocation_journal_unavailable", "Missing invocation reservation is not evidence of no charge.");
        if (TERMINAL.includes(row.state)) return row;
        const unknown = Object.freeze({ ...row, state: "outcome_unknown" as const,
          terminalAt: now(), failureCode: "process_interrupted" });
        store(db, unknown);
        return unknown;
      });
    },
    read(key: string): InvocationRecord | null { return transaction((db) => get(db, key)); }
  });
}
