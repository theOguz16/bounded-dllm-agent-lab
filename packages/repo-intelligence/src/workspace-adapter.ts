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
 * WorkspaceRepoFacts canonical shape'ine ek olarak bazı adapter/fixture'lar
 * evidenceFacts gibi metadata alanları taşıyabilir.
 *
 * Bu metadata verifier/remask flow için önemlidir. Repo intelligence attach ederken
 * bu alanları silmemeliyiz.
 */
type WorkspaceRepoFactsWithMetadata = SharedSemanticWorkspace["repoFacts"] & {
  evidenceFacts?: unknown[];
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
  input: RepoIntelligenceResult | RepoIntelligenceFacts,
  existingRepoFacts?: SharedSemanticWorkspace["repoFacts"]
): SharedSemanticWorkspace["repoFacts"] {
  const facts = isRepoIntelligenceResult(input) ? input.facts : input;
  const existing = existingRepoFacts as WorkspaceRepoFactsWithMetadata | undefined;

  const repoFacts: WorkspaceRepoFactsWithMetadata = {
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
  } as unknown as WorkspaceRepoFactsWithMetadata;

  /**
   * Kritik:
   * Fixture/workspace adapter bazı verifier evidence'larını repoFacts.evidenceFacts
   * içinde taşıyabiliyor. Repo intelligence attach sırasında bunu silersek
   * verifier stale/current evidence göremez ve remask_required yerine approve döner.
   */
  if (existing?.evidenceFacts) {
    repoFacts.evidenceFacts = existing.evidenceFacts;
  }

  return repoFacts as SharedSemanticWorkspace["repoFacts"];
}

/**
 * Mevcut workspace'i korur, sadece repoFacts region'ını gerçek repo intelligence
 * sonucuyla değiştirir.
 *
 * Önemli:
 * - repoFacts canonical fields repo intelligence'dan gelir.
 * - repoFacts.evidenceFacts gibi runtime/verifier metadata alanları korunur.
 */
export function attachRepoIntelligenceToWorkspace(
  workspace: SharedSemanticWorkspace,
  input: RepoIntelligenceResult | RepoIntelligenceFacts
): SharedSemanticWorkspace {
  return {
    ...workspace,
    repoFacts: repoIntelligenceToWorkspaceRepoFacts(input, workspace.repoFacts)
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