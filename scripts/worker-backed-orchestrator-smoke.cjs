const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  buildRemaskMessages,
  checkRepairDraftMutation,
  emptyRepairDraftChecks
} = require("./worker-backed-remask-smoke.cjs");

const SUITE_NAME = "phase-p-worker-backed-orchestrator-smoke";
const expectedAppliedFiles = ["packages/example/src/index.ts"];
const validateAppliedFilesSource = [
  "const fs=require('node:fs');",
  "const path=require('node:path');",
  "for(const file of process.argv.slice(1)){",
  "const full=path.resolve(process.cwd(),file);",
  "if(!fs.existsSync(full))process.exit(2);",
  "}"
].join("");

const fixture = {
  caseId: "phase-p-orchestrator-safe-helper",
  task: "Plan and draft a bounded change to add a small helper function.",
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "infra/prod.tf", "secrets.json"],
  fileContents: {
    "packages/example/src/index.ts": "export function addOne(value: number): number {\n  return value + 1;\n}\n"
  },
  proposedGoal: "Add an addOne helper function without touching unrelated files.",
  validationCommands: [
    {
      id: "validate-applied-files",
      executable: "node",
      args: ["-e", validateAppliedFilesSource, ...expectedAppliedFiles],
      timeoutMs: 10000,
      expectedExitCodes: [0]
    }
  ],
  validationAllowedExecutables: ["node"],
  validationEnvironment: {}
};

function readIntegerEnv(name, defaultValue, { min = 1 } = {}) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}; received ${JSON.stringify(raw)}`);
  }

  return parsed;
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function preview(value, maxChars = 1000) {
  return String(value || "").slice(0, maxChars);
}

function configFromEnv() {
  const hasShadowUrl = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL"
  );
  const hasShadowModelId = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKER_ORCHESTRATOR_SHADOW_MODEL_ID"
  );
  const hasAdminUrl = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL"
  );
  const hasAdminModelId = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKER_ORCHESTRATOR_ADMIN_MODEL_ID"
  );
  const handoffTargetNames = [
    "WORKER_ORCHESTRATOR_HANDOFF_REPOSITORY_IDENTITY_HASH",
    "WORKER_ORCHESTRATOR_HANDOFF_BASE_REVISION_HASH",
    "WORKER_ORCHESTRATOR_HANDOFF_WORKTREE_STATE_HASH"
  ];
  const handoffTargetPresence = handoffTargetNames.map((name) =>
    Object.prototype.hasOwnProperty.call(process.env, name));
  const handoffTargetValues = handoffTargetNames.map((name) => process.env[name]);
  const handoffTargetConfigured = handoffTargetPresence.every(Boolean) &&
    handoffTargetValues.every((value) => typeof value === "string" && value.length > 0);
  const handoffTargetIncomplete = handoffTargetPresence.some(Boolean) &&
    !handoffTargetConfigured;
  const hasHandoffConsumptionStatus = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS"
  );
  const configuredHandoffConsumptionStatus = hasHandoffConsumptionStatus
    ? process.env.WORKER_ORCHESTRATOR_HANDOFF_CONSUMPTION_STATUS
    : "unknown";
  const handoffConsumptionStatusValid = new Set([
    "not_consumed", "already_consumed", "unknown"
  ]).has(configuredHandoffConsumptionStatus);
  const upstreamUrl = process.env.WORKER_ORCHESTRATOR_UPSTREAM_URL || "";
  const modelId = process.env.WORKER_ORCHESTRATOR_MODEL_ID || "qwen2.5-coder-7b";
  return {
    upstreamUrl,
    modelId,
    timeoutMs: readIntegerEnv("WORKER_ORCHESTRATOR_TIMEOUT_MS", 120000),
    plannerMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS", 256),
    coderMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_CODER_MAX_TOKENS", 512),
    remaskMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS", 512),
    forceRemask: process.env.WORKER_ORCHESTRATOR_FORCE_REMASK === "1",
    required: process.env.WORKER_ORCHESTRATOR_REQUIRED === "1",
    shadow: {
      upstreamUrl: hasShadowUrl
        ? process.env.WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL
        : upstreamUrl,
      modelId: hasShadowModelId
        ? process.env.WORKER_ORCHESTRATOR_SHADOW_MODEL_ID
        : modelId,
      timeoutMs: readIntegerEnv("WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS", 120000),
      maxTraceEvents: readIntegerEnv(
        "WORKER_ORCHESTRATOR_SHADOW_MAX_TRACE_EVENTS",
        100
      ),
      maxPromptChars: readIntegerEnv(
        "WORKER_ORCHESTRATOR_SHADOW_MAX_PROMPT_CHARS",
        100000
      ),
      maxResponseChars: readIntegerEnv(
        "WORKER_ORCHESTRATOR_SHADOW_MAX_RESPONSE_CHARS",
        20000
      ),
      required: process.env.WORKER_ORCHESTRATOR_SHADOW_REQUIRED === "1"
    },
    admin: {
      upstreamUrl: hasAdminUrl
        ? process.env.WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL
        : hasShadowUrl
          ? process.env.WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL
          : upstreamUrl,
      modelId: hasAdminModelId
        ? process.env.WORKER_ORCHESTRATOR_ADMIN_MODEL_ID
        : hasShadowModelId
          ? process.env.WORKER_ORCHESTRATOR_SHADOW_MODEL_ID
          : modelId,
      timeoutMs: readIntegerEnv("WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS", 120000),
      maxTraceEvents: readIntegerEnv(
        "WORKER_ORCHESTRATOR_ADMIN_MAX_TRACE_EVENTS",
        100
      ),
      maxPromptChars: readIntegerEnv(
        "WORKER_ORCHESTRATOR_ADMIN_MAX_PROMPT_CHARS",
        150000
      ),
      maxResponseChars: readIntegerEnv(
        "WORKER_ORCHESTRATOR_ADMIN_MAX_RESPONSE_CHARS",
        30000
      ),
      required: process.env.WORKER_ORCHESTRATOR_ADMIN_REQUIRED === "1"
    },
    handoff: {
      targetConfigured: handoffTargetConfigured,
      targetIncomplete: handoffTargetIncomplete,
      target: handoffTargetConfigured ? {
        repositoryIdentityHash: handoffTargetValues[0],
        baseRevisionHash: handoffTargetValues[1],
        worktreeStateHash: handoffTargetValues[2]
      } : null,
      consumptionStatus: handoffConsumptionStatusValid
        ? configuredHandoffConsumptionStatus
        : "unknown",
      consumptionStatusValid: handoffConsumptionStatusValid,
      consumptionStatusExternallySupplied: hasHandoffConsumptionStatus,
      required: process.env.WORKER_ORCHESTRATOR_HANDOFF_REQUIRED === "1"
    },
    outDir: process.env.WORKER_ORCHESTRATOR_OUT_DIR || path.join("reports", "worker-backed-orchestrator-smoke")
  };
}

function buildPlannerMessages(testFixture = fixture) {
  const example = {
    role: "planner",
    target: "plan",
    summary: "short plan summary",
    claims: [
      {
        type: "planned_step",
        description: "Modify only packages/example/src/index.ts."
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  };

  return [
    {
      role: "system",
      content: [
        "You are the planner role in a bounded shared-workspace agent runtime.",
        "Return exactly one JSON object matching WorkspaceMutation and nothing else.",
        "Do not include markdown.",
        "Do not include prose before or after JSON.",
        'The JSON role must be "planner".',
        'The JSON target must be "plan".',
        "touchedFiles must be inside allowedFiles.",
        "forbiddenFiles must not be touched.",
        "Do not write a patch.",
        "Do not produce code.",
        "Only produce a planning mutation."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `CASE_ID: ${testFixture.caseId}`,
        `TASK: ${testFixture.task}`,
        `PROPOSED_GOAL: ${testFixture.proposedGoal}`,
        `ALLOWED_FILES: ${testFixture.allowedFiles.join(", ")}`,
        `FORBIDDEN_FILES: ${testFixture.forbiddenFiles.join(", ")}`,
        "Required JSON shape:",
        JSON.stringify(example, null, 2)
      ].join("\n")
    }
  ];
}

function buildCoderMessages(testFixture, plannerMutation) {
  const example = {
    role: "coder",
    target: "patchDraft",
    summary: "short patch draft summary",
    claims: [
      {
        type: "patch_draft",
        file: "packages/example/src/index.ts",
        description: "Add an exported addOne helper.",
        proposedPatch: "export function addOne(value: number): number { return value + 1; }"
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  };

  return [
    {
      role: "system",
      content: [
        "You are the coder role in a bounded shared-workspace agent runtime.",
        "Return exactly one JSON object matching WorkspaceMutation and nothing else.",
        "Do not include markdown.",
        "Do not include prose before or after JSON.",
        'The JSON role must be "coder".',
        'The JSON target must be "patchDraft".',
        "touchedFiles must be inside allowedFiles.",
        "forbiddenFiles must not be touched.",
        "Do not modify files on disk.",
        "Do not produce a full repo diff.",
        "Only produce a patchDraft workspace mutation.",
        "claims may include a proposedPatch string, but the caller will not apply it."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `CASE_ID: ${testFixture.caseId}`,
        `TASK: ${testFixture.task}`,
        `PROPOSED_GOAL: ${testFixture.proposedGoal}`,
        `PLANNER_MUTATION: ${JSON.stringify(plannerMutation)}`,
        `ALLOWED_FILES: ${testFixture.allowedFiles.join(", ")}`,
        `FORBIDDEN_FILES: ${testFixture.forbiddenFiles.join(", ")}`,
        "Required JSON shape:",
        JSON.stringify(example, null, 2)
      ].join("\n")
    }
  ];
}

function emptyRoleReport() {
  return {
    called: false,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    rawOutputPreview: "",
    validation: {
      ok: false,
      blocked: true,
      issues: [],
      mutation: null
    }
  };
}

function emptyVerifierReport() {
  return {
    called: false,
    forcedRemask: false,
    decision: null,
    ok: false,
    issueCount: 0,
    issues: [],
    finding: null
  };
}

function emptyRemaskReport() {
  return {
    called: false,
    requested: false,
    repairability: null,
    issueCount: 0,
    issues: [],
    request: null,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    rawOutputPreview: "",
    validation: null,
    repairDraftChecks: null
  };
}

function emptyRepairVerifierReport() {
  return {
    called: false,
    decision: null,
    ok: null,
    issueCount: 0,
    issues: [],
    finding: null
  };
}

function emptyPatchDryRunReport() {
  return {
    called: false,
    decision: null,
    ok: null,
    issueCount: 0,
    issues: [],
    summary: null,
    previews: []
  };
}

function emptyTemporaryWorkspaceApplyReport() {
  return {
    called: false,
    decision: null,
    ok: null,
    issueCount: 0,
    issues: [],
    tempWorkspacePath: null,
    appliedFileCount: 0,
    changedFiles: 0,
    cleanedUp: null,
    summary: null,
    appliedFiles: []
  };
}

function emptyTemporaryWorkspaceExecutionReport() {
  return {
    called: false,
    decision: null,
    ok: null,
    issueCount: 0,
    issues: [],
    commandCount: 0,
    passedCommands: 0,
    failedCommands: 0,
    timedOutCommands: 0,
    truncatedOutputs: 0,
    durationMs: 0,
    commandResults: [],
    cleanupAttempted: false,
    cleanupPerformed: false,
    cleanupError: null
  };
}

function emptyTemporaryWorkspaceExecutionDecision() {
  return {
    tempWorkspaceExecutionCalled: false,
    tempWorkspaceExecutionDecision: null,
    tempWorkspaceExecutionIssueCount: 0,
    tempWorkspaceExecutionCommandCount: 0,
    tempWorkspaceExecutionPassedCommands: 0,
    tempWorkspaceExecutionFailedCommands: 0,
    tempWorkspaceExecutionTimedOutCommands: 0,
    tempWorkspaceExecutionCleanupPerformed: false
  };
}

function emptyAccountabilityReport() {
  return {
    ledgerCreated: false,
    evidenceComplete: false,
    runId: null,
    objectiveHash: null,
    eventCountBeforeShadow: 0,
    eventCountAfterShadow: 0,
    eventCountAfterGovernance: 0,
    eventCountAfterAdmin: 0,
    eventCountAfterRouter: 0,
    ledgerRootHashBeforeShadow: null,
    ledgerRootHashAfterShadow: null,
    ledgerRootHashAfterGovernance: null,
    ledgerRootHashAfterAdmin: null,
    ledgerRootHashAfterRouter: null,
    preShadowLedgerVerificationDecision: null,
    preShadowTraceDecision: null,
    preShadowTraceHash: null,
    preShadowFindingCount: 0,
    preShadowWarningCount: 0,
    preShadowErrorCount: 0,
    postShadowLedgerVerificationDecision: null,
    postShadowTraceDecision: null,
    postShadowTraceHash: null,
    postShadowFindingCount: 0,
    postGovernanceLedgerVerificationDecision: null,
    postGovernanceTraceDecision: null,
    postGovernanceTraceHash: null,
    postGovernanceFindingCount: 0,
    postAdminLedgerVerificationDecision: null,
    postAdminTraceDecision: null,
    postAdminTraceHash: null,
    postAdminFindingCount: 0,
    postRouterLedgerVerificationDecision: null,
    postRouterTraceDecision: null,
    postRouterTraceHash: null,
    postRouterFindingCount: 0,
    governanceEventAppended: false,
    adminEventAppended: false,
    approvalRouterEventAppended: false,
    phaseVExecutionObserved: false,
    phaseVExecutionCompleted: false,
    issueCodes: [],
    ledger: null,
    preShadowTrace: null,
    postShadowTrace: null,
    postGovernanceTrace: null,
    postAdminTrace: null,
    postRouterTrace: null
  };
}

function emptyShadowObserverReport(configured = false, required = false) {
  return {
    configured,
    required,
    called: false,
    decision: null,
    validationDecision: null,
    requiredSatisfied: !required,
    riskLevel: null,
    riskScore: null,
    confidenceScore: null,
    recommendation: null,
    findingCount: 0,
    observationHash: null,
    responseContentHash: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    eventAppended: false,
    issueCodes: [],
    observation: null,
    durationMs: 0
  };
}

function emptyGovernanceReport() {
  return {
    evaluated: false,
    decision: null,
    riskClass: null,
    traceHash: null,
    observationHash: null,
    policyHash: null,
    governanceHash: null,
    triggeredRuleCount: 0,
    terminateRuleCount: 0,
    escalationRuleCount: 0,
    replanRuleCount: 0,
    repairRuleCount: 0,
    reasonCodes: [],
    issueCodes: [],
    eventAppended: false,
    assessment: null
  };
}

function emptyAdminAgentReport(configured = false, required = false) {
  return {
    configured,
    required,
    called: false,
    adapterDecision: null,
    validationDecision: null,
    requiredSatisfied: !required,
    governanceDecision: null,
    decision: null,
    riskLevel: null,
    riskScore: null,
    confidenceScore: null,
    findingCount: 0,
    adminDecisionHash: null,
    responseContentHash: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    issueCodes: [],
    eventAppended: false,
    adminDecision: null,
    adapterResult: null,
    durationMs: 0
  };
}

function emptyApprovalRouterReport() {
  return {
    evaluated: false,
    required: false,
    requiredSatisfied: true,
    validationDecision: null,
    route: null,
    riskClass: null,
    phaseVFinalDecision: null,
    shadowStageDecision: null,
    governanceDecision: null,
    adminStageDecision: null,
    adminDecision: null,
    traceHash: null,
    observationHash: null,
    governanceHash: null,
    adminDecisionHash: null,
    policyHash: null,
    routeHash: null,
    triggeredRuleCount: 0,
    repairRuleCount: 0,
    replanRuleCount: 0,
    humanRuleCount: 0,
    terminateRuleCount: 0,
    reasonCodes: [],
    issueCodes: [],
    deterministicAuthorityPreserved: false,
    autoContinueEligible: false,
    eventAppended: false,
    assessment: null
  };
}

function emptyGovernedChangeArtifactReport() {
  return {
    evaluated: false,
    required: false,
    requiredSatisfied: true,
    decision: null,
    artifactBuilt: false,
    applyEligible: false,
    changeKind: null,
    mutationHash: null,
    changedFileCount: 0,
    patchDryRunResultHash: null,
    temporaryApplyResultHash: null,
    executionVerificationResultHash: null,
    preShadowTraceHash: null,
    observationHash: null,
    governanceHash: null,
    adminDecisionHash: null,
    routeHash: null,
    governancePolicyHash: null,
    routerPolicyHash: null,
    finalLedgerRootHash: null,
    finalLedgerEventCount: 0,
    governedArtifactHash: null,
    eligibilityReasonCodes: [],
    issueCodes: [],
    artifact: null,
    durationMs: 0
  };
}

function emptyGovernedChangeFreshnessReport() {
  return {
    evaluated: false,
    decision: null,
    artifactIntegrityVerified: false,
    currentSnapshotHash: null,
    staleFields: [],
    reasonCodes: [],
    snapshotCurrent: false,
    handoffEligible: false,
    result: null
  };
}

function emptyControlledApplyHandoffReport() {
  return {
    evaluated: false,
    applicable: false,
    configured: false,
    required: false,
    requiredSatisfied: true,
    decision: null,
    handoffBuilt: false,
    mutationHash: null,
    changedFileCount: 0,
    governedArtifactHash: null,
    currentSnapshotHash: null,
    repositoryIdentityHash: null,
    baseRevisionHash: null,
    worktreeStateHash: null,
    constraintsHash: null,
    consumptionKey: null,
    handoffHash: null,
    externalConsumptionRegistryRequired: false,
    issueCodes: [],
    handoff: null,
    durationMs: 0,
    applyExecuted: false,
    registryWritten: false,
    rollbackPrepared: false
  };
}

function emptyControlledApplyHandoffVerificationReport() {
  return {
    evaluated: false,
    decision: null,
    consumptionStatus: "unknown",
    consumptionStatusExternallySupplied: false,
    handoffIntegrityVerified: false,
    artifactIntegrityVerified: false,
    currentSnapshotHash: null,
    currentMutationHash: null,
    staleFields: [],
    reasonCodes: [],
    executionEligible: false,
    result: null
  };
}

function emptyAccountabilityDecisionSummary() {
  return {
    agentLedgerCreated: false,
    agentLedgerEvidenceComplete: false,
    agentLedgerEventCountBeforeShadow: 0,
    agentLedgerEventCountAfterShadow: 0,
    agentLedgerRootHashBeforeShadow: null,
    agentLedgerRootHashAfterShadow: null,
    agentLedgerVerificationDecision: null,
    accountabilityTraceDecision: null,
    accountabilityTraceHash: null,
    shadowObserverConfigured: false,
    shadowObserverRequired: false,
    shadowObserverCalled: false,
    shadowObserverDecision: null,
    shadowObserverValidationDecision: null,
    shadowObserverRequiredSatisfied: true,
    shadowObserverRiskLevel: null,
    shadowObserverRiskScore: null,
    shadowObserverRecommendation: null,
    shadowObserverFindingCount: 0,
    shadowObserverObservationHash: null,
    shadowObserverEventAppended: false,
    postShadowLedgerVerificationDecision: null,
    postShadowTraceDecision: null,
    postShadowTraceHash: null,
    governanceEvaluated: false,
    governanceDecision: null,
    governanceRiskClass: null,
    governancePolicyHash: null,
    governanceHash: null,
    governanceTriggeredRuleCount: 0,
    governanceEventAppended: false,
    adminAgentConfigured: false,
    adminAgentRequired: false,
    adminAgentCalled: false,
    adminAgentAdapterDecision: null,
    adminAgentValidationDecision: null,
    adminAgentRequiredSatisfied: true,
    adminDecision: null,
    adminRiskLevel: null,
    adminRiskScore: null,
    adminFindingCount: 0,
    adminDecisionHash: null,
    adminEventAppended: false,
    agentLedgerEventCountAfterGovernance: 0,
    agentLedgerEventCountAfterAdmin: 0,
    agentLedgerRootHashAfterGovernance: null,
    agentLedgerRootHashAfterAdmin: null,
    postGovernanceLedgerVerificationDecision: null,
    postGovernanceTraceDecision: null,
    postGovernanceTraceHash: null,
    postAdminLedgerVerificationDecision: null,
    postAdminTraceDecision: null,
    postAdminTraceHash: null,
    approvalRouterEvaluated: false,
    approvalRouterValidationDecision: null,
    approvalWorkflowRoute: null,
    approvalRouterRiskClass: null,
    approvalRouterPolicyHash: null,
    approvalRouteHash: null,
    approvalRouterTriggeredRuleCount: 0,
    approvalRouterRepairRuleCount: 0,
    approvalRouterReplanRuleCount: 0,
    approvalRouterHumanRuleCount: 0,
    approvalRouterTerminateRuleCount: 0,
    approvalRouterDeterministicAuthorityPreserved: false,
    approvalRouterAutoContinueEligible: false,
    approvalRouterEventAppended: false,
    agentLedgerEventCountAfterRouter: 0,
    agentLedgerRootHashAfterRouter: null,
    postRouterLedgerVerificationDecision: null,
    postRouterTraceDecision: null,
    postRouterTraceHash: null,
    governedChangeArtifactEvaluated: false,
    governedChangeArtifactRequired: false,
    governedChangeArtifactRequiredSatisfied: true,
    governedChangeArtifactDecision: null,
    governedChangeArtifactBuilt: false,
    governedChangeApplyEligible: false,
    governedChangeKind: null,
    governedChangeMutationHash: null,
    governedChangeChangedFileCount: 0,
    governedChangePatchDryRunResultHash: null,
    governedChangeTemporaryApplyResultHash: null,
    governedChangeExecutionVerificationResultHash: null,
    governedChangeArtifactHash: null,
    governedChangeFreshnessEvaluated: false,
    governedChangeFreshnessDecision: null,
    governedChangeFreshnessCurrent: false,
    governedChangeHandoffEligible: false,
    governedChangeCurrentSnapshotHash: null,
    governedChangeStaleFieldCount: 0,
    controlledApplyHandoffApplicable: false,
    controlledApplyHandoffConfigured: false,
    controlledApplyHandoffRequired: false,
    controlledApplyHandoffRequiredSatisfied: true,
    controlledApplyHandoffEvaluated: false,
    controlledApplyHandoffDecision: null,
    controlledApplyHandoffBuilt: false,
    controlledApplyHandoffRepositoryIdentityHash: null,
    controlledApplyHandoffBaseRevisionHash: null,
    controlledApplyHandoffWorktreeStateHash: null,
    controlledApplyHandoffConstraintsHash: null,
    controlledApplyHandoffConsumptionKey: null,
    controlledApplyHandoffHash: null,
    controlledApplyHandoffVerificationEvaluated: false,
    controlledApplyHandoffVerificationDecision: null,
    controlledApplyHandoffConsumptionStatus: "unknown",
    controlledApplyHandoffExecutionEligible: false,
    controlledApplyHandoffStaleFieldCount: 0,
    controlledApplyApplyExecuted: false,
    controlledApplyRegistryWritten: false,
    controlledApplyRollbackPrepared: false
  };
}

function baseReport(config, status) {
  const finalDecision = status === "skipped" ? "skipped" : "blocked";

  return {
    ok: status === "skipped",
    status,
    suiteName: SUITE_NAME,
    caseId: fixture.caseId,
    configured: Boolean(config.upstreamUrl),
    forceRemask: config.forceRemask,
    finalDecision,
    orchestratorDecision: {
      finalDecision,
      reason: status === "skipped" ? "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured." : "",
      forcedRemask: config.forceRemask,
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
      tempWorkspaceApplyCalled: false,
      tempWorkspaceApplyDecision: null,
      tempWorkspaceApplyIssueCount: 0,
      tempWorkspaceApplyChangedFiles: null,
      tempWorkspaceApplyCleanedUp: null,
      ...emptyTemporaryWorkspaceExecutionDecision(),
      ...emptyAccountabilityDecisionSummary()
    },
    planner: emptyRoleReport(),
    coder: emptyRoleReport(),
    verifier: emptyVerifierReport(),
    remask: emptyRemaskReport(),
    repairVerifier: emptyRepairVerifierReport(),
    patchDryRun: emptyPatchDryRunReport(),
    tempWorkspaceApply: emptyTemporaryWorkspaceApplyReport(),
    tempWorkspaceExecution: emptyTemporaryWorkspaceExecutionReport(),
    accountability: emptyAccountabilityReport(),
    shadowObserver: {
      ...emptyShadowObserverReport(false, config.shadow.required),
      requiredSatisfied: true
    },
    governance: emptyGovernanceReport(),
    adminAgent: {
      ...emptyAdminAgentReport(false, config.admin.required),
      requiredSatisfied: true
    },
    approvalRouter: emptyApprovalRouterReport(),
    governedChangeArtifact: emptyGovernedChangeArtifactReport(),
    governedChangeFreshness: emptyGovernedChangeFreshnessReport(),
    controlledApplyHandoff: emptyControlledApplyHandoffReport(),
    controlledApplyHandoffVerification:
      emptyControlledApplyHandoffVerificationReport(),
    shadowStageDecision: "shadow_not_called",
    governanceStageDecision: "governance_not_evaluated",
    adminStageDecision: "admin_not_called",
    approvalRouterStageDecision: "approval_route_not_evaluated",
    governedChangeArtifactStageDecision: "governed_change_artifact_not_built",
    governedChangeFreshnessStageDecision: "governed_change_freshness_not_verified",
    controlledApplyHandoffStageDecision: "controlled_apply_handoff_not_built",
    controlledApplyHandoffVerificationStageDecision:
      "controlled_apply_handoff_not_verified",
    workflowRoute: null,
    jsonPath: "",
    markdownPath: ""
  };
}

function validationIssuesMarkdown(label, validation) {
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];

  if (issues.length === 0) {
    return `- ${label}: No issues.`;
  }

  return issues
    .map((issue) => `- ${label}: ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
}

function roleTokensMarkdown(label, result) {
  return [
    `- ${label} latency ms: ${result.latencyMs ?? ""}`,
    `- ${label} prompt tokens: ${result.promptTokens ?? ""}`,
    `- ${label} completion tokens: ${result.completionTokens ?? ""}`,
    `- ${label} total tokens: ${result.totalTokens ?? ""}`
  ].join("\n");
}

function mutationSummary(validation) {
  return validation && validation.mutation ? validation.mutation.summary : "";
}

function touchedFiles(validation) {
  return validation && validation.mutation ? validation.mutation.touchedFiles.join(", ") : "";
}

function verifierFindingSummary(verifier) {
  return verifier && verifier.finding ? verifier.finding.summary : "";
}

function verifierIssuesMarkdown(verifier) {
  const issues = verifier && Array.isArray(verifier.issues) ? verifier.issues : [];

  if (issues.length === 0) {
    return "- verifier: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.path || issue.file ? ` (${[issue.path, issue.file].filter(Boolean).join(", ")})` : "";
      return `- verifier: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function forcedVerifierFindingMarkdown(verifier) {
  if (!verifier || !verifier.forcedRemask || !verifier.finding) {
    return "";
  }

  return [
    "",
    "### Forced Verifier Finding",
    "",
    "```json",
    JSON.stringify(verifier.finding, null, 2),
    "```"
  ].join("\n");
}

function remaskRequestSummary(remask) {
  return remask && remask.request ? remask.request.summary : "";
}

function remaskRequestTouchedFiles(remask) {
  return remask && remask.request ? remask.request.touchedFiles.join(", ") : "";
}

function remaskRepairDraftSummary(remask) {
  return remask && remask.validation && remask.validation.mutation
    ? remask.validation.mutation.summary
    : "";
}

function remaskRepairDraftTouchedFiles(remask) {
  return remask && remask.validation && remask.validation.mutation
    ? remask.validation.mutation.touchedFiles.join(", ")
    : "";
}

function remaskIssuesMarkdown(remask) {
  const issues = remask && Array.isArray(remask.issues) ? remask.issues : [];

  if (issues.length === 0) {
    return "- remask: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.path || issue.file ? ` (${[issue.path, issue.file].filter(Boolean).join(", ")})` : "";
      return `- remask: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function remaskValidationIssuesMarkdown(remask) {
  const validation = remask && remask.validation ? remask.validation : null;
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];

  if (issues.length === 0) {
    return "- remask validation: No issues.";
  }

  return issues
    .map((issue) => `- remask validation: ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
}

function remaskRepairDraftCheckIssuesMarkdown(remask) {
  const checks = remask && remask.repairDraftChecks ? remask.repairDraftChecks : null;
  const issues = checks && Array.isArray(checks.issues) ? checks.issues : [];

  if (issues.length === 0) {
    return "- remask repairDraft checks: No issues.";
  }

  return issues
    .map((issue) => `- remask repairDraft checks: ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
}

function repairVerifierFindingSummary(repairVerifier) {
  return repairVerifier && repairVerifier.finding ? repairVerifier.finding.summary : "";
}

function repairVerifierIssueCodes(repairVerifier) {
  const issues = repairVerifier && Array.isArray(repairVerifier.issues) ? repairVerifier.issues : [];

  return issues.map((issue) => issue.code).join(", ");
}

function repairVerifierIssuesMarkdown(repairVerifier) {
  const issues = repairVerifier && Array.isArray(repairVerifier.issues) ? repairVerifier.issues : [];

  if (issues.length === 0) {
    return "- repair verifier: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.file ? ` (${issue.file})` : "";
      return `- repair verifier: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function patchDryRunIssuesMarkdown(patchDryRun) {
  const issues = patchDryRun && Array.isArray(patchDryRun.issues) ? patchDryRun.issues : [];

  if (issues.length === 0) {
    return "- patch dry run: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.file ? ` (${issue.file})` : "";
      return `- patch dry run: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function firstPatchDryRunDiffPreview(patchDryRun) {
  const previews = patchDryRun && Array.isArray(patchDryRun.previews) ? patchDryRun.previews : [];
  const firstPreview = previews[0];

  return firstPreview && typeof firstPreview.diffPreview === "string"
    ? firstPreview.diffPreview
    : "";
}

function firstTemporaryWorkspaceApplyDiffPreview(tempWorkspaceApply) {
  const appliedFiles = tempWorkspaceApply && Array.isArray(tempWorkspaceApply.appliedFiles)
    ? tempWorkspaceApply.appliedFiles
    : [];
  return appliedFiles[0] && typeof appliedFiles[0].diffPreview === "string"
    ? appliedFiles[0].diffPreview
    : "";
}

function temporaryWorkspaceApplyIssuesMarkdown(tempWorkspaceApply) {
  const issues = tempWorkspaceApply && Array.isArray(tempWorkspaceApply.issues)
    ? tempWorkspaceApply.issues
    : [];
  if (issues.length === 0) {
    return "- temporary workspace apply: No issues.";
  }
  return issues
    .map((issue) => {
      const location = issue.file ? ` (${issue.file})` : "";
      return `- temporary workspace apply: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function firstTemporaryWorkspaceExecutionCommand(tempWorkspaceExecution) {
  const commandResults =
    tempWorkspaceExecution && Array.isArray(tempWorkspaceExecution.commandResults)
      ? tempWorkspaceExecution.commandResults
      : [];
  return commandResults[0] ?? null;
}

function temporaryWorkspaceExecutionIssuesMarkdown(tempWorkspaceExecution) {
  const issues =
    tempWorkspaceExecution && Array.isArray(tempWorkspaceExecution.issues)
      ? tempWorkspaceExecution.issues
      : [];

  if (issues.length === 0) {
    return "- temporary workspace execution: No issues.";
  }

  return issues
    .map((issue) =>
      `- temporary workspace execution: ${issue.code}: ${issue.message}`
    )
    .join("\n");
}

function renderMarkdown(report, config) {
  const patchDryRunSummary = report.patchDryRun.summary;
  const firstExecutionCommand = firstTemporaryWorkspaceExecutionCommand(
    report.tempWorkspaceExecution
  );

  return [
    "# Worker-Backed Orchestrator Smoke",
    "",
    `- Suite: ${report.suiteName}`,
    `- Case: ${report.caseId}`,
    `- Configured endpoint: ${report.configured}`,
    `- Status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Final decision: ${report.finalDecision}`,
    `- Decision reason: ${report.orchestratorDecision.reason}`,
    `- Force remask mode: ${report.forceRemask}`,
    `- Planner called: ${report.planner.called}`,
    `- Planner validation OK: ${report.planner.validation.ok}`,
    `- Planner validation blocked: ${report.planner.validation.blocked}`,
    `- Coder called: ${report.coder.called}`,
    `- Coder validation OK: ${report.coder.validation.ok}`,
    `- Coder validation blocked: ${report.coder.validation.blocked}`,
    `- Verifier called: ${report.verifier.called}`,
    `- Verifier forced remask: ${report.verifier.forcedRemask}`,
    `- Verifier decision: ${report.verifier.decision ?? ""}`,
    `- Verifier issue count: ${report.verifier.issueCount}`,
    `- Remask called: ${report.remask.called}`,
    `- Remask requested: ${report.remask.requested}`,
    `- Remask repairability: ${report.remask.repairability ?? ""}`,
    `- Remask validation OK: ${report.remask.validation ? report.remask.validation.ok : ""}`,
    `- Remask validation blocked: ${report.remask.validation ? report.remask.validation.blocked : ""}`,
    `- RepairDraft checks OK: ${report.remask.repairDraftChecks ? report.remask.repairDraftChecks.ok : ""}`,
    `- Repair verifier called: ${report.repairVerifier.called}`,
    `- Repair verifier decision: ${report.repairVerifier.decision ?? ""}`,
    `- Repair verifier issue count: ${report.repairVerifier.issueCount}`,
    `- Patch dry run called: ${report.patchDryRun.called}`,
    `- Patch dry run decision: ${report.patchDryRun.decision ?? ""}`,
    `- Patch dry run issue count: ${report.patchDryRun.issueCount}`,
    `- Temporary workspace apply called: ${report.tempWorkspaceApply.called}`,
    `- Temporary workspace apply decision: ${report.tempWorkspaceApply.decision ?? ""}`,
    `- Temporary workspace apply issue count: ${report.tempWorkspaceApply.issueCount}`,
    `- Temporary workspace apply changed files: ${report.tempWorkspaceApply.changedFiles}`,
    `- Temporary workspace apply cleaned up: ${report.tempWorkspaceApply.cleanedUp ?? ""}`,
    `- Temporary workspace execution called: ${report.tempWorkspaceExecution.called}`,
    `- Temporary workspace execution decision: ${report.tempWorkspaceExecution.decision ?? ""}`,
    `- Temporary workspace execution cleanup performed: ${report.tempWorkspaceExecution.cleanupPerformed}`,
    `- Remask issue count: ${report.remask.issueCount}`,
    `- Planner mutation summary: ${mutationSummary(report.planner.validation)}`,
    `- Coder mutation summary: ${mutationSummary(report.coder.validation)}`,
    `- Planner touched files: ${touchedFiles(report.planner.validation)}`,
    `- Coder touched files: ${touchedFiles(report.coder.validation)}`,
    `- Verifier finding summary: ${verifierFindingSummary(report.verifier)}`,
    `- Remask request summary: ${remaskRequestSummary(report.remask)}`,
    `- RepairDraft summary: ${remaskRepairDraftSummary(report.remask)}`,
    "",
    "## Issues",
    "",
    validationIssuesMarkdown("planner", report.planner.validation),
    validationIssuesMarkdown("coder", report.coder.validation),
    verifierIssuesMarkdown(report.verifier),
    remaskIssuesMarkdown(report.remask),
    "",
    "## Verifier",
    "",
    `- Called: ${report.verifier.called}`,
    `- Decision: ${report.verifier.decision ?? ""}`,
    `- Issue count: ${report.verifier.issueCount}`,
    `- Finding summary: ${verifierFindingSummary(report.verifier)}`,
    "",
    "### Verifier Issues",
    "",
    verifierIssuesMarkdown(report.verifier),
    forcedVerifierFindingMarkdown(report.verifier),
    "",
    "## Remask",
    "",
    `- Called: ${report.remask.called}`,
    `- Requested: ${report.remask.requested}`,
    `- Repairability: ${report.remask.repairability ?? ""}`,
    `- Validation OK: ${report.remask.validation ? report.remask.validation.ok : ""}`,
    `- Validation blocked: ${report.remask.validation ? report.remask.validation.blocked : ""}`,
    `- RepairDraft checks OK: ${report.remask.repairDraftChecks ? report.remask.repairDraftChecks.ok : ""}`,
    `- Issue count: ${report.remask.issueCount}`,
    `- Request summary: ${remaskRequestSummary(report.remask)}`,
    `- RepairDraft summary: ${remaskRepairDraftSummary(report.remask)}`,
    `- Request touched files: ${remaskRequestTouchedFiles(report.remask)}`,
    `- RepairDraft touched files: ${remaskRepairDraftTouchedFiles(report.remask)}`,
    "",
    "### Remask Issues",
    "",
    remaskIssuesMarkdown(report.remask),
    remaskValidationIssuesMarkdown(report.remask),
    remaskRepairDraftCheckIssuesMarkdown(report.remask),
    "",
    "## Repair Verifier",
    "",
    `- Called: ${report.repairVerifier.called}`,
    `- Decision: ${report.repairVerifier.decision ?? ""}`,
    `- Issue count: ${report.repairVerifier.issueCount}`,
    `- Finding summary: ${repairVerifierFindingSummary(report.repairVerifier)}`,
    `- Issue codes: ${repairVerifierIssueCodes(report.repairVerifier)}`,
    `- Final repair decision: ${report.finalDecision}`,
    "",
    "### Repair Verifier Issues",
    "",
    repairVerifierIssuesMarkdown(report.repairVerifier),
    "",
    "## Patch Dry Run",
    "",
    `- Called: ${report.patchDryRun.called}`,
    `- Decision: ${report.patchDryRun.decision ?? ""}`,
    `- Issue count: ${report.patchDryRun.issueCount}`,
    `- Changed files: ${patchDryRunSummary ? patchDryRunSummary.changedFiles : ""}`,
    `- Added lines: ${patchDryRunSummary ? patchDryRunSummary.totalAddedLines : ""}`,
    `- Removed lines: ${patchDryRunSummary ? patchDryRunSummary.totalRemovedLines : ""}`,
    `- Final decision: ${report.finalDecision}`,
    "",
    "### Patch Dry Run Issues",
    "",
    patchDryRunIssuesMarkdown(report.patchDryRun),
    "",
    "### First Patch Dry Run Diff Preview",
    "",
    "```diff",
    firstPatchDryRunDiffPreview(report.patchDryRun),
    "```",
    "",
    "## Temporary Workspace Apply",
    "",
    `- Called: ${report.tempWorkspaceApply.called}`,
    `- Decision: ${report.tempWorkspaceApply.decision ?? ""}`,
    `- Issue count: ${report.tempWorkspaceApply.issueCount}`,
    `- Changed files: ${report.tempWorkspaceApply.changedFiles}`,
    `- Cleaned up: ${report.tempWorkspaceApply.cleanedUp ?? ""}`,
    `- Temp workspace path: ${report.tempWorkspaceApply.tempWorkspacePath ?? ""}`,
    `- Final decision: ${report.finalDecision}`,
    "",
    "### Temporary Workspace Apply Issues",
    "",
    temporaryWorkspaceApplyIssuesMarkdown(report.tempWorkspaceApply),
    "",
    "### First Applied File Diff Preview",
    "",
    "```diff",
    firstTemporaryWorkspaceApplyDiffPreview(report.tempWorkspaceApply),
    "```",
    "",
    "## Temporary Workspace Execution Verification",
    "",
    `- Called: ${report.tempWorkspaceExecution.called}`,
    `- Decision: ${report.tempWorkspaceExecution.decision ?? ""}`,
    `- Issue count: ${report.tempWorkspaceExecution.issueCount}`,
    `- Command count: ${report.tempWorkspaceExecution.commandCount}`,
    `- Passed commands: ${report.tempWorkspaceExecution.passedCommands}`,
    `- Failed commands: ${report.tempWorkspaceExecution.failedCommands}`,
    `- Timed-out commands: ${report.tempWorkspaceExecution.timedOutCommands}`,
    `- Truncated outputs: ${report.tempWorkspaceExecution.truncatedOutputs}`,
    `- Execution duration ms: ${report.tempWorkspaceExecution.durationMs}`,
    `- Cleanup attempted: ${report.tempWorkspaceExecution.cleanupAttempted}`,
    `- Cleanup performed: ${report.tempWorkspaceExecution.cleanupPerformed}`,
    `- Cleanup error: ${report.tempWorkspaceExecution.cleanupError ?? ""}`,
    `- First command executable: ${firstExecutionCommand ? firstExecutionCommand.executable : ""}`,
    `- First command args: ${firstExecutionCommand ? JSON.stringify(firstExecutionCommand.args) : ""}`,
    `- First command exit code: ${firstExecutionCommand ? firstExecutionCommand.exitCode ?? "" : ""}`,
    `- First command stdout: ${firstExecutionCommand ? preview(firstExecutionCommand.stdout, 1000) : ""}`,
    `- First command stderr: ${firstExecutionCommand ? preview(firstExecutionCommand.stderr, 1000) : ""}`,
    `- Final decision: ${report.finalDecision}`,
    "",
    "### Temporary Workspace Execution Issues",
    "",
    temporaryWorkspaceExecutionIssuesMarkdown(report.tempWorkspaceExecution),
    "",
    "## Agent Event Ledger",
    "",
    `- Created: ${report.accountability.ledgerCreated}`,
    `- Evidence complete: ${report.accountability.evidenceComplete}`,
    `- Run ID: ${report.accountability.runId ?? ""}`,
    `- Event count before Shadow: ${report.accountability.eventCountBeforeShadow}`,
    `- Event count after Shadow: ${report.accountability.eventCountAfterShadow}`,
    `- Event count after Governance: ${report.accountability.eventCountAfterGovernance}`,
    `- Event count after Admin: ${report.accountability.eventCountAfterAdmin}`,
    `- Event count after Router: ${report.accountability.eventCountAfterRouter}`,
    `- Root hash before Shadow: ${report.accountability.ledgerRootHashBeforeShadow ?? ""}`,
    `- Root hash after Shadow: ${report.accountability.ledgerRootHashAfterShadow ?? ""}`,
    `- Root hash after Governance: ${report.accountability.ledgerRootHashAfterGovernance ?? ""}`,
    `- Root hash after Admin: ${report.accountability.ledgerRootHashAfterAdmin ?? ""}`,
    `- Root hash after Router: ${report.accountability.ledgerRootHashAfterRouter ?? ""}`,
    `- Actor/action sequence: ${report.accountability.ledger
      ? report.accountability.ledger.events.map((event) => `${event.actor}/${event.action}`).join(", ")
      : ""}`,
    "",
    "## Accountability Trace",
    "",
    `- Pre-Shadow trace decision: ${report.accountability.preShadowTraceDecision ?? ""}`,
    `- Pre-Shadow trace hash: ${report.accountability.preShadowTraceHash ?? ""}`,
    `- Finding count: ${report.accountability.preShadowFindingCount}`,
    `- Warning count: ${report.accountability.preShadowWarningCount}`,
    `- Error count: ${report.accountability.preShadowErrorCount}`,
    `- Planned file count: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.files.plannedFileCount : 0}`,
    `- Proposed file count: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.files.proposedFileCount : 0}`,
    `- Unplanned proposed file count: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.files.unplannedProposedFiles.length : 0}`,
    `- Repair count: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.repairActivity.repairCount : 0}`,
    `- Remask count: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.repairActivity.remaskCount : 0}`,
    `- Execution terminal decision: ${report.accountability.preShadowTrace ? report.accountability.preShadowTrace.decisions.finalExecutionDecision ?? "" : ""}`,
    "",
    "## Shadow Observer",
    "",
    `- Configured: ${report.shadowObserver.configured}`,
    `- Required: ${report.shadowObserver.required}`,
    `- Called: ${report.shadowObserver.called}`,
    `- Adapter decision: ${report.shadowObserver.decision ?? ""}`,
    `- Validation decision: ${report.shadowObserver.validationDecision ?? ""}`,
    `- Required satisfied: ${report.shadowObserver.requiredSatisfied}`,
    `- Risk level: ${report.shadowObserver.riskLevel ?? ""}`,
    `- Risk score: ${report.shadowObserver.riskScore ?? ""}`,
    `- Confidence score: ${report.shadowObserver.confidenceScore ?? ""}`,
    `- Recommendation: ${report.shadowObserver.recommendation ?? ""}`,
    `- Finding count: ${report.shadowObserver.findingCount}`,
    `- Observation hash: ${report.shadowObserver.observationHash ?? ""}`,
    `- Response-content hash: ${report.shadowObserver.responseContentHash ?? ""}`,
    `- Input tokens: ${report.shadowObserver.inputTokens ?? ""}`,
    `- Output tokens: ${report.shadowObserver.outputTokens ?? ""}`,
    `- Total tokens: ${report.shadowObserver.totalTokens ?? ""}`,
    `- Issue codes: ${report.shadowObserver.issueCodes.join(", ")}`,
    "",
    "## Post-Shadow Audit State",
    "",
    `- Shadow event appended: ${report.shadowObserver.eventAppended}`,
    `- Post-Shadow ledger decision: ${report.accountability.postShadowLedgerVerificationDecision ?? ""}`,
    `- Post-Shadow root hash: ${report.accountability.ledgerRootHashAfterShadow ?? ""}`,
    `- Post-Shadow trace decision: ${report.accountability.postShadowTraceDecision ?? ""}`,
    `- Post-Shadow trace hash: ${report.accountability.postShadowTraceHash ?? ""}`,
    `- Final Phase V decision: ${report.finalDecision}`,
    `- Shadow stage decision: ${report.shadowStageDecision}`,
    "",
    "## Deterministic Governance",
    "",
    `- Evaluated: ${report.governance.evaluated}`,
    `- Decision: ${report.governance.decision ?? ""}`,
    `- Risk class: ${report.governance.riskClass ?? ""}`,
    `- Trace hash: ${report.governance.traceHash ?? ""}`,
    `- Observation hash: ${report.governance.observationHash ?? ""}`,
    `- Policy hash: ${report.governance.policyHash ?? ""}`,
    `- Governance hash: ${report.governance.governanceHash ?? ""}`,
    `- Triggered-rule count: ${report.governance.triggeredRuleCount}`,
    `- Terminate-rule count: ${report.governance.terminateRuleCount}`,
    `- Escalation-rule count: ${report.governance.escalationRuleCount}`,
    `- Replan-rule count: ${report.governance.replanRuleCount}`,
    `- Repair-rule count: ${report.governance.repairRuleCount}`,
    `- Reason codes: ${report.governance.reasonCodes.join(", ")}`,
    `- Issue codes: ${report.governance.issueCodes.join(", ")}`,
    `- Governor event appended: ${report.governance.eventAppended}`,
    "",
    "## Admin Agent",
    "",
    `- Configured: ${report.adminAgent.configured}`,
    `- Required: ${report.adminAgent.required}`,
    `- Called: ${report.adminAgent.called}`,
    `- Adapter decision: ${report.adminAgent.adapterDecision ?? ""}`,
    `- Validation decision: ${report.adminAgent.validationDecision ?? ""}`,
    `- Required satisfied: ${report.adminAgent.requiredSatisfied}`,
    `- Governance decision: ${report.adminAgent.governanceDecision ?? ""}`,
    `- Admin decision: ${report.adminAgent.decision ?? ""}`,
    `- Risk level: ${report.adminAgent.riskLevel ?? ""}`,
    `- Risk score: ${report.adminAgent.riskScore ?? ""}`,
    `- Confidence score: ${report.adminAgent.confidenceScore ?? ""}`,
    `- Finding count: ${report.adminAgent.findingCount}`,
    `- Admin decision hash: ${report.adminAgent.adminDecisionHash ?? ""}`,
    `- Response-content hash: ${report.adminAgent.responseContentHash ?? ""}`,
    `- Input tokens: ${report.adminAgent.inputTokens ?? ""}`,
    `- Output tokens: ${report.adminAgent.outputTokens ?? ""}`,
    `- Total tokens: ${report.adminAgent.totalTokens ?? ""}`,
    `- Issue codes: ${report.adminAgent.issueCodes.join(", ")}`,
    `- Admin event appended: ${report.adminAgent.eventAppended}`,
    "",
    "## Post-Governance Audit State",
    "",
    `- Event count: ${report.accountability.eventCountAfterGovernance}`,
    `- Ledger root hash: ${report.accountability.ledgerRootHashAfterGovernance ?? ""}`,
    `- Ledger-verification decision: ${report.accountability.postGovernanceLedgerVerificationDecision ?? ""}`,
    `- Trace decision: ${report.accountability.postGovernanceTraceDecision ?? ""}`,
    `- Trace hash: ${report.accountability.postGovernanceTraceHash ?? ""}`,
    `- Finding count: ${report.accountability.postGovernanceFindingCount}`,
    "",
    "## Post-Admin Audit State",
    "",
    `- Event count: ${report.accountability.eventCountAfterAdmin}`,
    `- Ledger root hash: ${report.accountability.ledgerRootHashAfterAdmin ?? ""}`,
    `- Ledger-verification decision: ${report.accountability.postAdminLedgerVerificationDecision ?? ""}`,
    `- Trace decision: ${report.accountability.postAdminTraceDecision ?? ""}`,
    `- Trace hash: ${report.accountability.postAdminTraceHash ?? ""}`,
    `- Finding count: ${report.accountability.postAdminFindingCount}`,
    `- Phase V final decision: ${report.finalDecision}`,
    `- Shadow stage decision: ${report.shadowStageDecision}`,
    `- Governance stage decision: ${report.governanceStageDecision}`,
    `- Admin stage decision: ${report.adminStageDecision}`,
    "",
    "## Risk-Based Approval Router",
    "",
    `- Evaluated: ${report.approvalRouter.evaluated}`,
    `- Required: ${report.approvalRouter.required}`,
    `- Required satisfied: ${report.approvalRouter.requiredSatisfied}`,
    `- Validation decision: ${report.approvalRouter.validationDecision ?? ""}`,
    `- Workflow route: ${report.approvalRouter.route ?? ""}`,
    `- Risk class: ${report.approvalRouter.riskClass ?? ""}`,
    `- Phase V final decision: ${report.approvalRouter.phaseVFinalDecision ?? ""}`,
    `- Shadow stage decision: ${report.approvalRouter.shadowStageDecision ?? ""}`,
    `- Governance decision: ${report.approvalRouter.governanceDecision ?? ""}`,
    `- Admin stage decision: ${report.approvalRouter.adminStageDecision ?? ""}`,
    `- Admin decision: ${report.approvalRouter.adminDecision ?? ""}`,
    `- Trace hash: ${report.approvalRouter.traceHash ?? ""}`,
    `- Observation hash: ${report.approvalRouter.observationHash ?? ""}`,
    `- Governance hash: ${report.approvalRouter.governanceHash ?? ""}`,
    `- Admin decision hash: ${report.approvalRouter.adminDecisionHash ?? ""}`,
    `- Policy hash: ${report.approvalRouter.policyHash ?? ""}`,
    `- Route hash: ${report.approvalRouter.routeHash ?? ""}`,
    `- Triggered-rule count: ${report.approvalRouter.triggeredRuleCount}`,
    `- Repair-rule count: ${report.approvalRouter.repairRuleCount}`,
    `- Replan-rule count: ${report.approvalRouter.replanRuleCount}`,
    `- Human-rule count: ${report.approvalRouter.humanRuleCount}`,
    `- Terminate-rule count: ${report.approvalRouter.terminateRuleCount}`,
    `- Deterministic authority preserved: ${report.approvalRouter.deterministicAuthorityPreserved}`,
    `- Auto-continue eligible: ${report.approvalRouter.autoContinueEligible}`,
    `- Reason codes: ${report.approvalRouter.reasonCodes.join(", ")}`,
    `- Issue codes: ${report.approvalRouter.issueCodes.join(", ")}`,
    `- Router event appended: ${report.approvalRouter.eventAppended}`,
    "",
    "## Post-Router Final Audit State",
    "",
    `- Event count: ${report.accountability.eventCountAfterRouter}`,
    `- Ledger root hash: ${report.accountability.ledgerRootHashAfterRouter ?? ""}`,
    `- Ledger-verification decision: ${report.accountability.postRouterLedgerVerificationDecision ?? ""}`,
    `- Trace decision: ${report.accountability.postRouterTraceDecision ?? ""}`,
    `- Trace hash: ${report.accountability.postRouterTraceHash ?? ""}`,
    `- Finding count: ${report.accountability.postRouterFindingCount}`,
    `- Final Phase V decision: ${report.finalDecision}`,
    `- Shadow stage decision: ${report.shadowStageDecision}`,
    `- Governance stage decision: ${report.governanceStageDecision}`,
    `- Admin stage decision: ${report.adminStageDecision}`,
    `- Router validation decision: ${report.approvalRouterStageDecision}`,
    `- Workflow route: ${report.workflowRoute ?? ""}`,
    "",
    "## Governed Change Artifact",
    "",
    `- Evaluated: ${report.governedChangeArtifact.evaluated}`,
    `- Required: ${report.governedChangeArtifact.required}`,
    `- Required satisfied: ${report.governedChangeArtifact.requiredSatisfied}`,
    `- Artifact decision: ${report.governedChangeArtifact.decision ?? ""}`,
    `- Artifact built: ${report.governedChangeArtifact.artifactBuilt}`,
    `- Apply eligible: ${report.governedChangeArtifact.applyEligible}`,
    `- Change kind: ${report.governedChangeArtifact.changeKind ?? ""}`,
    `- Mutation hash: ${report.governedChangeArtifact.mutationHash ?? ""}`,
    `- Changed-file count: ${report.governedChangeArtifact.changedFileCount}`,
    `- Patch dry-run result hash: ${report.governedChangeArtifact.patchDryRunResultHash ?? ""}`,
    `- Temporary-apply result hash: ${report.governedChangeArtifact.temporaryApplyResultHash ?? ""}`,
    `- Execution-verification result hash: ${report.governedChangeArtifact.executionVerificationResultHash ?? ""}`,
    `- Pre-Shadow trace hash: ${report.governedChangeArtifact.preShadowTraceHash ?? ""}`,
    `- Observation hash: ${report.governedChangeArtifact.observationHash ?? ""}`,
    `- Governance hash: ${report.governedChangeArtifact.governanceHash ?? ""}`,
    `- Admin decision hash: ${report.governedChangeArtifact.adminDecisionHash ?? ""}`,
    `- Route hash: ${report.governedChangeArtifact.routeHash ?? ""}`,
    `- Governance policy hash: ${report.governedChangeArtifact.governancePolicyHash ?? ""}`,
    `- Router policy hash: ${report.governedChangeArtifact.routerPolicyHash ?? ""}`,
    `- Final ledger root hash: ${report.governedChangeArtifact.finalLedgerRootHash ?? ""}`,
    `- Final ledger event count: ${report.governedChangeArtifact.finalLedgerEventCount}`,
    `- Governed artifact hash: ${report.governedChangeArtifact.governedArtifactHash ?? ""}`,
    `- Eligibility reason codes: ${report.governedChangeArtifact.eligibilityReasonCodes.join(", ")}`,
    `- Issue codes: ${report.governedChangeArtifact.issueCodes.join(", ")}`,
    `- Duration (ms): ${report.governedChangeArtifact.durationMs}`,
    "",
    "## Governed Change Freshness",
    "",
    `- Evaluated: ${report.governedChangeFreshness.evaluated}`,
    `- Decision: ${report.governedChangeFreshness.decision ?? ""}`,
    `- Artifact integrity verified: ${report.governedChangeFreshness.artifactIntegrityVerified}`,
    `- Current snapshot hash: ${report.governedChangeFreshness.currentSnapshotHash ?? ""}`,
    `- Snapshot current: ${report.governedChangeFreshness.snapshotCurrent}`,
    `- Stale fields: ${report.governedChangeFreshness.staleFields.join(", ")}`,
    `- Reason codes: ${report.governedChangeFreshness.reasonCodes.join(", ")}`,
    `- Handoff eligible: ${report.governedChangeFreshness.handoffEligible}`,
    "",
    "Handoff eligibility is evidence only.",
    "No repository application or handoff was executed.",
    "",
    "## Controlled Apply Handoff",
    "",
    `- Evaluated: ${report.controlledApplyHandoff.evaluated}`,
    `- Applicable: ${report.controlledApplyHandoff.applicable}`,
    `- Configured: ${report.controlledApplyHandoff.configured}`,
    `- Required: ${report.controlledApplyHandoff.required}`,
    `- Required satisfied: ${report.controlledApplyHandoff.requiredSatisfied}`,
    `- Decision: ${report.controlledApplyHandoff.decision ?? ""}`,
    `- Handoff built: ${report.controlledApplyHandoff.handoffBuilt}`,
    `- Mutation hash: ${report.controlledApplyHandoff.mutationHash ?? ""}`,
    `- Changed-file count: ${report.controlledApplyHandoff.changedFileCount}`,
    `- Governed artifact hash: ${report.controlledApplyHandoff.governedArtifactHash ?? ""}`,
    `- Current snapshot hash: ${report.controlledApplyHandoff.currentSnapshotHash ?? ""}`,
    `- Repository identity hash: ${report.controlledApplyHandoff.repositoryIdentityHash ?? ""}`,
    `- Base revision hash: ${report.controlledApplyHandoff.baseRevisionHash ?? ""}`,
    `- Worktree state hash: ${report.controlledApplyHandoff.worktreeStateHash ?? ""}`,
    `- Constraints hash: ${report.controlledApplyHandoff.constraintsHash ?? ""}`,
    `- Consumption key: ${report.controlledApplyHandoff.consumptionKey ?? ""}`,
    `- Handoff hash: ${report.controlledApplyHandoff.handoffHash ?? ""}`,
    `- External consumption registry required: ${report.controlledApplyHandoff.externalConsumptionRegistryRequired}`,
    `- Issue codes: ${report.controlledApplyHandoff.issueCodes.join(", ")}`,
    `- Duration (ms): ${report.controlledApplyHandoff.durationMs}`,
    `- Apply executed: ${report.controlledApplyHandoff.applyExecuted}`,
    `- Registry written: ${report.controlledApplyHandoff.registryWritten}`,
    `- Rollback prepared: ${report.controlledApplyHandoff.rollbackPrepared}`,
    "",
    "## Controlled Apply Handoff Verification",
    "",
    `- Evaluated: ${report.controlledApplyHandoffVerification.evaluated}`,
    `- Decision: ${report.controlledApplyHandoffVerification.decision ?? ""}`,
    `- Consumption status: ${report.controlledApplyHandoffVerification.consumptionStatus}`,
    `- Consumption status externally supplied: ${report.controlledApplyHandoffVerification.consumptionStatusExternallySupplied}`,
    `- Handoff integrity verified: ${report.controlledApplyHandoffVerification.handoffIntegrityVerified}`,
    `- Artifact integrity verified: ${report.controlledApplyHandoffVerification.artifactIntegrityVerified}`,
    `- Current snapshot hash: ${report.controlledApplyHandoffVerification.currentSnapshotHash ?? ""}`,
    `- Current mutation hash: ${report.controlledApplyHandoffVerification.currentMutationHash ?? ""}`,
    `- Stale fields: ${report.controlledApplyHandoffVerification.staleFields.join(", ")}`,
    `- Reason codes: ${report.controlledApplyHandoffVerification.reasonCodes.join(", ")}`,
    `- Execution eligible: ${report.controlledApplyHandoffVerification.executionEligible}`,
    "",
    "No repository application was executed.",
    "",
    "No consumption key was persisted or reserved.",
    "",
    "Execution eligibility requires a future executor,",
    "a fresh repository-state check, rollback preparation,",
    "and a durable external consumption registry.",
    "",
    "### Remask Raw Output Preview",
    "",
    "```text",
    report.remask.rawOutputPreview || "",
    "```",
    "",
    "## Latency And Tokens",
    "",
    roleTokensMarkdown("planner", report.planner),
    roleTokensMarkdown("coder", report.coder),
    roleTokensMarkdown("remask", report.remask),
    "",
    "## Planner Raw Output Preview",
    "",
    "```text",
    report.planner.rawOutputPreview || "",
    "```",
    "",
    "## Coder Raw Output Preview",
    "",
    "```text",
    report.coder.rawOutputPreview || "",
    "```",
    ""
  ].join("\n");
}

function writeReport(report, config) {
  const outDir = ensureDir(path.resolve(process.cwd(), config.outDir));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-worker-backed-orchestrator-smoke.json`);
  const markdownPath = path.join(outDir, `${timestamp}-worker-backed-orchestrator-smoke.md`);
  const redactedStringFields = new Set([
    "rawOutputPreview",
    "proposedPatch",
    "originalContent",
    "proposedContent",
    "appliedContent",
    "diffPreview",
    "stdout",
    "stderr"
  ]);
  const sanitizedReport = JSON.parse(JSON.stringify(report, (key, value) => {
    if (redactedStringFields.has(key)) return "";
    if (key === "args" && Array.isArray(value)) return [];
    return value;
  }));
  const reportWithPaths = {
    ...sanitizedReport,
    jsonPath,
    markdownPath
  };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths, config));

  return reportWithPaths;
}

function extractContent(data) {
  const firstChoice = data && Array.isArray(data.choices) ? data.choices[0] : null;

  if (firstChoice && firstChoice.message && typeof firstChoice.message.content === "string") {
    return firstChoice.message.content;
  }

  if (firstChoice && typeof firstChoice.text === "string") {
    return firstChoice.text;
  }

  return "";
}

function tokenUsage(data) {
  const usage = data && typeof data === "object" ? data.usage : null;

  return {
    promptTokens: usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completionTokens: usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    totalTokens: usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null
  };
}

async function loadValidator() {
  const validatorPath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "model-mutation-validator.js")
  );
  return import(validatorPath.href);
}

async function loadDeterministicVerifierGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "deterministic-verifier-gate.js")
  );
  return import(gatePath.href);
}

async function loadRemaskRequestBuilder() {
  const builderPath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "remask-request-builder.js")
  );
  return import(builderPath.href);
}

async function loadRepairDraftVerifierGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "repair-draft-verifier-gate.js")
  );
  return import(gatePath.href);
}

async function loadPatchApplicationDryRunGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "patch-application-dry-run-gate.js")
  );
  return import(gatePath.href);
}

async function loadTemporaryWorkspaceApplyGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "temporary-workspace-apply-gate.js")
  );
  return import(gatePath.href);
}

async function loadTemporaryWorkspaceExecutionVerifier() {
  const verifierPath = pathToFileURL(
    path.join(
      process.cwd(),
      "dist",
      "packages",
      "product-runtime",
      "src",
      "temporary-workspace-execution-verifier.js"
    )
  );
  return import(verifierPath.href);
}

async function loadAccountabilityRuntime() {
  const runtimePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "index.js")
  );
  return import(runtimePath.href);
}

function timestampNow(notBefore = null) {
  const now = new Date().toISOString();
  return notBefore !== null && Date.parse(now) < Date.parse(notBefore)
    ? notBefore
    : now;
}

function boundedCodes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => value && typeof value === "object" ? value.code : value)
    .filter((value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      /^[A-Za-z0-9._:-]+$/.test(value)
    ))].slice(0, 64);
}

function boundedFiles(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => typeof value === "string" ? value : value && value.file)
    .filter((value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ))].slice(0, 128);
}

function validTokenUsage(report) {
  const inputTokens = report && report.promptTokens;
  const outputTokens = report && report.completionTokens;
  const totalTokens = report && report.totalTokens;
  return Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
    Number.isSafeInteger(outputTokens) && outputTokens >= 0 &&
    Number.isSafeInteger(totalTokens) && totalTokens === inputTokens + outputTokens
    ? { inputTokens, outputTokens, totalTokens }
    : undefined;
}

function labeledHash(runtime, artifactType, value) {
  return runtime.hashCanonicalJson({ artifactType, value });
}

function createAccountabilityContext(runtime) {
  const objectiveHash = runtime.hashCanonicalJson({
    artifactType: "worker_orchestrator_objective",
    objective: fixture.task
  });
  return {
    runtime,
    ledger: runtime.createAgentEventLedger({
      runId: `worker-orchestrator:${fixture.caseId}`,
      objectiveHash
    }),
    objectiveHash,
    issueCodes: [],
    evidenceComplete: true,
    hashes: {},
    governedChange: {
      changeKind: null,
      mutation: null,
      mutationHash: null,
      changedFiles: [],
      patchDryRunResultHash: null,
      temporaryApplyResultHash: null,
      executionVerificationResultHash: null
    }
  };
}

function setActiveGovernedChange(context, changeKind, mutation, mutationHash) {
  if (!context || !context.governedChange ||
      !new Set(["coder_patch_draft", "repair_draft"]).has(changeKind) ||
      !mutation || !Array.isArray(mutation.touchedFiles) ||
      typeof mutationHash !== "string") {
    return false;
  }
  context.governedChange.changeKind = changeKind;
  context.governedChange.mutation = mutation;
  context.governedChange.mutationHash = mutationHash;
  context.governedChange.changedFiles = boundedFiles(mutation.touchedFiles);
  context.governedChange.patchDryRunResultHash = null;
  context.governedChange.temporaryApplyResultHash = null;
  context.governedChange.executionVerificationResultHash = null;
  return true;
}

function appendAccountabilityEvent(context, draft) {
  try {
    context.ledger = context.runtime.appendAgentEvent(context.ledger, {
      ...draft,
      inputArtifactHashes: [...new Set(draft.inputArtifactHashes.filter(Boolean))],
      outputArtifactHashes: [...new Set(draft.outputArtifactHashes.filter(Boolean))],
      filesRead: boundedFiles(draft.filesRead),
      filesProposed: boundedFiles(draft.filesProposed),
      reasonCodes: boundedCodes(draft.reasonCodes)
    });
    return true;
  } catch {
    context.evidenceComplete = false;
    context.issueCodes.push("accountability_event_append_failed");
    return false;
  }
}

function exactLedgerAnchors(ledger) {
  return {
    expectedRunId: ledger.runId,
    expectedObjectiveHash: ledger.objectiveHash,
    expectedRootHash: ledger.rootHash,
    expectedEventCount: ledger.eventCount
  };
}

function citedObservationFiles(observation) {
  return boundedFiles(
    observation && Array.isArray(observation.findings)
      ? observation.findings.flatMap((finding) => finding.evidenceFilePaths || [])
      : []
  );
}

function governanceEvidenceFiles(assessment) {
  return boundedFiles([
    ...assessment.issues.flatMap((issue) => issue.filePaths),
    ...assessment.ruleResults.flatMap((rule) => rule.filePaths)
  ]);
}

function adminEvidenceFiles(adminDecision) {
  return boundedFiles(adminDecision
    ? adminDecision.findings.flatMap((finding) => finding.evidenceFilePaths)
    : []);
}

function approvalRouterEvidenceFiles(assessment, result) {
  if (assessment) {
    return boundedFiles([
      ...assessment.issues.flatMap((issue) => issue.filePaths),
      ...assessment.ruleResults.flatMap((rule) => rule.filePaths)
    ]);
  }
  return boundedFiles(result
    ? result.issues.flatMap((issue) => issue.filePaths)
    : []);
}

function populateDecisionAccountability(report) {
  Object.assign(report.orchestratorDecision, {
    agentLedgerCreated: report.accountability.ledgerCreated,
    agentLedgerEvidenceComplete: report.accountability.evidenceComplete,
    agentLedgerEventCountBeforeShadow: report.accountability.eventCountBeforeShadow,
    agentLedgerEventCountAfterShadow: report.accountability.eventCountAfterShadow,
    agentLedgerRootHashBeforeShadow: report.accountability.ledgerRootHashBeforeShadow,
    agentLedgerRootHashAfterShadow: report.accountability.ledgerRootHashAfterShadow,
    agentLedgerVerificationDecision:
      report.accountability.preShadowLedgerVerificationDecision,
    accountabilityTraceDecision: report.accountability.preShadowTraceDecision,
    accountabilityTraceHash: report.accountability.preShadowTraceHash,
    shadowObserverConfigured: report.shadowObserver.configured,
    shadowObserverRequired: report.shadowObserver.required,
    shadowObserverCalled: report.shadowObserver.called,
    shadowObserverDecision: report.shadowObserver.decision,
    shadowObserverValidationDecision: report.shadowObserver.validationDecision,
    shadowObserverRequiredSatisfied: report.shadowObserver.requiredSatisfied,
    shadowObserverRiskLevel: report.shadowObserver.riskLevel,
    shadowObserverRiskScore: report.shadowObserver.riskScore,
    shadowObserverRecommendation: report.shadowObserver.recommendation,
    shadowObserverFindingCount: report.shadowObserver.findingCount,
    shadowObserverObservationHash: report.shadowObserver.observationHash,
    shadowObserverEventAppended: report.shadowObserver.eventAppended,
    postShadowLedgerVerificationDecision:
      report.accountability.postShadowLedgerVerificationDecision,
    postShadowTraceDecision: report.accountability.postShadowTraceDecision,
    postShadowTraceHash: report.accountability.postShadowTraceHash,
    governanceEvaluated: report.governance.evaluated,
    governanceDecision: report.governance.decision,
    governanceRiskClass: report.governance.riskClass,
    governancePolicyHash: report.governance.policyHash,
    governanceHash: report.governance.governanceHash,
    governanceTriggeredRuleCount: report.governance.triggeredRuleCount,
    governanceEventAppended: report.governance.eventAppended,
    adminAgentConfigured: report.adminAgent.configured,
    adminAgentRequired: report.adminAgent.required,
    adminAgentCalled: report.adminAgent.called,
    adminAgentAdapterDecision: report.adminAgent.adapterDecision,
    adminAgentValidationDecision: report.adminAgent.validationDecision,
    adminAgentRequiredSatisfied: report.adminAgent.requiredSatisfied,
    adminDecision: report.adminAgent.decision,
    adminRiskLevel: report.adminAgent.riskLevel,
    adminRiskScore: report.adminAgent.riskScore,
    adminFindingCount: report.adminAgent.findingCount,
    adminDecisionHash: report.adminAgent.adminDecisionHash,
    adminEventAppended: report.adminAgent.eventAppended,
    agentLedgerEventCountAfterGovernance: report.accountability.eventCountAfterGovernance,
    agentLedgerEventCountAfterAdmin: report.accountability.eventCountAfterAdmin,
    agentLedgerRootHashAfterGovernance: report.accountability.ledgerRootHashAfterGovernance,
    agentLedgerRootHashAfterAdmin: report.accountability.ledgerRootHashAfterAdmin,
    postGovernanceLedgerVerificationDecision:
      report.accountability.postGovernanceLedgerVerificationDecision,
    postGovernanceTraceDecision: report.accountability.postGovernanceTraceDecision,
    postGovernanceTraceHash: report.accountability.postGovernanceTraceHash,
    postAdminLedgerVerificationDecision:
      report.accountability.postAdminLedgerVerificationDecision,
    postAdminTraceDecision: report.accountability.postAdminTraceDecision,
    postAdminTraceHash: report.accountability.postAdminTraceHash,
    approvalRouterEvaluated: report.approvalRouter.evaluated,
    approvalRouterValidationDecision: report.approvalRouter.validationDecision,
    approvalWorkflowRoute: report.approvalRouter.route,
    approvalRouterRiskClass: report.approvalRouter.riskClass,
    approvalRouterPolicyHash: report.approvalRouter.policyHash,
    approvalRouteHash: report.approvalRouter.routeHash,
    approvalRouterTriggeredRuleCount: report.approvalRouter.triggeredRuleCount,
    approvalRouterRepairRuleCount: report.approvalRouter.repairRuleCount,
    approvalRouterReplanRuleCount: report.approvalRouter.replanRuleCount,
    approvalRouterHumanRuleCount: report.approvalRouter.humanRuleCount,
    approvalRouterTerminateRuleCount: report.approvalRouter.terminateRuleCount,
    approvalRouterDeterministicAuthorityPreserved:
      report.approvalRouter.deterministicAuthorityPreserved,
    approvalRouterAutoContinueEligible: report.approvalRouter.autoContinueEligible,
    approvalRouterEventAppended: report.approvalRouter.eventAppended,
    agentLedgerEventCountAfterRouter: report.accountability.eventCountAfterRouter,
    agentLedgerRootHashAfterRouter: report.accountability.ledgerRootHashAfterRouter,
    postRouterLedgerVerificationDecision:
      report.accountability.postRouterLedgerVerificationDecision,
    postRouterTraceDecision: report.accountability.postRouterTraceDecision,
    postRouterTraceHash: report.accountability.postRouterTraceHash,
    governedChangeArtifactEvaluated: report.governedChangeArtifact.evaluated,
    governedChangeArtifactRequired: report.governedChangeArtifact.required,
    governedChangeArtifactRequiredSatisfied:
      report.governedChangeArtifact.requiredSatisfied,
    governedChangeArtifactDecision: report.governedChangeArtifact.decision,
    governedChangeArtifactBuilt: report.governedChangeArtifact.artifactBuilt,
    governedChangeApplyEligible: report.governedChangeArtifact.applyEligible,
    governedChangeKind: report.governedChangeArtifact.changeKind,
    governedChangeMutationHash: report.governedChangeArtifact.mutationHash,
    governedChangeChangedFileCount: report.governedChangeArtifact.changedFileCount,
    governedChangePatchDryRunResultHash:
      report.governedChangeArtifact.patchDryRunResultHash,
    governedChangeTemporaryApplyResultHash:
      report.governedChangeArtifact.temporaryApplyResultHash,
    governedChangeExecutionVerificationResultHash:
      report.governedChangeArtifact.executionVerificationResultHash,
    governedChangeArtifactHash: report.governedChangeArtifact.governedArtifactHash,
    governedChangeFreshnessEvaluated: report.governedChangeFreshness.evaluated,
    governedChangeFreshnessDecision: report.governedChangeFreshness.decision,
    governedChangeFreshnessCurrent: report.governedChangeFreshness.snapshotCurrent,
    governedChangeHandoffEligible: report.governedChangeFreshness.handoffEligible,
    governedChangeCurrentSnapshotHash:
      report.governedChangeFreshness.currentSnapshotHash,
    governedChangeStaleFieldCount: report.governedChangeFreshness.staleFields.length,
    controlledApplyHandoffApplicable: report.controlledApplyHandoff.applicable,
    controlledApplyHandoffConfigured: report.controlledApplyHandoff.configured,
    controlledApplyHandoffRequired: report.controlledApplyHandoff.required,
    controlledApplyHandoffRequiredSatisfied:
      report.controlledApplyHandoff.requiredSatisfied,
    controlledApplyHandoffEvaluated: report.controlledApplyHandoff.evaluated,
    controlledApplyHandoffDecision: report.controlledApplyHandoff.decision,
    controlledApplyHandoffBuilt: report.controlledApplyHandoff.handoffBuilt,
    controlledApplyHandoffRepositoryIdentityHash:
      report.controlledApplyHandoff.repositoryIdentityHash,
    controlledApplyHandoffBaseRevisionHash:
      report.controlledApplyHandoff.baseRevisionHash,
    controlledApplyHandoffWorktreeStateHash:
      report.controlledApplyHandoff.worktreeStateHash,
    controlledApplyHandoffConstraintsHash:
      report.controlledApplyHandoff.constraintsHash,
    controlledApplyHandoffConsumptionKey:
      report.controlledApplyHandoff.consumptionKey,
    controlledApplyHandoffHash: report.controlledApplyHandoff.handoffHash,
    controlledApplyHandoffVerificationEvaluated:
      report.controlledApplyHandoffVerification.evaluated,
    controlledApplyHandoffVerificationDecision:
      report.controlledApplyHandoffVerification.decision,
    controlledApplyHandoffConsumptionStatus:
      report.controlledApplyHandoffVerification.consumptionStatus,
    controlledApplyHandoffExecutionEligible:
      report.controlledApplyHandoffVerification.executionEligible,
    controlledApplyHandoffStaleFieldCount:
      report.controlledApplyHandoffVerification.staleFields.length,
    controlledApplyApplyExecuted: report.controlledApplyHandoff.applyExecuted,
    controlledApplyRegistryWritten: report.controlledApplyHandoff.registryWritten,
    controlledApplyRollbackPrepared: report.controlledApplyHandoff.rollbackPrepared
  });
}

function integrateControlledApplyHandoff(
  report,
  config,
  context,
  activeGovernedMutation,
  currentGovernedChangeFreshnessSnapshot
) {
  const { runtime } = context;
  const artifact = report.governedChangeArtifact.artifact;
  const applicable = Boolean(
    artifact !== null &&
    report.governedChangeArtifact.decision === "governed_change_artifact_ready" &&
    artifact.applyEligibility.eligible === true &&
    report.governedChangeFreshness.decision === "governed_change_current" &&
    report.governedChangeFreshness.handoffEligible === true &&
    report.workflowRoute === "auto_continue" &&
    report.finalDecision === "temp_validation_passed" &&
    activeGovernedMutation !== null &&
    currentGovernedChangeFreshnessSnapshot !== null
  );
  Object.assign(report.controlledApplyHandoff, {
    applicable,
    configured: config.handoff.targetConfigured,
    required: applicable && config.handoff.required,
    requiredSatisfied: !(applicable && config.handoff.required)
  });
  Object.assign(report.controlledApplyHandoffVerification, {
    consumptionStatus: config.handoff.consumptionStatus,
    consumptionStatusExternallySupplied:
      config.handoff.consumptionStatusExternallySupplied
  });

  if (!applicable) return;

  if (!config.handoff.targetConfigured) {
    const issueCode = config.handoff.targetIncomplete
      ? "controlled_apply_target_configuration_incomplete"
      : "controlled_apply_target_not_configured";
    report.controlledApplyHandoff.issueCodes = [issueCode];
    context.issueCodes.push(issueCode);
    return;
  }

  const finalEvent = context.ledger.events.at(-1) || null;
  const ledgerInvariant = {
    eventCount: context.ledger.eventCount,
    rootHash: context.ledger.rootHash,
    finalEventId: finalEvent ? finalEvent.eventId : null,
    finalEventHash: finalEvent ? finalEvent.eventHash : null
  };
  let handoffInput = {
    artifact,
    currentFreshnessSnapshot: currentGovernedChangeFreshnessSnapshot,
    mutation: activeGovernedMutation,
    target: config.handoff.target
  };
  if (typeof fixture.controlledApplyHandoffInputMutation === "function") {
    const mutatedInput = fixture.controlledApplyHandoffInputMutation(
      handoffInput,
      runtime,
      context
    );
    if (mutatedInput !== undefined) handoffInput = mutatedInput;
  }

  const startedAt = Date.now();
  let result = null;
  report.controlledApplyHandoff.evaluated = true;
  try {
    result = runtime.buildControlledApplyHandoff(handoffInput);
  } catch {
    report.controlledApplyHandoff.issueCodes = [
      "controlled_apply_handoff_evaluation_failed"
    ];
    context.issueCodes.push("controlled_apply_handoff_evaluation_failed");
  }
  report.controlledApplyHandoff.durationMs = Date.now() - startedAt;

  if (result !== null) {
    const handoff = result.handoff;
    Object.assign(report.controlledApplyHandoff, {
      evaluated: true,
      decision: result.decision,
      handoffBuilt: handoff !== null,
      mutationHash: handoff ? handoff.mutation.mutationHash : null,
      changedFileCount: result.summary.changedFileCount,
      governedArtifactHash: handoff ? handoff.evidence.governedArtifactHash : null,
      currentSnapshotHash: result.summary.currentSnapshotHash,
      repositoryIdentityHash: handoff ? handoff.target.repositoryIdentityHash : null,
      baseRevisionHash: handoff ? handoff.target.baseRevisionHash : null,
      worktreeStateHash: handoff ? handoff.target.worktreeStateHash : null,
      constraintsHash: result.summary.constraintsHash,
      consumptionKey: result.summary.consumptionKey,
      handoffHash: result.summary.handoffHash,
      externalConsumptionRegistryRequired:
        result.summary.externalConsumptionRegistryRequired,
      issueCodes: boundedCodes([
        ...result.issues.map((issue) => issue.code),
        ...(!config.handoff.consumptionStatusValid
          ? ["controlled_apply_consumption_status_invalid"]
          : [])
      ]),
      handoff
    });
    report.controlledApplyHandoffStageDecision = result.decision;

    if (!config.handoff.consumptionStatusValid) {
      context.issueCodes.push("controlled_apply_consumption_status_invalid");
    }

    if (handoff !== null) {
      let handoffForVerification = handoff;
      if (typeof fixture.controlledApplyHandoffMutation === "function") {
        const mutatedHandoff = fixture.controlledApplyHandoffMutation(
          handoff,
          runtime,
          context
        );
        if (mutatedHandoff !== undefined) handoffForVerification = mutatedHandoff;
      }
      let verificationInput = {
        handoff: handoffForVerification,
        artifact,
        currentFreshnessSnapshot: currentGovernedChangeFreshnessSnapshot,
        mutation: activeGovernedMutation,
        currentTarget: config.handoff.target,
        consumptionStatus: config.handoff.consumptionStatus
      };
      if (typeof fixture.controlledApplyHandoffVerificationInputMutation === "function") {
        const mutatedInput = fixture.controlledApplyHandoffVerificationInputMutation(
          verificationInput,
          runtime,
          context
        );
        if (mutatedInput !== undefined) verificationInput = mutatedInput;
      }
      let verification = null;
      try {
        verification = runtime.verifyControlledApplyHandoff(verificationInput);
      } catch {
        context.issueCodes.push("controlled_apply_handoff_verification_failed");
      }
      if (verification !== null) {
        const reasonCodes = boundedCodes([
          ...verification.reasonCodes,
          ...(!config.handoff.consumptionStatusValid
            ? ["controlled_apply_consumption_status_invalid"]
            : [])
        ]);
        report.controlledApplyHandoffVerification = {
          evaluated: true,
          decision: verification.decision,
          consumptionStatus: config.handoff.consumptionStatus,
          consumptionStatusExternallySupplied:
            config.handoff.consumptionStatusExternallySupplied,
          handoffIntegrityVerified: verification.handoffIntegrityVerified,
          artifactIntegrityVerified: verification.artifactIntegrityVerified,
          currentSnapshotHash: verification.currentSnapshotHash,
          currentMutationHash: verification.currentMutationHash,
          staleFields: [...verification.staleFields],
          reasonCodes,
          executionEligible: verification.executionEligible &&
            config.handoff.consumptionStatusValid,
          result: verification
        };
        report.controlledApplyHandoffVerificationStageDecision =
          verification.decision;
      }
    }
  }

  const finalEventAfter = context.ledger.events.at(-1) || null;
  const ledgerUnchanged =
    context.ledger.eventCount === ledgerInvariant.eventCount &&
    context.ledger.rootHash === ledgerInvariant.rootHash &&
    (finalEventAfter ? finalEventAfter.eventId : null) === ledgerInvariant.finalEventId &&
    (finalEventAfter ? finalEventAfter.eventHash : null) === ledgerInvariant.finalEventHash &&
    finalEventAfter !== null &&
    finalEventAfter.actor === "approval_router" &&
    finalEventAfter.action === "approval_router.evaluate";
  if (!ledgerUnchanged) {
    report.controlledApplyHandoff.issueCodes = boundedCodes([
      ...report.controlledApplyHandoff.issueCodes,
      "controlled_apply_final_ledger_mutated"
    ]);
    context.issueCodes.push("controlled_apply_final_ledger_mutated");
  }

  if (report.controlledApplyHandoff.required) {
    report.controlledApplyHandoff.requiredSatisfied = Boolean(
      ledgerUnchanged &&
      report.controlledApplyHandoff.configured &&
      report.controlledApplyHandoff.decision === "controlled_apply_handoff_ready" &&
      report.controlledApplyHandoff.handoff !== null &&
      report.controlledApplyHandoff.handoffHash !== null &&
      report.controlledApplyHandoff.consumptionKey !== null &&
      report.controlledApplyHandoffVerification.evaluated &&
      report.controlledApplyHandoffVerification.decision ===
        "controlled_apply_handoff_current" &&
      report.controlledApplyHandoffVerification.executionEligible === true
    );
  }
}

async function finalizeAccountabilityAndShadow(report, config, context) {
  const { runtime } = context;
  const accountability = report.accountability;
  accountability.ledgerCreated = true;
  accountability.runId = context.ledger.runId;
  accountability.objectiveHash = context.objectiveHash;
  accountability.eventCountBeforeShadow = context.ledger.eventCount;
  accountability.ledgerRootHashBeforeShadow = context.ledger.rootHash;

  const preAnchors = exactLedgerAnchors(context.ledger);
  const preVerification = runtime.verifyAgentEventLedger(context.ledger, preAnchors);
  const preTraceResult = runtime.buildRunAccountabilityTrace(context.ledger, preAnchors);
  const preTrace = preTraceResult.trace;
  accountability.preShadowLedgerVerificationDecision = preVerification.decision;
  accountability.preShadowTraceDecision = preTraceResult.decision;
  accountability.preShadowTraceHash = preTrace ? preTrace.traceHash : null;
  accountability.preShadowFindingCount = preTraceResult.summary.findingCount;
  accountability.preShadowWarningCount = preTraceResult.summary.warningCount;
  accountability.preShadowErrorCount = preTraceResult.summary.errorCount;
  accountability.phaseVExecutionObserved = Boolean(preTrace && preTrace.phaseVExecutionObserved);
  accountability.phaseVExecutionCompleted = Boolean(preTrace && preTrace.phaseVExecutionCompleted);
  if (preVerification.decision !== "ledger_valid") {
    context.evidenceComplete = false;
    context.issueCodes.push("pre_shadow_ledger_verification_failed");
  }
  if (preTrace === null) {
    context.evidenceComplete = false;
    context.issueCodes.push("pre_shadow_trace_unavailable");
  }

  const executionTerminal = new Set([
    "temp_validation_passed",
    "temp_validation_failed",
    "temp_validation_needs_review"
  ]).has(report.finalDecision);
  const shadowEligible =
    context.evidenceComplete &&
    preVerification.decision === "ledger_valid" &&
    preTrace !== null &&
    preTraceResult.summary.traceHashValid === true &&
    accountability.phaseVExecutionObserved &&
    accountability.phaseVExecutionCompleted &&
    executionTerminal &&
    report.tempWorkspaceExecution.cleanupPerformed === true;
  const shadowConfigured = Boolean(config.shadow.upstreamUrl && config.shadow.modelId);
  report.shadowObserver = emptyShadowObserverReport(shadowConfigured, config.shadow.required);

  if (shadowEligible && shadowConfigured) {
    const shadowStartedAt = timestampNow();
    let adapterResult = null;
    try {
      adapterResult = await runtime.runShadowObserverModel(preTrace, {
        endpoint: config.shadow.upstreamUrl,
        modelId: config.shadow.modelId,
        timeoutMs: config.shadow.timeoutMs,
        maxTraceEvents: config.shadow.maxTraceEvents,
        maxPromptChars: config.shadow.maxPromptChars,
        maxResponseChars: config.shadow.maxResponseChars
      });
    } catch {
      context.evidenceComplete = false;
      context.issueCodes.push("shadow_adapter_configuration_invalid");
    }
    const shadowFinishedAt = timestampNow(shadowStartedAt);

    if (adapterResult !== null) {
      const observation = adapterResult.observation;
      report.shadowObserver = {
        configured: true,
        required: config.shadow.required,
        called: adapterResult.called,
        decision: adapterResult.decision,
        validationDecision: adapterResult.validationDecision,
        requiredSatisfied: false,
        riskLevel: observation ? observation.riskLevel : null,
        riskScore: observation ? observation.riskScore : null,
        confidenceScore: observation ? observation.confidenceScore : null,
        recommendation: observation ? observation.recommendation : null,
        findingCount: observation ? observation.findings.length : 0,
        observationHash: observation ? observation.observationHash : null,
        responseContentHash: adapterResult.responseContentHash,
        inputTokens: adapterResult.usage ? adapterResult.usage.inputTokens : null,
        outputTokens: adapterResult.usage ? adapterResult.usage.outputTokens : null,
        totalTokens: adapterResult.usage ? adapterResult.usage.totalTokens : null,
        eventAppended: false,
        issueCodes: adapterResult.issues.map((issue) => issue.code),
        observation,
        durationMs: adapterResult.summary.durationMs
      };
      report.shadowStageDecision = adapterResult.decision;

      if (adapterResult.called) {
        const shadowEventAppended = appendAccountabilityEvent(context, {
          actor: "shadow_observer",
          action: "shadow_observer.observe",
          startedAt: shadowStartedAt,
          finishedAt: shadowFinishedAt,
          inputArtifactHashes: [preTrace.traceHash],
          outputArtifactHashes: [
            observation && observation.observationHash,
            adapterResult.responseContentHash
          ],
          filesRead: citedObservationFiles(observation),
          filesProposed: [],
          decision: observation ? observation.recommendation : adapterResult.decision,
          reasonCodes: [
            ...(observation ? observation.rationaleCodes : []),
            ...adapterResult.issues.map((issue) => issue.code)
          ],
          ...(adapterResult.usage ? { tokenUsage: adapterResult.usage } : {})
        });
        report.shadowObserver.eventAppended = shadowEventAppended;
      }
    }
  }

  if (report.shadowObserver.eventAppended) {
    const postAnchors = exactLedgerAnchors(context.ledger);
    const postVerification = runtime.verifyAgentEventLedger(context.ledger, postAnchors);
    const postTraceResult = runtime.buildRunAccountabilityTrace(context.ledger, postAnchors);
    accountability.postShadowLedgerVerificationDecision = postVerification.decision;
    accountability.postShadowTraceDecision = postTraceResult.decision;
    accountability.postShadowTraceHash = postTraceResult.trace
      ? postTraceResult.trace.traceHash
      : null;
    accountability.postShadowFindingCount = postTraceResult.summary.findingCount;
    accountability.postShadowTrace = postTraceResult.trace;
    if (postVerification.decision !== "ledger_valid") {
      context.evidenceComplete = false;
      context.issueCodes.push("post_shadow_ledger_verification_failed");
    }
    if (postTraceResult.trace === null) {
      context.evidenceComplete = false;
      context.issueCodes.push("post_shadow_trace_unavailable");
    }
  }
  accountability.eventCountAfterShadow = context.ledger.eventCount;
  accountability.ledgerRootHashAfterShadow = context.ledger.rootHash;

  const validatedObservation = report.shadowObserver.observation || null;
  const governanceEligible =
    preVerification.decision === "ledger_valid" &&
    preTrace !== null &&
    preTraceResult.summary.traceHashValid === true &&
    accountability.phaseVExecutionObserved &&
    accountability.phaseVExecutionCompleted &&
    executionTerminal;
  let governanceResult = null;
  let governanceAssessment = null;

  if (governanceEligible) {
    const governanceStartedAt = timestampNow();
    try {
      governanceResult = runtime.evaluateDeterministicGovernance(
        preTrace,
        validatedObservation,
        runtime.DEFAULT_DETERMINISTIC_GOVERNANCE_POLICY
      );
      governanceAssessment = governanceResult.assessment;
    } catch {
      context.evidenceComplete = false;
      context.issueCodes.push("governance_evaluation_failed");
    }
    const governanceFinishedAt = timestampNow(governanceStartedAt);

    if (governanceAssessment !== null) {
      report.governance = {
        evaluated: true,
        decision: governanceAssessment.decision,
        riskClass: governanceAssessment.riskClass,
        traceHash: governanceAssessment.traceHash,
        observationHash: governanceAssessment.observationHash,
        policyHash: governanceAssessment.policyHash,
        governanceHash: governanceAssessment.governanceHash,
        triggeredRuleCount: governanceResult.summary.triggeredRuleCount,
        terminateRuleCount: governanceResult.summary.terminateRuleCount,
        escalationRuleCount: governanceResult.summary.escalationRuleCount,
        replanRuleCount: governanceResult.summary.replanRuleCount,
        repairRuleCount: governanceResult.summary.repairRuleCount,
        reasonCodes: [...governanceAssessment.reasonCodes],
        issueCodes: governanceAssessment.issues.map((issue) => issue.code),
        eventAppended: false,
        assessment: governanceAssessment
      };
      report.governanceStageDecision = governanceAssessment.decision;
      const eventAppended = appendAccountabilityEvent(context, {
        actor: "deterministic_governor",
        action: "deterministic_governor.evaluate",
        startedAt: governanceStartedAt,
        finishedAt: governanceFinishedAt,
        inputArtifactHashes: [
          preTrace.traceHash,
          validatedObservation && validatedObservation.observationHash,
          governanceAssessment.policyHash
        ],
        outputArtifactHashes: [governanceAssessment.governanceHash],
        filesRead: governanceEvidenceFiles(governanceAssessment),
        filesProposed: [],
        decision: governanceAssessment.decision,
        reasonCodes: governanceAssessment.reasonCodes
      });
      report.governance.eventAppended = eventAppended;
      accountability.governanceEventAppended = eventAppended;
    }
  }

  if (report.governance.eventAppended) {
    const postGovernanceAnchors = exactLedgerAnchors(context.ledger);
    const postGovernanceVerification = runtime.verifyAgentEventLedger(
      context.ledger,
      postGovernanceAnchors
    );
    const postGovernanceTraceResult = runtime.buildRunAccountabilityTrace(
      context.ledger,
      postGovernanceAnchors
    );
    accountability.postGovernanceLedgerVerificationDecision =
      postGovernanceVerification.decision;
    accountability.postGovernanceTraceDecision = postGovernanceTraceResult.decision;
    accountability.postGovernanceTraceHash = postGovernanceTraceResult.trace
      ? postGovernanceTraceResult.trace.traceHash
      : null;
    accountability.postGovernanceFindingCount = postGovernanceTraceResult.summary.findingCount;
    accountability.postGovernanceTrace = postGovernanceTraceResult.trace;
    if (postGovernanceVerification.decision !== "ledger_valid") {
      context.evidenceComplete = false;
      context.issueCodes.push("post_governance_ledger_verification_failed");
    }
    if (postGovernanceTraceResult.trace === null) {
      context.evidenceComplete = false;
      context.issueCodes.push("post_governance_trace_unavailable");
    }
  }
  accountability.eventCountAfterGovernance = context.ledger.eventCount;
  accountability.ledgerRootHashAfterGovernance = context.ledger.rootHash;

  const adminConfigured = Boolean(config.admin.upstreamUrl && config.admin.modelId);
  report.adminAgent = emptyAdminAgentReport(adminConfigured, config.admin.required);
  if (governanceAssessment !== null && preTrace !== null && adminConfigured) {
    const adminStartedAt = timestampNow();
    let adapterResult = null;
    try {
      adapterResult = await runtime.runAdminAgentModel(
        preTrace,
        validatedObservation,
        governanceAssessment,
        {
          endpoint: config.admin.upstreamUrl,
          modelId: config.admin.modelId,
          timeoutMs: config.admin.timeoutMs,
          maxTraceEvents: config.admin.maxTraceEvents,
          maxPromptChars: config.admin.maxPromptChars,
          maxResponseChars: config.admin.maxResponseChars
        }
      );
    } catch {
      context.issueCodes.push("admin_adapter_configuration_invalid");
    }
    const adminFinishedAt = timestampNow(adminStartedAt);

    if (adapterResult !== null) {
      const adminDecision = adapterResult.adminDecision;
      report.adminAgent = {
        configured: true,
        required: config.admin.required,
        called: adapterResult.called,
        adapterDecision: adapterResult.decision,
        validationDecision: adapterResult.validationDecision,
        requiredSatisfied: false,
        governanceDecision: governanceAssessment.decision,
        decision: adminDecision ? adminDecision.decision : null,
        riskLevel: adminDecision ? adminDecision.riskLevel : null,
        riskScore: adminDecision ? adminDecision.riskScore : null,
        confidenceScore: adminDecision ? adminDecision.confidenceScore : null,
        findingCount: adminDecision ? adminDecision.findings.length : 0,
        adminDecisionHash: adminDecision ? adminDecision.adminDecisionHash : null,
        responseContentHash: adapterResult.responseContentHash,
        inputTokens: adapterResult.usage ? adapterResult.usage.inputTokens : null,
        outputTokens: adapterResult.usage ? adapterResult.usage.outputTokens : null,
        totalTokens: adapterResult.usage ? adapterResult.usage.totalTokens : null,
        issueCodes: adapterResult.issues.map((issue) => issue.code),
        eventAppended: false,
        adminDecision,
        adapterResult,
        durationMs: adapterResult.summary.durationMs
      };
      report.adminStageDecision = adapterResult.decision;

      if (adapterResult.called) {
        const adminEventAppended = appendAccountabilityEvent(context, {
          actor: "admin_agent",
          action: "admin_agent.evaluate",
          startedAt: adminStartedAt,
          finishedAt: adminFinishedAt,
          inputArtifactHashes: [
            preTrace.traceHash,
            validatedObservation && validatedObservation.observationHash,
            governanceAssessment.governanceHash
          ],
          outputArtifactHashes: [
            adminDecision && adminDecision.adminDecisionHash,
            adapterResult.responseContentHash
          ],
          filesRead: adminEvidenceFiles(adminDecision),
          filesProposed: [],
          decision: adminDecision ? adminDecision.decision : adapterResult.decision,
          reasonCodes: [
            ...(adminDecision ? adminDecision.rationaleCodes : []),
            ...adapterResult.issues.map((issue) => issue.code)
          ],
          ...(adapterResult.usage ? { tokenUsage: adapterResult.usage } : {})
        });
        report.adminAgent.eventAppended = adminEventAppended;
        accountability.adminEventAppended = adminEventAppended;
      }
    }
  }

  if (report.adminAgent.eventAppended) {
    const postAdminAnchors = exactLedgerAnchors(context.ledger);
    const postAdminVerification = runtime.verifyAgentEventLedger(
      context.ledger,
      postAdminAnchors
    );
    const postAdminTraceResult = runtime.buildRunAccountabilityTrace(
      context.ledger,
      postAdminAnchors
    );
    accountability.postAdminLedgerVerificationDecision = postAdminVerification.decision;
    accountability.postAdminTraceDecision = postAdminTraceResult.decision;
    accountability.postAdminTraceHash = postAdminTraceResult.trace
      ? postAdminTraceResult.trace.traceHash
      : null;
    accountability.postAdminFindingCount = postAdminTraceResult.summary.findingCount;
    accountability.postAdminTrace = postAdminTraceResult.trace;
    if (postAdminVerification.decision !== "ledger_valid") {
      context.evidenceComplete = false;
      context.issueCodes.push("post_admin_ledger_verification_failed");
    }
    if (postAdminTraceResult.trace === null) {
      context.evidenceComplete = false;
      context.issueCodes.push("post_admin_trace_unavailable");
    }
  }
  accountability.eventCountAfterAdmin = context.ledger.eventCount;
  accountability.ledgerRootHashAfterAdmin = context.ledger.rootHash;

  const approvalRouterEligible =
    preVerification.decision === "ledger_valid" &&
    preTrace !== null &&
    preTraceResult.summary.traceHashValid === true &&
    accountability.phaseVExecutionObserved &&
    accountability.phaseVExecutionCompleted &&
    executionTerminal &&
    governanceAssessment !== null;
  report.approvalRouter = emptyApprovalRouterReport();
  report.approvalRouter.required = approvalRouterEligible;
  let approvalRouterResult = null;
  let approvalRouterAssessment = null;
  let postRouterVerification = null;

  if (approvalRouterEligible) {
    let approvalRouterInput = {
      phaseVFinalDecision: report.finalDecision,
      trace: preTrace,
      shadow: {
        stageDecision: report.shadowStageDecision,
        validationDecision: report.shadowObserver.validationDecision,
        observation: validatedObservation
      },
      governance: governanceAssessment,
      admin: {
        stageDecision: report.adminStageDecision,
        validationDecision: report.adminAgent.validationDecision,
        decision: report.adminAgent.adminDecision
      }
    };
    if (typeof fixture.approvalRouterInputMutation === "function") {
      const mutatedInput = fixture.approvalRouterInputMutation(
        approvalRouterInput,
        runtime
      );
      if (mutatedInput !== undefined) approvalRouterInput = mutatedInput;
    }
    Object.assign(report.approvalRouter, {
      evaluated: true,
      required: true,
      requiredSatisfied: false,
      phaseVFinalDecision: approvalRouterInput.phaseVFinalDecision,
      shadowStageDecision: approvalRouterInput.shadow.stageDecision,
      governanceDecision: approvalRouterInput.governance.decision,
      adminStageDecision: approvalRouterInput.admin.stageDecision,
      adminDecision: approvalRouterInput.admin.decision
        ? approvalRouterInput.admin.decision.decision
        : null,
      traceHash: approvalRouterInput.trace.traceHash,
      observationHash: approvalRouterInput.shadow.observation
        ? approvalRouterInput.shadow.observation.observationHash
        : null,
      governanceHash: approvalRouterInput.governance.governanceHash,
      adminDecisionHash: approvalRouterInput.admin.decision
        ? approvalRouterInput.admin.decision.adminDecisionHash
        : null
    });
    const routerStartedAt = timestampNow();
    try {
      approvalRouterResult = runtime.evaluateRiskBasedApprovalRoute(
        approvalRouterInput,
        runtime.DEFAULT_RISK_BASED_APPROVAL_ROUTER_POLICY
      );
      approvalRouterAssessment = approvalRouterResult.assessment;
    } catch {
      context.evidenceComplete = false;
      context.issueCodes.push("approval_router_evaluation_failed");
    }
    const routerFinishedAt = timestampNow(routerStartedAt);

    if (approvalRouterResult !== null) {
      report.approvalRouter = {
        evaluated: true,
        required: true,
        requiredSatisfied: false,
        validationDecision: approvalRouterResult.decision,
        route: approvalRouterResult.route,
        riskClass: approvalRouterAssessment ? approvalRouterAssessment.riskClass : null,
        phaseVFinalDecision: approvalRouterInput.phaseVFinalDecision,
        shadowStageDecision: approvalRouterInput.shadow.stageDecision,
        governanceDecision: approvalRouterInput.governance.decision,
        adminStageDecision: approvalRouterInput.admin.stageDecision,
        adminDecision: approvalRouterInput.admin.decision
          ? approvalRouterInput.admin.decision.decision
          : null,
        traceHash: approvalRouterAssessment
          ? approvalRouterAssessment.traceHash
          : approvalRouterInput.trace.traceHash,
        observationHash: approvalRouterAssessment
          ? approvalRouterAssessment.observationHash
          : approvalRouterInput.shadow.observation
            ? approvalRouterInput.shadow.observation.observationHash
            : null,
        governanceHash: approvalRouterAssessment
          ? approvalRouterAssessment.governanceHash
          : approvalRouterInput.governance.governanceHash,
        adminDecisionHash: approvalRouterAssessment
          ? approvalRouterAssessment.adminDecisionHash
          : approvalRouterInput.admin.decision
            ? approvalRouterInput.admin.decision.adminDecisionHash
            : null,
        policyHash: approvalRouterAssessment ? approvalRouterAssessment.policyHash : null,
        routeHash: approvalRouterAssessment ? approvalRouterAssessment.routeHash : null,
        triggeredRuleCount: approvalRouterResult.summary.triggeredRuleCount,
        repairRuleCount: approvalRouterResult.summary.repairRuleCount,
        replanRuleCount: approvalRouterResult.summary.replanRuleCount,
        humanRuleCount: approvalRouterResult.summary.humanRuleCount,
        terminateRuleCount: approvalRouterResult.summary.terminateRuleCount,
        reasonCodes: approvalRouterAssessment
          ? [...approvalRouterAssessment.reasonCodes]
          : approvalRouterResult.issues.map((issue) => issue.code),
        issueCodes: approvalRouterResult.issues.map((issue) => issue.code),
        deterministicAuthorityPreserved:
          approvalRouterResult.summary.deterministicAuthorityPreserved,
        autoContinueEligible: approvalRouterResult.summary.autoContinueEligible,
        eventAppended: false,
        assessment: approvalRouterAssessment
      };
      report.approvalRouterStageDecision = approvalRouterResult.decision;
      report.workflowRoute = approvalRouterResult.route;

      const eventAppended = appendAccountabilityEvent(context, {
        actor: "approval_router",
        action: "approval_router.evaluate",
        startedAt: routerStartedAt,
        finishedAt: routerFinishedAt,
        inputArtifactHashes: [
          approvalRouterInput.trace.traceHash,
          approvalRouterInput.shadow.observation &&
            approvalRouterInput.shadow.observation.observationHash,
          approvalRouterInput.governance.governanceHash,
          approvalRouterInput.admin.decision &&
            approvalRouterInput.admin.decision.adminDecisionHash,
          approvalRouterAssessment && approvalRouterAssessment.policyHash
        ],
        outputArtifactHashes: [
          approvalRouterAssessment && approvalRouterAssessment.routeHash
        ],
        filesRead: approvalRouterEvidenceFiles(
          approvalRouterAssessment,
          approvalRouterResult
        ),
        filesProposed: [],
        decision: approvalRouterAssessment && approvalRouterResult.route
          ? approvalRouterAssessment.route
          : approvalRouterResult.decision,
        reasonCodes: approvalRouterAssessment
          ? approvalRouterAssessment.reasonCodes
          : approvalRouterResult.issues.map((issue) => issue.code)
      });
      report.approvalRouter.eventAppended = eventAppended;
      accountability.approvalRouterEventAppended = eventAppended;
      if (!eventAppended) {
        context.issueCodes.push("approval_router_event_append_failed");
      }
    }
  }

  if (report.approvalRouter.eventAppended) {
    const postRouterAnchors = exactLedgerAnchors(context.ledger);
    postRouterVerification = runtime.verifyAgentEventLedger(
      context.ledger,
      postRouterAnchors
    );
    const postRouterTraceResult = runtime.buildRunAccountabilityTrace(
      context.ledger,
      postRouterAnchors
    );
    accountability.ledgerRootHashAfterRouter = context.ledger.rootHash;
    accountability.postRouterLedgerVerificationDecision = postRouterVerification.decision;
    accountability.postRouterTraceDecision = postRouterTraceResult.decision;
    accountability.postRouterTraceHash = postRouterTraceResult.trace
      ? postRouterTraceResult.trace.traceHash
      : null;
    accountability.postRouterFindingCount = postRouterTraceResult.summary.findingCount;
    accountability.postRouterTrace = postRouterTraceResult.trace;
    if (postRouterVerification.decision !== "ledger_valid") {
      context.evidenceComplete = false;
      context.issueCodes.push("post_router_ledger_verification_failed");
    }
    if (postRouterTraceResult.trace === null) {
      context.evidenceComplete = false;
      context.issueCodes.push("post_router_trace_unavailable");
    }
  }
  accountability.eventCountAfterRouter = context.ledger.eventCount;

  const governedChangeEligible =
    executionTerminal &&
    preTrace !== null &&
    governanceAssessment !== null &&
    approvalRouterResult !== null &&
    approvalRouterResult.decision === "approval_route_valid" &&
    approvalRouterAssessment !== null &&
    approvalRouterResult.route !== null &&
    report.approvalRouter.eventAppended === true &&
    postRouterVerification !== null &&
    postRouterVerification.decision === "ledger_valid" &&
    context.ledger !== null;

  let activeGovernedMutation = null;
  let currentGovernedChangeFreshnessSnapshot = null;

  if (governedChangeEligible) {
    const finalEvent = context.ledger.events.at(-1) || null;
    const ledgerInvariant = {
      eventCount: context.ledger.eventCount,
      rootHash: context.ledger.rootHash,
      finalEventId: finalEvent ? finalEvent.eventId : null,
      finalEventHash: finalEvent ? finalEvent.eventHash : null
    };
    let activeChange = {
      ...context.governedChange,
      changedFiles: [...context.governedChange.changedFiles]
    };
    if (typeof fixture.governedChangeActiveStateMutation === "function") {
      const mutatedState = fixture.governedChangeActiveStateMutation(
        activeChange,
        runtime,
        context
      );
      if (mutatedState !== undefined) activeChange = mutatedState;
    }

    Object.assign(report.governedChangeArtifact, {
      evaluated: true,
      required: true,
      requiredSatisfied: false,
      changeKind: activeChange && activeChange.changeKind || null,
      mutationHash: activeChange && activeChange.mutationHash || null,
      changedFileCount: activeChange && Array.isArray(activeChange.changedFiles)
        ? activeChange.changedFiles.length
        : 0,
      patchDryRunResultHash: activeChange && activeChange.patchDryRunResultHash || null,
      temporaryApplyResultHash:
        activeChange && activeChange.temporaryApplyResultHash || null,
      executionVerificationResultHash:
        activeChange && activeChange.executionVerificationResultHash || null,
      preShadowTraceHash: preTrace.traceHash,
      observationHash: validatedObservation ? validatedObservation.observationHash : null,
      governanceHash: governanceAssessment.governanceHash,
      adminDecisionHash: report.adminAgent.adminDecision
        ? report.adminAgent.adminDecision.adminDecisionHash
        : null,
      routeHash: approvalRouterAssessment.routeHash,
      governancePolicyHash: governanceAssessment.policyHash,
      routerPolicyHash: approvalRouterAssessment.policyHash,
      finalLedgerRootHash: context.ledger.rootHash,
      finalLedgerEventCount: context.ledger.eventCount
    });

    const activeStateComplete = Boolean(
      activeChange &&
      new Set(["coder_patch_draft", "repair_draft"]).has(activeChange.changeKind) &&
      activeChange.mutation &&
      typeof activeChange.mutationHash === "string" &&
      Array.isArray(activeChange.changedFiles) &&
      typeof activeChange.patchDryRunResultHash === "string" &&
      typeof activeChange.temporaryApplyResultHash === "string" &&
      typeof activeChange.executionVerificationResultHash === "string"
    );

    if (!activeStateComplete) {
      report.governedChangeArtifact.issueCodes = [
        "governed_change_active_mutation_unavailable"
      ];
      context.issueCodes.push("governed_change_active_mutation_unavailable");
    } else {
      activeGovernedMutation = activeChange.mutation;
      const finalLedgerAnchors = exactLedgerAnchors(context.ledger);
      let governedChangeArtifactInput = {
        finalLedger: context.ledger,
        finalLedgerAnchors,
        preShadowTrace: preTrace,
        shadowObservation: validatedObservation,
        governanceAssessment,
        adminDecision: report.adminAgent.adminDecision || null,
        approvalRouterAssessment,
        change: {
          changeKind: activeChange.changeKind,
          mutationHash: activeChange.mutationHash,
          changedFiles: [...activeChange.changedFiles],
          patchDryRunResultHash: activeChange.patchDryRunResultHash,
          temporaryApplyResultHash: activeChange.temporaryApplyResultHash,
          executionVerificationResultHash:
            activeChange.executionVerificationResultHash
        }
      };
      if (typeof fixture.governedChangeArtifactInputMutation === "function") {
        const mutatedInput = fixture.governedChangeArtifactInputMutation(
          governedChangeArtifactInput,
          runtime,
          context
        );
        if (mutatedInput !== undefined) governedChangeArtifactInput = mutatedInput;
      }

      const artifactStartedAt = Date.now();
      let governedChangeArtifactResult = null;
      try {
        governedChangeArtifactResult = runtime.buildGovernedChangeArtifact(
          governedChangeArtifactInput
        );
      } catch {
        report.governedChangeArtifact.issueCodes = [
          "governed_change_artifact_evaluation_failed"
        ];
        context.issueCodes.push("governed_change_artifact_evaluation_failed");
      }
      report.governedChangeArtifact.durationMs = Date.now() - artifactStartedAt;

      if (governedChangeArtifactResult !== null) {
        const artifact = governedChangeArtifactResult.artifact;
        Object.assign(report.governedChangeArtifact, {
          decision: governedChangeArtifactResult.decision,
          artifactBuilt: artifact !== null,
          applyEligible: Boolean(artifact && artifact.applyEligibility.eligible),
          governedArtifactHash: artifact ? artifact.governedArtifactHash : null,
          eligibilityReasonCodes: artifact
            ? [...artifact.applyEligibility.reasonCodes]
            : [],
          issueCodes: governedChangeArtifactResult.issues.map((issue) => issue.code),
          artifact
        });
        report.governedChangeArtifactStageDecision =
          governedChangeArtifactResult.decision;

        if (artifact !== null) {
          let currentFreshnessSnapshot = {
            runId: context.ledger.runId,
            objectiveHash: context.ledger.objectiveHash,
            mutationHash: activeChange.mutationHash,
            changedFiles: [...activeChange.changedFiles],
            patchDryRunResultHash: activeChange.patchDryRunResultHash,
            temporaryApplyResultHash: activeChange.temporaryApplyResultHash,
            executionVerificationResultHash:
              activeChange.executionVerificationResultHash,
            preShadowTraceHash: preTrace.traceHash,
            observationHash: validatedObservation
              ? validatedObservation.observationHash
              : null,
            governanceHash: governanceAssessment.governanceHash,
            adminDecisionHash: report.adminAgent.adminDecision
              ? report.adminAgent.adminDecision.adminDecisionHash
              : null,
            routeHash: approvalRouterAssessment.routeHash,
            governancePolicyHash: governanceAssessment.policyHash,
            routerPolicyHash: approvalRouterAssessment.policyHash,
            finalLedgerRootHash: context.ledger.rootHash,
            finalLedgerEventCount: context.ledger.eventCount,
            phaseVFinalDecision: report.finalDecision,
            workflowRoute: report.workflowRoute
          };
          if (typeof fixture.governedChangeFreshnessSnapshotMutation === "function") {
            const mutatedSnapshot = fixture.governedChangeFreshnessSnapshotMutation(
              currentFreshnessSnapshot,
              runtime,
              context
            );
            if (mutatedSnapshot !== undefined) {
              currentFreshnessSnapshot = mutatedSnapshot;
            }
          }
          currentGovernedChangeFreshnessSnapshot = currentFreshnessSnapshot;
          let artifactForFreshness = artifact;
          if (typeof fixture.governedChangeArtifactMutation === "function") {
            const mutatedArtifact = fixture.governedChangeArtifactMutation(
              artifact,
              runtime,
              context
            );
            if (mutatedArtifact !== undefined) artifactForFreshness = mutatedArtifact;
          }
          const freshnessResult = runtime.verifyGovernedChangeArtifactFreshness(
            artifactForFreshness,
            currentFreshnessSnapshot
          );
          report.governedChangeFreshness = {
            evaluated: true,
            decision: freshnessResult.decision,
            artifactIntegrityVerified: freshnessResult.artifactIntegrityVerified,
            currentSnapshotHash: freshnessResult.currentSnapshotHash,
            staleFields: [...freshnessResult.staleFields],
            reasonCodes: [...freshnessResult.reasonCodes],
            snapshotCurrent: freshnessResult.summary.snapshotCurrent,
            handoffEligible: freshnessResult.handoffEligible,
            result: freshnessResult
          };
          report.governedChangeFreshnessStageDecision = freshnessResult.decision;
        }
      }
    }

    const finalEventAfter = context.ledger.events.at(-1) || null;
    const ledgerUnchanged =
      context.ledger.eventCount === ledgerInvariant.eventCount &&
      context.ledger.rootHash === ledgerInvariant.rootHash &&
      (finalEventAfter ? finalEventAfter.eventId : null) === ledgerInvariant.finalEventId &&
      (finalEventAfter ? finalEventAfter.eventHash : null) === ledgerInvariant.finalEventHash;
    if (!ledgerUnchanged || !finalEventAfter ||
        finalEventAfter.actor !== "approval_router" ||
        finalEventAfter.action !== "approval_router.evaluate") {
      report.governedChangeArtifact.issueCodes = boundedCodes([
        ...report.governedChangeArtifact.issueCodes,
        "governed_change_final_ledger_mutated"
      ]);
      context.issueCodes.push("governed_change_final_ledger_mutated");
    }

    const artifact = report.governedChangeArtifact.artifact;
    const artifactDecisionAccepted = new Set([
      "governed_change_artifact_ready",
      "governed_change_artifact_blocked"
    ]).has(report.governedChangeArtifact.decision);
    const generalSatisfied =
      artifactDecisionAccepted &&
      artifact !== null &&
      report.governedChangeArtifact.governedArtifactHash !== null &&
      report.governedChangeFreshness.decision === "governed_change_current" &&
      report.governedChangeFreshness.artifactIntegrityVerified === true &&
      ledgerUnchanged;
    const autoRouteSatisfied = report.workflowRoute !== "auto_continue" || (
      report.governedChangeArtifact.decision === "governed_change_artifact_ready" &&
      artifact && artifact.applyEligibility.eligible === true &&
      report.governedChangeFreshness.handoffEligible === true
    );
    const nonAutoRouteSatisfied = report.workflowRoute === "auto_continue" || (
      report.governedChangeArtifact.decision === "governed_change_artifact_blocked" &&
      artifact && artifact.applyEligibility.eligible === false &&
      report.governedChangeFreshness.handoffEligible === false
    );
    report.governedChangeArtifact.requiredSatisfied = Boolean(
      generalSatisfied && autoRouteSatisfied && nonAutoRouteSatisfied
    );
  }

  integrateControlledApplyHandoff(
    report,
    config,
    context,
    activeGovernedMutation,
    currentGovernedChangeFreshnessSnapshot
  );

  const requiredSatisfied = !config.shadow.required || !shadowEligible || (
    report.shadowObserver.called &&
    report.shadowObserver.observation !== null &&
    (report.shadowObserver.decision === "shadow_observer_completed" ||
      report.shadowObserver.decision === "shadow_observer_needs_review")
  );
  report.shadowObserver.requiredSatisfied = requiredSatisfied;
  if (!requiredSatisfied) {
    report.ok = false;
    report.status = "failed_required_shadow";
  }

  const adminRequiredApplicable = governanceAssessment !== null && preTrace !== null;
  const adminRequiredSatisfied = !config.admin.required || !adminRequiredApplicable || (
    report.adminAgent.called &&
    report.adminAgent.adminDecision !== null &&
    (report.adminAgent.adapterDecision === "admin_agent_completed" ||
      report.adminAgent.adapterDecision === "admin_agent_needs_review")
  );
  report.adminAgent.requiredSatisfied = adminRequiredSatisfied;
  if (!adminRequiredSatisfied) {
    report.ok = false;
    if (report.status !== "failed_required_shadow") {
      report.status = "failed_required_admin";
    }
  }

  const approvalRouterRequiredSatisfied = !approvalRouterEligible || (
    report.approvalRouter.validationDecision === "approval_route_valid" &&
    report.approvalRouter.route !== null &&
    report.approvalRouter.assessment !== null &&
    report.approvalRouter.routeHash !== null &&
    report.approvalRouter.eventAppended &&
    accountability.postRouterLedgerVerificationDecision === "ledger_valid" &&
    accountability.postRouterTrace !== null
  );
  report.approvalRouter.requiredSatisfied = approvalRouterRequiredSatisfied;
  if (!approvalRouterRequiredSatisfied) {
    report.ok = false;
    if (report.status !== "failed_required_shadow" &&
        report.status !== "failed_required_admin") {
      report.status = "failed_required_approval_router";
    }
  }

  if (report.governedChangeArtifact.required &&
      !report.governedChangeArtifact.requiredSatisfied) {
    report.ok = false;
    if (report.status !== "failed_required_shadow" &&
        report.status !== "failed_required_admin" &&
        report.status !== "failed_required_approval_router") {
      report.status = "failed_required_governed_change_artifact";
    }
  }

  if (report.controlledApplyHandoff.required &&
      !report.controlledApplyHandoff.requiredSatisfied) {
    report.ok = false;
    if (report.status !== "failed_required_shadow" &&
        report.status !== "failed_required_admin" &&
        report.status !== "failed_required_approval_router" &&
        report.status !== "failed_required_governed_change_artifact") {
      report.status = "failed_required_controlled_apply_handoff";
    }
  }

  accountability.evidenceComplete = context.evidenceComplete;
  accountability.issueCodes = boundedCodes(context.issueCodes);
  accountability.ledger = context.ledger;
  accountability.preShadowTrace = preTrace;
  accountability.postShadowTrace = accountability.postShadowTrace || null;
  accountability.postGovernanceTrace = accountability.postGovernanceTrace || null;
  accountability.postAdminTrace = accountability.postAdminTrace || null;
  accountability.postRouterTrace = accountability.postRouterTrace || null;
  populateDecisionAccountability(report);
}

function canVerifyTemporaryWorkspaceExecution(tempWorkspaceApply) {
  return Boolean(
    tempWorkspaceApply &&
      tempWorkspaceApply.called === true &&
      tempWorkspaceApply.decision === "temp_apply_ready" &&
      typeof tempWorkspaceApply.tempWorkspacePath === "string" &&
      tempWorkspaceApply.tempWorkspacePath.length > 0 &&
      tempWorkspaceApply.cleanedUp === false
  );
}

function verifyAndCleanupTemporaryWorkspace(
  tempWorkspaceApply,
  trustedValidationConfig,
  verifyTemporaryWorkspaceExecution,
  options = {}
) {
  const report = emptyTemporaryWorkspaceExecutionReport();

  if (!canVerifyTemporaryWorkspaceExecution(tempWorkspaceApply)) {
    return report;
  }

  const tempWorkspacePath = tempWorkspaceApply.tempWorkspacePath;
  const removeWorkspace = options.removeWorkspace ?? ((workspacePath) => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  const workspaceExists = options.workspaceExists ?? fs.existsSync;
  report.called = true;

  try {
    const result = verifyTemporaryWorkspaceExecution({
      tempWorkspacePath,
      tempApplyDecision: "temp_apply_ready",
      tempWorkspaceCleanedUp: false,
      commands: trustedValidationConfig.validationCommands,
      allowedExecutables: trustedValidationConfig.validationAllowedExecutables,
      environment: trustedValidationConfig.validationEnvironment,
      maxCommands: 5,
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000,
      maxOutputChars: options.maxOutputChars ?? 20000
    });

    report.decision = result.decision;
    report.ok = result.decision === "temp_validation_passed";
    report.issueCount = result.issues.length;
    report.issues = [...result.issues];
    report.commandCount = result.summary.totalCommands;
    report.passedCommands = result.summary.passedCommands;
    report.failedCommands = result.summary.failedCommands;
    report.timedOutCommands = result.summary.timedOutCommands;
    report.truncatedOutputs = result.summary.truncatedOutputs;
    report.durationMs = result.summary.durationMs;
    report.commandResults = result.commandResults.map((commandResult) => ({
      ...commandResult,
      args: [...commandResult.args]
    }));
  } catch (error) {
    report.decision = "temp_validation_needs_review";
    report.ok = false;
    report.issues.push({
      code: "temp_validation_execution_exception",
      message: error instanceof Error ? error.message : String(error),
      severity: "review"
    });
    report.issueCount = report.issues.length;
  } finally {
    report.cleanupAttempted = true;

    try {
      removeWorkspace(tempWorkspacePath);
      report.cleanupPerformed = !workspaceExists(tempWorkspacePath);

      if (!report.cleanupPerformed) {
        throw new Error("Temporary workspace still exists after cleanup.");
      }
    } catch (error) {
      report.cleanupPerformed = false;
      report.cleanupError = error instanceof Error ? error.message : String(error);
      report.issues.push({
        code: "temp_workspace_cleanup_failed",
        message: report.cleanupError,
        severity: "review"
      });
      report.issueCount = report.issues.length;
      report.decision = "temp_validation_needs_review";
      report.ok = false;
    }
  }

  return report;
}

async function callOpenAiCompatibleEndpoint(config, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        top_p: 0.95,
        max_tokens: maxTokens,
        messages
      })
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new Error(`Orchestrator endpoint returned HTTP ${response.status}: ${preview(text, 500)}`);
    }

    return {
      latencyMs,
      data: JSON.parse(text)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function finalDecisionForVerifierDecision(verifierDecision) {
  if (verifierDecision === "approve") {
    return "approved_by_deterministic_verifier";
  }

  if (verifierDecision === "needs_review") {
    return "needs_review_by_deterministic_verifier";
  }

  if (verifierDecision === "reject") {
    return "rejected_by_deterministic_verifier";
  }

  return "blocked_before_verifier";
}

function finalDecisionForRepairVerifierDecision(repairVerifierDecision) {
  if (repairVerifierDecision === "approve") {
    return "repair_approved_by_deterministic_verifier";
  }

  if (repairVerifierDecision === "needs_review") {
    return "repair_needs_review_by_deterministic_verifier";
  }

  if (repairVerifierDecision === "reject") {
    return "repair_rejected_by_deterministic_verifier";
  }

  return "repair_draft_ready";
}

function finalDecisionForPatchDryRunDecision(patchDryRunDecision) {
  if (patchDryRunDecision === "ready_to_apply") {
    return "patch_ready_to_apply";
  }

  if (patchDryRunDecision === "needs_review") {
    return "patch_dry_run_needs_review";
  }

  if (patchDryRunDecision === "reject") {
    return "patch_dry_run_rejected";
  }

  return "repair_approved_by_deterministic_verifier";
}

function finalDecisionForTemporaryWorkspaceApplyDecision(decision) {
  if (decision === "temp_apply_ready") {
    return "temp_apply_ready";
  }
  if (decision === "temp_apply_needs_review") {
    return "temp_apply_needs_review";
  }
  if (decision === "temp_apply_rejected") {
    return "temp_apply_rejected";
  }
  return "patch_ready_to_apply";
}

function buildForcedRemaskVerifierResult(mutation) {
  const issues = [
    {
      code: "missing_proposed_patch",
      message: "Forced repairable issue for remask path smoke.",
      file: "packages/example/src/index.ts"
    }
  ];
  const finding = {
    role: "verifier",
    target: "verifierFinding",
    summary: "Forced repairable verifier finding for remask path smoke.",
    claims: [
      {
        type: "deterministic_verifier_finding",
        decision: "needs_review",
        issues
      }
    ],
    touchedFiles: mutation && Array.isArray(mutation.touchedFiles) ? mutation.touchedFiles : [],
    confidence: 1
  };

  return {
    ok: false,
    decision: "needs_review",
    issues,
    finding
  };
}

function repairableIssueCodesFromRemaskRequest(remaskRequest) {
  if (!remaskRequest || !Array.isArray(remaskRequest.claims)) {
    return [];
  }

  const claim = remaskRequest.claims.find((candidate) => {
    return candidate && typeof candidate === "object" && candidate.type === "remask_request";
  });

  if (!claim || !Array.isArray(claim.repairableIssueCodes)) {
    return [];
  }

  return claim.repairableIssueCodes.filter((issueCode) => typeof issueCode === "string");
}

function decide(
  plannerValidation,
  coderValidation,
  verifierResult = null,
  remaskResult = null,
  remaskReport = null,
  options = {}
) {
  if (!plannerValidation.ok) {
    return {
      finalDecision: "blocked_before_coder",
      reason: "planner validation failure blocked coder execution",
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
      tempWorkspaceApplyCalled: false,
      tempWorkspaceApplyDecision: null,
      tempWorkspaceApplyIssueCount: 0,
      tempWorkspaceApplyChangedFiles: null,
      tempWorkspaceApplyCleanedUp: null,
      ...emptyTemporaryWorkspaceExecutionDecision(),
      ...emptyAccountabilityDecisionSummary()
    };
  }

  if (!coderValidation.ok) {
    return {
      finalDecision: "blocked_before_verifier",
      reason: "coder validation failure blocked deterministic verifier execution",
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
      tempWorkspaceApplyCalled: false,
      tempWorkspaceApplyDecision: null,
      tempWorkspaceApplyIssueCount: 0,
      tempWorkspaceApplyChangedFiles: null,
      tempWorkspaceApplyCleanedUp: null,
      ...emptyTemporaryWorkspaceExecutionDecision()
    };
  }

  if (verifierResult) {
    const remaskRequested = Boolean(remaskResult && remaskResult.remaskRequest);
    const remaskValidationOk =
      remaskReport && remaskReport.validation ? Boolean(remaskReport.validation.ok) : null;
    const repairDraftChecksOk =
      remaskReport && remaskReport.repairDraftChecks
        ? Boolean(remaskReport.repairDraftChecks.ok)
        : null;
    const repairVerifier = options.repairVerifier ?? null;
    const repairVerifierCalled = Boolean(repairVerifier && repairVerifier.called);
    const repairVerifierDecision =
      repairVerifier && repairVerifier.decision !== undefined ? repairVerifier.decision : null;
    const repairVerifierIssueCount =
      repairVerifier && typeof repairVerifier.issueCount === "number" ? repairVerifier.issueCount : 0;
    const patchDryRun = options.patchDryRun ?? null;
    const patchDryRunCalled = Boolean(patchDryRun && patchDryRun.called);
    const patchDryRunDecision =
      patchDryRun && patchDryRun.decision !== undefined ? patchDryRun.decision : null;
    const patchDryRunIssueCount =
      patchDryRun && typeof patchDryRun.issueCount === "number" ? patchDryRun.issueCount : 0;
    const patchDryRunChangedFiles =
      patchDryRun && patchDryRun.summary && typeof patchDryRun.summary.changedFiles === "number"
        ? patchDryRun.summary.changedFiles
        : null;
    const tempWorkspaceApply = options.tempWorkspaceApply ?? null;
    const tempWorkspaceApplyCalled = Boolean(tempWorkspaceApply && tempWorkspaceApply.called);
    const tempWorkspaceApplyDecision =
      tempWorkspaceApply && tempWorkspaceApply.decision !== undefined
        ? tempWorkspaceApply.decision
        : null;
    const tempWorkspaceApplyIssueCount =
      tempWorkspaceApply && typeof tempWorkspaceApply.issueCount === "number"
        ? tempWorkspaceApply.issueCount
        : 0;
    const tempWorkspaceApplyChangedFiles =
      tempWorkspaceApply && typeof tempWorkspaceApply.changedFiles === "number"
        ? tempWorkspaceApply.changedFiles
        : null;
    const tempWorkspaceApplyCleanedUp =
      tempWorkspaceApply && typeof tempWorkspaceApply.cleanedUp === "boolean"
        ? tempWorkspaceApply.cleanedUp
        : null;
    const tempWorkspaceExecution = options.tempWorkspaceExecution ?? null;
    const tempWorkspaceExecutionCalled = Boolean(
      tempWorkspaceExecution && tempWorkspaceExecution.called
    );
    const tempWorkspaceExecutionDecision =
      tempWorkspaceExecution && tempWorkspaceExecution.decision !== undefined
        ? tempWorkspaceExecution.decision
        : null;
    const tempWorkspaceExecutionIssueCount =
      tempWorkspaceExecution && typeof tempWorkspaceExecution.issueCount === "number"
        ? tempWorkspaceExecution.issueCount
        : 0;
    const tempWorkspaceExecutionCommandCount =
      tempWorkspaceExecution && typeof tempWorkspaceExecution.commandCount === "number"
        ? tempWorkspaceExecution.commandCount
        : 0;
    const tempWorkspaceExecutionPassedCommands =
      tempWorkspaceExecution && typeof tempWorkspaceExecution.passedCommands === "number"
        ? tempWorkspaceExecution.passedCommands
        : 0;
    const tempWorkspaceExecutionFailedCommands =
      tempWorkspaceExecution && typeof tempWorkspaceExecution.failedCommands === "number"
        ? tempWorkspaceExecution.failedCommands
        : 0;
    const tempWorkspaceExecutionTimedOutCommands =
      tempWorkspaceExecution && typeof tempWorkspaceExecution.timedOutCommands === "number"
        ? tempWorkspaceExecution.timedOutCommands
        : 0;
    const tempWorkspaceExecutionCleanupPerformed = Boolean(
      tempWorkspaceExecution && tempWorkspaceExecution.cleanupPerformed
    );
    const finalDecision =
      verifierResult.decision === "needs_review" && remaskRequested && remaskReport && remaskReport.called
        ? remaskValidationOk && repairDraftChecksOk
            ? repairVerifierCalled
              ? repairVerifierDecision === "approve" && patchDryRunCalled
              ? patchDryRunDecision === "ready_to_apply" && tempWorkspaceApplyCalled
                ? tempWorkspaceApplyDecision === "temp_apply_ready" && tempWorkspaceExecutionCalled
                  ? tempWorkspaceExecutionDecision
                  : finalDecisionForTemporaryWorkspaceApplyDecision(tempWorkspaceApplyDecision)
                : finalDecisionForPatchDryRunDecision(patchDryRunDecision)
              : finalDecisionForRepairVerifierDecision(repairVerifierDecision)
            : "repair_draft_ready"
          : "remask_repair_failed"
        : verifierResult.decision === "needs_review" && remaskRequested
          ? "remask_requested"
        : finalDecisionForVerifierDecision(verifierResult.decision);

    return {
      finalDecision,
      reason: `deterministic verifier decision: ${verifierResult.decision}`,
      verifierDecision: verifierResult.decision,
      verifierIssueCount: Array.isArray(verifierResult.issues) ? verifierResult.issues.length : 0,
      remaskRequested,
      remaskRepairability: remaskResult ? remaskResult.repairability : null,
      remaskValidationOk,
      repairDraftChecksOk,
      repairVerifierCalled,
      repairVerifierDecision,
      repairVerifierIssueCount,
      patchDryRunCalled,
      patchDryRunDecision,
      patchDryRunIssueCount,
      patchDryRunChangedFiles,
      tempWorkspaceApplyCalled,
      tempWorkspaceApplyDecision,
      tempWorkspaceApplyIssueCount,
      tempWorkspaceApplyChangedFiles,
      tempWorkspaceApplyCleanedUp,
      tempWorkspaceExecutionCalled,
      tempWorkspaceExecutionDecision,
      tempWorkspaceExecutionIssueCount,
      tempWorkspaceExecutionCommandCount,
      tempWorkspaceExecutionPassedCommands,
      tempWorkspaceExecutionFailedCommands,
      tempWorkspaceExecutionTimedOutCommands,
      tempWorkspaceExecutionCleanupPerformed,
      forcedRemask: Boolean(options.forcedRemask)
    };
  }

  return {
    finalDecision: "ready_for_deterministic_verifier",
    reason: "planner and coder workspace mutations validated",
    repairVerifierCalled: false,
    repairVerifierDecision: null,
    repairVerifierIssueCount: 0,
    patchDryRunCalled: false,
    patchDryRunDecision: null,
    patchDryRunIssueCount: 0,
    patchDryRunChangedFiles: null,
    tempWorkspaceApplyCalled: false,
    tempWorkspaceApplyDecision: null,
    tempWorkspaceApplyIssueCount: 0,
    tempWorkspaceApplyChangedFiles: null,
    tempWorkspaceApplyCleanedUp: null,
    ...emptyTemporaryWorkspaceExecutionDecision()
  };
}

async function run() {
  const config = configFromEnv();

  if (!config.upstreamUrl) {
    const status = config.required ? "failed_required_endpoint_missing" : "skipped";
    const report = baseReport(config, status);
    report.ok = !config.required;
    report.orchestratorDecision = {
      ...report.orchestratorDecision,
      finalDecision: status,
      reason: "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured.",
      forcedRemask: config.forceRemask,
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
      tempWorkspaceApplyCalled: false,
      tempWorkspaceApplyDecision: null,
      tempWorkspaceApplyIssueCount: 0,
      tempWorkspaceApplyChangedFiles: null,
      tempWorkspaceApplyCleanedUp: null,
      ...emptyTemporaryWorkspaceExecutionDecision()
    };
    report.finalDecision = status;
    return writeReport(report, config);
  }

  const { validateModelWorkspaceMutation } = await loadValidator();
  const { verifyPatchDraftMutation } = await loadDeterministicVerifierGate();
  const { buildRemaskRequestFromVerifierFinding } = await loadRemaskRequestBuilder();
  const { verifyRepairDraftMutation } = await loadRepairDraftVerifierGate();
  const { dryRunPatchApplication } = await loadPatchApplicationDryRunGate();
  const { applyToTemporaryWorkspace } = await loadTemporaryWorkspaceApplyGate();
  const { verifyTemporaryWorkspaceExecution } =
    await loadTemporaryWorkspaceExecutionVerifier();
  const accountabilityRuntime = await loadAccountabilityRuntime();
  const accountabilityContext = createAccountabilityContext(accountabilityRuntime);
  const report = baseReport(config, "completed");
  let activeAccountabilityStage = null;

  try {
    const plannerStartedAt = timestampNow();
    activeAccountabilityStage = {
      actor: "planner",
      action: "planner.plan",
      startedAt: plannerStartedAt,
      inputArtifactHashes: [accountabilityContext.objectiveHash],
      filesRead: [],
      filesProposed: []
    };
    report.planner.called = true;
    const plannerResponse = await callOpenAiCompatibleEndpoint(
      config,
      buildPlannerMessages(fixture),
      config.plannerMaxTokens
    );
    const rawPlannerOutput = extractContent(plannerResponse.data);
    const plannerUsage = tokenUsage(plannerResponse.data);
    const plannerValidation = validateModelWorkspaceMutation(rawPlannerOutput, {
      role: "planner",
      allowedFiles: fixture.allowedFiles,
      forbiddenFiles: fixture.forbiddenFiles
    });

    report.planner.latencyMs = plannerResponse.latencyMs;
    report.planner.promptTokens = plannerUsage.promptTokens;
    report.planner.completionTokens = plannerUsage.completionTokens;
    report.planner.totalTokens = plannerUsage.totalTokens;
    report.planner.rawOutputPreview = preview(rawPlannerOutput);
    report.planner.validation = plannerValidation;
    const plannerFinishedAt = timestampNow(plannerStartedAt);
    if (plannerValidation.mutation) {
      accountabilityContext.hashes.plannerMutationHash = labeledHash(
        accountabilityRuntime,
        "planner_validated_mutation",
        plannerValidation.mutation
      );
    }
    accountabilityContext.hashes.plannerValidationHash = labeledHash(
      accountabilityRuntime,
      "planner_validation_result",
      plannerValidation
    );
    appendAccountabilityEvent(accountabilityContext, {
      actor: "planner",
      action: "planner.plan",
      startedAt: plannerStartedAt,
      finishedAt: plannerFinishedAt,
      inputArtifactHashes: [accountabilityContext.objectiveHash],
      outputArtifactHashes: [
        accountabilityContext.hashes.plannerMutationHash,
        accountabilityContext.hashes.plannerValidationHash
      ],
      filesRead: [],
      filesProposed: plannerValidation.mutation
        ? plannerValidation.mutation.touchedFiles
        : [],
      decision: plannerValidation.ok ? "planner_valid" : "planner_invalid",
      reasonCodes: plannerValidation.issues,
      ...(validTokenUsage(report.planner)
        ? { tokenUsage: validTokenUsage(report.planner) }
        : {})
    });
    activeAccountabilityStage = null;

    if (!plannerValidation.ok) {
      report.ok = true;
      report.status = "completed";
      const decision = decide(plannerValidation, report.coder.validation);
      report.finalDecision = decision.finalDecision;
      report.orchestratorDecision = decision;
      await finalizeAccountabilityAndShadow(
        report,
        config,
        accountabilityContext
      );
      return writeReport(report, config);
    }

    const coderStartedAt = timestampNow();
    activeAccountabilityStage = {
      actor: "coder",
      action: "coder.patch_draft",
      startedAt: coderStartedAt,
      inputArtifactHashes: [accountabilityContext.hashes.plannerMutationHash],
      filesRead: plannerValidation.mutation.touchedFiles,
      filesProposed: []
    };
    report.coder.called = true;
    const coderResponse = await callOpenAiCompatibleEndpoint(
      config,
      buildCoderMessages(fixture, plannerValidation.mutation),
      config.coderMaxTokens
    );
    const rawCoderOutput = extractContent(coderResponse.data);
    const coderUsage = tokenUsage(coderResponse.data);
    const coderValidation = validateModelWorkspaceMutation(rawCoderOutput, {
      role: "coder",
      allowedFiles: fixture.allowedFiles,
      forbiddenFiles: fixture.forbiddenFiles
    });

    report.coder.latencyMs = coderResponse.latencyMs;
    report.coder.promptTokens = coderUsage.promptTokens;
    report.coder.completionTokens = coderUsage.completionTokens;
    report.coder.totalTokens = coderUsage.totalTokens;
    report.coder.rawOutputPreview = preview(rawCoderOutput);
    report.coder.validation = coderValidation;
    const coderFinishedAt = timestampNow(coderStartedAt);
    if (coderValidation.mutation) {
      accountabilityContext.hashes.coderMutationHash = labeledHash(
        accountabilityRuntime,
        "coder_validated_mutation",
        coderValidation.mutation
      );
    }
    accountabilityContext.hashes.coderValidationHash = labeledHash(
      accountabilityRuntime,
      "coder_validation_result",
      coderValidation
    );
    appendAccountabilityEvent(accountabilityContext, {
      actor: "coder",
      action: "coder.patch_draft",
      startedAt: coderStartedAt,
      finishedAt: coderFinishedAt,
      inputArtifactHashes: [accountabilityContext.hashes.plannerMutationHash],
      outputArtifactHashes: [
        accountabilityContext.hashes.coderMutationHash,
        accountabilityContext.hashes.coderValidationHash
      ],
      filesRead: plannerValidation.mutation.touchedFiles,
      filesProposed: coderValidation.mutation
        ? coderValidation.mutation.touchedFiles
        : [],
      decision: coderValidation.ok ? "coder_valid" : "coder_invalid",
      reasonCodes: coderValidation.issues,
      ...(validTokenUsage(report.coder)
        ? { tokenUsage: validTokenUsage(report.coder) }
        : {})
    });
    activeAccountabilityStage = null;

    let verifierResult = null;
    let remaskResult = null;
    if (coderValidation.ok) {
      const verifierStartedAt = timestampNow();
      activeAccountabilityStage = {
        actor: "deterministic_verifier",
        action: "deterministic_verifier.patch_draft",
        startedAt: verifierStartedAt,
        inputArtifactHashes: [accountabilityContext.hashes.coderMutationHash],
        filesRead: coderValidation.mutation.touchedFiles,
        filesProposed: []
      };
      verifierResult = config.forceRemask
        ? buildForcedRemaskVerifierResult(coderValidation.mutation)
        : verifyPatchDraftMutation(coderValidation.mutation, {
          allowedFiles: fixture.allowedFiles,
          forbiddenFiles: fixture.forbiddenFiles,
          minConfidence: 0.5
        });
      report.verifier = {
        called: true,
        forcedRemask: config.forceRemask,
        decision: verifierResult.decision,
        ok: verifierResult.ok,
        issueCount: verifierResult.issues.length,
        issues: verifierResult.issues,
        finding: verifierResult.finding
      };
      const verifierFinishedAt = timestampNow(verifierStartedAt);
      accountabilityContext.hashes.initialVerifierResultHash = labeledHash(
        accountabilityRuntime,
        "initial_deterministic_verifier_result",
        verifierResult
      );
      appendAccountabilityEvent(accountabilityContext, {
        actor: "deterministic_verifier",
        action: "deterministic_verifier.patch_draft",
        startedAt: verifierStartedAt,
        finishedAt: verifierFinishedAt,
        inputArtifactHashes: [accountabilityContext.hashes.coderMutationHash],
        outputArtifactHashes: [accountabilityContext.hashes.initialVerifierResultHash],
        filesRead: coderValidation.mutation.touchedFiles,
        filesProposed: [],
        decision: verifierResult.decision,
        reasonCodes: verifierResult.issues
      });
      activeAccountabilityStage = null;

      if (verifierResult.decision === "needs_review") {
        const maskerStartedAt = timestampNow();
        activeAccountabilityStage = {
          actor: "masker",
          action: "masker.repair_scope",
          startedAt: maskerStartedAt,
          inputArtifactHashes: [accountabilityContext.hashes.initialVerifierResultHash],
          filesRead: coderValidation.mutation.touchedFiles,
          filesProposed: []
        };
        remaskResult = buildRemaskRequestFromVerifierFinding(
          coderValidation.mutation,
          verifierResult.finding,
          {
            allowedFiles: fixture.allowedFiles,
            forbiddenFiles: fixture.forbiddenFiles,
            maxRepairSteps: 3
          }
        );
        const maskerFinishedAt = timestampNow(maskerStartedAt);
        report.remask = {
          called: false,
          requested: Boolean(remaskResult.remaskRequest),
          repairability: remaskResult.repairability,
          issueCount: remaskResult.issues.length,
          issues: remaskResult.issues,
          request: remaskResult.remaskRequest,
          latencyMs: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          rawOutputPreview: "",
          validation: null,
          repairDraftChecks: null
        };

        if (remaskResult.remaskRequest || config.forceRemask) {
          accountabilityContext.hashes.remaskRequestHash = labeledHash(
            accountabilityRuntime,
            "remask_request",
            remaskResult.remaskRequest || {
              forced: true,
              repairability: remaskResult.repairability,
              issues: remaskResult.issues.map((issue) => issue.code)
            }
          );
          appendAccountabilityEvent(accountabilityContext, {
            actor: "masker",
            action: "masker.repair_scope",
            startedAt: maskerStartedAt,
            finishedAt: maskerFinishedAt,
            inputArtifactHashes: [accountabilityContext.hashes.initialVerifierResultHash],
            outputArtifactHashes: [accountabilityContext.hashes.remaskRequestHash],
            filesRead: coderValidation.mutation.touchedFiles,
            filesProposed: remaskResult.remaskRequest
              ? remaskResult.remaskRequest.touchedFiles
              : [],
            decision: remaskResult.remaskRequest
              ? "remask_requested"
              : "remask_forced",
            reasonCodes: [
              ...verifierResult.issues,
              ...remaskResult.issues,
              ...repairableIssueCodesFromRemaskRequest(remaskResult.remaskRequest)
            ]
          });
        }
        activeAccountabilityStage = null;

        if (remaskResult.remaskRequest) {
          report.remask.called = true;
          const repairerStartedAt = timestampNow();
          let repairerEventAppended = false;
          try {
            const remaskResponse = await callOpenAiCompatibleEndpoint(
              config,
              buildRemaskMessages({
                ...fixture,
                originalPatchDraft: coderValidation.mutation,
                verifierFinding: verifierResult.finding,
                remaskRequest: remaskResult.remaskRequest
              }),
              config.remaskMaxTokens
            );
            const rawRemaskOutput = extractContent(remaskResponse.data);
            const remaskUsage = tokenUsage(remaskResponse.data);
            const remaskValidation = validateModelWorkspaceMutation(rawRemaskOutput, {
              role: "remask",
              allowedFiles: fixture.allowedFiles,
              forbiddenFiles: fixture.forbiddenFiles
            });
            const repairDraftChecks = remaskValidation.ok
              ? checkRepairDraftMutation(remaskValidation.mutation)
              : emptyRepairDraftChecks();

            report.remask.latencyMs = remaskResponse.latencyMs;
            report.remask.promptTokens = remaskUsage.promptTokens;
            report.remask.completionTokens = remaskUsage.completionTokens;
            report.remask.totalTokens = remaskUsage.totalTokens;
            report.remask.rawOutputPreview = preview(rawRemaskOutput);
            report.remask.validation = remaskValidation;
            report.remask.repairDraftChecks = repairDraftChecks;
            const repairerFinishedAt = timestampNow(repairerStartedAt);
            if (remaskValidation.mutation) {
              accountabilityContext.hashes.repairDraftHash = labeledHash(
                accountabilityRuntime,
                "repair_draft_mutation",
                remaskValidation.mutation
              );
            }
            accountabilityContext.hashes.repairValidationHash = labeledHash(
              accountabilityRuntime,
              "repair_draft_validation",
              { validation: remaskValidation, checks: repairDraftChecks }
            );
            repairerEventAppended = appendAccountabilityEvent(accountabilityContext, {
              actor: "repairer",
              action: "repairer.repair_draft",
              startedAt: repairerStartedAt,
              finishedAt: repairerFinishedAt,
              inputArtifactHashes: [accountabilityContext.hashes.remaskRequestHash],
              outputArtifactHashes: [
                accountabilityContext.hashes.repairDraftHash,
                accountabilityContext.hashes.repairValidationHash
              ],
              filesRead: remaskResult.remaskRequest.touchedFiles,
              filesProposed: remaskValidation.mutation
                ? remaskValidation.mutation.touchedFiles
                : [],
              decision: remaskValidation.ok
                ? "repair_draft_valid"
                : "repair_draft_invalid",
              reasonCodes: [
                ...remaskValidation.issues,
                ...repairDraftChecks.issues
              ],
              ...(validTokenUsage(report.remask)
                ? { tokenUsage: validTokenUsage(report.remask) }
                : {})
            });

            if (
              remaskValidation.ok &&
              remaskValidation.mutation &&
              repairDraftChecks.ok
            ) {
              const repairVerifierStartedAt = timestampNow();
              activeAccountabilityStage = {
                actor: "repair_verifier",
                action: "repair_verifier.repair_draft",
                startedAt: repairVerifierStartedAt,
                inputArtifactHashes: [accountabilityContext.hashes.repairDraftHash],
                filesRead: remaskValidation.mutation.touchedFiles,
                filesProposed: []
              };
              const repairVerifierResult = verifyRepairDraftMutation(remaskValidation.mutation, {
                allowedFiles: fixture.allowedFiles,
                forbiddenFiles: fixture.forbiddenFiles,
                requiredIssueCodes: repairableIssueCodesFromRemaskRequest(remaskResult.remaskRequest),
                minConfidence: 0.5
              });

              report.repairVerifier = {
                called: true,
                decision: repairVerifierResult.decision,
                ok: repairVerifierResult.decision === "approve",
                issueCount: repairVerifierResult.issues.length,
                issues: repairVerifierResult.issues,
                finding: repairVerifierResult.finding
              };
              const repairVerifierFinishedAt = timestampNow(repairVerifierStartedAt);
              accountabilityContext.hashes.repairVerifierResultHash = labeledHash(
                accountabilityRuntime,
                "repair_deterministic_verifier_result",
                repairVerifierResult
              );
              appendAccountabilityEvent(accountabilityContext, {
                actor: "repair_verifier",
                action: "repair_verifier.repair_draft",
                startedAt: repairVerifierStartedAt,
                finishedAt: repairVerifierFinishedAt,
                inputArtifactHashes: [accountabilityContext.hashes.repairDraftHash],
                outputArtifactHashes: [accountabilityContext.hashes.repairVerifierResultHash],
                filesRead: remaskValidation.mutation.touchedFiles,
                filesProposed: [],
                decision: repairVerifierResult.decision,
                reasonCodes: repairVerifierResult.issues
              });
              activeAccountabilityStage = null;

              if (repairVerifierResult.decision === "approve") {
                setActiveGovernedChange(
                  accountabilityContext,
                  "repair_draft",
                  remaskValidation.mutation,
                  accountabilityContext.hashes.repairDraftHash
                );
                const patchDryRunStartedAt = timestampNow();
                activeAccountabilityStage = {
                  actor: "patch_dry_run",
                  action: "patch_dry_run.evaluate",
                  startedAt: patchDryRunStartedAt,
                  inputArtifactHashes: [
                    accountabilityContext.hashes.repairDraftHash,
                    accountabilityContext.hashes.repairVerifierResultHash
                  ],
                  filesRead: remaskValidation.mutation.touchedFiles,
                  filesProposed: []
                };
                const patchDryRunResult = dryRunPatchApplication(
                  remaskValidation.mutation,
                  repairVerifierResult.finding,
                  {
                    allowedFiles: fixture.allowedFiles,
                    forbiddenFiles: fixture.forbiddenFiles,
                    fileContents: fixture.fileContents,
                    requiredRepairVerifierDecision: "approve",
                    maxProposedPatchChars: 20000,
                    maxDiffPreviewLines: 80
                  }
                );

                report.patchDryRun = {
                  called: true,
                  decision: patchDryRunResult.decision,
                  ok: patchDryRunResult.decision === "ready_to_apply",
                  issueCount: patchDryRunResult.issues.length,
                  issues: patchDryRunResult.issues,
                  summary: patchDryRunResult.summary,
                  previews: patchDryRunResult.previews
                };
                const patchDryRunFinishedAt = timestampNow(patchDryRunStartedAt);
                accountabilityContext.hashes.patchDryRunResultHash = labeledHash(
                  accountabilityRuntime,
                  "patch_dry_run_result",
                  patchDryRunResult
                );
                accountabilityContext.governedChange.patchDryRunResultHash =
                  accountabilityContext.hashes.patchDryRunResultHash;
                appendAccountabilityEvent(accountabilityContext, {
                  actor: "patch_dry_run",
                  action: "patch_dry_run.evaluate",
                  startedAt: patchDryRunStartedAt,
                  finishedAt: patchDryRunFinishedAt,
                  inputArtifactHashes: [
                    accountabilityContext.hashes.repairDraftHash,
                    accountabilityContext.hashes.repairVerifierResultHash
                  ],
                  outputArtifactHashes: [accountabilityContext.hashes.patchDryRunResultHash],
                  filesRead: remaskValidation.mutation.touchedFiles,
                  filesProposed: patchDryRunResult.previews,
                  decision: patchDryRunResult.decision,
                  reasonCodes: patchDryRunResult.issues
                });
                activeAccountabilityStage = null;

                if (patchDryRunResult.decision === "ready_to_apply") {
                  const tempApplyStartedAt = timestampNow();
                  activeAccountabilityStage = {
                    actor: "temp_workspace_apply",
                    action: "temp_workspace_apply.apply",
                    startedAt: tempApplyStartedAt,
                    inputArtifactHashes: [accountabilityContext.hashes.patchDryRunResultHash],
                    filesRead: patchDryRunResult.previews,
                    filesProposed: []
                  };
                  const tempWorkspaceApplyResult = applyToTemporaryWorkspace(
                    remaskValidation.mutation,
                    repairVerifierResult.finding,
                    patchDryRunResult,
                    {
                      allowedFiles: fixture.allowedFiles,
                      forbiddenFiles: fixture.forbiddenFiles,
                      fileContents: fixture.fileContents,
                      cleanup: false,
                      maxFiles: 10,
                      maxFileBytes: 100000,
                      maxDiffPreviewLines: 80
                    }
                  );

                  report.tempWorkspaceApply = {
                    called: true,
                    decision: tempWorkspaceApplyResult.decision,
                    ok: tempWorkspaceApplyResult.decision === "temp_apply_ready",
                    issueCount: tempWorkspaceApplyResult.issues.length,
                    issues: tempWorkspaceApplyResult.issues,
                    tempWorkspacePath: tempWorkspaceApplyResult.tempWorkspacePath,
                    appliedFileCount: tempWorkspaceApplyResult.appliedFiles.length,
                    changedFiles: tempWorkspaceApplyResult.summary.changedFiles,
                    cleanedUp: tempWorkspaceApplyResult.summary.cleanedUp,
                    summary: tempWorkspaceApplyResult.summary,
                    appliedFiles: tempWorkspaceApplyResult.appliedFiles
                  };
                  const tempApplyFinishedAt = timestampNow(tempApplyStartedAt);
                  accountabilityContext.hashes.temporaryApplyResultHash = labeledHash(
                    accountabilityRuntime,
                    "temporary_workspace_apply_result",
                    {
                      decision: tempWorkspaceApplyResult.decision,
                      issues: tempWorkspaceApplyResult.issues,
                      appliedFiles: tempWorkspaceApplyResult.appliedFiles.map((file) => ({
                        file: file.file,
                        changed: file.changed,
                        addedLines: file.addedLines,
                        removedLines: file.removedLines
                      })),
                      summary: tempWorkspaceApplyResult.summary
                    }
                  );
                  accountabilityContext.governedChange.temporaryApplyResultHash =
                    accountabilityContext.hashes.temporaryApplyResultHash;
                  appendAccountabilityEvent(accountabilityContext, {
                    actor: "temp_workspace_apply",
                    action: "temp_workspace_apply.apply",
                    startedAt: tempApplyStartedAt,
                    finishedAt: tempApplyFinishedAt,
                    inputArtifactHashes: [accountabilityContext.hashes.patchDryRunResultHash],
                    outputArtifactHashes: [accountabilityContext.hashes.temporaryApplyResultHash],
                    filesRead: patchDryRunResult.previews,
                    filesProposed: tempWorkspaceApplyResult.appliedFiles,
                    decision: tempWorkspaceApplyResult.decision,
                    reasonCodes: tempWorkspaceApplyResult.issues
                  });
                  activeAccountabilityStage = null;

                  const executionStartedAt = timestampNow();
                  activeAccountabilityStage = {
                    actor: "execution_verifier",
                    action: "execution_verifier.validate",
                    startedAt: executionStartedAt,
                    inputArtifactHashes: [accountabilityContext.hashes.temporaryApplyResultHash],
                    filesRead: tempWorkspaceApplyResult.appliedFiles,
                    filesProposed: []
                  };
                  report.tempWorkspaceExecution = verifyAndCleanupTemporaryWorkspace(
                    report.tempWorkspaceApply,
                    {
                      validationCommands: fixture.validationCommands,
                      validationAllowedExecutables: fixture.validationAllowedExecutables,
                      validationEnvironment: fixture.validationEnvironment
                    },
                    verifyTemporaryWorkspaceExecution
                  );
                  const executionFinishedAt = timestampNow(executionStartedAt);
                  if (report.tempWorkspaceExecution.called) {
                    accountabilityContext.hashes.executionVerificationResultHash = labeledHash(
                      accountabilityRuntime,
                      "temporary_workspace_execution_result",
                      {
                        decision: report.tempWorkspaceExecution.decision,
                        issues: report.tempWorkspaceExecution.issues,
                        commandCount: report.tempWorkspaceExecution.commandCount,
                        passedCommands: report.tempWorkspaceExecution.passedCommands,
                        failedCommands: report.tempWorkspaceExecution.failedCommands,
                        timedOutCommands: report.tempWorkspaceExecution.timedOutCommands,
                        truncatedOutputs: report.tempWorkspaceExecution.truncatedOutputs,
                        cleanupAttempted: report.tempWorkspaceExecution.cleanupAttempted,
                        cleanupPerformed: report.tempWorkspaceExecution.cleanupPerformed
                      }
                    );
                    accountabilityContext.governedChange.executionVerificationResultHash =
                      accountabilityContext.hashes.executionVerificationResultHash;
                    const executionReasonCodes = [
                      ...report.tempWorkspaceExecution.issues,
                      ...(fixture.cleanupEvidenceMode === "missing"
                        ? []
                        : fixture.cleanupEvidenceMode === "failed"
                          ? ["temp_workspace_cleanup_failed"]
                          : fixture.cleanupEvidenceMode === "conflicting"
                            ? [
                              "temp_workspace_cleanup_performed",
                              "temp_workspace_cleanup_failed"
                            ]
                            : report.tempWorkspaceExecution.cleanupPerformed
                              ? ["temp_workspace_cleanup_performed"]
                              : report.tempWorkspaceExecution.cleanupAttempted
                                ? ["temp_workspace_cleanup_failed"]
                                : []),
                      ...(report.tempWorkspaceExecution.failedCommands > 0
                        ? ["validation_command_failed"]
                        : []),
                      ...(report.tempWorkspaceExecution.timedOutCommands > 0
                        ? ["validation_command_timeout"]
                        : []),
                      ...(report.tempWorkspaceExecution.truncatedOutputs > 0
                        ? ["validation_output_truncated"]
                        : [])
                    ];
                    appendAccountabilityEvent(accountabilityContext, {
                      actor: "execution_verifier",
                      action: "execution_verifier.validate",
                      startedAt: executionStartedAt,
                      finishedAt: executionFinishedAt,
                      inputArtifactHashes: [accountabilityContext.hashes.temporaryApplyResultHash],
                      outputArtifactHashes: [
                        accountabilityContext.hashes.executionVerificationResultHash
                      ],
                      filesRead: tempWorkspaceApplyResult.appliedFiles,
                      filesProposed: [],
                      decision: report.tempWorkspaceExecution.decision,
                      reasonCodes: executionReasonCodes
                    });
                  }
                  activeAccountabilityStage = null;
                }
              }
            }
          } catch (error) {
            report.remask.validation = {
              ok: false,
              blocked: true,
              issues: [
                {
                  code: "invalid_shape",
                  message: "The repair model stage failed before bounded validation completed."
                }
              ],
              mutation: null
            };
            report.remask.repairDraftChecks = emptyRepairDraftChecks();
            if (!repairerEventAppended) {
              accountabilityContext.hashes.repairValidationHash = labeledHash(
                accountabilityRuntime,
                "repair_draft_validation",
                { ok: false, code: "invalid_shape" }
              );
              appendAccountabilityEvent(accountabilityContext, {
                actor: "repairer",
                action: "repairer.repair_draft",
                startedAt: repairerStartedAt,
                finishedAt: timestampNow(repairerStartedAt),
                inputArtifactHashes: [accountabilityContext.hashes.remaskRequestHash],
                outputArtifactHashes: [accountabilityContext.hashes.repairValidationHash],
                filesRead: remaskResult.remaskRequest.touchedFiles,
                filesProposed: [],
                decision: "repair_draft_invalid",
                reasonCodes: ["invalid_shape"]
              });
            }
          }
        }
      }
    }

    report.ok = true;
    report.status = "completed";
    const decision = decide(
      plannerValidation,
      coderValidation,
      verifierResult,
      remaskResult,
      report.remask,
      {
        forcedRemask: config.forceRemask,
        repairVerifier: report.repairVerifier,
        patchDryRun: report.patchDryRun,
        tempWorkspaceApply: report.tempWorkspaceApply,
        tempWorkspaceExecution: report.tempWorkspaceExecution
      }
    );
    report.finalDecision = decision.finalDecision;
    report.orchestratorDecision = decision;
  } catch (error) {
    if (activeAccountabilityStage !== null) {
      const failureHash = labeledHash(
        accountabilityRuntime,
        "orchestration_stage_failure",
        { actor: activeAccountabilityStage.actor, action: activeAccountabilityStage.action }
      );
      appendAccountabilityEvent(accountabilityContext, {
        ...activeAccountabilityStage,
        finishedAt: timestampNow(activeAccountabilityStage.startedAt),
        outputArtifactHashes: [failureHash],
        decision: "stage_failed",
        reasonCodes: ["stage_execution_failed"]
      });
      activeAccountabilityStage = null;
    }
    report.ok = false;
    report.status = "failed";
    report.finalDecision = "blocked";
    report.orchestratorDecision = {
      finalDecision: "blocked",
      reason: "A worker-backed orchestration stage failed.",
      repairVerifierCalled: false,
      repairVerifierDecision: null,
      repairVerifierIssueCount: 0,
      patchDryRunCalled: false,
      patchDryRunDecision: null,
      patchDryRunIssueCount: 0,
      patchDryRunChangedFiles: null,
      tempWorkspaceApplyCalled: false,
      tempWorkspaceApplyDecision: null,
      tempWorkspaceApplyIssueCount: 0,
      tempWorkspaceApplyChangedFiles: null,
      tempWorkspaceApplyCleanedUp: null,
      ...emptyTemporaryWorkspaceExecutionDecision()
    };
  }

  await finalizeAccountabilityAndShadow(report, config, accountabilityContext);

  return writeReport(report, config);
}

if (require.main === module) {
  run()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  SUITE_NAME,
  buildCoderMessages,
  buildForcedRemaskVerifierResult,
  buildPlannerMessages,
  canVerifyTemporaryWorkspaceExecution,
  configFromEnv,
  decide,
  emptyRemaskReport,
  emptyRepairVerifierReport,
  emptyPatchDryRunReport,
  emptyTemporaryWorkspaceApplyReport,
  emptyTemporaryWorkspaceExecutionReport,
  emptyVerifierReport,
  emptyGovernedChangeArtifactReport,
  emptyGovernedChangeFreshnessReport,
  emptyControlledApplyHandoffReport,
  emptyControlledApplyHandoffVerificationReport,
  fixture,
  finalDecisionForVerifierDecision,
  finalDecisionForRepairVerifierDecision,
  finalDecisionForPatchDryRunDecision,
  finalDecisionForTemporaryWorkspaceApplyDecision,
  repairableIssueCodesFromRemaskRequest,
  run,
  setActiveGovernedChange,
  verifyAndCleanupTemporaryWorkspace
};
