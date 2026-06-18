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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
