import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PrChangedFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unknown";

export type GitHubStylePrFileInput = {
  filename?: string;
  file?: string;
  path?: string;
  previous_filename?: string;
  previousFilename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

export type GitHubStylePrInput = {
  repo?: string;
  repository?: string;
  owner?: string;
  name?: string;
  prNumber?: number;
  pullRequestNumber?: number;
  number?: number;
  baseRef?: string;
  base?: string;
  headRef?: string;
  head?: string;
  title?: string;
  changedFiles?: string[];
  files?: GitHubStylePrFileInput[];
};

export type NormalizedPrChangedFile = {
  file: string;
  previousFile: string | null;
  status: PrChangedFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
};

export type PrChangedFilesSummary = {
  sourcePath: string | null;
  repo: string | null;
  prNumber: number | null;
  baseRef: string | null;
  headRef: string | null;
  title: string | null;
  changedFiles: string[];
  existingChangedFiles: string[];
  files: NormalizedPrChangedFile[];
  fileCount: number;
  additionCount: number;
  deletionCount: number;
  patchLineCount: number;
  diagnostics: string[];
};

export function readPrChangedFilesInput(path: string): GitHubStylePrInput {
  return JSON.parse(readFileSync(path, "utf8")) as GitHubStylePrInput;
}

export function createPrChangedFilesSummary(input: {
  rootDir?: string;
  sourcePath?: string | null;
  prInput: GitHubStylePrInput;
}): PrChangedFilesSummary {
  const rootDir = input.rootDir ?? process.cwd();
  const diagnostics: string[] = [];

  const filesFromObjects = normalizeFileObjects(input.prInput.files ?? [], diagnostics);
  const filesFromChangedFiles = normalizeChangedFileList(input.prInput.changedFiles ?? []);
  const mergedFiles = mergeChangedFiles(filesFromObjects, filesFromChangedFiles);
  const changedFiles = uniqueSorted(mergedFiles.map((file) => file.file));
  const existingChangedFiles = changedFiles.filter((file) => existsSync(join(rootDir, file)));

  if (mergedFiles.length === 0) {
    diagnostics.push("PR input did not contain files or changedFiles.");
  }

  if (changedFiles.length > 0 && existingChangedFiles.length === 0) {
    diagnostics.push("PR changed files were detected, but none exists on disk. This may be a delete-only or external repo PR input.");
  }

  return {
    sourcePath: input.sourcePath ?? null,
    repo: resolveRepo(input.prInput),
    prNumber: resolvePrNumber(input.prInput),
    baseRef: input.prInput.baseRef ?? input.prInput.base ?? null,
    headRef: input.prInput.headRef ?? input.prInput.head ?? null,
    title: input.prInput.title ?? null,
    changedFiles,
    existingChangedFiles,
    files: mergedFiles,
    fileCount: mergedFiles.length,
    additionCount: mergedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletionCount: mergedFiles.reduce((sum, file) => sum + file.deletions, 0),
    patchLineCount: mergedFiles.reduce((sum, file) => sum + countPatchLines(file.patch), 0),
    diagnostics
  };
}

export function selectChangedFilesForPrEvaluation(input: {
  pr: PrChangedFilesSummary;
  fallbackChangedFiles: string[];
  preferExistingFiles?: boolean;
  diagnostics?: string[];
}): string[] {
  const diagnostics = input.diagnostics ?? [];
  const preferExistingFiles = input.preferExistingFiles ?? true;

  if (preferExistingFiles && input.pr.existingChangedFiles.length > 0) {
    diagnostics.push("Using existing changed files from PR input.");
    return uniqueSorted(input.pr.existingChangedFiles);
  }

  if (input.pr.changedFiles.length > 0) {
    diagnostics.push("Using changed files from PR input.");
    return uniqueSorted(input.pr.changedFiles);
  }

  diagnostics.push("Using fallback changed files because PR input did not include changed files.");
  return uniqueSorted(input.fallbackChangedFiles);
}

function normalizeFileObjects(
  files: GitHubStylePrFileInput[],
  diagnostics: string[]
): NormalizedPrChangedFile[] {
  const normalized: NormalizedPrChangedFile[] = [];

  for (const file of files) {
    const rawPath = file.filename ?? file.file ?? file.path;

    if (!rawPath) {
      diagnostics.push("Skipped PR file entry without filename/file/path.");
      continue;
    }

    const additions = safeNumber(file.additions);
    const deletions = safeNumber(file.deletions);
    const changes = file.changes === undefined
      ? additions + deletions
      : safeNumber(file.changes);

    normalized.push({
      file: normalizeRepoPath(rawPath),
      previousFile: file.previous_filename ?? file.previousFilename
        ? normalizeRepoPath(String(file.previous_filename ?? file.previousFilename))
        : null,
      status: normalizeStatus(file.status),
      additions,
      deletions,
      changes,
      patch: file.patch ?? null
    });
  }

  return normalized;
}

function normalizeChangedFileList(files: string[]): NormalizedPrChangedFile[] {
  return files
    .map((file) => normalizeRepoPath(file))
    .filter(Boolean)
    .map((file) => ({
      file,
      previousFile: null,
      status: "changed" as const,
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: null
    }));
}

function mergeChangedFiles(
  objectFiles: NormalizedPrChangedFile[],
  listedFiles: NormalizedPrChangedFile[]
): NormalizedPrChangedFile[] {
  const byFile = new Map<string, NormalizedPrChangedFile>();

  for (const file of listedFiles) {
    byFile.set(file.file, file);
  }

  for (const file of objectFiles) {
    const existing = byFile.get(file.file);
    if (!existing) {
      byFile.set(file.file, file);
      continue;
    }

    byFile.set(file.file, {
      ...existing,
      ...file,
      additions: Math.max(existing.additions, file.additions),
      deletions: Math.max(existing.deletions, file.deletions),
      changes: Math.max(existing.changes, file.changes),
      patch: file.patch ?? existing.patch
    });
  }

  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function resolveRepo(input: GitHubStylePrInput): string | null {
  if (input.repo) return input.repo;
  if (input.repository) return input.repository;
  if (input.owner && input.name) return `${input.owner}/${input.name}`;
  return null;
}

function resolvePrNumber(input: GitHubStylePrInput): number | null {
  const value = input.prNumber ?? input.pullRequestNumber ?? input.number;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatus(value: string | undefined): PrChangedFileStatus {
  if (!value) return "unknown";

  const normalized = value.toLowerCase();

  if (normalized === "added") return "added";
  if (normalized === "modified") return "modified";
  if (normalized === "removed" || normalized === "deleted") return "removed";
  if (normalized === "renamed") return "renamed";
  if (normalized === "copied") return "copied";
  if (normalized === "changed") return "changed";

  return "unknown";
}

function safeNumber(value: number | undefined): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function countPatchLines(patch: string | null): number {
  if (!patch) return 0;
  return patch.split("\n").filter((line) => line.length > 0).length;
}

function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^a\//, "")
    .replace(/^b\//, "");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
