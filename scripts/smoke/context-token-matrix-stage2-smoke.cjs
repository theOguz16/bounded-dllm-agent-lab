#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const hash = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => { const x = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr); return x.stdout.trim(); };

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-stage2-'));
  try {
    const harness = path.join(root, 'harness'), source = path.join(root, 'source');
    const head = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'clone', '--quiet', '--shared', '--no-checkout', '--', repository, harness);
    git(harness, 'checkout', '--quiet', '-B', 'research/context-token-matrix-v1', head);
    git(harness, 'clone', '--quiet', '--shared', '--no-checkout', '--', harness, source);
    git(source, 'checkout', '--quiet', '--detach', 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9');
    const manifestPath = path.join(harness, 'research/context-token-matrix-v1/experiment-manifest.json');
    const authorityModule = await import(pathToFileURL(path.join(repository,
      'dist/packages/integrations/src/planned-experiment-authority.js')).href);
    const { createDurableInvocationJournal, inspectPlannedExperimentJournal } = await import(
      pathToFileURL(path.join(repository, 'dist/packages/integrations/src/durable-invocation-journal.js')).href);
    const { plannerPrompt, coderPrompt } = await import(pathToFileURL(path.join(repository,
      'dist/apps/cli/src/providers/codex-bounded-provider.js')).href);
    const review = authorityModule.readPlannedStage2Review(manifestPath);
    const make = (variant = 'minimal', sessionId = 'stage2-fixture12345678', repetitionIndex = 2) =>
      authorityModule.createPlannedContextMatrixAuthority({ manifestPath,
        sourceRepositoryPath: source, sessionId, harnessHead: head, variant, repetitionIndex });
    const objective = JSON.parse(fs.readFileSync(path.join(source,
      'pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json'))).taskPrompt;
    const plannerTask = plannerPrompt({ taskContext: { objective }, allowedChangeFiles: make().allowedFiles });
    const coderTask = coderPrompt({ baseContext: { taskContext: {
      taskContext: { taskContext: { objective } } } } }, make().allowedFiles);
    const request = (runId, stage, authority) => ({ runId, stage,
      task: stage === 'planner' ? plannerTask : coderTask, model: 'gpt-5.6-luna',
      deadlineAt: Date.now() + 60000, plannedExperiment: authority,
      sourceRepositoryPath: source, reasoningEffort: 'medium' });
    const journalPath = path.join(root, 'journal.sqlite');
    const db = new DatabaseSync(journalPath);
    db.exec(`CREATE TABLE provider_invocations (invocation_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL, stage TEXT NOT NULL, record_json TEXT NOT NULL,
      record_hash TEXT NOT NULL, UNIQUE(run_id, stage))`);
    const priorRows = [];
    const insert = (runId, stage, authority, state = 'completed') => {
      const key = hash(JSON.stringify([runId, stage]));
      const json = JSON.stringify({ version: 'durable-invocation-journal/v3',
        invocationKey: key, runId, stage, state, plannedExperiment: authority });
      db.prepare('INSERT INTO provider_invocations VALUES (?, ?, ?, ?, ?)')
        .run(key, runId, stage, json, hash(json));
      return { key, json };
    };
    for (const variant of review.stage2Order) {
      const cell = review.stage1Cells[variant];
      const authority = { ...make(variant, review.priorStage1SessionId, 1),
        sessionHash: review.priorStage1SessionHash,
        harnessHead: review.priorStage1HarnessHead, cellHash: cell.cellHash };
      priorRows.push(insert(cell.plannerRunId, 'planner', authority),
        insert(cell.coderRunId, 'coder', authority));
    }
    db.close();
    const journal = createDurableInvocationJournal(journalPath);
    const cell = make();
    const before = fs.readFileSync(journalPath);
    const availability = inspectPlannedExperimentJournal(journalPath,
      review.stage2Order.map(variant => ({ authority: make(variant), sourceRepositoryPath: source })));
    assert(availability.every(entry => entry.authorized && !entry.consumed &&
      entry.availability === 'stage2_authorized'));
    assert.deepEqual(fs.readFileSync(journalPath), before, 'preflight must be read-only');
    assert.throws(() => journal.reserve(request('stage2.early', 'planner', cell)),
      { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('stage2.coder.early', 'coder', cell)),
      { code: 'invocation_replay_forbidden' });
    journal.authorizePlannedStage2(cell, source);
    assert.throws(() => journal.authorizePlannedStage2(make('minimal', 'stage2-random12345678'), source),
      { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('stage2.coder.old-planner', 'coder', cell)),
      { code: 'invocation_replay_forbidden' });
    for (const [index, variant] of review.stage2Order.entries()) {
      const authority = make(variant);
      const planner = journal.reserve(request(`stage2.${index}.planner`, 'planner', authority));
      journal.start(planner.invocationKey); journal.finish(planner.invocationKey, 'completed');
      assert.throws(() => journal.reserve(request(`stage2.${index}.planner.again`, 'planner', authority)),
        { code: 'invocation_replay_forbidden' });
      const coder = journal.reserve(request(`stage2.${index}.coder`, 'coder', authority));
      journal.start(coder.invocationKey); journal.finish(coder.invocationKey, 'completed');
    }
    assert.throws(() => make('minimal', 'stage2-third12345678', 3));
    for (const [field, value] of [
      ['sourceHead', '0'.repeat(40)], ['manifestHash', 'sha256:' + '0'.repeat(64)],
      ['taskId', 'other'], ['variant', 'expanded'], ['repetitionIndex', 3],
      ['model', 'other'], ['reasoning', 'high'], ['retryCount', 1],
      ['repairCount', 1], ['applyCount', 1], ['stage2ReviewHash', 'sha256:' + '0'.repeat(64)]
    ]) assert.throws(() => journal.reserve(request(`stage2.tamper.${field}`, 'planner',
      { ...cell, [field]: value })), { code: 'invocation_replay_forbidden' }, field);
    const check = new DatabaseSync(journalPath, { readOnly: true });
    for (const old of priorRows) assert.equal(check.prepare(
      'SELECT record_json FROM provider_invocations WHERE invocation_key = ?').get(old.key).record_json,
    old.json);
    check.close();
    const reviewPath = path.join(harness, 'research/context-token-matrix-v1/stage2-review.json');
    const original = fs.readFileSync(reviewPath);
    fs.writeFileSync(reviewPath, Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => make('minimal', 'stage2-tamper12345678'));
    fs.writeFileSync(reviewPath, original);
    console.log('context-token-matrix-stage2-smoke: PASS (real provider calls 0)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
