#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AC2A Fixture",
  GIT_AUTHOR_EMAIL: "ac2a@example.invalid",
  GIT_COMMITTER_NAME: "AC2A Fixture",
  GIT_COMMITTER_EMAIL: "ac2a@example.invalid"
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
    evaluateControlledApplyExecutionGate,
    hashCanonicalJson,
    inspectControlledRepository,
    materializeControlledRollbackBundle,
    verifyContextToApplyBindingReceipt,
    verifyTemporaryWorkspaceExecution
  } = runtime;

  const roots = [];
  const hash = (label) => hashCanonicalJson({ label });

  function evidence(filePath, content) {
    const bytes = Buffer.from(content, "utf8");
    return {
      path: filePath,
      source: "ac2a_fixture",
      content,
      contentHash: `sha256:${crypto
        .createHash("sha256")
        .update(bytes)
        .digest("hex")}`,
      byteLength: bytes.length,
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
          baseContext: { task: "Update fixture files." },
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
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
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
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }

  function artifactFor(mutation, verificationHash) {
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash: computeGovernedMutationHash(
          "repair_draft",
          mutation
        ),
        changedFiles: [...mutation.touchedFiles],
        patchDryRunResultHash: hash("ac2a:dry-run"),
        temporaryApplyResultHash: hash("ac2a:temp-apply"),
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
        runId: `ac2a-${Date.now()}-${Math.random()}`,
        objectiveHash: hash("ac2a:objective"),
        preShadowLedgerRootHash: hash("ac2a:pre-root"),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash("ac2a:trace"),
        observationHash: hash("ac2a:observation"),
        governanceHash: hash("ac2a:governance"),
        adminInvocationPolicyHash: hash("ac2a:invocation-policy"),
        adminInvocationAssessmentHash:
          hash("ac2a:invocation-assessment"),
        adminDecisionHash: null,
        routeHash: hash("ac2a:route"),
        governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy-v2"),
        finalLedgerRootHash: hash("ac2a:final-root"),
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
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2a-phase-v-"))
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

    fs.rmSync(workspace, { recursive: true, force: true });

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
    repairFiles = ["src/a.txt"],
    sourceFiles = repairFiles,
    allFiles = {
      "src/a.txt": "AC2A_BASELINE_A\n",
      "src/b.txt": "AC2A_BASELINE_B\n"
    }
  } = {}) {
    const repositoryPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2a-repo-"))
    );
    const bundleParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2a-bundle-"))
    );
    const registryDirectoryPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ac2a-registry-"))
    );

    roots.push(repositoryPath, bundleParent, registryDirectoryPath);

    git(repositoryPath, ["init", "--quiet"]);

    for (const [filePath, content] of Object.entries(allFiles)) {
      write(repositoryPath, filePath, content);
    }

    git(repositoryPath, ["add", "--", "."]);
    git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);

    const proposed = Object.fromEntries(
      repairFiles.map((filePath) => [
        filePath,
        `AC2A_REPAIRED_${path.basename(filePath)}\n`
      ])
    );

    const specification = {
      commands: [
        {
          id: "validate",
          executable: "node",
          args: ["-e", "process.exit(0)"]
        }
      ],
      allowedExecutables: ["node"],
      maxCommands: 5,
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000,
      maxOutputChars: 20000
    };

    const phaseEvidence = await priorEvidence(
      specification,
      proposed
    );

    const repairMutation = {
      role: "remask",
      target: "repairDraft",
      summary: "Produce the final bounded repair.",
      claims: repairFiles.map((filePath) => ({
        type: "repair_draft",
        file: filePath,
        proposedPatch: proposed[filePath]
      })),
      touchedFiles: [...repairFiles],
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

    const artifact = artifactFor(
      repairMutation,
      phaseEvidence.verificationResultHash
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

    const sourceMutation = coderMutation(sourceFiles);
    const sourceContents = Object.fromEntries(
      sourceFiles.map((filePath) => [filePath, allFiles[filePath]])
    );
    const contextAuthorization = contextAuthorizationFor(
      sourceMutation,
      sourceContents
    );

    return {
      contextAuthorization,
      coderMutation: sourceMutation,
      executionAuthorization: gated.authorization,
      gateInput
    };
  }

  try {
    await check(
      "valid context and current X3 authorization create apply binding",
      async () => {
        const value = await fixture();
        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_ready",
          JSON.stringify(result)
        );
        assert.equal(result.route, "apply_authorized");
        assert.equal(
          result.receipt.scope.scopeExpansionObserved,
          false
        );
      }
    );

    await check(
      "current binding receipt verifies downstream eligible",
      async () => {
        const value = await fixture();
        const built = await buildContextToApplyBinding(value);
        const verified = await verifyContextToApplyBindingReceipt(
          built.receipt,
          value
        );

        assert.equal(
          verified.decision,
          "context_to_apply_binding_current",
          JSON.stringify(verified)
        );
        assert.equal(verified.downstreamEligible, true);
      }
    );

    await check(
      "repair subset of coder scope is accepted",
      async () => {
        const value = await fixture({
          repairFiles: ["src/a.txt"],
          sourceFiles: ["src/a.txt", "src/b.txt"]
        });
        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_ready",
          JSON.stringify(result)
        );
        assert.deepEqual(result.receipt.sourceChangedFiles, [
          "src/a.txt",
          "src/b.txt"
        ]);
        assert.deepEqual(result.receipt.repairChangedFiles, [
          "src/a.txt"
        ]);
      }
    );

    await check(
      "repair scope expansion beyond coder scope is blocked",
      async () => {
        const value = await fixture({
          repairFiles: ["src/b.txt"],
          sourceFiles: ["src/a.txt"]
        });
        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_blocked"
        );
        assert.equal(result.route, "replan_required");
        assert.equal(
          result.issues[0].code,
          "repair_scope_expands_context_authorized_scope"
        );
      }
    );

    await check(
      "tampered context authorization is invalid",
      async () => {
        const value = await fixture();
        value.contextAuthorization = {
          ...value.contextAuthorization,
          budget: {
            ...value.contextAuthorization.budget,
            remainingTokens:
              value.contextAuthorization.budget.remainingTokens + 1
          }
        };

        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_invalid"
        );
        assert.equal(
          result.summary.contextAuthorizationCurrent,
          false
        );
      }
    );

    await check(
      "different coder mutation cannot reuse context authorization",
      async () => {
        const value = await fixture();
        value.coderMutation = {
          ...value.coderMutation,
          summary: "A different coder mutation."
        };

        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_invalid"
        );
        assert.equal(
          result.summary.contextAuthorizationCurrent,
          false
        );
      }
    );

    await check(
      "tampered execution authorization is blocked",
      async () => {
        const value = await fixture();
        value.executionAuthorization = {
          ...value.executionAuthorization,
          handoffHash: hash("tampered-handoff")
        };

        const result = await buildContextToApplyBinding(value);

        assert.equal(
          result.decision,
          "context_to_apply_binding_blocked"
        );
        assert.equal(
          result.summary.executionAuthorizationCurrent,
          false
        );
      }
    );

    await check(
      "tampered binding receipt fails verification",
      async () => {
        const value = await fixture();
        const built = await buildContextToApplyBinding(value);
        const tampered = {
          ...built.receipt,
          scope: {
            ...built.receipt.scope,
            sourceChangedFileCount:
              built.receipt.scope.sourceChangedFileCount + 1
          }
        };

        const verified = await verifyContextToApplyBindingReceipt(
          tampered,
          value
        );

        assert.equal(
          verified.decision,
          "context_to_apply_binding_verification_invalid"
        );
        assert.equal(verified.downstreamEligible, false);
      }
    );

    console.log(
      "context-to-apply binding smoke passed (8 checks)"
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
