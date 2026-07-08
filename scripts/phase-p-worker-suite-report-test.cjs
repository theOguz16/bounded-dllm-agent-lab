const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "phase-p-worker-suite-report.cjs");

function runSuite(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-p-worker-suite-"));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PHASE_P_WORKER_UPSTREAM_URL: "",
      PHASE_P_WORKER_SUITE_OUT_DIR: path.join(tempDir, "suite"),
      WORKER_PLANNER_UPSTREAM_URL: "",
      WORKER_CODER_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      WORKER_PLANNER_OUT_DIR: path.join(tempDir, "planner"),
      WORKER_CODER_OUT_DIR: path.join(tempDir, "coder"),
      WORKER_ORCHESTRATOR_OUT_DIR: path.join(tempDir, "orchestrator"),
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
  const { result, report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
});

check("suite creates JSON and Markdown report", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);
  assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("Phase P Worker Suite Report"));
});

check("suiteName is phase-p-worker-suite-report", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-suite-report");
});

check("configured false when no endpoint is provided", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("status is skipped or partial and ok true in non-required mode", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.ok(["skipped", "partial"].includes(report.status), report.status);
  assert.equal(report.ok, true);
});

check("children exist", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.ok(report.children.planner);
  assert.ok(report.children.coder);
  assert.ok(report.children.orchestrator);
});

check("readyForRunPodLiveValidation is false when no endpoint is configured", () => {
  const { report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "0" });

  assert.equal(report.summary.readyForRunPodLiveValidation, false);
});

check("required mode fails when no endpoint is configured", () => {
  const { result, report } = runSuite({ PHASE_P_WORKER_SUITE_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
});

console.log("phase-p worker suite report test passed");
