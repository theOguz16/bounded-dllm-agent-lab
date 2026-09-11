#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");
const builtModule = resolve(
  repoRoot,
  "dist/packages/integrations/src/comparative-agent-runner.js"
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function initFixture(root) {
  write(root, "src/target.ts", "export const value = 1;\n");
  write(root, "src/context.ts", "export const context = true;\n");
  write(root, "src/unrelated.ts", "export const unrelated = true;\n");
  write(root, "test/target.test.ts", "// validation context\n");
  write(root, ".env", "SECRET=not-for-agent\n");

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "src", "test", ".env"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

function workspaceFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(relative(root, absolute).split("\\").join("/"));
    }
  }
  visit(root);
  return files.sort();
}

function completedResult(request, overrides = {}) {
  return {
    status: "completed",
    agentId: "codex",
    agentVersion: "test-codex/1",
    modelId: request.model,
    durationMs: 25,
    finalMessage: "done",
    usage: {
      inputTokens: request.mode === "baseline" ? 100 : 60,
      outputTokens: 20,
      totalTokens: request.mode === "baseline" ? 120 : 80,
      cachedInputTokens: request.mode === "baseline" ? 40 : 10,
      toolCalls: 1
    },
    commands: [],
    fileChanges: [],
    diagnostics: [],
    ...overrides
  };
}

function taskForFirstArm(runtime, firstArm) {
  for (let index = 0; index < 10_000; index += 1) {
    const task = `Change value from 1 to 2. sample-${index}`;
    if (runtime.executionOrderForTaskHash(sha256(task))[0] === firstArm) return task;
  }
  throw new Error(`Could not find deterministic ${firstArm}-first task fixture.`);
}

async function runSample(runtime, fixtureRoot, sourceCommitSha, task, options = {}) {
  const validationSpec = Object.freeze({ command: "node test/evaluate.mjs" });
  const requests = [];
  const evaluatorCalls = [];
  const observedWorkspacePaths = [];
  const adapter = options.adapter ?? {
    agentId: "codex",
    agentVersion: "test-codex/1",
    async run(request) {
      requests.push(request);
      observedWorkspacePaths.push(request.workingDirectory);
      const files = workspaceFiles(request.workingDirectory);
      if (request.mode === "baseline") {
        assert.equal(files.includes("src/unrelated.ts"), true);
        assert.equal(files.includes(".env"), false);
      } else {
        assert.deepEqual(files, [
          "src/context.ts",
          "src/target.ts",
          "test/target.test.ts"
        ]);
      }
      writeFileSync(
        join(request.workingDirectory, "src/target.ts"),
        "export const value = 2;\n",
        "utf8"
      );
      return completedResult(request);
    }
  };
  const evaluator = async (context) => {
    evaluatorCalls.push(context.arm);
    assert.equal(context.validationSpec, validationSpec);
    assert.equal(context.task, task);
    return Object.freeze({
      passed: readFileSync(join(context.workspacePath, "src/target.ts"), "utf8").includes("2"),
      arm: context.arm,
      cachedInputTokens: context.run.usage.cachedInputTokens ?? null
    });
  };

  const result = await runtime.runComparativeAgentSample({
    repositoryPath: fixtureRoot,
    sourceRepositorySnapshotHash: sha256(`snapshot:${sourceCommitSha}`),
    sourceCommitSha,
    task,
    modelId: "gpt-test-codex",
    reasoningEffort: "high",
    timeoutBudget: 45_000,
    networkPolicy: "disabled",
    validationSpecHash: sha256(JSON.stringify(validationSpec)),
    validationSpec,
    selectedContextFiles: [
      "src/target.ts",
      "src/context.ts",
      "test/target.test.ts"
    ],
    approvedMutableFiles: ["src/target.ts"],
    forbiddenFiles: [],
    adapter,
    evaluator
  });
  return { result, requests, evaluatorCalls, observedWorkspacePaths };
}

async function main() {
  const runtime = await import(pathToFileURL(builtModule).href);
  assert.equal(runtime.COMPARATIVE_AGENT_RUNNER_VERSION, "comparative-agent-runner/v1");
  assert.equal(typeof runtime.runComparativeAgentSample, "function");
  assert.equal(typeof runtime.executionOrderForTaskHash, "function");
  assert.throws(
    () => runtime.executionOrderForTaskHash("not-a-hash"),
    (error) => error?.code === "comparative_agent_runner_invalid"
  );

  const fixtureRoot = mkdtempSync(join(tmpdir(), "bounded-comparison-source-"));
  try {
    initFixture(fixtureRoot);
    const sourceCommitSha = git(fixtureRoot, ["rev-parse", "HEAD"]);
    const sourceBefore = readFileSync(join(fixtureRoot, "src/target.ts"), "utf8");
    const baselineFirstTask = taskForFirstArm(runtime, "baseline");
    const boundedFirstTask = taskForFirstArm(runtime, "bounded");
    assert.notEqual(baselineFirstTask, boundedFirstTask);

    for (const [task, expectedOrder] of [
      [baselineFirstTask, ["baseline", "bounded"]],
      [boundedFirstTask, ["bounded", "baseline"]]
    ]) {
      const first = await runSample(runtime, fixtureRoot, sourceCommitSha, task);
      const second = await runSample(runtime, fixtureRoot, sourceCommitSha, task);

      assert.deepEqual(first.result.executionOrder, expectedOrder);
      assert.deepEqual(second.result.executionOrder, expectedOrder);
      assert.deepEqual(
        first.requests.map((request) => request.mode === "baseline" ? "baseline" : "bounded"),
        expectedOrder
      );
      assert.deepEqual(first.evaluatorCalls, expectedOrder);
      assert.equal(first.result.comparison.schemaVersion, "agent-comparison/v1");
      assert.equal(first.result.comparison.comparable, true);
      assert.deepEqual(first.result.comparison.identityMismatchFields, []);
      assert.deepEqual(first.result.workspaceIsolation, {
        distinctRoots: true,
        boundedContextIsBaselineSubset: true
      });
      assert.equal(first.result.arms.baseline.evaluation.passed, true);
      assert.equal(first.result.arms.bounded.evaluation.passed, true);
      assert.equal(first.result.arms.baseline.workspace.exposedFileCount, 4);
      assert.equal(first.result.arms.bounded.workspace.exposedFileCount, 3);
      assert.deepEqual(first.result.arms.bounded.workspace.mutableFiles, ["src/target.ts"]);
      assert.deepEqual(first.result.arms.bounded.workspace.changedFiles, ["src/target.ts"]);
      assert.equal(first.result.arms.baseline.workspace.mutableFiles.includes("src/unrelated.ts"), true);

      // Cache usage remains an independent observed metric on each arm.
      assert.equal(first.result.arms.baseline.run.usage.cachedInputTokens, 40);
      assert.equal(first.result.arms.bounded.run.usage.cachedInputTokens, 10);
      assert.equal(first.result.arms.baseline.evaluation.cachedInputTokens, 40);
      assert.equal(first.result.arms.bounded.evaluation.cachedInputTokens, 10);

      assert.equal(first.requests.length, 2);
      assert.notEqual(first.requests[0].workingDirectory, first.requests[1].workingDirectory);
      assert.equal(first.requests[0].task, first.requests[1].task);
      assert.equal(first.requests[0].model, first.requests[1].model);
      assert.equal(first.requests[0].reasoningEffort, first.requests[1].reasoningEffort);
      assert.equal(first.requests[0].timeoutMs, first.requests[1].timeoutMs);
      assert.equal(first.requests[0].networkAllowed, first.requests[1].networkAllowed);
      assert.equal(first.requests[0].sandboxMode, "workspace_write");
      assert.equal(first.requests[1].sandboxMode, "workspace_write");
      for (const workspacePath of first.observedWorkspacePaths) {
        assert.equal(existsSync(workspacePath), false);
      }
    }

    const violatingPaths = [];
    const violatingAdapter = {
      agentId: "codex",
      agentVersion: "test-codex/1",
      async run(request) {
        violatingPaths.push(request.workingDirectory);
        const target = request.mode === "coder" ? "src/context.ts" : "src/target.ts";
        writeFileSync(join(request.workingDirectory, target), "export const changed = true;\n", "utf8");
        return completedResult(request);
      }
    };
    await assert.rejects(
      () => runSample(runtime, fixtureRoot, sourceCommitSha, boundedFirstTask, { adapter: violatingAdapter }),
      (error) => {
        assert.equal(error?.code, "comparative_agent_scope_violation");
        assert.equal(error?.file, "src/context.ts");
        return true;
      }
    );
    for (const workspacePath of violatingPaths) assert.equal(existsSync(workspacePath), false);

    assert.equal(readFileSync(join(fixtureRoot, "src/target.ts"), "utf8"), sourceBefore);
    assert.equal(readFileSync(join(fixtureRoot, "src/context.ts"), "utf8"), "export const context = true;\n");
    assert.equal(git(fixtureRoot, ["rev-parse", "HEAD"]), sourceCommitSha);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      runnerVersion: runtime.COMPARATIVE_AGENT_RUNNER_VERSION,
      deterministicTaskHashOrder: true,
      baselineFirstCovered: true,
      boundedFirstCovered: true,
      fullArmOrderIncludesEvaluator: true,
      executionOrderRecorded: true,
      cachedInputTokensRemainSeparate: true,
      twinDisposableWorkspaces: true,
      boundedMutableScopeFailClosed: true,
      sourceRepositoryUnchanged: true,
      workspacesCleaned: true
    }, null, 2)}\n`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
