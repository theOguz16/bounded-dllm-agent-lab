import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";
import type {
  ShadowObservation,
  ShadowObservationValidationDecision
} from "./shadow-observer-contract.js";
import type {
  DeterministicGovernanceAssessment,
  DeterministicGovernanceDecision
} from "./deterministic-governance-policy.js";
import type {
  AdminDecision,
  AdminDecisionValidationDecision,
  ValidatedAdminDecision
} from "./admin-agent-contract.js";
import {
  evaluateAdminInvocationPolicy,
  type AdminInvocationAssessment,
  type AdminInvocationDecision,
  type AdminInvocationMode
} from "./admin-invocation-policy.js";

/**
 * This router executes no workflow action: it only classifies the next route.
 * Deterministic governance remains authoritative, and Shadow or Admin evidence
 * cannot weaken Phase V or governance. Auto-continuation is not repository-apply
 * authorization. Repair, replan, human, and termination routes are not executed
 * in W.11; controlled handoff and real apply remain later phases. Every input is
 * independently hash-verified, and this module performs no repository mutation.
 */

export const RISK_BASED_APPROVAL_ROUTER_VERSION = "2" as const;

export type ApprovalWorkflowRoute =
  | "auto_continue"
  | "repair_required"
  | "replan_required"
  | "human_required"
  | "terminated";

export type ApprovalRouteEffect = "none" | "repair" | "replan" | "human" | "terminate";

export type ApprovalRouterValidationDecision =
  | "approval_route_valid"
  | "approval_route_invalid"
  | "approval_route_needs_review";

export type ShadowRoutingStageDecision =
  | "shadow_observer_completed"
  | "shadow_observer_needs_review"
  | "shadow_observer_failed"
  | "shadow_not_called";

export type AdminRoutingStageDecision =
  | "admin_agent_completed"
  | "admin_agent_needs_review"
  | "admin_agent_failed"
  | "admin_not_called"
  | "admin_skipped_by_policy";

export type PhaseVTerminalDecision =
  | "temp_validation_passed"
  | "temp_validation_failed"
  | "temp_validation_needs_review";

export type RiskBasedApprovalRouterPolicy = {
  policyVersion: "2";
  requireShadowCompletedForAutoContinue: boolean;
  requireShadowValidationValidForAutoContinue: boolean;
  requireGovernancePassedForAutoContinue: boolean;
  requireAdminCompletedForAutoContinue: boolean;
  requireAdminValidationValidForAutoContinue: boolean;
  requireAdminAutoApprovalForAutoContinue: boolean;
  routeShadowNeedsReviewToHuman: boolean;
  routeShadowFailureToHuman: boolean;
  routeAdminNeedsReviewToHuman: boolean;
  routeAdminFailureToHuman: boolean;
  routeMissingAdminToHuman: boolean;
};

export type RiskBasedApprovalRouterInput = {
  phaseVFinalDecision: PhaseVTerminalDecision;
  trace: RunAccountabilityTrace;
  shadow: {
    stageDecision: ShadowRoutingStageDecision;
    validationDecision: ShadowObservationValidationDecision | null;
    observation: ShadowObservation | null;
  };
  governance: DeterministicGovernanceAssessment;
  admin: {
    invocation: AdminInvocationAssessment;
    stageDecision: AdminRoutingStageDecision;
    validationDecision: AdminDecisionValidationDecision | null;
    decision: ValidatedAdminDecision | null;
  };
};

export type ApprovalRouterRuleSeverity = "info" | "warning" | "high" | "critical";

type RouterEvidence = {
  eventIds: readonly string[];
  filePaths: readonly string[];
  traceFindingCodes: readonly string[];
  shadowFindingCodes: readonly string[];
  governanceRuleIds: readonly string[];
  governanceReasonCodes: readonly string[];
  adminFindingCodes: readonly string[];
};

export type ApprovalRouterRuleResult = RouterEvidence & {
  ruleId: string;
  triggered: boolean;
  severity: ApprovalRouterRuleSeverity;
  effect: ApprovalRouteEffect;
  reasonCode: string;
};

export type ApprovalRouterIssue = RouterEvidence & {
  code: string;
  message: string;
  severity: ApprovalRouterRuleSeverity;
  effect: ApprovalRouteEffect;
};

export type RiskBasedApprovalAssessment = {
  routerVersion: "2";
  runId: string;
  phaseVFinalDecision: PhaseVTerminalDecision;
  traceHash: string;
  observationHash: string | null;
  governanceHash: string;
  adminDecisionHash: string | null;
  shadowStageDecision: ShadowRoutingStageDecision;
  shadowValidationDecision: ShadowObservationValidationDecision | null;
  governanceDecision: DeterministicGovernanceDecision;
  adminInvocationMode: AdminInvocationMode;
  adminInvocationDecision: AdminInvocationDecision;
  adminInvocationPolicyHash: string;
  adminInvocationAssessmentHash: string;
  adminResolutionKind: "model_decision" | "verified_policy_skip";
  adminStageDecision: AdminRoutingStageDecision;
  adminValidationDecision: AdminDecisionValidationDecision | null;
  adminDecision: AdminDecision | null;
  policy: Readonly<RiskBasedApprovalRouterPolicy>;
  policyHash: string;
  route: ApprovalWorkflowRoute;
  riskClass: "low" | "medium" | "high" | "critical";
  triggeredRuleIds: readonly string[];
  reasonCodes: readonly string[];
  issues: readonly ApprovalRouterIssue[];
  ruleResults: readonly ApprovalRouterRuleResult[];
  routeHash: string;
};

export type RiskBasedApprovalRouterResult = {
  decision: ApprovalRouterValidationDecision;
  route: ApprovalWorkflowRoute | null;
  assessment: RiskBasedApprovalAssessment | null;
  issues: readonly ApprovalRouterIssue[];
  summary: {
    traceIntegrityVerified: boolean;
    phaseVDecisionValid: boolean;
    phaseVDecisionBoundToTrace: boolean;
    observationProvided: boolean;
    observationIntegrityVerified: boolean;
    observationBoundToTrace: boolean;
    governanceIntegrityVerified: boolean;
    governanceBoundToTrace: boolean;
    governanceBoundToObservation: boolean;
    adminInvocationIntegrityVerified: boolean;
    adminInvocationReproduced: boolean;
    adminDecisionProvided: boolean;
    adminDecisionIntegrityVerified: boolean;
    adminDecisionBoundToTrace: boolean;
    adminDecisionBoundToObservation: boolean;
    adminDecisionBoundToGovernance: boolean;
    shadowStageConsistent: boolean;
    adminStageConsistent: boolean;
    adminResolutionKind: "model_decision" | "verified_policy_skip" | "unresolved";
    deterministicAuthorityPreserved: boolean;
    autoContinueEligible: boolean;
    phaseVEffect: ApprovalRouteEffect;
    shadowEffect: ApprovalRouteEffect;
    governanceEffect: ApprovalRouteEffect;
    adminEffect: ApprovalRouteEffect;
    finalEffect: ApprovalRouteEffect;
    triggeredRuleCount: number;
    repairRuleCount: number;
    replanRuleCount: number;
    humanRuleCount: number;
    terminateRuleCount: number;
    policyHashValid: boolean;
    routeHashValid: boolean;
  };
};

const POLICY_FIELDS = [
  "policyVersion",
  "requireShadowCompletedForAutoContinue",
  "requireShadowValidationValidForAutoContinue",
  "requireGovernancePassedForAutoContinue",
  "requireAdminCompletedForAutoContinue",
  "requireAdminValidationValidForAutoContinue",
  "requireAdminAutoApprovalForAutoContinue",
  "routeShadowNeedsReviewToHuman",
  "routeShadowFailureToHuman",
  "routeAdminNeedsReviewToHuman",
  "routeAdminFailureToHuman",
  "routeMissingAdminToHuman"
] as const;

const DEFAULT_POLICY_VALUE: RiskBasedApprovalRouterPolicy = {
  policyVersion: RISK_BASED_APPROVAL_ROUTER_VERSION,
  requireShadowCompletedForAutoContinue: true,
  requireShadowValidationValidForAutoContinue: true,
  requireGovernancePassedForAutoContinue: true,
  requireAdminCompletedForAutoContinue: true,
  requireAdminValidationValidForAutoContinue: true,
  requireAdminAutoApprovalForAutoContinue: true,
  routeShadowNeedsReviewToHuman: true,
  routeShadowFailureToHuman: true,
  routeAdminNeedsReviewToHuman: true,
  routeAdminFailureToHuman: true,
  routeMissingAdminToHuman: true
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY = deepFreeze({
  ...DEFAULT_POLICY_VALUE
}) as Readonly<RiskBasedApprovalRouterPolicy>;

const RULE_DEFINITIONS = [
  ["trace_integrity", "approval_router_trace_integrity_mismatch", "critical", "terminate"],
  ["phase_v_binding", "approval_router_phase_v_trace_mismatch", "critical", "terminate"],
  ["shadow_observation_integrity", "approval_router_observation_integrity_mismatch", "critical", "terminate"],
  ["shadow_observation_trace_binding", "approval_router_observation_trace_mismatch", "critical", "terminate"],
  ["shadow_stage_consistency", "approval_router_shadow_stage_inconsistent", "critical", "terminate"],
  ["shadow_stage_health", "approval_router_shadow_needs_review", "info", "none"],
  ["governance_policy_integrity", "approval_router_governance_policy_hash_mismatch", "critical", "terminate"],
  ["governance_integrity", "approval_router_governance_integrity_mismatch", "critical", "terminate"],
  ["governance_trace_binding", "approval_router_governance_trace_mismatch", "critical", "terminate"],
  ["governance_observation_binding", "approval_router_governance_observation_mismatch", "critical", "terminate"],
  ["governance_route", "approval_router_governance_passed", "info", "none"],
  ["admin_invocation_integrity", "approval_router_admin_invocation_integrity_mismatch", "critical", "terminate"],
  ["admin_decision_integrity", "approval_router_admin_integrity_mismatch", "critical", "terminate"],
  ["admin_trace_binding", "approval_router_admin_trace_mismatch", "critical", "terminate"],
  ["admin_observation_binding", "approval_router_admin_observation_mismatch", "critical", "terminate"],
  ["admin_governance_binding", "approval_router_admin_governance_mismatch", "critical", "terminate"],
  ["admin_governance_decision_binding", "approval_router_admin_governance_decision_mismatch", "critical", "terminate"],
  ["admin_stage_consistency", "approval_router_admin_stage_inconsistent", "critical", "terminate"],
  ["admin_stage_health", "approval_router_admin_missing", "info", "none"],
  ["admin_route", "approval_router_admin_auto_approved", "info", "none"],
  ["phase_v_outcome", "approval_router_phase_v_passed", "info", "none"],
  ["auto_continue_eligibility", "approval_router_auto_continue_evidence_incomplete", "high", "human"],
  ["deterministic_authority", "approval_router_deterministic_authority_violation", "critical", "terminate"]
] as const satisfies readonly (readonly [string, string, ApprovalRouterRuleSeverity, ApprovalRouteEffect])[];

type RuleId = (typeof RULE_DEFINITIONS)[number][0];
type MutableRule = {
  ruleId: RuleId;
  triggered: boolean;
  severity: ApprovalRouterRuleSeverity;
  effect: ApprovalRouteEffect;
  reasonCode: string;
  evidence: RouterEvidence;
};

const EMPTY_EVIDENCE: RouterEvidence = {
  eventIds: [], filePaths: [], traceFindingCodes: [], shadowFindingCodes: [],
  governanceRuleIds: [], governanceReasonCodes: [], adminFindingCodes: []
};

const EFFECT_RANK: Record<ApprovalRouteEffect, number> = {
  none: 0, repair: 1, replan: 2, human: 3, terminate: 4
};
const EFFECT_ROUTE: Record<ApprovalRouteEffect, ApprovalWorkflowRoute> = {
  none: "auto_continue", repair: "repair_required", replan: "replan_required",
  human: "human_required", terminate: "terminated"
};
const EFFECT_RISK: Record<ApprovalRouteEffect, RiskBasedApprovalAssessment["riskClass"]> = {
  none: "low", repair: "medium", replan: "medium", human: "high", terminate: "critical"
};
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const PHASE_EFFECT: Record<PhaseVTerminalDecision, ApprovalRouteEffect> = {
  temp_validation_passed: "none", temp_validation_failed: "repair",
  temp_validation_needs_review: "human"
};
const GOVERNANCE_EFFECT: Record<DeterministicGovernanceDecision, ApprovalRouteEffect> = {
  governance_passed: "none", governance_repair_required: "repair",
  governance_replan_required: "replan", governance_escalation_required: "human",
  governance_terminated: "terminate"
};
const ADMIN_EFFECT: Record<AdminDecision, ApprovalRouteEffect> = {
  admin_auto_approved: "none", admin_repair_required: "repair",
  admin_replan_required: "replan", admin_human_escalation_required: "human",
  admin_run_terminated: "terminate"
};
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const SHADOW_RECOMMENDATIONS = new Set([
  "continue", "request_repair", "request_replan", "escalate", "terminate"
]);

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function scoreMatchesRisk(risk: unknown, score: unknown): boolean {
  return validScore(score) && (
    (risk === "low" && score <= 24) ||
    (risk === "medium" && score >= 25 && score <= 49) ||
    (risk === "high" && score >= 50 && score <= 74) ||
    (risk === "critical" && score >= 75)
  );
}

type MutableSummary = RiskBasedApprovalRouterResult["summary"];

function initialSummary(): MutableSummary {
  return {
    traceIntegrityVerified: false, phaseVDecisionValid: false,
    phaseVDecisionBoundToTrace: false, observationProvided: false,
    observationIntegrityVerified: false, observationBoundToTrace: false,
    governanceIntegrityVerified: false, governanceBoundToTrace: false,
    governanceBoundToObservation: false, adminDecisionProvided: false,
    adminInvocationIntegrityVerified: false, adminInvocationReproduced: false,
    adminDecisionIntegrityVerified: false, adminDecisionBoundToTrace: false,
    adminDecisionBoundToObservation: false, adminDecisionBoundToGovernance: false,
    shadowStageConsistent: false, adminStageConsistent: false,
    adminResolutionKind: "unresolved",
    deterministicAuthorityPreserved: false, autoContinueEligible: false,
    phaseVEffect: "none", shadowEffect: "none", governanceEffect: "none",
    adminEffect: "none", finalEffect: "none", triggeredRuleCount: 0,
    repairRuleCount: 0, replanRuleCount: 0, humanRuleCount: 0,
    terminateRuleCount: 0, policyHashValid: false, routeHashValid: false
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function boundedEvidence(values: Iterable<unknown>, filePath = false): string[] {
  const collected = [...values];
  if (collected.length > 2048) throw new BoundedReviewError("Router evidence exceeds the evaluation bound.");
  const maximum = filePath ? 512 : 128;
  if (collected.some((value) => typeof value !== "string" || value.length === 0 ||
      value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new SafeDataError("invalid_approval_router_input", "Router evidence is not bounded metadata.");
  }
  return sortedUnique(collected as string[]);
}

function makeRules(): MutableRule[] {
  return RULE_DEFINITIONS.map(([ruleId, reasonCode, severity, effect]) => ({
    ruleId, triggered: false, severity, effect, reasonCode, evidence: EMPTY_EVIDENCE
  }));
}

function applyRule(
  rules: MutableRule[], ruleId: RuleId, reasonCode?: string,
  severity?: ApprovalRouterRuleSeverity, effect?: ApprovalRouteEffect,
  evidence: RouterEvidence = EMPTY_EVIDENCE
): void {
  const rule = rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) throw new TypeError(`Unknown approval-router rule: ${ruleId}`);
  rule.triggered = true;
  if (reasonCode !== undefined) rule.reasonCode = reasonCode;
  if (severity !== undefined) rule.severity = severity;
  if (effect !== undefined) rule.effect = effect;
  rule.evidence = evidence;
}

function strongestEffect(effects: Iterable<ApprovalRouteEffect>): ApprovalRouteEffect {
  let strongest: ApprovalRouteEffect = "none";
  for (const effect of effects) if (EFFECT_RANK[effect] > EFFECT_RANK[strongest]) strongest = effect;
  return strongest;
}

class SafeDataError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

class BoundedReviewError extends Error {}

function safeClone(value: unknown, ancestors = new WeakSet<object>(), count = { value: 0 }): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new SafeDataError("invalid_approval_router_input", "Unsupported input value type.");
  }
  count.value += 1;
  if (count.value > 100_000) throw new BoundedReviewError("Router input exceeds the evaluation bound.");
  if (ancestors.has(value)) {
    throw new SafeDataError("invalid_approval_router_object", "Cyclic input is not accepted.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new SafeDataError("invalid_approval_router_object", "Only ordinary arrays are accepted.");
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new SafeDataError("invalid_approval_router_object", "Only plain objects are accepted.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new SafeDataError("approval_router_symbol_property", "Symbol properties are not accepted.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
      if (!Number.isSafeInteger(length) || length < 0 || length > 100_000) {
        throw new BoundedReviewError("Router array exceeds the evaluation bound.");
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new SafeDataError("invalid_approval_router_object", "Sparse arrays are not accepted.");
        }
        if (!("value" in descriptor)) {
          throw new SafeDataError("approval_router_accessor_property", "Accessor properties are not accepted.");
        }
        output.push(safeClone(descriptor.value, ancestors, count));
      }
      const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if ((keys as string[]).some((key) => !expected.has(key))) {
        throw new SafeDataError("unknown_approval_router_field", "Unknown array properties are not accepted.");
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new SafeDataError("approval_router_accessor_property", "Accessor properties are not accepted.");
      }
      output[key] = safeClone(descriptor.value, ancestors, count);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SafeDataError("invalid_approval_router_object", `${label} must be a plain object.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.find((key) => !fields.includes(key));
  if (unknown !== undefined) {
    throw new SafeDataError("unknown_approval_router_field", `${label} contains an unknown field.`);
  }
  const missing = fields.find((field) => !Object.prototype.hasOwnProperty.call(record, field));
  if (missing !== undefined) {
    throw new SafeDataError("missing_approval_router_field", `${label} is missing a required field.`);
  }
  return record;
}

function normalizePolicy(
  input?: RiskBasedApprovalRouterPolicy
): Readonly<RiskBasedApprovalRouterPolicy> | "unsupported" {
  if (input === undefined) return DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY;
  let cloned: unknown;
  try { cloned = safeClone(input); }
  catch (error) { throw new TypeError(error instanceof Error ? error.message : "Invalid router policy."); }
  let record: Record<string, unknown>;
  try { record = exactObject(cloned, POLICY_FIELDS, "Router policy"); }
  catch (error) { throw new TypeError(error instanceof Error ? error.message : "Invalid router policy."); }
  if (record.policyVersion !== RISK_BASED_APPROVAL_ROUTER_VERSION) return "unsupported";
  for (const field of POLICY_FIELDS.slice(1)) {
    if (typeof record[field] !== "boolean") throw new TypeError(`${field} must be a boolean.`);
  }
  const normalized = Object.fromEntries(
    POLICY_FIELDS.map((field) => [field, record[field]])
  ) as RiskBasedApprovalRouterPolicy;
  return deepFreeze(normalized) as Readonly<RiskBasedApprovalRouterPolicy>;
}

function hashWithoutField(record: Record<string, unknown>, field: string): string {
  return hashCanonicalJson(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== field)
  ));
}

function makeIssue(
  code: string,
  message: string,
  severity: ApprovalRouterRuleSeverity = "critical",
  effect: ApprovalRouteEffect = "terminate",
  evidence: RouterEvidence = EMPTY_EVIDENCE
): ApprovalRouterIssue {
  return { code, message, severity, effect, ...evidence };
}

function invalidResult(
  summary: MutableSummary,
  issues: ApprovalRouterIssue[]
): RiskBasedApprovalRouterResult {
  return deepFreeze({
    decision: "approval_route_invalid" as const,
    route: null,
    assessment: null,
    issues,
    summary
  }) as RiskBasedApprovalRouterResult;
}

function reviewResult(
  summary: MutableSummary,
  issue: ApprovalRouterIssue
): RiskBasedApprovalRouterResult {
  return deepFreeze({
    decision: "approval_route_needs_review" as const,
    route: null,
    assessment: null,
    issues: [issue],
    summary
  }) as RiskBasedApprovalRouterResult;
}

function evidenceFrom(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  governance: DeterministicGovernanceAssessment,
  admin: ValidatedAdminDecision | null
): RouterEvidence {
  const eventIds: string[] = [];
  const filePaths: string[] = [];
  const traceFindingCodes: string[] = [];
  const shadowFindingCodes: string[] = [];
  const governanceRuleIds: string[] = [];
  const governanceReasonCodes: string[] = [];
  const adminFindingCodes: string[] = [];
  for (const finding of trace.findings) {
    traceFindingCodes.push(finding.code);
    eventIds.push(...finding.eventIds);
    filePaths.push(...finding.filePaths);
  }
  for (const finding of observation?.findings ?? []) {
    shadowFindingCodes.push(finding.code);
    eventIds.push(...finding.evidenceEventIds);
    filePaths.push(...finding.evidenceFilePaths);
    traceFindingCodes.push(...finding.evidenceTraceFindingCodes);
  }
  for (const issue of governance.issues) {
    eventIds.push(...issue.eventIds); filePaths.push(...issue.filePaths);
    traceFindingCodes.push(...issue.traceFindingCodes);
    shadowFindingCodes.push(...issue.shadowFindingCodes);
  }
  governanceRuleIds.push(...governance.triggeredRuleIds);
  governanceReasonCodes.push(...governance.reasonCodes);
  for (const rule of governance.ruleResults) {
    if (rule.triggered) governanceRuleIds.push(rule.ruleId);
    eventIds.push(...rule.eventIds); filePaths.push(...rule.filePaths);
    traceFindingCodes.push(...rule.traceFindingCodes);
    shadowFindingCodes.push(...rule.shadowFindingCodes);
  }
  for (const finding of admin?.findings ?? []) {
    adminFindingCodes.push(finding.code);
    eventIds.push(...finding.evidenceEventIds); filePaths.push(...finding.evidenceFilePaths);
    traceFindingCodes.push(...finding.traceFindingCodes);
    shadowFindingCodes.push(...finding.shadowFindingCodes);
    governanceRuleIds.push(...finding.governanceRuleIds);
    governanceReasonCodes.push(...finding.governanceReasonCodes);
  }
  return {
    eventIds: boundedEvidence(eventIds), filePaths: boundedEvidence(filePaths, true),
    traceFindingCodes: boundedEvidence(traceFindingCodes),
    shadowFindingCodes: boundedEvidence(shadowFindingCodes),
    governanceRuleIds: boundedEvidence(governanceRuleIds),
    governanceReasonCodes: boundedEvidence(governanceReasonCodes),
    adminFindingCodes: boundedEvidence(adminFindingCodes)
  };
}

function ruleResults(rules: MutableRule[]): ApprovalRouterRuleResult[] {
  return rules.map(({ evidence, ...rule }) => ({ ...rule, ...evidence }));
}

const RULE_MESSAGES: Record<RuleId, string> = {
  trace_integrity: "The accountability trace failed independent integrity verification.",
  phase_v_binding: "The Phase V terminal decision is not bound to completed trace evidence.",
  shadow_observation_integrity: "The Shadow observation failed independent integrity verification.",
  shadow_observation_trace_binding: "The Shadow observation is not bound to this trace.",
  shadow_stage_consistency: "The Shadow stage state is internally inconsistent.",
  shadow_stage_health: "The Shadow stage requires conservative workflow routing.",
  governance_policy_integrity: "The governance policy hash failed independent verification.",
  governance_integrity: "The governance assessment failed independent integrity verification.",
  governance_trace_binding: "The governance assessment is not bound to this trace.",
  governance_observation_binding: "The governance assessment is not bound to the supplied observation.",
  governance_route: "Deterministic governance requires this workflow effect.",
  admin_invocation_integrity: "The Admin invocation assessment failed independent verification.",
  admin_decision_integrity: "The Admin decision failed independent integrity verification.",
  admin_trace_binding: "The Admin decision is not bound to this trace.",
  admin_observation_binding: "The Admin decision is not bound to the supplied observation.",
  admin_governance_binding: "The Admin decision is not bound to this governance assessment.",
  admin_governance_decision_binding: "The Admin decision contradicts the bound governance decision.",
  admin_stage_consistency: "The Admin stage state is internally inconsistent.",
  admin_stage_health: "The Admin stage requires conservative workflow routing.",
  admin_route: "The validated Admin decision requires this workflow effect.",
  phase_v_outcome: "The Phase V terminal outcome requires this workflow effect.",
  auto_continue_eligibility: "Automatic continuation lacks complete low-risk evidence.",
  deterministic_authority: "Supplied evidence attempts to weaken deterministic authority."
};

function issuesForRules(rules: MutableRule[]): ApprovalRouterIssue[] {
  return rules.filter((rule) => rule.triggered).map((rule) => makeIssue(
    rule.reasonCode, RULE_MESSAGES[rule.ruleId], rule.severity, rule.effect, rule.evidence
  ));
}

function markSummaryCounts(summary: MutableSummary, rules: MutableRule[]): void {
  const triggered = rules.filter((rule) => rule.triggered);
  summary.triggeredRuleCount = triggered.length;
  summary.repairRuleCount = triggered.filter((rule) => rule.effect === "repair").length;
  summary.replanRuleCount = triggered.filter((rule) => rule.effect === "replan").length;
  summary.humanRuleCount = triggered.filter((rule) => rule.effect === "human").length;
  summary.terminateRuleCount = triggered.filter((rule) => rule.effect === "terminate").length;
}

function promotedRisk(
  effect: ApprovalRouteEffect,
  observation: ShadowObservation | null,
  governance: DeterministicGovernanceAssessment,
  admin: ValidatedAdminDecision | null
): RiskBasedApprovalAssessment["riskClass"] {
  const candidates = [EFFECT_RISK[effect], governance.riskClass];
  if (observation !== null) candidates.push(observation.riskLevel);
  if (admin !== null) candidates.push(admin.riskLevel);
  return candidates.reduce((highest, risk) =>
    RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest, "low");
}

export function evaluateRiskBasedApprovalRoute(
  input: RiskBasedApprovalRouterInput,
  policyInput?: RiskBasedApprovalRouterPolicy
): RiskBasedApprovalRouterResult {
  const summary = initialSummary();
  const policy = normalizePolicy(policyInput);
  if (policy === "unsupported") {
    return reviewResult(summary, makeIssue(
      "unsupported_approval_router_policy_version",
      "The router policy version is not supported.",
      "warning", "human"
    ));
  }
  let policyHash: string;
  try {
    policyHash = hashCanonicalJson(policy);
    summary.policyHashValid = true;
  } catch {
    return reviewResult(summary, makeIssue(
      "approval_router_exception", "The router policy could not be evaluated.",
      "warning", "human"
    ));
  }

  try {
    const cloned = safeClone(input);
    const top = exactObject(cloned, [
      "phaseVFinalDecision", "trace", "shadow", "governance", "admin"
    ], "Router input");
    const shadowRecord = exactObject(top.shadow, [
      "stageDecision", "validationDecision", "observation"
    ], "Shadow router input");
    const adminRecord = exactObject(top.admin, [
      "invocation", "stageDecision", "validationDecision", "decision"
    ], "Admin router input");
    const traceRecord = exactObject(top.trace, [
      "traceVersion", "runId", "objectiveHash", "ledgerRootHash", "ledgerEventCount",
      "externallyAnchored", "externalAnchorsMatched", "rolesCalled", "roleActivity",
      "events", "files", "decisions", "repairActivity", "resources", "findings",
      "phaseVExecutionObserved", "phaseVExecutionCompleted", "traceHash"
    ], "Accountability trace");
    const governanceRecord = exactObject(top.governance, [
      "governanceVersion", "runId", "traceHash", "observationHash", "policy",
      "policyHash", "decision", "triggeredRuleIds", "reasonCodes", "issues",
      "ruleResults", "riskClass", "governanceHash"
    ], "Governance assessment");

    const trace = traceRecord as unknown as RunAccountabilityTrace;
    const observation = shadowRecord.observation as ShadowObservation | null;
    const governance = governanceRecord as unknown as DeterministicGovernanceAssessment;
    const invocation = adminRecord.invocation as AdminInvocationAssessment;
    const adminDecision = adminRecord.decision as ValidatedAdminDecision | null;
    const rules = makeRules();

    if (trace.traceVersion !== "1" || typeof trace.traceHash !== "string" ||
        hashWithoutField(traceRecord, "traceHash") !== trace.traceHash) {
      applyRule(rules, "trace_integrity");
      markSummaryCounts(summary, rules);
      return invalidResult(summary, issuesForRules(rules));
    }
    summary.traceIntegrityVerified = true;

    const terminalDecisions = new Set<PhaseVTerminalDecision>([
      "temp_validation_passed", "temp_validation_failed", "temp_validation_needs_review"
    ]);
    const phaseDecision = top.phaseVFinalDecision as PhaseVTerminalDecision;
    summary.phaseVDecisionValid = terminalDecisions.has(phaseDecision);
    const traceFinal = trace.decisions.finalExecutionDecision;
    const traceFinalValid = terminalDecisions.has(traceFinal as PhaseVTerminalDecision);
    summary.phaseVDecisionBoundToTrace = summary.phaseVDecisionValid && traceFinalValid &&
      phaseDecision === traceFinal;
    if (!summary.phaseVDecisionValid || !traceFinalValid) {
      applyRule(rules, "phase_v_binding", "approval_router_phase_v_decision_invalid");
    } else if (!trace.phaseVExecutionObserved || !trace.phaseVExecutionCompleted) {
      applyRule(rules, "phase_v_binding", "approval_router_phase_v_execution_not_completed");
    } else if (!summary.phaseVDecisionBoundToTrace) {
      applyRule(rules, "phase_v_binding", "approval_router_phase_v_trace_mismatch");
    }
    if (rules.find((rule) => rule.ruleId === "phase_v_binding")?.triggered) {
      markSummaryCounts(summary, rules);
      return invalidResult(summary, issuesForRules(rules));
    }

    summary.observationProvided = observation !== null;
    if (observation === null) {
      summary.observationIntegrityVerified = true;
      summary.observationBoundToTrace = true;
    } else {
      const observationRecord = exactObject(observation, [
        "observationVersion", "runId", "traceHash", "riskLevel", "riskScore",
        "confidenceScore", "findings", "observedScopeDrift", "observedPlanPatchMismatch",
        "observedRepairLoop", "observedSuspiciousRoleBehavior", "observedEvidenceConflict",
        "recommendation", "rationaleCodes", "observationHash"
      ], "Shadow observation");
      summary.observationIntegrityVerified = observation.observationVersion === "1" &&
        typeof observation.observationHash === "string" &&
        hashWithoutField(observationRecord, "observationHash") === observation.observationHash &&
        RISK_LEVELS.has(observation.riskLevel) &&
        scoreMatchesRisk(observation.riskLevel, observation.riskScore) &&
        validScore(observation.confidenceScore) &&
        Array.isArray(observation.findings) && Array.isArray(observation.rationaleCodes) &&
        SHADOW_RECOMMENDATIONS.has(observation.recommendation);
      if (!summary.observationIntegrityVerified) {
        applyRule(rules, "shadow_observation_integrity");
      } else {
        summary.observationBoundToTrace = observation.runId === trace.runId &&
          observation.traceHash === trace.traceHash;
        if (!summary.observationBoundToTrace) {
          applyRule(rules, "shadow_observation_trace_binding");
        }
      }
    }

    const shadowStage = shadowRecord.stageDecision as ShadowRoutingStageDecision;
    const shadowValidation = shadowRecord.validationDecision as ShadowObservationValidationDecision | null;
    summary.shadowStageConsistent =
      (shadowStage === "shadow_not_called" && shadowValidation === null && observation === null) ||
      (shadowStage === "shadow_observer_completed" &&
        shadowValidation === "shadow_observation_valid" && observation !== null) ||
      (shadowStage === "shadow_observer_needs_review" &&
        (shadowValidation === "shadow_observation_needs_review" ||
          (shadowValidation === null && observation === null))) ||
      (shadowStage === "shadow_observer_failed" && observation === null &&
        (shadowValidation === null || shadowValidation === "shadow_observation_invalid"));
    if (!summary.shadowStageConsistent) applyRule(rules, "shadow_stage_consistency");

    let governancePolicyValid = false;
    try {
      governancePolicyValid = hashCanonicalJson(governance.policy) === governance.policyHash;
    } catch { governancePolicyValid = false; }
    if (!governancePolicyValid) applyRule(rules, "governance_policy_integrity");
    summary.governanceIntegrityVerified = governance.governanceVersion === "1" &&
      typeof governance.governanceHash === "string" &&
      hashWithoutField(governanceRecord, "governanceHash") === governance.governanceHash &&
      RISK_LEVELS.has(governance.riskClass) &&
      typeof governance.decision === "string" && governance.decision in GOVERNANCE_EFFECT &&
      Array.isArray(governance.triggeredRuleIds) && Array.isArray(governance.reasonCodes) &&
      Array.isArray(governance.issues) && Array.isArray(governance.ruleResults);
    if (!summary.governanceIntegrityVerified) applyRule(rules, "governance_integrity");
    summary.governanceBoundToTrace = governance.runId === trace.runId &&
      governance.traceHash === trace.traceHash;
    if (!summary.governanceBoundToTrace) applyRule(rules, "governance_trace_binding");
    const observationHash = observation?.observationHash ?? null;
    summary.governanceBoundToObservation = governance.observationHash === observationHash;
    if (!summary.governanceBoundToObservation) applyRule(rules, "governance_observation_binding");

    let reproducedInvocation: AdminInvocationAssessment | null = null;
    try {
      const invocationResult = evaluateAdminInvocationPolicy({
        phaseVFinalDecision: phaseDecision,
        trace,
        shadow: {
          stageDecision: shadowStage,
          validationDecision: shadowValidation,
          observation
        },
        governance
      }, invocation.policy);
      reproducedInvocation = invocationResult.assessment;
      summary.adminInvocationIntegrityVerified =
        invocationResult.decision === "admin_invocation_policy_valid" &&
        reproducedInvocation !== null &&
        hashCanonicalJson(invocation.policy) === invocation.policyHash &&
        hashWithoutField(invocation as unknown as Record<string, unknown>, "assessmentHash") ===
          invocation.assessmentHash;
      summary.adminInvocationReproduced = reproducedInvocation !== null &&
        canonicalizeJson(reproducedInvocation) === canonicalizeJson(invocation);
    } catch {
      summary.adminInvocationIntegrityVerified = false;
      summary.adminInvocationReproduced = false;
    }
    if (!summary.adminInvocationIntegrityVerified || !summary.adminInvocationReproduced ||
        invocation.traceHash !== trace.traceHash ||
        invocation.observationHash !== observationHash ||
        invocation.governanceHash !== governance.governanceHash ||
        invocation.phaseVFinalDecision !== phaseDecision) {
      applyRule(rules, "admin_invocation_integrity");
    }

    summary.adminDecisionProvided = adminDecision !== null;
    if (adminDecision === null) {
      summary.adminDecisionIntegrityVerified = true;
      summary.adminDecisionBoundToTrace = true;
      summary.adminDecisionBoundToObservation = true;
      summary.adminDecisionBoundToGovernance = true;
    } else {
      const adminDecisionRecord = exactObject(adminDecision, [
        "decisionVersion", "runId", "traceHash", "observationHash", "governanceHash",
        "governanceDecision", "decision", "riskLevel", "riskScore", "confidenceScore",
        "findings", "rationaleCodes", "adminDecisionHash"
      ], "Admin decision");
      summary.adminDecisionIntegrityVerified = adminDecision.decisionVersion === "1" &&
        typeof adminDecision.adminDecisionHash === "string" &&
        hashWithoutField(adminDecisionRecord, "adminDecisionHash") === adminDecision.adminDecisionHash &&
        typeof adminDecision.decision === "string" && adminDecision.decision in ADMIN_EFFECT &&
        RISK_LEVELS.has(adminDecision.riskLevel) &&
        scoreMatchesRisk(adminDecision.riskLevel, adminDecision.riskScore) &&
        validScore(adminDecision.confidenceScore) && Array.isArray(adminDecision.findings) &&
        Array.isArray(adminDecision.rationaleCodes);
      if (!summary.adminDecisionIntegrityVerified) applyRule(rules, "admin_decision_integrity");
      summary.adminDecisionBoundToTrace = adminDecision.runId === trace.runId &&
        adminDecision.traceHash === trace.traceHash;
      if (!summary.adminDecisionBoundToTrace) applyRule(rules, "admin_trace_binding");
      summary.adminDecisionBoundToObservation = adminDecision.observationHash === observationHash;
      if (!summary.adminDecisionBoundToObservation) applyRule(rules, "admin_observation_binding");
      summary.adminDecisionBoundToGovernance = adminDecision.governanceHash === governance.governanceHash;
      if (!summary.adminDecisionBoundToGovernance) applyRule(rules, "admin_governance_binding");
      if (adminDecision.governanceDecision !== governance.decision) {
        applyRule(rules, "admin_governance_decision_binding");
      }
    }

    const adminStage = adminRecord.stageDecision as AdminRoutingStageDecision;
    const adminValidation = adminRecord.validationDecision as AdminDecisionValidationDecision | null;
    summary.adminStageConsistent =
      (adminStage === "admin_skipped_by_policy" &&
        invocation.decision === "admin_invocation_skipped" &&
        adminValidation === null && adminDecision === null) ||
      (adminStage === "admin_not_called" &&
        invocation.decision === "admin_invocation_required" &&
        adminValidation === null && adminDecision === null) ||
      (invocation.decision === "admin_invocation_required" &&
        adminStage === "admin_agent_completed" &&
        adminValidation === "admin_decision_valid" && adminDecision !== null) ||
      (invocation.decision === "admin_invocation_required" &&
        adminStage === "admin_agent_needs_review" &&
        adminValidation === "admin_decision_needs_review") ||
      (invocation.decision === "admin_invocation_required" &&
        adminStage === "admin_agent_failed" && adminDecision === null &&
        (adminValidation === null || adminValidation === "admin_decision_invalid"));
    if (!summary.adminStageConsistent) applyRule(rules, "admin_stage_consistency");

    const integrityRuleIds = new Set<RuleId>([
      "shadow_observation_integrity", "shadow_observation_trace_binding",
      "shadow_stage_consistency", "governance_policy_integrity", "governance_integrity",
      "governance_trace_binding", "governance_observation_binding", "admin_decision_integrity",
      "admin_invocation_integrity",
      "admin_trace_binding", "admin_observation_binding", "admin_governance_binding",
      "admin_governance_decision_binding", "admin_stage_consistency"
    ]);
    if (rules.some((rule) => integrityRuleIds.has(rule.ruleId) && rule.triggered)) {
      markSummaryCounts(summary, rules);
      return invalidResult(summary, issuesForRules(rules));
    }

    const evidence = evidenceFrom(trace, observation, governance, adminDecision);
    summary.phaseVEffect = PHASE_EFFECT[phaseDecision];
    if (summary.phaseVEffect !== "none") {
      applyRule(
        rules, "phase_v_outcome",
        phaseDecision === "temp_validation_failed"
          ? "approval_router_phase_v_failed"
          : "approval_router_phase_v_needs_review",
        phaseDecision === "temp_validation_failed" ? "high" : "high",
        summary.phaseVEffect, evidence
      );
    }

    summary.shadowEffect = "none";
    if (shadowStage === "shadow_observer_needs_review" && policy.routeShadowNeedsReviewToHuman) {
      summary.shadowEffect = "human";
      applyRule(rules, "shadow_stage_health", "approval_router_shadow_needs_review", "high", "human", evidence);
    } else if (shadowStage === "shadow_observer_failed" && policy.routeShadowFailureToHuman) {
      summary.shadowEffect = "human";
      applyRule(rules, "shadow_stage_health", "approval_router_shadow_failed", "high", "human", evidence);
    }

    const governanceEffect = GOVERNANCE_EFFECT[governance.decision];
    if (governanceEffect === undefined) {
      applyRule(rules, "governance_integrity");
      markSummaryCounts(summary, rules);
      return invalidResult(summary, issuesForRules(rules));
    }
    summary.governanceEffect = governanceEffect;
    if (governanceEffect !== "none") {
      const suffix = {
        repair: "repair_required", replan: "replan_required",
        human: "escalation_required", terminate: "terminated"
      }[governanceEffect];
      applyRule(rules, "governance_route", `approval_router_governance_${suffix}`,
        governanceEffect === "terminate" ? "critical" : "high", governanceEffect, evidence);
    }

    let adminSemanticEffect: ApprovalRouteEffect = "none";
    if (adminDecision !== null) {
      adminSemanticEffect = ADMIN_EFFECT[adminDecision.decision];
      if (adminSemanticEffect === undefined) {
        applyRule(rules, "admin_decision_integrity");
        markSummaryCounts(summary, rules);
        return invalidResult(summary, issuesForRules(rules));
      }
      if (EFFECT_RANK[adminSemanticEffect] < EFFECT_RANK[governanceEffect]) {
        applyRule(rules, "deterministic_authority", undefined, undefined, undefined, evidence);
        summary.deterministicAuthorityPreserved = false;
        markSummaryCounts(summary, rules);
        return invalidResult(summary, issuesForRules(rules));
      }
      if (adminSemanticEffect !== "none") {
        const reason = {
          repair: "approval_router_admin_repair_required",
          replan: "approval_router_admin_replan_required",
          human: "approval_router_admin_human_required",
          terminate: "approval_router_admin_terminated"
        }[adminSemanticEffect];
        applyRule(rules, "admin_route", reason,
          adminSemanticEffect === "terminate" ? "critical" : "high", adminSemanticEffect, evidence);
      }
    }
    let adminHealthEffect: ApprovalRouteEffect = "none";
    if (adminStage === "admin_agent_needs_review" && policy.routeAdminNeedsReviewToHuman) {
      adminHealthEffect = "human";
      applyRule(rules, "admin_stage_health", "approval_router_admin_needs_review", "high", "human", evidence);
    } else if (adminStage === "admin_agent_failed" && policy.routeAdminFailureToHuman) {
      adminHealthEffect = "human";
      applyRule(rules, "admin_stage_health", "approval_router_admin_failed", "high", "human", evidence);
    } else if (adminStage === "admin_not_called" && policy.routeMissingAdminToHuman) {
      adminHealthEffect = "human";
      applyRule(rules, "admin_stage_health", "approval_router_admin_missing", "high", "human", evidence);
    }
    summary.adminResolutionKind =
      adminStage === "admin_skipped_by_policy"
        ? "verified_policy_skip"
        : adminDecision !== null
          ? "model_decision"
          : "unresolved";
    summary.adminEffect = strongestEffect([adminSemanticEffect, adminHealthEffect]);
    summary.deterministicAuthorityPreserved = true;

    let finalEffect = strongestEffect([
      summary.phaseVEffect, summary.shadowEffect, summary.governanceEffect, summary.adminEffect
    ]);
    const noBlockingRule = !rules.some((rule) => rule.triggered && rule.effect !== "none");
    const lowEvidence = governance.riskClass === "low" &&
      (observation === null || observation.riskLevel === "low") &&
      (adminDecision === null || (adminDecision.riskLevel === "low" && adminDecision.riskScore <= 24));
    const modelResolution = adminStage === "admin_agent_completed" &&
      adminValidation === "admin_decision_valid" &&
      adminDecision?.decision === "admin_auto_approved" &&
      adminDecision.riskLevel === "low" && adminDecision.riskScore <= 24;
    const policySkipResolution = adminStage === "admin_skipped_by_policy" &&
      invocation.decision === "admin_invocation_skipped" &&
      invocation.autoContinueWithoutAdminEligible === true &&
      adminValidation === null && adminDecision === null;
    summary.autoContinueEligible = phaseDecision === "temp_validation_passed" &&
      (!policy.requireShadowCompletedForAutoContinue ||
        (shadowStage === "shadow_observer_completed" && observation !== null)) &&
      (!policy.requireShadowValidationValidForAutoContinue ||
        shadowValidation === "shadow_observation_valid") &&
      (!policy.requireGovernancePassedForAutoContinue || governance.decision === "governance_passed") &&
      (!policy.requireAdminCompletedForAutoContinue || modelResolution || policySkipResolution) &&
      (!policy.requireAdminValidationValidForAutoContinue || modelResolution || policySkipResolution) &&
      (!policy.requireAdminAutoApprovalForAutoContinue || modelResolution || policySkipResolution) &&
      governance.triggeredRuleIds.length === 0 && governance.issues.length === 0 &&
      lowEvidence && noBlockingRule;
    if (finalEffect === "none" && !summary.autoContinueEligible) {
      applyRule(rules, "auto_continue_eligibility", undefined, undefined, undefined, evidence);
      finalEffect = "human";
    }
    if (EFFECT_RANK[finalEffect] < EFFECT_RANK[summary.phaseVEffect] ||
        EFFECT_RANK[finalEffect] < EFFECT_RANK[summary.governanceEffect]) {
      applyRule(rules, "deterministic_authority", undefined, undefined, undefined, evidence);
      summary.deterministicAuthorityPreserved = false;
      markSummaryCounts(summary, rules);
      return invalidResult(summary, issuesForRules(rules));
    }

    summary.finalEffect = finalEffect;
    markSummaryCounts(summary, rules);
    const results = ruleResults(rules);
    const issues = issuesForRules(rules);
    const triggeredRuleIds = rules.filter((rule) => rule.triggered).map((rule) => rule.ruleId);
    const reasonCodes = sortedUnique(rules.filter((rule) => rule.triggered).map((rule) => rule.reasonCode));
    const route = EFFECT_ROUTE[finalEffect];
    const assessmentWithoutHash: Omit<RiskBasedApprovalAssessment, "routeHash"> = {
      routerVersion: RISK_BASED_APPROVAL_ROUTER_VERSION,
      runId: trace.runId,
      phaseVFinalDecision: phaseDecision,
      traceHash: trace.traceHash,
      observationHash,
      governanceHash: governance.governanceHash,
      adminDecisionHash: adminDecision?.adminDecisionHash ?? null,
      shadowStageDecision: shadowStage,
      shadowValidationDecision: shadowValidation,
      governanceDecision: governance.decision,
      adminInvocationMode: invocation.policy.mode,
      adminInvocationDecision: invocation.decision,
      adminInvocationPolicyHash: invocation.policyHash,
      adminInvocationAssessmentHash: invocation.assessmentHash,
      adminResolutionKind: summary.adminResolutionKind === "verified_policy_skip"
        ? "verified_policy_skip"
        : "model_decision",
      adminStageDecision: adminStage,
      adminValidationDecision: adminValidation,
      adminDecision: adminDecision?.decision ?? null,
      policy,
      policyHash,
      route,
      riskClass: promotedRisk(finalEffect, observation, governance, adminDecision),
      triggeredRuleIds,
      reasonCodes,
      issues,
      ruleResults: results
    };
    let routeHash: string;
    try {
      routeHash = hashCanonicalJson(assessmentWithoutHash);
    } catch {
      return invalidResult(summary, [makeIssue(
        "approval_router_route_hash_failure",
        "The canonical route hash could not be computed."
      )]);
    }
    summary.routeHashValid = true;
    const assessment: RiskBasedApprovalAssessment = { ...assessmentWithoutHash, routeHash };
    return deepFreeze({
      decision: "approval_route_valid" as const,
      route,
      assessment,
      issues,
      summary
    }) as RiskBasedApprovalRouterResult;
  } catch (error) {
    if (error instanceof BoundedReviewError) {
      return reviewResult(summary, makeIssue(
        "approval_router_exception", "The bounded router evaluation could not complete.",
        "warning", "human"
      ));
    }
    const code = error instanceof SafeDataError ? error.code : "approval_router_exception";
    return invalidResult(summary, [makeIssue(
      code,
      code === "approval_router_exception"
        ? "The router could not safely evaluate the supplied evidence."
        : "The router input failed bounded structural validation."
    )]);
  }
}
