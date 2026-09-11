#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function evaluation({
  taskSucceeded,
  controlPassed,
  behaviorSatisfied,
  inputTokens,
  outputTokens,
  exposedBytes,
  durationMs,
  scopeViolationCount
}) {
  return {
    schemaVersion: "product-comparison-evaluation/v1",
    correctness: {
      controlPassed,
      behaviorSatisfied,
      taskSucceeded,
      testsPassed: behaviorSatisfied,
      buildPassed: taskSucceeded,
      typecheckPassed: taskSucceeded
    },
    control: {
      scopeViolationCount,
      forbiddenTouchCount: 0,
      unsupportedMutationCount: 0,
      unnecessaryChangedFileCount: null
    },
    efficiency: {
      inputTokens,
      cachedInputTokens: null,
      outputTokens,
      reasoningTokens: null,
      totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      exposedFiles: 1,
      exposedBytes,
      commandCount: 1,
      failedCommandCount: 0,
      repairRounds: 0,
      durationMs
    }
  };
}

async function main() {
  const runtime = await import(pathToFileURL(
    resolve(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
  ).href);
  const statsModule = await import(pathToFileURL(
    resolve(repoRoot, "dist/apps/cli/src/commands/stats.js")
  ).href);
  const store = await import(pathToFileURL(
    resolve(repoRoot, "dist/apps/cli/src/run-artifact-store.js")
  ).href);

  assert.equal(runtime.PRODUCT_STATS_VERSION, "product-stats/v1");
  assert.equal(typeof runtime.aggregateProductStats, "function");
  assert.equal(statsModule.BOUNDED_STATS_VERSION, "bounded-stats/v1");
  assert.equal(typeof statsModule.statsCommand, "function");
  assert.equal(typeof statsModule.formatProductStatsTable, "function");

  const direct = runtime.aggregateProductStats([
    {
      comparable: true,
      normal: {
        taskSucceeded: true,
        controlPassed: true,
        behaviorSatisfied: true,
        inputTokens: 100,
        outputTokens: 20,
        exposedBytes: 1000,
        durationMs: 1000,
        scopeViolationCount: 0,
        humanAccepted: true
      },
      bounded: {
        taskSucceeded: true,
        controlPassed: true,
        behaviorSatisfied: true,
        inputTokens: 50,
        outputTokens: 10,
        exposedBytes: 500,
        durationMs: 700,
        scopeViolationCount: 0,
        humanAccepted: true
      }
    },
    {
      comparable: true,
      normal: {
        taskSucceeded: false,
        controlPassed: false,
        behaviorSatisfied: false,
        inputTokens: 300,
        outputTokens: 40,
        exposedBytes: 3000,
        durationMs: 3000,
        scopeViolationCount: 2,
        humanAccepted: false
      },
      bounded: {
        taskSucceeded: true,
        controlPassed: true,
        behaviorSatisfied: true,
        inputTokens: 150,
        outputTokens: 20,
        exposedBytes: 1000,
        durationMs: 1500,
        scopeViolationCount: 0,
        humanAccepted: true
      }
    },
    {
      comparable: false,
      normal: {
        taskSucceeded: false,
        controlPassed: false,
        behaviorSatisfied: false,
        inputTokens: 999999,
        outputTokens: 999999,
        exposedBytes: 999999,
        durationMs: 999999,
        scopeViolationCount: 99,
        humanAccepted: false
      },
      bounded: {
        taskSucceeded: false,
        controlPassed: false,
        behaviorSatisfied: false,
        inputTokens: 999999,
        outputTokens: 999999,
        exposedBytes: 999999,
        durationMs: 999999,
        scopeViolationCount: 99,
        humanAccepted: false
      }
    }
  ]);

  assert.equal(direct.sampleCount, 3);
  assert.equal(direct.comparableRuns, 2);
  assert.equal(direct.normal.taskSuccessRate, 0.5);
  assert.equal(direct.bounded.taskSuccessRate, 1);
  assert.equal(direct.delta.taskSuccessRate, 0.5);
  assert.equal(direct.normal.medianInputTokens, 200);
  assert.equal(direct.bounded.medianInputTokens, 100);
  assert.equal(direct.delta.medianInputTokens, -100);
  assert.equal(direct.normal.medianOutputTokens, 30);
  assert.equal(direct.bounded.medianOutputTokens, 15);
  assert.equal(direct.normal.medianExposedBytes, 2000);
  assert.equal(direct.bounded.medianExposedBytes, 750);
  assert.equal(direct.normal.medianDuration, 2000);
  assert.equal(direct.bounded.medianDuration, 1100);
  assert.equal(direct.normal.scopeViolationRate, 0.5);
  assert.equal(direct.bounded.scopeViolationRate, 0);
  assert.equal(direct.normal.humanAcceptanceRate, 0.5);
  assert.equal(direct.bounded.humanAcceptanceRate, 1);

  const unknownHuman = runtime.aggregateProductStats([
    {
      comparable: true,
      normal: { ...direct.normal, taskSucceeded: true, controlPassed: true, behaviorSatisfied: true, inputTokens: 1, outputTokens: 1, exposedBytes: 1, durationMs: 1, scopeViolationCount: 0, humanAccepted: null },
      bounded: { ...direct.bounded, taskSucceeded: true, controlPassed: true, behaviorSatisfied: true, inputTokens: 1, outputTokens: 1, exposedBytes: 1, durationMs: 1, scopeViolationCount: 0, humanAccepted: null }
    }
  ]);
  assert.equal(unknownHuman.normal.humanAcceptanceRate, null);
  assert.equal(unknownHuman.bounded.humanAcceptanceRate, null);
  assert.match(statsModule.formatProductStatsTable(unknownHuman), /Human acceptance rate\s+N\/A\s+N\/A\s+N\/A/);

  const fixtureRoot = mkdtempSync(join(tmpdir(), "bounded-stats-source-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: fixtureRoot });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: fixtureRoot });
    mkdirSync(join(fixtureRoot, ".bounded"), { mode: 0o700 });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "fixture"], { cwd: fixtureRoot });
    assert.match(git(fixtureRoot, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/);

    const comparisons = [
      {
        runId: "compare-a",
        comparable: true,
        normalHuman: true,
        boundedHuman: true,
        normal: evaluation({ taskSucceeded: true, controlPassed: true, behaviorSatisfied: true, inputTokens: 100, outputTokens: 20, exposedBytes: 1000, durationMs: 1000, scopeViolationCount: 0 }),
        bounded: evaluation({ taskSucceeded: true, controlPassed: true, behaviorSatisfied: true, inputTokens: 50, outputTokens: 10, exposedBytes: 500, durationMs: 700, scopeViolationCount: 0 })
      },
      {
        runId: "compare-b",
        comparable: true,
        normalHuman: false,
        boundedHuman: true,
        normal: evaluation({ taskSucceeded: false, controlPassed: false, behaviorSatisfied: false, inputTokens: 300, outputTokens: 40, exposedBytes: 3000, durationMs: 3000, scopeViolationCount: 2 }),
        bounded: evaluation({ taskSucceeded: true, controlPassed: true, behaviorSatisfied: true, inputTokens: 150, outputTokens: 20, exposedBytes: 1000, durationMs: 1500, scopeViolationCount: 0 })
      },
      {
        runId: "compare-c-noncomparable",
        comparable: false,
        normalHuman: false,
        boundedHuman: false,
        normal: evaluation({ taskSucceeded: false, controlPassed: false, behaviorSatisfied: false, inputTokens: 999999, outputTokens: 999999, exposedBytes: 999999, durationMs: 999999, scopeViolationCount: 99 }),
        bounded: evaluation({ taskSucceeded: false, controlPassed: false, behaviorSatisfied: false, inputTokens: 999999, outputTokens: 999999, exposedBytes: 999999, durationMs: 999999, scopeViolationCount: 99 })
      }
    ];

    for (const sample of comparisons) {
      const comparison = {
        command: "compare",
        target: "codex",
        comparable: sample.comparable,
        normal: { humanAccepted: sample.normalHuman },
        bounded: { humanAccepted: sample.boundedHuman },
        evaluations: { normal: sample.normal, bounded: sample.bounded }
      };
      await store.storeProductRunArtifact({
        repositoryRoot: fixtureRoot,
        runId: sample.runId,
        runKind: "compare",
        run: { command: "compare", task: sample.runId },
        candidateDiff: "",
        receipt: {},
        telemetry: {},
        validation: comparison.evaluations,
        comparison
      });
    }

    await store.storeProductRunArtifact({
      repositoryRoot: fixtureRoot,
      runId: "regular-run",
      runKind: "run",
      run: { command: "codex" },
      candidateDiff: "",
      receipt: {},
      telemetry: {},
      validation: {}
    });

    const result = await statsModule.statsCommand({ last: 20 }, fixtureRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.command, "stats");
    assert.equal(result.output.comparisonRuns, 3);
    assert.equal(result.output.comparableRuns, 2);
    assert.equal(result.output.normal.taskSuccessRate, 0.5);
    assert.equal(result.output.bounded.taskSuccessRate, 1);
    assert.equal(result.output.delta.taskSuccessRate, 0.5);
    assert.equal(result.output.normal.medianInputTokens, 200);
    assert.equal(result.output.bounded.medianInputTokens, 100);
    assert.equal(result.output.normal.humanAcceptanceRate, 0.5);
    assert.equal(result.output.bounded.humanAcceptanceRate, 1);
    assert.match(result.output.table, /NORMAL\s+BOUNDED\s+Δ/);
    assert.match(result.output.table, /Task success rate\s+50\.0%\s+100\.0%\s+\+50\.0 pp/);
    assert.match(result.output.table, /Median input tokens\s+200\s+100\s+-100/);
    assert.match(result.output.table, /Human acceptance rate\s+50\.0%\s+100\.0%\s+\+50\.0 pp/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const cli = resolve(repoRoot, "dist/apps/cli/src/index.js");
  const invalidLast = spawnSync(process.execPath, [cli, "stats", "--last", "0", "--json"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(invalidLast.status, 2);
  assert.equal(JSON.parse(invalidLast.stdout).code, "cli_stats_last_invalid");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    productStatsVersion: runtime.PRODUCT_STATS_VERSION,
    cliStatsVersion: statsModule.BOUNDED_STATS_VERSION,
    comparableOnlyAggregation: true,
    missingEvidenceNotImputed: true,
    normalBoundedDelta: true,
    compareArtifactReadPath: true,
    liveProviderCalls: false
  })}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
