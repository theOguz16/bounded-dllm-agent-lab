const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "worker-backed-orchestrator-smoke.cjs");
const { decide, emptyRemaskReport } = require(scriptPath);

function runSmoke(env) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-orchestrator-smoke-"));
  const outDir = path.join(tempDir, "reports");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKER_ORCHESTRATOR_UPSTREAM_URL: "",
      WORKER_ORCHESTRATOR_OUT_DIR: outDir,
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
  const { result, report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.status, "skipped");
});

check("missing endpoint fails when WORKER_ORCHESTRATOR_REQUIRED=1", () => {
  const { result, report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "1" });

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, "failed_required_endpoint_missing");
});

check("script creates JSON and Markdown report", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.ok(fs.existsSync(report.jsonPath), report.jsonPath);
  assert.ok(fs.existsSync(report.markdownPath), report.markdownPath);

  const saved = JSON.parse(fs.readFileSync(report.jsonPath, "utf8"));
  const markdown = fs.readFileSync(report.markdownPath, "utf8");

  assert.equal(saved.jsonPath, report.jsonPath);
  assert.ok(markdown.includes("Worker-Backed Orchestrator Smoke"));
  assert.ok(markdown.includes("Status: skipped"));
  assert.ok(markdown.includes("Final decision: skipped"));
  assert.ok(markdown.includes("## Verifier"));
  assert.ok(markdown.includes("Verifier called: false"));
  assert.ok(markdown.includes("## Remask"));
  assert.ok(markdown.includes("Remask requested: false"));
});

check("skipped report has suiteName phase-p-worker-backed-orchestrator-smoke", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.suiteName, "phase-p-worker-backed-orchestrator-smoke");
});

check("skipped report has configured false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.configured, false);
});

check("no live network call is required", () => {
  const { result, report } = runSmoke({
    WORKER_ORCHESTRATOR_REQUIRED: "0",
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "1"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.configured, false);
  assert.equal(report.planner.latencyMs, null);
  assert.equal(report.coder.latencyMs, null);
});

check("skipped report has planner.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.planner.called, false);
});

check("skipped report has coder.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.coder.called, false);
});

check("skipped report has verifier.called false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.verifier.called, false);
});

check("skipped report has remask.called false and remask.requested false", () => {
  const { report } = runSmoke({ WORKER_ORCHESTRATOR_REQUIRED: "0" });

  assert.equal(report.remask.called, false);
  assert.equal(report.remask.requested, false);
});

check("planner validation failure maps to blocked_before_coder", () => {
  const decision = decide({ ok: false }, { ok: false });

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.match(decision.reason, /planner validation failure/);
});

check("planner validation failure has remask.called false", () => {
  const decision = decide({ ok: false }, { ok: false });
  const remask = emptyRemaskReport();

  assert.equal(decision.finalDecision, "blocked_before_coder");
  assert.equal(remask.called, false);
  assert.equal(decision.remaskRequested, undefined);
});

check("coder validation failure maps to blocked_before_verifier", () => {
  const decision = decide({ ok: true }, { ok: false });

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.match(decision.reason, /coder validation failure/);
});

check("coder validation failure has remask.called false", () => {
  const decision = decide({ ok: true }, { ok: false });
  const remask = emptyRemaskReport();

  assert.equal(decision.finalDecision, "blocked_before_verifier");
  assert.equal(remask.called, false);
  assert.equal(decision.remaskRequested, undefined);
});

check("approved verifier result maps to approved_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );

  assert.equal(decision.finalDecision, "approved_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "approve");
  assert.equal(decision.verifierIssueCount, 0);
});

check("approved verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "approve", issues: [] }
  );

  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, null);
});

check("needs_review verifier result maps to needs_review_by_deterministic_verifier without remask request", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "low_confidence", message: "low" }] }
  );

  assert.equal(decision.finalDecision, "needs_review_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "needs_review");
  assert.equal(decision.verifierIssueCount, 1);
});

check("needs_review repairable verifier result requests remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "low_confidence", message: "low" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    }
  );

  assert.equal(decision.remaskRequested, true);
  assert.equal(decision.remaskRepairability, "repairable");
});

check("needs_review repairable verifier result maps finalDecision to remask_requested", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "missing_proposed_patch", message: "missing" }] },
    {
      repairability: "repairable",
      remaskRequest: {
        role: "verifier",
        target: "remaskRequest",
        summary: "Request a bounded remask repair for coder patchDraft.",
        claims: [],
        touchedFiles: [],
        confidence: 1
      },
      issues: []
    }
  );

  assert.equal(decision.finalDecision, "remask_requested");
});

check("needs_review non-repairable verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "needs_review", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] },
    {
      repairability: "not_repairable",
      remaskRequest: null,
      issues: [{ code: "unsafe_or_forbidden_issue", message: "unsafe" }]
    }
  );

  assert.equal(decision.finalDecision, "needs_review_by_deterministic_verifier");
  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, "not_repairable");
});

check("rejected verifier result maps to rejected_by_deterministic_verifier", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );

  assert.equal(decision.finalDecision, "rejected_by_deterministic_verifier");
  assert.equal(decision.verifierDecision, "reject");
  assert.equal(decision.verifierIssueCount, 1);
});

check("rejected verifier result does not request remask", () => {
  const decision = decide(
    { ok: true },
    { ok: true },
    { decision: "reject", issues: [{ code: "unsafe_patch_content", message: "unsafe" }] }
  );

  assert.equal(decision.remaskRequested, false);
  assert.equal(decision.remaskRepairability, null);
});

console.log("worker-backed orchestrator smoke test passed");
