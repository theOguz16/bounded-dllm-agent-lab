#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const preflight = require("./dogfood-auth-preflight.cjs");

const MODEL = "gpt-5.6-codex";

function expectFailure(input) {
  assert.throws(
    () => preflight.validateInputs(input),
    (error) => error instanceof Error && error.code === "dogfood_live_auth_preflight_failed"
  );
}

function main() {
  assert.deepEqual([...preflight.AUTH_MODES], ["api_key", "codex_home"]);

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

  for (const mode of ["", "key", "chatgpt", "auto", "api-key"]) {
    expectFailure({ mode, model: MODEL, runnerEnvironment: "self-hosted", env: {} });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    supportedAuthModes: [...preflight.AUTH_MODES],
    apiKeyWithoutKeyFails: true,
    codexHomeWithoutAuthFails: true,
    codexHomeFakeAuthPasses: true,
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
