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
import type {
  ControlledLocalDeliveryReceipt
} from "./controlled-local-delivery.js";
import {
  verifyControlledRemoteBranchPushReceipt,
  type ControlledRemoteBranchPushReceipt,
  type ControlledRemoteBranchPushReceiptVerificationResult
} from "./controlled-remote-branch-push.js";

export const CONTROLLED_GITHUB_DRAFT_PR_VERSION = "1" as const;

export type GithubRepositorySnapshot = {
  owner: string;
  name: string;
  defaultBranch: string;
};

export type GithubBranchSnapshot = {
  name: string;
  commitHash: string;
};

export type GithubPullRequestSnapshot = {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string;
  baseBranch: string;
  baseCommitHash: string;
  headBranch: string;
  headCommitHash: string;
};

export type CreateGithubDraftPullRequestInput = {
  owner: string;
  name: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
};

export type ControlledGithubDraftPrClient = {
  getRepository(
    owner: string,
    name: string
  ): Promise<GithubRepositorySnapshot>;
  getBranch(
    owner: string,
    name: string,
    branch: string
  ): Promise<GithubBranchSnapshot>;
  listOpenPullRequests(
    owner: string,
    name: string,
    baseBranch: string,
    headBranch: string
  ): Promise<readonly GithubPullRequestSnapshot[]>;
  createDraftPullRequest(
    input: CreateGithubDraftPullRequestInput
  ): Promise<{ number: number }>;
  getPullRequest(
    owner: string,
    name: string,
    number: number
  ): Promise<GithubPullRequestSnapshot>;
  listPullRequestFiles(
    owner: string,
    name: string,
    number: number
  ): Promise<readonly string[]>;
};

export type GithubFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type GithubFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<GithubFetchResponse>;

export type GithubRestDraftPrClientOptions = {
  token: string;
  fetchFn?: GithubFetch;
  userAgent?: string;
};

export type ControlledGithubDraftPrDecision =
  | "controlled_github_draft_pr_created"
  | "controlled_github_draft_pr_already_created"
  | "controlled_github_draft_pr_blocked"
  | "controlled_github_draft_pr_needs_review"
  | "controlled_github_draft_pr_invalid"
  | "controlled_github_draft_pr_recovery_required";

export type ControlledGithubDraftPrIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
};

export type ControlledGithubDraftPrReceipt = {
  receiptVersion: "1";
  outcome: "github_draft_pr_created";
  deliveryKey: string;
  contractHash: string;
  remotePushReceiptHash: string;
  localDeliveryReceiptHash: string;
  evidenceSetHash: string;
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
    repositorySnapshotHash: string;
  };
  pullRequest: {
    number: number;
    state: "open";
    draft: true;
    baseBranch: string;
    baseCommitHash: string;
    headBranch: string;
    headCommitHash: string;
    titleHash: string;
    bodyHash: string;
    changedFiles: readonly string[];
    changedFileCount: number;
    changedFileSetHash: string;
  };
  safety: {
    remotePushReceiptCurrentBeforeWrite: true;
    githubRepositoryMatched: true;
    githubBaseFreshBeforeWrite: true;
    githubHeadFreshBeforeWrite: true;
    noExistingOpenPullRequestBeforeWrite: true;
    durableClaimCreatedBeforeWrite: true;
    createDraftRequested: true;
    createdPullRequestReRead: true;
    createdPullRequestOpen: true;
    createdPullRequestDraft: true;
    createdPullRequestTextMatched: true;
    createdPullRequestRefsMatched: true;
    createdPullRequestFilesMatched: true;
    githubBaseUnchangedAfterWrite: true;
    githubHeadUnchangedAfterWrite: true;
    secondPullRequestCreated: false;
    gitWriteExecuted: false;
    shellExecuted: false;
  };
  receiptHash: string;
};

export type ExecuteControlledGithubDraftPrInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  remoteName: string;
  remotePushReceipt: ControlledRemoteBranchPushReceipt;
  localDeliveryReceipt: ControlledLocalDeliveryReceipt;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  client: ControlledGithubDraftPrClient;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledGithubDraftPrResult = {
  decision: ControlledGithubDraftPrDecision;
  issues: readonly ControlledGithubDraftPrIssue[];
  receipt: ControlledGithubDraftPrReceipt | null;
  remotePushVerification:
    ControlledRemoteBranchPushReceiptVerificationResult | null;
  summary: {
    inputValid: boolean;
    remotePushReceiptCurrent: boolean;
    registryPathValid: boolean;
    githubRepositoryMatched: boolean;
    githubBaseFresh: boolean;
    githubHeadFresh: boolean;
    duplicatePullRequestDetected: boolean;
    durableClaimCreated: boolean;
    createAttempted: boolean;
    createReturnedNumber: boolean;
    pullRequestReRead: boolean;
    pullRequestOpen: boolean;
    pullRequestDraft: boolean;
    pullRequestTextMatched: boolean;
    pullRequestRefsMatched: boolean;
    pullRequestFilesMatched: boolean;
    githubBaseUnchanged: boolean;
    githubHeadUnchanged: boolean;
    receiptWritten: boolean;
    gitWriteExecuted: false;
    shellExecuted: false;
  };
};

export type VerifyControlledGithubDraftPrReceiptInput = {
  repositoryPath: string;
  registryDirectoryPath: string;
  remoteName: string;
  receipt: ControlledGithubDraftPrReceipt;
  remotePushReceipt: ControlledRemoteBranchPushReceipt;
  localDeliveryReceipt: ControlledLocalDeliveryReceipt;
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  client: ControlledGithubDraftPrClient;
  timeoutMs?: number;
  maxGitOutputBytes?: number;
};

export type ControlledGithubDraftPrReceiptVerificationDecision =
  | "controlled_github_draft_pr_receipt_current"
  | "controlled_github_draft_pr_receipt_stale"
  | "controlled_github_draft_pr_receipt_invalid";

export type ControlledGithubDraftPrReceiptVerificationResult = {
  decision: ControlledGithubDraftPrReceiptVerificationDecision;
  receiptIntegrityVerified: boolean;
  remotePushReceiptCurrent: boolean;
  registryRecordMatched: boolean;
  repositoryMatched: boolean;
  pullRequestMatched: boolean;
  pullRequestFilesMatched: boolean;
  baseBranchMatched: boolean;
  headBranchMatched: boolean;
  downstreamEligible: boolean;
  staleFields: readonly string[];
  errors: readonly string[];
  githubWriteExecuted: false;
  gitWriteExecuted: false;
  shellExecuted: false;
};

type PlainRecord = Record<string, unknown>;

type ValidatedInput = {
  input: ExecuteControlledGithubDraftPrInput;
  timeoutMs: number;
  maxGitOutputBytes: number;
};

type DraftPrLocations = {
  registry: string;
  githubRoot: string;
  claim: string;
};

type ClaimState =
  | { state: "missing"; receipt: null }
  | { state: "incomplete"; receipt: null }
  | {
      state: "committed";
      receipt: ControlledGithubDraftPrReceipt;
    };

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*(?:\/\/|\.{2}|@\{|\\|\s|[\u0000-\u001f\u007f~^:?*\[]))(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,180}$/;
const MAX_TEXT = 20_000;
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_REGISTRY_ENTRIES = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 100 * 1024 * 1024;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

class DraftPrFailure extends Error {
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

class GithubClientFailure extends Error {
  constructor(
    readonly code: string,
    message: string
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(
    (left, right) => left.localeCompare(right)
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return hashCanonicalJson(left) === hashCanonicalJson(right);
  } catch {
    return false;
  }
}

function hashWithout(value: PlainRecord, field: string): string {
  const material = { ...value };
  delete material[field];
  return hashCanonicalJson(material);
}

function textHash(artifactType: string, value: string): string {
  return hashCanonicalJson({ artifactType, value });
}

function changedFileSetHash(files: readonly string[]): string {
  return hashCanonicalJson({
    artifactType: "controlled_github_draft_pr_changed_files",
    files: sortedUnique(files)
  });
}

function repositorySnapshotHash(snapshot: GithubRepositorySnapshot): string {
  return hashCanonicalJson({
    artifactType: "controlled_github_repository_snapshot",
    owner: snapshot.owner,
    name: snapshot.name,
    defaultBranch: snapshot.defaultBranch
  });
}

function issue(failure: DraftPrFailure): ControlledGithubDraftPrIssue {
  return {
    code: failure.code,
    message: failure.message,
    severity:
      failure.kind === "review" || failure.kind === "recovery"
        ? "review"
        : "error",
    ...(failure.field ? { field: failure.field } : {})
  };
}

function initialSummary(): ControlledGithubDraftPrResult["summary"] {
  return {
    inputValid: false,
    remotePushReceiptCurrent: false,
    registryPathValid: false,
    githubRepositoryMatched: false,
    githubBaseFresh: false,
    githubHeadFresh: false,
    duplicatePullRequestDetected: false,
    durableClaimCreated: false,
    createAttempted: false,
    createReturnedNumber: false,
    pullRequestReRead: false,
    pullRequestOpen: false,
    pullRequestDraft: false,
    pullRequestTextMatched: false,
    pullRequestRefsMatched: false,
    pullRequestFilesMatched: false,
    githubBaseUnchanged: false,
    githubHeadUnchanged: false,
    receiptWritten: false,
    gitWriteExecuted: false,
    shellExecuted: false
  };
}

function finish(
  decision: ControlledGithubDraftPrDecision,
  issues: readonly ControlledGithubDraftPrIssue[],
  receipt: ControlledGithubDraftPrReceipt | null,
  remotePushVerification:
    ControlledRemoteBranchPushReceiptVerificationResult | null,
  summary: ControlledGithubDraftPrResult["summary"]
): ControlledGithubDraftPrResult {
  return deepFreeze({
    decision,
    issues: [...issues],
    receipt,
    remotePushVerification,
    summary
  });
}

function numericLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`Invalid trusted GitHub draft PR limit: ${field}.`);
  }
  return value as number;
}

function clientValid(value: unknown): value is ControlledGithubDraftPrClient {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    "getRepository",
    "getBranch",
    "listOpenPullRequests",
    "createDraftPullRequest",
    "getPullRequest",
    "listPullRequestFiles"
  ].every((name) => typeof record[name] === "function");
}

function validateInput(input: ExecuteControlledGithubDraftPrInput): ValidatedInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    typeof input.registryDirectoryPath !== "string" ||
    input.registryDirectoryPath.length === 0 ||
    typeof input.remoteName !== "string" ||
    input.remoteName.length === 0 ||
    !input.remotePushReceipt ||
    !input.localDeliveryReceipt ||
    !input.contract ||
    !input.integratedReceipt ||
    !input.applyReceipt ||
    !clientValid(input.client)
  ) {
    throw new DraftPrFailure(
      "invalid_controlled_github_draft_pr_input",
      "GitHub draft PR input is invalid."
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

function requireOwner(value: unknown, field: string): string {
  if (typeof value !== "string" || !OWNER.test(value)) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value;
}

function requireRepository(value: unknown, field: string): string {
  if (typeof value !== "string" || !REPOSITORY.test(value)) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value;
}

function requireBranch(value: unknown, field: string): string {
  if (typeof value !== "string" || !BRANCH.test(value)) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value;
}

function requireCommit(value: unknown, field: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value;
}

function requireText(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_TEXT ||
    (!allowEmpty && value.trim().length === 0) ||
    ASCII_CONTROL.test(value.replace(/\r?\n/g, ""))
  ) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value as number;
}

function plainRecord(value: unknown, field: string): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new GithubClientFailure("github_response_invalid", `GitHub ${field} is invalid.`);
  }
  return value as PlainRecord;
}

function normalizeRepositorySnapshot(value: unknown): GithubRepositorySnapshot {
  const record = plainRecord(value, "repository");
  const owner = plainRecord(record.owner, "repository.owner");
  return {
    owner: requireOwner(owner.login, "repository.owner.login"),
    name: requireRepository(record.name, "repository.name"),
    defaultBranch: requireBranch(record.default_branch, "repository.default_branch")
  };
}

function normalizeBranchSnapshot(value: unknown): GithubBranchSnapshot {
  const record = plainRecord(value, "branch");
  const commit = plainRecord(record.commit, "branch.commit");
  return {
    name: requireBranch(record.name, "branch.name"),
    commitHash: requireCommit(commit.sha, "branch.commit.sha")
  };
}

function normalizePullRequestSnapshot(value: unknown): GithubPullRequestSnapshot {
  const record = plainRecord(value, "pull_request");
  const base = plainRecord(record.base, "pull_request.base");
  const head = plainRecord(record.head, "pull_request.head");
  const state = record.state;
  if (state !== "open" && state !== "closed") {
    throw new GithubClientFailure("github_response_invalid", "GitHub pull request state is invalid.");
  }
  if (typeof record.draft !== "boolean") {
    throw new GithubClientFailure("github_response_invalid", "GitHub pull request draft state is invalid.");
  }
  const body = record.body === null
    ? ""
    : requireText(record.body, "pull_request.body", true);
  return {
    number: requireNumber(record.number, "pull_request.number"),
    state,
    draft: record.draft,
    title: requireText(record.title, "pull_request.title"),
    body,
    baseBranch: requireBranch(base.ref, "pull_request.base.ref"),
    baseCommitHash: requireCommit(base.sha, "pull_request.base.sha"),
    headBranch: requireBranch(head.ref, "pull_request.head.ref"),
    headCommitHash: requireCommit(head.sha, "pull_request.head.sha")
  };
}

function normalizePullRequestFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new GithubClientFailure("github_response_invalid", "GitHub pull request files response is invalid.");
  }
  const files = value.map((entry) => {
    const record = plainRecord(entry, "pull_request_file");
    const filename = record.filename;
    if (
      typeof filename !== "string" ||
      filename.length === 0 ||
      filename.length > 4096 ||
      filename.startsWith("/") ||
      filename.includes("\\") ||
      filename.split("/").includes("..") ||
      ASCII_CONTROL.test(filename)
    ) {
      throw new GithubClientFailure("github_response_invalid", "GitHub pull request filename is invalid.");
    }
    return filename;
  });
  if (new Set(files).size !== files.length) {
    throw new GithubClientFailure("github_response_invalid", "GitHub pull request file list contains duplicates.");
  }
  return files;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export function createGithubRestDraftPrClient(
  options: GithubRestDraftPrClientOptions
): ControlledGithubDraftPrClient {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    typeof options.token !== "string" ||
    options.token.length < 8 ||
    options.token.length > 4096 ||
    ASCII_CONTROL.test(options.token) ||
    (options.fetchFn !== undefined && typeof options.fetchFn !== "function") ||
    (options.userAgent !== undefined &&
      (typeof options.userAgent !== "string" ||
        options.userAgent.length === 0 ||
        options.userAgent.length > 200 ||
        ASCII_CONTROL.test(options.userAgent)))
  ) {
    throw new TypeError("Invalid GitHub REST draft PR client configuration.");
  }
  const fetchFn = options.fetchFn ??
    (globalThis as typeof globalThis & { fetch?: GithubFetch }).fetch;
  if (typeof fetchFn !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": options.userAgent ?? "bounded-dllm-agent-lab-ae3b"
  };

  async function request(route: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await fetchFn(`https://api.github.com${route}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const responseText = await response.text();
    if (responseText.length > MAX_HTTP_RESPONSE_BYTES) {
      throw new GithubClientFailure("github_response_too_large", "GitHub response exceeded its bound.");
    }
    if (!response.ok) {
      throw new GithubClientFailure(`github_http_${response.status}`, "GitHub API request failed.");
    }
    if (responseText.length === 0) return null;
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      throw new GithubClientFailure("github_response_invalid", "GitHub returned invalid JSON.");
    }
  }

  async function paged(routeForPage: (page: number) => string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const value = await request(routeForPage(page));
      if (!Array.isArray(value)) {
        throw new GithubClientFailure("github_response_invalid", "GitHub paginated response is invalid.");
      }
      result.push(...value);
      if (value.length < 100) return result;
    }
    throw new GithubClientFailure("github_pagination_limit", "GitHub pagination exceeded its bound.");
  }

  return deepFreeze({
    async getRepository(owner, name) {
      requireOwner(owner, "owner");
      requireRepository(name, "name");
      return normalizeRepositorySnapshot(
        await request(`/repos/${encodePath(owner)}/${encodePath(name)}`)
      );
    },
    async getBranch(owner, name, branch) {
      requireOwner(owner, "owner");
      requireRepository(name, "name");
      requireBranch(branch, "branch");
      return normalizeBranchSnapshot(
        await request(`/repos/${encodePath(owner)}/${encodePath(name)}/branches/${encodePath(branch)}`)
      );
    },
    async listOpenPullRequests(owner, name, baseBranch, headBranch) {
      requireOwner(owner, "owner");
      requireRepository(name, "name");
      requireBranch(baseBranch, "baseBranch");
      requireBranch(headBranch, "headBranch");
      const query =
        `state=open&base=${encodePath(baseBranch)}` +
        `&head=${encodePath(`${owner}:${headBranch}`)}` +
        "&per_page=100";
      const value = await request(
        `/repos/${encodePath(owner)}/${encodePath(name)}/pulls?${query}`
      );
      if (!Array.isArray(value)) {
        throw new GithubClientFailure("github_response_invalid", "GitHub pull request list is invalid.");
      }
      return value.map(normalizePullRequestSnapshot);
    },
    async createDraftPullRequest(input) {
      requireOwner(input.owner, "owner");
      requireRepository(input.name, "name");
      requireText(input.title, "title");
      requireText(input.body, "body", true);
      requireBranch(input.baseBranch, "baseBranch");
      requireBranch(input.headBranch, "headBranch");
      const value = plainRecord(
        await request(
          `/repos/${encodePath(input.owner)}/${encodePath(input.name)}/pulls`,
          "POST",
          {
            title: input.title,
            body: input.body,
            base: input.baseBranch,
            head: input.headBranch,
            draft: true,
            maintainer_can_modify: false
          }
        ),
        "created_pull_request"
      );
      return { number: requireNumber(value.number, "created_pull_request.number") };
    },
    async getPullRequest(owner, name, number) {
      requireOwner(owner, "owner");
      requireRepository(name, "name");
      requireNumber(number, "number");
      return normalizePullRequestSnapshot(
        await request(`/repos/${encodePath(owner)}/${encodePath(name)}/pulls/${number}`)
      );
    },
    async listPullRequestFiles(owner, name, number) {
      requireOwner(owner, "owner");
      requireRepository(name, "name");
      requireNumber(number, "number");
      const value = await paged(
        (page) => `/repos/${encodePath(owner)}/${encodePath(name)}/pulls/${number}/files?per_page=100&page=${page}`
      );
      return normalizePullRequestFiles(value);
    }
  });
}

async function noSymlinkSegments(configured: string): Promise<void> {
  const absolute = path.resolve(configured);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_symlink_detected",
        "A configured path contains a symbolic link."
      );
    }
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

async function privateRegistry(repositoryPath: string, configured: string): Promise<string> {
  await noSymlinkSegments(repositoryPath);
  await noSymlinkSegments(configured);
  const repository = await realpath(repositoryPath);
  const registry = await realpath(configured);
  const metadata = await lstat(registry);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    inside(repository, registry) ||
    inside(registry, repository)
  ) {
    throw new DraftPrFailure(
      "controlled_github_draft_pr_registry_invalid",
      "A private registry outside the repository is required."
    );
  }
  return registry;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new DraftPrFailure(
      "controlled_github_draft_pr_registry_invalid",
      "GitHub draft PR registry namespace is unsafe."
    );
  }
  if (created) {
    await chmod(directory, 0o700);
    await syncDirectory(path.dirname(directory));
  }
}

async function locations(
  validated: ValidatedInput,
  createRoot: boolean
): Promise<DraftPrLocations> {
  const registry = await privateRegistry(
    validated.input.repositoryPath,
    validated.input.registryDirectoryPath
  );
  const githubRoot = path.join(registry, "github-draft-prs");
  if (createRoot) {
    await ensurePrivateDirectory(githubRoot);
  } else {
    const metadata = await lstat(githubRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_registry_invalid",
        "GitHub draft PR registry root is invalid."
      );
    }
  }
  return {
    registry,
    githubRoot,
    claim: path.join(githubRoot, validated.input.contract.deliveryKey.slice(7))
  };
}

async function writeExclusiveJson(file: string, value: unknown): Promise<void> {
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(Buffer.from(JSON.stringify(value), "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writeMarker(file: string): Promise<void> {
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600
  );
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

function receiptStructureValid(receipt: ControlledGithubDraftPrReceipt): boolean {
  return (
    receipt.receiptVersion === "1" &&
    receipt.outcome === "github_draft_pr_created" &&
    HASH.test(receipt.deliveryKey) &&
    HASH.test(receipt.contractHash) &&
    HASH.test(receipt.remotePushReceiptHash) &&
    HASH.test(receipt.localDeliveryReceiptHash) &&
    HASH.test(receipt.evidenceSetHash) &&
    OWNER.test(receipt.repository.owner) &&
    REPOSITORY.test(receipt.repository.name) &&
    BRANCH.test(receipt.repository.defaultBranch) &&
    HASH.test(receipt.repository.repositorySnapshotHash) &&
    Number.isSafeInteger(receipt.pullRequest.number) &&
    receipt.pullRequest.number > 0 &&
    receipt.pullRequest.state === "open" &&
    receipt.pullRequest.draft === true &&
    BRANCH.test(receipt.pullRequest.baseBranch) &&
    COMMIT.test(receipt.pullRequest.baseCommitHash) &&
    BRANCH.test(receipt.pullRequest.headBranch) &&
    COMMIT.test(receipt.pullRequest.headCommitHash) &&
    HASH.test(receipt.pullRequest.titleHash) &&
    HASH.test(receipt.pullRequest.bodyHash) &&
    HASH.test(receipt.pullRequest.changedFileSetHash) &&
    receipt.pullRequest.changedFileCount === receipt.pullRequest.changedFiles.length &&
    HASH.test(receipt.receiptHash) &&
    receipt.receiptHash === hashWithout(
      receipt as unknown as PlainRecord,
      "receiptHash"
    )
  );
}

async function readClaim(claim: string): Promise<ClaimState> {
  let metadata;
  try {
    metadata = await lstat(claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", receipt: null };
    }
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new DraftPrFailure(
      "controlled_github_draft_pr_registry_invalid",
      "Existing GitHub draft PR claim is unsafe."
    );
  }
  const entries = await readdir(claim, { withFileTypes: true });
  if (
    entries.length > MAX_REGISTRY_ENTRIES ||
    entries.some((entry) => entry.isSymbolicLink())
  ) {
    throw new DraftPrFailure(
      "controlled_github_draft_pr_registry_invalid",
      "Existing GitHub draft PR claim layout is unsafe."
    );
  }
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has("receipt.json") || !names.has("COMMITTED")) {
    return { state: "incomplete", receipt: null };
  }
  try {
    const receipt = JSON.parse(
      await readFile(path.join(claim, "receipt.json"), "utf8")
    ) as ControlledGithubDraftPrReceipt;
    if (!receiptStructureValid(receipt)) throw new Error("invalid receipt");
    return { state: "committed", receipt };
  } catch {
    throw new DraftPrFailure(
      "controlled_github_draft_pr_registry_invalid",
      "Existing GitHub draft PR receipt is invalid."
    );
  }
}

async function createClaim(
  where: DraftPrLocations,
  validated: ValidatedInput
): Promise<boolean> {
  try {
    await mkdir(where.claim, { mode: 0o700 });
    await chmod(where.claim, 0o700);
    await syncDirectory(where.githubRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  const { input } = validated;
  const intentMaterial = {
    intentVersion: "1",
    deliveryKey: input.contract.deliveryKey,
    contractHash: input.contract.contractHash,
    remotePushReceiptHash: input.remotePushReceipt.receiptHash,
    localDeliveryReceiptHash: input.localDeliveryReceipt.receiptHash,
    evidenceSetHash: input.contract.evidence.evidenceSetHash,
    owner: input.contract.repository.owner,
    name: input.contract.repository.name,
    baseBranch: input.contract.pullRequest.baseBranch,
    baseCommitHash: input.remotePushReceipt.remote.baseCommitHash,
    headBranch: input.contract.pullRequest.headBranch,
    headCommitHash: input.remotePushReceipt.remote.headCommitHash,
    titleHash: textHash(
      "controlled_github_draft_pr_title",
      input.contract.pullRequest.title
    ),
    bodyHash: textHash(
      "controlled_github_draft_pr_body",
      input.contract.pullRequest.body
    )
  };
  await writeExclusiveJson(
    path.join(where.claim, "intent.json"),
    { ...intentMaterial, intentHash: hashCanonicalJson(intentMaterial) }
  );
  return true;
}

function repositoryMatches(
  snapshot: GithubRepositorySnapshot,
  contract: DraftPrDeliveryContract
): boolean {
  return (
    snapshot.owner === contract.repository.owner &&
    snapshot.name === contract.repository.name &&
    snapshot.defaultBranch === contract.repository.baseBranch
  );
}

function pullRequestMatches(
  snapshot: GithubPullRequestSnapshot,
  contract: DraftPrDeliveryContract,
  remotePushReceipt: ControlledRemoteBranchPushReceipt
): boolean {
  return (
    snapshot.state === "open" &&
    snapshot.draft === true &&
    snapshot.title === contract.pullRequest.title &&
    snapshot.body === contract.pullRequest.body &&
    snapshot.baseBranch === contract.pullRequest.baseBranch &&
    snapshot.baseCommitHash === remotePushReceipt.remote.baseCommitHash &&
    snapshot.headBranch === contract.pullRequest.headBranch &&
    snapshot.headCommitHash === remotePushReceipt.remote.headCommitHash
  );
}

async function currentReceiptState(
  validated: ValidatedInput,
  receipt: ControlledGithubDraftPrReceipt
): Promise<{ current: boolean; staleFields: string[] }> {
  const staleFields: string[] = [];
  const { input } = validated;
  const repository = await input.client.getRepository(
    input.contract.repository.owner,
    input.contract.repository.name
  );
  if (
    !repositoryMatches(repository, input.contract) ||
    repositorySnapshotHash(repository) !== receipt.repository.repositorySnapshotHash
  ) {
    staleFields.push("repository");
  }
  const base = await input.client.getBranch(
    input.contract.repository.owner,
    input.contract.repository.name,
    input.contract.pullRequest.baseBranch
  );
  const head = await input.client.getBranch(
    input.contract.repository.owner,
    input.contract.repository.name,
    input.contract.pullRequest.headBranch
  );
  if (base.commitHash !== receipt.pullRequest.baseCommitHash) {
    staleFields.push("baseBranch");
  }
  if (head.commitHash !== receipt.pullRequest.headCommitHash) {
    staleFields.push("headBranch");
  }
  const pr = await input.client.getPullRequest(
    input.contract.repository.owner,
    input.contract.repository.name,
    receipt.pullRequest.number
  );
  if (
    !pullRequestMatches(pr, input.contract, input.remotePushReceipt) ||
    textHash("controlled_github_draft_pr_title", pr.title) !== receipt.pullRequest.titleHash ||
    textHash("controlled_github_draft_pr_body", pr.body) !== receipt.pullRequest.bodyHash
  ) {
    staleFields.push("pullRequest");
  }
  const files = sortedUnique(
    await input.client.listPullRequestFiles(
      input.contract.repository.owner,
      input.contract.repository.name,
      receipt.pullRequest.number
    )
  );
  if (
    !canonicalEqual(files, receipt.pullRequest.changedFiles) ||
    changedFileSetHash(files) !== receipt.pullRequest.changedFileSetHash
  ) {
    staleFields.push("pullRequestFiles");
  }
  if (receipt.deliveryKey !== input.contract.deliveryKey) staleFields.push("deliveryKey");
  if (receipt.contractHash !== input.contract.contractHash) staleFields.push("contractHash");
  if (receipt.remotePushReceiptHash !== input.remotePushReceipt.receiptHash) {
    staleFields.push("remotePushReceiptHash");
  }
  return {
    current: staleFields.length === 0,
    staleFields: sortedUnique(staleFields)
  };
}

export async function executeControlledGithubDraftPr(
  rawInput: ExecuteControlledGithubDraftPrInput
): Promise<ControlledGithubDraftPrResult> {
  const summary = initialSummary();
  let remotePushVerification:
    ControlledRemoteBranchPushReceiptVerificationResult | null = null;
  let where: DraftPrLocations | null = null;
  let claimCreated = false;
  try {
    const validated = validateInput(rawInput);
    summary.inputValid = true;
    const { input } = validated;

    remotePushVerification = await verifyControlledRemoteBranchPushReceipt({
      repositoryPath: input.repositoryPath,
      registryDirectoryPath: input.registryDirectoryPath,
      remoteName: input.remoteName,
      receipt: input.remotePushReceipt,
      localDeliveryReceipt: input.localDeliveryReceipt,
      contract: input.contract,
      integratedReceipt: input.integratedReceipt,
      applyReceipt: input.applyReceipt,
      timeoutMs: validated.timeoutMs,
      maxGitOutputBytes: validated.maxGitOutputBytes
    });
    if (
      remotePushVerification.decision !==
        "controlled_remote_branch_push_receipt_current" ||
      !remotePushVerification.downstreamEligible
    ) {
      throw new DraftPrFailure(
        remotePushVerification.decision ===
          "controlled_remote_branch_push_receipt_stale"
          ? "controlled_github_draft_pr_remote_push_stale"
          : "controlled_github_draft_pr_remote_push_invalid",
        "Remote branch push receipt is not current.",
        remotePushVerification.decision ===
          "controlled_remote_branch_push_receipt_stale"
          ? "review"
          : "invalid"
      );
    }
    summary.remotePushReceiptCurrent = true;

    where = await locations(validated, true);
    summary.registryPathValid = true;

    const repository = await input.client.getRepository(
      input.contract.repository.owner,
      input.contract.repository.name
    );
    if (!repositoryMatches(repository, input.contract)) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_repository_mismatch",
        "GitHub repository snapshot does not match the delivery contract.",
        "review"
      );
    }
    summary.githubRepositoryMatched = true;

    const baseBefore = await input.client.getBranch(
      input.contract.repository.owner,
      input.contract.repository.name,
      input.contract.pullRequest.baseBranch
    );
    if (
      baseBefore.name !== input.contract.pullRequest.baseBranch ||
      baseBefore.commitHash !== input.remotePushReceipt.remote.baseCommitHash
    ) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_base_stale",
        "GitHub base branch is not the pushed contract base.",
        "review"
      );
    }
    summary.githubBaseFresh = true;

    const headBefore = await input.client.getBranch(
      input.contract.repository.owner,
      input.contract.repository.name,
      input.contract.pullRequest.headBranch
    );
    if (
      headBefore.name !== input.contract.pullRequest.headBranch ||
      headBefore.commitHash !== input.remotePushReceipt.remote.headCommitHash
    ) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_head_stale",
        "GitHub head branch is not the pushed bounded commit.",
        "review"
      );
    }
    summary.githubHeadFresh = true;

    const existing = await readClaim(where.claim);
    if (existing.state === "committed") {
      summary.duplicatePullRequestDetected = true;
      const replay = await currentReceiptState(validated, existing.receipt);
      if (replay.current) {
        return finish(
          "controlled_github_draft_pr_already_created",
          [],
          existing.receipt,
          remotePushVerification,
          summary
        );
      }
      throw new DraftPrFailure(
        "controlled_github_draft_pr_existing_receipt_stale",
        "Existing GitHub draft PR receipt is stale.",
        "review"
      );
    }
    if (existing.state === "incomplete") {
      summary.duplicatePullRequestDetected = true;
      throw new DraftPrFailure(
        "controlled_github_draft_pr_incomplete_claim",
        "An incomplete GitHub draft PR claim requires recovery.",
        "recovery"
      );
    }

    const openPullRequests = await input.client.listOpenPullRequests(
      input.contract.repository.owner,
      input.contract.repository.name,
      input.contract.pullRequest.baseBranch,
      input.contract.pullRequest.headBranch
    );
    if (openPullRequests.length > 0) {
      summary.duplicatePullRequestDetected = true;
      throw new DraftPrFailure(
        openPullRequests.length === 1
          ? "controlled_github_draft_pr_unclaimed_duplicate"
          : "controlled_github_draft_pr_multiple_duplicates",
        "An open pull request already exists for the deterministic delivery branch.",
        openPullRequests.length === 1 ? "blocked" : "review"
      );
    }

    claimCreated = await createClaim(where, validated);
    if (!claimCreated) {
      summary.duplicatePullRequestDetected = true;
      throw new DraftPrFailure(
        "controlled_github_draft_pr_concurrent_claim",
        "Another process claimed this GitHub draft PR delivery.",
        "blocked"
      );
    }
    summary.durableClaimCreated = true;
    await writeMarker(path.join(where.claim, "CREATE_STARTED"));

    summary.createAttempted = true;
    const created = await input.client.createDraftPullRequest({
      owner: input.contract.repository.owner,
      name: input.contract.repository.name,
      title: input.contract.pullRequest.title,
      body: input.contract.pullRequest.body,
      baseBranch: input.contract.pullRequest.baseBranch,
      headBranch: input.contract.pullRequest.headBranch
    });
    if (!Number.isSafeInteger(created.number) || created.number <= 0) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_create_response_invalid",
        "GitHub did not return a valid pull request number.",
        "recovery"
      );
    }
    summary.createReturnedNumber = true;

    const pullRequest = await input.client.getPullRequest(
      input.contract.repository.owner,
      input.contract.repository.name,
      created.number
    );
    summary.pullRequestReRead = true;
    if (pullRequest.state !== "open") {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_not_open",
        "Created pull request is not open.",
        "recovery"
      );
    }
    summary.pullRequestOpen = true;
    if (pullRequest.draft !== true) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_not_draft",
        "Created pull request is not a draft.",
        "recovery"
      );
    }
    summary.pullRequestDraft = true;
    if (
      pullRequest.title !== input.contract.pullRequest.title ||
      pullRequest.body !== input.contract.pullRequest.body
    ) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_text_mismatch",
        "Created pull request text does not match the contract.",
        "recovery"
      );
    }
    summary.pullRequestTextMatched = true;
    if (
      pullRequest.baseBranch !== input.contract.pullRequest.baseBranch ||
      pullRequest.baseCommitHash !== input.remotePushReceipt.remote.baseCommitHash ||
      pullRequest.headBranch !== input.contract.pullRequest.headBranch ||
      pullRequest.headCommitHash !== input.remotePushReceipt.remote.headCommitHash
    ) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_ref_mismatch",
        "Created pull request refs do not match the pushed delivery.",
        "recovery"
      );
    }
    summary.pullRequestRefsMatched = true;

    const files = sortedUnique(
      await input.client.listPullRequestFiles(
        input.contract.repository.owner,
        input.contract.repository.name,
        created.number
      )
    );
    const expectedFiles = sortedUnique(input.contract.commit.changedFiles);
    if (!canonicalEqual(files, expectedFiles)) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_files_mismatch",
        "Created pull request files do not exactly match governed files.",
        "recovery"
      );
    }
    summary.pullRequestFilesMatched = true;

    const baseAfter = await input.client.getBranch(
      input.contract.repository.owner,
      input.contract.repository.name,
      input.contract.pullRequest.baseBranch
    );
    if (baseAfter.commitHash !== baseBefore.commitHash) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_base_changed",
        "GitHub base branch changed during pull request creation.",
        "recovery"
      );
    }
    summary.githubBaseUnchanged = true;

    const headAfter = await input.client.getBranch(
      input.contract.repository.owner,
      input.contract.repository.name,
      input.contract.pullRequest.headBranch
    );
    if (headAfter.commitHash !== headBefore.commitHash) {
      throw new DraftPrFailure(
        "controlled_github_draft_pr_head_changed",
        "GitHub head branch changed during pull request creation.",
        "recovery"
      );
    }
    summary.githubHeadUnchanged = true;

    const receiptMaterial = {
      receiptVersion: "1" as const,
      outcome: "github_draft_pr_created" as const,
      deliveryKey: input.contract.deliveryKey,
      contractHash: input.contract.contractHash,
      remotePushReceiptHash: input.remotePushReceipt.receiptHash,
      localDeliveryReceiptHash: input.localDeliveryReceipt.receiptHash,
      evidenceSetHash: input.contract.evidence.evidenceSetHash,
      repository: {
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        repositorySnapshotHash: repositorySnapshotHash(repository)
      },
      pullRequest: {
        number: pullRequest.number,
        state: "open" as const,
        draft: true as const,
        baseBranch: pullRequest.baseBranch,
        baseCommitHash: pullRequest.baseCommitHash,
        headBranch: pullRequest.headBranch,
        headCommitHash: pullRequest.headCommitHash,
        titleHash: textHash("controlled_github_draft_pr_title", pullRequest.title),
        bodyHash: textHash("controlled_github_draft_pr_body", pullRequest.body),
        changedFiles: files,
        changedFileCount: files.length,
        changedFileSetHash: changedFileSetHash(files)
      },
      safety: {
        remotePushReceiptCurrentBeforeWrite: true as const,
        githubRepositoryMatched: true as const,
        githubBaseFreshBeforeWrite: true as const,
        githubHeadFreshBeforeWrite: true as const,
        noExistingOpenPullRequestBeforeWrite: true as const,
        durableClaimCreatedBeforeWrite: true as const,
        createDraftRequested: true as const,
        createdPullRequestReRead: true as const,
        createdPullRequestOpen: true as const,
        createdPullRequestDraft: true as const,
        createdPullRequestTextMatched: true as const,
        createdPullRequestRefsMatched: true as const,
        createdPullRequestFilesMatched: true as const,
        githubBaseUnchangedAfterWrite: true as const,
        githubHeadUnchangedAfterWrite: true as const,
        secondPullRequestCreated: false as const,
        gitWriteExecuted: false as const,
        shellExecuted: false as const
      }
    };
    const receipt: ControlledGithubDraftPrReceipt = {
      ...receiptMaterial,
      receiptHash: hashCanonicalJson(receiptMaterial)
    };
    await writeExclusiveJson(path.join(where.claim, "receipt.json"), receipt);
    await writeMarker(path.join(where.claim, "COMMITTED"));
    summary.receiptWritten = true;

    return finish(
      "controlled_github_draft_pr_created",
      [],
      receipt,
      remotePushVerification,
      summary
    );
  } catch (error) {
    if (error instanceof TypeError && !(error instanceof DraftPrFailure)) {
      throw error;
    }
    const originalFailure =
      error instanceof DraftPrFailure
        ? error
        : error instanceof GithubClientFailure
          ? new DraftPrFailure(
              error.code,
              error.message,
              claimCreated ? "recovery" : "review"
            )
          : new DraftPrFailure(
              "controlled_github_draft_pr_exception",
              "GitHub draft PR delivery failed without exposing unbounded API output."
            );
    const failure = claimCreated
      ? new DraftPrFailure(
          originalFailure.code,
          originalFailure.message,
          "recovery",
          originalFailure.field
        )
      : originalFailure;

    if (claimCreated && where) {
      try {
        await writeMarker(path.join(where.claim, "FAILED"));
      } catch {
        // Preserve the original failure.
      }
    }

    const decision: ControlledGithubDraftPrDecision =
      failure.kind === "blocked"
        ? "controlled_github_draft_pr_blocked"
        : failure.kind === "review"
          ? "controlled_github_draft_pr_needs_review"
          : failure.kind === "recovery"
            ? "controlled_github_draft_pr_recovery_required"
            : "controlled_github_draft_pr_invalid";

    return finish(
      decision,
      [issue(failure)],
      null,
      remotePushVerification,
      summary
    );
  }
}

export async function verifyControlledGithubDraftPrReceipt(
  rawInput: VerifyControlledGithubDraftPrReceiptInput
): Promise<ControlledGithubDraftPrReceiptVerificationResult> {
  const errors: string[] = [];
  const staleFields: string[] = [];
  try {
    const validated = validateInput({
      repositoryPath: rawInput.repositoryPath,
      registryDirectoryPath: rawInput.registryDirectoryPath,
      remoteName: rawInput.remoteName,
      remotePushReceipt: rawInput.remotePushReceipt,
      localDeliveryReceipt: rawInput.localDeliveryReceipt,
      contract: rawInput.contract,
      integratedReceipt: rawInput.integratedReceipt,
      applyReceipt: rawInput.applyReceipt,
      client: rawInput.client,
      timeoutMs: rawInput.timeoutMs,
      maxGitOutputBytes: rawInput.maxGitOutputBytes
    });
    if (!receiptStructureValid(rawInput.receipt)) {
      return deepFreeze({
        decision: "controlled_github_draft_pr_receipt_invalid",
        receiptIntegrityVerified: false,
        remotePushReceiptCurrent: false,
        registryRecordMatched: false,
        repositoryMatched: false,
        pullRequestMatched: false,
        pullRequestFilesMatched: false,
        baseBranchMatched: false,
        headBranchMatched: false,
        downstreamEligible: false,
        staleFields,
        errors: ["controlled_github_draft_pr_receipt_hash_mismatch"],
        githubWriteExecuted: false,
        gitWriteExecuted: false,
        shellExecuted: false
      });
    }
    const remotePushVerification =
      await verifyControlledRemoteBranchPushReceipt({
        repositoryPath: rawInput.repositoryPath,
        registryDirectoryPath: rawInput.registryDirectoryPath,
        remoteName: rawInput.remoteName,
        receipt: rawInput.remotePushReceipt,
        localDeliveryReceipt: rawInput.localDeliveryReceipt,
        contract: rawInput.contract,
        integratedReceipt: rawInput.integratedReceipt,
        applyReceipt: rawInput.applyReceipt,
        timeoutMs: validated.timeoutMs,
        maxGitOutputBytes: validated.maxGitOutputBytes
      });
    const remotePushReceiptCurrent =
      remotePushVerification.decision ===
        "controlled_remote_branch_push_receipt_current" &&
      remotePushVerification.downstreamEligible;
    if (!remotePushReceiptCurrent) staleFields.push("remotePushReceipt");

    const where = await locations(validated, false);
    const claim = await readClaim(where.claim);
    const registryRecordMatched =
      claim.state === "committed" &&
      canonicalEqual(claim.receipt, rawInput.receipt);
    if (!registryRecordMatched) {
      errors.push("controlled_github_draft_pr_registry_receipt_mismatch");
    }

    const observed = await currentReceiptState(validated, rawInput.receipt);
    staleFields.push(...observed.staleFields);
    const uniqueStale = sortedUnique(staleFields);
    const invalid = errors.length > 0;
    const stale = uniqueStale.length > 0;

    return deepFreeze({
      decision: invalid
        ? "controlled_github_draft_pr_receipt_invalid"
        : stale
          ? "controlled_github_draft_pr_receipt_stale"
          : "controlled_github_draft_pr_receipt_current",
      receiptIntegrityVerified: true,
      remotePushReceiptCurrent,
      registryRecordMatched,
      repositoryMatched: !uniqueStale.includes("repository"),
      pullRequestMatched: !uniqueStale.includes("pullRequest"),
      pullRequestFilesMatched: !uniqueStale.includes("pullRequestFiles"),
      baseBranchMatched: !uniqueStale.includes("baseBranch"),
      headBranchMatched: !uniqueStale.includes("headBranch"),
      downstreamEligible:
        !invalid &&
        !stale &&
        remotePushReceiptCurrent &&
        registryRecordMatched,
      staleFields: uniqueStale,
      errors: sortedUnique(errors),
      githubWriteExecuted: false,
      gitWriteExecuted: false,
      shellExecuted: false
    });
  } catch {
    return deepFreeze({
      decision: "controlled_github_draft_pr_receipt_invalid",
      receiptIntegrityVerified: false,
      remotePushReceiptCurrent: false,
      registryRecordMatched: false,
      repositoryMatched: false,
      pullRequestMatched: false,
      pullRequestFilesMatched: false,
      baseBranchMatched: false,
      headBranchMatched: false,
      downstreamEligible: false,
      staleFields: [],
      errors: ["controlled_github_draft_pr_receipt_verification_exception"],
      githubWriteExecuted: false,
      gitWriteExecuted: false,
      shellExecuted: false
    });
  }
}
