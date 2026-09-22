#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const runner = require("./dogfood-resumable-runner.cjs");

const root = path.resolve(__dirname, "../..");
const model = "gpt-5.6-codex";
const runnerHeadSha = cp.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root, encoding: "utf8"
}).trim().toLowerCase();

function main() {
  const { suite, tasks } = runner.loadSuiteTasks();
  const base = runner.createCheckpoint({
    suite, tasks, model, runnerHeadSha,
    startedAt: "2026-01-01T00:00:00.000Z", results: [], inFlightTaskId: null
  });
  assert.equal(runner.validateResumeCheckpoint(base, {
    suite, tasks, model, runnerHeadSha
  }).results.length, 0);

  assert.throws(() => runner.validateResumeCheckpoint({
    ...base, inFlightTaskId: tasks[0].taskId
  }, { suite, tasks, model, runnerHeadSha }), /stopped during/);

  assert.throws(() => runner.validateResumeCheckpoint({
    ...base, failedTaskId: tasks[0].taskId,
    failure: { domain: "agent", code: "dogfood_agent_execution_failure" }
  }, { suite, tasks, model, runnerHeadSha }), /forbids a second invocation/);

  const completed = {
    taskId: tasks[0].taskId, attempt: 1, retryCount: 0,
    hiddenHintsInjected: false, promptMutatedAfterFailure: false,
    pairCompleted: true, failure: null, result: {}
  };
  const afterCompleted = runner.createCheckpoint({
    suite, tasks, model, runnerHeadSha,
    startedAt: base.startedAt, results: [completed], inFlightTaskId: null
  });
  assert.equal(runner.validateResumeCheckpoint(afterCompleted, {
    suite, tasks, model, runnerHeadSha
  }).results.length, 1);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    completedArmNotReplayed: true,
    ambiguousInvocationNotRetried: true,
    failedInvocationNotRetried: true,
    failureDomains: ["infrastructure", "agent", "acceptance"]
  }, null, 2)}\n`);
}

try { main(); } catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
