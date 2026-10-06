/** Offline-only authority and fairness checks for the first identity/bounded MCP ABBA. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BOUNDED_TRANSFORMATION, BOUNDED_TRANSFORMATION_HASH } from './read-file.mjs';
import { APPROVED_SOURCE_PATH, MCP_SERVER_NAME, MCP_TOOL_NAME, MCP_SCRIPT_PATH,
  readFileMcpConfig } from './identity-integration-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
export const PLAN_PATH = path.join(here, 'identity-bounded-plan.json');
export const LOCK_PATH = path.join(here, 'identity-bounded-lock.json');
export const SOURCE_HEAD = 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9';
export const MODEL = 'gpt-5.6-luna';
export const REASONING = 'medium';
export const MCP_USE_INSTRUCTION = 'Use research_read_file.read_file for the requested source inspection.';
export const TASK_PROMPT = `Inspect the approved source file ${APPROVED_SOURCE_PATH}. Report the exact first and fifth strings in its KNOWN_EVENTS set. Return only a JSON object with keys firstEvent and fifthEvent. Read the file before answering.`;
export const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const equal = (a, b) => assert.deepEqual(a, b);
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, `git ${args[0]} failed`);
  return r.stdout.trim();
};
const requireKeys = (value, keys) => equal(Object.keys(value).sort(), [...keys].sort());

export async function loadAndValidatePlan({ requireCommitted = false } = {}) {
  const bytes = await fs.readFile(PLAN_PATH);
  const plan = JSON.parse(bytes);
  requireKeys(plan, ['schemaVersion','experimentId','stage','task','taskHash','sourceHead',
    'model','reasoning','coderInstruction','coderInstructionHash','fullCoderPromptHash',
    'planner','selectedInitialContext','tool','transformation','orderedSlots','limits',
    'policy','comparison','liveExecutionAuthorized','evidencePolicy','observationSchema']);
  equal(plan.schemaVersion, 'research-mcp-result-representation-plan/v1');
  equal(plan.experimentId, 'known-events-owned-read-identity-vs-bounded-v1');
  equal(plan.stage, 'initial-abba');
  equal(plan.sourceHead, SOURCE_HEAD);
  equal([plan.model,plan.reasoning], [MODEL,REASONING]);
  equal(plan.task.id, 'codex-event-parser-known-events-inspection');
  equal(plan.task.provenance, 'successful-instructed-identity-smoke');
  equal(plan.task.prompt, TASK_PROMPT);
  equal(plan.task.promptHash, sha(TASK_PROMPT));
  equal(plan.task.candidateKind, 'final-answer');
  equal(plan.task.sourceFile, APPROVED_SOURCE_PATH);
  equal(plan.task.sourceHash,
    'sha256:2fddcdcc6f346d5db20eafc6843551b64a9cb52e5fd25e94f6968be0472b2f12');
  equal(plan.task.validation, { kind:'read-only-known-events-oracle/v1',
    scope:'pinned-checkout-unchanged', build:'not-applicable',
    typecheck:'not-applicable', tests:'not-applicable', moduleLoad:'not-applicable',
    behaviorOracle:'exact-first-and-fifth-KNOWN_EVENTS-from-pinned-source' });
  equal(plan.task.validationHash, sha(JSON.stringify(plan.task.validation)));
  equal(plan.taskHash, sha(JSON.stringify(plan.task)));
  equal(plan.coderInstruction, MCP_USE_INSTRUCTION);
  equal(plan.coderInstructionHash, sha(MCP_USE_INSTRUCTION));
  equal(plan.fullCoderPromptHash, sha(`${TASK_PROMPT}\n${MCP_USE_INSTRUCTION}`));
  equal(plan.planner, {enabled:false,prompt:null,promptHash:sha(''),stagesPerObservation:0});
  equal(plan.selectedInitialContext, {files:[],bytes:0,hash:sha('[]')});
  equal(plan.tool, {server:MCP_SERVER_NAME,name:MCP_TOOL_NAME,
    arguments:{path:APPROVED_SOURCE_PATH},approvalMode:'approve',
    sameNativeShellAvailability:true,sandboxMode:'read-only',networkAccessEnabled:false,
    webSearchMode:'disabled',configFileHash:sha(await fs.readFile(path.join(here,
      'identity-integration-config.mjs')))});
  equal(plan.transformation, {...BOUNDED_TRANSFORMATION,hash:BOUNDED_TRANSFORMATION_HASH,
    serverFileHash:sha(await fs.readFile(MCP_SCRIPT_PATH))});
  equal(plan.orderedSlots, [
    {position:1,slot:'A1',condition:'identity',replicate:1,mode:'identity'},
    {position:2,slot:'B1',condition:'bounded',replicate:1,mode:'bounded'},
    {position:3,slot:'B2',condition:'bounded',replicate:2,mode:'bounded'},
    {position:4,slot:'A2',condition:'identity',replicate:2,mode:'identity'}]);
  equal(plan.limits, {maxObservations:4,maxProviderStages:4,
    maxProviderStagesPerObservation:1,timeoutMs:180000});
  equal(plan.policy, {retry:0,repair:0,apply:0,contextExpansion:0});
  equal(plan.comparison, {primary:'cumulative-coder-input',correctnessRequired:true,
    pairs:[['B1','A1'],['B2','A2']],descriptiveOnly:true});
  equal(plan.liveExecutionAuthorized, false);
  equal(plan.evidencePolicy, {persistRawSource:false,persistRawToolResult:false,
    persistRawPrompt:false,telemetry:'bounded-hashes-counts-and-outcomes-only'});
  equal(plan.observationSchema,'research-mcp-representation-observation/v1');
  const planHash=sha(bytes);
  if (requireCommitted) {
    const lock=JSON.parse(await fs.readFile(LOCK_PATH));
    const implementationPaths=[
      'research/tool-control-prototype/read-file.mjs',
      'research/tool-control-prototype/identity-integration-config.mjs',
      'research/tool-control-prototype/identity-bounded-authority.mjs',
      'research/tool-control-prototype/identity-bounded-observation.mjs',
      'research/tool-control-prototype/identity-bounded-executor.mjs',
      'research/tool-control-prototype/rollout-telemetry.mjs',
      'research/tool-control-prototype/rollout-telemetry.test.mjs',
      'research/tool-control-prototype/rollout-telemetry-preflight.mjs',
      'research/tool-control-prototype/rollout-telemetry-smoke-replay.mjs',
      'research/tool-control-prototype/README.md',
      'research/tool-control-prototype/read-file.test.mjs',
      'research/tool-control-prototype/identity-bounded-authority.test.mjs'];
    const implementationHashes=Object.fromEntries(await Promise.all(implementationPaths.map(
      async relative=>[relative,sha(await fs.readFile(path.join(root,relative)))])));
    equal(lock,{schemaVersion:'research-mcp-representation-lock/v1',planHash,
      sourceHead:SOURCE_HEAD,slotCount:4,providerStageCeiling:4,
      liveExecutionAuthorized:false,implementationHashes});
    equal(git(root,['status','--short']),'');
    equal(git(root,['branch','--show-current']),'research/context-token-matrix-v1');
    equal(git(root,['merge-base','4af9b45f2e78460829a9e2f16657338f64459574','HEAD']),
      '4af9b45f2e78460829a9e2f16657338f64459574');
    const changed=git(root,['diff','--name-only',
      '4af9b45f2e78460829a9e2f16657338f64459574..HEAD']).split('\n').filter(Boolean);
    assert.ok(changed.length>0&&changed.every(name=>
      name.startsWith('research/tool-control-prototype/')),
    'historical research artifacts changed');
    equal(git(root,['show','HEAD:research/tool-control-prototype/identity-bounded-plan.json']),
      bytes.toString('utf8').trim());
    equal(git(root,['show','HEAD:research/tool-control-prototype/identity-bounded-lock.json']),
      (await fs.readFile(LOCK_PATH,'utf8')).trim());
  }
  return {plan,planHash};
}

export function slotAuthority(plan, slot, checkoutRoot) {
  equal(plan.orderedSlots[slot.position-1],slot);
  assert.ok(path.isAbsolute(checkoutRoot));
  const config=readFileMcpConfig(checkoutRoot,slot.mode);
  const server=config.mcp_servers[MCP_SERVER_NAME];
  equal(server.tools[MCP_TOOL_NAME].approval_mode,plan.tool.approvalMode);
  equal(server.args,[MCP_SCRIPT_PATH,checkoutRoot,slot.mode,APPROVED_SOURCE_PATH]);
  return {slot:slot.slot,mode:slot.mode,checkoutRoot,config,
    prompt:`${TASK_PROMPT}\n${MCP_USE_INSTRUCTION}`,
    promptHash:plan.fullCoderPromptHash,plannerPrompt:null,
    selectedInitialContext:plan.selectedInitialContext,
    model:plan.model,reasoning:plan.reasoning,timeoutMs:plan.limits.timeoutMs,
    sandboxMode:plan.tool.sandboxMode,networkAccessEnabled:plan.tool.networkAccessEnabled,
    webSearchMode:plan.tool.webSearchMode,approvalPolicy:'never',
    nativeShellAvailable:plan.tool.sameNativeShellAvailability,
    requestedArguments:{...plan.tool.arguments},validation:{...plan.task.validation},
    providerStages:1,retry:0,repair:0,apply:0,contextExpansion:0};
}

/** Oracle derives the expected values from the pinned source, without model judgment. */
export function validateCandidate(answer, original) {
  const match=/const KNOWN_EVENTS = new Set\(\[([\s\S]*?)\]\);/.exec(original);
  assert.ok(match,'KNOWN_EVENTS source fixture missing');
  const events=[...match[1].matchAll(/"([^"\n]+)"/g)].map(x=>x[1]);
  assert.ok(events.length>=5);
  let candidate;
  try {candidate=JSON.parse(answer)} catch {return {candidateProduced:answer.trim().length>0,behaviorOracle:'FAIL'}}
  const valid=candidate && typeof candidate==='object' && !Array.isArray(candidate) &&
    Object.keys(candidate).sort().join(',')==='fifthEvent,firstEvent' &&
    candidate.firstEvent===events[0] && candidate.fifthEvent===events[4];
  return {candidateProduced:true,behaviorOracle:valid?'PASS':'FAIL'};
}

async function localMcpCall(authority) {
  const {command,args}=authority.config.mcp_servers[MCP_SERVER_NAME];
  const child=spawn(command,args,{cwd:authority.checkoutRoot,env:process.env,
    stdio:['pipe','pipe','pipe']});
  let stderrBytes=0;
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length});
  const lines=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const request=async(id,method,params={})=>{
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    const next=await Promise.race([lines.next(),new Promise((_,reject)=>
      setTimeout(()=>reject(Error('local MCP timeout')),3000))]);
    assert.equal(next.done,false,'MCP stdout closed');
    const message=JSON.parse(next.value);
    equal([message.jsonrpc,message.id],['2.0',id]);
    assert.equal(message.error,undefined);
    return message.result;
  };
  try {
    const initialize=await request(1,'initialize',{protocolVersion:'2025-06-18',
      capabilities:{},clientInfo:{name:'offline-fairness',version:'1'}});
    equal(initialize.serverInfo.name,'research-read-file');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const tools=await request(2,'tools/list');
    equal(tools.tools.map(x=>x.name),[MCP_TOOL_NAME]);
    equal(tools.tools[0].inputSchema,{type:'object',properties:{path:{type:'string'}},
      required:['path'],additionalProperties:false});
    const result=await request(3,'tools/call',{name:MCP_TOOL_NAME,
      arguments:authority.requestedArguments});
    equal(result.isError,undefined);
    equal(result.content.map(x=>x.type),['text']);
    equal(result._meta.researchTelemetry.mode,authority.mode);
    equal(result._meta.researchTelemetry.requestedPath,undefined);
    return {text:result.content[0].text,telemetry:result._meta.researchTelemetry,
      protocolVersion:initialize.protocolVersion,stderrBytes};
  } finally {
    child.stdin.end();
    await new Promise(resolve=>child.once('exit',resolve));
    equal([child.exitCode,child.signalCode],[0,null]);
  }
}

export async function offlineFairnessReplay({remote = false,requireCommitted = false} = {}) {
  const {plan,planHash}=await loadAndValidatePlan({requireCommitted});
  let localHead=null,remoteHead=null;
  if (requireCommitted) {
    localHead=git(root,['rev-parse','HEAD']);
    if (remote) {
      const output=git(root,['ls-remote','origin','refs/heads/research/context-token-matrix-v1']);
      remoteHead=output.split('\t')[0];
      equal(remoteHead,localHead);
    }
  }
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'owned-mcp-fairness-'));
  try {
    const checkout=path.join(temp,'pinned');
    git(root,['clone','--quiet','--shared','--no-checkout','--',root,checkout]);
    git(checkout,['checkout','--quiet','--detach',SOURCE_HEAD]);
    equal(git(checkout,['rev-parse','HEAD']),SOURCE_HEAD);
    equal(git(checkout,['status','--short']),'');
    const original=await fs.readFile(path.join(checkout,APPROVED_SOURCE_PATH));
    equal(sha(original),plan.task.sourceHash);
    const authorities=plan.orderedSlots.map(slot=>slotAuthority(plan,slot,checkout));
    const normalized=authorities.map(a=>({prompt:a.prompt,promptHash:a.promptHash,
      plannerPrompt:a.plannerPrompt,selectedInitialContext:a.selectedInitialContext,
      model:a.model,reasoning:a.reasoning,timeoutMs:a.timeoutMs,
      sandboxMode:a.sandboxMode,networkAccessEnabled:a.networkAccessEnabled,
      webSearchMode:a.webSearchMode,approvalPolicy:a.approvalPolicy,
      nativeShellAvailable:a.nativeShellAvailable,requestedArguments:a.requestedArguments,
      validation:a.validation,providerStages:a.providerStages,
      retry:a.retry,repair:a.repair,apply:a.apply,contextExpansion:a.contextExpansion,
      toolName:MCP_TOOL_NAME,serverName:MCP_SERVER_NAME,
      command:a.config.mcp_servers[MCP_SERVER_NAME].command,
      script:a.config.mcp_servers[MCP_SERVER_NAME].args[0],
      checkoutRoot:a.checkoutRoot,
      approvedPath:a.config.mcp_servers[MCP_SERVER_NAME].args[3],
      toolApproval:a.config.mcp_servers[MCP_SERVER_NAME].tools[MCP_TOOL_NAME].approval_mode}));
    for(const row of normalized.slice(1)) equal(row,normalized[0]);
    const calls=[];
    for(const authority of authorities) calls.push(await localMcpCall(authority));
    const baseline=calls[0];
    for(const item of calls){
      equal(item.telemetry.sourceHash,plan.task.sourceHash);
      equal(item.telemetry.originalBytes,original.length);
      equal(item.telemetry.transformationHash,plan.transformation.hash);
      equal(item.telemetry.transformationVersion,plan.transformation.version);
      equal(item.telemetry.resultHash,sha(item.text));
      equal(item.telemetry.coderBytes,Buffer.byteLength(item.text));
      equal(item.stderrBytes,0);
      equal(item.protocolVersion,'2025-06-18');
    }
    equal(calls[0].text,calls[3].text);
    equal(calls[1].text,calls[2].text);
    equal(calls[0].text,original.toString('utf8'));
    assert.notEqual(calls[0].text,calls[1].text);
    assert.ok(calls[1].telemetry.coderBytes<calls[0].telemetry.coderBytes);
    equal(calls[0].telemetry.resultHash,calls[0].telemetry.sourceHash);
    assert.notEqual(calls[1].telemetry.resultHash,calls[1].telemetry.sourceHash);
    assert.ok(calls[1].text.includes('"thread.started"')&&
      calls[1].text.includes('"item.started"'));
    const metrics=calls.map((x,i)=>({slot:authorities[i].slot,mode:authorities[i].mode,
      sourceHash:x.telemetry.sourceHash,originalBytes:x.telemetry.originalBytes,
      coderBytes:x.telemetry.coderBytes,reductionBytes:x.telemetry.reductionBytes,
      reductionPercent:x.telemetry.reductionPercent,resultHash:x.telemetry.resultHash,
      transformationHash:x.telemetry.transformationHash}));
    return {schemaVersion:'research-mcp-fairness-preflight/v1',status:'PASS',planHash,
      taskHash:plan.taskHash,sourceHead:SOURCE_HEAD,localHead,remoteHead,
      instructionHash:plan.coderInstructionHash,transformationHash:plan.transformation.hash,
      orderedSlots:plan.orderedSlots.map(x=>x.slot),metrics,
      fairness:{sameServer:true,sameTool:true,sameArguments:true,sameUnderlyingFile:true,
        sameTrustedOriginal:true,onlyCoderRepresentationDiffers:true,
        sameInstruction:true,samePlannerPrompt:true,sameInitialContext:true,
        sameNativeShellAvailability:true,sameValidation:true,
        sameApprovalMode:true,sameModelReasoningTimeoutSandbox:true,
        noExtraBoundedProviderCall:true,noModelSummarization:true,
        deterministicBoundedTransformation:true,noRawDurableOutput:true},
      ceilings:{observations:4,providerStages:4,plannerStages:0,coderStages:4,
        retries:0,repairs:0,applies:0,contextExpansions:0},
      providerModelCalls:0,liveSessions:0};
  } finally {await fs.rm(temp,{recursive:true,force:true})}
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  const committed=process.argv[2]==='--preflight';
  if (!committed && process.argv[2]!=='--offline') throw Error('offline or preflight only');
  const result=await offlineFairnessReplay({remote:committed,requireCommitted:committed});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
