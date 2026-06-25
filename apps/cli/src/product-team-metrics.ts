import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTeamMetricsReport,
  type ReviewOutput,
  type TeamMetricArtifact
} from "../../../packages/product-runtime/src/index.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const reportDir = args.dir ?? "reports/product-runtime";
const outDir = args["out-dir"] ?? reportDir;
const files = (await readdir(reportDir).catch(() => []))
  .filter((file) => file.endsWith("-product-review.json"))
  .sort();
const artifacts: TeamMetricArtifact[] = [];

for (const file of files) {
  const path = join(reportDir, file);
  const review = JSON.parse(await readFile(path, "utf8")) as ReviewOutput;
  artifacts.push({
    decision: review.decision,
    riskLevel: review.riskLevel,
    metrics: review.metrics,
    findings: review.findings,
    remaskRegions: review.remaskRegions,
    workspace: review.workspace,
    createdAt: file.slice(0, 10)
  });
}

const report = createTeamMetricsReport(artifacts);
const jsonPath = join(outDir, "team-metrics.json");
const markdownPath = join(outDir, "team-metrics.md");

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, `${report.markdownReport}\n`);

console.log(JSON.stringify({
  ok: true,
  count: artifacts.length,
  jsonPath,
  markdownPath
}, null, 2));

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
  console.log(`Bounded Agent Team Metrics

Usage:
  npm run product:team-metrics -- --dir reports/product-runtime

Options:
  --dir <path>      Directory containing product review JSON artifacts.
  --out-dir <path>  Output directory for team metrics JSON/Markdown.
  --help            Show this help.
`);
}
