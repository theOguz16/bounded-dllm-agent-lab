import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  DurableBoundedTaskState,
  DurableProviderIntent
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";

export const PRODUCT_RUN_CHECKPOINT_VERSION = "product-run-checkpoint/v1" as const;
export const PRODUCT_RUN_CHECKPOINT_AUTHORITY = "canonical_durable_task_state" as const;
export const PRODUCT_RUN_CHECKPOINT_DIRECTORY = "product-checkpoints" as const;

export type ProductRunPersistPoint =
  | "before_agent_call"
  | "after_agent_call"
  | "after_mutation_capture"
  | "after_verification"
  | "after_validation"
  | "before_apply"
  | "after_apply";

export type ProductRunCheckpointSource = Readonly<{
  providerKind?: string;
  providerPhase?: "prepared" | "started" | "response_received" | "completed";
  artifactName?: string;
}>;

export type ProductRunCheckpointEvent = Readonly<{
  sequence: number;
  point: ProductRunPersistPoint;
  canonicalState: DurableBoundedTaskState["currentState"];
  canonicalTransitionSequence: number;
  canonicalStateHash: string;
  canonicalRunId: string;
  providerIntent: DurableProviderIntent | null;
  source: ProductRunCheckpointSource;
  recordedAt: string;
}>;

export type ProductRunCheckpoint = Readonly<{
  checkpointVersion: typeof PRODUCT_RUN_CHECKPOINT_VERSION;
  authority: typeof PRODUCT_RUN_CHECKPOINT_AUTHORITY;
  runId: string;
  taskId: string;
  idempotencyKey: string;
  latestPoint: ProductRunPersistPoint;
  latestCanonicalStateHash: string;
  events: readonly ProductRunCheckpointEvent[];
}>;

export type StoreProductRunCheckpointInput = Readonly<{
  registryRoot: string;
  runId: string;
  taskId: string;
  idempotencyKey: string;
  point: ProductRunPersistPoint;
  state: DurableBoundedTaskState;
  source?: ProductRunCheckpointSource;
}>;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PERSIST_POINTS = new Set<ProductRunPersistPoint>([
  "before_agent_call",
  "after_agent_call",
  "after_mutation_capture",
  "after_verification",
  "after_validation",
  "before_apply",
  "after_apply"
]);
const MAX_EVENTS = 1024;
const MAX_BYTES = 1024 * 1024;

function ensureDirectory(directory: string, label: string): string {
  const existing = (() => {
    try {
      return fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })();
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new CliError("cli_run_checkpoint_store_unsafe", `${label} must be a real directory.`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError("cli_run_checkpoint_store_unsafe", `${label} must be a real directory.`);
  }
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function checkpointDirectory(registryRoot: string): string {
  const root = ensureDirectory(registryRoot, "Canonical durable registry");
  return ensureDirectory(
    path.join(root, PRODUCT_RUN_CHECKPOINT_DIRECTORY),
    "Canonical durable product checkpoint directory"
  );
}

function checkpointFile(registryRoot: string, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new CliError("cli_run_checkpoint_run_id_invalid", "Product checkpoint runId is invalid.");
  }
  return path.join(checkpointDirectory(registryRoot), `${runId}.json`);
}

function validateSource(source: ProductRunCheckpointSource): void {
  for (const [field, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (field === "providerPhase") {
      if (!["prepared", "started", "response_received", "completed"].includes(String(value))) {
        throw new CliError("cli_run_checkpoint_invalid", "Product checkpoint provider phase is invalid.");
      }
      continue;
    }
    if (typeof value !== "string" || !SAFE_LABEL.test(value)) {
      throw new CliError("cli_run_checkpoint_invalid", "Product checkpoint source label is invalid.");
    }
  }
}

function parseCheckpoint(value: unknown): ProductRunCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("cli_run_checkpoint_invalid", "Stored product checkpoint is invalid.");
  }
  const checkpoint = value as ProductRunCheckpoint;
  if (
    checkpoint.checkpointVersion !== PRODUCT_RUN_CHECKPOINT_VERSION ||
    checkpoint.authority !== PRODUCT_RUN_CHECKPOINT_AUTHORITY ||
    !RUN_ID.test(checkpoint.runId) ||
    !TASK_ID.test(checkpoint.taskId) ||
    !TASK_ID.test(checkpoint.idempotencyKey) ||
    !PERSIST_POINTS.has(checkpoint.latestPoint) ||
    !HASH.test(checkpoint.latestCanonicalStateHash) ||
    !Array.isArray(checkpoint.events) ||
    checkpoint.events.length > MAX_EVENTS
  ) {
    throw new CliError("cli_run_checkpoint_invalid", "Stored product checkpoint fields are invalid.");
  }
  for (let index = 0; index < checkpoint.events.length; index += 1) {
    const event = checkpoint.events[index]!;
    if (
      event.sequence !== index + 1 ||
      !PERSIST_POINTS.has(event.point) ||
      typeof event.canonicalState !== "string" ||
      !Number.isSafeInteger(event.canonicalTransitionSequence) ||
      event.canonicalTransitionSequence < 0 ||
      !HASH.test(event.canonicalStateHash) ||
      !TASK_ID.test(event.canonicalRunId) ||
      typeof event.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(event.recordedAt))
    ) {
      throw new CliError("cli_run_checkpoint_invalid", "Stored product checkpoint event is invalid.");
    }
    validateSource(event.source);
  }
  const latest = checkpoint.events.at(-1);
  if (
    latest !== undefined &&
    (checkpoint.latestPoint !== latest.point ||
      checkpoint.latestCanonicalStateHash !== latest.canonicalStateHash)
  ) {
    throw new CliError("cli_run_checkpoint_invalid", "Stored product checkpoint latest binding is invalid.");
  }
  return checkpoint;
}

function readExisting(file: string): ProductRunCheckpoint | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("cli_run_checkpoint_read_failed", "Product checkpoint could not be inspected.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
    throw new CliError("cli_run_checkpoint_store_unsafe", "Stored product checkpoint is unsafe.");
  }
  try {
    return parseCheckpoint(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("cli_run_checkpoint_invalid", "Stored product checkpoint is not valid JSON.");
  }
}

function atomicWrite(file: string, value: ProductRunCheckpoint): void {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_BYTES) {
    throw new CliError("cli_run_checkpoint_too_large", "Product checkpoint exceeds its size limit.");
  }
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    const directoryDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (error instanceof CliError) throw error;
    throw new CliError("cli_run_checkpoint_write_failed", "Product checkpoint could not be persisted.");
  }
}

export function storeProductRunCheckpoint(
  input: StoreProductRunCheckpointInput
): ProductRunCheckpoint {
  if (!RUN_ID.test(input.runId) || !TASK_ID.test(input.taskId) || !TASK_ID.test(input.idempotencyKey)) {
    throw new CliError("cli_run_checkpoint_invalid", "Product checkpoint identity is invalid.");
  }
  if (!PERSIST_POINTS.has(input.point)) {
    throw new CliError("cli_run_checkpoint_invalid", "Product checkpoint persist point is invalid.");
  }
  if (input.state.taskId !== input.taskId || input.state.idempotencyKey !== input.idempotencyKey) {
    throw new CliError(
      "cli_run_checkpoint_binding_mismatch",
      "Product checkpoint does not match the canonical durable task binding."
    );
  }
  const source = Object.freeze({ ...(input.source ?? {}) });
  validateSource(source);
  const file = checkpointFile(input.registryRoot, input.runId);
  const existing = readExisting(file);
  if (existing && (existing.taskId !== input.taskId || existing.idempotencyKey !== input.idempotencyKey)) {
    throw new CliError(
      "cli_run_checkpoint_binding_mismatch",
      "Existing product checkpoint belongs to a different canonical task binding."
    );
  }

  const duplicate = existing?.events.at(-1);
  if (
    duplicate?.point === input.point &&
    duplicate.canonicalStateHash === input.state.stateHash &&
    JSON.stringify(duplicate.source) === JSON.stringify(source)
  ) {
    return existing!;
  }
  const priorEvents = existing?.events ?? [];
  if (priorEvents.length >= MAX_EVENTS) {
    throw new CliError("cli_run_checkpoint_event_limit", "Product checkpoint event limit was exceeded.");
  }
  const event: ProductRunCheckpointEvent = Object.freeze({
    sequence: priorEvents.length + 1,
    point: input.point,
    canonicalState: input.state.currentState,
    canonicalTransitionSequence: input.state.transitionSequence,
    canonicalStateHash: input.state.stateHash,
    canonicalRunId: input.state.runId,
    providerIntent: input.state.providerIntent,
    source,
    recordedAt: input.state.updatedAt
  });
  const checkpoint: ProductRunCheckpoint = Object.freeze({
    checkpointVersion: PRODUCT_RUN_CHECKPOINT_VERSION,
    authority: PRODUCT_RUN_CHECKPOINT_AUTHORITY,
    runId: input.runId,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    latestPoint: input.point,
    latestCanonicalStateHash: input.state.stateHash,
    events: Object.freeze([...priorEvents, event])
  });
  atomicWrite(file, checkpoint);
  return checkpoint;
}

export function readProductRunCheckpoint(
  registryRoot: string,
  runId: string
): ProductRunCheckpoint {
  const file = checkpointFile(registryRoot, runId);
  const checkpoint = readExisting(file);
  if (!checkpoint) {
    throw new CliError("cli_run_checkpoint_not_found", `Product checkpoint not found: ${runId}.`);
  }
  return checkpoint;
}
