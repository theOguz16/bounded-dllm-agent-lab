"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRepository, sourceChanged, fakeDiscoveryAdapter,
  fakeExecutionAdapter } = require("./codex-v1-fixture.cjs");
const { sha256, createTrustedChecker, executeAcceptance } = require("./codex-v1-trusted-host.cjs");

async function createCompareTrustedFixture(projectRoot) {
  const runtime = await import(pathToFileURL(path.join(projectRoot, "dist/packages/product-runtime/src/canonical-runtime.js")));
  const substrateModule = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/compare-validation-substrate.js")));
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bounded-compare-trusted-")));
  const { repository, sourceCommitSha } = await createRepository(parent, projectRoot, "bounded-compare-trusted-fixture");
  const checker = await createTrustedChecker(parent);
  const evidenceDirectory = path.join(parent, "trusted-evidence");
  const dependencyRoot = path.join(parent, "node_modules");
  await fs.mkdir(evidenceDirectory);
  await fs.mkdir(dependencyRoot);
  const snapshot = (workspace) => runtime.createCanonicalRepositoryContentSnapshot(workspace).snapshotHash;
  const sourceTreeHash = snapshot(repository);
  const criterion = {
    criterionId: "calculate.multiplies-by-three",
    checkHash: sha256(await fs.readFile(checker))
  };
  const catalogHash = runtime.hashCanonicalJson({ version: "bounded-compare-trusted/v1", criteria: [criterion] });
  const hostKey = crypto.randomBytes(32);
  const counters = { discovery: 0, execution: 0, baseline: 0, trusted: 0 };
  const discoveryAdapter = fakeDiscoveryAdapter(repository, counters);
  const executionAdapter = fakeExecutionAdapter(repository, counters);
  const adapter = {
    agentId: "codex", agentVersion: "offline-compare/v1",
    async run(request) {
      if (request.mode === "discovery") return discoveryAdapter.run(request);
      if (request.mode === "baseline") {
        counters.baseline += 1;
        assert.equal(request.networkAllowed, false);
        await fs.writeFile(path.join(request.workingDirectory, "src/calculate.js"), sourceChanged);
        return {
          status: "completed", agentId: "codex", agentVersion: "offline-compare/v1",
          modelId: "fixture-model", durationMs: 1, finalMessage: "fixture baseline",
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, totalTokens: 20, toolCalls: null },
          commands: [], fileChanges: [{ sequence: 1, path: "src/calculate.js", operation: "modify" }], diagnostics: []
        };
      }
      return executionAdapter.run(request);
    }
  };
  const prepareValidationSubstrate = async () => ({
    version: substrateModule.COMPARE_VALIDATION_SUBSTRATE_VERSION,
    image: substrateModule.COMPARE_VALIDATION_IMAGE,
    dependencyRoot,
    dependencySnapshotHash: runtime.hashCanonicalJson("empty-fixture-dependencies"),
    prepared: false
  });
  const copySource = async (target) => fs.cp(repository, target, {
    recursive: true,
    filter: (source) => ![".git", "node_modules"].includes(path.basename(source))
  });
  let firstReceipt = null;
  let issuedReceipt = null;
  let observedCandidateTreeHash = null;
  async function trustedBehavior(variant, { workspacePath, candidateTreeHash, taskId, taskHash,
    sourceCommitSha: observedCommit, sourceTreeHash: observedSourceHash }) {
    counters.trusted += 1;
    observedCandidateTreeHash = candidateTreeHash;
    assert.equal(observedCommit, sourceCommitSha);
    assert.equal(observedSourceHash, sourceTreeHash);
    assert.equal(snapshot(workspacePath), candidateTreeHash);
    assert.equal(await fs.readFile(path.join(workspacePath, "src/calculate.js"), "utf8"), sourceChanged);
    const reference = path.join(parent, `reference-${variant}`);
    const wrong = path.join(parent, `wrong-${variant}`);
    await copySource(reference);
    await copySource(wrong);
    await fs.writeFile(path.join(reference, "src/calculate.js"), sourceChanged);
    await fs.writeFile(path.join(wrong, "src/calculate.js"), sourceChanged.replace("* 3", "* 4"));
    const sourceCheck = await executeAcceptance(checker, repository, evidenceDirectory, `${variant}-source`, snapshot);
    const referenceCheck = await executeAcceptance(checker, reference, evidenceDirectory, `${variant}-reference`, snapshot);
    const wrongCheck = await executeAcceptance(checker, wrong, evidenceDirectory, `${variant}-wrong`, snapshot);
    const candidateCheck = await executeAcceptance(checker, workspacePath, evidenceDirectory, `${variant}-candidate`, snapshot);
    assert.deepEqual([sourceCheck.execution.verdict, referenceCheck.execution.verdict,
      wrongCheck.execution.verdict, candidateCheck.execution.verdict],
    ["assertion_fail", "pass", "assertion_fail", "pass"]);
    let candidateForReceipt = candidateCheck;
    if (variant === "wrong_candidate") {
      const otherCandidate = path.join(parent, "other-candidate");
      await copySource(otherCandidate);
      await fs.writeFile(path.join(otherCandidate, "src/calculate.js"), `${sourceChanged}// different candidate\n`);
      candidateForReceipt = await executeAcceptance(checker, otherCandidate, evidenceDirectory,
        "other-candidate", snapshot);
      assert.equal(candidateForReceipt.execution.verdict, "pass");
      assert.notEqual(candidateForReceipt.execution.workspaceHash, candidateTreeHash);
    }
    const expectation = {
      referenceCommitSha: sourceCommitSha,
      referenceTreeHash: referenceCheck.execution.workspaceHash,
      wrongTreeHash: wrongCheck.execution.workspaceHash,
      catalogHash, requiredCriteria: [criterion]
    };
    const receipt = runtime.sealTrustedBehaviorEvidence({
      receiptVersion: "trusted-behavior-evidence/v2", taskId, taskHash,
      sourceCommitSha, sourceTreeHash: observedSourceHash,
      referenceCommitSha: sourceCommitSha,
      referenceTreeHash: expectation.referenceTreeHash,
      wrongTreeHash: expectation.wrongTreeHash,
      candidateTreeHash: candidateForReceipt.execution.workspaceHash,
      catalogHash, issuedAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex"),
      criteria: [{ ...criterion, source: sourceCheck.execution,
        reference: referenceCheck.execution, wrong: wrongCheck.execution,
        candidate: candidateForReceipt.execution }]
    }, hostKey);
    issuedReceipt = receipt;
    if (variant === "valid") firstReceipt = receipt;
    return { expectation, hostKey,
      receipt: variant === "missing" ? null : variant === "corrupt" ? { ...receipt, seal: "invalid" } : receipt };
  }
  return {
    parent, repository, sourceCommitSha, sourceTreeHash, evidenceDirectory,
    adapter, prepareValidationSubstrate, trustedBehavior, snapshot, counters,
    firstReceipt: () => firstReceipt,
    issuedReceipt: () => issuedReceipt,
    observedCandidateTreeHash: () => observedCandidateTreeHash
  };
}

module.exports = { createCompareTrustedFixture };
