#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "X6 Fixture", GIT_AUTHOR_EMAIL: "x6@example.invalid",
  GIT_COMMITTER_NAME: "X6 Fixture", GIT_COMMITTER_EMAIL: "x6@example.invalid"
};
function git(cwd, args) { return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }); }
function write(root, file, content) {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content); fs.chmodSync(target, 0o644);
}
function gitMetadata(root) {
  const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).trim());
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    index: fs.readFileSync(path.join(gitDir, "index")).toString("hex"),
    refs: git(root, ["show-ref"]), tags: git(root, ["tag", "--list"]),
    config: fs.readFileSync(path.join(gitDir, "config")).toString("hex")
  };
}
function deepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value); assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child, seen);
}
async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
async function waitForContent(file, expected, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected) {
    if (Date.now() - started > timeoutMs) throw new Error(`content timeout: ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function directoryHash(directory, hashCanonicalJson) {
  function walk(current, relative = "") {
    const values = [];
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name); const rel = path.posix.join(relative, name);
      const stat = fs.lstatSync(file);
      values.push(stat.isDirectory() ? [rel, "directory", walk(file, rel)] :
        [rel, "file", fs.readFileSync(file).toString("hex")]);
    }
    return values;
  }
  return hashCanonicalJson(walk(directory));
}

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_TRANSACTION_RECOVERY_VERSION,
    DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY,
    buildControlledApplyHandoff, buildTemporaryWorkspaceExecutionVerificationEvidence,
    canonicalizeJson, computeGovernedMutationHash,
    evaluateControlledApplyExecutionGate, executeControlledRepositoryApply,
    executeControlledPostApplyValidation, executeControlledTransactionRecovery, hashCanonicalJson,
    inspectControlledRepository, inspectControlledTransactionRecovery,
    materializeControlledRollbackBundle, restoreControlledRepositoryFromRollbackBundle,
    verifyControlledTransactionRecoveryReceipt, verifyTemporaryWorkspaceExecution
  } = runtime;
  const roots = []; let checks = 0;
  const check = (name, fn) => { fn(); checks += 1; console.log(`[ok] ${name}`); };
  const clone = (value) => structuredClone(value);
  const hash = (label) => hashCanonicalJson({ label });

  function artifactFor(mutation, executionHash = hash("execution")) {
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash: computeGovernedMutationHash("repair_draft", mutation),
        changedFiles: [...mutation.touchedFiles], patchDryRunResultHash: hash("dry-run"),
        temporaryApplyResultHash: hash("temp-apply"), executionVerificationResultHash: executionHash,
        stageEvents: {
          mutationSourceEventId: "run:event:000005", patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008", executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010", deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012", adminAgentEventId: null,
          approvalRouterEventId: "run:event:000013"
        }
      },
      evidence: {
        runId: `x6-${Math.random()}`, objectiveHash: hash("objective"),
        preShadowLedgerRootHash: hash("pre-root"), preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash("trace"), observationHash: hash("observation"),
        governanceHash: hash("governance"), adminInvocationPolicyHash: hash("invocation-policy"),
        adminInvocationAssessmentHash: hash("invocation-assessment"), adminDecisionHash: null,
        routeHash: hash("route"), governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy-v2"), finalLedgerRootHash: hash("final-root"),
        finalLedgerEventCount: 13
      },
      decisions: {
        phaseVFinalDecision: "temp_validation_passed", shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid", governanceDecision: "governance_passed",
        adminInvocationMode: "conditional", adminInvocationDecision: "admin_invocation_skipped",
        adminInvocationSkipKind: "clean_path", adminResolutionKind: "verified_policy_skip",
        adminStageDecision: "admin_skipped_by_policy", adminValidationDecision: null,
        adminDecision: null, routerValidationDecision: "approval_route_valid", workflowRoute: "auto_continue"
      },
      applyEligibility: { eligible: true, reasonCodes: [] }
    };
    return { ...material, governedArtifactHash: hashCanonicalJson(material) };
  }
  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId, objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash, changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash: artifact.change.executionVerificationResultHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash, governanceHash: artifact.evidence.governanceHash,
      adminInvocationPolicyHash: artifact.evidence.adminInvocationPolicyHash,
      adminInvocationAssessmentHash: artifact.evidence.adminInvocationAssessmentHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash, routeHash: artifact.evidence.routeHash,
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }
  async function fixture({ files = ["src/a.txt"], apply = true, withPhaseV = false,
    validationFails = false, largeMutation = false } = {}) {
    const repositoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x6-repo-")));
    const bundleParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x6-bundle-")));
    const registryDirectoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x6-registry-")));
    const validationWorkspaceParentPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x6-workspaces-")));
    roots.push(repositoryPath, bundleParent, registryDirectoryPath, validationWorkspaceParentPath);
    git(repositoryPath, ["init", "--quiet"]);
    for (const [index, file] of files.entries()) write(repositoryPath, file, `X6_BASELINE_${index}\n`);
    if (validationFails) write(repositoryPath, "fail-validation", "fail\n");
    git(repositoryPath, ["add", "--", "."]); git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
    const mutation = {
      role: "remask", target: "repairDraft", summary: "X6_MUTATION_SENTINEL",
      claims: files.map((file, index) => ({ type: "repair_draft", file,
        proposedPatch: largeMutation ? `${index}`.repeat(2 * 1024 * 1024) : `X6_APPLIED_${index}\n` })),
      touchedFiles: [...files].sort(), confidence: 0.9
    };
    let phaseVExecutionSpecification = null; let phaseVExecutionVerification = null;
    if (withPhaseV) {
      phaseVExecutionSpecification = {
        commands: [{ id: "validate", executable: "node", args: ["-e",
          "if(require('fs').existsSync('fail-validation'))setTimeout(()=>process.exit(7),200)"] }],
        allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
        maxTimeoutMs: 120000, maxOutputChars: 20000
      };
      const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x6-phase-v-")));
      roots.push(workspace);
      for (const [index, file] of files.entries()) write(workspace, file, `X6_APPLIED_${index}\n`);
      const prior = verifyTemporaryWorkspaceExecution({
        tempWorkspacePath: workspace, tempApplyDecision: "temp_apply_ready",
        tempWorkspaceCleanedUp: false, ...phaseVExecutionSpecification
      });
      assert.equal(prior.decision, "temp_validation_passed", JSON.stringify(prior));
      phaseVExecutionVerification = buildTemporaryWorkspaceExecutionVerificationEvidence(
        phaseVExecutionSpecification, prior, true
      );
    }
    const inspected = await inspectControlledRepository({ repositoryPath, changedFiles: mutation.touchedFiles });
    assert.equal(inspected.decision, "repository_inspection_ready");
    const artifact = artifactFor(mutation,
      phaseVExecutionVerification?.verificationResultHash ?? hash("execution"));
    const currentFreshnessSnapshot = freshnessFrom(artifact);
    const handoffResult = buildControlledApplyHandoff({
      artifact, currentFreshnessSnapshot, mutation, target: inspected.inspection.target
    });
    assert.equal(handoffResult.decision, "controlled_apply_handoff_ready");
    const bundleDirectoryPath = path.join(bundleParent, "bundle");
    const bundle = await materializeControlledRollbackBundle({
      repositoryPath, bundleDirectoryPath, changedFiles: mutation.touchedFiles,
      expectedInspection: inspected.inspection, handoff: handoffResult.handoff,
      artifact, currentFreshnessSnapshot, mutation, consumptionStatus: "not_consumed"
    });
    assert.equal(bundle.decision, "rollback_bundle_ready", JSON.stringify(bundle));
    const gateInput = {
      repositoryPath, bundleDirectoryPath, changedFiles: [...mutation.touchedFiles], artifact,
      currentFreshnessSnapshot, mutation, handoff: handoffResult.handoff,
      expectedInspection: inspected.inspection, rollbackBundleManifest: bundle.manifest,
      rollbackBundleReceipt: bundle.receipt, consumptionStatus: "not_consumed"
    };
    const gate = await evaluateControlledApplyExecutionGate(gateInput);
    assert.equal(gate.decision, "controlled_apply_execution_gate_ready", JSON.stringify(gate));
    let applied = null;
    if (apply) {
      applied = await executeControlledRepositoryApply({
        authorization: gate.authorization, gateInput, registryDirectoryPath
      });
      assert.equal(applied.decision, "controlled_repository_apply_succeeded", JSON.stringify(applied));
    }
    return { authorization: gate.authorization, gateInput, registryDirectoryPath,
      validationWorkspaceParentPath, applied, phaseVExecutionSpecification,
      phaseVExecutionVerification };
  }
  function input(value, extra = {}) {
    return {
      repositoryPath: value.gateInput.repositoryPath,
      bundleDirectoryPath: value.gateInput.bundleDirectoryPath,
      registryDirectoryPath: value.registryDirectoryPath,
      validationWorkspaceParentPath: value.validationWorkspaceParentPath,
      authorization: value.authorization, gateInput: value.gateInput,
      consumptionKey: value.authorization.consumptionKey, ...extra
    };
  }
  function claim(value) {
    return path.join(value.registryDirectoryPath, "claims", value.authorization.consumptionKey.slice(7));
  }
  function validation(value) {
    return path.join(value.registryDirectoryPath, "validations", value.authorization.consumptionKey.slice(7));
  }
  function executeX5(value) {
    return executeControlledPostApplyValidation({
      applyReceipt: value.applied.receipt, authorization: value.authorization,
      gateInput: value.gateInput, registryDirectoryPath: value.registryDirectoryPath,
      validationWorkspaceParentPath: value.validationWorkspaceParentPath,
      phaseVExecutionSpecification: value.phaseVExecutionSpecification,
      phaseVExecutionVerification: value.phaseVExecutionVerification
    });
  }
  function executeX4(value) {
    return executeControlledRepositoryApply({
      authorization: value.authorization, gateInput: value.gateInput,
      registryDirectoryPath: value.registryDirectoryPath
    });
  }
  async function makePrewrite(value) {
    const restored = await restoreControlledRepositoryFromRollbackBundle({ gateInput: value.gateInput });
    assert.equal(restored.baselineRestored, true);
    for (const name of ["WRITE_STARTED", "apply-receipt.json", "COMMITTED"]) fs.rmSync(path.join(claim(value), name), { force: true });
    fs.rmSync(path.join(claim(value), "steps"), { recursive: true, force: true });
  }
  function makeWriteIncomplete(value) {
    for (const name of ["apply-receipt.json", "COMMITTED"]) fs.rmSync(path.join(claim(value), name), { force: true });
    fs.rmSync(path.join(claim(value), "steps"), { recursive: true, force: true });
  }

  try {
    const missing = await fixture({ apply: false });
    const missingInspection = await inspectControlledTransactionRecovery(input(missing));
    check("missing X.4 claim is invalid and never replaced", () => {
      assert.equal(missingInspection.decision, "controlled_transaction_recovery_inspection_invalid");
      assert.equal(missingInspection.summary.x4State, "x4_claim_missing");
      assert.equal(fs.existsSync(claim(missing)), false); deepFrozen(missingInspection);
    });

    const x4RolledBack = await fixture({
      files: ["src/a.txt", "src/z.txt"], apply: false, largeMutation: true
    });
    const rolledExternal = path.join(os.tmpdir(), `x6-rolled-external-${Date.now()}`);
    fs.writeFileSync(rolledExternal, "EXTERNAL"); roots.push(rolledExternal);
    const x4RolledPromise = executeX4(x4RolledBack);
    await waitForFile(path.join(claim(x4RolledBack), "WRITE_STARTED"));
    fs.unlinkSync(path.join(x4RolledBack.gateInput.repositoryPath, "src/z.txt"));
    fs.symlinkSync(rolledExternal, path.join(x4RolledBack.gateInput.repositoryPath, "src/z.txt"));
    const x4RolledResult = await x4RolledPromise;
    assert.equal(x4RolledResult.decision, "controlled_repository_apply_rolled_back",
      JSON.stringify(x4RolledResult));
    const x4RolledRecovery = await executeControlledTransactionRecovery(input(x4RolledBack));
    check("verified X.4 ROLLED_BACK state needs no recovery and retains its marker", () => {
      assert.equal(x4RolledRecovery.decision, "controlled_transaction_recovery_not_required",
        JSON.stringify(x4RolledRecovery));
      assert.equal(x4RolledRecovery.summary.x4State, "x4_rolled_back");
      assert.equal(fs.existsSync(path.join(claim(x4RolledBack), "ROLLED_BACK")), true);
    });

    const x4RollbackFailed = await fixture({
      files: ["src/a.txt", "src/z.txt"], apply: false, largeMutation: true
    });
    const failedEntry = x4RollbackFailed.gateInput.rollbackBundleManifest.entries
      .find((entry) => entry.filePath === "src/a.txt");
    const failedPayload = path.join(x4RollbackFailed.gateInput.bundleDirectoryPath,
      failedEntry.payloadRelativePath);
    const failedPayloadBytes = fs.readFileSync(failedPayload);
    const failedExternal = path.join(os.tmpdir(), `x6-failed-external-${Date.now()}`);
    fs.writeFileSync(failedExternal, "EXTERNAL"); roots.push(failedExternal);
    const x4FailedPromise = executeX4(x4RollbackFailed);
    await waitForFile(path.join(claim(x4RollbackFailed), "WRITE_STARTED"));
    fs.unlinkSync(path.join(x4RollbackFailed.gateInput.repositoryPath, "src/z.txt"));
    fs.symlinkSync(failedExternal, path.join(x4RollbackFailed.gateInput.repositoryPath, "src/z.txt"));
    fs.unlinkSync(failedPayload);
    const x4FailedResult = await x4FailedPromise;
    assert.equal(x4FailedResult.decision, "controlled_repository_apply_rollback_failed",
      JSON.stringify(x4FailedResult));
    fs.writeFileSync(failedPayload, failedPayloadBytes, { mode: 0o600 });
    const x4FailedRecovery = await executeControlledTransactionRecovery(input(x4RollbackFailed));
    check("X.4 ROLLBACK_FAILED state creates a new X.6 attempt and restores baseline", () => {
      assert.equal(x4FailedRecovery.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(x4FailedRecovery));
      assert.equal(x4FailedRecovery.summary.x4State, "x4_rollback_failed");
      assert.equal(fs.existsSync(path.join(claim(x4RollbackFailed), "ROLLBACK_FAILED")), true);
      assert.equal(fs.readFileSync(path.join(x4RollbackFailed.gateInput.repositoryPath,
        "src/a.txt"), "utf8"), "X6_BASELINE_0\n");
    });

    const committed = await fixture();
    const committedBefore = fs.readFileSync(path.join(committed.gateInput.repositoryPath, "src/a.txt"), "utf8");
    const committedResult = await executeControlledTransactionRecovery(input(committed));
    check("committed X.4 without X.5 awaits normal validation without recovery evidence", () => {
      assert.equal(committedResult.decision, "controlled_transaction_recovery_awaiting_validation", JSON.stringify(committedResult));
      assert.equal(committedResult.summary.recoveryAttemptCreated, false);
      assert.equal(fs.existsSync(path.join(committed.registryDirectoryPath, "recoveries")), false);
      assert.equal(fs.readFileSync(path.join(committed.gateInput.repositoryPath, "src/a.txt"), "utf8"), committedBefore);
    });

    const finalizedX5 = await fixture({ withPhaseV: true });
    const finalizedX5Result = await executeX5(finalizedX5);
    assert.equal(finalizedX5Result.decision, "controlled_post_apply_validation_finalized",
      JSON.stringify(finalizedX5Result));
    const finalizedRecovery = await executeControlledTransactionRecovery(input(finalizedX5));
    check("verified X.5 finalized state requires no recovery", () => {
      assert.equal(finalizedRecovery.decision, "controlled_transaction_recovery_not_required",
        JSON.stringify(finalizedRecovery));
      assert.equal(finalizedRecovery.summary.x5State, "x5_finalized");
      assert.equal(finalizedRecovery.summary.recoveryAttemptCreated, false);
    });

    const intentOnly = await fixture({ withPhaseV: true });
    const intentOnlyX5 = await executeX5(intentOnly);
    assert.equal(intentOnlyX5.decision, "controlled_post_apply_validation_finalized");
    for (const name of ["VALIDATION_STARTED", "validation-result.json", "final-receipt.json", "FINALIZED"]) {
      fs.rmSync(path.join(validation(intentOnly), name), { force: true });
    }
    const intentOriginalHash = directoryHash(validation(intentOnly), hashCanonicalJson);
    const intentRecovery = await executeControlledTransactionRecovery(input(intentOnly));
    check("X.5 intent-only incomplete state restores X.1 and preserves validation evidence", () => {
      assert.equal(intentRecovery.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(intentRecovery));
      assert.equal(intentRecovery.summary.x5State, "x5_intent_created_prevalidation_incomplete");
      assert.equal(directoryHash(validation(intentOnly), hashCanonicalJson), intentOriginalHash);
      assert.equal(fs.readFileSync(path.join(intentOnly.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X6_BASELINE_0\n");
    });

    const startedX5 = await fixture({ withPhaseV: true });
    const startedX5Final = await executeX5(startedX5);
    assert.equal(startedX5Final.decision, "controlled_post_apply_validation_finalized");
    for (const name of ["validation-result.json", "final-receipt.json", "FINALIZED"]) {
      fs.rmSync(path.join(validation(startedX5), name), { force: true });
    }
    const startedRecovery = await executeControlledTransactionRecovery(input(startedX5));
    check("X.5 VALIDATION_STARTED incomplete state is never accepted as passed", () => {
      assert.equal(startedRecovery.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(startedRecovery));
      assert.equal(startedRecovery.summary.x5State, "x5_validation_started_incomplete");
    });

    const rolledBackX5 = await fixture({ withPhaseV: true, validationFails: true });
    const rolledBackX5Result = await executeX5(rolledBackX5);
    assert.equal(rolledBackX5Result.decision, "controlled_post_apply_validation_rolled_back",
      JSON.stringify(rolledBackX5Result));
    const rolledBackRecovery = await executeControlledTransactionRecovery(input(rolledBackX5));
    check("verified X.5 validation rollback requires no further action", () => {
      assert.equal(rolledBackRecovery.decision, "controlled_transaction_recovery_not_required",
        JSON.stringify(rolledBackRecovery));
      assert.equal(rolledBackRecovery.summary.x5State, "x5_validation_rolled_back");
      assert.equal(rolledBackRecovery.summary.repositoryMatchesX1Baseline, true);
    });

    const rollbackFailedX5 = await fixture({ withPhaseV: true, validationFails: true });
    const rollbackObject = rollbackFailedX5.gateInput.rollbackBundleManifest.entries[0].payloadRelativePath;
    const rollbackObjectPath = path.join(rollbackFailedX5.gateInput.bundleDirectoryPath, rollbackObject);
    const rollbackObjectBytes = fs.readFileSync(rollbackObjectPath);
    const rollbackFailedPromise = executeX5(rollbackFailedX5);
    await waitForFile(path.join(validation(rollbackFailedX5), "VALIDATION_STARTED"));
    fs.appendFileSync(rollbackObjectPath, "tamper");
    const rollbackFailedX5Result = await rollbackFailedPromise;
    assert.equal(rollbackFailedX5Result.decision,
      "controlled_post_apply_validation_rollback_failed", JSON.stringify(rollbackFailedX5Result));
    fs.writeFileSync(rollbackObjectPath, rollbackObjectBytes);
    const recoveredRollbackFailure = await executeControlledTransactionRecovery(input(rollbackFailedX5));
    check("X.5 rollback-failed state can be safely recovered after bundle integrity is restored", () => {
      assert.equal(recoveredRollbackFailure.decision,
        "controlled_transaction_recovery_rolled_back", JSON.stringify(recoveredRollbackFailure));
      assert.equal(recoveredRollbackFailure.summary.x5State, "x5_validation_rollback_failed");
      assert.equal(fs.existsSync(path.join(validation(rollbackFailedX5),
        "VALIDATION_ROLLBACK_FAILED")), true);
    });

    const prewrite = await fixture(); await makePrewrite(prewrite);
    const originalClaimHash = directoryHash(claim(prewrite), hashCanonicalJson);
    const prewriteInput = input(prewrite); const prewriteBefore = clone(prewriteInput);
    const prewriteInspection = await inspectControlledTransactionRecovery(prewriteInput);
    check("valid pre-write incomplete claim derives a no-write closeout plan", () => {
      assert.equal(prewriteInspection.decision, "controlled_transaction_recovery_inspection_ready", JSON.stringify(prewriteInspection));
      assert.equal(prewriteInspection.plan.action, "close_prewrite_claim_without_repository_write");
      assert.equal(prewriteInspection.summary.repositoryWriteRequired, false);
      assert.equal(fs.existsSync(path.join(prewrite.registryDirectoryPath, "recoveries")), false);
    });
    const prewriteResult = await executeControlledTransactionRecovery(prewriteInput);
    check("pre-write closeout is durable and preserves the permanent claim byte-for-byte", () => {
      assert.equal(prewriteResult.decision, "controlled_transaction_recovery_closed_prewrite", JSON.stringify(prewriteResult));
      assert.equal(prewriteResult.receipt.outcome, "abandoned_before_repository_write");
      assert.equal(prewriteResult.summary.terminalMarker, "RECOVERED_NO_WRITE");
      assert.equal(prewriteResult.summary.repositoryWriteAttempted, false);
      assert.equal(directoryHash(claim(prewrite), hashCanonicalJson), originalClaimHash);
      assert.equal(fs.existsSync(claim(prewrite)), true); assert.deepEqual(prewriteInput, prewriteBefore);
      deepFrozen(prewriteResult);
    });
    const prewriteVerification = await verifyControlledTransactionRecoveryReceipt({
      repositoryPath: prewrite.gateInput.repositoryPath,
      registryDirectoryPath: prewrite.registryDirectoryPath,
      receipt: prewriteResult.receipt, authorization: prewrite.authorization,
      expectedInspection: prewrite.gateInput.expectedInspection
    });
    check("RECOVERED_NO_WRITE receipt verifies read-only", () => {
      assert.equal(prewriteVerification.decision, "controlled_transaction_recovery_receipt_current", JSON.stringify(prewriteVerification));
      deepFrozen(prewriteVerification);
    });
    async function copiedRecoveryVerification(label, mutate, receipt = prewriteResult.receipt) {
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `x6-${label}-`)));
      roots.push(parent); const registryDirectoryPath = path.join(parent, "registry");
      fs.cpSync(prewrite.registryDirectoryPath, registryDirectoryPath, { recursive: true });
      const permissionStack = [registryDirectoryPath];
      while (permissionStack.length > 0) {
        const currentPath = permissionStack.pop();
        const metadata = fs.lstatSync(currentPath);

        if (metadata.isSymbolicLink()) {
          throw new Error("Copied registry fixture contains a symbolic link.");
        }

        if (metadata.isDirectory()) {
          fs.chmodSync(currentPath, 0o700);
          for (const name of fs.readdirSync(currentPath)) {
            permissionStack.push(path.join(currentPath, name));
          }
        } else if (metadata.isFile()) {
          fs.chmodSync(currentPath, 0o600);
        } else {
          throw new Error("Copied registry fixture contains an unsupported entry.");
        }
      }
      mutate(registryDirectoryPath);
      return verifyControlledTransactionRecoveryReceipt({
        repositoryPath: prewrite.gateInput.repositoryPath, registryDirectoryPath,
        receipt, authorization: prewrite.authorization,
        expectedInspection: prewrite.gateInput.expectedInspection
      });
    }
    const badReceipt = clone(prewriteResult.receipt); badReceipt.receiptHash = hash("bad-receipt");
    const badReceiptVerification = await copiedRecoveryVerification("bad-receipt", () => {}, badReceipt);
    const noTerminalVerification = await copiedRecoveryVerification("no-terminal", (registry) => {
      fs.unlinkSync(path.join(registry, "recoveries", prewrite.authorization.consumptionKey.slice(7),
        "attempts", "000000", "RECOVERED_NO_WRITE"));
    });
    const intentTamperVerification = await copiedRecoveryVerification("intent-tamper", (registry) => {
      fs.appendFileSync(path.join(registry, "recoveries", prewrite.authorization.consumptionKey.slice(7),
        "attempts", "000000", "recovery-intent.json"), "\n");
    });
    const originalTamperVerification = await copiedRecoveryVerification("original-tamper", (registry) => {
      fs.appendFileSync(path.join(registry, "claims", prewrite.authorization.consumptionKey.slice(7),
        "reservation.json"), "\n");
    });
    check("receipt, intent, terminal, and original registry tampering fail read-only verification", () => {
      assert.equal(badReceiptVerification.decision,
        "controlled_transaction_recovery_receipt_invalid");
      assert.equal(noTerminalVerification.decision,
        "controlled_transaction_recovery_receipt_requires_recovery");
      assert.equal(intentTamperVerification.decision,
        "controlled_transaction_recovery_receipt_invalid");
      assert.ok(["controlled_transaction_recovery_receipt_invalid",
        "controlled_transaction_recovery_receipt_stale"].includes(originalTamperVerification.decision));
    });

    const drift = await fixture(); await makePrewrite(drift);
    write(drift.gateInput.repositoryPath, "unrelated.txt", "UNRELATED_DRIFT\n");
    const driftResult = await executeControlledTransactionRecovery(input(drift));
    check("pre-write claim with unrelated drift requires human recovery", () => {
      assert.equal(driftResult.decision, "controlled_transaction_recovery_needs_review", JSON.stringify(driftResult));
      assert.equal(driftResult.summary.recoveryAttemptCreated, false);
      assert.equal(fs.readFileSync(path.join(drift.gateInput.repositoryPath, "unrelated.txt"), "utf8"), "UNRELATED_DRIFT\n");
    });

    const incomplete = await fixture(); makeWriteIncomplete(incomplete);
    const incompleteClaimHash = directoryHash(claim(incomplete), hashCanonicalJson);
    const incompleteGitMetadata = gitMetadata(incomplete.gateInput.repositoryPath);
    const rollbackResult = await executeControlledTransactionRecovery(input(incomplete));
    check("WRITE_STARTED incomplete transaction restores the exact X.1 baseline", () => {
      assert.equal(rollbackResult.decision, "controlled_transaction_recovery_rolled_back", JSON.stringify(rollbackResult));
      assert.equal(rollbackResult.receipt.outcome, "restored_x1_baseline");
      assert.equal(rollbackResult.summary.rollbackSucceeded, true);
      assert.equal(rollbackResult.summary.terminalMarker, "RECOVERED_ROLLED_BACK");
      assert.equal(fs.readFileSync(path.join(incomplete.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X6_BASELINE_0\n");
      assert.equal(directoryHash(claim(incomplete), hashCanonicalJson), incompleteClaimHash);
      assert.deepEqual(gitMetadata(incomplete.gateInput.repositoryPath), incompleteGitMetadata);
      assert.equal(rollbackResult.summary.gitIndexMutated, false);
      assert.equal(rollbackResult.summary.gitHistoryMutated, false);
      assert.equal(rollbackResult.summary.commitCreated, false);
      assert.equal(rollbackResult.summary.pushExecuted, false);
    });
    const rollbackVerification = await verifyControlledTransactionRecoveryReceipt({
      repositoryPath: incomplete.gateInput.repositoryPath,
      registryDirectoryPath: incomplete.registryDirectoryPath,
      receipt: rollbackResult.receipt, authorization: incomplete.authorization,
      expectedInspection: incomplete.gateInput.expectedInspection
    });
    check("RECOVERED_ROLLED_BACK receipt verifies current baseline", () => {
      assert.equal(rollbackVerification.decision, "controlled_transaction_recovery_receipt_current", JSON.stringify(rollbackVerification));
    });
    const repeated = await executeControlledTransactionRecovery(input(incomplete));
    check("a successful recovery is terminal and cannot rewrite the repository", () => {
      assert.equal(repeated.decision, "controlled_transaction_recovery_not_required", JSON.stringify(repeated));
      assert.equal(repeated.summary.recoveryAttemptCreated, false);
      const attempts = path.join(incomplete.registryDirectoryPath, "recoveries",
        incomplete.authorization.consumptionKey.slice(7), "attempts");
      assert.deepEqual(fs.readdirSync(attempts), ["000000"]);
    });

    const concurrent = await fixture(); makeWriteIncomplete(concurrent);
    const concurrentResults = await Promise.all([
      executeControlledTransactionRecovery(input(concurrent)),
      executeControlledTransactionRecovery(input(concurrent))
    ]);
    check("concurrent recovery calls never perform concurrent repository restoration", () => {
      assert.equal(concurrentResults.filter((result) =>
        result.decision === "controlled_transaction_recovery_rolled_back").length, 1,
      JSON.stringify(concurrentResults));
      assert.ok(concurrentResults.some((result) => [
        "controlled_transaction_recovery_blocked", "controlled_transaction_recovery_not_required",
        "controlled_transaction_recovery_needs_review"
      ].includes(result.decision)), JSON.stringify(concurrentResults));
      assert.equal(fs.readFileSync(path.join(concurrent.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X6_BASELINE_0\n");
    });

    const changedAfterStart = await fixture(); makeWriteIncomplete(changedAfterStart);
    const changedAttempt = path.join(changedAfterStart.registryDirectoryPath, "recoveries",
      changedAfterStart.authorization.consumptionKey.slice(7), "attempts", "000000");
    const changedPromise = executeControlledTransactionRecovery(input(changedAfterStart));
    await waitForFile(path.join(changedAttempt, "RECOVERY_STARTED"));
    write(changedAfterStart.gateInput.repositoryPath, "concurrent.txt", "CONCURRENT_CHANGE\n");
    const changedResult = await changedPromise;
    check("repository state change after RECOVERY_STARTED fails durably without blind rollback", () => {
      assert.equal(changedResult.decision, "controlled_transaction_recovery_failed", JSON.stringify(changedResult));
      assert.equal(changedResult.summary.repositoryWriteAttempted, false);
      assert.equal(changedResult.summary.terminalMarker, "RECOVERY_FAILED");
      assert.equal(fs.readFileSync(path.join(changedAfterStart.gateInput.repositoryPath,
        "concurrent.txt"), "utf8"), "CONCURRENT_CHANGE\n");
    });
    const failedVerification = await verifyControlledTransactionRecoveryReceipt({
      repositoryPath: changedAfterStart.gateInput.repositoryPath,
      registryDirectoryPath: changedAfterStart.registryDirectoryPath,
      receipt: changedResult.receipt, authorization: changedAfterStart.authorization,
      expectedInspection: changedAfterStart.gateInput.expectedInspection
    });
    check("RECOVERY_FAILED receipt verifier requires further recovery", () => {
      assert.equal(failedVerification.decision,
        "controlled_transaction_recovery_receipt_requires_recovery", JSON.stringify(failedVerification));
      assert.equal(failedVerification.summary.recoveryRequired, true);
    });
    fs.unlinkSync(path.join(changedAfterStart.gateInput.repositoryPath, "concurrent.txt"));
    const retriedRecovery = await executeControlledTransactionRecovery(input(changedAfterStart));
    check("a failed attempt remains immutable while a fresh safe inspection permits retry", () => {
      assert.equal(retriedRecovery.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(retriedRecovery));
      assert.equal(retriedRecovery.receipt.attemptIndex, 1);
      assert.equal(fs.existsSync(path.join(changedAttempt, "RECOVERY_FAILED")), true);
      assert.equal(fs.existsSync(path.join(path.dirname(changedAttempt), "000001",
        "RECOVERED_ROLLED_BACK")), true);
    });

    const receiptFailure = await fixture(); makeWriteIncomplete(receiptFailure);
    const receiptFailureAttempt = path.join(receiptFailure.registryDirectoryPath, "recoveries",
      receiptFailure.authorization.consumptionKey.slice(7), "attempts", "000000");
    const receiptFailurePromise = executeControlledTransactionRecovery(input(receiptFailure));
    await waitForFile(path.join(receiptFailureAttempt, "RECOVERY_STARTED"));
    await waitForContent(path.join(receiptFailure.gateInput.repositoryPath, "src/a.txt"),
      "X6_BASELINE_0\n");
    fs.mkdirSync(path.join(receiptFailureAttempt, "recovery-receipt.json"), { mode: 0o700 });
    const receiptFailureResult = await receiptFailurePromise;
    check("receipt persistence failure retains RECOVERY_STARTED and adds RECOVERY_FAILED", () => {
      assert.equal(receiptFailureResult.decision, "controlled_transaction_recovery_failed",
        JSON.stringify(receiptFailureResult));
      assert.equal(receiptFailureResult.summary.repositoryMatchesX1Baseline, true);
      assert.equal(receiptFailureResult.summary.receiptWritten, false);
      assert.equal(receiptFailureResult.summary.terminalMarker, "RECOVERY_FAILED");
      assert.equal(fs.existsSync(path.join(receiptFailureAttempt, "RECOVERY_STARTED")), true);
      assert.equal(fs.existsSync(path.join(receiptFailureAttempt, "RECOVERY_FAILED")), true);
    });

    const cleanupFixture = await fixture({ withPhaseV: true });
    const cleanupX5 = await executeX5(cleanupFixture);
    assert.equal(cleanupX5.decision, "controlled_post_apply_validation_finalized");
    for (const name of ["validation-result.json", "final-receipt.json", "FINALIZED"]) {
      fs.rmSync(path.join(validation(cleanupFixture), name), { force: true });
    }
    const exactWorkspace = path.join(cleanupFixture.validationWorkspaceParentPath,
      `controlled-post-apply-${cleanupFixture.authorization.consumptionKey.slice(7)}.partial`);
    const siblingWorkspace = path.join(cleanupFixture.validationWorkspaceParentPath, "unrelated-sibling");
    fs.mkdirSync(exactWorkspace, { mode: 0o700 }); write(exactWorkspace, "leftover", "LEFTOVER\n");
    fs.mkdirSync(siblingWorkspace, { mode: 0o700 }); write(siblingWorkspace, "keep", "KEEP\n");
    const cleanupResult = await executeControlledTransactionRecovery(input(cleanupFixture));
    check("only the exact deterministic X.5 workspace is cleaned after safe recovery", () => {
      assert.equal(cleanupResult.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(cleanupResult));
      assert.equal(cleanupResult.summary.validationWorkspaceCleanupAttempted, true);
      assert.equal(cleanupResult.summary.validationWorkspaceCleanupSucceeded, true);
      assert.equal(fs.existsSync(exactWorkspace), false);
      assert.equal(fs.readFileSync(path.join(siblingWorkspace, "keep"), "utf8"), "KEEP\n");
    });

    const symlinkCleanup = await fixture({ withPhaseV: true });
    const symlinkCleanupX5 = await executeX5(symlinkCleanup);
    assert.equal(symlinkCleanupX5.decision, "controlled_post_apply_validation_finalized");
    for (const name of ["validation-result.json", "final-receipt.json", "FINALIZED"]) {
      fs.rmSync(path.join(validation(symlinkCleanup), name), { force: true });
    }
    const symlinkTarget = path.join(symlinkCleanup.validationWorkspaceParentPath, "safe-sibling");
    const symlinkWorkspace = path.join(symlinkCleanup.validationWorkspaceParentPath,
      `controlled-post-apply-${symlinkCleanup.authorization.consumptionKey.slice(7)}.partial`);
    fs.mkdirSync(symlinkTarget, { mode: 0o700 }); write(symlinkTarget, "keep", "KEEP_SYMLINK_TARGET\n");
    fs.symlinkSync(symlinkTarget, symlinkWorkspace);
    const symlinkCleanupResult = await executeControlledTransactionRecovery(input(symlinkCleanup));
    check("a symlinked validation workspace is never followed or deleted", () => {
      assert.equal(symlinkCleanupResult.decision, "controlled_transaction_recovery_rolled_back",
        JSON.stringify(symlinkCleanupResult));
      assert.equal(symlinkCleanupResult.summary.validationWorkspaceCleanupAttempted, true);
      assert.equal(symlinkCleanupResult.summary.validationWorkspaceCleanupSucceeded, false);
      assert.equal(fs.lstatSync(symlinkWorkspace).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(path.join(symlinkTarget, "keep"), "utf8"), "KEEP_SYMLINK_TARGET\n");
    });

    const multi = await fixture({ files: ["src/a.txt", "src/b.txt"] }); makeWriteIncomplete(multi);
    write(multi.gateInput.repositoryPath, "src/b.txt", "PARTIAL_DIFFERENT\n");
    const multiResult = await executeControlledTransactionRecovery(input(multi));
    check("multi-file partial apply restores every authorized path", () => {
      assert.equal(multiResult.decision, "controlled_transaction_recovery_rolled_back", JSON.stringify(multiResult));
      assert.equal(fs.readFileSync(path.join(multi.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X6_BASELINE_0\n");
      assert.equal(fs.readFileSync(path.join(multi.gateInput.repositoryPath, "src/b.txt"), "utf8"), "X6_BASELINE_1\n");
    });

    const unsafe = await fixture(); makeWriteIncomplete(unsafe);
    write(unsafe.gateInput.repositoryPath, "outside.txt", "KEEP_ME\n");
    const unsafeResult = await executeControlledTransactionRecovery(input(unsafe));
    check("unexpected paths prevent blind rollback", () => {
      assert.equal(unsafeResult.decision, "controlled_transaction_recovery_needs_review", JSON.stringify(unsafeResult));
      assert.equal(unsafeResult.summary.repositoryWriteAttempted, false);
      assert.equal(fs.readFileSync(path.join(unsafe.gateInput.repositoryPath, "outside.txt"), "utf8"), "KEEP_ME\n");
    });

    const staged = await fixture(); makeWriteIncomplete(staged);
    git(staged.gateInput.repositoryPath, ["add", "--", "src/a.txt"]);
    const stagedResult = await executeControlledTransactionRecovery(input(staged));
    check("index changes prevent automatic rollback", () => {
      assert.equal(stagedResult.decision, "controlled_transaction_recovery_needs_review", JSON.stringify(stagedResult));
      assert.equal(stagedResult.summary.repositoryWriteAttempted, false);
    });

    const headChanged = await fixture(); makeWriteIncomplete(headChanged);
    git(headChanged.gateInput.repositoryPath, ["add", "--", "src/a.txt"]);
    git(headChanged.gateInput.repositoryPath, ["commit", "--quiet", "-m", "concurrent-head"]);
    const headResult = await executeControlledTransactionRecovery(input(headChanged));
    check("HEAD changes prevent automatic rollback", () => {
      assert.equal(headResult.decision, "controlled_transaction_recovery_needs_review",
        JSON.stringify(headResult));
      assert.equal(headResult.inspection.summary.repositoryHeadMatched, false);
      assert.equal(headResult.summary.repositoryWriteAttempted, false);
    });

    for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
      const operationFixture = await fixture(); makeWriteIncomplete(operationFixture);
      const gitDir = path.resolve(operationFixture.gateInput.repositoryPath,
        git(operationFixture.gateInput.repositoryPath, ["rev-parse", "--git-dir"]).trim());
      fs.writeFileSync(path.join(gitDir, operation),
        operation === "BISECT_LOG" ? "bisect\n" : `${git(operationFixture.gateInput.repositoryPath, ["rev-parse", "HEAD"]).trim()}\n`);
      const operationResult = await executeControlledTransactionRecovery(input(operationFixture));
      assert.equal(operationResult.decision, "controlled_transaction_recovery_needs_review",
        `${operation}: ${JSON.stringify(operationResult)}`);
      assert.equal(operationResult.inspection.summary.repositoryOperationInProgress, true, operation);
      assert.equal(operationResult.summary.repositoryWriteAttempted, false, operation);
    }
    check("merge, cherry-pick, revert, and bisect states prevent rollback", () => {});

    for (const directory of ["rebase-merge", "rebase-apply"]) {
      const operationFixture = await fixture(); makeWriteIncomplete(operationFixture);
      const gitDir = path.resolve(operationFixture.gateInput.repositoryPath,
        git(operationFixture.gateInput.repositoryPath, ["rev-parse", "--git-dir"]).trim());
      fs.mkdirSync(path.join(gitDir, directory));
      const operationResult = await executeControlledTransactionRecovery(input(operationFixture));
      assert.equal(operationResult.decision, "controlled_transaction_recovery_needs_review",
        `${directory}: ${JSON.stringify(operationResult)}`);
      assert.equal(operationResult.inspection.summary.repositoryOperationInProgress, true, directory);
    }
    check("rebase operation states prevent rollback", () => {});

    const tampered = await fixture(); makeWriteIncomplete(tampered);
    const object = tampered.gateInput.rollbackBundleManifest.entries[0].payloadRelativePath;
    fs.appendFileSync(path.join(tampered.gateInput.bundleDirectoryPath, object), "tamper");
    const tamperedResult = await executeControlledTransactionRecovery(input(tampered));
    check("rollback bundle tampering causes no repository write", () => {
      assert.ok(["controlled_transaction_recovery_invalid",
        "controlled_transaction_recovery_needs_review"].includes(tamperedResult.decision),
      JSON.stringify(tamperedResult));
      assert.equal(tamperedResult.summary.repositoryWriteAttempted, false);
    });

    const unknownRegistry = await fixture();
    fs.writeFileSync(path.join(claim(unknownRegistry), "UNKNOWN"), "");
    const unknownRegistryResult = await inspectControlledTransactionRecovery(input(unknownRegistry));
    const conflictingRegistry = await fixture();
    fs.writeFileSync(path.join(claim(conflictingRegistry), "ROLLED_BACK"), "", { mode: 0o600 });
    const conflictingRegistryResult = await inspectControlledTransactionRecovery(input(conflictingRegistry));
    const symlinkRegistry = await fixture();
    fs.symlinkSync(path.join(symlinkRegistry.gateInput.repositoryPath, "src/a.txt"),
      path.join(claim(symlinkRegistry), "UNSAFE_LINK"));
    const symlinkRegistryResult = await inspectControlledTransactionRecovery(input(symlinkRegistry));
    check("unknown, conflicting, and symlinked original registry evidence fails closed", () => {
      for (const result of [unknownRegistryResult, conflictingRegistryResult, symlinkRegistryResult]) {
        assert.equal(result.decision, "controlled_transaction_recovery_inspection_invalid",
          JSON.stringify(result));
        assert.equal(result.summary.repositoryWritePerformed, false);
      }
    });

    const x5WithoutClaim = await fixture({ withPhaseV: true });
    const x5WithoutClaimResult = await executeX5(x5WithoutClaim);
    assert.equal(x5WithoutClaimResult.decision, "controlled_post_apply_validation_finalized");
    fs.rmSync(claim(x5WithoutClaim), { recursive: true, force: true });
    const x5WithoutClaimInspection = await inspectControlledTransactionRecovery(input(x5WithoutClaim));
    check("X.5 evidence without its permanent X.4 claim is invalid", () => {
      assert.equal(x5WithoutClaimInspection.decision,
        "controlled_transaction_recovery_inspection_invalid");
      assert.equal(x5WithoutClaimInspection.summary.x4State, "x4_claim_missing");
      assert.equal(x5WithoutClaimInspection.summary.x5State, "x5_registry_invalid");
    });

    const bounded = await fixture();
    const tinyRegistry = await inspectControlledTransactionRecovery(input(bounded, {
      maxRegistryFileBytes: 1
    }));
    const tinyCount = await inspectControlledTransactionRecovery(input(bounded, {
      maxRegistryEntryCount: 1
    }));
    const tinyBundle = await inspectControlledTransactionRecovery(input(bounded, {
      maxEntryBytes: 1
    }));
    check("registry and rollback bundle bounds fail before recovery writes", () => {
      for (const result of [tinyRegistry, tinyCount, tinyBundle]) {
        assert.equal(result.decision, "controlled_transaction_recovery_inspection_invalid",
          JSON.stringify(result));
        assert.equal(result.summary.registryWritePerformed, false);
      }
    });

    const explicit = await fixture(); await makePrewrite(explicit);
    const explicitResult = await executeControlledTransactionRecovery(input(explicit, {
      policy: clone(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY)
    }));
    assert.equal(explicitResult.decision, "controlled_transaction_recovery_closed_prewrite");
    for (const field of Object.keys(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY)) {
      if (field === "policyVersion") continue;
      const policy = clone(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY); policy[field] = false;
      await assert.rejects(() => executeControlledTransactionRecovery(input(explicit, { policy })), TypeError, field);
    }
    check("strict X.6 policy cannot be relaxed", () => {});

    const missingPolicy = clone(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY);
    delete missingPolicy.requirePermanentConsumptionClaim;
    const unknownPolicy = { ...clone(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY), unknown: true };
    assert.equal((await inspectControlledTransactionRecovery(input(committed, {
      policy: missingPolicy
    }))).decision, "controlled_transaction_recovery_inspection_invalid");
    assert.equal((await inspectControlledTransactionRecovery(input(committed, {
      policy: unknownPolicy
    }))).decision, "controlled_transaction_recovery_inspection_invalid");
    await assert.rejects(() => inspectControlledTransactionRecovery(input(committed, {
      timeoutMs: 120001
    })), TypeError);
    await assert.rejects(() => inspectControlledTransactionRecovery(input(committed, {
      maxRegistryEntryCount: 100001
    })), TypeError);
    check("policy shape and trusted numeric hard maximums are enforced", () => {});

    const attemptLimit = await fixture(); makeWriteIncomplete(attemptLimit);
    const attemptLimitInspection = await inspectControlledTransactionRecovery(input(attemptLimit));
    assert.equal(attemptLimitInspection.plan.action, "restore_x1_baseline");
    const attemptsRoot = path.join(attemptLimit.registryDirectoryPath, "recoveries",
      attemptLimit.authorization.consumptionKey.slice(7), "attempts");
    fs.mkdirSync(attemptsRoot, { recursive: true, mode: 0o700 });
    for (const directory of [path.dirname(path.dirname(attemptsRoot)), path.dirname(attemptsRoot), attemptsRoot]) {
      fs.chmodSync(directory, 0o700);
    }
    for (let attemptIndex = 0; attemptIndex < 1000; attemptIndex += 1) {
      const directory = path.join(attemptsRoot, attemptIndex.toString().padStart(6, "0"));
      fs.mkdirSync(directory, { mode: 0o700 });
      const plan = attemptLimitInspection.plan;
      const intentMaterial = {
        intentVersion: "1", attemptIndex, consumptionKey: plan.consumptionKey,
        authorizationHash: plan.authorizationHash, governedArtifactHash: plan.governedArtifactHash,
        handoffHash: plan.handoffHash, mutationHash: plan.mutationHash,
        changedFiles: [...plan.changedFiles], x4State: plan.observedState.x4State,
        x5State: plan.observedState.x5State, action: "restore_x1_baseline",
        expectedInspectionHash: plan.baseline.expectedInspectionHash,
        rollbackManifestHash: plan.baseline.rollbackManifestHash,
        rollbackBundleManifestHash: plan.rollbackBundle.bundleManifestHash,
        rollbackBundleReceiptHash: plan.rollbackBundle.bundleReceiptHash,
        rollbackPayloadRootHash: plan.rollbackBundle.payloadRootHash,
        policyHash: plan.policyHash, recoveryPlanHash: plan.planHash
      };
      const intent = { ...intentMaterial, intentHash: hashCanonicalJson(intentMaterial) };
      const receiptMaterial = {
        receiptVersion: "1", attemptIndex, outcome: "recovery_failed",
        consumptionKey: plan.consumptionKey, authorizationHash: plan.authorizationHash,
        governedArtifactHash: plan.governedArtifactHash, handoffHash: plan.handoffHash,
        mutation: { mutationHash: plan.mutationHash, changedFiles: [...plan.changedFiles],
          changedFileCount: plan.changedFiles.length },
        observedState: { ...plan.observedState },
        recovery: {
          action: "restore_x1_baseline", repositoryWriteAttempted: false,
          repositoryWriteSucceeded: null, rollbackAttempted: false, rollbackSucceeded: null,
          repositoryMatchesX1Baseline: false,
          validationWorkspaceCleanupAttempted: false,
          validationWorkspaceCleanupSucceeded: null
        },
        evidence: {
          recoveryPlanHash: plan.planHash, recoveryIntentHash: intent.intentHash,
          expectedInspectionHash: plan.baseline.expectedInspectionHash, finalInspectionHash: null,
          rollbackManifestHash: plan.baseline.rollbackManifestHash,
          rollbackBundleManifestHash: plan.rollbackBundle.bundleManifestHash,
          rollbackBundleReceiptHash: plan.rollbackBundle.bundleReceiptHash,
          rollbackPayloadRootHash: plan.rollbackBundle.payloadRootHash
        },
        safety: {
          consumptionClaimReleased: false, originalX4RegistryModified: false,
          originalX5RegistryModified: false, gitIndexMutated: false,
          gitHistoryMutated: false, shellExecuted: false, commitCreated: false,
          pushExecuted: false
        }
      };
      const receipt = { ...receiptMaterial, receiptHash: hashCanonicalJson(receiptMaterial) };
      fs.writeFileSync(path.join(directory, "recovery-intent.json"), canonicalizeJson(intent), { mode: 0o600 });
      fs.writeFileSync(path.join(directory, "RECOVERY_STARTED"), "", { mode: 0o600 });
      fs.writeFileSync(path.join(directory, "recovery-receipt.json"), canonicalizeJson(receipt), { mode: 0o600 });
      fs.writeFileSync(path.join(directory, "RECOVERY_FAILED"), "", { mode: 0o600 });
    }
    const attemptLimitResult = await executeControlledTransactionRecovery(input(attemptLimit));
    check("the durable recovery-attempt limit is exactly 1,000", () => {
      assert.equal(attemptLimitResult.decision, "controlled_transaction_recovery_blocked",
        JSON.stringify(attemptLimitResult));
      assert.ok(attemptLimitResult.issues.some((entry) =>
        entry.code === "controlled_transaction_recovery_attempt_limit_exceeded"));
      assert.equal(fs.readdirSync(attemptsRoot).length, 1000);
    });

    const unknownInput = { ...input(committed), unknown: true };
    const missingInput = input(committed); delete missingInput.authorization;
    assert.equal((await inspectControlledTransactionRecovery(unknownInput)).decision,
      "controlled_transaction_recovery_inspection_invalid");
    assert.equal((await inspectControlledTransactionRecovery(missingInput)).decision,
      "controlled_transaction_recovery_inspection_invalid");
    check("unknown and missing input fields are rejected", () => {});

    for (const value of [null, undefined, 1, "bad", [], new Date(), new Map(), new Set()]) {
      const result = await inspectControlledTransactionRecovery(value);
      assert.equal(result.decision, "controlled_transaction_recovery_inspection_invalid");
    }
    const cycle = {}; cycle.self = cycle;
    assert.equal((await inspectControlledTransactionRecovery(cycle)).decision,
      "controlled_transaction_recovery_inspection_invalid");
    const accessor = input(committed);
    Object.defineProperty(accessor, "authorization", { enumerable: true, get() { throw new Error("no"); } });
    assert.equal((await inspectControlledTransactionRecovery(accessor)).decision,
      "controlled_transaction_recovery_inspection_invalid");
    const symbol = { ...input(committed), [Symbol("secret")]: true };
    assert.equal((await inspectControlledTransactionRecovery(symbol)).decision,
      "controlled_transaction_recovery_inspection_invalid");
    check("structure attacks fail closed without throwing", () => {});

    check("results and durable evidence do not leak paths, source, commands, or payloads", () => {
      const serialized = JSON.stringify({ prewriteInspection, prewriteResult, rollbackResult, prewriteVerification });
      for (const sentinel of [
        prewrite.gateInput.repositoryPath, prewrite.registryDirectoryPath,
        prewrite.gateInput.bundleDirectoryPath, prewrite.validationWorkspaceParentPath,
        "X6_BASELINE", "X6_APPLIED", "X6_MUTATION_SENTINEL"
      ]) assert.equal(serialized.includes(sentinel), false, sentinel);
    });

    check("runtime exports X.6 and all primary functions", () => {
      assert.equal(CONTROLLED_TRANSACTION_RECOVERY_VERSION, "1");
      assert.equal(typeof inspectControlledTransactionRecovery, "function");
      assert.equal(typeof executeControlledTransactionRecovery, "function");
      assert.equal(typeof verifyControlledTransactionRecoveryReceipt, "function");
      assert.equal(Object.isFrozen(DEFAULT_CONTROLLED_TRANSACTION_RECOVERY_POLICY), true);
    });

    check("X.6 source invokes no shell or prohibited Git mutation", () => {
      const source = fs.readFileSync(path.join(__dirname,
        "../packages/product-runtime/src/controlled-transaction-recovery.ts"), "utf8");
      assert.equal(source.includes("shell: true"), false); assert.equal(source.includes("exec("), false);
      for (const command of ["add", "apply", "checkout", "clean", "commit", "merge", "rebase",
        "reset", "restore", "rm", "stash", "switch", "update-index", "push"]) {
        assert.equal(source.includes(`[\"${command}\"`), false, command);
      }
    });
  } finally {
    for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(checks >= 15); console.log(`controlled transaction recovery smoke passed (${checks} checks)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
