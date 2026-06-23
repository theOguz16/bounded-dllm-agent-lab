import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import { productPilotCases, type ProductPilotCase } from "./product-pilot-fixtures.js";

type PilotCaseResult = {
  id: string;
  family: ProductPilotCase["family"];
  expectedDecision: ReviewDecision;
  actualDecision: ReviewDecision;
  decisionMatches: boolean;
  expectedFindingsPresent: boolean;
  findingCategories: string[];
  falsePositive: boolean;
  falseRefusal: boolean;
  missedBlocker: boolean;
  riskLevel: string;
};

type PilotSummary = {
  caseCount: number;
  decisionAccuracy: number;
  falsePositiveRate: number;
  falseRefusalRate: number;
  missedBlockerRate: number;
  expectedFindingCoverage: number;
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const baseName = `${createdAt.replace(/[:.]/g, "-")}-mvp1-pilot`;
const results = productPilotCases.map(runCase);
const summary = summarize(results);
const artifact = {
  ok: summary.decisionAccuracy === 1 && summary.missedBlockerRate === 0,
  suiteName: "mvp1-enterprise-pilot",
  createdAt,
  summary,
  results
};
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(createdAt, summary, results)}\n`);

console.log(JSON.stringify({
  ok: artifact.ok,
  suiteName: artifact.suiteName,
  caseCount: summary.caseCount,
  decisionAccuracy: summary.decisionAccuracy,
  falsePositiveRate: summary.falsePositiveRate,
  falseRefusalRate: summary.falseRefusalRate,
  missedBlockerRate: summary.missedBlockerRate,
  expectedFindingCoverage: summary.expectedFindingCoverage,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-regression"] === "true" && !artifact.ok) {
  process.exitCode = 1;
}

function runCase(testCase: ProductPilotCase): PilotCaseResult {
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
    family: testCase.family,
    expectedDecision: testCase.expectedDecision,
    actualDecision: review.decision,
    decisionMatches: review.decision === testCase.expectedDecision,
    expectedFindingsPresent,
    findingCategories,
    falsePositive: !expectedBlocking && actualBlocking,
    falseRefusal: testCase.expectedDecision !== "refuse" && review.decision === "refuse",
    missedBlocker: expectedBlocking && review.decision === "approve",
    riskLevel: review.riskLevel
  };
}

function summarize(results: PilotCaseResult[]): PilotSummary {
  return {
    caseCount: results.length,
    decisionAccuracy: ratio(results.filter((result) => result.decisionMatches).length, results.length),
    falsePositiveRate: ratio(results.filter((result) => result.falsePositive).length, results.length),
    falseRefusalRate: ratio(results.filter((result) => result.falseRefusal).length, results.length),
    missedBlockerRate: ratio(results.filter((result) => result.missedBlocker).length, results.length),
    expectedFindingCoverage: ratio(results.filter((result) => result.expectedFindingsPresent).length, results.length)
  };
}

function createMarkdown(createdAt: string, summary: PilotSummary, results: PilotCaseResult[]): string {
  return [
    "# MVP-1 Enterprise Pilot Report",
    "",
    `- Created at: ${createdAt}`,
    `- Case count: ${summary.caseCount}`,
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
        ["Expected finding coverage", percent(summary.expectedFindingCoverage)]
      ]
    ),
    "",
    "## Case Results",
    "",
    table(
      ["Case", "Family", "Expected", "Actual", "Risk", "Findings", "Decision OK", "Finding OK"],
      results.map((result) => [
        result.id,
        result.family,
        result.expectedDecision,
        result.actualDecision,
        result.riskLevel,
        result.findingCategories.join(", ") || "(none)",
        result.decisionMatches ? "pass" : "fail",
        result.expectedFindingsPresent ? "pass" : "fail"
      ])
    ),
    "",
    "## Reading",
    "",
    "Decision accuracy checks whether the runtime made the expected product decision.",
    "False positives mean the runtime blocked an approve case.",
    "False refusals mean the runtime produced refuse when a different decision was expected.",
    "Missed blockers mean the runtime approved a case that should have been blocked or escalated."
  ].join("\n");
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
  console.log(`MVP-1 Product Pilot

Usage:
  npm run product:pilot
  npm run product:pilot -- --out-dir reports/product-runtime --fail-on-regression

Options:
  --out-dir <path>          Artifact output directory. Default: reports/product-runtime
  --fail-on-regression      Exit non-zero if pilot accuracy regresses.
  --help                    Show this help.
`);
}
