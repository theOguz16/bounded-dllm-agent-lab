#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

function request(overrides = {}) {
  return {
    runId: "run-1",
    agentId: "codex",
    workingDirectory: "/tmp/bounded-workspace",
    task: "Fix the bounded fixture.",
    model: "gpt-5.6-codex",
    reasoningEffort: "high",
    mode: "coder",
    timeoutMs: 10_000,
    networkAllowed: false,
    sandboxMode: "workspace_write",
    ...overrides
  };
}

function fakeEvents() {
  return [
    { type: "thread.started", thread_id: "thread-smoke" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "",
        status: "in_progress"
      }
    },
    {
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "ok\n",
        exit_code: 0,
        status: "completed"
      }
    },
    {
      type: "item.completed",
      item: {
        id: "file-1",
        type: "file_change",
        changes: [{ path: "src/index.ts", kind: "update" }],
        status: "completed"
      }
    },
    {
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Done." }
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 10,
        output_tokens: 25,
        reasoning_output_tokens: 7
      }
    }
  ];
}

function makeFakeClient(capture, events = fakeEvents()) {
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

async function main() {
  const moduleUrl = pathToFileURL(
    resolve(repoRoot, "dist/packages/integrations/src/codex-agent-adapter.js")
  ).href;
  const {
    CODEX_AGENT_ID,
    CODEX_SDK_VERSION,
    CodexAgentAdapter
  } = await import(moduleUrl);

  assert.equal(CODEX_AGENT_ID, "codex");
  assert.equal(CODEX_SDK_VERSION, "0.153.4");

  const capture = {};
  let clock = 1000;
  const adapter = new CodexAgentAdapter({
    clientFactory: () => makeFakeClient(capture),
    now: () => (clock += 10)
  });
  const schema = Object.freeze({ type: "object", properties: { ok: { type: "boolean" } } });
  const result = await adapter.run(request({ outputSchema: schema }));

  assert.equal(result.status, "completed");
  assert.equal(result.agentId, "codex");
  assert.equal(result.agentVersion, "0.153.4");
  assert.equal(result.modelId, "gpt-5.6-codex");
  assert.equal(result.finalMessage, "Done.");
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    cachedInputTokens: 40,
    toolCalls: null
  });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].command, "npm test");
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.commands[0].status, "completed");
  assert.deepEqual(result.fileChanges, [
    { sequence: 1, path: "src/index.ts", operation: "modify" }
  ]);

  assert.equal(capture.input, "Fix the bounded fixture.");
  assert.equal(capture.threadOptions.workingDirectory, "/tmp/bounded-workspace");
  assert.equal(capture.threadOptions.model, "gpt-5.6-codex");
  assert.equal(capture.threadOptions.sandboxMode, "workspace-write");
  assert.equal(capture.threadOptions.modelReasoningEffort, "high");
  assert.equal(capture.threadOptions.networkAccessEnabled, false);
  assert.equal(capture.threadOptions.approvalPolicy, "never");
  assert.equal("additionalDirectories" in capture.threadOptions, false);
  assert.equal(capture.turnOptions.outputSchema, schema);
  assert.equal(capture.turnOptions.signal instanceof AbortSignal, true);

  const plannerCapture = {};
  const plannerAdapter = new CodexAgentAdapter({
    clientFactory: () => makeFakeClient(plannerCapture),
    now: () => 2000
  });
  const planner = await plannerAdapter.run(
    request({ mode: "planner", sandboxMode: "read_only", reasoningEffort: "extra_high" })
  );
  assert.equal(planner.status, "completed");
  assert.equal(plannerCapture.threadOptions.sandboxMode, "read-only");
  assert.equal(plannerCapture.threadOptions.modelReasoningEffort, "xhigh");
  assert.equal(plannerCapture.threadOptions.networkAccessEnabled, false);
  assert.equal(plannerCapture.threadOptions.approvalPolicy, "never");
  assert.equal("additionalDirectories" in plannerCapture.threadOptions, false);

  let forbiddenFactoryCalls = 0;
  const rejectingAdapter = new CodexAgentAdapter({
    clientFactory: () => {
      forbiddenFactoryCalls += 1;
      return makeFakeClient({});
    },
    now: () => 3000
  });
  const rejected = await rejectingAdapter.run(
    request({ sandboxMode: "full_access" })
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(forbiddenFactoryCalls, 0);
  assert.equal(
    rejected.diagnostics.some((entry) => entry.code === "codex_sandbox_rejected"),
    true
  );

  const abortController = new AbortController();
  abortController.abort("smoke");
  const aborted = await rejectingAdapter.run(
    request({ abortSignal: abortController.signal })
  );
  assert.equal(aborted.status, "aborted");
  assert.equal(forbiddenFactoryCalls, 0);

  const source = require("node:fs").readFileSync(
    resolve(repoRoot, "packages/integrations/src/codex-agent-adapter.ts"),
    "utf8"
  );
  assert.equal(source.includes('"danger-full-access"'), false);
  assert.equal(source.includes("additionalDirectories:"), false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    adapter: "CodexAgentAdapter",
    sdkVersion: CODEX_SDK_VERSION,
    fakeSdkOnly: true,
    realCodexCalls: false,
    plannerSandbox: "read-only",
    coderSandbox: "workspace-write",
    networkDefault: false,
    approvalPolicy: "never",
    dangerFullAccessUsed: false,
    additionalDirectoriesUsed: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
