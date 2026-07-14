import { hashCanonicalJson } from "./agent-event-ledger.js";
import type {
  RunAccountabilityTrace,
  TraceFinding
} from "./run-accountability-trace.js";
import type {
  ShadowObservation,
  ShadowRecommendation,
  ShadowRiskLevel
} from "./shadow-observer-contract.js";

/**
 * Deterministic governance is the hard authority. Shadow evidence is advisory:
 * it may make a run stricter but cannot weaken deterministic evidence. A valid
 * observation proves structure and trace binding, not objective correctness.
 * A governance pass is not repository-apply authorization; Admin review and
 * apply handoff remain later phases. W.7 performs no repository mutation.
 */

export const DETERMINISTIC_GOVERNANCE_VERSION = "1" as const;

export type DeterministicGovernanceDecision =
  | "governance_passed"
  | "governance_repair_required"
  | "governance_replan_required"
  | "governance_escalation_required"
  | "governance_terminated";

export type GovernanceRuleSeverity = "info" | "warning" | "high" | "critical";
export type GovernanceRuleEffect = "none" | "repair" | "replan" | "escalate" | "terminate";

export type DeterministicGovernancePolicy = {
  policyVersion: "1";
  requireExternalTraceAnchor: boolean;
  requireShadowObservation: boolean;
  requireExecutionTerminalDecision: boolean;
  requireSuccessfulExecutionForPass: boolean;
  requireCleanupEvidenceForPass: boolean;
  maxPlannedFiles: number;
  maxProposedFiles: number;
  maxTemporaryAppliedFiles: number;
  maxScopeExpansionFactor: number;
  maxRepairCount: number;
  maxRemaskCount: number;
  maxTotalTokens: number;
  maxTotalDurationMs: number;
  maxWallClockSpanMs: number;
};

export type GovernanceIssue = {
  code: string;
  message: string;
  severity: GovernanceRuleSeverity;
  effect: GovernanceRuleEffect;
  eventIds: readonly string[];
  filePaths: readonly string[];
  traceFindingCodes: readonly string[];
  shadowFindingCodes: readonly string[];
};

export type GovernanceRuleResult = {
  ruleId: string;
  triggered: boolean;
  severity: GovernanceRuleSeverity;
  effect: GovernanceRuleEffect;
  reasonCode: string;
  eventIds: readonly string[];
  filePaths: readonly string[];
  traceFindingCodes: readonly string[];
  shadowFindingCodes: readonly string[];
};

export type DeterministicGovernanceAssessment = {
  governanceVersion: "1";
  runId: string;
  traceHash: string;
  observationHash: string | null;
  policy: Readonly<DeterministicGovernancePolicy>;
  policyHash: string;
  decision: DeterministicGovernanceDecision;
  triggeredRuleIds: readonly string[];
  reasonCodes: readonly string[];
  issues: readonly GovernanceIssue[];
  ruleResults: readonly GovernanceRuleResult[];
  riskClass: "low" | "medium" | "high" | "critical";
  governanceHash: string;
};

export type DeterministicGovernanceResult = {
  decision: DeterministicGovernanceDecision;
  assessment: DeterministicGovernanceAssessment | null;
  issues: readonly GovernanceIssue[];
  summary: {
    traceIntegrityVerified: boolean;
    observationProvided: boolean;
    observationIntegrityVerified: boolean;
    observationBoundToTrace: boolean;
    externalTraceAnchorPresent: boolean;
    externalTraceAnchorMatched: boolean;
    executionObserved: boolean;
    executionCompleted: boolean;
    executionPassed: boolean;
    executionFailed: boolean;
    executionNeedsReview: boolean;
    cleanupEvidenceObserved: boolean;
    cleanupFailureObserved: boolean;
    forbiddenProposedPathCount: number;
    forbiddenAppliedPathCount: number;
    suspiciousReadPathCount: number;
    unplannedProposedFileCount: number;
    appliedButUnproposedFileCount: number;
    scopeExpansionFactor: number | null;
    repairCount: number;
    remaskCount: number;
    totalTokens: number;
    totalDurationMs: number;
    wallClockSpanMs: number;
    traceWarningCount: number;
    traceErrorCount: number;
    shadowRiskLevel: ShadowRiskLevel | null;
    shadowRecommendation: ShadowRecommendation | null;
    triggeredRuleCount: number;
    terminateRuleCount: number;
    escalationRuleCount: number;
    replanRuleCount: number;
    repairRuleCount: number;
    governanceHashValid: boolean;
  };
};

const POLICY_FIELDS = [
  "policyVersion",
  "requireExternalTraceAnchor",
  "requireShadowObservation",
  "requireExecutionTerminalDecision",
  "requireSuccessfulExecutionForPass",
  "requireCleanupEvidenceForPass",
  "maxPlannedFiles",
  "maxProposedFiles",
  "maxTemporaryAppliedFiles",
  "maxScopeExpansionFactor",
  "maxRepairCount",
  "maxRemaskCount",
  "maxTotalTokens",
  "maxTotalDurationMs",
  "maxWallClockSpanMs"
] as const;

const DEFAULT_POLICY_VALUE: DeterministicGovernancePolicy = {
  policyVersion: DETERMINISTIC_GOVERNANCE_VERSION,
  requireExternalTraceAnchor: true,
  requireShadowObservation: true,
  requireExecutionTerminalDecision: true,
  requireSuccessfulExecutionForPass: true,
  requireCleanupEvidenceForPass: true,
  maxPlannedFiles: 20,
  maxProposedFiles: 20,
  maxTemporaryAppliedFiles: 20,
  maxScopeExpansionFactor: 2,
  maxRepairCount: 3,
  maxRemaskCount: 3,
  maxTotalTokens: 1_000_000,
  maxTotalDurationMs: 900_000,
  maxWallClockSpanMs: 900_000
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY = deepFreeze({
  ...DEFAULT_POLICY_VALUE
}) as Readonly<DeterministicGovernancePolicy>;

const RULE_DEFINITIONS = [
  ["trace_integrity", "governance_trace_integrity_mismatch", "critical", "terminate"],
  ["shadow_observation_integrity", "governance_shadow_observation_integrity_mismatch", "critical", "terminate"],
  ["shadow_observation_trace_binding", "governance_shadow_observation_trace_mismatch", "critical", "terminate"],
  ["shadow_observation_required", "governance_shadow_observation_missing", "high", "escalate"],
  ["external_trace_anchor", "governance_external_trace_anchor_missing", "high", "escalate"],
  ["execution_observed", "governance_execution_not_observed", "high", "escalate"],
  ["execution_terminal", "governance_execution_terminal_decision_missing", "high", "escalate"],
  ["execution_outcome", "governance_execution_failed", "high", "repair"],
  ["cleanup_integrity", "governance_temp_workspace_cleanup_evidence_missing", "high", "escalate"],
  ["forbidden_proposed_paths", "governance_forbidden_proposed_path", "critical", "terminate"],
  ["forbidden_applied_paths", "governance_forbidden_applied_path", "critical", "terminate"],
  ["suspicious_read_or_plan_paths", "governance_suspicious_read_or_plan_path", "high", "escalate"],
  ["applied_scope_consistency", "governance_applied_file_was_not_proposed", "critical", "terminate"],
  ["planned_scope_consistency", "governance_unplanned_files_proposed", "high", "replan"],
  ["proposed_scope_without_plan", "governance_files_proposed_without_plan", "high", "replan"],
  ["scope_expansion_limit", "governance_scope_expansion_limit_exceeded", "high", "replan"],
  ["planned_file_limit", "governance_planned_file_limit_exceeded", "high", "replan"],
  ["proposed_file_limit", "governance_proposed_file_limit_exceeded", "high", "replan"],
  ["temporary_applied_file_limit", "governance_temporary_applied_file_limit_exceeded", "high", "escalate"],
  ["repair_count_limit", "governance_repair_count_limit_exceeded", "high", "escalate"],
  ["remask_count_limit", "governance_remask_count_limit_exceeded", "high", "escalate"],
  ["total_token_limit", "governance_total_token_limit_exceeded", "high", "escalate"],
  ["total_duration_limit", "governance_total_duration_limit_exceeded", "high", "escalate"],
  ["wall_clock_limit", "governance_wall_clock_limit_exceeded", "high", "escalate"],
  ["resource_accounting_integrity", "governance_resource_accounting_overflow", "critical", "terminate"],
  ["classified_trace_errors", "governance_classified_trace_error", "critical", "terminate"],
  ["classified_trace_planning_warnings", "governance_classified_trace_planning_warning", "high", "replan"],
  ["classified_trace_execution_warnings", "governance_classified_trace_execution_warning", "high", "escalate"],
  ["classified_trace_loop_warnings", "governance_classified_trace_loop_warning", "high", "escalate"],
  ["unclassified_trace_error", "governance_unclassified_trace_error", "high", "escalate"],
  ["unclassified_trace_warning", "governance_unclassified_trace_warning", "warning", "escalate"],
  ["shadow_recommendation", "governance_shadow_recommends_repair", "info", "none"],
  ["shadow_risk_level", "governance_shadow_medium_risk", "info", "none"],
  ["shadow_critical_finding", "governance_shadow_critical_finding", "critical", "escalate"],
  ["shadow_high_finding", "governance_shadow_high_finding", "high", "escalate"],
  ["deterministic_authority", "governance_deterministic_authority_violation", "critical", "terminate"]
] as const satisfies readonly (readonly [string, string, GovernanceRuleSeverity, GovernanceRuleEffect])[];

type RuleId = (typeof RULE_DEFINITIONS)[number][0];
type Evidence = {
  eventIds?: readonly string[];
  filePaths?: readonly string[];
  traceFindingCodes?: readonly string[];
  shadowFindingCodes?: readonly string[];
};

type MutableRule = {
  ruleId: RuleId;
  triggered: boolean;
  severity: GovernanceRuleSeverity;
  effect: GovernanceRuleEffect;
  reasonCode: string;
  eventIds: string[];
  filePaths: string[];
  traceFindingCodes: string[];
  shadowFindingCodes: string[];
};

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EFFECT_RANK: Record<GovernanceRuleEffect, number> = {
  none: 0,
  repair: 1,
  replan: 2,
  escalate: 3,
  terminate: 4
};
const SEVERITY_RANK: Record<GovernanceRuleSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3
};
const TERMINAL_EXECUTION_DECISIONS = new Set([
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]);
const HARD_TRACE_ERRORS = new Set([
  "temporary_apply_scope_mismatch",
  "conflicting_execution_decisions",
  "resource_total_overflow"
]);
const PLANNING_WARNINGS = new Set([
  "proposed_files_without_plan",
  "unplanned_files_proposed",
  "missing_planner_event",
  "missing_coder_event",
  "missing_deterministic_verifier_event"
]);
const EXECUTION_WARNINGS = new Set([
  "missing_execution_verifier_event",
  "execution_terminal_decision_missing"
]);
const LOOP_WARNINGS = new Set(["high_repair_count", "high_remask_count"]);
const CLASSIFIED_TRACE_CODES = new Set([
  ...HARD_TRACE_ERRORS,
  ...PLANNING_WARNINGS,
  ...EXECUTION_WARNINGS,
  ...LOOP_WARNINGS
]);

function normalizePolicy(input?: DeterministicGovernancePolicy): Readonly<DeterministicGovernancePolicy> {
  const value: unknown = input === undefined ? DEFAULT_POLICY_VALUE : input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Governance policy must be an object.");
  }
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Governance policy must be a plain object.");
  }
  const ownKeys = Reflect.ownKeys(record);
  const keys = ownKeys.filter((key): key is string => typeof key === "string");
  if (
    ownKeys.length !== keys.length ||
    keys.length !== POLICY_FIELDS.length ||
    keys.some((key) => !(POLICY_FIELDS as readonly string[]).includes(key)) ||
    POLICY_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new TypeError("Governance policy must contain exactly the supported fields.");
  }
  if (record.policyVersion !== DETERMINISTIC_GOVERNANCE_VERSION) {
    throw new TypeError('policyVersion must be "1".');
  }
  for (const key of [
    "requireExternalTraceAnchor",
    "requireShadowObservation",
    "requireExecutionTerminalDecision",
    "requireSuccessfulExecutionForPass",
    "requireCleanupEvidenceForPass"
  ] as const) {
    if (typeof record[key] !== "boolean") throw new TypeError(`${key} must be a boolean.`);
  }
  for (const key of [
    "maxPlannedFiles",
    "maxProposedFiles",
    "maxTemporaryAppliedFiles",
    "maxRepairCount",
    "maxRemaskCount",
    "maxTotalTokens",
    "maxTotalDurationMs",
    "maxWallClockSpanMs"
  ] as const) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) <= 0) {
      throw new TypeError(`${key} must be a positive safe integer.`);
    }
  }
  if (
    typeof record.maxScopeExpansionFactor !== "number" ||
    !Number.isFinite(record.maxScopeExpansionFactor) ||
    record.maxScopeExpansionFactor < 1
  ) {
    throw new TypeError("maxScopeExpansionFactor must be finite and at least 1.");
  }
  const normalized = Object.fromEntries(
    POLICY_FIELDS.map((key) => [key, record[key]])
  ) as DeterministicGovernancePolicy;
  return deepFreeze(normalized) as Readonly<DeterministicGovernancePolicy>;
}

function sortedUnique(values: readonly string[] = []): string[] {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function makeRules(): MutableRule[] {
  return RULE_DEFINITIONS.map(([ruleId, reasonCode, severity, effect]) => ({
    ruleId,
    triggered: false,
    severity,
    effect,
    reasonCode,
    eventIds: [],
    filePaths: [],
    traceFindingCodes: [],
    shadowFindingCodes: []
  }));
}

function applyRule(
  rules: MutableRule[],
  ruleId: RuleId,
  reasonCode?: string,
  severity?: GovernanceRuleSeverity,
  effect?: GovernanceRuleEffect,
  evidence: Evidence = {}
): void {
  const rule = rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) throw new TypeError(`Unknown governance rule: ${ruleId}`);
  rule.triggered = true;
  if (reasonCode !== undefined) rule.reasonCode = reasonCode;
  if (severity !== undefined) rule.severity = severity;
  if (effect !== undefined) rule.effect = effect;
  rule.eventIds = sortedUnique(evidence.eventIds);
  rule.filePaths = sortedUnique(evidence.filePaths);
  rule.traceFindingCodes = sortedUnique(evidence.traceFindingCodes);
  rule.shadowFindingCodes = sortedUnique(evidence.shadowFindingCodes);
}

function setRuleEvidence(rules: MutableRule[], ruleId: RuleId, evidence: Evidence): void {
  const rule = rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) throw new TypeError(`Unknown governance rule: ${ruleId}`);
  rule.eventIds = sortedUnique(evidence.eventIds);
  rule.filePaths = sortedUnique(evidence.filePaths);
  rule.traceFindingCodes = sortedUnique(evidence.traceFindingCodes);
  rule.shadowFindingCodes = sortedUnique(evidence.shadowFindingCodes);
}

function traceHashMaterial(trace: RunAccountabilityTrace): Omit<RunAccountabilityTrace, "traceHash"> {
  return {
    traceVersion: trace.traceVersion,
    runId: trace.runId,
    objectiveHash: trace.objectiveHash,
    ledgerRootHash: trace.ledgerRootHash,
    ledgerEventCount: trace.ledgerEventCount,
    externallyAnchored: trace.externallyAnchored,
    externalAnchorsMatched: trace.externalAnchorsMatched,
    rolesCalled: trace.rolesCalled,
    roleActivity: trace.roleActivity,
    events: trace.events,
    files: trace.files,
    decisions: trace.decisions,
    repairActivity: trace.repairActivity,
    resources: trace.resources,
    findings: trace.findings,
    phaseVExecutionObserved: trace.phaseVExecutionObserved,
    phaseVExecutionCompleted: trace.phaseVExecutionCompleted
  };
}

function observationHashMaterial(
  observation: ShadowObservation
): Omit<ShadowObservation, "observationHash"> {
  return {
    observationVersion: observation.observationVersion,
    runId: observation.runId,
    traceHash: observation.traceHash,
    riskLevel: observation.riskLevel,
    riskScore: observation.riskScore,
    confidenceScore: observation.confidenceScore,
    findings: observation.findings,
    observedScopeDrift: observation.observedScopeDrift,
    observedPlanPatchMismatch: observation.observedPlanPatchMismatch,
    observedRepairLoop: observation.observedRepairLoop,
    observedSuspiciousRoleBehavior: observation.observedSuspiciousRoleBehavior,
    observedEvidenceConflict: observation.observedEvidenceConflict,
    recommendation: observation.recommendation,
    rationaleCodes: observation.rationaleCodes
  };
}

function forbiddenPath(path: string): boolean {
  if (path.length === 0 || /[\u0000-\u001f\u007f]/.test(path)) return true;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return true;
  }
  if (path.includes("\\")) return true;
  const segments = path.split(/[\\/]/);
  return segments.includes("..") || segments.includes(".git");
}

function evidenceFromTraceFindings(findings: readonly TraceFinding[]): Evidence {
  return {
    eventIds: findings.flatMap((finding) => [...finding.eventIds]),
    filePaths: findings.flatMap((finding) => [...finding.filePaths]),
    traceFindingCodes: findings.map((finding) => finding.code)
  };
}

function evidenceFromShadowFindings(
  findings: ShadowObservation["findings"]
): Evidence {
  return {
    eventIds: findings.flatMap((finding) => [...finding.evidenceEventIds]),
    filePaths: findings.flatMap((finding) => [...finding.evidenceFilePaths]),
    traceFindingCodes: findings.flatMap((finding) => [...finding.evidenceTraceFindingCodes]),
    shadowFindingCodes: findings.map((finding) => finding.code)
  };
}

function decisionForEffect(effect: GovernanceRuleEffect): DeterministicGovernanceDecision {
  if (effect === "terminate") return "governance_terminated";
  if (effect === "escalate") return "governance_escalation_required";
  if (effect === "replan") return "governance_replan_required";
  if (effect === "repair") return "governance_repair_required";
  return "governance_passed";
}

function riskForRules(rules: readonly MutableRule[]): "low" | "medium" | "high" | "critical" {
  const triggered = rules.filter((rule) => rule.triggered);
  const highestEffect = triggered.reduce(
    (highest, rule) => EFFECT_RANK[rule.effect] > EFFECT_RANK[highest] ? rule.effect : highest,
    "none" as GovernanceRuleEffect
  );
  let rank = highestEffect === "terminate" ? 3 : highestEffect === "escalate" ? 2 :
    highestEffect === "repair" || highestEffect === "replan" ? 1 : 0;
  for (const rule of triggered) rank = Math.max(rank, SEVERITY_RANK[rule.severity]);
  return (["low", "medium", "high", "critical"] as const)[rank] ?? "critical";
}

const ISSUE_MESSAGES: Record<RuleId, string> = Object.fromEntries(
  RULE_DEFINITIONS.map(([ruleId]) => [ruleId, `Deterministic governance rule ${ruleId} triggered.`])
) as Record<RuleId, string>;

function finalizeResult(options: {
  trace: RunAccountabilityTrace;
  observation: ShadowObservation | null;
  policy: Readonly<DeterministicGovernancePolicy>;
  rules: MutableRule[];
  summary: Omit<DeterministicGovernanceResult["summary"],
    "triggeredRuleCount" | "terminateRuleCount" | "escalationRuleCount" |
    "replanRuleCount" | "repairRuleCount" | "governanceHashValid">;
}): DeterministicGovernanceResult {
  const { trace, observation, policy, rules } = options;
  const frozenRuleResults = rules.map((rule) => ({
    ruleId: rule.ruleId,
    triggered: rule.triggered,
    severity: rule.severity,
    effect: rule.effect,
    reasonCode: rule.reasonCode,
    eventIds: sortedUnique(rule.eventIds),
    filePaths: sortedUnique(rule.filePaths),
    traceFindingCodes: sortedUnique(rule.traceFindingCodes),
    shadowFindingCodes: sortedUnique(rule.shadowFindingCodes)
  }));
  const triggered = frozenRuleResults.filter((rule) => rule.triggered);
  const highestEffect = triggered.reduce(
    (highest, rule) => EFFECT_RANK[rule.effect] > EFFECT_RANK[highest] ? rule.effect : highest,
    "none" as GovernanceRuleEffect
  );
  const decision = decisionForEffect(highestEffect);
  const triggeredRuleIds = triggered.map((rule) => rule.ruleId);
  const reasonCodes = sortedUnique(triggered.map((rule) => rule.reasonCode));
  const issues: GovernanceIssue[] = triggered.map((rule) => ({
    code: rule.reasonCode,
    message: ISSUE_MESSAGES[rule.ruleId as RuleId],
    severity: rule.severity,
    effect: rule.effect,
    eventIds: [...rule.eventIds],
    filePaths: [...rule.filePaths],
    traceFindingCodes: [...rule.traceFindingCodes],
    shadowFindingCodes: [...rule.shadowFindingCodes]
  }));
  const policyHash = hashCanonicalJson(policy);
  let assessmentObservationHash: string | null = null;
  try {
    assessmentObservationHash = observation !== null &&
      typeof observation.observationHash === "string" &&
      HASH_PATTERN.test(observation.observationHash)
      ? observation.observationHash
      : null;
  } catch {
    assessmentObservationHash = null;
  }
  const assessmentWithoutHash: Omit<DeterministicGovernanceAssessment, "governanceHash"> = {
    governanceVersion: DETERMINISTIC_GOVERNANCE_VERSION,
    runId: trace.runId,
    traceHash: trace.traceHash,
    observationHash: assessmentObservationHash,
    policy,
    policyHash,
    decision,
    triggeredRuleIds,
    reasonCodes,
    issues,
    ruleResults: frozenRuleResults,
    riskClass: riskForRules(rules)
  };
  const governanceHash = hashCanonicalJson(assessmentWithoutHash);
  const assessment: DeterministicGovernanceAssessment = {
    ...assessmentWithoutHash,
    governanceHash
  };
  const summary: DeterministicGovernanceResult["summary"] = {
    ...options.summary,
    triggeredRuleCount: triggered.length,
    terminateRuleCount: triggered.filter((rule) => rule.effect === "terminate").length,
    escalationRuleCount: triggered.filter((rule) => rule.effect === "escalate").length,
    replanRuleCount: triggered.filter((rule) => rule.effect === "replan").length,
    repairRuleCount: triggered.filter((rule) => rule.effect === "repair").length,
    governanceHashValid: HASH_PATTERN.test(governanceHash)
  };
  return deepFreeze({ decision, assessment, issues, summary }) as DeterministicGovernanceResult;
}

function evaluateVerifiedInputs(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  policy: Readonly<DeterministicGovernancePolicy>
): DeterministicGovernanceResult {
  const rules = makeRules();
  let traceIntegrityVerified = false;
  try {
    traceIntegrityVerified = hashCanonicalJson(traceHashMaterial(trace)) === trace.traceHash;
  } catch {
    traceIntegrityVerified = false;
  }
  if (!traceIntegrityVerified) applyRule(rules, "trace_integrity");

  const observationProvided = observation !== null;
  let observationIntegrityVerified = false;
  let observationBoundToTrace = false;
  if (observation !== null) {
    try {
      observationIntegrityVerified =
        hashCanonicalJson(observationHashMaterial(observation)) === observation.observationHash;
      observationBoundToTrace =
        observation.runId === trace.runId && observation.traceHash === trace.traceHash;
    } catch {
      observationIntegrityVerified = false;
      observationBoundToTrace = false;
    }
    if (!observationIntegrityVerified) applyRule(rules, "shadow_observation_integrity");
    if (!observationBoundToTrace) applyRule(rules, "shadow_observation_trace_binding");
  } else if (policy.requireShadowObservation) {
    applyRule(rules, "shadow_observation_required");
  }

  let externalTraceAnchorPresent = false;
  let externalTraceAnchorMatched = false;
  let executionObserved = false;
  let executionCompleted = false;
  let executionPassed = false;
  let executionFailed = false;
  let executionNeedsReview = false;
  let cleanupEvidenceObserved = false;
  let cleanupFailureObserved = false;
  let forbiddenProposedPaths: string[] = [];
  let forbiddenAppliedPaths: string[] = [];
  let suspiciousReadPaths: string[] = [];
  let unplannedProposedFileCount = 0;
  let appliedButUnproposedFileCount = 0;
  let scopeExpansionFactor: number | null = null;
  let repairCount = 0;
  let remaskCount = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;
  let wallClockSpanMs = 0;
  let traceWarningCount = 0;
  let traceErrorCount = 0;

  if (traceIntegrityVerified) {
    externalTraceAnchorPresent = trace.externallyAnchored === true;
    externalTraceAnchorMatched = trace.externalAnchorsMatched === true;
    if (policy.requireExternalTraceAnchor) {
      if (externalTraceAnchorPresent && !externalTraceAnchorMatched) {
        applyRule(
          rules,
          "external_trace_anchor",
          "governance_external_trace_anchor_mismatch",
          "critical",
          "terminate"
        );
      } else if (!externalTraceAnchorPresent) {
        applyRule(rules, "external_trace_anchor");
      }
    } else if (externalTraceAnchorPresent && !externalTraceAnchorMatched) {
      applyRule(
        rules,
        "external_trace_anchor",
        "governance_external_trace_anchor_mismatch",
        "critical",
        "terminate"
      );
    }

    executionObserved = trace.phaseVExecutionObserved === true;
    const finalExecutionDecision = trace.decisions.finalExecutionDecision;
    const terminalDecision = typeof finalExecutionDecision === "string" &&
      TERMINAL_EXECUTION_DECISIONS.has(finalExecutionDecision);
    executionCompleted = trace.phaseVExecutionCompleted === true && terminalDecision;
    executionPassed = executionCompleted && finalExecutionDecision === "temp_validation_passed";
    executionFailed = executionCompleted && finalExecutionDecision === "temp_validation_failed";
    executionNeedsReview = executionCompleted &&
      finalExecutionDecision === "temp_validation_needs_review";
    if (policy.requireExecutionTerminalDecision && !executionObserved) {
      applyRule(rules, "execution_observed");
    }
    if (policy.requireExecutionTerminalDecision && !executionCompleted) {
      applyRule(rules, "execution_terminal");
    }
    if (policy.requireSuccessfulExecutionForPass && executionFailed) {
      applyRule(rules, "execution_outcome");
    } else if (policy.requireSuccessfulExecutionForPass && executionNeedsReview) {
      applyRule(
        rules,
        "execution_outcome",
        "governance_execution_needs_review",
        "high",
        "escalate"
      );
    }

    const executionEvents = trace.events.filter((event) => event.actor === "execution_verifier");
    const cleanupSuccessEvents = executionEvents.filter((event) =>
      event.reasonCodes.includes("temp_workspace_cleanup_performed")
    );
    const cleanupFailureEvents = executionEvents.filter((event) =>
      event.reasonCodes.includes("temp_workspace_cleanup_failed")
    );
    cleanupEvidenceObserved = cleanupSuccessEvents.length > 0;
    cleanupFailureObserved = cleanupFailureEvents.length > 0;
    const cleanupEventIds = [
      ...cleanupSuccessEvents.map((event) => event.eventId),
      ...cleanupFailureEvents.map((event) => event.eventId)
    ];
    if (cleanupEvidenceObserved && cleanupFailureObserved) {
      applyRule(
        rules,
        "cleanup_integrity",
        "governance_conflicting_cleanup_evidence",
        "critical",
        "terminate",
        { eventIds: cleanupEventIds }
      );
    } else if (cleanupFailureObserved) {
      applyRule(
        rules,
        "cleanup_integrity",
        "governance_temp_workspace_cleanup_failed",
        "critical",
        "escalate",
        { eventIds: cleanupEventIds }
      );
    } else if (policy.requireCleanupEvidenceForPass && !cleanupEvidenceObserved) {
      applyRule(rules, "cleanup_integrity", undefined, undefined, undefined, {
        eventIds: executionEvents.map((event) => event.eventId)
      });
    }

    forbiddenProposedPaths = trace.files.allProposedFiles.filter(forbiddenPath);
    forbiddenAppliedPaths = trace.files.temporaryAppliedFiles.filter(forbiddenPath);
    const proposedOrApplied = new Set([
      ...trace.files.allProposedFiles,
      ...trace.files.temporaryAppliedFiles
    ]);
    suspiciousReadPaths = sortedUnique([
      ...trace.files.plannedFiles,
      ...trace.files.executionReadFiles
    ].filter((path) => forbiddenPath(path) && !proposedOrApplied.has(path)));
    if (forbiddenProposedPaths.length > 0) {
      applyRule(rules, "forbidden_proposed_paths", undefined, undefined, undefined, {
        filePaths: forbiddenProposedPaths
      });
    }
    if (forbiddenAppliedPaths.length > 0) {
      applyRule(rules, "forbidden_applied_paths", undefined, undefined, undefined, {
        filePaths: forbiddenAppliedPaths
      });
    }
    if (suspiciousReadPaths.length > 0) {
      applyRule(rules, "suspicious_read_or_plan_paths", undefined, undefined, undefined, {
        filePaths: suspiciousReadPaths
      });
    }

    unplannedProposedFileCount = trace.files.unplannedProposedFiles.length;
    appliedButUnproposedFileCount = trace.files.appliedButUnproposedFiles.length;
    scopeExpansionFactor = trace.files.scopeExpansionFactor;
    if (appliedButUnproposedFileCount > 0) {
      applyRule(rules, "applied_scope_consistency", undefined, undefined, undefined, {
        filePaths: trace.files.appliedButUnproposedFiles
      });
    }
    if (unplannedProposedFileCount > 0) {
      applyRule(rules, "planned_scope_consistency", undefined, undefined, undefined, {
        filePaths: trace.files.unplannedProposedFiles
      });
    }
    if (trace.files.plannedFileCount === 0 && trace.files.proposedFileCount > 0) {
      applyRule(rules, "proposed_scope_without_plan", undefined, undefined, undefined, {
        filePaths: trace.files.allProposedFiles
      });
    }
    if (scopeExpansionFactor === null && trace.files.proposedFileCount > 0) {
      applyRule(
        rules,
        "scope_expansion_limit",
        "governance_scope_expansion_undefined"
      );
    } else if (
      scopeExpansionFactor !== null &&
      scopeExpansionFactor > policy.maxScopeExpansionFactor
    ) {
      applyRule(rules, "scope_expansion_limit");
    }
    if (trace.files.plannedFileCount > policy.maxPlannedFiles) applyRule(rules, "planned_file_limit");
    if (trace.files.proposedFileCount > policy.maxProposedFiles) applyRule(rules, "proposed_file_limit");
    if (trace.files.temporaryAppliedFileCount > policy.maxTemporaryAppliedFiles) {
      applyRule(rules, "temporary_applied_file_limit");
    }

    repairCount = trace.repairActivity.repairCount;
    remaskCount = trace.repairActivity.remaskCount;
    if (repairCount > policy.maxRepairCount) applyRule(rules, "repair_count_limit");
    if (remaskCount > policy.maxRemaskCount) applyRule(rules, "remask_count_limit");

    totalTokens = trace.resources.totalTokens;
    totalDurationMs = trace.resources.totalDurationMs;
    wallClockSpanMs = trace.resources.wallClockSpanMs;
    if (totalTokens > policy.maxTotalTokens) applyRule(rules, "total_token_limit");
    if (totalDurationMs > policy.maxTotalDurationMs) applyRule(rules, "total_duration_limit");
    if (wallClockSpanMs > policy.maxWallClockSpanMs) applyRule(rules, "wall_clock_limit");

    traceWarningCount = trace.findings.filter((finding) => finding.severity === "warning").length;
    traceErrorCount = trace.findings.filter((finding) => finding.severity === "error").length;
    const selectFindings = (codes: Set<string>): TraceFinding[] =>
      trace.findings.filter((finding) => codes.has(finding.code));
    const resourceOverflow = trace.findings.filter((finding) =>
      finding.code === "resource_total_overflow"
    );
    if (resourceOverflow.length > 0) {
      applyRule(
        rules,
        "resource_accounting_integrity",
        undefined,
        undefined,
        undefined,
        evidenceFromTraceFindings(resourceOverflow)
      );
    }
    const hardErrors = selectFindings(HARD_TRACE_ERRORS);
    if (hardErrors.length > 0) {
      applyRule(rules, "classified_trace_errors", undefined, undefined, undefined,
        evidenceFromTraceFindings(hardErrors));
    }
    const planningWarnings = selectFindings(PLANNING_WARNINGS);
    if (planningWarnings.length > 0) {
      applyRule(rules, "classified_trace_planning_warnings", undefined, undefined, undefined,
        evidenceFromTraceFindings(planningWarnings));
    }
    const executionWarnings = selectFindings(EXECUTION_WARNINGS);
    if (executionWarnings.length > 0) {
      applyRule(rules, "classified_trace_execution_warnings", undefined, undefined, undefined,
        evidenceFromTraceFindings(executionWarnings));
    }
    const loopWarnings = selectFindings(LOOP_WARNINGS);
    if (loopWarnings.length > 0) {
      applyRule(rules, "classified_trace_loop_warnings", undefined, undefined, undefined,
        evidenceFromTraceFindings(loopWarnings));
    }
    const unknownErrors = trace.findings.filter((finding) =>
      finding.severity === "error" && !CLASSIFIED_TRACE_CODES.has(finding.code)
    );
    if (unknownErrors.length > 0) {
      applyRule(rules, "unclassified_trace_error", undefined, undefined, undefined,
        evidenceFromTraceFindings(unknownErrors));
    }
    const unknownWarnings = trace.findings.filter((finding) =>
      finding.severity === "warning" && !CLASSIFIED_TRACE_CODES.has(finding.code)
    );
    if (unknownWarnings.length > 0) {
      applyRule(rules, "unclassified_trace_warning", undefined, undefined, undefined,
        evidenceFromTraceFindings(unknownWarnings));
    }
  }

  const trustedObservation = traceIntegrityVerified && observationIntegrityVerified &&
    observationBoundToTrace && observation !== null ? observation : null;
  if (trustedObservation !== null) {
    const shadowEvidence = evidenceFromShadowFindings(trustedObservation.findings);
    setRuleEvidence(rules, "shadow_recommendation", shadowEvidence);
    setRuleEvidence(rules, "shadow_risk_level", shadowEvidence);
    if (trustedObservation.recommendation === "request_repair") {
      applyRule(rules, "shadow_recommendation", "governance_shadow_recommends_repair", "warning", "repair",
        shadowEvidence);
    } else if (trustedObservation.recommendation === "request_replan") {
      applyRule(rules, "shadow_recommendation", "governance_shadow_recommends_replan", "warning", "replan",
        shadowEvidence);
    } else if (trustedObservation.recommendation === "escalate") {
      applyRule(rules, "shadow_recommendation", "governance_shadow_recommends_escalation", "high", "escalate",
        shadowEvidence);
    } else if (trustedObservation.recommendation === "terminate") {
      applyRule(rules, "shadow_recommendation", "governance_shadow_recommends_termination_review", "critical", "escalate",
        shadowEvidence);
    }
    if (trustedObservation.riskLevel === "medium") {
      applyRule(rules, "shadow_risk_level", "governance_shadow_medium_risk", "warning", "escalate",
        shadowEvidence);
    } else if (trustedObservation.riskLevel === "high") {
      applyRule(rules, "shadow_risk_level", "governance_shadow_high_risk", "high", "escalate",
        shadowEvidence);
    } else if (trustedObservation.riskLevel === "critical") {
      applyRule(rules, "shadow_risk_level", "governance_shadow_critical_risk", "critical", "escalate",
        shadowEvidence);
    }
    const criticalFindings = trustedObservation.findings.filter((finding) =>
      finding.severity === "critical"
    );
    if (criticalFindings.length > 0) {
      applyRule(rules, "shadow_critical_finding", undefined, undefined, undefined,
        evidenceFromShadowFindings(criticalFindings));
    }
    const highFindings = trustedObservation.findings.filter((finding) => finding.severity === "high");
    if (highFindings.length > 0) {
      applyRule(rules, "shadow_high_finding", undefined, undefined, undefined,
        evidenceFromShadowFindings(highFindings));
    }
  }

  const summaryBase = {
    traceIntegrityVerified,
    observationProvided,
    observationIntegrityVerified,
    observationBoundToTrace,
    externalTraceAnchorPresent,
    externalTraceAnchorMatched,
    executionObserved,
    executionCompleted,
    executionPassed,
    executionFailed,
    executionNeedsReview,
    cleanupEvidenceObserved,
    cleanupFailureObserved,
    forbiddenProposedPathCount: forbiddenProposedPaths.length,
    forbiddenAppliedPathCount: forbiddenAppliedPaths.length,
    suspiciousReadPathCount: suspiciousReadPaths.length,
    unplannedProposedFileCount,
    appliedButUnproposedFileCount,
    scopeExpansionFactor,
    repairCount,
    remaskCount,
    totalTokens,
    totalDurationMs,
    wallClockSpanMs,
    traceWarningCount,
    traceErrorCount,
    shadowRiskLevel: trustedObservation?.riskLevel ?? null,
    shadowRecommendation: trustedObservation?.recommendation ?? null
  };
  return finalizeResult({ trace, observation, policy, rules, summary: summaryBase });
}

function safeMetadataTrace(trace: RunAccountabilityTrace): RunAccountabilityTrace {
  const zeroHash = `sha256:${"0".repeat(64)}`;
  let runId = "unavailable-run";
  let traceHash = zeroHash;
  try {
    if (typeof trace?.runId === "string" && trace.runId.length > 0 && trace.runId.length <= 128) {
      runId = trace.runId;
    }
    if (typeof trace?.traceHash === "string" && trace.traceHash.length <= 128) {
      traceHash = trace.traceHash;
    }
  } catch {
    // Bounded fallback metadata is used below.
  }
  return {
    traceVersion: "1",
    runId,
    objectiveHash: zeroHash,
    ledgerRootHash: zeroHash,
    ledgerEventCount: 0,
    externallyAnchored: false,
    externalAnchorsMatched: false,
    rolesCalled: [],
    roleActivity: [],
    events: [],
    files: {
      plannedFiles: [], coderProposedFiles: [], repairProposedFiles: [], allProposedFiles: [],
      temporaryAppliedFiles: [], executionReadFiles: [], unplannedProposedFiles: [],
      appliedButUnproposedFiles: [], plannedFileCount: 0, proposedFileCount: 0,
      temporaryAppliedFileCount: 0, scopeExpansionFactor: null
    },
    decisions: {
      plannerDecisions: [], coderDecisions: [], deterministicVerifierDecisions: [],
      repairVerifierDecisions: [], patchDryRunDecisions: [], temporaryApplyDecisions: [],
      executionDecisions: [], finalDeterministicVerifierDecision: null,
      finalRepairVerifierDecision: null, finalPatchDryRunDecision: null,
      finalTemporaryApplyDecision: null, finalExecutionDecision: null,
      uniqueExecutionDecisions: [], executionDecisionConflict: false
    },
    repairActivity: {
      plannerCallCount: 0, coderCallCount: 0, deterministicVerifierCallCount: 0,
      remaskCount: 0, repairCount: 0, repairVerifierCallCount: 0,
      patchDryRunCallCount: 0, temporaryApplyCallCount: 0,
      executionVerifierCallCount: 0, governanceRoleCallCount: 0,
      repeatedActorTransitions: 0
    },
    resources: {
      totalDurationMs: 0, eventsWithTokenUsage: 0, eventsWithoutTokenUsage: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
      longestEventDurationMs: 0, longestEventId: null, firstStartedAt: null,
      lastFinishedAt: null, wallClockSpanMs: 0
    },
    findings: [],
    phaseVExecutionObserved: false,
    phaseVExecutionCompleted: false,
    traceHash
  };
}

export function evaluateDeterministicGovernance(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  policy?: DeterministicGovernancePolicy
): DeterministicGovernanceResult {
  const normalizedPolicy = normalizePolicy(policy);
  try {
    return evaluateVerifiedInputs(trace, observation, normalizedPolicy);
  } catch {
    const boundedTrace = safeMetadataTrace(trace);
    const rules = makeRules();
    applyRule(rules, "trace_integrity");
    return finalizeResult({
      trace: boundedTrace,
      observation: null,
      policy: normalizedPolicy,
      rules,
      summary: {
        traceIntegrityVerified: false,
        observationProvided: observation !== null,
        observationIntegrityVerified: false,
        observationBoundToTrace: false,
        externalTraceAnchorPresent: false,
        externalTraceAnchorMatched: false,
        executionObserved: false,
        executionCompleted: false,
        executionPassed: false,
        executionFailed: false,
        executionNeedsReview: false,
        cleanupEvidenceObserved: false,
        cleanupFailureObserved: false,
        forbiddenProposedPathCount: 0,
        forbiddenAppliedPathCount: 0,
        suspiciousReadPathCount: 0,
        unplannedProposedFileCount: 0,
        appliedButUnproposedFileCount: 0,
        scopeExpansionFactor: null,
        repairCount: 0,
        remaskCount: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        wallClockSpanMs: 0,
        traceWarningCount: 0,
        traceErrorCount: 0,
        shadowRiskLevel: null,
        shadowRecommendation: null
      }
    });
  }
}
