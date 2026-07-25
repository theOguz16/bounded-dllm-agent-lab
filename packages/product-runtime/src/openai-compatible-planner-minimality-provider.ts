import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  createBoundedPlannerProposal,
  type BoundedPlannerProposal,
  type BoundedPlannerProposalLimits
} from "./bounded-planner-proposal-contract.js";
import type {
  PlannerMinimalityProviderContext,
  PlannerMinimalityProviderOutput
} from "./planner-minimality-integration.js";
import type {
  MinimalityAbstractionPlan,
  MinimalityDependencyPlan,
  MinimalityPlannedChangeKind,
  MinimalityPlannedFile,
  MinimalityRiskClass,
  PreventiveMinimalityRawPlan
} from "./preventive-minimality-contract.js";

export const OPENAI_COMPATIBLE_PLANNER_MINIMALITY_PROVIDER_VERSION = "1" as const;
export const OPENAI_COMPATIBLE_PLANNER_MINIMALITY_RUN_VERSION = "1" as const;

export type OpenAICompatiblePlannerMinimalityPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type OpenAICompatiblePlannerMinimalityProviderConfig = {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxAttempts?: 1 | 2;
  retryDelayMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  maxResponseBytes?: number;
  maxTaskContextBytes?: number;
  responseFormat?: "json_object" | "none";
  pricing?: OpenAICompatiblePlannerMinimalityPricing;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
};

export type OpenAICompatiblePlannerMinimalityFailureCode =
  | "planner_minimality_adapter_config_invalid"
  | "planner_minimality_adapter_task_context_invalid"
  | "planner_minimality_adapter_task_context_too_large"
  | "planner_minimality_adapter_network_error"
  | "planner_minimality_adapter_timeout"
  | "planner_minimality_adapter_http_retryable"
  | "planner_minimality_adapter_http_non_retryable"
  | "planner_minimality_adapter_response_too_large"
  | "planner_minimality_adapter_response_envelope_invalid"
  | "planner_minimality_adapter_response_content_invalid"
  | "planner_minimality_adapter_response_json_invalid"
  | "planner_minimality_adapter_draft_invalid"
  | "planner_minimality_adapter_output_invalid"
  | "planner_minimality_adapter_attempts_exhausted";

export type OpenAICompatiblePlannerMinimalityAttemptEvidence = {
  attempt: number;
  decision: "succeeded" | "failed";
  failureCode: OpenAICompatiblePlannerMinimalityFailureCode | null;
  retryable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  responseBytes: number | null;
  responseHash: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  proposalHash: string | null;
  minimalityDraftHash: string | null;
  outputHash: string | null;
  attemptHash: string;
};

export type OpenAICompatiblePlannerMinimalityRunEvidence = {
  runVersion: "1";
  evidenceClass: "observed_run";
  endpointIdentityHash: string;
  model: string;
  decision: "planner_minimality_provider_succeeded" | "planner_minimality_provider_failed";
  failureCode: OpenAICompatiblePlannerMinimalityFailureCode | null;
  attempts: readonly OpenAICompatiblePlannerMinimalityAttemptEvidence[];
  attemptCount: number;
  usageAvailableAttemptCount: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownTotalTokens: number;
  pricingSource: "operator_configured_rates" | "not_configured";
  knownCostUsd: number | null;
  proposalHash: string | null;
  minimalityDraftHash: string | null;
  outputHash: string | null;
  runHash: string;
};

export type OpenAICompatiblePlannerMinimalityProviderAdapter = {
  plannerMinimalityProvider: (
    context: PlannerMinimalityProviderContext
  ) => Promise<PlannerMinimalityProviderOutput>;
  invoke: (
    context: PlannerMinimalityProviderContext
  ) => Promise<{
    output: PlannerMinimalityProviderOutput;
    evidence: OpenAICompatiblePlannerMinimalityRunEvidence;
  }>;
  getLastRunEvidence: () => OpenAICompatiblePlannerMinimalityRunEvidence | null;
};

type ProposalDraft = {
  proposalVersion: "1";
  taskId: string;
  objectiveHash: string;
  acceptanceContractHash: string;
  authorityHash: string;
  policyHash: string;
  seedFiles: readonly string[];
  seedRationales: readonly { path: string; reason: string }[];
  requiredSymbols: readonly string[];
  requiredTestFiles: readonly string[];
  maxExpansionAttempts: 1 | 2;
};

type CombinedDraft = {
  proposal: ProposalDraft;
  minimalityPlan: PreventiveMinimalityRawPlan;
};

type ParsedProviderResponse = {
  content: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TASK_CONTEXT_BYTES = 250_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_PROMPT_DEPTH = 32;
const MAX_PROMPT_NODES = 50_000;
const CHANGE_KINDS = new Set<MinimalityPlannedChangeKind>([
  "bugfix", "config", "dependency", "docs", "feature", "refactor", "test"
]);
const RISK_CLASSES = new Set<MinimalityRiskClass>(["low", "medium", "high", "critical"]);

class PlannerMinimalityAdapterError extends Error {
  constructor(
    readonly code: OpenAICompatiblePlannerMinimalityFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requirePlainObject(
  value: unknown,
  label: string,
  code: OpenAICompatiblePlannerMinimalityFailureCode = "planner_minimality_adapter_draft_invalid",
  retryable = true
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlannerMinimalityAdapterError(code, `${label} must be a plain object.`, retryable);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PlannerMinimalityAdapterError(code, `${label} must be a plain object.`, retryable);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new PlannerMinimalityAdapterError(code, `${label} must not contain symbol properties.`, retryable);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new PlannerMinimalityAdapterError(code, `${label} must not contain accessors.`, retryable);
    }
  }
  return value as Record<string, unknown>;
}

function requireExactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid",
        `${label} contains an unknown field: ${key}.`,
        true
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid",
        `${label} is missing field: ${field}.`,
        true
      );
    }
  }
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || CONTROL_EXCEPT_NEWLINE_TAB.test(value)
  ) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} must be a bounded non-empty string.`,
      true
    );
  }
  return value;
}

function requireOptionalString(value: unknown, field: string, maximum = 4_000): string | null {
  if (value === null) return null;
  return requireString(value, field, maximum);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} must be boolean.`,
      true
    );
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} must be a sha256 hash.`,
      true
    );
  }
  return value;
}

function requireSafePath(value: unknown, field: string): string {
  const normalized = requireString(value, field, 4_096).replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") || WINDOWS_DRIVE.test(normalized) || normalized === "." ||
    normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")
  ) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} must be a safe repository-relative path.`,
      true
    );
  }
  return normalized;
}

function requireStringArray(
  value: unknown,
  field: string,
  maximum: number,
  mode: "path" | "text" | "package"
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} exceeds its bounded count.`,
      true
    );
  }
  const normalized = value.map((entry) => {
    if (mode === "path") return requireSafePath(entry, field);
    const item = requireString(entry, field, mode === "package" ? 214 : 512);
    if (mode === "package" && !PACKAGE_NAME.test(item.toLowerCase())) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid",
        `${field} contains an invalid package name.`,
        true
      );
    }
    return mode === "package" ? item.toLowerCase() : item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      `${field} must not contain duplicates.`,
      true
    );
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeProposal(value: unknown, context: PlannerMinimalityProviderContext): ProposalDraft {
  const record = requirePlainObject(value, "Combined proposal draft");
  requireExactFields(record, [
    "proposalVersion", "taskId", "objectiveHash", "acceptanceContractHash", "authorityHash",
    "policyHash", "seedFiles", "seedRationales", "requiredSymbols", "requiredTestFiles",
    "maxExpansionAttempts"
  ], "Combined proposal draft");
  if (record.proposalVersion !== "1") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "proposalVersion must be 1.", true
    );
  }
  const taskId = requireString(record.taskId, "proposal.taskId", 160);
  const objectiveHash = requireHash(record.objectiveHash, "proposal.objectiveHash");
  const acceptanceContractHash = requireHash(record.acceptanceContractHash, "proposal.acceptanceContractHash");
  const authorityHash = requireHash(record.authorityHash, "proposal.authorityHash");
  const policyHash = requireHash(record.policyHash, "proposal.policyHash");
  if (
    taskId !== context.taskId || objectiveHash !== context.objectiveHash ||
    acceptanceContractHash !== context.acceptanceContractHash || authorityHash !== context.authorityHash ||
    policyHash !== context.policyHash
  ) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      "Combined proposal identity fields must exactly match the request.",
      true
    );
  }
  const seedFiles = requireStringArray(record.seedFiles, "proposal.seedFiles", context.limits.maxSeedFiles, "path");
  if (seedFiles.length === 0) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "proposal.seedFiles must not be empty.", true
    );
  }
  if (!Array.isArray(record.seedRationales) || record.seedRationales.length !== seedFiles.length) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      "proposal.seedRationales must contain exactly one item per seed file.",
      true
    );
  }
  const seedRationales = record.seedRationales.map((entry, index) => {
    const rationale = requirePlainObject(entry, `proposal.seedRationales[${index}]`);
    requireExactFields(rationale, ["path", "reason"], `proposal.seedRationales[${index}]`);
    return {
      path: requireSafePath(rationale.path, `proposal.seedRationales[${index}].path`),
      reason: requireString(rationale.reason, `proposal.seedRationales[${index}].reason`, 2_000)
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (seedRationales.some((entry, index) => entry.path !== seedFiles[index])) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      "proposal.seedRationales paths must match proposal.seedFiles exactly.",
      true
    );
  }
  const maxExpansionAttempts = record.maxExpansionAttempts;
  if (
    (maxExpansionAttempts !== 1 && maxExpansionAttempts !== 2) ||
    maxExpansionAttempts > context.limits.maxExpansionAttempts
  ) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      "proposal.maxExpansionAttempts exceeds the permitted budget.",
      true
    );
  }
  return deepFreeze({
    proposalVersion: "1",
    taskId,
    objectiveHash,
    acceptanceContractHash,
    authorityHash,
    policyHash,
    seedFiles,
    seedRationales,
    requiredSymbols: requireStringArray(
      record.requiredSymbols, "proposal.requiredSymbols", context.limits.maxRequiredSymbols, "text"
    ),
    requiredTestFiles: requireStringArray(
      record.requiredTestFiles, "proposal.requiredTestFiles", context.limits.maxRequiredTests, "path"
    ),
    maxExpansionAttempts
  });
}

function normalizePlannedFiles(value: unknown, maximum: number): MinimalityPlannedFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid",
      "minimalityPlan.plannedFiles must contain between one and the policy limit entries.",
      true
    );
  }
  const normalized = value.map((entry, index) => {
    const record = requirePlainObject(entry, `minimalityPlan.plannedFiles[${index}]`);
    requireExactFields(record, ["path", "changeKind", "requested", "justification"], `minimalityPlan.plannedFiles[${index}]`);
    if (!CHANGE_KINDS.has(record.changeKind as MinimalityPlannedChangeKind)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid",
        `minimalityPlan.plannedFiles[${index}].changeKind is invalid.`,
        true
      );
    }
    return {
      path: requireSafePath(record.path, `minimalityPlan.plannedFiles[${index}].path`),
      changeKind: record.changeKind as MinimalityPlannedChangeKind,
      requested: requireBoolean(record.requested, `minimalityPlan.plannedFiles[${index}].requested`),
      justification: requireOptionalString(record.justification, `minimalityPlan.plannedFiles[${index}].justification`)
    };
  });
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan.plannedFiles contains duplicates.", true
    );
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeDependencies(value: unknown, maximum: number): MinimalityDependencyPlan[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan.newDependencies exceeds the policy limit.", true
    );
  }
  const normalized = value.map((entry, index) => {
    const record = requirePlainObject(entry, `minimalityPlan.newDependencies[${index}]`);
    requireExactFields(record, [
      "name", "requested", "purpose", "justification", "standardLibraryConsidered",
      "nativePlatformConsidered", "existingDependenciesConsidered", "whyExistingInsufficient"
    ], `minimalityPlan.newDependencies[${index}]`);
    const name = requireString(record.name, `minimalityPlan.newDependencies[${index}].name`, 214).toLowerCase();
    if (!PACKAGE_NAME.test(name)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid", "A new dependency name is invalid.", true
      );
    }
    return {
      name,
      requested: requireBoolean(record.requested, `minimalityPlan.newDependencies[${index}].requested`),
      purpose: requireString(record.purpose, `minimalityPlan.newDependencies[${index}].purpose`, 4_000),
      justification: requireOptionalString(record.justification, `minimalityPlan.newDependencies[${index}].justification`),
      standardLibraryConsidered: requireBoolean(
        record.standardLibraryConsidered,
        `minimalityPlan.newDependencies[${index}].standardLibraryConsidered`
      ),
      nativePlatformConsidered: requireBoolean(
        record.nativePlatformConsidered,
        `minimalityPlan.newDependencies[${index}].nativePlatformConsidered`
      ),
      existingDependenciesConsidered: requireStringArray(
        record.existingDependenciesConsidered,
        `minimalityPlan.newDependencies[${index}].existingDependenciesConsidered`,
        100,
        "package"
      ),
      whyExistingInsufficient: requireOptionalString(
        record.whyExistingInsufficient,
        `minimalityPlan.newDependencies[${index}].whyExistingInsufficient`
      )
    };
  });
  if (new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan.newDependencies contains duplicates.", true
    );
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeAbstractions(value: unknown, maximum: number): MinimalityAbstractionPlan[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan.newAbstractions exceeds the policy limit.", true
    );
  }
  const normalized = value.map((entry, index) => {
    const record = requirePlainObject(entry, `minimalityPlan.newAbstractions[${index}]`);
    requireExactFields(record, [
      "abstractionId", "filePath", "requested", "purpose", "justification", "reuseSites",
      "whyInlineInsufficient"
    ], `minimalityPlan.newAbstractions[${index}]`);
    const abstractionId = requireString(
      record.abstractionId, `minimalityPlan.newAbstractions[${index}].abstractionId`, 160
    );
    if (!IDENTIFIER.test(abstractionId)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_draft_invalid", "A minimality abstractionId is invalid.", true
      );
    }
    return {
      abstractionId,
      filePath: requireSafePath(record.filePath, `minimalityPlan.newAbstractions[${index}].filePath`),
      requested: requireBoolean(record.requested, `minimalityPlan.newAbstractions[${index}].requested`),
      purpose: requireString(record.purpose, `minimalityPlan.newAbstractions[${index}].purpose`, 4_000),
      justification: requireOptionalString(record.justification, `minimalityPlan.newAbstractions[${index}].justification`),
      reuseSites: requireStringArray(
        record.reuseSites, `minimalityPlan.newAbstractions[${index}].reuseSites`, 100, "text"
      ),
      whyInlineInsufficient: requireOptionalString(
        record.whyInlineInsufficient, `minimalityPlan.newAbstractions[${index}].whyInlineInsufficient`
      )
    };
  });
  if (new Set(normalized.map((entry) => entry.abstractionId)).size !== normalized.length) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan.newAbstractions contains duplicates.", true
    );
  }
  return normalized.sort((left, right) => left.abstractionId.localeCompare(right.abstractionId));
}

function normalizeMinimalityPlan(value: unknown, context: PlannerMinimalityProviderContext): PreventiveMinimalityRawPlan {
  const record = requirePlainObject(value, "Combined minimality plan draft");
  requireExactFields(record, [
    "planVersion", "riskClass", "taskExplicitlyRequestsRefactor", "plannedFiles",
    "newDependencies", "newAbstractions"
  ], "Combined minimality plan draft");
  if (record.planVersion !== "1" || !RISK_CLASSES.has(record.riskClass as MinimalityRiskClass)) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_draft_invalid", "minimalityPlan version or riskClass is invalid.", true
    );
  }
  return deepFreeze({
    planVersion: "1",
    riskClass: record.riskClass as MinimalityRiskClass,
    taskExplicitlyRequestsRefactor: requireBoolean(
      record.taskExplicitlyRequestsRefactor, "minimalityPlan.taskExplicitlyRequestsRefactor"
    ),
    plannedFiles: normalizePlannedFiles(record.plannedFiles, context.minimalityPolicy.maxPlannedFiles),
    newDependencies: normalizeDependencies(record.newDependencies, context.minimalityPolicy.maxNewDependencies),
    newAbstractions: normalizeAbstractions(record.newAbstractions, context.minimalityPolicy.maxNewAbstractions)
  });
}

function normalizeDraft(value: unknown, context: PlannerMinimalityProviderContext): CombinedDraft {
  const record = requirePlainObject(value, "Combined planner-minimality draft");
  requireExactFields(record, ["proposal", "minimalityPlan"], "Combined planner-minimality draft");
  return deepFreeze({
    proposal: normalizeProposal(record.proposal, context),
    minimalityPlan: normalizeMinimalityPlan(record.minimalityPlan, context)
  });
}

function proposalMaterial(proposal: Omit<BoundedPlannerProposal, "proposalHash">): Record<string, unknown> {
  return {
    proposalVersion: proposal.proposalVersion,
    taskId: proposal.taskId,
    objectiveHash: proposal.objectiveHash,
    acceptanceContractHash: proposal.acceptanceContractHash,
    authorityHash: proposal.authorityHash,
    policyHash: proposal.policyHash,
    seedFiles: proposal.seedFiles,
    seedRationales: proposal.seedRationales,
    requiredSymbols: proposal.requiredSymbols,
    requiredTestFiles: proposal.requiredTestFiles,
    maxExpansionAttempts: proposal.maxExpansionAttempts
  };
}

function finalizeOutput(draft: CombinedDraft, context: PlannerMinimalityProviderContext): PlannerMinimalityProviderOutput {
  const withoutHash: Omit<BoundedPlannerProposal, "proposalHash"> = {
    proposalVersion: "1",
    taskId: draft.proposal.taskId,
    objectiveHash: draft.proposal.objectiveHash,
    acceptanceContractHash: draft.proposal.acceptanceContractHash,
    authorityHash: draft.proposal.authorityHash,
    policyHash: draft.proposal.policyHash,
    seedFiles: draft.proposal.seedFiles,
    seedRationales: draft.proposal.seedRationales.map((entry) => ({
      path: entry.path,
      reasonHash: hashCanonicalJson({
        artifactType: "bounded_planner_seed_rationale",
        path: entry.path,
        reason: entry.reason
      })
    })),
    requiredSymbols: draft.proposal.requiredSymbols,
    requiredTestFiles: draft.proposal.requiredTestFiles,
    maxExpansionAttempts: draft.proposal.maxExpansionAttempts
  };
  const rawProposal = {
    ...withoutHash,
    proposalHash: hashCanonicalJson(proposalMaterial(withoutHash))
  };
  let proposal: BoundedPlannerProposal;
  try {
    proposal = createBoundedPlannerProposal({
      rawProposal,
      expectedTaskId: context.taskId,
      expectedObjectiveHash: context.objectiveHash,
      expectedAcceptanceContractHash: context.acceptanceContractHash,
      expectedAuthorityHash: context.authorityHash,
      expectedPolicyHash: context.policyHash,
      limits: context.limits
    });
  } catch (error) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_output_invalid",
      error instanceof Error ? error.message : "Combined proposal validation failed.",
      true
    );
  }
  return deepFreeze({ proposal, minimalityPlan: draft.minimalityPlan });
}

function parseContentJson(content: string): unknown {
  const trimmed = content.trim();
  let json = trimmed;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) json = fenced[1].trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_json_invalid",
      "Combined planner-minimality response must contain only one JSON object.",
      true
    );
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_json_invalid",
      "Combined planner-minimality response JSON parsing failed.",
      true
    );
  }
}

function parseUsage(value: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  if (value === undefined || value === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }
  const record = requirePlainObject(
    value,
    "Provider usage",
    "planner_minimality_adapter_response_envelope_invalid",
    true
  );
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const candidate = record[key];
      if (candidate !== undefined) {
        if (!Number.isInteger(candidate) || (candidate as number) < 0) {
          throw new PlannerMinimalityAdapterError(
            "planner_minimality_adapter_response_envelope_invalid",
            "Provider usage token counts must be non-negative integers.",
            true
          );
        }
        return candidate as number;
      }
    }
    return null;
  };
  const inputTokens = read("prompt_tokens", "input_tokens");
  const outputTokens = read("completion_tokens", "output_tokens");
  const reportedTotal = read("total_tokens");
  const derivedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  if (reportedTotal !== null && derivedTotal !== null && reportedTotal !== derivedTotal) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_envelope_invalid",
      "Provider usage total_tokens is inconsistent.",
      true
    );
  }
  return { inputTokens, outputTokens, totalTokens: reportedTotal ?? derivedTotal };
}

function parseProviderEnvelope(value: unknown): ParsedProviderResponse {
  const record = requirePlainObject(
    value,
    "OpenAI-compatible response",
    "planner_minimality_adapter_response_envelope_invalid",
    true
  );
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_envelope_invalid",
      "Provider response choices must contain at least one item.",
      true
    );
  }
  const choice = requirePlainObject(
    record.choices[0],
    "Provider response choice",
    "planner_minimality_adapter_response_envelope_invalid",
    true
  );
  const message = choice.message === undefined
    ? null
    : requirePlainObject(
        choice.message,
        "Provider response message",
        "planner_minimality_adapter_response_envelope_invalid",
        true
      );
  const content = message?.content ?? choice.text;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_content_invalid",
      "Provider response content must be a non-empty string.",
      true
    );
  }
  const finishReason = choice.finish_reason;
  if (finishReason !== undefined && finishReason !== null && typeof finishReason !== "string") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_response_envelope_invalid",
      "Provider finish_reason must be a string or null.",
      true
    );
  }
  return {
    content,
    finishReason: finishReason ?? null,
    ...parseUsage(record.usage)
  };
}

function normalizeJsonData(value: unknown, state: { nodes: number }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_PROMPT_NODES || depth > MAX_PROMPT_DEPTH) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_task_context_invalid",
      "Task context exceeds structural limits.",
      false
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_task_context_invalid",
        "Task context numbers must be finite.",
        false
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonData(entry, state, depth + 1));
  if (typeof value !== "object") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_task_context_invalid",
      "Task context must contain JSON-compatible values only.",
      false
    );
  }
  const record = requirePlainObject(
    value,
    "Task context",
    "planner_minimality_adapter_task_context_invalid",
    false
  );
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    result[key] = normalizeJsonData(record[key], state, depth + 1);
  }
  return result;
}

function buildPrompt(
  context: PlannerMinimalityProviderContext,
  maxTaskContextBytes: number,
  repairCode: OpenAICompatiblePlannerMinimalityFailureCode | null
): { system: string; user: string } {
  const normalizedTaskContext = normalizeJsonData(context.taskContext, { nodes: 0 });
  const payload = {
    protocolVersion: "1",
    taskId: context.taskId,
    objectiveHash: context.objectiveHash,
    acceptanceContractHash: context.acceptanceContractHash,
    authorityHash: context.authorityHash,
    policyHash: context.policyHash,
    limits: context.limits,
    allowedChangeFiles: context.allowedChangeFiles,
    forbiddenFiles: context.forbiddenFiles,
    minimalityPolicy: context.minimalityPolicy,
    taskContext: normalizedTaskContext,
    ...(repairCode === null ? {} : {
      repairInstruction: `The previous response failed with ${repairCode}. Return a corrected exact JSON object.`
    })
  };
  const user = JSON.stringify(payload);
  if (new TextEncoder().encode(user).byteLength > maxTaskContextBytes) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_task_context_too_large",
      "Serialized planner-minimality task context exceeds the configured byte limit.",
      false
    );
  }
  const system = [
    "You are a bounded repository planner with a preventive minimality declaration.",
    "Return only one JSON object. Do not use markdown or explanatory prose.",
    "The top-level object must contain exactly proposal and minimalityPlan.",
    "Copy taskId, objectiveHash, acceptanceContractHash, authorityHash, and policyHash exactly.",
    "Never compute or return proposalHash, reasonHash, planHash, receiptHash, or any other cryptographic hash.",
    "Use only repository-relative paths present in taskContext or allowedChangeFiles. Never invent paths.",
    "Choose the smallest defensible seed set and the smallest complete planned change set.",
    "proposal must contain exactly: proposalVersion, taskId, objectiveHash, acceptanceContractHash, authorityHash, policyHash, seedFiles, seedRationales, requiredSymbols, requiredTestFiles, maxExpansionAttempts.",
    "proposalVersion must be \"1\" and seedRationales must contain exactly one {path, reason} per seed file.",
    "minimalityPlan must contain exactly: planVersion, riskClass, taskExplicitlyRequestsRefactor, plannedFiles, newDependencies, newAbstractions.",
    "planVersion must be \"1\". plannedFiles must contain at least one {path, changeKind, requested, justification}.",
    "Use [] when no new dependency or abstraction is needed. Do not invent one to fill the schema.",
    "For each new dependency include exactly: name, requested, purpose, justification, standardLibraryConsidered, nativePlatformConsidered, existingDependenciesConsidered, whyExistingInsufficient.",
    "For each new abstraction include exactly: abstractionId, filePath, requested, purpose, justification, reuseSites, whyInlineInsufficient.",
    "Use null only for optional explanations that are genuinely not applicable. requested means explicitly requested by the task, not merely useful.",
    "High or critical risk must be declared honestly; the runtime decides whether policy is bypassed or routed to review."
  ].join("\n");
  return { system, user };
}

function normalizeConfig(config: OpenAICompatiblePlannerMinimalityProviderConfig): Required<
  Omit<OpenAICompatiblePlannerMinimalityProviderConfig, "apiKey" | "pricing">
> & {
  apiKey: string | null;
  pricing: OpenAICompatiblePlannerMinimalityPricing | null;
} {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "Adapter config must be an object.", false
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "Adapter endpoint must be a valid URL.", false
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username.length > 0 ||
    endpoint.password.length > 0 || endpoint.hash.length > 0 || endpoint.search.length > 0 ||
    config.endpoint.length > 2_048
  ) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid",
      "Adapter endpoint must be a bounded HTTP(S) URL without credentials, query, or fragment.",
      false
    );
  }
  const integer = (
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    field: string
  ): number => {
    const normalized = value ?? fallback;
    if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_config_invalid", `${field} is outside its permitted range.`, false
      );
    }
    return normalized;
  };
  const configString = (value: unknown, field: string, maximum: number): string => {
    if (
      typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value.trim() !== value || CONTROL_EXCEPT_NEWLINE_TAB.test(value)
    ) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_config_invalid", `${field} must be a bounded non-empty string.`, false
      );
    }
    return value;
  };
  const temperature = config.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "temperature must be between 0 and 2.", false
    );
  }
  const responseFormat = config.responseFormat ?? "json_object";
  if (responseFormat !== "json_object" && responseFormat !== "none") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "responseFormat must be json_object or none.", false
    );
  }
  if (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "fetchImpl must be a function.", false
    );
  }
  if (config.sleep !== undefined && typeof config.sleep !== "function") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "sleep must be a function.", false
    );
  }
  if (config.clock !== undefined && typeof config.clock !== "function") {
    throw new PlannerMinimalityAdapterError(
      "planner_minimality_adapter_config_invalid", "clock must be a function.", false
    );
  }
  let pricing: OpenAICompatiblePlannerMinimalityPricing | null = null;
  if (config.pricing !== undefined) {
    const input = config.pricing.inputUsdPerMillionTokens;
    const output = config.pricing.outputUsdPerMillionTokens;
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      throw new PlannerMinimalityAdapterError(
        "planner_minimality_adapter_config_invalid",
        "Pricing rates must be finite non-negative numbers.",
        false
      );
    }
    pricing = deepFreeze({ inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output });
  }
  return {
    endpoint: endpoint.toString(),
    model: configString(config.model, "model", 512),
    apiKey: config.apiKey === undefined ? null : configString(config.apiKey, "apiKey", 8_192),
    timeoutMs: integer(config.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 600_000, "timeoutMs"),
    maxAttempts: integer(config.maxAttempts, 2, 1, 2, "maxAttempts") as 1 | 2,
    retryDelayMs: integer(config.retryDelayMs, 0, 0, 60_000, "retryDelayMs"),
    maxOutputTokens: integer(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 64, 32_768, "maxOutputTokens"),
    temperature,
    maxResponseBytes: integer(config.maxResponseBytes, DEFAULT_RESPONSE_BYTES, 1_024, 20_000_000, "maxResponseBytes"),
    maxTaskContextBytes: integer(
      config.maxTaskContextBytes, DEFAULT_TASK_CONTEXT_BYTES, 1_024, 5_000_000, "maxTaskContextBytes"
    ),
    responseFormat,
    pricing,
    fetchImpl: config.fetchImpl ?? fetch,
    sleep: config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    clock: config.clock ?? (() => Date.now())
  };
}

function attemptMaterial(
  attempt: Omit<OpenAICompatiblePlannerMinimalityAttemptEvidence, "attemptHash">
): Record<string, unknown> {
  return { ...attempt };
}

function finalizeAttempt(
  attempt: Omit<OpenAICompatiblePlannerMinimalityAttemptEvidence, "attemptHash">
): OpenAICompatiblePlannerMinimalityAttemptEvidence {
  return deepFreeze({ ...attempt, attemptHash: hashCanonicalJson(attemptMaterial(attempt)) });
}

function runMaterial(
  run: Omit<OpenAICompatiblePlannerMinimalityRunEvidence, "runHash">
): Record<string, unknown> {
  return { ...run };
}

function finalizeRun(
  config: ReturnType<typeof normalizeConfig>,
  attempts: readonly OpenAICompatiblePlannerMinimalityAttemptEvidence[],
  output: PlannerMinimalityProviderOutput | null,
  failureCode: OpenAICompatiblePlannerMinimalityFailureCode | null
): OpenAICompatiblePlannerMinimalityRunEvidence {
  const usageAvailable = attempts.filter((entry) =>
    entry.inputTokens !== null && entry.outputTokens !== null && entry.totalTokens !== null
  );
  const knownInputTokens = attempts.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0);
  const knownOutputTokens = attempts.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0);
  const knownTotalTokens = attempts.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0);
  const knownCostUsd = config.pricing === null || usageAvailable.length === 0
    ? null
    : Number((
        knownInputTokens * config.pricing.inputUsdPerMillionTokens / 1_000_000 +
        knownOutputTokens * config.pricing.outputUsdPerMillionTokens / 1_000_000
      ).toFixed(12));
  const minimalityDraftHash = output === null ? null : hashCanonicalJson(output.minimalityPlan);
  const outputHash = output === null ? null : hashCanonicalJson(output);
  const withoutHash: Omit<OpenAICompatiblePlannerMinimalityRunEvidence, "runHash"> = {
    runVersion: OPENAI_COMPATIBLE_PLANNER_MINIMALITY_RUN_VERSION,
    evidenceClass: "observed_run",
    endpointIdentityHash: hashCanonicalJson({
      protocol: new URL(config.endpoint).protocol,
      host: new URL(config.endpoint).host,
      pathname: new URL(config.endpoint).pathname
    }),
    model: config.model,
    decision: output === null
      ? "planner_minimality_provider_failed"
      : "planner_minimality_provider_succeeded",
    failureCode,
    attempts,
    attemptCount: attempts.length,
    usageAvailableAttemptCount: usageAvailable.length,
    knownInputTokens,
    knownOutputTokens,
    knownTotalTokens,
    pricingSource: config.pricing === null ? "not_configured" : "operator_configured_rates",
    knownCostUsd,
    proposalHash: output === null ? null : (output.proposal as BoundedPlannerProposal).proposalHash,
    minimalityDraftHash,
    outputHash
  };
  return deepFreeze({ ...withoutHash, runHash: hashCanonicalJson(runMaterial(withoutHash)) });
}

export function verifyOpenAICompatiblePlannerMinimalityRunEvidence(
  run: OpenAICompatiblePlannerMinimalityRunEvidence
): boolean {
  try {
    if (run.runVersion !== OPENAI_COMPATIBLE_PLANNER_MINIMALITY_RUN_VERSION) return false;
    if (run.attemptCount !== run.attempts.length) return false;
    for (const attempt of run.attempts) {
      const { attemptHash, ...withoutHash } = attempt;
      if (attemptHash !== hashCanonicalJson(attemptMaterial(withoutHash))) return false;
    }
    const { runHash, ...withoutHash } = run;
    return runHash === hashCanonicalJson(runMaterial(withoutHash));
  } catch {
    return false;
  }
}

function retryableHttp(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function createOpenAICompatiblePlannerMinimalityProvider(
  inputConfig: OpenAICompatiblePlannerMinimalityProviderConfig
): OpenAICompatiblePlannerMinimalityProviderAdapter {
  const config = normalizeConfig(inputConfig);
  let lastRun: OpenAICompatiblePlannerMinimalityRunEvidence | null = null;

  const invoke = async (
    context: PlannerMinimalityProviderContext
  ): Promise<{
    output: PlannerMinimalityProviderOutput;
    evidence: OpenAICompatiblePlannerMinimalityRunEvidence;
  }> => {
    const attempts: OpenAICompatiblePlannerMinimalityAttemptEvidence[] = [];
    let repairCode: OpenAICompatiblePlannerMinimalityFailureCode | null = null;
    let finalFailure: PlannerMinimalityAdapterError | null = null;

    for (let attemptNumber = 1; attemptNumber <= config.maxAttempts; attemptNumber += 1) {
      const startedAt = config.clock();
      let responseBytes: number | null = null;
      let responseHash: string | null = null;
      let httpStatus: number | null = null;
      let parsed: ParsedProviderResponse | null = null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const prompt = buildPrompt(context, config.maxTaskContextBytes, repairCode);
        const body: Record<string, unknown> = {
          model: config.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          temperature: config.temperature,
          max_tokens: config.maxOutputTokens,
          stream: false
        };
        if (config.responseFormat === "json_object") body.response_format = { type: "json_object" };
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;
        let response: Response;
        try {
          response = await config.fetchImpl(config.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw new PlannerMinimalityAdapterError(
              "planner_minimality_adapter_timeout", "Planner-minimality provider request timed out.", true
            );
          }
          throw new PlannerMinimalityAdapterError(
            "planner_minimality_adapter_network_error",
            error instanceof Error ? error.message : "Planner-minimality provider network request failed.",
            true
          );
        }
        httpStatus = response.status;
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > config.maxResponseBytes) {
          throw new PlannerMinimalityAdapterError(
            "planner_minimality_adapter_response_too_large",
            "Planner-minimality provider response exceeds the configured byte limit.",
            false,
            response.status
          );
        }
        const text = await response.text();
        responseBytes = new TextEncoder().encode(text).byteLength;
        responseHash = hashCanonicalJson({ responseText: text });
        if (responseBytes > config.maxResponseBytes) {
          throw new PlannerMinimalityAdapterError(
            "planner_minimality_adapter_response_too_large",
            "Planner-minimality provider response exceeds the configured byte limit.",
            false,
            response.status
          );
        }
        if (!response.ok) {
          const retryable = retryableHttp(response.status);
          throw new PlannerMinimalityAdapterError(
            retryable
              ? "planner_minimality_adapter_http_retryable"
              : "planner_minimality_adapter_http_non_retryable",
            `Planner-minimality provider returned HTTP ${response.status}.`,
            retryable,
            response.status
          );
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(text);
        } catch {
          throw new PlannerMinimalityAdapterError(
            "planner_minimality_adapter_response_envelope_invalid",
            "Planner-minimality provider response envelope is not valid JSON.",
            true,
            response.status
          );
        }
        parsed = parseProviderEnvelope(envelope);
        const draft = normalizeDraft(parseContentJson(parsed.content), context);
        const output = finalizeOutput(draft, context);
        const minimalityDraftHash = hashCanonicalJson(output.minimalityPlan);
        const outputHash = hashCanonicalJson(output);
        attempts.push(finalizeAttempt({
          attempt: attemptNumber,
          decision: "succeeded",
          failureCode: null,
          retryable: false,
          httpStatus,
          latencyMs: Math.max(0, config.clock() - startedAt),
          responseBytes,
          responseHash,
          finishReason: parsed.finishReason,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.totalTokens,
          proposalHash: (output.proposal as BoundedPlannerProposal).proposalHash,
          minimalityDraftHash,
          outputHash
        }));
        lastRun = finalizeRun(config, attempts, output, null);
        return { output, evidence: lastRun };
      } catch (error) {
        const adapterError = error instanceof PlannerMinimalityAdapterError
          ? error
          : new PlannerMinimalityAdapterError(
              "planner_minimality_adapter_response_envelope_invalid",
              error instanceof Error ? error.message : "Planner-minimality adapter failed.",
              true,
              httpStatus
            );
        finalFailure = adapterError;
        attempts.push(finalizeAttempt({
          attempt: attemptNumber,
          decision: "failed",
          failureCode: adapterError.code,
          retryable: adapterError.retryable,
          httpStatus: adapterError.httpStatus ?? httpStatus,
          latencyMs: Math.max(0, config.clock() - startedAt),
          responseBytes,
          responseHash,
          finishReason: parsed?.finishReason ?? null,
          inputTokens: parsed?.inputTokens ?? null,
          outputTokens: parsed?.outputTokens ?? null,
          totalTokens: parsed?.totalTokens ?? null,
          proposalHash: null,
          minimalityDraftHash: null,
          outputHash: null
        }));
        repairCode = adapterError.code;
        if (!adapterError.retryable || attemptNumber >= config.maxAttempts) break;
        if (config.retryDelayMs > 0) await config.sleep(config.retryDelayMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    const failureCode = finalFailure?.code ?? "planner_minimality_adapter_attempts_exhausted";
    lastRun = finalizeRun(config, attempts, null, failureCode);
    throw new PlannerMinimalityAdapterError(
      failureCode,
      finalFailure?.message ?? "Planner-minimality adapter attempts were exhausted.",
      false,
      finalFailure?.httpStatus ?? null
    );
  };

  return deepFreeze({
    plannerMinimalityProvider: async (context) => (await invoke(context)).output,
    invoke,
    getLastRunEvidence: () => lastRun
  });
}
