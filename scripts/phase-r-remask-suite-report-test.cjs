const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "phase-r-remask-suite-report.cjs");
const { buildSummary, buildWorkerEnv } = require(scriptPath);

function runSuite(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-r-remask-suite-"));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_R_REMASK_SUITE_REQUIRED: "0",
      PHASE_R_WORKER_UPSTREAM_URL: "",
      WORKER_REMASK_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      ...env
    },
    encoding: "utf8"
  });
  const report = JSON.parse(result.stdout);

  return {
    result,
    report,
    tempDir
  };
}

function syntheticChildren(finalDecision, overrides = {}) {
  return {
    remaskRequestBuilder: {
      command: "npm run test:remask-request-builder",
      exitCode: 0,
      ok: true
    },
    remaskWorker: {
      command: "npm run worker:remask-smoke",
      exitCode: 0,
      reportPath: "reports/worker-backed-remask-smoke/synthetic.json",
      status: "completed",
      ok: true,
      configured: true,
      validationOk: true,
      blocked: false,
      repairDraftChecksOk: true,
      issueCount: 0,
      latencyMs: 1,
      ...overrides.remaskWorker
    },
    orchestrator: {
      command: "npm run worker:orchestrator-smoke",
      exitCode: 0,
      reportPath: "reports/worker-backed-orchestrator-smoke/synthetic.json",
      status: "completed",
      ok: true,
      configured: true,
      finalDecision,
      plannerValidationOk: true,
      coderValidationOk: true,
      verifierCalled: true,
      verifierDecision: finalDecision === "approved_by_deterministic_verifier" ? "approve" : "needs_review",
      verifierIssueCount: finalDecision === "approved_by_deterministic_verifier" ? 0 : 1,
      remaskRequested: false,
      remaskRepairability: null,
      remaskValidationOk: null,
      repairDraftChecksOk: null,
      ...overrides.orchestrator
    }
  };
}

function check(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

check("suite runs with no endpoint", () => {
  const { result, report } = runSuite({});

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("suite creates JSON and Markdown report", () => {
  const { report } = runSuite({});

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);
  assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("Phase R Remask Suite Report"));
});

check("suiteName is phase-r-remask-suite-report", () => {
  const { report } = runSuite({});

  assert.equal(report.suiteName, "phase-r-remask-suite-report");
});

check("configured false when no endpoint is provided", () => {
  const { report } = runSuite({});

  assert.equal(report.configured, false);
});

check("remaskRequestBuilder child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.remaskRequestBuilder);
  assert.equal(report.children.remaskRequestBuilder.command, "npm run test:remask-request-builder");
});

check("remaskWorker child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.remaskWorker);
  assert.equal(report.children.remaskWorker.command, "npm run worker:remask-smoke");
});

check("orchestrator child exists", () => {
  const { report } = runSuite({});

  assert.ok(report.children.orchestrator);
  assert.equal(report.children.orchestrator.command, "npm run worker:orchestrator-smoke");
});

check("readyForRunPodLiveValidation is false when no endpoint is configured", () => {
  const { report } = runSuite({});

  assert.equal(report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails when no endpoint is configured", () => {
  const { result, report } = runSuite({ PHASE_R_REMASK_SUITE_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

check("shared Phase R worker env maps to remask and orchestrator env", () => {
  const env = buildWorkerEnv(
    {
      PHASE_R_WORKER_UPSTREAM_URL: "http://127.0.0.1:9999/v1/chat/completions",
      PHASE_R_WORKER_MODEL_ID: "qwen-remask-test",
      PHASE_R_WORKER_TIMEOUT_MS: "12345"
    },
    true
  );

  assert.equal(env.WORKER_REMASK_UPSTREAM_URL, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(env.WORKER_REMASK_MODEL_ID, "qwen-remask-test");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "qwen-remask-test");
  assert.equal(env.WORKER_REMASK_TIMEOUT_MS, "12345");
  assert.equal(env.WORKER_ORCHESTRATOR_TIMEOUT_MS, "12345");
  assert.equal(env.WORKER_REMASK_REQUIRED, "1");
  assert.equal(env.WORKER_ORCHESTRATOR_REQUIRED, "1");
});

check("shared Phase R worker env does not override existing worker env", () => {
  const env = buildWorkerEnv(
    {
      PHASE_R_WORKER_UPSTREAM_URL: "http://shared.example/v1/chat/completions",
      PHASE_R_WORKER_MODEL_ID: "shared-model",
      PHASE_R_WORKER_TIMEOUT_MS: "12345",
      WORKER_REMASK_UPSTREAM_URL: "http://remask.example/v1/chat/completions",
      WORKER_ORCHESTRATOR_MODEL_ID: "orchestrator-model"
    },
    false
  );

  assert.equal(env.WORKER_REMASK_UPSTREAM_URL, "http://remask.example/v1/chat/completions");
  assert.equal(env.WORKER_ORCHESTRATOR_UPSTREAM_URL, "http://shared.example/v1/chat/completions");
  assert.equal(env.WORKER_REMASK_MODEL_ID, "shared-model");
  assert.equal(env.WORKER_ORCHESTRATOR_MODEL_ID, "orchestrator-model");
});

check("synthetic completed configured approve path is ready for live validation", () => {
  const summary = buildSummary(
    syntheticChildren("approved_by_deterministic_verifier", {
      orchestrator: {
        verifierDecision: "approve",
        remaskRequested: false
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.remaskRequested, false);
  assert.equal(summary.remaskSupported, true);
});

check("approve path does not require remaskRequested true", () => {
  const summary = buildSummary(
    syntheticChildren("approved_by_deterministic_verifier", {
      orchestrator: {
        verifierDecision: "approve",
        remaskRequested: false
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.remaskRequested, false);
});

check("synthetic completed configured repair_draft_ready path is ready for live validation", () => {
  const summary = buildSummary(
    syntheticChildren("repair_draft_ready", {
      orchestrator: {
        verifierDecision: "needs_review",
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.repairDraftReady, true);
});

check("repair_draft_ready path includes remaskRequested true and repairDraftChecksOk true", () => {
  const summary = buildSummary(
    syntheticChildren("repair_draft_ready", {
      orchestrator: {
        verifierDecision: "needs_review",
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: true,
        repairDraftChecksOk: true
      }
    }),
    true
  );

  assert.equal(summary.remaskRequested, true);
  assert.equal(summary.repairDraftReady, true);
  assert.equal(summary.readyForRunPodLiveValidation, true);
});

check("synthetic completed configured remask_repair_failed path is ready for live validation", () => {
  const summary = buildSummary(
    syntheticChildren("remask_repair_failed", {
      orchestrator: {
        verifierDecision: "needs_review",
        remaskRequested: true,
        remaskRepairability: "repairable",
        remaskValidationOk: false,
        repairDraftChecksOk: false
      }
    }),
    true
  );

  assert.equal(summary.readyForRunPodLiveValidation, true);
  assert.equal(summary.remaskRepairFailed, true);
});

console.log("phase-r remask suite report test passed");
