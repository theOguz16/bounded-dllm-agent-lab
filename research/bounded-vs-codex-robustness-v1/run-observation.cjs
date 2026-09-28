#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {tokens,sumStage,normalEvents,count}=require('./telemetry.cjs');
const {installObservationOverlay}=require('./observation-overlay.cjs');
const {annotateBoundedTrajectory}=require('./trajectory-analysis.cjs');
const {parseSessionId,sessionPath,observationSlots,assertPreflightBinding,assertObservationAvailable}=require('./session-identity.cjs');
const root=__dirname,sourceRepo=path.resolve(root,'../..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'benchmark-manifest.json'),'utf8'));
const resultsRoot=process.env.ROBUSTNESS_RESULT_ROOT||path.join(os.homedir(),'.bounded-agent','bounded-dllm-agent-lab','live-runs','bounded-vs-codex-robustness-v1');
const sessionId=parseSessionId(process.argv.slice(2)),sessionDir=sessionPath(resultsRoot,sessionId),ledgerPath=path.join(sessionDir,'ledger.json');
if(process.argv.includes('--inspect-session')){
 const pre=JSON.parse(fs.readFileSync(path.join(sessionDir,'preflight.json'),'utf8'));
 const post=JSON.parse(fs.readFileSync(path.join(sessionDir,'post-push-preflight.json'),'utf8'));
 assertPreflightBinding(pre,post,sessionId);
 const slots=observationSlots(manifest,sessionId);
 const ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):[];
 if(!Array.isArray(ledger)||ledger.some((entry,index)=>entry.sessionId!==sessionId||entry.observationId!==slots[index]?.observationId||entry.state!=='completed')||fs.existsSync(path.join(sessionDir,'infrastructure-stop.json')))throw Error('session consumed or stopped');
 process.stdout.write(JSON.stringify({sessionId,benchmarkVersion:manifest.benchmarkVersion,sourceHead:manifest.sourceHead,model:manifest.model,reasoning:manifest.reasoning,availableObservationIds:slots.slice(ledger.length).map(s=>s.observationId),providerCalls:0})+'\n');
 process.exit(0);
}
const task=manifest.tasks.find(t=>t.taskId===process.argv[2]),system=process.argv[3];
if(!task||!['normal','bounded'].includes(system))throw Error('Usage: node run-observation.cjs R1 normal|bounded --session-id <id>');
const slots=observationSlots(manifest,sessionId),obsId=`${task.taskId}-${system}`,slot=slots.find(s=>s.obsId===obsId),position=slot.executionPosition,observationId=slot.observationId,obsDir=path.join(sessionDir,'observations',obsId);
function run(command,args,cwd,timeout=120000,env=process.env){const p=cp.spawnSync(command,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:100*1024*1024});return {status:p.status,stdout:p.stdout||'',stderr:p.stderr||'',error:p.error?.message||null,signal:p.signal||null};}
function must(command,args,cwd,timeout,env){const r=run(command,args,cwd,timeout,env);if(r.status!==0||r.error||r.signal)throw Error(`${command} ${args.join(' ')} failed: ${r.error||r.stderr.slice(0,1200)}`);return r.stdout.trim();}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function hashFile(file){return 'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function clone(prefix){const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),checkout=path.join(dir,'source');must('git',['clone','--local','--no-hardlinks','--quiet',sourceRepo,checkout],root);must('git',['checkout','--detach',manifest.sourceHead],checkout);return {dir,checkout};}
function prepare(checkout,{boundedGeneration=false}={}){must('npm',['ci','--offline','--ignore-scripts','--no-audit','--no-fund'],checkout,120000);must('npm',['run','build'],checkout,120000);if(boundedGeneration){must('npm',['run','build'],sourceRepo,120000);installObservationOverlay(checkout,sourceRepo);}must('node',[path.join(root,'prepare-source.cjs'),checkout],checkout,30000);const d=readDoctor(checkout);if(!d.ok)throw Error('Bounded doctor failed');}
function readDoctor(checkout){return JSON.parse(must('node',['dist/apps/cli/src/index.js','doctor','--json'],checkout,30000));}
function untracked(checkout){return must('git',['ls-files','--others','--exclude-standard','-z'],checkout,30000).split('\0').filter(Boolean);}
function snapshot(checkout){const files=untracked(checkout);return {head:must('git',['rev-parse','HEAD'],checkout),status:must('git',['status','--porcelain=v1','--untracked-files=all'],checkout),untracked:files,untrackedHashes:Object.fromEntries(files.map(f=>[f,hashFile(path.join(checkout,f))]))};}
function changed(checkout,before){const tracked=must('git',['diff','--name-only','HEAD'],checkout).split('\n').filter(Boolean),now=untracked(checkout);return [...new Set([...tracked,...now.filter(f=>!before.untracked.includes(f)),...now.filter(f=>before.untrackedHashes[f]&&hashFile(path.join(checkout,f))!==before.untrackedHashes[f]),...before.untracked.filter(f=>!now.includes(f))])].sort();}
function authority(){return {head:must('git',['rev-parse','HEAD'],sourceRepo),status:must('git',['status','--porcelain=v1'],sourceRepo)};}
function assertAuthority(expected){const actual=authority();if(actual.head!==expected||actual.status!=='')throw Error('authority source changed: '+JSON.stringify(actual));return actual;}
function parseBounded(raw){for(const line of raw.split(/\r?\n/).reverse()){try{const value=JSON.parse(line);if(value.command==='codex')return value;}catch{}}return null;}
function validationCommand(name,command,args,cwd){const start=process.hrtime.bigint(),r=run(command,args,cwd,300000),elapsedMs=Number(process.hrtime.bigint()-start)/1e6;fs.writeFileSync(path.join(obsDir,`validation-${name}.stdout`),r.stdout);fs.writeFileSync(path.join(obsDir,`validation-${name}.stderr`),r.stderr);if(r.error||r.signal||r.status===null)throw Error(`${name} validation infrastructure: ${r.error||r.signal}`);return {status:r.status===0?'PASS':'FAIL',exitCode:r.status,elapsedMs};}
function saveCandidateFiles(checkout,files){const out=path.join(obsDir,'candidate-files');for(const file of files){const src=path.join(checkout,file);if(!fs.existsSync(src))continue;const dest=path.join(out,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);}}
function extractMutation(checkout,rawFile){const extraction=run('node',[path.join(root,'extract-bounded-result.cjs'),checkout,rawFile],checkout,30000);if(extraction.status!==0)throw Error('Bounded durable result extraction failed: '+extraction.stderr.slice(0,1000));fs.writeFileSync(path.join(obsDir,'bounded-terminal-result.json'),extraction.stdout,{mode:0o600});const full=JSON.parse(extraction.stdout);return full.result?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput||null;}
function stageTelemetry(raw){const entries=raw?.tokens?.tokenObservability;if(!Array.isArray(entries))return {stages:null,turns:null,tools:null,contextExpansions:null};const names=['planner','coder'];const stages={};for(const name of names){const matching=entries.filter(e=>String(e.operation||'').toLowerCase().includes(name));stages[name]=matching.length?{initialEstimate:sumStage(matching,'initialPromptEstimatedTokens'),...tokens(sumStage(matching,'cumulativeInputTokens'),sumStage(matching,'cumulativeCachedInputTokens'),sumStage(matching,'outputTokens')),turns:sumStage(matching,'providerTurnCount'),tools:sumStage(matching,'toolCallCount')}:null;}return {stages,turns:sumStage(entries,'providerTurnCount'),tools:sumStage(entries,'toolCallCount'),contextExpansions:raw?.contextExpansionTelemetry??null};}
let generation=null,work=null,verify=null,ledger=null,reserved=false,sessionBound=false;
try{
 const pre=readJson(path.join(sessionDir,'preflight.json')),post=readJson(path.join(sessionDir,'post-push-preflight.json'));
 assertPreflightBinding(pre,post,sessionId);
 sessionBound=true;
 if(must('git',['branch','--show-current'],sourceRepo)!=='research/bounded-vs-codex-robustness-v1')throw Error('benchmark branch mismatch');
 assertAuthority(post.benchmarkHead);
 if(fs.existsSync(path.join(sessionDir,'infrastructure-stop.json')))throw Error('session infrastructure stop exists');
 ledger=fs.existsSync(ledgerPath)?readJson(ledgerPath):[];
 assertObservationAvailable(ledger,slots,obsId,obsDir);
 work=clone('robustness-generation-');prepare(work.checkout,{boundedGeneration:system==='bounded'});
 const before=snapshot(work.checkout);if(before.head!==manifest.sourceHead)throw Error('source SHA mismatch');
 fs.mkdirSync(obsDir,{mode:0o700});writeJson(path.join(obsDir,'before-source.json'),before);
 ledger.push({sessionId,observationId,obsId,executionPosition:position,taskId:task.taskId,system,taskHash:task.taskHash,sourceHead:manifest.sourceHead,state:'reserved',reservedAt:new Date().toISOString()});writeJson(ledgerPath,ledger);reserved=true;
 const start=process.hrtime.bigint();
 const env={...process.env,BOUNDED_CODEX_MODEL:manifest.model,BOUNDED_CODEX_INVOCATION_JOURNAL_PATH:path.join(sessionDir,'provider-invocations.sqlite'),...(system==='bounded'?{ROBUSTNESS_CODER_TRAJECTORY:'1'}:{})};
 if(system==='normal')delete env.ROBUSTNESS_CODER_TRAJECTORY;
 const command=system==='normal'?'codex':'node';
 const args=system==='normal'?['exec','--json','--model',manifest.model,'-c',`model_reasoning_effort="${manifest.reasoning}"`,'-c','approval_policy="never"','--sandbox','workspace-write','-C',work.checkout,task.providerPrompt]:['dist/apps/cli/src/index.js','codex','--task',task.providerPrompt,...task.allowedFiles.flatMap(f=>['--allow',f]),'--json'];
 generation=run(command,args,work.checkout,20*60*1000,env);
 const elapsedMs=Number(process.hrtime.bigint()-start)/1e6;
 const rawFile=path.join(obsDir,'raw.stdout');fs.writeFileSync(rawFile,generation.stdout,{mode:0o600});fs.writeFileSync(path.join(obsDir,'raw.stderr'),generation.stderr,{mode:0o600});
 if(generation.error||generation.signal||generation.status===null)throw Error('generation process infrastructure: '+(generation.error||generation.signal));
 const after={head:must('git',['rev-parse','HEAD'],work.checkout),status:must('git',['status','--porcelain=v1','--untracked-files=all'],work.checkout),changedFiles:changed(work.checkout,before)};writeJson(path.join(obsDir,'after-source.json'),after);
 if(after.head!==manifest.sourceHead)throw Error('generation source HEAD changed');
 let candidateFiles=[],candidateProduced=false,agentReported='unknown',boundedRaw=null,normalRaw=null,mutation=null;
 if(system==='normal'){
  normalRaw=normalEvents(generation.stdout);if(!normalRaw.terminalObserved&&generation.status!==0)throw Error('Normal generation failure has no terminal event');
  candidateFiles=after.changedFiles;candidateProduced=candidateFiles.length>0;agentReported=generation.status===0?'completed':'failed';
  fs.writeFileSync(path.join(obsDir,'candidate.patch'),run('git',['diff','--binary','HEAD'],work.checkout).stdout,{mode:0o600});
 }else{
  boundedRaw=parseBounded(generation.stdout);if(!boundedRaw)throw Error('Bounded generation output unparseable');
  if(boundedRaw.model!==manifest.model||boundedRaw.reasoning!==manifest.reasoning)throw Error('Bounded effective model/reasoning mismatch');
  if(after.changedFiles.length)throw Error('Bounded mutated source checkout');
  agentReported=boundedRaw.decision||'unreported';candidateFiles=boundedRaw.candidate?.files||[];
  if(boundedRaw.recovery?.registryRoot&&boundedRaw.taskId){mutation=extractMutation(work.checkout,rawFile);}
  if(candidateFiles.length&&!mutation)throw Error('Bounded Candidate reported without recoverable mutation');
  if(mutation){if(mutation.role!=='coder'||mutation.target!=='patchDraft'||!Array.isArray(mutation.claims)||!mutation.claims.length)throw Error('Bounded mutation shape ambiguous');candidateFiles=mutation.claims.map(c=>c.file).sort();candidateProduced=true;writeJson(path.join(obsDir,'bounded-candidate-mutation.json'),mutation);}
  const handoffPath=path.join(work.checkout,'.bounded/state/candidate-handoff.json');if(fs.existsSync(handoffPath))fs.copyFileSync(handoffPath,path.join(obsDir,'candidate-handoff.json'));
 }
 const unauthorizedFiles=candidateFiles.filter(f=>!task.allowedFiles.includes(f)),scope=candidateProduced&&unauthorizedFiles.length===0?'PASS':'FAIL';
 let build='NOT_RUN',typecheck='NOT_RUN',tests='NOT_RUN',behavior='NOT_RUN',patchBytes=null;
 if(candidateProduced && !(system==='bounded' && unauthorizedFiles.length)){
  verify=clone('robustness-validation-');prepare(verify.checkout);
  if(system==='normal'){for(const file of candidateFiles){const from=path.join(work.checkout,file),to=path.join(verify.checkout,file);if(fs.existsSync(from)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}else if(fs.existsSync(to))fs.rmSync(to);}}
  else{for(const claim of mutation.claims){if(typeof claim.file!=='string'||typeof claim.newContent!=='string'||typeof claim.expectedContentHash!=='string')throw Error('Bounded mutation claim ambiguous');const to=path.join(verify.checkout,claim.file);if(hashFile(to)!==claim.expectedContentHash)throw Error('Bounded Candidate source hash mismatch: '+claim.file);fs.writeFileSync(to,claim.newContent);}}
  saveCandidateFiles(verify.checkout,candidateFiles);
  const patch=run('git',['diff','--binary','HEAD'],verify.checkout).stdout;fs.writeFileSync(path.join(obsDir,'candidate.patch'),patch,{mode:0o600});patchBytes=Buffer.byteLength(patch);
  build=validationCommand('build','npm',['run','build'],verify.checkout).status;
  typecheck=validationCommand('typecheck','npm',['run','typecheck'],verify.checkout).status;
  tests=validationCommand('test','npm',['test'],verify.checkout).status;
  const parts=task.oracle.replace('{benchmark}',root).replace('{candidate}',verify.checkout).split(' ');
  behavior=validationCommand('behavior',parts[0],parts.slice(1),verify.checkout).status;
 }
 const validation={scope,build,typecheck,tests,behavior};writeJson(path.join(obsDir,'validation.json'),validation);
 const t=system==='normal'?normalRaw:tokens(boundedRaw?.tokens?.input,boundedRaw?.tokens?.cached,boundedRaw?.tokens?.output);
 const boundedStage=system==='bounded'?stageTelemetry(boundedRaw):null;
 const trajectoryTelemetry=system==='bounded'?annotateBoundedTrajectory(boundedRaw?.coderTrajectoryTelemetry??null,boundedStage?.stages?.coder??null,boundedRaw?.context??null):null;
 if(system==='bounded')writeJson(path.join(obsDir,'coder-trajectory.json'),trajectoryTelemetry);
 const sourceUnchanged=assertAuthority(post.benchmarkHead).status===''&&after.head===manifest.sourceHead&&(system!=='bounded'||after.changedFiles.length===0);
 const normalized={benchmarkVersion:manifest.benchmarkVersion,sessionId,observationId,taskId:task.taskId,difficulty:task.difficulty,system,executionPosition:position,sourceHead:manifest.sourceHead,taskHash:task.taskHash,model:manifest.model,reasoning:manifest.reasoning,allowedFiles:task.allowedFiles,candidateFiles,changedFileCount:candidateFiles.length,unauthorizedFiles,approximatePatchBytes:patchBytes,candidateProduced,agentReported,sharedValidation:validation,benchmarkSuccess:Object.values(validation).every(x=>x==='PASS'),sourceUnchanged,applyState:'NOT_RUN',inputTokens:t.inputTokens,cachedInputTokens:t.cachedInputTokens,uncachedInputTokens:t.uncachedInputTokens,outputTokens:t.outputTokens,totalTokens:t.totalTokens,providerTurns:system==='normal'?normalRaw.turns:boundedStage.turns,toolCalls:system==='normal'?normalRaw.toolCalls:boundedStage.tools,elapsedMs,elapsedDefinition:'generation command wall time, excludes shared validation and dependency setup',stageTelemetry:boundedStage?.stages||null,contextExpansions:boundedStage?.contextExpansions??null,trajectoryTelemetry,normalUsageSemantics:normalRaw?.usageSemantics||null,boundedInternalValidation:boundedRaw?.validation||null,rawResultPath:rawFile,exitCode:generation.status};
 writeJson(path.join(obsDir,'normalized.json'),normalized);ledger.at(-1).state='completed';ledger.at(-1).completedAt=new Date().toISOString();writeJson(ledgerPath,ledger);
 if(ledger.length===slots.length)writeJson(path.join(sessionDir,'summary.json'),{schemaVersion:'robustness-summary/v1',sessionId,benchmarkVersion:manifest.benchmarkVersion,sourceHead:manifest.sourceHead,model:manifest.model,reasoning:manifest.reasoning,observationCount:ledger.length,observationIds:ledger.map(e=>e.observationId)});
 process.stdout.write(JSON.stringify({obsId,success:normalized.benchmarkSuccess,agentReported,candidateProduced,validation,elapsedMs})+'\n');
}catch(error){
 const event={sessionId,observationId,obsId,at:new Date().toISOString(),error:String(error.stack||error),classification:'infrastructure_or_ambiguous',providerMayHaveRun:!!generation};
 if(sessionBound&&fs.existsSync(obsDir))writeJson(path.join(obsDir,'infrastructure-event.json'),event);
 try{if(sessionBound&&fs.existsSync(sessionDir))writeJson(path.join(sessionDir,'infrastructure-stop.json'),event);}catch{}
 process.stderr.write(JSON.stringify(event)+'\n');process.exitCode=2;
}finally{if(work)fs.rmSync(work.dir,{recursive:true,force:true});if(verify)fs.rmSync(verify.dir,{recursive:true,force:true});}
