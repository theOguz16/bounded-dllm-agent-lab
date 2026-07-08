const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SUITE_NAME = "phase-r-worker-backed-remask-smoke";

const fixture = {
  caseId: "phase-r-remask-missing-proposed-patch",
  task: "Repair a coder patchDraft that missed proposedPatch.",
  allowedFiles: ["packages/example/src/index.ts"],
  forbiddenFiles: [".env", "infra/prod.tf", "secrets.json"],
  originalPatchDraft: {
    role: "coder",
    target: "patchDraft",
    summary: "Draft addOne helper but missing proposedPatch.",
    claims: [
      {
        type: "patch_draft",
        file: "packages/example/src/index.ts",
        description: "Add exported addOne helper."
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.7
  },
  verifierFinding: {
    role: "verifier",
    target: "verifierFinding",
    summary: "Deterministic verifier returned needs_review for coder patchDraft.",
    claims: [
      {
        type: "deterministic_verifier_finding",
        decision: "needs_review",
        issues: [
          {
            code: "missing_proposed_patch",
            message: "patch_draft claim is missing proposedPatch",
            file: "packages/example/src/index.ts"
          }
        ]
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 1
  },
  remaskRequest: {
    role: "verifier",
    target: "remaskRequest",
    summary: "Request a bounded remask repair for coder patchDraft.",
    claims: [
      {
        type: "remask_request",
        reason: "deterministic_verifier_needs_review",
        repairableIssueCodes: ["missing_proposed_patch"],
        originalSummary: "Draft addOne helper but missing proposedPatch.",
        verifierSummary: "Deterministic verifier returned needs_review for coder patchDraft.",
        allowedFiles: ["packages/example/src/index.ts"],
        forbiddenFiles: [".env", "infra/prod.tf", "secrets.json"],
        maxRepairSteps: 3
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 1
  }
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
    upstreamUrl: process.env.WORKER_REMASK_UPSTREAM_URL || "",
    modelId: process.env.WORKER_REMASK_MODEL_ID || "qwen2.5-coder-7b",
    timeoutMs: readIntegerEnv("WORKER_REMASK_TIMEOUT_MS", 120000),
    maxTokens: readIntegerEnv("WORKER_REMASK_MAX_TOKENS", 512),
    required: process.env.WORKER_REMASK_REQUIRED === "1",
    outDir: process.env.WORKER_REMASK_OUT_DIR || path.join("reports", "worker-backed-remask-smoke")
  };
}

function buildRemaskMessages(testFixture = fixture) {
  const example = {
    role: "remask",
    target: "repairDraft",
    summary: "short repair draft summary",
    claims: [
      {
        type: "repair_draft",
        file: "packages/example/src/index.ts",
        description: "Add the missing proposedPatch for addOne helper.",
        proposedPatch: "export function addOne(value: number): number { return value + 1; }",
        addressesIssueCodes: ["missing_proposed_patch"]
      }
    ],
    touchedFiles: ["packages/example/src/index.ts"],
    confidence: 0.8
  };

  return [
    {
      role: "system",
      content: [
        "You are the remask role in a bounded shared-workspace agent runtime.",
        "Return exactly one JSON object matching WorkspaceMutation and nothing else.",
        "Do not include markdown.",
        "Do not include prose before or after JSON.",
        'The JSON role must be "remask".',
        'The JSON target must be "repairDraft".',
        "touchedFiles must stay inside allowedFiles.",
        "forbiddenFiles must not be touched.",
        "Do not modify files on disk.",
        "Do not produce a full repo diff.",
        "Do not restart the original task.",
        "Only repair the verifierFinding issues.",
        "Only produce a repairDraft workspace mutation.",
        "claims may include a proposedPatch string, but the caller will not apply it."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `CASE_ID: ${testFixture.caseId}`,
        `TASK: ${testFixture.task}`,
        `ALLOWED_FILES: ${testFixture.allowedFiles.join(", ")}`,
        `FORBIDDEN_FILES: ${testFixture.forbiddenFiles.join(", ")}`,
        `ORIGINAL_PATCH_DRAFT: ${JSON.stringify(testFixture.originalPatchDraft)}`,
        `VERIFIER_FINDING: ${JSON.stringify(testFixture.verifierFinding)}`,
        `REMASK_REQUEST: ${JSON.stringify(testFixture.remaskRequest)}`,
        "Required JSON shape:",
        JSON.stringify(example, null, 2)
      ].join("\n")
    }
  ];
}

function emptyRepairDraftChecks() {
  return {
    ok: false,
    issues: []
  };
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
    repairDraftChecks: emptyRepairDraftChecks(),
    jsonPath: "",
    markdownPath: ""
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairDraftClaims(mutation) {
  if (!mutation || !Array.isArray(mutation.claims)) {
    return [];
  }

  return mutation.claims.filter((claim) => isRecord(claim) && claim.type === "repair_draft");
}

function repairDraftProposedPatchPreview(mutation) {
  const claim = repairDraftClaims(mutation).find((candidate) => {
    return typeof candidate.proposedPatch === "string" && candidate.proposedPatch.length > 0;
  });

  return claim ? preview(claim.proposedPatch, 1000) : "";
}

function addRepairDraftCheckIssue(issues, code, message, pathValue) {
  issues.push({
    code,
    message,
    ...(pathValue ? { path: pathValue } : {})
  });
}

function checkRepairDraftMutation(mutation) {
  const issues = [];

  if (!mutation) {
    addRepairDraftCheckIssue(issues, "missing_mutation", "Validated mutation is missing.");
    return { ok: false, issues };
  }

  if (mutation.role !== "remask") {
    addRepairDraftCheckIssue(issues, "invalid_role", 'repairDraft mutation role must be "remask".', "role");
  }

  if (mutation.target !== "repairDraft") {
    addRepairDraftCheckIssue(
      issues,
      "invalid_target",
      'repairDraft mutation target must be "repairDraft".',
      "target"
    );
  }

  const claims = repairDraftClaims(mutation);
  if (claims.length === 0) {
    addRepairDraftCheckIssue(
      issues,
      "missing_repair_draft_claim",
      'repairDraft mutation must include at least one "repair_draft" claim.',
      "claims"
    );
  }

  const touchedFiles = new Set(Array.isArray(mutation.touchedFiles) ? mutation.touchedFiles : []);

  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    const pathPrefix = `claims.${index}`;

    if (typeof claim.proposedPatch !== "string" || claim.proposedPatch.length === 0) {
      addRepairDraftCheckIssue(
        issues,
        "missing_proposed_patch",
        "repair_draft claim must include proposedPatch.",
        `${pathPrefix}.proposedPatch`
      );
    }

    if (
      !Array.isArray(claim.addressesIssueCodes) ||
      !claim.addressesIssueCodes.includes("missing_proposed_patch")
    ) {
      addRepairDraftCheckIssue(
        issues,
        "missing_addressed_issue_code",
        'repair_draft claim must address "missing_proposed_patch".',
        `${pathPrefix}.addressesIssueCodes`
      );
    }

    if (typeof claim.file !== "string" || !touchedFiles.has(claim.file)) {
      addRepairDraftCheckIssue(
        issues,
        "repair_file_outside_touched_files",
        "repair_draft claim file must be listed in touchedFiles.",
        `${pathPrefix}.file`
      );
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function validationIssuesMarkdown(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "No issues.";
  }

  return issues
    .map((issue) => `- ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
}

function renderMarkdown(report, config) {
  const mutation = report.validation.mutation;

  return [
    "# Worker-Backed Remask Smoke",
    "",
    `- Suite: ${report.suiteName}`,
    `- Case: ${report.caseId}`,
    `- Configured endpoint: ${report.configured ? config.upstreamUrl : "not configured"}`,
    `- Model id: ${report.modelId}`,
    `- Status: ${report.status}`,
    `- OK: ${report.ok}`,
    `- Validation OK: ${report.validation.ok}`,
    `- Validation blocked: ${report.validation.blocked}`,
    `- RepairDraft checks OK: ${report.repairDraftChecks.ok}`,
    `- Mutation summary: ${mutation ? mutation.summary : ""}`,
    `- Touched files: ${mutation ? mutation.touchedFiles.join(", ") : ""}`,
    `- Latency ms: ${report.latencyMs ?? ""}`,
    `- Prompt tokens: ${report.promptTokens ?? ""}`,
    `- Completion tokens: ${report.completionTokens ?? ""}`,
    `- Total tokens: ${report.totalTokens ?? ""}`,
    "",
    "## Validation Issues",
    "",
    validationIssuesMarkdown(report.validation.issues),
    "",
    "## RepairDraft Check Issues",
    "",
    validationIssuesMarkdown(report.repairDraftChecks.issues),
    "",
    "## RepairDraft ProposedPatch Preview",
    "",
    "```text",
    repairDraftProposedPatchPreview(mutation),
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
  const jsonPath = path.join(outDir, `${timestamp}-worker-backed-remask-smoke.json`);
  const markdownPath = path.join(outDir, `${timestamp}-worker-backed-remask-smoke.md`);
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
      throw new Error(`Remask endpoint returned HTTP ${response.status}: ${preview(text, 500)}`);
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
        message: "WORKER_REMASK_UPSTREAM_URL is not configured."
      }
    ];
    return writeReport(report, config);
  }

  const messages = buildRemaskMessages(fixture);
  const { validateModelWorkspaceMutation } = await loadValidator();
  const report = baseReport(config, "completed");

  try {
    const { latencyMs, data } = await callOpenAiCompatibleEndpoint(config, messages);
    const rawOutput = extractContent(data);
    const usage = tokenUsage(data);
    const validation = validateModelWorkspaceMutation(rawOutput, {
      role: "remask",
      allowedFiles: fixture.allowedFiles,
      forbiddenFiles: fixture.forbiddenFiles
    });
    const repairDraftChecks = validation.ok
      ? checkRepairDraftMutation(validation.mutation)
      : emptyRepairDraftChecks();

    report.latencyMs = latencyMs;
    report.promptTokens = usage.promptTokens;
    report.completionTokens = usage.completionTokens;
    report.totalTokens = usage.totalTokens;
    report.rawOutputPreview = preview(rawOutput);
    report.validation = validation;
    report.repairDraftChecks = repairDraftChecks;
    report.ok = validation.ok && repairDraftChecks.ok;
    report.status = validation.ok
      ? repairDraftChecks.ok
        ? "completed"
        : "repair_draft_check_failed"
      : "validation_blocked";
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
    report.repairDraftChecks = emptyRepairDraftChecks();
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
  buildRemaskMessages,
  checkRepairDraftMutation,
  emptyRepairDraftChecks,
  fixture,
  run
};
