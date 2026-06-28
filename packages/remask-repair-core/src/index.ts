import type {
  ConflictAwareMergeResult
} from "../../merge-core/src/index.js";
import type {
  OrchestrationRunResult
} from "../../orchestration-core/src/index.js";
import type {
  WorkspaceDecision
} from "../../workspace-core/src/index.js";

export type RemaskRepairStatus =
  | "not_needed"
  | "repaired"
  | "blocked";

export type RemaskRepairActionKind =
  | "replace_stale_authority_output"
  | "resolve_remask_request"
  | "run_second_pass_verifier"
  | "approve_repaired_merge";

export type RemaskRepairAction = {
  id: string;
  kind: RemaskRepairActionKind;
  summary: string;
  evidenceIds: string[];
  reason: string;
};

export type RemaskRepairConflictSummary = {
  kind: string;
  severity: string;
  suggestedDecision: string;
  sourceStepIds: string[];
  evidenceIds: string[];
  message: string;
  repairable: boolean;
};

export type RemaskRepairSecondPass = {
  verifierDecision: WorkspaceDecision;
  mergeDecision: WorkspaceDecision;
  mergeSafe: boolean;
  conflicts: RemaskRepairConflictSummary[];
  requiredActions: string[];
  summary: string;
};

export type RemaskRepairLoopResult = {
  status: RemaskRepairStatus;
  initialDecision: WorkspaceDecision;
  finalDecision: WorkspaceDecision;
  initialMergeSafe: boolean;
  finalMergeSafe: boolean;
  remaskTriggered: boolean;
  repairApplied: boolean;
  repairableConflictCount: number;
  unrepairedConflictCount: number;
  actions: RemaskRepairAction[];
  initialConflicts: RemaskRepairConflictSummary[];
  remainingConflicts: RemaskRepairConflictSummary[];
  secondPass: RemaskRepairSecondPass;
  evidence: {
    flowId: string;
    totalMutations: number;
    blockedMutations: number;
    mutatedRegions: string[];
    initialRequiredActions: string[];
  };
};

export type RunMockRemaskRepairLoopInput = {
  orchestration: OrchestrationRunResult;
  merge: ConflictAwareMergeResult;
};

const repairableConflictKinds = new Set([
  "stale_authority",
  "remask_unresolved"
]);

/**
 * Deterministic Remask Repair Loop v1.
 *
 * Amaç:
 * - conflict-aware merge "remask_required" dediğinde,
 * - conflict seti sadece local remask ile çözülebilir türlerden oluşuyorsa,
 * - ikinci-pass verifier sonucunu deterministic olarak approve'a taşımak.
 *
 * Bu v1 gerçek patch rewrite yapmaz.
 * Runtime policy ve trace üretir.
 */
export function runMockRemaskRepairLoop(
  input: RunMockRemaskRepairLoopInput
): RemaskRepairLoopResult {
  const initialConflicts = input.merge.conflicts.map(summarizeConflict);
  const repairableConflicts = initialConflicts.filter((conflict) => conflict.repairable);
  const unrepairedConflicts = initialConflicts.filter((conflict) => !conflict.repairable);

  if (input.merge.mergeSafe && input.merge.decision === "approve") {
    return createNotNeededResult(input, initialConflicts);
  }

  const canRepair = canApplyLocalRemaskRepair(input, initialConflicts);

  if (!canRepair) {
    return createBlockedResult(input, initialConflicts, unrepairedConflicts);
  }

  const evidenceIds = uniqueSorted(
    repairableConflicts.flatMap((conflict) => conflict.evidenceIds)
  );

  const actions: RemaskRepairAction[] = [
    {
      id: "repair-action-replace-stale-authority-output",
      kind: "replace_stale_authority_output",
      summary: "Replace stale authority-backed output with current/correction-backed output.",
      evidenceIds,
      reason: "stale_authority conflict is repairable when current/correction evidence is available."
    },
    {
      id: "repair-action-resolve-remask-request",
      kind: "resolve_remask_request",
      summary: "Mark remask request as locally repaired.",
      evidenceIds,
      reason: "The initial remask request was produced by verifier and has a bounded local repair path."
    },
    {
      id: "repair-action-run-second-pass-verifier",
      kind: "run_second_pass_verifier",
      summary: "Run a second-pass verifier over the repaired output.",
      evidenceIds,
      reason: "Merge should not approve immediately after remask without a second verifier pass."
    },
    {
      id: "repair-action-approve-repaired-merge",
      kind: "approve_repaired_merge",
      summary: "Approve merge after repairable conflicts are cleared by second-pass verifier.",
      evidenceIds,
      reason: "Only repairable remask conflicts were present and no blocked mutations were detected."
    }
  ];

  return {
    status: "repaired",
    initialDecision: input.merge.decision,
    finalDecision: "approve",
    initialMergeSafe: input.merge.mergeSafe,
    finalMergeSafe: true,
    remaskTriggered: input.orchestration.remaskTriggered,
    repairApplied: true,
    repairableConflictCount: repairableConflicts.length,
    unrepairedConflictCount: 0,
    actions,
    initialConflicts,
    remainingConflicts: [],
    secondPass: {
      verifierDecision: "approve",
      mergeDecision: "approve",
      mergeSafe: true,
      conflicts: [],
      requiredActions: [],
      summary: "Second-pass verifier approved after deterministic local remask repair."
    },
    evidence: createEvidence(input)
  };
}

function canApplyLocalRemaskRepair(
  input: RunMockRemaskRepairLoopInput,
  conflicts: RemaskRepairConflictSummary[]
): boolean {
  if (input.merge.decision !== "remask_required") {
    return false;
  }

  if (!input.orchestration.remaskTriggered) {
    return false;
  }

  if (input.orchestration.mutationSummary.blockedMutations !== 0) {
    return false;
  }

  if (conflicts.length === 0) {
    return false;
  }

  if (conflicts.some((conflict) => !conflict.repairable)) {
    return false;
  }

  const hasStaleAuthority = conflicts.some((conflict) => conflict.kind === "stale_authority");
  const hasRemaskUnresolved = conflicts.some((conflict) => conflict.kind === "remask_unresolved");

  return hasStaleAuthority && hasRemaskUnresolved;
}

function createNotNeededResult(
  input: RunMockRemaskRepairLoopInput,
  initialConflicts: RemaskRepairConflictSummary[]
): RemaskRepairLoopResult {
  return {
    status: "not_needed",
    initialDecision: input.merge.decision,
    finalDecision: input.merge.decision,
    initialMergeSafe: input.merge.mergeSafe,
    finalMergeSafe: input.merge.mergeSafe,
    remaskTriggered: input.orchestration.remaskTriggered,
    repairApplied: false,
    repairableConflictCount: 0,
    unrepairedConflictCount: initialConflicts.length,
    actions: [],
    initialConflicts,
    remainingConflicts: initialConflicts,
    secondPass: {
      verifierDecision: input.merge.decision,
      mergeDecision: input.merge.decision,
      mergeSafe: input.merge.mergeSafe,
      conflicts: initialConflicts,
      requiredActions: input.merge.requiredActions,
      summary: "Repair loop was not needed because the initial merge was already safe."
    },
    evidence: createEvidence(input)
  };
}

function createBlockedResult(
  input: RunMockRemaskRepairLoopInput,
  initialConflicts: RemaskRepairConflictSummary[],
  unrepairedConflicts: RemaskRepairConflictSummary[]
): RemaskRepairLoopResult {
  const remainingConflicts =
    unrepairedConflicts.length > 0 ? unrepairedConflicts : initialConflicts;

  return {
    status: "blocked",
    initialDecision: input.merge.decision,
    finalDecision: input.merge.decision,
    initialMergeSafe: input.merge.mergeSafe,
    finalMergeSafe: false,
    remaskTriggered: input.orchestration.remaskTriggered,
    repairApplied: false,
    repairableConflictCount: initialConflicts.filter((conflict) => conflict.repairable).length,
    unrepairedConflictCount: remainingConflicts.length,
    actions: [],
    initialConflicts,
    remainingConflicts,
    secondPass: {
      verifierDecision: input.merge.decision,
      mergeDecision: input.merge.decision,
      mergeSafe: false,
      conflicts: remainingConflicts,
      requiredActions: input.merge.requiredActions,
      summary: "Repair loop was blocked because not all conflicts were safely repairable."
    },
    evidence: createEvidence(input)
  };
}

function summarizeConflict(
  conflict: ConflictAwareMergeResult["conflicts"][number]
): RemaskRepairConflictSummary {
  return {
    kind: conflict.kind,
    severity: conflict.severity,
    suggestedDecision: conflict.suggestedDecision,
    sourceStepIds: conflict.sourceStepIds,
    evidenceIds: conflict.evidenceIds,
    message: conflict.message,
    repairable: repairableConflictKinds.has(conflict.kind)
  };
}

function createEvidence(input: RunMockRemaskRepairLoopInput): RemaskRepairLoopResult["evidence"] {
  return {
    flowId: input.orchestration.flowId,
    totalMutations: input.orchestration.mutationSummary.totalMutations,
    blockedMutations: input.orchestration.mutationSummary.blockedMutations,
    mutatedRegions: input.orchestration.mutationSummary.mutatedRegions,
    initialRequiredActions: input.merge.requiredActions
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}