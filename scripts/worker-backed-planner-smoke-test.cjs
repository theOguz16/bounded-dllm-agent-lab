const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "worker-backed-planner-smoke.cjs");

function runSmoke(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-planner-smoke-"));
  const outDir = path.join(tempDir, "reports");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_PLANNER_UPSTREAM_URL: "",
      WORKER_PLANNER_OUT_DIR: outDir,
      ...env
    },
    encoding: "utf8"
  });

  const report = JSON.parse(result.stdout);

  return {
    result,
    report,
    outDir
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

check("missing endpoint produces skipped report by default", () => {
  const { result, report } = runSmoke({ WORKER_PLANNER_REQUIRED: "0" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("missing endpoint fails when WORKER_PLANNER_REQUIRED=1", () => {
  const { result, report } = runSmoke({ WORKER_PLANNER_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed_required_endpoint_missing");
});

check("script creates JSON and Markdown report", () => {
  const { report } = runSmoke({ WORKER_PLANNER_REQUIRED: "0" });

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);

  const saved = JSON.parse(fs.readFileSync(report.jsonPath, "utf8"));
  const markdown = fs.readFileSync(report.markdownPath, "utf8");

  assert.equal(saved.jsonPath, report.jsonPath);
  assert.ok(markdown.includes("Worker-Backed Planner Smoke"));
  assert.ok(markdown.includes("Status: skipped"));
});

check("skipped report has suiteName phase-p-worker-backed-planner-smoke", () => {
  const { report } = runSmoke({ WORKER_PLANNER_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-backed-planner-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_PLANNER_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("no live network call is required", () => {
  const { result, report } = runSmoke({
    WORKER_PLANNER_REQUIRED: "0",
    WORKER_PLANNER_TIMEOUT_MS: "1"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.configured, false);
  assert.equal(report.latencyMs, null);
});

console.log("worker-backed planner smoke test passed");
