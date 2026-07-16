/**
 * Phase X.6 handles incomplete or failed X.4/X.5 transactions for one exact
 * consumption key. Original claims and validation records are immutable and
 * consumption keys are never released. An incomplete apply is never accepted
 * as successful and an incomplete validation is never accepted as passed.
 * Rollback uses only the sealed X.2 bundle; unrelated concurrent changes stop
 * automatic rollback. Recovery evidence is written in a separate namespace.
 * This boundary never mutates the Git index or history and never invokes a
 * shell. A recovery-failed state requires human intervention. X.6 closes local
 * transaction recovery; it is not deployment recovery.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, realpath, rm
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  computeGovernedMutationHash,
  deriveGovernedMutationChangedFiles
} from "./controlled-apply-handoff.js";
import type {
  ControlledApplyExecutionAuthorization,
  ControlledApplyExecutionGateInput
} from "./controlled-apply-execution-gate.js";
import {
  computeControlledApplyConsumptionReservationHash,
  computeControlledRepositoryApplyReceiptHash,
  computeControlledRepositoryApplyTransactionHash,
  inspectControlledRepositoryFileState,
  restoreControlledRepositoryFromRollbackBundle,
  verifyControlledApplyConsumptionReservationRecord,
  verifyControlledRepositoryApplyReceiptRecord,
  verifyControlledRepositoryApplyStepRecord,
  verifyControlledRepositoryApplyTransactionRecord,
  type ControlledApplyConsumptionReservation,
  type ControlledRepositoryApplyReceipt,
  type ControlledRepositoryApplyStepRecord,
  type ControlledRepositoryApplyTransactionIntent
} from "./controlled-repository-apply.js";
import {
  computeControlledPostApplyFinalReceiptHash,
  computeControlledPostApplyValidationIntentHash,
  computeControlledPostApplyValidationRecordHash,
  verifyControlledPostApplyFinalReceiptRecord,
  verifyControlledPostApplyValidationIntentRecord,
  verifyControlledPostApplyValidationResultRecord,
  type ControlledPostApplyFinalReceipt,
  type ControlledPostApplyValidationIntent,
  type ControlledPostApplyValidationRecord
} from "./controlled-post-apply-validation.js";
import {
  inspectControlledRepository,
  type ControlledRepositoryInspection,
  type ControlledRepositoryInspectionResult
} from "./controlled-repository-inspection.js";
import { verifyControlledRollbackBundle } from "./controlled-rollback-bundle.js";

export const CONTROLLED_TRANSACTION_RECOVERY_VERSION = "1" as const;

export type ControlledX4RecoveryState =
  | "x4_claim_missing"
  | "x4_claim_created_prewrite_incomplete"
  | "x4_write_started_incomplete"
  | "x4_committed"
  | "x4_rolled_back"
  | "x4_rollback_failed"
  | "x4_registry_invalid";

export type ControlledX5RecoveryState =
  | "x5_transaction_missing"
  | "x5_intent_created_prevalidation_incomplete"
  | "x5_validation_started_incomplete"
  | "x5_finalized"
  | "x5_validation_rolled_back"
  | "x5_validation_rollback_failed"
  | "x5_registry_invalid";

export type ControlledTransactionRecoveryAction =
  | "no_action_required"
  | "run_post_apply_validation"
  | "close_prewrite_claim_without_repository_write"
  | "restore_x1_baseline"
  | "human_recovery_required";

export type ControlledTransactionRecoveryInspectionDecision =
  | "controlled_transaction_recovery_inspection_ready"
  | "controlled_transaction_recovery_inspection_blocked"
  | "controlled_transaction_recovery_inspection_invalid"
  | "controlled_transaction_recovery_inspection_needs_review";

export type ControlledTransactionRecoveryDecision =
  | "controlled_transaction_recovery_not_required"
  | "controlled_transaction_recovery_awaiting_validation"
  | "controlled_transaction_recovery_closed_prewrite"
  | "controlled_transaction_recovery_rolled_back"
  | "controlled_transaction_recovery_blocked"
  | "controlled_transaction_recovery_invalid"
  | "controlled_transaction_recovery_needs_review"
  | "controlled_transaction_recovery_failed";

export type ControlledTransactionRecoveryPolicy = {
  policyVersion: "1";
  requirePermanentConsumptionClaim: true;
  neverReleaseConsumptionClaim: true;
  requireExactAuthorizationBinding: true;
  requireExactRegistryBinding: true;
  requireVerifiedRollbackBundle: true;
  requireExactX1BaselineAfterRecovery: true;
  preferRollbackOverIncompleteAppliedState: true;
  forbidAutomaticRollbackWithUnexpectedChanges: true;
  forbidAutomaticRollbackAfterHeadChange: true;
  forbidAutomaticRollbackWithIndexChanges: true;
  forbidAutomaticRollbackDuringGitOperation: true;
  preserveOriginalX4Registry: true;
  preserveOriginalX5Registry: true;
  writeRecoveryIntentBeforeRepositoryWrite: true;
  writeRecoveryReceiptAfterRecovery: true;
  cleanupKnownValidationWorkspaceWhenSafe: true;
  forbidGitIndexMutation: true;
  forbidGitHistoryMutation: true;
  forbidShellExecution: true;
};

const STRICT_POLICY: ControlledTransactionRecoveryPolicy = {
  policyVersion: "1",
  requirePermanentConsumptionClaim: true,
  neverReleaseConsumptionClaim: true,
  requireExactAuthorizationBinding: true,
  requireExactRegistryBinding: true,
  requireVerifiedRollbackBundle: true,
  requireExactX1BaselineAfterRecovery: true,
  preferRollbackOverIncompleteAppliedState: true,
  forbidAutomaticRollbackWithUnexpectedChanges: true,
  forbidAutomaticRollbackAfterHeadChange: true,
  forbidAutomaticRollbackWithIndexChanges: true,
  forbidAutomaticRollbackDuringGitOperation: true,
  preserveOriginalX4Registry: true,
  preserveOriginalX5Registry: true,
  writeRecoveryIntentBeforeRepositoryWrite: true,
  writeRecoveryReceiptAfterRecovery: true,
  cleanupKnownValidationWorkspaceWhenSafe: true,
  forbidGitIndexMutation: true,
  forbidGitHistoryMutation: true,
  forbidShellExecution: true
};

export type ControlledTransactionRecoveryInput = {
  repositoryPath: string;
  bundleDirectoryPath: string;
  registryDirectoryPath: string;
  validationWorkspaceParentPath?: string;
  authorization: ControlledApplyExecutionAuthorization;
  gateInput: ControlledApplyExecutionGateInput;
  consumptionKey: string;
  policy?: ControlledTransactionRecoveryPolicy;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
  maxRegistryFileBytes?: number;
  maxRegistryEntryCount?: number;
};

export type ControlledTransactionRecoveryIssueSeverity = "review" | "error";
export type ControlledTransactionRecoveryIssue = {
  code: string;
  message: string;
  severity: ControlledTransactionRecoveryIssueSeverity;
  field?: string;
  filePath?: string;
  hashValue?: string;
};

export type ControlledTransactionRecoveryPlan = {
  recoveryVersion: "1";
  consumptionKey: string;
  authorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutationHash: string;
  changedFiles: readonly string[];
  observedState: { x4State: ControlledX4RecoveryState; x5State: ControlledX5RecoveryState };
  action: ControlledTransactionRecoveryAction;
  baseline: {
    expectedInspectionHash: string;
    rollbackManifestHash: string;
    repositoryIdentityHash: string;
    baseRevisionHash: string;
    worktreeStateHash: string;
  };
  rollbackBundle: {
    bundleManifestHash: string;
    bundleReceiptHash: string;
    payloadRootHash: string;
  };
  safety: {
    headMatched: boolean;
    indexClean: boolean;
    noGitOperationInProgress: boolean;
    authorizedScopeOnly: boolean;
    repositoryMatchesX1Baseline: boolean;
    repositoryMatchesX4AppliedState: boolean;
    rollbackBundleUsable: boolean;
  };
  reasonCodes: readonly string[];
  policyHash: string;
  planHash: string;
};

export type ControlledTransactionRecoveryInspectionResult = {
  decision: ControlledTransactionRecoveryInspectionDecision;
  issues: readonly ControlledTransactionRecoveryIssue[];
  plan: ControlledTransactionRecoveryPlan | null;
  summary: {
    inputValid: boolean;
    policyValid: boolean;
    authorizationValid: boolean;
    consumptionKeyMatched: boolean;
    x4State: ControlledX4RecoveryState;
    x5State: ControlledX5RecoveryState;
    x4RegistryValid: boolean;
    x5RegistryValid: boolean;
    rollbackBundleVerified: boolean;
    repositoryHeadMatched: boolean;
    repositoryIndexClean: boolean;
    repositoryOperationInProgress: boolean;
    authorizedScopeOnly: boolean;
    unexpectedChangedFileCount: number;
    repositoryMatchesX1Baseline: boolean;
    repositoryMatchesX4AppliedState: boolean;
    recoveryAction: ControlledTransactionRecoveryAction | null;
    repositoryWriteRequired: boolean;
    humanRecoveryRequired: boolean;
    registryWritePerformed: false;
    repositoryWritePerformed: false;
    gitMutationPerformed: false;
    shellExecuted: false;
  };
};

export type ControlledTransactionRecoveryIntent = {
  intentVersion: "1";
  attemptIndex: number;
  consumptionKey: string;
  authorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutationHash: string;
  changedFiles: readonly string[];
  x4State: ControlledX4RecoveryState;
  x5State: ControlledX5RecoveryState;
  action: "close_prewrite_claim_without_repository_write" | "restore_x1_baseline";
  expectedInspectionHash: string;
  rollbackManifestHash: string;
  rollbackBundleManifestHash: string;
  rollbackBundleReceiptHash: string;
  rollbackPayloadRootHash: string;
  policyHash: string;
  recoveryPlanHash: string;
  intentHash: string;
};

export type ControlledTransactionRecoveryReceipt = {
  receiptVersion: "1";
  attemptIndex: number;
  outcome: "abandoned_before_repository_write" | "restored_x1_baseline" | "recovery_failed";
  consumptionKey: string;
  authorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutation: { mutationHash: string; changedFiles: readonly string[]; changedFileCount: number };
  observedState: { x4State: ControlledX4RecoveryState; x5State: ControlledX5RecoveryState };
  recovery: {
    action: "close_prewrite_claim_without_repository_write" | "restore_x1_baseline";
    repositoryWriteAttempted: boolean;
    repositoryWriteSucceeded: boolean | null;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean | null;
    repositoryMatchesX1Baseline: boolean;
    validationWorkspaceCleanupAttempted: boolean;
    validationWorkspaceCleanupSucceeded: boolean | null;
  };
  evidence: {
    recoveryPlanHash: string;
    recoveryIntentHash: string;
    expectedInspectionHash: string;
    finalInspectionHash: string | null;
    rollbackManifestHash: string;
    rollbackBundleManifestHash: string;
    rollbackBundleReceiptHash: string;
    rollbackPayloadRootHash: string;
  };
  safety: {
    consumptionClaimReleased: false;
    originalX4RegistryModified: false;
    originalX5RegistryModified: false;
    gitIndexMutated: false;
    gitHistoryMutated: false;
    shellExecuted: false;
    commitCreated: false;
    pushExecuted: false;
  };
  receiptHash: string;
};

export type ControlledTransactionRecoveryResult = {
  decision: ControlledTransactionRecoveryDecision;
  issues: readonly ControlledTransactionRecoveryIssue[];
  inspection: ControlledTransactionRecoveryInspectionResult | null;
  receipt: ControlledTransactionRecoveryReceipt | null;
  finalRepositoryInspection: ControlledRepositoryInspectionResult | null;
  summary: {
    inputValid: boolean;
    policyValid: boolean;
    inspectionCompleted: boolean;
    x4State: ControlledX4RecoveryState | null;
    x5State: ControlledX5RecoveryState | null;
    recoveryAction: ControlledTransactionRecoveryAction | null;
    recoveryAttemptCreated: boolean;
    recoveryIntentWritten: boolean;
    recoveryIntentVerified: boolean;
    recoveryStarted: boolean;
    repositoryWriteRequired: boolean;
    repositoryWriteAttempted: boolean;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean | null;
    repositoryMatchesX1Baseline: boolean;
    repositoryMatchesX4AppliedState: boolean;
    validationWorkspaceCleanupAttempted: boolean;
    validationWorkspaceCleanupSucceeded: boolean | null;
    receiptWritten: boolean;
    receiptVerified: boolean;
    terminalMarker: "RECOVERED_NO_WRITE" | "RECOVERED_ROLLED_BACK" | "RECOVERY_FAILED" | null;
    consumptionClaimReleased: false;
    originalX4RegistryModified: false;
    originalX5RegistryModified: false;
    gitIndexMutated: false;
    gitHistoryMutated: false;
    shellExecuted: false;
    commitCreated: false;
    pushExecuted: false;
  };
};

export type ControlledTransactionRecoveryReceiptVerificationInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  receipt: ControlledTransactionRecoveryReceipt;
  authorization: ControlledApplyExecutionAuthorization;
  expectedInspection: ControlledRepositoryInspection;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledTransactionRecoveryReceiptVerificationDecision =
  | "controlled_transaction_recovery_receipt_current"
  | "controlled_transaction_recovery_receipt_stale"
  | "controlled_transaction_recovery_receipt_invalid"
  | "controlled_transaction_recovery_receipt_requires_recovery";

export type ControlledTransactionRecoveryReceiptVerificationResult = {
  decision: ControlledTransactionRecoveryReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  registryRecordVerified: boolean;
  terminalMarker: "RECOVERED_NO_WRITE" | "RECOVERED_ROLLED_BACK" | "RECOVERY_FAILED" | "INCOMPLETE" | null;
  repositoryStateMatched: boolean;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  summary: {
    authorizationMatched: boolean;
    consumptionKeyMatched: boolean;
    recoveryIntentMatched: boolean;
    recoveryPlanMatched: boolean;
    expectedInspectionMatched: boolean;
    restoredBaselineMatched: boolean;
    originalClaimStillPresent: boolean;
    originalValidationRecordsPreserved: boolean;
    recoveryRequired: boolean;
    repositoryWritePerformedByVerifier: false;
    gitMutationPerformedByVerifier: false;
    shellExecutedByVerifier: false;
  };
};

type PlainRecord = Record<string, unknown>;
type RegistryEvidence = {
  x4State: ControlledX4RecoveryState;
  x5State: ControlledX5RecoveryState;
  reservation: ControlledApplyConsumptionReservation | null;
  transaction: ControlledRepositoryApplyTransactionIntent | null;
  applyReceipt: ControlledRepositoryApplyReceipt | null;
  validationIntent: ControlledPostApplyValidationIntent | null;
  validationRecord: ControlledPostApplyValidationRecord | null;
  finalReceipt: ControlledPostApplyFinalReceipt | null;
};
type ValidatedInput = {
  input: ControlledTransactionRecoveryInput;
  timeoutMs: number;
  maxGitOutputBytes: number;
  maxEntryBytes: number;
  maxBundleBytes: number;
  maxRegistryFileBytes: number;
  maxRegistryEntryCount: number;
  policyHash: string;
};
type RecoveryHistoryBinding = {
  authorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  mutationHash: string;
  changedFiles: readonly string[];
  expectedInspectionHash: string;
  rollbackManifestHash: string;
  rollbackBundleManifestHash: string;
  rollbackBundleReceiptHash: string;
  rollbackPayloadRootHash: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_REGISTRY_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REGISTRY_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_REGISTRY_ENTRIES = 10_000;
const MAX_REGISTRY_ENTRIES = 100_000;
const MAX_ATTEMPTS = 1_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const INPUT_FIELDS = new Set([
  "repositoryPath", "bundleDirectoryPath", "registryDirectoryPath",
  "validationWorkspaceParentPath", "authorization", "gateInput", "consumptionKey",
  "policy", "timeoutMs", "maxGitOutputBytes", "maxEntryBytes", "maxBundleBytes",
  "maxRegistryFileBytes", "maxRegistryEntryCount"
]);
const VERIFY_FIELDS = new Set([
  "repositoryPath", "registryDirectoryPath", "receipt", "authorization",
  "expectedInspection", "timeoutMs", "maxGitOutputBytes"
]);
const X4_ALLOWED = new Set([
  "reservation.json", "transaction.json", "WRITE_STARTED", "steps",
  "apply-receipt.json", "rollback-receipt.json", "COMMITTED", "ROLLED_BACK",
  "ROLLBACK_FAILED"
]);
const X5_ALLOWED = new Set([
  "validation-intent.json", "VALIDATION_STARTED", "validation-result.json",
  "final-receipt.json", "FINALIZED", "VALIDATION_ROLLED_BACK",
  "VALIDATION_ROLLBACK_FAILED"
]);
const execFileAsync = promisify(execFile);
const ACTIVE_RECOVERIES = new Set<string>();
const RECOVERY_CODES = new Set([
  "invalid_controlled_transaction_recovery_input",
  "invalid_controlled_transaction_recovery_object",
  "unknown_controlled_transaction_recovery_field",
  "missing_controlled_transaction_recovery_field",
  "controlled_transaction_recovery_accessor_property",
  "controlled_transaction_recovery_symbol_property",
  "controlled_transaction_recovery_policy_invalid",
  "controlled_transaction_recovery_policy_relaxation_forbidden",
  "controlled_transaction_recovery_consumption_key_mismatch",
  "controlled_transaction_recovery_authorization_invalid",
  "controlled_transaction_recovery_registry_path_invalid",
  "controlled_transaction_recovery_registry_symlink_detected",
  "controlled_transaction_recovery_registry_entry_unexpected",
  "controlled_transaction_recovery_registry_record_too_large",
  "controlled_transaction_recovery_x4_claim_missing",
  "controlled_transaction_recovery_x4_registry_invalid",
  "controlled_transaction_recovery_x5_registry_invalid",
  "controlled_transaction_recovery_terminal_markers_conflict",
  "controlled_transaction_recovery_state_combination_invalid",
  "controlled_transaction_recovery_no_action_required",
  "controlled_transaction_recovery_post_apply_validation_required",
  "controlled_transaction_recovery_prewrite_claim_incomplete",
  "controlled_transaction_recovery_write_started_incomplete",
  "controlled_transaction_recovery_validation_intent_incomplete",
  "controlled_transaction_recovery_validation_started_incomplete",
  "controlled_transaction_recovery_previous_rollback_failed",
  "controlled_transaction_recovery_repository_head_changed",
  "controlled_transaction_recovery_repository_index_changed",
  "controlled_transaction_recovery_repository_operation_in_progress",
  "controlled_transaction_recovery_unexpected_changed_file",
  "controlled_transaction_recovery_baseline_mismatch",
  "controlled_transaction_recovery_applied_state_mismatch",
  "controlled_transaction_recovery_rollback_bundle_invalid",
  "controlled_transaction_recovery_rollback_not_safe",
  "controlled_transaction_recovery_rollback_failed",
  "controlled_transaction_recovery_rollback_verification_failed",
  "controlled_transaction_recovery_attempt_limit_exceeded",
  "controlled_transaction_recovery_attempt_creation_failed",
  "controlled_transaction_recovery_intent_write_failed",
  "controlled_transaction_recovery_intent_hash_mismatch",
  "controlled_transaction_recovery_start_marker_failed",
  "controlled_transaction_recovery_state_changed_before_write",
  "controlled_transaction_recovery_workspace_cleanup_failed",
  "controlled_transaction_recovery_receipt_write_failed",
  "controlled_transaction_recovery_receipt_hash_mismatch",
  "controlled_transaction_recovery_terminal_marker_failed",
  "controlled_transaction_recovery_receipt_stale",
  "controlled_transaction_recovery_recovery_required",
  "controlled_transaction_recovery_exception"
]);
const RECOVERY_STALE_FIELDS = new Set([
  "consumptionKey", "authorizationHash", "governedArtifactHash", "handoffHash",
  "mutationHash", "changedFiles", "x4State", "x5State", "reservationHash",
  "transactionHash", "x4ApplyReceiptHash", "x5ValidationIntentHash",
  "x5ValidationRecordHash", "x5FinalReceiptHash", "expectedInspectionHash",
  "finalInspectionHash", "rollbackManifestHash", "rollbackBundleManifestHash",
  "rollbackBundleReceiptHash", "rollbackPayloadRootHash", "recoveryPlanHash",
  "recoveryIntentHash", "recoveryReceiptHash", "terminalMarker"
]);

class RecoveryFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: "invalid" | "review" | "blocked" = "invalid",
    readonly field?: string
  ) { super(message); }
}
class TrustedRecoveryConfigurationError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY:
Readonly<ControlledTransactionRecoveryPolicy> = deepFreeze({ ...STRICT_POLICY });

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function issue(
  code: string, kind: "invalid" | "review" | "blocked" = "invalid", field?: string
): ControlledTransactionRecoveryIssue {
  const stableCode = RECOVERY_CODES.has(code) ? code : "controlled_transaction_recovery_exception";
  const messages: Record<string, string> = {
    controlled_transaction_recovery_no_action_required: "No recovery action is required.",
    controlled_transaction_recovery_post_apply_validation_required: "Normal post-apply validation is required.",
    controlled_transaction_recovery_prewrite_claim_incomplete: "The claim stopped before repository write.",
    controlled_transaction_recovery_write_started_incomplete: "The repository write transaction is incomplete.",
    controlled_transaction_recovery_validation_intent_incomplete: "The validation transaction is incomplete.",
    controlled_transaction_recovery_validation_started_incomplete: "Validation started but did not terminate.",
    controlled_transaction_recovery_previous_rollback_failed: "A previous rollback failed.",
    controlled_transaction_recovery_x4_claim_missing: "The permanent consumption claim is missing.",
    controlled_transaction_recovery_repository_head_changed: "Repository HEAD changed after authorization.",
    controlled_transaction_recovery_repository_index_changed: "The Git index is not clean.",
    controlled_transaction_recovery_repository_operation_in_progress: "A Git operation is active.",
    controlled_transaction_recovery_unexpected_changed_file: "An unexpected changed path prevents recovery.",
    controlled_transaction_recovery_baseline_mismatch: "Repository state does not match the baseline.",
    controlled_transaction_recovery_rollback_bundle_invalid: "The sealed rollback bundle is invalid.",
    controlled_transaction_recovery_recovery_required: "The recovery attempt requires further recovery."
  };
  return {
    code: stableCode, message: messages[stableCode] ?? "Controlled transaction recovery evidence is invalid.",
    severity: kind === "review" ? "review" : "error", ...(field ? { field } : {})
  };
}

function inspectObject(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new RecoveryFailure(
    "invalid_controlled_transaction_recovery_object", "Cyclic input is invalid."
  );
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new RecoveryFailure(
      "controlled_transaction_recovery_symbol_property", "Symbol input is forbidden."
    );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new RecoveryFailure(
        "invalid_controlled_transaction_recovery_object", "Sparse or extended arrays are invalid."
      );
    }
    seen.add(value);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) throw new RecoveryFailure(
        "controlled_transaction_recovery_accessor_property", "Accessor input is forbidden."
      );
      if ("value" in descriptor) inspectObject(descriptor.value, seen);
    }
    seen.delete(value); return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new RecoveryFailure(
    "invalid_controlled_transaction_recovery_object", "Exotic input is invalid."
  );
  if (Object.getOwnPropertySymbols(value).length > 0) throw new RecoveryFailure(
    "controlled_transaction_recovery_symbol_property", "Symbol input is forbidden."
  );
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new RecoveryFailure(
      "controlled_transaction_recovery_accessor_property", "Accessor input is forbidden."
    );
    if ("value" in descriptor) inspectObject(descriptor.value, seen);
  }
  seen.delete(value);
}

function exactTop(value: unknown, fields: Set<string>, required: readonly string[]): PlainRecord {
  inspectObject(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw new RecoveryFailure(
    "invalid_controlled_transaction_recovery_input", "Recovery input is invalid."
  );
  const record = value as PlainRecord;
  for (const name of Object.keys(record)) if (!fields.has(name)) throw new RecoveryFailure(
    "unknown_controlled_transaction_recovery_field", "Unknown recovery field.", "invalid", name
  );
  for (const name of required) if (!Object.hasOwn(record, name)) throw new RecoveryFailure(
    "missing_controlled_transaction_recovery_field", "Missing recovery field.", "invalid", name
  );
  return record;
}

function numeric(record: PlainRecord, name: string, fallback: number, maximum: number): number {
  const value = record[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TrustedRecoveryConfigurationError(`Invalid trusted recovery limit: ${name}.`);
  }
  return value as number;
}

function validatePolicy(value: unknown): string {
  const policy = value === undefined ? STRICT_POLICY : value;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy) ||
      Object.getPrototypeOf(policy) !== Object.prototype ||
      Object.getOwnPropertySymbols(policy).length > 0) throw new RecoveryFailure(
    "controlled_transaction_recovery_policy_invalid", "Recovery policy is invalid."
  );
  const descriptors = Object.getOwnPropertyDescriptors(policy);
  if (Object.values(descriptors).some((entry) => entry.get || entry.set)) throw new RecoveryFailure(
    "controlled_transaction_recovery_policy_invalid", "Recovery policy is invalid."
  );
  const expected = Object.keys(STRICT_POLICY).sort();
  if (Object.keys(policy).sort().join("\0") !== expected.join("\0")) throw new RecoveryFailure(
    "controlled_transaction_recovery_policy_invalid", "Recovery policy is invalid."
  );
  for (const [name, expectedValue] of Object.entries(STRICT_POLICY)) {
    const actual = (policy as PlainRecord)[name];
    if (actual === false && expectedValue === true) throw new TrustedRecoveryConfigurationError(
      `Recovery policy relaxation is forbidden: ${name}.`
    );
    if (actual !== expectedValue) throw new RecoveryFailure(
      "controlled_transaction_recovery_policy_invalid", "Recovery policy is invalid."
    );
  }
  return hashCanonicalJson(policy);
}

function validateInput(value: unknown): ValidatedInput {
  const top = exactTop(value, INPUT_FIELDS, [
    "repositoryPath", "bundleDirectoryPath", "registryDirectoryPath", "authorization",
    "gateInput", "consumptionKey"
  ]);
  const policyHash = validatePolicy(top.policy);
  for (const name of ["repositoryPath", "bundleDirectoryPath", "registryDirectoryPath",
    "consumptionKey"]) if (typeof top[name] !== "string" || (top[name] as string).length === 0) {
    throw new RecoveryFailure("invalid_controlled_transaction_recovery_input", "Recovery input is invalid.");
  }
  const cloned = structuredClone(top) as unknown as ControlledTransactionRecoveryInput;
  return {
    input: cloned, policyHash,
    timeoutMs: numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxGitOutputBytes: numeric(top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES),
    maxEntryBytes: numeric(top, "maxEntryBytes", DEFAULT_ENTRY_BYTES, MAX_ENTRY_BYTES),
    maxBundleBytes: numeric(top, "maxBundleBytes", DEFAULT_BUNDLE_BYTES, MAX_BUNDLE_BYTES),
    maxRegistryFileBytes: numeric(top, "maxRegistryFileBytes", DEFAULT_REGISTRY_FILE_BYTES, MAX_REGISTRY_FILE_BYTES),
    maxRegistryEntryCount: numeric(top, "maxRegistryEntryCount", DEFAULT_REGISTRY_ENTRIES, MAX_REGISTRY_ENTRIES)
  };
}

function hashWithout(value: PlainRecord, field: string): string {
  const material = { ...value }; delete material[field]; return hashCanonicalJson(material);
}

function exactRecord(value: unknown, fields: readonly string[]): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_entry_unexpected", "Recovery record structure is invalid."
  );
  return value as PlainRecord;
}

function validateRecoveryIntent(value: unknown): ControlledTransactionRecoveryIntent {
  const record = exactRecord(value, [
    "intentVersion", "attemptIndex", "consumptionKey", "authorizationHash",
    "governedArtifactHash", "handoffHash", "mutationHash", "changedFiles", "x4State",
    "x5State", "action", "expectedInspectionHash", "rollbackManifestHash",
    "rollbackBundleManifestHash", "rollbackBundleReceiptHash", "rollbackPayloadRootHash",
    "policyHash", "recoveryPlanHash", "intentHash"
  ]);
  if (record.intentVersion !== "1" || !Number.isSafeInteger(record.attemptIndex) ||
      (record.attemptIndex as number) < 0 || (record.attemptIndex as number) >= MAX_ATTEMPTS ||
      !Array.isArray(record.changedFiles) ||
      !(record.changedFiles as unknown[]).every((file) => typeof file === "string") ||
      !canonicalEqual(record.changedFiles, sortedUnique(record.changedFiles as string[])) ||
      !["close_prewrite_claim_without_repository_write", "restore_x1_baseline"].includes(record.action as string) ||
      !["x4_claim_missing", "x4_claim_created_prewrite_incomplete", "x4_write_started_incomplete",
        "x4_committed", "x4_rolled_back", "x4_rollback_failed", "x4_registry_invalid"]
        .includes(record.x4State as string) ||
      !["x5_transaction_missing", "x5_intent_created_prevalidation_incomplete",
        "x5_validation_started_incomplete", "x5_finalized", "x5_validation_rolled_back",
        "x5_validation_rollback_failed", "x5_registry_invalid"].includes(record.x5State as string)) {
    throw new RecoveryFailure("controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent is invalid.");
  }
  for (const field of [
    "consumptionKey", "authorizationHash", "governedArtifactHash", "handoffHash",
    "mutationHash", "expectedInspectionHash", "rollbackManifestHash",
    "rollbackBundleManifestHash", "rollbackBundleReceiptHash", "rollbackPayloadRootHash",
    "policyHash", "recoveryPlanHash", "intentHash"
  ]) if (!HASH.test(record[field] as string)) throw new RecoveryFailure(
    "controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent hash field is invalid."
  );
  if (record.intentHash !== hashWithout(record, "intentHash")) throw new RecoveryFailure(
    "controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent hash mismatched."
  );
  return record as unknown as ControlledTransactionRecoveryIntent;
}

function validateRecoveryReceipt(value: unknown): ControlledTransactionRecoveryReceipt {
  const record = exactRecord(value, [
    "receiptVersion", "attemptIndex", "outcome", "consumptionKey", "authorizationHash",
    "governedArtifactHash", "handoffHash", "mutation", "observedState", "recovery",
    "evidence", "safety", "receiptHash"
  ]);
  const mutation = exactRecord(record.mutation, ["mutationHash", "changedFiles", "changedFileCount"]);
  const observed = exactRecord(record.observedState, ["x4State", "x5State"]);
  const recovery = exactRecord(record.recovery, [
    "action", "repositoryWriteAttempted", "repositoryWriteSucceeded", "rollbackAttempted",
    "rollbackSucceeded", "repositoryMatchesX1Baseline",
    "validationWorkspaceCleanupAttempted", "validationWorkspaceCleanupSucceeded"
  ]);
  const evidence = exactRecord(record.evidence, [
    "recoveryPlanHash", "recoveryIntentHash", "expectedInspectionHash",
    "finalInspectionHash", "rollbackManifestHash", "rollbackBundleManifestHash",
    "rollbackBundleReceiptHash", "rollbackPayloadRootHash"
  ]);
  const safety = exactRecord(record.safety, [
    "consumptionClaimReleased", "originalX4RegistryModified", "originalX5RegistryModified",
    "gitIndexMutated", "gitHistoryMutated", "shellExecuted", "commitCreated", "pushExecuted"
  ]);
  if (record.receiptVersion !== "1" || !Number.isSafeInteger(record.attemptIndex) ||
      (record.attemptIndex as number) < 0 || (record.attemptIndex as number) >= MAX_ATTEMPTS ||
      !["abandoned_before_repository_write", "restored_x1_baseline", "recovery_failed"]
        .includes(record.outcome as string) || !Array.isArray(mutation.changedFiles) ||
      !(mutation.changedFiles as unknown[]).every((file) => typeof file === "string") ||
      !canonicalEqual(mutation.changedFiles, sortedUnique(mutation.changedFiles as string[])) ||
      mutation.changedFileCount !== (mutation.changedFiles as unknown[]).length ||
      !["x4_claim_missing", "x4_claim_created_prewrite_incomplete", "x4_write_started_incomplete",
        "x4_committed", "x4_rolled_back", "x4_rollback_failed", "x4_registry_invalid"]
        .includes(observed.x4State as string) ||
      !["x5_transaction_missing", "x5_intent_created_prevalidation_incomplete",
        "x5_validation_started_incomplete", "x5_finalized", "x5_validation_rolled_back",
        "x5_validation_rollback_failed", "x5_registry_invalid"].includes(observed.x5State as string) ||
      !["close_prewrite_claim_without_repository_write", "restore_x1_baseline"]
        .includes(recovery.action as string) ||
      Object.values(safety).some((field) => field !== false)) throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt structure is invalid."
  );
  for (const field of ["repositoryWriteAttempted", "rollbackAttempted",
    "repositoryMatchesX1Baseline", "validationWorkspaceCleanupAttempted"]) {
    if (typeof recovery[field] !== "boolean") throw new RecoveryFailure(
      "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt boolean is invalid."
    );
  }
  for (const field of ["repositoryWriteSucceeded", "rollbackSucceeded",
    "validationWorkspaceCleanupSucceeded"]) if (recovery[field] !== null &&
      typeof recovery[field] !== "boolean") throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt result is invalid."
  );
  const successNoWrite = record.outcome === "abandoned_before_repository_write" &&
    recovery.action === "close_prewrite_claim_without_repository_write" &&
    recovery.repositoryWriteAttempted === false && recovery.rollbackAttempted === false &&
    recovery.repositoryMatchesX1Baseline === true;
  const successRollback = record.outcome === "restored_x1_baseline" &&
    recovery.action === "restore_x1_baseline" && recovery.repositoryWriteAttempted === true &&
    recovery.repositoryWriteSucceeded === true && recovery.rollbackAttempted === true &&
    recovery.rollbackSucceeded === true && recovery.repositoryMatchesX1Baseline === true;
  const failed = record.outcome === "recovery_failed";
  if (!successNoWrite && !successRollback && !failed) throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt outcome is inconsistent."
  );
  for (const hash of [
    record.consumptionKey, record.authorizationHash, record.governedArtifactHash,
    record.handoffHash, mutation.mutationHash, evidence.recoveryPlanHash,
    evidence.recoveryIntentHash, evidence.expectedInspectionHash,
    evidence.rollbackManifestHash, evidence.rollbackBundleManifestHash,
    evidence.rollbackBundleReceiptHash, evidence.rollbackPayloadRootHash, record.receiptHash
  ]) if (!HASH.test(hash as string)) throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt hash field is invalid."
  );
  if (evidence.finalInspectionHash !== null && !HASH.test(evidence.finalInspectionHash as string)) throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Final inspection hash is invalid."
  );
  if (record.receiptHash !== hashWithout(record, "receiptHash")) throw new RecoveryFailure(
    "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt hash mismatched."
  );
  return record as unknown as ControlledTransactionRecoveryReceipt;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalizeJson(left) === canonicalizeJson(right); } catch { return false; }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error;
  }
}

async function noSymlinkSegments(configured: string): Promise<void> {
  const absolute = path.resolve(configured);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_symlink_detected", "A configured path segment is unsafe."
    );
  }
}

async function privateDirectory(configured: string): Promise<string> {
  await noSymlinkSegments(configured);
  const metadata = await lstat(configured);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new RecoveryFailure("controlled_transaction_recovery_registry_path_invalid", "Private directory required.");
  }
  return realpath(configured);
}

async function validatePaths(validated: ValidatedInput): Promise<{
  repository: string; bundle: string; registry: string; gitCommon: string; workspaceParent: string | null;
}> {
  const { input } = validated;
  await noSymlinkSegments(input.repositoryPath);
  const repository = await realpath(input.repositoryPath);
  const bundle = await privateDirectory(input.bundleDirectoryPath);
  const registry = await privateDirectory(input.registryDirectoryPath);
  await noSymlinkSegments(input.gateInput.repositoryPath);
  await noSymlinkSegments(input.gateInput.bundleDirectoryPath);
  const gateRepository = await realpath(input.gateInput.repositoryPath);
  const gateBundle = await realpath(input.gateInput.bundleDirectoryPath);
  if (repository !== gateRepository || bundle !== gateBundle) throw new RecoveryFailure(
    "invalid_controlled_transaction_recovery_input", "Configured recovery paths do not match gate evidence."
  );
  const result = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repository, timeout: validated.timeoutMs, maxBuffer: validated.maxGitOutputBytes,
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  const gitCommon = await realpath(path.resolve(repository, result.stdout.trim()));
  if (inside(repository, registry) || inside(registry, repository) ||
      inside(gitCommon, registry) || inside(registry, gitCommon) ||
      inside(bundle, registry) || inside(registry, bundle) ||
      inside(repository, bundle) || inside(bundle, repository) ||
      inside(gitCommon, bundle) || inside(bundle, gitCommon)) {
    throw new RecoveryFailure("controlled_transaction_recovery_registry_path_invalid", "Recovery paths overlap.");
  }
  let workspaceParent: string | null = null;
  if (input.validationWorkspaceParentPath !== undefined) {
    workspaceParent = await privateDirectory(input.validationWorkspaceParentPath);
    if ([repository, gitCommon, bundle, registry].some((entry) =>
      inside(entry, workspaceParent!) || inside(workspaceParent!, entry))) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_path_invalid", "Workspace path overlaps protected state."
    );
  }
  return { repository, bundle, registry, gitCommon, workspaceParent };
}

async function validateVerifierRegistry(
  repositoryPath: string, registryPath: string, timeoutMs: number, maxGitOutputBytes: number
): Promise<{ repository: string; registry: string }> {
  await noSymlinkSegments(repositoryPath);
  const repository = await realpath(repositoryPath);
  const registry = await privateDirectory(registryPath);
  const result = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repository, timeout: timeoutMs, maxBuffer: maxGitOutputBytes,
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  const gitCommon = await realpath(path.resolve(repository, result.stdout.trim()));
  if (inside(repository, registry) || inside(registry, repository) ||
      inside(gitCommon, registry) || inside(registry, gitCommon)) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_path_invalid", "Verifier registry path is unsafe."
  );
  return { repository, registry };
}

async function readCanonical<T>(file: string, maximum: number): Promise<T> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_record_too_large", "Registry record is invalid."
  );
  const bytes = await readFile(file);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new RecoveryFailure(
    "controlled_transaction_recovery_x4_registry_invalid", "Registry JSON is invalid."
  ); }
  if (!bytes.equals(Buffer.from(canonicalizeJson(parsed), "utf8"))) throw new RecoveryFailure(
    "controlled_transaction_recovery_x4_registry_invalid", "Registry record is noncanonical."
  );
  return parsed as T;
}

async function validateDirectoryLayout(
  directory: string, allowed: Set<string>, maximumEntries: number, maximumFileBytes: number,
  allowSteps: boolean
): Promise<string[]> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_symlink_detected", "Registry directory is unsafe."
  );
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEntries) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_entry_unexpected", "Registry entry limit exceeded."
  );
  for (const entry of entries) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) throw new RecoveryFailure(
      entry.isSymbolicLink() ? "controlled_transaction_recovery_registry_symlink_detected" :
        "controlled_transaction_recovery_registry_entry_unexpected", "Unexpected registry entry."
    );
    if (entry.name === "steps") {
      if (!allowSteps || !entry.isDirectory()) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_entry_unexpected", "Invalid steps entry."
      );
      const stepsMetadata = await lstat(path.join(directory, "steps"));
      if ((stepsMetadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_entry_unexpected", "Invalid steps directory mode."
      );
      const steps = await readdir(path.join(directory, "steps"), { withFileTypes: true });
      if (steps.length > maximumEntries || steps.some((step) =>
        !step.isFile() || step.isSymbolicLink() || !/^\d{6}\.json$/.test(step.name))) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_entry_unexpected", "Invalid step registry entry."
      );
      for (const step of steps) {
        const stepMetadata = await lstat(path.join(directory, "steps", step.name));
        if ((stepMetadata.mode & 0o777) !== 0o600 || stepMetadata.size > maximumFileBytes) throw new RecoveryFailure(
          "controlled_transaction_recovery_registry_record_too_large", "Invalid step registry record."
        );
      }
    } else if (!entry.isFile()) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Registry entry must be a file."
    ); else {
      const fileMetadata = await lstat(path.join(directory, entry.name));
      const marker = [
        "WRITE_STARTED", "COMMITTED", "ROLLED_BACK", "ROLLBACK_FAILED",
        "VALIDATION_STARTED", "FINALIZED", "VALIDATION_ROLLED_BACK",
        "VALIDATION_ROLLBACK_FAILED"
      ].includes(entry.name);
      if ((fileMetadata.mode & 0o777) !== 0o600 || fileMetadata.size > maximumFileBytes ||
          (marker && fileMetadata.size !== 0)) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_record_too_large", "Registry record metadata is invalid."
      );
    }
  }
  return entries.map((entry) => entry.name);
}

function authorizationValid(input: ControlledTransactionRecoveryInput): boolean {
  const authorization = input.authorization;
  if (!authorization || typeof authorization !== "object" || !HASH.test(authorization.authorizationHash) ||
      authorization.authorizationHash !== hashWithout(authorization as unknown as PlainRecord, "authorizationHash")) return false;
  const gate = input.gateInput;
  let mutationHash: string;
  let changedFiles: readonly string[];
  try {
    mutationHash = computeGovernedMutationHash(gate.artifact.change.changeKind, gate.mutation);
    changedFiles = deriveGovernedMutationChangedFiles(gate.mutation);
  } catch { return false; }
  const inspection = gate.expectedInspection;
  const rollbackManifest = inspection.rollbackManifest;
  if (gate.artifact.governedArtifactHash !==
        hashWithout(gate.artifact as unknown as PlainRecord, "governedArtifactHash") ||
      gate.handoff.handoffHash !==
        hashWithout(gate.handoff as unknown as PlainRecord, "handoffHash") ||
      inspection.inspectionHash !==
        hashWithout(inspection as unknown as PlainRecord, "inspectionHash") ||
      rollbackManifest.manifestHash !==
        hashWithout(rollbackManifest as unknown as PlainRecord, "manifestHash")) return false;
  return input.consumptionKey === authorization.consumptionKey &&
    input.consumptionKey === gate.handoff.singleUse.consumptionKey &&
    authorization.governedArtifactHash === gate.artifact.governedArtifactHash &&
    authorization.handoffHash === gate.handoff.handoffHash &&
    authorization.mutation.mutationHash === mutationHash &&
    canonicalEqual(authorization.mutation.changedFiles, changedFiles) &&
    canonicalEqual(gate.changedFiles, changedFiles) &&
    authorization.evidence.expectedInspectionHash === gate.expectedInspection.inspectionHash &&
    authorization.evidence.rollbackManifestHash === gate.expectedInspection.rollbackManifest.manifestHash &&
    authorization.evidence.rollbackBundleManifestHash === gate.rollbackBundleManifest.bundleManifestHash &&
    authorization.evidence.rollbackBundleReceiptHash === gate.rollbackBundleReceipt.receiptHash &&
    authorization.evidence.rollbackPayloadRootHash === gate.rollbackBundleManifest.payloadRootHash;
}

async function readRegistryEvidence(
  registry: string, key: string, maximum: number, maximumEntries: number
): Promise<RegistryEvidence> {
  const hex = key.slice(7);
  for (const parent of [path.join(registry, "claims"), path.join(registry, "validations")]) {
    if (await exists(parent)) {
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
          (parentMetadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_symlink_detected", "Registry namespace is unsafe."
      );
    }
  }
  const claim = path.join(registry, "claims", hex);
  const validation = path.join(registry, "validations", hex);
  if (!await exists(claim)) return {
    x4State: "x4_claim_missing", x5State: await exists(validation) ? "x5_registry_invalid" : "x5_transaction_missing",
    reservation: null, transaction: null, applyReceipt: null,
    validationIntent: null, validationRecord: null, finalReceipt: null
  };
  await noSymlinkSegments(claim);
  if (await exists(validation)) await noSymlinkSegments(validation);
  try {
    const names = await validateDirectoryLayout(claim, X4_ALLOWED, maximumEntries, maximum, true);
    let totalEntries = names.length;
    const terminals = ["COMMITTED", "ROLLED_BACK", "ROLLBACK_FAILED"].filter((name) => names.includes(name));
    if (terminals.length > 1) throw new RecoveryFailure(
      "controlled_transaction_recovery_terminal_markers_conflict", "Conflicting X.4 terminal markers."
    );
    const reservation = verifyControlledApplyConsumptionReservationRecord(
      await readCanonical<ControlledApplyConsumptionReservation>(path.join(claim, "reservation.json"), maximum)
    );
    const transaction = verifyControlledRepositoryApplyTransactionRecord(
      await readCanonical<ControlledRepositoryApplyTransactionIntent>(path.join(claim, "transaction.json"), maximum)
    );
    if (reservation.reservationHash !== computeControlledApplyConsumptionReservationHash(reservation) ||
        transaction.transactionHash !== computeControlledRepositoryApplyTransactionHash(transaction) ||
        transaction.reservationHash !== reservation.reservationHash || transaction.authorizationHash !== reservation.authorizationHash ||
        transaction.consumptionKey !== reservation.consumptionKey) throw new RecoveryFailure(
      "controlled_transaction_recovery_x4_registry_invalid", "X.4 registry binding is invalid."
    );
    let stepCount = 0;
    if (names.includes("steps")) {
      const stepNames = (await readdir(path.join(claim, "steps"))).sort();
      stepCount = stepNames.length;
      totalEntries += stepCount;
      if (totalEntries > maximumEntries) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_entry_unexpected", "Registry entry limit exceeded."
      );
      if (stepNames.length > transaction.expectedOperations.length) throw new RecoveryFailure(
        "controlled_transaction_recovery_x4_registry_invalid", "X.4 step count is invalid."
      );
      for (let index = 0; index < stepNames.length; index += 1) {
        if (stepNames[index] !== `${index.toString().padStart(6, "0")}.json`) throw new RecoveryFailure(
          "controlled_transaction_recovery_x4_registry_invalid", "X.4 step order is invalid."
        );
        const step = verifyControlledRepositoryApplyStepRecord(
          await readCanonical<ControlledRepositoryApplyStepRecord>(
            path.join(claim, "steps", stepNames[index]), maximum
          )
        );
        const expected = transaction.expectedOperations[index];
        if (step.index !== index || step.filePath !== expected?.filePath ||
            step.operation !== expected.operation ||
            step.expectedAfterStateHash !== expected.expectedAfterStateHash) throw new RecoveryFailure(
          "controlled_transaction_recovery_x4_registry_invalid", "X.4 step binding is invalid."
        );
      }
    }
    let applyReceipt: ControlledRepositoryApplyReceipt | null = null;
    if (names.includes("apply-receipt.json") && names.includes("rollback-receipt.json")) throw new RecoveryFailure(
      "controlled_transaction_recovery_terminal_markers_conflict", "Conflicting X.4 receipts."
    );
    const receiptName = names.includes("apply-receipt.json") ? "apply-receipt.json" :
      names.includes("rollback-receipt.json") ? "rollback-receipt.json" : null;
    if (receiptName) {
      applyReceipt = verifyControlledRepositoryApplyReceiptRecord(
        await readCanonical<ControlledRepositoryApplyReceipt>(path.join(claim, receiptName), maximum)
      );
      if (applyReceipt.receiptHash !== computeControlledRepositoryApplyReceiptHash(applyReceipt) ||
          applyReceipt.reservationHash !== reservation.reservationHash ||
          applyReceipt.transactionHash !== transaction.transactionHash) throw new RecoveryFailure(
        "controlled_transaction_recovery_x4_registry_invalid", "X.4 receipt is invalid."
      );
    }
    if (!names.includes("WRITE_STARTED") &&
        (stepCount > 0 || receiptName !== null || terminals.length > 0)) throw new RecoveryFailure(
      "controlled_transaction_recovery_x4_registry_invalid", "X.4 write ordering is invalid."
    );
    let x4State: ControlledX4RecoveryState;
    if (terminals[0] === "COMMITTED") x4State = applyReceipt?.outcome === "applied" ? "x4_committed" : "x4_registry_invalid";
    else if (terminals[0] === "ROLLED_BACK") x4State = applyReceipt?.outcome === "rolled_back" ? "x4_rolled_back" : "x4_registry_invalid";
    else if (terminals[0] === "ROLLBACK_FAILED") x4State = "x4_rollback_failed";
    else x4State = names.includes("WRITE_STARTED") ? "x4_write_started_incomplete" : "x4_claim_created_prewrite_incomplete";

    let x5State: ControlledX5RecoveryState = "x5_transaction_missing";
    let validationIntent: ControlledPostApplyValidationIntent | null = null;
    let validationRecord: ControlledPostApplyValidationRecord | null = null;
    let finalReceipt: ControlledPostApplyFinalReceipt | null = null;
    if (await exists(validation)) {
      try {
        const validationNames = await validateDirectoryLayout(
          validation, X5_ALLOWED, maximumEntries, maximum, false
        );
        totalEntries += validationNames.length;
        if (totalEntries > maximumEntries) throw new RecoveryFailure(
          "controlled_transaction_recovery_registry_entry_unexpected", "Registry entry limit exceeded."
        );
        const validationTerminals = ["FINALIZED", "VALIDATION_ROLLED_BACK", "VALIDATION_ROLLBACK_FAILED"]
          .filter((name) => validationNames.includes(name));
        if (validationTerminals.length > 1) throw new RecoveryFailure(
          "controlled_transaction_recovery_terminal_markers_conflict",
          "Conflicting X.5 terminal markers."
        );
        validationIntent = verifyControlledPostApplyValidationIntentRecord(
          await readCanonical<ControlledPostApplyValidationIntent>(path.join(validation, "validation-intent.json"), maximum)
        );
        if (validationIntent.intentHash !== computeControlledPostApplyValidationIntentHash(validationIntent) ||
            validationIntent.consumptionKey !== reservation.consumptionKey ||
            validationIntent.authorizationHash !== reservation.authorizationHash ||
            validationIntent.x4ApplyReceiptHash !== applyReceipt?.receiptHash ||
            validationIntent.governedArtifactHash !== reservation.governedArtifactHash ||
            validationIntent.handoffHash !== reservation.handoffHash ||
            validationIntent.mutationHash !== reservation.mutationHash ||
            validationIntent.appliedStateHash !== applyReceipt?.after.appliedStateHash ||
            validationIntent.finalScopeHash !== applyReceipt?.after.finalScopeHash ||
            validationIntent.expectedInspectionHash !== transaction.expectedInspectionHash ||
            validationIntent.rollbackManifestHash !== transaction.rollbackManifestHash ||
            validationIntent.rollbackBundleManifestHash !== reservation.rollbackBundleManifestHash ||
            validationIntent.rollbackBundleReceiptHash !== reservation.rollbackBundleReceiptHash) throw new Error("intent");
        if (validationNames.includes("validation-result.json")) {
          validationRecord = verifyControlledPostApplyValidationResultRecord(
            await readCanonical<ControlledPostApplyValidationRecord>(path.join(validation, "validation-result.json"), maximum)
          );
          if (validationRecord.recordHash !== computeControlledPostApplyValidationRecordHash(validationRecord) ||
              validationRecord.intentHash !== validationIntent.intentHash) throw new Error("record");
        }
        if (validationNames.includes("final-receipt.json")) {
          finalReceipt = verifyControlledPostApplyFinalReceiptRecord(
            await readCanonical<ControlledPostApplyFinalReceipt>(path.join(validation, "final-receipt.json"), maximum)
          );
          if (finalReceipt.receiptHash !== computeControlledPostApplyFinalReceiptHash(finalReceipt) ||
              finalReceipt.x4ApplyReceiptHash !== applyReceipt?.receiptHash ||
              finalReceipt.consumptionKey !== reservation.consumptionKey ||
              finalReceipt.authorizationHash !== reservation.authorizationHash ||
              finalReceipt.governedArtifactHash !== reservation.governedArtifactHash ||
              finalReceipt.handoffHash !== reservation.handoffHash ||
              finalReceipt.mutation.mutationHash !== reservation.mutationHash ||
              !canonicalEqual(finalReceipt.mutation.changedFiles, reservation.changedFiles) ||
              finalReceipt.repository.beforeApplyInspectionHash !== transaction.expectedInspectionHash ||
              finalReceipt.rollback.rollbackManifestHash !== transaction.rollbackManifestHash ||
              finalReceipt.rollback.rollbackBundleManifestHash !== reservation.rollbackBundleManifestHash ||
              finalReceipt.rollback.rollbackBundleReceiptHash !== reservation.rollbackBundleReceiptHash ||
              (validationRecord !== null && (
                finalReceipt.validation.validationSpecificationHash !== validationRecord.validationSpecificationHash ||
                finalReceipt.validation.phaseVExecutionVerificationResultHash !==
                  validationRecord.phaseVExecutionVerificationResultHash ||
                finalReceipt.validation.validationDecision !== validationRecord.decision
              ))) throw new Error("receipt");
        }
        if (!validationNames.includes("VALIDATION_STARTED") &&
            (validationRecord !== null || finalReceipt !== null || validationTerminals.length > 0)) {
          throw new Error("validation ordering");
        }
        if (validationTerminals[0] === "FINALIZED") x5State = finalReceipt?.outcome === "validated" ? "x5_finalized" : "x5_registry_invalid";
        else if (validationTerminals[0] === "VALIDATION_ROLLED_BACK") x5State = finalReceipt?.outcome === "validation_failed_rolled_back" ? "x5_validation_rolled_back" : "x5_registry_invalid";
        else if (validationTerminals[0] === "VALIDATION_ROLLBACK_FAILED") x5State = "x5_validation_rollback_failed";
        else x5State = validationNames.includes("VALIDATION_STARTED") ?
          "x5_validation_started_incomplete" : "x5_intent_created_prevalidation_incomplete";
      } catch (error) {
        if (error instanceof RecoveryFailure &&
            error.code === "controlled_transaction_recovery_terminal_markers_conflict") throw error;
        x5State = "x5_registry_invalid";
      }
    }
    return { x4State, x5State, reservation, transaction, applyReceipt,
      validationIntent, validationRecord, finalReceipt };
  } catch (error) {
    if (error instanceof RecoveryFailure && error.code === "controlled_transaction_recovery_terminal_markers_conflict") throw error;
    return { x4State: "x4_registry_invalid", x5State: "x5_transaction_missing",
      reservation: null, transaction: null, applyReceipt: null,
      validationIntent: null, validationRecord: null, finalReceipt: null };
  }
}

async function readRecoveryHistory(
  registry: string, key: string, maximum: number, maximumEntries: number,
  binding: RecoveryHistoryBinding
): Promise<{ successful: boolean }> {
  const attempts = path.join(registry, "recoveries", key.slice(7), "attempts");
  if (!await exists(attempts)) return { successful: false };
  await noSymlinkSegments(attempts);
  for (const directory of [path.dirname(path.dirname(attempts)), path.dirname(attempts), attempts]) {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        (directoryMetadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Recovery namespace mode is invalid."
    );
  }
  const metadata = await lstat(attempts);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
    "controlled_transaction_recovery_registry_symlink_detected", "Recovery history is unsafe."
  );
  const entries = await readdir(attempts, { withFileTypes: true });
  if (entries.length > MAX_ATTEMPTS || entries.length > maximumEntries) throw new RecoveryFailure(
    "controlled_transaction_recovery_attempt_limit_exceeded", "Recovery attempt limit exceeded."
  );
  let successful = false;
  let totalEntries = entries.length;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^\d{6}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Recovery attempt entry is invalid."
    );
    const directory = path.join(attempts, entry.name);
    const directoryMetadata = await lstat(directory);
    if ((directoryMetadata.mode & 0o777) !== 0o700) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Recovery attempt mode is invalid."
    );
    const names = await readdir(directory, { withFileTypes: true });
    totalEntries += names.length;
    if (totalEntries > maximumEntries) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Recovery history entry limit exceeded."
    );
    const allowed = new Set([
      "recovery-intent.json", "RECOVERY_STARTED", "recovery-receipt.json",
      "RECOVERED_NO_WRITE", "RECOVERED_ROLLED_BACK", "RECOVERY_FAILED"
    ]);
    if (names.length > maximumEntries || names.some((item) =>
      !allowed.has(item.name) || !item.isFile() || item.isSymbolicLink())) throw new RecoveryFailure(
      "controlled_transaction_recovery_registry_entry_unexpected", "Recovery attempt layout is invalid."
    );
    for (const item of names) {
      const itemMetadata = await lstat(path.join(directory, item.name));
      const marker = item.name === "RECOVERY_STARTED" || item.name === "RECOVERED_NO_WRITE" ||
        item.name === "RECOVERED_ROLLED_BACK" || item.name === "RECOVERY_FAILED";
      if ((itemMetadata.mode & 0o777) !== 0o600 || itemMetadata.size > maximum ||
          (marker && itemMetadata.size !== 0)) throw new RecoveryFailure(
        "controlled_transaction_recovery_registry_record_too_large", "Recovery attempt record is invalid."
      );
    }
    const set = new Set(names.map((item) => item.name));
    if (!set.has("recovery-intent.json")) throw new RecoveryFailure(
      "controlled_transaction_recovery_recovery_required", "Recovery attempt is incomplete.", "review"
    );
    const intent = validateRecoveryIntent(await readCanonical<ControlledTransactionRecoveryIntent>(
      path.join(directory, "recovery-intent.json"), maximum
    ));
    if (intent.intentHash !== hashWithout(intent as unknown as PlainRecord, "intentHash") ||
        intent.consumptionKey !== key || intent.attemptIndex !== Number(entry.name) ||
        intent.authorizationHash !== binding.authorizationHash ||
        intent.governedArtifactHash !== binding.governedArtifactHash ||
        intent.handoffHash !== binding.handoffHash || intent.mutationHash !== binding.mutationHash ||
        !canonicalEqual(intent.changedFiles, binding.changedFiles) ||
        intent.expectedInspectionHash !== binding.expectedInspectionHash ||
        intent.rollbackManifestHash !== binding.rollbackManifestHash ||
        intent.rollbackBundleManifestHash !== binding.rollbackBundleManifestHash ||
        intent.rollbackBundleReceiptHash !== binding.rollbackBundleReceiptHash ||
        intent.rollbackPayloadRootHash !== binding.rollbackPayloadRootHash) throw new RecoveryFailure(
      "controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent is invalid."
    );
    const terminals = ["RECOVERED_NO_WRITE", "RECOVERED_ROLLED_BACK", "RECOVERY_FAILED"]
      .filter((name) => set.has(name));
    if (terminals.length > 1) throw new RecoveryFailure(
      "controlled_transaction_recovery_terminal_markers_conflict", "Recovery terminal markers conflict."
    );
    if (!set.has("recovery-receipt.json")) continue;
    const receipt = validateRecoveryReceipt(await readCanonical<ControlledTransactionRecoveryReceipt>(
      path.join(directory, "recovery-receipt.json"), maximum
    ));
    if (receipt.receiptHash !== hashWithout(receipt as unknown as PlainRecord, "receiptHash") ||
        receipt.attemptIndex !== intent.attemptIndex || receipt.consumptionKey !== key ||
        receipt.evidence.recoveryIntentHash !== intent.intentHash ||
        receipt.evidence.recoveryPlanHash !== intent.recoveryPlanHash) throw new RecoveryFailure(
      "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt is invalid."
    );
    if ((terminals[0] === "RECOVERED_NO_WRITE" && receipt.outcome !== "abandoned_before_repository_write") ||
        (terminals[0] === "RECOVERED_ROLLED_BACK" && receipt.outcome !== "restored_x1_baseline") ||
        (terminals[0] === "RECOVERY_FAILED" && receipt.outcome !== "recovery_failed")) throw new RecoveryFailure(
      "controlled_transaction_recovery_terminal_markers_conflict", "Recovery receipt terminal mismatched."
    );
    if (terminals[0] === "RECOVERED_NO_WRITE" || terminals[0] === "RECOVERED_ROLLED_BACK") successful = true;
  }
  return { successful };
}

function initialInspectionSummary(): ControlledTransactionRecoveryInspectionResult["summary"] {
  return {
    inputValid: false, policyValid: false, authorizationValid: false,
    consumptionKeyMatched: false, x4State: "x4_registry_invalid",
    x5State: "x5_registry_invalid", x4RegistryValid: false, x5RegistryValid: false,
    rollbackBundleVerified: false, repositoryHeadMatched: false,
    repositoryIndexClean: false, repositoryOperationInProgress: false,
    authorizedScopeOnly: false, unexpectedChangedFileCount: 0,
    repositoryMatchesX1Baseline: false, repositoryMatchesX4AppliedState: false,
    recoveryAction: null, repositoryWriteRequired: false, humanRecoveryRequired: false,
    registryWritePerformed: false, repositoryWritePerformed: false,
    gitMutationPerformed: false, shellExecuted: false
  };
}

function finishInspection(
  decision: ControlledTransactionRecoveryInspectionDecision,
  issues: ControlledTransactionRecoveryIssue[], plan: ControlledTransactionRecoveryPlan | null,
  summary: ControlledTransactionRecoveryInspectionResult["summary"]
): ControlledTransactionRecoveryInspectionResult {
  return deepFreeze({ decision, issues: [...issues], plan, summary });
}

async function appliedStateMatches(
  repository: string, receipt: ControlledRepositoryApplyReceipt | null
): Promise<boolean> {
  if (!receipt || receipt.outcome !== "applied" || !receipt.after.appliedStateHash) return false;
  for (const entry of receipt.after.appliedFiles) {
    const current = await inspectControlledRepositoryFileState(path.resolve(repository, entry.filePath));
    if (current.stateHash !== entry.finalStateHash) return false;
  }
  return true;
}

function stateCombinationValid(x4: ControlledX4RecoveryState, x5: ControlledX5RecoveryState): boolean {
  if (x5 === "x5_transaction_missing") return true;
  if (x4 !== "x4_committed") return false;
  return x5 !== "x5_registry_invalid";
}

function chooseAction(
  evidence: RegistryEvidence, baseline: boolean, applied: boolean,
  safe: boolean
): { action: ControlledTransactionRecoveryAction; codes: string[]; kind: "ready" | "invalid" | "review" } {
  if (evidence.x4State === "x4_claim_missing") return {
    action: "human_recovery_required", codes: ["controlled_transaction_recovery_x4_claim_missing"], kind: "invalid"
  };
  if (evidence.x4State === "x4_registry_invalid" || evidence.x5State === "x5_registry_invalid" ||
      !stateCombinationValid(evidence.x4State, evidence.x5State)) return {
    action: "human_recovery_required", codes: ["controlled_transaction_recovery_state_combination_invalid"], kind: "invalid"
  };
  if (evidence.x4State === "x4_claim_created_prewrite_incomplete") return baseline &&
    evidence.x5State === "x5_transaction_missing" ? {
      action: "close_prewrite_claim_without_repository_write",
      codes: ["controlled_transaction_recovery_prewrite_claim_incomplete"], kind: "ready"
    } : { action: "human_recovery_required",
      codes: ["controlled_transaction_recovery_baseline_mismatch"], kind: "review" };
  if (evidence.x4State === "x4_rolled_back" || evidence.x5State === "x5_validation_rolled_back") return baseline ? {
    action: "no_action_required", codes: ["controlled_transaction_recovery_no_action_required"], kind: "ready"
  } : { action: "human_recovery_required", codes: ["controlled_transaction_recovery_baseline_mismatch"], kind: "review" };
  if (evidence.x5State === "x5_finalized") return applied ? {
    action: "no_action_required", codes: ["controlled_transaction_recovery_no_action_required"], kind: "ready"
  } : { action: "human_recovery_required", codes: ["controlled_transaction_recovery_applied_state_mismatch"], kind: "review" };
  if (evidence.x4State === "x4_committed" && evidence.x5State === "x5_transaction_missing") return applied ? {
    action: "run_post_apply_validation", codes: ["controlled_transaction_recovery_post_apply_validation_required"], kind: "ready"
  } : { action: "human_recovery_required", codes: ["controlled_transaction_recovery_applied_state_mismatch"], kind: "review" };
  const recoverable = evidence.x4State === "x4_write_started_incomplete" ||
    evidence.x4State === "x4_rollback_failed" ||
    evidence.x5State === "x5_intent_created_prevalidation_incomplete" ||
    evidence.x5State === "x5_validation_started_incomplete" ||
    evidence.x5State === "x5_validation_rollback_failed";
  if (recoverable) return safe ? {
    action: "restore_x1_baseline", codes: [
      evidence.x4State === "x4_write_started_incomplete" ? "controlled_transaction_recovery_write_started_incomplete" :
      evidence.x4State === "x4_rollback_failed" || evidence.x5State === "x5_validation_rollback_failed" ?
        "controlled_transaction_recovery_previous_rollback_failed" :
      evidence.x5State === "x5_validation_started_incomplete" ?
        "controlled_transaction_recovery_validation_started_incomplete" :
        "controlled_transaction_recovery_validation_intent_incomplete"
    ], kind: "ready"
  } : { action: "human_recovery_required", codes: ["controlled_transaction_recovery_rollback_not_safe"], kind: "review" };
  return { action: "human_recovery_required", codes: ["controlled_transaction_recovery_state_combination_invalid"], kind: "invalid" };
}

export async function inspectControlledTransactionRecovery(
  rawInput: ControlledTransactionRecoveryInput
): Promise<ControlledTransactionRecoveryInspectionResult> {
  const summary = initialInspectionSummary();
  try {
    const validated = validateInput(rawInput);
    summary.inputValid = true; summary.policyValid = true;
    const { input } = validated;
    summary.consumptionKeyMatched = input.consumptionKey === input.authorization.consumptionKey &&
      input.consumptionKey === input.gateInput.handoff.singleUse.consumptionKey;
    summary.authorizationValid = authorizationValid(input);
    if (!summary.authorizationValid || !summary.consumptionKeyMatched) throw new RecoveryFailure(
      summary.consumptionKeyMatched ? "controlled_transaction_recovery_authorization_invalid" :
        "controlled_transaction_recovery_consumption_key_mismatch", "Authorization binding is invalid."
    );
    const locations = await validatePaths(validated);
    const evidence = await readRegistryEvidence(
      locations.registry, input.consumptionKey, validated.maxRegistryFileBytes,
      validated.maxRegistryEntryCount
    );
    summary.x4State = evidence.x4State; summary.x5State = evidence.x5State;
    summary.x4RegistryValid = !["x4_claim_missing", "x4_registry_invalid"].includes(evidence.x4State);
    summary.x5RegistryValid = evidence.x5State !== "x5_registry_invalid";
    if (evidence.reservation && (evidence.reservation.consumptionKey !== input.consumptionKey ||
        evidence.reservation.authorizationHash !== input.authorization.authorizationHash ||
        evidence.reservation.governedArtifactHash !== input.authorization.governedArtifactHash ||
        evidence.reservation.handoffHash !== input.authorization.handoffHash)) {
      summary.x4State = "x4_registry_invalid"; summary.x4RegistryValid = false;
    }
    if (evidence.validationIntent && (evidence.validationIntent.consumptionKey !== input.consumptionKey ||
        evidence.validationIntent.authorizationHash !== input.authorization.authorizationHash)) {
      summary.x5State = "x5_registry_invalid"; summary.x5RegistryValid = false;
    }
    const bundle = await verifyControlledRollbackBundle({
      bundleDirectoryPath: locations.bundle,
      expectedManifest: input.gateInput.rollbackBundleManifest,
      expectedReceipt: input.gateInput.rollbackBundleReceipt,
      expectedHandoffHash: input.authorization.handoffHash,
      expectedConsumptionKey: input.consumptionKey,
      expectedInspectionHash: input.gateInput.expectedInspection.inspectionHash,
      maxEntryBytes: validated.maxEntryBytes, maxBundleBytes: validated.maxBundleBytes
    });
    summary.rollbackBundleVerified = bundle.decision === "rollback_bundle_current" && bundle.rollbackUsable;
    const current = await inspectControlledRepository({
      repositoryPath: locations.repository,
      changedFiles: input.authorization.mutation.changedFiles,
      timeoutMs: validated.timeoutMs, maxGitOutputBytes: validated.maxGitOutputBytes
    });
    if (!current.inspection) throw new RecoveryFailure(
      "controlled_transaction_recovery_baseline_mismatch", "Repository cannot be inspected.", "review"
    );
    summary.repositoryHeadMatched = current.inspection.target.baseRevisionHash ===
      input.gateInput.expectedInspection.target.baseRevisionHash;
    summary.repositoryIndexClean = current.inspection.worktree.stagedChangeCount === 0 &&
      current.inspection.worktree.conflictedFileCount === 0;
    summary.repositoryOperationInProgress = current.summary.repositoryOperationInProgress;
    const allowed = new Set(input.authorization.mutation.changedFiles);
    const unexpected = current.inspection.worktree.changedPaths.filter((file) => !allowed.has(file));
    summary.unexpectedChangedFileCount = unexpected.length;
    summary.authorizedScopeOnly = unexpected.length === 0;
    summary.repositoryMatchesX1Baseline = current.inspection.inspectionHash ===
      input.gateInput.expectedInspection.inspectionHash;
    summary.repositoryMatchesX4AppliedState = summary.authorizedScopeOnly &&
      await appliedStateMatches(locations.repository, evidence.applyReceipt);
    const recoveryHistory = await readRecoveryHistory(
      locations.registry, input.consumptionKey, validated.maxRegistryFileBytes,
      validated.maxRegistryEntryCount, {
        authorizationHash: input.authorization.authorizationHash,
        governedArtifactHash: input.authorization.governedArtifactHash,
        handoffHash: input.authorization.handoffHash,
        mutationHash: input.authorization.mutation.mutationHash,
        changedFiles: input.authorization.mutation.changedFiles,
        expectedInspectionHash: input.gateInput.expectedInspection.inspectionHash,
        rollbackManifestHash: input.gateInput.expectedInspection.rollbackManifest.manifestHash,
        rollbackBundleManifestHash: input.gateInput.rollbackBundleManifest.bundleManifestHash,
        rollbackBundleReceiptHash: input.gateInput.rollbackBundleReceipt.receiptHash,
        rollbackPayloadRootHash: input.gateInput.rollbackBundleManifest.payloadRootHash
      }
    );
    const rollbackSafe = summary.repositoryHeadMatched && summary.repositoryIndexClean &&
      !summary.repositoryOperationInProgress && summary.authorizedScopeOnly &&
      summary.rollbackBundleVerified;
    let selection = chooseAction(evidence, summary.repositoryMatchesX1Baseline,
      summary.repositoryMatchesX4AppliedState, rollbackSafe);
    if (recoveryHistory.successful && summary.x4RegistryValid && summary.x5RegistryValid &&
        stateCombinationValid(summary.x4State, summary.x5State)) selection =
      summary.repositoryMatchesX1Baseline ? {
      action: "no_action_required", codes: ["controlled_transaction_recovery_no_action_required"], kind: "ready"
    } : {
      action: "human_recovery_required", codes: ["controlled_transaction_recovery_baseline_mismatch"], kind: "review"
    };
    if (!summary.rollbackBundleVerified) selection = {
      action: "human_recovery_required",
      codes: ["controlled_transaction_recovery_rollback_bundle_invalid"], kind: "invalid"
    };
    summary.recoveryAction = selection.action;
    summary.repositoryWriteRequired = selection.action === "restore_x1_baseline";
    summary.humanRecoveryRequired = selection.action === "human_recovery_required";
    const codes = [...selection.codes];
    if (!summary.rollbackBundleVerified) codes.push("controlled_transaction_recovery_rollback_bundle_invalid");
    if (!summary.repositoryHeadMatched) codes.push("controlled_transaction_recovery_repository_head_changed");
    if (!summary.repositoryIndexClean) codes.push("controlled_transaction_recovery_repository_index_changed");
    if (summary.repositoryOperationInProgress) codes.push("controlled_transaction_recovery_repository_operation_in_progress");
    if (!summary.authorizedScopeOnly) codes.push("controlled_transaction_recovery_unexpected_changed_file");
    const material = {
      recoveryVersion: "1" as const, consumptionKey: input.consumptionKey,
      authorizationHash: input.authorization.authorizationHash,
      governedArtifactHash: input.authorization.governedArtifactHash,
      handoffHash: input.authorization.handoffHash,
      mutationHash: input.authorization.mutation.mutationHash,
      changedFiles: [...input.authorization.mutation.changedFiles],
      observedState: { x4State: summary.x4State, x5State: summary.x5State },
      action: selection.action,
      baseline: {
        expectedInspectionHash: input.gateInput.expectedInspection.inspectionHash,
        rollbackManifestHash: input.gateInput.expectedInspection.rollbackManifest.manifestHash,
        repositoryIdentityHash: input.authorization.target.repositoryIdentityHash,
        baseRevisionHash: input.authorization.target.baseRevisionHash,
        worktreeStateHash: input.authorization.target.worktreeStateHash
      },
      rollbackBundle: {
        bundleManifestHash: input.gateInput.rollbackBundleManifest.bundleManifestHash,
        bundleReceiptHash: input.gateInput.rollbackBundleReceipt.receiptHash,
        payloadRootHash: input.gateInput.rollbackBundleManifest.payloadRootHash
      },
      safety: {
        headMatched: summary.repositoryHeadMatched, indexClean: summary.repositoryIndexClean,
        noGitOperationInProgress: !summary.repositoryOperationInProgress,
        authorizedScopeOnly: summary.authorizedScopeOnly,
        repositoryMatchesX1Baseline: summary.repositoryMatchesX1Baseline,
        repositoryMatchesX4AppliedState: summary.repositoryMatchesX4AppliedState,
        rollbackBundleUsable: summary.rollbackBundleVerified
      },
      reasonCodes: sortedUnique(codes), policyHash: validated.policyHash
    };
    const plan: ControlledTransactionRecoveryPlan = { ...material, planHash: hashCanonicalJson(material) };
    const decision = selection.kind === "invalid" ? "controlled_transaction_recovery_inspection_invalid" :
      selection.kind === "review" ? "controlled_transaction_recovery_inspection_needs_review" :
        "controlled_transaction_recovery_inspection_ready";
    const outputIssues = selection.kind === "ready" ? [] : sortedUnique(codes).map((code) =>
      issue(code, selection.kind === "review" ? "review" : "invalid")
    );
    return finishInspection(decision, outputIssues,
      selection.kind === "invalid" ? null : plan, summary);
  } catch (error) {
    if (error instanceof TrustedRecoveryConfigurationError) throw error;
    const failure = error instanceof RecoveryFailure ? error : new RecoveryFailure(
      "controlled_transaction_recovery_exception", "Recovery inspection failed."
    );
    const decision = failure.kind === "review" ?
      "controlled_transaction_recovery_inspection_needs_review" :
      failure.kind === "blocked" ? "controlled_transaction_recovery_inspection_blocked" :
        "controlled_transaction_recovery_inspection_invalid";
    return finishInspection(decision, [issue(failure.code, failure.kind, failure.field)], null, summary);
  }
}

function initialResultSummary(): ControlledTransactionRecoveryResult["summary"] {
  return {
    inputValid: false, policyValid: false, inspectionCompleted: false,
    x4State: null, x5State: null, recoveryAction: null,
    recoveryAttemptCreated: false, recoveryIntentWritten: false,
    recoveryIntentVerified: false, recoveryStarted: false,
    repositoryWriteRequired: false, repositoryWriteAttempted: false,
    rollbackAttempted: false, rollbackSucceeded: null,
    repositoryMatchesX1Baseline: false, repositoryMatchesX4AppliedState: false,
    validationWorkspaceCleanupAttempted: false,
    validationWorkspaceCleanupSucceeded: null, receiptWritten: false,
    receiptVerified: false, terminalMarker: null, consumptionClaimReleased: false,
    originalX4RegistryModified: false, originalX5RegistryModified: false,
    gitIndexMutated: false, gitHistoryMutated: false, shellExecuted: false,
    commitCreated: false, pushExecuted: false
  };
}

function finishResult(
  decision: ControlledTransactionRecoveryDecision,
  issues: readonly ControlledTransactionRecoveryIssue[],
  inspection: ControlledTransactionRecoveryInspectionResult | null,
  receipt: ControlledTransactionRecoveryReceipt | null,
  finalRepositoryInspection: ControlledRepositoryInspectionResult | null,
  summary: ControlledTransactionRecoveryResult["summary"]
): ControlledTransactionRecoveryResult {
  return deepFreeze({ decision, issues: [...issues], inspection, receipt, finalRepositoryInspection, summary });
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function writeExclusive(file: string, value?: unknown): Promise<void> {
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.chmod(0o600);
    if (value !== undefined) await handle.writeFile(Buffer.from(canonicalizeJson(value), "utf8"));
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

async function ensureRecoveryDirectory(directory: string): Promise<void> {
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (!created && (metadata.mode & 0o777) !== 0o700)) throw new RecoveryFailure(
    "controlled_transaction_recovery_attempt_creation_failed", "Recovery namespace is unsafe."
  );
  if (created) {
    await chmod(directory, 0o700);
    await syncDirectory(path.dirname(directory));
  }
}

async function createAttempt(registry: string, key: string): Promise<{ directory: string; index: number }> {
  const root = path.join(registry, "recoveries", key.slice(7));
  for (const directory of [path.join(registry, "recoveries"), root, path.join(root, "attempts")]) {
    await ensureRecoveryDirectory(directory);
  }
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    const directory = path.join(root, "attempts", index.toString().padStart(6, "0"));
    try {
      await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
      await syncDirectory(path.dirname(directory)); return { directory, index };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new RecoveryFailure("controlled_transaction_recovery_attempt_limit_exceeded", "Recovery attempt limit exceeded.", "blocked");
}

function buildIntent(plan: ControlledTransactionRecoveryPlan, index: number): ControlledTransactionRecoveryIntent {
  if (plan.action !== "close_prewrite_claim_without_repository_write" && plan.action !== "restore_x1_baseline") {
    throw new RecoveryFailure("controlled_transaction_recovery_state_combination_invalid", "Recovery action is not executable.");
  }
  const material = {
    intentVersion: "1" as const, attemptIndex: index, consumptionKey: plan.consumptionKey,
    authorizationHash: plan.authorizationHash, governedArtifactHash: plan.governedArtifactHash,
    handoffHash: plan.handoffHash, mutationHash: plan.mutationHash,
    changedFiles: [...plan.changedFiles], x4State: plan.observedState.x4State,
    x5State: plan.observedState.x5State, action: plan.action,
    expectedInspectionHash: plan.baseline.expectedInspectionHash,
    rollbackManifestHash: plan.baseline.rollbackManifestHash,
    rollbackBundleManifestHash: plan.rollbackBundle.bundleManifestHash,
    rollbackBundleReceiptHash: plan.rollbackBundle.bundleReceiptHash,
    rollbackPayloadRootHash: plan.rollbackBundle.payloadRootHash,
    policyHash: plan.policyHash, recoveryPlanHash: plan.planHash
  };
  return { ...material, intentHash: hashCanonicalJson(material) };
}

function buildReceipt(
  intent: ControlledTransactionRecoveryIntent,
  outcome: ControlledTransactionRecoveryReceipt["outcome"],
  finalInspectionHash: string | null, baseline: boolean,
  cleanupAttempted: boolean, cleanupSucceeded: boolean | null,
  execution?: {
    repositoryWriteAttempted: boolean;
    repositoryWriteSucceeded: boolean | null;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean | null;
  }
): ControlledTransactionRecoveryReceipt {
  const rollback = intent.action === "restore_x1_baseline";
  const success = outcome !== "recovery_failed";
  const material = {
    receiptVersion: "1" as const, attemptIndex: intent.attemptIndex, outcome,
    consumptionKey: intent.consumptionKey, authorizationHash: intent.authorizationHash,
    governedArtifactHash: intent.governedArtifactHash, handoffHash: intent.handoffHash,
    mutation: { mutationHash: intent.mutationHash, changedFiles: [...intent.changedFiles], changedFileCount: intent.changedFiles.length },
    observedState: { x4State: intent.x4State, x5State: intent.x5State },
    recovery: {
      action: intent.action,
      repositoryWriteAttempted: execution ? execution.repositoryWriteAttempted : rollback,
      repositoryWriteSucceeded: execution ? execution.repositoryWriteSucceeded : (rollback ? success : null),
      rollbackAttempted: execution ? execution.rollbackAttempted : rollback,
      rollbackSucceeded: execution ? execution.rollbackSucceeded : (rollback ? success : null),
      repositoryMatchesX1Baseline: baseline,
      validationWorkspaceCleanupAttempted: cleanupAttempted,
      validationWorkspaceCleanupSucceeded: cleanupSucceeded
    },
    evidence: {
      recoveryPlanHash: intent.recoveryPlanHash, recoveryIntentHash: intent.intentHash,
      expectedInspectionHash: intent.expectedInspectionHash, finalInspectionHash,
      rollbackManifestHash: intent.rollbackManifestHash,
      rollbackBundleManifestHash: intent.rollbackBundleManifestHash,
      rollbackBundleReceiptHash: intent.rollbackBundleReceiptHash,
      rollbackPayloadRootHash: intent.rollbackPayloadRootHash
    },
    safety: {
      consumptionClaimReleased: false as const, originalX4RegistryModified: false as const,
      originalX5RegistryModified: false as const, gitIndexMutated: false as const,
      gitHistoryMutated: false as const, shellExecuted: false as const,
      commitCreated: false as const, pushExecuted: false as const
    }
  };
  return { ...material, receiptHash: hashCanonicalJson(material) };
}

async function cleanupWorkspace(
  parent: string | null, key: string
): Promise<{ attempted: boolean; succeeded: boolean | null }> {
  if (!parent) return { attempted: false, succeeded: null };
  const workspace = path.join(parent, `controlled-post-apply-${key.slice(7)}.partial`);
  if (!await exists(workspace)) return { attempted: false, succeeded: null };
  try {
    const metadata = await lstat(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.dirname(workspace) !== parent) return { attempted: true, succeeded: false };
    await rm(workspace, { recursive: true, force: false });
    return { attempted: true, succeeded: true };
  } catch { return { attempted: true, succeeded: false }; }
}

export async function executeControlledTransactionRecovery(
  rawInput: ControlledTransactionRecoveryInput
): Promise<ControlledTransactionRecoveryResult> {
  const summary = initialResultSummary();
  let inspection: ControlledTransactionRecoveryInspectionResult | null = null;
  let attempt: { directory: string; index: number } | null = null;
  let intent: ControlledTransactionRecoveryIntent | null = null;
  let finalInspection: ControlledRepositoryInspectionResult | null = null;
  let activeKey: string | null = null;
  try {
    const validated = validateInput(rawInput); summary.inputValid = true; summary.policyValid = true;
    inspection = await inspectControlledTransactionRecovery(validated.input);
    summary.inspectionCompleted = true; summary.x4State = inspection.summary.x4State;
    summary.x5State = inspection.summary.x5State; summary.recoveryAction = inspection.summary.recoveryAction;
    summary.repositoryWriteRequired = inspection.summary.repositoryWriteRequired;
    summary.repositoryMatchesX1Baseline = inspection.summary.repositoryMatchesX1Baseline;
    summary.repositoryMatchesX4AppliedState = inspection.summary.repositoryMatchesX4AppliedState;
    if (inspection.decision === "controlled_transaction_recovery_inspection_invalid") return finishResult(
      "controlled_transaction_recovery_invalid", inspection.issues, inspection, null, null, summary
    );
    if (inspection.decision === "controlled_transaction_recovery_inspection_needs_review") return finishResult(
      "controlled_transaction_recovery_needs_review", inspection.issues, inspection, null, null, summary
    );
    if (inspection.decision === "controlled_transaction_recovery_inspection_blocked") return finishResult(
      "controlled_transaction_recovery_blocked", inspection.issues, inspection, null, null, summary
    );
    if (inspection.plan?.action === "no_action_required") return finishResult(
      "controlled_transaction_recovery_not_required", inspection.issues, inspection, null, null, summary
    );
    if (inspection.plan?.action === "run_post_apply_validation") return finishResult(
      "controlled_transaction_recovery_awaiting_validation", inspection.issues, inspection, null, null, summary
    );
    if (!inspection.plan) throw new RecoveryFailure("controlled_transaction_recovery_state_combination_invalid", "Missing recovery plan.");
    const locations = await validatePaths(validated);
    activeKey = `${locations.registry}\0${validated.input.consumptionKey}`;
    if (ACTIVE_RECOVERIES.has(activeKey)) throw new RecoveryFailure(
      "controlled_transaction_recovery_attempt_creation_failed", "Another recovery is active.", "blocked"
    );
    ACTIVE_RECOVERIES.add(activeKey);
    try { attempt = await createAttempt(locations.registry, validated.input.consumptionKey); }
    catch (error) {
      if (error instanceof RecoveryFailure) throw error;
      throw new RecoveryFailure(
        "controlled_transaction_recovery_attempt_creation_failed", "Recovery attempt creation failed.", "blocked"
      );
    }
    summary.recoveryAttemptCreated = true;
    intent = buildIntent(inspection.plan, attempt.index);
    try { await writeExclusive(path.join(attempt.directory, "recovery-intent.json"), intent); }
    catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_intent_write_failed", "Recovery intent write failed."
    ); }
    summary.recoveryIntentWritten = true;
    let diskIntent: ControlledTransactionRecoveryIntent;
    try {
      diskIntent = validateRecoveryIntent(await readCanonical<ControlledTransactionRecoveryIntent>(
        path.join(attempt.directory, "recovery-intent.json"), validated.maxRegistryFileBytes
      ));
    } catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent verification failed."
    ); }
    if (!canonicalEqual(diskIntent, intent) || diskIntent.intentHash !== hashWithout(diskIntent as unknown as PlainRecord, "intentHash")) throw new RecoveryFailure(
      "controlled_transaction_recovery_intent_hash_mismatch", "Recovery intent verification failed."
    );
    summary.recoveryIntentVerified = true;
    try { await writeExclusive(path.join(attempt.directory, "RECOVERY_STARTED")); }
    catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_start_marker_failed", "Recovery start marker failed."
    ); }
    summary.recoveryStarted = true;
    const reinspection = await inspectControlledTransactionRecovery(validated.input);
    if (reinspection.decision !== "controlled_transaction_recovery_inspection_ready" ||
        !reinspection.plan || reinspection.plan.planHash !== intent.recoveryPlanHash) throw new RecoveryFailure(
      "controlled_transaction_recovery_state_changed_before_write", "Recovery state changed after durable start."
    );
    let outcome: ControlledTransactionRecoveryReceipt["outcome"];
    if (intent.action === "close_prewrite_claim_without_repository_write") {
      outcome = "abandoned_before_repository_write";
    } else {
      summary.repositoryWriteAttempted = true; summary.rollbackAttempted = true;
      let restored;
      try {
        restored = await restoreControlledRepositoryFromRollbackBundle({
          gateInput: validated.input.gateInput, timeoutMs: validated.timeoutMs,
          maxGitOutputBytes: validated.maxGitOutputBytes, maxEntryBytes: validated.maxEntryBytes,
          maxBundleBytes: validated.maxBundleBytes
        });
      } catch { throw new RecoveryFailure(
        "controlled_transaction_recovery_rollback_failed", "Rollback execution failed."
      ); }
      summary.rollbackSucceeded = restored.baselineRestored;
      finalInspection = restored.rollbackInspection;
      summary.repositoryMatchesX1Baseline = restored.baselineRestored;
      if (!restored.baselineRestored) throw new RecoveryFailure(
        "controlled_transaction_recovery_rollback_verification_failed", "Rollback verification failed."
      );
      outcome = "restored_x1_baseline";
    }
    const cleanup = await cleanupWorkspace(locations.workspaceParent, intent.consumptionKey);
    summary.validationWorkspaceCleanupAttempted = cleanup.attempted;
    summary.validationWorkspaceCleanupSucceeded = cleanup.succeeded;
    const receipt = buildReceipt(intent, outcome,
      finalInspection?.inspection?.inspectionHash ?? validated.input.gateInput.expectedInspection.inspectionHash,
      true, cleanup.attempted, cleanup.succeeded);
    try { await writeExclusive(path.join(attempt.directory, "recovery-receipt.json"), receipt); }
    catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_receipt_write_failed", "Recovery receipt write failed."
    ); }
    summary.receiptWritten = true;
    let diskReceipt: ControlledTransactionRecoveryReceipt;
    try {
      diskReceipt = validateRecoveryReceipt(await readCanonical<ControlledTransactionRecoveryReceipt>(
        path.join(attempt.directory, "recovery-receipt.json"), validated.maxRegistryFileBytes
      ));
    } catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt verification failed."
    ); }
    if (!canonicalEqual(diskReceipt, receipt) || diskReceipt.receiptHash !== hashWithout(diskReceipt as unknown as PlainRecord, "receiptHash")) throw new RecoveryFailure(
      "controlled_transaction_recovery_receipt_hash_mismatch", "Recovery receipt verification failed."
    );
    summary.receiptVerified = true;
    const marker = outcome === "abandoned_before_repository_write" ? "RECOVERED_NO_WRITE" : "RECOVERED_ROLLED_BACK";
    try { await writeExclusive(path.join(attempt.directory, marker)); }
    catch { throw new RecoveryFailure(
      "controlled_transaction_recovery_terminal_marker_failed", "Recovery terminal marker failed."
    ); }
    summary.terminalMarker = marker;
    return finishResult(outcome === "abandoned_before_repository_write" ?
      "controlled_transaction_recovery_closed_prewrite" : "controlled_transaction_recovery_rolled_back",
      inspection.issues, inspection, receipt, finalInspection, summary);
  } catch (error) {
    if (error instanceof TrustedRecoveryConfigurationError) throw error;
    const failure = error instanceof RecoveryFailure ? error : new RecoveryFailure(
      "controlled_transaction_recovery_exception", "Recovery execution failed."
    );
    if (summary.recoveryStarted && attempt && intent) {
      let receipt: ControlledTransactionRecoveryReceipt | null = null;
      try {
        receipt = buildReceipt(intent, "recovery_failed",
          finalInspection?.inspection?.inspectionHash ?? null,
          summary.repositoryMatchesX1Baseline,
          summary.validationWorkspaceCleanupAttempted,
          summary.validationWorkspaceCleanupSucceeded, {
            repositoryWriteAttempted: summary.repositoryWriteAttempted,
            repositoryWriteSucceeded: summary.repositoryWriteAttempted ? summary.rollbackSucceeded : null,
            rollbackAttempted: summary.rollbackAttempted,
            rollbackSucceeded: summary.rollbackSucceeded
          });
        await writeExclusive(path.join(attempt.directory, "recovery-receipt.json"), receipt);
        summary.receiptWritten = true; summary.receiptVerified = true;
      } catch { /* preserve the strongest durable evidence already written */ }
      try {
        await writeExclusive(path.join(attempt.directory, "RECOVERY_FAILED"));
        summary.terminalMarker = "RECOVERY_FAILED";
      } catch { /* RECOVERY_STARTED remains the durable lower bound */ }
      return finishResult("controlled_transaction_recovery_failed", [issue(failure.code)],
        inspection, receipt, finalInspection, summary);
    }
    return finishResult(failure.kind === "blocked" ? "controlled_transaction_recovery_blocked" :
      failure.kind === "review" ? "controlled_transaction_recovery_needs_review" :
        "controlled_transaction_recovery_invalid", [issue(failure.code, failure.kind)],
      inspection, null, null, summary);
  } finally {
    if (activeKey) ACTIVE_RECOVERIES.delete(activeKey);
  }
}

function verificationSummary(): ControlledTransactionRecoveryReceiptVerificationResult["summary"] {
  return {
    authorizationMatched: false, consumptionKeyMatched: false,
    recoveryIntentMatched: false, recoveryPlanMatched: false,
    expectedInspectionMatched: false, restoredBaselineMatched: false,
    originalClaimStillPresent: false, originalValidationRecordsPreserved: false,
    recoveryRequired: false, repositoryWritePerformedByVerifier: false,
    gitMutationPerformedByVerifier: false, shellExecutedByVerifier: false
  };
}

export async function verifyControlledTransactionRecoveryReceipt(
  rawInput: ControlledTransactionRecoveryReceiptVerificationInput
): Promise<ControlledTransactionRecoveryReceiptVerificationResult> {
  const summary = verificationSummary();
  const stale: string[] = [];
  const finish = (
    decision: ControlledTransactionRecoveryReceiptVerificationDecision,
    integrity: boolean, registry: boolean,
    marker: ControlledTransactionRecoveryReceiptVerificationResult["terminalMarker"],
    repository: boolean, reasons: string[]
  ) => deepFreeze({ decision, receiptIntegrityVerified: integrity,
    registryRecordVerified: registry, terminalMarker: marker,
    repositoryStateMatched: repository,
    staleFields: sortedUnique(stale.filter((field) => RECOVERY_STALE_FIELDS.has(field))),
    reasonCodes: sortedUnique(reasons), summary });
  try {
    const top = exactTop(rawInput, VERIFY_FIELDS, [
      "repositoryPath", "registryDirectoryPath", "receipt", "authorization", "expectedInspection"
    ]);
    const timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxGitOutputBytes = numeric(top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES);
    const receipt = validateRecoveryReceipt(structuredClone(top.receipt));
    const authorization = structuredClone(top.authorization) as ControlledApplyExecutionAuthorization;
    const expected = structuredClone(top.expectedInspection) as ControlledRepositoryInspection;
    if (!authorization || typeof authorization !== "object" ||
        authorization.authorizationHash !==
          hashWithout(authorization as unknown as PlainRecord, "authorizationHash") ||
        expected.inspectionHash !== hashWithout(expected as unknown as PlainRecord, "inspectionHash") ||
        expected.rollbackManifest.manifestHash !==
          hashWithout(expected.rollbackManifest as unknown as PlainRecord, "manifestHash")) return finish(
      "controlled_transaction_recovery_receipt_invalid", false, false, null, false,
      ["controlled_transaction_recovery_authorization_invalid"]
    );
    if (!HASH.test(receipt.receiptHash) || receipt.receiptHash !== hashWithout(receipt as unknown as PlainRecord, "receiptHash")) return finish(
      "controlled_transaction_recovery_receipt_invalid", false, false, null, false,
      ["controlled_transaction_recovery_receipt_hash_mismatch"]
    );
    summary.authorizationMatched = receipt.authorizationHash === authorization.authorizationHash &&
      receipt.governedArtifactHash === authorization.governedArtifactHash &&
      receipt.handoffHash === authorization.handoffHash &&
      receipt.mutation.mutationHash === authorization.mutation.mutationHash &&
      canonicalEqual(receipt.mutation.changedFiles, authorization.mutation.changedFiles);
    summary.consumptionKeyMatched = receipt.consumptionKey === authorization.consumptionKey;
    summary.expectedInspectionMatched = receipt.evidence.expectedInspectionHash === expected.inspectionHash &&
      receipt.evidence.rollbackManifestHash === expected.rollbackManifest.manifestHash;
    if (!summary.authorizationMatched) stale.push("authorizationHash");
    if (!summary.consumptionKeyMatched) stale.push("consumptionKey");
    if (!summary.expectedInspectionMatched) stale.push("expectedInspectionHash");
    const verifiedPaths = await validateVerifierRegistry(
      top.repositoryPath as string, top.registryDirectoryPath as string,
      timeoutMs, maxGitOutputBytes
    );
    const { repository, registry } = verifiedPaths;
    const hex = receipt.consumptionKey.slice(7);
    const original = await readRegistryEvidence(
      registry, receipt.consumptionKey, DEFAULT_REGISTRY_FILE_BYTES, DEFAULT_REGISTRY_ENTRIES
    );
    summary.originalClaimStillPresent = original.x4State !== "x4_claim_missing" &&
      original.x4State !== "x4_registry_invalid";
    summary.originalValidationRecordsPreserved = original.x5State !== "x5_registry_invalid";
    if (!summary.originalClaimStillPresent) stale.push("reservationHash");
    if (!summary.originalValidationRecordsPreserved) stale.push("x5ValidationIntentHash");
    if (original.x4State !== receipt.observedState.x4State) stale.push("x4State");
    if (original.x5State !== receipt.observedState.x5State) stale.push("x5State");
    await readRecoveryHistory(
      registry, receipt.consumptionKey, DEFAULT_REGISTRY_FILE_BYTES, DEFAULT_REGISTRY_ENTRIES, {
        authorizationHash: receipt.authorizationHash,
        governedArtifactHash: receipt.governedArtifactHash,
        handoffHash: receipt.handoffHash,
        mutationHash: receipt.mutation.mutationHash,
        changedFiles: receipt.mutation.changedFiles,
        expectedInspectionHash: receipt.evidence.expectedInspectionHash,
        rollbackManifestHash: receipt.evidence.rollbackManifestHash,
        rollbackBundleManifestHash: receipt.evidence.rollbackBundleManifestHash,
        rollbackBundleReceiptHash: receipt.evidence.rollbackBundleReceiptHash,
        rollbackPayloadRootHash: receipt.evidence.rollbackPayloadRootHash
      }
    );
    const attempt = path.join(registry, "recoveries", hex, "attempts", receipt.attemptIndex.toString().padStart(6, "0"));
    const diskReceipt = validateRecoveryReceipt(await readCanonical<ControlledTransactionRecoveryReceipt>(
      path.join(attempt, "recovery-receipt.json"), DEFAULT_REGISTRY_FILE_BYTES
    ));
    const intent = validateRecoveryIntent(await readCanonical<ControlledTransactionRecoveryIntent>(
      path.join(attempt, "recovery-intent.json"), DEFAULT_REGISTRY_FILE_BYTES
    ));
    summary.recoveryIntentMatched = intent.intentHash === receipt.evidence.recoveryIntentHash &&
      intent.intentHash === hashWithout(intent as unknown as PlainRecord, "intentHash");
    summary.recoveryPlanMatched = intent.recoveryPlanHash === receipt.evidence.recoveryPlanHash;
    if (!summary.recoveryIntentMatched) stale.push("recoveryIntentHash");
    if (!summary.recoveryPlanMatched) stale.push("recoveryPlanHash");
    if (!canonicalEqual(diskReceipt, receipt)) stale.push("recoveryReceiptHash");
    const terminals: Array<"RECOVERED_NO_WRITE" | "RECOVERED_ROLLED_BACK" | "RECOVERY_FAILED"> = [];
    for (const name of ["RECOVERED_NO_WRITE", "RECOVERED_ROLLED_BACK", "RECOVERY_FAILED"] as const) {
      if (await exists(path.join(attempt, name))) terminals.push(name);
    }
    const marker = terminals.length === 0 ? "INCOMPLETE" : terminals.length === 1 ? terminals[0] : null;
    if (terminals.length > 1) stale.push("terminalMarker");
    if (marker === "RECOVERY_FAILED" || marker === "INCOMPLETE") {
      summary.recoveryRequired = true;
      return finish("controlled_transaction_recovery_receipt_requires_recovery", true,
        canonicalEqual(diskReceipt, receipt), marker, false,
        ["controlled_transaction_recovery_recovery_required"]);
    }
    const inspected = await inspectControlledRepository({
      repositoryPath: repository, changedFiles: expected.rollbackManifest.changedFiles,
      timeoutMs, maxGitOutputBytes
    });
    summary.restoredBaselineMatched = inspected.inspection?.inspectionHash === expected.inspectionHash;
    const expectedMarker = receipt.outcome === "abandoned_before_repository_write" ?
      "RECOVERED_NO_WRITE" : receipt.outcome === "restored_x1_baseline" ? "RECOVERED_ROLLED_BACK" : "RECOVERY_FAILED";
    if (marker !== expectedMarker) stale.push("terminalMarker");
    if (!summary.restoredBaselineMatched) stale.push("finalInspectionHash");
    const registryVerified = canonicalEqual(diskReceipt, receipt) && summary.recoveryIntentMatched &&
      summary.recoveryPlanMatched && marker === expectedMarker && summary.originalClaimStillPresent;
    if (stale.length || !summary.restoredBaselineMatched || !registryVerified) return finish(
      "controlled_transaction_recovery_receipt_stale", true, registryVerified, marker,
      summary.restoredBaselineMatched, ["controlled_transaction_recovery_receipt_stale"]
    );
    return finish("controlled_transaction_recovery_receipt_current", true, true, marker, true, []);
  } catch (error) {
    return finish("controlled_transaction_recovery_receipt_invalid", false, false, null, false,
      [error instanceof RecoveryFailure ? error.code : "controlled_transaction_recovery_exception"]);
  }
}
