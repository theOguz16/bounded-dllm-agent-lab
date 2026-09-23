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
const runtimeUrl = pathToFileURL(
  path.join(projectRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
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
const testSource = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { calculate } from '../src/calculate.js';",
  "test('calculate uses the accepted multiplier', () => assert.equal(calculate(4), 12));",
  ""
].join("\n");
const snapshotExclusions = new Set([".git", ".bounded", "node_modules", "dist"]);

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

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
    name: "codex-v1-real-controlled-apply-fixture",
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

async function snapshot(root) {
  const entries = [];
  async function walk(directory, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (prefix === "" && snapshotExclusions.has(name)) continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(absolute);
      assert.equal(stat.isSymbolicLink(), false, `snapshot symlink: ${relative}`);
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) entries.push([relative, sha256(await fs.readFile(absolute))]);
    }
  }
  await walk(root);
  return sha256(JSON.stringify(entries));
}

async function copyFixtureWorkspace(repository, target) {
  await fs.cp(repository, target, {
    recursive: true,
    filter: (source) => !snapshotExclusions.has(path.basename(source))
  });
}

async function materializeCandidate(repository, candidate, target) {
  await copyFixtureWorkspace(repository, target);
  const claim = candidate.coderMutation.claims.find((item) => item.file === "src/calculate.js");
  assert.ok(claim && typeof claim.newContent === "string");
  await fs.writeFile(path.join(target, claim.file), claim.newContent, "utf8");
}

async function createTrustedChecker(parent) {
  const trustedRoot = path.join(parent, "trusted-host");
  const checker = path.join(trustedRoot, "calculate-acceptance.mjs");
  await fs.mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(checker, [
    "import assert from 'node:assert/strict';",
    "import { pathToFileURL } from 'node:url';",
    "const workspace = process.argv[2];",
    "const moduleUrl = pathToFileURL(`${workspace}/src/calculate.js`);",
    "moduleUrl.searchParams.set('run', `${process.pid}-${Date.now()}`);",
    "const { calculate } = await import(moduleUrl.href);",
    "const actual = calculate(4);",
    "assert.equal(actual, 12);",
    "process.stdout.write(JSON.stringify({ criterionId: 'calculate.multiplies-by-three', actual, expected: 12 }));",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o400 });
  assert.equal(path.relative(parent, checker).startsWith("trusted-host/"), true);
  return checker;
}

async function executeAcceptance(checker, workspace, evidenceDirectory, label) {
  const result = spawnSync(process.execPath, [checker, workspace], {
    cwd: path.dirname(checker),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "1" },
    maxBuffer: 1024 * 1024
  });
  const output = {
    label,
    exitCode: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? "").slice(0, 32_768),
    stderr: String(result.stderr ?? "").slice(0, 32_768)
  };
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceDirectory, `${label}.json`), bytes, {
    flag: "wx",
    mode: 0o600
  });
  const observation = {
    workspaceHash: await snapshot(workspace),
    verdict: result.status === 0 ? "pass" : "assertion_fail",
    exitCode: result.status,
    outputHash: sha256(bytes)
  };
  return {
    log: { ...output, outputHash: observation.outputHash },
    execution: { ...observation, artifactHash: sha256(JSON.stringify(observation)) }
  };
}

async function main() {
  const originalCi = process.env.CI;
  process.env.CI = "";
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-v1-real-apply-")));
  try {
    const { repository, sourceCommitSha } = await createRepository(parent);
    const trustedChecker = await createTrustedChecker(parent);
    assert.equal(path.relative(repository, trustedChecker).startsWith(".."), true);
    const evidenceDirectory = path.join(parent, "trusted-evidence");
    await fs.mkdir(evidenceDirectory, { mode: 0o700 });
    const sourceTreeHash = await snapshot(repository);
    const sourceFileHash = sha256(await fs.readFile(path.join(repository, "src/calculate.js")));
    const counters = { discovery: 0, execution: 0 };
    let scopeApprovals = 0;
    const autoScope = await import(autoScopeUrl);
    const apply = await import(applyUrl);
    const candidateModule = await import(candidateUrl);
    const runtime = await import(runtimeUrl);

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

    const sourceWorkspace = path.join(parent, "behavior-source");
    const referenceWorkspace = path.join(parent, "behavior-reference");
    const wrongWorkspace = path.join(parent, "behavior-wrong");
    const candidateWorkspace = path.join(parent, "behavior-candidate");
    await copyFixtureWorkspace(repository, sourceWorkspace);
    await materializeCandidate(repository, candidate, referenceWorkspace);
    await copyFixtureWorkspace(repository, wrongWorkspace);
    await materializeCandidate(repository, candidate, candidateWorkspace);

    const sourceExecution = await executeAcceptance(
      trustedChecker, sourceWorkspace, evidenceDirectory, "source"
    );
    const referenceExecution = await executeAcceptance(
      trustedChecker, referenceWorkspace, evidenceDirectory, "reference"
    );
    const wrongExecution = await executeAcceptance(
      trustedChecker, wrongWorkspace, evidenceDirectory, "wrong"
    );
    const candidateExecution = await executeAcceptance(
      trustedChecker, candidateWorkspace, evidenceDirectory, "candidate"
    );
    assert.equal(sourceExecution.execution.workspaceHash, sourceTreeHash);
    assert.deepEqual([
      sourceExecution.execution.verdict,
      referenceExecution.execution.verdict,
      wrongExecution.execution.verdict,
      candidateExecution.execution.verdict
    ], ["assertion_fail", "pass", "assertion_fail", "pass"]);

    const candidateTreeHash = await snapshot(candidateWorkspace);
    const candidateFileHash = sha256(
      await fs.readFile(path.join(candidateWorkspace, "src/calculate.js"))
    );
    const checkerHash = sha256(await fs.readFile(trustedChecker));
    const criterion = {
      criterionId: "calculate.multiplies-by-three",
      checkHash: sha256(JSON.stringify({ checkerHash, expected: 12 }))
    };
    const taskHash = sha256(JSON.stringify({
      taskId: candidate.taskId,
      objectiveHash: candidate.objectiveHash,
      candidateHandoffHash: candidate.handoffHash
    }));
    const catalogHash = sha256(JSON.stringify({
      version: "codex-v1-real-apply/v1",
      criteria: [criterion]
    }));
    const expectation = {
      taskId: candidate.taskId,
      taskHash,
      sourceCommitSha,
      sourceTreeHash: sourceExecution.execution.workspaceHash,
      referenceCommitSha: sourceCommitSha,
      referenceTreeHash: referenceExecution.execution.workspaceHash,
      wrongTreeHash: wrongExecution.execution.workspaceHash,
      candidateTreeHash,
      catalogHash,
      requiredCriteria: [criterion]
    };
    const hostKey = crypto.randomBytes(32);
    const receipt = runtime.sealTrustedBehaviorEvidence({
      receiptVersion: "trusted-behavior-evidence/v2",
      taskId: candidate.taskId,
      taskHash,
      sourceCommitSha,
      sourceTreeHash: expectation.sourceTreeHash,
      referenceCommitSha: sourceCommitSha,
      referenceTreeHash: expectation.referenceTreeHash,
      wrongTreeHash: expectation.wrongTreeHash,
      candidateTreeHash,
      catalogHash,
      issuedAt: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
      criteria: [{
        ...criterion,
        source: sourceExecution.execution,
        reference: referenceExecution.execution,
        wrong: wrongExecution.execution,
        candidate: candidateExecution.execution
      }]
    }, hostKey);
    const assessment = runtime.evaluateTrustedBehaviorEvidence(receipt, expectation, hostKey);
    assert.equal(assessment.behaviorSatisfied, true, JSON.stringify(assessment));
    assert.equal(receipt.candidateTreeHash, candidateTreeHash);
    await writeJson(path.join(evidenceDirectory, "trusted-receipt.json"), receipt);

    const beforeUnauthorizedHash = sha256(
      await fs.readFile(path.join(repository, "src/calculate.js"))
    );
    const unauthorized = await apply.applyCommand(
      { nonInteractive: true },
      repository,
      { runtimeRoot: path.join(parent, "runtime-unauthorized") }
    );
    assert.equal(unauthorized.output.decision, "approval_required");
    assert.equal(unauthorized.output.mutationStarted, false);
    assert.equal(
      sha256(await fs.readFile(path.join(repository, "src/calculate.js"))),
      beforeUnauthorizedHash
    );

    const applied = await apply.applyCommand(
      {},
      repository,
      {
        decide: async (approvedCandidate) => {
          assert.equal(approvedCandidate.handoffHash, candidate.handoffHash);
          assert.equal(assessment.behaviorSatisfied, true);
          return { decision: "accept", reason: null };
        },
        runtimeRoot: path.join(parent, "runtime-applied")
      }
    );
    assert.equal(applied.exitCode, 0, JSON.stringify(applied.output));
    assert.equal(applied.output.apply, "APPLIED");
    assert.equal(applied.output.postApplyValidation, "PASS");
    const appliedBytes = await fs.readFile(path.join(repository, "src/calculate.js"));
    const appliedFileHash = sha256(appliedBytes);
    assert.equal(appliedBytes.toString("utf8"), sourceChanged);
    assert.notEqual(appliedFileHash, sourceFileHash);
    assert.equal(appliedFileHash, candidateFileHash);
    const appliedTreeHash = await snapshot(repository);
    assert.equal(appliedTreeHash, candidateTreeHash);
    const postApplyExecution = await executeAcceptance(
      trustedChecker, repository, evidenceDirectory, "post-apply"
    );
    assert.equal(postApplyExecution.execution.verdict, "pass");
    assert.equal(postApplyExecution.execution.workspaceHash, candidateTreeHash);

    const callsAtTerminal = counters.discovery + counters.execution;
    assert.equal(callsAtTerminal, 3, "one discovery, one planner and one coder call are expected");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      targetCommit: "b8562927fdf4b06609b96c31e4fd3f6abd41029a",
      liveProviderCalls: 0,
      fakeProviderCalls: { count: callsAtTerminal, discovery: counters.discovery, execution: counters.execution },
      source: { commitSha: sourceCommitSha, treeHash: sourceTreeHash, fileHash: sourceFileHash },
      candidate: { handoffHash: candidate.handoffHash, treeHash: candidateTreeHash, fileHash: candidateFileHash },
      trustedBehavior: {
        receiptVersion: receipt.receiptVersion,
        candidateTreeHash: receipt.candidateTreeHash,
        behaviorSatisfied: assessment.behaviorSatisfied,
        reason: assessment.reason,
        checkerHash,
        receiptHash: sha256(JSON.stringify(receipt))
      },
      unauthorizedApply: {
        decision: unauthorized.output.decision,
        mutationStarted: unauthorized.output.mutationStarted,
        sourceFileHash: beforeUnauthorizedHash
      },
      controlledApply: {
        decision: applied.output.decision,
        receiptHash: applied.output.receiptHash,
        controlledApplyReceiptHash: applied.output.controlledApplyReceiptHash,
        postApplyReceiptHash: applied.output.postApplyReceiptHash,
        sourceFileHash: appliedFileHash,
        sourceTreeHash: appliedTreeHash
      },
      postApplyBehavior: {
        verdict: postApplyExecution.execution.verdict,
        workspaceHash: postApplyExecution.execution.workspaceHash,
        outputHash: postApplyExecution.execution.outputHash
      },
      executionLogs: {
        source: sourceExecution.log,
        reference: referenceExecution.log,
        wrong: wrongExecution.log,
        candidate: candidateExecution.log,
        postApply: postApplyExecution.log
      }
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
