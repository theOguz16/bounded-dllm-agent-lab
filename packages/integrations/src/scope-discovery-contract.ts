export const SCOPE_DISCOVERY_CONTRACT_VERSION = "scope-discovery/v1" as const;

export type ScopeDiscoveryProposal = Readonly<{
  schemaVersion: typeof SCOPE_DISCOVERY_CONTRACT_VERSION;
  candidateSourceFiles: readonly string[];
  candidateTestFiles: readonly string[];
  candidateSymbols: readonly string[];
  reason: string;
}>;

export class ScopeDiscoveryContractError extends Error {
  readonly code = "scope_discovery_contract_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScopeDiscoveryContractError";
  }
}

const EXACT_KEYS = [
  "candidateSourceFiles",
  "candidateSymbols",
  "candidateTestFiles",
  "reason",
  "schemaVersion"
] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MAX_FILES = 32;
const MAX_SYMBOLS = 64;
const MAX_REASON = 2_000;

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScopeDiscoveryContractError("Scope discovery output must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ScopeDiscoveryContractError("Scope discovery output must be a plain data object.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ScopeDiscoveryContractError("Scope discovery output must not contain symbol properties.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) {
      throw new ScopeDiscoveryContractError("Scope discovery output must not contain accessors.");
    }
  }
  const keys = Object.keys(descriptors).sort();
  if (keys.join("\u0000") !== [...EXACT_KEYS].sort().join("\u0000")) {
    throw new ScopeDiscoveryContractError("Scope discovery output must contain the exact contract fields.");
  }
  return value as Record<string, unknown>;
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
    throw new ScopeDiscoveryContractError(`${field} contains an invalid repository-relative path.`);
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
    throw new ScopeDiscoveryContractError(`${field} contains a repository path escape or alias.`);
  }
  return normalized;
}

function normalizePathArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    throw new ScopeDiscoveryContractError(`${field} must be an array with at most ${MAX_FILES} paths.`);
  }
  const normalized = value.map((entry) => normalizePath(entry, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new ScopeDiscoveryContractError(`${field} must not contain duplicates.`);
  }
  return normalized.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeSymbols(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SYMBOLS) {
    throw new ScopeDiscoveryContractError(`candidateSymbols must be an array with at most ${MAX_SYMBOLS} entries.`);
  }
  const symbols = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 256 ||
      entry.trim() !== entry ||
      CONTROL.test(entry)
    ) {
      throw new ScopeDiscoveryContractError("candidateSymbols must contain bounded non-empty strings.");
    }
    return entry;
  });
  if (new Set(symbols).size !== symbols.length) {
    throw new ScopeDiscoveryContractError("candidateSymbols must not contain duplicates.");
  }
  return symbols.sort((left, right) => left.localeCompare(right, "en"));
}

export function parseScopeDiscoveryProposal(value: unknown): ScopeDiscoveryProposal {
  const record = plainObject(value);
  if (record.schemaVersion !== SCOPE_DISCOVERY_CONTRACT_VERSION) {
    throw new ScopeDiscoveryContractError(
      `schemaVersion must be ${SCOPE_DISCOVERY_CONTRACT_VERSION}.`
    );
  }
  const candidateSourceFiles = normalizePathArray(record.candidateSourceFiles, "candidateSourceFiles");
  const candidateTestFiles = normalizePathArray(record.candidateTestFiles, "candidateTestFiles");
  const overlap = candidateSourceFiles.filter((file) => candidateTestFiles.includes(file));
  if (overlap.length > 0) {
    throw new ScopeDiscoveryContractError("Source and test candidates must not overlap.");
  }
  if (candidateSourceFiles.length + candidateTestFiles.length === 0) {
    throw new ScopeDiscoveryContractError("Scope discovery must propose at least one candidate file.");
  }
  const candidateSymbols = normalizeSymbols(record.candidateSymbols);
  if (
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0 ||
    record.reason.trim() !== record.reason ||
    record.reason.length > MAX_REASON ||
    CONTROL.test(record.reason)
  ) {
    throw new ScopeDiscoveryContractError(`reason must be a bounded non-empty string up to ${MAX_REASON} characters.`);
  }
  return Object.freeze({
    schemaVersion: SCOPE_DISCOVERY_CONTRACT_VERSION,
    candidateSourceFiles: Object.freeze(candidateSourceFiles),
    candidateTestFiles: Object.freeze(candidateTestFiles),
    candidateSymbols: Object.freeze(candidateSymbols),
    reason: record.reason
  });
}

export const SCOPE_DISCOVERY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "candidateSourceFiles",
    "candidateTestFiles",
    "candidateSymbols",
    "reason"
  ],
  properties: {
    schemaVersion: {
      type: "string",
      enum: [SCOPE_DISCOVERY_CONTRACT_VERSION]
    },
    candidateSourceFiles: {
      type: "array",
      items: { type: "string" }
    },
    candidateTestFiles: {
      type: "array",
      items: { type: "string" }
    },
    candidateSymbols: {
      type: "array",
      items: { type: "string" }
    },
    reason: {
      type: "string"
    }
  }
} as const);
