#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

async function main() {
  const processControl = await import(pathToFileURL(
    resolve(repoRoot, "dist/packages/integrations/src/agent-process-control.js")
  ).href);
  const {
    AGENT_PROCESS_CONTROL_VERSION,
    AgentProcessControlError,
    DEFAULT_AGENT_PROCESS_BUDGET,
    createAgentProcessControl,
    resolveAgentProcessBudget
  } = processControl;

  assert.equal(AGENT_PROCESS_CONTROL_VERSION, "agent-process-control/v1");
  assert.equal(DEFAULT_AGENT_PROCESS_BUDGET.maxRepairRounds, 1);

  const resolved = resolveAgentProcessBudget(5_000, { totalTimeoutMs: 2_000, maxCommands: 3 });
  assert.equal(resolved.totalTimeoutMs, 2_000);
  assert.equal(resolved.maxCommands, 3);
  assert.equal(Object.isFrozen(resolved), true);

  const output = createAgentProcessControl({
    totalTimeoutMs: 10_000,
    budget: { maxStdoutBytes: 3 }
  });
  assert.throws(
    () => output.observeStdout("abcd"),
    (error) => error instanceof AgentProcessControlError && error.code === "agent_output_limit"
  );
  assert.equal(output.failure().code, "agent_output_limit");
  assert.equal(output.signal.aborted, true);
  output.close();

  const stderr = createAgentProcessControl({
    totalTimeoutMs: 10_000,
    budget: { maxStderrBytes: 2 }
  });
  assert.throws(
    () => stderr.observeStderr("abc"),
    (error) => error instanceof AgentProcessControlError && error.code === "agent_output_limit"
  );
  stderr.close();

  const events = createAgentProcessControl({
    totalTimeoutMs: 10_000,
    budget: { maxEvents: 1 }
  });
  events.observeEvent();
  assert.throws(
    () => events.observeEvent(),
    (error) => error instanceof AgentProcessControlError &&
      error.code === "agent_event_budget_exceeded"
  );
  events.close();

  const commands = createAgentProcessControl({
    totalTimeoutMs: 10_000,
    budget: { maxCommands: 1 }
  });
  commands.observeCommand("cmd-1");
  commands.observeCommand("cmd-1");
  assert.equal(commands.usage().commandCount, 1);
  assert.throws(
    () => commands.observeCommand("cmd-2"),
    (error) => error instanceof AgentProcessControlError &&
      error.code === "agent_command_budget_exceeded"
  );
  commands.close();

  for (const [method, budgetField, code] of [
    ["recordRepairRound", "maxRepairRounds", "agent_repair_budget_exceeded"],
    ["recordProviderCall", "maxProviderCalls", "agent_provider_call_budget_exceeded"],
    ["recordModelCall", "maxModelCalls", "agent_model_call_budget_exceeded"]
  ]) {
    const control = createAgentProcessControl({
      totalTimeoutMs: 10_000,
      budget: { [budgetField]: 0 }
    });
    assert.throws(
      () => control[method](),
      (error) => error instanceof AgentProcessControlError && error.code === code
    );
    assert.equal(control.failure().code, code);
    assert.equal(control.signal.aborted, true);
    control.close();
  }

  const timeout = createAgentProcessControl({ totalTimeoutMs: 10 });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  assert.equal(timeout.signal.aborted, true);
  assert.equal(timeout.failure().code, "agent_timeout");
  assert.throws(
    () => timeout.throwIfFailed(),
    (error) => error instanceof AgentProcessControlError && error.code === "agent_timeout"
  );
  timeout.close();

  const parent = new AbortController();
  const parentControlled = createAgentProcessControl({
    totalTimeoutMs: 10_000,
    parentSignal: parent.signal
  });
  parent.abort("caller-cancelled");
  assert.equal(parentControlled.signal.aborted, true);
  assert.equal(parentControlled.failure(), null);
  parentControlled.close();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: AGENT_PROCESS_CONTROL_VERSION,
    timeoutFailure: "agent_timeout",
    outputFailure: "agent_output_limit",
    eventFailure: "agent_event_budget_exceeded",
    commandFailure: "agent_command_budget_exceeded",
    repairFailure: "agent_repair_budget_exceeded",
    providerFailure: "agent_provider_call_budget_exceeded",
    modelFailure: "agent_model_call_budget_exceeded",
    abortSignal: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
