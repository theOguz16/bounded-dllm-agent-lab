import { evaluateConflictAwareMerge } from "../../../packages/merge-core/src/index.js";
import { runMockOrchestrationFlow } from "../../../packages/orchestration-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before conflict-aware merge smoke.",
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
        reason: "No fixture found for conflict-aware merge smoke."
      },
      null,
      2
    )
  );
}

const workspace = createWorkspaceFromPacket(fixture.packet, {
  id: `conflict-aware-merge-smoke-${fixture.case.id}`
});

const orchestrationResult = runMockOrchestrationFlow(workspace);
const mergeResult = evaluateConflictAwareMerge(orchestrationResult);

const failures = validateMergeResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Conflict-aware merge smoke failed.",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
        failures,
        orchestrationDecision: orchestrationResult.decision,
        mergeResult
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
      smokeName: "conflict-aware-merge-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      orchestrationDecision: orchestrationResult.decision,
      mergeResult
    },
    null,
    2
  )
);

function validateMergeResult(): string[] {
  const failures: string[] = [];

  if (mergeResult.decision !== "remask_required") {
    failures.push(`Expected merge decision remask_required, got ${mergeResult.decision}.`);
  }

  if (mergeResult.mergeSafe) {
    failures.push("Merge should not be marked safe while remask is unresolved.");
  }

  if (mergeResult.conflicts.length === 0) {
    failures.push("Expected at least one merge conflict.");
  }

  if (!mergeResult.conflicts.some((conflict) => conflict.kind === "stale_authority")) {
    failures.push("Expected stale_authority conflict.");
  }

  if (!mergeResult.conflicts.some((conflict) => conflict.kind === "remask_unresolved")) {
    failures.push("Expected remask_unresolved conflict.");
  }

  if (mergeResult.evidence.blockedMutations !== 0) {
    failures.push(`Expected zero blocked mutations, got ${mergeResult.evidence.blockedMutations}.`);
  }

  if (mergeResult.requiredActions.length === 0) {
    failures.push("Expected requiredActions for unresolved remask.");
  }

  return failures;
}