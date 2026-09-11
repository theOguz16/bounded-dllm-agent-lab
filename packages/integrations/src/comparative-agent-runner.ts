import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import {
  createAgentComparisonContract,
  type AgentComparisonArm,
  type AgentComparisonContract,
  type AgentComparableIdentity
} from "../../product-runtime/src/agent-comparison-contract.js";
import type {
  AgentAdapter,
  AgentReasoningEffort,
  AgentRunRequest,
  AgentRunResult
} from "./agent-adapter.js";
import {
  createDisposableAgentWorkspace,
  type DisposableAgentWorkspaceManifest,
  type DisposableAgentWorkspaceResult
} from "./disposable-agent-workspace.js";

export const COMPARATIVE_AGENT_RUNNER_VERSION =
  "comparative-agent-runner/v1" as const;

export type ComparativeAgentNetworkPolicy = "disabled" | "enabled";
export type ComparativeAgentExecutionOrder = readonly [AgentComparisonArm, AgentComparisonArm];

export type ComparativeAgentEvaluatorInput<TValidationSpec> = Readonly<{
  arm: AgentComparisonArm;
  task: string;
  workspacePath: string;
  workspaceManifest: DisposableAgentWorkspaceManifest;
  mutableFiles: readonly string[];
  changedFiles: readonly string[];
  run: AgentRunResult;
  validationSpec: TValidationSpec;
}>;

export type ComparativeAgentEvaluator<TValidationSpec, TEvaluation> = (
  input: ComparativeAgentEvaluatorInput<TValidationSpec>
) => Promise<TEvaluation> | TEvaluation;

export type ComparativeAgentRunnerInput<TValidationSpec, TEvaluation> = Readonly<{
  repositoryPath: string;
  sourceRepositorySnapshotHash: string;
  sourceCommitSha: string;
  task: string;
  modelId: string;
  reasoningEffort: AgentReasoningEffort;
  timeoutBudget: number;
  networkPolicy: ComparativeAgentNetworkPolicy;
  validationSpecHash: string;
  validationSpec: TValidationSpec;
  selectedContextFiles: readonly string[];
  approvedMutableFiles: readonly string[];
  forbiddenFiles?: readonly string[];
  adapter: AgentAdapter;
  evaluator: ComparativeAgentEvaluator<TValidationSpec, TEvaluation>;
  abortSignal?: AbortSignal;
}>;

export type ComparativeAgentWorkspaceSummary = Readonly<{
  mode: AgentComparisonArm;
  manifestHash: string;
  exposedFileCount: number;
  exposedBytes: number;
  mutableFiles: readonly string[];
  changedFiles: readonly string[];
}>;

export type ComparativeAgentArmResult<TEvaluation> = Readonly<{
  arm: AgentComparisonArm;
  run: AgentRunResult;
  evaluation: TEvaluation;
  workspace: ComparativeAgentWorkspaceSummary;
}>;

export type ComparativeAgentRunnerResult<TEvaluation> = Readonly<{
  schemaVersion: typeof COMPARATIVE_AGENT_RUNNER_VERSION;
  comparison: AgentComparisonContract;
  executionOrder: ComparativeAgentExecutionOrder;
  workspaceIsolation: Readonly<{
    distinctRoots: true;
    boundedContextIsBaselineSubset: true;
  }>;
  arms: Readonly<{
    baseline: ComparativeAgentArmResult<TEvaluation>;
    bounded: ComparativeAgentArmResult<TEvaluation>;
  }>;
}>;

export type ComparativeAgentRunnerErrorCode =
  | "comparative_agent_runner_invalid"
  | "comparative_agent_source_commit_mismatch"
  | "comparative_agent_workspace_isolation_failed"
  | "comparative_agent_source_snapshot_mismatch"
  | "comparative_agent_scope_violation";

export class ComparativeAgentRunnerError extends Error {
  constructor(
    readonly code: ComparativeAgentRunnerErrorCode,
    message: string,
    readonly file?: string
  ) {
    super(message);
    this.name = "ComparativeAgentRunnerError";
  }
}

const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const SHA256 = /^sha256:([0-9a-f]{64})$/;

function fail(
  code: ComparativeAgentRunnerErrorCode,
  message: string,
  file?: string
): never {
  throw new ComparativeAgentRunnerError(code, message, file);
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Deterministically alternates which arm runs first from the canonical task hash.
 * Even final SHA-256 nibbles run baseline first; odd nibbles run bounded first.
 */
export function executionOrderForTaskHash(taskHash: string): ComparativeAgentExecutionOrder {
  const match = SHA256.exec(taskHash);
  if (!match) {
    return fail(
      "comparative_agent_runner_invalid",
      "taskHash must be a canonical lowercase sha256 hash."
    );
  }
  const finalNibble = Number.parseInt(match[1]!.slice(-1), 16);
  return finalNibble % 2 === 0
    ? Object.freeze(["baseline", "bounded"] as const)
    : Object.freeze(["bounded", "baseline"] as const);
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toUpperCase().startsWith("GIT_")) continue;
    environment[key] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        env: isolatedGitEnvironment(),
        maxBuffer: MAX_GIT_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new ComparativeAgentRunnerError(
              "comparative_agent_runner_invalid",
              `Git command failed (${args.join(" ")}): ${stderr.trim() || error.message}`
            )
          );
          return;
        }
        resolvePromise(stdout);
      }
    );
  });
}

function parseNulList(value: string): string[] {
  return value
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function changedFiles(workspacePath: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(workspacePath, ["diff", "--name-only", "-z", "HEAD", "--"]),
    runGit(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
  ]);
  return [...new Set([...parseNulList(tracked), ...parseNulList(untracked)])].sort(
    (left, right) => left.localeCompare(right, "en")
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertDistinctWorkspaceRoots(
  baselinePath: string,
  boundedPath: string
): void {
  if (
    baselinePath === boundedPath ||
    isWithin(baselinePath, boundedPath) ||
    isWithin(boundedPath, baselinePath)
  ) {
    fail(
      "comparative_agent_workspace_isolation_failed",
      "Baseline and bounded arms must use independent, non-overlapping disposable workspace roots."
    );
  }
}

function validateBasicInput<TValidationSpec, TEvaluation>(
  input: ComparativeAgentRunnerInput<TValidationSpec, TEvaluation>
): Readonly<{
  taskHash: string;
  forbiddenFiles: readonly string[];
  expectedIdentity: AgentComparableIdentity;
}> {
  if (input === null || typeof input !== "object") {
    return fail("comparative_agent_runner_invalid", "Comparison runner input must be an object.");
  }
  if (
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    typeof input.task !== "string" ||
    input.task.trim().length === 0
  ) {
    return fail(
      "comparative_agent_runner_invalid",
      "repositoryPath and task must be non-empty strings."
    );
  }
  if (!Array.isArray(input.selectedContextFiles) || input.selectedContextFiles.length === 0) {
    return fail(
      "comparative_agent_runner_invalid",
      "selectedContextFiles must contain at least one bounded-context file."
    );
  }
  if (!Array.isArray(input.approvedMutableFiles) || input.approvedMutableFiles.length === 0) {
    return fail(
      "comparative_agent_runner_invalid",
      "approvedMutableFiles must contain at least one task-authorized file."
    );
  }
  if (input.forbiddenFiles !== undefined && !Array.isArray(input.forbiddenFiles)) {
    return fail("comparative_agent_runner_invalid", "forbiddenFiles must be an array when provided.");
  }
  if (input.networkPolicy !== "disabled" && input.networkPolicy !== "enabled") {
    return fail(
      "comparative_agent_runner_invalid",
      "networkPolicy must be disabled or enabled."
    );
  }
  if (typeof input.adapter?.run !== "function") {
    return fail("comparative_agent_runner_invalid", "adapter must implement AgentAdapter.run().");
  }
  if (typeof input.evaluator !== "function") {
    return fail("comparative_agent_runner_invalid", "evaluator must be a function.");
  }

  const taskHash = sha256Text(input.task);
  const expectedIdentity: AgentComparableIdentity = {
    taskHash,
    sourceRepositorySnapshotHash: input.sourceRepositorySnapshotHash,
    sourceCommitSha: input.sourceCommitSha,
    agentId: input.adapter.agentId,
    agentVersion: input.adapter.agentVersion,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    validationSpecHash: input.validationSpecHash,
    networkPolicy: input.networkPolicy,
    timeoutBudget: input.timeoutBudget
  };

  createAgentComparisonContract({
    baseline: expectedIdentity,
    bounded: expectedIdentity
  });

  return Object.freeze({
    taskHash,
    forbiddenFiles: Object.freeze([...(input.forbiddenFiles ?? [])]),
    expectedIdentity: Object.freeze({ ...expectedIdentity })
  });
}

function identityFromRun(
  expected: AgentComparableIdentity,
  run: AgentRunResult
): AgentComparableIdentity {
  return Object.freeze({
    ...expected,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
    modelId: run.modelId
  });
}

function requestForArm(
  input: Readonly<{
    arm: AgentComparisonArm;
    workspace: DisposableAgentWorkspaceResult;
    task: string;
    adapter: AgentAdapter;
    modelId: string;
    reasoningEffort: AgentReasoningEffort;
    timeoutBudget: number;
    networkAllowed: boolean;
    abortSignal?: AbortSignal;
  }>
): AgentRunRequest {
  return {
    runId: `comparison.${input.arm}.${createHash("sha256")
      .update(`${input.task}\n${input.workspace.manifestHash}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`,
    agentId: input.adapter.agentId,
    workingDirectory: input.workspace.workspacePath,
    task: input.task,
    model: input.modelId,
    reasoningEffort: input.reasoningEffort,
    mode: input.arm === "baseline" ? "baseline" : "coder",
    timeoutMs: input.timeoutBudget,
    networkAllowed: input.networkAllowed,
    sandboxMode: "workspace_write",
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal })
  };
}

function assertBoundedContextMatchesBaseline(
  baseline: DisposableAgentWorkspaceResult,
  bounded: DisposableAgentWorkspaceResult
): void {
  for (const [path, hash] of Object.entries(bounded.sourceFileHashes)) {
    const baselineHash = baseline.sourceFileHashes[path];
    if (baselineHash === undefined || baselineHash !== hash) {
      fail(
        "comparative_agent_source_snapshot_mismatch",
        `Bounded context file is not byte-identical to the baseline source snapshot: ${path}.`,
        path
      );
    }
  }
}

function freezeWorkspaceSummary(
  arm: AgentComparisonArm,
  workspace: DisposableAgentWorkspaceResult,
  mutableFiles: readonly string[],
  observedChangedFiles: readonly string[]
): ComparativeAgentWorkspaceSummary {
  return Object.freeze({
    mode: arm,
    manifestHash: workspace.manifestHash,
    exposedFileCount: workspace.exposedFileCount,
    exposedBytes: workspace.exposedBytes,
    mutableFiles: Object.freeze([...mutableFiles]),
    changedFiles: Object.freeze([...observedChangedFiles])
  });
}

/**
 * Runs one Product Comparison V1 sample from one source repository snapshot.
 *
 * Both arms receive the same task, model, reasoning effort, timeout, network
 * policy, validation spec, source snapshot, source commit and adapter. Baseline
 * receives the full eligible tracked repository in a disposable workspace;
 * bounded receives only selected context and is fail-closed if it mutates a
 * file outside approvedMutableFiles. The two arms never share a workspace root.
 * Arm execution order is deterministic from taskHash so one arm is not always
 * advantaged by provider/cache warmup effects.
 */
export async function runComparativeAgentSample<TValidationSpec, TEvaluation>(
  input: ComparativeAgentRunnerInput<TValidationSpec, TEvaluation>
): Promise<ComparativeAgentRunnerResult<TEvaluation>> {
  const validated = validateBasicInput(input);
  const repositoryPath = await realpath(input.repositoryPath).catch(() =>
    fail("comparative_agent_runner_invalid", "repositoryPath cannot be resolved.")
  );
  const sourceHeadBefore = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim();
  if (sourceHeadBefore !== input.sourceCommitSha) {
    return fail(
      "comparative_agent_source_commit_mismatch",
      `Source repository HEAD ${sourceHeadBefore} does not match sourceCommitSha ${input.sourceCommitSha}.`
    );
  }

  let baselineWorkspace: DisposableAgentWorkspaceResult | null = null;
  let boundedWorkspace: DisposableAgentWorkspaceResult | null = null;

  try {
    baselineWorkspace = await createDisposableAgentWorkspace({
      repositoryPath,
      sourceSnapshotHash: input.sourceRepositorySnapshotHash,
      visibleFiles: [],
      changeAllowedFiles: [],
      forbiddenFiles: validated.forbiddenFiles,
      mode: "baseline"
    });

    boundedWorkspace = await createDisposableAgentWorkspace({
      repositoryPath,
      sourceSnapshotHash: input.sourceRepositorySnapshotHash,
      visibleFiles: input.selectedContextFiles,
      changeAllowedFiles: input.approvedMutableFiles,
      forbiddenFiles: validated.forbiddenFiles,
      mode: "bounded"
    });

    assertDistinctWorkspaceRoots(
      baselineWorkspace.workspacePath,
      boundedWorkspace.workspacePath
    );
    assertBoundedContextMatchesBaseline(baselineWorkspace, boundedWorkspace);

    const sourceHeadAfterWorkspaceCreation = (
      await runGit(repositoryPath, ["rev-parse", "HEAD"])
    ).trim();
    if (sourceHeadAfterWorkspaceCreation !== sourceHeadBefore) {
      return fail(
        "comparative_agent_source_commit_mismatch",
        "Source repository HEAD changed while twin workspaces were being created."
      );
    }

    const networkAllowed = input.networkPolicy === "enabled";
    const executionOrder = executionOrderForTaskHash(validated.taskHash);
    const baselineMutableFiles = baselineWorkspace.manifest.files.map((entry) => entry.path);
    const boundedMutableFiles = [...input.approvedMutableFiles].sort((left, right) =>
      left.localeCompare(right, "en")
    );
    const approvedMutable = new Set(input.approvedMutableFiles);
    const completed: Partial<Record<AgentComparisonArm, ComparativeAgentArmResult<TEvaluation>>> = {};

    const executeArm = async (
      arm: AgentComparisonArm
    ): Promise<ComparativeAgentArmResult<TEvaluation>> => {
      const workspace = arm === "baseline" ? baselineWorkspace! : boundedWorkspace!;
      const mutableFiles = arm === "baseline" ? baselineMutableFiles : boundedMutableFiles;
      const run = await input.adapter.run(
        requestForArm({
          arm,
          workspace,
          task: input.task,
          adapter: input.adapter,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          timeoutBudget: input.timeoutBudget,
          networkAllowed,
          ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal })
        })
      );
      const observedChangedFiles = await changedFiles(workspace.workspacePath);

      if (arm === "bounded") {
        const unauthorized = observedChangedFiles.find((path) => !approvedMutable.has(path));
        if (unauthorized !== undefined) {
          return fail(
            "comparative_agent_scope_violation",
            `Bounded arm changed a file outside approvedMutableFiles: ${unauthorized}.`,
            unauthorized
          );
        }
      }

      const evaluation = await input.evaluator({
        arm,
        task: input.task,
        workspacePath: workspace.workspacePath,
        workspaceManifest: workspace.manifest,
        mutableFiles: Object.freeze([...mutableFiles]),
        changedFiles: Object.freeze([...observedChangedFiles]),
        run,
        validationSpec: input.validationSpec
      });

      return Object.freeze({
        arm,
        run,
        evaluation,
        workspace: freezeWorkspaceSummary(
          arm,
          workspace,
          mutableFiles,
          observedChangedFiles
        )
      });
    };

    for (const arm of executionOrder) {
      completed[arm] = await executeArm(arm);
    }

    const baselineResult = completed.baseline;
    const boundedResult = completed.bounded;
    if (baselineResult === undefined || boundedResult === undefined) {
      return fail(
        "comparative_agent_runner_invalid",
        "Both comparison arms must complete exactly once."
      );
    }

    const sourceHeadAfterRuns = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim();
    if (sourceHeadAfterRuns !== sourceHeadBefore) {
      return fail(
        "comparative_agent_source_commit_mismatch",
        "Source repository HEAD changed while comparison arms were running."
      );
    }

    const comparison = createAgentComparisonContract({
      baseline: identityFromRun(validated.expectedIdentity, baselineResult.run),
      bounded: identityFromRun(validated.expectedIdentity, boundedResult.run)
    });

    return Object.freeze({
      schemaVersion: COMPARATIVE_AGENT_RUNNER_VERSION,
      comparison,
      executionOrder,
      workspaceIsolation: Object.freeze({
        distinctRoots: true as const,
        boundedContextIsBaselineSubset: true as const
      }),
      arms: Object.freeze({
        baseline: baselineResult,
        bounded: boundedResult
      })
    });
  } finally {
    const cleanup = [baselineWorkspace?.workspacePath, boundedWorkspace?.workspacePath]
      .filter((value): value is string => typeof value === "string")
      .map((path) => rm(path, { recursive: true, force: true }));
    await Promise.all(cleanup);
  }
}
