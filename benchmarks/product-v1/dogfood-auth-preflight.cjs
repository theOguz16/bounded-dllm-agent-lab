#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const AUTH_MODES = Object.freeze(["api_key", "codex_home"]);
const REQUIRED_MODEL = "gpt-5.6-luna";
const REQUIRED_REASONING = "none";
const ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const repoRoot = path.resolve(__dirname, "../..");

function codexCommand() {
  const local = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  return fs.existsSync(local) ? local : "codex";
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
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
  } catch { return false; }
}

function hasCliAuthState(codexHome, env = process.env) {
  const result = spawnSync(codexCommand(), ["login", "status"], { env: { ...env, CODEX_HOME: codexHome }, stdio: "ignore", timeout: 10_000, windowsHide: true });
  return result.error === undefined && result.status === 0;
}

function hasCodexAuthState(env = process.env) {
  const home = resolveCodexHome(env);
  return hasFileAuthState(home) || hasCliAuthState(home, env);
}

function commandOk(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "ignore", timeout: 30_000, windowsHide: true });
  return result.error === undefined && result.status === 0;
}

function validationInputsReady() {
  try {
    const taskset = JSON.parse(fs.readFileSync(path.join(repoRoot, "benchmarks/product-v1/tasks/dogfood/taskset.json"), "utf8"));
    return Array.isArray(taskset.tasks) && taskset.tasks.length > 0 && taskset.tasks.every((task) =>
      Array.isArray(task.validationCommands) && task.validationCommands.length > 0 &&
      task.validationCommands.every((command) => typeof command === "string" && command.trim().length > 0));
  } catch { return false; }
}

function doctorConfirmsModelAccess(report, model, reasoning = REQUIRED_REASONING) {
  const details = report?.checks?.["config.load"]?.details;
  return details?.model === model && details?.reasoningEffort === reasoning;
}

function runtimeCompatibility(env, model, reasoning) {
  const doctor = spawnSync(codexCommand(), ["doctor", "--json", "-c", `model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`], {
    cwd: repoRoot, env, encoding: "utf8", timeout: 60_000, windowsHide: true
  });
  let report = null;
  try { report = JSON.parse(doctor.stdout); } catch {}
  return { ok: doctor.error === undefined && doctor.status === 0 && doctorConfirmsModelAccess(report, model, reasoning), report };
}

function validateInputs({ mode, model, reasoning = REQUIRED_REASONING, accountAlias, runnerEnvironment,
  runnerOs, runnerArch, env = process.env, checkRuntime = false, firstLiveAttemptApproved = false,
  firstLiveAttemptBudget = 0, compatibilityProbe = runtimeCompatibility, commandProbe = commandOk }) {
  if (!AUTH_MODES.includes(mode)) fail("dogfood_preflight_auth_mode_invalid", "auth_mode must be one of: api_key, codex_home");
  if (model !== REQUIRED_MODEL) fail("dogfood_preflight_model_mismatch", `model must be exactly ${REQUIRED_MODEL}; fallback is forbidden`);
  if (reasoning !== REQUIRED_REASONING) fail("dogfood_preflight_reasoning_mismatch", `reasoning must be exactly ${REQUIRED_REASONING}`);
  if (!ACCOUNT_ALIAS.test(accountAlias || "")) fail("dogfood_preflight_account_alias_invalid", "a stable non-secret account alias is required");
  if (firstLiveAttemptApproved !== true || firstLiveAttemptBudget !== 1) {
    fail("dogfood_preflight_live_attempt_not_approved", "the first live access attempt requires explicit approval and an exact budget of one invocation");
  }

  let localAuthPresent = false;
  if (mode === "api_key") {
    localAuthPresent = Boolean(env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
    if (!localAuthPresent) fail("dogfood_preflight_auth_missing", "api_key mode requires CODEX_API_KEY or OPENAI_API_KEY");
  } else {
    if (runnerEnvironment !== "self-hosted") fail("dogfood_preflight_runner_invalid", "codex_home mode requires a self-hosted runner");
    localAuthPresent = hasCodexAuthState(env);
    if (!localAuthPresent) fail("dogfood_preflight_auth_missing", "codex_home mode requires local Codex login state");
  }

  const checks = {
    authStatePresent: localAuthPresent,
    authAccessVerified: false,
    modelPinned: true,
    reasoningPinned: true,
    runnerImage: Boolean(runnerOs && runnerArch),
    lockfile: fs.existsSync(path.join(repoRoot, "package-lock.json")),
    dependencies: fs.existsSync(path.join(repoRoot, "node_modules")),
    build: fs.existsSync(path.join(repoRoot, "dist/apps/cli/src/index.js")),
    validationPrepared: validationInputsReady(),
    codexCli: commandProbe(codexCommand(), ["--version"], env),
    cliModelReasoningCompatible: false
  };
  if (checkRuntime) {
    for (const [key, message] of [
      ["runnerImage", "runner image identity is unavailable"], ["lockfile", "package-lock.json is required"],
      ["dependencies", "dependencies are not prepared"], ["build", "built CLI is missing"],
      ["validationPrepared", "validation inputs are missing"], ["codexCli", "Codex CLI is unavailable"]
    ]) if (!checks[key]) fail(`dogfood_preflight_${key}_failed`, message);
    checks.cliModelReasoningCompatible = compatibilityProbe(env, model, reasoning).ok === true;
    if (!checks.cliModelReasoningCompatible) fail("dogfood_preflight_cli_model_incompatible", "installed Codex path did not confirm the exact Luna/none configuration");
  }

  return Object.freeze({
    ok: true, authMode: mode, accountAlias, model, reasoning, runnerOs, runnerArch, checks,
    quota: { status: "unknown", reason: "No reliable free quota query is available; local auth state and API pricing do not prove account access or remaining quota." },
    providerEndpoint: { access: "unverified", firstAttemptApproved: true, invocationBudget: 1 },
    networkPolicies: { providerEndpoint: "approved_first_attempt_only", agent: "disabled", validation: "disabled" },
    silentFallback: false, paidModelCalls: 0
  });
}

function parseArgs(argv) {
  const values = { mode: null, model: null, reasoning: REQUIRED_REASONING, accountAlias: null,
    runnerEnvironment: null, runnerOs: null, runnerArch: null, output: null, checkRuntime: false,
    firstLiveAttemptApproved: false, firstLiveAttemptBudget: 0 };
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) values.mode = arg.slice(7).trim();
    else if (arg.startsWith("--model=")) values.model = arg.slice(8).trim();
    else if (arg.startsWith("--reasoning=")) values.reasoning = arg.slice(12).trim();
    else if (arg.startsWith("--account-alias=")) values.accountAlias = arg.slice(16).trim();
    else if (arg.startsWith("--runner-environment=")) values.runnerEnvironment = arg.slice(21).trim();
    else if (arg.startsWith("--runner-os=")) values.runnerOs = arg.slice(12).trim();
    else if (arg.startsWith("--runner-arch=")) values.runnerArch = arg.slice(14).trim();
    else if (arg.startsWith("--output=")) values.output = path.resolve(arg.slice(9));
    else if (arg === "--check-runtime") values.checkRuntime = true;
    else if (arg === "--approve-first-live-attempt") values.firstLiveAttemptApproved = true;
    else if (arg.startsWith("--first-live-attempt-budget=")) values.firstLiveAttemptBudget = Number(arg.slice(28));
    else fail("dogfood_preflight_argument_invalid", `unknown argument: ${arg}`);
  }
  return values;
}

function safeDiagnostic(error) {
  return { schemaVersion: "product-dogfood-preflight-diagnostic/v2", ok: false, failureDomain: "infrastructure",
    failureCode: error.code || "dogfood_live_preflight_failed", message: error instanceof Error ? error.message : String(error),
    quota: { status: "unknown" }, paidModelCalls: 0 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try { result = validateInputs({ ...args, env: process.env }); }
  catch (error) {
    result = safeDiagnostic(error);
    if (args.output) { fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); }
    throw error;
  }
  result = { schemaVersion: "product-dogfood-preflight-diagnostic/v2", ...result };
  if (args.output) { fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); }
  if (args.mode === "codex_home" && process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `CODEX_HOME=${resolveCodexHome(process.env)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { AUTH_MODES, REQUIRED_MODEL, REQUIRED_REASONING, codexCommand, resolveCodexHome,
  hasFileAuthState, hasCodexAuthState, doctorConfirmsModelAccess, validateInputs, safeDiagnostic };
if (require.main === module) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
