#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coderPrompt } from '../../dist/apps/cli/src/providers/codex-bounded-provider.js';
import { createProspectiveMatrixAuthority, readProspectiveMatrixPlan,
  validateProspectiveMatrixAuthority, validateTaskBInspectionPlan,
  TASK_B_INSPECTION_MIRROR_PLAN_HASH } from
  '../../dist/packages/integrations/src/prospective-matrix-authority.js';
import { inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT, outputParent } from './live-runtime.mjs';
import { capturePlannerRequest, loadTaskBPlan, selectTaskBContext } from './task-b-live.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const planPath = path.join(HARNESS_ROOT,
  'research/context-token-matrix-v1/task-b-inspection-mirror-plan.json');
const originalPath = path.join(HARNESS_ROOT,
  'research/context-token-matrix-v1/task-b-inspection-plan.json');
const compositionPath = path.join(outputParent(), 'task-b-stage1-20260930-suffix-r1',
  'stage1-composition.json');
const journalPath = expectedJournalPath();
const journalBefore = sha(fs.readFileSync(journalPath));
const compositionBefore = sha(fs.readFileSync(compositionPath));
const { plan, planHash, experimentKind, contextExpansion } = readProspectiveMatrixPlan(
  HARNESS_ROOT, planPath, compositionPath);
const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
assert.equal(planHash, TASK_B_INSPECTION_MIRROR_PLAN_HASH);
assert.equal(planHash, sha(fs.readFileSync(planPath)));
assert.equal(experimentKind, 'inspection-instruction-validation');
assert.equal(contextExpansion, 'none');
assert.deepEqual(validateTaskBInspectionPlan(plan, HARNESS_ROOT, true), plan);
assert.deepEqual(plan.orderedSlots.map(s => [s.position, s.replicate, s.variant, s.condition]), [
  [1, 'B', 'current', 'inspection-instruction'],
  [2, 'A', 'current', 'control'],
  [3, 'A', 'current', 'control'],
  [4, 'B', 'current', 'inspection-instruction']]);
assert.deepEqual(plan.conditionDefinitions, original.conditionDefinitions);
assert.equal(plan.conditionDefinitions.control.coderPrefixHash,
  'sha256:4603fac5b703f785b570f75b9e06804f68c5e354fdb2ef6876533024fe7888e2');
assert.equal(plan.conditionDefinitions['inspection-instruction'].coderPrefixHash,
  'sha256:b71156c3b1667aec4ee44fbec6ba6da83d69a4c25d860bc5a0ad17bc5cd617a7');
assert.deepEqual(plan.limits, { maxObservations: 4, maxProviderStages: 8,
  maxProviderStagesPerObservation: 2 });
assert.deepEqual(plan.policy, { retry: 0, repair: 0, apply: 0 });
for (const changed of [
  { ...plan, orderedSlots: [...plan.orderedSlots].reverse() },
  { ...plan, limits: { ...plan.limits, maxProviderStages: 9 } },
  { ...plan, conditionDefinitions: { ...plan.conditionDefinitions,
    'inspection-instruction': { ...plan.conditionDefinitions['inspection-instruction'],
      instruction: 'altered' } } }
]) assert.throws(() => validateTaskBInspectionPlan(changed, HARNESS_ROOT, true));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-inspection-mirror-offline-'));
const sessionId = 'task-b-inspection-mirror-offline';
try {
  const source = createSourceCheckout(path.join(temporary, 'source-parent'));
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
  const control = coderPrompt(context, files, 'control');
  const treatment = coderPrompt(context, files, 'inspection-instruction');
  const prefix = task => task.slice(0, task.lastIndexOf('\n{'));
  assert.equal(sha(prefix(control)), plan.conditionDefinitions.control.coderPrefixHash);
  assert.equal(sha(prefix(treatment)),
    plan.conditionDefinitions['inspection-instruction'].coderPrefixHash);
  assert.equal(treatment, control.replace('Bounded coder context follows:',
    `${plan.conditionDefinitions['inspection-instruction'].instruction}\nBounded coder context follows:`));
  const plannerTask = (await capturePlannerRequest(taskPlan, 'current',
    path.join(temporary, 'planner-capture'))).task;
  assert.equal(sha(plannerTask),
    'sha256:3788096e8d83dfd915af9b98faa7fcbca511e675193f1e5f7404d74e259f65de');
  const pairs = plan.orderedSlots.map(slot => ({
    planner: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
      sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
      sessionId, slot, providerStage: 'planner' }),
    coder: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
      sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
      sessionId, slot, providerStage: 'coder' }) }));
  const request = (authority, task) => ({ harnessRoot: HARNESS_ROOT,
    sourceRepositoryPath: source, planPath, priorCompositionPath: compositionPath,
    runId: `matrix.${authority.runtimeIdentity}.${authority.providerStage}.fixture`,
    stage: authority.providerStage, model: plan.model, reasoning: plan.reasoning, task });
  for (const [index, pair] of pairs.entries()) {
    const coderTask = plan.orderedSlots[index].condition === 'control' ? control : treatment;
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.planner,
      request(pair.planner, plannerTask)));
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair.coder, coderTask)));
    assert.throws(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair.coder, coderTask === control ? treatment : control)));
    assert.equal(pair.coder.contextExpansion, 'none');
    assert.equal(pair.coder.coderPrefixHash,
      plan.conditionDefinitions[plan.orderedSlots[index].condition].coderPrefixHash);
  }
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    pairs.map(pair => pair.planner)).map(item => item.authorized), [true, true, true, true]);
  assert.equal(sha(fs.readFileSync(journalPath)), journalBefore);
  assert.equal(sha(fs.readFileSync(compositionPath)), compositionBefore);
  assert.equal(fs.existsSync(path.join(outputParent(), sessionId)), false);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.log('mirrored inspection offline tests PASS; provider/model calls 0; live sessions 0; real journal mutations 0');
