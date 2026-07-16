import {
  canonicalizeJson,
  hashCanonicalJson,
  type AgentRole
} from "./agent-event-ledger.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";

/**
 * Shadow Observer output is advisory model output. Validation proves structure,
 * trace binding, and evidence-reference consistency, not objective semantic
 * correctness. Deterministic governor rules remain authoritative, and an Admin
 * Agent may not use a validated observation to override deterministic rejection.
 * The observation hash binds the normalized advisory assessment to one trace.
 */

export const SHADOW_OBSERVATION_VERSION = "1" as const;

export type ShadowRiskLevel = "low" | "medium" | "high" | "critical";
export type ShadowRecommendation =
  | "continue"
  | "request_repair"
  | "request_replan"
  | "escalate"
  | "terminate";
export type ShadowFindingSeverity = "info" | "warning" | "high" | "critical";

export type ShadowFindingDraft = {
  code: string;
  severity: ShadowFindingSeverity;
  actor?: AgentRole;
  message: string;
  evidenceEventIds: string[];
  evidenceFilePaths: string[];
  evidenceTraceFindingCodes: string[];
};

export type ShadowFinding = {
  code: string;
  severity: ShadowFindingSeverity;
  actor?: AgentRole;
  message: string;
  evidenceEventIds: readonly string[];
  evidenceFilePaths: readonly string[];
  evidenceTraceFindingCodes: readonly string[];
};

export type ShadowObservationDraft = {
  observationVersion: "1";
  runId: string;
  traceHash: string;
  riskLevel: ShadowRiskLevel;
  riskScore: number;
  confidenceScore: number;
  findings: ShadowFindingDraft[];
  observedScopeDrift: boolean;
  observedPlanPatchMismatch: boolean;
  observedRepairLoop: boolean;
  observedSuspiciousRoleBehavior: boolean;
  observedEvidenceConflict: boolean;
  recommendation: ShadowRecommendation;
  rationaleCodes: string[];
};

export type ShadowObservation = {
  observationVersion: "1";
  runId: string;
  traceHash: string;
  riskLevel: ShadowRiskLevel;
  riskScore: number;
  confidenceScore: number;
  findings: readonly ShadowFinding[];
  observedScopeDrift: boolean;
  observedPlanPatchMismatch: boolean;
  observedRepairLoop: boolean;
  observedSuspiciousRoleBehavior: boolean;
  observedEvidenceConflict: boolean;
  recommendation: ShadowRecommendation;
  rationaleCodes: readonly string[];
  observationHash: string;
};

export type ShadowObservationValidationDecision =
  | "shadow_observation_valid"
  | "shadow_observation_invalid"
  | "shadow_observation_needs_review";

export type ShadowObservationValidationIssueSeverity = "review" | "error";

export type ShadowObservationValidationIssue = {
  code: string;
  message: string;
  severity: ShadowObservationValidationIssueSeverity;
  field?: string;
  findingIndex?: number;
  evidenceValue?: string;
};

export type ShadowObservationValidationResult = {
  decision: ShadowObservationValidationDecision;
  issues: readonly ShadowObservationValidationIssue[];
  observation: ShadowObservation | null;
  summary: {
    traceIntegrityVerified: boolean;
    structureValid: boolean;
    versionSupported: boolean;
    runIdMatched: boolean;
    traceHashMatched: boolean;
    evidenceReferencesValid: boolean;
    semanticConsistencyValid: boolean;
    riskLevelValid: boolean;
    riskScoreValid: boolean;
    confidenceScoreValid: boolean;
    recommendationValid: boolean;
    findingCount: number;
    infoFindingCount: number;
    warningFindingCount: number;
    highFindingCount: number;
    criticalFindingCount: number;
    citedEventCount: number;
    citedFileCount: number;
    citedTraceFindingCount: number;
    observationBuilt: boolean;
    observationHashValid: boolean;
  };
};

type MutableSummary = ShadowObservationValidationResult["summary"];
type IssueContext = Pick<
  ShadowObservationValidationIssue,
  "field" | "findingIndex" | "evidenceValue"
>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const AGENT_ROLES = new Set<AgentRole>([
  "planner",
  "coder",
  "deterministic_verifier",
  "masker",
  "repairer",
  "repair_verifier",
  "patch_dry_run",
  "temp_workspace_apply",
  "execution_verifier",
  "shadow_observer",
  "deterministic_governor",
  "admin_invocation_policy",
  "admin_agent",
  "approval_router"
]);
const RISK_LEVELS = new Set<ShadowRiskLevel>(["low", "medium", "high", "critical"]);
const FINDING_SEVERITIES = new Set<ShadowFindingSeverity>([
  "info",
  "warning",
  "high",
  "critical"
]);
const RECOMMENDATIONS = new Set<ShadowRecommendation>([
  "continue",
  "request_repair",
  "request_replan",
  "escalate",
  "terminate"
]);
const FINDING_SEVERITY_RANK: Record<ShadowFindingSeverity, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3
};
const TOP_LEVEL_FIELDS = [
  "observationVersion",
  "runId",
  "traceHash",
  "riskLevel",
  "riskScore",
  "confidenceScore",
  "findings",
  "observedScopeDrift",
  "observedPlanPatchMismatch",
  "observedRepairLoop",
  "observedSuspiciousRoleBehavior",
  "observedEvidenceConflict",
  "recommendation",
  "rationaleCodes"
] as const;
const REQUIRED_FINDING_FIELDS = [
  "code",
  "severity",
  "message",
  "evidenceEventIds",
  "evidenceFilePaths",
  "evidenceTraceFindingCodes"
] as const;
const FINDING_FIELDS = [...REQUIRED_FINDING_FIELDS, "actor"] as const;
const FLAG_FINDING_PAIRS = [
  ["observedScopeDrift", "scope_drift"],
  ["observedPlanPatchMismatch", "plan_patch_mismatch"],
  ["observedRepairLoop", "repair_loop"],
  ["observedSuspiciousRoleBehavior", "suspicious_role_behavior"],
  ["observedEvidenceConflict", "evidence_conflict"]
] as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function initialSummary(): MutableSummary {
  return {
    traceIntegrityVerified: false,
    structureValid: false,
    versionSupported: false,
    runIdMatched: false,
    traceHashMatched: false,
    evidenceReferencesValid: false,
    semanticConsistencyValid: false,
    riskLevelValid: false,
    riskScoreValid: false,
    confidenceScoreValid: false,
    recommendationValid: false,
    findingCount: 0,
    infoFindingCount: 0,
    warningFindingCount: 0,
    highFindingCount: 0,
    criticalFindingCount: 0,
    citedEventCount: 0,
    citedFileCount: 0,
    citedTraceFindingCount: 0,
    observationBuilt: false,
    observationHashValid: false
  };
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

function inspectExactObject(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  issue: (
    code: string,
    message: string,
    severity: ShadowObservationValidationIssueSeverity,
    context?: IssueContext,
    structural?: boolean
  ) => void,
  codes: {
    invalidInput: string;
    invalidObject: string;
    unknownField: string;
    missingField: string;
    accessor: string;
    symbol: string;
  },
  context: IssueContext = {}
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issue(codes.invalidInput, "The value is not an object.", "error", context, true);
    return null;
  }
  if (Array.isArray(value)) {
    issue(codes.invalidObject, "An array cannot be used as this object.", "error", context, true);
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    issue(codes.invalidObject, "Only a plain object is accepted.", "error", context, true);
    return null;
  }

  const allowed = new Set(allowedFields);
  const present = new Set<string>();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      issue(codes.symbol, "Symbol-keyed properties are not accepted.", "error", context, true);
      continue;
    }
    present.add(key);
    const fieldContext =
      key.length <= 128 && !ASCII_CONTROL_PATTERN.test(key)
        ? { ...context, field: key }
        : context;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      issue(codes.accessor, "Accessor properties are not accepted.", "error", fieldContext, true);
      continue;
    }
    if (!allowed.has(key)) {
      issue(codes.unknownField, "The object contains an unknown field.", "error", fieldContext, true);
      continue;
    }
    output[key] = descriptor.value;
  }
  for (const field of requiredFields) {
    if (!present.has(field)) {
      issue(codes.missingField, "The object is missing a required field.", "error", {
        ...context,
        field
      }, true);
    }
  }
  return output;
}

function arrayLength(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) return null;
  return descriptor.value as number;
}

function readDenseArray(
  value: unknown,
  maximum: number,
  onInvalid: () => void
): unknown[] | null {
  const length = arrayLength(value);
  if (length === null || length > maximum) {
    onInvalid();
    return null;
  }
  const output: unknown[] = [];
  for (const key of Reflect.ownKeys(value as object)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      onInvalid();
      return null;
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      onInvalid();
      return null;
    }
    output.push(descriptor.value);
  }
  return output;
}

function validIdentifier(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function normalizeStringEvidence(
  value: unknown,
  maximum: number,
  maximumStringLength: number,
  issueCode: string,
  field: string,
  findingIndex: number,
  issue: (
    code: string,
    message: string,
    severity: ShadowObservationValidationIssueSeverity,
    context?: IssueContext,
    structural?: boolean
  ) => void
): string[] | null {
  const values = readDenseArray(value, maximum, () => {
    issue(issueCode, "The evidence field must be a bounded dense string array.", "error", {
      field,
      findingIndex
    }, true);
  });
  if (values === null) return null;
  for (const item of values) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > maximumStringLength ||
      ASCII_CONTROL_PATTERN.test(item)
    ) {
      issue(issueCode, "The evidence field contains an invalid string.", "error", {
        field,
        findingIndex
      }, true);
      return null;
    }
  }
  return [...new Set(values as string[])].sort();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortFindings(findings: ShadowFinding[]): ShadowFinding[] {
  return findings.sort((left, right) => {
    const severity = FINDING_SEVERITY_RANK[left.severity] - FINDING_SEVERITY_RANK[right.severity];
    if (severity !== 0) return severity;
    const code = compareStrings(left.code, right.code);
    if (code !== 0) return code;
    const actor = compareStrings(left.actor ?? "", right.actor ?? "");
    if (actor !== 0) return actor;
    const eventIds = compareStrings(JSON.stringify(left.evidenceEventIds), JSON.stringify(right.evidenceEventIds));
    if (eventIds !== 0) return eventIds;
    const files = compareStrings(JSON.stringify(left.evidenceFilePaths), JSON.stringify(right.evidenceFilePaths));
    if (files !== 0) return files;
    const traceCodes = compareStrings(
      JSON.stringify(left.evidenceTraceFindingCodes),
      JSON.stringify(right.evidenceTraceFindingCodes)
    );
    return traceCodes !== 0 ? traceCodes : compareStrings(left.message, right.message);
  });
}

function recommendationAllowed(risk: ShadowRiskLevel, recommendation: ShadowRecommendation): boolean {
  const allowed: Record<ShadowRiskLevel, readonly ShadowRecommendation[]> = {
    low: ["continue", "request_repair", "request_replan", "escalate"],
    medium: ["continue", "request_repair", "request_replan", "escalate"],
    high: ["request_repair", "request_replan", "escalate", "terminate"],
    critical: ["escalate", "terminate"]
  };
  return allowed[risk].includes(recommendation);
}

function scoreMatchesRisk(risk: ShadowRiskLevel, score: number): boolean {
  return (
    (risk === "low" && score <= 24) ||
    (risk === "medium" && score >= 25 && score <= 49) ||
    (risk === "high" && score >= 50 && score <= 74) ||
    (risk === "critical" && score >= 75)
  );
}

export function validateShadowObservation(
  trace: RunAccountabilityTrace,
  input: unknown
): ShadowObservationValidationResult {
  const issues: ShadowObservationValidationIssue[] = [];
  const summary = initialSummary();
  let structuralProblem = false;
  let evidenceProblem = false;
  let semanticProblem = false;

  const issue = (
    code: string,
    message: string,
    severity: ShadowObservationValidationIssueSeverity,
    context: IssueContext = {},
    structural = false
  ): void => {
    issues.push({ code, message, severity, ...context });
    if (structural) structuralProblem = true;
  };

  const finish = (observation: ShadowObservation | null): ShadowObservationValidationResult => {
    const hasError = issues.some((entry) => entry.severity === "error");
    const hasReview = issues.some((entry) => entry.severity === "review");
    const decision: ShadowObservationValidationDecision = hasError
      ? "shadow_observation_invalid"
      : hasReview
        ? "shadow_observation_needs_review"
        : "shadow_observation_valid";
    const safeObservation = decision === "shadow_observation_invalid" ? null : observation;
    summary.observationBuilt = safeObservation !== null;
    summary.observationHashValid =
      safeObservation !== null && HASH_PATTERN.test(safeObservation.observationHash);
    return deepFreeze({ decision, issues, observation: safeObservation, summary }) as ShadowObservationValidationResult;
  };

  try {
    let computedTraceHash: string;
    try {
      computedTraceHash = hashCanonicalJson(traceHashMaterial(trace));
    } catch {
      issue(
        "trace_integrity_mismatch",
        "The supplied accountability trace cannot be verified.",
        "error"
      );
      return finish(null);
    }
    if (computedTraceHash !== trace.traceHash) {
      issue(
        "trace_integrity_mismatch",
        "The supplied accountability trace hash is inconsistent.",
        "error"
      );
      return finish(null);
    }
    summary.traceIntegrityVerified = true;

    const raw = inspectExactObject(
      input,
      TOP_LEVEL_FIELDS,
      TOP_LEVEL_FIELDS,
      issue,
      {
        invalidInput: "invalid_shadow_observation_input",
        invalidObject: "invalid_shadow_observation_object",
        unknownField: "unknown_shadow_observation_field",
        missingField: "missing_shadow_observation_field",
        accessor: "shadow_observation_accessor_property",
        symbol: "shadow_observation_symbol_property"
      }
    );
    if (raw === null) return finish(null);

    if (raw.observationVersion === SHADOW_OBSERVATION_VERSION) {
      summary.versionSupported = true;
    } else if (typeof raw.observationVersion === "string" && raw.observationVersion.length > 0) {
      issue(
        "unsupported_shadow_observation_version",
        "The Shadow observation version is not supported.",
        "review",
        { field: "observationVersion" }
      );
      return finish(null);
    } else {
      issue(
        "unsupported_shadow_observation_version",
        "The Shadow observation version is malformed.",
        "error",
        { field: "observationVersion" },
        true
      );
    }

    summary.runIdMatched = raw.runId === trace.runId;
    if (!summary.runIdMatched) {
      issue("shadow_run_id_mismatch", "The observation runId does not match the trace.", "error", {
        field: "runId"
      });
    }
    summary.traceHashMatched = raw.traceHash === trace.traceHash;
    if (!summary.traceHashMatched) {
      issue(
        "shadow_trace_hash_mismatch",
        "The observation traceHash does not match the trace.",
        "error",
        { field: "traceHash" }
      );
    }

    summary.riskLevelValid = RISK_LEVELS.has(raw.riskLevel as ShadowRiskLevel);
    if (!summary.riskLevelValid) {
      issue("invalid_shadow_risk_level", "The Shadow risk level is invalid.", "error", {
        field: "riskLevel"
      }, true);
    }
    summary.riskScoreValid =
      Number.isSafeInteger(raw.riskScore) &&
      (raw.riskScore as number) >= 0 &&
      (raw.riskScore as number) <= 100;
    if (!summary.riskScoreValid) {
      issue("invalid_shadow_risk_score", "riskScore must be a safe integer from 0 to 100.", "error", {
        field: "riskScore"
      }, true);
    }
    summary.confidenceScoreValid =
      Number.isSafeInteger(raw.confidenceScore) &&
      (raw.confidenceScore as number) >= 0 &&
      (raw.confidenceScore as number) <= 100;
    if (!summary.confidenceScoreValid) {
      issue(
        "invalid_shadow_confidence_score",
        "confidenceScore must be a safe integer from 0 to 100.",
        "error",
        { field: "confidenceScore" },
        true
      );
    }
    summary.recommendationValid = RECOMMENDATIONS.has(raw.recommendation as ShadowRecommendation);
    if (!summary.recommendationValid) {
      issue(
        "invalid_shadow_recommendation",
        "The Shadow recommendation is invalid.",
        "error",
        { field: "recommendation" },
        true
      );
    }

    for (const [field] of FLAG_FINDING_PAIRS) {
      if (typeof raw[field] !== "boolean") {
        issue(
          "invalid_shadow_observation_input",
          "Observation flags must be booleans.",
          "error",
          { field },
          true
        );
      }
    }

    const rawFindingCount = arrayLength(raw.findings);
    if (rawFindingCount === null) {
      issue("findings_not_array", "findings must be a dense array.", "error", {
        field: "findings"
      }, true);
      return finish(null);
    }
    if (rawFindingCount > 32) {
      issue(
        "too_many_shadow_findings",
        "The finding count exceeds the bounded validation limit.",
        "review",
        { field: "findings" }
      );
      return finish(null);
    }
    const rawFindings = readDenseArray(raw.findings, 32, () => {
      issue("sparse_findings_array", "findings must be a dense data-property array.", "error", {
        field: "findings"
      }, true);
    });
    if (rawFindings === null) return finish(null);

    const rawRationaleCount = arrayLength(raw.rationaleCodes);
    if (rawRationaleCount === null) {
      issue(
        "invalid_shadow_rationale_codes",
        "rationaleCodes must be a dense string array.",
        "error",
        { field: "rationaleCodes" },
        true
      );
      return finish(null);
    }
    if (rawRationaleCount > 32) {
      issue(
        "too_many_shadow_rationale_codes",
        "rationaleCodes exceeds its bounded limit.",
        "error",
        { field: "rationaleCodes" },
        true
      );
      return finish(null);
    }
    const rawRationaleCodes = readDenseArray(raw.rationaleCodes, 32, () => {
      issue(
        "invalid_shadow_rationale_codes",
        "rationaleCodes must be a dense string array.",
        "error",
        { field: "rationaleCodes" },
        true
      );
    });
    if (rawRationaleCodes === null) return finish(null);
    let rationaleValid = true;
    for (const rationale of rawRationaleCodes) {
      if (!validIdentifier(rationale)) {
        rationaleValid = false;
        issue(
          "invalid_shadow_rationale_code",
          "A rationale code is invalid.",
          "error",
          { field: "rationaleCodes" },
          true
        );
      }
    }
    const rationaleCodes = rationaleValid
      ? [...new Set(rawRationaleCodes as string[])].sort()
      : [];

    const eventActors = new Map(trace.events.map((event) => [event.eventId, event.actor]));
    const allowedEventIds = new Set(eventActors.keys());
    const allowedFilePaths = new Set<string>([
      ...trace.files.plannedFiles,
      ...trace.files.coderProposedFiles,
      ...trace.files.repairProposedFiles,
      ...trace.files.allProposedFiles,
      ...trace.files.temporaryAppliedFiles,
      ...trace.files.executionReadFiles,
      ...trace.files.unplannedProposedFiles,
      ...trace.files.appliedButUnproposedFiles,
      ...trace.findings.flatMap((finding) => [...finding.filePaths])
    ]);
    const traceFindingSeverity = new Map<string, "info" | "warning" | "error">();
    for (const finding of trace.findings) {
      const previous = traceFindingSeverity.get(finding.code);
      if (
        previous === undefined ||
        (finding.severity === "error") ||
        (finding.severity === "warning" && previous === "info")
      ) {
        traceFindingSeverity.set(finding.code, finding.severity);
      }
    }

    const normalizedFindings: ShadowFinding[] = [];
    for (let findingIndex = 0; findingIndex < rawFindings.length; findingIndex += 1) {
      const findingRaw = inspectExactObject(
        rawFindings[findingIndex],
        FINDING_FIELDS,
        REQUIRED_FINDING_FIELDS,
        issue,
        {
          invalidInput: "invalid_shadow_finding",
          invalidObject: "invalid_shadow_finding",
          unknownField: "unknown_shadow_finding_field",
          missingField: "missing_shadow_finding_field",
          accessor: "shadow_finding_accessor_property",
          symbol: "shadow_finding_symbol_property"
        },
        { findingIndex }
      );
      if (findingRaw === null) continue;

      let findingValid = true;
      if (!validIdentifier(findingRaw.code)) {
        findingValid = false;
        issue("invalid_shadow_finding_code", "The finding code is invalid.", "error", {
          field: "code",
          findingIndex
        }, true);
      }
      if (!FINDING_SEVERITIES.has(findingRaw.severity as ShadowFindingSeverity)) {
        findingValid = false;
        issue("invalid_shadow_finding_severity", "The finding severity is invalid.", "error", {
          field: "severity",
          findingIndex
        }, true);
      }
      if (
        typeof findingRaw.message !== "string" ||
        findingRaw.message.length === 0 ||
        findingRaw.message.length > 500 ||
        findingRaw.message.trim() !== findingRaw.message ||
        ASCII_CONTROL_PATTERN.test(findingRaw.message)
      ) {
        findingValid = false;
        issue("invalid_shadow_finding_message", "The finding message is invalid.", "error", {
          field: "message",
          findingIndex
        }, true);
      }
      if (
        Object.prototype.hasOwnProperty.call(findingRaw, "actor") &&
        !AGENT_ROLES.has(findingRaw.actor as AgentRole)
      ) {
        findingValid = false;
        issue("invalid_shadow_finding_actor", "The finding actor is invalid.", "error", {
          field: "actor",
          findingIndex
        }, true);
      }

      const evidenceEventIds = normalizeStringEvidence(
        findingRaw.evidenceEventIds,
        64,
        256,
        "invalid_evidence_event_ids",
        "evidenceEventIds",
        findingIndex,
        issue
      );
      const evidenceFilePaths = normalizeStringEvidence(
        findingRaw.evidenceFilePaths,
        64,
        512,
        "invalid_evidence_file_paths",
        "evidenceFilePaths",
        findingIndex,
        issue
      );
      const evidenceTraceFindingCodes = normalizeStringEvidence(
        findingRaw.evidenceTraceFindingCodes,
        32,
        128,
        "invalid_evidence_trace_finding_codes",
        "evidenceTraceFindingCodes",
        findingIndex,
        issue
      );
      if (
        evidenceEventIds === null ||
        evidenceFilePaths === null ||
        evidenceTraceFindingCodes === null
      ) {
        findingValid = false;
        continue;
      }
      if (
        evidenceEventIds.length === 0 &&
        evidenceFilePaths.length === 0 &&
        evidenceTraceFindingCodes.length === 0
      ) {
        findingValid = false;
        evidenceProblem = true;
        issue("finding_without_evidence", "A finding must cite trace evidence.", "error", {
          findingIndex
        });
      }
      for (const eventId of evidenceEventIds) {
        if (!allowedEventIds.has(eventId)) {
          findingValid = false;
          evidenceProblem = true;
          issue("unknown_evidence_event_id", "A cited event ID is absent from the trace.", "error", {
            field: "evidenceEventIds",
            findingIndex,
            evidenceValue: eventId
          });
        }
      }
      for (const filePath of evidenceFilePaths) {
        if (!allowedFilePaths.has(filePath)) {
          findingValid = false;
          evidenceProblem = true;
          issue("unknown_evidence_file_path", "A cited file path is absent from the trace.", "error", {
            field: "evidenceFilePaths",
            findingIndex,
            evidenceValue: filePath
          });
        }
      }
      for (const findingCode of evidenceTraceFindingCodes) {
        if (!traceFindingSeverity.has(findingCode)) {
          findingValid = false;
          evidenceProblem = true;
          issue(
            "unknown_trace_finding_code",
            "A cited trace finding code is absent from the trace.",
            "error",
            {
              field: "evidenceTraceFindingCodes",
              findingIndex,
              evidenceValue: findingCode
            }
          );
        }
      }
      if (
        AGENT_ROLES.has(findingRaw.actor as AgentRole) &&
        evidenceEventIds.length > 0 &&
        !evidenceEventIds.some((eventId) => eventActors.get(eventId) === findingRaw.actor)
      ) {
        findingValid = false;
        evidenceProblem = true;
        issue(
          "finding_actor_evidence_mismatch",
          "No cited event supports the finding actor attribution.",
          "error",
          { field: "actor", findingIndex }
        );
      }

      if (findingValid) {
        normalizedFindings.push({
          code: findingRaw.code as string,
          severity: findingRaw.severity as ShadowFindingSeverity,
          ...(AGENT_ROLES.has(findingRaw.actor as AgentRole)
            ? { actor: findingRaw.actor as AgentRole }
            : {}),
          message: findingRaw.message as string,
          evidenceEventIds,
          evidenceFilePaths,
          evidenceTraceFindingCodes
        });
      }
    }

    sortFindings(normalizedFindings);
    const deduplicatedFindings: ShadowFinding[] = [];
    const findingKeys = new Set<string>();
    let duplicateFinding = false;
    for (const finding of normalizedFindings) {
      const key = canonicalizeJson(finding);
      if (findingKeys.has(key)) {
        duplicateFinding = true;
      } else {
        findingKeys.add(key);
        deduplicatedFindings.push(finding);
      }
    }
    if (duplicateFinding) {
      issue(
        "duplicate_shadow_finding",
        "Duplicate normalized Shadow findings were supplied.",
        "review",
        { field: "findings" }
      );
    }

    summary.findingCount = deduplicatedFindings.length;
    for (const finding of deduplicatedFindings) {
      if (finding.severity === "info") summary.infoFindingCount += 1;
      if (finding.severity === "warning") summary.warningFindingCount += 1;
      if (finding.severity === "high") summary.highFindingCount += 1;
      if (finding.severity === "critical") summary.criticalFindingCount += 1;
    }
    summary.citedEventCount = new Set(
      deduplicatedFindings.flatMap((finding) => [...finding.evidenceEventIds])
    ).size;
    summary.citedFileCount = new Set(
      deduplicatedFindings.flatMap((finding) => [...finding.evidenceFilePaths])
    ).size;
    summary.citedTraceFindingCount = new Set(
      deduplicatedFindings.flatMap((finding) => [...finding.evidenceTraceFindingCodes])
    ).size;
    summary.evidenceReferencesValid = !evidenceProblem && normalizedFindings.length === rawFindings.length;

    const risk = raw.riskLevel as ShadowRiskLevel;
    const riskScore = raw.riskScore as number;
    const recommendation = raw.recommendation as ShadowRecommendation;
    if (summary.riskLevelValid && summary.riskScoreValid && !scoreMatchesRisk(risk, riskScore)) {
      semanticProblem = true;
      issue("risk_level_score_mismatch", "riskLevel does not match riskScore.", "error", {
        field: "riskScore"
      });
    }
    if (
      summary.riskLevelValid &&
      summary.recommendationValid &&
      !recommendationAllowed(risk, recommendation)
    ) {
      semanticProblem = true;
      issue(
        "risk_recommendation_mismatch",
        "The recommendation is inconsistent with the risk level.",
        "error",
        { field: "recommendation" }
      );
    }

    const findingCodes = new Set(deduplicatedFindings.map((finding) => finding.code));
    for (const [field, findingCode] of FLAG_FINDING_PAIRS) {
      if (
        typeof raw[field] === "boolean" &&
        ((raw[field] === true) !== findingCodes.has(findingCode))
      ) {
        semanticProblem = true;
        issue(
          "observation_flag_finding_mismatch",
          "An observation flag does not match its dedicated finding code.",
          "error",
          { field }
        );
      }
    }

    const hasCriticalFinding = deduplicatedFindings.some(
      (finding) => finding.severity === "critical"
    );
    const hasHighFinding = deduplicatedFindings.some((finding) => finding.severity === "high");
    const citedTraceError = deduplicatedFindings.some((finding) =>
      finding.evidenceTraceFindingCodes.some(
        (code) => traceFindingSeverity.get(code) === "error"
      )
    );
    const citedTraceWarning = deduplicatedFindings.some((finding) =>
      finding.evidenceTraceFindingCodes.some(
        (code) => traceFindingSeverity.get(code) === "warning"
      )
    );
    if (
      (hasCriticalFinding &&
        (risk !== "critical" || riskScore < 75 || !["escalate", "terminate"].includes(recommendation))) ||
      (!hasCriticalFinding && hasHighFinding && risk !== "high" && risk !== "critical") ||
      (citedTraceError &&
        (!["high", "critical"].includes(risk) || recommendation === "continue")) ||
      (citedTraceWarning && risk === "low")
    ) {
      semanticProblem = true;
      issue(
        "shadow_severity_evidence_mismatch",
        "Shadow severity or trace evidence is inconsistent with overall risk.",
        "error"
      );
    }

    if (
      (recommendation === "terminate" && !hasCriticalFinding && !citedTraceError) ||
      (["escalate", "request_repair", "request_replan"].includes(recommendation) &&
        deduplicatedFindings.length === 0) ||
      (deduplicatedFindings.length === 0 && recommendation !== "continue")
    ) {
      semanticProblem = true;
      issue(
        "recommendation_without_evidence",
        "The recommendation is not supported by Shadow finding evidence.",
        "error",
        { field: "recommendation" }
      );
    }

    const traceHasError = trace.findings.some((finding) => finding.severity === "error");
    const traceHasWarning = trace.findings.some((finding) => finding.severity === "warning");
    if (
      (traceHasError &&
        (!["high", "critical"].includes(risk) || recommendation === "continue")) ||
      (traceHasWarning && risk === "low")
    ) {
      semanticProblem = true;
      issue(
        "shadow_understates_trace_risk",
        "The observation understates deterministic trace risk.",
        "error"
      );
    }

    summary.structureValid = !structuralProblem;
    summary.semanticConsistencyValid = !semanticProblem;
    if (
      issues.some((entry) => entry.severity === "error") ||
      structuralProblem ||
      evidenceProblem ||
      !rationaleValid
    ) {
      return finish(null);
    }

    const observationWithoutHash: Omit<ShadowObservation, "observationHash"> = {
      observationVersion: SHADOW_OBSERVATION_VERSION,
      runId: raw.runId as string,
      traceHash: raw.traceHash as string,
      riskLevel: risk,
      riskScore,
      confidenceScore: raw.confidenceScore as number,
      findings: deduplicatedFindings,
      observedScopeDrift: raw.observedScopeDrift as boolean,
      observedPlanPatchMismatch: raw.observedPlanPatchMismatch as boolean,
      observedRepairLoop: raw.observedRepairLoop as boolean,
      observedSuspiciousRoleBehavior: raw.observedSuspiciousRoleBehavior as boolean,
      observedEvidenceConflict: raw.observedEvidenceConflict as boolean,
      recommendation,
      rationaleCodes
    };
    let observationHash: string;
    try {
      observationHash = hashCanonicalJson(observationWithoutHash);
    } catch {
      issue(
        "observation_hash_failure",
        "The normalized observation could not be hashed.",
        "review"
      );
      return finish(null);
    }
    const observation: ShadowObservation = {
      ...observationWithoutHash,
      observationHash
    };
    summary.structureValid = true;
    summary.evidenceReferencesValid = true;
    summary.semanticConsistencyValid = true;
    return finish(observation);
  } catch {
    issue(
      "validation_exception",
      "Shadow observation validation could not complete safely.",
      "review"
    );
    return finish(null);
  }
}
