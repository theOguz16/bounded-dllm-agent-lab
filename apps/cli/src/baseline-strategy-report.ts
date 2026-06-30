import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BaselineStrategyUnavailableError,
  listBaselineStrategies,
  runBaselineStrategy,
  type BaselineStrategy,
  type BaselineStrategyRunInput
} from "../../../packages/baseline-core/src/index.js";

type StrategyAvailability = "available" | "unavailable";

type StrategyMetadataReportItem = {
  id: string;
  label: string;
  description: string;
  capabilities: string[];
  modelRequired: boolean;
  deterministic: boolean;
  availability: StrategyAvailability;
  sampleDecision: string | null;
  sampleMergeSafe: boolean | null;
  sampleEstimatedTokens: number | null;
  unavailableReason: string | null;
};

type BaselineStrategyMetadataReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  strategyCount: number;
  modelFreeCount: number;
  modelRequiredCount: number;
  deterministicCount: number;
  workerBackedCount: number;
  availableCount: number;
  unavailableCount: number;
  defaultStrategy: string;
  strategies: StrategyMetadataReportItem[];
};

const reportName = "baseline-strategy-metadata-report-v1";
const suiteName = "phase-k-baseline-strategy-catalog";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const reportDir = "reports/baseline-comparison";
const defaultStrategy = process.env.BASELINE_STRATEGY ?? "direct_broad_context_mock";

const sampleInput: BaselineStrategyRunInput = {
  changedFiles: [
    "apps/cli/src/baseline-comparison-report.ts",
    "packages/baseline-core/src/index.ts",
    "package.json"
  ],
  scannedFileCount: 188,
  sensitivePatternCount: 20,
  staleFactCount: 3,
  moduleBoundaryCount: 2,
  conflicts: [
    { kind: "stale_authority" },
    { kind: "remask_unresolved" }
  ],
  bounded: {
    estimatedTokens: 3800
  }
};

await runReport();

async function runReport(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const strategies = listBaselineStrategies();
  const items = strategies.map((strategy) => describeStrategy(strategy));

  const report: BaselineStrategyMetadataReport = {
    ok: true,
    reportName,
    createdAt,
    suiteName,
    strategyCount: items.length,
    modelFreeCount: items.filter((item) => !item.modelRequired).length,
    modelRequiredCount: items.filter((item) => item.modelRequired).length,
    deterministicCount: items.filter((item) => item.deterministic).length,
    workerBackedCount: items.filter((item) => item.capabilities.includes("worker_backed")).length,
    availableCount: items.filter((item) => item.availability === "available").length,
    unavailableCount: items.filter((item) => item.availability === "unavailable").length,
    defaultStrategy,
    strategies: items
  };

  const jsonPath = join(reportDir, `${safeTimestamp}-baseline-strategy-metadata-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-baseline-strategy-metadata-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        suiteName,
        strategyCount: report.strategyCount,
        modelFreeCount: report.modelFreeCount,
        modelRequiredCount: report.modelRequiredCount,
        deterministicCount: report.deterministicCount,
        workerBackedCount: report.workerBackedCount,
        availableCount: report.availableCount,
        unavailableCount: report.unavailableCount,
        defaultStrategy: report.defaultStrategy,
        jsonPath,
        markdownPath,
        strategies: report.strategies.map((strategy) => ({
          id: strategy.id,
          modelRequired: strategy.modelRequired,
          deterministic: strategy.deterministic,
          availability: strategy.availability,
          unavailableReason: strategy.unavailableReason
        }))
      },
      null,
      2
    )
  );
}

function describeStrategy(strategy: BaselineStrategy): StrategyMetadataReportItem {
  try {
    const result = runBaselineStrategy({
      strategy,
      baselineInput: sampleInput
    });

    return {
      id: strategy.metadata.id,
      label: strategy.metadata.label,
      description: strategy.metadata.description,
      capabilities: strategy.metadata.capabilities,
      modelRequired: strategy.metadata.modelRequired,
      deterministic: strategy.metadata.deterministic,
      availability: "available",
      sampleDecision: result.output.decision,
      sampleMergeSafe: result.output.mergeSafe,
      sampleEstimatedTokens: result.output.estimatedTokens,
      unavailableReason: null
    };
  } catch (error) {
    if (error instanceof BaselineStrategyUnavailableError) {
      return {
        id: strategy.metadata.id,
        label: strategy.metadata.label,
        description: strategy.metadata.description,
        capabilities: strategy.metadata.capabilities,
        modelRequired: strategy.metadata.modelRequired,
        deterministic: strategy.metadata.deterministic,
        availability: "unavailable",
        sampleDecision: null,
        sampleMergeSafe: null,
        sampleEstimatedTokens: null,
        unavailableReason: error.reason
      };
    }

    throw error;
  }
}

function reportToMarkdown(report: BaselineStrategyMetadataReport): string {
  const lines: string[] = [];

  lines.push(`# Baseline Strategy Metadata Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Default strategy: \`${report.defaultStrategy}\``);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Strategies | ${report.strategyCount} |`);
  lines.push(`| Model-free | ${report.modelFreeCount} |`);
  lines.push(`| Model-required | ${report.modelRequiredCount} |`);
  lines.push(`| Deterministic | ${report.deterministicCount} |`);
  lines.push(`| Worker-backed | ${report.workerBackedCount} |`);
  lines.push(`| Available | ${report.availableCount} |`);
  lines.push(`| Unavailable | ${report.unavailableCount} |`);
  lines.push("");

  lines.push(`## Strategies`);
  lines.push("");
  lines.push(`| Strategy | Label | Model Required | Deterministic | Availability | Capabilities | Unavailable Reason |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);

  for (const strategy of report.strategies) {
    lines.push(
      `| \`${escapeMarkdownCell(strategy.id)}\` | ${escapeMarkdownCell(strategy.label)} | ${strategy.modelRequired} | ${strategy.deterministic} | ${strategy.availability} | ${escapeMarkdownCell(strategy.capabilities.join(", "))} | ${escapeMarkdownCell(strategy.unavailableReason ?? "(none)")} |`
    );
  }

  lines.push("");

  lines.push(`## Descriptions`);
  lines.push("");

  for (const strategy of report.strategies) {
    lines.push(`### \`${strategy.id}\``);
    lines.push("");
    lines.push(strategy.description);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
}
