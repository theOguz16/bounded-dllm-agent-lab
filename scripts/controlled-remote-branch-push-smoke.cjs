#!/usr/bin/env node

const assert =
  require("node:assert/strict");
const { createHash } =
  require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  execFileSync
} = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME:
    "AE3A Fixture",
  GIT_AUTHOR_EMAIL:
    "ae3a@example.invalid",
  GIT_COMMITTER_NAME:
    "AE3A Fixture",
  GIT_COMMITTER_EMAIL:
    "ae3a@example.invalid"
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

function write(
  root,
  file,
  content
) {
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
    executeControlledRemoteBranchPush,
    hashCanonicalJson,
    inspectControlledRepository,
    verifyControlledRemoteBranchPushReceipt
  } = runtime;

  const roots = [];
  let checks = 0;
  const hash = (label) =>
    hashCanonicalJson({ label });
  const withHash =
    (material, field) => ({
      ...material,
      [field]:
        hashCanonicalJson(material)
    });
  const check =
    async (name, callback) => {
      console.log(`[run] ${name}`);
      await callback();
      checks += 1;
      console.log(`[ok] ${name}`);
    };

  async function fixture() {
    const root =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ae3a-fixture-"
          )
        )
      );
    const repositoryPath =
      path.join(root, "repo");
    const remotePath =
      path.join(root, "remote.git");
    const registryDirectoryPath =
      path.join(root, "registry");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(
      registryDirectoryPath,
      { mode: 0o700 }
    );
    fs.chmodSync(
      registryDirectoryPath,
      0o700
    );
    git(root, [
      "init",
      "--bare",
      "--quiet",
      remotePath
    ]);
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
    git(
      repositoryPath,
      [
        "remote",
        "add",
        "origin",
        remotePath
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
    git(
      repositoryPath,
      [
        "push",
        "--quiet",
        "-u",
        "origin",
        "main"
      ]
    );

    const changedFiles = [
      "src/a.ts",
      "src/b.ts"
    ];
    const baseline =
      await inspectControlledRepository({
        repositoryPath,
        changedFiles
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

    const appliedFiles = [];
    for (
      const filePath
      of changedFiles
    ) {
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
        changeKind:
          "repair_draft",
        mutationHash:
          hash("mutation"),
        changedFiles,
        changedFileCount:
          changedFiles.length
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
      outcome:
        "contract_approved",
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
        applyReceipt
          .governedArtifactHash,
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
        x5FinalReceiptCurrent:
          true,
        repositoryValidatedAppliedState:
          true
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
      appliedFiles.map(
        (entry, index) => ({
          kind: "file",
          evidenceId:
            `file.${String(index)
              .padStart(2, "0")}`,
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
      commandId: "validate",
      resultHash:
        integratedReceipt.validation
          .currentExecutionResultHash,
      sourceValidationReceiptHash:
        integratedReceipt.validation
          .x5FinalReceiptHash
    };
    const contractResult =
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
            "feat: deliver governed remote fixture"
        },
        pullRequest: {
          title:
            "feat: deliver governed remote fixture",
          body:
            "## Summary\n\nGoverned remote fixture."
        },
        evidenceReferences: [
          ...receiptReferences,
          ...fileReferences,
          testReference
        ]
      });
    assert.equal(
      contractResult.decision,
      "draft_pr_delivery_contract_ready",
      JSON.stringify(contractResult)
    );

    const localResult =
      await executeControlledLocalDelivery({
        repositoryPath,
        registryDirectoryPath,
        contract:
          contractResult.contract,
        integratedReceipt,
        applyReceipt
      });
    assert.equal(
      localResult.decision,
      "controlled_local_delivery_committed",
      JSON.stringify(localResult)
    );

    roots.push(root);
    return {
      root,
      repositoryPath,
      remotePath,
      registryDirectoryPath,
      contract:
        contractResult.contract,
      integratedReceipt,
      applyReceipt,
      localDeliveryReceipt:
        localResult.receipt
    };
  }

  function input(value) {
    return {
      repositoryPath:
        value.repositoryPath,
      registryDirectoryPath:
        value.registryDirectoryPath,
      remoteName: "origin",
      localDeliveryReceipt:
        value.localDeliveryReceipt,
      contract:
        value.contract,
      integratedReceipt:
        value.integratedReceipt,
      applyReceipt:
        value.applyReceipt
    };
  }

  function remoteRef(
    value,
    branch
  ) {
    return git(
      value.repositoryPath,
      [
        "ls-remote",
        "--refs",
        "origin",
        `refs/heads/${branch}`
      ]
    )
      .trim()
      .split(/\s+/)[0] || "";
  }

  await check(
    "current local receipt pushes exact bounded branch and preserves remote main",
    async () => {
      const value =
        await fixture();
      const mainBefore =
        remoteRef(value, "main");
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_remote_branch_pushed",
        JSON.stringify(result)
      );
      assert.equal(
        remoteRef(
          value,
          value.contract.branch.name
        ),
        value.localDeliveryReceipt
          .branch.commitHash
      );
      assert.equal(
        remoteRef(value, "main"),
        mainBefore
      );
      assert.equal(
        result.summary.pushSucceeded,
        true
      );
    }
  );

  await check(
    "remote push receipt verifies current and downstream eligible",
    async () => {
      const value =
        await fixture();
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      const verification =
        await verifyControlledRemoteBranchPushReceipt({
          ...input(value),
          receipt:
            result.receipt
        });
      assert.equal(
        verification.decision,
        "controlled_remote_branch_push_receipt_current",
        JSON.stringify(verification)
      );
      assert.equal(
        verification.downstreamEligible,
        true
      );
    }
  );

  await check(
    "replay returns current receipt without second push",
    async () => {
      const value =
        await fixture();
      const first =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      const second =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        second.decision,
        "controlled_remote_branch_already_pushed",
        JSON.stringify(second)
      );
      assert.equal(
        second.summary.pushAttempted,
        false
      );
      assert.equal(
        second.receipt.receiptHash,
        first.receipt.receiptHash
      );
    }
  );

  await check(
    "advanced remote main blocks before durable push claim",
    async () => {
      const value =
        await fixture();
      const clonePath =
        path.join(
          value.root,
          "other-clone"
        );
      git(value.root, [
        "clone",
        "--quiet",
        value.remotePath,
        clonePath
      ]);
      git(
        clonePath,
        [
          "switch",
          "--quiet",
          "main"
        ]
      );
      write(
        clonePath,
        "remote-change.txt",
        "remote drift\n"
      );
      git(
        clonePath,
        ["add", "--", "."]
      );
      git(
        clonePath,
        [
          "commit",
          "--quiet",
          "-m",
          "remote drift"
        ]
      );
      git(
        clonePath,
        [
          "push",
          "--quiet",
          "origin",
          "main"
        ]
      );
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary
          .durableClaimCreated,
        false
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "pre-existing remote bounded branch blocks unclaimed duplicate",
    async () => {
      const value =
        await fixture();
      git(
        value.repositoryPath,
        [
          "push",
          "--quiet",
          "origin",
          `${value.localDeliveryReceipt.branch.commitHash}:refs/heads/${value.contract.branch.name}`
        ]
      );
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_blocked",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "changed remote identity blocks before push",
    async () => {
      const value =
        await fixture();
      const replacement =
        path.join(
          value.root,
          "replacement.git"
        );
      git(value.root, [
        "init",
        "--bare",
        "--quiet",
        replacement
      ]);
      git(
        value.repositoryPath,
        [
          "remote",
          "set-url",
          "origin",
          replacement
        ]
      );
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_needs_review",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "tampered local delivery receipt cannot authorize push",
    async () => {
      const value =
        await fixture();
      const tampered =
        structuredClone(
          value.localDeliveryReceipt
        );
      tampered.branch.commitHash =
        tampered.repository
          .baseRevision;
      const result =
        await executeControlledRemoteBranchPush({
          ...input(value),
          localDeliveryReceipt:
            tampered
        });
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_invalid",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "local bounded branch ref drift blocks remote push",
    async () => {
      const value =
        await fixture();
      git(
        value.repositoryPath,
        [
          "update-ref",
          `refs/heads/${value.contract.branch.name}`,
          value.localDeliveryReceipt
            .repository.baseRevision
        ]
      );
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        [
          "controlled_remote_branch_push_invalid",
          "controlled_remote_branch_push_needs_review"
        ].includes(result.decision),
        true,
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "remote rejection after durable claim requires recovery",
    async () => {
      const value =
        await fixture();
      const hook =
        path.join(
          value.remotePath,
          "hooks",
          "pre-receive"
        );
      fs.writeFileSync(
        hook,
        "#!/bin/sh\nexit 1\n"
      );
      fs.chmodSync(hook, 0o755);
      const result =
        await executeControlledRemoteBranchPush(
          input(value)
        );
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_recovery_required",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary
          .durableClaimCreated,
        true
      );
      assert.equal(
        result.summary.pushAttempted,
        true
      );
      assert.equal(
        remoteRef(
          value,
          value.contract.branch.name
        ),
        ""
      );
    }
  );

  await check(
    "symlinked registry is invalid before remote write",
    async () => {
      const value =
        await fixture();
      const link =
        path.join(
          value.root,
          "registry-link"
        );
      fs.symlinkSync(
        value.registryDirectoryPath,
        link
      );
      const result =
        await executeControlledRemoteBranchPush({
          ...input(value),
          registryDirectoryPath:
            link
        });
      assert.equal(
        result.decision,
        "controlled_remote_branch_push_invalid",
        JSON.stringify(result)
      );
      assert.equal(
        result.summary.pushAttempted,
        false
      );
    }
  );

  await check(
    "executor uses lease-protected push and no shell or GitHub API",
    async () => {
      const source =
        fs.readFileSync(
          path.resolve(
            "packages/product-runtime/src/controlled-remote-branch-push.ts"
          ),
          "utf8"
        );
      assert.equal(
        /(?:^|[^.\w])exec(?:Sync)?\s*\(|shell\s*:\s*true|api\.github|\/pulls|octokit|gh\s+pr/im
          .test(source),
        false
      );
      assert.match(
        source,
        /"ls-remote"/
      );
      assert.match(
        source,
        /"push"/
      );
      assert.match(
        source,
        /--force-with-lease=/
      );
      assert.equal(
        /--force(?!-with-lease)/
          .test(source),
        false
      );
    }
  );

  console.log(
    `controlled remote branch push smoke passed (${checks} checks)`
  );

  for (
    const root
    of roots.reverse()
  ) {
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
  console.error(
    error.stack || error
  );
  process.exitCode = 1;
});
