#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const MODEL = process.env.LIVE_VALIDATION_MODEL ?? "qwen2.5-coder-7b";
const LLAMA = process.env.LIVE_LLAMA_HEALTH_URL ?? "http://127.0.0.1:8000/health";
const CAPTURE = process.env.LIVE_CAPTURE_HEALTH_URL ?? "http://127.0.0.1:8002/health";
const SCENARIO = process.env.LIVE_SCENARIO_HEALTH_URL ?? "http://127.0.0.1:8003/health";
const ENDPOINT = process.env.LIVE_SCENARIO_ENDPOINT ?? "http://127.0.0.1:8003/v1/chat/completions?scenario=control_low";
const BASE = process.env.LIVE_DURABLE_REGISTRY_OUT_DIR ??
  `/workspace/results/durable-consumption-registry/phase-ab-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const DB = process.env.LIVE_DURABLE_REGISTRY_PATH ?? path.join(BASE, "registry.sqlite");
const HANDOFF_FILE = path.join(BASE, "handoff.json");
const REGISTRY_MODULE = "../dist/packages/product-runtime/src/durable-consumption-registry.js";

async function worker() {
  const mode = process.argv[2];
  if (!new Set(["reserve-worker", "inspect-worker"]).has(mode)) return false;
  const runtime = await import(REGISTRY_MODULE);
  const registryPath = process.argv[3];
  const handoffPath = process.argv[4];
  const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  const result = mode === "reserve-worker"
    ? runtime.reserveDurableConsumption({ registryPath, handoff, reservedBy: process.argv[5], reservedAt: process.argv[6] })
    : runtime.inspectDurableConsumption({ registryPath, consumptionKey: handoff.singleUse.consumptionKey });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return true;
}
function sha(value) { return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`; }
function command(args) { const r = spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: "utf8" }); if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr || r.stdout}`); return r.stdout.trim(); }
function clean() { const s = spawnSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" }); const d = spawnSync("git", ["diff", "--check"], { cwd: ROOT, encoding: "utf8" }); return s.status === 0 && s.stdout.trim() === "" && d.status === 0; }
function target() { return { repositoryIdentityHash: sha(JSON.stringify({ remote: command(["git","config","--get","remote.origin.url"]), root: ROOT })), baseRevisionHash: sha(command(["git","rev-parse","HEAD"])), worktreeStateHash: sha(command(["git","status","--porcelain=v1","--untracked-files=all"])) }; }
async function health(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url} health failed ${response.status}`); return response.text(); }
async function wait(url) { let error; for (let i = 0; i < 100; i += 1) { try { return await health(url); } catch (e) { error = e; await new Promise((r) => setTimeout(r, 100)); } } throw error; }
function startProxy() { fs.mkdirSync(BASE, { recursive: true }); const fd = fs.openSync(path.join(BASE, "scenario-proxy.log"), "a"); const child = spawn("python3", ["-u", "scripts/openai-governance-scenario-proxy.py"], { cwd: ROOT, env: { ...process.env, GOVERNANCE_SCENARIO_PROXY_PORT: "8003", GOVERNANCE_SCENARIO_PROXY_UPSTREAM: "http://127.0.0.1:8002/v1/chat/completions" }, stdio: ["ignore", fd, fd] }); return { child, fd }; }
function configure(outDir, snapshot) { for (const key of Object.keys(process.env)) if (key.startsWith("WORKER_ORCHESTRATOR_")) delete process.env[key]; Object.assign(process.env, { WORKER_ORCHESTRATOR_UPSTREAM_URL: ENDPOINT, WORKER_ORCHESTRATOR_MODEL_ID: MODEL, WORKER_ORCHESTRATOR_TIMEOUT_MS: "300000", WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS: "512", WORKER_ORCHESTRATOR_CODER_MAX_TOKENS: "1024", WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS: "1536", WORKER_ORCHESTRATOR_REQUIRED: "1", WORKER_ORCHESTRATOR_FORCE_REMASK: "1", WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: ENDPOINT, WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: MODEL, WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "300000", WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1", WORKER_ORCHESTRATOR_ADMIN_MODE: "always", WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: ENDPOINT, WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: MODEL, WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "300000", WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1", WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH: snapshot.repositoryIdentityHash, WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH: snapshot.baseRevisionHash, WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH: snapshot.worktreeStateHash, WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS: "not_consumed", WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1", WORKER_ORCHESTRATOR_OUT_DIR: outDir }); }
function runChild(args) { const result = spawnSync(process.execPath, [__filename, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
function raceReserve() { return Promise.all(["race-a","race-b"].map((reservedBy, index) => new Promise((resolve, reject) => { const child = spawn(process.execPath, [__filename, "reserve-worker", DB, HANDOFF_FILE, reservedBy, `2026-07-20T12:00:0${index}.000Z`], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; child.stdout.on("data", (d) => out += d); child.stderr.on("data", (d) => err += d); child.on("exit", (code) => { if (code !== 0) reject(new Error(err || out)); else resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1))); }); }))); }

async function main() {
  if (await worker()) return;
  if (!clean()) throw new Error("repository must be clean");
  await health(LLAMA); await health(CAPTURE);
  fs.mkdirSync(BASE, { recursive: true });
  let proxy = null;
  try { try { await health(SCENARIO); } catch { proxy = startProxy(); await wait(SCENARIO); }
    const orchestrator = require("./worker-backed-orchestrator-smoke.cjs");
    const outDir = path.join(BASE, "orchestrator"); configure(outDir, target());
    const report = await orchestrator.run();
    const handoff = report.controlledApplyHandoff?.handoff;
    if (report.status !== "completed" || report.workflowRoute !== "auto_continue" ||
        report.controlledApplyHandoff?.decision !== "controlled_apply_handoff_ready" ||
        report.controlledApplyHandoffVerification?.decision !== "controlled_apply_handoff_current" ||
        !handoff) throw new Error("live handoff was not ready");
    fs.writeFileSync(HANDOFF_FILE, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
    const runtime = await import(REGISTRY_MODULE);
    const initial = runtime.inspectDurableConsumption({ registryPath: DB, consumptionKey: handoff.singleUse.consumptionKey });
    const raced = await raceReserve();
    const winners = raced.filter((entry) => entry.decision === "durable_consumption_reserved" && entry.reserved === true);
    const losers = raced.filter((entry) => entry.decision === "durable_consumption_already_reserved" && entry.reserved === false);
    const reopened = runChild(["inspect-worker", DB, HANDOFF_FILE]);
    const winner = winners[0];
    const finalized = runtime.finalizeDurableConsumption({ registryPath: DB, consumptionKey: handoff.singleUse.consumptionKey, handoffHash: handoff.handoffHash, reservationId: winner?.record?.reservationId, reservedBy: winner?.record?.reservedBy, outcome: "failed", failureCode: "apply_not_executed" });
    const afterRestart = runChild(["inspect-worker", DB, HANDOFF_FILE]);
    const replay = runtime.reserveDurableConsumption({ registryPath: DB, handoff, reservedBy: "replay-attempt" });
    const tampered = structuredClone(handoff); tampered.handoffHash = sha("tampered");
    const tamperResult = runtime.reserveDurableConsumption({ registryPath: path.join(BASE, "tampered.sqlite"), handoff: tampered, reservedBy: "tamper-attempt" });
    const checks = {
      initialAvailable: initial.decision === "durable_consumption_available",
      exactlyOneWinner: winners.length === 1 && losers.length === 1,
      persistedReserved: reopened.decision === "durable_consumption_reserved",
      failedClosed: finalized.decision === "durable_consumption_failed_requires_review",
      persistedAfterReopen: afterRestart.decision === "durable_consumption_failed_requires_review",
      replayRejected: replay.decision === "durable_consumption_failed_requires_review" && replay.reserved === false,
      tamperRejected: tamperResult.decision === "durable_consumption_reservation_invalid",
      repositoryClean: clean(), realApplyExecuted: false, rollbackExecuted: false,
    };
    const summary = { stable: Object.values(checks).every(Boolean), registryPath: DB, handoffHash: handoff.handoffHash, consumptionKey: handoff.singleUse.consumptionKey, raceDecisions: raced.map((entry) => entry.decision), finalDecision: finalized.decision, replayDecision: replay.decision, tamperDecision: tamperResult.decision, checks };
    fs.writeFileSync(path.join(BASE, "durable-consumption-registry-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(summary.stable ? "LIVE_DURABLE_CONSUMPTION_REGISTRY_PASSED" : "LIVE_DURABLE_CONSUMPTION_REGISTRY_FAILED");
    if (!summary.stable) process.exitCode = 1;
  } finally { for (const key of Object.keys(process.env)) if (key.startsWith("WORKER_ORCHESTRATOR_")) delete process.env[key]; if (proxy) { proxy.child.kill("SIGTERM"); fs.closeSync(proxy.fd); } }
}
main().catch((error) => { console.error("LIVE_DURABLE_CONSUMPTION_REGISTRY_SCRIPT_ERROR"); console.error(error.stack || error); process.exitCode = 1; });
