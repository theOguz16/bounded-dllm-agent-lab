const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-p-worker-backed-coder-smoke";

const fixture = {
  caseId: "phase-p-coder-safe-helper",
  task: "Draft a bounded patch to add a small helper function.",
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "infra/prod.tf", "secrets.json"],
  plannerMutation: {
    role: "planner",
    target: "plan",
    summary: "Add a small addOne helper inside the allowed example module only.",
    claims: [
      {
        type: "planned_step",
        description: "Modify only packages/example/src/index.ts."
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  },
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
    upstreamUrl: process.env.WORKER_CODER_UPSTREAM_URL || "",
    modelId: process.env.WORKER_CODER_MODEL_ID || "qwen2.5-coder-7b",
    timeoutMs: readIntegerEnv("WORKER_CODER_TIMEOUT_MS", 120000),
    maxTokens: readIntegerEnv("WORKER_CODER_MAX_TOKENS", 512),
    required: process.env.WORKER_CODER_REQUIRED === "1",
    outDir: process.env.WORKER_CODER_OUT_DIR || path.join("reports", "worker-backed-coder-smoke")
  };
}

function buildCoderMessages(testFixture = fixture) {
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
        `PLANNER_MUTATION: ${JSON.stringify(testFixture.plannerMutation)}`,
        `ALLOWED_FILES: ${testFixture.allowedFiles.join(", ")}`,
        `FORBIDDEN_FILES: ${testFixture.forbiddenFiles.join(", ")}`,
        "Required JSON shape:",
        JSON.stringify(example, null, 2)
      ].join("\n")
    }
  ];
}

function baseReport(config, status) {
  return {
    ok: status === "skipped",
    status,
    suiteName: SUITE_NAME,
    caseId: fixture.caseId,
    modelId: config.modelId,
    configured: Boolean(config.upstreamUrl),
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
    },
    jsonPath: "",
    markdownPath: ""
  };
}

function patchDraftClaimPreview(mutation) {
  if (!mutation || !Array.isArray(mutation.claims)) {
    return "";
  }

  const patchClaim = mutation.claims.find((claim) => {
    return claim && typeof claim === "object" && claim.type === "patch_draft";
  });

  if (!patchClaim || typeof patchClaim !== "object") {
    return "";
  }

  return preview(patchClaim.proposedPatch || patchClaim.description || "", 1000);
}

function renderMarkdown(report, config) {
  const mutation = report.validation.mutation;
  const issues = report.validation.issues || [];
  const patchPreview = patchDraftClaimPreview(mutation);

  return [
    "# Worker-Backed Coder Smoke",
    "",
    `- Suite: ${report.suiteName}`,
    `- Case: ${report.caseId}`,
    `- Configured endpoint: ${report.configured ? config.upstreamUrl : "not configured"}`,
    `- Model id: ${report.modelId}`,
    `- Status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Validation OK: ${report.validation.ok}`,
    `- Validation blocked: ${report.validation.blocked}`,
    `- Mutation summary: ${mutation ? mutation.summary : ""}`,
    `- Touched files: ${mutation ? mutation.touchedFiles.join(", ") : ""}`,
    `- Latency ms: ${report.latencyMs ?? ""}`,
    `- Prompt tokens: ${report.promptTokens ?? ""}`,
    `- Completion tokens: ${report.completionTokens ?? ""}`,
    `- Total tokens: ${report.totalTokens ?? ""}`,
    "",
    "## Issues",
    "",
    issues.length === 0
      ? "No issues."
      : issues.map((issue) => `- ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`).join("\n"),
    "",
    "## PatchDraft Claim Preview",
    "",
    "```text",
    patchPreview,
    "```",
    "",
    "## Raw Output Preview",
    "",
    "```text",
    report.rawOutputPreview || "",
    "```",
    ""
  ].join("\n");
}

function writeReport(report, config) {
  const outDir = ensureDir(path.resolve(process.cwd(), config.outDir));
  const timestamp = safeTimestamp();
  const jsonPath = path.join(outDir, `${timestamp}-worker-backed-coder-smoke.json`);
  const markdownPath = path.join(outDir, `${timestamp}-worker-backed-coder-smoke.md`);
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

async function callOpenAiCompatibleEndpoint(config, messages) {
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
        max_tokens: config.maxTokens,
        messages
      })
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      throw new Error(`Coder endpoint returned HTTP ${response.status}: ${preview(text, 500)}`);
    }

    return {
      latencyMs,
      data: JSON.parse(text)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const config = configFromEnv();

  if (!config.upstreamUrl) {
    const status = config.required ? "failed_required_endpoint_missing" : "skipped";
    const report = baseReport(config, status);
    report.ok = !config.required;
    report.validation.issues = [
      {
        code: "invalid_shape",
        message: "WORKER_CODER_UPSTREAM_URL is not configured."
      }
    ];
    return writeReport(report, config);
  }

  const messages = buildCoderMessages(fixture);
  const { validateModelWorkspaceMutation } = await loadValidator();
  const report = baseReport(config, "completed");

  try {
    const { latencyMs, data } = await callOpenAiCompatibleEndpoint(config, messages);
    const rawOutput = extractContent(data);
    const usage = tokenUsage(data);
    const validation = validateModelWorkspaceMutation(rawOutput, {
      role: "coder",
      allowedFiles: fixture.allowedFiles,
      forbiddenFiles: fixture.forbiddenFiles
    });

    report.latencyMs = latencyMs;
    report.promptTokens = usage.promptTokens;
    report.completionTokens = usage.completionTokens;
    report.totalTokens = usage.totalTokens;
    report.rawOutputPreview = preview(rawOutput);
    report.validation = validation;
    report.ok = validation.ok;
    report.status = validation.ok ? "completed" : "validation_blocked";
  } catch (error) {
    report.ok = false;
    report.status = "failed";
    report.validation = {
      ok: false,
      blocked: true,
      issues: [
        {
          code: "invalid_shape",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      mutation: null
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
  fixture,
  run
};
