#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const fixture = (name) =>
  readFileSync(resolve(repoRoot, "fixtures/product/codex-events", name), "utf8");

async function main() {
  const parser = await import(
    pathToFileURL(resolve(repoRoot, "dist/packages/integrations/src/codex-event-parser.js")).href
  );
  assert.equal(typeof parser.parseCodexJsonl, "function");

  const success = parser.parseCodexJsonl(fixture("normal-success.jsonl"), { durationMs: 321 });
  assert.equal(success.status, "completed");
  assert.equal(success.threadId, "thread-1");
  assert.equal(success.finalMessage, "Done.");
  assert.equal(success.commands.length, 1);
  assert.equal(success.commands[0].command, "npm test");
  assert.equal(success.commands[0].exitCode, 0);
  assert.equal(success.commands[0].status, "completed");
  assert.equal(success.fileChanges.length, 1);
  assert.equal(success.fileChanges[0].path, "src/index.ts");
  assert.equal(success.fileChanges[0].operation, "modify");
  assert.equal(success.telemetry.inputTokens, 100);
  assert.equal(success.telemetry.cachedInputTokens, 40);
  assert.equal(success.telemetry.cacheWriteInputTokens, 10);
  assert.equal(success.telemetry.outputTokens, 25);
  assert.equal(success.telemetry.reasoningOutputTokens, 7);
  assert.equal(success.telemetry.totalTokens, 125);
  assert.equal(success.telemetry.commandCount, 1);
  assert.equal(success.telemetry.failedCommandCount, 0);
  assert.equal(success.telemetry.fileChangeEventCount, 1);
  assert.equal(success.telemetry.durationMs, 321);

  const failedCommand = parser.parseCodexJsonl(fixture("failed-command.jsonl"));
  assert.equal(failedCommand.status, "completed");
  assert.equal(failedCommand.commands[0].status, "failed");
  assert.equal(failedCommand.commands[0].exitCode, 1);
  assert.equal(failedCommand.telemetry.failedCommandCount, 1);

  const turnFailed = parser.parseCodexJsonl(fixture("turn-failed.jsonl"));
  assert.equal(turnFailed.status, "failed");
  assert.ok(turnFailed.diagnostics.some((item) => item.code === "codex_turn_failed"));

  const malformedJson = parser.parseCodexJsonl(fixture("malformed-json.jsonl"));
  assert.equal(malformedJson.status, "agent_protocol_invalid");
  assert.ok(malformedJson.diagnostics.some((item) => item.code === "agent_protocol_invalid"));

  const malformedCanonical = parser.parseCodexJsonl(fixture("malformed-canonical-event.jsonl"));
  assert.equal(malformedCanonical.status, "agent_protocol_invalid");
  assert.ok(malformedCanonical.diagnostics.some((item) => item.code === "agent_protocol_invalid"));

  const future = parser.parseCodexJsonl(fixture("unknown-future-event.jsonl"));
  assert.equal(future.status, "completed");
  assert.ok(future.diagnostics.some((item) => item.code === "codex_event_ignored"));

  const missingUsage = parser.parseCodexJsonl(fixture("missing-usage.jsonl"));
  assert.equal(missingUsage.status, "completed");
  assert.equal(missingUsage.telemetry.usageStatus, "unavailable");
  assert.equal(missingUsage.telemetry.inputTokens, null);
  assert.equal(missingUsage.telemetry.outputTokens, null);
  assert.equal(missingUsage.telemetry.totalTokens, null);

  const partial = parser.parseCodexJsonl(fixture("partial-stream.jsonl"));
  assert.equal(partial.status, "partial");
  assert.equal(partial.commands.length, 1);

  const aborted = parser.parseCodexJsonl(fixture("process-abort.jsonl"), { processAborted: true });
  assert.equal(aborted.status, "aborted");

  const streamError = parser.parseCodexJsonl(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-error" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "transport failed" })
    ].join("\n")
  );
  assert.equal(streamError.status, "failed");
  assert.ok(streamError.diagnostics.some((item) => item.code === "codex_stream_error"));

  console.log(JSON.stringify({
    ok: true,
    parser: "codex-jsonl",
    normalizedItems: ["command_execution", "file_change", "agent_message"],
    knownEvents: [
      "thread.started",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "item.started",
      "item.updated",
      "item.completed",
      "error"
    ],
    futureEventsIgnoredWithDiagnostic: true,
    malformedCanonicalEvent: "agent_protocol_invalid",
    cases: 9
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
