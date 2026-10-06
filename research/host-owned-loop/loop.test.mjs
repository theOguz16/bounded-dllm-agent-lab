import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, identity, buildRequest, createScriptedProvider,
  runOfflineLoop, persistTelemetry, validateTelemetry } from './loop.mjs';
import { compileCanonicalPolicy, createCanonicalRepositoryContentSnapshot } from '../../dist/packages/product-runtime/src/canonical-policy-compiler.js';
import { createAcceptanceCriteriaContract, evaluateAcceptanceCriteria } from '../../dist/packages/product-runtime/src/acceptance-criteria-contract.js';
import { createTaskToSeedImplementationContract } from '../../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js';
import { canonicalizeJson, hashCanonicalJson } from '../../dist/packages/product-runtime/src/agent-event-ledger.js';
import { runContainerizedWorkspaceExecution } from '../../dist/packages/product-runtime/src/containerized-workspace-execution-runner.js';
import { buildValidationEvidence, buildTemporaryWorkspaceExecutionVerificationEvidence } from '../../dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js';
import { createHash } from 'node:crypto';
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const before = 'export function answer(value: number): number { return value + 1; }\n';
const after = 'export function answer(value: number): number { return value + 2; }\n';
const sentinel = 'RAW_CONTENT_ONLY_IN_MEMORY_8742';
const scripted = () => [
  { assistant: { text: 'Read the authorized evidence.', toolCall: { id: 'read-1', name: 'read_file',
    arguments: { path: 'src/answer.ts' } } }, status: 'completed', finishReason: 'tool_calls', usage: null },
  { assistant: { text: 'Update the existing function.', toolCall: { id: 'edit-1', name: 'update_file',
    arguments: { path: 'src/answer.ts', expectedContentHash: digest(before), newContent: after } } },
    status: 'completed', finishReason: 'tool_calls', usage: null },
  { assistant: { text: 'Candidate prepared.', toolCall: null }, status: 'completed', finishReason: 'stop', usage: null }
];
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-loop-source-'));
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src/answer.ts'), before);
  await fs.writeFile(path.join(root,'src/read-only.ts'), `export const note = '${sentinel}';\n`);
  try {
    const policy = compileCanonicalPolicy({ repositoryPath: root, policyDocument: {
      schemaVersion:'1', allowed_paths:['src/answer.ts'], forbidden_paths:[], paired_files:[], sensitive_patterns:[] } });
    const objective = `Make answer(3) return 5. ${sentinel}`;
    const acceptanceContract = createAcceptanceCriteriaContract({ taskId:'offline.answer',
      objectiveHash:hashCanonicalJson({objective}), criteria:[{id:'answer.behavior', description:'answer(3) equals 5.',
        required:true, evidence:{kind:'test',commandId:'behavior'}}] });
    const contract = createTaskToSeedImplementationContract({taskId:'offline.answer',
      objectiveHash:hashCanonicalJson({objective}),seedFiles:['src/answer.ts'], acceptanceCriteriaContract:acceptanceContract});
    // Trusted validation commands only; they are NOT model-exposed tools.
    const oracle = "const assert=require('node:assert/strict'); const {answer}=require('./build/answer.js'); assert.equal(answer(3),5); assert.equal(answer(-2),0);";
    const validationSpecification = { commands: [
      {id:'build',checkKind:'syntax',executable:'node',args:['node_modules/typescript/bin/tsc',
        '--target','ES2022','--module','commonjs','--outDir','build','src/answer.ts'], generatedOutputRoots:['build'],timeoutMs:30000},
      {id:'typecheck',checkKind:'typecheck',executable:'node',args:['node_modules/typescript/bin/tsc',
        '--noEmit','--strict','src/answer.ts'],timeoutMs:30000},
      {id:'behavior',checkKind:'behavior_test',executable:'node',args:['-e',oracle],timeoutMs:30000}
    ], allowedExecutables:['node'], maxCommands:3,defaultTimeoutMs:30000,maxTimeoutMs:30000,maxOutputChars:2000 };
    const input = { repositoryPath:root, task:{objective,contract,acceptanceContract}, policy,
      sourceSnapshot:createCanonicalRepositoryContentSnapshot(root), readableFiles:['src/answer.ts','src/read-only.ts'],
      allowedFiles:['src/answer.ts'], validationSpecification };
    await fn(input,root);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}
async function run(input,responses=scripted(),overrides={}) {
  const provider = createScriptedProvider(responses);
  const result = await runOfflineLoop({...input, ...overrides, provider});
  assert.equal(provider.realProviderCalls,0);
  assert.equal(result.telemetry.providerModelCalls,0);
  return {result,provider};
}
const expectCode = (result,code) => { assert.equal(result.classification,code); assert.equal(result.candidate,null); };

test('canonical request/state identity is order-stable and sensitive to every request surface', () => {
  const state = {trustedTask:{b:2,a:1},suppliedEvidence:[],history:[],candidateEdits:[]};
  const config = {sequence:1,model:'scripted-fake-v1',reasoning:'none'};
  const a=buildRequest(state,config), b=buildRequest({...state,trustedTask:{a:1,b:2}},config);
  assert.equal(a.metadata.requestHash,b.metadata.requestHash);
  assert.equal(identity(state).hash,identity({...state,trustedTask:{a:1,b:2}}).hash);
  assert.equal(a.metadata.requestBytes,Buffer.byteLength(canonicalizeJson(a.request)));
  assert.equal(a.metadata.messageStateHash,identity(a.request.messages).hash);
  assert.equal(a.metadata.toolSchemaHash,identity(a.request.tools).hash);
  for(const change of [{sequence:2},{model:'other-fake'},{reasoning:'medium'}])
    assert.notEqual(buildRequest(state,{...config,...change}).metadata.requestHash,a.metadata.requestHash);
  assert.notEqual(buildRequest({...state,suppliedEvidence:[{content:'changed'}]},config).metadata.requestHash,a.metadata.requestHash);
  assert.notEqual(identity({...a.request,tools:[]}).hash,a.metadata.requestHash);
  assert.throws(()=>{a.request.messages[0].content='provider rewrite';},TypeError);
  assert.equal(state.history.length,0);
});

test('scripted read/update/final replay owns results, state, Candidate and existing verifier', async () => fixture(async(input,root)=>{
  const script=scripted(); const provider=createScriptedProvider(script);
  script[0].assistant.toolCall.arguments.path='../untrusted'; // Provider factory took its own copy.
  const first=await runOfflineLoop({...input,provider});
  const {result:second}=await run(input);
  assert.equal(first.classification,'CANDIDATE_VERIFIED_STRUCTURALLY',JSON.stringify(first.telemetry));
  assert.deepEqual(first.telemetry,second.telemetry);
  if (process.env.HOST_LOOP_EVIDENCE_PATH) await persistTelemetry(process.env.HOST_LOOP_EVIDENCE_PATH,first.telemetry);
  assert.deepEqual(first.candidate,second.candidate);
  assert.equal(first.verifier.decision,'approve');
  assert.equal(first.telemetry.policyDecision,'allow');
  assert.equal(first.telemetry.fakeModelResponseSteps,3);
  assert.equal(first.telemetry.toolSteps,2);
  assert.equal(provider.responseSteps,3);
  const history=first.retainedState.history;
  const tool=history.find(x=>x.kind==='tool_result');
  assert.equal(tool.result.content,before);
  assert.equal(tool.result.contentHash,digest(before));
  // Reconstruct precisely the host state before request 2 and compare to the recorded identity.
  const state2={...first.retainedState,history:history.slice(0,3),candidateEdits:[]};
  const request2=buildRequest(state2,{sequence:2,model:'scripted-fake-v1',reasoning:'none'});
  assert.equal(request2.metadata.requestHash,first.telemetry.requests[1].requestHash);
  assert.deepEqual(JSON.parse(request2.request.messages.at(-1).content),tool.result);
  assert.equal(first.telemetry.requests[1].retainedStateHash,first.telemetry.states[1].retainedStateHash);
  assert.equal(first.candidate.claims[0].expectedContentHash,digest(before));
  assert.equal(first.candidate.claims[0].newContent,after);
  assert.equal(await fs.readFile(path.join(root,'src/answer.ts'),'utf8'),before);
  assert.equal(createCanonicalRepositoryContentSnapshot(root).snapshotHash,input.sourceSnapshot.snapshotHash);
  assert.equal(first.telemetry.apply,'NOT_RUN');
}));

test('path traversal and malformed paths fail closed', async()=>fixture(async input=>{
  for(const p of ['../answer.ts','/tmp/answer.ts','src/../answer.ts','src\\answer.ts','src//answer.ts']){
    const script=scripted();script[0].assistant.toolCall.arguments.path=p;
    const {result}=await run(input,script);expectCode(result,'PATH_INVALID');
    assert.equal(result.telemetry.toolSteps,0);
  }
}));
test('unauthorized read, unauthorized update, arbitrary shell, extra arguments and repeated call IDs are denied', async()=>fixture(async input=>{
  let script=scripted();script[0].assistant.toolCall.arguments.path='src/missing.ts';
  expectCode((await run(input,script)).result,'READ_NOT_ALLOWED');
  script=scripted();script[1].assistant.toolCall.arguments.path='src/read-only.ts';
  expectCode((await run(input,script)).result,'UPDATE_NOT_ALLOWED');
  script=scripted();script[0].assistant.toolCall.name='shell';
  expectCode((await run(input,script)).result,'TOOL_NOT_ALLOWED');
  script=scripted();script[0].assistant.toolCall.arguments.command='anything';
  expectCode((await run(input,script)).result,'TOOL_ARGUMENTS_INVALID');
  script=scripted();script[1].assistant.toolCall.id='read-1';
  expectCode((await run(input,script)).result,'RESPONSE_INVALID');
}));
test('source authority, acceptance identity and symlink boundaries use existing gates', async()=>fixture(async(input,root)=>{
  expectCode((await run(input,scripted(),{sourceSnapshot:{...input.sourceSnapshot,snapshotHash:digest('wrong')}})).result,'AUTHORITY_INVALID');
  const task=structuredClone(input.task);task.acceptanceContract.objectiveHash=digest('forged');
  expectCode((await run(input,scripted(),{task})).result,'AUTHORITY_INVALID');
  await fs.writeFile(path.join(root,'src/answer.ts'),'drift');
  expectCode((await run(input)).result,'SOURCE_DRIFT');
  await fs.writeFile(path.join(root,'src/answer.ts'),before);
  await fs.unlink(path.join(root,'src/answer.ts'));
  await fs.symlink(path.join(root,'src/read-only.ts'),path.join(root,'src/answer.ts'));
  const policy=compileCanonicalPolicy({repositoryPath:root,policyDocument:{schemaVersion:'1',allowed_paths:['src/answer.ts'],forbidden_paths:[],paired_files:[],sensitive_patterns:[]}});
  const {result}=await run(input,scripted(),{policy,sourceSnapshot:createCanonicalRepositoryContentSnapshot(root)});
  assert.notEqual(result.classification,'CANDIDATE_VERIFIED_STRUCTURALLY');assert.equal(result.candidate,null);
}));
test('wrong source hash, no-op, create and unsafe Candidate fail closed', async()=>fixture(async input=>{
  let script=scripted();script[1].assistant.toolCall.arguments.expectedContentHash=digest('wrong');
  expectCode((await run(input,script)).result,'UPDATE_INVALID');
  script=scripted();script[1].assistant.toolCall.arguments.newContent=before;
  expectCode((await run(input,script)).result,'UPDATE_INVALID');
  script=scripted();script[1].assistant.toolCall.arguments.path='src/new.ts';
  expectCode((await run(input,script)).result,'READ_NOT_ALLOWED');
  script=scripted();script[1].assistant.toolCall.arguments.newContent='export const x = process.env.VALUE;\n';
  expectCode((await run(input,script)).result,'CANDIDATE_REJECTED');
}));
test('model-response ceiling prevents dispatch of the next fake response', async()=>fixture(async input=>{
  const {result,provider}=await run(input,scripted(),{limits:{maxModelResponses:2}});
  expectCode(result,'MODEL_RESPONSE_CEILING');assert.equal(provider.responseSteps,2);assert.equal(result.telemetry.requests.length,2);
}));
test('request-byte ceiling blocks first request and a later cumulative request before dispatch', async()=>fixture(async input=>{
  const {result:first,provider:p1}=await run(input,scripted(),{limits:{maxCumulativeRequestBytes:1}});
  expectCode(first,'REQUEST_BYTES_CEILING');assert.equal(p1.responseSteps,0);
  // A bound large enough for one request but insufficient for two; limits themselves are in request identity.
  const {result:later,provider:p2}=await run(input,scripted(),{limits:{maxCumulativeRequestBytes:5000}});
  expectCode(later,'REQUEST_BYTES_CEILING');assert.equal(p2.responseSteps,1);
}));
test('tool ceiling prevents the update tool from executing', async()=>fixture(async input=>{
  const {result}=await run(input,scripted(),{limits:{maxToolCalls:1}});
  expectCode(result,'TOOL_CALL_CEILING');assert.equal(result.telemetry.toolSteps,1);
  assert.equal(result.retainedState.candidateEdits.length,0);
}));
test('state ceiling blocks initial state and a large update before mutation', async()=>fixture(async input=>{
  const {result:first,provider}=await run(input,scripted(),{limits:{maxRetainedStateBytes:1}});
  expectCode(first,'STATE_BYTES_CEILING');assert.equal(provider.responseSteps,0);
  const script=scripted();script[1].assistant.toolCall.arguments.newContent='x'.repeat(20000);
  const {result}=await run(input,script,{limits:{maxRetainedStateBytes:10000}});
  expectCode(result,'STATE_BYTES_CEILING');assert.equal(result.telemetry.toolSteps,1);
  assert.equal(result.retainedState.candidateEdits.length,0);
}));
test('invalid limits, incomplete response, fabricated usage and no Candidate never succeed', async()=>fixture(async input=>{
  expectCode((await run(input,scripted(),{limits:{maxModelResponses:0}})).result,'LIMITS_INVALID');
  const script=scripted();script[0].usage={inputTokens:10};
  expectCode((await run(input,script)).result,'RESPONSE_INVALID');
  script[0].usage=null;script[0].status='truncated';
  expectCode((await run(input,script)).result,'RESPONSE_INVALID');
  expectCode((await run(input,[scripted()[2]])).result,'NO_CANDIDATE');
}));
test('only branded fake providers can execute; no fetch/network calls', async()=>fixture(async input=>{
  let dispatched=0;
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw new Error('unexpected network');};
  try {
    const result=await runOfflineLoop({...input,provider:{async complete(){dispatched++;throw new Error('live');}}});
    expectCode(result,'FAKE_PROVIDER_REQUIRED');assert.equal(dispatched,0);
    assert.equal((await run(input)).result.classification,'CANDIDATE_VERIFIED_STRUCTURALLY');
  } finally {globalThis.fetch=previous;}
}));
test('bounded persistence excludes raw content and recursively rejects injected metadata', async()=>fixture(async(input,root)=>{
  const {result}=await run(input);
  const output=path.join(root,'evidence.json');await persistTelemetry(output,result.telemetry);
  const text=await fs.readFile(output,'utf8');
  for(const raw of [sentinel,before,after,'Candidate prepared.','src/answer.ts'])assert.equal(text.includes(raw),false);
  assert.deepEqual(JSON.parse(text),result.telemetry);
  assert.throws(()=>validateTelemetry({...result.telemetry,rawPrompt:sentinel}));
  const forged=structuredClone(result.telemetry);forged.requests[0].source=sentinel;
  assert.throws(()=>validateTelemetry(forged));
  await assert.rejects(()=>persistTelemetry(output,result.telemetry)); // Exclusive, immutable evidence write.
  assert.equal(VERSION,result.telemetry.version);
}));

// Actual checker execution is separate from Candidate generation. It exposes no commands to the provider.
// Opt in only when an existing local Docker daemon/image is available; no pull or network.
test('existing container/build/typecheck/independent acceptance handoff accepts correct and rejects wrong behavior',
  {skip:process.env.HOST_LOOP_CONTAINER_TEST!=='1'}, async()=>fixture(async(input,root)=>{
  const checkCandidate = async({workspacePath})=>{
    // Existing read-only validation runner owns execution, no provider-selected commands.
    const pkgRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../node_modules/typescript');
    await fs.cp(pkgRoot,path.join(workspacePath,'node_modules/typescript'),{recursive:true});
    await fs.mkdir(path.join(workspacePath,'.validation-output'));
    const snapshot=createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash;
    const execution=await runContainerizedWorkspaceExecution({...input.validationSpecification,
      tempWorkspacePath:workspacePath,tempApplyDecision:'temp_apply_ready',tempWorkspaceCleanedUp:false},
      async()=>createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash===snapshot?null:
        {code:'candidate_integrity_changed',message:'Candidate changed during validation.',severity:'failure'});
    return execution;
  };
  const {result}=await run(input,scripted(),{checkCandidate});
  assert.equal(result.classification,'CANDIDATE_VERIFIED_STRUCTURALLY',JSON.stringify(result.telemetry));
  function assess(execution){
    // runOfflineLoop has already cleaned its owned workspace before returning.
    const evidence=buildTemporaryWorkspaceExecutionVerificationEvidence(input.validationSpecification,execution,true);
    const acceptance=evaluateAcceptanceCriteria({contract:input.task.acceptanceContract,
      executionSpecification:input.validationSpecification,executionEvidence:evidence});
    const profile=buildValidationEvidence({profile:'existing_function_bug_fix',structuralPassed:true,
      specification:input.validationSpecification,executionResult:execution});
    return {acceptance,profile};
  }
  assert.equal(result.validation.decision,'temp_validation_passed',JSON.stringify(result.validation.issues));
  assert.deepEqual(result.validation.commandResults.map(c=>[c.id,c.passed]),[['build',true],['typecheck',true],['behavior',true]]);
  const good=assess(result.validation);
  assert.equal(good.acceptance.decision,'contract_approved');assert.equal(good.profile.profileSatisfied,true);
  // Wrong implementation passes structural verification/typecheck, but the unchanged independent oracle fails.
  const wrong=scripted();wrong[1].assistant.toolCall.arguments.newContent=after.replace('+ 2','+ 3');
  const {result:bad}=await run(input,wrong,{checkCandidate});
  assert.equal(bad.verifier.decision,'approve');
  assert.equal(bad.validation.decision,'temp_validation_failed');assert.equal(assess(bad.validation).acceptance.decision,'contract_failed');
  assert.deepEqual(bad.validation.commandResults.map(c=>[c.id,c.passed]),[['build',true],['typecheck',true],['behavior',false]]);
  assert.equal(await fs.readFile(path.join(root,'src/answer.ts'),'utf8'),before);
}));
