#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "dist/apps/cli/src/index.js");

function runCli(cwd, args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
      OPENAI_BASE_URL: "http://127.0.0.1:9",
      ...environment
    }
  });
}

function gitInit(cwd) {
  const result = spawnSync("git", ["init", "-q"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function createRepository(root, name, scripts = {}) {
  const repository = path.join(root, name);
  await fs.mkdir(repository, { recursive: true });
  gitInit(repository);
  await fs.writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({
      name,
      scripts: {
        test: "node --test",
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        ...scripts
      },
      devDependencies: { typescript: "^5.6.3" }
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(repository, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`,
    "utf8"
  );
  return repository;
}

async function init(repository) {
  const result = runCli(repository, ["init", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-doctor-smoke-"));
  try {
    const repository = await createRepository(root, "doctor-success");
    await init(repository);

    const authenticated = runCli(repository, ["doctor", "--json"], {
      CODEX_API_KEY: "bounded-doctor-smoke-key"
    });
    assert.equal(authenticated.status, 0, authenticated.stderr || authenticated.stdout);
    const report = JSON.parse(authenticated.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.command, "doctor");
    assert.equal(report.minimumNodeVersion, "22.14.0");
    assert.equal(report.codexAuthenticationSource, "environment");
    assert.deepEqual(
      report.checks.map((item) => item.id),
      [
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
      ]
    );
    assert.equal(report.checks.every((item) => item.ok === true), true);

    const human = runCli(repository, ["doctor"], {
      CODEX_API_KEY: "bounded-doctor-smoke-key"
    });
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /^Environment\n/m);
    assert.match(human.stdout, /✓ Node\n/);
    assert.match(human.stdout, /✓ Git\n/);
    assert.match(human.stdout, /Repository\n/);
    assert.match(human.stdout, /✓ JavaScript\/TypeScript\n/);
    assert.match(human.stdout, /✓ policy\n/);
    assert.match(human.stdout, /Codex\n/);
    assert.match(human.stdout, /✓ adapter\n/);
    assert.match(human.stdout, /✓ authentication\n/);
    assert.match(human.stdout, /Validation\n/);
    assert.match(human.stdout, /✓ test\n/);
    assert.match(human.stdout, /✓ typecheck\n/);

    const emptyCodexHome = path.join(root, "empty-codex-home");
    await fs.mkdir(emptyCodexHome);
    const unauthenticated = runCli(repository, ["doctor", "--json"], {
      CODEX_HOME: emptyCodexHome
    });
    assert.equal(unauthenticated.status, 2, unauthenticated.stderr || unauthenticated.stdout);
    const unauthenticatedReport = JSON.parse(unauthenticated.stdout);
    assert.equal(unauthenticatedReport.ok, false);
    assert.equal(unauthenticatedReport.code, "cli_doctor_checks_failed");
    assert.equal(unauthenticatedReport.codexAuthenticationSource, "unavailable");
    assert.equal(
      unauthenticatedReport.checks.find((item) => item.id === "codex_authentication").ok,
      false
    );
    assert.equal(
      unauthenticatedReport.checks.filter((item) => item.id !== "codex_authentication")
        .every((item) => item.ok === true),
      true
    );

    const authFileHome = path.join(root, "auth-file-codex-home");
    await fs.mkdir(authFileHome);
    await fs.writeFile(
      path.join(authFileHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-access-token" } })}\n`,
      "utf8"
    );
    const authFile = runCli(repository, ["doctor", "--json"], { CODEX_HOME: authFileHome });
    assert.equal(authFile.status, 0, authFile.stderr || authFile.stdout);
    assert.equal(JSON.parse(authFile.stdout).codexAuthenticationSource, "auth_file");
    assert.equal(authFile.stdout.includes("fixture-access-token"), false);

    const noTypecheck = await createRepository(root, "doctor-no-typecheck", { typecheck: undefined });
    const packageFile = path.join(noTypecheck, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));
    delete packageJson.scripts.typecheck;
    await fs.writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await init(noTypecheck);
    const validationFailure = runCli(noTypecheck, ["doctor", "--json"], {
      CODEX_API_KEY: "bounded-doctor-smoke-key"
    });
    assert.equal(validationFailure.status, 2, validationFailure.stderr || validationFailure.stdout);
    const validationReport = JSON.parse(validationFailure.stdout);
    assert.equal(validationReport.checks.find((item) => item.id === "validation_test").ok, true);
    assert.equal(validationReport.checks.find((item) => item.id === "validation_typecheck").ok, false);

    const brokenPolicy = await createRepository(root, "doctor-broken-policy");
    await init(brokenPolicy);
    await fs.writeFile(path.join(brokenPolicy, ".bounded", "policy.yml"), "not: [valid\n", "utf8");
    const policyFailure = runCli(brokenPolicy, ["doctor", "--json"], {
      CODEX_API_KEY: "bounded-doctor-smoke-key"
    });
    assert.equal(policyFailure.status, 2, policyFailure.stderr || policyFailure.stdout);
    const policyReport = JSON.parse(policyFailure.stdout);
    assert.equal(policyReport.checks.find((item) => item.id === "config").ok, true);
    assert.equal(policyReport.checks.find((item) => item.id === "policy").ok, false);

    const doctorSource = await fs.readFile(
      path.join(repoRoot, "apps", "cli", "src", "commands", "doctor.ts"),
      "utf8"
    );
    assert.equal(/\.run\s*\(/.test(doctorSource), false, "doctor must not call AgentAdapter.run()");
    assert.equal(/runStreamed\s*\(/.test(doctorSource), false, "doctor must not call Codex model streams");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      nodeSupported: true,
      gitAvailable: true,
      repositoryReadable: true,
      repositoryTypeDetected: true,
      configValidated: true,
      policyCompiled: true,
      validationCommandsChecked: true,
      codexAdapterLoadable: true,
      codexAuthenticationChecked: true,
      tempDirectoryWritable: true,
      humanSectionsRendered: true,
      modelCalls: 0
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
