#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, "scripts/fixtures/p7-7-hanging-worker.cjs");

async function main() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    console.log(`P7.7 Codex adapter worker smoke skipped on ${process.platform}`);
    return;
  }
  const { CodexAgentAdapter } = await import(pathToFileURL(
    path.join(root, "dist/packages/integrations/src/codex-agent-adapter.js")
  ).href);

  const adapter = new CodexAgentAdapter({
    environment: {},
    authCheck: async () => true,
    workerEntrypoint: fixture,
    workerGraceMs: 40,
    workerForceGraceMs: 120
  });
  const result = await adapter.run({
    runId: "p7-7-adapter-hang",
    agentId: "codex",
    workingDirectory: root,
    task: "offline fake hang; never invoke Codex",
    model: "offline-fake-model",
    reasoningEffort: "medium",
    mode: "baseline",
    timeoutMs: 60,
    networkAllowed: false,
    sandboxMode: "workspace_write"
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.failureCode, "provider_outcome_ambiguous");
  assert.equal(result.quotaStatus, "unknown");
  assert.ok(result.workerLifecycle);
  assert.equal(typeof result.workerLifecycle.deadlineTriggeredAt, "number");
  assert.equal(typeof result.workerLifecycle.abortRequestedAt, "number");
  assert.equal(typeof result.workerLifecycle.workerExitedAt, "number");
  assert.equal(result.workerLifecycle.exitSignal, "SIGKILL");
  assert.equal(result.workerLifecycle.forcedTermination, true);
  assert.equal(
    result.workerLifecycle.deadlineTriggeredAt <= result.workerLifecycle.abortRequestedAt &&
      result.workerLifecycle.abortRequestedAt <= result.workerLifecycle.workerExitedAt,
    true
  );
  assert.equal(result.diagnostics.some((entry) => entry.code === "agent_timeout"), true);
  assert.equal(result.usage.inputTokens, null);

  console.log(`P7.7 Codex adapter fake-hang PASS on ${process.platform}: ambiguous timeout, forced worker exit, no real Codex call`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
