import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileCanonicalPolicy } from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type { CliCommandResult } from "../bounded-task.js";
import {
  BOUNDED_LOCAL_CONFIG_VERSION,
  BOUNDED_POLICY_PATH,
  doctorBoundedLocalConfig,
  findGitRepositoryRoot,
  type BoundedDoctorResult
} from "../product-config.js";

export const DOCTOR_MIN_NODE_VERSION = "22.14.0" as const;

type DoctorSection = "Environment" | "Repository" | "Codex" | "Validation";

type DoctorCheck = Readonly<{
  id: string;
  section: DoctorSection;
  label: string;
  ok: boolean;
  detail?: string;
}>;

type CodexAuthentication = Readonly<{
  available: boolean;
  source: "environment" | "auth_file" | "unavailable";
}>;

function parseVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSupportedNode(version: string): boolean {
  const current = parseVersion(version);
  const minimum = parseVersion(DOCTOR_MIN_NODE_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

function hasNonEmptyEnvironmentValue(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function hasCredentialMaterial(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasCredentialMaterial(item, depth + 1));

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (
      typeof item === "string" &&
      item.trim().length > 0 &&
      /(apikey|accesstoken|refreshtoken|idtoken|credential)/.test(normalized)
    ) {
      return true;
    }
    if (hasCredentialMaterial(item, depth + 1)) return true;
  }
  return false;
}

async function detectCodexAuthentication(): Promise<CodexAuthentication> {
  if (hasNonEmptyEnvironmentValue("CODEX_API_KEY") || hasNonEmptyEnvironmentValue("OPENAI_API_KEY")) {
    return { available: true, source: "environment" };
  }

  const codexHome = process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), ".codex");
  const authFile = path.join(codexHome, "auth.json");
  try {
    const data = await readFile(authFile);
    if (data.length === 0 || data.length > 1024 * 1024) {
      return { available: false, source: "unavailable" };
    }
    const parsed = JSON.parse(data.toString("utf8")) as unknown;
    return hasCredentialMaterial(parsed)
      ? { available: true, source: "auth_file" }
      : { available: false, source: "unavailable" };
  } catch {
    return { available: false, source: "unavailable" };
  }
}

async function codexAdapterLoadable(): Promise<boolean> {
  try {
    const module = await import("../../../../packages/integrations/src/codex-agent-adapter.js");
    const adapter = new module.CodexAgentAdapter();
    return adapter.agentId === "codex" && typeof adapter.run === "function";
  } catch {
    return false;
  }
}

async function tempDirectoryWritable(): Promise<boolean> {
  let directory: string | null = null;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "bounded-doctor-"));
    const probe = path.join(directory, "write-probe");
    await writeFile(probe, "ok\n", { encoding: "utf8", flag: "wx" });
    await access(probe, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function check(
  id: string,
  section: DoctorSection,
  label: string,
  ok: boolean,
  detail?: string
): DoctorCheck {
  return Object.freeze({ id, section, label, ok, ...(detail ? { detail } : {}) });
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export async function doctorCommand(startPath = process.cwd()): Promise<CliCommandResult> {
  const checks: DoctorCheck[] = [];
  let primaryFailureCode: string | null = null;

  const nodeOk = isSupportedNode(process.versions.node);
  checks.push(check(
    "node",
    "Environment",
    "Node",
    nodeOk,
    nodeOk ? undefined : `Node >= ${DOCTOR_MIN_NODE_VERSION} is required.`
  ));

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const gitOk = !git.error && git.status === 0;
  checks.push(check("git", "Environment", "Git", gitOk, gitOk ? undefined : "Git is not available."));

  const tempOk = await tempDirectoryWritable();
  checks.push(check(
    "temp_directory",
    "Environment",
    "temp directory",
    tempOk,
    tempOk ? undefined : "The operating-system temp directory is not writable."
  ));

  let repositoryRoot: string | null = null;
  let diagnosed: BoundedDoctorResult | null = null;

  try {
    repositoryRoot = await findGitRepositoryRoot(startPath);
    await access(repositoryRoot, fsConstants.R_OK);
    checks.push(check("repository_readable", "Repository", "repository readable", true));
  } catch (error) {
    primaryFailureCode ??= errorCode(error);
    checks.push(check(
      "repository_readable",
      "Repository",
      "repository readable",
      false,
      safeErrorMessage(error, "Repository is not readable.")
    ));
  }

  if (repositoryRoot) {
    try {
      diagnosed = await doctorBoundedLocalConfig(repositoryRoot);
      checks.push(check("config", "Repository", "config", true));
    } catch (error) {
      primaryFailureCode ??= errorCode(error);
      checks.push(check(
        "config",
        "Repository",
        "config",
        false,
        safeErrorMessage(error, "Local bounded config is invalid.")
      ));
    }
  } else {
    checks.push(check("config", "Repository", "config", false, "Repository root is unavailable."));
  }

  const repoTypeOk = diagnosed !== null &&
    (diagnosed.config.packageJson.detected || diagnosed.config.typescript.detected);
  checks.push(check(
    "repository_type",
    "Repository",
    "JavaScript/TypeScript",
    repoTypeOk,
    repoTypeOk ? undefined : "Repository does not look like a JavaScript/TypeScript project."
  ));

  if (repositoryRoot) {
    try {
      compileCanonicalPolicy({
        repositoryPath: repositoryRoot,
        policyFilePath: path.join(repositoryRoot, BOUNDED_POLICY_PATH)
      });
      checks.push(check("policy", "Repository", "policy", true));
    } catch (error) {
      checks.push(check(
        "policy",
        "Repository",
        "policy",
        false,
        safeErrorMessage(error, "Bounded policy could not be compiled.")
      ));
    }
  } else {
    checks.push(check("policy", "Repository", "policy", false, "Repository root is unavailable."));
  }

  const adapterOk = await codexAdapterLoadable();
  checks.push(check(
    "codex_adapter",
    "Codex",
    "adapter",
    adapterOk,
    adapterOk ? undefined : "Codex adapter could not be loaded."
  ));

  const authentication = await detectCodexAuthentication();
  checks.push(check(
    "codex_authentication",
    "Codex",
    "authentication",
    authentication.available,
    authentication.available ? undefined : "Codex authentication/config is unavailable."
  ));

  const testOk = diagnosed !== null && diagnosed.config.scripts.test.length > 0;
  const typecheckOk = diagnosed !== null && diagnosed.config.scripts.typecheck.length > 0;
  checks.push(check(
    "validation_test",
    "Validation",
    "test",
    testOk,
    testOk ? undefined : "No test validation command was detected."
  ));
  checks.push(check(
    "validation_typecheck",
    "Validation",
    "typecheck",
    typecheckOk,
    typecheckOk ? undefined : "No typecheck validation command was detected."
  ));

  const ok = checks.every((item) => item.ok);
  const code = ok ? null : primaryFailureCode ?? "cli_doctor_checks_failed";
  return {
    exitCode: ok ? 0 : 2,
    output: {
      ok,
      command: "doctor",
      ...(code ? { code } : {}),
      configVersion: BOUNDED_LOCAL_CONFIG_VERSION,
      minimumNodeVersion: DOCTOR_MIN_NODE_VERSION,
      nodeVersion: process.versions.node,
      repositoryRoot,
      packageManager: diagnosed?.config.packageManager.name ?? null,
      typescript: diagnosed?.config.typescript.detected ?? false,
      scripts: diagnosed?.config.scripts ?? { test: [], build: [], typecheck: [] },
      codexAuthenticationSource: authentication.source,
      checks
    }
  };
}
