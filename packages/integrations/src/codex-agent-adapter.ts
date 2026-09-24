import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createDurableInvocationJournal, InvocationJournalError } from "./durable-invocation-journal.js";
import type {
  ModelReasoningEffort,
  ThreadOptions,
  TurnOptions
} from "@openai/codex-sdk";

import type {
  AgentAdapter,
  AgentCommandEvent,
  AgentDiagnostic,
  AgentFileChangeEvent,
  AgentReasoningEffort,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentProviderFailureClass,
  AgentWorkerOutcome
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
  type AgentProcessControl
} from "./agent-process-control.js";
import {
  DEFAULT_AGENT_WORKER_FORCE_GRACE_MS,
  DEFAULT_AGENT_WORKER_GRACE_MS,
  runIsolatedAgentWorker,
  type IsolatedAgentWorkerResult
} from "./isolated-agent-worker.js";
import { createWorkerFailureDiagnostic } from "./worker-failure-diagnostic.js";
import {
  CodexProviderAccessGate,
  classifyCodexProviderError,
  codexLocalAuthCheck,
  type CodexLocalAuthCheck,
  type CodexProviderFailureCode
} from "./codex-provider-access.js";
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
  /** Allows fake providers to supply a local, offline preflight in tests. */
  authCheck?: CodexLocalAuthCheck;
  /** Offline fake-hang tests may substitute the worker entrypoint; live use keeps the bundled worker. */
  workerEntrypoint?: string;
  workerGraceMs?: number;
  workerForceGraceMs?: number;
  /** Parent-owned durable provider-call authority; never forwarded to the worker. */
  invocationJournalPath?: string;
}>;

type CommandTiming = { startedAtMs: number | null; completedAtMs: number | null };
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
    case "none": throw new Error("none is a Codex CLI override, not minimal reasoning");
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "extra_high": return "xhigh";
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
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return;
    const record = candidate as Record<string, unknown>;
    if (record.type !== "item.started" && record.type !== "item.updated" && record.type !== "item.completed") return;
    if (typeof record.item !== "object" || record.item === null || Array.isArray(record.item)) return;
    const item = record.item as Record<string, unknown>;
    if (item.type !== "command_execution" || typeof item.id !== "string") return;
    processControl.observeCommand(item.id);
    const existing = timings.get(item.id) ?? { startedAtMs: null, completedAtMs: null };
    if (record.type === "item.started" && existing.startedAtMs === null) existing.startedAtMs = observedAtMs;
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
      diagnostics.push(diagnostic(
        "codex_command_timing_unavailable", "info", `Observed timing was unavailable for Codex command ${command.id}.`
      ));
    } else if (timing.startedAtMs === null || timing.completedAtMs === null) {
      diagnostics.push(diagnostic(
        "codex_command_timing_partial", "info", `Only partial observed timing was available for Codex command ${command.id}.`
      ));
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
      output: command.aggregatedOutput === null ? null : redactor.redactText(command.aggregatedOutput)
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

function mapRunStatus(parsed: CodexEventParserResult, termination: RunTermination): AgentRunStatus {
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
  failureCode: AgentRunResult["failureCode"] = null
): AgentRunResult {
  return {
    status,
    failureCode,
    quotaStatus: "unknown",
    agentId: CODEX_AGENT_ID,
    agentVersion: CODEX_SDK_VERSION,
    modelId: request.model,
    durationMs,
    finalMessage: "",
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, toolCalls: null },
    commands: [],
    fileChanges: [],
    diagnostics
  };
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly agentId = CODEX_AGENT_ID;
  readonly agentVersion = CODEX_SDK_VERSION;

  private readonly clientFactory: (() => CodexSdkClientLike) | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workerEntrypoint: string;
  private readonly workerGraceMs: number;
  private readonly workerForceGraceMs: number;
  private readonly invocationJournalPath: string | null;
  private readonly now: () => number;
  private readonly redactor: AgentOutputRedactor;
  private readonly providerGate: CodexProviderAccessGate;

  constructor(options: CodexAgentAdapterOptions = {}) {
    const environmentSource = options.environment ?? process.env;
    const environment = createAgentEnvironment(environmentSource);
    this.redactor = createAgentOutputRedactor({ environment: environmentSource });
    this.clientFactory = options.clientFactory ?? null;
    this.environment = { ...environment };
    this.workerEntrypoint = options.workerEntrypoint ?? fileURLToPath(new URL("./codex-agent-worker.js", import.meta.url));
    this.workerGraceMs = options.workerGraceMs ?? DEFAULT_AGENT_WORKER_GRACE_MS;
    this.workerForceGraceMs = options.workerForceGraceMs ?? DEFAULT_AGENT_WORKER_FORCE_GRACE_MS;
    const configuredJournal = options.invocationJournalPath ?? environmentSource.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH;
    // Fakes are journal-free by default unless their test provides a path. All
    // real SDK invocations have a persistent parent-owned journal.
    this.invocationJournalPath = configuredJournal ?? (options.clientFactory || options.workerEntrypoint
      ? null : path.join(environmentSource.HOME || os.homedir(), ".bounded-agent", "provider-invocations.sqlite"));
    this.now = options.now ?? Date.now;
    // Injected SDK clients are deterministic fakes in the offline conformance suite.
    // The real client always performs the free local auth/config check.
    const authCheck = options.authCheck ?? (options.clientFactory ? async () => true : codexLocalAuthCheck);
    this.providerGate = new CodexProviderAccessGate(environmentSource, authCheck);
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAtMs = this.now();
    if (request.agentId !== CODEX_AGENT_ID) {
      return emptyResult(request, "rejected", 0, [diagnostic(
        "codex_agent_id_mismatch", "error", `CodexAgentAdapter requires agentId=${CODEX_AGENT_ID}.`
      )]);
    }

    let isolation;
    try {
      isolation = resolveAgentIsolationPolicy(request);
    } catch (error) {
      if (error instanceof AgentIsolationPolicyError) {
        return emptyResult(request, "rejected", 0, [diagnostic(
          `codex_isolation_${error.reason}`, "error", error.message
        )]);
      }
      throw error;
    }

    if (request.timeoutMs <= 0 || !Number.isSafeInteger(request.timeoutMs)) {
      return emptyResult(request, "rejected", 0, [diagnostic(
        "codex_timeout_invalid", "error", "timeoutMs must be a positive safe integer."
      )]);
    }
    if (request.abortSignal?.aborted === true) {
      return emptyResult(request, "aborted", Math.max(0, this.now() - startedAtMs), [diagnostic(
        "codex_aborted", "info", "Codex run was already aborted before start."
      )]);
    }

    // No paid SDK invocation or call-budget increment until the free preflight passes.
    // Unknown quota remains unknown; an invalid/missing auth state stops this adapter.
    let preflightCode: CodexProviderFailureCode | null;
    try {
      preflightCode = await this.providerGate.preflight();
    } catch {
      preflightCode = this.providerGate.observe({ code: "authentication_failed" });
    }
    if (preflightCode !== null) {
      return emptyResult(request, "rejected", Math.max(0, this.now() - startedAtMs), [
        diagnostic(preflightCode, "error", preflightCode)
      ], preflightCode);
    }

    let processControl: AgentProcessControl;
    try {
      processControl = createAgentProcessControl({
        totalTimeoutMs: request.timeoutMs,
        budget: request.processBudget,
        parentSignal: request.abortSignal
      });
    } catch (error) {
      return emptyResult(request, "rejected", 0, [diagnostic(
        "codex_process_budget_invalid", "error",
        error instanceof Error ? error.message : "Agent process budget is invalid."
      )]);
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

    // Reserve and durably mark a possibly chargeable invocation BEFORE the
    // real SDK or isolated worker can start. No local preflight proves quota.
    let invocationJournal: ReturnType<typeof createDurableInvocationJournal> | null = null;
    let invocationKey: string | null = null;
    try {
      if (this.invocationJournalPath !== null) {
        invocationJournal = createDurableInvocationJournal(this.invocationJournalPath);
        const reservation = invocationJournal.reserve({
          runId: request.runId, stage: request.mode, task: request.task,
          model: request.model, deadlineAt: this.now() + processControl.limits.totalTimeoutMs,
          ...(request.invocationRetryDecision === undefined
            ? {}
            : { retryDecision: request.invocationRetryDecision })
        });
        invocationKey = reservation.invocationKey;
        invocationJournal.start(invocationKey);
      }
    } catch (error) {
      if (invocationJournal !== null && invocationKey !== null) {
        try { invocationJournal.recover(invocationKey); } catch { /* Deny even if recovery cannot be persisted. */ }
      }
      processControl.close();
      const code = error instanceof InvocationJournalError ? error.code : "invocation_journal_unavailable";
      return emptyResult(request, "rejected", Math.max(0, this.now() - startedAtMs), [
        diagnostic(code, "error", code)
      ], code);
    }

    const threadOptions: ThreadOptions = {
      workingDirectory: request.workingDirectory,
      model: request.model,
      skipGitRepoCheck: request.repositoryRequirement === "none",
      sandboxMode: isolation.sandboxMode,
      ...(request.reasoningEffort === "none" ? {} : { modelReasoningEffort: mapReasoningEffort(request.reasoningEffort) }),
      networkAccessEnabled: isolation.networkAccessEnabled,
      webSearchMode: isolation.webSearchMode,
      approvalPolicy: isolation.approvalPolicy,
      additionalDirectories: [...isolation.additionalDirectories]
    };
    const turnOptions: TurnOptions = { outputSchema: request.outputSchema, signal: processControl.signal };
    const lines: string[] = [];
    const commandTimings = new Map<string, CommandTiming>();
    const adapterDiagnostics: AgentDiagnostic[] = [];
    let streamError: unknown = null;
    let providerFailure: CodexProviderFailureCode | "provider_outcome_ambiguous" | null = null;
    let providerFailureClass: AgentProviderFailureClass = "unknown";
    let providerHttpStatus: number | null = null;
    let workerOutcome: AgentWorkerOutcome = this.clientFactory === null ? "not_started" : "not_isolated";
    let workerExitCode: number | null = null;
    let workerResult: IsolatedAgentWorkerResult | null = null;

    try {
      if (this.clientFactory !== null) {
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
      } else {
        const worker = await runIsolatedAgentWorker({
          command: process.execPath,
          args: [this.workerEntrypoint],
          cwd: request.workingDirectory,
          env: this.environment,
          stdin: JSON.stringify({
            protocolVersion: "codex-agent-worker/v1",
            task: request.task,
            threadOptions,
            outputSchema: request.outputSchema
          }),
          processControl,
          graceMs: this.workerGraceMs,
          forceGraceMs: this.workerForceGraceMs,
          onStdoutLine: (line) => {
            processControl.observeEvent();
            observeCommandTiming(line, this.now(), commandTimings, processControl);
            lines.push(line);
          }
        });
        workerResult = worker;
        workerExitCode = worker.exitCode;
        workerOutcome = !worker.terminationConfirmed ? "termination_unconfirmed" :
          worker.exitSignal !== null ? "signaled" :
            worker.exitCode === 0 ? "exited_zero" : "exited_nonzero";
        if (worker.stderr.length > 0) {
          const classified = classifyCodexProviderError(worker.stderr);
          providerFailureClass = classified.failureClass;
          providerHttpStatus = classified.httpStatus;
        }
        if (!worker.terminationConfirmed && processControl.failure()?.code !== "worker_termination_failed") {
          processControl.markWorkerTerminationFailed();
        } else if (processControl.failure()?.code === "agent_timeout") {
          providerFailure = "provider_outcome_ambiguous";
        } else if (worker.exitCode !== 0 && processControl.failure() === null && !request.abortSignal?.aborted) {
          providerFailure = this.providerGate.observe(worker.stderr || { code: "provider_stream_error_unknown" });
          if (providerFailureClass === "unknown" && worker.stderr.trim().length === 0) {
            providerFailureClass = "worker_process_failure";
          }
          adapterDiagnostics.push(diagnostic(providerFailure, "error", providerFailure));
        }
      }
    } catch (error) {
      streamError = error;
      if (processControl.failure() === null && !Boolean(request.abortSignal?.aborted) &&
          !(error instanceof AgentProcessControlError)) {
        providerFailure = this.providerGate.observe(error);
        const classified = classifyCodexProviderError(error);
        providerFailureClass = classified.failureClass;
        providerHttpStatus = classified.httpStatus;
        const message = error instanceof Error ? error.message : "Codex SDK stream failed.";
        try {
          processControl.observeStderr(message);
        } catch (budgetError) {
          streamError = budgetError;
        }
        if (processControl.failure() === null) {
          adapterDiagnostics.push(diagnostic(providerFailure, "error", providerFailure));
          if (this.redactor.redactText(message) !== message) {
            adapterDiagnostics.push(diagnostic("codex_provider_message_redacted", "info", "[REDACTED]"));
          }
        }
      }
    } finally {
      processControl.close();
    }

    const processFailure = processControl.failure();
    const finalTermination: RunTermination = processFailure?.code === "agent_timeout"
      ? "timed_out"
      : processFailure !== null ? "budget_failed"
        : Boolean(request.abortSignal?.aborted) ? "aborted" : "none";
    const durationMs = Math.max(0, this.now() - startedAtMs);
    const parsed = parseCodexJsonl(lines.join("\n"), {
      processAborted: finalTermination !== "none", durationMs
    });
    const workerDiagnostic = workerResult !== null &&
      (workerResult.exitCode !== 0 || parsed.status !== "completed")
      ? createWorkerFailureDiagnostic({
          executable: process.execPath, args: [this.workerEntrypoint],
          cwd: request.workingDirectory, worker: workerResult, stdoutLines: lines,
          parserStatus: parsed.status, terminalTurnObserved: parsed.terminalTurnObserved,
          redactor: this.redactor
        })
      : null;

    // Errors can be reported inside JSONL without throwing from the SDK.
    if (finalTermination === "none" && providerFailure === null) {
      const providerDiagnostics = parsed.diagnostics.filter(
        (entry) => ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(entry.code)
      );
      if (providerDiagnostics.length > 0) {
        for (const entry of providerDiagnostics) {
          const classified = classifyCodexProviderError({ message: entry.message });
          if (providerFailureClass === "unknown") providerFailureClass = classified.failureClass;
          const candidate = this.providerGate.observe({ code: entry.code === "codex_provider_auth" ? "authentication_failed" : entry.code === "codex_provider_quota" ? "usage_limit_exceeded" : entry.code === "codex_provider_capacity" ? "provider_overloaded" : entry.message });
          if (providerFailure === null || providerFailure === "provider_stream_error_unknown") {
            providerFailure = candidate;
          }
        }
      } else if (parsed.status === "partial") {
        providerFailure = this.providerGate.observe({ code: "provider_stream_error_unknown" });
      }
    }

    if (providerFailureClass === "unknown") {
      if (providerFailure === "authentication_failed") providerFailureClass = "auth";
      else if (providerFailure === "usage_limit_exceeded") providerFailureClass = "quota";
      else if (providerFailure === "provider_overloaded") providerFailureClass = "capacity_overload";
      else if (parsed.status === "partial" &&
        (workerOutcome === "exited_zero" || workerOutcome === "not_isolated")) {
        providerFailureClass = "partial_stream";
      }
    }

    if (processFailure !== null) {
      adapterDiagnostics.push(diagnostic(processFailure.code, "error", processFailure.message,
        processFailure.code === "agent_timeout"));
    } else if (streamError !== null && finalTermination === "aborted") {
      adapterDiagnostics.push(diagnostic("codex_aborted", "info", "Codex run was aborted by the caller."));
    }
    if (finalTermination === "none" && parsed.status === "partial") {
      adapterDiagnostics.push(diagnostic(
        "codex_partial_stream", "error", "Codex stream ended without a terminal turn event."
      ));
    }

    const diagnostics: AgentDiagnostic[] = [
      ...parsed.diagnostics.map(({ code, severity, message, retryable }) => ({
        code: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code)
          ? providerFailure ?? "provider_stream_error_unknown" : code,
        severity,
        // Provider errors may include identities; report only normalized codes.
        message: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code)
          ? providerFailure ?? "provider_stream_error_unknown" : this.redactor.redactText(message),
        retryable: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code) ? false : retryable
      })),
      ...adapterDiagnostics.map((entry) => ({
        ...entry,
        message: this.redactor.redactText(entry.message)
      }))
    ];
    const commands = mapCommands(parsed, commandTimings, finalTermination,
      request.workingDirectory, diagnostics, this.redactor);
    if (processFailure?.code === "agent_timeout") providerFailureClass = "timeout";
    else if (finalTermination === "aborted") providerFailureClass = "abort";
    else if (processFailure?.code === "worker_termination_failed" || workerOutcome === "signaled") {
      if (providerFailureClass === "unknown") providerFailureClass = "worker_process_failure";
    }

    let invocationOccurred: boolean | null = null;
    let outcomeKnown: boolean | null = null;

    if (invocationJournal !== null && invocationKey !== null) {
      const successObserved = finalTermination === "none" && processFailure === null &&
        providerFailure === null && parsed.status === "completed";
      const knownFailure = providerFailureClass === "auth" || providerFailureClass === "quota";
      const lifecycle = processControl.lifecycle();
      try {
        const finished = invocationJournal.finish(invocationKey, successObserved ? "completed" :
          knownFailure ? "failed" : "outcome_unknown", {
            failureCode: processFailure?.code ?? providerFailure ??
              (successObserved ? null : "provider_outcome_ambiguous"),
            failureDetail: successObserved ? null : this.redactor.redactText(
              diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ") ||
              "Provider invocation ended without an observed successful outcome."
            ),
            abortRequestedAt: lifecycle.abortRequestedAt,
            workerExitedAt: lifecycle.workerExitedAt,
            exitSignal: lifecycle.exitSignal,
            sessionEvidence: "unknown",
            providerFailureClass,
            providerHttpStatus,
            workerOutcome,
            workerExitCode,
            terminalTurnObserved: parsed.terminalTurnObserved,
            ...(workerDiagnostic === null ? {} : { workerDiagnostic })
          });
        invocationOccurred = finished.invocationOccurred;
        outcomeKnown = finished.state !== "outcome_unknown";
      } catch {
        return emptyResult(request, "failed", Math.max(0, this.now() - startedAtMs), [
          diagnostic("invocation_journal_unavailable", "error", "invocation_journal_unavailable")
        ], "invocation_journal_unavailable");
      }
    }

    return {
      status: providerFailure !== null && finalTermination === "none"
        ? "failed" : mapRunStatus(parsed, finalTermination),
      failureCode: processFailure?.code === "agent_timeout"
        ? "provider_outcome_ambiguous"
        : processFailure?.code ?? providerFailure,
      quotaStatus: "unknown",
      workerLifecycle: this.clientFactory === null ? processControl.lifecycle() : null,
      providerFailureClass,
      providerHttpStatus,
      workerOutcome,
      workerExitCode,
      terminalTurnObserved: parsed.terminalTurnObserved,
      invocationOccurred,
      outcomeKnown,
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
