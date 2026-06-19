import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type NumericRun = {
  label: string;
  patchPass?: number;
  refusal?: number;
  boundaryGuess?: number;
  invalidContract?: number;
  task?: number;
  evidence?: number;
  trace?: number;
  budget?: number;
};

type CodeFailureTaxonomyReport = {
  runs: Array<{
    label: string;
    patchPassRate: number;
    refusalAccuracy: number;
    categoryCounts: {
      enterprise_missing_authority_guess: number;
      contract_invalid_output: number;
    };
  }>;
};

type LlmContextComparisonReport = {
  runs: Array<{
    label: string;
    taskSuccessRate: number;
    evidenceCoverage: number;
    traceCompletenessRate: number;
    averageContextBudgetUtilization: number;
  }>;
};

const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-research-figures`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

const files = await readdir(reportDir).catch(() => []);
const codeTaxonomyPath = latestFile(files, "code-failure-taxonomy.json");
const llmContextPath = latestFile(files, "llm-context-comparison.json");

const codeRuns = codeTaxonomyPath ? await readCodeTaxonomy(join(reportDir, codeTaxonomyPath)) : [];
const llmRuns = llmContextPath ? await readLlmContextComparison(join(reportDir, llmContextPath)) : [];

if (!codeRuns.length && !llmRuns.length) {
  throw new Error("No research reports found. Run code:failure-taxonomy or reports:llm-context first.");
}

const output = {
  createdAt,
  sources: {
    codeTaxonomyPath: codeTaxonomyPath ? join(reportDir, codeTaxonomyPath) : null,
    llmContextPath: llmContextPath ? join(reportDir, llmContextPath) : null
  },
  codeRuns,
  llmRuns
};

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(markdownPath, `${figuresToMarkdown(output)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      jsonPath,
      markdownPath,
      sources: output.sources,
      figureCount: countFigures(output)
    },
    null,
    2
  )
);

async function readCodeTaxonomy(path: string): Promise<NumericRun[]> {
  const report = JSON.parse(await readFile(path, "utf8")) as CodeFailureTaxonomyReport;

  return report.runs.map((run) => ({
    label: shortenLabel(run.label),
    patchPass: run.patchPassRate,
    refusal: run.refusalAccuracy,
    boundaryGuess: run.categoryCounts.enterprise_missing_authority_guess,
    invalidContract: run.categoryCounts.contract_invalid_output
  }));
}

async function readLlmContextComparison(path: string): Promise<NumericRun[]> {
  const report = JSON.parse(await readFile(path, "utf8")) as LlmContextComparisonReport;

  return report.runs.map((run) => ({
    label: shortenLabel(run.label),
    task: run.taskSuccessRate,
    evidence: run.evidenceCoverage,
    trace: run.traceCompletenessRate,
    budget: run.averageContextBudgetUtilization
  }));
}

function figuresToMarkdown(input: typeof output): string {
  const sections = [
    "# Research Figures",
    "",
    `- Created at: ${input.createdAt}`,
    `- Code taxonomy source: ${input.sources.codeTaxonomyPath ?? "(missing)"}`,
    `- LLM context source: ${input.sources.llmContextPath ?? "(missing)"}`,
    "",
    "These figures are generated from benchmark artifacts. They are visual aids, not replacement metrics.",
    ""
  ];

  if (input.codeRuns.length) {
    sections.push(
      "## Figure 1: Code Patch Pass Rate",
      "",
      xychart({
        title: "Code patch pass rate",
        xLabel: "Run",
        yLabel: "Pass %",
        labels: input.codeRuns.map((run) => run.label),
        values: input.codeRuns.map((run) => toPercent(run.patchPass ?? 0)),
        yMin: 0,
        yMax: 100
      }),
      "",
      table(
        ["Run", "Patch Pass", "Refusal", "Boundary Guess", "Invalid Contract"],
        input.codeRuns.map((run) => [
          run.label,
          percent(run.patchPass ?? 0),
          percent(run.refusal ?? 0),
          String(run.boundaryGuess ?? 0),
          String(run.invalidContract ?? 0)
        ])
      ),
      "",
      "Reading: Qwen variants are strong at producing scoped patches. Dream-Coder direct patching is weak mostly because it breaks the machine-readable patch contract.",
      "",
      "## Figure 2: Enterprise Boundary Guess Count",
      "",
      xychart({
        title: "Enterprise boundary guesses",
        xLabel: "Run",
        yLabel: "Count",
        labels: input.codeRuns.map((run) => run.label),
        values: input.codeRuns.map((run) => run.boundaryGuess ?? 0),
        yMin: 0,
        yMax: Math.max(10, ...input.codeRuns.map((run) => run.boundaryGuess ?? 0))
      }),
      "",
      "Reading: lower is better. Boundary guess means the model should refuse because authority/context is missing, but it guessed or edited anyway.",
      "",
      "## Figure 3: Invalid Machine-Readable Contract Count",
      "",
      xychart({
        title: "Invalid patch/refusal contract",
        xLabel: "Run",
        yLabel: "Count",
        labels: input.codeRuns.map((run) => run.label),
        values: input.codeRuns.map((run) => run.invalidContract ?? 0),
        yMin: 0,
        yMax: Math.max(50, ...input.codeRuns.map((run) => run.invalidContract ?? 0))
      }),
      "",
      "Reading: lower is better. Invalid contract means the model did not produce a machine-applicable patch/refusal object."
    );
  }

  if (input.llmRuns.length) {
    sections.push(
      "",
      "## Figure 4: Behavior Benchmark Task Success",
      "",
      xychart({
        title: "Hard-suite task success",
        xLabel: "Run",
        yLabel: "Task %",
        labels: input.llmRuns.map((run) => run.label),
        values: input.llmRuns.map((run) => toPercent(run.task ?? 0)),
        yMin: 0,
        yMax: 100
      }),
      "",
      table(
        ["Run", "Task", "Evidence", "Trace", "Budget Used"],
        input.llmRuns.map((run) => [
          run.label,
          percent(run.task ?? 0),
          percent(run.evidence ?? 0),
          percent(run.trace ?? 0),
          percent(run.budget ?? 0)
        ])
      ),
      "",
      "Reading: task success, evidence, and trace must be read together. A run can answer more often while becoming less auditable."
    );
  }

  sections.push(
    "",
    "## Figure 5: Research Direction",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Qwen2.5-Coder<br/>strong scoped implementation] --> C[Hybrid shared workspace]",
    "  B[Dream-Coder dLLM<br/>weak direct patch contract] --> C",
    "  C --> D[Verifier / boundary checker]",
    "  C --> E[Remask planner]",
    "  D --> F[Reduce missing-authority guesses]",
    "  E --> G[Repair only uncertain regions]",
    "```",
    "",
    "Reading: the first phase does not prove that one model replaces another. It suggests a role-specialized hybrid architecture."
  );

  return sections.join("\n");
}

function xychart(input: {
  title: string;
  xLabel: string;
  yLabel: string;
  labels: string[];
  values: number[];
  yMin: number;
  yMax: number;
}): string {
  return [
    "```mermaid",
    "xychart-beta",
    `  title "${input.title}"`,
    `  x-axis "${input.xLabel}" [${input.labels.map((label) => `"${label}"`).join(", ")}]`,
    `  y-axis "${input.yLabel}" ${input.yMin} --> ${input.yMax}`,
    `  bar [${input.values.join(", ")}]`,
    "```"
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function latestFile(files: string[], suffix: string): string | undefined {
  return files.filter((file) => file.endsWith(suffix)).sort().at(-1);
}

function shortenLabel(label: string): string {
  return label
    .replace("Qwen2.5 ", "Qwen ")
    .replace("Dream-Coder dLLM", "Dream dLLM")
    .replace("Dream-Coder dLLM bounded", "Dream bounded")
    .replace("Qwen2.5 plain bounded", "Qwen plain")
    .replace("Qwen2.5 RAG-style", "Qwen RAG")
    .replace("Qwen2.5 expanded-context", "Qwen expanded")
    .replace("Qwen2.5 synthetic-context", "Qwen synthetic");
}

function toPercent(value: number): number {
  return Number((value * 100).toFixed(1));
}

function percent(value: number): string {
  return `${toPercent(value)}%`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function countFigures(input: typeof output): number {
  return (input.codeRuns.length ? 3 : 0) + (input.llmRuns.length ? 1 : 0) + 1;
}
