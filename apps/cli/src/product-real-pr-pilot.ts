import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import { validatePolicy } from "./product-policy-utils.js";
import { computeProductReadiness, formatReadiness } from "./product-readiness.js";
import { nanoidRealPrPilotCases, realPrPilotCases, type RealPrPilotCase } from "./product-real-pr-pilot-fixtures.js";

type RealPrPilotResult = {
  id: string;
  repository: string;
  pullRequest: string;
  family: RealPrPilotCase["family"];
  expectedDecision: ReviewDecision;
  actualDecision: ReviewDecision;
  decisionMatches: boolean;
  expectedFindingsPresent: boolean;
  findingCategories: string[];
  falsePositive: boolean;
  falseRefusal: boolean;
  missedBlocker: boolean;
  reviewerNotes: string[];
  riskLevel: string;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const suite = args.suite ?? "nanoid";
const cases = args.input ? JSON.parse(await readFile(args.input, "utf8")) as RealPrPilotCase[] : selectBuiltInCases(suite);
const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const results = cases.map(runCase);
const averagePolicyQuality = ratio(
  cases.reduce((total, testCase) => total + validatePolicy(testCase.policy).qualityScore, 0),
  cases.length
);
const summary = {
  caseCount: results.length,
  decisionAccuracy: ratio(results.filter((result) => result.decisionMatches).length, results.length),
  falsePositiveRate: ratio(results.filter((result) => result.falsePositive).length, results.length),
  falseRefusalRate: ratio(results.filter((result) => result.falseRefusal).length, results.length),
  missedBlockerRate: ratio(results.filter((result) => result.missedBlocker).length, results.length),
  expectedFindingCoverage: ratio(results.filter((result) => result.expectedFindingsPresent).length, results.length),
  policyQualityScore: averagePolicyQuality
};
const readiness = computeProductReadiness(summary);
const reportSummary = {
  ...summary,
  readiness
};
const artifact = {
  ok: readiness.blockers.length === 0,
  suiteName: suite === "nanoid" ? "mvp5-nanoid-real-pr-pilot" : "mvp4-real-pr-pilot",
  suite,
  createdAt,
  summary: reportSummary,
  results
};
const baseName = `${createdAt.replace(/[:.]/g, "-")}-real-pr-pilot`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(createdAt, reportSummary, readiness, results)}\n`);

console.log(JSON.stringify({
  ok: artifact.ok,
  suiteName: artifact.suiteName,
  ...summary,
  readiness,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-regression"] === "true" && !artifact.ok) {
  process.exitCode = 1;
}

function runCase(testCase: RealPrPilotCase): RealPrPilotResult {
  const review = reviewPatch({
    task: testCase.task,
    diff: parseUnifiedDiff(testCase.diff),
    policy: testCase.policy
  });
  const findingCategories = Array.from(new Set(review.findings.map((finding) => finding.category))).sort();
  const expectedFindingsPresent = testCase.expectedFindingCategories.every((category) => findingCategories.includes(category));
  const expectedBlocking = testCase.expectedDecision !== "approve";
  const actualBlocking = review.decision !== "approve";

  return {
    id: testCase.id,
    repository: testCase.source.repository,
    pullRequest: testCase.source.pullRequest,
    family: testCase.family,
    expectedDecision: testCase.expectedDecision,
    actualDecision: review.decision,
    decisionMatches: review.decision === testCase.expectedDecision,
    expectedFindingsPresent,
    findingCategories,
    falsePositive: !expectedBlocking && actualBlocking,
    falseRefusal: testCase.expectedDecision !== "refuse" && review.decision === "refuse",
    missedBlocker: expectedBlocking && review.decision === "approve",
    reviewerNotes: testCase.reviewerNotes,
    riskLevel: review.riskLevel
  };
}

function selectBuiltInCases(suite: string): RealPrPilotCase[] {
  if (suite === "nanoid") return nanoidRealPrPilotCases;
  if (suite === "sample") return realPrPilotCases;
  throw new Error(`Unknown --suite value: ${suite}`);
}

function createMarkdown(
  createdAt: string,
  summary: typeof artifact.summary,
  readiness: ReturnType<typeof computeProductReadiness>,
  results: RealPrPilotResult[]
): string {
  return [
    "# Real PR Pilot Report",
    "",
    `- Created at: ${createdAt}`,
    `- Case count: ${summary.caseCount}`,
    `- Readiness: ${formatReadiness(readiness)}`,
    "",
    "## Summary",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Decision accuracy", percent(summary.decisionAccuracy)],
        ["False positive rate", percent(summary.falsePositiveRate)],
        ["False refusal rate", percent(summary.falseRefusalRate)],
        ["Missed blocker rate", percent(summary.missedBlockerRate)],
        ["Expected finding coverage", percent(summary.expectedFindingCoverage)],
        ["Policy quality score", percent(summary.policyQualityScore)],
        ["Readiness blockers", readiness.blockers.join(", ") || "(none)"]
      ]
    ),
    "",
    "## Case Results",
    "",
    table(
      ["Case", "Repo", "PR", "Family", "Expected", "Actual", "Risk", "Findings", "Reviewer Notes"],
      results.map((result) => [
        result.id,
        result.repository,
        result.pullRequest,
        result.family,
        result.expectedDecision,
        result.actualDecision,
        result.riskLevel,
        result.findingCategories.join(", ") || "(none)",
        result.reviewerNotes.join(" ")
      ])
    ),
    "",
    "## Reading",
    "",
    "This suite is a bridge between synthetic product pilots and real repository adoption. Replace the built-in samples with reviewer-labeled PR diffs before treating the score as external validation."
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
  console.log(`Real PR Product Pilot

Usage:
  npm run product:real-pr-pilot
  npm run product:real-pr-pilot -- --suite sample
  npm run product:real-pr-pilot -- --input real-pr-cases.json --out-dir reports/product-runtime

Options:
  --input <path>             JSON array of real-PR pilot cases. Defaults to built-in samples.
  --suite <value>            Built-in suite: nanoid, sample. Default: nanoid
  --out-dir <path>           Output directory. Default: reports/product-runtime
  --fail-on-regression       Exit non-zero if readiness blockers exist.
  --help                     Show this help.
`);
}
