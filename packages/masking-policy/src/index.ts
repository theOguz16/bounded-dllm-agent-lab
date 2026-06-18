import { markRegionsMasked, type SharedSemanticWorkspace, type WorkspaceRegion } from "../../workspace-core/src/index.js";

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
  // Masking artık sessiz bir array güncellemesi değil. Ortak workspace'te hangi rolün
  // hangi alanı yeniden üretime açtığını trace'e yazıyoruz. Bu bilgi olmadan çoklu
  // agent akışında "kim neyi ezdi?" sorusunu sonradan ölçmek zorlaşır.
  return markRegionsMasked(workspace, policy.regions, policy.view, policy.reason);
}

export function remaskAfterFailure(workspace: SharedSemanticWorkspace, failedRegions: WorkspaceRegion[]): SharedSemanticWorkspace {
  return markRegionsMasked(workspace, failedRegions, "verifier", "Verifier requested failed regions to be remasked.");
}
