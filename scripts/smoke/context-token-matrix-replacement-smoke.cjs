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
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-replacement-'));
  try {
    const harness = path.join(root, 'harness'), source = path.join(root, 'source');
    const head = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'clone', '--quiet', '--shared', '--no-checkout', '--', repository, harness);
    git(harness, 'checkout', '--quiet', '-B', 'research/context-token-matrix-v1', head);
    git(harness, 'clone', '--quiet', '--shared', '--no-checkout', '--', harness, source);
    git(source, 'checkout', '--quiet', '--detach', 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9');
    const manifestPath = path.join(harness, 'research/context-token-matrix-v1/experiment-manifest.json');
    const { createPlannedContextMatrixAuthority: makeAuthority,
      readPlannedReplacementReview } = await import(pathToFileURL(path.join(repository,
      'dist/packages/integrations/src/planned-experiment-authority.js')).href);
    const { createDurableInvocationJournal: createJournal,
      inspectPlannedExperimentJournal: inspect } = await import(pathToFileURL(path.join(repository,
      'dist/packages/integrations/src/durable-invocation-journal.js')).href);
    const { plannerPrompt, coderPrompt } = await import(pathToFileURL(path.join(repository,
      'dist/apps/cli/src/providers/codex-bounded-provider.js')).href);
    const review = readPlannedReplacementReview(manifestPath);
    const make = (variant = 'minimal', sessionId = 'stage1-replacementfixture', replacement = true) =>
      makeAuthority({ manifestPath, sourceRepositoryPath: source, sessionId, harnessHead: head,
        variant, repetitionIndex: 1, ...(replacement ? { replacementAttemptIndex: 2,
          replacesSessionId: review.failedSessionId } : {}) });
    const cell = make(), initial = make('minimal', 'stage1-initialfixture', false);
    const objective = JSON.parse(fs.readFileSync(path.join(source,
      'pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json'))).taskPrompt;
    const plannerTask = plannerPrompt({ taskContext: { objective },
      allowedChangeFiles: cell.allowedFiles });
    const coderTask = coderPrompt({ baseContext: { taskContext: {
      taskContext: { taskContext: { objective } } } } }, cell.allowedFiles);
    const request = (runId, stage, authority = cell) => ({ runId, stage,
      task: stage === 'planner' ? plannerTask : coderTask,
      model: 'gpt-5.6-luna', deadlineAt: Date.now() + 60000,
      plannedExperiment: authority, sourceRepositoryPath: source, reasoningEffort: 'medium' });
    const journalPath = path.join(root, 'journal.sqlite');
    const journal = createJournal(journalPath);
    // The old journal row is inserted as an immutable historical fixture. Its identity
    // and state match the reviewed partial session; the test never changes it.
    const oldAuthority = { ...initial, sessionId: review.failedSessionId,
      sessionHash: 'sha256:c6b51a497f43cf7e94e73fa51272756fa5f0e170f9d47a6e93edaf9fef3a21e1',
      harnessHead: review.failedHarnessHead, cellHash: review.failedCellHash };
    const oldKey = digest(JSON.stringify([review.failedPlannerRunId, 'planner']));
    const oldRecord = { version: 'durable-invocation-journal/v3', invocationKey: oldKey,
      runId: review.failedPlannerRunId, stage: 'planner', state: 'completed',
      plannedExperiment: oldAuthority };
    const oldJson = JSON.stringify(oldRecord);
    const db = new DatabaseSync(journalPath);
    db.exec(`CREATE TABLE provider_invocations (
      invocation_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL,
      record_json TEXT NOT NULL, record_hash TEXT NOT NULL, UNIQUE(run_id, stage))`);
    db.prepare(`INSERT INTO provider_invocations
      (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)`).run(
        oldKey, review.failedPlannerRunId, 'planner', oldJson, digest(oldJson));
    db.close();
    const before = fs.readFileSync(journalPath);
    const state = inspect(journalPath, [{ authority: initial, sourceRepositoryPath: source },
      { authority: cell, sourceRepositoryPath: source }]);
    assert.equal(state[0].availability, 'consumed_infrastructure_invalidated');
    assert.equal(state[0].authorized, false);
    assert.equal(state[1].availability, 'replacement_authorized');
    assert.equal(state[1].authorized, true);
    assert.deepEqual(fs.readFileSync(journalPath), before, 'preflight inspection must be read-only');
    assert.throws(() => journal.reserve(request('random.planner', 'planner', initial)),
      { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('replacement.coder.early', 'coder')),
      { code: 'invocation_replay_forbidden' });
    journal.authorizePlannedReplacement(cell, source);
    assert.throws(() => journal.authorizePlannedReplacement(make('minimal',
      'stage1-secondreplacement'), source), { code: 'invocation_replay_forbidden' });
    assert.throws(() => journal.reserve(request('replacement.coder.old-planner', 'coder')),
      { code: 'invocation_replay_forbidden' });
    for (const [variant, index] of ['minimal', 'current', 'expanded'].map((v, i) => [v, i])) {
      const authority = make(variant);
      const planner = journal.reserve(request(`replacement.${index}.planner`, 'planner', authority));
      journal.start(planner.invocationKey);
      journal.finish(planner.invocationKey, 'completed');
      assert.throws(() => journal.reserve(request(`replacement.${index}.planner-again`,
        'planner', authority)), { code: 'invocation_replay_forbidden' });
      const coder = journal.reserve(request(`replacement.${index}.coder`, 'coder', authority));
      journal.start(coder.invocationKey);
      journal.finish(coder.invocationKey, 'completed');
      assert.equal(coder.plannedExperiment.sessionHash, authority.sessionHash);
      assert.notEqual(coder.plannedExperiment.cellHash, oldAuthority.cellHash);
    }
    const tamper = (field, value) => ({ ...cell, [field]: value });
    for (const [field, value] of [
      ['variant', 'expanded'], ['repetitionIndex', 2], ['taskId', 'other'],
      ['sourceHead', '0'.repeat(40)], ['allowedFiles', ['other.ts']],
      ['model', 'other'], ['reasoning', 'high'], ['retryCount', 1],
      ['repairCount', 1], ['applyCount', 1], ['replacementAttemptIndex', 3]
    ]) assert.throws(() => journal.reserve(request(`tamper.${field}`, 'planner',
      tamper(field, value))), { code: 'invocation_replay_forbidden' }, field);
    assert.throws(() => journal.reserve({ ...request('tamper.task', 'planner', cell),
      task: plannerTask.replace(objective, 'different task') }),
    { code: 'invocation_replay_forbidden' });
    const check = new DatabaseSync(journalPath, { readOnly: true });
    const historical = check.prepare('SELECT record_json, record_hash FROM provider_invocations WHERE invocation_key = ?')
      .get(oldKey);
    assert.equal(historical.record_json, oldJson);
    assert.equal(historical.record_hash, digest(oldJson));
    check.close();
    const candidatePath = path.join(root, 'candidate.sqlite');
    const candidateJournal = createJournal(candidatePath);
    // A genuine Candidate outcome has both provider operations; it cannot be reclassified
    // as the reviewed planner-only infrastructure failure.
    const candidateDb = new DatabaseSync(candidatePath);
    candidateDb.exec(`CREATE TABLE provider_invocations (
      invocation_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL,
      record_json TEXT NOT NULL, record_hash TEXT NOT NULL, UNIQUE(run_id, stage))`);
    candidateDb.prepare(`INSERT INTO provider_invocations
      (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)`).run(
        oldKey, review.failedPlannerRunId, 'planner', oldJson, digest(oldJson));
    const candidateCoderId = 'candidate.coder';
    const candidateCoderKey = digest(JSON.stringify([candidateCoderId, 'coder']));
    const candidateCoderJson = JSON.stringify({ ...oldRecord, invocationKey: candidateCoderKey,
      runId: candidateCoderId, stage: 'coder' });
    candidateDb.prepare(`INSERT INTO provider_invocations
      (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)`).run(
        candidateCoderKey, candidateCoderId, 'coder', candidateCoderJson,
        digest(candidateCoderJson));
    candidateDb.close();
    assert.throws(() => candidateJournal.authorizePlannedReplacement(cell, source),
      { code: 'invocation_replay_forbidden' });
    const reviewPath = path.join(harness,
      'research/context-token-matrix-v1/replacement-review.json');
    const reviewedBytes = fs.readFileSync(reviewPath);
    const malformed = JSON.parse(reviewedBytes);
    malformed.terminalClassification = 'ambiguous_failure';
    fs.writeFileSync(reviewPath, JSON.stringify(malformed));
    assert.throws(() => make(), /planned_experiment_authority_invalid/,
      'ambiguous or edited review cannot authorize replacement');
    fs.writeFileSync(reviewPath, reviewedBytes);
    console.log('context-token-matrix-replacement-smoke: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
