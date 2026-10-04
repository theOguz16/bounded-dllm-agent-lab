import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HARNESS_ROOT, MODEL, expectedJournalPath, outputParent,
  prepareSourceCheckout, verifyHarnessIdentity, verifySourceIdentity,
  verifyJournal } from './live-runtime.mjs';
import { executeTaskBObservation, loadTaskBPlan, selectTaskBContext, taskBMayContinue,
  verifyTaskBRemoteAuthority } from './task-b-live.mjs';
import { composeTaskBStage1 } from './task-b-suffix-executor.mjs';
import { executeOrderedMatrix } from './matrix-executor.mjs';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';
import { createProspectiveMatrixAuthority, readProspectiveMatrixPlan,
  TASK_B_INSPECTION_MIRROR_PLAN_HASH, TASK_B_NAVIGATION_PLAN_HASH,
  TASK_B_NAVIGATION_PREPARED_PLAN_HASH } from
  '../../dist/packages/integrations/src/prospective-matrix-authority.js';
import { inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { deriveTaskBNavigationCue } from
  '../../dist/packages/integrations/src/task-b-navigation-cue.js';

const PLAN_PATH = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/task-b-stage2-plan.json');
const SESSION_STAGE2 = /^task-b-stage2-[a-z0-9-]{8,24}$/;
const SESSION_TELEMETRY = /^task-b-telemetry-[a-z0-9-]{8,24}$/;
const SESSION_INSPECTION = /^task-b-inspection-[a-z0-9-]{8,24}$/;
const SESSION_NAVIGATION = /^task-b-navigation-[a-z0-9-]{8,24}$/;
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function gate(ok, reason) { if (!ok) throw Error(`task_b_stage2_invalid: ${reason}`); }
function stage1CompositionPath(evidenceRoot) {
  return path.join(evidenceRoot, 'task-b-stage1-20260930-suffix-r1',
    'stage1-composition.json');
}
function verifyUnusedSession(sessionId, home, journalPath, experimentKind) {
  const pattern = experimentKind === 'trajectory-v2-validation' ?
    SESSION_TELEMETRY : experimentKind === 'inspection-instruction-validation' ?
      SESSION_INSPECTION : experimentKind === 'navigation-cue-validation' ?
        SESSION_NAVIGATION : SESSION_STAGE2;
  gate(pattern.test(sessionId) && !/--|-$/.test(sessionId), 'matrix session ID');
  gate(!fs.existsSync(path.join(outputParent(home), sessionId)), 'session directory reused');
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const prefix = `matrix.${sessionId}.`;
    gate(db.prepare('SELECT count(*) AS n FROM provider_invocations WHERE substr(run_id,1,?)=?')
      .get(prefix.length, prefix).n === 0, 'session journal identity reused');
  } finally { db.close(); }
}
/** Read-only against the durable journal and live-session directory. Only temporary checkouts are created. */
export async function preflightTaskBStage2({ sessionId, home = os.homedir(),
  journalPath = expectedJournalPath(home), verifyRemote = true,
  planPath = PLAN_PATH, evidenceRoot = outputParent(home) } = {}) {
  gate(typeof sessionId === 'string', 'matrix session ID');
  const harnessHead = verifyHarnessIdentity();
  const remoteHead = verifyRemote
    ? (await verifyTaskBRemoteAuthority(harnessHead)).finalRemoteSha : null;
  if (verifyRemote) gate(remoteHead === harnessHead, 'remote HEAD mismatch');
  const compositionPath = stage1CompositionPath(evidenceRoot);
  const { plan, planHash, experimentKind, trajectoryTelemetry,
    contextExpansion } = readProspectiveMatrixPlan(HARNESS_ROOT, planPath, compositionPath);
  verifyUnusedSession(sessionId, home, journalPath, experimentKind);
  const taskPlan = loadTaskBPlan();
  gate(plan.taskHash === taskPlan.task.taskHash && plan.sourceHead === taskPlan.task.sourceHead &&
    plan.model === taskPlan.task.model && plan.reasoning === taskPlan.task.reasoning &&
    same(plan.orderedSlots.map(slot => `${slot.replicate}:${slot.variant}`),
      experimentKind === 'trajectory-v2-validation' ?
        ['A:current', 'A:minimal', 'B:expanded'] :
        experimentKind === 'inspection-instruction-validation' ?
          planHash === TASK_B_INSPECTION_MIRROR_PLAN_HASH ?
            ['B:current', 'A:current', 'A:current', 'B:current'] :
            ['A:current', 'B:current', 'B:current', 'A:current'] :
        experimentKind === 'navigation-cue-validation' &&
          [TASK_B_NAVIGATION_PLAN_HASH, TASK_B_NAVIGATION_PREPARED_PLAN_HASH].includes(planHash) ?
            ['A:current', 'B:current', 'B:current', 'A:current'] : taskPlan.order),
  'Task B frozen definition drift');
  const continuationRoot = path.dirname(compositionPath);
  const authority = JSON.parse(fs.readFileSync(path.join(continuationRoot,
    'continuation-authority.json'), 'utf8'));
  const recomposed = composeTaskBStage1({ authority, sessionRoot: continuationRoot,
    journalPath, resultParent: evidenceRoot });
  gate(same(recomposed, JSON.parse(fs.readFileSync(compositionPath, 'utf8'))) &&
    hash(fs.readFileSync(compositionPath)) === plan.priorStage.compositionHash,
  'Stage 1 composition integrity');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-stage2-preflight-'));
  try {
    const source = await prepareSourceCheckout(temporary, plan);
    verifySourceIdentity(source.root, plan.sourceHead);
    const journal = verifyJournal(journalPath, source.root, home);
    const selectedContext = ['inspection-instruction-validation', 'navigation-cue-validation']
      .includes(experimentKind) ?
      (await selectTaskBContext(taskPlan, 'current', source.root)).selected : null;
    const contextBinding = selectedContext === null ? null : {
      files: selectedContext.selectedFiles, bytes: selectedContext.selectedBytes,
      hashes: selectedContext.initialEvidence.map(item =>
        ({ path: item.path, sha256: item.contentHash })) };
    const navigationCue = experimentKind === 'navigation-cue-validation' ?
      deriveTaskBNavigationCue(selectedContext.intelligence,
        selectedContext.initialEvidence.map(item => ({ path: item.path,
          sha256: item.contentHash, bytes: item.byteLength }))) : null;
    const slots = plan.orderedSlots.map(slot => {
      if (experimentKind === 'inspection-instruction-validation')
        gate(slot.variant === 'current' &&
          ['control', 'inspection-instruction'].includes(slot.condition),
        'inspection slot context or condition');
      if (experimentKind === 'navigation-cue-validation')
        gate(slot.variant === 'current' &&
          ['control', 'navigation-cue'].includes(slot.condition),
        'navigation slot context or condition');
      const input = { harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source.root,
        planPath, priorCompositionPath: compositionPath, sessionId, slot };
      const planner = createProspectiveMatrixAuthority({ ...input, providerStage: 'planner' });
      const coder = createProspectiveMatrixAuthority({ ...input, providerStage: 'coder' });
      gate(planner.observationId === coder.observationId &&
        planner.stageHash !== coder.stageHash, 'stage binding');
      return { ...slot, sessionId, observationId: planner.observationId,
        runtimeIdentity: planner.runtimeIdentity,
        matrixAuthorities: { planner, coder } };
    });
    const inspected = inspectProspectiveMatrixJournal(journalPath, source.root,
      slots.map(slot => slot.matrixAuthorities.planner));
    gate(inspected.length === plan.orderedSlots.length &&
      inspected.every(item => item.authorized), 'matrix journal authority unavailable');
    return { schemaVersion: 'task-b-stage2-preflight/v1', ok: true, sessionId,
      planHash, experimentKind, trajectoryTelemetry, contextExpansion,
      taskHash: plan.taskHash, sourceHead: plan.sourceHead,
      ...(contextBinding === null ? {} : { contextBinding }),
      ...(navigationCue === null ? {} : { navigationCue: {
        hash: navigationCue.cueHash, bytes: navigationCue.bytes,
        estimatedTokens: navigationCue.estimatedTokens,
        analyzerHash: navigationCue.analyzerHash, contextHash: navigationCue.contextHash,
        projectionRule: navigationCue.projectionRule,
        symbolInventory: navigationCue.symbolInventory } }),
      harnessHead, remoteHead, remoteHeadVerified: verifyRemote, slots, journal, priorCompositionHash: plan.priorStage.compositionHash,
      providerModelCalls: 0, journalMutations: 0, liveSessionsCreated: 0 };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Prospective live entrypoint. It is never called by offline tests. */
export async function runTaskBStage2({ sessionId, planPath = PLAN_PATH,
  adapterFactory = () => new CodexAgentAdapter() } = {}) {
  gate(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'journal/model environment');
  const preflight = await preflightTaskBStage2({ sessionId, planPath });
  const { plan, planHash } = readProspectiveMatrixPlan(HARNESS_ROOT, planPath,
    stage1CompositionPath(outputParent()));
  const taskPlan = loadTaskBPlan();
  return executeOrderedMatrix({ plan, planHash, sessionId, slots: preflight.slots,
    sessionRoot: path.join(outputParent(), sessionId),
    beforeSlot: slot => {
      gate(verifyHarnessIdentity() === preflight.harnessHead, 'harness changed');
      const db = new DatabaseSync(expectedJournalPath(), { readOnly: true });
      try {
        const prefix = `matrix.${slot.runtimeIdentity}.`;
        gate(db.prepare('SELECT count(*) AS n FROM provider_invocations WHERE substr(run_id,1,?)=?')
          .get(prefix.length, prefix).n === 0, 'slot journal identity reused');
      } finally { db.close(); }
    },
    executeObservation: (slot, budget) => executeTaskBObservation(taskPlan, slot,
      path.join(outputParent(), sessionId), budget, adapterFactory),
    mayContinue: taskBMayContinue });
}
