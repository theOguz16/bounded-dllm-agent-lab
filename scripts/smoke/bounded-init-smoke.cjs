#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "dist/apps/cli/src/index.js");
const runtimeUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
).href;

function runCli(cwd, args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      CODEX_API_KEY: "bounded-doctor-smoke-key",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "http://127.0.0.1:9",
      ...environment
    }
  });
}

function gitInit(cwd) {
  const result = spawnSync("git", ["init", "-q"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepository(root, options) {
  const repository = path.join(root, options.name);
  await fs.mkdir(repository, { recursive: true });
  gitInit(repository);
  await writeJson(path.join(repository, "package.json"), {
    name: options.name,
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    scripts: {
      test: "node --test",
      "test:unit": "node --test test/unit.test.js",
      build: "tsc -p tsconfig.json",
      ...(options.includeTypecheck === false ? {} : { typecheck: "tsc -p tsconfig.json --noEmit" })
    },
    devDependencies: { typescript: "^5.6.3" }
  });
  if (options.lockfile) await fs.writeFile(path.join(repository, options.lockfile), "fixture\n", "utf8");
  await writeJson(path.join(repository, "tsconfig.json"), { compilerOptions: { strict: true } });
  return repository;
}

function expectedDoctorCheckIds() {
  return [
    "node",
    "git",
    "temp_directory",
    "repository_readable",
    "config",
    "repository_type",
    "policy",
    "codex_adapter",
    "codex_authentication",
    "validation_test",
    "validation_typecheck"
  ];
}

async function assertInitialized(repository, expectedManager) {
  const nested = path.join(repository, "src", "nested");
  await fs.mkdir(nested, { recursive: true });
  const init = runCli(nested, ["init", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const initJson = JSON.parse(init.stdout);
  assert.equal(initJson.ok, true);
  assert.equal(initJson.command, "init");
  assert.equal(initJson.configVersion, "bounded-local-config/v1");
  assert.equal(initJson.packageManager, expectedManager);
  assert.equal(initJson.typescript, true);

  const configFile = path.join(repository, ".bounded", "config.json");
  const policyFile = path.join(repository, ".bounded", "policy.yml");
  const gitignoreFile = path.join(repository, ".bounded", ".gitignore");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));

  assert.equal(config.schemaVersion, "bounded-local-config/v1");
  assert.deepEqual(config.repository, { git: true, root: "." });
  assert.equal(config.packageJson.detected, true);
  assert.equal(config.packageJson.path, "package.json");
  assert.equal(config.packageManager.name, expectedManager);
  assert.equal(config.typescript.detected, true);
  assert.deepEqual(config.typescript.configFiles, ["tsconfig.json"]);
  assert.deepEqual(config.scripts.test, ["test", "test:unit"]);
  assert.deepEqual(config.scripts.build, ["build"]);
  assert.deepEqual(config.scripts.typecheck, ["typecheck"]);
  assert.equal(config.policyFile, ".bounded/policy.yml");
  assert.equal(
    await fs.readFile(gitignoreFile, "utf8"),
    "runs/\nstate/\ntmp/\ncache/\n"
  );

  const runtime = await import(runtimeUrl);
  const compiled = runtime.compileCanonicalPolicy({
    repositoryPath: repository,
    policyFilePath: policyFile
  });
  assert.equal(typeof compiled.compiledPolicyHash, "string");

  const doctor = runCli(repository, ["doctor", "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const doctorJson = JSON.parse(doctor.stdout);
  assert.equal(doctorJson.ok, true);
  assert.equal(doctorJson.command, "doctor");
  assert.equal(doctorJson.configVersion, "bounded-local-config/v1");
  assert.equal(doctorJson.minimumNodeVersion, "22.14.0");
  assert.equal(doctorJson.packageManager, expectedManager);
  assert.equal(doctorJson.codexAuthenticationSource, "environment");
  assert.deepEqual(doctorJson.checks.map((item) => item.id), expectedDoctorCheckIds());
  assert.equal(doctorJson.checks.every((item) => item.ok === true), true);

  const humanDoctor = runCli(repository, ["doctor"]);
  assert.equal(humanDoctor.status, 0, humanDoctor.stderr || humanDoctor.stdout);
  assert.match(humanDoctor.stdout, /^Environment\n/m);
  assert.match(humanDoctor.stdout, /✓ Node\n/);
  assert.match(humanDoctor.stdout, /✓ Git\n/);
  assert.match(humanDoctor.stdout, /Repository\n/);
  assert.match(humanDoctor.stdout, /✓ JavaScript\/TypeScript\n/);
  assert.match(humanDoctor.stdout, /✓ policy\n/);
  assert.match(humanDoctor.stdout, /Codex\n/);
  assert.match(humanDoctor.stdout, /✓ adapter\n/);
  assert.match(humanDoctor.stdout, /✓ authentication\n/);
  assert.match(humanDoctor.stdout, /Validation\n/);
  assert.match(humanDoctor.stdout, /✓ test\n/);
  assert.match(humanDoctor.stdout, /✓ typecheck\n/);

  const before = {
    config: await fs.readFile(configFile, "utf8"),
    policy: await fs.readFile(policyFile, "utf8"),
    gitignore: await fs.readFile(gitignoreFile, "utf8")
  };
  const secondInit = runCli(repository, ["init", "--json"]);
  assert.equal(secondInit.status, 2, secondInit.stderr || secondInit.stdout);
  assert.equal(JSON.parse(secondInit.stdout).code, "cli_init_already_initialized");
  assert.equal(await fs.readFile(configFile, "utf8"), before.config);
  assert.equal(await fs.readFile(policyFile, "utf8"), before.policy);
  assert.equal(await fs.readFile(gitignoreFile, "utf8"), before.gitignore);

  return config;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-init-smoke-"));
  try {
    const pnpmRepository = await createRepository(root, {
      name: "fixture-pnpm",
      packageManager: "pnpm@10.0.0",
      lockfile: "pnpm-lock.yaml"
    });
    const pnpmConfig = await assertInitialized(pnpmRepository, "pnpm");
    assert.equal(pnpmConfig.packageManager.source, "packageManager");
    assert.equal(pnpmConfig.packageManager.lockfile, "pnpm-lock.yaml");

    const npmRepository = await createRepository(root, {
      name: "fixture-npm",
      lockfile: "package-lock.json"
    });
    const npmConfig = await assertInitialized(npmRepository, "npm");
    assert.equal(npmConfig.packageManager.source, "lockfile");

    const yarnRepository = await createRepository(root, {
      name: "fixture-yarn",
      lockfile: "yarn.lock"
    });
    const yarnConfig = await assertInitialized(yarnRepository, "yarn");
    assert.equal(yarnConfig.packageManager.source, "lockfile");

    const partial = path.join(root, "fixture-existing-policy");
    await fs.mkdir(path.join(partial, ".bounded"), { recursive: true });
    gitInit(partial);
    await fs.writeFile(path.join(partial, ".bounded", "policy.yml"), "KEEP\n", "utf8");
    const blocked = runCli(partial, ["init", "--json"]);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).code, "cli_init_target_exists");
    assert.equal(await fs.readFile(path.join(partial, ".bounded", "policy.yml"), "utf8"), "KEEP\n");
    await assert.rejects(fs.access(path.join(partial, ".bounded", "config.json")));

    const noGit = path.join(root, "not-a-repository");
    await fs.mkdir(noGit);
    const noGitInit = runCli(noGit, ["init", "--json"]);
    assert.equal(noGitInit.status, 2, noGitInit.stderr || noGitInit.stdout);
    assert.equal(JSON.parse(noGitInit.stdout).code, "cli_init_git_repository_required");

    const emptyCodexHome = path.join(root, "empty-codex-home");
    await fs.mkdir(emptyCodexHome);
    const unauthenticated = runCli(npmRepository, ["doctor", "--json"], {
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_HOME: emptyCodexHome
    });
    assert.equal(unauthenticated.status, 2, unauthenticated.stderr || unauthenticated.stdout);
    const unauthenticatedJson = JSON.parse(unauthenticated.stdout);
    assert.equal(unauthenticatedJson.code, "cli_doctor_checks_failed");
    assert.equal(unauthenticatedJson.codexAuthenticationSource, "unavailable");
    assert.equal(unauthenticatedJson.checks.find((item) => item.id === "codex_authentication").ok, false);
    assert.equal(
      unauthenticatedJson.checks.filter((item) => item.id !== "codex_authentication")
        .every((item) => item.ok === true),
      true
    );

    const authFileHome = path.join(root, "auth-file-codex-home");
    await fs.mkdir(authFileHome);
    await writeJson(path.join(authFileHome, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: { access_token: "fixture-access-token" }
    });
    const authFileDoctor = runCli(npmRepository, ["doctor", "--json"], {
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_HOME: authFileHome
    });
    assert.equal(authFileDoctor.status, 0, authFileDoctor.stderr || authFileDoctor.stdout);
    assert.equal(JSON.parse(authFileDoctor.stdout).codexAuthenticationSource, "auth_file");
    assert.equal(authFileDoctor.stdout.includes("fixture-access-token"), false);

    const noTypecheckRepository = await createRepository(root, {
      name: "fixture-no-typecheck",
      lockfile: "package-lock.json",
      includeTypecheck: false
    });
    const noTypecheckInit = runCli(noTypecheckRepository, ["init", "--json"]);
    assert.equal(noTypecheckInit.status, 0, noTypecheckInit.stderr || noTypecheckInit.stdout);
    const validationDoctor = runCli(noTypecheckRepository, ["doctor", "--json"]);
    assert.equal(validationDoctor.status, 2, validationDoctor.stderr || validationDoctor.stdout);
    const validationJson = JSON.parse(validationDoctor.stdout);
    assert.equal(validationJson.checks.find((item) => item.id === "validation_test").ok, true);
    assert.equal(validationJson.checks.find((item) => item.id === "validation_typecheck").ok, false);

    const brokenPolicyRepository = await createRepository(root, {
      name: "fixture-broken-policy",
      lockfile: "package-lock.json"
    });
    const brokenPolicyInit = runCli(brokenPolicyRepository, ["init", "--json"]);
    assert.equal(brokenPolicyInit.status, 0, brokenPolicyInit.stderr || brokenPolicyInit.stdout);
    await fs.writeFile(
      path.join(brokenPolicyRepository, ".bounded", "policy.yml"),
      "not: [valid\n",
      "utf8"
    );
    const policyDoctor = runCli(brokenPolicyRepository, ["doctor", "--json"]);
    assert.equal(policyDoctor.status, 2, policyDoctor.stderr || policyDoctor.stdout);
    const policyJson = JSON.parse(policyDoctor.stdout);
    assert.equal(policyJson.checks.find((item) => item.id === "config").ok, true);
    assert.equal(policyJson.checks.find((item) => item.id === "policy").ok, false);

    const driftPackage = JSON.parse(await fs.readFile(path.join(pnpmRepository, "package.json"), "utf8"));
    driftPackage.scripts["test:integration"] = "node --test test/integration.test.js";
    await writeJson(path.join(pnpmRepository, "package.json"), driftPackage);
    const driftDoctor = runCli(pnpmRepository, ["doctor", "--json"]);
    assert.equal(driftDoctor.status, 2, driftDoctor.stderr || driftDoctor.stdout);
    assert.equal(JSON.parse(driftDoctor.stdout).code, "cli_doctor_config_drift");

    const doctorSource = await fs.readFile(
      path.join(repoRoot, "apps", "cli", "src", "commands", "doctor.ts"),
      "utf8"
    );
    assert.equal(/\.run\s*\(/.test(doctorSource), false, "doctor must not call AgentAdapter.run()");
    assert.equal(/runStreamed\s*\(/.test(doctorSource), false, "doctor must not call Codex model streams");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      configVersion: "bounded-local-config/v1",
      gitRepositoryDetected: true,
      packageJsonDetected: true,
      packageManagersDetected: ["npm", "pnpm", "yarn"],
      typescriptDetected: true,
      testBuildTypecheckScriptsDetected: true,
      initCreatesLocalFiles: true,
      doctorAfterInit: true,
      silentOverwritePrevented: true,
      generatedPolicyCompiles: true,
      repositoryDriftDetected: true,
      doctorEnvironmentChecks: true,
      doctorRepositoryChecks: true,
      doctorCodexChecks: true,
      doctorValidationChecks: true,
      doctorHumanSections: true,
      doctorAuthFileSupport: true,
      doctorMissingAuthFailsClosed: true,
      doctorModelCalls: 0
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
