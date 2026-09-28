#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ratio = (a, b) => a === null || b === null || b === 0 ? null : Number((a / b).toFixed(4));
const show = value => value === null ? '—' : String(value);

/** Descriptive only: SDK-managed later prompt contents and carry-forward are unavailable. */
export function summarizeCoderTrajectory(trajectory) {
  if (trajectory === null) return { schemaVersion: 'codex-coder-trajectory-analysis/v1',
    status: 'unavailable', rows: [], amplification: null };
  if (trajectory?.schemaVersion !== 'codex-coder-trajectory/v1' ||
      !Array.isArray(trajectory.turns) || !Array.isArray(trajectory.tools))
    throw new Error('unsupported coder trajectory');
  const turns = trajectory.turns;
  const last = turns.at(-1);
  const initialEstimate = integer(turns[0]?.promptEstimatedTokensBeforeTurn);
  const cumulativeInput = integer(last?.cumulativeInputTokens);
  const cumulativeUncached = integer(last?.cumulativeUncachedInputTokens);
  const toolCount = trajectory.truncated ? null : integer(last?.cumulativeToolCalls);
  const responseBytes = trajectory.tools.filter(tool => tool.countsTowardToolCalls)
    .map(tool => integer(tool.responseBytes));
  const totalResultBytes = responseBytes.every(value => value !== null) ?
    responseBytes.reduce((sum, value) => sum + value, 0) : null;
  const rows = turns.map((turn, index) => {
    const input = integer(turn.cumulativeInputTokens);
    const cached = integer(turn.cumulativeCachedInputTokens);
    const inputDelta = integer(turn.inputDelta);
    const cachedDelta = integer(turn.cachedDelta);
    return { turn: turn.turnIndex,
      promptEstimate: integer(turn.promptEstimatedTokensBeforeTurn),
      cumulativeInput: input, cached,
      uncached: integer(turn.cumulativeUncachedInputTokens),
      inputDelta, tool: integer(turn.toolCallsInTurn),
      toolResultBytes: integer(turn.newToolResultBytesSincePreviousTurn),
      cumulativeTools: integer(turn.cumulativeToolCalls),
      inputGrowthToNextTurn: index + 1 < turns.length ?
        integer(turns[index + 1].inputDelta) : null,
      cachedShare: ratio(cached, input),
      cachedDeltaShare: ratio(cachedDelta, inputDelta) };
  });
  return { schemaVersion: 'codex-coder-trajectory-analysis/v1',
    status: trajectory.status, rows,
    amplification: { cumulativeInputToInitialEstimate: ratio(cumulativeInput, initialEstimate),
      cumulativeInputPerToolCall: ratio(cumulativeInput, toolCount),
      uncachedInputPerToolCall: ratio(cumulativeUncached, toolCount),
      toolResultBytesPerToolCall: ratio(totalResultBytes, toolCount) },
    interpretation: 'Descriptive ratios only; no causal claim.' };
}

export function renderCoderTrajectoryTable(analysis) {
  const header = 'turn | prompt estimate | cumulative input | cached | uncached | input delta | tool | tool-result bytes | cumulative tools | cached share';
  const rows = analysis.rows.map(row => [row.turn, row.promptEstimate,
    row.cumulativeInput, row.cached, row.uncached, row.inputDelta,
    row.tool, row.toolResultBytes, row.cumulativeTools, row.cachedShare].map(show).join(' | '));
  const amplification = analysis.amplification;
  return [header, ...rows, '',
    `cumulative input / initial estimate: ${show(amplification?.cumulativeInputToInitialEstimate ?? null)}`,
    `cumulative input / tool call: ${show(amplification?.cumulativeInputPerToolCall ?? null)}`,
    `uncached input / tool call: ${show(amplification?.uncachedInputPerToolCall ?? null)}`,
    `tool-result bytes / tool call: ${show(amplification?.toolResultBytesPerToolCall ?? null)}`,
    'Descriptive only; SDK-managed later prompt contents and tool-result carry-forward are unavailable.'
  ].join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: trajectory-analysis.mjs coder-trajectory.json');
    const file = process.argv[2];
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('trajectory file too large');
    process.stdout.write(renderCoderTrajectoryTable(summarizeCoderTrajectory(JSON.parse(fs.readFileSync(file, 'utf8')))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
