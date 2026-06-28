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
        reason: "Fixture validation failed before orchestrator smoke.",
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
        reason: "No fixture found for orchestrator smoke."
      },
      null,
      2
    )
  );
}

const workspace = createWorkspaceFromPacket(fixture.packet, {
  id: `orchestrator-smoke-${fixture.case.id}`
});

const result = runMockOrchestrationFlow(workspace);

const failures = validateResult(result);

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Orchestrator smoke failed.",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
        failures,
        result: summarizeResult(result)
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
      smokeName: "orchestrator-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      result: summarizeResult(result)
    },
    null,
    2
  )
);

function validateResult(result: ReturnType<typeof runMockOrchestrationFlow>): string[] {
  const failures: string[] = [];
  const expectedSteps = ["planner", "coder", "verifier", "remask", "merge", "final"];

  if (result.steps.length !== expectedSteps.length) {
    failures.push(`Expected ${expectedSteps.length} step(s), got ${result.steps.length}.`);
  }

  for (const step of expectedSteps) {
    if (!result.steps.some((item) => item.id === step)) {
      failures.push(`Missing orchestration step: ${step}.`);
    }
  }

  if (result.tokenSummary.totalEstimatedTokens <= 0) {
    failures.push("Total estimated tokens must be greater than zero.");
  }

  if (!result.workspace.finalResult) {
    failures.push("Workspace finalResult should be written by orchestrator.");
  }

  if (result.workspace.verifierResults.length === 0) {
    failures.push("Workspace should contain at least one verifier result.");
  }

  return failures;
}

function summarizeResult(result: ReturnType<typeof runMockOrchestrationFlow>): Record<string, unknown> {
  return {
    flowId: result.flowId,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    tokenSummary: result.tokenSummary,
    steps: result.steps.map((step) => ({
      id: step.id,
      role: step.role,
      status: step.status,
      decision: step.decision,
      sufficiency: step.sufficiency,
      estimatedTokens: step.estimatedTokens,
      budgetTokens: step.budgetTokens,
      budgetUtilization: step.budgetUtilization,
      includedFactCount: step.includedFactCount,
      excludedFactCount: step.excludedFactCount,
      warningCount: step.warnings.length
    })),
    finalResult: result.workspace.finalResult?.summary ?? null,
    verifierResultCount: result.workspace.verifierResults.length
  };
}