const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SUITE_NAME = "phase-p-worker-suite-report";

const children = {
  planner: {
    command: "npm run worker:planner-smoke",
    args: ["run", "worker:planner-smoke"],
    reportDirEnv: "WORKER_PLANNER_OUT_DIR",
    defaultReportDir: path.join("reports", "worker-backed-planner-smoke"),
    requiredEnv: "WORKER_PLANNER_REQUIRED",
    upstreamEnv: "WORKER_PLANNER_UPSTREAM_URL",
    modelEnv: "WORKER_PLANNER_MODEL_ID",
    timeoutEnv: "WORKER_PLANNER_TIMEOUT_MS"
  },
  coder: {
    command: "npm run worker:coder-smoke",
    args: ["run", "worker:coder-smoke"],
    reportDirEnv: "WORKER_CODER_OUT_DIR",
    defaultReportDir: path.join("reports", "worker-backed-coder-smoke"),
    requiredEnv: "WORKER_CODER_REQUIRED",
    upstreamEnv: "WORKER_CODER_UPSTREAM_URL",
    modelEnv: "WORKER_CODER_MODEL_ID",
    timeoutEnv: "WORKER_CODER_TIMEOUT_MS"
  },
  orchestrator: {
    command: "npm run worker:orchestrator-smoke",
    args: ["run", "worker:orchestrator-smoke"],
    reportDirEnv: "WORKER_ORCHESTRATOR_OUT_DIR",
    defaultReportDir: path.join("reports", "worker-backed-orchestrator-smoke"),
    requiredEnv: "WORKER_ORCHESTRATOR_REQUIRED",
    upstreamEnv: "WORKER_ORCHESTRATOR_UPSTREAM_URL",
    modelEnv: "WORKER_ORCHESTRATOR_MODEL_ID",
    timeoutEnv: "WORKER_ORCHESTRATOR_TIMEOUT_MS"
  }
};

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
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

function issueCount(validation) {
  return validation && Array.isArray(validation.issues) ? validation.issues.length : 0;
}

function configuredFromEnv(env) {
  return Boolean(
    env.PHASE_P_WORKER_UPSTREAM_URL ||
      env.WORKER_PLANNER_UPSTREAM_URL ||
      env.WORKER_CODER_UPSTREAM_URL ||
      env.WORKER_ORCHESTRATOR_UPSTREAM_URL
  );
}

function childReportDir(child, env) {
  return path.resolve(process.cwd(), env[child.reportDirEnv] || child.defaultReportDir);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function buildChildEnv(child, baseEnv, required) {
  const env = { ...baseEnv };

  if (required) {
    env[child.requiredEnv] = "1";
  }

  if (env.PHASE_P_WORKER_UPSTREAM_URL && !env[child.upstreamEnv]) {
    env[child.upstreamEnv] = env.PHASE_P_WORKER_UPSTREAM_URL;
  }

  if (env.PHASE_P_WORKER_MODEL_ID && !env[child.modelEnv]) {
    env[child.modelEnv] = env.PHASE_P_WORKER_MODEL_ID;
  }

  if (env.PHASE_P_WORKER_TIMEOUT_MS && !env[child.timeoutEnv]) {
    env[child.timeoutEnv] = env.PHASE_P_WORKER_TIMEOUT_MS;
  }

  return env;
}

function runChild(name, child, required) {
  const env = buildChildEnv(child, process.env, required);
  const result = spawnSync(npmCommand(), child.args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  const reportPath = latestJsonReport(childReportDir(child, env));
  const report = reportPath ? readJson(reportPath) : null;

  return {
    name,
    command: child.command,
    exitCode: result.status === null ? 1 : result.status,
    reportPath,
    report,
    stderr: result.stderr || "",
    stdout: result.stdout || ""
  };
}

function summarizePlannerLike(childResult) {
  const report = childResult.report || {};
  const validation = report.validation || {};

  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath: childResult.reportPath,
    status: report.status || "missing_report",
    ok: Boolean(report.ok),
    configured: Boolean(report.configured),
    validationOk: Boolean(validation.ok),
    blocked: Boolean(validation.blocked),
    issueCount: issueCount(validation),
    latencyMs: report.latencyMs ?? null
  };
}

function summarizeOrchestrator(childResult) {
  const report = childResult.report || {};
  const plannerValidation = report.planner && report.planner.validation ? report.planner.validation : {};
  const coderValidation = report.coder && report.coder.validation ? report.coder.validation : {};

  return {
    command: childResult.command,
    exitCode: childResult.exitCode,
    reportPath: childResult.reportPath,
    status: report.status || "missing_report",
    ok: Boolean(report.ok),
    configured: Boolean(report.configured),
    finalDecision: report.finalDecision || null,
    plannerValidationOk: Boolean(plannerValidation.ok),
    coderValidationOk: Boolean(coderValidation.ok),
    plannerIssueCount: issueCount(plannerValidation),
    coderIssueCount: issueCount(coderValidation)
  };
}

function determineStatus(childSummaries) {
  const values = Object.values(childSummaries);
  const allExitZero = values.every((child) => child.exitCode === 0);
  const statuses = values.map((child) => child.status);

  if (!allExitZero) {
    return "failed";
  }

  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }

  if (statuses.some((status) => status === "skipped")) {
    return "partial";
  }

  return "completed";
}

function buildSummary(childSummaries, required, configured) {
  const values = Object.values(childSummaries);
  const allCommandsExitedZero = values.every((child) => child.exitCode === 0);
  const allConfigured = values.every((child) => child.configured);
  const allValidationPassed =
    childSummaries.planner.validationOk &&
    childSummaries.coder.validationOk &&
    childSummaries.orchestrator.plannerValidationOk &&
    childSummaries.orchestrator.coderValidationOk;
  const anySkipped = values.some((child) => child.status === "skipped");
  const anyBlocked =
    childSummaries.planner.blocked ||
    childSummaries.coder.blocked ||
    childSummaries.orchestrator.finalDecision === "blocked";

  return {
    allCommandsExitedZero,
    allConfigured,
    allValidationPassed,
    anySkipped,
    anyBlocked,
    readyForRunPodLiveValidation:
      configured &&
      allCommandsExitedZero &&
      allConfigured &&
      allValidationPassed &&
      !anySkipped &&
      !anyBlocked
  };
}

function renderMarkdown(report) {
  return [
    "# Phase P Worker Suite Report",
    "",
    `- Suite status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Required mode: ${report.required}`,
    `- Configured endpoint: ${report.configured}`,
    `- Ready for RunPod live validation: ${report.summary.readyForRunPodLiveValidation}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt}`,
    `- Duration ms: ${report.durationMs}`,
    "",
    "## Children",
    "",
    `- Planner: status=${report.children.planner.status}, ok=${report.children.planner.ok}, validationOk=${report.children.planner.validationOk}, blocked=${report.children.planner.blocked}, report=${report.children.planner.reportPath || ""}`,
    `- Coder: status=${report.children.coder.status}, ok=${report.children.coder.ok}, validationOk=${report.children.coder.validationOk}, blocked=${report.children.coder.blocked}, report=${report.children.coder.reportPath || ""}`,
    `- Orchestrator: status=${report.children.orchestrator.status}, ok=${report.children.orchestrator.ok}, finalDecision=${report.children.orchestrator.finalDecision || ""}, plannerValidationOk=${report.children.orchestrator.plannerValidationOk}, coderValidationOk=${report.children.orchestrator.coderValidationOk}, report=${report.children.orchestrator.reportPath || ""}`,
    "",
    "## Summary",
    "",
    `- All commands exited zero: ${report.summary.allCommandsExitedZero}`,
    `- All configured: ${report.summary.allConfigured}`,
    `- All validation passed: ${report.summary.allValidationPassed}`,
    `- Any skipped: ${report.summary.anySkipped}`,
    `- Any blocked: ${report.summary.anyBlocked}`,
    ""
  ].join("\n");
}

function writeReport(report) {
  const outDir = ensureDir(path.resolve(process.cwd(), process.env.PHASE_P_WORKER_SUITE_OUT_DIR || path.join("reports", "phase-p-worker-suite")));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-phase-p-worker-suite-report.json`);
  const markdownPath = path.join(outDir, `${timestamp}-phase-p-worker-suite-report.md`);
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
  const required = process.env.PHASE_P_WORKER_SUITE_REQUIRED === "1";
  const configured = configuredFromEnv(process.env);
  const childResults = {
    planner: runChild("planner", children.planner, required),
    coder: runChild("coder", children.coder, required),
    orchestrator: runChild("orchestrator", children.orchestrator, required)
  };
  const childSummaries = {
    planner: summarizePlannerLike(childResults.planner),
    coder: summarizePlannerLike(childResults.coder),
    orchestrator: summarizeOrchestrator(childResults.orchestrator)
  };
  const finishedAt = new Date();
  const summary = buildSummary(childSummaries, required, configured);
  const status = determineStatus(childSummaries);
  const ok = summary.allCommandsExitedZero && !(required && summary.anySkipped);

  return writeReport({
    ok,
    status,
    suiteName: SUITE_NAME,
    required,
    configured,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    children: childSummaries,
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
  buildChildEnv,
  buildSummary,
  run
};
