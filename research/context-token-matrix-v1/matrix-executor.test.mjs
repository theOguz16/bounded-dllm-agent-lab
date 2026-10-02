import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeOrderedMatrix } from './matrix-executor.mjs';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT, outputParent } from './live-runtime.mjs';
import { capturePlannerRequest, classifyTaskBStage2Timeout, loadTaskBPlan,
  taskBMayContinue } from './task-b-live.mjs';
import { createDurableInvocationJournal, inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { createProspectiveMatrixAuthority, hashMatrixPlanBytes,
  readProspectiveMatrixPlan, validateFrozenTaskBStage2Plan, validateMatrixPlan,
  validateProspectiveMatrixAuthority } from '../../dist/packages/integrations/src/prospective-matrix-authority.js';

const planPath = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/task-b-stage2-plan.json');
const compositionPath = path.join(outputParent(), 'task-b-stage1-20260930-suffix-r1',
  'stage1-composition.json');
const bytes = fs.readFileSync(planPath);
const plan = JSON.parse(bytes.toString('utf8'));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const edit = (pathParts, value) => {
  const copy = structuredClone(plan);
  let node = copy;
  for (const part of pathParts.slice(0, -1)) node = node[part];
  node[pathParts.at(-1)] = value;
  return copy;
};
assert.equal(classifyTaskBStage2Timeout('ambiguous_failure', 'agent_timeout', false, 'NOT_RUN'),
  'production_product_timeout');
assert.equal(taskBMayContinue('production_product_timeout'), false);
assert.equal(classifyTaskBStage2Timeout('ambiguous_failure', 'agent_timeout', true, 'NOT_RUN'),
  'ambiguous_failure');
assert.equal(hashMatrixPlanBytes(bytes), sha(bytes));
assert.deepEqual(validateMatrixPlan(structuredClone(plan)), plan);
assert.deepEqual(validateFrozenTaskBStage2Plan(structuredClone(plan)), plan);
assert.deepEqual(plan.orderedSlots.map(slot => `${slot.replicate}:${slot.variant}`),
  ['A:minimal', 'A:current', 'A:expanded', 'B:current', 'B:expanded', 'B:minimal']);
for (const changed of [
  edit(['orderedSlots', 1, 'position'], 1),
  edit(['orderedSlots', 1, 'position'], 3),
  edit(['orderedSlots', 1, 'replicate'], 'B'),
  edit(['orderedSlots', 1, 'variant'], 'expanded'),
  edit(['taskHash'], 'sha256:' + 'f'.repeat(64)),
  edit(['model'], 'gpt-5.6-sol'),
  edit(['reasoning'], 'high'),
  edit(['limits', 'maxObservations'], 7),
  edit(['limits', 'maxProviderStages'], 19),
  edit(['policy', 'retry'], 1),
  edit(['policy', 'repair'], 1),
  edit(['policy', 'apply'], 1),
  edit(['timeoutPolicy', 'override'], true)
]) assert.throws(() => validateFrozenTaskBStage2Plan(changed));
const read = readProspectiveMatrixPlan(HARNESS_ROOT, planPath, compositionPath);
assert.equal(read.planHash, sha(bytes));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-stage2-offline-test-'));
try {
  const source = createSourceCheckout(path.join(temp, 'source-parent'));
  const sessionId = 'task-b-stage2-offline-fixture';
  const input = { harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source,
    planPath, priorCompositionPath: compositionPath, sessionId,
    slot: plan.orderedSlots[0], providerStage: 'planner' };
  const authority = createProspectiveMatrixAuthority(input);
  assert.equal(authority.stage, 'stage2');
  assert.equal(authority.replacement, false);
  assert.equal(authority.planHash, read.planHash);
  assert.equal(authority.priorCompositionHash, plan.priorStage.compositionHash);
  const request = { harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source,
    planPath, priorCompositionPath: compositionPath,
    runId: `matrix.${authority.runtimeIdentity}.planner.fixture`, stage: 'planner',
    model: 'gpt-5.6-luna', reasoning: 'medium' };
  assert.doesNotThrow(() => validateProspectiveMatrixAuthority(authority, request));
  assert.throws(() => createProspectiveMatrixAuthority({ ...input,
    sessionId: 'task-b-stage1-offline-fixture' }));
  assert.throws(() => validateProspectiveMatrixAuthority({ ...authority, stage: 'stage1' }, request));
  assert.throws(() => validateProspectiveMatrixAuthority({ ...authority, replacement: true }, request));
  assert.throws(() => validateProspectiveMatrixAuthority(authority,
    { ...request, model: 'gpt-5.6-sol' }));
  const corrupt = path.join(temp, 'corrupt-composition.json');
  fs.writeFileSync(corrupt, fs.readFileSync(compositionPath));
  fs.appendFileSync(corrupt, '\n');
  assert.throws(() => readProspectiveMatrixPlan(HARNESS_ROOT, planPath, corrupt));
  const journalPath = path.join(temp, 'journal.sqlite');
  fs.copyFileSync(expectedJournalPath(), journalPath);
  const journalBefore = fs.readFileSync(journalPath);
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source, [authority]),
    [{ observationId: authority.observationId, authorized: true }]);
  assert.deepEqual(fs.readFileSync(journalPath), journalBefore);
  const captured = await capturePlannerRequest(loadTaskBPlan(), 'minimal',
    path.join(temp, 'capture'));
  const plannedRequest = { runId: request.runId, stage: 'planner', task: captured.task,
    model: 'gpt-5.6-luna', deadlineAt: Date.now() + 60000,
    sourceRepositoryPath: source, reasoningEffort: 'medium', plannedMatrix: authority };
  const journal = createDurableInvocationJournal(journalPath);
  assert.throws(() => journal.reserve({ ...plannedRequest,
    plannedMatrix: { ...authority, stage: 'stage1' } }));
  assert.throws(() => journal.reserve({ ...plannedRequest,
    plannedMatrix: { ...authority, replacement: true } }));
  assert.throws(() => journal.reserve({ ...plannedRequest,
    plannedMatrix: { ...authority, priorCompositionHash: 'sha256:' + '0'.repeat(64) } }));
  assert.deepEqual(fs.readFileSync(journalPath), journalBefore);
  const reserved = journal.reserve(plannedRequest);
  assert.equal(reserved.runId, plannedRequest.runId);
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source, [authority]),
    [{ observationId: authority.observationId, authorized: false }]);
  const slots = plan.orderedSlots.map(slot => ({ ...slot, sessionId,
    observationId: `${sessionId}.${slot.position}.${slot.replicate}.${slot.variant}` }));
  const fixtureRoot = path.join(temp, 'fixture-session');
  const result = await executeOrderedMatrix({ plan, planHash: read.planHash, sessionId, slots,
    sessionRoot: fixtureRoot,
    executeObservation: async (slot, budget) => {
      budget.recordInvocation(slot.observationId);
      budget.recordInvocation(slot.observationId);
      return { ...slot, classification: 'completed' };
    }, mayContinue: classification => classification === 'completed' });
  assert.equal(result.observations.length, 6);
  assert.equal(result.budget.providerStageInvocations, 12);
  assert.equal(result.stop, null);
  assert.throws(() => fs.mkdirSync(fixtureRoot));
  const limited = edit(['limits', 'maxProviderStages'], 1);
  const limitedResult = await executeOrderedMatrix({ plan: limited, planHash: read.planHash, sessionId, slots,
    sessionRoot: path.join(temp, 'limited-session'),
    executeObservation: async (slot, budget) => {
      budget.recordInvocation(slot.observationId);
      budget.recordInvocation(slot.observationId);
      return { ...slot, classification: 'completed' };
    }, mayContinue: () => true });
  assert.equal(limitedResult.observations.length, 0);
  assert.match(limitedResult.stop, /provider-stage ceiling/);
  const timeoutResult = await executeOrderedMatrix({ plan, planHash: read.planHash, sessionId, slots,
    sessionRoot: path.join(temp, 'timeout-session'),
    executeObservation: async slot => ({ ...slot, classification: 'ambiguous_failure',
      failureCode: 'agent_timeout', candidate: false, replacementEligible: false }),
    mayContinue: classification => classification === 'completed' });
  assert.equal(timeoutResult.observations.length, 1);
  assert.equal(timeoutResult.stop, 'ambiguous_failure');
  assert.equal(timeoutResult.observations[0].replacementEligible, false);
  assert.equal(timeoutResult.observations[0].failureCode, 'agent_timeout');
  assert.equal(fs.existsSync(path.join(outputParent(), 'task-b-stage2-20260930-r1')), false);
  const frozen = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT,
    'research/context-token-matrix-v1/task-b-prospective-manifest.json')));
  for (const [file, expected] of [[frozen.taskBDefinition, frozen.taskBDefinitionSha256],
    [frozen.taskBCalibration, frozen.taskBCalibrationSha256],
    [frozen.frozenTaskAManifest, frozen.frozenTaskAManifestSha256]])
    assert.equal(sha(fs.readFileSync(path.join(HARNESS_ROOT, file))), expected);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('prospective matrix offline tests PASS; provider calls 0; durable journal mutations 0');
