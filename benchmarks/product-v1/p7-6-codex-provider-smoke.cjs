#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function request() {
  return {
    runId: "p7-6-offline", agentId: "codex", workingDirectory: "/tmp/p7-6-fake",
    task: "offline fixture", model: "fake-model", reasoningEffort: "medium",
    mode: "coder", timeoutMs: 10_000, networkAllowed: false, sandboxMode: "workspace_write"
  };
}

async function main() {
  const root = path.resolve(__dirname, "../..");
  const url = pathToFileURL(path.join(root, "dist/packages/integrations/src/codex-agent-adapter.js")).href;
  const { CodexAgentAdapter } = await import(url);
  const cases = [
    [{ code: "usage_limit_exceeded", message: "Usage limit exceeded" }, "usage_limit_exceeded", true],
    [Object.assign(new Error("missing Bearer"), { status: 401 }), "authentication_failed", true],
    [{ code: "server_overloaded", status: 503 }, "provider_overloaded", false],
    [new Error("socket closed after an ambiguous stream"), "provider_stream_error_unknown", false]
  ];
  let totalPaidCalls = 0;
  for (const [error, expected, stops] of cases) {
    let paidCalls = 0;
    const adapter = new CodexAgentAdapter({
      clientFactory: () => ({ startThread: () => ({
        async runStreamed() { paidCalls += 1; totalPaidCalls += 1; throw error; }
      }) })
    });
    const first = await adapter.run(request());
    assert.equal(first.status, "failed");
    assert.equal(first.failureCode, expected);
    assert.equal(first.quotaStatus, "unknown");
    assert.equal(first.diagnostics.some((entry) => entry.code === expected && entry.retryable === false), true);
    assert.equal(paidCalls, 1);
    if (stops) {
      const second = await adapter.run(request());
      assert.equal(second.status, "rejected");
      assert.equal(second.failureCode, expected);
      assert.equal(paidCalls, 1, "no further paid calls after limit or authentication failure");
    }
    // No implicit retry for overloaded/unknown: only the explicit run() above was invoked.
    assert.equal(paidCalls, 1);
  }

  let preflightPaidCalls = 0;
  const preflight = new CodexAgentAdapter({
    authCheck: async () => false,
    clientFactory: () => ({ startThread: () => ({
      async runStreamed() { preflightPaidCalls += 1; throw new Error("must not run"); }
    }) })
  });
  const refused = await preflight.run(request());
  assert.equal(refused.status, "rejected");
  assert.equal(refused.failureCode, "authentication_failed");
  assert.equal(preflightPaidCalls, 0);

  let jsonlCalls = 0;
  const jsonl = new CodexAgentAdapter({
    clientFactory: () => ({ startThread: () => ({
      async runStreamed() {
        jsonlCalls += 1;
        return { events: (async function* () {
          yield { type: "thread.started", thread_id: "offline" };
          yield { type: "error", message: "usage_limit_exceeded" };
        })() };
      }
    }) })
  });
  const parsed = await jsonl.run(request());
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.failureCode, "usage_limit_exceeded");
  assert.equal((await jsonl.run(request())).failureCode, "usage_limit_exceeded");
  assert.equal(jsonlCalls, 1);
  assert.equal(totalPaidCalls, 4);
  console.log("P7.6 fake Codex SDK: PASS; four terminal codes; zero paid/network calls in preflight; no retries");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
