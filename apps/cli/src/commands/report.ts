import type { ProductRunArtifact } from "../../../../packages/product-runtime/src/product-run-artifact.js";
import { findGitRepositoryRoot } from "../product-config.js";
import {
  readStoredProductRunBundle,
  type StoredProductRunBundle
} from "../run-artifact-store.js";
import type { CliCommandResult, CliJson } from "../bounded-task.js";

function record(value: unknown): CliJson | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CliJson
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  }
  return null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return [...value];
}

function normalizedStringArray(...values: unknown[]): string[] | null {
  for (const value of values) {
    const array = stringArray(value);
    if (array !== null) {
      return [...new Set(array)].sort((left, right) => left.localeCompare(right, "en"));
    }
  }
  return null;
}

function commandList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? [...value] : null;
}

function taskText(run: CliJson): string | null {
  const task = record(run.task);
  return firstString(
    typeof run.task === "string" ? run.task : null,
    run.objective,
    run.taskDescription,
    task?.description,
    task?.objective,
    run.taskId
  );
}

function tokensFrom(telemetry: CliJson): CliJson {
  const nested = record(telemetry.tokens) ?? {};
  return {
    input: firstNumber(nested.input, nested.inputTokens, telemetry.input, telemetry.inputTokens),
    cached: firstNumber(nested.cached, nested.cachedTokens, telemetry.cached, telemetry.cachedTokens),
    output: firstNumber(nested.output, nested.outputTokens, telemetry.output, telemetry.outputTokens),
    reasoning: firstNumber(
      nested.reasoning,
      nested.reasoningTokens,
      telemetry.reasoning,
      telemetry.reasoningTokens
    ),
    total: firstNumber(nested.total, nested.totalTokens, telemetry.total, telemetry.totalTokens)
  };
}

function contextExposureFrom(run: CliJson, telemetry: CliJson): CliJson | null {
  return record(telemetry.contextExposure) ?? record(run.contextExposure);
}

function diffChangedFiles(candidateDiff: string): string[] {
  const files = new Set<string>();
  for (const line of candidateDiff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files].sort();
}

function changedFilesFrom(run: CliJson, candidateDiff: string): string[] {
  const candidate = record(run.candidate);
  return stringArray(run.changedFiles) ??
    stringArray(candidate?.changedFiles) ??
    diffChangedFiles(candidateDiff);
}

function commandsFrom(run: CliJson, telemetry: CliJson, receipt: CliJson): unknown[] {
  return commandList(run.commands) ??
    commandList(telemetry.commands) ??
    commandList(receipt.commands) ??
    [];
}

function repairRoundsFrom(run: CliJson, telemetry: CliJson, receipt: CliJson): number | null {
  return firstNumber(run.repairRounds, telemetry.repairRounds, receipt.repairRounds);
}

function repairTelemetryFrom(
  run: CliJson,
  telemetry: CliJson,
  receipt: CliJson
): Readonly<{
  repairAttemptCount: number | null;
  repairInputTokens: number | null;
  repairOutputTokens: number | null;
  repairDurationMs: number | null;
  repairChangedFiles: readonly string[] | null;
  repairOutcome: string | null;
}> {
  const runRepair = record(run.repair) ?? {};
  const telemetryRepair = record(telemetry.repair) ?? {};
  const receiptRepair = record(receipt.repair) ?? {};
  return Object.freeze({
    repairAttemptCount: firstNumber(
      run.repairAttemptCount,
      telemetry.repairAttemptCount,
      receipt.repairAttemptCount,
      runRepair.attemptCount,
      telemetryRepair.attemptCount,
      receiptRepair.attemptCount
    ),
    repairInputTokens: firstNumber(
      run.repairInputTokens,
      telemetry.repairInputTokens,
      receipt.repairInputTokens,
      runRepair.inputTokens,
      telemetryRepair.inputTokens,
      receiptRepair.inputTokens
    ),
    repairOutputTokens: firstNumber(
      run.repairOutputTokens,
      telemetry.repairOutputTokens,
      receipt.repairOutputTokens,
      runRepair.outputTokens,
      telemetryRepair.outputTokens,
      receiptRepair.outputTokens
    ),
    repairDurationMs: firstNumber(
      run.repairDurationMs,
      telemetry.repairDurationMs,
      receipt.repairDurationMs,
      runRepair.durationMs,
      telemetryRepair.durationMs,
      receiptRepair.durationMs
    ),
    repairChangedFiles: normalizedStringArray(
      run.repairChangedFiles,
      telemetry.repairChangedFiles,
      receipt.repairChangedFiles,
      runRepair.changedFiles,
      telemetryRepair.changedFiles,
      receiptRepair.changedFiles
    ),
    repairOutcome: firstString(
      run.repairOutcome,
      telemetry.repairOutcome,
      receipt.repairOutcome,
      runRepair.outcome,
      telemetryRepair.outcome,
      receiptRepair.outcome
    )
  });
}

function humanDecisionFrom(run: CliJson, receipt: CliJson): string | null {
  return firstString(
    run.humanDecision,
    run.developerDecision,
    run.approvalDecision,
    receipt.humanDecision,
    receipt.developerDecision,
    receipt.approvalDecision
  );
}

function receiptHashFrom(
  artifact: ProductRunArtifact,
  run: CliJson,
  receipt: CliJson
): Readonly<{ value: string; source: "receipt" | "artifact-file" }> {
  const semantic = firstString(receipt.receiptHash, receipt.integratedReceiptHash, run.receiptHash);
  return semantic
    ? { value: semantic, source: "receipt" }
    : { value: artifact.files.receipt.sha256, source: "artifact-file" };
}

export type ProductRunReport = Readonly<{
  status: string | null;
  agent: string | null;
  model: string | null;
  task: string | null;
  sourceCommit: string | null;
  tokens: CliJson;
  contextExposure: CliJson | null;
  changedFiles: readonly string[];
  commands: readonly unknown[];
  validation: unknown;
  repairRounds: number | null;
  repairAttemptCount: number | null;
  repairInputTokens: number | null;
  repairOutputTokens: number | null;
  repairDurationMs: number | null;
  repairChangedFiles: readonly string[] | null;
  repairOutcome: string | null;
  humanDecision: string | null;
  receiptHash: string;
  receiptHashSource: "receipt" | "artifact-file";
}>;

export function buildProductRunReport(bundle: StoredProductRunBundle): ProductRunReport {
  const run = bundle.artifact.run as CliJson;
  const telemetry = record(bundle.telemetry) ?? {};
  const receipt = record(bundle.receipt) ?? {};
  const receiptHash = receiptHashFrom(bundle.artifact, run, receipt);
  const repairTelemetry = repairTelemetryFrom(run, telemetry, receipt);
  return Object.freeze({
    status: firstString(run.status, receipt.status, receipt.outcome, run.outcome),
    agent: firstString(run.agent, telemetry.agent),
    model: firstString(run.model, telemetry.model, telemetry.modelId),
    task: taskText(run),
    sourceCommit: firstString(
      run.sourceCommit,
      run.sourceCommitSha,
      run.sourceSha,
      receipt.sourceCommit,
      receipt.sourceCommitSha
    ),
    tokens: Object.freeze(tokensFrom(telemetry)),
    contextExposure: contextExposureFrom(run, telemetry),
    changedFiles: Object.freeze(changedFilesFrom(run, bundle.candidateDiff)),
    commands: Object.freeze(commandsFrom(run, telemetry, receipt)),
    validation: bundle.validation,
    repairRounds: repairRoundsFrom(run, telemetry, receipt),
    ...repairTelemetry,
    humanDecision: humanDecisionFrom(run, receipt),
    receiptHash: receiptHash.value,
    receiptHashSource: receiptHash.source
  });
}

export async function reportCommand(
  runId: string,
  startPath = process.cwd()
): Promise<CliCommandResult> {
  const repositoryRoot = await findGitRepositoryRoot(startPath);
  const bundle = await readStoredProductRunBundle(repositoryRoot, runId);
  const report = buildProductRunReport(bundle);
  return Object.freeze({
    output: {
      ok: true,
      command: "report",
      runId: bundle.artifact.runId,
      runKind: bundle.artifact.runKind,
      artifactVersion: bundle.artifact.artifactVersion,
      ...report
    },
    exitCode: 0
  });
}
