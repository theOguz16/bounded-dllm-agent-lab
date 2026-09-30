import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_ROOT, expectedJournalPath, outputParent } from './live-runtime.mjs';
import { deriveTaskBRuntimeIdentity, loadTaskBPlan } from './task-b-live.mjs';

const HERE = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1');
const REVIEW = path.join(HERE, 'task-b-r7-retained-prefix-review.json');
const ORDER = ['A:minimal', 'A:current', 'A:expanded', 'B:current', 'B:expanded', 'B:minimal'];
const R7 = 'task-b-stage1-20260930-r7';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function gate(ok, reason) { if (!ok) throw Error(`task_b_continuation_authority_invalid: ${reason}`); }
function bytes(file) { return fs.readFileSync(file); }
function json(file) { return JSON.parse(bytes(file).toString('utf8')); }
function files(root) { return fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => entry.name).sort(); }
function relativeHashes(root) { return Object.fromEntries(files(root).map(name =>
  [name, hash(bytes(path.join(root, name)))])); }
function journalRows(db, prefix) { return db.prepare('SELECT run_id, stage, record_json, record_hash FROM provider_invocations WHERE substr(run_id,1,?)=? ORDER BY run_id')
  .all(prefix.length, prefix); }

/** A read-only snapshot builder. The committed review is the independent expected value. */
export function inspectR7RetainedPrefix({ root = outputParent(),
  journalPath = expectedJournalPath() } = {}) {
  const sessionRoot = path.join(root, R7);
  const summaryFile = path.join(sessionRoot, 'stage1-summary.json');
  const summary = json(summaryFile);
  gate(summary.sessionId === R7 && summary.stop === 'ambiguous_failure' &&
    summary.observations?.length === 3 && summary.budget?.observations === 3 &&
    summary.budget?.providerStageInvocations === 6 && summary.providerModelCalls === 6,
  'r7 stopped summary');
  gate(same(summary.planned?.map(item => `${item.replicate}:${item.variant}`), ORDER),
    'r7 frozen planned order');
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const observations = [];
    for (let index = 0; index < 3; index++) {
      const position = index + 1;
      const variant = ORDER[index].slice(2);
      const observationId = `${R7}.${position}.A.${variant}`;
      const runtimeIdentity = deriveTaskBRuntimeIdentity({ sessionId: R7,
        position, replicate: 'A', variant });
      const cellRoot = path.join(sessionRoot, `${String(position).padStart(2, '0')}-A-${variant}`);
      const summaryRow = summary.observations[index];
      const reservation = json(path.join(sessionRoot, `reservation-${position}.json`));
      const cell = json(path.join(cellRoot, 'cell-summary.json'));
      const result = json(path.join(cellRoot, 'experiment-result.json'));
      const behavior = json(path.join(cellRoot, 'behavior-check.json'));
      const calls = json(path.join(cellRoot, 'adapter-calls.json'));
      const plannerAuthority = reservation.taskBPlannerAuthority;
      const coderAuthority = reservation.taskBCoderAuthority;
      gate([summaryRow, reservation, cell].every(item => item.position === position &&
        item.replicate === 'A' && item.variant === variant && item.sessionId === R7 &&
        item.observationId === observationId && item.runtimeIdentity === runtimeIdentity) &&
        result.runId === observationId && cell.taskHash === plannerAuthority.taskHash &&
        coderAuthority.taskHash === plannerAuthority.taskHash &&
        plannerAuthority.sourceHead === coderAuthority.sourceHead &&
        plannerAuthority.model === coderAuthority.model &&
        plannerAuthority.reasoning === coderAuthority.reasoning &&
        same([plannerAuthority.retry, plannerAuthority.repair, plannerAuthority.apply], [0, 0, 0]) &&
        same(calls.map(call => call.mode), ['planner', 'coder']) &&
        calls.every(call => call.model === plannerAuthority.model &&
          call.reasoning === plannerAuthority.reasoning),
      `r7 position ${position} identity`);
      const journal = calls.map((call, stageIndex) => {
        const rows = db.prepare('SELECT run_id, stage, record_json, record_hash FROM provider_invocations WHERE run_id=?').all(call.runId);
        gate(rows.length === 1 && rows[0].stage === call.mode &&
          call.mode === ['planner', 'coder'][stageIndex], `r7 position ${position} journal row`);
        const row = rows[0];
        const record = JSON.parse(row.record_json);
        gate(hash(Buffer.from(row.record_json)) === row.record_hash &&
          record.plannedTaskB?.sessionId === R7 &&
          record.plannedTaskB?.observationId === observationId &&
          record.plannedTaskB?.position === position &&
          record.plannedTaskB?.stage === call.mode && record.model === call.model,
        `r7 position ${position} journal binding`);
        return { runId: row.run_id, stage: row.stage, recordHash: row.record_hash,
          state: record.state, failureCode: record.failureCode,
          terminalTurnObserved: record.terminalTurnObserved };
      });
      if (position < 3) gate(cell.classification === 'completed' &&
        result.outcome.status === 'completed' &&
        result.outcome.decision === 'bounded_task_completed' &&
        behavior.status === 'PASS' && result.outcome.behavior === 'PASS' &&
        behavior.infrastructurePass === true && behavior.moduleLoaded === true &&
        behavior.assertionsCompleted === true &&
        ['build', 'typecheck', 'tests'].every(key => behavior.results?.[key]?.passed === true) &&
        ['scope', 'typecheck', 'tests'].every(key => result.outcome.validation[key] === 'PASS') &&
        result.outcome.candidateChangedFiles.length > 0 &&
        journal.every(row => row.state === 'completed' && row.failureCode === null &&
          row.terminalTurnObserved === true), `r7 position ${position} clean PASS`);
      else gate(cell.classification === 'ambiguous_failure' &&
        result.outcome.status === 'stopped' &&
        result.outcome.decision === 'bounded_task_stopped' &&
        result.outcome.candidateChangedFiles.length === 0 &&
        result.outcome.behavior === 'NOT_RUN' && behavior.status === 'NOT_RUN' &&
        journal[0].state === 'completed' && journal[1].state === 'outcome_unknown' &&
        journal[1].failureCode === 'agent_timeout' &&
        journal[1].terminalTurnObserved === false,
      'r7 production timeout and no Candidate');
      observations.push({ sessionId: R7, observationId, runtimeIdentity, position,
        replicate: 'A', variant, taskHash: plannerAuthority.taskHash,
        sourceHead: plannerAuthority.sourceHead, model: plannerAuthority.model,
        reasoning: plannerAuthority.reasoning,
        contextDefinitionHash: hash(bytes(path.join(cellRoot, 'selection.json'))),
        reservationHash: hash(bytes(path.join(sessionRoot, `reservation-${position}.json`))),
        artifactHashes: relativeHashes(cellRoot), journal,
        normalizedOutcome: { status: result.outcome.status, decision: result.outcome.decision,
          behavior: result.outcome.behavior, validation: result.outcome.validation,
          candidateChangedFiles: result.outcome.candidateChangedFiles },
        recordedClassification: cell.classification,
        classification: position === 3 ? 'production_product_timeout' : 'clean_pass',
        replacementEligible: false });
    }
    const r7Rows = journalRows(db, `matrix.${R7}.`);
    gate(r7Rows.length === 6 &&
      r7Rows.every(row => observations.some(item => item.journal.some(ref => ref.runId === row.run_id))) &&
      [4, 5, 6].every(position =>
        !fs.existsSync(path.join(sessionRoot, `reservation-${position}.json`)) &&
        !fs.existsSync(path.join(sessionRoot,
          `${String(position).padStart(2, '0')}-B-${ORDER[position - 1].slice(2)}`))),
    'r7 B suffix already started');
    const frozenFiles = ['task-b-definition.json', 'task-b-calibration.json',
      'task-b-prospective-manifest.json'];
    return { version: 'task-b-r7-retained-prefix/v1', sessionId: R7,
      frozenFileHashes: Object.fromEntries(frozenFiles.map(name =>
        [name, hash(bytes(path.join(HERE, name)))])),
      summaryHash: hash(bytes(summaryFile)), observations,
      untouchedSuffix: [4, 5, 6].map(position => ({ position, replicate: 'B',
        variant: ORDER[position - 1].slice(2), status: 'never_reserved_or_executed_in_r7' })) };
  } finally { db.close(); }
}

/** Verify the committed review against live immutable evidence before any future reservation. */
export function verifyR7RetainedPrefix(options = {}) {
  const review = json(options.reviewPath ?? REVIEW);
  const observed = inspectR7RetainedPrefix(options);
  gate(same(review, observed), 'retained prefix hash or journal state drift');
  return review;
}

/** Prospective authority only. This neither reserves observations nor creates a session. */
export function authorizeTaskBContinuation(sessionId, options = {}) {
  const prefix = verifyR7RetainedPrefix(options);
  const plan = loadTaskBPlan();
  gate(same(plan.order, ORDER) &&
    prefix.observations.every(item => item.taskHash === plan.task.taskHash &&
      item.sourceHead === plan.task.sourceHead && item.model === plan.task.model &&
      item.reasoning === plan.task.reasoning), 'frozen Task B drift');
  gate(typeof sessionId === 'string' &&
    /^task-b-stage1-[a-z0-9-]{8,24}$/.test(sessionId) && !/--|-$/.test(sessionId) &&
    sessionId !== R7, 'fresh explicit continuation session ID required');
  const resultParent = options.resultParent ?? options.root ?? outputParent();
  gate(!fs.existsSync(path.join(resultParent, sessionId)), 'continuation session reuse');
  const journalPath = options.journalPath ?? expectedJournalPath();
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    gate(journalRows(db, `matrix.${sessionId}.`).length === 0,
      'continuation session journal reuse');
    const priorSuffix = db.prepare('SELECT record_json FROM provider_invocations').all()
      .map(row => JSON.parse(row.record_json).plannedTaskB)
      .filter(item => item?.position >= 4 && item.position <= 6 &&
        item.sessionId !== 'task-b-stage1-20260930-r4');
    gate(priorSuffix.length === 0, 'B suffix authority already consumed');
    const suffix = prefix.untouchedSuffix.map(item => ({ ...item, sessionId,
      observationId: `${sessionId}.${item.position}.${item.replicate}.${item.variant}`,
      runtimeIdentity: deriveTaskBRuntimeIdentity({ sessionId, ...item }),
      observationKind: 'original_stage1_untouched_suffix', replacement: false, retry: false }));
    for (const item of suffix) {
      gate(journalRows(db, `matrix.${item.runtimeIdentity}.`).length === 0 &&
        journalRows(db, `matrix.${item.observationId}.`).length === 0,
      'continuation observation reuse');
    }
    const prefixHash = hash(bytes(options.reviewPath ?? REVIEW));
    const authority = { version: 'task-b-stage1-partial-continuation/v1',
      parentSessionId: R7, retainedPrefixReviewHash: prefixHash,
      continuationSessionId: sessionId, taskHash: plan.task.taskHash,
      sourceHead: plan.task.sourceHead, model: plan.task.model,
      reasoning: plan.task.reasoning, policy: { retry: 0, repair: 0, apply: 0 },
      originalPositions: [1, 2, 3, 4, 5, 6],
      authorizedPositions: [4, 5, 6], suffix,
      budget: { maximumObservations: 3, maximumPlannedProviderStageInvocations: 9,
        perObservation: 3 },
      stopPolicy: { candidateOrModelFailure: 'persist_and_continue_if_infrastructure_healthy',
        infrastructureOrAmbiguousFailure: 'stop_immediately' } };
    return { ...authority, authorityHash: hash(Buffer.from(JSON.stringify(authority))) };
  } finally { db.close(); }
}

/** Runtime counter for a separately authorized suffix executor. */
export function createTaskBContinuationBudget(authority) {
  const { authorityHash, ...payload } = authority ?? {};
  gate(authority?.version === 'task-b-stage1-partial-continuation/v1' &&
    authorityHash === hash(Buffer.from(JSON.stringify(payload))) &&
    same(authority.authorizedPositions, [4, 5, 6]) &&
    same(authority.budget, { maximumObservations: 3,
      maximumPlannedProviderStageInvocations: 9, perObservation: 3 }),
  'suffix budget authority');
  const admissible = new Set(authority.suffix.map(item => item.observationId));
  gate(admissible.size === 3 && authority.suffix.every(item => item.position >= 4 &&
    item.position <= 6), 'suffix identities');
  const reserved = new Set();
  const calls = new Map();
  return {
    reserveObservation(identity) {
      gate(admissible.has(identity) && !reserved.has(identity) && reserved.size < 3,
        'unauthorized or duplicate observation');
      reserved.add(identity);
    },
    recordInvocation(identity) {
      const count = calls.get(identity) ?? 0;
      gate(reserved.has(identity) && count < 3 &&
        [...calls.values()].reduce((sum, value) => sum + value, 0) < 9,
      'suffix provider-stage budget');
      calls.set(identity, count + 1);
    },
    snapshot() { return { observations: reserved.size,
      providerStageInvocations: [...calls.values()].reduce((sum, value) => sum + value, 0) }; }
  };
}
