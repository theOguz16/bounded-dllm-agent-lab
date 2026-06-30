import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export type GitDiffMode =
  | "working_tree"
  | "staged"
  | "range"
  | "diff_file"
  | "empty";

export type GitDiffAdapterInput = {
  rootDir?: string;
  baseRef?: string;
  headRef?: string;
  diffFilePath?: string;
  includeStaged?: boolean;
  includeUntracked?: boolean;
  maxDiffBytes?: number;
};

export type GitDiffHunk = {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  addedLines: string[];
  removedLines: string[];
  contextLines: string[];
};

export type GitDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unknown";

export type GitDiffFileChange = {
  file: string;
  oldFile: string | null;
  status: GitDiffFileStatus;
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
};

export type GitDiffSummary = {
  rootDir: string;
  mode: GitDiffMode;
  baseRef: string | null;
  headRef: string | null;
  diffFilePath: string | null;
  rawDiffBytes: number;
  changedFiles: string[];
  existingChangedFiles: string[];
  fileChanges: GitDiffFileChange[];
  hunkCount: number;
  additionCount: number;
  deletionCount: number;
  diagnostics: string[];
};

type MutableGitDiffFileChange = GitDiffFileChange;

export function readGitDiff(input: GitDiffAdapterInput = {}): GitDiffSummary {
  const rootDir = input.rootDir ?? process.cwd();
  const diagnostics: string[] = [];
  const maxDiffBytes = input.maxDiffBytes ?? 1_500_000;
  const diffSource = readRawDiff({ ...input, rootDir, diagnostics });
  const rawDiff = trimDiffToBudget(diffSource.rawDiff, maxDiffBytes, diagnostics);
  const parsed = parseUnifiedGitDiff(rawDiff);
  const untrackedFiles = input.includeUntracked ?? true
    ? readUntrackedFiles(rootDir, diagnostics)
    : [];
  const fileChanges = mergeUntrackedFiles(parsed.fileChanges, untrackedFiles);
  const changedFiles = uniqueSorted(fileChanges.map((change) => change.file));
  const existingChangedFiles = changedFiles.filter((file) => existsSync(join(rootDir, file)));

  if (!rawDiff.trim() && untrackedFiles.length === 0) {
    diagnostics.push("No git diff or untracked files were found.");
  }

  if (changedFiles.length > 0 && existingChangedFiles.length === 0) {
    diagnostics.push("Changed files were detected, but none currently exists on disk. This may be a delete-only diff.");
  }

  return {
    rootDir,
    mode: diffSource.mode,
    baseRef: input.baseRef ?? null,
    headRef: input.headRef ?? null,
    diffFilePath: input.diffFilePath ?? null,
    rawDiffBytes: Buffer.byteLength(rawDiff, "utf8"),
    changedFiles,
    existingChangedFiles,
    fileChanges,
    hunkCount: fileChanges.reduce((sum, change) => sum + change.hunks.length, 0),
    additionCount: fileChanges.reduce((sum, change) => sum + change.additions, 0),
    deletionCount: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
    diagnostics
  };
}

export function parseChangedFilesFromEnv(value: string | undefined): string[] | null {
  if (!value) return null;

  const files = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(normalizeRepoPath)
    .filter((item) => item.length > 0);

  if (files.length === 0) return null;
  return uniqueSorted(files);
}

export function selectChangedFilesForEvaluation(input: {
  rootDir: string;
  diff: GitDiffSummary;
  envChangedFiles?: string[] | null;
  fallbackChangedFiles: string[];
  diagnostics?: string[];
}): string[] {
  const diagnostics = input.diagnostics ?? [];
  const envFiles = input.envChangedFiles ?? [];

  if (envFiles.length > 0) {
    diagnostics.push("Using REPO_CHANGED_FILES override for real repo evaluation.");
    return uniqueSorted(envFiles);
  }

  if (input.diff.existingChangedFiles.length > 0) {
    diagnostics.push("Using existing changed files extracted from git diff.");
    return uniqueSorted(input.diff.existingChangedFiles);
  }

  if (input.diff.changedFiles.length > 0) {
    diagnostics.push("Using changed files extracted from git diff, including files that may no longer exist.");
    return uniqueSorted(input.diff.changedFiles);
  }

  diagnostics.push("Using fallback changed files because no real git diff was detected.");
  return uniqueSorted(input.fallbackChangedFiles);
}

function readRawDiff(input: GitDiffAdapterInput & {
  rootDir: string;
  diagnostics: string[];
}): { mode: GitDiffMode; rawDiff: string } {
  if (input.diffFilePath) {
    const path = join(input.rootDir, input.diffFilePath);
    try {
      return {
        mode: "diff_file",
        rawDiff: readFileSync(path, "utf8")
      };
    } catch (error) {
      input.diagnostics.push(`Failed to read diff file ${input.diffFilePath}: ${formatError(error)}`);
      return { mode: "empty", rawDiff: "" };
    }
  }

  if (input.baseRef && input.headRef) {
    return {
      mode: "range",
      rawDiff: runGitDiff(
        input.rootDir,
        ["diff", "--no-ext-diff", "--find-renames", "--unified=20", input.baseRef, input.headRef],
        input.diagnostics
      )
    };
  }

  if (input.includeStaged) {
    return {
      mode: "staged",
      rawDiff: runGitDiff(
        input.rootDir,
        ["diff", "--cached", "--no-ext-diff", "--find-renames", "--unified=20"],
        input.diagnostics
      )
    };
  }

  return {
    mode: "working_tree",
    rawDiff: runGitDiff(
      input.rootDir,
      ["diff", "--no-ext-diff", "--find-renames", "--unified=20"],
      input.diagnostics
    )
  };
}

function runGitDiff(rootDir: string, args: string[], diagnostics: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    diagnostics.push(`Failed to run git ${args.join(" ")}: ${formatError(error)}`);
    return "";
  }
}

function readUntrackedFiles(rootDir: string, diagnostics: string[]): string[] {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir,
      encoding: "utf8"
    })
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(normalizeRepoPath)
      .filter((file) => !isIgnoredGeneratedPath(file));
  } catch (error) {
    diagnostics.push(`Failed to read untracked files: ${formatError(error)}`);
    return [];
  }
}

function parseUnifiedGitDiff(rawDiff: string): { fileChanges: GitDiffFileChange[] } {
  const fileChanges: MutableGitDiffFileChange[] = [];
  const lines = rawDiff.split("\n");

  let currentFile: MutableGitDiffFileChange | null = null;
  let currentHunk: GitDiffHunk | null = null;

  for (const line of lines) {
    const diffHeader = parseDiffGitHeader(line);
    if (diffHeader) {
      if (currentFile) fileChanges.push(currentFile);
      currentFile = {
        file: diffHeader.newFile,
        oldFile: diffHeader.oldFile === diffHeader.newFile ? null : diffHeader.oldFile,
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: []
      };
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("new file mode")) {
      currentFile.status = "added";
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      currentFile.status = "deleted";
      continue;
    }

    if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldFile = normalizeRepoPath(line.replace("rename from ", ""));
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.file = normalizeRepoPath(line.replace("rename to ", ""));
      continue;
    }

    if (line.startsWith("copy from ")) {
      currentFile.status = "copied";
      currentFile.oldFile = normalizeRepoPath(line.replace("copy from ", ""));
      continue;
    }

    if (line.startsWith("copy to ")) {
      currentFile.status = "copied";
      currentFile.file = normalizeRepoPath(line.replace("copy to ", ""));
      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = parsePatchPath(line.slice(4));
      if (file && file !== "/dev/null") {
        currentFile.file = file;
      }
      continue;
    }

    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      currentHunk = {
        file: currentFile.file,
        oldStart: hunkHeader.oldStart,
        oldLines: hunkHeader.oldLines,
        newStart: hunkHeader.newStart,
        newLines: hunkHeader.newLines,
        header: line,
        addedLines: [],
        removedLines: [],
        contextLines: []
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.additions += 1;
      currentHunk.addedLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.deletions += 1;
      currentHunk.removedLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(" ")) {
      currentHunk.contextLines.push(line.slice(1));
    }
  }

  if (currentFile) fileChanges.push(currentFile);

  return {
    fileChanges: dedupeFileChanges(fileChanges)
  };
}

function mergeUntrackedFiles(
  fileChanges: GitDiffFileChange[],
  untrackedFiles: string[]
): GitDiffFileChange[] {
  const existing = new Set(fileChanges.map((change) => change.file));
  const additions = untrackedFiles
    .filter((file) => !existing.has(file))
    .map((file): GitDiffFileChange => ({
      file,
      oldFile: null,
      status: "added",
      additions: 0,
      deletions: 0,
      hunks: []
    }));

  return [...fileChanges, ...additions];
}

function dedupeFileChanges(fileChanges: GitDiffFileChange[]): GitDiffFileChange[] {
  const byFile = new Map<string, GitDiffFileChange>();

  for (const change of fileChanges) {
    const existing = byFile.get(change.file);
    if (!existing) {
      byFile.set(change.file, change);
      continue;
    }

    byFile.set(change.file, {
      ...existing,
      additions: existing.additions + change.additions,
      deletions: existing.deletions + change.deletions,
      hunks: [...existing.hunks, ...change.hunks],
      status: existing.status === "unknown" ? change.status : existing.status,
      oldFile: existing.oldFile ?? change.oldFile
    });
  }

  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function parseDiffGitHeader(line: string): { oldFile: string; newFile: string } | null {
  if (!line.startsWith("diff --git ")) return null;

  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!match) return null;

  return {
    oldFile: normalizeRepoPath(match[1]),
    newFile: normalizeRepoPath(match[2])
  };
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;

  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1")
  };
}

function parsePatchPath(value: string): string | null {
  const clean = value.trim();
  if (clean === "/dev/null") return clean;
  if (clean.startsWith("a/") || clean.startsWith("b/")) {
    return normalizeRepoPath(clean.slice(2));
  }
  return normalizeRepoPath(clean);
}

function trimDiffToBudget(rawDiff: string, maxDiffBytes: number, diagnostics: string[]): string {
  const bytes = Buffer.byteLength(rawDiff, "utf8");
  if (bytes <= maxDiffBytes) return rawDiff;

  diagnostics.push(`Raw diff was truncated from ${bytes} bytes to ${maxDiffBytes} bytes.`);
  return rawDiff.slice(0, maxDiffBytes);
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

function isIgnoredGeneratedPath(file: string): boolean {
  return (
    file.startsWith("dist/") ||
    file.startsWith("reports/") ||
    file.startsWith("node_modules/") ||
    file.startsWith(".git/") ||
    file.includes("/dist/") ||
    file.includes("/node_modules/")
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}