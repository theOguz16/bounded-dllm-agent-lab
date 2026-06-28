import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  analyzeRepository
} from "../../../packages/repo-intelligence/src/index.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import type {
  WorkspaceRole
} from "../../../packages/workspace-core/src/index.js";

const roles: WorkspaceRole[] = [
  "planner",
  "coder",
  "verifier",
  "tester",
  "remask",
  "merge"
];

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before repo context composer smoke.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

const fixture = remaskFixtures[0];

if (!fixture) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "No fixture found for repo context composer smoke."
      },
      null,
      2
    )
  );
}

/**
 * Gerçek repo taraması.
 * node_modules, dist, reports, benchmarks/repos gibi gürültüler repo-intelligence
 * default ignore listesinde dışarıda kalır.
 */
const repoResult = await analyzeRepository({
  rootDir: process.cwd(),
  maxFiles: 1000
});

/**
 * Fixture packet hâlâ task/scope/authority için kullanılıyor.
 * Ama repoFacts artık gerçek repo intelligence sonucundan geliyor.
 */
const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
  id: `repo-context-composer-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
const views = composeRoleViews(workspace, roles);

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Repo context composer smoke failed.",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
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
      smokeName: "repo-context-composer-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResult(): string[] {
  const failures: string[] = [];
  const repoSummary = summarizeWorkspaceRepoFacts(workspace.repoFacts);

  if (repoResult.scannedFileCount <= 0) {
    failures.push("Expected repo intelligence to scan at least one file.");
  }

  if (repoSummary.changedFileCount <= 0) {
    failures.push("Expected workspace.repoFacts.changedFiles to be populated from repo intelligence.");
  }

  if (repoSummary.ownershipCount <= 0) {
    failures.push("Expected workspace.repoFacts.ownership to be populated from repo intelligence.");
  }

  if (repoSummary.moduleBoundaryCount <= 0) {
    failures.push("Expected workspace.repoFacts.moduleBoundaries to be populated from repo intelligence.");
  }

  if (views.length !== roles.length) {
    failures.push(`Expected ${roles.length} role views, got ${views.length}.`);
  }

  for (const role of roles) {
    const view = views.find((item) => item.role === role);

    if (!view) {
      failures.push(`Missing role view for ${role}.`);
      continue;
    }

    if (view.estimatedTokens <= 0) {
      failures.push(`Role ${role} has invalid estimated token count.`);
    }

    if (view.budgetTokens <= 0) {
      failures.push(`Role ${role} has invalid budget token count.`);
    }
  }

  /**
   * En az bir role view içinde repoFacts context'i görünmeli.
   * Bu, repo intelligence -> workspace -> context composer bağlantısının
   * gerçekten kurulduğunu doğrular.
   */
  const hasRepoFactsInRoleContext = views.some((view) => {
    const context = view.context as Record<string, unknown>;
    return Boolean(context.repoFacts);
  });

  if (!hasRepoFactsInRoleContext) {
    failures.push("Expected at least one composed role view to include repoFacts context.");
  }

  /**
   * Coder ve planner stale fact'i active authority gibi görmemeli.
   */
  const planner = views.find((view) => view.role === "planner");
  const coder = views.find((view) => view.role === "coder");

  if (planner?.includedFacts.some((fact) => fact.kind === "stale")) {
    failures.push("Planner should not include stale facts by default.");
  }

  if (coder?.includedFacts.some((fact) => fact.kind === "stale")) {
    failures.push("Coder should not include stale facts by default.");
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      scannedFileSamples: repoResult.scannedFiles.slice(0, 10)
    },
    workspaceRepoFacts: {
      ...summarizeWorkspaceRepoFacts(workspace.repoFacts),
      sampleChangedFiles: workspace.repoFacts.changedFiles.slice(0, 10),
      sampleModuleBoundaries: workspace.repoFacts.moduleBoundaries.slice(0, 10),
      sampleSensitivePatterns: workspace.repoFacts.sensitivePatterns.slice(0, 10),
      sampleStaleFacts: workspace.repoFacts.staleFacts.slice(0, 10)
    },
    roleViews: views.map(summarizeRoleView)
  };
}

function summarizeRoleView(view: ComposedRoleView): Record<string, unknown> {
  return {
    role: view.role,
    sufficiency: view.sufficiency,
    estimatedTokens: view.estimatedTokens,
    budgetTokens: view.budgetTokens,
    budgetUtilization: view.budgetUtilization,
    includedRegionCount: view.includedRegions.length,
    excludedRegionCount: view.excludedRegions.length,
    includedRegions: view.includedRegions,
    excludedRegions: view.excludedRegions,
    includedFactCount: view.includedFacts.length,
    excludedFactCount: view.excludedFacts.length,
    staleExclusionCount: view.staleExclusions.length,
    sensitiveExclusionCount: view.sensitiveExclusions.length,
    warningCount: view.warnings.length,
    hasRepoFactsContext: Boolean((view.context as Record<string, unknown>).repoFacts)
  };
}