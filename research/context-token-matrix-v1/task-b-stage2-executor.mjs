import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HARNESS_ROOT, MODEL, expectedJournalPath, outputParent,
  prepareSourceCheckout, verifyHarnessIdentity, verifySourceIdentity,
  verifyJournal } from './live-runtime.mjs';
import { executeTaskBObservation, loadTaskBPlan, taskBMayContinue,
  verifyTaskBRemoteAuthority } from './task-b-live.mjs';
import { composeTaskBStage1 } from './task-b-suffix-executor.mjs';
import { executeOrderedMatrix } from './matrix-executor.mjs';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';
import { createProspectiveMatrixAuthority, readProspectiveMatrixPlan } from
  '../../dist/packages/integrations/src/prospective-matrix-authority.js';
import { inspectProspectiveMatrixJournal } from
  '../../dist/packages/integrations/src/durable-invocation-journal.js';

const PLAN_PATH = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/task-b-stage2-plan.json');
const SESSION = /^task-b-stage2-[a-z0-9-]{8,24}$/;
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function gate(ok, reason) { if (!ok) throw Error(`task_b_stage2_invalid: ${reason}`); }
function stage1CompositionPath(home) {
  return path.join(outputParent(home), 'task-b-stage1-20260930-suffix-r1',
    'stage1-composition.json');
}
function verifyUnusedSession(sessionId, home, journalPath) {
  gate(SESSION.test(sessionId) && !/--|-$/.test(sessionId), 'Stage 2 session ID');
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
  journalPath = expectedJournalPath(home), verifyRemote = true } = {}) {
  gate(typeof sessionId === 'string' && SESSION.test(sessionId) && !/--|-$/.test(sessionId),
    'Stage 2 session ID');
  const harnessHead = verifyHarnessIdentity();
  const remoteHead = verifyRemote
    ? (await verifyTaskBRemoteAuthority(harnessHead)).finalRemoteSha : null;
  if (verifyRemote) gate(remoteHead === harnessHead, 'remote HEAD mismatch');
  verifyUnusedSession(sessionId, home, journalPath);
  const compositionPath = stage1CompositionPath(home);
  const { plan, planHash } = readProspectiveMatrixPlan(HARNESS_ROOT, PLAN_PATH, compositionPath);
  const taskPlan = loadTaskBPlan();
  gate(plan.taskHash === taskPlan.task.taskHash && plan.sourceHead === taskPlan.task.sourceHead &&
    plan.model === taskPlan.task.model && plan.reasoning === taskPlan.task.reasoning &&
    same(plan.orderedSlots.map(slot => `${slot.replicate}:${slot.variant}`), taskPlan.order),
  'Task B frozen definition drift');
  const continuationRoot = path.dirname(compositionPath);
  const authority = JSON.parse(fs.readFileSync(path.join(continuationRoot,
    'continuation-authority.json'), 'utf8'));
  const recomposed = composeTaskBStage1({ authority, sessionRoot: continuationRoot,
    journalPath, resultParent: outputParent(home) });
  gate(same(recomposed, JSON.parse(fs.readFileSync(compositionPath, 'utf8'))) &&
    hash(fs.readFileSync(compositionPath)) === plan.priorStage.compositionHash,
  'Stage 1 composition integrity');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-stage2-preflight-'));
  try {
    const source = await prepareSourceCheckout(temporary, plan);
    verifySourceIdentity(source.root, plan.sourceHead);
    const journal = verifyJournal(journalPath, source.root, home);
    const slots = plan.orderedSlots.map(slot => {
      const input = { harnessRoot: HARNESS_ROOT, sourceRepositoryPath: source.root,
        planPath: PLAN_PATH, priorCompositionPath: compositionPath, sessionId, slot };
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
    gate(inspected.length === 6 && inspected.every(item => item.authorized),
      'Stage 2 journal authority unavailable');
    return { schemaVersion: 'task-b-stage2-preflight/v1', ok: true, sessionId,
      planHash, taskHash: plan.taskHash, sourceHead: plan.sourceHead,
      harnessHead, remoteHead, remoteHeadVerified: verifyRemote, slots, journal, priorCompositionHash: plan.priorStage.compositionHash,
      providerModelCalls: 0, journalMutations: 0, liveSessionsCreated: 0 };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Prospective live entrypoint. It is never called by offline tests. */
export async function runTaskBStage2({ sessionId,
  adapterFactory = () => new CodexAgentAdapter() } = {}) {
  gate(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'journal/model environment');
  const preflight = await preflightTaskBStage2({ sessionId });
  const { plan, planHash } = readProspectiveMatrixPlan(HARNESS_ROOT, PLAN_PATH,
    stage1CompositionPath(os.homedir()));
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
