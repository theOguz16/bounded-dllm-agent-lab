import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ModelKind = "llm" | "dllm";
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchResponse>;

type WorkerResult = {
  kind: ModelKind;
  modelId: string;
  configured: boolean;
  ok: boolean;
  status: "completed" | "skipped" | "failed";
  decision: string | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  failureReason: string | null;
};

const reportName = "model-worker-acceptance-report-v1";
const suiteName = "phase-k-real-model-worker-acceptance";
const createdAt = new Date().toISOString();
const reportDir = "reports/model-worker-acceptance";
const required = isTruthy(process.env.MODEL_ACCEPTANCE_REQUIRED);

main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reportName,
        suiteName,
        status: "failed",
        failureReason: error instanceof Error ? error.message : "unknown_error"
      },
      null,
      2
    )
  );
  process.exit(1);
});

async function main(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const results = await Promise.all([runWorker("llm"), runWorker("dllm")]);
  const configured = results.filter((result) => result.configured);
  const failed = results.filter((result) => result.status === "failed");

  const ok = required
    ? configured.length === 2 && failed.length === 0
    : failed.length === 0;

  const status = configured.length === 0 ? "skipped" : ok ? "completed" : "failed";
  const latencyValues = configured
    .map((result) => result.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const costValues = configured
    .map((result) => result.estimatedCostUsd)
    .filter((value): value is number => typeof value === "number");

  const report = {
    ok,
    reportName,
    suiteName,
    createdAt,
    status,
    required,
    configuredWorkerCount: configured.length,
    skippedWorkerCount: results.filter((result) => result.status === "skipped").length,
    failedWorkerCount: failed.length,
    averageLatencyMs: latencyValues.length ? round(mean(latencyValues), 2) : null,
    totalEstimatedCostUsd: costValues.length ? round(sum(costValues), 8) : null,
    results,
    notes: [
      configured.length === 0
        ? "No LLM_WORKER_URL or DLLM_WORKER_URL configured; real model acceptance skipped."
        : "Configured worker endpoints were evaluated.",
      "Set MODEL_ACCEPTANCE_REQUIRED=1 to make missing or failing workers fail the command.",
      "Cost is estimated only when token usage and pricing env vars are available."
    ]
  };

  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const jsonPath = join(reportDir, `${safeTimestamp}-model-worker-acceptance-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-model-worker-acceptance-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, toMarkdown(report));

  const output = { ...report, jsonPath, markdownPath };

  if (!ok) {
    console.error(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(output, null, 2));
}

async function runWorker(kind: ModelKind): Promise<WorkerResult> {
  const upper = kind.toUpperCase();
  const url = process.env[`${upper}_WORKER_URL`] ?? "";
  const modelId = process.env[`${upper}_MODEL_ID`] ?? `${kind}-worker`;

  if (!url) {
    return {
      kind,
      modelId,
      configured: false,
      ok: !required,
      status: "skipped",
      decision: null,
      latencyMs: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      failureReason: "worker_url_missing"
    };
  }

  const fetchFn = (globalThis as typeof globalThis & { fetch?: FetchFn }).fetch;
  if (!fetchFn) {
    return failed(kind, modelId, "fetch_not_available", null);
  }

  const startedAt = Date.now();

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MODEL_WORKER_API_KEY
          ? { authorization: `Bearer ${process.env.MODEL_WORKER_API_KEY}` }
          : {})
      },
      body: JSON.stringify({
        task: "phase-k-direct-worker-baseline-acceptance",
        modelKind: kind,
        modelId,
        prompt:
          "Return compact JSON with decision: approve | needs_review | reject, summary, and optional usage."
      })
    });

    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    const parsed = parseJson(text);
    const decision = readString(parsed, "decision") ?? readString(parsed, "result.decision");
    const promptTokens = readNumber(parsed, "usage.promptTokens") ?? readNumber(parsed, "usage.prompt_tokens");
    const completionTokens =
      readNumber(parsed, "usage.completionTokens") ?? readNumber(parsed, "usage.completion_tokens");
    const totalTokens =
      readNumber(parsed, "usage.totalTokens") ??
      readNumber(parsed, "usage.total_tokens") ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
    const estimatedCostUsd = estimateCost(promptTokens, completionTokens);

    if (!response.ok) {
      return failed(kind, modelId, `http_${response.status}`, latencyMs);
    }

    if (!decision || !["approve", "needs_review", "reject"].includes(decision)) {
      return failed(kind, modelId, "missing_or_invalid_decision", latencyMs);
    }

    return {
      kind,
      modelId,
      configured: true,
      ok: true,
      status: "completed",
      decision,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd,
      failureReason: null
    };
  } catch (error) {
    return failed(kind, modelId, error instanceof Error ? error.message : "worker_error", Date.now() - startedAt);
  }
}

function failed(kind: ModelKind, modelId: string, reason: string, latencyMs: number | null): WorkerResult {
  return {
    kind,
    modelId,
    configured: true,
    ok: false,
    status: "failed",
    decision: null,
    latencyMs,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
    failureReason: reason
  };
}

function estimateCost(promptTokens: number | null, completionTokens: number | null): number | null {
  const inputPrice = parseOptionalNumber(process.env.MODEL_INPUT_USD_PER_1M_TOKENS);
  const outputPrice = parseOptionalNumber(process.env.MODEL_OUTPUT_USD_PER_1M_TOKENS);

  if (promptTokens === null || completionTokens === null || inputPrice === null || outputPrice === null) {
    return null;
  }

  return round((promptTokens / 1_000_000) * inputPrice + (completionTokens / 1_000_000) * outputPrice, 8);
}

function toMarkdown(report: {
  reportName: string;
  suiteName: string;
  createdAt: string;
  status: string;
  required: boolean;
  configuredWorkerCount: number;
  skippedWorkerCount: number;
  failedWorkerCount: number;
  averageLatencyMs: number | null;
  totalEstimatedCostUsd: number | null;
  results: WorkerResult[];
  notes: string[];
}): string {
  const lines = [
    "# Model Worker Acceptance Report",
    "",
    `- Report: \`${report.reportName}\``,
    `- Suite: \`${report.suiteName}\``,
    `- Created at: \`${report.createdAt}\``,
    `- Status: \`${report.status}\``,
    `- Required: \`${report.required}\``,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Configured workers | ${report.configuredWorkerCount} |`,
    `| Skipped workers | ${report.skippedWorkerCount} |`,
    `| Failed workers | ${report.failedWorkerCount} |`,
    `| Average latency ms | ${report.averageLatencyMs ?? "(n/a)"} |`,
    `| Total estimated cost USD | ${report.totalEstimatedCostUsd ?? "(n/a)"} |`,
    "",
    "## Results",
    "",
    "| Kind | Model | Status | Decision | Latency ms | Total tokens | Estimated cost USD | Failure |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- |"
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.kind} | ${result.modelId} | ${result.status} | ${result.decision ?? "(none)"} | ${result.latencyMs ?? "(n/a)"} | ${result.totalTokens ?? "(n/a)"} | ${result.estimatedCostUsd ?? "(n/a)"} | ${result.failureReason ?? "(none)"} |`
    );
  }

  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown> | null, path: string): string | null {
  const value = readPath(record, path);
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown> | null, path: string): number | null {
  const value = readPath(record, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPath(record: Record<string, unknown> | null, path: string): unknown {
  if (!record) return null;
  let cursor: unknown = record;

  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return sum(values) / values.length;
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
