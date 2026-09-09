import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliError } from "./cli-errors.js";

export const BOUNDED_LOCAL_CONFIG_VERSION = "bounded-local-config/v1" as const;
export const BOUNDED_DIRECTORY = ".bounded" as const;
export const BOUNDED_CONFIG_PATH = ".bounded/config.json" as const;
export const BOUNDED_POLICY_PATH = ".bounded/policy.yml" as const;
export const BOUNDED_GITIGNORE_PATH = ".bounded/.gitignore" as const;

export const BOUNDED_GITIGNORE_CONTENT = "runs/\nstate/\ntmp/\ncache/\n";

export const BOUNDED_DEFAULT_POLICY_CONTENT = [
  'schemaVersion: "1"',
  "allowed_paths:",
  '  - "**"',
  "forbidden_paths:",
  "  - .git/**",
  "  - .bounded/**",
  "  - node_modules/**",
  "  - dist/**",
  "  - build/**",
  "  - coverage/**",
  "paired_files: []",
  "sensitive_patterns:",
  "  - SECRET",
  "  - API_KEY",
  "  - TOKEN",
  "  - PASSWORD",
  "sensitive_paths:",
  "  - pattern: .env",
  "    disposition: deny",
  '  - pattern: "**/.env"',
  "    disposition: deny",
  '  - pattern: "**/*secret*"',
  "    disposition: deny",
  "ownership_rules: []",
  ""
].join("\n");

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;
const PACKAGE_MANAGER_LOCKFILES = Object.freeze([
  { name: "pnpm", file: "pnpm-lock.yaml" },
  { name: "yarn", file: "yarn.lock" },
  { name: "npm", file: "package-lock.json" },
  { name: "npm", file: "npm-shrinkwrap.json" }
] as const);

export type ProductPackageManager = "npm" | "pnpm" | "yarn" | null;
export type ProductPackageManagerSource =
  | "packageManager"
  | "lockfile"
  | "ambiguous"
  | "none";

export type BoundedLocalConfig = Readonly<{
  schemaVersion: typeof BOUNDED_LOCAL_CONFIG_VERSION;
  repository: Readonly<{
    git: true;
    root: ".";
  }>;
  packageJson: Readonly<{
    detected: boolean;
    path: "package.json" | null;
    name: string | null;
  }>;
  packageManager: Readonly<{
    name: ProductPackageManager;
    source: ProductPackageManagerSource;
    lockfile: string | null;
    detectedLockfiles: readonly string[];
  }>;
  typescript: Readonly<{
    detected: boolean;
    dependency: boolean;
    configFiles: readonly string[];
  }>;
  scripts: Readonly<{
    test: readonly string[];
    build: readonly string[];
    typecheck: readonly string[];
  }>;
  policyFile: typeof BOUNDED_POLICY_PATH;
}>;

export type BoundedInitResult = Readonly<{
  repositoryRoot: string;
  config: BoundedLocalConfig;
}>;

export type BoundedDoctorResult = Readonly<{
  repositoryRoot: string;
  config: BoundedLocalConfig;
  checks: readonly string[];
}>;

type PackageJsonData = Readonly<{
  detected: boolean;
  name: string | null;
  declaredPackageManager: ProductPackageManager;
  scripts: Readonly<Record<string, string>>;
  typescriptDependency: boolean;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function parseDeclaredPackageManager(value: unknown): ProductPackageManager {
  if (typeof value !== "string") return null;
  const match = /^(npm|pnpm|yarn)(?:@|$)/.exec(value.trim());
  return match ? (match[1] as Exclude<ProductPackageManager, null>) : null;
}

function safePackageName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

async function readPackageJson(repositoryRoot: string): Promise<PackageJsonData> {
  const file = path.join(repositoryRoot, "package.json");
  if (!(await exists(file))) {
    return {
      detected: false,
      name: null,
      declaredPackageManager: null,
      scripts: {},
      typescriptDependency: false
    };
  }

  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new CliError("cli_init_package_json_unreadable", "package.json could not be read.");
  }
  if (data.length > MAX_PACKAGE_JSON_BYTES) {
    throw new CliError("cli_init_package_json_too_large", "package.json is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    throw new CliError("cli_init_package_json_invalid", "package.json is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new CliError("cli_init_package_json_invalid", "package.json must contain a JSON object.");
  }

  const scripts: Record<string, string> = {};
  if (isPlainObject(parsed.scripts)) {
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === "string") scripts[name] = command;
    }
  }

  const dependencySets = [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies,
    parsed.optionalDependencies].filter(isPlainObject);
  const typescriptDependency = dependencySets.some((set) => typeof set.typescript === "string");

  return {
    detected: true,
    name: safePackageName(parsed.name),
    declaredPackageManager: parseDeclaredPackageManager(parsed.packageManager),
    scripts,
    typescriptDependency
  };
}

function isTestScript(name: string): boolean {
  return name === "test" || name.startsWith("test:");
}

function isBuildScript(name: string): boolean {
  return name === "build" || name.startsWith("build:");
}

function isTypecheckScript(name: string, command: string): boolean {
  if (
    name === "typecheck" ||
    name.startsWith("typecheck:") ||
    name === "type-check" ||
    name.startsWith("type-check:") ||
    name === "check:types" ||
    name === "check-types" ||
    name === "types:check"
  ) {
    return true;
  }
  return /(?:^|\s)tsc(?:\s|$)/.test(command) && /(?:^|\s)--noEmit(?:\s|$)/.test(command);
}

async function detectTypeScriptConfigs(repositoryRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(repositoryRoot);
  } catch {
    throw new CliError("cli_init_repository_unreadable", "Git repository root could not be read.");
  }
  return entries
    .filter((name) => /^tsconfig(?:\.[A-Za-z0-9._-]+)?\.json$/.test(name))
    .sort();
}

async function detectPackageManager(
  repositoryRoot: string,
  declared: ProductPackageManager
): Promise<BoundedLocalConfig["packageManager"]> {
  const detected = [] as Array<{ name: Exclude<ProductPackageManager, null>; file: string }>;
  for (const candidate of PACKAGE_MANAGER_LOCKFILES) {
    if (await exists(path.join(repositoryRoot, candidate.file))) {
      detected.push({ name: candidate.name, file: candidate.file });
    }
  }

  const detectedLockfiles = detected.map((item) => item.file).sort();
  if (declared !== null) {
    return {
      name: declared,
      source: "packageManager",
      lockfile: detected.find((item) => item.name === declared)?.file ?? null,
      detectedLockfiles
    };
  }

  const managers = [...new Set(detected.map((item) => item.name))];
  if (managers.length === 1) {
    const name = managers[0]!;
    return {
      name,
      source: "lockfile",
      lockfile: detected.find((item) => item.name === name)?.file ?? null,
      detectedLockfiles
    };
  }
  if (managers.length > 1) {
    return { name: null, source: "ambiguous", lockfile: null, detectedLockfiles };
  }
  return { name: null, source: "none", lockfile: null, detectedLockfiles };
}

export async function findGitRepositoryRoot(startPath = process.cwd()): Promise<string> {
  const cwd = await realpath(startPath).catch(() => {
    throw new CliError("cli_repository_unavailable", "Current path does not exist or is inaccessible.");
  });
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new CliError(
      "cli_init_git_repository_required",
      "bounded init/doctor must be run inside a Git repository."
    );
  }
  return realpath(result.stdout.trim()).catch(() => {
    throw new CliError("cli_init_git_repository_required", "Git repository root is inaccessible.");
  });
}

export async function detectBoundedLocalConfig(repositoryRoot: string): Promise<BoundedLocalConfig> {
  const packageJson = await readPackageJson(repositoryRoot);
  const packageManager = await detectPackageManager(repositoryRoot, packageJson.declaredPackageManager);
  const configFiles = await detectTypeScriptConfigs(repositoryRoot);
  const scriptEntries = Object.entries(packageJson.scripts);
  const test = scriptEntries.filter(([name]) => isTestScript(name)).map(([name]) => name).sort();
  const build = scriptEntries.filter(([name]) => isBuildScript(name)).map(([name]) => name).sort();
  const typecheck = scriptEntries
    .filter(([name, command]) => isTypecheckScript(name, command))
    .map(([name]) => name)
    .sort();

  return Object.freeze({
    schemaVersion: BOUNDED_LOCAL_CONFIG_VERSION,
    repository: Object.freeze({ git: true as const, root: "." as const }),
    packageJson: Object.freeze({
      detected: packageJson.detected,
      path: packageJson.detected ? "package.json" as const : null,
      name: packageJson.name
    }),
    packageManager: Object.freeze({ ...packageManager }),
    typescript: Object.freeze({
      detected: packageJson.typescriptDependency || configFiles.length > 0,
      dependency: packageJson.typescriptDependency,
      configFiles: Object.freeze(configFiles)
    }),
    scripts: Object.freeze({
      test: Object.freeze(test),
      build: Object.freeze(build),
      typecheck: Object.freeze(typecheck)
    }),
    policyFile: BOUNDED_POLICY_PATH
  });
}

function targetPaths(repositoryRoot: string): readonly string[] {
  return [BOUNDED_CONFIG_PATH, BOUNDED_POLICY_PATH, BOUNDED_GITIGNORE_PATH]
    .map((relative) => path.join(repositoryRoot, relative));
}

export async function initializeBoundedLocalConfig(startPath = process.cwd()): Promise<BoundedInitResult> {
  const repositoryRoot = await findGitRepositoryRoot(startPath);
  const [configFile, policyFile, gitignoreFile] = targetPaths(repositoryRoot);

  if (await exists(configFile)) {
    throw new CliError(
      "cli_init_already_initialized",
      `${BOUNDED_CONFIG_PATH} already exists; refusing to overwrite existing config.`
    );
  }
  if (await exists(policyFile) || await exists(gitignoreFile)) {
    throw new CliError(
      "cli_init_target_exists",
      "A bounded init target already exists; refusing to overwrite local configuration files."
    );
  }

  const config = await detectBoundedLocalConfig(repositoryRoot);
  const boundedDirectory = path.join(repositoryRoot, BOUNDED_DIRECTORY);
  const boundedDirectoryExisted = await exists(boundedDirectory);
  await mkdir(boundedDirectory, { recursive: true });

  const created: string[] = [];
  try {
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    created.push(configFile);
    await writeFile(policyFile, BOUNDED_DEFAULT_POLICY_CONTENT, { encoding: "utf8", flag: "wx" });
    created.push(policyFile);
    await writeFile(gitignoreFile, BOUNDED_GITIGNORE_CONTENT, { encoding: "utf8", flag: "wx" });
    created.push(gitignoreFile);
  } catch (error) {
    await Promise.all(created.map((file) => rm(file, { force: true })));
    if (!boundedDirectoryExisted) await rmdir(boundedDirectory).catch(() => {});
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new CliError(
        "cli_init_target_exists",
        "A bounded init target appeared during initialization; no existing file was overwritten."
      );
    }
    if (error instanceof CliError) throw error;
    throw new CliError("cli_init_write_failed", "Bounded local configuration could not be written.");
  }

  return Object.freeze({ repositoryRoot, config });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseLocalConfig(value: unknown): BoundedLocalConfig {
  if (!isPlainObject(value) || value.schemaVersion !== BOUNDED_LOCAL_CONFIG_VERSION) {
    throw new CliError(
      "cli_doctor_config_invalid",
      `Local config must use schemaVersion ${BOUNDED_LOCAL_CONFIG_VERSION}.`
    );
  }
  const repository = value.repository;
  const packageJson = value.packageJson;
  const packageManager = value.packageManager;
  const typescript = value.typescript;
  const scripts = value.scripts;
  if (
    !isPlainObject(repository) || repository.git !== true || repository.root !== "." ||
    !isPlainObject(packageJson) || typeof packageJson.detected !== "boolean" ||
    !(packageJson.path === "package.json" || packageJson.path === null) ||
    !(typeof packageJson.name === "string" || packageJson.name === null) ||
    !isPlainObject(packageManager) ||
    !(["npm", "pnpm", "yarn", null] as unknown[]).includes(packageManager.name) ||
    !(["packageManager", "lockfile", "ambiguous", "none"] as unknown[]).includes(packageManager.source) ||
    !(typeof packageManager.lockfile === "string" || packageManager.lockfile === null) ||
    !stringArray(packageManager.detectedLockfiles) ||
    !isPlainObject(typescript) || typeof typescript.detected !== "boolean" ||
    typeof typescript.dependency !== "boolean" || !stringArray(typescript.configFiles) ||
    !isPlainObject(scripts) || !stringArray(scripts.test) || !stringArray(scripts.build) ||
    !stringArray(scripts.typecheck) || value.policyFile !== BOUNDED_POLICY_PATH
  ) {
    throw new CliError("cli_doctor_config_invalid", "Local bounded config has an invalid shape.");
  }
  return value as unknown as BoundedLocalConfig;
}

async function readLocalConfig(repositoryRoot: string): Promise<BoundedLocalConfig> {
  const file = path.join(repositoryRoot, BOUNDED_CONFIG_PATH);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new CliError("cli_doctor_config_missing", `${BOUNDED_CONFIG_PATH} is missing. Run bounded init.`);
  }
  if (data.length > MAX_LOCAL_CONFIG_BYTES) {
    throw new CliError("cli_doctor_config_invalid", `${BOUNDED_CONFIG_PATH} is too large.`);
  }
  try {
    return parseLocalConfig(JSON.parse(data.toString("utf8")));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("cli_doctor_config_invalid", `${BOUNDED_CONFIG_PATH} is not valid JSON.`);
  }
}

function sameConfig(left: BoundedLocalConfig, right: BoundedLocalConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function doctorBoundedLocalConfig(startPath = process.cwd()): Promise<BoundedDoctorResult> {
  const repositoryRoot = await findGitRepositoryRoot(startPath);
  const config = await readLocalConfig(repositoryRoot);
  const detected = await detectBoundedLocalConfig(repositoryRoot);
  if (!sameConfig(config, detected)) {
    throw new CliError(
      "cli_doctor_config_drift",
      "Local bounded config no longer matches repository/package detection; review and reinitialize intentionally."
    );
  }

  if (!(await exists(path.join(repositoryRoot, BOUNDED_POLICY_PATH)))) {
    throw new CliError("cli_doctor_policy_missing", `${BOUNDED_POLICY_PATH} is missing.`);
  }
  const gitignoreFile = path.join(repositoryRoot, BOUNDED_GITIGNORE_PATH);
  let gitignore: string;
  try {
    gitignore = await readFile(gitignoreFile, "utf8");
  } catch {
    throw new CliError("cli_doctor_gitignore_missing", `${BOUNDED_GITIGNORE_PATH} is missing.`);
  }
  const requiredIgnores = BOUNDED_GITIGNORE_CONTENT.trim().split("\n");
  const actualIgnores = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  if (requiredIgnores.some((entry) => !actualIgnores.has(entry))) {
    throw new CliError(
      "cli_doctor_gitignore_invalid",
      `${BOUNDED_GITIGNORE_PATH} must ignore runs/, state/, tmp/, and cache/.`
    );
  }

  return Object.freeze({
    repositoryRoot,
    config,
    checks: Object.freeze([
      "git_repository",
      "local_config_schema",
      "repository_detection",
      "policy_file",
      "bounded_gitignore"
    ])
  });
}
