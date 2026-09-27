#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

(async () => {
  const { tokenObservability } = await import("../../dist/apps/cli/src/commands/codex.js");
  const result = (decision, costBudget) => ({ decision, summary: costBudget ? { costBudget } : {} });
  const run = (mode, usage, task = "sensitive provider prompt") => ({
    request: { mode, task }, result: { status: "completed", usage,
      finalMessage: "sensitive provider output", diagnostics: [{ message: "secret" }] }
  });
  const planner = run("planner", { inputTokens: 100, cachedInputTokens: 30,
    outputTokens: 20, totalTokens: 120, providerTurnCount: 0, toolCallCount: 0 });
  const coder = run("coder", { inputTokens: 200, cachedInputTokens: 40,
    outputTokens: 50, totalTokens: 250, providerTurnCount: 2, toolCallCount: 3 });
  const success = tokenObservability(result("bounded_task_completed"), [planner, coder]);
  const stopped = tokenObservability(result("bounded_task_stopped"), [planner, coder]);
  assert.deepEqual(stopped, success, "downstream failure must retain completed provider observations");
  assert.deepEqual(success.map((stage) => stage.operation), ["planner", "coder"]);
  assert.deepEqual(success.map((stage) => stage.cumulativeUncachedInputTokens), [70, 160]);
  assert.equal(success[0].providerTurnCount, 0);
  assert.equal(success[0].toolCallCount, 0);
  assert.equal(success[0].provenance.providerTurnCount, "observed");
  assert.equal(success[0].provenance.cumulativeUncachedInputTokens, "derived");
  assert.equal(success[0].provenance.initialPromptEstimatedTokens, "estimated");
  assert.deepEqual(tokenObservability(result("bounded_task_stopped"), [planner]), [success[0]]);
  assert.equal(tokenObservability(result("bounded_task_stopped"), []), null);

  const malformed = tokenObservability(result("bounded_task_stopped"), [
    run("planner", { inputTokens: 10, cachedInputTokens: 2,
      outputTokens: 5, totalTokens: 99, providerTurnCount: 1, toolCallCount: 1 })
  ])[0];
  assert.equal(malformed.reported, false);
  assert.equal(malformed.cumulativeInputTokens, null);
  assert.equal(malformed.outputTokens, null);
  assert.equal(malformed.providerTurnCount, null);
  assert.equal(malformed.provenance.cumulativeInputTokens, "unavailable");

  const contradictory = tokenObservability(result("bounded_task_stopped"), [
    run("coder", { inputTokens: 10, cachedInputTokens: 11,
      outputTokens: 5, totalTokens: 15 })
  ])[0];
  assert.equal(contradictory.reported, true);
  assert.equal(contradictory.cumulativeCachedInputTokens, null);
  assert.equal(contradictory.cumulativeUncachedInputTokens, null);
  assert.equal(contradictory.provenance.cumulativeUncachedInputTokens, "unavailable");

  const missing = tokenObservability(result("bounded_task_stopped"), [
    run("planner", { inputTokens: 10, outputTokens: 5 })
  ])[0];
  assert.equal(missing.reported, false);
  assert.equal(missing.cumulativeInputTokens, null);
  assert.equal(missing.cumulativeCachedInputTokens, null);
  assert.equal(missing.toolCallCount, null);

  const partial = tokenObservability(result("bounded_task_stopped"), [
    run("planner", { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  ])[0];
  assert.equal(partial.reported, true);
  assert.equal(partial.cumulativeCachedInputTokens, null);
  assert.equal(partial.cumulativeUncachedInputTokens, null);
  assert.equal(partial.providerTurnCount, null);
  assert.equal(partial.toolCallCount, null);

  const emptyPrompt = tokenObservability(result("bounded_task_stopped"), [
    run("planner", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, "")
  ])[0];
  assert.equal(emptyPrompt.initialPromptEstimatedTokens, null);
  assert.equal(emptyPrompt.provenance.initialPromptEstimatedTokens, "unavailable");
  const failedProvider = { ...planner, result: { ...planner.result, status: "failed" } };
  assert.equal(tokenObservability(result("bounded_task_stopped"), [failedProvider])[0].reported, false);

  const expansion = tokenObservability(result("bounded_task_stopped", {
    reservations: [{ invocationId: "expansion-1", operation: "expansion", estimatedInputTokens: 7 }],
    reconciliations: [{ invocationId: "expansion-1", usage: { status: "observed",
      inputTokens: 12, cachedInputTokens: 0, outputTokens: 2, totalTokens: 14,
      providerTurnCount: 0, toolCallCount: 0 } }]
  }), []);
  assert.equal(expansion[0].operation, "expansion");
  assert.equal(expansion[0].initialPromptEstimatedTokens, 7);
  assert.equal(expansion[0].cumulativeUncachedInputTokens, 12);
  assert.equal(expansion[0].provenance.initialPromptEstimatedTokens, "estimated");
  assert.equal(expansion[0].provenance.cumulativeCachedInputTokens, "observed");

  const serialized = JSON.stringify({ success, stopped, malformed, contradictory, missing, partial, expansion });
  assert.equal(serialized.includes("sensitive provider prompt"), false);
  assert.equal(serialized.includes("sensitive provider output"), false);
  assert.equal(serialized.includes("secret"), false);
  console.log(JSON.stringify({ ok: true, completedStagesSurviveStop: true,
    malformedEvidenceUnavailable: true, zeroObserved: true, expansionPreserved: true,
    rawProviderTextSerialized: false }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
