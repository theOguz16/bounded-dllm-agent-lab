import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  createOpenAICompatibleModelAdapter,
  createModelAdapterRequest,
  createRoleMessages,
  isJsonObject,
  type ModelAdapterRole,
  type ModelAdapterResponse,
} from "../../../packages/model-adapter-core/src/index.js";
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

const workerUrl = process.env.MODEL_WORKER_URL;
const workerApiKey = process.env.MODEL_WORKER_API_KEY;
const workerModel = process.env.MODEL_WORKER_MODEL;
const workerTimeoutMs = parseNumberEnv(process.env.MODEL_WORKER_TIMEOUT_MS) ?? 60_000;

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const roles = parseRolesFromEnv(process.env.MODEL_WORKER_ROLES) ?? [
  "planner",
  "coder",
  "verifier",
  "remask"
];

if (!workerUrl || !workerModel) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Missing required model worker environment variables.",
        required: [
          "MODEL_WORKER_URL",
          "MODEL_WORKER_MODEL"
        ],
        optional: [
          "MODEL_WORKER_API_KEY",
          "MODEL_WORKER_TIMEOUT_MS",
          "MODEL_WORKER_ROLES",
          "REPO_CHANGED_FILES"
        ],
        example: "MODEL_WORKER_URL=https://your-worker/v1 MODEL_WORKER_MODEL=your-model npm run model:worker-smoke"
      },
      null,
      2
    )
  );
}

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before model worker smoke.",
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
        reason: "No fixture found for model worker smoke."
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
  id: `model-worker-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);

const adapter = createOpenAICompatibleModelAdapter({
  adapterId: "runpod-openai-compatible-worker-adapter-v1",
  baseUrl: workerUrl,
  apiKey: workerApiKey,
  model: workerModel,
  timeoutMs: workerTimeoutMs
});

const responses: ModelAdapterResponse[] = [];

for (const role of roles) {
  const boundedContext = {
    workspaceId: workspace.id,
    role,
    changedFiles,
    repoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    expectedResult: fixture.case.expectedResult,
    outputRule: "Return a single valid JSON object. Do not wrap it in markdown."
  };

  const request = createModelAdapterRequest({
    requestId: `model-worker-smoke-${role}`,
    workspaceId: workspace.id,
    role,
    task: fixture.packet.task,
    messages: createRoleMessages({
      role,
      task: fixture.packet.task,
      boundedContext,
      instruction: "a single valid JSON object only"
    }),
    responseFormat: "json",
    temperature: 0,
    maxOutputTokens: 900,
    metadata: {
      caseId: fixture.case.id,
      changedFiles: changedFiles.join(","),
      workerModel
    }
  });

  const response = await adapter.invoke(request);
  responses.push(response);
}

const failures = validateResponses();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Model worker smoke failed.",
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
      smokeName: "model-worker-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResponses(): string[] {
  const failures: string[] = [];

  if (responses.length !== roles.length) {
    failures.push(`Expected ${roles.length} responses, got ${responses.length}.`);
  }

  for (const role of roles) {
    const response = responses.find((item) => item.role === role);

    if (!response) {
      failures.push(`Missing response for role ${role}.`);
      continue;
    }

    if (!response.ok) {
      failures.push(`Expected role ${role} response ok=true, got error ${response.error}.`);
      continue;
    }

    if (!response.content) {
      failures.push(`Expected role ${role} to return non-empty content.`);
    }

    if (!isJsonObject(response.parsedJson)) {
      failures.push(
        `Expected role ${role} to return parseable JSON object. Content snippet: ${response.content.slice(0, 500)}`
      );
    }
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    adapterId: adapter.adapterId,
    worker: {
      urlConfigured: Boolean(workerUrl),
      apiKeyConfigured: Boolean(workerApiKey),
      model: workerModel,
      timeoutMs: workerTimeoutMs
    },
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    roles: responses.map((response) => ({
      role: response.role,
      ok: response.ok,
      latencyMs: response.latencyMs,
      contentLength: response.content.length,
      parsedKind: isJsonObject(response.parsedJson)
        ? response.parsedJson.kind
        : null,
      usage: response.usage,
      error: response.error,
      contentSnippet: response.content.slice(0, 300)
    }))
  };
}

function parseRolesFromEnv(value: string | undefined): ModelAdapterRole[] | null {
  if (!value) {
    return null;
  }

  const allowed = new Set<ModelAdapterRole>([
    "planner",
    "coder",
    "verifier",
    "tester",
    "remask",
    "merge"
  ]);

  const roles = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const invalid = roles.filter((role) => !allowed.has(role as ModelAdapterRole));

  if (invalid.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Invalid MODEL_WORKER_ROLES value.",
          invalid,
          allowed: [...allowed]
        },
        null,
        2
      )
    );
  }

  if (roles.length === 0) {
    return null;
  }

  return roles as ModelAdapterRole[];
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