/**
 * Phase X.3 is a read-only pre-write security boundary. It verifies the live
 * repository, governed evidence, handoff, and external sealed rollback bundle,
 * but never applies a mutation, writes repository content, alters Git state,
 * reserves or consumes a registry key, performs rollback, or emits executable
 * commands. Its authorization is deterministic evidence, not a capability
 * token, and has no trusted lifetime. A future X.4 executor must re-run the
 * verifier immediately before its first write and atomically coordinate
 * registry consumption with repository application. Post-apply validation and
 * rollback execution remain later Phase X work.
 */

import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  computeGovernedMutationHash,
  deriveGovernedMutationChangedFiles,
  verifyControlledApplyHandoff,
  type ControlledApplyHandoffPlan
} from "./controlled-apply-handoff.js";
import {
  verifyGovernedChangeArtifactFreshness,
  type GovernedChangeArtifact,
  type GovernedChangeFreshnessSnapshot,
  type GovernedChangeKind
} from "./governed-change-artifact.js";
import {
  inspectControlledRepository,
  type ControlledRepositoryInspection,
  type ControlledRepositoryInspectionResult
} from "./controlled-repository-inspection.js";
import {
  verifyControlledRollbackBundle,
  type ControlledRollbackAction,
  type ControlledRollbackBundleManifest,
  type ControlledRollbackBundleReceipt,
  type ControlledRollbackBundleVerificationResult
} from "./controlled-rollback-bundle.js";
import type {
  AdminInvocationDecision
} from "./admin-invocation-policy.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export const CONTROLLED_APPLY_EXECUTION_GATE_VERSION = "1" as const;

export type ControlledApplyExecutionGateDecision =
  | "controlled_apply_execution_gate_ready"
  | "controlled_apply_execution_gate_blocked"
  | "controlled_apply_execution_gate_invalid"
  | "controlled_apply_execution_gate_needs_review";

export type ControlledApplyExecutionGatePolicy = {
  policyVersion: "1";
  requireGovernedArtifactV2: true;
  requireCurrentArtifact: true;
  requireCurrentHandoff: true;
  requireHandoffExecutionEligible: true;
  requireRepositoryInspectionReady: true;
  requireCleanWorktree: true;
  requireNoRepositoryOperationInProgress: true;
  requireRepositoryIdentityMatch: true;
  requireBaseRevisionMatch: true;
  requireWorktreeStateMatch: true;
  requireRollbackBundleCurrent: true;
  requireRollbackBundleUsable: true;
  requireCompleteRollbackCoverage: true;
  requireExactMutationHashMatch: true;
  requireExactChangedFileMatch: true;
  requireNotConsumedStatus: true;
  forbidRepositoryWritesInGate: true;
  forbidGitMutationInGate: true;
  forbidRegistryWritesInGate: true;
};

const STRICT_POLICY: ControlledApplyExecutionGatePolicy = {
  policyVersion: "1",
  requireGovernedArtifactV2: true,
  requireCurrentArtifact: true,
  requireCurrentHandoff: true,
  requireHandoffExecutionEligible: true,
  requireRepositoryInspectionReady: true,
  requireCleanWorktree: true,
  requireNoRepositoryOperationInProgress: true,
  requireRepositoryIdentityMatch: true,
  requireBaseRevisionMatch: true,
  requireWorktreeStateMatch: true,
  requireRollbackBundleCurrent: true,
  requireRollbackBundleUsable: true,
  requireCompleteRollbackCoverage: true,
  requireExactMutationHashMatch: true,
  requireExactChangedFileMatch: true,
  requireNotConsumedStatus: true,
  forbidRepositoryWritesInGate: true,
  forbidGitMutationInGate: true,
  forbidRegistryWritesInGate: true
};

export const DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY:
Readonly<ControlledApplyExecutionGatePolicy> = deepFreeze({ ...STRICT_POLICY });

export type ControlledApplyExecutionGateInput = {
  repositoryPath: string;
  bundleDirectoryPath: string;
  changedFiles: readonly string[];
  artifact: GovernedChangeArtifact;
  currentFreshnessSnapshot: GovernedChangeFreshnessSnapshot;
  mutation: WorkspaceMutation;
  handoff: ControlledApplyHandoffPlan;
  expectedInspection: ControlledRepositoryInspection;
  rollbackBundleManifest: ControlledRollbackBundleManifest;
  rollbackBundleReceipt: ControlledRollbackBundleReceipt;
  consumptionStatus: "not_consumed" | "already_consumed" | "unknown";
  policy?: ControlledApplyExecutionGatePolicy;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
};

export type ControlledApplyRollbackCoverageEntry = {
  filePath: string;
  rollbackAction:
    | "restore_regular_file"
    | "restore_symlink"
    | "remove_path";
  payloadRequired: boolean;
  payloadAvailable: boolean;
  baseMode: "100644" | "100755" | "120000" | null;
  payloadObjectHash: string | null;
};

export type ControlledApplyExecutionAuthorization = {
  authorizationVersion: "1";
  governedArtifactHash: string;
  handoffHash: string;
  consumptionKey: string;
  mutation: {
    changeKind: GovernedChangeKind;
    mutationHash: string;
    changedFiles: readonly string[];
    changedFileCount: number;
  };
  target: {
    repositoryIdentityHash: string;
    baseRevisionHash: string;
    worktreeStateHash: string;
  };
  evidence: {
    currentSnapshotHash: string;
    expectedInspectionHash: string;
    currentInspectionHash: string;
    rollbackManifestHash: string;
    rollbackBundleManifestHash: string;
    rollbackBundleReceiptHash: string;
    rollbackPayloadRootHash: string;
    rollbackCoverageHash: string;
    constraintsHash: string;
    gatePolicyHash: string;
  };
  adminResolution: {
    invocationPolicyHash: string;
    invocationAssessmentHash: string;
    invocationDecision: AdminInvocationDecision;
    resolutionKind: "model_decision" | "verified_policy_skip";
    adminDecisionHash: string | null;
  };
  preconditions: {
    artifactCurrent: true;
    artifactApplyEligible: true;
    handoffCurrent: true;
    handoffExecutionEligible: true;
    repositoryInspectionReady: true;
    repositoryClean: true;
    repositoryOperationAbsent: true;
    repositoryTargetMatched: true;
    rollbackBundleCurrent: true;
    rollbackBundleUsable: true;
    rollbackCoverageComplete: true;
    mutationMatched: true;
    changedFilesMatched: true;
    consumptionStatusNotConsumed: true;
  };
  executorRequirements: {
    reverifyAuthorizationImmediatelyBeforeFirstWrite: true;
    recheckConsumptionRegistryBeforeFirstWrite: true;
    reserveOrConsumeKeyAtomicallyWithExecution: true;
    recheckRepositoryStateBeforeFirstWrite: true;
    restrictWritesToChangedFiles: true;
    rejectAdditionalFileWrites: true;
    useVerifiedRollbackBundle: true;
    validateAfterApply: true;
    rollbackOnApplyOrValidationFailure: true;
    produceApplyReceipt: true;
  };
  gatePolicyHash: string;
  authorizationHash: string;
};

export type ControlledApplyExecutionGateIssueSeverity = "review" | "error";
export type ControlledApplyExecutionGateIssue = {
  code: string;
  message: string;
  severity: ControlledApplyExecutionGateIssueSeverity;
  field?: string;
  filePath?: string;
  hashValue?: string;
};

export type ControlledApplyExecutionGateResult = {
  decision: ControlledApplyExecutionGateDecision;
  issues: readonly ControlledApplyExecutionGateIssue[];
  authorization: ControlledApplyExecutionAuthorization | null;
  repositoryInspection: ControlledRepositoryInspectionResult | null;
  rollbackBundleVerification: ControlledRollbackBundleVerificationResult | null;
  summary: {
    inputValid: boolean;
    policyValid: boolean;
    artifactIntegrityVerified: boolean;
    artifactCurrent: boolean;
    artifactApplyEligible: boolean;
    mutationValid: boolean;
    mutationMatched: boolean;
    changedFilesMatched: boolean;
    handoffIntegrityVerified: boolean;
    handoffCurrent: boolean;
    handoffExecutionEligible: boolean;
    repositoryReinspected: boolean;
    repositoryInspectionReady: boolean;
    repositoryClean: boolean;
    repositoryOperationInProgress: boolean;
    repositoryIdentityMatched: boolean;
    baseRevisionMatched: boolean;
    worktreeStateMatched: boolean;
    expectedInspectionMatched: boolean;
    rollbackBundleVerified: boolean;
    rollbackBundleCurrent: boolean;
    rollbackBundleUsable: boolean;
    rollbackCoverageComplete: boolean;
    rollbackCoverageEntryCount: number;
    rollbackCoverageHash: string | null;
    consumptionStatus: "not_consumed" | "already_consumed" | "unknown";
    consumptionAvailable: boolean;
    gatePolicyHash: string | null;
    authorizationHash: string | null;
    authorizationBuilt: boolean;
    repositoryWritePerformed: false;
    gitMutationPerformed: false;
    mutationApplied: false;
    rollbackExecuted: false;
    consumptionRegistryWritten: false;
  };
};

export type ControlledApplyExecutionAuthorizationVerificationInput = {
  authorization: ControlledApplyExecutionAuthorization;
  gateInput: ControlledApplyExecutionGateInput;
};

export type ControlledApplyExecutionAuthorizationVerificationDecision =
  | "controlled_apply_execution_authorization_current"
  | "controlled_apply_execution_authorization_stale"
  | "controlled_apply_execution_authorization_consumed"
  | "controlled_apply_execution_authorization_invalid";

export type ControlledApplyExecutionAuthorizationVerificationResult = {
  decision: ControlledApplyExecutionAuthorizationVerificationDecision;
  authorizationIntegrityVerified: boolean;
  currentGateDecision: ControlledApplyExecutionGateDecision | null;
  currentAuthorizationHash: string | null;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  firstWriteEligible: boolean;
  summary: {
    governedArtifactMatched: boolean;
    handoffMatched: boolean;
    consumptionKeyMatched: boolean;
    mutationMatched: boolean;
    changedFilesMatched: boolean;
    repositoryTargetMatched: boolean;
    expectedInspectionMatched: boolean;
    currentInspectionMatched: boolean;
    rollbackBundleMatched: boolean;
    rollbackCoverageMatched: boolean;
    gatePolicyMatched: boolean;
    consumptionStatusKnown: boolean;
    consumptionAvailable: boolean;
    currentGateReady: boolean;
    repositoryWritePerformed: false;
    gitMutationPerformed: false;
    mutationApplied: false;
  };
};

type PlainRecord = Record<string, unknown>;
type GateSummary = ControlledApplyExecutionGateResult["summary"];
type VerificationSummary = ControlledApplyExecutionAuthorizationVerificationResult["summary"];
type DecisionKind = "ready" | "blocked" | "review" | "invalid";

const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_NODES = 500_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

const INPUT_FIELDS = [
  "repositoryPath", "bundleDirectoryPath", "changedFiles", "artifact",
  "currentFreshnessSnapshot", "mutation", "handoff", "expectedInspection",
  "rollbackBundleManifest", "rollbackBundleReceipt", "consumptionStatus", "policy",
  "timeoutMs", "maxGitOutputBytes", "maxEntryBytes", "maxBundleBytes"
] as const;
const REQUIRED_INPUT_FIELDS = INPUT_FIELDS.filter((field) => ![
  "policy", "timeoutMs", "maxGitOutputBytes", "maxEntryBytes", "maxBundleBytes"
].includes(field));
const POLICY_FIELDS = Object.keys(STRICT_POLICY).sort();
const INSPECTION_FIELDS = [
  "inspectionVersion", "target", "worktree", "rollbackManifest", "inspectionHash"
] as const;
const TARGET_FIELDS = [
  "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash"
] as const;
const WORKTREE_FIELDS = [
  "clean", "stagedChangeCount", "unstagedChangeCount", "untrackedFileCount",
  "conflictedFileCount", "changedPaths", "mergeInProgress", "rebaseInProgress",
  "cherryPickInProgress", "revertInProgress", "bisectInProgress"
] as const;
const ROLLBACK_MANIFEST_FIELDS = [
  "manifestVersion", "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash",
  "changedFiles", "files", "restorationPolicy", "manifestHash"
] as const;
const RESTORATION_FIELDS = [
  "restoreTrackedFilesFromBaseObjects", "removeFilesOriginallyAbsent",
  "restoreExecutableModes", "restoreSymlinksWithoutFollowingTargets",
  "restoreGitlinksWithoutEnteringSubmodules", "rejectWritesOutsideChangedFiles",
  "validateRestoredWorktreeState"
] as const;
const ROLLBACK_FILE_FIELDS = [
  "filePath", "baselineState", "baseObjectId", "baseMode", "existsInWorktree",
  "worktreeEntryKind", "worktreeContentHash"
] as const;
const AUTH_FIELDS = [
  "authorizationVersion", "governedArtifactHash", "handoffHash", "consumptionKey",
  "mutation", "target", "evidence", "adminResolution", "preconditions",
  "executorRequirements", "gatePolicyHash", "authorizationHash"
] as const;
const AUTH_MUTATION_FIELDS = [
  "changeKind", "mutationHash", "changedFiles", "changedFileCount"
] as const;
const AUTH_EVIDENCE_FIELDS = [
  "currentSnapshotHash", "expectedInspectionHash", "currentInspectionHash",
  "rollbackManifestHash", "rollbackBundleManifestHash", "rollbackBundleReceiptHash",
  "rollbackPayloadRootHash", "rollbackCoverageHash", "constraintsHash", "gatePolicyHash"
] as const;
const AUTH_ADMIN_FIELDS = [
  "invocationPolicyHash", "invocationAssessmentHash", "invocationDecision",
  "resolutionKind", "adminDecisionHash"
] as const;
const AUTH_PRECONDITION_FIELDS = [
  "artifactCurrent", "artifactApplyEligible", "handoffCurrent",
  "handoffExecutionEligible", "repositoryInspectionReady", "repositoryClean",
  "repositoryOperationAbsent", "repositoryTargetMatched", "rollbackBundleCurrent",
  "rollbackBundleUsable", "rollbackCoverageComplete", "mutationMatched",
  "changedFilesMatched", "consumptionStatusNotConsumed"
] as const;
const AUTH_EXECUTOR_FIELDS = [
  "reverifyAuthorizationImmediatelyBeforeFirstWrite",
  "recheckConsumptionRegistryBeforeFirstWrite",
  "reserveOrConsumeKeyAtomicallyWithExecution", "recheckRepositoryStateBeforeFirstWrite",
  "restrictWritesToChangedFiles", "rejectAdditionalFileWrites",
  "useVerifiedRollbackBundle", "validateAfterApply", "rollbackOnApplyOrValidationFailure",
  "produceApplyReceipt"
] as const;
const VERIFY_INPUT_FIELDS = ["authorization", "gateInput"] as const;

class GateFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: Exclude<DecisionKind, "ready"> = "invalid",
    readonly field?: string,
    readonly filePath?: string,
    readonly hashValue?: string
  ) {
    super(message);
  }
}

class TrustedGateConfigurationError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  nodes = { count: 0 }
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Unsupported gate evidence value."
    );
  }
  nodes.count += 1;
  if (nodes.count > MAX_NODES) {
    throw new GateFailure(
      "controlled_apply_execution_gate_structure_bound_exceeded",
      "Gate evidence exceeds the bounded structure limit.", "review"
    );
  }
  if (ancestors.has(value)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Cyclic gate evidence is invalid."
    );
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Exotic gate evidence is invalid."
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GateFailure(
      "controlled_apply_execution_gate_symbol_property", "Symbol fields are invalid."
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  try {
    if (array) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw new GateFailure(
            "controlled_apply_execution_gate_accessor_property",
            "Sparse or accessor arrays are invalid."
          );
        }
        output.push(safeClone(descriptor.value, ancestors, nodes));
      }
      const allowed = new Set(["length", ...output.map((_, index) => String(index))]);
      if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
        throw new GateFailure(
          "unknown_controlled_apply_execution_gate_field", "Unknown array fields are invalid."
        );
      }
      return output;
    }
    const output: PlainRecord = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        throw new GateFailure(
          "controlled_apply_execution_gate_accessor_property", "Accessor fields are invalid."
        );
      }
      output[key] = safeClone(descriptor.value, ancestors, nodes);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
  required: readonly string[] = fields
): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", `${label} must be an exact object.`
    );
  }
  const record = value as PlainRecord;
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown) {
    throw new GateFailure(
      "unknown_controlled_apply_execution_gate_field", `${label} has an unknown field.`,
      "invalid", unknown
    );
  }
  const missing = required.find((field) => !Object.prototype.hasOwnProperty.call(record, field));
  if (missing) {
    throw new GateFailure(
      "missing_controlled_apply_execution_gate_field", `${label} is missing a field.`,
      "invalid", missing
    );
  }
  return record;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "A required evidence hash is invalid.",
      "invalid", field
    );
  }
  return value;
}

function normalizeFiles(value: unknown, field = "changedFiles"): string[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((file) =>
    typeof file !== "string" || file.length === 0 || file.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(file))) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Changed-file evidence is invalid.",
      "invalid", field
    );
  }
  return sortedUnique(value);
}

function normalizePolicy(value: unknown): Readonly<ControlledApplyExecutionGatePolicy> {
  if (value === undefined) return DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY;
  let cloned: unknown;
  try {
    cloned = safeClone(value);
  } catch {
    throw new TrustedGateConfigurationError("controlled_apply_execution_gate_policy_invalid");
  }
  let record: PlainRecord;
  try {
    record = exactObject(cloned, POLICY_FIELDS, "Execution-gate policy");
  } catch {
    throw new TrustedGateConfigurationError("controlled_apply_execution_gate_policy_invalid");
  }
  if (!canonicalEqual(record, STRICT_POLICY)) {
    throw new TrustedGateConfigurationError(
      "controlled_apply_execution_gate_policy_relaxation_forbidden"
    );
  }
  return deepFreeze({ ...STRICT_POLICY });
}

function numeric(
  record: PlainRecord,
  field: string,
  defaultValue: number,
  maximum: number
): number {
  const value = record[field] === undefined ? defaultValue : record[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TrustedGateConfigurationError(`${field} is outside the trusted bound.`);
  }
  return value as number;
}

function initialSummary(): GateSummary {
  return {
    inputValid: false, policyValid: false,
    artifactIntegrityVerified: false, artifactCurrent: false, artifactApplyEligible: false,
    mutationValid: false, mutationMatched: false, changedFilesMatched: false,
    handoffIntegrityVerified: false, handoffCurrent: false, handoffExecutionEligible: false,
    repositoryReinspected: false, repositoryInspectionReady: false,
    repositoryClean: false, repositoryOperationInProgress: false,
    repositoryIdentityMatched: false, baseRevisionMatched: false,
    worktreeStateMatched: false, expectedInspectionMatched: false,
    rollbackBundleVerified: false, rollbackBundleCurrent: false,
    rollbackBundleUsable: false, rollbackCoverageComplete: false,
    rollbackCoverageEntryCount: 0, rollbackCoverageHash: null,
    consumptionStatus: "unknown", consumptionAvailable: false,
    gatePolicyHash: null, authorizationHash: null, authorizationBuilt: false,
    repositoryWritePerformed: false, gitMutationPerformed: false,
    mutationApplied: false, rollbackExecuted: false, consumptionRegistryWritten: false
  };
}

function initialVerificationSummary(): VerificationSummary {
  return {
    governedArtifactMatched: false, handoffMatched: false,
    consumptionKeyMatched: false, mutationMatched: false, changedFilesMatched: false,
    repositoryTargetMatched: false, expectedInspectionMatched: false,
    currentInspectionMatched: false, rollbackBundleMatched: false,
    rollbackCoverageMatched: false, gatePolicyMatched: false,
    consumptionStatusKnown: false, consumptionAvailable: false,
    currentGateReady: false, repositoryWritePerformed: false,
    gitMutationPerformed: false, mutationApplied: false
  };
}

function issueFromFailure(failure: GateFailure): ControlledApplyExecutionGateIssue {
  return {
    code: failure.code,
    message: failure.message,
    severity: failure.kind === "review" ? "review" : "error",
    ...(failure.field ? { field: failure.field } : {}),
    ...(failure.filePath ? { filePath: failure.filePath } : {}),
    ...(failure.hashValue ? { hashValue: failure.hashValue } : {})
  };
}

function decisionFor(kind: DecisionKind): ControlledApplyExecutionGateDecision {
  return {
    ready: "controlled_apply_execution_gate_ready",
    blocked: "controlled_apply_execution_gate_blocked",
    review: "controlled_apply_execution_gate_needs_review",
    invalid: "controlled_apply_execution_gate_invalid"
  }[kind] as ControlledApplyExecutionGateDecision;
}

function finishGate(
  kind: DecisionKind,
  issues: ControlledApplyExecutionGateIssue[],
  authorization: ControlledApplyExecutionAuthorization | null,
  repositoryInspection: ControlledRepositoryInspectionResult | null,
  rollbackBundleVerification: ControlledRollbackBundleVerificationResult | null,
  summary: GateSummary
): ControlledApplyExecutionGateResult {
  return deepFreeze({
    decision: decisionFor(kind), issues, authorization, repositoryInspection,
    rollbackBundleVerification, summary
  });
}

function validateExpectedInspection(value: unknown): ControlledRepositoryInspection {
  const inspection = exactObject(value, INSPECTION_FIELDS, "Expected repository inspection");
  exactObject(inspection.target, TARGET_FIELDS, "Expected inspection target");
  exactObject(inspection.worktree, WORKTREE_FIELDS, "Expected inspection worktree");
  const manifest = exactObject(
    inspection.rollbackManifest, ROLLBACK_MANIFEST_FIELDS, "Expected rollback manifest"
  );
  exactObject(manifest.restorationPolicy, RESTORATION_FIELDS, "Expected restoration policy");
  if (!Array.isArray(manifest.files)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Expected rollback files are invalid."
    );
  }
  for (const file of manifest.files) {
    exactObject(file, ROLLBACK_FILE_FIELDS, "Expected rollback file");
  }
  const manifestHash = requireHash(manifest.manifestHash, "rollbackManifest.manifestHash");
  const manifestMaterial = { ...manifest };
  delete manifestMaterial.manifestHash;
  if (hashCanonicalJson(manifestMaterial) !== manifestHash) {
    throw new GateFailure(
      "controlled_apply_execution_expected_inspection_mismatch",
      "The expected rollback manifest integrity check failed."
    );
  }
  const inspectionHash = requireHash(inspection.inspectionHash, "inspectionHash");
  const inspectionMaterial = { ...inspection };
  delete inspectionMaterial.inspectionHash;
  if (hashCanonicalJson(inspectionMaterial) !== inspectionHash) {
    throw new GateFailure(
      "controlled_apply_execution_expected_inspection_mismatch",
      "The expected repository inspection integrity check failed."
    );
  }
  return inspection as unknown as ControlledRepositoryInspection;
}

function targetEqual(left: unknown, right: unknown): boolean {
  return canonicalEqual(left, right);
}

function inspectionEqual(
  expected: ControlledRepositoryInspection,
  current: ControlledRepositoryInspection
): boolean {
  return targetEqual(expected.target, current.target) &&
    canonicalEqual(expected.rollbackManifest.changedFiles,
      current.rollbackManifest.changedFiles) &&
    canonicalEqual(expected.rollbackManifest.files, current.rollbackManifest.files) &&
    expected.rollbackManifest.manifestHash === current.rollbackManifest.manifestHash &&
    expected.inspectionHash === current.inspectionHash;
}

function coverageFor(
  manifest: ControlledRollbackBundleManifest,
  changedFiles: readonly string[]
): { entries: ControlledApplyRollbackCoverageEntry[]; hash: string; complete: boolean } {
  if (!Array.isArray(manifest.entries)) {
    throw new GateFailure(
      "controlled_apply_execution_rollback_coverage_invalid",
      "Rollback coverage entries are invalid."
    );
  }
  const supported = new Set<ControlledRollbackAction>([
    "restore_regular_file", "restore_symlink", "remove_path"
  ]);
  const entries: ControlledApplyRollbackCoverageEntry[] = [];
  for (const raw of manifest.entries) {
    const action = raw.rollbackAction;
    if (!supported.has(action)) {
      throw new GateFailure(
        "controlled_apply_execution_rollback_action_unsupported",
        "The rollback action requires bounded review.", "review"
      );
    }
    const payloadRequired = action !== "remove_path";
    const payloadAvailable = payloadRequired ?
      typeof raw.payloadObjectHash === "string" && HASH.test(raw.payloadObjectHash) :
      raw.payloadObjectHash === null && raw.payloadBytes === 0;
    entries.push({
      filePath: raw.filePath,
      rollbackAction: action,
      payloadRequired,
      payloadAvailable,
      baseMode: raw.baseMode,
      payloadObjectHash: raw.payloadObjectHash
    });
  }
  entries.sort((left, right) => left.filePath < right.filePath ? -1 :
    left.filePath > right.filePath ? 1 : 0);
  const entryFiles = entries.map((entry) => entry.filePath);
  const uniqueFiles = sortedUnique(entryFiles);
  let complete = uniqueFiles.length === entries.length &&
    canonicalEqual(uniqueFiles, changedFiles);
  for (const entry of entries) {
    if (entry.rollbackAction === "restore_regular_file") {
      complete = complete && entry.payloadRequired && entry.payloadAvailable &&
        (entry.baseMode === "100644" || entry.baseMode === "100755") &&
        entry.payloadObjectHash !== null && HASH.test(entry.payloadObjectHash);
    } else if (entry.rollbackAction === "restore_symlink") {
      complete = complete && entry.payloadRequired && entry.payloadAvailable &&
        entry.baseMode === "120000" && entry.payloadObjectHash !== null &&
        HASH.test(entry.payloadObjectHash);
    } else {
      complete = complete && !entry.payloadRequired && entry.payloadAvailable &&
        entry.baseMode === null && entry.payloadObjectHash === null;
    }
  }
  return {
    entries,
    hash: hashCanonicalJson({
      artifactType: "controlled_apply_rollback_coverage",
      entries
    }),
    complete
  };
}

function adminResolutionValid(artifact: GovernedChangeArtifact): boolean {
  const decisions = artifact.decisions;
  const evidence = artifact.evidence;
  return decisions.adminInvocationDecision === "admin_invocation_skipped"
    ? decisions.adminResolutionKind === "verified_policy_skip" &&
      evidence.adminDecisionHash === null
    : decisions.adminInvocationDecision === "admin_invocation_required" &&
      decisions.adminResolutionKind === "model_decision" &&
      evidence.adminDecisionHash !== null;
}

const EXECUTOR_REQUIREMENTS = {
  reverifyAuthorizationImmediatelyBeforeFirstWrite: true,
  recheckConsumptionRegistryBeforeFirstWrite: true,
  reserveOrConsumeKeyAtomicallyWithExecution: true,
  recheckRepositoryStateBeforeFirstWrite: true,
  restrictWritesToChangedFiles: true,
  rejectAdditionalFileWrites: true,
  useVerifiedRollbackBundle: true,
  validateAfterApply: true,
  rollbackOnApplyOrValidationFailure: true,
  produceApplyReceipt: true
} as const;

function buildAuthorization(
  artifact: GovernedChangeArtifact,
  handoff: ControlledApplyHandoffPlan,
  changedFiles: readonly string[],
  currentSnapshotHash: string,
  expectedInspection: ControlledRepositoryInspection,
  currentInspection: ControlledRepositoryInspection,
  manifest: ControlledRollbackBundleManifest,
  receipt: ControlledRollbackBundleReceipt,
  coverageHash: string,
  gatePolicyHash: string
): ControlledApplyExecutionAuthorization {
  const withoutHash = {
    authorizationVersion: "1" as const,
    governedArtifactHash: artifact.governedArtifactHash,
    handoffHash: handoff.handoffHash,
    consumptionKey: handoff.singleUse.consumptionKey,
    mutation: {
      changeKind: artifact.change.changeKind,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...changedFiles],
      changedFileCount: changedFiles.length
    },
    target: { ...handoff.target },
    evidence: {
      currentSnapshotHash,
      expectedInspectionHash: expectedInspection.inspectionHash,
      currentInspectionHash: currentInspection.inspectionHash,
      rollbackManifestHash: currentInspection.rollbackManifest.manifestHash,
      rollbackBundleManifestHash: manifest.bundleManifestHash,
      rollbackBundleReceiptHash: receipt.receiptHash,
      rollbackPayloadRootHash: manifest.payloadRootHash,
      rollbackCoverageHash: coverageHash,
      constraintsHash: handoff.constraintsHash,
      gatePolicyHash
    },
    adminResolution: {
      invocationPolicyHash: artifact.evidence.adminInvocationPolicyHash,
      invocationAssessmentHash: artifact.evidence.adminInvocationAssessmentHash,
      invocationDecision: artifact.decisions.adminInvocationDecision,
      resolutionKind: artifact.decisions.adminResolutionKind,
      adminDecisionHash: artifact.evidence.adminDecisionHash
    },
    preconditions: {
      artifactCurrent: true as const,
      artifactApplyEligible: true as const,
      handoffCurrent: true as const,
      handoffExecutionEligible: true as const,
      repositoryInspectionReady: true as const,
      repositoryClean: true as const,
      repositoryOperationAbsent: true as const,
      repositoryTargetMatched: true as const,
      rollbackBundleCurrent: true as const,
      rollbackBundleUsable: true as const,
      rollbackCoverageComplete: true as const,
      mutationMatched: true as const,
      changedFilesMatched: true as const,
      consumptionStatusNotConsumed: true as const
    },
    executorRequirements: EXECUTOR_REQUIREMENTS,
    gatePolicyHash
  };
  return {
    ...withoutHash,
    authorizationHash: hashCanonicalJson(withoutHash)
  };
}

export async function evaluateControlledApplyExecutionGate(
  input: ControlledApplyExecutionGateInput
): Promise<ControlledApplyExecutionGateResult> {
  const summary = initialSummary();
  const issues: ControlledApplyExecutionGateIssue[] = [];
  let repositoryInspection: ControlledRepositoryInspectionResult | null = null;
  let rollbackVerification: ControlledRollbackBundleVerificationResult | null = null;
  try {
    const cloned = safeClone(input);
    const top = exactObject(
      cloned, INPUT_FIELDS, "Controlled apply execution gate input", REQUIRED_INPUT_FIELDS
    );
    summary.inputValid = true;
    const policy = normalizePolicy(top.policy);
    summary.policyValid = true;
    const gatePolicyHash = hashCanonicalJson(policy);
    summary.gatePolicyHash = gatePolicyHash;
    const timeoutMs = numeric(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxGitOutputBytes = numeric(
      top, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    const maxEntryBytes = numeric(top, "maxEntryBytes", DEFAULT_ENTRY_BYTES, MAX_ENTRY_BYTES);
    const maxBundleBytes = numeric(
      top, "maxBundleBytes", DEFAULT_BUNDLE_BYTES, MAX_BUNDLE_BYTES
    );
    if (typeof top.repositoryPath !== "string" ||
        typeof top.bundleDirectoryPath !== "string") {
      throw new GateFailure(
        "invalid_controlled_apply_execution_gate_input", "Gate paths are invalid."
      );
    }
    if (top.consumptionStatus !== "not_consumed" &&
        top.consumptionStatus !== "already_consumed" &&
        top.consumptionStatus !== "unknown") {
      throw new GateFailure(
        "invalid_controlled_apply_execution_gate_input", "Consumption status is invalid.",
        "invalid", "consumptionStatus"
      );
    }
    summary.consumptionStatus = top.consumptionStatus;
    summary.consumptionAvailable = top.consumptionStatus === "not_consumed";
    const inputFiles = normalizeFiles(top.changedFiles);
    const artifact = top.artifact as GovernedChangeArtifact;
    const snapshot = top.currentFreshnessSnapshot as GovernedChangeFreshnessSnapshot;
    const mutation = top.mutation as WorkspaceMutation;
    const handoff = top.handoff as ControlledApplyHandoffPlan;
    const expectedInspection = validateExpectedInspection(top.expectedInspection);
    const manifest = top.rollbackBundleManifest as ControlledRollbackBundleManifest;
    const receipt = top.rollbackBundleReceipt as ControlledRollbackBundleReceipt;
    let pendingBlocked: GateFailure | null = null;
    if (top.consumptionStatus === "already_consumed") {
      pendingBlocked = new GateFailure(
        "controlled_apply_execution_consumption_key_already_used",
        "The external consumption key has already been used.", "blocked"
      );
    } else if (top.consumptionStatus === "unknown") {
      pendingBlocked = new GateFailure(
        "controlled_apply_execution_consumption_status_unknown",
        "The external consumption status is unknown.", "blocked"
      );
    }

    if (artifact.artifactVersion !== "2") {
      throw new GateFailure(
        "controlled_apply_execution_artifact_version_unsupported",
        "The governed artifact version is unsupported."
      );
    }
    const freshness = verifyGovernedChangeArtifactFreshness(artifact, snapshot);
    summary.artifactIntegrityVerified = freshness.artifactIntegrityVerified;
    summary.artifactCurrent = freshness.decision === "governed_change_current";
    summary.artifactApplyEligible = freshness.summary.artifactApplyEligible;
    if (!freshness.artifactIntegrityVerified ||
        freshness.decision === "governed_change_freshness_invalid") {
      throw new GateFailure(
        "controlled_apply_execution_artifact_invalid", "The governed artifact is invalid."
      );
    }
    if (snapshot.adminInvocationPolicyHash !==
          artifact.evidence.adminInvocationPolicyHash ||
        snapshot.adminInvocationAssessmentHash !==
          artifact.evidence.adminInvocationAssessmentHash) {
      throw new GateFailure(
        "controlled_apply_execution_admin_invocation_binding_mismatch",
        "The Admin invocation evidence binding is inconsistent."
      );
    }
    if (freshness.decision !== "governed_change_current") {
      pendingBlocked = new GateFailure(
        "controlled_apply_execution_artifact_stale", "The governed artifact is stale.",
        "blocked"
      );
    }
    if (!freshness.handoffEligible || !artifact.applyEligibility.eligible) {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_artifact_not_eligible",
        "The governed artifact is not apply eligible.", "blocked"
      );
    }
    if (!adminResolutionValid(artifact)) {
      throw new GateFailure(
        "controlled_apply_execution_admin_resolution_binding_mismatch",
        "The Admin resolution binding is invalid."
      );
    }

    let mutationHash: string;
    let mutationFiles: readonly string[];
    try {
      mutationHash = computeGovernedMutationHash(artifact.change.changeKind, mutation);
      mutationFiles = deriveGovernedMutationChangedFiles(mutation);
      summary.mutationValid = true;
    } catch {
      throw new GateFailure(
        "controlled_apply_execution_mutation_invalid", "The governed mutation is invalid."
      );
    }
    summary.mutationMatched = mutationHash === artifact.change.mutationHash &&
      mutationHash === handoff.mutation.mutationHash &&
      mutationHash === manifest.mutation?.mutationHash &&
      handoff.mutation.changeKind === artifact.change.changeKind &&
      manifest.mutation?.changeKind === artifact.change.changeKind;
    if (!summary.mutationMatched) {
      throw new GateFailure(
        "controlled_apply_execution_mutation_hash_mismatch",
        "The mutation hash binding is inconsistent."
      );
    }
    summary.changedFilesMatched = [
      inputFiles, artifact.change.changedFiles, handoff.mutation.changedFiles,
      expectedInspection.rollbackManifest.changedFiles, manifest.mutation?.changedFiles
    ].every((files) => canonicalEqual(mutationFiles, files));
    if (!summary.changedFilesMatched) {
      throw new GateFailure(
        "controlled_apply_execution_changed_files_mismatch",
        "The changed-file binding is inconsistent."
      );
    }

    const preliminaryHandoff = verifyControlledApplyHandoff({
      handoff, artifact, currentFreshnessSnapshot: snapshot, mutation,
      currentTarget: expectedInspection.target,
      consumptionStatus: top.consumptionStatus
    });
    summary.handoffIntegrityVerified = preliminaryHandoff.handoffIntegrityVerified;
    summary.handoffCurrent = preliminaryHandoff.decision ===
      "controlled_apply_handoff_current";
    summary.handoffExecutionEligible = preliminaryHandoff.executionEligible;
    if (preliminaryHandoff.decision === "controlled_apply_handoff_verification_invalid" &&
        top.consumptionStatus !== "unknown") {
      throw new GateFailure(
        "controlled_apply_execution_handoff_invalid", "The controlled handoff is invalid."
      );
    }
    if (!summary.handoffCurrent || !summary.handoffExecutionEligible) {
      pendingBlocked ??= new GateFailure(
        preliminaryHandoff.decision === "controlled_apply_handoff_stale"
          ? "controlled_apply_execution_handoff_stale"
          : "controlled_apply_execution_handoff_not_execution_eligible",
        "The controlled handoff is not execution eligible.", "blocked"
      );
    }

    const manifestMaterial = { ...manifest } as Partial<ControlledRollbackBundleManifest>;
    delete manifestMaterial.bundleManifestHash;
    const receiptMaterial = { ...receipt } as Partial<ControlledRollbackBundleReceipt>;
    delete receiptMaterial.receiptHash;
    if (manifest.bundleVersion !== "1" || receipt.bundleVersion !== "1" ||
        !HASH.test(manifest.bundleManifestHash) ||
        hashCanonicalJson(manifestMaterial) !== manifest.bundleManifestHash ||
        !HASH.test(receipt.receiptHash) ||
        hashCanonicalJson(receiptMaterial) !== receipt.receiptHash) {
      throw new GateFailure(
        "controlled_apply_execution_rollback_bundle_invalid",
        "The supplied rollback bundle evidence is invalid."
      );
    }
    if (manifest.consumptionKey !== handoff.singleUse.consumptionKey ||
        receipt.consumptionKey !== handoff.singleUse.consumptionKey) {
      throw new GateFailure(
        "controlled_apply_execution_consumption_key_mismatch",
        "The rollback consumption-key binding is inconsistent."
      );
    }
    if (Array.isArray(manifest.entries) && manifest.entries.some((entry) =>
      !new Set(["restore_regular_file", "restore_symlink", "remove_path"])
        .has(entry.rollbackAction))) {
      throw new GateFailure(
        "controlled_apply_execution_rollback_action_unsupported",
        "The rollback action requires bounded review.", "review"
      );
    }
    const coverage = coverageFor(manifest, mutationFiles);
    summary.rollbackCoverageEntryCount = coverage.entries.length;
    summary.rollbackCoverageHash = coverage.hash;
    summary.rollbackCoverageComplete = coverage.complete;
    if (!coverage.complete) {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_rollback_coverage_incomplete",
        "Rollback coverage is incomplete.", "blocked"
      );
    }

    if (coverage.complete) {
      rollbackVerification = await verifyControlledRollbackBundle({
        bundleDirectoryPath: top.bundleDirectoryPath,
        expectedManifest: manifest,
        expectedReceipt: receipt,
        expectedHandoffHash: handoff.handoffHash,
        expectedConsumptionKey: handoff.singleUse.consumptionKey,
        expectedInspectionHash: expectedInspection.inspectionHash,
        maxEntryBytes,
        maxBundleBytes
      });
      summary.rollbackBundleVerified = rollbackVerification.manifestIntegrityVerified &&
        rollbackVerification.receiptIntegrityVerified &&
        rollbackVerification.payloadRootVerified &&
        rollbackVerification.payloadObjectsVerified &&
        rollbackVerification.expectedBindingsMatched;
      summary.rollbackBundleCurrent = rollbackVerification.decision === "rollback_bundle_current";
      summary.rollbackBundleUsable = rollbackVerification.rollbackUsable;
      if (rollbackVerification.decision === "rollback_bundle_invalid") {
        throw new GateFailure(
          "controlled_apply_execution_rollback_bundle_invalid",
          "The physical rollback bundle is invalid."
        );
      }
      if (rollbackVerification.decision !== "rollback_bundle_current") {
        pendingBlocked ??= new GateFailure(
          "controlled_apply_execution_rollback_bundle_stale",
          "The physical rollback bundle is stale.", "blocked"
        );
      }
      if (!summary.rollbackBundleUsable || !summary.rollbackBundleVerified) {
        pendingBlocked ??= new GateFailure(
          "controlled_apply_execution_rollback_bundle_not_usable",
          "The physical rollback bundle is not usable.", "blocked"
        );
      }
    }

    repositoryInspection = await inspectControlledRepository({
      repositoryPath: top.repositoryPath,
      changedFiles: inputFiles,
      expectedTarget: handoff.target,
      handoff,
      artifact,
      currentFreshnessSnapshot: snapshot,
      mutation,
      consumptionStatus: top.consumptionStatus,
      timeoutMs,
      maxGitOutputBytes
    });
    summary.repositoryReinspected = true;
    summary.repositoryInspectionReady =
      repositoryInspection.decision === "repository_inspection_ready";
    summary.repositoryClean = repositoryInspection.summary.worktreeClean;
    summary.repositoryOperationInProgress =
      repositoryInspection.summary.repositoryOperationInProgress;
    summary.handoffIntegrityVerified =
      repositoryInspection.handoffVerification?.handoffIntegrityVerified ?? false;
    summary.handoffCurrent = repositoryInspection.handoffVerification?.decision ===
      "controlled_apply_handoff_current";
    summary.handoffExecutionEligible =
      repositoryInspection.handoffVerification?.executionEligible ?? false;
    if (top.consumptionStatus === "already_consumed") {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_consumption_key_already_used",
        "The external consumption key has already been used.", "blocked"
      );
    }
    if (top.consumptionStatus === "unknown") {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_consumption_status_unknown",
        "The external consumption status is unknown.", "blocked"
      );
    }
    if (repositoryInspection.handoffVerification?.decision ===
        "controlled_apply_handoff_verification_invalid" &&
        top.consumptionStatus !== "unknown") {
      throw new GateFailure(
        "controlled_apply_execution_handoff_invalid", "The controlled handoff is invalid."
      );
    }
    if (repositoryInspection.handoffVerification?.decision ===
        "controlled_apply_handoff_stale") {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_handoff_stale", "The controlled handoff is stale.",
        "blocked"
      );
    }
    if (repositoryInspection.handoffVerification !== null &&
        !repositoryInspection.handoffVerification.executionEligible) {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_handoff_not_execution_eligible",
        "The controlled handoff is not execution eligible.", "blocked"
      );
    }
    if (repositoryInspection.decision === "repository_inspection_invalid") {
      throw new GateFailure(
        "controlled_apply_execution_repository_reinspection_failed",
        "The repository reinspection is invalid."
      );
    }
    if (repositoryInspection.decision === "repository_inspection_needs_review") {
      throw new GateFailure(
        "controlled_apply_execution_repository_not_ready",
        "The repository reinspection requires review.", "review"
      );
    }
    if (repositoryInspection.decision !== "repository_inspection_ready" ||
        repositoryInspection.inspection === null) {
      const code = summary.repositoryOperationInProgress
        ? "controlled_apply_execution_repository_operation_in_progress"
        : !summary.repositoryClean
          ? "controlled_apply_execution_repository_dirty"
          : "controlled_apply_execution_repository_not_ready";
      pendingBlocked ??= new GateFailure(
        code, "The repository is not ready for controlled apply.", "blocked"
      );
      if (repositoryInspection.inspection === null) throw pendingBlocked;
    }
    const currentInspection = repositoryInspection.inspection;
    const directHandoff = verifyControlledApplyHandoff({
      handoff, artifact, currentFreshnessSnapshot: snapshot, mutation,
      currentTarget: currentInspection.target,
      consumptionStatus: top.consumptionStatus
    });
    summary.handoffIntegrityVerified = directHandoff.handoffIntegrityVerified;
    summary.handoffCurrent = directHandoff.decision === "controlled_apply_handoff_current";
    summary.handoffExecutionEligible = directHandoff.executionEligible;
    if (directHandoff.decision === "controlled_apply_handoff_verification_invalid" &&
        top.consumptionStatus !== "unknown") {
      throw new GateFailure(
        "controlled_apply_execution_handoff_invalid", "The controlled handoff is invalid."
      );
    }
    if (!summary.handoffCurrent || !summary.handoffExecutionEligible) {
      const code = directHandoff.decision === "controlled_apply_handoff_stale"
        ? "controlled_apply_execution_handoff_stale"
        : "controlled_apply_execution_handoff_not_execution_eligible";
      pendingBlocked ??= new GateFailure(
        code, "The controlled handoff is not execution eligible.", "blocked"
      );
    }

    summary.repositoryIdentityMatched =
      currentInspection.target.repositoryIdentityHash === handoff.target.repositoryIdentityHash;
    summary.baseRevisionMatched =
      currentInspection.target.baseRevisionHash === handoff.target.baseRevisionHash;
    summary.worktreeStateMatched =
      currentInspection.target.worktreeStateHash === handoff.target.worktreeStateHash;
    if (!summary.repositoryIdentityMatched) pendingBlocked ??= new GateFailure(
      "controlled_apply_execution_repository_identity_mismatch",
      "The repository identity changed.", "blocked"
    );
    if (!summary.baseRevisionMatched) pendingBlocked ??= new GateFailure(
      "controlled_apply_execution_base_revision_mismatch", "The base revision changed.", "blocked"
    );
    if (!summary.worktreeStateMatched) pendingBlocked ??= new GateFailure(
      "controlled_apply_execution_worktree_state_mismatch",
      "The worktree state changed.", "blocked"
    );
    summary.expectedInspectionMatched = inspectionEqual(expectedInspection, currentInspection);
    if (!summary.expectedInspectionMatched) {
      pendingBlocked ??= new GateFailure(
        "controlled_apply_execution_expected_inspection_mismatch",
        "The current repository no longer matches the expected inspection.", "blocked"
      );
    }

    const targetsMatched = [expectedInspection.target, manifest.target]
      .every((target) => targetEqual(handoff.target, target));
    const inspectionBindingsMatched =
      manifest.inspectionHash === expectedInspection.inspectionHash &&
      receipt.inspectionHash === expectedInspection.inspectionHash &&
      manifest.rollbackManifestHash === expectedInspection.rollbackManifest.manifestHash &&
      receipt.bundleManifestHash === manifest.bundleManifestHash &&
      receipt.payloadRootHash === manifest.payloadRootHash;
    const handoffBindingsMatched =
      handoff.evidence.governedArtifactHash === artifact.governedArtifactHash &&
      manifest.governedArtifactHash === artifact.governedArtifactHash &&
      handoff.handoffHash === manifest.handoffHash &&
      handoff.handoffHash === receipt.handoffHash &&
      handoff.singleUse.consumptionKey === manifest.consumptionKey &&
      handoff.singleUse.consumptionKey === receipt.consumptionKey;
    if (!targetsMatched || !inspectionBindingsMatched || !handoffBindingsMatched) {
      throw new GateFailure(
        "controlled_apply_execution_handoff_invalid",
        "Cross-evidence state bindings are inconsistent."
      );
    }
    if (pendingBlocked !== null) throw pendingBlocked;
    const currentSnapshotHash = freshness.currentSnapshotHash;
    if (currentSnapshotHash === null) {
      throw new GateFailure(
        "controlled_apply_execution_gate_hash_failure",
        "The current freshness snapshot hash is unavailable."
      );
    }
    const authorization = buildAuthorization(
      artifact, handoff, mutationFiles, currentSnapshotHash, expectedInspection,
      currentInspection, manifest, receipt, coverage.hash, gatePolicyHash
    );
    summary.authorizationHash = authorization.authorizationHash;
    summary.authorizationBuilt = true;
    return finishGate(
      "ready", issues, authorization, repositoryInspection, rollbackVerification, summary
    );
  } catch (error) {
    if (error instanceof TrustedGateConfigurationError) throw error;
    const failure = error instanceof GateFailure ? error : new GateFailure(
      "controlled_apply_execution_gate_exception",
      "Execution-gate evaluation failed without exposing unbounded details."
    );
    issues.push(issueFromFailure(failure));
    return finishGate(
      failure.kind, issues, null, repositoryInspection, rollbackVerification, summary
    );
  }
}

function validateAuthorization(value: unknown): ControlledApplyExecutionAuthorization {
  const cloned = safeClone(value);
  const authorization = exactObject(cloned, AUTH_FIELDS, "Execution authorization");
  const mutation = exactObject(
    authorization.mutation, AUTH_MUTATION_FIELDS, "Authorization mutation"
  );
  exactObject(authorization.target, TARGET_FIELDS, "Authorization target");
  const evidence = exactObject(
    authorization.evidence, AUTH_EVIDENCE_FIELDS, "Authorization evidence"
  );
  const admin = exactObject(
    authorization.adminResolution, AUTH_ADMIN_FIELDS, "Authorization Admin resolution"
  );
  const preconditions = exactObject(
    authorization.preconditions, AUTH_PRECONDITION_FIELDS, "Authorization preconditions"
  );
  const executor = exactObject(
    authorization.executorRequirements, AUTH_EXECUTOR_FIELDS, "Authorization executor requirements"
  );
  if (authorization.authorizationVersion !== "1" ||
      (mutation.changeKind !== "coder_patch_draft" && mutation.changeKind !== "repair_draft") ||
      !Number.isSafeInteger(mutation.changedFileCount) ||
      mutation.changedFileCount !== normalizeFiles(mutation.changedFiles).length ||
      (admin.invocationDecision !== "admin_invocation_required" &&
        admin.invocationDecision !== "admin_invocation_skipped") ||
      (admin.resolutionKind !== "model_decision" &&
        admin.resolutionKind !== "verified_policy_skip")) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object", "Authorization structure is invalid."
    );
  }
  const normalizedAuthorizationFiles = normalizeFiles(mutation.changedFiles);
  const adminBindingValid = admin.invocationDecision === "admin_invocation_skipped"
    ? admin.resolutionKind === "verified_policy_skip" && admin.adminDecisionHash === null
    : admin.resolutionKind === "model_decision" && admin.adminDecisionHash !== null;
  if (!canonicalEqual(normalizedAuthorizationFiles, mutation.changedFiles) ||
      evidence.gatePolicyHash !== authorization.gatePolicyHash || !adminBindingValid) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object",
      "Authorization bindings are internally inconsistent."
    );
  }
  for (const field of [
    "governedArtifactHash", "handoffHash", "consumptionKey", "gatePolicyHash",
    "authorizationHash"
  ]) requireHash(authorization[field], field);
  for (const field of AUTH_EVIDENCE_FIELDS) requireHash(evidence[field], field);
  const target = authorization.target as PlainRecord;
  for (const field of TARGET_FIELDS) requireHash(target[field], field);
  requireHash(mutation.mutationHash, "mutationHash");
  requireHash(admin.invocationPolicyHash, "adminInvocationPolicyHash");
  requireHash(admin.invocationAssessmentHash, "adminInvocationAssessmentHash");
  if (admin.adminDecisionHash !== null) requireHash(admin.adminDecisionHash, "adminDecisionHash");
  if (Object.values(preconditions).some((valueAtField) => valueAtField !== true) ||
      Object.values(executor).some((valueAtField) => valueAtField !== true)) {
    throw new GateFailure(
      "invalid_controlled_apply_execution_gate_object",
      "Authorization safety requirements are invalid."
    );
  }
  const material = { ...authorization };
  delete material.authorizationHash;
  if (hashCanonicalJson(material) !== authorization.authorizationHash) {
    throw new GateFailure(
      "controlled_apply_execution_authorization_hash_mismatch",
      "The authorization hash is invalid."
    );
  }
  return authorization as unknown as ControlledApplyExecutionAuthorization;
}

function comparisonFields(
  previous: ControlledApplyExecutionAuthorization,
  current: ControlledApplyExecutionAuthorization
): string[] {
  const fields: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (!canonicalEqual(left, right)) fields.push(field);
  };
  compare("governedArtifactHash", previous.governedArtifactHash, current.governedArtifactHash);
  compare("adminInvocationPolicyHash", previous.adminResolution.invocationPolicyHash,
    current.adminResolution.invocationPolicyHash);
  compare("adminInvocationAssessmentHash", previous.adminResolution.invocationAssessmentHash,
    current.adminResolution.invocationAssessmentHash);
  compare("adminDecisionHash", previous.adminResolution.adminDecisionHash,
    current.adminResolution.adminDecisionHash);
  compare("adminResolutionKind", previous.adminResolution.resolutionKind,
    current.adminResolution.resolutionKind);
  compare("handoffHash", previous.handoffHash, current.handoffHash);
  compare("consumptionKey", previous.consumptionKey, current.consumptionKey);
  compare("mutationHash", previous.mutation.mutationHash, current.mutation.mutationHash);
  compare("changedFiles", previous.mutation.changedFiles, current.mutation.changedFiles);
  compare("repositoryIdentityHash", previous.target.repositoryIdentityHash,
    current.target.repositoryIdentityHash);
  compare("baseRevisionHash", previous.target.baseRevisionHash, current.target.baseRevisionHash);
  compare("worktreeStateHash", previous.target.worktreeStateHash,
    current.target.worktreeStateHash);
  for (const field of [
    "currentSnapshotHash", "expectedInspectionHash", "currentInspectionHash",
    "rollbackManifestHash", "rollbackBundleManifestHash", "rollbackBundleReceiptHash",
    "rollbackPayloadRootHash", "rollbackCoverageHash", "constraintsHash", "gatePolicyHash"
  ] as const) compare(field, previous.evidence[field], current.evidence[field]);
  compare("gatePolicyHash", previous.gatePolicyHash, current.gatePolicyHash);
  if (fields.length > 0 || previous.authorizationHash !== current.authorizationHash) {
    fields.push("authorizationHash");
  }
  return sortedUnique(fields);
}

function blockedStaleFields(
  authorization: ControlledApplyExecutionAuthorization,
  gateInput: ControlledApplyExecutionGateInput,
  gateResult: ControlledApplyExecutionGateResult
): string[] {
  const fields: string[] = [];
  const compare = (field: string, current: unknown, previous: unknown) => {
    if (!canonicalEqual(current, previous)) fields.push(field);
  };
  const artifact = gateInput.artifact;
  const handoff = gateInput.handoff;
  compare("governedArtifactHash", artifact?.governedArtifactHash,
    authorization.governedArtifactHash);
  compare("adminInvocationPolicyHash", artifact?.evidence?.adminInvocationPolicyHash,
    authorization.adminResolution.invocationPolicyHash);
  compare("adminInvocationAssessmentHash", artifact?.evidence?.adminInvocationAssessmentHash,
    authorization.adminResolution.invocationAssessmentHash);
  compare("adminDecisionHash", artifact?.evidence?.adminDecisionHash,
    authorization.adminResolution.adminDecisionHash);
  compare("adminResolutionKind", artifact?.decisions?.adminResolutionKind,
    authorization.adminResolution.resolutionKind);
  compare("handoffHash", handoff?.handoffHash, authorization.handoffHash);
  compare("consumptionKey", handoff?.singleUse?.consumptionKey,
    authorization.consumptionKey);
  try {
    compare("mutationHash", computeGovernedMutationHash(
      artifact.change.changeKind, gateInput.mutation
    ), authorization.mutation.mutationHash);
    compare("changedFiles", deriveGovernedMutationChangedFiles(gateInput.mutation),
      authorization.mutation.changedFiles);
  } catch {
    fields.push("mutationHash");
  }
  const currentInspection = gateResult.repositoryInspection?.inspection;
  if (currentInspection) {
    compare("repositoryIdentityHash", currentInspection.target.repositoryIdentityHash,
      authorization.target.repositoryIdentityHash);
    compare("baseRevisionHash", currentInspection.target.baseRevisionHash,
      authorization.target.baseRevisionHash);
    compare("worktreeStateHash", currentInspection.target.worktreeStateHash,
      authorization.target.worktreeStateHash);
    compare("currentInspectionHash", currentInspection.inspectionHash,
      authorization.evidence.currentInspectionHash);
  }
  compare("expectedInspectionHash", gateInput.expectedInspection?.inspectionHash,
    authorization.evidence.expectedInspectionHash);
  try {
    compare("currentSnapshotHash", hashCanonicalJson(gateInput.currentFreshnessSnapshot),
      authorization.evidence.currentSnapshotHash);
  } catch {
    fields.push("currentSnapshotHash");
  }
  compare("rollbackManifestHash",
    gateInput.expectedInspection?.rollbackManifest?.manifestHash,
    authorization.evidence.rollbackManifestHash);
  compare("rollbackBundleManifestHash",
    gateInput.rollbackBundleManifest?.bundleManifestHash,
    authorization.evidence.rollbackBundleManifestHash);
  compare("rollbackBundleReceiptHash", gateInput.rollbackBundleReceipt?.receiptHash,
    authorization.evidence.rollbackBundleReceiptHash);
  compare("rollbackPayloadRootHash", gateInput.rollbackBundleManifest?.payloadRootHash,
    authorization.evidence.rollbackPayloadRootHash);
  compare("constraintsHash", handoff?.constraintsHash,
    authorization.evidence.constraintsHash);
  try {
    compare("gatePolicyHash", hashCanonicalJson(
      gateInput.policy ?? DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY
    ), authorization.gatePolicyHash);
  } catch {
    fields.push("gatePolicyHash");
  }
  if (gateResult.summary.rollbackCoverageHash !== null) {
    compare("rollbackCoverageHash", gateResult.summary.rollbackCoverageHash,
      authorization.evidence.rollbackCoverageHash);
  }
  if (fields.length > 0) fields.push("authorizationHash");
  return sortedUnique(fields);
}

function finishVerification(
  decision: ControlledApplyExecutionAuthorizationVerificationDecision,
  integrity: boolean,
  gateDecision: ControlledApplyExecutionGateDecision | null,
  currentHash: string | null,
  staleFields: string[],
  reasonCodes: string[],
  summary: VerificationSummary
): ControlledApplyExecutionAuthorizationVerificationResult {
  return deepFreeze({
    decision,
    authorizationIntegrityVerified: integrity,
    currentGateDecision: gateDecision,
    currentAuthorizationHash: currentHash,
    staleFields: sortedUnique(staleFields),
    reasonCodes: sortedUnique(reasonCodes),
    firstWriteEligible:
      decision === "controlled_apply_execution_authorization_current",
    summary
  });
}

export async function verifyControlledApplyExecutionAuthorization(
  input: ControlledApplyExecutionAuthorizationVerificationInput
): Promise<ControlledApplyExecutionAuthorizationVerificationResult> {
  const summary = initialVerificationSummary();
  try {
    const cloned = safeClone(input);
    const top = exactObject(cloned, VERIFY_INPUT_FIELDS, "Authorization verification input");
    const authorization = validateAuthorization(top.authorization);
    const integrity = true;
    const gateInput = top.gateInput as ControlledApplyExecutionGateInput;
    summary.consumptionStatusKnown = gateInput.consumptionStatus === "not_consumed" ||
      gateInput.consumptionStatus === "already_consumed";
    summary.consumptionAvailable = gateInput.consumptionStatus === "not_consumed";
    const currentGate = await evaluateControlledApplyExecutionGate(gateInput);
    summary.currentGateReady =
      currentGate.decision === "controlled_apply_execution_gate_ready";
    if (gateInput.consumptionStatus === "already_consumed") {
      return finishVerification(
        "controlled_apply_execution_authorization_consumed", integrity,
        currentGate.decision, null, ["consumptionKey"],
        ["controlled_apply_execution_consumption_key_already_used"], summary
      );
    }
    if (currentGate.decision === "controlled_apply_execution_gate_invalid" ||
        currentGate.decision === "controlled_apply_execution_gate_needs_review") {
      return finishVerification(
        "controlled_apply_execution_authorization_invalid", integrity,
        currentGate.decision, null, [],
        currentGate.issues.map((issue) => issue.code), summary
      );
    }
    if (currentGate.authorization === null) {
      const staleFields = blockedStaleFields(authorization, gateInput, currentGate);
      return finishVerification(
        "controlled_apply_execution_authorization_stale", integrity,
        currentGate.decision, null,
        gateInput.consumptionStatus === "unknown"
          ? sortedUnique([...staleFields, "consumptionKey"])
          : staleFields,
        ["controlled_apply_execution_authorization_stale"], summary
      );
    }
    const current = currentGate.authorization;
    const staleFields = comparisonFields(authorization, current);
    summary.governedArtifactMatched =
      authorization.governedArtifactHash === current.governedArtifactHash;
    summary.handoffMatched = authorization.handoffHash === current.handoffHash;
    summary.consumptionKeyMatched =
      authorization.consumptionKey === current.consumptionKey;
    summary.mutationMatched =
      authorization.mutation.mutationHash === current.mutation.mutationHash;
    summary.changedFilesMatched = canonicalEqual(
      authorization.mutation.changedFiles, current.mutation.changedFiles
    );
    summary.repositoryTargetMatched = canonicalEqual(authorization.target, current.target);
    summary.expectedInspectionMatched = authorization.evidence.expectedInspectionHash ===
      current.evidence.expectedInspectionHash;
    summary.currentInspectionMatched = authorization.evidence.currentInspectionHash ===
      current.evidence.currentInspectionHash;
    summary.rollbackBundleMatched = [
      "rollbackBundleManifestHash", "rollbackBundleReceiptHash", "rollbackPayloadRootHash"
    ].every((field) => authorization.evidence[field as keyof typeof authorization.evidence] ===
      current.evidence[field as keyof typeof current.evidence]);
    summary.rollbackCoverageMatched = authorization.evidence.rollbackCoverageHash ===
      current.evidence.rollbackCoverageHash;
    summary.gatePolicyMatched = authorization.gatePolicyHash === current.gatePolicyHash;
    if (staleFields.length > 0) {
      return finishVerification(
        "controlled_apply_execution_authorization_stale", integrity,
        currentGate.decision, current.authorizationHash, staleFields,
        ["controlled_apply_execution_authorization_stale"], summary
      );
    }
    return finishVerification(
      "controlled_apply_execution_authorization_current", integrity,
      currentGate.decision, current.authorizationHash, [], [], summary
    );
  } catch (error) {
    const code = error instanceof GateFailure ? error.code :
      "invalid_controlled_apply_execution_gate_input";
    return finishVerification(
      "controlled_apply_execution_authorization_invalid", false, null, null,
      [], [code], summary
    );
  }
}
