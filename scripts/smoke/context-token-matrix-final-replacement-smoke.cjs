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
const git = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-final-replacement-'));
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
    const oldReview = authorityModule.readPlannedReplacementReview(manifestPath);
    const review = authorityModule.readPlannedFinalReplacementReview(manifestPath);
    const make = (variant = 'minimal', sessionId = 'stage1-finalfixture', attempt = 3,
      harnessHead = head) => authorityModule.createPlannedContextMatrixAuthority({ manifestPath,
        sourceRepositoryPath: source, sessionId, harnessHead, variant, repetitionIndex: 1,
        ...(attempt === 1 ? {} : { replacementAttemptIndex: attempt,
          replacesSessionId: attempt === 2 ? oldReview.failedSessionId : review.priorSessionId }) });
    const prior = { ...make('minimal', review.priorSessionId, 2),
      harnessHead: review.priorHarnessHead, sessionHash: review.priorSessionHash,
      cellHash: review.priorCellHash };
    const initial = { ...make('minimal', oldReview.failedSessionId, 1),
      harnessHead: oldReview.failedHarnessHead, cellHash: oldReview.failedCellHash };
    const objective = JSON.parse(fs.readFileSync(path.join(source,
      'pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json'))).taskPrompt;
    const plannerTask = plannerPrompt({ taskContext: { objective }, allowedChangeFiles: prior.allowedFiles });
    const coderTask = coderPrompt({ baseContext: { taskContext: {
      taskContext: { taskContext: { objective } } } } }, prior.allowedFiles);
    const request = (runId, stage, authority) => ({ runId, stage,
      task: stage === 'planner' ? plannerTask : coderTask, model: 'gpt-5.6-luna',
      deadlineAt: Date.now() + 60000, plannedExperiment: authority,
      sourceRepositoryPath: source, reasoningEffort: 'medium' });
    const journalPath = path.join(root, 'journal.sqlite');
    const db = new DatabaseSync(journalPath);
    db.exec(`CREATE TABLE provider_invocations (invocation_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL, stage TEXT NOT NULL, record_json TEXT NOT NULL,
      record_hash TEXT NOT NULL, UNIQUE(run_id, stage))`);
    db.exec(`CREATE TABLE planned_experiment_replacements (failed_session_id TEXT PRIMARY KEY,
      replacement_session_id TEXT NOT NULL UNIQUE, replacement_session_hash TEXT NOT NULL,
      review_hash TEXT NOT NULL, harness_head TEXT NOT NULL, authorized_at INTEGER NOT NULL)`);
    const add = (runId, stage, authority) => {
      const key = hash(JSON.stringify([runId, stage]));
      const json = JSON.stringify({ version: 'durable-invocation-journal/v3', invocationKey: key,
        runId, stage, state: 'completed', plannedExperiment: authority });
      db.prepare(`INSERT INTO provider_invocations VALUES (?, ?, ?, ?, ?)`)
        .run(key, runId, stage, json, hash(json));
      return { key, json };
    };
    const historical = [add(oldReview.failedPlannerRunId, 'planner', initial),
      add(review.priorPlannerRunId, 'planner', prior), add(review.priorCoderRunId, 'coder', prior)];
    db.prepare(`INSERT INTO planned_experiment_replacements VALUES (?, ?, ?, ?, ?, ?)`)
      .run(oldReview.failedSessionId, review.priorSessionId, prior.sessionHash,
        prior.replacementReviewHash, review.priorHarnessHead, Date.now());
    db.close();
    const cell = make(), journal = createDurableInvocationJournal(journalPath);
    const before = fs.readFileSync(journalPath);
    const state = inspectPlannedExperimentJournal(journalPath,
      ['minimal', 'current', 'expanded'].map(variant =>
        ({ authority: make(variant), sourceRepositoryPath: source })));
    assert.deepEqual(state.map(entry => entry.availability),
      Array(3).fill('final_replacement_authorized'));
    assert.deepEqual(fs.readFileSync(journalPath), before, 'inspection must be read-only');
    const candidatePath = path.join(root, 'candidate-failure.sqlite');
    fs.copyFileSync(journalPath, candidatePath);
    const candidateDb = new DatabaseSync(candidatePath);
    const priorCoder = historical[2];
    const candidateRecord = { ...JSON.parse(priorCoder.json), state: 'failed' };
    const candidateJson = JSON.stringify(candidateRecord);
    candidateDb.prepare(`UPDATE provider_invocations SET record_json = ?, record_hash = ?
      WHERE invocation_key = ?`).run(candidateJson, hash(candidateJson), priorCoder.key);
    candidateDb.close();
    assert.throws(() => createDurableInvocationJournal(candidatePath)
      .authorizePlannedFinalReplacement(cell, source), { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('early.planner', 'planner', cell)),
      { code: 'invocation_replay_forbidden' });
    journal.authorizePlannedFinalReplacement(cell, source);
    assert.throws(() => journal.authorizePlannedFinalReplacement(make('minimal', 'stage1-other'), source),
      { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('early.coder', 'coder', cell)),
      { code: 'invocation_replay_forbidden' });
    for (const [field, value] of [
      ['manifestHash', 'sha256:' + '0'.repeat(64)], ['sourceHead', '0'.repeat(40)],
      ['taskId', 'other'], ['variant', 'expanded'], ['repetitionIndex', 2],
      ['model', 'other'], ['reasoning', 'high'], ['retryCount', 1],
      ['repairCount', 1], ['applyCount', 1], ['replacementReviewHash', 'sha256:' + '0'.repeat(64)],
      ['replacementAttemptIndex', 4]
    ]) assert.throws(() => journal.reserve(request(`tamper.${field}`, 'planner',
      { ...cell, [field]: value })), { code: 'invocation_replay_forbidden' }, field);
    assert.throws(() => journal.reserve({ ...request('tamper.task', 'planner', cell),
      task: plannerTask.replace(objective, 'different task') }),
    { code: 'invocation_replay_forbidden' });
    for (const [index, variant] of ['minimal', 'current', 'expanded'].entries()) {
      const authority = make(variant);
      const planner = journal.reserve(request(`final.${index}.planner`, 'planner', authority));
      journal.start(planner.invocationKey); journal.finish(planner.invocationKey, 'completed');
      assert.throws(() => journal.reserve(request(`final.${index}.planner-again`, 'planner', authority)),
        { code: 'invocation_replay_forbidden' });
      const coder = journal.reserve(request(`final.${index}.coder`, 'coder', authority));
      journal.start(coder.invocationKey); journal.finish(coder.invocationKey, 'completed');
    }
    const after = inspectPlannedExperimentJournal(journalPath,
      [{ authority: cell, sourceRepositoryPath: source }]);
    assert.equal(after[0].availability, 'final_replacement_consumed');
    assert.equal(after[0].authorized, false);
    assert.throws(() => make('minimal', 'stage1-fourth', 4));
    const check = new DatabaseSync(journalPath, { readOnly: true });
    for (const item of historical) {
      const stored = check.prepare('SELECT record_json FROM provider_invocations WHERE invocation_key = ?')
        .get(item.key);
      assert.equal(stored.record_json, item.json);
    }
    check.close();
    const reviewPath = path.join(harness, 'research/context-token-matrix-v1/final-replacement-review.json');
    const original = fs.readFileSync(reviewPath);
    for (const [field, value] of [
      ['defect', 'candidate-failure'], ['fixCommit', '0'.repeat(40)],
      ['sourceHead', '0'.repeat(40)], ['manifestHash', 'sha256:' + '0'.repeat(64)]
    ]) {
      fs.writeFileSync(reviewPath, JSON.stringify({ ...review, [field]: value }) + '\n');
      assert.throws(() => make('minimal', `stage1-tampered-${field}`));
    }
    fs.writeFileSync(reviewPath, original);
    console.log('context-token-matrix-final-replacement-smoke: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
