'use strict';
const fs = require('node:fs');
const path = require('node:path');

const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ratio = (a, b) => a === null || b === null || b === 0 ? null : Number((a / b).toFixed(4));
const turnNumbers = ['cumulativeInputTokens','cumulativeCachedInputTokens',
  'cumulativeUncachedInputTokens','cumulativeOutputTokens','inputDelta','cachedDelta',
  'uncachedDelta','outputDelta','toolCallsInTurn','cumulativeToolCalls',
  'newToolResultBytesSincePreviousTurn'];
const toolNumbers = ['sequence','turnIndex','requestBytes','responseBytes',
  'responseEstimatedTokens','filesReturnedOrRead','elapsedMs'];
const safePath = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 160 && !/[\x00-\x1f\x7f\\]/.test(value) &&
  !path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  value !== '..' && !value.startsWith('../');

function annotateBoundedTrajectory(raw, coder, context) {
  if (raw === null) return null;
  if (raw?.schemaVersion !== 'codex-coder-trajectory/v1' ||
      !Array.isArray(raw.turns) || raw.turns.length > 64 ||
      !Array.isArray(raw.tools) || raw.tools.length > 128) return null;
  const turns = raw.turns.map((value, index) => {
    const turn = Object.fromEntries(turnNumbers.map(key => [key, number(value?.[key])]));
    turn.turnIndex = index + 1;
    turn.promptEstimatedTokensBeforeTurn = index === 0 ? number(coder?.initialEstimate) : null;
    turn.selectedContextFileCount = index === 0 ? number(context?.fileCount) : null;
    turn.selectedContextBytes = index === 0 ? number(context?.bytes) : null;
    turn.contextExpansionCount = null;
    turn.contextExpansionBytes = null;
    turn.contextExpansionTokens = null;
    turn.priorToolResultsRepresented = null;
    turn.selectedContextChanged = null;
    turn.provenance = {
      cumulative: ['observed','unavailable','invalid'].includes(value?.provenance?.cumulative)
        ? value.provenance.cumulative : 'unavailable',
      deltas: ['derived','unavailable','invalid'].includes(value?.provenance?.deltas)
        ? value.provenance.deltas : 'unavailable',
      promptEstimate: index === 0 && turn.promptEstimatedTokensBeforeTurn !== null
        ? 'estimated' : 'unavailable', carryForward: 'unavailable'
    };
    return turn;
  });
  const tools = raw.tools.map(value => ({
    ...Object.fromEntries(toolNumbers.map(key => [key, number(value?.[key])])),
    category: ['command_execution','file_change'].includes(value?.category) ? value.category : null,
    name: ['shell_command','file_change'].includes(value?.name) ? value.name : null,
    countsTowardToolCalls: value?.countsTowardToolCalls === true,
    responseTokenProvenance: value?.responseTokenProvenance === 'estimated' ? 'estimated' : 'unavailable',
    referencedPaths: Array.isArray(value?.referencedPaths) && value.referencedPaths.length <= 8 &&
      value.referencedPaths.every(safePath) ? value.referencedPaths : null,
    resultRepresentedInNextTurn: null
  }));
  return { schemaVersion: 'codex-coder-trajectory/v1',
    status: ['observed','partial','unavailable','invalid'].includes(raw.status) ? raw.status : 'invalid',
    bounded: true, truncated: raw.truncated === true, turns, tools,
    selectedContextSemantics: 'first-provider-turn-only',
    laterPromptAndCarryForward: 'unavailable' };
}

function summarizeBoundedObservation(observation) {
  if (observation?.system !== 'bounded') throw Error('Bounded observation required');
  const trajectory = observation.trajectoryTelemetry;
  const coder = observation.stageTelemetry?.coder;
  const turns = Array.isArray(trajectory?.turns) ? trajectory.turns : [];
  const tools = Array.isArray(trajectory?.tools) ? trajectory.tools.filter(x => x.countsTowardToolCalls) : [];
  const toolBytes = tools.every(x => number(x.responseBytes) !== null) ?
    tools.reduce((sum, x) => sum + x.responseBytes, 0) : null;
  const coderInput = number(coder?.inputTokens);
  const cumulativeInput = number(observation.inputTokens);
  return { taskId: observation.taskId,
    trajectoryStatus: trajectory?.status ?? 'unavailable',
    coderAmplification: ratio(coderInput, number(coder?.initialEstimate)),
    coderShareOfCumulativeInput: ratio(coderInput, cumulativeInput),
    coderProviderTurns: number(coder?.turns), coderToolCalls: number(coder?.tools),
    inputGrowthByTurn: turns.map(x => number(x.inputDelta)),
    uncachedGrowthByTurn: turns.map(x => number(x.uncachedDelta)),
    toolResultBytes: toolBytes, cumulativeCoderInput: coderInput };
}

function analyzeSweep(observations) {
  const bounded = observations.filter(x => x.system === 'bounded').map(summarizeBoundedObservation);
  const pairs = { comparable: 0, sameDirection: 0, oppositeDirection: 0, tied: 0 };
  for (let i = 0; i < bounded.length; i++) for (let j = i + 1; j < bounded.length; j++) {
    const a = bounded[i], b = bounded[j];
    if (a.coderToolCalls === null || b.coderToolCalls === null ||
        a.cumulativeCoderInput === null || b.cumulativeCoderInput === null) continue;
    pairs.comparable++;
    const direction = Math.sign(a.coderToolCalls - b.coderToolCalls) *
      Math.sign(a.cumulativeCoderInput - b.cumulativeCoderInput);
    if (direction > 0) pairs.sameDirection++;
    else if (direction < 0) pairs.oppositeDirection++;
    else pairs.tied++;
  }
  return { schemaVersion: 'robustness-bounded-trajectory-analysis/v1',
    interpretation: 'Descriptive observations only; no causal inference or variant ranking.',
    bounded, toolActivityVsTraffic: pairs };
}

module.exports = { annotateBoundedTrajectory, summarizeBoundedObservation, analyzeSweep };
if (require.main === module) {
  try {
    const files = process.argv.slice(2);
    if (files.length !== 5) throw Error('usage: node trajectory-analysis.cjs <five normalized.json files>');
    const observations = files.map(file => {
      if (fs.statSync(file).size > 1024 * 1024) throw Error('observation file too large');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    });
    process.stdout.write(JSON.stringify(analyzeSweep(observations), null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
