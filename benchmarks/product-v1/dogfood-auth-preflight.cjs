#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const AUTH_MODES = Object.freeze(["api_key", "codex_home"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function fail(message) {
  const error = new Error(message);
  error.code = "dogfood_live_auth_preflight_failed";
  throw error;
}

function resolveCodexHome(env = process.env) {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function hasFileAuthState(codexHome) {
  try {
    const stat = fs.statSync(path.join(codexHome, "auth.json"));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function hasCliAuthState(codexHome, env = process.env) {
  const result = spawnSync("codex", ["login", "status"], {
    env: { ...env, CODEX_HOME: codexHome },
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true
  });
  return result.error === undefined && result.status === 0;
}

function hasCodexAuthState(env = process.env) {
  const codexHome = resolveCodexHome(env);
  if (hasFileAuthState(codexHome)) return true;
  return hasCliAuthState(codexHome, env);
}

function validateInputs({ mode, model, runnerEnvironment, env = process.env }) {
  if (!AUTH_MODES.includes(mode)) {
    fail("auth_mode must be one of: api_key, codex_home");
  }
  if (typeof model !== "string" || !MODEL.test(model.trim())) {
    fail("an exact model id is required");
  }

  if (mode === "api_key") {
    const hasApiKey = Boolean(env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
    if (!hasApiKey) fail("api_key mode requires CODEX_API_KEY or OPENAI_API_KEY");
    return Object.freeze({ ok: true, authMode: mode, modelConfigured: true, authAvailable: true });
  }

  if (runnerEnvironment !== "self-hosted") {
    fail("codex_home mode requires a self-hosted GitHub Actions runner");
  }
  if (!hasCodexAuthState(env)) {
    fail("codex_home mode requires an existing Codex login state in CODEX_HOME or the default Codex home");
  }

  return Object.freeze({ ok: true, authMode: mode, modelConfigured: true, authAvailable: true });
}

function parseArgs(argv) {
  const values = { mode: null, model: null, runnerEnvironment: null };
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) values.mode = arg.slice("--mode=".length).trim();
    else if (arg.startsWith("--model=")) values.model = arg.slice("--model=".length).trim();
    else if (arg.startsWith("--runner-environment=")) values.runnerEnvironment = arg.slice("--runner-environment=".length).trim();
    else fail(`unknown argument: ${arg}`);
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateInputs({
    mode: args.mode,
    model: args.model,
    runnerEnvironment: args.runnerEnvironment,
    env: process.env
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  AUTH_MODES,
  resolveCodexHome,
  hasFileAuthState,
  hasCodexAuthState,
  validateInputs
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
