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

export type OrchestrationStepTrace = {
  id: OrchestrationStepId;
  role: WorkspaceRole;
  status: OrchestrationStepStatus;
  decision?: WorkspaceDecision;
  summary: string;
  startedAt: string;
  finishedAt: string;
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

export type OrchestrationRunResult = {
  flowId: OrchestrationFlowId;
  workspace: SharedSemanticWorkspace;
  decision: WorkspaceDecision;
  remaskTriggered: boolean;
  steps: OrchestrationStepTrace[];
  tokenSummary: OrchestrationTokenSummary;
};

export type RunMockOrchestrationOptions = {
  flowId?: OrchestrationFlowId;
};

/**
 * Agent Orchestrator v1'in deterministic mock versiyonu.
 *
 * Bu gerçek model çağırmaz.
 * Ama ürün runtime akışını test eder:
 *
 * planner view
 * -> coder view
 * -> verifier decision
 * -> remask optional
 * -> merge
 * -> final result
 *
 * Amaç model kalitesi ölçmek değil, workspace + bounded working memory +
 * verifier/remask/merge flow'unun izlenebilir şekilde çalıştığını göstermektir.
 */
export function runMockOrchestrationFlow(
  workspace: SharedSemanticWorkspace,
  options: RunMockOrchestrationOptions = {}
): OrchestrationRunResult {
  const flowId = options.flowId ?? "mock_workspace_verifier_remask_v1";
  const steps: OrchestrationStepTrace[] = [];
  let refined = workspace;

  const plannerView = composeRoleView(refined, "planner");
  steps.push(
    createStepTrace(
      "planner",
      "planner",
      plannerView,
      "Planner produced a bounded task plan from role-specific working memory."
    )
  );

  const coderView = composeRoleView(refined, "coder");
  steps.push(
    createStepTrace(
      "coder",
      "coder",
      coderView,
      "Coder produced a bounded patch proposal from allowed context."
    )
  );

  const verifierView = composeRoleView(refined, "verifier");
  const verifierDecision = decideFromVerifierView(refined, verifierView);
  const failedRegions = failedRegionsForDecision(verifierDecision);

  refined = addVerifierResult(refined, {
    id: `verifier-${refined.id}-orchestrator-v1`,
    status: verifierDecision === "approve" ? "pass" : "fail",
    decision: verifierDecision,
    checkName: "mock-orchestrator-verifier",
    summary: createVerifierSummary(verifierDecision, verifierView),
    findings:
      verifierDecision === "approve"
        ? []
        : [
            {
              id: `finding-${refined.id}-orchestrator-${verifierDecision}`,
              severity: verifierDecision === "reject" ? "error" : "warning",
              category: categoryForDecision(verifierDecision),
              message: createFindingMessage(verifierDecision, verifierView),
              files: refined.scope.changedFiles,
              suggestedAction: verifierDecision
            }
          ],
    checkedFiles: refined.scope.changedFiles,
    evidenceIds: verifierView.includedFacts
      .map((fact) => fact.evidenceId)
      .filter((evidenceId) => evidenceId.length > 0),
    failedRegions,
    createdBy: "verifier",
    createdAt: new Date().toISOString()
  });

  steps.push(
    createStepTrace(
      "verifier",
      "verifier",
      verifierView,
      "Verifier checked authority, policy, stale facts, and bounded context sufficiency.",
      verifierDecision
    )
  );

  const remaskTriggered = verifierDecision === "remask_required";

  if (remaskTriggered) {
    const remaskView = composeRoleView(refined, "remask");

    steps.push(
      createStepTrace(
        "remask",
        "remask",
        remaskView,
        "Remask repair step was triggered for failed local regions.",
        "remask_required"
      )
    );
  } else {
    const remaskView = composeRoleView(refined, "remask");

    steps.push(
      createStepTrace(
        "remask",
        "remask",
        remaskView,
        "Remask step skipped because verifier did not request local repair.",
        verifierDecision,
        "skipped"
      )
    );
  }

  const mergeView = composeRoleView(refined, "merge");
  const finalDecision = finalDecisionFromFlow(verifierDecision);

  steps.push(
    createStepTrace(
      "merge",
      "merge",
      mergeView,
      "Merge step produced final runtime decision from verifier and optional remask state.",
      finalDecision
    )
  );

  refined = setFinalResult(refined, {
    summary: createFinalSummary(finalDecision, remaskTriggered),
    createdBy: "merge",
    createdAt: new Date().toISOString()
  });

  const finalView = composeRoleView(refined, "merge");

  steps.push(
    createStepTrace(
      "final",
      "merge",
      finalView,
      "Final trace was written to workspace.",
      finalDecision
    )
  );

  return {
    flowId,
    workspace: refined,
    decision: finalDecision,
    remaskTriggered,
    steps,
    tokenSummary: summarizeTokens(steps)
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

  /**
   * Remask-required senaryolarında verifier stale ve correction/current sinyali
   * birlikte görür. Bu, active output'un stale authority'ye yaslanma riski taşıdığı
   * anlamına gelir.
   *
   * Planner/coder stale fact'i görmez; verifier ise stale'i görmek zorundadır.
   * Bu durumda full flow'u approve etmek yerine lokal repair/remask istemek
   * daha doğru ürün davranışıdır.
   */
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
  /**
   * Mock v1'de remask_required gerçek repair yapmaz.
   * Bu yüzden final decision'ı approve'a çevirmiyoruz.
   *
   * İleride Remask Engine v1 gerçek repair ürettiğinde:
   * remask_required -> remask repair -> verifier pass -> approve
   * akışı burada modellenebilir.
   */
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
  id: OrchestrationStepId,
  role: WorkspaceRole,
  view: ComposedRoleView,
  summary: string,
  decision?: WorkspaceDecision,
  status: OrchestrationStepStatus = "completed"
): OrchestrationStepTrace {
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();

  return {
    id,
    role,
    status,
    decision,
    summary,
    startedAt,
    finishedAt,
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