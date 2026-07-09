const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-t-patch-dry-run-suite-report";
const PATCH_DRY_RUN_FIXTURE_REPORT_DIR = path.join(
  "reports",
  "patch-application-dry-run-fixture-suite"
);
const ORCHESTRATOR_REPORT_DIR = path.join("reports", "worker-backed-orchestrator-smoke");
const SUITE_REPORT_DIR = path.join("reports", "phase-t-patch-dry-run-suite");

const patchAwareFinalDecisions = new Set([
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
  "patch_dry_run_rejected"
]);

const patchDryRunFinalDecisions = new Set([
  "patch_ready_to_apply",
  "patch_dry_run_needs_review",
  "patch_dry_run_rejected"
]);

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
  return Boolean(env.PHASE_T_WORKER_UPSTREAM_URL || env.WORKER_ORCHESTRATOR_UPSTREAM_URL);
}

function buildOrchestratorEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (env.PHASE_T_FORCE_REMASK === "1") {
    env.WORKER_ORCHESTRATOR_FORCE_REMASK = "1";
  }

  if (env.PHASE_T_WORKER_UPSTREAM_URL && !env.WORKER_ORCHESTRATOR_UPSTREAM_URL) {
    env.WORKER_ORCHESTRATOR_UPSTREAM_URL = env.PHASE_T_WORKER_UPSTREAM_URL;
  }

  if (env.PHASE_T_WORKER_MODEL_ID && !env.WORKER_ORCHESTRATOR_MODEL_ID) {
    env.WORKER_ORCHESTRATOR_MODEL_ID = env.PHASE_T_WORKER_MODEL_ID;
  }

  if (env.PHASE_T_WORKER_TIMEOUT_MS && !env.WORKER_ORCHESTRATOR_TIMEOUT_MS) {
    env.WORKER_ORCHESTRATOR_TIMEOUT_MS = env.PHASE_T_WORKER_TIMEOUT_MS;
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

function summarizePatchDryRunFixtures(childResult, reportPath, report) {
  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    ok: Boolean(report && report.ok),
    total: report && typeof report.total === "number" ? report.total : 0,
    passed: report && typeof report.passed === "number" ? report.passed : 0,
    failed: report && typeof report.failed === "number" ? report.failed : 0,
    readyToApplyCases:
      report && typeof report.readyToApplyCases === "number" ? report.readyToApplyCases : 0,
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
  const orchestratorDecision =
    report && report.orchestratorDecision ? report.orchestratorDecision : {};

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
    verifierIssueCount: typeof verifier.issueCount === "number" ? verifier.issueCount : null,
    remaskRequested:
      typeof remask.requested === "boolean"
        ? remask.requested
        : Boolean(orchestratorDecision.remaskRequested),
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
    patchDryRunCalled:
      typeof patchDryRun.called === "boolean"
        ? patchDryRun.called
        : Boolean(orchestratorDecision.patchDryRunCalled),
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
}

function buildSummary(children, configured, forceRemask = false) {
  const patchDryRunGatePassed = children.patchDryRunGate.exitCode === 0;
  const patchDryRunFixtureSuitePassed =
    children.patchDryRunFixtures.exitCode === 0 && children.patchDryRunFixtures.ok;
  const patchDryRunFixtureAllExpectedDecisionsObserved =
    Boolean(children.patchDryRunFixtures.allExpectedDecisionsObserved);
  const orchestratorCommandExitedZero = children.orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(children.orchestrator.configured);
  const plannerValidationPassed = Boolean(children.orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(children.orchestrator.coderValidationOk);
  const verifierCalled = Boolean(children.orchestrator.verifierCalled);
  const remaskRequested = Boolean(children.orchestrator.remaskRequested);
  const repairVerifierCalled = Boolean(children.orchestrator.repairVerifierCalled);
  const patchDryRunCalled = Boolean(children.orchestrator.patchDryRunCalled);
  const patchDryRunReadyToApply = children.orchestrator.patchDryRunDecision === "ready_to_apply";
  const patchDryRunNeedsReview = children.orchestrator.patchDryRunDecision === "needs_review";
  const patchDryRunRejected = children.orchestrator.patchDryRunDecision === "reject";
  const patchDryRunDecisionObserved = patchDryRunDecisions.has(
    children.orchestrator.patchDryRunDecision
  );
  const finalPatchDryRunDecisionObserved = patchDryRunFinalDecisions.has(
    children.orchestrator.finalDecision
  );
  const anySkipped = children.orchestrator.status === "skipped";
  const baseReady =
    configured &&
    patchDryRunGatePassed &&
    patchDryRunFixtureSuitePassed &&
    patchDryRunFixtureAllExpectedDecisionsObserved &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    patchAwareFinalDecisions.has(children.orchestrator.finalDecision) &&
    !anySkipped;
  const forcedReady =
    baseReady &&
    remaskRequested &&
    repairVerifierCalled &&
    patchDryRunCalled &&
    patchDryRunDecisionObserved &&
    finalPatchDryRunDecisionObserved;

  return {
    patchDryRunGatePassed,
    patchDryRunFixtureSuitePassed,
    patchDryRunFixtureAllExpectedDecisionsObserved,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    remaskRequested,
    repairVerifierCalled,
    patchDryRunCalled,
    patchDryRunReadyToApply,
    patchDryRunNeedsReview,
    patchDryRunRejected,
    finalPatchDryRunDecisionObserved,
    anySkipped,
    readyForRunPodLiveValidation: forceRemask ? forcedReady : baseReady
  };
}

function determineStatus(children, required) {
  if (
    children.patchDryRunGate.exitCode !== 0 ||
    children.patchDryRunFixtures.exitCode !== 0 ||
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
    "# Phase T Patch Dry-Run Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Force remask mode: ${report.forceRemask}`,
    `- Patch dry-run gate passed: ${report.summary.patchDryRunGatePassed}`,
    `- Patch dry-run fixture suite passed: ${report.summary.patchDryRunFixtureSuitePassed}`,
    `- Fixture ready_to_apply cases: ${report.children.patchDryRunFixtures.readyToApplyCases}`,
    `- Fixture needs_review cases: ${report.children.patchDryRunFixtures.needsReviewCases}`,
    `- Fixture reject cases: ${report.children.patchDryRunFixtures.rejectCases}`,
    `- Fixture expected decisions observed: ${report.children.patchDryRunFixtures.allExpectedDecisionsObserved}`,
    `- Orchestrator status: ${report.children.orchestrator.status}`,
    `- Orchestrator final decision: ${report.children.orchestrator.finalDecision || ""}`,
    `- Initial verifier decision: ${report.children.orchestrator.verifierDecision || ""}`,
    `- Remask requested: ${report.children.orchestrator.remaskRequested}`,
    `- Repair verifier called: ${report.children.orchestrator.repairVerifierCalled}`,
    `- Repair verifier decision: ${report.children.orchestrator.repairVerifierDecision || ""}`,
    `- Patch dry-run called: ${report.children.orchestrator.patchDryRunCalled}`,
    `- Patch dry-run decision: ${report.children.orchestrator.patchDryRunDecision || ""}`,
    `- Patch dry-run issue count: ${report.children.orchestrator.patchDryRunIssueCount ?? ""}`,
    `- Patch dry-run changed files: ${report.children.orchestrator.patchDryRunChangedFiles ?? ""}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Child Reports",
    "",
    `- Patch dry-run gate: command=${report.children.patchDryRunGate.command}, exitCode=${report.children.patchDryRunGate.exitCode}`,
    `- Patch dry-run fixtures: command=${report.children.patchDryRunFixtures.command}, exitCode=${report.children.patchDryRunFixtures.exitCode}, report=${report.children.patchDryRunFixtures.reportPath || ""}`,
    `- Orchestrator: command=${report.children.orchestrator.command}, exitCode=${report.children.orchestrator.exitCode}, report=${report.children.orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-phase-t-patch-dry-run-suite-report.json`);
  const markdownPath = path.join(outDir, `${timestamp}-phase-t-patch-dry-run-suite-report.md`);
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
  const required = process.env.PHASE_T_PATCH_DRY_RUN_SUITE_REQUIRED === "1";
  const forceRemask = process.env.PHASE_T_FORCE_REMASK === "1";
  const configured = configuredFromEnv(process.env);
  const patchDryRunGate = runNpmScript(
    "npm run test:patch-application-dry-run-gate",
    ["run", "test:patch-application-dry-run-gate"]
  );
  const patchDryRunFixtures = runNpmScript(
    "npm run report:patch-application-dry-run-fixture-suite",
    ["run", "report:patch-application-dry-run-fixture-suite"]
  );
  const orchestratorEnv = buildOrchestratorEnv(process.env, required);
  const orchestratorResult = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    orchestratorEnv
  );
  const patchDryRunFixtureReportPath = latestJsonReport(
    path.resolve(process.cwd(), PATCH_DRY_RUN_FIXTURE_REPORT_DIR)
  );
  const patchDryRunFixtureReport = patchDryRunFixtureReportPath
    ? readJson(patchDryRunFixtureReportPath)
    : null;
  const orchestratorReportPath = latestJsonReport(path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR));
  const orchestratorReport = orchestratorReportPath ? readJson(orchestratorReportPath) : null;
  const children = {
    patchDryRunGate: {
      command: patchDryRunGate.command,
      exitCode: patchDryRunGate.exitCode,
      ok: patchDryRunGate.exitCode === 0
    },
    patchDryRunFixtures: summarizePatchDryRunFixtures(
      patchDryRunFixtures,
      patchDryRunFixtureReportPath,
      patchDryRunFixtureReport
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
    children.patchDryRunGate.exitCode === 0 &&
    children.patchDryRunFixtures.exitCode === 0 &&
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
  summarizePatchDryRunFixtures
};
