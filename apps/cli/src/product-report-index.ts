import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewOutput } from "../../../packages/product-runtime/src/index.js";

type ReportIndexRow = {
  file: string;
  path: string;
  decision: ReviewOutput["decision"];
  riskLevel: ReviewOutput["riskLevel"];
  changedFileCount: number;
  findingCount: number;
  remaskRegionCount: number;
  repairProposalCount: number;
  markdownPath: string;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const reportDir = args.dir ?? "reports/product-runtime";
const outDir = args["out-dir"] ?? reportDir;
const files = await readdir(reportDir).catch(() => []);
const reviewFiles = files
  .filter((file) => file.endsWith("-product-review.json"))
  .sort();
const rows: ReportIndexRow[] = [];

for (const file of reviewFiles) {
  const path = join(reportDir, file);
  const review = JSON.parse(await readFile(path, "utf8")) as ReviewOutput;
  rows.push({
    file,
    path,
    decision: review.decision,
    riskLevel: review.riskLevel,
    changedFileCount: review.metrics.changedFileCount,
    findingCount: review.metrics.findingCount,
    remaskRegionCount: review.remaskRegions.length,
    repairProposalCount: review.repairProposals.length,
    markdownPath: path.replace(/\.json$/, ".md")
  });
}

const jsonPath = join(outDir, "product-report-index.json");
const markdownPath = join(outDir, "product-report-index.md");

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({ ok: true, reportDir, count: rows.length, reports: rows }, null, 2)}\n`);
await writeFile(markdownPath, `${toMarkdown(reportDir, rows)}\n`);

console.log(JSON.stringify({
  ok: true,
  reportDir,
  count: rows.length,
  jsonPath,
  markdownPath
}, null, 2));

function toMarkdown(reportDir: string, rows: ReportIndexRow[]): string {
  return [
    "# Product Runtime Report Index",
    "",
    `- Report directory: ${reportDir}`,
    `- Report count: ${rows.length}`,
    "",
    table(
      ["Decision", "Risk", "Changed", "Findings", "Remask", "Repairs", "Artifact"],
      rows.length
        ? rows.map((row) => [
            row.decision,
            row.riskLevel,
            row.changedFileCount.toString(),
            row.findingCount.toString(),
            row.remaskRegionCount.toString(),
            row.repairProposalCount.toString(),
            row.path
          ])
        : [["(none)", "(none)", "0", "0", "0", "0", "(none)"]]
    )
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`)
  ].join("\n");
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Bounded Agent Product Report Index

Usage:
  npm run product:report-index -- --dir reports/product-runtime

Options:
  --dir <path>      Directory containing product review JSON artifacts.
  --out-dir <path>  Output directory for index JSON/Markdown.
  --help            Show this help.
`);
}
