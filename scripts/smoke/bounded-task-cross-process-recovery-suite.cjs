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
const offlineOnly = process.env.BOUNDED_TASK_RECOVERY_OFFLINE_ONLY === "1";
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
    const replayResult = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(replayResult.receipt.receiptHash, receiptHash);
    assert.equal(replayResult.terminalCacheValidation.status, "current");
    assert.deepEqual(counts(counter), after);
    checks += 5; console.log(`[ok] ${crashState} kill/resume is idempotent`);
  }

  for (const usageMode of ["unavailable", "observed"]) {
    const base = path.join(root, `cost-budget-${usageMode}`);
    const workspace = path.join(base, "workspace"); const registry = path.join(base, "registry");
    const counter = path.join(base, "calls.log"); const output = path.join(base, "result.json");
    fs.mkdirSync(base, { recursive: true });
    const budget = { BOUNDED_TASK_WORKER_COST_MAX_CALLS: "1",
      ...(usageMode === "observed" ? { BOUNDED_TASK_WORKER_PROVIDER_USAGE: "observed" } : {}) };
    const crashed = run(workspace, registry, counter, output,
      { ...budget, BOUNDED_TASK_WORKER_CRASH_STATE: "planning_completed" });
    assert.equal(crashed.signal, "SIGKILL", `${usageMode}: ${crashed.stderr}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const before = counts(counter); assert.equal(before.planner, 1); assert.equal(before.coder ?? 0, 0);
    const resumed = run(workspace, registry, counter, output,
      { ...budget, BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_FORBID_PLANNER: "1" });
    assert.equal(resumed.status, 2, `${usageMode}: ${resumed.stderr}\n${resumed.stdout}`);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.failure.code, "task_cost_budget_exhausted");
    assert.equal(result.summary.costBudget.reservedProviderCalls, 1);
    assert.equal(result.summary.costBudget.reservations.length, 1);
    assert.equal(result.summary.costBudget.reconciliations.length, 1);
    assert.equal(result.summary.costBudget.reconciliations[0].usage.status, usageMode);
    if (usageMode === "observed") assert.equal(result.summary.costBudget.accountedTokens, 17);
    else assert.equal(result.summary.costBudget.accountedTokens,
      result.summary.costBudget.reservations[0].estimatedTokens);
    assert.deepEqual(counts(counter), before, "resume must start neither cached planner nor over-budget coder");
    checks += 10; console.log(`[ok] ${usageMode} provider cost survives process kill and blocks resume`);
  }

  {
    const base = path.join(root, "cost-budget-binding");
    const workspace = path.join(base, "workspace"); const registry = path.join(base, "registry");
    const counter = path.join(base, "calls.log"); const output = path.join(base, "result.json");
    fs.mkdirSync(base, { recursive: true });
    const crashed = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_COST_MAX_CALLS: "1", BOUNDED_TASK_WORKER_CRASH_STATE: "planning_completed"
    });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); const before = counts(counter);
    const resumed = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_FORBID_PLANNER: "1",
      BOUNDED_TASK_WORKER_FORBID_CODER: "1"
    });
    assert.equal(resumed.status, 2, resumed.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).failure.code,
      "bounded_task_state_resume_binding_mismatch");
    assert.deepEqual(counts(counter), before);
    checks += 4; console.log("[ok] resume cannot remove the original task cost budget");
  }

  {
    const base = path.join(root, "lease-takeover-crash"); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const ownerCrash = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_CRASH_STATE: "planning_started" });
    assert.equal(ownerCrash.signal, "SIGKILL", ownerCrash.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const takeoverCrash = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_CRASH_LEASE: "takeover_acquired" });
    assert.equal(takeoverCrash.signal, "SIGKILL", takeoverCrash.stderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const resumed = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_RESUME: "1" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).decision, "bounded_task_completed");
    const taskDirectory = path.join(registry, "tasks", fs.readdirSync(path.join(registry, "tasks"))[0]);
    assert.equal(fs.existsSync(path.join(taskDirectory, "lease-takeover")), false);
    checks += 5;
    console.log("[ok] a process killed during lease takeover does not permanently lock the task");
  }

  {
    const base = path.join(root, "terminal-content-drift"); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const first = run(workspace, registry, counter, output,
      { BOUNDED_TASK_WORKER_MODE: "git_draft" });
    assert.equal(first.status, 0, first.stderr); const historical = JSON.parse(fs.readFileSync(output, "utf8"));
    const before = counts(counter); const file = path.join(workspace, "src/service.ts");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
    const changed = "export function compute(value: number): number { return value * 99; }\n";
    const priorMode = fs.statSync(file).mode & 0o777; fs.writeFileSync(file, changed); fs.chmodSync(file, priorMode);
    const resumed = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_MODE: "git_draft",
      BOUNDED_TASK_WORKER_RESUME: "1",
      BOUNDED_TASK_WORKER_FORBID_PLANNER: "1", BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
    assert.equal(resumed.status, 2, resumed.stderr); const drift = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(drift.failure.code, "bounded_task_terminal_repository_drift");
    assert.equal(drift.receipt, null);
    assert.equal(drift.historicalReceipt.receiptHash, historical.receipt.receiptHash);
    assert.equal(drift.terminalCacheValidation.status, "repository_drift");
    assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim(), headBefore);
    assert.equal(fs.readFileSync(file, "utf8"), changed); assert.equal(fs.statSync(file).mode & 0o777, priorMode);
    assert.deepEqual(counts(counter), before); checks += 9;
    console.log("[ok] same-HEAD content drift invalidates terminal cache and preserves user content");
  }

  for (const terminalCase of [
    { name: "cancelled", extra: { BOUNDED_TASK_WORKER_PRE_CANCEL: "1" }, state: "human_review_required",
      code: "bounded_task_cancelled" },
    { name: "timeout", extra: { BOUNDED_TASK_WORKER_EXPIRED_DEADLINE: "1" }, state: "replan_required",
      code: "bounded_task_deadline_exceeded" },
    { name: "no-change", extra: { BOUNDED_TASK_WORKER_MODE: "no_change_draft" },
      state: "replan_required", code: "mutation_no_change" },
    { name: "recovery-required", extra: { BOUNDED_TASK_WORKER_MODE: "applied",
      BOUNDED_TASK_WORKER_FORCE_RECOVERY: "1" }, state: "recovery_required",
      code: "bounded_task_apply_not_completed" }
  ]) {
    const base = path.join(root, `terminal-${terminalCase.name}`);
    const workspace = path.join(base, "workspace"); const registry = path.join(base, "registry");
    const counter = path.join(base, "calls.log"); const output = path.join(base, "result.json");
    fs.mkdirSync(base, { recursive: true });
    const first = run(workspace, registry, counter, output, terminalCase.extra);
    assert.equal(first.status, 2, `${terminalCase.name}: ${first.stderr}`);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.failure.code, terminalCase.code);
    const before = counts(counter);
    const taskDirectory = path.join(registry, "tasks", fs.readdirSync(path.join(registry, "tasks"))[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(taskDirectory, "state.json"), "utf8")).currentState,
      terminalCase.state);
    const replay = run(workspace, registry, counter, output,
      { ...terminalCase.extra, BOUNDED_TASK_WORKER_RESUME: "1",
        BOUNDED_TASK_WORKER_FORBID_PLANNER: "1", BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
    assert.equal(replay.status, 2, replay.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).failure.code, terminalCase.code);
    assert.deepEqual(counts(counter), before);
    checks += 6;
    console.log(`[ok] ${terminalCase.name} outcome is durable and replayed without providers`);
  }

  {
    const base = path.join(root, "task-context-binding"); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const first = run(workspace, registry, counter, output);
    assert.equal(first.status, 0, first.stderr); const before = counts(counter);
    const mismatch = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_RESUME: "1",
      BOUNDED_TASK_WORKER_TASK_CONTEXT: "Changed trusted context with the same objective." });
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).failure.code,
      "bounded_task_state_resume_binding_mismatch");
    assert.deepEqual(counts(counter), before); checks += 4;
    console.log("[ok] changed task context cannot replay a terminal result");
  }
  if (!offlineOnly) for (const crashState of ["phase_v_container_created", "governed_apply_started",
    "x4_committed", "validation_started", "validation_completed", "finalized"]) {
    const base = path.join(root, `governed-${crashState}`); const workspace = path.join(base, "workspace");
    const registry = path.join(base, "task-registry"); const counter = path.join(base, "calls.log");
    const output = path.join(base, "result.json"); fs.mkdirSync(base, { recursive: true });
    const crashed = run(workspace, registry, counter, output, {
      BOUNDED_TASK_WORKER_MODE: "governed",
      ...(crashState === "phase_v_container_created"
        ? { BOUNDED_TASK_WORKER_CRASH_ARTIFACT: crashState }
        : { BOUNDED_TASK_WORKER_CRASH_STATE: crashState }) });
    assert.equal(crashed.signal, "SIGKILL", `${crashState}: ${crashed.stderr}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    let phaseVOrphan = null;
    if (crashState === "phase_v_container_created") {
      const taskDirectory = path.join(registry, "tasks", fs.readdirSync(path.join(registry, "tasks"))[0]);
      const artifacts = path.join(taskDirectory, "artifacts");
      const preparedFile = fs.readdirSync(artifacts).find((name) => name.startsWith("phase_v_prepared-"));
      const createdFile = fs.readdirSync(artifacts).find((name) => name.startsWith("phase_v_container_created-"));
      const intent = JSON.parse(fs.readFileSync(path.join(artifacts, preparedFile), "utf8"));
      const created = JSON.parse(fs.readFileSync(path.join(artifacts, createdFile), "utf8"));
      phaseVOrphan = { workspacePath: intent.workspacePath,
        containerId: created.containerLifecycle.containerId };
      assert.equal(fs.existsSync(phaseVOrphan.workspacePath), true);
      assert.equal(spawnSync("docker", ["container", "inspect", phaseVOrphan.containerId],
        { encoding: "utf8" }).status, 0);
    }
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
      const taskDirectory = fs.readdirSync(path.join(registry, "tasks"))
        .map((name) => path.join(registry, "tasks", name))[0];
      const preparedFile = fs.readdirSync(path.join(taskDirectory, "artifacts"))
        .find((name) => name.startsWith("governed_apply_prepared-"));
      const prepared = JSON.parse(fs.readFileSync(
        path.join(taskDirectory, "artifacts", preparedFile), "utf8"));
      assert.equal(result.receipt.acceptanceContractHash,
        prepared.acceptanceCriteriaContract.contractHash);
      assert.equal(result.receipt.validationSpecificationHash,
        prepared.phaseVExecutionVerification.validationSpecificationHash);
      assert.equal(result.receipt.validationEvidence.profile, "structural_draft");
      assert.equal(result.receipt.validationEvidence.checks.find((check) =>
        check.kind === "behavior_test").status, "passed");
      assert.equal(prepared.acceptanceEvaluation.receipt.contractHash,
        prepared.acceptanceCriteriaContract.contractHash);
      assert.equal(prepared.acceptanceEvaluation.receipt.validationSpecificationHash,
        prepared.phaseVExecutionVerification.validationSpecificationHash);
      const durableState = JSON.parse(fs.readFileSync(path.join(taskDirectory, "state.json"), "utf8"));
      assert.equal(result.receipt.acceptanceEvaluationReceiptHash,
        durableState.acceptanceEvaluationReceiptHash);
      const receiptHash = result.receipt.receiptHash;
      const replay = run(workspace, registry, counter, output, { BOUNDED_TASK_WORKER_MODE: "governed",
        BOUNDED_TASK_WORKER_RESUME: "1", BOUNDED_TASK_WORKER_FORBID_PLANNER: "1",
        BOUNDED_TASK_WORKER_FORBID_CODER: "1" });
      assert.equal(replay.status, 0); const replayResult = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(replayResult.receipt.receiptHash, receiptHash);
      assert.equal(replayResult.terminalCacheValidation.status, "current");
      assert.deepEqual(counts(counter), before);
      assert.match(fs.readFileSync(path.join(workspace, "src/service.ts"), "utf8"), /value \* 3/);
      if (phaseVOrphan) {
        assert.equal(fs.existsSync(phaseVOrphan.workspacePath), false);
        assert.notEqual(spawnSync("docker", ["container", "inspect", phaseVOrphan.containerId],
          { encoding: "utf8" }).status, 0);
        checks += 4;
      }
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
