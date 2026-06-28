import { analyzeRepository } from "../../../packages/repo-intelligence/src/index.js";

const result = await analyzeRepository({
  rootDir: process.cwd(),
  maxFiles: 1000
});

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Repo intelligence smoke failed.",
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
      smokeName: "repo-intelligence-smoke",
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResult(): string[] {
  const failures: string[] = [];

  if (result.scannedFileCount <= 0) {
    failures.push("Expected repo intelligence to scan at least one file.");
  }

  if (result.facts.changedFiles.length <= 0) {
    failures.push("Expected repo intelligence to infer at least one source/changed file candidate.");
  }

  if (result.facts.moduleBoundaries.length <= 0) {
    failures.push("Expected repo intelligence to infer at least one module boundary.");
  }

  if (result.facts.ownership.length <= 0) {
    failures.push("Expected repo intelligence to infer at least one ownership fact.");
  }

  /**
   * Test pairing olmayabilir; bu yüzden fail etmiyoruz.
   * Ama varsa output'ta görüyoruz.
   */
  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    rootDir: result.rootDir,
    scannedFileCount: result.scannedFileCount,
    skippedFileCount: result.skippedFileCount,
    changedFileCandidateCount: result.facts.changedFiles.length,
    ownershipCount: result.facts.ownership.length,
    pairedFileCount: result.facts.pairedFiles.length,
    requiredTestCount: result.facts.requiredTests.length,
    requiredTestMappingCount: result.facts.requiredTestMappings.length,
    moduleBoundaryCount: result.facts.moduleBoundaries.length,
    sensitivePatternCount: result.facts.sensitivePatterns.length,
    staleFactCount: result.facts.staleFacts.length,
    sampleChangedFiles: result.facts.changedFiles.slice(0, 10),
    sampleModuleBoundaries: result.facts.moduleBoundaries.slice(0, 10),
    samplePairedFiles: result.facts.pairedFiles.slice(0, 10),
    sampleSensitivePatterns: result.facts.sensitivePatterns.slice(0, 10),
    sampleStaleFacts: result.facts.staleFacts.slice(0, 10),
    diagnostics: result.diagnostics.slice(0, 10)
  };
}