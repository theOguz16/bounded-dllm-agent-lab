import {
  analyzeRepository
} from "../../../packages/repo-intelligence/src/index.js";

const changedFiles = [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const result = await analyzeRepository({
  rootDir: process.cwd(),
  changedFiles,
  maxFiles: 1000
});

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Repo changed-files smoke failed.",
        failures,
        summary: summarizeResult()
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
      smokeName: "repo-changed-files-smoke",
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResult(): string[] {
  const failures: string[] = [];
  const expectedChangedFiles = new Set(changedFiles);
  const actualChangedFiles = new Set(result.facts.changedFiles);

  if (result.scannedFileCount <= 0) {
    failures.push("Expected repo intelligence to scan at least one file.");
  }

  if (result.facts.changedFiles.length !== changedFiles.length) {
    failures.push(
      `Expected exactly ${changedFiles.length} changed files, got ${result.facts.changedFiles.length}.`
    );
  }

  for (const file of expectedChangedFiles) {
    if (!actualChangedFiles.has(file)) {
      failures.push(`Expected changed file ${file} to be preserved.`);
    }
  }

  const allowedModuleRoots = new Set(changedFiles.map(getModuleRoot));

  for (const ownership of result.facts.ownership) {
    if (!allowedModuleRoots.has(ownership.pathPrefix)) {
      failures.push(`Unexpected ownership pathPrefix outside changed modules: ${ownership.pathPrefix}`);
    }
  }

  for (const boundary of result.facts.moduleBoundaries) {
    if (!allowedModuleRoots.has(boundary.pathPrefix)) {
      failures.push(`Unexpected module boundary outside changed modules: ${boundary.pathPrefix}`);
    }
  }

  if (result.facts.changedFiles.some((file) => file.startsWith("apps/cli/"))) {
    failures.push("Changed files should not fall back to all source candidates.");
  }

  if (result.facts.ownership.length <= 0) {
    failures.push("Expected changed-files analysis to infer ownership facts.");
  }

  if (result.facts.moduleBoundaries.length <= 0) {
    failures.push("Expected changed-files analysis to infer module boundaries.");
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    rootDir: result.rootDir,
    scannedFileCount: result.scannedFileCount,
    skippedFileCount: result.skippedFileCount,

    changedFiles: result.facts.changedFiles,
    changedFileCount: result.facts.changedFiles.length,

    ownershipCount: result.facts.ownership.length,
    ownership: result.facts.ownership,

    moduleBoundaryCount: result.facts.moduleBoundaries.length,
    moduleBoundaries: result.facts.moduleBoundaries,

    pairedFileCount: result.facts.pairedFiles.length,
    requiredTestCount: result.facts.requiredTests.length,
    requiredTestMappingCount: result.facts.requiredTestMappings.length,

    sensitivePatternCount: result.facts.sensitivePatterns.length,
    sampleSensitivePatterns: result.facts.sensitivePatterns.slice(0, 10),

    staleFactCount: result.facts.staleFacts.length,
    sampleStaleFacts: result.facts.staleFacts.slice(0, 10),

    diagnostics: result.diagnostics.slice(0, 10)
  };
}

function getModuleRoot(file: string): string {
  const parts = file.split("/");

  if ((parts[0] === "packages" || parts[0] === "apps") && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0] ?? "";
}