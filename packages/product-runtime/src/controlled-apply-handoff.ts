import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  verifyGovernedChangeArtifactFreshness,
  type GovernedChangeArtifact,
  type GovernedChangeFreshnessResult,
  type GovernedChangeFreshnessSnapshot,
  type GovernedChangeKind
} from "./governed-change-artifact.js";
import { validateModelWorkspaceMutation } from "./model-mutation-validator.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

/**
 * W.15 plans but never executes repository application. The plan contains no
 * mutation or patch body: a future executor must receive the mutation
 * separately and recompute its exact governed hash. Repository identity, base
 * revision, worktree state, and artifact freshness must be recomputed
 * immediately before apply. The deterministic consumption key needs an
 * external durable registry; this stateless module cannot prove single use.
 * Rollback must be prepared before the first write. Apply and rollback remain
 * Phase X work, and no repository mutation occurs in W.15.
 */

export const CONTROLLED_APPLY_HANDOFF_VERSION = "1" as const;

export type ControlledApplyHandoffDecision =
  | "controlled_apply_handoff_ready"
  | "controlled_apply_handoff_blocked"
  | "controlled_apply_handoff_invalid"
  | "controlled_apply_handoff_needs_review";

export type ControlledApplyTargetSnapshot = {
  repositoryIdentityHash: string;
  baseRevisionHash: string;
  worktreeStateHash: string;
};

export type ControlledApplyConstraints = {
  requireCurrentArtifact: true;
  requireAutoContinueRoute: true;
  requireApplyEligibleArtifact: true;
  requireRepositoryIdentityMatch: true;
  requireBaseRevisionMatch: true;
  requireWorktreeStateMatch: true;
  restrictWritesToChangedFiles: true;
  forbidAdditionalFiles: true;
  requireAtomicApply: true;
  requireRollbackPreparation: true;
  requirePostApplyValidation: true;
  requireExternalConsumptionRegistry: true;
};

export type ControlledApplyHandoffInput = {
  artifact: GovernedChangeArtifact;
  currentFreshnessSnapshot: GovernedChangeFreshnessSnapshot;
  mutation: WorkspaceMutation;
  target: ControlledApplyTargetSnapshot;
  constraints?: ControlledApplyConstraints;
};

export type ControlledApplyTargetBinding = ControlledApplyTargetSnapshot;

export type ControlledApplyMutationBinding = {
  changeKind: GovernedChangeKind;
  mutationHash: string;
  changedFiles: readonly string[];
  patchDryRunResultHash: string;
  temporaryApplyResultHash: string;
  executionVerificationResultHash: string;
};

export type ControlledApplyEvidenceBinding = {
  governedArtifactHash: string;
  currentSnapshotHash: string;
  runId: string;
  objectiveHash: string;
  preShadowTraceHash: string;
  observationHash: string | null;
  governanceHash: string;
  adminDecisionHash: string | null;
  routeHash: string;
  governancePolicyHash: string;
  routerPolicyHash: string;
  finalLedgerRootHash: string;
  finalLedgerEventCount: number;
  phaseVFinalDecision: "temp_validation_passed";
  workflowRoute: "auto_continue";
};

export type ControlledApplyExecutorRequirements = {
  recomputeArtifactFreshnessImmediatelyBeforeApply: true;
  recomputeMutationHashImmediatelyBeforeApply: true;
  recomputeRepositoryIdentityImmediatelyBeforeApply: true;
  recomputeBaseRevisionImmediatelyBeforeApply: true;
  recomputeWorktreeStateImmediatelyBeforeApply: true;
  rejectChangedFileScopeExpansion: true;
  rejectUnlistedFileWrites: true;
  prepareRollbackBeforeFirstWrite: true;
  applyAtomicallyWhenSupported: true;
  validateAfterApply: true;
  rollbackOnValidationFailure: true;
  rejectPreviouslyConsumedKey: true;
};

export type ControlledApplySingleUseIntent = {
  consumptionKey: string;
  enforcement: "external_consumption_registry_required";
};

export type ControlledApplyHandoffPlan = {
  handoffVersion: "1";
  mutation: ControlledApplyMutationBinding;
  evidence: ControlledApplyEvidenceBinding;
  target: ControlledApplyTargetBinding;
  constraints: Readonly<ControlledApplyConstraints>;
  executorRequirements: ControlledApplyExecutorRequirements;
  singleUse: ControlledApplySingleUseIntent;
  constraintsHash: string;
  handoffHash: string;
};

export type ControlledApplyHandoffIssueSeverity = "review" | "error";

export type ControlledApplyHandoffIssue = {
  code: string;
  message: string;
  severity: ControlledApplyHandoffIssueSeverity;
  field?: string;
  hashValue?: string;
  filePath?: string;
};

export type ControlledApplyHandoffResult = {
  decision: ControlledApplyHandoffDecision;
  issues: readonly ControlledApplyHandoffIssue[];
  handoff: ControlledApplyHandoffPlan | null;
  freshness: GovernedChangeFreshnessResult | null;
  summary: {
    artifactIntegrityVerified: boolean;
    artifactCurrent: boolean;
    artifactApplyEligible: boolean;
    phaseVPassed: boolean;
    workflowRouteAutoContinue: boolean;
    mutationValid: boolean;
    mutationHashMatched: boolean;
    changedFilesMatched: boolean;
    targetValid: boolean;
    constraintsValid: boolean;
    currentSnapshotHash: string | null;
    constraintsHash: string | null;
    consumptionKey: string | null;
    handoffHash: string | null;
    handoffBuilt: boolean;
    changedFileCount: number;
    externalConsumptionRegistryRequired: boolean;
  };
};

export type ControlledApplyHandoffVerificationInput = {
  handoff: ControlledApplyHandoffPlan;
  artifact: GovernedChangeArtifact;
  currentFreshnessSnapshot: GovernedChangeFreshnessSnapshot;
  mutation: WorkspaceMutation;
  currentTarget: ControlledApplyTargetSnapshot;
  consumptionStatus: "not_consumed" | "already_consumed" | "unknown";
};

export type ControlledApplyHandoffVerificationDecision =
  | "controlled_apply_handoff_current"
  | "controlled_apply_handoff_stale"
  | "controlled_apply_handoff_consumed"
  | "controlled_apply_handoff_verification_invalid";

export type ControlledApplyHandoffVerificationResult = {
  decision: ControlledApplyHandoffVerificationDecision;
  handoffIntegrityVerified: boolean;
  artifactIntegrityVerified: boolean;
  currentSnapshotHash: string | null;
  currentMutationHash: string | null;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  executionEligible: boolean;
  summary: {
    artifactMatched: boolean;
    snapshotMatched: boolean;
    mutationMatched: boolean;
    changedFilesMatched: boolean;
    repositoryIdentityMatched: boolean;
    baseRevisionMatched: boolean;
    worktreeStateMatched: boolean;
    constraintsMatched: boolean;
    consumptionKeyMatched: boolean;
    consumptionStatusKnown: boolean;
    consumptionAvailable: boolean;
    artifactCurrent: boolean;
    artifactApplyEligible: boolean;
  };
};

type PlainRecord = Record<string, unknown>;
type PlannerSummary = ControlledApplyHandoffResult["summary"];
type VerificationSummary = ControlledApplyHandoffVerificationResult["summary"];

const HASH = /^sha256:[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_CHANGED_FILES = 1000;
const MAX_CLONED_NODES = 200_000;

const CONSTRAINT_FIELDS = [
  "requireCurrentArtifact", "requireAutoContinueRoute", "requireApplyEligibleArtifact",
  "requireRepositoryIdentityMatch", "requireBaseRevisionMatch", "requireWorktreeStateMatch",
  "restrictWritesToChangedFiles", "forbidAdditionalFiles", "requireAtomicApply",
  "requireRollbackPreparation", "requirePostApplyValidation",
  "requireExternalConsumptionRegistry"
] as const;

const EXECUTOR_FIELDS = [
  "recomputeArtifactFreshnessImmediatelyBeforeApply",
  "recomputeMutationHashImmediatelyBeforeApply",
  "recomputeRepositoryIdentityImmediatelyBeforeApply",
  "recomputeBaseRevisionImmediatelyBeforeApply",
  "recomputeWorktreeStateImmediatelyBeforeApply",
  "rejectChangedFileScopeExpansion", "rejectUnlistedFileWrites",
  "prepareRollbackBeforeFirstWrite", "applyAtomicallyWhenSupported",
  "validateAfterApply", "rollbackOnValidationFailure", "rejectPreviouslyConsumedKey"
] as const;

const STRICT_CONSTRAINTS: ControlledApplyConstraints = Object.fromEntries(
  CONSTRAINT_FIELDS.map((field) => [field, true])
) as ControlledApplyConstraints;

export const DEFAULT_CONTROLLED_APPLY_CONSTRAINTS: Readonly<ControlledApplyConstraints> =
  deepFreeze(STRICT_CONSTRAINTS);

const EXECUTOR_REQUIREMENTS: ControlledApplyExecutorRequirements = deepFreeze(
  Object.fromEntries(EXECUTOR_FIELDS.map((field) => [field, true])) as
    ControlledApplyExecutorRequirements
);

const PLANNER_FIELDS = [
  "artifact", "currentFreshnessSnapshot", "mutation", "target", "constraints"
] as const;
const TARGET_FIELDS = [
  "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash"
] as const;
const MUTATION_FIELDS = [
  "role", "target", "summary", "claims", "touchedFiles", "confidence"
] as const;
const REQUIRED_MUTATION_FIELDS = ["role", "target", "summary", "claims", "touchedFiles"] as const;
const HANDOFF_FIELDS = [
  "handoffVersion", "mutation", "evidence", "target", "constraints",
  "executorRequirements", "singleUse", "constraintsHash", "handoffHash"
] as const;
const HANDOFF_MUTATION_FIELDS = [
  "changeKind", "mutationHash", "changedFiles", "patchDryRunResultHash",
  "temporaryApplyResultHash", "executionVerificationResultHash"
] as const;
const EVIDENCE_FIELDS = [
  "governedArtifactHash", "currentSnapshotHash", "runId", "objectiveHash",
  "preShadowTraceHash", "observationHash", "governanceHash", "adminDecisionHash",
  "routeHash", "governancePolicyHash", "routerPolicyHash", "finalLedgerRootHash",
  "finalLedgerEventCount", "phaseVFinalDecision", "workflowRoute"
] as const;
const SINGLE_USE_FIELDS = ["consumptionKey", "enforcement"] as const;
const VERIFICATION_FIELDS = [
  "handoff", "artifact", "currentFreshnessSnapshot", "mutation", "currentTarget",
  "consumptionStatus"
] as const;

class ControlledInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Pick<ControlledApplyHandoffIssue, "field" | "hashValue" | "filePath"> = {}
  ) {
    super(message);
  }
}

class ControlledBoundError extends Error {
  constructor() {
    super("Controlled apply input exceeds a deterministic validation bound.");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  nodes = { count: 0 }
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_input",
      "Controlled apply input contains an unsupported value."
    );
  }
  nodes.count += 1;
  if (nodes.count > MAX_CLONED_NODES) throw new ControlledBoundError();
  if (ancestors.has(value)) {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "Cyclic controlled apply input is not accepted."
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new ControlledInputError(
        "invalid_controlled_apply_handoff_object",
        "Only ordinary arrays are accepted."
      );
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "Only plain controlled apply objects are accepted."
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new ControlledInputError(
      "controlled_apply_handoff_symbol_property",
      "Symbol properties are not accepted."
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : null;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CLONED_NODES) {
        throw new ControlledBoundError();
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new ControlledInputError(
            "invalid_controlled_apply_handoff_object",
            "Sparse arrays are not accepted."
          );
        }
        if (!("value" in descriptor)) {
          throw new ControlledInputError(
            "controlled_apply_handoff_accessor_property",
            "Accessor properties are not accepted."
          );
        }
        output.push(safeClone(descriptor.value, ancestors, nodes));
      }
      const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if ((keys as string[]).some((key) => !expected.has(key))) {
        throw new ControlledInputError(
          "unknown_controlled_apply_handoff_field",
          "Unknown array properties are not accepted."
        );
      }
      return output;
    }
    const output: PlainRecord = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new ControlledInputError(
          "controlled_apply_handoff_accessor_property",
          "Accessor properties are not accepted.",
          { field: key }
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
  optional: readonly string[] = []
): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      `${label} must be a plain object.`
    );
  }
  const allowed = new Set(fields);
  const optionalFields = new Set(optional);
  const output: PlainRecord = {};
  const present = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new ControlledInputError(
        "controlled_apply_handoff_symbol_property",
        "Symbol properties are not accepted."
      );
    }
    present.add(key);
    if (!allowed.has(key)) {
      throw new ControlledInputError(
        "unknown_controlled_apply_handoff_field",
        `${label} contains an unknown field.`,
        { field: key }
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ControlledInputError(
        "controlled_apply_handoff_accessor_property",
        "Accessor properties are not accepted.",
        { field: key }
      );
    }
    output[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!optionalFields.has(field) && !present.has(field)) {
      throw new ControlledInputError(
        "missing_controlled_apply_handoff_field",
        `${label} is missing a required field.`,
        { field }
      );
    }
  }
  return output;
}

function requireHash(value: unknown, code: string, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new ControlledInputError(code, "A controlled apply hash is malformed.", { field });
  }
  return value;
}

function normalizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ControlledInputError(
      "controlled_apply_mutation_invalid",
      "Mutation changed files must be an array.",
      { field: "touchedFiles" }
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHANGED_FILES) {
    throw new ControlledInputError(
      "controlled_apply_mutation_invalid",
      "Mutation changed files exceed the supported bound.",
      { field: "touchedFiles" }
    );
  }
  const files: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ControlledInputError(
        "controlled_apply_mutation_invalid",
        "Mutation changed files must be a dense data array.",
        { field: "touchedFiles" }
      );
    }
    const file = descriptor.value;
    if (typeof file !== "string" || file.length === 0 || file.trim() !== file ||
        ASCII_CONTROL.test(file)) {
      throw new ControlledInputError(
        "controlled_apply_mutation_invalid",
        "Mutation changed files contain an invalid path.",
        { field: "touchedFiles" }
      );
    }
    files.push(file);
  }
  return sortedUnique(files);
}

function normalizeMutation(value: unknown): WorkspaceMutation {
  const cloned = safeClone(value);
  const record = exactObject(cloned, MUTATION_FIELDS, "Workspace mutation", ["confidence"]);
  for (const field of REQUIRED_MUTATION_FIELDS) {
    if (!(field in record)) {
      throw new ControlledInputError(
        "controlled_apply_mutation_invalid",
        "Workspace mutation is missing a required field.",
        { field }
      );
    }
  }
  const role = record.role;
  if (role !== "coder" && role !== "remask") {
    throw new ControlledInputError(
      "controlled_apply_mutation_invalid",
      "Only governed coder or repair mutations are accepted.",
      { field: "role" }
    );
  }
  let validation;
  try {
    validation = validateModelWorkspaceMutation(JSON.stringify(record), { role });
  } catch {
    throw new ControlledInputError(
      "controlled_apply_mutation_invalid",
      "Workspace mutation validation failed safely."
    );
  }
  if (!validation.ok || validation.mutation === null ||
      !canonicalEqual(record, validation.mutation)) {
    throw new ControlledInputError(
      "controlled_apply_mutation_invalid",
      "Workspace mutation failed deterministic validation."
    );
  }
  normalizeFiles(validation.mutation.touchedFiles);
  return validation.mutation;
}

function kindForMutation(mutation: WorkspaceMutation): GovernedChangeKind {
  if (mutation.role === "coder" && mutation.target === "patchDraft") {
    return "coder_patch_draft";
  }
  if (mutation.role === "remask" && mutation.target === "repairDraft") {
    return "repair_draft";
  }
  throw new ControlledInputError(
    "controlled_apply_mutation_invalid",
    "Workspace mutation is not a governed apply mutation."
  );
}

function computeHashFromNormalized(
  changeKind: GovernedChangeKind,
  mutation: WorkspaceMutation
): string {
  const expectedKind = kindForMutation(mutation);
  if (expectedKind !== changeKind) {
    throw new ControlledInputError(
      "controlled_apply_mutation_hash_mismatch",
      "The governed change kind does not match the mutation contract.",
      { field: "changeKind" }
    );
  }
  const artifactType = changeKind === "coder_patch_draft"
    ? "coder_validated_mutation"
    : "repair_draft_mutation";
  return hashCanonicalJson({ artifactType, value: mutation });
}

export function computeGovernedMutationHash(
  changeKind: GovernedChangeKind,
  mutation: WorkspaceMutation
): string {
  return computeHashFromNormalized(changeKind, normalizeMutation(mutation));
}

export function deriveGovernedMutationChangedFiles(
  mutation: WorkspaceMutation
): readonly string[] {
  const normalized = normalizeMutation(mutation);
  kindForMutation(normalized);
  return deepFreeze(normalizeFiles(normalized.touchedFiles));
}

function normalizeTarget(value: unknown): ControlledApplyTargetSnapshot {
  const record = exactObject(value, TARGET_FIELDS, "Controlled apply target");
  return {
    repositoryIdentityHash: requireHash(
      record.repositoryIdentityHash,
      "controlled_apply_repository_identity_invalid",
      "repositoryIdentityHash"
    ),
    baseRevisionHash: requireHash(
      record.baseRevisionHash,
      "controlled_apply_base_revision_invalid",
      "baseRevisionHash"
    ),
    worktreeStateHash: requireHash(
      record.worktreeStateHash,
      "controlled_apply_worktree_state_invalid",
      "worktreeStateHash"
    )
  };
}

function normalizeConstraints(value: unknown): ControlledApplyConstraints {
  const record = exactObject(value, CONSTRAINT_FIELDS, "Controlled apply constraints");
  for (const field of CONSTRAINT_FIELDS) {
    if (record[field] !== true) {
      throw new ControlledInputError(
        record[field] === false
          ? "controlled_apply_constraint_relaxation_forbidden"
          : "controlled_apply_constraints_invalid",
        "Every version 1 controlled apply constraint must be true.",
        { field }
      );
    }
  }
  return Object.fromEntries(CONSTRAINT_FIELDS.map((field) => [field, true])) as
    ControlledApplyConstraints;
}

function normalizeExecutorRequirements(value: unknown): ControlledApplyExecutorRequirements {
  const record = exactObject(value, EXECUTOR_FIELDS, "Controlled apply executor requirements");
  for (const field of EXECUTOR_FIELDS) {
    if (record[field] !== true) {
      throw new ControlledInputError(
        "invalid_controlled_apply_handoff_object",
        "Every version 1 executor requirement must be true.",
        { field }
      );
    }
  }
  return Object.fromEntries(EXECUTOR_FIELDS.map((field) => [field, true])) as
    ControlledApplyExecutorRequirements;
}

function initialPlannerSummary(): PlannerSummary {
  return {
    artifactIntegrityVerified: false,
    artifactCurrent: false,
    artifactApplyEligible: false,
    phaseVPassed: false,
    workflowRouteAutoContinue: false,
    mutationValid: false,
    mutationHashMatched: false,
    changedFilesMatched: false,
    targetValid: false,
    constraintsValid: false,
    currentSnapshotHash: null,
    constraintsHash: null,
    consumptionKey: null,
    handoffHash: null,
    handoffBuilt: false,
    changedFileCount: 0,
    externalConsumptionRegistryRequired: false
  };
}

function initialVerificationSummary(): VerificationSummary {
  return {
    artifactMatched: false,
    snapshotMatched: false,
    mutationMatched: false,
    changedFilesMatched: false,
    repositoryIdentityMatched: false,
    baseRevisionMatched: false,
    worktreeStateMatched: false,
    constraintsMatched: false,
    consumptionKeyMatched: false,
    consumptionStatusKnown: false,
    consumptionAvailable: false,
    artifactCurrent: false,
    artifactApplyEligible: false
  };
}

function plannerIssue(
  code: string,
  message: string,
  severity: ControlledApplyHandoffIssueSeverity = "error",
  context: Pick<ControlledApplyHandoffIssue, "field" | "hashValue" | "filePath"> = {}
): ControlledApplyHandoffIssue {
  return { code, message, severity, ...context };
}

function issueFromError(error: unknown): ControlledApplyHandoffIssue {
  if (error instanceof ControlledInputError) {
    return plannerIssue(error.code, error.message, "error", error.context);
  }
  if (error instanceof ControlledBoundError) {
    return plannerIssue(
      "controlled_apply_handoff_exception",
      "Controlled apply input exceeds a deterministic validation bound.",
      "review"
    );
  }
  return plannerIssue(
    "controlled_apply_handoff_exception",
    "The controlled apply handoff could not be evaluated safely."
  );
}

function finishPlanner(
  decision: ControlledApplyHandoffDecision,
  issues: ControlledApplyHandoffIssue[],
  handoff: ControlledApplyHandoffPlan | null,
  freshness: GovernedChangeFreshnessResult | null,
  summary: PlannerSummary
): ControlledApplyHandoffResult {
  issues.sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
  return deepFreeze({ decision, issues, handoff, freshness, summary });
}

function consumptionKeyFor(
  governedArtifactHash: string,
  currentSnapshotHash: string,
  mutationHash: string,
  changedFiles: readonly string[],
  target: ControlledApplyTargetSnapshot,
  constraintsHash: string
): string {
  return hashCanonicalJson({
    artifactType: "controlled_apply_consumption_key",
    governedArtifactHash,
    currentSnapshotHash,
    mutationHash,
    changedFiles: [...changedFiles],
    repositoryIdentityHash: target.repositoryIdentityHash,
    baseRevisionHash: target.baseRevisionHash,
    worktreeStateHash: target.worktreeStateHash,
    constraintsHash
  });
}

function handoffHashMaterial(
  handoff: Omit<ControlledApplyHandoffPlan, "handoffHash">
): Omit<ControlledApplyHandoffPlan, "handoffHash"> {
  return handoff;
}

export function buildControlledApplyHandoff(
  input: ControlledApplyHandoffInput
): ControlledApplyHandoffResult {
  const summary = initialPlannerSummary();
  const issues: ControlledApplyHandoffIssue[] = [];
  let freshness: GovernedChangeFreshnessResult | null = null;
  try {
    const cloned = safeClone(input);
    const record = exactObject(cloned, PLANNER_FIELDS, "Controlled apply handoff input", ["constraints"]);
    const artifact = record.artifact as GovernedChangeArtifact;
    const snapshot = record.currentFreshnessSnapshot as GovernedChangeFreshnessSnapshot;
    freshness = verifyGovernedChangeArtifactFreshness(artifact, snapshot);
    summary.artifactIntegrityVerified = freshness.artifactIntegrityVerified;
    summary.artifactCurrent = freshness.decision === "governed_change_current";
    summary.artifactApplyEligible = freshness.summary.artifactApplyEligible;
    summary.currentSnapshotHash = freshness.currentSnapshotHash;

    if (!freshness.artifactIntegrityVerified) {
      issues.push(plannerIssue(
        "controlled_apply_artifact_integrity_mismatch",
        "The governed artifact integrity check failed."
      ));
    } else if (freshness.decision === "governed_change_stale") {
      issues.push(plannerIssue(
        "controlled_apply_artifact_stale",
        "The governed artifact is stale against current evidence."
      ));
    } else if (freshness.decision !== "governed_change_current") {
      issues.push(plannerIssue(
        "controlled_apply_artifact_not_current",
        "The governed artifact freshness evidence is invalid."
      ));
    }

    const normalizedMutation = normalizeMutation(record.mutation);
    summary.mutationValid = true;
    const changeKind = artifact.change?.changeKind;
    if (changeKind !== "coder_patch_draft" && changeKind !== "repair_draft") {
      throw new ControlledInputError(
        "controlled_apply_mutation_hash_mismatch",
        "The governed artifact change kind is invalid.",
        { field: "changeKind" }
      );
    }
    const mutationHash = computeHashFromNormalized(changeKind, normalizedMutation);
    const changedFiles = normalizeFiles(normalizedMutation.touchedFiles);
    summary.changedFileCount = changedFiles.length;
    summary.mutationHashMatched = mutationHash === artifact.change.mutationHash;
    summary.changedFilesMatched = canonicalEqual(changedFiles, artifact.change.changedFiles);
    if (!summary.mutationHashMatched) {
      issues.push(plannerIssue(
        "controlled_apply_mutation_hash_mismatch",
        "The supplied mutation hash does not match the governed artifact.",
        "error",
        { field: "mutationHash" }
      ));
    }
    if (!summary.changedFilesMatched) {
      issues.push(plannerIssue(
        "controlled_apply_changed_files_mismatch",
        "The supplied mutation file scope does not match the governed artifact.",
        "error",
        { field: "changedFiles" }
      ));
    }

    const target = normalizeTarget(record.target);
    summary.targetValid = true;
    const constraints = normalizeConstraints(
      Object.prototype.hasOwnProperty.call(record, "constraints")
        ? record.constraints
        : DEFAULT_CONTROLLED_APPLY_CONSTRAINTS
    );
    summary.constraintsValid = true;
    summary.constraintsHash = hashCanonicalJson(constraints);
    summary.externalConsumptionRegistryRequired = true;

    summary.phaseVPassed = artifact.decisions?.phaseVFinalDecision === "temp_validation_passed";
    summary.workflowRouteAutoContinue = artifact.decisions?.workflowRoute === "auto_continue";
    if (!summary.artifactApplyEligible) {
      issues.push(plannerIssue(
        "controlled_apply_artifact_not_eligible",
        "The governed artifact is not apply eligible.",
        "review"
      ));
    }
    if (!summary.phaseVPassed) {
      issues.push(plannerIssue(
        "controlled_apply_phase_v_not_passed",
        "The governed Phase V decision did not pass.",
        "review"
      ));
    }
    if (!summary.workflowRouteAutoContinue) {
      issues.push(plannerIssue(
        "controlled_apply_route_not_auto_continue",
        "The governed workflow route is not auto-continue.",
        "review"
      ));
    }
    if (freshness.decision === "governed_change_current" && !freshness.handoffEligible) {
      issues.push(plannerIssue(
        "controlled_apply_freshness_not_handoff_eligible",
        "Current governed freshness evidence does not permit handoff.",
        "review"
      ));
    }

    const invalid = !summary.artifactIntegrityVerified || !summary.artifactCurrent ||
      !summary.mutationValid || !summary.mutationHashMatched ||
      !summary.changedFilesMatched || !summary.targetValid || !summary.constraintsValid;
    if (invalid) {
      return finishPlanner("controlled_apply_handoff_invalid", issues, null, freshness, summary);
    }
    const blocked = !summary.artifactApplyEligible || !summary.phaseVPassed ||
      !summary.workflowRouteAutoContinue || !freshness.handoffEligible;
    if (blocked) {
      return finishPlanner("controlled_apply_handoff_blocked", issues, null, freshness, summary);
    }
    if (freshness.currentSnapshotHash === null || summary.constraintsHash === null) {
      throw new ControlledInputError(
        "controlled_apply_handoff_hash_failure",
        "Required controlled apply hashes are unavailable."
      );
    }

    const mutationBinding: ControlledApplyMutationBinding = {
      changeKind,
      mutationHash,
      changedFiles,
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash: artifact.change.executionVerificationResultHash
    };
    const evidence: ControlledApplyEvidenceBinding = {
      governedArtifactHash: artifact.governedArtifactHash,
      currentSnapshotHash: freshness.currentSnapshotHash,
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash,
      governanceHash: artifact.evidence.governanceHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash,
      routeHash: artifact.evidence.routeHash,
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: "temp_validation_passed",
      workflowRoute: "auto_continue"
    };
    const consumptionKey = consumptionKeyFor(
      artifact.governedArtifactHash,
      freshness.currentSnapshotHash,
      mutationHash,
      changedFiles,
      target,
      summary.constraintsHash
    );
    const withoutHash: Omit<ControlledApplyHandoffPlan, "handoffHash"> = {
      handoffVersion: CONTROLLED_APPLY_HANDOFF_VERSION,
      mutation: mutationBinding,
      evidence,
      target,
      constraints,
      executorRequirements: { ...EXECUTOR_REQUIREMENTS },
      singleUse: {
        consumptionKey,
        enforcement: "external_consumption_registry_required"
      },
      constraintsHash: summary.constraintsHash
    };
    const handoffHash = hashCanonicalJson(handoffHashMaterial(withoutHash));
    const handoff: ControlledApplyHandoffPlan = { ...withoutHash, handoffHash };
    summary.consumptionKey = consumptionKey;
    summary.handoffHash = handoffHash;
    summary.handoffBuilt = true;
    return finishPlanner("controlled_apply_handoff_ready", issues, handoff, freshness, summary);
  } catch (error) {
    if (error instanceof ControlledInputError && new Set([
      "controlled_apply_repository_identity_invalid",
      "controlled_apply_base_revision_invalid",
      "controlled_apply_worktree_state_invalid"
    ]).has(error.code)) {
      issues.push(plannerIssue(
        "controlled_apply_target_invalid",
        "The controlled apply target snapshot is invalid."
      ));
    }
    issues.push(issueFromError(error));
    const decision: ControlledApplyHandoffDecision = error instanceof ControlledBoundError
      ? "controlled_apply_handoff_needs_review"
      : "controlled_apply_handoff_invalid";
    return finishPlanner(decision, issues, null, freshness, summary);
  }
}

function normalizeHandoff(value: unknown): ControlledApplyHandoffPlan {
  const record = exactObject(value, HANDOFF_FIELDS, "Controlled apply handoff plan");
  if (record.handoffVersion !== CONTROLLED_APPLY_HANDOFF_VERSION) {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "The controlled apply handoff version is unsupported.",
      { field: "handoffVersion" }
    );
  }
  const mutation = exactObject(record.mutation, HANDOFF_MUTATION_FIELDS, "Handoff mutation binding");
  if (mutation.changeKind !== "coder_patch_draft" && mutation.changeKind !== "repair_draft") {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "The handoff mutation kind is invalid.",
      { field: "changeKind" }
    );
  }
  const evidence = exactObject(record.evidence, EVIDENCE_FIELDS, "Handoff evidence binding");
  const nullableHash = (field: "observationHash" | "adminDecisionHash"): string | null =>
    evidence[field] === null
      ? null
      : requireHash(evidence[field], "invalid_controlled_apply_handoff_object", field);
  if (typeof evidence.runId !== "string" || evidence.runId.length === 0 ||
      !Number.isSafeInteger(evidence.finalLedgerEventCount) ||
      (evidence.finalLedgerEventCount as number) < 0 ||
      evidence.phaseVFinalDecision !== "temp_validation_passed" ||
      evidence.workflowRoute !== "auto_continue") {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "The handoff evidence binding is invalid."
    );
  }
  const target = normalizeTarget(record.target);
  const constraints = normalizeConstraints(record.constraints);
  const executorRequirements = normalizeExecutorRequirements(record.executorRequirements);
  const singleUse = exactObject(record.singleUse, SINGLE_USE_FIELDS, "Handoff single-use intent");
  if (singleUse.enforcement !== "external_consumption_registry_required") {
    throw new ControlledInputError(
      "invalid_controlled_apply_handoff_object",
      "The handoff single-use enforcement contract is invalid.",
      { field: "enforcement" }
    );
  }
  return {
    handoffVersion: CONTROLLED_APPLY_HANDOFF_VERSION,
    mutation: {
      changeKind: mutation.changeKind,
      mutationHash: requireHash(
        mutation.mutationHash,
        "invalid_controlled_apply_handoff_object",
        "mutationHash"
      ),
      changedFiles: normalizeFiles(mutation.changedFiles),
      patchDryRunResultHash: requireHash(
        mutation.patchDryRunResultHash,
        "invalid_controlled_apply_handoff_object",
        "patchDryRunResultHash"
      ),
      temporaryApplyResultHash: requireHash(
        mutation.temporaryApplyResultHash,
        "invalid_controlled_apply_handoff_object",
        "temporaryApplyResultHash"
      ),
      executionVerificationResultHash: requireHash(
        mutation.executionVerificationResultHash,
        "invalid_controlled_apply_handoff_object",
        "executionVerificationResultHash"
      )
    },
    evidence: {
      governedArtifactHash: requireHash(
        evidence.governedArtifactHash,
        "invalid_controlled_apply_handoff_object",
        "governedArtifactHash"
      ),
      currentSnapshotHash: requireHash(
        evidence.currentSnapshotHash,
        "invalid_controlled_apply_handoff_object",
        "currentSnapshotHash"
      ),
      runId: evidence.runId,
      objectiveHash: requireHash(evidence.objectiveHash, "invalid_controlled_apply_handoff_object", "objectiveHash"),
      preShadowTraceHash: requireHash(evidence.preShadowTraceHash, "invalid_controlled_apply_handoff_object", "preShadowTraceHash"),
      observationHash: nullableHash("observationHash"),
      governanceHash: requireHash(evidence.governanceHash, "invalid_controlled_apply_handoff_object", "governanceHash"),
      adminDecisionHash: nullableHash("adminDecisionHash"),
      routeHash: requireHash(evidence.routeHash, "invalid_controlled_apply_handoff_object", "routeHash"),
      governancePolicyHash: requireHash(evidence.governancePolicyHash, "invalid_controlled_apply_handoff_object", "governancePolicyHash"),
      routerPolicyHash: requireHash(evidence.routerPolicyHash, "invalid_controlled_apply_handoff_object", "routerPolicyHash"),
      finalLedgerRootHash: requireHash(evidence.finalLedgerRootHash, "invalid_controlled_apply_handoff_object", "finalLedgerRootHash"),
      finalLedgerEventCount: evidence.finalLedgerEventCount as number,
      phaseVFinalDecision: "temp_validation_passed",
      workflowRoute: "auto_continue"
    },
    target,
    constraints,
    executorRequirements,
    singleUse: {
      consumptionKey: requireHash(
        singleUse.consumptionKey,
        "invalid_controlled_apply_handoff_object",
        "consumptionKey"
      ),
      enforcement: "external_consumption_registry_required"
    },
    constraintsHash: requireHash(
      record.constraintsHash,
      "invalid_controlled_apply_handoff_object",
      "constraintsHash"
    ),
    handoffHash: requireHash(
      record.handoffHash,
      "invalid_controlled_apply_handoff_object",
      "handoffHash"
    )
  };
}

function finishVerification(
  decision: ControlledApplyHandoffVerificationDecision,
  handoffIntegrityVerified: boolean,
  artifactIntegrityVerified: boolean,
  currentSnapshotHash: string | null,
  currentMutationHash: string | null,
  staleFields: string[],
  reasonCodes: string[],
  executionEligible: boolean,
  summary: VerificationSummary
): ControlledApplyHandoffVerificationResult {
  return deepFreeze({
    decision,
    handoffIntegrityVerified,
    artifactIntegrityVerified,
    currentSnapshotHash,
    currentMutationHash,
    staleFields: sortedUnique(staleFields),
    reasonCodes: sortedUnique(reasonCodes),
    executionEligible,
    summary
  });
}

export function verifyControlledApplyHandoff(
  input: ControlledApplyHandoffVerificationInput
): ControlledApplyHandoffVerificationResult {
  const summary = initialVerificationSummary();
  const invalid = (
    reasonCode: string,
    handoffIntegrityVerified = false,
    artifactIntegrityVerified = false,
    currentSnapshotHash: string | null = null,
    currentMutationHash: string | null = null
  ) => finishVerification(
    "controlled_apply_handoff_verification_invalid",
    handoffIntegrityVerified,
    artifactIntegrityVerified,
    currentSnapshotHash,
    currentMutationHash,
    [],
    [reasonCode],
    false,
    summary
  );
  try {
    const cloned = safeClone(input);
    const record = exactObject(cloned, VERIFICATION_FIELDS, "Controlled apply verification input");
    const handoff = normalizeHandoff(record.handoff);
    const { handoffHash, ...material } = handoff;
    if (hashCanonicalJson(handoffHashMaterial(material)) !== handoffHash) {
      return invalid("controlled_apply_handoff_hash_mismatch");
    }
    if (hashCanonicalJson(handoff.constraints) !== handoff.constraintsHash) {
      return invalid("controlled_apply_constraints_hash_mismatch");
    }
    const handoffIntegrityVerified = true;
    summary.constraintsMatched = canonicalEqual(handoff.constraints, DEFAULT_CONTROLLED_APPLY_CONSTRAINTS);

    const artifact = record.artifact as GovernedChangeArtifact;
    const snapshot = record.currentFreshnessSnapshot as GovernedChangeFreshnessSnapshot;
    const freshness = verifyGovernedChangeArtifactFreshness(artifact, snapshot);
    summary.artifactCurrent = freshness.decision === "governed_change_current";
    summary.artifactApplyEligible = freshness.summary.artifactApplyEligible;
    if (!freshness.artifactIntegrityVerified) {
      return invalid("controlled_apply_artifact_integrity_mismatch", true, false);
    }
    if (freshness.decision === "governed_change_freshness_invalid") {
      return invalid("controlled_apply_artifact_not_current", true, true);
    }

    const normalizedMutation = normalizeMutation(record.mutation);
    const changeKind = kindForMutation(normalizedMutation);
    const currentMutationHash = computeHashFromNormalized(changeKind, normalizedMutation);
    const changedFiles = normalizeFiles(normalizedMutation.touchedFiles);
    const target = normalizeTarget(record.currentTarget);
    const currentSnapshotHash = freshness.currentSnapshotHash;
    if (currentSnapshotHash === null) {
      return invalid("controlled_apply_artifact_not_current", true, true);
    }
    const currentConstraintsHash = hashCanonicalJson(DEFAULT_CONTROLLED_APPLY_CONSTRAINTS);
    const currentConsumptionKey = consumptionKeyFor(
      artifact.governedArtifactHash,
      currentSnapshotHash,
      currentMutationHash,
      changedFiles,
      target,
      currentConstraintsHash
    );

    summary.artifactMatched = handoff.evidence.governedArtifactHash ===
      artifact.governedArtifactHash;
    summary.snapshotMatched = handoff.evidence.currentSnapshotHash === currentSnapshotHash;
    summary.mutationMatched = handoff.mutation.mutationHash === currentMutationHash &&
      handoff.mutation.changeKind === changeKind;
    summary.changedFilesMatched = canonicalEqual(handoff.mutation.changedFiles, changedFiles);
    summary.repositoryIdentityMatched = handoff.target.repositoryIdentityHash ===
      target.repositoryIdentityHash;
    summary.baseRevisionMatched = handoff.target.baseRevisionHash === target.baseRevisionHash;
    summary.worktreeStateMatched = handoff.target.worktreeStateHash === target.worktreeStateHash;
    summary.consumptionKeyMatched = handoff.singleUse.consumptionKey === currentConsumptionKey;

    const staleFields: string[] = [];
    if (!summary.artifactMatched) staleFields.push("governedArtifactHash");
    if (!summary.snapshotMatched || freshness.decision === "governed_change_stale") {
      staleFields.push("currentSnapshotHash");
    }
    if (!summary.mutationMatched) staleFields.push("mutationHash");
    if (!summary.changedFilesMatched) staleFields.push("changedFiles");
    if (!summary.repositoryIdentityMatched) staleFields.push("repositoryIdentityHash");
    if (!summary.baseRevisionMatched) staleFields.push("baseRevisionHash");
    if (!summary.worktreeStateMatched) staleFields.push("worktreeStateHash");
    if (!summary.constraintsMatched || handoff.constraintsHash !== currentConstraintsHash) {
      staleFields.push("constraints", "constraintsHash");
    }
    if (!summary.consumptionKeyMatched) staleFields.push("consumptionKey");

    const artifactBindingMatched =
      handoff.mutation.patchDryRunResultHash === artifact.change.patchDryRunResultHash &&
      handoff.mutation.temporaryApplyResultHash === artifact.change.temporaryApplyResultHash &&
      handoff.mutation.executionVerificationResultHash ===
        artifact.change.executionVerificationResultHash &&
      handoff.evidence.runId === artifact.evidence.runId &&
      handoff.evidence.objectiveHash === artifact.evidence.objectiveHash &&
      handoff.evidence.preShadowTraceHash === artifact.evidence.preShadowTraceHash &&
      handoff.evidence.observationHash === artifact.evidence.observationHash &&
      handoff.evidence.governanceHash === artifact.evidence.governanceHash &&
      handoff.evidence.adminDecisionHash === artifact.evidence.adminDecisionHash &&
      handoff.evidence.routeHash === artifact.evidence.routeHash &&
      handoff.evidence.governancePolicyHash === artifact.evidence.governancePolicyHash &&
      handoff.evidence.routerPolicyHash === artifact.evidence.routerPolicyHash &&
      handoff.evidence.finalLedgerRootHash === artifact.evidence.finalLedgerRootHash &&
      handoff.evidence.finalLedgerEventCount === artifact.evidence.finalLedgerEventCount &&
      artifact.decisions.phaseVFinalDecision === "temp_validation_passed" &&
      artifact.decisions.workflowRoute === "auto_continue";
    if (!artifactBindingMatched) staleFields.push("governedArtifactHash");

    if (staleFields.length > 0) {
      const staleReasons = ["controlled_apply_handoff_stale"];
      if (staleFields.includes("governedArtifactHash") ||
          staleFields.includes("currentSnapshotHash")) {
        staleReasons.push("controlled_apply_artifact_stale");
      }
      if (staleFields.includes("mutationHash")) {
        staleReasons.push("controlled_apply_mutation_hash_mismatch");
      }
      if (staleFields.includes("changedFiles")) {
        staleReasons.push("controlled_apply_changed_files_mismatch");
      }
      if (staleFields.includes("consumptionKey")) {
        staleReasons.push("controlled_apply_consumption_key_mismatch");
      }
      return finishVerification(
        "controlled_apply_handoff_stale",
        handoffIntegrityVerified,
        true,
        currentSnapshotHash,
        currentMutationHash,
        staleFields,
        staleReasons,
        false,
        summary
      );
    }

    const consumptionStatus = record.consumptionStatus;
    summary.consumptionStatusKnown = consumptionStatus === "not_consumed" ||
      consumptionStatus === "already_consumed";
    summary.consumptionAvailable = consumptionStatus === "not_consumed";
    if (consumptionStatus === "already_consumed") {
      return finishVerification(
        "controlled_apply_handoff_consumed",
        true,
        true,
        currentSnapshotHash,
        currentMutationHash,
        [],
        ["controlled_apply_consumption_key_already_used"],
        false,
        summary
      );
    }
    if (consumptionStatus !== "not_consumed") {
      return invalid(
        "controlled_apply_consumption_status_unknown",
        true,
        true,
        currentSnapshotHash,
        currentMutationHash
      );
    }
    return finishVerification(
      "controlled_apply_handoff_current",
      true,
      true,
      currentSnapshotHash,
      currentMutationHash,
      [],
      [],
      true,
      summary
    );
  } catch (error) {
    if (error instanceof ControlledInputError) {
      return invalid(error.code);
    }
    if (error instanceof ControlledBoundError) {
      return invalid("controlled_apply_handoff_exception");
    }
    return invalid("controlled_apply_handoff_exception");
  }
}
