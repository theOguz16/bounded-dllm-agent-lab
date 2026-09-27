#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const research = path.join(repository, 'research/context-token-matrix-v1');
  const runtime = await import(pathToFileURL(path.join(research, 'live-runtime.mjs')).href);
  const { buildDryRun } = await import(pathToFileURL(path.join(research, 'dry-run.mjs')).href);
  const { codexCommand } = await import(pathToFileURL(path.join(repository,
    'dist/apps/cli/src/commands/codex.js')).href);
  const { doctorCommand } = await import(pathToFileURL(path.join(repository,
    'dist/apps/cli/src/commands/doctor.js')).href);
  const { runRepoIntelligenceBoundCoderFlow } = await import(pathToFileURL(path.join(repository,
    'dist/packages/product-runtime/src/repo-intelligence-context-binding.js')).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(research, 'experiment-manifest.json'), 'utf8'));
  const calibration = JSON.parse(fs.readFileSync(path.join(research, 'calibration.json'), 'utf8'));
  const task = manifest.selectedTasks[0];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'context-token-live-smoke-'));
  const savedKey = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'offline-context-matrix-fixture-key';
  const command = (args, cwd = repository) => { const result = spawnSync(args[0], args.slice(1),
    { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    const harness = path.join(temporary, 'harness');
    command(['git', 'clone', '--quiet', '--shared', '--no-checkout', '--', repository, harness]);
    command(['git', 'checkout', '--quiet', '-B', manifest.researchBranch,
      manifest.harnessBaselineSha], harness);
    assert.equal(runtime.verifyHarnessIdentity(harness), manifest.harnessBaselineSha);
    const source = await runtime.prepareSourceCheckout(path.join(temporary, 'source-one'),
      manifest, harness);
    assert.equal(command(['git', 'rev-parse', 'HEAD'], source.root), manifest.sourceHead);
    assert.notEqual(manifest.sourceHead, manifest.harnessBaselineSha);
    assert.equal(runtime.verifySourceIdentity(source.root, manifest.sourceHead), '?? .bounded/');
    assert.equal(source.doctor.ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(source.root, '.bounded/config.json'), 'utf8'));
    assert.equal(stored.scripts.test.includes('test:context-token-matrix-v1'), false,
      'harness-only scripts must not enter source doctor config');
    const fakeHome = path.join(temporary, 'home');
    const journal = runtime.expectedJournalPath(fakeHome);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, Buffer.from('SQLite format 3\0fixture', 'utf8'));
    const statBefore = fs.statSync(journal);
    assert.equal(runtime.verifyJournal(journal, source.root, fakeHome).path, fs.realpathSync(journal));
    assert.equal(fs.statSync(journal).size, statBefore.size);
    const pre = await runtime.preflight({ harnessRoot: harness, home: fakeHome,
      resultParent: runtime.outputParent(fakeHome) });
    assert.equal(pre.ok, true);
    assert.equal(pre.providerModelCalls, 0);
    assert.equal(pre.sourceHead, manifest.sourceHead);
    assert.equal(pre.harnessHead, manifest.harnessBaselineSha);
    assert.deepEqual(pre.stage1Order, ['minimal', 'current', 'expanded']);
    assert.deepEqual(pre.providerBinding.minimal.selectedPaths,
      pre.providerBinding.current.selectedPaths);
    assert.notEqual(pre.providerBinding.expanded.modelPayloadHash,
      pre.providerBinding.current.modelPayloadHash);
    assert(pre.providerBinding.expanded.selectedPaths.includes('apps/web/src/index.ts'));
    assert(pre.providerBinding.expanded.selectedPaths.includes('packages/integrations/src/index.ts'));
    assert.equal(fs.statSync(journal).size, statBefore.size);
    assert.equal(fs.statSync(journal).mtimeMs, statBefore.mtimeMs);
    assert.equal(runtime.verifySourceIdentity(source.root, manifest.sourceHead), '?? .bounded/');
    const stale = structuredClone(stored);
    stale.scripts.test.push('test:context-token-matrix-v1');
    fs.writeFileSync(path.join(source.root, '.bounded/config.json'), JSON.stringify(stale));
    const failedDoctor = await doctorCommand(source.root);
    assert.equal(failedDoctor.output.code, 'cli_doctor_config_drift');
    const refreshed = await runtime.prepareSourceCheckout(path.join(temporary, 'source-fresh'),
      manifest, harness);
    assert.equal(refreshed.doctor.ok, true);
    assert.equal(runtime.verifySourceIdentity(refreshed.root, manifest.sourceHead), '?? .bounded/');
    assert.throws(() => runtime.verifySourceIdentity(harness, manifest.sourceHead),
      /source HEAD mismatch/);
    const plan = buildDryRun();
    assert.deepEqual(runtime.stage1Rows(plan).map(row => row.variant),
      ['minimal', 'current', 'expanded']);
    assert.throws(() => runtime.stage1Rows({ rows: [...plan.rows.filter(x => x.stage === 'stage1'),
      plan.rows[0]] }), /maximum cell count/);
    assert.throws(() => runtime.stage1Rows({ rows: plan.rows.filter(x => x.stage === 'stage1')
      .reverse() }), /order/);
    assert.equal(runtime.classifyCell({ decision: 'bounded_task_completed',
      sourceRepositoryUnchanged: true }), 'completed');
    assert.equal(runtime.classifyCell({ decision: 'bounded_task_stopped',
      failure: { stage: 'planner', code: 'invocation_journal_unavailable' } }),
      'infrastructure_or_unclear_stop');
    assert.equal(runtime.classifyCell({ decision: 'bounded_task_stopped',
      failure: { stage: 'validation', code: 'bounded_task_required_validation_failed' } }),
      'candidate_failure');
    assert.equal(runtime.classifyCell({ decision: 'bounded_task_invalid',
      failure: { stage: 'coding', code: 'bounded_task_coder_output_invalid' } }),
      'candidate_failure');
    assert.equal(runtime.shouldContinueAfterCell('candidate_failure'), true);
    assert.equal(runtime.shouldContinueAfterCell('infrastructure_or_unclear_stop'), false);
    const journalEnvironment = process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH;
    process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH = path.join(temporary, 'wrong-journal.sqlite');
    try { await assert.rejects(runtime.runStage1(), /frozen journal path/); }
    finally {
      if (journalEnvironment === undefined) delete process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH;
      else process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH = journalEnvironment;
    }
    const seenIds = [];
    const fakeAdapter = { agentId: 'codex', agentVersion: 'fake/v1',
      async run(request) { seenIds.push(request.runId); return { status: 'completed' }; } };
    const wrapped = runtime.makeJournalScopedAdapter(fakeAdapter, 'fixture.minimal');
    await wrapped.run({ runId: 'planner.same-task', mode: 'planner',
      model: manifest.model, reasoningEffort: manifest.reasoning });
    assert.equal(seenIds[0], 'matrix.fixture.minimal.planner.same-task');
    await assert.rejects(wrapped.run({ runId: 'planner.same-task', mode: 'planner',
      model: manifest.model, reasoningEffort: manifest.reasoning }), /automatic provider retry forbidden/);
    await assert.rejects(wrapped.run({ runId: 'planner.same-task', mode: 'planner',
      model: 'different-model', reasoningEffort: manifest.reasoning }), /provider settings drift/);
    await assert.rejects(wrapped.run({ runId: 'planner.same-task', mode: 'planner',
      model: manifest.model, reasoningEffort: 'high' }), /provider settings drift/);
    const captured = {};
    for (const variant of manifest.variants) {
      const before = runtime.verifySourceIdentity(refreshed.root, manifest.sourceHead);
      const response = await codexCommand({ task: JSON.parse(fs.readFileSync(
        path.join(refreshed.root, task.taskFile), 'utf8')).taskPrompt,
        allowFiles: task.allowedFiles }, refreshed.root,
      { model: manifest.model, reasoningEffort: manifest.reasoning,
        adapter: { agentId: 'codex', agentVersion: 'unused-fake/v1',
          async run() { throw Error('real adapter must not run in fixture'); } },
        runTask: async input => {
          const bound = await runtime.bindTaskInput(input, { manifest, task, variant,
            sourceRoot: refreshed.root });
          if (variant === 'current') assert.equal(bound.prepared, input);
          assert.equal(bound.prepared.allowedChangeFiles, input.allowedChangeFiles);
          assert.equal(bound.prepared.draftValidation, input.draftValidation);
          assert.equal(bound.prepared.durableTask, input.durableTask);
          assert.equal(bound.prepared.taskId, input.taskId);
          assert.equal(bound.prepared.hardTotalBudgetTokens,
            manifest.effectivePolicies[variant].hardTotalBudgetTokens);
          const selected = bound.selected;
          const flow = await runRepoIntelligenceBoundCoderFlow({ repositoryPath: refreshed.root,
            seedFiles: task.allowedFiles,
            requiredTestFiles: task.allowedFiles.filter(file => file.startsWith('tests/')),
            requiredSymbols: [], forbiddenFiles: [], authorityPresent: true, policyPresent: true,
            baseContext: { version: '1', taskContext: { objective: input.taskContext.objective,
              seedFiles: task.allowedFiles } }, initialEvidence: bound.prepared.initialEvidence,
            hardTotalBudgetTokens: bound.prepared.hardTotalBudgetTokens,
            reservedOutputTokens: bound.prepared.reservedOutputTokens,
            contextRequestProvider: async () => { throw Error('no expansion in fake provider'); },
            coderProvider: async (context, runtimeData) => {
              captured[variant] = { context, runtimeData }; return { offline: true }; } });
          assert.equal(flow.decision, 'repo_context_binding_completed');
          assert.equal(selected.selectedFileCount, calibration.tasks[0].variants[variant].selectedFileCount);
          return { decision: 'bounded_task_stopped', route: 'replan_required',
            failure: null, receipt: null, plannerResult: null, verifierResult: null,
            applyResult: null, summary: { plannerCalled: false, coderCalled: false,
              verifierCalled: false, applyCalled: false, stageReceiptCount: 0 } };
        } });
      assert.equal(response.output.apply, 'NOT_RUN');
      assert.equal(runtime.verifySourceIdentity(refreshed.root, manifest.sourceHead), before);
    }
    assert.deepEqual(captured.minimal.context, captured.current.context);
    assert.notDeepEqual(captured.current.context, captured.expanded.context);
    assert(JSON.stringify(captured.expanded.context).includes('apps/web/src/index.ts'));
    assert(JSON.stringify(captured.expanded.context).includes('packages/integrations/src/index.ts'));
    assert.equal(JSON.stringify(captured.expanded.context).includes('readableFiles'), false);
    assert.equal(JSON.stringify(captured.expanded.context).includes('contentHash'), false);
    assert.deepEqual(captured.minimal.runtimeData.readableFiles,
      captured.expanded.runtimeData.readableFiles);
    assert.equal(runtime.verifySourceIdentity(refreshed.root, manifest.sourceHead), '?? .bounded/');
    console.log('context-token-matrix-live-runner-smoke: PASS');
  } finally {
    if (savedKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = savedKey;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
