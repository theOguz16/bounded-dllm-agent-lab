const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  buildRemaskMessages,
  checkRepairDraftMutation,
  emptyRepairDraftChecks
} = require("./worker-backed-remask-smoke.cjs");

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
    remaskMaxTokens: readIntegerEnv("WORKER_ORCHESTRATOR_REMASK_MAX_TOKENS", 512),
    forceRemask: process.env.WORKER_ORCHESTRATOR_FORCE_REMASK === "1",
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

function emptyVerifierReport() {
  return {
    called: false,
    forcedRemask: false,
    decision: null,
    ok: false,
    issueCount: 0,
    issues: [],
    finding: null
  };
}

function emptyRemaskReport() {
  return {
    called: false,
    requested: false,
    repairability: null,
    issueCount: 0,
    issues: [],
    request: null,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    rawOutputPreview: "",
    validation: null,
    repairDraftChecks: null
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
    forceRemask: config.forceRemask,
    finalDecision,
    orchestratorDecision: {
      finalDecision,
      reason: status === "skipped" ? "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured." : "",
      forcedRemask: config.forceRemask
    },
    planner: emptyRoleReport(),
    coder: emptyRoleReport(),
    verifier: emptyVerifierReport(),
    remask: emptyRemaskReport(),
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

function verifierFindingSummary(verifier) {
  return verifier && verifier.finding ? verifier.finding.summary : "";
}

function verifierIssuesMarkdown(verifier) {
  const issues = verifier && Array.isArray(verifier.issues) ? verifier.issues : [];

  if (issues.length === 0) {
    return "- verifier: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.path || issue.file ? ` (${[issue.path, issue.file].filter(Boolean).join(", ")})` : "";
      return `- verifier: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function forcedVerifierFindingMarkdown(verifier) {
  if (!verifier || !verifier.forcedRemask || !verifier.finding) {
    return "";
  }

  return [
    "",
    "### Forced Verifier Finding",
    "",
    "```json",
    JSON.stringify(verifier.finding, null, 2),
    "```"
  ].join("\n");
}

function remaskRequestSummary(remask) {
  return remask && remask.request ? remask.request.summary : "";
}

function remaskRequestTouchedFiles(remask) {
  return remask && remask.request ? remask.request.touchedFiles.join(", ") : "";
}

function remaskRepairDraftSummary(remask) {
  return remask && remask.validation && remask.validation.mutation
    ? remask.validation.mutation.summary
    : "";
}

function remaskRepairDraftTouchedFiles(remask) {
  return remask && remask.validation && remask.validation.mutation
    ? remask.validation.mutation.touchedFiles.join(", ")
    : "";
}

function remaskIssuesMarkdown(remask) {
  const issues = remask && Array.isArray(remask.issues) ? remask.issues : [];

  if (issues.length === 0) {
    return "- remask: No issues.";
  }

  return issues
    .map((issue) => {
      const location = issue.path || issue.file ? ` (${[issue.path, issue.file].filter(Boolean).join(", ")})` : "";
      return `- remask: ${issue.code}: ${issue.message}${location}`;
    })
    .join("\n");
}

function remaskValidationIssuesMarkdown(remask) {
  const validation = remask && remask.validation ? remask.validation : null;
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];

  if (issues.length === 0) {
    return "- remask validation: No issues.";
  }

  return issues
    .map((issue) => `- remask validation: ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
}

function remaskRepairDraftCheckIssuesMarkdown(remask) {
  const checks = remask && remask.repairDraftChecks ? remask.repairDraftChecks : null;
  const issues = checks && Array.isArray(checks.issues) ? checks.issues : [];

  if (issues.length === 0) {
    return "- remask repairDraft checks: No issues.";
  }

  return issues
    .map((issue) => `- remask repairDraft checks: ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`)
    .join("\n");
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
    `- Force remask mode: ${report.forceRemask}`,
    `- Planner called: ${report.planner.called}`,
    `- Planner validation OK: ${report.planner.validation.ok}`,
    `- Planner validation blocked: ${report.planner.validation.blocked}`,
    `- Coder called: ${report.coder.called}`,
    `- Coder validation OK: ${report.coder.validation.ok}`,
    `- Coder validation blocked: ${report.coder.validation.blocked}`,
    `- Verifier called: ${report.verifier.called}`,
    `- Verifier forced remask: ${report.verifier.forcedRemask}`,
    `- Verifier decision: ${report.verifier.decision ?? ""}`,
    `- Verifier issue count: ${report.verifier.issueCount}`,
    `- Remask called: ${report.remask.called}`,
    `- Remask requested: ${report.remask.requested}`,
    `- Remask repairability: ${report.remask.repairability ?? ""}`,
    `- Remask validation OK: ${report.remask.validation ? report.remask.validation.ok : ""}`,
    `- Remask validation blocked: ${report.remask.validation ? report.remask.validation.blocked : ""}`,
    `- RepairDraft checks OK: ${report.remask.repairDraftChecks ? report.remask.repairDraftChecks.ok : ""}`,
    `- Remask issue count: ${report.remask.issueCount}`,
    `- Planner mutation summary: ${mutationSummary(report.planner.validation)}`,
    `- Coder mutation summary: ${mutationSummary(report.coder.validation)}`,
    `- Planner touched files: ${touchedFiles(report.planner.validation)}`,
    `- Coder touched files: ${touchedFiles(report.coder.validation)}`,
    `- Verifier finding summary: ${verifierFindingSummary(report.verifier)}`,
    `- Remask request summary: ${remaskRequestSummary(report.remask)}`,
    `- RepairDraft summary: ${remaskRepairDraftSummary(report.remask)}`,
    "",
    "## Issues",
    "",
    validationIssuesMarkdown("planner", report.planner.validation),
    validationIssuesMarkdown("coder", report.coder.validation),
    verifierIssuesMarkdown(report.verifier),
    remaskIssuesMarkdown(report.remask),
    "",
    "## Verifier",
    "",
    `- Called: ${report.verifier.called}`,
    `- Decision: ${report.verifier.decision ?? ""}`,
    `- Issue count: ${report.verifier.issueCount}`,
    `- Finding summary: ${verifierFindingSummary(report.verifier)}`,
    "",
    "### Verifier Issues",
    "",
    verifierIssuesMarkdown(report.verifier),
    forcedVerifierFindingMarkdown(report.verifier),
    "",
    "## Remask",
    "",
    `- Called: ${report.remask.called}`,
    `- Requested: ${report.remask.requested}`,
    `- Repairability: ${report.remask.repairability ?? ""}`,
    `- Validation OK: ${report.remask.validation ? report.remask.validation.ok : ""}`,
    `- Validation blocked: ${report.remask.validation ? report.remask.validation.blocked : ""}`,
    `- RepairDraft checks OK: ${report.remask.repairDraftChecks ? report.remask.repairDraftChecks.ok : ""}`,
    `- Issue count: ${report.remask.issueCount}`,
    `- Request summary: ${remaskRequestSummary(report.remask)}`,
    `- RepairDraft summary: ${remaskRepairDraftSummary(report.remask)}`,
    `- Request touched files: ${remaskRequestTouchedFiles(report.remask)}`,
    `- RepairDraft touched files: ${remaskRepairDraftTouchedFiles(report.remask)}`,
    "",
    "### Remask Issues",
    "",
    remaskIssuesMarkdown(report.remask),
    remaskValidationIssuesMarkdown(report.remask),
    remaskRepairDraftCheckIssuesMarkdown(report.remask),
    "",
    "### Remask Raw Output Preview",
    "",
    "```text",
    report.remask.rawOutputPreview || "",
    "```",
    "",
    "## Latency And Tokens",
    "",
    roleTokensMarkdown("planner", report.planner),
    roleTokensMarkdown("coder", report.coder),
    roleTokensMarkdown("remask", report.remask),
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

async function loadDeterministicVerifierGate() {
  const gatePath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "deterministic-verifier-gate.js")
  );
  return import(gatePath.href);
}

async function loadRemaskRequestBuilder() {
  const builderPath = pathToFileURL(
    path.join(process.cwd(), "dist", "packages", "product-runtime", "src", "remask-request-builder.js")
  );
  return import(builderPath.href);
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

function finalDecisionForVerifierDecision(verifierDecision) {
  if (verifierDecision === "approve") {
    return "approved_by_deterministic_verifier";
  }

  if (verifierDecision === "needs_review") {
    return "needs_review_by_deterministic_verifier";
  }

  if (verifierDecision === "reject") {
    return "rejected_by_deterministic_verifier";
  }

  return "blocked_before_verifier";
}

function buildForcedRemaskVerifierResult(mutation) {
  const issues = [
    {
      code: "missing_proposed_patch",
      message: "Forced repairable issue for remask path smoke.",
      file: "packages/example/src/index.ts"
    }
  ];
  const finding = {
    role: "verifier",
    target: "verifierFinding",
    summary: "Forced repairable verifier finding for remask path smoke.",
    claims: [
      {
        type: "deterministic_verifier_finding",
        decision: "needs_review",
        issues
      }
    ],
    touchedFiles: mutation && Array.isArray(mutation.touchedFiles) ? mutation.touchedFiles : [],
    confidence: 1
  };

  return {
    ok: false,
    decision: "needs_review",
    issues,
    finding
  };
}

function decide(
  plannerValidation,
  coderValidation,
  verifierResult = null,
  remaskResult = null,
  remaskReport = null,
  options = {}
) {
  if (!plannerValidation.ok) {
    return {
      finalDecision: "blocked_before_coder",
      reason: "planner validation failure blocked coder execution"
    };
  }

  if (!coderValidation.ok) {
    return {
      finalDecision: "blocked_before_verifier",
      reason: "coder validation failure blocked deterministic verifier execution"
    };
  }

  if (verifierResult) {
    const remaskRequested = Boolean(remaskResult && remaskResult.remaskRequest);
    const remaskValidationOk =
      remaskReport && remaskReport.validation ? Boolean(remaskReport.validation.ok) : null;
    const repairDraftChecksOk =
      remaskReport && remaskReport.repairDraftChecks
        ? Boolean(remaskReport.repairDraftChecks.ok)
        : null;
    const finalDecision =
      verifierResult.decision === "needs_review" && remaskRequested && remaskReport && remaskReport.called
        ? remaskValidationOk && repairDraftChecksOk
          ? "repair_draft_ready"
          : "remask_repair_failed"
        : verifierResult.decision === "needs_review" && remaskRequested
          ? "remask_requested"
        : finalDecisionForVerifierDecision(verifierResult.decision);

    return {
      finalDecision,
      reason: `deterministic verifier decision: ${verifierResult.decision}`,
      verifierDecision: verifierResult.decision,
      verifierIssueCount: Array.isArray(verifierResult.issues) ? verifierResult.issues.length : 0,
      remaskRequested,
      remaskRepairability: remaskResult ? remaskResult.repairability : null,
      remaskValidationOk,
      repairDraftChecksOk,
      forcedRemask: Boolean(options.forcedRemask)
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
      reason: "WORKER_ORCHESTRATOR_UPSTREAM_URL is not configured.",
      forcedRemask: config.forceRemask
    };
    report.finalDecision = status;
    return writeReport(report, config);
  }

  const { validateModelWorkspaceMutation } = await loadValidator();
  const { verifyPatchDraftMutation } = await loadDeterministicVerifierGate();
  const { buildRemaskRequestFromVerifierFinding } = await loadRemaskRequestBuilder();
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

    let verifierResult = null;
    let remaskResult = null;
    if (coderValidation.ok) {
      verifierResult = config.forceRemask
        ? buildForcedRemaskVerifierResult(coderValidation.mutation)
        : verifyPatchDraftMutation(coderValidation.mutation, {
          allowedFiles: fixture.allowedFiles,
          forbiddenFiles: fixture.forbiddenFiles,
          minConfidence: 0.5
        });
      report.verifier = {
        called: true,
        forcedRemask: config.forceRemask,
        decision: verifierResult.decision,
        ok: verifierResult.ok,
        issueCount: verifierResult.issues.length,
        issues: verifierResult.issues,
        finding: verifierResult.finding
      };

      if (verifierResult.decision === "needs_review") {
        remaskResult = buildRemaskRequestFromVerifierFinding(
          coderValidation.mutation,
          verifierResult.finding,
          {
            allowedFiles: fixture.allowedFiles,
            forbiddenFiles: fixture.forbiddenFiles,
            maxRepairSteps: 3
          }
        );
        report.remask = {
          called: false,
          requested: Boolean(remaskResult.remaskRequest),
          repairability: remaskResult.repairability,
          issueCount: remaskResult.issues.length,
          issues: remaskResult.issues,
          request: remaskResult.remaskRequest,
          latencyMs: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          rawOutputPreview: "",
          validation: null,
          repairDraftChecks: null
        };

        if (remaskResult.remaskRequest) {
          report.remask.called = true;
          try {
            const remaskResponse = await callOpenAiCompatibleEndpoint(
              config,
              buildRemaskMessages({
                ...fixture,
                originalPatchDraft: coderValidation.mutation,
                verifierFinding: verifierResult.finding,
                remaskRequest: remaskResult.remaskRequest
              }),
              config.remaskMaxTokens
            );
            const rawRemaskOutput = extractContent(remaskResponse.data);
            const remaskUsage = tokenUsage(remaskResponse.data);
            const remaskValidation = validateModelWorkspaceMutation(rawRemaskOutput, {
              role: "remask",
              allowedFiles: fixture.allowedFiles,
              forbiddenFiles: fixture.forbiddenFiles
            });
            const repairDraftChecks = remaskValidation.ok
              ? checkRepairDraftMutation(remaskValidation.mutation)
              : emptyRepairDraftChecks();

            report.remask.latencyMs = remaskResponse.latencyMs;
            report.remask.promptTokens = remaskUsage.promptTokens;
            report.remask.completionTokens = remaskUsage.completionTokens;
            report.remask.totalTokens = remaskUsage.totalTokens;
            report.remask.rawOutputPreview = preview(rawRemaskOutput);
            report.remask.validation = remaskValidation;
            report.remask.repairDraftChecks = repairDraftChecks;
          } catch (error) {
            report.remask.validation = {
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
            report.remask.repairDraftChecks = emptyRepairDraftChecks();
          }
        }
      }
    }

    report.ok = true;
    report.status = "completed";
    const decision = decide(
      plannerValidation,
      coderValidation,
      verifierResult,
      remaskResult,
      report.remask,
      { forcedRemask: config.forceRemask }
    );
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
  buildForcedRemaskVerifierResult,
  buildPlannerMessages,
  decide,
  emptyRemaskReport,
  emptyVerifierReport,
  fixture,
  finalDecisionForVerifierDecision,
  run
};
