import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  analyzeCanonicalRepository,
  canonicalizeRepositoryRelativePath,
  compileCanonicalPolicy,
  createAcceptanceCriteriaContract,
  createOpenAICompatiblePlannerMinimalityProvider,
  createPreventiveMinimalityPolicy,
  hashCanonicalJson,
  normalizeOpenAiCompatibleUsage,
  readDurableBoundedTaskState,
  summarizeDurableBoundedTask,
  VALIDATION_PROFILES,
  type AcceptanceCriterion,
  type RunBoundedTaskInput,
  type RunBoundedTaskResult,
  type TaskProviderControl,
  type TemporaryWorkspaceExecutionSpecification,
  type ValidationProfileId,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";

export const CANONICAL_CLI_INPUT_VERSION = "canonical-cli-task/v1" as const;
export const CANONICAL_CLI_ACCEPTANCE_VERSION = "canonical-cli-acceptance/v1" as const;
export const CANONICAL_CLI_PROVIDER_VERSION = "canonical-cli-provider/v1" as const;
export const CANONICAL_CLI_VALIDATION_VERSION = "canonical-cli-validation/v1" as const;

export type CliCommand = "run" | "status" | "inspect" | "resume" | "recover";
export type CliJson = Record<string, unknown>;
export type CliCommandResult = Readonly<{ output: CliJson; exitCode: number }>;
export type TaskFile = Readonly<{
  schemaVersion: typeof CANONICAL_CLI_INPUT_VERSION;
  taskId: string;
  objective: string;
  repositoryPath: string;
  mode: "draft" | "governed";
  seedFiles: readonly string[];
  allowedChangeFiles: readonly string[];
  forbiddenFiles: readonly string[];
  requiredSymbols: readonly string[];
  requiredTestFiles: readonly string[];
  policyFile: string;
  acceptanceFile: string;
  providerFile: string;
  validationFile?: string;
  costBudget?: Readonly<{
    maxProviderCalls: number;
    maxEstimatedTokens: number;
    maxCostNanoUsd?: number | null;
    providerId: string;
    modelId: string;
    inputNanoUsdPerToken?: number | null;
    outputNanoUsdPerToken?: number | null;
    reservedOutputTokens?: number;
  }>;
  durable: Readonly<{ registryRoot: string; idempotencyKey: string }>;
  timeoutMs: number;
}>;

type ProviderFile = Readonly<{
  schemaVersion: typeof CANONICAL_CLI_PROVIDER_VERSION;
  kind: "openai-compatible";
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
  apiKeyRequired: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
}>;

type ValidationFile = Readonly<{
  schemaVersion: typeof CANONICAL_CLI_VALIDATION_VERSION;
  profile: ValidationProfileId;
  executionSpecification: TemporaryWorkspaceExecutionSpecification;
  containerRuntime: string;
  governed?: Readonly<{
    registryDirectoryPath: string;
    rollbackBundleParentPath: string;
    validationWorkspaceParentPath: string;
  }>;
}>;

const TASK_FIELDS = new Set([
  "schemaVersion", "taskId", "objective", "repositoryPath", "mode",
  "seedFiles", "allowedChangeFiles", "forbiddenFiles", "requiredSymbols", "requiredTestFiles",
  "policyFile", "acceptanceFile", "providerFile", "validationFile", "costBudget", "durable", "timeoutMs"
]);
const PROVIDER_FIELDS = new Set([
  "schemaVersion", "kind", "endpoint", "model", "apiKeyEnv",
  "apiKeyRequired", "timeoutMs", "maxOutputTokens"
]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_INITIAL_FILE_BYTES = 512 * 1024;
const MAX_INITIAL_TOTAL_BYTES = 2 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

function object(value: unknown, label: string): CliJson {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new CliError("cli_config_object_invalid", `${label} must be a JSON object.`);
  }
  return value as CliJson;
}

function exact(value: unknown, fields: readonly string[], label: string): CliJson {
  const result = object(value, label);
  const unknown = Object.keys(result).filter((field) => !fields.includes(field));
  if (unknown.length) {
    throw new CliError(
      "cli_config_unknown_field",
      `${label} contains unknown fields: ${unknown.sort().join(", ")}.`
    );
  }
  return result;
}

function string(value: unknown, field: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliError(
      "cli_config_string_invalid",
      `${field} must be a bounded non-empty string.`
    );
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new CliError(
      "cli_config_integer_invalid",
      `${field} must be an integer from ${min} to ${max}.`
    );
  }
  return value as number;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new CliError("cli_config_boolean_invalid", `${field} must be boolean.`);
  }
  return value;
}

function list(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length) || value.length > 1000) {
    throw new CliError(
      "cli_config_array_invalid",
      `${field} must be a bounded${required ? " non-empty" : ""} array.`
    );
  }
  return [...new Set(value.map((entry, index) => string(entry, `${field}[${index}]`)))].sort();
}

function pathList(value: unknown, field: string, required = false): string[] {
  try {
    return list(value, field, required).map(canonicalizeRepositoryRelativePath);
  } catch {
    throw new CliError(
      "cli_repository_path_invalid",
      `${field} contains an unsafe repository-relative path.`
    );
  }
}

async function jsonFile(file: string, label: string): Promise<unknown> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new CliError("cli_config_file_unreadable", `${label} could not be read.`);
  }
  if (data.length > MAX_CONFIG_BYTES) {
    throw new CliError("cli_config_file_too_large", `${label} is too large.`);
  }
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new CliError("cli_config_json_invalid", `${label} is not valid JSON.`);
  }
}

function resolve(base: string, value: unknown, field: string): string {
  return path.resolve(base, string(value, field));
}

export async function loadTaskFile(file: string): Promise<TaskFile> {
  const absolute = path.resolve(file);
  const base = path.dirname(absolute);
  const input = exact(await jsonFile(absolute, "Task file"), [...TASK_FIELDS], "Task file");
  if (input.schemaVersion !== CANONICAL_CLI_INPUT_VERSION) {
    throw new CliError(
      "cli_task_version_unsupported",
      `Task schemaVersion must be ${CANONICAL_CLI_INPUT_VERSION}.`
    );
  }
  const taskId = string(input.taskId, "taskId", 160);
  if (!IDENTIFIER.test(taskId)) {
    throw new CliError("cli_task_id_invalid", "taskId is invalid.");
  }
  const mode = input.mode ?? "draft";
  if (mode !== "draft" && mode !== "governed") {
    throw new CliError("cli_mode_invalid", "mode must be draft or governed.");
  }
  const durable = exact(input.durable, ["registryRoot", "idempotencyKey"], "durable");
  let costBudget: TaskFile["costBudget"];
  if (input.costBudget !== undefined) {
    const budget = exact(
      input.costBudget,
      [
        "maxProviderCalls", "maxEstimatedTokens", "maxCostNanoUsd", "providerId", "modelId",
        "inputNanoUsdPerToken", "outputNanoUsdPerToken", "reservedOutputTokens"
      ],
      "costBudget"
    );
    for (const field of ["maxProviderCalls", "maxEstimatedTokens", "providerId", "modelId"] as const) {
      if (budget[field] === undefined) {
        throw new CliError(
          "cli_cost_budget_field_missing",
          `costBudget.${field} is required.`
        );
      }
    }
    const optionalPrice = (value: unknown, field: string): number | null | undefined => {
      if (value === undefined || value === null) return value;
      return integer(value, field, 0, 0, Number.MAX_SAFE_INTEGER);
    };
    const maxCostNanoUsd = optionalPrice(budget.maxCostNanoUsd, "costBudget.maxCostNanoUsd");
    const inputNanoUsdPerToken = optionalPrice(
      budget.inputNanoUsdPerToken,
      "costBudget.inputNanoUsdPerToken"
    );
    const outputNanoUsdPerToken = optionalPrice(
      budget.outputNanoUsdPerToken,
      "costBudget.outputNanoUsdPerToken"
    );
    costBudget = {
      maxProviderCalls: integer(budget.maxProviderCalls, "costBudget.maxProviderCalls", 0, 0, 1000),
      maxEstimatedTokens: integer(
        budget.maxEstimatedTokens,
        "costBudget.maxEstimatedTokens",
        0,
        0,
        1_000_000_000
      ),
      providerId: string(budget.providerId, "costBudget.providerId", 256),
      modelId: string(budget.modelId, "costBudget.modelId", 256),
      ...(maxCostNanoUsd === undefined ? {} : { maxCostNanoUsd }),
      ...(inputNanoUsdPerToken === undefined ? {} : { inputNanoUsdPerToken }),
      ...(outputNanoUsdPerToken === undefined ? {} : { outputNanoUsdPerToken }),
      reservedOutputTokens: integer(
        budget.reservedOutputTokens,
        "costBudget.reservedOutputTokens",
        0,
        0,
        1_000_000_000
      )
    };
  }
  return {
    schemaVersion: CANONICAL_CLI_INPUT_VERSION,
    taskId,
    objective: string(input.objective, "objective", 32_768),
    repositoryPath: resolve(base, input.repositoryPath, "repositoryPath"),
    mode,
    seedFiles: pathList(input.seedFiles, "seedFiles", true),
    allowedChangeFiles: pathList(input.allowedChangeFiles, "allowedChangeFiles", true),
    forbiddenFiles: pathList(input.forbiddenFiles, "forbiddenFiles"),
    requiredSymbols: list(input.requiredSymbols, "requiredSymbols"),
    requiredTestFiles: pathList(input.requiredTestFiles, "requiredTestFiles"),
    policyFile: resolve(base, input.policyFile, "policyFile"),
    acceptanceFile: resolve(base, input.acceptanceFile, "acceptanceFile"),
    providerFile: resolve(base, input.providerFile, "providerFile"),
    ...(input.validationFile === undefined
      ? {}
      : { validationFile: resolve(base, input.validationFile, "validationFile") }),
    ...(costBudget ? { costBudget } : {}),
    durable: {
      registryRoot: resolve(base, durable.registryRoot, "durable.registryRoot"),
      idempotencyKey: string(durable.idempotencyKey, "durable.idempotencyKey", 160)
    },
    timeoutMs: integer(input.timeoutMs, "timeoutMs", 120_000, 1_000, 600_000)
  };
}

async function providerFile(file: string): Promise<ProviderFile> {
  const input = exact(await jsonFile(file, "Provider file"), [...PROVIDER_FIELDS], "Provider file");
  if (
    input.schemaVersion !== CANONICAL_CLI_PROVIDER_VERSION ||
    input.kind !== "openai-compatible"
  ) {
    throw new CliError(
      "cli_provider_unsupported",
      "Only canonical-cli-provider/v1 openai-compatible is supported."
    );
  }
  const endpoint = string(input.endpoint, "provider.endpoint", 2048);
  try {
    if (!["http:", "https:"].includes(new URL(endpoint).protocol)) throw new Error();
  } catch {
    throw new CliError(
      "cli_provider_endpoint_invalid",
      "provider.endpoint must be an HTTP(S) URL."
    );
  }
  const apiKeyEnv = input.apiKeyEnv === undefined
    ? undefined
    : string(input.apiKeyEnv, "provider.apiKeyEnv", 128);
  if (apiKeyEnv && !ENV_NAME.test(apiKeyEnv)) {
    throw new CliError(
      "cli_provider_key_env_invalid",
      "provider.apiKeyEnv must be an uppercase environment variable name."
    );
  }
  return {
    schemaVersion: CANONICAL_CLI_PROVIDER_VERSION,
    kind: "openai-compatible",
    endpoint,
    model: string(input.model, "provider.model", 256),
    apiKeyRequired: bool(input.apiKeyRequired, "provider.apiKeyRequired", true),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    timeoutMs: integer(input.timeoutMs, "provider.timeoutMs", 60_000, 1_000, 600_000),
    maxOutputTokens: integer(input.maxOutputTokens, "provider.maxOutputTokens", 4096, 128, 8192)
  };
}

async function acceptanceFile(file: string, taskId: string, objectiveHash: string) {
  const input = exact(
    await jsonFile(file, "Acceptance file"),
    ["schemaVersion", "criteria"],
    "Acceptance file"
  );
  if (input.schemaVersion !== CANONICAL_CLI_ACCEPTANCE_VERSION) {
    throw new CliError(
      "cli_acceptance_version_unsupported",
      "Acceptance schemaVersion must be canonical-cli-acceptance/v1."
    );
  }
  try {
    return createAcceptanceCriteriaContract({
      taskId,
      objectiveHash,
      criteria: input.criteria as readonly AcceptanceCriterion[]
    });
  } catch {
    throw new CliError("cli_acceptance_invalid", "Acceptance criteria are invalid.");
  }
}

function executionSpecification(value: unknown): TemporaryWorkspaceExecutionSpecification {
  const input = exact(
    value,
    [
      "commands", "allowedExecutables", "maxCommands", "defaultTimeoutMs",
      "maxTimeoutMs", "maxOutputChars", "environment"
    ],
    "executionSpecification"
  );
  if (
    !Array.isArray(input.commands) ||
    !input.commands.length ||
    !Array.isArray(input.allowedExecutables) ||
    !input.allowedExecutables.length
  ) {
    throw new CliError(
      "cli_validation_commands_missing",
      "Validation commands and allowedExecutables must be non-empty arrays."
    );
  }
  return input as TemporaryWorkspaceExecutionSpecification;
}

async function validationFile(file: string): Promise<ValidationFile> {
  const input = exact(
    await jsonFile(file, "Validation file"),
    ["schemaVersion", "profile", "executionSpecification", "containerRuntime", "governed"],
    "Validation file"
  );
  if (input.schemaVersion !== CANONICAL_CLI_VALIDATION_VERSION) {
    throw new CliError(
      "cli_validation_version_unsupported",
      "Validation schemaVersion must be canonical-cli-validation/v1."
    );
  }
  if (typeof input.profile !== "string" || !(input.profile in VALIDATION_PROFILES)) {
    throw new CliError(
      "cli_validation_profile_invalid",
      "validation.profile is unsupported."
    );
  }
  let governed: ValidationFile["governed"];
  if (input.governed !== undefined) {
    const base = path.dirname(file);
    const item = exact(
      input.governed,
      ["registryDirectoryPath", "rollbackBundleParentPath", "validationWorkspaceParentPath"],
      "validation.governed"
    );
    governed = {
      registryDirectoryPath: resolve(base, item.registryDirectoryPath, "registryDirectoryPath"),
      rollbackBundleParentPath: resolve(
        base,
        item.rollbackBundleParentPath,
        "rollbackBundleParentPath"
      ),
      validationWorkspaceParentPath: resolve(
        base,
        item.validationWorkspaceParentPath,
        "validationWorkspaceParentPath"
      )
    };
  }
  return {
    schemaVersion: CANONICAL_CLI_VALIDATION_VERSION,
    profile: input.profile as ValidationProfileId,
    executionSpecification: executionSpecification(input.executionSpecification),
    containerRuntime: input.containerRuntime === undefined
      ? "docker"
      : string(input.containerRuntime, "containerRuntime", 256),
    ...(governed ? { governed } : {})
  };
}

function apiKey(provider: ProviderFile): string | undefined {
  if (!provider.apiKeyEnv) {
    if (provider.apiKeyRequired) {
      throw new CliError(
        "cli_provider_credentials_missing",
        "Provider credentials are required; configure apiKeyEnv.",
        5
      );
    }
    return undefined;
  }
  const value = process.env[provider.apiKeyEnv];
  if (!value && provider.apiKeyRequired) {
    throw new CliError(
      "cli_provider_credentials_missing",
      `Provider credential environment variable ${provider.apiKeyEnv} is not set.`,
      5
    );
  }
  return value || undefined;
}

function checkRuntime(runtime: string): void {
  const args = runtime === "docker"
    ? ["info", "--format", "{{.ServerVersion}}"]
    : ["--version"];
  const result = spawnSync(runtime, args, { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) {
    throw new CliError(
      "cli_validation_environment_missing",
      `Validation container runtime '${runtime}' is unavailable.`,
      5
    );
  }
}

async function initialEvidence(
  repositoryPath: string,
  files: readonly string[],
  symbols: readonly string[]
) {
  const analyzed = await analyzeCanonicalRepository({
    repositoryPath,
    seedFiles: files,
    maxFiles: 1000,
    maxFileBytes: MAX_INITIAL_FILE_BYTES,
    maxTotalBytes: 16 * 1024 * 1024,
    maxDependencyDepth: 8,
    maxEdges: 10_000
  });
  if (analyzed.decision !== "repo_intelligence_ready" || !analyzed.intelligence) {
    throw new CliError(
      "cli_repository_discovery_failed",
      analyzed.issues[0]?.message ?? "Bounded repository discovery failed."
    );
  }
  const facts = new Map(analyzed.intelligence.scannedFiles.map((item) => [item.path, item]));
  let total = 0;
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    const content = await readFile(path.join(repositoryPath, file), "utf8").catch(() => {
      throw new CliError(
        "cli_initial_context_file_missing",
        `Declared initial context file is missing: ${file}.`
      );
    });
    const byteLength = Buffer.byteLength(content);
    total += byteLength;
    if (byteLength > MAX_INITIAL_FILE_BYTES || total > MAX_INITIAL_TOTAL_BYTES) {
      throw new CliError(
        "cli_initial_context_limit_exceeded",
        "Declared seed/test files exceed the bounded initial context limit."
      );
    }
    entries.push({
      path: file,
      source: "canonical_cli_bounded_discovery",
      content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteLength,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: facts.get(file)?.symbols
        .filter((item) => symbols.includes(item.name))
        .map((item) => item.name) ?? []
    });
  }
  return entries;
}

async function coder(
  provider: ProviderFile,
  key: string | undefined,
  context: unknown,
  control?: TaskProviderControl
): Promise<WorkspaceMutation> {
  const controller = new AbortController();
  const propagateAbort = () => controller.abort(control?.signal.reason);
  control?.signal.addEventListener("abort", propagateAbort, { once: true });
  if (control?.signal.aborted) propagateAbort();
  const timer = setTimeout(
    () => controller.abort(new Error("coder provider timeout")),
    provider.timeoutMs
  );
  let response: Response;
  try {
    response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        max_tokens: provider.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return only one canonical text-file-update/v1 WorkspaceMutation JSON object. Update existing files only; never create, delete, or rename."
          },
          { role: "user", content: JSON.stringify(context) }
        ]
      })
    });
  } catch {
    clearTimeout(timer);
    control?.signal.removeEventListener("abort", propagateAbort);
    throw new CliError(
      controller.signal.aborted
        ? "cli_coder_provider_timeout"
        : "cli_coder_provider_network_error",
      "Coder provider request failed.",
      5
    );
  }
  if (!response.ok) {
    clearTimeout(timer);
    control?.signal.removeEventListener("abort", propagateAbort);
    void response.body?.cancel().catch(() => {});
    throw new CliError(
      "cli_coder_provider_http_error",
      `Coder provider returned HTTP ${response.status}.`,
      5
    );
  }
  let text: string;
  try {
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_CONFIG_BYTES
    ) {
      controller.abort();
      void response.body?.cancel().catch(() => {});
      throw new CliError(
        "cli_coder_provider_response_too_large",
        "Coder provider response exceeded the bounded limit.",
        5
      );
    }
    if (response.body === null) text = "";
    else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_CONFIG_BYTES) {
            controller.abort();
            void reader.cancel().catch(() => {});
            throw new CliError(
              "cli_coder_provider_response_too_large",
              "Coder provider response exceeded the bounded limit.",
              5
            );
          }
          parts.push(decoder.decode(chunk.value, { stream: true }));
        }
        parts.push(decoder.decode());
        text = parts.join("");
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      controller.signal.aborted
        ? "cli_coder_provider_timeout"
        : "cli_coder_provider_network_error",
      "Coder provider response could not be read.",
      5
    );
  } finally {
    clearTimeout(timer);
    control?.signal.removeEventListener("abort", propagateAbort);
  }
  let envelope: CliJson;
  try {
    envelope = JSON.parse(text) as CliJson;
  } catch {
    throw new CliError(
      "cli_coder_provider_output_invalid",
      "Coder provider response envelope was not valid JSON.",
      5
    );
  }
  try {
    if (control?.reportUsage) {
      const normalized = normalizeOpenAiCompatibleUsage({
        response: envelope,
        providerResponseHash: hashCanonicalJson(envelope),
        providerRequestId: typeof envelope.id === "string" ? envelope.id : null
      });
      if (normalized.usage?.status === "observed") control.reportUsage(normalized.usage);
      else {
        control.reportUsage({
          status: "unavailable",
          reason: "provider_usage_missing",
          providerResponseHash: hashCanonicalJson(envelope)
        });
      }
    }
    const choices = envelope.choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw new CliError(
        "cli_coder_provider_envelope_invalid",
        "Coder provider must return exactly one choice.",
        5
      );
    }
    const choice = object(choices[0], "Coder provider choice");
    if (choice.finish_reason !== "stop") {
      const code = choice.finish_reason === "length"
        ? "cli_coder_provider_generation_truncated"
        : choice.finish_reason === "content_filter"
          ? "cli_coder_provider_generation_filtered"
          : "cli_coder_provider_generation_incomplete";
      throw new CliError(
        code,
        "Coder provider generation did not complete normally.",
        5
      );
    }
    const message = object(choice.message, "Coder provider message");
    if (typeof message?.content !== "string") throw new Error();
    return JSON.parse(message.content) as WorkspaceMutation;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "cli_coder_provider_output_invalid",
      "Coder provider output was not valid mutation JSON.",
      5
    );
  }
}

export async function buildRunInput(task: TaskFile): Promise<RunBoundedTaskInput> {
  const repositoryPath = await realpath(task.repositoryPath).catch(() => {
    throw new CliError(
      "cli_repository_unavailable",
      "Repository path does not exist or is inaccessible."
    );
  });
  const objectiveHash = hashCanonicalJson({ objective: task.objective });
  const policy = compileCanonicalPolicy({ repositoryPath, policyFilePath: task.policyFile });
  const acceptance = await acceptanceFile(task.acceptanceFile, task.taskId, objectiveHash);
  const provider = await providerFile(task.providerFile);
  const key = apiKey(provider);
  const planner = createOpenAICompatiblePlannerMinimalityProvider({
    endpoint: provider.endpoint,
    model: provider.model,
    ...(key ? { apiKey: key } : {}),
    timeoutMs: provider.timeoutMs,
    maxOutputTokens: provider.maxOutputTokens,
    maxTaskContextBytes: 64 * 1024,
    responseFormat: "json_object"
  });
  const evidence = await initialEvidence(
    repositoryPath,
    [...new Set([...task.seedFiles, ...task.requiredTestFiles])],
    task.requiredSymbols
  );
  const validation = task.validationFile ? await validationFile(task.validationFile) : undefined;
  if (task.mode === "governed" && (!validation || !validation.governed)) {
    throw new CliError(
      "cli_governed_validation_missing",
      "Governed mode requires validationFile with governed directories."
    );
  }
  if (task.mode === "governed" && validation?.containerRuntime !== "docker") {
    throw new CliError(
      "cli_governed_runtime_unsupported",
      "Governed mode currently requires containerRuntime 'docker'."
    );
  }
  if (validation) checkRuntime(validation.containerRuntime);
  const minimalityPolicy = createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "canonical-cli.v1",
    preferExistingCode: true,
    preferStandardLibrary: true,
    preferNativePlatform: true,
    preferInstalledDependencies: true,
    newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true,
    newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: "human_review",
    unrequestedAbstractionBehavior: "human_review",
    unrequestedRefactorBehavior: "replan",
    highRiskBehavior: "human_review",
    maxPlannedFiles: task.allowedChangeFiles.length,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });
  return {
    repositoryPath,
    taskId: task.taskId,
    objectiveHash,
    acceptanceCriteriaContract: acceptance,
    authorityHash: hashCanonicalJson({
      authority: "canonical-cli-declared-scope/v1",
      taskId: task.taskId,
      allowedChangeFiles: task.allowedChangeFiles
    }),
    policyHash: policy.compiledPolicyHash,
    proposalLimits: {
      maxSeedFiles: Math.max(1, task.seedFiles.length),
      maxRequiredSymbols: Math.max(1, task.requiredSymbols.length),
      maxRequiredTests: Math.max(1, task.requiredTestFiles.length),
      maxExpansionAttempts: 1
    },
    minimalityPolicy,
    allowedChangeFiles: task.allowedChangeFiles,
    forbiddenFiles: task.forbiddenFiles,
    canonicalPolicy: { compiledPolicy: policy },
    taskContext: {
      objective: task.objective,
      seedFiles: task.seedFiles,
      requiredSymbols: task.requiredSymbols,
      requiredTestFiles: task.requiredTestFiles
    },
    initialEvidence: evidence,
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: 16_384,
    timeoutMs: task.timeoutMs,
    durableTask: {
      registryRoot: task.durable.registryRoot,
      idempotencyKey: task.durable.idempotencyKey,
      providerIdempotencySupport: { planner: false, coder: false }
    },
    plannerMinimalityProvider: async (context, control) => {
      const output = await planner.plannerMinimalityProvider(context);
      const evidence = planner.getLastRunEvidence();
      if (
        evidence &&
        evidence.attemptCount > 0 &&
        evidence.usageAvailableAttemptCount === evidence.attemptCount
      ) {
        control.reportUsage?.({
          status: "observed",
          inputTokens: evidence.knownInputTokens,
          outputTokens: evidence.knownOutputTokens,
          totalTokens: evidence.knownTotalTokens,
          providerResponseHash: evidence.runHash,
          providerRequestId: null
        });
      } else {
        control.reportUsage?.({
          status: "unavailable",
          reason: "provider_usage_missing",
          providerResponseHash: evidence?.runHash ?? null
        });
      }
      return output;
    },
    contextRequestProvider: async () => ({
      requestedFiles: [],
      requiredSymbols: [],
      reason: "CLI does not automatically widen declared context."
    }),
    coderProvider: async (context, control) => coder(provider, key, context, control),
    ...(task.costBudget ? { costBudget: task.costBudget } : {}),
    ...(task.mode === "draft"
      ? validation
        ? {
            validationProfile: validation.profile,
            draftValidation: {
              executionSpecification: validation.executionSpecification,
              containerOptions: { runtime: validation.containerRuntime }
            }
          }
        : {}
      : {
          validationProfile: validation!.profile,
          governedExecution: {
            ...validation!.governed!,
            phaseVExecutionSpecification: validation!.executionSpecification
          }
        })
  };
}

export function buildResultOutput(
  command: CliCommand,
  task: TaskFile,
  result: RunBoundedTaskResult
): CliJson {
  return {
    ok: result.decision === "bounded_task_completed",
    command,
    taskId: task.taskId,
    mode: task.mode,
    decision: result.decision,
    route: result.route,
    outcome: result.receipt?.outcome ?? null,
    receiptHash: result.receipt?.receiptHash ?? null,
    validation: result.receipt?.validationEvidence ?? result.verifierResult?.validationEvidence ?? null,
    failure: result.failure
      ? {
          code: result.failure.code,
          stage: result.failure.stage,
          route: result.failure.route,
          message: result.failure.message
        }
      : null,
    terminalCacheValidation: result.terminalCacheValidation ?? null,
    costBudget: result.summary.costBudget ?? null,
    nextStep: result.route === "replan_required"
      ? "Revise task/scope or provider plan, then run resume explicitly; no automatic replan was started."
      : result.route === "human_review_required"
        ? "Supply review evidence or revise policy, then run resume explicitly."
        : result.route === "recovery_required"
          ? "Inspect durable state and repository drift, then run recover explicitly."
          : null
  };
}

export function buildStateOutput(
  command: "status" | "inspect",
  task: TaskFile
): CliJson {
  const state = readDurableBoundedTaskState({
    registryRoot: task.durable.registryRoot,
    taskId: task.taskId,
    idempotencyKey: task.durable.idempotencyKey
  });
  const operational = summarizeDurableBoundedTask({
    registryRoot: task.durable.registryRoot,
    taskId: task.taskId,
    idempotencyKey: task.durable.idempotencyKey
  });
  const summary: CliJson = {
    ok: true,
    command,
    taskId: state.taskId,
    state: state.currentState,
    runId: state.runId,
    transitionSequence: state.transitionSequence,
    updatedAt: state.updatedAt,
    stopReason: operational.stopReason,
    operatorNextStep: operational.operatorNextStep,
    lease: operational.lease,
    cost: operational.cost,
    protected: operational.protected,
    providerIntent: state.providerIntent && {
      providerKind: state.providerIntent.providerKind,
      attempt: state.providerIntent.attempt,
      status: state.providerIntent.status,
      requestHash: state.providerIntent.requestHash,
      responseHash: state.providerIntent.responseHash
    }
  };
  return command === "status"
    ? summary
    : {
        ...summary,
        taskInputVersion: state.taskInputVersion,
        taskInputHash: state.taskInputHash,
        repositoryIdentityHash: state.repositoryIdentityHash,
        baselineSnapshotHash: state.baselineSnapshotHash,
        baselineHeadHash: state.baselineHeadHash,
        compiledPolicyHash: state.compiledPolicyHash,
        acceptanceCriteriaContractHash: state.acceptanceCriteriaContractHash,
        acceptanceEvaluationReceiptHash: state.acceptanceEvaluationReceiptHash,
        planHash: state.planHash,
        contextEvidenceHash: state.contextEvidenceHash,
        mutationArtifactHash: state.mutationArtifactHash,
        verifiedMutationHash: state.verifiedMutationHash,
        terminalResultHash: state.terminalResultHash,
        terminalRepositorySnapshotHash: state.terminalRepositorySnapshotHash,
        artifacts: state.artifacts,
        attempts: state.attempts
      };
}

export function exitForResult(result: RunBoundedTaskResult): number {
  if (result.decision === "bounded_task_completed") return 0;
  if (result.route === "recovery_required") return 4;
  return result.decision === "bounded_task_invalid" ? 2 : 3;
}
