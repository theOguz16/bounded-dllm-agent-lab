#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const AUTH_MODES = Object.freeze(["api_key", "codex_home"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const repoRoot = path.resolve(__dirname, "../..");

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

function commandOk(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot, env, stdio: "ignore", timeout: 30_000, windowsHide: true
  });
  return result.error === undefined && result.status === 0;
}

function doctorConfirmsModelAccess(report, model) {
  return report?.checks?.["auth.credentials"]?.status === "ok" &&
    report?.checks?.["config.load"]?.details?.model === model &&
    report?.checks?.["network.provider_reachability"]?.status === "ok";
}

function validateInputs({ mode, model, runnerEnvironment, runnerOs, runnerArch, env = process.env,
  checkRuntime = false }) {
  if (!AUTH_MODES.includes(mode)) {
    fail("auth_mode must be one of: api_key, codex_home");
  }
  if (typeof model !== "string" || !MODEL.test(model.trim())) {
    fail("an exact model id is required");
  }

  if (mode === "api_key") {
    const hasApiKey = Boolean(env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
    if (!hasApiKey) fail("api_key mode requires CODEX_API_KEY or OPENAI_API_KEY");
  } else {
    if (runnerEnvironment !== "self-hosted") {
      fail("codex_home mode requires a self-hosted GitHub Actions runner");
    }
    if (!hasCodexAuthState(env)) {
      fail("codex_home mode requires an existing Codex login state in CODEX_HOME or the default Codex home");
    }
  }

  const checks = {
    auth: true,
    modelConfigured: true,
    runnerImage: Boolean(runnerOs && runnerArch),
    lockfile: fs.existsSync(path.join(repoRoot, "package-lock.json")),
    dependencies: fs.existsSync(path.join(repoRoot, "node_modules")),
    build: fs.existsSync(path.join(repoRoot, "dist/apps/cli/src/index.js")),
    codexCli: commandOk("codex", ["--version"], env),
    modelAccess: false
  };
  if (checkRuntime) {
    if (!checks.runnerImage) fail("runner image identity is unavailable");
    if (!checks.lockfile) fail("package-lock.json is required for npm ci");
    if (!checks.dependencies) fail("dependencies are not prepared; npm ci must complete before preflight");
    if (!checks.build) fail("built CLI is missing; npm run build must complete before preflight");
    if (!checks.codexCli) fail("Codex CLI is unavailable");
    const doctor = spawnSync("codex", ["doctor", "--json", "-c", `model=${JSON.stringify(model.trim())}`], {
      cwd: repoRoot, env, encoding: "utf8", timeout: 60_000, windowsHide: true
    });
    let report = null;
    try { report = JSON.parse(doctor.stdout); } catch {}
    checks.modelAccess = doctor.error === undefined && doctorConfirmsModelAccess(report, model.trim());
    if (!checks.modelAccess) fail("Codex doctor could not verify auth, configured model, and provider reachability");
  }

  return Object.freeze({ ok: true, authMode: mode, model: model.trim(), runnerOs, runnerArch,
    checks, paidModelCalls: 0 });
}

function parseArgs(argv) {
  const values = { mode: null, model: null, runnerEnvironment: null, runnerOs: null,
    runnerArch: null, output: null, checkRuntime: false };
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) values.mode = arg.slice("--mode=".length).trim();
    else if (arg.startsWith("--model=")) values.model = arg.slice("--model=".length).trim();
    else if (arg.startsWith("--runner-environment=")) values.runnerEnvironment = arg.slice("--runner-environment=".length).trim();
    else if (arg.startsWith("--runner-os=")) values.runnerOs = arg.slice("--runner-os=".length).trim();
    else if (arg.startsWith("--runner-arch=")) values.runnerArch = arg.slice("--runner-arch=".length).trim();
    else if (arg.startsWith("--output=")) values.output = path.resolve(arg.slice("--output=".length));
    else if (arg === "--check-runtime") values.checkRuntime = true;
    else fail(`unknown argument: ${arg}`);
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = validateInputs({ ...args, env: process.env });
  } catch (error) {
    result = { schemaVersion: "product-dogfood-preflight-diagnostic/v1", ok: false,
      failureDomain: "infrastructure", failureCode: error.code || "dogfood_live_preflight_failed",
      message: error instanceof Error ? error.message : String(error), paidModelCalls: 0 };
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    throw error;
  }

  result = { schemaVersion: "product-dogfood-preflight-diagnostic/v1", ...result };
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }

  if (args.mode === "codex_home" && process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `CODEX_HOME=${resolveCodexHome(process.env)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  AUTH_MODES,
  resolveCodexHome,
  hasFileAuthState,
  hasCodexAuthState,
  doctorConfirmsModelAccess,
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
