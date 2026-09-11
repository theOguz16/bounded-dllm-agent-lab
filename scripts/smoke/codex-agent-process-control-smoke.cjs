#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

function request(overrides = {}) {
  return {
    runId: "process-budget-smoke",
    agentId: "codex",
    workingDirectory: "/tmp/bounded-workspace",
    task: "Exercise process controls.",
    model: "gpt-5.6-codex",
    reasoningEffort: "medium",
    mode: "coder",
    timeoutMs: 10_000,
    networkAllowed: false,
    sandboxMode: "workspace_write",
    ...overrides
  };
}

function clientFromEvents(events, capture = {}) {
  return {
    startThread(options) {
      capture.threadOptions = options;
      return {
        async runStreamed(input, turnOptions) {
          capture.input = input;
          capture.turnOptions = turnOptions;
          return {
            events: (async function* () {
              for (const event of events) yield event;
            })()
          };
        }
      };
    }
  };
}

function assertFailure(result, code, status = "failed") {
  assert.equal(result.status, status);
  assert.equal(result.failureCode, code);
  assert.equal(result.diagnostics.some((entry) => entry.code === code), true);
}

async function main() {
  const moduleUrl = pathToFileURL(
    resolve(repoRoot, "dist/packages/integrations/src/codex-agent-adapter.js")
  ).href;
  const { CodexAgentAdapter } = await import(moduleUrl);

  const outputAdapter = new CodexAgentAdapter({
    clientFactory: () => clientFromEvents([
      { type: "thread.started", thread_id: "this-event-is-larger-than-one-byte" }
    ])
  });
  const outputLimited = await outputAdapter.run(request({
    processBudget: { maxStdoutBytes: 1 }
  }));
  assertFailure(outputLimited, "agent_output_limit");

  const eventAdapter = new CodexAgentAdapter({
    clientFactory: () => clientFromEvents([{ type: "turn.started" }])
  });
  const eventLimited = await eventAdapter.run(request({
    processBudget: { maxEvents: 0 }
  }));
  assertFailure(eventLimited, "agent_event_budget_exceeded");

  const commandAdapter = new CodexAgentAdapter({
    clientFactory: () => clientFromEvents([
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress"
        }
      }
    ])
  });
  const commandLimited = await commandAdapter.run(request({
    processBudget: { maxCommands: 0 }
  }));
  assertFailure(commandLimited, "agent_command_budget_exceeded");

  const stderrAdapter = new CodexAgentAdapter({
    clientFactory: () => ({
      startThread() {
        return {
          async runStreamed() {
            throw new Error("provider stderr text");
          }
        };
      }
    })
  });
  const stderrLimited = await stderrAdapter.run(request({
    processBudget: { maxStderrBytes: 1 }
  }));
  assertFailure(stderrLimited, "agent_output_limit");

  let preflightFactoryCalls = 0;
  const preflightAdapter = new CodexAgentAdapter({
    clientFactory: () => {
      preflightFactoryCalls += 1;
      return clientFromEvents([]);
    }
  });

  const providerLimited = await preflightAdapter.run(request({
    processBudget: { maxProviderCalls: 0 }
  }));
  assertFailure(providerLimited, "agent_provider_call_budget_exceeded");
  assert.equal(preflightFactoryCalls, 0);

  const modelLimited = await preflightAdapter.run(request({
    processBudget: { maxModelCalls: 0 }
  }));
  assertFailure(modelLimited, "agent_model_call_budget_exceeded");
  assert.equal(preflightFactoryCalls, 0);

  const repairLimited = await preflightAdapter.run(request({
    mode: "repair",
    processBudget: { maxRepairRounds: 0 }
  }));
  assertFailure(repairLimited, "agent_repair_budget_exceeded");
  assert.equal(preflightFactoryCalls, 0);

  const timeoutCapture = {};
  const timeoutAdapter = new CodexAgentAdapter({
    clientFactory: () => ({
      startThread(options) {
        timeoutCapture.threadOptions = options;
        return {
          async runStreamed(input, turnOptions) {
            timeoutCapture.turnOptions = turnOptions;
            return {
              events: (async function* () {
                await new Promise((resolvePromise, rejectPromise) => {
                  const signal = turnOptions.signal;
                  if (signal.aborted) {
                    rejectPromise(signal.reason);
                    return;
                  }
                  signal.addEventListener("abort", () => {
                    timeoutCapture.aborted = true;
                    rejectPromise(signal.reason);
                  }, { once: true });
                });
                yield { type: "turn.started" };
              })()
            };
          }
        };
      }
    })
  });
  const timedOut = await timeoutAdapter.run(request({
    timeoutMs: 1_000,
    processBudget: { totalTimeoutMs: 15 }
  }));
  assertFailure(timedOut, "agent_timeout", "timed_out");
  assert.equal(timeoutCapture.aborted, true);
  assert.equal(timeoutCapture.turnOptions.signal.aborted, true);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    adapter: "CodexAgentAdapter",
    timeoutViaAbortSignal: true,
    deterministicFailures: [
      "agent_timeout",
      "agent_output_limit",
      "agent_event_budget_exceeded",
      "agent_command_budget_exceeded",
      "agent_repair_budget_exceeded",
      "agent_provider_call_budget_exceeded",
      "agent_model_call_budget_exceeded"
    ],
    liveProviderCalls: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
