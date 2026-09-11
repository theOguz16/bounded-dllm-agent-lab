import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalizeRepositoryRelativePath,
  compileCanonicalPolicy,
  createAcceptanceCriteriaContract,
  createCanonicalRepositoryContentSnapshot,
  createPreventiveMinimalityPolicy,
  hashCanonicalJson,
  runBoundedTask,
  type RunBoundedTaskInput,
  type RunBoundedTaskResult,
  type TemporaryWorkspaceExecutionSpecification,
  type ValidationCheckStatus,
  type ValidationProfileId
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import {
  CodexAgentAdapter
} from "../../../../packages/integrations/src/codex-agent-adapter.js";
import type {
  AgentAdapter,
  AgentRunRequest,
  AgentRunResult
} from "../../../../packages/integrations/src/agent-adapter.js";
import { createCodexBoundedProvider } from "../providers/codex-bounded-provider.js";
import { CliError } from "../cli-errors.js";
import type { CliCommandResult } from "../bounded-task.js";
import { exitForResult } from "../bounded-task.js";
import {
  BOUNDED_POLICY_PATH,
  doctorBoundedLocalConfig,
  type BoundedLocalConfig
} from "../product-config.js";
import {
  BOUNDED_CODEX_CHECKPOINT_VERSION,
  createCodexDurableRecoveryBridge
} from "../run-artifact-store.js";

export const BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION =
  "bounded-codex-explicit-scope/v0" as const;
export const BOUNDED_CODEX_REASONING = "medium" as const;
export const BOUNDED_CODEX_VALIDATION_PROFILE =
  "existing_function_bug_fix" as const satisfies ValidationProfileId;

const MAX_TASK_LENGTH = 32_768;
const MAX_ALLOW_FILES = 32;
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export type CodexExplicitScopeCommandInput = Readonly<{
  task: string;
  allowFiles: readonly string[];
}>;

type RecordedAgentRun = Readonly<{
  request: AgentRunRequest;
  result: AgentRunResult;
}>;

export type CodexCommandDependencies = Readonly<{
  adapter?: AgentAdapter;
  model?: string;
  runTask?: (input: RunBoundedTaskInput) => Promise<RunBoundedTaskResult>;
  validationProfile?: ValidationProfileId;
}>;

type SourceState = Readonly<{
  snapshotHash: string;
  head: string | null;
  statusHash: string;
}>;

function requireTask(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TASK_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new CliError(
      "cli_codex_task_invalid",
      "--task must be a bounded non-empty task description."
    );
  }
  return value;
}

function normalizeAllowFiles(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ALLOW_FILES) {
    throw new CliError(
      "cli_codex_scope_invalid",
      `--allow must be provided between 1 and ${MAX_ALLOW_FILES} times.`
    );
  }
  const normalized = values.map((value) => {
    try {
      return canonicalizeRepositoryRelativePath(value);
    } catch {
      throw new CliError(
        "cli_codex_scope_invalid",
        `Invalid repository-relative --allow path: ${String(value)}.`
      );
    }
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new CliError("cli_codex_scope_invalid", "Duplicate --allow paths are not permitted.");
  }
  return normalized.sort((left, right) => left.localeCompare(right, "en"));
}

function looksLikeTestPath(file: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(file);
}

function selectScript(values: readonly string[], preferred: readonly string[]): string | null {
  for (const candidate of preferred) {
    if (values.includes(candidate)) return candidate;
  }
  return values[0] ?? null;
}

function validationSpecification(config: BoundedLocalConfig): TemporaryWorkspaceExecutionSpecification {
  if (!config.packageJson.detected) {
    throw new CliError(
      "cli_codex_package_json_required",
      "bounded codex V0 currently requires a JavaScript/TypeScript package.json repository."
    );
  }
  const test = selectScript(config.scripts.test, ["test"]);
  const typecheck = selectScript(
    config.scripts.typecheck,
    ["typecheck", "type-check", "check:types", "check-types", "types:check"]
  );
  if (test === null || typecheck === null) {
    throw new CliError(
      "cli_codex_validation_commands_missing",
      "bounded codex V0 requires detected test and typecheck scripts. Run bounded doctor."
    );
  }
  const syntax = selectScript(config.scripts.build, ["build"]) ?? typecheck;
  return {
    commands: [
      {
        id: "validation.syntax",
        checkKind: "syntax",
        executable: "npm",
        args: ["run", syntax],
        timeoutMs: 120_000,
        expectedExitCodes: [0]
      },
      {
        id: "validation.typecheck",
        checkKind: "typecheck",
        executable: "npm",
        args: ["run", typecheck],
        timeoutMs: 120_000,
        expectedExitCodes: [0]
      },
      {
        id: "validation.test",
        checkKind: "behavior_test",
        executable: "npm",
        args: ["run", test],
        timeoutMs: 120_000,
        expectedExitCodes: [0]
      }
    ],
    allowedExecutables: ["npm"],
    maxCommands: 3,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 120_000,
    maxOutputChars: 20_000,
    environment: { CI: "1" }
  };
}

async function noSymlinkComponents(repositoryRoot: string, relative: string): Promise<void> {
  let cursor = repositoryRoot;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor).catch(() => null);
    if (stat === null) {
      throw new CliError("cli_codex_scope_file_missing", `Allowed file does not exist: ${relative}.`);
    }
    if (stat.isSymbolicLink()) {
      throw new CliError("cli_codex_scope_file_unsafe", `Allowed path contains a symlink: ${relative}.`);
    }
  }
}

async function initialEvidence(repositoryRoot: string, files: readonly string[]) {
  const entries = [] as Array<{
    path: string;
    source: string;
    content: string;
    contentHash: string;
    byteLength: number;
    estimatedTokens: number;
    matchedSymbols: readonly string[];
  }>;
  let totalBytes = 0;
  for (const file of files) {
    await noSymlinkComponents(repositoryRoot, file);
    const absolute = path.join(repositoryRoot, file);
    const stat = await lstat(absolute);
    if (!stat.isFile()) {
      throw new CliError("cli_codex_scope_file_unsafe", `Allowed path is not a regular file: ${file}.`);
    }
    const bytes = await readFile(absolute);
    totalBytes += bytes.length;
    if (bytes.length > MAX_CONTEXT_FILE_BYTES || totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new CliError(
        "cli_codex_scope_too_large",
        "Explicit scope exceeds the bounded initial context byte limit."
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliError("cli_codex_scope_file_unsafe", `Allowed file is not strict UTF-8 text: ${file}.`);
    }
    if (content.includes("\u0000")) {
      throw new CliError("cli_codex_scope_file_unsafe", `Allowed file contains binary NUL data: ${file}.`);
    }
    entries.push(Object.freeze({
      path: file,
      source: "bounded_codex_explicit_scope_v0",
      content,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: Object.freeze([] as string[])
    }));
  }
  return Object.freeze(entries);
}

function configuredCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

async function resolveCodexModel(override?: string): Promise<string> {
  const environmentCandidates = [
    override,
    process.env.BOUNDED_CODEX_MODEL,
    process.env.CODEX_MODEL,
    process.env.OPENAI_MODEL
  ];
  for (const candidate of environmentCandidates) {
    if (typeof candidate === "string" && MODEL.test(candidate.trim())) return candidate.trim();
  }

  const file = path.join(configuredCodexHome(), "config.toml");
  try {
    const data = await readFile(file);
    if (data.length > 0 && data.length <= MAX_CODEX_CONFIG_BYTES) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
        if (match && MODEL.test(match[1]!)) return match[1]!;
      }
    }
  } catch {
    // Missing/unreadable Codex config is reported below without exposing local paths.
  }
  throw new CliError(
    "cli_codex_model_missing",
    "Codex model is not configured. Set CODEX_MODEL or configure model in CODEX_HOME/config.toml.",
    5
  );
}

function commandOutput(result: ReturnType<typeof spawnSync>, label: string): string {
  if (result.error || result.status !== 0) {
    throw new CliError("cli_codex_repository_state_unavailable", `${label} could not be inspected.`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function gitState(repositoryRoot: string): Readonly<{ head: string | null; statusHash: string }> {
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
  );
  const statusText = commandOutput(status, "Git worktree state");
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000
  });
  const headText = head.error || head.status !== 0 ? null : String(head.stdout).trim();
  return Object.freeze({
    head: headText && /^[0-9a-f]{40,64}$/i.test(headText) ? headText.toLowerCase() : null,
    statusHash: `sha256:${createHash("sha256").update(statusText).digest("hex")}`
  });
}

function captureSourceState(repositoryRoot: string): SourceState {
  const snapshot = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  const git = gitState(repositoryRoot);
  return Object.freeze({ snapshotHash: snapshot.snapshotHash, head: git.head, statusHash: git.statusHash });
}

function sameSourceState(left: SourceState, right: SourceState): boolean {
  return left.snapshotHash === right.snapshotHash && left.head === right.head &&
    left.statusHash === right.statusHash;
}

function recordingAdapter(adapter: AgentAdapter, runs: RecordedAgentRun[]): AgentAdapter {
  return Object.freeze({
    agentId: adapter.agentId,
    agentVersion: adapter.agentVersion,
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      const result = await adapter.run(request);
      runs.push(Object.freeze({ request, result }));
      return result;
    }
  });
}

function sumObserved(
  runs: readonly RecordedAgentRun[],
  read: (result: AgentRunResult) => number | null | undefined
): number | null {
  if (runs.length === 0) return null;
  let total = 0;
  for (const run of runs) {
    const value = read(run.result);
    if (!Number.isSafeInteger(value) || value === null || value === undefined || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function validationStatus(status: ValidationCheckStatus | undefined): "PASS" | "FAIL" | "NOT_RUN" {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  return "NOT_RUN";
}

function contextExposure(result: RunBoundedTaskResult): Readonly<{ fileCount: number; bytes: number }> {
  const context = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.context;
  if (!context) return Object.freeze({ fileCount: 0, bytes: 0 });
  const byPath = new Map<string, number>();
  for (const evidence of context.evidence) byPath.set(evidence.path, evidence.byteLength);
  let bytes = 0;
  for (const value of byPath.values()) bytes += value;
  return Object.freeze({ fileCount: byPath.size, bytes });
}

function candidateFiles(result: RunBoundedTaskResult): readonly string[] {
  if (result.verifierResult) {
    return Object.freeze([...new Set(result.verifierResult.canonicalTouchedFiles)].sort());
  }
  const mutation = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult
    ?.coderResult?.providerOutput;
  return Object.freeze([...(mutation?.touchedFiles ?? [])].sort());
}

function createMinimalityPolicy(maxPlannedFiles: number) {
  return createPreventiveMinimalityPolicy({
    policyVersion: "1",
    policyId: "bounded-codex-explicit-scope-v0",
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
    maxPlannedFiles,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });
}

export async function codexCommand(
  raw: CodexExplicitScopeCommandInput,
  startPath = process.cwd(),
  dependencies: CodexCommandDependencies = {}
): Promise<CliCommandResult> {
  const task = requireTask(raw.task);
  const allowFiles = normalizeAllowFiles(raw.allowFiles);
  const diagnosed = await doctorBoundedLocalConfig(startPath);
  const repositoryRoot = await realpath(diagnosed.repositoryRoot);
  if (!diagnosed.config.packageJson.detected && !diagnosed.config.typescript.detected) {
    throw new CliError(
      "cli_codex_repository_type_unsupported",
      "bounded codex V0 currently supports JavaScript/TypeScript repositories only."
    );
  }

  const policy = compileCanonicalPolicy({
    repositoryPath: repositoryRoot,
    policyFilePath: path.join(repositoryRoot, BOUNDED_POLICY_PATH)
  });
  const policyAllowed = new Set(policy.allowedPaths);
  const policyForbidden = new Set(policy.forbiddenPaths);
  const blocked = allowFiles.find((file) => !policyAllowed.has(file) || policyForbidden.has(file));
  if (blocked) {
    throw new CliError(
      "cli_codex_scope_policy_blocked",
      `Explicit scope is not writable under the compiled policy: ${blocked}.`
    );
  }

  const evidence = await initialEvidence(repositoryRoot, allowFiles);
  const specification = validationSpecification(diagnosed.config);
  const sourceBefore = captureSourceState(repositoryRoot);
  const sourceSnapshotHash = sourceBefore.snapshotHash;
  const model = await resolveCodexModel(dependencies.model);
  const taskId = `codex.${hashCanonicalJson({
    version: BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
    sourceSnapshotHash,
    task,
    allowFiles
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const objectiveHash = hashCanonicalJson({ objective: task });
  const requiredTestFiles = allowFiles.filter(looksLikeTestPath);
  const acceptanceCriteriaContract = createAcceptanceCriteriaContract({
    taskId,
    objectiveHash,
    criteria: [{
      id: "requested_behavior",
      description: task.slice(0, 1000),
      required: true,
      evidence: { kind: "test", commandId: "validation.test" }
    }]
  });
  const recovery = createCodexDurableRecoveryBridge({ repositoryRoot, taskId });

  const recordedRuns: RecordedAgentRun[] = [];
  const adapter = recordingAdapter(dependencies.adapter ?? new CodexAgentAdapter(), recordedRuns);
  const bridge = createCodexBoundedProvider({
    repositoryPath: repositoryRoot,
    sourceSnapshotHash,
    allowedChangeFiles: allowFiles,
    forbiddenFiles: [],
    model,
    adapter,
    plannerReasoningEffort: BOUNDED_CODEX_REASONING,
    coderReasoningEffort: BOUNDED_CODEX_REASONING,
    providerTimeoutMs: 120_000
  });
  const validationProfile = dependencies.validationProfile ?? BOUNDED_CODEX_VALIDATION_PROFILE;
  const input: RunBoundedTaskInput = {
    repositoryPath: repositoryRoot,
    taskId,
    objectiveHash,
    acceptanceCriteriaContract,
    authorityHash: hashCanonicalJson({
      authority: BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
      taskId,
      allowedChangeFiles: allowFiles
    }),
    policyHash: policy.compiledPolicyHash,
    proposalLimits: {
      maxSeedFiles: allowFiles.length,
      maxRequiredSymbols: 0,
      maxRequiredTests: requiredTestFiles.length,
      maxExpansionAttempts: 1
    },
    minimalityPolicy: createMinimalityPolicy(allowFiles.length),
    allowedChangeFiles: allowFiles,
    forbiddenFiles: [],
    canonicalPolicy: { compiledPolicy: policy },
    taskContext: {
      objective: task,
      seedFiles: allowFiles,
      requiredSymbols: [],
      requiredTestFiles,
      explicitScopeVersion: BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION
    },
    initialEvidence: evidence,
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: 16_384,
    reservedOutputTokens: 2_048,
    timeoutMs: 300_000,
    durableTask: recovery.durableTask,
    plannerMinimalityProvider: bridge.plannerMinimalityProvider,
    coderProvider: bridge.coderProvider,
    contextRequestProvider: async (state) => {
      const visible = new Set(state.visibleEvidence.map((entry) => entry.path));
      const requestedFiles = state.requiredSourceFiles
        .filter((file) => !visible.has(file))
        .sort((left, right) => left.localeCompare(right, "en"));
      const requestedTests = state.requiredTestFiles
        .filter((file) => !visible.has(file))
        .sort((left, right) => left.localeCompare(right, "en"));
      return {
        requestedFiles,
        requestedSymbols: [...state.requiredSymbols],
        requestedTests,
        evidenceKinds: ["direct_dependency", "required_test"] as const,
        reason: "Load only missing repository-intelligence-derived dependency/test context for explicit-scope V0.",
        scopeExpansionRequested: false,
        maxAdditionalTokens: 4096
      };
    },
    validationProfile,
    draftValidation: {
      executionSpecification: specification,
      containerOptions: { runtime: "docker" }
    }
    // Apply remains a separate explicit approval step. Durable state is canonical now;
    // no Codex-specific resume state machine is introduced here.
  };

  let result: RunBoundedTaskResult;
  let runError: unknown = null;
  try {
    result = await (dependencies.runTask ?? runBoundedTask)(input);
  } catch (error) {
    runError = error;
    result = null as never;
  }
  const sourceAfter = captureSourceState(repositoryRoot);
  if (!sameSourceState(sourceBefore, sourceAfter)) {
    throw new CliError(
      "cli_codex_source_repository_changed",
      "Source repository changed during bounded codex execution; no apply was authorized.",
      4
    );
  }
  if (runError !== null) throw runError;

  const exposure = contextExposure(result);
  const changedFiles = candidateFiles(result);
  const validationEvidence = result.verifierResult?.validationEvidence;
  const typecheck = validationEvidence?.checks.find((entry) => entry.kind === "typecheck");
  const tests = validationEvidence?.checks.find((entry) => entry.kind === "behavior_test");
  const scopeStatus = result.verifierResult?.decision === "approve" ? "PASS" :
    result.verifierResult ? "FAIL" : "NOT_RUN";
  const testStatus = validationStatus(tests?.status);
  const actualModel = recordedRuns.at(-1)?.result.modelId ?? model;
  const behavior = testStatus === "PASS" && requiredTestFiles.length > 0
    ? "PASS" as const
    : "NOT_DEMONSTRATED" as const;

  const output = {
    ok: result.decision === "bounded_task_completed",
    command: "codex",
    explicitScopeVersion: BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
    taskId,
    agent: "Codex",
    model: actualModel,
    reasoning: BOUNDED_CODEX_REASONING,
    recovery: {
      checkpointVersion: BOUNDED_CODEX_CHECKPOINT_VERSION,
      authority: "canonical_bounded_task_state",
      registryRoot: recovery.registryRoot,
      idempotencyKey: recovery.idempotencyKey,
      checkpointFile: recovery.checkpointFile
    },
    context: {
      fileCount: exposure.fileCount,
      bytes: exposure.bytes
    },
    tokens: {
      input: sumObserved(recordedRuns, (run) => run.usage.inputTokens),
      cached: sumObserved(recordedRuns, (run) => run.usage.cachedInputTokens),
      output: sumObserved(recordedRuns, (run) => run.usage.outputTokens),
      reasoning: null,
      total: sumObserved(recordedRuns, (run) => run.usage.totalTokens)
    },
    candidate: {
      changedFileCount: changedFiles.length,
      files: changedFiles
    },
    validation: {
      scope: scopeStatus,
      typecheck: validationStatus(typecheck?.status),
      tests: testStatus,
      behavior
    },
    decision: result.decision,
    route: result.route,
    outcome: result.receipt?.outcome ?? null,
    apply: "NOT_RUN",
    sourceRepositoryUnchanged: true,
    failure: result.failure
      ? {
          code: result.failure.code,
          stage: result.failure.stage,
          route: result.failure.route,
          message: result.failure.message
        }
      : null
  };

  return { output, exitCode: exitForResult(result) };
}
