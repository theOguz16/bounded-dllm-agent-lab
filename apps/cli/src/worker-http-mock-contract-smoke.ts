import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import {
  analyzeRepository
} from "../../../packages/repo-intelligence/src/index.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import {
  createHttpWorkspaceWorkerClient
} from "../../../packages/worker-contract/src/index.js";
import {
  addVerifierResult,
  setFinalResult,
  type SharedSemanticWorkspace
} from "../../../packages/workspace-core/src/index.js";

const workerName = "local-mock-http-workspace-worker";
const workerVersion = "0.1.0";

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before worker HTTP mock contract smoke.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

const fixture = remaskFixtures[0];

if (!fixture) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "No fixture found for worker HTTP mock contract smoke."
      },
      null,
      2
    )
  );
}

const repoResult = await analyzeRepository({
  rootDir: process.cwd(),
  changedFiles,
  maxFiles: 1000
});

const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
  id: `worker-http-mock-contract-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);

const server = await startMockWorkerServer();
const workerUrl = resolveServerUrl(server);

try {
  const client = createHttpWorkspaceWorkerClient({
    baseUrl: workerUrl,
    timeoutMs: 30_000
  });

  const health = await client.health();

  const refineResponse = await client.refine({
    requestId: `mock-refine-${Date.now()}`,
    workspace
  });

  const infillResponse = await client.infill({
    requestId: `mock-infill-${Date.now()}`,
    region: "patch_draft",
    prompt: "Repair only the failed bounded region."
  });

  const resolveConflictResponse = await client.resolveConflict({
    requestId: `mock-resolve-conflict-${Date.now()}`,
    conflictId: "mock-conflict-001",
    workspace
  });

  const failures = validateResult({
    health,
    refineResponse,
    infillResponse,
    resolveConflictResponse
  });

  if (failures.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Worker HTTP mock contract smoke failed.",
          failures,
          summary: summarizeResult({
            workerUrl,
            health,
            refineResponse,
            infillResponse,
            resolveConflictResponse
          })
        },
        null,
        2
      )
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        smokeName: "worker-http-mock-contract-smoke",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
        summary: summarizeResult({
          workerUrl,
          health,
          refineResponse,
          infillResponse,
          resolveConflictResponse
        })
      },
      null,
      2
    )
  );
} finally {
  await closeServer(server);
}

function validateResult(input: {
  health: Record<string, unknown>;
  refineResponse: Record<string, unknown>;
  infillResponse: Record<string, unknown>;
  resolveConflictResponse: Record<string, unknown>;
}): string[] {
  const failures: string[] = [];

  if (input.health.ok !== true) {
    failures.push("Expected health.ok=true.");
  }

  if (input.health.workerName !== workerName) {
    failures.push(`Expected workerName ${workerName}, got ${String(input.health.workerName)}.`);
  }

  if (input.health.mode !== "mock") {
    failures.push(`Expected health.mode mock, got ${String(input.health.mode)}.`);
  }

  if (input.refineResponse.requestId === undefined) {
    failures.push("Expected refine response requestId.");
  }

  if (!isJsonObject(input.refineResponse.workspace)) {
    failures.push("Expected refine response workspace object.");
  } else {
    const outputWorkspace = input.refineResponse.workspace;

    if (outputWorkspace.id !== workspace.id) {
      failures.push(`Expected refined workspace id ${workspace.id}, got ${String(outputWorkspace.id)}.`);
    }

    if (JSON.stringify(outputWorkspace) === JSON.stringify(workspace)) {
      failures.push("Expected refine response workspace to be mutated.");
    }
  }

  if (input.refineResponse.engineName !== workerName) {
    failures.push(
      `Expected refine engineName ${workerName}, got ${String(input.refineResponse.engineName)}.`
    );
  }

  if (input.infillResponse.region !== "patch_draft") {
    failures.push(
      `Expected infill region patch_draft, got ${String(input.infillResponse.region)}.`
    );
  }

  if (typeof input.infillResponse.content !== "string" || input.infillResponse.content.length === 0) {
    failures.push("Expected infill response content to be non-empty.");
  }

  if (input.resolveConflictResponse.conflictId !== "mock-conflict-001") {
    failures.push(
      `Expected resolve conflict id mock-conflict-001, got ${String(input.resolveConflictResponse.conflictId)}.`
    );
  }

  if (
    typeof input.resolveConflictResponse.resolution !== "string" ||
    input.resolveConflictResponse.resolution.length === 0
  ) {
    failures.push("Expected resolve conflict response resolution to be non-empty.");
  }

  return failures;
}

function summarizeResult(input: {
  workerUrl: string;
  health: Record<string, unknown>;
  refineResponse: Record<string, unknown>;
  infillResponse: Record<string, unknown>;
  resolveConflictResponse: Record<string, unknown>;
}): Record<string, unknown> {
  const refinedWorkspace = isJsonObject(input.refineResponse.workspace)
    ? input.refineResponse.workspace
    : {};

  return {
    worker: {
      url: input.workerUrl,
      health: input.health
    },
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    refine: {
      requestId: input.refineResponse.requestId,
      engineName: input.refineResponse.engineName,
      latencyMs: input.refineResponse.latencyMs,
      inputWorkspaceId: workspace.id,
      outputWorkspaceId: refinedWorkspace.id,
      workspaceMutated: JSON.stringify(refinedWorkspace) !== JSON.stringify(workspace),
      finalResult: readMaybeFinalResult(refinedWorkspace),
      verifierResultCount: Array.isArray(refinedWorkspace.verifierResults)
        ? refinedWorkspace.verifierResults.length
        : undefined
    },
    infill: {
      requestId: input.infillResponse.requestId,
      region: input.infillResponse.region,
      content: input.infillResponse.content,
      engineName: input.infillResponse.engineName,
      latencyMs: input.infillResponse.latencyMs
    },
    resolveConflict: {
      requestId: input.resolveConflictResponse.requestId,
      conflictId: input.resolveConflictResponse.conflictId,
      resolution: input.resolveConflictResponse.resolution,
      engineName: input.resolveConflictResponse.engineName,
      latencyMs: input.resolveConflictResponse.latencyMs
    }
  };
}

async function startMockWorkerServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, {
          ok: true,
          workerName,
          mode: "mock",
          version: workerVersion
        });
        return;
      }

      if (request.method === "POST" && request.url === "/refine") {
        await handleRefine(request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/infill") {
        await handleInfill(request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/resolve-conflict") {
        await handleResolveConflict(request, response);
        return;
      }

      writeJson(response, 404, {
        ok: false,
        error: "not_found"
      });
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function handleRefine(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const startedAt = Date.now();
  const body = await readJson(request);

  if (!isJsonObject(body)) {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_json"
    });
    return;
  }

  const requestId = body.requestId;
  const inputWorkspace = body.workspace;

  if (typeof requestId !== "string" || !isJsonObject(inputWorkspace)) {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_refine_request"
    });
    return;
  }

  const refinedWorkspace = applyMockRefine(inputWorkspace as unknown as SharedSemanticWorkspace);

  writeJson(response, 200, {
    requestId,
    workspace: refinedWorkspace,
    engineName: workerName,
    latencyMs: Date.now() - startedAt
  });
}

async function handleInfill(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const startedAt = Date.now();
  const body = await readJson(request);

  if (!isJsonObject(body)) {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_json"
    });
    return;
  }

  const requestId = body.requestId;
  const region = body.region;
  const prompt = body.prompt;

  if (typeof requestId !== "string" || typeof region !== "string" || typeof prompt !== "string") {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_infill_request"
    });
    return;
  }

  writeJson(response, 200, {
    requestId,
    region,
    content: `mock infill for ${region}: ${prompt.slice(0, 80)}`,
    engineName: workerName,
    latencyMs: Date.now() - startedAt
  });
}

async function handleResolveConflict(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const startedAt = Date.now();
  const body = await readJson(request);

  if (!isJsonObject(body)) {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_json"
    });
    return;
  }

  const requestId = body.requestId;
  const conflictId = body.conflictId;
  const inputWorkspace = body.workspace;

  if (
    typeof requestId !== "string" ||
    typeof conflictId !== "string" ||
    !isJsonObject(inputWorkspace)
  ) {
    writeJson(response, 400, {
      ok: false,
      error: "invalid_conflict_request"
    });
    return;
  }

  writeJson(response, 200, {
    requestId,
    conflictId,
    resolution: "mock resolution: keep evidence-backed claim and require second-pass verifier",
    engineName: workerName,
    latencyMs: Date.now() - startedAt
  });
}

function applyMockRefine(input: SharedSemanticWorkspace): SharedSemanticWorkspace {
  const createdAt = new Date().toISOString();

  const withVerifierResult = addVerifierResult(input, {
    id: `${input.id}-verifier-mock-http-worker`,
    status: "pass",
    decision: "approve",
    checkName: "mock_http_worker_refine",
    summary: "Mock HTTP worker refined the workspace through the worker contract.",
    findings: [],
    checkedFiles: input.scope.changedFiles,
    evidenceIds: [],
    failedRegions: [],
    createdBy: "verifier",
    createdAt
  });

  return setFinalResult(withVerifierResult, {
    summary: "mock_http_worker_final_result",
    createdBy: "coder",
    createdAt
  });
}

function resolveServerUrl(server: Server): string {
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not resolve mock worker server address.");
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });

  response.end(`${JSON.stringify(body)}\n`);
}

function readMaybeFinalResult(value: Record<string, unknown>): unknown {
  if ("finalResult" in value) {
    return value.finalResult;
  }

  if ("final_result" in value) {
    return value.final_result;
  }

  if ("final" in value) {
    return value.final;
  }

  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseChangedFilesFromEnv(value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }

  const files = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.replace(/\\/g, "/"))
    .map((item) => item.replace(/^\.\//, ""));

  if (files.length === 0) {
    return null;
  }

  return [...new Set(files)].sort();
}