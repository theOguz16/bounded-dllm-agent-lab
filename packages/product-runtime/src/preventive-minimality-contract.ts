import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { hashCanonicalJson } from "./agent-event-ledger.js";

export const PREVENTIVE_MINIMALITY_POLICY_VERSION = "1" as const;
export const PREVENTIVE_MINIMALITY_PLAN_VERSION = "1" as const;
export const PREVENTIVE_MINIMALITY_BASELINE_VERSION = "1" as const;
export const PREVENTIVE_MINIMALITY_RECEIPT_VERSION = "1" as const;
export const REPOSITORY_DEPENDENCY_INVENTORY_VERSION = "1" as const;

export type MinimalityRiskClass = "low" | "medium" | "high" | "critical";
export type MinimalityBehavior = "allow_with_justification" | "human_review" | "replan";
export type MinimalityHighRiskBehavior = "disabled" | "human_review";
export type MinimalityPlannedChangeKind =
  | "bugfix"
  | "config"
  | "dependency"
  | "docs"
  | "feature"
  | "refactor"
  | "test";

export type PreventiveMinimalityPolicy = {
  policyVersion: "1";
  policyId: string;
  preferExistingCode: boolean;
  preferStandardLibrary: boolean;
  preferNativePlatform: boolean;
  preferInstalledDependencies: boolean;
  newDependencyRequiresJustification: boolean;
  newDependencyRequiresAlternatives: boolean;
  newAbstractionRequiresJustification: boolean;
  newAbstractionMinReuseSites: number;
  unrequestedDependencyBehavior: MinimalityBehavior;
  unrequestedAbstractionBehavior: MinimalityBehavior;
  unrequestedRefactorBehavior: MinimalityBehavior;
  highRiskBehavior: MinimalityHighRiskBehavior;
  maxPlannedFiles: number;
  maxNewDependencies: number;
  maxNewAbstractions: number;
  policyHash: string;
};

export type PreventiveMinimalityPolicyDraft = Omit<
  PreventiveMinimalityPolicy,
  "policyHash"
>;

export type MinimalityPlannedFile = {
  path: string;
  changeKind: MinimalityPlannedChangeKind;
  requested: boolean;
  justification: string | null;
};

export type MinimalityDependencyPlan = {
  name: string;
  requested: boolean;
  purpose: string;
  justification: string | null;
  standardLibraryConsidered: boolean;
  nativePlatformConsidered: boolean;
  existingDependenciesConsidered: readonly string[];
  whyExistingInsufficient: string | null;
};

export type MinimalityAbstractionPlan = {
  abstractionId: string;
  filePath: string;
  requested: boolean;
  purpose: string;
  justification: string | null;
  reuseSites: readonly string[];
  whyInlineInsufficient: string | null;
};

export type PreventiveMinimalityRawPlan = {
  planVersion: "1";
  riskClass: MinimalityRiskClass;
  taskExplicitlyRequestsRefactor: boolean;
  plannedFiles: readonly MinimalityPlannedFile[];
  newDependencies: readonly MinimalityDependencyPlan[];
  newAbstractions: readonly MinimalityAbstractionPlan[];
};

export type PreventiveMinimalityPlan = PreventiveMinimalityRawPlan & {
  taskId: string;
  objectiveHash: string;
  plannerProposalHash: string;
  intelligenceHash: string;
  policyHash: string;
  planHash: string;
};

export type RepositoryDependencyManifest = {
  path: string;
  contentHash: string;
  dependencies: readonly string[];
  devDependencies: readonly string[];
  optionalDependencies: readonly string[];
  peerDependencies: readonly string[];
};

export type RepositoryDependencyInventory = {
  inventoryVersion: "1";
  manifestFiles: readonly RepositoryDependencyManifest[];
  installedDependencies: readonly string[];
  inventoryHash: string;
};

export type PreventiveMinimalityBaseline = {
  baselineVersion: "1";
  taskId: string;
  objectiveHash: string;
  plannerProposalHash: string;
  intelligenceHash: string;
  policyHash: string;
  planHash: string;
  expectedFiles: readonly string[];
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  requestedRefactor: boolean;
  plannedDependencies: readonly {
    name: string;
    requested: boolean;
    justification: string | null;
  }[];
  plannedAbstractions: readonly {
    abstractionId: string;
    filePath: string;
    requested: boolean;
    justification: string | null;
  }[];
  baselineHash: string;
};

export type PreventiveMinimalityDecision =
  | "minimality_plan_ready"
  | "minimality_justification_required"
  | "minimality_replan_required"
  | "minimality_human_review_required"
  | "minimality_policy_disabled"
  | "minimality_plan_invalid";

export type PreventiveMinimalityRoute =
  | "continue_to_coder"
  | "request_planner_revision"
  | "human_review"
  | "policy_bypassed"
  | "stop_invalid";

export type PreventiveMinimalityIssue = {
  code: string;
  message: string;
  action: "human_review" | "request_justification" | "replan" | "stop_invalid";
  field?: string;
  filePath?: string;
  itemName?: string;
};

export type PreventiveMinimalityReceipt = {
  receiptVersion: "1";
  decision: Exclude<PreventiveMinimalityDecision, "minimality_plan_invalid">;
  route: Exclude<PreventiveMinimalityRoute, "stop_invalid">;
  taskId: string;
  objectiveHash: string;
  plannerProposalHash: string;
  intelligenceHash: string;
  policyHash: string;
  planHash: string;
  dependencyInventoryHash: string;
  baselineHash: string;
  issueCodes: readonly string[];
  receiptHash: string;
};

export type EvaluatePreventiveMinimalityInput = {
  repositoryPath: string;
  expectedTaskId: string;
  expectedObjectiveHash: string;
  expectedPlannerProposalHash: string;
  expectedIntelligenceHash: string;
  policy: PreventiveMinimalityPolicy;
  plan: PreventiveMinimalityPlan;
  allowedFiles: readonly string[];
  forbiddenFiles?: readonly string[];
  maxManifestFiles?: number;
  maxManifestBytes?: number;
};

export type EvaluatePreventiveMinimalityResult = {
  decision: PreventiveMinimalityDecision;
  route: PreventiveMinimalityRoute;
  issues: readonly PreventiveMinimalityIssue[];
  plan: PreventiveMinimalityPlan | null;
  dependencyInventory: RepositoryDependencyInventory | null;
  baseline: PreventiveMinimalityBaseline | null;
  receipt: PreventiveMinimalityReceipt | null;
  summary: {
    planIntegrityVerified: boolean;
    policyIntegrityVerified: boolean;
    identityMatched: boolean;
    plannerProposalMatched: boolean;
    intelligenceMatched: boolean;
    repositoryDependencyInventoryBuilt: boolean;
    plannedFileCount: number;
    newPlannedFileCount: number;
    newDependencyCount: number;
    newAbstractionCount: number;
    installedDependencyCount: number;
    replanIssueCount: number;
    justificationIssueCount: number;
    humanReviewIssueCount: number;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MAX_PATH_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 4_000;
const MAX_REFERENCE_LENGTH = 512;
const HARD_MAX_PLANNED_FILES = 1_000;
const HARD_MAX_NEW_DEPENDENCIES = 100;
const HARD_MAX_NEW_ABSTRACTIONS = 1_000;
const HARD_MAX_MANIFEST_FILES = 1_000;
const HARD_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_FILES = 100;
const DEFAULT_MAX_MANIFEST_BYTES = 512 * 1024;

const POLICY_FIELDS = new Set([
  "policyVersion",
  "policyId",
  "preferExistingCode",
  "preferStandardLibrary",
  "preferNativePlatform",
  "preferInstalledDependencies",
  "newDependencyRequiresJustification",
  "newDependencyRequiresAlternatives",
  "newAbstractionRequiresJustification",
  "newAbstractionMinReuseSites",
  "unrequestedDependencyBehavior",
  "unrequestedAbstractionBehavior",
  "unrequestedRefactorBehavior",
  "highRiskBehavior",
  "maxPlannedFiles",
  "maxNewDependencies",
  "maxNewAbstractions"
]);
const RAW_PLAN_FIELDS = new Set([
  "planVersion",
  "riskClass",
  "taskExplicitlyRequestsRefactor",
  "plannedFiles",
  "newDependencies",
  "newAbstractions"
]);
const PLANNED_FILE_FIELDS = new Set([
  "path",
  "changeKind",
  "requested",
  "justification"
]);
const DEPENDENCY_FIELDS = new Set([
  "name",
  "requested",
  "purpose",
  "justification",
  "standardLibraryConsidered",
  "nativePlatformConsidered",
  "existingDependenciesConsidered",
  "whyExistingInsufficient"
]);
const ABSTRACTION_FIELDS = new Set([
  "abstractionId",
  "filePath",
  "requested",
  "purpose",
  "justification",
  "reuseSites",
  "whyInlineInsufficient"
]);
const RISK_CLASSES = new Set<MinimalityRiskClass>([
  "low",
  "medium",
  "high",
  "critical"
]);
const BEHAVIORS = new Set<MinimalityBehavior>([
  "allow_with_justification",
  "human_review",
  "replan"
]);
const HIGH_RISK_BEHAVIORS = new Set<MinimalityHighRiskBehavior>([
  "disabled",
  "human_review"
]);
const CHANGE_KINDS = new Set<MinimalityPlannedChangeKind>([
  "bugfix",
  "config",
  "dependency",
  "docs",
  "feature",
  "refactor",
  "test"
]);

class MinimalityFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly filePath?: string,
    readonly itemName?: string
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertAcyclic(
  value: unknown,
  active = new WeakSet<object>(),
  visited = new WeakSet<object>()
): void {
  if (value === null || typeof value !== "object") return;
  if (active.has(value)) {
    throw new MinimalityFailure(
      "minimality_cycle_detected",
      "Minimality input must be acyclic."
    );
  }
  if (visited.has(value)) return;
  active.add(value);
  for (const child of Object.values(value)) assertAcyclic(child, active, visited);
  active.delete(value);
  visited.add(value);
}

function exactRecord(value: unknown, fields: ReadonlySet<string>, label: string): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new MinimalityFailure(
      "minimality_structure_invalid",
      `${label} must be a plain object.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !fields.has(key) ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new MinimalityFailure(
        "minimality_structure_invalid",
        `${label} contains an unknown or accessor field.`,
        key
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new MinimalityFailure(
        "minimality_field_missing",
        `${label} is missing a required field.`,
        field
      );
    }
  }
  return value as PlainRecord;
}

function requireString(value: unknown, label: string, maximum = MAX_TEXT_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value)
  ) {
    throw new MinimalityFailure(
      "minimality_value_invalid",
      `${label} must be a bounded non-empty string.`,
      label
    );
  }
  return value;
}

function requireOptionalString(
  value: unknown,
  label: string,
  maximum = MAX_TEXT_LENGTH
): string | null {
  if (value === null) return null;
  return requireString(value, label, maximum);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new MinimalityFailure(
      "minimality_boolean_invalid",
      `${label} must be a boolean.`,
      label
    );
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new MinimalityFailure(
      "minimality_hash_invalid",
      `${label} must be a sha256 hash.`,
      label
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label, 160);
  if (!IDENTIFIER.test(identifier)) {
    throw new MinimalityFailure(
      "minimality_identifier_invalid",
      `${label} must be a bounded identifier.`,
      label
    );
  }
  return identifier;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new MinimalityFailure(
      "minimality_integer_invalid",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
      label
    );
  }
  return value as number;
}

function normalizePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new MinimalityFailure(
      "minimality_path_invalid",
      `${label} must be a safe repository-relative path.`,
      label
    );
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new MinimalityFailure(
      "minimality_path_escape",
      `${label} must not escape the repository.`,
      label,
      normalized
    );
  }
  return normalized;
}

function normalizePackageName(value: unknown, label: string): string {
  const name = requireString(value, label, 214).toLowerCase();
  if (!PACKAGE_NAME.test(name)) {
    throw new MinimalityFailure(
      "minimality_package_invalid",
      `${label} must be a valid package name.`,
      label,
      undefined,
      name
    );
  }
  return name;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizePathList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new MinimalityFailure(
      "minimality_path_list_invalid",
      `${label} must be an array with at most ${maximum} entries.`,
      label
    );
  }
  const normalized = value.map((entry) => normalizePath(entry, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new MinimalityFailure(
      "minimality_path_duplicate",
      `${label} must not contain duplicates.`,
      label
    );
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeReferenceList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new MinimalityFailure(
      "minimality_reference_list_invalid",
      `${label} must be an array with at most ${maximum} entries.`,
      label
    );
  }
  const normalized = value.map((entry) => requireString(entry, label, MAX_REFERENCE_LENGTH));
  if (new Set(normalized).size !== normalized.length) {
    throw new MinimalityFailure(
      "minimality_reference_duplicate",
      `${label} must not contain duplicates.`,
      label
    );
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function policyMaterial(policy: PreventiveMinimalityPolicyDraft): Record<string, unknown> {
  return { ...policy };
}

export function createPreventiveMinimalityPolicy(
  input: PreventiveMinimalityPolicyDraft
): PreventiveMinimalityPolicy {
  assertAcyclic(input);
  const record = exactRecord(input, POLICY_FIELDS, "Preventive minimality policy");
  if (record.policyVersion !== PREVENTIVE_MINIMALITY_POLICY_VERSION) {
    throw new MinimalityFailure(
      "minimality_policy_version_invalid",
      "policyVersion must be 1.",
      "policyVersion"
    );
  }
  const behavior = (value: unknown, label: string): MinimalityBehavior => {
    if (!BEHAVIORS.has(value as MinimalityBehavior)) {
      throw new MinimalityFailure(
        "minimality_behavior_invalid",
        `${label} is invalid.`,
        label
      );
    }
    return value as MinimalityBehavior;
  };
  if (!HIGH_RISK_BEHAVIORS.has(record.highRiskBehavior as MinimalityHighRiskBehavior)) {
    throw new MinimalityFailure(
      "minimality_high_risk_behavior_invalid",
      "highRiskBehavior is invalid.",
      "highRiskBehavior"
    );
  }
  const normalized: PreventiveMinimalityPolicyDraft = {
    policyVersion: PREVENTIVE_MINIMALITY_POLICY_VERSION,
    policyId: requireIdentifier(record.policyId, "policyId"),
    preferExistingCode: requireBoolean(record.preferExistingCode, "preferExistingCode"),
    preferStandardLibrary: requireBoolean(record.preferStandardLibrary, "preferStandardLibrary"),
    preferNativePlatform: requireBoolean(record.preferNativePlatform, "preferNativePlatform"),
    preferInstalledDependencies: requireBoolean(
      record.preferInstalledDependencies,
      "preferInstalledDependencies"
    ),
    newDependencyRequiresJustification: requireBoolean(
      record.newDependencyRequiresJustification,
      "newDependencyRequiresJustification"
    ),
    newDependencyRequiresAlternatives: requireBoolean(
      record.newDependencyRequiresAlternatives,
      "newDependencyRequiresAlternatives"
    ),
    newAbstractionRequiresJustification: requireBoolean(
      record.newAbstractionRequiresJustification,
      "newAbstractionRequiresJustification"
    ),
    newAbstractionMinReuseSites: requireInteger(
      record.newAbstractionMinReuseSites,
      "newAbstractionMinReuseSites",
      0,
      100
    ),
    unrequestedDependencyBehavior: behavior(
      record.unrequestedDependencyBehavior,
      "unrequestedDependencyBehavior"
    ),
    unrequestedAbstractionBehavior: behavior(
      record.unrequestedAbstractionBehavior,
      "unrequestedAbstractionBehavior"
    ),
    unrequestedRefactorBehavior: behavior(
      record.unrequestedRefactorBehavior,
      "unrequestedRefactorBehavior"
    ),
    highRiskBehavior: record.highRiskBehavior as MinimalityHighRiskBehavior,
    maxPlannedFiles: requireInteger(
      record.maxPlannedFiles,
      "maxPlannedFiles",
      1,
      HARD_MAX_PLANNED_FILES
    ),
    maxNewDependencies: requireInteger(
      record.maxNewDependencies,
      "maxNewDependencies",
      0,
      HARD_MAX_NEW_DEPENDENCIES
    ),
    maxNewAbstractions: requireInteger(
      record.maxNewAbstractions,
      "maxNewAbstractions",
      0,
      HARD_MAX_NEW_ABSTRACTIONS
    )
  };
  return deepFreeze({
    ...normalized,
    policyHash: hashCanonicalJson(policyMaterial(normalized))
  });
}

export function verifyPreventiveMinimalityPolicy(policy: PreventiveMinimalityPolicy): boolean {
  try {
    const { policyHash, ...withoutHash } = policy;
    return (
      policy.policyVersion === PREVENTIVE_MINIMALITY_POLICY_VERSION &&
      HASH.test(policyHash) &&
      policyHash === hashCanonicalJson(policyMaterial(withoutHash))
    );
  } catch {
    return false;
  }
}

function normalizePlannedFiles(value: unknown): MinimalityPlannedFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > HARD_MAX_PLANNED_FILES) {
    throw new MinimalityFailure(
      "minimality_planned_files_invalid",
      "plannedFiles must contain between 1 and the hard limit entries.",
      "plannedFiles"
    );
  }
  const normalized = value.map((entry, index) => {
    const record = exactRecord(entry, PLANNED_FILE_FIELDS, `plannedFiles[${index}]`);
    if (!CHANGE_KINDS.has(record.changeKind as MinimalityPlannedChangeKind)) {
      throw new MinimalityFailure(
        "minimality_change_kind_invalid",
        `plannedFiles[${index}].changeKind is invalid.`,
        `plannedFiles[${index}].changeKind`
      );
    }
    return {
      path: normalizePath(record.path, `plannedFiles[${index}].path`),
      changeKind: record.changeKind as MinimalityPlannedChangeKind,
      requested: requireBoolean(record.requested, `plannedFiles[${index}].requested`),
      justification: requireOptionalString(
        record.justification,
        `plannedFiles[${index}].justification`
      )
    };
  });
  const paths = normalized.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new MinimalityFailure(
      "minimality_planned_file_duplicate",
      "plannedFiles must not contain duplicate paths.",
      "plannedFiles"
    );
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeDependencies(value: unknown): MinimalityDependencyPlan[] {
  if (!Array.isArray(value) || value.length > HARD_MAX_NEW_DEPENDENCIES) {
    throw new MinimalityFailure(
      "minimality_dependencies_invalid",
      "newDependencies exceeds the hard limit.",
      "newDependencies"
    );
  }
  const normalized = value.map((entry, index) => {
    const record = exactRecord(entry, DEPENDENCY_FIELDS, `newDependencies[${index}]`);
    return {
      name: normalizePackageName(record.name, `newDependencies[${index}].name`),
      requested: requireBoolean(record.requested, `newDependencies[${index}].requested`),
      purpose: requireString(record.purpose, `newDependencies[${index}].purpose`),
      justification: requireOptionalString(
        record.justification,
        `newDependencies[${index}].justification`
      ),
      standardLibraryConsidered: requireBoolean(
        record.standardLibraryConsidered,
        `newDependencies[${index}].standardLibraryConsidered`
      ),
      nativePlatformConsidered: requireBoolean(
        record.nativePlatformConsidered,
        `newDependencies[${index}].nativePlatformConsidered`
      ),
      existingDependenciesConsidered: (() => {
        if (!Array.isArray(record.existingDependenciesConsidered)) {
          throw new MinimalityFailure(
            "minimality_existing_dependencies_invalid",
            `newDependencies[${index}].existingDependenciesConsidered must be an array.`,
            `newDependencies[${index}].existingDependenciesConsidered`
          );
        }
        const names = record.existingDependenciesConsidered.map((candidate, candidateIndex) =>
          normalizePackageName(
            candidate,
            `newDependencies[${index}].existingDependenciesConsidered[${candidateIndex}]`
          )
        );
        if (new Set(names).size !== names.length) {
          throw new MinimalityFailure(
            "minimality_existing_dependency_duplicate",
            "existingDependenciesConsidered must not contain duplicates.",
            `newDependencies[${index}].existingDependenciesConsidered`
          );
        }
        return names.sort((left, right) => left.localeCompare(right));
      })(),
      whyExistingInsufficient: requireOptionalString(
        record.whyExistingInsufficient,
        `newDependencies[${index}].whyExistingInsufficient`
      )
    };
  });
  const names = normalized.map((entry) => entry.name);
  if (new Set(names).size !== names.length) {
    throw new MinimalityFailure(
      "minimality_dependency_duplicate",
      "newDependencies must not contain duplicate package names.",
      "newDependencies"
    );
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeAbstractions(value: unknown): MinimalityAbstractionPlan[] {
  if (!Array.isArray(value) || value.length > HARD_MAX_NEW_ABSTRACTIONS) {
    throw new MinimalityFailure(
      "minimality_abstractions_invalid",
      "newAbstractions exceeds the hard limit.",
      "newAbstractions"
    );
  }
  const normalized = value.map((entry, index) => {
    const record = exactRecord(entry, ABSTRACTION_FIELDS, `newAbstractions[${index}]`);
    return {
      abstractionId: requireIdentifier(
        record.abstractionId,
        `newAbstractions[${index}].abstractionId`
      ),
      filePath: normalizePath(record.filePath, `newAbstractions[${index}].filePath`),
      requested: requireBoolean(record.requested, `newAbstractions[${index}].requested`),
      purpose: requireString(record.purpose, `newAbstractions[${index}].purpose`),
      justification: requireOptionalString(
        record.justification,
        `newAbstractions[${index}].justification`
      ),
      reuseSites: normalizeReferenceList(
        record.reuseSites,
        `newAbstractions[${index}].reuseSites`,
        100
      ),
      whyInlineInsufficient: requireOptionalString(
        record.whyInlineInsufficient,
        `newAbstractions[${index}].whyInlineInsufficient`
      )
    };
  });
  const ids = normalized.map((entry) => entry.abstractionId);
  if (new Set(ids).size !== ids.length) {
    throw new MinimalityFailure(
      "minimality_abstraction_duplicate",
      "newAbstractions must not contain duplicate abstraction IDs.",
      "newAbstractions"
    );
  }
  return normalized.sort((left, right) => left.abstractionId.localeCompare(right.abstractionId));
}

function planMaterial(plan: Omit<PreventiveMinimalityPlan, "planHash">): Record<string, unknown> {
  return { ...plan };
}

export function createPreventiveMinimalityPlan(input: {
  rawPlan: unknown;
  taskId: string;
  objectiveHash: string;
  plannerProposalHash: string;
  intelligenceHash: string;
  policyHash: string;
}): PreventiveMinimalityPlan {
  assertAcyclic(input.rawPlan);
  const record = exactRecord(input.rawPlan, RAW_PLAN_FIELDS, "Preventive minimality plan");
  if (record.planVersion !== PREVENTIVE_MINIMALITY_PLAN_VERSION) {
    throw new MinimalityFailure(
      "minimality_plan_version_invalid",
      "planVersion must be 1.",
      "planVersion"
    );
  }
  if (!RISK_CLASSES.has(record.riskClass as MinimalityRiskClass)) {
    throw new MinimalityFailure(
      "minimality_risk_class_invalid",
      "riskClass is invalid.",
      "riskClass"
    );
  }
  const withoutHash: Omit<PreventiveMinimalityPlan, "planHash"> = {
    planVersion: PREVENTIVE_MINIMALITY_PLAN_VERSION,
    taskId: requireIdentifier(input.taskId, "taskId"),
    objectiveHash: requireHash(input.objectiveHash, "objectiveHash"),
    plannerProposalHash: requireHash(input.plannerProposalHash, "plannerProposalHash"),
    intelligenceHash: requireHash(input.intelligenceHash, "intelligenceHash"),
    policyHash: requireHash(input.policyHash, "policyHash"),
    riskClass: record.riskClass as MinimalityRiskClass,
    taskExplicitlyRequestsRefactor: requireBoolean(
      record.taskExplicitlyRequestsRefactor,
      "taskExplicitlyRequestsRefactor"
    ),
    plannedFiles: normalizePlannedFiles(record.plannedFiles),
    newDependencies: normalizeDependencies(record.newDependencies),
    newAbstractions: normalizeAbstractions(record.newAbstractions)
  };
  return deepFreeze({
    ...withoutHash,
    planHash: hashCanonicalJson(planMaterial(withoutHash))
  });
}

export function verifyPreventiveMinimalityPlan(plan: PreventiveMinimalityPlan): boolean {
  try {
    const { planHash, ...withoutHash } = plan;
    return (
      plan.planVersion === PREVENTIVE_MINIMALITY_PLAN_VERSION &&
      HASH.test(planHash) &&
      planHash === hashCanonicalJson(planMaterial(withoutHash))
    );
  } catch {
    return false;
  }
}

function issue(
  code: string,
  message: string,
  action: PreventiveMinimalityIssue["action"],
  extra: Pick<PreventiveMinimalityIssue, "field" | "filePath" | "itemName"> = {}
): PreventiveMinimalityIssue {
  return { code, message, action, ...extra };
}

function applyBehavior(
  behavior: MinimalityBehavior,
  issues: PreventiveMinimalityIssue[],
  codePrefix: string,
  message: string,
  extra: Pick<PreventiveMinimalityIssue, "field" | "filePath" | "itemName"> = {}
): void {
  if (behavior === "replan") {
    issues.push(issue(`${codePrefix}_replan_required`, message, "replan", extra));
  } else if (behavior === "human_review") {
    issues.push(issue(`${codePrefix}_human_review_required`, message, "human_review", extra));
  }
}

function sha256Bytes(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectDependencyInventory(input: {
  repositoryPath: string;
  relevantFiles: readonly string[];
  maxManifestFiles: number;
  maxManifestBytes: number;
}): Promise<RepositoryDependencyInventory> {
  const repositoryStat = await lstat(input.repositoryPath);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new MinimalityFailure(
      "minimality_repository_invalid",
      "repositoryPath must be a real directory.",
      "repositoryPath"
    );
  }
  const root = await realpath(input.repositoryPath);
  const candidates = new Set<string>(["package.json"]);
  for (const file of input.relevantFiles) {
    let current = path.posix.dirname(file);
    while (current !== "." && current !== "") {
      candidates.add(path.posix.join(current, "package.json"));
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const sortedCandidates = [...candidates].sort((left, right) => left.localeCompare(right));
  if (sortedCandidates.length > input.maxManifestFiles) {
    throw new MinimalityFailure(
      "minimality_manifest_file_limit",
      "Dependency manifest candidate count exceeds the configured limit.",
      "maxManifestFiles"
    );
  }
  const manifests: RepositoryDependencyManifest[] = [];
  for (const relativePath of sortedCandidates) {
    const absolutePath = path.resolve(root, relativePath);
    if (!isWithin(root, absolutePath)) {
      throw new MinimalityFailure(
        "minimality_manifest_path_escape",
        "A dependency manifest candidate escapes the repository.",
        "repositoryPath",
        relativePath
      );
    }
    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new MinimalityFailure(
        "minimality_manifest_symlink",
        "Dependency manifests must not be symlinks.",
        undefined,
        relativePath
      );
    }
    if (!stat.isFile() || stat.size > input.maxManifestBytes) {
      throw new MinimalityFailure(
        "minimality_manifest_invalid",
        "Dependency manifest must be a bounded regular file.",
        undefined,
        relativePath
      );
    }
    const bytes = await readFile(absolutePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new MinimalityFailure(
        "minimality_manifest_json_invalid",
        "Dependency manifest must contain valid JSON.",
        undefined,
        relativePath
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MinimalityFailure(
        "minimality_manifest_structure_invalid",
        "Dependency manifest root must be a JSON object.",
        undefined,
        relativePath
      );
    }
    const manifestRecord = parsed as Record<string, unknown>;
    const section = (name: string): string[] => {
      const value = manifestRecord[name];
      if (value === undefined) return [];
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new MinimalityFailure(
          "minimality_manifest_dependency_section_invalid",
          `${name} in a dependency manifest must be an object.`,
          name,
          relativePath
        );
      }
      return Object.keys(value as Record<string, unknown>)
        .map((entry) => normalizePackageName(entry, `${relativePath}.${name}`))
        .sort((left, right) => left.localeCompare(right));
    };
    manifests.push({
      path: relativePath,
      contentHash: sha256Bytes(bytes),
      dependencies: section("dependencies"),
      devDependencies: section("devDependencies"),
      optionalDependencies: section("optionalDependencies"),
      peerDependencies: section("peerDependencies")
    });
  }
  const installedDependencies = sortedUnique(
    manifests.flatMap((manifest) => [
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    ])
  );
  const material = {
    inventoryVersion: REPOSITORY_DEPENDENCY_INVENTORY_VERSION,
    manifestFiles: manifests.sort((left, right) => left.path.localeCompare(right.path)),
    installedDependencies
  };
  return deepFreeze({
    ...material,
    inventoryHash: hashCanonicalJson(material)
  });
}

async function inspectPlannedFileExistence(
  repositoryPath: string,
  plannedFiles: readonly MinimalityPlannedFile[]
): Promise<Set<string>> {
  const root = await realpath(repositoryPath);
  const missing = new Set<string>();
  for (const plannedFile of plannedFiles) {
    const absolutePath = path.resolve(root, plannedFile.path);
    if (!isWithin(root, absolutePath)) {
      throw new MinimalityFailure(
        "minimality_planned_file_path_escape",
        "A planned file escapes the repository.",
        undefined,
        plannedFile.path
      );
    }
    try {
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new MinimalityFailure(
          "minimality_planned_file_symlink",
          "Planned files must not be symlinks.",
          undefined,
          plannedFile.path
        );
      }
      if (!stat.isFile()) {
        throw new MinimalityFailure(
          "minimality_planned_file_not_regular",
          "An existing planned path must be a regular file.",
          undefined,
          plannedFile.path
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.add(plannedFile.path);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

export function verifyRepositoryDependencyInventory(
  inventory: RepositoryDependencyInventory
): boolean {
  try {
    const { inventoryHash, ...withoutHash } = inventory;
    return (
      inventory.inventoryVersion === REPOSITORY_DEPENDENCY_INVENTORY_VERSION &&
      HASH.test(inventoryHash) &&
      inventoryHash === hashCanonicalJson(withoutHash)
    );
  } catch {
    return false;
  }
}

function buildBaseline(input: {
  plan: PreventiveMinimalityPlan;
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
}): PreventiveMinimalityBaseline {
  const material = {
    baselineVersion: PREVENTIVE_MINIMALITY_BASELINE_VERSION,
    taskId: input.plan.taskId,
    objectiveHash: input.plan.objectiveHash,
    plannerProposalHash: input.plan.plannerProposalHash,
    intelligenceHash: input.plan.intelligenceHash,
    policyHash: input.plan.policyHash,
    planHash: input.plan.planHash,
    expectedFiles: input.plan.plannedFiles.map((entry) => entry.path),
    allowedFiles: input.allowedFiles,
    forbiddenFiles: input.forbiddenFiles,
    requestedRefactor: input.plan.taskExplicitlyRequestsRefactor,
    plannedDependencies: input.plan.newDependencies.map((entry) => ({
      name: entry.name,
      requested: entry.requested,
      justification: entry.justification
    })),
    plannedAbstractions: input.plan.newAbstractions.map((entry) => ({
      abstractionId: entry.abstractionId,
      filePath: entry.filePath,
      requested: entry.requested,
      justification: entry.justification
    }))
  };
  return deepFreeze({
    ...material,
    baselineHash: hashCanonicalJson(material)
  });
}

export function verifyPreventiveMinimalityBaseline(
  baseline: PreventiveMinimalityBaseline
): boolean {
  try {
    const { baselineHash, ...withoutHash } = baseline;
    return (
      baseline.baselineVersion === PREVENTIVE_MINIMALITY_BASELINE_VERSION &&
      HASH.test(baselineHash) &&
      baselineHash === hashCanonicalJson(withoutHash)
    );
  } catch {
    return false;
  }
}

function buildReceipt(input: {
  decision: Exclude<PreventiveMinimalityDecision, "minimality_plan_invalid">;
  route: Exclude<PreventiveMinimalityRoute, "stop_invalid">;
  plan: PreventiveMinimalityPlan;
  inventory: RepositoryDependencyInventory;
  baseline: PreventiveMinimalityBaseline;
  issues: readonly PreventiveMinimalityIssue[];
}): PreventiveMinimalityReceipt {
  const material = {
    receiptVersion: PREVENTIVE_MINIMALITY_RECEIPT_VERSION,
    decision: input.decision,
    route: input.route,
    taskId: input.plan.taskId,
    objectiveHash: input.plan.objectiveHash,
    plannerProposalHash: input.plan.plannerProposalHash,
    intelligenceHash: input.plan.intelligenceHash,
    policyHash: input.plan.policyHash,
    planHash: input.plan.planHash,
    dependencyInventoryHash: input.inventory.inventoryHash,
    baselineHash: input.baseline.baselineHash,
    issueCodes: sortedUnique(input.issues.map((entry) => entry.code))
  };
  return deepFreeze({
    ...material,
    receiptHash: hashCanonicalJson(material)
  });
}

export function verifyPreventiveMinimalityReceipt(
  receipt: PreventiveMinimalityReceipt
): boolean {
  try {
    const { receiptHash, ...withoutHash } = receipt;
    return (
      receipt.receiptVersion === PREVENTIVE_MINIMALITY_RECEIPT_VERSION &&
      HASH.test(receiptHash) &&
      receiptHash === hashCanonicalJson(withoutHash)
    );
  } catch {
    return false;
  }
}

function initialSummary(): EvaluatePreventiveMinimalityResult["summary"] {
  return {
    planIntegrityVerified: false,
    policyIntegrityVerified: false,
    identityMatched: false,
    plannerProposalMatched: false,
    intelligenceMatched: false,
    repositoryDependencyInventoryBuilt: false,
    plannedFileCount: 0,
    newPlannedFileCount: 0,
    newDependencyCount: 0,
    newAbstractionCount: 0,
    installedDependencyCount: 0,
    replanIssueCount: 0,
    justificationIssueCount: 0,
    humanReviewIssueCount: 0,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function invalidResult(
  summary: EvaluatePreventiveMinimalityResult["summary"],
  error: unknown
): EvaluatePreventiveMinimalityResult {
  const failure = error instanceof MinimalityFailure ? error : null;
  return deepFreeze({
    decision: "minimality_plan_invalid",
    route: "stop_invalid",
    issues: [issue(
      failure?.code ?? "minimality_plan_invalid",
      error instanceof Error ? error.message : "Preventive minimality evaluation failed.",
      "stop_invalid",
      {
        ...(failure?.field === undefined ? {} : { field: failure.field }),
        ...(failure?.filePath === undefined ? {} : { filePath: failure.filePath }),
        ...(failure?.itemName === undefined ? {} : { itemName: failure.itemName })
      }
    )],
    plan: null,
    dependencyInventory: null,
    baseline: null,
    receipt: null,
    summary
  });
}

export async function evaluatePreventiveMinimalityPlan(
  input: EvaluatePreventiveMinimalityInput
): Promise<EvaluatePreventiveMinimalityResult> {
  const summary = initialSummary();
  try {
    summary.policyIntegrityVerified = verifyPreventiveMinimalityPolicy(input.policy);
    summary.planIntegrityVerified = verifyPreventiveMinimalityPlan(input.plan);
    if (!summary.policyIntegrityVerified) {
      throw new MinimalityFailure(
        "minimality_policy_integrity_invalid",
        "Preventive minimality policy integrity verification failed."
      );
    }
    if (!summary.planIntegrityVerified) {
      throw new MinimalityFailure(
        "minimality_plan_integrity_invalid",
        "Preventive minimality plan integrity verification failed."
      );
    }
    if (input.plan.policyHash !== input.policy.policyHash) {
      throw new MinimalityFailure(
        "minimality_policy_binding_mismatch",
        "Minimality plan is not bound to the active policy."
      );
    }
    summary.identityMatched =
      input.plan.taskId === input.expectedTaskId &&
      input.plan.objectiveHash === input.expectedObjectiveHash;
    summary.plannerProposalMatched =
      input.plan.plannerProposalHash === input.expectedPlannerProposalHash;
    summary.intelligenceMatched =
      input.plan.intelligenceHash === input.expectedIntelligenceHash;
    if (!summary.identityMatched) {
      throw new MinimalityFailure(
        "minimality_identity_mismatch",
        "Minimality task and objective identity do not match the expected task."
      );
    }
    if (!summary.plannerProposalMatched) {
      throw new MinimalityFailure(
        "minimality_planner_proposal_mismatch",
        "Minimality plan is stale or bound to another planner proposal."
      );
    }
    if (!summary.intelligenceMatched) {
      throw new MinimalityFailure(
        "minimality_intelligence_mismatch",
        "Minimality plan is stale or bound to another repository intelligence snapshot."
      );
    }
    const allowedFiles = normalizePathList(
      input.allowedFiles,
      "allowedFiles",
      HARD_MAX_PLANNED_FILES
    );
    if (allowedFiles.length === 0) {
      throw new MinimalityFailure(
        "minimality_allowed_files_empty",
        "allowedFiles must contain at least one path.",
        "allowedFiles"
      );
    }
    const forbiddenFiles = normalizePathList(
      input.forbiddenFiles ?? [],
      "forbiddenFiles",
      HARD_MAX_PLANNED_FILES
    );
    const allowedSet = new Set(allowedFiles);
    const forbiddenSet = new Set(forbiddenFiles);
    if (allowedFiles.some((entry) => forbiddenSet.has(entry))) {
      throw new MinimalityFailure(
        "minimality_scope_contract_invalid",
        "allowedFiles and forbiddenFiles must not overlap."
      );
    }
    const maxManifestFiles = requireInteger(
      input.maxManifestFiles ?? DEFAULT_MAX_MANIFEST_FILES,
      "maxManifestFiles",
      1,
      HARD_MAX_MANIFEST_FILES
    );
    const maxManifestBytes = requireInteger(
      input.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
      "maxManifestBytes",
      1,
      HARD_MAX_MANIFEST_BYTES
    );
    summary.plannedFileCount = input.plan.plannedFiles.length;
    summary.newDependencyCount = input.plan.newDependencies.length;
    summary.newAbstractionCount = input.plan.newAbstractions.length;

    const inventory = await collectDependencyInventory({
      repositoryPath: input.repositoryPath,
      relevantFiles: sortedUnique([
        ...allowedFiles,
        ...input.plan.plannedFiles.map((entry) => entry.path)
      ]),
      maxManifestFiles,
      maxManifestBytes
    });
    summary.repositoryDependencyInventoryBuilt = verifyRepositoryDependencyInventory(inventory);
    summary.installedDependencyCount = inventory.installedDependencies.length;
    if (!summary.repositoryDependencyInventoryBuilt) {
      throw new MinimalityFailure(
        "minimality_dependency_inventory_invalid",
        "Repository dependency inventory integrity verification failed."
      );
    }

    const missingPlannedFiles = await inspectPlannedFileExistence(
      input.repositoryPath,
      input.plan.plannedFiles
    );
    summary.newPlannedFileCount = missingPlannedFiles.size;

    const issues: PreventiveMinimalityIssue[] = [];
    if (input.plan.plannedFiles.length > input.policy.maxPlannedFiles) {
      issues.push(issue(
        "minimality_planned_file_budget_exceeded",
        "Planned file count exceeds the active minimality policy budget.",
        "replan",
        { field: "plannedFiles" }
      ));
    }
    if (input.plan.newDependencies.length > input.policy.maxNewDependencies) {
      issues.push(issue(
        "minimality_dependency_budget_exceeded",
        "New dependency count exceeds the active minimality policy budget.",
        "replan",
        { field: "newDependencies" }
      ));
    }
    if (input.plan.newAbstractions.length > input.policy.maxNewAbstractions) {
      issues.push(issue(
        "minimality_abstraction_budget_exceeded",
        "New abstraction count exceeds the active minimality policy budget.",
        "replan",
        { field: "newAbstractions" }
      ));
    }

    const plannedFileSet = new Set(input.plan.plannedFiles.map((entry) => entry.path));
    for (const plannedFile of input.plan.plannedFiles) {
      if (!allowedSet.has(plannedFile.path)) {
        issues.push(issue(
          "minimality_file_outside_allowed_scope",
          "A planned file is outside the authorized change scope.",
          "replan",
          { filePath: plannedFile.path }
        ));
      }
      if (forbiddenSet.has(plannedFile.path)) {
        issues.push(issue(
          "minimality_forbidden_file_planned",
          "A planned file is forbidden by the active scope policy.",
          "replan",
          { filePath: plannedFile.path }
        ));
      }
    }

    const highRisk = input.plan.riskClass === "high" || input.plan.riskClass === "critical";
    const policyDisabled = highRisk && input.policy.highRiskBehavior === "disabled";

    if (!policyDisabled) {
      for (const plannedFile of input.plan.plannedFiles) {
        if (
          input.policy.preferExistingCode &&
          missingPlannedFiles.has(plannedFile.path) &&
          !plannedFile.requested &&
          plannedFile.justification === null
        ) {
          issues.push(issue(
            "minimality_new_file_justification_missing",
            "A new unrequested file requires justification when existing code is preferred.",
            "request_justification",
            { filePath: plannedFile.path }
          ));
        }
        if (plannedFile.changeKind !== "refactor") continue;
        if (plannedFile.justification === null) {
          issues.push(issue(
            "minimality_refactor_justification_missing",
            "Every planned refactor requires a concrete justification.",
            "request_justification",
            { filePath: plannedFile.path }
          ));
        }
        if (!input.plan.taskExplicitlyRequestsRefactor && !plannedFile.requested) {
          applyBehavior(
            input.policy.unrequestedRefactorBehavior,
            issues,
            "minimality_unrequested_refactor",
            "The task did not request this refactor.",
            { filePath: plannedFile.path }
          );
        }
      }

      const installedSet = new Set(inventory.installedDependencies);
      for (const dependency of input.plan.newDependencies) {
        if (installedSet.has(dependency.name)) {
          issues.push(issue(
            "minimality_installed_dependency_should_be_reused",
            "A dependency declared as new is already installed and should be reused.",
            "replan",
            { itemName: dependency.name }
          ));
        }
        if (
          input.policy.newDependencyRequiresJustification &&
          dependency.justification === null
        ) {
          issues.push(issue(
            "minimality_dependency_justification_missing",
            "A new dependency requires a concrete justification.",
            "request_justification",
            { itemName: dependency.name }
          ));
        }
        if (
          input.policy.preferStandardLibrary &&
          !dependency.standardLibraryConsidered
        ) {
          issues.push(issue(
            "minimality_standard_library_not_considered",
            "The dependency plan must state whether the standard library can satisfy the task.",
            "request_justification",
            { itemName: dependency.name }
          ));
        }
        if (
          input.policy.preferNativePlatform &&
          !dependency.nativePlatformConsidered
        ) {
          issues.push(issue(
            "minimality_native_platform_not_considered",
            "The dependency plan must state whether native platform capability can satisfy the task.",
            "request_justification",
            { itemName: dependency.name }
          ));
        }
        if (input.policy.preferInstalledDependencies) {
          const unknownAlternatives = dependency.existingDependenciesConsidered.filter(
            (candidate) => !installedSet.has(candidate)
          );
          if (unknownAlternatives.length > 0) {
            issues.push(issue(
              "minimality_existing_dependency_claim_unverified",
              "The plan cites an existing dependency that is not present in the repository inventory.",
              "replan",
              { itemName: dependency.name }
            ));
          }
          if (
            input.policy.newDependencyRequiresAlternatives &&
            inventory.installedDependencies.length > 0 &&
            dependency.existingDependenciesConsidered.length === 0
          ) {
            issues.push(issue(
              "minimality_installed_alternatives_not_considered",
              "Installed dependencies must be considered before adding a new dependency.",
              "request_justification",
              { itemName: dependency.name }
            ));
          }
          if (
            dependency.existingDependenciesConsidered.length > 0 &&
            dependency.whyExistingInsufficient === null
          ) {
            issues.push(issue(
              "minimality_existing_alternatives_explanation_missing",
              "The plan must explain why considered installed dependencies are insufficient.",
              "request_justification",
              { itemName: dependency.name }
            ));
          }
        }
        if (!dependency.requested) {
          applyBehavior(
            input.policy.unrequestedDependencyBehavior,
            issues,
            "minimality_unrequested_dependency",
            "The task did not explicitly request this new dependency.",
            { itemName: dependency.name }
          );
        }
      }

      for (const abstraction of input.plan.newAbstractions) {
        if (!plannedFileSet.has(abstraction.filePath)) {
          issues.push(issue(
            "minimality_abstraction_target_not_planned",
            "A new abstraction must be located in a planned file.",
            "replan",
            { filePath: abstraction.filePath, itemName: abstraction.abstractionId }
          ));
        }
        if (
          input.policy.newAbstractionRequiresJustification &&
          abstraction.justification === null
        ) {
          issues.push(issue(
            "minimality_abstraction_justification_missing",
            "A new abstraction requires a concrete justification.",
            "request_justification",
            { itemName: abstraction.abstractionId }
          ));
        }
        if (abstraction.whyInlineInsufficient === null) {
          issues.push(issue(
            "minimality_inline_alternative_explanation_missing",
            "The plan must explain why an inline implementation is insufficient.",
            "request_justification",
            { itemName: abstraction.abstractionId }
          ));
        }
        if (abstraction.reuseSites.length < input.policy.newAbstractionMinReuseSites) {
          issues.push(issue(
            "minimality_abstraction_reuse_case_insufficient",
            "The abstraction does not meet the configured reuse-site requirement.",
            "request_justification",
            { itemName: abstraction.abstractionId }
          ));
        }
        if (!abstraction.requested) {
          applyBehavior(
            input.policy.unrequestedAbstractionBehavior,
            issues,
            "minimality_unrequested_abstraction",
            "The task did not explicitly request this new abstraction.",
            { itemName: abstraction.abstractionId, filePath: abstraction.filePath }
          );
        }
      }

      if (highRisk && input.policy.highRiskBehavior === "human_review") {
        issues.push(issue(
          "minimality_high_risk_human_review_required",
          "High-risk tasks require human review instead of automatic minimality enforcement.",
          "human_review",
          { field: "riskClass" }
        ));
      }
    }

    summary.replanIssueCount = issues.filter((entry) => entry.action === "replan").length;
    summary.justificationIssueCount = issues.filter(
      (entry) => entry.action === "request_justification"
    ).length;
    summary.humanReviewIssueCount = issues.filter(
      (entry) => entry.action === "human_review"
    ).length;

    let decision: Exclude<PreventiveMinimalityDecision, "minimality_plan_invalid">;
    let route: Exclude<PreventiveMinimalityRoute, "stop_invalid">;
    if (summary.replanIssueCount > 0) {
      decision = "minimality_replan_required";
      route = "request_planner_revision";
    } else if (summary.justificationIssueCount > 0) {
      decision = "minimality_justification_required";
      route = "request_planner_revision";
    } else if (summary.humanReviewIssueCount > 0) {
      decision = "minimality_human_review_required";
      route = "human_review";
    } else if (policyDisabled) {
      decision = "minimality_policy_disabled";
      route = "policy_bypassed";
    } else {
      decision = "minimality_plan_ready";
      route = "continue_to_coder";
    }

    const baseline = buildBaseline({ plan: input.plan, allowedFiles, forbiddenFiles });
    const receipt = buildReceipt({ decision, route, plan: input.plan, inventory, baseline, issues });
    return deepFreeze({
      decision,
      route,
      issues: issues.sort((left, right) => left.code.localeCompare(right.code)),
      plan: input.plan,
      dependencyInventory: inventory,
      baseline,
      receipt,
      summary
    });
  } catch (error) {
    return invalidResult(summary, error);
  }
}
