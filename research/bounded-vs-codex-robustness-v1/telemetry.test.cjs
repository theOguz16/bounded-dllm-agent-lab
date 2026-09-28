'use strict';
const assert = require('node:assert/strict');
const { tokens, sumStage, normalEvents } = require('./telemetry.cjs');
assert.deepEqual(tokens(null, null, null), { inputTokens:null,cachedInputTokens:null,uncachedInputTokens:null,outputTokens:null,totalTokens:null });
assert.deepEqual(tokens(0, 0, 0), { inputTokens:0,cachedInputTokens:0,uncachedInputTokens:0,outputTokens:0,totalTokens:0 });
assert.deepEqual(tokens(10, 7, 2), { inputTokens:10,cachedInputTokens:7,uncachedInputTokens:3,outputTokens:2,totalTokens:12 });
assert.throws(() => tokens(4, 5, 1), /cached input exceeds/);
assert.equal(sumStage([], 'providerTurnCount'), null);
assert.equal(sumStage([{providerTurnCount:0}], 'providerTurnCount'), 0);
assert.equal(sumStage([{providerTurnCount:1},{providerTurnCount:null}], 'providerTurnCount'), null);
const normal = normalEvents([
 JSON.stringify({type:'thread.started',thread_id:'x'}),
 JSON.stringify({type:'turn.started'}),
 JSON.stringify({type:'item.started',item:{id:'c1',type:'command_execution'}}),
 JSON.stringify({type:'item.completed',item:{id:'c1',type:'command_execution'}}),
 JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:5,output_tokens:2}})
].join('\n'));
assert.equal(normal.turns,1); assert.equal(normal.toolCalls,1); assert.equal(normal.uncachedInputTokens,5);
assert.equal(normalEvents('{"type":"thread.started"}').toolCalls,0);
assert.equal(normalEvents('').toolCalls,null);
console.log('telemetry normalization: PASS');
