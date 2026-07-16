/**
 * Phase X.5 validates an already applied repository state. Validation commands
 * run only in a fresh isolated external workspace using the exact Phase V
 * specification; the real repository is never their cwd. A non-passing result
 * after durable validation start restores from the sealed X.2 bundle through
 * the X.4 restoration boundary. Consumption claims are never released. X.5
 * never stages, commits, pushes, invokes a shell, or changes Git history. A
 * finalized receipt proves local apply and validation, not deployment.
 * Incomplete and rollback-failed transactions require recovery; automated
 * crash recovery remains a separate later boundary.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, symlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import type { AdminInvocationDecision } from "./admin-invocation-policy.js";
import type {
  ControlledApplyExecutionAuthorization,
  ControlledApplyExecutionGateInput
} from "./controlled-apply-execution-gate.js";
import {
  inspectControlledRepositoryFileState,
  restoreControlledRepositoryFromRollbackBundle,
  verifyControlledRepositoryApplyReceipt,
  type ControlledRepositoryApplyReceipt,
  type ControlledRepositoryApplyReceiptVerificationResult
} from "./controlled-repository-apply.js";
import {
  inspectControlledRepository,
  type ControlledRepositoryInspection,
  type ControlledRepositoryInspectionResult
} from "./controlled-repository-inspection.js";
import { verifyControlledRollbackBundle } from "./controlled-rollback-bundle.js";
import type { GovernedChangeKind } from "./governed-change-artifact.js";
import {
  buildTemporaryWorkspaceExecutionVerificationEvidence,
  computeTemporaryWorkspaceExecutionSpecificationHash,
  verifyTemporaryWorkspaceExecution,
  type TemporaryWorkspaceExecutionSpecification,
  type TemporaryWorkspaceExecutionVerificationEvidence
} from "./temporary-workspace-execution-verifier.js";

export const CONTROLLED_POST_APPLY_VALIDATION_VERSION = "1" as const;

export type ControlledPostApplyValidationDecision =
  | "controlled_post_apply_validation_finalized"
  | "controlled_post_apply_validation_rolled_back"
  | "controlled_post_apply_validation_blocked"
  | "controlled_post_apply_validation_invalid"
  | "controlled_post_apply_validation_needs_review"
  | "controlled_post_apply_validation_rollback_failed";

export type ControlledPostApplyValidationPolicy = {
  policyVersion: "1";
  requireCurrentX4ApplyReceipt: true;
  requireCommittedX4Transaction: true;
  requireExactAppliedRepositoryState: true;
  requireExactPhaseVValidationSpecification: true;
  requireIsolatedValidationWorkspace: true;
  forbidValidationInRealRepository: true;
  requireValidationWorkspaceOutsideRepository: true;
  requireValidationWorkspaceOutsideGitDirectory: true;
  requireValidationWorkspaceOutsideRegistry: true;
  requireValidationWorkspaceOutsideRollbackBundle: true;
  requireValidationWorkspaceCleanup: true;
  requireRepositoryUnchangedDuringValidation: true;
  rollbackOnValidationFailure: true;
  rollbackOnValidationTimeout: true;
  rollbackOnValidationNeedsReview: true;
  rollbackOnValidationInfrastructureFailureAfterStart: true;
  verifyRollbackAgainstX1Baseline: true;
  neverReleaseConsumptionClaim: true;
  forbidGitIndexMutation: true;
  forbidGitHistoryMutation: true;
  forbidShellExecution: true;
};

const STRICT_POLICY: ControlledPostApplyValidationPolicy = {
  policyVersion: "1",
  requireCurrentX4ApplyReceipt: true,
  requireCommittedX4Transaction: true,
  requireExactAppliedRepositoryState: true,
  requireExactPhaseVValidationSpecification: true,
  requireIsolatedValidationWorkspace: true,
  forbidValidationInRealRepository: true,
  requireValidationWorkspaceOutsideRepository: true,
  requireValidationWorkspaceOutsideGitDirectory: true,
  requireValidationWorkspaceOutsideRegistry: true,
  requireValidationWorkspaceOutsideRollbackBundle: true,
  requireValidationWorkspaceCleanup: true,
  requireRepositoryUnchangedDuringValidation: true,
  rollbackOnValidationFailure: true,
  rollbackOnValidationTimeout: true,
  rollbackOnValidationNeedsReview: true,
  rollbackOnValidationInfrastructureFailureAfterStart: true,
  verifyRollbackAgainstX1Baseline: true,
  neverReleaseConsumptionClaim: true,
  forbidGitIndexMutation: true,
  forbidGitHistoryMutation: true,
  forbidShellExecution: true
};

export type ControlledPostApplyValidationInput = {
  applyReceipt: ControlledRepositoryApplyReceipt;
  authorization: ControlledApplyExecutionAuthorization;
  gateInput: ControlledApplyExecutionGateInput;
  registryDirectoryPath: string;
  validationWorkspaceParentPath: string;
  phaseVExecutionSpecification: TemporaryWorkspaceExecutionSpecification;
  phaseVExecutionVerification: TemporaryWorkspaceExecutionVerificationEvidence;
  policy?: ControlledPostApplyValidationPolicy;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
  maxWorkspaceFileCount?: number;
  maxWorkspaceBytes?: number;
  maxValidationOutputBytes?: number;
};

export type ControlledPostApplyValidationStep =
  TemporaryWorkspaceExecutionVerificationEvidence["steps"][number];

export type ControlledPostApplyValidationIntent = {
  intentVersion: "1";
  consumptionKey: string;
  authorizationHash: string;
  x4ApplyReceiptHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutationHash: string;
  appliedStateHash: string;
  finalScopeHash: string;
  phaseVExecutionVerificationResultHash: string;
  validationSpecificationHash: string;
  expectedInspectionHash: string;
  rollbackManifestHash: string;
  rollbackBundleManifestHash: string;
  rollbackBundleReceiptHash: string;
  policyHash: string;
  intentHash: string;
};

export type ControlledPostApplyValidationRecord = {
  recordVersion: "1";
  intentHash: string;
  decision: "passed" | "failed" | "needs_review" | "invalid" | "infrastructure_failure";
  validationSpecificationHash: string;
  phaseVExecutionVerificationResultHash: string;
  currentExecutionResultHash: string | null;
  steps: readonly ControlledPostApplyValidationStep[];
  requiredStepCount: number;
  completedStepCount: number;
  passedStepCount: number;
  workspaceCleanupRequired: true;
  workspaceCleanupSucceeded: boolean;
  recordHash: string;
};

export type ControlledPostApplyFinalReceipt = {
  receiptVersion: "1";
  outcome: "validated" | "validation_failed_rolled_back" |
    "validation_failed_rollback_failed";
  consumptionKey: string;
  authorizationHash: string;
  x4ApplyReceiptHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutation: {
    changeKind: GovernedChangeKind;
    mutationHash: string;
    changedFiles: readonly string[];
    changedFileCount: number;
  };
  adminResolution: {
    invocationPolicyHash: string;
    invocationAssessmentHash: string;
    invocationDecision: AdminInvocationDecision;
    resolutionKind: "verified_policy_skip" | "model_decision";
    adminDecisionHash: string | null;
  };
  validation: {
    phaseVExecutionVerificationResultHash: string;
    validationSpecificationHash: string;
    currentExecutionResultHash: string | null;
    validationDecision: "passed" | "failed" | "needs_review" | "invalid" |
      "infrastructure_failure";
    requiredStepCount: number;
    completedStepCount: number;
    passedStepCount: number;
    workspaceCleanupSucceeded: boolean;
  };
  repository: {
    beforeApplyInspectionHash: string;
    x4AppliedStateHash: string;
    x4FinalScopeHash: string;
    finalRepositoryState: "validated_applied_state" | "restored_x1_baseline" |
      "unsafe_unknown_state";
    finalInspectionHash: string | null;
  };
  rollback: {
    attempted: boolean;
    succeeded: boolean | null;
    rollbackManifestHash: string;
    rollbackBundleManifestHash: string;
    rollbackBundleReceiptHash: string;
    rollbackPayloadRootHash: string;
  };
  execution: {
    validationExecuted: boolean;
    validationExecutedInRealRepository: false;
    repositoryWritePerformedByValidation: boolean;
    rollbackWritePerformed: boolean;
    consumptionClaimReleased: false;
    gitIndexMutated: false;
    gitHistoryMutated: false;
    shellExecuted: false;
    commitCreated: false;
    pushExecuted: false;
  };
  receiptHash: string;
};

export type ControlledPostApplyValidationIssueSeverity = "review" | "error";
export type ControlledPostApplyValidationIssue = {
  code: string;
  message: string;
  severity: ControlledPostApplyValidationIssueSeverity;
  field?: string;
  filePath?: string;
  hashValue?: string;
};

export type ControlledPostApplyValidationResult = {
  decision: ControlledPostApplyValidationDecision;
  issues: readonly ControlledPostApplyValidationIssue[];
  finalReceipt: ControlledPostApplyFinalReceipt | null;
  x4ReceiptVerification: ControlledRepositoryApplyReceiptVerificationResult | null;
  validationRecord: ControlledPostApplyValidationRecord | null;
  finalRepositoryInspection: ControlledRepositoryInspectionResult | null;
  summary: ValidationSummary;
};

export type ControlledPostApplyFinalReceiptVerificationInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  receipt: ControlledPostApplyFinalReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  authorization: ControlledApplyExecutionAuthorization;
  expectedInspection: ControlledRepositoryInspection;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledPostApplyFinalReceiptVerificationDecision =
  | "controlled_post_apply_final_receipt_current"
  | "controlled_post_apply_final_receipt_stale"
  | "controlled_post_apply_final_receipt_invalid"
  | "controlled_post_apply_final_receipt_requires_recovery";

export type ControlledPostApplyFinalReceiptVerificationResult = {
  decision: ControlledPostApplyFinalReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  registryRecordVerified: boolean;
  terminalMarker: "FINALIZED" | "VALIDATION_ROLLED_BACK" |
    "VALIDATION_ROLLBACK_FAILED" | "INCOMPLETE" | null;
  repositoryStateMatched: boolean;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  summary: FinalVerificationSummary;
};

/** Narrow compatibility helpers for read-only recovery boundaries. */
export function computeControlledPostApplyValidationIntentHash(
  intent: ControlledPostApplyValidationIntent
): string {
  return hashWithout(intent as unknown as PlainRecord, "intentHash");
}

export function computeControlledPostApplyValidationRecordHash(
  record: ControlledPostApplyValidationRecord
): string {
  return hashWithout(record as unknown as PlainRecord, "recordHash");
}

export function computeControlledPostApplyFinalReceiptHash(
  receipt: ControlledPostApplyFinalReceipt
): string {
  return hashWithout(receipt as unknown as PlainRecord, "receiptHash");
}

type ValidationSummary = {
  inputValid: boolean; policyValid: boolean;
  x4ReceiptCurrent: boolean; x4TransactionCommitted: boolean;
  evidenceBindingsMatched: boolean; phaseVSpecificationMatched: boolean;
  validationTransactionCreated: boolean; validationIntentWritten: boolean;
  validationIntentVerified: boolean; validationStarted: boolean;
  workspaceCreated: boolean; workspaceBoundToAppliedState: boolean;
  validationExecuted: boolean; validationPassed: boolean;
  workspaceCleanupRequired: boolean; workspaceCleanupSucceeded: boolean;
  realRepositoryUnchangedDuringValidation: boolean;
  emergencyRollbackExecuted: boolean; emergencyRollbackSucceeded: boolean | null;
  finalReceiptWritten: boolean; finalReceiptVerified: boolean;
  terminalMarker: "FINALIZED" | "VALIDATION_ROLLED_BACK" |
    "VALIDATION_ROLLBACK_FAILED" | null;
  finalRepositoryState: "validated_applied_state" | "restored_x1_baseline" |
    "unsafe_unknown_state" | null;
  consumptionClaimReleased: false; validationExecutedInRealRepository: false;
  gitIndexMutated: false; gitHistoryMutated: false; shellExecuted: false;
  commitCreated: false; pushExecuted: false;
};

type FinalVerificationSummary = {
  x4ApplyReceiptMatched: boolean; authorizationMatched: boolean;
  consumptionKeyMatched: boolean; validationIntentMatched: boolean;
  validationRecordMatched: boolean; finalizedAppliedStateMatched: boolean;
  restoredBaselineMatched: boolean; recoveryRequired: boolean;
  repositoryWritePerformedByVerifier: false; gitMutationPerformedByVerifier: false;
  shellExecutedByVerifier: false;
};

type PlainRecord = Record<string, unknown>;
type FailureKind = "invalid" | "review" | "blocked";
type ValidationPaths = {
  registry: string; validations: string; transaction: string;
  intent: string; started: string; record: string; receipt: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_WORKSPACE_FILES = 100_000;
const MAX_WORKSPACE_FILES = 1_000_000;
const DEFAULT_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_NODES = 400_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const INPUT_FIELDS = [
  "applyReceipt", "authorization", "gateInput", "registryDirectoryPath",
  "validationWorkspaceParentPath", "phaseVExecutionSpecification",
  "phaseVExecutionVerification", "policy", "timeoutMs", "maxGitOutputBytes",
  "maxWorkspaceFileCount", "maxWorkspaceBytes", "maxValidationOutputBytes"
] as const;
const VERIFY_FIELDS = [
  "repositoryPath", "registryDirectoryPath", "receipt", "applyReceipt",
  "authorization", "expectedInspection", "timeoutMs", "maxGitOutputBytes"
] as const;
const TERMINALS = [
  "FINALIZED", "VALIDATION_ROLLED_BACK", "VALIDATION_ROLLBACK_FAILED"
] as const;
const execFileAsync = promisify(execFile);

class ValidationFailure extends Error {
  constructor(
    readonly code: string, message: string,
    readonly kind: FailureKind = "invalid", readonly field?: string
  ) { super(message); }
}
class TrustedValidationConfigurationError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY:
Readonly<ControlledPostApplyValidationPolicy> = deepFreeze({ ...STRICT_POLICY });

function initialSummary(): ValidationSummary {
  return {
    inputValid: false, policyValid: false, x4ReceiptCurrent: false,
    x4TransactionCommitted: false, evidenceBindingsMatched: false,
    phaseVSpecificationMatched: false, validationTransactionCreated: false,
    validationIntentWritten: false, validationIntentVerified: false,
    validationStarted: false, workspaceCreated: false,
    workspaceBoundToAppliedState: false, validationExecuted: false,
    validationPassed: false, workspaceCleanupRequired: true,
    workspaceCleanupSucceeded: false, realRepositoryUnchangedDuringValidation: false,
    emergencyRollbackExecuted: false, emergencyRollbackSucceeded: null,
    finalReceiptWritten: false, finalReceiptVerified: false, terminalMarker: null,
    finalRepositoryState: null, consumptionClaimReleased: false,
    validationExecutedInRealRepository: false, gitIndexMutated: false,
    gitHistoryMutated: false, shellExecuted: false, commitCreated: false,
    pushExecuted: false
  };
}

function initialFinalVerificationSummary(): FinalVerificationSummary {
  return {
    x4ApplyReceiptMatched: false, authorizationMatched: false,
    consumptionKeyMatched: false, validationIntentMatched: false,
    validationRecordMatched: false, finalizedAppliedStateMatched: false,
    restoredBaselineMatched: false, recoveryRequired: false,
    repositoryWritePerformedByVerifier: false, gitMutationPerformedByVerifier: false,
    shellExecutedByVerifier: false
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function safeClone(value: unknown, ancestors = new WeakSet<object>(), count = { n: 0 }): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") throw new ValidationFailure(
    "invalid_controlled_post_apply_validation_object", "Unsupported validation evidence."
  );
  if (++count.n > MAX_NODES) throw new ValidationFailure(
    "invalid_controlled_post_apply_validation_object", "Validation evidence is too large."
  );
  if (ancestors.has(value)) throw new ValidationFailure(
    "invalid_controlled_post_apply_validation_object", "Cyclic evidence is invalid."
  );
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new ValidationFailure(
      "invalid_controlled_post_apply_validation_object", "Exotic evidence is invalid."
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new ValidationFailure(
    "controlled_post_apply_validation_symbol_property", "Symbol properties are forbidden."
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (descriptor.get || descriptor.set) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_accessor_property", "Accessor properties are forbidden."
    );
  }
  ancestors.add(value);
  try {
    if (array) {
      if (Object.keys(value).length !== value.length) throw new ValidationFailure(
        "invalid_controlled_post_apply_validation_object", "Sparse arrays are invalid."
      );
      return value.map((entry) => safeClone(entry, ancestors, count));
    }
    const result: PlainRecord = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) throw new ValidationFailure(
        "invalid_controlled_post_apply_validation_object", "Hidden properties are invalid."
      );
      result[key] = safeClone(descriptor.value, ancestors, count);
    }
    return result;
  } finally { ancestors.delete(value); }
}

function exactObject(
  value: unknown, allowed: readonly string[], label: string,
  required: readonly string[] = allowed
): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationFailure(
      "invalid_controlled_post_apply_validation_input", `${label} is invalid.`
    );
  }
  const record = value as PlainRecord;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new ValidationFailure(
    "unknown_controlled_post_apply_validation_field", `${label} has an unknown field.`,
    "invalid", key
  );
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new ValidationFailure(
      "missing_controlled_post_apply_validation_field", `${label} is missing a field.`,
      "invalid", key
    );
  }
  return record;
}

function normalizePolicy(value: unknown): ControlledPostApplyValidationPolicy {
  if (value === undefined) return { ...STRICT_POLICY };
  const record = exactObject(value, Object.keys(STRICT_POLICY), "Validation policy");
  for (const [field, expected] of Object.entries(STRICT_POLICY)) {
    if (record[field] !== expected) throw new TrustedValidationConfigurationError(
      "controlled_post_apply_validation_policy_relaxation_forbidden"
    );
  }
  return record as ControlledPostApplyValidationPolicy;
}

function numeric(record: PlainRecord, field: string, fallback: number, maximum: number): number {
  const value = record[field];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TrustedValidationConfigurationError(
      "controlled_post_apply_validation_policy_invalid"
    );
  }
  return value as number;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalizeJson(left) === canonicalizeJson(right); } catch { return false; }
}

function hashWithout(value: PlainRecord, field: string): string {
  const material = { ...value };
  delete material[field];
  return hashCanonicalJson(material);
}

function issue(error: ValidationFailure): ControlledPostApplyValidationIssue {
  return {
    code: error.code, message: error.message,
    severity: error.kind === "review" ? "review" : "error",
    ...(error.field ? { field: error.field } : {})
  };
}

function finish(
  decision: ControlledPostApplyValidationDecision,
  issues: ControlledPostApplyValidationIssue[],
  finalReceipt: ControlledPostApplyFinalReceipt | null,
  x4ReceiptVerification: ControlledRepositoryApplyReceiptVerificationResult | null,
  validationRecord: ControlledPostApplyValidationRecord | null,
  finalRepositoryInspection: ControlledRepositoryInspectionResult | null,
  summary: ValidationSummary
): ControlledPostApplyValidationResult {
  return deepFreeze({
    decision, issues, finalReceipt, x4ReceiptVerification, validationRecord,
    finalRepositoryInspection, summary
  });
}

function failureDecision(error: ValidationFailure): ControlledPostApplyValidationDecision {
  return error.kind === "review" ? "controlled_post_apply_validation_needs_review" :
    error.kind === "blocked" ? "controlled_post_apply_validation_blocked" :
      "controlled_post_apply_validation_invalid";
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    value.trim() === value && !ASCII_CONTROL.test(value);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function noSymlinkSegments(configuredPath: string): Promise<void> {
  const absolute = path.resolve(configuredPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new ValidationFailure(
      "controlled_post_apply_validation_workspace_path_invalid",
      "A configured path segment is a symbolic link."
    );
  }
}

async function git(
  repository: string, args: readonly string[], timeoutMs: number, maxBytes: number
): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: repository, encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBytes,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    return result.stdout;
  } catch {
    throw new ValidationFailure(
      "controlled_post_apply_validation_exception", "A bounded Git inspection failed."
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code ?? "")) throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const handle = await open(
    file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(Buffer.from(canonicalizeJson(value), "utf8"));
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function marker(file: string): Promise<void> {
  const handle = await open(
    file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600
  );
  try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function readCanonical<T>(file: string): Promise<T> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > DEFAULT_OUTPUT_BYTES) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_receipt_stale", "Registry record is invalid."
    );
  }
  const bytes = await readFile(file);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch {
    throw new ValidationFailure(
      "controlled_post_apply_validation_receipt_stale", "Registry record is invalid."
    );
  }
  if (!bytes.equals(Buffer.from(canonicalizeJson(value), "utf8"))) throw new ValidationFailure(
    "controlled_post_apply_validation_receipt_stale", "Registry record is noncanonical."
  );
  return value as T;
}

function validationPaths(registry: string, consumptionKey: string): ValidationPaths {
  if (!HASH.test(consumptionKey)) throw new ValidationFailure(
    "controlled_post_apply_validation_evidence_binding_mismatch",
    "Consumption key is invalid."
  );
  const transaction = path.join(registry, "validations", consumptionKey.slice(7));
  return {
    registry, validations: path.join(registry, "validations"), transaction,
    intent: path.join(transaction, "validation-intent.json"),
    started: path.join(transaction, "VALIDATION_STARTED"),
    record: path.join(transaction, "validation-result.json"),
    receipt: path.join(transaction, "final-receipt.json")
  };
}

async function ensureValidationsDirectory(paths: ValidationPaths): Promise<void> {
  let created = false;
  try { await mkdir(paths.validations, { mode: 0o700 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) await chmod(paths.validations, 0o700);
  const metadata = await lstat(paths.validations);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700) throw new ValidationFailure(
    "controlled_post_apply_validation_registry_path_invalid",
    "Validation registry namespace is invalid."
  );
}

async function existingTransactionFailure(paths: ValidationPaths): Promise<ValidationFailure> {
  const metadata = await lstat(paths.transaction);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return new ValidationFailure(
    "controlled_post_apply_validation_transaction_incomplete",
    "Validation transaction is unsafe.", "blocked"
  );
  const names = await readdir(paths.transaction);
  if (names.includes("FINALIZED")) return new ValidationFailure(
    "controlled_post_apply_validation_already_finalized",
    "Validation was already finalized.", "blocked"
  );
  if (names.includes("VALIDATION_ROLLED_BACK")) return new ValidationFailure(
    "controlled_post_apply_validation_already_rolled_back",
    "Validation already rolled back.", "blocked"
  );
  if (names.includes("VALIDATION_ROLLBACK_FAILED")) return new ValidationFailure(
    "controlled_post_apply_validation_previous_rollback_failed",
    "Previous validation rollback failed.", "blocked"
  );
  return new ValidationFailure(
    "controlled_post_apply_validation_transaction_incomplete",
    "Validation transaction is incomplete.", "blocked"
  );
}

function validateSpecification(value: unknown): TemporaryWorkspaceExecutionSpecification {
  const record = exactObject(value, [
    "commands", "allowedExecutables", "maxCommands", "defaultTimeoutMs", "maxTimeoutMs",
    "maxOutputChars", "environment"
  ], "Phase V execution specification", ["commands", "allowedExecutables"]);
  if (!Array.isArray(record.commands) || !Array.isArray(record.allowedExecutables) ||
      record.commands.length === 0 ||
      !(record.allowedExecutables as unknown[]).every((entry) => typeof entry === "string")) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_phase_v_evidence_invalid",
      "Phase V execution specification is invalid."
    );
  }
  const shellExecutables = new Set([
    "exec", "sh", "bash", "zsh", "cmd.exe", "powershell", "pwsh"
  ]);
  for (const commandValue of record.commands) {
    const command = exactObject(commandValue, [
      "id", "executable", "args", "timeoutMs", "expectedExitCodes"
    ], "Phase V execution command", ["id", "executable", "args"]);
    if (typeof command.id !== "string" || command.id.length === 0 ||
        typeof command.executable !== "string" || command.executable.length === 0 ||
        path.basename(command.executable) !== command.executable ||
        command.executable.includes("/") || command.executable.includes("\\") ||
        shellExecutables.has(command.executable.toLowerCase()) ||
        !Array.isArray(command.args) ||
        !(command.args as unknown[]).every((entry) =>
          typeof entry === "string" && !entry.includes("\0")) ||
        (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) ||
          (command.timeoutMs as number) <= 0)) ||
        (command.expectedExitCodes !== undefined &&
          (!Array.isArray(command.expectedExitCodes) ||
            command.expectedExitCodes.length === 0 ||
            !(command.expectedExitCodes as unknown[]).every(Number.isInteger)))) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_phase_v_evidence_invalid",
        "Phase V execution command is invalid."
      );
    }
  }
  const allowed = new Set(record.allowedExecutables as string[]);
  if ((record.commands as PlainRecord[]).some((command) =>
      !allowed.has(command.executable as string))) throw new ValidationFailure(
    "controlled_post_apply_validation_phase_v_evidence_invalid",
    "Phase V executable is not allowlisted."
  );
  for (const field of ["maxCommands", "defaultTimeoutMs", "maxTimeoutMs", "maxOutputChars"]) {
    if (record[field] !== undefined &&
        (!Number.isSafeInteger(record[field]) || (record[field] as number) <= 0)) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_phase_v_evidence_invalid",
        "Phase V numeric configuration is invalid."
      );
    }
  }
  if (record.environment !== undefined) {
    const environment = exactObject(
      record.environment, Object.keys(record.environment as PlainRecord), "Phase V environment", []
    );
    for (const [key, entry] of Object.entries(environment)) {
      if (/SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL/i.test(key) ||
          typeof entry !== "string") throw new ValidationFailure(
        "controlled_post_apply_validation_phase_v_evidence_invalid",
        "Phase V environment is unsafe."
      );
    }
  }
  return record as unknown as TemporaryWorkspaceExecutionSpecification;
}

function validateExecutionEvidence(
  value: unknown, specificationHash: string
): TemporaryWorkspaceExecutionVerificationEvidence {
  const record = exactObject(value, [
    "evidenceVersion", "validationSpecificationHash", "decision", "issueCodes", "steps",
    "requiredStepCount", "completedStepCount", "passedStepCount", "cleanupRequired",
    "cleanupSucceeded", "verificationResultHash"
  ], "Phase V execution verification evidence");
  if (record.evidenceVersion !== "1" || record.validationSpecificationHash !== specificationHash ||
      record.decision !== "temp_validation_passed" || record.cleanupRequired !== true ||
      record.cleanupSucceeded !== true || !Array.isArray(record.issueCodes) ||
      !Array.isArray(record.steps) || !Number.isSafeInteger(record.requiredStepCount) ||
      !Number.isSafeInteger(record.completedStepCount) ||
      !Number.isSafeInteger(record.passedStepCount) ||
      record.requiredStepCount !== record.completedStepCount ||
      record.completedStepCount !== record.passedStepCount ||
      record.steps.length !== record.completedStepCount) throw new ValidationFailure(
    "controlled_post_apply_validation_phase_v_evidence_invalid",
    "Phase V verification evidence is invalid."
  );
  for (const stepValue of record.steps) {
    const step = exactObject(stepValue, [
      "index", "stepIdentifierHash", "exitCode", "signal", "timedOut", "stdoutHash",
      "stderrHash", "stdoutBytes", "stderrBytes", "outputTruncated", "passed", "stepHash"
    ], "Phase V execution step");
    if (!Number.isSafeInteger(step.index) || !HASH.test(step.stepIdentifierHash as string) ||
        !HASH.test(step.stdoutHash as string) || !HASH.test(step.stderrHash as string) ||
        !HASH.test(step.stepHash as string) || step.timedOut !== false ||
        step.outputTruncated !== false || step.passed !== true ||
        step.stepHash !== hashWithout(step, "stepHash")) throw new ValidationFailure(
      "controlled_post_apply_validation_phase_v_evidence_invalid",
      "Phase V verification step is invalid."
    );
  }
  if (!HASH.test(record.verificationResultHash as string) ||
      record.verificationResultHash !== hashWithout(record, "verificationResultHash")) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_phase_v_evidence_invalid",
      "Phase V verification evidence hash is invalid."
    );
  }
  return record as unknown as TemporaryWorkspaceExecutionVerificationEvidence;
}

async function validateRegistryPath(configuredPath: unknown): Promise<string> {
  if (!validPath(configuredPath)) throw new ValidationFailure(
    "controlled_post_apply_validation_registry_path_invalid", "Registry path is invalid."
  );
  await noSymlinkSegments(configuredPath);
  const metadata = await lstat(configuredPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700) throw new ValidationFailure(
    "controlled_post_apply_validation_registry_path_invalid",
    "Registry must be a private real directory."
  );
  return realpath(configuredPath);
}

async function validateWorkspaceParent(
  configuredPath: unknown, repository: string, gitCommon: string,
  registry: string, bundle: string
): Promise<{ parent: string; workspace: string }> {
  if (!validPath(configuredPath)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_path_invalid",
    "Validation workspace parent path is invalid."
  );
  await noSymlinkSegments(configuredPath);
  const metadata = await lstat(configuredPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_path_invalid",
    "Validation workspace parent must be a real directory."
  );
  const parent = await realpath(configuredPath);
  if (inside(repository, parent) || inside(parent, repository)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_inside_repository",
    "Validation workspace overlaps the repository."
  );
  if (inside(gitCommon, parent) || inside(parent, gitCommon)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_inside_git_directory",
    "Validation workspace overlaps the Git directory."
  );
  if (inside(registry, parent) || inside(parent, registry)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_inside_registry",
    "Validation workspace overlaps the registry."
  );
  if (inside(bundle, parent) || inside(parent, bundle)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_inside_bundle",
    "Validation workspace overlaps the rollback bundle."
  );
  const tempRoot = await realpath(os.tmpdir());
  if (!inside(tempRoot, parent)) throw new ValidationFailure(
    "controlled_post_apply_validation_workspace_path_invalid",
    "Phase V requires an OS-temporary isolated workspace.", "review"
  );
  return { parent, workspace: "" };
}

async function repositoryInvariantHash(
  repository: string, timeoutMs: number, maxGitOutputBytes: number
): Promise<string> {
  const gitDirRaw = (await git(
    repository, ["rev-parse", "--git-dir"], timeoutMs, maxGitOutputBytes
  )).trim();
  const commonRaw = (await git(
    repository, ["rev-parse", "--git-common-dir"], timeoutMs, maxGitOutputBytes
  )).trim();
  const gitDir = path.resolve(repository, gitDirRaw);
  const common = path.resolve(repository, commonRaw);
  const optionalBytes = async (file: string) => {
    try { return sha256(await readFile(file)); } catch { return null; }
  };
  const material = {
    artifactType: "controlled_post_apply_real_repository_state",
    head: (await git(repository, ["rev-parse", "HEAD"], timeoutMs, maxGitOutputBytes)).trim(),
    branch: (await git(
      repository, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs, maxGitOutputBytes
    )).trim(),
    refsHash: sha256(await git(repository, ["show-ref"], timeoutMs, maxGitOutputBytes)),
    tagsHash: sha256(await git(repository, ["tag", "--list"], timeoutMs, maxGitOutputBytes)),
    statusHash: sha256(await git(
      repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      timeoutMs, maxGitOutputBytes
    )),
    indexHash: await optionalBytes(path.join(gitDir, "index")),
    configHash: await optionalBytes(path.join(common, "config"))
  };
  return hashCanonicalJson(material);
}

async function copyWorkspace(
  source: string, destination: string, maxFiles: number, maxBytes: number
): Promise<{ fileCount: number; bytes: number }> {
  let fileCount = 0;
  let bytes = 0;
  const walk = async (sourceDirectory: string, destinationDirectory: string, relative: string) => {
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const metadata = await lstat(sourcePath);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await walk(sourcePath, destinationPath, relativePath);
        continue;
      }
      fileCount += 1;
      if (fileCount > maxFiles) throw new ValidationFailure(
        "controlled_post_apply_validation_workspace_limit_exceeded",
        "Validation workspace file count exceeds its bound.", "review"
      );
      if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes > maxBytes) throw new ValidationFailure(
          "controlled_post_apply_validation_workspace_limit_exceeded",
          "Validation workspace bytes exceed their bound.", "review"
        );
        const sourceHandle = await open(
          sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
        );
        const destinationHandle = await open(
          destinationPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          (metadata.mode & 0o111) !== 0 ? 0o755 : 0o644
        );
        try {
          const content = await sourceHandle.readFile();
          await destinationHandle.writeFile(content);
          await destinationHandle.sync();
        } finally {
          await sourceHandle.close(); await destinationHandle.close();
        }
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(sourcePath, { encoding: "buffer" });
        bytes += target.length;
        if (bytes > maxBytes || path.isAbsolute(target.toString())) throw new ValidationFailure(
          "controlled_post_apply_validation_workspace_limit_exceeded",
          "Validation workspace symlink is unsafe.", "review"
        );
        const resolved = path.resolve(path.dirname(sourcePath), target.toString());
        if (!inside(source, resolved)) throw new ValidationFailure(
          "controlled_post_apply_validation_workspace_binding_mismatch",
          "Validation workspace symlink escapes the repository.", "review"
        );
        await symlink(target, destinationPath);
        continue;
      }
      throw new ValidationFailure(
        "controlled_post_apply_validation_workspace_creation_failed",
        "Validation workspace contains an unsupported filesystem entry.", "review"
      );
    }
  };
  await walk(source, destination, "");
  return { fileCount, bytes };
}

async function workspaceMatchesReceipt(
  workspace: string, receipt: ControlledRepositoryApplyReceipt
): Promise<boolean> {
  for (const entry of receipt.after.appliedFiles) {
    const state = await inspectControlledRepositoryFileState(
      path.resolve(workspace, entry.filePath), MAX_OUTPUT_BYTES
    );
    if (state.stateHash !== entry.finalStateHash) return false;
  }
  return true;
}

function buildIntent(
  applyReceipt: ControlledRepositoryApplyReceipt,
  authorization: ControlledApplyExecutionAuthorization,
  gateInput: ControlledApplyExecutionGateInput,
  phaseEvidence: TemporaryWorkspaceExecutionVerificationEvidence,
  specificationHash: string, policyHash: string
): ControlledPostApplyValidationIntent {
  if (applyReceipt.after.appliedStateHash === null || applyReceipt.after.finalScopeHash === null) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_x4_receipt_invalid",
      "X.4 applied-state hashes are unavailable."
    );
  }
  const material = {
    intentVersion: "1" as const,
    consumptionKey: applyReceipt.consumptionKey,
    authorizationHash: authorization.authorizationHash,
    x4ApplyReceiptHash: applyReceipt.receiptHash,
    governedArtifactHash: applyReceipt.governedArtifactHash,
    handoffHash: applyReceipt.handoffHash,
    mutationHash: applyReceipt.mutation.mutationHash,
    appliedStateHash: applyReceipt.after.appliedStateHash,
    finalScopeHash: applyReceipt.after.finalScopeHash,
    phaseVExecutionVerificationResultHash: phaseEvidence.verificationResultHash,
    validationSpecificationHash: specificationHash,
    expectedInspectionHash: gateInput.expectedInspection.inspectionHash,
    rollbackManifestHash: gateInput.expectedInspection.rollbackManifest.manifestHash,
    rollbackBundleManifestHash: gateInput.rollbackBundleManifest.bundleManifestHash,
    rollbackBundleReceiptHash: gateInput.rollbackBundleReceipt.receiptHash,
    policyHash
  };
  return { ...material, intentHash: hashCanonicalJson(material) };
}

function recordDecision(
  decision: string
): ControlledPostApplyValidationRecord["decision"] {
  return decision === "temp_validation_passed" ? "passed" :
    decision === "temp_validation_failed" ? "failed" :
      decision === "temp_validation_needs_review" ? "needs_review" : "invalid";
}

function buildRecord(
  intent: ControlledPostApplyValidationIntent,
  suppliedEvidence: TemporaryWorkspaceExecutionVerificationEvidence,
  currentEvidence: TemporaryWorkspaceExecutionVerificationEvidence | null,
  decision: ControlledPostApplyValidationRecord["decision"], cleanupSucceeded: boolean
): ControlledPostApplyValidationRecord {
  const material = {
    recordVersion: "1" as const,
    intentHash: intent.intentHash,
    decision,
    validationSpecificationHash: intent.validationSpecificationHash,
    phaseVExecutionVerificationResultHash: suppliedEvidence.verificationResultHash,
    currentExecutionResultHash: currentEvidence?.verificationResultHash ?? null,
    steps: currentEvidence?.steps.map((step) => ({ ...step })) ?? [],
    requiredStepCount: currentEvidence?.requiredStepCount ?? suppliedEvidence.requiredStepCount,
    completedStepCount: currentEvidence?.completedStepCount ?? 0,
    passedStepCount: currentEvidence?.passedStepCount ?? 0,
    workspaceCleanupRequired: true as const,
    workspaceCleanupSucceeded: cleanupSucceeded
  };
  return { ...material, recordHash: hashCanonicalJson(material) };
}

function buildFinalReceipt(
  outcome: ControlledPostApplyFinalReceipt["outcome"],
  applyReceipt: ControlledRepositoryApplyReceipt,
  authorization: ControlledApplyExecutionAuthorization,
  record: ControlledPostApplyValidationRecord,
  finalState: ControlledPostApplyFinalReceipt["repository"]["finalRepositoryState"],
  finalInspectionHash: string | null, rollbackAttempted: boolean,
  rollbackSucceeded: boolean | null, gateInput: ControlledApplyExecutionGateInput,
  validationExecuted: boolean
): ControlledPostApplyFinalReceipt {
  const material = {
    receiptVersion: "1" as const, outcome,
    consumptionKey: applyReceipt.consumptionKey,
    authorizationHash: authorization.authorizationHash,
    x4ApplyReceiptHash: applyReceipt.receiptHash,
    governedArtifactHash: applyReceipt.governedArtifactHash,
    handoffHash: applyReceipt.handoffHash,
    mutation: {
      changeKind: applyReceipt.mutation.changeKind,
      mutationHash: applyReceipt.mutation.mutationHash,
      changedFiles: [...applyReceipt.mutation.changedFiles],
      changedFileCount: applyReceipt.mutation.changedFileCount
    },
    adminResolution: {
      invocationPolicyHash: authorization.adminResolution.invocationPolicyHash,
      invocationAssessmentHash: authorization.adminResolution.invocationAssessmentHash,
      invocationDecision: authorization.adminResolution.invocationDecision,
      resolutionKind: authorization.adminResolution.resolutionKind,
      adminDecisionHash: authorization.adminResolution.adminDecisionHash
    },
    validation: {
      phaseVExecutionVerificationResultHash: record.phaseVExecutionVerificationResultHash,
      validationSpecificationHash: record.validationSpecificationHash,
      currentExecutionResultHash: record.currentExecutionResultHash,
      validationDecision: record.decision,
      requiredStepCount: record.requiredStepCount,
      completedStepCount: record.completedStepCount,
      passedStepCount: record.passedStepCount,
      workspaceCleanupSucceeded: record.workspaceCleanupSucceeded
    },
    repository: {
      beforeApplyInspectionHash: gateInput.expectedInspection.inspectionHash,
      x4AppliedStateHash: applyReceipt.after.appliedStateHash!,
      x4FinalScopeHash: applyReceipt.after.finalScopeHash!,
      finalRepositoryState: finalState,
      finalInspectionHash
    },
    rollback: {
      attempted: rollbackAttempted, succeeded: rollbackSucceeded,
      rollbackManifestHash: gateInput.expectedInspection.rollbackManifest.manifestHash,
      rollbackBundleManifestHash: gateInput.rollbackBundleManifest.bundleManifestHash,
      rollbackBundleReceiptHash: gateInput.rollbackBundleReceipt.receiptHash,
      rollbackPayloadRootHash: gateInput.rollbackBundleManifest.payloadRootHash
    },
    execution: {
      validationExecuted,
      validationExecutedInRealRepository: false as const,
      repositoryWritePerformedByValidation: false,
      rollbackWritePerformed: rollbackAttempted,
      consumptionClaimReleased: false as const,
      gitIndexMutated: false as const, gitHistoryMutated: false as const,
      shellExecuted: false as const, commitCreated: false as const, pushExecuted: false as const
    }
  };
  return { ...material, receiptHash: hashCanonicalJson(material) };
}

async function persistFinal(
  paths: ValidationPaths, receipt: ControlledPostApplyFinalReceipt,
  terminal: typeof TERMINALS[number]
): Promise<void> {
  await writeExclusive(paths.receipt, receipt);
  const disk = await readCanonical<PlainRecord>(paths.receipt);
  if (!canonicalEqual(disk, receipt) || disk.receiptHash !== hashWithout(disk, "receiptHash")) {
    throw new ValidationFailure(
      "controlled_post_apply_validation_final_receipt_hash_mismatch",
      "Final receipt integrity verification failed."
    );
  }
  try { await marker(path.join(paths.transaction, terminal)); }
  catch { throw new ValidationFailure(
    "controlled_post_apply_validation_terminal_marker_failed",
    "Final validation marker could not be persisted."
  ); }
}

function bindingsMatch(
  applyReceipt: ControlledRepositoryApplyReceipt,
  authorization: ControlledApplyExecutionAuthorization,
  gateInput: ControlledApplyExecutionGateInput
): boolean {
  const admin = authorization.adminResolution;
  const adminValid = admin.resolutionKind === "verified_policy_skip"
    ? admin.adminDecisionHash === null
    : admin.resolutionKind === "model_decision" && admin.adminDecisionHash !== null;
  return adminValid &&
    applyReceipt.authorizationHash === authorization.authorizationHash &&
    applyReceipt.governedArtifactHash === gateInput.artifact.governedArtifactHash &&
    applyReceipt.handoffHash === gateInput.handoff.handoffHash &&
    applyReceipt.consumptionKey === gateInput.handoff.singleUse.consumptionKey &&
    applyReceipt.mutation.mutationHash === gateInput.artifact.change.mutationHash &&
    canonicalEqual(applyReceipt.mutation.changedFiles, gateInput.changedFiles) &&
    applyReceipt.before.expectedInspectionHash === gateInput.expectedInspection.inspectionHash &&
    applyReceipt.before.rollbackManifestHash ===
      gateInput.expectedInspection.rollbackManifest.manifestHash;
}

async function finalInspection(
  repository: string, gateInput: ControlledApplyExecutionGateInput,
  timeoutMs: number, maxGitOutputBytes: number
): Promise<ControlledRepositoryInspectionResult> {
  return inspectControlledRepository({
    repositoryPath: repository, changedFiles: gateInput.changedFiles,
    timeoutMs, maxGitOutputBytes
  });
}

export async function executeControlledPostApplyValidation(
  input: ControlledPostApplyValidationInput
): Promise<ControlledPostApplyValidationResult> {
  const summary = initialSummary();
  const issues: ControlledPostApplyValidationIssue[] = [];
  let x4ReceiptVerification: ControlledRepositoryApplyReceiptVerificationResult | null = null;
  let validationRecord: ControlledPostApplyValidationRecord | null = null;
  let finalReceipt: ControlledPostApplyFinalReceipt | null = null;
  let finalRepositoryInspection: ControlledRepositoryInspectionResult | null = null;
  let paths: ValidationPaths | null = null;
  let workspacePath: string | null = null;
  let intent: ControlledPostApplyValidationIntent | null = null;
  let applyReceipt: ControlledRepositoryApplyReceipt | null = null;
  let authorization: ControlledApplyExecutionAuthorization | null = null;
  let gateInput: ControlledApplyExecutionGateInput | null = null;
  let phaseEvidence: TemporaryWorkspaceExecutionVerificationEvidence | null = null;
  let specification: TemporaryWorkspaceExecutionSpecification | null = null;
  let repository = "";
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxGitOutputBytes = DEFAULT_GIT_OUTPUT_BYTES;
  let repositoryChanged = false;
  let currentEvidence: TemporaryWorkspaceExecutionVerificationEvidence | null = null;
  let validationDecision: ControlledPostApplyValidationRecord["decision"] =
    "infrastructure_failure";
  try {
    const cloned = safeClone(input);
    const top = exactObject(
      cloned, INPUT_FIELDS, "Controlled post-apply validation input",
      ["applyReceipt", "authorization", "gateInput", "registryDirectoryPath",
        "validationWorkspaceParentPath", "phaseVExecutionSpecification",
        "phaseVExecutionVerification"]
    );
    summary.inputValid = true;
    const policy = normalizePolicy(top.policy);
    summary.policyValid = true;
    const policyHash = hashCanonicalJson(policy);
    timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    maxGitOutputBytes = numeric(
      top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    const maxWorkspaceFileCount = numeric(
      top, "maxWorkspaceFileCount", DEFAULT_WORKSPACE_FILES, MAX_WORKSPACE_FILES
    );
    const maxWorkspaceBytes = numeric(
      top, "maxWorkspaceBytes", DEFAULT_WORKSPACE_BYTES, MAX_WORKSPACE_BYTES
    );
    const maxValidationOutputBytes = numeric(
      top, "maxValidationOutputBytes", DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES
    );
    specification = validateSpecification(top.phaseVExecutionSpecification);
    const specificationHash = computeTemporaryWorkspaceExecutionSpecificationHash(specification);
    phaseEvidence = validateExecutionEvidence(top.phaseVExecutionVerification, specificationHash);
    applyReceipt = top.applyReceipt as ControlledRepositoryApplyReceipt;
    authorization = top.authorization as ControlledApplyExecutionAuthorization;
    gateInput = top.gateInput as ControlledApplyExecutionGateInput;
    if (phaseEvidence.verificationResultHash !==
        gateInput.artifact.change.executionVerificationResultHash) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_specification_mismatch",
        "Phase V verification evidence does not bind to the governed artifact."
      );
    }
    summary.phaseVSpecificationMatched = true;
    if ((specification.maxOutputChars ?? 20_000) > maxValidationOutputBytes) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_output_limit_exceeded",
        "Phase V output bound exceeds the X.5 bound.", "review"
      );
    }

    x4ReceiptVerification = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: gateInput.repositoryPath,
      registryDirectoryPath: top.registryDirectoryPath as string,
      receipt: applyReceipt, authorization,
      expectedInspection: gateInput.expectedInspection,
      timeoutMs, maxGitOutputBytes
    });
    summary.x4ReceiptCurrent = x4ReceiptVerification.decision ===
      "controlled_repository_apply_receipt_current";
    summary.x4TransactionCommitted = x4ReceiptVerification.terminalMarker === "COMMITTED";
    let pendingBlocked: ValidationFailure | null = null;
    if (x4ReceiptVerification.decision === "controlled_repository_apply_receipt_invalid") {
      throw new ValidationFailure(
        "controlled_post_apply_validation_x4_receipt_invalid",
        "The X.4 apply receipt is invalid."
      );
    }
    if (!x4ReceiptVerification.repositoryStateMatched &&
        x4ReceiptVerification.receiptIntegrityVerified &&
        x4ReceiptVerification.registryRecordVerified) pendingBlocked = new ValidationFailure(
      "controlled_post_apply_validation_repository_not_applied_state",
      "The repository no longer matches the X.4 applied state.", "blocked"
    );
    if (!summary.x4ReceiptCurrent || !x4ReceiptVerification.receiptIntegrityVerified ||
        !x4ReceiptVerification.registryRecordVerified) pendingBlocked ??= new ValidationFailure(
      "controlled_post_apply_validation_x4_receipt_stale",
      "The X.4 apply receipt is not current.", "blocked"
    );
    if (!summary.x4TransactionCommitted) pendingBlocked ??= new ValidationFailure(
      "controlled_post_apply_validation_x4_transaction_not_committed",
      "The X.4 transaction is not committed.", "blocked"
    );
    if (applyReceipt.outcome !== "applied" || !applyReceipt.execution.mutationApplied ||
        applyReceipt.after.appliedStateHash === null || applyReceipt.after.finalScopeHash === null) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_x4_receipt_invalid",
        "The X.4 receipt does not represent an applied mutation."
      );
    }
    summary.evidenceBindingsMatched = bindingsMatch(applyReceipt, authorization, gateInput);
    if (!summary.evidenceBindingsMatched) throw new ValidationFailure(
      "controlled_post_apply_validation_evidence_binding_mismatch",
      "W.17 through X.4 evidence bindings do not match."
    );

    const bundleVerification = await verifyControlledRollbackBundle({
      bundleDirectoryPath: gateInput.bundleDirectoryPath,
      expectedManifest: gateInput.rollbackBundleManifest,
      expectedReceipt: gateInput.rollbackBundleReceipt,
      expectedHandoffHash: gateInput.handoff.handoffHash,
      expectedConsumptionKey: gateInput.handoff.singleUse.consumptionKey,
      expectedInspectionHash: gateInput.expectedInspection.inspectionHash
    });
    if (bundleVerification.decision === "rollback_bundle_invalid") throw new ValidationFailure(
      "controlled_post_apply_validation_rollback_bundle_invalid",
      "The rollback bundle is invalid."
    );
    if (bundleVerification.decision !== "rollback_bundle_current" ||
        !bundleVerification.rollbackUsable) throw new ValidationFailure(
      "controlled_post_apply_validation_x4_receipt_stale",
      "The rollback bundle is unavailable.", "blocked"
    );

    repository = await realpath(gateInput.repositoryPath);
    const bundle = await realpath(gateInput.bundleDirectoryPath);
    const registry = await validateRegistryPath(top.registryDirectoryPath);
    const commonRaw = (await git(
      repository, ["rev-parse", "--git-common-dir"], timeoutMs, maxGitOutputBytes
    )).trim();
    const gitCommon = await realpath(path.resolve(repository, commonRaw));
    const workspaceParent = await validateWorkspaceParent(
      top.validationWorkspaceParentPath, repository, gitCommon, registry, bundle
    );
    workspacePath = path.join(
      workspaceParent.parent,
      `controlled-post-apply-${applyReceipt.consumptionKey.slice(7)}.partial`
    );
    try { await lstat(workspacePath); throw new ValidationFailure(
      "controlled_post_apply_validation_workspace_already_exists",
      "Validation workspace already exists.", "review"
    ); } catch (error) {
      if (error instanceof ValidationFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (pendingBlocked !== null) throw pendingBlocked;

    paths = validationPaths(registry, applyReceipt.consumptionKey);
    await ensureValidationsDirectory(paths);
    try {
      await mkdir(paths.transaction, { mode: 0o700 });
      await chmod(paths.transaction, 0o700);
      await syncDirectory(paths.validations);
      summary.validationTransactionCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw await existingTransactionFailure(paths);
      }
      throw new ValidationFailure(
        "controlled_post_apply_validation_registry_path_invalid",
        "Validation transaction could not be created."
      );
    }
    intent = buildIntent(
      applyReceipt, authorization, gateInput, phaseEvidence, specificationHash, policyHash
    );
    try {
      await writeExclusive(paths.intent, intent);
      summary.validationIntentWritten = true;
      const disk = await readCanonical<PlainRecord>(paths.intent);
      summary.validationIntentVerified = canonicalEqual(disk, intent) &&
        disk.intentHash === hashWithout(disk, "intentHash");
      if (!summary.validationIntentVerified) throw new Error("intent mismatch");
    } catch {
      throw new ValidationFailure(
        "controlled_post_apply_validation_intent_write_failed",
        "Validation intent could not be durably verified."
      );
    }
    try { await marker(paths.started); summary.validationStarted = true; }
    catch { throw new ValidationFailure(
      "controlled_post_apply_validation_start_marker_failed",
      "Durable validation start could not be recorded."
    ); }

    let executionResult: ReturnType<typeof verifyTemporaryWorkspaceExecution> | null = null;
    let beforeRepositoryHash: string | null = null;
    try {
      await mkdir(workspacePath, { mode: 0o700 });
      await chmod(workspacePath, 0o700);
      summary.workspaceCreated = true;
      await copyWorkspace(
        repository, workspacePath, maxWorkspaceFileCount, maxWorkspaceBytes
      );
      summary.workspaceBoundToAppliedState = await workspaceMatchesReceipt(
        workspacePath, applyReceipt
      );
      if (!summary.workspaceBoundToAppliedState) throw new ValidationFailure(
        "controlled_post_apply_validation_workspace_binding_mismatch",
        "Isolated workspace does not match the X.4 applied state."
      );
      beforeRepositoryHash = await repositoryInvariantHash(
        repository, timeoutMs, maxGitOutputBytes
      );
      executionResult = verifyTemporaryWorkspaceExecution({
        tempWorkspacePath: workspacePath,
        tempApplyDecision: "temp_apply_ready",
        tempWorkspaceCleanedUp: false,
        ...specification
      });
      summary.validationExecuted = true;
      validationDecision = recordDecision(executionResult.decision);
    } catch (error) {
      validationDecision = error instanceof ValidationFailure && error.kind === "review"
        ? "needs_review" : "infrastructure_failure";
      issues.push(issue(error instanceof ValidationFailure ? error : new ValidationFailure(
        "controlled_post_apply_validation_execution_failed",
        "Isolated validation infrastructure failed."
      )));
    }
    try {
      if (workspacePath !== null) await rm(workspacePath, { recursive: true, force: true });
      summary.workspaceCleanupSucceeded = workspacePath === null ||
        await lstat(workspacePath).then(() => false).catch((error) =>
          (error as NodeJS.ErrnoException).code === "ENOENT");
    } catch { summary.workspaceCleanupSucceeded = false; }
    if (!summary.workspaceCleanupSucceeded) issues.push(issue(new ValidationFailure(
      "controlled_post_apply_validation_workspace_cleanup_failed",
      "Validation workspace cleanup failed."
    )));
    if (executionResult !== null && specification !== null) {
      currentEvidence = buildTemporaryWorkspaceExecutionVerificationEvidence(
        specification, executionResult, summary.workspaceCleanupSucceeded
      );
    }
    if (beforeRepositoryHash !== null) {
      const afterRepositoryHash = await repositoryInvariantHash(
        repository, timeoutMs, maxGitOutputBytes
      );
      const currentX4 = await verifyControlledRepositoryApplyReceipt({
        repositoryPath: repository,
        registryDirectoryPath: top.registryDirectoryPath as string,
        receipt: applyReceipt, authorization,
        expectedInspection: gateInput.expectedInspection,
        timeoutMs, maxGitOutputBytes
      });
      summary.realRepositoryUnchangedDuringValidation =
        beforeRepositoryHash === afterRepositoryHash &&
        currentX4.decision === "controlled_repository_apply_receipt_current";
      repositoryChanged = !summary.realRepositoryUnchangedDuringValidation;
    }
    summary.validationPassed = validationDecision === "passed" &&
      summary.workspaceCleanupSucceeded && !repositoryChanged && currentEvidence !== null;
    validationRecord = buildRecord(
      intent, phaseEvidence, currentEvidence,
      summary.workspaceCleanupSucceeded ? validationDecision : "infrastructure_failure",
      summary.workspaceCleanupSucceeded
    );
    try {
      await writeExclusive(paths.record, validationRecord);
      const disk = await readCanonical<PlainRecord>(paths.record);
      if (!canonicalEqual(disk, validationRecord) ||
          disk.recordHash !== hashWithout(disk, "recordHash")) throw new Error("record mismatch");
    } catch {
      summary.validationPassed = false;
      issues.push(issue(new ValidationFailure(
        "controlled_post_apply_validation_record_write_failed",
        "Validation result record could not be persisted."
      )));
    }

    if (summary.validationPassed) {
      finalRepositoryInspection = await finalInspection(
        repository, gateInput, timeoutMs, maxGitOutputBytes
      );
      finalReceipt = buildFinalReceipt(
        "validated", applyReceipt, authorization, validationRecord,
        "validated_applied_state",
        finalRepositoryInspection.inspection?.inspectionHash ?? null,
        false, null, gateInput, true
      );
      try {
        await persistFinal(paths, finalReceipt, "FINALIZED");
        summary.finalReceiptWritten = true; summary.finalReceiptVerified = true;
        summary.terminalMarker = "FINALIZED";
        summary.finalRepositoryState = "validated_applied_state";
        return finish(
          "controlled_post_apply_validation_finalized", issues, finalReceipt,
          x4ReceiptVerification, validationRecord, finalRepositoryInspection, summary
        );
      } catch {
        issues.push(issue(new ValidationFailure(
          "controlled_post_apply_validation_final_receipt_write_failed",
          "Final validation receipt could not be committed."
        )));
      }
    }
    throw new ValidationFailure(
      repositoryChanged
        ? "controlled_post_apply_validation_real_repository_changed"
        : currentEvidence?.steps.some((step) => step.timedOut)
          ? "controlled_post_apply_validation_execution_timeout"
        : validationDecision === "failed"
          ? "controlled_post_apply_validation_execution_failed"
          : validationDecision === "needs_review"
            ? "controlled_post_apply_validation_execution_needs_review"
            : "controlled_post_apply_validation_execution_invalid",
      repositoryChanged
        ? "The real repository changed during isolated validation."
        : "Post-apply validation did not pass."
    );
  } catch (error) {
    if (error instanceof TrustedValidationConfigurationError) throw error;
    const failure = error instanceof ValidationFailure ? error : new ValidationFailure(
      "controlled_post_apply_validation_exception",
      "Post-apply validation failed without exposing unbounded details."
    );
    issues.push(issue(failure));
    if (!summary.validationStarted || !paths || !applyReceipt || !authorization ||
        !gateInput || !phaseEvidence || !intent) {
      return finish(
        failureDecision(failure), issues, null, x4ReceiptVerification,
        validationRecord, finalRepositoryInspection, summary
      );
    }
    if (workspacePath !== null && !summary.workspaceCleanupSucceeded) {
      try {
        await rm(workspacePath, { recursive: true, force: true });
        summary.workspaceCleanupSucceeded = true;
      } catch { /* cleanup failure contributes to rollback path */ }
    }
    if (validationRecord === null) {
      validationRecord = buildRecord(
        intent, phaseEvidence, currentEvidence, "infrastructure_failure",
        summary.workspaceCleanupSucceeded
      );
      try { await writeExclusive(paths.record, validationRecord); } catch { /* best effort */ }
    }
    if (!repositoryChanged) {
      try {
        const currentX4 = await verifyControlledRepositoryApplyReceipt({
          repositoryPath: repository,
          registryDirectoryPath: paths.registry,
          receipt: applyReceipt, authorization,
          expectedInspection: gateInput.expectedInspection,
          timeoutMs, maxGitOutputBytes
        });
        repositoryChanged = currentX4.decision !==
          "controlled_repository_apply_receipt_current";
        if (repositoryChanged) {
          summary.realRepositoryUnchangedDuringValidation = false;
          issues.push(issue(new ValidationFailure(
            "controlled_post_apply_validation_real_repository_changed",
            "The real repository changed during isolated validation."
          )));
        }
      } catch { repositoryChanged = true; }
    }
    if (repositoryChanged) {
      return finalizeRollbackFailure(
        paths, applyReceipt, authorization, gateInput, validationRecord,
        false, summary, issues, x4ReceiptVerification, finalRepositoryInspection
      );
    }
    summary.emergencyRollbackExecuted = true;
    try {
      const restored = await restoreControlledRepositoryFromRollbackBundle({
        gateInput, timeoutMs, maxGitOutputBytes
      });
      finalRepositoryInspection = restored.rollbackInspection;
      if (!restored.rollbackBundleVerified || !restored.baselineRestored) {
        throw new ValidationFailure(
          "controlled_post_apply_validation_rollback_verification_failed",
          "Rollback did not match the X.1 baseline."
        );
      }
      summary.emergencyRollbackSucceeded = true;
      finalReceipt = buildFinalReceipt(
        "validation_failed_rolled_back", applyReceipt, authorization, validationRecord,
        "restored_x1_baseline",
        finalRepositoryInspection.inspection?.inspectionHash ?? null,
        true, true, gateInput, summary.validationExecuted
      );
      await persistFinal(paths, finalReceipt, "VALIDATION_ROLLED_BACK");
      summary.finalReceiptWritten = true; summary.finalReceiptVerified = true;
      summary.terminalMarker = "VALIDATION_ROLLED_BACK";
      summary.finalRepositoryState = "restored_x1_baseline";
      return finish(
        "controlled_post_apply_validation_rolled_back", issues, finalReceipt,
        x4ReceiptVerification, validationRecord, finalRepositoryInspection, summary
      );
    } catch {
      summary.emergencyRollbackSucceeded = false;
      issues.push(issue(new ValidationFailure(
        "controlled_post_apply_validation_rollback_failed",
        "Validation rollback could not restore the X.1 baseline."
      )));
      return finalizeRollbackFailure(
        paths, applyReceipt, authorization, gateInput, validationRecord,
        true, summary, issues, x4ReceiptVerification, finalRepositoryInspection
      );
    }
  }
}

async function finalizeRollbackFailure(
  paths: ValidationPaths, applyReceipt: ControlledRepositoryApplyReceipt,
  authorization: ControlledApplyExecutionAuthorization,
  gateInput: ControlledApplyExecutionGateInput,
  record: ControlledPostApplyValidationRecord, rollbackAttempted: boolean,
  summary: ValidationSummary, issues: ControlledPostApplyValidationIssue[],
  x4Verification: ControlledRepositoryApplyReceiptVerificationResult | null,
  inspection: ControlledRepositoryInspectionResult | null
): Promise<ControlledPostApplyValidationResult> {
  summary.emergencyRollbackExecuted = rollbackAttempted;
  summary.emergencyRollbackSucceeded = false;
  summary.finalRepositoryState = "unsafe_unknown_state";
  const receipt = buildFinalReceipt(
    "validation_failed_rollback_failed", applyReceipt, authorization, record,
    "unsafe_unknown_state", inspection?.inspection?.inspectionHash ?? null,
    rollbackAttempted, false, gateInput, summary.validationExecuted
  );
  try {
    await persistFinal(paths, receipt, "VALIDATION_ROLLBACK_FAILED");
    summary.finalReceiptWritten = true; summary.finalReceiptVerified = true;
    summary.terminalMarker = "VALIDATION_ROLLBACK_FAILED";
  } catch { /* strongest in-memory evidence is returned */ }
  return finish(
    "controlled_post_apply_validation_rollback_failed", issues, receipt,
    x4Verification, record, inspection, summary
  );
}

function validateIntent(value: unknown): ControlledPostApplyValidationIntent {
  const record = exactObject(value, [
    "intentVersion", "consumptionKey", "authorizationHash", "x4ApplyReceiptHash",
    "governedArtifactHash", "handoffHash", "mutationHash", "appliedStateHash",
    "finalScopeHash", "phaseVExecutionVerificationResultHash",
    "validationSpecificationHash", "expectedInspectionHash", "rollbackManifestHash",
    "rollbackBundleManifestHash", "rollbackBundleReceiptHash", "policyHash", "intentHash"
  ], "Validation intent");
  if (record.intentVersion !== "1" || Object.entries(record).some(([field, value]) =>
      field !== "intentVersion" && (!HASH.test(value as string)))) throw new ValidationFailure(
    "controlled_post_apply_validation_intent_hash_mismatch", "Validation intent is invalid."
  );
  if (record.intentHash !== hashWithout(record, "intentHash")) throw new ValidationFailure(
    "controlled_post_apply_validation_intent_hash_mismatch", "Validation intent hash mismatched."
  );
  return record as unknown as ControlledPostApplyValidationIntent;
}

function validateRecord(value: unknown): ControlledPostApplyValidationRecord {
  const record = exactObject(value, [
    "recordVersion", "intentHash", "decision", "validationSpecificationHash",
    "phaseVExecutionVerificationResultHash", "currentExecutionResultHash", "steps",
    "requiredStepCount", "completedStepCount", "passedStepCount",
    "workspaceCleanupRequired", "workspaceCleanupSucceeded", "recordHash"
  ], "Validation result record");
  if (record.recordVersion !== "1" ||
      !["passed", "failed", "needs_review", "invalid", "infrastructure_failure"]
        .includes(record.decision as string) || !Array.isArray(record.steps) ||
      record.workspaceCleanupRequired !== true ||
      typeof record.workspaceCleanupSucceeded !== "boolean" ||
      !HASH.test(record.intentHash as string) ||
      !HASH.test(record.validationSpecificationHash as string) ||
      !HASH.test(record.phaseVExecutionVerificationResultHash as string) ||
      (record.currentExecutionResultHash !== null &&
        !HASH.test(record.currentExecutionResultHash as string)) ||
      !Number.isSafeInteger(record.requiredStepCount) ||
      !Number.isSafeInteger(record.completedStepCount) ||
      !Number.isSafeInteger(record.passedStepCount) ||
      !HASH.test(record.recordHash as string) ||
      record.recordHash !== hashWithout(record, "recordHash")) throw new ValidationFailure(
    "controlled_post_apply_validation_record_hash_mismatch",
    "Validation result record is invalid."
  );
  return record as unknown as ControlledPostApplyValidationRecord;
}

function validateFinalReceipt(value: unknown): ControlledPostApplyFinalReceipt {
  const receipt = exactObject(value, [
    "receiptVersion", "outcome", "consumptionKey", "authorizationHash",
    "x4ApplyReceiptHash", "governedArtifactHash", "handoffHash", "mutation",
    "adminResolution", "validation", "repository", "rollback", "execution", "receiptHash"
  ], "Final execution receipt");
  const mutation = exactObject(receipt.mutation, [
    "changeKind", "mutationHash", "changedFiles", "changedFileCount"
  ], "Final receipt mutation");
  const admin = exactObject(receipt.adminResolution, [
    "invocationPolicyHash", "invocationAssessmentHash", "invocationDecision",
    "resolutionKind", "adminDecisionHash"
  ], "Final receipt Admin resolution");
  const validation = exactObject(receipt.validation, [
    "phaseVExecutionVerificationResultHash", "validationSpecificationHash",
    "currentExecutionResultHash", "validationDecision", "requiredStepCount",
    "completedStepCount", "passedStepCount", "workspaceCleanupSucceeded"
  ], "Final receipt validation");
  const repository = exactObject(receipt.repository, [
    "beforeApplyInspectionHash", "x4AppliedStateHash", "x4FinalScopeHash",
    "finalRepositoryState", "finalInspectionHash"
  ], "Final receipt repository");
  const rollback = exactObject(receipt.rollback, [
    "attempted", "succeeded", "rollbackManifestHash", "rollbackBundleManifestHash",
    "rollbackBundleReceiptHash", "rollbackPayloadRootHash"
  ], "Final receipt rollback");
  const execution = exactObject(receipt.execution, [
    "validationExecuted", "validationExecutedInRealRepository",
    "repositoryWritePerformedByValidation", "rollbackWritePerformed",
    "consumptionClaimReleased", "gitIndexMutated", "gitHistoryMutated", "shellExecuted",
    "commitCreated", "pushExecuted"
  ], "Final receipt execution");
  if (receipt.receiptVersion !== "1" ||
      !["validated", "validation_failed_rolled_back",
        "validation_failed_rollback_failed"].includes(receipt.outcome as string) ||
      !Array.isArray(mutation.changedFiles) ||
      execution.validationExecutedInRealRepository !== false ||
      execution.repositoryWritePerformedByValidation !== false ||
      execution.consumptionClaimReleased !== false || execution.gitIndexMutated !== false ||
      execution.gitHistoryMutated !== false || execution.shellExecuted !== false ||
      execution.commitCreated !== false || execution.pushExecuted !== false ||
      !HASH.test(receipt.receiptHash as string) ||
      receipt.receiptHash !== hashWithout(receipt, "receiptHash")) throw new ValidationFailure(
    "controlled_post_apply_validation_final_receipt_hash_mismatch",
    "Final execution receipt is invalid."
  );
  for (const hash of [
    receipt.consumptionKey, receipt.authorizationHash, receipt.x4ApplyReceiptHash,
    receipt.governedArtifactHash, receipt.handoffHash, mutation.mutationHash,
    admin.invocationPolicyHash, admin.invocationAssessmentHash,
    validation.phaseVExecutionVerificationResultHash, validation.validationSpecificationHash,
    repository.beforeApplyInspectionHash, repository.x4AppliedStateHash,
    repository.x4FinalScopeHash, rollback.rollbackManifestHash,
    rollback.rollbackBundleManifestHash, rollback.rollbackBundleReceiptHash,
    rollback.rollbackPayloadRootHash
  ]) if (!HASH.test(hash as string)) throw new ValidationFailure(
    "controlled_post_apply_validation_final_receipt_hash_mismatch",
    "Final execution receipt hash field is invalid."
  );
  const adminValid = admin.resolutionKind === "verified_policy_skip"
    ? admin.adminDecisionHash === null && admin.invocationDecision === "admin_invocation_skipped"
    : admin.resolutionKind === "model_decision" &&
      HASH.test(admin.adminDecisionHash as string) &&
      admin.invocationDecision === "admin_invocation_required";
  const files = mutation.changedFiles as unknown[];
  if (!adminValid || !files.every((file) => typeof file === "string") ||
      !canonicalEqual(files, sortedUnique(files as string[])) ||
      mutation.changedFileCount !== files.length) throw new ValidationFailure(
    "controlled_post_apply_validation_final_receipt_hash_mismatch",
    "Final execution receipt bindings are invalid."
  );
  const outcomeValid = receipt.outcome === "validated"
    ? validation.validationDecision === "passed" &&
      validation.workspaceCleanupSucceeded === true &&
      repository.finalRepositoryState === "validated_applied_state" &&
      rollback.attempted === false && rollback.succeeded === null &&
      execution.rollbackWritePerformed === false
    : receipt.outcome === "validation_failed_rolled_back"
      ? repository.finalRepositoryState === "restored_x1_baseline" &&
        rollback.attempted === true && rollback.succeeded === true &&
        execution.rollbackWritePerformed === true
      : repository.finalRepositoryState === "unsafe_unknown_state" &&
        rollback.succeeded === false;
  if (!outcomeValid) throw new ValidationFailure(
    "controlled_post_apply_validation_final_receipt_hash_mismatch",
    "Final execution receipt outcome is inconsistent."
  );
  return receipt as unknown as ControlledPostApplyFinalReceipt;
}

/** Bounded read-only registry validators reused by transaction recovery. */
export function verifyControlledPostApplyValidationIntentRecord(
  value: unknown
): ControlledPostApplyValidationIntent {
  return deepFreeze(validateIntent(value));
}

export function verifyControlledPostApplyValidationResultRecord(
  value: unknown
): ControlledPostApplyValidationRecord {
  return deepFreeze(validateRecord(value));
}

export function verifyControlledPostApplyFinalReceiptRecord(
  value: unknown
): ControlledPostApplyFinalReceipt {
  return deepFreeze(validateFinalReceipt(value));
}

async function terminalFor(paths: ValidationPaths): Promise<
  "FINALIZED" | "VALIDATION_ROLLED_BACK" | "VALIDATION_ROLLBACK_FAILED" | "INCOMPLETE"
> {
  const transactionMetadata = await lstat(paths.transaction);
  if (!transactionMetadata.isDirectory() || transactionMetadata.isSymbolicLink() ||
      (transactionMetadata.mode & 0o777) !== 0o700) throw new ValidationFailure(
    "controlled_post_apply_validation_receipt_stale",
    "Validation transaction directory is invalid."
  );
  const names = await readdir(paths.transaction);
  const allowed = new Set([
    "validation-intent.json", "VALIDATION_STARTED", "validation-result.json",
    "final-receipt.json", ...TERMINALS
  ]);
  for (const name of names) {
    if (!allowed.has(name)) throw new ValidationFailure(
      "controlled_post_apply_validation_receipt_stale",
      "Validation transaction contains an unexpected entry."
    );
    const metadata = await lstat(path.join(paths.transaction, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o600 ||
        ((TERMINALS.includes(name as typeof TERMINALS[number]) ||
          name === "VALIDATION_STARTED") && metadata.size !== 0)) {
      throw new ValidationFailure(
        "controlled_post_apply_validation_receipt_stale",
        "Validation transaction record is invalid."
      );
    }
  }
  const found = TERMINALS.filter((terminal) => names.includes(terminal));
  if (found.length > 1) throw new ValidationFailure(
    "controlled_post_apply_validation_receipt_stale", "Multiple terminal markers are invalid."
  );
  return found[0] ?? "INCOMPLETE";
}

function finishFinalVerification(
  decision: ControlledPostApplyFinalReceiptVerificationDecision,
  integrity: boolean, registry: boolean,
  terminal: ControlledPostApplyFinalReceiptVerificationResult["terminalMarker"],
  repository: boolean, stale: string[], reasons: string[], summary: FinalVerificationSummary
): ControlledPostApplyFinalReceiptVerificationResult {
  return deepFreeze({
    decision, receiptIntegrityVerified: integrity, registryRecordVerified: registry,
    terminalMarker: terminal, repositoryStateMatched: repository,
    staleFields: sortedUnique(stale), reasonCodes: sortedUnique(reasons), summary
  });
}

export async function verifyControlledPostApplyFinalReceipt(
  input: ControlledPostApplyFinalReceiptVerificationInput
): Promise<ControlledPostApplyFinalReceiptVerificationResult> {
  const summary = initialFinalVerificationSummary();
  try {
    const top = exactObject(
      safeClone(input), VERIFY_FIELDS, "Final receipt verification input",
      ["repositoryPath", "registryDirectoryPath", "receipt", "applyReceipt",
        "authorization", "expectedInspection"]
    );
    const timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxGitOutputBytes = numeric(
      top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    const receipt = validateFinalReceipt(top.receipt);
    const applyReceipt = top.applyReceipt as ControlledRepositoryApplyReceipt;
    const authorization = top.authorization as ControlledApplyExecutionAuthorization;
    const expectedInspection = top.expectedInspection as ControlledRepositoryInspection;
    const stale: string[] = [];
    const compare = (field: string, left: unknown, right: unknown) => {
      if (!canonicalEqual(left, right)) stale.push(field);
    };
    compare("x4ApplyReceiptHash", receipt.x4ApplyReceiptHash, applyReceipt.receiptHash);
    compare("authorizationHash", receipt.authorizationHash, authorization.authorizationHash);
    compare("consumptionKey", receipt.consumptionKey, authorization.consumptionKey);
    compare("governedArtifactHash", receipt.governedArtifactHash,
      authorization.governedArtifactHash);
    compare("handoffHash", receipt.handoffHash, authorization.handoffHash);
    compare("mutationHash", receipt.mutation.mutationHash,
      authorization.mutation.mutationHash);
    compare("changedFiles", receipt.mutation.changedFiles,
      authorization.mutation.changedFiles);
    compare("x4AppliedStateHash", receipt.repository.x4AppliedStateHash,
      applyReceipt.after.appliedStateHash);
    compare("x4FinalScopeHash", receipt.repository.x4FinalScopeHash,
      applyReceipt.after.finalScopeHash);
    summary.x4ApplyReceiptMatched = !stale.includes("x4ApplyReceiptHash");
    summary.authorizationMatched = !stale.some((field) => [
      "authorizationHash", "governedArtifactHash", "handoffHash", "mutationHash",
      "changedFiles"
    ].includes(field));
    summary.consumptionKeyMatched = !stale.includes("consumptionKey");
    const registry = await validateRegistryPath(top.registryDirectoryPath);
    const paths = validationPaths(registry, receipt.consumptionKey);
    const terminal = await terminalFor(paths);
    if (terminal === "INCOMPLETE" || terminal === "VALIDATION_ROLLBACK_FAILED") {
      summary.recoveryRequired = true;
      return finishFinalVerification(
        "controlled_post_apply_final_receipt_requires_recovery", true, false,
        terminal, false, [...stale, "terminalMarker"],
        ["controlled_post_apply_validation_recovery_required"], summary
      );
    }
    const intent = validateIntent(await readCanonical(paths.intent));
    const record = validateRecord(await readCanonical(paths.record));
    const diskReceipt = validateFinalReceipt(await readCanonical(paths.receipt));
    summary.validationIntentMatched = intent.intentHash === record.intentHash &&
      intent.x4ApplyReceiptHash === receipt.x4ApplyReceiptHash &&
      intent.authorizationHash === receipt.authorizationHash;
    summary.validationRecordMatched = record.recordHash ===
      hashWithout(record as unknown as PlainRecord, "recordHash") &&
      record.currentExecutionResultHash === receipt.validation.currentExecutionResultHash &&
      canonicalEqual(diskReceipt, receipt);
    if (!summary.validationIntentMatched) stale.push("intentHash");
    if (!summary.validationRecordMatched) stale.push("validationRecordHash");
    let repositoryMatched = false;
    if (receipt.outcome === "validated" && terminal === "FINALIZED") {
      const x4 = await verifyControlledRepositoryApplyReceipt({
        repositoryPath: top.repositoryPath as string,
        registryDirectoryPath: top.registryDirectoryPath as string,
        receipt: applyReceipt, authorization, expectedInspection,
        timeoutMs, maxGitOutputBytes
      });
      repositoryMatched = x4.decision === "controlled_repository_apply_receipt_current";
      const inspection = await inspectControlledRepository({
        repositoryPath: top.repositoryPath as string,
        changedFiles: applyReceipt.mutation.changedFiles,
        timeoutMs, maxGitOutputBytes
      });
      if (receipt.repository.finalInspectionHash !==
          (inspection.inspection?.inspectionHash ?? null)) {
        repositoryMatched = false;
        stale.push("finalInspectionHash");
      }
      summary.finalizedAppliedStateMatched = repositoryMatched;
      if (!repositoryMatched) stale.push("x4AppliedStateHash");
    } else if (receipt.outcome === "validation_failed_rolled_back" &&
        terminal === "VALIDATION_ROLLED_BACK") {
      const inspection = await inspectControlledRepository({
        repositoryPath: top.repositoryPath as string,
        changedFiles: expectedInspection.rollbackManifest.changedFiles,
        expectedTarget: expectedInspection.target, timeoutMs, maxGitOutputBytes
      });
      repositoryMatched = inspection.decision === "repository_inspection_ready" &&
        inspection.inspection?.inspectionHash === expectedInspection.inspectionHash &&
        inspection.inspection?.rollbackManifest.manifestHash ===
          expectedInspection.rollbackManifest.manifestHash;
      if (receipt.repository.finalInspectionHash !== expectedInspection.inspectionHash) {
        repositoryMatched = false;
        stale.push("finalInspectionHash");
      }
      summary.restoredBaselineMatched = repositoryMatched;
      if (!repositoryMatched) stale.push("finalInspectionHash");
    } else stale.push("terminalMarker");
    const registryMatched = summary.validationIntentMatched &&
      summary.validationRecordMatched && stale.length === 0;
    if (!repositoryMatched || !registryMatched) return finishFinalVerification(
      "controlled_post_apply_final_receipt_stale", true, registryMatched,
      terminal, repositoryMatched, stale,
      ["controlled_post_apply_validation_receipt_stale"], summary
    );
    return finishFinalVerification(
      "controlled_post_apply_final_receipt_current", true, true,
      terminal, true, [], [], summary
    );
  } catch (error) {
    const code = error instanceof ValidationFailure ? error.code :
      "invalid_controlled_post_apply_validation_input";
    return finishFinalVerification(
      "controlled_post_apply_final_receipt_invalid", false, false,
      null, false, [], [code], summary
    );
  }
}
