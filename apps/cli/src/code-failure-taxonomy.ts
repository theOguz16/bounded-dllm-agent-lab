import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CodePatchBenchmarkReport,
  CodePatchCaseScore,
  CodePatchFailureSignal
} from "../../../packages/code-benchmark/src/index.js";

type CodeFailureCategory =
  | "contract_invalid_output"
  | "patch_application_failure"
  | "scope_violation"
  | "forbidden_pattern_violation"
  | "missing_expected_file"
  | "no_effect_patch"
  | "enterprise_missing_authority_guess"
  | "test_failure"
  | "unknown_patch_failure";

type TaxonomyItem = {
  runLabel: string;
  caseId: string;
  family: string;
  realityLevel: string;
  category: CodeFailureCategory;
  reason: string;
  observedFailureSignals: CodePatchFailureSignal[];
  modelPatchKind: string;
  changedFiles: string[];
  rawOutputPreview: string;
};

type TaxonomyRun = {
  label: string;
  path: string;
  engineName: string;
  caseCount: number;
  patchPassRate: number;
  refusalAccuracy: number;
  categoryCounts: Record<CodeFailureCategory, number>;
  items: TaxonomyItem[];
};

const reportDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const outputDir = process.env.CODE_BENCH_REPORT_DIR ?? "reports";
const requestedPaths = process.argv.slice(2);

const reportPaths = requestedPaths.length ? requestedPaths : await findLatestCodeReports(reportDir);

if (!reportPaths.length) {
  throw new Error("No code patch benchmark reports found. Pass report JSON paths or run code model benchmarks first.");
}

const runs: TaxonomyRun[] = [];

for (const path of reportPaths) {
  const report = JSON.parse(await readFile(path, "utf8")) as CodePatchBenchmarkReport;
  runs.push(createTaxonomyRun(path, report));
}

const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-code-failure-taxonomy`;
const jsonPath = join(outputDir, `${runId}.json`);
const markdownPath = join(outputDir, `${runId}.md`);

await mkdir(outputDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify({ createdAt, runs }, null, 2)}\n`);
await writeFile(markdownPath, `${taxonomyToMarkdown(createdAt, runs)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      runCount: runs.length,
      jsonPath,
      markdownPath,
      summaries: runs.map((run) => ({
        label: run.label,
        caseCount: run.caseCount,
        patchPassRate: run.patchPassRate,
        refusalAccuracy: run.refusalAccuracy,
        categoryCounts: run.categoryCounts
      }))
    },
    null,
    2
  )
);

async function findLatestCodeReports(directory: string): Promise<string[]> {
  const files = await readdir(directory).catch(() => []);
  const suffixes = [
    "code-model-patch-benchmark.json",
    "code-model-synthetic-patch-benchmark.json",
    "code-model-expanded-patch-benchmark.json",
    "code-model-rag-patch-benchmark.json",
    "code-dllm-patch-benchmark.json"
  ];

  // Her strateji için en yeni raporu seçiyoruz. Böylece RunPod'da aynı benchmark
  // birkaç kez koşulsa bile taxonomy komutu son geçerli ölçümü okur.
  return suffixes
    .map((suffix) => files.filter((file) => file.endsWith(suffix)).sort().at(-1))
    .filter((file): file is string => Boolean(file))
    .map((file) => join(directory, file));
}

function createTaxonomyRun(path: string, report: CodePatchBenchmarkReport): TaxonomyRun {
  const items = report.cases
    .filter((score) => score.patchMeetsCriteria !== 1 || score.outcomeAsExpected !== 1)
    .map((score) => createTaxonomyItem(createRunLabel(report.engineName), score));

  return {
    label: createRunLabel(report.engineName),
    path,
    engineName: report.engineName,
    caseCount: report.caseCount,
    patchPassRate: report.positiveControlPassRate,
    refusalAccuracy: report.refusalAccuracy,
    categoryCounts: countCategories(items),
    items
  };
}

function createTaxonomyItem(runLabel: string, score: CodePatchCaseScore): TaxonomyItem {
  const category = classifyCodeFailure(score);

  return {
    runLabel,
    caseId: score.caseId,
    family: score.family,
    realityLevel: score.realityLevel,
    category,
    reason: explainCodeFailure(category, score),
    observedFailureSignals: score.observedFailureSignals,
    modelPatchKind: score.modelTrace?.patchKind ?? "(none)",
    changedFiles: score.changedFiles,
    rawOutputPreview: score.modelTrace?.rawOutputPreview ?? "(none)"
  };
}

function classifyCodeFailure(score: CodePatchCaseScore): CodeFailureCategory {
  const signals = new Set(score.observedFailureSignals);

  // Sıralama önemli: aynı case birden fazla sinyal taşıyabilir. Önce model/agent
  // sözleşmesini bozan veya güvenlik sınırını ihlal eden kök sebepleri yakalıyoruz.
  if (signals.has("invalid_model_output")) return "contract_invalid_output";
  if (signals.has("forbidden_file_touch")) return "scope_violation";

  if (score.realityLevel === "enterprise_boundary" && signals.has("refusal_failure")) {
    return "enterprise_missing_authority_guess";
  }

  if (signals.has("patch_application_failure")) return "patch_application_failure";
  if (signals.has("forbidden_pattern_hit")) return "forbidden_pattern_violation";
  if (signals.has("missing_expected_file")) return "missing_expected_file";
  if (signals.has("no_effect_patch")) return "no_effect_patch";
  if (signals.has("test_failure")) return "test_failure";
  return "unknown_patch_failure";
}

function explainCodeFailure(category: CodeFailureCategory, score: CodePatchCaseScore): string {
  if (category === "contract_invalid_output") {
    return "Model did not return a machine-readable patch/refusal contract.";
  }
  if (category === "patch_application_failure") {
    return score.patchApplicationError ?? "Patch could not be applied with exact search/replace.";
  }
  if (category === "scope_violation") {
    return "Patch touched at least one forbidden file.";
  }
  if (category === "forbidden_pattern_violation") {
    return "Patch stayed in files but introduced a forbidden change pattern.";
  }
  if (category === "missing_expected_file") {
    return "Patch did not touch all files required by the benchmark case.";
  }
  if (category === "no_effect_patch") {
    return "Patch applied without producing a repository diff.";
  }
  if (category === "enterprise_missing_authority_guess") {
    return "Enterprise-boundary case required refusal, but the model guessed or edited instead.";
  }
  if (category === "test_failure") {
    return "Patch produced a failing repository check.";
  }
  return "Patch failed the aggregate criteria without a more specific deterministic signal.";
}

function createRunLabel(engineName: string): string {
  if (engineName.includes("code-patch-expanded")) return "Qwen2.5 expanded";
  if (engineName.includes("code-patch-synthetic")) return "Qwen2.5 synthetic";
  if (engineName.includes("code-patch-rag")) return "Qwen2.5 RAG";
  if (engineName.includes("dllm-infill-code-patch")) return "Dream-Coder dLLM";
  if (engineName.includes("openai-compatible-code-patch")) return "Qwen2.5 plain";
  return engineName;
}

function countCategories(items: TaxonomyItem[]): Record<CodeFailureCategory, number> {
  const categories: CodeFailureCategory[] = [
    "contract_invalid_output",
    "patch_application_failure",
    "scope_violation",
    "forbidden_pattern_violation",
    "missing_expected_file",
    "no_effect_patch",
    "enterprise_missing_authority_guess",
    "test_failure",
    "unknown_patch_failure"
  ];
  const counts = Object.fromEntries(categories.map((category) => [category, 0])) as Record<CodeFailureCategory, number>;

  for (const item of items) counts[item.category] += 1;
  return counts;
}

function taxonomyToMarkdown(createdAt: string, runs: TaxonomyRun[]): string {
  const summaryRows = runs.map((run) => [
    run.label,
    run.caseCount.toString(),
    percent(run.patchPassRate),
    percent(run.refusalAccuracy),
    run.categoryCounts.enterprise_missing_authority_guess.toString(),
    run.categoryCounts.contract_invalid_output.toString(),
    run.categoryCounts.forbidden_pattern_violation.toString(),
    run.categoryCounts.no_effect_patch.toString(),
    run.path
  ]);
  const detailRows = runs.flatMap((run) =>
    run.items.map((item) => [
      item.runLabel,
      item.caseId,
      item.realityLevel,
      item.category,
      item.observedFailureSignals.join(", ") || "(none)",
      item.modelPatchKind,
      item.changedFiles.join(", ") || "(none)",
      compact(item.reason),
      compact(item.rawOutputPreview)
    ])
  );

  return [
    "# Code Patch Failure Taxonomy",
    "",
    `- Created at: ${createdAt}`,
    `- Run count: ${runs.length}`,
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
        "Forbidden Pattern",
        "No Effect",
        "Artifact"
      ],
      summaryRows
    ),
    "",
    "## Failure Details",
    "",
    table(
      [
        "Run",
        "Case",
        "Reality",
        "Category",
        "Signals",
        "Patch Kind",
        "Changed Files",
        "Reason",
        "Raw Output"
      ],
      detailRows
    ),
    "",
    "## Reading",
    "",
    "This taxonomy does not replace raw benchmark scores. It explains why failed cases failed.",
    "For this research, `enterprise_missing_authority_guess` is especially important because it marks cases where a model should refuse instead of inventing a product or governance decision.",
    "`contract_invalid_output` is also important because an agentic coding system needs machine-applicable outputs, not only plausible prose."
  ].join("\n");
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

function percent(value: number): string {
  return `${Number((value * 100).toFixed(1))}%`;
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
