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
const REDACTED = "[REDACTED]";

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

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (normalized.endsWith("token") && !normalized.endsWith("pertoken")) ||
    /secret|password|credential|apikey|authorization|privatekey/.test(normalized);
}

function collectSecrets(
  environment: NodeJS.ProcessEnv,
  explicit: readonly string[]
): string[] {
  const values = new Set<string>();
  for (const secret of explicit) {
    if (typeof secret === "string" && secret.length >= 4) values.add(secret);
  }
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value === "string" &&
      value.length >= 4 &&
      /(?:key|token|secret|credential|password|authorization)/i.test(name)
    ) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) output = output.replaceAll(secret, REDACTED);
  return output;
}

function redactSecretText(value: string, secrets: readonly string[]): string {
  let output = redactKnownSecrets(value, secrets);

  output = output
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/g, REDACTED)
    .replace(/(\bAuthorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"'`]+/gi, `$1${REDACTED}`);

  const lines = output.split("\n").map((line) => {
    const prefixMatch = /^([+\- ]?)(.*)$/.exec(line);
    const prefix = prefixMatch?.[1] ?? "";
    const body = prefixMatch?.[2] ?? line;
    if (!/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|credential|authorization|private[_-]?key)/i.test(body)) {
      return line;
    }
    const separator = /[:=]/.exec(body);
    if (!separator || separator.index === undefined) return line;
    const head = body.slice(0, separator.index + 1);
    return `${prefix}${head} ${REDACTED}`;
  });
  return lines.join("\n");
}

function sanitizeJsonValue(
  value: unknown,
  secrets: readonly string[],
  seen: Set<object>,
  fieldName?: string
): unknown {
  if (fieldName && isCredentialField(fieldName)) return REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new CliError("cli_run_artifact_invalid", "Run artifact JSON contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "string") return redactSecretText(value, secrets);
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new CliError("cli_run_artifact_invalid", "Run artifact contains a non-JSON value.");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CliError("cli_run_artifact_invalid", "Run artifact contains a cycle.");
    seen.add(value);
    const output = value.map((item) => sanitizeJsonValue(item, secrets, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new CliError("cli_run_artifact_invalid", "Run artifact contains a cycle.");
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitizeJsonValue(item, secrets, seen, key);
    }
    seen.delete(value);
    return output;
  }
  throw new CliError("cli_run_artifact_invalid", "Run artifact contains an unsupported value.");
}

function sanitizeJson(value: unknown, secrets: readonly string[]): unknown {
  return sanitizeJsonValue(value, secrets, new Set<object>());
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

function assertNoKnownSecrets(bytes: Buffer, secrets: readonly string[]): void {
  const text = bytes.toString("utf8");
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret)) {
      throw new CliError("cli_run_artifact_secret_detected", "Raw secret material remained after artifact redaction.");
    }
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

  const secrets = collectSecrets(input.environment ?? process.env, input.secrets ?? []);
  const sanitizedRun = sanitizeJson(input.run, secrets) as Readonly<Record<string, unknown>>;
  const sanitizedReceipt = sanitizeJson(input.receipt, secrets);
  const sanitizedTelemetry = sanitizeJson(input.telemetry, secrets);
  const sanitizedValidation = sanitizeJson(input.validation, secrets);
  const sanitizedComparison = input.comparison === undefined
    ? undefined
    : sanitizeJson(input.comparison, secrets);
  const sanitizedDiff = redactSecretText(input.candidateDiff, secrets);

  const candidateDiffBytes = Buffer.from(sanitizedDiff, "utf8");
  if (candidateDiffBytes.length > MAX_DIFF_BYTES) {
    throw new CliError("cli_run_artifact_too_large", "candidate.diff exceeds the local size limit.");
  }
  const receiptBytes = jsonBytes(sanitizedReceipt);
  const telemetryBytes = jsonBytes(sanitizedTelemetry);
  const validationBytes = jsonBytes(sanitizedValidation);
  const comparisonBytes = sanitizedComparison === undefined ? null : jsonBytes(sanitizedComparison);

  for (const bytes of [candidateDiffBytes, receiptBytes, telemetryBytes, validationBytes, comparisonBytes]) {
    if (bytes) assertNoKnownSecrets(bytes, secrets);
  }

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
  assertNoKnownSecrets(runBytes, secrets);

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
