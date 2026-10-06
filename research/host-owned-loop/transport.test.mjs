import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {buildRequest,identity,runTransportLoop,persistTelemetry} from './loop.mjs';
import {buildChatPayload,extractUsage,createMockChatTransport,createOpenAIChatTransport,
  validateTransportReceipts,ENDPOINT} from './transport.mjs';
import {compileCanonicalPolicy,createCanonicalRepositoryContentSnapshot} from '../../dist/packages/product-runtime/src/canonical-policy-compiler.js';
import {createAcceptanceCriteriaContract} from '../../dist/packages/product-runtime/src/acceptance-criteria-contract.js';
import {createTaskToSeedImplementationContract} from '../../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js';
const model='gpt-5.6-luna',reasoning='medium';
const hash=s=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
const before='export const answer = 1;\n',after='export const answer = 2;\n';
const makeRequest=(sequence=1,history=[])=>buildRequest({trustedTask:{objective:'fixture'},suppliedEvidence:[],
  candidateEdits:[],history},{sequence,model,reasoning}).request;
const rawUsage={prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:64,cache_write_tokens:8},
  completion_tokens_details:{reasoning_tokens:5}};
const answer=(name,args,id='call_1')=>({status:200,body:{id:'fixture',model,
  choices:[{index:0,message:{role:'assistant',content:null,...(name?{tool_calls:[{id,type:'function',
    function:{name,arguments:JSON.stringify(args)}}]}:{})},finish_reason:name?'tool_calls':'stop'}],usage:rawUsage}});
async function withJournal(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'host-transport-test-'));
  const source=path.join(dir,'source');await fs.mkdir(source);
  const options={journalPath:path.join(dir,'calls.sqlite'),sourceRepositoryPath:source,
    sessionId:'offline-transport',model,reasoning};
  try{await fn(options,dir,source);}finally{await fs.rm(dir,{recursive:true,force:true});}
}
const journalRows=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT record_json FROM provider_invocations').all().map(r=>JSON.parse(r.record_json));}finally{db.close();}};

test('wire encoding preserves ordered content, host tools, reasoning and identities; has no native tools or implicit conversation',()=>{
  const history=[{kind:'assistant_response',assistant:{text:'read',toolCall:{id:'call_1',name:'read_file',arguments:{path:'src/a.ts'}}}},
    {kind:'tool_result',callId:'call_1',result:{content:'exact result',path:'src/a.ts'}}];
  const request=makeRequest(2,history), original=identity(request).hash;
  const body=buildChatPayload(request);
  assert.deepEqual(body.messages.map(m=>m.role),['system','user','assistant','tool']);
  assert.equal(body.messages[3].content,request.messages[3].content);
  assert.equal(JSON.parse(body.messages[2].tool_calls[0].function.arguments).path,'src/a.ts');
  assert.deepEqual(body.tools.map(t=>t.function.parameters),request.tools.map(t=>t.parameters));
  assert.deepEqual(body.tools.map(t=>t.function.name),['read_file','update_file']);
  assert.equal(body.reasoning_effort,reasoning);assert.equal(body.model,model);
  assert.equal(body.metadata.application_request_hash,original);assert.equal(body.metadata.retained_state_hash,request.retainedStateHash);
  assert.equal(body.parallel_tool_calls,false);assert.equal(body.store,false);
  assert.equal('previous_response_id' in body,false);assert.equal('conversation' in body,false);
  assert.equal(identity(request).hash,original);
  assert.equal(identity(buildChatPayload(request)).hash,identity(body).hash);
  assert.throws(()=>{body.messages[0].content='mutate';});
  assert.equal(ENDPOINT,'https://api.openai.com/v1/chat/completions');
});
test('usage preserves observed fields, derives uncached only with both values, leaves unavailable values null',()=>{
  assert.deepEqual(extractUsage(rawUsage),{input:100,cachedInput:64,uncachedInput:36,output:20,reasoningOutput:5,cacheWriteInput:8});
  assert.deepEqual(extractUsage({prompt_tokens:7,completion_tokens:2}),{input:7,cachedInput:null,uncachedInput:null,output:2,reasoningOutput:null,cacheWriteInput:null});
  assert.deepEqual(extractUsage(undefined),{input:null,cachedInput:null,uncachedInput:null,output:null,reasoningOutput:null,cacheWriteInput:null});
  assert.throws(()=>extractUsage({prompt_tokens:1,prompt_tokens_details:{cached_tokens:2}}));
  assert.throws(()=>extractUsage({completion_tokens:-1}));
});
test('existing durable journal reserves/starts/completes exact requests and blocks same-session and new-session replay',async()=>withJournal(async(options)=>{
  const provider=createMockChatTransport(options,[answer('read_file',{path:'src/a.ts'})]);
  const request=makeRequest();const response=await provider.complete(request);
  assert.equal(response.assistant.toolCall.name,'read_file');assert.equal(provider.realProviderCalls,0);
  assert.equal(provider.httpDispatches,1);assert.equal(journalRows(options.journalPath)[0].state,'completed');
  assert.equal(provider.receipts[0].applicationRequestHash,identity(request).hash);
  assert.equal(provider.receipts[0].usageProvenance,'fixture');
  await assert.rejects(()=>provider.complete(request),e=>e.code==='TRANSPORT_REQUEST_INVALID');
  const reopened=createMockChatTransport(options,[answer(null)]);
  await assert.rejects(()=>reopened.complete(request),e=>e.code==='invocation_replay_forbidden');
  const other=createMockChatTransport({...options,sessionId:'different-session'},[answer(null)]);
  await assert.rejects(()=>other.complete(request),e=>e.code==='invocation_replay_forbidden');
  assert.equal(reopened.httpDispatches+other.httpDispatches,0);
  validateTransportReceipts(provider.receipts);
}));
test('truncation, malformed JSON arguments, multiple tools, unauthorized tools and refusal stop without retry; usage retained',async()=>{
  for(const variant of ['length','bad_args','multiple','shell','refusal'])await withJournal(async(options)=>{
    const response=answer('read_file',{path:'src/a.ts'});
    if(variant==='length')response.body.choices[0].finish_reason='length';
    if(variant==='bad_args')response.body.choices[0].message.tool_calls[0].function.arguments='{';
    if(variant==='multiple')response.body.choices[0].message.tool_calls.push(structuredClone(response.body.choices[0].message.tool_calls[0]));
    if(variant==='shell')response.body.choices[0].message.tool_calls[0].function.name='shell';
    if(variant==='refusal')response.body.choices[0].message.refusal='not returned';
    const provider=createMockChatTransport(options,[response,answer(null)]);
    await assert.rejects(()=>provider.complete(makeRequest()));
    assert.equal(provider.httpDispatches,1);assert.equal(provider.receipts[0].usage.input,100);
    if(variant==='length'){assert.equal(provider.receipts[0].finishReason,'length');assert.equal(provider.receipts[0].responseStatus,'incomplete');}
    assert.equal(journalRows(options.journalPath)[0].state,'outcome_unknown');
    await assert.rejects(()=>provider.complete(makeRequest(2)));
    assert.equal(provider.httpDispatches,1);
  });
});
test('HTTP rejection is terminal and raw body/key/source cannot enter receipts or journal',async()=>withJournal(async(options,dir)=>{
  const sentinel='PRIVATE_RAW_RESPONSE_8342';
  const provider=createMockChatTransport(options,[{status:401,body:{error:{message:sentinel}}}]);
  await assert.rejects(()=>provider.complete(makeRequest()),e=>e.code==='TRANSPORT_HTTP_FAILED');
  const text=JSON.stringify(provider.receipts)+JSON.stringify(journalRows(options.journalPath));
  assert.equal(text.includes(sentinel),false);assert.equal(provider.receipts[0].usage,null);
  assert.equal(provider.receipts[0].journalState,'failed');
  const forged=structuredClone(provider.receipts);forged[0].rawBody=sentinel;
  assert.throws(()=>validateTransportReceipts(forged));
  await assert.rejects(()=>provider.complete(makeRequest(2)));assert.equal(provider.httpDispatches,1);
}));
test('credential, endpoint/config, sequence and journal-location checks block before dispatch',async()=>withJournal(async(options)=>{
  assert.throws(()=>createOpenAIChatTransport(options),e=>e.code==='API_CREDENTIAL_UNAVAILABLE');
  assert.throws(()=>createMockChatTransport({...options,journalPath:path.join(options.sourceRepositoryPath,'calls.sqlite')},[]));
  const provider=createMockChatTransport(options,[]);
  await assert.rejects(()=>provider.complete(makeRequest(2)),e=>e.code==='TRANSPORT_REQUEST_INVALID');
  assert.equal(provider.httpDispatches,0);
}));
test('host loop via mock HTTP retains exact result, produces ordinary Candidate, preserves ceilings and persists bounded usage',async()=>withJournal(async(options,dir,source)=>{
  await fs.mkdir(path.join(source,'src'));await fs.writeFile(path.join(source,'src/a.ts'),before);
  const objective='Change answer to 2.';
  const acceptanceContract=createAcceptanceCriteriaContract({taskId:'transport.fixture',objectiveHash:identity({objective}).hash,
    criteria:[{id:'answer',description:objective,required:true,evidence:{kind:'test',commandId:'behavior'}}]});
  const contract=createTaskToSeedImplementationContract({taskId:'transport.fixture',objectiveHash:identity({objective}).hash,
    seedFiles:['src/a.ts'],acceptanceCriteriaContract:acceptanceContract});
  const provider=createMockChatTransport(options,[answer('read_file',{path:'src/a.ts'},'read_1'),
    answer('update_file',{path:'src/a.ts',expectedContentHash:hash(before),newContent:after},'update_1'),answer(null)]);
  const result=await runTransportLoop({repositoryPath:source,task:{objective,contract,acceptanceContract},
    policy:compileCanonicalPolicy({repositoryPath:source,policyDocument:{schemaVersion:'1',allowed_paths:['src/a.ts'],
      forbidden_paths:[],paired_files:[],sensitive_patterns:[]}}),sourceSnapshot:createCanonicalRepositoryContentSnapshot(source),
    readableFiles:['src/a.ts'],allowedFiles:['src/a.ts'],validationSpecification:{commands:[],allowedExecutables:[]},
    model,reasoning,provider});
  assert.equal(result.classification,'CANDIDATE_VERIFIED_STRUCTURALLY',JSON.stringify(result.telemetry));
  assert.equal(result.verifier.decision,'approve');assert.equal(result.candidate.claims[0].newContent,after);
  assert.equal(result.retainedState.history.find(h=>h.kind==='tool_result').result.content,before);
  assert.equal(result.telemetry.requests.length,3);assert.equal(result.telemetry.tools.length,2);
  assert.equal(result.telemetry.providerModelCalls,0);assert.equal(result.telemetry.fakeModelResponseSteps,0);
  assert.equal(result.telemetry.transportResponses.length,3);
  assert.equal(result.telemetry.requests[1].retainedStateHash,result.telemetry.states[1].retainedStateHash);
  const file=path.join(dir,'evidence.json');await persistTelemetry(file,result.telemetry);
  const data=await fs.readFile(file,'utf8');assert.equal(data.includes(before),false);assert.equal(data.includes(after),false);
  assert.equal(data.includes('src/a.ts'),false);assert.equal(await fs.readFile(path.join(source,'src/a.ts'),'utf8'),before);
  assert.equal(provider.httpDispatches,3);assert.equal(provider.realProviderCalls,0);
}));

test('fixed smoke task through mocked HTTP exercises real Candidate/oracle handoff without model calls',
  {skip:process.env.HOST_LOOP_CONTAINER_TEST!=='1'},async()=>withJournal(async(options,dir,source)=>{
  const {createSmokeTask,checkSmokeCandidate,summarizeSmoke,auditControl,SMOKE_MODEL,SMOKE_REASONING}=await import('./smoke.mjs');
  const input=await createSmokeTask(source);
  const sourceText=await fs.readFile(path.join(source,'src/answer.ts'),'utf8');
  const provider=createMockChatTransport({...options,model:SMOKE_MODEL,reasoning:SMOKE_REASONING},[
    answer('read_file',{path:'src/answer.ts'},'read_1'),
    answer('update_file',{path:'src/answer.ts',expectedContentHash:hash(sourceText),
      newContent:sourceText.replace('+ 1','+ 2')},'edit_1'),answer(null)]);
  const result=await runTransportLoop({...input,provider,checkCandidate:args=>checkSmokeCandidate({...args,specification:input.validationSpecification})});
  assert.equal(result.classification,'CANDIDATE_VERIFIED_STRUCTURALLY',JSON.stringify(result.telemetry));
  assert.equal(result.validation.decision,'temp_validation_passed',JSON.stringify(result.validation.issues));
  assert.deepEqual(auditControl(result),{requestWireIdentity:true,stateIdentity:true,exactReadResultInNextRequest:true,expectedToolSequence:true});
  const report=summarizeSmoke(input,result);
  assert.equal(report.verdict,'OFFLINE_FIXTURE_ONLY');assert.equal(report.acceptanceDecision,'contract_approved');
  assert.equal(report.realProviderModelCalls,0);assert.equal(report.sourceApply,0);assert.equal(report.ceilingStatus,true);
  assert.equal(report.validationProfileSatisfied,true);assert.equal(report.sourceUnchanged,true);
}));
