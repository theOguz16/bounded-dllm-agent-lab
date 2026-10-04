#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndValidatePlan, offlineFairnessReplay, slotAuthority,
  validateCandidate, MCP_USE_INSTRUCTION, sha } from './identity-bounded-authority.mjs';
import { summarizeObservation } from './identity-bounded-observation.mjs';
import { readFileMcpConfig, APPROVED_SOURCE_PATH, MCP_SERVER_NAME,
  MCP_TOOL_NAME } from './identity-integration-config.mjs';
import { BOUNDED_TRANSFORMATION, BOUNDED_TRANSFORMATION_HASH,
  executeReadFile } from './read-file.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const {plan,planHash}=await loadAndValidatePlan();
const source=await fs.readFile(path.join(root,APPROVED_SOURCE_PATH));
const original=source.toString('utf8');
const common={checkoutRoot:root,allowedPaths:[APPROVED_SOURCE_PATH],
  arguments:{path:APPROVED_SOURCE_PATH},now:()=>100};
const identity=await executeReadFile({...common,mode:'identity'});
const bounded=await executeReadFile({...common,mode:'bounded'});
const boundedAgain=await executeReadFile({...common,mode:'bounded'});
assert.equal(identity.trusted.originalHash,bounded.trusted.originalHash);
assert.equal(identity.trusted.originalBytes,bounded.trusted.originalBytes);
assert.equal(identity.coder.text,original);
assert.equal(identity.telemetry.resultHash,identity.trusted.originalHash);
assert.notEqual(bounded.telemetry.resultHash,bounded.trusted.originalHash);
assert.ok(bounded.telemetry.coderBytes<identity.telemetry.coderBytes);
assert.equal(bounded.coder.text,boundedAgain.coder.text);
assert.equal(bounded.telemetry.resultHash,boundedAgain.telemetry.resultHash);
assert.equal(BOUNDED_TRANSFORMATION.version,'edge-lines-128/v1');
assert.equal(BOUNDED_TRANSFORMATION.edgeLines,128);
assert.equal(BOUNDED_TRANSFORMATION_HASH,plan.transformation.hash);
assert.equal(bounded.telemetry.originalBytes,18225);
assert.equal(bounded.telemetry.coderBytes,7154);
assert.equal(bounded.telemetry.reductionBytes,11071);
assert.equal(bounded.telemetry.reductionPercent,60.75);
assert.equal(plan.orderedSlots.map(x=>x.slot).join(','),'A1,B1,B2,A2');
assert.equal(plan.limits.maxProviderStages,4);
assert.deepEqual(plan.policy,{retry:0,repair:0,apply:0,contextExpansion:0});
assert.equal(plan.coderInstruction,MCP_USE_INSTRUCTION);
assert.equal(plan.coderInstructionHash,sha(MCP_USE_INSTRUCTION));
assert.equal(plan.planner.enabled,false);
assert.deepEqual(plan.selectedInitialContext.files,[]);
assert.equal(plan.tool.sameNativeShellAvailability,true);
assert.equal(plan.tool.approvalMode,'approve');
assert.deepEqual(plan.tool.arguments,{path:APPROVED_SOURCE_PATH});
for(const slot of plan.orderedSlots){
 const authority=slotAuthority(plan,slot,root);
 assert.equal(authority.promptHash,plan.fullCoderPromptHash);
 assert.equal(authority.prompt,`${plan.task.prompt}\n${plan.coderInstruction}`);
 assert.equal(authority.plannerPrompt,null);
 assert.deepEqual(authority.selectedInitialContext,plan.selectedInitialContext);
 assert.deepEqual(authority.validation,plan.task.validation);
 assert.equal(authority.nativeShellAvailable,true);
 assert.equal(authority.providerStages,1);
 assert.equal(authority.config.mcp_servers[MCP_SERVER_NAME].tools[MCP_TOOL_NAME].approval_mode,'approve');
 assert.deepEqual(authority.requestedArguments,{path:APPROVED_SOURCE_PATH});
 assert.equal(authority.config.mcp_servers[MCP_SERVER_NAME].args[2],slot.mode);
}
assert.throws(()=>readFileMcpConfig(root,'trimmed'));
assert.throws(()=>slotAuthority(plan,{...plan.orderedSlots[0],mode:'bounded'},root));
assert.deepEqual(validateCandidate(JSON.stringify({firstEvent:'thread.started',
  fifthEvent:'item.started'}),original),{candidateProduced:true,behaviorOracle:'PASS'});
assert.equal(validateCandidate(JSON.stringify({firstEvent:'thread.started',
  fifthEvent:'turn.failed'}),original).behaviorOracle,'FAIL');
const synthetic=[{type:'thread.started'},{type:'turn.started'},
 {type:'item.completed',item:{type:'mcp_tool_call',server:MCP_SERVER_NAME,tool:MCP_TOOL_NAME,
  arguments:{path:APPROVED_SOURCE_PATH},status:'completed',
  result:{content:[{type:'text',text:identity.coder.text}],
    _meta:{researchTelemetry:identity.telemetry}}}},
 {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({
   firstEvent:'thread.started',fifthEvent:'item.started'})}},
 {type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}];
const observation=summarizeObservation({plan,slot:plan.orderedSlots[0],events:synthetic,
  original:source,elapsedMs:12,expectedHead:plan.sourceHead,scopeStatus:'PASS'});
assert.equal(observation.behaviorOracle,'PASS');
assert.equal(observation.coderInput,100);
assert.equal(observation.coderUncachedInput,60);
assert.equal(observation.coderAmplification,null);
assert.equal(observation.mcpInvocationCount,1);
assert.equal(observation.mcpResultBeforeSubsequentCoderActivity,true);
assert.equal(observation.nativeSameFileReads,0);
assert.equal(observation.rawSourcePersisted,false);
assert.equal(observation.rawToolResultPersisted,false);
assert.equal(observation.rawPromptPersisted,false);
const contaminated=summarizeObservation({plan,slot:plan.orderedSlots[0],
  events:[...synthetic.slice(0,3),{type:'item.completed',item:{type:'command_execution',
    command:`git show HEAD:${APPROVED_SOURCE_PATH}`,status:'completed'}},
    ...synthetic.slice(3)],original:source,elapsedMs:13,
  expectedHead:plan.sourceHead,scopeStatus:'PASS'});
assert.equal(contaminated.nativeSameFileReads,1);
assert.equal(JSON.stringify(observation).includes(original),false);
const replay=await offlineFairnessReplay();
assert.equal(replay.status,'PASS');
assert.equal(replay.planHash,planHash);
assert.deepEqual(replay.orderedSlots,['A1','B1','B2','A2']);
assert.ok(Object.values(replay.fairness).every(Boolean));
assert.equal(replay.providerModelCalls,0);
assert.equal(replay.liveSessions,0);
console.log('identity/bounded authority offline PASS; provider/model calls 0; live sessions 0');
