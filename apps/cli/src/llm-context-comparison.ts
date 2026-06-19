import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkArtifact, FailureTaxonomyCategory } from "../../../packages/eval-core/src/index.js";

type ComparisonRun = {
  id: string;
  label: string;
  fileSuffix: string;
  artifact?: BenchmarkArtifact;
  path?: string;
};

const reportDir = "reports";
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-llm-context-comparison`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

const runs: ComparisonRun[] = [
  {
    id: "bounded_dllm",
    label: "Dream-Coder dLLM bounded",
    fileSuffix: "-worker-hard-benchmark.json"
  },
  {
    id: "plain_llm",
    label: "Qwen2.5 plain bounded",
    fileSuffix: "-llm-hard-baseline.json"
  },
  {
    id: "rag_llm",
    label: "Qwen2.5 RAG-style",
    fileSuffix: "-llm-rag-hard-baseline.json"
  },
  {
    id: "expanded_llm",
    label: "Qwen2.5 expanded-context",
    fileSuffix: "-llm-expanded-hard-baseline.json"
  },
  {
    id: "synthetic_llm",
    label: "Qwen2.5 synthetic-context",
    fileSuffix: "-llm-synthetic-hard-baseline.json"
  }
];

const files = await readdir(reportDir);
const loadedRuns = await Promise.all(runs.map((run) => loadLatestRun(run, files)));
const missingRuns = loadedRuns.filter((run) => !run.artifact).map((run) => ({ id: run.id, label: run.label, suffix: run.fileSuffix }));
const availableRuns = loadedRuns.filter((run): run is ComparisonRun & { artifact: BenchmarkArtifact; path: string } => Boolean(run.artifact && run.path));

const comparison = {
  createdAt,
  runCount: availableRuns.length,
  missingRuns,
  runs: availableRuns.map((run) => ({
    id: run.id,
    label: run.label,
    path: run.path,
    suiteName: run.artifact.suiteName,
    engineName: run.artifact.engineName,
    scenarioCount: run.artifact.report.cases.length,
    taskSuccessRate: run.artifact.report.taskSuccessRate,
    scopeDriftRate: run.artifact.report.scopeDriftRate,
    sensitiveLeakageRate: run.artifact.report.sensitiveLeakageRate,
    evidenceCoverage: run.artifact.report.evidenceCoverage,
    traceCompletenessRate: run.artifact.report.traceCompletenessRate,
    averageContextBudgetUtilization: run.artifact.report.averageContextBudgetUtilization,
    failureTaxonomy: countFailureTaxonomy(run.artifact)
  }))
};

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(markdownPath, comparisonToMarkdown(comparison));

console.log(
  JSON.stringify(
    {
      ok: true,
      runCount: comparison.runCount,
      missingRuns,
      jsonPath,
      markdownPath
    },
    null,
    2
  )
);

async function loadLatestRun(run: ComparisonRun, files: string[]): Promise<ComparisonRun> {
  const latest = files
    .filter((file) => file.endsWith(run.fileSuffix))
    .filter((file) => !file.endsWith(".manifest.json") && !file.endsWith(".checkpoint.json"))
    .sort()
    .reverse()[0];

  if (!latest) return run;

  const path = join(reportDir, latest);
  const artifact = JSON.parse(await readFile(path, "utf8")) as BenchmarkArtifact;

  return { ...run, path, artifact };
}

function countFailureTaxonomy(artifact: BenchmarkArtifact): Record<FailureTaxonomyCategory, number> {
  const counts: Record<FailureTaxonomyCategory, number> = {
    semantic_match_but_keyword_fail: 0,
    true_task_failure: 0,
    missing_evidence_or_trace: 0,
    boundary_failure: 0,
    leakage_or_scope_violation: 0
  };

  for (const item of artifact.failureTaxonomy ?? []) {
    counts[item.category] += 1;
  }

  return counts;
}

function comparisonToMarkdown(input: typeof comparison): string {
  const summaryRows = input.runs.map((run) => [
    run.label,
    run.scenarioCount.toString(),
    percent(run.taskSuccessRate),
    percent(run.scopeDriftRate),
    percent(run.sensitiveLeakageRate),
    percent(run.evidenceCoverage),
    percent(run.traceCompletenessRate),
    percent(run.averageContextBudgetUtilization),
    run.path
  ]);
  const taxonomyRows = input.runs.map((run) => [
    run.label,
    run.failureTaxonomy.semantic_match_but_keyword_fail.toString(),
    run.failureTaxonomy.true_task_failure.toString(),
    run.failureTaxonomy.missing_evidence_or_trace.toString(),
    run.failureTaxonomy.boundary_failure.toString(),
    run.failureTaxonomy.leakage_or_scope_violation.toString()
  ]);
  const sections = [
    [
      "# LLM Context Strategy Comparison",
      "",
      `- Created at: ${input.createdAt}`,
      `- Run count: ${input.runCount}`
    ].join("\n"),
    [
      "## Summary",
      "",
      table(
        ["Run", "Cases", "Task", "Drift", "Leakage", "Evidence", "Trace", "Budget Used", "Artifact"],
        summaryRows
      )
    ].join("\n"),
    [
      "## Failure Taxonomy",
      "",
      table(
        ["Run", "Semantic Keyword", "True Task", "Evidence/Trace Gap", "Boundary", "Leakage/Scope"],
        taxonomyRows
      )
    ].join("\n"),
    [
      "## Reading",
      "",
      [
        "This comparison holds the hard-suite benchmark shape constant and changes the model/context strategy column.",
        "Scope drift and leakage at 0% mean this benchmark did not observe forbidden-term or raw-sensitive-output violations; it does not prove all forms of scope control are solved.",
        "Evidence and trace should be read beside task success because expanded context can improve final answers while weakening auditability."
      ].join("\n")
    ].join("\n")
  ];

  if (input.missingRuns.length) {
    sections.push(
      [
        "## Missing Runs",
        "",
        table(
          ["Run", "Expected Suffix"],
          input.missingRuns.map((run) => [run.label, run.suffix])
        )
      ].join("\n")
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}
