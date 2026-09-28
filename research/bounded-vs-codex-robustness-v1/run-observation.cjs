#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root=__dirname;
const sourceRepo=path.resolve(root,'../../');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'benchmark-manifest.json'),'utf8'));
const resultsRoot=process.env.ROBUSTNESS_RESULT_ROOT || path.join(os.homedir(),'.bounded-agent','bounded-dllm-agent-lab','live-runs','bounded-vs-codex-robustness-v1');
const sessionDir=path.join(resultsRoot,manifest.sessionId);
const task=manifest.tasks.find(t=>t.taskId===process.argv[2]);
const system=process.argv[3];
if(!task||!['normal','bounded'].includes(system)) throw Error('Usage: node run-observation.cjs R1 normal|bounded');
const orderPosition=task.order.indexOf(system)+1;
const obsId=task.taskId+'-'+system;
const obsDir=path.join(sessionDir,'observations',obsId);
const ledgerPath=path.join(sessionDir,'ledger.json');
function run(command,args,cwd,timeout=120000,env=process.env) {
 const p=cp.spawnSync(command,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:100*1024*1024});
 return {status:p.status,stdout:p.stdout||'',stderr:p.stderr||'',error:p.error?.message||null,signal:p.signal||null};
}
function must(command,args,cwd,timeout,env) {const r=run(command,args,cwd,timeout,env); if(r.status!==0) throw Error(`${command} ${args.join(' ')} failed: ${r.error||r.stderr.slice(0,1200)}`);return r.stdout.trim();}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function hashFile(file){return 'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function clone(prefix){const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix)); const checkout=path.join(dir,'source');must('git',['clone','--local','--no-hardlinks','--quiet',sourceRepo,checkout],root);must('git',['checkout','--detach',manifest.sourceHead],checkout);return {dir,checkout};}
function prepare(checkout){must('npm',['ci','--offline','--ignore-scripts','--no-audit','--no-fund'],checkout,120000);must('npm',['run','build'],checkout,120000);
 const init='import fs from "node:fs/promises"; import {detectBoundedLocalConfig,BOUNDED_GITIGNORE_CONTENT,BOUNDED_DEFAULT_POLICY_CONTENT} from "./dist/apps/cli/src/product-config.js"; await fs.mkdir(".bounded",{recursive:true}); await fs.writeFile(".bounded/config.json",JSON.stringify(await detectBoundedLocalConfig(process.cwd()),null,2)+"\n"); await fs.writeFile(".bounded/.gitignore",BOUNDED_GITIGNORE_CONTENT); await fs.writeFile(".bounded/policy.yml",BOUNDED_DEFAULT_POLICY_CONTENT);';
 must('node',['--input-type=module','-e',init],checkout,30000);
 const doctor=JSON.parse(must('node',['dist/apps/cli/src/index.js','doctor','--json'],checkout,30000)); if(!doctor.ok)throw Error('Bounded doctor failed');
}
function status(checkout){return must('git',['status','--porcelain=v1','--untracked-files=all'],checkout,30000);}
function untracked(checkout){const output=must('git',['ls-files','--others','--exclude-standard','-z'],checkout,30000);return output.split('\0').filter(Boolean);}
function changed(checkout,before){const tracked=must('git',['diff','--name-only','HEAD'],checkout,30000).split('\n').filter(Boolean);const current=untracked(checkout);const fresh=current.filter(x=>!before.untracked.includes(x));const modified=current.filter(x=>before.untrackedHashes[x]&&hashFile(path.join(checkout,x))!==before.untrackedHashes[x]);const removed=before.untracked.filter(x=>!current.includes(x));return [...new Set([...tracked,...fresh,...modified,...removed])].sort();}
function parseNormal(raw){let last=null;let input=null,cached=null,output=null,turns=0,tools=0;for(const line of raw.split(/\r?\n/)){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue}if(e.type==='turn.started')turns++;if(e.type==='item.completed'&&e.item?.type==='command_execution')tools++;if(e.type==='turn.completed'&&e.usage){last=e.usage;input=Number.isSafeInteger(last.input_tokens)?last.input_tokens:null;cached=Number.isSafeInteger(last.cached_input_tokens)?last.cached_input_tokens:null;output=Number.isSafeInteger(last.output_tokens)?last.output_tokens:null;}}
 return {input,cached,output,turns:turns||null,tools:tools||null,usageSemantics:'last cumulative session usage from Codex JSONL; no stage split'};}
function parseBounded(raw){const lines=raw.split(/\r?\n/).filter(Boolean);for(let i=lines.length-1;i>=0;i--){try{const v=JSON.parse(lines[i]);if(v.command==='codex')return v;}catch{}}return null;}
function checkCmd(name,command,args,cwd){const start=process.hrtime.bigint();const r=run(command,args,cwd,300000);const elapsedMs=Number(process.hrtime.bigint()-start)/1e6;fs.writeFileSync(path.join(obsDir,`validation-${name}.stdout`),r.stdout);fs.writeFileSync(path.join(obsDir,`validation-${name}.stderr`),r.stderr);return {status:r.status===0?'PASS':'FAIL',exitCode:r.status,elapsedMs,error:r.error};}
let generation=null,validation=null,normalized=null,work=null,verify=null;
try{
 if(!fs.existsSync(path.join(sessionDir,'preflight.json')))throw Error('preflight record missing');
 const pf=JSON.parse(fs.readFileSync(path.join(sessionDir,'preflight.json'),'utf8'));if(!pf.ok||pf.providerCalls!==0)throw Error('preflight is not a zero-call PASS');
 if(must('git',['branch','--show-current'],sourceRepo)!=='research/bounded-vs-codex-robustness-v1')throw Error('benchmark branch mismatch');
 if(fs.existsSync(ledgerPath)){const ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));if(ledger.some(x=>x.obsId===obsId))throw Error('run identity already consumed');}
 if(fs.existsSync(obsDir))throw Error('observation directory already exists');
 work=clone('robustness-generation-');prepare(work.checkout);
 const before={head:must('git',['rev-parse','HEAD'],work.checkout),status:status(work.checkout),untracked:untracked(work.checkout)};before.untrackedHashes=Object.fromEntries(before.untracked.map(f=>[f,hashFile(path.join(work.checkout,f))]));
 if(before.head!==manifest.sourceHead)throw Error('source SHA mismatch');
 fs.mkdirSync(obsDir,{recursive:true,mode:0o700});writeJson(path.join(obsDir,'before-source.json'),before);
 const ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):[];
 ledger.push({obsId,taskId:task.taskId,system,taskHash:task.taskHash,sourceHead:manifest.sourceHead,state:'reserved',reservedAt:new Date().toISOString()});writeJson(ledgerPath,ledger);
 const start=process.hrtime.bigint();
 const env={...process.env,BOUNDED_CODEX_MODEL:manifest.model,BOUNDED_CODEX_INVOCATION_JOURNAL_PATH:path.join(sessionDir,'provider-invocations.sqlite')};
 const args=system==='normal' ? ['exec','--json','--model',manifest.model,'-c','model_reasoning_effort="medium"','-c','approval_policy="never"','--sandbox','workspace-write','-C',work.checkout,task.providerPrompt] : ['dist/apps/cli/src/index.js','codex','--task',task.providerPrompt,...task.allowedFiles.flatMap(f=>['--allow',f]),'--json'];
 const command=system==='normal'?'codex':'node';
 generation=run(command,args,work.checkout,20*60*1000,env);
 const elapsedMs=Number(process.hrtime.bigint()-start)/1e6;
 fs.writeFileSync(path.join(obsDir,'raw.stdout'),generation.stdout,{mode:0o600});fs.writeFileSync(path.join(obsDir,'raw.stderr'),generation.stderr,{mode:0o600});
 const after={head:must('git',['rev-parse','HEAD'],work.checkout),status:status(work.checkout),changedFiles:changed(work.checkout,before)};writeJson(path.join(obsDir,'after-source.json'),after);
 if(after.head!==manifest.sourceHead)throw Error('generation source HEAD changed');
 let candidateFiles=[],candidateProduced=false,agentReported='unknown',boundedRaw=null,normalRaw=null,handoff=null;
 if(system==='normal'){
  candidateFiles=after.changedFiles;candidateProduced=candidateFiles.length>0;agentReported=generation.status===0?'completed':'failed';normalRaw=parseNormal(generation.stdout);
  fs.writeFileSync(path.join(obsDir,'candidate.patch'),run('git',['diff','--binary','HEAD'],work.checkout).stdout,{mode:0o600});
 }else{
  boundedRaw=parseBounded(generation.stdout);agentReported=boundedRaw?.decision||'unparsed';candidateFiles=boundedRaw?.candidate?.files||[];candidateProduced=candidateFiles.length>0;
  const handoffPath=path.join(work.checkout,'.bounded/state/candidate-handoff.json');if(fs.existsSync(handoffPath)){handoff=JSON.parse(fs.readFileSync(handoffPath,'utf8'));fs.copyFileSync(handoffPath,path.join(obsDir,'candidate-handoff.json'));}
  if(after.changedFiles.length)throw Error('Bounded mutated source checkout');
 }
 if(generation.error||generation.signal)throw Error('generation process timeout/signal: '+(generation.error||generation.signal));
 let scopePass=false,build='NOT_RUN',typecheck='NOT_RUN',test='NOT_RUN',behavior='NOT_RUN',sourceUnchanged=system==='bounded'?after.changedFiles.length===0:true;
 if(candidateProduced && (system==='normal'||handoff)){
  verify=clone('robustness-validation-');prepare(verify.checkout);
  if(system==='normal'){
   for(const file of candidateFiles){const from=path.join(work.checkout,file),to=path.join(verify.checkout,file);if(fs.existsSync(from)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}else if(fs.existsSync(to))fs.rmSync(to);}
  }else{
   for(const claim of handoff.coderMutation.claims){const to=path.join(verify.checkout,claim.file);if(hashFile(to)!==claim.expectedContentHash)throw Error('Bounded Candidate source hash mismatch: '+claim.file);fs.writeFileSync(to,claim.newContent);}
   candidateFiles=handoff.coderMutation.claims.map(x=>x.file).sort();
  }
  scopePass=candidateFiles.every(f=>task.allowedFiles.includes(f)) && candidateFiles.length>0;
  if(scopePass){build=checkCmd('build','npm',['run','build'],verify.checkout).status;typecheck=checkCmd('typecheck','npm',['run','typecheck'],verify.checkout).status;test=checkCmd('test','npm',['test'],verify.checkout).status;
   if(build==='PASS'){const parts=task.oracle.replace('{benchmark}',root).replace('{candidate}',verify.checkout).split(' ');behavior=checkCmd('behavior',parts[0],parts.slice(1),verify.checkout).status;}
  }
  fs.writeFileSync(path.join(obsDir,'candidate.patch'),run('git',['diff','--binary','HEAD'],verify.checkout).stdout,{mode:0o600});
 }
 validation={scope:scopePass?'PASS':'FAIL',build,typecheck,test,behavior};writeJson(path.join(obsDir,'validation.json'),validation);
 const input=system==='normal'?normalRaw?.input:boundedRaw?.tokens?.input??null;
 const cached=system==='normal'?normalRaw?.cached:boundedRaw?.tokens?.cached??null;
 const output=system==='normal'?normalRaw?.output:boundedRaw?.tokens?.output??null;
 const turns=system==='normal'?normalRaw?.turns:(boundedRaw?.tokens?.tokenObservability||[]).reduce((n,x)=>n+(x.providerTurnCount||0),0)||null;
 const tools=system==='normal'?normalRaw?.tools:(boundedRaw?.tokens?.tokenObservability||[]).reduce((n,x)=>n+(x.toolCallCount||0),0)||null;
 normalized={benchmarkVersion:manifest.benchmarkVersion,sessionId:manifest.sessionId,taskId:task.taskId,difficulty:task.difficulty,system,sourceHead:manifest.sourceHead,taskHash:task.taskHash,executionOrder:orderPosition,model:manifest.model,reasoning:manifest.reasoning,allowedFiles:task.allowedFiles,candidateFiles,candidateProduced,agentReported,scopePass:validation.scope,build,typecheck,test,behavior,benchmarkSuccess:Object.values(validation).every(v=>v==='PASS'),sourceUnchanged,applyState:'NOT_RUN',inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:Number.isSafeInteger(input)&&Number.isSafeInteger(cached)?input-cached:null,outputTokens:output,totalTokens:Number.isSafeInteger(input)&&Number.isSafeInteger(output)?input+output:null,turns,toolCalls:tools,elapsedMs,rawResultPath:path.join(obsDir,'raw.stdout'),exitCode:generation.status,stageTelemetry:system==='bounded'?(boundedRaw?.tokens?.tokenObservability||null):null,normalUsageSemantics:normalRaw?.usageSemantics||null,boundedInternalValidation:boundedRaw?.validation||null};
 writeJson(path.join(obsDir,'normalized.json'),normalized);
 ledger.at(-1).state='completed';ledger.at(-1).completedAt=new Date().toISOString();writeJson(ledgerPath,ledger);
 process.stdout.write(JSON.stringify({obsId,success:normalized.benchmarkSuccess,agentReported,candidateProduced,validation,elapsedMs})+'\n');
}catch(error){
 const event={obsId,at:new Date().toISOString(),error:String(error.stack||error),classification:'infrastructure_or_ambiguous',providerMayHaveRun:!!generation};
 if(fs.existsSync(obsDir))writeJson(path.join(obsDir,'infrastructure-event.json'),event);
 process.stderr.write(JSON.stringify(event)+'\n');process.exitCode=2;
}finally{if(work)fs.rmSync(work.dir,{recursive:true,force:true});if(verify)fs.rmSync(verify.dir,{recursive:true,force:true});}
