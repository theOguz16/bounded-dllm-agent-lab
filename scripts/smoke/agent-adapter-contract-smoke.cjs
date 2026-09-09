const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");
const contractPath = join(repoRoot, "packages/integrations/src/agent-adapter.ts");
const contractSource = readFileSync(contractPath, "utf8");
const tempDirectory = mkdtempSync(join(repoRoot, ".tmp-agent-adapter-contract-"));
const consumerPath = join(tempDirectory, "consumer.mts");
const tscPath = join(repoRoot, "node_modules/typescript/bin/tsc");

const requiredExports = [
  "AgentAdapter",
  "AgentRunRequest",
  "AgentRunResult",
  "AgentRunStatus",
  "AgentUsage",
  "AgentCommandEvent",
  "AgentFileChangeEvent"
];

for (const name of requiredExports) {
  assert.match(
    contractSource,
    new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`),
    `missing required agent adapter contract export: ${name}`
  );
}

for (const forbiddenVendorTerm of ["Codex", "Claude", "OpenAI", "Anthropic"]) {
  assert.equal(
    contractSource.includes(forbiddenVendorTerm),
    false,
    `agent adapter contract must remain vendor-neutral: ${forbiddenVendorTerm}`
  );
}

try {
  writeFileSync(
    consumerPath,
    `import type {
  AgentAdapter,
  AgentRunRequest,
  AgentRunResult
} from "@bounded/integrations";

class FakeCodexAdapter implements AgentAdapter {
  readonly agentId = "fake-codex";
  readonly agentVersion = "1.0.0";

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return fakeResult(this, request);
  }
}

class FakeClaudeAdapter implements AgentAdapter {
  readonly agentId = "fake-claude";
  readonly agentVersion = "2.0.0";

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return fakeResult(this, request);
  }
}

function fakeResult(adapter: AgentAdapter, request: AgentRunRequest): AgentRunResult {
  return {
    status: "completed",
    agentId: adapter.agentId,
    agentVersion: adapter.agentVersion,
    modelId: request.model,
    durationMs: 1,
    finalMessage: "done",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      toolCalls: 0
    },
    commands: [],
    fileChanges: [],
    diagnostics: []
  };
}

const request: AgentRunRequest = {
  runId: "run-1",
  agentId: "fake-codex",
  workingDirectory: "/tmp/repo",
  task: "fix bug",
  model: "test-model",
  reasoningEffort: "medium",
  mode: "coder",
  timeoutMs: 1000,
  networkAllowed: false,
  sandboxMode: "workspace_write",
  outputSchema: { type: "object" }
};

const adapters: AgentAdapter[] = [new FakeCodexAdapter(), new FakeClaudeAdapter()];
const results = await Promise.all(adapters.map((adapter) => adapter.run({ ...request, agentId: adapter.agentId })));

if (results.some((result) => result.status !== "completed")) {
  throw new Error("fake adapters did not satisfy AgentAdapter runtime contract");
}
`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      "--noEmit",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      consumerPath
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(
    result.status,
    0,
    [
      "fake Codex and fake Claude adapters must implement the same AgentAdapter contract",
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n")
  );
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  contract: "AgentAdapter",
  fakeAdapters: ["fake-codex", "fake-claude"],
  vendorNeutral: true
}, null, 2));
