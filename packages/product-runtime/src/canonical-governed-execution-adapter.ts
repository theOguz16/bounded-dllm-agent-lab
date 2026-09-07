import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAgentEvent, createAgentEventLedger, hashCanonicalJson,
  type AgentEventDraft, type AgentEventLedger } from "./agent-event-ledger.js";
import {
  evaluateAcceptanceCriteria,
  verifyAcceptanceCriteriaContract,
  verifyAcceptanceCriteriaCoverageReceipt,
  type AcceptanceCriteriaContract,
  type AcceptanceCriteriaEvaluationResult,
  type HumanReviewAcceptanceEvidence
} from "./acceptance-criteria-contract.js";
import { authorizeContextSufficientPatch } from "./context-sufficiency-authorization.js";
import { buildContextToApplyBinding } from "./context-to-apply-binding.js";
import { buildControlledApplyHandoff, computeGovernedMutationHash } from "./controlled-apply-handoff.js";
import { evaluateControlledApplyExecutionGate } from "./controlled-apply-execution-gate.js";
import { inspectControlledRepository } from "./controlled-repository-inspection.js";
import { materializeControlledRollbackBundle } from "./controlled-rollback-bundle.js";
import { createValidationContainerIdentity, recoverValidationContainer,
  runContainerizedWorkspaceExecution } from "./containerized-workspace-execution-runner.js";
import { runIntegratedDisposableApply, type IntegratedDisposableApplyResult } from "./integrated-disposable-apply-coordinator.js";
import { buildRunAccountabilityTrace, type RunAccountabilityTrace } from "./run-accountability-trace.js";
import { validateShadowObservation, type ShadowObservation } from "./shadow-observer-contract.js";
import { DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY,
  assessDeterministicChangeRisk,
  evaluateDeterministicGovernance,
  type DeterministicGovernanceAssessment,
  type DeterministicRiskAssessment } from "./deterministic-governance-policy.js";
import { DEFAULT_ADMIN_INVOCATION_POLICY,
  evaluateAdminInvocationPolicy,
  type AdminInvocationAssessment } from "./admin-invocation-policy.js";
import { evaluateRiskBasedApprovalRoute,
  type RiskBasedApprovalAssessment } from "./risk-based-approval-router.js";
import { buildGovernedChangeArtifact, verifyGovernedChangeArtifactFreshness,
  type GovernedChangeArtifact, type GovernedChangeFreshnessSnapshot } from "./governed-change-artifact.js";
import { verifyRepairDraftMutation } from "./repair-draft-verifier-gate.js";
import { dryRunPatchApplication,
  type PatchApplicationDryRunResult } from "./patch-application-dry-run-gate.js";
import { applyToTemporaryWorkspace,
  type TemporaryWorkspaceApplyResult } from "./temporary-workspace-apply-gate.js";
import { parseTextFileUpdates } from "./text-file-update-contract.js";
import {
  buildTemporaryWorkspaceExecutionVerificationEvidence,
  buildValidationEvidence,
  computeTemporaryWorkspaceExecutionSpecificationHash,
  type TemporaryWorkspaceExecutionVerificationEvidence,
  type TemporaryWorkspaceExecutionSpecification
} from "./temporary-workspace-execution-verifier.js";
import type { ValidationEvidence, ValidationProfileId } from "./runtime-contract-foundation.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";
import { createCanonicalRepositoryContentSnapshot } from "./canonical-policy-compiler.js";

export const CANONICAL_GOVERNED_ADAPTER_VERSION = "canonical-governed-adapter/v1" as const;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class CanonicalGovernedExecutionError extends Error {
  readonly code: string;
  readonly route: "replan_required" | "human_review_required" | "recovery_required";

  constructor(code: string, message: string,
    route: "replan_required" | "human_review_required" | "recovery_required") {
    super(message);
    this.name = "CanonicalGovernedExecutionError";
    this.code = code;
    this.route = route;
  }
}

export type CanonicalGovernedAdapterReceipt = Readonly<{
  adapterVersion: typeof CANONICAL_GOVERNED_ADAPTER_VERSION;
  taskId: string;
  objectiveHash: string;
  planHash: string;
  contextBindingHash: string;
  plannerExecutionBindingHash: string;
  compiledPolicyHash: string;
  coderMutationHash: string;
  verifierFindingHash: string;
  repairMutationHash: string;
  losslessPayloadHash: string;
  receiptHash: string;
}>;

export type CanonicalGovernedExecutionConfiguration = Readonly<{
  registryDirectoryPath: string;
  rollbackBundleParentPath: string;
  validationWorkspaceParentPath: string;
  phaseVExecutionSpecification: TemporaryWorkspaceExecutionSpecification;
}>;

export type CanonicalGovernedExecutionInput = Readonly<{
  taskId: string;
  objectiveHash: string;
  repositoryPath: string;
  planHash: string;
  contextBindingHash: string;
  plannerExecutionBindingHash: string;
  compiledPolicyHash: string;
  coderMutation: WorkspaceMutation;
  verifierFinding: WorkspaceMutation;
  adaptiveResult: unknown;
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  humanReviewEvidence?: readonly HumanReviewAcceptanceEvidence[];
  declaredRiskClass?: "low" | "medium" | "high" | "critical";
  configuration: CanonicalGovernedExecutionConfiguration;
  durableCheckpoint?: (state: "phase_v_prepared" | "phase_v_started" | "phase_v_completed" |
    "governed_apply_prepared" | "governed_apply_started" |
    "x4_committed" | "validation_started" | "validation_completed", artifact: unknown) => void | Promise<void>;
}>;

export type CanonicalGovernedExecutionResult = Readonly<{
  adapterReceipt: CanonicalGovernedAdapterReceipt;
  repairMutation: WorkspaceMutation;
  governanceReceipts: CanonicalGovernanceReceipts;
  integratedResult: IntegratedDisposableApplyResult;
}>;

export type CanonicalPreparedGovernedMutation = Readonly<{
  adapterReceipt: CanonicalGovernedAdapterReceipt;
  repairMutation: WorkspaceMutation;
  governanceReceipts: CanonicalGovernanceReceipts;
  acceptanceEvaluation: AcceptanceCriteriaEvaluationResult;
}>;

export type CanonicalGovernanceReceipts = Readonly<{
  coderVerifierFinding: WorkspaceMutation;
  repairVerifierFinding: WorkspaceMutation;
  patchDryRun: PatchApplicationDryRunResult;
  temporaryApply: TemporaryWorkspaceApplyResult;
  phaseVExecutionVerification: TemporaryWorkspaceExecutionVerificationEvidence;
  phaseVAcceptanceEvaluation: AcceptanceCriteriaEvaluationResult;
  deterministicRiskAssessment: DeterministicRiskAssessment;
  finalLedger: AgentEventLedger;
  preShadowTrace: RunAccountabilityTrace;
  shadowObservation: ShadowObservation;
  governanceAssessment: DeterministicGovernanceAssessment;
  adminInvocationAssessment: AdminInvocationAssessment;
  approvalRouteAssessment: RiskBasedApprovalAssessment;
  governedArtifact: GovernedChangeArtifact;
}>;

export type CanonicalNoChangeAcceptanceResult = Readonly<{
  decision: "no_change_accepted" | "no_change_rejected";
  route: "contract_approved" | "replan_required" | "human_review_required";
  acceptanceContractHash: string;
  acceptanceEvaluationReceiptHash: string | null;
  validationSpecificationHash: string;
  validationEvidence: ValidationEvidence;
  executionVerificationHash: string | null;
  beforeInspectionHash: string | null;
  afterInspectionHash: string | null;
  receiptHash: string | null;
}>;

function assertHash(value: string, field: string): void {
  if (!HASH.test(value)) throw new TypeError(`${field} must be a sha256 hash.`);
}

function assertApprovedCoderVerifierFinding(finding: WorkspaceMutation,
  mutation: WorkspaceMutation, compiledPolicyHash: string): void {
  const claim = finding.claims.length === 1 && finding.claims[0] !== null &&
    typeof finding.claims[0] === "object" && !Array.isArray(finding.claims[0])
    ? finding.claims[0] as Record<string, unknown> : null;
  const valid = finding.role === "verifier" && finding.target === "verifierFinding" &&
    claim?.type === "deterministic_verifier_v2_finding" &&
    claim.version === "deterministic-verifier/v2" && claim.decision === "approve" &&
    claim.policyHash === compiledPolicyHash &&
    hashCanonicalJson(finding.touchedFiles) === hashCanonicalJson(mutation.touchedFiles);
  if (!valid) {
    throw new CanonicalGovernedExecutionError("canonical_coder_verifier_receipt_invalid",
      "Canonical governed execution requires the approved verifier v2 finding for this coder mutation.",
      "human_review_required");
  }
}

export function adaptVerifiedCoderMutation(input: {
  taskId: string;
  objectiveHash: string;
  planHash: string;
  contextBindingHash: string;
  plannerExecutionBindingHash: string;
  compiledPolicyHash: string;
  coderMutation: WorkspaceMutation;
  verifierFindingHash: string;
}): { repairMutation: WorkspaceMutation; receipt: CanonicalGovernedAdapterReceipt } {
  const compiledPolicyHash = input.compiledPolicyHash;
  for (const [field, value] of [["objectiveHash", input.objectiveHash], ["planHash", input.planHash],
    ["contextBindingHash", input.contextBindingHash], ["plannerExecutionBindingHash", input.plannerExecutionBindingHash],
    ["compiledPolicyHash", compiledPolicyHash],
    ["verifierFindingHash", input.verifierFindingHash]] as const) assertHash(value, field);
  const claims = parseTextFileUpdates(input.coderMutation);
  const repairClaims = claims.map((claim) => ({ ...claim, type: "repair_draft" as const }));
  const repairMutation: WorkspaceMutation = {
    role: "remask", target: "repairDraft", summary: input.coderMutation.summary,
    claims: repairClaims, touchedFiles: [...input.coderMutation.touchedFiles],
    ...(input.coderMutation.confidence === undefined ? {} : { confidence: input.coderMutation.confidence })
  };
  parseTextFileUpdates(repairMutation);
  const sourcePayload = claims.map(({ type: _, ...claim }) => claim);
  const repairPayload = repairClaims.map(({ type: _, ...claim }) => claim);
  if (hashCanonicalJson(sourcePayload) !== hashCanonicalJson(repairPayload) ||
      hashCanonicalJson(input.coderMutation.touchedFiles) !== hashCanonicalJson(repairMutation.touchedFiles)) {
    throw new TypeError("Coder-to-repair mutation conversion lost information.");
  }
  const core = {
    adapterVersion: CANONICAL_GOVERNED_ADAPTER_VERSION,
    taskId: input.taskId, objectiveHash: input.objectiveHash, planHash: input.planHash,
    contextBindingHash: input.contextBindingHash,
    plannerExecutionBindingHash: input.plannerExecutionBindingHash,
    compiledPolicyHash,
    coderMutationHash: hashCanonicalJson(input.coderMutation),
    verifierFindingHash: input.verifierFindingHash,
    repairMutationHash: computeGovernedMutationHash("repair_draft", repairMutation),
    losslessPayloadHash: hashCanonicalJson({ claims: sourcePayload, touchedFiles: input.coderMutation.touchedFiles })
  };
  return { repairMutation, receipt: Object.freeze({ ...core, receiptHash: hashCanonicalJson(core) }) };
}

type CanonicalPhaseVReceipts = Awaited<ReturnType<typeof phaseVEvidence>>;

export function buildCanonicalFreshnessSnapshot(input: Readonly<{
  adapterReceipt: CanonicalGovernedAdapterReceipt;
  repairMutation: WorkspaceMutation;
  receipts: CanonicalGovernanceReceipts;
}>): GovernedChangeFreshnessSnapshot {
  const updates = parseTextFileUpdates(input.repairMutation);
  const mutationHash = computeGovernedMutationHash("repair_draft", input.repairMutation);
  const changedFiles = updates.map((claim) => claim.file);
  const patchDryRunResultHash = hashCanonicalJson(input.receipts.patchDryRun);
  const temporaryApplyResultHash = hashCanonicalJson(input.receipts.temporaryApply);
  const phaseV = input.receipts.phaseVExecutionVerification;
  const ledger = input.receipts.finalLedger;
  const trace = input.receipts.preShadowTrace;
  const observation = input.receipts.shadowObservation;
  const governance = input.receipts.governanceAssessment;
  const invocation = input.receipts.adminInvocationAssessment;
  const router = input.receipts.approvalRouteAssessment;
  const rebuilt = buildGovernedChangeArtifact({ finalLedger: ledger,
    finalLedgerAnchors: { expectedRunId: ledger.runId,
      expectedObjectiveHash: ledger.objectiveHash, expectedRootHash: ledger.rootHash,
      expectedEventCount: ledger.eventCount },
    preShadowTrace: trace, shadowObservation: observation,
    governanceAssessment: governance, adminInvocationAssessment: invocation,
    adminDecision: null, approvalRouterAssessment: router,
    change: { changeKind: "repair_draft", mutationHash, changedFiles,
      patchDryRunResultHash, temporaryApplyResultHash,
      executionVerificationResultHash: phaseV.verificationResultHash } });
  const sourcesValid = mutationHash === input.adapterReceipt.repairMutationHash &&
    hashCanonicalJson(input.receipts.coderVerifierFinding) === input.adapterReceipt.verifierFindingHash &&
    rebuilt.decision === "governed_change_artifact_ready" && rebuilt.artifact !== null &&
    rebuilt.artifact.governedArtifactHash === input.receipts.governedArtifact.governedArtifactHash;
  if (!sourcesValid) {
    throw new CanonicalGovernedExecutionError("canonical_freshness_receipts_invalid",
      "Freshness sources did not reproduce the governed artifact.", "human_review_required");
  }
  const snapshot: GovernedChangeFreshnessSnapshot = Object.freeze({
    runId: ledger.runId, objectiveHash: ledger.objectiveHash,
    mutationHash, changedFiles, patchDryRunResultHash, temporaryApplyResultHash,
    executionVerificationResultHash: phaseV.verificationResultHash,
    preShadowTraceHash: trace.traceHash, observationHash: observation.observationHash,
    governanceHash: governance.governanceHash,
    adminInvocationPolicyHash: invocation.policyHash,
    adminInvocationAssessmentHash: invocation.assessmentHash,
    adminDecisionHash: null, routeHash: router.routeHash,
    governancePolicyHash: governance.policyHash, routerPolicyHash: router.policyHash,
    finalLedgerRootHash: ledger.rootHash, finalLedgerEventCount: ledger.eventCount,
    phaseVFinalDecision: phaseV.decision, workflowRoute: router.route });
  const verification = verifyGovernedChangeArtifactFreshness(
    input.receipts.governedArtifact, snapshot);
  if (verification.decision !== "governed_change_current" || !verification.handoffEligible) {
    throw new CanonicalGovernedExecutionError("canonical_freshness_verification_failed",
      "Receipt-derived freshness did not match the governed artifact.",
      "human_review_required");
  }
  return snapshot;
}

function appendLedgerEvent(ledger: AgentEventLedger, actor: AgentEventDraft["actor"],
  action: string, values: Partial<AgentEventDraft>): AgentEventLedger {
  const timestamp = new Date().toISOString();
  return appendAgentEvent(ledger, { actor, action, startedAt: timestamp, finishedAt: timestamp,
    inputArtifactHashes: [], outputArtifactHashes: [], filesRead: [], filesProposed: [],
    decision: null, reasonCodes: [], ...values });
}

function buildRealGovernanceReceipts(input: CanonicalGovernedExecutionInput,
  adapter: CanonicalGovernedAdapterReceipt, phase: CanonicalPhaseVReceipts,
  acceptanceEvaluation: AcceptanceCriteriaEvaluationResult,
  contextAuthorizationHash: string): CanonicalGovernanceReceipts {
  const files = [...phase.changedFiles];
  const runId = `canonical:${adapter.receiptHash.slice(7, 39)}`;
  let ledger = createAgentEventLedger({ runId, objectiveHash: input.objectiveHash });
  const add = (actor: AgentEventDraft["actor"], action: string, values: Partial<AgentEventDraft>) => {
    ledger = appendLedgerEvent(ledger, actor, action, values);
  };
  add("planner", "planner.plan", { inputArtifactHashes: [input.plannerExecutionBindingHash],
    outputArtifactHashes: [input.planHash],
    filesProposed: files, decision: "plan_ready" });
  add("coder", "coder.patch_draft", { inputArtifactHashes: [input.planHash, input.contextBindingHash],
    outputArtifactHashes: [adapter.coderMutationHash], filesRead: files,
    filesProposed: files, decision: "patch_draft_ready" });
  add("deterministic_verifier", "deterministic_verifier.evaluate", {
    inputArtifactHashes: [adapter.coderMutationHash],
    outputArtifactHashes: [adapter.verifierFindingHash], filesRead: files, decision: "approve" });
  add("deterministic_transformer", "deterministic_transformer.text_file_update_conversion", {
    inputArtifactHashes: [adapter.coderMutationHash, adapter.receiptHash],
    outputArtifactHashes: [adapter.repairMutationHash], filesRead: files,
    filesProposed: files, decision: "deterministic_conversion_completed",
    reasonCodes: ["no_model_call"] });
  add("deterministic_verifier", "deterministic_verifier.repair_format", {
    inputArtifactHashes: [adapter.repairMutationHash],
    outputArtifactHashes: [phase.repairVerifierReceiptHash], filesRead: files, decision: "approve",
    reasonCodes: ["deterministic_check_no_model_call"] });
  add("patch_dry_run", "patch_dry_run.evaluate", {
    inputArtifactHashes: [adapter.repairMutationHash],
    outputArtifactHashes: [phase.patchDryRunReceiptHash], filesRead: files,
    filesProposed: files, decision: "ready_to_apply" });
  add("temp_workspace_apply", "temp_workspace_apply.apply", {
    inputArtifactHashes: [phase.patchDryRunReceiptHash],
    outputArtifactHashes: [phase.temporaryApplyReceiptHash], filesRead: files,
    filesProposed: files, decision: "temp_apply_ready" });
  add("execution_verifier", "execution_verifier.validate", {
    inputArtifactHashes: [phase.temporaryApplyReceiptHash],
    outputArtifactHashes: [phase.verification.verificationResultHash,
      acceptanceEvaluation.receipt!.receiptHash], filesRead: files,
    decision: phase.verification.decision,
    reasonCodes: ["temp_workspace_cleanup_performed"] });
  const preLedger = ledger;
  const traceResult = buildRunAccountabilityTrace(preLedger, { expectedRunId: runId,
    expectedObjectiveHash: input.objectiveHash, expectedRootHash: preLedger.rootHash,
    expectedEventCount: preLedger.eventCount });
  if (traceResult.decision !== "trace_ready" || !traceResult.trace) {
    throw new CanonicalGovernedExecutionError("canonical_accountability_trace_failed",
      "Real Phase V receipts did not produce a valid accountability trace.", "human_review_required");
  }
  const trace = traceResult.trace;
  const riskAssessment = assessDeterministicChangeRisk({ changedFiles: files,
    allowedFiles: input.allowedFiles, forbiddenFiles: input.forbiddenFiles,
    declaredRiskClass: input.declaredRiskClass,
    mutationHash: adapter.repairMutationHash, authorizationHash: contextAuthorizationHash,
    validationEvidenceHash: phase.verification.verificationResultHash,
    acceptanceEvidenceHash: acceptanceEvaluation.receipt?.receiptHash });
  const observedRisk = riskAssessment.riskClass === "unknown" ? "high" : riskAssessment.riskClass;
  const riskSeverity = observedRisk === "low" ? "info" : observedRisk === "medium" ? "warning" :
    observedRisk === "high" ? "high" : "critical";
  const shadowResult = validateShadowObservation(trace, { observationVersion: "1", runId,
    traceHash: trace.traceHash, riskLevel: observedRisk, riskScore: riskAssessment.riskScore,
    confidenceScore: riskAssessment.confidenceScore,
    findings: [{ code: riskAssessment.reasonCodes[0]!, severity: riskSeverity,
      message: "Deterministic policy assessed change risk from bound scope and validation evidence.",
      evidenceEventIds: trace.events.map((event) => event.eventId),
      evidenceFilePaths: files, evidenceTraceFindingCodes: [] }],
    observedScopeDrift: false, observedPlanPatchMismatch: false,
    observedRepairLoop: false, observedSuspiciousRoleBehavior: false,
    observedEvidenceConflict: false, recommendation: riskAssessment.recommendation,
    rationaleCodes: [...riskAssessment.reasonCodes] });
  if (shadowResult.decision !== "shadow_observation_valid" || !shadowResult.observation) {
    throw new CanonicalGovernedExecutionError("canonical_shadow_receipt_failed",
      "Deterministic risk evidence could not be bound to the Phase V trace.", "human_review_required");
  }
  const observation = shadowResult.observation;
  const governanceResult = evaluateDeterministicGovernance(trace, observation,
    { ...DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY });
  if (governanceResult.decision !== "governance_passed" || !governanceResult.assessment) {
    throw new CanonicalGovernedExecutionError("canonical_governance_receipt_failed",
      "Deterministic policy did not approve the real Phase V receipts.", "human_review_required");
  }
  const governance = governanceResult.assessment;
  const invocationResult = evaluateAdminInvocationPolicy({ phaseVFinalDecision: phase.verification.decision,
    trace, shadow: { stageDecision: "shadow_observer_completed",
      validationDecision: "shadow_observation_valid", observation }, governance },
  { ...DEFAULT_ADMIN_INVOCATION_POLICY, mode: "conditional" });
  if (!invocationResult.assessment || invocationResult.assessment.decision !== "admin_invocation_skipped") {
    throw new CanonicalGovernedExecutionError("canonical_policy_receipt_failed",
      "Real policy receipt did not authorize the clean automatic route.", "human_review_required");
  }
  const invocation = invocationResult.assessment;
  const routerResult = evaluateRiskBasedApprovalRoute({ phaseVFinalDecision: phase.verification.decision,
    trace, shadow: { stageDecision: "shadow_observer_completed",
      validationDecision: "shadow_observation_valid", observation }, governance,
    admin: { invocation, stageDecision: "admin_skipped_by_policy",
      validationDecision: null, decision: null } });
  if (routerResult.decision !== "approval_route_valid" ||
      routerResult.route !== "auto_continue" || !routerResult.assessment) {
    throw new CanonicalGovernedExecutionError("canonical_route_receipt_failed",
      "Real route receipt did not permit automatic continuation.", "human_review_required");
  }
  const router = routerResult.assessment;
  add("deterministic_risk_assessor", "deterministic_risk_assessor.evaluate", {
    inputArtifactHashes: [trace.traceHash, ...riskAssessment.evidenceHashes],
    outputArtifactHashes: [riskAssessment.assessmentHash, observation.observationHash], filesRead: files,
    decision: "deterministic_risk_assessment_completed",
    reasonCodes: [...riskAssessment.reasonCodes] });
  add("deterministic_governor", "deterministic_governor.evaluate", {
    inputArtifactHashes: [trace.traceHash, governance.policyHash, observation.observationHash],
    outputArtifactHashes: [governance.governanceHash], filesRead: files,
    decision: governance.decision, reasonCodes: [...governance.reasonCodes] });
  add("admin_invocation_policy", "admin_invocation_policy.evaluate", {
    inputArtifactHashes: [trace.traceHash, governance.governanceHash, invocation.policyHash,
      observation.observationHash], outputArtifactHashes: [invocation.assessmentHash],
    filesRead: files, decision: invocation.decision, reasonCodes: [...invocation.reasonCodes] });
  add("approval_router", "approval_router.evaluate", {
    inputArtifactHashes: [trace.traceHash, governance.governanceHash, invocation.policyHash,
      invocation.assessmentHash, router.policyHash, observation.observationHash],
    outputArtifactHashes: [router.routeHash], filesRead: files,
    decision: router.route, reasonCodes: [...router.reasonCodes] });
  const built = buildGovernedChangeArtifact({ finalLedger: ledger,
    finalLedgerAnchors: { expectedRunId: runId, expectedObjectiveHash: input.objectiveHash,
      expectedRootHash: ledger.rootHash, expectedEventCount: ledger.eventCount },
    preShadowTrace: trace, shadowObservation: observation, governanceAssessment: governance,
    adminInvocationAssessment: invocation, adminDecision: null,
    approvalRouterAssessment: router, change: { changeKind: "repair_draft",
      mutationHash: adapter.repairMutationHash, changedFiles: files,
      patchDryRunResultHash: phase.patchDryRunReceiptHash,
      temporaryApplyResultHash: phase.temporaryApplyReceiptHash,
      executionVerificationResultHash: phase.verification.verificationResultHash } });
  if (built.decision !== "governed_change_artifact_ready" || !built.artifact) {
    throw new CanonicalGovernedExecutionError("canonical_governed_artifact_failed",
      built.issues[0]?.message ?? "Real governed receipts did not produce an eligible artifact.",
      "human_review_required");
  }
  return Object.freeze({ coderVerifierFinding: input.verifierFinding,
    repairVerifierFinding: phase.repairVerifierFinding,
    patchDryRun: phase.patchDryRun, temporaryApply: phase.temporaryApply,
    phaseVExecutionVerification: phase.verification,
    phaseVAcceptanceEvaluation: acceptanceEvaluation,
    deterministicRiskAssessment: riskAssessment,
    finalLedger: ledger, preShadowTrace: trace, shadowObservation: observation,
    governanceAssessment: governance, adminInvocationAssessment: invocation,
    approvalRouteAssessment: router, governedArtifact: built.artifact });
}

function approvedAcceptanceEvaluation(contract: AcceptanceCriteriaContract,
  specification: TemporaryWorkspaceExecutionSpecification,
  evidence: TemporaryWorkspaceExecutionVerificationEvidence,
  humanReviewEvidence?: readonly HumanReviewAcceptanceEvidence[],
  expected?: Readonly<{ taskId: string; objectiveHash: string }>): AcceptanceCriteriaEvaluationResult {
  if (!verifyAcceptanceCriteriaContract(contract, expected)) {
    throw new CanonicalGovernedExecutionError("canonical_acceptance_contract_invalid",
      "Original acceptance criteria contract is corrupt or bound to another task.",
      "human_review_required");
  }
  const evaluation = evaluateAcceptanceCriteria({
    contract,
    executionSpecification: specification,
    executionEvidence: evidence,
    humanReviewEvidence
  });
  const verification = evaluation.receipt === null ? null :
    verifyAcceptanceCriteriaCoverageReceipt(evaluation.receipt,
      contract, evidence);
  if (evaluation.decision !== "contract_approved" || evaluation.receipt === null ||
      verification === null || !verification.downstreamEligible) {
    const route = evaluation.decision === "contract_failed"
      ? "replan_required" as const : "human_review_required" as const;
    throw new CanonicalGovernedExecutionError(
      evaluation.decision === "contract_needs_review"
        ? "canonical_acceptance_human_review_required"
        : evaluation.decision === "contract_failed"
          ? "canonical_acceptance_contract_failed"
          : "canonical_acceptance_contract_invalid",
      evaluation.issues[0]?.message ??
        "Original acceptance criteria are not satisfied by the trusted Phase V evidence.",
      route);
  }
  return evaluation;
}

async function phaseVEvidence(repository: string, mutation: WorkspaceMutation,
  specification: TemporaryWorkspaceExecutionSpecification,
  allowedFiles: readonly string[], forbiddenFiles: readonly string[],
  lifecycle?: Readonly<{ bindingHash: string; workspaceParentPath: string;
    checkpoint?: CanonicalGovernedExecutionInput["durableCheckpoint"] }>) {
  const claims = parseTextFileUpdates(mutation);
  // Validate the complete source tree before copying it.  The copy operation
  // must never proceed from a silently truncated inventory.
  createCanonicalRepositoryContentSnapshot(repository);
  const fileContents: Record<string, string> = {};
  for (const claim of claims) fileContents[claim.file] =
    await readFile(path.join(repository, claim.file), "utf8");
  const repairVerification = verifyRepairDraftMutation(mutation, { fileContents,
    allowedFiles: [...allowedFiles], forbiddenFiles: [...forbiddenFiles] });
  if (repairVerification.decision !== "approve") {
    throw new CanonicalGovernedExecutionError("canonical_repair_verifier_failed",
      repairVerification.issues[0]?.message ?? "Repair verifier did not approve the adapted mutation.",
      "human_review_required");
  }
  const dryRun = dryRunPatchApplication(mutation, repairVerification.finding, { fileContents,
    allowedFiles: [...allowedFiles], forbiddenFiles: [...forbiddenFiles] });
  if (dryRun.decision !== "ready_to_apply") {
    throw new CanonicalGovernedExecutionError("canonical_patch_dry_run_failed",
      dryRun.issues[0]?.message ?? "Patch dry run did not approve the adapted mutation.",
      "replan_required");
  }
  const temporaryApply = applyToTemporaryWorkspace(mutation, repairVerification.finding,
    dryRun, { fileContents, allowedFiles: [...allowedFiles],
      forbiddenFiles: [...forbiddenFiles], cleanup: false });
  if (temporaryApply.decision !== "temp_apply_ready" || !temporaryApply.tempWorkspacePath) {
    throw new CanonicalGovernedExecutionError("canonical_temporary_apply_failed",
      temporaryApply.issues[0]?.message ?? "Temporary apply did not materialize the mutation.",
      "replan_required");
  }
  const phaseReceipts = await (async () => {
    try {
      return { repairVerifierReceiptHash: hashCanonicalJson(repairVerification.finding),
        patchDryRunReceiptHash: hashCanonicalJson(dryRun),
        temporaryApplyReceiptHash: hashCanonicalJson(temporaryApply) };
    } finally {
      await rm(temporaryApply.tempWorkspacePath!, { recursive: true, force: true });
    }
  })();
  const phaseBindingHash = lifecycle?.bindingHash ?? hashCanonicalJson({
    artifactType: "canonical_phase_v_ephemeral", mutation: hashCanonicalJson(mutation),
    specification: computeTemporaryWorkspaceExecutionSpecificationHash(specification)
  });
  const workspaceParent = lifecycle?.workspaceParentPath ?? os.tmpdir();
  const root = lifecycle ? path.join(workspaceParent,
    `canonical-phase-v-${phaseBindingHash.slice(7, 31)}.partial`) :
    await mkdtemp(path.join(workspaceParent, "canonical-phase-v-"));
  const markerPath = path.join(root, ".bounded-phase-v-owner.json");
  const containerIdentity = createValidationContainerIdentity(hashCanonicalJson({
    artifactType: "canonical_phase_v_container_binding", phaseBindingHash,
    validationSpecificationHash: computeTemporaryWorkspaceExecutionSpecificationHash(specification)
  }), undefined, lifecycle ? `bounded-validation-${phaseBindingHash.slice(7, 31)}` : undefined);
  const intent = { lifecycleVersion: "canonical-phase-v-lifecycle/v1", phaseBindingHash,
    workspacePath: root, containerIdentity };
  await lifecycle?.checkpoint?.("phase_v_prepared", intent);
  if (lifecycle) {
    const exists = await lstat(root).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (exists) {
      let owner: unknown = null;
      try { owner = JSON.parse(await readFile(markerPath, "utf8")); } catch {}
      if (hashCanonicalJson(owner) !== hashCanonicalJson({ lifecycleVersion: intent.lifecycleVersion,
          phaseBindingHash })) throw new CanonicalGovernedExecutionError(
        "canonical_phase_v_workspace_ownership_ambiguous",
        "An existing Phase V workspace has no matching durable ownership marker.", "recovery_required");
      const recovered = recoverValidationContainer(containerIdentity);
      if (!new Set(["validation_container_removed", "validation_container_absent"]).has(recovered.decision))
        throw new CanonicalGovernedExecutionError("canonical_phase_v_container_recovery_required",
          "The recorded Phase V container could not be safely reconciled.", "recovery_required");
      await rm(root, { recursive: true, force: true });
    }
    await mkdir(root, { mode: 0o700 });
    await writeFile(markerPath, JSON.stringify({ lifecycleVersion: intent.lifecycleVersion,
      phaseBindingHash }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  let completed: Awaited<ReturnType<typeof buildTemporaryWorkspaceExecutionVerificationEvidence>> | null = null;
  let phaseResult: any = null;
  try {
    await cp(repository, root, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
    createCanonicalRepositoryContentSnapshot(root);
    for (const claim of parseTextFileUpdates(mutation)) {
      await mkdir(path.dirname(path.join(root, claim.file)), { recursive: true });
      await writeFile(path.join(root, claim.file), claim.newContent, "utf8");
    }
    await mkdir(path.join(root, ".validation-output"));
    await lifecycle?.checkpoint?.("phase_v_started", intent);
    const execution = await runContainerizedWorkspaceExecution({ tempWorkspacePath: root,
      tempApplyDecision: "temp_apply_ready", tempWorkspaceCleanedUp: false, ...specification }, async () => null,
      { containerIdentity, onLifecycleCheckpoint: lifecycle?.checkpoint === undefined ? undefined :
        async (containerLifecycle) => lifecycle.checkpoint!("phase_v_started",
          { ...intent, containerLifecycle }) });
    if (execution.decision !== "temp_validation_passed") {
      throw new CanonicalGovernedExecutionError("canonical_phase_v_validation_failed",
        "Phase V candidate validation failed.", "replan_required");
    }
    completed = buildTemporaryWorkspaceExecutionVerificationEvidence(
      specification, execution, true);
    phaseResult = { verification: completed,
      repairVerifierFinding: repairVerification.finding,
    patchDryRun: dryRun, temporaryApply,
    ...phaseReceipts,
      changedFiles: claims.map((claim) => claim.file) };
  } finally { await rm(root, { recursive: true, force: true }); }
  await lifecycle?.checkpoint?.("phase_v_completed", {
    phaseBindingHash, verificationResultHash: completed!.verificationResultHash,
    workspaceCleanedUp: true, containerIdentity });
  return phaseResult;
}

export async function verifyCanonicalNoChangeAcceptance(input: {
  taskId: string;
  objectiveHash: string;
  repositoryPath: string;
  touchedFiles: readonly string[];
  specification: TemporaryWorkspaceExecutionSpecification;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  humanReviewEvidence?: readonly HumanReviewAcceptanceEvidence[];
  validationProfile?: ValidationProfileId;
}): Promise<CanonicalNoChangeAcceptanceResult> {
  const specificationHash = computeTemporaryWorkspaceExecutionSpecificationHash(input.specification);
  const rejected = (route: "replan_required" | "human_review_required",
    values: Partial<CanonicalNoChangeAcceptanceResult> = {}): CanonicalNoChangeAcceptanceResult => ({
    decision: "no_change_rejected", route,
    acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
    acceptanceEvaluationReceiptHash: null,
    validationSpecificationHash: specificationHash,
    validationEvidence: buildValidationEvidence({
      profile: input.validationProfile ?? "structural_draft", structuralPassed: true,
      specification: input.specification
    }),
    executionVerificationHash: null, beforeInspectionHash: null,
    afterInspectionHash: null, receiptHash: null, ...values
  });
  const before = await inspectControlledRepository({ repositoryPath: input.repositoryPath,
    changedFiles: input.touchedFiles });
  if (before.decision !== "repository_inspection_ready" || !before.inspection) {
    return rejected("replan_required");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-no-change-"));
  let verificationHash: string | null = null;
  try {
    createCanonicalRepositoryContentSnapshot(input.repositoryPath);
    await cp(input.repositoryPath, root, { recursive: true,
      filter: (source) => path.basename(source) !== ".git" });
    createCanonicalRepositoryContentSnapshot(root);
    await mkdir(path.join(root, ".validation-output"));
    const execution = await runContainerizedWorkspaceExecution({ tempWorkspacePath: root,
      tempApplyDecision: "temp_apply_ready", tempWorkspaceCleanedUp: false,
      ...input.specification }, async () => null);
    if (execution.decision !== "temp_validation_passed") return rejected("replan_required", {
      beforeInspectionHash: before.inspection.inspectionHash, afterInspectionHash: null,
      receiptHash: null
    });
    const verification = buildTemporaryWorkspaceExecutionVerificationEvidence(
      input.specification, execution, true);
    const validationEvidence = buildValidationEvidence({
      profile: input.validationProfile ?? "structural_draft", structuralPassed: true,
      specification: input.specification, executionResult: execution
    });
    if (!validationEvidence.profileSatisfied) return rejected("replan_required", {
      executionVerificationHash: verification.verificationResultHash,
      beforeInspectionHash: before.inspection.inspectionHash,
      validationEvidence
    });
    verificationHash = verification.verificationResultHash;
    let evaluation: AcceptanceCriteriaEvaluationResult;
    try { evaluation = approvedAcceptanceEvaluation(input.acceptanceCriteriaContract,
      input.specification, verification, input.humanReviewEvidence,
      { taskId: input.taskId, objectiveHash: input.objectiveHash }); }
    catch (error) {
      const route = error instanceof CanonicalGovernedExecutionError &&
        error.route === "replan_required" ? "replan_required" : "human_review_required";
      return rejected(route, { executionVerificationHash: verificationHash,
        beforeInspectionHash: before.inspection.inspectionHash });
    }
    const evaluationReceiptHash = evaluation.receipt!.receiptHash;
    const after = await inspectControlledRepository({ repositoryPath: input.repositoryPath,
      changedFiles: input.touchedFiles });
    if (after.decision !== "repository_inspection_ready" || !after.inspection ||
        after.inspection.inspectionHash !== before.inspection.inspectionHash) return rejected(
      "replan_required", { executionVerificationHash: verificationHash,
        acceptanceEvaluationReceiptHash: evaluationReceiptHash,
        beforeInspectionHash: before.inspection.inspectionHash,
        afterInspectionHash: after.inspection?.inspectionHash ?? null });
    const core = { artifactType: "canonical_no_change_acceptance", taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      acceptanceEvaluationReceiptHash: evaluationReceiptHash,
      validationSpecificationHash: verification.validationSpecificationHash,
      validationEvidence,
      executionVerificationHash: verificationHash,
      beforeInspectionHash: before.inspection.inspectionHash,
      afterInspectionHash: after.inspection.inspectionHash };
    return { decision: "no_change_accepted", route: "contract_approved",
      acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      acceptanceEvaluationReceiptHash: evaluationReceiptHash,
      validationSpecificationHash: verification.validationSpecificationHash,
      validationEvidence,
      executionVerificationHash: verificationHash,
      beforeInspectionHash: before.inspection.inspectionHash,
      afterInspectionHash: after.inspection.inspectionHash,
      receiptHash: hashCanonicalJson(core) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function prepareCanonicalGovernedMutation(
  input: CanonicalGovernedExecutionInput
): Promise<CanonicalPreparedGovernedMutation> {
  assertApprovedCoderVerifierFinding(input.verifierFinding, input.coderMutation,
    input.compiledPolicyHash);
  const adapted = adaptVerifiedCoderMutation({ taskId: input.taskId,
    objectiveHash: input.objectiveHash, planHash: input.planHash,
    contextBindingHash: input.contextBindingHash,
    plannerExecutionBindingHash: input.plannerExecutionBindingHash,
    compiledPolicyHash: input.compiledPolicyHash,
    coderMutation: input.coderMutation,
    verifierFindingHash: hashCanonicalJson(input.verifierFinding) });
  const specification = input.configuration.phaseVExecutionSpecification;
  const evidence = await phaseVEvidence(input.repositoryPath, adapted.repairMutation,
    specification, input.allowedFiles, input.forbiddenFiles, {
      bindingHash: adapted.receipt.receiptHash,
      workspaceParentPath: input.configuration.validationWorkspaceParentPath,
      checkpoint: input.durableCheckpoint
    });
  const acceptanceEvaluation = approvedAcceptanceEvaluation(input.acceptanceCriteriaContract,
    specification, evidence.verification, input.humanReviewEvidence,
    { taskId: input.taskId, objectiveHash: input.objectiveHash });
  const contextAuthorization = authorizeContextSufficientPatch({ adaptiveResult: input.adaptiveResult as any,
    allowedFiles: input.allowedFiles, forbiddenFiles: input.forbiddenFiles,
    policyHash: input.compiledPolicyHash });
  if (contextAuthorization.decision !== "context_authorization_ready" ||
      !contextAuthorization.authorization) throw new CanonicalGovernedExecutionError(
    "canonical_context_authorization_failed",
    "Bound context did not authorize deterministic governance risk evaluation.", "replan_required");
  const governanceReceipts = buildRealGovernanceReceipts(input, adapted.receipt, evidence,
    acceptanceEvaluation, contextAuthorization.authorization.authorizationHash);
  return Object.freeze({ adapterReceipt: adapted.receipt,
    repairMutation: adapted.repairMutation, governanceReceipts, acceptanceEvaluation });
}

function assertPreparedMutationBoundToInput(input: CanonicalGovernedExecutionInput,
  prepared: CanonicalPreparedGovernedMutation): void {
  assertApprovedCoderVerifierFinding(input.verifierFinding, input.coderMutation,
    input.compiledPolicyHash);
  const expected = adaptVerifiedCoderMutation({ taskId: input.taskId,
    objectiveHash: input.objectiveHash, planHash: input.planHash,
    contextBindingHash: input.contextBindingHash,
    plannerExecutionBindingHash: input.plannerExecutionBindingHash,
    compiledPolicyHash: input.compiledPolicyHash,
    coderMutation: input.coderMutation,
    verifierFindingHash: hashCanonicalJson(input.verifierFinding) });
  let currentAcceptanceReceiptHash: string | null = null;
  try {
    currentAcceptanceReceiptHash = approvedAcceptanceEvaluation(input.acceptanceCriteriaContract,
      input.configuration.phaseVExecutionSpecification,
      prepared.governanceReceipts.phaseVExecutionVerification,
      input.humanReviewEvidence,
      { taskId: input.taskId, objectiveHash: input.objectiveHash }).receipt?.receiptHash ?? null;
  } catch {
    // A changed contract/specification/evidence tuple invalidates the prepared mutation binding.
  }
  if (prepared.adapterReceipt.receiptHash !== expected.receipt.receiptHash ||
      hashCanonicalJson(prepared.repairMutation) !== hashCanonicalJson(expected.repairMutation) ||
      prepared.acceptanceEvaluation.receipt === null ||
      prepared.acceptanceEvaluation.receipt.contractHash !== input.acceptanceCriteriaContract.contractHash ||
      prepared.acceptanceEvaluation.receipt.validationSpecificationHash !==
        prepared.governanceReceipts.phaseVExecutionVerification.validationSpecificationHash ||
      prepared.governanceReceipts.phaseVAcceptanceEvaluation.receipt?.receiptHash !==
        currentAcceptanceReceiptHash ||
      prepared.acceptanceEvaluation.receipt.receiptHash !==
        currentAcceptanceReceiptHash) {
    throw new CanonicalGovernedExecutionError("canonical_prepared_mutation_binding_invalid",
      "Prepared governance receipts are not bound to this canonical task input.",
      "human_review_required");
  }
}

export async function executePreparedCanonicalGovernedMutation(
  input: CanonicalGovernedExecutionInput,
  prepared: CanonicalPreparedGovernedMutation
): Promise<CanonicalGovernedExecutionResult> {
  assertPreparedMutationBoundToInput(input, prepared);
  const adapted = { receipt: prepared.adapterReceipt,
    repairMutation: prepared.repairMutation };
  const governanceReceipts = prepared.governanceReceipts;
  const specification = input.configuration.phaseVExecutionSpecification;
  const inspection = await inspectControlledRepository({ repositoryPath: input.repositoryPath,
    changedFiles: adapted.repairMutation.touchedFiles });
  if (inspection.decision !== "repository_inspection_ready" || !inspection.inspection) {
    throw new CanonicalGovernedExecutionError("canonical_x1_inspection_failed",
      "X.1 repository inspection failed.", "replan_required");
  }
  const artifact = governanceReceipts.governedArtifact;
  const currentFreshnessSnapshot = buildCanonicalFreshnessSnapshot({
    adapterReceipt: adapted.receipt, repairMutation: adapted.repairMutation,
    receipts: governanceReceipts
  });
  const handoff = buildControlledApplyHandoff({ artifact, currentFreshnessSnapshot,
    mutation: adapted.repairMutation, target: inspection.inspection.target });
  if (handoff.decision !== "controlled_apply_handoff_ready" || !handoff.handoff) {
    throw new CanonicalGovernedExecutionError("canonical_governed_handoff_failed",
      "Governed apply handoff failed.", "human_review_required");
  }
  const bundleDirectoryPath = path.join(input.configuration.rollbackBundleParentPath,
    `bundle-${adapted.receipt.receiptHash.slice(7)}`);
  const bundle = await materializeControlledRollbackBundle({ repositoryPath: input.repositoryPath,
    bundleDirectoryPath, changedFiles: adapted.repairMutation.touchedFiles,
    expectedInspection: inspection.inspection, handoff: handoff.handoff, artifact,
    currentFreshnessSnapshot, mutation: adapted.repairMutation, consumptionStatus: "not_consumed" });
  if (bundle.decision !== "rollback_bundle_ready" || !bundle.manifest || !bundle.receipt) {
    throw new CanonicalGovernedExecutionError("canonical_rollback_bundle_failed",
      bundle.issues[0]?.message ?? "Rollback bundle preparation failed.", "human_review_required");
  }
  const gateInput: any = { repositoryPath: input.repositoryPath, bundleDirectoryPath,
    changedFiles: [...adapted.repairMutation.touchedFiles], artifact, currentFreshnessSnapshot,
    mutation: adapted.repairMutation, handoff: handoff.handoff,
    expectedInspection: inspection.inspection, rollbackBundleManifest: bundle.manifest,
    rollbackBundleReceipt: bundle.receipt, consumptionStatus: "not_consumed" };
  const gate = await evaluateControlledApplyExecutionGate(gateInput);
  if (gate.decision !== "controlled_apply_execution_gate_ready" || !gate.authorization) {
    throw new CanonicalGovernedExecutionError("canonical_apply_gate_failed",
      "Controlled apply gate did not authorize execution.", "human_review_required");
  }
  const authorization = authorizeContextSufficientPatch({ adaptiveResult: input.adaptiveResult as any,
    allowedFiles: input.allowedFiles, forbiddenFiles: input.forbiddenFiles,
    policyHash: input.compiledPolicyHash });
  if (authorization.decision !== "context_authorization_ready" || !authorization.authorization) {
    throw new CanonicalGovernedExecutionError("canonical_context_authorization_failed",
      "Bound context did not authorize apply.", "replan_required");
  }
  const bindingInput: any = { contextAuthorization: authorization.authorization,
    coderMutation: input.coderMutation, executionAuthorization: gate.authorization, gateInput };
  const binding = await buildContextToApplyBinding(bindingInput);
  if (binding.decision !== "context_to_apply_binding_ready" || !binding.receipt) {
    throw new CanonicalGovernedExecutionError("canonical_context_apply_binding_failed",
      "Context-to-apply binding failed.", "human_review_required");
  }
  const recoveryInput = { repositoryPath: await realpath(input.repositoryPath), bundleDirectoryPath,
    registryDirectoryPath: input.configuration.registryDirectoryPath,
    validationWorkspaceParentPath: input.configuration.validationWorkspaceParentPath,
    authorization: gate.authorization, gateInput, consumptionKey: gate.authorization.consumptionKey };
  await input.durableCheckpoint?.("governed_apply_prepared", { recoveryInput,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    humanReviewEvidence: input.humanReviewEvidence ?? [],
    acceptanceEvaluation: prepared.acceptanceEvaluation,
    phaseVExecutionSpecification: specification,
    phaseVExecutionVerification: governanceReceipts.phaseVExecutionVerification });
  await input.durableCheckpoint?.("governed_apply_started", { recoveryInput });
  const integratedResult = await runIntegratedDisposableApply({ bindingReceipt: binding.receipt,
    bindingInput, acceptanceContract: input.acceptanceCriteriaContract,
    humanReviewEvidence: input.humanReviewEvidence,
    registryDirectoryPath: input.configuration.registryDirectoryPath,
    validationWorkspaceParentPath: input.configuration.validationWorkspaceParentPath,
    phaseVExecutionSpecification: specification,
    phaseVExecutionVerification: governanceReceipts.phaseVExecutionVerification,
    durableCheckpoint: input.durableCheckpoint === undefined ? undefined :
      (state, artifact) => input.durableCheckpoint!(state, { recoveryInput, artifact }) });
  return Object.freeze({ adapterReceipt: adapted.receipt,
    repairMutation: adapted.repairMutation, governanceReceipts, integratedResult });
}

export async function executeCanonicalGovernedMutation(
  input: CanonicalGovernedExecutionInput
): Promise<CanonicalGovernedExecutionResult> {
  const prepared = await prepareCanonicalGovernedMutation(input);
  return executePreparedCanonicalGovernedMutation(input, prepared);
}
