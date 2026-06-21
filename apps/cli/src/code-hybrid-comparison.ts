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
  })),
  remaskDelta: createRemaskDelta(availableRuns)
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

function createRemaskDelta(runs: Array<HybridRun & { path: string; report: CodePatchBenchmarkReport }>) {
  const verifier = runs.find((run) => run.label === "Qwen workspace verifier")?.report;
  const remask = runs.find((run) => run.label === "Qwen workspace verifier remask")?.report;

  if (!verifier || !remask) return null;

  const verifierBoundaryGuessCount = countEnterpriseBoundaryGuesses(verifier.cases);
  const remaskBoundaryGuessCount = countEnterpriseBoundaryGuesses(remask.cases);
  const patchPassDelta = remask.positiveControlPassRate - verifier.positiveControlPassRate;
  const refusalDelta = remask.refusalAccuracy - verifier.refusalAccuracy;
  const boundaryGuessDelta = remaskBoundaryGuessCount - verifierBoundaryGuessCount;

  // Bu alan remask sonucunu tek kelimeye sıkıştırmaz; araştırma yorumunu düzenli tutar.
  // Pozitif delta varsa remask ek değer vermiştir, negatif delta varsa zarar vermiştir.
  // Hepsi sıfırsa bu suite remask gerektiren hatayı görünür kılmamış demektir.
  const interpretation =
    patchPassDelta > 0 || refusalDelta > 0 || boundaryGuessDelta < 0
      ? "positive"
      : patchPassDelta < 0 || refusalDelta < 0 || boundaryGuessDelta > 0
        ? "negative"
        : "neutral";

  return {
    verifierPatchPassRate: verifier.positiveControlPassRate,
    remaskPatchPassRate: remask.positiveControlPassRate,
    patchPassDelta,
    verifierRefusalAccuracy: verifier.refusalAccuracy,
    remaskRefusalAccuracy: remask.refusalAccuracy,
    refusalDelta,
    verifierBoundaryGuessCount,
    remaskBoundaryGuessCount,
    boundaryGuessDelta,
    interpretation
  };
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

  if (input.remaskDelta) {
    sections.push(
      "",
      "## Verifier vs Remask Delta",
      "",
      table(
        ["Metric", "Verifier", "Verifier + Remask", "Delta"],
        [
          [
            "Patch Pass",
            percent(input.remaskDelta.verifierPatchPassRate),
            percent(input.remaskDelta.remaskPatchPassRate),
            signedPercent(input.remaskDelta.patchPassDelta)
          ],
          [
            "Refusal",
            percent(input.remaskDelta.verifierRefusalAccuracy),
            percent(input.remaskDelta.remaskRefusalAccuracy),
            signedPercent(input.remaskDelta.refusalDelta)
          ],
          [
            "Boundary Guess",
            input.remaskDelta.verifierBoundaryGuessCount.toString(),
            input.remaskDelta.remaskBoundaryGuessCount.toString(),
            signedNumber(input.remaskDelta.boundaryGuessDelta)
          ]
        ]
      ),
      "",
      `Interpretation: ${input.remaskDelta.interpretation}.`,
      "",
      input.remaskDelta.interpretation === "neutral"
        ? "In this run, remask did not harm the verifier flow, but it also did not add measurable improvement. This usually means the current cases were resolved or rejected by the verifier before a targeted remask could create a separate gain."
        : input.remaskDelta.interpretation === "positive"
          ? "In this run, remask added measurable value over verifier-only flow."
          : "In this run, remask reduced at least one key metric and should be inspected before being treated as a product improvement."
    );
  }

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

function signedPercent(value: number): string {
  const formatted = percent(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : "0%";
}

function signedNumber(value: number): string {
  return value > 0 ? `+${value}` : value.toString();
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
