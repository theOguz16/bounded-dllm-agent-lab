export const AGENT_PROCESS_CONTROL_VERSION = "agent-process-control/v1" as const;

export type AgentProcessFailureCode =
  | "agent_timeout"
  | "agent_output_limit"
  | "agent_event_budget_exceeded"
  | "agent_command_budget_exceeded"
  | "agent_repair_budget_exceeded"
  | "agent_provider_call_budget_exceeded"
  | "agent_model_call_budget_exceeded";

export type AgentProcessBudgetLimits = Readonly<{
  totalTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxEvents: number;
  maxCommands: number;
  maxRepairRounds: number;
  maxProviderCalls: number;
  maxModelCalls: number;
}>;

export type AgentProcessBudgetOverrides = Readonly<Partial<AgentProcessBudgetLimits>>;

export type AgentProcessBudgetUsage = Readonly<{
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
  commandCount: number;
  repairRounds: number;
  providerCalls: number;
  modelCalls: number;
}>;

export type AgentProcessFailure = Readonly<{
  code: AgentProcessFailureCode;
  message: string;
}>;

export type AgentProcessControl = Readonly<{
  version: typeof AGENT_PROCESS_CONTROL_VERSION;
  limits: AgentProcessBudgetLimits;
  signal: AbortSignal;
  observeStdout(value: string | Uint8Array): void;
  observeStderr(value: string | Uint8Array): void;
  observeEvent(count?: number): void;
  observeCommand(commandId: string): void;
  recordRepairRound(count?: number): void;
  recordProviderCall(count?: number): void;
  recordModelCall(count?: number): void;
  failure(): AgentProcessFailure | null;
  usage(): AgentProcessBudgetUsage;
  throwIfFailed(): void;
  close(): void;
}>;

export class AgentProcessControlError extends Error {
  constructor(
    readonly code: AgentProcessFailureCode,
    message: string
  ) {
    super(message);
    this.name = "AgentProcessControlError";
  }
}

export const DEFAULT_AGENT_PROCESS_BUDGET = Object.freeze({
  totalTimeoutMs: 120_000,
  maxStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 2 * 1024 * 1024,
  maxEvents: 20_000,
  maxCommands: 256,
  maxRepairRounds: 1,
  maxProviderCalls: 8,
  maxModelCalls: 8
}) satisfies AgentProcessBudgetLimits;

function safeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function safePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

export function resolveAgentProcessBudget(
  totalTimeoutMs: number,
  overrides: AgentProcessBudgetOverrides = {}
): AgentProcessBudgetLimits {
  const requestTimeout = safePositiveInteger(totalTimeoutMs, "totalTimeoutMs");
  const overrideTimeout = overrides.totalTimeoutMs === undefined
    ? requestTimeout
    : safePositiveInteger(overrides.totalTimeoutMs, "processBudget.totalTimeoutMs");

  return Object.freeze({
    totalTimeoutMs: Math.min(requestTimeout, overrideTimeout),
    maxStdoutBytes: safeNonNegativeInteger(
      overrides.maxStdoutBytes ?? DEFAULT_AGENT_PROCESS_BUDGET.maxStdoutBytes,
      "processBudget.maxStdoutBytes"
    ),
    maxStderrBytes: safeNonNegativeInteger(
      overrides.maxStderrBytes ?? DEFAULT_AGENT_PROCESS_BUDGET.maxStderrBytes,
      "processBudget.maxStderrBytes"
    ),
    maxEvents: safeNonNegativeInteger(
      overrides.maxEvents ?? DEFAULT_AGENT_PROCESS_BUDGET.maxEvents,
      "processBudget.maxEvents"
    ),
    maxCommands: safeNonNegativeInteger(
      overrides.maxCommands ?? DEFAULT_AGENT_PROCESS_BUDGET.maxCommands,
      "processBudget.maxCommands"
    ),
    maxRepairRounds: safeNonNegativeInteger(
      overrides.maxRepairRounds ?? DEFAULT_AGENT_PROCESS_BUDGET.maxRepairRounds,
      "processBudget.maxRepairRounds"
    ),
    maxProviderCalls: safeNonNegativeInteger(
      overrides.maxProviderCalls ?? DEFAULT_AGENT_PROCESS_BUDGET.maxProviderCalls,
      "processBudget.maxProviderCalls"
    ),
    maxModelCalls: safeNonNegativeInteger(
      overrides.maxModelCalls ?? DEFAULT_AGENT_PROCESS_BUDGET.maxModelCalls,
      "processBudget.maxModelCalls"
    )
  });
}

function incremented(current: number, count: number, field: string): number {
  safeNonNegativeInteger(count, field);
  const next = current + count;
  if (!Number.isSafeInteger(next)) {
    throw new TypeError(`${field} exceeds the safe integer range.`);
  }
  return next;
}

export function createAgentProcessControl(input: Readonly<{
  totalTimeoutMs: number;
  budget?: AgentProcessBudgetOverrides;
  parentSignal?: AbortSignal;
}>): AgentProcessControl {
  const limits = resolveAgentProcessBudget(input.totalTimeoutMs, input.budget);
  const controller = new AbortController();
  const commandIds = new Set<string>();

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let eventCount = 0;
  let repairRounds = 0;
  let providerCalls = 0;
  let modelCalls = 0;
  let processFailure: AgentProcessFailure | null = null;
  let closed = false;

  const setFailure = (code: AgentProcessFailureCode, message: string): AgentProcessControlError => {
    if (processFailure === null) {
      processFailure = Object.freeze({ code, message });
      controller.abort(new AgentProcessControlError(code, message));
    }
    return new AgentProcessControlError(processFailure.code, processFailure.message);
  };

  const fail = (code: AgentProcessFailureCode, message: string): never => {
    throw setFailure(code, message);
  };

  const abortFromParent = (): void => {
    if (!controller.signal.aborted) controller.abort(input.parentSignal?.reason);
  };
  if (input.parentSignal?.aborted === true) abortFromParent();
  else input.parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutHandle = setTimeout(() => {
    if (closed || controller.signal.aborted) return;
    setFailure(
      "agent_timeout",
      `Agent exceeded the total timeout budget of ${limits.totalTimeoutMs} ms.`
    );
  }, limits.totalTimeoutMs);

  const assertOpen = (): void => {
    if (closed) throw new Error("Agent process control is closed.");
    if (processFailure !== null) {
      throw new AgentProcessControlError(processFailure.code, processFailure.message);
    }
  };

  const api: AgentProcessControl = Object.freeze({
    version: AGENT_PROCESS_CONTROL_VERSION,
    limits,
    signal: controller.signal,
    observeStdout(value) {
      assertOpen();
      stdoutBytes = incremented(stdoutBytes, byteLength(value), "stdoutBytes");
      if (stdoutBytes > limits.maxStdoutBytes) {
        fail(
          "agent_output_limit",
          `Agent stdout exceeded the ${limits.maxStdoutBytes}-byte limit.`
        );
      }
    },
    observeStderr(value) {
      assertOpen();
      stderrBytes = incremented(stderrBytes, byteLength(value), "stderrBytes");
      if (stderrBytes > limits.maxStderrBytes) {
        fail(
          "agent_output_limit",
          `Agent stderr exceeded the ${limits.maxStderrBytes}-byte limit.`
        );
      }
    },
    observeEvent(count = 1) {
      assertOpen();
      eventCount = incremented(eventCount, count, "eventCount");
      if (eventCount > limits.maxEvents) {
        fail(
          "agent_event_budget_exceeded",
          `Agent event count exceeded the limit of ${limits.maxEvents}.`
        );
      }
    },
    observeCommand(commandId) {
      assertOpen();
      if (typeof commandId !== "string" || commandId.length === 0) {
        throw new TypeError("commandId must be a non-empty string.");
      }
      commandIds.add(commandId);
      if (commandIds.size > limits.maxCommands) {
        fail(
          "agent_command_budget_exceeded",
          `Agent command count exceeded the limit of ${limits.maxCommands}.`
        );
      }
    },
    recordRepairRound(count = 1) {
      assertOpen();
      repairRounds = incremented(repairRounds, count, "repairRounds");
      if (repairRounds > limits.maxRepairRounds) {
        fail(
          "agent_repair_budget_exceeded",
          `Agent repair rounds exceeded the limit of ${limits.maxRepairRounds}.`
        );
      }
    },
    recordProviderCall(count = 1) {
      assertOpen();
      providerCalls = incremented(providerCalls, count, "providerCalls");
      if (providerCalls > limits.maxProviderCalls) {
        fail(
          "agent_provider_call_budget_exceeded",
          `Agent provider calls exceeded the limit of ${limits.maxProviderCalls}.`
        );
      }
    },
    recordModelCall(count = 1) {
      assertOpen();
      modelCalls = incremented(modelCalls, count, "modelCalls");
      if (modelCalls > limits.maxModelCalls) {
        fail(
          "agent_model_call_budget_exceeded",
          `Agent model calls exceeded the limit of ${limits.maxModelCalls}.`
        );
      }
    },
    failure() {
      return processFailure;
    },
    usage() {
      return Object.freeze({
        stdoutBytes,
        stderrBytes,
        eventCount,
        commandCount: commandIds.size,
        repairRounds,
        providerCalls,
        modelCalls
      });
    },
    throwIfFailed() {
      if (processFailure !== null) {
        throw new AgentProcessControlError(processFailure.code, processFailure.message);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeoutHandle);
      input.parentSignal?.removeEventListener("abort", abortFromParent);
    }
  });

  return api;
}
