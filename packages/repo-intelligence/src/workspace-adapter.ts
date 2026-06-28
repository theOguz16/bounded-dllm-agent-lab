import type {
  RepoIntelligenceFacts,
  RepoIntelligenceResult
} from "./index.js";
import type {
  SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";

export type RepoIntelligenceWorkspaceSummary = {
  changedFileCount: number;
  ownershipCount: number;
  pairedFileCount: number;
  requiredTestCount: number;
  requiredTestMappingCount: number;
  moduleBoundaryCount: number;
  sensitivePatternCount: number;
  staleFactCount: number;
};

/**
 * Repo Intelligence -> Workspace RepoFacts adapter.
 *
 * Repo Intelligence daha zengin metadata tutar:
 * - ownership: Array<{ pathPrefix, owner, reason }>
 * - pairedFiles: Array<{ sourceFile, pairedFile, reason }>
 * - requiredTestMappings: Array<{ sourceFile, requiredTestFile, reason }>
 *
 * Workspace runtime ise canonical daha kompakt shape bekler.
 * Özellikle WorkspaceRepoFacts.ownership tipi Record<string, string>'dir.
 */
export function repoIntelligenceToWorkspaceRepoFacts(
  input: RepoIntelligenceResult | RepoIntelligenceFacts
): SharedSemanticWorkspace["repoFacts"] {
  const facts = isRepoIntelligenceResult(input) ? input.facts : input;

  const repoFacts = {
    changedFiles: uniqueSorted(facts.changedFiles),

    /**
     * Canonical workspace shape:
     * ownership: Record<pathPrefix, owner>
     */
    ownership: ownershipFactsToRecord(facts.ownership),

    /**
     * Bu alanlar workspace-core sürümüne göre array veya daha zengin tip olarak
     * tanımlanmış olabilir. Repo intelligence metadata'sını koruyoruz.
     */
    pairedFiles: facts.pairedFiles,
    requiredTests: uniqueSorted(facts.requiredTests),
    requiredTestMappings: facts.requiredTestMappings,
    moduleBoundaries: facts.moduleBoundaries,
    sensitivePatterns: uniqueSorted(facts.sensitivePatterns),
    staleFacts: uniqueSorted(facts.staleFacts)
  };

  /**
   * WorkspaceRepoFacts ile repo-intelligence fact tipleri birebir aynı değil.
   * Runtime'da ihtiyaç duyulan canonical alanlar korunuyor; zengin metadata ise
   * context composer'da bounded/compact edilerek kullanılıyor.
   */
  return repoFacts as unknown as SharedSemanticWorkspace["repoFacts"];
}

/**
 * Mevcut workspace'i korur, sadece repoFacts region'ını gerçek repo intelligence
 * sonucuyla değiştirir.
 */
export function attachRepoIntelligenceToWorkspace(
  workspace: SharedSemanticWorkspace,
  input: RepoIntelligenceResult | RepoIntelligenceFacts
): SharedSemanticWorkspace {
  return {
    ...workspace,
    repoFacts: repoIntelligenceToWorkspaceRepoFacts(input)
  };
}

export function summarizeWorkspaceRepoFacts(
  repoFacts: SharedSemanticWorkspace["repoFacts"]
): RepoIntelligenceWorkspaceSummary {
  return {
    changedFileCount: countCollection(repoFacts.changedFiles),
    ownershipCount: countCollection(repoFacts.ownership),
    pairedFileCount: countCollection(repoFacts.pairedFiles),
    requiredTestCount: countCollection(repoFacts.requiredTests),
    requiredTestMappingCount: countCollection(repoFacts.requiredTestMappings),
    moduleBoundaryCount: countCollection(repoFacts.moduleBoundaries),
    sensitivePatternCount: countCollection(repoFacts.sensitivePatterns),
    staleFactCount: countCollection(repoFacts.staleFacts)
  };
}

function isRepoIntelligenceResult(
  input: RepoIntelligenceResult | RepoIntelligenceFacts
): input is RepoIntelligenceResult {
  return "facts" in input && "scannedFileCount" in input;
}

function ownershipFactsToRecord(
  ownership: RepoIntelligenceFacts["ownership"]
): Record<string, string> {
  return Object.fromEntries(
    ownership.map((item) => [item.pathPrefix, item.owner])
  );
}

function countCollection(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length;
  }

  return 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}