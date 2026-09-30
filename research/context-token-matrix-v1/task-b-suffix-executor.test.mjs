#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectedJournalPath, outputParent } from './live-runtime.mjs';
import { loadTaskBPlan, preflightTaskBJournalAuthority } from './task-b-live.mjs';
import { authorizeTaskBContinuation, createTaskBContinuationBudget,
  verifyR7RetainedPrefix } from './task-b-continuation-authority.mjs';
import { assertTaskBSuffixOrder, composeTaskBStage1,
  executeAuthorizedTaskBSuffix } from './task-b-suffix-executor.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sessionId = 'task-b-stage1-suffix-offline-fixture';
const prefix = verifyR7RetainedPrefix();
const authority = authorizeTaskBContinuation(sessionId);
const slots = assertTaskBSuffixOrder(authority, authority.suffix);
assert.deepEqual(slots.map(item => item.position), [4, 5, 6]);
assert.deepEqual(slots.map(item => `${item.replicate}:${item.variant}`),
  ['B:current', 'B:expanded', 'B:minimal']);
for (const index of [0, 1, 2]) {
  const copy = structuredClone(slots);
  copy[index].replicate = 'A';
  assert.throws(() => assertTaskBSuffixOrder(authority, copy), /order or identity/);
}
assert.throws(() => assertTaskBSuffixOrder(authority,
  [slots[1], slots[0], slots[2]]), /order or identity/);
const seen = [];
const completed = await executeAuthorizedTaskBSuffix({ authority, slots,
  budget: createTaskBContinuationBudget(authority),
  execute: async (slot, budget) => {
    seen.push(slot.position);
    for (let n = 0; n < 3; n++) budget.recordInvocation(slot.observationId);
    return { ...slot, classification: 'completed', providerStageInvocations: 3 };
  } });
assert.deepEqual(seen, [4, 5, 6]);
assert.equal(completed.stop, null);
assert.deepEqual(completed.budget, { observations: 3, providerStageInvocations: 9 });
assert.deepEqual(completed.observations.map(item => item.position), [4, 5, 6]);
const candidateSeen = [];
const candidate = await executeAuthorizedTaskBSuffix({ authority, slots,
  budget: createTaskBContinuationBudget(authority),
  execute: async slot => { candidateSeen.push(slot.position);
    return { ...slot, classification: slot.position === 4 ?
      'candidate_model_failure' : 'completed' }; } });
assert.deepEqual(candidateSeen, [4, 5, 6]);
assert.equal(candidate.stop, null);
const stoppedSeen = [];
const stopped = await executeAuthorizedTaskBSuffix({ authority, slots,
  budget: createTaskBContinuationBudget(authority),
  execute: async slot => { stoppedSeen.push(slot.position);
    return { ...slot, classification: slot.position === 4 ?
      'infrastructure_failure' : 'completed' }; } });
assert.deepEqual(stoppedSeen, [4]);
assert.equal(stopped.stop, 'infrastructure_failure');
const thrownSeen = [];
const thrown = await executeAuthorizedTaskBSuffix({ authority, slots,
  budget: createTaskBContinuationBudget(authority),
  execute: async slot => { thrownSeen.push(slot.position); throw Error('offline infrastructure'); } });
assert.deepEqual(thrownSeen, [4]);
assert.match(thrown.stop, /infrastructure_or_ambiguous/);
assert.throws(() => authorizeTaskBContinuation('task-b-stage1-20260930-r7'), /fresh explicit/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-suffix-composition-'));
try {
  const journalProbe = await preflightTaskBJournalAuthority(loadTaskBPlan(), slots,
    expectedJournalPath(), temp, 3);
  assert.deepEqual(journalProbe.inspected.map(item => item.status),
    Array(3).fill('reviewed_replacement_required'));
  assert.deepEqual(journalProbe.slots.map(item => item.position), [4, 5, 6]);
  const journalPath = path.join(temp, 'journal.sqlite');
  const source = new DatabaseSync(expectedJournalPath(), { readOnly: true });
  const db = new DatabaseSync(journalPath);
  db.exec('CREATE TABLE provider_invocations(run_id TEXT,stage TEXT,record_json TEXT,record_hash TEXT)');
  const insert = db.prepare('INSERT INTO provider_invocations VALUES(?,?,?,?)');
  for (const row of source.prepare("SELECT run_id,stage,record_json,record_hash FROM provider_invocations WHERE run_id LIKE 'matrix.task-b-stage1-20260930-r7.%'").all())
    insert.run(row.run_id, row.stage, row.record_json, row.record_hash);
  source.close();
  const sessionRoot = path.join(temp, sessionId);
  fs.mkdirSync(sessionRoot);
  const observations = [];
  for (const slot of slots) {
    const cellRoot = path.join(sessionRoot,
      `${String(slot.position).padStart(2, '0')}-B-${slot.variant}`);
    fs.mkdirSync(cellRoot);
    const calls = ['planner', 'coder'].map(mode => ({ mode,
      runId: `matrix.${slot.runtimeIdentity}.${mode}.fixture` }));
    for (const call of calls) {
      const record = JSON.stringify({ state: 'completed', plannedTaskB: {
        sessionId, observationId: slot.observationId, position: slot.position } });
      insert.run(call.runId, call.mode, record, sha(Buffer.from(record)));
    }
    fs.writeFileSync(path.join(sessionRoot, `reservation-${slot.position}.json`),
      JSON.stringify(slot));
    fs.writeFileSync(path.join(cellRoot, 'cell-summary.json'),
      JSON.stringify({ ...slot, classification: 'completed', providerStageInvocations: 2 }));
    fs.writeFileSync(path.join(cellRoot, 'experiment-result.json'),
      JSON.stringify({ runId: slot.observationId,
        outcome: { decision: 'bounded_task_completed', behavior: 'PASS' } }));
    fs.writeFileSync(path.join(cellRoot, 'behavior-check.json'),
      JSON.stringify({ status: 'PASS', infrastructurePass: true, moduleLoaded: true,
        assertionsCompleted: true }));
    fs.writeFileSync(path.join(cellRoot, 'adapter-calls.json'), JSON.stringify(calls));
    observations.push({ ...slot, classification: 'completed' });
  }
  fs.writeFileSync(path.join(sessionRoot, 'suffix-summary.json'), JSON.stringify({
    sessionId, observations, stop: null, budget: { observations: 3,
      providerStageInvocations: 6 } }));
  const composition = composeTaskBStage1({ authority, sessionRoot,
    journalPath, resultParent: outputParent() });
  assert.deepEqual(composition.rows.map(row => row.position), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(composition.rows.map(row => row.sessionId),
    Array(3).fill('task-b-stage1-20260930-r7').concat(Array(3).fill(sessionId)));
  assert.equal(composition.rows[2].classification, 'production_product_timeout');
  assert.equal(composition.rows[2].artifactHashes['cell-summary.json'],
    prefix.observations[2].artifactHashes['cell-summary.json']);
  assert.equal(composition.rows[2].journal[1].state, 'outcome_unknown');
  assert.equal(composition.rows[4].journal[0].runId,
    `matrix.${slots[1].runtimeIdentity}.planner.fixture`);
  db.prepare('UPDATE provider_invocations SET record_hash=? WHERE run_id=?')
    .run('sha256:' + '0'.repeat(64), `matrix.${slots[1].runtimeIdentity}.planner.fixture`);
  assert.throws(() => composeTaskBStage1({ authority, sessionRoot,
    journalPath, resultParent: outputParent() }), /journal hash/);
  db.close();
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
assert.equal(fs.existsSync(path.join(outputParent(), sessionId)), false);
console.log('Task B suffix executor and additive composition: PASS (provider/model calls 0)');
