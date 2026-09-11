import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  createAgentOutputRedactor,
  isCredentialFieldName,
  AGENT_OUTPUT_REDACTED,
  type AgentOutputRedactor
} from "../../../packages/integrations/src/agent-output-redaction.js";
import {
  PRODUCT_RUN_ARTIFACT_FILES,
  createProductRunArtifact,
  verifyProductRunArtifact,
  type ProductRunArtifact,
  type ProductRunKind,
  type ProductRunStoredFile
} from "../../../packages/product-runtime/src/product-run-artifact.js";
import { CliError } from "./cli-errors.js";

export const BOUNDED_RUNS_PATH = ".bounded/runs" as const;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

export type StoreProductRunArtifactInput = Readonly<{
  repositoryRoot: string;
  runId: string;
  runKind?: ProductRunKind;
  run: Readonly<Record<string, unknown>>;
  candidateDiff: string;
  receipt: unknown;
  telemetry: unknown;
  validation: unknown;
  comparison?: unknown;
  secrets?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}>;

export type StoredProductRunArtifact = Readonly<{
  directoryPath: string;
  artifact: ProductRunArtifact;
}>;

export type StoredProductRunBundle = Readonly<{
  directoryPath: string;
  artifact: ProductRunArtifact;
  candidateDiff: string;
  receipt: unknown;
  telemetry: unknown;
  validation: unknown;
  comparison: unknown | null;
}>;

export type StoredProductRunArtifactEntry = Readonly<{
  artifact: ProductRunArtifact;
  modifiedAtMs: number;
}>;

function sanitizeJsonValue(
  value: unknown,
  redactor: AgentOutputRedactor,
  seen: Set<object>,
  fieldName?: string
): unknown {
  if (fieldName && isCredentialFieldName(fieldName)) return AGENT_OUTPUT_REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new CliError("cli_run_artifact_invalid", "Run artifact JSON contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "string") return redactor.redactText(value);
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new CliError("cli_run_artifact_invalid", "Run artifact contains a non-JSON value.");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CliError("cli_run_artifact_invalid", "Run artifact contains a cycle.");
    seen.add(value);
    const output = value.map((item) => sanitizeJsonValue(item, redactor, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new CliError("cli_run_artifact_invalid", "Run artifact contains a cycle.");
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitizeJsonValue(item, redactor, seen, key);
    }
    seen.delete(value);
    return output;
  }
  throw new CliError("cli_run_artifact_invalid", "Run artifact contains an unsupported value.");
}

function sanitizeJson(value: unknown, redactor: AgentOutputRedactor): unknown {
  return sanitizeJsonValue(value, redactor, new Set<object>());
}

function jsonBytes(value: unknown): Buffer {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new CliError("cli_run_artifact_invalid", "Run artifact JSON could not be serialized.");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_JSON_BYTES) {
    throw new CliError("cli_run_artifact_too_large", "Run artifact JSON exceeds the local size limit.");
  }
  return bytes;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fileMetadata(file: string, bytes: Buffer): ProductRunStoredFile {
  return Object.freeze({ file, sha256: hashBytes(bytes), bytes: bytes.length });
}

function assertNoKnownSecrets(bytes: Buffer, redactor: AgentOutputRedactor): void {
  if (redactor.containsKnownCredentialValue(bytes.toString("utf8"))) {
    throw new CliError(
      "cli_run_artifact_secret_detected",
      "Raw secret material remained after artifact redaction."
    );
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new CliError("cli_run_artifact_run_id_invalid", "Run artifact runId is invalid.");
  }
}

async function assertBoundedDirectory(repositoryRoot: string): Promise<string> {
  const bounded = path.join(repositoryRoot, ".bounded");
  const stat = await lstat(bounded).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError("cli_run_artifact_store_unsafe", ".bounded must be a real directory. Run bounded init first.");
  }
  return bounded;
}

async function prepareRunsDirectory(repositoryRoot: string): Promise<string> {
  const bounded = await assertBoundedDirectory(repositoryRoot);
  const runs = path.join(bounded, "runs");
  const existing = await lstat(runs).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new CliError("cli_run_artifact_store_unsafe", ".bounded/runs must be a real directory.");
  }
  await mkdir(runs, { recursive: true, mode: 0o700 });
  await chmod(runs, 0o700);
  return runs;
}

async function runsDirectoryForRead(repositoryRoot: string): Promise<string | null> {
  const bounded = await assertBoundedDirectory(repositoryRoot);
  const runs = path.join(bounded, "runs");
  const stat = await lstat(runs).catch(() => null);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError("cli_run_artifact_store_unsafe", ".bounded/runs must be a real directory.");
  }
  return runs;
}

async function runDirectoryForRead(
  repositoryRoot: string,
  runId: string
): Promise<Readonly<{ directoryPath: string; modifiedAtMs: number }>> {
  assertRunId(runId);
  const runs = await runsDirectoryForRead(repositoryRoot);
  if (!runs) {
    throw new CliError("cli_run_artifact_not_found", `Run artifact not found: ${runId}.`);
  }
  const directoryPath = path.join(runs, runId);
  const stat = await lstat(directoryPath).catch(() => null);
  if (!stat) {
    throw new CliError("cli_run_artifact_not_found", `Run artifact not found: ${runId}.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError("cli_run_artifact_store_unsafe", `Run artifact directory is unsafe: ${runId}.`);
  }
  return Object.freeze({ directoryPath, modifiedAtMs: stat.mtimeMs });
}

async function readRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  const stat = await lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new CliError("cli_run_artifact_invalid", "Stored run artifact file is missing or unsafe.");
  }
  if (stat.size > maxBytes) {
    throw new CliError("cli_run_artifact_too_large", "Stored run artifact exceeds the local size limit.");
  }
  try {
    return await readFile(file);
  } catch {
    throw new CliError("cli_run_artifact_invalid", "Stored run artifact file could not be read.");
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError("cli_run_artifact_invalid", "Stored run artifact is not valid UTF-8 text.");
  }
}

function parseStoredJson(bytes: Buffer, file: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("cli_run_artifact_invalid", `Stored ${file} is not valid JSON.`);
  }
}

async function readManifestFromDirectory(
  directoryPath: string,
  runId: string
): Promise<ProductRunArtifact> {
  const bytes = await readRegularFile(
    path.join(directoryPath, PRODUCT_RUN_ARTIFACT_FILES.run),
    MAX_JSON_BYTES
  );
  const value = parseStoredJson(bytes, PRODUCT_RUN_ARTIFACT_FILES.run);
  if (!verifyProductRunArtifact(value) || value.runId !== runId) {
    throw new CliError("cli_run_artifact_invalid", "Stored run.json failed bounded-product-run/v1 verification.");
  }
  return value;
}

async function readVerifiedStoredFile(
  directoryPath: string,
  metadata: ProductRunStoredFile,
  maxBytes: number
): Promise<Buffer> {
  const bytes = await readRegularFile(path.join(directoryPath, metadata.file), maxBytes);
  if (bytes.length !== metadata.bytes || hashBytes(bytes) !== metadata.sha256) {
    throw new CliError("cli_run_artifact_integrity_failed", `Stored ${metadata.file} failed integrity verification.`);
  }
  return bytes;
}

async function assertExpectedRunFiles(
  directoryPath: string,
  artifact: ProductRunArtifact
): Promise<void> {
  const expected = new Set<string>([
    PRODUCT_RUN_ARTIFACT_FILES.run,
    PRODUCT_RUN_ARTIFACT_FILES.candidateDiff,
    PRODUCT_RUN_ARTIFACT_FILES.receipt,
    PRODUCT_RUN_ARTIFACT_FILES.telemetry,
    PRODUCT_RUN_ARTIFACT_FILES.validation
  ]);
  if (artifact.runKind === "compare") expected.add(PRODUCT_RUN_ARTIFACT_FILES.comparison);
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => {
    throw new CliError("cli_run_artifact_invalid", "Stored run artifact directory could not be read.");
  });
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
  ) {
    throw new CliError("cli_run_artifact_integrity_failed", "Stored run artifact directory contents are invalid.");
  }
}

async function writePrivateFile(directory: string, file: string, bytes: Buffer): Promise<void> {
  await writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
}

export async function storeProductRunArtifact(
  input: StoreProductRunArtifactInput
): Promise<StoredProductRunArtifact> {
  assertRunId(input.runId);
  if (typeof input.candidateDiff !== "string") {
    throw new CliError("cli_run_artifact_invalid", "candidate.diff content must be text.");
  }

  const runKind: ProductRunKind = input.runKind ?? (input.comparison === undefined ? "run" : "compare");
  if (runKind === "compare" && input.comparison === undefined) {
    throw new CliError("cli_run_artifact_invalid", "Compare run artifacts require comparison data.");
  }
  if (runKind === "run" && input.comparison !== undefined) {
    throw new CliError("cli_run_artifact_invalid", "Non-compare run artifacts must not include comparison data.");
  }

  // Redaction is intentionally an artifact-boundary operation. Any canonical
  // source/evidence hashes must already have been computed from their raw input.
  const redactor = createAgentOutputRedactor({
    environment: input.environment ?? process.env,
    secrets: input.secrets ?? []
  });
  const sanitizedRun = sanitizeJson(input.run, redactor) as Readonly<Record<string, unknown>>;
  const sanitizedReceipt = sanitizeJson(input.receipt, redactor);
  const sanitizedTelemetry = sanitizeJson(input.telemetry, redactor);
  const sanitizedValidation = sanitizeJson(input.validation, redactor);
  const sanitizedComparison = input.comparison === undefined
    ? undefined
    : sanitizeJson(input.comparison, redactor);
  const sanitizedDiff = redactor.redactText(input.candidateDiff);

  const candidateDiffBytes = Buffer.from(sanitizedDiff, "utf8");
  if (candidateDiffBytes.length > MAX_DIFF_BYTES) {
    throw new CliError("cli_run_artifact_too_large", "candidate.diff exceeds the local size limit.");
  }
  const receiptBytes = jsonBytes(sanitizedReceipt);
  const telemetryBytes = jsonBytes(sanitizedTelemetry);
  const validationBytes = jsonBytes(sanitizedValidation);
  const comparisonBytes = sanitizedComparison === undefined ? null : jsonBytes(sanitizedComparison);

  for (const bytes of [candidateDiffBytes, receiptBytes, telemetryBytes, validationBytes, comparisonBytes]) {
    if (bytes) assertNoKnownSecrets(bytes, redactor);
  }

  // These hashes describe the redacted bytes actually persisted to disk; they
  // are storage-integrity hashes, not semantic hashes of raw source material.
  const artifact = createProductRunArtifact({
    runId: input.runId,
    runKind,
    run: sanitizedRun,
    files: {
      candidateDiff: fileMetadata(PRODUCT_RUN_ARTIFACT_FILES.candidateDiff, candidateDiffBytes),
      receipt: fileMetadata(PRODUCT_RUN_ARTIFACT_FILES.receipt, receiptBytes),
      telemetry: fileMetadata(PRODUCT_RUN_ARTIFACT_FILES.telemetry, telemetryBytes),
      validation: fileMetadata(PRODUCT_RUN_ARTIFACT_FILES.validation, validationBytes),
      comparison: comparisonBytes === null
        ? null
        : fileMetadata(PRODUCT_RUN_ARTIFACT_FILES.comparison, comparisonBytes)
    }
  });
  const runBytes = jsonBytes(artifact);
  assertNoKnownSecrets(runBytes, redactor);

  const runs = await prepareRunsDirectory(input.repositoryRoot);
  const target = path.join(runs, input.runId);
  if (await lstat(target).catch(() => null)) {
    throw new CliError("cli_run_artifact_exists", `Run artifact already exists: ${input.runId}.`);
  }
  const temporary = path.join(runs, `.${input.runId}.${process.pid}.tmp`);
  if (await lstat(temporary).catch(() => null)) {
    throw new CliError("cli_run_artifact_store_unsafe", "Temporary run artifact path already exists.");
  }

  try {
    await mkdir(temporary, { mode: 0o700 });
    await chmod(temporary, 0o700);
    await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.candidateDiff, candidateDiffBytes);
    await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.receipt, receiptBytes);
    await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.telemetry, telemetryBytes);
    await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.validation, validationBytes);
    if (comparisonBytes !== null) {
      await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.comparison, comparisonBytes);
    }
    await writePrivateFile(temporary, PRODUCT_RUN_ARTIFACT_FILES.run, runBytes);
    await rename(temporary, target);
    await chmod(target, 0o700);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError("cli_run_artifact_write_failed", "Local run artifact could not be written.");
  }

  return Object.freeze({ directoryPath: target, artifact });
}

export async function readStoredProductRunArtifact(
  repositoryRoot: string,
  runId: string
): Promise<ProductRunArtifact> {
  const { directoryPath } = await runDirectoryForRead(repositoryRoot, runId);
  return readManifestFromDirectory(directoryPath, runId);
}

export async function readStoredProductRunBundle(
  repositoryRoot: string,
  runId: string
): Promise<StoredProductRunBundle> {
  const { directoryPath } = await runDirectoryForRead(repositoryRoot, runId);
  const artifact = await readManifestFromDirectory(directoryPath, runId);
  await assertExpectedRunFiles(directoryPath, artifact);

  const candidateDiffBytes = await readVerifiedStoredFile(
    directoryPath,
    artifact.files.candidateDiff,
    MAX_DIFF_BYTES
  );
  const receiptBytes = await readVerifiedStoredFile(directoryPath, artifact.files.receipt, MAX_JSON_BYTES);
  const telemetryBytes = await readVerifiedStoredFile(directoryPath, artifact.files.telemetry, MAX_JSON_BYTES);
  const validationBytes = await readVerifiedStoredFile(directoryPath, artifact.files.validation, MAX_JSON_BYTES);
  const comparisonBytes = artifact.files.comparison === null
    ? null
    : await readVerifiedStoredFile(directoryPath, artifact.files.comparison, MAX_JSON_BYTES);

  return Object.freeze({
    directoryPath,
    artifact,
    candidateDiff: decodeUtf8(candidateDiffBytes),
    receipt: parseStoredJson(receiptBytes, PRODUCT_RUN_ARTIFACT_FILES.receipt),
    telemetry: parseStoredJson(telemetryBytes, PRODUCT_RUN_ARTIFACT_FILES.telemetry),
    validation: parseStoredJson(validationBytes, PRODUCT_RUN_ARTIFACT_FILES.validation),
    comparison: comparisonBytes === null
      ? null
      : parseStoredJson(comparisonBytes, PRODUCT_RUN_ARTIFACT_FILES.comparison)
  });
}

export async function listStoredProductRunArtifacts(
  repositoryRoot: string
): Promise<readonly StoredProductRunArtifactEntry[]> {
  const runs = await runsDirectoryForRead(repositoryRoot);
  if (!runs) return Object.freeze([]);
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => {
    throw new CliError("cli_run_artifact_store_unsafe", ".bounded/runs could not be read.");
  });
  const artifacts: StoredProductRunArtifactEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!RUN_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new CliError("cli_run_artifact_store_unsafe", "Unexpected entry exists under .bounded/runs.");
    }
    const { directoryPath, modifiedAtMs } = await runDirectoryForRead(repositoryRoot, entry.name);
    const artifact = await readManifestFromDirectory(directoryPath, entry.name);
    artifacts.push(Object.freeze({ artifact, modifiedAtMs }));
  }
  artifacts.sort((left, right) =>
    right.modifiedAtMs - left.modifiedAtMs || left.artifact.runId.localeCompare(right.artifact.runId)
  );
  return Object.freeze(artifacts);
}
