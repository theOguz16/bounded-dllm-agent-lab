#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
const decisionUrl = pathToFileURL(
  path.join(projectRoot, "dist/apps/cli/src/human-decision.js")
).href;

const { sourceOriginal, sourceChanged, createRepository, fakeDiscoveryAdapter, fakeExecutionAdapter } =
  require("./codex-v1-fixture.cjs");
const { createTrustedChecker, materializeCandidate, executeAcceptance } =
  require("./codex-v1-trusted-host.cjs");
const sourceWrong = sourceChanged.replace("* 3", "* 4");

async function independentBehavior(repository, candidate, parent, variant, checker, evidenceDirectory) {
  if (variant === "missing") {
    return {
      validationExecuted: false,
      behaviorObserved: false,
      behaviorSatisfied: null,
      outcome: "unknown"
    };
  }
  const workspace = path.join(parent, `behavior-${variant}`);
  await materializeCandidate(repository, candidate, workspace);
  if (variant === "failed") {
    await fs.writeFile(path.join(workspace, "src/calculate.js"), sourceWrong, "utf8");
  }
  const checked = await executeAcceptance(checker, workspace, evidenceDirectory, variant);
  const verdict = checked.execution.verdict;
  return {
    validationExecuted: checked.log.exitCode !== null,
    behaviorObserved: verdict !== "infrastructure_fail",
    behaviorSatisfied: verdict === "infrastructure_fail" ? null : verdict === "pass",
    outcome: verdict === "infrastructure_fail" ? "unknown" : verdict === "pass" ? "successful" : "failed",
    evidenceHash: checked.execution.artifactHash
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
    const { repository } = await createRepository(parent, projectRoot, "codex-v1-core-e2e-fixture");
    const checker = await createTrustedChecker(parent);
    assert.equal(path.relative(repository, checker).startsWith(".."), true);
    const evidenceDirectory = path.join(parent, "trusted-evidence");
    await fs.mkdir(evidenceDirectory, { mode: 0o700 });
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

    const successful = await independentBehavior(repository, candidate, parent, "successful", checker, evidenceDirectory);
    const failed = await independentBehavior(repository, candidate, parent, "failed", checker, evidenceDirectory);
    const missing = await independentBehavior(repository, candidate, parent, "missing", checker, evidenceDirectory);
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
