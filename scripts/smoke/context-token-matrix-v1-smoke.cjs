#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '../..');
const research = path.join(repo, 'research/context-token-matrix-v1');
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const evidence = (root, file) => { const bytes=fs.readFileSync(path.join(root,file)); const content=bytes.toString('utf8');
  return { path:file, source:'fixture', content, contentHash:sha(bytes), byteLength:bytes.length,
    estimatedTokens:Math.ceil(content.length/4), matchedSymbols:[] }; };
(async()=>{
  const policy=await import(pathToFileURL(path.join(research,'policy.mjs')).href);
  const resultModule=await import(pathToFileURL(path.join(research,'result.mjs')).href);
  const comparison=await import(pathToFileURL(path.join(research,'compare.mjs')).href);
  const flow=await import(pathToFileURL(path.join(repo,'dist/packages/product-runtime/src/repo-intelligence-context-binding.js')).href);
  const target=JSON.parse(fs.readFileSync(path.join(research,'pilot-target.json'),'utf8'));
  const pilot=JSON.parse(fs.readFileSync(path.join(repo,target.taskFile),'utf8'));
  assert.equal(target.taskHash,sha(pilot.taskPrompt));
  assert.deepEqual(target.allowedFiles,pilot.allowedMutationPaths);
  assert.deepEqual(target.variants,policy.VARIANTS);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'context-token-matrix-'));
  try {
    fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.mkdirSync(path.join(root,'tests'));
    fs.writeFileSync(path.join(root,'src/main.ts'),
      'import { a } from "./extra-a.js";\nimport { b } from "./extra-b.js";\nexport function run(): number { return a + b; }\n');
    fs.writeFileSync(path.join(root,'src/extra-a.ts'),'export const a = 1;\n'+'// a context\n'.repeat(30));
    fs.writeFileSync(path.join(root,'src/extra-b.ts'),'export const b = 2;\n'+'// b context\n'.repeat(60));
    fs.writeFileSync(path.join(root,'tests/main.test.ts'),
      'import { run } from "../src/main.js";\nif (run() !== 3) throw Error("test");\n');
    const git=(args)=>{const run=spawnSync('git',args,{cwd:root,encoding:'utf8'});
      assert.equal(run.status,0,run.stderr);return run.stdout.trim()};
    git(['init','-q']);git(['add','.']);
    git(['-c','user.name=Research Fixture','-c','user.email=fixture@example.invalid',
      'commit','-qm','baseline']);
    const sourceHead=git(['rev-parse','HEAD']);
    const baseline=[evidence(root,'src/main.ts'),evidence(root,'tests/main.test.ts'),evidence(root,'src/extra-a.ts')];
    const makeConfig=variant=>policy.createResearchConfig({experimentId:'fixture-1',variant,
      model:'fixture-model',reasoning:'medium',sourceHead,taskHash:sha('test task'),
      allowedFiles:['src/main.ts','tests/main.test.ts']});
    const selections=[];
    for(const variant of policy.VARIANTS){
      const config=makeConfig(variant);
      const selected=await policy.selectResearchContext({config,repositoryPath:root,seedFiles:['src/main.ts'],
        requiredTestFiles:['tests/main.test.ts'],currentEvidence:baseline});
      const seen={context:null,runtime:null,calls:0};
      const run=await flow.runRepoIntelligenceBoundCoderFlow({repositoryPath:root,seedFiles:['src/main.ts'],
        baseContext:{version:'1',taskContext:{objective:'test task',seedFiles:['src/main.ts'],
          requiredTestFiles:['tests/main.test.ts']}},requiredTestFiles:['tests/main.test.ts'],
        requiredSymbols:[],forbiddenFiles:[],authorityPresent:true,policyPresent:true,
        hardTotalBudgetTokens:selected.policyOverrides.hardTotalBudgetTokens,
        reservedOutputTokens:selected.policyOverrides.reservedOutputTokens,
        initialEvidence:selected.policyOverrides.initialEvidence,
        contextRequestProvider:async()=>{throw Error('expansion not expected')},
        coderProvider:async(context,runtime)=>{seen.context=context;seen.runtime=runtime;seen.calls++;return {ok:true}}});
      assert.equal(run.decision,'repo_context_binding_completed',JSON.stringify(run.issues));
      assert.equal(seen.calls,1);
      assert(run.adaptiveResult.coderResult.summary.estimatedInputTokens <=
        config.effectivePolicy.hardTotalBudgetTokens-config.effectivePolicy.reservedOutputTokens);
      assert.equal(JSON.stringify(seen.context).includes('readableFiles'),false);
      assert.equal(JSON.stringify(seen.context).includes('contentHash'),false);
      assert.deepEqual(seen.runtime.readableFiles,run.binding.allowedContextFiles);
      assert.deepEqual(Object.keys(selected.policyOverrides).sort(),
        ['hardTotalBudgetTokens','initialEvidence','reservedOutputTokens']);
      selections.push({variant,config,selected,run,seen});
    }
    const [minimal,current,expanded]=selections;
    assert.deepEqual(current.selected.initialEvidence,baseline,'current must be exact production evidence');
    let directContext=null;
    const direct=await flow.runRepoIntelligenceBoundCoderFlow({repositoryPath:root,
      seedFiles:['src/main.ts'],baseContext:{version:'1',taskContext:{objective:'test task',
        seedFiles:['src/main.ts'],requiredTestFiles:['tests/main.test.ts']}},
      requiredTestFiles:['tests/main.test.ts'],requiredSymbols:[],forbiddenFiles:[],
      authorityPresent:true,policyPresent:true,hardTotalBudgetTokens:16_384,
      reservedOutputTokens:2_048,initialEvidence:baseline,
      contextRequestProvider:async()=>{throw Error('expansion not expected')},
      coderProvider:async(context)=>{directContext=context;return {ok:true}}});
    assert.equal(direct.decision,'repo_context_binding_completed');
    assert.deepEqual(current.seen.context,directContext,'current model-facing payload must match production flow');
    assert.equal(current.run.binding.bindingHash,direct.binding.bindingHash);
    assert(minimal.selected.selectedBytes < current.selected.selectedBytes);
    assert(expanded.selected.selectedBytes > current.selected.selectedBytes);
    assert(minimal.run.adaptiveResult.coderResult.summary.estimatedInputTokens <
      current.run.adaptiveResult.coderResult.summary.estimatedInputTokens);
    assert(expanded.run.adaptiveResult.coderResult.summary.estimatedInputTokens >
      current.run.adaptiveResult.coderResult.summary.estimatedInputTokens);
    assert.deepEqual(expanded.selected.selectedFiles,
      ['src/main.ts','tests/main.test.ts','src/extra-a.ts','src/extra-b.ts']);
    const forbiddenExpansion=await policy.selectResearchContext({config:expanded.config,
      repositoryPath:root,seedFiles:['src/main.ts'],requiredTestFiles:['tests/main.test.ts'],
      forbiddenFiles:['src/extra-b.ts'],currentEvidence:baseline});
    assert.equal(forbiddenExpansion.selectedFiles.includes('src/extra-b.ts'),false);
    assert.deepEqual(selections.map(x=>x.seen.runtime.readableFiles),
      selections.map(()=>current.seen.runtime.readableFiles));
    const validationAuthority={commands:[{id:'test',generatedOutputRoots:['dist']}],networkAllowed:false};
    const taskInput={allowedChangeFiles:['src/main.ts','tests/main.test.ts'],initialEvidence:baseline,
      hardTotalBudgetTokens:16_384,reservedOutputTokens:2_048,
      draftValidation:validationAuthority,applyExecutor:()=>{throw Error('must not run')},
      durableTask:{idempotencyKey:'unchanged'},taskId:'unchanged-task-id'};
    assert.equal(policy.prepareResearchTaskInput(taskInput,current.selected),taskInput,
      'current must return the exact production input');
    for(const chosen of [minimal,expanded]){
      const prepared=policy.prepareResearchTaskInput(taskInput,chosen.selected);
      assert.equal(prepared.draftValidation,validationAuthority);
      assert.equal(prepared.applyExecutor,taskInput.applyExecutor);
      assert.equal(prepared.durableTask,taskInput.durableTask);
      assert.equal(prepared.taskId,taskInput.taskId);
      assert.deepEqual(prepared.allowedChangeFiles,taskInput.allowedChangeFiles);
      assert.equal(prepared.initialEvidence,chosen.selected.initialEvidence);
    }
    assert.throws(()=>makeConfig('unknown'),/research_context_policy_invalid/);
    assert.throws(()=>policy.createResearchConfig({experimentId:'x',variant:'expanded',model:'m',
      reasoning:'medium',sourceHead:'a'.repeat(40),taskHash:sha('x'),allowedFiles:[]}),/research_context_policy_invalid/);
    await assert.rejects(policy.selectResearchContext({config:{...current.config,effectivePolicy:
      {...current.config.effectivePolicy,hardTotalBudgetTokens:999999}},repositoryPath:root,
      seedFiles:['src/main.ts'],requiredTestFiles:['tests/main.test.ts'],currentEvidence:baseline}),
      /research_context_policy_invalid/);
    await assert.rejects(policy.selectResearchContext({config:{...current.config,sourceHead:'b'.repeat(40)},
      repositoryPath:root,seedFiles:['src/main.ts'],requiredTestFiles:['tests/main.test.ts'],
      currentEvidence:baseline}),/source HEAD/);
    const observation=(operation,input,cached,output,turns,tools)=>({operation,reported:true,
      initialPromptEstimatedTokens:operation==='coder'?140:12,cumulativeInputTokens:input,
      cumulativeCachedInputTokens:cached,outputTokens:output,providerTurnCount:turns,toolCallCount:tools});
    const mockOutput=(variant,tokenObservability)=>({taskId:`fixture.${variant}`,decision:'bounded_task_completed',
      route:'validated_draft_ready',candidate:{files:['src/main.ts']},
      validation:{scope:'PASS',typecheck:'PASS',tests:'PASS',behavior:'PASS'},
      sourceRepositoryUnchanged:true,tokens:{input:300,cached:80,output:30,total:330,tokenObservability}});
    const rows=selections.map(({variant,config,selected})=>resultModule.createExperimentResult({config,
      runId:`fixture-${variant}`,selectedContext:selected,providerCalls:2,
      expansion:{requested:0,granted:0,tokens:0,bytes:0},
      validationProfile:'existing_function_bug_fix',validationSpecificationHash:sha('unchanged spec'),
      codexOutput:mockOutput(variant,[observation('planner',100,30,10,0,0),
        observation('coder',200,50,20,1,2)])}));
    rows.forEach(resultModule.validateExperimentResult);
    assert.equal(rows[0].usage.planner.providerTurnCount,0,'observed zero is retained');
    assert.equal(rows[0].usage.aggregate.uncached,220);
    assert.equal(rows[0].usage.aggregate.totalTurns,1);
    const withExpansion=resultModule.createExperimentResult({config:current.config,runId:'expanded-usage',
      selectedContext:current.selected,providerCalls:3,expansion:{requested:1,granted:1,tokens:10,bytes:40},
      validationDetail:{syntax:'PASS'},
      codexOutput:mockOutput('current',[observation('planner',100,30,10,0,0),
        observation('coder',200,50,20,1,2),observation('expansion',10,0,1,1,0)])});
    assert.equal(withExpansion.usage.aggregate.input,310);
    assert.equal(withExpansion.usage.aggregate.total,341);
    assert.equal(withExpansion.usage.aggregate.provenance.input,'derived');
    assert.equal(withExpansion.usage.contextExpansion.length,1);
    assert.equal(withExpansion.outcome.validation.syntax,'PASS');
    assert.deepEqual(rows.map(r=>r.outcome.scopeViolations),[[],[],[]]);
    assert.equal(rows[0].timing.taskElapsedMs,null);
    const bad=resultModule.createExperimentResult({config:current.config,runId:'bad',
      selectedContext:current.selected,codexOutput:mockOutput('current',[
        observation('planner',10,11,1,0,0)]),providerCalls:0});
    assert.equal(bad.usage.planner.cumulativeCachedInputTokens,null);
    assert.equal(bad.usage.planner.cumulativeUncachedInputTokens,null);
    assert.equal(bad.usage.aggregate.providerCalls,0);
    assert.equal(bad.context.expansion.requested,null);
    const invalidAggregate=resultModule.createExperimentResult({config:current.config,runId:'bad-aggregate',
      selectedContext:current.selected,codexOutput:{...mockOutput('current',[]),tokens:{
        input:10,cached:11,output:2,total:12,tokenObservability:[]}}});
    assert.equal(invalidAggregate.usage.aggregate.cached,null);
    assert.equal(invalidAggregate.usage.aggregate.uncached,null);
    const missing=resultModule.createExperimentResult({config:current.config,runId:'missing',
      selectedContext:current.selected,codexOutput:{...mockOutput('current',[]),tokens:{} }});
    assert.equal(missing.usage.planner,null);
    assert.equal(missing.usage.aggregate.input,null);
    assert.equal(missing.context.initialPromptEstimatedTokens,null);
    const report=comparison.compareExperimentResults(rows,{historical:true});
    assert.equal(report.historical.comparisonKind,'historical_non_paired');
    assert.match(report.historical.warning,/not a clean paired A\/B/);
    assert.equal(report.rows.length,3);
    assert.equal(report.rows[1].inputChangeVsCurrentPercent,0);
    assert.equal(report.derivedMetricsAreProviderEvidence,false);
    assert.match(comparison.renderComparison(report,'csv'),/^variant,status,/);
    assert.equal(JSON.parse(comparison.renderComparison(report,'json')).rows.length,3);
    const resultPaths=rows.map((row,index)=>{const file=path.join(root,`${index}.json`);
      fs.writeFileSync(file,JSON.stringify(row));return file});
    const cli=spawnSync(process.execPath,[path.join(research,'compare.mjs'),'--format','csv',...resultPaths],
      {cwd:repo,encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/expanded/);
    const specimen=JSON.stringify(rows);
    assert.equal(specimen.includes('test task'),false,'task prompt must not enter result records');
    console.log('context-token-matrix-v1-smoke: PASS');
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
