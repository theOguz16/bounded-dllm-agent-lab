export type ModelRole =
  | "planner"
  | "coder"
  | "verifier"
  | "remask";

export type WorkspaceMutationTarget =
  | "plan"
  | "patchDraft"
  | "verifierFinding"
  | "remaskRequest"
  | "repairDraft";

export type WorkspaceMutation = {
  role: ModelRole;
  target: WorkspaceMutationTarget;
  summary: string;
  claims: unknown[];
  touchedFiles: string[];
  confidence?: number;
};

const workspaceMutationTargetsByRole: Record<ModelRole, WorkspaceMutationTarget[]> = {
  planner: ["plan"],
  coder: ["patchDraft"],
  verifier: ["verifierFinding", "remaskRequest"],
  remask: ["repairDraft"]
};

const knownRoles = new Set<ModelRole>(Object.keys(workspaceMutationTargetsByRole) as ModelRole[]);
const knownTargets = new Set<WorkspaceMutationTarget>(
  Object.values(workspaceMutationTargetsByRole).flat()
);

export function getAllowedWorkspaceMutationTargets(role: ModelRole): WorkspaceMutationTarget[] {
  return [...(workspaceMutationTargetsByRole[role] ?? [])];
}

export function canRoleWriteWorkspaceMutationTarget(
  role: ModelRole,
  target: WorkspaceMutationTarget
): boolean {
  return getAllowedWorkspaceMutationTargets(role).includes(target);
}

export function createWorkspaceMutation(input: WorkspaceMutation): WorkspaceMutation {
  return {
    role: input.role,
    target: input.target,
    summary: input.summary.trim(),
    claims: Array.isArray(input.claims) ? input.claims : [],
    touchedFiles: Array.isArray(input.touchedFiles) ? input.touchedFiles : [],
    ...(input.confidence === undefined ? {} : { confidence: input.confidence })
  };
}

export function validateWorkspaceMutationContract(mutation: WorkspaceMutation): {
  ok: boolean;
  errors: string[];
} {
  const candidate = mutation as Partial<WorkspaceMutation>;
  const errors: string[] = [];

  if (!knownRoles.has(candidate.role as ModelRole)) {
    errors.push("role must be a known model role");
  }

  if (!knownTargets.has(candidate.target as WorkspaceMutationTarget)) {
    errors.push("target must be a known workspace mutation target");
  }

  if (
    knownRoles.has(candidate.role as ModelRole) &&
    knownTargets.has(candidate.target as WorkspaceMutationTarget) &&
    !canRoleWriteWorkspaceMutationTarget(
      candidate.role as ModelRole,
      candidate.target as WorkspaceMutationTarget
    )
  ) {
    errors.push("role cannot write target");
  }

  if (typeof candidate.summary !== "string" || candidate.summary.trim().length === 0) {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(candidate.claims)) {
    errors.push("claims must be an array");
  }

  if (!Array.isArray(candidate.touchedFiles)) {
    errors.push("touchedFiles must be an array");
  }

  if (
    candidate.confidence !== undefined &&
    (typeof candidate.confidence !== "number" ||
      Number.isNaN(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1)
  ) {
    errors.push("confidence must be a number between 0 and 1");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
