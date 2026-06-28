import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  analyzeRepository
} from "../../../packages/repo-intelligence/src/index.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import {
  createHttpWorkspaceWorkerClient
} from "../../../packages/worker-contract/src/index.js";

const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8765";
const workerApiKey = process.env.WORKER_API_KEY;
const timeoutMs = parseNumberEnv(process.env.WORKER_TIMEOUT_MS) ?? 120_000;

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
        reason: "Fixture validation failed before worker HTTP refine smoke.",
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
        reason: "No fixture found for worker HTTP refine smoke."
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
  id: `worker-http-refine-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);

const client = createHttpWorkspaceWorkerClient({
  baseUrl: workerUrl,
  apiKey: workerApiKey,
  timeoutMs
});

const health = await client.health();
const requestId = `worker-http-refine-smoke-${fixture.case.id}-${Date.now()}`;

const refineResponse = await client.refine({
  requestId,
  workspace
});

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Worker HTTP refine smoke failed.",
        failures,
        summary: summarizeResult()
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
      smokeName: "worker-http-refine-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      workerUrl,
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResult(): string[] {
  const failures: string[] = [];

  if (!health.ok) {
    failures.push("Expected health.ok=true before refine.");
  }

  if (refineResponse.requestId !== requestId) {
    failures.push(
      `Expected response requestId ${requestId}, got ${refineResponse.requestId}.`
    );
  }

  if (!isJsonObject(refineResponse.workspace)) {
    failures.push("Expected refine response workspace to be an object.");
  }

  if (refineResponse.workspace.id !== workspace.id) {
    failures.push(
      `Expected response workspace id ${workspace.id}, got ${refineResponse.workspace.id}.`
    );
  }

  if (typeof refineResponse.engineName !== "string" || refineResponse.engineName.length === 0) {
    failures.push("Expected refine response engineName to be a non-empty string.");
  }

  if (typeof refineResponse.latencyMs !== "number" || refineResponse.latencyMs < 0) {
    failures.push("Expected refine response latencyMs to be a non-negative number.");
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    worker: {
      url: workerUrl,
      health,
      apiKeyConfigured: Boolean(workerApiKey),
      timeoutMs
    },
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    request: {
      requestId,
      inputWorkspaceId: workspace.id
    },
    response: {
      requestId: refineResponse.requestId,
      engineName: refineResponse.engineName,
      latencyMs: refineResponse.latencyMs,
      outputWorkspaceId: refineResponse.workspace.id,
      workspaceMutated: JSON.stringify(refineResponse.workspace) !== JSON.stringify(workspace),
      finalResult: readMaybeFinalResult(refineResponse.workspace),
      verifierResultCount: Array.isArray(refineResponse.workspace.verifierResults)
        ? refineResponse.workspace.verifierResults.length
        : undefined
    }
  };
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