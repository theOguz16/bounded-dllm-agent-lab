import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  verifyDraftPrDeliveryContract,
  type DraftPrDeliveryContract,
  type DraftPrDeliveryContractVerificationResult
} from "./draft-pr-delivery-contract.js";
import type {
  IntegratedDisposableApplyReceipt
} from "./integrated-disposable-apply-coordinator.js";
import type {
  ControlledRepositoryApplyReceipt
} from "./controlled-repository-apply.js";
import {
  inspectControlledRepository
} from "./controlled-repository-inspection.js";

export const CONTROLLED_LOCAL_DELIVERY_VERSION = "1" as const;

export type ControlledLocalDeliveryDecision =
  | "controlled_local_delivery_committed"
  | "controlled_local_delivery_already_committed"
  | "controlled_local_delivery_blocked"
  | "controlled_local_delivery_needs_review"
  | "controlled_local_delivery_invalid"
  | "controlled_local_delivery_recovery_required";

export type ControlledLocalDeliveryIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
};

export type ControlledLocalDeliveryReceipt = {
  receiptVersion: "1";
  outcome: "local_commit_created";
  deliveryKey: string;
  contractHash: string;
  evidenceSetHash: string;
  integratedApplyReceiptHash: string;
  x4ApplyReceiptHash: string;
  repository: {
    repositoryIdentityHash: string;
    baseBranch: string;
    baseRevisionHash: string;
    baseRevision: string;
    baseBranchRefBefore: string;
    baseBranchRefAfter: string;
  };
  branch: {
    name: string;
    commitHash: string;
    treeHash: string;
    parentCommitHash: string;
  };
  commit: {
    messageHash: string;
    changedFiles: readonly string[];
    changedFileCount: number;
    stagedContentSetHash: string;
  };
  safety: {
    contractCurrentBeforeWrite: true;
    repositoryIdentityMatched: true;
    baseRevisionMatched: true;
    baseBranchRefUnchanged: true;
    onlyGovernedPathsChangedBeforeWrite: true;
    onlyGovernedPathsStaged: true;
    stagedContentMatched: true;
    branchCreated: true;
    commitCreated: true;
    remoteRefsUnchanged: true;
    pushExecuted: false;
    githubWriteExecuted: false;
    shellExecuted: false;
    hooksExecuted: false;
  };
  receiptHash: string;
};

export type ExecuteControlledLocalDeliveryInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledLocalDeliveryResult = {
  decision: ControlledLocalDeliveryDecision;
  issues: readonly ControlledLocalDeliveryIssue[];
  receipt: ControlledLocalDeliveryReceipt | null;
  contractVerification:
    DraftPrDeliveryContractVerificationResult | null;
  summary: {
    inputValid: boolean;
    contractCurrent: boolean;
    repositoryPathValid: boolean;
    registryPathValid: boolean;
    repositoryIdentityMatched: boolean;
    baseBranchMatched: boolean;
    baseRevisionMatched: boolean;
    baseBranchRefCaptured: boolean;
    repositoryOperationInProgress: boolean;
    indexCleanBeforeWrite: boolean;
    governedWorktreeScopeExact: boolean;
    governedContentMatched: boolean;
    duplicateDeliveryDetected: boolean;
    deliveryClaimCreated: boolean;
    branchCollisionDetected: boolean;
    branchCreated: boolean;
    governedPathsStaged: boolean;
    stagedContentMatched: boolean;
    commitCreated: boolean;
    baseBranchRefUnchanged: boolean;
    remoteRefsUnchanged: boolean;
    receiptWritten: boolean;
    pushExecuted: false;
    githubWriteExecuted: false;
    shellExecuted: false;
    hooksExecuted: false;
  };
};

export type VerifyControlledLocalDeliveryReceiptInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  receipt: ControlledLocalDeliveryReceipt;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledLocalDeliveryReceiptVerificationDecision =
  | "controlled_local_delivery_receipt_current"
  | "controlled_local_delivery_receipt_stale"
  | "controlled_local_delivery_receipt_invalid";

export type ControlledLocalDeliveryReceiptVerificationResult = {
  decision: ControlledLocalDeliveryReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  contractCurrent: boolean;
  registryRecordMatched: boolean;
  branchCommitMatched: boolean;
  baseBranchRefUnchanged: boolean;
  changedFilesMatched: boolean;
  downstreamEligible: boolean;
  staleFields: readonly string[];
  errors: readonly string[];
  pushExecuted: false;
  githubWriteExecuted: false;
  shellExecuted: false;
};

type PlainRecord = Record<string, unknown>;

type ValidatedInput = {
  input: ExecuteControlledLocalDeliveryInput;
  timeoutMs: number;
  maxGitOutputBytes: number;
};

type DeliveryLocations = {
  repository: string;
  registry: string;
  gitCommon: string;
  claim: string;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_CHANGED_FILES = 10_000;
const MAX_REGISTRY_ENTRIES = 20;
const MAX_GOVERNED_FILE_BYTES =
  20 * 1024 * 1024;
const execFileAsync = promisify(execFile);

class DeliveryFailure extends Error {
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

function initialSummary():
ControlledLocalDeliveryResult["summary"] {
  return {
    inputValid: false,
    contractCurrent: false,
    repositoryPathValid: false,
    registryPathValid: false,
    repositoryIdentityMatched: false,
    baseBranchMatched: false,
    baseRevisionMatched: false,
    baseBranchRefCaptured: false,
    repositoryOperationInProgress: false,
    indexCleanBeforeWrite: false,
    governedWorktreeScopeExact: false,
    governedContentMatched: false,
    duplicateDeliveryDetected: false,
    deliveryClaimCreated: false,
    branchCollisionDetected: false,
    branchCreated: false,
    governedPathsStaged: false,
    stagedContentMatched: false,
    commitCreated: false,
    baseBranchRefUnchanged: false,
    remoteRefsUnchanged: false,
    receiptWritten: false,
    pushExecuted: false,
    githubWriteExecuted: false,
    shellExecuted: false,
    hooksExecuted: false
  };
}

function issue(
  failure: DeliveryFailure
): ControlledLocalDeliveryIssue {
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

function finish(
  decision: ControlledLocalDeliveryDecision,
  issues: readonly ControlledLocalDeliveryIssue[],
  receipt: ControlledLocalDeliveryReceipt | null,
  contractVerification:
    DraftPrDeliveryContractVerificationResult | null,
  summary:
    ControlledLocalDeliveryResult["summary"]
): ControlledLocalDeliveryResult {
  return deepFreeze({
    decision,
    issues: [...issues],
    receipt,
    contractVerification,
    summary
  });
}

function validateNumericLimit(
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
      `Invalid trusted local delivery limit: ${field}.`
    );
  }
  return value as number;
}

function validateInput(
  input: ExecuteControlledLocalDeliveryInput
): ValidatedInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new DeliveryFailure(
      "invalid_controlled_local_delivery_input",
      "Local delivery input is invalid."
    );
  }
  if (
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    typeof input.registryDirectoryPath !== "string" ||
    input.registryDirectoryPath.length === 0 ||
    !input.contract ||
    !input.integratedReceipt ||
    !input.applyReceipt
  ) {
    throw new DeliveryFailure(
      "invalid_controlled_local_delivery_input",
      "Required local delivery input is missing."
    );
  }
  if (
    input.contract.commit.changedFiles.length === 0 ||
    input.contract.commit.changedFiles.length >
      MAX_CHANGED_FILES ||
    input.contract.commit.changedFileCount !==
      input.contract.commit.changedFiles.length
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_changed_files_invalid",
      "Changed-file scope is invalid."
    );
  }
  return {
    input,
    timeoutMs: validateNumericLimit(
      input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs"
    ),
    maxGitOutputBytes: validateNumericLimit(
      input.maxGitOutputBytes,
      DEFAULT_GIT_OUTPUT_BYTES,
      MAX_GIT_OUTPUT_BYTES,
      "maxGitOutputBytes"
    )
  };
}

function inside(
  parent: string,
  child: string
): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    )
  );
}

async function noSymlinkSegments(
  configured: string
): Promise<void> {
  const absolute = path.resolve(configured);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (
    const segment
    of absolute
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)
  ) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new DeliveryFailure(
        "controlled_local_delivery_symlink_detected",
        "Configured path contains a symbolic link.",
        "invalid"
      );
    }
  }
}

async function privateDirectory(
  configured: string
): Promise<string> {
  await noSymlinkSegments(configured);
  const absolute = await realpath(configured);
  const metadata = await lstat(absolute);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_registry_invalid",
      "A private delivery registry directory is required.",
      "invalid",
      "registryDirectoryPath"
    );
  }
  return absolute;
}

function gitEnvironment(
  timeoutMs: number
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    BOUNDED_DELIVERY_TIMEOUT:
      String(timeoutMs)
  };
}

async function gitText(
  repository: string,
  args: readonly string[],
  validated: ValidatedInput,
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<string> {
  const result = await execFileAsync(
    "git",
    [...args],
    {
      cwd: repository,
      timeout: validated.timeoutMs,
      maxBuffer:
        validated.maxGitOutputBytes,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...gitEnvironment(
          validated.timeoutMs
        ),
        ...extraEnvironment
      }
    }
  );
  return result.stdout;
}

async function gitBuffer(
  repository: string,
  args: readonly string[],
  validated: ValidatedInput
): Promise<Buffer> {
  return await new Promise(
    (resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd: repository,
          timeout:
            validated.timeoutMs,
          maxBuffer:
            validated.maxGitOutputBytes,
          encoding: null,
          windowsHide: true,
          env: gitEnvironment(
            validated.timeoutMs
          )
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(
            Buffer.isBuffer(stdout)
              ? stdout
              : Buffer.from(stdout)
          );
        }
      );
    }
  );
}

async function refExists(
  repository: string,
  ref: string,
  validated: ValidatedInput
): Promise<boolean> {
  try {
    await gitText(
      repository,
      [
        "show-ref",
        "--verify",
        "--quiet",
        ref
      ],
      validated
    );
    return true;
  } catch (error) {
    const code =
      (error as {
        code?: unknown;
      }).code;

    if (code === 1) {
      return false;
    }

    throw error;
  }
}

function parseNullList(
  value: string
): string[] {
  return value
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function parseStatusPaths(
  value: string
): {
  paths: string[];
  staged: boolean;
  conflicted: boolean;
  renameOrCopy: boolean;
} {
  const entries = parseNullList(value);
  const paths: string[] = [];
  let staged = false;
  let conflicted = false;
  let renameOrCopy = false;
  for (
    let index = 0;
    index < entries.length;
    index += 1
  ) {
    const entry = entries[index]!;
    if (entry.length < 4) {
      throw new DeliveryFailure(
        "controlled_local_delivery_status_invalid",
        "Git status output is invalid."
      );
    }
    const x = entry[0]!;
    const y = entry[1]!;
    const filePath = entry.slice(3);
    if (
      x !== " " &&
      x !== "?" &&
      x !== "!"
    ) {
      staged = true;
    }
    if (
      x === "U" ||
      y === "U" ||
      (x === "A" && y === "A") ||
      (x === "D" && y === "D")
    ) {
      conflicted = true;
    }
    if (
      x === "R" ||
      x === "C" ||
      y === "R" ||
      y === "C"
    ) {
      renameOrCopy = true;
      index += 1;
    }
    paths.push(filePath);
  }
  return {
    paths: sortedUnique(paths),
    staged,
    conflicted,
    renameOrCopy
  };
}

async function remoteRefSnapshot(
  repository: string,
  validated: ValidatedInput
): Promise<string> {
  return await gitText(
    repository,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/remotes"
    ],
    validated
  );
}

async function syncDirectory(
  directory: string
): Promise<void> {
  let handle;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY
    );
    await handle.sync();
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException)
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
      (error as NodeJS.ErrnoException)
        .code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_registry_invalid",
      "Delivery registry namespace is unsafe."
    );
  }
  if (created) {
    await chmod(directory, 0o700);
    await syncDirectory(
      path.dirname(directory)
    );
  }
}

async function writeExclusiveJson(
  file: string,
  value: unknown
): Promise<void> {
  const handle = await open(
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

async function writeExclusiveMarker(
  file: string
): Promise<void> {
  const handle = await open(
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

async function validateLocations(
  validated: ValidatedInput
): Promise<DeliveryLocations> {
  const {
    repositoryPath,
    registryDirectoryPath,
    contract
  } = validated.input;
  await noSymlinkSegments(
    repositoryPath
  );
  const repository =
    await realpath(repositoryPath);
  const topLevel =
    (
      await gitText(
        repository,
        [
          "rev-parse",
          "--show-toplevel"
        ],
        validated
      )
    ).trim();
  if (
    await realpath(topLevel) !==
      repository
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_repository_invalid",
      "Configured path is not the repository root."
    );
  }
  const gitCommonRaw =
    (
      await gitText(
        repository,
        [
          "rev-parse",
          "--git-common-dir"
        ],
        validated
      )
    ).trim();
  const gitCommon =
    await realpath(
      path.resolve(
        repository,
        gitCommonRaw
      )
    );
  const registry =
    await privateDirectory(
      registryDirectoryPath
    );
  if (
    inside(repository, registry) ||
    inside(registry, repository) ||
    inside(gitCommon, registry) ||
    inside(registry, gitCommon)
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_registry_invalid",
      "Delivery registry overlaps repository state."
    );
  }
  const deliveryRoot =
    path.join(
      registry,
      "deliveries"
    );
  await ensurePrivateDirectory(
    deliveryRoot
  );
  const claim =
    path.join(
      deliveryRoot,
      contract.deliveryKey.slice(7)
    );
  return {
    repository,
    registry,
    gitCommon,
    claim
  };
}

function fileStateMap(
  applyReceipt:
    ControlledRepositoryApplyReceipt
): Map<
  string,
  {
    finalStateHash: string;
  }
> {
  const result = new Map<
    string,
    {
      finalStateHash: string;
    }
  >();
  for (
    const entry
    of applyReceipt.after.appliedFiles
  ) {
    result.set(
      entry.filePath,
      {
        finalStateHash:
          entry.finalStateHash
      }
    );
  }
  return result;
}

function fileEvidenceMap(
  contract:
    DraftPrDeliveryContract
): Map<string, string> {
  const result =
    new Map<string, string>();
  for (
    const reference
    of contract.evidence.references
  ) {
    if (reference.kind === "file") {
      result.set(
        reference.filePath,
        reference.contentHash
      );
    }
  }
  return result;
}

function sha256(
  bytes: Buffer
): string {
  return `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
}

async function inspectGovernedRegularFile(
  target: string
): Promise<{
  contentHash: string;
  stateHash: string;
}> {
  const metadata =
    await lstat(target);

  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size >
      MAX_GOVERNED_FILE_BYTES
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_file_state_mismatch",
      "Governed delivery files must remain bounded regular files.",
      "review"
    );
  }

  const handle =
    await open(
      target,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0)
    );

  try {
    const openedMetadata =
      await handle.stat();

    if (
      !openedMetadata.isFile() ||
      openedMetadata.size >
        MAX_GOVERNED_FILE_BYTES
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_file_state_mismatch",
        "Governed file type changed during inspection.",
        "review"
      );
    }

    const bytes =
      await handle.readFile();

    if (
      bytes.length >
        MAX_GOVERNED_FILE_BYTES
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_file_state_mismatch",
        "Governed file exceeds its delivery bound.",
        "review"
      );
    }

    const mode =
      (openedMetadata.mode & 0o111) !== 0
        ? "100755"
        : "100644";
    const contentHash =
      sha256(bytes);

    return {
      contentHash,
      stateHash:
        hashCanonicalJson({
          artifactType:
            "controlled_repository_file_state",
          state:
            "regular_file",
          mode,
          contentHash
        })
    };
  } finally {
    await handle.close();
  }
}

async function verifyGovernedWorktree(
  repository: string,
  validated: ValidatedInput
): Promise<Map<string, Buffer>> {
  const {
    contract,
    applyReceipt
  } = validated.input;
  const inspection =
    await inspectControlledRepository({
      repositoryPath: repository,
      changedFiles:
        contract.commit.changedFiles,
      timeoutMs:
        validated.timeoutMs,
      maxGitOutputBytes:
        validated.maxGitOutputBytes
    });
  if (!inspection.inspection) {
    throw new DeliveryFailure(
      "controlled_local_delivery_repository_inspection_failed",
      "Repository inspection failed.",
      "review"
    );
  }
  if (
    inspection.summary
      .repositoryOperationInProgress
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_git_operation_in_progress",
      "A Git operation is already active.",
      "review"
    );
  }
  if (
    inspection.inspection.target
      .repositoryIdentityHash !==
      contract.repository
        .repositoryIdentityHash
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_repository_identity_mismatch",
      "Repository identity does not match the delivery contract.",
      "review"
    );
  }
  if (
    inspection.inspection.target
      .baseRevisionHash !==
      contract.repository
        .baseRevisionHash
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_base_revision_mismatch",
      "Repository base revision is stale.",
      "review"
    );
  }
  if (
    inspection.inspection.worktree
      .stagedChangeCount !== 0 ||
    inspection.inspection.worktree
      .conflictedFileCount !== 0
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_index_not_clean",
      "The Git index must be clean before local delivery.",
      "review"
    );
  }
  const expected =
    sortedUnique(
      contract.commit.changedFiles
    );
  const observed =
    sortedUnique(
      inspection.inspection.worktree
        .changedPaths
    );
  if (
    !canonicalEqual(
      expected,
      observed
    )
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_worktree_scope_mismatch",
      "Worktree changes do not exactly match the governed scope.",
      "review"
    );
  }
  const status =
    parseStatusPaths(
      await gitText(
        repository,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all"
        ],
        validated
      )
    );
  if (
    status.staged ||
    status.conflicted ||
    status.renameOrCopy ||
    !canonicalEqual(
      status.paths,
      expected
    )
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_worktree_scope_mismatch",
      "Git status is not an exact unstaged governed mutation.",
      "review"
    );
  }

  const states =
    fileStateMap(applyReceipt);
  const evidence =
    fileEvidenceMap(contract);
  const bytes =
    new Map<string, Buffer>();
  for (const file of expected) {
    const expectedState =
      states.get(file);
    const expectedContent =
      evidence.get(file);
    if (
      !expectedState ||
      !expectedContent ||
      !HASH.test(expectedContent)
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_file_evidence_missing",
        "Governed file evidence is incomplete."
      );
    }
    const absolute =
      path.resolve(
        repository,
        file
      );
    if (
      !inside(repository, absolute)
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_file_path_invalid",
        "Governed file path escapes the repository."
      );
    }
    await noSymlinkSegments(
      absolute
    );

    const current =
      await inspectGovernedRegularFile(
        absolute
      );

    if (
      current.stateHash !==
        expectedState.finalStateHash ||
      current.contentHash !==
        expectedContent
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_file_state_mismatch",
        "Governed worktree content does not match X.4 applied evidence.",
        "review",
        file
      );
    }
    bytes.set(
      file,
      await readFile(absolute)
    );
  }
  return bytes;
}

async function validateBranchPreconditions(
  repository: string,
  validated: ValidatedInput
): Promise<{
  baseRevision: string;
  baseRef: string;
  remoteRefs: string;
}> {
  const { contract } =
    validated.input;
  let currentBranch: string;
  try {
    currentBranch =
      (
        await gitText(
          repository,
          [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD"
          ],
          validated
        )
      ).trim();
  } catch {
    throw new DeliveryFailure(
      "controlled_local_delivery_detached_head",
      "Detached HEAD cannot be delivered.",
      "review"
    );
  }
  if (
    currentBranch !==
      contract.repository.baseBranch
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_base_branch_mismatch",
      "Repository is not checked out on the contracted base branch.",
      "review"
    );
  }
  const baseRevision =
    (
      await gitText(
        repository,
        [
          "rev-parse",
          "HEAD"
        ],
        validated
      )
    ).trim();
  const baseRef =
    (
      await gitText(
        repository,
        [
          "rev-parse",
          `refs/heads/${contract.repository.baseBranch}`
        ],
        validated
      )
    ).trim();
  if (
    !COMMIT.test(baseRevision) ||
    baseRevision !== baseRef
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_base_ref_mismatch",
      "Base branch ref and HEAD do not match.",
      "review"
    );
  }
  if (
    await refExists(
      repository,
      `refs/heads/${contract.branch.name}`,
      validated
    ) ||
    await refExists(
      repository,
      `refs/remotes/origin/${contract.branch.name}`,
      validated
    )
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_branch_collision",
      "The deterministic delivery branch already exists.",
      "blocked"
    );
  }
  return {
    baseRevision,
    baseRef,
    remoteRefs:
      await remoteRefSnapshot(
        repository,
        validated
      )
  };
}

function fullCommitMessage(
  contract:
    DraftPrDeliveryContract
): string {
  return [
    contract.commit.message,
    "",
    `Bounded-Delivery-Key: ${contract.deliveryKey}`,
    `Bounded-Contract-Hash: ${contract.contractHash}`,
    `Bounded-Evidence-Set-Hash: ${contract.evidence.evidenceSetHash}`,
    `Bounded-Integrated-Receipt: ${contract.source.integratedApplyReceiptHash}`,
    `Bounded-X4-Receipt: ${contract.source.x4ApplyReceiptHash}`,
    `Bounded-X5-Receipt: ${contract.source.x5FinalReceiptHash}`
  ].join("\n");
}

async function stagedBlobBytes(
  repository: string,
  file: string,
  validated: ValidatedInput
): Promise<Buffer> {
  const stage =
    await gitText(
      repository,
      [
        "ls-files",
        "--stage",
        "-z",
        "--",
        file
      ],
      validated
    );
  const record =
    parseNullList(stage)[0];
  if (!record) {
    throw new DeliveryFailure(
      "controlled_local_delivery_staged_entry_missing",
      "A governed staged entry is missing.",
      "recovery",
      file
    );
  }
  const metadata =
    record.slice(
      0,
      record.indexOf("\t")
    );
  const parts =
    metadata.split(" ");
  const objectId = parts[1];
  const stageNumber = parts[2];
  if (
    !objectId ||
    !COMMIT.test(objectId) ||
    stageNumber !== "0"
  ) {
    throw new DeliveryFailure(
      "controlled_local_delivery_staged_entry_invalid",
      "A governed staged entry is invalid.",
      "recovery",
      file
    );
  }
  return await gitBuffer(
    repository,
    [
      "cat-file",
      "blob",
      objectId
    ],
    validated
  );
}

async function createClaim(
  locations: DeliveryLocations,
  validated: ValidatedInput,
  baseRevision: string
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
      path.dirname(
        locations.claim
      )
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)
        .code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  }
  const { contract } =
    validated.input;
  const intentMaterial = {
    intentVersion: "1",
    deliveryKey:
      contract.deliveryKey,
    contractHash:
      contract.contractHash,
    evidenceSetHash:
      contract.evidence.evidenceSetHash,
    repositoryIdentityHash:
      contract.repository
        .repositoryIdentityHash,
    baseBranch:
      contract.repository.baseBranch,
    baseRevisionHash:
      contract.repository
        .baseRevisionHash,
    baseRevision,
    branchName:
      contract.branch.name
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

function validateReceiptStructure(
  receipt:
    ControlledLocalDeliveryReceipt
): boolean {
  return (
    receipt.receiptVersion === "1" &&
    receipt.outcome ===
      "local_commit_created" &&
    HASH.test(receipt.deliveryKey) &&
    HASH.test(receipt.contractHash) &&
    HASH.test(receipt.evidenceSetHash) &&
    HASH.test(
      receipt.integratedApplyReceiptHash
    ) &&
    HASH.test(receipt.x4ApplyReceiptHash) &&
    HASH.test(receipt.receiptHash) &&
    COMMIT.test(
      receipt.repository.baseRevision
    ) &&
    COMMIT.test(
      receipt.branch.commitHash
    ) &&
    COMMIT.test(
      receipt.branch.treeHash
    ) &&
    COMMIT.test(
      receipt.branch.parentCommitHash
    ) &&
    receipt.receiptHash ===
      hashWithout(
        receipt as unknown as PlainRecord,
        "receiptHash"
      )
  );
}

async function readExistingReceipt(
  claim: string
): Promise<
  ControlledLocalDeliveryReceipt | null
> {
  try {
    const metadata =
      await lstat(claim);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_registry_invalid",
        "Existing delivery claim is unsafe."
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
      throw new DeliveryFailure(
        "controlled_local_delivery_registry_invalid",
        "Existing delivery claim layout is unsafe."
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
      return null;
    }
    const receipt =
      JSON.parse(
        await readFile(
          path.join(
            claim,
            "receipt.json"
          ),
          "utf8"
        )
      ) as ControlledLocalDeliveryReceipt;
    return validateReceiptStructure(
      receipt
    )
      ? receipt
      : null;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)
        .code === "ENOENT"
    ) {
      return null;
    }

    if (
      error instanceof DeliveryFailure
    ) {
      throw error;
    }

    throw new DeliveryFailure(
      "controlled_local_delivery_registry_invalid",
      "Existing delivery receipt is invalid."
    );
  }
}

async function verifyReceiptAgainstRepository(
  repository: string,
  receipt:
    ControlledLocalDeliveryReceipt,
  contract:
    DraftPrDeliveryContract,
  validated: ValidatedInput
): Promise<{
  current: boolean;
  staleFields: string[];
}> {
  const staleFields: string[] = [];
  if (
    receipt.deliveryKey !==
      contract.deliveryKey
  ) {
    staleFields.push(
      "deliveryKey"
    );
  }
  if (
    receipt.contractHash !==
      contract.contractHash
  ) {
    staleFields.push(
      "contractHash"
    );
  }
  if (
    receipt.evidenceSetHash !==
      contract.evidence
        .evidenceSetHash
  ) {
    staleFields.push(
      "evidenceSetHash"
    );
  }
  let branchCommit = "";
  let baseRef = "";
  try {
    branchCommit =
      (
        await gitText(
          repository,
          [
            "rev-parse",
            `refs/heads/${receipt.branch.name}`
          ],
          validated
        )
      ).trim();
    baseRef =
      (
        await gitText(
          repository,
          [
            "rev-parse",
            `refs/heads/${receipt.repository.baseBranch}`
          ],
          validated
        )
      ).trim();
  } catch {
    staleFields.push(
      "repositoryRefs"
    );
  }
  if (
    branchCommit !==
      receipt.branch.commitHash
  ) {
    staleFields.push(
      "branchCommitHash"
    );
  }
  if (
    baseRef !==
      receipt.repository
        .baseBranchRefAfter ||
    receipt.repository
      .baseBranchRefBefore !==
      receipt.repository
        .baseBranchRefAfter
  ) {
    staleFields.push(
      "baseBranchRef"
    );
  }
  const observedFiles =
    parseNullList(
      await gitText(
        repository,
        [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          receipt.branch.commitHash
        ],
        validated
      )
    ).sort();
  if (
    !canonicalEqual(
      observedFiles,
      receipt.commit.changedFiles
    )
  ) {
    staleFields.push(
      "changedFiles"
    );
  }
  return {
    current:
      staleFields.length === 0,
    staleFields:
      sortedUnique(staleFields)
  };
}

export async function executeControlledLocalDelivery(
  rawInput:
    ExecuteControlledLocalDeliveryInput
): Promise<ControlledLocalDeliveryResult> {
  const summary = initialSummary();
  let contractVerification:
    DraftPrDeliveryContractVerificationResult | null =
      null;
  let locations:
    DeliveryLocations | null = null;
  let claimCreated = false;
  try {
    const validated =
      validateInput(rawInput);
    summary.inputValid = true;
    const { input } = validated;

    contractVerification =
      verifyDraftPrDeliveryContract({
        contract:
          input.contract,
        integratedReceipt:
          input.integratedReceipt,
        applyReceipt:
          input.applyReceipt
      });
    if (
      contractVerification.decision !==
        "draft_pr_delivery_contract_current" ||
      !contractVerification
        .downstreamEligible
    ) {
      throw new DeliveryFailure(
        contractVerification.decision ===
          "draft_pr_delivery_contract_stale"
          ? "controlled_local_delivery_contract_stale"
          : "controlled_local_delivery_contract_invalid",
        "Draft PR delivery contract is not current.",
        contractVerification.decision ===
          "draft_pr_delivery_contract_stale"
          ? "review"
          : "invalid"
      );
    }
    summary.contractCurrent = true;

    locations =
      await validateLocations(
        validated
      );
    summary.repositoryPathValid = true;
    summary.registryPathValid = true;

    if (
      await refExists(
        locations.repository,
        `refs/heads/${input.contract.branch.name}`,
        validated
      ) ||
      await refExists(
        locations.repository,
        `refs/remotes/origin/${input.contract.branch.name}`,
        validated
      )
    ) {
      summary.branchCollisionDetected =
        true;
    }

    try {
      const existing =
        await readExistingReceipt(
          locations.claim
        );
      if (existing) {
        summary.duplicateDeliveryDetected =
          true;
        const replay =
          await verifyReceiptAgainstRepository(
            locations.repository,
            existing,
            input.contract,
            validated
          );
        if (replay.current) {
          return finish(
            "controlled_local_delivery_already_committed",
            [],
            existing,
            contractVerification,
            summary
          );
        }
        throw new DeliveryFailure(
          "controlled_local_delivery_existing_receipt_stale",
          "Existing local delivery receipt is stale.",
          "review"
        );
      }
      const claimMetadata =
        await lstat(
          locations.claim
        ).catch(
          (error: NodeJS.ErrnoException) => {
            if (
              error.code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          }
        );
      if (claimMetadata) {
        summary.duplicateDeliveryDetected =
          true;
        throw new DeliveryFailure(
          "controlled_local_delivery_incomplete_claim",
          "An incomplete local delivery claim requires recovery.",
          "recovery"
        );
      }
    } catch (error) {
      if (
        error instanceof DeliveryFailure
      ) {
        throw error;
      }
      throw error;
    }

    const branch =
      await validateBranchPreconditions(
        locations.repository,
        validated
      );
    summary.baseBranchMatched = true;
    summary.baseRevisionMatched = true;
    summary.baseBranchRefCaptured = true;
    if (
      summary.branchCollisionDetected
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_branch_collision",
        "The deterministic delivery branch already exists.",
        "blocked"
      );
    }

    const worktreeBytes =
      await verifyGovernedWorktree(
        locations.repository,
        validated
      );
    summary.repositoryIdentityMatched =
      true;
    summary.indexCleanBeforeWrite = true;
    summary.governedWorktreeScopeExact =
      true;
    summary.governedContentMatched =
      true;

    claimCreated =
      await createClaim(
        locations,
        validated,
        branch.baseRevision
      );
    if (!claimCreated) {
      summary.duplicateDeliveryDetected =
        true;
      throw new DeliveryFailure(
        "controlled_local_delivery_concurrent_claim",
        "Another process claimed this delivery.",
        "blocked"
      );
    }
    summary.deliveryClaimCreated = true;

    await writeExclusiveMarker(
      path.join(
        locations.claim,
        "COMMIT_STARTED"
      )
    );

    await gitText(
      locations.repository,
      [
        "switch",
        "--quiet",
        "-c",
        input.contract.branch.name,
        "--no-track"
      ],
      validated
    );
    summary.branchCreated = true;

    for (
      const file
      of input.contract.commit
        .changedFiles
    ) {
      await gitText(
        locations.repository,
        [
          "add",
          "--",
          file
        ],
        validated
      );
    }

    const staged =
      sortedUnique(
        parseNullList(
          await gitText(
            locations.repository,
            [
              "diff",
              "--cached",
              "--name-only",
              "-z",
              "--diff-filter=ACMRTUXB"
            ],
            validated
          )
        )
      );
    const unstaged =
      parseNullList(
        await gitText(
          locations.repository,
          [
            "diff",
            "--name-only",
            "-z"
          ],
          validated
        )
      );
    const untracked =
      parseNullList(
        await gitText(
          locations.repository,
          [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z"
          ],
          validated
        )
      );
    if (
      !canonicalEqual(
        staged,
        sortedUnique(
          input.contract.commit
            .changedFiles
        )
      ) ||
      unstaged.length > 0 ||
      untracked.length > 0
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_staged_scope_mismatch",
        "Only governed paths may be staged.",
        "recovery"
      );
    }
    summary.governedPathsStaged =
      true;

    const stagedMaterial: {
      filePath: string;
      byteLength: number;
      byteHash: string;
    }[] = [];
    for (const file of staged) {
      const expected =
        worktreeBytes.get(file);
      const stagedBytes =
        await stagedBlobBytes(
          locations.repository,
          file,
          validated
        );
      if (
        !expected ||
        !stagedBytes.equals(expected)
      ) {
        throw new DeliveryFailure(
          "controlled_local_delivery_staged_content_mismatch",
          "Staged content differs from the verified governed worktree.",
          "recovery",
          file
        );
      }
      stagedMaterial.push({
        filePath: file,
        byteLength:
          stagedBytes.length,
        byteHash:
          `sha256:${(
            await import(
              "node:crypto"
            )
          ).createHash("sha256")
            .update(stagedBytes)
            .digest("hex")}`
      });
    }
    summary.stagedContentMatched =
      true;
    const stagedContentSetHash =
      hashCanonicalJson({
        artifactType:
          "controlled_local_delivery_staged_content",
        files: stagedMaterial
      });

    const treeHash =
      (
        await gitText(
          locations.repository,
          [
            "write-tree"
          ],
          validated
        )
      ).trim();
    if (!COMMIT.test(treeHash)) {
      throw new DeliveryFailure(
        "controlled_local_delivery_tree_invalid",
        "Git write-tree did not produce a valid tree.",
        "recovery"
      );
    }

    const message =
      fullCommitMessage(
        input.contract
      );
    const messagePath =
      path.join(
        locations.claim,
        "commit-message.txt"
      );
    await writeFile(
      messagePath,
      message,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      }
    );
    const baseTimestamp =
      Number(
        (
          await gitText(
            locations.repository,
            [
              "show",
              "-s",
              "--format=%ct",
              branch.baseRevision
            ],
            validated
          )
        ).trim()
      );
    if (
      !Number.isSafeInteger(
        baseTimestamp
      ) ||
      baseTimestamp < 0
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_base_timestamp_invalid",
        "Base commit timestamp is invalid.",
        "recovery"
      );
    }
    const deterministicDate =
      `@${baseTimestamp + 1} +0000`;
    const commitHash =
      (
        await gitText(
          locations.repository,
          [
            "commit-tree",
            treeHash,
            "-p",
            branch.baseRevision,
            "-F",
            messagePath
          ],
          validated,
          {
            GIT_AUTHOR_NAME:
              "Bounded Delivery Executor",
            GIT_AUTHOR_EMAIL:
              "bounded-delivery@local.invalid",
            GIT_COMMITTER_NAME:
              "Bounded Delivery Executor",
            GIT_COMMITTER_EMAIL:
              "bounded-delivery@local.invalid",
            GIT_AUTHOR_DATE:
              deterministicDate,
            GIT_COMMITTER_DATE:
              deterministicDate
          }
        )
      ).trim();
    if (!COMMIT.test(commitHash)) {
      throw new DeliveryFailure(
        "controlled_local_delivery_commit_invalid",
        "Git commit-tree did not produce a valid commit.",
        "recovery"
      );
    }

    await gitText(
      locations.repository,
      [
        "update-ref",
        `refs/heads/${input.contract.branch.name}`,
        commitHash,
        branch.baseRevision
      ],
      validated
    );
    summary.commitCreated = true;

    const head =
      (
        await gitText(
          locations.repository,
          [
            "rev-parse",
            "HEAD"
          ],
          validated
        )
      ).trim();
    const parent =
      (
        await gitText(
          locations.repository,
          [
            "show",
            "-s",
            "--format=%P",
            commitHash
          ],
          validated
        )
      ).trim();
    const observedTree =
      (
        await gitText(
          locations.repository,
          [
            "show",
            "-s",
            "--format=%T",
            commitHash
          ],
          validated
        )
      ).trim();
    const observedMessage =
      (
        await gitText(
          locations.repository,
          [
            "show",
            "-s",
            "--format=%B",
            commitHash
          ],
          validated
        )
      ).trimEnd();
    const observedFiles =
      sortedUnique(
        parseNullList(
          await gitText(
            locations.repository,
            [
              "diff-tree",
              "--no-commit-id",
              "--name-only",
              "-r",
              "-z",
              commitHash
            ],
            validated
          )
        )
      );
    const statusAfter =
      await gitText(
        locations.repository,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all"
        ],
        validated
      );
    const baseRefAfter =
      (
        await gitText(
          locations.repository,
          [
            "rev-parse",
            `refs/heads/${input.contract.repository.baseBranch}`
          ],
          validated
        )
      ).trim();
    const remoteRefsAfter =
      await remoteRefSnapshot(
        locations.repository,
        validated
      );
    if (
      head !== commitHash ||
      parent !== branch.baseRevision ||
      observedTree !== treeHash ||
      observedMessage !== message ||
      !canonicalEqual(
        observedFiles,
        staged
      ) ||
      statusAfter.length !== 0 ||
      baseRefAfter !==
        branch.baseRef ||
      remoteRefsAfter !==
        branch.remoteRefs
    ) {
      throw new DeliveryFailure(
        "controlled_local_delivery_post_commit_verification_failed",
        "Created local delivery commit failed verification.",
        "recovery"
      );
    }
    summary.baseBranchRefUnchanged =
      true;
    summary.remoteRefsUnchanged =
      true;

    const receiptMaterial = {
      receiptVersion: "1" as const,
      outcome:
        "local_commit_created" as const,
      deliveryKey:
        input.contract.deliveryKey,
      contractHash:
        input.contract.contractHash,
      evidenceSetHash:
        input.contract.evidence
          .evidenceSetHash,
      integratedApplyReceiptHash:
        input.contract.source
          .integratedApplyReceiptHash,
      x4ApplyReceiptHash:
        input.contract.source
          .x4ApplyReceiptHash,
      repository: {
        repositoryIdentityHash:
          input.contract.repository
            .repositoryIdentityHash,
        baseBranch:
          input.contract.repository
            .baseBranch,
        baseRevisionHash:
          input.contract.repository
            .baseRevisionHash,
        baseRevision:
          branch.baseRevision,
        baseBranchRefBefore:
          branch.baseRef,
        baseBranchRefAfter:
          baseRefAfter
      },
      branch: {
        name:
          input.contract.branch.name,
        commitHash,
        treeHash,
        parentCommitHash:
          parent
      },
      commit: {
        messageHash:
          hashCanonicalJson({
            message
          }),
        changedFiles:
          staged,
        changedFileCount:
          staged.length,
        stagedContentSetHash
      },
      safety: {
        contractCurrentBeforeWrite:
          true as const,
        repositoryIdentityMatched:
          true as const,
        baseRevisionMatched:
          true as const,
        baseBranchRefUnchanged:
          true as const,
        onlyGovernedPathsChangedBeforeWrite:
          true as const,
        onlyGovernedPathsStaged:
          true as const,
        stagedContentMatched:
          true as const,
        branchCreated:
          true as const,
        commitCreated:
          true as const,
        remoteRefsUnchanged:
          true as const,
        pushExecuted:
          false as const,
        githubWriteExecuted:
          false as const,
        shellExecuted:
          false as const,
        hooksExecuted:
          false as const
      }
    };
    const receipt:
      ControlledLocalDeliveryReceipt = {
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
    await writeExclusiveMarker(
      path.join(
        locations.claim,
        "COMMITTED"
      )
    );
    summary.receiptWritten = true;

    return finish(
      "controlled_local_delivery_committed",
      [],
      receipt,
      contractVerification,
      summary
    );
  } catch (error) {
    if (
      error instanceof TypeError &&
      !(error instanceof DeliveryFailure)
    ) {
      throw error;
    }
    const failure =
      error instanceof DeliveryFailure
        ? error
        : new DeliveryFailure(
            "controlled_local_delivery_exception",
            "Local delivery failed without exposing unbounded command output.",
            claimCreated
              ? "recovery"
              : "invalid"
          );
    if (
      claimCreated &&
      locations
    ) {
      try {
        await writeExclusiveMarker(
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
      ControlledLocalDeliveryDecision =
      failure.kind === "blocked"
        ? "controlled_local_delivery_blocked"
        : failure.kind === "review"
          ? "controlled_local_delivery_needs_review"
          : failure.kind === "recovery"
            ? "controlled_local_delivery_recovery_required"
            : "controlled_local_delivery_invalid";
    return finish(
      decision,
      [issue(failure)],
      null,
      contractVerification,
      summary
    );
  }
}

export async function verifyControlledLocalDeliveryReceipt(
  rawInput:
    VerifyControlledLocalDeliveryReceiptInput
): Promise<ControlledLocalDeliveryReceiptVerificationResult> {
  const errors: string[] = [];
  const staleFields: string[] = [];
  try {
    const validated =
      validateInput({
        repositoryPath:
          rawInput.repositoryPath,
        registryDirectoryPath:
          rawInput.registryDirectoryPath,
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
    const contractVerification =
      verifyDraftPrDeliveryContract({
        contract:
          rawInput.contract,
        integratedReceipt:
          rawInput.integratedReceipt,
        applyReceipt:
          rawInput.applyReceipt
      });
    if (
      !validateReceiptStructure(
        rawInput.receipt
      )
    ) {
      errors.push(
        "controlled_local_delivery_receipt_hash_mismatch"
      );
      return deepFreeze({
        decision:
          "controlled_local_delivery_receipt_invalid",
        receiptIntegrityVerified:
          false,
        contractCurrent:
          false,
        registryRecordMatched:
          false,
        branchCommitMatched:
          false,
        baseBranchRefUnchanged:
          false,
        changedFilesMatched:
          false,
        downstreamEligible:
          false,
        staleFields,
        errors,
        pushExecuted: false,
        githubWriteExecuted: false,
        shellExecuted: false
      });
    }
    const locations =
      await validateLocations(
        validated
      );
    let registryReceipt:
      ControlledLocalDeliveryReceipt | null =
      null;
    try {
      registryReceipt =
        await readExistingReceipt(
          locations.claim
        );
    } catch {
      errors.push(
        "controlled_local_delivery_registry_receipt_invalid"
      );
    }
    const registryRecordMatched =
      registryReceipt !== null &&
      canonicalEqual(
        registryReceipt,
        rawInput.receipt
      );
    if (!registryRecordMatched) {
      errors.push(
        "controlled_local_delivery_registry_receipt_mismatch"
      );
    }
    const observed =
      await verifyReceiptAgainstRepository(
        locations.repository,
        rawInput.receipt,
        rawInput.contract,
        validated
      );
    staleFields.push(
      ...observed.staleFields
    );
    const contractCurrent =
      contractVerification.decision ===
        "draft_pr_delivery_contract_current" &&
      contractVerification
        .downstreamEligible;
    if (!contractCurrent) {
      staleFields.push(
        "deliveryContract"
      );
    }
    const stale =
      staleFields.length > 0;
    return deepFreeze({
      decision:
        errors.length > 0
          ? "controlled_local_delivery_receipt_invalid"
          : stale
            ? "controlled_local_delivery_receipt_stale"
            : "controlled_local_delivery_receipt_current",
      receiptIntegrityVerified:
        true,
      contractCurrent,
      registryRecordMatched,
      branchCommitMatched:
        !staleFields.includes(
          "branchCommitHash"
        ) &&
        !staleFields.includes(
          "repositoryRefs"
        ),
      baseBranchRefUnchanged:
        !staleFields.includes(
          "baseBranchRef"
        ),
      changedFilesMatched:
        !staleFields.includes(
          "changedFiles"
        ),
      downstreamEligible:
        errors.length === 0 &&
        !stale &&
        contractCurrent &&
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
        "controlled_local_delivery_receipt_invalid",
      receiptIntegrityVerified:
        false,
      contractCurrent: false,
      registryRecordMatched:
        false,
      branchCommitMatched:
        false,
      baseBranchRefUnchanged:
        false,
      changedFilesMatched:
        false,
      downstreamEligible:
        false,
      staleFields: [],
      errors: [
        "controlled_local_delivery_receipt_verification_exception"
      ],
      pushExecuted: false,
      githubWriteExecuted:
        false,
      shellExecuted: false
    });
  }
}
