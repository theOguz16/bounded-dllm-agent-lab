import type { AgentOutputRedactor } from "./agent-output-redaction.js";
import type { CodexEventParserStatus } from "./codex-event-parser.js";
import type { IsolatedAgentWorkerResult } from "./isolated-agent-worker.js";

export const WORKER_FAILURE_DIAGNOSTIC_VERSION = "worker-failure-diagnostic/v1" as const;
const EVENT_TYPES = ["thread.started", "turn.started", "turn.completed", "turn.failed",
  "error", "item.started", "item.updated", "item.completed"] as const;
const EVENT_SET = new Set<string>(EVENT_TYPES);
const MAX_FIELD = 256;
const MAX_STDERR = 2_048;
const MAX_SERIALIZED_BYTES = 4_096;
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "RangeError",
  "AbortError", "TimeoutError"]);

function stderrMetadata(redacted: string): Readonly<{
  format: "worker_error_envelope" | "unstructured" | "empty";
  errorName: string | null;
  errorStatus: number | null;
}> {
  if (redacted.length === 0) return { format: "empty", errorName: null, errorStatus: null };
  try {
    const parsed: unknown = JSON.parse(redacted.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).message === "string") {
      const error = parsed as Record<string, unknown>;
      return {
        format: "worker_error_envelope",
        errorName: typeof error.name === "string" && ERROR_NAMES.has(error.name)
          ? error.name : null,
        errorStatus: typeof error.status === "number" && Number.isSafeInteger(error.status) &&
          error.status >= 100 && error.status <= 599 ? error.status : null
      };
    }
  } catch { /* Unstructured stderr cannot safely be persisted as text. */ }
  return { format: "unstructured", errorName: null, errorStatus: null };
}

export function createWorkerFailureDiagnostic(input: Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  worker: IsolatedAgentWorkerResult;
  stdoutLines: readonly string[];
  parserStatus: CodexEventParserStatus;
  terminalTurnObserved: boolean;
  redactor: AgentOutputRedactor;
}>): Readonly<Record<string, unknown>> {
  const seen = new Set<string>();
  let malformedLineCount = 0;
  let recognizedEventCount = 0;
  let unknownEventCount = 0;
  let lastRecognizedEventType: string | null = null;
  for (const line of input.stdoutLines) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          typeof (value as { type?: unknown }).type !== "string") {
        malformedLineCount++;
        continue;
      }
      const type = (value as { type: string }).type;
      if (EVENT_SET.has(type)) {
        seen.add(type);
        recognizedEventCount++;
        lastRecognizedEventType = type;
      } else unknownEventCount++;
    } catch { malformedLineCount++; }
  }
  const safeField = (value: string) => input.redactor.redactText(value).slice(0, MAX_FIELD);
  const redactedStderr = input.redactor.redactText(input.worker.stderr);
  // Error.message and unstructured stderr can echo a JSON-escaped prompt. Keep
  // only allowlisted, machine-readable metadata from the worker's error envelope.
  const stderr = input.worker.stderrTruncated
    ? { format: "unstructured" as const, errorName: null, errorStatus: null }
    : stderrMetadata(redactedStderr);
  const stderrExceededExcerpt = Buffer.byteLength(input.worker.stderr, "utf8") > MAX_STDERR;
  const diagnostic: Record<string, unknown> = {
    version: WORKER_FAILURE_DIAGNOSTIC_VERSION,
    executable: safeField(input.executable),
    args: input.args.slice(0, 4).map(safeField),
    argsTruncated: input.args.length > 4,
    cwd: safeField(input.cwd),
    exitCode: input.worker.exitCode,
    exitSignal: input.worker.exitSignal,
    stdoutEmpty: input.worker.stdoutBytes === 0,
    stderrEmpty: input.worker.stderrBytes === 0,
    stderrExcerpt: input.worker.stderrBytes === 0 ? "" : "[UNSAFE_STDERR_CONTENT_OMITTED]",
    stderrFormat: stderr.format,
    workerErrorName: stderr.errorName,
    workerErrorStatus: stderr.errorStatus,
    stderrTruncated: input.worker.stderrTruncated || stderrExceededExcerpt,
    stdoutLineCount: input.stdoutLines.length,
    recognizedEventCount,
    unknownEventCount,
    eventTypes: EVENT_TYPES.filter((type) => seen.has(type)),
    threadStarted: seen.has("thread.started"),
    turnStarted: seen.has("turn.started"),
    turnCompleted: seen.has("turn.completed"),
    turnFailed: seen.has("turn.failed"),
    errorEvent: seen.has("error"),
    malformedLineCount,
    lastRecognizedEventType,
    parserStatus: input.parserStatus,
    terminalTurnObserved: input.terminalTurnObserved,
    serializationTruncated: false
  };
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > MAX_SERIALIZED_BYTES) {
    diagnostic.stderrExcerpt = "";
    diagnostic.stderrTruncated = true;
    diagnostic.serializationTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > MAX_SERIALIZED_BYTES) {
    diagnostic.executable = "[TRUNCATED]";
    diagnostic.args = [];
    diagnostic.argsTruncated = true;
    diagnostic.cwd = "[TRUNCATED]";
  }
  return Object.freeze(diagnostic);
}
