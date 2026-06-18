import type { BenchmarkReport } from "../../eval-core/src/index.js";

export type ExperimentConfig = {
  runId: string;
  suiteName: string;
  architectureName: string;
  engineName: string;
  modelName: string;
  modelVersion: string;
  workerUrl?: string;
  seed: number;
  maxAttempts: number;
  maskPolicyVersion: string;
  gitCommit: string;
  hardware: ExperimentHardware;
  createdAt: string;
};

export type ExperimentHardware = {
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemoryMb: number;
};

export type ExperimentReportPaths = {
  jsonPath: string;
  markdownPath: string;
  manifestPath: string;
};

export type ExperimentRunManifest = ExperimentConfig & {
  caseCount: number;
  reportPaths: ExperimentReportPaths;
  summary: {
    taskSuccessRate: number;
    scopeDriftRate: number;
    sensitiveLeakageRate: number;
    evidenceCoverage: number;
    traceCompletenessRate: number;
  };
};

export type ExperimentComparisonRow = {
  runId: string;
  architectureName: string;
  modelName: string;
  modelVersion: string;
  suiteName: string;
  caseCount: number;
  taskSuccessRate: number;
  scopeDriftRate: number;
  sensitiveLeakageRate: number;
  evidenceCoverage: number;
  traceCompletenessRate: number;
  reportPath: string;
};

export type ExperimentComparisonArtifact = {
  createdAt: string;
  runCount: number;
  rows: ExperimentComparisonRow[];
};

export function createExperimentConfig(input: ExperimentConfig): ExperimentConfig {
  // ExperimentConfig deneyin kimlik kartıdır. Model çıktısını tek başına saklamak
  // yetmez; hangi commit, hangi mimari, hangi worker, hangi seed ve hangi donanım
  // ile üretildiğini de kaydetmezsek sonuçlar sonradan bilimsel olarak izlenemez.
  return input;
}

export function createRunManifest(input: {
  config: ExperimentConfig;
  report: BenchmarkReport;
  reportPaths: ExperimentReportPaths;
}): ExperimentRunManifest {
  // Manifest raporun üstüne yazılan araştırma bağlamıdır. JSON/Markdown "ne oldu?"
  // sorusuna cevap verir; manifest ise "bu sonuç hangi koşullarda oldu?" sorusuna
  // cevap verir. Gerçek GPU deneylerine geçmeden önce bu iz şarttır.
  return {
    ...input.config,
    caseCount: input.report.cases.length,
    reportPaths: input.reportPaths,
    summary: {
      taskSuccessRate: input.report.taskSuccessRate,
      scopeDriftRate: input.report.scopeDriftRate,
      sensitiveLeakageRate: input.report.sensitiveLeakageRate,
      evidenceCoverage: input.report.evidenceCoverage,
      traceCompletenessRate: input.report.traceCompletenessRate
    }
  };
}

export function validateRunManifest(manifest: ExperimentRunManifest): string[] {
  const failures: string[] = [];

  // Manifest validation model kalitesini ölçmez; deney kaydının güvenilir olup
  // olmadığını ölçer. Eğer runId, git commit veya report path eksikse üretilen skor
  // sonradan hangi koşula ait bilinemez.
  if (!manifest.runId.trim()) failures.push("runId is required");
  if (!manifest.suiteName.trim()) failures.push("suiteName is required");
  if (!manifest.architectureName.trim()) failures.push("architectureName is required");
  if (!manifest.engineName.trim()) failures.push("engineName is required");
  if (!manifest.modelName.trim()) failures.push("modelName is required");
  if (!manifest.modelVersion.trim()) failures.push("modelVersion is required");
  if (!Number.isInteger(manifest.seed)) failures.push("seed must be an integer");
  if (manifest.maxAttempts <= 0) failures.push("maxAttempts must be positive");
  if (!manifest.maskPolicyVersion.trim()) failures.push("maskPolicyVersion is required");
  if (!manifest.gitCommit.trim()) failures.push("gitCommit is required");
  if (manifest.caseCount <= 0) failures.push("caseCount must be positive");
  if (!manifest.reportPaths.jsonPath.trim()) failures.push("jsonPath is required");
  if (!manifest.reportPaths.markdownPath.trim()) failures.push("markdownPath is required");
  if (!manifest.reportPaths.manifestPath.trim()) failures.push("manifestPath is required");
  if (manifest.hardware.cpuCount <= 0) failures.push("hardware.cpuCount must be positive");
  if (manifest.hardware.totalMemoryMb <= 0) failures.push("hardware.totalMemoryMb must be positive");

  return failures;
}

export function createComparisonArtifact(input: {
  createdAt: string;
  manifests: ExperimentRunManifest[];
}): ExperimentComparisonArtifact {
  // Comparison artifact, tek tek raporlardan araştırma tablosuna geçiştir. Bir
  // mimarinin iyi görünüp görünmediğini anlamak için raporları tek tek açmak yerine
  // aynı metrikleri yan yana görmek gerekir.
  const rows = input.manifests.map((manifest) => ({
    runId: manifest.runId,
    architectureName: manifest.architectureName,
    modelName: manifest.modelName,
    modelVersion: manifest.modelVersion,
    suiteName: manifest.suiteName,
    caseCount: manifest.caseCount,
    taskSuccessRate: manifest.summary.taskSuccessRate,
    scopeDriftRate: manifest.summary.scopeDriftRate,
    sensitiveLeakageRate: manifest.summary.sensitiveLeakageRate,
    evidenceCoverage: manifest.summary.evidenceCoverage,
    traceCompletenessRate: manifest.summary.traceCompletenessRate,
    reportPath: manifest.reportPaths.markdownPath
  }));

  return {
    createdAt: input.createdAt,
    runCount: rows.length,
    rows: rows.sort((left, right) => left.architectureName.localeCompare(right.architectureName))
  };
}

export function comparisonArtifactToMarkdown(artifact: ExperimentComparisonArtifact): string {
  const rows = artifact.rows.map((row) => [
    row.architectureName,
    row.modelName,
    row.suiteName,
    row.caseCount.toString(),
    percent(row.taskSuccessRate),
    percent(row.scopeDriftRate),
    percent(row.sensitiveLeakageRate),
    percent(row.evidenceCoverage),
    percent(row.traceCompletenessRate),
    row.reportPath
  ]);

  return [
    "# Experiment Comparison",
    "",
    `- Created at: ${artifact.createdAt}`,
    `- Run count: ${artifact.runCount}`,
    "",
    table(
      ["Architecture", "Model", "Suite", "Cases", "Task", "Drift", "Leakage", "Evidence", "Trace", "Report"],
      rows
    ),
    ""
  ].join("\n");
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
