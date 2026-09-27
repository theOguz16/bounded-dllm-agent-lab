import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TempExecutionCommandResult,
  TempExecutionIssue,
  TemporaryWorkspaceExecutionContext,
  TemporaryWorkspaceExecutionResult
} from "./temporary-workspace-execution-verifier.js";
import { VALIDATION_CHECK_KINDS } from "./runtime-contract-foundation.js";

// Validation input authority is deliberately wider than repository currentness:
// existing build, cache and dependency entries can affect command behavior.
const VALIDATION_INTEGRITY_LIMITS = Object.freeze({
  maximumEntries: 100_000,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumTotalBytes: 2 * 1024 * 1024 * 1024,
  maximumGeneratedEntries: 20_000,
  maximumGeneratedBytes: 512 * 1024 * 1024
});
type ValidationEntry = Readonly<{
  kind: "directory" | "file" | "symlink";
  mode: number;
  byteLength: number;
  hash: string | null;
}>;
type GeneratedEntry = Readonly<{ path: string; entry: ValidationEntry; producerCommandId: string }>;

function validationManifest(root: string): Map<string, ValidationEntry> {
  const records = new Map<string, ValidationEntry>();
  const resolvedRoot = fs.realpathSync(root);
  let totalBytes = 0;
  const walk = (directory: string, relative: string, depth: number): void => {
    if (depth > 64) throw new Error("Validation input exceeds traversal depth.");
    for (const name of fs.readdirSync(directory)) {
      const child = relative === "" ? name : `${relative}/${name}`;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (child === ".validation-output" && !stat.isDirectory()) {
        throw new Error("Validation output mount must be an ordinary directory.");
      }
      if (records.size >= VALIDATION_INTEGRITY_LIMITS.maximumEntries) {
        throw new Error("Validation input exceeds entry limit.");
      }
      let entry: ValidationEntry;
      if (stat.isDirectory()) {
        entry = { kind: "directory", mode: stat.mode & 0o777, byteLength: 0, hash: null };
      } else if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error("Validation input symlink escapes its workspace.");
        }
        const bytes = Buffer.from(fs.readlinkSync(absolute), "utf8");
        entry = { kind: "symlink", mode: stat.mode & 0o777, byteLength: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex") };
      } else if (stat.isFile()) {
        if (stat.size > VALIDATION_INTEGRITY_LIMITS.maximumFileBytes) {
          throw new Error("Validation input file exceeds size limit.");
        }
        entry = { kind: "file", mode: stat.mode & 0o777, byteLength: stat.size,
          hash: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
      } else {
        throw new Error("Validation input contains a special file.");
      }
      totalBytes += entry.byteLength;
      if (totalBytes > VALIDATION_INTEGRITY_LIMITS.maximumTotalBytes) {
        throw new Error("Validation input exceeds total byte limit.");
      }
      records.set(child, entry);
      if (stat.isDirectory()) {
        // This path is reserved for the separately bounded container tmpfs.
        if (child === ".validation-output") {
          if (fs.readdirSync(absolute).length !== 0) {
            throw new Error("Validation output mount contains pre-existing input.");
          }
        } else walk(absolute, child, depth + 1);
      }
    }
  };
  walk(resolvedRoot, "", 0);
  return records;
}

function sameValidationEntry(left: ValidationEntry | undefined, right: ValidationEntry): boolean {
  return left !== undefined && left.kind === right.kind && left.mode === right.mode &&
    left.byteLength === right.byteLength && left.hash === right.hash;
}

function validGeneratedOutputRoots(value: unknown, input: Map<string, ValidationEntry>): value is string[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) return false;
  return value.every((root) => {
    if (typeof root !== "string" || root.length === 0 || root.length > 240 ||
        root.startsWith("/") || root.includes("\\") || /[\x00-\x1f\x7f]/.test(root) ||
        root.split("/").some((segment) => !segment || segment === "." || segment === ".." ||
          [".git", ".bounded", ".validation-output", "node_modules"].includes(segment))) return false;
    const segments = root.split("/");
    return segments.every((_, index) => input.get(segments.slice(0, index + 1).join("/"))?.kind !== "symlink");
  });
}

function disposableRootIsDerived(repository: string, workspace: string, root: string): boolean {
  const invoke = (args: string[]) => spawnSync("git", args, { cwd: repository, shell: false,
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
  const top = invoke(["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== repository) return false;
  const ignored = invoke(["check-ignore", "--quiet", "--no-index", "--", `${root}/`]);
  const authoritative = invoke(["ls-files", "--cached", "--others", "--exclude-standard",
    "-z", "--", `${root}/`]);
  if (ignored.error || ignored.status !== 0 || authoritative.error ||
      authoritative.status !== 0 || authoritative.stdout.length !== 0) return false;
  const sourceRoot = path.join(repository, root);
  const candidateRoot = path.join(workspace, root);
  const sourceStat = fs.lstatSync(sourceRoot, { throwIfNoEntry: false });
  const candidateStat = fs.lstatSync(candidateRoot, { throwIfNoEntry: false });
  if (sourceStat === undefined || candidateStat === undefined) {
    return sourceStat === undefined && candidateStat === undefined;
  }
  if (!sourceStat.isDirectory() || !candidateStat.isDirectory()) return false;
  const sourceRecords = validationManifest(sourceRoot);
  const candidateRecords = validationManifest(candidateRoot);
  return sourceRecords.size === candidateRecords.size && [...sourceRecords].every(([relative, entry]) =>
    candidateRecords.get(relative)?.kind === entry.kind &&
    candidateRecords.get(relative)?.byteLength === entry.byteLength &&
    candidateRecords.get(relative)?.hash === entry.hash);
}

function authorizedGeneratedPath(relative: string, kind: ValidationEntry["kind"], roots: readonly string[]): boolean {
  return roots.some((root) => relative === root || relative.startsWith(`${root}/`) ||
    (kind === "directory" && root.startsWith(`${relative}/`)));
}

function copyGeneratedEntries(source: string, destination: string, entries: readonly GeneratedEntry[]): void {
  for (const { path: relative, entry } of entries) {
    const target = path.join(destination, relative);
    if (entry.kind === "directory") fs.mkdirSync(target, { recursive: true, mode: entry.mode });
    else if (entry.kind === "file") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, relative), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, entry.mode);
    } else throw new Error("Generated validation symlink is forbidden.");
  }
}

export const CONTAINERIZED_VALIDATION_RUNNER_VERSION = "1" as const;
export const DEFAULT_VALIDATION_CONTAINER_IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" as const;
export const DEFAULT_VALIDATION_CONTAINER_LIMITS = Object.freeze({
  memoryBytes: 1024 * 1024 * 1024,
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
  /** Canonical Git checkout used to verify that discarded output is ignored derived state. */
  sourceRepositoryPath?: string;
  memoryBytes?: number;
  processCount?: number;
  cpuCount?: number;
  tmpfsBytes?: number;
  validationOutputBytes?: number;
  containerIdentity?: ValidationContainerIdentity;
  onLifecycleCheckpoint?: (event: Readonly<{
    phase: "container_create_intent" | "container_created" | "container_cleanup_completed";
    commandId: string; identity: ValidationContainerIdentity; containerId: string | null;
    cleanupDecision: ValidationContainerRecoveryResult["decision"] | null;
  }>) => void | Promise<void>;
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_NAME = /^bounded-validation-[0-9a-f]{24}$/;

export function createValidationContainerIdentity(
  transactionBindingHash: string,
  image: string = DEFAULT_VALIDATION_CONTAINER_IMAGE,
  stableContainerName?: string
): ValidationContainerIdentity {
  if (!HASH.test(transactionBindingHash) ||
      !/^\S+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new TypeError("Validation container identity binding is invalid.");
  }
  const containerName = stableContainerName ?? `bounded-validation-${randomBytes(12).toString("hex")}`;
  if (!CONTAINER_NAME.test(containerName)) throw new TypeError("Validation container name is invalid.");
  return Object.freeze({
    containerName,
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

  // Every command receives a fresh copy of the immutable candidate authority.
  // Only bounded, hashed files newly generated by a successful prior command
  // are carried forward with explicit producer provenance.
  let executionWorkspace: string | null = null;
  let inputRecords: Map<string, ValidationEntry>;
  let generatedEntries: GeneratedEntry[] = [];
  const retiredInputPaths = new Set<string>();
  const retiredRoots = new Set<string>();
  try {
    inputRecords = validationManifest(workspace);
  } catch {
    return result([{ code: "validation_workspace_staging_failed",
      message: "Validation candidate input could not be inventoried.", severity: "failure" }],
    results, Date.now() - started);
  }

  try {
    for (const command of context.commands) {
      if (!context.allowedExecutables.includes(command.executable) || !safeRuntime(command.executable) ||
          (command.checkKind as string | undefined) === "structural" ||
          command.checkKind !== undefined &&
            !VALIDATION_CHECK_KINDS.includes(command.checkKind as (typeof VALIDATION_CHECK_KINDS)[number]) ||
          !Array.isArray(command.args) || command.args.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
        issues.push({ code: "validation_container_command_invalid",
          message: "Container validation command is not allowlisted or is unsafe.",
          severity: "failure", commandId: command.id });
        return result(issues, results, Date.now() - started);
      }
      if (!validGeneratedOutputRoots(command.generatedOutputRoots, inputRecords)) {
        issues.push({ code: "validation_generated_output_authority_invalid",
          message: "Generated output roots must be explicit, safe repository-relative paths.",
          severity: "failure", commandId: command.id });
        return result(issues, results, Date.now() - started);
      }
      const disposableRoots = command.disposableGeneratedOutputRoots ?? [];
      if (!validGeneratedOutputRoots(disposableRoots, inputRecords) ||
          disposableRoots.some((root) => !command.generatedOutputRoots?.includes(root) ||
            inputRecords.get(root)?.kind === "file") ||
          disposableRoots.some((root, index) => disposableRoots.some((other, otherIndex) =>
            index !== otherIndex && root.startsWith(`${other}/`)))) {
        issues.push({ code: "validation_disposable_output_authority_invalid",
          message: "Disposable generated roots must be distinct authorized directories.",
          severity: "failure", commandId: command.id });
        return result(issues, results, Date.now() - started);
      }
      if (disposableRoots.length > 0) {
        try {
          const repository = fs.realpathSync(options.sourceRepositoryPath ?? "");
          if (repository === workspace || repository.startsWith(`${workspace}${path.sep}`) ||
              workspace.startsWith(`${repository}${path.sep}`) ||
              disposableRoots.some((root) => !disposableRootIsDerived(repository, workspace, root))) {
            throw new Error("Disposable output root is not verified derived state.");
          }
        } catch {
          issues.push({ code: "validation_disposable_output_authority_invalid",
            message: "Disposable output root contains authoritative or unverified input.",
            severity: "failure", commandId: command.id });
          return result(issues, results, Date.now() - started);
        }
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
      let freshWorkspace: string | null = null;
      try {
        const authorityRecords = validationManifest(workspace);
        if (inputRecords.size !== authorityRecords.size || [...inputRecords].some(([relative, entry]) =>
          !sameValidationEntry(authorityRecords.get(relative), entry))) {
          throw new Error("Validation candidate authority changed.");
        }
        if (executionWorkspace !== null) {
          const priorRecords = validationManifest(executionWorkspace);
          if (generatedEntries.some(({ path: relative, entry }) =>
            !sameValidationEntry(priorRecords.get(relative), entry))) {
            throw new Error("Generated validation output changed after capture.");
          }
        }
        freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-validation-execution-"));
        fs.cpSync(workspace, freshWorkspace,
          { recursive: true, force: false, verbatimSymlinks: true });
        for (const root of new Set([...retiredRoots, ...disposableRoots])) {
          fs.rmSync(path.join(freshWorkspace, root), { recursive: true, force: true });
        }
        const activeGeneratedEntries = generatedEntries.filter(({ path: relative }) =>
          !disposableRoots.some((root) => relative === root || relative.startsWith(`${root}/`)));
        if (executionWorkspace !== null) copyGeneratedEntries(
          executionWorkspace, freshWorkspace, activeGeneratedEntries);
        generatedEntries = activeGeneratedEntries;
        for (const root of disposableRoots) retiredRoots.add(root);
        for (const relative of inputRecords.keys()) {
          if (disposableRoots.some((root) => relative === root || relative.startsWith(`${root}/`))) {
            retiredInputPaths.add(relative);
          }
        }
        const stagedRecords = validationManifest(freshWorkspace);
        if ([...inputRecords].some(([relative, entry]) => !retiredInputPaths.has(relative) &&
          !sameValidationEntry(stagedRecords.get(relative), entry)) ||
          generatedEntries.some(({ path: relative, entry }) =>
            !sameValidationEntry(stagedRecords.get(relative), entry)) ||
          stagedRecords.size !== inputRecords.size - retiredInputPaths.size + generatedEntries.length) {
          throw new Error("Validation staging did not preserve bound inputs and outputs.");
        }
        if (executionWorkspace !== null) fs.rmSync(executionWorkspace, { recursive: true, force: true });
        executionWorkspace = freshWorkspace;
      } catch {
        if (freshWorkspace !== null && freshWorkspace !== executionWorkspace) {
          fs.rmSync(freshWorkspace, { recursive: true, force: true });
        }
        issues.push({ code: "validation_workspace_staging_failed",
          message: "Disposable validation command input could not be prepared or verified.",
          severity: "failure", commandId: command.id });
        return result(issues, results, Date.now() - started);
      }
      const args = ["run", "--detach", "--pull", "never", "--name", name,
        "--label", `${identity.labelKey}=${identity.labelValue}`, "--stop-timeout", "1",
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", String(memoryBytes),
        "--memory-swap", String(memoryBytes), "--pids-limit", String(processCount),
        "--cpus", String(cpuCount), "--user", `${containerUid}:${containerGid}`,
        "--mount", `type=bind,src=${workspace},dst=/candidate-input,readonly`,
        "--mount", `type=bind,src=${executionWorkspace},dst=/workspace`,
        "--workdir", "/workspace", "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsBytes}`,
        "--tmpfs", `/workspace/.validation-output:rw,noexec,nosuid,nodev,size=${validationOutputBytes},mode=0700,uid=${containerUid},gid=${containerGid}`,
        ...environment, image, "node", "-e", "setInterval(()=>{},2147483647)"];
      const commandStartedMs = Date.now();
      let commandResult: TempExecutionCommandResult | null = null;
      let commandPassed = false;
      let lifecycleStage: "container_start" | "command" = "container_start";
      try {
        await options.onLifecycleCheckpoint?.({ phase: "container_create_intent",
          commandId: command.id, identity, containerId: null, cleanupDecision: null });
        const container = spawnSync(runtime, args, { shell: false, encoding: "utf8", timeout: 10_000,
          killSignal: "SIGKILL", maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "pipe"] });
        if (container.error !== undefined || container.status !== 0) {
          throw container.error ?? new Error("Validation container could not be created.");
        }
        const containerId = (container.stdout ?? "").trim();
        if (!/^[0-9a-f]{12,64}$/.test(containerId)) throw new Error(
          "Validation runtime returned an invalid container identity.");
        await options.onLifecycleCheckpoint?.({ phase: "container_created",
          commandId: command.id, identity, containerId, cleanupDecision: null });
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
          const currentRecords = validationManifest(executionWorkspace);
          const authorityRecords = validationManifest(workspace);
          if (inputRecords.size !== authorityRecords.size || [...inputRecords].some(([relative, entry]) =>
            !sameValidationEntry(authorityRecords.get(relative), entry) ||
            (!retiredInputPaths.has(relative) && !sameValidationEntry(currentRecords.get(relative), entry))) ||
            generatedEntries.some(({ path: relative, entry }) =>
              !sameValidationEntry(currentRecords.get(relative), entry))) {
            issues.push({ code: "validation_candidate_input_changed",
              message: "A validation command changed bound candidate input or generated output.",
              severity: "failure", commandId: command.id });
            commandPassed = false;
          } else if (commandPassed) {
            const newEntries: GeneratedEntry[] = [];
            const priorGeneratedPaths = new Set(generatedEntries.map((item) => item.path));
            let generatedBytes = generatedEntries.reduce((sum, item) => sum + item.entry.byteLength, 0);
            for (const [relative, entry] of currentRecords) {
              if ((inputRecords.has(relative) && !retiredInputPaths.has(relative)) ||
                  priorGeneratedPaths.has(relative)) continue;
              if (!authorizedGeneratedPath(relative, entry.kind, command.generatedOutputRoots ?? [])) {
                issues.push({ code: "validation_generated_output_unauthorized",
                  message: "Validation command created output outside its declared generated roots.",
                  severity: "failure", commandId: command.id });
                commandPassed = false;
                break;
              }
              if (entry.kind === "symlink") throw new Error("Generated validation symlink is forbidden.");
              generatedBytes += entry.byteLength;
              if (generatedEntries.length + newEntries.length >= VALIDATION_INTEGRITY_LIMITS.maximumGeneratedEntries ||
                  generatedBytes > VALIDATION_INTEGRITY_LIMITS.maximumGeneratedBytes) {
                throw new Error("Generated validation output exceeds limits.");
              }
              newEntries.push({ path: relative, entry, producerCommandId: command.id });
            }
            if (commandPassed) generatedEntries = [...generatedEntries, ...newEntries];
          }
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
        try { await options.onLifecycleCheckpoint?.({ phase: "container_cleanup_completed",
          commandId: command.id, identity, containerId: cleanup.containerId,
          cleanupDecision: cleanup.decision }); } catch {
          issues.push({ code: "validation_container_lifecycle_checkpoint_failed",
            message: "Container lifecycle cleanup could not be durably checkpointed.",
            severity: "failure", commandId: command.id });
          commandPassed = false;
        }
        if (!new Set(["validation_container_removed", "validation_container_absent"])
          .has(cleanup.decision)) {
          issues.push({ code: "validation_container_cleanup_recovery_required",
            message: "Container cleanup could not prove removal; infrastructure recovery is required.",
            severity: "failure", commandId: command.id });
          commandPassed = false;
        }
      }
      if (commandResult !== null) {
        commandResult.passed = commandPassed && !issues.some((entry) =>
          entry.commandId === command.id && entry.severity === "failure");
      }
      if (!commandPassed || issues.some((entry) =>
        entry.commandId === command.id && entry.severity === "failure")) {
        return result(issues, results, Date.now() - started);
      }
    }
    return result(issues, results, Date.now() - started);
  } finally {
    if (executionWorkspace !== null) fs.rmSync(executionWorkspace, { recursive: true, force: true });
  }
}
