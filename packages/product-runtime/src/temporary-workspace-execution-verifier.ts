import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashCanonicalJson } from "./agent-event-ledger.js";

export type TempExecutionDecision =
  | "temp_validation_passed"
  | "temp_validation_failed"
  | "temp_validation_needs_review";

export type TempExecutionIssue = {
  code: string;
  message: string;
  severity: "review" | "failure";
  commandId?: string;
};

export type TempExecutionCommand = {
  id: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
  expectedExitCodes?: number[];
};

export type TempExecutionCommandResult = {
  id: string;
  executable: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  passed: boolean;
};

export type TemporaryWorkspaceExecutionContext = {
  tempWorkspacePath: string;
  tempApplyDecision: "temp_apply_ready";
  tempWorkspaceCleanedUp: boolean;
  commands: TempExecutionCommand[];
  allowedExecutables: string[];
  maxCommands?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  environment?: Record<string, string>;
};

export type TemporaryWorkspaceExecutionResult = {
  decision: TempExecutionDecision;
  issues: TempExecutionIssue[];
  commandResults: TempExecutionCommandResult[];
  summary: {
    totalCommands: number;
    passedCommands: number;
    failedCommands: number;
    timedOutCommands: number;
    truncatedOutputs: number;
    durationMs: number;
  };
};

/**
 * Canonical Phase V command specification without invocation-specific workspace state.
 * It is the exact subset used to construct TemporaryWorkspaceExecutionContext.
 */
export type TemporaryWorkspaceExecutionSpecification = Omit<
  TemporaryWorkspaceExecutionContext,
  "tempWorkspacePath" | "tempApplyDecision" | "tempWorkspaceCleanedUp"
>;

export type TemporaryWorkspaceExecutionVerificationEvidence = {
  evidenceVersion: "1";
  validationSpecificationHash: string;
  decision: TempExecutionDecision;
  issueCodes: readonly string[];
  steps: readonly {
    index: number;
    stepIdentifierHash: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdoutHash: string;
    stderrHash: string;
    stdoutBytes: number;
    stderrBytes: number;
    outputTruncated: boolean;
    passed: boolean;
    stepHash: string;
  }[];
  requiredStepCount: number;
  completedStepCount: number;
  passedStepCount: number;
  cleanupRequired: true;
  cleanupSucceeded: boolean;
  verificationResultHash: string;
};

function normalizedSpecification(
  specification: TemporaryWorkspaceExecutionSpecification
): Record<string, unknown> {
  return {
    artifactType: "temporary_workspace_execution_specification",
    workspaceRule: "isolated_workspace_root",
    tempApplyDecision: "temp_apply_ready",
    commands: specification.commands.map((command) => ({
      id: command.id,
      executable: command.executable,
      args: [...command.args],
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(command.expectedExitCodes === undefined ? {} : {
        expectedExitCodes: [...command.expectedExitCodes]
      })
    })),
    allowedExecutables: [...specification.allowedExecutables],
    ...(specification.maxCommands === undefined ? {} : {
      maxCommands: specification.maxCommands
    }),
    ...(specification.defaultTimeoutMs === undefined ? {} : {
      defaultTimeoutMs: specification.defaultTimeoutMs
    }),
    ...(specification.maxTimeoutMs === undefined ? {} : {
      maxTimeoutMs: specification.maxTimeoutMs
    }),
    ...(specification.maxOutputChars === undefined ? {} : {
      maxOutputChars: specification.maxOutputChars
    }),
    ...(specification.environment === undefined ? {} : {
      environment: { ...specification.environment }
    })
  };
}

export function computeTemporaryWorkspaceExecutionSpecificationHash(
  specification: TemporaryWorkspaceExecutionSpecification
): string {
  return hashCanonicalJson(normalizedSpecification(specification));
}

export function buildTemporaryWorkspaceExecutionVerificationEvidence(
  specification: TemporaryWorkspaceExecutionSpecification,
  result: TemporaryWorkspaceExecutionResult,
  cleanupSucceeded: boolean
): TemporaryWorkspaceExecutionVerificationEvidence {
  const validationSpecificationHash =
    computeTemporaryWorkspaceExecutionSpecificationHash(specification);
  const steps = result.commandResults.map((command, index) => {
    const stepIdentifierHash = hashCanonicalJson({
      artifactType: "temporary_workspace_execution_step_identifier",
      index,
      id: command.id,
      executable: command.executable,
      args: command.args
    });
    const material = {
      index,
      stepIdentifierHash,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      stdoutHash: hashCanonicalJson({ artifactType: "validation_stdout", value: command.stdout }),
      stderrHash: hashCanonicalJson({ artifactType: "validation_stderr", value: command.stderr }),
      stdoutBytes: Buffer.byteLength(command.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(command.stderr, "utf8"),
      outputTruncated: command.stdoutTruncated || command.stderrTruncated,
      passed: command.passed
    };
    return { ...material, stepHash: hashCanonicalJson(material) };
  });
  const material = {
    evidenceVersion: "1" as const,
    validationSpecificationHash,
    decision: result.decision,
    issueCodes: [...new Set(result.issues.map((issue) => issue.code))].sort(),
    steps,
    requiredStepCount: specification.commands.length,
    completedStepCount: result.summary.totalCommands,
    passedStepCount: result.summary.passedCommands,
    cleanupRequired: true as const,
    cleanupSucceeded
  };
  return { ...material, verificationResultHash: hashCanonicalJson(material) };
}

const defaultMaxCommands = 5;
const defaultTimeoutMs = 30_000;
const defaultMaxTimeoutMs = 120_000;
const defaultMaxOutputChars = 20_000;
const unsafeEnvironmentKeyPattern =
  /SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL/i;

function addIssue(
  issues: TempExecutionIssue[],
  code: string,
  message: string,
  severity: TempExecutionIssue["severity"],
  commandId?: string
): void {
  issues.push({
    code,
    message,
    severity,
    ...(commandId === undefined ? {} : { commandId })
  });
}

function selectDecision(
  issues: TempExecutionIssue[],
  commandResults: TempExecutionCommandResult[]
): TempExecutionDecision {
  if (
    commandResults.some((result) => !result.passed || result.timedOut) ||
    issues.some((issue) => issue.severity === "failure")
  ) {
    return "temp_validation_failed";
  }

  if (issues.some((issue) => issue.severity === "review")) {
    return "temp_validation_needs_review";
  }

  return "temp_validation_passed";
}

function buildResult(
  issues: TempExecutionIssue[],
  commandResults: TempExecutionCommandResult[],
  durationMs: number
): TemporaryWorkspaceExecutionResult {
  const passedCommands = commandResults.filter((result) => result.passed).length;
  const timedOutCommands = commandResults.filter(
    (result) => result.timedOut
  ).length;
  const truncatedOutputs = commandResults.filter(
    (result) => result.stdoutTruncated || result.stderrTruncated
  ).length;

  return {
    decision: selectDecision(issues, commandResults),
    issues,
    commandResults,
    summary: {
      totalCommands: commandResults.length,
      passedCommands,
      failedCommands: commandResults.length - passedCommands,
      timedOutCommands,
      truncatedOutputs,
      durationMs
    }
  };
}

function isUnderTempRoot(resolvedPath: string): boolean {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(tempRoot, resolvedPath);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isUnsafeExecutable(executable: unknown): executable is string {
  return (
    typeof executable !== "string" ||
    executable.length === 0 ||
    path.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    executable.includes("..") ||
    path.basename(executable) !== executable
  );
}

function isIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => Number.isInteger(entry))
  );
}

function truncateOutput(
  value: string,
  maxOutputChars: number
): { output: string; truncated: boolean } {
  if (value.length <= maxOutputChars) {
    return { output: value, truncated: false };
  }

  return { output: value.slice(0, maxOutputChars), truncated: true };
}

function validateEnvironment(
  issues: TempExecutionIssue[],
  environment: TemporaryWorkspaceExecutionContext["environment"]
): boolean {
  if (environment === undefined) {
    return true;
  }

  for (const [key, value] of Object.entries(environment)) {
    if (unsafeEnvironmentKeyPattern.test(key)) {
      addIssue(
        issues,
        "unsafe_environment_key",
        `Environment key is unsafe for temporary workspace validation: ${key}`,
        "review"
      );
      return false;
    }

    if (typeof value !== "string") {
      addIssue(
        issues,
        "invalid_environment_value",
        `Environment value must be a string for key: ${key}`,
        "review"
      );
      return false;
    }
  }

  return true;
}

function buildEnvironment(
  environment: TemporaryWorkspaceExecutionContext["environment"]
): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[key];

    if (typeof value === "string") {
      safeEnvironment[key] = value;
    }
  }

  return { ...safeEnvironment, ...(environment ?? {}) };
}

export function verifyTemporaryWorkspaceExecution(
  context: TemporaryWorkspaceExecutionContext
): TemporaryWorkspaceExecutionResult {
  const execution = executeCommands(context);
  let step = execution.next();
  while (!step.done) step = execution.next(null);
  return step.value;
}

/** Await an integrity check before allowing the next command to start. */
export async function verifyTemporaryWorkspaceExecutionWithCheck(
  context: TemporaryWorkspaceExecutionContext,
  afterCommand: (command: TempExecutionCommandResult) => Promise<TempExecutionIssue | null>
): Promise<TemporaryWorkspaceExecutionResult> {
  const execution = executeCommands(context);
  let step = execution.next();
  while (!step.done) {
    let failure: TempExecutionIssue | null;
    try {
      failure = await afterCommand(step.value);
    } catch {
      failure = {
        code: "validation_command_integrity_check_failed",
        message: "Candidate integrity could not be verified after the command.",
        severity: "failure",
        commandId: step.value.id
      };
    }
    step = execution.next(failure);
  }
  return step.value;
}

function* executeCommands(
  context: TemporaryWorkspaceExecutionContext
): Generator<TempExecutionCommandResult, TemporaryWorkspaceExecutionResult, TempExecutionIssue | null> {
  const startedAtMs = Date.now();
  const issues: TempExecutionIssue[] = [];
  const commandResults: TempExecutionCommandResult[] = [];

  if (context.tempApplyDecision !== "temp_apply_ready") {
    addIssue(
      issues,
      "temp_apply_not_ready",
      "Temporary workspace apply decision is not temp_apply_ready.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  if (context.tempWorkspaceCleanedUp) {
    addIssue(
      issues,
      "temp_workspace_already_cleaned",
      "Temporary workspace was already cleaned up.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  if (!fs.existsSync(context.tempWorkspacePath)) {
    addIssue(
      issues,
      "temp_workspace_missing",
      "Temporary workspace path does not exist.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  const workspaceStats = fs.statSync(context.tempWorkspacePath);

  if (!workspaceStats.isDirectory()) {
    addIssue(
      issues,
      "temp_workspace_not_directory",
      "Temporary workspace path is not a directory.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  const resolvedWorkspacePath = fs.realpathSync(context.tempWorkspacePath);

  if (!isUnderTempRoot(resolvedWorkspacePath)) {
    addIssue(
      issues,
      "workspace_outside_temp_root",
      "Temporary workspace path must resolve under the OS temporary directory.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  const maxCommands = context.maxCommands ?? defaultMaxCommands;
  const commandList = context.commands;

  if (commandList.length === 0) {
    addIssue(
      issues,
      "no_validation_commands",
      "At least one trusted validation command is required.",
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  if (commandList.length > maxCommands) {
    addIssue(
      issues,
      "too_many_validation_commands",
      `Validation command count exceeds maxCommands: ${maxCommands}.`,
      "review"
    );
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  if (!validateEnvironment(issues, context.environment)) {
    return buildResult(issues, commandResults, Date.now() - startedAtMs);
  }

  const maxTimeoutMs = context.maxTimeoutMs ?? defaultMaxTimeoutMs;
  const fallbackTimeoutMs = context.defaultTimeoutMs ?? defaultTimeoutMs;
  const maxOutputChars = context.maxOutputChars ?? defaultMaxOutputChars;
  const allowedExecutables = new Set(context.allowedExecutables);
  const processEnvironment = buildEnvironment(context.environment);

  for (const command of commandList) {
    if (isUnsafeExecutable(command.executable)) {
      addIssue(
        issues,
        "unsafe_executable",
        `Validation executable is unsafe: ${String(command.executable)}`,
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    if (!allowedExecutables.has(command.executable)) {
      addIssue(
        issues,
        "executable_not_allowed",
        `Validation executable is not allowlisted: ${command.executable}`,
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    if (
      !Array.isArray(command.args) ||
      !command.args.every((argument) => typeof argument === "string")
    ) {
      addIssue(
        issues,
        "invalid_command_args",
        "Validation command args must be an array of strings.",
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    if (command.args.some((argument) => argument.includes("\0"))) {
      addIssue(
        issues,
        "unsafe_command_argument",
        "Validation command args must not contain null bytes.",
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    const commandTimeoutMs = command.timeoutMs ?? fallbackTimeoutMs;

    if (commandTimeoutMs <= 0 || commandTimeoutMs > maxTimeoutMs) {
      addIssue(
        issues,
        "invalid_command_timeout",
        `Validation command timeout is outside allowed bounds: ${commandTimeoutMs}.`,
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    const expectedExitCodes = command.expectedExitCodes ?? [0];

    if (!isIntegerArray(expectedExitCodes)) {
      addIssue(
        issues,
        "invalid_expected_exit_codes",
        "Validation command expectedExitCodes must be a non-empty array of integers.",
        "review",
        command.id
      );
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }

    const commandStartedAtMs = Date.now();
    const commandStartedAt = new Date(commandStartedAtMs).toISOString();
    const execution = spawnSync(command.executable, command.args, {
      cwd: resolvedWorkspacePath,
      shell: false,
      encoding: "utf8",
      env: processEnvironment,
      timeout: commandTimeoutMs,
      maxBuffer: Math.max(maxOutputChars * 2 + 1024, 1024)
    });
    const commandFinishedAtMs = Date.now();
    const commandFinishedAt = new Date(commandFinishedAtMs).toISOString();
    const stdout = truncateOutput(execution.stdout ?? "", maxOutputChars);
    const stderr = truncateOutput(execution.stderr ?? "", maxOutputChars);
    const timedOut =
      execution.error !== undefined &&
      "code" in execution.error &&
      execution.error.code === "ETIMEDOUT";
    const launchFailed = execution.error !== undefined && !timedOut;
    const passed =
      !timedOut &&
      !launchFailed &&
      execution.status !== null &&
      expectedExitCodes.includes(execution.status);

    const result: TempExecutionCommandResult = {
      id: command.id,
      executable: command.executable,
      args: [...command.args],
      startedAt: commandStartedAt,
      finishedAt: commandFinishedAt,
      durationMs: commandFinishedAtMs - commandStartedAtMs,
      exitCode: execution.status,
      signal: execution.signal,
      timedOut,
      stdout: stdout.output,
      stderr: stderr.output,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      passed
    };

    commandResults.push(result);

    if (stdout.truncated || stderr.truncated) {
      addIssue(
        issues,
        "validation_output_truncated",
        "Validation command output exceeded the configured capture limit.",
        "review",
        command.id
      );
    }

    if (timedOut) {
      addIssue(
        issues,
        "validation_command_timeout",
        "Validation command timed out.",
        "failure",
        command.id
      );
    } else if (launchFailed) {
      addIssue(
        issues,
        "validation_command_launch_failed",
        `Validation command could not be started: ${command.executable}`,
        "failure",
        command.id
      );
    } else if (!passed) {
      addIssue(
        issues,
        "validation_command_failed",
        `Validation command exited with an unexpected code: ${String(execution.status)}.`,
        "failure",
        command.id
      );
    }
    const integrityFailure = yield result;
    if (integrityFailure) {
      issues.push(integrityFailure);
      return buildResult(issues, commandResults, Date.now() - startedAtMs);
    }
  }

  return buildResult(issues, commandResults, Date.now() - startedAtMs);
}
