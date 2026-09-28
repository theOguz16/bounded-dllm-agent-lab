'use strict';
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function tokens(inputValue, cachedValue, outputValue) {
  const input = count(inputValue), cached = count(cachedValue), output = count(outputValue);
  if (input !== null && cached !== null && cached > input) throw Error('cached input exceeds input');
  const total = input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : null;
  return { inputTokens: input, cachedInputTokens: cached, uncachedInputTokens: input !== null && cached !== null ? input - cached : null, outputTokens: output, totalTokens: total };
}
function sumStage(stage, field) {
  if (!Array.isArray(stage) || stage.length === 0) return null;
  let result = 0;
  for (const entry of stage) {
    const value = count(entry[field]);
    if (value === null || !Number.isSafeInteger(result + value)) return null;
    result += value;
  }
  return result;
}
function normalEvents(raw) {
  let seen = false, terminal = false, input = null, cached = null, output = null, turns = 0;
  const tools = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    seen = true;
    if (event.type === 'turn.started') turns++;
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      terminal = true;
      if (event.usage) {
        input = count(event.usage.input_tokens);
        cached = count(event.usage.cached_input_tokens);
        output = count(event.usage.output_tokens);
      }
    }
    if (event.type === 'item.started' && event.item?.type === 'command_execution' && typeof event.item.id === 'string') tools.add(event.item.id);
    if (event.type === 'item.completed' && event.item?.type === 'command_execution' && typeof event.item.id === 'string') tools.add(event.item.id);
  }
  return { ...tokens(input, cached, output), turns: seen ? turns : null, toolCalls: seen ? tools.size : null, terminalObserved: terminal, usageSemantics: 'last cumulative session usage from Codex JSONL; no planner/coder stages' };
}
module.exports = { count, tokens, sumStage, normalEvents };
