import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  createMockModelAdapter,
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

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const roles: ModelAdapterRole[] = [
  "planner",
  "coder",
  "verifier",
  "remask"
];

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before model adapter smoke.",
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
        reason: "No fixture found for model adapter smoke."
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
  id: `model-adapter-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
const adapter = createMockModelAdapter();

const responses: ModelAdapterResponse[] = [];

for (const role of roles) {
  const boundedContext = {
    workspaceId: workspace.id,
    role,
    changedFiles,
    repoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    expectedResult: fixture.case.expectedResult
  };

  const request = createModelAdapterRequest({
    requestId: `model-adapter-smoke-${role}`,
    workspaceId: workspace.id,
    role,
    task: fixture.packet.task,
    messages: createRoleMessages({
      role,
      task: fixture.packet.task,
      boundedContext
    }),
    responseFormat: "json",
    temperature: 0,
    maxOutputTokens: 800,
    metadata: {
      caseId: fixture.case.id,
      changedFiles: changedFiles.join(",")
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
        reason: "Model adapter smoke failed.",
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
      smokeName: "model-adapter-smoke",
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
    }

    if (!response.content) {
      failures.push(`Expected role ${role} to return non-empty content.`);
    }

    if (!isJsonObject(response.parsedJson)) {
      failures.push(`Expected role ${role} to return parsed JSON object.`);
    }

    if (response.usage.totalTokens !== undefined && response.usage.totalTokens <= 0) {
      failures.push(`Expected role ${role} totalTokens to be positive.`);
    }
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    adapterId: adapter.adapterId,
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
      error: response.error
    }))
  };
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