import type { SharedSemanticWorkspace, WorkspaceRegion } from "../../workspace-core/src/index.js";

export type MaskView = "planner" | "implementer" | "reviewer" | "verifier" | "boundary";

export type MaskingPolicy = {
  view: MaskView;
  regions: WorkspaceRegion[];
  reason: string;
};

export function defaultMaskingPolicy(view: MaskView): MaskingPolicy {
  const table: Record<MaskView, WorkspaceRegion[]> = {
    planner: ["plan", "risk_analysis"],
    implementer: ["patch_intent"],
    reviewer: ["review", "risk_analysis"],
    verifier: ["verifier_feedback"],
    boundary: ["boundary_decision"]
  };

  return {
    view,
    regions: table[view],
    reason: `${view} view refines ${table[view].join(", ")}`
  };
}

export function applyMaskingPolicy(workspace: SharedSemanticWorkspace, policy: MaskingPolicy): SharedSemanticWorkspace {
  return {
    ...workspace,
    maskedRegions: Array.from(new Set([...workspace.maskedRegions, ...policy.regions]))
  };
}

export function remaskAfterFailure(workspace: SharedSemanticWorkspace, failedRegions: WorkspaceRegion[]): SharedSemanticWorkspace {
  return {
    ...workspace,
    maskedRegions: Array.from(new Set(failedRegions))
  };
}

