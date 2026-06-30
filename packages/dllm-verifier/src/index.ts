export type DllmVerifierDecision = "approve" | "remask_required" | "reject";

export type DllmVerifierSignalKind =
  | "scope_broadening"
  | "stale_authority"
  | "unresolved_remask"
  | "sensitive_boundary"
  | "missing_required_context"
  | "forbidden_file_touch";

export type DllmVerifierSignalSeverity = "low" | "medium" | "high" | "critical";

export type DllmVerifierSignal = {
  kind: DllmVerifierSignalKind;
  severity: DllmVerifierSignalSeverity;
  filePath: string | null;
  reason: string;
};

export type DllmMaskRegion = {
  id: string;
  filePath: string;
  reason: string;
  priority: "low" | "medium" | "high";
};

export type DllmVerifierInput = {
  taskId: string;
  changedFiles: string[];
  proposedTouchedFiles: string[];
  allowedFiles: string[];
  requiredFiles: string[];
  unresolvedConflicts: Array<{
    kind: string;
    filePath?: string;
  }>;
  staleFactCount: number;
  sensitivePatternCount: number;
  proposedAddedLines: string[];
};

export type DllmVerifierOutput = {
  ok: boolean;
  taskId: string;
  decision: DllmVerifierDecision;
  signals: DllmVerifierSignal[];
  maskRegions: DllmMaskRegion[];
  approvedFiles: string[];
  rejectedFiles: string[];
  summary: string;
};

const forbiddenAddedPatterns = [
  /authorization:\s*`?Bearer/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i
];

export function runDllmStyleVerifier(input: DllmVerifierInput): DllmVerifierOutput {
  const signals: DllmVerifierSignal[] = [];

  for (const requiredFile of input.requiredFiles) {
    if (!input.proposedTouchedFiles.includes(requiredFile)) {
      signals.push({
        kind: "missing_required_context",
        severity: "medium",
        filePath: requiredFile,
        reason: `Required file was not touched: ${requiredFile}`
      });
    }
  }

  for (const touchedFile of input.proposedTouchedFiles) {
    if (!input.allowedFiles.includes(touchedFile)) {
      signals.push({
        kind: "forbidden_file_touch",
        severity: "critical",
        filePath: touchedFile,
        reason: `Proposed patch touched a file outside the allowed scope: ${touchedFile}`
      });
    }

    if (!input.changedFiles.includes(touchedFile)) {
      signals.push({
        kind: "scope_broadening",
        severity: "high",
        filePath: touchedFile,
        reason: `Proposed patch broadened scope beyond changed files: ${touchedFile}`
      });
    }
  }

  for (const conflict of input.unresolvedConflicts) {
    if (conflict.kind === "remask_unresolved") {
      signals.push({
        kind: "unresolved_remask",
        severity: "high",
        filePath: conflict.filePath ?? null,
        reason: "Patch still contains unresolved remask conflict."
      });
    }

    if (conflict.kind === "stale_authority") {
      signals.push({
        kind: "stale_authority",
        severity: "high",
        filePath: conflict.filePath ?? null,
        reason: "Patch relies on stale authority."
      });
    }
  }

  if (input.staleFactCount > 0) {
    signals.push({
      kind: "stale_authority",
      severity: "medium",
      filePath: null,
      reason: `Repository intelligence reported ${input.staleFactCount} stale fact(s).`
    });
  }

  if (input.sensitivePatternCount > 0) {
    signals.push({
      kind: "sensitive_boundary",
      severity: "high",
      filePath: null,
      reason: `Repository intelligence reported ${input.sensitivePatternCount} sensitive pattern(s).`
    });
  }

  for (const line of input.proposedAddedLines) {
    for (const pattern of forbiddenAddedPatterns) {
      if (pattern.test(line)) {
        signals.push({
          kind: "sensitive_boundary",
          severity: "critical",
          filePath: null,
          reason: `Proposed added line matched forbidden sensitive pattern: ${line.slice(0, 120)}`
        });
      }
    }
  }

  const maskRegions = createMaskRegions(input, signals);
  const hasCritical = signals.some((signal) => signal.severity === "critical");
  const hasHigh = signals.some((signal) => signal.severity === "high");

  const decision: DllmVerifierDecision = hasCritical
    ? "reject"
    : hasHigh || maskRegions.length > 0
      ? "remask_required"
      : "approve";

  return {
    ok: decision !== "reject",
    taskId: input.taskId,
    decision,
    signals,
    maskRegions,
    approvedFiles: decision === "approve" ? input.proposedTouchedFiles : [],
    rejectedFiles: decision === "reject" ? input.proposedTouchedFiles : [],
    summary: summarizeDecision(decision, signals, maskRegions)
  };
}

function createMaskRegions(
  input: DllmVerifierInput,
  signals: DllmVerifierSignal[]
): DllmMaskRegion[] {
  const regions = new Map<string, DllmMaskRegion>();

  for (const signal of signals) {
    if (!signal.filePath) continue;

    const priority: DllmMaskRegion["priority"] =
      signal.severity === "critical" || signal.severity === "high"
        ? "high"
        : signal.severity === "medium"
          ? "medium"
          : "low";

    regions.set(`${signal.kind}:${signal.filePath}`, {
      id: `${input.taskId}:${signal.kind}:${signal.filePath}`,
      filePath: signal.filePath,
      reason: signal.reason,
      priority
    });
  }

  return Array.from(regions.values());
}

function summarizeDecision(
  decision: DllmVerifierDecision,
  signals: DllmVerifierSignal[],
  maskRegions: DllmMaskRegion[]
): string {
  if (decision === "approve") {
    return "Verifier approved the patch because no blocking dLLM-style remask signals were detected.";
  }

  if (decision === "reject") {
    return `Verifier rejected the patch because ${signals.length} signal(s) included critical safety or scope violations.`;
  }

  return `Verifier requires remask because ${signals.length} signal(s) produced ${maskRegions.length} mask region(s).`;
}
