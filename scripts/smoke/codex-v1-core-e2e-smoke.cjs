#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = process.cwd();
const cliPath = path.join(projectRoot, "dist/apps/cli/src/index.js");
const autoScopeUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/commands/codex-auto-scope.js")
).href;
const applyUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/commands/apply.js")
).href;
const candidateUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/candidate-handoff.js")
).href;
const decisionUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/human-decision.js")
).href;

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
const sourceWrong = sourceChanged.replace("* 3", "* 4");
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

function runCli(cwd, args) {
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

async function createRepository(parent) {
  const repository = path.join(parent, "repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.mkdir(path.join(repository, "test"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: "codex-v1-core-e2e-fixture",
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
  const initialized = runCli(repository, ["init", "--json"]);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  git(repository, ["add", "."]);
  git(repository, [
    "-c", "user.name=Codex V1 Fixture",
    "-c", "user.email=codex-v1@example.invalid",
    "commit", "-q", "-m", "bounded fixture config"
  ]);
  return repository;
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

function fakeExecutionAdapter(repository, counters) {
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
      await fs.writeFile(path.join(request.workingDirectory, "src/calculate.js"), sourceChanged, "utf8");
      return completedAgentResult(
        "fake-execution/v1",
        "fixture-model",
        "Updated the approved source file in the disposable workspace.",
        [{ sequence: 1, path: "src/calculate.js", operation: "modify" }]
      );
    }
  };
}

async function independentBehavior(repository, candidate, parent, variant) {
  if (variant === "missing") {
    return {
      validationExecuted: false,
      behaviorObserved: false,
      behaviorSatisfied: null,
      outcome: "unknown"
    };
  }
  const workspace = path.join(parent, `behavior-${variant}`);
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "test"), { recursive: true });
  await fs.copyFile(path.join(repository, "package.json"), path.join(workspace, "package.json"));
  await fs.copyFile(path.join(repository, "test/calculate.test.js"), path.join(workspace, "test/calculate.test.js"));
  const claim = candidate.coderMutation.claims.find((item) => item.file === "src/calculate.js");
  assert.ok(claim && typeof claim.newContent === "string");
  await fs.writeFile(
    path.join(workspace, "src/calculate.js"),
    variant === "failed" ? sourceWrong : claim.newContent,
    "utf8"
  );
  const checked = spawnSync(process.execPath, ["--test"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "1" }
  });
  return {
    validationExecuted: true,
    behaviorObserved: true,
    behaviorSatisfied: checked.status === 0,
    outcome: checked.status === 0 ? "successful" : "failed",
    evidenceHash: `sha256:${crypto.createHash("sha256")
      .update(`${checked.status}\n${checked.stdout}\n${checked.stderr}`)
      .digest("hex")}`
  };
}

function runReport(modelCalls, candidate, behavior) {
  return {
    modelCallStarted: modelCalls > 0,
    candidateProduced: candidate !== null,
    validationExecuted: behavior.validationExecuted,
    behaviorObserved: behavior.behaviorObserved,
    behaviorSatisfied: behavior.behaviorSatisfied,
    outcome: behavior.outcome
  };
}

async function main() {
  const originalCi = process.env.CI;
  process.env.CI = "";
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-v1-core-e2e-")));
  try {
    const repository = await createRepository(parent);
    const counters = { discovery: 0, execution: 0 };
    let scopeApprovals = 0;
    const autoScope = await import(autoScopeUrl);
    const apply = await import(applyUrl);
    const candidateModule = await import(candidateUrl);
    const decisions = await import(decisionUrl);

    const generated = await autoScope.codexAutoScopeCommand(
      { task: "Make calculate multiply by three." },
      repository,
      {
        discoveryAdapter: fakeDiscoveryAdapter(repository, counters),
        discoveryModel: "fixture-model",
        approveScope: async (proposal) => {
          scopeApprovals += 1;
          assert.deepEqual(proposal.candidateSourceFiles, ["src/calculate.js"]);
          return true;
        },
        explicit: {
          adapter: fakeExecutionAdapter(repository, counters),
          model: "fixture-model",
          validationProfile: "structural_draft"
        }
      }
    );
    assert.equal(generated.exitCode, 0, JSON.stringify(generated.output));
    assert.equal(generated.output.candidatePersisted, true);
    assert.equal(scopeApprovals, 1);
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.js"), "utf8"), sourceOriginal);
    const candidate = await candidateModule.readCandidateHandoff(repository);

    const successful = await independentBehavior(repository, candidate, parent, "successful");
    const failed = await independentBehavior(repository, candidate, parent, "failed");
    const missing = await independentBehavior(repository, candidate, parent, "missing");
    const reports = {
      successful: runReport(counters.discovery + counters.execution, candidate, successful),
      failed: runReport(counters.discovery + counters.execution, candidate, failed),
      missing: runReport(counters.discovery + counters.execution, candidate, missing)
    };
    assert.equal(reports.successful.outcome, "successful");
    assert.equal(reports.failed.outcome, "failed");
    assert.equal(reports.missing.outcome, "unknown");
    assert.equal(reports.missing.behaviorSatisfied, null);

    let executeCalls = 0;
    const unauthorized = await apply.applyCommand(
      { nonInteractive: true },
      repository,
      {
        execute: async () => {
          executeCalls += 1;
          throw new Error("unauthorized execution");
        },
        runtimeRoot: path.join(parent, "runtime-unauthorized")
      }
    );
    assert.equal(unauthorized.output.decision, "approval_required");
    assert.equal(unauthorized.output.mutationStarted, false);
    assert.equal(executeCalls, 0);

    await decisions.recordHumanDecision(repository, candidate, { decision: "accept", reason: null });
    const { handoffHash: _oldHash, ...candidateMaterial } = candidate;
    const newerCandidate = candidateModule.createCandidateHandoff({
      ...candidateMaterial,
      planHash: `sha256:${"9".repeat(64)}`
    });
    assert.notEqual(newerCandidate.handoffHash, candidate.handoffHash);
    await candidateModule.writeCandidateHandoff(repository, newerCandidate);
    const staleApproval = await apply.applyCommand(
      { nonInteractive: true },
      repository,
      {
        execute: async () => {
          executeCalls += 1;
          throw new Error("stale approval execution");
        },
        runtimeRoot: path.join(parent, "runtime-stale")
      }
    );
    assert.equal(staleApproval.output.decision, "approval_required");
    assert.equal(staleApproval.output.candidateHandoffHash, newerCandidate.handoffHash);
    assert.equal(executeCalls, 0);

    await candidateModule.writeCandidateHandoff(repository, candidate);
    const applied = await apply.applyCommand(
      {},
      repository,
      {
        decide: async (approvedCandidate) => {
          assert.equal(approvedCandidate.handoffHash, candidate.handoffHash);
          assert.equal(successful.behaviorSatisfied, true);
          return { decision: "accept", reason: null };
        },
        runtimeRoot: path.join(parent, "runtime-applied")
      }
    );
    assert.equal(applied.exitCode, 0, JSON.stringify(applied.output));
    assert.equal(applied.output.apply, "APPLIED");
    assert.equal(applied.output.postApplyValidation, "PASS");
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.js"), "utf8"), sourceChanged);

    const callsAtTerminal = counters.discovery + counters.execution;
    assert.equal(callsAtTerminal, 3, "one discovery, one planner and one coder call are expected");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      liveProviderCalls: 0,
      fakeProviderCalls: callsAtTerminal,
      scopeApprovalRequired: true,
      reports,
      unauthorizedApply: "blocked",
      staleCandidateApproval: "blocked",
      controlledApply: "applied_and_validated",
      automaticCallsAfterCompletedFlow: 0,
      sourceChangedOnlyAfterApprovedApply: true
    }, null, 2)}\n`);
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    await fs.rm(parent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
