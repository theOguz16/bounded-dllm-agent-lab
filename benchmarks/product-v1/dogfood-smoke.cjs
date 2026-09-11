#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../..");
const suitePath = path.join(repoRoot, "benchmarks/product-v1/dogfood-v1.json");
const hiddenPath = path.join(repoRoot, "benchmarks/product-v1/evaluator/dogfood-v1.hidden.json");
const runnerPath = path.join(repoRoot, "benchmarks/product-v1/dogfood-runner.cjs");
const hiddenKeys = ["oracle", "expectedPatch", "expectedChangedFiles", "evaluator", "referencePullRequest", "referenceHeadSha"];
const expectedValidation = ["npm run typecheck", "npm run build", "npm test"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const runtime = await import(
    pathToFileURL(
      path.join(repoRoot, "dist/packages/product-runtime/src/product-task-contract.js")
    ).href
  );
  const suite = readJson(suitePath);
  const taskset = readJson(path.join(repoRoot, suite.taskFile));
  assert.equal(taskset.schemaVersion, "product-dogfood-taskset/v1");
  assert.equal(taskset.suiteId, suite.suiteId);
  assert.equal(taskset.tasks.length, 20);

  const tasks = taskset.tasks.map((raw, index) => {
    for (const key of hiddenKeys) {
      assert.equal(Object.hasOwn(raw, key), false, `task ${index} leaks hidden evaluator field ${key}`);
    }
    const parsed = runtime.parseProductTask(raw);
    assert.equal(parsed.repo, "theOguz16/bounded-dllm-agent-lab");
    assert.match(parsed.commitSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(parsed.validationCommands, expectedValidation);
    return parsed;
  });

  assert.equal(new Set(tasks.map((task) => task.taskId)).size, 20);
  const categories = ["bug_fix", "behavior_change", "regression_test", "small_multi_file"];
  const allListed = [];
  for (const category of categories) {
    assert.equal(suite.categories[category].length, 5, `${category} must contain exactly five tasks`);
    allListed.push(...suite.categories[category]);
  }
  assert.equal(new Set(allListed).size, 20);
  assert.deepEqual([...allListed].sort(), tasks.map((task) => task.taskId).sort());

  assert.deepEqual(suite.comparison, {
    normalArm: "baseline",
    boundedArm: "bounded",
    freshWorkspacePerArm: true,
    freshSourceCheckoutPerTask: true,
    sameTask: true,
    sameCommit: true,
    sameModel: true,
    sameReasoning: true,
    sameValidation: true,
    reasoningEffort: "medium",
    networkPolicy: "disabled",
    retryOnArmFailure: false,
    mutatePromptAfterFailure: false,
    injectHiddenHints: false
  });

  const hidden = readJson(hiddenPath);
  assert.equal(hidden.schemaVersion, "product-dogfood-evaluator-catalog/v1");
  assert.equal(hidden.providerVisible, false);
  assert.equal(hidden.entries.length, 20);
  assert.equal(new Set(hidden.entries.map((entry) => entry.taskId)).size, 20);
  assert.deepEqual(
    hidden.entries.map((entry) => entry.taskId).sort(),
    tasks.map((task) => task.taskId).sort()
  );
  for (const entry of hidden.entries) {
    assert.equal(Number.isInteger(entry.referencePullRequest), true);
    assert.match(entry.referenceHeadSha, /^[0-9a-f]{40}$/);
  }

  const smallMultiRefs = new Map(hidden.entries.map((entry) => [entry.taskId, entry.referencePullRequest]));
  assert.deepEqual(
    suite.categories.small_multi_file.map((taskId) => smallMultiRefs.get(taskId)),
    [215, 216, 220, 221, 222]
  );

  const runnerSource = fs.readFileSync(runnerPath, "utf8");
  assert.match(runnerSource, /attempt:\s*1/);
  assert.match(runnerSource, /retryCount:\s*0/);
  assert.match(runnerSource, /hiddenHintsInjected:\s*false/);
  assert.match(runnerSource, /promptMutatedAfterFailure:\s*false/);
  assert.match(runnerSource, /Exactly one comparison invocation per task/);
  assert.equal(runnerSource.includes("referenceHeadSha"), false);
  assert.equal(runnerSource.includes("referencePullRequest"), false);
  assert.equal(runnerSource.includes("dogfood-v1.hidden.json"), false);

  const check = spawnSync(process.execPath, [runnerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_HOME: ""
    }
  });
  assert.equal(check.status, 0, check.stderr);
  const plan = JSON.parse(check.stdout);
  assert.equal(plan.liveProviderCalls, false);
  assert.equal(plan.taskCount, 20);
  assert.deepEqual(plan.distribution, {
    bug_fix: 5,
    behavior_change: 5,
    regression_test: 5,
    small_multi_file: 5
  });
  assert.equal(plan.comparison.retryOnArmFailure, false);
  assert.equal(plan.comparison.mutatePromptAfterFailure, false);
  assert.equal(plan.comparison.injectHiddenHints, false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    suite: suite.suiteId,
    taskCount: tasks.length,
    distribution: plan.distribution,
    normalFreshRunsPerTask: 1,
    boundedFreshRunsPerTask: 1,
    sameTaskCommitModelReasoningValidation: true,
    retriesOnFailure: 0,
    promptMutationOnFailure: false,
    hiddenHintInjection: false,
    hiddenEvaluatorSeparate: true,
    liveProviderCallsInCi: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
