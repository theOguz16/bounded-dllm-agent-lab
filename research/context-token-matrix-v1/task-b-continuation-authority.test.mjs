#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectedJournalPath, outputParent } from './live-runtime.mjs';
import { authorizeTaskBContinuation, createTaskBContinuationBudget,
  inspectR7RetainedPrefix, verifyR7RetainedPrefix } from './task-b-continuation-authority.mjs';

const sessionId = 'task-b-stage1-future-offline-fixture';
const authorityTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-authority-state-'));
const authorityJournal = path.join(authorityTemp, 'journal.sqlite');
fs.copyFileSync(expectedJournalPath(), authorityJournal);
const authorityDb = new DatabaseSync(authorityJournal);
for (const row of authorityDb.prepare('SELECT run_id, record_json FROM provider_invocations').all()) {
  const item = JSON.parse(row.record_json).plannedTaskB;
  if (item?.position >= 4 && item.position <= 6 &&
      item.sessionId !== 'task-b-stage1-20260930-r4')
    authorityDb.prepare('DELETE FROM provider_invocations WHERE run_id=?').run(row.run_id);
}
authorityDb.close();
const review = verifyR7RetainedPrefix();
assert.deepEqual(inspectR7RetainedPrefix(), review);
assert.deepEqual(review.observations.map(item => item.position), [1, 2, 3]);
assert.deepEqual(review.observations.map(item => item.classification),
  ['clean_pass', 'clean_pass', 'production_product_timeout']);
assert.deepEqual(review.observations.map(item => item.normalizedOutcome.behavior),
  ['PASS', 'PASS', 'NOT_RUN']);
assert.deepEqual(review.untouchedSuffix.map(item => `${item.position}:${item.replicate}:${item.variant}`),
  ['4:B:current', '5:B:expanded', '6:B:minimal']);
assert.equal(review.observations[2].replacementEligible, false);
assert.equal(review.observations[2].journal[1].failureCode, 'agent_timeout');
assert.equal(review.observations[2].journal[1].state, 'outcome_unknown');
assert.deepEqual(review.observations[2].normalizedOutcome.candidateChangedFiles, []);
const authority = authorizeTaskBContinuation(sessionId,
  { journalPath: authorityJournal, resultParent: authorityTemp });
assert.deepEqual(authority.authorizedPositions, [4, 5, 6]);
assert.deepEqual(authority.suffix.map(item => item.position), [4, 5, 6]);
assert.deepEqual(authority.suffix.map(item => `${item.replicate}:${item.variant}`),
  ['B:current', 'B:expanded', 'B:minimal']);
assert(authority.suffix.every(item => item.observationKind ===
  'original_stage1_untouched_suffix' && item.replacement === false && item.retry === false));
assert.deepEqual(authority.budget, { maximumObservations: 3,
  maximumPlannedProviderStageInvocations: 9, perObservation: 3 });
assert.equal(authority.policy.retry, 0);
assert.equal(authority.policy.repair, 0);
assert.equal(authority.policy.apply, 0);
const budget = createTaskBContinuationBudget(authority);
assert.throws(() => createTaskBContinuationBudget({ ...authority,
  authorizedPositions: [1, 2, 3, 4, 5, 6] }), /suffix budget authority/);
assert.throws(() => budget.reserveObservation(review.observations[0].observationId),
  /unauthorized or duplicate/);
for (const slot of authority.suffix) {
  budget.reserveObservation(slot.observationId);
  for (let n = 0; n < 3; n++) budget.recordInvocation(slot.observationId);
}
assert.deepEqual(budget.snapshot(), { observations: 3, providerStageInvocations: 9 });
assert.throws(() => budget.reserveObservation(authority.suffix[0].observationId),
  /unauthorized or duplicate/);
assert.throws(() => budget.recordInvocation(authority.suffix[0].observationId),
  /suffix provider-stage budget/);
assert.throws(() => authorizeTaskBContinuation('task-b-stage1-20260930-r7',
  { journalPath: authorityJournal, resultParent: authorityTemp }), /fresh explicit/);
assert.throws(() => authorizeTaskBContinuation('r8',
  { journalPath: authorityJournal, resultParent: authorityTemp }), /fresh explicit/);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-continuation-fixture-'));
try {
  const reviewPath = path.join(temporary, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ ...review, summaryHash: 'sha256:' + '0'.repeat(64) }));
  assert.throws(() => verifyR7RetainedPrefix({ reviewPath }), /retained prefix hash/);
  const journalPath = path.join(temporary, 'journal.sqlite');
  const original = new DatabaseSync(expectedJournalPath(), { readOnly: true });
  const fixture = new DatabaseSync(journalPath);
  fixture.exec('CREATE TABLE provider_invocations(run_id TEXT, stage TEXT, record_json TEXT, record_hash TEXT)');
  const insert = fixture.prepare('INSERT INTO provider_invocations VALUES(?,?,?,?)');
  for (const row of original.prepare("SELECT run_id, stage, record_json, record_hash FROM provider_invocations WHERE run_id LIKE 'matrix.task-b-stage1-20260930-r7.%'").all())
    insert.run(row.run_id, row.stage, row.record_json, row.record_hash);
  original.close();
  assert.deepEqual(verifyR7RetainedPrefix({ journalPath }), review);
  const coder = review.observations[2].journal[1];
  fixture.prepare('UPDATE provider_invocations SET record_json=? WHERE run_id=?')
    .run(JSON.stringify({ ...JSON.parse(fixture.prepare('SELECT record_json FROM provider_invocations WHERE run_id=?')
      .get(coder.runId).record_json), state: 'completed' }), coder.runId);
  assert.throws(() => verifyR7RetainedPrefix({ journalPath }), /journal binding/);
  fixture.prepare('DELETE FROM provider_invocations WHERE run_id=?').run(coder.runId);
  const source = new DatabaseSync(expectedJournalPath(), { readOnly: true });
  const originalCoder = source.prepare('SELECT run_id,stage,record_json,record_hash FROM provider_invocations WHERE run_id=?').get(coder.runId);
  insert.run(originalCoder.run_id, originalCoder.stage, originalCoder.record_json, originalCoder.record_hash);
  source.close();
  assert.deepEqual(verifyR7RetainedPrefix({ journalPath }), review);
  const consumed = { ...JSON.parse(originalCoder.record_json), plannedTaskB: {
    ...JSON.parse(originalCoder.record_json).plannedTaskB,
    sessionId, position: 4, replicate: 'B', variant: 'current' } };
  insert.run(`matrix.${sessionId}.task-b.4.b.current.coder.fixture`, 'coder',
    JSON.stringify(consumed), 'sha256:' + 'b'.repeat(64));
  assert.throws(() => authorizeTaskBContinuation(sessionId, { journalPath }),
    /continuation session journal reuse/);
  assert.throws(() => authorizeTaskBContinuation('task-b-stage1-other-offline', { journalPath }),
    /B suffix authority already consumed/);
  fixture.close();
  fs.mkdirSync(path.join(temporary, sessionId));
  assert.throws(() => authorizeTaskBContinuation(sessionId, { resultParent: temporary }),
    /continuation session reuse/);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
assert.equal(fs.existsSync(path.join(outputParent(), sessionId)), false);
fs.rmSync(authorityTemp, { recursive: true, force: true });
console.log('Task B r7 retained prefix and untouched suffix authority: PASS (provider/model calls 0)');
