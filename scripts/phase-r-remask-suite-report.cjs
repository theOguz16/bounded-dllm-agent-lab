const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-r-remask-suite-report";
const REMASK_WORKER_REPORT_DIR = path.join("reports", "worker-backed-remask-smoke");
const ORCHESTRATOR_REPORT_DIR = path.join("reports", "worker-backed-orchestrator-smoke");
const SUITE_REPORT_DIR = path.join("reports", "phase-r-remask-suite");

const remaskAwareFinalDecisions = new Set([
  "approved_by_deterministic_verifier",
  "rejected_by_deterministic_verifier",
  "needs_review_by_deterministic_verifier",
  "remask_requested",
  "repair_draft_ready",
  "repair_approved_by_deterministic_verifier",
  "repair_needs_review_by_deterministic_verifier",
  "repair_rejected_by_deterministic_verifier",
  "remask_repair_failed"
]);

const repairVerifierFinalDecisions = new Set([
  "repair_approved_by_deterministic_verifier",
  "repair_needs_review_by_deterministic_verifier",
  "repair_rejected_by_deterministic_verifier"
]);

const repairVerifierDecisions = new Set(["approve", "needs_review", "reject"]);

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
  return Boolean(
    env.PHASE_R_WORKER_UPSTREAM_URL ||
      env.WORKER_REMASK_UPSTREAM_URL ||
      env.WORKER_ORCHESTRATOR_UPSTREAM_URL
  );
}

function buildWorkerEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_REMASK_REQUIRED = "1";
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (env.PHASE_R_FORCE_REMASK === "1") {
    env.WORKER_ORCHESTRATOR_FORCE_REMASK = "1";
  }

  if (env.PHASE_R_WORKER_UPSTREAM_URL) {
    if (!env.WORKER_REMASK_UPSTREAM_URL) {
      env.WORKER_REMASK_UPSTREAM_URL = env.PHASE_R_WORKER_UPSTREAM_URL;
    }
    if (!env.WORKER_ORCHESTRATOR_UPSTREAM_URL) {
      env.WORKER_ORCHESTRATOR_UPSTREAM_URL = env.PHASE_R_WORKER_UPSTREAM_URL;
    }
  }

  if (env.PHASE_R_WORKER_MODEL_ID) {
    if (!env.WORKER_REMASK_MODEL_ID) {
      env.WORKER_REMASK_MODEL_ID = env.PHASE_R_WORKER_MODEL_ID;
    }
    if (!env.WORKER_ORCHESTRATOR_MODEL_ID) {
      env.WORKER_ORCHESTRATOR_MODEL_ID = env.PHASE_R_WORKER_MODEL_ID;
    }
  }

  if (env.PHASE_R_WORKER_TIMEOUT_MS) {
    if (!env.WORKER_REMASK_TIMEOUT_MS) {
      env.WORKER_REMASK_TIMEOUT_MS = env.PHASE_R_WORKER_TIMEOUT_MS;
    }
    if (!env.WORKER_ORCHESTRATOR_TIMEOUT_MS) {
      env.WORKER_ORCHESTRATOR_TIMEOUT_MS = env.PHASE_R_WORKER_TIMEOUT_MS;
    }
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

function summarizeRemaskWorker(childResult, reportPath, report) {
  const validation = report && report.validation ? report.validation : {};
  const repairDraftChecks = report && report.repairDraftChecks ? report.repairDraftChecks : {};
  const validationIssues = Array.isArray(validation.issues) ? validation.issues : [];
  const repairDraftIssues = Array.isArray(repairDraftChecks.issues) ? repairDraftChecks.issues : [];

  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    status: report ? report.status || "missing_report" : "missing_report",
    ok: Boolean(report && report.ok),
    configured: Boolean(report && report.configured),
    validationOk: Boolean(validation.ok),
    blocked: Boolean(validation.blocked),
    repairDraftChecksOk: Boolean(repairDraftChecks.ok),
    issueCount: validationIssues.length + repairDraftIssues.length,
    latencyMs: report && typeof report.latencyMs === "number" ? report.latencyMs : null
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
  const orchestratorDecision =
    report && report.orchestratorDecision ? report.orchestratorDecision : {};
  const repairVerifierFieldsPresent = Boolean(
    (report && report.repairVerifier) ||
      orchestratorDecision.repairVerifierCalled !== undefined ||
      orchestratorDecision.repairVerifierDecision !== undefined ||
      orchestratorDecision.repairVerifierIssueCount !== undefined
  );

  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    status: report ? report.status || "missing_report" : "missing_report",
    ok: Boolean(report && report.ok),
    configured: Boolean(report && report.configured),
    forceRemask: Boolean(report && report.forceRemask),
    forcedRemask: Boolean(orchestratorDecision.forcedRemask),
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
    repairVerifierFieldsPresent,
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
        : orchestratorDecision.repairVerifierIssueCount ?? null
  };
}

function buildSummary(children, configured, forceRemask = false) {
  const remaskRequestBuilderPassed = children.remaskRequestBuilder.exitCode === 0;
  const remaskWorkerCommandExitedZero = children.remaskWorker.exitCode === 0;
  const remaskWorkerConfigured = Boolean(children.remaskWorker.configured);
  const remaskWorkerValidationPassed = Boolean(children.remaskWorker.validationOk);
  const remaskWorkerRepairDraftChecksPassed = Boolean(children.remaskWorker.repairDraftChecksOk);
  const orchestratorCommandExitedZero = children.orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(children.orchestrator.configured);
  const plannerValidationPassed = Boolean(children.orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(children.orchestrator.coderValidationOk);
  const verifierCalled = Boolean(children.orchestrator.verifierCalled);
  const remaskSupported = remaskAwareFinalDecisions.has(children.orchestrator.finalDecision);
  const remaskRequested = Boolean(children.orchestrator.remaskRequested);
  const repairDraftReady = children.orchestrator.finalDecision === "repair_draft_ready";
  const remaskRepairFailed = children.orchestrator.finalDecision === "remask_repair_failed";
  const repairVerifierFinalDecision = repairVerifierFinalDecisions.has(children.orchestrator.finalDecision);
  const repairVerifierCalled = Boolean(children.orchestrator.repairVerifierCalled);
  const repairVerifierDecisionValid = repairVerifierDecisions.has(children.orchestrator.repairVerifierDecision);
  const repairVerifierSatisfied =
    !repairVerifierFinalDecision || (repairVerifierCalled && repairVerifierDecisionValid);
  const anySkipped =
    children.remaskWorker.status === "skipped" || children.orchestrator.status === "skipped";
  const normalReadyForRunPodLiveValidation =
    configured &&
    remaskRequestBuilderPassed &&
    remaskWorkerCommandExitedZero &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    remaskAwareFinalDecisions.has(children.orchestrator.finalDecision) &&
    repairVerifierSatisfied &&
    !anySkipped;
  const forcedReadyForRunPodLiveValidation =
    configured &&
    remaskRequestBuilderPassed &&
    remaskWorkerCommandExitedZero &&
    orchestratorCommandExitedZero &&
    plannerValidationPassed &&
    coderValidationPassed &&
    verifierCalled &&
    remaskRequested &&
    (repairDraftReady || remaskRepairFailed || repairVerifierFinalDecision) &&
    repairVerifierSatisfied &&
    !anySkipped;

  return {
    forceRemask,
    remaskRequestBuilderPassed,
    remaskWorkerCommandExitedZero,
    remaskWorkerConfigured,
    remaskWorkerValidationPassed,
    remaskWorkerRepairDraftChecksPassed,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    remaskSupported,
    remaskRequested,
    repairDraftReady,
    repairVerifierFinalDecision,
    repairVerifierCalled,
    repairVerifierDecisionValid,
    remaskRepairFailed,
    anySkipped,
    readyForRunPodLiveValidation: forceRemask
      ? forcedReadyForRunPodLiveValidation
      : normalReadyForRunPodLiveValidation
  };
}

function determineStatus(children, required) {
  if (
    children.remaskRequestBuilder.exitCode !== 0 ||
    children.remaskWorker.exitCode !== 0 ||
    children.orchestrator.exitCode !== 0
  ) {
    return "failed";
  }

  const remaskWorkerSkipped = children.remaskWorker.status === "skipped";
  const orchestratorSkipped = children.orchestrator.status === "skipped";

  if (required && (remaskWorkerSkipped || orchestratorSkipped)) {
    return "failed";
  }

  if (remaskWorkerSkipped && orchestratorSkipped) {
    return "skipped";
  }

  if (remaskWorkerSkipped || orchestratorSkipped) {
    return "partial";
  }

  if (children.remaskWorker.status === "completed" && children.orchestrator.status === "completed") {
    return "completed";
  }

  return "failed";
}

function renderMarkdown(report) {
  return [
    "# Phase R Remask Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Force remask mode: ${report.forceRemask}`,
    `- Remask request builder passed: ${report.summary.remaskRequestBuilderPassed}`,
    `- Remask worker status: ${report.children.remaskWorker.status}`,
    `- Remask worker validation passed: ${report.children.remaskWorker.validationOk}`,
    `- Remask worker repairDraft checks passed: ${report.children.remaskWorker.repairDraftChecksOk}`,
    `- Orchestrator status: ${report.children.orchestrator.status}`,
    `- Orchestrator force remask: ${report.children.orchestrator.forceRemask}`,
    `- Orchestrator forced remask: ${report.children.orchestrator.forcedRemask}`,
    `- Orchestrator final decision: ${report.children.orchestrator.finalDecision || ""}`,
    `- Verifier decision: ${report.children.orchestrator.verifierDecision || ""}`,
    `- Remask requested: ${report.children.orchestrator.remaskRequested}`,
    `- Remask repairability: ${report.children.orchestrator.remaskRepairability ?? ""}`,
    `- Remask validation OK: ${report.children.orchestrator.remaskValidationOk ?? ""}`,
    `- RepairDraft checks OK: ${report.children.orchestrator.repairDraftChecksOk ?? ""}`,
    `- Repair verifier called: ${report.children.orchestrator.repairVerifierCalled}`,
    `- Repair verifier decision: ${report.children.orchestrator.repairVerifierDecision || ""}`,
    `- Repair verifier issue count: ${report.children.orchestrator.repairVerifierIssueCount ?? ""}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Child Reports",
    "",
    `- Remask request builder: command=${report.children.remaskRequestBuilder.command}, exitCode=${report.children.remaskRequestBuilder.exitCode}`,
    `- Remask worker: command=${report.children.remaskWorker.command}, exitCode=${report.children.remaskWorker.exitCode}, report=${report.children.remaskWorker.reportPath || ""}`,
    `- Orchestrator: command=${report.children.orchestrator.command}, exitCode=${report.children.orchestrator.exitCode}, report=${report.children.orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-phase-r-remask-suite-report.json`);
  const markdownPath = path.join(outDir, `${timestamp}-phase-r-remask-suite-report.md`);
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
  const required = process.env.PHASE_R_REMASK_SUITE_REQUIRED === "1";
  const forceRemask = process.env.PHASE_R_FORCE_REMASK === "1";
  const configured = configuredFromEnv(process.env);
  const workerEnv = buildWorkerEnv(process.env, required);
  const remaskRequestBuilder = runNpmScript(
    "npm run test:remask-request-builder",
    ["run", "test:remask-request-builder"]
  );
  const remaskWorker = runNpmScript(
    "npm run worker:remask-smoke",
    ["run", "worker:remask-smoke"],
    workerEnv
  );
  const orchestrator = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    workerEnv
  );
  const remaskWorkerReportPath = latestJsonReport(path.resolve(process.cwd(), REMASK_WORKER_REPORT_DIR));
  const remaskWorkerReport = remaskWorkerReportPath ? readJson(remaskWorkerReportPath) : null;
  const orchestratorReportPath = latestJsonReport(path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR));
  const orchestratorReport = orchestratorReportPath ? readJson(orchestratorReportPath) : null;
  const children = {
    remaskRequestBuilder: {
      command: remaskRequestBuilder.command,
      exitCode: remaskRequestBuilder.exitCode,
      ok: remaskRequestBuilder.exitCode === 0
    },
    remaskWorker: summarizeRemaskWorker(
      remaskWorker,
      remaskWorkerReportPath,
      remaskWorkerReport
    ),
    orchestrator: summarizeOrchestrator(
      orchestrator,
      orchestratorReportPath,
      orchestratorReport
    )
  };
  const summary = buildSummary(children, configured, forceRemask);
  const status = determineStatus(children, required);
  const finishedAt = new Date();
  const ok =
    children.remaskRequestBuilder.exitCode === 0 &&
    children.remaskWorker.exitCode === 0 &&
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
  buildSummary,
  buildWorkerEnv,
  determineStatus,
  run,
  summarizeOrchestrator,
  summarizeRemaskWorker
};
