#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coderPrompt } from '../../dist/apps/cli/src/providers/codex-bounded-provider.js';
import { createProspectiveMatrixAuthority, readProspectiveMatrixPlan,
  validateProspectiveMatrixAuthority, validateTaskBNavigationPlan,
  TASK_B_NAVIGATION_PLAN_HASH } from
  '../../dist/packages/integrations/src/prospective-matrix-authority.js';
import { deriveTaskBNavigationCue, TASK_B_NAVIGATION_BLOCK,
  TASK_B_NAVIGATION_HASH } from '../../dist/packages/integrations/src/task-b-navigation-cue.js';
import { inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT, outputParent } from './live-runtime.mjs';
import { capturePlannerRequest, loadTaskBPlan, persistTaskBCellArtifacts,
  selectTaskBContext } from './task-b-live.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const planPath = path.join(HARNESS_ROOT,
  'research/context-token-matrix-v1/task-b-navigation-plan.json');
const compositionPath = path.join(outputParent(), 'task-b-stage1-20260930-suffix-r1',
  'stage1-composition.json');
const realJournal = expectedJournalPath();
const journalBefore = sha(fs.readFileSync(realJournal));
const compositionBefore = sha(fs.readFileSync(compositionPath));
const { plan, planHash, experimentKind, contextExpansion } = readProspectiveMatrixPlan(
  HARNESS_ROOT, planPath, compositionPath);
assert.equal(planHash, TASK_B_NAVIGATION_PLAN_HASH);
assert.equal(planHash, sha(fs.readFileSync(planPath)));
assert.equal(experimentKind, 'navigation-cue-validation');
assert.equal(contextExpansion, 'none');
assert.deepEqual(validateTaskBNavigationPlan(plan, HARNESS_ROOT), plan);
assert.deepEqual(plan.orderedSlots.map(s => [s.replicate, s.variant, s.condition]), [
  ['A', 'current', 'control'], ['B', 'current', 'navigation-cue'],
  ['B', 'current', 'navigation-cue'], ['A', 'current', 'control']]);
assert.deepEqual(plan.limits, { maxObservations: 4, maxProviderStages: 8,
  maxProviderStagesPerObservation: 2 });
assert.deepEqual(plan.policy, { retry: 0, repair: 0, apply: 0 });
for (const changed of [
  { ...plan, orderedSlots: [...plan.orderedSlots].reverse() },
  { ...plan, limits: { ...plan.limits, maxProviderStages: 9 } },
  { ...plan, navigationCue: { ...plan.navigationCue, cueHash: 'sha256:' + 'f'.repeat(64) } },
  { ...plan, navigationCue: { ...plan.navigationCue, placement: 'elsewhere' } }
]) assert.throws(() => validateTaskBNavigationPlan(changed, HARNESS_ROOT));
assert.equal(Buffer.byteLength(TASK_B_NAVIGATION_BLOCK), 174);
assert.equal(sha(TASK_B_NAVIGATION_BLOCK), TASK_B_NAVIGATION_HASH);
assert.equal(plan.navigationCue.cueEstimatedTokens, 44);
assert.equal(TASK_B_NAVIGATION_BLOCK.includes('function '), false);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-navigation-offline-'));
const sessionId = 'task-b-navigation-offline-fixture';
try {
  const taskPlan = loadTaskBPlan();
  const selections = [];
  const cues = [];
  const pairs = [];
  let plannerTask = null;
  const journalPath = path.join(temp, 'journal.sqlite');
  fs.copyFileSync(realJournal, journalPath);
  for (const slot of plan.orderedSlots) {
    const sourceParent = path.join(temp, `source-${slot.position}`);
    const source = createSourceCheckout(sourceParent);
    const { selected } = await selectTaskBContext(taskPlan, 'current', source);
    const hashes = selected.initialEvidence.map(x =>
      ({ path: x.path, sha256: x.contentHash, bytes: x.byteLength }));
    selections.push({ files: selected.selectedFiles, bytes: selected.selectedBytes,
      hashes, analyzerHash: selected.intelligenceHash });
    // Derivation succeeds after source removal: it only projects the prior analyzer object.
    const intelligence = selected.intelligence;
    fs.rmSync(sourceParent, { recursive: true, force: true });
    const cue = deriveTaskBNavigationCue(intelligence, hashes);
    cues.push(cue);
    assert.equal(cue.block, TASK_B_NAVIGATION_BLOCK);
    assert.equal(cue.cueHash, plan.navigationCue.cueHash);
    assert.equal(cue.analyzerHash, plan.navigationCue.analyzerHash);
    const facts = intelligence.scannedFiles.map(f => ({ ...f,
      symbols: f.path === 'packages/integrations/src/codex-event-parser.ts'
        ? [...f.symbols].reverse() : f.symbols }));
    assert.throws(() => deriveTaskBNavigationCue({ ...intelligence,
      scannedFiles: facts }, hashes));
    const altered = intelligence.scannedFiles.map(f => ({ ...f,
      symbols: f.path === 'scripts/smoke/codex-event-parser-smoke.cjs'
        ? f.symbols.map(x => x.name === 'main' ? { ...x, name: 'changed' } : x) : f.symbols }));
    assert.throws(() => deriveTaskBNavigationCue({ ...intelligence,
      scannedFiles: altered }, hashes));
    // Authority uses a disposable pinned checkout; it does not invoke a provider.
    const authoritySource = createSourceCheckout(path.join(temp, `authority-${slot.position}`));
    pairs.push({ source: authoritySource,
      planner: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
        sourceRepositoryPath: authoritySource, planPath, priorCompositionPath: compositionPath,
        sessionId, slot, providerStage: 'planner' }),
      coder: createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
        sourceRepositoryPath: authoritySource, planPath, priorCompositionPath: compositionPath,
        sessionId, slot, providerStage: 'coder' }) });
  }
  assert.ok(selections.every(x => JSON.stringify(x) === JSON.stringify(selections[0])));
  assert.equal(selections[0].bytes, 24668);
  assert.equal(selections[0].analyzerHash, plan.navigationCue.analyzerHash);
  assert.ok(cues.every(x => x.cueHash === cues[0].cueHash));
  const files = taskPlan.task.allowedFiles;
  const context = { baseContext: { taskContext: { taskContext: { taskContext:
    { objective: taskPlan.task.providerPrompt } } } } };
  const control = coderPrompt(context, files, 'control');
  const treatment = coderPrompt(context, files, 'navigation-cue', cues[0].block);
  assert.equal(treatment, control.replace('Bounded coder context follows:',
    `${TASK_B_NAVIGATION_BLOCK}\nBounded coder context follows:`));
  assert.equal(treatment.split(TASK_B_NAVIGATION_BLOCK).length, 2);
  assert.equal(control.includes(TASK_B_NAVIGATION_BLOCK), false);
  assert.throws(() => coderPrompt(context, files, 'navigation-cue',
    TASK_B_NAVIGATION_BLOCK.replace('parseCodexJsonl', 'wrong')));
  assert.throws(() => coderPrompt(context, files, 'control', TASK_B_NAVIGATION_BLOCK));
  const prefix = task => task.slice(0, task.lastIndexOf('\n{'));
  assert.equal(sha(prefix(control)), plan.navigationCue.controlPrefixHash);
  assert.equal(sha(prefix(treatment)), plan.navigationCue.navigationPrefixHash);
  plannerTask = (await capturePlannerRequest(taskPlan, 'current',
    path.join(temp, 'planner-capture'))).task;
  assert.equal(sha(plannerTask),
    'sha256:3788096e8d83dfd915af9b98faa7fcbca511e675193f1e5f7404d74e259f65de');
  const request = (pair, stage, task) => ({ harnessRoot: HARNESS_ROOT,
    sourceRepositoryPath: pair.source, planPath, priorCompositionPath: compositionPath,
    runId: `matrix.${pair[stage].runtimeIdentity}.${stage}.fixture`, stage,
    model: plan.model, reasoning: plan.reasoning, task });
  for (const [index, pair] of pairs.entries()) {
    const coderTask = plan.orderedSlots[index].condition === 'control' ? control : treatment;
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.planner,
      request(pair, 'planner', plannerTask)));
    assert.doesNotThrow(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair, 'coder', coderTask)));
    assert.throws(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair, 'coder', coderTask === control ? treatment : control)));
    assert.throws(() => validateProspectiveMatrixAuthority(pair.coder,
      request(pair, 'coder', coderTask.replace('Bounded coder context follows:',
        'Changed placement:\nBounded coder context follows:'))));
    assert.equal(pair.coder.contextExpansion, 'none');
    assert.equal(pair.coder.navigationCueHash, TASK_B_NAVIGATION_HASH);
  }
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, pairs[0].source,
    pairs.map(pair => pair.planner)).map(x => x.authorized), [true, true, true, true]);
  const cell = path.join(temp, 'artifact-check'); fs.mkdirSync(cell);
  persistTaskBCellArtifacts(cell, { matrixAuthorities: pairs[0] }, {
    sourceStatus: {}, calls: [], rawProduct: { secret: true }, rawBounded: { secret: true },
    selection: {}, behavior: {}, contextExpansion: {}, normalized: {}, trajectory: null,
    summary: {} });
  assert.equal(fs.existsSync(path.join(cell, 'raw-product-result.json')), false);
  assert.equal(fs.existsSync(path.join(cell, 'raw-bounded-result.json')), false);
  assert.equal(sha(fs.readFileSync(realJournal)), journalBefore);
  assert.equal(sha(fs.readFileSync(compositionPath)), compositionBefore);
  assert.equal(fs.existsSync(path.join(outputParent(), sessionId)), false);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('navigation cue offline PASS; provider/model calls 0; live sessions 0; real journal mutations 0');
