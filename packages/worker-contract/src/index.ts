import type { MaskView } from "../../masking-policy/src/index.js";
import type {
  SharedSemanticWorkspace,
  WorkspaceRegion
} from "../../workspace-core/src/index.js";

export type DllmWorkerRoute =
  | "/health"
  | "/refine"
  | "/infill"
  | "/resolve-conflict";

/**
 * Worker tarafında geçerli workspace region set'i.
 * Eski plan/review/risk_analysis/boundary_decision/verifier_feedback region'larını
 * burada tutmuyoruz; worker contract da yeni canonical workspace dilini kullanmalı.
 */
const workspaceRegions = new Set<WorkspaceRegion>([
  "task",
  "scope",
  "authority",
  "policy",
  "repo_facts",
  "patch_intent",
  "role_view",
  "claim",
  "patch_plan",
  "patch_draft",
  "verifier_result",
  "test_signal",
  "remask_request",
  "conflict",
  "merge_decision",
  "final_result"
]);

export type DllmWorkerHealthResponse = {
  ok: boolean;
  workerName: string;
  mode: "mock" | "dllm" | "llm";
  version: string;
  modelName?: string;
  modelVersion?: string;
  upstreamBaseUrl?: string;
};

export type DllmWorkerRefineRequest = {
  requestId: string;
  view: MaskView;
  workspace: SharedSemanticWorkspace;
  maskedRegions: WorkspaceRegion[];
};

export type DllmWorkerRefineResponse = {
  requestId: string;
  workspace: SharedSemanticWorkspace;
  engineName: string;
  latencyMs: number;
};

export type DllmWorkerInfillRequest = {
  requestId: string;
  view: MaskView;
  workspace: SharedSemanticWorkspace;
  region: WorkspaceRegion;
  prompt: string;
};

export type DllmWorkerInfillResponse = {
  requestId: string;
  region: WorkspaceRegion;
  content: string;
  engineName: string;
  latencyMs: number;
};

export type DllmWorkerResolveConflictRequest = {
  requestId: string;
  workspace: SharedSemanticWorkspace;
  conflictId: string;
};

export type DllmWorkerResolveConflictResponse = {
  requestId: string;
  conflictId: string;
  resolution: string;
  engineName: string;
  latencyMs: number;
};

export type DllmWorkerErrorResponse = {
  ok: false;
  error: string;
  requestId?: string;
};

export function createRefineRequest(input: {
  requestId: string;
  view: MaskView;
  workspace: SharedSemanticWorkspace;
}): DllmWorkerRefineRequest {
  /**
   * Worker contract bilinçli olarak ince tutulur.
   * Policy, orchestration ve verifier kararları TypeScript tarafında kalır.
   * Worker sadece masked workspace'i refine eden inference katmanıdır.
   */
  return {
    requestId: input.requestId,
    view: input.view,
    workspace: input.workspace,
    maskedRegions: input.workspace.maskedRegions
  };
}

export function isHealthResponse(value: unknown): value is DllmWorkerHealthResponse {
  if (!isRecord(value)) return false;

  return (
    value.ok === true &&
    typeof value.workerName === "string" &&
    (value.mode === "mock" || value.mode === "dllm" || value.mode === "llm") &&
    typeof value.version === "string" &&
    (value.modelName === undefined || typeof value.modelName === "string") &&
    (value.modelVersion === undefined || typeof value.modelVersion === "string") &&
    (value.upstreamBaseUrl === undefined || typeof value.upstreamBaseUrl === "string")
  );
}

export function isRefineResponse(value: unknown): value is DllmWorkerRefineResponse {
  if (!isRecord(value)) return false;

  /**
   * Python/worker sınırından gelen JSON'a güvenmiyoruz.
   * TypeScript tipi runtime'da korunmadığı için ana workspace iskeletini kontrol ediyoruz.
   */
  return (
    typeof value.requestId === "string" &&
    typeof value.engineName === "string" &&
    typeof value.latencyMs === "number" &&
    isWorkspaceLike(value.workspace)
  );
}

export function isInfillResponse(value: unknown): value is DllmWorkerInfillResponse {
  if (!isRecord(value)) return false;

  /**
   * Infill endpoint'i tek region üretimi içindir.
   * Bu, dLLM-style "bütün cevabı üretme, maskeli boşluğu doldur" davranışını test eder.
   */
  return (
    typeof value.requestId === "string" &&
    isWorkspaceRegion(value.region) &&
    typeof value.content === "string" &&
    typeof value.engineName === "string" &&
    typeof value.latencyMs === "number"
  );
}

export function isResolveConflictResponse(
  value: unknown
): value is DllmWorkerResolveConflictResponse {
  if (!isRecord(value)) return false;

  /**
   * Conflict resolution ayrı endpoint'tir.
   * Merge aşamasının iki claim veya iki write arasındaki çelişkiyi çözmesini sağlar.
   */
  return (
    typeof value.requestId === "string" &&
    typeof value.conflictId === "string" &&
    typeof value.resolution === "string" &&
    typeof value.engineName === "string" &&
    typeof value.latencyMs === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkspaceLike(value: unknown): value is SharedSemanticWorkspace {
  if (!isRecord(value)) return false;

  /**
   * Eski guard version + packet bekliyordu.
   * Yeni canonical workspace schemaVersion + revision + product state alanlarıyla tanınır.
   */
  return (
    value.schemaVersion === "shared-semantic-workspace/v1" &&
    typeof value.id === "string" &&
    typeof value.revision === "number" &&
    isRecord(value.task) &&
    isRecord(value.scope) &&
    isRecord(value.authority) &&
    isRecord(value.policy) &&
    isRecord(value.repoFacts) &&
    isRecord(value.patchIntent) &&
    Array.isArray(value.activeRoles) &&
    isRecord(value.roleViews) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.conflicts) &&
    Array.isArray(value.maskedRegions) &&
    Array.isArray(value.verifierResults) &&
    Array.isArray(value.testSignals) &&
    Array.isArray(value.remaskRequests) &&
    Array.isArray(value.trace)
  );
}

function isWorkspaceRegion(value: unknown): value is WorkspaceRegion {
  return typeof value === "string" && workspaceRegions.has(value as WorkspaceRegion);
}