import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBoundedPlannerProposal,
  type BoundedPlannerProposal
} from "../../../../packages/product-runtime/src/bounded-planner-proposal-contract.js";
import { hashCanonicalJson } from "../../../../packages/product-runtime/src/agent-event-ledger.js";
import type { CoderProviderContext } from "../../../../packages/product-runtime/src/coder-context-execution-gate.js";
import type {
  PlannerMinimalityProviderContext,
  PlannerMinimalityProviderOutput
} from "../../../../packages/product-runtime/src/planner-minimality-integration.js";
import type {
  RunBoundedTaskInput
} from "../../../../packages/product-runtime/src/run-bounded-task.js";
import type {
  TaskProviderControl,
  TaskProviderUsageReport
} from "../../../../packages/product-runtime/src/task-provider-deadline.js";
import type { WorkspaceMutation } from "../../../../packages/product-runtime/src/workspace-mutation.js";
import type {
  AgentAdapter,
  AgentReasoningEffort,
  AgentRunRequest,
  AgentRunResult
} from "../../../../packages/integrations/src/agent-adapter.js";
import { captureAgentMutations } from "../../../../packages/integrations/src/agent-mutation-capture.js";
import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";
import { createDisposableAgentWorkspace } from "../../../../packages/integrations/src/disposable-agent-workspace.js";

export const CODEX_BOUNDED_PROVIDER_VERSION = "codex-bounded-provider/v1" as const;

export type CodexBoundedProviderOptions = Readonly<{
  repositoryPath: string;
  sourceSnapshotHash: string;
  allowedChangeFiles: readonly string[];
  forbiddenFiles: readonly string[];
  model: string;
  adapter?: AgentAdapter;
  plannerReasoningEffort?: AgentReasoningEffort;
  coderReasoningEffort?: AgentReasoningEffort;
  providerTimeoutMs?: number;
}>;

export type CodexBoundedProviderBridge = Readonly<{
  bridgeVersion: typeof CODEX_BOUNDED_PROVIDER_VERSION;
  plannerMinimalityProvider: RunBoundedTaskInput["plannerMinimalityProvider"];
  coderProvider: RunBoundedTaskInput["coderProvider"];
}>;

export class CodexBoundedProviderError extends Error {
  readonly code = "codex_bounded_provider_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodexBoundedProviderError";
  }
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_TIMEOUT_MS = 600_000;

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new CodexBoundedProviderError(`${label} must be a plain JSON object.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new CodexBoundedProviderError(`${label} must not contain accessors.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const expected = [...fields].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new CodexBoundedProviderError(
      `${label} must contain exactly: ${expected.join(", ")}.`
    );
  }
}

function stringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new CodexBoundedProviderError(`${field} must be a bounded string array.`);
  }
  const values = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      throw new CodexBoundedProviderError(`${field} contains an invalid string.`);
    }
    return entry;
  });
  if (new Set(values).size !== values.length) {
    throw new CodexBoundedProviderError(`${field} must not contain duplicates.`);
  }
  return values.sort((left, right) => left.localeCompare(right, "en"));
}

function parsePlannerDraft(
  finalMessage: string,
  context: PlannerMinimalityProviderContext
): PlannerMinimalityProviderOutput {
  let value: unknown;
  try {
    const text = finalMessage.trim();
    if (!text.startsWith("{") || !text.endsWith("}")) throw new Error("not-object");
    value = JSON.parse(text);
  } catch {
    throw new CodexBoundedProviderError(
      "Codex planner final message must contain exactly one JSON object."
    );
  }

  const top = plainObject(value, "Codex planner output");
  exactFields(top, ["proposal", "minimalityPlan"], "Codex planner output");
  const raw = plainObject(top.proposal, "Codex planner proposal draft");
  exactFields(
    raw,
    [
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
    ],
    "Codex planner proposal draft"
  );

  if (
    raw.proposalVersion !== "1" ||
    raw.taskId !== context.taskId ||
    raw.objectiveHash !== context.objectiveHash ||
    raw.acceptanceContractHash !== context.acceptanceContractHash ||
    raw.authorityHash !== context.authorityHash ||
    raw.policyHash !== context.policyHash
  ) {
    throw new CodexBoundedProviderError(
      "Codex planner proposal identity must exactly match the runtime context."
    );
  }

  const seedFiles = stringArray(raw.seedFiles, "proposal.seedFiles", context.limits.maxSeedFiles);
  const requiredSymbols = stringArray(
    raw.requiredSymbols,
    "proposal.requiredSymbols",
    context.limits.maxRequiredSymbols
  );
  const requiredTestFiles = stringArray(
    raw.requiredTestFiles,
    "proposal.requiredTestFiles",
    context.limits.maxRequiredTests
  );
  if (
    raw.maxExpansionAttempts !== 1 &&
    raw.maxExpansionAttempts !== 2
  ) {
    throw new CodexBoundedProviderError("proposal.maxExpansionAttempts must be 1 or 2.");
  }
  if (raw.maxExpansionAttempts > context.limits.maxExpansionAttempts) {
    throw new CodexBoundedProviderError(
      "proposal.maxExpansionAttempts exceeds the runtime limit."
    );
  }
  if (!Array.isArray(raw.seedRationales) || raw.seedRationales.length !== seedFiles.length) {
    throw new CodexBoundedProviderError(
      "proposal.seedRationales must contain one rationale per seed file."
    );
  }

  const rationaleByPath = new Map<string, string>();
  for (const entry of raw.seedRationales) {
    const rationale = plainObject(entry, "Codex planner seed rationale");
    exactFields(rationale, ["path", "reason"], "Codex planner seed rationale");
    if (
      typeof rationale.path !== "string" ||
      typeof rationale.reason !== "string" ||
      rationale.reason.trim().length === 0
    ) {
      throw new CodexBoundedProviderError("Codex planner seed rationale is invalid.");
    }
    if (rationaleByPath.has(rationale.path)) {
      throw new CodexBoundedProviderError("Codex planner seed rationales contain duplicates.");
    }
    rationaleByPath.set(rationale.path, rationale.reason.trim());
  }
  if (seedFiles.some((path) => !rationaleByPath.has(path))) {
    throw new CodexBoundedProviderError(
      "Codex planner seed rationale paths must match seedFiles exactly."
    );
  }

  const withoutHash: Omit<BoundedPlannerProposal, "proposalHash"> = {
    proposalVersion: "1",
    taskId: context.taskId,
    objectiveHash: context.objectiveHash,
    acceptanceContractHash: context.acceptanceContractHash,
    authorityHash: context.authorityHash,
    policyHash: context.policyHash,
    seedFiles,
    seedRationales: seedFiles.map((path) => ({
      path,
      reasonHash: hashCanonicalJson({
        artifactType: "bounded_planner_seed_rationale",
        path,
        reason: rationaleByPath.get(path)!
      })
    })),
    requiredSymbols,
    requiredTestFiles,
    maxExpansionAttempts: raw.maxExpansionAttempts
  };
  const proposal = createBoundedPlannerProposal({
    rawProposal: {
      ...withoutHash,
      proposalHash: hashCanonicalJson({
        proposalVersion: withoutHash.proposalVersion,
        taskId: withoutHash.taskId,
        objectiveHash: withoutHash.objectiveHash,
        acceptanceContractHash: withoutHash.acceptanceContractHash,
        authorityHash: withoutHash.authorityHash,
        policyHash: withoutHash.policyHash,
        seedFiles: withoutHash.seedFiles,
        seedRationales: withoutHash.seedRationales,
        requiredSymbols: withoutHash.requiredSymbols,
        requiredTestFiles: withoutHash.requiredTestFiles,
        maxExpansionAttempts: withoutHash.maxExpansionAttempts
      })
    },
    expectedTaskId: context.taskId,
    expectedObjectiveHash: context.objectiveHash,
    expectedAcceptanceContractHash: context.acceptanceContractHash,
    expectedAuthorityHash: context.authorityHash,
    expectedPolicyHash: context.policyHash,
    limits: context.limits
  });

  // The existing planner-minimality coordinator owns minimality validation.
  // This bridge only prevents Codex from supplying cryptographic proposal hashes.
  plainObject(top.minimalityPlan, "Codex minimality plan draft");
  return Object.freeze({ proposal, minimalityPlan: top.minimalityPlan });
}

function providerResponseHash(result: AgentRunResult): string {
  return hashCanonicalJson({
    agentId: result.agentId,
    agentVersion: result.agentVersion,
    modelId: result.modelId,
    status: result.status,
    durationMs: result.durationMs,
    finalMessage: result.finalMessage,
    usage: result.usage,
    commands: result.commands,
    fileChanges: result.fileChanges,
    diagnostics: result.diagnostics
  });
}

function reportCodexUsage(result: AgentRunResult, control: TaskProviderControl): void {
  if (control.reportUsage === undefined) return;
  const responseHash = providerResponseHash(result);
  const { inputTokens, outputTokens, totalTokens } = result.usage;
  if (
    Number.isSafeInteger(inputTokens) &&
    inputTokens !== null &&
    inputTokens >= 0 &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens !== null &&
    outputTokens >= 0 &&
    Number.isSafeInteger(totalTokens) &&
    totalTokens !== null &&
    totalTokens >= 0 &&
    totalTokens === inputTokens + outputTokens
  ) {
    const usage: TaskProviderUsageReport = {
      status: "observed",
      inputTokens,
      outputTokens,
      totalTokens,
      providerResponseHash: responseHash,
      providerRequestId: null
    };
    control.reportUsage(usage);
    return;
  }
  control.reportUsage({
    status: "unavailable",
    reason: "provider_usage_missing",
    providerResponseHash: responseHash
  });
}

function remainingTimeout(control: TaskProviderControl, configured: number): number {
  const remaining = Math.floor(control.deadlineAt - Date.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || control.signal.aborted) {
    throw new CodexBoundedProviderError("Codex provider deadline was exhausted before the run started.");
  }
  return Math.max(1, Math.min(configured, remaining));
}

function validateOptions(options: CodexBoundedProviderOptions): Required<Pick<
  CodexBoundedProviderOptions,
  "repositoryPath" | "sourceSnapshotHash" | "allowedChangeFiles" | "forbiddenFiles" | "model"
>> & Readonly<{
  adapter: AgentAdapter;
  plannerReasoningEffort: AgentReasoningEffort;
  coderReasoningEffort: AgentReasoningEffort;
  providerTimeoutMs: number;
}> {
  if (typeof options.repositoryPath !== "string" || options.repositoryPath.length === 0) {
    throw new CodexBoundedProviderError("repositoryPath is required.");
  }
  if (typeof options.sourceSnapshotHash !== "string" || !HASH.test(options.sourceSnapshotHash)) {
    throw new CodexBoundedProviderError("sourceSnapshotHash must be a sha256 hash.");
  }
  if (typeof options.model !== "string" || !IDENTIFIER.test(options.model)) {
    throw new CodexBoundedProviderError("model must be a bounded identifier.");
  }
  const normalizePaths = (values: readonly string[], field: string): string[] => {
    if (!Array.isArray(values) || values.length > 1000) {
      throw new CodexBoundedProviderError(`${field} must be a bounded array.`);
    }
    const normalized = values.map((value) => {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.trim() !== value ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw new CodexBoundedProviderError(`${field} contains an unsafe repository-relative path.`);
      }
      return value;
    });
    if (new Set(normalized).size !== normalized.length) {
      throw new CodexBoundedProviderError(`${field} must not contain duplicates.`);
    }
    return normalized.sort((left, right) => left.localeCompare(right, "en"));
  };
  const allowedChangeFiles = normalizePaths(options.allowedChangeFiles, "allowedChangeFiles");
  if (allowedChangeFiles.length === 0) {
    throw new CodexBoundedProviderError("allowedChangeFiles must not be empty.");
  }
  const forbiddenFiles = normalizePaths(options.forbiddenFiles, "forbiddenFiles");
  if (allowedChangeFiles.some((path) => forbiddenFiles.includes(path))) {
    throw new CodexBoundedProviderError("allowedChangeFiles and forbiddenFiles must not overlap.");
  }
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs <= 0 ||
    providerTimeoutMs > MAX_PROVIDER_TIMEOUT_MS
  ) {
    throw new CodexBoundedProviderError("providerTimeoutMs is outside its permitted range.");
  }
  return Object.freeze({
    repositoryPath: options.repositoryPath,
    sourceSnapshotHash: options.sourceSnapshotHash,
    allowedChangeFiles: Object.freeze(allowedChangeFiles),
    forbiddenFiles: Object.freeze(forbiddenFiles),
    model: options.model,
    adapter: options.adapter ?? new CodexAgentAdapter(),
    plannerReasoningEffort: options.plannerReasoningEffort ?? "medium",
    coderReasoningEffort: options.coderReasoningEffort ?? "medium",
    providerTimeoutMs
  });
}

function plannerPrompt(context: PlannerMinimalityProviderContext): string {
  return [
    "You are the bounded Codex planner provider for an existing canonical coordinator.",
    "Return ONLY one JSON object with exactly proposal and minimalityPlan. No markdown.",
    "Do not compute or return proposalHash, reasonHash, content hashes, or any cryptographic hash.",
    "proposal must contain exactly proposalVersion, taskId, objectiveHash, acceptanceContractHash, authorityHash, policyHash, seedFiles, seedRationales, requiredSymbols, requiredTestFiles, maxExpansionAttempts.",
    "Each seedRationale must be exactly {path, reason}. Copy all identity hashes from the input exactly.",
    "minimalityPlan must follow the existing preventive-minimality v1 draft contract.",
    "Use only repository-relative paths already present in taskContext or allowedChangeFiles.",
    "Prefer the smallest defensible existing-code change set and never request new files for Product V1.",
    JSON.stringify(context)
  ].join("\n");
}

function coderPrompt(
  context: CoderProviderContext,
  allowedChangeFiles: readonly string[]
): string {
  return [
    "You are the bounded Codex coder inside an isolated disposable Git workspace.",
    "Edit files in the working directory directly. Do not return a patch or WorkspaceMutation JSON.",
    "Only modify existing regular UTF-8 files. Never add, delete, rename, copy, chmod, or create symlinks.",
    `Only these paths may be modified: ${JSON.stringify(allowedChangeFiles)}.`,
    "Do not configure remotes or object alternates. Do not access the source repository.",
    "The runtime will deterministically capture git diff and derive expectedContentHash from its pre-agent manifest.",
    "Bounded coder context follows:",
    JSON.stringify(context)
  ].join("\n");
}

function assertCompleted(result: AgentRunResult, phase: "planner" | "coder"): void {
  if (result.status !== "completed") {
    const diagnostic = result.diagnostics.find((entry) => entry.severity === "error");
    throw new CodexBoundedProviderError(
      `Codex ${phase} run ended with status=${result.status}${diagnostic ? `: ${diagnostic.code}` : ""}.`
    );
  }
}

export function createCodexBoundedProvider(
  input: CodexBoundedProviderOptions
): CodexBoundedProviderBridge {
  const options = validateOptions(input);

  const plannerMinimalityProvider: RunBoundedTaskInput["plannerMinimalityProvider"] = async (
    context,
    control
  ) => {
    const plannerRoot = await mkdtemp(join(tmpdir(), "bounded-codex-planner-"));
    try {
      const request: AgentRunRequest = {
        runId: `planner.${context.taskId}`,
        agentId: options.adapter.agentId,
        workingDirectory: plannerRoot,
        task: plannerPrompt(context),
        model: options.model,
        reasoningEffort: options.plannerReasoningEffort,
        mode: "planner",
        timeoutMs: remainingTimeout(control, options.providerTimeoutMs),
        networkAllowed: false,
        sandboxMode: "read_only",
        abortSignal: control.signal
      };
      const result = await options.adapter.run(request);
      reportCodexUsage(result, control);
      assertCompleted(result, "planner");
      return parsePlannerDraft(result.finalMessage, context);
    } finally {
      await rm(plannerRoot, { recursive: true, force: true });
    }
  };

  const coderProvider: RunBoundedTaskInput["coderProvider"] = async (
    context,
    control
  ): Promise<WorkspaceMutation> => {
    const repositoryPath = await realpath(options.repositoryPath).catch(() => {
      throw new CodexBoundedProviderError("repositoryPath cannot be resolved.");
    });
    const visibleFiles = [...new Set(context.evidence.map((entry) => entry.path))].sort(
      (left, right) => left.localeCompare(right, "en")
    );
    if (visibleFiles.length === 0) {
      throw new CodexBoundedProviderError("Coder context exposes no repository files.");
    }
    const visibleSet = new Set(visibleFiles);
    const changeAllowedFiles = options.allowedChangeFiles.filter((path) => visibleSet.has(path));
    if (changeAllowedFiles.length === 0) {
      throw new CodexBoundedProviderError(
        "Coder context does not expose any task-authorized change file."
      );
    }

    let workspacePath: string | null = null;
    try {
      const workspace = await createDisposableAgentWorkspace({
        repositoryPath,
        sourceSnapshotHash: options.sourceSnapshotHash,
        visibleFiles,
        changeAllowedFiles,
        forbiddenFiles: options.forbiddenFiles,
        mode: "bounded"
      });
      workspacePath = workspace.workspacePath;

      const request: AgentRunRequest = {
        runId: `coder.${hashCanonicalJson({
          sourceSnapshotHash: options.sourceSnapshotHash,
          visibleFiles,
          manifestHash: workspace.manifestHash
        }).slice("sha256:".length, "sha256:".length + 32)}`,
        agentId: options.adapter.agentId,
        workingDirectory: workspace.workspacePath,
        task: coderPrompt(context, changeAllowedFiles),
        model: options.model,
        reasoningEffort: options.coderReasoningEffort,
        mode: "coder",
        timeoutMs: remainingTimeout(control, options.providerTimeoutMs),
        networkAllowed: false,
        sandboxMode: "workspace_write",
        abortSignal: control.signal
      };
      const result = await options.adapter.run(request);
      reportCodexUsage(result, control);
      assertCompleted(result, "coder");

      const captured = await captureAgentMutations({
        workspacePath: workspace.workspacePath,
        sourceManifest: workspace.manifest
      });
      const allowed = new Set(changeAllowedFiles);
      const unauthorized = captured.changedFiles.find((path) => !allowed.has(path));
      if (unauthorized !== undefined) {
        throw new CodexBoundedProviderError(
          `Codex changed a file outside the task-authorized change set: ${unauthorized}.`
        );
      }
      return captured.mutation;
    } finally {
      if (workspacePath !== null) {
        await rm(workspacePath, { recursive: true, force: true });
      }
    }
  };

  return Object.freeze({
    bridgeVersion: CODEX_BOUNDED_PROVIDER_VERSION,
    plannerMinimalityProvider,
    coderProvider
  });
}
