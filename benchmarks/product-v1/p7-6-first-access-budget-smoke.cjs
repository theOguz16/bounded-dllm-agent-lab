#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");

async function main() {
  process.env.BOUNDED_CODEX_PROVIDER_INVOCATION_BUDGET = "1";
  const { CodexAgentAdapter } = await import(pathToFileURL(
    path.join(root, "dist/packages/integrations/src/codex-agent-adapter.js")
  ).href);
  let clientCount = 0;
  const options = [];
  const adapter = new CodexAgentAdapter({
    clientFactory: () => {
      clientCount += 1;
      return {
        startThread(threadOptions) {
          options.push(threadOptions);
          return {
            async runStreamed() {
              return { events: (async function* () {
                yield { type: "thread.started", thread_id: "fake-thread" };
                yield { type: "turn.started" };
                yield { type: "turn.completed" };
              })() };
            }
          };
        }
      };
    }
  });
  const request = {
    runId: "first-access-probe",
    agentId: "codex",
    workingDirectory: root,
    task: "Return a bounded fixture.",
    model: "gpt-5.6-luna",
    reasoningEffort: "none",
    mode: "discovery",
    timeoutMs: 10_000,
    networkAllowed: false,
    sandboxMode: "read_only"
  };
  await adapter.run(request);
  assert.equal(clientCount, 1);
  assert.equal(options.length, 1);
  assert.equal(options[0].model, "gpt-5.6-luna");
  assert.equal(options[0].modelReasoningEffort, "none", "none must never be rewritten to minimal");
  const second = await adapter.run({ ...request, runId: "blocked-second-access" });
  assert.equal(second.status, "rejected");
  assert.equal(second.diagnostics[0].code, "codex_first_live_attempt_budget_exhausted");
  assert.equal(clientCount, 1, "no second SDK client may be started");
  console.log("P7.6 first access offline budget and exact Luna/none: PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
