import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  evaluateConflictAwareMerge
} from "../../../packages/merge-core/src/index.js";
import {
  runMockOrchestrationFlow
} from "../../../packages/orchestration-core/src/index.js";
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

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

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
        reason: "Fixture validation failed before repo orchestrator smoke.",
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
        reason: "No fixture found for repo orchestrator smoke."
      },
      null,
      2
    )
  );
}

const repoResult = await analyzeRepository({
  rootDir: process.cwd(),
  changedFiles,
  maxFiles: 1000
});

const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
  id: `repo-orchestrator-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
const roleViews = composeRoleViews(workspace, roles);
const orchestrationResult = runMockOrchestrationFlow(workspace);
const mergeResult = evaluateConflictAwareMerge(orchestrationResult);

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Repo orchestrator smoke failed.",
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
      smokeName: "repo-orchestrator-smoke",
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

  if (repoSummary.changedFileCount !== changedFiles.length) {
    failures.push(
      `Expected ${changedFiles.length} changed files in workspace repoFacts, got ${repoSummary.changedFileCount}.`
    );
  }

  if (repoSummary.ownershipCount <= 0) {
    failures.push("Expected scoped repo intelligence to infer ownership facts.");
  }

  if (repoSummary.moduleBoundaryCount <= 0) {
    failures.push("Expected scoped repo intelligence to infer module boundaries.");
  }

  if (repoSummary.sensitivePatternCount > 10) {
    failures.push(
      `Expected changed-files scoped sensitive patterns to stay compact, got ${repoSummary.sensitivePatternCount}.`
    );
  }

  if (roleViews.length !== roles.length) {
    failures.push(`Expected ${roles.length} role views, got ${roleViews.length}.`);
  }

  for (const role of roles) {
    const view = roleViews.find((item) => item.role === role);

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

    if (view.sufficiency !== "sufficient") {
      failures.push(`Expected role ${role} to be sufficient, got ${view.sufficiency}.`);
    }
  }

  const repoAwareRoles = roleViews.filter((view) =>
    Boolean((view.context as Record<string, unknown>).repoFacts)
  );

  if (repoAwareRoles.length <= 0) {
    failures.push("Expected at least one role view to receive scoped repoFacts.");
  }

  if (orchestrationResult.steps.length <= 0) {
    failures.push("Expected orchestrator to execute at least one step.");
  }

  const expectedSteps = [
    "planner",
    "coder",
    "verifier",
    "remask",
    "merge",
    "final"
  ];

  for (const step of expectedSteps) {
    if (!orchestrationResult.steps.some((item) => item.id === step)) {
      failures.push(`Expected orchestrator step ${step} to exist.`);
    }
  }

  if (orchestrationResult.mutationSummary.blockedMutations !== 0) {
    failures.push(
      `Expected zero blocked mutations, got ${orchestrationResult.mutationSummary.blockedMutations}.`
    );
  }

  if (orchestrationResult.mutationSummary.appliedMutations <= 0) {
    failures.push("Expected orchestrator to apply at least one mutation.");
  }

  if (orchestrationResult.decision !== "remask_required") {
    failures.push(
      `Expected orchestration decision remask_required, got ${orchestrationResult.decision}.`
    );
  }

  if (!orchestrationResult.remaskTriggered) {
    failures.push("Expected remask to be triggered for remask fixture.");
  }

  if (mergeResult.decision !== "remask_required") {
    failures.push(`Expected merge decision remask_required, got ${mergeResult.decision}.`);
  }

  if (mergeResult.mergeSafe) {
    failures.push("Expected mergeSafe=false while remask is unresolved.");
  }

  if (mergeResult.conflicts.length <= 0) {
    failures.push("Expected conflict-aware merge to produce at least one conflict.");
  }

  if (!mergeResult.conflicts.some((conflict) => conflict.kind === "stale_authority")) {
    failures.push("Expected stale_authority conflict.");
  }

  if (!mergeResult.conflicts.some((conflict) => conflict.kind === "remask_unresolved")) {
    failures.push("Expected remask_unresolved conflict.");
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    workspaceRepoFacts: {
      ...summarizeWorkspaceRepoFacts(workspace.repoFacts),
      sampleChangedFiles: workspace.repoFacts.changedFiles.slice(0, 10),
      sampleOwnership: workspace.repoFacts.ownership,
      sampleModuleBoundaries: workspace.repoFacts.moduleBoundaries.slice(0, 10),
      sampleSensitivePatterns: workspace.repoFacts.sensitivePatterns.slice(0, 10),
      sampleStaleFacts: workspace.repoFacts.staleFacts.slice(0, 10)
    },
    roleViews: roleViews.map(summarizeRoleView),
    orchestration: {
      flowId: orchestrationResult.flowId,
      decision: orchestrationResult.decision,
      remaskTriggered: orchestrationResult.remaskTriggered,
      stepCount: orchestrationResult.steps.length,
      tokenSummary: orchestrationResult.tokenSummary,
      mutationSummary: orchestrationResult.mutationSummary,
      steps: orchestrationResult.steps.map((step) => ({
        id: step.id,
        role: step.role,
        status: step.status,
        decision: step.decision,
        estimatedTokens: step.estimatedTokens,
        budgetTokens: step.budgetTokens,
        budgetUtilization: step.budgetUtilization,
        sufficiency: step.sufficiency,
        mutationCount: step.mutations.length,
        mutatedRegions: step.mutations.map((mutation) => mutation.region)
      }))
    },
    merge: {
      decision: mergeResult.decision,
      mergeSafe: mergeResult.mergeSafe,
      conflictCount: mergeResult.conflicts.length,
      conflicts: mergeResult.conflicts.map((conflict) => ({
        kind: conflict.kind,
        severity: conflict.severity,
        suggestedDecision: conflict.suggestedDecision,
        sourceStepIds: conflict.sourceStepIds,
        evidenceIds: conflict.evidenceIds,
        message: conflict.message
      })),
      requiredActions: mergeResult.requiredActions,
      evidence: mergeResult.evidence
    }
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

function parseChangedFilesFromEnv(value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }

  const files = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.replace(/\\/g, "/"))
    .map((item) => item.replace(/^\.\//, ""));

  if (files.length === 0) {
    return null;
  }

  return [...new Set(files)].sort();
}