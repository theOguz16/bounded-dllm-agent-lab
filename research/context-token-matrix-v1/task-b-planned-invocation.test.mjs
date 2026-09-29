#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT } from './live-runtime.mjs';
import { loadTaskBPlan, stage1Slots, preflightTaskBJournalAuthority, capturePlannerRequest } from './task-b-live.mjs';
import { makeJournalScopedAdapter } from './live-runtime.mjs';
import { createTaskBInvocationAuthority, validateTaskBInvocationAuthority } from
  '../../dist/packages/integrations/src/task-b-invocation-authority.js';
import { createDurableInvocationJournal, inspectTaskBExperimentJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { coderPrompt } from
  '../../dist/apps/cli/src/providers/codex-bounded-provider.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-planned-journal-'));
let providerCalls = 0;
try {
  const plan = loadTaskBPlan();
  const source = createSourceCheckout(temp);
  const journalPath = path.join(temp, 'provider-invocations.sqlite');
  fs.copyFileSync(expectedJournalPath(), journalPath);
  const historic = path.join(os.homedir(), '.bounded-agent/bounded-dllm-agent-lab/live-runs',
    'context-token-matrix-v1/task-b-stage1-20260929-r2');
  const copyRoot = path.join(temp, 'live-runs/context-token-matrix-v1/task-b-stage1-20260929-r2');
  fs.mkdirSync(copyRoot, { recursive: true });
  for (const name of ['stage1-summary.json', 'reservation-1.json'])
    fs.copyFileSync(path.join(historic, name), path.join(copyRoot, name));
  for (const suffix of ['r1', 'r3']) {
    const session = `task-b-stage1-20260929-${suffix}`;
    const from = path.join(os.homedir(), '.bounded-agent/bounded-dllm-agent-lab/live-runs',
      'context-token-matrix-v1', session);
    const to = path.join(temp, 'live-runs/context-token-matrix-v1', session);
    fs.mkdirSync(to, { recursive: true });
    for (const name of ['stage1-summary.json', 'reservation-1.json'])
      fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
  const before = fs.readFileSync(expectedJournalPath());
  const oldDb = new DatabaseSync(journalPath, { readOnly: true });
  const initialRows = oldDb.prepare('SELECT count(*) AS n FROM provider_invocations').get().n;
  const historicRows = oldDb.prepare('SELECT run_id, record_json, record_hash FROM provider_invocations WHERE run_id LIKE ? ORDER BY run_id')
    .all('matrix.task-b-stage1-20260929-r2.%');
  oldDb.close();
  assert.equal(historicRows.length, 2);
  const captureRoot = path.join(temp, 'preflight-captures');
  fs.mkdirSync(captureRoot);
  const futureSlots = stage1Slots(plan, 'task-b-stage1-offline-proof');
  const preview = await preflightTaskBJournalAuthority(plan, futureSlots, journalPath, captureRoot);
  assert.deepEqual(preview.inspected.map(item => item.status), [
    'reviewed_replacement_required', ...Array(5).fill('fresh_planned_observation')]);
  assert.equal(fs.existsSync(path.join(temp, 'task-b-stage1-offline-proof')), false);
  const unchanged = new DatabaseSync(journalPath, { readOnly: true });
  assert.equal(unchanged.prepare('SELECT count(*) AS n FROM provider_invocations').get().n,
    initialRows);
  unchanged.close();
  const journal = createDurableInvocationJournal(journalPath);
  const files = plan.task.allowedFiles;
  const oneCaptureRoot = path.join(temp, 'exact-planner-capture');
  fs.mkdirSync(oneCaptureRoot);
  const task = (await capturePlannerRequest(plan, 'minimal', oneCaptureRoot)).task;
  const coderTask = coderPrompt({ baseContext: { taskContext: {
    taskContext: { taskContext: { objective: plan.task.providerPrompt } } } } }, files);
  const make = (sessionId, position, replicate, variant, stage, replacement = position === 1) =>
    createTaskBInvocationAuthority({ harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source,
      sessionId, position, replicate, variant, stage, replacement });
  const request = (authority, suffix, providerTask = task) => ({
    runId: `matrix.${authority.runtimeIdentity}.${authority.stage}.${suffix}`,
    stage: authority.stage, task: providerTask, model: 'gpt-5.6-luna',
    reasoningEffort: 'medium', sourceRepositoryPath: source,
    deadlineAt: Date.now() + 60_000, plannedTaskB: authority
  });
  const inspect = (authority, suffix = 'offline') =>
    inspectTaskBExperimentJournal(journalPath, [{ authority,
      sourceRepositoryPath: source, runId: request(authority, suffix).runId, task }])[0];
  const session = 'task-b-stage1-offline-journal';
  const replacement = make(session, 1, 'A', 'minimal', 'planner');
  assert.equal(inspect(replacement).status, 'reviewed_replacement_required');
  assert.equal(inspect(replacement).authorized, true);
  const reviewedSummary = path.join(copyRoot, 'stage1-summary.json');
  const originalSummaryBytes = fs.readFileSync(reviewedSummary);
  fs.writeFileSync(reviewedSummary, originalSummaryBytes.toString('utf8')
    .replace('Candidate path alias', 'Candidate model failure'));
  assert.equal(inspect(replacement).status, 'authority_conflict');
  fs.writeFileSync(reviewedSummary, originalSummaryBytes);
  assert.equal(inspect(replacement).authorized, true);
  assert.throws(() => make(session, 1, 'A', 'minimal', 'planner', false),
    /replacement slot binding/);
  assert.throws(() => make(session, 2, 'A', 'current', 'planner', true),
    /replacement slot binding/);
  const fresh = make(session, 2, 'A', 'current', 'planner');
  let scopedRequest = null;
  const scoped = makeJournalScopedAdapter({ agentId: 'offline', agentVersion: '1',
    async run(value) { scopedRequest = value; return { status: 'rejected' }; } },
  fresh.runtimeIdentity, null, null, null, { planner: fresh });
  await scoped.run({ mode: 'planner', runId: 'planner.fixture', model: 'gpt-5.6-luna',
    reasoningEffort: 'medium' });
  assert.strictEqual(scopedRequest.plannedTaskB, fresh);
  assert.equal(scopedRequest.runId,
    `matrix.${fresh.runtimeIdentity}.planner.fixture`);
  const distinct = make(session, 3, 'A', 'expanded', 'planner');
  assert.equal(inspect(fresh).status, 'fresh_planned_observation');
  assert.equal(replacement.replacement.originalSlotHash, replacement.slotHash);
  assert.notEqual(fresh.slotHash, distinct.slotHash);
  assert.throws(() => journal.reserve(request(make(session, 2, 'A', 'current', 'coder'),
    'too-early', coderTask)), { code: 'invocation_replay_forbidden' });
  const first = journal.reserve(request(fresh, 'first'));
  journal.start(first.invocationKey); journal.finish(first.invocationKey, 'completed');
  const second = journal.reserve(request(distinct, 'second'));
  journal.start(second.invocationKey); journal.finish(second.invocationKey, 'completed');
  assert.equal(first.taskHash, second.taskHash, 'distinct planned slots share exact payload');
  assert.throws(() => journal.reserve(request(fresh, 'again')),
    { code: 'invocation_replay_forbidden' });
  assert.equal(inspect(fresh).authorized, false, 'preflight sees consumed slot before reservation');
  assert.throws(() => journal.reserve(request(make('task-b-stage1-another-run', 2,
    'A', 'current', 'planner'), 'new-session')), { code: 'invocation_replay_forbidden' });
  const coder = make(session, 2, 'A', 'current', 'coder');
  assert.notEqual(coder.stageHash, fresh.stageHash);
  assert.throws(() => journal.reserve(request(coder, 'wrong-stage', task)),
    { code: 'invocation_replay_forbidden' });
  const coderRow = journal.reserve(request(coder, 'coder', coderTask));
  journal.start(coderRow.invocationKey); journal.finish(coderRow.invocationKey, 'completed');
  assert.throws(() => journal.reserve({ ...request(distinct, 'retry'),
    retryDecision: { decisionId: 'forged', supersedesRunId: first.runId,
      newRunId: request(distinct, 'retry').runId, stage: 'planner',
      taskHash: first.taskHash, model: 'gpt-5.6-luna' } }),
  { code: 'invocation_replay_forbidden' });
  const replaced = journal.reserve(request(replacement, 'replacement'));
  journal.start(replaced.invocationKey); journal.finish(replaced.invocationKey, 'completed');
  const replacementCoder = make(session, 1, 'A', 'minimal', 'coder');
  const replacementCoderRow = journal.reserve(request(replacementCoder, 'replacement-coder', coderTask));
  journal.start(replacementCoderRow.invocationKey);
  journal.finish(replacementCoderRow.invocationKey, 'completed');
  assert.throws(() => journal.reserve(request(replacement, 'second-use')),
    { code: 'invocation_replay_forbidden' });
  assert.throws(() => journal.reserve(request(make('task-b-stage1-next-review', 1,
    'A', 'minimal', 'planner'), 'new-replacement')), { code: 'invocation_replay_forbidden' });
  const failed = make(session, 4, 'B', 'current', 'planner');
  const failedRow = journal.reserve(request(failed, 'candidate-failure'));
  journal.start(failedRow.invocationKey); journal.finish(failedRow.invocationKey, 'failed');
  assert.throws(() => journal.reserve(request(make('task-b-stage1-other-run', 4,
    'B', 'current', 'planner'), 'candidate-replacement')),
  { code: 'invocation_replay_forbidden' });
  assert.throws(() => validateTaskBInvocationAuthority({
    ...replacement, replacement: { ...replacement.replacement, replacementOrdinal: 2 }
  }, { sourceRepositoryPath: source, runId: request(replacement, 'tamper').runId,
    stage: 'planner', model: 'gpt-5.6-luna', reasoning: 'medium', task }),
  /authority differs/);
  const verify = new DatabaseSync(journalPath, { readOnly: true });
  assert.deepEqual(verify.prepare('SELECT run_id, record_json, record_hash FROM provider_invocations WHERE run_id LIKE ? ORDER BY run_id')
    .all('matrix.task-b-stage1-20260929-r2.%'), historicRows);
  verify.close();
  assert.deepEqual(fs.readFileSync(expectedJournalPath()), before);
  assert.equal(providerCalls, 0);
  console.log('Task B planned journal/replacement authority: PASS (provider/model calls 0)');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
