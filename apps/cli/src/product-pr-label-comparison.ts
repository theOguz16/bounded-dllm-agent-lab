import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import type { RealPrPilotCase } from "./product-real-pr-pilot-fixtures.js";

type LabelOverride = {
  id: string;
  expectedDecision?: ReviewDecision;
  expectedFindingCategories?: Finding["category"][];
  humanReviewedBy?: string;
  reviewedAt?: string;
  reviewerNotes?: string[];
};

type ComparisonRow = {
  id: string;
  pullRequest: string;
  title: string;
  draftDecision: ReviewDecision;
  reviewedDecision: ReviewDecision;
  decisionChanged: boolean;
  draftFindings: Finding["category"][];
  reviewedFindings: Finding["category"][];
  findingsChanged: boolean;
  humanReviewed: boolean;
  reviewedBy: string;
  reviewedAt: string;
  note: string;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const inputPath = args.input ?? "examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json";
const overridesPath = args.overrides ?? "examples/product-runtime/real-pr-fixtures/nanoid-reviewed-label-overrides.json";
const outDir = args["out-dir"] ?? "reports/product-runtime";
const cases = JSON.parse(await readFile(inputPath, "utf8")) as RealPrPilotCase[];
const overrides = new Map(
  (JSON.parse(await readFile(overridesPath, "utf8")) as LabelOverride[]).map((override) => [override.id, override])
);
const createdAt = new Date().toISOString();
const rows = cases.map((testCase) => compareCase(testCase, overrides.get(testCase.id)));
const summary = createSummary(rows);
const baseName = `${createdAt.replace(/[:.]/g, "-")}-pr-label-comparison`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({
  ok: summary.unreviewedCount === 0,
  inputPath,
  overridesPath,
  createdAt,
  summary,
  rows
}, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(inputPath, overridesPath, createdAt, summary, rows)}\n`);

console.log(JSON.stringify({
  ok: summary.unreviewedCount === 0,
  inputPath,
  overridesPath,
  caseCount: summary.caseCount,
  decisionChangeCount: summary.decisionChangeCount,
  findingChangeCount: summary.findingChangeCount,
  unreviewedCount: summary.unreviewedCount,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-unreviewed"] === "true" && summary.unreviewedCount > 0) {
  process.exitCode = 1;
}

function compareCase(testCase: RealPrPilotCase, override: LabelOverride | undefined): ComparisonRow {
  const reviewedDecision = override?.expectedDecision ?? testCase.expectedDecision;
  const reviewedFindings = uniqueSorted(override?.expectedFindingCategories ?? testCase.expectedFindingCategories);
  const draftFindings = uniqueSorted(testCase.expectedFindingCategories);

  return {
    id: testCase.id,
    pullRequest: testCase.source.pullRequest,
    title: testCase.task.title,
    draftDecision: testCase.expectedDecision,
    reviewedDecision,
    decisionChanged: testCase.expectedDecision !== reviewedDecision,
    draftFindings,
    reviewedFindings,
    findingsChanged: draftFindings.join("|") !== reviewedFindings.join("|"),
    humanReviewed: Boolean(override?.humanReviewedBy),
    reviewedBy: override?.humanReviewedBy ?? "(missing)",
    reviewedAt: override?.reviewedAt ?? "(missing)",
    note: override?.reviewerNotes?.join(" ") ?? "(no reviewer override)"
  };
}

function createSummary(rows: ComparisonRow[]) {
  return {
    caseCount: rows.length,
    reviewedCount: rows.filter((row) => row.humanReviewed).length,
    unreviewedCount: rows.filter((row) => !row.humanReviewed).length,
    decisionChangeCount: rows.filter((row) => row.decisionChanged).length,
    findingChangeCount: rows.filter((row) => row.findingsChanged).length,
    reviewedRate: ratio(rows.filter((row) => row.humanReviewed).length, rows.length)
  };
}

function createMarkdown(
  inputPath: string,
  overridesPath: string,
  createdAt: string,
  summary: ReturnType<typeof createSummary>,
  rows: ComparisonRow[]
): string {
  return [
    "# Real PR Draft vs Reviewed Label Comparison",
    "",
    `- Created at: ${createdAt}`,
    `- Draft fixture: ${inputPath}`,
    `- Reviewed overrides: ${overridesPath}`,
    "",
    "## Summary",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Case count", summary.caseCount.toString()],
        ["Reviewed count", summary.reviewedCount.toString()],
        ["Unreviewed count", summary.unreviewedCount.toString()],
        ["Decision changes", summary.decisionChangeCount.toString()],
        ["Finding changes", summary.findingChangeCount.toString()],
        ["Reviewed rate", percent(summary.reviewedRate)]
      ]
    ),
    "",
    "## Rows",
    "",
    table(
      ["Case", "PR", "Reviewed", "Draft Decision", "Reviewed Decision", "Draft Findings", "Reviewed Findings", "Title"],
      rows.map((row) => [
        row.id,
        row.pullRequest,
        row.humanReviewed ? "yes" : "no",
        row.draftDecision,
        row.reviewedDecision,
        row.draftFindings.join(", ") || "(none)",
        row.reviewedFindings.join(", ") || "(none)",
        row.title
      ])
    ),
    "",
    "## Reading",
    "",
    "A low change count does not mean human review was unnecessary. It means the current runtime-draft labels agreed with the reviewed labels for this fixture. The reviewed override file is still valuable because it makes that agreement explicit and auditable."
  ].join("\n");
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values)).sort();
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

function ratio(value: number, total: number): number {
  if (total === 0) return 0;
  return Number((value / total).toFixed(4));
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printHelp(): void {
  console.log(`Real PR Label Comparison

Usage:
  npm run product:pr-label-comparison

Options:
  --input <path>                 Imported runtime-draft fixture.
  --overrides <path>             Human-reviewed label override JSON.
  --out-dir <path>               Output directory. Default: reports/product-runtime
  --fail-on-unreviewed           Exit non-zero when any case has no human-reviewed override.
  --help                         Show this help.
`);
}
