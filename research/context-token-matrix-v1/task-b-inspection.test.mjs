#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coderPrompt } from '../../dist/apps/cli/src/providers/codex-bounded-provider.js';
import { createProspectiveMatrixAuthority, readProspectiveMatrixPlan,
  validateProspectiveMatrixAuthority, validateTaskBInspectionPlan,
  TASK_B_INSPECTION_PLAN_HASH } from
  '../../dist/packages/integrations/src/prospective-matrix-authority.js';
import { inspectProspectiveMatrixJournal, createDurableInvocationJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT, outputParent } from './live-runtime.mjs';
import { capturePlannerRequest, classifyTaskBStage2Timeout, loadTaskBPlan,
  selectTaskBContext, taskBMayContinue } from './task-b-live.mjs';
import { executeOrderedMatrix } from './matrix-executor.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const planPath = path.join(HARNESS_ROOT,
  'research/context-token-matrix-v1/task-b-inspection-plan.json');
const compositionPath = path.join(outputParent(), 'task-b-stage1-20260930-suffix-r1',
  'stage1-composition.json');
const planBytes = fs.readFileSync(planPath);
const { plan, planHash, experimentKind, contextExpansion } = readProspectiveMatrixPlan(
  HARNESS_ROOT, planPath, compositionPath);
assert.equal(planHash, TASK_B_INSPECTION_PLAN_HASH);
assert.equal(planHash, sha(planBytes));
assert.equal(experimentKind, 'inspection-instruction-validation');
assert.equal(contextExpansion, 'none');
assert.deepEqual(validateTaskBInspectionPlan(plan, HARNESS_ROOT), plan);
assert.deepEqual(plan.orderedSlots.map(s => [s.replicate, s.variant, s.condition]), [
  ['A', 'current', 'control'], ['B', 'current', 'inspection-instruction'],
  ['B', 'current', 'inspection-instruction'], ['A', 'current', 'control']]);
assert.deepEqual(plan.limits, { maxObservations: 4, maxProviderStages: 8,
  maxProviderStagesPerObservation: 2 });
assert.deepEqual(plan.policy, { retry: 0, repair: 0, apply: 0 });
for (const changed of [
  { ...plan, orderedSlots: [...plan.orderedSlots].reverse() },
  { ...plan, limits: { ...plan.limits, maxProviderStages: 9 } },
  { ...plan, conditionDefinitions: { ...plan.conditionDefinitions,
    'inspection-instruction': { ...plan.conditionDefinitions['inspection-instruction'],
      instruction: 'altered' } } },
  { ...plan, conditionDefinitions: { ...plan.conditionDefinitions,
    control: { ...plan.conditionDefinitions.control, coderPrefixHash: 'sha256:' + 'f'.repeat(64) } } }
]) assert.throws(() => validateTaskBInspectionPlan(changed, HARNESS_ROOT));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-inspection-offline-'));
const realJournalBefore = sha(fs.readFileSync(expectedJournalPath()));
const compositionBefore = sha(fs.readFileSync(compositionPath));
try {
  const source = createSourceCheckout(path.join(temp, 'source-parent'));
  const taskPlan = loadTaskBPlan();
  const selections = [];
  for (const slot of plan.orderedSlots) {
    const { selected } = await selectTaskBContext(taskPlan, slot.variant, source);
    selections.push({ files: selected.selectedFiles, bytes: selected.selectedBytes,
      hashes: selected.initialEvidence.map(e => [e.path, e.contentHash]) });
  }
  assert.ok(selections.every(item => JSON.stringify(item) === JSON.stringify(selections[0])));
  assert.equal(selections[0].bytes, 24668);
  const files = taskPlan.task.allowedFiles;
  const context = { baseContext: { taskContext: { taskContext: { taskContext:
    { objective: taskPlan.task.providerPrompt } } } } };
  const baseline = [
    'You are the bounded Codex coder inside an isolated disposable Git workspace.',
    'Edit files in the working directory directly. Do not return a patch or WorkspaceMutation JSON.',
    'Only modify existing regular UTF-8 files. Never add, delete, rename, copy, chmod, or create symlinks.',
    `Only these paths may be modified: ${JSON.stringify(files)}.`,
    'Do not configure remotes or object alternates. Do not access the source repository.',
    'The runtime will deterministically capture git diff and derive expectedContentHash from its pre-agent manifest.',
    'Bounded coder context follows:', JSON.stringify(context)
  ].join('\n');
  const control = coderPrompt(context, files, 'control');
  const treatment = coderPrompt(context, files, 'inspection-instruction');
  assert.equal(control, baseline);
  assert.equal(coderPrompt(context, files), baseline);
  assert.equal(treatment, baseline.replace('Bounded coder context follows:',
    `${plan.conditionDefinitions['inspection-instruction'].instruction}\nBounded coder context follows:`));
  assert.throws(() => coderPrompt(context, files, 'unapproved'));
  const prefix = task => task.slice(0, task.lastIndexOf('\n{'));
  assert.equal(sha(prefix(control)), plan.conditionDefinitions.control.coderPrefixHash);
  assert.equal(sha(prefix(treatment)),
    plan.conditionDefinitions['inspection-instruction'].coderPrefixHash);
  const plannerTask = (await capturePlannerRequest(taskPlan, 'current',
    path.join(temp, 'planner-capture'))).task;
  assert.equal(sha(plannerTask),
    'sha256:3788096e8d83dfd915af9b98faa7fcbca511e675193f1e5f7404d74e259f65de');

  const sessionId = 'task-b-inspection-offline-fixture';
  const authorities = plan.orderedSlots.map(slot => ({
    planner: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
      sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
      sessionId, slot, providerStage: 'planner' }),
    coder: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
      sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
      sessionId, slot, providerStage: 'coder' }) }));
  const request = (authority, task) => ({ harnessRoot: HARNESS_ROOT,
    sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
    runId: `matrix.${authority.runtimeIdentity}.${authority.providerStage}.fixture`,
    stage: authority.providerStage, model: 'gpt-5.6-luna', reasoning: 'medium', task });
  for (const [index, pair] of authorities.entries()) {
    const coderTask = plan.orderedSlots[index].condition === 'control' ? control : treatment;
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.planner,
      request(pair.planner, plannerTask)));
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair.coder, coderTask)));
    assert.throws(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair.coder, coderTask === control ? treatment : control)));
    assert.equal(pair.coder.coderPrefixHash,
      plan.conditionDefinitions[plan.orderedSlots[index].condition].coderPrefixHash);
  }
  assert.throws(() => validateProspectiveMatrixAuthority(authorities[1].coder,
    request(authorities[1].coder, treatment.replace('When practical,', 'Always,'))));
  const journalPath = path.join(temp, 'isolated-journal.sqlite');
  fs.copyFileSync(expectedJournalPath(), journalPath);
  const db = new DatabaseSync(journalPath);
  for (const row of db.prepare('SELECT run_id, record_json FROM provider_invocations').all())
    if (JSON.parse(row.record_json).plannedMatrix)
      db.prepare('DELETE FROM provider_invocations WHERE run_id=?').run(row.run_id);
  db.close();
  const journalBefore = sha(fs.readFileSync(journalPath));
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    authorities.map(pair => pair.planner)).map(item => item.authorized), [true, true, true, true]);
  assert.equal(sha(fs.readFileSync(journalPath)), journalBefore);
  const journal = createDurableInvocationJournal(journalPath);
  const authority = authorities[0].planner;
  const plannedRequest = { runId: request(authority, plannerTask).runId,
    stage: 'planner', task: plannerTask, model: 'gpt-5.6-luna',
    reasoningEffort: 'medium', deadlineAt: Date.now() + 60000,
    sourceRepositoryPath: source, plannedMatrix: authority };
  journal.reserve(plannedRequest);
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    [authority]).map(item => item.authorized), [false]);
  assert.throws(() => journal.reserve(plannedRequest));
  const slots = plan.orderedSlots.map((slot, index) => ({ ...slot, sessionId,
    observationId: authorities[index].planner.observationId }));
  const result = await executeOrderedMatrix({ plan, planHash, sessionId, slots,
    sessionRoot: path.join(temp, 'matrix-session'),
    executeObservation: async (slot, budget) => {
      budget.recordInvocation(slot.observationId);
      budget.recordInvocation(slot.observationId);
      return { ...slot, classification: 'completed' };
    }, mayContinue: taskBMayContinue });
  assert.equal(result.observations.length, 4);
  assert.equal(result.providerModelCalls, 8); // Offline counter exercise; no provider was called.
  assert.deepEqual(result.observations.map(item => item.condition),
    ['control', 'inspection-instruction', 'inspection-instruction', 'control']);
  assert.equal(classifyTaskBStage2Timeout('ambiguous_failure', 'agent_timeout', false, 'NOT_RUN'),
    'production_product_timeout');
  assert.equal(taskBMayContinue('production_product_timeout'), false);
  assert.equal(sha(fs.readFileSync(expectedJournalPath())), realJournalBefore);
  assert.equal(sha(fs.readFileSync(compositionPath)), compositionBefore);
  assert.equal(fs.existsSync(path.join(outputParent(), sessionId)), false);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('inspection prompt offline tests PASS; provider/model calls 0; live sessions 0; real journal mutations 0');
