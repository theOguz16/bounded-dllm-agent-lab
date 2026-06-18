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
