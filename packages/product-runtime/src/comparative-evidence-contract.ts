export const COMPARATIVE_EVIDENCE_VERSION = "comparative-evidence/v1" as const;

export const ABLATION_MODES = Object.freeze([
  "A_long_context",
  "B_retrieval_context",
  "C_synthetic_context",
  "D_bounded_workspace",
  "E_bounded_workspace_boundary"
] as const);

export type AblationMode = (typeof ABLATION_MODES)[number];

export type ComparativeTaskObservation = Readonly<{
  taskId: string;
  repositoryId: string;
  mode: AblationMode;
  modelId: string;
  providerId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  taskSucceeded: boolean;
  scopeDriftCount: number;
  forbiddenTouchCount: number;
  verifierDecision: "approve" | "needs_review" | "reject";
  oracleLeakageDetected: boolean;
}>;

export type ComparativeEvidenceReport = Readonly<{
  version: typeof COMPARATIVE_EVIDENCE_VERSION;
  evidenceClass: "comparative_benchmark";
  taskIds: readonly string[];
  modes: readonly AblationMode[];
  observations: readonly ComparativeTaskObservation[];
  comparable: boolean;
  comparisonFailureReasons: readonly string[];
}>;

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function createComparativeEvidenceReport(
  observations: readonly ComparativeTaskObservation[]
): ComparativeEvidenceReport {
  if (observations.length === 0) throw new TypeError("At least one observation is required.");

  const normalized = observations.map((entry) => Object.freeze({ ...entry }));
  const taskIds = [...new Set(normalized.map((entry) => entry.taskId))].sort();
  const modes = [...new Set(normalized.map((entry) => entry.mode))].sort() as AblationMode[];
  const failureReasons: string[] = [];

  for (const entry of normalized) {
    if (!ABLATION_MODES.includes(entry.mode)) failureReasons.push(`unknown_mode:${entry.mode}`);
    if (!entry.taskId || !entry.repositoryId || !entry.modelId || !entry.providerId) failureReasons.push("missing_identity_field");
    if (![entry.promptTokens, entry.completionTokens, entry.latencyMs, entry.scopeDriftCount, entry.forbiddenTouchCount].every(isNonNegativeFinite)) {
      failureReasons.push(`invalid_numeric_metric:${entry.taskId}:${entry.mode}`);
    }
    if (entry.oracleLeakageDetected) failureReasons.push(`oracle_leakage:${entry.taskId}:${entry.mode}`);
  }

  const expectedModes = new Set<AblationMode>(ABLATION_MODES);
  for (const taskId of taskIds) {
    const taskRows = normalized.filter((entry) => entry.taskId === taskId);
    const seen = new Set(taskRows.map((entry) => entry.mode));
    for (const mode of expectedModes) if (!seen.has(mode)) failureReasons.push(`missing_mode:${taskId}:${mode}`);
    if (new Set(taskRows.map((entry) => entry.modelId)).size !== 1) failureReasons.push(`model_mismatch:${taskId}`);
    if (new Set(taskRows.map((entry) => entry.providerId)).size !== 1) failureReasons.push(`provider_mismatch:${taskId}`);
    if (new Set(taskRows.map((entry) => entry.repositoryId)).size !== 1) failureReasons.push(`repository_mismatch:${taskId}`);
  }

  const uniqueReasons = [...new Set(failureReasons)].sort();
  return Object.freeze({
    version: COMPARATIVE_EVIDENCE_VERSION,
    evidenceClass: "comparative_benchmark",
    taskIds: Object.freeze(taskIds),
    modes: Object.freeze(modes),
    observations: Object.freeze(normalized),
    comparable: uniqueReasons.length === 0,
    comparisonFailureReasons: Object.freeze(uniqueReasons)
  });
}
