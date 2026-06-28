import type {
  OrchestrationMutationEvent,
  OrchestrationRunResult
} from "../../orchestration-core/src/index.js";
import type {
  WorkspaceDecision,
  WorkspaceFindingSeverity
} from "../../workspace-core/src/index.js";

export type MergeConflictKind =
  | "stale_authority"
  | "sensitive_boundary"
  | "permission_violation"
  | "blocked_mutation"
  | "insufficient_context"
  | "remask_unresolved"
  | "verifier_rejection"
  | "human_review_needed";

export type MergeConflictSeverity = WorkspaceFindingSeverity;

export type MergeConflict = {
  id: string;
  kind: MergeConflictKind;
  severity: MergeConflictSeverity;
  message: string;
  sourceStepIds: string[];
  evidenceIds: string[];
  suggestedDecision: WorkspaceDecision;
};

export type ConflictAwareMergeResult = {
  decision: WorkspaceDecision;
  mergeSafe: boolean;
  conflicts: MergeConflict[];
  reasons: string[];
  requiredActions: string[];
  evidence: {
    flowId: string;
    verifierDecisions: WorkspaceDecision[];
    remaskTriggered: boolean;
    totalMutations: number;
    appliedMutations: number;
    blockedMutations: number;
    mutatedRegions: string[];
  };
};

/**
 * Conflict-Aware Merge v1.
 *
 * Bu fonksiyon gerçek kod merge etmez.
 * Orchestration sonucundaki verifier result, mutation trace, permission state ve
 * remask state üzerinden final merge kararını yorumlar.
 *
 * Amaç:
 * - verifier "approve" demiş olsa bile permission/mutation conflict var mı görmek,
 * - remask_required ise bunu final approve'a çevirmemek,
 * - sensitive veya blocked mutation varsa merge'i güvenli saymamak,
 * - kararın nedenini trace edilebilir hale getirmek.
 */
export function evaluateConflictAwareMerge(
  result: OrchestrationRunResult
): ConflictAwareMergeResult {
  const conflicts = collectMergeConflicts(result);
  const decision = resolveMergeDecision(result, conflicts);

  return {
    decision,
    mergeSafe: decision === "approve" && conflicts.length === 0,
    conflicts,
    reasons: createReasons(result, conflicts, decision),
    requiredActions: createRequiredActions(decision, conflicts),
    evidence: {
      flowId: result.flowId,
      verifierDecisions: result.workspace.verifierResults.map((item) => item.decision),
      remaskTriggered: result.remaskTriggered,
      totalMutations: result.mutationSummary.totalMutations,
      appliedMutations: result.mutationSummary.appliedMutations,
      blockedMutations: result.mutationSummary.blockedMutations,
      mutatedRegions: result.mutationSummary.mutatedRegions
    }
  };
}

function collectMergeConflicts(result: OrchestrationRunResult): MergeConflict[] {
  return compactConflicts([
    ...collectVerifierConflicts(result),
    ...collectMutationConflicts(result),
    ...collectContextConflicts(result),
    ...collectRemaskConflicts(result)
  ]);
}

function collectVerifierConflicts(result: OrchestrationRunResult): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  for (const verifierResult of result.workspace.verifierResults) {
    const sourceStepIds = result.steps
      .filter((step) => step.role === "verifier")
      .map((step) => step.id);

    if (verifierResult.decision === "reject") {
      conflicts.push({
        id: `${verifierResult.id}-reject`,
        kind: "verifier_rejection",
        severity: "error",
        message: verifierResult.summary,
        sourceStepIds,
        evidenceIds: verifierResult.evidenceIds,
        suggestedDecision: "reject"
      });
    }

    if (verifierResult.decision === "human_review_required") {
      conflicts.push({
        id: `${verifierResult.id}-human-review`,
        kind: "human_review_needed",
        severity: "warning",
        message: verifierResult.summary,
        sourceStepIds,
        evidenceIds: verifierResult.evidenceIds,
        suggestedDecision: "human_review_required"
      });
    }

    if (verifierResult.decision === "remask_required") {
      conflicts.push({
        id: `${verifierResult.id}-remask-required`,
        kind: inferRemaskConflictKind(verifierResult.summary),
        severity: "warning",
        message: verifierResult.summary,
        sourceStepIds,
        evidenceIds: verifierResult.evidenceIds,
        suggestedDecision: "remask_required"
      });
    }

    for (const finding of verifierResult.findings) {
      if (finding.category === "sensitive_boundary") {
        conflicts.push({
          id: `${finding.id}-sensitive-boundary`,
          kind: "sensitive_boundary",
          severity: finding.severity,
          message: finding.message,
          sourceStepIds,
          evidenceIds: verifierResult.evidenceIds,
          suggestedDecision: "reject"
        });
      }

      if (finding.category === "authority" && finding.message.toLowerCase().includes("stale")) {
        conflicts.push({
          id: `${finding.id}-stale-authority`,
          kind: "stale_authority",
          severity: finding.severity,
          message: finding.message,
          sourceStepIds,
          evidenceIds: verifierResult.evidenceIds,
          suggestedDecision: "remask_required"
        });
      }
    }
  }

  return conflicts;
}

function collectMutationConflicts(result: OrchestrationRunResult): MergeConflict[] {
  const blockedMutations = result.mutations.filter((mutation) => mutation.status === "blocked");

  return blockedMutations.map((mutation) => ({
    id: `${mutation.id}-blocked`,
    kind: inferBlockedMutationKind(mutation),
    severity: "error",
    message: mutation.permissionCheck.reason,
    sourceStepIds: [mutation.stepId],
    evidenceIds: [],
    suggestedDecision: "reject"
  }));
}

function collectContextConflicts(result: OrchestrationRunResult): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  for (const step of result.steps) {
    if (step.sufficiency === "insufficient") {
      conflicts.push({
        id: `${step.id}-insufficient-context`,
        kind: "insufficient_context",
        severity: "error",
        message: `Step ${step.id} had insufficient bounded context.`,
        sourceStepIds: [step.id],
        evidenceIds: [],
        suggestedDecision: "human_review_required"
      });
    }

    if (step.sufficiency === "risky") {
      conflicts.push({
        id: `${step.id}-risky-context`,
        kind: "insufficient_context",
        severity: "warning",
        message: `Step ${step.id} had risky bounded context.`,
        sourceStepIds: [step.id],
        evidenceIds: [],
        suggestedDecision: "human_review_required"
      });
    }
  }

  return conflicts;
}

function collectRemaskConflicts(result: OrchestrationRunResult): MergeConflict[] {
  if (result.decision !== "remask_required") {
    return [];
  }

  return [
    {
      id: `${result.flowId}-remask-unresolved`,
      kind: "remask_unresolved",
      severity: "warning",
      message:
        "Flow ended with remask_required. Mock remask step was triggered, but no second-pass verifier approval exists yet.",
      sourceStepIds: result.steps
        .filter((step) => step.id === "remask" || step.id === "merge" || step.id === "final")
        .map((step) => step.id),
      evidenceIds: result.workspace.verifierResults.flatMap((item) => item.evidenceIds),
      suggestedDecision: "remask_required"
    }
  ];
}

function resolveMergeDecision(
  result: OrchestrationRunResult,
  conflicts: MergeConflict[]
): WorkspaceDecision {
  if (conflicts.some((conflict) => conflict.suggestedDecision === "reject")) {
    return "reject";
  }

  if (conflicts.some((conflict) => conflict.suggestedDecision === "human_review_required")) {
    return "human_review_required";
  }

  if (conflicts.some((conflict) => conflict.suggestedDecision === "remask_required")) {
    return "remask_required";
  }

  return result.decision;
}

function createReasons(
  result: OrchestrationRunResult,
  conflicts: MergeConflict[],
  decision: WorkspaceDecision
): string[] {
  const reasons: string[] = [];

  reasons.push(`Flow ${result.flowId} produced decision ${result.decision}.`);
  reasons.push(
    `Mutation summary: ${result.mutationSummary.appliedMutations}/${result.mutationSummary.totalMutations} applied, ${result.mutationSummary.blockedMutations} blocked.`
  );

  if (result.remaskTriggered) {
    reasons.push("Verifier triggered remask.");
  }

  if (conflicts.length === 0) {
    reasons.push("No merge conflicts detected.");
  } else {
    reasons.push(`${conflicts.length} merge conflict(s) detected.`);
  }

  reasons.push(`Conflict-aware merge decision: ${decision}.`);

  return reasons;
}

function createRequiredActions(
  decision: WorkspaceDecision,
  conflicts: MergeConflict[]
): string[] {
  if (decision === "approve") {
    return [];
  }

  const actions = new Set<string>();

  for (const conflict of conflicts) {
    if (conflict.kind === "stale_authority") {
      actions.add("Run local remask repair and verify the corrected authority-backed output.");
    }

    if (conflict.kind === "remask_unresolved") {
      actions.add("Run second-pass verifier after remask before approving merge.");
    }

    if (conflict.kind === "sensitive_boundary") {
      actions.add("Remove sensitive boundary exposure and reject unsafe merge.");
    }

    if (conflict.kind === "permission_violation" || conflict.kind === "blocked_mutation") {
      actions.add("Fix flow step write permissions or block the agent mutation.");
    }

    if (conflict.kind === "insufficient_context") {
      actions.add("Request additional bounded context or escalate to human review.");
    }

    if (conflict.kind === "human_review_needed") {
      actions.add("Escalate to human review before merge.");
    }

    if (conflict.kind === "verifier_rejection") {
      actions.add("Reject merge until verifier-blocking findings are resolved.");
    }
  }

  return [...actions];
}

function inferRemaskConflictKind(summary: string): MergeConflictKind {
  return summary.toLowerCase().includes("stale")
    ? "stale_authority"
    : "remask_unresolved";
}

function inferBlockedMutationKind(
  mutation: OrchestrationMutationEvent
): MergeConflictKind {
  return mutation.permissionCheck.ok ? "blocked_mutation" : "permission_violation";
}

/**
 * Aynı semantic conflict bazen hem verifier result summary'den hem finding'den
 * gelebilir. Ürün çıktısında bunları çift göstermek yerine tek conflict'e
 * indiriyoruz.
 *
 * Örnek:
 * - stale_authority from verifier summary
 * - stale_authority from verifier finding
 *
 * Aynı evidence + aynı suggested decision + aynı kind ise tek conflict kalır.
 */
function compactConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  const byKey = new Map<string, MergeConflict>();

  for (const conflict of conflicts) {
    const key = createConflictCompactKey(conflict);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, normalizeConflict(conflict));
      continue;
    }

    byKey.set(key, mergeConflicts(existing, conflict));
  }

  return [...byKey.values()];
}

function createConflictCompactKey(conflict: MergeConflict): string {
  return [
    conflict.kind,
    conflict.suggestedDecision,
    [...conflict.evidenceIds].sort().join(",")
  ].join(":");
}

function normalizeConflict(conflict: MergeConflict): MergeConflict {
  return {
    ...conflict,
    sourceStepIds: uniqueSorted(conflict.sourceStepIds),
    evidenceIds: uniqueSorted(conflict.evidenceIds)
  };
}

function mergeConflicts(left: MergeConflict, right: MergeConflict): MergeConflict {
  const severity = pickHigherSeverity(left.severity, right.severity);

  return {
    id: left.id,
    kind: left.kind,
    severity,
    message: pickBetterConflictMessage(left.message, right.message),
    sourceStepIds: uniqueSorted([...left.sourceStepIds, ...right.sourceStepIds]),
    evidenceIds: uniqueSorted([...left.evidenceIds, ...right.evidenceIds]),
    suggestedDecision: pickStrongerDecision(left.suggestedDecision, right.suggestedDecision)
  };
}

function pickBetterConflictMessage(left: string, right: string): string {
  /**
   * Daha spesifik finding mesajı genelde daha uzundur.
   * Summary mesajı kısa kalırsa finding mesajını gösteririz.
   */
  return right.length > left.length ? right : left;
}

function pickHigherSeverity(
  left: MergeConflictSeverity,
  right: MergeConflictSeverity
): MergeConflictSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(severity: MergeConflictSeverity): number {
  if (severity === "error") {
    return 3;
  }

  if (severity === "warning") {
    return 2;
  }

  return 1;
}

function pickStrongerDecision(
  left: WorkspaceDecision,
  right: WorkspaceDecision
): WorkspaceDecision {
  return decisionRank(right) > decisionRank(left) ? right : left;
}

function decisionRank(decision: WorkspaceDecision): number {
  if (decision === "reject") {
    return 4;
  }

  if (decision === "human_review_required") {
    return 3;
  }

  if (decision === "remask_required") {
    return 2;
  }

  if (decision === "refuse") {
    return 1;
  }

  return 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}