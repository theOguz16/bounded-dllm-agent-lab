#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "X4 Fixture",
  GIT_AUTHOR_EMAIL: "x4@example.invalid",
  GIT_COMMITTER_NAME: "X4 Fixture",
  GIT_COMMITTER_EMAIL: "x4@example.invalid"
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

function write(root, file, content, mode) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function snapshotGit(root) {
  const gitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    index: fs.readFileSync(path.resolve(root, gitDir, "index")).toString("hex"),
    refs: git(root, ["show-ref"]),
    config: fs.readFileSync(path.resolve(root, gitDir, "config")).toString("hex"),
    tags: git(root, ["tag", "--list"])
  };
}

function deepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child, seen);
}

async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_REPOSITORY_APPLY_VERSION,
    DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY,
    buildControlledApplyHandoff,
    computeGovernedMutationHash,
    evaluateControlledApplyExecutionGate,
    executeControlledRepositoryApply,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    verifyControlledRepositoryApplyReceipt
  } = runtime;
  const roots = [];
  let checks = 0;
  const check = (name, fn) => { fn(); checks += 1; console.log(`[ok] ${name}`); };
  const clone = (value) => structuredClone(value);
  const hash = (label) => hashCanonicalJson({ label });

  function artifactFor(mode, mutation, changedFiles) {
    const model = mode === "always";
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash: computeGovernedMutationHash("repair_draft", mutation),
        changedFiles: [...changedFiles],
        patchDryRunResultHash: hash(`${mode}:dry-run`),
        temporaryApplyResultHash: hash(`${mode}:temp-apply`),
        executionVerificationResultHash: hash(`${mode}:execution`),
        stageEvents: {
          mutationSourceEventId: "run:event:000005",
          patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008",
          executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010",
          deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012",
          adminAgentEventId: model ? "run:event:000013" : null,
          approvalRouterEventId: model ? "run:event:000014" : "run:event:000013"
        }
      },
      evidence: {
        runId: `x4-${mode}-${Math.random()}`,
        objectiveHash: hash(`${mode}:objective`),
        preShadowLedgerRootHash: hash(`${mode}:pre-root`),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash(`${mode}:trace`),
        observationHash: hash(`${mode}:observation`),
        governanceHash: hash(`${mode}:governance`),
        adminInvocationPolicyHash: hash(`${mode}:invocation-policy`),
        adminInvocationAssessmentHash: hash(`${mode}:invocation-assessment`),
        adminDecisionHash: model ? hash(`${mode}:admin`) : null,
        routeHash: hash(`${mode}:route`),
        governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy-v2"),
        finalLedgerRootHash: hash(`${mode}:final-root`),
        finalLedgerEventCount: model ? 14 : 13
      },
      decisions: {
        phaseVFinalDecision: "temp_validation_passed",
        shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid",
        governanceDecision: "governance_passed",
        adminInvocationMode: mode,
        adminInvocationDecision: model ? "admin_invocation_required" : "admin_invocation_skipped",
        adminInvocationSkipKind: model ? null : "clean_path",
        adminResolutionKind: model ? "model_decision" : "verified_policy_skip",
        adminStageDecision: model ? "admin_agent_completed" : "admin_skipped_by_policy",
        adminValidationDecision: model ? "admin_decision_valid" : null,
        adminDecision: model ? "admin_auto_approved" : null,
        routerValidationDecision: "approval_route_valid",
        workflowRoute: "auto_continue"
      },
      applyEligibility: { eligible: true, reasonCodes: [] }
    };
    return { ...material, governedArtifactHash: hashCanonicalJson(material) };
  }

  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash: artifact.change.executionVerificationResultHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash,
      governanceHash: artifact.evidence.governanceHash,
      adminInvocationPolicyHash: artifact.evidence.adminInvocationPolicyHash,
      adminInvocationAssessmentHash: artifact.evidence.adminInvocationAssessmentHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash,
      routeHash: artifact.evidence.routeHash,
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }

  async function fixture({
    mode = "conditional",
    tracked = { "src/a.txt": { content: "X4_SOURCE_SENTINEL\n", mode: 0o644 } },
    proposed = { "src/a.txt": "X4_APPLIED_SENTINEL\n" },
    claimExtras = {}
  } = {}) {
    const repositoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x4-repo-")));
    const bundleParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x4-bundle-")));
    const registryDirectoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x4-registry-")));
    roots.push(repositoryPath, bundleParent, registryDirectoryPath);
    git(repositoryPath, ["init", "--quiet"]);
    for (const [file, value] of Object.entries(tracked)) {
      write(repositoryPath, file, value.content, value.mode);
      git(repositoryPath, ["add", "--", file]);
    }
    git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
    const changedFiles = Object.keys(proposed).sort();
    const mutation = {
      role: "remask", target: "repairDraft", summary: "X4_MUTATION_SENTINEL",
      claims: changedFiles.map((file) => ({
        type: "repair_draft", file, proposedPatch: proposed[file], ...(claimExtras[file] ?? {})
      })),
      touchedFiles: [...changedFiles], confidence: 0.9
    };
    const inspected = await inspectControlledRepository({ repositoryPath, changedFiles });
    assert.equal(inspected.decision, "repository_inspection_ready");
    const artifact = artifactFor(mode, mutation, changedFiles);
    const currentFreshnessSnapshot = freshnessFrom(artifact);
    const handoffResult = buildControlledApplyHandoff({
      artifact, currentFreshnessSnapshot, mutation, target: inspected.inspection.target
    });
    assert.equal(handoffResult.decision, "controlled_apply_handoff_ready");
    const bundleDirectoryPath = path.join(bundleParent, "bundle");
    const bundled = await materializeControlledRollbackBundle({
      repositoryPath, bundleDirectoryPath, changedFiles,
      expectedInspection: inspected.inspection, handoff: handoffResult.handoff,
      artifact, currentFreshnessSnapshot, mutation, consumptionStatus: "not_consumed"
    });
    assert.equal(bundled.decision, "rollback_bundle_ready", JSON.stringify(bundled));
    const gateInput = {
      repositoryPath, bundleDirectoryPath, changedFiles, artifact,
      currentFreshnessSnapshot, mutation, handoff: handoffResult.handoff,
      expectedInspection: inspected.inspection,
      rollbackBundleManifest: bundled.manifest,
      rollbackBundleReceipt: bundled.receipt,
      consumptionStatus: "not_consumed"
    };
    const gated = await evaluateControlledApplyExecutionGate(gateInput);
    assert.equal(gated.decision, "controlled_apply_execution_gate_ready", JSON.stringify(gated));
    return { gateInput, authorization: gated.authorization, registryDirectoryPath, proposed };
  }

  function execute(value, extra = {}) {
    return executeControlledRepositoryApply({
      authorization: value.authorization,
      gateInput: value.gateInput,
      registryDirectoryPath: value.registryDirectoryPath,
      ...extra
    });
  }

  try {
    const basic = await fixture();
    const inputBefore = clone(basic);
    const gitBefore = snapshotGit(basic.gateInput.repositoryPath);
    const result = await execute(basic);
    check("clean W.17 policy-skip authorization applies and commits durable evidence", () => {
      assert.equal(CONTROLLED_REPOSITORY_APPLY_VERSION, "1");
      assert.equal(result.decision, "controlled_repository_apply_succeeded",
        JSON.stringify(result));
      assert.equal(result.receipt.outcome, "applied");
      assert.equal(result.receipt.governedArtifactHash, basic.authorization.governedArtifactHash);
      assert.equal(basic.authorization.adminResolution.adminDecisionHash, null);
      assert.equal(result.summary.consumptionClaimCreated, true);
      assert.equal(result.summary.terminalRegistryMarker, "COMMITTED");
      assert.equal(result.summary.postApplyValidationExecuted, false);
      assert.equal(fs.readFileSync(path.join(basic.gateInput.repositoryPath, "src/a.txt"), "utf8"),
        basic.proposed["src/a.txt"]);
      deepFrozen(result);
    });
    const claim = path.join(
      basic.registryDirectoryPath, "claims", basic.authorization.consumptionKey.slice(7)
    );
    check("claim ordering and canonical durable registry layout are complete", () => {
      for (const name of [
        "reservation.json", "transaction.json", "WRITE_STARTED", "steps",
        "apply-receipt.json", "COMMITTED"
      ]) assert.equal(fs.existsSync(path.join(claim, name)), true, name);
      assert.equal(fs.existsSync(path.join(claim, "ROLLED_BACK")), false);
      assert.deepEqual(clone(basic), inputBefore);
    });
    check("Git index and history metadata remain unchanged", () => {
      assert.deepEqual(snapshotGit(basic.gateInput.repositoryPath), gitBefore);
    });

    const verified = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: basic.gateInput.repositoryPath,
      registryDirectoryPath: basic.registryDirectoryPath,
      receipt: result.receipt,
      authorization: basic.authorization,
      expectedInspection: basic.gateInput.expectedInspection
    });
    check("successful apply receipt verifies current without writes", () => {
      assert.equal(verified.decision, "controlled_repository_apply_receipt_current",
        JSON.stringify(verified));
      assert.equal(verified.repositoryStateMatched, true);
      deepFrozen(verified);
    });

    const duplicate = await execute(basic);
    check("a changed repository cannot reuse a permanently consumed authorization", () => {
      assert.equal(duplicate.decision, "controlled_repository_apply_blocked");
      assert.equal(duplicate.summary.repositoryWritePerformed, false);
      assert.equal(duplicate.summary.consumptionClaimPreviouslyExisted, false);
    });

    const existingStates = ["COMMITTED", "ROLLED_BACK", "ROLLBACK_FAILED", null];
    const existingResults = [];
    for (const marker of existingStates) {
      const existing = await fixture();
      const claimPath = path.join(
        existing.registryDirectoryPath, "claims", existing.authorization.consumptionKey.slice(7)
      );
      fs.mkdirSync(claimPath, { recursive: true, mode: 0o700 });
      if (marker) fs.writeFileSync(path.join(claimPath, marker), "", { mode: 0o600 });
      existingResults.push(await execute(existing));
    }
    check("committed, rolled-back, unsafe, and incomplete claims all block reuse", () => {
      for (const existing of existingResults) {
        assert.equal(existing.decision, "controlled_repository_apply_blocked");
        assert.equal(existing.summary.consumptionClaimPreviouslyExisted, true);
        assert.equal(existing.summary.repositoryWritePerformed, false);
      }
    });

    const concurrent = await fixture();
    const concurrentResults = await Promise.all([execute(concurrent), execute(concurrent)]);
    check("exclusive mkdir permits exactly one concurrent claimant", () => {
      assert.equal(concurrentResults.filter((entry) =>
        entry.decision === "controlled_repository_apply_succeeded").length, 1);
      assert.equal(concurrentResults.filter((entry) =>
        entry.decision === "controlled_repository_apply_blocked").length, 1);
      assert.equal(concurrentResults.filter((entry) => entry.summary.consumptionClaimCreated).length,
        1);
    });

    const postClaimDrift = await fixture();
    const driftClaim = path.join(
      postClaimDrift.registryDirectoryPath, "claims",
      postClaimDrift.authorization.consumptionKey.slice(7)
    );
    const driftPromise = execute(postClaimDrift);
    await waitForFile(driftClaim);
    fs.writeFileSync(path.join(postClaimDrift.gateInput.repositoryPath, "post-claim-drift.txt"),
      "drift");
    const postClaimDriftResult = await driftPromise;
    check("repository drift after claim blocks before WRITE_STARTED", () => {
      assert.equal(postClaimDriftResult.decision, "controlled_repository_apply_blocked");
      assert.equal(postClaimDriftResult.summary.consumptionClaimCreated, true);
      assert.equal(postClaimDriftResult.summary.repositoryWritePerformed, false);
      assert.equal(fs.existsSync(path.join(driftClaim, "WRITE_STARTED")), false);
    });

    const symlinkRace = await fixture({
      tracked: { "src/a.txt": { content: "baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "changed\n" }
    });
    const externalTarget = path.join(os.tmpdir(), `x4-external-${process.pid}-${Date.now()}`);
    fs.writeFileSync(externalTarget, "EXTERNAL_SENTINEL");
    roots.push(externalTarget);
    const symlinkClaim = path.join(
      symlinkRace.registryDirectoryPath, "claims", symlinkRace.authorization.consumptionKey.slice(7)
    );
    const symlinkPromise = execute(symlinkRace);
    await waitForFile(path.join(symlinkClaim, "transaction.json"));
    const symlinkPath = path.join(symlinkRace.gateInput.repositoryPath, "src/a.txt");
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(externalTarget, symlinkPath);
    const symlinkRaceResult = await symlinkPromise;
    check("a target symlink swap is never followed", () => {
      assert.ok([
        "controlled_repository_apply_blocked", "controlled_repository_apply_rolled_back"
      ].includes(symlinkRaceResult.decision), JSON.stringify(symlinkRaceResult));
      assert.equal(fs.readFileSync(externalTarget, "utf8"), "EXTERNAL_SENTINEL");
      assert.notEqual(symlinkRaceResult.decision, "controlled_repository_apply_succeeded");
    });

    const parentRace = await fixture({
      tracked: { "src/sub/a.txt": { content: "parent-baseline\n", mode: 0o644 } },
      proposed: { "src/sub/a.txt": "parent-changed\n" }
    });
    const parentExternal = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x4-parent-")));
    roots.push(parentExternal);
    fs.writeFileSync(path.join(parentExternal, "a.txt"), "PARENT_EXTERNAL_SENTINEL");
    const parentClaim = path.join(
      parentRace.registryDirectoryPath, "claims", parentRace.authorization.consumptionKey.slice(7)
    );
    const parentPromise = execute(parentRace);
    await waitForFile(path.join(parentClaim, "transaction.json"));
    const originalParent = path.join(parentRace.gateInput.repositoryPath, "src/sub");
    fs.renameSync(originalParent, `${originalParent}-moved`);
    fs.symlinkSync(parentExternal, originalParent);
    const parentRaceResult = await parentPromise;
    check("a parent-directory symlink swap is rejected without external writes", () => {
      assert.ok([
        "controlled_repository_apply_blocked", "controlled_repository_apply_needs_review",
        "controlled_repository_apply_rolled_back"
      ].includes(parentRaceResult.decision), JSON.stringify(parentRaceResult));
      assert.notEqual(parentRaceResult.decision, "controlled_repository_apply_succeeded");
      assert.equal(fs.readFileSync(path.join(parentExternal, "a.txt"), "utf8"),
        "PARENT_EXTERNAL_SENTINEL");
    });

    const model = await fixture({ mode: "always" });
    const modelResult = await execute(model);
    check("model-backed Admin authorization follows the same controlled boundary", () => {
      assert.equal(modelResult.decision, "controlled_repository_apply_succeeded");
      assert.match(modelResult.receipt.mutation.mutationHash, /^sha256:/);
      assert.notEqual(modelResult.receipt.receiptHash, result.receipt.receiptHash);
    });

    const combined = await fixture({
      tracked: {
        "bin/tool.sh": { content: "#!/bin/sh\necho old\n", mode: 0o755 },
        "src/a.txt": { content: "old\n", mode: 0o644 }
      },
      proposed: {
        "bin/tool.sh": "#!/bin/sh\necho new\n",
        "src/a.txt": "new\n",
        "src/new.txt": "created\n"
      }
    });
    const combinedResult = await execute(combined);
    check("create, update, executable preservation, and deterministic multi-file order work", () => {
      assert.equal(combinedResult.decision, "controlled_repository_apply_succeeded",
        JSON.stringify(combinedResult));
      assert.equal(fs.statSync(path.join(combined.gateInput.repositoryPath, "bin/tool.sh")).mode & 0o777,
        0o755);
      assert.equal(fs.statSync(path.join(combined.gateInput.repositoryPath, "src/new.txt")).mode & 0o777,
        0o644);
      assert.deepEqual(combinedResult.receipt.after.appliedFiles.map((entry) => entry.filePath),
        ["bin/tool.sh", "src/a.txt", "src/new.txt"]);
    });

    const unsupportedResults = [];
    for (const extras of [
      { operation: "delete" }, { operation: "directory_delete" },
      { operation: "gitlink" }, { operation: "fifo" },
      { symlinkTarget: "outside" }, { mode: "100777" }
    ]) {
      const unsupported = await fixture({ claimExtras: { "src/a.txt": extras } });
      unsupportedResults.push(await execute(unsupported));
    }
    check("delete, directory, gitlink, FIFO, symlink, and mode transformations review", () => {
      for (const unsupported of unsupportedResults) {
        assert.equal(unsupported.decision, "controlled_repository_apply_needs_review");
        assert.equal(unsupported.summary.consumptionClaimCreated, false);
        assert.equal(unsupported.summary.repositoryWritePerformed, false);
      }
    });

    const exactBound = await fixture({ proposed: { "src/a.txt": "12345678" } });
    const exactBoundResult = await execute(exactBound, { maxMutationFileBytes: 8 });
    const aboveBound = await fixture({ proposed: { "src/a.txt": "123456789" } });
    const aboveBoundResult = await execute(aboveBound, { maxMutationFileBytes: 8 });
    const exactTotal = await fixture({
      tracked: {
        "src/a.txt": { content: "old-a", mode: 0o644 },
        "src/b.txt": { content: "old-b", mode: 0o644 }
      },
      proposed: { "src/a.txt": "1234", "src/b.txt": "5678" }
    });
    const exactTotalResult = await execute(exactTotal, { maxMutationTotalBytes: 8 });
    const aboveTotal = await fixture({
      tracked: {
        "src/a.txt": { content: "old-a", mode: 0o644 },
        "src/b.txt": { content: "old-b", mode: 0o644 }
      },
      proposed: { "src/a.txt": "1234", "src/b.txt": "56789" }
    });
    const aboveTotalResult = await execute(aboveTotal, { maxMutationTotalBytes: 8 });
    check("per-file and total byte limits accept equality and reject excess before claim", () => {
      assert.equal(exactBoundResult.decision, "controlled_repository_apply_succeeded");
      assert.equal(exactTotalResult.decision, "controlled_repository_apply_succeeded");
      assert.equal(aboveBoundResult.decision, "controlled_repository_apply_needs_review");
      assert.equal(aboveTotalResult.decision, "controlled_repository_apply_needs_review");
      assert.equal(aboveBoundResult.summary.consumptionClaimCreated, false);
      assert.equal(aboveTotalResult.summary.consumptionClaimCreated, false);
    });

    const large = "x".repeat(2 * 1024 * 1024);
    const rollbackFixture = await fixture({
      tracked: {
        "src/a.txt": { content: "baseline-a\n", mode: 0o644 },
        "src/z.txt": { content: "baseline-z\n", mode: 0o644 }
      },
      proposed: { "src/a.txt": large, "src/z.txt": large }
    });
    const rollbackClaim = path.join(
      rollbackFixture.registryDirectoryPath, "claims",
      rollbackFixture.authorization.consumptionKey.slice(7)
    );
    const rollbackExternal = path.join(os.tmpdir(), `x4-rollback-external-${Date.now()}`);
    fs.writeFileSync(rollbackExternal, "ROLLBACK_EXTERNAL_SENTINEL");
    roots.push(rollbackExternal);
    const rollbackPromise = execute(rollbackFixture);
    await waitForFile(path.join(rollbackClaim, "WRITE_STARTED"));
    const rollbackSecond = path.join(rollbackFixture.gateInput.repositoryPath, "src/z.txt");
    fs.unlinkSync(rollbackSecond);
    fs.symlinkSync(rollbackExternal, rollbackSecond);
    const rolledBack = await rollbackPromise;
    check("a post-WRITE_STARTED target race triggers exact emergency rollback", () => {
      assert.equal(rolledBack.decision, "controlled_repository_apply_rolled_back",
        JSON.stringify(rolledBack));
      assert.equal(rolledBack.summary.emergencyRollbackSucceeded, true);
      assert.equal(rolledBack.summary.terminalRegistryMarker, "ROLLED_BACK");
      assert.equal(fs.readFileSync(path.join(
        rollbackFixture.gateInput.repositoryPath, "src/a.txt"), "utf8"), "baseline-a\n");
      assert.equal(fs.readFileSync(path.join(
        rollbackFixture.gateInput.repositoryPath, "src/z.txt"), "utf8"), "baseline-z\n");
      assert.equal(fs.readFileSync(rollbackExternal, "utf8"), "ROLLBACK_EXTERNAL_SENTINEL");
    });
    const rollbackVerified = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: rollbackFixture.gateInput.repositoryPath,
      registryDirectoryPath: rollbackFixture.registryDirectoryPath,
      receipt: rolledBack.receipt,
      authorization: rollbackFixture.authorization,
      expectedInspection: rollbackFixture.gateInput.expectedInspection
    });
    check("rolled-back receipt proves the exact original baseline", () => {
      assert.equal(rollbackVerified.decision, "controlled_repository_apply_receipt_current",
        JSON.stringify(rollbackVerified));
      assert.equal(rollbackVerified.summary.restoredBaselineMatched, true);
    });

    const stepFailureFixture = await fixture({
      tracked: { "src/a.txt": { content: "step-baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "s".repeat(8 * 1024 * 1024) }
    });
    const stepFailureClaim = path.join(
      stepFailureFixture.registryDirectoryPath, "claims",
      stepFailureFixture.authorization.consumptionKey.slice(7)
    );
    const stepFailurePromise = execute(stepFailureFixture);
    await waitForFile(path.join(stepFailureClaim, "WRITE_STARTED"));
    fs.writeFileSync(path.join(stepFailureClaim, "steps/000000.json"), "{}", { mode: 0o600 });
    const stepFailureResult = await stepFailurePromise;
    check("step-record persistence failure after a write forces emergency rollback", () => {
      assert.equal(stepFailureResult.decision, "controlled_repository_apply_rolled_back",
        JSON.stringify(stepFailureResult));
      assert.equal(stepFailureResult.summary.emergencyRollbackExecuted, true);
      assert.equal(stepFailureResult.summary.emergencyRollbackSucceeded, true);
      assert.equal(fs.readFileSync(path.join(
        stepFailureFixture.gateInput.repositoryPath, "src/a.txt"), "utf8"),
        "step-baseline\n");
    });

    const afterMismatchFixture = await fixture({
      tracked: { "src/a.txt": { content: "mismatch-baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "m".repeat(8 * 1024 * 1024) }
    });
    const mismatchClaim = path.join(
      afterMismatchFixture.registryDirectoryPath, "claims",
      afterMismatchFixture.authorization.consumptionKey.slice(7)
    );
    const mismatchTarget = path.join(afterMismatchFixture.gateInput.repositoryPath, "src/a.txt");
    const mismatchPromise = execute(afterMismatchFixture);
    await waitForFile(path.join(mismatchClaim, "WRITE_STARTED"));
    const mismatchStarted = Date.now();
    while (fs.statSync(mismatchTarget).size !== 8 * 1024 * 1024) {
      if (Date.now() - mismatchStarted > 5000) throw new Error("after-state race timeout");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fs.writeFileSync(mismatchTarget, "wrong after state");
    const afterMismatchResult = await mismatchPromise;
    check("an immediate actual-after-state mismatch triggers verified rollback", () => {
      assert.equal(afterMismatchResult.decision, "controlled_repository_apply_rolled_back",
        JSON.stringify(afterMismatchResult));
      assert.ok(afterMismatchResult.issues.some((entry) =>
        entry.code === "controlled_repository_apply_after_state_mismatch"));
      assert.equal(fs.readFileSync(mismatchTarget, "utf8"), "mismatch-baseline\n");
    });

    const unexpectedFixture = await fixture({
      tracked: { "src/a.txt": { content: "scope-baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "u".repeat(8 * 1024 * 1024) }
    });
    const unexpectedClaim = path.join(
      unexpectedFixture.registryDirectoryPath, "claims",
      unexpectedFixture.authorization.consumptionKey.slice(7)
    );
    const unexpectedPromise = execute(unexpectedFixture);
    await waitForFile(path.join(unexpectedClaim, "WRITE_STARTED"));
    fs.writeFileSync(path.join(unexpectedFixture.gateInput.repositoryPath, "unexpected.txt"),
      "external concurrent change");
    const unexpectedResult = await unexpectedPromise;
    check("an unexpected worktree change triggers rollback and unsafe recovery status", () => {
      assert.equal(unexpectedResult.decision, "controlled_repository_apply_rollback_failed",
        JSON.stringify(unexpectedResult));
      assert.equal(unexpectedResult.summary.emergencyRollbackExecuted, true);
      assert.equal(unexpectedResult.summary.emergencyRollbackSucceeded, false);
      assert.equal(unexpectedResult.summary.terminalRegistryMarker, "ROLLBACK_FAILED");
      assert.equal(fs.existsSync(path.join(unexpectedFixture.gateInput.repositoryPath,
        "unexpected.txt")), true);
    });

    const operationStateFixture = await fixture({
      tracked: { "src/a.txt": { content: "operation-baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "o".repeat(8 * 1024 * 1024) }
    });
    const operationClaim = path.join(
      operationStateFixture.registryDirectoryPath, "claims",
      operationStateFixture.authorization.consumptionKey.slice(7)
    );
    const operationPromise = execute(operationStateFixture);
    await waitForFile(path.join(operationClaim, "WRITE_STARTED"));
    const gitDirectory = git(operationStateFixture.gateInput.repositoryPath,
      ["rev-parse", "--git-dir"]).trim();
    fs.writeFileSync(path.resolve(
      operationStateFixture.gateInput.repositoryPath, gitDirectory, "MERGE_HEAD"
    ), `${git(operationStateFixture.gateInput.repositoryPath, ["rev-parse", "HEAD"]).trim()}\n`);
    const operationStateResult = await operationPromise;
    check("a Git operation state appearing during apply prevents success and requires recovery", () => {
      assert.equal(operationStateResult.decision,
        "controlled_repository_apply_rollback_failed", JSON.stringify(operationStateResult));
      assert.equal(operationStateResult.summary.terminalRegistryMarker, "ROLLBACK_FAILED");
      assert.equal(operationStateResult.summary.gitIndexMutated, false);
      assert.equal(operationStateResult.summary.gitHistoryMutated, false);
    });

    const stagedFixture = await fixture({
      tracked: { "src/a.txt": { content: "staged-baseline\n", mode: 0o644 } },
      proposed: { "src/a.txt": "g".repeat(8 * 1024 * 1024) }
    });
    const stagedClaim = path.join(
      stagedFixture.registryDirectoryPath, "claims", stagedFixture.authorization.consumptionKey.slice(7)
    );
    const stagedTarget = path.join(stagedFixture.gateInput.repositoryPath, "src/a.txt");
    const stagedPromise = execute(stagedFixture);
    await waitForFile(path.join(stagedClaim, "WRITE_STARTED"));
    const stagedStarted = Date.now();
    while (fs.statSync(stagedTarget).size !== 8 * 1024 * 1024) {
      if (Date.now() - stagedStarted > 5000) throw new Error("staged-state race timeout");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    git(stagedFixture.gateInput.repositoryPath, ["add", "--", "src/a.txt"]);
    const stagedResult = await stagedPromise;
    check("staged state appearing during apply is rejected without X.4 index mutation", () => {
      assert.equal(stagedResult.decision, "controlled_repository_apply_rollback_failed",
        JSON.stringify(stagedResult));
      assert.equal(stagedResult.summary.gitIndexMutated, false);
      assert.equal(stagedResult.summary.gitHistoryMutated, false);
      assert.match(git(stagedFixture.gateInput.repositoryPath, ["status", "--porcelain"]), /^M/m);
    });

    const rollbackFailureFixture = await fixture({
      tracked: {
        "src/a.txt": { content: "baseline-a\n", mode: 0o644 },
        "src/z.txt": { content: "baseline-z\n", mode: 0o644 }
      },
      proposed: { "src/a.txt": large, "src/z.txt": large }
    });
    const failureClaim = path.join(
      rollbackFailureFixture.registryDirectoryPath, "claims",
      rollbackFailureFixture.authorization.consumptionKey.slice(7)
    );
    const failureExternal = path.join(os.tmpdir(), `x4-failure-external-${Date.now()}`);
    fs.writeFileSync(failureExternal, "FAILURE_EXTERNAL_SENTINEL");
    roots.push(failureExternal);
    const rollbackFailurePromise = execute(rollbackFailureFixture);
    await waitForFile(path.join(failureClaim, "WRITE_STARTED"));
    const failureSecond = path.join(rollbackFailureFixture.gateInput.repositoryPath, "src/z.txt");
    fs.unlinkSync(failureSecond);
    fs.symlinkSync(failureExternal, failureSecond);
    const firstRollbackEntry = rollbackFailureFixture.gateInput.rollbackBundleManifest.entries
      .find((entry) => entry.filePath === "src/a.txt");
    fs.unlinkSync(path.join(
      rollbackFailureFixture.gateInput.bundleDirectoryPath, firstRollbackEntry.payloadRelativePath
    ));
    const rollbackFailed = await rollbackFailurePromise;
    check("tampered rollback material produces ROLLBACK_FAILED without false safety", () => {
      assert.equal(rollbackFailed.decision, "controlled_repository_apply_rollback_failed",
        JSON.stringify(rollbackFailed));
      assert.equal(rollbackFailed.summary.emergencyRollbackSucceeded, false);
      assert.equal(rollbackFailed.summary.terminalRegistryMarker, "ROLLBACK_FAILED");
      assert.equal(fs.existsSync(path.join(failureClaim, "COMMITTED")), false);
      assert.equal(fs.readFileSync(failureExternal, "utf8"), "FAILURE_EXTERNAL_SENTINEL");
    });
    const recoveryVerification = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: rollbackFailureFixture.gateInput.repositoryPath,
      registryDirectoryPath: rollbackFailureFixture.registryDirectoryPath,
      receipt: rollbackFailed.receipt,
      authorization: rollbackFailureFixture.authorization,
      expectedInspection: rollbackFailureFixture.gateInput.expectedInspection
    });
    check("rollback-failed receipt always requires recovery", () => {
      assert.equal(recoveryVerification.decision,
        "controlled_repository_apply_receipt_requires_recovery");
      assert.equal(recoveryVerification.summary.recoveryRequired, true);
    });

    const missingParent = await fixture({ proposed: { "missing/new.txt": "new\n" } });
    const missingParentResult = await execute(missingParent);
    check("missing parent directory requires review before claim and write", () => {
      assert.equal(missingParentResult.decision, "controlled_repository_apply_needs_review");
      assert.equal(missingParentResult.summary.consumptionClaimCreated, false);
      assert.equal(fs.existsSync(path.join(missingParent.gateInput.repositoryPath, "missing")), false);
    });

    const stale = await fixture();
    fs.writeFileSync(path.join(stale.gateInput.repositoryPath, "drift.txt"), "drift");
    const staleResult = await execute(stale);
    check("stale authorization creates no claim and performs no write", () => {
      assert.equal(staleResult.decision, "controlled_repository_apply_blocked");
      assert.equal(staleResult.summary.consumptionClaimCreated, false);
      assert.equal(staleResult.summary.repositoryWritePerformed, false);
    });

    const staleSurfaceResults = [];
    const mutationStale = await fixture();
    mutationStale.gateInput.mutation.summary = "changed mutation";
    staleSurfaceResults.push(await execute(mutationStale));
    const handoffStale = await fixture();
    handoffStale.gateInput.handoff = clone(handoffStale.gateInput.handoff);
    handoffStale.gateInput.handoff.handoffHash = hash("tampered handoff");
    staleSurfaceResults.push(await execute(handoffStale));
    const authorizationStale = await fixture();
    authorizationStale.authorization = clone(authorizationStale.authorization);
    authorizationStale.authorization.authorizationHash = hash("tampered authorization");
    staleSurfaceResults.push(await execute(authorizationStale));
    const bundleStale = await fixture();
    const bundleObject = fs.readdirSync(path.join(
      bundleStale.gateInput.bundleDirectoryPath, "objects"
    ))[0];
    fs.writeFileSync(path.join(
      bundleStale.gateInput.bundleDirectoryPath, "objects", bundleObject
    ), "tampered rollback payload");
    staleSurfaceResults.push(await execute(bundleStale));
    check("mutation, handoff, authorization, and physical bundle drift create no claim", () => {
      for (const surface of staleSurfaceResults) {
        assert.notEqual(surface.decision, "controlled_repository_apply_succeeded");
        assert.equal(surface.summary.consumptionClaimCreated, false);
        assert.equal(surface.summary.repositoryWritePerformed, false);
      }
    });

    const staleUnsupported = await fixture({
      claimExtras: { "src/a.txt": { operation: "delete" } }
    });
    fs.writeFileSync(path.join(staleUnsupported.gateInput.repositoryPath, "drift.txt"), "drift");
    const reviewPrecedence = await execute(staleUnsupported);
    const staleInvalidRegistry = await fixture();
    fs.writeFileSync(path.join(staleInvalidRegistry.gateInput.repositoryPath, "drift.txt"), "drift");
    const invalidRegistryPath = path.join(staleInvalidRegistry.gateInput.repositoryPath, "registry");
    fs.mkdirSync(invalidRegistryPath, { mode: 0o700 });
    const invalidPrecedence = await execute(staleInvalidRegistry, {
      registryDirectoryPath: invalidRegistryPath
    });
    check("pre-write precedence is invalid over needs-review over blocked", () => {
      assert.equal(reviewPrecedence.decision, "controlled_repository_apply_needs_review");
      assert.equal(invalidPrecedence.decision, "controlled_repository_apply_invalid");
      assert.equal(reviewPrecedence.summary.consumptionClaimCreated, false);
      assert.equal(invalidPrecedence.summary.consumptionClaimCreated, false);
    });

    const insideRegistry = await fixture();
    const unsafeRegistry = path.join(insideRegistry.gateInput.repositoryPath, "registry");
    fs.mkdirSync(unsafeRegistry, { mode: 0o700 });
    const insideResult = await execute(insideRegistry, { registryDirectoryPath: unsafeRegistry });
    check("registry inside repository is invalid before claim", () => {
      assert.equal(insideResult.decision, "controlled_repository_apply_invalid");
      assert.equal(insideResult.summary.repositoryWritePerformed, false);
    });

    const receiptTamper = clone(result.receipt);
    receiptTamper.receiptHash = hash("tampered-receipt");
    const tamperedVerification = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: basic.gateInput.repositoryPath,
      registryDirectoryPath: basic.registryDirectoryPath,
      receipt: receiptTamper,
      authorization: basic.authorization,
      expectedInspection: basic.gateInput.expectedInspection
    });
    check("receipt tampering is invalid", () => {
      assert.equal(tamperedVerification.decision,
        "controlled_repository_apply_receipt_invalid");
    });

    async function verifyRegistryCopy(label, mutate) {
      const copyParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `x4-${label}-`)));
      roots.push(copyParent);
      const registryDirectoryPath = path.join(copyParent, "registry");
      fs.cpSync(basic.registryDirectoryPath, registryDirectoryPath, { recursive: true });
      fs.chmodSync(registryDirectoryPath, 0o700);
      const copiedClaim = path.join(
        registryDirectoryPath, "claims", basic.authorization.consumptionKey.slice(7)
      );
      mutate(copiedClaim);
      return verifyControlledRepositoryApplyReceipt({
        repositoryPath: basic.gateInput.repositoryPath, registryDirectoryPath,
        receipt: result.receipt, authorization: basic.authorization,
        expectedInspection: basic.gateInput.expectedInspection
      });
    }
    const reservationTamper = await verifyRegistryCopy("reservation-tamper", (copiedClaim) => {
      fs.appendFileSync(path.join(copiedClaim, "reservation.json"), "\n");
    });
    const transactionTamper = await verifyRegistryCopy("transaction-tamper", (copiedClaim) => {
      fs.appendFileSync(path.join(copiedClaim, "transaction.json"), "\n");
    });
    const stepTamper = await verifyRegistryCopy("step-tamper", (copiedClaim) => {
      fs.appendFileSync(path.join(copiedClaim, "steps/000000.json"), "\n");
    });
    const markerTamper = await verifyRegistryCopy("marker-tamper", (copiedClaim) => {
      fs.writeFileSync(path.join(copiedClaim, "ROLLED_BACK"), "", { mode: 0o600 });
    });
    const unexpectedRegistry = await verifyRegistryCopy("unexpected-registry", (copiedClaim) => {
      fs.writeFileSync(path.join(copiedClaim, "unexpected.txt"), "unexpected", { mode: 0o600 });
    });
    check("reservation, transaction, step, terminal, and layout tampering fail closed", () => {
      for (const verification of [
        reservationTamper, transactionTamper, stepTamper, markerTamper, unexpectedRegistry
      ]) assert.equal(verification.decision,
        "controlled_repository_apply_receipt_invalid", JSON.stringify(verification));
    });

    const incompleteVerification = await verifyRegistryCopy("incomplete", (copiedClaim) => {
      fs.unlinkSync(path.join(copiedClaim, "COMMITTED"));
    });
    check("an incomplete durable claim requires recovery and is never reusable", () => {
      assert.equal(incompleteVerification.decision,
        "controlled_repository_apply_receipt_requires_recovery");
      assert.equal(incompleteVerification.terminalMarker, "INCOMPLETE");
      assert.equal(incompleteVerification.summary.recoveryRequired, true);
    });

    fs.writeFileSync(path.join(basic.gateInput.repositoryPath, "src/a.txt"), "receipt drift\n");
    const staleReceiptVerification = await verifyControlledRepositoryApplyReceipt({
      repositoryPath: basic.gateInput.repositoryPath,
      registryDirectoryPath: basic.registryDirectoryPath,
      receipt: result.receipt,
      authorization: basic.authorization,
      expectedInspection: basic.gateInput.expectedInspection
    });
    check("current repository drift makes an applied receipt stale", () => {
      assert.equal(staleReceiptVerification.decision,
        "controlled_repository_apply_receipt_stale");
      assert.equal(staleReceiptVerification.repositoryStateMatched, false);
      assert.ok(staleReceiptVerification.staleFields.includes("appliedStateHash"));
    });

    const unsafePermissions = await fixture();
    fs.chmodSync(unsafePermissions.registryDirectoryPath, 0o755);
    const unsafePermissionsResult = await execute(unsafePermissions);
    check("non-private registry permissions require review before claim", () => {
      assert.equal(unsafePermissionsResult.decision,
        "controlled_repository_apply_needs_review");
      assert.equal(unsafePermissionsResult.summary.consumptionClaimCreated, false);
    });

    const registrySymlinkFixture = await fixture();
    const registrySymlinkParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x4-reglink-")));
    roots.push(registrySymlinkParent);
    const registrySymlink = path.join(registrySymlinkParent, "registry-link");
    fs.symlinkSync(registrySymlinkFixture.registryDirectoryPath, registrySymlink);
    const registrySymlinkResult = await execute(registrySymlinkFixture, {
      registryDirectoryPath: registrySymlink
    });
    check("a symlinked registry path is invalid before claim", () => {
      assert.equal(registrySymlinkResult.decision, "controlled_repository_apply_invalid");
      assert.equal(registrySymlinkResult.summary.consumptionClaimCreated, false);
    });

    const explicitPolicy = await fixture();
    const explicitResult = await execute(explicitPolicy, {
      policy: clone(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY)
    });
    assert.equal(explicitResult.decision, "controlled_repository_apply_succeeded");
    const relaxed = clone(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY);
    relaxed.forbidShellExecution = false;
    const relaxedFixture = await fixture();
    await assert.rejects(() => execute(relaxedFixture, { policy: relaxed }), TypeError);
    for (const field of Object.keys(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY)) {
      if (field === "policyVersion") continue;
      const candidate = clone(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY);
      candidate[field] = false;
      await assert.rejects(() => execute(basic, { policy: candidate }), TypeError, field);
    }
    const missingPolicy = clone(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY);
    delete missingPolicy.requireCurrentExecutionAuthorization;
    const unknownPolicy = { ...clone(DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY), unknown: true };
    assert.equal((await execute(basic, { policy: missingPolicy })).decision,
      "controlled_repository_apply_invalid");
    assert.equal((await execute(basic, { policy: unknownPolicy })).decision,
      "controlled_repository_apply_invalid");
    check("only the complete exact strict executor policy is accepted", () => {});

    class ExoticInput {}
    for (const value of [
      null, undefined, 1, "bad", [], new Date(), new Map(), new Set(), new ExoticInput()
    ]) {
      const malformed = await executeControlledRepositoryApply(value);
      assert.equal(malformed.decision, "controlled_repository_apply_invalid");
    }
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal((await executeControlledRepositoryApply(cyclic)).decision,
      "controlled_repository_apply_invalid");
    const accessorInput = {
      authorization: basic.authorization, gateInput: basic.gateInput,
      registryDirectoryPath: basic.registryDirectoryPath
    };
    Object.defineProperty(accessorInput, "authorization", {
      enumerable: true, get() { throw new Error("getter invoked"); }
    });
    const symbolInput = executeControlledRepositoryApply({
      authorization: basic.authorization, gateInput: basic.gateInput,
      registryDirectoryPath: basic.registryDirectoryPath, [Symbol("secret")]: true
    });
    const inheritedInput = Object.create({
      authorization: basic.authorization, gateInput: basic.gateInput,
      registryDirectoryPath: basic.registryDirectoryPath
    });
    assert.equal((await executeControlledRepositoryApply(accessorInput)).decision,
      "controlled_repository_apply_invalid");
    assert.equal((await symbolInput).decision, "controlled_repository_apply_invalid");
    assert.equal((await executeControlledRepositoryApply(inheritedInput)).decision,
      "controlled_repository_apply_invalid");
    check("malformed, exotic, accessor, symbol, inherited, and cyclic evidence fails closed", () => {});

    check("results and registry evidence leak no paths or source and mutation bytes", () => {
      const serialized = JSON.stringify({ result, verified });
      for (const sentinel of [
        basic.gateInput.repositoryPath, basic.registryDirectoryPath,
        basic.gateInput.bundleDirectoryPath, "X4_SOURCE_SENTINEL",
        "X4_APPLIED_SENTINEL", "X4_MUTATION_SENTINEL"
      ]) assert.equal(serialized.includes(sentinel), false, sentinel);
      for (const file of ["reservation.json", "transaction.json", "apply-receipt.json"]) {
        const text = fs.readFileSync(path.join(claim, file), "utf8");
        assert.equal(text.includes("X4_"), false);
        assert.equal(text.includes(basic.gateInput.repositoryPath), false);
      }
    });

    check("production executor uses execFile only and contains no prohibited Git mutation", () => {
      const source = fs.readFileSync(path.join(
        __dirname, "../packages/product-runtime/src/controlled-repository-apply.ts"
      ), "utf8");
      assert.equal(source.includes("exec("), false);
      assert.equal(source.includes("shell: true"), false);
      for (const command of [
        "add", "apply", "checkout", "clean", "commit", "merge", "rebase", "reset",
        "restore", "stash", "switch", "update-index", "write-tree", "push"
      ]) assert.equal(source.includes(`[\"${command}\"`), false, command);
    });

    check("runtime exports the complete X.4 value API", () => {
      assert.equal(runtime.CONTROLLED_REPOSITORY_APPLY_VERSION, "1");
      assert.equal(typeof runtime.executeControlledRepositoryApply, "function");
      assert.equal(typeof runtime.verifyControlledRepositoryApplyReceipt, "function");
      assert.equal(typeof runtime.restoreControlledRepositoryFromRollbackBundle, "function");
      assert.equal(typeof runtime.inspectControlledRepositoryFileState, "function");
      assert.equal(Object.isFrozen(runtime.DEFAULT_CONTROLLED_REPOSITORY_APPLY_POLICY), true);
    });
  } finally {
    for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(checks >= 15);
  console.log(`controlled repository apply smoke passed (${checks} checks)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
