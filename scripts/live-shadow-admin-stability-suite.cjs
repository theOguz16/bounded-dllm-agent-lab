#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

const ENDPOINT =
  process.env.LIVE_VALIDATION_ENDPOINT ??
  "http://127.0.0.1:8002/v1/chat/completions";

const MODEL =
  process.env.LIVE_VALIDATION_MODEL ??
  "qwen2.5-coder-7b";

const LLAMA_HEALTH_URL =
  process.env.LIVE_LLAMA_HEALTH_URL ??
  "http://127.0.0.1:8000/health";

const PROXY_HEALTH_URL =
  process.env.LIVE_PROXY_HEALTH_URL ??
  "http://127.0.0.1:8002/health";

const BASE_OUT_DIR =
  process.env.LIVE_STABILITY_OUT_DIR ??
  "/tmp/phase-y-live/shadow-admin-stability";

const CAPTURE_PATH =
  process.env.LIVE_VALIDATION_CAPTURE_PATH ??
  "/tmp/qwen-capture/events.jsonl";

const REQUEST_TIMEOUT_MS = 300_000;

function parseCount(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0 || value > 50) {
    throw new TypeError(`${name} must be between 1 and 50.`);
  }

  return value;
}

const FORCED_RUNS = parseCount("LIVE_STABILITY_FORCED_RUNS", 5);
const NORMAL_RUNS = parseCount("LIVE_STABILITY_NORMAL_RUNS", 5);
const STOP_ON_FAILURE = process.env.LIVE_STABILITY_STOP_ON_FAILURE === "1";

function section(report, name) {
  const value = report[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function heading(title) {
  console.log();
  console.log("=".repeat(100));
  console.log(title);
  console.log("=".repeat(100));
}

function writeJson(filePath, value) {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function tail(text, maximumLines = 40) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(-maximumLines)
    .join("\n");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth(label, url) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    30_000,
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${label} health check failed with HTTP ${response.status}: ${body}`,
    );
  }

  console.log(`${label}: ${body}`);
}

function parseCompletion(upstream, label) {
  const content =
    upstream &&
    Array.isArray(upstream.choices) &&
    upstream.choices[0] &&
    upstream.choices[0].message &&
    upstream.choices[0].message.content;

  if (typeof content !== "string") {
    throw new Error(`${label} response has no string completion content.`);
  }

  let value;

  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${label} completion is not valid JSON: ${error.message}\n${content}`,
    );
  }

  return value;
}

async function runSchemaPreflight() {
  heading("REQUIRED-FIELDS SCHEMA PREFLIGHT");

  const required = [
    "version",
    "riskLevel",
    "riskScore",
    "confidenceScore",
    "findings",
    "recommendation",
    "rationaleCodes",
  ];

  const payload = {
    model: MODEL,
    temperature: 0,
    max_tokens: 256,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "Return exactly one JSON object matching the schema. " +
          "Populate every required field.",
      },
      {
        role: "user",
        content: "Return a valid low-risk observation.",
      },
    ],
    response_format: {
      type: "json_object",
      schema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            enum: ["1"],
          },
          riskLevel: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          riskScore: {
            type: "integer",
            enum: [10, 35, 60, 90],
          },
          confidenceScore: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          findings: {
            type: "array",
            maxItems: 0,
            items: {
              type: "object",
            },
          },
          recommendation: {
            type: "string",
            enum: ["continue"],
          },
          rationaleCodes: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              type: "string",
            },
          },
        },
        required,
        additionalProperties: false,
      },
    },
  };

  const response = await fetchWithTimeout(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Schema preflight failed with HTTP ${response.status}: ${responseText}`,
    );
  }

  const upstream = JSON.parse(responseText);
  const value = parseCompletion(upstream, "Schema preflight");
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Schema preflight key mismatch: ${JSON.stringify({ actual, expected, value })}`,
    );
  }

  if (
    value.version !== "1" ||
    !Array.isArray(value.findings) ||
    value.findings.length !== 0 ||
    value.recommendation !== "continue"
  ) {
    throw new Error(`Schema preflight semantic mismatch: ${JSON.stringify(value)}`);
  }

  console.log(JSON.stringify(value, null, 2));
  console.log("REQUIRED_FIELDS_SCHEMA_PREFLIGHT_PASSED");
}

function cleanOrchestratorEnvironment(forceRemask, outDir) {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("WORKER_ORCHESTRATOR_")) {
      env[key] = value;
    }
  }

  Object.assign(env, {
    WORKER_ORCHESTRATOR_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS: "512",
    WORKER_ORCHESTRATOR_CODER_MAX_TOKENS: "1024",
    WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS: "1536",
    WORKER_ORCHESTRATOR_REQUIRED: "1",
    WORKER_ORCHESTRATOR_FORCE_REMASK: forceRemask ? "1" : "0",

    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1",

    WORKER_ORCHESTRATOR_ADMIN_MODE: "always",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",

    WORKER_ORCHESTRATOR_OUT_DIR: outDir,
  });

  return env;
}

function findLatestReport(outDir) {
  const candidates = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(outDir, name);
      return {
        filePath,
        modified: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.modified - left.modified);

  if (candidates.length === 0) {
    throw new Error(`No JSON report was produced in ${outDir}.`);
  }

  return candidates[0].filePath;
}

function captureRole(request) {
  const system =
    request &&
    Array.isArray(request.messages) &&
    request.messages[0] &&
    typeof request.messages[0].content === "string"
      ? request.messages[0].content.toLowerCase()
      : "";

  if (system.includes("shadow observer")) {
    return "SHADOW";
  }

  if (system.includes("admin agent")) {
    return "ADMIN";
  }

  return null;
}

function analyzeCaptures(captureText) {
  const results = {
    SHADOW: null,
    ADMIN: null,
  };

  for (const line of captureText.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const event = JSON.parse(line);
    const role = captureRole(event.request);

    if (role === null) {
      continue;
    }

    const response = event.response;
    const choice =
      response && Array.isArray(response.choices) && response.choices[0]
        ? response.choices[0]
        : {};

    const content =
      choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : null;

    const schema =
      event.request &&
      event.request.response_format &&
      event.request.response_format.schema
        ? event.request.response_format.schema
        : {};

    let parsed = null;
    let parseError = null;

    try {
      parsed = typeof content === "string" ? JSON.parse(content) : null;

      if (parsed === null) {
        throw new Error("Completion content is not a string JSON object.");
      }
    } catch (error) {
      parseError = error.message;
    }

    const expected = new Set(schema.required ?? []);
    const actual = new Set(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed)
        : [],
    );

    const missing = [...expected].filter((key) => !actual.has(key));
    const unexpected = [...actual].filter((key) => !expected.has(key));

    results[role] = {
      httpStatus: event.status ?? null,
      finishReason: choice.finish_reason ?? null,
      schemaHasOneOf: "oneOf" in schema,
      parseError,
      missing,
      unexpected,
      parsed,
      shapeValid:
        event.status === 200 &&
        choice.finish_reason === "stop" &&
        !("oneOf" in schema) &&
        parseError === null &&
        missing.length === 0 &&
        unexpected.length === 0,
    };
  }

  return results;
}

function gitState() {
  const status = spawnSync("git", ["status", "--short"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const diffCheck = spawnSync("git", ["diff", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  return {
    revision: revision.stdout.trim(),
    clean:
      status.status === 0 &&
      status.stdout.trim() === "" &&
      diffCheck.status === 0,
    status: status.stdout.trim(),
    diffCheck: diffCheck.stdout.trim(),
  };
}

function stageTokens(report, name) {
  const value = section(report, name).totalTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function summarizeRun({ mode, index, outDir, orchestrator, elapsedMs }) {
  const reportPath = findLatestReport(outDir);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const captureText = fs.existsSync(CAPTURE_PATH)
    ? fs.readFileSync(CAPTURE_PATH, "utf8")
    : "";

  fs.writeFileSync(path.join(outDir, "capture-events.jsonl"), captureText, "utf8");

  const captures = analyzeCaptures(captureText);
  const repository = gitState();
  const shadow = section(report, "shadowObserver");
  const admin = section(report, "adminAgent");
  const router = section(report, "approvalRouter");
  const remask = section(report, "remask");
  const phaseV = section(report, "tempWorkspaceExecution");
  const artifact = section(report, "governedChangeArtifact");
  const handoff = section(report, "controlledApplyHandoff");
  const handoffVerification = section(
    report,
    "controlledApplyHandoffVerification",
  );

  const failures = [];

  function require(condition, code) {
    if (!condition) {
      failures.push(code);
    }
  }

  require(orchestrator.status === 0, "orchestrator_exit_nonzero");
  require(report.ok === true, "report_not_ok");
  require(report.status === "completed", "report_not_completed");
  require(report.forceRemask === (mode === "forced"), "force_remask_flag_mismatch");
  require(shadow.validationDecision === "shadow_observation_valid", "shadow_invalid");
  require(shadow.requiredSatisfied === true, "shadow_required_not_satisfied");
  require(admin.validationDecision === "admin_decision_valid", "admin_invalid");
  require(admin.requiredSatisfied === true, "admin_required_not_satisfied");
  require(router.deterministicAuthorityPreserved === true, "authority_not_preserved");
  require(captures.SHADOW?.shapeValid === true, "shadow_shape_invalid");
  require(captures.ADMIN?.shapeValid === true, "admin_shape_invalid");
  require(repository.clean === true, "repository_not_clean");
  require(handoff.configured === false, "controlled_handoff_configured");
  require(handoff.required === false, "controlled_handoff_required");
  require(handoff.evaluated === false, "controlled_handoff_evaluated");
  require(handoff.applyExecuted !== true, "real_apply_executed");
  require(handoff.registryWritten !== true, "consumption_registry_written");
  require(handoff.rollbackPrepared !== true, "rollback_prepared");
  require(handoff.handoffBuilt !== true, "controlled_handoff_built");
  require(handoffVerification.executionEligible !== true, "handoff_execution_eligible");

  if (mode === "forced") {
    require(remask.called === true, "forced_remask_not_called");
    require(phaseV.decision === "temp_validation_passed", "forced_phase_v_not_passed");
    require(phaseV.cleanupPerformed === true, "forced_cleanup_not_performed");
    require(phaseV.failedCommands === 0, "forced_phase_v_command_failure");
    require(report.finalDecision === "temp_validation_passed", "forced_final_decision_mismatch");
  }

  const totalTokens = [
    "planner",
    "coder",
    "verifier",
    "remask",
    "repairVerifier",
    "shadowObserver",
    "adminAgent",
  ].reduce((sum, name) => sum + stageTokens(report, name), 0);

  return {
    mode,
    index,
    success: failures.length === 0,
    failures,
    elapsedMs,
    orchestratorExit: orchestrator.status,
    reportPath,
    finalDecision: report.finalDecision ?? null,
    workflowRoute: report.workflowRoute ?? null,
    forceRemask: report.forceRemask ?? null,
    remaskCalled: remask.called ?? null,
    phaseVDecision: phaseV.decision ?? null,
    phaseVCleanupPerformed: phaseV.cleanupPerformed ?? null,
    shadowDecision: shadow.decision ?? null,
    shadowValidation: shadow.validationDecision ?? null,
    shadowRiskLevel: shadow.riskLevel ?? null,
    adminDecision: admin.decision ?? null,
    adminValidation: admin.validationDecision ?? null,
    adminRiskLevel: admin.riskLevel ?? null,
    workflowAuthorityPreserved: router.deterministicAuthorityPreserved ?? null,
    artifactDecision: artifact.decision ?? null,
    artifactApplyEligible: artifact.applyEligible ?? null,
    controlledHandoffConfigured: handoff.configured ?? null,
    controlledHandoffRequired: handoff.required ?? null,
    controlledHandoffEvaluated: handoff.evaluated ?? null,
    controlledHandoffBuilt: handoff.handoffBuilt ?? null,
    realApplyExecuted: handoff.applyExecuted ?? null,
    shadowShapeValid: captures.SHADOW?.shapeValid ?? false,
    adminShapeValid: captures.ADMIN?.shapeValid ?? false,
    repositoryClean: repository.clean,
    repositoryRevision: repository.revision,
    totalTokens,
  };
}

function runOne(mode, index) {
  const forceRemask = mode === "forced";
  const runName = `${mode}-${String(index).padStart(2, "0")}`;
  const outDir = path.join(BASE_OUT_DIR, "runs", runName);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(CAPTURE_PATH), { recursive: true });
  fs.writeFileSync(CAPTURE_PATH, "", "utf8");

  const started = Date.now();
  const orchestrator = spawnSync(
    process.execPath,
    ["scripts/worker-backed-orchestrator-smoke.cjs"],
    {
      cwd: ROOT,
      env: cleanOrchestratorEnvironment(forceRemask, outDir),
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  const elapsedMs = Date.now() - started;

  fs.writeFileSync(
    path.join(outDir, "wrapper-stdout.log"),
    orchestrator.stdout ?? "",
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "wrapper-stderr.log"),
    orchestrator.stderr ?? "",
    "utf8",
  );

  let result;

  try {
    result = summarizeRun({
      mode,
      index,
      outDir,
      orchestrator,
      elapsedMs,
    });
  } catch (error) {
    result = {
      mode,
      index,
      success: false,
      failures: ["suite_analysis_error"],
      elapsedMs,
      orchestratorExit: orchestrator.status,
      error: error instanceof Error ? error.stack : String(error),
    };
  }

  writeJson(path.join(outDir, "stability-run-summary.json"), result);

  const symbol = result.success ? "PASS" : "FAIL";
  console.log(
    `[${symbol}] ${runName} ` +
      `exit=${result.orchestratorExit} ` +
      `final=${result.finalDecision ?? "unknown"} ` +
      `route=${result.workflowRoute ?? "unknown"} ` +
      `shadow=${result.shadowValidation ?? "unknown"} ` +
      `admin=${result.adminValidation ?? "unknown"} ` +
      `tokens=${result.totalTokens ?? 0} ` +
      `elapsedMs=${elapsedMs}`,
  );

  if (!result.success) {
    console.log(`  failures=${JSON.stringify(result.failures)}`);
    console.log("  stdout tail:");
    console.log(tail(orchestrator.stdout, 20));

    if (orchestrator.stderr) {
      console.log("  stderr tail:");
      console.log(tail(orchestrator.stderr, 20));
    }
  }

  return result;
}

function distribution(results, key) {
  const counts = {};

  for (const result of results) {
    const value = String(result[key] ?? "null");
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildMarkdown(summary) {
  const lines = [
    "# Live Shadow/Admin Stability Suite",
    "",
    `- Stable: **${summary.stable}**`,
    `- Passed: **${summary.passed}/${summary.total}**`,
    `- Forced-remask: **${summary.forced.passed}/${summary.forced.total}**`,
    `- Normal: **${summary.normal.passed}/${summary.normal.total}**`,
    `- Repository revision: \`${summary.repositoryRevision}\``,
    `- Real apply executed: **${summary.realApplyExecuted}**`,
    "",
    "| Mode | Run | Result | Final decision | Route | Shadow | Admin | Remask | Tokens | Duration ms |",
    "|---|---:|---|---|---|---|---|---|---:|---:|",
  ];

  for (const result of summary.results) {
    lines.push(
      `| ${result.mode} | ${result.index} | ${result.success ? "PASS" : "FAIL"} | ` +
        `${result.finalDecision ?? "-"} | ${result.workflowRoute ?? "-"} | ` +
        `${result.shadowValidation ?? "-"} | ${result.adminValidation ?? "-"} | ` +
        `${result.remaskCalled ?? "-"} | ${result.totalTokens ?? 0} | ${result.elapsedMs} |`,
    );
  }

  lines.push("");

  if (summary.failures.length > 0) {
    lines.push("## Failures", "");

    for (const failure of summary.failures) {
      lines.push(
        `- ${failure.mode}-${failure.index}: ${failure.failures.join(", ")}`,
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  heading("LIVE SHADOW/ADMIN STABILITY SUITE");
  console.log(`forcedRuns=${FORCED_RUNS}`);
  console.log(`normalRuns=${NORMAL_RUNS}`);
  console.log(`outDir=${BASE_OUT_DIR}`);
  console.log("realApplyConfigured=false");

  await checkHealth("llama-server", LLAMA_HEALTH_URL);
  await checkHealth("capture-proxy", PROXY_HEALTH_URL);
  await runSchemaPreflight();

  fs.rmSync(BASE_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE_OUT_DIR, "runs"), { recursive: true });

  const results = [];

  for (const mode of ["forced", "normal"]) {
    const count = mode === "forced" ? FORCED_RUNS : NORMAL_RUNS;

    heading(`${mode.toUpperCase()} RUNS`);

    for (let index = 1; index <= count; index += 1) {
      const result = runOne(mode, index);
      results.push(result);

      if (!result.success && STOP_ON_FAILURE) {
        break;
      }
    }

    if (STOP_ON_FAILURE && results.some((result) => !result.success)) {
      break;
    }
  }

  const forced = results.filter((result) => result.mode === "forced");
  const normal = results.filter((result) => result.mode === "normal");
  const failures = results.filter((result) => !result.success);
  const passed = results.length - failures.length;
  const repositoryRevision = gitState().revision;

  const summary = {
    suiteName: "live-shadow-admin-stability-suite",
    generatedAt: new Date().toISOString(),
    stable:
      results.length === FORCED_RUNS + NORMAL_RUNS &&
      failures.length === 0,
    total: results.length,
    passed,
    failed: failures.length,
    successRate: results.length === 0 ? 0 : passed / results.length,
    forced: {
      total: forced.length,
      passed: forced.filter((result) => result.success).length,
      finalDecisionDistribution: distribution(forced, "finalDecision"),
      workflowRouteDistribution: distribution(forced, "workflowRoute"),
      averageTokens: average(forced.map((result) => result.totalTokens ?? 0)),
      averageElapsedMs: average(forced.map((result) => result.elapsedMs)),
    },
    normal: {
      total: normal.length,
      passed: normal.filter((result) => result.success).length,
      finalDecisionDistribution: distribution(normal, "finalDecision"),
      workflowRouteDistribution: distribution(normal, "workflowRoute"),
      remaskCalledDistribution: distribution(normal, "remaskCalled"),
      averageTokens: average(normal.map((result) => result.totalTokens ?? 0)),
      averageElapsedMs: average(normal.map((result) => result.elapsedMs)),
    },
    shadowValidationDistribution: distribution(results, "shadowValidation"),
    adminValidationDistribution: distribution(results, "adminValidation"),
    realApplyExecuted: results.some((result) => result.realApplyExecuted === true),
    controlledHandoffBuilt: results.some(
      (result) => result.controlledHandoffBuilt === true,
    ),
    repositoryRevision,
    failures: failures.map((result) => ({
      mode: result.mode,
      index: result.index,
      failures: result.failures,
      error: result.error ?? null,
    })),
    results,
  };

  const jsonPath = path.join(BASE_OUT_DIR, "stability-summary.json");
  const markdownPath = path.join(BASE_OUT_DIR, "stability-summary.md");

  writeJson(jsonPath, summary);
  fs.writeFileSync(markdownPath, buildMarkdown(summary), "utf8");

  heading("STABILITY SUMMARY");
  console.log(
    JSON.stringify(
      {
        stable: summary.stable,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        successRate: summary.successRate,
        forced: summary.forced,
        normal: summary.normal,
        shadowValidationDistribution:
          summary.shadowValidationDistribution,
        adminValidationDistribution:
          summary.adminValidationDistribution,
        realApplyExecuted: summary.realApplyExecuted,
        controlledHandoffBuilt: summary.controlledHandoffBuilt,
        repositoryRevision: summary.repositoryRevision,
        jsonPath,
        markdownPath,
      },
      null,
      2,
    ),
  );

  if (summary.stable) {
    console.log("LIVE_SHADOW_ADMIN_STABILITY_PASSED");
    return;
  }

  console.log("LIVE_SHADOW_ADMIN_STABILITY_FAILED");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error();
  console.error("LIVE_SHADOW_ADMIN_STABILITY_SCRIPT_ERROR");
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
