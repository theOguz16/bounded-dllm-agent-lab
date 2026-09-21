#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const repoRoot = path.resolve(__dirname, "../..");
const workerPath = path.join(__dirname, "isolated-command-worker.cjs");
let loaded = null;
async function runIsolatedCommand(command, args, options = {}) {
  if (!loaded) loaded = import(pathToFileURL(path.join(
    repoRoot, "dist/packages/integrations/src/isolated-agent-worker.js"
  )).href);
  const { runIsolatedAgentWorker } = await loaded;
  const timeoutMs = options.timeout;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid command deadline");
  const abort = new AbortController();
  let deadlineTriggeredAt = null;
  let observation = null;
  const timer = setTimeout(() => {
    deadlineTriggeredAt = Date.now();
    abort.abort("dogfood_deadline");
  }, timeoutMs);
  try {
    const result = await runIsolatedAgentWorker({
      workerPath,
      environment: options.env || process.env,
      payload: {
        command, args, cwd: options.cwd || process.cwd(),
        maxBuffer: options.maxBuffer || 32 * 1024 * 1024
      },
      signal: abort.signal,
      deadlineTriggeredAt: () => deadlineTriggeredAt,
      ...(options.graceMs ? { graceMs: options.graceMs } : {}),
      ...(options.killGraceMs ? { killGraceMs: options.killGraceMs } : {}),
      onEvent(value) {
        if (value && typeof value === "object" && value.type === "commandResult") {
          observation = value;
        }
      }
    });
    const completed = result.completed && observation !== null;
    return Object.freeze({
      status: completed ? observation.status : null,
      signal: completed ? observation.signal : result.lifecycle.exitSignal,
      error: completed ? null : "isolated_worker_incomplete",
      stdout: completed && typeof observation.stdout === "string" ? observation.stdout : "",
      stderr: completed && typeof observation.stderr === "string" ? observation.stderr : "",
      failureCode: !result.lifecycle.workerTerminationVerified ? "worker_termination_failed"
        : completed ? null : result.failureCode || "provider_outcome_ambiguous",
      lifecycle: result.lifecycle
    });
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { runIsolatedCommand };
