/**
 * Phase X.2 writes only a protected external rollback bundle and never writes
 * repository content or Git metadata, applies a mutation, or persists a
 * consumption key. Rollback payloads contain sensitive pre-apply bytes and
 * must be protected. Returned evidence contains hashes and metadata only and
 * intentionally omits the bundle path. The bundle is content-addressed and
 * atomically sealed. A future apply executor must verify it immediately before
 * apply, and a rollback executor must verify repository target state before
 * restoration. Controlled apply remains a later phase.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat
} from "node:fs/promises";
import path from "node:path";
import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import type {
  ControlledApplyHandoffPlan
} from "./controlled-apply-handoff.js";
import {
  inspectControlledRepository,
  type ControlledRepositoryInspection,
  type ControlledRepositoryInspectionResult,
  type ControlledRollbackFileEntry
} from "./controlled-repository-inspection.js";
import type {
  GovernedChangeArtifact,
  GovernedChangeFreshnessSnapshot,
  GovernedChangeKind
} from "./governed-change-artifact.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export const CONTROLLED_ROLLBACK_BUNDLE_VERSION = "1" as const;

export type ControlledRollbackBundleDecision =
  | "rollback_bundle_ready"
  | "rollback_bundle_blocked"
  | "rollback_bundle_invalid"
  | "rollback_bundle_needs_review";

export type ControlledRollbackBundleInput = {
  repositoryPath: string;
  bundleDirectoryPath: string;
  changedFiles: readonly string[];
  expectedInspection: ControlledRepositoryInspection;
  handoff: ControlledApplyHandoffPlan;
  artifact: GovernedChangeArtifact;
  currentFreshnessSnapshot: GovernedChangeFreshnessSnapshot;
  mutation: WorkspaceMutation;
  consumptionStatus: "not_consumed" | "already_consumed" | "unknown";
  timeoutMs?: number;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
};

export type ControlledRollbackAction =
  | "restore_regular_file"
  | "restore_symlink"
  | "remove_path";

export type ControlledRollbackPayloadEntry = {
  filePath: string;
  rollbackAction: ControlledRollbackAction;
  baseMode: "100644" | "100755" | "120000" | null;
  baseObjectId: string | null;
  payloadObjectHash: string | null;
  payloadRelativePath: string | null;
  payloadBytes: number;
  originallyPresent: boolean;
};

export type ControlledRollbackBundleManifest = {
  bundleVersion: "1";
  handoffHash: string;
  consumptionKey: string;
  governedArtifactHash: string;
  inspectionHash: string;
  rollbackManifestHash: string;
  target: {
    repositoryIdentityHash: string;
    baseRevisionHash: string;
    worktreeStateHash: string;
  };
  mutation: {
    changeKind: GovernedChangeKind;
    mutationHash: string;
    changedFiles: readonly string[];
  };
  entries: readonly ControlledRollbackPayloadEntry[];
  totalPayloadBytes: number;
  uniquePayloadObjectCount: number;
  restorationRequirements: {
    restrictRestorationToChangedFiles: true;
    removeOriginallyAbsentPaths: true;
    restoreRegularFileBytesExactly: true;
    restoreExecutableModes: true;
    recreateSymlinksWithoutFollowingTargets: true;
    rejectGitlinksWithoutExplicitSupport: true;
    verifyRepositoryTargetBeforeRollback: true;
    verifyRestoredWorktreeAfterRollback: true;
  };
  payloadRootHash: string;
  bundleManifestHash: string;
};

export type ControlledRollbackBundleReceipt = {
  bundleVersion: "1";
  bundleManifestHash: string;
  payloadRootHash: string;
  handoffHash: string;
  consumptionKey: string;
  inspectionHash: string;
  totalPayloadBytes: number;
  uniquePayloadObjectCount: number;
  changedFileCount: number;
  bundleSealed: true;
  repositoryWritePerformed: false;
  gitMutationPerformed: false;
  mutationApplied: false;
  consumptionRegistryWritten: false;
  receiptHash: string;
};

export type ControlledRollbackBundleIssueSeverity = "review" | "error";
export type ControlledRollbackBundleIssue = {
  code: string;
  message: string;
  severity: ControlledRollbackBundleIssueSeverity;
  field?: string;
  filePath?: string;
  hashValue?: string;
};

export type ControlledRollbackBundleResult = {
  decision: ControlledRollbackBundleDecision;
  issues: readonly ControlledRollbackBundleIssue[];
  manifest: ControlledRollbackBundleManifest | null;
  receipt: ControlledRollbackBundleReceipt | null;
  reinspection: ControlledRepositoryInspectionResult | null;
  summary: {
    inputValid: boolean;
    outputPathValid: boolean;
    outputOutsideRepository: boolean;
    outputOutsideGitDirectory: boolean;
    repositoryReinspected: boolean;
    repositoryStateMatched: boolean;
    handoffCurrent: boolean;
    handoffExecutionEligible: boolean;
    consumptionAvailable: boolean;
    rollbackManifestMatched: boolean;
    partialDirectoryCreated: boolean;
    partialDirectoryCleaned: boolean;
    payloadObjectsWritten: number;
    payloadObjectsVerified: number;
    payloadBytesWritten: number;
    manifestWritten: boolean;
    manifestVerified: boolean;
    bundleRenamedAtomically: boolean;
    finalBundleVerified: boolean;
    bundleSealed: boolean;
    rollbackPrepared: boolean;
    repositoryWritePerformed: false;
    gitMutationPerformed: false;
    mutationApplied: false;
    consumptionRegistryWritten: false;
  };
};

export type ControlledRollbackBundleVerificationInput = {
  bundleDirectoryPath: string;
  expectedManifest: ControlledRollbackBundleManifest;
  expectedReceipt: ControlledRollbackBundleReceipt;
  expectedHandoffHash: string;
  expectedConsumptionKey: string;
  expectedInspectionHash: string;
  maxEntryBytes?: number;
  maxBundleBytes?: number;
};

export type ControlledRollbackBundleVerificationDecision =
  | "rollback_bundle_current"
  | "rollback_bundle_stale"
  | "rollback_bundle_invalid";

export type ControlledRollbackBundleVerificationResult = {
  decision: ControlledRollbackBundleVerificationDecision;
  issues: readonly ControlledRollbackBundleIssue[];
  manifestIntegrityVerified: boolean;
  receiptIntegrityVerified: boolean;
  payloadRootVerified: boolean;
  payloadObjectsVerified: boolean;
  expectedBindingsMatched: boolean;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  rollbackUsable: boolean;
  summary: {
    bundleDirectoryValid: boolean;
    manifestFound: boolean;
    manifestParsed: boolean;
    unexpectedEntryCount: number;
    payloadObjectCount: number;
    payloadBytesRead: number;
    handoffMatched: boolean;
    consumptionKeyMatched: boolean;
    inspectionMatched: boolean;
    bundleSealed: boolean;
  };
};

type PlainRecord = Record<string, unknown>;
type Issue = ControlledRollbackBundleIssue;
type MaterialSummary = ControlledRollbackBundleResult["summary"];
type VerifySummary = ControlledRollbackBundleVerificationResult["summary"];

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const MAX_CLONED_NODES = 300_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_NAME = /^[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const MATERIAL_FIELDS = new Set([
  "repositoryPath", "bundleDirectoryPath", "changedFiles", "expectedInspection",
  "handoff", "artifact", "currentFreshnessSnapshot", "mutation", "consumptionStatus",
  "timeoutMs", "maxEntryBytes", "maxBundleBytes"
]);
const VERIFY_FIELDS = new Set([
  "bundleDirectoryPath", "expectedManifest", "expectedReceipt", "expectedHandoffHash",
  "expectedConsumptionKey", "expectedInspectionHash", "maxEntryBytes", "maxBundleBytes"
]);
const MANIFEST_FIELDS = new Set([
  "bundleVersion", "handoffHash", "consumptionKey", "governedArtifactHash",
  "inspectionHash", "rollbackManifestHash", "target", "mutation", "entries",
  "totalPayloadBytes", "uniquePayloadObjectCount", "restorationRequirements",
  "payloadRootHash", "bundleManifestHash"
]);
const TARGET_FIELDS = new Set([
  "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash"
]);
const MUTATION_BINDING_FIELDS = new Set(["changeKind", "mutationHash", "changedFiles"]);
const ENTRY_FIELDS = new Set([
  "filePath", "rollbackAction", "baseMode", "baseObjectId", "payloadObjectHash",
  "payloadRelativePath", "payloadBytes", "originallyPresent"
]);
const RECEIPT_FIELDS = new Set([
  "bundleVersion", "bundleManifestHash", "payloadRootHash", "handoffHash",
  "consumptionKey", "inspectionHash", "totalPayloadBytes", "uniquePayloadObjectCount",
  "changedFileCount", "bundleSealed", "repositoryWritePerformed", "gitMutationPerformed",
  "mutationApplied", "consumptionRegistryWritten", "receiptHash"
]);
const INSPECTION_FIELDS = new Set([
  "inspectionVersion", "target", "worktree", "rollbackManifest", "inspectionHash"
]);
const WORKTREE_FIELDS = new Set([
  "clean", "stagedChangeCount", "unstagedChangeCount", "untrackedFileCount",
  "conflictedFileCount", "changedPaths", "mergeInProgress", "rebaseInProgress",
  "cherryPickInProgress", "revertInProgress", "bisectInProgress"
]);
const ROLLBACK_MANIFEST_FIELDS = new Set([
  "manifestVersion", "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash",
  "changedFiles", "files", "restorationPolicy", "manifestHash"
]);
const ROLLBACK_FILE_FIELDS = new Set([
  "filePath", "baselineState", "baseObjectId", "baseMode", "existsInWorktree",
  "worktreeEntryKind", "worktreeContentHash"
]);
const ROLLBACK_POLICY_FIELDS = new Set([
  "restoreTrackedFilesFromBaseObjects", "removeFilesOriginallyAbsent",
  "restoreExecutableModes", "restoreSymlinksWithoutFollowingTargets",
  "restoreGitlinksWithoutEnteringSubmodules", "rejectWritesOutsideChangedFiles",
  "validateRestoredWorktreeState"
]);

const RESTORATION_REQUIREMENTS = {
  restrictRestorationToChangedFiles: true,
  removeOriginallyAbsentPaths: true,
  restoreRegularFileBytesExactly: true,
  restoreExecutableModes: true,
  recreateSymlinksWithoutFollowingTargets: true,
  rejectGitlinksWithoutExplicitSupport: true,
  verifyRepositoryTargetBeforeRollback: true,
  verifyRestoredWorktreeAfterRollback: true
} as const;
const RESTORATION_FIELDS = new Set(Object.keys(RESTORATION_REQUIREMENTS));

class BundleFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: "invalid" | "review" | "blocked" = "invalid",
    readonly field?: string,
    readonly filePath?: string,
    readonly hashValue?: string
  ) {
    super(message);
  }
}

class TrustedBundleConfigurationError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function bytesHash(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function issueFromFailure(error: BundleFailure): Issue {
  return {
    code: error.code,
    message: error.message,
    severity: error.kind === "review" ? "review" : "error",
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.filePath === undefined ? {} : { filePath: error.filePath }),
    ...(error.hashValue === undefined ? {} : { hashValue: error.hashValue })
  };
}

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  nodes = { count: 0 }
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") {
    throw new BundleFailure(
      "invalid_rollback_bundle_input",
      "Rollback bundle input contains an unsupported value."
    );
  }
  nodes.count += 1;
  if (nodes.count > MAX_CLONED_NODES || ancestors.has(value)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object",
      "Rollback bundle input is cyclic or exceeds its structure bound."
    );
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object",
      "Rollback bundle input contains an exotic object."
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new BundleFailure(
      "rollback_bundle_symbol_property",
      "Rollback bundle input must not contain symbol properties."
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  try {
    if (array) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        throw new BundleFailure(
          "rollback_bundle_accessor_property",
          "Rollback bundle arrays must have ordinary length properties."
        );
      }
      const length = lengthDescriptor.value;
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw new BundleFailure(
            "rollback_bundle_accessor_property",
            "Rollback bundle arrays must be dense data arrays."
          );
        }
        result.push(safeClone(descriptor.value, ancestors, nodes));
      }
      if (Object.keys(descriptors).some((key) =>
        key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
        throw new BundleFailure(
          "unknown_rollback_bundle_field",
          "Rollback bundle arrays must not contain named properties."
        );
      }
      return result;
    }
    const result: PlainRecord = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        throw new BundleFailure(
          "rollback_bundle_accessor_property",
          "Rollback bundle input must not contain accessor properties.",
          "invalid",
          key
        );
      }
      result[key] = safeClone(descriptor.value, ancestors, nodes);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function exactTop(value: unknown, fields: Set<string>, label: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BundleFailure("invalid_rollback_bundle_input", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", `${label} must be a plain object.`
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new BundleFailure(
      "rollback_bundle_symbol_property", `${label} must not contain symbol properties.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new BundleFailure(
        "rollback_bundle_accessor_property", `${label} must not contain accessors.`,
        "invalid", key
      );
    }
    if (!fields.has(key)) {
      throw new BundleFailure(
        "unknown_rollback_bundle_field", `${label} contains an unknown field.`,
        "invalid", key
      );
    }
  }
  return value as PlainRecord;
}

function requireFields(record: PlainRecord, fields: readonly string[]): void {
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw new BundleFailure(
        "missing_rollback_bundle_field", "Rollback bundle input is missing a required field.",
        "invalid", field
      );
    }
  }
}

function numericValue(
  record: PlainRecord,
  field: string,
  fallback: number,
  maximum: number
): number {
  if (!Object.hasOwn(record, field)) return fallback;
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TrustedBundleConfigurationError(
      `${field} must be a positive safe integer within its hard maximum.`
    );
  }
  return value;
}

function validateConfiguredPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH ||
      value.trim() !== value || ASCII_CONTROL.test(value)) {
    throw new BundleFailure(
      field === "bundleDirectoryPath"
        ? "rollback_bundle_output_path_invalid"
        : "invalid_rollback_bundle_input",
      "A configured rollback bundle path is invalid.",
      "invalid",
      field
    );
  }
  return path.resolve(value);
}

function isWithin(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoSymlinkComponents(candidate: string, includeFinal: boolean): Promise<void> {
  const parsed = path.parse(candidate);
  const relative = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const count = includeFinal ? relative.length : Math.max(0, relative.length - 1);
  for (const segment of relative.slice(0, count)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new BundleFailure(
        "rollback_bundle_output_parent_symlink",
        "The rollback bundle path resolves through a symbolic link."
      );
    }
  }
}

async function boundedMetadataPath(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_PATH_LENGTH) throw new Error("metadata path too long");
  const text = bytes.toString("utf8").trim();
  if (text.length === 0 || ASCII_CONTROL.test(text)) throw new Error("invalid metadata path");
  return text;
}

async function locateRepositoryBoundaries(repositoryPath: string): Promise<{
  root: string;
  gitCommonDirectory: string;
}> {
  let current = await realpath(repositoryPath);
  if (!(await stat(current)).isDirectory()) throw new Error("repository is not directory");
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (await pathExists(dotGit)) {
      const metadata = await lstat(dotGit);
      let gitDirectory: string;
      if (metadata.isDirectory()) {
        gitDirectory = await realpath(dotGit);
      } else if (metadata.isFile()) {
        const pointer = await boundedMetadataPath(dotGit);
        const match = /^gitdir: (.+)$/.exec(pointer);
        if (!match) throw new Error("invalid gitdir pointer");
        gitDirectory = await realpath(path.resolve(current, match[1] ?? ""));
      } else {
        throw new Error("unsupported git metadata entry");
      }
      const commonPointer = path.join(gitDirectory, "commondir");
      const gitCommonDirectory = await pathExists(commonPointer)
        ? await realpath(path.resolve(gitDirectory, await boundedMetadataPath(commonPointer)))
        : gitDirectory;
      return { root: await realpath(current), gitCommonDirectory };
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("repository root not found");
    current = parent;
  }
}

async function validateOutputLocation(
  configuredOutput: string,
  root: string,
  gitCommonDirectory: string,
  summary?: MaterialSummary
): Promise<{ finalPath: string; partialPath: string }> {
  const parent = path.dirname(configuredOutput);
  try {
    await assertNoSymlinkComponents(parent, true);
    const metadata = await stat(parent);
    if (!metadata.isDirectory()) throw new Error("parent not directory");
  } catch (error) {
    if (error instanceof BundleFailure) throw error;
    throw new BundleFailure(
      "rollback_bundle_output_path_invalid",
      "The rollback bundle parent must be an existing non-symlinked directory."
    );
  }
  const realParent = await realpath(parent);
  const finalPath = path.join(realParent, path.basename(configuredOutput));
  const partialPath = `${finalPath}.partial`;
  if (isWithin(finalPath, gitCommonDirectory) || isWithin(partialPath, gitCommonDirectory)) {
    throw new BundleFailure(
      "rollback_bundle_output_inside_git_directory",
      "The rollback bundle output must be outside Git metadata."
    );
  }
  if (summary) summary.outputOutsideGitDirectory = true;
  if (isWithin(finalPath, root) || isWithin(partialPath, root)) {
    throw new BundleFailure(
      "rollback_bundle_output_inside_repository",
      "The rollback bundle output must be outside the repository."
    );
  }
  if (summary) summary.outputOutsideRepository = true;
  if (await pathExists(finalPath)) {
    throw new BundleFailure(
      "rollback_bundle_output_already_exists",
      "The final rollback bundle path already exists."
    );
  }
  if (await pathExists(partialPath)) {
    throw new BundleFailure(
      "rollback_bundle_partial_already_exists",
      "The rollback bundle partial path already exists."
    );
  }
  if (summary) summary.outputPathValid = true;
  return { finalPath, partialPath };
}

function initialMaterialSummary(): MaterialSummary {
  return {
    inputValid: false,
    outputPathValid: false,
    outputOutsideRepository: false,
    outputOutsideGitDirectory: false,
    repositoryReinspected: false,
    repositoryStateMatched: false,
    handoffCurrent: false,
    handoffExecutionEligible: false,
    consumptionAvailable: false,
    rollbackManifestMatched: false,
    partialDirectoryCreated: false,
    partialDirectoryCleaned: false,
    payloadObjectsWritten: 0,
    payloadObjectsVerified: 0,
    payloadBytesWritten: 0,
    manifestWritten: false,
    manifestVerified: false,
    bundleRenamedAtomically: false,
    finalBundleVerified: false,
    bundleSealed: false,
    rollbackPrepared: false,
    repositoryWritePerformed: false,
    gitMutationPerformed: false,
    mutationApplied: false,
    consumptionRegistryWritten: false
  };
}

function initialVerifySummary(): VerifySummary {
  return {
    bundleDirectoryValid: false,
    manifestFound: false,
    manifestParsed: false,
    unexpectedEntryCount: 0,
    payloadObjectCount: 0,
    payloadBytesRead: 0,
    handoffMatched: false,
    consumptionKeyMatched: false,
    inspectionMatched: false,
    bundleSealed: false
  };
}

function finishMaterial(
  decision: ControlledRollbackBundleDecision,
  issues: Issue[],
  manifest: ControlledRollbackBundleManifest | null,
  receipt: ControlledRollbackBundleReceipt | null,
  reinspection: ControlledRepositoryInspectionResult | null,
  summary: MaterialSummary
): ControlledRollbackBundleResult {
  return deepFreeze({ decision, issues, manifest, receipt, reinspection, summary });
}

function finishVerify(
  decision: ControlledRollbackBundleVerificationDecision,
  issues: Issue[],
  manifestIntegrityVerified: boolean,
  receiptIntegrityVerified: boolean,
  payloadRootVerified: boolean,
  payloadObjectsVerified: boolean,
  staleFields: string[],
  reasonCodes: string[],
  summary: VerifySummary
): ControlledRollbackBundleVerificationResult {
  const normalizedStale = sortedUnique(staleFields);
  return deepFreeze({
    decision,
    issues,
    manifestIntegrityVerified,
    receiptIntegrityVerified,
    payloadRootVerified,
    payloadObjectsVerified,
    expectedBindingsMatched: normalizedStale.length === 0,
    staleFields: normalizedStale,
    reasonCodes: sortedUnique(reasonCodes),
    rollbackUsable: decision === "rollback_bundle_current",
    summary
  });
}

function verifyInspectionIntegrity(inspection: ControlledRepositoryInspection): void {
  const { inspectionHash, ...inspectionMaterial } = inspection;
  const { manifestHash, ...rollbackMaterial } = inspection.rollbackManifest;
  if (!HASH.test(inspectionHash) || !HASH.test(manifestHash) ||
      hashCanonicalJson(rollbackMaterial) !== manifestHash ||
      hashCanonicalJson(inspectionMaterial) !== inspectionHash) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The supplied X.1 inspection failed its independent integrity check."
    );
  }
}

function inspectionMatches(
  expected: ControlledRepositoryInspection,
  current: ControlledRepositoryInspection
): boolean {
  return expected.target.repositoryIdentityHash === current.target.repositoryIdentityHash &&
    expected.target.baseRevisionHash === current.target.baseRevisionHash &&
    expected.target.worktreeStateHash === current.target.worktreeStateHash &&
    canonicalEqual(expected.rollbackManifest.changedFiles, current.rollbackManifest.changedFiles) &&
    canonicalEqual(expected.rollbackManifest.files, current.rollbackManifest.files) &&
    expected.rollbackManifest.manifestHash === current.rollbackManifest.manifestHash &&
    expected.inspectionHash === current.inspectionHash;
}

async function readGitBlob(
  repositoryRoot: string,
  objectId: string,
  timeoutMs: number,
  maxEntryBytes: number
): Promise<Buffer> {
  if (!OBJECT_ID.test(objectId)) {
    throw new BundleFailure(
      "rollback_manifest_binding_mismatch",
      "A rollback object ID is invalid."
    );
  }
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["cat-file", "blob", objectId],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
          LANG: "C"
        },
        encoding: "buffer",
        timeout: timeoutMs,
        maxBuffer: maxEntryBytes + 1,
        windowsHide: true
      },
      (error, stdout) => {
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        if (bytes.length > maxEntryBytes) {
          reject(new BundleFailure(
            "rollback_entry_too_large",
            "A rollback payload exceeds the configured entry limit.",
            "review"
          ));
          return;
        }
        if (error) {
          const detail = error as NodeJS.ErrnoException & { killed?: boolean };
          reject(new BundleFailure(
            detail.killed || detail.code === "ETIMEDOUT"
              ? "rollback_payload_read_failed"
              : detail.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "rollback_entry_too_large"
                : "rollback_payload_read_failed",
            "A verified rollback payload could not be read.",
            detail.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "review" : "invalid"
          ));
          return;
        }
        resolve(bytes);
      }
    );
  });
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(filePath: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function payloadRoot(objects: Iterable<{ payloadObjectHash: string; payloadBytes: number }>): string {
  const unique = new Map<string, number>();
  for (const object of objects) unique.set(object.payloadObjectHash, object.payloadBytes);
  return hashCanonicalJson({
    artifactType: "controlled_rollback_payload_root",
    objects: [...unique].map(([payloadObjectHash, payloadBytes]) => ({
      payloadObjectHash, payloadBytes
    })).sort((left, right) => compareStrings(left.payloadObjectHash, right.payloadObjectHash))
  });
}

function manifestHashValid(manifest: ControlledRollbackBundleManifest): boolean {
  const { bundleManifestHash, ...material } = manifest;
  return HASH.test(bundleManifestHash) && hashCanonicalJson(material) === bundleManifestHash;
}

function receiptHashValid(receipt: ControlledRollbackBundleReceipt): boolean {
  const { receiptHash, ...material } = receipt;
  return HASH.test(receiptHash) && hashCanonicalJson(material) === receiptHash;
}

function validatePayloadRelativePath(value: string | null, expectedHash: string | null): boolean {
  if (expectedHash === null) return value === null;
  const hex = expectedHash.slice("sha256:".length);
  return HASH.test(expectedHash) && value === `objects/${hex}`;
}

function exactRuntimeRecord(value: unknown, fields: Set<string>, label: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", `${label} must be an exact object.`
    );
  }
  const record = value as PlainRecord;
  const keys = Object.keys(record);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", `${label} has an invalid field set.`
    );
  }
  return record;
}

function validChangedFile(file: unknown): file is string {
  if (typeof file !== "string" || file.length === 0 || file.length > MAX_PATH_LENGTH ||
      file.trim() !== file || ASCII_CONTROL.test(file) || file.includes("\\") ||
      path.posix.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) || /^(?:\\\\|\/\/)/.test(file)) {
    return false;
  }
  const segments = file.split("/");
  return !segments.some((segment) => segment === "" || segment === ".." || segment === ".git");
}

function validateManifestShape(value: unknown): ControlledRollbackBundleManifest {
  const record = exactRuntimeRecord(value, MANIFEST_FIELDS, "Rollback bundle manifest");
  if (record.bundleVersion !== "1") {
    throw new BundleFailure("invalid_rollback_bundle_object", "Bundle version is invalid.");
  }
  for (const field of [
    "handoffHash", "consumptionKey", "governedArtifactHash", "inspectionHash",
    "rollbackManifestHash", "payloadRootHash", "bundleManifestHash"
  ]) {
    if (typeof record[field] !== "string" || !HASH.test(record[field])) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "Bundle manifest contains an invalid hash.",
        "invalid", field
      );
    }
  }
  const target = exactRuntimeRecord(record.target, TARGET_FIELDS, "Bundle target");
  for (const field of TARGET_FIELDS) {
    if (typeof target[field] !== "string" || !HASH.test(target[field])) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "Bundle target contains an invalid hash.",
        "invalid", `target.${field}`
      );
    }
  }
  const mutation = exactRuntimeRecord(
    record.mutation, MUTATION_BINDING_FIELDS, "Bundle mutation binding"
  );
  if (mutation.changeKind !== "coder_patch_draft" && mutation.changeKind !== "repair_draft") {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Bundle mutation kind is invalid."
    );
  }
  if (typeof mutation.mutationHash !== "string" || !HASH.test(mutation.mutationHash) ||
      !Array.isArray(mutation.changedFiles) ||
      mutation.changedFiles.some((file) => !validChangedFile(file))) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Bundle mutation binding is invalid."
    );
  }
  const normalizedFiles = sortedUnique(mutation.changedFiles as string[]);
  if (!canonicalEqual(normalizedFiles, mutation.changedFiles)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Bundle changed files are not canonical."
    );
  }
  if (!Array.isArray(record.entries) || record.entries.length !== normalizedFiles.length) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Bundle entries do not match the changed-file count."
    );
  }
  const entries: ControlledRollbackPayloadEntry[] = [];
  for (const entryValue of record.entries) {
    const entry = exactRuntimeRecord(entryValue, ENTRY_FIELDS, "Rollback payload entry");
    if (!validChangedFile(entry.filePath) || !normalizedFiles.includes(entry.filePath)) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "A rollback payload entry has an invalid path."
      );
    }
    const action = entry.rollbackAction;
    if (action !== "restore_regular_file" && action !== "restore_symlink" &&
        action !== "remove_path") {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "A rollback payload action is invalid."
      );
    }
    if (!Number.isSafeInteger(entry.payloadBytes) || (entry.payloadBytes as number) < 0) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "A rollback payload byte count is invalid."
      );
    }
    if (action === "remove_path") {
      if (entry.baseMode !== null || entry.baseObjectId !== null ||
          entry.payloadObjectHash !== null || entry.payloadRelativePath !== null ||
          entry.payloadBytes !== 0 || entry.originallyPresent !== false) {
        throw new BundleFailure(
          "invalid_rollback_bundle_object", "An absent-path rollback entry is inconsistent."
        );
      }
    } else {
      const validMode = action === "restore_regular_file"
        ? entry.baseMode === "100644" || entry.baseMode === "100755"
        : entry.baseMode === "120000";
      if (!validMode || typeof entry.baseObjectId !== "string" ||
          !OBJECT_ID.test(entry.baseObjectId) || typeof entry.payloadObjectHash !== "string" ||
          !HASH.test(entry.payloadObjectHash) ||
          !validatePayloadRelativePath(
            entry.payloadRelativePath as string | null, entry.payloadObjectHash
          ) || entry.originallyPresent !== true) {
        throw new BundleFailure(
          "invalid_rollback_bundle_object", "A present-path rollback entry is inconsistent."
        );
      }
    }
    entries.push(entry as unknown as ControlledRollbackPayloadEntry);
  }
  entries.sort((left, right) => compareStrings(left.filePath, right.filePath));
  if (!canonicalEqual(entries, record.entries)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Rollback payload entries are not canonical."
    );
  }
  const requirements = exactRuntimeRecord(
    record.restorationRequirements, RESTORATION_FIELDS, "Restoration requirements"
  );
  if (Object.values(requirements).some((entry) => entry !== true)) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Restoration requirements are not strict."
    );
  }
  if (!Number.isSafeInteger(record.totalPayloadBytes) ||
      (record.totalPayloadBytes as number) < 0 ||
      !Number.isSafeInteger(record.uniquePayloadObjectCount) ||
      (record.uniquePayloadObjectCount as number) < 0) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Bundle payload totals are invalid."
    );
  }
  return record as unknown as ControlledRollbackBundleManifest;
}

function validateReceiptShape(value: unknown): ControlledRollbackBundleReceipt {
  const record = exactRuntimeRecord(value, RECEIPT_FIELDS, "Rollback bundle receipt");
  if (record.bundleVersion !== "1" || record.bundleSealed !== true ||
      record.repositoryWritePerformed !== false || record.gitMutationPerformed !== false ||
      record.mutationApplied !== false || record.consumptionRegistryWritten !== false) {
    throw new BundleFailure(
      "invalid_rollback_bundle_object", "Rollback bundle receipt safety fields are invalid."
    );
  }
  for (const field of [
    "bundleManifestHash", "payloadRootHash", "handoffHash", "consumptionKey",
    "inspectionHash", "receiptHash"
  ]) {
    if (typeof record[field] !== "string" || !HASH.test(record[field])) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "Rollback bundle receipt contains an invalid hash.",
        "invalid", field
      );
    }
  }
  for (const field of [
    "totalPayloadBytes", "uniquePayloadObjectCount", "changedFileCount"
  ]) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) {
      throw new BundleFailure(
        "invalid_rollback_bundle_object", "Rollback bundle receipt contains an invalid count.",
        "invalid", field
      );
    }
  }
  return record as unknown as ControlledRollbackBundleReceipt;
}

function validateExpectedInspectionShape(value: unknown): ControlledRepositoryInspection {
  const inspection = exactRuntimeRecord(value, INSPECTION_FIELDS, "Expected X.1 inspection");
  if (inspection.inspectionVersion !== "1" ||
      typeof inspection.inspectionHash !== "string" || !HASH.test(inspection.inspectionHash)) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 inspection header is invalid."
    );
  }
  const target = exactRuntimeRecord(inspection.target, TARGET_FIELDS, "X.1 target");
  if ([...TARGET_FIELDS].some((field) =>
    typeof target[field] !== "string" || !HASH.test(target[field]))) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 target hashes are invalid."
    );
  }
  const worktree = exactRuntimeRecord(inspection.worktree, WORKTREE_FIELDS, "X.1 worktree");
  for (const field of [
    "clean", "mergeInProgress", "rebaseInProgress", "cherryPickInProgress",
    "revertInProgress", "bisectInProgress"
  ]) {
    if (typeof worktree[field] !== "boolean") {
      throw new BundleFailure(
        "rollback_expected_inspection_integrity_mismatch",
        "The expected X.1 worktree flags are invalid."
      );
    }
  }
  for (const field of [
    "stagedChangeCount", "unstagedChangeCount", "untrackedFileCount", "conflictedFileCount"
  ]) {
    if (!Number.isSafeInteger(worktree[field]) || (worktree[field] as number) < 0) {
      throw new BundleFailure(
        "rollback_expected_inspection_integrity_mismatch",
        "The expected X.1 worktree counts are invalid."
      );
    }
  }
  if (!Array.isArray(worktree.changedPaths) || worktree.changedPaths.some((file) =>
    typeof file !== "string" || file.length === 0 || file.length > MAX_PATH_LENGTH ||
    ASCII_CONTROL.test(file))) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 worktree paths are invalid."
    );
  }
  const rollback = exactRuntimeRecord(
    inspection.rollbackManifest, ROLLBACK_MANIFEST_FIELDS, "X.1 rollback manifest"
  );
  if (rollback.manifestVersion !== "1") {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 rollback manifest version is invalid."
    );
  }
  for (const field of [
    "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash", "manifestHash"
  ]) {
    if (typeof rollback[field] !== "string" || !HASH.test(rollback[field])) {
      throw new BundleFailure(
        "rollback_expected_inspection_integrity_mismatch",
        "The expected X.1 rollback manifest hashes are invalid."
      );
    }
  }
  if (!Array.isArray(rollback.changedFiles) ||
      rollback.changedFiles.some((file) => !validChangedFile(file)) ||
      !canonicalEqual(rollback.changedFiles, sortedUnique(rollback.changedFiles as string[]))) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 changed-file scope is invalid."
    );
  }
  if (!Array.isArray(rollback.files) ||
      rollback.files.length !== rollback.changedFiles.length) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 rollback file entries are incomplete."
    );
  }
  const normalizedEntries: ControlledRollbackFileEntry[] = [];
  for (const value of rollback.files) {
    const entry = exactRuntimeRecord(value, ROLLBACK_FILE_FIELDS, "X.1 rollback file entry");
    if (!validChangedFile(entry.filePath) ||
        !(rollback.changedFiles as string[]).includes(entry.filePath as string) ||
        !["tracked_file", "tracked_symlink", "tracked_gitlink", "absent"].includes(
          entry.baselineState as string
        ) || typeof entry.existsInWorktree !== "boolean" ||
        !["regular_file", "symlink", "directory", "absent", "other"].includes(
          entry.worktreeEntryKind as string
        ) || (entry.worktreeContentHash !== null &&
          (typeof entry.worktreeContentHash !== "string" || !HASH.test(entry.worktreeContentHash)))) {
      throw new BundleFailure(
        "rollback_expected_inspection_integrity_mismatch",
        "An expected X.1 rollback file entry is invalid."
      );
    }
    if (entry.baselineState === "absent") {
      if (entry.baseObjectId !== null || entry.baseMode !== null) {
        throw new BundleFailure(
          "rollback_expected_inspection_integrity_mismatch",
          "An absent X.1 rollback file entry has base object evidence."
        );
      }
    } else if (typeof entry.baseObjectId !== "string" || !OBJECT_ID.test(entry.baseObjectId) ||
        !["100644", "100755", "120000", "160000"].includes(entry.baseMode as string)) {
      throw new BundleFailure(
        "rollback_expected_inspection_integrity_mismatch",
        "A tracked X.1 rollback file entry has invalid base evidence."
      );
    }
    normalizedEntries.push(entry as unknown as ControlledRollbackFileEntry);
  }
  normalizedEntries.sort((left, right) => compareStrings(left.filePath, right.filePath));
  if (!canonicalEqual(normalizedEntries, rollback.files)) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 rollback file entries are not canonical."
    );
  }
  const policy = exactRuntimeRecord(
    rollback.restorationPolicy, ROLLBACK_POLICY_FIELDS, "X.1 restoration policy"
  );
  if (Object.values(policy).some((flag) => flag !== true)) {
    throw new BundleFailure(
      "rollback_expected_inspection_integrity_mismatch",
      "The expected X.1 restoration policy is not strict."
    );
  }
  return inspection as unknown as ControlledRepositoryInspection;
}

export async function verifyControlledRollbackBundle(
  input: ControlledRollbackBundleVerificationInput
): Promise<ControlledRollbackBundleVerificationResult> {
  const summary = initialVerifySummary();
  const issues: Issue[] = [];
  try {
    const top = exactTop(input, VERIFY_FIELDS, "Rollback bundle verification input");
    requireFields(top, [
      "bundleDirectoryPath", "expectedManifest", "expectedReceipt", "expectedHandoffHash",
      "expectedConsumptionKey", "expectedInspectionHash"
    ]);
    const maxEntryBytes = numericValue(
      top, "maxEntryBytes", DEFAULT_ENTRY_BYTES, MAX_ENTRY_BYTES
    );
    const maxBundleBytes = numericValue(
      top, "maxBundleBytes", DEFAULT_BUNDLE_BYTES, MAX_BUNDLE_BYTES
    );
    const cloned = safeClone(top) as PlainRecord;
    const configuredPath = validateConfiguredPath(
      cloned.bundleDirectoryPath, "bundleDirectoryPath"
    );
    const expectedManifest = validateManifestShape(cloned.expectedManifest);
    const expectedReceipt = validateReceiptShape(cloned.expectedReceipt);
    for (const field of [
      "expectedHandoffHash", "expectedConsumptionKey", "expectedInspectionHash"
    ]) {
      if (typeof cloned[field] !== "string" || !HASH.test(cloned[field])) {
        throw new BundleFailure(
          "invalid_rollback_bundle_input", "A bundle verification binding hash is invalid.",
          "invalid", field
        );
      }
    }
    if (!manifestHashValid(expectedManifest)) {
      throw new BundleFailure(
        "rollback_bundle_manifest_hash_mismatch",
        "The expected rollback bundle manifest hash is invalid."
      );
    }
    if (!receiptHashValid(expectedReceipt)) {
      throw new BundleFailure(
        "rollback_bundle_receipt_hash_mismatch",
        "The expected rollback bundle receipt hash is invalid."
      );
    }

    await assertNoSymlinkComponents(configuredPath, false);
    const rootMetadata = await lstat(configuredPath);
    if (rootMetadata.isSymbolicLink()) {
      throw new BundleFailure(
        "rollback_bundle_symlink_detected",
        "The rollback bundle verification path is a symbolic link."
      );
    }
    if (!rootMetadata.isDirectory()) {
      throw new BundleFailure(
        "rollback_bundle_output_path_invalid",
        "The rollback bundle verification path is not a directory."
      );
    }
    const bundlePath = await realpath(configuredPath);
    summary.bundleDirectoryValid = true;

    const rootEntries = await readdir(bundlePath, { withFileTypes: true });
    const rootNames = rootEntries.map((entry) => entry.name).sort(compareStrings);
    const unexpectedRoot = rootEntries.filter((entry) =>
      (entry.name !== "bundle.json" || !entry.isFile()) &&
      (entry.name !== "objects" || !entry.isDirectory())
    );
    summary.unexpectedEntryCount += unexpectedRoot.length;
    if (!canonicalEqual(rootNames, ["bundle.json", "objects"]) || unexpectedRoot.length > 0) {
      throw new BundleFailure(
        "rollback_bundle_unexpected_entry",
        "The rollback bundle root contains unexpected entries."
      );
    }
    for (const entry of rootEntries) {
      if ((await lstat(path.join(bundlePath, entry.name))).isSymbolicLink()) {
        throw new BundleFailure(
          "rollback_bundle_symlink_detected",
          "The rollback bundle contains a symbolic link."
        );
      }
    }

    const bundleJsonPath = path.join(bundlePath, "bundle.json");
    summary.manifestFound = true;
    let manifestBytes: Buffer;
    try {
      manifestBytes = await readFile(bundleJsonPath);
    } catch {
      throw new BundleFailure(
        "rollback_manifest_verification_failed",
        "The rollback bundle manifest could not be read."
      );
    }
    if (manifestBytes.length > maxEntryBytes || manifestBytes.length > maxBundleBytes) {
      throw new BundleFailure(
        "rollback_bundle_size_limit_exceeded",
        "The rollback bundle manifest exceeds verification bounds."
      );
    }
    let diskValue: unknown;
    try {
      diskValue = JSON.parse(manifestBytes.toString("utf8"));
      summary.manifestParsed = true;
    } catch {
      throw new BundleFailure(
        "rollback_manifest_verification_failed",
        "The rollback bundle manifest is not valid JSON."
      );
    }
    const diskManifest = validateManifestShape(safeClone(diskValue));
    if (!manifestBytes.equals(Buffer.from(canonicalizeJson(diskManifest), "utf8"))) {
      throw new BundleFailure(
        "rollback_manifest_verification_failed",
        "The rollback bundle manifest is not canonically encoded."
      );
    }
    if (!manifestHashValid(diskManifest)) {
      throw new BundleFailure(
        "rollback_bundle_manifest_hash_mismatch",
        "The materialized rollback bundle manifest hash is invalid."
      );
    }
    const manifestIntegrityVerified = true;

    const expectedObjectMap = new Map<string, number>();
    for (const entry of diskManifest.entries) {
      if (entry.payloadObjectHash !== null) {
        const name = entry.payloadObjectHash.slice("sha256:".length);
        const previous = expectedObjectMap.get(name);
        if (previous !== undefined && previous !== entry.payloadBytes) {
          throw new BundleFailure(
            "rollback_bundle_manifest_hash_mismatch",
            "Duplicate rollback payload references have inconsistent byte counts."
          );
        }
        expectedObjectMap.set(name, entry.payloadBytes);
      }
    }
    if (expectedObjectMap.size !== diskManifest.uniquePayloadObjectCount) {
      throw new BundleFailure(
        "rollback_bundle_manifest_hash_mismatch",
        "The manifest object count is inconsistent."
      );
    }
    const objectsPath = path.join(bundlePath, "objects");
    const objectEntries = await readdir(objectsPath, { withFileTypes: true });
    summary.payloadObjectCount = objectEntries.length;
    const actualNames = objectEntries.map((entry) => entry.name).sort(compareStrings);
    const expectedNames = [...expectedObjectMap.keys()].sort(compareStrings);
    for (const entry of objectEntries) {
      const objectPath = path.join(objectsPath, entry.name);
      const metadata = await lstat(objectPath);
      if (metadata.isSymbolicLink()) {
        throw new BundleFailure(
          "rollback_bundle_symlink_detected",
          "The rollback bundle object store contains a symbolic link."
        );
      }
      if (!entry.isFile() || !OBJECT_NAME.test(entry.name)) {
        summary.unexpectedEntryCount += 1;
        throw new BundleFailure(
          "rollback_bundle_unexpected_entry",
          "The rollback bundle object store contains an unexpected entry."
        );
      }
    }
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const extra = actualNames.filter((name) => !expectedNames.includes(name));
    if (missing.length > 0) {
      throw new BundleFailure(
        "rollback_bundle_missing_object",
        "The rollback bundle is missing a required payload object."
      );
    }
    if (extra.length > 0) {
      summary.unexpectedEntryCount += extra.length;
      throw new BundleFailure(
        "rollback_bundle_extra_object",
        "The rollback bundle contains an additional payload object."
      );
    }

    const rootObjects: { payloadObjectHash: string; payloadBytes: number }[] = [];
    for (const name of expectedNames) {
      const objectPath = path.join(objectsPath, name);
      const metadata = await lstat(objectPath);
      if (metadata.size > maxEntryBytes) {
        throw new BundleFailure(
          "rollback_entry_too_large",
          "A rollback payload object exceeds the verification entry limit."
        );
      }
      if (manifestBytes.length + summary.payloadBytesRead + metadata.size > maxBundleBytes) {
        throw new BundleFailure(
          "rollback_bundle_size_limit_exceeded",
          "Rollback payload objects exceed the verification bundle limit."
        );
      }
      const bytes = await readFile(objectPath);
      if (bytes.length !== metadata.size || bytes.length !== expectedObjectMap.get(name)) {
        throw new BundleFailure(
          "rollback_payload_hash_mismatch",
          "A rollback payload object has an inconsistent byte count."
        );
      }
      summary.payloadBytesRead += bytes.length;
      const objectHash = bytesHash(bytes);
      if (objectHash !== `sha256:${name}`) {
        throw new BundleFailure(
          "rollback_payload_hash_mismatch",
          "A rollback payload object hash is invalid."
        );
      }
      rootObjects.push({ payloadObjectHash: objectHash, payloadBytes: bytes.length });
    }
    if (summary.payloadBytesRead !== diskManifest.totalPayloadBytes) {
      throw new BundleFailure(
        "rollback_bundle_payload_root_mismatch",
        "The rollback bundle payload byte total is inconsistent."
      );
    }
    const computedPayloadRoot = payloadRoot(rootObjects);
    if (computedPayloadRoot !== diskManifest.payloadRootHash) {
      throw new BundleFailure(
        "rollback_bundle_payload_root_mismatch",
        "The rollback bundle payload root hash is invalid."
      );
    }
    const payloadRootVerified = true;
    const payloadObjectsVerified = true;

    const staleFields: string[] = [];
    const reasonCodes: string[] = [];
    const manifestComparisons = [
      ["handoffHash", diskManifest.handoffHash, expectedManifest.handoffHash],
      ["consumptionKey", diskManifest.consumptionKey, expectedManifest.consumptionKey],
      ["inspectionHash", diskManifest.inspectionHash, expectedManifest.inspectionHash],
      ["rollbackManifestHash", diskManifest.rollbackManifestHash,
        expectedManifest.rollbackManifestHash],
      ["governedArtifactHash", diskManifest.governedArtifactHash,
        expectedManifest.governedArtifactHash],
      ["mutationHash", diskManifest.mutation.mutationHash,
        expectedManifest.mutation.mutationHash],
      ["changedFiles", canonicalizeJson(diskManifest.mutation.changedFiles),
        canonicalizeJson(expectedManifest.mutation.changedFiles)],
      ["target", canonicalizeJson(diskManifest.target), canonicalizeJson(expectedManifest.target)],
      ["payloadRootHash", diskManifest.payloadRootHash, expectedManifest.payloadRootHash],
      ["bundleManifestHash", diskManifest.bundleManifestHash,
        expectedManifest.bundleManifestHash]
    ] as const;
    for (const [field, current, expected] of manifestComparisons) {
      if (current !== expected) staleFields.push(field);
    }
    if (!canonicalEqual(diskManifest, expectedManifest)) {
      staleFields.push("bundleManifestHash");
      reasonCodes.push("rollback_bundle_expected_manifest_mismatch");
    }
    summary.handoffMatched = diskManifest.handoffHash === cloned.expectedHandoffHash;
    summary.consumptionKeyMatched =
      diskManifest.consumptionKey === cloned.expectedConsumptionKey;
    summary.inspectionMatched = diskManifest.inspectionHash === cloned.expectedInspectionHash;
    if (!summary.handoffMatched) staleFields.push("handoffHash");
    if (!summary.consumptionKeyMatched) staleFields.push("consumptionKey");
    if (!summary.inspectionMatched) staleFields.push("inspectionHash");
    if (expectedReceipt.bundleManifestHash !== diskManifest.bundleManifestHash) {
      staleFields.push("bundleManifestHash");
    }
    if (expectedReceipt.payloadRootHash !== diskManifest.payloadRootHash) {
      staleFields.push("payloadRootHash");
    }
    if (expectedReceipt.handoffHash !== diskManifest.handoffHash) staleFields.push("handoffHash");
    if (expectedReceipt.consumptionKey !== diskManifest.consumptionKey) {
      staleFields.push("consumptionKey");
    }
    if (expectedReceipt.inspectionHash !== diskManifest.inspectionHash) {
      staleFields.push("inspectionHash");
    }
    if (expectedReceipt.totalPayloadBytes !== diskManifest.totalPayloadBytes ||
        expectedReceipt.uniquePayloadObjectCount !== diskManifest.uniquePayloadObjectCount ||
        expectedReceipt.changedFileCount !== diskManifest.mutation.changedFiles.length) {
      staleFields.push("receiptHash");
    }
    const receiptIntegrityVerified = true;
    const normalizedStale = sortedUnique(staleFields);
    if (normalizedStale.length > 0) reasonCodes.push("rollback_bundle_bindings_stale");
    summary.bundleSealed = normalizedStale.length === 0;
    return finishVerify(
      normalizedStale.length === 0 ? "rollback_bundle_current" : "rollback_bundle_stale",
      issues,
      manifestIntegrityVerified,
      receiptIntegrityVerified,
      payloadRootVerified,
      payloadObjectsVerified,
      normalizedStale,
      reasonCodes,
      summary
    );
  } catch (error) {
    if (error instanceof TrustedBundleConfigurationError) throw error;
    const failure = error instanceof BundleFailure ? error : new BundleFailure(
      "rollback_bundle_exception",
      "Rollback bundle verification failed without exposing unbounded details."
    );
    issues.push(issueFromFailure(failure));
    return finishVerify(
      "rollback_bundle_invalid", issues, false, false, false, false, [],
      [failure.code], summary
    );
  }
}

export async function materializeControlledRollbackBundle(
  input: ControlledRollbackBundleInput
): Promise<ControlledRollbackBundleResult> {
  const summary = initialMaterialSummary();
  const issues: Issue[] = [];
  let reinspection: ControlledRepositoryInspectionResult | null = null;
  let partialPath: string | null = null;
  let finalPath: string | null = null;
  let partialCreated = false;
  let finalCreated = false;
  try {
    const top = exactTop(input, MATERIAL_FIELDS, "Rollback bundle input");
    requireFields(top, [
      "repositoryPath", "bundleDirectoryPath", "changedFiles", "expectedInspection",
      "handoff", "artifact", "currentFreshnessSnapshot", "mutation", "consumptionStatus"
    ]);
    const timeoutMs = numericValue(top, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxEntryBytes = numericValue(
      top, "maxEntryBytes", DEFAULT_ENTRY_BYTES, MAX_ENTRY_BYTES
    );
    const maxBundleBytes = numericValue(
      top, "maxBundleBytes", DEFAULT_BUNDLE_BYTES, MAX_BUNDLE_BYTES
    );
    const cloned = safeClone(top) as PlainRecord;
    const repositoryPath = validateConfiguredPath(cloned.repositoryPath, "repositoryPath");
    const bundleDirectoryPath = validateConfiguredPath(
      cloned.bundleDirectoryPath, "bundleDirectoryPath"
    );
    if (!Array.isArray(cloned.changedFiles) ||
        cloned.changedFiles.some((file) => !validChangedFile(file))) {
      throw new BundleFailure(
        "invalid_rollback_bundle_input",
        "Rollback bundle changed files are invalid.",
        "invalid",
        "changedFiles"
      );
    }
    const changedFiles = sortedUnique(cloned.changedFiles as string[]);
    if (cloned.consumptionStatus !== "not_consumed" &&
        cloned.consumptionStatus !== "already_consumed" &&
        cloned.consumptionStatus !== "unknown") {
      throw new BundleFailure(
        "invalid_rollback_bundle_input",
        "Rollback bundle consumption status is invalid.",
        "invalid",
        "consumptionStatus"
      );
    }
    const expectedInspection = validateExpectedInspectionShape(cloned.expectedInspection);
    verifyInspectionIntegrity(expectedInspection);
    summary.inputValid = true;

    let boundaries: { root: string; gitCommonDirectory: string };
    try {
      boundaries = await locateRepositoryBoundaries(repositoryPath);
    } catch {
      throw new BundleFailure(
        "rollback_repository_reinspection_failed",
        "Repository boundaries could not be safely resolved before rollback preparation."
      );
    }
    const output = await validateOutputLocation(
      bundleDirectoryPath, boundaries.root, boundaries.gitCommonDirectory, summary
    );
    finalPath = output.finalPath;
    partialPath = output.partialPath;

    reinspection = await inspectControlledRepository({
      repositoryPath,
      changedFiles,
      expectedTarget: (cloned.handoff as ControlledApplyHandoffPlan).target,
      handoff: cloned.handoff as ControlledApplyHandoffPlan,
      artifact: cloned.artifact as GovernedChangeArtifact,
      currentFreshnessSnapshot:
        cloned.currentFreshnessSnapshot as GovernedChangeFreshnessSnapshot,
      mutation: cloned.mutation as WorkspaceMutation,
      consumptionStatus: cloned.consumptionStatus as
        "not_consumed" | "already_consumed" | "unknown",
      timeoutMs
    });
    summary.repositoryReinspected = true;
    summary.handoffCurrent = reinspection.handoffVerification?.decision ===
      "controlled_apply_handoff_current";
    summary.handoffExecutionEligible =
      reinspection.handoffVerification?.executionEligible === true &&
      reinspection.summary.handoffExecutionEligible;
    summary.consumptionAvailable = cloned.consumptionStatus === "not_consumed";

    if (cloned.consumptionStatus === "already_consumed") {
      throw new BundleFailure(
        "rollback_handoff_consumed",
        "Rollback preparation is blocked because the handoff is already consumed.",
        "blocked"
      );
    }
    if (cloned.consumptionStatus === "unknown") {
      throw new BundleFailure(
        "rollback_consumption_status_unknown",
        "Rollback preparation is blocked because consumption availability is unknown.",
        "blocked"
      );
    }
    if (reinspection.handoffVerification?.decision ===
        "controlled_apply_handoff_verification_invalid") {
      throw new BundleFailure(
        "rollback_handoff_not_current",
        "The controlled apply handoff failed integrity verification.",
        "invalid"
      );
    }
    if (reinspection.decision !== "repository_inspection_ready" ||
        reinspection.inspection === null) {
      const kind = reinspection.decision === "repository_inspection_needs_review"
        ? "review"
        : reinspection.decision === "repository_inspection_invalid"
          ? "invalid"
          : "blocked";
      throw new BundleFailure(
        "rollback_repository_reinspection_failed",
        "The immediate repository reinspection did not permit rollback preparation.",
        kind
      );
    }
    if (!summary.handoffCurrent) {
      throw new BundleFailure(
        "rollback_handoff_not_current",
        "The controlled apply handoff is not current.",
        "blocked"
      );
    }
    if (!summary.handoffExecutionEligible) {
      throw new BundleFailure(
        "rollback_handoff_not_execution_eligible",
        "The controlled apply handoff is not execution eligible.",
        "blocked"
      );
    }

    const currentInspection = reinspection.inspection;
    if (!inspectionMatches(expectedInspection, currentInspection)) {
      throw new BundleFailure(
        "rollback_repository_state_changed",
        "Repository evidence changed after the supplied X.1 inspection.",
        "blocked"
      );
    }
    summary.repositoryStateMatched = true;
    summary.rollbackManifestMatched = true;

    const handoff = cloned.handoff as ControlledApplyHandoffPlan;
    const artifact = cloned.artifact as GovernedChangeArtifact;
    const rollbackManifest = currentInspection.rollbackManifest;
    if (!canonicalEqual(changedFiles, rollbackManifest.changedFiles) ||
        !canonicalEqual(changedFiles, handoff.mutation.changedFiles)) {
      throw new BundleFailure(
        "rollback_changed_files_mismatch",
        "Rollback preparation changed files do not match governed evidence.",
        "invalid"
      );
    }
    if (handoff.target.repositoryIdentityHash !==
          currentInspection.target.repositoryIdentityHash ||
        handoff.target.baseRevisionHash !== currentInspection.target.baseRevisionHash ||
        handoff.target.worktreeStateHash !== currentInspection.target.worktreeStateHash ||
        handoff.evidence.governedArtifactHash !== artifact.governedArtifactHash) {
      throw new BundleFailure(
        "rollback_mutation_binding_mismatch",
        "Rollback preparation bindings do not match current governed evidence.",
        "invalid"
      );
    }
    const gitlink = rollbackManifest.files.find((entry) =>
      entry.baselineState === "tracked_gitlink");
    if (gitlink) {
      throw new BundleFailure(
        "rollback_gitlink_not_supported",
        "Automatic rollback payload preparation does not support gitlinks.",
        "review",
        undefined,
        gitlink.filePath
      );
    }

    try {
      await mkdir(partialPath, { mode: 0o700 });
      partialCreated = true;
      summary.partialDirectoryCreated = true;
      await mkdir(path.join(partialPath, "objects"), { mode: 0o700 });
    } catch {
      throw new BundleFailure(
        "rollback_partial_directory_creation_failed",
        "The rollback bundle partial directory could not be created exclusively."
      );
    }

    const objectBuffers = new Map<string, Buffer>();
    const objectSizes = new Map<string, number>();
    const entries: ControlledRollbackPayloadEntry[] = [];
    for (const source of rollbackManifest.files) {
      if (source.baselineState === "absent") {
        entries.push({
          filePath: source.filePath,
          rollbackAction: "remove_path",
          baseMode: null,
          baseObjectId: null,
          payloadObjectHash: null,
          payloadRelativePath: null,
          payloadBytes: 0,
          originallyPresent: false
        });
        continue;
      }
      if (source.baselineState !== "tracked_file" &&
          source.baselineState !== "tracked_symlink") {
        throw new BundleFailure(
          "rollback_gitlink_not_supported",
          "A rollback entry type is not supported for automatic preparation.",
          "review",
          undefined,
          source.filePath
        );
      }
      if (source.baseObjectId === null || source.baseMode === null) {
        throw new BundleFailure(
          "rollback_manifest_binding_mismatch",
          "A rollback manifest entry is missing its base object binding."
        );
      }
      let bytes = objectBuffers.get(source.baseObjectId);
      if (bytes === undefined) {
        bytes = await readGitBlob(
          boundaries.root, source.baseObjectId, timeoutMs, maxEntryBytes
        );
        objectBuffers.set(source.baseObjectId, bytes);
      }
      const objectHash = bytesHash(bytes);
      if (source.worktreeContentHash !== objectHash) {
        throw new BundleFailure(
          "rollback_payload_hash_mismatch",
          "Rollback payload bytes do not match the inspected pre-apply worktree evidence.",
          "invalid",
          undefined,
          source.filePath
        );
      }
      const objectName = objectHash.slice("sha256:".length);
      if (!objectSizes.has(objectHash)) {
        if (summary.payloadBytesWritten + bytes.length > maxBundleBytes) {
          throw new BundleFailure(
            "rollback_bundle_size_limit_exceeded",
            "Rollback payload objects exceed the configured bundle limit.",
            "review"
          );
        }
        const objectPath = path.join(partialPath, "objects", objectName);
        try {
          await writeExclusive(objectPath, bytes);
        } catch {
          throw new BundleFailure(
            "rollback_object_write_failed",
            "A rollback payload object could not be written exclusively."
          );
        }
        objectSizes.set(objectHash, bytes.length);
        summary.payloadObjectsWritten += 1;
        summary.payloadBytesWritten += bytes.length;
      }
      entries.push({
        filePath: source.filePath,
        rollbackAction: source.baselineState === "tracked_symlink"
          ? "restore_symlink"
          : "restore_regular_file",
        baseMode: source.baseMode as "100644" | "100755" | "120000",
        baseObjectId: source.baseObjectId,
        payloadObjectHash: objectHash,
        payloadRelativePath: `objects/${objectName}`,
        payloadBytes: bytes.length,
        originallyPresent: true
      });
    }
    entries.sort((left, right) => compareStrings(left.filePath, right.filePath));
    objectBuffers.clear();

    const payloadObjects = [...objectSizes].map(([payloadObjectHash, payloadBytes]) => ({
      payloadObjectHash, payloadBytes
    }));
    for (const object of payloadObjects) {
      const objectPath = path.join(
        partialPath, "objects", object.payloadObjectHash.slice("sha256:".length)
      );
      let bytes: Buffer;
      try {
        const metadata = await lstat(objectPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== object.payloadBytes) {
          throw new Error("invalid object metadata");
        }
        bytes = await readFile(objectPath);
      } catch {
        throw new BundleFailure(
          "rollback_object_verification_failed",
          "A materialized rollback payload object could not be verified."
        );
      }
      if (bytesHash(bytes) !== object.payloadObjectHash) {
        throw new BundleFailure(
          "rollback_object_verification_failed",
          "A materialized rollback payload object hash is invalid."
        );
      }
      summary.payloadObjectsVerified += 1;
    }

    const manifestWithoutHash = {
      bundleVersion: "1" as const,
      handoffHash: handoff.handoffHash,
      consumptionKey: handoff.singleUse.consumptionKey,
      governedArtifactHash: artifact.governedArtifactHash,
      inspectionHash: currentInspection.inspectionHash,
      rollbackManifestHash: rollbackManifest.manifestHash,
      target: { ...currentInspection.target },
      mutation: {
        changeKind: handoff.mutation.changeKind,
        mutationHash: handoff.mutation.mutationHash,
        changedFiles: [...handoff.mutation.changedFiles]
      },
      entries,
      totalPayloadBytes: summary.payloadBytesWritten,
      uniquePayloadObjectCount: objectSizes.size,
      restorationRequirements: RESTORATION_REQUIREMENTS,
      payloadRootHash: payloadRoot(payloadObjects)
    };
    const manifest: ControlledRollbackBundleManifest = {
      ...manifestWithoutHash,
      bundleManifestHash: hashCanonicalJson(manifestWithoutHash)
    };
    const manifestBytes = Buffer.from(canonicalizeJson(manifest), "utf8");
    if (manifestBytes.length > maxEntryBytes ||
        summary.payloadBytesWritten + manifestBytes.length > maxBundleBytes) {
      throw new BundleFailure(
        "rollback_bundle_size_limit_exceeded",
        "Rollback bundle metadata exceeds the configured bundle limit.",
        "review"
      );
    }
    try {
      await writeExclusive(path.join(partialPath, "bundle.json"), manifestBytes);
      summary.manifestWritten = true;
    } catch {
      throw new BundleFailure(
        "rollback_manifest_write_failed",
        "The rollback bundle manifest could not be written exclusively."
      );
    }
    try {
      const writtenManifest = await readFile(path.join(partialPath, "bundle.json"));
      const parsed = validateManifestShape(safeClone(JSON.parse(writtenManifest.toString("utf8"))));
      if (!writtenManifest.equals(manifestBytes) || !canonicalEqual(parsed, manifest) ||
          !manifestHashValid(parsed)) {
        throw new Error("manifest mismatch");
      }
      summary.manifestVerified = true;
    } catch {
      throw new BundleFailure(
        "rollback_manifest_verification_failed",
        "The materialized rollback bundle manifest could not be verified."
      );
    }

    const partialNames = (await readdir(partialPath)).sort(compareStrings);
    if (!canonicalEqual(partialNames, ["bundle.json", "objects"])) {
      throw new BundleFailure(
        "rollback_bundle_unexpected_entry",
        "The rollback bundle partial directory contains an unexpected entry."
      );
    }
    await fsyncDirectory(path.join(partialPath, "objects"));
    await fsyncDirectory(partialPath);
    try {
      if (await pathExists(finalPath)) {
        throw new Error("final path appeared before rename");
      }
      await rename(partialPath, finalPath);
      partialCreated = false;
      finalCreated = true;
      await fsyncDirectory(path.dirname(finalPath));
      summary.bundleRenamedAtomically = true;
    } catch {
      throw new BundleFailure(
        "rollback_atomic_rename_failed",
        "The rollback bundle could not be atomically sealed."
      );
    }

    const receiptWithoutHash = {
      bundleVersion: "1" as const,
      bundleManifestHash: manifest.bundleManifestHash,
      payloadRootHash: manifest.payloadRootHash,
      handoffHash: manifest.handoffHash,
      consumptionKey: manifest.consumptionKey,
      inspectionHash: manifest.inspectionHash,
      totalPayloadBytes: manifest.totalPayloadBytes,
      uniquePayloadObjectCount: manifest.uniquePayloadObjectCount,
      changedFileCount: manifest.mutation.changedFiles.length,
      bundleSealed: true as const,
      repositoryWritePerformed: false as const,
      gitMutationPerformed: false as const,
      mutationApplied: false as const,
      consumptionRegistryWritten: false as const
    };
    const receipt: ControlledRollbackBundleReceipt = {
      ...receiptWithoutHash,
      receiptHash: hashCanonicalJson(receiptWithoutHash)
    };
    const finalVerification = await verifyControlledRollbackBundle({
      bundleDirectoryPath: finalPath,
      expectedManifest: manifest,
      expectedReceipt: receipt,
      expectedHandoffHash: manifest.handoffHash,
      expectedConsumptionKey: manifest.consumptionKey,
      expectedInspectionHash: manifest.inspectionHash,
      maxEntryBytes,
      maxBundleBytes
    });
    if (finalVerification.decision !== "rollback_bundle_current" ||
        !finalVerification.rollbackUsable) {
      throw new BundleFailure(
        "rollback_manifest_verification_failed",
        "The atomically renamed rollback bundle failed final verification."
      );
    }
    summary.finalBundleVerified = true;
    summary.bundleSealed = true;
    summary.rollbackPrepared = true;
    return finishMaterial(
      "rollback_bundle_ready", issues, manifest, receipt, reinspection, summary
    );
  } catch (error) {
    if (error instanceof TrustedBundleConfigurationError) throw error;
    if (partialCreated && partialPath !== null) {
      try {
        await rm(partialPath, { recursive: true, force: false });
        summary.partialDirectoryCleaned = true;
      } catch {
        issues.push({
          code: "rollback_partial_cleanup_failed",
          message: "The current invocation's partial rollback directory could not be cleaned.",
          severity: "error"
        });
      }
    }
    if (finalCreated && finalPath !== null && !summary.finalBundleVerified) {
      try {
        await rm(finalPath, { recursive: true, force: false });
      } catch {
        issues.push({
          code: "rollback_partial_cleanup_failed",
          message: "The unverified bundle created by this invocation could not be cleaned.",
          severity: "error"
        });
      }
    }
    const failure = error instanceof BundleFailure ? error : new BundleFailure(
      "rollback_bundle_exception",
      "Rollback bundle materialization failed without exposing unbounded details."
    );
    issues.push(issueFromFailure(failure));
    const decision: ControlledRollbackBundleDecision =
      issues.some((issue) => issue.code === "rollback_partial_cleanup_failed")
        ? "rollback_bundle_invalid"
        : failure.kind === "review"
          ? "rollback_bundle_needs_review"
          : failure.kind === "blocked"
            ? "rollback_bundle_blocked"
            : "rollback_bundle_invalid";
    return finishMaterial(decision, issues, null, null, reinspection, summary);
  }
}
