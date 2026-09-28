'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { installObservationOverlay, FILES, SOURCE } = require('./observation-overlay.cjs');
const { annotateBoundedTrajectory, summarizeBoundedObservation, analyzeSweep } = require('./trajectory-analysis.cjs');
const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmark-manifest.json')));
const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` :
  x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const hash = x => `sha256:${crypto.createHash('sha256').update(canonical(x)).digest('hex')}`;
const exec = (args, cwd = root) => {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function main() {
  const frozen = JSON.parse(exec(['show', 'eb0b501ba6d106730ba15c0e7f3dc3a5e4f5b496:research/bounded-vs-codex-robustness-v1/benchmark-manifest.json']));
  assert.deepEqual(manifest.tasks, frozen.tasks);
  assert.equal(manifest.sourceHead, SOURCE);
  assert.equal(manifest.model, 'gpt-5.6-luna');
  assert.equal(manifest.reasoning, 'medium');
  assert.deepEqual(manifest.tasks.map(t => t.order), [
    ['normal','bounded'],['bounded','normal'],['normal','bounded'],
    ['bounded','normal'],['normal','bounded']]);
  const sequence = manifest.tasks.flatMap(t => t.order.map(system => `${t.taskId}-${system}`));
  assert.equal(sequence.length,10); assert.equal(new Set(sequence).size,10);
  for (const task of manifest.tasks) {
    const { taskHash, ...definition } = task;
    assert.equal(hash(definition), taskHash);
    assert.equal(task.policy.boundedContext, 'production-current');
    assert.equal(task.policy.retry + task.policy.repair + task.policy.apply, 0);
  }
  assert.equal(fs.readFileSync(path.join(__dirname, 'PROTOCOL.md'), 'utf8').trimEnd(),
    exec(['show', 'eb0b501ba6d106730ba15c0e7f3dc3a5e4f5b496:research/bounded-vs-codex-robustness-v1/PROTOCOL.md']).trimEnd());
  const { deriveCodexCoderTrajectory } = await import(pathToFileURL(path.join(root,
    'dist/packages/integrations/src/codex-coder-trajectory.js')).href);
  const { CodexAgentAdapter } = await import(pathToFileURL(path.join(root,
    'dist/packages/integrations/src/codex-agent-adapter.js')).href);
  const events = [{ type:'thread.started',thread_id:'fixture' },{ type:'turn.started' },
    { type:'item.completed',item:{ id:'one',type:'command_execution',command:'SECRET_COMMAND',
      aggregated_output:'SECRET_OUTPUT',exit_code:0,status:'completed' } },
    { type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:10} },
    { type:'turn.started' },
    { type:'item.completed',item:{ id:'two',type:'command_execution',command:'SECRET_COMMAND_2',
      aggregated_output:'ok',exit_code:0,status:'completed' } },
    { type:'turn.completed',usage:{input_tokens:220,cached_input_tokens:160,output_tokens:20} }];
  const direct = deriveCodexCoderTrajectory(events.map(JSON.stringify).join('\n'));
  assert.equal(direct.status, 'observed');
  assert.deepEqual(direct.turns.map(t => t.inputDelta), [100,120]);
  assert.deepEqual(direct.turns.map(t => t.uncachedDelta), [40,20]);
  assert.deepEqual(direct.turns.map(t => t.toolCallsInTurn), [1,1]);
  assert.equal(direct.turns[1].newToolResultBytesSincePreviousTurn, 13);
  assert.equal(direct.tools[0].responseBytes, 13);
  assert.equal(direct.tools[0].responseTokenProvenance, 'estimated');
  assert.equal(JSON.stringify(direct).includes('SECRET_'), false);
  assert.equal(deriveCodexCoderTrajectory(JSON.stringify({type:'turn.started'})).turns[0].inputDelta, null);
  const invalid = deriveCodexCoderTrajectory([events[1],
    { type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:2,output_tokens:0} }]
    .map(JSON.stringify).join('\n'));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.turns[0].inputDelta, null);
  const missing = deriveCodexCoderTrajectory([events[1],{type:'turn.completed'}]
    .map(JSON.stringify).join('\n'));
  assert.equal(missing.turns[0].cumulativeInputTokens, null);
  const file = deriveCodexCoderTrajectory([events[1],
    {type:'item.completed',item:{id:'file',type:'file_change',changes:[{path:'src/a.ts'}]}},
    {type:'item.completed',item:{id:'bad',type:'file_change',changes:[{path:'../secret'}]}},
    {type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0}}]
    .map(JSON.stringify).join('\n'));
  assert.deepEqual(file.tools[0].referencedPaths, ['src/a.ts']);
  assert.equal(file.tools[1].referencedPaths, null);
  let calls = 0; const captured = {};
  const adapter = new CodexAgentAdapter({ clientFactory: () => ({ startThread(options) {
    captured.options = options; return { async runStreamed(input) {
      calls++; captured.prompt = input;
      return { events: (async function* () { for (const value of events) yield value; })() };
    } }; } }), now: () => 1000 });
  const result = await adapter.run({runId:'fixture',agentId:'codex',
    workingDirectory:'/tmp/bounded-workspace',task:'SECRET_PROMPT',model:'gpt-5.6-luna',
    reasoningEffort:'medium',mode:'coder',timeoutMs:10000,networkAllowed:false,
    sandboxMode:'workspace_write'});
  assert.equal(calls,1); assert.equal(captured.prompt,'SECRET_PROMPT');
  assert.equal(captured.options.model,'gpt-5.6-luna');
  assert.equal(result.usage.inputTokens,220); assert.equal(result.usage.cachedInputTokens,160);
  assert.equal(result.usage.providerTurnCount,2); assert.equal(result.usage.toolCallCount,2);
  assert.deepEqual(result.commands.map(x => x.command),['SECRET_COMMAND','SECRET_COMMAND_2']);
  assert.equal(result.trajectoryTelemetry.turns.length,2);
  const annotated = annotateBoundedTrajectory(result.trajectoryTelemetry,
    {initialEstimate:50},{fileCount:2,bytes:400,source:'SECRET_SOURCE',authority:'SECRET_AUTHORITY'});
  assert.equal(annotated.turns[0].promptEstimatedTokensBeforeTurn,50);
  assert.equal(annotated.turns[1].promptEstimatedTokensBeforeTurn,null);
  assert.equal(annotated.turns[1].selectedContextFileCount,null);
  assert.equal(JSON.stringify(annotated).includes('SECRET_'),false);
  const normal = {system:'normal',trajectoryTelemetry:null};
  assert.equal(normal.trajectoryTelemetry,null);
  const observation = {system:'bounded',taskId:'R1',inputTokens:300,
    stageTelemetry:{coder:{inputTokens:220,initialEstimate:50,turns:2,tools:2}},
    trajectoryTelemetry:annotated};
  const summary = summarizeBoundedObservation(observation);
  assert.equal(summary.coderAmplification,4.4);
  assert.equal(summary.coderShareOfCumulativeInput,0.7333);
  assert.deepEqual(summary.inputGrowthByTurn,[100,120]);
  assert.deepEqual(summary.uncachedGrowthByTurn,[40,20]);
  assert.equal(summary.toolResultBytes,15);
  assert.equal(analyzeSweep([observation]).toolActivityVsTraffic.comparable,0);
  const second = {...observation,taskId:'R2',stageTelemetry:{coder:{
    inputTokens:300,initialEstimate:50,turns:3,tools:3}}};
  assert.equal(analyzeSweep([observation,second]).toolActivityVsTraffic.sameDirection,1);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'robustness-overlay-test-'));
  try {
    const checkout = path.join(temp,'source');
    exec(['clone','--local','--no-hardlinks','--quiet',root,checkout]);
    exec(['checkout','--detach',SOURCE],checkout);
    for (const relative of FILES) fs.mkdirSync(path.dirname(path.join(checkout,'dist',relative)),{recursive:true});
    const overlay = installObservationOverlay(checkout);
    assert.equal(overlay.trackedSourceUnchanged,true);
    assert.equal(exec(['diff','--name-only','HEAD'],checkout),'');
    assert.equal(exec(['rev-parse','HEAD'],checkout),SOURCE);
    assert.equal(fs.readFileSync(path.join(checkout,'dist',FILES[0]),'utf8'),
      fs.readFileSync(path.join(root,'dist',FILES[0]),'utf8'));
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  console.log('robustness trajectory: PASS (fake provider calls 1; real provider calls 0)');
}
main().catch(error => { console.error(error); process.exitCode=1; });
