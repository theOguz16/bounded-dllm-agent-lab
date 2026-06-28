import {
  composeRoleView,
  type ComposedRoleView
} from "../../context-core/src/index.js";
import {
  addVerifierResult,
  setFinalResult,
  type SharedSemanticWorkspace,
  type WorkspaceDecision,
  type WorkspaceRegion,
  type WorkspaceRole
} from "../../workspace-core/src/index.js";

export type OrchestrationFlowId = "mock_workspace_verifier_remask_v1";

export type OrchestrationStepId =
  | "planner"
  | "coder"
  | "verifier"
  | "remask"
  | "merge"
  | "final";

export type OrchestrationStepStatus = "completed" | "skipped";

export type OrchestrationFlowStepDefinition = {
  id: OrchestrationStepId;
  role: WorkspaceRole;

  /**
   * Bu step'in workspace'te okumasına izin verilen semantic region'lar.
   */
  reads: WorkspaceRegion[];

  /**
   * Bu step'in workspace'e yazmasına izin verilen semantic region'lar.
   * Permission guard bu alanı enforce eder.
   */
  writes: WorkspaceRegion[];

  /**
   * Optional step ise trigger gelmeden skipped olabilir.
   */
  optional: boolean;

  /**
   * Optional step'in hangi decision ile tetikleneceği.
   */
  trigger?: WorkspaceDecision;

  description: string;
};

export type OrchestrationFlowDefinition = {
  id: OrchestrationFlowId;
  label: string;
  description: string;
  steps: OrchestrationFlowStepDefinition[];
};

export type OrchestrationPermissionCheck = {
  ok: boolean;
  stepId: OrchestrationStepId;
  role: WorkspaceRole;
  region: WorkspaceRegion;
  allowedWrites: WorkspaceRegion[];
  reason: string;
};

export type OrchestrationMutationStatus = "applied" | "blocked";

export type OrchestrationMutationEvent = {
  id: string;
  stepId: OrchestrationStepId;
  role: WorkspaceRole;
  region: WorkspaceRegion;
  action: "write";
  status: OrchestrationMutationStatus;
  permissionCheck: OrchestrationPermissionCheck;
  summary: string;
  createdAt: string;
};

export type OrchestrationStepTrace = {
  id: OrchestrationStepId;
  role: WorkspaceRole;
  status: OrchestrationStepStatus;
  decision?: WorkspaceDecision;
  summary: string;
  startedAt: string;
  finishedAt: string;

  /**
   * Flow definition'dan gelen permission contract trace'i.
   */
  reads: WorkspaceRegion[];
  writes: WorkspaceRegion[];
  optional: boolean;
  trigger?: WorkspaceDecision;

  /**
   * Bu step içinde denenen workspace write region kontrolleri.
   */
  writeChecks: OrchestrationPermissionCheck[];

  /**
   * Bu step'in ürettiği workspace mutation event'leri.
   * Şu an gerçek patch_plan/patch_draft yazımı mock; ama mutation trace ürün
   * contract'ını başlatıyor.
   */
  mutations: OrchestrationMutationEvent[];

  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  sufficiency: string;
  warnings: string[];
  includedRegionCount: number;
  excludedRegionCount: number;
  includedFactCount: number;
  excludedFactCount: number;
};

export type OrchestrationTokenSummary = {
  totalEstimatedTokens: number;
  totalBudgetTokens: number;
  averageBudgetUtilization: number;
  maxEstimatedTokens: number;
};

export type OrchestrationMutationSummary = {
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  mutatedRegions: WorkspaceRegion[];
};

export type OrchestrationRunResult = {
  flowId: OrchestrationFlowId;
  flow: OrchestrationFlowDefinition;
  workspace: SharedSemanticWorkspace;
  decision: WorkspaceDecision;
  remaskTriggered: boolean;
  steps: OrchestrationStepTrace[];
  mutations: OrchestrationMutationEvent[];
  tokenSummary: OrchestrationTokenSummary;
  mutationSummary: OrchestrationMutationSummary;
};

export type RunMockOrchestrationOptions = {
  flow?: OrchestrationFlowDefinition;
};

export const mockWorkspaceVerifierRemaskFlow: OrchestrationFlowDefinition = {
  id: "mock_workspace_verifier_remask_v1",
  label: "Mock Workspace + Verifier + Remask Flow",
  description:
    "Deterministic bounded workspace orchestration flow with planner, coder, verifier, optional remask, merge, and final trace.",
  steps: [
    {
      id: "planner",
      role: "planner",
      reads: ["task", "scope", "authority", "policy", "repo_facts", "patch_intent"],
      writes: ["patch_plan", "claim"],
      optional: false,
      description: "Planner creates a bounded patch plan from task, scope, authority, and policy."
    },
    {
      id: "coder",
      role: "coder",
      reads: ["task", "scope", "authority", "policy", "repo_facts", "patch_intent", "patch_plan"],
      writes: ["patch_draft", "claim"],
      optional: false,
      description: "Coder creates a bounded patch draft from the plan and allowed workspace context."
    },
    {
      id: "verifier",
      role: "verifier",
      reads: [
        "task",
        "scope",
        "authority",
        "policy",
        "repo_facts",
        "patch_intent",
        "claim",
        "patch_plan",
        "patch_draft",
        "verifier_result"
      ],
      writes: ["verifier_result", "remask_request"],
      optional: false,
      description: "Verifier checks authority, policy, stale facts, sensitive boundaries, and remask need."
    },
    {
      id: "remask",
      role: "remask",
      reads: ["task", "scope", "authority", "policy", "patch_draft", "verifier_result", "remask_request"],
      writes: ["patch_draft", "remask_request", "claim"],
      optional: true,
      trigger: "remask_required",
      description: "Remask step repairs only the failed local region if verifier requests remask."
    },
    {
      id: "merge",
      role: "merge",
      reads: [
        "task",
        "scope",
        "authority",
        "policy",
        "claim",
        "patch_plan",
        "patch_draft",
        "verifier_result",
        "test_signal",
        "conflict",
        "merge_decision"
      ],
      writes: ["merge_decision", "conflict", "final_result"],
      optional: false,
      description: "Merge step converts verifier/remask state into final runtime decision."
    },
    {
      id: "final",
      role: "merge",
      reads: ["merge_decision", "final_result", "verifier_result", "conflict"],
      writes: ["final_result"],
      optional: false,
      description: "Final step writes the traceable final result."
    }
  ]
};

export function validateStepWrite(
  stepDefinition: OrchestrationFlowStepDefinition,
  region: WorkspaceRegion
): OrchestrationPermissionCheck {
  const ok = stepDefinition.writes.includes(region);

  return {
    ok,
    stepId: stepDefinition.id,
    role: stepDefinition.role,
    region,
    allowedWrites: stepDefinition.writes,
    reason: ok
      ? `${stepDefinition.id} can write ${region}.`
      : `${stepDefinition.id} cannot write ${region}; allowed writes are ${stepDefinition.writes.join(", ")}.`
  };
}

export function assertStepCanWrite(
  stepDefinition: OrchestrationFlowStepDefinition,
  region: WorkspaceRegion
): OrchestrationPermissionCheck {
  const check = validateStepWrite(stepDefinition, region);

  if (!check.ok) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Orchestration step attempted to write outside its allowed regions.",
          check
        },
        null,
        2
      )
    );
  }

  return check;
}

export function createMutationEvent(
  stepDefinition: OrchestrationFlowStepDefinition,
  region: WorkspaceRegion,
  summary: string
): OrchestrationMutationEvent {
  const permissionCheck = validateStepWrite(stepDefinition, region);

  return {
    id: `mutation-${stepDefinition.id}-${region}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stepId: stepDefinition.id,
    role: stepDefinition.role,
    region,
    action: "write",
    status: permissionCheck.ok ? "applied" : "blocked",
    permissionCheck,
    summary,
    createdAt: new Date().toISOString()
  };
}

export function createAllowedMutationEvent(
  stepDefinition: OrchestrationFlowStepDefinition,
  region: WorkspaceRegion,
  summary: string
): OrchestrationMutationEvent {
  const mutation = createMutationEvent(stepDefinition, region, summary);

  if (mutation.status === "blocked") {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Blocked mutation cannot be applied.",
          mutation
        },
        null,
        2
      )
    );
  }

  return mutation;
}

export function validateFlowDefinition(flow: OrchestrationFlowDefinition): string[] {
  const failures: string[] = [];
  const seen = new Set<OrchestrationStepId>();

  if (flow.steps.length === 0) {
    failures.push(`Flow ${flow.id} has no steps.`);
  }

  for (const step of flow.steps) {
    if (seen.has(step.id)) {
      failures.push(`Duplicate step id: ${step.id}.`);
    }

    seen.add(step.id);

    if (step.reads.length === 0) {
      failures.push(`Step ${step.id} has no read regions.`);
    }

    if (step.writes.length === 0) {
      failures.push(`Step ${step.id} has no write regions.`);
    }

    if (step.optional && !step.trigger) {
      failures.push(`Optional step ${step.id} must define a trigger.`);
    }

    if (!step.optional && step.trigger) {
      failures.push(`Non-optional step ${step.id} should not define a trigger.`);
    }
  }

  return failures;
}

export function runMockOrchestrationFlow(
  workspace: SharedSemanticWorkspace,
  options: RunMockOrchestrationOptions = {}
): OrchestrationRunResult {
  const flow = options.flow ?? mockWorkspaceVerifierRemaskFlow;
  const flowFailures = validateFlowDefinition(flow);

  if (flowFailures.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Invalid orchestration flow definition.",
          flowId: flow.id,
          flowFailures
        },
        null,
        2
      )
    );
  }

  const steps: OrchestrationStepTrace[] = [];
  let refined = workspace;
  let verifierDecision: WorkspaceDecision = "approve";
  let remaskTriggered = false;

  for (const stepDefinition of flow.steps) {
    const view = composeRoleView(refined, stepDefinition.role);

    if (stepDefinition.optional && stepDefinition.trigger !== verifierDecision) {
      steps.push(
        createStepTrace(
          stepDefinition,
          view,
          `${stepDefinition.description} Skipped because trigger ${stepDefinition.trigger ?? "none"} did not match decision ${verifierDecision}.`,
          verifierDecision,
          "skipped"
        )
      );
      continue;
    }

    switch (stepDefinition.id) {
      case "planner": {
        const mutations = [
          createAllowedMutationEvent(stepDefinition, "patch_plan", "Planner wrote bounded patch_plan intent."),
          createAllowedMutationEvent(stepDefinition, "claim", "Planner wrote planning claim trace.")
        ];

        steps.push(
          createStepTrace(
            stepDefinition,
            view,
            "Planner produced a bounded task plan from role-specific working memory.",
            undefined,
            "completed",
            mutations
          )
        );
        break;
      }

      case "coder": {
        const mutations = [
          createAllowedMutationEvent(stepDefinition, "patch_draft", "Coder wrote bounded patch_draft proposal."),
          createAllowedMutationEvent(stepDefinition, "claim", "Coder wrote implementation claim trace.")
        ];

        steps.push(
          createStepTrace(
            stepDefinition,
            view,
            "Coder produced a bounded patch proposal from allowed context.",
            undefined,
            "completed",
            mutations
          )
        );
        break;
      }

      case "verifier": {
        verifierDecision = decideFromVerifierView(refined, view);
        const failedRegions = failedRegionsForDecision(verifierDecision);

        const mutations = [
          createAllowedMutationEvent(stepDefinition, "verifier_result", "Verifier wrote verifier_result.")
        ];

        if (verifierDecision === "remask_required") {
          mutations.push(
            createAllowedMutationEvent(stepDefinition, "remask_request", "Verifier wrote remask_request.")
          );
        }

        refined = addVerifierResult(refined, {
          id: `verifier-${refined.id}-orchestrator-v1`,
          status: verifierDecision === "approve" ? "pass" : "fail",
          decision: verifierDecision,
          checkName: "mock-orchestrator-verifier",
          summary: createVerifierSummary(verifierDecision, view),
          findings:
            verifierDecision === "approve"
              ? []
              : [
                  {
                    id: `finding-${refined.id}-orchestrator-${verifierDecision}`,
                    severity: verifierDecision === "reject" ? "error" : "warning",
                    category: categoryForDecision(verifierDecision),
                    message: createFindingMessage(verifierDecision, view),
                    files: refined.scope.changedFiles,
                    suggestedAction: verifierDecision
                  }
                ],
          checkedFiles: refined.scope.changedFiles,
          evidenceIds: view.includedFacts
            .map((fact) => fact.evidenceId)
            .filter((evidenceId) => evidenceId.length > 0),
          failedRegions,
          createdBy: "verifier",
          createdAt: new Date().toISOString()
        });

        steps.push(
          createStepTrace(
            stepDefinition,
            view,
            "Verifier checked authority, policy, stale facts, and bounded context sufficiency.",
            verifierDecision,
            "completed",
            mutations
          )
        );
        break;
      }

      case "remask": {
        remaskTriggered = true;

        const mutations = [
          createAllowedMutationEvent(stepDefinition, "patch_draft", "Remask wrote repaired local patch_draft."),
          createAllowedMutationEvent(stepDefinition, "remask_request", "Remask updated remask_request state."),
          createAllowedMutationEvent(stepDefinition, "claim", "Remask wrote repair claim trace.")
        ];

        steps.push(
          createStepTrace(
            stepDefinition,
            view,
            "Remask repair step was triggered for failed local regions.",
            verifierDecision,
            "completed",
            mutations
          )
        );
        break;
      }

      case "merge": {
        const finalDecision = finalDecisionFromFlow(verifierDecision);

        const mutations = [
          createAllowedMutationEvent(stepDefinition, "merge_decision", "Merge wrote merge_decision."),
          createAllowedMutationEvent(stepDefinition, "conflict", "Merge wrote conflict reconciliation trace.")
        ];

        steps.push(
          createStepTrace(
            stepDefinition,
            view,
            "Merge step produced final runtime decision from verifier and optional remask state.",
            finalDecision,
            "completed",
            mutations
          )
        );
        break;
      }

      case "final": {
        const finalDecision = finalDecisionFromFlow(verifierDecision);

        const mutations = [
          createAllowedMutationEvent(stepDefinition, "final_result", "Final step wrote final_result.")
        ];

        refined = setFinalResult(refined, {
          summary: createFinalSummary(finalDecision, remaskTriggered),
          createdBy: "merge",
          createdAt: new Date().toISOString()
        });

        const finalView = composeRoleView(refined, stepDefinition.role);

        steps.push(
          createStepTrace(
            stepDefinition,
            finalView,
            "Final trace was written to workspace.",
            finalDecision,
            "completed",
            mutations
          )
        );
        break;
      }
    }
  }

  const decision = finalDecisionFromFlow(verifierDecision);
  const mutations = steps.flatMap((step) => step.mutations);

  return {
    flowId: flow.id,
    flow,
    workspace: refined,
    decision,
    remaskTriggered,
    steps,
    mutations,
    tokenSummary: summarizeTokens(steps),
    mutationSummary: summarizeMutations(mutations)
  };
}

function decideFromVerifierView(
  workspace: SharedSemanticWorkspace,
  verifierView: ComposedRoleView
): WorkspaceDecision {
  if (hasSensitiveRisk(verifierView)) {
    return "reject";
  }

  if (workspace.authority.missingRules.some((rule) => rule.toLowerCase().includes("missing"))) {
    return "remask_required";
  }

  if (hasStaleAuthorityConflict(verifierView)) {
    return "remask_required";
  }

  if (verifierView.sufficiency === "insufficient") {
    return "human_review_required";
  }

  if (verifierView.sufficiency === "risky") {
    return "human_review_required";
  }

  return "approve";
}

function hasSensitiveRisk(verifierView: ComposedRoleView): boolean {
  return verifierView.includedFacts.some((fact) => fact.kind === "sensitive");
}

function hasStaleAuthorityConflict(verifierView: ComposedRoleView): boolean {
  const hasStaleFact = verifierView.includedFacts.some((fact) => fact.kind === "stale");
  const hasCurrentOrCorrectionFact = verifierView.includedFacts.some(
    (fact) => fact.kind === "current" || fact.kind === "correction"
  );

  return hasStaleFact && hasCurrentOrCorrectionFact;
}

function failedRegionsForDecision(decision: WorkspaceDecision): WorkspaceRegion[] {
  if (decision === "approve") {
    return [];
  }

  if (decision === "remask_required") {
    return ["final_result"];
  }

  if (decision === "reject") {
    return ["policy", "final_result"];
  }

  return ["authority", "final_result"];
}

function finalDecisionFromFlow(decision: WorkspaceDecision): WorkspaceDecision {
  return decision;
}

function createVerifierSummary(
  decision: WorkspaceDecision,
  verifierView: ComposedRoleView
): string {
  if (decision === "approve") {
    return "Verifier approved the bounded mock patch flow.";
  }

  if (decision === "remask_required" && hasStaleAuthorityConflict(verifierView)) {
    return "Verifier detected stale authority conflict and requested local remask repair.";
  }

  if (decision === "reject") {
    return "Verifier rejected the flow because sensitive boundary risk was present.";
  }

  return "Verifier detected that the bounded mock patch flow requires repair or human review.";
}

function createFindingMessage(
  decision: WorkspaceDecision,
  verifierView: ComposedRoleView
): string {
  if (decision === "remask_required" && hasStaleAuthorityConflict(verifierView)) {
    return "Verifier saw both stale and current/correction authority facts; final_result should be locally remasked.";
  }

  if (decision === "reject") {
    return "Verifier detected sensitive boundary risk.";
  }

  if (decision === "human_review_required") {
    return "Verifier marked the bounded context as risky or insufficient.";
  }

  return `Verifier decision was ${decision}.`;
}

function categoryForDecision(
  decision: WorkspaceDecision
):
  | "scope"
  | "authority"
  | "test"
  | "ownership"
  | "module_boundary"
  | "sensitive_boundary"
  | "paired_file"
  | "trace"
  | "verifier_adapter"
  | "merge_safety" {
  if (decision === "reject") {
    return "sensitive_boundary";
  }

  if (decision === "human_review_required") {
    return "trace";
  }

  return "authority";
}

function createStepTrace(
  stepDefinition: OrchestrationFlowStepDefinition,
  view: ComposedRoleView,
  summary: string,
  decision?: WorkspaceDecision,
  status: OrchestrationStepStatus = "completed",
  mutations: OrchestrationMutationEvent[] = []
): OrchestrationStepTrace {
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();

  return {
    id: stepDefinition.id,
    role: stepDefinition.role,
    status,
    decision,
    summary,
    startedAt,
    finishedAt,
    reads: stepDefinition.reads,
    writes: stepDefinition.writes,
    optional: stepDefinition.optional,
    trigger: stepDefinition.trigger,
    writeChecks: mutations.map((mutation) => mutation.permissionCheck),
    mutations,
    estimatedTokens: view.estimatedTokens,
    budgetTokens: view.budgetTokens,
    budgetUtilization: view.budgetUtilization,
    sufficiency: view.sufficiency,
    warnings: view.warnings,
    includedRegionCount: view.includedRegions.length,
    excludedRegionCount: view.excludedRegions.length,
    includedFactCount: view.includedFacts.length,
    excludedFactCount: view.excludedFacts.length
  };
}

function summarizeTokens(steps: OrchestrationStepTrace[]): OrchestrationTokenSummary {
  const totalEstimatedTokens = steps.reduce((sum, step) => sum + step.estimatedTokens, 0);
  const totalBudgetTokens = steps.reduce((sum, step) => sum + step.budgetTokens, 0);
  const totalBudgetUtilization = steps.reduce((sum, step) => sum + step.budgetUtilization, 0);

  return {
    totalEstimatedTokens,
    totalBudgetTokens,
    averageBudgetUtilization: roundRatio(totalBudgetUtilization / Math.max(steps.length, 1)),
    maxEstimatedTokens: Math.max(0, ...steps.map((step) => step.estimatedTokens))
  };
}

function summarizeMutations(mutations: OrchestrationMutationEvent[]): OrchestrationMutationSummary {
  const mutatedRegions = [...new Set(mutations.map((mutation) => mutation.region))];

  return {
    totalMutations: mutations.length,
    appliedMutations: mutations.filter((mutation) => mutation.status === "applied").length,
    blockedMutations: mutations.filter((mutation) => mutation.status === "blocked").length,
    mutatedRegions
  };
}

function createFinalSummary(
  decision: WorkspaceDecision,
  remaskTriggered: boolean
): string {
  return JSON.stringify({
    decision,
    remaskTriggered,
    summary: "Mock orchestration flow completed with bounded role views and verifier-controlled decision."
  });
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}