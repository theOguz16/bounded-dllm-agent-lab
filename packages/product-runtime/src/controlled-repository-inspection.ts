/**
 * Phase X.1 is a read-only security boundary. It runs only explicitly
 * allowlisted Git inspection operations and never applies or writes a
 * mutation. Repository paths and remote URLs are never returned; regular-file
 * contents and symlink targets are hashed and not retained. The rollback
 * manifest contains metadata only and no rollback snapshot is materialized.
 * A ready inspection is not apply authorization. A future executor must
 * reinspect immediately before its first write; rollback materialization and
 * controlled apply remain later Phase X work.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  deriveGovernedMutationChangedFiles,
  verifyControlledApplyHandoff,
  type ControlledApplyHandoffPlan,
  type ControlledApplyHandoffVerificationResult,
  type ControlledApplyTargetSnapshot
} from "./controlled-apply-handoff.js";
import type {
  GovernedChangeArtifact,
  GovernedChangeFreshnessSnapshot
} from "./governed-change-artifact.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export const CONTROLLED_REPOSITORY_INSPECTION_VERSION = "1" as const;

export type ControlledRepositoryInspectionDecision =
  | "repository_inspection_ready"
  | "repository_inspection_blocked"
  | "repository_inspection_invalid"
  | "repository_inspection_needs_review";

export type ControlledRepositoryInspectionInput = {
  repositoryPath: string;
  changedFiles: readonly string[];
  expectedTarget?: ControlledApplyTargetSnapshot;
  handoff?: ControlledApplyHandoffPlan;
  artifact?: GovernedChangeArtifact;
  currentFreshnessSnapshot?: GovernedChangeFreshnessSnapshot;
  mutation?: WorkspaceMutation;
  consumptionStatus?: "not_consumed" | "already_consumed" | "unknown";
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledRepositoryWorktreeSummary = {
  clean: boolean;
  stagedChangeCount: number;
  unstagedChangeCount: number;
  untrackedFileCount: number;
  conflictedFileCount: number;
  changedPaths: readonly string[];
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  cherryPickInProgress: boolean;
  revertInProgress: boolean;
  bisectInProgress: boolean;
};

export type InspectedControlledApplyTarget = {
  repositoryIdentityHash: string;
  baseRevisionHash: string;
  worktreeStateHash: string;
};

export type ControlledRollbackFileEntry = {
  filePath: string;
  baselineState: "tracked_file" | "tracked_symlink" | "tracked_gitlink" | "absent";
  baseObjectId: string | null;
  baseMode: "100644" | "100755" | "120000" | "160000" | null;
  existsInWorktree: boolean;
  worktreeEntryKind: "regular_file" | "symlink" | "directory" | "absent" | "other";
  worktreeContentHash: string | null;
};

export type ControlledRollbackManifest = {
  manifestVersion: "1";
  repositoryIdentityHash: string;
  baseRevisionHash: string;
  worktreeStateHash: string;
  changedFiles: readonly string[];
  files: readonly ControlledRollbackFileEntry[];
  restorationPolicy: {
    restoreTrackedFilesFromBaseObjects: true;
    removeFilesOriginallyAbsent: true;
    restoreExecutableModes: true;
    restoreSymlinksWithoutFollowingTargets: true;
    restoreGitlinksWithoutEnteringSubmodules: true;
    rejectWritesOutsideChangedFiles: true;
    validateRestoredWorktreeState: true;
  };
  manifestHash: string;
};

export type ControlledRepositoryInspection = {
  inspectionVersion: "1";
  target: InspectedControlledApplyTarget;
  worktree: ControlledRepositoryWorktreeSummary;
  rollbackManifest: ControlledRollbackManifest;
  inspectionHash: string;
};

export type ControlledRepositoryInspectionIssueSeverity = "review" | "error";
export type ControlledRepositoryInspectionIssue = {
  code: string;
  message: string;
  severity: ControlledRepositoryInspectionIssueSeverity;
  filePath?: string;
  field?: string;
};

export type ControlledRepositoryInspectionResult = {
  decision: ControlledRepositoryInspectionDecision;
  issues: readonly ControlledRepositoryInspectionIssue[];
  inspection: ControlledRepositoryInspection | null;
  handoffVerification: ControlledApplyHandoffVerificationResult | null;
  summary: {
    repositoryRecognized: boolean;
    repositoryInsideWorktree: boolean;
    repositoryIdentityComputed: boolean;
    baseRevisionComputed: boolean;
    worktreeStateComputed: boolean;
    worktreeClean: boolean;
    repositoryOperationInProgress: boolean;
    changedFilesValid: boolean;
    changedFileCount: number;
    rollbackManifestBuilt: boolean;
    expectedTargetProvided: boolean;
    expectedTargetMatched: boolean;
    handoffProvided: boolean;
    handoffVerified: boolean;
    handoffExecutionEligible: boolean;
    inspectionHashValid: boolean;
    rollbackManifestHashValid: boolean;
    gitCommandCount: number;
    fileBytesRead: number;
    repositoryWritePerformed: false;
    gitMutationPerformed: false;
    rollbackMaterialized: false;
  };
};

type Issue = ControlledRepositoryInspectionIssue;
type Summary = ControlledRepositoryInspectionResult["summary"];
type PlainRecord = Record<string, unknown>;
type ObjectFormat = "sha1" | "sha256";
type StatusRecord = {
  recordType: "ordinary" | "renamed" | "unmerged" | "untracked";
  indexStatus: string;
  worktreeStatus: string;
  filePath: string;
  originalPath?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 200 * 1024 * 1024;
const MAX_CHANGED_FILES = 1_000;
const MAX_PATH_LENGTH = 4_096;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SHA1_OID = /^[0-9a-f]{40}$/;
const SHA256_OID = /^[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^(?:\\\\|\/\/)/;
const INPUT_FIELDS = new Set([
  "repositoryPath", "changedFiles", "expectedTarget", "handoff", "artifact",
  "currentFreshnessSnapshot", "mutation", "consumptionStatus", "timeoutMs",
  "maxGitOutputBytes"
]);
const TARGET_FIELDS = new Set([
  "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash"
]);

const RESTORATION_POLICY = {
  restoreTrackedFilesFromBaseObjects: true,
  removeFilesOriginallyAbsent: true,
  restoreExecutableModes: true,
  restoreSymlinksWithoutFollowingTargets: true,
  restoreGitlinksWithoutEnteringSubmodules: true,
  rejectWritesOutsideChangedFiles: true,
  validateRestoredWorktreeState: true
} as const;

class InspectionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: "invalid" | "review" | "blocked" = "invalid",
    readonly field?: string,
    readonly filePath?: string
  ) {
    super(message);
  }
}

class GitFailure extends InspectionFailure {}

class TrustedConfigurationTypeError extends TypeError {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function initialSummary(): Summary {
  return {
    repositoryRecognized: false,
    repositoryInsideWorktree: false,
    repositoryIdentityComputed: false,
    baseRevisionComputed: false,
    worktreeStateComputed: false,
    worktreeClean: false,
    repositoryOperationInProgress: false,
    changedFilesValid: false,
    changedFileCount: 0,
    rollbackManifestBuilt: false,
    expectedTargetProvided: false,
    expectedTargetMatched: false,
    handoffProvided: false,
    handoffVerified: false,
    handoffExecutionEligible: false,
    inspectionHashValid: false,
    rollbackManifestHashValid: false,
    gitCommandCount: 0,
    fileBytesRead: 0,
    repositoryWritePerformed: false,
    gitMutationPerformed: false,
    rollbackMaterialized: false
  };
}

function finish(
  decision: ControlledRepositoryInspectionDecision,
  issues: Issue[],
  inspection: ControlledRepositoryInspection | null,
  handoffVerification: ControlledApplyHandoffVerificationResult | null,
  summary: Summary
): ControlledRepositoryInspectionResult {
  return deepFreeze({ decision, issues, inspection, handoffVerification, summary });
}

function issueFromFailure(error: InspectionFailure): Issue {
  return {
    code: error.code,
    message: error.message,
    severity: error.kind === "review" ? "review" : "error",
    ...(error.filePath === undefined ? {} : { filePath: error.filePath }),
    ...(error.field === undefined ? {} : { field: error.field })
  };
}

function exactPlainObject(value: unknown, fields: Set<string>, label: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InspectionFailure(
      "invalid_repository_inspection_input",
      `${label} must be a plain object.`
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InspectionFailure(
      "invalid_repository_inspection_object",
      `${label} must not be a class instance or exotic object.`
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new InspectionFailure(
      "repository_inspection_symbol_property",
      `${label} must not contain symbol properties.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new InspectionFailure(
        "repository_inspection_accessor_property",
        `${label} must not contain accessor properties.`,
        "invalid",
        key
      );
    }
    if (!fields.has(key)) {
      throw new InspectionFailure(
        "unknown_repository_inspection_field",
        `${label} contains an unknown field.`,
        "invalid",
        key
      );
    }
  }
  return value as PlainRecord;
}

function requireOwn(record: PlainRecord, field: string): unknown {
  if (!Object.hasOwn(record, field)) {
    throw new InspectionFailure(
      "missing_repository_inspection_field",
      "Repository inspection input is missing a required field.",
      "invalid",
      field
    );
  }
  return record[field];
}

function numericConfiguration(
  record: PlainRecord,
  field: "timeoutMs" | "maxGitOutputBytes",
  defaultValue: number,
  maximum: number
): number {
  if (!Object.hasOwn(record, field)) return defaultValue;
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TrustedConfigurationTypeError(
      `${field} must be a positive safe integer within its hard maximum.`
    );
  }
  return value;
}

function validateRepositoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH ||
      value.trim() !== value || ASCII_CONTROL.test(value)) {
    throw new InspectionFailure(
      "repository_path_invalid",
      "The configured repository path is invalid.",
      "invalid",
      "repositoryPath"
    );
  }
  return path.resolve(value);
}

function validateArrayStructure(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InspectionFailure(
      "invalid_repository_inspection_input",
      "changedFiles must be an array.",
      "invalid",
      "changedFiles"
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new InspectionFailure(
      "repository_inspection_symbol_property",
      "changedFiles must not contain symbol properties.",
      "invalid",
      "changedFiles"
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new InspectionFailure(
        "unknown_repository_inspection_field",
        "changedFiles contains a non-index property.",
        "invalid",
        "changedFiles"
      );
    }
    if (!("value" in descriptor)) {
      throw new InspectionFailure(
        "repository_inspection_accessor_property",
        "changedFiles must not contain accessor entries.",
        "invalid",
        "changedFiles"
      );
    }
  }
  return value;
}

function validateChangedFiles(value: unknown): string[] {
  const source = validateArrayStructure(value);
  if (source.length > MAX_CHANGED_FILES) {
    throw new InspectionFailure(
      "repository_changed_file_limit_exceeded",
      "The changed-file list exceeds the inspection limit.",
      "invalid",
      "changedFiles"
    );
  }
  const files: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!Object.hasOwn(source, index)) {
      throw new InspectionFailure(
        "repository_changed_file_invalid",
        "Sparse changed-file arrays are not accepted.",
        "invalid",
        "changedFiles"
      );
    }
    const file = source[index];
    const segments = typeof file === "string" ? file.split("/") : [];
    if (typeof file !== "string" || file.length === 0 || file.length > MAX_PATH_LENGTH ||
        file.trim() !== file || ASCII_CONTROL.test(file) || file.includes("\\") ||
        path.posix.isAbsolute(file) || WINDOWS_DRIVE.test(file) || UNC.test(file) ||
        segments.some((segment) => segment === "" || segment === ".." || segment === ".git")) {
      throw new InspectionFailure(
        "repository_changed_file_invalid",
        "A changed-file path is not a safe exact repository-relative path.",
        "invalid",
        "changedFiles",
        typeof file === "string" && file.length <= MAX_PATH_LENGTH && !ASCII_CONTROL.test(file)
          ? file
          : undefined
      );
    }
    files.push(file);
  }
  return [...new Set(files)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateTarget(value: unknown): ControlledApplyTargetSnapshot {
  const record = exactPlainObject(value, TARGET_FIELDS, "expectedTarget");
  for (const field of TARGET_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throw new InspectionFailure(
        "missing_repository_inspection_field",
        "expectedTarget is missing a required field.",
        "invalid",
        `expectedTarget.${field}`
      );
    }
    if (typeof record[field] !== "string" || !HASH.test(record[field])) {
      throw new InspectionFailure(
        "invalid_repository_inspection_input",
        "expectedTarget contains an invalid hash.",
        "invalid",
        `expectedTarget.${field}`
      );
    }
  }
  return {
    repositoryIdentityHash: record.repositoryIdentityHash as string,
    baseRevisionHash: record.baseRevisionHash as string,
    worktreeStateHash: record.worktreeStateHash as string
  };
}

function handoffPackageState(record: PlainRecord): { provided: boolean; complete: boolean } {
  const fields = [
    "handoff", "artifact", "currentFreshnessSnapshot", "mutation", "consumptionStatus"
  ];
  const count = fields.filter((field) => Object.hasOwn(record, field)).length;
  return { provided: count > 0, complete: count === fields.length };
}

function oidPattern(format: ObjectFormat): RegExp {
  return format === "sha1" ? SHA1_OID : SHA256_OID;
}

function sha256Bytes(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function ensureAllowedGitArgs(args: readonly string[]): void {
  const exact = (expected: readonly string[]) =>
    args.length === expected.length && args.every((value, index) => value === expected[index]);
  const allowed =
    exact(["rev-parse", "--is-inside-work-tree"]) ||
    exact(["rev-parse", "--show-toplevel"]) ||
    exact(["rev-parse", "--git-common-dir"]) ||
    exact(["rev-parse", "HEAD"]) ||
    exact(["rev-parse", "--show-object-format"]) ||
    exact(["rev-list", "--max-parents=0", "HEAD"]) ||
    exact(["status", "--porcelain=v2", "-z", "--untracked-files=all"]) ||
    exact(["config", "--get-regexp", "^remote\\..*\\.url$"]) ||
    (args.length >= 4 && args[0] === "ls-files" && args[1] === "-s" && args[2] === "-z" &&
      args[3] === "--" && args.slice(4).length <= MAX_CHANGED_FILES) ||
    (args.length === 3 && args[0] === "cat-file" && args[1] === "-e" &&
      /^[0-9a-f]{40,64}\^\{blob\}$/.test(args[2] ?? ""));
  if (!allowed) {
    throw new GitFailure(
      "repository_git_command_not_allowed",
      "A Git inspection operation was not allowlisted."
    );
  }
}

type GitRunner = (
  cwd: string,
  args: readonly string[],
  acceptedExitCodes?: readonly number[]
) => Promise<Buffer>;

function makeGitRunner(summary: Summary, timeoutMs: number, maxOutputBytes: number): GitRunner {
  return async (cwd, args, acceptedExitCodes = [0]) => {
    ensureAllowedGitArgs(args);
    summary.gitCommandCount += 1;
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
            LANG: "C"
          },
          encoding: "buffer",
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          windowsHide: true
        },
        (error, stdout) => {
          const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
          if (output.length > maxOutputBytes) {
            reject(new GitFailure(
              "repository_git_output_limit_exceeded",
              "Git inspection output exceeded the configured limit."
            ));
            return;
          }
          if (error) {
            const maybe = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
            if (maybe.killed || maybe.code === "ETIMEDOUT") {
              reject(new GitFailure(
                "repository_git_command_timeout",
                "A Git inspection operation timed out."
              ));
              return;
            }
            if (maybe.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(new GitFailure(
                "repository_git_output_limit_exceeded",
                "Git inspection output exceeded the configured limit."
              ));
              return;
            }
            const exitCode = typeof maybe.code === "number" ? maybe.code : -1;
            if (acceptedExitCodes.includes(exitCode)) {
              resolve(output);
              return;
            }
            reject(new GitFailure(
              "repository_git_command_failed",
              "An allowlisted Git inspection operation failed."
            ));
            return;
          }
          resolve(output);
        }
      );
    });
  };
}

function boundedText(output: Buffer, allowNul = false): string {
  const text = output.toString("utf8");
  if (text.includes("\ufffd") || (!allowNul && text.includes("\0"))) {
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git inspection returned malformed text output."
    );
  }
  return text;
}

function oneLine(output: Buffer): string {
  const text = boundedText(output).replace(/[\r\n]+$/, "");
  if (text.length === 0 || text.includes("\n") || text.includes("\r") || ASCII_CONTROL.test(text)) {
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git inspection returned an invalid single-line value."
    );
  }
  return text;
}

async function verifyChangedPathContainment(root: string, file: string): Promise<void> {
  const resolved = path.resolve(root, ...file.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new InspectionFailure(
      "repository_changed_file_outside_root",
      "A changed-file path resolves outside the repository root.",
      "invalid",
      "changedFiles",
      file
    );
  }
  const segments = file.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new InspectionFailure(
          "repository_changed_file_symlink_parent",
          "A changed-file path traverses a symlinked parent directory.",
          "invalid",
          "changedFiles",
          file
        );
      }
      if (!metadata.isDirectory()) break;
    } catch (error) {
      if (error instanceof InspectionFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new InspectionFailure(
        "repository_changed_file_invalid",
        "A changed-file parent could not be safely inspected.",
        "invalid",
        "changedFiles",
        file
      );
    }
  }
}

function normalizeRemoteIdentity(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_PATH_LENGTH || ASCII_CONTROL.test(value)) return null;
  const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    const host = scp[1]?.toLowerCase();
    let repository = scp[2] ?? "";
    repository = repository.replace(/\/+$/, "").replace(/\.git$/i, "");
    if (!host || !repository || ASCII_CONTROL.test(repository)) return null;
    return `ssh://${host}/${repository.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.hostname) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    let pathname = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    if (pathname === "") pathname = "/";
    parsed.pathname = pathname;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    if (/^(?:\.\.?\/|\/)/.test(value)) {
      return value.replace(/\/+$/, "").replace(/\.git$/i, "");
    }
    return null;
  }
}

function parseRemoteHashes(output: Buffer, issues: Issue[]): string[] {
  const text = boundedText(output);
  const hashes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const separator = line.search(/[ \t]/);
    if (separator < 1) {
      issues.push({
        code: "repository_remote_identity_needs_review",
        message: "A repository remote identity could not be safely normalized.",
        severity: "review"
      });
      continue;
    }
    const normalized = normalizeRemoteIdentity(line.slice(separator + 1));
    if (normalized === null) {
      issues.push({
        code: "repository_remote_identity_needs_review",
        message: "A repository remote identity could not be safely normalized.",
        severity: "review"
      });
      continue;
    }
    hashes.push(hashCanonicalJson({
      artifactType: "controlled_repository_remote_identity",
      normalizedRemoteIdentity: normalized
    }));
  }
  return [...new Set(hashes)].sort(compareStrings);
}

function validateStatusPath(filePath: string): void {
  if (filePath.length === 0 || filePath.length > MAX_PATH_LENGTH || ASCII_CONTROL.test(filePath)) {
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git status contained an invalid path value."
    );
  }
}

function parseStatus(output: Buffer): { records: StatusRecord[]; summary: Omit<ControlledRepositoryWorktreeSummary,
  "mergeInProgress" | "rebaseInProgress" | "cherryPickInProgress" | "revertInProgress" |
  "bisectInProgress" | "clean"> } {
  const text = boundedText(output, true);
  const parts = text.split("\0");
  if (parts.at(-1) !== "") {
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git status output was not NUL terminated."
    );
  }
  parts.pop();
  const records: StatusRecord[] = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (part.startsWith("? ")) {
      const filePath = part.slice(2);
      validateStatusPath(filePath);
      records.push({ recordType: "untracked", indexStatus: ".", worktreeStatus: "?", filePath });
      paths.push(filePath);
      untracked += 1;
      continue;
    }
    if (part.startsWith("! ")) continue;
    if (part.startsWith("1 ") || part.startsWith("2 ") || part.startsWith("u ")) {
      const fields = part.split(" ");
      const type = part[0];
      const xy = fields[1] ?? "";
      const minimum = type === "1" ? 9 : type === "2" ? 10 : 11;
      if (!/^[.MADRCUT?!]{2}$/.test(xy) || fields.length < minimum) {
        throw new InspectionFailure(
          "repository_git_output_invalid",
          "Git status contained an unsupported record."
        );
      }
      const filePath = fields.slice(minimum - 1).join(" ");
      validateStatusPath(filePath);
      let originalPath: string | undefined;
      if (type === "2") {
        originalPath = parts[++index];
        if (originalPath === undefined) {
          throw new InspectionFailure(
            "repository_git_output_invalid",
            "Git rename status was incomplete."
          );
        }
        validateStatusPath(originalPath);
      }
      const recordType = type === "1" ? "ordinary" : type === "2" ? "renamed" : "unmerged";
      records.push({ recordType, indexStatus: xy[0] ?? ".", worktreeStatus: xy[1] ?? ".",
        filePath, ...(originalPath === undefined ? {} : { originalPath }) });
      paths.push(filePath);
      if (xy[0] !== ".") staged += 1;
      if (xy[1] !== ".") unstaged += 1;
      if (type === "u" || xy.includes("U")) conflicted += 1;
      continue;
    }
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git status contained an unsupported record type."
    );
  }
  records.sort((left, right) => compareStrings(
    `${left.recordType}\0${left.filePath}\0${left.originalPath ?? ""}\0${left.indexStatus}${left.worktreeStatus}`,
    `${right.recordType}\0${right.filePath}\0${right.originalPath ?? ""}\0${right.indexStatus}${right.worktreeStatus}`
  ));
  return {
    records,
    summary: {
      stagedChangeCount: staged,
      unstagedChangeCount: unstaged,
      untrackedFileCount: untracked,
      conflictedFileCount: conflicted,
      changedPaths: [...new Set(paths)].sort(compareStrings)
    }
  };
}

async function existsWithoutFollowing(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function operationState(commonDirectory: string): Promise<{
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  cherryPickInProgress: boolean;
  revertInProgress: boolean;
  bisectInProgress: boolean;
}> {
  const [merge, rebaseMerge, rebaseApply, cherryPick, revert, bisect] = await Promise.all([
    "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"
  ].map((entry) => existsWithoutFollowing(path.join(commonDirectory, entry))));
  return {
    mergeInProgress: merge,
    rebaseInProgress: rebaseMerge || rebaseApply,
    cherryPickInProgress: cherryPick,
    revertInProgress: revert,
    bisectInProgress: bisect
  };
}

type IndexEntry = { mode: ControlledRollbackFileEntry["baseMode"]; oid: string; stage: number };

function parseIndexEntries(
  output: Buffer,
  changedFiles: readonly string[],
  format: ObjectFormat
): Map<string, IndexEntry> {
  const text = boundedText(output, true);
  const parts = text.split("\0");
  if (parts.at(-1) !== "") {
    throw new InspectionFailure(
      "repository_git_output_invalid",
      "Git index output was not NUL terminated."
    );
  }
  parts.pop();
  const allowed = new Set(changedFiles);
  const result = new Map<string, IndexEntry>();
  for (const part of parts) {
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(part);
    if (!match) {
      throw new InspectionFailure(
        "repository_git_output_invalid",
        "Git index output contained a malformed record."
      );
    }
    const [, modeRaw, oid = "", stageRaw = "", filePath = ""] = match;
    if (!allowed.has(filePath) || !oidPattern(format).test(oid)) {
      throw new InspectionFailure(
        "repository_git_output_invalid",
        "Git index output did not match the bounded changed-file request."
      );
    }
    const stage = Number(stageRaw);
    if (stage !== 0) {
      throw new InspectionFailure(
        "repository_index_stage_conflict",
        "A changed file has a non-zero index stage.",
        "blocked",
        undefined,
        filePath
      );
    }
    if (modeRaw !== "100644" && modeRaw !== "100755" && modeRaw !== "120000" &&
        modeRaw !== "160000") {
      throw new InspectionFailure(
        "repository_file_entry_needs_review",
        "A changed file has an unsupported Git mode.",
        "review",
        undefined,
        filePath
      );
    }
    if (result.has(filePath)) {
      throw new InspectionFailure(
        "repository_git_output_invalid",
        "Git index output contained duplicate changed-file records."
      );
    }
    result.set(filePath, { mode: modeRaw, oid, stage });
  }
  return result;
}

async function worktreeEvidence(
  root: string,
  file: string,
  summary: Summary
): Promise<Pick<ControlledRollbackFileEntry,
  "existsInWorktree" | "worktreeEntryKind" | "worktreeContentHash">> {
  const absolute = path.join(root, ...file.split("/"));
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existsInWorktree: false, worktreeEntryKind: "absent", worktreeContentHash: null };
    }
    throw new InspectionFailure(
      "repository_file_entry_needs_review",
      "A changed-file worktree entry could not be classified.",
      "review",
      undefined,
      file
    );
  }
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolute);
    const bytes = Buffer.byteLength(target);
    if (summary.fileBytesRead + bytes > MAX_TOTAL_FILE_BYTES) {
      throw new InspectionFailure(
        "repository_total_file_bytes_exceeded",
        "Changed-file evidence exceeds the total read limit.",
        "review",
        undefined,
        file
      );
    }
    summary.fileBytesRead += bytes;
    return { existsInWorktree: true, worktreeEntryKind: "symlink",
      worktreeContentHash: sha256Bytes(target) };
  }
  if (metadata.isFile()) {
    if (metadata.size > MAX_FILE_BYTES) {
      throw new InspectionFailure(
        "repository_changed_file_too_large",
        "A changed file exceeds the per-file read limit.",
        "review",
        undefined,
        file
      );
    }
    if (summary.fileBytesRead + metadata.size > MAX_TOTAL_FILE_BYTES) {
      throw new InspectionFailure(
        "repository_total_file_bytes_exceeded",
        "Changed-file evidence exceeds the total read limit.",
        "review",
        undefined,
        file
      );
    }
    let handle;
    try {
      handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw new InspectionFailure(
          "repository_file_entry_needs_review",
          "A changed-file worktree entry changed type during inspection.",
          "review",
          undefined,
          file
        );
      }
      if (openedMetadata.size > MAX_FILE_BYTES ||
          summary.fileBytesRead + openedMetadata.size > MAX_TOTAL_FILE_BYTES) {
        throw new InspectionFailure(
          openedMetadata.size > MAX_FILE_BYTES
            ? "repository_changed_file_too_large"
            : "repository_total_file_bytes_exceeded",
          "A changed file exceeded a strict content read limit.",
          "review",
          undefined,
          file
        );
      }
      const bytes = await handle.readFile();
      if (bytes.length > MAX_FILE_BYTES || summary.fileBytesRead + bytes.length > MAX_TOTAL_FILE_BYTES) {
        throw new InspectionFailure(
          bytes.length > MAX_FILE_BYTES
            ? "repository_changed_file_too_large"
            : "repository_total_file_bytes_exceeded",
          "A changed file exceeded a strict content read limit.",
          "review",
          undefined,
          file
        );
      }
      summary.fileBytesRead += bytes.length;
      return { existsInWorktree: true, worktreeEntryKind: "regular_file",
        worktreeContentHash: sha256Bytes(bytes) };
    } catch (error) {
      if (error instanceof InspectionFailure) throw error;
      throw new InspectionFailure(
        "repository_file_entry_needs_review",
        "A changed-file worktree entry could not be safely opened without following links.",
        "review",
        undefined,
        file
      );
    } finally {
      await handle?.close();
    }
  }
  if (metadata.isDirectory()) {
    return { existsInWorktree: true, worktreeEntryKind: "directory", worktreeContentHash: null };
  }
  throw new InspectionFailure(
    "repository_file_entry_needs_review",
    "A changed-file worktree entry has an unsupported type.",
    "review",
    undefined,
    file
  );
}

function hasOperation(state: ReturnType<typeof operationState> extends Promise<infer T> ? T : never): boolean {
  return Object.values(state).some(Boolean);
}

function addWorktreeIssues(worktree: ControlledRepositoryWorktreeSummary, issues: Issue[]): boolean {
  let blocked = false;
  if (worktree.stagedChangeCount > 0 || worktree.unstagedChangeCount > 0) {
    issues.push({ code: "repository_worktree_dirty",
      message: "The repository worktree contains tracked changes.", severity: "error" });
    blocked = true;
  }
  if (worktree.untrackedFileCount > 0) {
    issues.push({ code: "repository_untracked_files_present",
      message: "The repository worktree contains untracked files.", severity: "error" });
    blocked = true;
  }
  if (worktree.conflictedFileCount > 0) {
    issues.push({ code: "repository_conflicts_present",
      message: "The repository worktree contains conflicts.", severity: "error" });
    blocked = true;
  }
  if (worktree.mergeInProgress || worktree.rebaseInProgress || worktree.cherryPickInProgress ||
      worktree.revertInProgress || worktree.bisectInProgress) {
    issues.push({ code: "repository_operation_in_progress",
      message: "A repository operation is in progress.", severity: "error" });
    blocked = true;
  }
  return blocked;
}

export async function inspectControlledRepository(
  input: ControlledRepositoryInspectionInput
): Promise<ControlledRepositoryInspectionResult> {
  const summary = initialSummary();
  const issues: Issue[] = [];
  let numericError: TypeError | null = null;
  try {
    const record = exactPlainObject(input, INPUT_FIELDS, "Repository inspection input");
    const timeoutMs = numericConfiguration(record, "timeoutMs", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxGitOutputBytes = numericConfiguration(
      record, "maxGitOutputBytes", DEFAULT_GIT_OUTPUT_BYTES, MAX_GIT_OUTPUT_BYTES
    );
    const configuredPath = validateRepositoryPath(requireOwn(record, "repositoryPath"));
    const changedFiles = validateChangedFiles(requireOwn(record, "changedFiles"));
    summary.changedFileCount = changedFiles.length;
    summary.changedFilesValid = true;

    const packageState = handoffPackageState(record);
    summary.handoffProvided = packageState.provided;
    if (!packageState.complete && packageState.provided) {
      throw new InspectionFailure(
        "repository_handoff_package_incomplete",
        "The optional handoff verification package must be complete or absent."
      );
    }
    if (packageState.complete &&
        record.consumptionStatus !== "not_consumed" &&
        record.consumptionStatus !== "already_consumed" &&
        record.consumptionStatus !== "unknown") {
      throw new InspectionFailure(
        "invalid_repository_inspection_input",
        "The handoff consumption status is invalid.",
        "invalid",
        "consumptionStatus"
      );
    }

    let expectedTarget: ControlledApplyTargetSnapshot | null = null;
    if (Object.hasOwn(record, "expectedTarget")) {
      summary.expectedTargetProvided = true;
      expectedTarget = validateTarget(record.expectedTarget);
    }

    try {
      const metadata = await stat(configuredPath);
      if (!metadata.isDirectory()) {
        throw new InspectionFailure(
          "repository_path_not_directory",
          "The configured repository location is not a directory."
        );
      }
      await access(configuredPath, fsConstants.R_OK | fsConstants.X_OK);
    } catch (error) {
      if (error instanceof InspectionFailure) throw error;
      throw new InspectionFailure(
        "repository_path_not_directory",
        "The configured repository location is not an inspectable directory."
      );
    }

    const git = makeGitRunner(summary, timeoutMs, maxGitOutputBytes);
    let inside: string;
    try {
      inside = oneLine(await git(configuredPath, ["rev-parse", "--is-inside-work-tree"]));
    } catch (error) {
      if (error instanceof GitFailure && error.code === "repository_git_command_failed") {
        throw new InspectionFailure(
          "repository_not_git_worktree",
          "The configured directory is not a recognized Git worktree."
        );
      }
      throw error;
    }
    if (inside !== "true") {
      throw new InspectionFailure(
        "repository_not_git_worktree",
        "The configured directory is not inside a Git worktree."
      );
    }
    summary.repositoryRecognized = true;
    summary.repositoryInsideWorktree = true;

    let root: string;
    try {
      const shownRoot = oneLine(await git(configuredPath, ["rev-parse", "--show-toplevel"]));
      root = await realpath(shownRoot);
      const rootMetadata = await stat(root);
      if (!path.isAbsolute(root) || !rootMetadata.isDirectory()) throw new Error("invalid root");
    } catch {
      throw new InspectionFailure(
        "repository_root_resolution_failed",
        "The Git repository root could not be safely resolved."
      );
    }

    for (const file of changedFiles) await verifyChangedPathContainment(root, file);

    const formatRaw = oneLine(await git(root, ["rev-parse", "--show-object-format"]));
    if (formatRaw !== "sha1" && formatRaw !== "sha256") {
      throw new InspectionFailure(
        "repository_object_format_unsupported",
        "The repository object format requires review.",
        "review"
      );
    }
    const objectFormat: ObjectFormat = formatRaw;
    const oid = oidPattern(objectFormat);

    const headObjectId = oneLine(await git(root, ["rev-parse", "HEAD"]));
    if (!oid.test(headObjectId)) {
      throw new InspectionFailure("repository_head_invalid", "The repository HEAD object is invalid.");
    }
    const baseRevisionHash = hashCanonicalJson({
      artifactType: "controlled_apply_base_revision", objectFormat, headObjectId
    });
    summary.baseRevisionComputed = true;

    const rootsText = boundedText(await git(root, ["rev-list", "--max-parents=0", "HEAD"]));
    const rootCommitObjectIds = rootsText.split(/\r?\n/).filter(Boolean);
    if (rootCommitObjectIds.length === 0 || rootCommitObjectIds.some((value) => !oid.test(value))) {
      throw new InspectionFailure(
        "repository_root_commit_invalid",
        "The repository root commit evidence is invalid."
      );
    }
    const remoteOutput = await git(
      root, ["config", "--get-regexp", "^remote\\..*\\.url$"], [0, 1]
    );
    const remoteIdentityHashes = parseRemoteHashes(remoteOutput, issues);
    const repositoryIdentityHash = hashCanonicalJson({
      artifactType: "controlled_repository_identity",
      objectFormat,
      rootCommitObjectIds: [...new Set(rootCommitObjectIds)].sort(compareStrings),
      remoteIdentityHashes
    });
    summary.repositoryIdentityComputed = true;

    const statusOutput = await git(
      root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]
    );
    const parsedStatus = parseStatus(statusOutput);

    const commonRaw = oneLine(await git(root, ["rev-parse", "--git-common-dir"]));
    const commonCandidate = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw);
    let commonDirectory: string;
    try {
      commonDirectory = await realpath(commonCandidate);
      if (!(await stat(commonDirectory)).isDirectory()) throw new Error("not directory");
    } catch {
      throw new InspectionFailure(
        "repository_root_resolution_failed",
        "The Git common directory could not be safely resolved."
      );
    }
    const operations = await operationState(commonDirectory);
    const clean = parsedStatus.records.length === 0 && !hasOperation(operations);
    const worktree: ControlledRepositoryWorktreeSummary = {
      clean,
      ...parsedStatus.summary,
      ...operations
    };
    summary.worktreeStateComputed = true;
    summary.worktreeClean = clean;
    summary.repositoryOperationInProgress = hasOperation(operations);
    let blocked = addWorktreeIssues(worktree, issues);
    let invalid = false;

    const indexOutput = changedFiles.length === 0
      ? Buffer.from("", "utf8")
      : await git(root, ["ls-files", "-s", "-z", "--", ...changedFiles]);
    const indexEntries = changedFiles.length === 0
      ? new Map<string, IndexEntry>()
      : parseIndexEntries(indexOutput, changedFiles, objectFormat);
    const files: ControlledRollbackFileEntry[] = [];
    for (const file of changedFiles) {
      const indexEntry = indexEntries.get(file);
      if (indexEntry && indexEntry.mode !== "160000") {
        try {
          await git(root, ["cat-file", "-e", `${indexEntry.oid}^{blob}`]);
        } catch {
          throw new InspectionFailure(
            "repository_base_object_missing",
            "A changed file's baseline object could not be verified.",
            "invalid",
            undefined,
            file
          );
        }
      }
      const evidence = await worktreeEvidence(root, file, summary);
      if (indexEntry === undefined && evidence.existsInWorktree) {
        blocked = true;
        issues.push({
          code: "repository_worktree_dirty",
          message: "A changed-file path conflicts with an entry not present in the baseline.",
          severity: "error",
          filePath: file
        });
      }
      files.push({
        filePath: file,
        baselineState: indexEntry === undefined ? "absent" :
          indexEntry.mode === "120000" ? "tracked_symlink" :
            indexEntry.mode === "160000" ? "tracked_gitlink" : "tracked_file",
        baseObjectId: indexEntry?.oid ?? null,
        baseMode: indexEntry?.mode ?? null,
        ...evidence
      });
    }

    const statusHash = hashCanonicalJson({
      artifactType: "controlled_repository_porcelain_v2",
      statusRecords: parsedStatus.records
    });
    const worktreeStateHash = hashCanonicalJson({
      artifactType: "controlled_apply_worktree_state",
      objectFormat,
      headObjectId,
      statusHash,
      operationState: operations,
      changedFilesBaseline: files
    });
    const target: InspectedControlledApplyTarget = {
      repositoryIdentityHash, baseRevisionHash, worktreeStateHash
    };
    const manifestWithoutHash = {
      manifestVersion: "1" as const,
      repositoryIdentityHash,
      baseRevisionHash,
      worktreeStateHash,
      changedFiles,
      files,
      restorationPolicy: RESTORATION_POLICY
    };
    const rollbackManifest: ControlledRollbackManifest = {
      ...manifestWithoutHash,
      manifestHash: hashCanonicalJson(manifestWithoutHash)
    };
    summary.rollbackManifestBuilt = true;
    summary.rollbackManifestHashValid =
      hashCanonicalJson(manifestWithoutHash) === rollbackManifest.manifestHash;
    if (!summary.rollbackManifestHashValid) {
      throw new InspectionFailure(
        "repository_rollback_manifest_failure",
        "The rollback manifest integrity check failed."
      );
    }
    const inspectionWithoutHash = {
      inspectionVersion: "1" as const, target, worktree, rollbackManifest
    };
    const inspection: ControlledRepositoryInspection = {
      ...inspectionWithoutHash,
      inspectionHash: hashCanonicalJson(inspectionWithoutHash)
    };
    summary.inspectionHashValid =
      hashCanonicalJson(inspectionWithoutHash) === inspection.inspectionHash;
    if (!summary.inspectionHashValid) {
      throw new InspectionFailure(
        "repository_inspection_hash_failure",
        "The repository inspection integrity check failed."
      );
    }

    if (expectedTarget !== null) {
      summary.expectedTargetMatched = true;
      const comparisons = [
        ["repositoryIdentityHash", "repository_identity_target_mismatch"],
        ["baseRevisionHash", "repository_base_revision_target_mismatch"],
        ["worktreeStateHash", "repository_worktree_state_target_mismatch"]
      ] as const;
      for (const [field, code] of comparisons) {
        if (expectedTarget[field] !== target[field]) {
          summary.expectedTargetMatched = false;
          blocked = true;
          issues.push({
            code,
            message: "The inspected repository does not match the expected target.",
            severity: "error",
            field: `expectedTarget.${field}`
          });
        }
      }
    }

    let handoffVerification: ControlledApplyHandoffVerificationResult | null = null;
    if (packageState.complete) {
      handoffVerification = verifyControlledApplyHandoff({
        handoff: record.handoff as ControlledApplyHandoffPlan,
        artifact: record.artifact as GovernedChangeArtifact,
        currentFreshnessSnapshot:
          record.currentFreshnessSnapshot as GovernedChangeFreshnessSnapshot,
        mutation: record.mutation as WorkspaceMutation,
        currentTarget: target,
        consumptionStatus: record.consumptionStatus as
          "not_consumed" | "already_consumed" | "unknown"
      });
      summary.handoffVerified = handoffVerification.handoffIntegrityVerified;
      let inspectedScopeMatched = false;
      if (handoffVerification.decision === "controlled_apply_handoff_current" &&
          handoffVerification.executionEligible) {
        try {
          const governedFiles = deriveGovernedMutationChangedFiles(
            record.mutation as WorkspaceMutation
          );
          inspectedScopeMatched = governedFiles.length === changedFiles.length &&
            governedFiles.every((file, index) => file === changedFiles[index]);
        } catch {
          inspectedScopeMatched = false;
        }
      }
      summary.handoffExecutionEligible = handoffVerification.executionEligible &&
        inspectedScopeMatched && (expectedTarget === null || summary.expectedTargetMatched);
      if (!summary.handoffExecutionEligible) blocked = true;
      if (handoffVerification.decision === "controlled_apply_handoff_consumed") {
        issues.push({ code: "repository_handoff_consumed",
          message: "The controlled apply handoff has already been consumed.", severity: "error" });
      } else if (handoffVerification.decision === "controlled_apply_handoff_verification_invalid") {
        if (!handoffVerification.reasonCodes.includes("controlled_apply_consumption_status_unknown")) {
          invalid = true;
        }
        issues.push({ code: "repository_handoff_verification_invalid",
          message: "The controlled apply handoff could not be verified.", severity: "error" });
      } else if (handoffVerification.decision !== "controlled_apply_handoff_current" ||
          !handoffVerification.executionEligible) {
        issues.push({ code: "repository_handoff_not_current",
          message: "The controlled apply handoff is not current and execution eligible.",
          severity: "error" });
      } else if (!inspectedScopeMatched) {
        issues.push({ code: "repository_handoff_not_current",
          message: "The inspected changed-file scope does not match the governed handoff scope.",
          severity: "error", field: "changedFiles" });
      }
    }

    const review = issues.some((entry) => entry.severity === "review");
    return finish(
      invalid ? "repository_inspection_invalid" :
        review ? "repository_inspection_needs_review" :
        blocked ? "repository_inspection_blocked" : "repository_inspection_ready",
      issues,
      inspection,
      handoffVerification,
      summary
    );
  } catch (error) {
    if (error instanceof TrustedConfigurationTypeError) numericError = error;
    if (numericError) throw numericError;
    const failure = error instanceof InspectionFailure ? error : new InspectionFailure(
      "repository_inspection_exception",
      "Repository inspection failed without exposing unbounded error details."
    );
    issues.push(issueFromFailure(failure));
    return finish(
      failure.kind === "review"
        ? "repository_inspection_needs_review"
        : failure.kind === "blocked"
          ? "repository_inspection_blocked"
          : "repository_inspection_invalid",
      issues,
      null,
      null,
      summary
    );
  }
}
