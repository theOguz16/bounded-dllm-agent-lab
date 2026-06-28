import {
  assertStepCanWrite,
  createMutationEvent,
  runMockOrchestrationFlow,
  validateStepWrite,
  type OrchestrationStepId
} from "../../../packages/orchestration-core/src/index.js";
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
  const expectedSteps: OrchestrationStepId[] = ["planner", "coder", "verifier", "remask", "merge", "final"];

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

  if (result.mutationSummary.totalMutations <= 0) {
    failures.push("Total mutations must be greater than zero.");
  }

  if (result.mutationSummary.blockedMutations !== 0) {
    failures.push(`Expected zero blocked runtime mutations, got ${result.mutationSummary.blockedMutations}.`);
  }

  if (!result.workspace.finalResult) {
    failures.push("Workspace finalResult should be written by orchestrator.");
  }

  if (result.workspace.verifierResults.length === 0) {
    failures.push("Workspace should contain at least one verifier result.");
  }

  if (result.decision !== "remask_required") {
    failures.push(`Expected remask_required decision for remask fixture, got ${result.decision}.`);
  }

  if (!result.remaskTriggered) {
    failures.push("Expected remaskTriggered to be true for remask fixture.");
  }

  failures.push(...validatePermissionGuard(result));
  failures.push(...validateMutationTrace(result));

  return failures;
}

function validatePermissionGuard(result: ReturnType<typeof runMockOrchestrationFlow>): string[] {
  const failures: string[] = [];

  const planner = getStepDefinition(result, "planner");
  const verifier = getStepDefinition(result, "verifier");
  const merge = getStepDefinition(result, "merge");

  /**
   * Positive permission checks.
   */
  assertStepCanWrite(verifier, "verifier_result");
  assertStepCanWrite(merge, "final_result");

  /**
   * Negative permission checks.
   * Bunlar throw etmemeli; validateStepWrite ok:false dönmeli.
   */
  const verifierFinalResult = validateStepWrite(verifier, "final_result");
  const plannerVerifierResult = validateStepWrite(planner, "verifier_result");

  if (verifierFinalResult.ok) {
    failures.push("Verifier should not be allowed to write final_result.");
  }

  if (plannerVerifierResult.ok) {
    failures.push("Planner should not be allowed to write verifier_result.");
  }

  /**
   * Blocked mutation event üretilebilmeli ama runtime applied mutation listesine
   * girmemeli. Bu product guard'ın debug için de sinyal verebildiğini gösterir.
   */
  const blockedMutation = createMutationEvent(verifier, "final_result", "Verifier attempted illegal final_result write.");

  if (blockedMutation.status !== "blocked") {
    failures.push("Illegal verifier final_result mutation should be blocked.");
  }

  return failures;
}

function validateMutationTrace(result: ReturnType<typeof runMockOrchestrationFlow>): string[] {
  const failures: string[] = [];

  const mutationCountFromSteps = result.steps.reduce(
    (sum, step) => sum + step.mutations.length,
    0
  );

  if (mutationCountFromSteps !== result.mutations.length) {
    failures.push(
      `Mutation count mismatch: steps=${mutationCountFromSteps}, result=${result.mutations.length}.`
    );
  }

  for (const step of result.steps) {
    if (step.status === "completed" && step.mutations.length === 0) {
      failures.push(`Completed step ${step.id} should have at least one mutation event.`);
    }

    for (const mutation of step.mutations) {
      if (mutation.status !== "applied") {
        failures.push(`Runtime mutation should be applied, got ${mutation.status} for ${mutation.id}.`);
      }

      if (!mutation.permissionCheck.ok) {
        failures.push(`Runtime mutation has failed permission check: ${mutation.permissionCheck.reason}`);
      }

      if (!step.writes.includes(mutation.region)) {
        failures.push(`Step ${step.id} mutation region ${mutation.region} is not in writes contract.`);
      }
    }
  }

  return failures;
}

function getStepDefinition(
  result: ReturnType<typeof runMockOrchestrationFlow>,
  id: OrchestrationStepId
) {
  const step = result.flow.steps.find((item) => item.id === id);

  if (!step) {
    throw new Error(`Missing flow step definition: ${id}`);
  }

  return step;
}

function summarizeResult(result: ReturnType<typeof runMockOrchestrationFlow>): Record<string, unknown> {
  return {
    flowId: result.flowId,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    tokenSummary: result.tokenSummary,
    mutationSummary: result.mutationSummary,
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
      warningCount: step.warnings.length,
      reads: step.reads,
      writes: step.writes,
      writeCheckCount: step.writeChecks.length,
      mutationCount: step.mutations.length,
      mutatedRegions: step.mutations.map((mutation) => mutation.region)
    })),
    finalResult: result.workspace.finalResult?.summary ?? null,
    verifierResultCount: result.workspace.verifierResults.length
  };
}