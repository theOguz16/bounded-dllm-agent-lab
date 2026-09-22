import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDisposableAgentWorkspace } from "../../../packages/integrations/src/disposable-agent-workspace.js";
import { CliError } from "./cli-errors.js";

export const COMPARE_VALIDATION_SUBSTRATE_VERSION =
  "compare-validation-substrate/v1" as const;
export const COMPARE_VALIDATION_IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" as const;
export const COMPARE_VALIDATION_TIMEOUT_MS = 120_000;

export type CompareValidationSpec = Readonly<{
  tests: string | null;
  build: string | null;
  typecheck: string | null;
}>;

export type CompareCandidateChange = Readonly<{
  path: string;
  content: string | null;
}>;

export type CompareValidationObservation = Readonly<{
  passed: boolean | null;
  durationMs: number;
}>;

export type CompareValidationResult = Readonly<{
  tests: CompareValidationObservation;
  build: CompareValidationObservation;
  typecheck: CompareValidationObservation;
  durationMs: number;
  infrastructureFailure: Readonly<{ code: string; message: string }> | null;
}>;

export type CompareValidationSubstrate = Readonly<{
  version: typeof COMPARE_VALIDATION_SUBSTRATE_VERSION;
  image: typeof COMPARE_VALIDATION_IMAGE;
  dependencyRoot: string;
  dependencySnapshotHash: string;
  prepared: boolean;
}>;

const SAFE_REPOSITORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\/\/)[^\u0000]+$/;
const CACHE_MARKER = "bounded-compare-dependencies.json";

function sha256(parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

function safeMountPath(value: string): boolean {
  return value.length > 0 && !value.includes(",") && !value.includes("\n") && !value.includes("\r");
}

function docker(args: readonly string[], timeoutMs: number) {
  return spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function requireDocker(): void {
  const info = docker(["info", "--format", "{{.ServerVersion}}"], 10_000);
  if (info.error || info.status !== 0) {
    throw new CliError(
      "cli_compare_validation_runtime_unavailable",
      "Comparison validation requires an available Docker runtime before any model call.",
      5
    );
  }
}

function imageAvailable(): boolean {
  const inspected = docker(["image", "inspect", COMPARE_VALIDATION_IMAGE], 10_000);
  return inspected.error === undefined && inspected.status === 0;
}

function pullValidationImage(): void {
  const pulled = docker(["pull", COMPARE_VALIDATION_IMAGE], 5 * 60_000);
  if (pulled.error || pulled.status !== 0) {
    throw new CliError(
      "cli_compare_validation_image_unavailable",
      "Pinned comparison validation image is unavailable and could not be prepared.",
      5
    );
  }
}

async function dependencyMaterial(repositoryRoot: string): Promise<{
  packageJson: Buffer;
  packageLock: Buffer;
  hash: string;
}> {
  let packageJson: Buffer;
  let packageLock: Buffer;
  try {
    packageJson = await readFile(path.join(repositoryRoot, "package.json"));
    packageLock = await readFile(path.join(repositoryRoot, "package-lock.json"));
  } catch {
    throw new CliError(
      "cli_compare_validation_lockfile_required",
      "Comparison validation currently requires package.json plus package-lock.json for deterministic npm dependencies.",
      5
    );
  }
  return {
    packageJson,
    packageLock,
    hash: sha256(["compare-validation-dependencies/v1\n", packageJson, "\n", packageLock])
  };
}

function cacheRootFor(hash: string): string {
  return path.join(
    os.homedir(),
    ".cache",
    "bounded-dllm-agent-lab",
    "compare-validation",
    hash.slice("sha256:".length)
  );
}

async function validPreparedCache(root: string, expectedHash: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(root, CACHE_MARKER), "utf8")) as Record<string, unknown>;
    const modules = await lstat(path.join(root, "node_modules"));
    return marker.schemaVersion === "compare-validation-dependencies/v1" &&
      marker.dependencySnapshotHash === expectedHash &&
      modules.isDirectory() && !modules.isSymbolicLink();
  } catch {
    return false;
  }
}

async function prepareDependencies(
  root: string,
  material: Awaited<ReturnType<typeof dependencyMaterial>>
): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "package.json"), material.packageJson, { mode: 0o600 });
  await writeFile(path.join(root, "package-lock.json"), material.packageLock, { mode: 0o600 });

  const realRoot = await realpath(root);
  if (!safeMountPath(realRoot)) {
    throw new CliError(
      "cli_compare_validation_cache_path_invalid",
      "Comparison dependency cache path cannot be represented as a safe Docker bind mount.",
      5
    );
  }
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const installed = docker([
    "run", "--rm", "--pull", "never",
    "--network", "bridge",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp/npm-home",
    "--env", "npm_config_audit=false",
    "--env", "npm_config_fund=false",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--mount", `type=bind,src=${realRoot},dst=/workspace`,
    "--workdir", "/workspace",
    COMPARE_VALIDATION_IMAGE,
    "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"
  ], 10 * 60_000);
  if (installed.error || installed.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new CliError(
      "cli_compare_validation_dependency_prepare_failed",
      "Deterministic validation dependencies could not be prepared before model execution.",
      5
    );
  }
  const modules = await lstat(path.join(root, "node_modules")).catch(() => null);
  if (!modules?.isDirectory() || modules.isSymbolicLink()) {
    await rm(root, { recursive: true, force: true });
    throw new CliError(
      "cli_compare_validation_dependency_prepare_failed",
      "Dependency preparation completed without a safe node_modules directory.",
      5
    );
  }
  await writeFile(
    path.join(root, CACHE_MARKER),
    `${JSON.stringify({
      schemaVersion: "compare-validation-dependencies/v1",
      dependencySnapshotHash: material.hash,
      image: COMPARE_VALIDATION_IMAGE
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

export async function prepareCompareValidationSubstrate(
  repositoryRoot: string,
  options: Readonly<{ allowPreparation?: boolean }> = {}
): Promise<CompareValidationSubstrate> {
  requireDocker();
  const allowPreparation = options.allowPreparation === true;
  let prepared = false;
  if (!imageAvailable()) {
    if (!allowPreparation) {
      throw new CliError(
        "cli_compare_validation_image_unavailable",
        "Pinned comparison validation image is not installed. Prepare it before running a comparison.",
        5
      );
    }
    pullValidationImage();
    prepared = true;
  }

  const material = await dependencyMaterial(repositoryRoot);
  const cacheRoot = cacheRootFor(material.hash);
  if (!(await validPreparedCache(cacheRoot, material.hash))) {
    if (!allowPreparation) {
      throw new CliError(
        "cli_compare_validation_dependencies_missing",
        "Hermetic comparison dependencies are not prepared. Run through the post-fix regression runner or opt in to dependency preparation.",
        5
      );
    }
    await prepareDependencies(cacheRoot, material);
    prepared = true;
  }
  const dependencyRoot = await realpath(path.join(cacheRoot, "node_modules"));
  return Object.freeze({
    version: COMPARE_VALIDATION_SUBSTRATE_VERSION,
    image: COMPARE_VALIDATION_IMAGE,
    dependencyRoot,
    dependencySnapshotHash: material.hash,
    prepared
  });
}

function canonicalChangePath(value: string): string {
  if (!SAFE_REPOSITORY_PATH.test(value) || value.startsWith("/") || value.endsWith("/")) {
    throw new CliError(
      "cli_compare_validation_change_path_invalid",
      `Validation candidate contains an unsafe repository path: ${value}.`,
      4
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new CliError(
      "cli_compare_validation_change_path_invalid",
      `Validation candidate contains an unsafe repository path: ${value}.`,
      4
    );
  }
  return segments.join("/");
}

async function applyChanges(root: string, changes: readonly CompareCandidateChange[]): Promise<void> {
  for (const change of changes) {
    const relative = canonicalChangePath(change.path);
    const target = path.join(root, ...relative.split("/"));
    const resolved = path.resolve(target);
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      throw new CliError(
        "cli_compare_validation_change_path_invalid",
        `Validation candidate escaped the disposable workspace: ${relative}.`,
        4
      );
    }
    if (change.content === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, change.content, "utf8");
  }
}

function observation(
  workspaceRoot: string,
  dependencyRoot: string,
  script: string | null
): CompareValidationObservation & { infrastructureFailure: { code: string; message: string } | null } {
  if (script === null) {
    return Object.freeze({ passed: null, durationMs: 0, infrastructureFailure: null });
  }
  const started = Date.now();
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const result = docker([
    "run", "--rm", "--pull", "never",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "1073741824",
    "--memory-swap", "1073741824",
    "--pids-limit", "128",
    "--cpus", "2",
    "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp",
    "--env", "TMPDIR=/tmp",
    "--env", "CI=1",
    "--env", "npm_config_offline=true",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--mount", `type=bind,src=${workspaceRoot},dst=/workspace`,
    "--mount", `type=bind,src=${dependencyRoot},dst=/workspace/node_modules,readonly`,
    "--workdir", "/workspace",
    COMPARE_VALIDATION_IMAGE,
    "npm", "run", script
  ], COMPARE_VALIDATION_TIMEOUT_MS);
  const durationMs = Math.max(0, Date.now() - started);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ETIMEDOUT") {
    return Object.freeze({
      passed: false,
      durationMs,
      infrastructureFailure: {
        code: "runtime_validation_timeout",
        message: `Validation script ${script} exceeded its explicit timeout.`
      }
    });
  }
  if (result.error || result.status === null) {
    return Object.freeze({
      passed: null,
      durationMs,
      infrastructureFailure: {
        code: "runtime_validation_launch_failed",
        message: `Validation script ${script} could not be executed in the hermetic substrate.`
      }
    });
  }
  return Object.freeze({ passed: result.status === 0, durationMs, infrastructureFailure: null });
}

export async function runCompareValidation(input: Readonly<{
  repositoryRoot: string;
  sourceSnapshotHash: string;
  substrate: CompareValidationSubstrate;
  spec: CompareValidationSpec;
  changes: readonly CompareCandidateChange[];
}>): Promise<CompareValidationResult> {
  const workspace = await createDisposableAgentWorkspace({
    repositoryPath: input.repositoryRoot,
    sourceSnapshotHash: input.sourceSnapshotHash,
    visibleFiles: [],
    changeAllowedFiles: [],
    forbiddenFiles: [],
    mode: "baseline"
  });
  try {
    await applyChanges(workspace.workspacePath, input.changes);
    const build = observation(workspace.workspacePath, input.substrate.dependencyRoot, input.spec.build);
    if (build.infrastructureFailure !== null) {
      return Object.freeze({
        tests: { passed: null, durationMs: 0 },
        build: { passed: build.passed, durationMs: build.durationMs },
        typecheck: { passed: null, durationMs: 0 },
        durationMs: build.durationMs,
        infrastructureFailure: build.infrastructureFailure
      });
    }
    const typecheck = observation(
      workspace.workspacePath,
      input.substrate.dependencyRoot,
      input.spec.typecheck
    );
    if (typecheck.infrastructureFailure !== null) {
      return Object.freeze({
        tests: { passed: null, durationMs: 0 },
        build: { passed: build.passed, durationMs: build.durationMs },
        typecheck: { passed: typecheck.passed, durationMs: typecheck.durationMs },
        durationMs: build.durationMs + typecheck.durationMs,
        infrastructureFailure: typecheck.infrastructureFailure
      });
    }
    const tests = observation(workspace.workspacePath, input.substrate.dependencyRoot, input.spec.tests);
    return Object.freeze({
      tests: { passed: tests.passed, durationMs: tests.durationMs },
      build: { passed: build.passed, durationMs: build.durationMs },
      typecheck: { passed: typecheck.passed, durationMs: typecheck.durationMs },
      durationMs: build.durationMs + typecheck.durationMs + tests.durationMs,
      infrastructureFailure: tests.infrastructureFailure
    });
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
  }
}
