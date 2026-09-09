export const AGENT_RUN_TELEMETRY_VERSION = "agent-run-telemetry/v1" as const;

export type AgentTelemetryUsageStatus =
  | "observed"
  | "estimated"
  | "unavailable";

export type AgentRunTelemetry = Readonly<{
  schemaVersion: typeof AGENT_RUN_TELEMETRY_VERSION;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  usageStatus: AgentTelemetryUsageStatus;
  commandCount: number | null;
  failedCommandCount: number | null;
  fileChangeEventCount: number | null;
  durationMs: number | null;
}>;

export type AgentRunTelemetryInput = Readonly<{
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  usageStatus: AgentTelemetryUsageStatus;
  commandCount?: number | null;
  failedCommandCount?: number | null;
  fileChangeEventCount?: number | null;
  durationMs?: number | null;
}>;

export class AgentTelemetryValidationError extends Error {
  readonly code = "agent_run_telemetry_invalid" as const;
}

function nullableCount(
  value: number | null | undefined,
  field: string
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentTelemetryValidationError(
      `${field} must be null or a non-negative safe integer.`
    );
  }
  return value;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new AgentTelemetryValidationError(
      "totalTokens exceeds the safe integer range."
    );
  }
  return total;
}

export function createAgentRunTelemetry(
  input: AgentRunTelemetryInput
): AgentRunTelemetry {
  if (!["observed", "estimated", "unavailable"].includes(input.usageStatus)) {
    throw new AgentTelemetryValidationError("usageStatus is invalid.");
  }

  const inputTokens = nullableCount(input.inputTokens, "inputTokens");
  const cachedInputTokens = nullableCount(
    input.cachedInputTokens,
    "cachedInputTokens"
  );
  const cacheWriteInputTokens = nullableCount(
    input.cacheWriteInputTokens,
    "cacheWriteInputTokens"
  );
  const outputTokens = nullableCount(input.outputTokens, "outputTokens");
  const reasoningOutputTokens = nullableCount(
    input.reasoningOutputTokens,
    "reasoningOutputTokens"
  );
  const providedTotalTokens = nullableCount(input.totalTokens, "totalTokens");
  const commandCount = nullableCount(input.commandCount, "commandCount");
  const failedCommandCount = nullableCount(
    input.failedCommandCount,
    "failedCommandCount"
  );
  const fileChangeEventCount = nullableCount(
    input.fileChangeEventCount,
    "fileChangeEventCount"
  );
  const durationMs = nullableCount(input.durationMs, "durationMs");

  if (cachedInputTokens !== null) {
    if (inputTokens === null) {
      throw new AgentTelemetryValidationError(
        "cachedInputTokens requires inputTokens so subset semantics can be verified."
      );
    }
    if (cachedInputTokens > inputTokens) {
      throw new AgentTelemetryValidationError(
        "cachedInputTokens must be a subset of inputTokens."
      );
    }
  }

  const derivedTotalTokens =
    inputTokens !== null && outputTokens !== null
      ? safeAdd(inputTokens, outputTokens)
      : null;

  if (
    providedTotalTokens !== null &&
    derivedTotalTokens !== null &&
    providedTotalTokens !== derivedTotalTokens
  ) {
    throw new AgentTelemetryValidationError(
      "totalTokens must equal inputTokens + outputTokens; cached input tokens must not be counted twice."
    );
  }

  const totalTokens = providedTotalTokens ?? derivedTotalTokens;

  if (input.usageStatus === "unavailable") {
    const tokenValues = [
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens
    ];
    if (tokenValues.some((value) => value !== null)) {
      throw new AgentTelemetryValidationError(
        "usageStatus=unavailable requires all token fields to be null."
      );
    }
  }

  return Object.freeze({
    schemaVersion: AGENT_RUN_TELEMETRY_VERSION,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    usageStatus: input.usageStatus,
    commandCount,
    failedCommandCount,
    fileChangeEventCount,
    durationMs
  });
}
