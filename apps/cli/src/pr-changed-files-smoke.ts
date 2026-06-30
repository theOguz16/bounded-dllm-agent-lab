import { analyzeRepository } from "../../../packages/repo-intelligence/src/index.js";
import {
  createPrChangedFilesSummary,
  readPrChangedFilesInput,
  selectChangedFilesForPrEvaluation
} from "../../../packages/repo-intelligence/src/pr-changed-files-adapter.js";

const rootDir = process.cwd();
const prInputPath = process.env.PR_INPUT_FILE ?? "examples/real-repo-evaluation/github-pr-input.example.json";

const fallbackChangedFiles = [
  "apps/cli/src/pr-changed-files-smoke.ts",
  "apps/cli/src/pr-evaluation-report.ts",
  "packages/repo-intelligence/src/pr-changed-files-adapter.ts",
  "package.json"
];

const diagnostics: string[] = [];
const prInput = readPrChangedFilesInput(prInputPath);

const pr = createPrChangedFilesSummary({
  rootDir,
  sourcePath: prInputPath,
  prInput
});

diagnostics.push(...pr.diagnostics);

const changedFiles = selectChangedFilesForPrEvaluation({
  pr,
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
        smokeName: "pr-changed-files-smoke",
        reason: "PR changed files smoke failed.",
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
      smokeName: "pr-changed-files-smoke",
      summary: summarize()
    },
    null,
    2
  )
);

function validateSmoke(): string[] {
  const failures: string[] = [];

  if (pr.fileCount <= 0) {
    failures.push("Expected PR input to contain at least one file.");
  }

  if (pr.changedFiles.length <= 0) {
    failures.push("Expected PR changed files to be non-empty.");
  }

  if (changedFiles.length <= 0) {
    failures.push("Expected selected changed files to be non-empty.");
  }

  if (repoResult.scannedFileCount <= 0) {
    failures.push("Expected repo intelligence to scan files.");
  }

  for (const file of changedFiles) {
    if (!repoResult.facts.changedFiles.includes(file)) {
      failures.push(`Expected repo intelligence to preserve changed file ${file}.`);
    }
  }

  if (repoResult.facts.ownership.length <= 0) {
    failures.push("Expected ownership facts for PR changed files.");
  }

  return failures;
}

function summarize(): Record<string, unknown> {
  return {
    rootDir,
    pr: {
      sourcePath: pr.sourcePath,
      repo: pr.repo,
      prNumber: pr.prNumber,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      title: pr.title,
      fileCount: pr.fileCount,
      changedFiles: pr.changedFiles,
      existingChangedFiles: pr.existingChangedFiles,
      additionCount: pr.additionCount,
      deletionCount: pr.deletionCount,
      patchLineCount: pr.patchLineCount
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
