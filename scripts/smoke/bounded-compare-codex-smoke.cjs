#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");

async function main() {
  const moduleUrl = pathToFileURL(
    resolve(repoRoot, "dist/apps/cli/src/commands/compare.js")
  ).href;
  const compare = await import(moduleUrl);
  const validation = await import(pathToFileURL(
    resolve(repoRoot, "dist/apps/cli/src/compare-validation-substrate.js")
  ).href);

  assert.equal(compare.BOUNDED_COMPARE_CODEX_VERSION, "bounded-compare-codex/v1");
  assert.equal(compare.BOUNDED_COMPARE_RUNTIME_VERSION, "canonical-bounded-compare/v1");
  assert.equal(compare.BOUNDED_COMPARE_REASONING, "none");
  assert.equal(compare.BOUNDED_COMPARE_DISCOVERY_TIMEOUT_MS, 180000);
  assert.equal(compare.BOUNDED_COMPARE_AGENT_TIMEOUT_MS, 300000);
  assert.equal(compare.BOUNDED_COMPARE_TIMEOUT_MS, 300000);
  assert.equal(compare.BOUNDED_COMPARE_NETWORK_POLICY, "disabled");
  assert.equal(validation.COMPARE_VALIDATION_SUBSTRATE_VERSION, "compare-validation-substrate/v1");
  assert.equal(validation.COMPARE_VALIDATION_TIMEOUT_MS, 120000);
  assert.equal(typeof compare.compareCodexCommand, "function");
  assert.equal(typeof compare.formatCodexComparisonTable, "function");
  assert.equal(typeof validation.prepareCompareValidationSubstrate, "function");
  assert.equal(typeof validation.runCompareValidation, "function");

  const normal = {
    behavior: true,
    controls: true,
    inputTokens: 61840,
    cachedInputTokens: 18200,
    outputTokens: 8420,
    exposedFiles: 94,
    exposedBytes: Math.round(2.1 * 1024 * 1024),
    changedFiles: 5,
    scopeViolations: 2,
    commands: 27,
    failedCommands: 4,
    repairRounds: 0,
    durationMs: 91234
  };
  const bounded = {
    behavior: true,
    controls: true,
    inputTokens: 29270,
    cachedInputTokens: 8950,
    outputTokens: 7110,
    exposedFiles: 11,
    exposedBytes: 134 * 1024,
    changedFiles: 2,
    scopeViolations: 0,
    commands: 16,
    failedCommands: 1,
    repairRounds: 0,
    durationMs: 65432
  };

  const table = compare.formatCodexComparisonTable(normal, bounded);
  assert.match(table, /NORMAL\s+BOUNDED\s+Δ/);
  assert.match(table, /Behavior\s+PASS\s+PASS/);
  assert.match(table, /Controls\s+PASS\s+PASS/);
  assert.match(table, /Input tokens\s+61,840\s+29,270\s+-52\.7%/);
  assert.match(table, /Output tokens\s+8,420\s+7,110\s+-15\.6%/);
  assert.match(table, /Exposed files\s+94\s+11/);
  assert.match(table, /Exposed bytes\s+2\.1 MB\s+134 KB/);
  assert.match(table, /Changed files\s+5\s+2/);
  assert.match(table, /Scope violations\s+2\s+0/);
  assert.match(table, /Commands\s+27\s+16/);
  assert.match(table, /Failed commands\s+4\s+1/);
  assert.match(table, /Repair rounds\s+0\s+0/);
  assert.match(table, /Duration\s+91\.2 s\s+65\.4 s/);

  const missing = compare.formatCodexComparisonTable(
    { ...normal, behavior: null, inputTokens: null, cachedInputTokens: null, outputTokens: null },
    { ...bounded, behavior: null, inputTokens: null, cachedInputTokens: null, outputTokens: null }
  );
  assert.match(missing, /Behavior\s+N\/A\s+N\/A/);
  assert.match(missing, /Input tokens\s+N\/A\s+N\/A\s+N\/A/);
  assert.match(missing, /Cached input\s+N\/A\s+N\/A/);
  assert.match(missing, /Output tokens\s+N\/A\s+N\/A\s+N\/A/);

  const cli = resolve(repoRoot, "dist/apps/cli/src/index.js");
  const missingTask = spawnSync(process.execPath, [cli, "compare", "codex", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" }
  });
  assert.equal(missingTask.status, 2);
  const missingTaskJson = JSON.parse(missingTask.stdout);
  assert.equal(missingTaskJson.code, "cli_compare_task_missing");

  const invalidTarget = spawnSync(process.execPath, [cli, "compare", "other", "--task", "x", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" }
  });
  assert.equal(invalidTarget.status, 2);
  const invalidTargetJson = JSON.parse(invalidTarget.stdout);
  assert.equal(invalidTargetJson.code, "cli_compare_target_invalid");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: compare.BOUNDED_COMPARE_CODEX_VERSION,
    runtimeVersion: compare.BOUNDED_COMPARE_RUNTIME_VERSION,
    validationSubstrate: validation.COMPARE_VALIDATION_SUBSTRATE_VERSION,
    discoveryBudgetMs: compare.BOUNDED_COMPARE_DISCOVERY_TIMEOUT_MS,
    agentBudgetMs: compare.BOUNDED_COMPARE_AGENT_TIMEOUT_MS,
    validationBudgetMs: validation.COMPARE_VALIDATION_TIMEOUT_MS,
    humanTable: true,
    missingMetric: "N/A",
    inputDelta: "-52.7%",
    outputDelta: "-15.6%",
    liveProviderCalls: false
  })}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
