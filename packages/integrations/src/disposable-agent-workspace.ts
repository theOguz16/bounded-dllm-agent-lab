import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32
} from "node:path";
import { TextDecoder } from "node:util";

export const DISPOSABLE_AGENT_WORKSPACE_VERSION =
  "disposable-agent-workspace/v1" as const;

export type DisposableAgentWorkspaceMode = "bounded" | "baseline";

export type DisposableAgentWorkspaceInput = Readonly<{
  repositoryPath: string;
  sourceSnapshotHash: string;
  visibleFiles: readonly string[];
  changeAllowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  mode: DisposableAgentWorkspaceMode;
}>;

export type DisposableAgentWorkspaceManifestFile = Readonly<{
  path: string;
  sourceHash: string;
  bytes: number;
  changeAllowed: boolean;
}>;

export type DisposableAgentWorkspaceManifest = Readonly<{
  schemaVersion: typeof DISPOSABLE_AGENT_WORKSPACE_VERSION;
  sourceSnapshotHash: string;
  mode: DisposableAgentWorkspaceMode;
  files: readonly DisposableAgentWorkspaceManifestFile[];
}>;

export type DisposableAgentWorkspaceResult = Readonly<{
  workspacePath: string;
  manifest: DisposableAgentWorkspaceManifest;
  manifestHash: string;
  sourceFileHashes: Readonly<Record<string, string>>;
  exposedFileCount: number;
  exposedBytes: number;
}>;

export class DisposableAgentWorkspaceError extends Error {
  readonly code = "disposable_agent_workspace_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "DisposableAgentWorkspaceError";
  }
}

type SourceInspection =
  | Readonly<{
      status: "eligible";
      bytes: Buffer;
      mode: number;
    }>
  | Readonly<{
      status: "missing" | "symlink" | "not_file" | "binary";
    }>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_GIT_LS_FILES_BUFFER = 32 * 1024 * 1024;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRelativePath(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DisposableAgentWorkspaceError(
      `${field} entries must be non-empty repository-relative paths.`
    );
  }
  if (value.includes("\0")) {
    throw new DisposableAgentWorkspaceError(`${field} contains a NUL byte.`);
  }
  if (value.includes("\\")) {
    throw new DisposableAgentWorkspaceError(
      `${field} must use canonical POSIX separators.`
    );
  }
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw new DisposableAgentWorkspaceError(
      `${field} must contain repository-relative paths only.`
    );
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    throw new DisposableAgentWorkspaceError(
      `${field} must contain canonical repository-relative paths.`
    );
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DisposableAgentWorkspaceError(
      `${field} must not contain empty, dot, or parent path segments.`
    );
  }

  return segments.join("/");
}

function normalizeUniquePaths(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) {
    throw new DisposableAgentWorkspaceError(`${field} must be an array.`);
  }

  const normalized: string[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();

  for (const value of values) {
    const path = canonicalRelativePath(value, field);
    if (exact.has(path)) {
      throw new DisposableAgentWorkspaceError(`${field} contains duplicate path: ${path}.`);
    }
    const foldedPath = path.toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) {
      throw new DisposableAgentWorkspaceError(
        `${field} contains a case-insensitive path collision: ${path}.`
      );
    }
    exact.add(path);
    folded.add(foldedPath);
    normalized.push(path);
  }

  return normalized.sort((left, right) => left.localeCompare(right, "en"));
}

function hardDeniedReason(path: string): string | null {
  const segments = path.split("/");
  const lowerSegments = segments.map((segment) => segment.toLocaleLowerCase("en-US"));
  const basename = lowerSegments.at(-1) ?? "";

  if (lowerSegments.includes(".git")) return ".git metadata";
  if (basename === ".env" || basename.startsWith(".env.")) return "environment secrets";

  for (let index = 0; index < lowerSegments.length - 1; index += 1) {
    if (lowerSegments[index] === ".bounded" && lowerSegments[index + 1] === "runs") {
      return ".bounded/runs state";
    }
  }

  if (lowerSegments.includes("node_modules")) return "node_modules";
  if (lowerSegments.includes("dist") || lowerSegments.includes("build")) {
    return "build output";
  }

  if (
    lowerSegments.includes("credentials") ||
    basename === "credentials" ||
    basename.startsWith("credentials.")
  ) {
    return "credentials";
  }

  const secretComponent = /(^|[._-])secrets?([._-]|$)/i;
  if (lowerSegments.some((segment) => segment === "secrets" || secretComponent.test(segment))) {
    return "secret material";
  }

  if (
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx")
  ) {
    return "credential material";
  }

  return null;
}

function matchesForbidden(path: string, forbiddenFiles: readonly string[]): boolean {
  return forbiddenFiles.some(
    (forbidden) => path === forbidden || path.startsWith(`${forbidden}/`)
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;

  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return false;
    }
  }

  try {
    UTF8_DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function inspectSourceFile(
  repositoryRealPath: string,
  path: string
): Promise<SourceInspection> {
  let current = repositoryRealPath;
  const segments = path.split("/");

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);

    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      throw error;
    }

    if (entry.isSymbolicLink()) return { status: "symlink" };
    if (index < segments.length - 1 && !entry.isDirectory()) {
      return { status: "not_file" };
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      return { status: "not_file" };
    }
  }

  const sourcePath = join(repositoryRealPath, ...segments);
  const bytes = await readFile(sourcePath);
  if (!isText(bytes)) return { status: "binary" };

  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    return { status: sourceStat.isSymbolicLink() ? "symlink" : "not_file" };
  }

  return {
    status: "eligible",
    bytes,
    mode: sourceStat.mode & 0o777
  };
}

function listTrackedFiles(repositoryRealPath: string): Promise<string[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", repositoryRealPath, "ls-files", "-z", "--cached"],
      {
        encoding: "utf8",
        maxBuffer: MAX_GIT_LS_FILES_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new DisposableAgentWorkspaceError(
              `Unable to enumerate tracked repository files: ${stderr.trim() || error.message}`
            )
          );
          return;
        }

        resolvePromise(
          stdout
            .split("\0")
            .filter((value) => value.length > 0)
            .sort((left, right) => left.localeCompare(right, "en"))
        );
      }
    );
  });
}

function validateInput(input: DisposableAgentWorkspaceInput): void {
  if (typeof input.repositoryPath !== "string" || input.repositoryPath.length === 0) {
    throw new DisposableAgentWorkspaceError("repositoryPath must be a non-empty path.");
  }
  if (
    typeof input.sourceSnapshotHash !== "string" ||
    input.sourceSnapshotHash.trim().length === 0
  ) {
    throw new DisposableAgentWorkspaceError(
      "sourceSnapshotHash must be a non-empty string."
    );
  }
  if (input.mode !== "bounded" && input.mode !== "baseline") {
    throw new DisposableAgentWorkspaceError("mode must be bounded or baseline.");
  }
}

function assertChangeAllowedIsExposed(
  changeAllowedFiles: readonly string[],
  exposedPaths: ReadonlySet<string>
): void {
  for (const path of changeAllowedFiles) {
    if (!exposedPaths.has(path)) {
      throw new DisposableAgentWorkspaceError(
        `changeAllowedFiles contains a file that is not exposed to the agent: ${path}.`
      );
    }
  }
}

export async function createDisposableAgentWorkspace(
  input: DisposableAgentWorkspaceInput
): Promise<DisposableAgentWorkspaceResult> {
  validateInput(input);

  const visibleFiles = normalizeUniquePaths(input.visibleFiles, "visibleFiles");
  const changeAllowedFiles = normalizeUniquePaths(
    input.changeAllowedFiles,
    "changeAllowedFiles"
  );
  const forbiddenFiles = normalizeUniquePaths(input.forbiddenFiles, "forbiddenFiles");
  const changeAllowedSet = new Set(changeAllowedFiles);

  let repositoryRealPath: string;
  try {
    repositoryRealPath = await realpath(resolve(input.repositoryPath));
  } catch (error) {
    throw new DisposableAgentWorkspaceError(
      `repositoryPath cannot be resolved: ${
        error instanceof Error ? error.message : "unknown filesystem error"
      }`
    );
  }

  const repositoryStat = await lstat(repositoryRealPath);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new DisposableAgentWorkspaceError("repositoryPath must resolve to a directory.");
  }

  let candidateFiles: string[];
  if (input.mode === "bounded") {
    candidateFiles = visibleFiles;
  } else {
    const trackedFiles = await listTrackedFiles(repositoryRealPath);
    const normalizedTracked: string[] = [];
    const seen = new Set<string>();
    const folded = new Set<string>();

    for (const trackedFile of trackedFiles) {
      let normalized: string;
      try {
        normalized = canonicalRelativePath(trackedFile, "tracked repository path");
      } catch {
        continue;
      }
      const foldedPath = normalized.toLocaleLowerCase("en-US");
      if (seen.has(normalized) || folded.has(foldedPath)) continue;
      seen.add(normalized);
      folded.add(foldedPath);
      normalizedTracked.push(normalized);
    }
    candidateFiles = normalizedTracked.sort((left, right) => left.localeCompare(right, "en"));
  }

  const selected: Array<{
    path: string;
    bytes: Buffer;
    mode: number;
    sourceHash: string;
  }> = [];

  for (const path of candidateFiles) {
    const deniedReason = hardDeniedReason(path);
    const explicitlyForbidden = matchesForbidden(path, forbiddenFiles);

    if (deniedReason !== null || explicitlyForbidden) {
      if (input.mode === "bounded") {
        throw new DisposableAgentWorkspaceError(
          `Bounded workspace selection contains forbidden file ${path}: ${
            deniedReason ?? "forbiddenFiles"
          }.`
        );
      }
      continue;
    }

    const inspection = await inspectSourceFile(repositoryRealPath, path);
    if (inspection.status !== "eligible") {
      if (input.mode === "bounded") {
        throw new DisposableAgentWorkspaceError(
          `Bounded workspace selection contains ineligible ${inspection.status} path: ${path}.`
        );
      }
      continue;
    }

    selected.push({
      path,
      bytes: inspection.bytes,
      mode: inspection.mode,
      sourceHash: sha256(inspection.bytes)
    });
  }

  const exposedPaths = new Set(selected.map((entry) => entry.path));
  assertChangeAllowedIsExposed(changeAllowedFiles, exposedPaths);

  const workspacePath = await mkdtemp(join(tmpdir(), "bounded-agent-workspace-"));

  try {
    const workspaceRealPath = await realpath(workspacePath);
    if (isWithin(repositoryRealPath, workspaceRealPath)) {
      throw new DisposableAgentWorkspaceError(
        "Disposable agent workspace must not be the original repository or a descendant of it."
      );
    }

    for (const entry of selected) {
      const destinationPath = join(workspaceRealPath, ...entry.path.split("/"));
      if (!isWithin(workspaceRealPath, destinationPath)) {
        throw new DisposableAgentWorkspaceError(
          `Workspace destination escaped disposable root: ${entry.path}.`
        );
      }
      await mkdir(resolve(destinationPath, ".."), { recursive: true });
      await writeFile(destinationPath, entry.bytes, { flag: "wx" });
      await chmod(destinationPath, entry.mode);
    }

    const files = selected.map<DisposableAgentWorkspaceManifestFile>((entry) =>
      Object.freeze({
        path: entry.path,
        sourceHash: entry.sourceHash,
        bytes: entry.bytes.byteLength,
        changeAllowed: changeAllowedSet.has(entry.path)
      })
    );

    const manifest: DisposableAgentWorkspaceManifest = Object.freeze({
      schemaVersion: DISPOSABLE_AGENT_WORKSPACE_VERSION,
      sourceSnapshotHash: input.sourceSnapshotHash,
      mode: input.mode,
      files: Object.freeze(files)
    });

    const sourceFileHashes: Record<string, string> = {};
    for (const entry of selected) {
      sourceFileHashes[entry.path] = entry.sourceHash;
    }

    const exposedBytes = selected.reduce(
      (total, entry) => total + entry.bytes.byteLength,
      0
    );

    return Object.freeze({
      workspacePath: workspaceRealPath,
      manifest,
      manifestHash: sha256(JSON.stringify(manifest)),
      sourceFileHashes: Object.freeze(sourceFileHashes),
      exposedFileCount: selected.length,
      exposedBytes
    });
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}
