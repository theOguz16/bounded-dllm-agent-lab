#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AC2B Fixture",
  GIT_AUTHOR_EMAIL: "ac2b@example.invalid",
  GIT_COMMITTER_NAME: "AC2B Fixture",
  GIT_COMMITTER_EMAIL: "ac2b@example.invalid"
};

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8"
  });
}

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function gitMetadata(root) {
  const gitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    index: fs
      .readFileSync(path.resolve(root, gitDir, "index"))
      .toString("hex"),
    refs: git(root, ["show-ref"]),
    tags: git(root, ["tag", "--list"]),
    config: fs
      .readFileSync(path.resolve(root, gitDir, "config"))
      .toString("hex")
  };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

(async () => {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );

  const {
    authorizeContextSufficientPatch,
    buildContextToApplyBinding,
    buildControlledApplyHandoff,
    buildTemporaryWorkspaceExecutionVerificationEvidence,
    computeGovernedMutationHash,
    createAcceptanceCriteriaContract,
    createHumanReviewAcceptanceEvidence,
    evaluateControlledApplyExecutionGate,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    runIntegratedDisposableApply,
    verifyIntegratedDisposableApplyReceipt,
    verifyTemporaryWorkspaceExecution
  } = runtime;

  const roots = [];
  const hash = (label) => hashCanonicalJson({ label });

  function contentHash(value) {
    return `sha256:${crypto
      .createHash("sha256")
      .update(Buffer.from(value, "utf8"))
      .digest("hex")}`;
  }

  function evidence(filePath, content) {
    return {
      path: filePath,
      source: "ac2b_fixture",
      content,
      contentHash: contentHash(content),
      byteLength: Buffer.byteLength(content, "utf8"),
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: []
    };
  }

  function coderMutation(files) {
    return {
      role: "coder",
      target: "patchDraft",
      summary: "Create the source patch.",
      claims: files.map((file) => ({
        type: "patch_draft",
        file
      })),
      touchedFiles: [...files],
      confidence: 0.9
    };
  }

  function contextAuthorizationFor(mutation, fileContents) {
    const visibleEvidence = Object.entries(fileContents).map(
      ([filePath, content]) => ({
        ...evidence(filePath, content),
        origin: "initial_context"
      })
    );

    const adaptiveResult = {
      decision: "adaptive_coder_completed",
      route: "coder_executed",
      issues: [],
      coderResult: {
        decision: "coder_execution_completed",
        route: "coder_executed",
        issues: [],
        providerCalled: true,
        providerOutput: mutation,
        context: {
          version: "1",
          baseContext: {
            task: "Update fixture files."
          },
          evidence: visibleEvidence,
          provenance: visibleEvidence.map((entry) => ({
            path: entry.path,
            origin: entry.origin,
            contentHash: entry.contentHash,
            source: entry.source
          })),
          budget: {
            estimatedInputTokens: 500,
            reservedOutputTokens: 500,
            hardTotalBudgetTokens: 4000,
            remainingTokens: 3000
          }
        },
        summary: {
          visibleFileCount: visibleEvidence.length,
          requiredSourceCount: visibleEvidence.length,
          requiredTestCount: 0,
          requiredSymbolCount: 0,
          estimatedInputTokens: 500,
          reservedOutputTokens: 500,
          hardTotalBudgetTokens: 4000,
          providerCallCount: 1
        }
      },
      traces: [],
      summary: {
        expansionAttemptCount: 0,
        contextRequestProviderCallCount: 0,
        scopeApprovalProviderCallCount: 0,
        resolverCallCount: 0,
        coderProviderCallCount: 1,
        requestedFileCount: 0,
        loadedExpansionFileCount: 0
      }
    };

    const result = authorizeContextSufficientPatch({
      adaptiveResult,
      allowedFiles: [...mutation.touchedFiles]
    });

    assert.equal(
      result.decision,
      "context_authorization_ready",
      JSON.stringify(result)
    );

    return result.authorization;
  }

  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash:
        artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash:
        artifact.change.executionVerificationResultHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash,
      governanceHash: artifact.evidence.governanceHash,
      adminInvocationPolicyHash:
        artifact.evidence.adminInvocationPolicyHash,
      adminInvocationAssessmentHash:
        artifact.evidence.adminInvocationAssessmentHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash,
      routeHash: artifact.evidence.routeHash,
      governancePolicyHash:
        artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash:
        artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount:
        artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision:
        artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }

  function artifactFor(mutation, verificationHash, objectiveHash) {
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash: computeGovernedMutationHash(
          "repair_draft",
          mutation
        ),
        changedFiles: [...mutation.touchedFiles],
        patchDryRunResultHash: hash("ac2b:dry-run"),
        temporaryApplyResultHash: hash("ac2b:temp-apply"),
        executionVerificationResultHash: verificationHash,
        stageEvents: {
          mutationSourceEventId: "run:event:000005",
          patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008",
          executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010",
          deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012",
          adminAgentEventId: null,
          approvalRouterEventId: "run:event:000013"
        }
      },
      evidence: {
        runId: `ac2b-${Date.now()}-${Math.random()}`,
        objectiveHash,
        preShadowLedgerRootHash: hash("ac2b:pre-root"),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash("ac2b:trace"),
        observationHash: hash("ac2b:observation"),
        governanceHash: hash("ac2b:governance"),
        adminInvocationPolicyHash:
          hash("ac2b:invocation-policy"),
        adminInvocationAssessmentHash:
          hash("ac2b:invocation-assessment"),
        adminDecisionHash: null,
        routeHash: hash("ac2b:route"),
        governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy-v2"),
        finalLedgerRootHash: hash("ac2b:final-root"),
        finalLedgerEventCount: 13
      },
      decisions: {
        phaseVFinalDecision: "temp_validation_passed",
        shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid",
        governanceDecision: "governance_passed",
        adminInvocationMode: "conditional",
        adminInvocationDecision: "admin_invocation_skipped",
        adminInvocationSkipKind: "clean_path",
        adminResolutionKind: "verified_policy_skip",
        adminStageDecision: "admin_skipped_by_policy",
        adminValidationDecision: null,
        adminDecision: null,
        routerValidationDecision: "approval_route_valid",
        workflowRoute: "auto_continue"
      },
      applyEligibility: {
        eligible: true,
        reasonCodes: []
      }
    };

    return {
      ...material,
      governedArtifactHash: hashCanonicalJson(material)
    };
  }

  async function priorEvidence(specification, files) {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2b-phase-v-"))
    );
    roots.push(workspace);

    for (const [filePath, content] of Object.entries(files)) {
      write(workspace, filePath, content);
    }

    const result = verifyTemporaryWorkspaceExecution({
      tempWorkspacePath: workspace,
      tempApplyDecision: "temp_apply_ready",
      tempWorkspaceCleanedUp: false,
      ...specification
    });

    fs.rmSync(workspace, {
      recursive: true,
      force: true
    });

    assert.equal(
      result.decision,
      "temp_validation_passed",
      JSON.stringify(result)
    );

    return buildTemporaryWorkspaceExecutionVerificationEvidence(
      specification,
      result,
      true
    );
  }

  async function fixture({
    specification,
    includeHumanCriterion = false,
    humanReviewEvidence,
    contractCommandId = "validate"
  } = {}) {
    const repositoryPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2b-repo-"))
    );
    const bundleParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2b-bundle-"))
    );
    const registryDirectoryPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2b-registry-"))
    );
    const validationWorkspaceParentPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2b-workspaces-"))
    );

    roots.push(
      repositoryPath,
      bundleParent,
      registryDirectoryPath,
      validationWorkspaceParentPath
    );

    git(repositoryPath, ["init", "--quiet"]);
    const baseline = "AC2B_BASELINE\n";
    const proposed = "AC2B_APPLIED\n";
    write(repositoryPath, "src/a.txt", baseline);
    git(repositoryPath, ["add", "--", "."]);
    git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);

    const actualSpecification =
      specification ?? {
        commands: [
          {
            id: "validate",
            executable: "node",
            args: [
              "-e",
              "const fs=require('fs');process.exit(fs.readFileSync('src/a.txt','utf8')==='AC2B_APPLIED\\n'?0:1)"
            ]
          }
        ],
        allowedExecutables: ["node"],
        maxCommands: 5,
        defaultTimeoutMs: 30000,
        maxTimeoutMs: 120000,
        maxOutputChars: 20000
      };

    const phaseVExecutionVerification = await priorEvidence(
      actualSpecification,
      { "src/a.txt": proposed }
    );

    const repairMutation = {
      role: "remask",
      target: "repairDraft",
      summary: "Produce the final bounded repair.",
      claims: [
        {
          type: "repair_draft",
          file: "src/a.txt",
          proposedPatch: proposed
        }
      ],
      touchedFiles: ["src/a.txt"],
      confidence: 0.9
    };

    const inspected = await inspectControlledRepository({
      repositoryPath,
      changedFiles: repairMutation.touchedFiles
    });
    assert.equal(
      inspected.decision,
      "repository_inspection_ready",
      JSON.stringify(inspected)
    );

    const objectiveHash = hash("ac2b:objective");
    const artifact = artifactFor(
      repairMutation,
      phaseVExecutionVerification.verificationResultHash,
      objectiveHash
    );
    const currentFreshnessSnapshot = freshnessFrom(artifact);
    const handoffResult = buildControlledApplyHandoff({
      artifact,
      currentFreshnessSnapshot,
      mutation: repairMutation,
      target: inspected.inspection.target
    });
    assert.equal(
      handoffResult.decision,
      "controlled_apply_handoff_ready",
      JSON.stringify(handoffResult)
    );

    const bundleDirectoryPath = path.join(bundleParent, "bundle");
    const bundled = await materializeControlledRollbackBundle({
      repositoryPath,
      bundleDirectoryPath,
      changedFiles: repairMutation.touchedFiles,
      expectedInspection: inspected.inspection,
      handoff: handoffResult.handoff,
      artifact,
      currentFreshnessSnapshot,
      mutation: repairMutation,
      consumptionStatus: "not_consumed"
    });
    assert.equal(
      bundled.decision,
      "rollback_bundle_ready",
      JSON.stringify(bundled)
    );

    const gateInput = {
      repositoryPath,
      bundleDirectoryPath,
      changedFiles: [...repairMutation.touchedFiles],
      artifact,
      currentFreshnessSnapshot,
      mutation: repairMutation,
      handoff: handoffResult.handoff,
      expectedInspection: inspected.inspection,
      rollbackBundleManifest: bundled.manifest,
      rollbackBundleReceipt: bundled.receipt,
      consumptionStatus: "not_consumed"
    };

    const gated = await evaluateControlledApplyExecutionGate(gateInput);
    assert.equal(
      gated.decision,
      "controlled_apply_execution_gate_ready",
      JSON.stringify(gated)
    );

    const sourceMutation = coderMutation(["src/a.txt"]);
    const contextAuthorization = contextAuthorizationFor(
      sourceMutation,
      { "src/a.txt": baseline }
    );

    const bindingInput = {
      contextAuthorization,
      coderMutation: sourceMutation,
      executionAuthorization: gated.authorization,
      gateInput
    };

    const binding = await buildContextToApplyBinding(bindingInput);
    assert.equal(
      binding.decision,
      "context_to_apply_binding_ready",
      JSON.stringify(binding)
    );

    const criteria = [
      {
        id: "validation",
        description:
          "The applied repository passes the validation command.",
        required: true,
        evidence: {
          kind: "test",
          commandId: contractCommandId
        }
      }
    ];

    if (includeHumanCriterion) {
      criteria.push({
        id: "review",
        description:
          "A bounded human review approves the requested behavior.",
        required: true,
        evidence: {
          kind: "human_review",
          reviewKey: "review-key"
        }
      });
    }

    const acceptanceContract = createAcceptanceCriteriaContract({
      taskId: "ac2b-task",
      objectiveHash,
      criteria
    });

    return {
      input: {
        bindingReceipt: binding.receipt,
        bindingInput,
        acceptanceContract,
        ...(humanReviewEvidence === undefined
          ? {}
          : { humanReviewEvidence }),
        registryDirectoryPath,
        validationWorkspaceParentPath,
        phaseVExecutionSpecification: actualSpecification,
        phaseVExecutionVerification
      },
      repositoryPath,
      registryDirectoryPath,
      baseline,
      proposed
    };
  }

  try {
    await check(
      "clean integrated flow applies validates and approves contract",
      async () => {
        const value = await fixture();
        const gitBefore = gitMetadata(value.repositoryPath);
        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_finalized",
          JSON.stringify(result)
        );
        assert.equal(result.route, "contract_approved");
        assert.equal(result.receipt.outcome, "contract_approved");
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          value.proposed
        );
        assert.deepEqual(gitMetadata(value.repositoryPath), gitBefore);
      }
    );

    await check(
      "integrated receipt verifies current",
      async () => {
        const value = await fixture();
        const result = await runIntegratedDisposableApply(value.input);

        const verified = await verifyIntegratedDisposableApplyReceipt({
          receipt: result.receipt,
          bindingReceipt: value.input.bindingReceipt,
          acceptanceContract: value.input.acceptanceContract,
          preflightCoverageReceipt:
            result.preflightAcceptance.receipt,
          finalCoverageReceipt: result.finalAcceptance.receipt,
          finalExecutionEvidence: result.finalExecutionEvidence,
          applyReceipt: result.applyResult.receipt,
          postApplyFinalReceipt:
            result.postApplyValidation.finalReceipt,
          executionAuthorization:
            value.input.bindingInput.executionAuthorization,
          bindingInput: value.input.bindingInput,
          registryDirectoryPath:
            value.input.registryDirectoryPath
        });

        assert.equal(
          verified.decision,
          "integrated_disposable_apply_receipt_current",
          JSON.stringify(verified)
        );
        assert.equal(verified.downstreamEligible, true);
      }
    );

    await check(
      "missing human review blocks before real apply",
      async () => {
        const value = await fixture({
          includeHumanCriterion: true
        });
        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_needs_review"
        );
        assert.equal(result.summary.applyCallCount, 0);
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          value.baseline
        );
        assert.equal(
          fs.existsSync(
            path.join(value.registryDirectoryPath, "claims")
          ),
          false
        );
      }
    );

    await check(
      "approved human review permits apply",
      async () => {
        const review = createHumanReviewAcceptanceEvidence({
          reviewKey: "review-key",
          criterionId: "review",
          reviewerIdentityHash: hash("reviewer"),
          decision: "approved",
          reviewedAt: "2026-07-22T12:00:00Z",
          rationaleHash: hash("rationale")
        });

        const value = await fixture({
          includeHumanCriterion: true,
          humanReviewEvidence: [review]
        });
        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_finalized",
          JSON.stringify(result)
        );
        assert.equal(
          result.receipt.acceptance.requiredCriterionCount,
          2
        );
      }
    );

    await check(
      "missing command mapping blocks before real apply",
      async () => {
        const value = await fixture({
          contractCommandId: "missing-command"
        });
        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_invalid"
        );
        assert.equal(result.summary.applyCallCount, 0);
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          value.baseline
        );
      }
    );

    await check(
      "tampered context-to-apply binding blocks before write",
      async () => {
        const value = await fixture();
        value.input.bindingReceipt = {
          ...value.input.bindingReceipt,
          scope: {
            ...value.input.bindingReceipt.scope,
            sourceChangedFileCount:
              value.input.bindingReceipt.scope
                .sourceChangedFileCount + 1
          }
        };

        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_invalid"
        );
        assert.equal(result.summary.applyCallCount, 0);
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          value.baseline
        );
      }
    );

    await check(
      "post-apply validation failure restores exact baseline",
      async () => {
        const counter = path.join(
          os.tmpdir(),
          `ac2b-counter-${Date.now()}-${Math.random()}`
        );
        roots.push(counter);

        const specification = {
          commands: [
            {
              id: "validate",
              executable: "node",
              args: [
                "-e",
                "const fs=require('fs');const p=process.env.AC2B_COUNTER;if(fs.existsSync(p)){process.exit(1)}fs.writeFileSync(p,'seen')"
              ]
            }
          ],
          allowedExecutables: ["node"],
          maxCommands: 5,
          defaultTimeoutMs: 30000,
          maxTimeoutMs: 120000,
          maxOutputChars: 20000,
          environment: {
            AC2B_COUNTER: counter
          }
        };

        const value = await fixture({ specification });
        const gitBefore = gitMetadata(value.repositoryPath);
        const result = await runIntegratedDisposableApply(value.input);

        assert.equal(
          result.decision,
          "integrated_disposable_apply_rolled_back",
          JSON.stringify(result)
        );
        assert.equal(result.summary.x5RollbackExecuted, true);
        assert.equal(result.summary.x5RollbackSucceeded, true);
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          value.baseline
        );
        assert.deepEqual(gitMetadata(value.repositoryPath), gitBefore);
      }
    );

    await check(
      "replay cannot produce a second repository write",
      async () => {
        const value = await fixture();
        const first = await runIntegratedDisposableApply(value.input);
        assert.equal(
          first.decision,
          "integrated_disposable_apply_finalized",
          JSON.stringify(first)
        );

        const contentAfterFirst = fs.readFileSync(
          path.join(value.repositoryPath, "src/a.txt"),
          "utf8"
        );
        const second = await runIntegratedDisposableApply(value.input);

        assert.notEqual(
          second.decision,
          "integrated_disposable_apply_finalized"
        );
        assert.equal(second.summary.applyCallCount, 0);
        assert.equal(
          fs.readFileSync(
            path.join(value.repositoryPath, "src/a.txt"),
            "utf8"
          ),
          contentAfterFirst
        );
      }
    );

    await check(
      "tampered integrated receipt is invalid",
      async () => {
        const value = await fixture();
        const result = await runIntegratedDisposableApply(value.input);
        const tampered = {
          ...result.receipt,
          acceptance: {
            ...result.receipt.acceptance,
            approvedCriterionCount:
              result.receipt.acceptance.approvedCriterionCount + 1
          }
        };

        const verified = await verifyIntegratedDisposableApplyReceipt({
          receipt: tampered,
          bindingReceipt: value.input.bindingReceipt,
          acceptanceContract: value.input.acceptanceContract,
          preflightCoverageReceipt:
            result.preflightAcceptance.receipt,
          finalCoverageReceipt: result.finalAcceptance.receipt,
          finalExecutionEvidence: result.finalExecutionEvidence,
          applyReceipt: result.applyResult.receipt,
          postApplyFinalReceipt:
            result.postApplyValidation.finalReceipt,
          executionAuthorization:
            value.input.bindingInput.executionAuthorization,
          bindingInput: value.input.bindingInput,
          registryDirectoryPath:
            value.input.registryDirectoryPath
        });

        assert.equal(
          verified.decision,
          "integrated_disposable_apply_receipt_invalid"
        );
        assert.equal(verified.downstreamEligible, false);
      }
    );

    console.log(
      "integrated disposable apply coordinator smoke passed (9 checks)"
    );
  } finally {
    for (const root of roots.reverse()) {
      fs.rmSync(root, {
        recursive: true,
        force: true
      });
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
