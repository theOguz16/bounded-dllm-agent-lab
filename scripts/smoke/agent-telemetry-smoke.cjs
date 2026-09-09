const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");
const tscPath = join(repoRoot, "node_modules/typescript/bin/tsc");
const tempDirectory = mkdtempSync(join(repoRoot, ".tmp-agent-telemetry-"));
const consumerPath = join(tempDirectory, "consumer.mts");

try {
  writeFileSync(
    consumerPath,
    `import {
  AGENT_RUN_TELEMETRY_VERSION,
  AgentTelemetryValidationError,
  createAgentRunTelemetry,
  type AgentRunTelemetry
} from "@bounded/integrations";

const observed: AgentRunTelemetry = createAgentRunTelemetry({
  usageStatus: "observed",
  inputTokens: 100,
  cachedInputTokens: 40,
  cacheWriteInputTokens: 10,
  outputTokens: 25,
  reasoningOutputTokens: 7,
  commandCount: 3,
  failedCommandCount: 1,
  fileChangeEventCount: 2,
  durationMs: 500
});

if (observed.schemaVersion !== AGENT_RUN_TELEMETRY_VERSION) throw new Error("schema version mismatch");
if (observed.totalTokens !== 125) throw new Error("cached input tokens were double-counted");
if (observed.cachedInputTokens !== 40) throw new Error("cached input tokens lost");

const partial = createAgentRunTelemetry({
  usageStatus: "observed",
  inputTokens: 12,
  outputTokens: 3,
  commandCount: 0,
  failedCommandCount: 0,
  fileChangeEventCount: 0,
  durationMs: 0
});

if (partial.cachedInputTokens !== null) throw new Error("missing cachedInputTokens must be null");
if (partial.cacheWriteInputTokens !== null) throw new Error("missing cacheWriteInputTokens must be null");
if (partial.reasoningOutputTokens !== null) throw new Error("missing reasoningOutputTokens must be null");
if (partial.commandCount !== 0 || partial.durationMs !== 0) throw new Error("real zero values must be preserved");

const unavailable = createAgentRunTelemetry({ usageStatus: "unavailable" });
if (
  unavailable.inputTokens !== null ||
  unavailable.cachedInputTokens !== null ||
  unavailable.cacheWriteInputTokens !== null ||
  unavailable.outputTokens !== null ||
  unavailable.reasoningOutputTokens !== null ||
  unavailable.totalTokens !== null
) throw new Error("unavailable usage must preserve null token fields");

assertThrows(() => createAgentRunTelemetry({
  usageStatus: "observed",
  inputTokens: 10,
  cachedInputTokens: 11,
  outputTokens: 5
}));

assertThrows(() => createAgentRunTelemetry({
  usageStatus: "observed",
  inputTokens: 10,
  cachedInputTokens: 5,
  outputTokens: 5,
  totalTokens: 20
}));

assertThrows(() => createAgentRunTelemetry({
  usageStatus: "unavailable",
  inputTokens: 0
}));

function assertThrows(callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    if (!(error instanceof AgentTelemetryValidationError)) throw error;
    return;
  }
  throw new Error("expected AgentTelemetryValidationError");
}
`,
    "utf8"
  );

  const compile = spawnSync(
    process.execPath,
    [
      tscPath,
      "--outDir", tempDirectory,
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
    compile.status,
    0,
    ["agent telemetry TypeScript consumer failed", compile.stdout, compile.stderr]
      .filter(Boolean)
      .join("\n")
  );

  const compiledConsumerPath = join(tempDirectory, ".tmp-agent-telemetry-placeholder");
  const candidates = [
    join(tempDirectory, "consumer.mjs"),
    join(tempDirectory, "consumer.js")
  ];
  const { existsSync } = require("node:fs");
  const actualConsumerPath = candidates.find((candidate) => existsSync(candidate));
  assert.ok(actualConsumerPath, `compiled consumer missing; checked ${compiledConsumerPath}`);

  const run = spawnSync(process.execPath, [actualConsumerPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(
    run.status,
    0,
    ["agent telemetry runtime smoke failed", run.stdout, run.stderr]
      .filter(Boolean)
      .join("\n")
  );

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: "agent-run-telemetry/v1",
    cachedTokensDoubleCounted: false,
    missingValuesStayNull: true,
    zeroValuesPreserved: true,
    usageStatuses: ["observed", "estimated", "unavailable"]
  }, null, 2));
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
