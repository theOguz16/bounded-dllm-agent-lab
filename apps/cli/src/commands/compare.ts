import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compileCanonicalPolicy,
  createCanonicalRepositoryContentSnapshot,
  evaluateProductComparison,
  hashCanonicalJson,
  type ProductComparisonEvaluation
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";
import {
  runComparativeAgentSample,
  type AgentAdapter,
  type AgentRunResult,
  type ComparativeAgentEvaluatorInput,
  type ComparativeAgentRunnerResult
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

export const BOUNDED_COMPARE_CODEX_VERSION = "bounded-compare-codex/v1" as const;
export const BOUNDED_COMPARE_REASONING = "medium" as const;
export const BOUNDED_COMPARE_TIMEOUT_MS = 120_000;
export const BOUNDED_COMPARE_NETWORK_POLICY = "disabled" as const;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MAX_TASK_LENGTH = 32_768;

export type CompareCodexCommandInput = Readonly<{ task: string }>;

type CompareValidationSpec = Readonly<{
  tests: string | null;
  build: string | null;
  typecheck: string | null;
  approvedMutableFiles: readonly string[];
  forbiddenFiles: readonly string[];
}>;

type ValidationObservation = Readonly<{
  passed: boolean | null;
  durationMs: number;
}>;

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

export type CompareCodexOutput = Readonly<{
  ok: boolean;
  command: "compare";
  target: "codex";
  compareVersion: typeof BOUNDED_COMPARE_CODEX_VERSION;
  task: string;
  comparable: boolean;
  identityMismatchFields: readonly string[];
  model: string;
  reasoning: typeof BOUNDED_COMPARE_REASONING;
  timeoutMs: typeof BOUNDED_COMPARE_TIMEOUT_MS;
  networkPolicy: typeof BOUNDED_COMPARE_NETWORK_POLICY;
  normal: ArmDisplayMetrics;
  bounded: ArmDisplayMetrics;
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

function validationSpec(
  config: BoundedLocalConfig,
  approvedMutableFiles: readonly string[],
  forbiddenFiles: readonly string[]
): CompareValidationSpec {
  return Object.freeze({
    tests: selectScript(config.scripts.test, ["test"]),
    build: selectScript(config.scripts.build, ["build"]),
    typecheck: selectScript(
      config.scripts.typecheck,
      ["typecheck", "type-check", "check:types", "check-types", "types:check"]
    ),
    approvedMutableFiles: Object.freeze([...approvedMutableFiles]),
    forbiddenFiles: Object.freeze([...forbiddenFiles])
  });
}

function runValidationScript(workspacePath: string, script: string | null): ValidationObservation {
  if (script === null) return Object.freeze({ passed: null, durationMs: 0 });
  const started = Date.now();
  const result = spawnSync("npm", ["run", script], {
    cwd: workspacePath,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    timeout: BOUNDED_COMPARE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  return Object.freeze({
    passed: result.error === undefined && result.status === 0,
    durationMs: Math.max(0, Date.now() - started)
  });
}

function taskSucceeded(values: readonly (boolean | null)[]): boolean | null {
  if (values.some((value) => value === false)) return false;
  if (values.every((value) => value === true)) return true;
  return null;
}

function failedCommandCount(run: AgentRunResult): number {
  return run.commands.filter(
    (command) =>
      command.status !== "completed" ||
      (command.exitCode !== null && command.exitCode !== 0)
  ).length;
}

function exposedBytes(input: ComparativeAgentEvaluatorInput<CompareValidationSpec>): number {
  return input.workspaceManifest.files.reduce((total, file) => total + file.bytes, 0);
}

function comparisonEvaluator(
  input: ComparativeAgentEvaluatorInput<CompareValidationSpec>
): ProductComparisonEvaluation {
  const tests = runValidationScript(input.workspacePath, input.validationSpec.tests);
  const build = runValidationScript(input.workspacePath, input.validationSpec.build);
  const typecheck = runValidationScript(input.workspacePath, input.validationSpec.typecheck);

  const approved = new Set(input.validationSpec.approvedMutableFiles);
  const forbidden = new Set(input.validationSpec.forbiddenFiles);
  const scopeViolationCount = input.changedFiles.filter((file) => !approved.has(file)).length;
  const forbiddenTouchCount = input.changedFiles.filter((file) => forbidden.has(file)).length;
  const unsupportedMutationCount = 0;
  const controls =
    scopeViolationCount === 0 && forbiddenTouchCount === 0 && unsupportedMutationCount === 0;
  const behavior = tests.passed;
  const succeeded = taskSucceeded([controls, behavior, build.passed, typecheck.passed]);
  const validationDurationMs = tests.durationMs + build.durationMs + typecheck.durationMs;

  return evaluateProductComparison({
    correctness: {
      controlPassed: controls,
      behaviorSatisfied: behavior,
      taskSucceeded: succeeded,
      testsPassed: tests.passed,
      buildPassed: build.passed,
      typecheckPassed: typecheck.passed
    },
    control: {
      scopeViolationCount,
      forbiddenTouchCount,
      unsupportedMutationCount,
      changedFiles: input.changedFiles,
      changedFileNecessityAssessments: []
    },
    efficiency: {
      inputTokens: input.run.usage.inputTokens,
      cachedInputTokens: input.run.usage.cachedInputTokens ?? null,
      outputTokens: input.run.usage.outputTokens,
      reasoningTokens: null,
      totalTokens: input.run.usage.totalTokens,
      exposedFiles: input.workspaceManifest.files.length,
      exposedBytes: exposedBytes(input),
      commandCount: input.run.commands.length,
      failedCommandCount: failedCommandCount(input.run),
      repairRounds: 0,
      durationMs: Math.max(0, input.run.durationMs + validationDurationMs)
    }
  });
}

function displayMetrics(
  arm: ComparativeAgentRunnerResult<ProductComparisonEvaluation>["arms"]["baseline"],
  repairRounds: number | null
): ArmDisplayMetrics {
  return Object.freeze({
    behavior: arm.evaluation.correctness.behaviorSatisfied,
    controls: arm.evaluation.correctness.controlPassed,
    inputTokens: arm.evaluation.efficiency.inputTokens,
    cachedInputTokens: arm.evaluation.efficiency.cachedInputTokens,
    outputTokens: arm.evaluation.efficiency.outputTokens,
    exposedFiles: arm.evaluation.efficiency.exposedFiles,
    exposedBytes: arm.evaluation.efficiency.exposedBytes,
    changedFiles: arm.workspace.changedFiles.length,
    scopeViolations: arm.evaluation.control.scopeViolationCount,
    commands: arm.evaluation.efficiency.commandCount,
    failedCommands: arm.evaluation.efficiency.failedCommandCount,
    repairRounds,
    durationMs: arm.evaluation.efficiency.durationMs
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
  if (value < 1024 * 1024) {
    return `${Math.round((value / 1024) * 10) / 10} KB`;
  }
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

type TableRow = Readonly<{
  label: string;
  normal: string;
  bounded: string;
  delta: string;
}>;

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
    (row) =>
      `${row.label.padEnd(labelWidth)}  ${row.normal.padStart(normalWidth)}  ${row.bounded.padStart(boundedWidth)}  ${row.delta.padStart(deltaWidth)}`.trimEnd()
  );
  return [header.trimEnd(), ...lines].join("\n");
}

function proposalFiles(discovery: CodexScopeDiscoveryResult): string[] {
  return [...new Set([
    ...discovery.proposal.candidateSourceFiles,
    ...discovery.proposal.candidateTestFiles
  ])].sort((left, right) => left.localeCompare(right, "en"));
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

  const model = await resolveCodexModel(dependencies.model);
  const sourceCommitSha = gitHead(repositoryRoot);
  const sourceBefore = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  let discovery: CodexScopeDiscoveryResult;
  try {
    discovery = await (dependencies.discover ?? discoverCodexScope)({
      repositoryPath: repositoryRoot,
      sourceSnapshotHash: sourceBefore.snapshotHash,
      task,
      model,
      adapter: dependencies.adapter,
      reasoningEffort: BOUNDED_COMPARE_REASONING,
      timeoutMs: BOUNDED_COMPARE_TIMEOUT_MS
    });
  } catch (error) {
    if (error instanceof CodexScopeDiscoveryError) {
      throw new CliError("cli_compare_scope_discovery_failed", error.message, 3);
    }
    throw error;
  }

  const sourceAfterDiscovery = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  if (sourceAfterDiscovery.snapshotHash !== sourceBefore.snapshotHash || gitHead(repositoryRoot) !== sourceCommitSha) {
    throw new CliError(
      "cli_compare_source_repository_changed",
      "Source repository changed during read-only comparison scope discovery.",
      4
    );
  }

  const approvedMutableFiles = proposalFiles(discovery);
  if (approvedMutableFiles.length === 0) {
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
  const forbiddenFiles = [...policy.forbiddenPaths].sort((left, right) =>
    left.localeCompare(right, "en")
  );
  const spec = validationSpec(diagnosed.config, approvedMutableFiles, forbiddenFiles);
  const validationSpecHash = hashCanonicalJson({
    tests: spec.tests,
    build: spec.build,
    typecheck: spec.typecheck
  });
  const adapter = dependencies.adapter ?? new CodexAgentAdapter();

  let result: ComparativeAgentRunnerResult<ProductComparisonEvaluation>;
  try {
    result = await runComparativeAgentSample({
      repositoryPath: repositoryRoot,
      sourceRepositorySnapshotHash: sourceBefore.snapshotHash,
      sourceCommitSha,
      task,
      modelId: model,
      reasoningEffort: BOUNDED_COMPARE_REASONING,
      timeoutBudget: BOUNDED_COMPARE_TIMEOUT_MS,
      networkPolicy: BOUNDED_COMPARE_NETWORK_POLICY,
      validationSpecHash,
      validationSpec: spec,
      selectedContextFiles: approvedMutableFiles,
      approvedMutableFiles,
      forbiddenFiles,
      adapter,
      evaluator: comparisonEvaluator
    });
  } catch (error) {
    throw new CliError(
      "cli_compare_execution_failed",
      error instanceof Error ? error.message : "Codex comparison execution failed.",
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

  const normal = displayMetrics(result.arms.baseline, null);
  const bounded = displayMetrics(
    result.arms.bounded,
    result.arms.bounded.evaluation.efficiency.repairRounds
  );
  const output: CompareCodexOutput = Object.freeze({
    ok: result.comparison.comparable,
    command: "compare",
    target: "codex",
    compareVersion: BOUNDED_COMPARE_CODEX_VERSION,
    task,
    comparable: result.comparison.comparable,
    identityMismatchFields: Object.freeze([...result.comparison.identityMismatchFields]),
    model,
    reasoning: BOUNDED_COMPARE_REASONING,
    timeoutMs: BOUNDED_COMPARE_TIMEOUT_MS,
    networkPolicy: BOUNDED_COMPARE_NETWORK_POLICY,
    normal,
    bounded,
    evaluations: Object.freeze({
      normal: result.arms.baseline.evaluation,
      bounded: result.arms.bounded.evaluation
    }),
    table: formatCodexComparisonTable(normal, bounded),
    sourceRepositoryUnchanged: true
  });

  return { output, exitCode: result.comparison.comparable ? 0 : 4 };
}
