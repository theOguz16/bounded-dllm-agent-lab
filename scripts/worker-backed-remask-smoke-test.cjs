const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "worker-backed-remask-smoke.cjs");
const { checkRepairDraftMutation } = require(scriptPath);

function runSmoke(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-remask-smoke-"));
  const outDir = path.join(tempDir, "reports");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_REMASK_UPSTREAM_URL: "",
      WORKER_REMASK_OUT_DIR: outDir,
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
  const { result, report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("missing endpoint fails when WORKER_REMASK_REQUIRED=1", () => {
  const { result, report } = runSmoke({ WORKER_REMASK_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed_required_endpoint_missing");
});

check("script creates JSON and Markdown report", () => {
  const { report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);

  const saved = JSON.parse(fs.readFileSync(report.jsonPath, "utf8"));
  const markdown = fs.readFileSync(report.markdownPath, "utf8");

  assert.equal(saved.jsonPath, report.jsonPath);
  assert.ok(markdown.includes("Worker-Backed Remask Smoke"));
  assert.ok(markdown.includes("Status: skipped"));
  assert.ok(markdown.includes("RepairDraft checks OK: false"));
  assert.ok(markdown.includes("RepairDraft ProposedPatch Preview"));
});

check("skipped report has suiteName phase-r-worker-backed-remask-smoke", () => {
  const { report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-r-worker-backed-remask-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("no live network call is required", () => {
  const { result, report } = runSmoke({
    WORKER_REMASK_REQUIRED: "0",
    WORKER_REMASK_TIMEOUT_MS: "1"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.configured, false);
  assert.equal(report.latencyMs, null);
});

check("skipped report has validation.mutation null", () => {
  const { report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.equal(report.validation.mutation, null);
});

check("skipped report has repairDraftChecks.ok false safely", () => {
  const { report } = runSmoke({ WORKER_REMASK_REQUIRED: "0" });

  assert.equal(report.repairDraftChecks.ok, false);
  assert.deepEqual(report.repairDraftChecks.issues, []);
});

check("repairDraft checks accept valid local repairDraft shape", () => {
  const result = checkRepairDraftMutation({
    role: "remask",
    target: "repairDraft",
    summary: "Repair missing proposedPatch.",
    claims: [
      {
        type: "repair_draft",
        file: "packages/example/src/index.ts",
        description: "Add missing proposedPatch.",
        proposedPatch: "export function addOne(value: number): number { return value + 1; }",
        addressesIssueCodes: ["missing_proposed_patch"]
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

check("repairDraft checks reject missing addressed issue code", () => {
  const result = checkRepairDraftMutation({
    role: "remask",
    target: "repairDraft",
    summary: "Repair missing proposedPatch.",
    claims: [
      {
        type: "repair_draft",
        file: "packages/example/src/index.ts",
        description: "Add missing proposedPatch.",
        proposedPatch: "export function addOne(value: number): number { return value + 1; }",
        addressesIssueCodes: []
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing_addressed_issue_code"));
});

console.log("worker-backed remask smoke test passed");
