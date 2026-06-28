import {
  composeRoleViews,
  type ComposedRoleView,
  type ContextFactKind
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import type { WorkspaceRole } from "../../../packages/workspace-core/src/index.js";

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
        reason: "Fixture validation failed before context composer smoke.",
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
        reason: "No remask fixture found for context composer smoke."
      },
      null,
      2
    )
  );
}

/**
 * Bu smoke test eski packet'i runtime modeline doğrudan sokmaz.
 * Fixture packet sadece adapter input'u olarak kullanılır.
 * Çıktı canonical SharedSemanticWorkspace olur.
 */
const workspace = createWorkspaceFromPacket(fixture.packet, {
  id: `context-composer-smoke-${fixture.case.id}`
});

/**
 * Context Composer v1:
 * Aynı workspace'ten farklı agent rolleri için farklı bounded working memory
 * view'leri üretir.
 */
const views = composeRoleViews(workspace, roles);

const failures = validateComposedViews(views);

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Context composer smoke failed.",
        workspaceId: workspace.id,
        caseId: fixture.case.id,
        failures,
        views: views.map(summarizeView)
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
      smokeName: "context-composer-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      roleCount: views.length,
      roles: views.map((view) => view.role),
      summaries: views.map(summarizeView)
    },
    null,
    2
  )
);

function validateComposedViews(views: ComposedRoleView[]): string[] {
  const failures: string[] = [];

  if (views.length !== roles.length) {
    failures.push(`Expected ${roles.length} role view(s), got ${views.length}.`);
  }

  for (const role of roles) {
    const view = views.find((item) => item.role === role);

    if (!view) {
      failures.push(`Missing role view for ${role}.`);
      continue;
    }

    if (view.workspaceId !== workspace.id) {
      failures.push(`Role ${role} has wrong workspaceId: ${view.workspaceId}.`);
    }

    if (view.includedRegions.length === 0) {
      failures.push(`Role ${role} has no included regions.`);
    }

    if (view.estimatedTokens <= 0) {
      failures.push(`Role ${role} has invalid estimated token count.`);
    }

    if (view.budgetTokens <= 0) {
      failures.push(`Role ${role} has invalid budget token count.`);
    }

    if (view.budgetUtilization < 0) {
      failures.push(`Role ${role} has invalid budget utilization.`);
    }

    /**
     * Coder role'ü aktif üretim rolüdür.
     * Stale fact default olarak coder context'ine girmemelidir.
     */
    if (role === "coder" && view.includedFacts.some((fact) => fact.kind === "stale")) {
      failures.push("Coder view should not include stale facts by default.");
    }

    /**
     * Planner da execution role değildir ama task planlarken stale authority'ye
     * yaslanmamalıdır.
     */
    if (role === "planner" && view.includedFacts.some((fact) => fact.kind === "stale")) {
      failures.push("Planner view should not include stale facts by default.");
    }

    /**
     * Verifier ve merge, stale/sensitive sinyalleri görebilir.
     * Ama bunlar raw secret olarak değil sanitize edilmiş boundary sinyali olarak gelir.
     */
    if ((role === "verifier" || role === "merge") && view.includedFacts.length === 0) {
      failures.push(`Role ${role} should include at least one fact for verification trace.`);
    }
  }

  return failures;
}

function summarizeView(view: ComposedRoleView): Record<string, unknown> {
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
    includedFactKinds: countFactsByKind(view.includedFacts),
    excludedFactKinds: countFactsByKind(view.excludedFacts),
    sensitiveExclusionCount: view.sensitiveExclusions.length,
    staleExclusionCount: view.staleExclusions.length,
    warnings: view.warnings
  };
}

function countFactsByKind(
  facts: Array<{
    kind: ContextFactKind;
  }>
): Record<ContextFactKind, number> {
  const counts: Record<ContextFactKind, number> = {
    current: 0,
    stale: 0,
    correction: 0,
    sensitive: 0,
    uncertain: 0
  };

  for (const fact of facts) {
    counts[fact.kind] += 1;
  }

  return counts;
}