import {
  hashCanonicalJson,
  type AgentEvent,
  type AgentRole
} from "./agent-event-ledger.js";
import {
  verifyAgentEventLedger,
  type AgentEventLedgerVerificationOptions,
  type AgentEventLedgerVerificationResult,
  type LedgerVerificationIssue
} from "./agent-event-ledger-verifier.js";

export const RUN_ACCOUNTABILITY_TRACE_VERSION = "1" as const;

export type RunAccountabilityTraceDecision =
  | "trace_ready"
  | "trace_invalid"
  | "trace_needs_review";

export type TraceFindingSeverity = "info" | "warning" | "error";

export type TraceFinding = {
  code: string;
  message: string;
  severity: TraceFindingSeverity;
  actor?: AgentRole;
  eventIds: readonly string[];
  filePaths: readonly string[];
};

export type RoleActivitySummary = {
  actor: AgentRole;
  callCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  totalDurationMs: number;
  eventsWithTokenUsage: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  decisions: readonly string[];
  actions: readonly string[];
};

export type AccountabilityEventSummary = {
  sequence: number;
  eventId: string;
  actor: AgentRole;
  action: string;
  decision: string | null;
  reasonCodes: readonly string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filesReadCount: number;
  filesProposedCount: number;
  inputArtifactCount: number;
  outputArtifactCount: number;
  tokenUsagePresent: boolean;
  totalTokens: number | null;
  previousEventHash: string | null;
  eventHash: string;
};

export type FileAccountabilitySummary = {
  plannedFiles: readonly string[];
  coderProposedFiles: readonly string[];
  repairProposedFiles: readonly string[];
  allProposedFiles: readonly string[];
  temporaryAppliedFiles: readonly string[];
  executionReadFiles: readonly string[];
  unplannedProposedFiles: readonly string[];
  appliedButUnproposedFiles: readonly string[];
  plannedFileCount: number;
  proposedFileCount: number;
  temporaryAppliedFileCount: number;
  scopeExpansionFactor: number | null;
};

export type DecisionAccountabilitySummary = {
  plannerDecisions: readonly string[];
  coderDecisions: readonly string[];
  deterministicVerifierDecisions: readonly string[];
  repairVerifierDecisions: readonly string[];
  patchDryRunDecisions: readonly string[];
  temporaryApplyDecisions: readonly string[];
  executionDecisions: readonly string[];
  finalDeterministicVerifierDecision: string | null;
  finalRepairVerifierDecision: string | null;
  finalPatchDryRunDecision: string | null;
  finalTemporaryApplyDecision: string | null;
  finalExecutionDecision: string | null;
  uniqueExecutionDecisions: readonly string[];
  executionDecisionConflict: boolean;
};

export type RepairActivitySummary = {
  plannerCallCount: number;
  coderCallCount: number;
  deterministicVerifierCallCount: number;
  remaskCount: number;
  repairCount: number;
  repairVerifierCallCount: number;
  patchDryRunCallCount: number;
  temporaryApplyCallCount: number;
  executionVerifierCallCount: number;
  governanceRoleCallCount: number;
  repeatedActorTransitions: number;
};

export type RunResourceSummary = {
  totalDurationMs: number;
  eventsWithTokenUsage: number;
  eventsWithoutTokenUsage: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  longestEventDurationMs: number;
  longestEventId: string | null;
  firstStartedAt: string | null;
  lastFinishedAt: string | null;
  wallClockSpanMs: number;
};

export type RunAccountabilityTrace = {
  traceVersion: "1";
  runId: string;
  objectiveHash: string;
  ledgerRootHash: string;
  ledgerEventCount: number;
  externallyAnchored: boolean;
  externalAnchorsMatched: boolean;
  rolesCalled: readonly AgentRole[];
  roleActivity: readonly RoleActivitySummary[];
  events: readonly AccountabilityEventSummary[];
  files: FileAccountabilitySummary;
  decisions: DecisionAccountabilitySummary;
  repairActivity: RepairActivitySummary;
  resources: RunResourceSummary;
  findings: readonly TraceFinding[];
  phaseVExecutionObserved: boolean;
  phaseVExecutionCompleted: boolean;
  traceHash: string;
};

export type RunAccountabilityTraceResult = {
  decision: RunAccountabilityTraceDecision;
  issues: readonly LedgerVerificationIssue[];
  findings: readonly TraceFinding[];
  ledgerVerification: AgentEventLedgerVerificationResult["summary"];
  trace: RunAccountabilityTrace | null;
  summary: {
    ledgerValid: boolean;
    ledgerNeedsReview: boolean;
    ledgerInvalid: boolean;
    traceBuilt: boolean;
    traceHashValid: boolean;
    totalEvents: number;
    rolesCalled: number;
    plannedFiles: number;
    proposedFiles: number;
    unplannedProposedFiles: number;
    temporaryAppliedFiles: number;
    appliedButUnproposedFiles: number;
    remaskCount: number;
    repairCount: number;
    executionObserved: boolean;
    executionCompleted: boolean;
    executionDecisionConflict: boolean;
    totalDurationMs: number;
    totalTokens: number;
    findingCount: number;
    warningCount: number;
    errorCount: number;
  };
};

const AGENT_ROLE_ORDER: readonly AgentRole[] = Object.freeze([
  "planner",
  "coder",
  "deterministic_verifier",
  "masker",
  "repairer",
  "repair_verifier",
  "patch_dry_run",
  "temp_workspace_apply",
  "execution_verifier",
  "shadow_observer",
  "deterministic_governor",
  "admin_agent",
  "approval_router"
]);

const GOVERNANCE_ROLES = new Set<AgentRole>([
  "shadow_observer",
  "deterministic_governor",
  "admin_agent",
  "approval_router"
]);
const TERMINAL_EXECUTION_DECISIONS = new Set([
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SEVERITY_RANK: Record<TraceFindingSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2
};

type MutableRoleActivity = {
  actor: AgentRole;
  callCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  totalDurationMs: number;
  eventsWithTokenUsage: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  decisions: string[];
  actions: string[];
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function setDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function decisionsFor(events: readonly AgentEvent[], actor: AgentRole): string[] {
  return events
    .filter((event) => event.actor === actor && event.decision !== null)
    .map((event) => event.decision as string);
}

function finalDecision(decisions: readonly string[]): string | null {
  return decisions.length === 0 ? null : decisions[decisions.length - 1];
}

function safeAdd(
  current: number,
  amount: number,
  eventId: string,
  overflowEventIds: Set<string>
): number {
  if (current > Number.MAX_SAFE_INTEGER - amount) {
    overflowEventIds.add(eventId);
    return Number.MAX_SAFE_INTEGER;
  }
  return current + amount;
}

function makeFinding(
  code: string,
  message: string,
  severity: TraceFindingSeverity,
  options: {
    actor?: AgentRole;
    eventIds?: Iterable<string>;
    filePaths?: Iterable<string>;
  } = {}
): TraceFinding {
  return {
    code,
    message,
    severity,
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    eventIds: sortedUnique(options.eventIds ?? []),
    filePaths: sortedUnique(options.filePaths ?? [])
  };
}

function sortFindings(findings: TraceFinding[]): TraceFinding[] {
  return findings.sort((left, right) => {
    const rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (rank !== 0) return rank;
    const code = left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
    if (code !== 0) return code;
    const leftActor = left.actor ?? "";
    const rightActor = right.actor ?? "";
    const actor = leftActor < rightActor ? -1 : leftActor > rightActor ? 1 : 0;
    if (actor !== 0) return actor;
    const leftEvents = canonicalizeList(left.eventIds);
    const rightEvents = canonicalizeList(right.eventIds);
    const eventIds = leftEvents < rightEvents ? -1 : leftEvents > rightEvents ? 1 : 0;
    if (eventIds !== 0) return eventIds;
    const leftFiles = canonicalizeList(left.filePaths);
    const rightFiles = canonicalizeList(right.filePaths);
    return leftFiles < rightFiles ? -1 : leftFiles > rightFiles ? 1 : 0;
  });
}

function canonicalizeList(values: readonly string[]): string {
  return JSON.stringify(values);
}

function baseResultSummary(
  ledgerDecision: AgentEventLedgerVerificationResult["decision"]
): RunAccountabilityTraceResult["summary"] {
  return {
    ledgerValid: ledgerDecision === "ledger_valid",
    ledgerNeedsReview: ledgerDecision === "ledger_needs_review",
    ledgerInvalid: ledgerDecision === "ledger_invalid",
    traceBuilt: false,
    traceHashValid: false,
    totalEvents: 0,
    rolesCalled: 0,
    plannedFiles: 0,
    proposedFiles: 0,
    unplannedProposedFiles: 0,
    temporaryAppliedFiles: 0,
    appliedButUnproposedFiles: 0,
    remaskCount: 0,
    repairCount: 0,
    executionObserved: false,
    executionCompleted: false,
    executionDecisionConflict: false,
    totalDurationMs: 0,
    totalTokens: 0,
    findingCount: 0,
    warningCount: 0,
    errorCount: 0
  };
}

function suspiciousPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /(^|[\\/])\.\.([\\/]|$)/.test(path) ||
    /(^|[\\/])\.git([\\/]|$)/.test(path) ||
    path.includes("\\")
  );
}

export function buildRunAccountabilityTrace(
  input: unknown,
  options?: AgentEventLedgerVerificationOptions
): RunAccountabilityTraceResult {
  const verification = verifyAgentEventLedger(input, options);
  const initialSummary = baseResultSummary(verification.decision);

  if (verification.decision !== "ledger_valid") {
    return deepFreeze({
      decision:
        verification.decision === "ledger_invalid"
          ? "trace_invalid"
          : "trace_needs_review",
      issues: verification.issues,
      findings: [],
      ledgerVerification: verification.summary,
      trace: null,
      summary: initialSummary
    }) as RunAccountabilityTraceResult;
  }

  const ledger = verification.verifiedLedger;
  if (ledger === null) {
    const findings = [
      makeFinding(
        "verified_ledger_missing",
        "Ledger verification succeeded without a reconstructed ledger.",
        "error"
      )
    ];
    return deepFreeze({
      decision: "trace_needs_review",
      issues: verification.issues,
      findings,
      ledgerVerification: verification.summary,
      trace: null,
      summary: {
        ...initialSummary,
        findingCount: 1,
        errorCount: 1
      }
    }) as RunAccountabilityTraceResult;
  }

  const events = ledger.events;
  const overflowEventIds = new Set<string>();
  const roleMap = new Map<AgentRole, MutableRoleActivity>();
  for (const actor of AGENT_ROLE_ORDER) {
    roleMap.set(actor, {
      actor,
      callCount: 0,
      firstSequence: null,
      lastSequence: null,
      totalDurationMs: 0,
      eventsWithTokenUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      decisions: [],
      actions: []
    });
  }

  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let eventsWithTokenUsage = 0;
  let longestEventDurationMs = 0;
  let longestEventId: string | null = null;
  let minimumStartedMs: number | null = null;
  let maximumFinishedMs: number | null = null;
  let firstStartedAt: string | null = null;
  let lastFinishedAt: string | null = null;

  for (const event of events) {
    const role = roleMap.get(event.actor) as MutableRoleActivity;
    role.callCount += 1;
    role.firstSequence ??= event.sequence;
    role.lastSequence = event.sequence;
    role.totalDurationMs = safeAdd(
      role.totalDurationMs,
      event.durationMs,
      event.eventId,
      overflowEventIds
    );
    role.actions.push(event.action);
    if (event.decision !== null) role.decisions.push(event.decision);

    totalDurationMs = safeAdd(totalDurationMs, event.durationMs, event.eventId, overflowEventIds);
    if (event.tokenUsage !== undefined) {
      role.eventsWithTokenUsage += 1;
      eventsWithTokenUsage += 1;
      role.inputTokens = safeAdd(
        role.inputTokens,
        event.tokenUsage.inputTokens,
        event.eventId,
        overflowEventIds
      );
      role.outputTokens = safeAdd(
        role.outputTokens,
        event.tokenUsage.outputTokens,
        event.eventId,
        overflowEventIds
      );
      role.totalTokens = safeAdd(
        role.totalTokens,
        event.tokenUsage.totalTokens,
        event.eventId,
        overflowEventIds
      );
      totalInputTokens = safeAdd(
        totalInputTokens,
        event.tokenUsage.inputTokens,
        event.eventId,
        overflowEventIds
      );
      totalOutputTokens = safeAdd(
        totalOutputTokens,
        event.tokenUsage.outputTokens,
        event.eventId,
        overflowEventIds
      );
      totalTokens = safeAdd(
        totalTokens,
        event.tokenUsage.totalTokens,
        event.eventId,
        overflowEventIds
      );
    }

    if (longestEventId === null || event.durationMs > longestEventDurationMs) {
      longestEventDurationMs = event.durationMs;
      longestEventId = event.eventId;
    }
    const startedMs = Date.parse(event.startedAt);
    const finishedMs = Date.parse(event.finishedAt);
    if (minimumStartedMs === null || startedMs < minimumStartedMs) {
      minimumStartedMs = startedMs;
      firstStartedAt = event.startedAt;
    }
    if (maximumFinishedMs === null || finishedMs > maximumFinishedMs) {
      maximumFinishedMs = finishedMs;
      lastFinishedAt = event.finishedAt;
    }
  }

  const roleActivity: RoleActivitySummary[] = AGENT_ROLE_ORDER.map((actor) => {
    const role = roleMap.get(actor) as MutableRoleActivity;
    return {
      actor: role.actor,
      callCount: role.callCount,
      firstSequence: role.firstSequence,
      lastSequence: role.lastSequence,
      totalDurationMs: role.totalDurationMs,
      eventsWithTokenUsage: role.eventsWithTokenUsage,
      inputTokens: role.inputTokens,
      outputTokens: role.outputTokens,
      totalTokens: role.totalTokens,
      decisions: [...role.decisions],
      actions: [...role.actions]
    };
  });
  const rolesCalled = AGENT_ROLE_ORDER.filter(
    (actor) => (roleMap.get(actor) as MutableRoleActivity).callCount > 0
  );

  const eventSummaries: AccountabilityEventSummary[] = events.map((event) => ({
    sequence: event.sequence,
    eventId: event.eventId,
    actor: event.actor,
    action: event.action,
    decision: event.decision,
    reasonCodes: [...event.reasonCodes],
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    filesReadCount: event.filesRead.length,
    filesProposedCount: event.filesProposed.length,
    inputArtifactCount: event.inputArtifactHashes.length,
    outputArtifactCount: event.outputArtifactHashes.length,
    tokenUsagePresent: event.tokenUsage !== undefined,
    totalTokens: event.tokenUsage?.totalTokens ?? null,
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash
  }));

  const proposedFor = (actor: AgentRole): string[] =>
    sortedUnique(
      events
        .filter((event) => event.actor === actor)
        .flatMap((event) => [...event.filesProposed])
    );
  const plannedFiles = proposedFor("planner");
  const coderProposedFiles = proposedFor("coder");
  const repairProposedFiles = proposedFor("repairer");
  const allProposedFiles = sortedUnique([...coderProposedFiles, ...repairProposedFiles]);
  const temporaryAppliedFiles = proposedFor("temp_workspace_apply");
  const executionReadFiles = sortedUnique(
    events
      .filter((event) => event.actor === "execution_verifier")
      .flatMap((event) => [...event.filesRead])
  );
  const unplannedProposedFiles = setDifference(allProposedFiles, plannedFiles);
  const appliedButUnproposedFiles = setDifference(temporaryAppliedFiles, allProposedFiles);
  const plannedFileCount = plannedFiles.length;
  const proposedFileCount = allProposedFiles.length;
  const files: FileAccountabilitySummary = {
    plannedFiles,
    coderProposedFiles,
    repairProposedFiles,
    allProposedFiles,
    temporaryAppliedFiles,
    executionReadFiles,
    unplannedProposedFiles,
    appliedButUnproposedFiles,
    plannedFileCount,
    proposedFileCount,
    temporaryAppliedFileCount: temporaryAppliedFiles.length,
    scopeExpansionFactor:
      plannedFileCount > 0
        ? proposedFileCount / plannedFileCount
        : proposedFileCount === 0
          ? 1
          : null
  };

  const plannerDecisions = decisionsFor(events, "planner");
  const coderDecisions = decisionsFor(events, "coder");
  const deterministicVerifierDecisions = decisionsFor(events, "deterministic_verifier");
  const repairVerifierDecisions = decisionsFor(events, "repair_verifier");
  const patchDryRunDecisions = decisionsFor(events, "patch_dry_run");
  const temporaryApplyDecisions = decisionsFor(events, "temp_workspace_apply");
  const executionDecisions = decisionsFor(events, "execution_verifier");
  const uniqueExecutionDecisions = sortedUnique(executionDecisions);
  const decisions: DecisionAccountabilitySummary = {
    plannerDecisions,
    coderDecisions,
    deterministicVerifierDecisions,
    repairVerifierDecisions,
    patchDryRunDecisions,
    temporaryApplyDecisions,
    executionDecisions,
    finalDeterministicVerifierDecision: finalDecision(deterministicVerifierDecisions),
    finalRepairVerifierDecision: finalDecision(repairVerifierDecisions),
    finalPatchDryRunDecision: finalDecision(patchDryRunDecisions),
    finalTemporaryApplyDecision: finalDecision(temporaryApplyDecisions),
    finalExecutionDecision: finalDecision(executionDecisions),
    uniqueExecutionDecisions,
    executionDecisionConflict: uniqueExecutionDecisions.length > 1
  };

  const calls = (actor: AgentRole): number =>
    (roleMap.get(actor) as MutableRoleActivity).callCount;
  let repeatedActorTransitions = 0;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].actor === events[index].actor) repeatedActorTransitions += 1;
  }
  const repairActivity: RepairActivitySummary = {
    plannerCallCount: calls("planner"),
    coderCallCount: calls("coder"),
    deterministicVerifierCallCount: calls("deterministic_verifier"),
    remaskCount: calls("masker"),
    repairCount: calls("repairer"),
    repairVerifierCallCount: calls("repair_verifier"),
    patchDryRunCallCount: calls("patch_dry_run"),
    temporaryApplyCallCount: calls("temp_workspace_apply"),
    executionVerifierCallCount: calls("execution_verifier"),
    governanceRoleCallCount: [...GOVERNANCE_ROLES].reduce(
      (total, actor) => total + calls(actor),
      0
    ),
    repeatedActorTransitions
  };

  const resources: RunResourceSummary = {
    totalDurationMs,
    eventsWithTokenUsage,
    eventsWithoutTokenUsage: events.length - eventsWithTokenUsage,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    longestEventDurationMs,
    longestEventId,
    firstStartedAt,
    lastFinishedAt,
    wallClockSpanMs:
      minimumStartedMs === null || maximumFinishedMs === null
        ? 0
        : maximumFinishedMs - minimumStartedMs
  };

  const phaseVExecutionObserved = calls("execution_verifier") > 0;
  const phaseVExecutionCompleted =
    decisions.finalExecutionDecision !== null &&
    TERMINAL_EXECUTION_DECISIONS.has(decisions.finalExecutionDecision);
  const findings: TraceFinding[] = [];
  const eventsForActor = (actor: AgentRole): string[] =>
    events.filter((event) => event.actor === actor).map((event) => event.eventId);

  if (events.length === 0) {
    findings.push(makeFinding("empty_run_trace", "The verified ledger contains no run events.", "warning"));
  }
  for (const [actor, code, message] of [
    ["planner", "missing_planner_event", "No planner event is present."],
    ["coder", "missing_coder_event", "No coder event is present."],
    [
      "deterministic_verifier",
      "missing_deterministic_verifier_event",
      "No deterministic verifier event is present."
    ],
    [
      "execution_verifier",
      "missing_execution_verifier_event",
      "No execution verifier event is present."
    ]
  ] as const) {
    if (calls(actor) === 0) {
      findings.push(makeFinding(code, message, "warning", { actor }));
    }
  }
  if (!phaseVExecutionCompleted) {
    findings.push(
      makeFinding(
        "execution_terminal_decision_missing",
        "No final terminal Phase V execution decision is present.",
        "warning",
        {
          actor: "execution_verifier",
          eventIds: eventsForActor("execution_verifier")
        }
      )
    );
  }
  const proposedEventIds = events
    .filter(
      (event) =>
        (event.actor === "coder" || event.actor === "repairer") &&
        event.filesProposed.length > 0
    )
    .map((event) => event.eventId);
  const unplannedFileSet = new Set(unplannedProposedFiles);
  const unplannedEventIds = events
    .filter(
      (event) =>
        (event.actor === "coder" || event.actor === "repairer") &&
        event.filesProposed.some((path) => unplannedFileSet.has(path))
    )
    .map((event) => event.eventId);
  if (plannedFiles.length === 0 && allProposedFiles.length > 0) {
    findings.push(
      makeFinding(
        "proposed_files_without_plan",
        "Files were proposed without planner file-scope evidence.",
        "warning",
        { eventIds: proposedEventIds, filePaths: allProposedFiles }
      )
    );
  }
  if (unplannedProposedFiles.length > 0) {
    findings.push(
      makeFinding(
        "unplanned_files_proposed",
        "Proposed files exceed the recorded planner file scope.",
        "warning",
        { eventIds: unplannedEventIds, filePaths: unplannedProposedFiles }
      )
    );
  }
  if (appliedButUnproposedFiles.length > 0) {
    const mismatchedFileSet = new Set(appliedButUnproposedFiles);
    findings.push(
      makeFinding(
        "temporary_apply_scope_mismatch",
        "Temporary application includes files absent from proposal evidence.",
        "error",
        {
          actor: "temp_workspace_apply",
          eventIds: events
            .filter(
              (event) =>
                event.actor === "temp_workspace_apply" &&
                event.filesProposed.some((path) => mismatchedFileSet.has(path))
            )
            .map((event) => event.eventId),
          filePaths: appliedButUnproposedFiles
        }
      )
    );
  }
  if (decisions.executionDecisionConflict) {
    findings.push(
      makeFinding(
        "conflicting_execution_decisions",
        "Execution verifier events contain distinct decisions.",
        "error",
        {
          actor: "execution_verifier",
          eventIds: eventsForActor("execution_verifier")
        }
      )
    );
  }
  if (repairActivity.repairCount > 3) {
    findings.push(
      makeFinding("high_repair_count", "More than three repair events are present.", "warning", {
        actor: "repairer",
        eventIds: eventsForActor("repairer")
      })
    );
  }
  if (repairActivity.remaskCount > 3) {
    findings.push(
      makeFinding("high_remask_count", "More than three remask events are present.", "warning", {
        actor: "masker",
        eventIds: eventsForActor("masker")
      })
    );
  }
  if (repairActivity.governanceRoleCallCount > 0) {
    findings.push(
      makeFinding(
        "pre_governance_trace_contains_governance_roles",
        "Governance-role activity appears before governance integration.",
        "info",
        {
          eventIds: events
            .filter((event) => GOVERNANCE_ROLES.has(event.actor))
            .map((event) => event.eventId)
        }
      )
    );
  }
  if (overflowEventIds.size > 0) {
    findings.push(
      makeFinding(
        "resource_total_overflow",
        "One or more resource totals exceed safe-integer arithmetic.",
        "error",
        { eventIds: overflowEventIds }
      )
    );
  }
  const suspiciousPaths = sortedUnique(
    events.flatMap((event) => [...event.filesRead, ...event.filesProposed]).filter(suspiciousPath)
  );
  if (suspiciousPaths.length > 0) {
    findings.push(
      makeFinding(
        "suspicious_path_evidence_observed",
        "Suspicious path-shaped audit evidence is present.",
        "info",
        {
          eventIds: events
            .filter((event) =>
              [...event.filesRead, ...event.filesProposed].some((path) => suspiciousPath(path))
            )
            .map((event) => event.eventId),
          filePaths: suspiciousPaths
        }
      )
    );
  }
  sortFindings(findings);

  const traceWithoutHash: Omit<RunAccountabilityTrace, "traceHash"> = {
    traceVersion: RUN_ACCOUNTABILITY_TRACE_VERSION,
    runId: ledger.runId,
    objectiveHash: ledger.objectiveHash,
    ledgerRootHash: ledger.rootHash,
    ledgerEventCount: ledger.eventCount,
    externallyAnchored: verification.summary.externallyAnchored,
    externalAnchorsMatched: verification.summary.externalAnchorsMatched,
    rolesCalled,
    roleActivity,
    events: eventSummaries,
    files,
    decisions,
    repairActivity,
    resources,
    findings,
    phaseVExecutionObserved,
    phaseVExecutionCompleted
  };
  const trace: RunAccountabilityTrace = {
    ...traceWithoutHash,
    traceHash: hashCanonicalJson(traceWithoutHash)
  };
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const resultSummary: RunAccountabilityTraceResult["summary"] = {
    ...initialSummary,
    traceBuilt: true,
    traceHashValid: HASH_PATTERN.test(trace.traceHash),
    totalEvents: ledger.eventCount,
    rolesCalled: rolesCalled.length,
    plannedFiles: files.plannedFileCount,
    proposedFiles: files.proposedFileCount,
    unplannedProposedFiles: files.unplannedProposedFiles.length,
    temporaryAppliedFiles: files.temporaryAppliedFileCount,
    appliedButUnproposedFiles: files.appliedButUnproposedFiles.length,
    remaskCount: repairActivity.remaskCount,
    repairCount: repairActivity.repairCount,
    executionObserved: phaseVExecutionObserved,
    executionCompleted: phaseVExecutionCompleted,
    executionDecisionConflict: decisions.executionDecisionConflict,
    totalDurationMs: resources.totalDurationMs,
    totalTokens: resources.totalTokens,
    findingCount: findings.length,
    warningCount,
    errorCount
  };

  return deepFreeze({
    decision: warningCount > 0 || errorCount > 0 ? "trace_needs_review" : "trace_ready",
    issues: verification.issues,
    findings,
    ledgerVerification: verification.summary,
    trace,
    summary: resultSummary
  }) as RunAccountabilityTraceResult;
}
