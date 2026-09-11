import path from "node:path";

import type {
  AgentMode,
  AgentRunRequest,
  AgentSandboxMode
} from "./agent-adapter.js";

export const AGENT_ISOLATION_POLICY_VERSION = "agent-isolation-policy/v1" as const;

export type AgentNetworkPolicy = "disabled" | "enabled";
export type AgentIsolationSandboxMode = "read-only" | "workspace-write";
export type AgentIsolationWebSearchMode = "disabled";
export type AgentIsolationApprovalPolicy = "never";

export type AgentIsolationPolicyRejectionReason =
  | "danger_full_access"
  | "sandbox_escalation"
  | "network_policy_required"
  | "additional_directory_invalid"
  | "additional_directory_source_context_required"
  | "additional_directory_source_overlap";

export type AgentIsolationPolicy = Readonly<{
  policyVersion: typeof AGENT_ISOLATION_POLICY_VERSION;
  sandboxMode: AgentIsolationSandboxMode;
  networkAccessEnabled: boolean;
  webSearchMode: AgentIsolationWebSearchMode;
  approvalPolicy: AgentIsolationApprovalPolicy;
  additionalDirectories: readonly string[];
}>;

export class AgentIsolationPolicyError extends Error {
  readonly code = "agent_isolation_policy_rejected" as const;
  readonly reason: AgentIsolationPolicyRejectionReason;

  constructor(reason: AgentIsolationPolicyRejectionReason, message: string) {
    super(message);
    this.name = "AgentIsolationPolicyError";
    this.reason = reason;
  }
}

type IsolationRequest = Readonly<Pick<
  AgentRunRequest,
  | "mode"
  | "workingDirectory"
  | "sandboxMode"
  | "networkAllowed"
  | "networkPolicy"
  | "additionalDirectories"
  | "sourceRepositoryPath"
>>;

function defaultSandbox(mode: AgentMode): AgentIsolationSandboxMode {
  if (mode === "planner" || mode === "discovery") return "read-only";
  return "workspace-write";
}

function requestedSandbox(mode: AgentMode, requested: AgentSandboxMode): AgentIsolationSandboxMode {
  if (requested === "full_access") {
    throw new AgentIsolationPolicyError(
      "danger_full_access",
      "danger-full-access/full_access is forbidden by the agent isolation policy."
    );
  }

  const defaults = defaultSandbox(mode);
  if (defaults === "read-only" && requested === "workspace_write") {
    throw new AgentIsolationPolicyError(
      "sandbox_escalation",
      "Planner/discovery runs may not escalate beyond read-only sandbox access."
    );
  }

  if (requested === "read_only") return "read-only";
  return "workspace-write";
}

function isContainedBy(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlaps(left: string, right: string): boolean {
  return isContainedBy(left, right) || isContainedBy(right, left);
}

function normalizeAdditionalDirectories(request: IsolationRequest): readonly string[] {
  const raw = request.additionalDirectories ?? [];
  if (!Array.isArray(raw)) {
    throw new AgentIsolationPolicyError(
      "additional_directory_invalid",
      "additionalDirectories must be an array."
    );
  }
  if (raw.length === 0) return Object.freeze([] as string[]);

  if (
    typeof request.sourceRepositoryPath !== "string" ||
    request.sourceRepositoryPath.trim().length === 0
  ) {
    throw new AgentIsolationPolicyError(
      "additional_directory_source_context_required",
      "Additional directories require the source repository path so overlap can be checked fail-closed."
    );
  }

  const sourceRepositoryPath = path.resolve(request.sourceRepositoryPath);
  const normalized = raw.map((value) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.trim() !== value ||
      value.includes("\u0000")
    ) {
      throw new AgentIsolationPolicyError(
        "additional_directory_invalid",
        "additionalDirectories contains an invalid path."
      );
    }
    const resolved = path.resolve(request.workingDirectory, value);
    if (overlaps(sourceRepositoryPath, resolved)) {
      throw new AgentIsolationPolicyError(
        "additional_directory_source_overlap",
        "The source repository or any overlapping parent/child directory may not be added to the agent sandbox."
      );
    }
    return resolved;
  });

  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw new AgentIsolationPolicyError(
      "additional_directory_invalid",
      "additionalDirectories must not contain duplicates after normalization."
    );
  }
  return Object.freeze(unique.sort((left, right) => left.localeCompare(right, "en")));
}

export function resolveAgentIsolationPolicy(request: IsolationRequest): AgentIsolationPolicy {
  const networkPolicy: AgentNetworkPolicy = request.networkPolicy ?? "disabled";
  if (request.networkAllowed === true && networkPolicy !== "enabled") {
    throw new AgentIsolationPolicyError(
      "network_policy_required",
      "Network access requires explicit networkPolicy=enabled authorization."
    );
  }

  return Object.freeze({
    policyVersion: AGENT_ISOLATION_POLICY_VERSION,
    sandboxMode: requestedSandbox(request.mode, request.sandboxMode),
    networkAccessEnabled: request.networkAllowed === true && networkPolicy === "enabled",
    webSearchMode: "disabled" as const,
    approvalPolicy: "never" as const,
    additionalDirectories: normalizeAdditionalDirectories(request)
  });
}
