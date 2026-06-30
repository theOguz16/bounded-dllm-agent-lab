import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type JsonRecord = Record<string, unknown>;

const port = Number(process.env.MODEL_WORKER_MOCK_PORT ?? "8787");
const host = process.env.MODEL_WORKER_MOCK_HOST ?? "127.0.0.1";

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    writeJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify(
      {
        ok: true,
        server: "model-worker-mock-server",
        status: "ready",
        llmUrl: `http://${host}:${port}/llm`,
        dllmUrl: `http://${host}:${port}/dllm`,
        healthUrl: `http://${host}:${port}/healthz`
      },
      null,
      2
    )
  );
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const path = request.url ?? "/";

  if (request.method === "GET" && path.startsWith("/healthz")) {
    writeJson(response, 200, {
      ok: true,
      status: "ready",
      server: "model-worker-mock-server"
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, {
      ok: false,
      error: "method_not_allowed",
      allowedMethods: ["POST"]
    });
    return;
  }

  const bodyText = await readBody(request);
  const body = parseJsonObject(bodyText);
  const kind = path.includes("dllm") ? "dllm" : "llm";
  const decision = normalizeDecision(process.env.MODEL_WORKER_MOCK_DECISION);
  const promptTokens = countApproxTokens(JSON.stringify(body));
  const completionTokens = kind === "dllm" ? 48 : 40;
  const totalTokens = promptTokens + completionTokens;

  const responseBody: JsonRecord = {
    ok: true,
    modelId:
      kind === "dllm"
        ? process.env.DLLM_MODEL_ID ?? "mock-dllm-worker"
        : process.env.LLM_MODEL_ID ?? "mock-llm-worker",
    kind,
    decision,
    reasoning:
      kind === "dllm"
        ? "Mock dLLM worker response for local HTTP acceptance smoke."
        : "Mock LLM worker response for local HTTP acceptance smoke.",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens
    },
    promptTokens,
    completionTokens,
    totalTokens,
    echo: {
      path,
      receivedJson: Object.keys(body).length > 0
    }
  };

  if (kind === "dllm") {
    responseBody.dllmVerifier = {
      recommendedAction:
        decision === "approve"
          ? "approve"
          : decision === "reject"
            ? "reject"
            : "remask_required",
      signalCount: decision === "approve" ? 0 : 1,
      maskRegionCount: decision === "approve" ? 0 : 1
    };
  }

  writeJson(response, 200, responseBody);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown
): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });

  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

function parseJsonObject(raw: string): JsonRecord {
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }

    return {
      value: parsed
    };
  } catch {
    return {
      raw
    };
  }
}

function normalizeDecision(value: string | undefined): "approve" | "needs_review" | "reject" {
  if (value === "needs_review" || value === "reject" || value === "approve") {
    return value;
  }

  return "approve";
}

function countApproxTokens(value: string): number {
  const normalized = value.trim();

  if (normalized.length === 0) {
    return 32;
  }

  return Math.max(32, Math.ceil(normalized.length / 4));
}
