import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import {
  evaluateConflictAwareMerge
} from "../../../packages/merge-core/src/index.js";
import {
  runMockOrchestrationFlow
} from "../../../packages/orchestration-core/src/index.js";
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

const mockWorkerName = "local-worker-backed-orchestrator-mock";
const mockWorkerVersion = "0.1.0";

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const externalWorkerUrl = process.env.WORKER_URL;
const timeoutMs = parseNumberEnv(process.env.WORKER_TIMEOUT_MS) ?? 120_000;

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before worker-backed orchestrator smoke.",
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
        reason: "No fixture found for worker-backed orchestrator smoke."
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
  id: `worker-backed-orchestrator-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);

let mockServer: Server | undefined;
const workerUrl = externalWorkerUrl
  ? normalizeBaseUrl(externalWorkerUrl)
  : await startLocalMockWorkerAndGetUrl();

try {
  const client = createHttpWorkspaceWorkerClient({
    baseUrl: workerUrl,
    timeoutMs
  });

  const health = await client.health();

  const initialOrchestration = runMockOrchestrationFlow(workspace);
  const initialMerge = evaluateConflictAwareMerge(initialOrchestration);

  const refineResponse = await client.refine({
    requestId: `worker-backed-orchestrator-refine-${fixture.case.id}-${Date.now()}`,
    workspace
  });

  const failures = validateSmoke({
    health,
    initialOrchestration,
    initialMerge,
    refineResponse
  });

  const summary = summarizeSmoke({
    health,
    initialOrchestration,
    initialMerge,
    refineResponse
  });

  if (failures.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Worker-backed orchestrator smoke failed.",
          failures,
          caseId: fixture.case.id,
          workspaceId: workspace.id,
          workerUrl,
          summary
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
        smokeName: "worker-backed-orchestrator-smoke",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
        workerUrl,
        workerMode: externalWorkerUrl ? "external" : "local_mock",
        summary
      },
      null,
      2
    )
  );
} finally {
  if (mockServer) {
    await closeServer(mockServer);
  }
}

function validateSmoke(input: {
  health: Record<string, unknown>;
  initialOrchestration: ReturnType<typeof runMockOrchestrationFlow>;
  initialMerge: ReturnType<typeof evaluateConflictAwareMerge>;
  refineResponse: {
    requestId: string;
    workspace: SharedSemanticWorkspace;
    engineName: string;
    latencyMs: number;
  };
}): string[] {
  const failures: string[] = [];

  if (input.health.ok !== true) {
    failures.push("Expected worker health ok=true.");
  }

  if (typeof input.health.workerName !== "string" || input.health.workerName.length === 0) {
    failures.push("Expected worker health workerName to be a non-empty string.");
  }

  if (input.initialOrchestration.decision !== "remask_required") {
    failures.push(
      `Expected initial deterministic orchestration decision remask_required, got ${input.initialOrchestration.decision}.`
    );
  }

  if (input.initialOrchestration.remaskTriggered !== true) {
    failures.push("Expected initial deterministic orchestration to trigger remask.");
  }

  if (input.initialMerge.decision !== "remask_required") {
    failures.push(
      `Expected initial merge decision remask_required, got ${input.initialMerge.decision}.`
    );
  }

  if (input.initialMerge.mergeSafe !== false) {
    failures.push("Expected initial merge to be unsafe before worker-backed refinement.");
  }

  if (input.initialMerge.conflicts.length === 0) {
    failures.push("Expected initial merge to include conflicts before worker-backed refinement.");
  }

  if (input.refineResponse.workspace.id !== workspace.id) {
    failures.push(
      `Expected refined workspace id ${workspace.id}, got ${input.refineResponse.workspace.id}.`
    );
  }

  if (typeof input.refineResponse.engineName !== "string" || input.refineResponse.engineName.length === 0) {
    failures.push("Expected refine response engineName to be a non-empty string.");
  }

  if (typeof input.refineResponse.latencyMs !== "number" || input.refineResponse.latencyMs < 0) {
    failures.push("Expected refine response latencyMs to be a non-negative number.");
  }

  if (JSON.stringify(input.refineResponse.workspace) === JSON.stringify(workspace)) {
    failures.push("Expected worker refine response to mutate the workspace.");
  }

  const finalResult = readMaybeFinalResult(input.refineResponse.workspace);

  if (finalResult === undefined || finalResult === null || finalResult === "") {
    failures.push("Expected refined workspace to contain a final result.");
  }

  return failures;
}

function summarizeSmoke(input: {
  health: Record<string, unknown>;
  initialOrchestration: ReturnType<typeof runMockOrchestrationFlow>;
  initialMerge: ReturnType<typeof evaluateConflictAwareMerge>;
  refineResponse: {
    requestId: string;
    workspace: SharedSemanticWorkspace;
    engineName: string;
    latencyMs: number;
  };
}): Record<string, unknown> {
  return {
    worker: {
      url: workerUrl,
      mode: externalWorkerUrl ? "external" : "local_mock",
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
    initialOrchestration: {
      flowId: input.initialOrchestration.flowId,
      decision: input.initialOrchestration.decision,
      remaskTriggered: input.initialOrchestration.remaskTriggered,
      stepCount: input.initialOrchestration.steps.length,
      tokenSummary: input.initialOrchestration.tokenSummary,
      mutationSummary: input.initialOrchestration.mutationSummary
    },
    initialMerge: {
      decision: input.initialMerge.decision,
      mergeSafe: input.initialMerge.mergeSafe,
      conflictCount: input.initialMerge.conflicts.length,
      conflictKinds: input.initialMerge.conflicts.map((conflict) => conflict.kind),
      requiredActions: input.initialMerge.requiredActions
    },
    workerRefine: {
      requestId: input.refineResponse.requestId,
      engineName: input.refineResponse.engineName,
      latencyMs: input.refineResponse.latencyMs,
      inputWorkspaceId: workspace.id,
      outputWorkspaceId: input.refineResponse.workspace.id,
      workspaceMutated: JSON.stringify(input.refineResponse.workspace) !== JSON.stringify(workspace),
      finalResult: readMaybeFinalResult(input.refineResponse.workspace),
      verifierResultCount: Array.isArray(input.refineResponse.workspace.verifierResults)
        ? input.refineResponse.workspace.verifierResults.length
        : undefined
    }
  };
}

async function startLocalMockWorkerAndGetUrl(): Promise<string> {
  mockServer = await startMockWorkerServer();

  const address = mockServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not resolve local mock worker address.");
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function startMockWorkerServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, {
          ok: true,
          workerName: mockWorkerName,
          mode: "mock",
          version: mockWorkerVersion
        });
        return;
      }

      if (request.method === "POST" && request.url === "/refine") {
        await handleRefine(request, response);
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

  const refinedWorkspace = applyMockWorkerRefine(
    inputWorkspace as unknown as SharedSemanticWorkspace
  );

  writeJson(response, 200, {
    requestId,
    workspace: refinedWorkspace,
    engineName: mockWorkerName,
    latencyMs: Date.now() - startedAt
  });
}

function applyMockWorkerRefine(input: SharedSemanticWorkspace): SharedSemanticWorkspace {
  const createdAt = new Date().toISOString();

  const withVerifierResult = addVerifierResult(input, {
    id: `${input.id}-worker-backed-verifier-result`,
    status: "pass",
    decision: "approve",
    checkName: "worker_backed_mock_refine",
    summary: "Worker-backed mock refinement produced an approved canonical workspace result.",
    findings: [],
    checkedFiles: input.scope.changedFiles,
    evidenceIds: [],
    failedRegions: [],
    createdBy: "verifier",
    createdAt
  });

  return setFinalResult(withVerifierResult, {
    summary: "worker_backed_mock_final_result",
    createdBy: "coder",
    createdAt
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

function readMaybeFinalResult(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return undefined;
  }

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

function parseNumberEnv(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}