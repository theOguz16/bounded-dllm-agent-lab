import type {
  SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";

export type DllmWorkerMode = "mock" | "dllm" | "llm" | string;

export type DllmWorkerHealthResponse = {
  ok: true;
  workerName: string;
  mode: DllmWorkerMode;
  version?: string;
  modelName?: string;
  upstreamBaseUrl?: string;
  [key: string]: unknown;
};

export type DllmWorkerRefineRequest = {
  requestId: string;
  workspace: SharedSemanticWorkspace;
};

export type DllmWorkerRefineResponse = {
  requestId: string;
  workspace: SharedSemanticWorkspace;
  engineName: string;
  latencyMs: number;
};

export type DllmWorkerInfillRequest = {
  requestId: string;
  region: string;
  prompt: string;
};

export type DllmWorkerInfillResponse = {
  requestId: string;
  region: string;
  content: string;
  engineName: string;
  latencyMs: number;
};

export type DllmWorkerResolveConflictRequest = {
  requestId: string;
  conflictId: string;
  workspace: SharedSemanticWorkspace;
};

export type DllmWorkerResolveConflictResponse = {
  requestId: string;
  conflictId: string;
  resolution: string;
  engineName: string;
  latencyMs: number;
};

export type HttpWorkspaceWorkerClientConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type HttpWorkspaceWorkerClient = {
  baseUrl: string;
  health(): Promise<DllmWorkerHealthResponse>;
  refine(input: DllmWorkerRefineRequest): Promise<DllmWorkerRefineResponse>;
  infill(input: DllmWorkerInfillRequest): Promise<DllmWorkerInfillResponse>;
  resolveConflict(
    input: DllmWorkerResolveConflictRequest
  ): Promise<DllmWorkerResolveConflictResponse>;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function createHttpWorkspaceWorkerClient(
  config: HttpWorkspaceWorkerClientConfig
): HttpWorkspaceWorkerClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 60_000;

  return {
    baseUrl,

    async health(): Promise<DllmWorkerHealthResponse> {
      const body = await requestJson<unknown>({
        url: `${baseUrl}/health`,
        method: "GET",
        apiKey: config.apiKey,
        timeoutMs
      });

      return assertHealthResponse(body);
    },

    async refine(
      input: DllmWorkerRefineRequest
    ): Promise<DllmWorkerRefineResponse> {
      const body = await requestJson<unknown>({
        url: `${baseUrl}/refine`,
        method: "POST",
        apiKey: config.apiKey,
        timeoutMs,
        body: input
      });

      return assertRefineResponse(body);
    },

    async infill(
      input: DllmWorkerInfillRequest
    ): Promise<DllmWorkerInfillResponse> {
      const body = await requestJson<unknown>({
        url: `${baseUrl}/infill`,
        method: "POST",
        apiKey: config.apiKey,
        timeoutMs,
        body: input
      });

      return assertInfillResponse(body);
    },

    async resolveConflict(
      input: DllmWorkerResolveConflictRequest
    ): Promise<DllmWorkerResolveConflictResponse> {
      const body = await requestJson<unknown>({
        url: `${baseUrl}/resolve-conflict`,
        method: "POST",
        apiKey: config.apiKey,
        timeoutMs,
        body: input
      });

      return assertResolveConflictResponse(body);
    }
  };
}

async function requestJson<T>(input: {
  url: string;
  method: "GET" | "POST";
  apiKey?: string;
  timeoutMs: number;
  body?: unknown;
}): Promise<T> {
  const fetchImpl = getFetch();

  if (!fetchImpl) {
    throw new Error("global fetch is not available in this Node.js runtime.");
  }

  const response = await withTimeout(
    fetchImpl(input.url, {
      method: input.method,
      headers: createHeaders(input.apiKey),
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    }),
    input.timeoutMs
  );

  const text = await response.text();
  const parsed = safeJsonParse(text);

  if (!response.ok) {
    throw new Error(`Worker returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (parsed === null) {
    throw new Error(`Worker returned invalid JSON: ${text.slice(0, 1000)}`);
  }

  return parsed as T;
}

function assertHealthResponse(value: unknown): DllmWorkerHealthResponse {
  if (
    isJsonObject(value) &&
    value.ok === true &&
    typeof value.workerName === "string" &&
    value.workerName.length > 0 &&
    typeof value.mode === "string" &&
    value.mode.length > 0
  ) {
    return value as DllmWorkerHealthResponse;
  }

  throw new Error(
    `Worker health response did not match contract: ${JSON.stringify(value).slice(0, 1000)}`
  );
}

function assertRefineResponse(value: unknown): DllmWorkerRefineResponse {
  if (
    isJsonObject(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    isJsonObject(value.workspace) &&
    typeof value.engineName === "string" &&
    value.engineName.length > 0 &&
    typeof value.latencyMs === "number" &&
    value.latencyMs >= 0
  ) {
    return value as DllmWorkerRefineResponse;
  }

  throw new Error(
    `Worker refine response did not match contract: ${JSON.stringify(value).slice(0, 1000)}`
  );
}

function assertInfillResponse(value: unknown): DllmWorkerInfillResponse {
  if (
    isJsonObject(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.region === "string" &&
    value.region.length > 0 &&
    typeof value.content === "string" &&
    typeof value.engineName === "string" &&
    value.engineName.length > 0 &&
    typeof value.latencyMs === "number" &&
    value.latencyMs >= 0
  ) {
    return value as DllmWorkerInfillResponse;
  }

  throw new Error(
    `Worker infill response did not match contract: ${JSON.stringify(value).slice(0, 1000)}`
  );
}

function assertResolveConflictResponse(
  value: unknown
): DllmWorkerResolveConflictResponse {
  if (
    isJsonObject(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.conflictId === "string" &&
    value.conflictId.length > 0 &&
    typeof value.resolution === "string" &&
    value.resolution.length > 0 &&
    typeof value.engineName === "string" &&
    value.engineName.length > 0 &&
    typeof value.latencyMs === "number" &&
    value.latencyMs >= 0
  ) {
    return value as DllmWorkerResolveConflictResponse;
  }

  throw new Error(
    `Worker resolve-conflict response did not match contract: ${JSON.stringify(value).slice(0, 1000)}`
  );
}

function createHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getFetch(): FetchLike | null {
  const fetchImpl = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  return typeof fetchImpl === "function" ? fetchImpl : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Worker request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}