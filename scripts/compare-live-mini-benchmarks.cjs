const fs = require("fs");
const path = require("path");

function usage() {
  return [
    "Usage:",
    "  npm run report:compare-live-mini-benchmark -- <report-a.json> <report-b.json> [report-c.json ...]",
    "",
    "If no report paths are supplied, the script compares the latest live-mini-benchmark JSON files in reports/live-mini-benchmark.",
    "",
    "Environment:",
    "  LIVE_MINI_BENCHMARK_COMPARISON_OUT_DIR=reports/live-mini-benchmark-comparison"
  ].join("\n");
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON report ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureOutDir() {
  const outDir = path.resolve(process.cwd(), process.env.LIVE_MINI_BENCHMARK_COMPARISON_OUT_DIR || path.join("reports", "live-mini-benchmark-comparison"));
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function findDefaultReports() {
  const dir = path.resolve(process.cwd(), "reports", "live-mini-benchmark");

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter(fileName => fileName.endsWith(".json"))
    .map(fileName => path.join(dir, fileName))
    .map(filePath => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .map(entry => entry.filePath);
}

function parseArgs(argv) {
  const paths = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    paths.push(arg);
  }

  return paths.length > 0 ? paths : findDefaultReports();
}

function round(value, digits = 4) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }

  const formatted = (value * 100).toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
  return `${formatted}%`;
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(round(value));
  }

  return String(value);
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function decisionCount(summary, decision) {
  return Number(summary?.decisionCounts?.[decision] || 0);
}

function modelKey(summary) {
  return `${summary.kind}:${summary.modelId}`;
}

function normalizeModelSummary(summary) {
  const decisionCounts = summary.decisionCounts || {};

  return {
    kind: summary.kind || "unknown",
    modelId: summary.modelId || "unknown",
    key: modelKey(summary),
    configured: Boolean(summary.configured),
    resultCount: Number(summary.resultCount || 0),
    completedCount: Number(summary.completedCount || 0),
    failedCount: Number(summary.failedCount || 0),
    expectedMatchedCount: Number(summary.expectedMatchedCount || 0),
    expectedMatchRate: typeof summary.expectedMatchRate === "number" ? summary.expectedMatchRate : null,
    jsonComplianceCount: Number(summary.jsonComplianceCount || 0),
    jsonComplianceRate: typeof summary.jsonComplianceRate === "number" ? summary.jsonComplianceRate : null,
    averageLatencyMs: typeof summary.averageLatencyMs === "number" ? summary.averageLatencyMs : null,
    averagePromptTokens: typeof summary.averagePromptTokens === "number" ? summary.averagePromptTokens : null,
    averageCompletionTokens: typeof summary.averageCompletionTokens === "number" ? summary.averageCompletionTokens : null,
    averageTotalTokens: typeof summary.averageTotalTokens === "number" ? summary.averageTotalTokens : null,
    averageStrictness: typeof summary.averageStrictness === "number" ? summary.averageStrictness : null,
    decisionCounts,
    approveCount: decisionCount(summary, "approve"),
    needsReviewCount: decisionCount(summary, "needs_review"),
    rejectCount: decisionCount(summary, "reject"),
    unknownCount: decisionCount(summary, "unknown")
  };
}

function normalizeRun(report, sourcePath, index) {
  const summaries = Array.isArray(report.modelSummaries) ? report.modelSummaries.map(normalizeModelSummary) : [];
  const summaryByKey = Object.fromEntries(summaries.map(summary => [summary.key, summary]));

  return {
    runId: `run-${index + 1}`,
    sourcePath,
    createdAt: report.createdAt || null,
    reportName: report.reportName || null,
    suiteName: report.suiteName || null,
    status: report.status || null,
    ok: Boolean(report.ok),
    expectationsOk: Boolean(report.expectationsOk),
    modelCount: Number(report.modelCount || summaries.length || 0),
    caseCount: Number(report.caseCount || 0),
    resultCount: Number(report.resultCount || 0),
    modelSummaries: summaries,
    summaryByKey
  };
}

function deltaNumber(first, last) {
  if (typeof first !== "number" || typeof last !== "number") {
    return null;
  }

  return round(last - first);
}

function buildDeltas(runs) {
  if (runs.length < 2) {
    return [];
  }

  const first = runs[0];
  const last = runs[runs.length - 1];
  const keys = new Set([...Object.keys(first.summaryByKey), ...Object.keys(last.summaryByKey)]);
  const deltas = [];

  for (const key of [...keys].sort()) {
    const before = first.summaryByKey[key] || null;
    const after = last.summaryByKey[key] || null;

    if (!before || !after) {
      deltas.push({
        key,
        kind: after?.kind || before?.kind || "unknown",
        modelId: after?.modelId || before?.modelId || "unknown",
        status: before ? "missing_in_last" : "missing_in_first"
      });
      continue;
    }

    deltas.push({
      key,
      kind: after.kind,
      modelId: after.modelId,
      status: "compared",
      expectedMatchRateDelta: deltaNumber(before.expectedMatchRate, after.expectedMatchRate),
      jsonComplianceRateDelta: deltaNumber(before.jsonComplianceRate, after.jsonComplianceRate),
      averageLatencyMsDelta: deltaNumber(before.averageLatencyMs, after.averageLatencyMs),
      averageTotalTokensDelta: deltaNumber(before.averageTotalTokens, after.averageTotalTokens),
      unknownCountDelta: after.unknownCount - before.unknownCount,
      approveCountDelta: after.approveCount - before.approveCount,
      needsReviewCountDelta: after.needsReviewCount - before.needsReviewCount,
      rejectCountDelta: after.rejectCount - before.rejectCount
    });
  }

  return deltas;
}

function toMarkdown(comparison) {
  const runRows = comparison.runs.map(run => [
    run.runId,
    run.createdAt || "",
    path.relative(process.cwd(), run.sourcePath),
    run.status || "",
    run.ok ? "yes" : "no",
    run.expectationsOk ? "yes" : "no",
    run.caseCount,
    run.resultCount
  ]);

  const summaryRows = comparison.runs.flatMap(run => run.modelSummaries.map(summary => [
    run.runId,
    summary.kind,
    summary.modelId,
    summary.resultCount,
    summary.completedCount,
    summary.failedCount,
    asPercent(summary.expectedMatchRate),
    asPercent(summary.jsonComplianceRate),
    formatNumber(summary.averageLatencyMs),
    formatNumber(summary.averageTotalTokens),
    summary.approveCount,
    summary.needsReviewCount,
    summary.rejectCount,
    summary.unknownCount
  ]));

  const deltaRows = comparison.deltas.map(delta => [
    delta.kind,
    delta.modelId,
    delta.status,
    asPercent(delta.expectedMatchRateDelta),
    asPercent(delta.jsonComplianceRateDelta),
    formatNumber(delta.averageLatencyMsDelta),
    formatNumber(delta.averageTotalTokensDelta),
    formatNumber(delta.approveCountDelta),
    formatNumber(delta.needsReviewCountDelta),
    formatNumber(delta.rejectCountDelta),
    formatNumber(delta.unknownCountDelta)
  ]);

  return [
    "# Live Mini Benchmark Comparison",
    "",
    `Created at: ${comparison.createdAt}`,
    "",
    "## Compared runs",
    "",
    "| Run | Created at | Source | Status | OK | Expectations OK | Cases | Results |",
    "|---|---|---|---|---:|---:|---:|---:|",
    ...runRows.map(row => `| ${row.map(escapeMarkdown).join(" | ")} |`),
    "",
    "## Model summaries",
    "",
    "| Run | Kind | Model | Results | Completed | Failed | Expected match | JSON compliance | Avg latency ms | Avg tokens | Approve | Needs review | Reject | Unknown |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summaryRows.map(row => `| ${row.map(escapeMarkdown).join(" | ")} |`),
    "",
    "## First vs last delta",
    "",
    "| Kind | Model | Status | Expected match Δ | JSON compliance Δ | Latency ms Δ | Tokens Δ | Approve Δ | Needs review Δ | Reject Δ | Unknown Δ |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...deltaRows.map(row => `| ${row.map(escapeMarkdown).join(" | ")} |`),
    "",
    "## Interpretation hints",
    "",
    "- Positive JSON compliance delta means the model followed the structured output contract more often.",
    "- Negative unknown delta means fewer unparseable decisions.",
    "- This script compares benchmark contract behavior, not general model quality.",
    ""
  ].join("\n");
}

function writeComparison(comparison) {
  const outDir = ensureOutDir();
  const stamp = safeTimestamp(new Date(comparison.createdAt));
  const jsonPath = path.join(outDir, `${stamp}-live-mini-benchmark-comparison.json`);
  const markdownPath = path.join(outDir, `${stamp}-live-mini-benchmark-comparison.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(comparison, null, 2));
  fs.writeFileSync(markdownPath, toMarkdown(comparison));

  return { jsonPath, markdownPath };
}

function main() {
  const reportPaths = parseArgs(process.argv.slice(2));

  if (reportPaths.length < 2) {
    console.error(usage());
    console.error("");
    console.error(`Need at least 2 reports to compare; found ${reportPaths.length}.`);
    process.exit(1);
  }

  const resolvedPaths = reportPaths.map(reportPath => path.resolve(process.cwd(), reportPath));

  for (const reportPath of resolvedPaths) {
    if (!fs.existsSync(reportPath)) {
      throw new Error(`Report not found: ${reportPath}`);
    }
  }

  const runs = resolvedPaths.map((reportPath, index) => normalizeRun(readJson(reportPath), reportPath, index));
  const comparison = {
    ok: true,
    reportName: "live-mini-benchmark-comparison-v1",
    createdAt: new Date().toISOString(),
    runCount: runs.length,
    runs,
    deltas: buildDeltas(runs),
    notes: [
      "This report compares live-mini-benchmark model summaries across runs.",
      "Use it to compare O.1, O.3, O.5, or other live benchmark reruns.",
      "The comparison is based on benchmark contract metrics, not general model quality."
    ]
  };

  const paths = writeComparison(comparison);

  console.log(JSON.stringify({
    ok: true,
    runCount: comparison.runCount,
    jsonPath: paths.jsonPath,
    markdownPath: paths.markdownPath,
    deltas: comparison.deltas
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  normalizeModelSummary,
  normalizeRun,
  buildDeltas,
  toMarkdown
};
