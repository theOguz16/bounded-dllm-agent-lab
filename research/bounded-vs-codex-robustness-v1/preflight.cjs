#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'benchmark-manifest.json'), 'utf8'));
const resultsRoot = process.env.ROBUSTNESS_RESULT_ROOT || path.join(os.homedir(), '.bounded-agent', 'bounded-dllm-agent-lab', 'live-runs', 'bounded-vs-codex-robustness-v1');
const checks = [];
function check(name, ok, detail) { checks.push({name, ok: !!ok, detail: String(detail || '')}); if (!ok) throw new Error(name + ': ' + detail); }
function run(command, args, cwd = root, timeout = 120000, env = process.env) {
  const r = cp.spawnSync(command, args, {cwd, env, encoding:'utf8', timeout, maxBuffer:4*1024*1024});
  if (r.error || r.status !== 0) throw new Error(command + ' ' + args.join(' ') + ': ' + String(r.error?.message || r.stderr || r.stdout).slice(0,1500));
  return r.stdout.trim();
}
function canon(x) { if (Array.isArray(x)) return '['+x.map(canon).join(',')+']'; if (x && typeof x==='object') return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canon(x[k])).join(',')+'}'; return JSON.stringify(x); }
const sha = x => 'sha256:'+crypto.createHash('sha256').update(canon(x)).digest('hex');
let scratch;
try {
  const branch = run('git',['branch','--show-current']);
  check('benchmark branch', branch==='research/bounded-vs-codex-robustness-v1', branch);
  const head = run('git',['rev-parse','HEAD']);
  run('git',['merge-base','--is-ancestor',manifest.sourceHead,head]);
  check('source commit',run('git',['cat-file','-t',manifest.sourceHead])==='commit',manifest.sourceHead);
  check('task count',manifest.tasks.length===5 && manifest.observationLimit===10,'expected 5/10');
  check('difficulty and ordering',manifest.tasks.map(t=>t.difficulty).join(',')==='easy,medium_a,medium_b,medium_c,hard' && manifest.tasks.map(t=>t.order.join('/')).join(',')==='normal/bounded,bounded/normal,normal/bounded,bounded/normal,normal/bounded','frozen design');
  for (const t of manifest.tasks) {
    const {taskHash,...definition}=t;
    check(t.taskId+' hash',sha(definition)===taskHash,taskHash);
    check(t.taskId+' source/model',t.sourceHead===manifest.sourceHead && t.model==='gpt-5.6-luna' && t.reasoning==='medium',t.taskId);
    check(t.taskId+' policy',t.policy.retry===0 && t.policy.repair===0 && t.policy.apply===0 && t.policy.boundedContext==='production-current' && t.policy.plannerBypass===false,t.taskId);
  }
  check('result root outside source/temp',path.isAbsolute(resultsRoot) && !resultsRoot.startsWith(path.dirname(root)) && !resultsRoot.startsWith('/private/tmp/'),resultsRoot);
  const sessionDir = path.join(resultsRoot,manifest.sessionId);
  check('run identities unused',!fs.existsSync(path.join(sessionDir,'ledger.json')) && !fs.existsSync(path.join(sessionDir,'observations')),sessionDir);
  fs.mkdirSync(sessionDir,{recursive:true,mode:0o700});
  fs.accessSync(sessionDir,fs.constants.W_OK);
  check('result root writable',true,sessionDir);
  check('Docker',!!run('docker',['info','--format','{{.ServerVersion}}']), 'daemon reachable');
  check('Codex login',/logged in/i.test(run('codex',['login','status'])),'login status');
  const doctorProbe = require('node:child_process').spawnSync('codex',['doctor','--json','-c','model="gpt-5.6-luna"','-c','model_reasoning_effort="medium"'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  const doctor = JSON.parse(doctorProbe.stdout);
  check('Normal model/reasoning config',doctor.checks?.['config.load']?.details?.model==='gpt-5.6-luna','explicit Luna/medium override');
  check('provider reachability',doctor.checks?.['network.provider_reachability']?.status==='ok','endpoint check');
  const journal = path.join(sessionDir,'provider-invocations.sqlite');
  check('journal location and unused state',path.isAbsolute(journal) && !journal.startsWith(path.dirname(root)) && !journal.startsWith('/private/tmp/') && !fs.existsSync(journal),journal);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(),'robustness-preflight-'));
  const candidate = path.join(scratch,'source');
  run('git',['clone','--local','--no-hardlinks','--quiet',path.resolve(root,'../../'),candidate],root);
  run('git',['checkout','--detach',manifest.sourceHead],candidate);
  run('npm',['ci','--offline','--ignore-scripts','--no-audit','--no-fund'],candidate);
  run('npm',['run','build'],candidate);
  run('npm',['run','typecheck'],candidate);
  run('npm',['test'],candidate);
  const init = 'import fs from "node:fs/promises"; import {detectBoundedLocalConfig,BOUNDED_GITIGNORE_CONTENT,BOUNDED_DEFAULT_POLICY_CONTENT} from "./dist/apps/cli/src/product-config.js"; await fs.mkdir(".bounded",{recursive:true}); await fs.writeFile(".bounded/config.json",JSON.stringify(await detectBoundedLocalConfig(process.cwd()),null,2)+"\n"); await fs.writeFile(".bounded/.gitignore",BOUNDED_GITIGNORE_CONTENT); await fs.writeFile(".bounded/policy.yml",BOUNDED_DEFAULT_POLICY_CONTENT);';
  run('node',['--input-type=module','-e',init],candidate);
  const boundedDoctor = JSON.parse(run('node',['dist/apps/cli/src/index.js','doctor','--json'],candidate));
  check('Bounded doctor',boundedDoctor.ok===true,'isolated source');
  for (const t of manifest.tasks) {
    for (const file of t.allowedFiles) check(t.taskId+' source file '+file,fs.statSync(path.join(candidate,file)).isFile(),file);
    const estimate=t.allowedFiles.reduce((n,file)=>n+Math.ceil(fs.readFileSync(path.join(candidate,file),'utf8').length/4),0);
    check(t.taskId+' bounded context estimate',estimate<10000,estimate+' initial file tokens before prompt/metadata, 14336 hard input');
    const oracle=t.oracle.replace('{candidate}',candidate).replace('{benchmark}',root).split(' ');
    check(t.taskId+' oracle command',fs.existsSync(path.isAbsolute(oracle[1])?oracle[1]:path.join(candidate,oracle[1])),oracle[1]);
    const result=cp.spawnSync(oracle[0],oracle.slice(1),{cwd:candidate,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    check(t.taskId+' baseline oracle rejects missing behavior',result.status===1 && !result.error, String(result.stderr||result.stdout).slice(0,160));
  }
  const report={schemaVersion:'robustness-preflight/v1',at:new Date().toISOString(),benchmarkHead:head,sourceHead:manifest.sourceHead,sessionId:manifest.sessionId,checks,providerCalls:0,ok:true};
  fs.writeFileSync(path.join(sessionDir,'preflight.json'),JSON.stringify(report,null,2)+'\n',{flag:'w',mode:0o600});
  process.stdout.write(JSON.stringify({ok:true,checks:checks.length,providerCalls:0,sessionDir})+'\n');
} catch(error) {
  const report={schemaVersion:'robustness-preflight/v1',at:new Date().toISOString(),checks,providerCalls:0,ok:false,error:String(error.message||error)};
  try { fs.mkdirSync(path.join(resultsRoot,manifest.sessionId),{recursive:true,mode:0o700}); fs.writeFileSync(path.join(resultsRoot,manifest.sessionId,'preflight.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600}); } catch {}
  process.stderr.write(JSON.stringify(report)+'\n'); process.exitCode=1;
} finally { if(scratch) fs.rmSync(scratch,{recursive:true,force:true}); }
