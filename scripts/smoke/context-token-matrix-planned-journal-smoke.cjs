#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const { validatePlannedContextMatrixAuthority: validateAuthority, createPlannedContextMatrixAuthority: authority } = await import(pathToFileURL(path.join(
    repository, 'dist/packages/integrations/src/planned-experiment-authority.js')).href);
  const { createDurableInvocationJournal, inspectPlannedExperimentJournal } = await import(
    pathToFileURL(path.join(repository,
      'dist/packages/integrations/src/durable-invocation-journal.js')).href);
  const { CodexAgentAdapter } = await import(pathToFileURL(path.join(repository,
    'dist/packages/integrations/src/codex-agent-adapter.js')).href);
  const { plannerPrompt, coderPrompt } = await import(pathToFileURL(path.join(repository,
    'dist/apps/cli/src/providers/codex-bounded-provider.js')).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-journal-smoke-'));
  const command = (cwd, args) => { const result = spawnSync('git', args,
    { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    const harness = path.join(temp, 'harness');
    const source = path.join(temp, 'source');
    const head = command(repository, ['rev-parse', 'HEAD']);
    command(repository, ['clone', '--quiet', '--shared', '--no-checkout', '--', repository, harness]);
    command(harness, ['checkout', '--quiet', '-B', 'research/context-token-matrix-v1', head]);
    command(harness, ['clone', '--quiet', '--shared', '--no-checkout', '--', harness, source]);
    command(source, ['checkout', '--quiet', '--detach',
      'ea6bc88e947e78b7539b9614b4c637dd9b2805a9']);
    const manifestPath = path.join(harness, 'research/context-token-matrix-v1/experiment-manifest.json');
    const make = (variant, sessionId = 'stage1-journalfixture1') => authority({ manifestPath,
      sourceRepositoryPath: source, sessionId, harnessHead: head, variant, repetitionIndex: 1 });
    const cells = ['minimal', 'current', 'expanded'].map(variant => make(variant));
    const objective = JSON.parse(fs.readFileSync(path.join(source,
      'pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json'), 'utf8')).taskPrompt;
    const plannerTask = plannerPrompt({ taskContext: { objective },
      allowedChangeFiles: cells[0].allowedFiles });
    const coderTask = coderPrompt({ baseContext: { taskContext: {
      taskContext: { taskContext: { objective } } } } }, cells[0].allowedFiles);
    const journalPath = path.join(temp, 'existing.sqlite');
    const journal = createDurableInvocationJournal(journalPath);
    const request = (runId, stage, plannedExperiment,
      task = stage === 'planner' ? plannerTask : coderTask) => ({
      runId, stage, task, model: 'gpt-5.6-luna', deadlineAt: Date.now() + 60_000,
      ...(plannedExperiment ? { plannedExperiment, sourceRepositoryPath: source,
        reasoningEffort: 'medium' } : {}) });
    const finish = value => { journal.start(value.invocationKey);
      journal.finish(value.invocationKey, 'completed'); };
    const historical = journal.reserve(request('normal.historical', 'planner', null));
    finish(historical);
    assert.throws(() => journal.reserve(request('normal.replay', 'planner', null)),
      { code: 'invocation_replay_forbidden' });
    const db = new DatabaseSync(journalPath, { readOnly: true });
    const old = db.prepare('SELECT record_json, record_hash FROM provider_invocations WHERE run_id = ?')
      .get('normal.historical');
    db.close();
    const statBefore = fs.statSync(journalPath);
    const planned = () => inspectPlannedExperimentJournal(journalPath,
      cells.map(cell => ({ authority: cell, sourceRepositoryPath: source })));
    assert.deepEqual(planned().map(cell => cell.authorized), [true, true, true]);
    assert.equal(fs.statSync(journalPath).mtimeMs, statBefore.mtimeMs,
      'read-only inspection may not mutate the journal');
    assert.throws(() => journal.reserve(request('cross.coder', 'coder', cells[1])),
      { code: 'invocation_replay_forbidden' });
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      validateAuthority(cell, { sourceRepositoryPath: source, model: 'gpt-5.6-luna', reasoning: 'medium', stage: 'planner', task: plannerTask });
      const planner = journal.reserve(request(`planned.${index}.planner`, 'planner', cell));
      assert.equal(planner.plannedExperiment.cellHash, cell.cellHash);
      finish(planner);
      const coder = journal.reserve(request(`planned.${index}.coder`, 'coder', cell));
      finish(coder);
      assert.throws(() => journal.reserve(request(`planned.${index}.changed-run`, 'planner', cell)),
        { code: 'invocation_replay_forbidden' });
    }
    assert.deepEqual(planned().map(cell => cell.replayForbidden), [true, true, true]);
    assert.throws(() => journal.reserve(request('same.slot.new.session', 'planner',
      make('minimal', 'stage1-anothersession1'))), { code: 'invocation_replay_forbidden' });
    assert.throws(() => make('unknown'), /planned_experiment_authority_invalid/);
    assert.throws(() => authority({ manifestPath, sourceRepositoryPath: source,
      sessionId: 'stage1-journalfixture1', harnessHead: head, variant: 'minimal',
      repetitionIndex: 2 }), /planned_experiment_authority_invalid/);
    const changed = (field, value) => ({ ...cells[0], [field]: value });
    for (const [field, value] of [
      ['model', 'other-model'], ['reasoning', 'high'],
      ['sourceHead', '0'.repeat(40)], ['baseTaskHash', `sha256:${'0'.repeat(64)}`],
      ['allowedFiles', ['other.ts']], ['retryCount', 1], ['repairCount', 1],
      ['applyCount', 1], ['sessionHash', `sha256:${'0'.repeat(64)}`]
    ]) assert.throws(() => journal.reserve(request(`tamper.${field}`, 'planner',
      changed(field, value))), { code: 'invocation_replay_forbidden' }, field);
    assert.throws(() => journal.reserve(request('tamper.task', 'planner', cells[0],
      plannerTask.replace(objective, 'unrelated task'))),
    { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('tamper.planner-files', 'planner', cells[0],
      plannerTask.replace(JSON.stringify(cells[0].allowedFiles), JSON.stringify(['other.ts'])))),
    { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('tamper.coder-files', 'coder', cells[0],
      coderTask.replace(JSON.stringify(cells[0].allowedFiles), JSON.stringify(['other.ts'])))),
    { code: 'invocation_replay_forbidden' });
    const bytes = fs.readFileSync(manifestPath);
    fs.writeFileSync(manifestPath, Buffer.concat([bytes, Buffer.from(' ')]));
    assert.throws(() => journal.reserve(request('tamper.manifest', 'planner', cells[0])),
      { code: 'invocation_replay_forbidden' });
    fs.writeFileSync(manifestPath, bytes);
    assert.throws(() => journal.reserve({ ...request('tamper.retry-decision', 'planner', cells[0]),
      retryDecision: { decisionId: 'forged', supersedesRunId: 'normal.historical',
        newRunId: 'tamper.retry-decision', stage: 'planner',
        taskHash: historical.taskHash, model: 'gpt-5.6-luna' } }),
      { code: 'invocation_replay_forbidden' });
    const verify = new DatabaseSync(journalPath, { readOnly: true });
    const oldAfter = verify.prepare('SELECT record_json, record_hash FROM provider_invocations WHERE run_id = ?')
      .get('normal.historical');
    const rowCount = verify.prepare('SELECT COUNT(*) AS count FROM provider_invocations').get().count;
    verify.close();
    assert.deepEqual(oldAfter, old, 'historical normal row must remain byte-for-byte unchanged');
    assert.equal(rowCount, 7, 'one normal row and six planned operations only');
    // The actual adapter boundary must reject malformed experiment authority before its fake SDK runs.
    let providerCalls = 0;
    const adapter = new CodexAgentAdapter({
      environment: { HOME: temp, PATH: process.env.PATH }, authCheck: async () => true,
      invocationJournalPath: journalPath,
      clientFactory: () => ({ startThread: () => ({ runStreamed: async () => {
        providerCalls++;
        return { events: (async function* () { yield { type: 'thread.started', thread_id: 'fake' };
          yield { type: 'turn.started' }; yield { type: 'turn.completed',
            usage: { input_tokens: 1, output_tokens: 1 } }; })() };
      } }) })
    });
    const result = await adapter.run({ runId: 'adapter.malformed', agentId: 'codex',
      workingDirectory: temp, sourceRepositoryPath: source,
      task: plannerTask, model: 'gpt-5.6-luna', reasoningEffort: 'medium',
      mode: 'planner', timeoutMs: 10_000, networkAllowed: false,
      sandboxMode: 'read_only', repositoryRequirement: 'none',
      plannedExperiment: changed('allowedFiles', ['forged.ts']) });
    assert.equal(result.status, 'rejected');
    assert.equal(providerCalls, 0);
    const duplicate = await adapter.run({ runId: 'adapter.duplicate', agentId: 'codex',
      workingDirectory: temp, sourceRepositoryPath: source, task: plannerTask,
      model: 'gpt-5.6-luna', reasoningEffort: 'medium', mode: 'planner',
      timeoutMs: 10_000, networkAllowed: false, sandboxMode: 'read_only',
      repositoryRequirement: 'none', plannedExperiment: cells[0] });
    assert.equal(duplicate.status, 'rejected');
    assert.equal(providerCalls, 0);
    const journalFreeAdapter = new CodexAgentAdapter({
      environment: { HOME: temp, PATH: process.env.PATH },
      authCheck: async () => true,
      clientFactory: () => ({ startThread: () => ({ runStreamed: async () => {
        providerCalls++; throw Error('must never run'); } }) }) });
    const journalFree = await journalFreeAdapter.run({ runId: 'adapter.no-journal',
      agentId: 'codex', workingDirectory: temp, sourceRepositoryPath: source,
      task: plannerTask, model: 'gpt-5.6-luna', reasoningEffort: 'medium',
      mode: 'planner', timeoutMs: 10_000, networkAllowed: false,
      sandboxMode: 'read_only', repositoryRequirement: 'none',
      plannedExperiment: cells[0] });
    assert.equal(journalFree.status, 'rejected');
    assert.equal(providerCalls, 0);
    const finalDb = new DatabaseSync(journalPath, { readOnly: true });
    assert.equal(finalDb.prepare('SELECT COUNT(*) AS count FROM provider_invocations').get().count, 7);
    finalDb.close();
    const ambiguousJournal = createDurableInvocationJournal(path.join(temp, 'ambiguous.sqlite'));
    const ambiguous = ambiguousJournal.reserve(request('planned.ambiguous', 'planner', cells[0]));
    ambiguousJournal.start(ambiguous.invocationKey);
    ambiguousJournal.finish(ambiguous.invocationKey, 'outcome_unknown');
    assert.throws(() => ambiguousJournal.authorizeRetry({
      decisionId: 'planned.retry', supersedesRunId: ambiguous.runId,
      newRunId: 'planned.retry.run', stage: 'planner', taskHash: ambiguous.taskHash,
      model: ambiguous.model }), { code: 'invocation_replay_forbidden' });
    console.log('context-token-matrix-planned-journal-smoke: PASS');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
