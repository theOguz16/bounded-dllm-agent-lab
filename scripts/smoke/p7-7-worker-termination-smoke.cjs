#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, "scripts/fixtures/p7-7-hanging-worker.cjs");

async function main() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    console.log(`P7.7 worker termination smoke skipped on ${process.platform}`);
    return;
  }

  const controlModule = await import(pathToFileURL(
    path.join(root, "dist/packages/integrations/src/agent-process-control.js")
  ).href);
  const workerModule = await import(pathToFileURL(
    path.join(root, "dist/packages/integrations/src/isolated-agent-worker.js")
  ).href);

  const control = controlModule.createAgentProcessControl({ totalTimeoutMs: 60 });
  const result = await workerModule.runIsolatedAgentWorker({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: { ...process.env },
    stdin: "",
    processControl: control,
    graceMs: 40,
    forceGraceMs: 120
  });
  const lifecycle = control.lifecycle();

  assert.equal(control.failure().code, "agent_timeout");
  assert.equal(result.terminationConfirmed, true);
  assert.equal(result.exitSignal, "SIGKILL");
  assert.equal(lifecycle.forcedTermination, true);
  assert.equal(typeof lifecycle.deadlineTriggeredAt, "number");
  assert.equal(typeof lifecycle.abortRequestedAt, "number");
  assert.equal(typeof lifecycle.workerExitedAt, "number");
  assert.equal(lifecycle.exitSignal, "SIGKILL");
  assert.equal(lifecycle.deadlineTriggeredAt <= lifecycle.abortRequestedAt, true);
  assert.equal(lifecycle.abortRequestedAt <= lifecycle.workerExitedAt, true);
  assert.notEqual(lifecycle.deadlineTriggeredAt, lifecycle.workerExitedAt);
  assert.equal(typeof result.workerPid, "number");
  assert.throws(
    () => process.kill(result.workerPid, 0),
    (error) => error && error.code === "ESRCH"
  );
  control.close();

  const failedTermination = controlModule.createAgentProcessControl({ totalTimeoutMs: 30 });
  const failureResult = await workerModule.runIsolatedAgentWorker({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: { ...process.env, P7_7_FAKE_AUTO_EXIT_MS: "220" },
    stdin: "",
    processControl: failedTermination,
    graceMs: 30,
    forceGraceMs: 30,
    killProcessGroup: () => true
  });
  assert.equal(failureResult.terminationConfirmed, false);
  assert.equal(failedTermination.failure().code, "worker_termination_failed");
  assert.equal(failedTermination.lifecycle().forcedTermination, true);
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(typeof failedTermination.lifecycle().workerExitedAt, "number");
  failedTermination.close();

  console.log(`P7.7 worker termination PASS on ${process.platform}: deadline, abort, forced group kill, exit proof, and termination-failure fail-closed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
