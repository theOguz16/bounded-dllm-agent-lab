import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";
import { hashCanonicalJson } from "./agent-event-ledger.js";
import { canonicalizeRepositoryRelativePath } from "./runtime-contract-foundation.js";

export const CANONICAL_POLICY_SCHEMA_VERSION = "1" as const;
export const CANONICAL_POLICY_COMPILER_VERSION = "canonical-policy-compiler/v1" as const;

export type CanonicalPolicyDisposition = "deny" | "human_review";
export type CanonicalPolicyPair = Readonly<{ source: string; requires: string; reason: string;
  changedWhenContains: readonly string[] }>;
export type CanonicalSensitiveRule = Readonly<{
  pattern: string; matchedPaths: readonly string[]; disposition: CanonicalPolicyDisposition;
}>;
export type CanonicalOwnershipRule = Readonly<{
  pattern: string; matchedPaths: readonly string[]; authorities: readonly string[];
}>;
export type CanonicalPolicyAuthorityIssuer = Readonly<{ issuerId: string; publicKey: string }>;
export type CanonicalCompiledPolicy = Readonly<{
  schemaVersion: typeof CANONICAL_POLICY_SCHEMA_VERSION;
  compilerVersion: typeof CANONICAL_POLICY_COMPILER_VERSION;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  pairedFiles: readonly CanonicalPolicyPair[];
  sensitiveContentPatterns: readonly string[];
  sensitiveRules: readonly CanonicalSensitiveRule[];
  ownershipRules: readonly CanonicalOwnershipRule[];
  authorityIssuers: readonly CanonicalPolicyAuthorityIssuer[];
  sourcePolicyHash: string;
  repositorySnapshotHash: string;
  compiledPolicyHash: string;
}>;

export type CanonicalPolicyAuthority = Readonly<{
  authorityVersion: "canonical-policy-authority/v1"; issuerId: string; actorId: string;
  authorities: readonly string[]; compiledPolicyHash: string; repositoryIdentityHash: string;
  taskId: string | null; signature: string; authorityHash: string;
}>;

export type CompileCanonicalPolicyInput = Readonly<{
  repositoryPath: string;
  policyFilePath?: string;
  policyDocument?: unknown;
}>;

export type CanonicalPolicyEvaluation = Readonly<{
  decision: "allow" | "deny" | "human_review";
  reasonCodes: readonly string[];
  files: readonly string[];
  evaluationHash: string;
}>;
export type CanonicalScopeViolation = Readonly<{
  file: string;
  code: "canonical_policy_forbidden_path" | "canonical_policy_path_not_allowed";
}>;

type Plain = Record<string, unknown>;
const HASH = /^sha256:[0-9a-f]{64}$/;
const AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POLICY_FIELDS = new Set([
  "schemaVersion", "allowed_paths", "forbidden_paths", "paired_files",
  "sensitive_patterns", "sensitive_paths", "ownership_rules", "ownership",
  "owner_aliases", "required_tests", "required_test_mappings", "module_boundaries",
  "missing_authority_rules", "authority_issuers"
]);
const UNSUPPORTED_POLICY_FIELDS = new Set([
  "required_tests", "required_test_mappings", "module_boundaries",
  "missing_authority_rules", "owner_aliases"
]);

export class CanonicalPolicyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plain(value: unknown, label: string): Plain {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalPolicyError("canonical_policy_schema_invalid", `${label} must be an object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => entry.get || entry.set)) {
    throw new CanonicalPolicyError("canonical_policy_schema_invalid", `${label} cannot contain accessors.`);
  }
  return value as Plain;
}

function normalizePattern(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      /[\u0001-\u001f\u007f]/.test(value)) {
    throw new CanonicalPolicyError("canonical_policy_path_invalid", `${field} contains an invalid path pattern.`);
  }
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new CanonicalPolicyError("canonical_policy_path_invalid", `${field} must be repository-relative.`);
  }
  try { minimatch("policy-probe", normalized, { dot: true, nonegate: true }); }
  catch { throw new CanonicalPolicyError("canonical_policy_glob_invalid", `${field} contains an invalid glob.`); }
  return normalized;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CanonicalPolicyError("canonical_policy_schema_invalid", `${field} must be a string array.`);
  }
  return [...new Set(value.map((entry, index) => normalizePattern(entry, `${field}[${index}]`)))].sort();
}

function credentialIdentifierList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CanonicalPolicyError("canonical_policy_schema_invalid", `${field} must be a string array.`);
  }
  return [...new Set(value.map((entry, index) => {
    const normalized = entry.trim().replace(/\s*[:=]\s*$/, "");
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) throw new CanonicalPolicyError(
      "canonical_policy_sensitive_pattern_invalid", `${field}[${index}] must be a credential identifier.`);
    return normalized;
  }))].sort();
}

function conditionList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) =>
    typeof entry !== "string" || entry.trim().length === 0 || entry.length > 160)) {
    throw new CanonicalPolicyError("canonical_policy_pair_invalid", `${field} must be a non-empty string array.`);
  }
  return [...new Set((value as string[]).map((entry) => entry.normalize("NFC")))].sort();
}

function optionalArray(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CanonicalPolicyError(
    "canonical_policy_schema_invalid", `${field} must be an array.`);
  return value;
}

function inventory(repositoryPath: string): { paths: string[]; snapshotHash: string } {
  const root = fs.realpathSync(repositoryPath);
  if (!fs.statSync(root).isDirectory()) throw new CanonicalPolicyError(
    "canonical_policy_repository_invalid", "Policy repository must be a directory.");
  const records: Array<{ path: string; kind: "file" | "symlink"; mode: number; targetHash: string | null }> = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b, "en"))) {
      if (relative === "" && name === ".git") continue;
      const absolute = path.join(directory, name);
      const child = relative === "" ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { walk(absolute, child); continue; }
      const canonical = canonicalizeRepositoryRelativePath(child.normalize("NFC").replaceAll("\\", "/"));
      if (stat.isSymbolicLink()) {
        let target: string;
        try { target = fs.realpathSync(absolute); }
        catch { throw new CanonicalPolicyError("canonical_policy_symlink_escape", `Policy inventory symlink is unresolved: ${canonical}`); }
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new CanonicalPolicyError(
          "canonical_policy_symlink_escape", `Policy inventory symlink escapes the repository: ${canonical}`);
        records.push({ path: canonical, kind: "symlink", mode: stat.mode & 0o777,
          targetHash: `sha256:${createHash("sha256").update(fs.readlinkSync(absolute)).digest("hex")}` });
      } else if (stat.isFile()) {
        records.push({ path: canonical, kind: "file", mode: stat.mode & 0o777, targetHash: null });
      }
    }
  };
  walk(root, "");
  records.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { paths: records.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    snapshotHash: hashCanonicalJson(records) };
}

function matches(files: readonly string[], patterns: readonly string[]): string[] {
  return files.filter((file) => patterns.some((pattern) =>
    minimatch(file, pattern, { dot: true, nonegate: true, nocase: false })));
}

export function matchCanonicalPolicyPattern(file: string, pattern: string): boolean {
  try {
    const canonicalFile = canonicalizeRepositoryRelativePath(file.normalize("NFC").replaceAll("\\", "/"));
    const normalizedPattern = normalizePattern(pattern, "pattern");
    return minimatch(canonicalFile, normalizedPattern, { dot: true, nonegate: true, nocase: false });
  } catch { return false; }
}

export function evaluateCanonicalScopePatterns(input: Readonly<{
  changedFiles: readonly string[];
  allowedPatterns: readonly string[];
  forbiddenPatterns: readonly string[];
  allowUnlistedWhenEmpty?: boolean;
}>): readonly CanonicalScopeViolation[] {
  const violations: CanonicalScopeViolation[] = [];
  const changed: string[] = [];
  for (const raw of [...new Set(input.changedFiles)].sort()) {
    try {
      changed.push(canonicalizeRepositoryRelativePath(raw.normalize("NFC").replaceAll("\\", "/")));
    } catch {
      violations.push({ file: raw, code: "canonical_policy_path_not_allowed" });
    }
  }
  for (const file of changed) {
    if (input.forbiddenPatterns.some((pattern) => matchCanonicalPolicyPattern(file, pattern))) {
      violations.push({ file, code: "canonical_policy_forbidden_path" });
    } else if (!(input.allowUnlistedWhenEmpty && input.allowedPatterns.length === 0) &&
        !input.allowedPatterns.some((pattern) => matchCanonicalPolicyPattern(file, pattern))) {
      violations.push({ file, code: "canonical_policy_path_not_allowed" });
    }
  }
  return deepFreeze(violations);
}

function readPolicy(input: CompileCanonicalPolicyInput): { document: Plain; sourcePolicyHash: string } {
  if ((input.policyFilePath === undefined) === (input.policyDocument === undefined)) {
    throw new CanonicalPolicyError("canonical_policy_source_invalid",
      "Provide exactly one policyFilePath or policyDocument.");
  }
  if (input.policyFilePath !== undefined) {
    const root = fs.realpathSync(input.repositoryPath);
    const requested = path.resolve(root, input.policyFilePath);
    const real = fs.realpathSync(requested);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new CanonicalPolicyError(
      "canonical_policy_path_invalid", "Policy file must be inside the repository.");
    const bytes = fs.readFileSync(real);
    const parsed = parseDocument(bytes.toString("utf8"), { strict: true, uniqueKeys: true });
    if (parsed.errors.length > 0) throw new CanonicalPolicyError(
      "canonical_policy_yaml_invalid", "Policy YAML is malformed or contains duplicate keys.");
    return { document: plain(parsed.toJS({ maxAliasCount: 0 }), "Policy"),
      sourcePolicyHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }
  const document = structuredClone(input.policyDocument);
  return { document: plain(document, "Policy"), sourcePolicyHash: hashCanonicalJson(document) };
}

export function compileCanonicalPolicy(input: CompileCanonicalPolicyInput): CanonicalCompiledPolicy {
  const top = plain(input, "Compiler input");
  if (Object.keys(top).some((field) => !["repositoryPath", "policyFilePath", "policyDocument"].includes(field))) {
    throw new CanonicalPolicyError("canonical_policy_input_unknown_field", "Compiler input contains an unknown field.");
  }
  const { document, sourcePolicyHash } = readPolicy(input);
  const unknown = Object.keys(document).filter((field) => !POLICY_FIELDS.has(field));
  if (unknown.length > 0) throw new CanonicalPolicyError(
    "canonical_policy_unknown_field", `Policy contains unknown fields: ${unknown.sort().join(", ")}.`);
  const unsupported = Object.keys(document).filter((field) =>
    UNSUPPORTED_POLICY_FIELDS.has(field));
  if (unsupported.length > 0) throw new CanonicalPolicyError(
    "unsupported_policy_field", `Canonical policy field is unsupported: ${unsupported.sort().join(", ")}.`);
  if (document.schemaVersion !== CANONICAL_POLICY_SCHEMA_VERSION) throw new CanonicalPolicyError(
    "canonical_policy_schema_version_unsupported", "Policy schemaVersion must be 1.");
  const allowedPatterns = stringList(document.allowed_paths, "allowed_paths");
  const forbiddenPatterns = stringList(document.forbidden_paths, "forbidden_paths");
  if (allowedPatterns.length === 0) throw new CanonicalPolicyError(
    "canonical_policy_empty_allowlist", "Policy allowed_paths cannot be empty.");
  const repo = inventory(input.repositoryPath);
  const allowed = matches(repo.paths, allowedPatterns);
  const forbidden = matches(repo.paths, forbiddenPatterns);
  const forbiddenSet = new Set(forbidden);
  const finalAllowed = allowed.filter((file) => !forbiddenSet.has(file)).sort();

  const pairs: CanonicalPolicyPair[] = [];
  for (const [index, raw] of optionalArray(document.paired_files, "paired_files").entries()) {
    const rule = plain(raw, `paired_files[${index}]`);
    if (Object.keys(rule).some((field) => !["source", "requires", "reason", "changed_when_contains"].includes(field)) ||
        typeof rule.source !== "string" || typeof rule.requires !== "string" ||
        (rule.reason !== undefined && typeof rule.reason !== "string")) throw new CanonicalPolicyError(
      "canonical_policy_pair_invalid", `paired_files[${index}] is invalid.`);
    const sources = matches(repo.paths, [normalizePattern(rule.source, `paired_files[${index}].source`)]);
    const required = matches(repo.paths, [normalizePattern(rule.requires, `paired_files[${index}].requires`)]);
    for (const source of sources) for (const requires of required) {
      if (source === requires) throw new CanonicalPolicyError(
        "canonical_policy_rule_conflict", "A paired-file rule cannot require itself.");
      pairs.push({ source, requires, reason: typeof rule.reason === "string" ? rule.reason : "Paired file required.",
        changedWhenContains: conditionList(rule.changed_when_contains, `paired_files[${index}].changed_when_contains`) });
    }
  }

  const sensitiveRules: CanonicalSensitiveRule[] = [];
  const sensitiveContentPatterns = credentialIdentifierList(
    document.sensitive_patterns ?? [], "sensitive_patterns");
  for (const [index, raw] of optionalArray(document.sensitive_paths, "sensitive_paths").entries()) {
    const rule = plain(raw, `sensitive_paths[${index}]`);
    if (Object.keys(rule).some((field) => !["pattern", "disposition"].includes(field)) ||
        typeof rule.pattern !== "string" || !["deny", "human_review"].includes(rule.disposition as string)) {
      throw new CanonicalPolicyError("canonical_policy_sensitive_rule_invalid", `sensitive_paths[${index}] is invalid.`);
    }
    const pattern = normalizePattern(rule.pattern, `sensitive_paths[${index}].pattern`);
    sensitiveRules.push({ pattern, matchedPaths: matches(repo.paths, [pattern]),
      disposition: rule.disposition as CanonicalPolicyDisposition });
  }
  const sensitiveByPattern = new Map<string, CanonicalSensitiveRule>();
  for (const rule of sensitiveRules) {
    const prior = sensitiveByPattern.get(rule.pattern);
    if (prior && prior.disposition !== rule.disposition) throw new CanonicalPolicyError(
      "canonical_policy_rule_conflict", `Sensitive rule has conflicting dispositions: ${rule.pattern}.`);
    sensitiveByPattern.set(rule.pattern, rule);
  }

  const ownershipRules: CanonicalOwnershipRule[] = [];
  const ownership = document.ownership === undefined ? {} : plain(document.ownership, "ownership");
  for (const [patternValue, authorityValue] of Object.entries(ownership)) {
    if (typeof authorityValue !== "string" || !AUTHORITY.test(authorityValue)) throw new CanonicalPolicyError(
      "canonical_policy_ownership_rule_invalid", "Legacy ownership rule is invalid.");
    const pattern = normalizePattern(patternValue, "ownership pattern");
    ownershipRules.push({ pattern, matchedPaths: matches(repo.paths, [pattern]), authorities: [authorityValue] });
  }
  for (const [index, raw] of optionalArray(document.ownership_rules, "ownership_rules").entries()) {
    const rule = plain(raw, `ownership_rules[${index}]`);
    if (Object.keys(rule).some((field) => !["pattern", "authorities"].includes(field)) ||
        typeof rule.pattern !== "string" || !Array.isArray(rule.authorities) || rule.authorities.length === 0 ||
        rule.authorities.some((entry) => typeof entry !== "string" || !AUTHORITY.test(entry))) {
      throw new CanonicalPolicyError("canonical_policy_ownership_rule_invalid", `ownership_rules[${index}] is invalid.`);
    }
    const pattern = normalizePattern(rule.pattern, `ownership_rules[${index}].pattern`);
    ownershipRules.push({ pattern, matchedPaths: matches(repo.paths, [pattern]),
      authorities: [...new Set(rule.authorities as string[])].sort() });
  }
  const ownershipByPattern = new Map<string, CanonicalOwnershipRule>();
  for (const rule of ownershipRules) {
    const prior = ownershipByPattern.get(rule.pattern);
    if (prior && prior.authorities.join("\0") !== rule.authorities.join("\0")) {
      throw new CanonicalPolicyError("canonical_policy_rule_conflict",
        `Ownership rule has conflicting authorities: ${rule.pattern}.`);
    }
    ownershipByPattern.set(rule.pattern, rule);
  }
  const authorityIssuers: CanonicalPolicyAuthorityIssuer[] = [];
  for (const [index, raw] of optionalArray(document.authority_issuers, "authority_issuers").entries()) {
    const issuer = plain(raw, `authority_issuers[${index}]`);
    if (Object.keys(issuer).some((field) => !["issuerId", "publicKey"].includes(field)) ||
        !AUTHORITY.test(issuer.issuerId as string) || typeof issuer.publicKey !== "string") {
      throw new CanonicalPolicyError("canonical_policy_authority_issuer_invalid",
        `authority_issuers[${index}] is invalid.`);
    }
    try {
      if (createPublicKey(issuer.publicKey).asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch { throw new CanonicalPolicyError("canonical_policy_authority_issuer_invalid",
      `authority_issuers[${index}] must contain an Ed25519 public key.`); }
    if (authorityIssuers.some((entry) => entry.issuerId === issuer.issuerId)) throw new CanonicalPolicyError(
      "canonical_policy_rule_conflict", "Authority issuer IDs must be unique.");
    authorityIssuers.push({ issuerId: issuer.issuerId as string, publicKey: issuer.publicKey });
  }
  const pairMap = new Map<string, CanonicalPolicyPair>();
  for (const pair of pairs) {
    const key = `${pair.source}\0${pair.requires}\0${pair.changedWhenContains.join("\0")}`;
    const prior = pairMap.get(key);
    if (!prior || pair.reason.localeCompare(prior.reason, "en") < 0) pairMap.set(key, pair);
  }
  const core = {
    schemaVersion: CANONICAL_POLICY_SCHEMA_VERSION,
    compilerVersion: CANONICAL_POLICY_COMPILER_VERSION,
    allowedPaths: finalAllowed,
    forbiddenPaths: forbidden.sort(),
    pairedFiles: [...pairMap.values()].sort((a, b) =>
      `${a.source}\0${a.requires}`.localeCompare(`${b.source}\0${b.requires}`, "en")),
    sensitiveContentPatterns,
    sensitiveRules: [...sensitiveByPattern.values()].sort((a, b) => a.pattern.localeCompare(b.pattern, "en")),
    ownershipRules: [...ownershipByPattern.values()].sort((a, b) => a.pattern.localeCompare(b.pattern, "en")),
    authorityIssuers: authorityIssuers.sort((a, b) => a.issuerId.localeCompare(b.issuerId, "en")),
    sourcePolicyHash,
    repositorySnapshotHash: repo.snapshotHash
  };
  return deepFreeze({ ...core, compiledPolicyHash: hashCanonicalJson(core) });
}

export function verifyCanonicalCompiledPolicy(
  policy: CanonicalCompiledPolicy, repositoryPath: string
): boolean {
  try {
    if (policy.schemaVersion !== CANONICAL_POLICY_SCHEMA_VERSION ||
        policy.compilerVersion !== CANONICAL_POLICY_COMPILER_VERSION ||
        !HASH.test(policy.sourcePolicyHash) || !HASH.test(policy.repositorySnapshotHash) ||
        !HASH.test(policy.compiledPolicyHash) || inventory(repositoryPath).snapshotHash !== policy.repositorySnapshotHash) {
      return false;
    }
    const { compiledPolicyHash, ...core } = policy;
    return compiledPolicyHash === hashCanonicalJson(core);
  } catch { return false; }
}

export function canonicalPolicyRepositoryIdentity(repositoryPath: string): string {
  return hashCanonicalJson({ repository: fs.realpathSync(repositoryPath) });
}

export function createCanonicalPolicyAuthority(input: Readonly<{ issuerId: string; actorId: string;
  authorities: readonly string[]; compiledPolicyHash: string; repositoryIdentityHash: string;
  taskId?: string; privateKey: string }>): CanonicalPolicyAuthority {
  if (!input || !AUTHORITY.test(input.issuerId) || !AUTHORITY.test(input.actorId) ||
      !Array.isArray(input.authorities) || input.authorities.some((entry) => !AUTHORITY.test(entry)) ||
      !HASH.test(input.compiledPolicyHash) || !HASH.test(input.repositoryIdentityHash) ||
      (input.taskId !== undefined && !AUTHORITY.test(input.taskId)) ||
      typeof input.privateKey !== "string") {
    throw new CanonicalPolicyError("canonical_policy_authority_invalid", "Trusted authority input is invalid.");
  }
  const core = { authorityVersion: "canonical-policy-authority/v1" as const,
    issuerId: input.issuerId, actorId: input.actorId,
    authorities: [...new Set(input.authorities)].sort(), compiledPolicyHash: input.compiledPolicyHash,
    repositoryIdentityHash: input.repositoryIdentityHash, taskId: input.taskId ?? null };
  let signature: string;
  try {
    const key = createPrivateKey(input.privateKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    signature = sign(null, Buffer.from(hashCanonicalJson(core), "utf8"), key).toString("base64url");
  } catch { throw new CanonicalPolicyError("canonical_policy_authority_invalid",
    "Authority must be signed by an Ed25519 issuer key."); }
  return deepFreeze({ ...core, signature,
    authorityHash: hashCanonicalJson({ ...core, signature }) });
}

function verifiedAuthorities(authority: CanonicalPolicyAuthority | undefined,
  expected: Readonly<{ compiledPolicyHash: string; repositoryIdentityHash?: string; taskId?: string;
    authorityIssuers: readonly CanonicalPolicyAuthorityIssuer[] }>): Set<string> | null {
  if (!authority || Object.keys(authority).sort().join("\0") !== ["actorId", "authorities",
      "authorityHash", "authorityVersion", "compiledPolicyHash", "issuerId", "repositoryIdentityHash",
      "signature", "taskId"].sort().join("\0") ||
      authority.authorityVersion !== "canonical-policy-authority/v1" ||
      !AUTHORITY.test(authority.issuerId) || !AUTHORITY.test(authority.actorId) ||
      !Array.isArray(authority.authorities) || authority.authorities.some((entry) => !AUTHORITY.test(entry)) ||
      !HASH.test(authority.compiledPolicyHash) || !HASH.test(authority.repositoryIdentityHash) ||
      (authority.taskId !== null && !AUTHORITY.test(authority.taskId)) ||
      !/^[A-Za-z0-9_-]{80,120}$/.test(authority.signature) || !HASH.test(authority.authorityHash) ||
      authority.compiledPolicyHash !== expected.compiledPolicyHash ||
      (expected.repositoryIdentityHash !== undefined && authority.repositoryIdentityHash !== expected.repositoryIdentityHash) ||
      (expected.taskId !== undefined && authority.taskId !== expected.taskId)) return null;
  const issuer = expected.authorityIssuers.find((entry) => entry.issuerId === authority.issuerId);
  if (!issuer) return null;
  const normalized = [...new Set(authority.authorities)].sort();
  if (normalized.length !== authority.authorities.length ||
      normalized.some((entry, index) => entry !== authority.authorities[index])) return null;
  const core = { authorityVersion: authority.authorityVersion, issuerId: authority.issuerId,
    actorId: authority.actorId, authorities: normalized, compiledPolicyHash: authority.compiledPolicyHash,
    repositoryIdentityHash: authority.repositoryIdentityHash, taskId: authority.taskId };
  try {
    if (!verify(null, Buffer.from(hashCanonicalJson(core), "utf8"), createPublicKey(issuer.publicKey),
      Buffer.from(authority.signature, "base64url"))) return null;
  } catch { return null; }
  if (authority.authorityHash !== hashCanonicalJson({ ...core, signature: authority.signature })) return null;
  return new Set(normalized);
}

function assignedValue(line: string, identifier: string): string | null {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:(?:export\\s+)?(?:const|let|var)\\s+)?` +
    `(?:[A-Za-z_$][A-Za-z0-9_$]*\\.)?["']?${escaped}["']?\\s*[:=]\\s*(.+?)\\s*$`, "i")
    .exec(line)?.[1] ?? null;
}

function isLiteralCredential(expression: string): boolean {
  const value = expression.trim().replace(/[,;]\s*$/, "");
  if (/^(?:process\.env|Deno\.env|getenv\s*\(|import\.meta\.env)/i.test(value)) return false;
  const match = /^(?:["'`](.*)["'`])$/.exec(value);
  const literal = (match?.[1] ?? value).trim();
  if (!literal || /^<[^>]+>$/.test(literal) || /^\$\{[^}]+\}$/.test(literal) ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(literal) ||
      /^(?:placeholder|redacted|change-?me|dummy|example(?:-value)?|none|null|undefined|\*+)$/i.test(literal)) return false;
  if (match === null && /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\[|\().*)?$/.test(literal)) return false;
  return true;
}

export function containsCanonicalSensitiveLiteral(content: string,
  identifiers: readonly string[]): boolean {
  return content.split(/\r?\n/).some((line) => identifiers.some((rawIdentifier) => {
    const identifier = rawIdentifier.trim().replace(/\s*[:=]\s*$/, "");
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) return false;
    const value = assignedValue(line, identifier);
    return value !== null && isLiteralCredential(value);
  }));
}

export function canonicalPolicyConditionMatches(content: string | undefined,
  signals: readonly string[]): boolean {
  if (signals.length === 0) return true;
  if (content === undefined) return false;
  const normalized = content.toLowerCase();
  return signals.some((signal) => normalized.includes(signal.toLowerCase()));
}

export function canonicalPolicyOwnershipReason(required: readonly string[],
  granted: ReadonlySet<string> | null): "canonical_policy_ownership_authority_missing" |
    "canonical_policy_ownership_mismatch" | null {
  if (granted === null) return "canonical_policy_ownership_authority_missing";
  return required.some((entry) => granted.has(entry)) ? null : "canonical_policy_ownership_mismatch";
}

export type CanonicalPolicyMutationRuleFinding = Readonly<{
  code: "canonical_policy_paired_file_missing" | "canonical_policy_conditional_evidence_missing" |
    "canonical_policy_sensitive_path" | "canonical_policy_sensitive_review" |
    "canonical_policy_sensitive_literal" | "canonical_policy_ownership_authority_missing" |
    "canonical_policy_ownership_mismatch";
  disposition: "deny" | "human_review"; file: string; relatedFile: string | null;
}>;

export function evaluateCanonicalMutationPolicyRules(input: Readonly<{
  changedFiles: readonly string[];
  contentsByFile?: Readonly<Record<string, string>>;
  pairedFiles: readonly CanonicalPolicyPair[];
  sensitiveContentPatterns: readonly string[];
  sensitiveRules: readonly CanonicalSensitiveRule[];
  ownershipRules: readonly CanonicalOwnershipRule[];
  grantedAuthorities: ReadonlySet<string> | null;
}>): readonly CanonicalPolicyMutationRuleFinding[] {
  const changed = new Set(input.changedFiles);
  const findings: CanonicalPolicyMutationRuleFinding[] = [];
  for (const pair of input.pairedFiles) {
    if (!changed.has(pair.source) || changed.has(pair.requires)) continue;
    const content = input.contentsByFile?.[pair.source];
    if (pair.changedWhenContains.length > 0 && content === undefined) {
      findings.push({ code: "canonical_policy_conditional_evidence_missing", disposition: "deny",
        file: pair.source, relatedFile: pair.requires }); continue;
    }
    if (!canonicalPolicyConditionMatches(content, pair.changedWhenContains)) continue;
    findings.push({ code: "canonical_policy_paired_file_missing", disposition: "deny",
      file: pair.source, relatedFile: pair.requires });
  }
  for (const rule of input.sensitiveRules) {
    for (const file of rule.matchedPaths.filter((entry) => changed.has(entry))) findings.push({
      code: rule.disposition === "deny" ? "canonical_policy_sensitive_path" : "canonical_policy_sensitive_review",
      disposition: rule.disposition === "deny" ? "deny" : "human_review", file, relatedFile: null });
  }
  for (const [file, content] of Object.entries(input.contentsByFile ?? {})) {
    if (!changed.has(file)) continue;
    for (const pattern of input.sensitiveContentPatterns) if (
      containsCanonicalSensitiveLiteral(content, [pattern])) findings.push({
        code: "canonical_policy_sensitive_literal", disposition: "deny", file, relatedFile: null });
  }
  for (const rule of input.ownershipRules) {
    const reason = canonicalPolicyOwnershipReason(rule.authorities, input.grantedAuthorities);
    if (reason === null) continue;
    for (const file of rule.matchedPaths.filter((entry) => changed.has(entry))) findings.push({
      code: reason, disposition: "deny", file, relatedFile: null });
  }
  return deepFreeze(findings);
}

export function evaluateCanonicalPolicy(input: Readonly<{
  policy: CanonicalCompiledPolicy;
  changedFiles: readonly string[];
  authority?: CanonicalPolicyAuthority;
  repositoryIdentityHash?: string;
  taskId?: string;
  mutation?: Readonly<{ claims: readonly unknown[] }>;
}>): CanonicalPolicyEvaluation {
  const changed = [...new Set(input.changedFiles.map(canonicalizeRepositoryRelativePath))].sort();
  const reasons = new Set<string>();
  let decision: CanonicalPolicyEvaluation["decision"] = "allow";
  const deny = (code: string) => { reasons.add(code); decision = "deny"; };
  const review = (code: string) => { reasons.add(code); if (decision === "allow") decision = "human_review"; };
  for (const violation of evaluateCanonicalScopePatterns({ changedFiles: changed,
    allowedPatterns: input.policy.allowedPaths, forbiddenPatterns: input.policy.forbiddenPaths })) {
    deny(violation.code);
  }
  const contents = new Map<string, string>();
  for (const claim of input.mutation?.claims ?? []) {
    if (claim && typeof claim === "object" && !Array.isArray(claim)) {
      const record = claim as Record<string, unknown>;
      if (typeof record.file === "string" && typeof record.newContent === "string") {
        contents.set(record.file, record.newContent);
      }
    }
  }
  const authorities = verifiedAuthorities(input.authority, {
    compiledPolicyHash: input.policy.compiledPolicyHash,
    ...(input.repositoryIdentityHash === undefined ? {} : { repositoryIdentityHash: input.repositoryIdentityHash }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    authorityIssuers: input.policy.authorityIssuers
  });
  for (const finding of evaluateCanonicalMutationPolicyRules({ changedFiles: changed,
    contentsByFile: Object.fromEntries(contents), pairedFiles: input.policy.pairedFiles,
    sensitiveContentPatterns: input.policy.sensitiveContentPatterns,
    sensitiveRules: input.policy.sensitiveRules, ownershipRules: input.policy.ownershipRules,
    grantedAuthorities: authorities })) {
    finding.disposition === "deny" ? deny(finding.code) : review(finding.code);
  }
  const core = { decision, reasonCodes: [...reasons].sort(), files: changed,
    compiledPolicyHash: input.policy.compiledPolicyHash,
    authorityHash: input.authority?.authorityHash ?? null };
  return deepFreeze({ decision, reasonCodes: core.reasonCodes, files: changed,
    evaluationHash: hashCanonicalJson(core) });
}
