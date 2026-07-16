/**
 * Phase X.4 is the first real repository-write security boundary. It creates
 * an external durable consumption claim before every repository write and
 * never releases that claim; incomplete claims permanently block reuse.
 * Returned evidence never contains source bytes or absolute paths. The
 * executor writes only authorized worktree files and bounded registry records,
 * never stages, commits, pushes, invokes a shell, or changes Git history.
 * Emergency rollback uses only the sealed X.2 bundle. A successful apply is
 * not deployment and still requires X.5 post-apply validation. Process crashes
 * cannot be made atomically consistent across filesystems, so incomplete
 * transactions require a future recovery command or human review.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readlink, realpath, stat, symlink, unlink
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  computeGovernedMutationHash,
  deriveGovernedMutationChangedFiles
} from "./controlled-apply-handoff.js";
import {
  verifyControlledApplyExecutionAuthorization,
  type ControlledApplyExecutionAuthorization,
  type ControlledApplyExecutionAuthorizationVerificationResult,
  type ControlledApplyExecutionGateInput
} from "./controlled-apply-execution-gate.js";
import {
  inspectControlledRepository,
  type ControlledRepositoryInspection,
  type ControlledRepositoryInspectionResult,
  type ControlledRollbackFileEntry
} from "./controlled-repository-inspection.js";
import {
  verifyControlledRollbackBundle,
  type ControlledRollbackBundleManifest,
  type ControlledRollbackPayloadEntry
} from "./controlled-rollback-bundle.js";
import type { GovernedChangeKind } from "./governed-change-artifact.js";
import { validateWorkspaceMutationContract, type WorkspaceMutation } from "./workspace-mutation.js";

export const CONTROLLED_REPOSITORY_APPLY_VERSION = "1" as const;

export type ControlledRepositoryApplyDecision =
  | "controlled_repository_apply_succeeded"
  | "controlled_repository_apply_rolled_back"
  | "controlled_repository_apply_blocked"
  | "controlled_repository_apply_invalid"
  | "controlled_repository_apply_needs_review"
  | "controlled_repository_apply_rollback_failed";

export type ControlledRepositoryApplyPolicy = {
  policyVersion: "1";
  requireCurrentExecutionAuthorization: true;
  requireNotConsumedStatus: true;
  requireExclusiveConsumptionClaim: true;
  recheckRepositoryAfterClaim: true;
  recheckEveryTargetBeforeMutation: true;
  restrictWritesToChangedFiles: true;
  rejectUnexpectedWorktreeChanges: true;
  requireExactMutationContentMatch: true;
  requireExactFinalScopeMatch: true;
  preserveExistingExecutableMode: true;
  useDefaultModeForNewRegularFiles: true;
  requireParentDirectoriesToExist: true;
  rejectSymlinkedParentDirectories: true;
  rejectWritingThroughSymlinkTargets: true;
  writeDurableTransactionIntentBeforeFirstWrite: true;
  fsyncWrittenRegularFilesWhenSupported: true;
  fsyncRegistryRecordsWhenSupported: true;
  rollbackOnApplyFailure: true;
  rollbackOnScopeFailure: true;
  rollbackOnResultMismatch: true;
  verifyRollbackAgainstExpectedInspection: true;
  neverReleaseConsumptionClaim: true;
  forbidGitIndexMutation: true;
  forbidGitHistoryMutation: true;
  forbidShellExecution: true;
};

const STRICT_POLICY: ControlledRepositoryApplyPolicy = {
  policyVersion: "1",
  requireCurrentExecutionAuthorization: true,
  requireNotConsumedStatus: true,
  requireExclusiveConsumptionClaim: true,
  recheckRepositoryAfterClaim: true,
  recheckEveryTargetBeforeMutation: true,
  restrictWritesToChangedFiles: true,
  rejectUnexpectedWorktreeChanges: true,
  requireExactMutationContentMatch: true,
  requireExactFinalScopeMatch: true,
  preserveExistingExecutableMode: true,
  useDefaultModeForNewRegularFiles: true,
  requireParentDirectoriesToExist: true,
  rejectSymlinkedParentDirectories: true,
  rejectWritingThroughSymlinkTargets: true,
  writeDurableTransactionIntentBeforeFirstWrite: true,
  fsyncWrittenRegularFilesWhenSupported: true,
  fsyncRegistryRecordsWhenSupported: true,
  rollbackOnApplyFailure: true,
  rollbackOnScopeFailure: true,
  rollbackOnResultMismatch: true,
  verifyRollbackAgainstExpectedInspection: true,
  neverReleaseConsumptionClaim: true,
  forbidGitIndexMutation: true,
  forbidGitHistoryMutation: true,
  forbidShellExecution: true
};

export type ControlledRepositoryApplyInput = {
  authorization: ControlledApplyExecutionAuthorization;
  gateInput: ControlledApplyExecutionGateInput;
  registryDirectoryPath: string;
  policy?: ControlledRepositoryApplyPolicy;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
  maxMutationFileBytes?: number;
  maxMutationTotalBytes?: number;
};

export type ControlledApplyConsumptionReservation = {
  registryVersion: "1";
  consumptionKey: string;
  authorizationHash: string;
  handoffHash: string;
  governedArtifactHash: string;
  mutationHash: string;
  changedFiles: readonly string[];
  repositoryIdentityHash: string;
  baseRevisionHash: string;
  worktreeStateHash: string;
  rollbackBundleManifestHash: string;
  rollbackBundleReceiptHash: string;
  policyHash: string;
  reservationHash: string;
};

export type ControlledRepositoryApplyTransactionIntent = {
  transactionVersion: "1";
  reservationHash: string;
  authorizationHash: string;
  consumptionKey: string;
  mutationHash: string;
  changedFiles: readonly string[];
  expectedInspectionHash: string;
  rollbackManifestHash: string;
  expectedOperations: readonly {
    filePath: string;
    operation: "create" | "update" | "delete";
    expectedBeforeStateHash: string;
    expectedAfterStateHash: string;
  }[];
  transactionHash: string;
};

export type ControlledRepositoryApplyStepRecord = {
  stepVersion: "1";
  index: number;
  filePath: string;
  operation: "create" | "update" | "delete";
  actualAfterStateHash: string;
  expectedAfterStateHash: string;
  matched: true;
  stepHash: string;
};

export type ControlledRepositoryAppliedFileEntry = {
  filePath: string;
  operation: "create" | "update" | "delete";
  finalState: "regular_file" | "symlink" | "absent";
  finalMode: "100644" | "100755" | "120000" | null;
  finalContentHash: string | null;
  finalStateHash: string;
  gitStatusObserved: boolean;
};

export type ControlledRepositoryApplyReceipt = {
  receiptVersion: "1";
  outcome: "applied" | "rolled_back" | "rollback_failed";
  authorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  consumptionKey: string;
  reservationHash: string;
  transactionHash: string;
  mutation: {
    changeKind: GovernedChangeKind;
    mutationHash: string;
    changedFiles: readonly string[];
    changedFileCount: number;
  };
  before: {
    repositoryIdentityHash: string;
    baseRevisionHash: string;
    worktreeStateHash: string;
    expectedInspectionHash: string;
    rollbackManifestHash: string;
    rollbackBundleManifestHash: string;
    rollbackBundleReceiptHash: string;
    rollbackPayloadRootHash: string;
  };
  after: {
    appliedStateHash: string | null;
    finalScopeHash: string | null;
    appliedFiles: readonly ControlledRepositoryAppliedFileEntry[];
    observedChangedFiles: readonly string[];
    unexpectedChangedFiles: readonly string[];
  };
  execution: {
    writeStarted: boolean;
    attemptedOperationCount: number;
    completedOperationCount: number;
    mutationApplyAttempted: boolean;
    mutationApplied: boolean;
    emergencyRollbackExecuted: boolean;
    emergencyRollbackSucceeded: boolean | null;
    finalRepositoryMatchesBeforeState: boolean;
    gitIndexMutated: false;
    gitHistoryMutated: false;
    shellExecuted: false;
  };
  receiptHash: string;
};

export type ControlledRepositoryApplyIssueSeverity = "review" | "error";
export type ControlledRepositoryApplyIssue = {
  code: string;
  message: string;
  severity: ControlledRepositoryApplyIssueSeverity;
  field?: string;
  filePath?: string;
  hashValue?: string;
};

export type ControlledRepositoryApplyResult = {
  decision: ControlledRepositoryApplyDecision;
  issues: readonly ControlledRepositoryApplyIssue[];
  receipt: ControlledRepositoryApplyReceipt | null;
  authorizationVerification: ControlledApplyExecutionAuthorizationVerificationResult | null;
  postClaimInspection: ControlledRepositoryInspectionResult | null;
  rollbackInspection: ControlledRepositoryInspectionResult | null;
  summary: ApplySummary;
};

export type ControlledRepositoryApplyReceiptVerificationInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  receipt: ControlledRepositoryApplyReceipt;
  authorization: ControlledApplyExecutionAuthorization;
  expectedInspection: ControlledRepositoryInspection;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledRepositoryApplyReceiptVerificationDecision =
  | "controlled_repository_apply_receipt_current"
  | "controlled_repository_apply_receipt_stale"
  | "controlled_repository_apply_receipt_invalid"
  | "controlled_repository_apply_receipt_requires_recovery";

export type ControlledRepositoryApplyReceiptVerificationResult = {
  decision: ControlledRepositoryApplyReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  registryRecordVerified: boolean;
  terminalMarker: "COMMITTED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "INCOMPLETE" | null;
  repositoryStateMatched: boolean;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  summary: VerificationSummary;
};

export type ControlledRepositoryRollbackRestorationInput = {
  gateInput: ControlledApplyExecutionGateInput;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
};

export type ControlledRepositoryRollbackRestorationResult = {
  rollbackBundleVerified: boolean;
  rollbackInspection: ControlledRepositoryInspectionResult;
  baselineRestored: boolean;
};

export type ControlledRepositoryFileStateEvidence = {
  state: "regular_file" | "symlink" | "directory" | "other" | "absent";
  mode: "100644" | "100755" | "120000" | null;
  contentHash: string | null;
  size: number;
  stateHash: string;
};

/** Narrow compatibility helpers for read-only recovery boundaries. */
export function computeControlledApplyConsumptionReservationHash(
  reservation: ControlledApplyConsumptionReservation
): string {
  return hashWithout(reservation as unknown as PlainRecord, "reservationHash");
}

export function computeControlledRepositoryApplyTransactionHash(
  transaction: ControlledRepositoryApplyTransactionIntent
): string {
  return hashWithout(transaction as unknown as PlainRecord, "transactionHash");
}

export function computeControlledRepositoryApplyReceiptHash(
  receipt: ControlledRepositoryApplyReceipt
): string {
  return hashWithout(receipt as unknown as PlainRecord, "receiptHash");
}

type ApplySummary = {
  inputValid: boolean;
  policyValid: boolean;
  authorizationCurrent: boolean;
  firstWriteEligible: boolean;
  registryPathValid: boolean;
  consumptionClaimCreated: boolean;
  consumptionClaimPreviouslyExisted: boolean;
  consumptionClaimPermanent: boolean;
  reservationWritten: boolean;
  reservationVerified: boolean;
  transactionIntentWritten: boolean;
  transactionIntentVerified: boolean;
  repositoryRecheckedAfterClaim: boolean;
  repositoryMatchedBeforeWrite: boolean;
  writeStarted: boolean;
  attemptedOperationCount: number;
  completedOperationCount: number;
  appliedStateMatched: boolean;
  finalScopeMatched: boolean;
  unexpectedChangedFileCount: number;
  emergencyRollbackExecuted: boolean;
  emergencyRollbackSucceeded: boolean | null;
  applyReceiptWritten: boolean;
  applyReceiptVerified: boolean;
  terminalRegistryMarker: "COMMITTED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | null;
  mutationApplied: boolean;
  repositoryWritePerformed: boolean;
  gitIndexMutated: false;
  gitHistoryMutated: false;
  shellExecuted: false;
  postApplyValidationExecuted: false;
  commitCreated: false;
  pushExecuted: false;
};

type VerificationSummary = {
  authorizationMatched: boolean;
  consumptionKeyMatched: boolean;
  reservationMatched: boolean;
  transactionMatched: boolean;
  stepRecordsMatched: boolean;
  receiptFileMatched: boolean;
  successfulApplyStateMatched: boolean;
  restoredBaselineMatched: boolean;
  recoveryRequired: boolean;
  repositoryWritePerformedByVerifier: false;
  gitMutationPerformedByVerifier: false;
  shellExecutedByVerifier: false;
};

type PlainRecord = Record<string, unknown>;
type FailureKind = "invalid" | "review" | "blocked";
type Operation = {
  filePath: string;
  operation: "create" | "update" | "delete";
  bytes: Buffer | null;
  baseline: ControlledRollbackFileEntry;
  expectedBeforeStateHash: string;
  expectedAfterStateHash: string;
  finalMode: "100644" | "100755" | null;
};
type FileState = {
  state: "regular_file" | "symlink" | "directory" | "other" | "absent";
  mode: "100644" | "100755" | "120000" | null;
  contentHash: string | null;
  size: number;
  stateHash: string;
};
type RegistryPaths = {
  registry: string;
  claims: string;
  claim: string;
  reservation: string;
  transaction: string;
  writeStarted: string;
  steps: string;
  applyReceipt: string;
  rollbackReceipt: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MUTATION_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MUTATION_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MUTATION_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_MUTATION_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_NODES = 300_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const INPUT_FIELDS = [
  "authorization", "gateInput", "registryDirectoryPath", "policy", "timeoutMs",
  "maxGitOutputBytes", "maxEntryBytes", "maxBundleBytes", "maxMutationFileBytes",
  "maxMutationTotalBytes"
] as const;
const VERIFY_INPUT_FIELDS = [
  "repositoryPath", "registryDirectoryPath", "receipt", "authorization",
  "expectedInspection", "timeoutMs", "maxGitOutputBytes"
] as const;
const TERMINAL_MARKERS = ["COMMITTED", "ROLLED_BACK", "ROLLBACK_FAILED"] as const;
const execFileAsync = promisify(execFile);

class ApplyFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: FailureKind = "invalid",
    readonly field?: string,
    readonly filePath?: string,
    readonly hashValue?: string
  ) { super(message); }
}
class TrustedApplyConfigurationError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY:
Readonly<ControlledRepositoryApplyPolicy> = deepFreeze({ ...STRICT_POLICY });

function initialSummary(): ApplySummary {
  return {
    inputValid: false, policyValid: false, authorizationCurrent: false,
    firstWriteEligible: false, registryPathValid: false,
    consumptionClaimCreated: false, consumptionClaimPreviouslyExisted: false,
    consumptionClaimPermanent: false, reservationWritten: false,
    reservationVerified: false, transactionIntentWritten: false,
    transactionIntentVerified: false, repositoryRecheckedAfterClaim: false,
    repositoryMatchedBeforeWrite: false, writeStarted: false,
    attemptedOperationCount: 0, completedOperationCount: 0,
    appliedStateMatched: false, finalScopeMatched: false,
    unexpectedChangedFileCount: 0, emergencyRollbackExecuted: false,
    emergencyRollbackSucceeded: null, applyReceiptWritten: false,
    applyReceiptVerified: false, terminalRegistryMarker: null,
    mutationApplied: false, repositoryWritePerformed: false,
    gitIndexMutated: false, gitHistoryMutated: false, shellExecuted: false,
    postApplyValidationExecuted: false, commitCreated: false, pushExecuted: false
  };
}

function initialVerificationSummary(): VerificationSummary {
  return {
    authorizationMatched: false, consumptionKeyMatched: false,
    reservationMatched: false, transactionMatched: false,
    stepRecordsMatched: false, receiptFileMatched: false,
    successfulApplyStateMatched: false, restoredBaselineMatched: false,
    recoveryRequired: false, repositoryWritePerformedByVerifier: false,
    gitMutationPerformedByVerifier: false, shellExecutedByVerifier: false
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function safeClone(value: unknown, ancestors = new WeakSet<object>(), count = { n: 0 }): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") throw new ApplyFailure(
    "invalid_controlled_repository_apply_object", "Unsupported apply evidence value."
  );
  if (++count.n > MAX_NODES) throw new ApplyFailure(
    "invalid_controlled_repository_apply_object", "Apply evidence exceeds bounded structure."
  );
  if (ancestors.has(value)) throw new ApplyFailure(
    "invalid_controlled_repository_apply_object", "Cyclic apply evidence is invalid."
  );
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new ApplyFailure(
      "invalid_controlled_repository_apply_object", "Exotic apply evidence is invalid."
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new ApplyFailure(
    "controlled_repository_apply_symbol_property", "Symbol properties are forbidden."
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) throw new ApplyFailure(
      "controlled_repository_apply_accessor_property", "Accessor properties are forbidden."
    );
  }
  ancestors.add(value);
  try {
    if (array) {
      if (Object.keys(value).length !== value.length) throw new ApplyFailure(
        "invalid_controlled_repository_apply_object", "Sparse arrays are invalid."
      );
      return value.map((entry) => safeClone(entry, ancestors, count));
    }
    const result: PlainRecord = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) throw new ApplyFailure(
        "invalid_controlled_repository_apply_object", "Hidden properties are invalid."
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApplyFailure(
    "invalid_controlled_repository_apply_input", `${label} is invalid.`
  );
  const record = value as PlainRecord;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new ApplyFailure(
    "unknown_controlled_repository_apply_field", `${label} has an unknown field.`,
    "invalid", key
  );
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new ApplyFailure(
      "missing_controlled_repository_apply_field", `${label} is missing a field.`,
      "invalid", key
    );
  }
  return record;
}

function normalizePolicy(value: unknown): ControlledRepositoryApplyPolicy {
  if (value === undefined) return { ...STRICT_POLICY };
  const record = exactObject(value, Object.keys(STRICT_POLICY), "Apply policy");
  for (const [key, expected] of Object.entries(STRICT_POLICY)) {
    if (record[key] !== expected) throw new TrustedApplyConfigurationError(
      "controlled_repository_apply_policy_relaxation_forbidden"
    );
  }
  return record as ControlledRepositoryApplyPolicy;
}

function numeric(
  record: PlainRecord, field: string, fallback: number, maximum: number
): number {
  const value = record[field];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TrustedApplyConfigurationError("controlled_repository_apply_policy_invalid");
  }
  return value as number;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalizeJson(left) === canonicalizeJson(right); } catch { return false; }
}

function issue(error: ApplyFailure): ControlledRepositoryApplyIssue {
  return {
    code: error.code, message: error.message,
    severity: error.kind === "review" ? "review" : "error",
    ...(error.field ? { field: error.field } : {}),
    ...(error.filePath ? { filePath: error.filePath } : {}),
    ...(error.hashValue ? { hashValue: error.hashValue } : {})
  };
}

function finish(
  decision: ControlledRepositoryApplyDecision,
  issues: ControlledRepositoryApplyIssue[], receipt: ControlledRepositoryApplyReceipt | null,
  authorizationVerification: ControlledApplyExecutionAuthorizationVerificationResult | null,
  postClaimInspection: ControlledRepositoryInspectionResult | null,
  rollbackInspection: ControlledRepositoryInspectionResult | null, summary: ApplySummary
): ControlledRepositoryApplyResult {
  return deepFreeze({
    decision, issues, receipt, authorizationVerification, postClaimInspection,
    rollbackInspection, summary
  });
}

function decisionForFailure(error: ApplyFailure): ControlledRepositoryApplyDecision {
  return error.kind === "review" ? "controlled_repository_apply_needs_review" :
    error.kind === "blocked" ? "controlled_repository_apply_blocked" :
      "controlled_repository_apply_invalid";
}

function validConfiguredPath(value: unknown): value is string {
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
    if (metadata.isSymbolicLink()) throw new ApplyFailure(
      "controlled_repository_apply_registry_symlink_detected",
      "A registry path segment is a symbolic link."
    );
  }
}

async function runGit(
  repositoryPath: string, args: readonly string[], timeoutMs: number, maxBytes: number
): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: repositoryPath, encoding: "utf8", timeout: timeoutMs,
      maxBuffer: maxBytes, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    return result.stdout;
  } catch {
    throw new ApplyFailure(
      "controlled_repository_apply_exception", "A bounded Git inspection failed."
    );
  }
}

async function validateRegistry(
  configuredPath: unknown, repositoryPath: string, bundlePath: string,
  timeoutMs: number, maxGitOutputBytes: number
): Promise<string> {
  if (!validConfiguredPath(configuredPath)) throw new ApplyFailure(
    "controlled_repository_apply_registry_path_invalid", "Registry path is invalid."
  );
  await noSymlinkSegments(configuredPath);
  const metadata = await lstat(configuredPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ApplyFailure(
    "controlled_repository_apply_registry_path_invalid", "Registry must be a real directory."
  );
  if ((metadata.mode & 0o777) !== 0o700) throw new ApplyFailure(
    "controlled_repository_apply_registry_permissions_unsafe",
    "Registry permissions are not private.", "review"
  );
  const registry = await realpath(configuredPath);
  const repository = await realpath(repositoryPath);
  const bundle = await realpath(bundlePath);
  const commonRaw = (await runGit(
    repository, ["rev-parse", "--git-common-dir"], timeoutMs, maxGitOutputBytes
  )).trim();
  const gitCommon = await realpath(path.resolve(repository, commonRaw));
  if (inside(repository, registry)) throw new ApplyFailure(
    "controlled_repository_apply_registry_inside_repository",
    "Registry must be outside the repository."
  );
  if (inside(gitCommon, registry)) throw new ApplyFailure(
    "controlled_repository_apply_registry_inside_git_directory",
    "Registry must be outside the Git directory."
  );
  if (inside(bundle, registry) || inside(registry, bundle)) throw new ApplyFailure(
    "controlled_repository_apply_registry_inside_bundle",
    "Registry must be separate from the rollback bundle."
  );
  return registry;
}

async function validateRegistryForVerifier(
  configuredPath: unknown, repository: string, timeoutMs: number, maxGitOutputBytes: number
): Promise<string> {
  if (!validConfiguredPath(configuredPath)) throw new ApplyFailure(
    "controlled_repository_apply_registry_path_invalid", "Registry path is invalid."
  );
  await noSymlinkSegments(configuredPath);
  const metadata = await lstat(configuredPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_path_invalid", "Registry must be a private directory."
    );
  }
  const registry = await realpath(configuredPath);
  const commonRaw = (await runGit(
    repository, ["rev-parse", "--git-common-dir"], timeoutMs, maxGitOutputBytes
  )).trim();
  const gitCommon = await realpath(path.resolve(repository, commonRaw));
  if (inside(repository, registry) || inside(gitCommon, registry)) throw new ApplyFailure(
    "controlled_repository_apply_registry_path_invalid",
    "Registry overlaps protected repository state."
  );
  return registry;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EBADF") {
      throw error;
    }
  } finally { await handle?.close().catch(() => undefined); }
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonicalizeJson(value), "utf8");
  const handle = await open(
    file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600
  );
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function createMarker(file: string): Promise<void> {
  const handle = await open(
    file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600
  );
  try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function readCanonical<T>(file: string, maxBytes = DEFAULT_ENTRY_BYTES): Promise<T> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Registry record is invalid."
    );
  }
  const bytes = await readFile(file);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Registry record is invalid."
    );
  }
  if (!bytes.equals(Buffer.from(canonicalizeJson(parsed), "utf8"))) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Registry record is noncanonical."
  );
  return parsed as T;
}

function hashWithout<T extends PlainRecord>(value: T, field: string): string {
  const material = { ...value };
  delete material[field];
  return hashCanonicalJson(material);
}

function registryPaths(registry: string, consumptionKey: string): RegistryPaths {
  if (!HASH.test(consumptionKey)) throw new ApplyFailure(
    "controlled_repository_apply_authorization_invalid", "Consumption key is invalid."
  );
  const claim = path.join(registry, "claims", consumptionKey.slice("sha256:".length));
  return {
    registry, claims: path.join(registry, "claims"), claim,
    reservation: path.join(claim, "reservation.json"),
    transaction: path.join(claim, "transaction.json"),
    writeStarted: path.join(claim, "WRITE_STARTED"),
    steps: path.join(claim, "steps"),
    applyReceipt: path.join(claim, "apply-receipt.json"),
    rollbackReceipt: path.join(claim, "rollback-receipt.json")
  };
}

async function ensureClaimsDirectory(paths: RegistryPaths): Promise<void> {
  let created = false;
  try { await mkdir(paths.claims, { mode: 0o700 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) await chmod(paths.claims, 0o700);
  const metadata = await lstat(paths.claims);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid",
      "Claims registry is not a private real directory."
    );
  }
}

async function existingClaimFailure(paths: RegistryPaths): Promise<ApplyFailure> {
  let names: string[];
  try {
    const metadata = await lstat(paths.claim);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o700) return new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid",
      "Existing consumption claim is not a real directory."
    );
    const { readdir } = await import("node:fs/promises");
    names = await readdir(paths.claim);
  } catch {
    return new ApplyFailure(
      "controlled_repository_apply_consumption_claim_exists",
      "Consumption claim already exists.", "blocked"
    );
  }
  if (names.includes("ROLLBACK_FAILED")) return new ApplyFailure(
    "controlled_repository_apply_consumption_claim_incomplete",
    "A previous unsafe transaction exists.", "blocked"
  );
  if (names.includes("COMMITTED") || names.includes("ROLLED_BACK")) return new ApplyFailure(
    "controlled_repository_apply_consumption_key_already_used",
    "Consumption key was already used.", "blocked"
  );
  return new ApplyFailure(
    "controlled_repository_apply_consumption_claim_incomplete",
    "An incomplete or active consumption claim exists.", "blocked"
  );
}

function stateHash(
  state: FileState["state"], mode: FileState["mode"], contentHash: string | null
): string {
  return hashCanonicalJson({
    artifactType: "controlled_repository_file_state", state, mode, contentHash
  });
}

async function actualState(target: string, maxBytes: number): Promise<FileState> {
  let metadata;
  try { metadata = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: "absent", mode: null, contentHash: null, size: 0,
        stateHash: stateHash("absent", null, null)
      };
    }
    throw error;
  }
  if (metadata.isFile()) {
    if (metadata.size > maxBytes) throw new ApplyFailure(
      "controlled_repository_apply_entry_too_large", "A mutation file exceeds its bound."
    );
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    const mode = (metadata.mode & 0o111) !== 0 ? "100755" : "100644";
    const contentHash = sha256(bytes);
    return {
      state: "regular_file", mode, contentHash, size: bytes.length,
      stateHash: stateHash("regular_file", mode, contentHash)
    };
  }
  if (metadata.isSymbolicLink()) {
    const link = await readlink(target, { encoding: "buffer" });
    if (link.length > maxBytes) throw new ApplyFailure(
      "controlled_repository_apply_entry_too_large", "A symlink exceeds its bound."
    );
    const contentHash = sha256(link);
    return {
      state: "symlink", mode: "120000", contentHash, size: link.length,
      stateHash: stateHash("symlink", "120000", contentHash)
    };
  }
  const state = metadata.isDirectory() ? "directory" : "other";
  return { state, mode: null, contentHash: null, size: 0,
    stateHash: stateHash(state, null, null) };
}

/** Content-free state inspection reused by X.5 workspace binding. */
export async function inspectControlledRepositoryFileState(
  targetPath: string,
  maxBytes = DEFAULT_ENTRY_BYTES
): Promise<ControlledRepositoryFileStateEvidence> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ENTRY_BYTES) {
    throw new TypeError("controlled_repository_apply_policy_invalid");
  }
  return deepFreeze(await actualState(targetPath, maxBytes));
}

function expectedBaselineState(entry: ControlledRollbackFileEntry): FileState {
  const state = entry.baselineState === "absent" ? "absent" :
    entry.baselineState === "tracked_symlink" ? "symlink" :
      entry.baselineState === "tracked_file" ? "regular_file" : "other";
  const mode = entry.baseMode === "100644" || entry.baseMode === "100755" ||
    entry.baseMode === "120000" ? entry.baseMode : null;
  const contentHash = state === "absent" ? null : entry.worktreeContentHash;
  return {
    state, mode, contentHash, size: 0, stateHash: stateHash(state, mode, contentHash)
  };
}

async function validateParent(repository: string, filePath: string): Promise<string> {
  if (typeof filePath !== "string" || filePath.length === 0 ||
      filePath.length > MAX_PATH_LENGTH || filePath.trim() !== filePath ||
      ASCII_CONTROL.test(filePath) || path.isAbsolute(filePath) || filePath.includes("\\") ||
      path.posix.normalize(filePath) !== filePath ||
      filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported", "Mutation path is unsafe.",
      "review", "changedFiles"
    );
  }
  const target = path.resolve(repository, filePath);
  if (!inside(repository, target) || filePath === ".git" || filePath.startsWith(".git/")) {
    throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported", "Mutation path is unsafe.",
      "review", "changedFiles", filePath
    );
  }
  const parent = path.dirname(target);
  const relative = path.relative(repository, parent);
  let current = repository;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApplyFailure(
        "controlled_repository_apply_parent_directory_missing",
        "A target parent directory is missing.", "review", undefined, filePath
      );
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new ApplyFailure(
      "controlled_repository_apply_parent_symlink_detected",
      "A target parent is a symbolic link.", "review", undefined, filePath
    );
    if (!metadata.isDirectory()) throw new ApplyFailure(
      "controlled_repository_apply_parent_directory_missing",
      "A target parent is not a directory.", "review", undefined, filePath
    );
  }
  return target;
}

function collectClaims(mutation: WorkspaceMutation): Map<string, Buffer> {
  if (!validateWorkspaceMutationContract(mutation).ok || mutation.role !== "remask" ||
      mutation.target !== "repairDraft" || !Array.isArray(mutation.claims)) {
    throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported",
      "Mutation cannot be represented by the supported apply contract.", "review"
    );
  }
  const result = new Map<string, Buffer>();
  for (const claim of mutation.claims) {
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) continue;
    const candidate = claim as PlainRecord;
    if (candidate.type !== "repair_draft") continue;
    if (["operation", "delete", "mode", "chmod", "symlinkTarget", "linkTarget"]
      .some((field) => Object.prototype.hasOwnProperty.call(candidate, field))) {
      throw new ApplyFailure(
        candidate.operation === "delete"
          ? "controlled_repository_apply_operation_unsupported"
          : "controlled_repository_apply_operation_unsupported",
        "The mutation requests an unsupported filesystem transformation.", "review"
      );
    }
    if (typeof candidate.file !== "string" || typeof candidate.proposedPatch !== "string" ||
        candidate.file.trim() !== candidate.file || result.has(candidate.file)) {
      throw new ApplyFailure(
        "controlled_repository_apply_operation_unsupported",
        "Repair-draft operations are ambiguous.", "review"
      );
    }
    result.set(candidate.file, Buffer.from(candidate.proposedPatch, "utf8"));
  }
  return result;
}

async function deriveOperations(
  repository: string, mutation: WorkspaceMutation, expected: ControlledRepositoryInspection,
  changedFiles: readonly string[], maxFileBytes: number, maxTotalBytes: number
): Promise<Operation[]> {
  const claims = collectClaims(mutation);
  if (changedFiles.length === 0) throw new ApplyFailure(
    "controlled_repository_apply_operation_unsupported",
    "An empty repository mutation requires review.", "review"
  );
  if (claims.size !== changedFiles.length || changedFiles.some((file) => !claims.has(file))) {
    throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported",
      "Every authorized file must have one exact repair-draft operation.", "review"
    );
  }
  const baselineByPath = new Map(
    expected.rollbackManifest.files.map((entry) => [entry.filePath, entry])
  );
  let total = 0;
  const operations: Operation[] = [];
  for (const filePath of [...changedFiles].sort()) {
    const baseline = baselineByPath.get(filePath);
    const bytes = claims.get(filePath)!;
    if (!baseline) throw new ApplyFailure(
      "controlled_repository_apply_baseline_mismatch", "Baseline entry is missing."
    );
    await validateParent(repository, filePath);
    if (baseline.baselineState === "tracked_gitlink") throw new ApplyFailure(
      "controlled_repository_apply_gitlink_unsupported", "Gitlink mutation is unsupported.",
      "review", undefined, filePath
    );
    if (baseline.baselineState === "tracked_symlink") throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported",
      "Symlink mutation is unsupported.", "review", undefined, filePath
    );
    if (baseline.worktreeEntryKind === "directory" || baseline.worktreeEntryKind === "other") {
      throw new ApplyFailure(
        "controlled_repository_apply_directory_operation_unsupported",
        "Directory or special-file mutation is unsupported.", "review", undefined, filePath
      );
    }
    if (bytes.length > maxFileBytes) throw new ApplyFailure(
      "controlled_repository_apply_entry_too_large", "Mutation file exceeds its bound.",
      "review", undefined, filePath
    );
    total += bytes.length;
    if (total > maxTotalBytes) throw new ApplyFailure(
      "controlled_repository_apply_total_bytes_exceeded", "Mutation total exceeds its bound.",
      "review"
    );
    const before = expectedBaselineState(baseline);
    const operation = baseline.baselineState === "absent" ? "create" : "update";
    const finalMode = operation === "create" ? "100644" :
      baseline.baseMode === "100755" ? "100755" : "100644";
    const afterHash = stateHash("regular_file", finalMode, sha256(bytes));
    if (before.stateHash === afterHash) throw new ApplyFailure(
      "controlled_repository_apply_operation_unsupported",
      "A semantic no-op is not supported by the existing apply contract.",
      "review", undefined, filePath
    );
    operations.push({
      filePath, operation, bytes, baseline,
      expectedBeforeStateHash: before.stateHash,
      expectedAfterStateHash: afterHash, finalMode
    });
  }
  return operations;
}

async function verifyAllBaselines(
  repository: string, operations: readonly Operation[], maxFileBytes: number
): Promise<void> {
  for (const operation of operations) {
    await validateParent(repository, operation.filePath);
    const current = await actualState(path.resolve(repository, operation.filePath), maxFileBytes);
    if (current.stateHash !== operation.expectedBeforeStateHash) throw new ApplyFailure(
      current.state === "symlink"
        ? "controlled_repository_apply_target_symlink_detected"
        : "controlled_repository_apply_baseline_mismatch",
      "A target no longer matches its baseline.", "blocked", undefined, operation.filePath
    );
  }
}

async function applyOperation(
  repository: string, operation: Operation, maxFileBytes: number
): Promise<FileState> {
  const target = await validateParent(repository, operation.filePath);
  const current = await actualState(target, maxFileBytes);
  if (current.stateHash !== operation.expectedBeforeStateHash) throw new ApplyFailure(
    "controlled_repository_apply_baseline_mismatch",
    "A target changed immediately before mutation.", "blocked", undefined, operation.filePath
  );
  if (operation.bytes === null) throw new ApplyFailure(
    "controlled_repository_apply_operation_unsupported", "Delete mutation is unsupported.",
    "review", undefined, operation.filePath
  );
  if (operation.operation === "create") {
    let handle;
    try {
      handle = await open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      await handle.writeFile(operation.bytes);
      await handle.sync();
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_create_failed", "A file create operation failed."
      );
    } finally { await handle?.close().catch(() => undefined); }
    await chmod(target, operation.finalMode === "100755" ? 0o755 : 0o644);
    await syncDirectory(path.dirname(target));
  } else if (operation.operation === "update") {
    let handle;
    try {
      handle = await open(target, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("not regular");
      const beforeBytes = await handle.readFile();
      const beforeMode = (metadata.mode & 0o111) !== 0 ? "100755" : "100644";
      if (stateHash("regular_file", beforeMode, sha256(beforeBytes)) !==
          operation.expectedBeforeStateHash) throw new Error("baseline mismatch");
      await handle.truncate(0);
      await handle.write(operation.bytes, 0, operation.bytes.length, 0);
      await handle.chmod(operation.finalMode === "100755" ? 0o755 : 0o644);
      await handle.sync();
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_update_failed", "A file update operation failed."
      );
    } finally { await handle?.close().catch(() => undefined); }
    await syncDirectory(path.dirname(target));
  } else {
    try { await unlink(target); await syncDirectory(path.dirname(target)); }
    catch { throw new ApplyFailure(
      "controlled_repository_apply_delete_failed", "A file delete operation failed."
    ); }
  }
  const after = await actualState(target, maxFileBytes);
  if (after.stateHash !== operation.expectedAfterStateHash) throw new ApplyFailure(
    "controlled_repository_apply_after_state_mismatch",
    "Actual file state does not match the authorized mutation."
  );
  return after;
}

function parseStatus(output: string): {
  observed: string[]; staged: boolean; conflict: boolean;
} {
  const observed: string[] = [];
  let staged = false;
  let conflict = false;
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("? ")) { observed.push(record.slice(2)); continue; }
    if (record.startsWith("u ")) conflict = true;
    if (record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ")) {
      const fields = record.split(" ");
      const xy = fields[1] ?? "";
      if (xy[0] !== ".") staged = true;
      const pathIndex = record.startsWith("1 ") ? 8 : record.startsWith("2 ") ? 9 : 10;
      if (fields[pathIndex]) observed.push(fields.slice(pathIndex).join(" "));
      if (record.startsWith("2 ")) index += 1;
    }
  }
  return { observed: sortedUnique(observed), staged, conflict };
}

async function finalStatus(
  repository: string, timeoutMs: number, maxGitOutputBytes: number,
  authorized: readonly string[]
): Promise<{ observed: string[]; unexpected: string[] }> {
  const output = await runGit(
    repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    timeoutMs, maxGitOutputBytes
  );
  const parsed = parseStatus(output);
  if (parsed.staged || parsed.conflict) throw new ApplyFailure(
    "controlled_repository_apply_final_scope_mismatch",
    "Staged or conflicted state is forbidden after apply."
  );
  const allowed = new Set(authorized);
  return {
    observed: parsed.observed,
    unexpected: parsed.observed.filter((file) => !allowed.has(file))
  };
}

function buildReservation(
  authorization: ControlledApplyExecutionAuthorization, policyHash: string
): ControlledApplyConsumptionReservation {
  const material = {
    registryVersion: "1" as const,
    consumptionKey: authorization.consumptionKey,
    authorizationHash: authorization.authorizationHash,
    handoffHash: authorization.handoffHash,
    governedArtifactHash: authorization.governedArtifactHash,
    mutationHash: authorization.mutation.mutationHash,
    changedFiles: [...authorization.mutation.changedFiles],
    repositoryIdentityHash: authorization.target.repositoryIdentityHash,
    baseRevisionHash: authorization.target.baseRevisionHash,
    worktreeStateHash: authorization.target.worktreeStateHash,
    rollbackBundleManifestHash: authorization.evidence.rollbackBundleManifestHash,
    rollbackBundleReceiptHash: authorization.evidence.rollbackBundleReceiptHash,
    policyHash
  };
  return { ...material, reservationHash: hashCanonicalJson(material) };
}

function buildTransaction(
  reservation: ControlledApplyConsumptionReservation,
  authorization: ControlledApplyExecutionAuthorization,
  expectedInspection: ControlledRepositoryInspection,
  operations: readonly Operation[]
): ControlledRepositoryApplyTransactionIntent {
  const material = {
    transactionVersion: "1" as const,
    reservationHash: reservation.reservationHash,
    authorizationHash: authorization.authorizationHash,
    consumptionKey: authorization.consumptionKey,
    mutationHash: authorization.mutation.mutationHash,
    changedFiles: [...authorization.mutation.changedFiles],
    expectedInspectionHash: expectedInspection.inspectionHash,
    rollbackManifestHash: expectedInspection.rollbackManifest.manifestHash,
    expectedOperations: operations.map((operation) => ({
      filePath: operation.filePath, operation: operation.operation,
      expectedBeforeStateHash: operation.expectedBeforeStateHash,
      expectedAfterStateHash: operation.expectedAfterStateHash
    }))
  };
  return { ...material, transactionHash: hashCanonicalJson(material) };
}

function buildReceipt(
  outcome: ControlledRepositoryApplyReceipt["outcome"],
  authorization: ControlledApplyExecutionAuthorization,
  gateInput: ControlledApplyExecutionGateInput,
  reservation: ControlledApplyConsumptionReservation,
  transaction: ControlledRepositoryApplyTransactionIntent,
  appliedFiles: readonly ControlledRepositoryAppliedFileEntry[],
  observedChangedFiles: readonly string[], unexpectedChangedFiles: readonly string[],
  summary: ApplySummary, finalRepositoryMatchesBeforeState: boolean
): ControlledRepositoryApplyReceipt {
  const appliedStateHash = outcome === "applied" ? hashCanonicalJson({
    artifactType: "controlled_repository_applied_state", entries: appliedFiles
  }) : null;
  const finalScopeHash = outcome === "applied" ? hashCanonicalJson({
    artifactType: "controlled_repository_apply_scope",
    authorizedChangedFiles: [...authorization.mutation.changedFiles],
    observedChangedFiles: [...observedChangedFiles],
    unexpectedChangedFiles: [...unexpectedChangedFiles]
  }) : null;
  const material = {
    receiptVersion: "1" as const, outcome,
    authorizationHash: authorization.authorizationHash,
    governedArtifactHash: authorization.governedArtifactHash,
    handoffHash: authorization.handoffHash,
    consumptionKey: authorization.consumptionKey,
    reservationHash: reservation.reservationHash,
    transactionHash: transaction.transactionHash,
    mutation: {
      changeKind: authorization.mutation.changeKind,
      mutationHash: authorization.mutation.mutationHash,
      changedFiles: [...authorization.mutation.changedFiles],
      changedFileCount: authorization.mutation.changedFileCount
    },
    before: {
      repositoryIdentityHash: authorization.target.repositoryIdentityHash,
      baseRevisionHash: authorization.target.baseRevisionHash,
      worktreeStateHash: authorization.target.worktreeStateHash,
      expectedInspectionHash: authorization.evidence.expectedInspectionHash,
      rollbackManifestHash: authorization.evidence.rollbackManifestHash,
      rollbackBundleManifestHash: authorization.evidence.rollbackBundleManifestHash,
      rollbackBundleReceiptHash: authorization.evidence.rollbackBundleReceiptHash,
      rollbackPayloadRootHash: authorization.evidence.rollbackPayloadRootHash
    },
    after: {
      appliedStateHash, finalScopeHash,
      appliedFiles: [...appliedFiles], observedChangedFiles: [...observedChangedFiles],
      unexpectedChangedFiles: [...unexpectedChangedFiles]
    },
    execution: {
      writeStarted: summary.writeStarted,
      attemptedOperationCount: summary.attemptedOperationCount,
      completedOperationCount: summary.completedOperationCount,
      mutationApplyAttempted: summary.attemptedOperationCount > 0,
      mutationApplied: outcome === "applied",
      emergencyRollbackExecuted: summary.emergencyRollbackExecuted,
      emergencyRollbackSucceeded: summary.emergencyRollbackSucceeded,
      finalRepositoryMatchesBeforeState,
      gitIndexMutated: false as const, gitHistoryMutated: false as const,
      shellExecuted: false as const
    }
  };
  return { ...material, receiptHash: hashCanonicalJson(material) };
}

async function persistStep(
  paths: RegistryPaths, index: number, operation: Operation, actual: FileState
): Promise<void> {
  const material = {
    stepVersion: "1" as const, index, filePath: operation.filePath,
    operation: operation.operation, actualAfterStateHash: actual.stateHash,
    expectedAfterStateHash: operation.expectedAfterStateHash, matched: true as const
  };
  const record: ControlledRepositoryApplyStepRecord = {
    ...material, stepHash: hashCanonicalJson(material)
  };
  const file = path.join(paths.steps, `${String(index).padStart(6, "0")}.json`);
  try {
    await writeExclusive(file, record);
    const disk = await readCanonical<PlainRecord>(file);
    if (!canonicalEqual(disk, record)) throw new Error("step mismatch");
  } catch { throw new ApplyFailure(
    "controlled_repository_apply_step_record_failed", "A durable step record failed."
  ); }
}

async function rollbackObject(
  bundle: string, entry: ControlledRollbackPayloadEntry, maxEntryBytes: number
): Promise<Buffer> {
  if (entry.payloadObjectHash === null || entry.payloadRelativePath === null ||
      !HASH.test(entry.payloadObjectHash) ||
      entry.payloadRelativePath !== `objects/${entry.payloadObjectHash.slice(7)}`) {
    throw new ApplyFailure(
      "controlled_repository_apply_rollback_object_invalid", "Rollback object binding is invalid."
    );
  }
  const target = path.resolve(bundle, entry.payloadRelativePath);
  if (!inside(bundle, target)) throw new ApplyFailure(
    "controlled_repository_apply_rollback_object_invalid", "Rollback object path is invalid."
  );
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxEntryBytes) {
    throw new ApplyFailure(
      "controlled_repository_apply_rollback_object_invalid", "Rollback object is invalid."
    );
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  if (sha256(bytes) !== entry.payloadObjectHash) throw new ApplyFailure(
    "controlled_repository_apply_rollback_object_invalid", "Rollback object hash is invalid."
  );
  return bytes;
}

async function removeNonDirectory(target: string): Promise<void> {
  try {
    const metadata = await lstat(target);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) throw new ApplyFailure(
      "controlled_repository_apply_rollback_failed", "Rollback target is a directory."
    );
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function restoreEntry(
  repository: string, bundle: string, entry: ControlledRollbackPayloadEntry,
  maxEntryBytes: number
): Promise<void> {
  const target = await validateParent(repository, entry.filePath);
  if (entry.rollbackAction === "remove_path") {
    await removeNonDirectory(target); await syncDirectory(path.dirname(target)); return;
  }
  const bytes = await rollbackObject(bundle, entry, maxEntryBytes);
  await removeNonDirectory(target);
  if (entry.rollbackAction === "restore_symlink") {
    await symlink(bytes, target); await syncDirectory(path.dirname(target)); return;
  }
  const handle = await open(
    target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    entry.baseMode === "100755" ? 0o755 : 0o644
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(target, entry.baseMode === "100755" ? 0o755 : 0o644);
  await syncDirectory(path.dirname(target));
}

async function emergencyRollback(
  repository: string, bundle: string, manifest: ControlledRollbackBundleManifest,
  completed: readonly Operation[], gateInput: ControlledApplyExecutionGateInput,
  timeoutMs: number, maxGitOutputBytes: number, maxEntryBytes: number
): Promise<ControlledRepositoryInspectionResult> {
  const byPath = new Map(manifest.entries.map((entry) => [entry.filePath, entry]));
  const order = sortedUnique([
    ...completed.map((entry) => entry.filePath), ...manifest.entries.map((entry) => entry.filePath)
  ]).reverse();
  for (const filePath of order) {
    const entry = byPath.get(filePath);
    if (!entry) throw new ApplyFailure(
      "controlled_repository_apply_rollback_failed", "Rollback coverage is missing."
    );
    await restoreEntry(repository, bundle, entry, maxEntryBytes);
  }
  return inspectControlledRepository({
    repositoryPath: repository, changedFiles: gateInput.changedFiles,
    expectedTarget: gateInput.handoff.target, timeoutMs, maxGitOutputBytes
  });
}

/** Narrow X.5 compatibility wrapper around the exact X.4 restoration boundary. */
export async function restoreControlledRepositoryFromRollbackBundle(
  input: ControlledRepositoryRollbackRestorationInput
): Promise<ControlledRepositoryRollbackRestorationResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxGitOutputBytes = input.maxGitOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
  const maxEntryBytes = input.maxEntryBytes ?? DEFAULT_ENTRY_BYTES;
  const maxBundleBytes = input.maxBundleBytes ?? DEFAULT_BUNDLE_BYTES;
  if (![timeoutMs, maxGitOutputBytes, maxEntryBytes, maxBundleBytes]
    .every((value) => Number.isSafeInteger(value) && value > 0) ||
      timeoutMs > MAX_TIMEOUT_MS || maxGitOutputBytes > MAX_GIT_OUTPUT_BYTES ||
      maxEntryBytes > MAX_ENTRY_BYTES || maxBundleBytes > MAX_BUNDLE_BYTES) {
    throw new TypeError("controlled_repository_apply_policy_invalid");
  }
  const gateInput = input.gateInput;
  const verification = await verifyControlledRollbackBundle({
    bundleDirectoryPath: gateInput.bundleDirectoryPath,
    expectedManifest: gateInput.rollbackBundleManifest,
    expectedReceipt: gateInput.rollbackBundleReceipt,
    expectedHandoffHash: gateInput.handoff.handoffHash,
    expectedConsumptionKey: gateInput.handoff.singleUse.consumptionKey,
    expectedInspectionHash: gateInput.expectedInspection.inspectionHash,
    maxEntryBytes, maxBundleBytes
  });
  if (verification.decision !== "rollback_bundle_current" || !verification.rollbackUsable) {
    throw new ApplyFailure(
      "controlled_repository_apply_rollback_bundle_invalid",
      "The sealed rollback bundle is not current and usable."
    );
  }
  const repository = await realpath(gateInput.repositoryPath);
  const bundle = await realpath(gateInput.bundleDirectoryPath);
  const rollbackInspection = await emergencyRollback(
    repository, bundle, gateInput.rollbackBundleManifest, [], gateInput,
    timeoutMs, maxGitOutputBytes, maxEntryBytes
  );
  return deepFreeze({
    rollbackBundleVerified: true,
    rollbackInspection,
    baselineRestored: inspectionMatchesExpected(
      rollbackInspection, gateInput.expectedInspection
    )
  });
}

function inspectionMatchesExpected(
  result: ControlledRepositoryInspectionResult,
  expected: ControlledRepositoryInspection
): boolean {
  return result.decision === "repository_inspection_ready" && result.inspection !== null &&
    result.inspection.inspectionHash === expected.inspectionHash &&
    result.inspection.rollbackManifest.manifestHash === expected.rollbackManifest.manifestHash &&
    canonicalEqual(result.inspection.target, expected.target);
}

export async function executeControlledRepositoryApply(
  input: ControlledRepositoryApplyInput
): Promise<ControlledRepositoryApplyResult> {
  const summary = initialSummary();
  const issues: ControlledRepositoryApplyIssue[] = [];
  let authorizationVerification: ControlledApplyExecutionAuthorizationVerificationResult | null = null;
  let postClaimInspection: ControlledRepositoryInspectionResult | null = null;
  let rollbackInspection: ControlledRepositoryInspectionResult | null = null;
  let receipt: ControlledRepositoryApplyReceipt | null = null;
  let paths: RegistryPaths | null = null;
  let reservation: ControlledApplyConsumptionReservation | null = null;
  let transaction: ControlledRepositoryApplyTransactionIntent | null = null;
  let repository = "";
  let bundle = "";
  let maxEntryBytes = DEFAULT_ENTRY_BYTES;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxGitOutputBytes = DEFAULT_GIT_OUTPUT_BYTES;
  let authorization: ControlledApplyExecutionAuthorization | null = null;
  let gateInput: ControlledApplyExecutionGateInput | null = null;
  let operations: Operation[] = [];
  const completed: Operation[] = [];
  const appliedFiles: ControlledRepositoryAppliedFileEntry[] = [];
  let observedChangedFiles: string[] = [];
  let unexpectedChangedFiles: string[] = [];
  try {
    const cloned = safeClone(input);
    const top = exactObject(
      cloned, INPUT_FIELDS, "Controlled repository apply input",
      ["authorization", "gateInput", "registryDirectoryPath"]
    );
    summary.inputValid = true;
    const policy = normalizePolicy(top.policy);
    summary.policyValid = true;
    const policyHash = hashCanonicalJson(policy);
    timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    maxGitOutputBytes = numeric(
      top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    maxEntryBytes = numeric(top, "maxEntryBytes", DEFAULT_ENTRY_BYTES, MAX_ENTRY_BYTES);
    const maxBundleBytes = numeric(
      top, "maxBundleBytes", DEFAULT_BUNDLE_BYTES, MAX_BUNDLE_BYTES
    );
    const maxMutationFileBytes = numeric(
      top, "maxMutationFileBytes", DEFAULT_MUTATION_FILE_BYTES, MAX_MUTATION_FILE_BYTES
    );
    const maxMutationTotalBytes = numeric(
      top, "maxMutationTotalBytes", DEFAULT_MUTATION_TOTAL_BYTES, MAX_MUTATION_TOTAL_BYTES
    );
    authorization = top.authorization as ControlledApplyExecutionAuthorization;
    gateInput = top.gateInput as ControlledApplyExecutionGateInput;
    let pendingBlocked: ApplyFailure | null = gateInput.consumptionStatus !== "not_consumed"
      ? new ApplyFailure(
        "controlled_repository_apply_authorization_stale",
        "External consumption status must be not consumed.", "blocked"
      ) : null;

    authorizationVerification = await verifyControlledApplyExecutionAuthorization({
      authorization, gateInput
    });
    summary.authorizationCurrent = authorizationVerification.decision ===
      "controlled_apply_execution_authorization_current";
    summary.firstWriteEligible = authorizationVerification.firstWriteEligible;
    if (authorizationVerification.decision ===
        "controlled_apply_execution_authorization_invalid") {
      throw new ApplyFailure(
        "controlled_repository_apply_authorization_invalid",
        "The X.3 authorization is invalid."
      );
    }
    if (!summary.authorizationCurrent ||
        authorizationVerification.currentAuthorizationHash !== authorization.authorizationHash) {
      pendingBlocked ??= new ApplyFailure(
        "controlled_repository_apply_authorization_stale",
        "The X.3 authorization is not current.", "blocked"
      );
    }
    if (!summary.firstWriteEligible) pendingBlocked ??= new ApplyFailure(
      "controlled_repository_apply_not_first_write_eligible",
      "The X.3 authorization is not first-write eligible.", "blocked"
    );
    let mutationHash: string;
    let changedFiles: readonly string[];
    try {
      mutationHash = computeGovernedMutationHash(
        authorization.mutation.changeKind, gateInput.mutation
      );
      changedFiles = deriveGovernedMutationChangedFiles(gateInput.mutation);
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_authorization_invalid",
        "The authorized mutation evidence is invalid."
      );
    }
    if (mutationHash !== authorization.mutation.mutationHash ||
        !canonicalEqual(changedFiles, authorization.mutation.changedFiles)) {
      throw new ApplyFailure(
        "controlled_repository_apply_authorization_invalid",
        "Mutation evidence does not match the authorization."
      );
    }
    const bundleVerification = await verifyControlledRollbackBundle({
      bundleDirectoryPath: gateInput.bundleDirectoryPath,
      expectedManifest: gateInput.rollbackBundleManifest,
      expectedReceipt: gateInput.rollbackBundleReceipt,
      expectedHandoffHash: gateInput.handoff.handoffHash,
      expectedConsumptionKey: gateInput.handoff.singleUse.consumptionKey,
      expectedInspectionHash: gateInput.expectedInspection.inspectionHash,
      maxEntryBytes, maxBundleBytes
    });
    if (bundleVerification.decision === "rollback_bundle_invalid") throw new ApplyFailure(
      "controlled_repository_apply_rollback_bundle_invalid",
      "The sealed rollback bundle is invalid."
    );
    if (bundleVerification.decision !== "rollback_bundle_current" ||
        !bundleVerification.rollbackUsable) pendingBlocked ??= new ApplyFailure(
      "controlled_repository_apply_authorization_stale",
      "The sealed rollback bundle is not current and usable.", "blocked"
    );

    repository = await realpath(gateInput.repositoryPath);
    bundle = await realpath(gateInput.bundleDirectoryPath);
    operations = await deriveOperations(
      repository, gateInput.mutation, gateInput.expectedInspection,
      authorization.mutation.changedFiles, maxMutationFileBytes, maxMutationTotalBytes
    );
    const registry = await validateRegistry(
      top.registryDirectoryPath, repository, bundle, timeoutMs, maxGitOutputBytes
    );
    summary.registryPathValid = true;
    if (pendingBlocked !== null) throw pendingBlocked;
    paths = registryPaths(registry, authorization.consumptionKey);
    await ensureClaimsDirectory(paths);
    try {
      await mkdir(paths.claim, { mode: 0o700 });
      await chmod(paths.claim, 0o700);
      summary.consumptionClaimCreated = true;
      summary.consumptionClaimPermanent = true;
      await syncDirectory(paths.claims);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        summary.consumptionClaimPreviouslyExisted = true;
        summary.consumptionClaimPermanent = true;
        throw await existingClaimFailure(paths);
      }
      throw new ApplyFailure(
        "controlled_repository_apply_consumption_claim_creation_failed",
        "The exclusive consumption claim could not be created."
      );
    }

    reservation = buildReservation(authorization, policyHash);
    try {
      await writeExclusive(paths.reservation, reservation);
      summary.reservationWritten = true;
      const disk = await readCanonical<ControlledApplyConsumptionReservation>(paths.reservation);
      summary.reservationVerified = canonicalEqual(disk, reservation) &&
        disk.reservationHash === hashWithout(disk as unknown as PlainRecord, "reservationHash");
      if (!summary.reservationVerified) throw new Error("reservation mismatch");
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_reservation_write_failed",
        "The durable reservation could not be written and verified."
      );
    }

    transaction = buildTransaction(
      reservation, authorization, gateInput.expectedInspection, operations
    );
    try {
      await writeExclusive(paths.transaction, transaction);
      summary.transactionIntentWritten = true;
      const disk = await readCanonical<ControlledRepositoryApplyTransactionIntent>(
        paths.transaction
      );
      summary.transactionIntentVerified = canonicalEqual(disk, transaction) &&
        disk.transactionHash === hashWithout(
          disk as unknown as PlainRecord, "transactionHash"
        );
      if (!summary.transactionIntentVerified) throw new Error("transaction mismatch");
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_transaction_write_failed",
        "The durable transaction intent could not be written and verified."
      );
    }

    postClaimInspection = await inspectControlledRepository({
      repositoryPath: repository, changedFiles: gateInput.changedFiles,
      expectedTarget: authorization.target, timeoutMs, maxGitOutputBytes
    });
    summary.repositoryRecheckedAfterClaim = true;
    summary.repositoryMatchedBeforeWrite = inspectionMatchesExpected(
      postClaimInspection, gateInput.expectedInspection
    );
    if (!summary.repositoryMatchedBeforeWrite) throw new ApplyFailure(
      "controlled_repository_apply_repository_changed_after_claim",
      "Repository changed after the durable claim.", "blocked"
    );
    const maxStateBytes = Math.max(maxEntryBytes, maxMutationFileBytes);
    await verifyAllBaselines(repository, operations, maxStateBytes);
    await mkdir(paths.steps, { mode: 0o700 });
    await chmod(paths.steps, 0o700);
    await syncDirectory(paths.claim);
    await createMarker(paths.writeStarted);
    summary.writeStarted = true;

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      summary.attemptedOperationCount += 1;
      summary.repositoryWritePerformed = true;
      const actual = await applyOperation(repository, operation, maxStateBytes);
      completed.push(operation);
      summary.completedOperationCount += 1;
      await persistStep(paths, index, operation, actual);
      appliedFiles.push({
        filePath: operation.filePath, operation: operation.operation,
        finalState: actual.state as "regular_file" | "symlink" | "absent",
        finalMode: actual.mode, finalContentHash: actual.contentHash,
        finalStateHash: actual.stateHash, gitStatusObserved: false
      });
    }
    const status = await finalStatus(
      repository, timeoutMs, maxGitOutputBytes, authorization.mutation.changedFiles
    );
    const finalInspection = await inspectControlledRepository({
      repositoryPath: repository, changedFiles: gateInput.changedFiles,
      timeoutMs, maxGitOutputBytes
    });
    if (finalInspection.summary.repositoryOperationInProgress) throw new ApplyFailure(
      "controlled_repository_apply_final_scope_mismatch",
      "A Git repository operation is in progress."
    );
    observedChangedFiles = status.observed;
    unexpectedChangedFiles = status.unexpected;
    summary.unexpectedChangedFileCount = unexpectedChangedFiles.length;
    if (unexpectedChangedFiles.length > 0) throw new ApplyFailure(
      "controlled_repository_apply_unexpected_changed_file",
      "An unexpected worktree path changed."
    );
    const observedSet = new Set(observedChangedFiles);
    for (const entry of appliedFiles) entry.gitStatusObserved = observedSet.has(entry.filePath);
    for (const operation of operations) {
      const actual = await actualState(
        path.resolve(repository, operation.filePath), maxStateBytes
      );
      if (actual.stateHash !== operation.expectedAfterStateHash) throw new ApplyFailure(
        "controlled_repository_apply_applied_state_mismatch",
        "Final applied state does not match the mutation."
      );
    }
    summary.appliedStateMatched = true;
    summary.finalScopeMatched = true;
    receipt = buildReceipt(
      "applied", authorization, gateInput, reservation, transaction,
      appliedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath)),
      observedChangedFiles, unexpectedChangedFiles, summary, false
    );
    try {
      await writeExclusive(paths.applyReceipt, receipt);
      summary.applyReceiptWritten = true;
      const disk = await readCanonical<ControlledRepositoryApplyReceipt>(paths.applyReceipt);
      summary.applyReceiptVerified = canonicalEqual(disk, receipt) &&
        disk.receiptHash === hashWithout(disk as unknown as PlainRecord, "receiptHash");
      if (!summary.applyReceiptVerified) throw new Error("receipt mismatch");
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_receipt_write_failed",
        "The final apply receipt could not be committed."
      );
    }
    try {
      await createMarker(path.join(paths.claim, "COMMITTED"));
      summary.terminalRegistryMarker = "COMMITTED";
    } catch {
      throw new ApplyFailure(
        "controlled_repository_apply_terminal_marker_failed",
        "The terminal registry marker could not be committed."
      );
    }
    summary.mutationApplied = true;
    return finish(
      "controlled_repository_apply_succeeded", issues, receipt,
      authorizationVerification, postClaimInspection, rollbackInspection, summary
    );
  } catch (error) {
    if (error instanceof TrustedApplyConfigurationError) throw error;
    const failure = error instanceof ApplyFailure ? error : new ApplyFailure(
      "controlled_repository_apply_exception",
      "Controlled repository apply failed without exposing unbounded details."
    );
    issues.push(issue(failure));
    if (!summary.repositoryWritePerformed || !summary.writeStarted || !paths ||
        !authorization || !gateInput || !reservation || !transaction) {
      return finish(
        decisionForFailure(failure), issues, null, authorizationVerification,
        postClaimInspection, rollbackInspection, summary
      );
    }
    summary.emergencyRollbackExecuted = true;
    try {
      rollbackInspection = await emergencyRollback(
        repository, bundle, gateInput.rollbackBundleManifest, completed, gateInput,
        timeoutMs, maxGitOutputBytes, maxEntryBytes
      );
      const restored = inspectionMatchesExpected(rollbackInspection, gateInput.expectedInspection);
      if (!restored) throw new ApplyFailure(
        "controlled_repository_apply_rollback_verification_failed",
        "Emergency rollback could not be proven complete."
      );
      summary.emergencyRollbackSucceeded = true;
      receipt = buildReceipt(
        "rolled_back", authorization, gateInput, reservation, transaction,
        [], [], [], summary, true
      );
      await writeExclusive(paths.rollbackReceipt, receipt);
      const disk = await readCanonical<ControlledRepositoryApplyReceipt>(paths.rollbackReceipt);
      if (!canonicalEqual(disk, receipt) ||
          disk.receiptHash !== hashWithout(disk as unknown as PlainRecord, "receiptHash")) {
        throw new ApplyFailure(
          "controlled_repository_apply_receipt_hash_mismatch",
          "Rollback receipt integrity failed."
        );
      }
      await createMarker(path.join(paths.claim, "ROLLED_BACK"));
      summary.terminalRegistryMarker = "ROLLED_BACK";
      return finish(
        "controlled_repository_apply_rolled_back", issues, receipt,
        authorizationVerification, postClaimInspection, rollbackInspection, summary
      );
    } catch {
      summary.emergencyRollbackSucceeded = false;
      issues.push(issue(new ApplyFailure(
        "controlled_repository_apply_rollback_failed",
        "Emergency rollback could not restore the verified baseline."
      )));
      try {
        receipt = buildReceipt(
          "rollback_failed", authorization, gateInput, reservation, transaction,
          [], observedChangedFiles, unexpectedChangedFiles, summary, false
        );
        if (paths) {
          try { await writeExclusive(paths.rollbackReceipt, receipt); } catch { /* evidence best effort */ }
          await createMarker(path.join(paths.claim, "ROLLBACK_FAILED"));
          summary.terminalRegistryMarker = "ROLLBACK_FAILED";
        }
      } catch { /* preserve strongest bounded in-memory evidence */ }
      return finish(
        "controlled_repository_apply_rollback_failed", issues, receipt,
        authorizationVerification, postClaimInspection, rollbackInspection, summary
      );
    }
  }
}

function finishVerification(
  decision: ControlledRepositoryApplyReceiptVerificationDecision,
  receiptIntegrityVerified: boolean, registryRecordVerified: boolean,
  terminalMarker: ControlledRepositoryApplyReceiptVerificationResult["terminalMarker"],
  repositoryStateMatched: boolean, staleFields: string[], reasonCodes: string[],
  summary: VerificationSummary
): ControlledRepositoryApplyReceiptVerificationResult {
  return deepFreeze({
    decision, receiptIntegrityVerified, registryRecordVerified, terminalMarker,
    repositoryStateMatched, staleFields: sortedUnique(staleFields),
    reasonCodes: sortedUnique(reasonCodes), summary
  });
}

function validateReceipt(value: unknown): ControlledRepositoryApplyReceipt {
  const receipt = exactObject(value, [
    "receiptVersion", "outcome", "authorizationHash", "governedArtifactHash",
    "handoffHash", "consumptionKey", "reservationHash", "transactionHash",
    "mutation", "before", "after", "execution", "receiptHash"
  ], "Apply receipt");
  const mutation = exactObject(receipt.mutation, [
    "changeKind", "mutationHash", "changedFiles", "changedFileCount"
  ], "Apply receipt mutation");
  const before = exactObject(receipt.before, [
    "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash",
    "expectedInspectionHash", "rollbackManifestHash", "rollbackBundleManifestHash",
    "rollbackBundleReceiptHash", "rollbackPayloadRootHash"
  ], "Apply receipt before state");
  const after = exactObject(receipt.after, [
    "appliedStateHash", "finalScopeHash", "appliedFiles", "observedChangedFiles",
    "unexpectedChangedFiles"
  ], "Apply receipt after state");
  const execution = exactObject(receipt.execution, [
    "writeStarted", "attemptedOperationCount", "completedOperationCount",
    "mutationApplyAttempted", "mutationApplied", "emergencyRollbackExecuted",
    "emergencyRollbackSucceeded", "finalRepositoryMatchesBeforeState",
    "gitIndexMutated", "gitHistoryMutated", "shellExecuted"
  ], "Apply receipt execution");
  if (receipt.receiptVersion !== "1" ||
      !["applied", "rolled_back", "rollback_failed"].includes(receipt.outcome as string) ||
      !Array.isArray(mutation.changedFiles) || !Array.isArray(after.appliedFiles) ||
      !Array.isArray(after.observedChangedFiles) || !Array.isArray(after.unexpectedChangedFiles) ||
      execution.gitIndexMutated !== false || execution.gitHistoryMutated !== false ||
      execution.shellExecuted !== false) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Apply receipt structure is invalid."
  );
  for (const entryValue of after.appliedFiles) {
    const entry = exactObject(entryValue, [
      "filePath", "operation", "finalState", "finalMode", "finalContentHash",
      "finalStateHash", "gitStatusObserved"
    ], "Applied file entry");
    if (typeof entry.filePath !== "string" ||
        !["create", "update", "delete"].includes(entry.operation as string) ||
        !["regular_file", "symlink", "absent"].includes(entry.finalState as string) ||
        !["100644", "100755", "120000", null].includes(entry.finalMode as never) ||
        (entry.finalContentHash !== null && !HASH.test(entry.finalContentHash as string)) ||
        !HASH.test(entry.finalStateHash as string) ||
        typeof entry.gitStatusObserved !== "boolean") throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid",
      "Applied file entry is invalid."
    );
  }
  for (const field of [
    "authorizationHash", "governedArtifactHash", "handoffHash", "consumptionKey",
    "reservationHash", "transactionHash", "receiptHash"
  ]) if (!HASH.test(receipt[field] as string)) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Apply receipt hash is invalid."
  );
  for (const field of Object.keys(before)) if (!HASH.test(before[field] as string)) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Before-state hash is invalid."
    );
  }
  if (!HASH.test(mutation.mutationHash as string) ||
      receipt.receiptHash !== hashWithout(receipt, "receiptHash")) throw new ApplyFailure(
    "controlled_repository_apply_receipt_hash_mismatch", "Apply receipt hash is invalid."
  );
  const changedFiles = mutation.changedFiles as string[];
  const appliedFiles = after.appliedFiles as unknown as ControlledRepositoryAppliedFileEntry[];
  const observed = after.observedChangedFiles as string[];
  const unexpected = after.unexpectedChangedFiles as string[];
  if (!changedFiles.every((file) => typeof file === "string") ||
      !observed.every((file) => typeof file === "string") ||
      !unexpected.every((file) => typeof file === "string") ||
      !canonicalEqual(changedFiles, sortedUnique(changedFiles)) ||
      !canonicalEqual(observed, sortedUnique(observed)) ||
      !canonicalEqual(unexpected, sortedUnique(unexpected)) ||
      !canonicalEqual(appliedFiles.map((entry) => entry.filePath),
        sortedUnique(appliedFiles.map((entry) => entry.filePath))) ||
      mutation.changedFileCount !== changedFiles.length ||
      !Number.isSafeInteger(execution.attemptedOperationCount) ||
      !Number.isSafeInteger(execution.completedOperationCount)) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Receipt arrays are invalid."
  );
  if (receipt.outcome === "applied") {
    const appliedHash = hashCanonicalJson({
      artifactType: "controlled_repository_applied_state", entries: appliedFiles
    });
    const scopeHash = hashCanonicalJson({
      artifactType: "controlled_repository_apply_scope",
      authorizedChangedFiles: changedFiles,
      observedChangedFiles: observed,
      unexpectedChangedFiles: unexpected
    });
    if (after.appliedStateHash !== appliedHash || after.finalScopeHash !== scopeHash ||
        unexpected.length !== 0 || execution.mutationApplied !== true ||
        execution.emergencyRollbackExecuted !== false ||
        execution.emergencyRollbackSucceeded !== null) throw new ApplyFailure(
      "controlled_repository_apply_receipt_hash_mismatch",
      "Applied receipt state evidence is inconsistent."
    );
  } else if (after.appliedStateHash !== null || after.finalScopeHash !== null ||
      execution.emergencyRollbackExecuted !== true ||
      execution.emergencyRollbackSucceeded !== (receipt.outcome === "rolled_back") ||
      execution.mutationApplied !== false) throw new ApplyFailure(
    "controlled_repository_apply_receipt_hash_mismatch",
    "Rollback receipt state evidence is inconsistent."
  );
  return receipt as unknown as ControlledRepositoryApplyReceipt;
}

async function terminalState(paths: RegistryPaths): Promise<
  "COMMITTED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "INCOMPLETE"
> {
  const found: string[] = [];
  for (const marker of TERMINAL_MARKERS) {
    try {
      const metadata = await lstat(path.join(paths.claim, marker));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 0) {
        throw new ApplyFailure(
          "controlled_repository_apply_registry_record_invalid",
          "Terminal registry marker is invalid."
        );
      }
      found.push(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (found.length > 1) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid",
    "Multiple terminal registry markers are invalid."
  );
  return (found[0] as typeof TERMINAL_MARKERS[number] | undefined) ?? "INCOMPLETE";
}

async function validateClaimLayout(paths: RegistryPaths): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const claimMetadata = await lstat(paths.claim);
  if (!claimMetadata.isDirectory() || claimMetadata.isSymbolicLink() ||
      (claimMetadata.mode & 0o777) !== 0o700) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Claim directory is invalid."
  );
  const allowed = new Set([
    "reservation.json", "transaction.json", "WRITE_STARTED", "steps",
    "apply-receipt.json", "rollback-receipt.json", ...TERMINAL_MARKERS
  ]);
  for (const name of await readdir(paths.claim)) {
    if (!allowed.has(name)) throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid",
      "Claim contains an unexpected registry entry."
    );
    const metadata = await lstat(path.join(paths.claim, name));
    if (metadata.isSymbolicLink()) throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid",
      "Claim contains a symbolic link."
    );
    if (name === "steps") {
      if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) throw new ApplyFailure(
        "controlled_repository_apply_registry_record_invalid", "Steps entry is invalid."
      );
      for (const step of await readdir(paths.steps)) {
        if (!/^\d{6}\.json$/.test(step)) throw new ApplyFailure(
          "controlled_repository_apply_registry_record_invalid",
          "Steps contain an unexpected registry entry."
        );
        const stepMetadata = await lstat(path.join(paths.steps, step));
        if (!stepMetadata.isFile() || stepMetadata.isSymbolicLink() ||
            (stepMetadata.mode & 0o777) !== 0o600) throw new ApplyFailure(
          "controlled_repository_apply_registry_record_invalid", "Step record is invalid."
        );
      }
    } else if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Claim record is invalid."
    );
  }
}

async function verifyStepRecords(
  paths: RegistryPaths, transaction: ControlledRepositoryApplyTransactionIntent,
  receipt: ControlledRepositoryApplyReceipt
): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try { names = (await readdir(paths.steps)).sort(); } catch { return false; }
  if (names.length !== receipt.execution.completedOperationCount) return false;
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== `${String(index).padStart(6, "0")}.json`) return false;
    const record = exactObject(
      await readCanonical(path.join(paths.steps, names[index])),
      ["stepVersion", "index", "filePath", "operation", "actualAfterStateHash",
        "expectedAfterStateHash", "matched", "stepHash"],
      "Apply step record"
    );
    if (record.stepVersion !== "1" || record.index !== index || record.matched !== true ||
        record.stepHash !== hashWithout(record, "stepHash") ||
        record.filePath !== transaction.expectedOperations[index]?.filePath ||
        record.operation !== transaction.expectedOperations[index]?.operation ||
        record.expectedAfterStateHash !==
          transaction.expectedOperations[index]?.expectedAfterStateHash ||
        record.actualAfterStateHash !== record.expectedAfterStateHash) return false;
  }
  return true;
}

function validateReservationRecord(value: unknown): ControlledApplyConsumptionReservation {
  const record = exactObject(value, [
    "registryVersion", "consumptionKey", "authorizationHash", "handoffHash",
    "governedArtifactHash", "mutationHash", "changedFiles", "repositoryIdentityHash",
    "baseRevisionHash", "worktreeStateHash", "rollbackBundleManifestHash",
    "rollbackBundleReceiptHash", "policyHash", "reservationHash"
  ], "Consumption reservation");
  if (record.registryVersion !== "1" || !Array.isArray(record.changedFiles) ||
      !(record.changedFiles as unknown[]).every((file) => typeof file === "string") ||
      !canonicalEqual(record.changedFiles, sortedUnique(record.changedFiles as string[]))) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Reservation structure is invalid."
    );
  }
  for (const field of Object.keys(record).filter((field) => field !== "changedFiles" &&
      field !== "registryVersion")) if (!HASH.test(record[field] as string)) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Reservation hash is invalid."
    );
  }
  if (record.reservationHash !== hashWithout(record, "reservationHash")) throw new ApplyFailure(
    "controlled_repository_apply_reservation_hash_mismatch", "Reservation hash mismatched."
  );
  return record as unknown as ControlledApplyConsumptionReservation;
}

function validateTransactionRecord(value: unknown): ControlledRepositoryApplyTransactionIntent {
  const record = exactObject(value, [
    "transactionVersion", "reservationHash", "authorizationHash", "consumptionKey",
    "mutationHash", "changedFiles", "expectedInspectionHash", "rollbackManifestHash",
    "expectedOperations", "transactionHash"
  ], "Apply transaction");
  if (record.transactionVersion !== "1" || !Array.isArray(record.changedFiles) ||
      !(record.changedFiles as unknown[]).every((file) => typeof file === "string") ||
      !Array.isArray(record.expectedOperations) ||
      !canonicalEqual(record.changedFiles, sortedUnique(record.changedFiles as string[]))) {
    throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Transaction structure is invalid."
    );
  }
  for (const operation of record.expectedOperations) {
    const item = exactObject(operation, [
      "filePath", "operation", "expectedBeforeStateHash", "expectedAfterStateHash"
    ], "Expected operation");
    if (typeof item.filePath !== "string" ||
        !["create", "update", "delete"].includes(item.operation as string) ||
        !HASH.test(item.expectedBeforeStateHash as string) ||
        !HASH.test(item.expectedAfterStateHash as string)) throw new ApplyFailure(
      "controlled_repository_apply_registry_record_invalid", "Expected operation is invalid."
    );
  }
  for (const field of [
    "reservationHash", "authorizationHash", "consumptionKey", "mutationHash",
    "expectedInspectionHash", "rollbackManifestHash", "transactionHash"
  ]) if (!HASH.test(record[field] as string)) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Transaction hash is invalid."
  );
  if (record.transactionHash !== hashWithout(record, "transactionHash")) throw new ApplyFailure(
    "controlled_repository_apply_transaction_hash_mismatch", "Transaction hash mismatched."
  );
  return record as unknown as ControlledRepositoryApplyTransactionIntent;
}

/** Bounded read-only registry validators reused by transaction recovery. */
export function verifyControlledApplyConsumptionReservationRecord(
  value: unknown
): ControlledApplyConsumptionReservation {
  return deepFreeze(validateReservationRecord(value));
}

export function verifyControlledRepositoryApplyTransactionRecord(
  value: unknown
): ControlledRepositoryApplyTransactionIntent {
  return deepFreeze(validateTransactionRecord(value));
}

export function verifyControlledRepositoryApplyReceiptRecord(
  value: unknown
): ControlledRepositoryApplyReceipt {
  return deepFreeze(validateReceipt(value));
}

export function verifyControlledRepositoryApplyStepRecord(
  value: unknown
): ControlledRepositoryApplyStepRecord {
  const record = exactObject(value, [
    "stepVersion", "index", "filePath", "operation", "actualAfterStateHash",
    "expectedAfterStateHash", "matched", "stepHash"
  ], "Apply step record");
  if (record.stepVersion !== "1" || !Number.isSafeInteger(record.index) ||
      (record.index as number) < 0 || typeof record.filePath !== "string" ||
      !["create", "update", "delete"].includes(record.operation as string) ||
      record.matched !== true || !HASH.test(record.actualAfterStateHash as string) ||
      !HASH.test(record.expectedAfterStateHash as string) ||
      !HASH.test(record.stepHash as string) ||
      record.actualAfterStateHash !== record.expectedAfterStateHash ||
      record.stepHash !== hashWithout(record, "stepHash")) throw new ApplyFailure(
    "controlled_repository_apply_registry_record_invalid", "Apply step record is invalid."
  );
  return deepFreeze(record as unknown as ControlledRepositoryApplyStepRecord);
}

export async function verifyControlledRepositoryApplyReceipt(
  input: ControlledRepositoryApplyReceiptVerificationInput
): Promise<ControlledRepositoryApplyReceiptVerificationResult> {
  const summary = initialVerificationSummary();
  try {
    const cloned = safeClone(input);
    const top = exactObject(
      cloned, VERIFY_INPUT_FIELDS, "Apply receipt verification input",
      ["repositoryPath", "registryDirectoryPath", "receipt", "authorization",
        "expectedInspection"]
    );
    const timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxGitOutputBytes = numeric(
      top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    const receipt = validateReceipt(top.receipt);
    const authorization = top.authorization as ControlledApplyExecutionAuthorization;
    const expectedInspection = top.expectedInspection as ControlledRepositoryInspection;
    const expectedMaterial = { ...expectedInspection } as PlainRecord;
    delete expectedMaterial.inspectionHash;
    const rollbackMaterial = { ...expectedInspection.rollbackManifest } as PlainRecord;
    delete rollbackMaterial.manifestHash;
    if (expectedInspection.inspectionHash !== hashCanonicalJson(expectedMaterial) ||
        expectedInspection.rollbackManifest.manifestHash !== hashCanonicalJson(rollbackMaterial)) {
      throw new ApplyFailure(
        "controlled_repository_apply_registry_record_invalid",
        "Expected repository inspection integrity is invalid."
      );
    }
    const stale: string[] = [];
    const compare = (field: string, left: unknown, right: unknown) => {
      if (!canonicalEqual(left, right)) stale.push(field);
    };
    compare("authorizationHash", receipt.authorizationHash, authorization.authorizationHash);
    compare("governedArtifactHash", receipt.governedArtifactHash,
      authorization.governedArtifactHash);
    compare("handoffHash", receipt.handoffHash, authorization.handoffHash);
    compare("consumptionKey", receipt.consumptionKey, authorization.consumptionKey);
    compare("mutationHash", receipt.mutation.mutationHash,
      authorization.mutation.mutationHash);
    compare("changedFiles", receipt.mutation.changedFiles,
      authorization.mutation.changedFiles);
    compare("repositoryIdentityHash", receipt.before.repositoryIdentityHash,
      authorization.target.repositoryIdentityHash);
    compare("baseRevisionHash", receipt.before.baseRevisionHash,
      authorization.target.baseRevisionHash);
    compare("worktreeStateHash", receipt.before.worktreeStateHash,
      authorization.target.worktreeStateHash);
    compare("expectedInspectionHash", receipt.before.expectedInspectionHash,
      expectedInspection.inspectionHash);
    compare("rollbackManifestHash", receipt.before.rollbackManifestHash,
      expectedInspection.rollbackManifest.manifestHash);
    compare("rollbackBundleManifestHash", receipt.before.rollbackBundleManifestHash,
      authorization.evidence.rollbackBundleManifestHash);
    compare("rollbackBundleReceiptHash", receipt.before.rollbackBundleReceiptHash,
      authorization.evidence.rollbackBundleReceiptHash);
    compare("rollbackPayloadRootHash", receipt.before.rollbackPayloadRootHash,
      authorization.evidence.rollbackPayloadRootHash);
    summary.authorizationMatched = !stale.some((field) => [
      "authorizationHash", "governedArtifactHash", "handoffHash", "mutationHash",
      "changedFiles", "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash",
      "rollbackBundleManifestHash", "rollbackBundleReceiptHash", "rollbackPayloadRootHash"
    ].includes(field));
    summary.consumptionKeyMatched = !stale.includes("consumptionKey");

    const repository = await realpath(top.repositoryPath as string);
    const registry = await validateRegistryForVerifier(
      top.registryDirectoryPath, repository, timeoutMs, maxGitOutputBytes
    );
    const paths = registryPaths(registry, receipt.consumptionKey);
    await validateClaimLayout(paths);
    const terminal = await terminalState(paths);
    if (terminal === "INCOMPLETE") {
      summary.recoveryRequired = true;
      return finishVerification(
        "controlled_repository_apply_receipt_requires_recovery", true, false,
        terminal, false, sortedUnique([...stale, "terminalMarker"]),
        ["controlled_repository_apply_recovery_required"], summary
      );
    }
    const reservation = validateReservationRecord(await readCanonical(paths.reservation));
    const transaction = validateTransactionRecord(await readCanonical(paths.transaction));
    summary.reservationMatched = reservation.reservationHash ===
      hashWithout(reservation as unknown as PlainRecord, "reservationHash") &&
      reservation.reservationHash === receipt.reservationHash &&
      reservation.authorizationHash === receipt.authorizationHash &&
      reservation.consumptionKey === receipt.consumptionKey;
    summary.transactionMatched = transaction.transactionHash ===
      hashWithout(transaction as unknown as PlainRecord, "transactionHash") &&
      transaction.transactionHash === receipt.transactionHash &&
      transaction.reservationHash === receipt.reservationHash &&
      transaction.authorizationHash === receipt.authorizationHash;
    if (!summary.reservationMatched) stale.push("reservationHash");
    if (!summary.transactionMatched) stale.push("transactionHash");
    if (terminal === "ROLLBACK_FAILED") {
      summary.recoveryRequired = true;
      return finishVerification(
        "controlled_repository_apply_receipt_requires_recovery", true, false,
        terminal, false, sortedUnique([...stale, "terminalMarker"]),
        ["controlled_repository_apply_recovery_required"], summary
      );
    }
    const receiptFile = receipt.outcome === "applied" ? paths.applyReceipt : paths.rollbackReceipt;
    const diskReceipt = await readCanonical<ControlledRepositoryApplyReceipt>(receiptFile);
    summary.receiptFileMatched = canonicalEqual(diskReceipt, receipt);
    summary.stepRecordsMatched = await verifyStepRecords(paths, transaction, receipt);
    const expectedTerminal = receipt.outcome === "applied" ? "COMMITTED" : "ROLLED_BACK";
    if (terminal !== expectedTerminal) stale.push("terminalMarker");
    if (!summary.receiptFileMatched) stale.push("receiptHash");
    if (!summary.stepRecordsMatched) stale.push("transactionHash");
    let repositoryMatched = false;
    if (receipt.outcome === "applied") {
      const status = await finalStatus(
        repository, timeoutMs, maxGitOutputBytes, receipt.mutation.changedFiles
      );
      let statesMatch = status.unexpected.length === 0;
      const inspection = await inspectControlledRepository({
        repositoryPath: repository, changedFiles: receipt.mutation.changedFiles,
        timeoutMs, maxGitOutputBytes
      });
      if (inspection.summary.repositoryOperationInProgress) statesMatch = false;
      for (const entry of receipt.after.appliedFiles) {
        const current = await actualState(path.resolve(repository, entry.filePath), MAX_ENTRY_BYTES);
        if (current.stateHash !== entry.finalStateHash) statesMatch = false;
      }
      summary.successfulApplyStateMatched = statesMatch;
      repositoryMatched = statesMatch;
      if (!statesMatch) stale.push("appliedStateHash");
    } else {
      const inspection = await inspectControlledRepository({
        repositoryPath: repository,
        changedFiles: expectedInspection.rollbackManifest.changedFiles,
        expectedTarget: expectedInspection.target, timeoutMs, maxGitOutputBytes
      });
      summary.restoredBaselineMatched = inspectionMatchesExpected(inspection, expectedInspection);
      repositoryMatched = summary.restoredBaselineMatched;
      if (!repositoryMatched) stale.push("worktreeStateHash");
    }
    const registryVerified = summary.reservationMatched && summary.transactionMatched &&
      summary.stepRecordsMatched && summary.receiptFileMatched && terminal === expectedTerminal;
    if (stale.length > 0 || !repositoryMatched || !registryVerified) return finishVerification(
      "controlled_repository_apply_receipt_stale", true, registryVerified,
      terminal, repositoryMatched, stale,
      ["controlled_repository_apply_receipt_stale"], summary
    );
    return finishVerification(
      "controlled_repository_apply_receipt_current", true, true,
      terminal, true, [], [], summary
    );
  } catch (error) {
    const code = error instanceof ApplyFailure ? error.code :
      "invalid_controlled_repository_apply_input";
    return finishVerification(
      "controlled_repository_apply_receipt_invalid", false, false,
      null, false, [], [code], summary
    );
  }
}
