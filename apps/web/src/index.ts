import type { ReviewOutput, TeamMetricsReport } from "../../../packages/product-runtime/src/index.js";

export type ArtifactViewerIndex = {
  count: number;
  reports: Array<{
    file: string;
    path: string;
    decision: ReviewOutput["decision"];
    riskLevel: ReviewOutput["riskLevel"];
    changedFileCount: number;
    findingCount: number;
    remaskRegionCount: number;
    repairProposalCount: number;
    markdownPath: string;
  }>;
};

export type ArtifactViewerInput = {
  title?: string;
  reviews: Array<{ fileName: string; review: ReviewOutput }>;
  reportIndex?: ArtifactViewerIndex;
  teamMetrics?: TeamMetricsReport;
};

export const webStatus = {
  name: "bounded-dllm-agent-lab-web",
  status: "artifact-viewer-ready"
};

export function renderArtifactViewerHtml(input: ArtifactViewerInput): string {
  const title = input.title ?? "Bounded Agent Artifact Viewer";
  const reviews = [...input.reviews].sort((left, right) => left.fileName.localeCompare(right.fileName));
  const primary = reviews[0]?.review;
  const summaryCards = primary
    ? [
        card("Decision", primary.decision),
        card("Risk", primary.riskLevel),
        card("Findings", String(primary.findings.length)),
        card("Changed Files", String(primary.metrics.changedFileCount))
      ].join("")
    : card("Reports", "0");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${viewerCss()}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<header><p class="eyebrow">bounded runtime</p><h1>${escapeHtml(title)}</h1><p class="lede">Review decisions, workspace risks, remask requests and team metrics from product-runtime artifacts.</p></header>`,
    `<section class="summary">${summaryCards}</section>`,
    renderReports(reviews),
    renderTeamMetrics(input.teamMetrics),
    renderIndex(input.reportIndex),
    "</main>",
    "</body>",
    "</html>"
  ].join("\n");
}

function renderReports(reviews: ArtifactViewerInput["reviews"]): string {
  if (reviews.length === 0) {
    return '<section><h2>Review Reports</h2><p class="muted">No product review artifacts were found.</p></section>';
  }

  return [
    "<section>",
    "<h2>Review Reports</h2>",
    '<div class="report-list">',
    ...reviews.map(({ fileName, review }) => [
      '<article class="report">',
      `<div><h3>${escapeHtml(fileName)}</h3><p class="muted">${escapeHtml(review.workspace.id)}</p></div>`,
      `<p><strong>${escapeHtml(review.decision)}</strong> · ${escapeHtml(review.riskLevel)} risk · ${review.findings.length} findings</p>`,
      table(
        ["Category", "Severity", "Message"],
        review.findings.length
          ? review.findings.map((finding) => [finding.category, finding.severity, finding.message])
          : [["none", "info", "No configured verifier findings."]]
      ),
      review.repairProposals.length
        ? `<h4>Repair Proposals</h4><ul>${review.repairProposals.map((proposal) => `<li>${escapeHtml(proposal.kind)}: ${escapeHtml(proposal.summary)}</li>`).join("")}</ul>`
        : "",
      "</article>"
    ].join("\n")),
    "</div>",
    "</section>"
  ].join("\n");
}

function renderTeamMetrics(metrics?: TeamMetricsReport): string {
  if (!metrics) return "";
  return [
    "<section>",
    "<h2>Team Metrics</h2>",
    '<div class="summary">',
    card("AI Patches", String(metrics.aiPatchCount)),
    card("Remask Required", String(metrics.remaskRequiredCount)),
    card("Scope Drift", String(metrics.scopeDriftCount)),
    card("Avg Role View", String(metrics.averageRoleViewSize)),
    "</div>",
    table(
      ["Bucket", "Low", "Medium", "High"],
      metrics.riskTrend.map((bucket) => [bucket.bucket, String(bucket.low), String(bucket.medium), String(bucket.high)])
    ),
    "</section>"
  ].join("\n");
}

function renderIndex(index?: ArtifactViewerIndex): string {
  if (!index) return "";
  return [
    "<section>",
    "<h2>Artifact Index</h2>",
    table(
      ["Artifact", "Decision", "Risk", "Findings", "Repairs"],
      index.reports.map((row) => [
        row.file,
        row.decision,
        row.riskLevel,
        String(row.findingCount),
        String(row.repairProposalCount)
      ])
    ),
    "</section>"
  ].join("\n");
}

function card(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    "<table>",
    `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table>"
  ].join("");
}

function viewerCss(): string {
  return `
    :root { color-scheme: light; --ink: #17202a; --muted: #5b6572; --line: #d9dee5; --bg: #f7f8fa; --panel: #ffffff; --accent: #176b87; --warn: #a55b13; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    header { padding: 24px 0 18px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 32px; line-height: 1.15; letter-spacing: 0; }
    h2 { margin: 32px 0 12px; font-size: 22px; letter-spacing: 0; }
    h3 { margin: 0 0 4px; font-size: 17px; letter-spacing: 0; }
    h4 { margin: 18px 0 8px; }
    .eyebrow { margin: 0 0 8px; color: var(--accent); font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .lede { max-width: 760px; color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 18px 0; }
    .metric, .report { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric span { display: block; color: var(--muted); font-size: 13px; }
    .metric strong { display: block; margin-top: 6px; font-size: 22px; overflow-wrap: anywhere; }
    .report-list { display: grid; gap: 14px; }
    .muted { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; table-layout: fixed; }
    th, td { padding: 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { font-size: 12px; color: var(--muted); background: #eef2f5; }
    tr:last-child td { border-bottom: 0; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    @media (max-width: 640px) { main { width: min(100% - 20px, 1120px); padding-top: 18px; } h1 { font-size: 25px; } th, td { padding: 8px; font-size: 13px; } }
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
