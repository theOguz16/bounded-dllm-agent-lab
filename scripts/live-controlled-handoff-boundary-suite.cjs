#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.LIVE_HANDOFF_BOUNDARY_OUT_DIR ??
  "/tmp/phase-aa-live/controlled-handoff-boundary";
const MODEL = process.env.LIVE_VALIDATION_MODEL ?? "qwen2.5-coder-7b";
const LLAMA_HEALTH = process.env.LIVE_LLAMA_HEALTH_URL ??
  "http://127.0.0.1:8000/health";
const CAPTURE_HEALTH = process.env.LIVE_CAPTURE_HEALTH_URL ??
  "http://127.0.0.1:8002/health";
const SCENARIO_HEALTH = process.env.LIVE_SCENARIO_HEALTH_URL ??
  "http://127.0.0.1:8003/health";
const SCENARIO_ENDPOINT = process.env.LIVE_SCENARIO_ENDPOINT ??
  "http://127.0.0.1:8003/v1/chat/completions";

const CASES = [
  {
    name: "ready_not_consumed",
    scenario: "control_low",
    consumptionStatus: "not_consumed",
    expectedStatus: "completed",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_current",
    expectedExecutionEligible: true,
    expectedApplicable: true,
    expectedBuilt: true,
  },
  {
    name: "already_consumed",
    scenario: "control_low",
    consumptionStatus: "already_consumed",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_consumed",
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: true,
  },
  {
    name: "unknown_consumption_status",
    scenario: "control_low",
    consumptionStatus: "unknown",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_verification_invalid",
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: true,
  },
  {
    name: "tampered_handoff_hash",
    scenario: "control_low",
    consumptionStatus: "not_consumed",
    mutation: "handoff_hash",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_verification_invalid",
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: true,
    expectedReason: "controlled_apply_handoff_hash_mismatch",
  },
  {
    name: "stale_base_revision",
    scenario: "control_low",
    consumptionStatus: "not_consumed",
    mutation: "base_revision",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_stale",
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: true,
    expectedStaleField: "baseRevisionHash",
  },
  {
    name: "stale_freshness_snapshot",
    scenario: "control_low",
    consumptionStatus: "not_consumed",
    mutation: "freshness_snapshot",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_ready",
    expectedVerificationDecision: "controlled_apply_handoff_stale",
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: true,
    expectedStaleField: "currentSnapshotHash",
  },
  {
    name: "constraint_relaxation",
    scenario: "control_low",
    consumptionStatus: "not_consumed",
    mutation: "constraints",
    expectedStatus: "failed_required_controlled_apply_handoff",
    expectedRoute: "auto_continue",
    expectedHandoffDecision: "controlled_apply_handoff_invalid",
    expectedVerificationDecision: null,
    expectedExecutionEligible: false,
    expectedApplicable: true,
    expectedBuilt: false,
    expectedIssue: "controlled_apply_constraint_relaxation_forbidden",
  },
  {
    name: "repair_route_blocked",
    scenario: "repair_required",
    consumptionStatus: "not_consumed",
    expectedStatus: "completed",
    expectedRoute: "repair_required",
    expectedHandoffDecision: null,
    expectedVerificationDecision: null,
    expectedExecutionEligible: false,
    expectedApplicable: false,
    expectedBuilt: false,
  },
  {
    name: "replan_route_blocked",
    scenario: "replan_required",
    consumptionStatus: "not_consumed",
    expectedStatus: "completed",
    expectedRoute: "replan_required",
    expectedHandoffDecision: null,
    expectedVerificationDecision: null,
    expectedExecutionEligible: false,
    expectedApplicable: false,
    expectedBuilt: false,
  },
  {
    name: "human_route_blocked",
    scenario: "medium_human",
    consumptionStatus: "not_consumed",
    expectedStatus: "completed",
    expectedRoute: "human_required",
    expectedHandoffDecision: null,
    expectedVerificationDecision: null,
    expectedExecutionEligible: false,
    expectedApplicable: false,
    expectedBuilt: false,
  },
  {
    name: "terminated_route_blocked",
    scenario: "critical_terminated",
    consumptionStatus: "not_consumed",
    expectedStatus: "completed",
    expectedRoute: "terminated",
    expectedHandoffDecision: null,
    expectedVerificationDecision: null,
    expectedExecutionEligible: false,
    expectedApplicable: false,
    expectedBuilt: false,
  },
];

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function command(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function repositoryClean() {
  const status = spawnSync("git", ["status", "--short"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const diff = spawnSync("git", ["diff", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return status.status === 0 && status.stdout.trim() === "" && diff.status === 0;
}

function targetSnapshot() {
  const remote = command(["git", "config", "--get", "remote.origin.url"]);
  const revision = command(["git", "rev-parse", "HEAD"]);
  const worktree = command([
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return {
    repositoryIdentityHash: sha256(JSON.stringify({ remote, root: ROOT })),
    baseRevisionHash: sha256(revision),
    worktreeStateHash: sha256(worktree),
  };
}

async function health(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} health failed: ${response.status}`);
  return response.text();
}

async function waitForHealth(url, label, attempts = 100) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await health(url, label);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`${label} did not become healthy`);
}

function startScenarioProxy() {
  fs.mkdirSync(BASE, { recursive: true });
  const logPath = path.join(BASE, "scenario-proxy.log");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    "python3",
    ["-u", "scripts/openai-governance-scenario-proxy.py"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GOVERNANCE_SCENARIO_PROXY_PORT: "8003",
        GOVERNANCE_SCENARIO_PROXY_UPSTREAM:
          "http://127.0.0.1:8002/v1/chat/completions",
      },
      stdio: ["ignore", logFd, logFd],
    },
  );
  return { child, logFd };
}

function clearOrchestratorEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("WORKER_ORCHESTRATOR_")) delete process.env[key];
  }
}

function configureCase(testCase, outDir, target) {
  clearOrchestratorEnvironment();
  const endpoint = `${SCENARIO_ENDPOINT}?scenario=${encodeURIComponent(testCase.scenario)}`;
  Object.assign(process.env, {
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
    WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH:
      target.repositoryIdentityHash,
    WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH:
      target.baseRevisionHash,
    WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH:
      target.worktreeStateHash,
    WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS:
      testCase.consumptionStatus,
    WORKER_ORCHESTRATOR_HANDOFF_REQUIRED: "1",
    WORKER_ORCHESTRATOR_OUT_DIR: outDir,
  });
}

function applyFixtureMutation(orchestrator, testCase) {
  const fixture = orchestrator.fixture;
  delete fixture.controlledApplyHandoffInputMutation;
  delete fixture.controlledApplyHandoffMutation;
  delete fixture.controlledApplyHandoffVerificationInputMutation;

  if (testCase.mutation === "handoff_hash") {
    fixture.controlledApplyHandoffMutation = (handoff) => ({
      ...handoff,
      handoffHash: sha256("tampered-handoff-hash"),
    });
  }
  if (testCase.mutation === "base_revision") {
    fixture.controlledApplyHandoffVerificationInputMutation = (input) => ({
      ...input,
      currentTarget: {
        ...input.currentTarget,
        baseRevisionHash: sha256("stale-base-revision"),
      },
    });
  }
  if (testCase.mutation === "freshness_snapshot") {
    fixture.controlledApplyHandoffVerificationInputMutation = (input) => ({
      ...input,
      currentFreshnessSnapshot: {
        ...input.currentFreshnessSnapshot,
        routeHash: sha256("stale-route-hash"),
      },
    });
  }
  if (testCase.mutation === "constraints") {
    fixture.controlledApplyHandoffInputMutation = (input, runtime) => ({
      ...input,
      constraints: {
        ...runtime.DEFAULT_CONTROLLED_APPLY_CONSTRAINTS,
        requireRollbackPreparation: false,
      },
    });
  }
}

function clearFixtureMutations(orchestrator) {
  delete orchestrator.fixture.controlledApplyHandoffInputMutation;
  delete orchestrator.fixture.controlledApplyHandoffMutation;
  delete orchestrator.fixture.controlledApplyHandoffVerificationInputMutation;
}

function validateCase(testCase, report) {
  const errors = [];
  const handoff = report.controlledApplyHandoff ?? {};
  const verification = report.controlledApplyHandoffVerification ?? {};
  const check = (condition, code) => {
    if (!condition) errors.push(code);
  };

  check(report.status === testCase.expectedStatus, "status_mismatch");
  check(report.workflowRoute === testCase.expectedRoute, "route_mismatch");
  check(handoff.applicable === testCase.expectedApplicable, "applicable_mismatch");
  check(handoff.handoffBuilt === testCase.expectedBuilt, "handoff_built_mismatch");
  check(handoff.decision === testCase.expectedHandoffDecision, "handoff_decision_mismatch");
  check(
    verification.decision === testCase.expectedVerificationDecision,
    "verification_decision_mismatch",
  );
  check(
    verification.executionEligible === testCase.expectedExecutionEligible,
    "execution_eligibility_mismatch",
  );
  check(handoff.applyExecuted === false, "real_apply_executed");
  check(handoff.registryWritten === false, "registry_written");
  check(handoff.rollbackPrepared === false, "rollback_prepared");
  check(repositoryClean(), "repository_not_clean_after_case");

  if (testCase.expectedApplicable) {
    check(handoff.configured === true, "handoff_not_configured");
    check(handoff.required === true, "handoff_not_required");
  } else {
    check(handoff.required === false, "blocked_route_handoff_required");
  }
  if (testCase.expectedBuilt) {
    check(typeof handoff.handoffHash === "string", "handoff_hash_missing");
    check(typeof handoff.consumptionKey === "string", "consumption_key_missing");
    check(handoff.externalConsumptionRegistryRequired === true,
      "external_registry_requirement_missing");
  }
  if (testCase.expectedStaleField) {
    check(
      Array.isArray(verification.staleFields) &&
        verification.staleFields.includes(testCase.expectedStaleField),
      "expected_stale_field_missing",
    );
  }
  if (testCase.expectedReason) {
    check(
      Array.isArray(verification.reasonCodes) &&
        verification.reasonCodes.includes(testCase.expectedReason),
      "expected_reason_missing",
    );
  }
  if (testCase.expectedIssue) {
    check(
      Array.isArray(handoff.issueCodes) &&
        handoff.issueCodes.includes(testCase.expectedIssue),
      "expected_issue_missing",
    );
  }

  return errors;
}

function resultFor(testCase, report, elapsedMs, errors) {
  return {
    name: testCase.name,
    scenario: testCase.scenario,
    success: errors.length === 0,
    errors,
    elapsedMs,
    status: report.status ?? null,
    workflowRoute: report.workflowRoute ?? null,
    handoffApplicable: report.controlledApplyHandoff?.applicable ?? null,
    handoffDecision: report.controlledApplyHandoff?.decision ?? null,
    handoffBuilt: report.controlledApplyHandoff?.handoffBuilt ?? false,
    verificationDecision:
      report.controlledApplyHandoffVerification?.decision ?? null,
    executionEligible:
      report.controlledApplyHandoffVerification?.executionEligible ?? false,
    applyExecuted: report.controlledApplyHandoff?.applyExecuted ?? false,
    registryWritten: report.controlledApplyHandoff?.registryWritten ?? false,
    rollbackPrepared: report.controlledApplyHandoff?.rollbackPrepared ?? false,
    staleFields: report.controlledApplyHandoffVerification?.staleFields ?? [],
    reasonCodes: report.controlledApplyHandoffVerification?.reasonCodes ?? [],
  };
}

function markdown(summary) {
  const rows = summary.results.map((entry) =>
    `| ${entry.name} | ${entry.success ? "PASS" : "FAIL"} | ${entry.workflowRoute ?? ""} | ${entry.handoffDecision ?? "not_applicable"} | ${entry.verificationDecision ?? "not_verified"} | ${entry.executionEligible} | ${entry.applyExecuted} |`,
  );
  return [
    "# Live Controlled Handoff Boundary",
    "",
    `- Stable: ${summary.stable}`,
    `- Passed: ${summary.passed}/${summary.total}`,
    `- Real apply executed: ${summary.realApplyExecuted}`,
    `- Registry written: ${summary.registryWritten}`,
    `- Rollback prepared: ${summary.rollbackPrepared}`,
    "",
    "| Case | Result | Route | Handoff | Verification | Execution eligible | Apply executed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "The suite stops at the verified handoff boundary. It performs no repository apply,",
    "does not reserve a consumption key, and does not prepare or execute rollback.",
    "",
  ].join("\n");
}

async function main() {
  if (!repositoryClean()) throw new Error("repository must be clean");
  await health(LLAMA_HEALTH, "llama-server");
  await health(CAPTURE_HEALTH, "capture-proxy");

  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, "runs"), { recursive: true });

  let proxy = null;
  try {
    try {
      await health(SCENARIO_HEALTH, "scenario-proxy");
    } catch {
      proxy = startScenarioProxy();
      await waitForHealth(SCENARIO_HEALTH, "scenario-proxy");
    }

    const orchestrator = require("./worker-backed-orchestrator-smoke.cjs");
    const target = targetSnapshot();
    const results = [];

    for (const testCase of CASES) {
      const outDir = path.join(BASE, "runs", testCase.name);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      configureCase(testCase, outDir, target);
      applyFixtureMutation(orchestrator, testCase);
      const started = Date.now();
      let report;
      try {
        report = await orchestrator.run();
      } finally {
        clearFixtureMutations(orchestrator);
      }
      const elapsedMs = Date.now() - started;
      const errors = validateCase(testCase, report);
      const result = resultFor(testCase, report, elapsedMs, errors);
      results.push(result);
      fs.writeFileSync(
        path.join(outDir, "boundary-case-summary.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.log(
        `[${result.success ? "PASS" : "FAIL"}] ${testCase.name} ` +
        `route=${result.workflowRoute ?? "none"} ` +
        `handoff=${result.handoffDecision ?? "not_applicable"} ` +
        `verification=${result.verificationDecision ?? "not_verified"}`,
      );
      if (!result.success) console.log(`  errors=${JSON.stringify(errors)}`);
    }

    const failed = results.filter((entry) => !entry.success);
    const summary = {
      stable: failed.length === 0,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      realApplyExecuted: results.some((entry) => entry.applyExecuted),
      registryWritten: results.some((entry) => entry.registryWritten),
      rollbackPrepared: results.some((entry) => entry.rollbackPrepared),
      target,
      results,
    };
    fs.writeFileSync(
      path.join(BASE, "controlled-handoff-boundary-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(BASE, "controlled-handoff-boundary-summary.md"),
      markdown(summary),
    );
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      summary.stable
        ? "LIVE_CONTROLLED_HANDOFF_BOUNDARY_PASSED"
        : "LIVE_CONTROLLED_HANDOFF_BOUNDARY_FAILED",
    );
    if (!summary.stable) process.exitCode = 1;
  } finally {
    clearOrchestratorEnvironment();
    if (proxy?.child) {
      proxy.child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        proxy.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      fs.closeSync(proxy.logFd);
    }
  }
}

main().catch((error) => {
  console.error("LIVE_CONTROLLED_HANDOFF_BOUNDARY_SCRIPT_ERROR");
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
