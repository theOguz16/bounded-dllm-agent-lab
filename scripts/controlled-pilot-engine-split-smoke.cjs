#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

(async () => {
  const root = process.cwd();
  const facadePath = join(root, "scripts/controlled-coding-pilot.cjs");
  const facade = await readFile(facadePath, "utf8");
  assert.ok(facade.split(/\r?\n/).length < 140, "controlled pilot facade grew beyond 140 LOC");

  const expectedModules = [
    "definition.cjs", "profiles.cjs", "context.cjs", "text-edits.cjs",
    "provider.cjs", "verification.cjs", "evidence.cjs", "runner.cjs"
  ];
  for (const file of expectedModules) {
    const content = await readFile(join(root, "scripts/controlled-pilot", file), "utf8");
    assert.ok(content.length > 0, file);
  }

  const runner = await readFile(join(root, "scripts/controlled-pilot/runner.cjs"), "utf8");
  assert.ok(runner.split(/\r?\n/).length < 390, "controlled pilot runner grew beyond 390 LOC");
  for (const forbiddenImplementation of [
    "function validateDefinition(",
    "function boundedTextEditOutputSchema(",
    "function materializeBoundedTextEdits(",
    "function reportBase(",
    "function markdown(",
    "function classifyVerifierFailure(",
    "bounded.controlled-pilot-workspace-receipt/v1",
    "bounded.controlled-pilot-change-artifact/v1",
    "bounded.controlled-pilot-verifier-error/v1"
  ]) {
    assert.equal(runner.includes(forbiddenImplementation), false, forbiddenImplementation);
  }

  const api = require("./controlled-coding-pilot.cjs");
  const expectedExports = [
    "DEFINITION", "PILOT_EXECUTION_RUNTIME_MS", "PILOT_EXECUTOR_OUTPUT_TOKEN_LIMIT",
    "PILOT_MAX_INSERTION_LINES", "PILOT_MODEL_CONTEXT_TOKEN_LIMIT",
    "PILOT_PROVIDER_MAX_OUTPUT_TOKENS", "PILOT_PROVIDER_TIMEOUT_MS", "REPORT_VERSION",
    "TARGET", "V2_DEFINITION", "V2_TARGETS", "V1_RUNTIME_BUDGET", "V2_RUNTIME_BUDGET",
    "hash", "patchLines", "boundedTextEditInstruction", "boundedTextEditOutputSchema",
    "materializeBoundedTextEdits", "controlledInsertionInstruction",
    "controlledInsertionOutputSchema", "enforceSemanticPatchLimit",
    "executorModelIdForProvider", "classifyVerifierFailure",
    "deriveExecutorMutationLineBudget", "materializeControlledInsertion",
    "liveProviderConfiguration", "pilotProviderClientConfiguration",
    "renderControlledHelpInsertion", "resolveControlledInsertionAuthority",
    "runControlledCodingPilot", "validateRenderedInsertion", "validateDefinition"
  ].sort();
  assert.deepEqual(Object.keys(api).sort(), expectedExports);

  process.stdout.write(`controlled pilot engine split smoke: PASS facade=${facade.split(/\r?\n/).length} runner=${runner.split(/\r?\n/).length}\n`);
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
