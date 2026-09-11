import {
  PRODUCT_COMPARISON_EVALUATION_VERSION,
  PRODUCT_STATS_VERSION,
  aggregateProductStats,
  type ProductStats,
  type ProductStatsArmObservation,
  type ProductStatsComparisonObservation
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type { CliCommandResult, CliJson } from "../bounded-task.js";
import { CliError } from "../cli-errors.js";
import { findGitRepositoryRoot } from "../product-config.js";
import {
  listStoredProductRunArtifacts,
  readStoredProductRunBundle
} from "../run-artifact-store.js";

export const BOUNDED_STATS_VERSION = "bounded-stats/v1" as const;
export const DEFAULT_STATS_LAST = 20;
export const MAX_STATS_LAST = 1000;

export type StatsCommandInput = Readonly<{ last?: number }>;

export type StatsCommandOutput = Readonly<{
  ok: true;
  command: "stats";
  statsVersion: typeof BOUNDED_STATS_VERSION;
  productStatsVersion: typeof PRODUCT_STATS_VERSION;
  requestedLast: number;
  comparisonRuns: number;
  comparableRuns: number;
  normal: ProductStats["normal"];
  bounded: ProductStats["bounded"];
  delta: ProductStats["delta"];
  table: string;
}>;

function record(value: unknown): CliJson | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CliJson
    : null;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  throw new CliError("cli_stats_comparison_invalid", `${field} must be boolean or null.`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new CliError(
    "cli_stats_comparison_invalid",
    `${field} must be a finite non-negative number or null.`
  );
}

function requiredRecord(value: unknown, field: string): CliJson {
  const result = record(value);
  if (result === null) {
    throw new CliError("cli_stats_comparison_invalid", `${field} must be an object.`);
  }
  return result;
}

function humanDecision(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["accept", "accepted", "approve", "approved", "apply", "applied"].includes(normalized)) {
    return true;
  }
  if (["reject", "rejected", "deny", "denied", "decline", "declined"].includes(normalized)) {
    return false;
  }
  return null;
}

function firstHumanDecision(...values: unknown[]): boolean | null {
  for (const value of values) {
    const decision = humanDecision(value);
    if (decision !== null) return decision;
  }
  return null;
}

function armObservation(
  evaluationValue: unknown,
  humanCandidates: readonly unknown[],
  field: string
): ProductStatsArmObservation {
  const evaluation = requiredRecord(evaluationValue, field);
  if (evaluation.schemaVersion !== PRODUCT_COMPARISON_EVALUATION_VERSION) {
    throw new CliError(
      "cli_stats_comparison_invalid",
      `${field}.schemaVersion must be ${PRODUCT_COMPARISON_EVALUATION_VERSION}.`
    );
  }
  const correctness = requiredRecord(evaluation.correctness, `${field}.correctness`);
  const control = requiredRecord(evaluation.control, `${field}.control`);
  const efficiency = requiredRecord(evaluation.efficiency, `${field}.efficiency`);

  return Object.freeze({
    taskSucceeded: nullableBoolean(correctness.taskSucceeded, `${field}.correctness.taskSucceeded`),
    controlPassed: nullableBoolean(correctness.controlPassed, `${field}.correctness.controlPassed`),
    behaviorSatisfied: nullableBoolean(
      correctness.behaviorSatisfied,
      `${field}.correctness.behaviorSatisfied`
    ),
    inputTokens: nullableNumber(efficiency.inputTokens, `${field}.efficiency.inputTokens`),
    outputTokens: nullableNumber(efficiency.outputTokens, `${field}.efficiency.outputTokens`),
    exposedBytes: nullableNumber(efficiency.exposedBytes, `${field}.efficiency.exposedBytes`),
    durationMs: nullableNumber(efficiency.durationMs, `${field}.efficiency.durationMs`),
    scopeViolationCount: nullableNumber(
      control.scopeViolationCount,
      `${field}.control.scopeViolationCount`
    ),
    humanAccepted: firstHumanDecision(...humanCandidates)
  });
}

export function productStatsObservationFromComparison(
  value: unknown
): ProductStatsComparisonObservation {
  const comparison = requiredRecord(value, "comparison");
  if (typeof comparison.comparable !== "boolean") {
    throw new CliError(
      "cli_stats_comparison_invalid",
      "comparison.comparable must be boolean."
    );
  }
  const evaluations = requiredRecord(comparison.evaluations, "comparison.evaluations");
  const normalDisplay = record(comparison.normal) ?? {};
  const boundedDisplay = record(comparison.bounded) ?? {};
  const humanAcceptance = record(comparison.humanAcceptance) ?? {};
  const humanLabels = record(comparison.humanLabels) ?? {};

  return Object.freeze({
    comparable: comparison.comparable,
    normal: armObservation(
      evaluations.normal,
      [
        normalDisplay.humanAccepted,
        normalDisplay.humanAcceptance,
        normalDisplay.humanDecision,
        humanAcceptance.normal,
        humanLabels.normal
      ],
      "comparison.evaluations.normal"
    ),
    bounded: armObservation(
      evaluations.bounded,
      [
        boundedDisplay.humanAccepted,
        boundedDisplay.humanAcceptance,
        boundedDisplay.humanDecision,
        humanAcceptance.bounded,
        humanLabels.bounded
      ],
      "comparison.evaluations.bounded"
    )
  });
}

function formatRate(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatRateDelta(value: number | null): string {
  if (value === null) return "N/A";
  const points = value * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function formatNumber(value: number | null): string {
  if (value === null) return "N/A";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatNumberDelta(value: number | null): string {
  if (value === null) return "N/A";
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
}

function byteMagnitude(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1024) return `${Math.round(absolute * 10) / 10} B`;
  if (absolute < 1024 * 1024) return `${Math.round((absolute / 1024) * 10) / 10} KB`;
  return `${Math.round((absolute / (1024 * 1024)) * 10) / 10} MB`;
}

function formatBytes(value: number | null): string {
  return value === null ? "N/A" : byteMagnitude(value);
}

function formatBytesDelta(value: number | null): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${byteMagnitude(value)}`;
}

function durationMagnitude(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1000) return `${Math.round(absolute * 10) / 10} ms`;
  return `${Math.round((absolute / 1000) * 10) / 10} s`;
}

function formatDuration(value: number | null): string {
  return value === null ? "N/A" : durationMagnitude(value);
}

function formatDurationDelta(value: number | null): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${durationMagnitude(value)}`;
}

type StatsTableRow = Readonly<{
  label: string;
  normal: string;
  bounded: string;
  delta: string;
}>;

export function formatProductStatsTable(stats: ProductStats): string {
  const rows: StatsTableRow[] = [
    {
      label: "Task success rate",
      normal: formatRate(stats.normal.taskSuccessRate),
      bounded: formatRate(stats.bounded.taskSuccessRate),
      delta: formatRateDelta(stats.delta.taskSuccessRate)
    },
    {
      label: "Control pass rate",
      normal: formatRate(stats.normal.controlPassRate),
      bounded: formatRate(stats.bounded.controlPassRate),
      delta: formatRateDelta(stats.delta.controlPassRate)
    },
    {
      label: "Behavior success rate",
      normal: formatRate(stats.normal.behaviorSuccessRate),
      bounded: formatRate(stats.bounded.behaviorSuccessRate),
      delta: formatRateDelta(stats.delta.behaviorSuccessRate)
    },
    {
      label: "Median input tokens",
      normal: formatNumber(stats.normal.medianInputTokens),
      bounded: formatNumber(stats.bounded.medianInputTokens),
      delta: formatNumberDelta(stats.delta.medianInputTokens)
    },
    {
      label: "Median output tokens",
      normal: formatNumber(stats.normal.medianOutputTokens),
      bounded: formatNumber(stats.bounded.medianOutputTokens),
      delta: formatNumberDelta(stats.delta.medianOutputTokens)
    },
    {
      label: "Median exposed bytes",
      normal: formatBytes(stats.normal.medianExposedBytes),
      bounded: formatBytes(stats.bounded.medianExposedBytes),
      delta: formatBytesDelta(stats.delta.medianExposedBytes)
    },
    {
      label: "Median duration",
      normal: formatDuration(stats.normal.medianDuration),
      bounded: formatDuration(stats.bounded.medianDuration),
      delta: formatDurationDelta(stats.delta.medianDuration)
    },
    {
      label: "Scope violation rate",
      normal: formatRate(stats.normal.scopeViolationRate),
      bounded: formatRate(stats.bounded.scopeViolationRate),
      delta: formatRateDelta(stats.delta.scopeViolationRate)
    },
    {
      label: "Human acceptance rate",
      normal: formatRate(stats.normal.humanAcceptanceRate),
      bounded: formatRate(stats.bounded.humanAcceptanceRate),
      delta: formatRateDelta(stats.delta.humanAcceptanceRate)
    }
  ];

  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const normalWidth = Math.max("NORMAL".length, ...rows.map((row) => row.normal.length));
  const boundedWidth = Math.max("BOUNDED".length, ...rows.map((row) => row.bounded.length));
  const deltaWidth = Math.max("Δ".length, ...rows.map((row) => row.delta.length));
  const header = `${"".padEnd(labelWidth)}  ${"NORMAL".padStart(normalWidth)}  ${"BOUNDED".padStart(boundedWidth)}  ${"Δ".padStart(deltaWidth)}`;
  return [
    header.trimEnd(),
    ...rows.map((row) =>
      `${row.label.padEnd(labelWidth)}  ${row.normal.padStart(normalWidth)}  ${row.bounded.padStart(boundedWidth)}  ${row.delta.padStart(deltaWidth)}`.trimEnd()
    )
  ].join("\n");
}

function normalizeLast(value: number | undefined): number {
  const resolved = value ?? DEFAULT_STATS_LAST;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_STATS_LAST) {
    throw new CliError(
      "cli_stats_last_invalid",
      `--last must be an integer between 1 and ${MAX_STATS_LAST}.`
    );
  }
  return resolved;
}

export async function statsCommand(
  raw: StatsCommandInput = {},
  startPath = process.cwd()
): Promise<CliCommandResult> {
  const last = normalizeLast(raw.last);
  const repositoryRoot = await findGitRepositoryRoot(startPath);
  const artifacts = await listStoredProductRunArtifacts(repositoryRoot);
  const selected = artifacts
    .filter(({ artifact }) => artifact.runKind === "compare")
    .slice(0, last);

  const observations: ProductStatsComparisonObservation[] = [];
  for (const { artifact } of selected) {
    const bundle = await readStoredProductRunBundle(repositoryRoot, artifact.runId);
    if (bundle.comparison === null) {
      throw new CliError(
        "cli_stats_comparison_invalid",
        `Compare artifact ${artifact.runId} is missing comparison.json.`
      );
    }
    observations.push(productStatsObservationFromComparison(bundle.comparison));
  }

  const stats = aggregateProductStats(observations);
  const output: StatsCommandOutput = Object.freeze({
    ok: true,
    command: "stats",
    statsVersion: BOUNDED_STATS_VERSION,
    productStatsVersion: stats.schemaVersion,
    requestedLast: last,
    comparisonRuns: stats.sampleCount,
    comparableRuns: stats.comparableRuns,
    normal: stats.normal,
    bounded: stats.bounded,
    delta: stats.delta,
    table: formatProductStatsTable(stats)
  });

  return Object.freeze({ output, exitCode: 0 });
}
