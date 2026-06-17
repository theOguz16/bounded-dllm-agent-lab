import type { BoundedContextPacket } from "../../context-core/src/index.js";

export type WorkspaceRegion =
  | "plan"
  | "patch_intent"
  | "risk_analysis"
  | "review"
  | "boundary_decision"
  | "verifier_feedback"
  | "final_result";

export type BoundaryStatus = "sufficient_context" | "insufficient_context" | "unsafe_sensitive" | "outside_allowed_scope";

export type WorkspaceClaim = {
  id: string;
  region: WorkspaceRegion;
  content: string;
  evidenceIds: string[];
  confidence: number;
};

export type WorkspaceConflict = {
  id: string;
  leftClaimId: string;
  rightClaimId: string;
  reason: string;
  resolvedByClaimId?: string;
};

export type BoundaryDecision = {
  status: BoundaryStatus;
  reason: string;
  missingInformation: string[];
};

export type SharedSemanticWorkspace = {
  id: string;
  packet: BoundedContextPacket;
  claims: WorkspaceClaim[];
  conflicts: WorkspaceConflict[];
  maskedRegions: WorkspaceRegion[];
  boundaryDecision?: BoundaryDecision;
  finalResult?: string;
};

export function createWorkspace(id: string, packet: BoundedContextPacket): SharedSemanticWorkspace {
  return {
    id,
    packet,
    claims: [],
    conflicts: [],
    maskedRegions: [],
    finalResult: undefined
  };
}

export function addClaim(workspace: SharedSemanticWorkspace, claim: WorkspaceClaim): SharedSemanticWorkspace {
  return {
    ...workspace,
    claims: [...workspace.claims, claim]
  };
}

export function setBoundaryDecision(
  workspace: SharedSemanticWorkspace,
  boundaryDecision: BoundaryDecision
): SharedSemanticWorkspace {
  return {
    ...workspace,
    boundaryDecision
  };
}

