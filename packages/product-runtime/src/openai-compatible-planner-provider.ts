import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  createBoundedPlannerProposal,
  type BoundedPlannerProposal,
  type BoundedPlannerProposalLimits,
  type RunBoundedPlannerTaskFlowInput
} from "./bounded-planner-proposal-contract.js";

export const OPENAI_COMPATIBLE_PLANNER_PROVIDER_VERSION = "1" as const;
export const OPENAI_COMPATIBLE_PLANNER_RUN_VERSION = "1" as const;

export type OpenAICompatiblePlannerProviderContext = Parameters<
  RunBoundedPlannerTaskFlowInput<unknown>["plannerProvider"]
>[0];

export type OpenAICompatiblePlannerPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type OpenAICompatiblePlannerProviderConfig = {
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
  pricing?: OpenAICompatiblePlannerPricing;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
};

export type OpenAICompatiblePlannerFailureCode =
  | "planner_adapter_config_invalid"
  | "planner_adapter_task_context_invalid"
  | "planner_adapter_task_context_too_large"
  | "planner_adapter_network_error"
  | "planner_adapter_timeout"
  | "planner_adapter_http_retryable"
  | "planner_adapter_http_non_retryable"
  | "planner_adapter_response_too_large"
  | "planner_adapter_response_envelope_invalid"
  | "planner_adapter_response_content_invalid"
  | "planner_adapter_response_json_invalid"
  | "planner_adapter_draft_invalid"
  | "planner_adapter_proposal_invalid"
  | "planner_adapter_attempts_exhausted";

export type OpenAICompatiblePlannerAttemptEvidence = {
  attempt: number;
  decision: "succeeded" | "failed";
  failureCode: OpenAICompatiblePlannerFailureCode | null;
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
  attemptHash: string;
};

export type OpenAICompatiblePlannerRunEvidence = {
  runVersion: "1";
  evidenceClass: "observed_run";
  endpointIdentityHash: string;
  model: string;
  decision: "planner_provider_succeeded" | "planner_provider_failed";
  failureCode: OpenAICompatiblePlannerFailureCode | null;
  attempts: readonly OpenAICompatiblePlannerAttemptEvidence[];
  attemptCount: number;
  usageAvailableAttemptCount: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownTotalTokens: number;
  pricingSource: "operator_configured_rates" | "not_configured";
  knownCostUsd: number | null;
  proposalHash: string | null;
  runHash: string;
};

export type OpenAICompatiblePlannerProviderAdapter = {
  plannerProvider: (
    context: OpenAICompatiblePlannerProviderContext
  ) => Promise<BoundedPlannerProposal>;
  invoke: (
    context: OpenAICompatiblePlannerProviderContext
  ) => Promise<{
    proposal: BoundedPlannerProposal;
    evidence: OpenAICompatiblePlannerRunEvidence;
  }>;
  getLastRunEvidence: () => OpenAICompatiblePlannerRunEvidence | null;
};

type PlannerDraft = {
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

type ParsedProviderResponse = {
  content: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TASK_CONTEXT_BYTES = 250_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_PROMPT_DEPTH = 32;
const MAX_PROMPT_NODES = 50_000;

class PlannerAdapterError extends Error {
  constructor(
    readonly code: OpenAICompatiblePlannerFailureCode,
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
  code: OpenAICompatiblePlannerFailureCode = "planner_adapter_draft_invalid",
  retryable = true
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlannerAdapterError(code, `${label} must be a plain object.`, retryable);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PlannerAdapterError(code, `${label} must be a plain object.`, retryable);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new PlannerAdapterError(code, `${label} must not contain symbol properties.`, retryable);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new PlannerAdapterError(code, `${label} must not contain accessors.`, retryable);
    }
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PlannerAdapterError(
        "planner_adapter_draft_invalid",
        `${label} contains an unknown field: ${key}.`,
        true
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw new PlannerAdapterError(
        "planner_adapter_draft_invalid",
        `${label} is missing field: ${field}.`,
        true
      );
    }
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    CONTROL_EXCEPT_NEWLINE_TAB.test(value)
  ) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      `${field} must be a bounded non-empty string.`,
      true
    );
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      `${field} must be a sha256 hash.`,
      true
    );
  }
  return value;
}

function requireSafePath(value: unknown, field: string): string {
  const path = requireBoundedString(value, field, 4_096).replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    path.startsWith("/") ||
    WINDOWS_DRIVE.test(path) ||
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    path.split("/").includes("..")
  ) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      `${field} must be a safe repository-relative path.`,
      true
    );
  }
  return path;
}

function requireStringArray(
  value: unknown,
  field: string,
  maximum: number,
  pathMode: boolean
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      `${field} exceeds its bounded count.`,
      true
    );
  }
  const normalized = value.map((entry) => pathMode
    ? requireSafePath(entry, field)
    : requireBoundedString(entry, field, 256));
  if (new Set(normalized).size !== normalized.length) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      `${field} must not contain duplicates.`,
      true
    );
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeDraft(value: unknown, limits: BoundedPlannerProposalLimits): PlannerDraft {
  const record = requirePlainObject(value, "Planner draft");
  requireExactFields(record, [
    "proposalVersion",
    "taskId",
    "objectiveHash",
    "acceptanceContractHash",
    "authorityHash",
    "policyHash",
    "seedFiles",
    "seedRationales",
    "requiredSymbols",
    "requiredTestFiles",
    "maxExpansionAttempts"
  ], "Planner draft");
  if (record.proposalVersion !== "1") {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      "proposalVersion must be 1.",
      true
    );
  }
  const seedFiles = requireStringArray(record.seedFiles, "seedFiles", limits.maxSeedFiles, true);
  if (seedFiles.length === 0) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      "seedFiles must contain at least one path.",
      true
    );
  }
  if (!Array.isArray(record.seedRationales) || record.seedRationales.length !== seedFiles.length) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      "seedRationales must contain exactly one entry per seed file.",
      true
    );
  }
  const seedRationales = record.seedRationales.map((entry) => {
    const rationale = requirePlainObject(entry, "Seed rationale draft");
    requireExactFields(rationale, ["path", "reason"], "Seed rationale draft");
    return {
      path: requireSafePath(rationale.path, "seedRationales.path"),
      reason: requireBoundedString(rationale.reason, "seedRationales.reason", 2_000)
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (seedRationales.some((entry, index) => entry.path !== seedFiles[index])) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      "Seed rationale paths must match seedFiles exactly.",
      true
    );
  }
  const maxExpansionAttempts = record.maxExpansionAttempts;
  if (
    (maxExpansionAttempts !== 1 && maxExpansionAttempts !== 2) ||
    maxExpansionAttempts > limits.maxExpansionAttempts
  ) {
    throw new PlannerAdapterError(
      "planner_adapter_draft_invalid",
      "maxExpansionAttempts exceeds the permitted budget.",
      true
    );
  }
  return deepFreeze({
    proposalVersion: "1",
    taskId: requireBoundedString(record.taskId, "taskId", 128),
    objectiveHash: requireHash(record.objectiveHash, "objectiveHash"),
    acceptanceContractHash: requireHash(record.acceptanceContractHash, "acceptanceContractHash"),
    authorityHash: requireHash(record.authorityHash, "authorityHash"),
    policyHash: requireHash(record.policyHash, "policyHash"),
    seedFiles,
    seedRationales,
    requiredSymbols: requireStringArray(
      record.requiredSymbols,
      "requiredSymbols",
      limits.maxRequiredSymbols,
      false
    ),
    requiredTestFiles: requireStringArray(
      record.requiredTestFiles,
      "requiredTestFiles",
      limits.maxRequiredTests,
      true
    ),
    maxExpansionAttempts
  });
}

function proposalMaterial(
  proposal: Omit<BoundedPlannerProposal, "proposalHash">
): Record<string, unknown> {
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

function finalizeProposal(
  draft: PlannerDraft,
  context: OpenAICompatiblePlannerProviderContext
): BoundedPlannerProposal {
  const withoutHash: Omit<BoundedPlannerProposal, "proposalHash"> = {
    proposalVersion: "1",
    taskId: draft.taskId,
    objectiveHash: draft.objectiveHash,
    acceptanceContractHash: draft.acceptanceContractHash,
    authorityHash: draft.authorityHash,
    policyHash: draft.policyHash,
    seedFiles: draft.seedFiles,
    seedRationales: draft.seedRationales.map((entry) => ({
      path: entry.path,
      reasonHash: hashCanonicalJson({
        artifactType: "bounded_planner_seed_rationale",
        path: entry.path,
        reason: entry.reason
      })
    })),
    requiredSymbols: draft.requiredSymbols,
    requiredTestFiles: draft.requiredTestFiles,
    maxExpansionAttempts: draft.maxExpansionAttempts
  };
  const rawProposal = {
    ...withoutHash,
    proposalHash: hashCanonicalJson(proposalMaterial(withoutHash))
  };
  try {
    return createBoundedPlannerProposal({
      rawProposal,
      expectedTaskId: context.taskId,
      expectedObjectiveHash: context.objectiveHash,
      expectedAcceptanceContractHash: context.acceptanceContractHash,
      expectedAuthorityHash: context.authorityHash,
      expectedPolicyHash: context.policyHash,
      limits: context.limits
    });
  } catch (error) {
    throw new PlannerAdapterError(
      "planner_adapter_proposal_invalid",
      error instanceof Error ? error.message : "Planner proposal validation failed.",
      true
    );
  }
}

function parseContentJson(content: string): unknown {
  const trimmed = content.trim();
  let json = trimmed;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) json = fenced[1].trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new PlannerAdapterError(
      "planner_adapter_response_json_invalid",
      "Planner response must contain only one JSON object.",
      true
    );
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new PlannerAdapterError(
      "planner_adapter_response_json_invalid",
      "Planner response JSON parsing failed.",
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
  const record = requirePlainObject(value, "Provider usage", "planner_adapter_response_envelope_invalid", true);
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const candidate = record[key];
      if (candidate !== undefined) {
        if (!Number.isInteger(candidate) || (candidate as number) < 0) {
          throw new PlannerAdapterError(
            "planner_adapter_response_envelope_invalid",
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
  const derivedTotal = inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens
    : null;
  if (reportedTotal !== null && derivedTotal !== null && reportedTotal !== derivedTotal) {
    throw new PlannerAdapterError(
      "planner_adapter_response_envelope_invalid",
      "Provider usage total_tokens is inconsistent.",
      true
    );
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? derivedTotal
  };
}

function parseProviderEnvelope(value: unknown): ParsedProviderResponse {
  const record = requirePlainObject(value, "OpenAI-compatible response", "planner_adapter_response_envelope_invalid", true);
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw new PlannerAdapterError(
      "planner_adapter_response_envelope_invalid",
      "Provider response choices must contain at least one item.",
      true
    );
  }
  const choice = requirePlainObject(record.choices[0], "Provider response choice", "planner_adapter_response_envelope_invalid", true);
  const message = choice.message === undefined
    ? null
    : requirePlainObject(choice.message, "Provider response message", "planner_adapter_response_envelope_invalid", true);
  const content = message?.content ?? choice.text;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new PlannerAdapterError(
      "planner_adapter_response_content_invalid",
      "Provider response content must be a non-empty string.",
      true
    );
  }
  const finishReason = choice.finish_reason;
  if (finishReason !== undefined && finishReason !== null && typeof finishReason !== "string") {
    throw new PlannerAdapterError(
      "planner_adapter_response_envelope_invalid",
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

function normalizeJsonData(
  value: unknown,
  state: { nodes: number },
  depth = 0
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_PROMPT_NODES || depth > MAX_PROMPT_DEPTH) {
    throw new PlannerAdapterError(
      "planner_adapter_task_context_invalid",
      "Task context exceeds structural limits.",
      false
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PlannerAdapterError(
        "planner_adapter_task_context_invalid",
        "Task context numbers must be finite.",
        false
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonData(entry, state, depth + 1));
  }
  if (typeof value !== "object") {
    throw new PlannerAdapterError(
      "planner_adapter_task_context_invalid",
      "Task context must contain JSON-compatible values only.",
      false
    );
  }
  const record = requirePlainObject(value, "Task context", "planner_adapter_task_context_invalid", false);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    result[key] = normalizeJsonData(record[key], state, depth + 1);
  }
  return result;
}

function buildPrompt(
  context: OpenAICompatiblePlannerProviderContext,
  maxTaskContextBytes: number,
  repairCode: OpenAICompatiblePlannerFailureCode | null
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
    forbiddenFiles: context.forbiddenFiles,
    taskContext: normalizedTaskContext,
    ...(repairCode === null ? {} : {
      repairInstruction: `The previous response failed with ${repairCode}. Return a corrected exact JSON object.`
    })
  };
  const user = JSON.stringify(payload);
  if (new TextEncoder().encode(user).byteLength > maxTaskContextBytes) {
    throw new PlannerAdapterError(
      "planner_adapter_task_context_too_large",
      "Serialized planner task context exceeds the configured byte limit.",
      false
    );
  }
  const system = [
    "You are a bounded repository planning provider.",
    "Return only one JSON object. Do not use markdown or explanatory prose.",
    "Copy taskId, objectiveHash, acceptanceContractHash, authorityHash, and policyHash exactly from the request.",
    "Do not compute or return cryptographic hashes beyond copying those identity fields.",
    "Use only repository-relative paths explicitly available in taskContext. Never invent paths.",
    "Choose the smallest defensible seed set and stay inside every count and expansion limit.",
    "The JSON object must contain exactly these fields:",
    "proposalVersion, taskId, objectiveHash, acceptanceContractHash, authorityHash, policyHash, seedFiles, seedRationales, requiredSymbols, requiredTestFiles, maxExpansionAttempts.",
    "proposalVersion must be \"1\".",
    "seedRationales must contain exactly one {path, reason} item for each seed file.",
    "reason must be short plain text. The trusted adapter will hash it.",
    "Do not include proposalHash or reasonHash."
  ].join("\n");
  return { system, user };
}

function normalizeConfig(config: OpenAICompatiblePlannerProviderConfig): Required<
  Omit<OpenAICompatiblePlannerProviderConfig, "apiKey" | "pricing">
> & {
  apiKey: string | null;
  pricing: OpenAICompatiblePlannerPricing | null;
} {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "Planner adapter config must be an object.",
      false
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "Planner endpoint must be a valid URL.",
      false
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.search.length > 0 ||
    config.endpoint.length > 2_048
  ) {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "Planner endpoint must be a bounded HTTP(S) URL without credentials or fragments.",
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
      throw new PlannerAdapterError(
        "planner_adapter_config_invalid",
        `${field} is outside its permitted range.`,
        false
      );
    }
    return normalized;
  };
  const configString = (value: unknown, field: string, maximum: number): string => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum ||
      value.trim() !== value ||
      CONTROL_EXCEPT_NEWLINE_TAB.test(value)
    ) {
      throw new PlannerAdapterError(
        "planner_adapter_config_invalid",
        `${field} must be a bounded non-empty string.`,
        false
      );
    }
    return value;
  };
  const model = configString(config.model, "model", 512);
  const temperature = config.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "temperature must be between 0 and 2.",
      false
    );
  }
  const responseFormat = config.responseFormat ?? "json_object";
  if (responseFormat !== "json_object" && responseFormat !== "none") {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "responseFormat must be json_object or none.",
      false
    );
  }
  if (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function") {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "fetchImpl must be a function.",
      false
    );
  }
  if (config.sleep !== undefined && typeof config.sleep !== "function") {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "sleep must be a function.",
      false
    );
  }
  if (config.clock !== undefined && typeof config.clock !== "function") {
    throw new PlannerAdapterError(
      "planner_adapter_config_invalid",
      "clock must be a function.",
      false
    );
  }
  let pricing: OpenAICompatiblePlannerPricing | null = null;
  if (config.pricing !== undefined) {
    const input = config.pricing.inputUsdPerMillionTokens;
    const output = config.pricing.outputUsdPerMillionTokens;
    if (
      !Number.isFinite(input) || input < 0 ||
      !Number.isFinite(output) || output < 0
    ) {
      throw new PlannerAdapterError(
        "planner_adapter_config_invalid",
        "Planner pricing rates must be finite non-negative numbers.",
        false
      );
    }
    pricing = deepFreeze({
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output
    });
  }
  return {
    endpoint: endpoint.toString(),
    model,
    apiKey: config.apiKey === undefined
      ? null
      : configString(config.apiKey, "apiKey", 8_192),
    timeoutMs: integer(config.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 600_000, "timeoutMs"),
    maxAttempts: integer(config.maxAttempts, 2, 1, 2, "maxAttempts") as 1 | 2,
    retryDelayMs: integer(config.retryDelayMs, 0, 0, 60_000, "retryDelayMs"),
    maxOutputTokens: integer(
      config.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      32_768,
      "maxOutputTokens"
    ),
    temperature,
    maxResponseBytes: integer(
      config.maxResponseBytes,
      DEFAULT_RESPONSE_BYTES,
      1_024,
      20_000_000,
      "maxResponseBytes"
    ),
    maxTaskContextBytes: integer(
      config.maxTaskContextBytes,
      DEFAULT_TASK_CONTEXT_BYTES,
      1_024,
      5_000_000,
      "maxTaskContextBytes"
    ),
    responseFormat,
    pricing,
    fetchImpl: config.fetchImpl ?? fetch,
    sleep: config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    clock: config.clock ?? (() => Date.now())
  };
}

function attemptMaterial(
  attempt: Omit<OpenAICompatiblePlannerAttemptEvidence, "attemptHash">
): Record<string, unknown> {
  return {
    attempt: attempt.attempt,
    decision: attempt.decision,
    failureCode: attempt.failureCode,
    retryable: attempt.retryable,
    httpStatus: attempt.httpStatus,
    latencyMs: attempt.latencyMs,
    responseBytes: attempt.responseBytes,
    responseHash: attempt.responseHash,
    finishReason: attempt.finishReason,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    totalTokens: attempt.totalTokens,
    proposalHash: attempt.proposalHash
  };
}

function finalizeAttempt(
  attempt: Omit<OpenAICompatiblePlannerAttemptEvidence, "attemptHash">
): OpenAICompatiblePlannerAttemptEvidence {
  return deepFreeze({
    ...attempt,
    attemptHash: hashCanonicalJson(attemptMaterial(attempt))
  });
}

function runMaterial(
  run: Omit<OpenAICompatiblePlannerRunEvidence, "runHash">
): Record<string, unknown> {
  return {
    runVersion: run.runVersion,
    evidenceClass: run.evidenceClass,
    endpointIdentityHash: run.endpointIdentityHash,
    model: run.model,
    decision: run.decision,
    failureCode: run.failureCode,
    attempts: run.attempts,
    attemptCount: run.attemptCount,
    usageAvailableAttemptCount: run.usageAvailableAttemptCount,
    knownInputTokens: run.knownInputTokens,
    knownOutputTokens: run.knownOutputTokens,
    knownTotalTokens: run.knownTotalTokens,
    pricingSource: run.pricingSource,
    knownCostUsd: run.knownCostUsd,
    proposalHash: run.proposalHash
  };
}

function finalizeRun(
  config: ReturnType<typeof normalizeConfig>,
  attempts: readonly OpenAICompatiblePlannerAttemptEvidence[],
  proposal: BoundedPlannerProposal | null,
  failureCode: OpenAICompatiblePlannerFailureCode | null
): OpenAICompatiblePlannerRunEvidence {
  const usageAvailable = attempts.filter((entry) =>
    entry.inputTokens !== null &&
    entry.outputTokens !== null &&
    entry.totalTokens !== null
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
  const withoutHash: Omit<OpenAICompatiblePlannerRunEvidence, "runHash"> = {
    runVersion: OPENAI_COMPATIBLE_PLANNER_RUN_VERSION,
    evidenceClass: "observed_run",
    endpointIdentityHash: hashCanonicalJson({
      protocol: new URL(config.endpoint).protocol,
      host: new URL(config.endpoint).host,
      pathname: new URL(config.endpoint).pathname
    }),
    model: config.model,
    decision: proposal === null ? "planner_provider_failed" : "planner_provider_succeeded",
    failureCode,
    attempts,
    attemptCount: attempts.length,
    usageAvailableAttemptCount: usageAvailable.length,
    knownInputTokens,
    knownOutputTokens,
    knownTotalTokens,
    pricingSource: config.pricing === null ? "not_configured" : "operator_configured_rates",
    knownCostUsd,
    proposalHash: proposal?.proposalHash ?? null
  };
  return deepFreeze({
    ...withoutHash,
    runHash: hashCanonicalJson(runMaterial(withoutHash))
  });
}

export function verifyOpenAICompatiblePlannerRunEvidence(
  run: OpenAICompatiblePlannerRunEvidence
): boolean {
  try {
    if (run.runVersion !== OPENAI_COMPATIBLE_PLANNER_RUN_VERSION) return false;
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

export function createOpenAICompatiblePlannerProvider(
  inputConfig: OpenAICompatiblePlannerProviderConfig
): OpenAICompatiblePlannerProviderAdapter {
  const config = normalizeConfig(inputConfig);
  let lastRun: OpenAICompatiblePlannerRunEvidence | null = null;

  const invoke = async (
    context: OpenAICompatiblePlannerProviderContext
  ): Promise<{ proposal: BoundedPlannerProposal; evidence: OpenAICompatiblePlannerRunEvidence }> => {
    const attempts: OpenAICompatiblePlannerAttemptEvidence[] = [];
    let repairCode: OpenAICompatiblePlannerFailureCode | null = null;
    let finalFailure: PlannerAdapterError | null = null;

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
        if (config.responseFormat === "json_object") {
          body.response_format = { type: "json_object" };
        }
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
            throw new PlannerAdapterError(
              "planner_adapter_timeout",
              "Planner provider request timed out.",
              true
            );
          }
          throw new PlannerAdapterError(
            "planner_adapter_network_error",
            error instanceof Error ? error.message : "Planner provider network request failed.",
            true
          );
        }
        httpStatus = response.status;
        const contentLength = response.headers.get("content-length");
        if (
          contentLength !== null &&
          /^\d+$/.test(contentLength) &&
          Number(contentLength) > config.maxResponseBytes
        ) {
          throw new PlannerAdapterError(
            "planner_adapter_response_too_large",
            "Planner provider response exceeds the configured byte limit.",
            false,
            response.status
          );
        }
        const text = await response.text();
        const measuredResponseBytes = new TextEncoder().encode(text).byteLength;
        responseBytes = measuredResponseBytes;
        responseHash = hashCanonicalJson({ responseText: text });
        if (measuredResponseBytes > config.maxResponseBytes) {
          throw new PlannerAdapterError(
            "planner_adapter_response_too_large",
            "Planner provider response exceeds the configured byte limit.",
            false,
            response.status
          );
        }
        if (!response.ok) {
          const retryable = retryableHttp(response.status);
          throw new PlannerAdapterError(
            retryable
              ? "planner_adapter_http_retryable"
              : "planner_adapter_http_non_retryable",
            `Planner provider returned HTTP ${response.status}.`,
            retryable,
            response.status
          );
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(text);
        } catch {
          throw new PlannerAdapterError(
            "planner_adapter_response_envelope_invalid",
            "Planner provider response envelope is not valid JSON.",
            true,
            response.status
          );
        }
        parsed = parseProviderEnvelope(envelope);
        const draft = normalizeDraft(parseContentJson(parsed.content), context.limits);
        const proposal = finalizeProposal(draft, context);
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
          proposalHash: proposal.proposalHash
        }));
        lastRun = finalizeRun(config, attempts, proposal, null);
        return { proposal, evidence: lastRun };
      } catch (error) {
        const adapterError = error instanceof PlannerAdapterError
          ? error
          : new PlannerAdapterError(
              "planner_adapter_response_envelope_invalid",
              error instanceof Error ? error.message : "Planner adapter failed.",
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
          proposalHash: null
        }));
        repairCode = adapterError.code;
        if (!adapterError.retryable || attemptNumber >= config.maxAttempts) break;
        if (config.retryDelayMs > 0) await config.sleep(config.retryDelayMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    const failureCode = finalFailure?.code ?? "planner_adapter_attempts_exhausted";
    lastRun = finalizeRun(config, attempts, null, failureCode);
    throw new PlannerAdapterError(
      failureCode,
      finalFailure?.message ?? "Planner adapter attempts were exhausted.",
      false,
      finalFailure?.httpStatus ?? null
    );
  };

  return deepFreeze({
    plannerProvider: async (context) => (await invoke(context)).proposal,
    invoke,
    getLastRunEvidence: () => lastRun
  });
}
