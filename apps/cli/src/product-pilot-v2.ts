import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, reviewPatch, type ReviewDecision } from "../../../packages/product-runtime/src/index.js";
import { validatePolicy } from "./product-policy-utils.js";
import { externalStylePolicy, productPilotV2Cases, type ProductPilotV2Case } from "./product-pilot-v2-fixtures.js";

type PilotV2CaseResult = {
  id: string;
  family: ProductPilotV2Case["family"];
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

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const baseName = `${createdAt.replace(/[:.]/g, "-")}-mvp2-pilot`;
const results = productPilotV2Cases.map(runCase);
const policyQuality = validatePolicy(externalStylePolicy);
const summary = {
  caseCount: results.length,
  decisionAccuracy: ratio(results.filter((result) => result.decisionMatches).length, results.length),
  falsePositiveRate: ratio(results.filter((result) => result.falsePositive).length, results.length),
  falseRefusalRate: ratio(results.filter((result) => result.falseRefusal).length, results.length),
  missedBlockerRate: ratio(results.filter((result) => result.missedBlocker).length, results.length),
  expectedFindingCoverage: ratio(results.filter((result) => result.expectedFindingsPresent).length, results.length),
  policyQualityScore: policyQuality.qualityScore,
  policyQualityGrade: policyQuality.qualityGrade
};
const artifact = {
  ok: summary.decisionAccuracy === 1 && summary.missedBlockerRate === 0 && summary.policyQualityGrade === "strong",
  suiteName: "mvp2-external-style-pilot",
  createdAt,
  summary,
  policyQualityFindings: policyQuality.findings,
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
  ...summary,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-regression"] === "true" && !artifact.ok) {
  process.exitCode = 1;
}

function runCase(testCase: ProductPilotV2Case): PilotV2CaseResult {
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

function createMarkdown(createdAt: string, summary: typeof artifact.summary, results: PilotV2CaseResult[]): string {
  return [
    "# MVP-2 External-Style Pilot Report",
    "",
    `- Created at: ${createdAt}`,
    `- Case count: ${summary.caseCount}`,
    `- Policy quality: ${percent(summary.policyQualityScore)} (${summary.policyQualityGrade})`,
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
        ["Policy quality score", `${percent(summary.policyQualityScore)} (${summary.policyQualityGrade})`]
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
    "MVP-2 adds owner aliases, path-aware required test mappings, and policy quality scoring.",
    "This pilot is still deterministic and controlled; it is closer to an external repository workflow but is not yet a live production pilot."
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
  console.log(`MVP-2 Product Pilot

Usage:
  npm run product:pilot-v2
  npm run product:pilot-v2 -- --out-dir reports/product-runtime --fail-on-regression

Options:
  --out-dir <path>          Artifact output directory. Default: reports/product-runtime
  --fail-on-regression      Exit non-zero if pilot v2 accuracy regresses.
  --help                    Show this help.
`);
}
