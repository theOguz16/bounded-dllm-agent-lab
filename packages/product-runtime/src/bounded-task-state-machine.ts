import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashCanonicalJson } from "./agent-event-ledger.js";

export const BOUNDED_TASK_STATE_SCHEMA_VERSION = "2" as const;
export const BOUNDED_TASK_INPUT_VERSION = "canonical-task-input/v1" as const;
export const BOUNDED_TASK_STATE_MAX_BYTES = 1024 * 1024;
export const BOUNDED_TASK_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const NONCE = /^[0-9a-f]{48}$/;

export type BoundedTaskStateName = "received" | "planning_started" | "planning_completed" |
  "context_authorized" | "coding_started" | "coding_completed" | "mutation_verified" |
  "governed_apply_prepared" | "governed_apply_started" | "x4_committed" |
  "validation_started" | "validation_completed" | "finalized" | "failed" |
  "replan_required" | "human_review_required" | "recovery_required";
export type BoundedTaskArtifactReference = Readonly<{ name: string; relativePath: string;
  contentHash: string; byteLength: number }>;
export type DurableProviderIntent = Readonly<{ providerKind: string; requestHash: string;
  providerIdempotencyKey: string; attempt: number; status: "prepared" | "started" | "completed";
  responseHash: string | null }>;
export type DurableLeaseOwnerBinding = Readonly<{ runId: string; ownerNonceHash: string;
  pid: number; processIdentityHash: string; acquiredAt: string; heartbeatAt: string }>;
export type DurableBoundedTaskState = Readonly<{
  schemaVersion: "2"; taskInputVersion: typeof BOUNDED_TASK_INPUT_VERSION;
  taskInputHash: string; taskId: string; runId: string; idempotencyKey: string;
  currentState: BoundedTaskStateName; transitionSequence: number;
  attempts: readonly Readonly<{ runId: string; startedAt: string; resume: boolean }>[];
  repositoryIdentityHash: string; baselineSnapshotHash: string; baselineHeadHash: string;
  compiledPolicyHash: string; planHash: string | null; contextEvidenceHash: string | null;
  providerRequestHash: string | null; providerResponseHash: string | null;
  mutationArtifactHash: string | null; verifiedMutationHash: string | null;
  x4Reference: BoundedTaskArtifactReference | null; x5IntentReference: BoundedTaskArtifactReference | null;
  x5ReceiptReference: BoundedTaskArtifactReference | null; terminalResultReference: BoundedTaskArtifactReference | null;
  terminalResultHash: string | null; artifacts: Readonly<Record<string, BoundedTaskArtifactReference>>;
  leaseOwner: DurableLeaseOwnerBinding; providerIntent: DurableProviderIntent | null;
  createdAt: string; updatedAt: string; previousStateHash: string | null; stateHash: string;
}>;
export type DurableBoundedTaskConfiguration = Readonly<{ registryRoot: string;
  idempotencyKey: string; resume?: boolean; leaseTimeoutMs?: number;
  providerIdempotencySupport?: Readonly<Record<string, boolean>>;
  onCheckpoint?: (state: DurableBoundedTaskState) => void;
  onProviderCheckpoint?: (event: Readonly<{ providerKind: string;
    phase: "prepared" | "started" | "response_received" | "completed";
    providerIdempotencyKey: string; attempt: number }>) => void }>;

type LeaseOwnerRecord = Readonly<{ leaseVersion: "1"; runId: string; ownerNonce: string;
  pid: number; processIdentityHash: string; acquiredAt: string; heartbeatAt: string }>;
const ORDER: readonly BoundedTaskStateName[] = ["received", "planning_started", "planning_completed",
  "context_authorized", "coding_started", "coding_completed", "mutation_verified",
  "governed_apply_prepared", "governed_apply_started", "x4_committed", "validation_started",
  "validation_completed", "finalized"];
const TERMINAL = new Set<BoundedTaskStateName>(["finalized", "failed", "replan_required",
  "human_review_required", "recovery_required"]);

export class BoundedTaskStateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BoundedTaskStateError"; }
}
function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BoundedTaskStateError("bounded_task_state_not_serializable", "Durable number is invalid.");
    return value;
  }
  if (typeof value !== "object") throw new BoundedTaskStateError("bounded_task_state_not_serializable", "Durable value is invalid.");
  if (seen.has(value)) throw new BoundedTaskStateError("bounded_task_state_not_serializable", "Cyclic durable value is invalid.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new BoundedTaskStateError(
      "bounded_task_state_not_serializable", "Exotic durable object is invalid.");
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) =>
      [key, canonicalValue((value as Record<string, unknown>)[key], seen)]));
  } finally { seen.delete(value); }
}
function canonicalBytes(value: unknown): Buffer {
  const text = JSON.stringify(canonicalValue(value));
  if (typeof text !== "string") throw new BoundedTaskStateError("bounded_task_state_not_serializable", "Durable value is invalid.");
  return Buffer.from(text, "utf8");
}
function ensurePrivateDirectory(directory: string): string {
  const resolved = path.resolve(directory); fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundedTaskStateError(
    "bounded_task_state_registry_unsafe", "Durable registry root is unsafe.");
  fs.chmodSync(resolved, 0o700); return fs.realpathSync(resolved);
}
function syncDir(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file: string, bytes: Buffer): void {
  const temp = `${file}.tmp-${randomBytes(12).toString("hex")}`; const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); fs.chmodSync(file, 0o600); syncDir(path.dirname(file));
}
function isIso(value: unknown): value is string { return typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function nullableHash(value: unknown): boolean { return value === null || typeof value === "string" && HASH.test(value); }
function validRef(value: unknown): value is BoundedTaskArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as BoundedTaskArtifactReference;
  return /^[a-z0-9][a-z0-9._-]{0,95}$/.test(ref.name) &&
    /^artifacts\/[a-z0-9][a-z0-9._-]{0,95}-[0-9a-f]{16}\.json$/.test(ref.relativePath) &&
    HASH.test(ref.contentHash) && Number.isSafeInteger(ref.byteLength) && ref.byteLength >= 0 &&
    ref.byteLength <= BOUNDED_TASK_ARTIFACT_MAX_BYTES;
}
function validLeaseBinding(value: unknown): value is DurableLeaseOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as DurableLeaseOwnerBinding;
  return ID.test(owner.runId) && HASH.test(owner.ownerNonceHash) && Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 && HASH.test(owner.processIdentityHash) && isIso(owner.acquiredAt) && isIso(owner.heartbeatAt);
}
function validProviderIntent(value: unknown): value is DurableProviderIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as DurableProviderIntent;
  return ID.test(intent.providerKind) && HASH.test(intent.requestHash) &&
    HASH.test(intent.providerIdempotencyKey) && Number.isSafeInteger(intent.attempt) && intent.attempt > 0 &&
    ["prepared", "started", "completed"].includes(intent.status) && nullableHash(intent.responseHash) &&
    (intent.status === "completed" ? typeof intent.responseHash === "string" : intent.responseHash === null);
}
function validateState(value: unknown): DurableBoundedTaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundedTaskStateError(
    "bounded_task_state_corrupt", "Durable task state is corrupt.");
  const state = value as DurableBoundedTaskState;
  const refs = [state.x4Reference, state.x5IntentReference, state.x5ReceiptReference, state.terminalResultReference];
  const artifactsValid = state.artifacts && typeof state.artifacts === "object" && !Array.isArray(state.artifacts) &&
    Object.entries(state.artifacts).every(([name, ref]) => name === ref.name && validRef(ref));
  const attemptsValid = Array.isArray(state.attempts) && state.attempts.length > 0 && state.attempts.length <= 10_000 &&
    state.attempts.every((attempt) => attempt && ID.test(attempt.runId) && isIso(attempt.startedAt) &&
      typeof attempt.resume === "boolean");
  if (state.schemaVersion !== BOUNDED_TASK_STATE_SCHEMA_VERSION ||
      state.taskInputVersion !== BOUNDED_TASK_INPUT_VERSION || !HASH.test(state.taskInputHash) ||
      !ID.test(state.taskId) || !ID.test(state.idempotencyKey) || !ID.test(state.runId) ||
      !ORDER.includes(state.currentState) && !TERMINAL.has(state.currentState) ||
      !Number.isSafeInteger(state.transitionSequence) || state.transitionSequence < 0 || !attemptsValid ||
      !HASH.test(state.repositoryIdentityHash) || !HASH.test(state.baselineSnapshotHash) ||
      !HASH.test(state.baselineHeadHash) || !HASH.test(state.compiledPolicyHash) ||
      !nullableHash(state.planHash) || !nullableHash(state.contextEvidenceHash) ||
      !nullableHash(state.providerRequestHash) || !nullableHash(state.providerResponseHash) ||
      !nullableHash(state.mutationArtifactHash) || !nullableHash(state.verifiedMutationHash) ||
      !nullableHash(state.terminalResultHash) || refs.some((ref) => ref !== null && !validRef(ref)) ||
      !artifactsValid || !validLeaseBinding(state.leaseOwner) ||
      state.providerIntent !== null && !validProviderIntent(state.providerIntent) ||
      !isIso(state.createdAt) || !isIso(state.updatedAt) || !nullableHash(state.previousStateHash) ||
      !HASH.test(state.stateHash)) throw new BoundedTaskStateError(
        "bounded_task_state_corrupt", "Durable task state fields are invalid.");
  const { stateHash, ...core } = state;
  if (hashCanonicalJson(core) !== stateHash) throw new BoundedTaskStateError(
    "bounded_task_state_hash_mismatch", "Durable task state integrity failed.");
  return Object.freeze(state);
}
function readJson(file: string, limit: number): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new BoundedTaskStateError(
    stat.size > limit ? "bounded_task_state_oversized" : "bounded_task_state_symlink", "Durable record is unsafe.");
  const bytes = fs.readFileSync(file);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new BoundedTaskStateError(
    "bounded_task_state_corrupt", "Durable record is truncated or corrupt."); }
}
function processIdentity(pid: number): string | null {
  if (pid !== process.pid) return null;
  return hashCanonicalJson({ pid, processStartedAtMs: Math.floor(Date.now() - process.uptime() * 1_000) });
}
function validateLeaseOwner(value: unknown): LeaseOwnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundedTaskStateError(
    "bounded_task_state_lease_unsafe", "Durable task lease owner is invalid.");
  const owner = value as LeaseOwnerRecord;
  if (owner.leaseVersion !== "1" || !ID.test(owner.runId) || !NONCE.test(owner.ownerNonce) ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !HASH.test(owner.processIdentityHash) ||
      !isIso(owner.acquiredAt) || !isIso(owner.heartbeatAt)) throw new BoundedTaskStateError(
        "bounded_task_state_lease_unsafe", "Durable task lease owner is invalid.");
  return owner;
}
function ownerIsLive(owner: LeaseOwnerRecord): boolean {
  try { process.kill(owner.pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // A live PID always blocks takeover. The durable start binding distinguishes this
  // run, while fail-closed PID reuse cannot allow a second writer into the task.
  return true;
}

export class BoundedTaskStateSession {
  readonly runId = `run-${randomBytes(16).toString("hex")}`;
  readonly taskDirectory: string; private readonly stateFile: string; private readonly leaseDirectory: string;
  private readonly takeoverDirectory: string; private readonly owner: LeaseOwnerRecord;
  private readonly heartbeatTimer: NodeJS.Timeout; private state: DurableBoundedTaskState;
  private released = false; private leaseLost = false;
  constructor(readonly config: DurableBoundedTaskConfiguration, identity: { taskId: string;
    repositoryPath: string; repositoryIdentityHash: string; baselineSnapshotHash: string;
    baselineHeadHash: string; compiledPolicyHash: string; taskInputHash: string }) {
    if (!ID.test(identity.taskId) || !ID.test(config.idempotencyKey) || !HASH.test(identity.taskInputHash))
      throw new BoundedTaskStateError("bounded_task_state_identity_invalid", "Task durable identity is invalid.");
    const root = ensurePrivateDirectory(config.registryRoot); const repository = fs.realpathSync(identity.repositoryPath);
    if (repository === root || repository.startsWith(`${root}${path.sep}`) || root.startsWith(`${repository}${path.sep}`))
      throw new BoundedTaskStateError("bounded_task_state_registry_overlap", "Durable registry must be outside the repository.");
    const key = hashCanonicalJson({ taskId: identity.taskId, idempotencyKey: config.idempotencyKey }).slice(7);
    this.taskDirectory = path.join(root, "tasks", key); ensurePrivateDirectory(path.dirname(this.taskDirectory));
    ensurePrivateDirectory(this.taskDirectory); ensurePrivateDirectory(path.join(this.taskDirectory, "artifacts"));
    this.stateFile = path.join(this.taskDirectory, "state.json"); this.leaseDirectory = path.join(this.taskDirectory, "lease");
    this.takeoverDirectory = path.join(this.taskDirectory, "lease-takeover");
    if (config.resume && !fs.existsSync(this.stateFile)) throw new BoundedTaskStateError(
      "bounded_task_state_missing", "No durable state exists for this resume request.");
    const timeout = config.leaseTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout < 30) throw new BoundedTaskStateError(
      "bounded_task_state_lease_timeout_invalid", "Lease timeout must be at least 30 milliseconds.");
    this.owner = this.acquireLease(timeout);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), Math.max(10, Math.floor(timeout / 3)));
    this.heartbeatTimer.unref();
    try {
      const now = new Date().toISOString(); const binding = this.ownerBinding();
      if (fs.existsSync(this.stateFile)) {
        const loaded = validateState(readJson(this.stateFile, BOUNDED_TASK_STATE_MAX_BYTES));
        if (loaded.taskId !== identity.taskId || loaded.idempotencyKey !== config.idempotencyKey ||
            loaded.taskInputHash !== identity.taskInputHash ||
            loaded.repositoryIdentityHash !== identity.repositoryIdentityHash ||
            loaded.baselineSnapshotHash !== identity.baselineSnapshotHash || loaded.baselineHeadHash !== identity.baselineHeadHash ||
            loaded.compiledPolicyHash !== identity.compiledPolicyHash) throw new BoundedTaskStateError(
          "bounded_task_state_resume_binding_mismatch", "Durable task input bindings changed.");
        this.state = loaded;
        if (!TERMINAL.has(loaded.currentState)) { const { stateHash: _, ...core } = loaded;
          this.write({ ...core, runId: this.runId, leaseOwner: binding,
            attempts: [...loaded.attempts, { runId: this.runId, startedAt: now, resume: true }],
            updatedAt: now, previousStateHash: loaded.stateHash, transitionSequence: loaded.transitionSequence + 1 }); }
      } else {
        const base: Omit<DurableBoundedTaskState, "stateHash"> = {
          schemaVersion: BOUNDED_TASK_STATE_SCHEMA_VERSION, taskInputVersion: BOUNDED_TASK_INPUT_VERSION,
          taskInputHash: identity.taskInputHash, taskId: identity.taskId, runId: this.runId,
          idempotencyKey: config.idempotencyKey, currentState: "received", transitionSequence: 0,
          attempts: [{ runId: this.runId, startedAt: now, resume: Boolean(config.resume) }],
          repositoryIdentityHash: identity.repositoryIdentityHash, baselineSnapshotHash: identity.baselineSnapshotHash,
          baselineHeadHash: identity.baselineHeadHash, compiledPolicyHash: identity.compiledPolicyHash,
          planHash: null, contextEvidenceHash: null, providerRequestHash: null, providerResponseHash: null,
          mutationArtifactHash: null, verifiedMutationHash: null, x4Reference: null, x5IntentReference: null,
          x5ReceiptReference: null, terminalResultReference: null, terminalResultHash: null, artifacts: {},
          leaseOwner: binding, providerIntent: null, createdAt: now, updatedAt: now, previousStateHash: null };
        this.state = { ...base, stateHash: hashCanonicalJson(base) }; atomicWrite(this.stateFile, canonicalBytes(this.state));
      }
    } catch (error) { this.release(); throw error; }
  }
  private ownerBinding(): DurableLeaseOwnerBinding {
    let heartbeatAt = this.owner.heartbeatAt;
    try { const current = validateLeaseOwner(readJson(path.join(this.leaseDirectory, "owner.json"), 4096));
      if (current.runId === this.owner.runId && current.ownerNonce === this.owner.ownerNonce)
        heartbeatAt = current.heartbeatAt; } catch {}
    return { runId: this.owner.runId, ownerNonceHash: hashCanonicalJson({ ownerNonce: this.owner.ownerNonce }),
      pid: this.owner.pid, processIdentityHash: this.owner.processIdentityHash,
      acquiredAt: this.owner.acquiredAt, heartbeatAt };
  }
  private newOwner(): LeaseOwnerRecord {
    const now = new Date().toISOString(); const identity = processIdentity(process.pid);
    if (!identity) throw new BoundedTaskStateError("bounded_task_process_identity_unavailable",
      "The runtime process identity could not be verified.");
    return { leaseVersion: "1", runId: this.runId, ownerNonce: randomBytes(24).toString("hex"),
      pid: process.pid, processIdentityHash: identity, acquiredAt: now, heartbeatAt: now };
  }
  private installOwner(): LeaseOwnerRecord {
    fs.mkdirSync(this.leaseDirectory, { mode: 0o700 }); const owner = this.newOwner();
    atomicWrite(path.join(this.leaseDirectory, "owner.json"), canonicalBytes(owner)); return owner;
  }
  private acquireLease(timeout: number): LeaseOwnerRecord {
    try { return this.installOwner(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let takeoverHeld = false;
    try {
      try { fs.mkdirSync(this.takeoverDirectory, { mode: 0o700 }); takeoverHeld = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BoundedTaskStateError(
          "bounded_task_already_running", "Another process is acquiring the durable task lease.");
        throw error;
      }
      const stat = fs.lstatSync(this.leaseDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundedTaskStateError(
        "bounded_task_state_lease_unsafe", "Durable task lease is unsafe.");
      const existingOwner = validateLeaseOwner(readJson(path.join(this.leaseDirectory, "owner.json"), 4096));
      if (ownerIsLive(existingOwner) || Date.now() - Date.parse(existingOwner.heartbeatAt) <= timeout)
        throw new BoundedTaskStateError("bounded_task_already_running", "Another live process owns the durable task lease.");
      if (!fs.existsSync(this.stateFile)) throw new BoundedTaskStateError(
        "bounded_task_stale_lease_recovery_required", "A stale lease without verified state requires recovery.");
      validateState(readJson(this.stateFile, BOUNDED_TASK_STATE_MAX_BYTES));
      const quarantine = `${this.leaseDirectory}.stale-${randomBytes(12).toString("hex")}`;
      fs.renameSync(this.leaseDirectory, quarantine);
      try { const owner = this.installOwner(); fs.rmSync(quarantine, { recursive: true, force: true }); return owner; }
      catch (error) { try { if (!fs.existsSync(this.leaseDirectory)) fs.renameSync(quarantine, this.leaseDirectory); } catch {} throw error; }
    } finally { if (takeoverHeld) fs.rmSync(this.takeoverDirectory, { recursive: true, force: true }); }
  }
  private assertOwnership(): LeaseOwnerRecord {
    if (this.released || this.leaseLost) throw new BoundedTaskStateError(
      "bounded_task_lease_lost", "Durable task lease ownership was lost.");
    try {
      const current = validateLeaseOwner(readJson(path.join(this.leaseDirectory, "owner.json"), 4096));
      if (current.runId !== this.owner.runId || current.ownerNonce !== this.owner.ownerNonce) throw new Error("owner changed");
      return current;
    } catch (error) { this.leaseLost = true;
      if (error instanceof BoundedTaskStateError && error.code === "bounded_task_state_lease_unsafe") throw error;
      throw new BoundedTaskStateError("bounded_task_lease_lost", "Durable task lease ownership was lost."); }
  }
  private heartbeat(): void {
    if (this.released || this.leaseLost) return;
    try { const current = this.assertOwnership(); atomicWrite(path.join(this.leaseDirectory, "owner.json"),
      canonicalBytes({ ...current, heartbeatAt: new Date().toISOString() })); } catch { this.leaseLost = true; }
  }
  get snapshot(): DurableBoundedTaskState { return this.state; }
  private write(next: Omit<DurableBoundedTaskState, "stateHash">): void {
    this.assertOwnership(); const withHash = { ...next, stateHash: hashCanonicalJson(next) };
    const bytes = canonicalBytes(withHash); if (bytes.length > BOUNDED_TASK_STATE_MAX_BYTES) throw new BoundedTaskStateError(
      "bounded_task_state_oversized", "Durable task state exceeds its size limit.");
    atomicWrite(this.stateFile, bytes); this.state = validateState(withHash);
  }
  transition(target: BoundedTaskStateName, fields: Partial<DurableBoundedTaskState> = {}): DurableBoundedTaskState {
    if (TERMINAL.has(this.state.currentState)) throw new BoundedTaskStateError(
      "bounded_task_terminal_state_immutable", "Terminal durable task state cannot be overwritten.");
    const currentIndex = ORDER.indexOf(this.state.currentState); const targetIndex = ORDER.indexOf(target);
    if (!TERMINAL.has(target) && (targetIndex < 0 || targetIndex !== currentIndex + 1)) throw new BoundedTaskStateError(
      "bounded_task_state_transition_invalid", "Durable task transition is invalid.");
    const { stateHash: _, ...current } = this.state;
    this.write({ ...current, ...fields, schemaVersion: BOUNDED_TASK_STATE_SCHEMA_VERSION,
      taskInputVersion: BOUNDED_TASK_INPUT_VERSION, taskInputHash: current.taskInputHash,
      taskId: current.taskId, idempotencyKey: current.idempotencyKey, leaseOwner: this.ownerBinding(),
      currentState: target, transitionSequence: current.transitionSequence + 1,
      previousStateHash: this.state.stateHash, updatedAt: new Date().toISOString() });
    this.config.onCheckpoint?.(this.state); return this.state;
  }
  advance(target: BoundedTaskStateName, fields: Partial<DurableBoundedTaskState> = {}): void {
    if (TERMINAL.has(this.state.currentState)) return;
    const targetIndex = ORDER.indexOf(target); const currentIndex = ORDER.indexOf(this.state.currentState);
    if (targetIndex > currentIndex) for (let index = currentIndex + 1; index <= targetIndex; index += 1)
      this.transition(ORDER[index], index === targetIndex ? fields : {});
    else if (targetIndex === currentIndex && Object.keys(fields).length > 0) {
      const { stateHash: _, ...current } = this.state; this.write({ ...current, ...fields,
        leaseOwner: this.ownerBinding(), transitionSequence: current.transitionSequence + 1,
        previousStateHash: this.state.stateHash, updatedAt: new Date().toISOString() });
    }
  }
  writeArtifact(name: string, value: unknown): BoundedTaskArtifactReference {
    this.assertOwnership();
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(name)) throw new BoundedTaskStateError(
      "bounded_task_artifact_name_invalid", "Durable artifact name is invalid.");
    const bytes = canonicalBytes(value); if (bytes.length > BOUNDED_TASK_ARTIFACT_MAX_BYTES) throw new BoundedTaskStateError(
      "bounded_task_artifact_oversized", "Durable artifact exceeds its size limit.");
    const contentHash = hashCanonicalJson(value); const relativePath = `artifacts/${name}-${contentHash.slice(7, 23)}.json`;
    const file = path.join(this.taskDirectory, relativePath); if (!fs.existsSync(file)) atomicWrite(file, bytes);
    const ref = Object.freeze({ name, relativePath, contentHash, byteLength: bytes.length });
    const { stateHash: _, ...current } = this.state; this.write({ ...current,
      artifacts: { ...this.state.artifacts, [name]: ref }, leaseOwner: this.ownerBinding(),
      transitionSequence: current.transitionSequence + 1, previousStateHash: this.state.stateHash,
      updatedAt: new Date().toISOString() }); return ref;
  }
  readArtifact<T>(ref: BoundedTaskArtifactReference): T {
    const file = path.resolve(this.taskDirectory, ref.relativePath);
    if (!file.startsWith(`${this.taskDirectory}${path.sep}`)) throw new BoundedTaskStateError(
      "bounded_task_artifact_path_invalid", "Durable artifact path is invalid.");
    const value = readJson(file, BOUNDED_TASK_ARTIFACT_MAX_BYTES);
    if (hashCanonicalJson(value) !== ref.contentHash || canonicalBytes(value).length !== ref.byteLength) throw new BoundedTaskStateError(
      "bounded_task_artifact_hash_mismatch", "Durable artifact integrity failed.");
    return value as T;
  }
  getArtifact<T>(name: string): T | undefined { const ref = this.state.artifacts[name];
    return ref ? this.readArtifact<T>(ref) : undefined; }
  assertProviderResumeSafe(): void {
    const intent = this.state.providerIntent;
    if (!intent || intent.status !== "started" || this.config.providerIdempotencySupport?.[intent.providerKind] === true) return;
    const name = `provider-${intent.providerKind}-${intent.requestHash.slice(7, 23)}`;
    if (this.state.artifacts[name] !== undefined) return;
    throw new BoundedTaskStateError("provider_outcome_ambiguous",
      "Provider started but no durable response exists; automatic retry is unsafe.");
  }
  private updateProviderIntent(intent: DurableProviderIntent): void {
    const { stateHash: _, ...current } = this.state; this.write({ ...current, providerIntent: intent,
      providerRequestHash: intent.requestHash, providerResponseHash: intent.responseHash,
      leaseOwner: this.ownerBinding(), transitionSequence: current.transitionSequence + 1,
      previousStateHash: this.state.stateHash, updatedAt: new Date().toISOString() });
  }
  async cachedProvider<T>(kind: string, request: unknown,
    call: (providerIdempotencyKey: string) => Promise<T>): Promise<{ value: T; called: boolean }> {
    if (!ID.test(kind)) throw new BoundedTaskStateError("bounded_task_provider_kind_invalid", "Provider kind is invalid.");
    const requestHash = hashCanonicalJson(request); const name = `provider-${kind}-${requestHash.slice(7, 23)}`;
    const providerIdempotencyKey = hashCanonicalJson({ version: "provider-idempotency/v1",
      taskId: this.state.taskId, taskInputHash: this.state.taskInputHash, providerKind: kind, requestHash });
    const cached = this.getArtifact<{ requestHash: string; providerIdempotencyKey: string;
      responseHash: string; response: T }>(name);
    if (cached) {
      if (cached.requestHash !== requestHash || cached.providerIdempotencyKey !== providerIdempotencyKey ||
          hashCanonicalJson(cached.response) !== cached.responseHash) throw new BoundedTaskStateError(
        "bounded_task_provider_artifact_mismatch", "Stored provider artifact integrity failed.");
      return { value: cached.response, called: false };
    }
    const prior = this.state.providerIntent;
    if (prior?.status === "started" && (prior.providerKind !== kind || prior.requestHash !== requestHash ||
        this.config.providerIdempotencySupport?.[kind] !== true)) throw new BoundedTaskStateError(
      "provider_outcome_ambiguous", "Provider started but no durable response exists; automatic retry is unsafe.");
    if (prior && prior.providerKind === kind && prior.requestHash === requestHash &&
        prior.providerIdempotencyKey !== providerIdempotencyKey) throw new BoundedTaskStateError(
      "bounded_task_provider_intent_mismatch", "Stored provider intent does not match the stable request binding.");
    const attempt = prior && prior.providerKind === kind && prior.requestHash === requestHash ? prior.attempt + 1 : 1;
    const prepared: DurableProviderIntent = { providerKind: kind, requestHash, providerIdempotencyKey,
      attempt, status: "prepared", responseHash: null };
    this.updateProviderIntent(prepared); this.config.onProviderCheckpoint?.({ providerKind: kind,
      phase: "prepared", providerIdempotencyKey, attempt });
    this.updateProviderIntent({ ...prepared, status: "started" }); this.config.onProviderCheckpoint?.({ providerKind: kind,
      phase: "started", providerIdempotencyKey, attempt });
    const value = await call(providerIdempotencyKey); this.config.onProviderCheckpoint?.({ providerKind: kind,
      phase: "response_received", providerIdempotencyKey, attempt });
    const responseHash = hashCanonicalJson(value);
    this.writeArtifact(name, { requestHash, providerIdempotencyKey, responseHash, response: value });
    this.updateProviderIntent({ ...prepared, status: "completed", responseHash });
    this.config.onProviderCheckpoint?.({ providerKind: kind, phase: "completed", providerIdempotencyKey, attempt });
    return { value, called: true };
  }
  finalize(state: Extract<BoundedTaskStateName, "finalized" | "failed" | "replan_required" |
    "human_review_required" | "recovery_required">, result: unknown): void {
    const ref = this.writeArtifact("terminal-result", result); this.transition(state,
      { terminalResultReference: ref, terminalResultHash: ref.contentHash });
  }
  terminalResult<T>(): T | null { return this.state.terminalResultReference ?
    this.readArtifact<T>(this.state.terminalResultReference) : null; }
  release(): void {
    if (this.released) return; clearInterval(this.heartbeatTimer); this.released = true;
    try { const owner = validateLeaseOwner(readJson(path.join(this.leaseDirectory, "owner.json"), 4096));
      if (owner.runId === this.owner.runId && owner.ownerNonce === this.owner.ownerNonce)
        fs.rmSync(this.leaseDirectory, { recursive: true, force: true }); } catch {}
  }
}

export function readDurableBoundedTaskState(input: { registryRoot: string; taskId: string;
  idempotencyKey: string }): DurableBoundedTaskState {
  try {
    const root = fs.realpathSync(input.registryRoot); const key = hashCanonicalJson({ taskId: input.taskId,
      idempotencyKey: input.idempotencyKey }).slice(7);
    return validateState(readJson(path.join(root, "tasks", key, "state.json"), BOUNDED_TASK_STATE_MAX_BYTES));
  } catch (error) {
    if (error instanceof BoundedTaskStateError) throw error;
    throw new BoundedTaskStateError("bounded_task_state_missing", "Durable task state is missing.");
  }
}
