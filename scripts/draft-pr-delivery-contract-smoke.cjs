#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );

  const {
    buildDraftPrDeliveryContract,
    hashCanonicalJson,
    verifyDraftPrDeliveryContract
  } = runtime;

  let checks = 0;
  const check = (name, callback) => {
    callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const hash = (label) =>
    hashCanonicalJson({ label });
  const clone = (value) =>
    structuredClone(value);

  function withHash(material, field) {
    return {
      ...material,
      [field]: hashCanonicalJson(material)
    };
  }

  function fixture() {
    const changedFiles = [
      "src/a.ts",
      "src/b.ts"
    ];
    const contents = new Map([
      ["src/a.ts", hash("content:a")],
      ["src/b.ts", hash("content:b")]
    ]);

    const applyMaterial = {
      receiptVersion: "1",
      outcome: "applied",
      authorizationHash:
        hash("authorization"),
      governedArtifactHash:
        hash("governed-artifact"),
      handoffHash:
        hash("handoff"),
      consumptionKey:
        hash("consumption"),
      reservationHash:
        hash("reservation"),
      transactionHash:
        hash("transaction"),
      mutation: {
        changeKind: "repair_draft",
        mutationHash:
          hash("mutation"),
        changedFiles,
        changedFileCount:
          changedFiles.length
      },
      before: {
        repositoryIdentityHash:
          hash("repository-identity"),
        baseRevisionHash:
          hash("base-revision"),
        worktreeStateHash:
          hash("worktree"),
        expectedInspectionHash:
          hash("inspection"),
        rollbackManifestHash:
          hash("rollback-manifest"),
        rollbackBundleManifestHash:
          hash("rollback-bundle-manifest"),
        rollbackBundleReceiptHash:
          hash("rollback-bundle-receipt"),
        rollbackPayloadRootHash:
          hash("rollback-root")
      },
      after: {
        appliedStateHash:
          hash("applied-state"),
        finalScopeHash:
          hash("final-scope"),
        appliedFiles:
          changedFiles.map(
            (filePath) => ({
              filePath,
              operation: "update",
              finalState:
                "regular_file",
              finalMode: "100644",
              finalContentHash:
                contents.get(filePath),
              finalStateHash:
                hash(
                  `state:${filePath}`
                ),
              gitStatusObserved: true
            })
          ),
        observedChangedFiles:
          changedFiles,
        unexpectedChangedFiles: []
      },
      execution: {
        writeStarted: true,
        attemptedOperationCount: 2,
        completedOperationCount: 2,
        mutationApplyAttempted: true,
        mutationApplied: true,
        emergencyRollbackExecuted: false,
        emergencyRollbackSucceeded: null,
        finalRepositoryMatchesBeforeState:
          false,
        gitIndexMutated: false,
        gitHistoryMutated: false,
        shellExecuted: false
      }
    };
    const applyReceipt =
      withHash(
        applyMaterial,
        "receiptHash"
      );

    const integratedMaterial = {
      receiptVersion: "1",
      outcome: "contract_approved",
      contextToApplyBindingHash:
        hash("context-to-apply"),
      contextAuthorizationHash:
        hash("context-authorization"),
      coderMutationHash:
        hash("coder-mutation"),
      repairMutationHash:
        hash("repair-mutation"),
      executionAuthorizationHash:
        hash("execution-authorization"),
      governedArtifactHash:
        applyReceipt.governedArtifactHash,
      handoffHash:
        applyReceipt.handoffHash,
      consumptionKey:
        applyReceipt.consumptionKey,
      acceptance: {
        contractHash:
          hash("acceptance-contract"),
        preflightCoverageReceiptHash:
          hash("preflight-coverage"),
        finalCoverageReceiptHash:
          hash("final-coverage"),
        requiredCriterionCount: 3,
        approvedCriterionCount: 3,
        coverageComplete: true
      },
      apply: {
        x4ApplyReceiptHash:
          applyReceipt.receiptHash,
        appliedStateHash:
          applyReceipt.after.appliedStateHash,
        finalScopeHash:
          applyReceipt.after.finalScopeHash,
        changedFiles
      },
      validation: {
        x5FinalReceiptHash:
          hash("x5-final"),
        currentExecutionResultHash:
          hash("execution-result"),
        finalInspectionHash:
          hash("final-inspection"),
        finalRepositoryState:
          "validated_applied_state"
      },
      preconditions: {
        bindingCurrentBeforeWrite: true,
        objectiveMatched: true,
        phaseVArtifactBindingMatched: true,
        acceptancePreflightApproved: true,
        x4ApplySucceeded: true,
        x5ValidationFinalized: true,
        finalAcceptanceApproved: true,
        x5FinalReceiptCurrent: true,
        repositoryValidatedAppliedState: true
      }
    };
    const integratedReceipt =
      withHash(
        integratedMaterial,
        "receiptHash"
      );

    const receiptReferences = [
      [
        "integrated_apply",
        integratedReceipt.receiptHash
      ],
      [
        "context_to_apply",
        integratedReceipt
          .contextToApplyBindingHash
      ],
      [
        "acceptance_contract",
        integratedReceipt.acceptance
          .contractHash
      ],
      [
        "preflight_coverage",
        integratedReceipt.acceptance
          .preflightCoverageReceiptHash
      ],
      [
        "final_coverage",
        integratedReceipt.acceptance
          .finalCoverageReceiptHash
      ],
      [
        "x4_apply",
        applyReceipt.receiptHash
      ],
      [
        "x5_final",
        integratedReceipt.validation
          .x5FinalReceiptHash
      ]
    ].map(
      ([receiptType, receiptHash]) => ({
        kind: "receipt",
        evidenceId:
          `receipt.${receiptType}`,
        receiptType,
        receiptHash
      })
    );

    const fileReferences =
      applyReceipt.after.appliedFiles.map(
        (entry, index) => ({
          kind: "file",
          evidenceId:
            `file.${String(index).padStart(2, "0")}`,
          filePath:
            entry.filePath,
          contentHash:
            entry.finalContentHash,
          sourceApplyReceiptHash:
            applyReceipt.receiptHash
        })
      );

    const testReference = {
      kind: "test",
      evidenceId:
        "test.final-validation",
      commandId:
        "validate",
      resultHash:
        integratedReceipt.validation
          .currentExecutionResultHash,
      sourceValidationReceiptHash:
        integratedReceipt.validation
          .x5FinalReceiptHash
    };

    const input = {
      integratedReceipt,
      applyReceipt,
      repository: {
        owner: "theOguz16",
        name:
          "bounded-dllm-agent-lab",
        baseBranch: "main"
      },
      commit: {
        message:
          "feat: apply governed bounded change"
      },
      pullRequest: {
        title:
          "feat: apply governed bounded change",
        body:
          "## Summary\n\nEvidence-bound governed delivery."
      },
      evidenceReferences: [
        ...fileReferences.reverse(),
        testReference,
        ...receiptReferences.reverse()
      ]
    };

    return {
      input,
      integratedReceipt,
      applyReceipt
    };
  }

  const valid = fixture();
  const before = clone(valid.input);
  const ready =
    buildDraftPrDeliveryContract(
      valid.input
    );

  check(
    "valid typed evidence builds deterministic delivery contract",
    () => {
      assert.equal(
        ready.decision,
        "draft_pr_delivery_contract_ready",
        JSON.stringify(ready)
      );
      assert.equal(
        ready.contract.pullRequest.draft,
        true
      );
      assert.equal(
        ready.contract.branch.name.startsWith(
          "bounded/"
        ),
        true
      );
      assert.deepEqual(
        valid.input,
        before
      );
      assert.equal(
        Object.isFrozen(ready),
        true
      );
    }
  );

  check(
    "current delivery contract verifies downstream eligible",
    () => {
      const verification =
        verifyDraftPrDeliveryContract({
          contract:
            ready.contract,
          integratedReceipt:
            valid.integratedReceipt,
          applyReceipt:
            valid.applyReceipt
        });
      assert.equal(
        verification.decision,
        "draft_pr_delivery_contract_current",
        JSON.stringify(verification)
      );
      assert.equal(
        verification.downstreamEligible,
        true
      );
    }
  );

  check(
    "same source derives identical branch delivery key and hash",
    () => {
      const second =
        buildDraftPrDeliveryContract(
          clone(valid.input)
        );
      assert.equal(
        second.contract.branch.name,
        ready.contract.branch.name
      );
      assert.equal(
        second.contract.deliveryKey,
        ready.contract.deliveryKey
      );
      assert.equal(
        second.contract.contractHash,
        ready.contract.contractHash
      );
    }
  );

  check(
    "file evidence is sorted and exactly covers governed files",
    () => {
      assert.deepEqual(
        ready.contract.commit.changedFiles,
        ["src/a.ts", "src/b.ts"]
      );
      assert.equal(
        ready.contract.evidence
          .fileReferenceCount,
        2
      );
      assert.equal(
        ready.contract.evidence
          .complete,
        true
      );
    }
  );

  check(
    "missing governed file evidence blocks delivery",
    () => {
      const value = fixture();
      value.input.evidenceReferences =
        value.input.evidenceReferences
          .filter(
            (entry) =>
              !(
                entry.kind === "file" &&
                entry.filePath ===
                  "src/b.ts"
              )
          );
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_blocked"
      );
      assert.equal(
        result.summary.contractBuilt,
        false
      );
    }
  );

  check(
    "tampered file content hash is invalid",
    () => {
      const value = fixture();
      const file =
        value.input.evidenceReferences
          .find(
            (entry) =>
              entry.kind === "file"
          );
      file.contentHash =
        hash("tampered-content");
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_invalid"
      );
    }
  );

  check(
    "missing required receipt evidence blocks delivery",
    () => {
      const value = fixture();
      value.input.evidenceReferences =
        value.input.evidenceReferences
          .filter(
            (entry) =>
              !(
                entry.kind === "receipt" &&
                entry.receiptType ===
                  "x5_final"
              )
          );
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_blocked"
      );
    }
  );

  check(
    "duplicate evidence identifiers are invalid",
    () => {
      const value = fixture();
      value.input.evidenceReferences[1]
        .evidenceId =
        value.input.evidenceReferences[0]
          .evidenceId;
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_invalid"
      );
    }
  );

  check(
    "unsafe repository or branch target is invalid",
    () => {
      const value = fixture();
      value.input.repository.baseBranch =
        "../main";
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_invalid"
      );
      assert.equal(
        result.summary.repositoryTargetValid,
        false
      );
    }
  );

  check(
    "tampered integrated receipt cannot authorize delivery",
    () => {
      const value = fixture();
      value.input.integratedReceipt
        .validation.finalRepositoryState =
        "restored_x1_baseline";
      const result =
        buildDraftPrDeliveryContract(
          value.input
        );
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_invalid"
      );
      assert.equal(
        result.summary
          .integratedReceiptIntegrityVerified,
        false
      );
    }
  );

  check(
    "tampered contract fails read-only verification",
    () => {
      const contract =
        clone(ready.contract);
      contract.pullRequest.title =
        "tampered title";
      const result =
        verifyDraftPrDeliveryContract({
          contract,
          integratedReceipt:
            valid.integratedReceipt,
          applyReceipt:
            valid.applyReceipt
        });
      assert.equal(
        result.decision,
        "draft_pr_delivery_contract_invalid"
      );
      assert.equal(
        result.downstreamEligible,
        false
      );
    }
  );

  check(
    "source and builder perform no Git or GitHub write",
    () => {
      const source =
        fs.readFileSync(
          path.resolve(
            "packages/product-runtime/src/draft-pr-delivery-contract.ts"
          ),
          "utf8"
        );
      assert.equal(
        /execFile|spawn|git\s+(?:add|commit|push|checkout|switch|branch)|createPullRequest|octokit/i
          .test(source),
        false
      );
      assert.equal(
        ready.summary.gitWritePerformed,
        false
      );
      assert.equal(
        ready.summary.githubWritePerformed,
        false
      );
    }
  );

  console.log(
    `draft PR delivery contract smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
