import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compileCanonicalPolicy,
  createAgentComparisonContract,
  createCanonicalRepositoryContentSnapshot,
  evaluateProductComparison,
  hashCanonicalJson,
  parseTextFileUpdates,
  runBoundedTask,
  type ProductComparisonEvaluation,
  type RunBoundedTaskInput,
  type RunBoundedTaskResult
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";
import {
  createDisposableAgentWorkspace,
  executionOrderForTaskHash,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRunResult,
  type ComparativeAgentExecutionOrder
} from "../../../../packages/integrations/src/index.js";
import { CliError } from "../cli-errors.js";
import type { CliCommandResult } from "../bounded-task.js";
import {
  BOUNDED_POLICY_PATH,
  doctorBoundedLocalConfig,
  type BoundedLocalConfig
} from "../product-config.js";
import {
  CodexScopeDiscoveryError,
  discoverCodexScope,
  type CodexScopeDiscoveryResult
} from "../providers/codex-scope-discovery.js";
import { codexCommand } from "./codex.js";
import { createCandidateHandoffFromBoundedRun } from "../candidate-handoff.js";
import {
  COMPARE_VALIDATION_SUBSTRATE_VERSION,
  COMPARE_VALIDATION_TIMEOUT_MS,
  prepareCompareValidationSubstrate,
  runCompareValidation,
  type CompareCandidateChange,
  type CompareValidationResult,
  type CompareValidationSpec
} from "../compare-validation-substrate.js";

export const BOUNDED_COMPARE_CODEX_VERSION = "bounded-compare-codex/v1" as const;
export const BOUNDED_COMPARE_RUNTIME_VERSION = "canonical-bounded-compare/v1" as const;
export const BOUNDED_COMPARE_REASONING = "medium" as const;
export const BOUNDED_COMPARE_DISCOVERY_TIMEOUT_MS = 180_000;
export const BOUNDED_COMPARE_AGENT_TIMEOUT_MS = 300_000;
export const BOUNDED_COMPARE_TIMEOUT_MS = BOUNDED_COMPARE_AGENT_TIMEOUT_MS;
export const BOUNDED_COMPARE_NETWORK_POLICY = "disabled" as const;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MAX_TASK_LENGTH = 32_768;

export type CompareCodexCommandInput = Readonly<{ task: string }>;

type ArmDisplayMetrics = Readonly<{
  behavior: boolean | null;
  controls: boolean | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  exposedFiles: number | null;
  exposedBytes: number | null;
  changedFiles: number | null;
  scopeViolations: number | null;
  commands: number | null;
  failedCommands: number | null;
  repairRounds: number | null;
  durationMs: number | null;
}>;

type ArmRuntimeObservation = Readonly<{
  status: string;
  failureCode: string | null;
  validationFailureCode: string | null;
}>;

type UsageObservation = Readonly<{
  inputTokens: number | null;
  cachedInputTokens?: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

type ArmExecution = Readonly<{
  evaluation: ProductComparisonEvaluation;
  display: ArmDisplayMetrics;
  runtime: ArmRuntimeObservation;
}>;

export type CompareCodexOutput = Readonly<{
  ok: boolean;
  command: "compare";
  target: "codex";
  compareVersion: typeof BOUNDED_COMPARE_CODEX_VERSION;
  comparisonRuntimeVersion: typeof BOUNDED_COMPARE_RUNTIME_VERSION;
  task: string;
  comparable: boolean;
  identityMismatchFields: readonly string[];
  executionOrder: ComparativeAgentExecutionOrder;
  model: string;
  reasoning: typeof BOUNDED_COMPARE_REASONING;
  timeoutMs: number;
  budgets: Readonly<{
    discoveryMs: number;
    agentMs: number;
    validationCommandMs: number;
  }>;
  networkPolicy: typeof BOUNDED_COMPARE_NETWORK_POLICY;
  discovery: Readonly<{
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    visibleFileCount: number;
    visibleBytes: number;
    durationMs: number;
  }>;
  validationSubstrate: Readonly<{
    version: typeof COMPARE_VALIDATION_SUBSTRATE_VERSION;
    dependencySnapshotHash: string;
    prepared: boolean;
  }>;
  normal: ArmDisplayMetrics;
  bounded: ArmDisplayMetrics;
  runtime: Readonly<{
    normal: ArmRuntimeObservation;
    bounded: ArmRuntimeObservation;
  }>;
  evaluations: Readonly<{
    normal: ProductComparisonEvaluation;
    bounded: ProductComparisonEvaluation;
  }>;
  table: string;
  sourceRepositoryUnchanged: true;
}>;

export type CompareCodexDependencies = Readonly<{
  adapter?: AgentAdapter;
  model?: string;
  discover?: typeof discoverCodexScope;
  runTask?: (input: RunBoundedTaskInput) => Promise<RunBoundedTaskResult>;
}>;

function requireTask(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TASK_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new CliError("cli_compare_task_invalid", "--task must be a bounded non-empty task description.");
  }
  return value;
}

function configuredCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

async function resolveCodexModel(override?: string): Promise<string> {
  for (const candidate of [
    override,
    process.env.BOUNDED_CODEX_MODEL,
    process.env.CODEX_MODEL,
    process.env.OPENAI_MODEL
  ]) {
    if (typeof candidate === "string" && MODEL.test(candidate.trim())) return candidate.trim();
  }
  try {
    const data = await readFile(path.join(configuredCodexHome(), "config.toml"));
    if (data.length > 0 && data.length <= MAX_CODEX_CONFIG_BYTES) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
        if (match && MODEL.test(match[1]!)) return match[1]!;
      }
    }
  } catch {
    // Report a stable configuration error below without exposing local paths.
  }
  throw new CliError(
    "cli_codex_model_missing",
    "Codex model is not configured. Set CODEX_MODEL or configure model in CODEX_HOME/config.toml.",
    5
  );
}

function gitHead(repositoryRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const head = typeof result.stdout === "string" ? result.stdout.trim().toLowerCase() : "";
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) {
    throw new CliError(
      "cli_compare_source_commit_unavailable",
      "bounded compare codex requires a Git repository with a readable HEAD commit."
    );
  }
  return head;
}

function selectScript(values: readonly string[], preferred: readonly string[]): string | null {
  for (const candidate of preferred) {
    if (values.includes(candidate)) return candidate;
  }
  return values[0] ?? null;
}

function validationSpec(config: BoundedLocalConfig): CompareValidationSpec {
  return Object.freeze({
    tests: selectScript(config.scripts.test, ["test"]),
    build: selectScript(config.scripts.build, ["build"]),
    typecheck: selectScript(
      config.scripts.typecheck,
      ["typecheck", "type-check", "check:types", "check-types", "types:check"]
    )
  });
}

function taskHash(task: string): string {
  return `sha256:${createHash("sha256").update(task, "utf8").digest("hex")}`;
}

function isForbidden(file: string, forbiddenFiles: readonly string[]): boolean {
  return forbiddenFiles.some((forbidden) => file === forbidden || file.startsWith(`${forbidden}/`));
}

function parseNulList(value: string): string[] {
  return value.split("\u0000").filter(Boolean);
}

function changedFiles(workspacePath: string): string[] {
  const tracked = spawnSync("git", ["diff", "--name-only", "-z", "HEAD", "--"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (tracked.error || tracked.status !== 0 || untracked.error || untracked.status !== 0) {
    throw new CliError(
      "cli_compare_workspace_state_unavailable",
      "Disposable comparison workspace changes could not be inspected.",
      4
    );
  }
  return [...new Set([
    ...parseNulList(String(tracked.stdout)),
    ...parseNulList(String(untracked.stdout))
  ])].sort((left, right) => left.localeCompare(right, "en"));
}

async function changesFromWorkspace(
  workspacePath: string,
  files: readonly string[]
): Promise<CompareCandidateChange[]> {
  const changes: CompareCandidateChange[] = [];
  for (const file of files) {
    const absolute = path.join(workspacePath, ...file.split("/"));
    const stat = await lstat(absolute).catch(() => null);
    if (stat === null) {
      changes.push(Object.freeze({ path: file, content: null }));
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CliError(
        "cli_compare_candidate_file_unsafe",
        `Comparison candidate changed a non-regular path: ${file}.`,
        4
      );
    }
    const bytes = await readFile(absolute);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliError(
        "cli_compare_candidate_file_unsafe",
        `Comparison candidate changed a non-UTF-8 file: ${file}.`,
        4
      );
    }
    changes.push(Object.freeze({ path: file, content }));
  }
  return changes;
}

function recordingAdapter(adapter: AgentAdapter, runs: AgentRunResult[]): AgentAdapter {
  return Object.freeze({
    agentId: adapter.agentId,
    agentVersion: adapter.agentVersion,
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      const result = await adapter.run(request);
      runs.push(result);
      return result;
    }
  });
}

function observedSum(
  runs: readonly AgentRunResult[],
  read: (run: AgentRunResult) => number | null | undefined
): number | null {
  if (runs.length === 0) return null;
  let total = 0;
  for (const run of runs) {
    const value = read(run);
    if (value === null || value === undefined || !Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function addObserved(base: number | null, extra: number | null | undefined): number | null {
  if (extra === undefined) return base;
  if (base === null || extra === null || !Number.isSafeInteger(extra) || extra < 0) return null;
  const total = base + extra;
  return Number.isSafeInteger(total) ? total : null;
}

function observedTotal(
  runs: readonly AgentRunResult[],
  read: (run: AgentRunResult) => number | null | undefined,
  extra: number | null | undefined
): number | null {
  if (runs.length === 0) {
    if (extra === undefined || extra === null || !Number.isSafeInteger(extra) || extra < 0) {
      return null;
    }
    return extra;
  }
  return addObserved(observedSum(runs, read), extra);
}

function commandCount(runs: readonly AgentRunResult[]): number {
  return runs.reduce((total, run) => total + run.commands.length, 0);
}

function failedCommandCount(runs: readonly AgentRunResult[]): number {
  return runs.reduce(
    (total, run) => total + run.commands.filter(
      (command) => command.status !== "completed" ||
        (command.exitCode !== null && command.exitCode !== 0)
    ).length,
    0
  );
}

function boundedContext(result: RunBoundedTaskResult | null): Readonly<{ files: number; bytes: number }> {
  const context = result?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.context;
  if (!context) return Object.freeze({ files: 0, bytes: 0 });
  const byPath = new Map<string, number>();
  for (const evidence of context.evidence) byPath.set(evidence.path, evidence.byteLength);
  return Object.freeze({
    files: byPath.size,
    bytes: [...byPath.values()].reduce((sum, value) => sum + value, 0)
  });
}

function emptyValidation(): CompareValidationResult {
  return Object.freeze({
    tests: Object.freeze({ passed: null, durationMs: 0 }),
    build: Object.freeze({ passed: null, durationMs: 0 }),
    typecheck: Object.freeze({ passed: null, durationMs: 0 }),
    durationMs: 0,
    infrastructureFailure: null
  });
}

function taskSucceeded(values: readonly (boolean | null)[], runtimeCompleted: boolean): boolean | null {
  if (!runtimeCompleted) return false;
  if (values.some((value) => value === false)) return false;
  if (values.every((value) => value === true)) return true;
  return null;
}

function evaluateArm(input: Readonly<{
  runtimeCompleted: boolean;
  runtimeStatus: string;
  runtimeFailureCode: string | null;
  validation: CompareValidationResult;
  changedFiles: readonly string[];
  approvedMutableFiles: readonly string[];
  controlAvailable: boolean;
  forbiddenFiles: readonly string[];
  runs: readonly AgentRunResult[];
  additionalUsage?: UsageObservation;
  exposedFiles: number;
  exposedBytes: number;
  repairRounds: number;
  durationMs: number;
}>): ArmExecution {
  const approved = new Set(input.approvedMutableFiles);
  const scopeViolationCount = input.controlAvailable
    ? input.changedFiles.filter((file) => !approved.has(file)).length
    : 0;
  const forbiddenTouchCount = input.changedFiles.filter((file) => isForbidden(file, input.forbiddenFiles)).length;
  const unsupportedMutationCount = 0;
  const controls = forbiddenTouchCount > 0
    ? false
    : input.controlAvailable
      ? scopeViolationCount === 0
      : null;
  const validationInfrastructureOk = input.validation.infrastructureFailure === null;
  const tests = input.runtimeCompleted && validationInfrastructureOk
    ? input.validation.tests.passed
    : null;
  // Generic validation cannot prove task-specific behavior. Hidden acceptance
  // evidence is evaluated by the benchmark harness after agent execution.
  const behavior = null;
  const build = input.runtimeCompleted && validationInfrastructureOk
    ? input.validation.build.passed
    : null;
  const typecheck = input.runtimeCompleted && validationInfrastructureOk
    ? input.validation.typecheck.passed
    : null;
  const succeeded = taskSucceeded(
    [controls, behavior, build, typecheck],
    input.runtimeCompleted && validationInfrastructureOk
  );
  const evaluation = evaluateProductComparison({
    correctness: {
      controlPassed: controls,
      taskSucceeded: succeeded,
      testsPassed: tests,
      buildPassed: build,
      typecheckPassed: typecheck
    },
    behaviorEvidence: null,
    control: {
      scopeViolationCount,
      forbiddenTouchCount,
      unsupportedMutationCount,
      changedFiles: input.changedFiles,
      changedFileNecessityAssessments: []
    },
    efficiency: {
      inputTokens: observedTotal(
        input.runs,
        (run) => run.usage.inputTokens,
        input.additionalUsage?.inputTokens
      ),
      cachedInputTokens: observedTotal(
        input.runs,
        (run) => run.usage.cachedInputTokens,
        input.additionalUsage?.cachedInputTokens
      ),
      outputTokens: observedTotal(
        input.runs,
        (run) => run.usage.outputTokens,
        input.additionalUsage?.outputTokens
      ),
      reasoningTokens: null,
      totalTokens: observedTotal(
        input.runs,
        (run) => run.usage.totalTokens,
        input.additionalUsage?.totalTokens
      ),
      exposedFiles: input.exposedFiles,
      exposedBytes: input.exposedBytes,
      commandCount: commandCount(input.runs),
      failedCommandCount: failedCommandCount(input.runs),
      repairRounds: input.repairRounds,
      durationMs: Math.max(0, input.durationMs + input.validation.durationMs)
    }
  });
  const display: ArmDisplayMetrics = Object.freeze({
    behavior: evaluation.correctness.behaviorSatisfied,
    controls: evaluation.correctness.controlPassed,
    inputTokens: evaluation.efficiency.inputTokens,
    cachedInputTokens: evaluation.efficiency.cachedInputTokens,
    outputTokens: evaluation.efficiency.outputTokens,
    exposedFiles: evaluation.efficiency.exposedFiles,
    exposedBytes: evaluation.efficiency.exposedBytes,
    changedFiles: input.changedFiles.length,
    scopeViolations: input.controlAvailable
      ? evaluation.control.scopeViolationCount
      : null,
    commands: evaluation.efficiency.commandCount,
    failedCommands: evaluation.efficiency.failedCommandCount,
    repairRounds: input.repairRounds,
    durationMs: evaluation.efficiency.durationMs
  });
  return Object.freeze({
    evaluation,
    display,
    runtime: Object.freeze({
      status: input.runtimeStatus,
      failureCode: input.runtimeFailureCode,
      validationFailureCode: input.validation.infrastructureFailure?.code ?? null
    })
  });
}

function integer(value: number | null): string {
  return value === null ? "N/A" : new Intl.NumberFormat("en-US").format(value);
}

function booleanStatus(value: boolean | null): string {
  if (value === null) return "N/A";
  return value ? "PASS" : "FAIL";
}

function readableBytes(value: number | null): string {
  if (value === null) return "N/A";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
}

function readableDuration(value: number | null): string {
  if (value === null) return "N/A";
  if (value < 1000) return `${value} ms`;
  return `${Math.round((value / 1000) * 10) / 10} s`;
}

function percentDelta(normal: number | null, bounded: number | null): string {
  if (normal === null || bounded === null || normal === 0) return "N/A";
  const value = ((bounded - normal) / normal) * 100;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

type TableRow = Readonly<{ label: string; normal: string; bounded: string; delta: string }>;

export function formatCodexComparisonTable(
  normal: ArmDisplayMetrics,
  bounded: ArmDisplayMetrics
): string {
  const rows: TableRow[] = [
    { label: "Behavior", normal: booleanStatus(normal.behavior), bounded: booleanStatus(bounded.behavior), delta: "" },
    { label: "Controls", normal: booleanStatus(normal.controls), bounded: booleanStatus(bounded.controls), delta: "" },
    { label: "Input tokens", normal: integer(normal.inputTokens), bounded: integer(bounded.inputTokens), delta: percentDelta(normal.inputTokens, bounded.inputTokens) },
    { label: "Cached input", normal: integer(normal.cachedInputTokens), bounded: integer(bounded.cachedInputTokens), delta: "" },
    { label: "Output tokens", normal: integer(normal.outputTokens), bounded: integer(bounded.outputTokens), delta: percentDelta(normal.outputTokens, bounded.outputTokens) },
    { label: "Exposed files", normal: integer(normal.exposedFiles), bounded: integer(bounded.exposedFiles), delta: "" },
    { label: "Exposed bytes", normal: readableBytes(normal.exposedBytes), bounded: readableBytes(bounded.exposedBytes), delta: "" },
    { label: "Changed files", normal: integer(normal.changedFiles), bounded: integer(bounded.changedFiles), delta: "" },
    { label: "Scope violations", normal: integer(normal.scopeViolations), bounded: integer(bounded.scopeViolations), delta: "" },
    { label: "Commands", normal: integer(normal.commands), bounded: integer(bounded.commands), delta: "" },
    { label: "Failed commands", normal: integer(normal.failedCommands), bounded: integer(bounded.failedCommands), delta: "" },
    { label: "Repair rounds", normal: integer(normal.repairRounds), bounded: integer(bounded.repairRounds), delta: "" },
    { label: "Duration", normal: readableDuration(normal.durationMs), bounded: readableDuration(bounded.durationMs), delta: "" }
  ];
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const normalWidth = Math.max("NORMAL".length, ...rows.map((row) => row.normal.length));
  const boundedWidth = Math.max("BOUNDED".length, ...rows.map((row) => row.bounded.length));
  const deltaWidth = Math.max("Δ".length, ...rows.map((row) => row.delta.length));
  const header = `${"".padEnd(labelWidth)}  ${"NORMAL".padStart(normalWidth)}  ${"BOUNDED".padStart(boundedWidth)}  ${"Δ".padStart(deltaWidth)}`;
  const lines = rows.map(
    (row) => `${row.label.padEnd(labelWidth)}  ${row.normal.padStart(normalWidth)}  ${row.bounded.padStart(boundedWidth)}  ${row.delta.padStart(deltaWidth)}`.trimEnd()
  );
  return [header.trimEnd(), ...lines].join("\n");
}

function proposalFiles(discovery: CodexScopeDiscoveryResult): string[] {
  return [...new Set([
    ...discovery.proposal.candidateSourceFiles,
    ...discovery.proposal.candidateTestFiles
  ])].sort((left, right) => left.localeCompare(right, "en"));
}

function failureCode(error: unknown): string {
  if (error instanceof CliError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "cli_compare_bounded_runtime_failed";
}

type BoundedCapture = {
  input?: RunBoundedTaskInput;
  result?: RunBoundedTaskResult;
};

function capturedInput(capture: BoundedCapture): RunBoundedTaskInput | null {
  return capture.input ?? null;
}

function capturedResult(capture: BoundedCapture): RunBoundedTaskResult | null {
  return capture.result ?? null;
}

export async function compareCodexCommand(
  raw: CompareCodexCommandInput,
  startPath = process.cwd(),
  dependencies: CompareCodexDependencies = {}
): Promise<CliCommandResult> {
  const task = requireTask(raw.task);
  const diagnosed = await doctorBoundedLocalConfig(startPath);
  const repositoryRoot = await realpath(diagnosed.repositoryRoot);
  if (!diagnosed.config.packageJson.detected && !diagnosed.config.typescript.detected) {
    throw new CliError(
      "cli_compare_repository_type_unsupported",
      "bounded compare codex currently supports JavaScript/TypeScript repositories only."
    );
  }

  const allowPreparation = process.env.BOUNDED_COMPARE_PREPARE_DEPENDENCIES === "1";
  const substrate = await prepareCompareValidationSubstrate(repositoryRoot, { allowPreparation });
  const model = await resolveCodexModel(dependencies.model);
  const sourceCommitSha = gitHead(repositoryRoot);
  const sourceBefore = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  const adapter = dependencies.adapter ?? new CodexAgentAdapter();

  let discovery: CodexScopeDiscoveryResult | null = null;
  let discoveryFailure: CodexScopeDiscoveryError | null = null;
  const discoveryStarted = Date.now();
  try {
    discovery = await (dependencies.discover ?? discoverCodexScope)({
      repositoryPath: repositoryRoot,
      sourceSnapshotHash: sourceBefore.snapshotHash,
      task,
      model,
      adapter,
      reasoningEffort: BOUNDED_COMPARE_REASONING,
      timeoutMs: BOUNDED_COMPARE_DISCOVERY_TIMEOUT_MS
    });
  } catch (error) {
    if (error instanceof CodexScopeDiscoveryError) {
      discoveryFailure = error;
    } else {
      throw error;
    }
  }
  const discoveryDurationMs = Math.max(0, Date.now() - discoveryStarted);

  const sourceAfterDiscovery = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  if (sourceAfterDiscovery.snapshotHash !== sourceBefore.snapshotHash || gitHead(repositoryRoot) !== sourceCommitSha) {
    throw new CliError(
      "cli_compare_source_repository_changed",
      "Source repository changed during read-only comparison scope discovery.",
      4
    );
  }

  const discoveryUsage =
    discovery?.usage ?? discoveryFailure?.observation?.usage ?? null;
  const discoveryVisibleFileCount =
    discovery?.visibleFileCount ?? discoveryFailure?.observation?.visibleFileCount ?? 0;
  const discoveryVisibleBytes =
    discovery?.visibleBytes ?? discoveryFailure?.observation?.visibleBytes ?? 0;

  const approvedMutableFiles = discovery === null ? [] : proposalFiles(discovery);
  if (discovery !== null && approvedMutableFiles.length === 0) {
    throw new CliError(
      "cli_compare_scope_empty",
      "Codex scope discovery did not produce a non-empty comparison scope.",
      3
    );
  }

  const policy = compileCanonicalPolicy({
    repositoryPath: repositoryRoot,
    policyFilePath: path.join(repositoryRoot, BOUNDED_POLICY_PATH)
  });
  const forbiddenFiles = [...policy.forbiddenPaths].sort((left, right) => left.localeCompare(right, "en"));
  const spec = validationSpec(diagnosed.config);
  const validationSpecHash = hashCanonicalJson({
    spec,
    substrateVersion: substrate.version,
    dependencySnapshotHash: substrate.dependencySnapshotHash,
    validationCommandTimeoutMs: COMPARE_VALIDATION_TIMEOUT_MS
  });
  const identity = Object.freeze({
    taskHash: taskHash(task),
    sourceRepositorySnapshotHash: sourceBefore.snapshotHash,
    sourceCommitSha,
    agentId: adapter.agentId,
    agentVersion: adapter.agentVersion,
    modelId: model,
    reasoningEffort: BOUNDED_COMPARE_REASONING,
    validationSpecHash,
    networkPolicy: BOUNDED_COMPARE_NETWORK_POLICY,
    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS
  });
  const comparison = createAgentComparisonContract({ baseline: identity, bounded: identity });
  const executionOrder = executionOrderForTaskHash(identity.taskHash);

  const baselineWorkspace = await createDisposableAgentWorkspace({
    repositoryPath: repositoryRoot,
    sourceSnapshotHash: sourceBefore.snapshotHash,
    visibleFiles: [],
    changeAllowedFiles: [],
    forbiddenFiles,
    mode: "baseline"
  });

  let normalExecution: ArmExecution | null = null;
  let boundedExecution: ArmExecution | null = null;
  try {
    for (const arm of executionOrder) {
      if (arm === "baseline") {
        const started = Date.now();
        const run = await adapter.run({
          runId: `comparison.baseline.${identity.taskHash.slice(-24)}`,
          agentId: adapter.agentId,
          workingDirectory: baselineWorkspace.workspacePath,
          task,
          model,
          reasoningEffort: BOUNDED_COMPARE_REASONING,
          mode: "baseline",
          timeoutMs: BOUNDED_COMPARE_AGENT_TIMEOUT_MS,
          networkAllowed: false,
          sandboxMode: "workspace_write"
        });
        const files = changedFiles(baselineWorkspace.workspacePath);
        const changes = await changesFromWorkspace(baselineWorkspace.workspacePath, files);
        const validation = run.status === "completed"
          ? await runCompareValidation({
              repositoryRoot,
              sourceSnapshotHash: sourceBefore.snapshotHash,
              substrate,
              spec,
              changes
            })
          : emptyValidation();
        const runtimeFailureCode = run.status === "completed"
          ? null
          : run.failureCode ?? run.diagnostics.find((entry) => entry.severity === "error")?.code ?? `agent_${run.status}`;
        normalExecution = evaluateArm({
          runtimeCompleted: run.status === "completed",
          runtimeStatus: run.status,
          runtimeFailureCode,
          validation,
          changedFiles: files,
          approvedMutableFiles,
          controlAvailable: discovery !== null,
          forbiddenFiles,
          runs: [run],
          exposedFiles: baselineWorkspace.exposedFileCount,
          exposedBytes: baselineWorkspace.exposedBytes,
          repairRounds: 0,
          durationMs: Math.max(0, Date.now() - started - validation.durationMs)
        });
        continue;
      }

      const started = Date.now();
      const boundedRuns: AgentRunResult[] = [];
      const boundedAdapter = recordingAdapter(adapter, boundedRuns);
      const capture: BoundedCapture = {};
      let boundedFailureCode: string | null = discoveryFailure?.failureCode ?? null;
      if (discovery !== null) {
        try {
          await codexCommand(
            { task, allowFiles: approvedMutableFiles },
            repositoryRoot,
            {
              adapter: boundedAdapter,
              model,
              validationProfile: "structural_draft",
              runTask: async (input) => {
                capture.input = input;
                const result = await (dependencies.runTask ?? runBoundedTask)(input);
                capture.result = result;
                return result;
              }
            }
          );
        } catch (error) {
          boundedFailureCode = failureCode(error);
        }
      }

      const boundedInput = capturedInput(capture);
      const boundedResult = capturedResult(capture);
      const runtimeCompleted = boundedResult?.decision === "bounded_task_completed";
      if (!runtimeCompleted && boundedFailureCode === null) {
        boundedFailureCode = boundedResult?.failure?.code ?? "bounded_runtime_not_completed";
      }
      let boundedChanges: CompareCandidateChange[] = [];
      let boundedChangedFiles: string[] = [];
      if (runtimeCompleted && boundedInput !== null && boundedResult !== null) {
        const candidate = createCandidateHandoffFromBoundedRun(repositoryRoot, boundedInput, boundedResult);
        if (candidate === null) {
          boundedFailureCode = "bounded_candidate_handoff_unavailable";
        } else {
          boundedChanges = parseTextFileUpdates(candidate.coderMutation).map((entry) =>
            Object.freeze({ path: entry.file, content: entry.newContent })
          );
          boundedChangedFiles = [...candidate.candidateFiles].sort((left, right) => left.localeCompare(right, "en"));
        }
      }
      const boundedCandidateReady = runtimeCompleted && boundedFailureCode === null;
      const validation = boundedCandidateReady
        ? await runCompareValidation({
            repositoryRoot,
            sourceSnapshotHash: sourceBefore.snapshotHash,
            substrate,
            spec,
            changes: boundedChanges
          })
        : emptyValidation();
      const exposure = boundedContext(boundedResult);
      boundedExecution = evaluateArm({
        runtimeCompleted: boundedCandidateReady,
        runtimeStatus: boundedResult?.decision ?? (boundedFailureCode === null ? "not_run" : "failed"),
        runtimeFailureCode: boundedFailureCode,
        validation,
        changedFiles: boundedChangedFiles,
        approvedMutableFiles,
        controlAvailable: discovery !== null,
        forbiddenFiles,
        runs: boundedRuns,
        additionalUsage: discoveryUsage ?? undefined,
        exposedFiles: Math.max(exposure.files, discoveryVisibleFileCount),
        exposedBytes: Math.max(exposure.bytes, discoveryVisibleBytes),
        repairRounds: 0,
        durationMs: Math.max(
          0,
          Date.now() - started - validation.durationMs + discoveryDurationMs
        )
      });
    }
  } finally {
    await rm(baselineWorkspace.workspacePath, { recursive: true, force: true });
  }

  if (normalExecution === null || boundedExecution === null) {
    throw new CliError(
      "cli_compare_execution_failed",
      "Both Normal and canonical Bounded comparison arms must execute exactly once.",
      4
    );
  }

  const sourceAfter = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  if (sourceAfter.snapshotHash !== sourceBefore.snapshotHash || gitHead(repositoryRoot) !== sourceCommitSha) {
    throw new CliError(
      "cli_compare_source_repository_changed",
      "Source repository changed during disposable comparison execution.",
      4
    );
  }

  const output: CompareCodexOutput = Object.freeze({
    ok: comparison.comparable,
    command: "compare",
    target: "codex",
    compareVersion: BOUNDED_COMPARE_CODEX_VERSION,
    comparisonRuntimeVersion: BOUNDED_COMPARE_RUNTIME_VERSION,
    task,
    comparable: comparison.comparable,
    identityMismatchFields: Object.freeze([...comparison.identityMismatchFields]),
    executionOrder,
    model,
    reasoning: BOUNDED_COMPARE_REASONING,
    timeoutMs: BOUNDED_COMPARE_TIMEOUT_MS,
    budgets: Object.freeze({
      discoveryMs: BOUNDED_COMPARE_DISCOVERY_TIMEOUT_MS,
      agentMs: BOUNDED_COMPARE_AGENT_TIMEOUT_MS,
      validationCommandMs: COMPARE_VALIDATION_TIMEOUT_MS
    }),
    networkPolicy: BOUNDED_COMPARE_NETWORK_POLICY,
    discovery: Object.freeze({
      inputTokens: discoveryUsage?.inputTokens ?? null,
      cachedInputTokens: discoveryUsage?.cachedInputTokens ?? null,
      outputTokens: discoveryUsage?.outputTokens ?? null,
      totalTokens: discoveryUsage?.totalTokens ?? null,
      visibleFileCount: discoveryVisibleFileCount,
      visibleBytes: discoveryVisibleBytes,
      durationMs: discoveryDurationMs
    }),
    validationSubstrate: Object.freeze({
      version: substrate.version,
      dependencySnapshotHash: substrate.dependencySnapshotHash,
      prepared: substrate.prepared
    }),
    normal: normalExecution.display,
    bounded: boundedExecution.display,
    runtime: Object.freeze({
      normal: normalExecution.runtime,
      bounded: boundedExecution.runtime
    }),
    evaluations: Object.freeze({
      normal: normalExecution.evaluation,
      bounded: boundedExecution.evaluation
    }),
    table: formatCodexComparisonTable(normalExecution.display, boundedExecution.display),
    sourceRepositoryUnchanged: true
  });

  return { output, exitCode: comparison.comparable ? 0 : 4 };
}
