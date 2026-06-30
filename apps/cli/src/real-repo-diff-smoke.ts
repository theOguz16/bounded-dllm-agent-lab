import { analyzeRepository } from "../../../packages/repo-intelligence/src/index.js";
import {
  parseChangedFilesFromEnv,
  readGitDiff,
  selectChangedFilesForEvaluation
} from "../../../packages/repo-intelligence/src/git-diff-adapter.js";

const fallbackChangedFiles = [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const diagnostics: string[] = [];
const rootDir = process.cwd();
const diff = readGitDiff({
  rootDir,
  baseRef: process.env.GIT_BASE_REF,
  headRef: process.env.GIT_HEAD_REF,
  diffFilePath: process.env.GIT_DIFF_FILE,
  includeStaged: process.env.GIT_DIFF_STAGED === "1",
  includeUntracked: process.env.GIT_DIFF_INCLUDE_UNTRACKED !== "0"
});

diagnostics.push(...diff.diagnostics);

const changedFiles = selectChangedFilesForEvaluation({
  rootDir,
  diff,
  envChangedFiles: parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES),
  fallbackChangedFiles,
  diagnostics
});

const repoResult = await analyzeRepository({
  rootDir,
  changedFiles,
  maxFiles: 1000
});

const failures = validateSmoke();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        smokeName: "real-repo-diff-smoke",
        reason: "Real repo diff smoke failed.",
        failures,
        summary: summarize()
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      smokeName: "real-repo-diff-smoke",
      summary: summarize()
    },
    null,
    2
  )
);

function validateSmoke(): string[] {
  const failures: string[] = [];

  if (repoResult.scannedFileCount <= 0) {
    failures.push("Expected repo intelligence to scan at least one file.");
  }

  if (changedFiles.length <= 0) {
    failures.push("Expected at least one changed file from diff, env, or fallback.");
  }

  for (const file of changedFiles) {
    if (!repoResult.facts.changedFiles.includes(file)) {
      failures.push(`Expected repo intelligence to preserve changed file ${file}.`);
    }
  }

  if (repoResult.facts.ownership.length <= 0) {
    failures.push("Expected ownership facts for changed files.");
  }

  if (repoResult.facts.moduleBoundaries.length <= 0) {
    failures.push("Expected module boundary facts for changed files.");
  }

  if (
    diff.mode !== "empty" &&
    diff.changedFiles.length > 0 &&
    diff.fileChanges.length <= 0
  ) {
    failures.push("Expected fileChanges to be populated when diff changed files exist.");
  }

  return failures;
}

function summarize(): Record<string, unknown> {
  return {
    rootDir,
    diff: {
      mode: diff.mode,
      baseRef: diff.baseRef,
      headRef: diff.headRef,
      diffFilePath: diff.diffFilePath,
      rawDiffBytes: diff.rawDiffBytes,
      changedFiles: diff.changedFiles,
      existingChangedFiles: diff.existingChangedFiles,
      fileChangeCount: diff.fileChanges.length,
      hunkCount: diff.hunkCount,
      additionCount: diff.additionCount,
      deletionCount: diff.deletionCount
    },
    selectedChangedFiles: changedFiles,
    repo: {
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      changedFileCount: repoResult.facts.changedFiles.length,
      ownershipCount: repoResult.facts.ownership.length,
      pairedFileCount: repoResult.facts.pairedFiles.length,
      requiredTestCount: repoResult.facts.requiredTests.length,
      requiredTestMappingCount: repoResult.facts.requiredTestMappings.length,
      moduleBoundaryCount: repoResult.facts.moduleBoundaries.length,
      sensitivePatternCount: repoResult.facts.sensitivePatterns.length,
      staleFactCount: repoResult.facts.staleFacts.length
    },
    diagnostics: [...diagnostics, ...repoResult.diagnostics].slice(0, 20)
  };
}