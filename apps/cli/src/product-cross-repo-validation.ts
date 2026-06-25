import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type Finding, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import type { RealPrPilotCase } from "./product-real-pr-pilot-fixtures.js";

type LabelOverride = {
  id: string;
  expectedDecision?: ReviewDecision;
  expectedFindingCategories?: Finding["category"][];
  humanReviewedBy?: string;
};

type RepoValidationInput = {
  repoLabel: string;
  fixturePath: string;
  overridesPath: string;
};

type RepoValidationRow = {
  repoLabel: string;
  id: string;
  pullRequest: string;
  title: string;
  humanReviewed: boolean;
  draftDecision: ReviewDecision;
  reviewedDecision: ReviewDecision;
  runtimeDecision: ReviewDecision;
  decisionChanged: boolean;
  decisionMatches: boolean;
  draftFindings: Finding["category"][];
  reviewedFindings: Finding["category"][];
  runtimeFindings: Finding["category"][];
  missingExpectedFindings: Finding["category"][];
  extraRuntimeFindings: Finding["category"][];
  status: "reviewed_ready" | "needs_human_review" | "runtime_drift";
};

type RepoValidationSummary = {
  repoLabel: string;
  fixturePath: string;
  overridesPath: string;
  caseCount: number;
  reviewedReadyCount: number;
  needsHumanReviewCount: number;
  runtimeDriftCount: number;
  decisionMatchRate: number;
  expectedFindingCoverageRate: number;
  decisionChangeCount: number;
  findingChangeCount: number;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const inputs: RepoValidationInput[] = [
  {
    repoLabel: "NanoID",
    fixturePath: "examples/product-runtime/real-pr-fixtures/nanoid-github-prs.draft.json",
    overridesPath: "examples/product-runtime/real-pr-fixtures/nanoid-reviewed-label-overrides.json"
  },
  {
    repoLabel: "p-limit",
    fixturePath: "examples/product-runtime/real-pr-fixtures/p-limit-github-prs.draft.json",
    overridesPath: "examples/product-runtime/real-pr-fixtures/p-limit-reviewed-label-overrides.json"
  }
];
const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const repoResults = await Promise.all(inputs.map(validateRepo));
const summaries = repoResults.map((result) => result.summary);
const rows = repoResults.flatMap((result) => result.rows);
const aggregate = createAggregate(summaries);
const baseName = `${createdAt.replace(/[:.]/g, "-")}-cross-repo-validation`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({
  ok: aggregate.runtimeDriftCount === 0 && aggregate.needsHumanReviewCount === 0,
  createdAt,
  aggregate,
  summaries,
  rows
}, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(createdAt, aggregate, summaries, rows)}\n`);

console.log(JSON.stringify({
  ok: aggregate.runtimeDriftCount === 0 && aggregate.needsHumanReviewCount === 0,
  createdAt,
  repoCount: summaries.length,
  caseCount: aggregate.caseCount,
  needsHumanReviewCount: aggregate.needsHumanReviewCount,
  runtimeDriftCount: aggregate.runtimeDriftCount,
  reviewedReadyCount: aggregate.reviewedReadyCount,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-runtime-drift"] === "true" && aggregate.runtimeDriftCount > 0) {
  process.exitCode = 1;
}

if (args["fail-on-unreviewed"] === "true" && aggregate.needsHumanReviewCount > 0) {
  process.exitCode = 1;
}

async function validateRepo(input: RepoValidationInput): Promise<{ summary: RepoValidationSummary; rows: RepoValidationRow[] }> {
  const cases = JSON.parse(await readFile(input.fixturePath, "utf8")) as RealPrPilotCase[];
  const overrides = new Map(
    (JSON.parse(await readFile(input.overridesPath, "utf8")) as LabelOverride[]).map((override) => [override.id, override])
  );
  const rows = cases.map((testCase) => validateCase(input.repoLabel, testCase, overrides.get(testCase.id)));

  return {
    summary: {
      repoLabel: input.repoLabel,
      fixturePath: input.fixturePath,
      overridesPath: input.overridesPath,
      caseCount: rows.length,
      reviewedReadyCount: rows.filter((row) => row.status === "reviewed_ready").length,
      needsHumanReviewCount: rows.filter((row) => row.status === "needs_human_review").length,
      runtimeDriftCount: rows.filter((row) => row.status === "runtime_drift").length,
      decisionMatchRate: ratio(rows.filter((row) => row.decisionMatches).length, rows.length),
      expectedFindingCoverageRate: ratio(rows.filter((row) => row.missingExpectedFindings.length === 0).length, rows.length),
      decisionChangeCount: rows.filter((row) => row.decisionChanged).length,
      findingChangeCount: rows.filter((row) => row.draftFindings.join("|") !== row.reviewedFindings.join("|")).length
    },
    rows
  };
}

function validateCase(repoLabel: string, testCase: RealPrPilotCase, override: LabelOverride | undefined): RepoValidationRow {
  const review = reviewPatch({
    task: testCase.task,
    diff: parseUnifiedDiff(testCase.diff),
    policy: testCase.policy
  });
  const draftFindings = uniqueSorted(testCase.expectedFindingCategories);
  const reviewedFindings = uniqueSorted(override?.expectedFindingCategories ?? testCase.expectedFindingCategories);
  const runtimeFindings = uniqueSorted(review.findings.map((finding) => finding.category));
  const missingExpectedFindings = reviewedFindings.filter((category) => !runtimeFindings.includes(category));
  const extraRuntimeFindings = runtimeFindings.filter((category) => !reviewedFindings.includes(category));
  const reviewedDecision = override?.expectedDecision ?? testCase.expectedDecision;
  const decisionMatches = reviewedDecision === review.decision;
  const humanReviewed = Boolean(override?.humanReviewedBy);

  return {
    repoLabel,
    id: testCase.id,
    pullRequest: testCase.source.pullRequest,
    title: testCase.task.title,
    humanReviewed,
    draftDecision: testCase.expectedDecision,
    reviewedDecision,
    runtimeDecision: review.decision,
    decisionChanged: testCase.expectedDecision !== reviewedDecision,
    decisionMatches,
    draftFindings,
    reviewedFindings,
    runtimeFindings,
    missingExpectedFindings,
    extraRuntimeFindings,
    status: toStatus(humanReviewed, decisionMatches, missingExpectedFindings)
  };
}

function toStatus(
  humanReviewed: boolean,
  decisionMatches: boolean,
  missingExpectedFindings: Finding["category"][]
): RepoValidationRow["status"] {
  if (!decisionMatches || missingExpectedFindings.length > 0) return "runtime_drift";
  if (!humanReviewed) return "needs_human_review";
  return "reviewed_ready";
}

function createAggregate(summaries: RepoValidationSummary[]) {
  const caseCount = sum(summaries.map((summary) => summary.caseCount));
  const reviewedReadyCount = sum(summaries.map((summary) => summary.reviewedReadyCount));
  const needsHumanReviewCount = sum(summaries.map((summary) => summary.needsHumanReviewCount));
  const runtimeDriftCount = sum(summaries.map((summary) => summary.runtimeDriftCount));
  const decisionMatchCount = sum(summaries.map((summary) => Math.round(summary.decisionMatchRate * summary.caseCount)));
  const expectedFindingCoverageCount = sum(summaries.map((summary) => Math.round(summary.expectedFindingCoverageRate * summary.caseCount)));

  return {
    repoCount: summaries.length,
    caseCount,
    reviewedReadyCount,
    needsHumanReviewCount,
    runtimeDriftCount,
    decisionMatchRate: ratio(decisionMatchCount, caseCount),
    expectedFindingCoverageRate: ratio(expectedFindingCoverageCount, caseCount),
    decisionChangeCount: sum(summaries.map((summary) => summary.decisionChangeCount)),
    findingChangeCount: sum(summaries.map((summary) => summary.findingChangeCount))
  };
}

function createMarkdown(
  createdAt: string,
  aggregate: ReturnType<typeof createAggregate>,
  summaries: RepoValidationSummary[],
  rows: RepoValidationRow[]
): string {
  return [
    "# Cross-Repo External Validation Report",
    "",
    `- Created at: ${createdAt}`,
    `- Repository count: ${aggregate.repoCount}`,
    `- Case count: ${aggregate.caseCount}`,
    "",
    "## Aggregate",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Reviewed ready", aggregate.reviewedReadyCount.toString()],
        ["Needs human review", aggregate.needsHumanReviewCount.toString()],
        ["Runtime drift", aggregate.runtimeDriftCount.toString()],
        ["Decision match rate", percent(aggregate.decisionMatchRate)],
        ["Expected finding coverage", percent(aggregate.expectedFindingCoverageRate)],
        ["Draft vs reviewed decision changes", aggregate.decisionChangeCount.toString()],
        ["Draft vs reviewed finding changes", aggregate.findingChangeCount.toString()]
      ]
    ),
    "",
    "## Repositories",
    "",
    table(
      ["Repository", "Cases", "Reviewed Ready", "Unreviewed", "Runtime Drift", "Decision Match", "Finding Coverage", "Decision Changes", "Finding Changes"],
      summaries.map((summary) => [
        summary.repoLabel,
        summary.caseCount.toString(),
        summary.reviewedReadyCount.toString(),
        summary.needsHumanReviewCount.toString(),
        summary.runtimeDriftCount.toString(),
        percent(summary.decisionMatchRate),
        percent(summary.expectedFindingCoverageRate),
        summary.decisionChangeCount.toString(),
        summary.findingChangeCount.toString()
      ])
    ),
    "",
    "## Non-Ready Rows",
    "",
    nonReadyRows(rows),
    "",
    "## Reading",
    "",
    "This report checks whether reviewed external PR fixtures remain stable across more than one repository. Every case must have human-reviewed labels, and the current runtime must still match those labels. Passing this gate does not prove general correctness, but it reduces the risk that the product runtime was only calibrated to one repository's conventions."
  ].join("\n");
}

function nonReadyRows(rows: RepoValidationRow[]): string {
  const selected = rows.filter((row) => row.status !== "reviewed_ready");
  if (!selected.length) return "All reviewed external rows are ready.";

  return table(
    ["Repository", "Case", "PR", "Status", "Reviewed", "Expected", "Runtime", "Missing Findings", "Extra Findings"],
    selected.map((row) => [
      row.repoLabel,
      row.id,
      row.pullRequest,
      row.status,
      row.humanReviewed ? "yes" : "no",
      row.reviewedDecision,
      row.runtimeDecision,
      row.missingExpectedFindings.join(", ") || "(none)",
      row.extraRuntimeFindings.join(", ") || "(none)"
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
  console.log(`Cross-Repo External Validation

Usage:
  npm run product:cross-repo-validation

Options:
  --out-dir <path>               Output directory. Default: reports/product-runtime
  --fail-on-runtime-drift        Exit non-zero when reviewed labels drift from runtime output.
  --fail-on-unreviewed           Exit non-zero when any external case lacks reviewed labels.
  --help                         Show this help.
`);
}
