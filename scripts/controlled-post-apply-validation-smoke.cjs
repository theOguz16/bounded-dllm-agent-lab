const { createHash } = require("node:crypto");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "X5 Fixture",
  GIT_AUTHOR_EMAIL: "x5@example.invalid",
  GIT_COMMITTER_NAME: "X5 Fixture",
  GIT_COMMITTER_EMAIL: "x5@example.invalid"
};
function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}
function write(root, file, content, mode = 0o644) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content); fs.chmodSync(target, mode);
}
function gitMetadata(root) {
  const gitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    index: fs.readFileSync(path.resolve(root, gitDir, "index")).toString("hex"),
    refs: git(root, ["show-ref"]), tags: git(root, ["tag", "--list"]),
    config: fs.readFileSync(path.resolve(root, gitDir, "config")).toString("hex")
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

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_POST_APPLY_VALIDATION_VERSION,
    DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY,
    buildControlledApplyHandoff,
    buildTemporaryWorkspaceExecutionVerificationEvidence,
    computeGovernedMutationHash,
    computeTemporaryWorkspaceExecutionSpecificationHash,
    evaluateControlledApplyExecutionGate,
    executeControlledPostApplyValidation,
    executeControlledRepositoryApply,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    verifyControlledPostApplyFinalReceipt,
    verifyTemporaryWorkspaceExecution
  } = runtime;
  const roots = [];
  let checks = 0;
  const check = (name, fn) => { fn(); checks += 1; console.log(`[ok] ${name}`); };
  const clone = (value) => structuredClone(value);
  const hash = (label) => hashCanonicalJson({ label });

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

  function artifactFor(mode, mutation, evidenceHash) {
    const model = mode === "always";
    const mutationHash = computeGovernedMutationHash("repair_draft", mutation);
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft", mutationHash,
        changedFiles: [...mutation.touchedFiles],
        patchDryRunResultHash: hash(`${mode}:dry-run`),
        temporaryApplyResultHash: hash(`${mode}:temp-apply`),
        executionVerificationResultHash: evidenceHash,
        stageEvents: {
          mutationSourceEventId: "run:event:000005", patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008", executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010",
          deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012",
          adminAgentEventId: model ? "run:event:000013" : null,
          approvalRouterEventId: model ? "run:event:000014" : "run:event:000013"
        }
      },
      evidence: {
        runId: `x5-${mode}-${Date.now()}-${Math.random()}`,
        objectiveHash: hash(`${mode}:objective`),
        preShadowLedgerRootHash: hash(`${mode}:pre-root`), preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash(`${mode}:trace`), observationHash: hash(`${mode}:observation`),
        governanceHash: hash(`${mode}:governance`),
        adminInvocationPolicyHash: hash(`${mode}:invocation-policy`),
        adminInvocationAssessmentHash: hash(`${mode}:invocation-assessment`),
        adminDecisionHash: model ? hash(`${mode}:admin`) : null,
        routeHash: hash(`${mode}:route`), governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy-v2"), finalLedgerRootHash: hash(`${mode}:root`),
        finalLedgerEventCount: model ? 14 : 13
      },
      decisions: {
        phaseVFinalDecision: "temp_validation_passed",
        shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid",
        governanceDecision: "governance_passed", adminInvocationMode: mode,
        adminInvocationDecision: model ? "admin_invocation_required" : "admin_invocation_skipped",
        adminInvocationSkipKind: model ? null : "clean_path",
        adminResolutionKind: model ? "model_decision" : "verified_policy_skip",
        adminStageDecision: model ? "admin_agent_completed" : "admin_skipped_by_policy",
        adminValidationDecision: model ? "admin_decision_valid" : null,
        adminDecision: model ? "admin_auto_approved" : null,
        routerValidationDecision: "approval_route_valid", workflowRoute: "auto_continue"
      },
      applyEligibility: { eligible: true, reasonCodes: [] }
    };
    return { ...material, governedArtifactHash: hashCanonicalJson(material) };
  }

  async function priorEvidence(specification, proposedContent) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x5-phase-v-")));
    write(workspace, "src/a.txt", proposedContent);
    const result = verifyTemporaryWorkspaceExecution({
      tempWorkspacePath: workspace, tempApplyDecision: "temp_apply_ready",
      tempWorkspaceCleanedUp: false, ...specification
    });
    fs.rmSync(workspace, { recursive: true, force: true });
    assert.equal(result.decision, "temp_validation_passed", JSON.stringify(result));
    return buildTemporaryWorkspaceExecutionVerificationEvidence(specification, result, true);
  }

  async function fixture({
    mode = "conditional",
    specification = {
      commands: [{
        id: "validate", executable: "node",
        args: ["-e", "require('fs').mkdirSync('.validation-output',{recursive:true});require('fs').writeFileSync('.validation-output/report.txt','X5_SIDE_EFFECT_SENTINEL')"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    },
    extraTracked = {}
  } = {}) {
    const repositoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x5-repo-")));
    const bundleParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x5-bundle-")));
    const registryDirectoryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x5-registry-")));
    const validationWorkspaceParentPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x5-workspaces-")));
    roots.push(repositoryPath, bundleParent, registryDirectoryPath, validationWorkspaceParentPath);
    git(repositoryPath, ["init", "--quiet"]);
    write(repositoryPath, "src/a.txt", "X5_BASELINE_SENTINEL\n");
    for (const [file, content] of Object.entries(extraTracked)) write(repositoryPath, file, content);
    git(repositoryPath, ["add", "--", "."]);
    git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
    const proposed = "X5_APPLIED_SENTINEL\n";
    const phaseVExecutionVerification = await priorEvidence(specification, proposed);
    const mutation = {
      role: "remask", target: "repairDraft", summary: "X5_MUTATION_SENTINEL",
      claims: [{ type: "repair_draft", claimVersion: "text-file-update/v1", operation: "update", description: "Update fixture.", expectedContentHash: `sha256:${createHash("sha256").update("X5_BASELINE_SENTINEL\n").digest("hex")}`, file: "src/a.txt", newContent: proposed }],
      touchedFiles: ["src/a.txt"], confidence: 0.9
    };
    const inspected = await inspectControlledRepository({
      repositoryPath, changedFiles: mutation.touchedFiles
    });
    assert.equal(inspected.decision, "repository_inspection_ready");
    const artifact = artifactFor(mode, mutation, phaseVExecutionVerification.verificationResultHash);
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
      repositoryPath, bundleDirectoryPath, changedFiles: [...mutation.touchedFiles],
      artifact, currentFreshnessSnapshot, mutation, handoff: handoffResult.handoff,
      expectedInspection: inspected.inspection, rollbackBundleManifest: bundle.manifest,
      rollbackBundleReceipt: bundle.receipt, consumptionStatus: "not_consumed"
    };
    const gated = await evaluateControlledApplyExecutionGate(gateInput);
    assert.equal(gated.decision, "controlled_apply_execution_gate_ready", JSON.stringify(gated));
    const applied = await executeControlledRepositoryApply({
      authorization: gated.authorization, gateInput, registryDirectoryPath
    });
    assert.equal(applied.decision, "controlled_repository_apply_succeeded", JSON.stringify(applied));
    return {
      applyReceipt: applied.receipt, authorization: gated.authorization, gateInput,
      registryDirectoryPath, validationWorkspaceParentPath,
      phaseVExecutionSpecification: specification, phaseVExecutionVerification,
      proposed
    };
  }

  function execute(value, extra = {}) {
    return executeControlledPostApplyValidation({
      applyReceipt: value.applyReceipt,
      authorization: value.authorization,
      gateInput: value.gateInput,
      registryDirectoryPath: value.registryDirectoryPath,
      validationWorkspaceParentPath: value.validationWorkspaceParentPath,
      phaseVExecutionSpecification: value.phaseVExecutionSpecification,
      phaseVExecutionVerification: value.phaseVExecutionVerification,
      ...extra
    });
  }

  try {
    const clean = await fixture();
    const cleanBefore = clone(clean);
    const cleanGitBefore = gitMetadata(clean.gateInput.repositoryPath);
    const finalized = await execute(clean);
    check("clean W.17 policy-skip path finalizes only after isolated Phase V validation", () => {
      assert.equal(CONTROLLED_POST_APPLY_VALIDATION_VERSION, "1");
      assert.equal(finalized.decision, "controlled_post_apply_validation_finalized",
        JSON.stringify(finalized));
      assert.equal(finalized.finalReceipt.outcome, "validated");
      assert.equal(finalized.finalReceipt.adminResolution.resolutionKind, "verified_policy_skip");
      assert.equal(finalized.finalReceipt.adminResolution.adminDecisionHash, null);
      assert.equal(finalized.summary.validationExecutedInRealRepository, false);
      assert.equal(finalized.summary.terminalMarker, "FINALIZED");
      assert.equal(finalized.summary.emergencyRollbackExecuted, false);
      assert.equal(fs.existsSync(path.join(clean.gateInput.repositoryPath,
        ".validation-output/report.txt")), false);
      assert.equal(fs.readFileSync(path.join(clean.gateInput.repositoryPath, "src/a.txt"), "utf8"),
        clean.proposed);
      deepFrozen(finalized);
      assert.deepEqual(gitMetadata(clean.gateInput.repositoryPath), cleanGitBefore);
    });
    const transaction = path.join(
      clean.registryDirectoryPath, "validations", clean.authorization.consumptionKey.slice(7)
    );
    check("X.5 writes a separate durable namespace and cleans its workspace", () => {
      for (const name of [
        "validation-intent.json", "VALIDATION_STARTED", "validation-result.json",
        "final-receipt.json", "FINALIZED"
      ]) assert.equal(fs.existsSync(path.join(transaction, name)), true, name);
      const workspace = path.join(clean.validationWorkspaceParentPath,
        `controlled-post-apply-${clean.authorization.consumptionKey.slice(7)}.partial`);
      assert.equal(fs.existsSync(workspace), false);
      assert.equal(fs.existsSync(path.join(clean.registryDirectoryPath, "claims",
        clean.authorization.consumptionKey.slice(7), "COMMITTED")), true);
      assert.deepEqual(clone(clean), cleanBefore);
    });
    const finalizedVerification = await verifyControlledPostApplyFinalReceipt({
      repositoryPath: clean.gateInput.repositoryPath,
      registryDirectoryPath: clean.registryDirectoryPath,
      receipt: finalized.finalReceipt, applyReceipt: clean.applyReceipt,
      authorization: clean.authorization, expectedInspection: clean.gateInput.expectedInspection
    });
    check("finalized receipt verifies current read-only", () => {
      assert.equal(finalizedVerification.decision,
        "controlled_post_apply_final_receipt_current", JSON.stringify(finalizedVerification));
      deepFrozen(finalizedVerification);
    });

    for (const [name, command, extraTracked] of [
      ["source modification", "require('fs').writeFileSync('src/a.txt','tampered')", {}],
      ["test modification", "if(require('fs').existsSync('tests/other.js'))require('fs').writeFileSync('tests/other.js','process.exit(0)')", { "tests/other.js": "throw new Error('failure');" }],
      ["unapproved output", "require('fs').writeFileSync('unexpected-report.txt','report')", {}],
      ["source deletion", "require('fs').unlinkSync('src/a.txt')", {}],
      ["source replacement with symlink", "require('fs').unlinkSync('src/a.txt');require('fs').symlinkSync('../report.txt','src/a.txt')", {}]
    ]) {
      const malicious = await fixture({
        specification: {
          commands: [{ id: "test", executable: "node", args: ["-e", command] },
            { id: "acceptance", executable: "node", args: ["-e", "if(require('fs').existsSync('tests/other.js'))require('./tests/other.js')"] }],
          allowedExecutables: ["node"]
        },
        extraTracked
      });
      const result = await execute(malicious);
      check(`${name} is blocked by the read-only candidate mount and restores baseline`, () => {
        assert.equal(result.decision, "controlled_post_apply_validation_rolled_back", JSON.stringify(result));
        assert.equal(result.validationRecord.decision, "failed");
        assert.equal(result.summary.validationPassed, false);
        assert.equal(result.summary.emergencyRollbackSucceeded, true);
        assert.equal(result.validationRecord.steps.length, 1);
        assert.equal(result.validationRecord.steps[0].passed, false);
        assert.equal(result.validationRecord.candidateManifestBeforeHash, result.validationRecord.candidateManifestAfterHash);
        assert.equal(fs.readFileSync(path.join(malicious.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X5_BASELINE_SENTINEL\n");
      });
    }
    for (const [target, original, firstStage] of [
      ["src/a.txt", "X5_APPLIED_SENTINEL\n", "test"],
      ["tests/other.js", "throw new Error('failure');", "test"],
      ["src/a.txt", "X5_APPLIED_SENTINEL\n", "acceptance"]
    ]) {
      const mutate = `const fs=require('fs');if(fs.existsSync('stage-probe'))fs.writeFileSync(${JSON.stringify(target)},'tampered');`;
      const restore = `const fs=require('fs');if(fs.existsSync('stage-probe')){fs.writeFileSync(${JSON.stringify(target)},${JSON.stringify(original)});}`;
      const commands = [
        ...(firstStage === "acceptance" ? [{ id: "test", executable: "node", args: ["-e", "process.exit(0)"] }] : []),
        { id: firstStage, executable: "node", args: ["-e", mutate] },
        { id: "restore", executable: "node", args: ["-e", restore] }
      ];
      const staged = await fixture({
        specification: { commands, allowedExecutables: ["node"] },
        extraTracked: { "stage-probe": "enabled", ...(target.startsWith("tests/") ? { [target]: original } : {}) }
      });
      const result = await execute(staged);
      check(`${firstStage} changing ${target} stops before the restoring command`, () => {
        assert.equal(result.decision, "controlled_post_apply_validation_rolled_back", JSON.stringify(result));
        assert.equal(result.validationRecord.decision, "failed");
        assert.equal(result.validationRecord.requiredStepCount, commands.length);
        assert.equal(result.validationRecord.completedStepCount, commands.length - 1);
        assert.equal(result.validationRecord.steps.length, commands.length - 1);
        assert.equal(result.validationRecord.steps.at(-1).passed, false);
        assert.equal(result.validationRecord.candidateManifestBeforeHash, result.validationRecord.candidateManifestAfterHash);
        assert.equal(result.summary.validationPassed, false);
        assert.equal(result.summary.emergencyRollbackSucceeded, true);
        assert.equal(fs.readFileSync(path.join(staged.gateInput.repositoryPath, "src/a.txt"), "utf8"), "X5_BASELINE_SENTINEL\n");
      });
    }
    const reportsOnly = await fixture({ specification: {
      commands: ["test", "acceptance"].map((id) => ({ id, executable: "node", args: ["-e",
        `const fs=require('fs');fs.mkdirSync('.validation-output',{recursive:true});fs.writeFileSync('.validation-output/${id}.txt','report');`
      ] })), allowedExecutables: ["node"]
    } });
    const reportsResult = await execute(reportsOnly);
    check("multiple commands writing only allowed reports complete", () => {
      assert.equal(reportsResult.summary.validationPassed, true, JSON.stringify(reportsResult));
      assert.equal(reportsResult.validationRecord.completedStepCount, 2);
      assert.equal(reportsResult.validationRecord.candidateManifestBeforeHash, reportsResult.validationRecord.candidateManifestAfterHash);
    });

    const acceptanceMutation = await fixture({ specification: {
      commands: [
        { id: "test", executable: "node", args: ["-e", "process.exit(0)"] },
        { id: "acceptance", executable: "node", args: ["-e", "require('fs').writeFileSync('src/a.txt','acceptance changed source')"] }
      ], allowedExecutables: ["node"]
    } });
    const acceptanceMutationResult = await execute(acceptanceMutation);
    check("acceptance commands cannot mutate the candidate either", () => {
      assert.equal(acceptanceMutationResult.decision, "controlled_post_apply_validation_rolled_back");
      assert.equal(acceptanceMutationResult.validationRecord.decision, "failed");
      assert.equal(acceptanceMutationResult.validationRecord.steps.at(-1).passed, false);
      assert.equal(acceptanceMutationResult.validationRecord.candidateManifestBeforeHash,
        acceptanceMutationResult.validationRecord.candidateManifestAfterHash);
    });

    check("reports in reserved output directory preserve the candidate manifest", () => {
      assert.match(finalized.validationRecord.candidateManifestBeforeHash, /^sha256:/);
      assert.equal(finalized.validationRecord.candidateManifestBeforeHash, finalized.validationRecord.candidateManifestAfterHash);
      assert.equal(finalized.validationRecord.decision, "passed");
    });

    const model = await fixture({ mode: "always" });
    const modelFinalized = await execute(model);
    check("model-backed Admin path finalizes with distinct bound evidence", () => {
      assert.equal(modelFinalized.decision, "controlled_post_apply_validation_finalized");
      assert.equal(modelFinalized.finalReceipt.adminResolution.resolutionKind, "model_decision");
      assert.match(modelFinalized.finalReceipt.adminResolution.adminDecisionHash, /^sha256:/);
      assert.notEqual(modelFinalized.finalReceipt.receiptHash, finalized.finalReceipt.receiptHash);
    });

    const failingSpec = {
      commands: [{
        id: "validate", executable: "node",
        args: ["-e", "process.exit(require('fs').existsSync('fail-validation')?7:0)"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    };
    const failing = await fixture({
      specification: failingSpec, extraTracked: { "fail-validation": "fail\n" }
    });
    const failingGitBefore = gitMetadata(failing.gateInput.repositoryPath);
    const rolledBack = await execute(failing);
    check("non-passing isolated validation restores and proves the exact X.1 baseline", () => {
      assert.equal(rolledBack.decision, "controlled_post_apply_validation_rolled_back",
        JSON.stringify(rolledBack));
      assert.equal(rolledBack.finalReceipt.outcome, "validation_failed_rolled_back");
      assert.equal(rolledBack.summary.emergencyRollbackSucceeded, true);
      assert.equal(rolledBack.summary.terminalMarker, "VALIDATION_ROLLED_BACK");
      assert.equal(fs.readFileSync(path.join(failing.gateInput.repositoryPath, "src/a.txt"), "utf8"),
        "X5_BASELINE_SENTINEL\n");
      assert.equal(fs.existsSync(path.join(failing.registryDirectoryPath, "claims",
        failing.authorization.consumptionKey.slice(7), "COMMITTED")), true);
      assert.deepEqual(gitMetadata(failing.gateInput.repositoryPath), failingGitBefore);
    });
    const rollbackVerification = await verifyControlledPostApplyFinalReceipt({
      repositoryPath: failing.gateInput.repositoryPath,
      registryDirectoryPath: failing.registryDirectoryPath,
      receipt: rolledBack.finalReceipt, applyReceipt: failing.applyReceipt,
      authorization: failing.authorization, expectedInspection: failing.gateInput.expectedInspection
    });
    check("validation-failure rollback receipt verifies the restored baseline", () => {
      assert.equal(rollbackVerification.decision,
        "controlled_post_apply_final_receipt_current", JSON.stringify(rollbackVerification));
      assert.equal(rollbackVerification.summary.restoredBaselineMatched, true);
    });

    const timeoutSpec = {
      commands: [{
        id: "timeout", executable: "node", timeoutMs: 50,
        args: ["-e", "if(require('fs').existsSync('slow-validation'))setTimeout(()=>{},1000)"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    };
    const timeoutFixture = await fixture({
      specification: timeoutSpec, extraTracked: { "slow-validation": "slow\n" }
    });
    const timeoutResult = await execute(timeoutFixture);
    check("Phase V timeout triggers exact rollback", () => {
      assert.equal(timeoutResult.decision, "controlled_post_apply_validation_rolled_back",
        JSON.stringify(timeoutResult));
      assert.equal(timeoutResult.validationRecord.decision, "failed");
      assert.equal(timeoutResult.summary.emergencyRollbackSucceeded, true);
    });

    const reviewSpec = {
      commands: [{
        id: "review", executable: "node",
        args: ["-e", "console.log(require('fs').existsSync('review-validation')?'x'.repeat(1000):'ok')"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 10
    };
    const reviewFixture = await fixture({
      specification: reviewSpec, extraTracked: { "review-validation": "review\n" }
    });
    const reviewResult = await execute(reviewFixture);
    check("Phase V needs-review result triggers exact rollback", () => {
      assert.equal(reviewResult.decision, "controlled_post_apply_validation_rolled_back",
        JSON.stringify(reviewResult));
      assert.equal(reviewResult.validationRecord.decision, "needs_review");
    });

    const recordFailureSpec = {
      commands: [{
        id: "delay", executable: "node", args: ["-e", "setTimeout(()=>{},200)"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    };
    const recordFailureFixture = await fixture({ specification: recordFailureSpec });
    const recordTransaction = path.join(
      recordFailureFixture.registryDirectoryPath, "validations",
      recordFailureFixture.authorization.consumptionKey.slice(7)
    );
    const recordFailurePromise = execute(recordFailureFixture);
    await waitForFile(path.join(recordTransaction, "VALIDATION_STARTED"));
    fs.writeFileSync(path.join(recordTransaction, "validation-result.json"), "{}", { mode: 0o600 });
    const recordFailure = await recordFailurePromise;
    check("validation-result persistence failure after start triggers rollback", () => {
      assert.equal(recordFailure.decision, "controlled_post_apply_validation_rolled_back",
        JSON.stringify(recordFailure));
      assert.equal(recordFailure.summary.emergencyRollbackSucceeded, true);
    });

    const driftSpec = {
      commands: [{
        id: "delay", executable: "node", args: ["-e", "setTimeout(()=>{},250)"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    };
    const driftFixture = await fixture({ specification: driftSpec });
    const driftTransaction = path.join(
      driftFixture.registryDirectoryPath, "validations",
      driftFixture.authorization.consumptionKey.slice(7)
    );
    const driftPromise = execute(driftFixture);
    await waitForFile(path.join(driftTransaction, "VALIDATION_STARTED"));
    fs.writeFileSync(path.join(driftFixture.gateInput.repositoryPath, "concurrent-drift.txt"),
      "external drift");
    const driftResult = await driftPromise;
    check("concurrent real-repository drift never finalizes or blindly rolls back", () => {
      assert.equal(driftResult.decision,
        "controlled_post_apply_validation_rollback_failed", JSON.stringify(driftResult));
      assert.equal(driftResult.summary.emergencyRollbackExecuted, false);
      assert.equal(driftResult.summary.terminalMarker, "VALIDATION_ROLLBACK_FAILED");
      assert.equal(fs.existsSync(path.join(driftFixture.gateInput.repositoryPath,
        "concurrent-drift.txt")), true);
    });

    const duplicate = await execute(clean);
    check("a finalized validation transaction is never overwritten or reused", () => {
      assert.equal(duplicate.decision, "controlled_post_apply_validation_blocked");
      assert.ok(duplicate.issues.some((entry) =>
        entry.code === "controlled_post_apply_validation_already_finalized"));
    });

    const existingResults = [];
    for (const terminal of [
      "FINALIZED", "VALIDATION_ROLLED_BACK", "VALIDATION_ROLLBACK_FAILED", null
    ]) {
      const existing = await fixture();
      const transactionPath = path.join(
        existing.registryDirectoryPath, "validations",
        existing.authorization.consumptionKey.slice(7)
      );
      fs.mkdirSync(transactionPath, { recursive: true, mode: 0o700 });
      if (terminal) fs.writeFileSync(path.join(transactionPath, terminal), "", { mode: 0o600 });
      existingResults.push(await execute(existing));
    }
    check("all existing terminal and incomplete validation transactions block reuse", () => {
      for (const existing of existingResults) {
        assert.equal(existing.decision, "controlled_post_apply_validation_blocked");
        assert.equal(existing.summary.validationTransactionCreated, false);
      }
    });

    const mismatches = [];
    for (const mutate of [
      (spec) => { spec.commands[0].executable = "nodejs"; },
      (spec) => { spec.commands[0].args = ["--version"]; },
      (spec) => { spec.commands[0].timeoutMs = 1234; },
      (spec) => { spec.maxOutputChars = 19999; }
    ]) {
      const input = await fixture();
      input.phaseVExecutionSpecification = clone(input.phaseVExecutionSpecification);
      mutate(input.phaseVExecutionSpecification);
      mismatches.push(await execute(input));
    }
    check("every Phase V specification mutation fails before validation start", () => {
      for (const mismatch of mismatches) {
        assert.equal(mismatch.decision, "controlled_post_apply_validation_invalid");
        assert.equal(mismatch.summary.validationTransactionCreated, false);
      }
    });

    const invalidReceipt = await fixture();
    invalidReceipt.applyReceipt = clone(invalidReceipt.applyReceipt);
    invalidReceipt.applyReceipt.receiptHash = hash("tampered-x4-receipt");
    const invalidBeforeStart = await execute(invalidReceipt);
    check("invalid X.4 evidence causes no X.5 transaction or rollback", () => {
      assert.equal(invalidBeforeStart.decision, "controlled_post_apply_validation_invalid");
      assert.equal(invalidBeforeStart.summary.validationTransactionCreated, false);
      assert.equal(invalidBeforeStart.summary.emergencyRollbackExecuted, false);
    });

    const staleInvalidPath = await fixture();
    fs.writeFileSync(path.join(staleInvalidPath.gateInput.repositoryPath, "drift.txt"), "drift");
    const invalidPrecedence = await execute(staleInvalidPath, {
      validationWorkspaceParentPath: staleInvalidPath.gateInput.repositoryPath
    });
    const staleReviewPath = await fixture();
    fs.writeFileSync(path.join(staleReviewPath.gateInput.repositoryPath, "drift.txt"), "drift");
    fs.mkdirSync(path.join(
      staleReviewPath.validationWorkspaceParentPath,
      `controlled-post-apply-${staleReviewPath.authorization.consumptionKey.slice(7)}.partial`
    ), { mode: 0o700 });
    const reviewPrecedence = await execute(staleReviewPath);
    check("pre-start precedence is invalid over needs-review over blocked", () => {
      assert.equal(invalidPrecedence.decision, "controlled_post_apply_validation_invalid");
      assert.equal(reviewPrecedence.decision,
        "controlled_post_apply_validation_needs_review");
      assert.equal(invalidPrecedence.summary.validationTransactionCreated, false);
      assert.equal(reviewPrecedence.summary.validationTransactionCreated, false);
    });

    const insideWorkspace = await fixture();
    const insideWorkspaceResult = await execute(insideWorkspace, {
      validationWorkspaceParentPath: insideWorkspace.gateInput.repositoryPath
    });
    const missingWorkspace = await fixture();
    const missingWorkspaceResult = await execute(missingWorkspace, {
      validationWorkspaceParentPath: path.join(missingWorkspace.validationWorkspaceParentPath,
        "missing")
    });
    const existingWorkspace = await fixture();
    const exactWorkspace = path.join(
      existingWorkspace.validationWorkspaceParentPath,
      `controlled-post-apply-${existingWorkspace.authorization.consumptionKey.slice(7)}.partial`
    );
    fs.mkdirSync(exactWorkspace, { mode: 0o700 });
    const existingWorkspaceResult = await execute(existingWorkspace);
    check("inside, missing, and pre-existing workspace paths fail before validation start", () => {
      assert.notEqual(insideWorkspaceResult.decision,
        "controlled_post_apply_validation_finalized");
      assert.notEqual(missingWorkspaceResult.decision,
        "controlled_post_apply_validation_finalized");
      assert.equal(existingWorkspaceResult.decision,
        "controlled_post_apply_validation_needs_review");
      for (const result of [insideWorkspaceResult, missingWorkspaceResult,
        existingWorkspaceResult]) assert.equal(result.summary.validationStarted, false);
    });

    const atLimit = await fixture({ specification: { commands: [{ id: "noop", executable: "node", args: ["-e", "process.exit(0)"] }], allowedExecutables: ["node"] } });
    const atLimitResult = await execute(atLimit, {
      maxWorkspaceFileCount: 1,
      maxWorkspaceBytes: Buffer.byteLength(atLimit.proposed)
    });
    const overLimit = await fixture({ extraTracked: { "extra.txt": "extra\n" } });
    const overLimitResult = await execute(overLimit, { maxWorkspaceFileCount: 1 });
    check("workspace file and byte bounds accept equality and rollback on excess", () => {
      assert.equal(atLimitResult.decision, "controlled_post_apply_validation_finalized",
        JSON.stringify(atLimitResult));
      assert.equal(overLimitResult.decision, "controlled_post_apply_validation_rolled_back",
        JSON.stringify(overLimitResult));
      assert.equal(overLimitResult.summary.emergencyRollbackSucceeded, true);
    });

    const outputQuota = await fixture({ specification: {
      commands: [{ id: "output-quota", executable: "node",
        args: ["-e", "require('fs').mkdirSync('.validation-output',{recursive:true});require('fs').writeFileSync('.validation-output/quota.bin',Buffer.alloc(1024*1024))"] }],
      allowedExecutables: ["node"], maxOutputChars: 20_000
    } });
    const outputQuotaResult = await execute(outputQuota, { maxValidationOutputBytes: 64 * 1024 });
    check("validation output disk quota fails during the command and rolls back", () => {
      assert.equal(outputQuotaResult.decision,
        "controlled_post_apply_validation_rolled_back", JSON.stringify(outputQuotaResult));
      assert.equal(outputQuotaResult.summary.validationPassed, false);
      assert.equal(outputQuotaResult.summary.emergencyRollbackSucceeded, true);
      assert.equal(fs.readFileSync(path.join(outputQuota.gateInput.repositoryPath, "src/a.txt"), "utf8"),
        "X5_BASELINE_SENTINEL\n");
    });

    const tamperedRollbackSpec = {
      commands: [{
        id: "delayed-failure", executable: "node",
        args: ["-e", "if(require('fs').existsSync('fail-validation'))setTimeout(()=>process.exit(9),200)"]
      }],
      allowedExecutables: ["node"], maxCommands: 5, defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000, maxOutputChars: 20000
    };
    const tamperedRollback = await fixture({
      specification: tamperedRollbackSpec, extraTracked: { "fail-validation": "fail\n" }
    });
    const tamperedTransaction = path.join(
      tamperedRollback.registryDirectoryPath, "validations",
      tamperedRollback.authorization.consumptionKey.slice(7)
    );
    const tamperedPromise = execute(tamperedRollback);
    await waitForFile(path.join(tamperedTransaction, "VALIDATION_STARTED"));
    const rollbackObject = tamperedRollback.gateInput.rollbackBundleManifest.entries[0]
      .payloadRelativePath;
    fs.unlinkSync(path.join(tamperedRollback.gateInput.bundleDirectoryPath, rollbackObject));
    const tamperedRollbackResult = await tamperedPromise;
    check("rollback-object tampering after validation start requires recovery", () => {
      assert.equal(tamperedRollbackResult.decision,
        "controlled_post_apply_validation_rollback_failed",
        JSON.stringify(tamperedRollbackResult));
      assert.equal(tamperedRollbackResult.summary.emergencyRollbackSucceeded, false);
      assert.equal(tamperedRollbackResult.summary.terminalMarker,
        "VALIDATION_ROLLBACK_FAILED");
    });

    check("returned and durable X.5 evidence contains no paths, source, commands, or output", () => {
      const serialized = JSON.stringify({ finalized, finalizedVerification });
      for (const sentinel of [
        clean.gateInput.repositoryPath, clean.registryDirectoryPath,
        clean.gateInput.bundleDirectoryPath, clean.validationWorkspaceParentPath,
        "X5_BASELINE_SENTINEL", "X5_APPLIED_SENTINEL", "X5_MUTATION_SENTINEL",
        "X5_SIDE_EFFECT_SENTINEL", "writeFileSync"
      ]) assert.equal(serialized.includes(sentinel), false, sentinel);
      for (const name of ["validation-intent.json", "validation-result.json", "final-receipt.json"]) {
        const text = fs.readFileSync(path.join(transaction, name), "utf8");
        assert.equal(text.includes("X5_"), false);
        assert.equal(text.includes("writeFileSync"), false);
      }
    });

    const finalReceiptTamper = clone(finalized.finalReceipt);
    finalReceiptTamper.receiptHash = hash("tampered-final-receipt");
    const finalReceiptTamperResult = await verifyControlledPostApplyFinalReceipt({
      repositoryPath: clean.gateInput.repositoryPath,
      registryDirectoryPath: clean.registryDirectoryPath,
      receipt: finalReceiptTamper, applyReceipt: clean.applyReceipt,
      authorization: clean.authorization, expectedInspection: clean.gateInput.expectedInspection
    });
    async function copiedRegistry(label, mutate) {
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `x5-${label}-`)));
      roots.push(parent);
      const registryDirectoryPath = path.join(parent, "registry");
      fs.cpSync(clean.registryDirectoryPath, registryDirectoryPath, { recursive: true });
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
      const copiedTransaction = path.join(
        registryDirectoryPath, "validations", clean.authorization.consumptionKey.slice(7)
      );
      mutate(copiedTransaction);
      return verifyControlledPostApplyFinalReceipt({
        repositoryPath: clean.gateInput.repositoryPath, registryDirectoryPath,
        receipt: finalized.finalReceipt, applyReceipt: clean.applyReceipt,
        authorization: clean.authorization, expectedInspection: clean.gateInput.expectedInspection
      });
    }
    const intentTamperResult = await copiedRegistry("intent", (copiedTransaction) => {
      fs.appendFileSync(path.join(copiedTransaction, "validation-intent.json"), "\n");
    });
    const recordTamperResult = await copiedRegistry("record", (copiedTransaction) => {
      fs.appendFileSync(path.join(copiedTransaction, "validation-result.json"), "\n");
    });
    const incompleteResult = await copiedRegistry("incomplete", (copiedTransaction) => {
      fs.unlinkSync(path.join(copiedTransaction, "FINALIZED"));
    });
    check("final receipt, intent, record, and terminal tampering fail closed", () => {
      assert.equal(finalReceiptTamperResult.decision,
        "controlled_post_apply_final_receipt_invalid");
      assert.equal(intentTamperResult.decision, "controlled_post_apply_final_receipt_invalid");
      assert.equal(recordTamperResult.decision, "controlled_post_apply_final_receipt_invalid");
      assert.equal(incompleteResult.decision,
        "controlled_post_apply_final_receipt_requires_recovery");
    });

    const rollbackFailedVerification = await verifyControlledPostApplyFinalReceipt({
      repositoryPath: tamperedRollback.gateInput.repositoryPath,
      registryDirectoryPath: tamperedRollback.registryDirectoryPath,
      receipt: tamperedRollbackResult.finalReceipt,
      applyReceipt: tamperedRollback.applyReceipt,
      authorization: tamperedRollback.authorization,
      expectedInspection: tamperedRollback.gateInput.expectedInspection
    });
    check("rollback-failed final receipt always requires recovery", () => {
      assert.equal(rollbackFailedVerification.decision,
        "controlled_post_apply_final_receipt_requires_recovery");
      assert.equal(rollbackFailedVerification.summary.recoveryRequired, true);
    });

    const explicit = await fixture();
    const explicitResult = await execute(explicit, {
      policy: clone(DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY)
    });
    assert.equal(explicitResult.decision, "controlled_post_apply_validation_finalized");
    for (const field of Object.keys(DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY)) {
      if (field === "policyVersion") continue;
      const policy = clone(DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY);
      policy[field] = false;
      await assert.rejects(() => execute(clean, { policy }),
        TypeError, field);
    }
    const missingPolicy = clone(DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY);
    delete missingPolicy.requireCurrentX4ApplyReceipt;
    const unknownPolicy = { ...clone(DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY),
      unknown: true };
    assert.equal((await execute(clean, { policy: missingPolicy })).decision,
      "controlled_post_apply_validation_invalid");
    assert.equal((await execute(clean, { policy: unknownPolicy })).decision,
      "controlled_post_apply_validation_invalid");
    check("the complete exact X.5 policy is mandatory", () => {});

    for (const value of [null, undefined, 1, "bad", [], new Date(), new Map(), new Set()]) {
      const malformed = await executeControlledPostApplyValidation(value);
      assert.equal(malformed.decision, "controlled_post_apply_validation_invalid");
    }
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal((await executeControlledPostApplyValidation(cyclic)).decision,
      "controlled_post_apply_validation_invalid");
    class ExoticInput {}
    assert.equal((await executeControlledPostApplyValidation(new ExoticInput())).decision,
      "controlled_post_apply_validation_invalid");
    const accessor = {
      applyReceipt: clean.applyReceipt, authorization: clean.authorization,
      gateInput: clean.gateInput, registryDirectoryPath: clean.registryDirectoryPath,
      validationWorkspaceParentPath: clean.validationWorkspaceParentPath,
      phaseVExecutionSpecification: clean.phaseVExecutionSpecification,
      phaseVExecutionVerification: clean.phaseVExecutionVerification
    };
    Object.defineProperty(accessor, "applyReceipt", {
      enumerable: true, get() { throw new Error("getter invoked"); }
    });
    const symbol = {
      applyReceipt: clean.applyReceipt, authorization: clean.authorization,
      gateInput: clean.gateInput, registryDirectoryPath: clean.registryDirectoryPath,
      validationWorkspaceParentPath: clean.validationWorkspaceParentPath,
      phaseVExecutionSpecification: clean.phaseVExecutionSpecification,
      phaseVExecutionVerification: clean.phaseVExecutionVerification,
      [Symbol("secret")]: true
    };
    assert.equal((await executeControlledPostApplyValidation(accessor)).decision,
      "controlled_post_apply_validation_invalid");
    assert.equal((await executeControlledPostApplyValidation(symbol)).decision,
      "controlled_post_apply_validation_invalid");
    check("malformed, exotic, accessor, symbol, and cyclic inputs fail closed", () => {});

    check("X.5 itself invokes no shell or prohibited Git mutation command", () => {
      const source = fs.readFileSync(path.join(
        __dirname, "../packages/product-runtime/src/controlled-post-apply-validation.ts"
      ), "utf8");
      assert.equal(source.includes("shell: true"), false);
      assert.equal(source.includes("exec("), false);
      for (const command of [
        "add", "apply", "checkout", "clean", "commit", "merge", "rebase", "reset",
        "restore", "stash", "switch", "update-index", "write-tree", "push"
      ]) assert.equal(source.includes(`[\"${command}\"`), false, command);
    });

    check("runtime exports X.5 and its narrow compatibility helpers", () => {
      assert.equal(runtime.CONTROLLED_POST_APPLY_VALIDATION_VERSION, "1");
      assert.equal(typeof runtime.executeControlledPostApplyValidation, "function");
      assert.equal(typeof runtime.verifyControlledPostApplyFinalReceipt, "function");
      assert.equal(typeof runtime.computeTemporaryWorkspaceExecutionSpecificationHash, "function");
      assert.equal(typeof runtime.restoreControlledRepositoryFromRollbackBundle, "function");
      assert.equal(typeof runtime.computeControlledPostApplyValidationIntentHash, "function");
      assert.equal(typeof runtime.computeControlledPostApplyValidationRecordHash, "function");
      assert.equal(typeof runtime.computeControlledPostApplyFinalReceiptHash, "function");
      assert.equal(typeof runtime.verifyControlledPostApplyValidationIntentRecord, "function");
      assert.equal(typeof runtime.verifyControlledPostApplyValidationResultRecord, "function");
      assert.equal(typeof runtime.verifyControlledPostApplyFinalReceiptRecord, "function");
      assert.equal(Object.isFrozen(runtime.DEFAULT_CONTROLLED_POST_APPLY_VALIDATION_POLICY), true);
    });
  } finally {
    for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(checks >= 14);
  console.log(`controlled post-apply validation smoke passed (${checks} checks)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
