const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-v-temporary-workspace-execution-suite-report";
const EXECUTION_FIXTURE_REPORT_DIR = path.join(
  "reports",
  "temporary-workspace-execution-verifier-fixture-suite"
);
const ORCHESTRATOR_REPORT_DIR = path.join(
  "reports",
  "worker-backed-orchestrator-smoke"
);
const SUITE_REPORT_DIR = path.join(
  "reports",
  "phase-v-temporary-workspace-execution-suite"
);

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

const executionDecisions = new Set([
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

  const candidates = fs
    .readdirSync(dirPath)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const fullPath = path.join(dirPath, fileName);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates.length > 0 ? candidates[0].fullPath : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasOwnEnv(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name);
}

function configuredFromEnv(env) {
  if (hasOwnEnv(env, "WORKER_ORCHESTRATOR_UPSTREAM_URL")) {
    return Boolean(env.WORKER_ORCHESTRATOR_UPSTREAM_URL);
  }

  return Boolean(env.PHASE_V_WORKER_UPSTREAM_URL);
}

function buildOrchestratorEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (
    env.PHASE_V_FORCE_REMASK === "1" &&
    !hasOwnEnv(env, "WORKER_ORCHESTRATOR_FORCE_REMASK")
  ) {
    env.WORKER_ORCHESTRATOR_FORCE_REMASK = "1";
  }

  for (const [phaseName, workerName] of [
    ["PHASE_V_WORKER_UPSTREAM_URL", "WORKER_ORCHESTRATOR_UPSTREAM_URL"],
    ["PHASE_V_WORKER_MODEL_ID", "WORKER_ORCHESTRATOR_MODEL_ID"],
    ["PHASE_V_WORKER_TIMEOUT_MS", "WORKER_ORCHESTRATOR_TIMEOUT_MS"]
  ]) {
    if (env[phaseName] && !hasOwnEnv(env, workerName)) {
      env[workerName] = env[phaseName];
    }
  }

  return env;
}

function runNpmScript(command, args, env = process.env) {
  const result = spawnSync(npmCommand(), args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    shell: false
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
    tempValidationPassedCases:
      report && typeof report.tempValidationPassedCases === "number"
        ? report.tempValidationPassedCases
        : 0,
    tempValidationFailedCases:
      report && typeof report.tempValidationFailedCases === "number"
        ? report.tempValidationFailedCases
        : 0,
    tempValidationNeedsReviewCases:
      report && typeof report.tempValidationNeedsReviewCases === "number"
        ? report.tempValidationNeedsReviewCases
        : 0,
    allExpectedDecisionsObserved: Boolean(
      report && report.allExpectedDecisionsObserved
    )
  };
}

function summarizeOrchestrator(childResult, reportPath, report) {
  const plannerValidation = report?.planner?.validation ?? {};
  const coderValidation = report?.coder?.validation ?? {};
  const verifier = report?.verifier ?? {};
  const remask = report?.remask ?? {};
  const repairVerifier = report?.repairVerifier ?? {};
  const patchDryRun = report?.patchDryRun ?? {};
  const tempWorkspaceApply = report?.tempWorkspaceApply ?? {};
  const tempWorkspaceExecution = report?.tempWorkspaceExecution ?? {};
  const decision = report?.orchestratorDecision ?? {};

  return {
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
      typeof remask.requested === "boolean"
        ? remask.requested
        : Boolean(decision.remaskRequested),
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
    tempWorkspaceApplyChangedFiles:
      typeof tempWorkspaceApply.changedFiles === "number"
        ? tempWorkspaceApply.changedFiles
        : decision.tempWorkspaceApplyChangedFiles ?? null,
    tempWorkspaceExecutionCalled:
      typeof tempWorkspaceExecution.called === "boolean"
        ? tempWorkspaceExecution.called
        : Boolean(decision.tempWorkspaceExecutionCalled),
    tempWorkspaceExecutionDecision:
      tempWorkspaceExecution.decision === undefined
        ? decision.tempWorkspaceExecutionDecision ?? null
        : tempWorkspaceExecution.decision,
    tempWorkspaceExecutionIssueCount:
      typeof tempWorkspaceExecution.issueCount === "number"
        ? tempWorkspaceExecution.issueCount
        : decision.tempWorkspaceExecutionIssueCount ?? null,
    tempWorkspaceExecutionCommandCount:
      typeof tempWorkspaceExecution.commandCount === "number"
        ? tempWorkspaceExecution.commandCount
        : decision.tempWorkspaceExecutionCommandCount ?? null,
    tempWorkspaceExecutionPassedCommands:
      typeof tempWorkspaceExecution.passedCommands === "number"
        ? tempWorkspaceExecution.passedCommands
        : decision.tempWorkspaceExecutionPassedCommands ?? null,
    tempWorkspaceExecutionFailedCommands:
      typeof tempWorkspaceExecution.failedCommands === "number"
        ? tempWorkspaceExecution.failedCommands
        : decision.tempWorkspaceExecutionFailedCommands ?? null,
    tempWorkspaceExecutionTimedOutCommands:
      typeof tempWorkspaceExecution.timedOutCommands === "number"
        ? tempWorkspaceExecution.timedOutCommands
        : decision.tempWorkspaceExecutionTimedOutCommands ?? null,
    tempWorkspaceExecutionCleanupPerformed:
      typeof tempWorkspaceExecution.cleanupPerformed === "boolean"
        ? tempWorkspaceExecution.cleanupPerformed
        : Boolean(decision.tempWorkspaceExecutionCleanupPerformed)
  };
}

function buildSummary(children, configured, forceRemask = false) {
  const orchestrator = children.orchestrator;
  const executionVerifierPassed = children.executionVerifier.exitCode === 0;
  const executionFixtureSuitePassed =
    children.executionVerifierFixtures.exitCode === 0 &&
    children.executionVerifierFixtures.ok;
  const executionFixtureAllExpectedDecisionsObserved = Boolean(
    children.executionVerifierFixtures.allExpectedDecisionsObserved &&
      children.executionVerifierFixtures.tempValidationPassedCases > 0 &&
      children.executionVerifierFixtures.tempValidationFailedCases > 0 &&
      children.executionVerifierFixtures.tempValidationNeedsReviewCases > 0
  );
  const orchestratorCommandExitedZero = orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(orchestrator.configured);
  const plannerValidationPassed = Boolean(orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(orchestrator.coderValidationOk);
  const verifierCalled = Boolean(orchestrator.verifierCalled);
  const remaskRequested = Boolean(orchestrator.remaskRequested);
  const repairVerifierCalled = Boolean(orchestrator.repairVerifierCalled);
  const patchDryRunCalled = Boolean(orchestrator.patchDryRunCalled);
  const tempWorkspaceApplyCalled = Boolean(orchestrator.tempWorkspaceApplyCalled);
  const tempWorkspaceExecutionCalled = Boolean(
    orchestrator.tempWorkspaceExecutionCalled
  );
  const tempValidationPassed =
    tempWorkspaceExecutionCalled &&
    orchestrator.tempWorkspaceExecutionDecision === "temp_validation_passed";
  const tempValidationFailed =
    tempWorkspaceExecutionCalled &&
    orchestrator.tempWorkspaceExecutionDecision === "temp_validation_failed";
  const tempValidationNeedsReview =
    tempWorkspaceExecutionCalled &&
    orchestrator.tempWorkspaceExecutionDecision ===
      "temp_validation_needs_review";
  const executionCleanupPerformed = Boolean(
    orchestrator.tempWorkspaceExecutionCleanupPerformed
  );
  const finalExecutionDecisionObserved = executionDecisions.has(
    orchestrator.finalDecision
  );
  const anySkipped = orchestrator.status === "skipped";
  const baseReady =
    configured &&
    executionVerifierPassed &&
    executionFixtureSuitePassed &&
    executionFixtureAllExpectedDecisionsObserved &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    !anySkipped &&
    acceptedFinalDecisions.has(orchestrator.finalDecision);
  const forcedReady =
    baseReady &&
    remaskRequested &&
    repairVerifierCalled &&
    orchestrator.repairVerifierDecision === "approve" &&
    patchDryRunCalled &&
    orchestrator.patchDryRunDecision === "ready_to_apply" &&
    tempWorkspaceApplyCalled &&
    orchestrator.tempWorkspaceApplyDecision === "temp_apply_ready" &&
    tempWorkspaceExecutionCalled &&
    executionDecisions.has(orchestrator.tempWorkspaceExecutionDecision) &&
    executionCleanupPerformed &&
    orchestrator.finalDecision === orchestrator.tempWorkspaceExecutionDecision;

  return {
    executionVerifierPassed,
    executionFixtureSuitePassed,
    executionFixtureAllExpectedDecisionsObserved,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    remaskRequested,
    repairVerifierCalled,
    patchDryRunCalled,
    tempWorkspaceApplyCalled,
    tempWorkspaceExecutionCalled,
    tempValidationPassed,
    tempValidationFailed,
    tempValidationNeedsReview,
    executionCleanupPerformed,
    finalExecutionDecisionObserved,
    anySkipped,
    readyForRunPodLiveValidation: forceRemask ? forcedReady : baseReady
  };
}

function determineStatus(children, required) {
  if (
    children.executionVerifier.exitCode !== 0 ||
    children.executionVerifierFixtures.exitCode !== 0 ||
    children.orchestrator.exitCode !== 0
  ) {
    return "failed";
  }

  if (children.orchestrator.status === "skipped") {
    return required ? "failed" : "skipped";
  }

  return children.orchestrator.status === "completed" ? "completed" : "failed";
}

function renderMarkdown(report) {
  const fixtures = report.children.executionVerifierFixtures;
  const orchestrator = report.children.orchestrator;

  return [
    "# Phase V Temporary Workspace Execution Suite",
    "",
    "## Suite Status",
    "",
    `- Status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Configuration",
    "",
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Force remask mode: ${report.forceRemask}`,
    "",
    "## Execution Verifier",
    "",
    `- Command: ${report.children.executionVerifier.command}`,
    `- Exit code: ${report.children.executionVerifier.exitCode}`,
    `- Passed: ${report.summary.executionVerifierPassed}`,
    "",
    "## Execution Fixture Suite",
    "",
    `- Command: ${fixtures.command}`,
    `- Exit code: ${fixtures.exitCode}`,
    `- OK: ${fixtures.ok}`,
    `- Total: ${fixtures.total}`,
    `- Passed: ${fixtures.passed}`,
    `- Failed: ${fixtures.failed}`,
    `- temp_validation_passed cases: ${fixtures.tempValidationPassedCases}`,
    `- temp_validation_failed cases: ${fixtures.tempValidationFailedCases}`,
    `- temp_validation_needs_review cases: ${fixtures.tempValidationNeedsReviewCases}`,
    `- All expected decisions observed: ${fixtures.allExpectedDecisionsObserved}`,
    "",
    "## Orchestrator",
    "",
    `- Status: ${orchestrator.status}`,
    `- Exit code: ${orchestrator.exitCode}`,
    `- Final decision: ${orchestrator.finalDecision ?? ""}`,
    `- Planner validation passed: ${orchestrator.plannerValidationOk}`,
    `- Coder validation passed: ${orchestrator.coderValidationOk}`,
    `- Verifier called: ${orchestrator.verifierCalled}`,
    `- Remask requested: ${orchestrator.remaskRequested}`,
    `- Repair verifier called: ${orchestrator.repairVerifierCalled}`,
    `- Repair verifier decision: ${orchestrator.repairVerifierDecision ?? ""}`,
    `- Patch dry-run called: ${orchestrator.patchDryRunCalled}`,
    `- Patch dry-run decision: ${orchestrator.patchDryRunDecision ?? ""}`,
    "",
    "## Temporary Workspace Apply",
    "",
    `- Called: ${orchestrator.tempWorkspaceApplyCalled}`,
    `- Decision: ${orchestrator.tempWorkspaceApplyDecision ?? ""}`,
    `- Changed files: ${orchestrator.tempWorkspaceApplyChangedFiles ?? ""}`,
    "",
    "## Temporary Workspace Execution",
    "",
    `- Called: ${orchestrator.tempWorkspaceExecutionCalled}`,
    `- Decision: ${orchestrator.tempWorkspaceExecutionDecision ?? ""}`,
    `- Issue count: ${orchestrator.tempWorkspaceExecutionIssueCount ?? ""}`,
    `- Validation command count: ${orchestrator.tempWorkspaceExecutionCommandCount ?? ""}`,
    `- Passed commands: ${orchestrator.tempWorkspaceExecutionPassedCommands ?? ""}`,
    `- Failed commands: ${orchestrator.tempWorkspaceExecutionFailedCommands ?? ""}`,
    `- Timed-out commands: ${orchestrator.tempWorkspaceExecutionTimedOutCommands ?? ""}`,
    `- Final decision: ${orchestrator.finalDecision ?? ""}`,
    "",
    "## Cleanup",
    "",
    `- Execution cleanup performed: ${orchestrator.tempWorkspaceExecutionCleanupPerformed}`,
    "",
    "## Live Readiness",
    "",
    `- Final execution decision observed: ${report.summary.finalExecutionDecisionObserved}`,
    `- Any skipped: ${report.summary.anySkipped}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    "",
    "## Child Report Paths",
    "",
    `- Execution verifier: ${report.children.executionVerifier.command}`,
    `- Execution fixtures: ${fixtures.reportPath || ""}`,
    `- Orchestrator: ${orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(
    outDir,
    `${timestamp}-phase-v-temporary-workspace-execution-suite-report.json`
  );
  const markdownPath = path.join(
    outDir,
    `${timestamp}-phase-v-temporary-workspace-execution-suite-report.md`
  );
  const reportWithPaths = { ...report, jsonPath, markdownPath };

  fs.writeFileSync(jsonPath, JSON.stringify(reportWithPaths, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(reportWithPaths));
  return reportWithPaths;
}

function run() {
  const startedAt = new Date();
  const required = process.env.PHASE_V_EXECUTION_SUITE_REQUIRED === "1";
  const forceRemask = process.env.PHASE_V_FORCE_REMASK === "1";
  const configured = configuredFromEnv(process.env);
  const executionVerifier = runNpmScript(
    "npm run test:temporary-workspace-execution-verifier",
    ["run", "test:temporary-workspace-execution-verifier"]
  );
  const executionVerifierFixtures = runNpmScript(
    "npm run report:temporary-workspace-execution-verifier-fixture-suite",
    ["run", "report:temporary-workspace-execution-verifier-fixture-suite"]
  );
  const orchestratorResult = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    buildOrchestratorEnv(process.env, required)
  );
  const fixtureReportPath = latestJsonReport(
    path.resolve(process.cwd(), EXECUTION_FIXTURE_REPORT_DIR)
  );
  const fixtureReport = fixtureReportPath ? readJson(fixtureReportPath) : null;
  const orchestratorReportPath = latestJsonReport(
    path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR)
  );
  const orchestratorReport = orchestratorReportPath
    ? readJson(orchestratorReportPath)
    : null;
  const children = {
    executionVerifier: {
      command: executionVerifier.command,
      exitCode: executionVerifier.exitCode,
      ok: executionVerifier.exitCode === 0
    },
    executionVerifierFixtures: summarizeFixtures(
      executionVerifierFixtures,
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
    children.executionVerifier.exitCode === 0 &&
    children.executionVerifierFixtures.exitCode === 0 &&
    children.orchestrator.exitCode === 0 &&
    !(required && summary.anySkipped);

  return writeReport({
    ok,
    status,
    suiteName: SUITE_NAME,
    required,
    configured,
    forceRemask,
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
  configuredFromEnv,
  determineStatus,
  renderMarkdown,
  run,
  summarizeFixtures,
  summarizeOrchestrator
};
