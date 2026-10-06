/** Exact offline replay of the first live identity telemetry smoke. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRolloutTelemetry, toolConfigIdentity,
  validateBoundedTelemetry, VERSION } from './rollout-telemetry.mjs';
import { readFileMcpConfig, APPROVED_SOURCE_PATH, MCP_SERVER_NAME, MCP_TOOL_NAME } from
  './identity-integration-config.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const defaultRoot=path.join(os.homedir(),'.bounded-agent','bounded-dllm-agent-lab',
  'live-runs','identity-telemetry-smoke-S7FhZ5');
export async function replayLatestSmoke(evidenceRoot=defaultRoot) {
  const plan=JSON.parse(await fs.readFile(path.join(here,'identity-bounded-plan.json')));
  const asRun=JSON.parse(await fs.readFile(path.join(evidenceRoot,'observation.json')));
  assert.equal(asRun.mode,'identity');
  assert.equal(asRun.responseTrajectory.schemaVersion,
    'research-mcp-response-trajectory/v1');
  assert.equal(asRun.responseTrajectory.canonicalTrajectoryFingerprint,
    'sha256:ab8c1b58d748732539f4380fceb3e21063a58d0e6f7d89620c703a791c523512');
  const options={sessionId:asRun.sessionId,
    suppliedPrompt:plan.task.prompt+'\n'+plan.coderInstruction,
    mcpUseInstructionHash:plan.coderInstructionHash,
    toolConfigHash:toolConfigIdentity(
      readFileMcpConfig('/tmp/identity-replay','identity'),
      MCP_SERVER_NAME,MCP_TOOL_NAME).hash,
    expectedMode:'identity',mcpObservation:asRun.observation};
  const result=validateBoundedTelemetry(await captureRolloutTelemetry(options));
  const again=validateBoundedTelemetry(await captureRolloutTelemetry(options));
  assert.equal(result.schemaVersion,VERSION);
  assert.equal(result.status,'observed');
  assert.equal(result.canonicalTrajectoryFingerprint,
    again.canonicalTrajectoryFingerprint);
  assert.deepEqual(result.modelResponses.map(r=>r.phase),
    ['pre_tool_discovery','tool_call_generation','post_tool_result']);
  assert.deepEqual(result.modelResponses.map(r=>r.mcpResultsDeliveredBeforeResponse),
    [0,0,1]);
  assert.equal(result.modelResponses[2].mcpResultDeliveredBeforeResponse,true);
  assert.equal(result.mcpResults.length,1);
  assert.equal(result.mcpResults[0].status,'completed');
  assert.equal(result.mcpResults[0].representation,'wrapped_json_text');
  assert.equal(result.mcpResults[0].deliveredBeforeResponse,3);
  assert.equal(result.mcpResults[0].coderFacingHash,
    asRun.observation.coderFacingResultHash);
  assert.deepEqual(result.modelResponses.map(r=>
    [r.inputTokens,r.cachedInputTokens,r.uncachedInputTokens]),
    [[10907,0,10907],[11064,9984,1080],[16046,9984,6062]]);
  const input=result.modelResponses.reduce((n,r)=>n+r.inputTokens,0);
  const cached=result.modelResponses.reduce((n,r)=>n+r.cachedInputTokens,0);
  const output=result.modelResponses.reduce((n,r)=>n+r.outputTokens,0);
  assert.deepEqual([input,cached,input-cached,output],
    [38017,19968,18049,136]);
  assert.equal(input,asRun.turnCompletedUsage.input_tokens);
  assert.equal(cached,asRun.turnCompletedUsage.cached_input_tokens);
  assert.equal(output,asRun.turnCompletedUsage.output_tokens);
  const serialized=JSON.stringify(result);
  assert.equal(serialized.includes(plan.task.prompt),false);
  assert.equal(serialized.includes(plan.coderInstruction),false);
  assert.equal(serialized.includes('const KNOWN_EVENTS'),false);
  const source=await fs.readFile(path.resolve(here,'../..',APPROVED_SOURCE_PATH),'utf8');
  assert.equal(serialized.includes(source),false);
  return {status:'PASS',schemaVersion:VERSION,
    phases:result.modelResponses.map(r=>r.phase),
    resultDeliveredBeforeResponse:result.mcpResults[0].deliveredBeforeResponse,
    input,cached,uncached:input-cached,
    oldFingerprintUnchanged:asRun.responseTrajectory.canonicalTrajectoryFingerprint,
    newFingerprint:result.canonicalTrajectoryFingerprint,
    rawContentPersisted:false,providerModelCalls:0,liveSessions:0};
}
if(process.argv[1]===fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(await replayLatestSmoke(
    process.argv[2] ?? defaultRoot),null,2)+'\n');
