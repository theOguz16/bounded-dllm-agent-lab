#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "X3 Fixture",
  GIT_AUTHOR_EMAIL: "x3@example.invalid",
  GIT_COMMITTER_NAME: "X3 Fixture",
  GIT_COMMITTER_EMAIL: "x3@example.invalid"
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

function createRepository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x3-repo-")));
  git(root, ["init", "--quiet"]);
  write(root, "src/a.txt", "X3_SOURCE_CONTENT_SENTINEL\n");
  write(root, "bin/tool.sh", "#!/bin/sh\necho X3_ROLLBACK_PAYLOAD_SENTINEL\n", 0o755);
  fs.symlinkSync("src/a.txt", path.join(root, "link-to-a"));
  git(root, ["add", "--", "src/a.txt", "bin/tool.sh", "link-to-a"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

function treeSnapshot(root) {
  const output = {};
  function walk(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isSymbolicLink()) output[relative] = `link:${fs.readlinkSync(absolute)}`;
      else output[relative] = `file:${stat.mode & 0o777}:${fs.readFileSync(absolute).toString("hex")}`;
    }
  }
  walk(root);
  return output;
}

function repositorySnapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    status: git(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    index: git(root, ["ls-files", "-s"]),
    tree: treeSnapshot(root)
  };
}

function deepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child, seen);
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_APPLY_EXECUTION_GATE_VERSION,
    DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY,
    buildControlledApplyHandoff,
    canonicalizeJson,
    computeGovernedMutationHash,
    evaluateControlledApplyExecutionGate,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    verifyControlledApplyExecutionAuthorization
  } = runtime;

  let checks = 0;
  const check = (name, operation) => {
    operation();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const hash = (label) => hashCanonicalJson({ label });
  const clone = (value) => structuredClone(value);
  const files = ["bin/tool.sh", "link-to-a", "src/a.txt", "src/new.txt"];
  const mutation = {
    role: "remask",
    target: "repairDraft",
    summary: "X3_MUTATION_PAYLOAD_SENTINEL",
    claims: [{
      type: "repair_draft",
      file: "src/a.txt",
      proposedPatch: "X3_PATCH_CONTENT_SENTINEL"
    }],
    touchedFiles: [...files],
    confidence: 0.9
  };

  function artifactFor(mode = "conditional") {
    const model = mode === "always";
    const mutationHash = computeGovernedMutationHash("repair_draft", mutation);
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash,
        changedFiles: [...files],
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
        runId: `x3-${mode}`,
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
        adminInvocationSkipKind: model ? null : mode === "disabled" ? "disabled" : "clean_path",
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

  const roots = [];
  async function makeFixture(mode = "conditional") {
    const repositoryPath = createRepository();
    const bundleParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x3-bundles-")));
    roots.push(repositoryPath, bundleParent);
    const bundleDirectoryPath = path.join(bundleParent, "bundle");
    const initialInspection = await inspectControlledRepository({ repositoryPath, changedFiles: files });
    assert.equal(initialInspection.decision, "repository_inspection_ready");
    const artifact = artifactFor(mode);
    const currentFreshnessSnapshot = freshnessFrom(artifact);
    const handoffResult = buildControlledApplyHandoff({
      artifact,
      currentFreshnessSnapshot,
      mutation,
      target: initialInspection.inspection.target
    });
    assert.equal(handoffResult.decision, "controlled_apply_handoff_ready");
    const materialized = await materializeControlledRollbackBundle({
      repositoryPath,
      bundleDirectoryPath,
      changedFiles: files,
      expectedInspection: initialInspection.inspection,
      handoff: handoffResult.handoff,
      artifact,
      currentFreshnessSnapshot,
      mutation,
      consumptionStatus: "not_consumed"
    });
    assert.equal(materialized.decision, "rollback_bundle_ready", JSON.stringify(materialized));
    return {
      repositoryPath,
      bundleDirectoryPath,
      changedFiles: [...files],
      artifact,
      currentFreshnessSnapshot,
      mutation: clone(mutation),
      handoff: handoffResult.handoff,
      expectedInspection: initialInspection.inspection,
      rollbackBundleManifest: materialized.manifest,
      rollbackBundleReceipt: materialized.receipt,
      consumptionStatus: "not_consumed"
    };
  }

  function reseal(input, mutate, suffix) {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `x3-reseal-${suffix}-`)));
    roots.push(parent);
    const bundleDirectoryPath = path.join(parent, "bundle");
    fs.cpSync(input.bundleDirectoryPath, bundleDirectoryPath, { recursive: true });
    const manifest = clone(input.rollbackBundleManifest);
    mutate(manifest);
    delete manifest.bundleManifestHash;
    manifest.bundleManifestHash = hashCanonicalJson(manifest);
    const receipt = clone(input.rollbackBundleReceipt);
    receipt.bundleManifestHash = manifest.bundleManifestHash;
    receipt.payloadRootHash = manifest.payloadRootHash;
    receipt.handoffHash = manifest.handoffHash;
    receipt.consumptionKey = manifest.consumptionKey;
    receipt.inspectionHash = manifest.inspectionHash;
    receipt.totalPayloadBytes = manifest.totalPayloadBytes;
    receipt.uniquePayloadObjectCount = manifest.uniquePayloadObjectCount;
    receipt.changedFileCount = manifest.mutation.changedFiles.length;
    delete receipt.receiptHash;
    receipt.receiptHash = hashCanonicalJson(receipt);
    fs.writeFileSync(path.join(bundleDirectoryPath, "bundle.json"), canonicalizeJson(manifest));
    return {
      ...input,
      bundleDirectoryPath,
      rollbackBundleManifest: manifest,
      rollbackBundleReceipt: receipt
    };
  }

  try {
    const policyFixture = await makeFixture("conditional");
    const beforeRepository = repositorySnapshot(policyFixture.repositoryPath);
    const beforeBundle = treeSnapshot(policyFixture.bundleDirectoryPath);
    const inputBefore = clone(policyFixture);
    const ready = await evaluateControlledApplyExecutionGate(policyFixture);

    check("clean W.17 policy-skip path builds immutable pre-write authorization", () => {
      assert.equal(CONTROLLED_APPLY_EXECUTION_GATE_VERSION, "1");
      assert.equal(ready.decision, "controlled_apply_execution_gate_ready");
      assert.ok(ready.authorization);
      assert.equal(ready.authorization.adminResolution.resolutionKind,
        "verified_policy_skip");
      assert.equal(ready.authorization.adminResolution.adminDecisionHash, null);
      assert.equal(ready.summary.authorizationBuilt, true);
      assert.equal(ready.summary.rollbackCoverageComplete, true);
      assert.equal(ready.summary.repositoryWritePerformed, false);
      assert.equal(ready.summary.gitMutationPerformed, false);
      assert.equal(ready.summary.mutationApplied, false);
      assert.equal(ready.summary.rollbackExecuted, false);
      assert.equal(ready.summary.consumptionRegistryWritten, false);
    });

    const immediate = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: policyFixture
    });
    check("immediate authorization verification is current but remains evidence-only", () => {
      assert.equal(immediate.decision,
        "controlled_apply_execution_authorization_current");
      assert.equal(immediate.firstWriteEligible, true);
      assert.equal(immediate.authorizationIntegrityVerified, true);
      assert.equal(immediate.summary.repositoryWritePerformed, false);
      assert.equal(immediate.summary.gitMutationPerformed, false);
      assert.equal(immediate.summary.mutationApplied, false);
    });

    check("X.3 leaves repository, bundle, and caller evidence unchanged", () => {
      assert.deepEqual(repositorySnapshot(policyFixture.repositoryPath), beforeRepository);
      assert.deepEqual(treeSnapshot(policyFixture.bundleDirectoryPath), beforeBundle);
      assert.deepEqual(policyFixture, inputBefore);
      assert.equal(Object.isFrozen(policyFixture), false);
      assert.equal(Object.isFrozen(policyFixture.artifact), false);
      deepFrozen(ready);
      deepFrozen(ready.authorization);
      deepFrozen(immediate);
    });

    const repeated = await evaluateControlledApplyExecutionGate({
      ...policyFixture,
      changedFiles: [...policyFixture.changedFiles].reverse()
    });
    const roundTrip = await evaluateControlledApplyExecutionGate(
      JSON.parse(JSON.stringify(policyFixture))
    );
    check("policy, coverage, and authorization hashes are deterministic", () => {
      for (const candidate of [repeated, roundTrip]) {
        assert.equal(candidate.decision, "controlled_apply_execution_gate_ready");
        assert.equal(candidate.authorization.gatePolicyHash,
          ready.authorization.gatePolicyHash);
        assert.equal(candidate.authorization.evidence.rollbackCoverageHash,
          ready.authorization.evidence.rollbackCoverageHash);
        assert.equal(candidate.authorization.authorizationHash,
          ready.authorization.authorizationHash);
      }
    });

    const modelFixture = await makeFixture("always");
    const modelReady = await evaluateControlledApplyExecutionGate(modelFixture);
    const disabledFixture = await makeFixture("disabled");
    const disabledReady = await evaluateControlledApplyExecutionGate(disabledFixture);
    check("model-backed and disabled clean W.17 paths are supported exactly", () => {
      assert.equal(modelReady.decision, "controlled_apply_execution_gate_ready");
      assert.equal(modelReady.authorization.adminResolution.resolutionKind, "model_decision");
      assert.match(modelReady.authorization.adminResolution.adminDecisionHash,
        /^sha256:[0-9a-f]{64}$/);
      assert.notEqual(modelReady.authorization.authorizationHash,
        ready.authorization.authorizationHash);
      assert.equal(disabledReady.decision, "controlled_apply_execution_gate_ready");
      assert.equal(disabledReady.authorization.adminResolution.resolutionKind,
        "verified_policy_skip");
    });

    const consumed = await evaluateControlledApplyExecutionGate({
      ...policyFixture, consumptionStatus: "already_consumed"
    });
    const unknown = await evaluateControlledApplyExecutionGate({
      ...policyFixture, consumptionStatus: "unknown"
    });
    const consumedVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: { ...policyFixture, consumptionStatus: "already_consumed" }
    });
    check("external consumption status blocks without registry writes", () => {
      assert.equal(consumed.decision, "controlled_apply_execution_gate_blocked");
      assert.equal(unknown.decision, "controlled_apply_execution_gate_blocked");
      assert.equal(consumed.authorization, null);
      assert.equal(unknown.authorization, null);
      assert.ok(consumed.issues.some((issue) => issue.code ===
        "controlled_apply_execution_consumption_key_already_used"));
      assert.ok(unknown.issues.some((issue) => issue.code ===
        "controlled_apply_execution_consumption_status_unknown"));
      assert.equal(consumedVerification.decision,
        "controlled_apply_execution_authorization_consumed");
      assert.equal(consumedVerification.firstWriteEligible, false);
      assert.equal(consumed.summary.consumptionRegistryWritten, false);
    });

    const oldArtifactInput = clone(policyFixture);
    oldArtifactInput.artifact.artifactVersion = "1";
    delete oldArtifactInput.artifact.governedArtifactHash;
    oldArtifactInput.artifact.governedArtifactHash = hashCanonicalJson(oldArtifactInput.artifact);
    const oldArtifact = await evaluateControlledApplyExecutionGate(oldArtifactInput);
    const oldFreshnessInput = clone(policyFixture);
    delete oldFreshnessInput.currentFreshnessSnapshot.adminInvocationPolicyHash;
    const oldFreshness = await evaluateControlledApplyExecutionGate(oldFreshnessInput);
    check("pre-W.17 artifact and freshness evidence are rejected without migration", () => {
      assert.equal(oldArtifact.decision, "controlled_apply_execution_gate_invalid");
      assert.ok(oldArtifact.issues.some((issue) =>
        issue.code === "controlled_apply_execution_artifact_version_unsupported"));
      assert.equal(oldFreshness.decision, "controlled_apply_execution_gate_invalid");
    });

    const oldRouterInput = clone(policyFixture);
    oldRouterInput.artifact.evidence.routerPolicyHash = hash("router-policy-v1");
    const oldRouter = await evaluateControlledApplyExecutionGate(oldRouterInput);
    const oldHandoffInput = clone(policyFixture);
    oldHandoffInput.handoff.evidence.governedArtifactHash = hash("pre-w17-artifact");
    delete oldHandoffInput.handoff.handoffHash;
    oldHandoffInput.handoff.handoffHash = hashCanonicalJson(oldHandoffInput.handoff);
    const oldHandoff = await evaluateControlledApplyExecutionGate(oldHandoffInput);
    const oldBundleInput = reseal(policyFixture, (manifest) => {
      manifest.governedArtifactHash = hash("pre-w17-artifact");
    }, "pre-w17-bundle");
    const oldBundle = await evaluateControlledApplyExecutionGate(oldBundleInput);
    check("pre-W.17 router, handoff, and rollback bindings are never upgraded", () => {
      for (const result of [oldRouter, oldHandoff, oldBundle]) {
        assert.notEqual(result.decision, "controlled_apply_execution_gate_ready");
        assert.equal(result.authorization, null);
      }
    });

    const mutationCases = [
      { ...clone(mutation), summary: "changed operation" },
      { ...clone(mutation), claims: [{ file: "src/new.txt", operation: "changed" }] },
      { ...clone(mutation), role: "coder", target: "patchDraft" },
      { ...clone(mutation), claims: [...mutation.claims, { operation: "second" }] },
      { ...clone(mutation), touchedFiles: ["src/a.txt"] }
    ];
    const mutationResults = [];
    for (const changedMutation of mutationCases) {
      mutationResults.push(await evaluateControlledApplyExecutionGate({
        ...policyFixture, mutation: changedMutation
      }));
    }
    check("every mutation and changed-file scope mismatch is invalid", () => {
      for (const result of mutationResults) {
        assert.equal(result.decision, "controlled_apply_execution_gate_invalid");
        assert.equal(result.authorization, null);
      }
    });

    const artifactTamperFields = [
      ["adminInvocationPolicyHash", "evidence"],
      ["adminInvocationAssessmentHash", "evidence"],
      ["adminDecisionHash", "evidence"],
      ["adminResolutionKind", "decisions"],
      ["routeHash", "evidence"],
      ["governedArtifactHash", null]
    ];
    const artifactTamperResults = [];
    for (const [field, parent] of artifactTamperFields) {
      const changed = clone(policyFixture);
      if (parent === null) changed.artifact[field] = hash(`tampered:${field}`);
      else changed.artifact[parent][field] = field === "adminResolutionKind"
        ? "model_decision" : hash(`tampered:${field}`);
      artifactTamperResults.push(await evaluateControlledApplyExecutionGate(changed));
    }
    check("artifact and Admin invocation evidence tampering is invalid", () => {
      for (const result of artifactTamperResults) {
        assert.equal(result.decision, "controlled_apply_execution_gate_invalid");
      }
    });

    const invalidHandoff = clone(policyFixture);
    invalidHandoff.handoff.handoffHash = hash("invalid-handoff");
    const invalidHandoffResult = await evaluateControlledApplyExecutionGate(invalidHandoff);
    const staleHandoff = clone(policyFixture);
    staleHandoff.handoff.target.baseRevisionHash = hash("stale-base");
    delete staleHandoff.handoff.handoffHash;
    staleHandoff.handoff.handoffHash = hashCanonicalJson(staleHandoff.handoff);
    const staleHandoffResult = await evaluateControlledApplyExecutionGate(staleHandoff);
    check("invalid and stale handoffs never authorize execution", () => {
      assert.equal(invalidHandoffResult.decision,
        "controlled_apply_execution_gate_invalid");
      assert.notEqual(staleHandoffResult.decision,
        "controlled_apply_execution_gate_ready");
    });

    const targetResults = [];
    for (const field of [
      "repositoryIdentityHash", "baseRevisionHash", "worktreeStateHash"
    ]) {
      const changed = clone(policyFixture);
      changed.handoff.target[field] = hash(`target:${field}`);
      delete changed.handoff.handoffHash;
      changed.handoff.handoffHash = hashCanonicalJson(changed.handoff);
      targetResults.push(await evaluateControlledApplyExecutionGate(changed));
    }
    check("every handoff target component is independently bound", () => {
      for (const result of targetResults) {
        assert.notEqual(result.decision, "controlled_apply_execution_gate_ready");
      }
    });

    write(policyFixture.repositoryPath, "untracked.txt", "drift");
    const dirty = await evaluateControlledApplyExecutionGate(policyFixture);
    const dirtyVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization, gateInput: policyFixture
    });
    check("repository drift blocks gate and makes authorization stale", () => {
      assert.equal(dirty.decision, "controlled_apply_execution_gate_blocked");
      assert.equal(dirty.summary.repositoryWritePerformed, false);
      assert.equal(dirtyVerification.decision,
        "controlled_apply_execution_authorization_stale");
      assert.equal(dirtyVerification.firstWriteEligible, false);
      assert.ok(dirtyVerification.staleFields.includes("worktreeStateHash"));
      assert.ok(dirtyVerification.staleFields.includes("currentInspectionHash"));
      assert.deepEqual(dirtyVerification.staleFields,
        [...dirtyVerification.staleFields].sort());
    });
    fs.unlinkSync(path.join(policyFixture.repositoryPath, "untracked.txt"));

    const trackedOriginal = fs.readFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"));
    fs.writeFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"), "tracked drift");
    const trackedDrift = await evaluateControlledApplyExecutionGate(policyFixture);
    assert.equal(fs.readFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"), "utf8"),
      "tracked drift");
    fs.writeFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"), trackedOriginal);

    fs.writeFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"), "staged drift");
    git(policyFixture.repositoryPath, ["add", "--", "src/a.txt"]);
    const stagedDrift = await evaluateControlledApplyExecutionGate(policyFixture);
    assert.match(git(policyFixture.repositoryPath, ["status", "--porcelain"]), /^M /m);
    git(policyFixture.repositoryPath, ["restore", "--staged", "--", "src/a.txt"]);
    fs.writeFileSync(path.join(policyFixture.repositoryPath, "src/a.txt"), trackedOriginal);

    const gitDirectory = git(policyFixture.repositoryPath, ["rev-parse", "--git-dir"]).trim();
    const mergeMarker = path.resolve(policyFixture.repositoryPath, gitDirectory, "MERGE_HEAD");
    fs.writeFileSync(mergeMarker, `${"a".repeat(40)}\n`);
    const operationDrift = await evaluateControlledApplyExecutionGate(policyFixture);
    assert.equal(fs.existsSync(mergeMarker), true);
    fs.unlinkSync(mergeMarker);

    const headFixture = await makeFixture("conditional");
    write(headFixture.repositoryPath, "head-change.txt", "head drift");
    git(headFixture.repositoryPath, ["add", "--", "head-change.txt"]);
    git(headFixture.repositoryPath, ["commit", "--quiet", "-m", "head drift"]);
    const headDrift = await evaluateControlledApplyExecutionGate(headFixture);
    check("tracked, staged, operation-marker, and HEAD drift are blocked without cleanup", () => {
      for (const result of [trackedDrift, stagedDrift, operationDrift, headDrift]) {
        assert.equal(result.decision, "controlled_apply_execution_gate_blocked");
        assert.equal(result.authorization, null);
      }
    });

    const anotherRoot = createRepository();
    roots.push(anotherRoot);
    const anotherInspection = await inspectControlledRepository({
      repositoryPath: anotherRoot, changedFiles: files
    });
    const expectedMismatch = await evaluateControlledApplyExecutionGate({
      ...policyFixture, expectedInspection: anotherInspection.inspection
    });
    check("a valid expected inspection from another repository cannot be reused", () => {
      assert.notEqual(expectedMismatch.decision, "controlled_apply_execution_gate_ready");
      assert.equal(expectedMismatch.authorization, null);
    });

    const tamperedParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x3-tamper-")));
    roots.push(tamperedParent);
    const tamperedPath = path.join(tamperedParent, "bundle");
    fs.cpSync(policyFixture.bundleDirectoryPath, tamperedPath, { recursive: true });
    const objectName = fs.readdirSync(path.join(tamperedPath, "objects"))[0];
    fs.writeFileSync(path.join(tamperedPath, "objects", objectName), "tampered");
    const tamperedBundle = await evaluateControlledApplyExecutionGate({
      ...policyFixture, bundleDirectoryPath: tamperedPath
    });
    check("physical rollback payload tampering is invalid", () => {
      assert.equal(tamperedBundle.decision, "controlled_apply_execution_gate_invalid");
      assert.equal(tamperedBundle.authorization, null);
    });

    function copiedBundle(suffix) {
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `x3-copy-${suffix}-`)));
      roots.push(parent);
      const bundleDirectoryPath = path.join(parent, "bundle");
      fs.cpSync(policyFixture.bundleDirectoryPath, bundleDirectoryPath, { recursive: true });
      return bundleDirectoryPath;
    }
    const missingObjectPath = copiedBundle("missing-object");
    fs.unlinkSync(path.join(missingObjectPath, "objects",
      fs.readdirSync(path.join(missingObjectPath, "objects"))[0]));
    const missingObject = await evaluateControlledApplyExecutionGate({
      ...policyFixture, bundleDirectoryPath: missingObjectPath
    });
    const extraObjectPath = copiedBundle("extra-object");
    fs.writeFileSync(path.join(extraObjectPath, "objects", "f".repeat(64)), "extra");
    const extraObject = await evaluateControlledApplyExecutionGate({
      ...policyFixture, bundleDirectoryPath: extraObjectPath
    });
    const noncanonicalPath = copiedBundle("noncanonical");
    fs.appendFileSync(path.join(noncanonicalPath, "bundle.json"), "\n");
    const noncanonical = await evaluateControlledApplyExecutionGate({
      ...policyFixture, bundleDirectoryPath: noncanonicalPath
    });
    const manifestHashInput = clone(policyFixture);
    manifestHashInput.rollbackBundleManifest.bundleManifestHash = hash("bad-manifest");
    const manifestHashTamper = await evaluateControlledApplyExecutionGate(manifestHashInput);
    const receiptHashInput = clone(policyFixture);
    receiptHashInput.rollbackBundleReceipt.receiptHash = hash("bad-receipt");
    const receiptHashTamper = await evaluateControlledApplyExecutionGate(receiptHashInput);
    const payloadRootInput = reseal(policyFixture, (manifest) => {
      manifest.payloadRootHash = hash("bad-payload-root");
    }, "payload-root");
    const payloadRootTamper = await evaluateControlledApplyExecutionGate(payloadRootInput);
    check("all physical bundle integrity surfaces fail closed", () => {
      for (const result of [
        missingObject, extraObject, noncanonical, manifestHashTamper,
        receiptHashTamper, payloadRootTamper
      ]) assert.equal(result.decision, "controlled_apply_execution_gate_invalid");
    });

    const missingCoverageInput = reseal(policyFixture, (manifest) => {
      manifest.entries = manifest.entries.filter((entry) => entry.filePath !== "src/new.txt");
    }, "missing");
    const extraCoverageInput = reseal(policyFixture, (manifest) => {
      manifest.entries.push({
        filePath: "src/extra.txt", rollbackAction: "remove_path", baseMode: null,
        baseObjectId: null, payloadObjectHash: null, payloadRelativePath: null,
        payloadBytes: 0, originallyPresent: false
      });
    }, "extra");
    const duplicateCoverageInput = reseal(policyFixture, (manifest) => {
      manifest.entries.push(clone(manifest.entries.find((entry) =>
        entry.filePath === "src/new.txt")));
    }, "duplicate");
    const coverageResults = await Promise.all([
      missingCoverageInput, extraCoverageInput, duplicateCoverageInput
    ].map((candidate) => evaluateControlledApplyExecutionGate(candidate)));
    check("missing, extra, and duplicate rollback coverage are blocked", () => {
      for (const result of coverageResults) {
        assert.equal(result.decision, "controlled_apply_execution_gate_blocked",
          JSON.stringify(result));
        assert.ok(result.issues.some((issue) =>
          issue.code === "controlled_apply_execution_rollback_coverage_incomplete"));
      }
    });

    const wrongActionInput = reseal(policyFixture, (manifest) => {
      const entry = manifest.entries.find((candidate) => candidate.filePath === "src/new.txt");
      entry.rollbackAction = "restore_regular_file";
    }, "wrong-action");
    const wrongModeInput = reseal(policyFixture, (manifest) => {
      const entry = manifest.entries.find((candidate) => candidate.filePath === "src/a.txt");
      entry.baseMode = "120000";
    }, "wrong-mode");
    const missingPayloadInput = reseal(policyFixture, (manifest) => {
      const entry = manifest.entries.find((candidate) => candidate.filePath === "src/a.txt");
      entry.payloadObjectHash = null;
      entry.payloadRelativePath = null;
    }, "missing-payload");
    const malformedCoverageResults = await Promise.all([
      wrongActionInput, wrongModeInput, missingPayloadInput
    ].map((candidate) => evaluateControlledApplyExecutionGate(candidate)));
    check("wrong action, mode, and missing payload coverage never authorize", () => {
      for (const result of malformedCoverageResults) {
        assert.notEqual(result.decision, "controlled_apply_execution_gate_ready");
        assert.equal(result.authorization, null);
        assert.notEqual(result.summary.rollbackCoverageHash,
          ready.summary.rollbackCoverageHash);
      }
    });

    const handoffBindingInput = reseal(policyFixture, (manifest) => {
      manifest.handoffHash = hash("other-handoff");
    }, "handoff-binding");
    const consumptionBindingInput = reseal(policyFixture, (manifest) => {
      manifest.consumptionKey = hash("other-consumption");
    }, "consumption-binding");
    const inspectionBindingInput = reseal(policyFixture, (manifest) => {
      manifest.inspectionHash = hash("other-inspection");
    }, "inspection-binding");
    const targetBindingInput = reseal(policyFixture, (manifest) => {
      manifest.target.baseRevisionHash = hash("other-target");
    }, "target-binding");
    const bindingResults = await Promise.all([
      handoffBindingInput, consumptionBindingInput, inspectionBindingInput, targetBindingInput
    ].map((candidate) => evaluateControlledApplyExecutionGate(candidate)));
    check("bundle handoff, consumption, inspection, and target bindings cannot diverge", () => {
      for (const result of bindingResults) {
        assert.notEqual(result.decision, "controlled_apply_execution_gate_ready");
      }
    });

    const unsupported = reseal(policyFixture, (manifest) => {
      manifest.entries[0].rollbackAction = "future_action";
    }, "unsupported");
    const unsupportedResult = await evaluateControlledApplyExecutionGate(unsupported);
    check("unsupported rollback action requires review", () => {
      assert.equal(unsupportedResult.decision,
        "controlled_apply_execution_gate_needs_review");
    });

    const invalidAndConsumed = clone(policyFixture);
    invalidAndConsumed.consumptionStatus = "already_consumed";
    invalidAndConsumed.rollbackBundleManifest.bundleManifestHash = hash("invalid-precedence");
    const invalidPrecedence = await evaluateControlledApplyExecutionGate(invalidAndConsumed);
    const reviewAndBlocked = await evaluateControlledApplyExecutionGate({
      ...unsupported, consumptionStatus: "unknown"
    });
    write(policyFixture.repositoryPath, "precedence-drift.txt", "drift");
    const invalidBundleAndDirtyRepository = await evaluateControlledApplyExecutionGate({
      ...policyFixture, bundleDirectoryPath: tamperedPath
    });
    fs.unlinkSync(path.join(policyFixture.repositoryPath, "precedence-drift.txt"));
    check("decision precedence is invalid over review over blocked over ready", () => {
      assert.equal(invalidPrecedence.decision,
        "controlled_apply_execution_gate_invalid");
      assert.equal(reviewAndBlocked.decision,
        "controlled_apply_execution_gate_needs_review");
      assert.equal(invalidBundleAndDirtyRepository.decision,
        "controlled_apply_execution_gate_invalid");
    });

    const authorizationFields = [
      ["governedArtifactHash"], ["handoffHash"], ["consumptionKey"],
      ["mutation", "mutationHash"], ["mutation", "changedFiles"],
      ["target", "repositoryIdentityHash"], ["target", "baseRevisionHash"],
      ["target", "worktreeStateHash"], ["evidence", "expectedInspectionHash"],
      ["evidence", "rollbackBundleManifestHash"],
      ["evidence", "rollbackCoverageHash"], ["gatePolicyHash"], ["authorizationHash"]
    ];
    const authorizationTamperResults = [];
    for (const fieldPath of authorizationFields) {
      const authorization = clone(ready.authorization);
      let cursor = authorization;
      for (const key of fieldPath.slice(0, -1)) cursor = cursor[key];
      const final = fieldPath.at(-1);
      cursor[final] = final === "changedFiles" ? ["different.ts"] : hash(`auth:${fieldPath.join(".")}`);
      authorizationTamperResults.push(await verifyControlledApplyExecutionAuthorization({
        authorization, gateInput: policyFixture
      }));
    }
    check("authorization tampering is invalid without mutating production evidence", () => {
      for (const result of authorizationTamperResults) {
        assert.equal(result.decision,
          "controlled_apply_execution_authorization_invalid");
      }
      assert.equal(ready.authorization.authorizationHash,
        hashCanonicalJson((({ authorizationHash, ...rest }) => rest)(ready.authorization)));
    });

    const changedMutationVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: {
        ...policyFixture,
        mutation: { ...clone(mutation), summary: "changed after authorization" }
      }
    });
    const changedHandoffVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: { ...policyFixture, handoff: invalidHandoff.handoff }
    });
    const changedBundleVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: { ...policyFixture, bundleDirectoryPath: tamperedPath }
    });
    const unknownVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: { ...policyFixture, consumptionStatus: "unknown" }
    });
    const changedPolicyVerification = await verifyControlledApplyExecutionAuthorization({
      authorization: ready.authorization,
      gateInput: {
        ...policyFixture,
        policy: {
          ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY,
          requireCurrentArtifact: false
        }
      }
    });
    check("current mutation, handoff, bundle, policy boundary, and registry changes revoke eligibility", () => {
      for (const result of [
        changedMutationVerification, changedHandoffVerification,
        changedBundleVerification, unknownVerification, changedPolicyVerification
      ]) {
        assert.notEqual(result.decision,
          "controlled_apply_execution_authorization_current");
        assert.equal(result.firstWriteEligible, false);
      }
    });

    const explicitPolicy = await evaluateControlledApplyExecutionGate({
      ...policyFixture,
      policy: { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY }
    });
    check("omitted and exact explicit strict policies are equivalent", () => {
      assert.equal(explicitPolicy.decision, "controlled_apply_execution_gate_ready");
      assert.equal(explicitPolicy.authorization.gatePolicyHash,
        ready.authorization.gatePolicyHash);
    });
    for (const field of Object.keys(DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY)
      .filter((field) => field !== "policyVersion")) {
      await assert.rejects(() => evaluateControlledApplyExecutionGate({
        ...policyFixture,
        policy: { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY, [field]: false }
      }), TypeError, field);
    }
    await assert.rejects(() => evaluateControlledApplyExecutionGate({
      ...policyFixture,
      policy: { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY, unknown: true }
    }), TypeError);
    const missingPolicy = { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY };
    delete missingPolicy.requireCurrentArtifact;
    await assert.rejects(() => evaluateControlledApplyExecutionGate({
      ...policyFixture, policy: missingPolicy
    }), TypeError);
    const accessorPolicy = { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY };
    Object.defineProperty(accessorPolicy, "requireCurrentArtifact", {
      enumerable: true, get() { throw new Error("policy getter"); }
    });
    const accessorPolicyResult = await evaluateControlledApplyExecutionGate({
      ...policyFixture, policy: accessorPolicy
    });
    const symbolPolicy = { ...DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY };
    symbolPolicy[Symbol("policy-secret")] = true;
    const symbolPolicyResult = await evaluateControlledApplyExecutionGate({
      ...policyFixture, policy: symbolPolicy
    });
    assert.equal(accessorPolicyResult.decision, "controlled_apply_execution_gate_invalid");
    assert.equal(symbolPolicyResult.decision, "controlled_apply_execution_gate_invalid");
    for (const [field, value] of [
      ["timeoutMs", 0], ["timeoutMs", 120001],
      ["maxGitOutputBytes", 50 * 1024 * 1024 + 1],
      ["maxEntryBytes", 100 * 1024 * 1024 + 1],
      ["maxBundleBytes", 1024 * 1024 * 1024 + 1]
    ]) {
      await assert.rejects(() => evaluateControlledApplyExecutionGate({
        ...policyFixture, [field]: value
      }), TypeError, field);
    }
    check("every policy relaxation and unknown field is rejected", () => {});

    class ExoticGateInput {}
    const malformed = [
      null, undefined, 1, "bad", [], new Date(), new Map(), new Set(), new ExoticGateInput()
    ];
    for (const value of malformed) {
      const result = await evaluateControlledApplyExecutionGate(value);
      assert.equal(result.decision, "controlled_apply_execution_gate_invalid");
    }
    const cyclic = clone(policyFixture); cyclic.self = cyclic;
    const cyclicResult = await evaluateControlledApplyExecutionGate(cyclic);
    const accessor = clone(policyFixture);
    Object.defineProperty(accessor, "artifact", { enumerable: true, get() {
      throw new Error("getter");
    } });
    const accessorResult = await evaluateControlledApplyExecutionGate(accessor);
    const symbol = clone(policyFixture); symbol[Symbol("secret")] = true;
    const symbolResult = await evaluateControlledApplyExecutionGate(symbol);
    const unknownTop = { ...clone(policyFixture), unknown: true };
    const unknownTopResult = await evaluateControlledApplyExecutionGate(unknownTop);
    const missingTop = clone(policyFixture); delete missingTop.consumptionStatus;
    const missingTopResult = await evaluateControlledApplyExecutionGate(missingTop);
    const inherited = Object.create(clone(policyFixture));
    const inheritedResult = await evaluateControlledApplyExecutionGate(inherited);
    check("structure attacks fail closed without throwing", () => {
      for (const result of [
        cyclicResult, accessorResult, symbolResult, unknownTopResult,
        missingTopResult, inheritedResult
      ]) {
        assert.equal(result.decision, "controlled_apply_execution_gate_invalid");
      }
    });

    check("results leak no paths, payloads, commands, prompts, or credentials", () => {
      const serialized = JSON.stringify({ ready, immediate });
      for (const sentinel of [
        policyFixture.repositoryPath, policyFixture.bundleDirectoryPath,
        "X3_SOURCE_CONTENT_SENTINEL", "X3_ROLLBACK_PAYLOAD_SENTINEL",
        "X3_MUTATION_PAYLOAD_SENTINEL", "X3_PATCH_CONTENT_SENTINEL",
        "ADMIN_PROMPT_SENTINEL", "SHADOW_PROMPT_SENTINEL", "MODEL_OUTPUT_SENTINEL",
        "STDOUT_SENTINEL", "STDERR_SENTINEL", "CREDENTIAL_SENTINEL",
        "ENVIRONMENT_SECRET_SENTINEL", "git command", "shell command"
      ]) assert.equal(serialized.includes(sentinel), false, sentinel);
    });

    check("runtime exports the complete X.3 value API", () => {
      assert.equal(runtime.CONTROLLED_APPLY_EXECUTION_GATE_VERSION, "1");
      assert.equal(typeof runtime.DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY, "object");
      assert.equal(typeof runtime.evaluateControlledApplyExecutionGate, "function");
      assert.equal(typeof runtime.verifyControlledApplyExecutionAuthorization, "function");
      assert.equal(Object.isFrozen(runtime.DEFAULT_CONTROLLED_APPLY_EXECUTION_GATE_POLICY), true);
    });

    check("production gate contains no filesystem, shell, or process execution API", () => {
      const source = fs.readFileSync(path.join(__dirname, "../packages/product-runtime/src/controlled-apply-execution-gate.ts"), "utf8");
      for (const forbidden of [
        "node:fs", "node:child_process", "writeFile", "appendFile", "execFile", "spawn("
      ]) assert.equal(source.includes(forbidden), false, forbidden);
    });
  } finally {
    for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
  }

  assert.ok(checks >= 20);
  console.log(`controlled apply execution gate smoke passed (${checks} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
