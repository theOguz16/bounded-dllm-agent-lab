export const TARGETED_REPAIR_REQUEST_VERSION = "targeted-repair-request/v1" as const;

export type TargetedRepairVerifierIssue = Readonly<{
  code: string;
  message: string;
  file?: string;
}>;

export type TargetedRepairRequest = Readonly<{
  schemaVersion: typeof TARGETED_REPAIR_REQUEST_VERSION;
  originalCandidateHash: string;
  failingFiles: readonly string[];
  failingChecks: readonly string[];
  verifierIssues: readonly TargetedRepairVerifierIssue[];
  allowedFiles: readonly string[];
  preserveFiles: readonly string[];
  repairRound: number;
}>;

/**
 * Trusted, pre-repair boundary derived from the already validated candidate and
 * its immutable policy/acceptance context. This object is not model output.
 */
export type TargetedRepairBoundary = Readonly<{
  originalCandidateHash: string;
  originalCandidateFiles: readonly string[];
  policyFiles: readonly string[];
  acceptanceCriteriaFiles: readonly string[];
}>;

export class TargetedRepairContractError extends Error {
  readonly code = "targeted_repair_contract_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "TargetedRepairContractError";
  }
}

const EXACT_KEYS = [
  "allowedFiles",
  "failingChecks",
  "failingFiles",
  "originalCandidateHash",
  "preserveFiles",
  "repairRound",
  "schemaVersion",
  "verifierIssues"
] as const;
const ISSUE_KEYS = new Set(["code", "message", "file"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_FILES = 32;
const MAX_CHECKS = 64;
const MAX_ISSUES = 128;
const MAX_CHECK_LENGTH = 256;
const MAX_ISSUE_TEXT = 2_000;

function fail(message: string): never {
  throw new TargetedRepairContractError(message);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain data object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(`${label} must not contain symbol properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) return fail(`${label} must not contain accessors.`);
  }
  return value as Record<string, unknown>;
}

function exactRoot(value: unknown): Record<string, unknown> {
  const record = plainObject(value, "Targeted repair request");
  const keys = Object.keys(record).sort();
  if (keys.join("\u0000") !== [...EXACT_KEYS].sort().join("\u0000")) {
    return fail("Targeted repair request must contain the exact contract fields.");
  }
  return record;
}

function normalizeHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    return fail(`${field} must be a sha256: prefixed lowercase SHA-256 hash.`);
  }
  return value;
}

function normalizePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    CONTROL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    return fail(`${field} contains an invalid repository-relative path.`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return fail(`${field} contains a repository path escape or alias.`);
  }
  return normalized;
}

function normalizePathArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    return fail(`${field} must be an array with at most ${MAX_FILES} paths.`);
  }
  const paths = value.map((entry) => normalizePath(entry, field));
  if (new Set(paths).size !== paths.length) return fail(`${field} must not contain duplicates.`);
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeBoundedStrings(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return fail(`${field} must be an array with at most ${maximumItems} entries.`);
  }
  const entries = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > maximumLength ||
      entry.trim() !== entry ||
      CONTROL.test(entry)
    ) {
      return fail(`${field} must contain bounded non-empty strings.`);
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) return fail(`${field} must not contain duplicates.`);
  return entries.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeVerifierIssues(value: unknown): TargetedRepairVerifierIssue[] {
  if (!Array.isArray(value) || value.length > MAX_ISSUES) {
    return fail(`verifierIssues must be an array with at most ${MAX_ISSUES} entries.`);
  }
  return value.map((entry, index) => {
    const issue = plainObject(entry, `verifierIssues[${index}]`);
    const unknown = Object.keys(issue).filter((key) => !ISSUE_KEYS.has(key));
    if (unknown.length > 0) return fail(`verifierIssues[${index}] contains unknown fields.`);
    if (
      typeof issue.code !== "string" ||
      issue.code.length === 0 ||
      issue.code.length > MAX_CHECK_LENGTH ||
      issue.code.trim() !== issue.code ||
      CONTROL.test(issue.code)
    ) {
      return fail(`verifierIssues[${index}].code is invalid.`);
    }
    if (
      typeof issue.message !== "string" ||
      issue.message.length === 0 ||
      issue.message.length > MAX_ISSUE_TEXT ||
      issue.message.trim() !== issue.message ||
      CONTROL.test(issue.message)
    ) {
      return fail(`verifierIssues[${index}].message is invalid.`);
    }
    const file = issue.file === undefined ? undefined : normalizePath(issue.file, `verifierIssues[${index}].file`);
    return Object.freeze({
      code: issue.code,
      message: issue.message,
      ...(file === undefined ? {} : { file })
    });
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function validateBoundary(boundary: TargetedRepairBoundary): Readonly<{
  originalCandidateHash: string;
  originalCandidateFiles: readonly string[];
  protectedFiles: ReadonlySet<string>;
}> {
  const record = plainObject(boundary, "Targeted repair boundary");
  const boundaryKeys = [
    "acceptanceCriteriaFiles",
    "originalCandidateFiles",
    "originalCandidateHash",
    "policyFiles"
  ].sort();
  if (Object.keys(record).sort().join("\u0000") !== boundaryKeys.join("\u0000")) {
    return fail("Targeted repair boundary must contain the exact trusted boundary fields.");
  }
  const originalCandidateHash = normalizeHash(record.originalCandidateHash, "boundary.originalCandidateHash");
  const originalCandidateFiles = normalizePathArray(record.originalCandidateFiles, "boundary.originalCandidateFiles");
  if (originalCandidateFiles.length === 0) {
    return fail("Targeted repair boundary requires at least one original candidate file.");
  }
  const policyFiles = normalizePathArray(record.policyFiles, "boundary.policyFiles");
  const acceptanceCriteriaFiles = normalizePathArray(
    record.acceptanceCriteriaFiles,
    "boundary.acceptanceCriteriaFiles"
  );
  return Object.freeze({
    originalCandidateHash,
    originalCandidateFiles: Object.freeze(originalCandidateFiles),
    protectedFiles: new Set([...policyFiles, ...acceptanceCriteriaFiles])
  });
}

/**
 * Parses an untrusted repair request against a trusted original-candidate
 * boundary. Boundary validation is mandatory so scope cannot expand merely by
 * changing allowedFiles in model output.
 */
export function parseTargetedRepairRequest(
  value: unknown,
  boundary: TargetedRepairBoundary
): TargetedRepairRequest {
  const trusted = validateBoundary(boundary);
  const record = exactRoot(value);

  if (record.schemaVersion !== TARGETED_REPAIR_REQUEST_VERSION) {
    return fail(`schemaVersion must be ${TARGETED_REPAIR_REQUEST_VERSION}.`);
  }
  const originalCandidateHash = normalizeHash(record.originalCandidateHash, "originalCandidateHash");
  if (originalCandidateHash !== trusted.originalCandidateHash) {
    return fail("originalCandidateHash does not match the trusted original candidate.");
  }

  const allowedFiles = normalizePathArray(record.allowedFiles, "allowedFiles");
  const preserveFiles = normalizePathArray(record.preserveFiles, "preserveFiles");
  const failingFiles = normalizePathArray(record.failingFiles, "failingFiles");
  if (allowedFiles.length === 0) return fail("Targeted repair requires at least one allowed file.");

  const allowedSet = new Set(allowedFiles);
  const preserveSet = new Set(preserveFiles);
  if (allowedFiles.some((file) => preserveSet.has(file))) {
    return fail("allowedFiles and preserveFiles must be disjoint.");
  }
  if (!sameSet([...allowedFiles, ...preserveFiles], trusted.originalCandidateFiles)) {
    return fail("Repair scope must exactly partition the original candidate files; scope expansion is forbidden.");
  }
  if (allowedFiles.some((file) => trusted.protectedFiles.has(file))) {
    return fail("Policy and acceptance-criteria files cannot be mutable during targeted repair.");
  }
  if (failingFiles.some((file) => !allowedSet.has(file))) {
    return fail("failingFiles must be a subset of allowedFiles.");
  }

  const failingChecks = normalizeBoundedStrings(
    record.failingChecks,
    "failingChecks",
    MAX_CHECKS,
    MAX_CHECK_LENGTH
  );
  const verifierIssues = normalizeVerifierIssues(record.verifierIssues);
  if (failingChecks.length === 0 && verifierIssues.length === 0) {
    return fail("Targeted repair requires at least one failing check or verifier issue.");
  }
  if (!Number.isSafeInteger(record.repairRound) || Number(record.repairRound) < 1) {
    return fail("repairRound must be a positive safe integer.");
  }

  return Object.freeze({
    schemaVersion: TARGETED_REPAIR_REQUEST_VERSION,
    originalCandidateHash,
    failingFiles: Object.freeze(failingFiles),
    failingChecks: Object.freeze(failingChecks),
    verifierIssues: Object.freeze(verifierIssues),
    allowedFiles: Object.freeze(allowedFiles),
    preserveFiles: Object.freeze(preserveFiles),
    repairRound: Number(record.repairRound)
  });
}

export const TARGETED_REPAIR_REQUEST_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "originalCandidateHash",
    "failingFiles",
    "failingChecks",
    "verifierIssues",
    "allowedFiles",
    "preserveFiles",
    "repairRound"
  ],
  properties: {
    schemaVersion: { type: "string", const: TARGETED_REPAIR_REQUEST_VERSION },
    originalCandidateHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    failingFiles: {
      type: "array",
      maxItems: MAX_FILES,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    failingChecks: {
      type: "array",
      maxItems: MAX_CHECKS,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: MAX_CHECK_LENGTH }
    },
    verifierIssues: {
      type: "array",
      maxItems: MAX_ISSUES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_CHECK_LENGTH },
          message: { type: "string", minLength: 1, maxLength: MAX_ISSUE_TEXT },
          file: { type: "string", minLength: 1, maxLength: 4_096 }
        }
      }
    },
    allowedFiles: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FILES,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    preserveFiles: {
      type: "array",
      maxItems: MAX_FILES,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    repairRound: { type: "integer", minimum: 1 }
  }
} as const);
