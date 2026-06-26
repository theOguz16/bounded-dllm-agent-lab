import type { BoundedContextPacket } from "../../context-core/src/index.js";

export type WorkspaceDecision =
| "approve"
| "refuse"
| "reject"
| "remask_required"
| "human_review_required";

export type WorkspaceRiskLevel = "low" | "medium" | "high";
export type WorkspaceFindingSeverity = "info" | "warning" | "error";

export type WorkspaceRole =
| "workspace_builder"
| "context_composer"
| "orchestrator"
| "planner"
| "coder"
| "reviewer"
| "verifier"
| "tester"
| "remask"
| "merge"
| "boundary"
| "system";

export type WorkspaceRegion =
| "task"
| "scope"
| "authority"
| "policy"
| "repo_facts"
| "patch_intent"
| "role_view"
| "claim"
| "patch_plan"
| "patch_draft"
| "verifier_result"
| "test_signal"
| "remask_request"
| "conflict"
| "merge_decision"
| "final_result";

export type WorkspaceClaimState = "proposed" | "accepted" | "rejected";
export type WorkspaceCheckStatus = "pass" | "warn" | "fail" | "not_run";

export type WorkspaceAction =
| "workspace_created"
| "workspace_deserialized"
| "role_views_set"
| "claim_added"
| "patch_plan_set"
| "verifier_result_added"
| "test_signal_added"
| "remask_request_added"
| "conflict_added"
| "merge_decision_set"
| "final_result_set"
| "region_masked";

export type WorkspaceTask = {
id: string;
title: string;
description: string;

/**

* Authority facts are explicit task-level permissions or constraints.
* Example: "This PR is allowed to modify packages/workspace-core only."
  */
  authorityFacts: string[];
  };

export type WorkspaceScope = {
allowed: string[];
forbidden: string[];
changedFiles: string[];
};

export type WorkspaceAuthority = {
facts: string[];
missingRules: string[];
};

export type WorkspacePolicy = {
allowedPaths: string[];
forbiddenPaths: string[];
ownership: Record<string, string>;
ownerAliases: Record<string, string[]>;
pairedFiles: WorkspacePairedFileRule[];
sensitivePatterns: string[];
requiredTests: string[];
requiredTestMappings: WorkspaceRequiredTestMappingRule[];
moduleBoundaries: WorkspaceModuleBoundaryRule[];
missingAuthorityRules: string[];
};

export type WorkspacePairedFileRule = {
source: string;
requires: string;
reason?: string;
changedWhenContains?: string[];
};

export type WorkspaceRequiredTestMappingRule = {
source: string;
test: string;
reason?: string;
changedWhenContains?: string[];
};

export type WorkspaceModuleBoundaryRule = {
source: string;
allowedWith: string[];
authority?: string;
reason?: string;
};

export type WorkspacePatchIntent = {
rawDiff: string;
changedFiles: string[];
};

export type WorkspaceRepoFacts = {
changedFiles: string[];
ownership: Record<string, string>;
pairedFiles: WorkspacePairedFileRule[];
requiredTests: string[];
requiredTestMappings: WorkspaceRequiredTestMappingRule[];
moduleBoundaries: WorkspaceModuleBoundaryRule[];
sensitivePatterns: string[];
staleFacts: string[];
intelligence?: WorkspaceRepoIntelligence;
};

export type WorkspaceRepoFileKind =
| "source"
| "test"
| "docs"
| "config"
| "generated"
| "build"
| "public_api"
| "unknown";

export type WorkspaceRepoFileClassification = {
path: string;
kind: WorkspaceRepoFileKind;
reason: string;
};

export type WorkspaceRepoIntelligence = {
packageManagers: string[];
files: WorkspaceRepoFileClassification[];
sourceFiles: string[];
testFiles: string[];
docsFiles: string[];
configFiles: string[];
generatedFiles: string[];
buildOutputPaths: string[];
likelyPairedFiles: WorkspacePairedFileRule[];
likelyPublicApiFiles: string[];
likelyTestMappings: WorkspaceRequiredTestMappingRule[];
};

export type WorkspaceContextFactSelection = {
field: string;
reason: string;
};

export type WorkspaceContextFactExclusion = {
field: string;
reason: string;
};

export type WorkspaceViewProvenance = {
workspaceId: string;
sourceFields: string[];
composerVersion: "context-composer-v1";
};

export type WorkspaceContextSufficiencyRisk = "low" | "medium" | "high";

export type WorkspaceContextComposerReport = {
role: WorkspaceRole;
budgetTokens: number;
estimatedTokens: number;
budgetUtilization: number;
includedFacts: WorkspaceContextFactSelection[];
excludedFacts: WorkspaceContextFactExclusion[];
provenance: WorkspaceViewProvenance;
contextSufficiencyRisk: WorkspaceContextSufficiencyRisk;
};

export type WorkspaceRoleView = {
role: WorkspaceRole;
visibleFields: string[];
writableFields: string[];
tokenBudget: number;
estimatedTokens: number;
budgetUtilization: number;
includedFacts: WorkspaceContextFactSelection[];
excludedFacts: WorkspaceContextFactExclusion[];
provenance: WorkspaceViewProvenance;
contextSufficiencyRisk: WorkspaceContextSufficiencyRisk;
composerReport: WorkspaceContextComposerReport;
summary: string;
};

export type WorkspaceFinding = {
id: string;
severity: WorkspaceFindingSeverity;
category:
| "scope"
| "authority"
| "ownership"
| "module_boundary"
| "sensitive_boundary"
| "paired_file"
| "test"
| "trace"
| "verifier_adapter"
| "merge_safety";
message: string;
files: string[];
suggestedAction: WorkspaceDecision;
metadata?: Record<string, string>;
};

export type WorkspaceClaim = {
id: string;
actor: WorkspaceRole;
region: WorkspaceRegion;
summary: string;
status: WorkspaceClaimState;
evidenceIds: string[];

/**

* Agents write claims against the revision they saw.
* Merge can later reject stale claims instead of blindly trusting them.
  */
  baseRevision: number;

/**

* Optional write boundary. The orchestrator can enforce this later.
  */
  writableRegions?: WorkspaceRegion[];

confidence?: number;
createdAt: string;
};

export type WorkspacePatchPlan = {
id: string;
summary: string;
files: string[];
allowedEditRegions: string[];
forbiddenEditRegions: string[];
requiredSignals: string[];
createdBy: WorkspaceRole;
createdAt: string;
};

export type WorkspaceVerifierResult = {
id: string;
decision: WorkspaceDecision;
status: WorkspaceCheckStatus;
findings: WorkspaceFinding[];
checkedFiles: string[];

/**

* Verifier must point to local failed regions.
* This makes remask local, not a full rewrite.
  */
  failedRegions: WorkspaceRegion[];

summary: string;
createdBy: WorkspaceRole;
createdAt: string;
};

export type WorkspaceTestSignal = {
id: string;
status: WorkspaceCheckStatus;
checkName: string;
summary: string;
files: string[];
createdBy: WorkspaceRole;
createdAt: string;
};

export type WorkspaceRemaskRequest = {
id: string;
required: boolean;
reason: string;
failedRegions: WorkspaceRegion[];
files: string[];
instruction: string;
requestedBy: WorkspaceRole;
createdAt: string;
};

export type WorkspaceConflict = {
id: string;
kind:
| "claim_conflict"
| "authority_conflict"
| "scope_conflict"
| "patch_conflict"
| "stale_claim"
| "unsafe_overwrite";
summary: string;
claimIds: string[];
files: string[];
severity: WorkspaceRiskLevel;
detectedBy: WorkspaceRole;
createdAt: string;
resolvedByClaimId?: string;
};

export type WorkspaceMergeSafetyReport = {
ok: boolean;
findings: WorkspaceConflict[];
conflictCount: number;
staleClaimCount: number;
unsafeOverwriteCount: number;
authorityViolationCount: number;
};

export type WorkspaceMergeDecision = {
decision: WorkspaceDecision;
riskLevel: WorkspaceRiskLevel;
reason: string;
decidedBy: WorkspaceRole;
safetyReport?: WorkspaceMergeSafetyReport;
createdAt: string;
};

export type WorkspaceFinalResult = {
decision?: WorkspaceDecision;
summary: string;
createdBy: WorkspaceRole;
createdAt: string;
};

export type WorkspaceTraceEvent = {
id: string;
actor: WorkspaceRole;
action: WorkspaceAction;
summary: string;
region?: WorkspaceRegion;
relatedIds: string[];
relatedClaimIds: string[];
createdAt: string;
};

export type SharedSemanticWorkspace = {
id: string;
schemaVersion: "shared-semantic-workspace/v1";

/**

* revision is the mutation counter.
* It is not a schema version and must not be used as a public contract version.
  */
  revision: number;

/**

* sourcePacket keeps research compatibility without making packet the center
* of the product runtime model.
  */
  sourcePacket?: BoundedContextPacket;

task: WorkspaceTask;
scope: WorkspaceScope;
authority: WorkspaceAuthority;
policy: WorkspacePolicy;
repoFacts: WorkspaceRepoFacts;
patchIntent: WorkspacePatchIntent;

activeRoles: WorkspaceRole[];
roleViews: Partial<Record<WorkspaceRole, WorkspaceRoleView>>;

claims: WorkspaceClaim[];
conflicts: WorkspaceConflict[];
maskedRegions: WorkspaceRegion[];

patchPlan?: WorkspacePatchPlan;
verifierResults: WorkspaceVerifierResult[];
testSignals: WorkspaceTestSignal[];
remaskRequests: WorkspaceRemaskRequest[];

mergeDecision?: WorkspaceMergeDecision;
finalResult?: WorkspaceFinalResult;

/**

* Trace is the audit log of the workspace.
* This is why the project is not just "agents chatting".
  */
  trace: WorkspaceTraceEvent[];
  };

export type CreateWorkspaceInput = {
id: string;
task: WorkspaceTask;
scope: WorkspaceScope;
authority: WorkspaceAuthority;
policy: WorkspacePolicy;
repoFacts: WorkspaceRepoFacts;
patchIntent: WorkspacePatchIntent;
roleViews?: Partial<Record<WorkspaceRole, WorkspaceRoleView>>;
activeRoles?: WorkspaceRole[];
sourcePacket?: BoundedContextPacket;
createdAt?: string;
};

export function createWorkspace(input: CreateWorkspaceInput): SharedSemanticWorkspace {
const createdAt = input.createdAt ?? new Date().toISOString();

return {
id: input.id,
schemaVersion: "shared-semantic-workspace/v1",
revision: 1,
sourcePacket: input.sourcePacket,
task: input.task,
scope: input.scope,
authority: input.authority,
policy: input.policy,
repoFacts: input.repoFacts,
patchIntent: input.patchIntent,
activeRoles: input.activeRoles ?? [
"workspace_builder",
"context_composer",
"planner",
"coder",
"verifier",
"tester",
"remask",
"merge"
],
roleViews: input.roleViews ?? {},
claims: [],
conflicts: [],
maskedRegions: [],
verifierResults: [],
testSignals: [],
remaskRequests: [],
trace: [
{
id: `${input.id}-trace-created`,
actor: "workspace_builder",
action: "workspace_created",
region: "task",
summary: "Workspace was created from task, scope, authority, policy, repo facts and patch intent.",
relatedIds: [input.task.id],
relatedClaimIds: [],
createdAt
}
]
};
}

export function setRoleViews(
workspace: SharedSemanticWorkspace,
roleViews: Partial<Record<WorkspaceRole, WorkspaceRoleView>>,
createdAt = new Date().toISOString()
): SharedSemanticWorkspace {
return withTraceEvent({
...workspace,
roleViews
}, {
id: `${workspace.id}-trace-role-views-${workspace.trace.length + 1}`,
actor: "context_composer",
action: "role_views_set",
region: "role_view",
summary: "Role-specific bounded working memory views were attached to the workspace.",
relatedIds: Object.keys(roleViews),
relatedClaimIds: [],
createdAt
});
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
actor: claim.actor,
action: "claim_added",
region: claim.region,
summary: claim.summary,
relatedIds: [claim.id, ...claim.evidenceIds],
relatedClaimIds: [claim.id],
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
actor: patchPlan.createdBy,
action: "patch_plan_set",
region: "patch_plan",
summary: patchPlan.summary,
relatedIds: [patchPlan.id, ...patchPlan.files],
relatedClaimIds: [],
createdAt: patchPlan.createdAt
});
}

export function addVerifierResult(
workspace: SharedSemanticWorkspace,
verifierResult: WorkspaceVerifierResult
): SharedSemanticWorkspace {
return withTraceEvent({
...workspace,
verifierResults: [...workspace.verifierResults, verifierResult]
}, {
id: `${workspace.id}-trace-verifier-${verifierResult.id}`,
actor: verifierResult.createdBy,
action: "verifier_result_added",
region: "verifier_result",
summary: verifierResult.summary,
relatedIds: [
verifierResult.id,
...verifierResult.checkedFiles,
...verifierResult.findings.map((finding) => finding.id)
],
relatedClaimIds: [],
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
actor: testSignal.createdBy,
action: "test_signal_added",
region: "test_signal",
summary: `${testSignal.checkName}: ${testSignal.status}.`,
relatedIds: [testSignal.id, ...testSignal.files],
relatedClaimIds: [],
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
actor: remaskRequest.requestedBy,
action: "remask_request_added",
region: "remask_request",
summary: remaskRequest.reason,
relatedIds: [remaskRequest.id, ...remaskRequest.files],
relatedClaimIds: [],
createdAt: remaskRequest.createdAt
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
actor: conflict.detectedBy,
action: "conflict_added",
region: "conflict",
summary: conflict.summary,
relatedIds: [conflict.id, ...conflict.files],
relatedClaimIds: conflict.claimIds,
createdAt: conflict.createdAt
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
actor: mergeDecision.decidedBy,
action: "merge_decision_set",
region: "merge_decision",
summary: mergeDecision.reason,
relatedIds: [],
relatedClaimIds: [],
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
actor: finalResult.createdBy,
action: "final_result_set",
region: "final_result",
summary: finalResult.summary,
relatedIds: [],
relatedClaimIds: [],
createdAt: finalResult.createdAt
});
}

export function markRegionsMasked(
workspace: SharedSemanticWorkspace,
regions: WorkspaceRegion[],
actor: WorkspaceRole,
reason: string,
createdAt = new Date().toISOString()
): SharedSemanticWorkspace {
const maskedRegions = Array.from(new Set([
...workspace.maskedRegions,
...regions
]));

return withTraceEvent({
...workspace,
maskedRegions
}, {
id: `${workspace.id}-trace-mask-${workspace.trace.length + 1}`,
actor,
action: "region_masked",
region: regions[0],
summary: reason,
relatedIds: regions,
relatedClaimIds: [],
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
actor: "system",
action: "workspace_deserialized",
summary: "Workspace was deserialized and validated.",
relatedIds: [],
relatedClaimIds: [],
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

if (typeof value.revision !== "number") {
throw new Error("Invalid SharedWorkspace payload: revision must be a number.");
}

if (!value.task || typeof value.task !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing task.");
}

if (!value.scope || typeof value.scope !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing scope.");
}

if (!value.authority || typeof value.authority !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing authority.");
}

if (!value.policy || typeof value.policy !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing policy.");
}

if (!value.repoFacts || typeof value.repoFacts !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing repo facts.");
}

if (!value.patchIntent || typeof value.patchIntent !== "object") {
throw new Error("Invalid SharedWorkspace payload: missing patch intent.");
}

if (!Array.isArray(value.activeRoles)) {
throw new Error("Invalid SharedWorkspace payload: activeRoles must be an array.");
}

if (!Array.isArray(value.claims)) {
throw new Error("Invalid SharedWorkspace payload: claims must be an array.");
}

if (!Array.isArray(value.conflicts)) {
throw new Error("Invalid SharedWorkspace payload: conflicts must be an array.");
}

if (!Array.isArray(value.maskedRegions)) {
throw new Error("Invalid SharedWorkspace payload: maskedRegions must be an array.");
}

if (!Array.isArray(value.verifierResults)) {
throw new Error("Invalid SharedWorkspace payload: verifierResults must be an array.");
}

if (!Array.isArray(value.testSignals)) {
throw new Error("Invalid SharedWorkspace payload: testSignals must be an array.");
}

if (!Array.isArray(value.remaskRequests)) {
throw new Error("Invalid SharedWorkspace payload: remaskRequests must be an array.");
}

if (!Array.isArray(value.trace)) {
throw new Error("Invalid SharedWorkspace payload: trace must be an array.");
}
}
