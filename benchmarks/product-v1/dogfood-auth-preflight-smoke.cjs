#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const preflight = require("./dogfood-auth-preflight.cjs");

const MODEL = "gpt-5.6-codex";
const repoRoot = path.resolve(__dirname, "../..");
const workflowPath = path.join(repoRoot, ".github/workflows/product-dogfood-v1-live.yml");
const preflightPath = path.join(__dirname, "dogfood-auth-preflight.cjs");

function expectFailure(input) {
  assert.throws(
    () => preflight.validateInputs(input),
    (error) => error instanceof Error && error.code === "dogfood_live_auth_preflight_failed"
  );
}

function main() {
  assert.deepEqual([...preflight.AUTH_MODES], ["api_key", "codex_home"]);

  const workflow = fs.readFileSync(workflowPath, "utf8");
  const authStart = workflow.indexOf("      auth_mode:");
  const modelStart = workflow.indexOf("      model:", authStart);
  assert.notEqual(authStart, -1);
  assert.notEqual(modelStart, -1);
  const authBlock = workflow.slice(authStart, modelStart);
  assert.match(authBlock, /type:\s*choice/);
  assert.match(authBlock, /\n\s*- api_key\n/);
  assert.match(authBlock, /\n\s*- codex_home\n/);
  assert.equal((authBlock.match(/^\s*- /gm) || []).length, 2);
  assert.match(workflow, /api-key-live:[\s\S]*?runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /codex-home-live:[\s\S]*?runs-on:\s*self-hosted/);

  expectFailure({
    mode: "api_key",
    model: MODEL,
    runnerEnvironment: "github-hosted",
    env: {}
  });

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-auth-empty-"));
  try {
    expectFailure({
      mode: "codex_home",
      model: MODEL,
      runnerEnvironment: "self-hosted",
      env: { CODEX_HOME: emptyHome, PATH: "" }
    });
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-auth-state-"));
  try {
    fs.writeFileSync(path.join(fakeHome, "auth.json"), "{}\n", { mode: 0o600 });
    const codexHomePass = preflight.validateInputs({
      mode: "codex_home",
      model: MODEL,
      runnerEnvironment: "self-hosted",
      env: { CODEX_HOME: fakeHome, PATH: "" }
    });
    assert.equal(codexHomePass.ok, true);
    assert.equal(codexHomePass.authMode, "codex_home");

    expectFailure({
      mode: "codex_home",
      model: MODEL,
      runnerEnvironment: "github-hosted",
      env: { CODEX_HOME: fakeHome, PATH: "" }
    });
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }

  const defaultHome = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-default-home-"));
  try {
    const defaultCodexHome = path.join(defaultHome, ".codex");
    fs.mkdirSync(defaultCodexHome, { recursive: true });
    fs.writeFileSync(path.join(defaultCodexHome, "auth.json"), "{}\n", { mode: 0o600 });
    const githubEnv = path.join(defaultHome, "github-env.txt");
    fs.writeFileSync(githubEnv, "", { mode: 0o600 });

    const child = spawnSync(process.execPath, [
      preflightPath,
      "--mode=codex_home",
      `--model=${MODEL}`,
      "--runner-environment=self-hosted"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: defaultHome,
        CODEX_HOME: "",
        GITHUB_ENV: githubEnv,
        PATH: ""
      },
      timeout: 10_000
    });

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.includes(defaultHome), false);
    assert.equal(
      fs.readFileSync(githubEnv, "utf8"),
      `CODEX_HOME=${defaultCodexHome}\n`
    );
  } finally {
    fs.rmSync(defaultHome, { recursive: true, force: true });
  }

  for (const mode of ["", "key", "chatgpt", "auto", "api-key"]) {
    expectFailure({ mode, model: MODEL, runnerEnvironment: "self-hosted", env: {} });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    supportedAuthModes: [...preflight.AUTH_MODES],
    workflowAuthModeChoicesExact: true,
    apiKeyWithoutKeyFails: true,
    codexHomeWithoutAuthFails: true,
    codexHomeFakeAuthPasses: true,
    codexHomeDefaultDirectoryPasses: true,
    codexHomePropagatesWithoutLoggingPath: true,
    codexHomeRequiresSelfHosted: true,
    externalProviderCalls: false
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
