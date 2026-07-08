const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-p-worker-backed-orchestrator-smoke";

const fixture = {
  caseId: "phase-p-orchestrator-safe-helper",
  task: "Plan and draft a bounded change to add a small helper function.",
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "infra/prod.tf", "secrets.json"],
  proposedGoal: "Add an addOne helper function without touching unrelated files."
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
  return {
    upstreamUrl: process.env.WORKER_ORCHESTRATOR_UPSTREAM_URL || "",
    modelId: process.env.WORKER_ORCHESTRATOR_MODEL_ID || "qwen2.5-coder-7b",
    timeoutMs: readIntegerEnv("WORKER_ORCHESTRATOR_TIMEOUT_MS", 120000),
    plannerMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_PLANNER_MAX_TOKENS", 256),
    coderMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_CODER_MAX_TOKENS", 512),
    required: process.env.WORKER_ORCHESTRATOR_REQUIRED === "1",
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

function baseReport(config, status) {
  const finalDecision = status === "skipped" ? "skipped" : "blocked";

  return {
    ok: status === "skipped",
    status,
    suiteName: SUITE_NAME,
    caseId: fixture.caseId,
    modelId: config.modelId,
    configured: Boolean(config.upstreamUrl),
    finalDecision,
    orchestratorDecision: {
      finalDecision,
      reason: status === "skipped" ? "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured." : ""
    },
    planner: emptyRoleReport(),
    coder: emptyRoleReport(),
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

function renderMarkdown(report, config) {
  return [
    "# Worker-Backed Orchestrator Smoke",
    "",
    `- Suite: ${report.suiteName}`,
    `- Case: ${report.caseId}`,
    `- Configured endpoint: ${report.configured ? config.upstreamUrl : "not configured"}`,
    `- Model id: ${report.modelId}`,
    `- Status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Final decision: ${report.finalDecision}`,
    `- Decision reason: ${report.orchestratorDecision.reason}`,
    `- Planner called: ${report.planner.called}`,
    `- Planner validation OK: ${report.planner.validation.ok}`,
    `- Planner validation blocked: ${report.planner.validation.blocked}`,
    `- Coder called: ${report.coder.called}`,
    `- Coder validation OK: ${report.coder.validation.ok}`,
    `- Coder validation blocked: ${report.coder.validation.blocked}`,
    `- Planner mutation summary: ${mutationSummary(report.planner.validation)}`,
    `- Coder mutation summary: ${mutationSummary(report.coder.validation)}`,
    `- Planner touched files: ${touchedFiles(report.planner.validation)}`,
    `- Coder touched files: ${touchedFiles(report.coder.validation)}`,
    "",
    "## Issues",
    "",
    validationIssuesMarkdown("planner", report.planner.validation),
    validationIssuesMarkdown("coder", report.coder.validation),
    "",
    "## Latency And Tokens",
    "",
    roleTokensMarkdown("planner", report.planner),
    roleTokensMarkdown("coder", report.coder),
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
  const reportWithPaths = {
    ...report,
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

function decide(plannerValidation, coderValidation) {
  if (!plannerValidation.ok) {
    return {
      finalDecision: "blocked",
      reason: "planner mutation validation failure"
    };
  }

  if (!coderValidation.ok) {
    return {
      finalDecision: "blocked",
      reason: "coder mutation validation failure"
    };
  }

  return {
    finalDecision: "ready_for_deterministic_verifier",
    reason: "planner and coder workspace mutations validated"
  };
}

async function run() {
  const config = configFromEnv();

  if (!config.upstreamUrl) {
    const status = config.required ? "failed_required_endpoint_missing" : "skipped";
    const report = baseReport(config, status);
    report.ok = !config.required;
    report.orchestratorDecision = {
      finalDecision: status,
      reason: "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured."
    };
    report.finalDecision = status;
    return writeReport(report, config);
  }

  const { validateModelWorkspaceMutation } = await loadValidator();
  const report = baseReport(config, "completed");

  try {
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

    if (!plannerValidation.ok) {
      report.ok = true;
      report.status = "completed";
      const decision = decide(plannerValidation, report.coder.validation);
      report.finalDecision = decision.finalDecision;
      report.orchestratorDecision = decision;
      return writeReport(report, config);
    }

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

    report.ok = true;
    report.status = "completed";
    const decision = decide(plannerValidation, coderValidation);
    report.finalDecision = decision.finalDecision;
    report.orchestratorDecision = decision;
  } catch (error) {
    report.ok = false;
    report.status = "failed";
    report.finalDecision = "blocked";
    report.orchestratorDecision = {
      finalDecision: "blocked",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

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
  buildPlannerMessages,
  decide,
  fixture,
  run
};
