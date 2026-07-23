import { execFile } from "node:child_process";
import {
  constants as fsConstants
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir
} from "node:fs/promises";
import path from "node:path";

import { hashCanonicalJson } from "./agent-event-ledger.js";
import type {
  DraftPrDeliveryContract
} from "./draft-pr-delivery-contract.js";
import type {
  IntegratedDisposableApplyReceipt
} from "./integrated-disposable-apply-coordinator.js";
import type {
  ControlledRepositoryApplyReceipt
} from "./controlled-repository-apply.js";
import {
  verifyControlledLocalDeliveryReceipt,
  type ControlledLocalDeliveryReceipt,
  type ControlledLocalDeliveryReceiptVerificationResult
} from "./controlled-local-delivery.js";

export const CONTROLLED_REMOTE_BRANCH_PUSH_VERSION = "1" as const;

export type ControlledRemoteBranchPushDecision =
  | "controlled_remote_branch_pushed"
  | "controlled_remote_branch_already_pushed"
  | "controlled_remote_branch_push_blocked"
  | "controlled_remote_branch_push_needs_review"
  | "controlled_remote_branch_push_invalid"
  | "controlled_remote_branch_push_recovery_required";

export type ControlledRemoteBranchPushIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
};

export type ControlledRemoteBranchPushReceipt = {
  receiptVersion: "1";
  outcome: "remote_branch_pushed";
  deliveryKey: string;
  contractHash: string;
  localDeliveryReceiptHash: string;
  evidenceSetHash: string;
  repositoryIdentityHash: string;
  remote: {
    remoteNameHash: string;
    baseBranch: string;
    baseCommitHash: string;
    headBranch: string;
    headCommitHash: string;
  };
  safety: {
    localReceiptCurrentBeforePush: true;
    repositoryIdentityMatched: true;
    localBaseRefMatched: true;
    localHeadRefMatched: true;
    remoteBaseFreshBeforePush: true;
    remoteHeadAbsentBeforePush: true;
    durableClaimCreatedBeforePush: true;
    leaseProtectedCreation: true;
    remoteBaseUnchangedAfterPush: true;
    remoteHeadMatchedAfterPush: true;
    localBaseRefUnchanged: true;
    localHeadRefUnchanged: true;
    unconditionalForcePushExecuted: false;
    githubWriteExecuted: false;
    shellExecuted: false;
  };
  receiptHash: string;
};

export type ExecuteControlledRemoteBranchPushInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  remoteName: string;
  localDeliveryReceipt: ControlledLocalDeliveryReceipt;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledRemoteBranchPushResult = {
  decision: ControlledRemoteBranchPushDecision;
  issues: readonly ControlledRemoteBranchPushIssue[];
  receipt: ControlledRemoteBranchPushReceipt | null;
  localReceiptVerification:
    ControlledLocalDeliveryReceiptVerificationResult | null;
  summary: {
    inputValid: boolean;
    localReceiptCurrent: boolean;
    repositoryPathValid: boolean;
    registryPathValid: boolean;
    repositoryIdentityMatched: boolean;
    localBaseRefMatched: boolean;
    localHeadRefMatched: boolean;
    remoteBaseFresh: boolean;
    remoteHeadAbsent: boolean;
    duplicatePushDetected: boolean;
    durableClaimCreated: boolean;
    pushAttempted: boolean;
    pushSucceeded: boolean;
    remoteBaseUnchanged: boolean;
    remoteHeadMatched: boolean;
    localBaseRefUnchanged: boolean;
    localHeadRefUnchanged: boolean;
    receiptWritten: boolean;
    unconditionalForcePushExecuted: false;
    githubWriteExecuted: false;
    shellExecuted: false;
  };
};

export type VerifyControlledRemoteBranchPushReceiptInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  remoteName: string;
  receipt: ControlledRemoteBranchPushReceipt;
  localDeliveryReceipt: ControlledLocalDeliveryReceipt;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledRemoteBranchPushReceiptVerificationDecision =
  | "controlled_remote_branch_push_receipt_current"
  | "controlled_remote_branch_push_receipt_stale"
  | "controlled_remote_branch_push_receipt_invalid";

export type ControlledRemoteBranchPushReceiptVerificationResult = {
  decision: ControlledRemoteBranchPushReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  localReceiptCurrent: boolean;
  registryRecordMatched: boolean;
  repositoryIdentityMatched: boolean;
  localRefsMatched: boolean;
  remoteBaseMatched: boolean;
  remoteHeadMatched: boolean;
  downstreamEligible: boolean;
  staleFields: readonly string[];
  errors: readonly string[];
  pushExecuted: false;
  githubWriteExecuted: false;
  shellExecuted: false;
};

type PlainRecord = Record<string, unknown>;

type ValidatedInput = {
  input: ExecuteControlledRemoteBranchPushInput;
  timeoutMs: number;
  maxGitOutputBytes: number;
};

type PushLocations = {
  repository: string;
  registry: string;
  gitCommon: string;
  pushRoot: string;
  claim: string;
};

type ClaimState =
  | { state: "missing"; receipt: null }
  | { state: "incomplete"; receipt: null }
  | {
      state: "committed";
      receipt: ControlledRemoteBranchPushReceipt;
    };

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const REMOTE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES =
  10 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES =
  100 * 1024 * 1024;
const MAX_REGISTRY_ENTRIES = 20;
const MAX_PATH_LENGTH = 4096;
const ASCII_CONTROL =
  /[\u0000-\u001f\u007f]/;

class PushFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind:
      | "invalid"
      | "blocked"
      | "review"
      | "recovery" = "invalid",
    readonly field?: string
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(
  values: readonly string[]
): string[] {
  return [...new Set(values)].sort(
    (left, right) => left.localeCompare(right)
  );
}

function canonicalEqual(
  left: unknown,
  right: unknown
): boolean {
  try {
    return (
      hashCanonicalJson(left) ===
      hashCanonicalJson(right)
    );
  } catch {
    return false;
  }
}

function hashWithout(
  value: PlainRecord,
  field: string
): string {
  const material = { ...value };
  delete material[field];
  return hashCanonicalJson(material);
}

function issue(
  failure: PushFailure
): ControlledRemoteBranchPushIssue {
  return {
    code: failure.code,
    message: failure.message,
    severity:
      failure.kind === "review" ||
      failure.kind === "recovery"
        ? "review"
        : "error",
    ...(failure.field
      ? { field: failure.field }
      : {})
  };
}

function initialSummary():
ControlledRemoteBranchPushResult["summary"] {
  return {
    inputValid: false,
    localReceiptCurrent: false,
    repositoryPathValid: false,
    registryPathValid: false,
    repositoryIdentityMatched: false,
    localBaseRefMatched: false,
    localHeadRefMatched: false,
    remoteBaseFresh: false,
    remoteHeadAbsent: false,
    duplicatePushDetected: false,
    durableClaimCreated: false,
    pushAttempted: false,
    pushSucceeded: false,
    remoteBaseUnchanged: false,
    remoteHeadMatched: false,
    localBaseRefUnchanged: false,
    localHeadRefUnchanged: false,
    receiptWritten: false,
    unconditionalForcePushExecuted: false,
    githubWriteExecuted: false,
    shellExecuted: false
  };
}

function finish(
  decision: ControlledRemoteBranchPushDecision,
  issues: readonly ControlledRemoteBranchPushIssue[],
  receipt: ControlledRemoteBranchPushReceipt | null,
  localReceiptVerification:
    ControlledLocalDeliveryReceiptVerificationResult | null,
  summary:
    ControlledRemoteBranchPushResult["summary"]
): ControlledRemoteBranchPushResult {
  return deepFreeze({
    decision,
    issues: [...issues],
    receipt,
    localReceiptVerification,
    summary
  });
}

function numericLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      `Invalid trusted remote push limit: ${field}.`
    );
  }
  return value as number;
}

function validateInput(
  input:
    ExecuteControlledRemoteBranchPushInput
): ValidatedInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !==
      Object.prototype ||
    typeof input.repositoryPath !==
      "string" ||
    input.repositoryPath.length === 0 ||
    typeof input.registryDirectoryPath !==
      "string" ||
    input.registryDirectoryPath.length === 0 ||
    typeof input.remoteName !== "string" ||
    !REMOTE_NAME.test(input.remoteName) ||
    !input.localDeliveryReceipt ||
    !input.contract ||
    !input.integratedReceipt ||
    !input.applyReceipt
  ) {
    throw new PushFailure(
      "invalid_controlled_remote_branch_push_input",
      "Remote branch push input is invalid."
    );
  }
  return {
    input,
    timeoutMs: numericLimit(
      input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs"
    ),
    maxGitOutputBytes: numericLimit(
      input.maxGitOutputBytes,
      DEFAULT_GIT_OUTPUT_BYTES,
      MAX_GIT_OUTPUT_BYTES,
      "maxGitOutputBytes"
    )
  };
}

function gitEnvironment():
NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C"
  };
}

async function runGit(
  repository: string,
  args: readonly string[],
  validated: ValidatedInput,
  acceptedExitCodes:
    readonly number[] = [0]
): Promise<Buffer> {
  return await new Promise(
    (resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd: repository,
          env: gitEnvironment(),
          encoding: "buffer",
          timeout:
            validated.timeoutMs,
          maxBuffer:
            validated.maxGitOutputBytes,
          windowsHide: true
        },
        (error, stdout) => {
          const output =
            Buffer.isBuffer(stdout)
              ? stdout
              : Buffer.from(
                  stdout ?? ""
                );
          if (
            output.length >
              validated.maxGitOutputBytes
          ) {
            reject(
              new PushFailure(
                "controlled_remote_branch_push_output_limit",
                "A bounded Git operation exceeded its output limit."
              )
            );
            return;
          }
          if (error) {
            const maybe =
              error as
                NodeJS.ErrnoException & {
                  code?:
                    string | number;
                  killed?: boolean;
                };
            if (
              maybe.killed ||
              maybe.code ===
                "ETIMEDOUT"
            ) {
              reject(
                new PushFailure(
                  "controlled_remote_branch_push_timeout",
                  "A bounded Git operation timed out.",
                  "review"
                )
              );
              return;
            }
            const exitCode =
              typeof maybe.code ===
                "number"
                ? maybe.code
                : -1;
            if (
              acceptedExitCodes.includes(
                exitCode
              )
            ) {
              resolve(output);
              return;
            }
            reject(
              new PushFailure(
                "controlled_remote_branch_push_git_failed",
                "A bounded Git remote operation failed.",
                "review"
              )
            );
            return;
          }
          resolve(output);
        }
      );
    }
  );
}

function text(
  output: Buffer,
  allowNul = false
): string {
  const value =
    output.toString("utf8");
  if (
    value.includes("\ufffd") ||
    (
      !allowNul &&
      value.includes("\0")
    )
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_git_output_invalid",
      "Git returned malformed text."
    );
  }
  return value;
}

function oneLine(
  output: Buffer
): string {
  const value =
    text(output)
      .replace(/[\r\n]+$/, "");
  if (
    value.length === 0 ||
    value.includes("\n") ||
    value.includes("\r") ||
    ASCII_CONTROL.test(value)
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_git_output_invalid",
      "Git returned an invalid single-line value."
    );
  }
  return value;
}

function inside(
  parent: string,
  child: string
): boolean {
  const relative =
    path.relative(parent, child);
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(
        `..${path.sep}`
      ) &&
      !path.isAbsolute(relative)
    )
  );
}

async function noSymlinkSegments(
  configured: string
): Promise<void> {
  const absolute =
    path.resolve(configured);
  const parsed =
    path.parse(absolute);
  let current = parsed.root;
  for (
    const segment
    of absolute
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)
  ) {
    current =
      path.join(current, segment);
    const metadata =
      await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new PushFailure(
        "controlled_remote_branch_push_symlink_detected",
        "A configured path contains a symbolic link."
      );
    }
  }
}

async function privateDirectory(
  configured: string
): Promise<string> {
  await noSymlinkSegments(
    configured
  );
  const resolved =
    await realpath(configured);
  const metadata =
    await lstat(resolved);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "A private remote push registry is required."
    );
  }
  return resolved;
}

async function syncDirectory(
  directory: string
): Promise<void> {
  let handle;
  try {
    handle =
      await open(
        directory,
        fsConstants.O_RDONLY
      );
    await handle.sync();
  } catch (error) {
    const code =
      (error as
        NodeJS.ErrnoException)
        .code ?? "";
    if (
      ![
        "EINVAL",
        "ENOTSUP",
        "EISDIR",
        "EBADF"
      ].includes(code)
    ) {
      throw error;
    }
  } finally {
    await handle?.close()
      .catch(() => undefined);
  }
}

async function ensurePrivateDirectory(
  directory: string
): Promise<void> {
  let created = false;
  try {
    await mkdir(
      directory,
      { mode: 0o700 }
    );
    created = true;
  } catch (error) {
    if (
      (error as
        NodeJS.ErrnoException)
        .code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const metadata =
    await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !==
      0o700
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "Remote push registry namespace is unsafe."
    );
  }
  if (created) {
    await chmod(
      directory,
      0o700
    );
    await syncDirectory(
      path.dirname(directory)
    );
  }
}

async function resolveLocations(
  validated: ValidatedInput,
  createRoot: boolean
): Promise<PushLocations> {
  await noSymlinkSegments(
    validated.input.repositoryPath
  );
  const repository =
    await realpath(
      validated.input.repositoryPath
    );
  const topLevel =
    oneLine(
      await runGit(
        repository,
        [
          "rev-parse",
          "--show-toplevel"
        ],
        validated
      )
    );
  if (
    await realpath(topLevel) !==
      repository
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_repository_invalid",
      "Configured path is not the repository root."
    );
  }
  const gitCommonRaw =
    oneLine(
      await runGit(
        repository,
        [
          "rev-parse",
          "--git-common-dir"
        ],
        validated
      )
    );
  const gitCommon =
    await realpath(
      path.resolve(
        repository,
        gitCommonRaw
      )
    );
  const registry =
    await privateDirectory(
      validated.input
        .registryDirectoryPath
    );
  if (
    inside(repository, registry) ||
    inside(registry, repository) ||
    inside(gitCommon, registry) ||
    inside(registry, gitCommon)
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "Remote push registry overlaps repository state."
    );
  }
  const pushRoot =
    path.join(
      registry,
      "remote-pushes"
    );
  if (createRoot) {
    await ensurePrivateDirectory(
      pushRoot
    );
  } else {
    const metadata =
      await lstat(pushRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !==
        0o700
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_registry_invalid",
        "Remote push registry root is invalid."
      );
    }
  }
  return {
    repository,
    registry,
    gitCommon,
    pushRoot,
    claim: path.join(
      pushRoot,
      validated.input.contract
        .deliveryKey.slice(7)
    )
  };
}

function normalizeRemoteIdentity(
  raw: string
): string | null {
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length >
      MAX_PATH_LENGTH ||
    ASCII_CONTROL.test(value)
  ) {
    return null;
  }
  const scp =
    /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/
      .exec(value);
  if (
    scp &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//
      .test(value)
  ) {
    const host =
      scp[1]?.toLowerCase();
    let repository =
      scp[2] ?? "";
    repository =
      repository
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "");
    if (
      !host ||
      !repository ||
      ASCII_CONTROL.test(repository)
    ) {
      return null;
    }
    return `ssh://${host}/${repository.replace(/^\/+/, "")}`;
  }
  try {
    const parsed =
      new URL(value);
    if (
      !parsed.protocol ||
      !parsed.hostname
    ) {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hostname =
      parsed.hostname.toLowerCase();
    let pathname =
      parsed.pathname
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "");
    if (pathname === "") {
      pathname = "/";
    }
    parsed.pathname = pathname;
    parsed.hash = "";
    parsed.search = "";
    return parsed
      .toString()
      .replace(/\/$/, "");
  } catch {
    if (
      /^(?:\.\.?\/|\/)/
        .test(value)
    ) {
      return value
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "");
    }
    return null;
  }
}

async function currentRepositoryIdentity(
  repository: string,
  validated: ValidatedInput
): Promise<string> {
  const objectFormat =
    oneLine(
      await runGit(
        repository,
        [
          "rev-parse",
          "--show-object-format"
        ],
        validated
      )
    );
  if (
    objectFormat !== "sha1" &&
    objectFormat !== "sha256"
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_object_format_invalid",
      "Repository object format is unsupported.",
      "review"
    );
  }
  const oid =
    objectFormat === "sha1"
      ? /^[0-9a-f]{40}$/
      : /^[0-9a-f]{64}$/;
  const roots =
    text(
      await runGit(
        repository,
        [
          "rev-list",
          "--max-parents=0",
          "HEAD"
        ],
        validated
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
  if (
    roots.length === 0 ||
    roots.some(
      (value) => !oid.test(value)
    )
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_repository_identity_invalid",
      "Repository root commit evidence is invalid."
    );
  }
  const remoteOutput =
    text(
      await runGit(
        repository,
        [
          "config",
          "--get-regexp",
          "^remote\\..*\\.url$"
        ],
        validated,
        [0, 1]
      )
    );
  const remoteIdentityHashes:
    string[] = [];
  for (
    const line
    of remoteOutput
      .split(/\r?\n/)
  ) {
    if (line === "") {
      continue;
    }
    const separator =
      line.search(/[ \t]/);
    if (separator < 1) {
      throw new PushFailure(
        "controlled_remote_branch_push_repository_identity_invalid",
        "A repository remote identity is malformed.",
        "review"
      );
    }
    const normalized =
      normalizeRemoteIdentity(
        line.slice(separator + 1)
      );
    if (normalized === null) {
      throw new PushFailure(
        "controlled_remote_branch_push_repository_identity_invalid",
        "A repository remote identity cannot be normalized.",
        "review"
      );
    }
    remoteIdentityHashes.push(
      hashCanonicalJson({
        artifactType:
          "controlled_repository_remote_identity",
        normalizedRemoteIdentity:
          normalized
      })
    );
  }
  return hashCanonicalJson({
    artifactType:
      "controlled_repository_identity",
    objectFormat,
    rootCommitObjectIds:
      sortedUnique(roots),
    remoteIdentityHashes:
      sortedUnique(
        remoteIdentityHashes
      )
  });
}

async function localRefs(
  repository: string,
  validated: ValidatedInput
): Promise<{
  base: string;
  head: string;
}> {
  const { contract } =
    validated.input;
  const base =
    oneLine(
      await runGit(
        repository,
        [
          "rev-parse",
          `refs/heads/${contract.repository.baseBranch}`
        ],
        validated
      )
    );
  const head =
    oneLine(
      await runGit(
        repository,
        [
          "rev-parse",
          `refs/heads/${contract.branch.name}`
        ],
        validated
      )
    );
  if (
    !COMMIT.test(base) ||
    !COMMIT.test(head)
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_local_ref_invalid",
      "A required local ref is invalid."
    );
  }
  return { base, head };
}

async function remoteRefs(
  repository: string,
  validated: ValidatedInput
): Promise<Map<string, string>> {
  const { input } = validated;
  const baseRef =
    `refs/heads/${input.contract.repository.baseBranch}`;
  const headRef =
    `refs/heads/${input.contract.branch.name}`;
  const output =
    text(
      await runGit(
        repository,
        [
          "ls-remote",
          "--refs",
          input.remoteName,
          baseRef,
          headRef
        ],
        validated
      )
    );
  const result =
    new Map<string, string>();
  for (
    const line
    of output
      .split(/\r?\n/)
  ) {
    if (line === "") {
      continue;
    }
    const match =
      /^([0-9a-f]{40,64})\t(.+)$/
        .exec(line);
    if (
      !match ||
      (
        match[2] !== baseRef &&
        match[2] !== headRef
      ) ||
      result.has(match[2])
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_remote_ref_invalid",
        "Remote ref evidence is invalid.",
        "review"
      );
    }
    result.set(
      match[2],
      match[1]
    );
  }
  return result;
}

async function writeExclusiveJson(
  file: string,
  value: unknown
): Promise<void> {
  const handle =
    await open(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL,
      0o600
    );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(
      Buffer.from(
        JSON.stringify(value),
        "utf8"
      )
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(
    path.dirname(file)
  );
}

async function writeMarker(
  file: string
): Promise<void> {
  const handle =
    await open(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL,
      0o600
    );
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(
    path.dirname(file)
  );
}

function receiptStructureValid(
  receipt:
    ControlledRemoteBranchPushReceipt
): boolean {
  return (
    receipt.receiptVersion === "1" &&
    receipt.outcome ===
      "remote_branch_pushed" &&
    HASH.test(receipt.deliveryKey) &&
    HASH.test(receipt.contractHash) &&
    HASH.test(
      receipt.localDeliveryReceiptHash
    ) &&
    HASH.test(
      receipt.evidenceSetHash
    ) &&
    HASH.test(
      receipt.repositoryIdentityHash
    ) &&
    HASH.test(
      receipt.remote.remoteNameHash
    ) &&
    COMMIT.test(
      receipt.remote.baseCommitHash
    ) &&
    COMMIT.test(
      receipt.remote.headCommitHash
    ) &&
    HASH.test(receipt.receiptHash) &&
    receipt.receiptHash ===
      hashWithout(
        receipt as unknown as
          PlainRecord,
        "receiptHash"
      )
  );
}

async function readClaim(
  claim: string
): Promise<ClaimState> {
  let metadata;
  try {
    metadata =
      await lstat(claim);
  } catch (error) {
    if (
      (error as
        NodeJS.ErrnoException)
        .code === "ENOENT"
    ) {
      return {
        state: "missing",
        receipt: null
      };
    }
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !==
      0o700
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "Existing remote push claim is unsafe."
    );
  }
  const entries =
    await readdir(
      claim,
      { withFileTypes: true }
    );
  if (
    entries.length >
      MAX_REGISTRY_ENTRIES ||
    entries.some(
      (entry) =>
        entry.isSymbolicLink()
    )
  ) {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "Existing remote push claim layout is unsafe."
    );
  }
  const names =
    new Set(
      entries.map(
        (entry) => entry.name
      )
    );
  if (
    !names.has("receipt.json") ||
    !names.has("COMMITTED")
  ) {
    return {
      state: "incomplete",
      receipt: null
    };
  }
  try {
    const receipt =
      JSON.parse(
        await readFile(
          path.join(
            claim,
            "receipt.json"
          ),
          "utf8"
        )
      ) as
        ControlledRemoteBranchPushReceipt;
    if (
      !receiptStructureValid(receipt)
    ) {
      throw new Error(
        "invalid receipt"
      );
    }
    return {
      state: "committed",
      receipt
    };
  } catch {
    throw new PushFailure(
      "controlled_remote_branch_push_registry_invalid",
      "Existing remote push receipt is invalid."
    );
  }
}

async function createClaim(
  locations: PushLocations,
  validated: ValidatedInput
): Promise<boolean> {
  try {
    await mkdir(
      locations.claim,
      { mode: 0o700 }
    );
    await chmod(
      locations.claim,
      0o700
    );
    await syncDirectory(
      locations.pushRoot
    );
  } catch (error) {
    if (
      (error as
        NodeJS.ErrnoException)
        .code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  }
  const { input } = validated;
  const intentMaterial = {
    intentVersion: "1",
    deliveryKey:
      input.contract.deliveryKey,
    contractHash:
      input.contract.contractHash,
    localDeliveryReceiptHash:
      input.localDeliveryReceipt
        .receiptHash,
    repositoryIdentityHash:
      input.contract.repository
        .repositoryIdentityHash,
    remoteNameHash:
      hashCanonicalJson({
        artifactType:
          "controlled_remote_name",
        remoteName:
          input.remoteName
      }),
    baseBranch:
      input.contract.repository
        .baseBranch,
    baseCommitHash:
      input.localDeliveryReceipt
        .repository.baseRevision,
    headBranch:
      input.contract.branch.name,
    headCommitHash:
      input.localDeliveryReceipt
        .branch.commitHash
  };
  await writeExclusiveJson(
    path.join(
      locations.claim,
      "intent.json"
    ),
    {
      ...intentMaterial,
      intentHash:
        hashCanonicalJson(
          intentMaterial
        )
    }
  );
  return true;
}

async function currentReceiptState(
  locations: PushLocations,
  validated: ValidatedInput,
  receipt:
    ControlledRemoteBranchPushReceipt
): Promise<{
  current: boolean;
  staleFields: string[];
}> {
  const staleFields: string[] = [];
  const identity =
    await currentRepositoryIdentity(
      locations.repository,
      validated
    );
  if (
    identity !==
      receipt.repositoryIdentityHash
  ) {
    staleFields.push(
      "repositoryIdentityHash"
    );
  }
  const local =
    await localRefs(
      locations.repository,
      validated
    );
  if (
    local.base !==
      receipt.remote.baseCommitHash
  ) {
    staleFields.push(
      "localBaseRef"
    );
  }
  if (
    local.head !==
      receipt.remote.headCommitHash
  ) {
    staleFields.push(
      "localHeadRef"
    );
  }
  const remote =
    await remoteRefs(
      locations.repository,
      validated
    );
  const baseRef =
    `refs/heads/${receipt.remote.baseBranch}`;
  const headRef =
    `refs/heads/${receipt.remote.headBranch}`;
  if (
    remote.get(baseRef) !==
      receipt.remote.baseCommitHash
  ) {
    staleFields.push(
      "remoteBaseRef"
    );
  }
  if (
    remote.get(headRef) !==
      receipt.remote.headCommitHash
  ) {
    staleFields.push(
      "remoteHeadRef"
    );
  }
  if (
    receipt.deliveryKey !==
      validated.input.contract
        .deliveryKey
  ) {
    staleFields.push(
      "deliveryKey"
    );
  }
  if (
    receipt.contractHash !==
      validated.input.contract
        .contractHash
  ) {
    staleFields.push(
      "contractHash"
    );
  }
  if (
    receipt.localDeliveryReceiptHash !==
      validated.input
        .localDeliveryReceipt
        .receiptHash
  ) {
    staleFields.push(
      "localDeliveryReceiptHash"
    );
  }
  return {
    current:
      staleFields.length === 0,
    staleFields:
      sortedUnique(staleFields)
  };
}

export async function executeControlledRemoteBranchPush(
  rawInput:
    ExecuteControlledRemoteBranchPushInput
): Promise<ControlledRemoteBranchPushResult> {
  const summary =
    initialSummary();
  let localReceiptVerification:
    ControlledLocalDeliveryReceiptVerificationResult | null =
      null;
  let locations:
    PushLocations | null = null;
  let claimCreated = false;
  try {
    const validated =
      validateInput(rawInput);
    summary.inputValid = true;
    const { input } = validated;

    localReceiptVerification =
      await verifyControlledLocalDeliveryReceipt({
        repositoryPath:
          input.repositoryPath,
        registryDirectoryPath:
          input.registryDirectoryPath,
        receipt:
          input.localDeliveryReceipt,
        contract:
          input.contract,
        integratedReceipt:
          input.integratedReceipt,
        applyReceipt:
          input.applyReceipt,
        timeoutMs:
          validated.timeoutMs,
        maxGitOutputBytes:
          validated.maxGitOutputBytes
      });
    if (
      localReceiptVerification.decision !==
        "controlled_local_delivery_receipt_current" ||
      !localReceiptVerification
        .downstreamEligible
    ) {
      throw new PushFailure(
        localReceiptVerification.decision ===
          "controlled_local_delivery_receipt_stale"
          ? "controlled_remote_branch_push_local_receipt_stale"
          : "controlled_remote_branch_push_local_receipt_invalid",
        "Local delivery receipt is not current.",
        localReceiptVerification.decision ===
          "controlled_local_delivery_receipt_stale"
          ? "review"
          : "invalid"
      );
    }
    summary.localReceiptCurrent =
      true;

    locations =
      await resolveLocations(
        validated,
        true
      );
    summary.repositoryPathValid =
      true;
    summary.registryPathValid =
      true;

    const identity =
      await currentRepositoryIdentity(
        locations.repository,
        validated
      );
    if (
      identity !==
        input.contract.repository
          .repositoryIdentityHash ||
      identity !==
        input.localDeliveryReceipt
          .repository
          .repositoryIdentityHash
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_repository_identity_mismatch",
        "Repository identity changed before remote push.",
        "review"
      );
    }
    summary.repositoryIdentityMatched =
      true;

    const localBefore =
      await localRefs(
        locations.repository,
        validated
      );
    if (
      localBefore.base !==
        input.localDeliveryReceipt
          .repository.baseRevision ||
      localBefore.base !==
        input.localDeliveryReceipt
          .repository
          .baseBranchRefAfter
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_local_base_mismatch",
        "Local base branch ref changed before remote push.",
        "review"
      );
    }
    summary.localBaseRefMatched =
      true;
    if (
      localBefore.head !==
        input.localDeliveryReceipt
          .branch.commitHash
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_local_head_mismatch",
        "Local bounded branch ref changed before remote push.",
        "review"
      );
    }
    summary.localHeadRefMatched =
      true;

    const existing =
      await readClaim(
        locations.claim
      );
    if (
      existing.state ===
        "committed"
    ) {
      summary.duplicatePushDetected =
        true;
      const replay =
        await currentReceiptState(
          locations,
          validated,
          existing.receipt
        );
      if (replay.current) {
        return finish(
          "controlled_remote_branch_already_pushed",
          [],
          existing.receipt,
          localReceiptVerification,
          summary
        );
      }
      throw new PushFailure(
        "controlled_remote_branch_push_existing_receipt_stale",
        "Existing remote push receipt is stale.",
        "review"
      );
    }
    if (
      existing.state ===
        "incomplete"
    ) {
      summary.duplicatePushDetected =
        true;
      throw new PushFailure(
        "controlled_remote_branch_push_incomplete_claim",
        "An incomplete remote push claim requires recovery.",
        "recovery"
      );
    }

    const remoteBefore =
      await remoteRefs(
        locations.repository,
        validated
      );
    const baseRef =
      `refs/heads/${input.contract.repository.baseBranch}`;
    const headRef =
      `refs/heads/${input.contract.branch.name}`;
    if (
      remoteBefore.get(baseRef) !==
        input.localDeliveryReceipt
          .repository.baseRevision
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_remote_base_stale",
        "Remote base branch is not the contracted base revision.",
        "review"
      );
    }
    summary.remoteBaseFresh =
      true;
    if (
      remoteBefore.has(headRef)
    ) {
      summary.duplicatePushDetected =
        true;
      throw new PushFailure(
        "controlled_remote_branch_push_remote_head_exists",
        "The deterministic remote branch already exists without a current receipt.",
        "blocked"
      );
    }
    summary.remoteHeadAbsent =
      true;

    claimCreated =
      await createClaim(
        locations,
        validated
      );
    if (!claimCreated) {
      summary.duplicatePushDetected =
        true;
      throw new PushFailure(
        "controlled_remote_branch_push_concurrent_claim",
        "Another process claimed this remote push.",
        "blocked"
      );
    }
    summary.durableClaimCreated =
      true;
    await writeMarker(
      path.join(
        locations.claim,
        "PUSH_STARTED"
      )
    );

    summary.pushAttempted = true;
    await runGit(
      locations.repository,
      [
        "push",
        "--porcelain",
        "--no-verify",
        `--force-with-lease=${headRef}:`,
        input.remoteName,
        `${input.localDeliveryReceipt.branch.commitHash}:${headRef}`
      ],
      validated
    );
    summary.pushSucceeded = true;

    const remoteAfter =
      await remoteRefs(
        locations.repository,
        validated
      );
    if (
      remoteAfter.get(baseRef) !==
        input.localDeliveryReceipt
          .repository.baseRevision
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_remote_base_changed",
        "Remote base branch changed during push.",
        "recovery"
      );
    }
    summary.remoteBaseUnchanged =
      true;
    if (
      remoteAfter.get(headRef) !==
        input.localDeliveryReceipt
          .branch.commitHash
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_remote_head_mismatch",
        "Remote bounded branch does not match the local delivery commit.",
        "recovery"
      );
    }
    summary.remoteHeadMatched =
      true;

    const localAfter =
      await localRefs(
        locations.repository,
        validated
      );
    if (
      localAfter.base !==
        localBefore.base
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_local_base_changed",
        "Local base branch ref changed during push.",
        "recovery"
      );
    }
    summary.localBaseRefUnchanged =
      true;
    if (
      localAfter.head !==
        localBefore.head
    ) {
      throw new PushFailure(
        "controlled_remote_branch_push_local_head_changed",
        "Local bounded branch ref changed during push.",
        "recovery"
      );
    }
    summary.localHeadRefUnchanged =
      true;

    const receiptMaterial = {
      receiptVersion: "1" as const,
      outcome:
        "remote_branch_pushed" as const,
      deliveryKey:
        input.contract.deliveryKey,
      contractHash:
        input.contract.contractHash,
      localDeliveryReceiptHash:
        input.localDeliveryReceipt
          .receiptHash,
      evidenceSetHash:
        input.contract.evidence
          .evidenceSetHash,
      repositoryIdentityHash:
        identity,
      remote: {
        remoteNameHash:
          hashCanonicalJson({
            artifactType:
              "controlled_remote_name",
            remoteName:
              input.remoteName
          }),
        baseBranch:
          input.contract.repository
            .baseBranch,
        baseCommitHash:
          localBefore.base,
        headBranch:
          input.contract.branch.name,
        headCommitHash:
          localBefore.head
      },
      safety: {
        localReceiptCurrentBeforePush:
          true as const,
        repositoryIdentityMatched:
          true as const,
        localBaseRefMatched:
          true as const,
        localHeadRefMatched:
          true as const,
        remoteBaseFreshBeforePush:
          true as const,
        remoteHeadAbsentBeforePush:
          true as const,
        durableClaimCreatedBeforePush:
          true as const,
        leaseProtectedCreation:
          true as const,
        remoteBaseUnchangedAfterPush:
          true as const,
        remoteHeadMatchedAfterPush:
          true as const,
        localBaseRefUnchanged:
          true as const,
        localHeadRefUnchanged:
          true as const,
        unconditionalForcePushExecuted:
          false as const,
        githubWriteExecuted:
          false as const,
        shellExecuted:
          false as const
      }
    };
    const receipt:
      ControlledRemoteBranchPushReceipt = {
        ...receiptMaterial,
        receiptHash:
          hashCanonicalJson(
            receiptMaterial
          )
      };
    await writeExclusiveJson(
      path.join(
        locations.claim,
        "receipt.json"
      ),
      receipt
    );
    await writeMarker(
      path.join(
        locations.claim,
        "COMMITTED"
      )
    );
    summary.receiptWritten =
      true;

    return finish(
      "controlled_remote_branch_pushed",
      [],
      receipt,
      localReceiptVerification,
      summary
    );
  } catch (error) {
    if (
      error instanceof TypeError &&
      !(error instanceof PushFailure)
    ) {
      throw error;
    }
    const originalFailure =
      error instanceof PushFailure
        ? error
        : new PushFailure(
            "controlled_remote_branch_push_exception",
            "Remote branch push failed without exposing unbounded command output."
          );

    /*
     * Once the durable claim exists, an attempted push may have produced
     * remote side effects even when Git reports failure. Every subsequent
     * failure therefore requires explicit recovery and remote inspection.
     */
    const failure =
      claimCreated
        ? new PushFailure(
            originalFailure.code,
            originalFailure.message,
            "recovery",
            originalFailure.field
          )
        : originalFailure;

    if (
      claimCreated &&
      locations
    ) {
      try {
        await writeMarker(
          path.join(
            locations.claim,
            "FAILED"
          )
        );
      } catch {
        // Preserve the original failure.
      }
    }

    const decision:
      ControlledRemoteBranchPushDecision =
      failure.kind === "blocked"
        ? "controlled_remote_branch_push_blocked"
        : failure.kind === "review"
          ? "controlled_remote_branch_push_needs_review"
          : failure.kind === "recovery"
            ? "controlled_remote_branch_push_recovery_required"
            : "controlled_remote_branch_push_invalid";

    return finish(
      decision,
      [issue(failure)],
      null,
      localReceiptVerification,
      summary
    );
  }
}

export async function verifyControlledRemoteBranchPushReceipt(
  rawInput:
    VerifyControlledRemoteBranchPushReceiptInput
): Promise<ControlledRemoteBranchPushReceiptVerificationResult> {
  const errors: string[] = [];
  const staleFields: string[] = [];
  try {
    const validated =
      validateInput({
        repositoryPath:
          rawInput.repositoryPath,
        registryDirectoryPath:
          rawInput.registryDirectoryPath,
        remoteName:
          rawInput.remoteName,
        localDeliveryReceipt:
          rawInput.localDeliveryReceipt,
        contract:
          rawInput.contract,
        integratedReceipt:
          rawInput.integratedReceipt,
        applyReceipt:
          rawInput.applyReceipt,
        timeoutMs:
          rawInput.timeoutMs,
        maxGitOutputBytes:
          rawInput.maxGitOutputBytes
      });
    if (
      !receiptStructureValid(
        rawInput.receipt
      )
    ) {
      return deepFreeze({
        decision:
          "controlled_remote_branch_push_receipt_invalid",
        receiptIntegrityVerified:
          false,
        localReceiptCurrent:
          false,
        registryRecordMatched:
          false,
        repositoryIdentityMatched:
          false,
        localRefsMatched:
          false,
        remoteBaseMatched:
          false,
        remoteHeadMatched:
          false,
        downstreamEligible:
          false,
        staleFields,
        errors: [
          "controlled_remote_branch_push_receipt_hash_mismatch"
        ],
        pushExecuted: false,
        githubWriteExecuted:
          false,
        shellExecuted: false
      });
    }
    const localVerification =
      await verifyControlledLocalDeliveryReceipt({
        repositoryPath:
          rawInput.repositoryPath,
        registryDirectoryPath:
          rawInput.registryDirectoryPath,
        receipt:
          rawInput.localDeliveryReceipt,
        contract:
          rawInput.contract,
        integratedReceipt:
          rawInput.integratedReceipt,
        applyReceipt:
          rawInput.applyReceipt,
        timeoutMs:
          validated.timeoutMs,
        maxGitOutputBytes:
          validated.maxGitOutputBytes
      });
    const localReceiptCurrent =
      localVerification.decision ===
        "controlled_local_delivery_receipt_current" &&
      localVerification
        .downstreamEligible;
    if (!localReceiptCurrent) {
      staleFields.push(
        "localDeliveryReceipt"
      );
    }
    const locations =
      await resolveLocations(
        validated,
        false
      );
    const claim =
      await readClaim(
        locations.claim
      );
    const registryRecordMatched =
      claim.state ===
        "committed" &&
      canonicalEqual(
        claim.receipt,
        rawInput.receipt
      );
    if (!registryRecordMatched) {
      errors.push(
        "controlled_remote_branch_push_registry_receipt_mismatch"
      );
    }
    const observed =
      await currentReceiptState(
        locations,
        validated,
        rawInput.receipt
      );
    staleFields.push(
      ...observed.staleFields
    );
    const repositoryIdentityMatched =
      !staleFields.includes(
        "repositoryIdentityHash"
      );
    const localRefsMatched =
      !staleFields.includes(
        "localBaseRef"
      ) &&
      !staleFields.includes(
        "localHeadRef"
      );
    const remoteBaseMatched =
      !staleFields.includes(
        "remoteBaseRef"
      );
    const remoteHeadMatched =
      !staleFields.includes(
        "remoteHeadRef"
      );
    const stale =
      staleFields.length > 0;
    return deepFreeze({
      decision:
        errors.length > 0
          ? "controlled_remote_branch_push_receipt_invalid"
          : stale
            ? "controlled_remote_branch_push_receipt_stale"
            : "controlled_remote_branch_push_receipt_current",
      receiptIntegrityVerified:
        true,
      localReceiptCurrent,
      registryRecordMatched,
      repositoryIdentityMatched,
      localRefsMatched,
      remoteBaseMatched,
      remoteHeadMatched,
      downstreamEligible:
        errors.length === 0 &&
        !stale &&
        localReceiptCurrent &&
        registryRecordMatched,
      staleFields:
        sortedUnique(staleFields),
      errors:
        sortedUnique(errors),
      pushExecuted: false,
      githubWriteExecuted: false,
      shellExecuted: false
    });
  } catch {
    return deepFreeze({
      decision:
        "controlled_remote_branch_push_receipt_invalid",
      receiptIntegrityVerified:
        false,
      localReceiptCurrent:
        false,
      registryRecordMatched:
        false,
      repositoryIdentityMatched:
        false,
      localRefsMatched:
        false,
      remoteBaseMatched:
        false,
      remoteHeadMatched:
        false,
      downstreamEligible:
        false,
      staleFields: [],
      errors: [
        "controlled_remote_branch_push_receipt_verification_exception"
      ],
      pushExecuted: false,
      githubWriteExecuted: false,
      shellExecuted: false
    });
  }
}
