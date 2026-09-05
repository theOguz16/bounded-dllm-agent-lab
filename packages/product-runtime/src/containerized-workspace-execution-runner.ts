import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  TempExecutionCommandResult,
  TempExecutionIssue,
  TemporaryWorkspaceExecutionContext,
  TemporaryWorkspaceExecutionResult
} from "./temporary-workspace-execution-verifier.js";

export const CONTAINERIZED_VALIDATION_RUNNER_VERSION = "1" as const;
export const DEFAULT_VALIDATION_CONTAINER_IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" as const;
export const DEFAULT_VALIDATION_CONTAINER_LIMITS = Object.freeze({
  memoryBytes: 512 * 1024 * 1024,
  processCount: 64,
  cpuCount: 1,
  tmpfsBytes: 64 * 1024 * 1024,
  validationOutputBytes: 5 * 1024 * 1024
});
export const VALIDATION_CONTAINER_BINDING_LABEL =
  "com.bounded-dllm-agent-lab.validation-binding" as const;

export type ValidationContainerIdentity = Readonly<{
  containerName: string;
  labelKey: typeof VALIDATION_CONTAINER_BINDING_LABEL;
  labelValue: string;
  imageDigest: string;
  transactionBindingHash: string;
}>;

export type ContainerizedWorkspaceExecutionOptions = {
  runtime?: string;
  image?: string;
  memoryBytes?: number;
  processCount?: number;
  cpuCount?: number;
  tmpfsBytes?: number;
  validationOutputBytes?: number;
  containerIdentity?: ValidationContainerIdentity;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_NAME = /^bounded-validation-[0-9a-f]{24}$/;

export function createValidationContainerIdentity(
  transactionBindingHash: string,
  image: string = DEFAULT_VALIDATION_CONTAINER_IMAGE
): ValidationContainerIdentity {
  if (!HASH.test(transactionBindingHash) ||
      !/^\S+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new TypeError("Validation container identity binding is invalid.");
  }
  return Object.freeze({
    containerName: `bounded-validation-${randomBytes(12).toString("hex")}`,
    labelKey: VALIDATION_CONTAINER_BINDING_LABEL,
    labelValue: transactionBindingHash,
    imageDigest: image.slice(image.lastIndexOf("@") + 1),
    transactionBindingHash
  });
}

export function verifyValidationContainerIdentity(
  identity: ValidationContainerIdentity, image: string = DEFAULT_VALIDATION_CONTAINER_IMAGE
): boolean {
  return CONTAINER_NAME.test(identity.containerName) &&
    identity.labelKey === VALIDATION_CONTAINER_BINDING_LABEL &&
    HASH.test(identity.labelValue) && identity.labelValue === identity.transactionBindingHash &&
    HASH.test(identity.transactionBindingHash) &&
    identity.imageDigest === image.slice(image.lastIndexOf("@") + 1);
}

export type ValidationContainerRecoveryResult = Readonly<{
  decision: "validation_container_removed" | "validation_container_absent" |
    "validation_container_identity_mismatch" | "validation_container_recovery_required";
  containerId: string | null;
}>;

export function recoverValidationContainer(
  identity: ValidationContainerIdentity,
  options: Pick<ContainerizedWorkspaceExecutionOptions, "runtime" | "image"> = {}
): ValidationContainerRecoveryResult {
  const runtime = options.runtime ?? "docker";
  const image = options.image ?? DEFAULT_VALIDATION_CONTAINER_IMAGE;
  if (!safeRuntime(runtime) || !verifyValidationContainerIdentity(identity, image)) {
    return { decision: "validation_container_identity_mismatch", containerId: null };
  }
  const invoke = (args: string[]) => {
    try {
      return spawnSync(runtime, args, { shell: false, encoding: "utf8", timeout: 10_000,
        maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch { return null; }
  };
  const info = invoke(["info", "--format", "{{.ServerVersion}}"]) ;
  if (!info || info.error || info.status !== 0) {
    return { decision: "validation_container_recovery_required", containerId: null };
  }
  const listed = invoke(["ps", "--all", "--quiet", "--no-trunc", "--filter",
    `name=^/${identity.containerName}$`]);
  if (!listed || listed.error || listed.status !== 0) {
    return { decision: "validation_container_recovery_required", containerId: null };
  }
  const ids = (listed.stdout ?? "").trim().split("\n").filter(Boolean);
  if (ids.length === 0) {
    return { decision: "validation_container_absent", containerId: null };
  }
  if (ids.length !== 1 || !/^[0-9a-f]{12,64}$/.test(ids[0]!)) {
    return { decision: "validation_container_identity_mismatch", containerId: null };
  }
  const containerId = ids[0]!;
  const inspected = invoke(["container", "inspect", "--format",
    `{{json .Id}}|{{json (index .Config.Labels "${identity.labelKey}")}}|{{json .Config.Image}}`,
    containerId]);
  if (!inspected || inspected.error || inspected.status !== 0) {
    return { decision: "validation_container_recovery_required", containerId };
  }
  const parts = (inspected.stdout ?? "").trim().split("|");
  let inspectedId: unknown; let label: unknown; let configuredImage: unknown;
  try {
    [inspectedId, label, configuredImage] = parts.map((part) => JSON.parse(part));
  } catch {
    return { decision: "validation_container_identity_mismatch", containerId };
  }
  if (inspectedId !== containerId || label !== identity.labelValue ||
      typeof configuredImage !== "string" || !configuredImage.endsWith(`@${identity.imageDigest}`)) {
    return { decision: "validation_container_identity_mismatch", containerId };
  }
  // Always attempt KILL before removal. A stopped container may reject kill;
  // removal and final absence remain mandatory.
  invoke(["kill", "--signal", "KILL", containerId]);
  const removed = invoke(["rm", "--force", containerId]);
  const remaining = invoke(["container", "inspect", containerId]);
  const exact = invoke(["ps", "--all", "--quiet", "--no-trunc", "--filter",
    `name=^/${identity.containerName}$`]);
  if (!removed || removed.error || removed.status !== 0 ||
      !remaining || remaining.error || remaining.status === 0 ||
      !exact || exact.error || exact.status !== 0 || (exact.stdout ?? "").trim() !== "") {
    return { decision: "validation_container_recovery_required", containerId };
  }
  return { decision: "validation_container_removed", containerId };
}

const safeEnvironmentKeyPattern = /^[A-Z_][A-Z0-9_]{0,63}$/;
const secretEnvironmentKeyPattern = /SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|SSH|HOME/i;

function result(
  issues: TempExecutionIssue[], commandResults: TempExecutionCommandResult[], durationMs: number
): TemporaryWorkspaceExecutionResult {
  const passedCommands = commandResults.filter((entry) => entry.passed).length;
  const timedOutCommands = commandResults.filter((entry) => entry.timedOut).length;
  const truncatedOutputs = commandResults.filter((entry) =>
    entry.stdoutTruncated || entry.stderrTruncated).length;
  const decision = commandResults.some((entry) => !entry.passed) ||
    issues.some((entry) => entry.severity === "failure")
    ? "temp_validation_failed"
    : issues.some((entry) => entry.severity === "review")
      ? "temp_validation_needs_review" : "temp_validation_passed";
  return { decision, issues, commandResults, summary: {
    totalCommands: commandResults.length,
    passedCommands,
    failedCommands: commandResults.length - passedCommands,
    timedOutCommands,
    truncatedOutputs,
    durationMs
  } };
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > max) {
    throw new TypeError("Container resource limit is invalid.");
  }
  return selected;
}

function safeRuntime(value: string): boolean {
  return value === path.basename(value) && !value.includes("..") && !value.includes("/") &&
    !value.includes("\\") && value.length > 0;
}

function truncate(value: string, limit: number): { value: string; truncated: boolean } {
  return value.length <= limit
    ? { value, truncated: false }
    : { value: value.slice(0, limit), truncated: true };
}

export function checkValidationContainerInfrastructure(
  options: ContainerizedWorkspaceExecutionOptions = {}
): TempExecutionIssue | null {
  const runtime = options.runtime ?? "docker";
  const image = options.image ?? DEFAULT_VALIDATION_CONTAINER_IMAGE;
  if (!safeRuntime(runtime) || typeof image !== "string" ||
      !/^\S+@sha256:[0-9a-f]{64}$/.test(image)) {
    return { code: "validation_container_configuration_invalid",
      message: "Validation container configuration is invalid.", severity: "failure" };
  }
  const server = spawnSync(runtime, ["info", "--format", "{{.ServerVersion}}"], {
    shell: false, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"]
  });
  if (server.error || server.status !== 0) return {
    code: "validation_container_runtime_unavailable",
    message: "Validation requires an available container runtime; host execution is forbidden.",
    severity: "failure"
  };
  const installed = spawnSync(runtime, ["image", "inspect", image], {
    shell: false, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "ignore"]
  });
  return installed.error || installed.status !== 0 ? {
    code: "validation_container_image_unavailable",
    message: "The pinned validation image must already exist; automatic image pulls are forbidden.",
    severity: "failure"
  } : null;
}

export async function runContainerizedWorkspaceExecution(
  context: TemporaryWorkspaceExecutionContext,
  afterCommand: (command: TempExecutionCommandResult) => Promise<TempExecutionIssue | null>,
  options: ContainerizedWorkspaceExecutionOptions = {}
): Promise<TemporaryWorkspaceExecutionResult> {
  const started = Date.now();
  const issues: TempExecutionIssue[] = [];
  const results: TempExecutionCommandResult[] = [];
  if (context.tempApplyDecision !== "temp_apply_ready" || context.tempWorkspaceCleanedUp ||
      !Array.isArray(context.commands) || context.commands.length === 0 ||
      context.commands.length > (context.maxCommands ?? 5) ||
      !Array.isArray(context.allowedExecutables)) {
    return result([{ code: "validation_container_context_invalid",
      message: "Container validation context is invalid.", severity: "failure" }],
    results, Date.now() - started);
  }
  const infrastructureIssue = checkValidationContainerInfrastructure(options);
  if (infrastructureIssue) return result([infrastructureIssue], results, Date.now() - started);
  const runtime = options.runtime ?? "docker";
  const image = options.image ?? DEFAULT_VALIDATION_CONTAINER_IMAGE;
  const memoryBytes = boundedInteger(options.memoryBytes,
    DEFAULT_VALIDATION_CONTAINER_LIMITS.memoryBytes, 4 * 1024 * 1024 * 1024);
  const processCount = boundedInteger(options.processCount,
    DEFAULT_VALIDATION_CONTAINER_LIMITS.processCount, 1024);
  const tmpfsBytes = boundedInteger(options.tmpfsBytes,
    DEFAULT_VALIDATION_CONTAINER_LIMITS.tmpfsBytes, 1024 * 1024 * 1024);
  const validationOutputBytes = boundedInteger(options.validationOutputBytes,
    DEFAULT_VALIDATION_CONTAINER_LIMITS.validationOutputBytes, 50 * 1024 * 1024);
  const cpuCount = options.cpuCount ?? DEFAULT_VALIDATION_CONTAINER_LIMITS.cpuCount;
  if (!Number.isFinite(cpuCount) || cpuCount <= 0 || cpuCount > 8) throw new TypeError("Container CPU limit is invalid.");
  const workspace = fs.realpathSync(context.tempWorkspacePath);
  if (workspace.includes(",") || workspace.includes("\n") || workspace.includes("\r")) {
    return result([{ code: "validation_container_mount_path_invalid",
      message: "Validation workspace path cannot be represented as a safe container mount.",
      severity: "failure" }], results, Date.now() - started);
  }
  const containerUid = process.getuid?.() ?? 65534;
  const containerGid = process.getgid?.() ?? 65534;
  const maxOutput = context.maxOutputChars ?? 20_000;
  const fallbackTimeout = context.defaultTimeoutMs ?? 30_000;

  for (const command of context.commands) {
    if (!context.allowedExecutables.includes(command.executable) || !safeRuntime(command.executable) ||
        !Array.isArray(command.args) || command.args.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
      issues.push({ code: "validation_container_command_invalid",
        message: "Container validation command is not allowlisted or is unsafe.",
        severity: "failure", commandId: command.id });
      return result(issues, results, Date.now() - started);
    }
    const timeout = command.timeoutMs ?? fallbackTimeout;
    const expected = command.expectedExitCodes ?? [0];
    if (!Number.isSafeInteger(timeout) || timeout <= 0 ||
        timeout > (context.maxTimeoutMs ?? 120_000) || expected.length === 0 ||
        !expected.every(Number.isInteger)) {
      issues.push({ code: "validation_container_command_limits_invalid",
        message: "Container validation command limits are invalid.",
        severity: "failure", commandId: command.id });
      return result(issues, results, Date.now() - started);
    }
    const identity = options.containerIdentity ?? createValidationContainerIdentity(
      `sha256:${randomBytes(32).toString("hex")}`, image);
    if (!verifyValidationContainerIdentity(identity, image)) {
      issues.push({ code: "validation_container_identity_invalid",
        message: "Validation container identity is not bound to the configured image and transaction.",
        severity: "failure", commandId: command.id });
      return result(issues, results, Date.now() - started);
    }
    const name = identity.containerName;
    const environment: string[] = ["--env", "HOME=/nonexistent", "--env", "TMPDIR=/tmp"];
    for (const [key, value] of Object.entries(context.environment ?? {})) {
      if (!safeEnvironmentKeyPattern.test(key) || secretEnvironmentKeyPattern.test(key) ||
          typeof value !== "string" || value.includes("\0")) {
        issues.push({ code: "validation_container_environment_invalid",
          message: "Container environment contains a forbidden entry.", severity: "failure",
          commandId: command.id });
        return result(issues, results, Date.now() - started);
      }
      environment.push("--env", `${key}=${value}`);
    }
    const args = ["run", "--detach", "--pull", "never", "--name", name,
      "--label", `${identity.labelKey}=${identity.labelValue}`, "--stop-timeout", "1",
      "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--memory", String(memoryBytes),
      "--memory-swap", String(memoryBytes), "--pids-limit", String(processCount),
      "--cpus", String(cpuCount), "--user", `${containerUid}:${containerGid}`,
      "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`,
      "--workdir", "/workspace", "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsBytes}`,
      "--tmpfs", `/workspace/.validation-output:rw,noexec,nosuid,nodev,size=${validationOutputBytes},mode=0700,uid=${containerUid},gid=${containerGid}`,
      ...environment, image, "node", "-e", "setInterval(()=>{},2147483647)"];
    const commandStartedMs = Date.now();
    let commandResult: TempExecutionCommandResult | null = null;
    let commandPassed = false;
    let lifecycleStage: "container_start" | "command" = "container_start";
    try {
      const container = spawnSync(runtime, args, { shell: false, encoding: "utf8", timeout: 10_000,
        killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"] });
      if (container.error !== undefined || container.status !== 0) {
        throw container.error ?? new Error("Validation container could not be created.");
      }
      lifecycleStage = "command";
      const execution = spawnSync(runtime, ["exec", name, command.executable, ...command.args],
        { shell: false, encoding: "utf8", timeout,
        killSignal: "SIGKILL",
        maxBuffer: Math.max(maxOutput * 4 + 4096, 4096), stdio: ["ignore", "pipe", "pipe"] });
      const commandFinishedMs = Date.now();
      const errorCode = execution.error !== undefined && "code" in execution.error
        ? execution.error.code : null;
      const timedOut = errorCode === "ETIMEDOUT";
      const outputOverflow = errorCode === "ENOBUFS";
      const stdout = truncate(execution.stdout ?? "", maxOutput);
      const stderr = truncate(execution.stderr ?? "", maxOutput);
      const launchFailed = execution.error !== undefined && !timedOut && !outputOverflow;
      commandPassed = !timedOut && !outputOverflow && !launchFailed &&
        execution.status !== null && expected.includes(execution.status);
      commandResult = {
        id: command.id, executable: command.executable, args: [...command.args],
        startedAt: new Date(commandStartedMs).toISOString(),
        finishedAt: new Date(commandFinishedMs).toISOString(),
        durationMs: commandFinishedMs - commandStartedMs,
        exitCode: execution.status, signal: execution.signal, timedOut,
        stdout: stdout.value, stderr: stderr.value,
        stdoutTruncated: stdout.truncated || outputOverflow,
        stderrTruncated: stderr.truncated || outputOverflow, passed: commandPassed
      };
      results.push(commandResult);
      if (stdout.truncated || stderr.truncated || outputOverflow) issues.push({
        code: outputOverflow ? "validation_container_output_overflow" : "validation_output_truncated",
        message: outputOverflow
          ? "Container runtime output exceeded the bounded process buffer."
          : "Validation command output exceeded the configured capture limit.",
        severity: outputOverflow ? "failure" : "review", commandId: command.id });
      if (timedOut) issues.push({ code: "validation_command_timeout",
        message: "Containerized validation command timed out and required forced cleanup.",
        severity: "failure", commandId: command.id });
      else if (launchFailed) issues.push({ code: "validation_container_launch_failed",
        message: "Containerized validation could not be started.", severity: "failure", commandId: command.id });
      else if (!commandPassed && !outputOverflow) issues.push({ code: "validation_command_failed",
        message: "Containerized validation exited with an unexpected code.", severity: "failure", commandId: command.id });
      try {
        const integrityFailure = await afterCommand(commandResult);
        if (integrityFailure) issues.push(integrityFailure);
      } catch {
        issues.push({ code: "validation_after_command_callback_failed",
          message: "Post-command integrity verification failed unexpectedly.",
          severity: "failure", commandId: command.id });
        commandPassed = false;
      }
    } catch {
      issues.push({ code: lifecycleStage === "container_start"
        ? "validation_container_launch_failed" : "validation_container_unexpected_exception",
        message: "Containerized validation failed with an unexpected runtime exception.",
        severity: "failure", commandId: command.id });
      commandPassed = false;
    } finally {
      const cleanup = recoverValidationContainer(identity, { runtime, image });
      if (!new Set(["validation_container_removed", "validation_container_absent"])
        .has(cleanup.decision)) {
        issues.push({ code: "validation_container_cleanup_recovery_required",
          message: "Container cleanup could not prove removal; infrastructure recovery is required.",
          severity: "failure", commandId: command.id });
        commandPassed = false;
      }
    }
    if (!commandPassed || issues.some((entry) =>
      entry.commandId === command.id && entry.severity === "failure")) {
      return result(issues, results, Date.now() - started);
    }
  }
  return result(issues, results, Date.now() - started);
}
