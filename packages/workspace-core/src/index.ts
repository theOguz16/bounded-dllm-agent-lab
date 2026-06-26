import type { BoundedContextPacket } from "../../context-core/src/index.js";

export type WorkspaceRegion =
  | "task"
  | "scope"
  | "authority"
  | "repo_facts"
  | "plan"
  | "patch_intent"
  | "patch_plan"
  | "patch_draft"
  | "risk_analysis"
  | "review"
  | "boundary_decision"
  | "verifier_feedback"
  | "test_signal"
  | "remask_request"
  | "merge_decision"
  | "final_result";

export type BoundaryStatus =
  | "sufficient_context"
  | "insufficient_context"
  | "unsafe_sensitive"
  | "outside_allowed_scope";

export type AgentRole =
  | "planner"
  | "coder"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "boundary"
  | "tester"
  | "remask"
  | "merge"
  | "workspace_builder"
  | "context_composer"
  | "orchestrator"
  | "system";

export type WorkspaceDecision =
  | "approve"
  | "refuse"
  | "reject"
  | "remask_required"
  | "human_review_required";

export type RiskLevel = "low" | "medium" | "high";
export type ClaimState = "proposed" | "accepted" | "rejected";
export type ConflictSeverity = "low" | "medium" | "high";
export type VerifierStatus = "pass" | "warn" | "fail";
export type TestSignalStatus = "pass" | "warn" | "fail" | "not_run";

export type WorkspaceAction =
  | "workspace_created"
  | "workspace_deserialized"
  | "region_masked"
  | "claim_added"
  | "patch_plan_set"
  | "conflict_added"
  | "boundary_decided"
  | "verifier_result_added"
  | "test_signal_added"
  | "remask_request_added"
  | "merge_decision_set"
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

  /**
   * baseRevision lets the merge layer detect stale claims later.
   * If an agent wrote a claim from revision 3 but the workspace is now revision 9,
   * the merge layer can decide whether the claim is still safe to apply.
   */
  baseRevision?: number;

  /**
   * writableRegions is optional for now, but it becomes important once the
   * orchestrator starts enforcing role-specific write permissions.
   */
  writableRegions?: WorkspaceRegion[];
};

export type WorkspacePatchPlan = {
  id: string;
  summary: string;
  files: string[];
  allowedEditRegions: string[];
  forbiddenEditRegions: string[];
  requiredSignals: string[];
  createdBy: AgentRole;
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

  /**
   * Verifier sadece "fail" dememeli; hangi workspace bölgesinin sorunlu
   * olduğunu da söylemelidir. Remask loop bu alanı okuyup bütün cevabı değil,
   * sadece başarısız region'ı yeniden açar.
   */
  failedRegions: WorkspaceRegion[];

  createdAt: string;
};

export type WorkspaceTestSignal = {
  id: string;
  status: TestSignalStatus;
  checkName: string;
  summary: string;
  files: string[];
  createdBy: AgentRole;
  createdAt: string;
};

export type WorkspaceRemaskRequest = {
  id: string;
  reason: string;
  failedRegions: WorkspaceRegion[];
  files: string[];
  instruction: string;
  requestedBy: AgentRole;
  createdAt: string;
};

export type WorkspaceMergeDecision = {
  decision: WorkspaceDecision;
  riskLevel: RiskLevel;
  reason: string;
  decidedBy: AgentRole;
  createdAt: string;
};

export type WorkspaceFinalResult = {
  decision?: WorkspaceDecision;
  summary: string;
  createdBy: AgentRole;
  createdAt: string;
};

export type WorkspaceTraceEvent = {
  id: string;
  action: WorkspaceAction;
  actor: AgentRole;
  summary: string;
  region?: WorkspaceRegion;
  relatedClaimIds: string[];
  relatedIds: string[];
  createdAt: string;
};

export type SharedSemanticWorkspace = {
  id: string;

  /**
   * schemaVersion is the external contract version.
   * Keep this stable unless the serialized workspace shape changes incompatibly.
   */
  schemaVersion: "shared-semantic-workspace/v1";

  /**
   * revision is the mutation counter.
   * It increases whenever the runtime writes a new claim, verifier result,
   * remask request, merge decision or final result.
   */
  revision: number;

  packet: BoundedContextPacket;
  activeAgents: AgentRole[];

  claims: WorkspaceClaim[];
  conflicts: WorkspaceConflict[];
  maskedRegions: WorkspaceRegion[];

  patchPlan?: WorkspacePatchPlan;
  verifierResults: VerifierResult[];
  testSignals: WorkspaceTestSignal[];
  remaskRequests: WorkspaceRemaskRequest[];

  boundaryDecision?: BoundaryDecision;
  mergeDecision?: WorkspaceMergeDecision;
  finalResult?: WorkspaceFinalResult;

  /**
   * Trace alanı bu projenin "ortak sohbet değil, ortak workspace" fikrinin
   * kalbidir. Agent'lar aynı metne sırayla cevap yazmak yerine, ortak state
   * üzerinde denetlenebilir olaylar üretir.
   */
  trace: WorkspaceTraceEvent[];
};

export type CreateWorkspaceOptions = {
  activeAgents?: AgentRole[];
  createdAt?: string;
};

export function createWorkspace(
  id: string,
  packet: BoundedContextPacket,
  options: CreateWorkspaceOptions = {}
): SharedSemanticWorkspace {
  const createdAt = options.createdAt ?? new Date().toISOString();

  return {
    id,
    schemaVersion: "shared-semantic-workspace/v1",
    revision: 1,
    packet,
    activeAgents: options.activeAgents ?? [
      "workspace_builder",
      "planner",
      "coder",
      "verifier",
      "tester",
      "remask",
      "merge"
    ],
    claims: [],
    conflicts: [],
    maskedRegions: [],
    verifierResults: [],
    testSignals: [],
    remaskRequests: [],
    trace: [
      {
        id: `${id}-trace-created`,
        action: "workspace_created",
        actor: "workspace_builder",
        summary: "Workspace was created from a bounded context packet.",
        relatedClaimIds: [],
        relatedIds: [packet.id],
        createdAt
      }
    ]
  };
}

export function addClaim(
  workspace: SharedSemanticWorkspace,
  claim: WorkspaceClaim
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    claims: [...workspace.claims, claim]
  }, {
    id: `${workspace.id}-trace-claim-${claim.id}`,
    action: "claim_added",
    actor: claim.actor,
    region: claim.region,
    summary: `Claim ${claim.id} was added to ${claim.region}.`,
    relatedClaimIds: [claim.id],
    relatedIds: [claim.id],
    createdAt: claim.createdAt
  });
}

export function setPatchPlan(
  workspace: SharedSemanticWorkspace,
  patchPlan: WorkspacePatchPlan
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    patchPlan
  }, {
    id: `${workspace.id}-trace-patch-plan-${workspace.trace.length + 1}`,
    action: "patch_plan_set",
    actor: patchPlan.createdBy,
    region: "patch_plan",
    summary: patchPlan.summary,
    relatedClaimIds: [],
    relatedIds: [patchPlan.id, ...patchPlan.files],
    createdAt: patchPlan.createdAt
  });
}

export function setBoundaryDecision(
  workspace: SharedSemanticWorkspace,
  boundaryDecision: BoundaryDecision
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    boundaryDecision
  }, {
    id: `${workspace.id}-trace-boundary-${workspace.trace.length + 1}`,
    action: "boundary_decided",
    actor: boundaryDecision.decidedBy,
    region: "boundary_decision",
    summary: `Boundary status is ${boundaryDecision.status}.`,
    relatedClaimIds: [],
    relatedIds: boundaryDecision.missingInformation,
    createdAt: boundaryDecision.createdAt
  });
}

export function addConflict(
  workspace: SharedSemanticWorkspace,
  conflict: WorkspaceConflict
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    conflicts: [...workspace.conflicts, conflict]
  }, {
    id: `${workspace.id}-trace-conflict-${conflict.id}`,
    action: "conflict_added",
    actor: conflict.detectedBy,
    region: "merge_decision",
    summary: `Conflict ${conflict.id} was detected with ${conflict.severity} severity.`,
    relatedClaimIds: [conflict.leftClaimId, conflict.rightClaimId],
    relatedIds: [conflict.id],
    createdAt: conflict.createdAt
  });
}

export function addVerifierResult(
  workspace: SharedSemanticWorkspace,
  verifierResult: VerifierResult
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    verifierResults: [...workspace.verifierResults, verifierResult]
  }, {
    id: `${workspace.id}-trace-verifier-${verifierResult.id}`,
    action: "verifier_result_added",
    actor: "verifier",
    region: "verifier_feedback",
    summary: `${verifierResult.checkName}: ${verifierResult.status}.`,
    relatedClaimIds: [],
    relatedIds: [verifierResult.id, ...verifierResult.evidenceIds],
    createdAt: verifierResult.createdAt
  });
}

export function addTestSignal(
  workspace: SharedSemanticWorkspace,
  testSignal: WorkspaceTestSignal
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    testSignals: [...workspace.testSignals, testSignal]
  }, {
    id: `${workspace.id}-trace-test-${testSignal.id}`,
    action: "test_signal_added",
    actor: testSignal.createdBy,
    region: "test_signal",
    summary: `${testSignal.checkName}: ${testSignal.status}.`,
    relatedClaimIds: [],
    relatedIds: [testSignal.id, ...testSignal.files],
    createdAt: testSignal.createdAt
  });
}

export function addRemaskRequest(
  workspace: SharedSemanticWorkspace,
  remaskRequest: WorkspaceRemaskRequest
): SharedSemanticWorkspace {
  const maskedRegions = Array.from(new Set([
    ...workspace.maskedRegions,
    ...remaskRequest.failedRegions
  ]));

  return withTraceEvent({
    ...workspace,
    maskedRegions,
    remaskRequests: [...workspace.remaskRequests, remaskRequest]
  }, {
    id: `${workspace.id}-trace-remask-${remaskRequest.id}`,
    action: "remask_request_added",
    actor: remaskRequest.requestedBy,
    region: "remask_request",
    summary: remaskRequest.reason,
    relatedClaimIds: [],
    relatedIds: [remaskRequest.id, ...remaskRequest.files],
    createdAt: remaskRequest.createdAt
  });
}

export function setMergeDecision(
  workspace: SharedSemanticWorkspace,
  mergeDecision: WorkspaceMergeDecision
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    mergeDecision
  }, {
    id: `${workspace.id}-trace-merge-${workspace.trace.length + 1}`,
    action: "merge_decision_set",
    actor: mergeDecision.decidedBy,
    region: "merge_decision",
    summary: `Merge decision is ${mergeDecision.decision}.`,
    relatedClaimIds: [],
    relatedIds: [],
    createdAt: mergeDecision.createdAt
  });
}

export function setFinalResult(
  workspace: SharedSemanticWorkspace,
  finalResult: WorkspaceFinalResult
): SharedSemanticWorkspace {
  return withTraceEvent({
    ...workspace,
    finalResult
  }, {
    id: `${workspace.id}-trace-final-${workspace.trace.length + 1}`,
    action: "final_result_set",
    actor: finalResult.createdBy,
    region: "final_result",
    summary: finalResult.summary,
    relatedClaimIds: [],
    relatedIds: [],
    createdAt: finalResult.createdAt
  });
}

export function markRegionsMasked(
  workspace: SharedSemanticWorkspace,
  regions: WorkspaceRegion[],
  actor: AgentRole,
  reason: string,
  createdAt = new Date().toISOString()
): SharedSemanticWorkspace {
  const maskedRegions = Array.from(new Set([
    ...workspace.maskedRegions,
    ...regions
  ]));

  /**
   * Mask bilgisini trace'e yazıyoruz; çünkü ileride "agent hangi alanı yeniden
   * düşünmeye açtı?" sorusu benchmark için önemli olacak.
   */
  return withTraceEvent({
    ...workspace,
    maskedRegions
  }, {
    id: `${workspace.id}-trace-mask-${workspace.trace.length + 1}`,
    action: "region_masked",
    actor,
    summary: reason,
    region: regions[0],
    relatedClaimIds: [],
    relatedIds: regions,
    createdAt
  });
}

export function serializeWorkspace(workspace: SharedSemanticWorkspace): string {
  return `${JSON.stringify(workspace, null, 2)}\n`;
}

export function deserializeWorkspace(raw: string): SharedSemanticWorkspace {
  const parsed = JSON.parse(raw) as SharedSemanticWorkspace;

  assertWorkspaceShape(parsed);

  return withTraceEvent(parsed, {
    id: `${parsed.id}-trace-deserialized-${parsed.trace.length + 1}`,
    action: "workspace_deserialized",
    actor: "system",
    summary: "Workspace was deserialized and validated.",
    relatedClaimIds: [],
    relatedIds: [],
    createdAt: new Date().toISOString()
  });
}

function withTraceEvent(
  workspace: SharedSemanticWorkspace,
  event: WorkspaceTraceEvent
): SharedSemanticWorkspace {
  return {
    ...workspace,
    revision: workspace.revision + 1,
    trace: [...workspace.trace, event]
  };
}

function assertWorkspaceShape(value: SharedSemanticWorkspace): void {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid SharedWorkspace payload: expected object.");
  }

  if (value.schemaVersion !== "shared-semantic-workspace/v1") {
    throw new Error("Invalid SharedWorkspace payload: unsupported schemaVersion.");
  }

  if (!value.id || typeof value.id !== "string") {
    throw new Error("Invalid SharedWorkspace payload: missing id.");
  }

  if (!value.packet || typeof value.packet !== "object") {
    throw new Error("Invalid SharedWorkspace payload: missing bounded context packet.");
  }

  if (!Array.isArray(value.claims)) {
    throw new Error("Invalid SharedWorkspace payload: claims must be an array.");
  }

  if (!Array.isArray(value.conflicts)) {
    throw new Error("Invalid SharedWorkspace payload: conflicts must be an array.");
  }

  if (!Array.isArray(value.verifierResults)) {
    throw new Error("Invalid SharedWorkspace payload: verifierResults must be an array.");
  }

  if (!Array.isArray(value.remaskRequests)) {
    throw new Error("Invalid SharedWorkspace payload: remaskRequests must be an array.");
  }

  if (!Array.isArray(value.trace)) {
    throw new Error("Invalid SharedWorkspace payload: trace must be an array.");
  }
}