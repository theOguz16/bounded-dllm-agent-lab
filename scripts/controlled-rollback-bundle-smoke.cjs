#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Rollback Fixture",
  GIT_AUTHOR_EMAIL: "rollback@example.invalid",
  GIT_COMMITTER_NAME: "Rollback Fixture",
  GIT_COMMITTER_EMAIL: "rollback@example.invalid"
};

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd, env: gitEnv, encoding: options.buffer ? null : "utf8"
  });
}

function write(root, file, content, mode) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function createRepository(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rollback-repo-")));
  git(root, ["init", "--quiet"]);
  write(root, "src/a.txt", "ROLLBACK_CONTENT_SENTINEL\n");
  write(root, "src/duplicate.txt", "ROLLBACK_CONTENT_SENTINEL\n");
  write(root, "bin/tool.sh", "#!/bin/sh\necho rollback\n", 0o755);
  fs.symlinkSync("../src/a.txt", path.join(root, "link-to-a"));
  git(root, ["add", "--", "src/a.txt", "src/duplicate.txt", "bin/tool.sh", "link-to-a"]);
  if (options.gitlink) {
    const nested = path.join(root, "vendor/nested");
    fs.mkdirSync(nested, { recursive: true });
    git(nested, ["init", "--quiet"]);
    write(nested, "nested.txt", "NESTED_SENTINEL\n");
    git(nested, ["add", "--", "nested.txt"]);
    git(nested, ["commit", "--quiet", "-m", "nested"]);
    git(root, ["-c", "advice.addEmbeddedRepo=false", "add", "--", "vendor/nested"]);
  }
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

function snapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    status: git(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    index: git(root, ["ls-files", "-s"]),
    a: fs.readFileSync(path.join(root, "src/a.txt")).toString("hex")
  };
}

function externalParent() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rollback-bundles-")));
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_ROLLBACK_BUNDLE_VERSION,
    buildControlledApplyHandoff,
    computeGovernedMutationHash,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    verifyControlledRollbackBundle
  } = runtime;
  let checks = 0;
  const check = (name, operation) => {
    operation();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const hash = (label) => hashCanonicalJson({ label });

  function mutationFor(files) {
    return {
      role: "remask",
      target: "repairDraft",
      summary: "Bounded rollback fixture mutation.",
      claims: [{
        type: "repair_draft",
        file: files[0],
        description: "MUTATION_DESCRIPTION_SENTINEL",
        proposedPatch: "MUTATION_PATCH_SENTINEL"
      }],
      touchedFiles: [...files],
      confidence: 0.9
    };
  }

  function artifactFor(mutation, { policySkip = true } = {}) {
    const mutationHash = computeGovernedMutationHash("repair_draft", mutation);
    const changedFiles = [...new Set(mutation.touchedFiles)].sort();
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash,
        changedFiles,
        patchDryRunResultHash: hash("dry-run"),
        temporaryApplyResultHash: hash("temp-apply"),
        executionVerificationResultHash: hash("execution"),
        stageEvents: {
          mutationSourceEventId: "run:event:000005",
          patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008",
          executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010",
          deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012",
          adminAgentEventId: policySkip ? null : "run:event:000013",
          approvalRouterEventId: "run:event:000013"
        }
      },
      evidence: {
        runId: `rollback-${changedFiles.join("-")}`,
        objectiveHash: hash("objective"),
        preShadowLedgerRootHash: hash("pre-root"),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash("trace"),
        observationHash: hash("observation"),
        governanceHash: hash("governance"),
        adminInvocationPolicyHash: hash("admin-invocation-policy"),
        adminInvocationAssessmentHash: hash("admin-invocation-assessment"),
        adminDecisionHash: policySkip ? null : hash("admin"),
        routeHash: hash("route"),
        governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy"),
        finalLedgerRootHash: hash("final-root"),
        finalLedgerEventCount: policySkip ? 13 : 14
      },
      decisions: {
        phaseVFinalDecision: "temp_validation_passed",
        shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid",
        governanceDecision: "governance_passed",
        adminInvocationMode: policySkip ? "conditional" : "always",
        adminInvocationDecision: policySkip
          ? "admin_invocation_skipped" : "admin_invocation_required",
        adminInvocationSkipKind: policySkip ? "clean_path" : null,
        adminResolutionKind: policySkip ? "verified_policy_skip" : "model_decision",
        adminStageDecision: policySkip ? "admin_skipped_by_policy" : "admin_agent_completed",
        adminValidationDecision: policySkip ? null : "admin_decision_valid",
        adminDecision: policySkip ? null : "admin_auto_approved",
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

  async function governedFixture(root, files) {
    const inspectionResult = await inspectControlledRepository({ repositoryPath: root, changedFiles: files });
    assert.equal(inspectionResult.decision, "repository_inspection_ready");
    const mutation = mutationFor(files);
    const artifact = artifactFor(mutation);
    const currentFreshnessSnapshot = freshnessFrom(artifact);
    const handoffResult = buildControlledApplyHandoff({
      artifact,
      currentFreshnessSnapshot,
      mutation,
      target: inspectionResult.inspection.target
    });
    assert.equal(handoffResult.decision, "controlled_apply_handoff_ready");
    const verifiedInspection = await inspectControlledRepository({
      repositoryPath: root,
      changedFiles: files,
      handoff: handoffResult.handoff,
      artifact,
      currentFreshnessSnapshot,
      mutation,
      consumptionStatus: "not_consumed"
    });
    assert.equal(verifiedInspection.decision, "repository_inspection_ready");
    assert.equal(verifiedInspection.summary.handoffExecutionEligible, true);
    return {
      expectedInspection: inspectionResult.inspection,
      handoff: handoffResult.handoff,
      artifact,
      currentFreshnessSnapshot,
      mutation
    };
  }

  function materialInput(root, bundleDirectoryPath, files, fixture, extra = {}) {
    return {
      repositoryPath: root,
      bundleDirectoryPath,
      changedFiles: [...files],
      ...fixture,
      consumptionStatus: "not_consumed",
      ...extra
    };
  }

  const root = createRepository();
  const parent = externalParent();
  const cleanup = [root, parent];
  try {
    const files = ["src/a.txt", "src/duplicate.txt", "bin/tool.sh", "link-to-a", "src/new.txt"];
    const fixture = await governedFixture(root, files);
    const input = materialInput(root, path.join(parent, "bundle"), files, fixture);
    const inputBefore = structuredClone(input);
    const repositoryBefore = snapshot(root);
    const result = await materializeControlledRollbackBundle(input);

    const modelArtifact = artifactFor(fixture.mutation, { policySkip: false });
    const modelFreshness = freshnessFrom(modelArtifact);
    const modelHandoff = buildControlledApplyHandoff({
      artifact: modelArtifact,
      currentFreshnessSnapshot: modelFreshness,
      mutation: fixture.mutation,
      target: fixture.expectedInspection.target
    });
    assert.equal(modelHandoff.decision, "controlled_apply_handoff_ready");
    const modelInspection = await inspectControlledRepository({
      repositoryPath: root,
      changedFiles: files,
      handoff: modelHandoff.handoff,
      artifact: modelArtifact,
      currentFreshnessSnapshot: modelFreshness,
      mutation: fixture.mutation,
      consumptionStatus: "not_consumed"
    });

    check("clean governed evidence materializes an atomically sealed rollback bundle", () => {
      assert.equal(CONTROLLED_ROLLBACK_BUNDLE_VERSION, "1");
      assert.equal(result.decision, "rollback_bundle_ready");
      assert.equal(result.summary.rollbackPrepared, true);
      assert.equal(result.summary.bundleSealed, true);
      assert.equal(result.summary.bundleRenamedAtomically, true);
      assert.equal(result.summary.finalBundleVerified, true);
      assert.equal(fs.existsSync(path.join(parent, "bundle")), true);
      assert.equal(fs.existsSync(path.join(parent, "bundle.partial")), false);
    });

    check("X.1 accepts both policy-skip and model-backed W.17 handoffs", () => {
      assert.equal(fixture.artifact.evidence.adminDecisionHash, null);
      assert.equal(modelArtifact.evidence.adminDecisionHash !== null, true);
      assert.equal(modelInspection.decision, "repository_inspection_ready");
      assert.equal(modelInspection.summary.handoffExecutionEligible, true);
    });

    check("tracked, executable, symlink, and absent actions are exact", () => {
      const entries = Object.fromEntries(result.manifest.entries.map((entry) =>
        [entry.filePath, entry]));
      assert.equal(entries["src/a.txt"].rollbackAction, "restore_regular_file");
      assert.equal(entries["bin/tool.sh"].rollbackAction, "restore_regular_file");
      assert.equal(entries["bin/tool.sh"].baseMode, "100755");
      assert.equal(entries["link-to-a"].rollbackAction, "restore_symlink");
      assert.equal(entries["link-to-a"].baseMode, "120000");
      assert.equal(entries["src/new.txt"].rollbackAction, "remove_path");
      assert.equal(entries["src/new.txt"].payloadBytes, 0);
      assert.equal(entries["src/new.txt"].payloadObjectHash, null);
    });

    check("identical blobs deduplicate into one protected content object", () => {
      const a = result.manifest.entries.find((entry) => entry.filePath === "src/a.txt");
      const duplicate = result.manifest.entries.find((entry) =>
        entry.filePath === "src/duplicate.txt");
      assert.equal(a.payloadObjectHash, duplicate.payloadObjectHash);
      assert.equal(fs.readdirSync(path.join(parent, "bundle/objects")).length,
        result.manifest.uniquePayloadObjectCount);
      assert.equal(fs.statSync(path.join(parent, "bundle")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(parent, "bundle/bundle.json")).mode & 0o777, 0o600);
      for (const object of fs.readdirSync(path.join(parent, "bundle/objects"))) {
        assert.equal(fs.statSync(path.join(parent, "bundle/objects", object)).mode & 0o777, 0o600);
      }
    });

    check("physical payload bytes equal the original Git blobs", () => {
      for (const entry of result.manifest.entries.filter((item) => item.payloadObjectHash)) {
        const physical = fs.readFileSync(path.join(parent, "bundle", entry.payloadRelativePath));
        const gitBlob = git(root, ["cat-file", "blob", entry.baseObjectId], { buffer: true });
        assert.deepEqual(physical, gitBlob);
      }
    });

    check("materialization leaves the repository and caller evidence unchanged", () => {
      assert.deepEqual(snapshot(root), repositoryBefore);
      assert.deepEqual(input, inputBefore);
      assert.equal(Object.isFrozen(input), false);
      assert.equal(result.summary.repositoryWritePerformed, false);
      assert.equal(result.summary.gitMutationPerformed, false);
      assert.equal(result.summary.mutationApplied, false);
      assert.equal(result.summary.consumptionRegistryWritten, false);
    });

    check("returned metadata is deeply frozen and leaks no sensitive paths or payloads", () => {
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.manifest), true);
      assert.equal(Object.isFrozen(result.manifest.entries), true);
      assert.equal(Object.isFrozen(result.receipt), true);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(root), false);
      assert.equal(serialized.includes(parent), false);
      assert.equal(serialized.includes("ROLLBACK_CONTENT_SENTINEL"), false);
      assert.equal(serialized.includes("../src/a.txt"), false);
      assert.equal(serialized.includes("MUTATION_PATCH_SENTINEL"), false);
    });

    const verification = await verifyControlledRollbackBundle({
      bundleDirectoryPath: path.join(parent, "bundle"),
      expectedManifest: result.manifest,
      expectedReceipt: result.receipt,
      expectedHandoffHash: result.manifest.handoffHash,
      expectedConsumptionKey: result.manifest.consumptionKey,
      expectedInspectionHash: result.manifest.inspectionHash
    });
    check("sealed bundle verifies as current and rollback usable", () => {
      assert.equal(verification.decision, "rollback_bundle_current");
      assert.equal(verification.rollbackUsable, true);
      assert.equal(verification.manifestIntegrityVerified, true);
      assert.equal(verification.receiptIntegrityVerified, true);
      assert.equal(verification.payloadRootVerified, true);
      assert.equal(Object.isFrozen(verification), true);
    });

    const stale = await verifyControlledRollbackBundle({
      bundleDirectoryPath: path.join(parent, "bundle"),
      expectedManifest: result.manifest,
      expectedReceipt: result.receipt,
      expectedHandoffHash: hash("other-handoff"),
      expectedConsumptionKey: result.manifest.consumptionKey,
      expectedInspectionHash: result.manifest.inspectionHash
    });
    check("verification reports expected binding changes as stale", () => {
      assert.equal(stale.decision, "rollback_bundle_stale");
      assert.deepEqual(stale.staleFields, ["handoffHash"]);
      assert.equal(stale.rollbackUsable, false);
    });

    for (const status of ["already_consumed", "unknown"]) {
      const output = path.join(parent, `bundle-${status}`);
      const blocked = await materializeControlledRollbackBundle(
        materialInput(root, output, files, fixture, { consumptionStatus: status })
      );
      check(`${status} consumption state blocks without creating output`, () => {
        assert.equal(blocked.decision, "rollback_bundle_blocked");
        assert.equal(fs.existsSync(output), false);
        assert.equal(fs.existsSync(`${output}.partial`), false);
      });
    }

    const existing = path.join(parent, "existing");
    fs.mkdirSync(existing);
    const existingResult = await materializeControlledRollbackBundle(
      materialInput(root, existing, files, fixture)
    );
    const partialOutput = path.join(parent, "partial-collision");
    fs.mkdirSync(`${partialOutput}.partial`);
    const partialResult = await materializeControlledRollbackBundle(
      materialInput(root, partialOutput, files, fixture)
    );
    check("existing final and partial paths are never overwritten", () => {
      assert.equal(existingResult.decision, "rollback_bundle_invalid");
      assert.ok(existingResult.issues.some((issue) =>
        issue.code === "rollback_bundle_output_already_exists"));
      assert.equal(partialResult.decision, "rollback_bundle_invalid");
      assert.ok(partialResult.issues.some((issue) =>
        issue.code === "rollback_bundle_partial_already_exists"));
    });

    const inside = await materializeControlledRollbackBundle(
      materialInput(root, path.join(root, "forbidden-bundle"), files, fixture)
    );
    const insideGit = await materializeControlledRollbackBundle(
      materialInput(root, path.join(root, ".git/forbidden-bundle"), files, fixture)
    );
    check("outputs inside repository or Git metadata are rejected", () => {
      assert.equal(inside.decision, "rollback_bundle_invalid");
      assert.ok(inside.issues.some((issue) =>
        issue.code === "rollback_bundle_output_inside_repository"));
      assert.equal(insideGit.decision, "rollback_bundle_invalid");
      assert.ok(insideGit.issues.some((issue) =>
        issue.code === "rollback_bundle_output_inside_git_directory"));
    });

    const symlinkTarget = externalParent();
    cleanup.push(symlinkTarget);
    fs.symlinkSync(symlinkTarget, path.join(parent, "linked-parent"));
    const linked = await materializeControlledRollbackBundle(
      materialInput(root, path.join(parent, "linked-parent/bundle"), files, fixture)
    );
    check("symlinked output parents are rejected", () => {
      assert.equal(linked.decision, "rollback_bundle_invalid");
      assert.ok(linked.issues.some((issue) =>
        issue.code === "rollback_bundle_output_parent_symlink"));
    });

    const missingParentOutput = path.join(parent, "missing-parent/bundle");
    const missingParent = await materializeControlledRollbackBundle(
      materialInput(root, missingParentOutput, files, fixture)
    );
    const fileParentPath = path.join(parent, "file-parent");
    fs.writeFileSync(fileParentPath, "not a directory");
    const fileParent = await materializeControlledRollbackBundle(
      materialInput(root, path.join(fileParentPath, "bundle"), files, fixture)
    );
    check("missing and non-directory output parents are invalid", () => {
      assert.equal(missingParent.decision, "rollback_bundle_invalid");
      assert.equal(fileParent.decision, "rollback_bundle_invalid");
      assert.ok(missingParent.issues.some((issue) =>
        issue.code === "rollback_bundle_output_path_invalid"));
      assert.ok(fileParent.issues.some((issue) =>
        issue.code === "rollback_bundle_output_path_invalid"));
    });

    const changedOutput = path.join(parent, "changed-repository");
    write(root, "src/a.txt", "changed after inspection\n");
    const changed = await materializeControlledRollbackBundle(
      materialInput(root, changedOutput, files, fixture)
    );
    git(root, ["restore", "--", "src/a.txt"]);
    check("repository changes after X.1 block before bundle creation", () => {
      assert.equal(changed.decision, "rollback_bundle_blocked");
      assert.equal(fs.existsSync(changedOutput), false);
    });

    const operationOutput = path.join(parent, "operation-state");
    fs.writeFileSync(path.join(root, ".git/MERGE_HEAD"), `${git(root, ["rev-parse", "HEAD"]).trim()}\n`);
    const operationChanged = await materializeControlledRollbackBundle(
      materialInput(root, operationOutput, files, fixture)
    );
    fs.unlinkSync(path.join(root, ".git/MERGE_HEAD"));
    check("repository operation state changes block before output", () => {
      assert.equal(operationChanged.decision, "rollback_bundle_blocked");
      assert.equal(fs.existsSync(operationOutput), false);
    });

    const staleTarget = {
      ...fixture.expectedInspection.target,
      baseRevisionHash: hash("stale-base-target")
    };
    const staleHandoff = buildControlledApplyHandoff({
      artifact: fixture.artifact,
      currentFreshnessSnapshot: fixture.currentFreshnessSnapshot,
      mutation: fixture.mutation,
      target: staleTarget
    });
    assert.equal(staleHandoff.decision, "controlled_apply_handoff_ready");
    const staleOutput = path.join(parent, "stale-target");
    const stalePreparation = await materializeControlledRollbackBundle(
      materialInput(root, staleOutput, files, { ...fixture, handoff: staleHandoff.handoff })
    );
    check("a valid but stale target handoff blocks preparation", () => {
      assert.equal(stalePreparation.decision, "rollback_bundle_blocked");
      assert.equal(fs.existsSync(staleOutput), false);
    });

    const tamperedInspection = structuredClone(fixture);
    tamperedInspection.expectedInspection.inspectionHash = hash("tampered-inspection");
    const inspectionIntegrity = await materializeControlledRollbackBundle(
      materialInput(root, path.join(parent, "tampered-inspection"), files, tamperedInspection)
    );
    check("tampered expected X.1 inspection integrity is invalid", () => {
      assert.equal(inspectionIntegrity.decision, "rollback_bundle_invalid");
      assert.ok(inspectionIntegrity.issues.some((issue) =>
        issue.code === "rollback_expected_inspection_integrity_mismatch"));
    });

    const gitlinkRoot = createRepository({ gitlink: true });
    const gitlinkParent = externalParent();
    cleanup.push(gitlinkRoot, gitlinkParent);
    const gitlinkFiles = ["vendor/nested"];
    const gitlinkFixture = await governedFixture(gitlinkRoot, gitlinkFiles);
    const gitlinkResult = await materializeControlledRollbackBundle(
      materialInput(
        gitlinkRoot, path.join(gitlinkParent, "bundle"), gitlinkFiles, gitlinkFixture
      )
    );
    check("gitlink rollback evidence requires review without entering the nested repository", () => {
      assert.equal(gitlinkResult.decision, "rollback_bundle_needs_review");
      assert.ok(gitlinkResult.issues.some((issue) =>
        issue.code === "rollback_gitlink_not_supported"));
      assert.equal(fs.existsSync(path.join(gitlinkParent, "bundle")), false);
    });

    const malformedValues = [null, 1, "bad", [], new Date(), new Map(), new Set()];
    for (const value of malformedValues) {
      const malformed = await materializeControlledRollbackBundle(value);
      check("malformed materialization input returns invalid without throwing", () => {
        assert.equal(malformed.decision, "rollback_bundle_invalid");
      });
    }
    const accessor = { repositoryPath: root };
    Object.defineProperty(accessor, "bundleDirectoryPath", {
      get() { throw new Error("must not run"); }
    });
    const accessorResult = await materializeControlledRollbackBundle(accessor);
    const unknownResult = await materializeControlledRollbackBundle({ ...input, unknown: true });
    const symbolInput = { ...input };
    symbolInput[Symbol("unsafe")] = true;
    const symbolResult = await materializeControlledRollbackBundle(symbolInput);
    const cyclicInput = { ...input };
    cyclicInput.expectedInspection = { self: null };
    cyclicInput.expectedInspection.self = cyclicInput.expectedInspection;
    const cyclicResult = await materializeControlledRollbackBundle(cyclicInput);
    check("accessor input is rejected without evaluation", () => {
      assert.equal(accessorResult.decision, "rollback_bundle_invalid");
      assert.equal(accessorResult.issues[0].code, "rollback_bundle_accessor_property");
    });
    check("unknown, symbol, and cyclic structures are rejected", () => {
      assert.equal(unknownResult.issues[0].code, "unknown_rollback_bundle_field");
      assert.equal(symbolResult.issues[0].code, "rollback_bundle_symbol_property");
      assert.equal(cyclicResult.decision, "rollback_bundle_invalid");
    });
    await assert.rejects(
      materializeControlledRollbackBundle({ ...input, bundleDirectoryPath: path.join(parent, "bad-limit"), maxEntryBytes: 0 }),
      TypeError
    );
    check("invalid trusted numeric configuration may throw TypeError", () => {});

    const oversizedOutput = path.join(parent, "entry-bound");
    const entryBound = await materializeControlledRollbackBundle({
      ...input,
      bundleDirectoryPath: oversizedOutput,
      maxEntryBytes: 4
    });
    check("entry bounds fail closed and clean only the invocation partial", () => {
      assert.equal(entryBound.decision, "rollback_bundle_needs_review");
      assert.equal(entryBound.summary.partialDirectoryCreated, true);
      assert.equal(entryBound.summary.partialDirectoryCleaned, true);
      assert.equal(fs.existsSync(oversizedOutput), false);
      assert.equal(fs.existsSync(`${oversizedOutput}.partial`), false);
    });

    const bundleBoundOutput = path.join(parent, "bundle-bound");
    const bundleBound = await materializeControlledRollbackBundle({
      ...input,
      bundleDirectoryPath: bundleBoundOutput,
      maxBundleBytes: 100
    });
    check("total bundle bounds leave no final or partial output", () => {
      assert.equal(bundleBound.decision, "rollback_bundle_needs_review");
      assert.equal(bundleBound.summary.partialDirectoryCleaned, true);
      assert.equal(fs.existsSync(bundleBoundOutput), false);
      assert.equal(fs.existsSync(`${bundleBoundOutput}.partial`), false);
    });

    const invalidHandoff = structuredClone(fixture);
    invalidHandoff.handoff.handoffHash = hash("tampered-handoff");
    const invalidHandoffOutput = path.join(parent, "invalid-handoff");
    const invalidHandoffResult = await materializeControlledRollbackBundle(
      materialInput(root, invalidHandoffOutput, files, invalidHandoff)
    );
    check("an integrity-invalid handoff invalidates preparation before output", () => {
      assert.equal(invalidHandoffResult.decision, "rollback_bundle_invalid");
      assert.ok(invalidHandoffResult.issues.some((issue) =>
        issue.code === "rollback_handoff_not_current"));
      assert.equal(fs.existsSync(invalidHandoffOutput), false);
    });

    const oldEvidence = structuredClone(fixture);
    oldEvidence.handoff.evidence.governedArtifactHash = hash("pre-w17-artifact");
    oldEvidence.handoff.evidence.currentSnapshotHash = hash("pre-w17-snapshot");
    delete oldEvidence.handoff.handoffHash;
    oldEvidence.handoff.handoffHash = hashCanonicalJson(oldEvidence.handoff);
    const oldEvidenceOutput = path.join(parent, "old-admin-evidence");
    const oldEvidenceResult = await materializeControlledRollbackBundle(
      materialInput(root, oldEvidenceOutput, files, oldEvidence)
    );
    check("pre-W.17 Admin-always handoff evidence cannot be reused for a bundle", () => {
      assert.equal(oldEvidenceResult.decision, "rollback_bundle_blocked");
      assert.equal(fs.existsSync(oldEvidenceOutput), false);
    });

    const tamperParent = externalParent();
    cleanup.push(tamperParent);
    fs.cpSync(path.join(parent, "bundle"), path.join(tamperParent, "tampered"), { recursive: true });
    const objectName = fs.readdirSync(path.join(tamperParent, "tampered/objects"))[0];
    fs.writeFileSync(path.join(tamperParent, "tampered/objects", objectName), "tampered");
    const tampered = await verifyControlledRollbackBundle({
      bundleDirectoryPath: path.join(tamperParent, "tampered"),
      expectedManifest: result.manifest,
      expectedReceipt: result.receipt,
      expectedHandoffHash: result.manifest.handoffHash,
      expectedConsumptionKey: result.manifest.consumptionKey,
      expectedInspectionHash: result.manifest.inspectionHash
    });
    check("payload tampering invalidates the sealed bundle", () => {
      assert.equal(tampered.decision, "rollback_bundle_invalid");
      assert.ok(tampered.issues.some((issue) => issue.code === "rollback_payload_hash_mismatch"));
    });

    const verifyArguments = (bundleDirectoryPath) => ({
      bundleDirectoryPath,
      expectedManifest: result.manifest,
      expectedReceipt: result.receipt,
      expectedHandoffHash: result.manifest.handoffHash,
      expectedConsumptionKey: result.manifest.consumptionKey,
      expectedInspectionHash: result.manifest.inspectionHash
    });
    const missingPath = path.join(tamperParent, "missing");
    fs.cpSync(path.join(parent, "bundle"), missingPath, { recursive: true });
    fs.unlinkSync(path.join(missingPath, "objects", fs.readdirSync(path.join(missingPath, "objects"))[0]));
    const missing = await verifyControlledRollbackBundle(verifyArguments(missingPath));
    const extraPath = path.join(tamperParent, "extra");
    fs.cpSync(path.join(parent, "bundle"), extraPath, { recursive: true });
    fs.writeFileSync(path.join(extraPath, "objects", "0".repeat(64)), "extra");
    const extra = await verifyControlledRollbackBundle(verifyArguments(extraPath));
    const metadataPath = path.join(tamperParent, "metadata");
    fs.cpSync(path.join(parent, "bundle"), metadataPath, { recursive: true });
    fs.writeFileSync(path.join(metadataPath, "extra.json"), "{}");
    const metadata = await verifyControlledRollbackBundle(verifyArguments(metadataPath));
    check("missing, extra, and unexpected bundle entries are rejected independently", () => {
      assert.ok(missing.issues.some((issue) => issue.code === "rollback_bundle_missing_object"));
      assert.ok(extra.issues.some((issue) => issue.code === "rollback_bundle_extra_object"));
      assert.ok(metadata.issues.some((issue) => issue.code === "rollback_bundle_unexpected_entry"));
    });

    const noncanonicalPath = path.join(tamperParent, "noncanonical");
    fs.cpSync(path.join(parent, "bundle"), noncanonicalPath, { recursive: true });
    fs.appendFileSync(path.join(noncanonicalPath, "bundle.json"), " ");
    const noncanonical = await verifyControlledRollbackBundle(verifyArguments(noncanonicalPath));
    check("noncanonical manifest bytes invalidate bundle verification", () => {
      assert.equal(noncanonical.decision, "rollback_bundle_invalid");
      assert.ok(noncanonical.issues.some((issue) =>
        issue.code === "rollback_manifest_verification_failed"));
    });

    const invalidReceipt = {
      ...result.receipt,
      receiptHash: hash("invalid-receipt")
    };
    const receiptTamper = await verifyControlledRollbackBundle({
      ...verifyArguments(path.join(parent, "bundle")),
      expectedReceipt: invalidReceipt
    });
    check("receipt hash tampering invalidates verification", () => {
      assert.equal(receiptTamper.decision, "rollback_bundle_invalid");
      assert.ok(receiptTamper.issues.some((issue) =>
        issue.code === "rollback_bundle_receipt_hash_mismatch"));
    });

    const symlinkBundlePath = path.join(tamperParent, "symlink-object");
    fs.cpSync(path.join(parent, "bundle"), symlinkBundlePath, { recursive: true });
    const symlinkObjectName = fs.readdirSync(path.join(symlinkBundlePath, "objects"))[0];
    const symlinkObjectPath = path.join(symlinkBundlePath, "objects", symlinkObjectName);
    fs.unlinkSync(symlinkObjectPath);
    fs.symlinkSync(path.join(parent, "bundle/objects", symlinkObjectName), symlinkObjectPath);
    const symlinkBundle = await verifyControlledRollbackBundle(
      verifyArguments(symlinkBundlePath)
    );
    check("symbolic links inside a bundle invalidate verification", () => {
      assert.equal(symlinkBundle.decision, "rollback_bundle_invalid");
      assert.ok(symlinkBundle.issues.some((issue) =>
        issue.code === "rollback_bundle_symlink_detected"));
    });

    const malformedVerification = await verifyControlledRollbackBundle(null);
    const mutableManifest = structuredClone(result.manifest);
    const mutableReceipt = structuredClone(result.receipt);
    const mutableVerification = await verifyControlledRollbackBundle({
      ...verifyArguments(path.join(parent, "bundle")),
      expectedManifest: mutableManifest,
      expectedReceipt: mutableReceipt
    });
    check("verification structure attacks fail closed without freezing caller evidence", () => {
      assert.equal(malformedVerification.decision, "rollback_bundle_invalid");
      assert.equal(mutableVerification.decision, "rollback_bundle_current");
      assert.equal(Object.isFrozen(mutableManifest), false);
      assert.equal(Object.isFrozen(mutableReceipt), false);
    });

    const traversalManifest = structuredClone(result.manifest);
    const payloadEntry = traversalManifest.entries.find((entry) => entry.payloadRelativePath);
    payloadEntry.payloadRelativePath = "objects/../escape";
    const oldManifestHash = traversalManifest.bundleManifestHash;
    delete traversalManifest.bundleManifestHash;
    traversalManifest.bundleManifestHash = hashCanonicalJson(traversalManifest);
    assert.notEqual(traversalManifest.bundleManifestHash, oldManifestHash);
    const traversalVerification = await verifyControlledRollbackBundle({
      ...verifyArguments(path.join(parent, "bundle")),
      expectedManifest: traversalManifest
    });
    check("traversal payload paths are rejected before bundle reads are trusted", () => {
      assert.equal(traversalVerification.decision, "rollback_bundle_invalid");
    });

    const source = fs.readFileSync(
      path.join(__dirname, "../packages/product-runtime/src/controlled-rollback-bundle.ts"),
      "utf8"
    );
    check("runtime Git boundary is execFile-only and permits only cat-file blob", () => {
      assert.match(source, /execFile\(\s*"git",\s*\["cat-file", "blob", objectId\]/);
      assert.equal(source.includes("shell: true"), false);
      for (const command of ["checkout", "restore", "apply", "reset", "update-index", "hash-object"]) {
        assert.equal(new RegExp(`\\[\\s*"${command}"`).test(source), false);
      }
    });

    console.log(`controlled rollback bundle smoke passed (${checks} checks)`);
  } finally {
    for (const target of cleanup.reverse()) fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
