/** One fixed live smoke, not a benchmark. Importing this file makes no calls. */
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DEFAULT_LIMITS,identity,buildRequest,runTransportLoop,persistTelemetry} from './loop.mjs';
import {createOpenAIChatTransport,createMockChatTransport,ENDPOINT} from './transport.mjs';
import {compileCanonicalPolicy,createCanonicalRepositoryContentSnapshot} from '../../dist/packages/product-runtime/src/canonical-policy-compiler.js';
import {createAcceptanceCriteriaContract,evaluateAcceptanceCriteria} from '../../dist/packages/product-runtime/src/acceptance-criteria-contract.js';
import {createTaskToSeedImplementationContract} from '../../dist/packages/product-runtime/src/task-to-seed-implementation-contract.js';
import {runContainerizedWorkspaceExecution,checkValidationContainerInfrastructure} from '../../dist/packages/product-runtime/src/containerized-workspace-execution-runner.js';
import {buildTemporaryWorkspaceExecutionVerificationEvidence,buildValidationEvidence} from '../../dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js';

export const SMOKE_MODEL='gpt-5.6-luna',SMOKE_REASONING='medium';
export const SESSION='host-owned-loop-smoke-20261006-r1';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const git=args=>{
  const r=spawnSync('git',args,{cwd:repository,encoding:'utf8',timeout:30000,maxBuffer:65536});
  if(r.status!==0)fail('SMOKE_GIT_PREFLIGHT_FAILED');return r.stdout.trim();
};
export async function loadApiKey(){
  if(process.env.OPENAI_API_KEY?.trim())return process.env.OPENAI_API_KEY.trim();
  const file=process.env.HOST_LOOP_API_KEY_FILE;
  if(!file||!path.isAbsolute(file))fail('API_CREDENTIAL_UNAVAILABLE');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>8192||(stat.mode&0o077)!==0)fail('API_CREDENTIAL_UNAVAILABLE');
    const value=(await handle.readFile('utf8')).trim();
    if(!value||/[\r\n]/.test(value))fail('API_CREDENTIAL_UNAVAILABLE');return value;
  }finally{await handle.close();}
}
export async function createSmokeTask(root){
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src/answer.ts'),'export function answer(value: number): number { return value + 1; }\n');
  const objective='Change the existing answer function in src/answer.ts so it returns value + 2 for every number, preserving its TypeScript signature. First inspect src/answer.ts with read_file, then use update_file with the returned contentHash and full replacement text, then finish. Modify only that existing file. Do not run commands or create files.';
  const acceptanceContract=createAcceptanceCriteriaContract({taskId:'host.smoke.answer',objectiveHash:identity({objective}).hash,
    criteria:[{id:'answer.behavior',description:'answer(3) is 5 and answer(-2) is 0.',required:true,
      evidence:{kind:'test',commandId:'behavior'}}]});
  const contract=createTaskToSeedImplementationContract({taskId:'host.smoke.answer',objectiveHash:identity({objective}).hash,
    seedFiles:['src/answer.ts'],acceptanceCriteriaContract:acceptanceContract});
  const oracle="const assert=require('node:assert/strict');const {answer}=require('./build/answer.js');assert.equal(answer(3),5);assert.equal(answer(-2),0);";
  const validationSpecification={commands:[
    {id:'build',checkKind:'syntax',executable:'node',args:['node_modules/typescript/bin/tsc','--target','ES2022','--module','commonjs','--outDir','build','src/answer.ts'],generatedOutputRoots:['build'],timeoutMs:30000},
    {id:'typecheck',checkKind:'typecheck',executable:'node',args:['node_modules/typescript/bin/tsc','--noEmit','--strict','src/answer.ts'],timeoutMs:30000},
    {id:'behavior',checkKind:'behavior_test',executable:'node',args:['-e',oracle],timeoutMs:30000}
  ],allowedExecutables:['node'],maxCommands:3,defaultTimeoutMs:30000,maxTimeoutMs:30000,maxOutputChars:2000};
  return {repositoryPath:root,task:{objective,contract,acceptanceContract},
    policy:compileCanonicalPolicy({repositoryPath:root,policyDocument:{schemaVersion:'1',allowed_paths:['src/answer.ts'],
      forbidden_paths:[],paired_files:[],sensitive_patterns:[]}}),sourceSnapshot:createCanonicalRepositoryContentSnapshot(root),
    readableFiles:['src/answer.ts'],allowedFiles:['src/answer.ts'],validationSpecification,
    model:SMOKE_MODEL,reasoning:SMOKE_REASONING};
}
export async function checkSmokeCandidate({workspacePath,specification}){
  await fs.cp(path.join(repository,'node_modules/typescript'),path.join(workspacePath,'node_modules/typescript'),{recursive:true});
  await fs.mkdir(path.join(workspacePath,'.validation-output'));
  const snapshot=createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash;
  return await runContainerizedWorkspaceExecution({...specification,tempWorkspacePath:workspacePath,
    tempApplyDecision:'temp_apply_ready',tempWorkspaceCleanedUp:false},
    async()=>createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash===snapshot?null:
      {code:'smoke_candidate_changed',message:'Candidate changed during validation.',severity:'failure'});
}
export function auditControl(result){
  const checks={requestWireIdentity:true,stateIdentity:true,exactReadResultInNextRequest:false,
    expectedToolSequence:result.telemetry.tools.map(t=>t.name).join(',')==='read_file,update_file'};
  for(const receipt of result.telemetry.transportResponses){
    const request=result.telemetry.requests[receipt.sequence-1];
    if(!request||request.requestHash!==receipt.applicationRequestHash)checks.requestWireIdentity=false;
    if(!request||request.retainedStateHash!==receipt.retainedStateHash)checks.stateIdentity=false;
  }
  const state=result.retainedState;
  if(state&&state.history.length>=3&&result.telemetry.requests.length>=2){
    const read=state.history[2];
    if(read.kind==='tool_result'&&typeof read.result.content==='string'){
      const afterRead={...state,suppliedEvidence:[read.result],candidateEdits:[],history:state.history.slice(0,3)};
      const second=buildRequest(afterRead,{sequence:2,model:SMOKE_MODEL,reasoning:SMOKE_REASONING});
      // Canonical request equality proves exact tool data transfer; compare structured data as well.
      checks.exactReadResultInNextRequest=second.metadata.requestHash===result.telemetry.requests[1].requestHash&&
        identity(JSON.parse(second.request.messages.at(-1).content)).hash===identity(read.result).hash;
    }
  }
  return checks;
}
export function summarizeSmoke(input,result){
  const controls=auditControl(result);
  let acceptance=null,profile=null;
  if(result.validation){
    const evidence=buildTemporaryWorkspaceExecutionVerificationEvidence(input.validationSpecification,result.validation,true);
    acceptance=evaluateAcceptanceCriteria({contract:input.task.acceptanceContract,executionSpecification:input.validationSpecification,executionEvidence:evidence});
    profile=buildValidationEvidence({profile:'existing_function_bug_fix',structuralPassed:result.verifier?.decision==='approve',
      specification:input.validationSpecification,executionResult:result.validation});
  }
  const sourceUnchanged=createCanonicalRepositoryContentSnapshot(input.repositoryPath).snapshotHash===input.sourceSnapshot.snapshotHash;
  const usageFields=['input','cachedInput','uncachedInput','output','reasoningOutput','cacheWriteInput'];
  const responses=result.telemetry.transportResponses;
  const usageTotals=Object.fromEntries(usageFields.map(k=>[k,responses.length>0&&responses.every(r=>r.usage?.[k]!==null&&r.usage?.[k]!==undefined)?responses.reduce((n,r)=>n+r.usage[k],0):null]));
  const ceilingStatus=result.telemetry.requests.length<=3&&result.telemetry.toolSteps<=2&&
    result.telemetry.cumulativeApplicationRequestBytes<=DEFAULT_LIMITS.maxCumulativeRequestBytes&&
    result.telemetry.states.every(s=>s.retainedStateBytes<=DEFAULT_LIMITS.maxRetainedStateBytes);
  const lost=!controls.requestWireIdentity||!controls.stateIdentity||!sourceUnchanged||!ceilingStatus;
  const actualLive=result.telemetry.transportKind==='openai-chat-transport';
  const usageObserved=responses.length>0&&responses.every(r=>r.usage?.input!==null&&r.usage?.input!==undefined&&r.usage?.output!==null&&r.usage?.output!==undefined);
  const successful=usageObserved&&result.candidate!==null&&result.verifier?.decision==='approve'&&acceptance?.decision==='contract_approved'&&
    profile?.profileSatisfied&&Object.values(controls).every(Boolean);
  const verdict=!actualLive?'OFFLINE_FIXTURE_ONLY':lost?'HOST_OWNED_LOOP_CONTROL_LOST_WITH_REAL_PROVIDER':successful?'HOST_OWNED_LOOP_PROVEN_LIVE':
    responses.some(r=>r.responseStatus==='completed')?'REAL_TRANSPORT_WORKS_BUT_TASK_NOT_COMPLETED':'TRANSPORT_ADAPTER_INCOMPATIBLE';
  return {verdict,classification:result.classification,controls,sourceUnchanged,ceilingStatus,
    candidateHash:result.telemetry.candidateHash,verifierDecision:result.verifier?.decision??null,
    acceptanceDecision:acceptance?.decision??null,validationProfileSatisfied:profile?.profileSatisfied??null,
    validationChecks:result.validation?.commandResults.map(c=>({id:c.id,passed:c.passed,exitCode:c.exitCode}))??[],
    realProviderModelCalls:result.telemetry.providerModelCalls,
    completedModelResponses:responses.filter(r=>r.responseStatus==='completed').length,
    repositoryToolCalls:result.telemetry.toolSteps,usageTotals,sourceApply:0,retries:0,repairs:0,historicalArtifactsModified:0};
}
export async function runLiveSmoke(){
  // Missing credentials do not consume a session or count as a live attempt.
  const apiKey=await loadApiKey();
  assert.equal(git(['branch','--show-current']),'codex/host-owned-loop-offline');
  assert.equal(git(['status','--porcelain=v1']),'','smoke requires clean committed checkout');
  const localHead=git(['rev-parse','HEAD']);
  const remoteHead=git(['ls-remote','--heads','origin','refs/heads/codex/host-owned-loop-offline']).split('\t')[0];
  assert.equal(localHead,remoteHead,'adapter must be pushed before live execution');
  const issue=checkValidationContainerInfrastructure();if(issue)fail('SMOKE_VALIDATION_PREFLIGHT_FAILED');
  const outside=path.join(os.homedir(),'.bounded-agent/bounded-dllm-agent-lab');
  const output=path.join(outside,'live-runs',SESSION);
  await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
  await fs.mkdir(output,{recursive:false,mode:0o700}); // One task/session; existing directory blocks all reruns.
  await fs.writeFile(path.join(output,'session-start.json'),JSON.stringify({sessionId:SESSION,localHead,remoteHead,
    model:SMOKE_MODEL,reasoning:SMOKE_REASONING,endpoint:ENDPOINT,limits:DEFAULT_LIMITS,retry:0,repair:0,apply:0})+'\n',{flag:'wx',mode:0o600});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'host-live-smoke-source-'));
  try{
    const input=await createSmokeTask(root);
    const provider=createOpenAIChatTransport({apiKey,journalPath:path.join(outside,'provider-invocations.sqlite'),
      sourceRepositoryPath:repository,sessionId:SESSION,model:SMOKE_MODEL,reasoning:SMOKE_REASONING});
    const result=await runTransportLoop({...input,provider,checkCandidate:args=>checkSmokeCandidate({...args,specification:input.validationSpecification})});
    await persistTelemetry(path.join(output,'loop-evidence.json'),result.telemetry);
    const report={sessionId:SESSION,localHead,remoteHead,model:SMOKE_MODEL,reasoning:SMOKE_REASONING,
      endpoint:ENDPOINT,nativeModelIdentifierParity:true,nativeEndpointFramingParity:false,
      ...summarizeSmoke(input,result)};
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return {output,report};
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3||process.argv[2]!=='--live')fail('SMOKE_EXPLICIT_LIVE_FLAG_REQUIRED');
  runLiveSmoke().then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(error=>{
    const safe=['API_CREDENTIAL_UNAVAILABLE','SMOKE_GIT_PREFLIGHT_FAILED','SMOKE_VALIDATION_PREFLIGHT_FAILED'].includes(error?.code)?error.code:'SMOKE_PREFLIGHT_OR_EXECUTION_STOPPED';
    process.stderr.write(safe+'\n');process.exitCode=1;
  });
}
