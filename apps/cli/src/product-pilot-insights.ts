import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PilotResult = {
  id: string;
  family: string;
  expectedDecision: string;
  actualDecision: string;
  decisionMatches: boolean;
  expectedFindingsPresent: boolean;
  findingCategories: string[];
  falsePositive: boolean;
  falseRefusal: boolean;
  missedBlocker: boolean;
  riskLevel: string;
};

type PilotArtifact = {
  suiteName: string;
  createdAt: string;
  summary: Record<string, unknown>;
  results: PilotResult[];
};

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const inputPath = args.input ?? await findLatestPilotArtifact(args.dir ?? "reports/product-runtime");
const outDir = args["out-dir"] ?? "reports/product-runtime";
const createdAt = new Date().toISOString();
const artifact = JSON.parse(await readFile(inputPath, "utf8")) as PilotArtifact;
const insights = createInsights(artifact);
const baseName = `${createdAt.replace(/[:.]/g, "-")}-pilot-insights`;
const jsonPath = join(outDir, `${baseName}.json`);
const markdownPath = join(outDir, `${baseName}.md`);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({
  ok: insights.missedBlockerCount === 0,
  inputPath,
  createdAt,
  suiteName: artifact.suiteName,
  insights
}, null, 2)}\n`);
await writeFile(markdownPath, `${createMarkdown(inputPath, artifact, insights)}\n`);

console.log(JSON.stringify({
  ok: insights.missedBlockerCount === 0,
  inputPath,
  caughtBlockerCount: insights.caughtBlockerCount,
  falsePositiveCount: insights.falsePositiveCount,
  missedBlockerCount: insights.missedBlockerCount,
  extraWarningCount: insights.extraWarningCount,
  jsonPath,
  markdownPath
}, null, 2));

if (args["fail-on-missed-blocker"] === "true" && insights.missedBlockerCount > 0) {
  process.exitCode = 1;
}

function createInsights(artifact: PilotArtifact) {
  const caughtBlockers = artifact.results.filter((result) =>
    result.expectedDecision !== "approve" && result.actualDecision !== "approve"
  );
  const falsePositives = artifact.results.filter((result) => result.falsePositive);
  const missedBlockers = artifact.results.filter((result) => result.missedBlocker);
  const falseRefusals = artifact.results.filter((result) => result.falseRefusal);
  const extraWarnings = artifact.results.filter((result) =>
    result.expectedDecision === "approve" && result.actualDecision !== "approve"
  );
  const findingGaps = artifact.results.filter((result) => !result.expectedFindingsPresent);
  const familyRows = Array.from(new Set(artifact.results.map((result) => result.family))).sort().map((family) => {
    const rows = artifact.results.filter((result) => result.family === family);
    return {
      family,
      caseCount: rows.length,
      caughtBlockerCount: rows.filter((result) => result.expectedDecision !== "approve" && result.actualDecision !== "approve").length,
      falsePositiveCount: rows.filter((result) => result.falsePositive).length,
      missedBlockerCount: rows.filter((result) => result.missedBlocker).length,
      decisionAccuracy: ratio(rows.filter((result) => result.decisionMatches).length, rows.length),
      findingCoverage: ratio(rows.filter((result) => result.expectedFindingsPresent).length, rows.length)
    };
  });

  return {
    caseCount: artifact.results.length,
    caughtBlockerCount: caughtBlockers.length,
    falsePositiveCount: falsePositives.length,
    falseRefusalCount: falseRefusals.length,
    missedBlockerCount: missedBlockers.length,
    extraWarningCount: extraWarnings.length,
    findingGapCount: findingGaps.length,
    caughtBlockers: caughtBlockers.map(toCaseInsight),
    falsePositives: falsePositives.map(toCaseInsight),
    missedBlockers: missedBlockers.map(toCaseInsight),
    extraWarnings: extraWarnings.map(toCaseInsight),
    findingGaps: findingGaps.map(toCaseInsight),
    familyRows
  };
}

function toCaseInsight(result: PilotResult) {
  return {
    id: result.id,
    family: result.family,
    expectedDecision: result.expectedDecision,
    actualDecision: result.actualDecision,
    riskLevel: result.riskLevel,
    findings: result.findingCategories
  };
}

function createMarkdown(inputPath: string, artifact: PilotArtifact, insights: ReturnType<typeof createInsights>): string {
  return [
    "# Product Pilot Insight Report",
    "",
    `- Suite: ${artifact.suiteName}`,
    `- Source artifact: ${inputPath}`,
    `- Pilot created at: ${artifact.createdAt}`,
    "",
    "## Summary",
    "",
    table(
      ["Question", "Answer"],
      [
        ["What did the tool catch?", `${insights.caughtBlockerCount} blocker case(s)`],
        ["Where did it over-warn?", `${insights.falsePositiveCount} false positive case(s)`],
        ["Where did it under-warn?", `${insights.missedBlockerCount} missed blocker case(s)`],
        ["Where were findings incomplete?", `${insights.findingGapCount} finding gap case(s)`],
        ["Extra warnings on expected approve", `${insights.extraWarningCount} case(s)`]
      ]
    ),
    "",
    "## Family Breakdown",
    "",
    table(
      ["Family", "Cases", "Caught", "False Positive", "Missed", "Decision", "Finding"],
      insights.familyRows.map((row) => [
        row.family,
        row.caseCount.toString(),
        row.caughtBlockerCount.toString(),
        row.falsePositiveCount.toString(),
        row.missedBlockerCount.toString(),
        percent(row.decisionAccuracy),
        percent(row.findingCoverage)
      ])
    ),
    "",
    "## Caught Blockers",
    "",
    caseTable(insights.caughtBlockers),
    "",
    "## False Positives",
    "",
    caseTable(insights.falsePositives),
    "",
    "## Missed Blockers",
    "",
    caseTable(insights.missedBlockers),
    "",
    "## Reading",
    "",
    "This report does not claim product readiness by itself. It makes verifier behavior reviewable: caught blockers are useful, false positives show over-warning, and missed blockers show unsafe under-warning."
  ].join("\n");
}

function caseTable(rows: ReturnType<typeof toCaseInsight>[]): string {
  if (!rows.length) return "No cases.";
  return table(
    ["Case", "Family", "Expected", "Actual", "Risk", "Findings"],
    rows.map((row) => [
      row.id,
      row.family,
      row.expectedDecision,
      row.actualDecision,
      row.riskLevel,
      row.findings.join(", ") || "(none)"
    ])
  );
}

async function findLatestPilotArtifact(dir: string): Promise<string> {
  const files = await readdir(dir);
  const candidates = files
    .filter((file) => file.endsWith("-mvp3-pilot.json") || file.endsWith("-mvp2-pilot.json") || file.endsWith("-mvp1-pilot.json"))
    .sort()
    .reverse();

  if (!candidates.length) {
    throw new Error(`No pilot artifact found in ${dir}. Pass --input explicitly.`);
  }

  return join(dir, candidates[0]);
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
  console.log(`Product Pilot Insights

Usage:
  npm run product:pilot-insights -- --input reports/product-runtime/2026-...-mvp3-pilot.json
  npm run product:pilot-insights -- --dir reports/product-runtime

Options:
  --input <path>                 Exact pilot JSON artifact.
  --dir <path>                   Directory to search for latest pilot artifact.
  --out-dir <path>               Output directory. Default: reports/product-runtime
  --fail-on-missed-blocker       Exit non-zero if any missed blocker exists.
  --help                         Show this help.
`);
}
