#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const builtModule = resolve(
  repoRoot,
  "dist/packages/product-runtime/src/product-comparison-evaluator.js"
);

function baseInput() {
  return {
    correctness: {
      controlPassed: true,
      behaviorSatisfied: true,
      taskSucceeded: true,
      testsPassed: true,
      buildPassed: true,
      typecheckPassed: true
    },
    control: {
      scopeViolationCount: 0,
      forbiddenTouchCount: 0,
      unsupportedMutationCount: 0,
      changedFiles: ["src/b.ts", "src/a.ts"],
      changedFileNecessityAssessments: [
        {
          path: "src/a.ts",
          source: "acceptance",
          decision: "necessary",
          evidenceReference: "criterion:behavior-1"
        },
        {
          path: "src/b.ts",
          source: "human",
          decision: "unnecessary",
          evidenceReference: "review:human-1"
        }
      ]
    },
    efficiency: {
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 140,
      exposedFiles: 12,
      exposedBytes: 8192,
      commandCount: 5,
      failedCommandCount: 1,
      repairRounds: 1,
      durationMs: 4200
    }
  };
}

async function main() {
  const module = await import(pathToFileURL(builtModule).href);
  assert.equal(
    module.PRODUCT_COMPARISON_EVALUATION_VERSION,
    "product-comparison-evaluation/v1"
  );
  assert.equal(typeof module.evaluateProductComparison, "function");

  const full = module.evaluateProductComparison(baseInput());
  assert.equal(full.schemaVersion, "product-comparison-evaluation/v1");
  assert.deepEqual(full.correctness, baseInput().correctness);
  assert.deepEqual(full.control, {
    scopeViolationCount: 0,
    forbiddenTouchCount: 0,
    unsupportedMutationCount: 0,
    unnecessaryChangedFileCount: 1
  });
  assert.deepEqual(full.efficiency, baseInput().efficiency);
  assert.equal(Object.isFrozen(full), true);
  assert.equal(Object.isFrozen(full.correctness), true);
  assert.equal(Object.isFrozen(full.control), true);
  assert.equal(Object.isFrozen(full.efficiency), true);

  const partial = baseInput();
  partial.control.changedFileNecessityAssessments = [
    partial.control.changedFileNecessityAssessments[0]
  ];
  assert.equal(
    module.evaluateProductComparison(partial).control.unnecessaryChangedFileCount,
    null,
    "missing necessity labels must remain unknown instead of becoming zero"
  );

  const noChanges = baseInput();
  noChanges.control.changedFiles = [];
  noChanges.control.changedFileNecessityAssessments = [];
  assert.equal(
    module.evaluateProductComparison(noChanges).control.unnecessaryChangedFileCount,
    0
  );

  const unknownTelemetry = baseInput();
  unknownTelemetry.efficiency.inputTokens = null;
  unknownTelemetry.efficiency.cachedInputTokens = null;
  unknownTelemetry.efficiency.reasoningTokens = null;
  unknownTelemetry.efficiency.totalTokens = null;
  const unknownResult = module.evaluateProductComparison(unknownTelemetry);
  assert.equal(unknownResult.efficiency.inputTokens, null);
  assert.equal(unknownResult.efficiency.cachedInputTokens, null);
  assert.equal(unknownResult.efficiency.reasoningTokens, null);
  assert.equal(unknownResult.efficiency.totalTokens, null);

  const hiddenPatch = baseInput();
  hiddenPatch.control.expectedPatch = "do-not-use-hidden-oracle";
  assert.throws(
    () => module.evaluateProductComparison(hiddenPatch),
    (error) => {
      assert.equal(error?.code, "product_comparison_evaluator_invalid");
      assert.match(String(error?.message), /control must contain exactly/i);
      return true;
    }
  );

  const directCount = baseInput();
  directCount.control.unnecessaryChangedFileCount = 0;
  assert.throws(
    () => module.evaluateProductComparison(directCount),
    (error) => {
      assert.equal(error?.code, "product_comparison_evaluator_invalid");
      assert.match(String(error?.message), /control must contain exactly/i);
      return true;
    }
  );

  const oracleLabel = baseInput();
  oracleLabel.control.changedFileNecessityAssessments[1] = {
    ...oracleLabel.control.changedFileNecessityAssessments[1],
    source: "oracle"
  };
  assert.throws(
    () => module.evaluateProductComparison(oracleLabel),
    (error) => {
      assert.equal(error?.code, "product_comparison_evaluator_invalid");
      assert.match(String(error?.message), /acceptance, policy, or human/i);
      return true;
    }
  );

  const contradictorySuccess = baseInput();
  contradictorySuccess.correctness.testsPassed = false;
  assert.throws(
    () => module.evaluateProductComparison(contradictorySuccess),
    /taskSucceeded cannot be true.*testsPassed/i
  );

  const contradictoryControl = baseInput();
  contradictoryControl.control.scopeViolationCount = 1;
  assert.throws(
    () => module.evaluateProductComparison(contradictoryControl),
    /controlPassed cannot be true/i
  );

  const impossibleCommands = baseInput();
  impossibleCommands.efficiency.commandCount = 1;
  impossibleCommands.efficiency.failedCommandCount = 2;
  assert.throws(
    () => module.evaluateProductComparison(impossibleCommands),
    /failedCommandCount cannot exceed/i
  );

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: full.schemaVersion,
    metrics: {
      correctness: Object.keys(full.correctness),
      control: Object.keys(full.control),
      efficiency: Object.keys(full.efficiency)
    },
    unnecessaryChangedFiles: {
      derivedFromTrustedLabels: true,
      hiddenExpectedPatchRejected: true,
      directCountRejected: true,
      incompleteCoverageIsNull: true
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
