import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  type DeterministicGovernanceAssessment,
  type DeterministicGovernanceDecision
} from "./deterministic-governance-policy.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";
import {
  validateShadowObservation,
  type ShadowObservation,
  type ShadowObservationValidationDecision
} from "./shadow-observer-contract.js";

/**
 * W.17 makes Admin invocation a pure deterministic evidence decision. This
 * module performs no I/O, model call, workflow action, or repository mutation.
 * A verified skip is not an Admin approval and cannot weaken governance.
 */

export const ADMIN_INVOCATION_POLICY_VERSION = "1" as const;

export type AdminInvocationMode = "disabled" | "conditional" | "always";
export type AdminInvocationDecision =
  | "admin_invocation_required"
  | "admin_invocation_skipped";
export type AdminInvocationSkipKind =
  | "clean_path"
  | "disabled"
  | "deterministic_hard_stop"
  | "insufficient_semantic_evidence"
  | null;

export type AdminInvocationPolicy = {
  policyVersion: "1";
  mode: AdminInvocationMode;
  invokeForGovernanceRepairRequired: true;
  invokeForGovernanceReplanRequired: true;
  invokeForGovernanceEscalationWhenObservationAvailable: true;
  invokeForShadowNeedsReviewWhenObservationAvailable: true;
  invokeForShadowMediumOrHigherRisk: true;
  invokeForShadowRepairOrStrongerRecommendation: true;
  skipForGovernanceTerminated: true;
  cleanPathMaximumShadowRiskScore: 24;
  cleanPathMinimumShadowConfidenceScore: 70;
};

export type AdminInvocationShadowEvidence = {
  stageDecision:
    | "shadow_observer_completed"
    | "shadow_observer_needs_review"
    | "shadow_observer_failed"
    | "shadow_not_called";
  validationDecision: ShadowObservationValidationDecision | null;
  observation: ShadowObservation | null;
};

export type AdminInvocationPolicyInput = {
  phaseVFinalDecision:
    | "temp_validation_passed"
    | "temp_validation_failed"
    | "temp_validation_needs_review";
  trace: RunAccountabilityTrace;
  shadow: AdminInvocationShadowEvidence;
  governance: DeterministicGovernanceAssessment;
};

export type AdminInvocationAssessment = {
  invocationVersion: "1";
  runId: string;
  phaseVFinalDecision: AdminInvocationPolicyInput["phaseVFinalDecision"];
  traceHash: string;
  observationHash: string | null;
  governanceHash: string;
  shadowStageDecision: AdminInvocationShadowEvidence["stageDecision"];
  shadowValidationDecision: ShadowObservationValidationDecision | null;
  governanceDecision: DeterministicGovernanceDecision;
  policy: Readonly<AdminInvocationPolicy>;
  policyHash: string;
  decision: AdminInvocationDecision;
  skipKind: AdminInvocationSkipKind;
  autoContinueWithoutAdminEligible: boolean;
  reasonCodes: readonly string[];
  triggerCodes: readonly string[];
  assessmentHash: string;
};

export type AdminInvocationPolicyValidationDecision =
  | "admin_invocation_policy_valid"
  | "admin_invocation_policy_invalid"
  | "admin_invocation_policy_needs_review";

export type AdminInvocationPolicyIssue = {
  code: string;
  message: string;
  severity: "review" | "error";
};

export type AdminInvocationPolicyResult = {
  decision: AdminInvocationPolicyValidationDecision;
  assessment: AdminInvocationAssessment | null;
  issues: readonly AdminInvocationPolicyIssue[];
  summary: {
    traceIntegrityVerified: boolean;
    phaseVBoundToTrace: boolean;
    shadowStageConsistent: boolean;
    observationIntegrityVerified: boolean;
    observationBoundToTrace: boolean;
    governanceIntegrityVerified: boolean;
    governanceBoundToTrace: boolean;
    governanceBoundToObservation: boolean;
    cleanPath: boolean;
    invocationRequired: boolean;
    invocationSkipped: boolean;
    autoContinueWithoutAdminEligible: boolean;
    policyHashValid: boolean;
    assessmentHashValid: boolean;
  };
};

type PlainRecord = Record<string, unknown>;
type Summary = AdminInvocationPolicyResult["summary"];

const POLICY_FIELDS = [
  "policyVersion", "mode", "invokeForGovernanceRepairRequired",
  "invokeForGovernanceReplanRequired",
  "invokeForGovernanceEscalationWhenObservationAvailable",
  "invokeForShadowNeedsReviewWhenObservationAvailable",
  "invokeForShadowMediumOrHigherRisk",
  "invokeForShadowRepairOrStrongerRecommendation",
  "skipForGovernanceTerminated", "cleanPathMaximumShadowRiskScore",
  "cleanPathMinimumShadowConfidenceScore"
] as const;
const INPUT_FIELDS = ["phaseVFinalDecision", "trace", "shadow", "governance"] as const;
const SHADOW_FIELDS = ["stageDecision", "validationDecision", "observation"] as const;
const PHASE_DECISIONS = new Set([
  "temp_validation_passed", "temp_validation_failed", "temp_validation_needs_review"
]);
const SHADOW_STAGES = new Set([
  "shadow_observer_completed", "shadow_observer_needs_review",
  "shadow_observer_failed", "shadow_not_called"
]);
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_NODES = 200_000;

const DEFAULT_POLICY_VALUE: AdminInvocationPolicy = {
  policyVersion: ADMIN_INVOCATION_POLICY_VERSION,
  mode: "conditional",
  invokeForGovernanceRepairRequired: true,
  invokeForGovernanceReplanRequired: true,
  invokeForGovernanceEscalationWhenObservationAvailable: true,
  invokeForShadowNeedsReviewWhenObservationAvailable: true,
  invokeForShadowMediumOrHigherRisk: true,
  invokeForShadowRepairOrStrongerRecommendation: true,
  skipForGovernanceTerminated: true,
  cleanPathMaximumShadowRiskScore: 24,
  cleanPathMinimumShadowConfidenceScore: 70
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_ADMIN_INVOCATION_POLICY: Readonly<AdminInvocationPolicy> =
  deepFreeze({ ...DEFAULT_POLICY_VALUE });

class EvidenceError extends Error {
  constructor(readonly code: string, message: string, readonly review = false) {
    super(message);
  }
}

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  nodes = { count: 0 }
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") {
    throw new EvidenceError("invalid_admin_invocation_policy_input", "Unsupported input value.");
  }
  nodes.count += 1;
  if (nodes.count > MAX_NODES) {
    throw new EvidenceError(
      "admin_invocation_policy_input_bound_exceeded", "Input exceeds the structure bound.", true
    );
  }
  if (ancestors.has(value)) {
    throw new EvidenceError("invalid_admin_invocation_policy_object", "Cyclic input is invalid.");
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new EvidenceError("invalid_admin_invocation_policy_object", "Exotic objects are invalid.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new EvidenceError("admin_invocation_policy_symbol_property", "Symbols are invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  try {
    if (array) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw new EvidenceError(
            "admin_invocation_policy_accessor_property", "Sparse or accessor arrays are invalid."
          );
        }
        output.push(safeClone(descriptor.value, ancestors, nodes));
      }
      const allowed = new Set(["length", ...output.map((_, index) => String(index))]);
      if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
        throw new EvidenceError("unknown_admin_invocation_policy_field", "Unknown array field.");
      }
      return output;
    }
    const output: PlainRecord = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        throw new EvidenceError(
          "admin_invocation_policy_accessor_property", "Accessor properties are invalid."
        );
      }
      output[key] = safeClone(descriptor.value, ancestors, nodes);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function exactObject(value: unknown, fields: readonly string[], label: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceError("invalid_admin_invocation_policy_object", `${label} must be an object.`);
  }
  const record = value as PlainRecord;
  const keys = Object.keys(record);
  if (keys.some((key) => !fields.includes(key))) {
    throw new EvidenceError("unknown_admin_invocation_policy_field", `${label} has an unknown field.`);
  }
  if (fields.some((field) => !Object.hasOwn(record, field))) {
    throw new EvidenceError("missing_admin_invocation_policy_field", `${label} is incomplete.`);
  }
  return record;
}

function normalizePolicy(policy?: AdminInvocationPolicy): Readonly<AdminInvocationPolicy> {
  if (policy === undefined) return DEFAULT_ADMIN_INVOCATION_POLICY;
  let record: PlainRecord;
  try {
    record = exactObject(safeClone(policy), POLICY_FIELDS, "Admin invocation policy");
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "Invalid Admin invocation policy.");
  }
  if (record.policyVersion !== "1") throw new TypeError("Unsupported Admin invocation policy version.");
  if (record.mode !== "disabled" && record.mode !== "conditional" && record.mode !== "always") {
    throw new TypeError("Admin invocation mode is invalid.");
  }
  for (const field of POLICY_FIELDS.slice(2, 9)) {
    if (record[field] !== true) throw new TypeError(`${field} must remain true in policy version 1.`);
  }
  if (record.cleanPathMaximumShadowRiskScore !== 24 ||
      record.cleanPathMinimumShadowConfidenceScore !== 70) {
    throw new TypeError("Admin invocation clean-path thresholds are fixed in policy version 1.");
  }
  return deepFreeze({
    policyVersion: "1",
    mode: record.mode,
    invokeForGovernanceRepairRequired: true,
    invokeForGovernanceReplanRequired: true,
    invokeForGovernanceEscalationWhenObservationAvailable: true,
    invokeForShadowNeedsReviewWhenObservationAvailable: true,
    invokeForShadowMediumOrHigherRisk: true,
    invokeForShadowRepairOrStrongerRecommendation: true,
    skipForGovernanceTerminated: true,
    cleanPathMaximumShadowRiskScore: 24,
    cleanPathMinimumShadowConfidenceScore: 70
  });
}

function traceHashMaterial(trace: RunAccountabilityTrace): Omit<RunAccountabilityTrace, "traceHash"> {
  const { traceHash: _traceHash, ...material } = trace;
  return material;
}

function governanceHashMaterial(
  governance: DeterministicGovernanceAssessment
): Omit<DeterministicGovernanceAssessment, "governanceHash"> {
  const { governanceHash: _governanceHash, ...material } = governance;
  return material;
}

function initialSummary(): Summary {
  return {
    traceIntegrityVerified: false,
    phaseVBoundToTrace: false,
    shadowStageConsistent: false,
    observationIntegrityVerified: false,
    observationBoundToTrace: false,
    governanceIntegrityVerified: false,
    governanceBoundToTrace: false,
    governanceBoundToObservation: false,
    cleanPath: false,
    invocationRequired: false,
    invocationSkipped: false,
    autoContinueWithoutAdminEligible: false,
    policyHashValid: false,
    assessmentHashValid: false
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function cleanPath(
  phase: AdminInvocationPolicyInput["phaseVFinalDecision"],
  shadow: AdminInvocationShadowEvidence,
  governance: DeterministicGovernanceAssessment
): boolean {
  const observation = shadow.observation;
  return phase === "temp_validation_passed" &&
    shadow.stageDecision === "shadow_observer_completed" &&
    shadow.validationDecision === "shadow_observation_valid" &&
    observation !== null &&
    observation.riskLevel === "low" &&
    observation.riskScore <= 24 &&
    observation.confidenceScore >= 70 &&
    observation.recommendation === "continue" &&
    observation.findings.every((finding) => finding.severity === "info") &&
    !observation.observedScopeDrift &&
    !observation.observedPlanPatchMismatch &&
    !observation.observedRepairLoop &&
    !observation.observedSuspiciousRoleBehavior &&
    !observation.observedEvidenceConflict &&
    governance.decision === "governance_passed" &&
    governance.riskClass === "low" &&
    governance.triggeredRuleIds.length === 0 &&
    governance.issues.length === 0;
}

function decisionFor(
  mode: AdminInvocationMode,
  isClean: boolean,
  shadow: AdminInvocationShadowEvidence,
  governance: DeterministicGovernanceAssessment
): {
  decision: AdminInvocationDecision;
  skipKind: AdminInvocationSkipKind;
  eligible: boolean;
  reasons: string[];
  triggers: string[];
} {
  if (governance.decision === "governance_terminated") {
    return {
      decision: "admin_invocation_skipped",
      skipKind: "deterministic_hard_stop",
      eligible: false,
      reasons: ["admin_invocation_deterministic_hard_stop"],
      triggers: []
    };
  }
  if (mode === "disabled") {
    return {
      decision: "admin_invocation_skipped",
      skipKind: "disabled",
      eligible: isClean,
      reasons: [
        "admin_invocation_disabled",
        ...(isClean ? ["admin_invocation_auto_continue_without_admin_eligible"] : [])
      ],
      triggers: []
    };
  }
  if (mode === "always") {
    return {
      decision: "admin_invocation_required",
      skipKind: null,
      eligible: false,
      reasons: ["admin_invocation_always_mode"],
      triggers: ["admin_invocation_always_mode"]
    };
  }
  if (isClean) {
    return {
      decision: "admin_invocation_skipped",
      skipKind: "clean_path",
      eligible: true,
      reasons: [
        "admin_invocation_auto_continue_without_admin_eligible",
        "admin_invocation_clean_path"
      ],
      triggers: []
    };
  }
  const observation = shadow.observation;
  const triggers: string[] = [];
  if (governance.decision === "governance_repair_required") {
    triggers.push("admin_invocation_governance_repair");
  }
  if (governance.decision === "governance_replan_required") {
    triggers.push("admin_invocation_governance_replan");
  }
  if (governance.decision === "governance_escalation_required") {
    if (observation !== null) triggers.push("admin_invocation_governance_escalation");
    else return {
      decision: "admin_invocation_skipped",
      skipKind: "insufficient_semantic_evidence",
      eligible: false,
      reasons: ["admin_invocation_insufficient_semantic_evidence"],
      triggers: []
    };
  }
  if (observation !== null) {
    if (shadow.stageDecision === "shadow_observer_needs_review") {
      triggers.push("admin_invocation_shadow_needs_review");
    }
    if (observation.riskLevel !== "low" || observation.riskScore > 24) {
      triggers.push("admin_invocation_shadow_risk_elevated");
    }
    const recommendationTrigger: string | undefined = observation.recommendation === "continue"
      ? undefined
      : ({
      request_repair: "admin_invocation_shadow_repair_recommendation",
      request_replan: "admin_invocation_shadow_replan_recommendation",
      escalate: "admin_invocation_shadow_escalation_recommendation",
      terminate: "admin_invocation_shadow_termination_recommendation"
    } as const)[observation.recommendation];
    if (recommendationTrigger) triggers.push(recommendationTrigger);
    if (observation.observedScopeDrift || observation.observedPlanPatchMismatch ||
        observation.observedRepairLoop || observation.observedSuspiciousRoleBehavior ||
        observation.observedEvidenceConflict) {
      triggers.push("admin_invocation_shadow_behavior_flag");
    }
    if (observation.findings.some((finding) => finding.severity !== "info")) {
      triggers.push("admin_invocation_shadow_finding_elevated");
    }
  }
  const normalized = sortedUnique(triggers);
  if (normalized.length > 0) {
    return {
      decision: "admin_invocation_required",
      skipKind: null,
      eligible: false,
      reasons: normalized,
      triggers: normalized
    };
  }
  return {
    decision: "admin_invocation_skipped",
    skipKind: "insufficient_semantic_evidence",
    eligible: false,
    reasons: ["admin_invocation_insufficient_semantic_evidence"],
    triggers: []
  };
}

export function evaluateAdminInvocationPolicy(
  input: AdminInvocationPolicyInput,
  policy?: AdminInvocationPolicy
): AdminInvocationPolicyResult {
  const normalizedPolicy = normalizePolicy(policy);
  const summary = initialSummary();
  const issues: AdminInvocationPolicyIssue[] = [];
  const finish = (
    decision: AdminInvocationPolicyValidationDecision,
    assessment: AdminInvocationAssessment | null
  ): AdminInvocationPolicyResult => deepFreeze({ decision, assessment, issues, summary });
  try {
    const record = exactObject(safeClone(input), INPUT_FIELDS, "Admin invocation input");
    if (typeof record.phaseVFinalDecision !== "string" ||
        !PHASE_DECISIONS.has(record.phaseVFinalDecision)) {
      throw new EvidenceError(
        "admin_invocation_phase_v_invalid", "Phase V final decision is invalid."
      );
    }
    const phase = record.phaseVFinalDecision as AdminInvocationPolicyInput["phaseVFinalDecision"];
    const traceRecord = exactObject(record.trace, [
      "traceVersion", "runId", "objectiveHash", "ledgerRootHash", "ledgerEventCount",
      "externallyAnchored", "externalAnchorsMatched", "rolesCalled", "roleActivity",
      "events", "files", "decisions", "repairActivity", "resources", "findings",
      "phaseVExecutionObserved", "phaseVExecutionCompleted", "traceHash"
    ], "Admin invocation trace");
    const trace = traceRecord as unknown as RunAccountabilityTrace;
    try {
      summary.traceIntegrityVerified =
        trace.traceVersion === "1" &&
        typeof trace.runId === "string" && trace.runId.length > 0 &&
        typeof trace.traceHash === "string" && HASH.test(trace.traceHash) &&
        hashCanonicalJson(traceHashMaterial(trace)) === trace.traceHash;
    } catch {
      summary.traceIntegrityVerified = false;
    }
    if (!summary.traceIntegrityVerified) {
      throw new EvidenceError(
        "admin_invocation_trace_integrity_mismatch", "Pre-Shadow trace integrity failed."
      );
    }
    summary.phaseVBoundToTrace = trace.phaseVExecutionObserved === true &&
      trace.phaseVExecutionCompleted === true && trace.decisions.finalExecutionDecision === phase;
    if (!summary.phaseVBoundToTrace) {
      throw new EvidenceError(
        "admin_invocation_phase_v_trace_mismatch", "Phase V is not bound to the trace."
      );
    }

    const shadowRecord = exactObject(record.shadow, SHADOW_FIELDS, "Admin invocation Shadow evidence");
    if (typeof shadowRecord.stageDecision !== "string" ||
        !SHADOW_STAGES.has(shadowRecord.stageDecision)) {
      throw new EvidenceError(
        "admin_invocation_shadow_stage_invalid", "Shadow stage decision is invalid."
      );
    }
    const stage = shadowRecord.stageDecision as AdminInvocationShadowEvidence["stageDecision"];
    const suppliedValidation = shadowRecord.validationDecision as
      ShadowObservationValidationDecision | null;
    const suppliedObservation = shadowRecord.observation as ShadowObservation | null;
    let observation: ShadowObservation | null = null;
    if (suppliedObservation !== null) {
      const { observationHash: suppliedObservationHash, ...observationDraft } =
        suppliedObservation;
      const validated = validateShadowObservation(trace, observationDraft);
      summary.observationIntegrityVerified = validated.summary.observationHashValid;
      summary.observationBoundToTrace = validated.summary.runIdMatched &&
        validated.summary.traceHashMatched;
      if (validated.observation === null ||
          validated.observation.observationHash !== suppliedObservationHash ||
          !canonicalEqual(validated.observation, suppliedObservation)) {
        throw new EvidenceError(
          "admin_invocation_shadow_integrity_mismatch", "Shadow observation failed validation."
        );
      }
      observation = validated.observation;
    } else {
      summary.observationIntegrityVerified = false;
      summary.observationBoundToTrace = false;
    }
    summary.shadowStageConsistent =
      (stage === "shadow_observer_completed" &&
        suppliedValidation === "shadow_observation_valid" && observation !== null) ||
      (stage === "shadow_observer_needs_review" &&
        (suppliedValidation === "shadow_observation_needs_review" ||
          (suppliedValidation === null && observation === null))) ||
      (stage === "shadow_observer_failed" &&
        (suppliedValidation === null ||
          suppliedValidation === "shadow_observation_invalid") && observation === null) ||
      (stage === "shadow_not_called" && suppliedValidation === null && observation === null);
    if (!summary.shadowStageConsistent) {
      throw new EvidenceError(
        "admin_invocation_shadow_stage_inconsistent", "Shadow stage evidence is inconsistent."
      );
    }

    const governanceRecord = exactObject(record.governance, [
      "governanceVersion", "runId", "traceHash", "observationHash", "policy",
      "policyHash", "decision", "triggeredRuleIds", "reasonCodes", "issues",
      "ruleResults", "riskClass", "governanceHash"
    ], "Admin invocation governance assessment");
    const governance = governanceRecord as unknown as DeterministicGovernanceAssessment;
    try {
      summary.governanceIntegrityVerified =
        governance.governanceVersion === "1" &&
        typeof governance.policyHash === "string" && HASH.test(governance.policyHash) &&
        typeof governance.governanceHash === "string" && HASH.test(governance.governanceHash) &&
        hashCanonicalJson(governance.policy) === governance.policyHash &&
        hashCanonicalJson(governanceHashMaterial(governance)) === governance.governanceHash;
    } catch {
      summary.governanceIntegrityVerified = false;
    }
    summary.governanceBoundToTrace = governance.runId === trace.runId &&
      governance.traceHash === trace.traceHash;
    summary.governanceBoundToObservation = governance.observationHash ===
      (observation?.observationHash ?? null);
    if (!summary.governanceIntegrityVerified || !summary.governanceBoundToTrace ||
        !summary.governanceBoundToObservation) {
      throw new EvidenceError(
        "admin_invocation_governance_integrity_mismatch",
        "Governance evidence failed integrity or binding verification."
      );
    }
    const governanceShapeValid = new Set([
      "governance_passed", "governance_repair_required", "governance_replan_required",
      "governance_escalation_required", "governance_terminated"
    ]).has(governance.decision) &&
      new Set(["low", "medium", "high", "critical"]).has(governance.riskClass) &&
      Array.isArray(governance.triggeredRuleIds) && Array.isArray(governance.reasonCodes) &&
      Array.isArray(governance.issues) && Array.isArray(governance.ruleResults);
    if (!governanceShapeValid) {
      throw new EvidenceError(
        "admin_invocation_governance_integrity_mismatch",
        "Governance assessment has an invalid bounded shape."
      );
    }

    const shadow: AdminInvocationShadowEvidence = {
      stageDecision: stage,
      validationDecision: suppliedValidation,
      observation
    };
    summary.cleanPath = cleanPath(phase, shadow, governance);
    const outcome = decisionFor(normalizedPolicy.mode, summary.cleanPath, shadow, governance);
    summary.invocationRequired = outcome.decision === "admin_invocation_required";
    summary.invocationSkipped = outcome.decision === "admin_invocation_skipped";
    summary.autoContinueWithoutAdminEligible = outcome.eligible;
    const policyHash = hashCanonicalJson(normalizedPolicy);
    summary.policyHashValid = HASH.test(policyHash);
    const withoutHash = {
      invocationVersion: "1" as const,
      runId: trace.runId,
      phaseVFinalDecision: phase,
      traceHash: trace.traceHash,
      observationHash: observation?.observationHash ?? null,
      governanceHash: governance.governanceHash,
      shadowStageDecision: stage,
      shadowValidationDecision: suppliedValidation,
      governanceDecision: governance.decision,
      policy: normalizedPolicy,
      policyHash,
      decision: outcome.decision,
      skipKind: outcome.skipKind,
      autoContinueWithoutAdminEligible: outcome.eligible,
      reasonCodes: sortedUnique(outcome.reasons),
      triggerCodes: sortedUnique(outcome.triggers)
    };
    const assessmentHash = hashCanonicalJson(withoutHash);
    summary.assessmentHashValid = HASH.test(assessmentHash);
    return finish("admin_invocation_policy_valid", {
      ...withoutHash,
      assessmentHash
    });
  } catch (error) {
    const failure = error instanceof EvidenceError ? error : new EvidenceError(
      "admin_invocation_policy_exception",
      "Admin invocation policy evaluation failed without exposing unbounded details."
    );
    issues.push({
      code: failure.code,
      message: failure.message,
      severity: failure.review ? "review" : "error"
    });
    return finish(
      failure.review
        ? "admin_invocation_policy_needs_review"
        : "admin_invocation_policy_invalid",
      null
    );
  }
}
