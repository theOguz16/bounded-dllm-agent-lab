/** Offline replay of completed ABBA sessions; never invokes the Codex SDK. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRolloutTelemetry, comparePairedTelemetry,
  toolConfigIdentity, validateBoundedTelemetry, VERSION } from './rollout-telemetry.mjs';
import { readFileMcpConfig, MCP_SERVER_NAME, MCP_TOOL_NAME } from
  './identity-integration-config.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const defaultRoot=path.join(os.homedir(),'.bounded-agent','bounded-dllm-agent-lab',
  'live-runs','tool-control-abba-20261004-r1');
export async function replayHistoricalAbba(evidenceRoot=defaultRoot) {
  const plan=JSON.parse(await fs.readFile(path.join(here,'identity-bounded-plan.json')));
  const usage=JSON.parse(await fs.readFile(path.join(evidenceRoot,'usage-supplement.json')));
  const rows={};
  const expected={
    A1:[[11604,9984,1620],[11759,11008,751],[15955,11008,4947]],
    B1:[[10907,0,10907],[11061,0,11061],[12751,9984,2767]],
    B2:[[10907,0,10907],[11079,7936,3143],[12770,9984,2786]],
    A2:[[10905,3840,7065],[11099,9984,1115],[15294,9984,5310]]
  };
  for(const slot of ['A1','B1','B2','A2']) {
    const observation=JSON.parse(await fs.readFile(path.join(evidenceRoot,slot+'.json')));
    const options={sessionId:usage.observations[slot].sessionId,
      suppliedPrompt:plan.task.prompt+'\n'+plan.coderInstruction,
      mcpUseInstructionHash:plan.coderInstructionHash,
      toolConfigHash:toolConfigIdentity(
        readFileMcpConfig('/tmp/placeholder-checkout',observation.mcpMode),
        MCP_SERVER_NAME,MCP_TOOL_NAME).hash,
      expectedMode:observation.mcpMode,mcpObservation:observation};
    const result=validateBoundedTelemetry(await captureRolloutTelemetry(options));
    const again=await captureRolloutTelemetry(options);
    assert.equal(result.schemaVersion,VERSION);
    assert.equal(result.status,'observed');
    assert.equal(result.canonicalTrajectoryFingerprint,
      again.canonicalTrajectoryFingerprint);
    assert.equal(result.modelResponses.length,3);
    assert.deepEqual(result.modelResponses.map(x=>x.phase),
      ['pre_tool_discovery','tool_call_generation','post_tool_result']);
    assert.deepEqual(result.modelResponses.map(x=>x.mcpResultsDeliveredBeforeResponse),
      [0,0,1]);
    assert.equal(result.mcpResults.length,1);
    assert.equal(result.mcpResults[0].status,'completed');
    assert.equal(result.mcpResults[0].representation,'direct');
    assert.equal(result.mcpResults[0].deliveredBeforeResponse,3);
    assert.deepEqual(result.modelResponses.map(x=>
      [x.inputTokens,x.cachedInputTokens,x.uncachedInputTokens]),expected[slot]);
    assert.equal(result.suppliedPromptIdentity.hash,plan.fullCoderPromptHash);
    assert.equal(result.mcpResults[0].coderFacingHash,
      observation.coderFacingResultHash);
    assert.equal(result.modelResponses.reduce((n,x)=>n+x.inputTokens,0),
      observation.coderInput);
    assert.equal(result.modelResponses.reduce((n,x)=>n+x.cachedInputTokens,0),
      observation.coderCachedInput);
    assert.equal(result.modelResponses.reduce((n,x)=>n+x.outputTokens,0),
      observation.coderOutput);
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes(plan.task.prompt),false);
    assert.equal(serialized.includes('const KNOWN_EVENTS'),false);
    assert.equal(serialized.includes('Use research_read_file.read_file'),false);
    rows[slot]=result;
  }
  assert.equal(rows.A2.preMcpAssistantActivity,true);
  assert.equal(rows.A1.ambientInstruction.totalBytes,10275);
  for(const slot of ['B1','B2','A2'])
    assert.equal(rows[slot].ambientInstruction.totalBytes,7312);
  const first=comparePairedTelemetry(rows.B1,rows.A1);
  const second=comparePairedTelemetry(rows.B2,rows.A2);
  assert.ok(first.flags.some(x=>x.code==='AMBIENT_INSTRUCTION_DRIFT'));
  assert.equal(first.cleanAmbientIdentity,false);
  assert.equal(second.cleanAmbientIdentity,true);
  return {status:'PASS',schemaVersion:VERSION,
    responseCounts:Object.fromEntries(Object.entries(rows).map(
      ([slot,row])=>[slot,row.modelResponses.length])),
    ambientBytes:Object.fromEntries(Object.entries(rows).map(
      ([slot,row])=>[slot,row.ambientInstruction.totalBytes])),
    postToolResponseBoundariesReliable:true,
    a1AmbientDriftDetected:true,
    pairAudits:{B1_A1:first,B2_A2:second},
    rawContentPersisted:false,providerModelCalls:0,liveSessions:0};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const root=process.argv[2] ?? defaultRoot;
  process.stdout.write(JSON.stringify(await replayHistoricalAbba(root),null,2)+'\n');
}
