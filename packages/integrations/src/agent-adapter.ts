import type {
  AgentProcessBudgetOverrides,
  AgentProcessFailureCode,
  AgentWorkerLifecycle
} from "./agent-process-control.js";

export type AgentRunStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out"
  | "rejected";

export type AgentMode =
  | "discovery"
  | "planner"
  | "coder"
  | "repair"
  | "baseline";

export type AgentReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "extra_high";

export type AgentSandboxMode =
  | "read_only"
  | "workspace_write"
  | "full_access";

/** Provider-neutral terminal failure categories; provider-specific adapters normalize into them. */
export type AgentProviderFailureCode =
  | "usage_limit_exceeded"
  | "authentication_failed"
  | "provider_overloaded"
  | "provider_stream_error_unknown"
  | "provider_outcome_ambiguous";

/** Safe, bounded observations; never a provider message or worker stderr. */
export type AgentProviderFailureClass =
  | "auth" | "quota" | "model_unsupported" | "context_input_too_large"
  | "capacity_overload" | "timeout" | "abort" | "worker_process_failure"
  | "partial_stream" | "unknown";
export type AgentWorkerOutcome =
  | "exited_zero" | "exited_nonzero" | "signaled" | "termination_unconfirmed"
  | "not_started" | "not_isolated" | "unknown";

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number | null;
  toolCalls?: number | null;
}

export interface AgentCommandEvent {
  sequence: number;
  command: string;
  args: string[];
  workingDirectory: string;
  startedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  status: "completed" | "failed" | "aborted" | "timed_out";
  output?: string | null;
}

export interface AgentFileChangeEvent {
  sequence: number;
  path: string;
  operation: "create" | "modify" | "delete" | "rename";
  previousPath?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  additions?: number;
  deletions?: number;
}

export interface AgentDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  retryable: boolean;
}

export interface AgentRunRequest {
  runId: string;
  agentId: string;
  workingDirectory: string;
  task: string;
  model: string;
  reasoningEffort: AgentReasoningEffort;
  mode: AgentMode;
  timeoutMs: number;
  processBudget?: AgentProcessBudgetOverrides;
  networkAllowed: boolean;
  networkPolicy?: "disabled" | "enabled";
  sandboxMode: AgentSandboxMode;
  additionalDirectories?: readonly string[];
  sourceRepositoryPath?: string;
  repositoryRequirement?: "required" | "none";
  outputSchema?: Readonly<Record<string, unknown>>;
  abortSignal?: AbortSignal;
  invocationRetryDecision?: Readonly<{
    decisionId: string;
    supersedesRunId: string;
  }>;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  failureCode?: AgentProcessFailureCode | AgentProviderFailureCode | null;
  /** Absence of a trusted quota endpoint is never interpreted as availability. */
  quotaStatus?: "unknown";
  /** Present for isolated worker executions; timestamps are distinct by contract. */
  workerLifecycle?: AgentWorkerLifecycle | null;
  providerFailureClass?: AgentProviderFailureClass;
  providerHttpStatus?: number | null;
  workerOutcome?: AgentWorkerOutcome;
  workerExitCode?: number | null;
  terminalTurnObserved?: boolean | null;
  invocationOccurred?: boolean | null;
  outcomeKnown?: boolean | null;
  agentId: string;
  agentVersion: string;
  modelId: string;
  durationMs: number;
  finalMessage: string;
  usage: AgentUsage;
  commands: AgentCommandEvent[];
  fileChanges: AgentFileChangeEvent[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentAdapter {
  readonly agentId: string;
  readonly agentVersion: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
