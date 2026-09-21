#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");
const fixture = path.join(__dirname, "p7-7-fake-worker.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function live(pid) {
  const check = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1500 });
  return check.status === 0 && /\S/.test(check.stdout) && !/^\s*Z/.test(check.stdout);
}
async function gone(pid) {
  for (let i = 0; i < 30; i++) {
    if (!live(pid)) return;
    await delay(40);
  }
  assert.equal(live(pid), false, `PID ${pid} still has a live process`);
}
async function main() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    process.stdout.write(JSON.stringify({ ok: true, skipped: "POSIX-only isolation" }) + "\n");
    return;
  }
  const { runIsolatedAgentWorker } = await import(pathToFileURL(path.join(root,
    "dist/packages/integrations/src/isolated-agent-worker.js")).href);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "p7-7-fake-"));
  // Prove the supervisor never issues a broad kill to an unrelated session.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"],
    { detached: true, stdio: "ignore" });
  unrelated.unref();
  let heldWorker = null;
  const nativeKill = process.kill;
  try {
    const graceful = await runIsolatedAgentWorker({
      workerPath: fixture, payload: { mode: "exit" }, environment: process.env,
      signal: new AbortController().signal, onEvent() {}
    });
    assert.equal(graceful.completed, true);
    assert.equal(graceful.failureCode, null);
    assert.equal(graceful.lifecycle.workerTerminationVerified, true);
    assert.equal(graceful.lifecycle.deadlineTriggeredAt, null);
    assert.equal(graceful.lifecycle.abortRequestedAt, null);
    assert.equal(typeof graceful.lifecycle.workerExitedAt, "number");

    const file = path.join(parent, "child.pid");
    const abort = new AbortController();
    let deadlineTriggeredAt = null;
    let workerPid = null;
    const hanging = await runIsolatedAgentWorker({
      workerPath: fixture, payload: { mode: "hang", grandchildFile: file },
      environment: process.env, signal: abort.signal,
      graceMs: 90, killGraceMs: 400,
      deadlineTriggeredAt: () => deadlineTriggeredAt,
      onEvent(event) {
        if (event?.type !== "ready") return;
        workerPid = event.workerPid;
        setTimeout(() => { deadlineTriggeredAt = Date.now(); abort.abort("test_deadline"); }, 45);
      }
    });
    assert.equal(hanging.completed, false);
    assert.equal(hanging.failureCode, "provider_outcome_ambiguous");
    assert.equal(hanging.lifecycle.workerTerminationVerified, true);
    assert.equal(hanging.lifecycle.forcedTermination, true);
    assert.equal(hanging.lifecycle.exitSignal, "SIGKILL");
    assert.equal(typeof hanging.lifecycle.deadlineTriggeredAt, "number");
    assert.equal(typeof hanging.lifecycle.abortRequestedAt, "number");
    assert.equal(typeof hanging.lifecycle.workerExitedAt, "number");
    assert.ok(hanging.lifecycle.deadlineTriggeredAt <= hanging.lifecycle.abortRequestedAt);
    assert.ok(hanging.lifecycle.abortRequestedAt <= hanging.lifecycle.workerExitedAt);
    assert.ok(hanging.lifecycle.workerExitedAt - hanging.lifecycle.deadlineTriggeredAt < 2000);
    const descendant = Number(fs.readFileSync(file, "utf8"));
    await gone(workerPid);
    await gone(descendant);
    assert.equal(live(unrelated.pid), true, "unrelated process must survive group escalation");

    const blockedFile = path.join(parent, "blocked.pid");
    const blocked = new AbortController();
    let blockedDeadline = null;
    let blockedPid = null;
    const failed = await runIsolatedAgentWorker({
      workerPath: fixture, payload: { mode: "hang", grandchildFile: blockedFile },
      environment: process.env, signal: blocked.signal, graceMs: 60,
      killGraceMs: 110, deadlineTriggeredAt: () => blockedDeadline,
      onEvent(event) {
        if (event?.type !== "ready") return;
        blockedPid = event.workerPid;
        // Simulate lack of permission for signal delivery, but not group liveness checks.
        process.kill = function(pid, signal) {
          if (pid < 0 && signal !== 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
          return nativeKill(pid, signal);
        };
        setTimeout(() => { blockedDeadline = Date.now(); blocked.abort("deadline"); }, 20);
      }
    });
    assert.equal(failed.completed, false);
    assert.equal(failed.failureCode, "worker_termination_failed");
    assert.equal(failed.lifecycle.workerTerminationVerified, false);
    assert.equal(failed.lifecycle.workerExitedAt, null);
    assert.equal(typeof failed.lifecycle.abortRequestedAt, "number");
    assert.equal(live(blockedPid), true, "failed termination must not be misreported as exited");
    assert.equal(live(unrelated.pid), true);
    process.kill = nativeKill;
    heldWorker = blockedPid;
    nativeKill(-blockedPid, "SIGKILL");
    await gone(blockedPid);
    await gone(Number(fs.readFileSync(blockedFile, "utf8")));
    heldWorker = null;

    // The command-level fixture exercises the exact runner boundary with no SDK.
    const { runIsolatedCommand } = require("./isolated-command-runner.cjs");
    const command = await runIsolatedCommand(process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: root, timeout: 80, graceMs: 90, killGraceMs: 400 });
    assert.equal(command.lifecycle.workerTerminationVerified, true);
    assert.equal(command.failureCode, "provider_outcome_ambiguous");
    assert.equal(command.status, null);
    assert.equal(typeof command.lifecycle.workerExitedAt, "number");
    process.stdout.write(JSON.stringify({ ok: true, platform: process.platform,
      deadlineDistinctFromExit: true, descendantDead: true,
      unrelatedSurvives: true, failedKillFailClosed: true,
      commandBoundaryVerified: true, liveProviderCalls: false }) + "\n");
  } finally {
    process.kill = nativeKill;
    if (heldWorker) { try { nativeKill(-heldWorker, "SIGKILL"); } catch {} }
    try { nativeKill(unrelated.pid, "SIGKILL"); } catch {}
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
