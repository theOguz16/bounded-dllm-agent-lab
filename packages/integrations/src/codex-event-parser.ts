import type { AgentDiagnostic } from "./agent-adapter.js";
import {
  AgentTelemetryValidationError,
  createAgentRunTelemetry,
  type AgentRunTelemetry
} from "./agent-telemetry.js";

export type CodexEventParserStatus =
  | "completed"
  | "failed"
  | "partial"
  | "aborted"
  | "agent_protocol_invalid";

export type CodexNormalizedCommandEvent = Readonly<{
  id: string;
  command: string;
  aggregatedOutput: string;
  exitCode: number | null;
  status: "in_progress" | "completed" | "failed";
}>;

export type CodexNormalizedFileChangeEvent = Readonly<{
  id: string;
  path: string;
  operation: "create" | "modify" | "delete";
  status: "completed" | "failed";
}>;

export type CodexNormalizedAgentMessage = Readonly<{
  id: string;
  text: string;
}>;

export type CodexEventParserDiagnostic = AgentDiagnostic &
  Readonly<{
    line: number | null;
    eventType: string | null;
  }>;

export type CodexEventParserOptions = Readonly<{
  processAborted?: boolean;
  durationMs?: number | null;
}>;

export type CodexEventParserResult = Readonly<{
  status: CodexEventParserStatus;
  threadId: string | null;
  finalMessage: string;
  telemetry: AgentRunTelemetry;
  commands: readonly CodexNormalizedCommandEvent[];
  fileChanges: readonly CodexNormalizedFileChangeEvent[];
  agentMessages: readonly CodexNormalizedAgentMessage[];
  diagnostics: readonly CodexEventParserDiagnostic[];
}>;

type JsonObject = Record<string, unknown>;

type ParsedUsage = Readonly<{
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  observed: boolean;
}>;

const KNOWN_EVENTS = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error"
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
  code: string,
  severity: "info" | "warning" | "error",
  message: string,
  line: number | null,
  eventType: string | null,
  retryable = false
): CodexEventParserDiagnostic {
  return Object.freeze({ code, severity, message, retryable, line, eventType });
}

function protocolError(
  message: string,
  line: number,
  eventType: string | null
): CodexEventParserDiagnostic {
  return diagnostic(
    "agent_protocol_invalid",
    "error",
    message,
    line,
    eventType,
    false
  );
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  line: number,
  eventType: string
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError(
      `${eventType}.${field} must be a non-negative safe integer when present.`,
      line,
      eventType
    );
  }
  return value as number;
}

function parseUsage(
  value: unknown,
  line: number
): ParsedUsage {
  if (value === undefined || value === null) {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      observed: false
    };
  }
  if (!isObject(value)) {
    throw protocolError(
      "turn.completed.usage must be an object when present.",
      line,
      "turn.completed"
    );
  }

  const inputTokens = nonNegativeInteger(
    value.input_tokens,
    "usage.input_tokens",
    line,
    "turn.completed"
  );
  const cachedInputTokens = nonNegativeInteger(
    value.cached_input_tokens,
    "usage.cached_input_tokens",
    line,
    "turn.completed"
  );
  const cacheWriteInputTokens = nonNegativeInteger(
    value.cache_write_input_tokens,
    "usage.cache_write_input_tokens",
    line,
    "turn.completed"
  );
  const outputTokens = nonNegativeInteger(
    value.output_tokens,
    "usage.output_tokens",
    line,
    "turn.completed"
  );
  const reasoningOutputTokens = nonNegativeInteger(
    value.reasoning_output_tokens,
    "usage.reasoning_output_tokens",
    line,
    "turn.completed"
  );

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    observed: [
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens
    ].some((tokenCount) => tokenCount !== null)
  };
}

function requireString(
  object: JsonObject,
  field: string,
  line: number,
  eventType: string
): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError(
      `${eventType}.${field} must be a non-empty string.`,
      line,
      eventType
    );
  }
  return value;
}

function normalizeCommandItem(
  item: JsonObject,
  line: number,
  eventType: string
): CodexNormalizedCommandEvent {
  const id = requireString(item, "id", line, eventType);
  const command = requireString(item, "command", line, eventType);
  if (typeof item.aggregated_output !== "string") {
    throw protocolError(
      `${eventType}.item.aggregated_output must be a string for command_execution.`,
      line,
      eventType
    );
  }
  if (
    item.status !== "in_progress" &&
    item.status !== "completed" &&
    item.status !== "failed"
  ) {
    throw protocolError(
      `${eventType}.item.status is invalid for command_execution.`,
      line,
      eventType
    );
  }
  const exitCode =
    item.exit_code === undefined || item.exit_code === null
      ? null
      : Number.isSafeInteger(item.exit_code)
        ? (item.exit_code as number)
        : null;
  if (item.exit_code !== undefined && item.exit_code !== null && exitCode === null) {
    throw protocolError(
      `${eventType}.item.exit_code must be an integer when present.`,
      line,
      eventType
    );
  }
  return Object.freeze({
    id,
    command,
    aggregatedOutput: item.aggregated_output,
    exitCode,
    status: item.status
  });
}

function normalizeFileChangeItem(
  item: JsonObject,
  line: number,
  eventType: string
): readonly CodexNormalizedFileChangeEvent[] {
  const id = requireString(item, "id", line, eventType);
  if (item.status !== "completed" && item.status !== "failed") {
    throw protocolError(
      `${eventType}.item.status is invalid for file_change.`,
      line,
      eventType
    );
  }
  if (!Array.isArray(item.changes)) {
    throw protocolError(
      `${eventType}.item.changes must be an array for file_change.`,
      line,
      eventType
    );
  }
  return item.changes.map((change, index) => {
    if (!isObject(change)) {
      throw protocolError(
        `${eventType}.item.changes[${index}] must be an object.`,
        line,
        eventType
      );
    }
    const path = requireString(change, "path", line, eventType);
    const operation =
      change.kind === "add"
        ? "create"
        : change.kind === "update"
          ? "modify"
          : change.kind === "delete"
            ? "delete"
            : null;
    if (operation === null) {
      throw protocolError(
        `${eventType}.item.changes[${index}].kind is invalid.`,
        line,
        eventType
      );
    }
    return Object.freeze({ id, path, operation, status: item.status });
  });
}

function normalizeAgentMessage(
  item: JsonObject,
  line: number,
  eventType: string
): CodexNormalizedAgentMessage {
  const id = requireString(item, "id", line, eventType);
  if (typeof item.text !== "string") {
    throw protocolError(
      `${eventType}.item.text must be a string for agent_message.`,
      line,
      eventType
    );
  }
  return Object.freeze({ id, text: item.text });
}

export function parseCodexJsonl(
  jsonl: string,
  options: CodexEventParserOptions = {}
): CodexEventParserResult {
  const diagnostics: CodexEventParserDiagnostic[] = [];
  const commands = new Map<string, CodexNormalizedCommandEvent>();
  const fileChanges = new Map<string, CodexNormalizedFileChangeEvent>();
  const agentMessages = new Map<string, CodexNormalizedAgentMessage>();

  let threadId: string | null = null;
  let turnCompleted = false;
  let turnFailed = false;
  let streamFailed = false;
  let usage: ParsedUsage = {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    observed: false
  };
  let protocolInvalid = false;

  const lines = jsonl.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]?.trim() ?? "";
    if (rawLine.length === 0) continue;
    const line = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      diagnostics.push(
        protocolError("Codex JSONL line is not valid JSON.", line, null)
      );
      protocolInvalid = true;
      break;
    }

    if (!isObject(parsed) || typeof parsed.type !== "string") {
      diagnostics.push(
        protocolError(
          "Codex JSONL event must be an object with a string type.",
          line,
          null
        )
      );
      protocolInvalid = true;
      break;
    }

    const eventType = parsed.type;
    if (!KNOWN_EVENTS.has(eventType)) {
      diagnostics.push(
        diagnostic(
          "codex_event_ignored",
          "warning",
          `Ignoring unknown Codex event type: ${eventType}.`,
          line,
          eventType
        )
      );
      continue;
    }

    try {
      switch (eventType) {
        case "thread.started":
          threadId = requireString(parsed, "thread_id", line, eventType);
          break;
        case "turn.started":
          break;
        case "turn.completed":
          usage = parseUsage(parsed.usage, line);
          turnCompleted = true;
          if (!usage.observed) {
            diagnostics.push(
              diagnostic(
                "codex_usage_unavailable",
                "info",
                "turn.completed did not include token usage; telemetry remains unavailable.",
                line,
                eventType
              )
            );
          }
          break;
        case "turn.failed": {
          if (!isObject(parsed.error) || typeof parsed.error.message !== "string") {
            throw protocolError(
              "turn.failed.error.message must be a string.",
              line,
              eventType
            );
          }
          turnFailed = true;
          diagnostics.push(
            diagnostic(
              "codex_turn_failed",
              "error",
              parsed.error.message,
              line,
              eventType
            )
          );
          break;
        }
        case "error":
          if (typeof parsed.message !== "string") {
            throw protocolError(
              "error.message must be a string.",
              line,
              eventType
            );
          }
          streamFailed = true;
          diagnostics.push(
            diagnostic(
              "codex_stream_error",
              "error",
              parsed.message,
              line,
              eventType
            )
          );
          break;
        case "item.started":
        case "item.updated":
        case "item.completed": {
          if (!isObject(parsed.item)) {
            throw protocolError(
              `${eventType}.item must be an object.`,
              line,
              eventType
            );
          }
          const item = parsed.item;
          const id = requireString(item, "id", line, eventType);
          const itemType = requireString(item, "type", line, eventType);
          if (itemType === "command_execution") {
            commands.set(id, normalizeCommandItem(item, line, eventType));
          } else if (itemType === "file_change") {
            for (const change of normalizeFileChangeItem(item, line, eventType)) {
              fileChanges.set(`${change.id}:${change.path}`, change);
            }
          } else if (itemType === "agent_message") {
            agentMessages.set(id, normalizeAgentMessage(item, line, eventType));
          }
          break;
        }
      }
    } catch (error) {
      if (
        isObject(error) &&
        error.code === "agent_protocol_invalid" &&
        typeof error.message === "string"
      ) {
        diagnostics.push(error as CodexEventParserDiagnostic);
      } else {
        diagnostics.push(
          protocolError(
            error instanceof Error ? error.message : "Codex event validation failed.",
            line,
            eventType
          )
        );
      }
      protocolInvalid = true;
      break;
    }
  }

  const commandValues = [...commands.values()];
  const fileChangeValues = [...fileChanges.values()];
  const messageValues = [...agentMessages.values()];
  const failedCommandCount = commandValues.filter(
    (command) => command.status === "failed"
  ).length;

  let telemetry: AgentRunTelemetry;
  try {
    telemetry = createAgentRunTelemetry({
      usageStatus: usage.observed ? "observed" : "unavailable",
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      commandCount: commandValues.length,
      failedCommandCount,
      fileChangeEventCount: fileChangeValues.length,
      durationMs: options.durationMs
    });
  } catch (error) {
    if (error instanceof AgentTelemetryValidationError) {
      diagnostics.push(protocolError(error.message, lines.length, "turn.completed"));
      protocolInvalid = true;
      telemetry = createAgentRunTelemetry({
        usageStatus: "unavailable",
        commandCount: commandValues.length,
        failedCommandCount,
        fileChangeEventCount: fileChangeValues.length,
        durationMs: options.durationMs
      });
    } else {
      throw error;
    }
  }

  const status: CodexEventParserStatus = protocolInvalid
    ? "agent_protocol_invalid"
    : turnFailed || streamFailed
      ? "failed"
      : turnCompleted
        ? "completed"
        : options.processAborted === true
          ? "aborted"
          : "partial";

  return Object.freeze({
    status,
    threadId,
    finalMessage: messageValues.at(-1)?.text ?? "",
    telemetry,
    commands: Object.freeze(commandValues),
    fileChanges: Object.freeze(fileChangeValues),
    agentMessages: Object.freeze(messageValues),
    diagnostics: Object.freeze(diagnostics)
  });
}
