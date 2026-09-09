import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  MUTATION_LIMITS,
  TEXT_FILE_UPDATE_VERSION,
  parseTextFileUpdates,
  type TextFileUpdateClaimV1
} from "../../product-runtime/src/text-file-update-contract.js";
import { canonicalizeRepositoryRelativePath } from "../../product-runtime/src/runtime-contract-foundation.js";
import {
  createWorkspaceMutation,
  type WorkspaceMutation
} from "../../product-runtime/src/workspace-mutation.js";
import {
  DISPOSABLE_AGENT_WORKSPACE_VERSION,
  type DisposableAgentWorkspaceManifest
} from "./disposable-agent-workspace.js";

export type AgentMutationCaptureErrorCode =
  | "agent_mutation_workspace_invalid"
  | "agent_mutation_baseline_invalid"
  | "agent_mutation_source_manifest_invalid"
  | "agent_mutation_source_manifest_mismatch"
  | "agent_mutation_no_changes"
  | "agent_mutation_added_unsupported"
  | "agent_mutation_deleted_unsupported"
  | "agent_mutation_renamed_unsupported"
  | "agent_mutation_copied_unsupported"
  | "agent_mutation_mode_change_unsupported"
  | "agent_mutation_symlink_unsupported"
  | "agent_mutation_binary_unsupported"
  | "agent_mutation_file_type_unsupported"
  | "agent_mutation_path_escape"
  | "agent_mutation_file_limit_exceeded"
  | "agent_mutation_total_limit_exceeded"
  | "agent_mutation_file_count_exceeded"
  | "agent_mutation_git_diff_invalid";

export class AgentMutationCaptureError extends Error {
  constructor(
    readonly code: AgentMutationCaptureErrorCode,
    message: string,
    readonly file?: string
  ) {
    super(message);
    this.name = "AgentMutationCaptureError";
  }
}

export type AgentMutationCaptureInput = Readonly<{
  workspacePath: string;
  sourceManifest: DisposableAgentWorkspaceManifest;
}>;

export type AgentMutationCaptureResult = Readonly<{
  mutation: WorkspaceMutation;
  claims: readonly TextFileUpdateClaimV1[];
  changedFiles: readonly string[];
  totalNewBytes: number;
}>;

type GitRawChange = Readonly<{
  oldMode: string;
  newMode: string;
  status: string;
  path: string;
  secondPath?: string;
}>;

type BaselineTreeEntry = Readonly<{
  mode: string;
  type: string;
  object: string;
  path: string;
}>;

const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const RAW_DIFF_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/;
const TREE_ENTRY_HEADER = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]+)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function fail(code: AgentMutationCaptureErrorCode, message: string, file?: string): never {
  throw new AgentMutationCaptureError(code, message, file);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalMutationPath(value: unknown): string {
  try {
    return canonicalizeRepositoryRelativePath(value);
  } catch {
    return fail(
      "agent_mutation_path_escape",
      "Agent mutation path must be a canonical repository-relative path.",
      typeof value === "string" ? value : undefined
    );
  }
}

function isolatedGitEnvironment(homePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const hostHomeKeys = new Set(["HOME", "XDG_CONFIG_HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (upperKey.startsWith("GIT_") || hostHomeKeys.has(upperKey)) continue;
    environment[key] = value;
  }
  environment.HOME = homePath;
  environment.XDG_CONFIG_HOME = homePath;
  environment.USERPROFILE = homePath;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGitBuffer(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "buffer", env: environment, maxBuffer: MAX_GIT_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new AgentMutationCaptureError(
              "agent_mutation_git_diff_invalid",
              `Git command failed (${args.join(" ")}): ${Buffer.from(stderr).toString("utf8").trim() || error.message}`
            )
          );
          return;
        }
        resolvePromise(Buffer.from(stdout));
      }
    );
  });
}

async function runGitText(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<string> {
  return (await runGitBuffer(cwd, args, environment)).toString("utf8");
}

async function withIsolatedGitHome<T>(
  action: (environment: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const homePath = await mkdtemp(join(tmpdir(), "bounded-agent-capture-git-home-"));
  try {
    return await action(isolatedGitEnvironment(homePath));
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
}

function parseNulFields(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) {
    fail("agent_mutation_git_diff_invalid", "Git NUL-delimited output is malformed.");
  }
  return bytes.subarray(0, bytes.length - 1).toString("utf8").split("\0");
}

function parseRawDiff(bytes: Buffer): GitRawChange[] {
  const fields = parseNulFields(bytes);
  const changes: GitRawChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++];
    const match = RAW_DIFF_HEADER.exec(header ?? "");
    if (match === null) {
      fail("agent_mutation_git_diff_invalid", `Unexpected raw Git diff header: ${JSON.stringify(header ?? "")}.`);
    }
    const path = fields[index++];
    if (!path) fail("agent_mutation_git_diff_invalid", "Raw Git diff is missing a path.");
    const status = match[5]!;
    let secondPath: string | undefined;
    if (status === "R" || status === "C") {
      secondPath = fields[index++];
      if (!secondPath) fail("agent_mutation_git_diff_invalid", `Raw Git ${status} entry is missing its destination.`);
    }
    changes.push(Object.freeze({
      oldMode: match[1]!,
      newMode: match[2]!,
      status,
      path,
      ...(secondPath === undefined ? {} : { secondPath })
    }));
  }
  return changes;
}

function parseBaselineTree(bytes: Buffer): BaselineTreeEntry[] {
  return parseNulFields(bytes).map((field) => {
    const match = TREE_ENTRY_HEADER.exec(field);
    if (match === null) fail("agent_mutation_baseline_invalid", "Unexpected Git baseline tree entry.");
    return Object.freeze({ mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! });
  });
}

function validateManifest(
  manifest: DisposableAgentWorkspaceManifest
): Map<string, DisposableAgentWorkspaceManifest["files"][number]> {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== DISPOSABLE_AGENT_WORKSPACE_VERSION ||
    !Array.isArray(manifest.files)
  ) {
    fail("agent_mutation_source_manifest_invalid", "A valid pre-agent disposable workspace manifest is required.");
  }

  const byPath = new Map<string, DisposableAgentWorkspaceManifest["files"][number]>();
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== "object") {
      fail("agent_mutation_source_manifest_invalid", "Manifest file entry is invalid.");
    }
    const path = canonicalMutationPath(entry.path);
    if (byPath.has(path)) fail("agent_mutation_source_manifest_invalid", `Manifest contains duplicate path ${path}.`, path);
    if (!SHA256_HEX.test(entry.sourceHash)) fail("agent_mutation_source_manifest_invalid", `Manifest source hash is invalid for ${path}.`, path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail("agent_mutation_source_manifest_invalid", `Manifest byte count is invalid for ${path}.`, path);
    byPath.set(path, entry);
  }
  return byPath;
}

async function verifyWorkspaceGitBoundary(
  workspaceRealPath: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const dotGitPath = join(workspaceRealPath, ".git");
  let dotGitStat;
  try {
    dotGitStat = await lstat(dotGitPath);
  } catch {
    fail("agent_mutation_workspace_invalid", "Disposable agent workspace must contain its own .git directory.");
  }
  if (!dotGitStat.isDirectory() || dotGitStat.isSymbolicLink()) {
    fail("agent_mutation_workspace_invalid", "Disposable agent workspace .git must be a regular directory.");
  }

  const gitDirRealPath = await realpath((await runGitText(workspaceRealPath, ["rev-parse", "--absolute-git-dir"], environment)).trim());
  const expectedGitDirRealPath = await realpath(dotGitPath);
  if (gitDirRealPath !== expectedGitDirRealPath) {
    fail("agent_mutation_workspace_invalid", "Agent workspace Git directory points outside the disposable workspace.");
  }

  const commonDirOutput = (await runGitText(workspaceRealPath, ["rev-parse", "--git-common-dir"], environment)).trim();
  const commonDirRealPath = await realpath(isAbsolute(commonDirOutput) ? commonDirOutput : resolve(workspaceRealPath, commonDirOutput));
  if (commonDirRealPath !== gitDirRealPath) {
    fail("agent_mutation_workspace_invalid", "Agent workspace Git common directory points outside its own .git directory.");
  }
  if ((await runGitText(workspaceRealPath, ["remote"], environment)).trim().length > 0) {
    fail("agent_mutation_workspace_invalid", "Agent workspace Git repository must not configure remotes.");
  }
  try {
    const alternates = await readFile(join(gitDirRealPath, "objects", "info", "alternates"), "utf8");
    if (alternates.trim().length > 0) fail("agent_mutation_workspace_invalid", "Agent workspace must not use alternate object directories.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function findVerifiedBaselineCommit(
  workspaceRealPath: string,
  manifestByPath: ReadonlyMap<string, DisposableAgentWorkspaceManifest["files"][number]>,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const roots = (await runGitText(workspaceRealPath, ["rev-list", "--max-parents=0", "HEAD"], environment))
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (roots.length !== 1 || !/^[0-9a-f]{40,64}$/.test(roots[0]!)) {
    fail("agent_mutation_baseline_invalid", "Agent workspace must have exactly one reachable root baseline commit.");
  }
  const baselineCommit = roots[0]!;
  const tree = parseBaselineTree(await runGitBuffer(workspaceRealPath, ["ls-tree", "-r", "-z", "--full-tree", baselineCommit], environment));
  if (tree.length !== manifestByPath.size) {
    fail("agent_mutation_source_manifest_mismatch", "Workspace Git baseline path set differs from the pre-agent manifest.");
  }

  const seen = new Set<string>();
  for (const treeEntry of tree) {
    const path = canonicalMutationPath(treeEntry.path);
    const manifestEntry = manifestByPath.get(path);
    if (manifestEntry === undefined || seen.has(path)) {
      fail("agent_mutation_source_manifest_mismatch", `Workspace Git baseline contains unexpected path ${path}.`, path);
    }
    seen.add(path);
    if (treeEntry.type !== "blob" || !REGULAR_GIT_MODES.has(treeEntry.mode)) {
      fail(
        treeEntry.mode === "120000" ? "agent_mutation_symlink_unsupported" : "agent_mutation_file_type_unsupported",
        `Workspace Git baseline contains unsupported file type for ${path}.`,
        path
      );
    }
    const baselineBytes = await runGitBuffer(workspaceRealPath, ["cat-file", "blob", treeEntry.object], environment);
    if (baselineBytes.byteLength !== manifestEntry.bytes || sha256(baselineBytes) !== manifestEntry.sourceHash) {
      fail("agent_mutation_source_manifest_mismatch", `Workspace Git baseline differs from the pre-agent manifest for ${path}.`, path);
    }
  }
  return baselineCommit;
}

function rejectUnsupportedChange(change: GitRawChange): void {
  const path = canonicalMutationPath(change.path);
  const destination = change.secondPath === undefined ? undefined : canonicalMutationPath(change.secondPath);
  switch (change.status) {
    case "A": fail("agent_mutation_added_unsupported", `Added files are not supported: ${path}.`, path);
    case "D": fail("agent_mutation_deleted_unsupported", `Deleted files are not supported: ${path}.`, path);
    case "R": fail("agent_mutation_renamed_unsupported", `Renamed files are not supported: ${path} -> ${destination ?? "?"}.`, path);
    case "C": fail("agent_mutation_copied_unsupported", `Copied files are not supported: ${path} -> ${destination ?? "?"}.`, path);
    case "T": fail(
      change.newMode === "120000" || change.oldMode === "120000" ? "agent_mutation_symlink_unsupported" : "agent_mutation_file_type_unsupported",
      `File type changes are not supported: ${path}.`, path
    );
    case "M": return;
    default: fail("agent_mutation_git_diff_invalid", `Unsupported Git diff status ${change.status} for ${path}.`, path);
  }
}

async function readCurrentTextFile(
  workspaceRealPath: string,
  path: string,
  expectedGitMode: string
): Promise<{ content: string; bytes: number }> {
  const destination = resolve(workspaceRealPath, ...path.split("/"));
  if (!isWithin(workspaceRealPath, destination)) fail("agent_mutation_path_escape", `Changed path escapes workspace: ${path}.`, path);

  let cursor = workspaceRealPath;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("agent_mutation_deleted_unsupported", `Changed file no longer exists: ${path}.`, path);
      throw error;
    }
    if (metadata.isSymbolicLink()) fail("agent_mutation_symlink_unsupported", `Symlinks are not supported: ${path}.`, path);
    if (index < segments.length - 1 && !metadata.isDirectory()) fail("agent_mutation_file_type_unsupported", `Changed path has a non-directory ancestor: ${path}.`, path);
    if (index === segments.length - 1 && !metadata.isFile()) fail("agent_mutation_file_type_unsupported", `Changed target must be a regular file: ${path}.`, path);
  }

  const handle = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail("agent_mutation_file_type_unsupported", `Changed target must remain a regular file: ${path}.`, path);
    if (metadata.size > MUTATION_LIMITS.maxFileBytes) fail("agent_mutation_file_limit_exceeded", `Changed file exceeds ${MUTATION_LIMITS.maxFileBytes} bytes: ${path}.`, path);
    const expectedPermissions = Number.parseInt(expectedGitMode.slice(-3), 8);
    if ((metadata.mode & 0o777) !== expectedPermissions) fail("agent_mutation_mode_change_unsupported", `Filesystem mode changed for ${path}.`, path);

    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) fail("agent_mutation_git_diff_invalid", `Changed file size changed during capture: ${path}.`, path);
    if (bytes.includes(0)) fail("agent_mutation_binary_unsupported", `NUL-containing files are not supported: ${path}.`, path);
    for (const byte of bytes) {
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        fail("agent_mutation_binary_unsupported", `Control-byte content is not supported: ${path}.`, path);
      }
    }
    let content: string;
    try {
      content = UTF8_DECODER.decode(bytes);
    } catch {
      return fail("agent_mutation_binary_unsupported", `Changed file is not valid UTF-8: ${path}.`, path);
    }
    if (!Buffer.from(content, "utf8").equals(bytes)) fail("agent_mutation_binary_unsupported", `Changed file does not round-trip as UTF-8: ${path}.`, path);
    return { content, bytes: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

export async function captureAgentMutations(
  input: AgentMutationCaptureInput
): Promise<AgentMutationCaptureResult> {
  if (input === null || typeof input !== "object" || typeof input.workspacePath !== "string" || input.workspacePath.length === 0) {
    fail("agent_mutation_workspace_invalid", "workspacePath must identify a disposable agent workspace.");
  }
  const manifestByPath = validateManifest(input.sourceManifest);

  let workspaceRealPath: string;
  try {
    workspaceRealPath = await realpath(resolve(input.workspacePath));
  } catch {
    return fail("agent_mutation_workspace_invalid", "workspacePath cannot be resolved.");
  }
  const workspaceStat = await lstat(workspaceRealPath);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) fail("agent_mutation_workspace_invalid", "workspacePath must resolve to a regular directory.");

  return withIsolatedGitHome(async (environment) => {
    await verifyWorkspaceGitBoundary(workspaceRealPath, environment);
    const baselineCommit = await findVerifiedBaselineCommit(workspaceRealPath, manifestByPath, environment);

    const untrackedPaths = parseNulFields(await runGitBuffer(workspaceRealPath, ["ls-files", "--others", "--exclude-standard", "-z", "--"], environment));
    if (untrackedPaths.length > 0) {
      const path = canonicalMutationPath(untrackedPaths[0]);
      fail("agent_mutation_added_unsupported", `Added or untracked files are not supported: ${path}.`, path);
    }

    const rawChanges = parseRawDiff(await runGitBuffer(
      workspaceRealPath,
      ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--find-copies-harder", baselineCommit, "--"],
      environment
    ));
    if (rawChanges.length === 0) fail("agent_mutation_no_changes", "Agent workspace contains no file changes.");
    if (rawChanges.length > MUTATION_LIMITS.maxFiles) fail("agent_mutation_file_count_exceeded", `Agent changed more than ${MUTATION_LIMITS.maxFiles} files.`);

    const claims: TextFileUpdateClaimV1[] = [];
    let totalNewBytes = 0;
    for (const change of rawChanges) {
      rejectUnsupportedChange(change);
      const path = canonicalMutationPath(change.path);
      const manifestEntry = manifestByPath.get(path);
      if (manifestEntry === undefined) fail("agent_mutation_added_unsupported", `Changed path did not exist in the pre-agent manifest: ${path}.`, path);
      if (!REGULAR_GIT_MODES.has(change.oldMode) || !REGULAR_GIT_MODES.has(change.newMode)) {
        fail(
          change.oldMode === "120000" || change.newMode === "120000" ? "agent_mutation_symlink_unsupported" : "agent_mutation_file_type_unsupported",
          `Only existing regular files may be converted: ${path}.`, path
        );
      }
      if (change.oldMode !== change.newMode) fail("agent_mutation_mode_change_unsupported", `File mode changes are not supported: ${path}.`, path);

      const current = await readCurrentTextFile(workspaceRealPath, path, change.newMode);
      totalNewBytes += current.bytes;
      if (totalNewBytes > MUTATION_LIMITS.maxTotalBytes) fail("agent_mutation_total_limit_exceeded", `Agent changes exceed ${MUTATION_LIMITS.maxTotalBytes} total bytes.`);
      claims.push({
        claimVersion: TEXT_FILE_UPDATE_VERSION,
        type: "patch_draft",
        operation: "update",
        file: path,
        expectedContentHash: `sha256:${manifestEntry.sourceHash}`,
        newContent: current.content,
        description: `Captured agent modification for ${path}.`
      });
    }

    claims.sort((left, right) => left.file.localeCompare(right.file, "en"));
    const touchedFiles = claims.map((claim) => claim.file);
    const mutation = createWorkspaceMutation({
      role: "coder",
      target: "patchDraft",
      summary: `Captured ${claims.length} agent file update${claims.length === 1 ? "" : "s"}.`,
      claims,
      touchedFiles
    });
    const parsedClaims = parseTextFileUpdates(mutation);

    return Object.freeze({
      mutation,
      claims: Object.freeze([...parsedClaims]),
      changedFiles: Object.freeze([...touchedFiles]),
      totalNewBytes
    });
  });
}
