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
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 0,
      toolCalls: 1
    },
    commands: [],
    fileChanges: [],
    diagnostics: [],
    ...overrides
  };
}

async function main() {
  const runtime = await import(pathToFileURL(builtModule).href);
  assert.equal(runtime.COMPARATIVE_AGENT_RUNNER_VERSION, "comparative-agent-runner/v1");
  assert.equal(typeof runtime.runComparativeAgentSample, "function");

  const fixtureRoot = mkdtempSync(join(tmpdir(), "bounded-comparison-source-"));
  try {
    initFixture(fixtureRoot);
    const sourceCommitSha = git(fixtureRoot, ["rev-parse", "HEAD"]);
    const sourceBefore = readFileSync(join(fixtureRoot, "src/target.ts"), "utf8");
    const validationSpec = Object.freeze({ command: "node test/evaluate.mjs" });
    const requests = [];
    const observedWorkspacePaths = [];
    const evaluatorCalls = [];

    const adapter = {
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
      evaluatorCalls.push(context);
      assert.equal(context.validationSpec, validationSpec);
      assert.equal(context.task, "Change value from 1 to 2.");
      return Object.freeze({
        passed: readFileSync(join(context.workspacePath, "src/target.ts"), "utf8").includes("2"),
        arm: context.arm
      });
    };

    const result = await runtime.runComparativeAgentSample({
      repositoryPath: fixtureRoot,
      sourceRepositorySnapshotHash: sha256(`snapshot:${sourceCommitSha}`),
      sourceCommitSha,
      task: "Change value from 1 to 2.",
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

    assert.equal(result.schemaVersion, "comparative-agent-runner/v1");
    assert.equal(result.comparison.schemaVersion, "agent-comparison/v1");
    assert.equal(result.comparison.comparable, true);
    assert.deepEqual(result.comparison.identityMismatchFields, []);
    assert.deepEqual(result.workspaceIsolation, {
      distinctRoots: true,
      boundedContextIsBaselineSubset: true
    });
    assert.equal(result.arms.baseline.evaluation.passed, true);
    assert.equal(result.arms.bounded.evaluation.passed, true);
    assert.equal(result.arms.baseline.workspace.exposedFileCount, 4);
    assert.equal(result.arms.bounded.workspace.exposedFileCount, 3);
    assert.deepEqual(result.arms.bounded.workspace.mutableFiles, ["src/target.ts"]);
    assert.deepEqual(result.arms.bounded.workspace.changedFiles, ["src/target.ts"]);
    assert.equal(result.arms.baseline.workspace.mutableFiles.includes("src/unrelated.ts"), true);

    assert.equal(requests.length, 2);
    assert.equal(evaluatorCalls.length, 2);
    assert.notEqual(requests[0].workingDirectory, requests[1].workingDirectory);
    assert.equal(requests[0].task, requests[1].task);
    assert.equal(requests[0].model, requests[1].model);
    assert.equal(requests[0].reasoningEffort, requests[1].reasoningEffort);
    assert.equal(requests[0].timeoutMs, requests[1].timeoutMs);
    assert.equal(requests[0].networkAllowed, requests[1].networkAllowed);
    assert.equal(requests[0].sandboxMode, "workspace_write");
    assert.equal(requests[1].sandboxMode, "workspace_write");
    assert.equal(requests[0].mode, "baseline");
    assert.equal(requests[1].mode, "coder");
    assert.equal(existsSync(observedWorkspacePaths[0]), false);
    assert.equal(existsSync(observedWorkspacePaths[1]), false);
    assert.equal(readFileSync(join(fixtureRoot, "src/target.ts"), "utf8"), sourceBefore);
    assert.equal(git(fixtureRoot, ["rev-parse", "HEAD"]), sourceCommitSha);

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
      () => runtime.runComparativeAgentSample({
        repositoryPath: fixtureRoot,
        sourceRepositorySnapshotHash: sha256(`snapshot:${sourceCommitSha}`),
        sourceCommitSha,
        task: "Change value from 1 to 2.",
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
        adapter: violatingAdapter,
        evaluator
      }),
      (error) => {
        assert.equal(error?.code, "comparative_agent_scope_violation");
        assert.equal(error?.file, "src/context.ts");
        return true;
      }
    );
    for (const workspacePath of violatingPaths) {
      assert.equal(existsSync(workspacePath), false);
    }
    assert.equal(readFileSync(join(fixtureRoot, "src/context.ts"), "utf8"), "export const context = true;\n");

    const mismatchAdapter = {
      agentId: "codex",
      agentVersion: "test-codex/1",
      async run(request) {
        writeFileSync(join(request.workingDirectory, "src/target.ts"), "export const value = 2;\n", "utf8");
        return completedResult(
          request,
          request.mode === "coder" ? { modelId: "unexpected-model" } : {}
        );
      }
    };
    const nonComparable = await runtime.runComparativeAgentSample({
      repositoryPath: fixtureRoot,
      sourceRepositorySnapshotHash: sha256(`snapshot:${sourceCommitSha}`),
      sourceCommitSha,
      task: "Change value from 1 to 2.",
      modelId: "gpt-test-codex",
      reasoningEffort: "high",
      timeoutBudget: 45_000,
      networkPolicy: "disabled",
      validationSpecHash: sha256(JSON.stringify(validationSpec)),
      validationSpec,
      selectedContextFiles: ["src/target.ts", "src/context.ts"],
      approvedMutableFiles: ["src/target.ts"],
      adapter: mismatchAdapter,
      evaluator
    });
    assert.equal(nonComparable.comparison.comparable, false);
    assert.deepEqual(nonComparable.comparison.identityMismatchFields, ["modelId"]);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      runnerVersion: runtime.COMPARATIVE_AGENT_RUNNER_VERSION,
      twinDisposableWorkspaces: true,
      baselineFullEligibleContext: true,
      boundedSelectedContextOnly: true,
      boundedMutableScopeFailClosed: true,
      sameEvaluator: true,
      sameTaskModelReasoningTimeoutNetworkValidationCommit: true,
      actualIdentityMismatchMarksNonComparable: true,
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
