#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTask, loadTaskBPlan, validateTaskBPlan, stage1Slots,
  createTaskBBudget, assertFreshTaskBSession, classifyTaskBObservation } from './task-b-live.mjs';
import { annotateCoderTrajectory } from './live-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const plan = loadTaskBPlan();
const copy = value => structuredClone(value);
const invalid = (mutate, pattern) => {
  const [p, d, c] = [copy(plan.proposal), copy(plan.definition), copy(plan.calibration)];
  mutate(p, d, c);
  assert.throws(() => validateTaskBPlan(p, d, c), pattern);
};
assert.equal(selectTask('B'), 'B');
assert.equal(selectTask('A'), 'A');
assert.throws(() => selectTask(undefined), /explicit task selection/);
assert.throws(() => selectTask('unknown'), /explicit task selection/);
invalid(p => { p.taskBHash = 'sha256:' + '0'.repeat(64); }, /Task B hash/);
invalid((p, d) => { d.sourceTask.sourceHead = '0'.repeat(40); }, /Task B hash|source SHA/);
invalid((p, d) => { d.sourceTask.oracle = 'other'; }, /Task B hash|behavioral oracle/);
invalid(p => { p.stage1Order.reverse(); }, /execution order/);
invalid(p => { p.controlledExecution.retry = 1; }, /retry\/repair\/apply/);
invalid(p => { p.model = 'other'; }, /model\/reasoning/);
invalid((p, d, c) => { c.variants.minimal.selectedBytes++; }, /minimal context/);
invalid((p, d, c) => { c.variants.expanded.selectedFiles.push('other'); }, /expanded context/);
assert.deepEqual(plan.calibration.variants.minimal.selectedFiles,
  ['packages/integrations/src/codex-event-parser.ts', 'scripts/smoke/codex-event-parser-smoke.cjs']);
assert.deepEqual(plan.calibration.variants.current.selectedFiles,
  plan.calibration.variants.minimal.selectedFiles);
assert.deepEqual(plan.calibration.variants.expanded.selectedFiles.slice(2),
  ['packages/integrations/src/agent-adapter.ts', 'packages/integrations/src/agent-telemetry.ts']);
assert.deepEqual([plan.calibration.variants.minimal.selectedBytes,
  plan.calibration.variants.current.selectedBytes, plan.calibration.variants.expanded.selectedBytes],
  [24668, 24668, 33962]);
assert.deepEqual([plan.calibration.variants.minimal.estimatedInitialTokens,
  plan.calibration.variants.current.estimatedInitialTokens,
  plan.calibration.variants.expanded.estimatedInitialTokens], [6944, 6944, 9435]);
const sessionId = 'task-b-stage1-offline-fixture';
const slots = stage1Slots(plan, sessionId);
assert.deepEqual(slots.map(item => `${item.replicate}:${item.variant}`),
  ['A:minimal', 'A:current', 'A:expanded', 'B:current', 'B:expanded', 'B:minimal']);
assert.equal(new Set(slots.map(item => item.observationId)).size, 6);
assert.throws(() => stage1Slots(plan, 'stage1-historical'), /fresh explicit/);
assert.throws(() => stage1Slots(plan, 'r10'), /fresh explicit/);
const budget = createTaskBBudget();
for (const slot of slots) {
  budget.reserveObservation(slot.observationId);
  for (let n = 0; n < 3; n++) budget.recordInvocation(slot.observationId);
}
assert.deepEqual(budget.snapshot(), { observations: 6, providerStageInvocations: 18 });
assert.throws(() => budget.reserveObservation(slots[0].observationId), /duplicate or extra/);
assert.throws(() => budget.reserveObservation('extra'), /duplicate or extra/);
assert.throws(() => budget.recordInvocation(slots[0].observationId), /provider budget ceiling/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-session-fixture-'));
try {
  const dbPath = path.join(root, 'journal.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE provider_invocations(run_id TEXT NOT NULL)');
  assert.doesNotThrow(() => assertFreshTaskBSession(slots, root, dbPath));
  db.prepare('INSERT INTO provider_invocations(run_id) VALUES (?)').run(`matrix.${slots[2].observationId}.coder`);
  assert.throws(() => assertFreshTaskBSession(slots, root, dbPath), /identity consumed/);
  db.exec('DELETE FROM provider_invocations');
  fs.mkdirSync(path.join(root, sessionId));
  assert.throws(() => assertFreshTaskBSession(slots, root, dbPath), /historical session reuse/);
  db.close();
} finally { fs.rmSync(root, { recursive: true, force: true }); }
const trajectory = { schemaVersion: 'codex-coder-trajectory/v1', turns: [
  { turnIndex: 1, provenance: { tokens: 'observed' } }], tools: [] };
const original = copy(trajectory);
const annotated = annotateCoderTrajectory(trajectory,
  { usage: { coder: { initialPromptEstimatedTokens: 6944 } } },
  { selectedFileCount: 2, selectedBytes: 24668 });
assert.deepEqual(trajectory, original);
assert.equal(annotated.turns[0].promptEstimatedTokensBeforeTurn, 6944);
assert.equal(annotated.selectedContextSemantics, 'initial-selection-only');
const safeProduct = { sourceRepositoryUnchanged: true, apply: 'NOT_RUN',
  decision: 'bounded_task_completed' };
assert.equal(classifyTaskBObservation(safeProduct,
  { decision: 'bounded_task_completed' }, { status: 'PASS' }), 'completed');
assert.equal(classifyTaskBObservation(safeProduct,
  { decision: 'bounded_task_completed' }, { status: 'FAIL' }), 'candidate_validation_failure');
assert.equal(classifyTaskBObservation({ ...safeProduct, decision: 'bounded_task_stopped',
  failure: { stage: 'validation' } }, { verifierResult: { decision: 'approve' } },
{ status: 'FAIL' }), 'candidate_validation_failure');
assert.equal(classifyTaskBObservation(safeProduct, {}, { status: 'INFRASTRUCTURE_STOP' }),
  'infrastructure_failure');
assert.equal(classifyTaskBObservation(safeProduct, {}, { status: 'CANDIDATE_INVALID' }),
  'candidate_model_failure');
assert.equal(classifyTaskBObservation({ ...safeProduct, decision: 'bounded_task_stopped',
  failure: { stage: 'coding', code: 'coder_provider_failed' } }, {},
{ status: 'NOT_RUN' }), 'ambiguous_failure');
const cli = path.join(here, 'run-live.mjs');
for (const args of [['preflight', '--task', 'unknown', '--session-id', sessionId],
  ['preflight', '--task', 'B', '--session-id', 'r10']]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout.trim()).providerModelCalls, 0);
}
const taskA = fs.readFileSync(path.join(here, 'experiment-manifest.json'));
const committedA = spawnSync('git', ['show', 'HEAD:research/context-token-matrix-v1/experiment-manifest.json'],
  { cwd: path.resolve(here, '../..') });
assert.equal(committedA.status, 0);
assert.deepEqual(taskA, committedA.stdout);
console.log('Task B explicit selection, frozen authority, sessions, budget, trajectory, Task A unchanged: PASS (provider/model calls 0)');
