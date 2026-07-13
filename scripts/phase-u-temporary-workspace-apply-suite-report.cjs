const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-u-temporary-workspace-apply-suite-report";
const TEMP_APPLY_FIXTURE_REPORT_DIR = path.join(
  "reports",
  "temporary-workspace-apply-fixture-suite"
);
const ORCHESTRATOR_REPORT_DIR = path.join("reports", "worker-backed-orchestrator-smoke");
const SUITE_REPORT_DIR = path.join("reports", "phase-u-temporary-workspace-apply-suite");

const acceptedFinalDecisions = new Set([
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

const tempApplyFinalDecisions = new Set([
  "temp_apply_ready",
  "temp_apply_needs_review",
  "temp_apply_rejected"
]);

const tempValidationFinalDecisions = new Set([
  "temp_validation_passed",
  "temp_validation_failed",
  "temp_validation_needs_review"
]);

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
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length > 0 ? candidates[0].fullPath : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function configuredFromEnv(env) {
  return Boolean(env.PHASE_U_WORKER_UPSTREAM_URL || env.WORKER_ORCHESTRATOR_UPSTREAM_URL);
}

function hasOwnEnv(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name);
}

function buildOrchestratorEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (
    env.PHASE_U_FORCE_REMASK === "1" &&
    !hasOwnEnv(env, "WORKER_ORCHESTRATOR_FORCE_REMASK")
  ) {
    env.WORKER_ORCHESTRATOR_FORCE_REMASK = "1";
  }

  if (
    env.PHASE_U_WORKER_UPSTREAM_URL &&
    !hasOwnEnv(env, "WORKER_ORCHESTRATOR_UPSTREAM_URL")
  ) {
    env.WORKER_ORCHESTRATOR_UPSTREAM_URL = env.PHASE_U_WORKER_UPSTREAM_URL;
  }

  if (
    env.PHASE_U_WORKER_MODEL_ID &&
    !hasOwnEnv(env, "WORKER_ORCHESTRATOR_MODEL_ID")
  ) {
    env.WORKER_ORCHESTRATOR_MODEL_ID = env.PHASE_U_WORKER_MODEL_ID;
  }

  if (
    env.PHASE_U_WORKER_TIMEOUT_MS &&
    !hasOwnEnv(env, "WORKER_ORCHESTRATOR_TIMEOUT_MS")
  ) {
    env.WORKER_ORCHESTRATOR_TIMEOUT_MS = env.PHASE_U_WORKER_TIMEOUT_MS;
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

function summarizeFixtures(childResult, reportPath, report) {
  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    ok: Boolean(report && report.ok),
    total: report && typeof report.total === "number" ? report.total : 0,
    passed: report && typeof report.passed === "number" ? report.passed : 0,
    failed: report && typeof report.failed === "number" ? report.failed : 0,
    tempApplyReadyCases:
      report && typeof report.tempApplyReadyCases === "number" ? report.tempApplyReadyCases : 0,
    tempApplyNeedsReviewCases:
      report && typeof report.tempApplyNeedsReviewCases === "number"
        ? report.tempApplyNeedsReviewCases
        : 0,
    tempApplyRejectedCases:
      report && typeof report.tempApplyRejectedCases === "number"
        ? report.tempApplyRejectedCases
        : 0,
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
  const decision = report && report.orchestratorDecision ? report.orchestratorDecision : {};

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
    remaskRequested:
      typeof remask.requested === "boolean" ? remask.requested : Boolean(decision.remaskRequested),
    repairVerifierCalled:
      typeof repairVerifier.called === "boolean"
        ? repairVerifier.called
        : Boolean(decision.repairVerifierCalled),
    repairVerifierDecision:
      repairVerifier.decision === undefined
        ? decision.repairVerifierDecision ?? null
        : repairVerifier.decision,
    patchDryRunCalled:
      typeof patchDryRun.called === "boolean"
        ? patchDryRun.called
        : Boolean(decision.patchDryRunCalled),
    patchDryRunDecision:
      patchDryRun.decision === undefined
        ? decision.patchDryRunDecision ?? null
        : patchDryRun.decision,
    tempWorkspaceApplyCalled:
      typeof tempWorkspaceApply.called === "boolean"
        ? tempWorkspaceApply.called
        : Boolean(decision.tempWorkspaceApplyCalled),
    tempWorkspaceApplyDecision:
      tempWorkspaceApply.decision === undefined
        ? decision.tempWorkspaceApplyDecision ?? null
        : tempWorkspaceApply.decision,
    tempWorkspaceApplyIssueCount:
      typeof tempWorkspaceApply.issueCount === "number"
        ? tempWorkspaceApply.issueCount
        : decision.tempWorkspaceApplyIssueCount ?? null,
    tempWorkspaceApplyChangedFiles:
      typeof tempWorkspaceApply.changedFiles === "number"
        ? tempWorkspaceApply.changedFiles
        : decision.tempWorkspaceApplyChangedFiles ?? null,
    tempWorkspaceApplyCleanedUp:
      typeof tempWorkspaceApply.cleanedUp === "boolean"
        ? tempWorkspaceApply.cleanedUp
        : decision.tempWorkspaceApplyCleanedUp ?? null
  };
  const hasTempWorkspaceExecutionFields =
    Object.prototype.hasOwnProperty.call(report || {}, "tempWorkspaceExecution") ||
    Object.prototype.hasOwnProperty.call(decision, "tempWorkspaceExecutionCalled") ||
    Object.prototype.hasOwnProperty.call(decision, "tempWorkspaceExecutionDecision");

  if (hasTempWorkspaceExecutionFields) {
    summary.tempWorkspaceExecutionCalled =
      typeof tempWorkspaceExecution.called === "boolean"
        ? tempWorkspaceExecution.called
        : Boolean(decision.tempWorkspaceExecutionCalled);
    summary.tempWorkspaceExecutionDecision =
      tempWorkspaceExecution.decision === undefined
        ? decision.tempWorkspaceExecutionDecision ?? null
        : tempWorkspaceExecution.decision;
    summary.tempWorkspaceExecutionIssueCount =
      typeof tempWorkspaceExecution.issueCount === "number"
        ? tempWorkspaceExecution.issueCount
        : decision.tempWorkspaceExecutionIssueCount ?? null;
    summary.tempWorkspaceExecutionPassedCommands =
      typeof tempWorkspaceExecution.passedCommands === "number"
        ? tempWorkspaceExecution.passedCommands
        : decision.tempWorkspaceExecutionPassedCommands ?? null;
    summary.tempWorkspaceExecutionFailedCommands =
      typeof tempWorkspaceExecution.failedCommands === "number"
        ? tempWorkspaceExecution.failedCommands
        : decision.tempWorkspaceExecutionFailedCommands ?? null;
    summary.tempWorkspaceExecutionCleanupPerformed =
      typeof tempWorkspaceExecution.cleanupPerformed === "boolean"
        ? tempWorkspaceExecution.cleanupPerformed
        : Boolean(decision.tempWorkspaceExecutionCleanupPerformed);
  }

  return summary;
}

function buildSummary(children, configured, forceRemask = false) {
  const orchestrator = children.orchestrator;
  const tempWorkspaceApplyGatePassed = children.tempWorkspaceApplyGate.exitCode === 0;
  const tempWorkspaceApplyFixtureSuitePassed =
    children.tempWorkspaceApplyFixtures.exitCode === 0 &&
    children.tempWorkspaceApplyFixtures.ok;
  const tempWorkspaceApplyFixtureAllExpectedDecisionsObserved =
    Boolean(children.tempWorkspaceApplyFixtures.allExpectedDecisionsObserved);
  const orchestratorCommandExitedZero = orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(orchestrator.configured);
  const plannerValidationPassed = Boolean(orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(orchestrator.coderValidationOk);
  const verifierCalled = Boolean(orchestrator.verifierCalled);
  const remaskRequested = Boolean(orchestrator.remaskRequested);
  const repairVerifierCalled = Boolean(orchestrator.repairVerifierCalled);
  const patchDryRunCalled = Boolean(orchestrator.patchDryRunCalled);
  const tempWorkspaceApplyCalled = Boolean(orchestrator.tempWorkspaceApplyCalled);
  const tempWorkspaceApplyReady =
    tempWorkspaceApplyCalled && orchestrator.tempWorkspaceApplyDecision === "temp_apply_ready";
  const tempWorkspaceApplyNeedsReview =
    tempWorkspaceApplyCalled &&
    orchestrator.tempWorkspaceApplyDecision === "temp_apply_needs_review";
  const tempWorkspaceApplyRejected =
    tempWorkspaceApplyCalled && orchestrator.tempWorkspaceApplyDecision === "temp_apply_rejected";
  const finalTempApplyDecisionObserved = tempApplyFinalDecisions.has(orchestrator.finalDecision);
  const tempWorkspaceExecutionFieldsPresent =
    Object.prototype.hasOwnProperty.call(orchestrator, "tempWorkspaceExecutionCalled") ||
    Object.prototype.hasOwnProperty.call(orchestrator, "tempWorkspaceExecutionDecision");
  const tempWorkspaceExecutionExpected =
    tempWorkspaceExecutionFieldsPresent && tempWorkspaceApplyReady;
  const tempWorkspaceExecutionReady =
    !tempWorkspaceExecutionExpected ||
    (orchestrator.tempWorkspaceExecutionCalled === true &&
      tempValidationFinalDecisions.has(orchestrator.tempWorkspaceExecutionDecision) &&
      orchestrator.tempWorkspaceExecutionCleanupPerformed === true);
  const finalPostApplyDecisionObserved =
    finalTempApplyDecisionObserved ||
    tempValidationFinalDecisions.has(orchestrator.finalDecision);
  const anySkipped = orchestrator.status === "skipped";
  const baseReady =
    configured &&
    tempWorkspaceApplyGatePassed &&
    tempWorkspaceApplyFixtureSuitePassed &&
    tempWorkspaceApplyFixtureAllExpectedDecisionsObserved &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    acceptedFinalDecisions.has(orchestrator.finalDecision) &&
    !anySkipped;
  const forcedReady =
    baseReady &&
    remaskRequested &&
    repairVerifierCalled &&
    patchDryRunCalled &&
    orchestrator.patchDryRunDecision === "ready_to_apply" &&
    tempWorkspaceApplyCalled &&
    tempApplyFinalDecisions.has(orchestrator.tempWorkspaceApplyDecision) &&
    finalPostApplyDecisionObserved &&
    tempWorkspaceExecutionReady;

  return {
    tempWorkspaceApplyGatePassed,
    tempWorkspaceApplyFixtureSuitePassed,
    tempWorkspaceApplyFixtureAllExpectedDecisionsObserved,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    remaskRequested,
    repairVerifierCalled,
    patchDryRunCalled,
    tempWorkspaceApplyCalled,
    tempWorkspaceApplyReady,
    tempWorkspaceApplyNeedsReview,
    tempWorkspaceApplyRejected,
    finalTempApplyDecisionObserved,
    finalPostApplyDecisionObserved,
    tempWorkspaceExecutionFieldsPresent,
    tempWorkspaceExecutionExpected,
    tempWorkspaceExecutionReady,
    tempWorkspaceExecutionCalled: orchestrator.tempWorkspaceExecutionCalled ?? null,
    tempWorkspaceExecutionDecision: orchestrator.tempWorkspaceExecutionDecision ?? null,
    tempWorkspaceExecutionIssueCount: orchestrator.tempWorkspaceExecutionIssueCount ?? null,
    tempWorkspaceExecutionPassedCommands:
      orchestrator.tempWorkspaceExecutionPassedCommands ?? null,
    tempWorkspaceExecutionFailedCommands:
      orchestrator.tempWorkspaceExecutionFailedCommands ?? null,
    tempWorkspaceExecutionCleanupPerformed:
      orchestrator.tempWorkspaceExecutionCleanupPerformed ?? null,
    anySkipped,
    readyForRunPodLiveValidation: forceRemask ? forcedReady : baseReady
  };
}

function determineStatus(children, required) {
  if (
    children.tempWorkspaceApplyGate.exitCode !== 0 ||
    children.tempWorkspaceApplyFixtures.exitCode !== 0 ||
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

  return children.orchestrator.status === "completed" ? "completed" : "failed";
}

function renderMarkdown(report) {
  return [
    "# Phase U Temporary Workspace Apply Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Force remask mode: ${report.forceRemask}`,
    `- Temporary workspace apply gate passed: ${report.summary.tempWorkspaceApplyGatePassed}`,
    `- Fixture suite passed: ${report.summary.tempWorkspaceApplyFixtureSuitePassed}`,
    `- Fixture temp_apply_ready cases: ${report.children.tempWorkspaceApplyFixtures.tempApplyReadyCases}`,
    `- Fixture temp_apply_needs_review cases: ${report.children.tempWorkspaceApplyFixtures.tempApplyNeedsReviewCases}`,
    `- Fixture temp_apply_rejected cases: ${report.children.tempWorkspaceApplyFixtures.tempApplyRejectedCases}`,
    `- Fixture expected decisions observed: ${report.children.tempWorkspaceApplyFixtures.allExpectedDecisionsObserved}`,
    `- Orchestrator status: ${report.children.orchestrator.status}`,
    `- Orchestrator final decision: ${report.children.orchestrator.finalDecision || ""}`,
    `- Verifier called: ${report.children.orchestrator.verifierCalled}`,
    `- Verifier decision: ${report.children.orchestrator.verifierDecision || ""}`,
    `- Remask requested: ${report.children.orchestrator.remaskRequested}`,
    `- Repair verifier called: ${report.children.orchestrator.repairVerifierCalled}`,
    `- Repair verifier decision: ${report.children.orchestrator.repairVerifierDecision || ""}`,
    `- Patch dry-run called: ${report.children.orchestrator.patchDryRunCalled}`,
    `- Patch dry-run decision: ${report.children.orchestrator.patchDryRunDecision || ""}`,
    `- Temporary workspace apply called: ${report.children.orchestrator.tempWorkspaceApplyCalled}`,
    `- Temporary workspace apply decision: ${report.children.orchestrator.tempWorkspaceApplyDecision || ""}`,
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
    `- Temporary workspace apply gate: command=${report.children.tempWorkspaceApplyGate.command}, exitCode=${report.children.tempWorkspaceApplyGate.exitCode}`,
    `- Temporary workspace apply fixtures: command=${report.children.tempWorkspaceApplyFixtures.command}, exitCode=${report.children.tempWorkspaceApplyFixtures.exitCode}, report=${report.children.tempWorkspaceApplyFixtures.reportPath || ""}`,
    `- Orchestrator: command=${report.children.orchestrator.command}, exitCode=${report.children.orchestrator.exitCode}, report=${report.children.orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    outDir,
    `${timestamp}-phase-u-temporary-workspace-apply-suite-report.json`
  );
  const markdownPath = path.join(
    outDir,
    `${timestamp}-phase-u-temporary-workspace-apply-suite-report.md`
  );
  const reportWithPaths = { ...report, jsonPath, markdownPath };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths));
  return reportWithPaths;
}

function run() {
  const startedAt = new Date();
  const required = process.env.PHASE_U_TEMP_APPLY_SUITE_REQUIRED === "1";
  const forceRemask = process.env.PHASE_U_FORCE_REMASK === "1";
  const configured = configuredFromEnv(process.env);
  const tempWorkspaceApplyGate = runNpmScript(
    "npm run test:temporary-workspace-apply-gate",
    ["run", "test:temporary-workspace-apply-gate"]
  );
  const tempWorkspaceApplyFixtures = runNpmScript(
    "npm run report:temporary-workspace-apply-fixture-suite",
    ["run", "report:temporary-workspace-apply-fixture-suite"]
  );
  const orchestratorResult = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    buildOrchestratorEnv(process.env, required)
  );
  const fixtureReportPath = latestJsonReport(
    path.resolve(process.cwd(), TEMP_APPLY_FIXTURE_REPORT_DIR)
  );
  const fixtureReport = fixtureReportPath ? readJson(fixtureReportPath) : null;
  const orchestratorReportPath = latestJsonReport(
    path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR)
  );
  const orchestratorReport = orchestratorReportPath ? readJson(orchestratorReportPath) : null;
  const children = {
    tempWorkspaceApplyGate: {
      command: tempWorkspaceApplyGate.command,
      exitCode: tempWorkspaceApplyGate.exitCode,
      ok: tempWorkspaceApplyGate.exitCode === 0
    },
    tempWorkspaceApplyFixtures: summarizeFixtures(
      tempWorkspaceApplyFixtures,
      fixtureReportPath,
      fixtureReport
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
    children.tempWorkspaceApplyGate.exitCode === 0 &&
    children.tempWorkspaceApplyFixtures.exitCode === 0 &&
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
  summarizeFixtures,
  summarizeOrchestrator
};
