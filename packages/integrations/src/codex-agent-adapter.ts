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
  AgentIsolationPolicyError,
  resolveAgentIsolationPolicy
} from "./agent-isolation-policy.js";
import {
  createAgentOutputRedactor,
  type AgentOutputRedactor
} from "./agent-output-redaction.js";
import {
  AgentProcessControlError,
  createAgentProcessControl,
  type AgentProcessControl,
  type AgentProcessFailureCode
} from "./agent-process-control.js";
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

type RunTermination = "none" | "aborted" | "timed_out" | "budget_failed";

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

function serializeStreamEvent(event: unknown): string {
  if (typeof event === "string") return event;
  return JSON.stringify(event);
}

function observeCommandTiming(
  event: unknown,
  observedAtMs: number,
  timings: Map<string, CommandTiming>,
  processControl: AgentProcessControl
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

    processControl.observeCommand(item.id);
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
    } catch (error) {
      if (error instanceof AgentProcessControlError) throw error;
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
  diagnostics: AgentDiagnostic[],
  redactor: AgentOutputRedactor
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
      command: redactor.redactText(command.command),
      args: [],
      workingDirectory,
      startedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      exitCode: command.exitCode,
      status: mapCommandStatus(command, termination),
      output: command.aggregatedOutput === null
        ? null
        : redactor.redactText(command.aggregatedOutput)
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
  if (termination === "budget_failed") return "failed";
  if (parsed.status === "completed") return "completed";
  return "failed";
}

function emptyResult(
  request: AgentRunRequest,
  status: AgentRunStatus,
  durationMs: number,
  diagnostics: AgentDiagnostic[],
  failureCode: AgentProcessFailureCode | null = null
): AgentRunResult {
  return {
    status,
    failureCode,
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
  private readonly redactor: AgentOutputRedactor;

  constructor(options: CodexAgentAdapterOptions = {}) {
    const environmentSource = options.environment ?? process.env;
    const environment = createAgentEnvironment(environmentSource);
    this.redactor = createAgentOutputRedactor({ environment: environmentSource });
    this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));
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

    let isolation;
    try {
      isolation = resolveAgentIsolationPolicy(request);
    } catch (error) {
      if (error instanceof AgentIsolationPolicyError) {
        return emptyResult(request, "rejected", 0, [
          diagnostic(
            `codex_isolation_${error.reason}`,
            "error",
            error.message
          )
        ]);
      }
      throw error;
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

    let processControl: AgentProcessControl;
    try {
      processControl = createAgentProcessControl({
        totalTimeoutMs: request.timeoutMs,
        budget: request.processBudget,
        parentSignal: request.abortSignal
      });
    } catch (error) {
      return emptyResult(request, "rejected", 0, [
        diagnostic(
          "codex_process_budget_invalid",
          "error",
          error instanceof Error ? error.message : "Agent process budget is invalid."
        )
      ]);
    }

    try {
      if (request.mode === "repair") processControl.recordRepairRound();
      processControl.recordProviderCall();
      processControl.recordModelCall();
    } catch (error) {
      const failure = processControl.failure();
      processControl.close();
      if (failure !== null) {
        return emptyResult(request, "failed", Math.max(0, this.now() - startedAtMs), [
          diagnostic(failure.code, "error", failure.message)
        ], failure.code);
      }
      throw error;
    }

    const threadOptions: ThreadOptions = {
      workingDirectory: request.workingDirectory,
      model: request.model,
      sandboxMode: isolation.sandboxMode,
      modelReasoningEffort: mapReasoningEffort(request.reasoningEffort),
      networkAccessEnabled: isolation.networkAccessEnabled,
      webSearchMode: isolation.webSearchMode,
      approvalPolicy: isolation.approvalPolicy,
      additionalDirectories: [...isolation.additionalDirectories]
    };
    const turnOptions: TurnOptions = {
      outputSchema: request.outputSchema,
      signal: processControl.signal
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
        processControl.observeEvent();
        const serialized = serializeStreamEvent(event);
        processControl.observeStdout(serialized);
        observeCommandTiming(event, this.now(), commandTimings, processControl);
        lines.push(serialized);
      }
    } catch (error) {
      streamError = error;
      if (
        processControl.failure() === null &&
        !Boolean(request.abortSignal?.aborted) &&
        !(error instanceof AgentProcessControlError)
      ) {
        const message = error instanceof Error ? error.message : "Codex SDK stream failed.";
        try {
          processControl.observeStderr(message);
        } catch (budgetError) {
          streamError = budgetError;
        }
        if (processControl.failure() === null) {
          adapterDiagnostics.push(
            diagnostic(
              "codex_sdk_error",
              "error",
              message,
              true
            )
          );
        }
      }
    } finally {
      processControl.close();
    }

    const processFailure = processControl.failure();
    const finalTermination: RunTermination = processFailure?.code === "agent_timeout"
      ? "timed_out"
      : processFailure !== null
        ? "budget_failed"
        : Boolean(request.abortSignal?.aborted)
          ? "aborted"
          : "none";
    const durationMs = Math.max(0, this.now() - startedAtMs);
    const parsed = parseCodexJsonl(lines.join("\n"), {
      processAborted: finalTermination !== "none",
      durationMs
    });

    if (processFailure !== null) {
      adapterDiagnostics.push(
        diagnostic(
          processFailure.code,
          "error",
          processFailure.message,
          processFailure.code === "agent_timeout"
        )
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
        message: this.redactor.redactText(message),
        retryable
      })),
      ...adapterDiagnostics.map((entry) => ({
        ...entry,
        message: this.redactor.redactText(entry.message)
      }))
    ];

    const commands = mapCommands(
      parsed,
      commandTimings,
      finalTermination,
      request.workingDirectory,
      diagnostics,
      this.redactor
    );

    return {
      status: mapRunStatus(parsed, finalTermination),
      failureCode: processFailure?.code ?? null,
      agentId: CODEX_AGENT_ID,
      agentVersion: CODEX_SDK_VERSION,
      modelId: request.model,
      durationMs,
      finalMessage: this.redactor.redactText(parsed.finalMessage),
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
