#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  execFileSync
} = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AE2 Fixture",
  GIT_AUTHOR_EMAIL: "ae2@example.invalid",
  GIT_COMMITTER_NAME: "AE2 Fixture",
  GIT_COMMITTER_EMAIL: "ae2@example.invalid"
};

function git(cwd, args) {
  return execFileSync(
    "git",
    args,
    {
      cwd,
      env: gitEnv,
      encoding: "utf8"
    }
  );
}

function write(root, file, content) {
  const target =
    path.join(root, file);
  fs.mkdirSync(
    path.dirname(target),
    { recursive: true }
  );
  fs.writeFileSync(
    target,
    content
  );
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    buildDraftPrDeliveryContract,
    executeControlledLocalDelivery,
    hashCanonicalJson,
    inspectControlledRepository,
    verifyControlledLocalDeliveryReceipt
  } = runtime;

  const roots = [];
  let checks = 0;
  const hash = (label) =>
    hashCanonicalJson({ label });
  const withHash = (material, field) => ({
    ...material,
    [field]: hashCanonicalJson(material)
  });
  const check =
    async (name, callback) => {
      console.log(`[run] ${name}`);
      await callback();
      checks += 1;
      console.log(`[ok] ${name}`);
    };

  async function fixture() {
    const repositoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ae2-repo-"
          )
        )
      );
    const registryDirectoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ae2-registry-"
          )
        )
      );
    roots.push(
      repositoryPath,
      registryDirectoryPath
    );
    fs.chmodSync(
      registryDirectoryPath,
      0o700
    );

    git(
      repositoryPath,
      ["init", "--quiet"]
    );
    git(
      repositoryPath,
      [
        "branch",
        "-m",
        "main"
      ]
    );
    write(
      repositoryPath,
      "src/a.ts",
      "export const a = 1;\n"
    );
    write(
      repositoryPath,
      "src/b.ts",
      "export const b = 1;\n"
    );
    write(
      repositoryPath,
      "src/unchanged.ts",
      "export const unchanged = true;\n"
    );
    git(
      repositoryPath,
      ["add", "--", "."]
    );
    git(
      repositoryPath,
      [
        "commit",
        "--quiet",
        "-m",
        "baseline"
      ]
    );

    const baseline =
      await inspectControlledRepository({
        repositoryPath,
        changedFiles: [
          "src/a.ts",
          "src/b.ts"
        ]
      });
    assert.equal(
      baseline.decision,
      "repository_inspection_ready",
      JSON.stringify(baseline)
    );

    write(
      repositoryPath,
      "src/a.ts",
      "export const a = 2;\n"
    );
    write(
      repositoryPath,
      "src/b.ts",
      "export const b = 2;\n"
    );

    const changedFiles = [
      "src/a.ts",
      "src/b.ts"
    ];
    const appliedFiles = [];
    for (const filePath of changedFiles) {
      const absolute =
        path.join(
          repositoryPath,
          filePath
        );
      const bytes =
        fs.readFileSync(absolute);
      const metadata =
        fs.statSync(absolute);
      const mode =
        (metadata.mode & 0o111) !== 0
          ? "100755"
          : "100644";
      const contentHash =
        `sha256:${createHash("sha256")
          .update(bytes)
          .digest("hex")}`;
      const stateHash =
        hashCanonicalJson({
          artifactType:
            "controlled_repository_file_state",
          state:
            "regular_file",
          mode,
          contentHash
        });

      appliedFiles.push({
        filePath,
        operation: "update",
        finalState:
          "regular_file",
        finalMode: mode,
        finalContentHash:
          contentHash,
        finalStateHash:
          stateHash,
        gitStatusObserved: true
      });
    }

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
        changedFileCount: 2
      },
      before: {
        repositoryIdentityHash:
          baseline.inspection.target
            .repositoryIdentityHash,
        baseRevisionHash:
          baseline.inspection.target
            .baseRevisionHash,
        worktreeStateHash:
          baseline.inspection.target
            .worktreeStateHash,
        expectedInspectionHash:
          baseline.inspection
            .inspectionHash,
        rollbackManifestHash:
          baseline.inspection
            .rollbackManifest
            .manifestHash,
        rollbackBundleManifestHash:
          hash("bundle-manifest"),
        rollbackBundleReceiptHash:
          hash("bundle-receipt"),
        rollbackPayloadRootHash:
          hash("bundle-root")
      },
      after: {
        appliedStateHash:
          hash("applied-state"),
        finalScopeHash:
          hash("final-scope"),
        appliedFiles,
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
        emergencyRollbackExecuted:
          false,
        emergencyRollbackSucceeded:
          null,
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
        requiredCriterionCount: 2,
        approvedCriterionCount: 2,
        coverageComplete: true
      },
      apply: {
        x4ApplyReceiptHash:
          applyReceipt.receiptHash,
        appliedStateHash:
          applyReceipt.after
            .appliedStateHash,
        finalScopeHash:
          applyReceipt.after
            .finalScopeHash,
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
        bindingCurrentBeforeWrite:
          true,
        objectiveMatched: true,
        phaseVArtifactBindingMatched:
          true,
        acceptancePreflightApproved:
          true,
        x4ApplySucceeded: true,
        x5ValidationFinalized: true,
        finalAcceptanceApproved:
          true,
        x5FinalReceiptCurrent: true,
        repositoryValidatedAppliedState:
          true
      }
    };
    const integratedReceipt =
      withHash(
        integratedMaterial,
        "receiptHash"
      );

    const receipts = [
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
    const files =
      appliedFiles.map(
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
    const test = {
      kind: "test",
      evidenceId:
        "test.final-validation",
      commandId: "validate",
      resultHash:
        integratedReceipt.validation
          .currentExecutionResultHash,
      sourceValidationReceiptHash:
        integratedReceipt.validation
          .x5FinalReceiptHash
    };
    const built =
      buildDraftPrDeliveryContract({
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
            "feat: deliver governed fixture"
        },
        pullRequest: {
          title:
            "feat: deliver governed fixture",
          body:
            "## Summary\n\nGoverned fixture delivery."
        },
        evidenceReferences: [
          ...receipts,
          ...files,
          test
        ]
      });
    assert.equal(
      built.decision,
      "draft_pr_delivery_contract_ready",
      JSON.stringify(built)
    );
    return {
      repositoryPath,
      registryDirectoryPath,
      contract: built.contract,
      integratedReceipt,
      applyReceipt,
      baseCommit:
        git(
          repositoryPath,
          [
            "rev-parse",
            "HEAD"
          ]
        ).trim()
    };
  }

  function input(value) {
    return {
      repositoryPath:
        value.repositoryPath,
      registryDirectoryPath:
        value.registryDirectoryPath,
      contract:
        value.contract,
      integratedReceipt:
        value.integratedReceipt,
      applyReceipt:
        value.applyReceipt
    };
  }

  await check(
    "current contract creates bounded branch and evidence-bound commit",
    async () => {
      const value =
        await fixture();
      const mainBefore =
        git(
          value.repositoryPath,
          [
            "rev-parse",
            "refs/heads/main"
          ]
        ).trim();
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_committed",
        JSON.stringify(result)
      );
      assert.equal(
        git(
          value.repositoryPath,
          [
            "branch",
            "--show-current"
          ]
        ).trim(),
        value.contract.branch.name
      );
      assert.equal(
        git(
          value.repositoryPath,
          [
            "rev-parse",
            "refs/heads/main"
          ]
        ).trim(),
        mainBefore
      );
      assert.equal(
        result.receipt.branch
          .parentCommitHash,
        value.baseCommit
      );
      assert.equal(
        git(
          value.repositoryPath,
          [
            "status",
            "--porcelain"
          ]
        ),
        ""
      );
    }
  );

  await check(
    "commit includes evidence trailers and only governed files",
    async () => {
      const value =
        await fixture();
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      const message =
        git(
          value.repositoryPath,
          [
            "show",
            "-s",
            "--format=%B",
            result.receipt.branch
              .commitHash
          ]
        );
      assert.match(
        message,
        /Bounded-Delivery-Key: sha256:/
      );
      assert.match(
        message,
        /Bounded-Contract-Hash: sha256:/
      );
      const files =
        git(
          value.repositoryPath,
          [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            result.receipt.branch
              .commitHash
          ]
        ).trim().split("\n").sort();
      assert.deepEqual(
        files,
        [
          "src/a.ts",
          "src/b.ts"
        ]
      );
    }
  );

  await check(
    "local delivery receipt verifies current and downstream eligible",
    async () => {
      const value =
        await fixture();
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      const verification =
        await verifyControlledLocalDeliveryReceipt({
          ...input(value),
          receipt:
            result.receipt
        });
      assert.equal(
        verification.decision,
        "controlled_local_delivery_receipt_current",
        JSON.stringify(verification)
      );
      assert.equal(
        verification.downstreamEligible,
        true
      );
    }
  );

  await check(
    "replay returns existing commit without second Git write",
    async () => {
      const value =
        await fixture();
      const first =
        await executeControlledLocalDelivery(
          input(value)
        );
      const branchBefore =
        git(
          value.repositoryPath,
          [
            "rev-parse",
            `refs/heads/${value.contract.branch.name}`
          ]
        ).trim();
      const second =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        second.decision,
        "controlled_local_delivery_already_committed",
        JSON.stringify(second)
      );
      assert.equal(
        second.summary.commitCreated,
        false
      );
      assert.equal(
        git(
          value.repositoryPath,
          [
            "rev-parse",
            `refs/heads/${value.contract.branch.name}`
          ]
        ).trim(),
        branchBefore
      );
      assert.equal(
        second.receipt.receiptHash,
        first.receipt.receiptHash
      );
    }
  );

  await check(
    "unexpected untracked path blocks before delivery claim",
    async () => {
      const value =
        await fixture();
      write(
        value.repositoryPath,
        "unexpected.txt",
        "unexpected\n"
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary
          .deliveryClaimCreated,
        false
      );
      assert.equal(
        git(
          value.repositoryPath,
          [
            "branch",
            "--show-current"
          ]
        ).trim(),
        "main"
      );
    }
  );

  await check(
    "pre-staged governed file blocks before branch creation",
    async () => {
      const value =
        await fixture();
      git(
        value.repositoryPath,
        [
          "add",
          "--",
          "src/a.ts"
        ]
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.branchCreated,
        false
      );
    }
  );

  await check(
    "tampered governed content blocks before branch creation",
    async () => {
      const value =
        await fixture();
      write(
        value.repositoryPath,
        "src/a.ts",
        "export const a = 999;\n"
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.branchCreated,
        false
      );
    }
  );

  await check(
    "wrong current branch blocks without changing refs",
    async () => {
      const value =
        await fixture();
      git(
        value.repositoryPath,
        [
          "switch",
          "-c",
          "other"
        ]
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary
          .deliveryClaimCreated,
        false
      );
    }
  );

  await check(
    "existing deterministic branch blocks duplicate delivery",
    async () => {
      const value =
        await fixture();
      git(
        value.repositoryPath,
        [
          "branch",
          value.contract.branch.name
        ]
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_blocked",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary
          .deliveryClaimCreated,
        false
      );
    }
  );

  await check(
    "incomplete durable claim requires recovery",
    async () => {
      const value =
        await fixture();
      const claim =
        path.join(
          value.registryDirectoryPath,
          "deliveries",
          value.contract.deliveryKey
            .slice(7)
        );
      fs.mkdirSync(
        path.dirname(claim),
        {
          recursive: true,
          mode: 0o700
        }
      );
      fs.chmodSync(
        path.dirname(claim),
        0o700
      );
      fs.mkdirSync(
        claim,
        { mode: 0o700 }
      );
      fs.writeFileSync(
        path.join(
          claim,
          "intent.json"
        ),
        "{}"
      );
      const result =
        await executeControlledLocalDelivery(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_local_delivery_recovery_required",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.commitCreated,
        false
      );
    }
  );

  await check(
    "symlinked registry path is invalid before Git write",
    async () => {
      const value =
        await fixture();
      const parent =
        fs.realpathSync(
          fs.mkdtempSync(
            path.join(
              os.tmpdir(),
              "ae2-symlink-"
            )
          )
        );
      roots.push(parent);
      const link =
        path.join(
          parent,
          "registry-link"
        );
      fs.symlinkSync(
        value.registryDirectoryPath,
        link
      );
      const result =
        await executeControlledLocalDelivery({
          ...input(value),
          registryDirectoryPath:
            link
        });
      assert.equal(
        result.decision,
        "controlled_local_delivery_invalid",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.branchCreated,
        false
      );
    }
  );

  await check(
    "executor uses no shell push remote mutation or commit hooks",
    async () => {
      const source =
        fs.readFileSync(
          path.resolve(
            "packages/product-runtime/src/controlled-local-delivery.ts"
          ),
          "utf8"
        );
      assert.equal(
        /exec\(|shell\s*:\s*true|["'`]push["'`]|["'`]fetch["'`]|["'`]commit["'`]|gh\s+pr|octokit|createPullRequest/i
          .test(source),
        false
      );
      assert.match(
        source,
        /"commit-tree"/
      );
      assert.match(
        source,
        /"write-tree"/
      );
      assert.match(
        source,
        /"update-ref"/
      );
    }
  );

  console.log(
    `controlled local delivery smoke passed (${checks} checks)`
  );

  for (const root of roots.reverse()) {
    fs.rmSync(
      root,
      {
        recursive: true,
        force: true
      }
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
