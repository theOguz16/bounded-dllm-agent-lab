import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type Finding, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import type { RealPrPilotCase } from "./product-real-pr-pilot-fixtures.js";

type LabelOverride = {
  id: string;
  expectedDecision?: ReviewDecision;
  expectedFindingCategories?: Finding["category"][];
  reviewerNotes?: string[];
  humanReviewedBy?: string;
  reviewedAt?: string;
};

type CalibrationStatus = "needs_human_review" | "runtime_drift" | "reviewed_ready";

type CalibrationRow = {
  id: string;
  repository: string;
  pullRequest: string;
  title: string;
  isDraftLabel: boolean;
  expectedDecision: ReviewDecision;
  runtimeDecision: ReviewDecision;
  decisionMatches: boolean;
  expectedFindingCategories: Finding["category"][];
  runtimeFindingCategories: Finding["category"][];
  missingExpectedFindings: Finding["category"][];
  extraRuntimeFindings: Finding["category"][];
  status: CalibrationStatus;
  reviewerNotes: string[];
  sourceNote: string;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const inputPath = args.input ?? "examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json";
const outDir = args["out-dir"] ?? "reports/product-runtime";
const overrides = args.overrides ? await readOverrides(args.overrides) : new Map<string, LabelOverride>();
const cases = applyOverrides(
  JSON.parse(await readFile(inputPath, "utf8")) as RealPrPilotCase[],
  overrides
);
const createdAt = new Date().toISOString();
const rows = cases.map(calibrateCase);
const summary = createSummary(rows);
const baseName = `${createdAt.replace(/[:.]/g, "-")}-pr-calibration`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({
  ok: summary.runtimeDriftCount === 0,
  inputPath,
  overridesPath: args.overrides ?? null,
  createdAt,
  summary,
  rows
}, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(inputPath, args.overrides, createdAt, summary, rows)}\n`);

console.log(JSON.stringify({
  ok: summary.runtimeDriftCount === 0,
  inputPath,
  overridesPath: args.overrides ?? null,
  caseCount: summary.caseCount,
  needsHumanReviewCount: summary.needsHumanReviewCount,
  runtimeDriftCount: summary.runtimeDriftCount,
  reviewedReadyCount: summary.reviewedReadyCount,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-runtime-drift"] === "true" && summary.runtimeDriftCount > 0) {
  process.exitCode = 1;
}

function calibrateCase(testCase: RealPrPilotCase): CalibrationRow {
  const review = reviewPatch({
    task: testCase.task,
    diff: parseUnifiedDiff(testCase.diff),
    policy: testCase.policy
  });
  const runtimeFindingCategories = uniqueSorted(review.findings.map((finding) => finding.category));
  const expectedFindingCategories = uniqueSorted(testCase.expectedFindingCategories);
  const missingExpectedFindings = expectedFindingCategories.filter((category) => !runtimeFindingCategories.includes(category));
  const extraRuntimeFindings = runtimeFindingCategories.filter((category) => !expectedFindingCategories.includes(category));
  const isDraftLabel = testCase.reviewerNotes.some((note) => note.includes("DRAFT_LABEL"));
  const decisionMatches = testCase.expectedDecision === review.decision;
  const status = toStatus(isDraftLabel, decisionMatches, missingExpectedFindings);

  return {
    id: testCase.id,
    repository: testCase.source.repository,
    pullRequest: testCase.source.pullRequest,
    title: testCase.task.title,
    isDraftLabel,
    expectedDecision: testCase.expectedDecision,
    runtimeDecision: review.decision,
    decisionMatches,
    expectedFindingCategories,
    runtimeFindingCategories,
    missingExpectedFindings,
    extraRuntimeFindings,
    status,
    reviewerNotes: testCase.reviewerNotes,
    sourceNote: testCase.source.note
  };
}

function toStatus(
  isDraftLabel: boolean,
  decisionMatches: boolean,
  missingExpectedFindings: Finding["category"][]
): CalibrationStatus {
  if (!decisionMatches || missingExpectedFindings.length > 0) return "runtime_drift";
  if (isDraftLabel) return "needs_human_review";
  return "reviewed_ready";
}

function createSummary(rows: CalibrationRow[]) {
  return {
    caseCount: rows.length,
    needsHumanReviewCount: rows.filter((row) => row.status === "needs_human_review").length,
    runtimeDriftCount: rows.filter((row) => row.status === "runtime_drift").length,
    reviewedReadyCount: rows.filter((row) => row.status === "reviewed_ready").length,
    draftLabelCount: rows.filter((row) => row.isDraftLabel).length,
    decisionMatchRate: ratio(rows.filter((row) => row.decisionMatches).length, rows.length),
    expectedFindingCoverageRate: ratio(rows.filter((row) => row.missingExpectedFindings.length === 0).length, rows.length)
  };
}

function createMarkdown(
  inputPath: string,
  overridesPath: string | undefined,
  createdAt: string,
  summary: ReturnType<typeof createSummary>,
  rows: CalibrationRow[]
): string {
  return [
    "# Real PR Fixture Calibration Report",
    "",
    `- Created at: ${createdAt}`,
    `- Input fixture: ${inputPath}`,
    `- Overrides: ${overridesPath ?? "(none)"}`,
    "",
    "## Summary",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Case count", summary.caseCount.toString()],
        ["Needs human review", summary.needsHumanReviewCount.toString()],
        ["Runtime drift", summary.runtimeDriftCount.toString()],
        ["Reviewed ready", summary.reviewedReadyCount.toString()],
        ["Draft labels", summary.draftLabelCount.toString()],
        ["Decision match rate", percent(summary.decisionMatchRate)],
        ["Expected finding coverage", percent(summary.expectedFindingCoverageRate)]
      ]
    ),
    "",
    "## Calibration Rows",
    "",
    table(
      ["Case", "PR", "Status", "Draft", "Expected", "Runtime", "Missing Findings", "Extra Findings", "Title"],
      rows.map((row) => [
        row.id,
        row.pullRequest,
        row.status,
        row.isDraftLabel ? "yes" : "no",
        row.expectedDecision,
        row.runtimeDecision,
        row.missingExpectedFindings.join(", ") || "(none)",
        row.extraRuntimeFindings.join(", ") || "(none)",
        row.title
      ])
    ),
    "",
    "## Human Review Queue",
    "",
    humanQueue(rows),
    "",
    "## Reading",
    "",
    "Draft imported labels are useful for deterministic regression tests, but they are not external validation. A case should be treated as reviewer-labeled only after a human checks the expected decision, expected findings, policy fit and reviewer notes."
  ].join("\n");
}

function humanQueue(rows: CalibrationRow[]): string {
  const queued = rows.filter((row) => row.status !== "reviewed_ready");
  if (!queued.length) return "No cases waiting for calibration.";

  return table(
    ["Case", "Why Review", "Source", "Notes"],
    queued.map((row) => [
      row.id,
      row.status === "runtime_drift" ? "runtime output differs from expected labels" : "runtime-draft label needs human confirmation",
      row.sourceNote,
      row.reviewerNotes.join(" ")
    ])
  );
}

async function readOverrides(path: string): Promise<Map<string, LabelOverride>> {
  const values = JSON.parse(await readFile(path, "utf8")) as LabelOverride[];
  return new Map(values.map((value) => [value.id, value]));
}

function applyOverrides(cases: RealPrPilotCase[], overrides: Map<string, LabelOverride>): RealPrPilotCase[] {
  return cases.map((testCase) => {
    const override = overrides.get(testCase.id);
    if (!override) return testCase;

    // İnsan reviewer override'u geldiğinde DRAFT_LABEL notunu korumayız; böylece
    // calibration raporu bu case'i insan tarafından etiketlenmiş kabul edebilir.
    const reviewerNotes = override.reviewerNotes ?? testCase.reviewerNotes.filter((note) => !note.includes("DRAFT_LABEL"));
    const humanReviewNote = override.humanReviewedBy
      ? [`HUMAN_REVIEWED_BY: ${override.humanReviewedBy}${override.reviewedAt ? ` at ${override.reviewedAt}` : ""}.`]
      : [];

    return {
      ...testCase,
      reviewerNotes: [...humanReviewNote, ...reviewerNotes],
      expectedDecision: override.expectedDecision ?? testCase.expectedDecision,
      expectedFindingCategories: override.expectedFindingCategories ?? testCase.expectedFindingCategories
    };
  });
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
  console.log(`Real PR Calibration

Usage:
  npm run product:pr-calibration
  npm run product:pr-calibration -- --overrides examples/product-runtime/real-pr-fixtures/reviewer-label-overrides.example.json

Options:
  --input <path>                 Imported RealPrPilotCase JSON fixture.
  --overrides <path>             Human reviewer label override JSON.
  --out-dir <path>               Output directory. Default: reports/product-runtime
  --fail-on-runtime-drift        Exit non-zero when expected labels drift from runtime output.
  --help                         Show this help.
`);
}
