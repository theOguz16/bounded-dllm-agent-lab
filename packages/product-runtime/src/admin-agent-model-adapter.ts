import { canonicalizeJson, hashCanonicalJson } from "./agent-event-ledger.js";
import {
  ADMIN_DECISION_VERSION,
  validateAdminDecision,
  type AdminDecision,
  type AdminDecisionValidationDecision,
  type AdminRiskLevel,
  type ValidatedAdminDecision
} from "./admin-agent-contract.js";
import type {
  DeterministicGovernanceAssessment,
  DeterministicGovernanceDecision
} from "./deterministic-governance-policy.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";
import type { ShadowObservation } from "./shadow-observer-contract.js";

/**
 * Admin receives only bounded trace, validated Shadow, and deterministic
 * governance evidence: no patch/source contents or other agent prompts are
 * sent. Governance remains authoritative and Admin may strengthen, never
 * weaken it. Model output is untrusted until W.8 validation; structural validity
 * does not prove objective semantic correctness. Auto approval is not apply
 * authorization. Raw output is discarded after parsing and hashing, and W.9
 * performs no repository mutation.
 */

export type AdminAgentAdapterDecision =
  | "admin_agent_completed"
  | "admin_agent_needs_review"
  | "admin_agent_failed";
export type AdminAgentAdapterIssueSeverity = "review" | "error";
export type AdminAgentAdapterIssue = {
  code: string;
  message: string;
  severity: AdminAgentAdapterIssueSeverity;
};

export type AdminAgentModelAdapterConfig = {
  endpoint: string;
  modelId: string;
  timeoutMs?: number;
  maxTraceEvents?: number;
  maxPromptChars?: number;
  maxResponseChars?: number;
  fetchImpl?: typeof fetch;
};

export type AdminAgentUpstreamUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AdminAgentModelAdapterResult = {
  decision: AdminAgentAdapterDecision;
  called: boolean;
  issues: readonly AdminAgentAdapterIssue[];
  validationDecision: AdminDecisionValidationDecision | null;
  adminDecision: ValidatedAdminDecision | null;
  responseContentHash: string | null;
  usage: Readonly<AdminAgentUpstreamUsage> | null;
  summary: {
    traceIntegrityVerified: boolean;
    observationIntegrityVerified: boolean;
    governanceIntegrityVerified: boolean;
    traceEventCount: number;
    promptChars: number;
    requestStarted: boolean;
    responseReceived: boolean;
    responseChars: number;
    responseParsed: boolean;
    adminValidationCompleted: boolean;
    adminDecisionBuilt: boolean;
    governanceDecision: DeterministicGovernanceDecision | null;
    finalAdminDecision: AdminDecision | null;
    riskLevel: AdminRiskLevel | null;
    recommendationStrength: "auto" | "repair" | "replan" | "escalate" | "terminate" | null;
    findingCount: number;
    durationMs: number;
  };
};

type ValidatedConfig = Required<Omit<AdminAgentModelAdapterConfig, "fetchImpl">> & {
  fetchImpl: typeof fetch;
};
type Summary = AdminAgentModelAdapterResult["summary"];

const DEFAULTS = {
  timeoutMs: 120_000,
  maxTraceEvents: 100,
  maxPromptChars: 150_000,
  maxResponseChars: 30_000
} as const;
const HARD_MAXIMUMS = {
  timeoutMs: 300_000,
  maxTraceEvents: 1_000,
  maxPromptChars: 750_000,
  maxResponseChars: 100_000
} as const;
const CONTROL = /[\u0000-\u001f\u007f]/;

const GOVERNANCE_DECISION_MATRIX = {
  governance_passed: [
    "admin_auto_approved", "admin_repair_required", "admin_replan_required",
    "admin_human_escalation_required", "admin_run_terminated"
  ],
  governance_repair_required: [
    "admin_repair_required", "admin_replan_required",
    "admin_human_escalation_required", "admin_run_terminated"
  ],
  governance_replan_required: [
    "admin_replan_required", "admin_human_escalation_required", "admin_run_terminated"
  ],
  governance_escalation_required: ["admin_human_escalation_required", "admin_run_terminated"],
  governance_terminated: ["admin_run_terminated"]
} as const;

const ADMIN_SYSTEM_MESSAGE = [
  "You are an evidence-bound Admin Agent.",
  "Deterministic governance is the hard authority.",
  "You may preserve or strengthen governance, never weaken it.",
  "Use only evidence in the supplied package.",
  "Do not invent event IDs, files, rules, reasons, issues, trace findings, or Shadow findings.",
  "Do not create or modify code, and do not propose patch contents.",
  "Do not change the plan or event ledger.",
  "Do not override deterministic rules.",
  "Do not execute commands or tools.",
  "Do not authorize real-repository application.",
  "admin_auto_approved means only that later routing may continue.",
  "Output exactly one JSON object using only the W.8 schema.",
  "Every Admin finding must use exactly these fields: code, severity, message, governanceRuleIds, governanceReasonCodes, governanceIssueCodes, traceFindingCodes, shadowFindingCodes, evidenceEventIds, evidenceFilePaths.",
  "Never copy effect, eventIds, or filePaths directly from a governance issue into an Admin finding.",
  "Map governance issue codes to governanceIssueCodes, event IDs to evidenceEventIds, and file paths to evidenceFilePaths.",
  "Every Admin finding must cite at least one exact bounded evidence value from the supplied package.",
  "Risk score bands are exact: low 0-24, medium 25-49, high 50-74, critical 75-100.",
  "For example, riskScore 90 requires riskLevel critical, not high.",
  "The validOutputExample object is an example of the entire Admin response.",
  "Your top-level response must contain decisionVersion, bindings, decision, risk fields, findings, and rationaleCodes.",
  "Never return only one finding object.",
  "Return only the fields inside validOutputExample; never output validOutputExample or exampleInstructions as wrapper fields.",
  "No Markdown; no code fences preferred; no prose before or after JSON.",
  "Do not include chain-of-thought; keep finding messages short.",
  "Governance matrix:",
  "governance_passed: auto_approved, repair, replan, escalation, termination",
  "governance_repair_required: repair, replan, escalation, termination",
  "governance_replan_required: replan, escalation, termination",
  "governance_escalation_required: escalation, termination",
  "governance_terminated: termination only",
  "You cannot weaken deterministic governance.",
  "Your decision is workflow evidence, not repository-apply authorization."
].join("\n");

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireLimit(value: unknown, name: keyof typeof HARD_MAXIMUMS): number {
  const resolved = value === undefined ? DEFAULTS[name] : value;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0 || (resolved as number) > HARD_MAXIMUMS[name]) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${HARD_MAXIMUMS[name]}.`);
  }
  return resolved as number;
}

function validateConfig(config: AdminAgentModelAdapterConfig): ValidatedConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("Admin Agent adapter config must be an object.");
  }
  if (typeof config.endpoint !== "string" || config.endpoint.length === 0 ||
      config.endpoint.length > 2048 || config.endpoint.trim() !== config.endpoint || CONTROL.test(config.endpoint)) {
    throw new TypeError("endpoint must be a non-empty bounded URL string.");
  }
  let url: URL;
  try { url = new URL(config.endpoint); }
  catch { throw new TypeError("endpoint must be a valid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("endpoint protocol must be http or https.");
  if (url.username !== "" || url.password !== "") throw new TypeError("endpoint must not contain credentials.");
  if (url.hash !== "") throw new TypeError("endpoint must not contain a fragment.");
  if (typeof config.modelId !== "string" || config.modelId.length === 0 ||
      config.modelId.length > 128 || config.modelId.trim() !== config.modelId || CONTROL.test(config.modelId)) {
    throw new TypeError("modelId must be a non-empty bounded string without ASCII controls.");
  }
  if (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  return {
    endpoint: url.toString(), modelId: config.modelId,
    timeoutMs: requireLimit(config.timeoutMs, "timeoutMs"),
    maxTraceEvents: requireLimit(config.maxTraceEvents, "maxTraceEvents"),
    maxPromptChars: requireLimit(config.maxPromptChars, "maxPromptChars"),
    maxResponseChars: requireLimit(config.maxResponseChars, "maxResponseChars"),
    fetchImpl
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

function governanceMaterial(value: DeterministicGovernanceAssessment): Omit<DeterministicGovernanceAssessment, "governanceHash"> {
  return {
    governanceVersion: value.governanceVersion, runId: value.runId,
    traceHash: value.traceHash, observationHash: value.observationHash,
    policy: value.policy, policyHash: value.policyHash, decision: value.decision,
    triggeredRuleIds: value.triggeredRuleIds, reasonCodes: value.reasonCodes,
    issues: value.issues, ruleResults: value.ruleResults, riskClass: value.riskClass
  };
}

function shadowPayload(observation: ShadowObservation | null): unknown {
  if (observation === null) return null;
  return {
    observationVersion: observation.observationVersion, runId: observation.runId,
    traceHash: observation.traceHash, riskLevel: observation.riskLevel,
    riskScore: observation.riskScore, confidenceScore: observation.confidenceScore,
    findings: observation.findings.map((finding) => ({
      code: finding.code, severity: finding.severity,
      ...(finding.actor === undefined ? {} : { actor: finding.actor }),
      evidenceEventIds: finding.evidenceEventIds,
      evidenceFilePaths: finding.evidenceFilePaths,
      evidenceTraceFindingCodes: finding.evidenceTraceFindingCodes
    })),
    observedScopeDrift: observation.observedScopeDrift,
    observedPlanPatchMismatch: observation.observedPlanPatchMismatch,
    observedRepairLoop: observation.observedRepairLoop,
    observedSuspiciousRoleBehavior: observation.observedSuspiciousRoleBehavior,
    observedEvidenceConflict: observation.observedEvidenceConflict,
    recommendation: observation.recommendation, rationaleCodes: observation.rationaleCodes,
    observationHash: observation.observationHash
  };
}

export function buildAdminAgentMessages(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  governance: DeterministicGovernanceAssessment
): readonly { role: "system" | "user"; content: string }[] {
  const payload = {
    requestVersion: "1", task: "admin_evaluate_governed_change",
    authority: {
      deterministicGovernanceAuthoritative: true, adminMayStrengthenOnly: true,
      mayAuthorizeRepositoryApply: false, mayMutatePatch: false, mayExecuteCommands: false
    },
    bindings: {
      runId: trace.runId, traceHash: trace.traceHash,
      observationHash: observation?.observationHash ?? null,
      governanceHash: governance.governanceHash
    },
    governanceDecisionMatrix: GOVERNANCE_DECISION_MATRIX,
    trace: { ...traceMaterial(trace), traceHash: trace.traceHash },
    shadowObservation: shadowPayload(observation),
    governance: {
      governanceVersion: governance.governanceVersion, runId: governance.runId,
      traceHash: governance.traceHash, observationHash: governance.observationHash,
      policy: governance.policy, policyHash: governance.policyHash,
      decision: governance.decision, triggeredRuleIds: governance.triggeredRuleIds,
      reasonCodes: governance.reasonCodes,
      issues: governance.issues.map((entry) => ({
        code: entry.code, severity: entry.severity, effect: entry.effect,
        eventIds: entry.eventIds, filePaths: entry.filePaths,
        traceFindingCodes: entry.traceFindingCodes, shadowFindingCodes: entry.shadowFindingCodes
      })),
      ruleResults: governance.ruleResults, riskClass: governance.riskClass,
      governanceHash: governance.governanceHash
    },
    outputContract: {
      decisionVersion: ADMIN_DECISION_VERSION,
      decisions: [
        "admin_auto_approved", "admin_repair_required", "admin_replan_required",
        "admin_human_escalation_required", "admin_run_terminated"
      ],
      riskLevels: ["low", "medium", "high", "critical"],
      riskScoreBands: {
        low: { minimum: 0, maximum: 24 },
        medium: { minimum: 25, maximum: 49 },
        high: { minimum: 50, maximum: 74 },
        critical: { minimum: 75, maximum: 100 }
      },
      requiredFields: [
        "decisionVersion", "runId", "traceHash", "observationHash", "governanceHash",
        "decision", "riskLevel", "riskScore", "confidenceScore", "findings", "rationaleCodes"
      ],
      findingContract: {
        requiredFields: [
          "code",
          "severity",
          "message",
          "governanceRuleIds",
          "governanceReasonCodes",
          "governanceIssueCodes",
          "traceFindingCodes",
          "shadowFindingCodes",
          "evidenceEventIds",
          "evidenceFilePaths"
        ],
        allowedFields: [
          "code",
          "severity",
          "message",
          "governanceRuleIds",
          "governanceReasonCodes",
          "governanceIssueCodes",
          "traceFindingCodes",
          "shadowFindingCodes",
          "evidenceEventIds",
          "evidenceFilePaths"
        ],
        severities: ["info", "warning", "high", "critical"],
        evidenceRequired: true,
        invalidFieldAliases: ["effect", "eventIds", "filePaths"]
      },
      fieldMappings: {
        governanceIssueCode: "governanceIssueCodes",
        governanceRuleId: "governanceRuleIds",
        governanceReasonCode: "governanceReasonCodes",
        governanceEventIds: "evidenceEventIds",
        governanceFilePaths: "evidenceFilePaths",
        governanceTraceFindingCodes: "traceFindingCodes",
        governanceShadowFindingCodes: "shadowFindingCodes",
        governanceEffect: "do_not_output"
      },
      semanticRules: {
        unknownFieldsForbidden: true,
        riskLevelMustMatchRiskScoreBand: true,
        decisionMustPreserveOrStrengthenGovernance: true,
        nonAutoDecisionRequiresGovernanceEvidence: true,
        everyFindingRequiresVerifiedEvidence: true
      },
      exampleInstructions: [
        "validOutputExample is the complete top-level Admin response.",
        "Never return only the nested finding object.",
        "Use only evidence values present in the supplied bounded package."
      ],
      validOutputExample: {
        decisionVersion: ADMIN_DECISION_VERSION,
        runId: trace.runId,
        traceHash: trace.traceHash,
        observationHash: observation?.observationHash ?? null,
        governanceHash: governance.governanceHash,
        decision:
          governance.decision === "governance_passed"
            ? "admin_auto_approved"
            : governance.decision === "governance_repair_required"
              ? "admin_repair_required"
              : governance.decision === "governance_replan_required"
                ? "admin_replan_required"
                : governance.decision === "governance_escalation_required"
                  ? "admin_human_escalation_required"
                  : "admin_run_terminated",
        riskLevel:
          governance.decision === "governance_passed"
            ? "low"
            : governance.decision === "governance_repair_required" ||
                governance.decision === "governance_replan_required"
              ? "medium"
              : governance.decision === "governance_escalation_required"
                ? "high"
                : "critical",
        riskScore:
          governance.decision === "governance_passed"
            ? 10
            : governance.decision === "governance_repair_required" ||
                governance.decision === "governance_replan_required"
              ? 35
              : governance.decision === "governance_escalation_required"
                ? 60
                : 90,
        confidenceScore: 90,
        findings:
          governance.decision === "governance_passed"
            ? []
            : [
                {
                  code: "bounded_admin_evidence",
                  severity:
                    governance.decision === "governance_terminated"
                      ? "critical"
                      : governance.decision === "governance_escalation_required"
                        ? "high"
                        : "warning",
                  message:
                    "Bounded governance evidence supports this Admin decision.",
                  governanceRuleIds:
                    governance.triggeredRuleIds.slice(0, 1),
                  governanceReasonCodes:
                    governance.reasonCodes.slice(0, 1),
                  governanceIssueCodes:
                    governance.issues.slice(0, 1).map((entry) => entry.code),
                  traceFindingCodes: [],
                  shadowFindingCodes: [],
                  evidenceEventIds: [
                    ...governance.issues.flatMap((entry) => entry.eventIds),
                    ...governance.ruleResults
                      .filter((rule) => rule.triggered)
                      .flatMap((rule) => rule.eventIds),
                    ...trace.events.map((event) => event.eventId)
                  ].slice(0, 1),
                  evidenceFilePaths: [
                    ...governance.issues.flatMap((entry) => entry.filePaths),
                    ...governance.ruleResults
                      .filter((rule) => rule.triggered)
                      .flatMap((rule) => rule.filePaths),
                    ...trace.files.allProposedFiles
                  ].slice(0, 1)
                }
              ],
        rationaleCodes:
          governance.reasonCodes.length > 0
            ? governance.reasonCodes.slice(0, 1)
            : ["bounded_admin_review"]
      }
    }
  };
  return deepFreeze([
    { role: "system" as const, content: ADMIN_SYSTEM_MESSAGE },
    { role: "user" as const, content: canonicalizeJson(payload) }
  ]);
}

export function parseAdminAgentCompletionContent(content: string): unknown {
  if (typeof content !== "string") throw new TypeError("Admin completion content must be a string.");
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new TypeError("Admin completion content must not be empty.");
  let jsonText = trimmed;
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    const match = /^```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
    if (match === null) throw new TypeError("Admin completion fence must contain the entire response.");
    if (match[1] !== "" && match[1] !== "json") throw new TypeError("Admin completion fence language is unsupported.");
    if (match[2].includes("```")) throw new TypeError("Nested or multiple Admin completion fences are unsupported.");
    jsonText = match[2].trim();
    if (jsonText.length === 0) throw new TypeError("Admin completion fence must contain JSON.");
  } else if (trimmed.includes("```")) throw new TypeError("Partial Admin completion fences are unsupported.");
  const parsed = JSON.parse(jsonText) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new TypeError("Admin completion must contain exactly one JSON object.");
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  return true;
}

type BoundedBody = { ok: true; content: string; chars: number } | { ok: false; chars: number };
async function readBoundedBody(response: Response, maximum: number): Promise<BoundedBody> {
  if (response.body === null) return { ok: true, content: "", chars: 0 };
  const reader = response.body?.getReader?.();
  if (reader !== undefined) {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let chars = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const decoded = decoder.decode(next.value, { stream: true });
        if (chars + decoded.length > maximum) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, chars: maximum + 1 };
        }
        chars += decoded.length; chunks.push(decoded);
      }
      const final = decoder.decode();
      if (chars + final.length > maximum) return { ok: false, chars: maximum + 1 };
      chars += final.length; chunks.push(final);
      return { ok: true, content: chunks.join(""), chars };
    } finally { reader.releaseLock(); }
  }
  // Without a stream, reject unknown or excessive lengths before using text().
  const lengthText = response.headers?.get?.("content-length") ?? null;
  const length = lengthText !== null && /^\d+$/.test(lengthText) ? Number(lengthText) : null;
  if (length === null || !Number.isSafeInteger(length) || length > maximum) return { ok: false, chars: maximum + 1 };
  const content = await response.text();
  return content.length <= maximum ? { ok: true, content, chars: content.length } : { ok: false, chars: maximum + 1 };
}

function parseUsage(value: unknown): AdminAgentUpstreamUsage | null {
  if (!isPlainRecord(value)) return null;
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0 ||
      !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0 ||
      !Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0 ||
      (inputTokens as number) > Number.MAX_SAFE_INTEGER - (outputTokens as number) ||
      totalTokens !== (inputTokens as number) + (outputTokens as number)) return null;
  return { inputTokens, outputTokens, totalTokens } as AdminAgentUpstreamUsage;
}

function initialSummary(trace: RunAccountabilityTrace): Summary {
  return {
    traceIntegrityVerified: false, observationIntegrityVerified: false,
    governanceIntegrityVerified: false,
    traceEventCount: Array.isArray(trace?.events) ? trace.events.length : 0,
    promptChars: 0, requestStarted: false, responseReceived: false, responseChars: 0,
    responseParsed: false, adminValidationCompleted: false, adminDecisionBuilt: false,
    governanceDecision: null, finalAdminDecision: null, riskLevel: null,
    recommendationStrength: null, findingCount: 0, durationMs: 0
  };
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0;
}

const STRENGTH: Record<AdminDecision, NonNullable<Summary["recommendationStrength"]>> = {
  admin_auto_approved: "auto", admin_repair_required: "repair",
  admin_replan_required: "replan", admin_human_escalation_required: "escalate",
  admin_run_terminated: "terminate"
};

export async function runAdminAgentModel(
  trace: RunAccountabilityTrace,
  observation: ShadowObservation | null,
  governance: DeterministicGovernanceAssessment,
  config: AdminAgentModelAdapterConfig
): Promise<AdminAgentModelAdapterResult> {
  const validated = validateConfig(config);
  const summary = initialSummary(trace);
  const issues: AdminAgentAdapterIssue[] = [];
  let called = false;
  let validationDecision: AdminDecisionValidationDecision | null = null;
  let adminDecision: ValidatedAdminDecision | null = null;
  let responseContentHash: string | null = null;
  let usage: AdminAgentUpstreamUsage | null = null;
  const started = now();
  const issue = (code: string, message: string, severity: AdminAgentAdapterIssueSeverity): void => { issues.push({ code, message, severity }); };
  const finish = (): AdminAgentModelAdapterResult => {
    const error = issues.some((entry) => entry.severity === "error");
    const review = issues.some((entry) => entry.severity === "review");
    const decision: AdminAgentAdapterDecision = error ? "admin_agent_failed" : review ? "admin_agent_needs_review" : "admin_agent_completed";
    const exposedDecision = error ? null : adminDecision;
    summary.durationMs = Math.max(0, Math.round(now() - started));
    summary.adminDecisionBuilt = exposedDecision !== null;
    summary.finalAdminDecision = exposedDecision?.decision ?? null;
    summary.riskLevel = exposedDecision?.riskLevel ?? null;
    summary.recommendationStrength = exposedDecision ? STRENGTH[exposedDecision.decision] : null;
    summary.findingCount = exposedDecision?.findings.length ?? 0;
    return deepFreeze({
      decision, called, issues, validationDecision, adminDecision: exposedDecision,
      responseContentHash, usage, summary
    }) as AdminAgentModelAdapterResult;
  };

  try {
    try { summary.traceIntegrityVerified = hashCanonicalJson(traceMaterial(trace)) === trace.traceHash; }
    catch { summary.traceIntegrityVerified = false; }
    if (!summary.traceIntegrityVerified) { issue("admin_adapter_trace_integrity_mismatch", "The accountability trace integrity check failed.", "error"); return finish(); }

    const expectedObservationHash = observation?.observationHash ?? null;
    if (observation === null) summary.observationIntegrityVerified = true;
    else {
      try { summary.observationIntegrityVerified = hashCanonicalJson(observationMaterial(observation)) === observation.observationHash; }
      catch { summary.observationIntegrityVerified = false; }
      if (!summary.observationIntegrityVerified) { issue("admin_adapter_observation_integrity_mismatch", "The Shadow observation integrity check failed.", "error"); return finish(); }
      if (observation.runId !== trace.runId || observation.traceHash !== trace.traceHash) { issue("admin_adapter_observation_trace_mismatch", "The Shadow observation is not bound to this trace.", "error"); return finish(); }
    }

    let policyValid = false;
    try { policyValid = hashCanonicalJson(governance.policy) === governance.policyHash; } catch { policyValid = false; }
    if (!policyValid) { issue("admin_adapter_policy_hash_mismatch", "The governance policy hash is inconsistent.", "error"); return finish(); }
    try { summary.governanceIntegrityVerified = hashCanonicalJson(governanceMaterial(governance)) === governance.governanceHash; }
    catch { summary.governanceIntegrityVerified = false; }
    if (!summary.governanceIntegrityVerified) { issue("admin_adapter_governance_integrity_mismatch", "The governance assessment integrity check failed.", "error"); return finish(); }
    if (governance.runId !== trace.runId || governance.traceHash !== trace.traceHash) { issue("admin_adapter_governance_trace_mismatch", "Governance is not bound to this trace.", "error"); return finish(); }
    if (governance.observationHash !== expectedObservationHash) { issue("admin_adapter_governance_observation_mismatch", "Governance is not bound to this observation.", "error"); return finish(); }
    summary.governanceDecision = governance.decision;

    if (trace.events.length > validated.maxTraceEvents) { issue("admin_trace_event_limit_exceeded", "The trace exceeds the configured event limit.", "review"); return finish(); }
    const messages = buildAdminAgentMessages(trace, observation, governance);
    summary.promptChars = messages.reduce((total, message) => total + message.content.length, 0);
    if (summary.promptChars > validated.maxPromptChars) { issue("admin_prompt_size_limit_exceeded", "The Admin prompt exceeds the configured character limit.", "review"); return finish(); }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, validated.timeoutMs);
    try {
      called = true; summary.requestStarted = true;
      const response = await validated.fetchImpl(validated.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: validated.modelId, temperature: 0, stream: false, messages }),
        signal: controller.signal
      });
      summary.responseReceived = true;
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : 0;
        issue("admin_upstream_http_error", status > 0 ? `Admin endpoint returned HTTP ${status}.` : "Admin endpoint returned a non-success response.", "error");
        return finish();
      }
      const bounded = await readBoundedBody(response, validated.maxResponseChars);
      summary.responseChars = bounded.chars;
      if (!bounded.ok) { issue("admin_response_size_limit_exceeded", "The Admin response exceeds the configured character limit.", "review"); return finish(); }
      let upstream: unknown;
      try { upstream = JSON.parse(bounded.content) as unknown; }
      catch { issue("invalid_admin_upstream_response", "The Admin endpoint response is not valid JSON.", "error"); return finish(); }
      summary.responseParsed = true;
      if (!isPlainRecord(upstream)) { issue("invalid_admin_upstream_response", "The Admin endpoint response must be a JSON object.", "error"); return finish(); }
      const choices = upstream.choices;
      if (!isDenseArray(choices) || choices.length === 0 || !isPlainRecord(choices[0])) { issue("invalid_admin_upstream_response", "The Admin endpoint response has invalid choices.", "error"); return finish(); }
      const message = choices[0].message;
      if (!isPlainRecord(message)) { issue("invalid_admin_upstream_response", "The Admin endpoint response is missing a valid message.", "error"); return finish(); }
      const content = message.content;
      if (typeof content !== "string") { issue("missing_admin_completion_content", "The Admin endpoint response is missing string completion content.", "error"); return finish(); }
      responseContentHash = hashCanonicalJson(content);
      if (Object.prototype.hasOwnProperty.call(upstream, "usage")) {
        usage = parseUsage(upstream.usage);
        if (usage === null) issue("invalid_admin_upstream_usage", "The Admin endpoint returned malformed token usage.", "review");
      }
      let parsed: unknown;
      try { parsed = parseAdminAgentCompletionContent(content); }
      catch { issue("malformed_admin_completion_json", "The Admin completion is not exactly one supported JSON object.", "error"); return finish(); }
      const validation = validateAdminDecision(trace, observation, governance, parsed);
      validationDecision = validation.decision;
      summary.adminValidationCompleted = true;
      if (validation.decision === "admin_decision_invalid") { issue("admin_decision_validation_failed", "The Admin completion failed deterministic validation.", "error"); return finish(); }
      adminDecision = validation.adminDecision;
      if (validation.decision === "admin_decision_needs_review") issue("admin_decision_validation_needs_review", "The Admin completion requires deterministic review.", "review");
      return finish();
    } catch {
      issue(timedOut ? "admin_upstream_timeout" : "admin_upstream_request_failed",
        timedOut ? "The Admin endpoint request timed out." : "The Admin endpoint request failed.", "error");
      return finish();
    } finally { clearTimeout(timer); }
  } catch {
    issue("admin_adapter_exception", "The Admin Agent adapter could not complete safely.", "error");
    return finish();
  }
}
