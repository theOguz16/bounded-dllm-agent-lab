'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const repo = path.resolve(process.argv[2] || process.cwd());
  const { parseCodexJsonl } = await import(pathToFileURL(path.join(repo, 'dist/packages/integrations/src/codex-event-parser.js')).href);
  const parse = (events) => parseCodexJsonl(events.map((event) => JSON.stringify(event)).join('\n'));
  const usage = { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1 };
  for (const events of [
    [{ type: 'turn.completed', usage }],
    [{ type: 'thread.started', thread_id: 'a' }, { type: 'turn.completed', usage }],
    [{ type: 'thread.started', thread_id: 'a' }, { type: 'thread.started', thread_id: 'b' }, { type: 'turn.started' }, { type: 'turn.completed', usage }],
    [{ type: 'thread.started', thread_id: 'a' }, { type: 'turn.started' }, { type: 'turn.completed', usage }, { type: 'turn.completed', usage }]
  ]) {
    const result = parse(events);
    assert.equal(result.status, 'agent_protocol_invalid');
    assert.ok(result.diagnostics.some((item) => item.code === 'agent_protocol_invalid'));
  }
  const valid = parse([
    { type: 'thread.started', thread_id: 'a' },
    { type: 'turn.started' }, { type: 'turn.completed', usage },
    { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 3, output_tokens: 2 } }
  ]);
  assert.equal(valid.status, 'completed');
  assert.equal(valid.telemetry.providerTurnCount, 2);
  assert.equal(valid.telemetry.inputTokens, 9);
  process.stdout.write('event-order behavior PASS\n');
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
