import type { MaskView } from "../../masking-policy/src/index.js";
import type { SharedSemanticWorkspace, WorkspaceRegion } from "../../workspace-core/src/index.js";

export type DllmWorkerRoute = "/health" | "/refine" | "/infill" | "/resolve-conflict";

export type DllmWorkerHealthResponse = {
  ok: boolean;
  workerName: string;
  mode: "mock" | "dllm";
  version: string;
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
  return value.ok === true && typeof value.workerName === "string" && typeof value.version === "string";
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
    isRecord(value.workspace)
  );
}

export function isInfillResponse(value: unknown): value is DllmWorkerInfillResponse {
  if (!isRecord(value)) return false;
  // Infill endpoint'i tek bir region için küçük bir üretim yapar. Bu, dLLM'in
  // "tüm cevabı üret" yerine "maskeli boşluğu doldur" davranışını test etmek için
  // ayrı tutulur.
  return (
    typeof value.requestId === "string" &&
    typeof value.region === "string" &&
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
