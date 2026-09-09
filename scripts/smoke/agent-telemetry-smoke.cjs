const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");
const tscPath = join(repoRoot, "node_modules/typescript/bin/tsc");
const tempDirectory = mkdtempSync(join(repoRoot, ".tmp-agent-telemetry-"));
const consumerPath = join(tempDirectory, "consumer.mts");

async function main() {
  try {
    writeFileSync(
      consumerPath,
      `import {
  AGENT_RUN_TELEMETRY_VERSION,
  AgentTelemetryValidationError,
  createAgentRunTelemetry,
  type AgentRunTelemetry
} from "@bounded/integrations";

const telemetry: AgentRunTelemetry = createAgentRunTelemetry({
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

void [AGENT_RUN_TELEMETRY_VERSION, AgentTelemetryValidationError, telemetry];
`,
      "utf8"
    );

    const compile = spawnSync(
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
      compile.status,
      0,
      ["agent telemetry TypeScript consumer failed", compile.stdout, compile.stderr]
        .filter(Boolean)
        .join("\n")
    );

    const runtime = await import(
      "../../dist/packages/integrations/src/agent-telemetry.js"
    );
    const {
      AGENT_RUN_TELEMETRY_VERSION,
      AgentTelemetryValidationError,
      createAgentRunTelemetry
    } = runtime;

    const observed = createAgentRunTelemetry({
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

    assert.equal(observed.schemaVersion, AGENT_RUN_TELEMETRY_VERSION);
    assert.equal(observed.totalTokens, 125);
    assert.equal(observed.cachedInputTokens, 40);

    const partial = createAgentRunTelemetry({
      usageStatus: "observed",
      inputTokens: 12,
      outputTokens: 3,
      commandCount: 0,
      failedCommandCount: 0,
      fileChangeEventCount: 0,
      durationMs: 0
    });

    assert.equal(partial.cachedInputTokens, null);
    assert.equal(partial.cacheWriteInputTokens, null);
    assert.equal(partial.reasoningOutputTokens, null);
    assert.equal(partial.commandCount, 0);
    assert.equal(partial.durationMs, 0);

    const unavailable = createAgentRunTelemetry({ usageStatus: "unavailable" });
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens"
    ]) {
      assert.equal(unavailable[field], null, `${field} must stay null when unavailable`);
    }

    const assertTelemetryError = (callback) => {
      assert.throws(callback, (error) => error instanceof AgentTelemetryValidationError);
    };

    assertTelemetryError(() => createAgentRunTelemetry({
      usageStatus: "observed",
      inputTokens: 10,
      cachedInputTokens: 11,
      outputTokens: 5
    }));

    assertTelemetryError(() => createAgentRunTelemetry({
      usageStatus: "observed",
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 5,
      totalTokens: 20
    }));

    assertTelemetryError(() => createAgentRunTelemetry({
      usageStatus: "unavailable",
      inputTokens: 0
    }));

    console.log(JSON.stringify({
      ok: true,
      schemaVersion: AGENT_RUN_TELEMETRY_VERSION,
      cachedTokensDoubleCounted: false,
      missingValuesStayNull: true,
      zeroValuesPreserved: true,
      usageStatuses: ["observed", "estimated", "unavailable"]
    }, null, 2));
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
