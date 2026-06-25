import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type Finding, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import {
  nanoidNegativeExternalCases,
  pLimitNegativeExternalCases,
  type RealPrPilotCase
} from "./product-real-pr-pilot-fixtures.js";

type LabelOverride = {
  id: string;
  expectedDecision?: ReviewDecision;
  expectedFindingCategories?: Finding["category"][];
  reviewerNotes?: string[];
  humanReviewedBy?: string;
};

type MixedValidationCase = RealPrPilotCase & {
  validationKind: "positive_reviewed" | "negative_control";
};

type MixedValidationResult = {
  id: string;
  repository: string;
  pullRequest: string;
  validationKind: MixedValidationCase["validationKind"];
  expectedDecision: ReviewDecision;
  actualDecision: ReviewDecision;
  decisionMatches: boolean;
  expectedBlocking: boolean;
  actualBlocking: boolean;
  falseBlocker: boolean;
  missedBlocker: boolean;
  expectedFindingsPresent: boolean;
  expectedFindingCategories: Finding["category"][];
  actualFindingCategories: Finding["category"][];
  reviewerNotes: string[];
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const cases = [
  ...await readReviewedPositiveCases(
    "examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json",
    "examples/product-runtime/real-pr-fixtures/nanoid-reviewed-label-overrides.json"
  ),
  ...await readReviewedPositiveCases(
    "examples/product-runtime/real-pr-fixtures/p-limit-github-prs.draft.json",
    "examples/product-runtime/real-pr-fixtures/p-limit-reviewed-label-overrides.json"
  ),
  ...nanoidNegativeExternalCases.map(asNegativeControl),
  ...pLimitNegativeExternalCases.map(asNegativeControl)
];
const results = cases.map(runCase);
const summary = createSummary(results);
const repoBreakdown = createRepoBreakdown(results);
const baseName = `${createdAt.replace(/[:.]/g, "-")}-mixed-external-validation`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({
  ok: summary.falseBlockerCount === 0 && summary.missedBlockerCount === 0,
  createdAt,
  summary,
  repoBreakdown,
  results
}, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(createdAt, summary, repoBreakdown, results)}\n`);

console.log(JSON.stringify({
  ok: summary.falseBlockerCount === 0 && summary.missedBlockerCount === 0,
  createdAt,
  caseCount: summary.caseCount,
  positiveCaseCount: summary.positiveCaseCount,
  negativeCaseCount: summary.negativeCaseCount,
  falseBlockerCount: summary.falseBlockerCount,
  missedBlockerCount: summary.missedBlockerCount,
  decisionAccuracy: summary.decisionAccuracy,
  blockerDetectionRate: summary.blockerDetectionRate,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-false-blocker"] === "true" && summary.falseBlockerCount > 0) {
  process.exitCode = 1;
}

if (args["fail-on-missed-blocker"] === "true" && summary.missedBlockerCount > 0) {
  process.exitCode = 1;
}

async function readReviewedPositiveCases(fixturePath: string, overridesPath: string): Promise<MixedValidationCase[]> {
  const cases = JSON.parse(await readFile(fixturePath, "utf8")) as RealPrPilotCase[];
  const overrides = new Map(
    (JSON.parse(await readFile(overridesPath, "utf8")) as LabelOverride[]).map((override) => [override.id, override])
  );

  return cases.map((testCase) => {
    const override = overrides.get(testCase.id);
    return {
      ...testCase,
      validationKind: "positive_reviewed",
      expectedDecision: override?.expectedDecision ?? testCase.expectedDecision,
      expectedFindingCategories: override?.expectedFindingCategories ?? testCase.expectedFindingCategories,
      reviewerNotes: override?.reviewerNotes ?? testCase.reviewerNotes
    };
  });
}

function asNegativeControl(testCase: RealPrPilotCase): MixedValidationCase {
  return { ...testCase, validationKind: "negative_control" };
}

function runCase(testCase: MixedValidationCase): MixedValidationResult {
  const review = reviewPatch({
    task: testCase.task,
    diff: parseUnifiedDiff(testCase.diff),
    policy: testCase.policy
  });
  const actualFindingCategories = uniqueSorted(review.findings.map((finding) => finding.category));
  const expectedFindingCategories = uniqueSorted(testCase.expectedFindingCategories);
  const expectedBlocking = testCase.expectedDecision !== "approve";
  const actualBlocking = review.decision !== "approve";

  return {
    id: testCase.id,
    repository: testCase.source.repository,
    pullRequest: testCase.source.pullRequest,
    validationKind: testCase.validationKind,
    expectedDecision: testCase.expectedDecision,
    actualDecision: review.decision,
    decisionMatches: review.decision === testCase.expectedDecision,
    expectedBlocking,
    actualBlocking,
    falseBlocker: !expectedBlocking && actualBlocking,
    missedBlocker: expectedBlocking && !actualBlocking,
    expectedFindingsPresent: expectedFindingCategories.every((category) => actualFindingCategories.includes(category)),
    expectedFindingCategories,
    actualFindingCategories,
    reviewerNotes: testCase.reviewerNotes
  };
}

function createSummary(results: MixedValidationResult[]) {
  const positiveResults = results.filter((result) => result.validationKind === "positive_reviewed");
  const negativeResults = results.filter((result) => result.validationKind === "negative_control");

  return {
    caseCount: results.length,
    positiveCaseCount: positiveResults.length,
    negativeCaseCount: negativeResults.length,
    decisionAccuracy: ratio(results.filter((result) => result.decisionMatches).length, results.length),
    positivePassRate: ratio(positiveResults.filter((result) => !result.actualBlocking).length, positiveResults.length),
    blockerDetectionRate: ratio(negativeResults.filter((result) => result.actualBlocking).length, negativeResults.length),
    falseBlockerCount: positiveResults.filter((result) => result.falseBlocker).length,
    missedBlockerCount: negativeResults.filter((result) => result.missedBlocker).length,
    expectedFindingCoverage: ratio(results.filter((result) => result.expectedFindingsPresent).length, results.length)
  };
}

function createRepoBreakdown(results: MixedValidationResult[]) {
  const repositories = uniqueSorted(results.map((result) => result.repository));

  return repositories.map((repository) => {
    const rows = results.filter((result) => result.repository === repository);
    const positiveRows = rows.filter((result) => result.validationKind === "positive_reviewed");
    const negativeRows = rows.filter((result) => result.validationKind === "negative_control");

    return {
      repository,
      caseCount: rows.length,
      positiveCaseCount: positiveRows.length,
      negativeCaseCount: negativeRows.length,
      decisionAccuracy: ratio(rows.filter((result) => result.decisionMatches).length, rows.length),
      falseBlockerCount: positiveRows.filter((result) => result.falseBlocker).length,
      missedBlockerCount: negativeRows.filter((result) => result.missedBlocker).length,
      expectedFindingCoverage: ratio(rows.filter((result) => result.expectedFindingsPresent).length, rows.length)
    };
  });
}

function createMarkdown(
  createdAt: string,
  summary: ReturnType<typeof createSummary>,
  repoBreakdown: ReturnType<typeof createRepoBreakdown>,
  results: MixedValidationResult[]
): string {
  return [
    "# Mixed External Validation Report",
    "",
    `- Created at: ${createdAt}`,
    `- Case count: ${summary.caseCount}`,
    "",
    "## Summary",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Positive reviewed cases", summary.positiveCaseCount.toString()],
        ["Negative control cases", summary.negativeCaseCount.toString()],
        ["Decision accuracy", percent(summary.decisionAccuracy)],
        ["Positive pass rate", percent(summary.positivePassRate)],
        ["Blocker detection rate", percent(summary.blockerDetectionRate)],
        ["False blockers", summary.falseBlockerCount.toString()],
        ["Missed blockers", summary.missedBlockerCount.toString()],
        ["Expected finding coverage", percent(summary.expectedFindingCoverage)]
      ]
    ),
    "",
    "## Repository Breakdown",
    "",
    table(
      ["Repository", "Cases", "Positive", "Negative", "Decision Accuracy", "False Blockers", "Missed Blockers", "Finding Coverage"],
      repoBreakdown.map((row) => [
        row.repository,
        row.caseCount.toString(),
        row.positiveCaseCount.toString(),
        row.negativeCaseCount.toString(),
        percent(row.decisionAccuracy),
        row.falseBlockerCount.toString(),
        row.missedBlockerCount.toString(),
        percent(row.expectedFindingCoverage)
      ])
    ),
    "",
    "## Non-Matching Cases",
    "",
    nonMatchingTable(results),
    "",
    "## Reading",
    "",
    "Positive reviewed cases are real merged upstream PRs and should not be blocked. Negative controls are realistic risky diffs and should not pass silently. This report is the first product gate that reads both sides together: false blockers measure over-warning on accepted PRs, while missed blockers measure unsafe under-warning on risky PRs."
  ].join("\n");
}

function nonMatchingTable(results: MixedValidationResult[]): string {
  const selected = results.filter((result) => !result.decisionMatches || !result.expectedFindingsPresent);
  if (!selected.length) return "All mixed external cases matched expected decisions and findings.";

  return table(
    ["Case", "Repo", "Kind", "Expected", "Actual", "Expected Findings", "Actual Findings", "Notes"],
    selected.map((result) => [
      result.id,
      result.repository,
      result.validationKind,
      result.expectedDecision,
      result.actualDecision,
      result.expectedFindingCategories.join(", ") || "(none)",
      result.actualFindingCategories.join(", ") || "(none)",
      result.reviewerNotes.join(" ")
    ])
  );
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
  console.log(`Mixed External Validation

Usage:
  npm run product:mixed-external-validation

Options:
  --out-dir <path>               Output directory. Default: reports/product-runtime
  --fail-on-false-blocker        Exit non-zero when a positive reviewed PR is blocked.
  --fail-on-missed-blocker       Exit non-zero when a negative control passes silently.
  --help                         Show this help.
`);
}
