#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = resolve(__dirname, '../..');
const event = value => JSON.stringify(value);
const usage = (input, cached, output) => ({ type: 'turn.completed', usage: {
  input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
const started = { type: 'turn.started' };
const command = (id, output = 'ok') => ({ type: 'item.completed', item: {
  id, type: 'command_execution', command: 'SECRET_COMMAND',
  aggregated_output: output, exit_code: 0, status: 'completed' } });
const stream = events => events.map(event).join('\n');
async function main() {
  const { deriveCodexCoderTrajectory } = await import(pathToFileURL(resolve(repo,
    'dist/packages/integrations/src/codex-coder-trajectory.js')).href);
  const { summarizeCoderTrajectory, renderCoderTrajectoryTable } = await import(pathToFileURL(resolve(repo,
    'research/context-token-matrix-v1/trajectory-analysis.mjs')).href);
  const { CodexAgentAdapter } = await import(pathToFileURL(resolve(repo,
    'dist/packages/integrations/src/codex-agent-adapter.js')).href);
  const { makeJournalScopedAdapter, annotateCoderTrajectory } = await import(pathToFileURL(resolve(repo,
    'research/context-token-matrix-v1/live-runtime.mjs')).href);
  const events = [{ type: 'thread.started', thread_id: 'x' }, started,
    command('one', 'SECRET_OUTPUT'), usage(100, 40, 20), started,
    command('two', 'ok'), command('three', ''), usage(220, 130, 30),
    started, usage(330, 230, 35)];
  const trajectory = deriveCodexCoderTrajectory(stream(events), new Map([
    ['one', { startedAtMs: 10, completedAtMs: 20 }] ]));
  assert.equal(trajectory.schemaVersion, 'codex-coder-trajectory/v2');
  assert.equal(trajectory.status, 'observed');
  assert.deepEqual(trajectory.turns.map(t => t.toolCallsInTurn), [1, 2, 0]);
  assert.deepEqual(trajectory.turns.map(t => t.cumulativeToolCalls), [1, 3, 3]);
  assert.deepEqual(trajectory.turns.map(t => t.inputDelta), [100, 120, 110]);
  assert.deepEqual(trajectory.turns.map(t => t.cachedDelta), [40, 90, 100]);
  assert.deepEqual(trajectory.turns.map(t => t.uncachedDelta), [60, 30, 10]);
  assert.deepEqual(trajectory.turns.map(t => t.outputDelta), [20, 10, 5]);
  assert.equal(trajectory.turns[1].newToolResultBytesSincePreviousTurn, 13);
  assert.equal(trajectory.turns[2].newToolResultBytesSincePreviousTurn, 2);
  assert.equal(trajectory.tools[0].requestBytes, 14);
  assert.equal(trajectory.tools[0].responseBytes, 13);
  assert.equal(trajectory.tools[0].responseEstimatedTokens, 4);
  assert.equal(trajectory.tools[0].responseTokenProvenance, 'estimated');
  assert.equal(trajectory.tools[0].elapsedMs, 10);
  assert.equal(trajectory.turns[1].priorToolResultsRepresented, null);
  assert.equal(trajectory.turns[1].selectedContextChanged, null);
  assert.equal(trajectory.turns[1].promptEstimatedTokensBeforeTurn, null);
  assert.equal(trajectory.tools[2].responseBytes, 0);
  assert.equal(trajectory.tools[2].responseEstimatedTokens, 0);
  assert.equal(trajectory.tools[0].providerInputBeforeToolEvent, null);
  assert.equal(trajectory.tools[0].providerInputAfterToolEvent, 100);
  assert.equal(trajectory.tools[0].inputDeltaAfterToolEvent, null);
  assert.equal(trajectory.tools[1].providerInputBeforeToolEvent, 100);
  assert.equal(trajectory.tools[1].providerInputAfterToolEvent, 220);
  assert.equal(trajectory.tools[1].inputDeltaAfterToolEvent, null);
  assert.equal(trajectory.tools[1].observationIntervalToolCount, 2);
  assert.equal(trajectory.tools[2].observationIntervalToolCount, 2);
  assert.equal(JSON.stringify(trajectory).includes('SECRET_'), false);

  // Every interval below has one tool event and two observed cumulative samples.
  const intervals = deriveCodexCoderTrajectory(stream([started, usage(100, 40, 20),
    started, command('small', 'x'), usage(180, 90, 28),
    started, command('large', 'RESULT_SECRET'.repeat(10)), usage(330, 170, 40)]));
  assert.deepEqual(intervals.tools.map(t => t.sequence), [1, 2]);
  assert.deepEqual(intervals.tools.map(t => t.responseBytes), [1, 130]);
  assert.deepEqual(intervals.tools.map(t => t.inputDeltaAfterToolEvent), [80, 150]);
  assert.deepEqual(intervals.tools.map(t => t.cachedDeltaAfterToolEvent), [50, 80]);
  assert.deepEqual(intervals.tools.map(t => t.uncachedDeltaAfterToolEvent), [30, 70]);
  assert.deepEqual(intervals.tools.map(t => t.outputDeltaAfterToolEvent), [8, 12]);
  assert.equal(intervals.tools[0].providerInputBeforeToolEvent, 100);
  assert.equal(intervals.tools[0].providerCachedInputBeforeToolEvent, 40);
  assert.equal(intervals.tools[0].providerUncachedInputBeforeToolEvent, 60);
  assert.equal(intervals.tools[0].providerOutputBeforeToolEvent, 20);
  assert.equal(intervals.tools[0].providerInputAfterToolEvent, 180);
  assert.equal(intervals.tools[0].providerCachedInputAfterToolEvent, 90);
  assert.equal(intervals.tools[0].providerUncachedInputAfterToolEvent, 90);
  assert.equal(intervals.tools[0].providerOutputAfterToolEvent, 28);
  assert.equal(intervals.tools[1].providerInputBeforeToolEvent, 180);
  assert.equal(intervals.tools[1].providerInputAfterToolEvent, 330);
  assert.equal(intervals.tools[1].cumulativeCoderInputAtEvent, null);
  assert.equal(JSON.stringify(intervals).includes('RESULT_SECRET'), false);
  assert.equal(JSON.stringify(intervals).includes('SECRET_COMMAND'), false);
  assert.equal(JSON.stringify(intervals).includes('SECRET_RUNTIME_PROMPT'), false);
  assert.deepEqual(intervals, deriveCodexCoderTrajectory(stream([started, usage(100, 40, 20),
    started, command('small', 'x'), usage(180, 90, 28),
    started, command('large', 'RESULT_SECRET'.repeat(10)), usage(330, 170, 40)])));
  const intervalAnalysis = summarizeCoderTrajectory(intervals);
  assert.equal(intervalAnalysis.toolEventSummary.totalToolResultBytes, 131);
  assert.equal(intervalAnalysis.toolEventSummary.medianToolResultBytes, 65.5);
  assert.equal(intervalAnalysis.toolEventSummary.totalObservedInputGrowthAfterToolEvents, 230);
  assert.equal(intervalAnalysis.toolEventSummary.largestObservedInputDeltaAfterToolEvent, 150);
  assert.equal(intervalAnalysis.toolEventSummary.largestObservedDeltaToolCategory, 'command_execution');
  assert.match(renderCoderTrajectoryTable(intervalAnalysis), /2 \| command_execution \| 130 \| 180 \| 330 \| 150/);

  const unavailableInterval = deriveCodexCoderTrajectory(stream([started,
    command('unknown', 'a'.repeat(4000)), { type: 'turn.completed' }]));
  assert.equal(unavailableInterval.tools[0].responseBytes, 4000);
  assert.equal(unavailableInterval.tools[0].providerInputAfterToolEvent, null);
  assert.equal(unavailableInterval.tools[0].inputDeltaAfterToolEvent, null);
  assert.equal(unavailableInterval.tools[0].cachedDeltaAfterToolEvent, null);
  assert.equal(unavailableInterval.tools[0].uncachedDeltaAfterToolEvent, null);
  const invalidInterval = deriveCodexCoderTrajectory(stream([started, usage(100, 80, 10),
    started, command('invalid-cache'), usage(110, 100, 11)]));
  assert.equal(invalidInterval.status, 'invalid');
  assert.equal(invalidInterval.tools[0].providerInputBeforeToolEvent, 100);
  assert.equal(invalidInterval.tools[0].inputDeltaAfterToolEvent, null);
  assert.equal(invalidInterval.tools[0].cachedDeltaAfterToolEvent, null);
  assert.equal(invalidInterval.tools[0].uncachedDeltaAfterToolEvent, null);
  const oldV1 = { ...trajectory, schemaVersion: 'codex-coder-trajectory/v1',
    tools: trajectory.tools.map(({ providerInputBeforeToolEvent, providerInputAfterToolEvent,
      inputDeltaAfterToolEvent, ...oldTool }) => oldTool) };
  assert.equal(summarizeCoderTrajectory(oldV1).toolEvents, undefined);

  const single = deriveCodexCoderTrajectory(stream([started, command('only'), usage(0, 0, 0)]));
  assert.equal(single.status, 'observed');
  assert.equal(single.turns[0].cumulativeUncachedInputTokens, 0);
  assert.equal(single.turns[0].toolCallsInTurn, 1);
  const missing = deriveCodexCoderTrajectory(stream([started, { type: 'turn.completed' }]));
  assert.equal(missing.status, 'partial');
  assert.equal(missing.turns[0].cumulativeInputTokens, null);
  assert.equal(missing.turns[0].inputDelta, null);
  const unfinished = deriveCodexCoderTrajectory(stream([started, command('unfinished')]));
  assert.equal(unfinished.status, 'partial');
  assert.equal(unfinished.turns[0].cumulativeInputTokens, null);
  const gap = deriveCodexCoderTrajectory(stream([started, command('gap'), started,
    usage(20, 0, 1)]));
  assert.deepEqual(gap.turns.map(turn => turn.turnIndex), [1, 2]);
  assert.equal(gap.turns[1].inputDelta, null);
  const decreasing = deriveCodexCoderTrajectory(stream([started, usage(100, 50, 10),
    started, usage(90, 40, 9)]));
  assert.equal(decreasing.status, 'invalid');
  assert.equal(decreasing.turns[1].inputDelta, null);
  const impossible = deriveCodexCoderTrajectory(stream([started, usage(100, 80, 10),
    started, usage(110, 100, 11)]));
  assert.equal(impossible.status, 'invalid');
  assert.equal(impossible.turns[1].cachedDelta, null);
  assert.equal(deriveCodexCoderTrajectory(stream([started, usage(10, 11, 0)])).status, 'invalid');
  const paths = deriveCodexCoderTrajectory(stream([started,
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [
      { path: 'src/index.ts' }, { path: 'src/index.ts' }] } },
    { type: 'item.completed', item: { id: 'f2', type: 'file_change', changes: [
      { path: '../private.txt' }] } }, usage(1, 0, 0)]));
  assert.deepEqual(paths.tools[0].referencedPaths, ['src/index.ts']);
  assert.equal(paths.tools[0].filesReturnedOrRead, null);
  assert.equal(paths.tools[1].referencedPaths, null);
  assert.equal(paths.tools[1].filesReturnedOrRead, null);
  const annotated = annotateCoderTrajectory(trajectory,
    { usage: { coder: { initialPromptEstimatedTokens: 50 } },
      runtimeOnlyAuthority: 'SECRET_RUNTIME_AUTHORITY' },
    { selectedFileCount: 2, selectedBytes: 400,
      initialEvidence: [{ content: 'SECRET_SOURCE_CONTENT' }] });
  assert.equal(annotated.turns[0].selectedContextFileCount, 2);
  assert.equal(annotated.turns[0].selectedContextBytes, 400);
  assert.equal(annotated.turns[1].selectedContextFileCount, null);
  assert.equal(annotated.turns[1].promptEstimatedTokensBeforeTurn, null);
  assert.equal(JSON.stringify(annotated).includes('SECRET_'), false);
  const analysis = summarizeCoderTrajectory(annotated);
  assert.equal(analysis.amplification.cumulativeInputToInitialEstimate, 6.6);
  assert.equal(analysis.amplification.cumulativeInputPerToolCall, 110);
  assert.equal(analysis.amplification.toolResultBytesPerToolCall, 5);
  assert.equal(analysis.rows[0].inputGrowthToNextTurn, 120);
  assert.equal(analysis.rows[1].cachedDeltaShare, 0.75);
  assert.match(renderCoderTrajectoryTable(analysis), /tool-result bytes/);
  assert.equal(summarizeCoderTrajectory(null).status, 'unavailable');

  let providerCalls = 0; const capture = {};
  const adapter = new CodexAgentAdapter({ clientFactory: () => ({ startThread(options) {
    capture.options = options; return { async runStreamed(input, turnOptions) {
      providerCalls++; capture.input = input; capture.turnOptions = turnOptions;
      return { events: (async function* () { for (const value of events) yield value; })() };
    } }; } }), now: () => 1000 });
  const request = { runId: 'trajectory-smoke', agentId: 'codex',
    workingDirectory: '/tmp/bounded-workspace', task: 'SECRET_RUNTIME_PROMPT',
    model: 'gpt-5.6-codex', reasoningEffort: 'high', mode: 'coder',
    timeoutMs: 10000, networkAllowed: false, sandboxMode: 'workspace_write' };
  const result = await adapter.run(request);
  assert.equal(providerCalls, 1);
  assert.equal(capture.input, request.task);
  assert.equal(capture.options.model, request.model);
  assert.equal(result.usage.inputTokens, 330);
  assert.equal(result.usage.cachedInputTokens, 230);
  assert.equal(result.usage.providerTurnCount, 3);
  assert.equal(result.usage.toolCallCount, 3);
  assert.deepEqual(result.commands.map(c => c.command), ['SECRET_COMMAND', 'SECRET_COMMAND', 'SECRET_COMMAND']);
  assert.equal(result.trajectoryTelemetry.tools.length, 3);
  assert.equal(JSON.stringify(result.trajectoryTelemetry).includes('SECRET_'), false);
  const productResult = Object.freeze({ candidate: 'same-candidate',
    validation: 'same-validation', routing: 'same-route', trajectoryTelemetry: trajectory });
  const calls = []; const observed = []; let wrapperCalls = 0;
  const wrapped = makeJournalScopedAdapter({ agentId: 'codex', agentVersion: 'fixture',
    async run(input) { wrapperCalls++; calls.push(input); return productResult; } },
  'fixture.trajectory', call => observed.push(call), null,
  () => { throw new Error('telemetry callback failure'); });
  const wrappedResult = await wrapped.run({ runId: 'one', mode: 'coder',
    model: 'gpt-5.6-luna', reasoningEffort: 'medium', task: 'SECRET_RUNTIME_PROMPT' });
  assert.equal(wrappedResult, productResult);
  assert.equal(wrapperCalls, 1);
  assert.equal(calls[0].task, 'SECRET_RUNTIME_PROMPT');
  assert.equal(calls[0].runId, 'matrix.fixture.trajectory.one');
  assert.equal(observed.length, 1);
  assert.equal(wrappedResult.candidate, 'same-candidate');
  assert.equal(wrappedResult.validation, 'same-validation');
  assert.equal(wrappedResult.routing, 'same-route');
  console.log('codex-coder-trajectory-smoke: PASS (fake provider calls 1; real provider calls 0)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
