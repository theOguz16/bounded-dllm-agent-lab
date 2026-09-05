#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repository = path.resolve(__dirname, "../..");
const worker = path.join(repository, "scripts/run-bounded-task-smoke.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-task-cross-process-"));
const run = (workspace, registry, counter, output, extra = {}) => spawnSync(process.execPath, [worker], {
  cwd: repository, encoding: "utf8", env: { ...process.env, BOUNDED_TASK_STATE_WORKER: "1",
    BOUNDED_TASK_WORKER_REPO: workspace, BOUNDED_TASK_WORKER_REGISTRY: registry,
    BOUNDED_TASK_WORKER_COUNTER: counter, BOUNDED_TASK_WORKER_OUTPUT: output,
    BOUNDED_TASK_WORKER_LEASE_MS: "90", ...extra }
});
const counts = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n")
  .filter(Boolean).reduce((all, item) => ({ ...all, [item]: (all[item] ?? 0) + 1 }), {}) : {};
let checks = 0;
try {
  for (const crashState of ["planning_started", "planning_completed", "coding_started",
    "coding_completed", "mutation_verified", "finalized"]) {
    const base = path.join(root, crashState); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const crashed = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_CRASH_STATE: crashState });
    assert.equal(crashed.signal, "SIGKILL", `${crashState}: ${crashed.stderr}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const before = counts(counter);
    const resumed = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_RESUME: "1",
        BOUNDED_TASK_WORKER_FORBID_PLANNER: crashState !== "planning_started" ? "1" : "0",
        BOUNDED_TASK_WORKER_FORBID_CODER:
          ["coding_completed", "mutation_verified", "finalized"].includes(crashState) ? "1" : "0" });
    assert.equal(resumed.status, 0, `${crashState}: ${resumed.stderr}\n${resumed.stdout}`);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.decision, "bounded_task_completed");
    const after = counts(counter);
    if (["planning_completed", "coding_completed", "mutation_verified", "finalized"].includes(crashState)) {
      assert.equal(after.planner, before.planner, `${crashState} planner replay`);
    }
    if (["coding_completed", "mutation_verified", "finalized"].includes(crashState)) {
      assert.equal(after.coder, before.coder, `${crashState} coder replay`);
    }
    const receiptHash = result.receipt.receiptHash;
    const replay = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_FORBID_PLANNER: "1",
        BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
    assert.equal(replay.status, 0, `${crashState} replay: ${replay.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).receipt.receiptHash, receiptHash);
    assert.deepEqual(counts(counter), after);
    checks += 5; console.log(`[ok] ${crashState} kill/resume is idempotent`);
  }
  for (const crashState of ["governed_apply_started", "x4_committed", "validation_started",
    "validation_completed", "finalized"]) {
    const base = path.join(root, `governed-${crashState}`); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "task-registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const crashed = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_MODE: "governed", BOUNDED_TASK_WORKER_CRASH_STATE: crashState });
    assert.equal(crashed.signal, "SIGKILL", `${crashState}: ${crashed.stderr}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const before = counts(counter);
    const resumed = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_MODE: "governed", BOUNDED_TASK_WORKER_RESUME: "1",
      BOUNDED_TASK_WORKER_FORBID_PLANNER: "1", BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(counts(counter), before);
    if (crashState === "governed_apply_started") {
      assert.equal(result.route, "recovery_required");
      assert.match(fs.readFileSync(path.join(workspace, "src/service.ts"), "utf8"), /value \* 2/);
    } else {
      assert.equal(resumed.status, 0, `${crashState}: ${resumed.stderr}\n${resumed.stdout}`);
      assert.equal(result.decision, "bounded_task_completed");
      assert.match(fs.readFileSync(path.join(workspace, "src/service.ts"), "utf8"), /value \* 3/);
      const receiptHash = result.receipt.receiptHash;
      const replay = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_MODE: "governed",
        BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_FORBID_PLANNER: "1",
        BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
      assert.equal(replay.status, 0); assert.equal(JSON.parse(fs.readFileSync(output, "utf8"))
        .receipt.receiptHash, receiptHash);
    }
    checks += 5; console.log(`[ok] ${crashState} governed recovery is bounded`);
  }

  {
    const base = path.join(root, "objective-binding"); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const first = run(workspace, registry, counter, output);
    assert.equal(first.status, 0, first.stderr); const before = counts(counter);
    const mismatch = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_RESUME: "1",
      BOUNDED_TASK_WORKER_OBJECTIVE: "A different objective using the same durable key." });
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).failure.code,
      "bounded_task_state_resume_binding_mismatch");
    assert.deepEqual(counts(counter), before); checks += 4;
    console.log("[ok] changed objective cannot replay a terminal result");
  }

  {
    const base = path.join(root, "validation-binding"); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const crashed = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_MODE: "governed",
      BOUNDED_TASK_WORKER_CRASH_STATE: "planning_started" });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); const before = counts(counter);
    const mismatch = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_MODE: "governed",
      BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_VALIDATION_PREFIX: "// changed validation\n" });
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).failure.code,
      "bounded_task_state_resume_binding_mismatch");
    assert.deepEqual(counts(counter), before); checks += 4;
    console.log("[ok] changed validation specification cannot resume the durable task");
  }

  for (const idempotent of [false, true]) {
    const suffix = idempotent ? "idempotent" : "non-idempotent";
    const base = path.join(root, `provider-${suffix}`); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const mode = idempotent ? { BOUNDED_TASK_WORKER_IDEMPOTENT: "1" } : {};
    const crashed = run(workspace, registry, counter, output,
      { ...mode, BOUNDED_TASK_WORKER_CRASH_PROVIDER: "planner:response_received" });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); const before = counts(counter);
    assert.equal(before.planner, 1);
    const resumed = run(workspace, registry, counter, output, { ...mode, BOUNDED_TASK_WORKER_RESUME: "1" });
    const result = JSON.parse(fs.readFileSync(output, "utf8")); const after = counts(counter);
    const keys = Object.keys(after).filter((key) => key.startsWith("planner-key:"));
    assert.equal(keys.length, 1, "provider retries must retain one stable idempotency key");
    if (idempotent) {
      assert.equal(resumed.status, 0, resumed.stderr); assert.equal(result.decision, "bounded_task_completed");
      assert.equal(after.planner, 2); assert.equal(after[keys[0]], 2);
    } else {
      assert.equal(resumed.status, 2, resumed.stderr); assert.equal(result.route, "recovery_required");
      assert.equal(result.failure.code, "provider_outcome_ambiguous"); assert.equal(after.planner, 1);
    }
    checks += 6; console.log(`[ok] ${suffix} provider crash has bounded retry behavior`);
  }
  console.log(`bounded task cross-process recovery passed (${checks} assertions)`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
