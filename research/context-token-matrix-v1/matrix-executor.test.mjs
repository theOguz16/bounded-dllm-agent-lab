import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executeOrderedMatrix, meetsTelemetryValidity } from './matrix-executor.mjs';
import { composeTaskBStage1 } from './task-b-suffix-executor.mjs';
import { createSourceCheckout, expectedJournalPath, HARNESS_ROOT, outputParent } from './live-runtime.mjs';
import { capturePlannerRequest, classifyTaskBStage2Timeout, loadTaskBPlan,
  persistTaskBCellArtifacts, summarizeTelemetryValidity, taskBMayContinue } from './task-b-live.mjs';
import { createDurableInvocationJournal, inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { createProspectiveMatrixAuthority, hashMatrixPlanBytes,
  readProspectiveMatrixPlan, validateFrozenTaskBStage2Plan, validateMatrixPlan,
  validateTaskBTrajectoryV2Plan, TASK_B_TRAJECTORY_V2_PLAN_HASH,
  validateProspectiveMatrixAuthority } from '../../dist/packages/integrations/src/prospective-matrix-authority.js';

const planPath = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/task-b-stage2-plan.json');
const compositionPath = path.join(outputParent(), 'task-b-stage1-20260930-suffix-r1',
  'stage1-composition.json');
const bytes = fs.readFileSync(planPath);
const plan = JSON.parse(bytes.toString('utf8'));
const telemetryPath = path.join(HARNESS_ROOT,
  'research/context-token-matrix-v1/fixtures/task-b-telemetry-v2-plan.json');
const telemetryBytes = fs.readFileSync(telemetryPath);
const telemetryPlan = JSON.parse(telemetryBytes.toString('utf8'));
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
assert.equal(hashMatrixPlanBytes(telemetryBytes), TASK_B_TRAJECTORY_V2_PLAN_HASH);
assert.deepEqual(validateTaskBTrajectoryV2Plan(telemetryPlan, HARNESS_ROOT), telemetryPlan);
assert.deepEqual(telemetryPlan.orderedSlots.map(slot => `${slot.replicate}:${slot.variant}`),
  ['A:current', 'A:minimal', 'B:expanded']);
for (const [field, value] of [
  ['taskHash', 'sha256:' + 'f'.repeat(64)], ['sourceHead', 'f'.repeat(40)],
  ['model', 'gpt-5.6-sol'], ['reasoning', 'high'],
  ['stage', 'stage1'], ['experimentId', 'unrelated'],
  ['taskId', 'Task-A']
]) assert.throws(() => validateTaskBTrajectoryV2Plan(
  { ...telemetryPlan, [field]: value }, HARNESS_ROOT));
for (const [part, value] of [
  [['orderedSlots', 0, 'variant'], 'minimal'],
  [['limits', 'maxObservations'], 4], [['limits', 'maxProviderStages'], 7],
  [['limits', 'maxProviderStagesPerObservation'], 3],
  [['policy', 'retry'], 1], [['policy', 'repair'], 1], [['policy', 'apply'], 1],
  [['timeoutPolicy', 'override'], true],
  [['stopPolicy', 'infrastructureOrAmbiguousFailure'], 'continue'],
  [['contextDefinition', 'definitionHash'], 'sha256:' + 'f'.repeat(64)],
  [['priorStage', 'compositionHash'], 'sha256:' + 'f'.repeat(64)]
]) {
  const changed = structuredClone(telemetryPlan);
  let target = changed;
  for (const key of part.slice(0, -1)) target = target[key];
  target[part.at(-1)] = value;
  assert.throws(() => validateTaskBTrajectoryV2Plan(changed, HARNESS_ROOT));
}
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
assert.equal(read.experimentKind, 'context-matrix-stage2');
const telemetryRead = readProspectiveMatrixPlan(HARNESS_ROOT, telemetryPath, compositionPath);
assert.equal(telemetryRead.planHash, TASK_B_TRAJECTORY_V2_PLAN_HASH);
assert.equal(telemetryRead.experimentKind, 'trajectory-v2-validation');
assert.equal(telemetryRead.trajectoryTelemetry, 'codex-coder-trajectory/v2');
assert.equal(telemetryRead.contextExpansion, 'none');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-stage2-offline-test-'));
try {
  const realJournal = expectedJournalPath();
  const realJournalBefore = sha(fs.readFileSync(realJournal));
  const canonicalEvidenceRoot = outputParent();
  const suffix = 'task-b-stage1-20260930-suffix-r1';
  const r7 = 'task-b-stage1-20260930-r7';
  const suffixRoot = path.join(canonicalEvidenceRoot, suffix);
  const savedComposition = JSON.parse(fs.readFileSync(compositionPath, 'utf8'));
  const compositionBefore = sha(fs.readFileSync(compositionPath));
  const continuationAuthority = JSON.parse(fs.readFileSync(path.join(suffixRoot,
    'continuation-authority.json'), 'utf8'));
  const isolatedJournal = path.join(temp, 'isolated-journal.sqlite');
  fs.copyFileSync(realJournal, isolatedJournal);
  const snapshotBefore = sha(fs.readFileSync(isolatedJournal));
  const compose = (root, journalFile) => composeTaskBStage1({
    authority: continuationAuthority, sessionRoot: path.join(root, suffix),
    journalPath: journalFile, resultParent: root });
  assert.deepEqual(compose(canonicalEvidenceRoot, isolatedJournal), savedComposition);
  assert.equal(sha(fs.readFileSync(isolatedJournal)), snapshotBefore);
  const historicalFiles = [];
  const collect = (root, relative = '') => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(root, next);
      else if (entry.isFile()) historicalFiles.push(next);
    }
  };
  for (const session of [r7, suffix]) collect(canonicalEvidenceRoot, session);
  const historicalHashes = historicalFiles.map(file => sha(fs.readFileSync(
    path.join(canonicalEvidenceRoot, file))));
  const relocatedRoot = path.join(temp, 'relocated-evidence');
  fs.mkdirSync(relocatedRoot);
  for (const session of [r7, suffix]) fs.cpSync(
    path.join(canonicalEvidenceRoot, session), path.join(relocatedRoot, session),
    { recursive: true });
  assert.deepEqual(historicalFiles.map(file => sha(fs.readFileSync(
    path.join(relocatedRoot, file)))), historicalHashes);
  assert.notDeepEqual(compose(relocatedRoot, isolatedJournal), savedComposition);
  assert.equal(sha(fs.readFileSync(path.join(relocatedRoot, suffix,
    'stage1-composition.json'))), compositionBefore);
  const badJournal = path.join(temp, 'bad-journal.sqlite');
  fs.copyFileSync(isolatedJournal, badJournal);
  const badDb = new DatabaseSync(badJournal);
  const historicalRunId = savedComposition.rows[0].journal[0].runId;
  badDb.prepare('UPDATE provider_invocations SET record_hash=? WHERE run_id=?')
    .run('sha256:' + 'f'.repeat(64), historicalRunId);
  badDb.close();
  assert.throws(() => compose(canonicalEvidenceRoot, badJournal), /journal binding/);
  assert.equal(sha(fs.readFileSync(realJournal)), realJournalBefore);
  assert.deepEqual(historicalFiles.map(file => sha(fs.readFileSync(
    path.join(canonicalEvidenceRoot, file)))), historicalHashes);
  assert.equal(readProspectiveMatrixPlan(HARNESS_ROOT, telemetryPath,
    compositionPath).experimentKind, 'trajectory-v2-validation');
  const realDb = new DatabaseSync(realJournal, { readOnly: true });
  try {
    assert.equal(realDb.prepare('SELECT count(*) AS n FROM provider_invocations WHERE run_id LIKE ?')
      .get('matrix.task-b-telemetry-offline-fixture.%').n, 0);
    assert.equal(realDb.prepare("SELECT count(*) AS n FROM provider_invocations WHERE record_json LIKE '%raw-bounded-result.json%' OR record_json LIKE '%raw-product-result.json%'").get().n, 0);
  } finally { realDb.close(); }
  assert.equal(fs.existsSync(path.join(canonicalEvidenceRoot,
    'task-b-telemetry-offline-fixture')), false);
  const alternatePath = path.join(temp, 'alternate-plan.json');
  fs.copyFileSync(telemetryPath, alternatePath);
  assert.equal(readProspectiveMatrixPlan(HARNESS_ROOT, alternatePath,
    compositionPath).planHash, TASK_B_TRAJECTORY_V2_PLAN_HASH);
  fs.chmodSync(alternatePath, 0o600);
  fs.appendFileSync(alternatePath, ' ');
  assert.throws(() => readProspectiveMatrixPlan(HARNESS_ROOT, alternatePath,
    compositionPath), /approved plan hash/);
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
  assert.throws(() => readProspectiveMatrixPlan(HARNESS_ROOT, telemetryPath, corrupt));
  const telemetryAuthorities = telemetryPlan.orderedSlots.map(slot =>
    createProspectiveMatrixAuthority({ harnessRoot: HARNESS_ROOT,
      sourceRepositoryPath: source, planPath: telemetryPath,
      priorCompositionPath: compositionPath,
      sessionId: 'task-b-telemetry-offline-fixture', slot,
      providerStage: 'planner' }));
  assert.equal(telemetryAuthorities.length, 3);
  const journalPath = path.join(temp, 'journal.sqlite');
  fs.copyFileSync(expectedJournalPath(), journalPath);
  // Replay the state before prospective Stage 2. Prior Stage 1 evidence remains intact.
  const fixtureDb = new (await import('node:sqlite')).DatabaseSync(journalPath);
  for (const row of fixtureDb.prepare('SELECT run_id, record_json FROM provider_invocations').all())
    if (JSON.parse(row.record_json).plannedMatrix)
      fixtureDb.prepare('DELETE FROM provider_invocations WHERE run_id=?').run(row.run_id);
  fixtureDb.close();
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    telemetryAuthorities).map(item => item.authorized), [true, true, true]);
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
  const telemetrySessionId = 'task-b-telemetry-offline-fixture';
  const telemetryInput = { ...input, planPath: telemetryPath,
    sessionId: telemetrySessionId, slot: telemetryPlan.orderedSlots[0] };
  const telemetryAuthority = createProspectiveMatrixAuthority(telemetryInput);
  assert.equal(telemetryAuthority.version, 'prospective-matrix-stage/v2');
  assert.equal(telemetryAuthority.experimentKind, 'trajectory-v2-validation');
  assert.equal(telemetryAuthority.trajectoryTelemetry, 'codex-coder-trajectory/v2');
  assert.equal(telemetryAuthority.contextExpansion, 'none');
  const telemetryRequest = { ...request, planPath: telemetryPath,
    runId: `matrix.${telemetryAuthority.runtimeIdentity}.planner.fixture` };
  assert.doesNotThrow(() => validateProspectiveMatrixAuthority(
    telemetryAuthority, telemetryRequest));
  for (const changed of [
    { ...telemetryAuthority, experimentKind: 'context-matrix-stage2' },
    { ...telemetryAuthority, version: 'prospective-matrix-stage/v1' },
    { ...telemetryAuthority, stage: 'stage1' },
    { ...telemetryAuthority, replacement: true },
    { ...telemetryAuthority, planHash: read.planHash },
    { ...telemetryAuthority, trajectoryTelemetry: 'codex-coder-trajectory/v1' },
    { ...telemetryAuthority, limits: { ...telemetryAuthority.limits,
      maxProviderStages: 7 } }
  ]) assert.throws(() => validateProspectiveMatrixAuthority(changed, telemetryRequest));
  assert.throws(() => validateProspectiveMatrixAuthority(authority, telemetryRequest));
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    [telemetryAuthority]), [{ observationId: telemetryAuthority.observationId,
      authorized: true }]);
  const telemetryCaptured = await capturePlannerRequest(loadTaskBPlan(), 'current',
    path.join(temp, 'telemetry-capture'));
  const telemetryPlannedRequest = { ...plannedRequest,
    runId: telemetryRequest.runId, task: telemetryCaptured.task,
    plannedMatrix: telemetryAuthority };
  journal.reserve(telemetryPlannedRequest);
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    [telemetryAuthority]), [{ observationId: telemetryAuthority.observationId,
      authorized: false }]);
  const replayAuthority = createProspectiveMatrixAuthority({ ...telemetryInput,
    sessionId: 'task-b-telemetry-replay-fixture' });
  assert.deepEqual(inspectProspectiveMatrixJournal(journalPath, source,
    [replayAuthority]), [{ observationId: replayAuthority.observationId,
      authorized: false }]);
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
  const telemetrySlots = telemetryPlan.orderedSlots.map(slot => ({ ...slot,
    sessionId: telemetrySessionId,
    observationId: `${telemetrySessionId}.${slot.position}.${slot.replicate}.${slot.variant}` }));
  const telemetryResult = await executeOrderedMatrix({ plan: telemetryPlan,
    planHash: telemetryRead.planHash, sessionId: telemetrySessionId,
    slots: telemetrySlots, sessionRoot: path.join(temp, 'telemetry-session'),
    executeObservation: async (slot, budget) => {
      budget.recordInvocation(slot.observationId);
      budget.recordInvocation(slot.observationId);
      return { ...slot, classification: 'completed' };
    }, mayContinue: classification => classification === 'completed' });
  assert.deepEqual(telemetryResult.observations.map(item =>
    `${item.replicate}:${item.variant}`), ['A:current', 'A:minimal', 'B:expanded']);
  assert.deepEqual(telemetryResult.budget,
    { observations: 3, providerStageInvocations: 6 });
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
  const requirement = { schemaVersion: 'codex-coder-trajectory/v2',
    minimumUsableIntervalFraction: 0.5,
    requiredFields: ['inputDeltaAfterToolEvent', 'cachedDeltaAfterToolEvent'] };
  const measuredPlan = { ...telemetryPlan, telemetryValidity: requirement };
  assert.deepEqual(validateMatrixPlan(measuredPlan), measuredPlan);
  assert.throws(() => validateMatrixPlan({ ...measuredPlan,
    telemetryValidity: { ...requirement, minimumUsableIntervalFraction: 2 } }));
  const noIntervals = summarizeTelemetryValidity({ schemaVersion: requirement.schemaVersion,
    status: 'observed', truncated: false,
    tools: [{ inputDeltaAfterToolEvent: null, cachedDeltaAfterToolEvent: null },
      { inputDeltaAfterToolEvent: null, cachedDeltaAfterToolEvent: null }] }, requirement);
  assert.equal(noIntervals.usableIntervals, 0);
  assert.equal(meetsTelemetryValidity(requirement, { telemetryValidity: noIntervals }), false);
  const oneInterval = summarizeTelemetryValidity({ schemaVersion: requirement.schemaVersion,
    status: 'observed', truncated: false,
    tools: [{ inputDeltaAfterToolEvent: 8, cachedDeltaAfterToolEvent: 2 },
      { inputDeltaAfterToolEvent: null, cachedDeltaAfterToolEvent: null }] }, requirement);
  assert.equal(meetsTelemetryValidity(requirement, { telemetryValidity: oneInterval }), true);
  assert.equal(meetsTelemetryValidity(requirement, { telemetryValidity:
    { ...oneInterval, status: 'invalid' } }), false);
  assert.equal(meetsTelemetryValidity(requirement, { telemetryValidity:
    { ...oneInterval, schemaVersion: 'codex-coder-trajectory/v1' } }), false);
  let executed = 0;
  const measured = await executeOrderedMatrix({ plan: measuredPlan,
    planHash: telemetryRead.planHash, sessionId: telemetrySessionId,
    slots: telemetrySlots, sessionRoot: path.join(temp, 'measured-session'),
    executeObservation: async slot => { executed++;
      return { ...slot, classification: 'completed', telemetryValidity: noIntervals }; },
    mayContinue: taskBMayContinue });
  assert.equal(executed, 1);
  assert.equal(measured.stop, 'telemetry_unusable');
  assert.equal(measured.observations.length, 1);
  assert.equal(measured.budget.observations, 1);
  assert.equal(meetsTelemetryValidity(undefined, { telemetryValidity: noIntervals }), true);
  const safeCell = path.join(temp, 'bounded-cell');
  fs.mkdirSync(safeCell);
  const secret = 'RAW_PROMPT_SOURCE_TOOL_RESULT_SENTINEL';
  const safeTrajectory = { schemaVersion: 'codex-coder-trajectory/v2',
    tools: [{ requestBytes: secret.length, responseBytes: secret.length,
      inputDeltaAfterToolEvent: null }] };
  persistTaskBCellArtifacts(safeCell, { matrixAuthorities: {} }, {
    sourceStatus: { before: 'pinned', after: 'pinned' }, calls: [],
    rawProduct: { providerText: secret }, rawBounded: { source: secret, toolResult: secret },
    selection: { files: [], bytes: 0 }, behavior: { status: 'PASS', behaviorPass: true },
    contextExpansion: { expansion: null, traces: null },
    normalized: { outcome: { candidate: true }, usage: { aggregate: { input: 1 } } },
    trajectory: safeTrajectory, summary: { classification: 'completed' } });
  assert.equal(fs.existsSync(path.join(safeCell, 'raw-bounded-result.json')), false);
  assert.equal(fs.existsSync(path.join(safeCell, 'raw-product-result.json')), false);
  assert.equal(fs.readFileSync(path.join(safeCell, 'coder-trajectory.json'), 'utf8')
    .includes(secret), false);
  assert.equal(fs.readdirSync(safeCell).some(file =>
    fs.readFileSync(path.join(safeCell, file), 'utf8').includes(secret)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(safeCell, 'behavior-check.json'))).status, 'PASS');
  assert.equal(JSON.parse(fs.readFileSync(path.join(safeCell, 'experiment-result.json')))
    .outcome.candidate, true);
  const frozen = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT,
    'research/context-token-matrix-v1/task-b-prospective-manifest.json')));
  for (const [file, expected] of [[frozen.taskBDefinition, frozen.taskBDefinitionSha256],
    [frozen.taskBCalibration, frozen.taskBCalibrationSha256],
    [frozen.frozenTaskAManifest, frozen.frozenTaskAManifestSha256]])
    assert.equal(sha(fs.readFileSync(path.join(HARNESS_ROOT, file))), expected);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('prospective matrix offline tests PASS; provider calls 0; durable journal mutations 0');
