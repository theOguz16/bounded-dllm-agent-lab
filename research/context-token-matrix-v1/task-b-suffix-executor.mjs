import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_ROOT, expectedJournalPath, outputParent,
  verifyHarnessIdentity } from './live-runtime.mjs';
import { assertFreshTaskBSession, executeTaskBObservation, loadTaskBPlan,
  preflightTaskBForSlots, taskBMayContinue } from './task-b-live.mjs';
import { authorizeTaskBContinuation, createTaskBContinuationBudget,
  verifyR7RetainedPrefix } from './task-b-continuation-authority.mjs';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';

const R7 = 'task-b-stage1-20260930-r7';
const ORDER = ['B:current', 'B:expanded', 'B:minimal'];
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function gate(ok, reason) { if (!ok) throw Error(`task_b_suffix_authority_invalid: ${reason}`); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function artifactHashes(root) { return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry =>
    [entry.name, sha(fs.readFileSync(path.join(root, entry.name)))]).sort((a, b) =>
      a[0].localeCompare(b[0], 'en'))); }

export function assertTaskBSuffixOrder(authority, slots) {
  gate(authority?.version === 'task-b-stage1-partial-continuation/v1' &&
    same(authority.authorizedPositions, [4, 5, 6]) &&
    same(authority.policy, { retry: 0, repair: 0, apply: 0 }) &&
    Array.isArray(slots) && slots.length === 3, 'three authorized B slots');
  for (let index = 0; index < 3; index++) {
    const slot = slots[index];
    const authorized = authority.suffix[index];
    gate(slot.position === index + 4 &&
      `${slot.replicate}:${slot.variant}` === ORDER[index] &&
      slot.sessionId === authority.continuationSessionId &&
      slot.observationId === authorized.observationId &&
      slot.runtimeIdentity === authorized.runtimeIdentity &&
      authorized.observationKind === 'original_stage1_untouched_suffix' &&
      authorized.replacement === false && authorized.retry === false,
    `position ${index + 4} order or identity`);
  }
  return slots;
}

/** No session directory and no provider call. */
export async function preflightTaskBSuffix({ sessionId, home = os.homedir(),
  resultParent = outputParent(home), journalPath = expectedJournalPath(home),
  verifyRemote = true } = {}) {
  const authority = authorizeTaskBContinuation(sessionId, { root: resultParent, journalPath });
  const plan = loadTaskBPlan();
  const identitySlots = assertTaskBSuffixOrder(authority, authority.suffix);
  for (const slot of identitySlots)
    assertFreshTaskBSession([slot], resultParent, journalPath);
  const common = await preflightTaskBForSlots({ plan, sessionId, identitySlots,
    home, journalPath, verifyRemote });
  assertTaskBSuffixOrder(authority, common.slots);
  gate(common.plannedJournal.length === 3 &&
    common.plannedJournal.every(item => item.status === 'reviewed_replacement_required' &&
      item.authorized && item.coderFutureAdmissible), 'frozen r4 lineage or B journal authority');
  return { ...common, schemaVersion: 'task-b-stage1-suffix-preflight/v1',
    retainedPrefixReviewHash: authority.retainedPrefixReviewHash,
    continuationAuthority: authority, providerModelCalls: 0 };
}

/** Deterministic orchestration boundary, exercised only with offline fixture callbacks. */
export async function executeAuthorizedTaskBSuffix({ authority, slots, budget,
  beforeSlot = async () => {}, execute }) {
  assertTaskBSuffixOrder(authority, slots);
  const observations = [];
  let stop = null;
  for (const slot of slots) {
    try {
      await beforeSlot(slot);
      budget.reserveObservation(slot.observationId);
      const result = await execute(slot, budget);
      gate(result?.observationId === slot.observationId &&
        result?.position === slot.position && result?.replicate === 'B' &&
        result?.variant === slot.variant, 'executed result identity');
      observations.push(result);
      if (!taskBMayContinue(result.classification)) {
        stop = result.classification;
        break;
      }
    } catch (error) {
      stop = `infrastructure_or_ambiguous: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  return { observations, stop, budget: budget.snapshot(),
    providerModelCalls: budget.snapshot().providerStageInvocations };
}

/** Reference immutable r7 and suffix artifacts; never copy either session's rows. */
export function composeTaskBStage1({ authority, sessionRoot,
  journalPath = expectedJournalPath(), resultParent = outputParent() }) {
  const prefix = verifyR7RetainedPrefix({ root: resultParent, journalPath });
  const { authorityHash, ...authorityPayload } = authority ?? {};
  gate(authorityHash === sha(Buffer.from(JSON.stringify(authorityPayload))) &&
    authority?.retainedPrefixReviewHash === sha(fs.readFileSync(path.join(
      HARNESS_ROOT, 'research/context-token-matrix-v1/task-b-r7-retained-prefix-review.json'))) &&
    authority?.parentSessionId === R7, 'retained-prefix authority');
  assertTaskBSuffixOrder(authority, authority.suffix);
  const report = read(path.join(sessionRoot, 'suffix-summary.json'));
  gate(report.sessionId === authority.continuationSessionId && report.stop === null &&
    report.observations?.length === 3 && report.budget?.observations === 3 &&
    report.budget?.providerStageInvocations <= 9, 'completed suffix summary');
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const suffix = authority.suffix.map((slot, index) => {
      const cellRoot = path.join(sessionRoot,
        `${String(slot.position).padStart(2, '0')}-B-${slot.variant}`);
      const reservation = read(path.join(sessionRoot, `reservation-${slot.position}.json`));
      const cell = read(path.join(cellRoot, 'cell-summary.json'));
      const result = read(path.join(cellRoot, 'experiment-result.json'));
      const behavior = read(path.join(cellRoot, 'behavior-check.json'));
      const calls = read(path.join(cellRoot, 'adapter-calls.json'));
      gate(report.observations[index]?.observationId === slot.observationId &&
        reservation.observationId === slot.observationId &&
        cell.observationId === slot.observationId && result.runId === slot.observationId &&
        taskBMayContinue(cell.classification) &&
        same(calls.map(call => call.mode), ['planner', 'coder']) &&
        calls.length === cell.providerStageInvocations &&
        (cell.classification !== 'completed' ||
          result.outcome?.decision === 'bounded_task_completed' &&
          result.outcome?.behavior === 'PASS' && behavior.status === 'PASS' &&
          behavior.infrastructurePass === true && behavior.moduleLoaded === true &&
          behavior.assertionsCompleted === true),
      `suffix position ${slot.position} result provenance`);
      const journal = calls.map(call => {
        const row = db.prepare('SELECT stage,record_json,record_hash FROM provider_invocations WHERE run_id=?')
          .get(call.runId);
        gate(row && sha(Buffer.from(row.record_json)) === row.record_hash,
          `suffix position ${slot.position} journal hash`);
        const record = JSON.parse(row.record_json);
        gate(row.stage === call.mode && record.state === 'completed' &&
          record.plannedTaskB?.sessionId === slot.sessionId &&
          record.plannedTaskB?.observationId === slot.observationId &&
          record.plannedTaskB?.position === slot.position,
        `suffix position ${slot.position} journal binding`);
        return { runId: call.runId, recordHash: row.record_hash, state: record.state };
      });
      return { position: slot.position, replicate: 'B', variant: slot.variant,
        sessionId: slot.sessionId, observationId: slot.observationId,
        classification: cell.classification, artifactRoot: cellRoot,
        reservationHash: sha(fs.readFileSync(path.join(sessionRoot,
          `reservation-${slot.position}.json`))), artifactHashes: artifactHashes(cellRoot), journal };
    });
    return { schemaVersion: 'task-b-stage1-composition/v1',
      retainedPrefixReviewHash: authority.retainedPrefixReviewHash,
      continuationAuthorityHash: authority.authorityHash,
      rows: [...prefix.observations.map(item => ({ position: item.position,
        replicate: item.replicate, variant: item.variant, sessionId: R7,
        observationId: item.observationId, classification: item.classification,
        artifactRoot: path.join(resultParent, R7,
          `${String(item.position).padStart(2, '0')}-A-${item.variant}`),
        reservationHash: item.reservationHash,
        artifactHashes: item.artifactHashes, journal: item.journal })), ...suffix] };
  } finally { db.close(); }
}

/** Future live entry only; never invoked by offline fixtures. */
export async function runTaskBSuffix({ sessionId,
  adapterFactory = () => new CodexAgentAdapter() } = {}) {
  gate(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === 'gpt-5.6-luna', 'frozen journal/model environment');
  const preflight = await preflightTaskBSuffix({ sessionId });
  const authority = preflight.continuationAuthority;
  const plan = loadTaskBPlan();
  const budget = createTaskBContinuationBudget(authority);
  const parent = outputParent();
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const sessionRoot = path.join(parent, sessionId);
  fs.mkdirSync(sessionRoot, { recursive: false, mode: 0o700 });
  save(path.join(sessionRoot, 'preflight.json'), preflight);
  save(path.join(sessionRoot, 'continuation-authority.json'), authority);
  save(path.join(sessionRoot, 'proposal.snapshot.json'), plan.proposal);
  save(path.join(sessionRoot, 'definition.snapshot.json'), plan.definition);
  save(path.join(sessionRoot, 'calibration.snapshot.json'), plan.calibration);
  const result = await executeAuthorizedTaskBSuffix({ authority, slots: preflight.slots,
    budget, beforeSlot: slot => {
      gate(verifyHarnessIdentity() === preflight.harnessHead, 'harness changed');
      verifyR7RetainedPrefix();
      assertFreshTaskBSession([slot], parent, expectedJournalPath(), { checkDirectory: false });
      save(path.join(sessionRoot, `reservation-${slot.position}.json`), slot);
    },
    execute: (slot, counter) => executeTaskBObservation(plan, slot, sessionRoot,
      counter, adapterFactory) });
  const report = { sessionId, planned: preflight.slots, ...result };
  save(path.join(sessionRoot, 'suffix-summary.json'), report);
  if (result.stop === null && result.observations.length === 3)
    save(path.join(sessionRoot, 'stage1-composition.json'),
      composeTaskBStage1({ authority, sessionRoot }));
  return { sessionRoot, ...report };
}
