import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodePatchBenchmarkReport, CodePatchCaseScore } from "../../../packages/code-benchmark/src/index.js";

type RemaskRun = {
  label: string;
  suffix: string;
  path?: string;
  report?: CodePatchBenchmarkReport;
};

const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-code-remask-comparison`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

const runs: RemaskRun[] = [
  { label: "Qwen verifier only", suffix: "code-model-remask-required-workspace-verifier-patch-benchmark.json" },
  { label: "Qwen verifier + remask", suffix: "code-model-remask-required-workspace-verifier-remask-patch-benchmark.json" }
];

const files = await readdir(reportDir).catch(() => []);
const loadedRuns = await Promise.all(runs.map((run) => loadLatestRun(run, files)));
const availableRuns = loadedRuns.filter((run): run is RemaskRun & { path: string; report: CodePatchBenchmarkReport } => Boolean(run.path && run.report));
const missingRuns = loadedRuns.filter((run) => !run.report).map((run) => ({ label: run.label, suffix: run.suffix }));

if (!availableRuns.length) {
  throw new Error("No remask-required code benchmark reports found. Run the remask verifier and remask benchmark modes first.");
}

const comparison = {
  createdAt,
  runCount: availableRuns.length,
  missingRuns,
  runs: availableRuns.map((run) => ({
    label: run.label,
    path: run.path,
    caseCount: run.report.caseCount,
    patchPassRate: run.report.positiveControlPassRate,
    expectedOutcomeAccuracy: run.report.expectedOutcomeAccuracy,
    refusalAccuracy: run.report.refusalAccuracy,
    requiredContentMissCount: countSignal(run.report.cases, "missing_required_content"),
    missingExpectedFileCount: countSignal(run.report.cases, "missing_expected_file"),
    invalidContractCount: countSignal(run.report.cases, "invalid_model_output")
  }))
};

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(markdownPath, `${comparisonToMarkdown(comparison)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      runCount: comparison.runCount,
      missingRuns,
      jsonPath,
      markdownPath,
      summaries: comparison.runs.map((run) => ({
        label: run.label,
        patchPassRate: run.patchPassRate,
        requiredContentMissCount: run.requiredContentMissCount,
        missingExpectedFileCount: run.missingExpectedFileCount,
        invalidContractCount: run.invalidContractCount
      }))
    },
    null,
    2
  )
);

async function loadLatestRun(run: RemaskRun, files: string[]): Promise<RemaskRun> {
  const latest = files
    .filter((file) => file.endsWith(run.suffix))
    .filter((file) => !file.endsWith(".checkpoint.json") && !file.endsWith(".manifest.json"))
    .sort()
    .at(-1);

  if (!latest) return run;

  const path = join(reportDir, latest);
  const report = JSON.parse(await readFile(path, "utf8")) as CodePatchBenchmarkReport;

  return { ...run, path, report };
}

function countSignal(scores: CodePatchCaseScore[], signal: string): number {
  return scores.filter((score) => score.observedFailureSignals.includes(signal as never)).length;
}

function comparisonToMarkdown(input: typeof comparison): string {
  const rows = input.runs.map((run) => [
    run.label,
    run.caseCount.toString(),
    percent(run.patchPassRate),
    percent(run.expectedOutcomeAccuracy),
    percent(run.refusalAccuracy),
    run.requiredContentMissCount.toString(),
    run.missingExpectedFileCount.toString(),
    run.invalidContractCount.toString(),
    run.path
  ]);

  return [
    "# Code Remask-Required Flow Comparison",
    "",
    `- Created at: ${input.createdAt}`,
    `- Run count: ${input.runCount}`,
    "",
    "## Summary",
    "",
    table(
      [
        "Run",
        "Cases",
        "Patch Pass",
        "Outcome",
        "Refusal",
        "Required Content Miss",
        "Missing Expected File",
        "Invalid Contract",
        "Artifact"
      ],
      rows
    ),
    "",
    "## Reading",
    "",
    [
      "This comparison isolates partial-repair behavior rather than binary missing-authority refusal.",
      "A useful remask result should reduce required-content misses or missing expected files without increasing invalid contracts.",
      "If verifier-only and verifier-plus-remask remain equal, the case set still is not exposing a repairable failed region."
    ].join("\n"),
    ...(input.missingRuns.length
      ? [
          "",
          "## Missing Runs",
          "",
          table(["Run", "Expected Suffix"], input.missingRuns.map((run) => [run.label, run.suffix]))
        ]
      : [])
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function percent(value: number): string {
  return `${Number((value * 100).toFixed(1))}%`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
