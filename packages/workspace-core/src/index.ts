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
export type AgentRole = "planner" | "implementer" | "reviewer" | "verifier" | "boundary" | "system";
export type ClaimState = "proposed" | "accepted" | "rejected";
export type ConflictSeverity = "low" | "medium" | "high";
export type VerifierStatus = "pass" | "warn" | "fail";
export type WorkspaceAction =
  | "workspace_created"
  | "region_masked"
  | "claim_added"
  | "conflict_added"
  | "boundary_decided"
  | "verifier_result_added"
  | "final_result_set";

export type WorkspaceClaim = {
  id: string;
  region: WorkspaceRegion;
  actor: AgentRole;
  content: string;
  evidenceIds: string[];
  confidence: number;
  state: ClaimState;
  createdAt: string;
};

export type WorkspaceConflict = {
  id: string;
  leftClaimId: string;
  rightClaimId: string;
  reason: string;
  severity: ConflictSeverity;
  detectedBy: AgentRole;
  createdAt: string;
  resolvedByClaimId?: string;
};

export type BoundaryDecision = {
  status: BoundaryStatus;
  reason: string;
  missingInformation: string[];
  decidedBy: AgentRole;
  createdAt: string;
};

export type VerifierResult = {
  id: string;
  status: VerifierStatus;
  checkName: string;
  summary: string;
  evidenceIds: string[];
  // Verifier sadece "fail" dememeli; hangi workspace bölgesinin sorunlu olduğunu
  // da söylemelidir. Refinement loop bu alanı okuyup bütün cevabı değil, sadece
  // başarısız region'ı yeniden maskeler.
  failedRegions: WorkspaceRegion[];
  createdAt: string;
};

export type WorkspaceTraceEvent = {
  id: string;
  action: WorkspaceAction;
  actor: AgentRole;
  summary: string;
  region?: WorkspaceRegion;
  relatedClaimIds: string[];
  createdAt: string;
};

export type SharedSemanticWorkspace = {
  id: string;
  version: number;
  packet: BoundedContextPacket;
  activeAgents: AgentRole[];
  claims: WorkspaceClaim[];
  conflicts: WorkspaceConflict[];
  maskedRegions: WorkspaceRegion[];
  verifierResults: VerifierResult[];
  trace: WorkspaceTraceEvent[];
  boundaryDecision?: BoundaryDecision;
  finalResult?: string;
};

export function createWorkspace(id: string, packet: BoundedContextPacket): SharedSemanticWorkspace {
  const createdAt = new Date().toISOString();

  return {
    id,
    version: 1,
    packet,
    activeAgents: ["planner", "implementer", "reviewer", "verifier", "boundary"],
    claims: [],
    conflicts: [],
    maskedRegions: [],
    verifierResults: [],
    // Trace alanı bu projenin "ortak sohbet değil, ortak workspace" fikrinin kalbidir.
    // Agent'lar aynı metne sırayla cevap yazmak yerine, ortak state üzerinde denetlenebilir
    // olaylar üretir. Böylece ileride hangi rolün hangi kararı verdiğini ölçebiliriz.
    trace: [
      {
        id: `${id}-trace-created`,
        action: "workspace_created",
        actor: "system",
        summary: "Workspace was created from a bounded context packet.",
        relatedClaimIds: [],
        createdAt
      }
    ],
    finalResult: undefined
  };
}

export function addClaim(workspace: SharedSemanticWorkspace, claim: WorkspaceClaim): SharedSemanticWorkspace {
  const next = touch(workspace);

  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    claims: [...workspace.claims, claim]
  }, {
    id: `${workspace.id}-trace-claim-${claim.id}`,
    action: "claim_added",
    actor: claim.actor,
    region: claim.region,
    summary: `Claim ${claim.id} was added to ${claim.region}.`,
    relatedClaimIds: [claim.id],
    createdAt: claim.createdAt
  });
}

export function setBoundaryDecision(
  workspace: SharedSemanticWorkspace,
  boundaryDecision: BoundaryDecision
): SharedSemanticWorkspace {
  const next = touch(workspace);

  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    boundaryDecision
  }, {
    id: `${workspace.id}-trace-boundary-${workspace.trace.length + 1}`,
    action: "boundary_decided",
    actor: boundaryDecision.decidedBy,
    region: "boundary_decision",
    summary: `Boundary status is ${boundaryDecision.status}.`,
    relatedClaimIds: [],
    createdAt: boundaryDecision.createdAt
  });
}

export function addConflict(workspace: SharedSemanticWorkspace, conflict: WorkspaceConflict): SharedSemanticWorkspace {
  const next = touch(workspace);

  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    conflicts: [...workspace.conflicts, conflict]
  }, {
    id: `${workspace.id}-trace-conflict-${conflict.id}`,
    action: "conflict_added",
    actor: conflict.detectedBy,
    summary: `Conflict ${conflict.id} was detected with ${conflict.severity} severity.`,
    relatedClaimIds: [conflict.leftClaimId, conflict.rightClaimId],
    createdAt: conflict.createdAt
  });
}

export function addVerifierResult(
  workspace: SharedSemanticWorkspace,
  verifierResult: VerifierResult
): SharedSemanticWorkspace {
  const next = touch(workspace);

  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    verifierResults: [...workspace.verifierResults, verifierResult]
  }, {
    id: `${workspace.id}-trace-verifier-${verifierResult.id}`,
    action: "verifier_result_added",
    actor: "verifier",
    region: "verifier_feedback",
    summary: `${verifierResult.checkName}: ${verifierResult.status}.`,
    relatedClaimIds: [],
    createdAt: verifierResult.createdAt
  });
}

export function setFinalResult(
  workspace: SharedSemanticWorkspace,
  finalResult: string,
  actor: AgentRole,
  createdAt: string
): SharedSemanticWorkspace {
  const next = touch(workspace);

  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    finalResult
  }, {
    id: `${workspace.id}-trace-final-${workspace.trace.length + 1}`,
    action: "final_result_set",
    actor,
    region: "final_result",
    summary: "Final result was written to the shared workspace.",
    relatedClaimIds: [],
    createdAt
  });
}

export function markRegionsMasked(
  workspace: SharedSemanticWorkspace,
  regions: WorkspaceRegion[],
  actor: AgentRole,
  reason: string,
  createdAt = new Date().toISOString()
): SharedSemanticWorkspace {
  const next = touch(workspace);
  const maskedRegions = Array.from(new Set([...workspace.maskedRegions, ...regions]));

  // Mask bilgisini de trace'e yazıyoruz; çünkü ileride "agent hangi alanı yeniden
  // düşünmeye açtı?" sorusu benchmark için önemli olacak. Bu, switch tabanlı ajan
  // akışından farklı olarak ortak state üzerinde kontrollü çalışma fikrini gösterir.
  return addTraceEvent({
    ...next,
    ...workspace,
    version: next.version,
    maskedRegions
  }, {
    id: `${workspace.id}-trace-mask-${workspace.trace.length + 1}`,
    action: "region_masked",
    actor,
    summary: reason,
    region: regions[0],
    relatedClaimIds: [],
    createdAt
  });
}

function addTraceEvent(
  workspace: SharedSemanticWorkspace,
  event: WorkspaceTraceEvent
): SharedSemanticWorkspace {
  return {
    ...workspace,
    trace: [...workspace.trace, event]
  };
}

function touch(workspace: SharedSemanticWorkspace): Pick<SharedSemanticWorkspace, "version"> {
  return {
    version: workspace.version + 1
  };
}
