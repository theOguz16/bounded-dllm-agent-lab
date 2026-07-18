#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ENDPOINT = process.env.LIVE_VALIDATION_ENDPOINT ?? "http://127.0.0.1:8002/v1/chat/completions";
const MODEL = process.env.LIVE_VALIDATION_MODEL ?? "qwen2.5-coder-7b";
const BASE = process.env.LIVE_STABILITY_OUT_DIR ?? "/tmp/phase-y-live/shadow-admin-stability-v2";
const CAPTURE = process.env.LIVE_VALIDATION_CAPTURE_PATH ?? "/tmp/qwen-capture/events.jsonl";

function count(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error(`${name} must be an integer between 1 and 50`);
  }
  return value;
}

const FORCED = count("LIVE_STABILITY_FORCED_RUNS", 5);
const NORMAL = count("LIVE_STABILITY_NORMAL_RUNS", 5);

function section(report, name) {
  const value = report[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function gitClean() {
  const status = spawnSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" });
  const check = spawnSync("git", ["diff", "--check"], { cwd: ROOT, encoding: "utf8" });
  return status.status === 0 && status.stdout.trim() === "" && check.status === 0;
}

function latestJson(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "stability-run-summary.json")
    .map((name) => ({ path: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No report in ${dir}`);
  return files[0].path;
}

function captureRole(request) {
  const text = request?.messages?.[0]?.content;
  if (typeof text !== "string") return null;
  const lower = text.toLowerCase();
  if (lower.includes("shadow observer")) return "SHADOW";
  if (lower.includes("admin agent")) return "ADMIN";
  return null;
}

function captureShapes() {
  const result = { SHADOW: null, ADMIN: null };
  if (!fs.existsSync(CAPTURE)) return result;
  for (const line of fs.readFileSync(CAPTURE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const role = captureRole(event.request);
    if (!role) continue;
    const schema = event.request?.response_format?.schema ?? {};
    const content = event.response?.choices?.[0]?.message?.content;
    let parsed = null;
    try { parsed = JSON.parse(content); } catch {}
    const required = schema.required ?? [];
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    result[role] = {
      valid: event.status === 200 && event.response?.choices?.[0]?.finish_reason === "stop" &&
        !("oneOf" in schema) && parsed !== null &&
        required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key)),
    };
  }
  return result;
}

function envFor(mode, outDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WORKER_ORCHESTRATOR_")));
  return {
    ...env,
    WORKER_ORCHESTRATOR_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS: "512",
    WORKER_ORCHESTRATOR_CODER_MAX_TOKENS: "1024",
    WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS: "1536",
    WORKER_ORCHESTRATOR_REQUIRED: "1",
    WORKER_ORCHESTRATOR_FORCE_REMASK: mode === "forced" ? "1" : "0",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1",
    WORKER_ORCHESTRATOR_ADMIN_MODE: "always",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
    WORKER_ORCHESTRATOR_OUT_DIR: outDir,
  };
}

function requireCheck(failures, condition, code) {
  if (!condition) failures.push(code);
}

function runOne(mode, index) {
  const name = `${mode}-${String(index).padStart(2, "0")}`;
  const dir = path.join(BASE, "runs", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.dirname(CAPTURE), { recursive: true });
  fs.writeFileSync(CAPTURE, "");

  const started = Date.now();
  const child = spawnSync(process.execPath, ["scripts/worker-backed-orchestrator-smoke.cjs"], {
    cwd: ROOT, env: envFor(mode, dir), encoding: "utf8", maxBuffer: 100 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, "stdout.log"), child.stdout ?? "");
  fs.writeFileSync(path.join(dir, "stderr.log"), child.stderr ?? "");

  const report = JSON.parse(fs.readFileSync(latestJson(dir), "utf8"));
  const verifier = section(report, "verifier");
  const remask = section(report, "remask");
  const phaseV = section(report, "tempWorkspaceExecution");
  const shadow = section(report, "shadowObserver");
  const governance = section(report, "governance");
  const admin = section(report, "adminAgent");
  const router = section(report, "approvalRouter");
  const artifact = section(report, "governedChangeArtifact");
  const handoff = section(report, "controlledApplyHandoff");
  const shapes = captureShapes();
  const failures = [];

  requireCheck(failures, child.status === 0, "orchestrator_exit_nonzero");
  requireCheck(failures, report.ok === true && report.status === "completed", "report_not_completed");
  requireCheck(failures, report.forceRemask === (mode === "forced"), "force_remask_mismatch");
  requireCheck(failures, gitClean(), "repository_not_clean");
  requireCheck(failures, handoff.configured === false, "handoff_configured");
  requireCheck(failures, handoff.handoffBuilt !== true, "handoff_built");
  requireCheck(failures, handoff.applyExecuted !== true, "real_apply_executed");

  if (mode === "forced") {
    requireCheck(failures, verifier.decision === "needs_review", "forced_verifier_mismatch");
    requireCheck(failures, remask.called === true, "forced_remask_not_called");
    requireCheck(failures, phaseV.decision === "temp_validation_passed", "forced_phase_v_failed");
    requireCheck(failures, phaseV.cleanupPerformed === true && phaseV.failedCommands === 0, "forced_cleanup_failed");
    requireCheck(failures, shadow.validationDecision === "shadow_observation_valid", "forced_shadow_invalid");
    requireCheck(failures, governance.decision === "governance_passed", "forced_governance_invalid");
    requireCheck(failures, admin.validationDecision === "admin_decision_valid", "forced_admin_invalid");
    requireCheck(failures, router.deterministicAuthorityPreserved === true, "forced_authority_lost");
    requireCheck(failures, shapes.SHADOW?.valid === true && shapes.ADMIN?.valid === true, "forced_shape_invalid");
    requireCheck(failures, report.workflowRoute === "auto_continue", "forced_route_mismatch");
    requireCheck(failures, artifact.decision === "governed_change_artifact_ready" && artifact.artifactBuilt === true, "forced_artifact_invalid");
    requireCheck(failures, report.finalDecision === "temp_validation_passed", "forced_final_mismatch");
  } else {
    requireCheck(failures, verifier.called === true && verifier.decision === "approve" && verifier.ok === true, "normal_verifier_invalid");
    requireCheck(failures, verifier.issueCount === 0, "normal_verifier_issues");
    requireCheck(failures, remask.called === false && remask.requested === false, "normal_remask_unexpected");
    requireCheck(failures, report.finalDecision === "approved_by_deterministic_verifier", "normal_final_mismatch");
    requireCheck(failures, report.workflowRoute === null, "normal_route_unexpected");
    requireCheck(failures, report.shadowStageDecision === "shadow_not_called", "normal_shadow_stage_mismatch");
    requireCheck(failures, report.governanceStageDecision === "governance_not_evaluated", "normal_governance_stage_mismatch");
    requireCheck(failures, report.adminStageDecision === "admin_not_called", "normal_admin_stage_mismatch");
    requireCheck(failures, report.approvalRouterStageDecision === "approval_route_not_evaluated", "normal_router_stage_mismatch");
    requireCheck(failures, shapes.SHADOW === null && shapes.ADMIN === null, "normal_governance_capture_unexpected");
  }

  const result = { mode, index, success: failures.length === 0, failures, elapsedMs, finalDecision: report.finalDecision ?? null, workflowRoute: report.workflowRoute ?? null };
  fs.writeFileSync(path.join(dir, "stability-run-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[${result.success ? "PASS" : "FAIL"}] ${name} final=${result.finalDecision} route=${result.workflowRoute ?? "none"} elapsedMs=${elapsedMs}`);
  if (!result.success) console.log(`  failures=${JSON.stringify(failures)}`);
  return result;
}

async function health(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} health failed: ${response.status}`);
  console.log(`${label}: ${await response.text()}`);
}

async function main() {
  await health("http://127.0.0.1:8000/health", "llama-server");
  await health("http://127.0.0.1:8002/health", "capture-proxy");
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, "runs"), { recursive: true });
  const results = [];
  for (let i = 1; i <= FORCED; i++) results.push(runOne("forced", i));
  for (let i = 1; i <= NORMAL; i++) results.push(runOne("normal", i));
  const failures = results.filter((result) => !result.success);
  const summary = { stable: failures.length === 0, total: results.length, passed: results.length - failures.length, failed: failures.length, realApplyExecuted: false, controlledHandoffBuilt: false, results };
  fs.writeFileSync(path.join(BASE, "stability-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(summary.stable ? "LIVE_SHADOW_ADMIN_STABILITY_V2_PASSED" : "LIVE_SHADOW_ADMIN_STABILITY_V2_FAILED");
  if (!summary.stable) process.exitCode = 1;
}

main().catch((error) => {
  console.error("LIVE_SHADOW_ADMIN_STABILITY_V2_SCRIPT_ERROR");
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
