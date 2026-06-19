import type { MaskView } from "../../masking-policy/src/index.js";
import type { SharedSemanticWorkspace, WorkspaceRegion } from "../../workspace-core/src/index.js";

export type DllmWorkerRoute = "/health" | "/refine" | "/infill" | "/resolve-conflict";

const workspaceRegions = new Set<WorkspaceRegion>([
  "plan",
  "patch_intent",
  "risk_analysis",
  "review",
  "boundary_decision",
  "verifier_feedback",
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
  // Worker contract tarafı bilinçli olarak ince tutulur. Benchmark, memory policy,
  // scope kuralları ve verifier kararları TypeScript tarafında kalır. Python worker
  // sadece kendisine verilen masked workspace'i refine eden izole inference katmanıdır.
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
  // Buradaki runtime guard TypeScript tiplerinin Python tarafında otomatik olarak
  // korunmadığını hatırlatır. Dil sınırından gelen JSON'u güvenmeden önce en azından
  // ana alanları kontrol ediyoruz.
  return (
    typeof value.requestId === "string" &&
    typeof value.engineName === "string" &&
    typeof value.latencyMs === "number" &&
    isWorkspaceLike(value.workspace)
  );
}

export function isInfillResponse(value: unknown): value is DllmWorkerInfillResponse {
  if (!isRecord(value)) return false;
  // Infill endpoint'i tek bir region için küçük bir üretim yapar. Bu, dLLM'in
  // "tüm cevabı üret" yerine "maskeli boşluğu doldur" davranışını test etmek için
  // ayrı tutulur.
  return (
    typeof value.requestId === "string" &&
    isWorkspaceRegion(value.region) &&
    typeof value.content === "string" &&
    typeof value.engineName === "string" &&
    typeof value.latencyMs === "number"
  );
}

export function isResolveConflictResponse(value: unknown): value is DllmWorkerResolveConflictResponse {
  if (!isRecord(value)) return false;
  // Conflict çözümü ayrı endpoint'tir çünkü conflict resolution ileride modelin
  // iki iddia arasından hangisinin evidence'a daha uygun olduğunu tartmasını sağlar.
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
  // Worker response içinde tüm workspace'i derinlemesine validate etmek pahalı ve
  // tekrarlı olur; ama ana iskeleti kontrol etmek gerekir. Çünkü Python tarafı bozuk
  // JSON döndürürse TypeScript tipi bunu otomatik yakalayamaz.
  return (
    typeof value.id === "string" &&
    typeof value.version === "number" &&
    isRecord(value.packet) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.conflicts) &&
    Array.isArray(value.maskedRegions) &&
    Array.isArray(value.verifierResults) &&
    Array.isArray(value.trace)
  );
}

function isWorkspaceRegion(value: unknown): value is WorkspaceRegion {
  return typeof value === "string" && workspaceRegions.has(value as WorkspaceRegion);
}
