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
  networkAllowed: boolean;
  networkPolicy?: "disabled" | "enabled";
  sandboxMode: AgentSandboxMode;
  additionalDirectories?: readonly string[];
  sourceRepositoryPath?: string;
  outputSchema?: Readonly<Record<string, unknown>>;
  abortSignal?: AbortSignal;
}

export interface AgentRunResult {
  status: AgentRunStatus;
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
