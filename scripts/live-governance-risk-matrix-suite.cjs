#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.LIVE_GOVERNANCE_MATRIX_OUT_DIR ?? "/tmp/phase-z-live/governance-risk-matrix";
const MODEL = process.env.LIVE_VALIDATION_MODEL ?? "qwen2.5-coder-7b";
const LLAMA_HEALTH = process.env.LIVE_LLAMA_HEALTH_URL ?? "http://127.0.0.1:8000/health";
const CAPTURE_HEALTH = process.env.LIVE_PROXY_HEALTH_URL ?? "http://127.0.0.1:8002/health";
const PORT = Number(process.env.GOVERNANCE_SCENARIO_PROXY_PORT ?? "8003");
const SCENARIO_HEALTH = `http://127.0.0.1:${PORT}/health`;
const SCENARIO_ENDPOINT = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const UPSTREAM = process.env.LIVE_VALIDATION_ENDPOINT ?? "http://127.0.0.1:8002/v1/chat/completions";
const ORCHESTRATOR = path.join(ROOT, "scripts", "worker-backed-orchestrator-smoke.cjs");
const PROXY = path.join(ROOT, "scripts", "openai-governance-scenario-proxy.py");

const CASES = [
  ["control_low", "completed", "governance_passed", "admin_auto_approved", "auto_continue", "governed_change_artifact_ready"],
  ["repair_required", "completed", "governance_repair_required", "admin_repair_required", "repair_required", "governed_change_artifact_blocked"],
  ["replan_required", "completed", "governance_replan_required", "admin_replan_required", "replan_required", "governed_change_artifact_blocked"],
  ["medium_human", "completed", "governance_escalation_required", "admin_human_escalation_required", "human_required", "governed_change_artifact_blocked"],
  ["high_human", "completed", "governance_escalation_required", "admin_human_escalation_required", "human_required", "governed_change_artifact_blocked"],
  ["critical_terminated", "completed", "governance_escalation_required", "admin_run_terminated", "terminated", "governed_change_artifact_blocked"],
  ["shadow_invalid_json", "shadow_failure"],
  ["shadow_missing_field", "shadow_failure"],
  ["admin_weakening_attempt", "admin_failure"],
  ["admin_invalid_json", "admin_failure"],
].map(([id, kind, governance, admin, route, artifact]) => ({ id, kind, governance, admin, route, artifact }));

const obj = (value, key) => value?.[key] && typeof value[key] === "object" ? value[key] : {};
const check = (errors, ok, code) => { if (!ok) errors.push(code); };

function cleanRepo() {
  const status = spawnSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" });
  const diff = spawnSync("git", ["diff", "--check"], { cwd: ROOT, encoding: "utf8" });
  return status.status === 0 && status.stdout.trim() === "" && diff.status === 0;
}

async function health(url) {
  try { const response = await fetch(url); return response.ok ? await response.text() : null; }
  catch { return null; }
}

async function waitHealth(url) {
  for (let i = 0; i < 50; i += 1) {
    const body = await health(url);
    if (body !== null) return body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function latestJson(dir) {
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "matrix-run-summary.json")
    .map((name) => ({ file: path.join(dir, name), time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files[0]?.file ?? null;
}

function envFor(testCase, outDir) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("WORKER_ORCHESTRATOR_") && !key.startsWith("CONTROLLED_APPLY_")));
  const endpoint = `${SCENARIO_ENDPOINT}?scenario=${encodeURIComponent(testCase.id)}`;
  return {
    ...base,
    WORKER_ORCHESTRATOR_UPSTREAM_URL: endpoint,
    WORKER_ORCHESTRATOR_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS: "512",
    WORKER_ORCHESTRATOR_CODER_MAX_TOKENS: "1024",
    WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS: "1536",
    WORKER_ORCHESTRATOR_REQUIRED: "1",
    WORKER_ORCHESTRATOR_FORCE_REMASK: "1",
    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: endpoint,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1",
    WORKER_ORCHESTRATOR_ADMIN_MODE: "always",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: endpoint,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",
    WORKER_ORCHESTRATOR_OUT_DIR: outDir,
  };
}

function runCase(testCase) {
  const outDir = path.join(BASE, "runs", testCase.id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const child = spawnSync(process.execPath, [ORCHESTRATOR], {
    cwd: ROOT, env: envFor(testCase, outDir), encoding: "utf8", maxBuffer: 100 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(outDir, "stdout.log"), child.stdout ?? "");
  fs.writeFileSync(path.join(outDir, "stderr.log"), child.stderr ?? "");
  const reportPath = latestJson(outDir);
  const errors = [];
  let report = null;
  if (!reportPath) errors.push("report_missing");
  else { try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch { errors.push("report_invalid"); } }

  check(errors, cleanRepo(), "repository_not_clean");
  if (report) {
    const handoff = obj(report, "controlledApplyHandoff");
    check(errors, handoff.configured === false, "handoff_configured");
    check(errors, handoff.handoffBuilt !== true, "handoff_built");
    check(errors, handoff.applyExecuted !== true, "real_apply_executed");

    if (testCase.kind === "completed") {
      const phaseV = obj(report, "tempWorkspaceExecution");
      const shadow = obj(report, "shadowObserver");
      const governance = obj(report, "governance");
      const admin = obj(report, "adminAgent");
      const router = obj(report, "approvalRouter");
      const artifact = obj(report, "governedChangeArtifact");
      check(errors, child.status === 0 && report.ok === true && report.status === "completed", "not_completed");
      check(errors, report.finalDecision === "temp_validation_passed", "phase_v_final_mismatch");
      check(errors, phaseV.decision === "temp_validation_passed" && phaseV.cleanupPerformed === true, "phase_v_failed");
      check(errors, shadow.validationDecision === "shadow_observation_valid", "shadow_invalid");
      check(errors, governance.decision === testCase.governance, "governance_mismatch");
      check(errors, admin.validationDecision === "admin_decision_valid" && admin.decision === testCase.admin, "admin_mismatch");
      check(errors, router.validationDecision === "approval_route_valid" && router.deterministicAuthorityPreserved === true, "router_invalid");
      check(errors, report.workflowRoute === testCase.route, "route_mismatch");
      check(errors, artifact.decision === testCase.artifact && artifact.artifactBuilt === true, "artifact_mismatch");
      check(errors, testCase.route === "auto_continue" ? artifact.applyEligible === true : artifact.applyEligible === false, "artifact_eligibility_mismatch");
    } else if (testCase.kind === "shadow_failure") {
      const shadow = obj(report, "shadowObserver");
      check(errors, child.status !== 0 && report.ok === false, "shadow_failure_not_blocked");
      check(errors, report.status === "failed_required_shadow", "shadow_failure_status");
      check(errors, shadow.called === true && shadow.decision === "shadow_observer_failed", "shadow_failure_decision");
      check(errors, report.workflowRoute !== "auto_continue", "shadow_failure_auto_continue");
    } else {
      const admin = obj(report, "adminAgent");
      check(errors, child.status !== 0 && report.ok === false, "admin_failure_not_blocked");
      check(errors, report.status === "failed_required_admin", "admin_failure_status");
      check(errors, admin.called === true && admin.adapterDecision === "admin_agent_failed", "admin_failure_decision");
      check(errors, report.workflowRoute !== "auto_continue", "admin_failure_auto_continue");
    }
  }

  const result = {
    scenario: testCase.id, success: errors.length === 0, errors,
    elapsedMs: Date.now() - started, exitStatus: child.status,
    status: report?.status ?? null, governance: report?.governance?.decision ?? null,
    admin: report?.adminAgent?.decision ?? null, route: report?.workflowRoute ?? null,
    realApplyExecuted: report?.controlledApplyHandoff?.applyExecuted === true,
    controlledHandoffBuilt: report?.controlledApplyHandoff?.handoffBuilt === true,
  };
  fs.writeFileSync(path.join(outDir, "matrix-run-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[${result.success ? "PASS" : "FAIL"}] ${result.scenario} status=${result.status ?? "none"} route=${result.route ?? "none"}`);
  if (!result.success) console.log(`  errors=${JSON.stringify(errors)}`);
  return result;
}

async function main() {
  if (!cleanRepo()) throw new Error("repository must be clean");
  if (await health(LLAMA_HEALTH) === null) throw new Error(`llama-server unavailable: ${LLAMA_HEALTH}`);
  if (await health(CAPTURE_HEALTH) === null) throw new Error(`capture-proxy unavailable: ${CAPTURE_HEALTH}`);
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, "runs"), { recursive: true });

  const out = fs.openSync(path.join(BASE, "scenario-proxy.log"), "w");
  const proxy = spawn("python3", ["-u", PROXY], {
    cwd: ROOT,
    env: { ...process.env, GOVERNANCE_SCENARIO_PROXY_PORT: String(PORT), GOVERNANCE_SCENARIO_PROXY_UPSTREAM: UPSTREAM },
    stdio: ["ignore", out, out],
  });
  try {
    if (await waitHealth(SCENARIO_HEALTH) === null) throw new Error("scenario proxy failed to start");
    const results = CASES.map(runCase);
    const summary = {
      stable: results.every((result) => result.success), total: results.length,
      passed: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
      realApplyExecuted: results.some((result) => result.realApplyExecuted),
      controlledHandoffBuilt: results.some((result) => result.controlledHandoffBuilt),
      results,
    };
    fs.writeFileSync(path.join(BASE, "governance-risk-matrix-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(summary.stable && !summary.realApplyExecuted && !summary.controlledHandoffBuilt
      ? "LIVE_GOVERNANCE_RISK_MATRIX_PASSED" : "LIVE_GOVERNANCE_RISK_MATRIX_FAILED");
    if (!summary.stable || summary.realApplyExecuted || summary.controlledHandoffBuilt) process.exitCode = 1;
  } finally {
    if (proxy.exitCode === null) proxy.kill("SIGTERM");
    try { fs.closeSync(out); } catch {}
  }
}

main().catch((error) => {
  console.error("LIVE_GOVERNANCE_RISK_MATRIX_SCRIPT_ERROR");
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
