import {
  Codex,
  type ModelReasoningEffort,
  type ThreadOptions,
  type TurnOptions
} from "@openai/codex-sdk";

import type {
  AgentAdapter,
  AgentCommandEvent,
  AgentDiagnostic,
  AgentFileChangeEvent,
  AgentReasoningEffort,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus
} from "./agent-adapter.js";
import {
  createAgentEnvironment,
  type AgentEnvironmentSource
} from "./agent-environment.js";
import {
  parseCodexJsonl,
  type CodexEventParserResult,
  type CodexNormalizedCommandEvent
} from "./codex-event-parser.js";

export const CODEX_AGENT_ID = "codex" as const;
export const CODEX_SDK_VERSION = "0.153.4" as const;

export interface CodexSdkStreamLike {
  readonly events: AsyncIterable<unknown>;
}

export interface CodexSdkThreadLike {
  runStreamed(input: string, options?: TurnOptions): Promise<CodexSdkStreamLike>;
}

export interface CodexSdkClientLike {
  startThread(options?: ThreadOptions): CodexSdkThreadLike;
}

export type CodexAgentAdapterOptions = Readonly<{
  clientFactory?: () => CodexSdkClientLike;
  environment?: AgentEnvironmentSource;
  now?: () => number;
}>;

type CommandTiming = {
  startedAtMs: number | null;
  completedAtMs: number | null;
};

type RunTermination = "none" | "aborted" | "timed_out";

function diagnostic(
  code: string,
  severity: AgentDiagnostic["severity"],
  message: string,
  retryable = false
): AgentDiagnostic {
  return { code, severity, message, retryable };
}

function mapReasoningEffort(effort: AgentReasoningEffort): ModelReasoningEffort {
  switch (effort) {
    case "none":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "extra_high":
      return "xhigh";
  }
}

function resolveSandboxMode(
  request: AgentRunRequest
): "read-only" | "workspace-write" | null {
  if (request.sandboxMode === "full_access") return null;

  if (request.mode === "planner" || request.mode === "discovery") {
    return "read-only";
  }

  if (request.sandboxMode === "read_only") return "read-only";
  return "workspace-write";
}

function serializeStreamEvent(event: unknown): string {
  if (typeof event === "string") return event;
  return JSON.stringify(event);
}

function observeCommandTiming(
  event: unknown,
  observedAtMs: number,
  timings: Map<string, CommandTiming>
): void {
  const observeOne = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (
      record.type !== "item.started" &&
      record.type !== "item.updated" &&
      record.type !== "item.completed"
    ) {
      return;
    }
    if (typeof record.item !== "object" || record.item === null || Array.isArray(record.item)) {
      return;
    }
    const item = record.item as Record<string, unknown>;
    if (item.type !== "command_execution" || typeof item.id !== "string") return;

    const existing = timings.get(item.id) ?? {
      startedAtMs: null,
      completedAtMs: null
    };
    if (record.type === "item.started" && existing.startedAtMs === null) {
      existing.startedAtMs = observedAtMs;
    }
    if (record.type === "item.completed") {
      existing.completedAtMs = observedAtMs;
      if (existing.startedAtMs === null) existing.startedAtMs = observedAtMs;
    }
    timings.set(item.id, existing);
  };

  if (typeof event !== "string") {
    observeOne(event);
    return;
  }

  for (const line of event.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      observeOne(JSON.parse(line));
    } catch {
      // Protocol validation belongs to the canonical JSONL parser.
    }
  }
}

function mapCommandStatus(
  command: CodexNormalizedCommandEvent,
  termination: RunTermination
): AgentCommandEvent["status"] {
  if (command.status === "completed") return "completed";
  if (command.status === "failed") return "failed";
  if (termination === "timed_out") return "timed_out";
  if (termination === "aborted") return "aborted";
  return "failed";
}

function mapCommands(
  parsed: CodexEventParserResult,
  timings: ReadonlyMap<string, CommandTiming>,
  termination: RunTermination,
  workingDirectory: string,
  diagnostics: AgentDiagnostic[]
): AgentCommandEvent[] {
  return parsed.commands.map((command, index) => {
    const timing = timings.get(command.id);
    const startedAtMs = timing?.startedAtMs ?? timing?.completedAtMs ?? 0;
    const completedAtMs = timing?.completedAtMs ?? timing?.startedAtMs ?? startedAtMs;
    if (timing === undefined) {
      diagnostics.push(
        diagnostic(
          "codex_command_timing_unavailable",
          "info",
          `Observed timing was unavailable for Codex command ${command.id}.`
        )
      );
    } else if (timing.startedAtMs === null || timing.completedAtMs === null) {
      diagnostics.push(
        diagnostic(
          "codex_command_timing_partial",
          "info",
          `Only partial observed timing was available for Codex command ${command.id}.`
        )
      );
    }

    return {
      sequence: index + 1,
      command: command.command,
      args: [],
      workingDirectory,
      startedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      exitCode: command.exitCode,
      status: mapCommandStatus(command, termination)
    };
  });
}

function mapFileChanges(parsed: CodexEventParserResult): AgentFileChangeEvent[] {
  return parsed.fileChanges.map((change, index) => ({
    sequence: index + 1,
    path: change.path,
    operation: change.operation
  }));
}

function mapRunStatus(
  parsed: CodexEventParserResult,
  termination: RunTermination
): AgentRunStatus {
  if (termination === "timed_out") return "timed_out";
  if (termination === "aborted") return "aborted";
  if (parsed.status === "completed") return "completed";
  return "failed";
}

function emptyResult(
  request: AgentRunRequest,
  status: AgentRunStatus,
  durationMs: number,
  diagnostics: AgentDiagnostic[]
): AgentRunResult {
  return {
    status,
    agentId: CODEX_AGENT_ID,
    agentVersion: CODEX_SDK_VERSION,
    modelId: request.model,
    durationMs,
    finalMessage: "",
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      toolCalls: null
    },
    commands: [],
    fileChanges: [],
    diagnostics
  };
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly agentId = CODEX_AGENT_ID;
  readonly agentVersion = CODEX_SDK_VERSION;

  private readonly clientFactory: () => CodexSdkClientLike;
  private readonly now: () => number;

  constructor(options: CodexAgentAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? (() => {
      const environment = createAgentEnvironment(options.environment ?? process.env);
      return new Codex({ env: { ...environment } });
    });
    this.now = options.now ?? Date.now;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAtMs = this.now();

    if (request.agentId !== CODEX_AGENT_ID) {
      return emptyResult(request, "rejected", 0, [
        diagnostic(
          "codex_agent_id_mismatch",
          "error",
          `CodexAgentAdapter requires agentId=${CODEX_AGENT_ID}.`
        )
      ]);
    }

    const sdkSandboxMode = resolveSandboxMode(request);
    if (sdkSandboxMode === null) {
      return emptyResult(request, "rejected", 0, [
        diagnostic(
          "codex_sandbox_rejected",
          "error",
          "full_access is not permitted by the bounded Codex adapter."
        )
      ]);
    }

    if (request.timeoutMs <= 0 || !Number.isSafeInteger(request.timeoutMs)) {
      return emptyResult(request, "rejected", 0, [
        diagnostic(
          "codex_timeout_invalid",
          "error",
          "timeoutMs must be a positive safe integer."
        )
      ]);
    }

    if (request.abortSignal?.aborted === true) {
      return emptyResult(request, "aborted", Math.max(0, this.now() - startedAtMs), [
        diagnostic("codex_aborted", "info", "Codex run was already aborted before start.")
      ]);
    }

    const controller = new AbortController();
    let termination: RunTermination = "none";
    const getTermination = (): RunTermination => termination;
    const abortFromCaller = (): void => {
      if (termination === "none") termination = "aborted";
      controller.abort(request.abortSignal?.reason);
    };
    request.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const timeoutHandle = setTimeout(() => {
      if (termination === "none") termination = "timed_out";
      controller.abort(new Error("Codex agent run timed out."));
    }, request.timeoutMs);

    const threadOptions: ThreadOptions = {
      workingDirectory: request.workingDirectory,
      model: request.model,
      sandboxMode: sdkSandboxMode,
      modelReasoningEffort: mapReasoningEffort(request.reasoningEffort),
      networkAccessEnabled: request.networkAllowed === true,
      approvalPolicy: "never"
    };
    const turnOptions: TurnOptions = {
      outputSchema: request.outputSchema,
      signal: controller.signal
    };

    const lines: string[] = [];
    const commandTimings = new Map<string, CommandTiming>();
    const adapterDiagnostics: AgentDiagnostic[] = [];
    let streamError: unknown = null;

    try {
      const client = this.clientFactory();
      const thread = client.startThread(threadOptions);
      const streamed = await thread.runStreamed(request.task, turnOptions);
      for await (const event of streamed.events) {
        observeCommandTiming(event, this.now(), commandTimings);
        lines.push(serializeStreamEvent(event));
      }
    } catch (error) {
      streamError = error;
      if (getTermination() === "none") {
        adapterDiagnostics.push(
          diagnostic(
            "codex_sdk_error",
            "error",
            error instanceof Error ? error.message : "Codex SDK stream failed.",
            true
          )
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
      request.abortSignal?.removeEventListener("abort", abortFromCaller);
    }

    const finalTermination = getTermination();
    const durationMs = Math.max(0, this.now() - startedAtMs);
    const parsed = parseCodexJsonl(lines.join("\n"), {
      processAborted: finalTermination !== "none",
      durationMs
    });

    if (streamError !== null && finalTermination === "timed_out") {
      adapterDiagnostics.push(
        diagnostic("codex_timed_out", "error", "Codex run exceeded timeoutMs.", true)
      );
    } else if (streamError !== null && finalTermination === "aborted") {
      adapterDiagnostics.push(
        diagnostic("codex_aborted", "info", "Codex run was aborted by the caller.")
      );
    }

    if (finalTermination === "none" && parsed.status === "partial") {
      adapterDiagnostics.push(
        diagnostic(
          "codex_partial_stream",
          "error",
          "Codex stream ended without a terminal turn event."
        )
      );
    }

    const diagnostics: AgentDiagnostic[] = [
      ...parsed.diagnostics.map(({ code, severity, message, retryable }) => ({
        code,
        severity,
        message,
        retryable
      })),
      ...adapterDiagnostics
    ];

    const commands = mapCommands(
      parsed,
      commandTimings,
      finalTermination,
      request.workingDirectory,
      diagnostics
    );

    return {
      status: mapRunStatus(parsed, finalTermination),
      agentId: CODEX_AGENT_ID,
      agentVersion: CODEX_SDK_VERSION,
      modelId: request.model,
      durationMs,
      finalMessage: parsed.finalMessage,
      usage: {
        inputTokens: parsed.telemetry.inputTokens,
        outputTokens: parsed.telemetry.outputTokens,
        totalTokens: parsed.telemetry.totalTokens,
        cachedInputTokens: parsed.telemetry.cachedInputTokens,
        toolCalls: null
      },
      commands,
      fileChanges: mapFileChanges(parsed),
      diagnostics
    };
  }
}
