#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.env.BOUNDED_LEASE_HOLDER === "1") {
  (async () => {
    const runtime = await import("../../dist/packages/product-runtime/src/canonical-runtime.js");
    const hash = (name) => runtime.hashCanonicalJson({ name });
    const session = new runtime.BoundedTaskStateSession({ registryRoot: process.env.LEASE_REGISTRY,
      idempotencyKey: process.env.LEASE_KEY, leaseTimeoutMs: 90 }, {
      taskId: process.env.LEASE_TASK, repositoryPath: process.env.LEASE_REPO,
      repositoryIdentityHash: hash("repository"), baselineSnapshotHash: hash("snapshot"),
      baselineHeadHash: hash("head"), compiledPolicyHash: hash("policy"), taskInputHash: hash("input") });
    session.advance("planning_started");
    process.stdout.write("ready\n");
    setInterval(() => {}, 1_000);
  })().catch((error) => { console.error(error.code || error); process.exit(1); });
  return;
}

(async () => {
  const runtime = await import("../../dist/packages/product-runtime/src/canonical-runtime.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-smoke-"));
  const repo = path.join(root, "repo"); const registry = path.join(root, "registry");
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  const hash = (name) => runtime.hashCanonicalJson({ name });
  const identity = (taskId = "task.state") => ({ taskId, repositoryPath: repo,
    repositoryIdentityHash: hash("repository"), baselineSnapshotHash: hash("snapshot"),
    baselineHeadHash: hash("head"), compiledPolicyHash: hash("policy"), taskInputHash: hash("input") });
  const config = (idempotencyKey = "idem.state") => ({ registryRoot: registry, idempotencyKey });
  let checks = 0; const check = (name, fn) => { fn(); checks++; console.log(`[ok] ${name}`); };
  try {
    const first = new runtime.BoundedTaskStateSession(config(), identity());
    check("state starts with a hashed received record and private modes", () => {
      assert.equal(first.snapshot.currentState, "received");
      assert.match(first.snapshot.stateHash, /^sha256:/);
      assert.equal(fs.statSync(registry).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(first.taskDirectory, "state.json")).mode & 0o777, 0o600);
    });
    check("invalid skipped and backward transitions are rejected", () => {
      assert.throws(() => first.transition("coding_started"), (e) => e.code === "bounded_task_state_transition_invalid");
      first.transition("planning_started");
      assert.throws(() => first.transition("received"), (e) => e.code === "bounded_task_state_transition_invalid");
    });
    check("an active lease has exactly one owner", () => {
      assert.throws(() => new runtime.BoundedTaskStateSession(config(), identity()),
        (e) => e.code === "bounded_task_already_running");
    });
    const artifact = first.writeArtifact("provider-test", { response: { ok: true } });
    check("artifact is private and hash verified", () => {
      assert.deepEqual(first.readArtifact(artifact), { response: { ok: true } });
      assert.equal(fs.statSync(path.join(first.taskDirectory, artifact.relativePath)).mode & 0o777, 0o600);
    });
    first.finalize("finalized", { receipt: "stable" });
    check("terminal state is immutable", () => assert.throws(() => first.transition("failed"),
      (e) => e.code === "bounded_task_terminal_state_immutable"));
    first.release();
    const replay = new runtime.BoundedTaskStateSession({ ...config(), resume: true }, identity());
    check("terminal artifact replays exactly", () => assert.deepEqual(replay.terminalResult(), { receipt: "stable" }));
    replay.release();

    check("missing resume state fails closed", () => assert.throws(() =>
      new runtime.BoundedTaskStateSession({ ...config("missing"), resume: true }, identity("task.missing")),
      (e) => e.code === "bounded_task_state_missing"));

    const tamper = new runtime.BoundedTaskStateSession(config("tamper"), identity("task.tamper"));
    const tamperRef = tamper.writeArtifact("payload", { safe: true }); tamper.release();
    fs.writeFileSync(path.join(tamper.taskDirectory, tamperRef.relativePath), JSON.stringify({ safe: false }));
    check("tampered artifact fails closed", () => assert.throws(() => tamper.readArtifact(tamperRef),
      (e) => e.code === "bounded_task_artifact_hash_mismatch"));

    const corrupt = new runtime.BoundedTaskStateSession(config("corrupt"), identity("task.corrupt"));
    const corruptState = path.join(corrupt.taskDirectory, "state.json"); corrupt.release();
    fs.writeFileSync(corruptState, "{\"");
    check("truncated state fails closed", () => assert.throws(() => runtime.readDurableBoundedTaskState({
      registryRoot: registry, taskId: "task.corrupt", idempotencyKey: "corrupt" }),
      (e) => e.code === "bounded_task_state_corrupt"));

    const symlink = new runtime.BoundedTaskStateSession(config("symlink"), identity("task.symlink"));
    const stateFile = path.join(symlink.taskDirectory, "state.json"); symlink.release();
    const saved = `${stateFile}.saved`; fs.renameSync(stateFile, saved); fs.symlinkSync(saved, stateFile);
    check("symlink state fails closed", () => assert.throws(() => runtime.readDurableBoundedTaskState({
      registryRoot: registry, taskId: "task.symlink", idempotencyKey: "symlink" }),
      (e) => e.code === "bounded_task_state_symlink"));

    const mismatch = new runtime.BoundedTaskStateSession(config("mismatch"), identity("task.mismatch")); mismatch.release();
    check("repository/policy binding drift fails closed without leaking the lease", () => {
      assert.throws(() => new runtime.BoundedTaskStateSession({ ...config("mismatch"), resume: true },
        { ...identity("task.mismatch"), compiledPolicyHash: hash("changed") }),
      (e) => e.code === "bounded_task_state_resume_binding_mismatch");
      const afterMismatch = new runtime.BoundedTaskStateSession(
        { ...config("mismatch"), resume: true }, identity("task.mismatch"));
      afterMismatch.release();
    });

    const oversized = new runtime.BoundedTaskStateSession(config("oversized"), identity("task.oversized"));
    const oversizedState = path.join(oversized.taskDirectory, "state.json"); oversized.release();
    fs.writeFileSync(oversizedState, "x".repeat(runtime.BOUNDED_TASK_STATE_MAX_BYTES + 1));
    check("oversized state fails closed", () => assert.throws(() => runtime.readDurableBoundedTaskState({
      registryRoot: registry, taskId: "task.oversized", idempotencyKey: "oversized" }),
      (e) => e.code === "bounded_task_state_oversized"));

    const largeArtifact = new runtime.BoundedTaskStateSession(config("large-artifact"), identity("task.large"));
    check("oversized artifact is rejected", () => assert.throws(() => largeArtifact.writeArtifact(
      "payload", { value: "x".repeat(runtime.BOUNDED_TASK_ARTIFACT_MAX_BYTES) }),
      (e) => e.code === "bounded_task_artifact_oversized"));
    largeArtifact.release();

    const stale = new runtime.BoundedTaskStateSession({ ...config("stale"), leaseTimeoutMs: 60 }, identity("task.stale"));
    stale.transition("planning_started");
    const old = new Date(Date.now() - 10_000); fs.utimesSync(path.join(stale.taskDirectory, "lease"), old, old);
    check("a live owner cannot be displaced by backdating the lease directory", () => assert.throws(() =>
      new runtime.BoundedTaskStateSession({ ...config("stale"), resume: true, leaseTimeoutMs: 60 },
        identity("task.stale")), (e) => e.code === "bounded_task_already_running"));
    stale.release();

    const deadTask = "task.dead-owner"; const deadKey = "dead-owner";
    const holder = spawn(process.execPath, [__filename], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BOUNDED_LEASE_HOLDER: "1", LEASE_REGISTRY: registry,
        LEASE_REPO: repo, LEASE_TASK: deadTask, LEASE_KEY: deadKey } });
    await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("error", reject); });
    holder.kill("SIGKILL"); await new Promise((resolve) => holder.once("exit", resolve));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const resumedDead = new runtime.BoundedTaskStateSession({ ...config(deadKey), resume: true,
      leaseTimeoutMs: 90 }, identity(deadTask));
    check("a verified task can take over after its process owner is killed", () =>
      assert.equal(resumedDead.snapshot.currentState, "planning_started"));
    resumedDead.release();

    const nonceGuard = new runtime.BoundedTaskStateSession(config("nonce-guard"), identity("task.nonce-guard"));
    const leasePath = path.join(nonceGuard.taskDirectory, "lease");
    const ownerPath = path.join(leasePath, "owner.json"); const replacedOwner = JSON.parse(fs.readFileSync(ownerPath));
    replacedOwner.runId = "run-replacement"; replacedOwner.ownerNonce = "a".repeat(48);
    fs.writeFileSync(ownerPath, JSON.stringify(replacedOwner)); nonceGuard.release();
    check("an old owner cannot release a replacement owner's lease", () => assert.equal(fs.existsSync(leasePath), true));
    fs.rmSync(leasePath, { recursive: true, force: true });

    const malformed = new runtime.BoundedTaskStateSession(config("missing-input"), identity("task.missing-input"));
    const malformedPath = path.join(malformed.taskDirectory, "state.json"); malformed.release();
    const malformedState = JSON.parse(fs.readFileSync(malformedPath)); delete malformedState.taskInputHash;
    const { stateHash: ignored, ...malformedCore } = malformedState;
    malformedState.stateHash = runtime.hashCanonicalJson(malformedCore); fs.writeFileSync(malformedPath, JSON.stringify(malformedState));
    check("missing taskInputHash fails closed even with a recomputed state hash", () => assert.throws(() =>
      runtime.readDurableBoundedTaskState({ registryRoot: registry, taskId: "task.missing-input",
        idempotencyKey: "missing-input" }), (e) => e.code === "bounded_task_state_corrupt"));

    for (const [key, task, mutate] of [
      ["bad-lease", "task.bad-lease", (state) => { state.leaseOwner.ownerNonceHash = "bad"; }],
      ["bad-provider", "task.bad-provider", (state) => { state.providerIntent = { providerKind: "planner",
        requestHash: hash("request"), providerIdempotencyKey: hash("provider-key"), attempt: 0,
        status: "started", responseHash: null }; }]
    ]) {
      const malformedRecord = new runtime.BoundedTaskStateSession(config(key), identity(task));
      const file = path.join(malformedRecord.taskDirectory, "state.json"); malformedRecord.release();
      const state = JSON.parse(fs.readFileSync(file)); mutate(state); const { stateHash: oldHash, ...core } = state;
      state.stateHash = runtime.hashCanonicalJson(core); fs.writeFileSync(file, JSON.stringify(state));
      check(`${key} durable field fails closed`, () => assert.throws(() => runtime.readDurableBoundedTaskState({
        registryRoot: registry, taskId: task, idempotencyKey: key }),
      (e) => e.code === "bounded_task_state_corrupt"));
    }

    const hashTamper = new runtime.BoundedTaskStateSession(config("hash-tamper"), identity("task.hash-tamper"));
    const hashTamperPath = path.join(hashTamper.taskDirectory, "state.json"); hashTamper.release();
    const hashTamperState = JSON.parse(fs.readFileSync(hashTamperPath)); hashTamperState.updatedAt = new Date(0).toISOString();
    fs.writeFileSync(hashTamperPath, JSON.stringify(hashTamperState));
    check("state hash tampering fails closed", () => assert.throws(() => runtime.readDurableBoundedTaskState({
      registryRoot: registry, taskId: "task.hash-tamper", idempotencyKey: "hash-tamper" }),
    (e) => e.code === "bounded_task_state_hash_mismatch"));

    const raceTask = "task.takeover-race"; const raceKey = "takeover-race";
    const raceEnv = { ...process.env, BOUNDED_LEASE_HOLDER: "1", LEASE_REGISTRY: registry,
      LEASE_REPO: repo, LEASE_TASK: raceTask, LEASE_KEY: raceKey };
    const original = spawn(process.execPath, [__filename], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: raceEnv });
    await new Promise((resolve) => original.stdout.once("data", resolve)); original.kill("SIGKILL");
    await new Promise((resolve) => original.once("exit", resolve));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    const contenders = [0, 1].map(() => spawn(process.execPath, [__filename], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: raceEnv }));
    const outputs = ["", ""]; const errors = ["", ""];
    contenders.forEach((child, index) => { child.stdout.on("data", (data) => { outputs[index] += data; });
      child.stderr.on("data", (data) => { errors[index] += data; }); });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const winners = contenders.map((child, index) => ({ child, index })).filter(({ child, index }) =>
      child.exitCode === null && outputs[index].includes("ready"));
    check("two concurrent stale takeovers produce exactly one owner", () => {
      assert.equal(winners.length, 1, JSON.stringify({ outputs, errors, exitCodes: contenders.map((c) => c.exitCode) }));
      const loser = winners[0].index === 0 ? 1 : 0;
      assert.notEqual(contenders[loser].exitCode, null); assert.match(errors[loser], /bounded_task_already_running/);
    });
    winners[0].child.kill("SIGKILL"); await new Promise((resolve) => winners[0].child.once("exit", resolve));
    console.log(`bounded task state machine smoke passed (${checks} checks)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
