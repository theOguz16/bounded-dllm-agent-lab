#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT } from './live-runtime.mjs';
import { loadTaskBPlan, stage1Slots, preflightTaskBJournalAuthority,
  capturePlannerRequest } from './task-b-live.mjs';
import { createTaskBInvocationAuthority, validateTaskBInvocationAuthority,
  readTaskBOracleReplacementReview } from '../../dist/packages/integrations/src/task-b-invocation-authority.js';
import { createDurableInvocationJournal, inspectTaskBExperimentJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { coderPrompt } from '../../dist/apps/cli/src/providers/codex-bounded-provider.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-planned-journal-'));
let providerCalls = 0;
try {
  const plan = loadTaskBPlan();
  const review = readTaskBOracleReplacementReview(HARNESS_ROOT);
  assert.deepEqual(review.slots.map(item => item.replacementOrdinal), [2, 1, 1, 1, 1, 1]);
  const source = createSourceCheckout(temp);
  const journalPath = path.join(temp, 'provider-invocations.sqlite');
  fs.copyFileSync(expectedJournalPath(), journalPath);
  // Replay the historical pre-r7 authority state in this disposable journal only.
  // The durable journal now correctly records r7 A slots as consumed.
  const fixtureDb = new DatabaseSync(journalPath);
  fixtureDb.prepare("DELETE FROM provider_invocations WHERE run_id LIKE ?")
    .run('matrix.task-b-stage1-20260930-r7.%');
  fixtureDb.prepare("DELETE FROM provider_invocations WHERE run_id LIKE ?")
    .run('matrix.task-b-stage1-20260930-suffix-r1.%');
  fixtureDb.close();
  const history = path.join(os.homedir(), '.bounded-agent/bounded-dllm-agent-lab/live-runs',
    'context-token-matrix-v1');
  const copied = path.join(temp, 'live-runs/context-token-matrix-v1');
  for (const session of ['task-b-stage1-20260929-r1', 'task-b-stage1-20260929-r2',
    'task-b-stage1-20260929-r3', 'task-b-stage1-20260930-r4'])
    fs.cpSync(path.join(history, session), path.join(copied, session), { recursive: true });
  const originalJournal = fs.readFileSync(expectedJournalPath());
  const existingDb = new DatabaseSync(journalPath, { readOnly: true });
  const existingCount = existingDb.prepare('SELECT count(*) AS n FROM provider_invocations').get().n;
  const historicalRows = existingDb.prepare('SELECT run_id, record_hash FROM provider_invocations WHERE run_id LIKE ? ORDER BY run_id')
    .all('matrix.task-b-stage1-20260930-r4.%');
  existingDb.close();
  assert.equal(historicalRows.length, 12);
  const future = 'task-b-stage1-offline-proof';
  const preview = await preflightTaskBJournalAuthority(plan, stage1Slots(plan, future), journalPath, temp);
  assert.deepEqual(preview.inspected.map(item => item.status),
    Array(6).fill('reviewed_replacement_required'));
  assert.ok(preview.inspected.every(item => item.authorized && item.coderFutureAdmissible));
  assert.deepEqual(preview.slots.map(item => item.taskBPlannerAuthority.replacement.replacementOrdinal),
    [2, 1, 1, 1, 1, 1]);
  assert.equal(fs.existsSync(path.join(temp, future)), false);
  const unchanged = new DatabaseSync(journalPath, { readOnly: true });
  assert.equal(unchanged.prepare('SELECT count(*) AS n FROM provider_invocations').get().n, existingCount);
  unchanged.close();
  const captureRoot = path.join(temp, 'single-planner-capture');
  fs.mkdirSync(captureRoot);
  const task = (await capturePlannerRequest(plan, 'minimal', captureRoot)).task;
  const files = plan.task.allowedFiles;
  const coderTask = coderPrompt({ baseContext: { taskContext: {
    taskContext: { taskContext: { objective: plan.task.providerPrompt } } } } }, files);
  const make = (sessionId, position, replicate, variant, stage, replacement = true) =>
    createTaskBInvocationAuthority({ harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source,
      sessionId, position, replicate, variant, stage, replacement });
  const request = (authority, suffix, providerTask = task) => ({
    runId: `matrix.${authority.runtimeIdentity}.${authority.stage}.${suffix}`,
    stage: authority.stage, task: providerTask, model: 'gpt-5.6-luna',
    reasoningEffort: 'medium', sourceRepositoryPath: source,
    deadlineAt: Date.now() + 60_000, plannedTaskB: authority
  });
  const inspect = authority => inspectTaskBExperimentJournal(journalPath, [{ authority,
    sourceRepositoryPath: source, runId: request(authority, 'fixture').runId, task }])[0];
  const slot1 = make(future, 1, 'A', 'minimal', 'planner');
  const slot2 = make(future, 2, 'A', 'current', 'planner');
  assert.equal(inspect(slot1).status, 'reviewed_replacement_required');
  assert.equal(inspect(slot2).status, 'reviewed_replacement_required');
  assert.throws(() => make(future, 1, 'A', 'minimal', 'planner', false), /replacement slot binding/);
  assert.throws(() => make(future, 2, 'A', 'current', 'planner', false), /replacement slot binding/);
  assert.throws(() => validateTaskBInvocationAuthority({ ...slot1,
    replacement: { ...slot1.replacement, replacementOrdinal: 1 } },
  { sourceRepositoryPath: source, runId: request(slot1, 'tamper').runId,
    stage: 'planner', model: 'gpt-5.6-luna', reasoning: 'medium', task }), /authority differs/);
  const r4Behavior = path.join(copied, 'task-b-stage1-20260930-r4',
    '01-A-minimal/behavior-check.json');
  const bytes = fs.readFileSync(r4Behavior);
  fs.writeFileSync(r4Behavior, bytes.toString('utf8').replace('"FAIL"', '"PASS"'));
  assert.equal(inspect(slot1).status, 'authority_conflict');
  fs.writeFileSync(r4Behavior, bytes);
  assert.equal(inspect(slot1).authorized, true);
  const journal = createDurableInvocationJournal(journalPath);
  const first = journal.reserve(request(slot1, 'first'));
  journal.start(first.invocationKey); journal.finish(first.invocationKey, 'completed');
  const coder = make(future, 1, 'A', 'minimal', 'coder');
  const second = journal.reserve(request(coder, 'coder', coderTask));
  journal.start(second.invocationKey); journal.finish(second.invocationKey, 'completed');
  assert.throws(() => journal.reserve(request(slot1, 'repeat')),
    { code: 'invocation_replay_forbidden' });
  assert.throws(() => journal.reserve(request(make('task-b-stage1-another-run', 1,
    'A', 'minimal', 'planner'), 'another')),
  { code: 'invocation_replay_forbidden' });
  assert.equal(inspect(slot2).authorized, true);
  const verify = new DatabaseSync(journalPath, { readOnly: true });
  assert.deepEqual(verify.prepare('SELECT run_id, record_hash FROM provider_invocations WHERE run_id LIKE ? ORDER BY run_id')
    .all('matrix.task-b-stage1-20260930-r4.%'), historicalRows);
  verify.close();
  assert.deepEqual(fs.readFileSync(expectedJournalPath()), originalJournal);
  assert.equal(providerCalls, 0);
  console.log('Task B r4 reviewed replacement authority: PASS (provider/model calls 0)');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
