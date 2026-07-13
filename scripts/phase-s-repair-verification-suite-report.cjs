const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-s-repair-verification-suite-report";
const REPAIR_DRAFT_FIXTURE_REPORT_DIR = path.join(
  "reports",
  "repair-draft-verifier-negative-fixture-suite"
);
const ORCHESTRATOR_REPORT_DIR = path.join("reports", "worker-backed-orchestrator-smoke");
const SUITE_REPORT_DIR = path.join("reports", "phase-s-repair-verification-suite");

const repairAwareFinalDecisions = new Set([
  "approved_by_deterministic_verifier",
  "rejected_by_deterministic_verifier",
  "needs_review_by_deterministic_verifier",
  "remask_requested",
  "repair_draft_ready",
  "remask_repair_failed",
  "repair_approved_by_deterministic_verifier",
  "repair_needs_review_by_deterministic_verifier",
  "repair_rejected_by_deterministic_verifier",
  "patch_ready_to_apply",
  "patch_dry_run_needs_review",
  "patch_dry_run_rejected",
  "temp_apply_ready",
  "temp_apply_needs_review",
  "temp_apply_rejected",
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]);

const forcedRepairFinalDecisions = new Set([
  "repair_approved_by_deterministic_verifier",
  "repair_needs_review_by_deterministic_verifier",
  "repair_rejected_by_deterministic_verifier"
]);

const forcedPatchDryRunFinalDecisions = new Set([
  "patch_ready_to_apply",
  "patch_dry_run_needs_review",
  "patch_dry_run_rejected",
  "temp_apply_ready",
  "temp_apply_needs_review",
  "temp_apply_rejected",
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]);

const repairVerifierDecisions = new Set(["approve", "needs_review", "reject"]);
const patchDryRunDecisions = new Set(["ready_to_apply", "needs_review", "reject"]);

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function latestJsonReport(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }

  const candidates = fs.readdirSync(dirPath)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const fullPath = path.join(dirPath, fileName);
      return {
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length > 0 ? candidates[0].fullPath : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function configuredFromEnv(env) {
  return Boolean(env.PHASE_S_WORKER_UPSTREAM_URL || env.WORKER_ORCHESTRATOR_UPSTREAM_URL);
}

function buildOrchestratorEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (env.PHASE_S_FORCE_REMASK === "1") {
    env.WORKER_ORCHESTRATOR_FORCE_REMASK = "1";
  }

  if (env.PHASE_S_WORKER_UPSTREAM_URL && !env.WORKER_ORCHESTRATOR_UPSTREAM_URL) {
    env.WORKER_ORCHESTRATOR_UPSTREAM_URL = env.PHASE_S_WORKER_UPSTREAM_URL;
  }

  if (env.PHASE_S_WORKER_MODEL_ID && !env.WORKER_ORCHESTRATOR_MODEL_ID) {
    env.WORKER_ORCHESTRATOR_MODEL_ID = env.PHASE_S_WORKER_MODEL_ID;
  }

  if (env.PHASE_S_WORKER_TIMEOUT_MS && !env.WORKER_ORCHESTRATOR_TIMEOUT_MS) {
    env.WORKER_ORCHESTRATOR_TIMEOUT_MS = env.PHASE_S_WORKER_TIMEOUT_MS;
  }

  return env;
}

function runNpmScript(command, args, env = process.env) {
  const result = spawnSync(npmCommand(), args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });

  return {
    command,
    exitCode: result.status === null ? 1 : result.status,
    stderr: result.stderr || "",
    stdout: result.stdout || ""
  };
}

function summarizeRepairDraftFixtures(childResult, reportPath, report) {
  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    ok: Boolean(report && report.ok),
    total: report && typeof report.total === "number" ? report.total : 0,
    passed: report && typeof report.passed === "number" ? report.passed : 0,
    failed: report && typeof report.failed === "number" ? report.failed : 0,
    approveCases: report && typeof report.approveCases === "number" ? report.approveCases : 0,
    needsReviewCases:
      report && typeof report.needsReviewCases === "number" ? report.needsReviewCases : 0,
    rejectCases: report && typeof report.rejectCases === "number" ? report.rejectCases : 0,
    allExpectedDecisionsObserved: Boolean(report && report.allExpectedDecisionsObserved)
  };
}

function summarizeOrchestrator(childResult, reportPath, report) {
  const plannerValidation = report && report.planner && report.planner.validation
    ? report.planner.validation
    : {};
  const coderValidation = report && report.coder && report.coder.validation
    ? report.coder.validation
    : {};
  const verifier = report && report.verifier ? report.verifier : {};
  const remask = report && report.remask ? report.remask : {};
  const repairVerifier = report && report.repairVerifier ? report.repairVerifier : {};
  const patchDryRun = report && report.patchDryRun ? report.patchDryRun : {};
  const tempWorkspaceApply = report && report.tempWorkspaceApply
    ? report.tempWorkspaceApply
    : {};
  const tempWorkspaceExecution = report && report.tempWorkspaceExecution
    ? report.tempWorkspaceExecution
    : {};
  const orchestratorDecision =
    report && report.orchestratorDecision ? report.orchestratorDecision : {};

  const summary = {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    status: report ? report.status || "missing_report" : "missing_report",
    ok: Boolean(report && report.ok),
    configured: Boolean(report && report.configured),
    forceRemask: Boolean(report && report.forceRemask),
    finalDecision: report ? report.finalDecision || null : null,
    plannerValidationOk: Boolean(plannerValidation.ok),
    coderValidationOk: Boolean(coderValidation.ok),
    verifierCalled: Boolean(verifier.called),
    verifierDecision: verifier.decision ?? null,
    verifierIssueCount: typeof verifier.issueCount === "number" ? verifier.issueCount : null,
    remaskRequested:
      typeof remask.requested === "boolean"
        ? remask.requested
        : Boolean(orchestratorDecision.remaskRequested),
    remaskRepairability:
      remask.repairability === undefined
        ? orchestratorDecision.remaskRepairability ?? null
        : remask.repairability,
    remaskValidationOk:
      remask.validation === undefined || remask.validation === null
        ? orchestratorDecision.remaskValidationOk ?? null
        : Boolean(remask.validation.ok),
    repairDraftChecksOk:
      remask.repairDraftChecks === undefined || remask.repairDraftChecks === null
        ? orchestratorDecision.repairDraftChecksOk ?? null
        : Boolean(remask.repairDraftChecks.ok),
    repairVerifierCalled:
      typeof repairVerifier.called === "boolean"
        ? repairVerifier.called
        : Boolean(orchestratorDecision.repairVerifierCalled),
    repairVerifierDecision:
      repairVerifier.decision === undefined
        ? orchestratorDecision.repairVerifierDecision ?? null
        : repairVerifier.decision,
    repairVerifierIssueCount:
      typeof repairVerifier.issueCount === "number"
        ? repairVerifier.issueCount
        : orchestratorDecision.repairVerifierIssueCount ?? null,
    patchDryRunCalled:
      typeof patchDryRun.called === "boolean"
        ? patchDryRun.called
        : orchestratorDecision.patchDryRunCalled ?? null,
    patchDryRunDecision:
      patchDryRun.decision === undefined
        ? orchestratorDecision.patchDryRunDecision ?? null
        : patchDryRun.decision,
    patchDryRunIssueCount:
      typeof patchDryRun.issueCount === "number"
        ? patchDryRun.issueCount
        : orchestratorDecision.patchDryRunIssueCount ?? null,
    patchDryRunChangedFiles:
      patchDryRun.summary && typeof patchDryRun.summary.changedFiles === "number"
        ? patchDryRun.summary.changedFiles
        : orchestratorDecision.patchDryRunChangedFiles ?? null
  };

  const hasTempWorkspaceApplyFields =
    Object.prototype.hasOwnProperty.call(report || {}, "tempWorkspaceApply") ||
    Object.prototype.hasOwnProperty.call(orchestratorDecision, "tempWorkspaceApplyCalled") ||
    Object.prototype.hasOwnProperty.call(orchestratorDecision, "tempWorkspaceApplyDecision");
  if (hasTempWorkspaceApplyFields) {
    summary.tempWorkspaceApplyCalled =
      typeof tempWorkspaceApply.called === "boolean"
        ? tempWorkspaceApply.called
        : Boolean(orchestratorDecision.tempWorkspaceApplyCalled);
    summary.tempWorkspaceApplyDecision =
      tempWorkspaceApply.decision === undefined
        ? orchestratorDecision.tempWorkspaceApplyDecision ?? null
        : tempWorkspaceApply.decision;
    summary.tempWorkspaceApplyIssueCount =
      typeof tempWorkspaceApply.issueCount === "number"
        ? tempWorkspaceApply.issueCount
        : orchestratorDecision.tempWorkspaceApplyIssueCount ?? null;
    summary.tempWorkspaceApplyChangedFiles =
      typeof tempWorkspaceApply.changedFiles === "number"
        ? tempWorkspaceApply.changedFiles
        : orchestratorDecision.tempWorkspaceApplyChangedFiles ?? null;
    summary.tempWorkspaceApplyCleanedUp =
      typeof tempWorkspaceApply.cleanedUp === "boolean"
        ? tempWorkspaceApply.cleanedUp
        : orchestratorDecision.tempWorkspaceApplyCleanedUp ?? null;
  }
  const hasTempWorkspaceExecutionFields =
    Object.prototype.hasOwnProperty.call(report || {}, "tempWorkspaceExecution") ||
    Object.prototype.hasOwnProperty.call(
      orchestratorDecision,
      "tempWorkspaceExecutionCalled"
    ) ||
    Object.prototype.hasOwnProperty.call(
      orchestratorDecision,
      "tempWorkspaceExecutionDecision"
    );
  if (hasTempWorkspaceExecutionFields) {
    summary.tempWorkspaceExecutionCalled =
      typeof tempWorkspaceExecution.called === "boolean"
        ? tempWorkspaceExecution.called
        : Boolean(orchestratorDecision.tempWorkspaceExecutionCalled);
    summary.tempWorkspaceExecutionDecision =
      tempWorkspaceExecution.decision === undefined
        ? orchestratorDecision.tempWorkspaceExecutionDecision ?? null
        : tempWorkspaceExecution.decision;
    summary.tempWorkspaceExecutionIssueCount =
      typeof tempWorkspaceExecution.issueCount === "number"
        ? tempWorkspaceExecution.issueCount
        : orchestratorDecision.tempWorkspaceExecutionIssueCount ?? null;
    summary.tempWorkspaceExecutionPassedCommands =
      typeof tempWorkspaceExecution.passedCommands === "number"
        ? tempWorkspaceExecution.passedCommands
        : orchestratorDecision.tempWorkspaceExecutionPassedCommands ?? null;
    summary.tempWorkspaceExecutionFailedCommands =
      typeof tempWorkspaceExecution.failedCommands === "number"
        ? tempWorkspaceExecution.failedCommands
        : orchestratorDecision.tempWorkspaceExecutionFailedCommands ?? null;
    summary.tempWorkspaceExecutionCleanupPerformed =
      typeof tempWorkspaceExecution.cleanupPerformed === "boolean"
        ? tempWorkspaceExecution.cleanupPerformed
        : Boolean(orchestratorDecision.tempWorkspaceExecutionCleanupPerformed);
  }
  return summary;
}

function buildSummary(children, configured, forceRemask = false) {
  const repairDraftVerifierGatePassed = children.repairDraftVerifierGate.exitCode === 0;
  const repairDraftFixtureSuitePassed =
    children.repairDraftVerifierFixtures.exitCode === 0 &&
    children.repairDraftVerifierFixtures.ok;
  const repairDraftFixtureAllExpectedDecisionsObserved =
    Boolean(children.repairDraftVerifierFixtures.allExpectedDecisionsObserved);
  const orchestratorCommandExitedZero = children.orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(children.orchestrator.configured);
  const plannerValidationPassed = Boolean(children.orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(children.orchestrator.coderValidationOk);
  const verifierCalled = Boolean(children.orchestrator.verifierCalled);
  const remaskRequested = Boolean(children.orchestrator.remaskRequested);
  const remaskValidationPassed = Boolean(children.orchestrator.remaskValidationOk);
  const repairDraftChecksPassed = Boolean(children.orchestrator.repairDraftChecksOk);
  const repairVerifierCalled = Boolean(children.orchestrator.repairVerifierCalled);
  const repairVerifierApproved = children.orchestrator.repairVerifierDecision === "approve";
  const repairVerifierNeedsReview =
    children.orchestrator.repairVerifierDecision === "needs_review";
  const repairVerifierRejected = children.orchestrator.repairVerifierDecision === "reject";
  const finalRepairDecisionObserved = forcedRepairFinalDecisions.has(
    children.orchestrator.finalDecision
  );
  const finalPatchDryRunDecisionObserved = forcedPatchDryRunFinalDecisions.has(
    children.orchestrator.finalDecision
  );
  const finalRepairOrPatchDecisionObserved =
    finalRepairDecisionObserved || finalPatchDryRunDecisionObserved;
  const patchDryRunFieldsPresent =
    Object.prototype.hasOwnProperty.call(children.orchestrator, "patchDryRunCalled") ||
    Object.prototype.hasOwnProperty.call(children.orchestrator, "patchDryRunDecision") ||
    Object.prototype.hasOwnProperty.call(children.orchestrator, "patchDryRunIssueCount") ||
    Object.prototype.hasOwnProperty.call(children.orchestrator, "patchDryRunChangedFiles");
  const patchDryRunCalled = Boolean(children.orchestrator.patchDryRunCalled);
  const patchDryRunDecisionObserved = patchDryRunDecisions.has(
    children.orchestrator.patchDryRunDecision
  );
  const patchDryRunReady =
    !patchDryRunFieldsPresent ||
    !repairVerifierApproved ||
    (patchDryRunCalled && patchDryRunDecisionObserved);
  const tempWorkspaceApplyFieldsPresent =
    Object.prototype.hasOwnProperty.call(children.orchestrator, "tempWorkspaceApplyCalled") ||
    Object.prototype.hasOwnProperty.call(children.orchestrator, "tempWorkspaceApplyDecision");
  const tempWorkspaceApplyFinalDecisionObserved = [
    "temp_apply_ready",
    "temp_apply_needs_review",
    "temp_apply_rejected"
  ].includes(children.orchestrator.finalDecision);
  const tempWorkspaceApplyReady =
    !tempWorkspaceApplyFieldsPresent ||
    !tempWorkspaceApplyFinalDecisionObserved ||
    (children.orchestrator.tempWorkspaceApplyCalled === true &&
      children.orchestrator.tempWorkspaceApplyDecision === children.orchestrator.finalDecision);
  const tempWorkspaceExecutionFieldsPresent =
    Object.prototype.hasOwnProperty.call(
      children.orchestrator,
      "tempWorkspaceExecutionCalled"
    ) ||
    Object.prototype.hasOwnProperty.call(
      children.orchestrator,
      "tempWorkspaceExecutionDecision"
    );
  const tempWorkspaceExecutionFinalDecisionObserved = [
    "temp_validation_passed",
    "temp_validation_failed",
    "temp_validation_needs_review"
  ].includes(children.orchestrator.finalDecision);
  const tempWorkspaceExecutionReady =
    !tempWorkspaceExecutionFieldsPresent ||
    !tempWorkspaceExecutionFinalDecisionObserved ||
    (children.orchestrator.tempWorkspaceExecutionCalled === true &&
      children.orchestrator.tempWorkspaceExecutionDecision ===
        children.orchestrator.finalDecision &&
      children.orchestrator.tempWorkspaceExecutionCleanupPerformed === true);
  const anySkipped = children.orchestrator.status === "skipped";
  const baseReady =
    configured &&
    repairDraftVerifierGatePassed &&
    repairDraftFixtureSuitePassed &&
    repairDraftFixtureAllExpectedDecisionsObserved &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    repairAwareFinalDecisions.has(children.orchestrator.finalDecision) &&
    patchDryRunReady &&
    tempWorkspaceApplyReady &&
    tempWorkspaceExecutionReady &&
    !anySkipped;
  const forcedReady =
    baseReady &&
    remaskRequested &&
    remaskValidationPassed &&
    repairDraftChecksPassed &&
    repairVerifierCalled &&
    repairVerifierDecisions.has(children.orchestrator.repairVerifierDecision) &&
    finalRepairOrPatchDecisionObserved &&
    patchDryRunReady;

  return {
    repairDraftVerifierGatePassed,
    repairDraftFixtureSuitePassed,
    repairDraftFixtureAllExpectedDecisionsObserved,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    remaskRequested,
    remaskValidationPassed,
    repairDraftChecksPassed,
    repairVerifierCalled,
    repairVerifierApproved,
    repairVerifierNeedsReview,
    repairVerifierRejected,
    finalRepairDecisionObserved,
    finalPatchDryRunDecisionObserved,
    finalRepairOrPatchDecisionObserved,
    tempWorkspaceApplyFieldsPresent,
    tempWorkspaceApplyFinalDecisionObserved,
    tempWorkspaceApplyReady,
    tempWorkspaceApplyCalled: children.orchestrator.tempWorkspaceApplyCalled ?? null,
    tempWorkspaceApplyDecision: children.orchestrator.tempWorkspaceApplyDecision ?? null,
    tempWorkspaceApplyIssueCount: children.orchestrator.tempWorkspaceApplyIssueCount ?? null,
    tempWorkspaceApplyChangedFiles: children.orchestrator.tempWorkspaceApplyChangedFiles ?? null,
    tempWorkspaceApplyCleanedUp: children.orchestrator.tempWorkspaceApplyCleanedUp ?? null,
    tempWorkspaceExecutionFieldsPresent,
    tempWorkspaceExecutionFinalDecisionObserved,
    tempWorkspaceExecutionReady,
    tempWorkspaceExecutionCalled:
      children.orchestrator.tempWorkspaceExecutionCalled ?? null,
    tempWorkspaceExecutionDecision:
      children.orchestrator.tempWorkspaceExecutionDecision ?? null,
    tempWorkspaceExecutionIssueCount:
      children.orchestrator.tempWorkspaceExecutionIssueCount ?? null,
    tempWorkspaceExecutionPassedCommands:
      children.orchestrator.tempWorkspaceExecutionPassedCommands ?? null,
    tempWorkspaceExecutionFailedCommands:
      children.orchestrator.tempWorkspaceExecutionFailedCommands ?? null,
    tempWorkspaceExecutionCleanupPerformed:
      children.orchestrator.tempWorkspaceExecutionCleanupPerformed ?? null,
    patchDryRunFieldsPresent,
    patchDryRunCalled,
    patchDryRunDecisionObserved,
    patchDryRunDecision: children.orchestrator.patchDryRunDecision ?? null,
    patchDryRunIssueCount: children.orchestrator.patchDryRunIssueCount ?? null,
    patchDryRunChangedFiles: children.orchestrator.patchDryRunChangedFiles ?? null,
    anySkipped,
    readyForRunPodLiveValidation: forceRemask ? forcedReady : baseReady
  };
}

function determineStatus(children, required) {
  if (
    children.repairDraftVerifierGate.exitCode !== 0 ||
    children.repairDraftVerifierFixtures.exitCode !== 0 ||
    !children.repairDraftVerifierFixtures.ok ||
    children.orchestrator.exitCode !== 0
  ) {
    return "failed";
  }

  if (children.orchestrator.status === "skipped" && required) {
    return "failed";
  }

  if (children.orchestrator.status === "skipped") {
    return "skipped";
  }

  if (children.orchestrator.status === "completed") {
    return "completed";
  }

  return "failed";
}

function renderMarkdown(report) {
  return [
    "# Phase S Repair Verification Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Force remask mode: ${report.forceRemask}`,
    `- RepairDraft verifier gate passed: ${report.summary.repairDraftVerifierGatePassed}`,
    `- RepairDraft fixture suite passed: ${report.summary.repairDraftFixtureSuitePassed}`,
    `- Fixture approve cases: ${report.children.repairDraftVerifierFixtures.approveCases}`,
    `- Fixture needs_review cases: ${report.children.repairDraftVerifierFixtures.needsReviewCases}`,
    `- Fixture reject cases: ${report.children.repairDraftVerifierFixtures.rejectCases}`,
    `- Fixture expected decisions observed: ${report.children.repairDraftVerifierFixtures.allExpectedDecisionsObserved}`,
    `- Orchestrator status: ${report.children.orchestrator.status}`,
    `- Orchestrator final decision: ${report.children.orchestrator.finalDecision || ""}`,
    `- Initial verifier decision: ${report.children.orchestrator.verifierDecision || ""}`,
    `- Remask requested: ${report.children.orchestrator.remaskRequested}`,
    `- Remask validation OK: ${report.children.orchestrator.remaskValidationOk ?? ""}`,
    `- RepairDraft checks OK: ${report.children.orchestrator.repairDraftChecksOk ?? ""}`,
    `- Repair verifier called: ${report.children.orchestrator.repairVerifierCalled}`,
    `- Repair verifier decision: ${report.children.orchestrator.repairVerifierDecision || ""}`,
    `- Repair verifier issue count: ${report.children.orchestrator.repairVerifierIssueCount ?? ""}`,
    `- Patch dry run called: ${report.children.orchestrator.patchDryRunCalled ?? ""}`,
    `- Patch dry run decision: ${report.children.orchestrator.patchDryRunDecision || ""}`,
    `- Patch dry run issue count: ${report.children.orchestrator.patchDryRunIssueCount ?? ""}`,
    `- Patch dry run changed files: ${report.children.orchestrator.patchDryRunChangedFiles ?? ""}`,
    `- Temporary workspace apply called: ${report.children.orchestrator.tempWorkspaceApplyCalled ?? ""}`,
    `- Temporary workspace apply decision: ${report.children.orchestrator.tempWorkspaceApplyDecision ?? ""}`,
    `- Temporary workspace apply issue count: ${report.children.orchestrator.tempWorkspaceApplyIssueCount ?? ""}`,
    `- Temporary workspace apply changed files: ${report.children.orchestrator.tempWorkspaceApplyChangedFiles ?? ""}`,
    `- Temporary workspace apply cleaned up: ${report.children.orchestrator.tempWorkspaceApplyCleanedUp ?? ""}`,
    `- Temporary workspace execution called: ${report.children.orchestrator.tempWorkspaceExecutionCalled ?? ""}`,
    `- Temporary workspace execution decision: ${report.children.orchestrator.tempWorkspaceExecutionDecision ?? ""}`,
    `- Temporary workspace execution issue count: ${report.children.orchestrator.tempWorkspaceExecutionIssueCount ?? ""}`,
    `- Temporary workspace execution passed commands: ${report.children.orchestrator.tempWorkspaceExecutionPassedCommands ?? ""}`,
    `- Temporary workspace execution failed commands: ${report.children.orchestrator.tempWorkspaceExecutionFailedCommands ?? ""}`,
    `- Temporary workspace execution cleanup performed: ${report.children.orchestrator.tempWorkspaceExecutionCleanupPerformed ?? ""}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Child Reports",
    "",
    `- RepairDraft verifier gate: command=${report.children.repairDraftVerifierGate.command}, exitCode=${report.children.repairDraftVerifierGate.exitCode}`,
    `- RepairDraft verifier fixtures: command=${report.children.repairDraftVerifierFixtures.command}, exitCode=${report.children.repairDraftVerifierFixtures.exitCode}, report=${report.children.repairDraftVerifierFixtures.reportPath || ""}`,
    `- Orchestrator: command=${report.children.orchestrator.command}, exitCode=${report.children.orchestrator.exitCode}, report=${report.children.orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-phase-s-repair-verification-suite-report.json`);
  const markdownPath = path.join(outDir, `${timestamp}-phase-s-repair-verification-suite-report.md`);
  const reportWithPaths = {
    ...report,
    jsonPath,
    markdownPath
  };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths));

  return reportWithPaths;
}

function run() {
  const startedAt = new Date();
  const required = process.env.PHASE_S_REPAIR_SUITE_REQUIRED === "1";
  const forceRemask = process.env.PHASE_S_FORCE_REMASK === "1";
  const configured = configuredFromEnv(process.env);
  const repairDraftVerifierGate = runNpmScript(
    "npm run test:repair-draft-verifier-gate",
    ["run", "test:repair-draft-verifier-gate"]
  );
  const repairDraftVerifierFixtures = runNpmScript(
    "npm run report:repair-draft-verifier-negative-fixture-suite",
    ["run", "report:repair-draft-verifier-negative-fixture-suite"]
  );
  const orchestratorEnv = buildOrchestratorEnv(process.env, required);
  const orchestratorResult = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    orchestratorEnv
  );
  const repairDraftFixtureReportPath = latestJsonReport(
    path.resolve(process.cwd(), REPAIR_DRAFT_FIXTURE_REPORT_DIR)
  );
  const repairDraftFixtureReport = repairDraftFixtureReportPath
    ? readJson(repairDraftFixtureReportPath)
    : null;
  const orchestratorReportPath = latestJsonReport(path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR));
  const orchestratorReport = orchestratorReportPath ? readJson(orchestratorReportPath) : null;
  const children = {
    repairDraftVerifierGate: {
      command: repairDraftVerifierGate.command,
      exitCode: repairDraftVerifierGate.exitCode,
      ok: repairDraftVerifierGate.exitCode === 0
    },
    repairDraftVerifierFixtures: summarizeRepairDraftFixtures(
      repairDraftVerifierFixtures,
      repairDraftFixtureReportPath,
      repairDraftFixtureReport
    ),
    orchestrator: summarizeOrchestrator(
      orchestratorResult,
      orchestratorReportPath,
      orchestratorReport
    )
  };
  const summary = buildSummary(children, configured, forceRemask);
  const status = determineStatus(children, required);
  const finishedAt = new Date();
  const ok =
    children.repairDraftVerifierGate.exitCode === 0 &&
    children.repairDraftVerifierFixtures.exitCode === 0 &&
    children.repairDraftVerifierFixtures.ok &&
    children.orchestrator.exitCode === 0 &&
    !(required && summary.anySkipped);

  return writeReport({
    ok,
    status,
    suiteName: SUITE_NAME,
    required,
    forceRemask,
    configured,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    children,
    summary,
    jsonPath: "",
    markdownPath: ""
  });
}

if (require.main === module) {
  try {
    const report = run();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  SUITE_NAME,
  buildOrchestratorEnv,
  buildSummary,
  determineStatus,
  run,
  summarizeOrchestrator,
  summarizeRepairDraftFixtures
};
