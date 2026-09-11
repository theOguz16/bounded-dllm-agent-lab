#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const taskDirectory = resolve(repoRoot, "benchmarks/product-v1/tasks");
const evaluatorDirectory = resolve(repoRoot, "benchmarks/product-v1/evaluator");
const hiddenKeys = ["oracle", "expectedPatch", "expectedChangedFiles", "evaluator"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const contract = await import(
    pathToFileURL(
      resolve(repoRoot, "dist/packages/product-runtime/src/product-task-contract.js")
    ).href
  );

  assert.equal(contract.PRODUCT_TASK_CONTRACT_VERSION, "product-task/v1");
  assert.deepEqual([...contract.PRODUCT_TASK_FAMILIES], [
    "existing_function_bug_fix",
    "bounded_behavior_change",
    "regression_test_addition"
  ]);

  const taskFiles = readdirSync(taskDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const evaluatorFiles = readdirSync(evaluatorDirectory)
    .filter((name) => name.endsWith(".evaluator.json"))
    .sort();

  assert.equal(taskFiles.length, 3);
  assert.equal(evaluatorFiles.length, 3);

  const parsedTasks = taskFiles.map((name) => {
    const raw = readJson(join(taskDirectory, name));
    for (const key of hiddenKeys) {
      assert.equal(Object.hasOwn(raw, key), false, `${name} leaks hidden key ${key}`);
    }

    const parsed = contract.parseProductTask(raw);
    const providerInput = contract.createProductTaskProviderInput(raw);

    assert.deepEqual(providerInput, parsed);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.acceptanceCriteria), true);
    assert.equal(Object.isFrozen(parsed.validationCommands), true);
    assert.match(parsed.commitSha, /^[0-9a-f]{40}$/);
    assert.match(parsed.repo, /^[^/]+\/[^/]+$/);
    return parsed;
  });

  assert.deepEqual(
    [...new Set(parsedTasks.map((task) => task.family))].sort(),
    [...contract.PRODUCT_TASK_FAMILIES].sort()
  );

  const evaluatorByTask = new Map();
  for (const name of evaluatorFiles) {
    const evaluator = readJson(join(evaluatorDirectory, name));
    assert.equal(evaluator.schemaVersion, "product-task-evaluator/v1");
    assert.equal(typeof evaluator.taskId, "string");
    assert.equal(evaluatorByTask.has(evaluator.taskId), false);
    evaluatorByTask.set(evaluator.taskId, evaluator);
  }

  for (const task of parsedTasks) {
    const evaluator = evaluatorByTask.get(task.taskId);
    assert.ok(evaluator, `missing hidden evaluator for ${task.taskId}`);
    assert.equal(Array.isArray(evaluator.expectedChangedFiles), true);
    assert.equal(Array.isArray(evaluator.oracleAssertions), true);
    for (const key of hiddenKeys) {
      assert.equal(Object.hasOwn(task, key), false);
    }
  }

  const base = JSON.parse(JSON.stringify(parsedTasks[0]));
  for (const [key, value] of [
    ["oracle", { answer: "hidden" }],
    ["expectedPatch", "hidden diff"],
    ["expectedChangedFiles", ["secret.js"]],
    ["evaluator", { score: 1 }]
  ]) {
    const contaminated = { ...base, [key]: value };
    assert.throws(
      () => contract.createProductTaskProviderInput(contaminated),
      (error) =>
        error instanceof contract.ProductTaskContractError &&
        error.code === "product_task_invalid" &&
        error.reasons.includes(`unexpected_${key}`)
    );
  }

  assert.throws(
    () => contract.parseProductTask({ ...base, family: "unknown_family" }),
    (error) =>
      error instanceof contract.ProductTaskContractError &&
      error.reasons.includes("family_invalid")
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: contract.PRODUCT_TASK_CONTRACT_VERSION,
    taskCount: parsedTasks.length,
    taskFamilies: [...contract.PRODUCT_TASK_FAMILIES],
    fixedCommitRequired: true,
    acceptanceCriteriaRequired: true,
    validationCommandsRequired: true,
    hiddenEvaluatorSeparate: true,
    hiddenFieldsRejectedFromProviderInput: hiddenKeys
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
