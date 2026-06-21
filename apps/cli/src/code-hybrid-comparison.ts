import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodePatchBenchmarkReport, CodePatchCaseScore } from "../../../packages/code-benchmark/src/index.js";

type HybridRun = {
  label: string;
  suffix: string;
  path?: string;
  report?: CodePatchBenchmarkReport;
};

const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-code-hybrid-comparison`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

const runs: HybridRun[] = [
  { label: "Qwen direct", suffix: "code-model-patch-benchmark.json" },
  { label: "Qwen workspace", suffix: "code-model-workspace-patch-benchmark.json" },
  { label: "Qwen workspace verifier", suffix: "code-model-workspace-verifier-patch-benchmark.json" },
  { label: "Qwen workspace verifier remask", suffix: "code-model-workspace-verifier-remask-patch-benchmark.json" }
];

const files = await readdir(reportDir).catch(() => []);
const loadedRuns = await Promise.all(runs.map((run) => loadLatestRun(run, files)));
const availableRuns = loadedRuns.filter((run): run is HybridRun & { path: string; report: CodePatchBenchmarkReport } => Boolean(run.path && run.report));
const missingRuns = loadedRuns.filter((run) => !run.report).map((run) => ({ label: run.label, suffix: run.suffix }));

if (!availableRuns.length) {
  throw new Error("No hybrid code benchmark reports found. Run code:model-benchmark and workspace benchmark modes first.");
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
    allowedFileAccuracy: run.report.allowedFileAccuracy,
    expectedFileCoverage: run.report.expectedFileCoverage,
    forbiddenPatternHitRate: run.report.forbiddenPatternHitRate,
    enterpriseBoundaryGuessCount: countEnterpriseBoundaryGuesses(run.report.cases),
    invalidContractCount: countInvalidContracts(run.report.cases)
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
        refusalAccuracy: run.refusalAccuracy,
        enterpriseBoundaryGuessCount: run.enterpriseBoundaryGuessCount,
        invalidContractCount: run.invalidContractCount
      }))
    },
    null,
    2
  )
);

async function loadLatestRun(run: HybridRun, files: string[]): Promise<HybridRun> {
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

function countEnterpriseBoundaryGuesses(scores: CodePatchCaseScore[]): number {
  return scores.filter((score) =>
    score.realityLevel === "enterprise_boundary" &&
    score.observedFailureSignals.includes("refusal_failure")
  ).length;
}

function countInvalidContracts(scores: CodePatchCaseScore[]): number {
  return scores.filter((score) => score.observedFailureSignals.includes("invalid_model_output")).length;
}

function comparisonToMarkdown(input: typeof comparison): string {
  const rows = input.runs.map((run) => [
    run.label,
    run.caseCount.toString(),
    percent(run.patchPassRate),
    percent(run.refusalAccuracy),
    run.enterpriseBoundaryGuessCount.toString(),
    run.invalidContractCount.toString(),
    percent(run.allowedFileAccuracy),
    percent(run.expectedFileCoverage),
    run.path
  ]);

  const sections = [
    "# Code Hybrid Agent Flow Comparison",
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
        "Refusal",
        "Boundary Guess",
        "Invalid Contract",
        "Allowed Files",
        "Expected Files",
        "Artifact"
      ],
      rows
    ),
    "",
    "## Reading",
    "",
    [
      "This comparison isolates agent flow while keeping the model-facing code benchmark family constant.",
      "The core product-validation question is whether workspace/verifier/remask flow reduces enterprise boundary guesses without destroying patch pass rate.",
      "Lower boundary guess and invalid contract counts are better. Patch pass must be read together with refusal accuracy."
    ].join("\n")
  ];

  if (input.missingRuns.length) {
    sections.push(
      "",
      "## Missing Runs",
      "",
      table(
        ["Run", "Expected Suffix"],
        input.missingRuns.map((run) => [run.label, run.suffix])
      )
    );
  }

  return sections.join("\n");
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
