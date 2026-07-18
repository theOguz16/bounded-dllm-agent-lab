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

const OUT_DIR =
  process.env.LIVE_VALIDATION_OUT_DIR ??
  "/tmp/phase-y-live/embedded-shadow-admin-validation";

const CAPTURE_PATH =
  process.env.LIVE_VALIDATION_CAPTURE_PATH ??
  "/tmp/qwen-capture/events.jsonl";

const REQUEST_TIMEOUT_MS = 300_000;

function section(report, name) {
  const value = report[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function printHeading(title) {
  console.log();
  console.log("=".repeat(100));
  console.log(title);
  console.log("=".repeat(100));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function tail(text, maximumLines = 60) {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines.slice(-maximumLines).join("\n");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

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

  return {
    content,
    value,
    finishReason: upstream.choices[0].finish_reason ?? null,
  };
}

function assertExactKeys(value, expectedKeys, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value).sort();

  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} key mismatch:\n` +
        JSON.stringify(
          {
            missing,
            unexpected,
            value,
          },
          null,
          2,
        ),
    );
  }
}

async function runRequiredFieldsPreflight() {
  printHeading("REQUIRED-FIELDS SCHEMA PREFLIGHT");

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

  let upstream;

  try {
    upstream = JSON.parse(responseText);
  } catch {
    throw new Error(`Schema preflight returned invalid JSON: ${responseText}`);
  }

  const completion = parseCompletion(upstream, "Schema preflight");

  assertExactKeys(
    completion.value,
    required,
    "Schema preflight completion",
  );

  if (completion.value.version !== "1") {
    throw new Error("Schema preflight returned an invalid version.");
  }

  if (
    !Array.isArray(completion.value.findings) ||
    completion.value.findings.length !== 0
  ) {
    throw new Error("Schema preflight findings must be an empty array.");
  }

  if (completion.value.recommendation !== "continue") {
    throw new Error("Schema preflight recommendation must be continue.");
  }

  const validRiskLevels = new Set([
    "low",
    "medium",
    "high",
    "critical",
  ]);

  const validRiskScores = new Set([10, 35, 60, 90]);

  if (!validRiskLevels.has(completion.value.riskLevel)) {
    throw new Error("Schema preflight returned an invalid riskLevel.");
  }

  if (!validRiskScores.has(completion.value.riskScore)) {
    throw new Error("Schema preflight returned an invalid riskScore.");
  }

  printJson(completion.value);
  console.log("REQUIRED_FIELDS_SCHEMA_PREFLIGHT_PASSED");
}

function cleanOrchestratorEnvironment() {
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
    WORKER_ORCHESTRATOR_FORCE_REMASK: "1",

    WORKER_ORCHESTRATOR_SHADOW_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_SHADOW_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_SHADOW_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_SHADOW_REQUIRED: "1",

    WORKER_ORCHESTRATOR_ADMIN_MODE: "always",
    WORKER_ORCHESTRATOR_ADMIN_UPSTREAM_URL: ENDPOINT,
    WORKER_ORCHESTRATOR_ADMIN_MODEL_ID: MODEL,
    WORKER_ORCHESTRATOR_ADMIN_TIMEOUT_MS: "300000",
    WORKER_ORCHESTRATOR_ADMIN_REQUIRED: "1",

    WORKER_ORCHESTRATOR_OUT_DIR: OUT_DIR,
  });

  return env;
}

function prepareOutputPaths() {
  fs.rmSync(OUT_DIR, {
    recursive: true,
    force: true,
  });

  fs.mkdirSync(OUT_DIR, {
    recursive: true,
  });

  fs.mkdirSync(path.dirname(CAPTURE_PATH), {
    recursive: true,
  });

  fs.writeFileSync(CAPTURE_PATH, "", "utf8");
}

function runOrchestrator() {
  printHeading("FORCED-REMASK LIVE ORCHESTRATOR");

  const result = spawnSync(
    process.execPath,
    ["scripts/worker-backed-orchestrator-smoke.cjs"],
    {
      cwd: ROOT,
      env: cleanOrchestratorEnvironment(),
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    },
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "wrapper-stdout.log"),
    result.stdout ?? "",
    "utf8",
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "wrapper-stderr.log"),
    result.stderr ?? "",
    "utf8",
  );

  console.log(`ORCHESTRATOR_EXIT=${result.status}`);

  if (result.error) {
    console.log(`ORCHESTRATOR_SPAWN_ERROR=${result.error.message}`);
  }

  if (result.signal) {
    console.log(`ORCHESTRATOR_SIGNAL=${result.signal}`);
  }

  console.log();
  console.log("ORCHESTRATOR OUTPUT TAIL");
  console.log("-".repeat(100));
  console.log(tail(result.stdout, 60));

  if (result.stderr) {
    console.log();
    console.log("ORCHESTRATOR STDERR TAIL");
    console.log("-".repeat(100));
    console.log(tail(result.stderr, 40));
  }

  return result;
}

function findLatestReport() {
  const candidates = fs
    .readdirSync(OUT_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(OUT_DIR, name);
      return {
        filePath,
        modified: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.modified - left.modified);

  if (candidates.length === 0) {
    throw new Error(`No JSON report was produced in ${OUT_DIR}.`);
  }

  return candidates[0].filePath;
}

function summarizeReport(reportPath) {
  const report = JSON.parse(
    fs.readFileSync(reportPath, "utf8"),
  );

  const summary = {
    reportPath,
    run: {
      ok: report.ok ?? null,
      status: report.status ?? null,
      finalDecision: report.finalDecision ?? null,
      workflowRoute: report.workflowRoute ?? null,
    },
    phaseV: {
      decision:
        section(report, "tempWorkspaceExecution").decision ?? null,
      cleanupPerformed:
        section(report, "tempWorkspaceExecution").cleanupPerformed ??
        null,
      passedCommands:
        section(report, "tempWorkspaceExecution").passedCommands ??
        null,
      failedCommands:
        section(report, "tempWorkspaceExecution").failedCommands ??
        null,
    },
    shadow: {
      called:
        section(report, "shadowObserver").called ?? null,
      decision:
        section(report, "shadowObserver").decision ?? null,
      validationDecision:
        section(report, "shadowObserver").validationDecision ?? null,
      riskLevel:
        section(report, "shadowObserver").riskLevel ?? null,
      riskScore:
        section(report, "shadowObserver").riskScore ?? null,
      recommendation:
        section(report, "shadowObserver").recommendation ?? null,
      requiredSatisfied:
        section(report, "shadowObserver").requiredSatisfied ?? null,
      issueCodes:
        section(report, "shadowObserver").issueCodes ?? [],
    },
    governance: {
      decision:
        section(report, "governance").decision ?? null,
      riskClass:
        section(report, "governance").riskClass ?? null,
    },
    admin: {
      called:
        section(report, "adminAgent").called ?? null,
      decision:
        section(report, "adminAgent").decision ?? null,
      validationDecision:
        section(report, "adminAgent").validationDecision ?? null,
      riskLevel:
        section(report, "adminAgent").riskLevel ?? null,
      riskScore:
        section(report, "adminAgent").riskScore ?? null,
      requiredSatisfied:
        section(report, "adminAgent").requiredSatisfied ?? null,
      issueCodes:
        section(report, "adminAgent").issueCodes ?? [],
    },
    router: {
      route:
        section(report, "approvalRouter").route ?? null,
      authorityPreserved:
        section(report, "approvalRouter")
          .deterministicAuthorityPreserved ?? null,
    },
    artifact: {
      decision:
        section(report, "governedChangeArtifact").decision ?? null,
      built:
        section(report, "governedChangeArtifact").artifactBuilt ??
        null,
      applyEligible:
        section(report, "governedChangeArtifact").applyEligible ??
        null,
    },
  };

  printHeading("LIVE REPORT SUMMARY");
  printJson(summary);

  return {
    report,
    summary,
  };
}

function captureRole(request) {
  if (
    !request ||
    typeof request !== "object" ||
    !Array.isArray(request.messages) ||
    !request.messages[0] ||
    typeof request.messages[0].content !== "string"
  ) {
    return null;
  }

  const system = request.messages[0].content.toLowerCase();

  if (system.includes("shadow observer")) {
    return "SHADOW";
  }

  if (system.includes("admin agent")) {
    return "ADMIN";
  }

  return null;
}

function analyzeCaptures() {
  if (!fs.existsSync(CAPTURE_PATH)) {
    throw new Error(`Capture file does not exist: ${CAPTURE_PATH}`);
  }

  const lines = fs
    .readFileSync(CAPTURE_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const roleResults = {
    SHADOW: null,
    ADMIN: null,
  };

  lines.forEach((line, index) => {
    const event = JSON.parse(line);
    const role = captureRole(event.request);

    if (role === null) {
      return;
    }

    const response = event.response;
    const choice =
      response &&
      Array.isArray(response.choices) &&
      response.choices[0]
        ? response.choices[0]
        : {};

    const content =
      choice &&
      choice.message &&
      typeof choice.message.content === "string"
        ? choice.message.content
        : null;

    const schema =
      event.request &&
      event.request.response_format &&
      event.request.response_format.schema
        ? event.request.response_format.schema
        : {};

    printHeading(`${role} — CAPTURE REQUEST ${index + 1}`);

    console.log(`HTTP status: ${event.status ?? null}`);
    console.log(`finish_reason: ${choice.finish_reason ?? null}`);
    console.log(`schema has oneOf: ${"oneOf" in schema}`);
    console.log(
      `required fields: ${JSON.stringify(schema.required ?? [])}`,
    );

    console.log();
    console.log("RAW COMPLETION");
    console.log("-".repeat(100));
    console.log(content);

    let parsed = null;
    let parseError = null;
    let missing = [];
    let unexpected = [];

    if (typeof content === "string") {
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        parseError = error.message;
      }
    } else {
      parseError = "Completion content is not a string.";
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const expected = new Set(schema.required ?? []);
      const actual = new Set(Object.keys(parsed));

      missing = [...expected].filter((key) => !actual.has(key));
      unexpected = [...actual].filter((key) => !expected.has(key));
    }

    console.log();
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Unexpected fields: ${JSON.stringify(unexpected)}`);

    if (parseError !== null) {
      console.log(`Parse error: ${parseError}`);
    }

    roleResults[role] = {
      status: event.status ?? null,
      finishReason: choice.finish_reason ?? null,
      schemaHasOneOf: "oneOf" in schema,
      parsed,
      parseError,
      missing,
      unexpected,
      shapeValid:
        parseError === null &&
        missing.length === 0 &&
        unexpected.length === 0,
    };
  });

  if (roleResults.SHADOW === null) {
    throw new Error("No Shadow capture was found.");
  }

  if (roleResults.ADMIN === null) {
    throw new Error("No Admin capture was found.");
  }

  return roleResults;
}

function verifyRepositoryClean() {
  const status = spawnSync(
    "git",
    ["status", "--short"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  const diffCheck = spawnSync(
    "git",
    ["diff", "--check"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  const revision = spawnSync(
    "git",
    ["rev-parse", "--short", "HEAD"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  const clean =
    status.status === 0 &&
    status.stdout.trim() === "" &&
    diffCheck.status === 0;

  printHeading("REPOSITORY SAFETY");

  console.log(`HEAD=${revision.stdout.trim()}`);
  console.log(`WORKTREE_CLEAN=${clean}`);

  if (status.stdout.trim() !== "") {
    console.log(status.stdout);
  }

  if (diffCheck.stdout.trim() !== "") {
    console.log(diffCheck.stdout);
  }

  return clean;
}

async function main() {
  printHeading("SERVICE HEALTH");

  await checkHealth("llama-server", LLAMA_HEALTH_URL);
  await checkHealth("capture-proxy", PROXY_HEALTH_URL);

  await runRequiredFieldsPreflight();

  prepareOutputPaths();

  const orchestrator = runOrchestrator();
  const reportPath = findLatestReport();
  const { summary } = summarizeReport(reportPath);
  const captures = analyzeCaptures();
  const repositoryClean = verifyRepositoryClean();

  const success =
    summary.phaseV.decision === "temp_validation_passed" &&
    summary.phaseV.cleanupPerformed === true &&
    summary.shadow.validationDecision ===
      "shadow_observation_valid" &&
    summary.shadow.requiredSatisfied === true &&
    summary.admin.validationDecision ===
      "admin_decision_valid" &&
    summary.admin.requiredSatisfied === true &&
    summary.router.authorityPreserved === true &&
    captures.SHADOW.shapeValid === true &&
    captures.ADMIN.shapeValid === true &&
    repositoryClean === true;

  printHeading("FINAL RESULT");

  printJson({
    success,
    orchestratorExit: orchestrator.status,
    phaseVDecision: summary.phaseV.decision,
    shadowValidation: summary.shadow.validationDecision,
    adminValidation: summary.admin.validationDecision,
    authorityPreserved: summary.router.authorityPreserved,
    shadowShapeValid: captures.SHADOW.shapeValid,
    adminShapeValid: captures.ADMIN.shapeValid,
    repositoryClean,
  });

  if (success) {
    console.log("LIVE_SHADOW_ADMIN_VALIDATION_PASSED");
    return;
  }

  console.log("LIVE_SHADOW_ADMIN_VALIDATION_FAILED");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error();
  console.error("LIVE_VALIDATION_SCRIPT_ERROR");
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
