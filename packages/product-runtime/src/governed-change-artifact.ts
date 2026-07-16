import {
  appendAgentEvent,
  canonicalizeJson,
  createAgentEventLedger,
  hashCanonicalJson,
  type AgentEvent,
  type AgentEventLedger
} from "./agent-event-ledger.js";
import { verifyAgentEventLedger } from "./agent-event-ledger-verifier.js";
import type { RunAccountabilityTrace } from "./run-accountability-trace.js";
import {
  validateShadowObservation,
  type ShadowObservation,
  type ShadowObservationValidationDecision
} from "./shadow-observer-contract.js";
import {
  evaluateDeterministicGovernance,
  type DeterministicGovernanceAssessment,
  type DeterministicGovernanceDecision
} from "./deterministic-governance-policy.js";
import {
  validateAdminDecision,
  type AdminDecision,
  type AdminDecisionValidationDecision,
  type ValidatedAdminDecision
} from "./admin-agent-contract.js";
import {
  evaluateAdminInvocationPolicy,
  type AdminInvocationAssessment,
  type AdminInvocationDecision,
  type AdminInvocationMode,
  type AdminInvocationSkipKind
} from "./admin-invocation-policy.js";
import {
  evaluateRiskBasedApprovalRoute,
  type AdminRoutingStageDecision,
  type ApprovalWorkflowRoute,
  type PhaseVTerminalDecision,
  type RiskBasedApprovalAssessment,
  type ShadowRoutingStageDecision
} from "./risk-based-approval-router.js";

/**
 * This artifact contains only bounded hashes, IDs, paths, decisions, and policy
 * evidence; it never contains patch or source content. A later handoff must
 * receive the mutation separately, recompute its hash, compare it here, and run
 * stale-decision verification immediately before handoff. This artifact does
 * not authorize repository apply: eligibility only permits later consideration,
 * and W.13 performs no repository mutation.
 */

export const GOVERNED_CHANGE_ARTIFACT_VERSION = "2" as const;

export type GovernedChangeKind = "coder_patch_draft" | "repair_draft";

export type GovernedChangeBindingInput = {
  changeKind: GovernedChangeKind;
  mutationHash: string;
  changedFiles: readonly string[];
  patchDryRunResultHash: string;
  temporaryApplyResultHash: string;
  executionVerificationResultHash: string;
};

export type GovernedChangeLedgerAnchors = {
  expectedRunId: string;
  expectedObjectiveHash: string;
  expectedRootHash: string;
  expectedEventCount: number;
};

export type GovernedChangeArtifactInput = {
  finalLedger: unknown;
  finalLedgerAnchors: GovernedChangeLedgerAnchors;
  preShadowTrace: RunAccountabilityTrace;
  shadowObservation: ShadowObservation | null;
  governanceAssessment: DeterministicGovernanceAssessment;
  adminInvocationAssessment: AdminInvocationAssessment;
  adminDecision: ValidatedAdminDecision | null;
  approvalRouterAssessment: RiskBasedApprovalAssessment;
  change: GovernedChangeBindingInput;
};

export type GovernedChangeArtifactDecision =
  | "governed_change_artifact_ready"
  | "governed_change_artifact_blocked"
  | "governed_change_artifact_invalid"
  | "governed_change_artifact_needs_review";

export type GovernedChangeStageEventBindings = {
  mutationSourceEventId: string;
  patchDryRunEventId: string;
  temporaryApplyEventId: string;
  executionVerifierEventId: string;
  shadowObserverEventId: string | null;
  deterministicGovernorEventId: string;
  adminInvocationPolicyEventId: string;
  adminAgentEventId: string | null;
  approvalRouterEventId: string;
};

export type GovernedChangeChain = GovernedChangeBindingInput & {
  stageEvents: GovernedChangeStageEventBindings;
};

export type GovernedChangeEvidenceBindings = {
  runId: string;
  objectiveHash: string;
  preShadowLedgerRootHash: string;
  preShadowLedgerEventCount: number;
  preShadowTraceHash: string;
  observationHash: string | null;
  governanceHash: string;
  adminInvocationPolicyHash: string;
  adminInvocationAssessmentHash: string;
  adminDecisionHash: string | null;
  routeHash: string;
  governancePolicyHash: string;
  routerPolicyHash: string;
  finalLedgerRootHash: string;
  finalLedgerEventCount: number;
};

export type GovernedChangeDecisionSnapshot = {
  phaseVFinalDecision: PhaseVTerminalDecision;
  shadowStageDecision: ShadowRoutingStageDecision;
  shadowValidationDecision: ShadowObservationValidationDecision | null;
  governanceDecision: DeterministicGovernanceDecision;
  adminInvocationMode: AdminInvocationMode;
  adminInvocationDecision: AdminInvocationDecision;
  adminInvocationSkipKind: AdminInvocationSkipKind;
  adminResolutionKind: "model_decision" | "verified_policy_skip";
  adminStageDecision: AdminRoutingStageDecision;
  adminValidationDecision: AdminDecisionValidationDecision | null;
  adminDecision: AdminDecision | null;
  routerValidationDecision: "approval_route_valid";
  workflowRoute: ApprovalWorkflowRoute;
};

export type GovernedChangeApplyEligibility = {
  eligible: boolean;
  reasonCodes: readonly string[];
};

export type GovernedChangeArtifact = {
  artifactVersion: "2";
  change: GovernedChangeChain;
  evidence: GovernedChangeEvidenceBindings;
  decisions: GovernedChangeDecisionSnapshot;
  applyEligibility: GovernedChangeApplyEligibility;
  governedArtifactHash: string;
};

export type GovernedChangeArtifactIssueSeverity = "review" | "error";

export type GovernedChangeArtifactIssue = {
  code: string;
  message: string;
  severity: GovernedChangeArtifactIssueSeverity;
  field?: string;
  eventId?: string;
  hashValue?: string;
  filePath?: string;
};

export type GovernedChangeArtifactResult = {
  decision: GovernedChangeArtifactDecision;
  issues: readonly GovernedChangeArtifactIssue[];
  artifact: GovernedChangeArtifact | null;
  summary: {
    finalLedgerValid: boolean;
    finalLedgerAnchored: boolean;
    preShadowPrefixVerified: boolean;
    preShadowTraceIntegrityVerified: boolean;
    shadowObservationProvided: boolean;
    shadowObservationVerified: boolean;
    governanceVerified: boolean;
    adminInvocationVerified: boolean;
    adminDecisionProvided: boolean;
    adminDecisionVerified: boolean;
    routerAssessmentVerified: boolean;
    mutationSourceVerified: boolean;
    patchDryRunChainVerified: boolean;
    temporaryApplyChainVerified: boolean;
    executionVerificationChainVerified: boolean;
    changedFilesMatchedMutation: boolean;
    changedFilesMatchedTemporaryApply: boolean;
    changedFilesMatchedTrace: boolean;
    cleanupSuccessObserved: boolean;
    cleanupFailureObserved: boolean;
    artifactBuilt: boolean;
    applyEligible: boolean;
    changedFileCount: number;
    finalLedgerEventCount: number;
    finalLedgerRootHash: string | null;
    governedArtifactHashValid: boolean;
  };
};

export type GovernedChangeFreshnessSnapshot = {
  runId: string;
  objectiveHash: string;
  mutationHash: string;
  changedFiles: readonly string[];
  patchDryRunResultHash: string;
  temporaryApplyResultHash: string;
  executionVerificationResultHash: string;
  preShadowTraceHash: string;
  observationHash: string | null;
  governanceHash: string;
  adminInvocationPolicyHash: string;
  adminInvocationAssessmentHash: string;
  adminDecisionHash: string | null;
  routeHash: string;
  governancePolicyHash: string;
  routerPolicyHash: string;
  finalLedgerRootHash: string;
  finalLedgerEventCount: number;
  phaseVFinalDecision: PhaseVTerminalDecision;
  workflowRoute: ApprovalWorkflowRoute;
};

export type GovernedChangeFreshnessDecision =
  | "governed_change_current"
  | "governed_change_stale"
  | "governed_change_freshness_invalid";

export type GovernedChangeFreshnessResult = {
  decision: GovernedChangeFreshnessDecision;
  artifactIntegrityVerified: boolean;
  currentSnapshotHash: string | null;
  staleFields: readonly string[];
  reasonCodes: readonly string[];
  handoffEligible: boolean;
  summary: {
    runMatched: boolean;
    objectiveMatched: boolean;
    mutationMatched: boolean;
    changedFilesMatched: boolean;
    patchDryRunMatched: boolean;
    temporaryApplyMatched: boolean;
    executionVerificationMatched: boolean;
    traceMatched: boolean;
    observationMatched: boolean;
    governanceMatched: boolean;
    adminInvocationPolicyMatched: boolean;
    adminInvocationAssessmentMatched: boolean;
    adminDecisionMatched: boolean;
    routeMatched: boolean;
    governancePolicyMatched: boolean;
    routerPolicyMatched: boolean;
    finalLedgerRootMatched: boolean;
    finalLedgerEventCountMatched: boolean;
    phaseVDecisionMatched: boolean;
    workflowRouteMatched: boolean;
    artifactApplyEligible: boolean;
    snapshotCurrent: boolean;
  };
};

type ArtifactSummary = GovernedChangeArtifactResult["summary"];
type FreshnessSummary = GovernedChangeFreshnessResult["summary"];
type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_CHANGED_FILES = 1000;
const MAX_CLONED_NODES = 200_000;

const INPUT_FIELDS = [
  "finalLedger", "finalLedgerAnchors", "preShadowTrace", "shadowObservation",
  "governanceAssessment", "adminInvocationAssessment", "adminDecision",
  "approvalRouterAssessment", "change"
] as const;
const ANCHOR_FIELDS = [
  "expectedRunId", "expectedObjectiveHash", "expectedRootHash", "expectedEventCount"
] as const;
const CHANGE_FIELDS = [
  "changeKind", "mutationHash", "changedFiles", "patchDryRunResultHash",
  "temporaryApplyResultHash", "executionVerificationResultHash"
] as const;
const ARTIFACT_FIELDS = [
  "artifactVersion", "change", "evidence", "decisions", "applyEligibility",
  "governedArtifactHash"
] as const;
const CHAIN_FIELDS = [...CHANGE_FIELDS, "stageEvents"] as const;
const STAGE_EVENT_FIELDS = [
  "mutationSourceEventId", "patchDryRunEventId", "temporaryApplyEventId",
  "executionVerifierEventId", "shadowObserverEventId",
  "deterministicGovernorEventId", "adminInvocationPolicyEventId",
  "adminAgentEventId", "approvalRouterEventId"
] as const;
const EVIDENCE_FIELDS = [
  "runId", "objectiveHash", "preShadowLedgerRootHash", "preShadowLedgerEventCount",
  "preShadowTraceHash", "observationHash", "governanceHash",
  "adminInvocationPolicyHash", "adminInvocationAssessmentHash", "adminDecisionHash",
  "routeHash", "governancePolicyHash", "routerPolicyHash", "finalLedgerRootHash",
  "finalLedgerEventCount"
] as const;
const DECISION_FIELDS = [
  "phaseVFinalDecision", "shadowStageDecision", "shadowValidationDecision",
  "governanceDecision", "adminInvocationMode", "adminInvocationDecision",
  "adminInvocationSkipKind", "adminResolutionKind", "adminStageDecision",
  "adminValidationDecision", "adminDecision", "routerValidationDecision", "workflowRoute"
] as const;
const ELIGIBILITY_FIELDS = ["eligible", "reasonCodes"] as const;
const FRESHNESS_FIELDS = [
  "runId", "objectiveHash", "mutationHash", "changedFiles",
  "patchDryRunResultHash", "temporaryApplyResultHash",
  "executionVerificationResultHash", "preShadowTraceHash", "observationHash",
  "governanceHash", "adminInvocationPolicyHash", "adminInvocationAssessmentHash",
  "adminDecisionHash", "routeHash", "governancePolicyHash",
  "routerPolicyHash", "finalLedgerRootHash", "finalLedgerEventCount",
  "phaseVFinalDecision", "workflowRoute"
] as const;

const PHASE_DECISIONS = new Set<PhaseVTerminalDecision>([
  "temp_validation_passed", "temp_validation_failed", "temp_validation_needs_review"
]);
const ROUTES = new Set<ApprovalWorkflowRoute>([
  "auto_continue", "repair_required", "replan_required", "human_required", "terminated"
]);

class SafeInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Omit<GovernedChangeArtifactIssue, "code" | "message" | "severity"> = {}
  ) {
    super(message);
  }
}

class BoundedInputError extends Error {
  constructor(readonly code = "governed_change_artifact_exception") {
    super("Governed change input exceeds a deterministic validation bound.");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function initialSummary(): ArtifactSummary {
  return {
    finalLedgerValid: false,
    finalLedgerAnchored: false,
    preShadowPrefixVerified: false,
    preShadowTraceIntegrityVerified: false,
    shadowObservationProvided: false,
    shadowObservationVerified: false,
    governanceVerified: false,
    adminInvocationVerified: false,
    adminDecisionProvided: false,
    adminDecisionVerified: false,
    routerAssessmentVerified: false,
    mutationSourceVerified: false,
    patchDryRunChainVerified: false,
    temporaryApplyChainVerified: false,
    executionVerificationChainVerified: false,
    changedFilesMatchedMutation: false,
    changedFilesMatchedTemporaryApply: false,
    changedFilesMatchedTrace: false,
    cleanupSuccessObserved: false,
    cleanupFailureObserved: false,
    artifactBuilt: false,
    applyEligible: false,
    changedFileCount: 0,
    finalLedgerEventCount: 0,
    finalLedgerRootHash: null,
    governedArtifactHashValid: false
  };
}

function initialFreshnessSummary(): FreshnessSummary {
  return {
    runMatched: false,
    objectiveMatched: false,
    mutationMatched: false,
    changedFilesMatched: false,
    patchDryRunMatched: false,
    temporaryApplyMatched: false,
    executionVerificationMatched: false,
    traceMatched: false,
    observationMatched: false,
    governanceMatched: false,
    adminInvocationPolicyMatched: false,
    adminInvocationAssessmentMatched: false,
    adminDecisionMatched: false,
    routeMatched: false,
    governancePolicyMatched: false,
    routerPolicyMatched: false,
    finalLedgerRootMatched: false,
    finalLedgerEventCountMatched: false,
    phaseVDecisionMatched: false,
    workflowRouteMatched: false,
    artifactApplyEligible: false,
    snapshotCurrent: false
  };
}

function finishArtifact(
  decision: GovernedChangeArtifactDecision,
  issues: GovernedChangeArtifactIssue[],
  artifact: GovernedChangeArtifact | null,
  summary: ArtifactSummary
): GovernedChangeArtifactResult {
  issues.sort((left, right) => {
    const leftValue = canonicalizeJson(left);
    const rightValue = canonicalizeJson(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
  return deepFreeze({ decision, issues, artifact, summary });
}

function issueFromError(error: unknown): GovernedChangeArtifactIssue {
  if (error instanceof SafeInputError) {
    return { code: error.code, message: error.message, severity: "error", ...error.context };
  }
  if (error instanceof BoundedInputError) {
    return {
      code: error.code,
      message: "Governed change input exceeds a deterministic validation bound.",
      severity: "review"
    };
  }
  return {
    code: "governed_change_artifact_exception",
    message: "The governed change artifact could not be evaluated safely.",
    severity: "error"
  };
}

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  nodes = { count: 0 }
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object") {
    throw new SafeInputError("invalid_governed_change_input", "Unsupported governed change input value.");
  }
  nodes.count += 1;
  if (nodes.count > MAX_CLONED_NODES) throw new BoundedInputError();
  if (ancestors.has(value)) {
    throw new SafeInputError("invalid_governed_change_object", "Cyclic governed change input is not accepted.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new SafeInputError("invalid_governed_change_object", "Only ordinary arrays are accepted.");
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new SafeInputError("invalid_governed_change_object", "Only plain objects are accepted.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new SafeInputError("governed_change_symbol_property", "Symbol properties are not accepted.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : null;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CLONED_NODES) {
        throw new BoundedInputError();
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new SafeInputError("invalid_governed_change_object", "Sparse arrays are not accepted.");
        }
        if (!("value" in descriptor)) {
          throw new SafeInputError("governed_change_accessor_property", "Accessor properties are not accepted.");
        }
        output.push(safeClone(descriptor.value, ancestors, nodes));
      }
      const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if ((keys as string[]).some((key) => !expected.has(key))) {
        throw new SafeInputError("unknown_governed_change_field", "Unknown array properties are not accepted.");
      }
      return output;
    }
    const output: PlainRecord = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new SafeInputError(
          "governed_change_accessor_property",
          "Accessor properties are not accepted."
        );
      }
      output[key] = safeClone(descriptor.value, ancestors, nodes);
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
): PlainRecord {
  if (typeof value !== "object" || value === null) {
    throw new SafeInputError("invalid_governed_change_input", `${label} must be an object.`);
  }
  if (Array.isArray(value)) {
    throw new SafeInputError("invalid_governed_change_object", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SafeInputError("invalid_governed_change_object", `${label} must be a plain object.`);
  }
  const allowed = new Set(fields);
  const output: PlainRecord = {};
  const present = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new SafeInputError("governed_change_symbol_property", "Symbol properties are not accepted.");
    }
    present.add(key);
    if (!allowed.has(key)) {
      throw new SafeInputError(
        "unknown_governed_change_field",
        `${label} contains an unknown field.`
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new SafeInputError(
        "governed_change_accessor_property",
        "Accessor properties are not accepted.",
        { field: key }
      );
    }
    output[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!present.has(field)) {
      throw new SafeInputError(
        "missing_governed_change_field",
        `${label} is missing a required field.`,
        { field }
      );
    }
  }
  return output;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new SafeInputError(
      "invalid_governed_change_hash",
      "A governed change hash is malformed.",
      { field }
    );
  }
  return value;
}

function normalizeFiles(value: unknown, field = "changedFiles"): string[] {
  if (!Array.isArray(value)) {
    throw new SafeInputError("invalid_governed_change_files", "Changed files must be an array.", { field });
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new SafeInputError("invalid_governed_change_files", "Changed files must be a dense array.", { field });
  }
  if (length > MAX_CHANGED_FILES) {
    throw new BoundedInputError("too_many_governed_change_files");
  }
  const files: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new SafeInputError("invalid_governed_change_files", "Changed files must be a dense data array.", { field });
    }
    const file = descriptor.value;
    if (
      typeof file !== "string" || file.length === 0 || file.trim() !== file ||
      ASCII_CONTROL.test(file)
    ) {
      throw new SafeInputError("invalid_governed_change_files", "Changed files contain an invalid path.", { field });
    }
    files.push(file);
  }
  return sortedUnique(files);
}

function normalizeChange(value: unknown): GovernedChangeBindingInput {
  const record = exactObject(value, CHANGE_FIELDS, "Governed change binding");
  if (record.changeKind !== "coder_patch_draft" && record.changeKind !== "repair_draft") {
    throw new SafeInputError("invalid_governed_change_binding", "The governed change kind is invalid.", { field: "changeKind" });
  }
  return {
    changeKind: record.changeKind,
    mutationHash: requireHash(record.mutationHash, "mutationHash"),
    changedFiles: normalizeFiles(record.changedFiles),
    patchDryRunResultHash: requireHash(record.patchDryRunResultHash, "patchDryRunResultHash"),
    temporaryApplyResultHash: requireHash(record.temporaryApplyResultHash, "temporaryApplyResultHash"),
    executionVerificationResultHash: requireHash(
      record.executionVerificationResultHash,
      "executionVerificationResultHash"
    )
  };
}

function normalizeAnchors(value: unknown): GovernedChangeLedgerAnchors {
  const record = exactObject(value, ANCHOR_FIELDS, "Final ledger anchors");
  if (typeof record.expectedRunId !== "string" || record.expectedRunId.length === 0) {
    throw new SafeInputError("invalid_governed_change_binding", "The expected run ID is invalid.", { field: "expectedRunId" });
  }
  const expectedObjectiveHash = requireHash(record.expectedObjectiveHash, "expectedObjectiveHash");
  const expectedRootHash = requireHash(record.expectedRootHash, "expectedRootHash");
  if (
    !Number.isSafeInteger(record.expectedEventCount) ||
    (record.expectedEventCount as number) < 0 ||
    (record.expectedEventCount as number) > 1000
  ) {
    throw new SafeInputError("invalid_governed_change_binding", "The expected event count is invalid.", { field: "expectedEventCount" });
  }
  return {
    expectedRunId: record.expectedRunId,
    expectedObjectiveHash,
    expectedRootHash,
    expectedEventCount: record.expectedEventCount as number
  };
}

function withoutField(value: PlainRecord, field: string): PlainRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function eventDraft(event: AgentEvent) {
  return {
    actor: event.actor,
    action: event.action,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    inputArtifactHashes: [...event.inputArtifactHashes],
    outputArtifactHashes: [...event.outputArtifactHashes],
    filesRead: [...event.filesRead],
    filesProposed: [...event.filesProposed],
    decision: event.decision,
    reasonCodes: [...event.reasonCodes],
    ...(event.tokenUsage === undefined ? {} : { tokenUsage: { ...event.tokenUsage } })
  };
}

function reconstructPrefix(ledger: AgentEventLedger, count: number): AgentEventLedger | null {
  if (!Number.isSafeInteger(count) || count < 0 || count > ledger.eventCount) return null;
  let prefix = createAgentEventLedger({ runId: ledger.runId, objectiveHash: ledger.objectiveHash });
  for (let index = 0; index < count; index += 1) {
    const event = ledger.events[index];
    if (event === undefined) return null;
    prefix = appendAgentEvent(prefix, eventDraft(event));
  }
  return prefix;
}

function matchingEvents(
  ledger: AgentEventLedger,
  actor: AgentEvent["actor"],
  action: string
): AgentEvent[] {
  return ledger.events.filter((event) => event.actor === actor && event.action === action);
}

function contains(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function exactFiles(left: readonly string[], right: readonly string[]): boolean {
  return canonicalEqual(sortedUnique(left), sortedUnique(right));
}

function blockingRouterRules(assessment: RiskBasedApprovalAssessment): boolean {
  return assessment.ruleResults.some((rule) => rule.triggered && rule.effect !== "none");
}

function artifactHashMaterial(
  artifact: Omit<GovernedChangeArtifact, "governedArtifactHash">
): Omit<GovernedChangeArtifact, "governedArtifactHash"> {
  return artifact;
}

export function buildGovernedChangeArtifact(
  input: GovernedChangeArtifactInput
): GovernedChangeArtifactResult {
  const summary = initialSummary();
  const issues: GovernedChangeArtifactIssue[] = [];
  const fail = (
    code: string,
    message: string,
    context: Omit<GovernedChangeArtifactIssue, "code" | "message" | "severity"> = {}
  ): GovernedChangeArtifactResult => {
    issues.push({ code, message, severity: "error", ...context });
    return finishArtifact("governed_change_artifact_invalid", issues, null, summary);
  };

  try {
    const top = exactObject(input, INPUT_FIELDS, "Governed change artifact input");
    const anchors = normalizeAnchors(safeClone(top.finalLedgerAnchors));
    const change = normalizeChange(safeClone(top.change));
    summary.changedFileCount = change.changedFiles.length;
    const trace = safeClone(top.preShadowTrace) as RunAccountabilityTrace;
    const suppliedObservation = safeClone(top.shadowObservation) as ShadowObservation | null;
    const suppliedGovernance = safeClone(top.governanceAssessment) as DeterministicGovernanceAssessment;
    const suppliedInvocation = safeClone(
      top.adminInvocationAssessment
    ) as AdminInvocationAssessment;
    const suppliedAdmin = safeClone(top.adminDecision) as ValidatedAdminDecision | null;
    const suppliedRouter = safeClone(top.approvalRouterAssessment) as RiskBasedApprovalAssessment;
    summary.shadowObservationProvided = suppliedObservation !== null;
    summary.adminDecisionProvided = suppliedAdmin !== null;

    const ledgerResult = verifyAgentEventLedger(top.finalLedger, {
      expectedRunId: anchors.expectedRunId,
      expectedObjectiveHash: anchors.expectedObjectiveHash,
      expectedRootHash: anchors.expectedRootHash,
      expectedEventCount: anchors.expectedEventCount
    });
    summary.finalLedgerAnchored = ledgerResult.summary.externallyAnchored &&
      ledgerResult.summary.externalAnchorsMatched;
    summary.finalLedgerValid = ledgerResult.decision === "ledger_valid" &&
      ledgerResult.verifiedLedger !== null;
    summary.finalLedgerEventCount = ledgerResult.summary.actualEventCount;
    summary.finalLedgerRootHash = ledgerResult.verifiedLedger?.rootHash ?? null;
    if (ledgerResult.decision === "ledger_needs_review") {
      issues.push({
        code: "governed_change_final_ledger_needs_review",
        message: "The final ledger requires bounded deterministic review.",
        severity: "review"
      });
      return finishArtifact("governed_change_artifact_needs_review", issues, null, summary);
    }
    if (!summary.finalLedgerValid || ledgerResult.verifiedLedger === null) {
      const anchorMismatch = !ledgerResult.summary.externalAnchorsMatched;
      return fail(
        anchorMismatch
          ? "governed_change_final_ledger_anchor_mismatch"
          : "governed_change_final_ledger_invalid",
        anchorMismatch
          ? "The final ledger does not match every trusted external anchor."
          : "The final ledger is invalid."
      );
    }
    const ledger = ledgerResult.verifiedLedger;

    if (
      trace.runId !== ledger.runId ||
      trace.objectiveHash !== ledger.objectiveHash ||
      !Number.isSafeInteger(trace.ledgerEventCount) ||
      trace.ledgerEventCount < 0 ||
      trace.ledgerEventCount > ledger.eventCount
    ) {
      return fail(
        "governed_change_pre_shadow_prefix_mismatch",
        "The pre-Shadow trace does not identify a valid final-ledger prefix."
      );
    }
    const prefix = reconstructPrefix(ledger, trace.ledgerEventCount);
    const prefixLast = trace.ledgerEventCount === 0
      ? null
      : ledger.events[trace.ledgerEventCount - 1] ?? null;
    if (
      prefix === null ||
      prefix.eventCount !== trace.ledgerEventCount ||
      prefix.rootHash !== trace.ledgerRootHash ||
      (prefixLast !== null && prefixLast.eventHash !== trace.ledgerRootHash)
    ) {
      return fail(
        "governed_change_pre_shadow_prefix_mismatch",
        "The pre-Shadow ledger prefix could not be reconstructed exactly."
      );
    }
    summary.preShadowPrefixVerified = true;

    const traceRecord = exactObject(trace, [
      "traceVersion", "runId", "objectiveHash", "ledgerRootHash", "ledgerEventCount",
      "externallyAnchored", "externalAnchorsMatched", "rolesCalled", "roleActivity",
      "events", "files", "decisions", "repairActivity", "resources", "findings",
      "phaseVExecutionObserved", "phaseVExecutionCompleted", "traceHash"
    ], "Pre-Shadow trace");
    if (
      typeof trace.traceHash !== "string" ||
      hashCanonicalJson(withoutField(traceRecord, "traceHash")) !== trace.traceHash ||
      trace.ledgerRootHash !== prefix.rootHash ||
      trace.ledgerEventCount !== prefix.eventCount
    ) {
      return fail(
        "governed_change_trace_integrity_mismatch",
        "The pre-Shadow trace integrity check failed."
      );
    }
    summary.preShadowTraceIntegrityVerified = true;

    let observation: ShadowObservation | null = null;
    if (suppliedObservation !== null) {
      const observationRecord = exactObject(suppliedObservation, [
        "observationVersion", "runId", "traceHash", "riskLevel", "riskScore",
        "confidenceScore", "findings", "observedScopeDrift",
        "observedPlanPatchMismatch", "observedRepairLoop",
        "observedSuspiciousRoleBehavior", "observedEvidenceConflict",
        "recommendation", "rationaleCodes", "observationHash"
      ], "Shadow observation");
      const shadowResult = validateShadowObservation(
        trace,
        withoutField(observationRecord, "observationHash")
      );
      if (
        shadowResult.decision !== "shadow_observation_valid" ||
        shadowResult.observation === null
      ) {
        return fail(
          "governed_change_shadow_verification_failed",
          "The Shadow observation could not be independently validated."
        );
      }
      if (!canonicalEqual(shadowResult.observation, suppliedObservation)) {
        return fail(
          "governed_change_shadow_binding_mismatch",
          "The Shadow observation does not match its independently validated form."
        );
      }
      observation = shadowResult.observation;
      summary.shadowObservationVerified = true;
    }
    if (suppliedRouter.observationHash !== (observation?.observationHash ?? null)) {
      return fail(
        "governed_change_shadow_binding_mismatch",
        "The router assessment expects different Shadow evidence."
      );
    }

    const governanceResult = evaluateDeterministicGovernance(
      trace,
      observation,
      suppliedGovernance.policy
    );
    if (governanceResult.assessment === null) {
      return fail(
        "governed_change_governance_reproduction_failed",
        "The governance assessment could not be reproduced."
      );
    }
    const governance = governanceResult.assessment;
    if (!canonicalEqual(governance, suppliedGovernance)) {
      return fail(
        "governed_change_governance_binding_mismatch",
        "The governance assessment differs from its deterministic reproduction."
      );
    }
    summary.governanceVerified = true;

    const invocationResult = evaluateAdminInvocationPolicy({
      phaseVFinalDecision: suppliedRouter.phaseVFinalDecision,
      trace,
      shadow: {
        stageDecision: suppliedRouter.shadowStageDecision,
        validationDecision: suppliedRouter.shadowValidationDecision,
        observation
      },
      governance
    }, suppliedInvocation.policy);
    if (invocationResult.decision !== "admin_invocation_policy_valid" ||
        invocationResult.assessment === null ||
        !canonicalEqual(invocationResult.assessment, suppliedInvocation)) {
      return fail(
        "governed_change_admin_invocation_binding_mismatch",
        "The Admin invocation assessment differs from its deterministic reproduction."
      );
    }
    const invocation = invocationResult.assessment;
    summary.adminInvocationVerified = true;

    let admin: ValidatedAdminDecision | null = null;
    if (suppliedAdmin !== null) {
      const adminRecord = exactObject(suppliedAdmin, [
        "decisionVersion", "runId", "traceHash", "observationHash", "governanceHash",
        "governanceDecision", "decision", "riskLevel", "riskScore", "confidenceScore",
        "findings", "rationaleCodes", "adminDecisionHash"
      ], "Admin decision");
      const adminDraft = withoutField(
        withoutField(adminRecord, "adminDecisionHash"),
        "governanceDecision"
      );
      const adminResult = validateAdminDecision(trace, observation, governance, adminDraft);
      if (adminResult.decision !== "admin_decision_valid" || adminResult.adminDecision === null) {
        return fail(
          "governed_change_admin_reproduction_failed",
          "The Admin decision could not be independently validated."
        );
      }
      if (!canonicalEqual(adminResult.adminDecision, suppliedAdmin)) {
        return fail(
          "governed_change_admin_binding_mismatch",
          "The Admin decision differs from its independently validated form."
        );
      }
      admin = adminResult.adminDecision;
      summary.adminDecisionVerified = true;
    }
    if (suppliedRouter.adminDecisionHash !== (admin?.adminDecisionHash ?? null)) {
      return fail(
        "governed_change_admin_binding_mismatch",
        "The router assessment expects different Admin evidence."
      );
    }

    const routerResult = evaluateRiskBasedApprovalRoute({
      phaseVFinalDecision: suppliedRouter.phaseVFinalDecision,
      trace,
      shadow: {
        stageDecision: suppliedRouter.shadowStageDecision,
        validationDecision: suppliedRouter.shadowValidationDecision,
        observation
      },
      governance,
      admin: {
        invocation,
        stageDecision: suppliedRouter.adminStageDecision,
        validationDecision: suppliedRouter.adminValidationDecision,
        decision: admin
      }
    }, suppliedRouter.policy);
    if (routerResult.decision !== "approval_route_valid" || routerResult.assessment === null) {
      return fail(
        "governed_change_router_reproduction_failed",
        "The approval-router assessment could not be reproduced."
      );
    }
    const router = routerResult.assessment;
    if (!canonicalEqual(router, suppliedRouter)) {
      return fail(
        "governed_change_router_assessment_mismatch",
        "The approval-router assessment differs from its deterministic reproduction."
      );
    }
    summary.routerAssessmentVerified = true;

    const sourceActor = change.changeKind === "coder_patch_draft" ? "coder" : "repairer";
    const sourceAction = change.changeKind === "coder_patch_draft"
      ? "coder.patch_draft"
      : "repairer.repair_draft";
    const sourceCandidates = matchingEvents(ledger, sourceActor, sourceAction)
      .filter((event) => contains(event.outputArtifactHashes, change.mutationHash));
    if (sourceCandidates.length === 0) {
      const actorEvents = matchingEvents(ledger, sourceActor, sourceAction);
      return fail(
        actorEvents.length > 0
          ? "governed_change_mutation_hash_mismatch"
          : "governed_change_mutation_source_missing",
        "The mutation source event does not bind the supplied mutation hash."
      );
    }
    if (sourceCandidates.length !== 1) {
      return fail(
        "governed_change_mutation_source_ambiguous",
        "More than one mutation source event binds the supplied mutation hash."
      );
    }
    const sourceEvent = sourceCandidates[0]!;
    summary.mutationSourceVerified = true;

    const patchEvents = matchingEvents(ledger, "patch_dry_run", "patch_dry_run.evaluate");
    if (
      patchEvents.length !== 1 ||
      !contains(patchEvents[0]!.inputArtifactHashes, change.mutationHash) ||
      !contains(patchEvents[0]!.outputArtifactHashes, change.patchDryRunResultHash)
    ) {
      return fail(
        "governed_change_patch_dry_run_chain_mismatch",
        "The patch dry-run event does not bind the governed mutation chain."
      );
    }
    const patchEvent = patchEvents[0]!;
    summary.patchDryRunChainVerified = true;

    const applyEvents = matchingEvents(ledger, "temp_workspace_apply", "temp_workspace_apply.apply");
    if (
      applyEvents.length !== 1 ||
      !contains(applyEvents[0]!.inputArtifactHashes, change.patchDryRunResultHash) ||
      !contains(applyEvents[0]!.outputArtifactHashes, change.temporaryApplyResultHash)
    ) {
      return fail(
        "governed_change_temporary_apply_chain_mismatch",
        "The temporary-apply event does not bind the governed mutation chain."
      );
    }
    const applyEvent = applyEvents[0]!;
    summary.temporaryApplyChainVerified = true;

    const executionEvents = matchingEvents(
      ledger,
      "execution_verifier",
      "execution_verifier.validate"
    );
    if (
      executionEvents.length !== 1 ||
      !contains(executionEvents[0]!.inputArtifactHashes, change.temporaryApplyResultHash) ||
      !contains(
        executionEvents[0]!.outputArtifactHashes,
        change.executionVerificationResultHash
      ) ||
      executionEvents[0]!.decision !== router.phaseVFinalDecision
    ) {
      return fail(
        "governed_change_execution_chain_mismatch",
        "The execution-verifier event does not bind the governed mutation chain."
      );
    }
    const executionEvent = executionEvents[0]!;
    summary.executionVerificationChainVerified = true;

    if (!(
      sourceEvent.sequence < patchEvent.sequence &&
      patchEvent.sequence < applyEvent.sequence &&
      applyEvent.sequence < executionEvent.sequence
    )) {
      return fail(
        "governed_change_stage_sequence_mismatch",
        "Governed mutation stages are not in strict ledger order."
      );
    }

    summary.changedFilesMatchedMutation = exactFiles(change.changedFiles, sourceEvent.filesProposed);
    if (!summary.changedFilesMatchedMutation) {
      return fail(
        "governed_change_mutation_file_mismatch",
        "Changed files do not match the mutation source event."
      );
    }
    summary.changedFilesMatchedTemporaryApply = exactFiles(
      change.changedFiles,
      applyEvent.filesProposed
    );
    if (!summary.changedFilesMatchedTemporaryApply) {
      return fail(
        "governed_change_temporary_apply_file_mismatch",
        "Changed files do not match the temporary-apply event."
      );
    }
    summary.changedFilesMatchedTrace = exactFiles(
      change.changedFiles,
      trace.files.temporaryAppliedFiles
    ) && change.changedFiles.every((file) => trace.files.allProposedFiles.includes(file));
    if (!summary.changedFilesMatchedTrace) {
      return fail(
        "governed_change_trace_file_mismatch",
        "Changed files do not match the pre-Shadow trace."
      );
    }

    summary.cleanupSuccessObserved = executionEvent.reasonCodes.includes(
      "temp_workspace_cleanup_performed"
    );
    summary.cleanupFailureObserved = executionEvent.reasonCodes.includes(
      "temp_workspace_cleanup_failed"
    );
    if (summary.cleanupSuccessObserved && summary.cleanupFailureObserved) {
      return fail(
        "governed_change_conflicting_cleanup_evidence",
        "Execution cleanup evidence is internally contradictory.",
        { eventId: executionEvent.eventId }
      );
    }

    const shadowEvents = matchingEvents(ledger, "shadow_observer", "shadow_observer.observe");
    let shadowEvent: AgentEvent | null = null;
    if (observation !== null) {
      const candidates = shadowEvents.filter((event) =>
        contains(event.inputArtifactHashes, trace.traceHash) &&
        contains(event.outputArtifactHashes, observation!.observationHash)
      );
      if (shadowEvents.length !== 1 || candidates.length !== 1) {
        return fail(
          "governed_change_shadow_event_binding_mismatch",
          "The Shadow ledger event does not bind the validated observation."
        );
      }
      shadowEvent = candidates[0]!;
    } else {
      if (
        shadowEvents.length > 1 ||
        (shadowEvents[0] !== undefined &&
          !contains(shadowEvents[0].inputArtifactHashes, trace.traceHash))
      ) {
        return fail(
          "governed_change_shadow_event_binding_mismatch",
          "A null Shadow stage has ambiguous observation events."
        );
      }
      shadowEvent = shadowEvents[0] ?? null;
    }

    const allGovernorEvents = matchingEvents(
      ledger,
      "deterministic_governor",
      "deterministic_governor.evaluate"
    );
    const governorEvents = allGovernorEvents.filter((event) =>
      contains(event.inputArtifactHashes, trace.traceHash) &&
      contains(event.inputArtifactHashes, governance.policyHash) &&
      (observation === null || contains(event.inputArtifactHashes, observation.observationHash)) &&
      contains(event.outputArtifactHashes, governance.governanceHash) &&
      event.decision === governance.decision
    );
    if (allGovernorEvents.length !== 1 || governorEvents.length !== 1) {
      return fail(
        "governed_change_governor_event_binding_mismatch",
        "The deterministic-governor ledger event is not bound exactly."
      );
    }
    const governorEvent = governorEvents[0]!;

    const invocationEvents = matchingEvents(
      ledger,
      "admin_invocation_policy",
      "admin_invocation_policy.evaluate"
    );
    const expectedInvocationInputs = sortedUnique([
      trace.traceHash,
      governance.governanceHash,
      invocation.policyHash,
      ...(observation === null ? [] : [observation.observationHash])
    ]);
    const matchingInvocationEvents = invocationEvents.filter((event) =>
      canonicalEqual(event.inputArtifactHashes, expectedInvocationInputs) &&
      canonicalEqual(event.outputArtifactHashes, [invocation.assessmentHash]) &&
      event.decision === invocation.decision &&
      canonicalEqual(event.reasonCodes, invocation.reasonCodes)
    );
    if (invocationEvents.length !== 1 || matchingInvocationEvents.length !== 1) {
      return fail(
        "governed_change_admin_invocation_event_binding_mismatch",
        "The Admin invocation-policy ledger event is not bound exactly."
      );
    }
    const invocationEvent = matchingInvocationEvents[0]!;

    const adminEvents = matchingEvents(ledger, "admin_agent", "admin_agent.evaluate");
    let adminEvent: AgentEvent | null = null;
    if (admin !== null) {
      const candidates = adminEvents.filter((event) =>
        contains(event.inputArtifactHashes, trace.traceHash) &&
        contains(event.inputArtifactHashes, governance.governanceHash) &&
        (observation === null || contains(event.inputArtifactHashes, observation.observationHash)) &&
        contains(event.outputArtifactHashes, admin!.adminDecisionHash) &&
        event.decision === admin!.decision
      );
      if (adminEvents.length !== 1 || candidates.length !== 1) {
        return fail(
          "governed_change_admin_event_binding_mismatch",
          "The Admin ledger event does not bind the validated decision."
        );
      }
      adminEvent = candidates[0]!;
    } else {
      if (invocation.decision === "admin_invocation_skipped" && adminEvents.length !== 0) {
        return fail(
          "governed_change_admin_event_binding_mismatch",
          "A policy-skipped Admin stage cannot have an Admin-agent event."
        );
      }
      if (invocation.decision === "admin_invocation_required" && (
        adminEvents.length > 1 ||
        (adminEvents[0] !== undefined && (
          !contains(adminEvents[0].inputArtifactHashes, trace.traceHash) ||
          !contains(adminEvents[0].inputArtifactHashes, governance.governanceHash) ||
          (observation !== null && !contains(
            adminEvents[0].inputArtifactHashes,
            observation.observationHash
          ))
        ))
      )) {
        return fail(
          "governed_change_admin_event_binding_mismatch",
          "A required but unresolved Admin stage has ambiguous decision events."
        );
      }
      adminEvent = adminEvents[0] ?? null;
    }

    const routerEvents = matchingEvents(ledger, "approval_router", "approval_router.evaluate");
    if (routerEvents.length !== 1) {
      return fail(
        "governed_change_router_event_binding_mismatch",
        "The approval-router ledger event is missing or ambiguous."
      );
    }
    const routerEvent = routerEvents[0]!;
    if (ledger.events[ledger.events.length - 1]?.eventId !== routerEvent.eventId) {
      return fail(
        "governed_change_router_event_not_final",
        "The approval-router event is not the final ledger event."
      );
    }
    if (
      !contains(routerEvent.inputArtifactHashes, trace.traceHash) ||
      !contains(routerEvent.inputArtifactHashes, governance.governanceHash) ||
      !contains(routerEvent.inputArtifactHashes, invocation.assessmentHash) ||
      !contains(routerEvent.inputArtifactHashes, invocation.policyHash) ||
      !contains(routerEvent.inputArtifactHashes, router.policyHash) ||
      (observation !== null && !contains(
        routerEvent.inputArtifactHashes,
        observation.observationHash
      )) ||
      (admin !== null && !contains(routerEvent.inputArtifactHashes, admin.adminDecisionHash)) ||
      !contains(routerEvent.outputArtifactHashes, router.routeHash) ||
      routerEvent.decision !== router.route
    ) {
      return fail(
        "governed_change_router_event_binding_mismatch",
        "The final approval-router ledger event is not bound exactly."
      );
    }
    if (ledger.rootHash !== routerEvent.eventHash) {
      return fail(
        "governed_change_final_root_mismatch",
        "The final ledger root does not equal the approval-router event hash."
      );
    }

    const auditLowerBound = shadowEvent?.sequence ?? executionEvent.sequence;
    if (
      executionEvent.sequence >= auditLowerBound && shadowEvent !== null ||
      governorEvent.sequence <= auditLowerBound ||
      invocationEvent.sequence <= governorEvent.sequence ||
      (adminEvent !== null && adminEvent.sequence <= invocationEvent.sequence) ||
      routerEvent.sequence <= (adminEvent?.sequence ?? invocationEvent.sequence)
    ) {
      return fail(
        "governed_change_stage_sequence_mismatch",
        "Governance audit stages are not in strict ledger order."
      );
    }

    const eligibilityReasons: string[] = [];
    if (router.phaseVFinalDecision !== "temp_validation_passed") {
      eligibilityReasons.push("governed_change_phase_v_not_passed");
    }
    if (router.shadowStageDecision !== "shadow_observer_completed") {
      eligibilityReasons.push("governed_change_shadow_not_completed");
    }
    if (router.shadowValidationDecision !== "shadow_observation_valid") {
      eligibilityReasons.push("governed_change_shadow_validation_not_valid");
    }
    if (observation === null) {
      eligibilityReasons.push("governed_change_shadow_observation_missing");
    }
    if (governance.decision !== "governance_passed") {
      eligibilityReasons.push("governed_change_governance_not_passed");
    }
    if (governance.triggeredRuleIds.length > 0) {
      eligibilityReasons.push("governed_change_governance_has_triggered_rules");
    }
    if (governance.issues.length > 0) {
      eligibilityReasons.push("governed_change_governance_has_issues");
    }
    const verifiedPolicySkip = router.adminStageDecision === "admin_skipped_by_policy" &&
      invocation.decision === "admin_invocation_skipped" &&
      invocation.autoContinueWithoutAdminEligible &&
      router.adminResolutionKind === "verified_policy_skip" &&
      router.adminValidationDecision === null && admin === null;
    const modelResolution = router.adminStageDecision === "admin_agent_completed" &&
      invocation.decision === "admin_invocation_required" &&
      router.adminResolutionKind === "model_decision" &&
      router.adminValidationDecision === "admin_decision_valid" && admin !== null;
    if (!verifiedPolicySkip && !modelResolution) {
      eligibilityReasons.push("governed_change_admin_resolution_invalid");
    }
    if (admin !== null) {
      if (admin.decision !== "admin_auto_approved") {
        eligibilityReasons.push("governed_change_admin_not_auto_approved");
      }
      if (admin.riskLevel !== "low" || admin.riskScore < 0 || admin.riskScore > 24) {
        eligibilityReasons.push("governed_change_admin_risk_not_low");
      }
    } else if (!verifiedPolicySkip) {
      eligibilityReasons.push("governed_change_admin_decision_missing");
    }
    if (router.route !== "auto_continue") {
      eligibilityReasons.push("governed_change_route_not_auto_continue");
    }
    if (blockingRouterRules(router)) {
      eligibilityReasons.push("governed_change_router_has_blocking_rules");
    }
    if (router.riskClass !== "low") {
      eligibilityReasons.push("governed_change_router_risk_not_low");
    }
    if (executionEvent.decision !== "temp_validation_passed") {
      eligibilityReasons.push("governed_change_execution_decision_not_passed");
    }
    if (!summary.cleanupSuccessObserved) {
      eligibilityReasons.push("governed_change_cleanup_success_missing");
    }
    if (summary.cleanupFailureObserved) {
      eligibilityReasons.push("governed_change_cleanup_failure_observed");
    }
    const reasonCodes = sortedUnique(eligibilityReasons);
    const eligible = reasonCodes.length === 0;

    const stageEvents: GovernedChangeStageEventBindings = {
      mutationSourceEventId: sourceEvent.eventId,
      patchDryRunEventId: patchEvent.eventId,
      temporaryApplyEventId: applyEvent.eventId,
      executionVerifierEventId: executionEvent.eventId,
      shadowObserverEventId: shadowEvent?.eventId ?? null,
      deterministicGovernorEventId: governorEvent.eventId,
      adminInvocationPolicyEventId: invocationEvent.eventId,
      adminAgentEventId: adminEvent?.eventId ?? null,
      approvalRouterEventId: routerEvent.eventId
    };
    const artifactWithoutHash: Omit<GovernedChangeArtifact, "governedArtifactHash"> = {
      artifactVersion: GOVERNED_CHANGE_ARTIFACT_VERSION,
      change: { ...change, stageEvents },
      evidence: {
        runId: ledger.runId,
        objectiveHash: ledger.objectiveHash,
        preShadowLedgerRootHash: trace.ledgerRootHash,
        preShadowLedgerEventCount: trace.ledgerEventCount,
        preShadowTraceHash: trace.traceHash,
        observationHash: observation?.observationHash ?? null,
        governanceHash: governance.governanceHash,
        adminInvocationPolicyHash: invocation.policyHash,
        adminInvocationAssessmentHash: invocation.assessmentHash,
        adminDecisionHash: admin?.adminDecisionHash ?? null,
        routeHash: router.routeHash,
        governancePolicyHash: governance.policyHash,
        routerPolicyHash: router.policyHash,
        finalLedgerRootHash: ledger.rootHash,
        finalLedgerEventCount: ledger.eventCount
      },
      decisions: {
        phaseVFinalDecision: router.phaseVFinalDecision,
        shadowStageDecision: router.shadowStageDecision,
        shadowValidationDecision: router.shadowValidationDecision,
        governanceDecision: governance.decision,
        adminInvocationMode: invocation.policy.mode,
        adminInvocationDecision: invocation.decision,
        adminInvocationSkipKind: invocation.skipKind,
        adminResolutionKind: router.adminResolutionKind,
        adminStageDecision: router.adminStageDecision,
        adminValidationDecision: router.adminValidationDecision,
        adminDecision: admin?.decision ?? null,
        routerValidationDecision: "approval_route_valid",
        workflowRoute: router.route
      },
      applyEligibility: { eligible, reasonCodes }
    };
    let governedArtifactHash: string;
    try {
      governedArtifactHash = hashCanonicalJson(artifactHashMaterial(artifactWithoutHash));
    } catch {
      return fail(
        "governed_change_artifact_hash_failure",
        "The governed artifact hash could not be computed."
      );
    }
    const artifact: GovernedChangeArtifact = {
      ...artifactWithoutHash,
      governedArtifactHash
    };
    summary.artifactBuilt = true;
    summary.applyEligible = eligible;
    summary.governedArtifactHashValid = HASH.test(governedArtifactHash) &&
      hashCanonicalJson(artifactWithoutHash) === governedArtifactHash;
    return finishArtifact(
      eligible ? "governed_change_artifact_ready" : "governed_change_artifact_blocked",
      issues,
      artifact,
      summary
    );
  } catch (error) {
    const issue = issueFromError(error);
    issues.push(issue);
    const decision = issue.severity === "review"
      ? "governed_change_artifact_needs_review"
      : "governed_change_artifact_invalid";
    return finishArtifact(decision, issues, null, summary);
  }
}

const STALE_REASON_BY_FIELD: Readonly<Record<keyof GovernedChangeFreshnessSnapshot, string>> = {
  runId: "governed_change_run_changed",
  objectiveHash: "governed_change_objective_changed",
  mutationHash: "governed_change_mutation_changed",
  changedFiles: "governed_change_changed_files_changed",
  patchDryRunResultHash: "governed_change_patch_dry_run_changed",
  temporaryApplyResultHash: "governed_change_temporary_apply_changed",
  executionVerificationResultHash: "governed_change_execution_verification_changed",
  preShadowTraceHash: "governed_change_trace_changed",
  observationHash: "governed_change_observation_changed",
  governanceHash: "governed_change_governance_changed",
  adminInvocationPolicyHash: "governed_change_admin_invocation_policy_changed",
  adminInvocationAssessmentHash: "governed_change_admin_invocation_assessment_changed",
  adminDecisionHash: "governed_change_admin_decision_changed",
  routeHash: "governed_change_route_changed",
  governancePolicyHash: "governed_change_governance_policy_changed",
  routerPolicyHash: "governed_change_router_policy_changed",
  finalLedgerRootHash: "governed_change_final_ledger_root_changed",
  finalLedgerEventCount: "governed_change_final_ledger_count_changed",
  phaseVFinalDecision: "governed_change_phase_v_decision_changed",
  workflowRoute: "governed_change_workflow_route_changed"
};

function normalizeFreshness(value: unknown): GovernedChangeFreshnessSnapshot {
  const record = exactObject(value, FRESHNESS_FIELDS, "Governed change freshness snapshot");
  const nullableHash = (field: "observationHash" | "adminDecisionHash"): string | null =>
    record[field] === null ? null : requireHash(record[field], field);
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    throw new SafeInputError("governed_change_current_snapshot_invalid", "The current run ID is invalid.");
  }
  if (!Number.isSafeInteger(record.finalLedgerEventCount) || (record.finalLedgerEventCount as number) < 0) {
    throw new SafeInputError("governed_change_current_snapshot_invalid", "The current ledger count is invalid.");
  }
  if (!PHASE_DECISIONS.has(record.phaseVFinalDecision as PhaseVTerminalDecision)) {
    throw new SafeInputError("governed_change_current_snapshot_invalid", "The current Phase V decision is invalid.");
  }
  if (!ROUTES.has(record.workflowRoute as ApprovalWorkflowRoute)) {
    throw new SafeInputError("governed_change_current_snapshot_invalid", "The current workflow route is invalid.");
  }
  return {
    runId: record.runId,
    objectiveHash: requireHash(record.objectiveHash, "objectiveHash"),
    mutationHash: requireHash(record.mutationHash, "mutationHash"),
    changedFiles: normalizeFiles(record.changedFiles),
    patchDryRunResultHash: requireHash(record.patchDryRunResultHash, "patchDryRunResultHash"),
    temporaryApplyResultHash: requireHash(record.temporaryApplyResultHash, "temporaryApplyResultHash"),
    executionVerificationResultHash: requireHash(
      record.executionVerificationResultHash,
      "executionVerificationResultHash"
    ),
    preShadowTraceHash: requireHash(record.preShadowTraceHash, "preShadowTraceHash"),
    observationHash: nullableHash("observationHash"),
    governanceHash: requireHash(record.governanceHash, "governanceHash"),
    adminInvocationPolicyHash: requireHash(
      record.adminInvocationPolicyHash,
      "adminInvocationPolicyHash"
    ),
    adminInvocationAssessmentHash: requireHash(
      record.adminInvocationAssessmentHash,
      "adminInvocationAssessmentHash"
    ),
    adminDecisionHash: nullableHash("adminDecisionHash"),
    routeHash: requireHash(record.routeHash, "routeHash"),
    governancePolicyHash: requireHash(record.governancePolicyHash, "governancePolicyHash"),
    routerPolicyHash: requireHash(record.routerPolicyHash, "routerPolicyHash"),
    finalLedgerRootHash: requireHash(record.finalLedgerRootHash, "finalLedgerRootHash"),
    finalLedgerEventCount: record.finalLedgerEventCount as number,
    phaseVFinalDecision: record.phaseVFinalDecision as PhaseVTerminalDecision,
    workflowRoute: record.workflowRoute as ApprovalWorkflowRoute
  };
}

function inspectArtifact(value: unknown): GovernedChangeArtifact {
  const cloned = safeClone(value);
  const record = exactObject(cloned, ARTIFACT_FIELDS, "Governed change artifact");
  const chain = exactObject(record.change, CHAIN_FIELDS, "Governed change chain");
  const normalizedChange = normalizeChange(Object.fromEntries(
    CHANGE_FIELDS.map((field) => [field, chain[field]])
  ));
  for (const field of CHANGE_FIELDS) {
    if (!canonicalEqual(normalizedChange[field], chain[field])) {
      throw new SafeInputError(
        "invalid_governed_change_binding",
        "The governed change chain is not in canonical form.",
        { field }
      );
    }
  }
  const stageEvents = exactObject(chain.stageEvents, STAGE_EVENT_FIELDS, "Governed stage events");
  for (const field of STAGE_EVENT_FIELDS) {
    const valueAtField = stageEvents[field];
    const nullable = field === "shadowObserverEventId" || field === "adminAgentEventId";
    if ((nullable && valueAtField === null) ||
        (typeof valueAtField === "string" && valueAtField.length > 0)) continue;
    throw new SafeInputError("invalid_governed_change_object", "A governed stage event ID is invalid.", { field });
  }
  const evidence = exactObject(record.evidence, EVIDENCE_FIELDS, "Governed evidence bindings");
  const decisions = exactObject(record.decisions, DECISION_FIELDS, "Governed decision snapshot");
  const eligibility = exactObject(record.applyEligibility, ELIGIBILITY_FIELDS, "Governed apply eligibility");
  if (record.artifactVersion !== GOVERNED_CHANGE_ARTIFACT_VERSION) {
    throw new SafeInputError("invalid_governed_change_object", "The governed artifact version is unsupported.");
  }
  if (typeof eligibility.eligible !== "boolean" || !Array.isArray(eligibility.reasonCodes)) {
    throw new SafeInputError("invalid_governed_change_object", "The governed apply eligibility is invalid.");
  }
  const reasonCodes = normalizeFiles(eligibility.reasonCodes, "reasonCodes");
  if (!canonicalEqual(reasonCodes, eligibility.reasonCodes)) {
    throw new SafeInputError("invalid_governed_change_object", "Eligibility reason codes are not canonical.");
  }
  for (const field of [
    "objectiveHash", "preShadowLedgerRootHash", "preShadowTraceHash", "governanceHash",
    "adminInvocationPolicyHash", "adminInvocationAssessmentHash", "routeHash",
    "governancePolicyHash", "routerPolicyHash", "finalLedgerRootHash"
  ]) requireHash(evidence[field], field);
  if (evidence.observationHash !== null) requireHash(evidence.observationHash, "observationHash");
  if (evidence.adminDecisionHash !== null) requireHash(evidence.adminDecisionHash, "adminDecisionHash");
  if (typeof evidence.runId !== "string" || evidence.runId.length === 0 ||
      !Number.isSafeInteger(evidence.preShadowLedgerEventCount) ||
      !Number.isSafeInteger(evidence.finalLedgerEventCount)) {
    throw new SafeInputError("invalid_governed_change_object", "Governed evidence counters are invalid.");
  }
  if (!PHASE_DECISIONS.has(decisions.phaseVFinalDecision as PhaseVTerminalDecision) ||
      !ROUTES.has(decisions.workflowRoute as ApprovalWorkflowRoute) ||
      decisions.routerValidationDecision !== "approval_route_valid") {
    throw new SafeInputError("invalid_governed_change_object", "Governed decisions are invalid.");
  }
  const invocationModeValid = decisions.adminInvocationMode === "disabled" ||
    decisions.adminInvocationMode === "conditional" || decisions.adminInvocationMode === "always";
  const invocationDecisionValid = decisions.adminInvocationDecision === "admin_invocation_required" ||
    decisions.adminInvocationDecision === "admin_invocation_skipped";
  const invocationSkipValid = decisions.adminInvocationSkipKind === null ||
    decisions.adminInvocationSkipKind === "clean_path" ||
    decisions.adminInvocationSkipKind === "disabled" ||
    decisions.adminInvocationSkipKind === "deterministic_hard_stop" ||
    decisions.adminInvocationSkipKind === "insufficient_semantic_evidence";
  const resolutionValid = decisions.adminResolutionKind === "model_decision" ||
    decisions.adminResolutionKind === "verified_policy_skip";
  const skipConsistent = decisions.adminResolutionKind !== "verified_policy_skip" ||
    (decisions.adminInvocationDecision === "admin_invocation_skipped" &&
      decisions.adminStageDecision === "admin_skipped_by_policy" &&
      decisions.adminValidationDecision === null && evidence.adminDecisionHash === null);
  const invocationConsistent = decisions.adminInvocationDecision === "admin_invocation_required"
    ? decisions.adminInvocationSkipKind === null &&
      decisions.adminResolutionKind === "model_decision" &&
      decisions.adminStageDecision !== "admin_skipped_by_policy"
    : decisions.adminInvocationSkipKind !== null &&
      decisions.adminResolutionKind === "verified_policy_skip" &&
      decisions.adminStageDecision === "admin_skipped_by_policy";
  const adminEvidenceConsistent = decisions.adminStageDecision === "admin_agent_completed"
    ? decisions.adminValidationDecision === "admin_decision_valid" &&
      decisions.adminDecision !== null && evidence.adminDecisionHash !== null
    : decisions.adminStageDecision === "admin_agent_needs_review"
      ? decisions.adminValidationDecision === "admin_decision_needs_review" &&
        ((decisions.adminDecision === null && evidence.adminDecisionHash === null) ||
          (decisions.adminDecision !== null && evidence.adminDecisionHash !== null))
      : decisions.adminDecision === null && evidence.adminDecisionHash === null;
  if (!invocationModeValid || !invocationDecisionValid || !invocationSkipValid ||
      !resolutionValid || !skipConsistent || !invocationConsistent ||
      !adminEvidenceConsistent) {
    throw new SafeInputError(
      "invalid_governed_change_object",
      "The governed Admin invocation decision snapshot is invalid."
    );
  }
  const governedArtifactHash = requireHash(
    record.governedArtifactHash,
    "governedArtifactHash"
  );
  return {
    artifactVersion: GOVERNED_CHANGE_ARTIFACT_VERSION,
    change: {
      ...normalizedChange,
      stageEvents: stageEvents as unknown as GovernedChangeStageEventBindings
    },
    evidence: evidence as unknown as GovernedChangeEvidenceBindings,
    decisions: decisions as unknown as GovernedChangeDecisionSnapshot,
    applyEligibility: { eligible: eligibility.eligible, reasonCodes },
    governedArtifactHash
  };
}

function expectedFreshness(artifact: GovernedChangeArtifact): GovernedChangeFreshnessSnapshot {
  return {
    runId: artifact.evidence.runId,
    objectiveHash: artifact.evidence.objectiveHash,
    mutationHash: artifact.change.mutationHash,
    changedFiles: [...artifact.change.changedFiles],
    patchDryRunResultHash: artifact.change.patchDryRunResultHash,
    temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
    executionVerificationResultHash: artifact.change.executionVerificationResultHash,
    preShadowTraceHash: artifact.evidence.preShadowTraceHash,
    observationHash: artifact.evidence.observationHash,
    governanceHash: artifact.evidence.governanceHash,
    adminInvocationPolicyHash: artifact.evidence.adminInvocationPolicyHash,
    adminInvocationAssessmentHash: artifact.evidence.adminInvocationAssessmentHash,
    adminDecisionHash: artifact.evidence.adminDecisionHash,
    routeHash: artifact.evidence.routeHash,
    governancePolicyHash: artifact.evidence.governancePolicyHash,
    routerPolicyHash: artifact.evidence.routerPolicyHash,
    finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
    finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
    phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
    workflowRoute: artifact.decisions.workflowRoute
  };
}

export function verifyGovernedChangeArtifactFreshness(
  artifact: GovernedChangeArtifact,
  current: GovernedChangeFreshnessSnapshot
): GovernedChangeFreshnessResult {
  const summary = initialFreshnessSummary();
  const invalid = (
    artifactIntegrityVerified: boolean,
    reasonCode: string
  ): GovernedChangeFreshnessResult => deepFreeze({
    decision: "governed_change_freshness_invalid",
    artifactIntegrityVerified,
    currentSnapshotHash: null,
    staleFields: [],
    reasonCodes: [reasonCode],
    handoffEligible: false,
    summary
  });
  let normalizedArtifact: GovernedChangeArtifact;
  try {
    normalizedArtifact = inspectArtifact(artifact);
    const { governedArtifactHash, ...material } = normalizedArtifact;
    if (hashCanonicalJson(material) !== governedArtifactHash) {
      return invalid(false, "governed_change_artifact_integrity_mismatch");
    }
  } catch {
    return invalid(false, "governed_change_artifact_integrity_mismatch");
  }
  summary.artifactApplyEligible = normalizedArtifact.applyEligibility.eligible;
  try {
    const normalizedCurrent = normalizeFreshness(safeClone(current));
    const currentSnapshotHash = hashCanonicalJson(normalizedCurrent);
    const expected = expectedFreshness(normalizedArtifact);
    const staleFields: string[] = [];
    for (const field of FRESHNESS_FIELDS) {
      const matched = canonicalEqual(expected[field], normalizedCurrent[field]);
      const summaryField: Record<typeof field, keyof FreshnessSummary> = {
        runId: "runMatched",
        objectiveHash: "objectiveMatched",
        mutationHash: "mutationMatched",
        changedFiles: "changedFilesMatched",
        patchDryRunResultHash: "patchDryRunMatched",
        temporaryApplyResultHash: "temporaryApplyMatched",
        executionVerificationResultHash: "executionVerificationMatched",
        preShadowTraceHash: "traceMatched",
        observationHash: "observationMatched",
        governanceHash: "governanceMatched",
        adminInvocationPolicyHash: "adminInvocationPolicyMatched",
        adminInvocationAssessmentHash: "adminInvocationAssessmentMatched",
        adminDecisionHash: "adminDecisionMatched",
        routeHash: "routeMatched",
        governancePolicyHash: "governancePolicyMatched",
        routerPolicyHash: "routerPolicyMatched",
        finalLedgerRootHash: "finalLedgerRootMatched",
        finalLedgerEventCount: "finalLedgerEventCountMatched",
        phaseVFinalDecision: "phaseVDecisionMatched",
        workflowRoute: "workflowRouteMatched"
      };
      summary[summaryField[field]] = matched;
      if (!matched) staleFields.push(field);
    }
    staleFields.sort();
    const reasonCodes = sortedUnique(staleFields.map((field) =>
      STALE_REASON_BY_FIELD[field as keyof GovernedChangeFreshnessSnapshot]
    ));
    summary.snapshotCurrent = staleFields.length === 0;
    const decision: GovernedChangeFreshnessDecision = summary.snapshotCurrent
      ? "governed_change_current"
      : "governed_change_stale";
    const handoffEligible = decision === "governed_change_current" &&
      normalizedArtifact.applyEligibility.eligible &&
      normalizedArtifact.decisions.workflowRoute === "auto_continue" &&
      normalizedArtifact.decisions.phaseVFinalDecision === "temp_validation_passed";
    return deepFreeze({
      decision,
      artifactIntegrityVerified: true,
      currentSnapshotHash,
      staleFields,
      reasonCodes,
      handoffEligible,
      summary
    });
  } catch {
    return invalid(true, "governed_change_current_snapshot_invalid");
  }
}
