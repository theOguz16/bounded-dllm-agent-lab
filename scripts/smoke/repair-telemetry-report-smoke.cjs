#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

async function main() {
  const reportModule = await import(pathToFileURL(
    resolve(repoRoot, "dist/apps/cli/src/commands/report.js")
  ).href);

  assert.equal(typeof reportModule.buildProductRunReport, "function");

  const artifactHash = `sha256:${"a".repeat(64)}`;
  const bundle = {
    artifact: {
      run: {
        status: "validated",
        repairRounds: 1
      },
      files: {
        receipt: { sha256: artifactHash }
      }
    },
    candidateDiff: "diff --git a/src/main.ts b/src/main.ts\n",
    receipt: {},
    telemetry: {
      repairAttemptCount: 1,
      repairInputTokens: 233,
      repairOutputTokens: 61,
      repairDurationMs: 417,
      repairChangedFiles: ["src/z.ts", "src/a.ts", "src/a.ts"],
      repairOutcome: "repair_candidate_ready"
    },
    validation: { status: "passed" }
  };

  const report = reportModule.buildProductRunReport(bundle);
  assert.equal(report.repairAttemptCount, 1);
  assert.equal(report.repairInputTokens, 233);
  assert.equal(report.repairOutputTokens, 61);
  assert.equal(report.repairDurationMs, 417);
  assert.deepEqual(report.repairChangedFiles, ["src/a.ts", "src/z.ts"]);
  assert.equal(report.repairOutcome, "repair_candidate_ready");

  const nested = reportModule.buildProductRunReport({
    ...bundle,
    artifact: {
      ...bundle.artifact,
      run: { status: "stopped" }
    },
    telemetry: {
      repair: {
        attemptCount: 1,
        inputTokens: 17,
        outputTokens: 5,
        durationMs: 23,
        changedFiles: [],
        outcome: "repair_stopped"
      }
    }
  });
  assert.equal(nested.repairAttemptCount, 1);
  assert.equal(nested.repairInputTokens, 17);
  assert.equal(nested.repairOutputTokens, 5);
  assert.equal(nested.repairDurationMs, 23);
  assert.deepEqual(nested.repairChangedFiles, []);
  assert.equal(nested.repairOutcome, "repair_stopped");

  const legacy = reportModule.buildProductRunReport({
    ...bundle,
    artifact: {
      ...bundle.artifact,
      run: { status: "legacy", repairRounds: 1 }
    },
    telemetry: {},
    receipt: {}
  });
  assert.equal(legacy.repairAttemptCount, null);
  assert.equal(legacy.repairInputTokens, null);
  assert.equal(legacy.repairOutputTokens, null);
  assert.equal(legacy.repairDurationMs, null);
  assert.equal(legacy.repairChangedFiles, null);
  assert.equal(legacy.repairOutcome, null);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    repairTelemetryReport: true,
    flatTelemetrySupported: true,
    nestedTelemetrySupported: true,
    legacyUnknownPreserved: true,
    repairChangedFilesDeterministic: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
