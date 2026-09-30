import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentOutputRedactor } from "./agent-output-redaction.js";
import { readPlannedReplacementReview, readPlannedFinalReplacementReview, readPlannedStage2Review, validatePlannedContextMatrixAuthority } from "./planned-experiment-authority.js";
import type { PlannedExperimentAuthority } from "./planned-experiment-authority.js";
import { validateTaskBInvocationAuthority, readTaskBReplacementReview,
  readTaskBOracleReplacementReview } from "./task-b-invocation-authority.js";
import type { TaskBInvocationAuthority } from "./task-b-invocation-authority.js";
import type { AgentProviderFailureClass, AgentWorkerOutcome } from "./agent-adapter.js";

/** One transactional authority for a provider invocation, never a retry queue. */
export const DURABLE_INVOCATION_JOURNAL_VERSION = "durable-invocation-journal/v3" as const;
export type InvocationState = "prepared" | "started" | "completed" | "failed" | "outcome_unknown";
export type InvocationStage = "discovery" | "planner" | "coder" | "repair" | "baseline";
export type InvocationRetryDecision = Readonly<{
  decisionId: string;
  supersedesRunId: string;
  newRunId: string;
  stage: InvocationStage;
  taskHash: string;
  model: string;
}>;
export type InvocationCrashRecoveryAuthority = Readonly<{
  invocationKey: string;
  recoveryId: string;
  ownerPid: number;
}>;
export type InvocationIdentity = Readonly<{
  runId: string;
  stage: InvocationStage;
  task: string;
  model: string;
  deadlineAt: number;
  retryDecision?: InvocationRetryDecision;
  plannedExperiment?: PlannedExperimentAuthority;
  plannedTaskB?: TaskBInvocationAuthority;
  sourceRepositoryPath?: string;
  reasoningEffort?: string;
}>;
export type InvocationRecord = Readonly<{
  version: typeof DURABLE_INVOCATION_JOURNAL_VERSION;
  invocationKey: string;
  runId: string;
  stage: InvocationStage;
  taskHash: string;
  model: string;
  state: InvocationState;
  preparedAt: number;
  startedAt: number | null;
  deadlineAt: number;
  abortRequestedAt: number | null;
  workerExitedAt: number | null;
  exitSignal: string | null;
  terminalAt: number | null;
  sessionEvidence: "unknown" | "present" | "absent";
  invocationOccurred: boolean | null;
  failureCode: string | null;
  failureDetail: string | null;
  providerFailureClass?: AgentProviderFailureClass;
  providerHttpStatus?: number | null;
  workerOutcome?: AgentWorkerOutcome;
  workerExitCode?: number | null;
  terminalTurnObserved?: boolean | null;
  retryDecisionId: string | null;
  supersedesRunId: string | null;
  recoveryId?: string;
  ownerPid?: number;
  plannedExperiment?: PlannedExperimentAuthority;
  plannedTaskB?: TaskBInvocationAuthority;
  workerDiagnostic?: Readonly<Record<string, unknown>> | null;
}>;

export class InvocationJournalError extends Error {
  constructor(readonly code: "invocation_replay_forbidden" | "invocation_journal_unavailable" |
    "invocation_journal_inside_source_repository", message: string) {
    super(message);
    this.name = "InvocationJournalError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const STAGES: readonly InvocationStage[] = ["discovery", "planner", "coder", "repair", "baseline"];
const TERMINAL: readonly InvocationState[] = ["completed", "failed", "outcome_unknown"];
function replacementPriorValid(records: readonly InvocationRecord[], authority: PlannedExperimentAuthority): boolean {
  if (authority.replacementAttemptIndex !== 2 || !authority.replacesSessionId) return false;
  const review = readPlannedReplacementReview(authority.manifestPath);
  const prior = records.filter((record) =>
    record.plannedExperiment?.sessionId === review.failedSessionId);
  return prior.length === 1 && prior[0].stage === "planner" &&
    prior[0].state === "completed" && prior[0].runId === review.failedPlannerRunId &&
    prior[0].plannedExperiment?.cellHash === review.failedCellHash &&
    prior[0].plannedExperiment?.harnessHead === review.failedHarnessHead &&
    prior[0].plannedExperiment?.manifestHash === authority.manifestHash &&
    prior[0].plannedExperiment?.sourceHead === authority.sourceHead &&
    records.every((record) => record.plannedExperiment?.planSlotHash !==
      prior[0].plannedExperiment?.planSlotHash ||
      record.plannedExperiment?.sessionId === review.failedSessionId ||
      record.plannedExperiment?.sessionId === authority.sessionId);
}
function finalReplacementPriorValid(records: readonly InvocationRecord[], authority: PlannedExperimentAuthority): boolean {
  if (authority.replacementAttemptIndex !== 3 || !authority.replacesSessionId) return false;
  const review = readPlannedFinalReplacementReview(authority.manifestPath);
  const prior = records.filter(record => record.plannedExperiment?.sessionId === review.priorSessionId);
  const original = readPlannedReplacementReview(authority.manifestPath);
  const first = records.filter(record => record.plannedExperiment?.sessionId === original.failedSessionId);
  return authority.replacesSessionId === review.priorSessionId && prior.length === 2 &&
    first.length === 1 && first[0].stage === "planner" && first[0].state === "completed" &&
    first[0].runId === original.failedPlannerRunId &&
    prior.every(record => record.state === "completed" &&
      record.plannedExperiment?.replacementAttemptIndex === 2 &&
      record.plannedExperiment?.cellHash === review.priorCellHash &&
      record.plannedExperiment?.sessionHash === review.priorSessionHash &&
      record.plannedExperiment?.harnessHead === review.priorHarnessHead &&
      record.plannedExperiment?.manifestHash === authority.manifestHash &&
      record.plannedExperiment?.sourceHead === authority.sourceHead) &&
    prior.some(record => record.stage === "planner" && record.runId === review.priorPlannerRunId) &&
    prior.some(record => record.stage === "coder" && record.runId === review.priorCoderRunId) &&
    records.every(record => record.plannedExperiment?.planSlotHash !== authority.planSlotHash ||
      [original.failedSessionId, review.priorSessionId, authority.sessionId]
        .includes(record.plannedExperiment.sessionId));
}
function stage2PriorValid(records: readonly InvocationRecord[], authority: PlannedExperimentAuthority): boolean {
  if (authority.repetitionIndex !== 2 || authority.replacementAttemptIndex !== undefined) return false;
  const review = readPlannedStage2Review(authority.manifestPath);
  const prior = records.filter(record => record.plannedExperiment?.sessionId === review.priorStage1SessionId);
  if (prior.length !== 6 || authority.priorStage1SessionId !== review.priorStage1SessionId) return false;
  return (["minimal", "current", "expanded"] as const).every(variant => {
    const cell = review.stage1Cells[variant];
    const rows = prior.filter(record => record.plannedExperiment?.variant === variant);
    return rows.length === 2 && rows.every(record => record.state === "completed" &&
      record.plannedExperiment?.repetitionIndex === 1 &&
      record.plannedExperiment?.cellHash === cell.cellHash &&
      record.plannedExperiment?.sessionHash === review.priorStage1SessionHash &&
      record.plannedExperiment?.harnessHead === review.priorStage1HarnessHead &&
      record.plannedExperiment?.manifestHash === authority.manifestHash &&
      record.plannedExperiment?.sourceHead === authority.sourceHead) &&
      rows.some(record => record.stage === "planner" && record.runId === cell.plannerRunId) &&
      rows.some(record => record.stage === "coder" && record.runId === cell.coderRunId);
  });
}
const SAFE_DIAGNOSTIC_CODES = new Set([
  "agent_command_budget_exceeded", "agent_event_budget_exceeded",
  "agent_model_call_budget_exceeded", "agent_output_limit", "agent_protocol_invalid",
  "agent_provider_call_budget_exceeded", "agent_repair_budget_exceeded", "agent_timeout",
  "authentication_failed", "codex_aborted", "codex_command_timing_partial",
  "codex_command_timing_unavailable", "codex_event_ignored", "codex_item_ignored",
  "codex_item_pending_details", "codex_partial_stream", "codex_provider_message_redacted",
  "codex_usage_unavailable", "invocation_journal_unavailable", "invocation_replay_forbidden",
  "provider_outcome_ambiguous", "provider_overloaded", "provider_stream_error_unknown",
  "usage_limit_exceeded", "worker_termination_failed"
]);
const SAFE_FAILURE_CODES = new Set([...SAFE_DIAGNOSTIC_CODES, "process_interrupted"]);
function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function safeCode(value: string | null): string | null {
  return typeof value === "string" && SAFE_FAILURE_CODES.has(value) ? value : null;
}
function safeDiagnosticCodes(values: readonly string[] | undefined): string | null {
  if (!values) return null;
  const codes = [...new Set(values.filter((value) => SAFE_DIAGNOSTIC_CODES.has(value)))].slice(0, 32);
  return codes.length === 0 ? null : codes.join(";");
}
function ownerStillAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function safeWorkerDiagnostic(value: Readonly<Record<string, unknown>> | null | undefined):
  Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  const fallback = { version: "worker-failure-diagnostic/v1", serializationTruncated: true };
  const eventTypes = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed",
    "error", "item.started", "item.updated", "item.completed"]);
  const parserStatuses = new Set(["completed", "failed", "partial", "aborted", "agent_protocol_invalid"]);
  const formats = new Set(["empty", "unstructured", "worker_error_envelope"]);
  const errorNames = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError"]);
  const nonnegative = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0;
  const pathField = (entry: unknown) => typeof entry === "string" && isAbsolute(entry) &&
    entry.length <= 256 && !/[\r\n\0]/.test(entry);
  if (value.version !== "worker-failure-diagnostic/v1" || !pathField(value.executable) ||
      !pathField(value.cwd) || !Array.isArray(value.args) || value.args.length > 4 ||
      !value.args.every(pathField) || typeof value.argsTruncated !== "boolean" ||
      !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
      !(value.exitSignal === null || typeof value.exitSignal === "string" && /^SIG[A-Z0-9]+$/.test(value.exitSignal)) ||
      typeof value.stdoutEmpty !== "boolean" || typeof value.stderrEmpty !== "boolean" ||
      !["", "[UNSAFE_STDERR_CONTENT_OMITTED]"].includes(value.stderrExcerpt as string) ||
      !formats.has(value.stderrFormat as string) ||
      !(value.workerErrorName === null || errorNames.has(value.workerErrorName as string)) ||
      !(value.workerErrorStatus === null || Number.isSafeInteger(value.workerErrorStatus) &&
        (value.workerErrorStatus as number) >= 100 && (value.workerErrorStatus as number) <= 599) ||
      typeof value.stderrTruncated !== "boolean" || !nonnegative(value.stdoutLineCount) ||
      !nonnegative(value.recognizedEventCount) || !nonnegative(value.unknownEventCount) ||
      !Array.isArray(value.eventTypes) || !value.eventTypes.every((entry) => eventTypes.has(entry)) ||
      typeof value.threadStarted !== "boolean" || typeof value.turnStarted !== "boolean" ||
      typeof value.turnCompleted !== "boolean" || typeof value.turnFailed !== "boolean" ||
      typeof value.errorEvent !== "boolean" || !nonnegative(value.malformedLineCount) ||
      !(value.lastRecognizedEventType === null || eventTypes.has(value.lastRecognizedEventType as string)) ||
      !parserStatuses.has(value.parserStatus as string) ||
      typeof value.terminalTurnObserved !== "boolean" ||
      typeof value.serializationTruncated !== "boolean") return fallback;
  const fields = ["version", "executable", "args", "argsTruncated", "cwd", "exitCode", "exitSignal",
    "stdoutEmpty", "stderrEmpty", "stderrExcerpt", "stderrFormat", "workerErrorName",
    "workerErrorStatus", "stderrTruncated", "stdoutLineCount", "recognizedEventCount",
    "unknownEventCount", "eventTypes", "threadStarted", "turnStarted", "turnCompleted",
    "turnFailed", "errorEvent", "malformedLineCount", "lastRecognizedEventType",
    "parserStatus", "terminalTurnObserved", "serializationTruncated"];
  const selected = Object.fromEntries(fields.map((field) => [field, value[field]]));
  const sanitized = createAgentOutputRedactor().redactValue(selected) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(sanitized)) <= 4_096 ? sanitized : fallback;
}
function assertIdentity(input: InvocationIdentity): void {
  if (!ID.test(input.runId) || !STAGES.includes(input.stage) || !MODEL.test(input.model) ||
    typeof input.task !== "string" || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0) {
    throw new InvocationJournalError("invocation_journal_unavailable", "Invalid provider invocation identity.");
  }
  if (input.retryDecision !== undefined &&
      (!ID.test(input.retryDecision.decisionId) || !ID.test(input.retryDecision.supersedesRunId) ||
       !ID.test(input.retryDecision.newRunId) || !HASH.test(input.retryDecision.taskHash) ||
       !STAGES.includes(input.retryDecision.stage) || !MODEL.test(input.retryDecision.model) ||
       input.retryDecision.supersedesRunId === input.runId ||
       input.retryDecision.newRunId !== input.runId ||
       input.retryDecision.stage !== input.stage ||
       input.retryDecision.model !== input.model ||
       input.retryDecision.taskHash !== hash(input.task))) {
    throw new InvocationJournalError("invocation_replay_forbidden", "Invalid explicit invocation retry decision.");
  }
  if (input.plannedExperiment !== undefined) {
    if (input.retryDecision !== undefined || !input.sourceRepositoryPath ||
        !input.reasoningEffort) throw new InvocationJournalError(
      "invocation_replay_forbidden", "Planned experiment cannot be a retry or omit source/reasoning.");
    try {
      validatePlannedContextMatrixAuthority(input.plannedExperiment, {
        sourceRepositoryPath: input.sourceRepositoryPath, model: input.model,
        reasoning: input.reasoningEffort, stage: input.stage,
        task: input.task,
        retryDecision: input.retryDecision });
    } catch { throw new InvocationJournalError(
      "invocation_replay_forbidden", "Planned experiment authority is invalid."); }
  }
  if (input.plannedTaskB !== undefined) {
    if (input.plannedExperiment !== undefined || input.retryDecision !== undefined ||
        !input.sourceRepositoryPath || !input.reasoningEffort)
      throw new InvocationJournalError("invocation_replay_forbidden",
        "Task B planned observation cannot be a retry or omit source/reasoning.");
    try { validateTaskBInvocationAuthority(input.plannedTaskB, {
      sourceRepositoryPath: input.sourceRepositoryPath, runId: input.runId,
      stage: input.stage, model: input.model, reasoning: input.reasoningEffort,
      task: input.task, retryDecision: input.retryDecision
    }); } catch { throw new InvocationJournalError("invocation_replay_forbidden",
      "Task B planned authority is invalid."); }
  }
}
function keyOf(input: Pick<InvocationIdentity, "runId" | "stage">): string {
  return hash(JSON.stringify([input.runId, input.stage]));
}
function checkedRow(row: unknown, expectedKey: string): InvocationRecord {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("Invalid journal row.");
  const value = row as { record_json?: unknown; record_hash?: unknown };
  if (typeof value.record_json !== "string" || typeof value.record_hash !== "string" ||
      hash(value.record_json) !== value.record_hash) throw Error("Journal record integrity mismatch.");
  const record: unknown = JSON.parse(value.record_json);
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      (record as InvocationRecord).version !== DURABLE_INVOCATION_JOURNAL_VERSION ||
      (record as InvocationRecord).invocationKey !== expectedKey ||
      !["prepared", "started", ...TERMINAL].includes((record as InvocationRecord).state)) {
    throw Error("Journal record version or identity mismatch.");
  }
  return Object.freeze(record as InvocationRecord);
}

export type TaskBSlotStatus = "fresh_planned_observation" | "reviewed_replacement_required" |
  "already_completed" | "already_consumed_not_replaceable" | "authority_conflict";
function taskBAdmissibility(db: DatabaseSync, authority: TaskBInvocationAuthority,
  stage: InvocationStage, preflight: boolean, journalPath?: string):
  { status: TaskBSlotStatus; authorized: boolean } {
  const conflict = { status: "authority_conflict" as const, authorized: false };
  if (!["planner", "coder"].includes(stage) || stage !== authority.stage ||
      !authority.replacement || !journalPath) return conflict;
  const rows = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
    .all().map(row => checkedRow(row, (row as { invocation_key: string }).invocation_key));
  const sameSlot = rows.filter(row => row.plannedTaskB?.slotHash === authority.slotHash);
  const permittedHistory = new Set(["task-b-stage1-20260930-r4",
    ...(authority.position === 1 ? ["task-b-stage1-20260929-r2"] : [])]);
  const unrelated = sameSlot.filter(row =>
    row.plannedTaskB?.sessionId !== authority.sessionId &&
    !permittedHistory.has(row.plannedTaskB?.sessionId ?? ""));
  if (unrelated.length > 0) {
    const complete = unrelated.some(row => row.stage === "coder" && row.state === "completed");
    return { status: complete ? "already_completed" : "already_consumed_not_replaceable",
      authorized: false };
  }
  const ownPlanner = sameSlot.find(row => row.plannedTaskB?.sessionId === authority.sessionId &&
    row.stage === "planner");
  const ownCoder = sameSlot.find(row => row.plannedTaskB?.sessionId === authority.sessionId &&
    row.stage === "coder");
  if (stage === "planner" && ownPlanner || stage === "coder" && (ownCoder || !preflight &&
      (!ownPlanner || ownPlanner.state !== "completed")))
    return { status: "already_consumed_not_replaceable", authorized: false };
  if (rows.some(row => row.plannedTaskB?.sessionId === authority.sessionId &&
      row.plannedTaskB?.sessionHash !== authority.sessionHash)) return conflict;
  try {
    const review = readTaskBOracleReplacementReview(authority.harnessRoot);
    const reviewed = review.slots[authority.position - 1];
    if (!reviewed || authority.replacement.historicalObservationId !== reviewed.observationId ||
        authority.replacement.replacementOrdinal !== reviewed.replacementOrdinal ||
        authority.replacement.originalPlannerRunId !== reviewed.planner.runId ||
        authority.replacement.originalCoderRunId !== reviewed.coder.runId ||
        authority.replacement.originalPlannerRecordHash !== reviewed.planner.recordHash ||
        authority.replacement.originalCoderRecordHash !== reviewed.coder.recordHash) return conflict;
    const historyRoot = resolve(dirname(journalPath), "live-runs/context-token-matrix-v1");
    const r4 = resolve(historyRoot, review.historicalSessionId);
    const summaryBytes = readFileSync(resolve(r4, "stage1-summary.json"));
    const summary = JSON.parse(summaryBytes.toString("utf8"));
    if (hash(summaryBytes.toString("utf8")) !== review.stage1SummarySha256 ||
        summary.sessionId !== review.historicalSessionId ||
        summary.providerModelCalls !== 12 || summary.budget?.providerStageInvocations !== 12 ||
        summary.stop !== null || summary.observations?.length !== 6) return conflict;
    for (const item of review.slots) {
      const cell = resolve(r4, `${String(item.position).padStart(2, "0")}-${item.replicate}-${item.variant}`);
      const reservationBytes = readFileSync(resolve(r4, `reservation-${item.position}.json`));
      const behaviorBytes = readFileSync(resolve(cell, "behavior-check.json"));
      const cellBytes = readFileSync(resolve(cell, "cell-summary.json"));
      if (hash(reservationBytes.toString("utf8")) !== item.reservationSha256 ||
          hash(behaviorBytes.toString("utf8")) !== item.behaviorCheckSha256 ||
          hash(cellBytes.toString("utf8")) !== item.cellSummarySha256) return conflict;
      const reservation = JSON.parse(reservationBytes.toString("utf8"));
      const behavior = JSON.parse(behaviorBytes.toString("utf8"));
      const cellSummary = JSON.parse(cellBytes.toString("utf8"));
      if (reservation.observationId !== item.observationId ||
          reservation.position !== item.position || reservation.replicate !== item.replicate ||
          reservation.variant !== item.variant ||
          reservation.taskBPlannerAuthority?.slotHash !== authority.slotHash &&
            item.position === authority.position ||
          cellSummary.observationId !== item.observationId ||
          cellSummary.classification !== "candidate_validation_failure" ||
          cellSummary.providerStageInvocations !== 2 ||
          behavior.status !== "FAIL" ||
          !["build", "typecheck", "tests"].every(name => behavior.results?.[name]?.passed === true) ||
          behavior.results?.behavior?.exitCode !== 1 ||
          !/dist\/packages\/integrations\/src\/codex-event-parser\.js/.test(
            behavior.results?.behavior?.stderrTail ?? "") ||
          /AssertionError/.test(behavior.results?.behavior?.stderrTail ?? "")) return conflict;
      if (item.position === authority.position &&
          (reservation.taskBPlannerAuthority?.observationHash !==
            authority.replacement.originalObservationHash ||
           reservation.taskBPlannerAuthority?.slotHash !== authority.replacement.originalSlotHash))
        return conflict;
      for (const [expectedStage, reference] of [["planner", item.planner],
          ["coder", item.coder]] as const) {
        const selected = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE run_id = ?")
          .get(reference.runId) as { invocation_key: string; record_json: string; record_hash: string } | undefined;
        if (!selected || selected.record_hash !== reference.recordHash) return conflict;
        const row = checkedRow(selected, selected.invocation_key);
        if (row.stage !== expectedStage || row.state !== "completed" ||
            row.invocationOccurred !== true || row.model !== authority.model ||
            row.plannedTaskB?.sessionId !== review.historicalSessionId ||
            row.plannedTaskB?.position !== item.position ||
            row.plannedTaskB?.stage !== expectedStage ||
            row.plannedTaskB?.observationId !== item.observationId) return conflict;
      }
    }
    if (authority.position === 1) {
      const prior = readTaskBReplacementReview(authority.harnessRoot);
      const r2 = resolve(historyRoot, prior.historicalSessionId);
      const r2Summary = readFileSync(resolve(r2, "stage1-summary.json"));
      const r2Reservation = readFileSync(resolve(r2, "reservation-1.json"));
      if (hash(r2Summary.toString("utf8")) !== prior.evidence.stage1SummarySha256 ||
          hash(r2Reservation.toString("utf8")) !== prior.evidence.reservationSha256 ||
          JSON.parse(r2Summary.toString("utf8")).stop !==
            "infrastructure_or_ambiguous: task_b_authority_invalid: Candidate path alias") return conflict;
      for (const [runId, recordHash] of [[prior.evidence.plannerRunId,
          prior.evidence.plannerRecordHash], [prior.evidence.coderRunId,
          prior.evidence.coderRecordHash]]) {
        const selected = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE run_id = ?")
          .get(runId) as { invocation_key: string; record_json: string; record_hash: string } | undefined;
        if (!selected || selected.record_hash !== recordHash) return conflict;
        const row = checkedRow(selected, selected.invocation_key);
        if (row.state !== "completed" || row.invocationOccurred !== true) return conflict;
      }
      for (const stopped of prior.zeroRowStoppedSessions) {
        const stoppedRoot = resolve(historyRoot, stopped.sessionId);
        const stoppedSummary = readFileSync(resolve(stoppedRoot, "stage1-summary.json"));
        const stoppedReservation = readFileSync(resolve(stoppedRoot, "reservation-1.json"));
        if (hash(stoppedSummary.toString("utf8")) !== stopped.stage1SummarySha256 ||
            hash(stoppedReservation.toString("utf8")) !== stopped.reservationSha256 ||
            db.prepare("SELECT 1 FROM provider_invocations WHERE run_id LIKE ?")
              .get(`matrix.${stopped.sessionId}.%`)) return conflict;
      }
    }
    return { status: "reviewed_replacement_required", authorized: true };
  } catch { return conflict; }
}
/** Read-only Task B planner authority inspection; never reserves a journal row. */
export function inspectTaskBExperimentJournal(file: string, cells: readonly Readonly<{
  authority: TaskBInvocationAuthority; sourceRepositoryPath: string;
  runId: string; task: string;
}>[]): readonly Readonly<{ observationId: string; status: TaskBSlotStatus;
  authorized: boolean; plannerTaskHash: string; coderFutureAdmissible: boolean }> [] {
  if (!isAbsolute(file) || !existsSync(file) || lstatSync(file).isSymbolicLink())
    throw new InvocationJournalError("invocation_journal_unavailable", "Existing journal is required.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.freeze(cells.map(cell => {
      validateTaskBInvocationAuthority(cell.authority, {
        sourceRepositoryPath: cell.sourceRepositoryPath, runId: cell.runId,
        stage: "planner", model: cell.authority.model,
        reasoning: cell.authority.reasoning, task: cell.task
      });
      const verdict = taskBAdmissibility(db, cell.authority, "planner", true, file);
      const coderFutureAdmissible = verdict.authorized &&
        !db.prepare("SELECT 1 FROM provider_invocations WHERE run_id LIKE ?")
          .get(`matrix.${cell.authority.runtimeIdentity}.%coder.%`);
      return Object.freeze({ observationId: cell.authority.observationId,
        status: verdict.status, authorized: verdict.authorized,
        plannerTaskHash: hash(cell.task), coderFutureAdmissible });
    }));
  } finally { db.close(); }
}

export function createDurableInvocationJournal(file: string, now: () => number = Date.now) {
  if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0")) {
    throw new InvocationJournalError("invocation_journal_unavailable", "Journal path must be absolute.");
  }
  const path = resolve(file);
  const parent = dirname(path);
  const ownedReservations = new Set<string>();
  const openDatabase = (): DatabaseSync => {
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // Never follow a symlink at the database path. The directory is resolved once.
      realpathSync(parent);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe journal file.");
      }
      const db = new DatabaseSync(path);
      try {
        chmodSync(path, 0o600);
        db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        db.exec(`CREATE TABLE IF NOT EXISTS provider_invocations (
          invocation_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          UNIQUE(run_id, stage)
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS invocation_retry_authorizations (
          decision_id TEXT PRIMARY KEY,
          supersedes_run_id TEXT NOT NULL,
          new_run_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          task_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          consumed_at INTEGER,
          UNIQUE(supersedes_run_id, stage)
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS planned_experiment_replacements (
          failed_session_id TEXT PRIMARY KEY,
          replacement_session_id TEXT NOT NULL UNIQUE,
          replacement_session_hash TEXT NOT NULL,
          review_hash TEXT NOT NULL,
          harness_head TEXT NOT NULL,
          authorized_at INTEGER NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS planned_experiment_final_replacements (
          prior_session_id TEXT PRIMARY KEY,
          final_session_id TEXT NOT NULL UNIQUE,
          final_session_hash TEXT NOT NULL,
          review_hash TEXT NOT NULL,
          harness_head TEXT NOT NULL,
          authorized_at INTEGER NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS planned_experiment_stage2_authorizations (
          prior_stage1_session_id TEXT PRIMARY KEY,
          stage2_session_id TEXT NOT NULL UNIQUE,
          stage2_session_hash TEXT NOT NULL,
          review_hash TEXT NOT NULL,
          harness_head TEXT NOT NULL,
          authorized_at INTEGER NOT NULL
        )`);
      } catch (error) { db.close(); throw error; }
      return db;
    } catch {
      throw new InvocationJournalError("invocation_journal_unavailable", "Durable provider journal could not be opened.");
    }
  };
  const transaction = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = openDatabase();
    try {
      db.exec("BEGIN IMMEDIATE");
      try { const value = fn(db); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError("invocation_journal_unavailable", "Durable provider journal transaction failed.");
    } finally { db.close(); }
  };
  const get = (db: DatabaseSync, key: string): InvocationRecord | null => {
    const row = db.prepare("SELECT record_json, record_hash FROM provider_invocations WHERE invocation_key = ?").get(key);
    return row ? checkedRow(row, key) : null;
  };
  const store = (db: DatabaseSync, record: InvocationRecord): void => {
    const json = JSON.stringify(record);
    const outcome = db.prepare("UPDATE provider_invocations SET record_json = ?, record_hash = ? WHERE invocation_key = ?")
      .run(json, hash(json), record.invocationKey);
    if (outcome.changes !== 1) throw Error("Journal update lost its reservation.");
  };
  const transition = (key: string, expected: readonly InvocationState[], mutate: (row: InvocationRecord) => InvocationRecord): InvocationRecord =>
    transaction((db) => {
      const row = get(db, key);
      if (!row || !expected.includes(row.state)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Provider invocation cannot transition or be replayed.");
      const next = Object.freeze(mutate(row));
      store(db, next);
      return next;
    });
  return Object.freeze({
    authorizePlannedStage2(authority: PlannedExperimentAuthority,
      sourceRepositoryPath: string): void {
      try { validatePlannedContextMatrixAuthority(authority, {
        sourceRepositoryPath, model: authority.model, reasoning: authority.reasoning,
        stage: "planner" }); }
      catch { throw new InvocationJournalError("invocation_replay_forbidden", "Invalid Stage 2 authority."); }
      transaction(db => {
        const rows = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
          .all().map(row => checkedRow(row, (row as { invocation_key: string }).invocation_key));
        if (authority.variant !== "minimal" || !stage2PriorValid(rows, authority) ||
            rows.some(row => row.plannedExperiment?.sessionId === authority.sessionId ||
              row.plannedExperiment?.repetitionIndex === 2) ||
            db.prepare(`SELECT 1 FROM planned_experiment_stage2_authorizations
              WHERE prior_stage1_session_id = ? OR stage2_session_id = ?`)
              .get(authority.priorStage1SessionId ?? "", authority.sessionId))
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Stage 2 requires the reviewed valid Stage 1 and one fresh session.");
        db.prepare(`INSERT INTO planned_experiment_stage2_authorizations
          (prior_stage1_session_id, stage2_session_id, stage2_session_hash, review_hash, harness_head, authorized_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(authority.priorStage1SessionId ?? "", authority.sessionId,
            authority.sessionHash, authority.stage2ReviewHash ?? "", authority.harnessHead, now());
      });
    },
    authorizePlannedFinalReplacement(authority: PlannedExperimentAuthority,
      sourceRepositoryPath: string): void {
      try { validatePlannedContextMatrixAuthority(authority, {
        sourceRepositoryPath, model: authority.model, reasoning: authority.reasoning,
        stage: "planner" }); }
      catch { throw new InvocationJournalError("invocation_replay_forbidden", "Invalid final replacement authority."); }
      transaction(db => {
        const rows = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
          .all().map(row => checkedRow(row, (row as { invocation_key: string }).invocation_key));
        const original = readPlannedReplacementReview(authority.manifestPath);
        const finalReview = readPlannedFinalReplacementReview(authority.manifestPath);
        const priorAuthorization = db.prepare(`SELECT * FROM planned_experiment_replacements
          WHERE replacement_session_id = ?`).get(authority.replacesSessionId ?? "") as Record<string, unknown> | undefined;
        if (authority.variant !== "minimal" || !finalReplacementPriorValid(rows, authority) ||
            priorAuthorization?.failed_session_id !== original.failedSessionId ||
            priorAuthorization?.replacement_session_hash !== finalReview.priorSessionHash ||
            priorAuthorization?.review_hash !== rows.find(row =>
              row.plannedExperiment?.sessionId === finalReview.priorSessionId)?.plannedExperiment?.replacementReviewHash ||
            priorAuthorization?.harness_head !== finalReview.priorHarnessHead ||
            rows.some(row => row.plannedExperiment?.sessionId === authority.sessionId) ||
            db.prepare(`SELECT 1 FROM planned_experiment_final_replacements
              WHERE prior_session_id = ? OR final_session_id = ?`)
              .get(authority.replacesSessionId ?? "", authority.sessionId))
          throw new InvocationJournalError("invocation_replay_forbidden", "Final replacement requires the exact reviewed prior sessions.");
        db.prepare(`INSERT INTO planned_experiment_final_replacements
          (prior_session_id, final_session_id, final_session_hash, review_hash, harness_head, authorized_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(authority.replacesSessionId ?? "", authority.sessionId,
            authority.sessionHash, authority.replacementReviewHash ?? "", authority.harnessHead, now());
      });
    },
    authorizePlannedReplacement(authority: PlannedExperimentAuthority,
      sourceRepositoryPath: string): void {
      try { validatePlannedContextMatrixAuthority(authority, {
        sourceRepositoryPath, model: authority.model, reasoning: authority.reasoning,
        stage: "planner" }); }
      catch { throw new InvocationJournalError("invocation_replay_forbidden",
        "Invalid replacement authority."); }
      transaction((db) => {
        const rows = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
          .all().map((row) => checkedRow(row, (row as { invocation_key: string }).invocation_key));
        if (!replacementPriorValid(rows, authority) ||
            rows.some((row) => row.plannedExperiment?.sessionId === authority.sessionId) ||
            db.prepare("SELECT 1 FROM planned_experiment_replacements WHERE failed_session_id = ? OR replacement_session_id = ?")
              .get(authority.replacesSessionId ?? "", authority.sessionId))
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Replacement requires one reviewed infrastructure-invalidated prior session.");
        db.prepare(`INSERT INTO planned_experiment_replacements
          (failed_session_id, replacement_session_id, replacement_session_hash, review_hash, harness_head, authorized_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(authority.replacesSessionId ?? "", authority.sessionId,
            authority.sessionHash, authority.replacementReviewHash ?? "", authority.harnessHead, now());
      });
    },
    authorizeRetry(decision: InvocationRetryDecision): void {
      if (!ID.test(decision.decisionId) || !ID.test(decision.supersedesRunId) ||
          !ID.test(decision.newRunId) || decision.newRunId === decision.supersedesRunId ||
          !STAGES.includes(decision.stage) || !HASH.test(decision.taskHash) ||
          !MODEL.test(decision.model)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Invalid explicit retry authorization.");
      transaction((db) => {
        const prior = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE run_id = ? AND stage = ?")
          .get(decision.supersedesRunId, decision.stage) as { invocation_key: string } | undefined;
        const record = prior ? checkedRow(prior, prior.invocation_key) : null;
        if (!record || record.plannedExperiment !== undefined || record.state !== "outcome_unknown" ||
            record.taskHash !== decision.taskHash || record.model !== decision.model) {
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Retry authorization must match a persisted ambiguous invocation.");
        }
        const inserted = db.prepare(`INSERT OR IGNORE INTO invocation_retry_authorizations
          (decision_id, supersedes_run_id, new_run_id, stage, task_hash, model, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
          decision.decisionId, decision.supersedesRunId, decision.newRunId,
          decision.stage, decision.taskHash, decision.model);
        if (inserted.changes !== 1) throw new InvocationJournalError(
          "invocation_replay_forbidden", "Retry authorization already exists.");
      });
    },
    reserve(input: InvocationIdentity): InvocationRecord {
      assertIdentity(input);
      const reservation = transaction((db) => {
        const key = keyOf(input);
        const taskHash = hash(input.task);
        const current = get(db, key);
        if (current) {
          // A losing claimant never owns this reservation and must not change it.
          // Interrupted attempts are made terminal only by explicit recovery.
          return null;
        }
        const prior = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations WHERE stage = ?")
          .all(input.stage)
          .map((row) => checkedRow(row, (row as { invocation_key: string }).invocation_key))
          .filter((record) => record.taskHash === taskHash && record.runId !== input.runId);
        if (input.plannedTaskB !== undefined) {
          const verdict = taskBAdmissibility(db, input.plannedTaskB, input.stage, false, path);
          if (!verdict.authorized) throw new InvocationJournalError("invocation_replay_forbidden",
            `Task B planned observation unavailable: ${verdict.status}.`);
        } else if (input.plannedExperiment !== undefined) {
          const planned = input.plannedExperiment;
          const allPlanned = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
            .all().map((row) => checkedRow(row, (row as { invocation_key: string }).invocation_key))
            .filter((record) => record.plannedExperiment !== undefined);
          const replacement = planned.replacementAttemptIndex === 2;
          const finalReplacement = planned.replacementAttemptIndex === 3;
          const stage2 = planned.repetitionIndex === 2;
          const replacementRow = replacement ? db.prepare(`SELECT * FROM planned_experiment_replacements
            WHERE replacement_session_id = ?`).get(planned.sessionId) as Record<string, unknown> | undefined : null;
          const finalRow = finalReplacement ? db.prepare(`SELECT * FROM planned_experiment_final_replacements
            WHERE final_session_id = ?`).get(planned.sessionId) as Record<string, unknown> | undefined : null;
          const stage2Row = stage2 ? db.prepare(`SELECT * FROM planned_experiment_stage2_authorizations
            WHERE stage2_session_id = ?`).get(planned.sessionId) as Record<string, unknown> | undefined : null;
          if ((replacement && (!replacementRow ||
                replacementRow.failed_session_id !== planned.replacesSessionId ||
                replacementRow.replacement_session_hash !== planned.sessionHash ||
                replacementRow.review_hash !== planned.replacementReviewHash ||
                replacementRow.harness_head !== planned.harnessHead ||
                !replacementPriorValid(allPlanned, planned))) ||
              (finalReplacement && (!finalRow ||
                finalRow.prior_session_id !== planned.replacesSessionId ||
                finalRow.final_session_hash !== planned.sessionHash ||
                finalRow.review_hash !== planned.replacementReviewHash ||
                finalRow.harness_head !== planned.harnessHead ||
                !finalReplacementPriorValid(allPlanned, planned))) ||
              (stage2 && (!stage2Row ||
                stage2Row.prior_stage1_session_id !== planned.priorStage1SessionId ||
                stage2Row.stage2_session_hash !== planned.sessionHash ||
                stage2Row.review_hash !== planned.stage2ReviewHash ||
                stage2Row.harness_head !== planned.harnessHead ||
                !stage2PriorValid(allPlanned, planned))) ||
              allPlanned.some((record) => record.stage === input.stage &&
                record.plannedExperiment?.planSlotHash === planned.planSlotHash &&
                !(replacement && record.plannedExperiment?.sessionId === planned.replacesSessionId) &&
                !(finalReplacement && [planned.replacesSessionId,
                  readPlannedReplacementReview(planned.manifestPath).failedSessionId]
                    .includes(record.plannedExperiment?.sessionId ?? ""))) ||
              allPlanned.some((record) => record.plannedExperiment?.sessionId === planned.sessionId &&
                record.plannedExperiment?.sessionHash !== planned.sessionHash))
            throw new InvocationJournalError("invocation_replay_forbidden",
              "Planned experiment cell or session authority is already consumed.");
          if (input.stage === "coder" && !allPlanned.some((record) =>
                record.stage === "planner" && record.state === "completed" &&
                record.plannedExperiment?.cellHash === planned.cellHash &&
                record.plannedExperiment?.sessionId === planned.sessionId))
            throw new InvocationJournalError("invocation_replay_forbidden",
              "Coder requires its own completed planned-cell planner operation.");
        } else if (prior.length > 0) {
          const decision = input.retryDecision;
          const matched = decision && prior.find((record) =>
            record.runId === decision.supersedesRunId && record.state === "outcome_unknown" &&
            record.model === decision.model && record.taskHash === decision.taskHash);
          const authorization = decision ? db.prepare(`SELECT * FROM invocation_retry_authorizations
            WHERE decision_id = ?`).get(decision.decisionId) as Record<string, unknown> | undefined : null;
          if (!matched || !authorization || authorization.consumed_at !== null ||
              authorization.supersedes_run_id !== decision.supersedesRunId ||
              authorization.new_run_id !== input.runId || authorization.stage !== input.stage ||
              authorization.task_hash !== taskHash || authorization.model !== input.model) {
            throw new InvocationJournalError(
              "invocation_replay_forbidden",
              "A new run requires an unused explicit authorization bound to the ambiguous prior invocation."
            );
          }
        } else if (input.retryDecision !== undefined) {
          throw new InvocationJournalError(
            "invocation_replay_forbidden",
            "Explicit retry decision does not identify a persisted prior invocation."
          );
        }
        const record: InvocationRecord = Object.freeze({
          version: DURABLE_INVOCATION_JOURNAL_VERSION, invocationKey: key, runId: input.runId,
          stage: input.stage, taskHash: hash(input.task), model: input.model,
          state: "prepared", preparedAt: now(), startedAt: null, deadlineAt: input.deadlineAt,
          abortRequestedAt: null, workerExitedAt: null, exitSignal: null, terminalAt: null,
          sessionEvidence: "unknown", invocationOccurred: null, failureCode: null,
          failureDetail: null,
          retryDecisionId: input.retryDecision?.decisionId ?? null,
          supersedesRunId: input.retryDecision?.supersedesRunId ?? null,
          recoveryId: randomUUID(), ownerPid: process.pid,
          ...(input.plannedExperiment === undefined ? {} : { plannedExperiment: input.plannedExperiment }),
          ...(input.plannedTaskB === undefined ? {} : { plannedTaskB: input.plannedTaskB })
        });
        const json = JSON.stringify(record);
        db.prepare("INSERT INTO provider_invocations (invocation_key, run_id, stage, record_json, record_hash) VALUES (?, ?, ?, ?, ?)")
          .run(key, input.runId, input.stage, json, hash(json));
        if (input.retryDecision) db.prepare(`UPDATE invocation_retry_authorizations
          SET consumed_at = ? WHERE decision_id = ? AND consumed_at IS NULL`)
          .run(now(), input.retryDecision.decisionId);
        return record;
      });
      if (reservation === null) throw new InvocationJournalError("invocation_replay_forbidden", "Provider invocation already reserved; no automatic replay.");
      ownedReservations.add(reservation.invocationKey);
      return reservation;
    },
    start(key: string): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      return transition(key, ["prepared"], (row) => ({ ...row, state: "started", startedAt: now() }));
    },
    finish(key: string, state: "completed" | "failed" | "outcome_unknown", details: Readonly<{
      failureCode?: string | null;
      diagnosticCodes?: readonly string[];
      abortRequestedAt?: number | null;
      workerExitedAt?: number | null;
      exitSignal?: string | null;
      sessionEvidence?: InvocationRecord["sessionEvidence"];
      providerFailureClass?: AgentProviderFailureClass;
      providerHttpStatus?: number | null;
      workerOutcome?: AgentWorkerOutcome;
      workerExitCode?: number | null;
      terminalTurnObserved?: boolean | null;
      workerDiagnostic?: Readonly<Record<string, unknown>> | null;
    }> = {}): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      const finished = transition(key, ["started"], (row) => ({ ...row, state, terminalAt: now(),
        failureCode: safeCode(details.failureCode ?? null),
        failureDetail: safeDiagnosticCodes(details.diagnosticCodes),
        abortRequestedAt: details.abortRequestedAt ?? null,
        workerExitedAt: details.workerExitedAt ?? null,
        exitSignal: details.exitSignal ?? null,
        sessionEvidence: details.sessionEvidence ?? "unknown",
        providerFailureClass: details.providerFailureClass ?? "unknown",
        providerHttpStatus: details.providerHttpStatus ?? null,
        workerOutcome: details.workerOutcome ?? "unknown",
        workerExitCode: details.workerExitCode ?? null,
        terminalTurnObserved: details.terminalTurnObserved ?? null,
        invocationOccurred: state === "completed" ? true : null,
        ...(details.workerDiagnostic === undefined ? {} :
          { workerDiagnostic: safeWorkerDiagnostic(details.workerDiagnostic) })
      }));
      ownedReservations.delete(key);
      return finished;
    },
    recover(key: string): InvocationRecord {
      if (!ownedReservations.has(key)) throw new InvocationJournalError(
        "invocation_replay_forbidden", "This journal instance does not own the invocation reservation.");
      const recovered = transaction((db) => {
        const row = get(db, key);
        if (!row) throw new InvocationJournalError("invocation_journal_unavailable", "Missing invocation reservation is not evidence of no charge.");
        if (TERMINAL.includes(row.state)) throw new InvocationJournalError(
          "invocation_replay_forbidden", "Terminal invocation cannot be recovered again.");
        const unknown = Object.freeze({ ...row, state: "outcome_unknown" as const,
          terminalAt: now(), failureCode: "process_interrupted" });
        store(db, unknown);
        return unknown;
      });
      ownedReservations.delete(key);
      return recovered;
    },
    recoverCrashed(authority: InvocationCrashRecoveryAuthority): InvocationRecord {
      if (!authority || typeof authority !== "object" || !HASH.test(authority.invocationKey) ||
          !ID.test(authority.recoveryId) || !Number.isSafeInteger(authority.ownerPid) ||
          authority.ownerPid <= 0) throw new InvocationJournalError(
        "invocation_replay_forbidden", "Invalid crash-recovery authority.");
      return transaction((db) => {
        const row = get(db, authority.invocationKey);
        if (!row || TERMINAL.includes(row.state) || row.recoveryId !== authority.recoveryId ||
            row.ownerPid !== authority.ownerPid || ownerStillAlive(authority.ownerPid)) {
          throw new InvocationJournalError("invocation_replay_forbidden",
            "Crash recovery requires the matching claim and a terminated owner process.");
        }
        const unknown = Object.freeze({ ...row, state: "outcome_unknown" as const,
          terminalAt: now(), failureCode: "process_interrupted" });
        store(db, unknown);
        return unknown;
      });
    },
    read(key: string): InvocationRecord | null { return transaction((db) => get(db, key)); }
  });
}

/** Read-only planned-cell availability; never reserves or initializes the journal. */
export function inspectPlannedExperimentJournal(file: string, cells: readonly Readonly<{
  authority: PlannedExperimentAuthority; sourceRepositoryPath: string;
}>[]): readonly Readonly<{ cellId: string; authorized: boolean; consumed: boolean;
  replayForbidden: boolean; plannerState: InvocationState | null;
  coderState: InvocationState | null;
  availability: "available" | "consumed_successfully" | "consumed_infrastructure_invalidated" |
    "replacement_authorized" | "replacement_consumed" | "final_replacement_authorized" |
    "final_replacement_consumed" | "stage2_authorized" | "stage2_consumed" | "blocked"; }>[] {
  if (!isAbsolute(file) || !existsSync(file) || lstatSync(file).isSymbolicLink())
    throw new InvocationJournalError("invocation_journal_unavailable", "Existing journal is required.");
  for (const cell of cells) validatePlannedContextMatrixAuthority(cell.authority, {
    sourceRepositoryPath: cell.sourceRepositoryPath, model: cell.authority.model,
    reasoning: cell.authority.reasoning, stage: "planner" });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const records = db.prepare("SELECT invocation_key, record_json, record_hash FROM provider_invocations")
      .all().map((row) => checkedRow(row, (row as { invocation_key: string }).invocation_key));
    const hasReplacementTable = Boolean(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'planned_experiment_replacements'`).get());
    const hasFinalTable = Boolean(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'planned_experiment_final_replacements'`).get());
    const hasStage2Table = Boolean(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'planned_experiment_stage2_authorizations'`).get());
    return Object.freeze(cells.map((cell) => {
      const matching = records.filter((record) =>
        record.plannedExperiment?.planSlotHash === cell.authority.planSlotHash);
      const sessionCollision = records.some((record) =>
        record.plannedExperiment?.sessionId === cell.authority.sessionId &&
        record.plannedExperiment?.sessionHash !== cell.authority.sessionHash);
      const own = matching.filter((record) =>
        record.plannedExperiment?.sessionId === cell.authority.sessionId);
      const planner = own.find((record) => record.stage === "planner");
      const coder = own.find((record) => record.stage === "coder");
      const replacement = cell.authority.replacementAttemptIndex === 2;
      const finalReplacement = cell.authority.replacementAttemptIndex === 3;
      const stage2 = cell.authority.repetitionIndex === 2;
      // For the final authority, consumption means work in the new session;
      // the reviewed historical minimal slot is necessarily occupied.
      const consumed = finalReplacement ? own.length > 0 : matching.length > 0;
      const existing = hasReplacementTable ? db.prepare(`SELECT * FROM planned_experiment_replacements
        WHERE failed_session_id = ? OR replacement_session_id = ?`)
        .get(cell.authority.replacesSessionId ?? "", cell.authority.sessionId) as
        Record<string, unknown> | undefined : undefined;
      const replacementAllowed = replacement && replacementPriorValid(records, cell.authority) &&
        (!existing || existing.replacement_session_id === cell.authority.sessionId &&
          existing.replacement_session_hash === cell.authority.sessionHash);
      const finalExisting = hasFinalTable ? db.prepare(`SELECT * FROM planned_experiment_final_replacements
        WHERE prior_session_id = ? OR final_session_id = ?`)
        .get(cell.authority.replacesSessionId ?? "", cell.authority.sessionId) as
        Record<string, unknown> | undefined : undefined;
      const original = finalReplacement ? readPlannedReplacementReview(cell.authority.manifestPath) : null;
      const priorAuthorization = finalReplacement && hasReplacementTable ?
        db.prepare(`SELECT * FROM planned_experiment_replacements WHERE replacement_session_id = ?`)
          .get(cell.authority.replacesSessionId ?? "") as Record<string, unknown> | undefined : undefined;
      const finalAllowed = finalReplacement && finalReplacementPriorValid(records, cell.authority) &&
        priorAuthorization?.failed_session_id === original?.failedSessionId &&
        priorAuthorization?.replacement_session_hash ===
          readPlannedFinalReplacementReview(cell.authority.manifestPath).priorSessionHash &&
        (!finalExisting || finalExisting.final_session_id === cell.authority.sessionId &&
          finalExisting.final_session_hash === cell.authority.sessionHash);
      const stage2Existing = hasStage2Table ? db.prepare(`SELECT * FROM planned_experiment_stage2_authorizations
        WHERE prior_stage1_session_id = ? OR stage2_session_id = ?`)
        .get(cell.authority.priorStage1SessionId ?? "", cell.authority.sessionId) as
        Record<string, unknown> | undefined : undefined;
      const stage2Allowed = stage2 && stage2PriorValid(records, cell.authority) &&
        (!stage2Existing || stage2Existing.stage2_session_id === cell.authority.sessionId &&
          stage2Existing.stage2_session_hash === cell.authority.sessionHash) &&
        !records.some(record => record.plannedExperiment?.repetitionIndex === 2 &&
          record.plannedExperiment?.sessionId !== cell.authority.sessionId);
      const authorized = stage2 ? stage2Allowed && own.length === 0 && !sessionCollision :
        finalReplacement ? finalAllowed && own.length === 0 && !sessionCollision :
        replacement ? replacementAllowed && own.length === 0 && !sessionCollision :
        !consumed && !sessionCollision;
      const availability = stage2 ?
        (stage2Allowed ? own.length === 0 ? "stage2_authorized" : "stage2_consumed" : "blocked") :
        finalReplacement ?
        (finalAllowed ? own.length === 0 ? "final_replacement_authorized" :
          "final_replacement_consumed" : "blocked") : replacement ?
        (replacementAllowed ? own.length === 0 ? "replacement_authorized" : "replacement_consumed" : "blocked") :
        (!consumed && !sessionCollision ? "available" : matching.some((record) =>
          record.plannedExperiment?.sessionId === "stage1-70a2d3b048822c4ab11b779d") ?
          "consumed_infrastructure_invalidated" : consumed ? "consumed_successfully" : "blocked");
      return Object.freeze({ cellId: cell.authority.cellId,
        authorized, consumed, replayForbidden: !authorized,
        availability,
        plannerState: planner?.state ?? null,
        coderState: coder?.state ?? null });
    }));
  } finally { db.close(); }
}
