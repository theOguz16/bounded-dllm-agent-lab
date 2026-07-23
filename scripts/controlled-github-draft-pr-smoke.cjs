#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AE3B Fixture",
  GIT_AUTHOR_EMAIL: "ae3b@example.invalid",
  GIT_COMMITTER_NAME: "AE3B Fixture",
  GIT_COMMITTER_EMAIL: "ae3b@example.invalid"
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

class FakeGithubClient {
  constructor(value) {
    /*
     * requestedOwner/requestedName validate that the executor calls the
     * intended endpoint. owner/name represent the snapshot returned by
     * GitHub and may intentionally drift in negative fixtures.
     */
    this.requestedOwner = value.owner;
    this.requestedName = value.name;
    this.owner = value.owner;
    this.name = value.name;
    this.defaultBranch = value.defaultBranch;
    this.branches = new Map(value.branches);
    this.files = [...value.files];
    this.pullRequests = [];
    this.nextNumber = 1;
    this.createCalls = 0;
    this.failCreate = false;
    this.createdDraft = true;
    this.createdState = "open";
    this.createdFiles = null;
  }

  async getRepository(owner, name) {
    assert.equal(owner, this.requestedOwner);
    assert.equal(name, this.requestedName);
    return {
      owner: this.owner,
      name: this.name,
      defaultBranch: this.defaultBranch
    };
  }

  async getBranch(owner, name, branch) {
    assert.equal(owner, this.requestedOwner);
    assert.equal(name, this.requestedName);
    const commitHash = this.branches.get(branch);
    if (!commitHash) throw new Error("missing branch");
    return { name: branch, commitHash };
  }

  async listOpenPullRequests(owner, name, baseBranch, headBranch) {
    assert.equal(owner, this.requestedOwner);
    assert.equal(name, this.requestedName);
    return this.pullRequests
      .filter(
        (pr) =>
          pr.state === "open" &&
          pr.baseBranch === baseBranch &&
          pr.headBranch === headBranch
      )
      .map((pr) => ({ ...pr }));
  }

  async createDraftPullRequest(input) {
    this.createCalls += 1;
    if (this.failCreate) throw new Error("simulated create failure");
    const number = this.nextNumber++;
    this.pullRequests.push({
      number,
      state: this.createdState,
      draft: this.createdDraft,
      title: input.title,
      body: input.body,
      baseBranch: input.baseBranch,
      baseCommitHash: this.branches.get(input.baseBranch),
      headBranch: input.headBranch,
      headCommitHash: this.branches.get(input.headBranch)
    });
    return { number };
  }

  async getPullRequest(owner, name, number) {
    assert.equal(owner, this.requestedOwner);
    assert.equal(name, this.requestedName);
    const pr = this.pullRequests.find((entry) => entry.number === number);
    if (!pr) throw new Error("missing pull request");
    return { ...pr };
  }

  async listPullRequestFiles(owner, name, number) {
    assert.equal(owner, this.requestedOwner);
    assert.equal(name, this.requestedName);
    assert.ok(this.pullRequests.some((entry) => entry.number === number));
    return [...(this.createdFiles ?? this.files)];
  }

  seedPullRequest(value) {
    this.pullRequests.push({
      ...value,
      number: this.nextNumber++
    });
  }
}

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    buildDraftPrDeliveryContract,
    executeControlledGithubDraftPr,
    executeControlledLocalDelivery,
    executeControlledRemoteBranchPush,
    hashCanonicalJson,
    inspectControlledRepository,
    verifyControlledGithubDraftPrReceipt
  } = runtime;

  const roots = [];
  let checks = 0;
  const hash = (label) => hashCanonicalJson({ label });
  const withHash = (material, field) => ({
    ...material,
    [field]: hashCanonicalJson(material)
  });
  const check = async (name, callback) => {
    console.log(`[run] ${name}`);
    await callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };

  async function fixture() {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ae3b-fixture-"))
    );
    const repositoryPath = path.join(root, "repo");
    const remotePath = path.join(root, "remote.git");
    const registryDirectoryPath = path.join(root, "registry");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(registryDirectoryPath, { mode: 0o700 });
    fs.chmodSync(registryDirectoryPath, 0o700);

    git(root, ["init", "--bare", "--quiet", remotePath]);
    git(repositoryPath, ["init", "--quiet"]);
    git(repositoryPath, ["branch", "-m", "main"]);
    git(repositoryPath, ["remote", "add", "origin", remotePath]);

    write(repositoryPath, "src/a.ts", "export const a = 1;\n");
    write(repositoryPath, "src/b.ts", "export const b = 1;\n");
    write(
      repositoryPath,
      "src/unchanged.ts",
      "export const unchanged = true;\n"
    );
    git(repositoryPath, ["add", "--", "."]);
    git(repositoryPath, ["commit", "--quiet", "-m", "baseline"]);
    git(repositoryPath, ["push", "--quiet", "-u", "origin", "main"]);

    const changedFiles = ["src/a.ts", "src/b.ts"];
    const baseline = await inspectControlledRepository({
      repositoryPath,
      changedFiles
    });
    assert.equal(
      baseline.decision,
      "repository_inspection_ready",
      JSON.stringify(baseline)
    );

    write(repositoryPath, "src/a.ts", "export const a = 2;\n");
    write(repositoryPath, "src/b.ts", "export const b = 2;\n");

    const appliedFiles = [];
    for (const filePath of changedFiles) {
      const absolute = path.join(repositoryPath, filePath);
      const bytes = fs.readFileSync(absolute);
      const metadata = fs.statSync(absolute);
      const mode = (metadata.mode & 0o111) !== 0 ? "100755" : "100644";
      const contentHash = `sha256:${createHash("sha256")
        .update(bytes)
        .digest("hex")}`;
      const stateHash = hashCanonicalJson({
        artifactType: "controlled_repository_file_state",
        state: "regular_file",
        mode,
        contentHash
      });
      appliedFiles.push({
        filePath,
        operation: "update",
        finalState: "regular_file",
        finalMode: mode,
        finalContentHash: contentHash,
        finalStateHash: stateHash,
        gitStatusObserved: true
      });
    }

    const applyMaterial = {
      receiptVersion: "1",
      outcome: "applied",
      authorizationHash: hash("authorization"),
      governedArtifactHash: hash("governed-artifact"),
      handoffHash: hash("handoff"),
      consumptionKey: hash("consumption"),
      reservationHash: hash("reservation"),
      transactionHash: hash("transaction"),
      mutation: {
        changeKind: "repair_draft",
        mutationHash: hash("mutation"),
        changedFiles,
        changedFileCount: changedFiles.length
      },
      before: {
        repositoryIdentityHash:
          baseline.inspection.target.repositoryIdentityHash,
        baseRevisionHash:
          baseline.inspection.target.baseRevisionHash,
        worktreeStateHash:
          baseline.inspection.target.worktreeStateHash,
        expectedInspectionHash:
          baseline.inspection.inspectionHash,
        rollbackManifestHash:
          baseline.inspection.rollbackManifest.manifestHash,
        rollbackBundleManifestHash: hash("bundle-manifest"),
        rollbackBundleReceiptHash: hash("bundle-receipt"),
        rollbackPayloadRootHash: hash("bundle-root")
      },
      after: {
        appliedStateHash: hash("applied-state"),
        finalScopeHash: hash("final-scope"),
        appliedFiles,
        observedChangedFiles: changedFiles,
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
        finalRepositoryMatchesBeforeState: false,
        gitIndexMutated: false,
        gitHistoryMutated: false,
        shellExecuted: false
      }
    };
    const applyReceipt = withHash(applyMaterial, "receiptHash");

    const integratedMaterial = {
      receiptVersion: "1",
      outcome: "contract_approved",
      contextToApplyBindingHash: hash("context-to-apply"),
      contextAuthorizationHash: hash("context-authorization"),
      coderMutationHash: hash("coder-mutation"),
      repairMutationHash: hash("repair-mutation"),
      executionAuthorizationHash: hash("execution-authorization"),
      governedArtifactHash: applyReceipt.governedArtifactHash,
      handoffHash: applyReceipt.handoffHash,
      consumptionKey: applyReceipt.consumptionKey,
      acceptance: {
        contractHash: hash("acceptance-contract"),
        preflightCoverageReceiptHash: hash("preflight-coverage"),
        finalCoverageReceiptHash: hash("final-coverage"),
        requiredCriterionCount: 2,
        approvedCriterionCount: 2,
        coverageComplete: true
      },
      apply: {
        x4ApplyReceiptHash: applyReceipt.receiptHash,
        appliedStateHash: applyReceipt.after.appliedStateHash,
        finalScopeHash: applyReceipt.after.finalScopeHash,
        changedFiles
      },
      validation: {
        x5FinalReceiptHash: hash("x5-final"),
        currentExecutionResultHash: hash("execution-result"),
        finalInspectionHash: hash("final-inspection"),
        finalRepositoryState: "validated_applied_state"
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
    const integratedReceipt = withHash(
      integratedMaterial,
      "receiptHash"
    );

    const receiptReferences = [
      ["integrated_apply", integratedReceipt.receiptHash],
      ["context_to_apply", integratedReceipt.contextToApplyBindingHash],
      ["acceptance_contract", integratedReceipt.acceptance.contractHash],
      [
        "preflight_coverage",
        integratedReceipt.acceptance.preflightCoverageReceiptHash
      ],
      [
        "final_coverage",
        integratedReceipt.acceptance.finalCoverageReceiptHash
      ],
      ["x4_apply", applyReceipt.receiptHash],
      ["x5_final", integratedReceipt.validation.x5FinalReceiptHash]
    ].map(([receiptType, receiptHash]) => ({
      kind: "receipt",
      evidenceId: `receipt.${receiptType}`,
      receiptType,
      receiptHash
    }));
    const fileReferences = appliedFiles.map((entry, index) => ({
      kind: "file",
      evidenceId: `file.${String(index).padStart(2, "0")}`,
      filePath: entry.filePath,
      contentHash: entry.finalContentHash,
      sourceApplyReceiptHash: applyReceipt.receiptHash
    }));
    const testReference = {
      kind: "test",
      evidenceId: "test.final-validation",
      commandId: "validate",
      resultHash:
        integratedReceipt.validation.currentExecutionResultHash,
      sourceValidationReceiptHash:
        integratedReceipt.validation.x5FinalReceiptHash
    };

    const contractResult = buildDraftPrDeliveryContract({
      integratedReceipt,
      applyReceipt,
      repository: {
        owner: "theOguz16",
        name: "bounded-dllm-agent-lab",
        baseBranch: "main"
      },
      commit: {
        message: "feat: deliver governed GitHub fixture"
      },
      pullRequest: {
        title: "feat: deliver governed GitHub fixture",
        body: "## Summary\n\nGoverned GitHub fixture."
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

    const localResult = await executeControlledLocalDelivery({
      repositoryPath,
      registryDirectoryPath,
      contract: contractResult.contract,
      integratedReceipt,
      applyReceipt
    });
    assert.equal(
      localResult.decision,
      "controlled_local_delivery_committed",
      JSON.stringify(localResult)
    );

    const pushResult = await executeControlledRemoteBranchPush({
      repositoryPath,
      registryDirectoryPath,
      remoteName: "origin",
      localDeliveryReceipt: localResult.receipt,
      contract: contractResult.contract,
      integratedReceipt,
      applyReceipt
    });
    assert.equal(
      pushResult.decision,
      "controlled_remote_branch_pushed",
      JSON.stringify(pushResult)
    );

    const client = new FakeGithubClient({
      owner: "theOguz16",
      name: "bounded-dllm-agent-lab",
      defaultBranch: "main",
      branches: [
        ["main", pushResult.receipt.remote.baseCommitHash],
        [
          contractResult.contract.branch.name,
          pushResult.receipt.remote.headCommitHash
        ]
      ],
      files: changedFiles
    });

    roots.push(root);
    return {
      repositoryPath,
      registryDirectoryPath,
      contract: contractResult.contract,
      integratedReceipt,
      applyReceipt,
      localDeliveryReceipt: localResult.receipt,
      remotePushReceipt: pushResult.receipt,
      client
    };
  }

  function input(value) {
    return {
      repositoryPath: value.repositoryPath,
      registryDirectoryPath: value.registryDirectoryPath,
      remoteName: "origin",
      remotePushReceipt: value.remotePushReceipt,
      localDeliveryReceipt: value.localDeliveryReceipt,
      contract: value.contract,
      integratedReceipt: value.integratedReceipt,
      applyReceipt: value.applyReceipt,
      client: value.client
    };
  }

  await check(
    "current remote push receipt creates exact open draft PR",
    async () => {
      const value = await fixture();
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_created",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 1);
      assert.equal(result.receipt.pullRequest.draft, true);
      assert.equal(result.receipt.pullRequest.state, "open");
      assert.deepEqual(
        result.receipt.pullRequest.changedFiles,
        ["src/a.ts", "src/b.ts"]
      );
    }
  );

  await check(
    "draft PR receipt verifies current and downstream eligible",
    async () => {
      const value = await fixture();
      const result = await executeControlledGithubDraftPr(input(value));
      const verification = await verifyControlledGithubDraftPrReceipt({
        ...input(value),
        receipt: result.receipt
      });
      assert.equal(
        verification.decision,
        "controlled_github_draft_pr_receipt_current",
        JSON.stringify(verification)
      );
      assert.equal(verification.downstreamEligible, true);
    }
  );

  await check(
    "replay returns current receipt without second PR",
    async () => {
      const value = await fixture();
      const first = await executeControlledGithubDraftPr(input(value));
      const second = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        second.decision,
        "controlled_github_draft_pr_already_created",
        JSON.stringify(second)
      );
      assert.equal(value.client.createCalls, 1);
      assert.equal(second.receipt.receiptHash, first.receipt.receiptHash);
    }
  );

  await check(
    "unclaimed existing open PR blocks duplicate creation",
    async () => {
      const value = await fixture();
      value.client.seedPullRequest({
        state: "open",
        draft: true,
        title: value.contract.pullRequest.title,
        body: value.contract.pullRequest.body,
        baseBranch: value.contract.pullRequest.baseBranch,
        baseCommitHash: value.remotePushReceipt.remote.baseCommitHash,
        headBranch: value.contract.pullRequest.headBranch,
        headCommitHash: value.remotePushReceipt.remote.headCommitHash
      });
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_blocked",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
      assert.equal(result.summary.durableClaimCreated, false);
    }
  );

  await check(
    "repository identity mismatch blocks before durable claim",
    async () => {
      const value = await fixture();
      value.client.name = "different-repository";
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_needs_review",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
      assert.equal(result.summary.durableClaimCreated, false);
    }
  );

  await check(
    "default branch mismatch blocks before durable claim",
    async () => {
      const value = await fixture();
      value.client.defaultBranch = "develop";
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_needs_review",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
    }
  );

  await check(
    "GitHub base drift blocks before PR creation",
    async () => {
      const value = await fixture();
      value.client.branches.set(
        "main",
        value.remotePushReceipt.remote.headCommitHash
      );
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_needs_review",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
    }
  );

  await check(
    "GitHub head drift blocks before PR creation",
    async () => {
      const value = await fixture();
      value.client.branches.set(
        value.contract.branch.name,
        value.remotePushReceipt.remote.baseCommitHash
      );
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_needs_review",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
    }
  );

  await check(
    "create failure after durable claim requires recovery",
    async () => {
      const value = await fixture();
      value.client.failCreate = true;
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_recovery_required",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 1);
      assert.equal(result.summary.durableClaimCreated, true);
    }
  );

  await check(
    "non-draft created PR requires recovery",
    async () => {
      const value = await fixture();
      value.client.createdDraft = false;
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_recovery_required",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 1);
      assert.equal(result.summary.pullRequestDraft, false);
    }
  );

  await check(
    "created PR file mismatch requires recovery",
    async () => {
      const value = await fixture();
      value.client.createdFiles = ["src/a.ts", "unexpected.ts"];
      const result = await executeControlledGithubDraftPr(input(value));
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_recovery_required",
        JSON.stringify(result)
      );
      assert.equal(result.summary.pullRequestFilesMatched, false);
    }
  );

  await check(
    "tampered remote push receipt cannot authorize PR creation",
    async () => {
      const value = await fixture();
      const tampered = structuredClone(value.remotePushReceipt);
      tampered.remote.headCommitHash = tampered.remote.baseCommitHash;
      const result = await executeControlledGithubDraftPr({
        ...input(value),
        remotePushReceipt: tampered
      });
      assert.equal(
        result.decision,
        "controlled_github_draft_pr_invalid",
        JSON.stringify(result)
      );
      assert.equal(value.client.createCalls, 0);
    }
  );

  await check(
    "executor uses typed GitHub client and no shell or Git mutation",
    async () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/controlled-github-draft-pr.ts"
        ),
        "utf8"
      );
      assert.equal(
        /child_process|execFile|execSync|shell\s*:\s*true|git\s+push|gh\s+pr/i
          .test(source),
        false
      );
      assert.match(source, /createDraftPullRequest/);
      assert.match(source, /https:\/\/api\.github\.com/);
      assert.match(source, /draft:\s*true/);
    }
  );

  console.log(
    `controlled GitHub draft PR smoke passed (${checks} checks)`
  );

  for (const root of roots.reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
