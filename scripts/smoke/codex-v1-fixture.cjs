#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");


const sourceOriginal = [
  "export function calculate(value) {",
  "  return value * 2;",
  "}",
  ""
].join("\n");
const sourceChanged = [
  "export function calculate(value) {",
  "  return value * 3;",
  "}",
  ""
].join("\n");
const testSource = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { calculate } from '../src/calculate.js';",
  "test('calculate uses the accepted multiplier', () => assert.equal(calculate(4), 12));",
  ""
].join("\n");
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCli(cwd, args, cliPath) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "", CODEX_API_KEY: "", OPENAI_API_KEY: "", CODEX_MODEL: "" }
  });
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepository(parent, projectRoot, fixtureName) {
  const repository = path.join(parent, "repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "test"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: fixtureName,
    private: true,
    type: "module",
    scripts: {
      test: "node --test",
      build: "node --check src/calculate.js",
      typecheck: "node --check src/calculate.js"
    }
  });
  await fs.writeFile(path.join(repository, "package-lock.json"), "fixture\n", "utf8");
  await fs.writeFile(path.join(repository, "src/calculate.js"), sourceOriginal, "utf8");
  await fs.writeFile(path.join(repository, "test/calculate.test.js"), testSource, "utf8");
  git(repository, ["add", "package.json", "package-lock.json", "src", "test"]);
  git(repository, [
    "-c", "user.name=Codex V1 Fixture",
    "-c", "user.email=codex-v1@example.invalid",
    "commit", "-q", "-m", "fixture"
  ]);
  const initialized = runCli(repository, ["init", "--json"], path.join(projectRoot, "dist/apps/cli/src/index.js"));
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  git(repository, ["add", "."]);
  git(repository, [
    "-c", "user.name=Codex V1 Fixture",
    "-c", "user.email=codex-v1@example.invalid",
    "commit", "-q", "-m", "bounded fixture config"
  ]);
  return { repository, sourceCommitSha: git(repository, ["rev-parse", "HEAD"]) };
}

function discoveryProposal() {
  return {
    schemaVersion: "scope-discovery/v1",
    candidateSourceFiles: ["src/calculate.js"],
    candidateTestFiles: ["test/calculate.test.js"],
    candidateSymbols: ["calculate"],
    reason: "The implementation and focused regression test are the smallest grounded scope."
  };
}

function completedAgentResult(version, modelId, finalMessage, fileChanges = []) {
  return {
    status: "completed",
    agentId: "codex",
    agentVersion: version,
    modelId,
    durationMs: 1,
    finalMessage,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 20,
      toolCalls: null
    },
    commands: [],
    fileChanges,
    diagnostics: []
  };
}

function fakeDiscoveryAdapter(repository, counters) {
  return {
    agentId: "codex",
    agentVersion: "fake-discovery/v1",
    async run(request) {
      counters.discovery += 1;
      assert.equal(request.mode, "discovery");
      assert.equal(request.networkAllowed, false);
      assert.equal(request.sandboxMode, "read_only");
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(repository));
      return completedAgentResult(
        "fake-discovery/v1",
        "fixture-model",
        JSON.stringify(discoveryProposal())
      );
    }
  };
}

function plannerDraft(context) {
  return {
    proposal: {
      proposalVersion: "1",
      taskId: context.taskId,
      objectiveHash: context.objectiveHash,
      acceptanceContractHash: context.acceptanceContractHash,
      authorityHash: context.authorityHash,
      policyHash: context.policyHash,
      seedFiles: ["src/calculate.js", "test/calculate.test.js"],
      seedRationales: [
        { path: "src/calculate.js", reason: "Approved implementation scope." },
        { path: "test/calculate.test.js", reason: "Approved regression evidence." }
      ],
      requiredSymbols: [],
      requiredTestFiles: ["test/calculate.test.js"],
      maxExpansionAttempts: 1
    },
    minimalityPlan: {
      planVersion: "1",
      riskClass: "low",
      taskExplicitlyRequestsRefactor: false,
      plannedFiles: [{
        path: "src/calculate.js",
        changeKind: "bugfix",
        requested: true,
        justification: null
      }],
      newDependencies: [],
      newAbstractions: []
    }
  };
}

function fakeExecutionAdapter(repository, counters, candidateSource = sourceChanged) {
  return {
    agentId: "codex",
    agentVersion: "fake-execution/v1",
    async run(request) {
      counters.execution += 1;
      assert.equal(request.networkAllowed, false);
      assert.notEqual(path.resolve(request.workingDirectory), path.resolve(repository));
      if (request.mode === "planner") {
        const context = JSON.parse(request.task.split("\n").at(-1));
        return completedAgentResult(
          "fake-execution/v1",
          "fixture-model",
          JSON.stringify(plannerDraft(context))
        );
      }
      assert.equal(request.mode, "coder");
      await fs.writeFile(path.join(request.workingDirectory, "src/calculate.js"), candidateSource, "utf8");
      return completedAgentResult(
        "fake-execution/v1",
        "fixture-model",
        "Updated the approved source file in the disposable workspace.",
        [{ sequence: 1, path: "src/calculate.js", operation: "modify" }]
      );
    }
  };
}

module.exports = { sourceOriginal, sourceChanged, testSource, createRepository, fakeDiscoveryAdapter, fakeExecutionAdapter };
