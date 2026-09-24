#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const modulePath = path.join(root, 'dist/packages/integrations/src/durable-invocation-journal.js');
const adapterPath = path.join(root, 'dist/packages/integrations/src/codex-agent-adapter.js');
const url = pathToFileURL(modulePath).href;
const fixture = (runId, stage='coder') => ({ runId, stage, task:'offline synthetic provider request', model:'gpt-5.6-luna', deadlineAt:Date.now()+30_000 });
const hash = (value) => 'sha256:'+require('node:crypto').createHash('sha256').update(value).digest('hex');
const key = (identity) => hash(JSON.stringify([identity.runId,identity.stage]));
const decision = (id, prior, next, stage='coder', task='offline synthetic provider request', model='gpt-5.6-luna') =>
  ({decisionId:id,supersedesRunId:prior,newRunId:next,stage,taskHash:hash(task),model});
function processResult(code, file, id) {
  const source = `import {createDurableInvocationJournal} from ${JSON.stringify(url)};\n`+
    `const j=createDurableInvocationJournal(${JSON.stringify(file)});`+
    `const input=${JSON.stringify(id)};`+code;
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,CODEX_API_KEY:'',OPENAI_API_KEY:''}});
    let stdout='';let stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    child.once('error',reject);child.once('exit',(status)=>done({status,stdout,stderr}));
  });
}
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'p7-7-journal-'));
 try {
  const {createDurableInvocationJournal,InvocationJournalError}=await import(url);
  const {CodexAgentAdapter}=await import(pathToFileURL(adapterPath).href);
  const file=path.join(temp,'authority.sqlite');
  const journal=createDurableInvocationJournal(file);
  const id=fixture('fixture.one');
  const reservation=journal.reserve(id);
  assert.equal(reservation.state,'prepared');
  assert.equal(journal.start(reservation.invocationKey).state,'started');
  assert.throws(()=>journal.reserve(id), error=>error instanceof InvocationJournalError&&error.code==='invocation_replay_forbidden');
  assert.equal(journal.read(reservation.invocationKey).state,'started');
  journal.recover(reservation.invocationKey);
  assert.equal(journal.read(reservation.invocationKey).state,'outcome_unknown');
  assert.throws(()=>journal.finish(reservation.invocationKey,'completed'),{code:'invocation_replay_forbidden'});
  assert.throws(()=>journal.reserve({...id,task:'modified prompt'}),{code:'invocation_replay_forbidden'});
  assert.throws(()=>journal.reserve(fixture('fixture.new-run')),{code:'invocation_replay_forbidden'});
  const firstDecision=decision('decision-new-run',id.runId,'fixture.new-run');
  journal.authorizeRetry(firstDecision);
  const newRun=journal.reserve({...fixture('fixture.new-run'),retryDecision:firstDecision});
  assert.equal(newRun.state,'prepared');
  journal.start(newRun.invocationKey);
  assert.equal(journal.recover(newRun.invocationKey).state,'outcome_unknown');
  assert.throws(()=>journal.reserve({...fixture('fixture.third'),retryDecision:firstDecision}),
    {code:'invocation_replay_forbidden'});
  const failed=fixture('fixture.failed','planner');
  const failedReservation=journal.reserve(failed);
  journal.start(failedReservation.invocationKey);
  const failedRecord=journal.finish(failedReservation.invocationKey,'failed',{
    failureCode:'provider_stream_error_unknown',
    diagnosticCodes:['codex_event_ignored','agent_protocol_invalid',
      'UNTRUSTED_MODEL_TEXT','sk-12345678901234567890'],
    workerDiagnostic:{version:'worker-failure-diagnostic/v1',stderrExcerpt:'UNTRUSTED_MODEL_TEXT'}
  });
  assert.equal(failedRecord.state,'failed');
  assert.equal(failedRecord.failureDetail,'codex_event_ignored;agent_protocol_invalid');
  assert.deepEqual(failedRecord.workerDiagnostic,
    {version:'worker-failure-diagnostic/v1',serializationTruncated:true});
  assert.doesNotMatch(JSON.stringify(failedRecord),/UNTRUSTED_MODEL_TEXT|sk-12345678901234567890/);
  assert.throws(()=>journal.recover(failedReservation.invocationKey),{code:'invocation_replay_forbidden'});
  // Recovery after a process crash must never turn a possibly charged attempt into a fresh slot.
  const crashDecision=decision('decision-crash','fixture.new-run','fixture.crashed');
  journal.authorizeRetry(crashDecision);
  const crashed={...fixture('fixture.crashed'),retryDecision:crashDecision};
  const exit=spawnSync(process.execPath,['--input-type=module','-e',
    `import {createDurableInvocationJournal} from ${JSON.stringify(url)};`+
    `const j=createDurableInvocationJournal(${JSON.stringify(file)});`+
    `const r=j.reserve(${JSON.stringify(crashed)});j.start(r.invocationKey);`+
    `console.log(JSON.stringify({invocationKey:r.invocationKey,recoveryId:r.recoveryId,ownerPid:r.ownerPid}));process.exit(0);`],
    {encoding:'utf8',env:{...process.env,CODEX_API_KEY:'',OPENAI_API_KEY:''}});
  assert.equal(exit.status,0,exit.stderr);
  const crashAuthority=JSON.parse(exit.stdout.trim());
  assert.throws(()=>journal.reserve(crashed),{code:'invocation_replay_forbidden'});
  assert.equal(journal.read(key(crashed)).state,'started');
  assert.throws(()=>journal.recover(key(crashed)),{code:'invocation_replay_forbidden'});
  assert.equal(journal.recoverCrashed(crashAuthority).state,'outcome_unknown');
  assert.throws(()=>journal.recoverCrashed(crashAuthority),{code:'invocation_replay_forbidden'});
  for (const terminalState of ['completed','failed']) {
    const terminalFile=path.join(temp,`terminal-${terminalState}.sqlite`);
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      `import {createDurableInvocationJournal} from ${JSON.stringify(url)};`+
      `const j=createDurableInvocationJournal(${JSON.stringify(terminalFile)});`+
      `const r=j.reserve({runId:'terminal',stage:'coder',task:'${terminalState}',`+
      `model:'offline',deadlineAt:Date.now()+30000});j.start(r.invocationKey);`+
      `j.finish(r.invocationKey,'${terminalState}');`+
      `console.log(JSON.stringify({invocationKey:r.invocationKey,recoveryId:r.recoveryId,ownerPid:r.ownerPid}));`],
      {encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    const authority=JSON.parse(child.stdout.trim());
    const terminalJournal=createDurableInvocationJournal(terminalFile);
    assert.throws(()=>terminalJournal.recoverCrashed(authority),{code:'invocation_replay_forbidden'});
    assert.equal(terminalJournal.read(authority.invocationKey).state,terminalState);
  }
  const lookupDecision=decision('decision-lookup','fixture.crashed','fixture.lookup');
  journal.authorizeRetry(lookupDecision);
  assert.equal(journal.read(journal.reserve({...fixture('fixture.lookup'),retryDecision:lookupDecision}).invocationKey).state,'prepared');
  assert.equal(journal.read('sha256:invalid'),null);
  // Distinct processes compete for exactly one transactional claim, never a read/rename race.
  const concurrent=fixture('fixture.concurrent');
  const concurrentFile=path.join(temp,'concurrent.sqlite');
  createDurableInvocationJournal(concurrentFile).read('sha256:unclaimed');
  const claim='try{j.reserve(input);console.log("claimed")}catch(e){console.log(e.code);process.exitCode=e.code==="invocation_replay_forbidden"?2:3}';
  const outcomes=await Promise.all([processResult(claim,concurrentFile,concurrent),processResult(claim,concurrentFile,concurrent)]);
  assert.deepEqual(outcomes.map(x=>x.status).sort(),[0,2],JSON.stringify(outcomes));
  assert.equal(outcomes.filter(x=>x.stdout.includes('claimed')).length,1);
  // Actual CodexAgentAdapter.run call boundary, not merely a disconnected journal utility.
  const adapterFile=path.join(temp,'adapter.sqlite');
  let chargeableCalls=0;
  const adapter=new CodexAgentAdapter({
   environment:{HOME:temp,PATH:process.env.PATH},authCheck:async()=>true,
   invocationJournalPath:adapterFile,
   clientFactory:()=>({startThread:()=>({runStreamed:async()=>{
     chargeableCalls++;
     return {events:(async function*(){yield {type:'thread.started',thread_id:'offline'};
       yield {type:'turn.started'};yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};})()};
   }})})
  });
  const request={runId:'adapter.one',agentId:'codex',workingDirectory:temp,
   task:'offline synthetic provider request',model:'gpt-5.6-luna',reasoningEffort:'none',
   mode:'baseline',timeoutMs:10_000,networkAllowed:false,sandboxMode:'workspace_write',repositoryRequirement:'none'};
  const first=await adapter.run(request);
  assert.equal(first.status,'completed',JSON.stringify(first.diagnostics));
  const second=await adapter.run(request);
  assert.equal(second.status,'rejected');
  assert.equal(second.failureCode,'invocation_replay_forbidden');
  assert.equal(chargeableCalls,1);
  // A different runId alone is not an operator decision and cannot create a new slot.
  const undecided=await adapter.run({...request,runId:'adapter.two'});
  assert.equal(undecided.status,'rejected');
  assert.equal(undecided.failureCode,'invocation_replay_forbidden');
  assert.equal(chargeableCalls,1);
  // Completed invocations are never eligible for ambiguous-outcome retry.
  assert.throws(()=>createDurableInvocationJournal(adapterFile).authorizeRetry(
    decision('operator-decision-1','adapter.one','adapter.two','baseline')),
    {code:'invocation_replay_forbidden'});
  assert.equal(chargeableCalls,1);
  const confirmed=createDurableInvocationJournal(adapterFile);
  const db=new DatabaseSync(adapterFile);
  try {
   const row=db.prepare('SELECT record_json FROM provider_invocations WHERE run_id = ?').get('adapter.one');
   assert.equal(JSON.parse(row.record_json).state,'completed');
   db.prepare('UPDATE provider_invocations SET record_hash = ? WHERE run_id = ?').run('sha256:tampered','adapter.one');
  } finally {db.close();}
  assert.throws(()=>confirmed.reserve({...fixture('adapter.one','baseline')}),{code:'invocation_journal_unavailable'});
  console.log('P7.7 durable invocation PASS: concurrent claim, crash recovery, adapter replay denial, explicit retry decision, redacted failure detail, integrity failure; fake SDK only');
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
