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
