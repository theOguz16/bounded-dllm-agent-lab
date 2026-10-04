/** Future live entrypoint. Importing this module never starts a provider session. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { loadAndValidatePlan, slotAuthority, SOURCE_HEAD } from './identity-bounded-authority.mjs';
import { summarizeObservation } from './identity-bounded-observation.mjs';
import { APPROVED_SOURCE_PATH } from './identity-integration-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const git=(cwd,args)=>{
 const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,
  maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 assert.equal(r.status,0,`git ${args[0]} failed`);
 return r.stdout.trim();
};
const save=async(file,value)=>{
 const serialized=JSON.stringify(value,null,2)+'\n';
 await fs.writeFile(file,serialized,{flag:'wx',mode:0o600});
};

/** Requires separate future human authorization; absent that, no SDK run is possible. */
export async function executeLiveAbba({authorizationPlanHash,sessionRoot}) {
 const {plan,planHash}=await loadAndValidatePlan({requireCommitted:true});
 assert.equal(authorizationPlanHash,planHash,'separate live authorization missing');
 assert.ok(path.isAbsolute(sessionRoot),'absolute session path required');
 assert.ok(!sessionRoot.startsWith(`${root}${path.sep}`),'evidence cannot be inside repository');
 assert.equal(git(root,['status','--short']),'');
 const localHead=git(root,['rev-parse','HEAD']);
 const remoteHead=git(root,['ls-remote','origin','refs/heads/research/context-token-matrix-v1'])
  .split('\t')[0];
 assert.equal(remoteHead,localHead);
 await fs.mkdir(sessionRoot,{recursive:false,mode:0o700});
 await save(path.join(sessionRoot,'plan-binding.json'),{planHash,localHead,remoteHead,
  orderedSlots:plan.orderedSlots.map(x=>x.slot),providerStageCeiling:4,
  retry:0,repair:0,apply:0,contextExpansion:0});
 const observations=[];
 let coderStages=0,stop=null;
 for(const slot of plan.orderedSlots){
  assert.ok(observations.length<plan.limits.maxObservations);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),`mcp-abba-${slot.slot}-`));
  try{
   const checkout=path.join(temp,'source');
   git(root,['clone','--quiet','--shared','--no-checkout','--',root,checkout]);
   git(checkout,['checkout','--quiet','--detach',SOURCE_HEAD]);
   assert.equal(git(checkout,['rev-parse','HEAD']),SOURCE_HEAD);
   assert.equal(git(checkout,['status','--short']),'');
   const authority=slotAuthority(plan,slot,checkout);
   const original=await fs.readFile(path.join(checkout,APPROVED_SOURCE_PATH));
   assert.ok(coderStages<plan.limits.maxProviderStages);
   const events=[];
   const start=Date.now();
   const client=new Codex({config:authority.config});
   const thread=client.startThread({model:authority.model,
    modelReasoningEffort:authority.reasoning,sandboxMode:authority.sandboxMode,
    workingDirectory:checkout,networkAccessEnabled:authority.networkAccessEnabled,
    webSearchMode:authority.webSearchMode,approvalPolicy:authority.approvalPolicy});
   coderStages++;
   let thrown=null;
   try{
    const streamed=await thread.runStreamed(authority.prompt,
      {signal:AbortSignal.timeout(authority.timeoutMs)});
    for await(const event of streamed.events)events.push(event);
   }catch(error){thrown={name:error?.name??'Error',messageHash:error?.message ?
      (await import('./identity-bounded-authority.mjs')).sha(error.message):null};}
   const scopeStatus=git(checkout,['status','--short'])===''?'PASS':'FAIL';
   const observation=summarizeObservation({plan,slot,events,original,
    elapsedMs:Date.now()-start,expectedHead:SOURCE_HEAD,scopeStatus});
   if(thrown)observation.failure={category:thrown.name==='TimeoutError'?'timeout':'sdk_exception',
    messageHash:thrown.messageHash};
   await save(path.join(sessionRoot,`${slot.slot}.json`),observation);
   observations.push({slot:slot.slot,classification:observation.failureTimeoutClassification,
    oracle:observation.behaviorOracle,mcpInvocations:observation.mcpInvocationCount});
   if(thrown||scopeStatus!=='PASS'||!observation.infrastructureHealthy||
      ['mcp_failed','provider_or_timeout_ambiguous'].includes(observation.failureTimeoutClassification)){
    stop=thrown?.name==='TimeoutError'?'timeout':'infrastructure_or_ambiguous';break;
   }
  }finally{await fs.rm(temp,{recursive:true,force:true})}
 }
 const summary={schemaVersion:'research-mcp-representation-summary/v1',planHash,
  observations,plannedObservations:4,executedObservations:observations.length,
  coderStages,plannerStages:0,providerModelStageInvocations:coderStages,
  retries:0,repairs:0,applies:0,contextExpansions:0,stop};
 await save(path.join(sessionRoot,'summary.json'),summary);
 return summary;
}
