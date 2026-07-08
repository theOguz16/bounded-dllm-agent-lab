const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-q-verifier-suite-report";
const ORCHESTRATOR_REPORT_DIR = path.join("reports", "worker-backed-orchestrator-smoke");
const SUITE_REPORT_DIR = path.join("reports", "phase-q-verifier-suite");

const verifierFinalDecisions = new Set([
  "approved_by_deterministic_verifier",
  "needs_review_by_deterministic_verifier",
  "rejected_by_deterministic_verifier"
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
  return Boolean(env.PHASE_Q_WORKER_UPSTREAM_URL || env.WORKER_ORCHESTRATOR_UPSTREAM_URL);
}

function buildOrchestratorEnv(baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env.WORKER_ORCHESTRATOR_REQUIRED = "1";
  }

  if (env.PHASE_Q_WORKER_UPSTREAM_URL && !env.WORKER_ORCHESTRATOR_UPSTREAM_URL) {
    env.WORKER_ORCHESTRATOR_UPSTREAM_URL = env.PHASE_Q_WORKER_UPSTREAM_URL;
  }

  if (env.PHASE_Q_WORKER_MODEL_ID && !env.WORKER_ORCHESTRATOR_MODEL_ID) {
    env.WORKER_ORCHESTRATOR_MODEL_ID = env.PHASE_Q_WORKER_MODEL_ID;
  }

  if (env.PHASE_Q_WORKER_TIMEOUT_MS && !env.WORKER_ORCHESTRATOR_TIMEOUT_MS) {
    env.WORKER_ORCHESTRATOR_TIMEOUT_MS = env.PHASE_Q_WORKER_TIMEOUT_MS;
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

function summarizeOrchestrator(childResult, reportPath, report) {
  const plannerValidation = report && report.planner && report.planner.validation
    ? report.planner.validation
    : {};
  const coderValidation = report && report.coder && report.coder.validation
    ? report.coder.validation
    : {};
  const verifier = report && report.verifier ? report.verifier : {};

  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath,
    status: report ? report.status || "missing_report" : "missing_report",
    ok: Boolean(report && report.ok),
    configured: Boolean(report && report.configured),
    finalDecision: report ? report.finalDecision || null : null,
    plannerValidationOk: Boolean(plannerValidation.ok),
    coderValidationOk: Boolean(coderValidation.ok),
    verifierCalled: Boolean(verifier.called),
    verifierDecision: verifier.decision ?? null,
    verifierIssueCount: typeof verifier.issueCount === "number" ? verifier.issueCount : null
  };
}

function buildSummary(children, configured) {
  const verifierGateTestPassed = children.deterministicVerifierGate.exitCode === 0;
  const orchestratorCommandExitedZero = children.orchestrator.exitCode === 0;
  const orchestratorConfigured = Boolean(children.orchestrator.configured);
  const plannerValidationPassed = Boolean(children.orchestrator.plannerValidationOk);
  const coderValidationPassed = Boolean(children.orchestrator.coderValidationOk);
  const verifierCalled = Boolean(children.orchestrator.verifierCalled);
  const verifierApproved = children.orchestrator.finalDecision === "approved_by_deterministic_verifier";
  const verifierNeedsReview = children.orchestrator.finalDecision === "needs_review_by_deterministic_verifier";
  const verifierRejected = children.orchestrator.finalDecision === "rejected_by_deterministic_verifier";
  const anySkipped = children.orchestrator.status === "skipped";

  return {
    verifierGateTestPassed,
    orchestratorCommandExitedZero,
    orchestratorConfigured,
    plannerValidationPassed,
    coderValidationPassed,
    verifierCalled,
    verifierApproved,
    verifierNeedsReview,
    verifierRejected,
    anySkipped,
    readyForRunPodLiveValidation:
      configured &&
      verifierGateTestPassed &&
      orchestratorCommandExitedZero &&
      plannerValidationPassed &&
      coderValidationPassed &&
      verifierCalled &&
      verifierFinalDecisions.has(children.orchestrator.finalDecision) &&
      !anySkipped
  };
}

function determineStatus(children, required) {
  if (
    children.deterministicVerifierGate.exitCode !== 0 ||
    children.orchestrator.exitCode !== 0
  ) {
    return "failed";
  }

  if (children.orchestrator.status === "completed") {
    return "completed";
  }

  if (children.orchestrator.status === "skipped" && required) {
    return "failed";
  }

  if (children.orchestrator.status === "skipped") {
    return "partial";
  }

  return "failed";
}

function renderMarkdown(report) {
  return [
    "# Phase Q Verifier Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Deterministic verifier gate test passed: ${report.summary.verifierGateTestPassed}`,
    `- Orchestrator status: ${report.children.orchestrator.status}`,
    `- Planner validation passed: ${report.summary.plannerValidationPassed}`,
    `- Coder validation passed: ${report.summary.coderValidationPassed}`,
    `- Verifier called: ${report.summary.verifierCalled}`,
    `- Verifier decision: ${report.children.orchestrator.verifierDecision || ""}`,
    `- Verifier issue count: ${report.children.orchestrator.verifierIssueCount ?? ""}`,
    `- Final decision: ${report.children.orchestrator.finalDecision || ""}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Child Reports",
    "",
    `- Deterministic verifier gate: command=${report.children.deterministicVerifierGate.command}, exitCode=${report.children.deterministicVerifierGate.exitCode}`,
    `- Orchestrator: command=${report.children.orchestrator.command}, exitCode=${report.children.orchestrator.exitCode}, report=${report.children.orchestrator.reportPath || ""}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), SUITE_REPORT_DIR));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-phase-q-verifier-suite-report.json`);
  const markdownPath = path.join(outDir, `${timestamp}-phase-q-verifier-suite-report.md`);
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
  const required = process.env.PHASE_Q_VERIFIER_SUITE_REQUIRED === "1";
  const configured = configuredFromEnv(process.env);
  const deterministicVerifierGate = runNpmScript(
    "npm run test:deterministic-verifier-gate",
    ["run", "test:deterministic-verifier-gate"]
  );
  const orchestratorEnv = buildOrchestratorEnv(process.env, required);
  const orchestratorResult = runNpmScript(
    "npm run worker:orchestrator-smoke",
    ["run", "worker:orchestrator-smoke"],
    orchestratorEnv
  );
  const orchestratorReportPath = latestJsonReport(path.resolve(process.cwd(), ORCHESTRATOR_REPORT_DIR));
  const orchestratorReport = orchestratorReportPath ? readJson(orchestratorReportPath) : null;
  const children = {
    deterministicVerifierGate: {
      command: deterministicVerifierGate.command,
      exitCode: deterministicVerifierGate.exitCode,
      ok: deterministicVerifierGate.exitCode === 0
    },
    orchestrator: summarizeOrchestrator(
      orchestratorResult,
      orchestratorReportPath,
      orchestratorReport
    )
  };
  const summary = buildSummary(children, configured);
  const status = determineStatus(children, required);
  const finishedAt = new Date();
  const ok =
    children.deterministicVerifierGate.exitCode === 0 &&
    children.orchestrator.exitCode === 0 &&
    !(required && summary.anySkipped);

  return writeReport({
    ok,
    status,
    suiteName: SUITE_NAME,
    required,
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
  run
};
