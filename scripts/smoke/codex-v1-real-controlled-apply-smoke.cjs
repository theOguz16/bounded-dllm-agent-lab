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
const comparisonUrl = pathToFileURL(
  path.join(projectRoot, "dist/packages/product-runtime/src/product-comparison-evaluator-v3.js")
).href;
const decisionUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/human-decision.js")
).href;

const { sourceOriginal, sourceChanged, createRepository, fakeDiscoveryAdapter, fakeExecutionAdapter } =
  require("./codex-v1-fixture.cjs");
const { sha256, snapshot, copyFixtureWorkspace, materializeCandidate, createTrustedChecker,
  executeAcceptance, executeFixtureCheck } = require("./codex-v1-trusted-host.cjs");

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const originalCi = process.env.CI;
  process.env.CI = "";
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-v1-real-apply-")));
  try {
    const { repository, sourceCommitSha } = await createRepository(
      parent, projectRoot, "codex-v1-real-controlled-apply-fixture"
    );
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
    const comparison = await import(comparisonUrl);
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

    const sourceWorkspace = path.join(parent, "behavior-source");
    const referenceWorkspace = path.join(parent, "behavior-reference");
    const wrongWorkspace = path.join(parent, "behavior-wrong");
    const candidateWorkspace = path.join(parent, "behavior-candidate");
    await copyFixtureWorkspace(repository, sourceWorkspace);
    await materializeCandidate(repository, candidate, referenceWorkspace);
    await copyFixtureWorkspace(repository, wrongWorkspace);
    await fs.writeFile(
      path.join(wrongWorkspace, "src/calculate.js"), sourceChanged.replace("* 3", "* 4"), "utf8"
    );
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

    const buildCheck = executeFixtureCheck(candidateWorkspace, "build");
    const typecheckCheck = executeFixtureCheck(candidateWorkspace, "typecheck");
    assert.equal(buildCheck.exitCode, 0, JSON.stringify(buildCheck));
    assert.equal(typecheckCheck.exitCode, 0, JSON.stringify(typecheckCheck));
    const reportInput = {
      correctness: {
        controlPassed: generated.exitCode === 0 && generated.output.candidatePersisted === true,
        taskSucceeded: null,
        testsPassed: candidateExecution.execution.verdict === "pass",
        buildPassed: buildCheck.exitCode === 0,
        typecheckPassed: typecheckCheck.exitCode === 0
      },
      behaviorEvidence: receipt,
      control: {
        scopeViolationCount: 0,
        forbiddenTouchCount: 0,
        unsupportedMutationCount: 0,
        changedFiles: ["src/calculate.js"],
        changedFileNecessityAssessments: [{
          path: "src/calculate.js",
          source: "acceptance",
          decision: "necessary",
          evidenceReference: checkerHash
        }]
      },
      efficiency: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        exposedFiles: 0,
        exposedBytes: 0,
        commandCount: 0,
        failedCommandCount: 0,
        repairRounds: 0,
        durationMs: 0
      }
    };
    const canonicalReport = comparison.evaluateTrustedProductComparison(reportInput, expectation, hostKey);
    assert.equal(canonicalReport.schemaVersion, "product-comparison-evaluation/v3");
    assert.equal(canonicalReport.correctness.behaviorSatisfied, true);
    assert.equal(canonicalReport.correctness.taskSucceeded, true);
    assert.equal(canonicalReport.behavior.reason, "trusted_acceptance_passed");
    const missingReport = comparison.evaluateTrustedProductComparison(
      { ...reportInput, behaviorEvidence: null }, expectation, hostKey
    );
    assert.equal(missingReport.correctness.taskSucceeded, null);
    const wrongReport = comparison.evaluateTrustedProductComparison(
      { ...reportInput, behaviorEvidence: { ...receipt, seal: "0".repeat(64) } }, expectation, hostKey
    );
    assert.equal(wrongReport.correctness.taskSucceeded, null);

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

    const approvalA = await decisions.recordHumanDecision(
      repository, candidate, { decision: "accept", reason: null }
    );
    assert.equal(approvalA.candidateHandoffHash, candidate.handoffHash);
    assert.equal((await decisions.readHumanDecision(repository, candidate.handoffHash)).decision, "accept");
    const candidateBSource = sourceChanged.replace(
      "  return value * 3;", "  // The accepted multiplier is three.\n  return value * 3;"
    );
    const generatedB = await autoScope.codexAutoScopeCommand(
      { task: "Make calculate multiply by three and document the accepted multiplier." },
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
          adapter: fakeExecutionAdapter(repository, counters, candidateBSource),
          model: "fixture-model",
          validationProfile: "structural_draft"
        }
      }
    );
    assert.equal(generatedB.exitCode, 0, JSON.stringify(generatedB.output));
    assert.equal(generatedB.output.candidatePersisted, true);
    assert.equal(scopeApprovals, 2);
    const candidateB = await candidateModule.readCandidateHandoff(repository);
    assert.notEqual(candidateB.handoffHash, candidate.handoffHash);
    const candidateBWorkspace = path.join(parent, "behavior-candidate-b");
    await materializeCandidate(repository, candidateB, candidateBWorkspace);
    assert.equal(await fs.readFile(path.join(candidateBWorkspace, "src/calculate.js"), "utf8"), candidateBSource);
    const candidateBExecution = await executeAcceptance(
      trustedChecker, candidateBWorkspace, evidenceDirectory, "candidate-b"
    );
    assert.equal(candidateBExecution.execution.verdict, "pass");
    const candidateBTreeHash = await snapshot(candidateBWorkspace);
    assert.notEqual(candidateBTreeHash, candidateTreeHash);
    assert.equal(await decisions.readHumanDecision(repository, candidateB.handoffHash), null);
    const expectationB = {
      ...expectation,
      taskId: candidateB.taskId,
      taskHash: sha256(JSON.stringify({
        taskId: candidateB.taskId,
        objectiveHash: candidateB.objectiveHash,
        candidateHandoffHash: candidateB.handoffHash
      })),
      candidateTreeHash: candidateBTreeHash
    };
    const staleEvidenceReport = comparison.evaluateTrustedProductComparison(
      reportInput, expectationB, hostKey
    );
    assert.equal(staleEvidenceReport.correctness.behaviorSatisfied, null);
    assert.equal(staleEvidenceReport.correctness.taskSucceeded, null);
    const staleApproval = await apply.applyCommand(
      { nonInteractive: true }, repository, { runtimeRoot: path.join(parent, "runtime-stale") }
    );
    assert.equal(staleApproval.output.candidateHandoffHash, candidateB.handoffHash);
    assert.equal(staleApproval.output.decision, "approval_required");
    assert.equal(staleApproval.output.mutationStarted, false);
    assert.equal(staleApproval.output.apply, "NOT_RUN");
    assert.equal(await fs.stat(path.join(parent, "runtime-stale")).catch(() => null), null);
    assert.equal(sha256(await fs.readFile(path.join(repository, "src/calculate.js"))), sourceFileHash);
    await candidateModule.writeCandidateHandoff(repository, candidate);

    const applied = await apply.applyCommand(
      {},
      repository,
      {
        decide: async (approvedCandidate) => {
          assert.equal(approvedCandidate.handoffHash, candidate.handoffHash);
          assert.equal(canonicalReport.correctness.taskSucceeded, true);
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
    assert.equal(callsAtTerminal, 6, "two candidates require two discovery, planner and coder calls");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      integrationHead: head.stdout.trim(),
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
      canonicalReport: {
        schemaVersion: canonicalReport.schemaVersion,
        candidateHandoffHash: candidate.handoffHash,
        candidateTreeHash: receipt.candidateTreeHash,
        behaviorSatisfied: canonicalReport.correctness.behaviorSatisfied,
        taskSucceeded: canonicalReport.correctness.taskSucceeded,
        missingTaskSucceeded: missingReport.correctness.taskSucceeded,
        wrongTaskSucceeded: wrongReport.correctness.taskSucceeded,
        staleTaskSucceeded: staleEvidenceReport.correctness.taskSucceeded
      },
      unauthorizedApply: {
        decision: unauthorized.output.decision,
        mutationStarted: unauthorized.output.mutationStarted,
        sourceFileHash: beforeUnauthorizedHash
      },
      staleApproval: {
        approvedCandidateHash: approvalA.candidateHandoffHash,
        currentCandidateHash: candidateB.handoffHash,
        currentCandidateTreeHash: candidateBTreeHash,
        currentCandidateBehaviorVerdict: candidateBExecution.execution.verdict,
        decision: staleApproval.output.decision,
        mutationStarted: staleApproval.output.mutationStarted,
        apply: staleApproval.output.apply,
        sourceFileHash: sourceFileHash,
        oldEvidenceBehaviorSatisfied: staleEvidenceReport.correctness.behaviorSatisfied
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
        candidateB: candidateBExecution.log,
        postApply: postApplyExecution.log,
        build: buildCheck,
        typecheck: typecheckCheck
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
