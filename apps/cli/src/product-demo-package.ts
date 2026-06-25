import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createProductRuntimeArtifactV1,
  createTeamMetricsReport,
  parseUnifiedDiff,
  reviewPatch,
  type ReviewOutput
} from "../../../packages/product-runtime/src/index.js";
import { renderArtifactViewerHtml } from "../../web/src/index.js";
import { parsePolicy } from "./product-policy-utils.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime-demo";
const createdAt = new Date().toISOString();
const taskPath = args.task ?? "examples/product-runtime/tasks/repo-dogfood.md";
const diffPath = args.diff ?? "examples/product-runtime/diffs/repo-package-remask.diff";
const policyPath = args.policy ?? "bounded-agent.policy.yml";
const taskText = await readFile(taskPath, "utf8");
const review = reviewPatch({
  task: {
    id: "demo-real-pr-package",
    title: firstTitle(taskText) ?? "Demo real PR bounded review",
    description: taskText,
    authorityFacts: taskText
      .split("\n")
      .filter((line) => line.toLowerCase().includes("authority:"))
      .map((line) => line.trim())
  },
  diff: parseUnifiedDiff(await readFile(diffPath, "utf8")),
  policy: parsePolicy(await readFile(policyPath, "utf8"), policyPath)
});

await mkdir(outDir, { recursive: true });

const baseName = `${createdAt.replace(/[:.]/g, "-")}-product-review`;
const reviewJsonPath = join(outDir, `${baseName}.json`);
const reviewMarkdownPath = join(outDir, `${baseName}.md`);
const stableArtifactPath = join(outDir, "product-runtime-artifact-v1.json");
const commentPath = join(outDir, "pr-comment.md");
const indexJsonPath = join(outDir, "product-report-index.json");
const indexMarkdownPath = join(outDir, "product-report-index.md");
const teamMetricsJsonPath = join(outDir, "team-metrics.json");
const teamMetricsMarkdownPath = join(outDir, "team-metrics.md");
const viewerPath = join(outDir, "index.html");

await writeFile(reviewJsonPath, `${JSON.stringify(review, null, 2)}\n`);
await writeFile(reviewMarkdownPath, `${review.markdownReport}\n`);
await writeFile(stableArtifactPath, `${JSON.stringify(createProductRuntimeArtifactV1(review), null, 2)}\n`);
await writeFile(commentPath, `${createPrComment(review, reviewJsonPath)}\n`);

const reportIndex = {
  ok: true,
  reportDir: outDir,
  count: 1,
  reports: [
    {
      file: `${baseName}.json`,
      path: reviewJsonPath,
      decision: review.decision,
      riskLevel: review.riskLevel,
      changedFileCount: review.metrics.changedFileCount,
      findingCount: review.findings.length,
      remaskRegionCount: review.remaskRegions.length,
      repairProposalCount: review.repairProposals.length,
      markdownPath: reviewMarkdownPath
    }
  ]
};
await writeFile(indexJsonPath, `${JSON.stringify(reportIndex, null, 2)}\n`);
await writeFile(indexMarkdownPath, `${indexMarkdown(reportIndex)}\n`);

const teamMetrics = createTeamMetricsReport([{ ...review, createdAt }]);
await writeFile(teamMetricsJsonPath, `${JSON.stringify(teamMetrics, null, 2)}\n`);
await writeFile(teamMetricsMarkdownPath, `${teamMetrics.markdownReport}\n`);

await writeFile(viewerPath, `${renderArtifactViewerHtml({
  title: "Bounded Agent Demo Review",
  reviews: [{ fileName: `${baseName}.json`, review }],
  reportIndex,
  teamMetrics
})}\n`);

console.log(JSON.stringify({
  ok: true,
  decision: review.decision,
  riskLevel: review.riskLevel,
  outDir,
  reviewJsonPath,
  reviewMarkdownPath,
  stableArtifactPath,
  commentPath,
  indexJsonPath,
  indexMarkdownPath,
  teamMetricsJsonPath,
  teamMetricsMarkdownPath,
  viewerPath
}, null, 2));

function createPrComment(review: ReviewOutput, reviewPath: string): string {
  const findings = review.findings.length
    ? review.findings.map((finding) => `- **${finding.category}**: ${finding.message}`).join("\n")
    : "- No configured verifier findings.";
  return [
    "<!-- bounded-agent-review -->",
    "",
    "## Bounded Agent Review",
    "",
    `**Decision:** \`${review.decision}\``,
    `**Risk:** \`${review.riskLevel}\``,
    `**Changed files:** ${review.metrics.changedFileCount}`,
    `**Findings:** ${review.findings.length}`,
    "",
    "### Findings",
    "",
    findings,
    "",
    `<sub>Full JSON artifact: ${reviewPath}</sub>`
  ].join("\n");
}

function indexMarkdown(index: typeof reportIndex): string {
  return [
    "# Product Runtime Demo Index",
    "",
    `- Report directory: ${index.reportDir}`,
    `- Report count: ${index.count}`,
    "",
    "| Decision | Risk | Changed | Findings | Remask | Repairs | Artifact |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...index.reports.map((row) => `| ${row.decision} | ${row.riskLevel} | ${row.changedFileCount} | ${row.findingCount} | ${row.remaskRegionCount} | ${row.repairProposalCount} | ${row.path} |`)
  ].join("\n");
}

function firstTitle(content: string): string | undefined {
  return content.split("\n").find((line) => line.trim().length > 0)?.replace(/^#+\s*/, "");
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Bounded Agent Demo Package

Usage:
  npm run product:demo-package

Options:
  --task <path>      Task markdown/json path.
  --diff <path>      Unified diff path.
  --policy <path>    Policy path.
  --out-dir <path>   Output directory. Default: reports/product-runtime-demo
  --help             Show this help.
`);
}
