export type ModelAdapterRole =
  | "planner"
  | "coder"
  | "verifier"
  | "tester"
  | "remask"
  | "merge";

export type ModelAdapterMessageRole = "system" | "user" | "assistant";

export type ModelAdapterMessage = {
  role: ModelAdapterMessageRole;
  content: string;
};

export type ModelAdapterResponseFormat = "json" | "text";

export type ModelAdapterUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ModelAdapterRequest = {
  requestId: string;
  workspaceId: string;
  role: ModelAdapterRole;
  task: string;
  messages: ModelAdapterMessage[];
  responseFormat: ModelAdapterResponseFormat;
  temperature: number;
  maxOutputTokens: number;
  metadata: Record<string, string | number | boolean | null>;
};

export type ModelAdapterResponse = {
  requestId: string;
  adapterId: string;
  role: ModelAdapterRole;
  ok: boolean;
  content: string;
  parsedJson: unknown | null;
  usage: ModelAdapterUsage;
  latencyMs: number;
  raw: unknown | null;
  error: string | null;
};

export type ModelAdapter = {
  adapterId: string;
  invoke(request: ModelAdapterRequest): Promise<ModelAdapterResponse>;
};

export type CreateModelAdapterRequestInput = {
  requestId?: string;
  workspaceId: string;
  role: ModelAdapterRole;
  task: string;
  messages: ModelAdapterMessage[];
  responseFormat?: ModelAdapterResponseFormat;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type CreateRoleMessagesInput = {
  role: ModelAdapterRole;
  task: string;
  boundedContext: unknown;
  instruction?: string;
};

export type MockModelAdapterOptions = {
  adapterId?: string;
  latencyMs?: number;
};

export type OpenAICompatibleModelAdapterConfig = {
  adapterId?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function createModelAdapterRequest(
  input: CreateModelAdapterRequestInput
): ModelAdapterRequest {
  return {
    requestId: input.requestId ?? createStableRequestId(input.role),
    workspaceId: input.workspaceId,
    role: input.role,
    task: input.task,
    messages: input.messages,
    responseFormat: input.responseFormat ?? "json",
    temperature: input.temperature ?? 0,
    maxOutputTokens: input.maxOutputTokens ?? 800,
    metadata: input.metadata ?? {}
  };
}

export function createRoleMessages(input: CreateRoleMessagesInput): ModelAdapterMessage[] {
  const roleContract = getRoleContract(input.role);

  return [
    {
      role: "system",
      content: [
        `You are the ${input.role} agent inside a bounded shared semantic workspace runtime.`,
        `You must follow the role contract exactly.`,
        `Return ${input.instruction ?? "valid JSON only"}.`,
        ``,
        `Role contract:`,
        roleContract
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Task:`,
        input.task,
        ``,
        `Bounded context:`,
        JSON.stringify(input.boundedContext, null, 2)
      ].join("\n")
    }
  ];
}

export function createMockModelAdapter(
  options: MockModelAdapterOptions = {}
): ModelAdapter {
  const adapterId = options.adapterId ?? "mock-model-adapter-v1";
  const latencyMs = options.latencyMs ?? 0;

  return {
    adapterId,
    async invoke(request) {
      const startedAt = Date.now();

      if (latencyMs > 0) {
        await delay(latencyMs);
      }

      const payload = createMockPayload(request);
      const content = JSON.stringify(payload, null, 2);

      return {
        requestId: request.requestId,
        adapterId,
        role: request.role,
        ok: true,
        content,
        parsedJson: payload,
        usage: {
          inputTokens: estimateTokensFromMessages(request.messages),
          outputTokens: estimateTokens(content),
          totalTokens: estimateTokensFromMessages(request.messages) + estimateTokens(content)
        },
        latencyMs: Date.now() - startedAt,
        raw: payload,
        error: null
      };
    }
  };
}

export function createOpenAICompatibleModelAdapter(
  config: OpenAICompatibleModelAdapterConfig
): ModelAdapter {
  const adapterId = config.adapterId ?? "openai-compatible-model-adapter-v1";
  const timeoutMs = config.timeoutMs ?? 60_000;

  return {
    adapterId,
    async invoke(request) {
      const startedAt = Date.now();

      try {
        const fetchImpl = getFetch();

        if (!fetchImpl) {
          return createErrorResponse({
            request,
            adapterId,
            startedAt,
            error: "global fetch is not available in this Node.js runtime."
          });
        }

        const endpoint = normalizeChatCompletionsUrl(config.baseUrl);

        const body = {
          model: config.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          response_format:
            request.responseFormat === "json"
              ? {
                  type: "json_object"
                }
              : undefined
        };

        const response = await withTimeout(
          fetchImpl(endpoint, {
            method: "POST",
            headers: createHeaders(config.apiKey),
            body: JSON.stringify(body)
          }),
          timeoutMs
        );

        const text = await response.text();

        if (!response.ok) {
          return createErrorResponse({
            request,
            adapterId,
            startedAt,
            error: `Worker returned HTTP ${response.status}: ${text.slice(0, 1000)}`,
            raw: text
          });
        }

        const raw = safeJsonParse(text);
        const content = extractOpenAICompatibleContent(raw);

        if (!content) {
          return createErrorResponse({
            request,
            adapterId,
            startedAt,
            error: "Worker response did not contain choices[0].message.content.",
            raw
          });
        }

        return {
          requestId: request.requestId,
          adapterId,
          role: request.role,
          ok: true,
          content,
          parsedJson: request.responseFormat === "json" ? parseJsonFromModelText(content) : null,
          usage: extractOpenAICompatibleUsage(raw),
          latencyMs: Date.now() - startedAt,
          raw,
          error: null
        };
      } catch (error) {
        return createErrorResponse({
          request,
          adapterId,
          startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function estimateTokensFromMessages(messages: ModelAdapterMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

function getRoleContract(role: ModelAdapterRole): string {
  switch (role) {
    case "planner":
      return [
        `Return JSON with:`,
        `- kind: "patch_plan"`,
        `- summary: string`,
        `- plannedFiles: string[]`,
        `- risks: string[]`
      ].join("\n");

    case "coder":
      return [
        `Return JSON with:`,
        `- kind: "patch_draft"`,
        `- summary: string`,
        `- files: string[]`,
        `- patch: string`
      ].join("\n");

    case "verifier":
      return [
        `Return JSON with:`,
        `- kind: "verifier_result"`,
        `- decision: "approve" | "reject" | "remask_required" | "human_review_required"`,
        `- findings: array`,
        `- summary: string`
      ].join("\n");

    case "tester":
      return [
        `Return JSON with:`,
        `- kind: "test_signal"`,
        `- recommendedTests: string[]`,
        `- missingTests: string[]`,
        `- summary: string`
      ].join("\n");

    case "remask":
      return [
        `Return JSON with:`,
        `- kind: "remask_repair"`,
        `- repairedRegion: string`,
        `- summary: string`,
        `- requiresSecondPassVerifier: boolean`
      ].join("\n");

    case "merge":
      return [
        `Return JSON with:`,
        `- kind: "merge_decision"`,
        `- decision: "approve" | "reject" | "remask_required" | "human_review_required"`,
        `- mergeSafe: boolean`,
        `- summary: string`
      ].join("\n");
  }
}

function createMockPayload(request: ModelAdapterRequest): Record<string, unknown> {
  switch (request.role) {
    case "planner":
      return {
        kind: "patch_plan",
        decision: "continue",
        summary: "Mock planner produced a bounded patch plan.",
        plannedFiles: getChangedFilesFromMetadata(request),
        risks: ["mock_runtime_only"]
      };

    case "coder":
      return {
        kind: "patch_draft",
        decision: "continue",
        summary: "Mock coder produced a bounded patch draft.",
        files: getChangedFilesFromMetadata(request),
        patch: "mock patch draft"
      };

    case "verifier":
      return {
        kind: "verifier_result",
        decision: "approve",
        findings: [],
        summary: "Mock verifier approved the bounded model output."
      };

    case "tester":
      return {
        kind: "test_signal",
        recommendedTests: ["npm run typecheck", "npm run build"],
        missingTests: [],
        summary: "Mock tester recommended standard runtime checks."
      };

    case "remask":
      return {
        kind: "remask_repair",
        repairedRegion: "mock repaired region",
        summary: "Mock remask repaired the bounded failed region.",
        requiresSecondPassVerifier: true
      };

    case "merge":
      return {
        kind: "merge_decision",
        decision: "approve",
        mergeSafe: true,
        summary: "Mock merge approved the model output contract."
      };
  }
}

function getChangedFilesFromMetadata(request: ModelAdapterRequest): string[] {
  const changedFiles = request.metadata.changedFiles;

  if (typeof changedFiles !== "string") {
    return [];
  }

  return changedFiles
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createErrorResponse(input: {
  request: ModelAdapterRequest;
  adapterId: string;
  startedAt: number;
  error: string;
  raw?: unknown;
}): ModelAdapterResponse {
  return {
    requestId: input.request.requestId,
    adapterId: input.adapterId,
    role: input.request.role,
    ok: false,
    content: "",
    parsedJson: null,
    usage: {},
    latencyMs: Date.now() - input.startedAt,
    raw: input.raw ?? null,
    error: input.error
  };
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

function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");

  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }

  return `${trimmed}/v1/chat/completions`;
}

function extractOpenAICompatibleContent(raw: unknown): string | null {
  if (!isJsonObject(raw)) {
    return null;
  }

  const choices = raw.choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const first = choices[0];

  if (!isJsonObject(first)) {
    return null;
  }

  const message = first.message;

  if (!isJsonObject(message)) {
    return null;
  }

  return typeof message.content === "string" ? message.content : null;
}

function extractOpenAICompatibleUsage(raw: unknown): ModelAdapterUsage {
  if (!isJsonObject(raw) || !isJsonObject(raw.usage)) {
    return {};
  }

  const usage = raw.usage;

  return {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens)
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseJsonFromModelText(value: string): unknown | null {
  const direct = safeJsonParse(value);

  if (direct) {
    return direct;
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return safeJsonParse(value.slice(firstBrace, lastBrace + 1));
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
          reject(new Error(`Model worker request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createStableRequestId(role: ModelAdapterRole): string {
  return `model-request-${role}-${Date.now()}`;
}