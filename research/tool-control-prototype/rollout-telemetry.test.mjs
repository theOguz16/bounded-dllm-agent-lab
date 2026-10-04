import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reconstructRolloutTelemetry, comparePairedTelemetry,
  toolConfigIdentity, validateBoundedTelemetry, VERSION } from './rollout-telemetry.mjs';

const sha = x => 'sha256:' + createHash('sha256').update(x).digest('hex');
const prompt = 'SECRET_USER_PROMPT';
const original = 'SECRET_ORIGINAL_CONTENT';
const result = 'SECRET_TOOL_RESULT';
const observation = { mcpInvocationCount:1, mcpMode:'bounded',
  originalBytes:Buffer.byteLength(original), coderFacingBytes:Buffer.byteLength(result),
  originalResultHash:sha(original), coderFacingResultHash:sha(result) };
const config = { mcp_servers:{ research_read_file:{
  command:'node',args:['/repo/read-file.mjs','/tmp/random-checkout','bounded','file.ts'],
  tools:{read_file:{approval_mode:'approve'}} } } };
const tool = toolConfigIdentity(config,'research_read_file','read_file');
const options = { suppliedPrompt:prompt,mcpUseInstructionHash:sha('instruction'),
  toolConfigHash:tool.hash,expectedMode:'bounded',mcpObservation:observation };
const row = (type,payload) => JSON.stringify({type,payload});
const used = (input,cached,output,reasoning) => row('token_usage_record',{
  usage:{input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,
    output_tokens:output,reasoning_output_tokens:reasoning} });
function fixture(ambient = 'SECRET_AMBIENT',extraAssistant = false) {
  return [
    row('response_item',{type:'message',role:'developer',
      content:[{type:'input_text',text:ambient}]}),
    row('response_item',{type:'message',role:'user',
      content:[{type:'input_text',text:prompt}]}),
    ...(extraAssistant ? [row('response_item',{type:'message',role:'assistant',
      content:[{type:'output_text',text:'hello'}]})] : []),
    row('response_item',{type:'custom_tool_call',name:'exec',
      input:'const hits = ALL_TOOLS.filter(x => x.name.includes("research_read_file"))'}),
    used(100,40,10,3),
    row('response_item',{type:'custom_tool_call_output',output:[
      {type:'input_text',text:'tool metadata'}]}),
    row('response_item',{type:'custom_tool_call',name:'exec',
      input:'tools.mcp__research_read_file__read_file({path:"file.ts"})'}),
    used(110,50,11,4),
    row('response_item',{type:'custom_tool_call_output',output:[
      {type:'input_text',text:'tool wrapper'},{type:'input_text',text:result}]}),
    row('response_item',{type:'reasoning'}),
    row('response_item',{type:'message',role:'assistant',
      content:[{type:'output_text',text:'answer'}]}),
    used(150,60,12,5)
  ].join('\n');
}
const telemetry = validateBoundedTelemetry(reconstructRolloutTelemetry(fixture(),options));
assert.equal(telemetry.schemaVersion,VERSION);
assert.equal(telemetry.status,'observed');
assert.deepEqual(telemetry.modelResponses.map(x=>x.phase),
  ['pre_tool_discovery','tool_call_generation','post_tool_result']);
assert.deepEqual(telemetry.modelResponses.map(x=>x.inputTokens),[100,110,150]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.cachedInputTokens),[40,50,60]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.uncachedInputTokens),[60,60,90]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.reasoningOutputTokens),[3,4,5]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.cacheWriteInputTokens),[0,0,0]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.cumulativeToolCountBeforeResponse),
  [0,1,2]);
assert.deepEqual(telemetry.modelResponses.map(x=>x.mcpResultsDeliveredBeforeResponse),
  [0,0,1]);
assert.equal(telemetry.mcpResults[0].deliveredBeforeResponse,3);
assert.equal(telemetry.mcpResults[0].coderFacingHash,sha(result));
assert.equal(telemetry.mcpResults[0].coderFacingBytes,Buffer.byteLength(result));
assert.equal(telemetry.ambientInstruction.blocks[0].hash,sha('SECRET_AMBIENT'));
assert.equal(telemetry.suppliedPromptIdentity.hash,sha(prompt));
assert.notEqual(telemetry.ambientInstruction.combinedCanonicalHash,
  telemetry.suppliedPromptIdentity.hash);
assert.equal(telemetry.canonicalTrajectoryFingerprint,
  reconstructRolloutTelemetry(fixture(),options).canonicalTrajectoryFingerprint);
const serialized=JSON.stringify(telemetry);
for(const secret of [prompt,original,result,'SECRET_AMBIENT'])
  assert.equal(serialized.includes(secret),false);
assert.equal(reconstructRolloutTelemetry(fixture('SECRET_DIFFERENT_AMBIENT'),options)
  .suppliedPromptIdentity.hash,sha(prompt));
const other=reconstructRolloutTelemetry(fixture('SECRET_DIFFERENT_AMBIENT',true),options);
assert.equal(other.preMcpAssistantActivity,true);
assert.equal(other.modelResponses[0].phase,'pre_tool_discovery');
const drift=comparePairedTelemetry(telemetry,other);
assert.equal(drift.cleanAmbientIdentity,false);
assert.ok(drift.flags.some(x=>x.code==='AMBIENT_INSTRUCTION_DRIFT'));
assert.ok(drift.flags.some(x=>x.code==='AMBIENT_INSTRUCTION_BYTE_DRIFT'));
const same=comparePairedTelemetry(telemetry,reconstructRolloutTelemetry(fixture(),options));
assert.equal(same.cleanAmbientIdentity,true);
assert.equal(toolConfigIdentity({...config,mcp_servers:{research_read_file:{
  ...config.mcp_servers.research_read_file,
  args:['/repo/read-file.mjs','/tmp/other-checkout','identity','file.ts']}}},
  'research_read_file','read_file').hash,tool.hash);
assert.ok(telemetry.unavailable.includes('providerCacheKey'));
const extra=reconstructRolloutTelemetry(fixture()+'\n'+
  row('response_item',{type:'reasoning'})+'\n'+used(180,70,3,1),options);
assert.equal(extra.modelResponses[3].phase,'additional_post_tool_result');
assert.ok(comparePairedTelemetry(extra,telemetry).flags.some(
  x=>x.code==='UNEXPECTED_MODEL_RESPONSE_COUNT'));
const wrongPrompt=reconstructRolloutTelemetry(fixture(),
  {...options,suppliedPrompt:'DIFFERENT_PROMPT'});
assert.equal(wrongPrompt.status,'partial');
assert.ok(comparePairedTelemetry(wrongPrompt,telemetry).flags.some(
  x=>x.code==='SUPPLIED_PROMPT_DRIFT'));
const differentTool=reconstructRolloutTelemetry(fixture(),
  {...options,toolConfigHash:sha('different tool config')});
assert.ok(comparePairedTelemetry(differentTool,telemetry).flags.some(
  x=>x.code==='TOOL_CONFIGURATION_DRIFT'));
const differentInstruction=reconstructRolloutTelemetry(fixture(),
  {...options,mcpUseInstructionHash:sha('different instruction')});
assert.ok(comparePairedTelemetry(differentInstruction,telemetry).flags.some(
  x=>x.code==='MCP_USE_INSTRUCTION_DRIFT'));
const wrongMode=reconstructRolloutTelemetry(fixture(),
  {...options,expectedMode:'identity'});
assert.ok(comparePairedTelemetry(wrongMode,telemetry).flags.some(
  x=>x.code==='RESULT_MODE_MISMATCH'));
console.log('rollout-telemetry.test: PASS (real provider/model calls 0)');
