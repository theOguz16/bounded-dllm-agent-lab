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
  assert.equal(result.commands[0].output, "ok\n");
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
  assert.equal(capture.threadOptions.webSearchMode, "disabled");
  assert.equal(capture.threadOptions.approvalPolicy, "never");
  assert.deepEqual(capture.threadOptions.additionalDirectories, []);
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
  assert.equal(plannerCapture.threadOptions.webSearchMode, "disabled");
  assert.equal(plannerCapture.threadOptions.approvalPolicy, "never");
  assert.deepEqual(plannerCapture.threadOptions.additionalDirectories, []);

  let forbiddenFactoryCalls = 0;
  const rejectingAdapter = new CodexAgentAdapter({
    clientFactory: () => {
      forbiddenFactoryCalls += 1;
      return makeFakeClient({});
    },
    now: () => 3000
  });

  const rejectedFullAccess = await rejectingAdapter.run(
    request({ sandboxMode: "full_access" })
  );
  assert.equal(rejectedFullAccess.status, "rejected");
  assert.equal(forbiddenFactoryCalls, 0);
  assert.equal(
    rejectedFullAccess.diagnostics.some(
      (entry) => entry.code === "codex_isolation_danger_full_access"
    ),
    true
  );

  const rejectedPlannerWrite = await rejectingAdapter.run(
    request({ mode: "planner", sandboxMode: "workspace_write" })
  );
  assert.equal(rejectedPlannerWrite.status, "rejected");
  assert.equal(forbiddenFactoryCalls, 0);
  assert.equal(
    rejectedPlannerWrite.diagnostics.some(
      (entry) => entry.code === "codex_isolation_sandbox_escalation"
    ),
    true
  );

  const rejectedNetwork = await rejectingAdapter.run(
    request({ networkAllowed: true })
  );
  assert.equal(rejectedNetwork.status, "rejected");
  assert.equal(forbiddenFactoryCalls, 0);
  assert.equal(
    rejectedNetwork.diagnostics.some(
      (entry) => entry.code === "codex_isolation_network_policy_required"
    ),
    true
  );

  const rejectedSourceDirectory = await rejectingAdapter.run(
    request({
      sourceRepositoryPath: "/tmp/source-repository",
      additionalDirectories: ["/tmp/source-repository"]
    })
  );
  assert.equal(rejectedSourceDirectory.status, "rejected");
  assert.equal(forbiddenFactoryCalls, 0);
  assert.equal(
    rejectedSourceDirectory.diagnostics.some(
      (entry) => entry.code === "codex_isolation_additional_directory_source_overlap"
    ),
    true
  );

  const networkCapture = {};
  const networkAdapter = new CodexAgentAdapter({
    clientFactory: () => makeFakeClient(networkCapture),
    now: () => 4000
  });
  const networked = await networkAdapter.run(
    request({ networkAllowed: true, networkPolicy: "enabled" })
  );
  assert.equal(networked.status, "completed");
  assert.equal(networkCapture.threadOptions.networkAccessEnabled, true);
  assert.equal(networkCapture.threadOptions.webSearchMode, "disabled");
  assert.equal(networkCapture.threadOptions.approvalPolicy, "never");

  const additionalCapture = {};
  const additionalAdapter = new CodexAgentAdapter({
    clientFactory: () => makeFakeClient(additionalCapture),
    now: () => 5000
  });
  const safeAdditional = await additionalAdapter.run(
    request({
      sourceRepositoryPath: "/tmp/source-repository",
      additionalDirectories: ["/tmp/bounded-shared"]
    })
  );
  assert.equal(safeAdditional.status, "completed");
  assert.deepEqual(additionalCapture.threadOptions.additionalDirectories, ["/tmp/bounded-shared"]);

  const abortController = new AbortController();
  abortController.abort("smoke");
  const aborted = await rejectingAdapter.run(
    request({ abortSignal: abortController.signal })
  );
  assert.equal(aborted.status, "aborted");
  assert.equal(forbiddenFactoryCalls, 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    adapter: "CodexAgentAdapter",
    sdkVersion: CODEX_SDK_VERSION,
    fakeSdkOnly: true,
    realCodexCalls: false,
    plannerSandbox: "read-only",
    coderSandbox: "workspace-write",
    networkDefault: false,
    networkRequiresExplicitPolicy: true,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    additionalDirectoriesDefaultEmpty: true,
    dangerFullAccessRejected: true,
    realRepositoryAdditionalDirectoryRejected: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
