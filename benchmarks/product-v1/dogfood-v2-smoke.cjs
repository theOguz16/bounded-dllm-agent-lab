#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const suite = JSON.parse(fs.readFileSync(path.join(__dirname, "dogfood-v2.json"), "utf8"));
const taskset = JSON.parse(fs.readFileSync(path.join(root, suite.taskFile), "utf8"));
const hidden = JSON.parse(fs.readFileSync(path.join(root, suite.evaluatorCatalog), "utf8"));
const unsupported = JSON.parse(fs.readFileSync(path.join(root, suite.unsupportedSet), "utf8"));

function git(args) {
  return cp.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function main() {
  const runtime = await import(pathToFileURL(path.join(root,
    "dist/packages/product-runtime/src/product-task-contract.js")).href);
  assert.equal(suite.schemaVersion, "product-dogfood-suite/v2");
  assert.equal(taskset.schemaVersion, "product-dogfood-taskset/v2");
  assert.equal(taskset.suiteId, suite.suiteId);
  assert.deepEqual(suite.validationEnvironment, {
    nodeVersion: "22", installCommand: "npm ci", networkPolicy: "disabled"
  });
  const tasks = taskset.tasks.map((task) => runtime.parseProductTask(task));
  assert.equal(tasks.length, 20);
  assert.equal(new Set(tasks.map((task) => task.taskId)).size, 20);
  const categoryNames = ["bug_fix", "behavior_change", "regression_test", "small_multi_file"];
  for (const category of categoryNames) assert.equal(suite.categories[category].length, 5);
  assert.deepEqual(categoryNames.flatMap((name) => suite.categories[name]).sort(),
    tasks.map((task) => task.taskId).sort());

  assert.equal(hidden.schemaVersion, "product-dogfood-evaluator-catalog/v2");
  assert.equal(hidden.providerVisible, false);
  assert.equal(hidden.acceptanceFilesMutableByAgent, false);
  assert.equal(hidden.entries.length, 20);
  const hiddenByTask = new Map(hidden.entries.map((entry) => [entry.taskId, entry]));
  const protectedPrefix = "benchmarks/product-v1/evaluator/";
  for (const task of tasks) {
    const providerInput = runtime.createProductTaskProviderInput(task);
    assert.equal(JSON.stringify(providerInput).includes("criterionEvidence"), false);
    const evaluator = hiddenByTask.get(task.taskId);
    assert.ok(evaluator, `missing evaluator entry: ${task.taskId}`);
    assert.match(evaluator.referenceHeadSha, /^[0-9a-f]{40}$/);
    assert.equal(evaluator.criterionEvidence.length, task.acceptanceCriteria.length);
    const indexes = evaluator.criterionEvidence.map((entry) => entry.criterionIndex).sort((a, b) => a - b);
    assert.deepEqual(indexes, task.acceptanceCriteria.map((_, index) => index));
    for (const evidence of evaluator.criterionEvidence) {
      assert.match(evidence.evidenceId, /^[a-z0-9][a-z0-9._-]{2,127}$/);
      assert.equal(typeof evidence.command, "string");
      assert.deepEqual([evidence.baseline, evidence.reference, evidence.incomplete],
        ["fail", "pass", "fail"]);
    }
    git(["cat-file", "-e", `${task.commitSha}^{commit}`]);
    git(["cat-file", "-e", `${evaluator.referenceHeadSha}^{commit}`]);
    const changes = git(["diff", "--name-status", task.commitSha, evaluator.referenceHeadSha])
      .split("\n").filter(Boolean);
    assert.ok(changes.length > 0, `empty reference change: ${task.taskId}`);
    assert.equal(changes.every((line) => line.startsWith("M\t")), true,
      `unsupported file operation: ${task.taskId}`);
    assert.equal(changes.some((line) => line.slice(2).startsWith(protectedPrefix)), false,
      `hidden acceptance is candidate mutable: ${task.taskId}`);
    if (suite.categories.small_multi_file.includes(task.taskId)) assert.ok(changes.length >= 2);
  }
  assert.equal(unsupported.taskIds.length, 15);
  assert.equal(new Set(unsupported.taskIds).size, 15);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    suiteId: suite.suiteId,
    supportedTaskCount: tasks.length,
    unsupportedHistoricalTaskCount: unsupported.taskIds.length,
    distribution: Object.fromEntries(categoryNames.map((name) => [name, suite.categories[name].length])),
    criterionEvidenceComplete: true,
    baselineReferenceIncompleteTriad: "fail/pass/fail",
    hiddenAcceptanceCandidateMutable: false,
    validationEnvironment: suite.validationEnvironment
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
