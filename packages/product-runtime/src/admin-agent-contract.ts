import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";
import type { ShadowObservation } from "./shadow-observer-contract.js";
import type {
  DeterministicGovernanceAssessment,
  DeterministicGovernanceDecision,
  GovernanceRuleEffect
} from "./deterministic-governance-policy.js";

/**
 * Deterministic governance remains the hard authority: Admin may preserve or
 * strengthen it, never weaken it. Auto approval is not repository-apply
 * authorization, and structural/evidence validation cannot prove objective
 * semantic correctness. Admin output remains advisory workflow control until a
 * later risk router and handoff; W.8 performs no repository mutation. Model
 * adapters must send only bounded evidence and discard raw output after hashing.
 */

export const ADMIN_DECISION_VERSION = "1" as const;

export type AdminDecision =
  | "admin_auto_approved"
  | "admin_repair_required"
  | "admin_replan_required"
  | "admin_human_escalation_required"
  | "admin_run_terminated";
export type AdminRiskLevel = "low" | "medium" | "high" | "critical";
export type AdminFindingSeverity = "info" | "warning" | "high" | "critical";

export type AdminFindingDraft = {
  code: string;
  severity: AdminFindingSeverity;
  message: string;
  governanceRuleIds: string[];
  governanceReasonCodes: string[];
  governanceIssueCodes: string[];
  traceFindingCodes: string[];
  shadowFindingCodes: string[];
  evidenceEventIds: string[];
  evidenceFilePaths: string[];
};

export type AdminFinding = Omit<AdminFindingDraft,
  "governanceRuleIds" | "governanceReasonCodes" | "governanceIssueCodes" |
  "traceFindingCodes" | "shadowFindingCodes" | "evidenceEventIds" | "evidenceFilePaths"
> & {
  governanceRuleIds: readonly string[];
  governanceReasonCodes: readonly string[];
  governanceIssueCodes: readonly string[];
  traceFindingCodes: readonly string[];
  shadowFindingCodes: readonly string[];
  evidenceEventIds: readonly string[];
  evidenceFilePaths: readonly string[];
};

export type AdminDecisionDraft = {
  decisionVersion: "1";
  runId: string;
  traceHash: string;
  observationHash: string | null;
  governanceHash: string;
  decision: AdminDecision;
  riskLevel: AdminRiskLevel;
  riskScore: number;
  confidenceScore: number;
  findings: AdminFindingDraft[];
  rationaleCodes: string[];
};

export type ValidatedAdminDecision = {
  decisionVersion: "1";
  runId: string;
  traceHash: string;
  observationHash: string | null;
  governanceHash: string;
  governanceDecision: DeterministicGovernanceDecision;
  decision: AdminDecision;
  riskLevel: AdminRiskLevel;
  riskScore: number;
  confidenceScore: number;
  findings: readonly AdminFinding[];
  rationaleCodes: readonly string[];
  adminDecisionHash: string;
};

export type AdminDecisionValidationDecision =
  | "admin_decision_valid"
  | "admin_decision_invalid"
  | "admin_decision_needs_review";
export type AdminDecisionValidationIssueSeverity = "review" | "error";
export type AdminDecisionValidationIssue = {
  code: string;
  message: string;
  severity: AdminDecisionValidationIssueSeverity;
  field?: string;
  findingIndex?: number;
  evidenceValue?: string;
};

export type AdminDecisionValidationResult = {
  decision: AdminDecisionValidationDecision;
  issues: readonly AdminDecisionValidationIssue[];
  adminDecision: ValidatedAdminDecision | null;
  summary: {
    traceIntegrityVerified: boolean;
    observationProvided: boolean;
    observationIntegrityVerified: boolean;
    observationBoundToTrace: boolean;
    governanceIntegrityVerified: boolean;
    governanceBoundToTrace: boolean;
    governanceBoundToObservation: boolean;
    structureValid: boolean;
    versionSupported: boolean;
    runIdMatched: boolean;
    traceHashMatched: boolean;
    observationHashMatched: boolean;
    governanceHashMatched: boolean;
    adminDecisionAllowedByGovernance: boolean;
    deterministicAuthorityPreserved: boolean;
    riskLevelValid: boolean;
    riskScoreValid: boolean;
    confidenceScoreValid: boolean;
    evidenceReferencesValid: boolean;
    semanticConsistencyValid: boolean;
    findingCount: number;
    infoFindingCount: number;
    warningFindingCount: number;
    highFindingCount: number;
    criticalFindingCount: number;
    citedGovernanceRuleCount: number;
    citedGovernanceReasonCount: number;
    citedGovernanceIssueCount: number;
    citedTraceFindingCount: number;
    citedShadowFindingCount: number;
    citedEventCount: number;
    citedFileCount: number;
    adminDecisionBuilt: boolean;
    adminDecisionHashValid: boolean;
  };
};

type Summary = AdminDecisionValidationResult["summary"];
type Context = Pick<AdminDecisionValidationIssue, "field" | "findingIndex" | "evidenceValue">;

const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DECISIONS = new Set<AdminDecision>([
  "admin_auto_approved", "admin_repair_required", "admin_replan_required",
  "admin_human_escalation_required", "admin_run_terminated"
]);
const RISKS = new Set<AdminRiskLevel>(["low", "medium", "high", "critical"]);
const SEVERITIES = new Set<AdminFindingSeverity>(["info", "warning", "high", "critical"]);
const RISK_RANK: Record<AdminRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const SEVERITY_RANK: Record<AdminFindingSeverity, number> = { critical: 0, high: 1, warning: 2, info: 3 };
const TOP_FIELDS = [
  "decisionVersion", "runId", "traceHash", "observationHash", "governanceHash",
  "decision", "riskLevel", "riskScore", "confidenceScore", "findings", "rationaleCodes"
] as const;
const FINDING_FIELDS = [
  "code", "severity", "message", "governanceRuleIds", "governanceReasonCodes",
  "governanceIssueCodes", "traceFindingCodes", "shadowFindingCodes", "evidenceEventIds",
  "evidenceFilePaths"
] as const;
const EVIDENCE_FIELDS = [
  ["governanceRuleIds", 32], ["governanceReasonCodes", 64],
  ["governanceIssueCodes", 32], ["traceFindingCodes", 32],
  ["shadowFindingCodes", 32], ["evidenceEventIds", 64], ["evidenceFilePaths", 64]
] as const;
const ALLOWED: Record<DeterministicGovernanceDecision, readonly AdminDecision[]> = {
  governance_passed: [...DECISIONS],
  governance_repair_required: ["admin_repair_required", "admin_replan_required", "admin_human_escalation_required", "admin_run_terminated"],
  governance_replan_required: ["admin_replan_required", "admin_human_escalation_required", "admin_run_terminated"],
  governance_escalation_required: ["admin_human_escalation_required", "admin_run_terminated"],
  governance_terminated: ["admin_run_terminated"]
};
const GOVERNANCE_RISK: Record<DeterministicGovernanceDecision, AdminRiskLevel> = {
  governance_passed: "low", governance_repair_required: "medium",
  governance_replan_required: "medium", governance_escalation_required: "high",
  governance_terminated: "critical"
};
const DECISION_RISK: Record<AdminDecision, AdminRiskLevel> = {
  admin_auto_approved: "low", admin_repair_required: "medium", admin_replan_required: "medium",
  admin_human_escalation_required: "high", admin_run_terminated: "critical"
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function initialSummary(observation: ShadowObservation | null): Summary {
  return {
    traceIntegrityVerified: false, observationProvided: observation !== null,
    observationIntegrityVerified: observation === null, observationBoundToTrace: observation === null,
    governanceIntegrityVerified: false, governanceBoundToTrace: false,
    governanceBoundToObservation: false, structureValid: false, versionSupported: false,
    runIdMatched: false, traceHashMatched: false, observationHashMatched: false,
    governanceHashMatched: false, adminDecisionAllowedByGovernance: false,
    deterministicAuthorityPreserved: false, riskLevelValid: false, riskScoreValid: false,
    confidenceScoreValid: false, evidenceReferencesValid: false,
    semanticConsistencyValid: false, findingCount: 0, infoFindingCount: 0,
    warningFindingCount: 0, highFindingCount: 0, criticalFindingCount: 0,
    citedGovernanceRuleCount: 0, citedGovernanceReasonCount: 0,
    citedGovernanceIssueCount: 0, citedTraceFindingCount: 0, citedShadowFindingCount: 0,
    citedEventCount: 0, citedFileCount: 0, adminDecisionBuilt: false,
    adminDecisionHashValid: false
  };
}

function traceMaterial(trace: RunAccountabilityTrace): Omit<RunAccountabilityTrace, "traceHash"> {
  return {
    traceVersion: trace.traceVersion, runId: trace.runId, objectiveHash: trace.objectiveHash,
    ledgerRootHash: trace.ledgerRootHash, ledgerEventCount: trace.ledgerEventCount,
    externallyAnchored: trace.externallyAnchored, externalAnchorsMatched: trace.externalAnchorsMatched,
    rolesCalled: trace.rolesCalled, roleActivity: trace.roleActivity, events: trace.events,
    files: trace.files, decisions: trace.decisions, repairActivity: trace.repairActivity,
    resources: trace.resources, findings: trace.findings,
    phaseVExecutionObserved: trace.phaseVExecutionObserved,
    phaseVExecutionCompleted: trace.phaseVExecutionCompleted
  };
}

function observationMaterial(observation: ShadowObservation): Omit<ShadowObservation, "observationHash"> {
  return {
    observationVersion: observation.observationVersion, runId: observation.runId,
    traceHash: observation.traceHash, riskLevel: observation.riskLevel,
    riskScore: observation.riskScore, confidenceScore: observation.confidenceScore,
    findings: observation.findings, observedScopeDrift: observation.observedScopeDrift,
    observedPlanPatchMismatch: observation.observedPlanPatchMismatch,
    observedRepairLoop: observation.observedRepairLoop,
    observedSuspiciousRoleBehavior: observation.observedSuspiciousRoleBehavior,
    observedEvidenceConflict: observation.observedEvidenceConflict,
    recommendation: observation.recommendation, rationaleCodes: observation.rationaleCodes
  };
}

function governanceMaterial(governance: DeterministicGovernanceAssessment): Omit<DeterministicGovernanceAssessment, "governanceHash"> {
  return {
    governanceVersion: governance.governanceVersion, runId: governance.runId,
    traceHash: governance.traceHash, observationHash: governance.observationHash,
    policy: governance.policy, policyHash: governance.policyHash, decision: governance.decision,
    triggeredRuleIds: governance.triggeredRuleIds, reasonCodes: governance.reasonCodes,
    issues: governance.issues, ruleResults: governance.ruleResults, riskClass: governance.riskClass
  };
}

function exactObject(
  value: unknown, fields: readonly string[], issue: (code: string, message: string, severity: AdminDecisionValidationIssueSeverity, context?: Context, structural?: boolean) => void,
  codes: readonly [string, string, string, string, string, string], context: Context = {}
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issue(codes[0], "The supplied value is not an object.", "error", context, true); return null;
  }
  if (Array.isArray(value)) {
    issue(codes[1], "Only a plain object is accepted.", "error", context, true); return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    issue(codes[1], "Only a plain object is accepted.", "error", context, true); return null;
  }
  const output: Record<string, unknown> = {};
  const present = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") { issue(codes[5], "Symbol properties are not accepted.", "error", context, true); continue; }
    present.add(key);
    const ctx = key.length <= 128 && !CONTROL.test(key) ? { ...context, field: key } : context;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      issue(codes[4], "Accessor properties are not accepted.", "error", ctx, true); continue;
    }
    if (!fields.includes(key)) { issue(codes[2], "The object contains an unknown field.", "error", ctx, true); continue; }
    output[key] = descriptor.value;
  }
  for (const field of fields) if (!present.has(field)) issue(codes[3], "A required field is missing.", "error", { ...context, field }, true);
  return output;
}

function arrayLength(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  return descriptor && "value" in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
    ? descriptor.value as number : null;
}

function denseArray(value: unknown, maximum: number): unknown[] | null {
  const length = arrayLength(value);
  if (length === null || length > maximum) return null;
  for (const key of Reflect.ownKeys(value as object)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) return null;
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    output.push(descriptor.value);
  }
  return output;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && IDENTIFIER.test(value);
}

function normalizeEvidence(value: unknown, maximum: number, filePath: boolean): string[] | null {
  const values = denseArray(value, maximum);
  if (values === null) return null;
  for (const item of values) {
    if (typeof item !== "string" || item.length === 0 || item.length > (filePath ? 512 : 128) || item.trim() !== item || CONTROL.test(item) || (!filePath && !IDENTIFIER.test(item))) return null;
  }
  return [...new Set(values as string[])].sort();
}

function scoreMatchesRisk(risk: AdminRiskLevel, score: number): boolean {
  return (risk === "low" && score <= 24) || (risk === "medium" && score >= 25 && score <= 49) ||
    (risk === "high" && score >= 50 && score <= 74) || (risk === "critical" && score >= 75);
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sortFindings(findings: AdminFinding[]): AdminFinding[] {
  return findings.sort((a, b) => {
    const values: (number | string)[] = [SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity], compare(a.code, b.code)];
    for (const field of EVIDENCE_FIELDS) values.push(compare(canonicalizeJson(a[field[0]]), canonicalizeJson(b[field[0]])));
    values.push(compare(a.message, b.message));
    return (values.find((value) => value !== 0) as number | undefined) ?? 0;
  });
}

function hasAnyEvidence(finding: AdminFinding): boolean {
  return EVIDENCE_FIELDS.some(([field]) => finding[field].length > 0);
}

export function validateAdminDecision(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  governance: DeterministicGovernanceAssessment,
  input: unknown
): AdminDecisionValidationResult {
  const issues: AdminDecisionValidationIssue[] = [];
  const summary = initialSummary(observation);
  let structural = false;
  let evidenceInvalid = false;
  let semanticInvalid = false;
  const issue = (code: string, message: string, severity: AdminDecisionValidationIssueSeverity, context: Context = {}, isStructural = false): void => {
    issues.push({ code, message, severity, ...context });
    if (isStructural) structural = true;
  };
  const finish = (candidate: ValidatedAdminDecision | null): AdminDecisionValidationResult => {
    const error = issues.some((item) => item.severity === "error");
    const review = issues.some((item) => item.severity === "review");
    const decision: AdminDecisionValidationDecision = error ? "admin_decision_invalid" : review ? "admin_decision_needs_review" : "admin_decision_valid";
    const adminDecision = error ? null : candidate;
    summary.structureValid = !structural;
    summary.evidenceReferencesValid = !evidenceInvalid && summary.traceIntegrityVerified && summary.governanceIntegrityVerified;
    summary.semanticConsistencyValid = !semanticInvalid && !error;
    summary.adminDecisionBuilt = adminDecision !== null;
    summary.adminDecisionHashValid = adminDecision !== null && HASH.test(adminDecision.adminDecisionHash);
    return deepFreeze({ decision, issues, adminDecision, summary }) as AdminDecisionValidationResult;
  };

  try {
    try {
      summary.traceIntegrityVerified = hashCanonicalJson(traceMaterial(trace)) === trace.traceHash;
    } catch { summary.traceIntegrityVerified = false; }
    if (!summary.traceIntegrityVerified) { issue("admin_trace_integrity_mismatch", "The accountability trace integrity check failed.", "error"); return finish(null); }

    if (observation !== null) {
      try { summary.observationIntegrityVerified = hashCanonicalJson(observationMaterial(observation)) === observation.observationHash; }
      catch { summary.observationIntegrityVerified = false; }
      if (!summary.observationIntegrityVerified) { issue("admin_shadow_observation_integrity_mismatch", "The Shadow observation integrity check failed.", "error"); return finish(null); }
      summary.observationBoundToTrace = observation.runId === trace.runId && observation.traceHash === trace.traceHash;
      if (!summary.observationBoundToTrace) { issue("admin_shadow_observation_trace_mismatch", "The Shadow observation is not bound to this trace.", "error"); return finish(null); }
    }

    let policyHashValid = false;
    let governanceHashValid = false;
    try { policyHashValid = hashCanonicalJson(governance.policy) === governance.policyHash; } catch { policyHashValid = false; }
    if (!policyHashValid) { issue("admin_governance_policy_hash_mismatch", "The governance policy hash is inconsistent.", "error"); return finish(null); }
    try { governanceHashValid = hashCanonicalJson(governanceMaterial(governance)) === governance.governanceHash; } catch { governanceHashValid = false; }
    if (!governanceHashValid) { issue("admin_governance_integrity_mismatch", "The governance assessment integrity check failed.", "error"); return finish(null); }
    summary.governanceIntegrityVerified = true;
    summary.governanceBoundToTrace = governance.runId === trace.runId && governance.traceHash === trace.traceHash;
    if (!summary.governanceBoundToTrace) { issue("admin_governance_trace_mismatch", "Governance is not bound to this trace.", "error"); return finish(null); }
    const expectedObservationHash = observation?.observationHash ?? null;
    summary.governanceBoundToObservation = governance.observationHash === expectedObservationHash;
    if (!summary.governanceBoundToObservation) { issue("admin_governance_observation_mismatch", "Governance is not bound to this observation.", "error"); return finish(null); }

    const raw = exactObject(input, TOP_FIELDS, issue, [
      "invalid_admin_decision_input", "invalid_admin_decision_object", "unknown_admin_decision_field",
      "missing_admin_decision_field", "admin_decision_accessor_property", "admin_decision_symbol_property"
    ]);
    if (raw === null) return finish(null);

    if (raw.decisionVersion === ADMIN_DECISION_VERSION) summary.versionSupported = true;
    else if (typeof raw.decisionVersion === "string" && raw.decisionVersion.length > 0) {
      issue("unsupported_admin_decision_version", "The Admin decision version is unsupported.", "review", { field: "decisionVersion" }); return finish(null);
    } else issue("unsupported_admin_decision_version", "The Admin decision version is malformed.", "error", { field: "decisionVersion" }, true);

    summary.runIdMatched = raw.runId === trace.runId;
    summary.traceHashMatched = raw.traceHash === trace.traceHash;
    summary.observationHashMatched = raw.observationHash === expectedObservationHash;
    summary.governanceHashMatched = raw.governanceHash === governance.governanceHash;
    if (!summary.runIdMatched) issue("admin_run_id_mismatch", "runId does not match the trace.", "error", { field: "runId" });
    if (!summary.traceHashMatched) issue("admin_trace_hash_mismatch", "traceHash does not match the trace.", "error", { field: "traceHash" });
    if (!summary.observationHashMatched) issue("admin_observation_hash_mismatch", "observationHash does not match the observation.", "error", { field: "observationHash" });
    if (!summary.governanceHashMatched) issue("admin_governance_hash_mismatch", "governanceHash does not match governance.", "error", { field: "governanceHash" });

    const decisionValid = DECISIONS.has(raw.decision as AdminDecision);
    if (!decisionValid) issue("invalid_admin_decision", "The Admin decision is invalid.", "error", { field: "decision" }, true);
    summary.riskLevelValid = RISKS.has(raw.riskLevel as AdminRiskLevel);
    if (!summary.riskLevelValid) issue("invalid_admin_risk_level", "The Admin risk level is invalid.", "error", { field: "riskLevel" }, true);
    summary.riskScoreValid = Number.isSafeInteger(raw.riskScore) && (raw.riskScore as number) >= 0 && (raw.riskScore as number) <= 100;
    if (!summary.riskScoreValid) issue("invalid_admin_risk_score", "riskScore must be a safe integer from 0 to 100.", "error", { field: "riskScore" }, true);
    summary.confidenceScoreValid = Number.isSafeInteger(raw.confidenceScore) && (raw.confidenceScore as number) >= 0 && (raw.confidenceScore as number) <= 100;
    if (!summary.confidenceScoreValid) issue("invalid_admin_confidence_score", "confidenceScore must be a safe integer from 0 to 100.", "error", { field: "confidenceScore" }, true);
    if (summary.riskLevelValid && summary.riskScoreValid && !scoreMatchesRisk(raw.riskLevel as AdminRiskLevel, raw.riskScore as number)) {
      semanticInvalid = true; issue("admin_risk_level_score_mismatch", "riskLevel and riskScore are inconsistent.", "error");
    }

    const findingCount = arrayLength(raw.findings);
    if (findingCount === null) { issue("admin_findings_not_array", "findings must be an array.", "error", { field: "findings" }, true); return finish(null); }
    if (findingCount > 32) { issue("too_many_admin_findings", "The finding limit was exceeded.", "review", { field: "findings" }); return finish(null); }
    const rawFindings = denseArray(raw.findings, 32);
    if (rawFindings === null) { issue("sparse_admin_findings_array", "findings must be a dense data-property array.", "error", { field: "findings" }, true); return finish(null); }

    const rationaleCount = arrayLength(raw.rationaleCodes);
    if (rationaleCount === null) { issue("invalid_admin_rationale_codes", "rationaleCodes must be an array.", "error", { field: "rationaleCodes" }, true); return finish(null); }
    if (rationaleCount > 32) { issue("too_many_admin_rationale_codes", "The rationale code limit was exceeded.", "error", { field: "rationaleCodes" }, true); return finish(null); }
    const rawRationale = denseArray(raw.rationaleCodes, 32);
    if (rawRationale === null) { issue("invalid_admin_rationale_codes", "rationaleCodes must be a dense data-property array.", "error", { field: "rationaleCodes" }, true); return finish(null); }
    let rationaleValid = true;
    for (const value of rawRationale) if (!validIdentifier(value)) { rationaleValid = false; issue("invalid_admin_rationale_code", "A rationale code is invalid.", "error", { field: "rationaleCodes" }, true); }
    const rationaleCodes = rationaleValid ? [...new Set(rawRationale as string[])].sort() : [];

    const trusted: Record<(typeof EVIDENCE_FIELDS)[number][0], Set<string>> = {
      governanceRuleIds: new Set(governance.ruleResults.map((rule) => rule.ruleId)),
      governanceReasonCodes: new Set([...governance.reasonCodes, ...governance.ruleResults.map((rule) => rule.reasonCode)]),
      governanceIssueCodes: new Set(governance.issues.map((entry) => entry.code)),
      traceFindingCodes: new Set(trace.findings.map((entry) => entry.code)),
      shadowFindingCodes: new Set(observation?.findings.map((entry) => entry.code) ?? []),
      evidenceEventIds: new Set(trace.events.map((event) => event.eventId)),
      evidenceFilePaths: new Set([
        ...trace.files.plannedFiles, ...trace.files.coderProposedFiles, ...trace.files.repairProposedFiles,
        ...trace.files.allProposedFiles, ...trace.files.temporaryAppliedFiles, ...trace.files.executionReadFiles,
        ...trace.files.unplannedProposedFiles, ...trace.files.appliedButUnproposedFiles,
        ...trace.findings.flatMap((entry) => [...entry.filePaths]),
        ...(observation?.findings.flatMap((entry) => [...entry.evidenceFilePaths]) ?? []),
        ...governance.issues.flatMap((entry) => [...entry.filePaths]),
        ...governance.ruleResults.flatMap((entry) => [...entry.filePaths])
      ])
    };
    const unknownCodes: Record<(typeof EVIDENCE_FIELDS)[number][0], string> = {
      governanceRuleIds: "unknown_admin_governance_rule_id", governanceReasonCodes: "unknown_admin_governance_reason_code",
      governanceIssueCodes: "unknown_admin_governance_issue_code", traceFindingCodes: "unknown_admin_trace_finding_code",
      shadowFindingCodes: "unknown_admin_shadow_finding_code", evidenceEventIds: "unknown_admin_evidence_event_id",
      evidenceFilePaths: "unknown_admin_evidence_file_path"
    };
    const normalized: AdminFinding[] = [];
    for (let findingIndex = 0; findingIndex < rawFindings.length; findingIndex += 1) {
      const item = exactObject(rawFindings[findingIndex], FINDING_FIELDS, issue, [
        "invalid_admin_finding", "invalid_admin_finding", "unknown_admin_finding_field",
        "missing_admin_finding_field", "admin_finding_accessor_property", "admin_finding_symbol_property"
      ], { findingIndex });
      if (item === null) continue;
      let valid = true;
      if (!validIdentifier(item.code)) { valid = false; issue("invalid_admin_finding_code", "The finding code is invalid.", "error", { field: "code", findingIndex }, true); }
      if (!SEVERITIES.has(item.severity as AdminFindingSeverity)) { valid = false; issue("invalid_admin_finding_severity", "The finding severity is invalid.", "error", { field: "severity", findingIndex }, true); }
      if (typeof item.message !== "string" || item.message.length === 0 || item.message.length > 500 || item.message.trim() !== item.message || CONTROL.test(item.message)) {
        valid = false; issue("invalid_admin_finding_message", "The finding message is invalid.", "error", { field: "message", findingIndex }, true);
      }
      const arrays: Partial<Record<(typeof EVIDENCE_FIELDS)[number][0], string[]>> = {};
      for (const [field, maximum] of EVIDENCE_FIELDS) {
        const values = normalizeEvidence(item[field], maximum, field === "evidenceFilePaths");
        if (values === null) { valid = false; issue("invalid_admin_finding", "An evidence field is not a bounded dense string array.", "error", { field, findingIndex }, true); }
        else arrays[field] = values;
      }
      if (!valid) continue;
      const finding: AdminFinding = {
        code: item.code as string, severity: item.severity as AdminFindingSeverity,
        message: item.message as string, governanceRuleIds: arrays.governanceRuleIds!,
        governanceReasonCodes: arrays.governanceReasonCodes!, governanceIssueCodes: arrays.governanceIssueCodes!,
        traceFindingCodes: arrays.traceFindingCodes!, shadowFindingCodes: arrays.shadowFindingCodes!,
        evidenceEventIds: arrays.evidenceEventIds!, evidenceFilePaths: arrays.evidenceFilePaths!
      };
      if (!hasAnyEvidence(finding)) { semanticInvalid = true; issue("admin_finding_without_evidence", "Every finding must cite bounded evidence.", "error", { findingIndex }); }
      for (const [field] of EVIDENCE_FIELDS) for (const value of finding[field]) if (!trusted[field].has(value)) {
        evidenceInvalid = true; issue(unknownCodes[field], "A cited evidence value is not present in the verified package.", "error", { field, findingIndex, evidenceValue: value });
      }
      normalized.push(finding);
    }

    sortFindings(normalized);
    const deduped: AdminFinding[] = [];
    let previous = "";
    for (const finding of normalized) {
      const key = canonicalizeJson(finding);
      if (key === previous) issue("duplicate_admin_finding", "An exact normalized finding was duplicated.", "review");
      else { deduped.push(finding); previous = key; }
    }
    summary.findingCount = deduped.length;
    for (const finding of deduped) summary[`${finding.severity}FindingCount` as "infoFindingCount"] += 1;
    for (const [field] of EVIDENCE_FIELDS) {
      const count = new Set(deduped.flatMap((finding) => [...finding[field]])).size;
      const summaryField: Record<string, keyof Summary> = {
        governanceRuleIds: "citedGovernanceRuleCount", governanceReasonCodes: "citedGovernanceReasonCount",
        governanceIssueCodes: "citedGovernanceIssueCount", traceFindingCodes: "citedTraceFindingCount",
        shadowFindingCodes: "citedShadowFindingCount", evidenceEventIds: "citedEventCount", evidenceFilePaths: "citedFileCount"
      };
      (summary[summaryField[field]] as number) = count;
    }

    if (decisionValid) {
      const decision = raw.decision as AdminDecision;
      summary.adminDecisionAllowedByGovernance = ALLOWED[governance.decision].includes(decision);
      summary.deterministicAuthorityPreserved = summary.adminDecisionAllowedByGovernance;
      if (!summary.adminDecisionAllowedByGovernance) { semanticInvalid = true; issue("admin_decision_weakens_governance", "The Admin decision would weaken governance.", "error"); }
      if (summary.riskLevelValid) {
        const risk = raw.riskLevel as AdminRiskLevel;
        const requiredDecisionRisk = DECISION_RISK[decision];
        const exactAuto = decision !== "admin_auto_approved" || risk === "low";
        if (RISK_RANK[risk] < RISK_RANK[requiredDecisionRisk] || !exactAuto) { semanticInvalid = true; issue("admin_decision_risk_mismatch", "Risk is inconsistent with the Admin decision.", "error"); }
        if (RISK_RANK[risk] < RISK_RANK[GOVERNANCE_RISK[governance.decision]]) { semanticInvalid = true; issue("admin_understates_governance_risk", "Risk understates governance.", "error"); }
        if (observation && RISK_RANK[risk] < RISK_RANK[observation.riskLevel]) { semanticInvalid = true; issue("admin_understates_shadow_risk", "Risk understates the Shadow observation.", "error"); }
        const severities = new Set(deduped.map((finding) => finding.severity));
        if ((severities.has("critical") && risk !== "critical") || (severities.has("high") && RISK_RANK[risk] < 2) || (severities.has("warning") && RISK_RANK[risk] < 1)) {
          semanticInvalid = true; issue("admin_finding_severity_risk_mismatch", "Finding severity is inconsistent with risk.", "error");
        }
      }

      const triggered = new Set(governance.triggeredRuleIds);
      const triggeredReasons = new Set(governance.ruleResults.filter((rule) => rule.triggered).map((rule) => rule.reasonCode));
      const governanceEvidence = deduped.some((finding) => finding.governanceRuleIds.some((id) => triggered.has(id)) || finding.governanceReasonCodes.some((code) => triggeredReasons.has(code)) || finding.governanceIssueCodes.length > 0);
      if (decision !== "admin_auto_approved" && (deduped.length === 0 || (governance.decision !== "governance_passed" && !governanceEvidence))) {
        semanticInvalid = true; issue("admin_decision_missing_governance_evidence", "The decision lacks required governance evidence.", "error");
      }
      if (decision === "admin_auto_approved" && (governance.decision !== "governance_passed" || governance.triggeredRuleIds.length !== 0 || governance.issues.length !== 0 || raw.riskLevel !== "low" || (raw.riskScore as number) > 24 || deduped.some((finding) => finding.severity !== "info"))) {
        semanticInvalid = true; issue("admin_auto_approval_not_permitted", "Automatic approval is not permitted by this package.", "error");
      }

      const citedRules = new Set(deduped.flatMap((finding) => [...finding.governanceRuleIds]));
      const citedIssues = new Set(deduped.flatMap((finding) => [...finding.governanceIssueCodes]));
      const citedRuleEffect = (effect: GovernanceRuleEffect) => governance.ruleResults.some((rule) => citedRules.has(rule.ruleId) && rule.effect === effect);
      const citedIssueEffect = (effect: GovernanceRuleEffect) => governance.issues.some((entry) => citedIssues.has(entry.code) && entry.effect === effect);
      if (decision === "admin_run_terminated" && !(governance.decision === "governance_terminated" || deduped.some((finding) => finding.severity === "critical") || citedRuleEffect("terminate") || citedIssueEffect("terminate") || observation?.findings.some((finding) => finding.severity === "critical") || observation?.recommendation === "terminate")) {
        semanticInvalid = true; issue("admin_termination_without_critical_evidence", "Termination lacks critical evidence.", "error");
      }
      if (decision === "admin_human_escalation_required" && (deduped.length === 0 || !deduped.some(hasAnyEvidence))) {
        semanticInvalid = true; issue("admin_escalation_without_evidence", "Escalation lacks evidence.", "error");
      }
      const repairTokens = new Set(["governance_execution_failed", "governance_shadow_recommends_repair", "execution_outcome", "high_repair_count", "repair_loop"]);
      const repairEvidence = citedRuleEffect("repair") || deduped.some((finding) => [...finding.governanceRuleIds, ...finding.governanceReasonCodes, ...finding.traceFindingCodes, ...finding.shadowFindingCodes].some((value) => repairTokens.has(value)));
      if (decision === "admin_repair_required" && (deduped.length === 0 || !repairEvidence)) { semanticInvalid = true; issue("admin_repair_without_repair_evidence", "Repair lacks repair-related evidence.", "error"); }
      const replanTokens = new Set([
        "planned_scope_consistency", "proposed_scope_without_plan", "scope_expansion_limit", "planned_file_limit", "proposed_file_limit",
        "governance_unplanned_files_proposed", "governance_files_proposed_without_plan", "governance_scope_expansion_limit_exceeded",
        "governance_shadow_recommends_replan", "proposed_files_without_plan", "unplanned_files_proposed", "plan_patch_mismatch", "scope_drift"
      ]);
      const replanEvidence = citedRuleEffect("replan") || deduped.some((finding) => [...finding.governanceRuleIds, ...finding.governanceReasonCodes, ...finding.traceFindingCodes, ...finding.shadowFindingCodes].some((value) => replanTokens.has(value)));
      if (decision === "admin_replan_required" && (deduped.length === 0 || !replanEvidence)) { semanticInvalid = true; issue("admin_replan_without_replan_evidence", "Replan lacks planning evidence.", "error"); }
    }

    if (issues.some((entry) => entry.severity === "error")) return finish(null);
    const material = {
      decisionVersion: ADMIN_DECISION_VERSION, runId: trace.runId, traceHash: trace.traceHash,
      observationHash: expectedObservationHash, governanceHash: governance.governanceHash,
      governanceDecision: governance.decision, decision: raw.decision as AdminDecision,
      riskLevel: raw.riskLevel as AdminRiskLevel, riskScore: raw.riskScore as number,
      confidenceScore: raw.confidenceScore as number, findings: deduped, rationaleCodes
    };
    let adminDecisionHash: string;
    try { adminDecisionHash = hashCanonicalJson(material); }
    catch { issue("admin_decision_hash_failure", "The Admin decision hash could not be computed.", "error"); return finish(null); }
    return finish({ ...material, adminDecisionHash });
  } catch {
    issue("admin_validation_exception", "Bounded Admin validation could not complete safely.", "review");
    return finish(null);
  }
}
