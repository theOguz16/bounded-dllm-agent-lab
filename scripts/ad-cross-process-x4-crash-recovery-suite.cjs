#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  execFileSync,
  spawn
} = require("node:child_process");
const { once } = require("node:events");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AD1 Fixture",
  GIT_AUTHOR_EMAIL: "ad1@example.invalid",
  GIT_COMMITTER_NAME: "AD1 Fixture",
  GIT_COMMITTER_EMAIL: "ad1@example.invalid"
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
  fs.mkdirSync(path.dirname(target), {
    recursive: true
  });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o644);
}

function gitMetadata(root) {
  const gitDirectory = path.resolve(
    root,
    git(root, ["rev-parse", "--git-dir"]).trim()
  );

  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(
      root,
      ["branch", "--show-current"]
    ).trim(),
    index: fs
      .readFileSync(path.join(gitDirectory, "index"))
      .toString("hex"),
    refs: git(root, ["show-ref"]),
    tags: git(root, ["tag", "--list"]),
    config: fs
      .readFileSync(path.join(gitDirectory, "config"))
      .toString("hex")
  };
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
}

async function waitForMarker(
  marker,
  failureMarker,
  child,
  timeoutMs = 20000
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (fs.existsSync(marker)) {
      return;
    }

    if (fs.existsSync(failureMarker)) {
      throw new Error(
        fs.readFileSync(failureMarker, "utf8")
      );
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Worker exited before checkpoint: exit=${child.exitCode} signal=${child.signalCode}`
      );
    }

    await delay(2);
  }

  throw new Error(
    `Timed out waiting for ${path.basename(marker)}`
  );
}

async function killStoppedWorker(child) {
  const exitPromise = Promise.race([
    once(child, "exit"),
    delay(5000).then(() => {
      throw new Error("SIGKILL worker exit timeout");
    })
  ]);

  const signalSent = child.kill("SIGKILL");

  assert.equal(
    signalSent,
    true,
    "SIGKILL could not be sent to the stopped worker"
  );

  const [code, signal] = await exitPromise;

  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function check(name, callback) {
  console.log(`[run] ${name}`);

  try {
    await callback();
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
    buildControlledApplyHandoff,
    buildTemporaryWorkspaceExecutionVerificationEvidence,
    computeGovernedMutationHash,
    evaluateControlledApplyExecutionGate,
    executeControlledPostApplyValidation,
    executeControlledTransactionRecovery,
    hashCanonicalJson,
    inspectControlledRepository,
    inspectControlledTransactionRecovery,
    materializeControlledRollbackBundle,
    verifyControlledTransactionRecoveryReceipt,
    verifyTemporaryWorkspaceExecution
  } = runtime;

  const roots = [];
  const workerPath = path.resolve(
    "scripts/ad-cross-process-crash-worker.cjs"
  );

  const hash = (label) =>
    hashCanonicalJson({ label });

  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash:
        artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash:
        artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash:
        artifact.change.executionVerificationResultHash,
      preShadowTraceHash:
        artifact.evidence.preShadowTraceHash,
      observationHash:
        artifact.evidence.observationHash,
      governanceHash:
        artifact.evidence.governanceHash,
      adminInvocationPolicyHash:
        artifact.evidence.adminInvocationPolicyHash,
      adminInvocationAssessmentHash:
        artifact.evidence.adminInvocationAssessmentHash,
      adminDecisionHash:
        artifact.evidence.adminDecisionHash,
      routeHash:
        artifact.evidence.routeHash,
      governancePolicyHash:
        artifact.evidence.governancePolicyHash,
      routerPolicyHash:
        artifact.evidence.routerPolicyHash,
      finalLedgerRootHash:
        artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount:
        artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision:
        artifact.decisions.phaseVFinalDecision,
      workflowRoute:
        artifact.decisions.workflowRoute
    };
  }

  function artifactFor(
    mutation,
    executionVerificationResultHash
  ) {
    const material = {
      artifactVersion: "2",
      change: {
        changeKind: "repair_draft",
        mutationHash: computeGovernedMutationHash(
          "repair_draft",
          mutation
        ),
        changedFiles: [...mutation.touchedFiles],
        patchDryRunResultHash:
          hash("ad1:dry-run"),
        temporaryApplyResultHash:
          hash("ad1:temporary-apply"),
        executionVerificationResultHash,
        stageEvents: {
          mutationSourceEventId:
            "run:event:000005",
          patchDryRunEventId:
            "run:event:000007",
          temporaryApplyEventId:
            "run:event:000008",
          executionVerifierEventId:
            "run:event:000009",
          shadowObserverEventId:
            "run:event:000010",
          deterministicGovernorEventId:
            "run:event:000011",
          adminInvocationPolicyEventId:
            "run:event:000012",
          adminAgentEventId: null,
          approvalRouterEventId:
            "run:event:000013"
        }
      },
      evidence: {
        runId:
          `ad1-${Date.now()}-${Math.random()}`,
        objectiveHash:
          hash("ad1:objective"),
        preShadowLedgerRootHash:
          hash("ad1:pre-root"),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash:
          hash("ad1:trace"),
        observationHash:
          hash("ad1:observation"),
        governanceHash:
          hash("ad1:governance"),
        adminInvocationPolicyHash:
          hash("ad1:invocation-policy"),
        adminInvocationAssessmentHash:
          hash("ad1:invocation-assessment"),
        adminDecisionHash: null,
        routeHash:
          hash("ad1:route"),
        governancePolicyHash:
          hash("governance-policy"),
        routerPolicyHash:
          hash("router-policy-v2"),
        finalLedgerRootHash:
          hash("ad1:final-root"),
        finalLedgerEventCount: 13
      },
      decisions: {
        phaseVFinalDecision:
          "temp_validation_passed",
        shadowStageDecision:
          "shadow_observer_completed",
        shadowValidationDecision:
          "shadow_observation_valid",
        governanceDecision:
          "governance_passed",
        adminInvocationMode:
          "conditional",
        adminInvocationDecision:
          "admin_invocation_skipped",
        adminInvocationSkipKind:
          "clean_path",
        adminResolutionKind:
          "verified_policy_skip",
        adminStageDecision:
          "admin_skipped_by_policy",
        adminValidationDecision: null,
        adminDecision: null,
        routerValidationDecision:
          "approval_route_valid",
        workflowRoute:
          "auto_continue"
      },
      applyEligibility: {
        eligible: true,
        reasonCodes: []
      }
    };

    return {
      ...material,
      governedArtifactHash:
        hashCanonicalJson(material)
    };
  }

  async function phaseVEvidence(
    specification,
    proposedFiles
  ) {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(
        path.join(os.tmpdir(), "ad1-phase-v-")
      )
    );
    roots.push(workspace);

    for (
      const [file, content]
      of Object.entries(proposedFiles)
    ) {
      write(workspace, file, content);
    }

    const result =
      verifyTemporaryWorkspaceExecution({
        tempWorkspacePath: workspace,
        tempApplyDecision:
          "temp_apply_ready",
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
    fileCount = 1,
    proposedBytes = 0,
    withPhaseV = false
  } = {}) {
    const repositoryPath = fs.realpathSync(
      fs.mkdtempSync(
        path.join(os.tmpdir(), "ad1-repo-")
      )
    );
    const bundleParent = fs.realpathSync(
      fs.mkdtempSync(
        path.join(os.tmpdir(), "ad1-bundle-")
      )
    );
    const registryDirectoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(os.tmpdir(), "ad1-registry-")
        )
      );
    const validationWorkspaceParentPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(os.tmpdir(), "ad1-workspaces-")
        )
      );
    const controlDirectoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(os.tmpdir(), "ad1-control-")
        )
      );

    roots.push(
      repositoryPath,
      bundleParent,
      registryDirectoryPath,
      validationWorkspaceParentPath,
      controlDirectoryPath
    );

    git(repositoryPath, ["init", "--quiet"]);

    const files = Array.from(
      { length: fileCount },
      (_, index) =>
        `src/file-${String(index).padStart(4, "0")}.txt`
    );

    const baselineFiles = {};
    const proposedFiles = {};

    for (const [index, file] of files.entries()) {
      const baseline =
        `AD1_BASELINE_${index}\n`;
      const padding =
        proposedBytes > 0
          ? "x".repeat(
              Math.max(
                0,
                proposedBytes -
                  Buffer.byteLength(
                    `AD1_APPLIED_${index}\n`,
                    "utf8"
                  )
              )
            )
          : "";
      const proposed =
        `AD1_APPLIED_${index}\n${padding}`;

      baselineFiles[file] = baseline;
      proposedFiles[file] = proposed;
      write(repositoryPath, file, baseline);
    }

    git(repositoryPath, ["add", "--", "."]);
    git(
      repositoryPath,
      ["commit", "--quiet", "-m", "fixture"]
    );

    let phaseVExecutionSpecification = null;
    let phaseVExecutionVerification = null;

    if (withPhaseV) {
      const firstFile = files[0];
      const expectedHash = crypto
        .createHash("sha256")
        .update(
          Buffer.from(
            proposedFiles[firstFile],
            "utf8"
          )
        )
        .digest("hex");

      phaseVExecutionSpecification = {
        commands: [
          {
            id: "validate",
            executable: "node",
            args: [
              "-e",
              [
                "const fs=require('fs');",
                "const crypto=require('crypto');",
                `const value=fs.readFileSync(${JSON.stringify(firstFile)});`,
                "const actual=crypto.createHash('sha256').update(value).digest('hex');",
                `process.exit(actual===${JSON.stringify(expectedHash)}?0:1);`
              ].join("")
            ]
          }
        ],
        allowedExecutables: ["node"],
        maxCommands: 5,
        defaultTimeoutMs: 30000,
        maxTimeoutMs: 120000,
        maxOutputChars: 20000
      };

      phaseVExecutionVerification =
        await phaseVEvidence(
          phaseVExecutionSpecification,
          proposedFiles
        );
    }

    const mutation = {
      role: "remask",
      target: "repairDraft",
      summary:
        "Apply a bounded AD.1 crash fixture.",
      claims: files.map((file) => ({
        type: "repair_draft",
        file,
        proposedPatch: proposedFiles[file]
      })),
      touchedFiles: [...files],
      confidence: 0.9
    };

    const inspection =
      await inspectControlledRepository({
        repositoryPath,
        changedFiles:
          mutation.touchedFiles
      });

    assert.equal(
      inspection.decision,
      "repository_inspection_ready",
      JSON.stringify(inspection)
    );

    const artifact = artifactFor(
      mutation,
      phaseVExecutionVerification
        ?.verificationResultHash ??
        hash("ad1:execution")
    );
    const currentFreshnessSnapshot =
      freshnessFrom(artifact);

    const handoff =
      buildControlledApplyHandoff({
        artifact,
        currentFreshnessSnapshot,
        mutation,
        target:
          inspection.inspection.target
      });

    assert.equal(
      handoff.decision,
      "controlled_apply_handoff_ready",
      JSON.stringify(handoff)
    );

    const bundleDirectoryPath =
      path.join(bundleParent, "bundle");

    const bundle =
      await materializeControlledRollbackBundle({
        repositoryPath,
        bundleDirectoryPath,
        changedFiles:
          mutation.touchedFiles,
        expectedInspection:
          inspection.inspection,
        handoff:
          handoff.handoff,
        artifact,
        currentFreshnessSnapshot,
        mutation,
        consumptionStatus:
          "not_consumed"
      });

    assert.equal(
      bundle.decision,
      "rollback_bundle_ready",
      JSON.stringify(bundle)
    );

    const gateInput = {
      repositoryPath,
      bundleDirectoryPath,
      changedFiles:
        [...mutation.touchedFiles],
      artifact,
      currentFreshnessSnapshot,
      mutation,
      handoff:
        handoff.handoff,
      expectedInspection:
        inspection.inspection,
      rollbackBundleManifest:
        bundle.manifest,
      rollbackBundleReceipt:
        bundle.receipt,
      consumptionStatus:
        "not_consumed"
    };

    const gate =
      await evaluateControlledApplyExecutionGate(
        gateInput
      );

    assert.equal(
      gate.decision,
      "controlled_apply_execution_gate_ready",
      JSON.stringify(gate)
    );

    const consumptionSuffix =
      gate.authorization.consumptionKey.slice(7);
    const claimPath = path.join(
      registryDirectoryPath,
      "claims",
      consumptionSuffix
    );
    const validationPath = path.join(
      registryDirectoryPath,
      "validations",
      consumptionSuffix
    );

    return {
      repositoryPath,
      bundleDirectoryPath,
      registryDirectoryPath,
      validationWorkspaceParentPath,
      controlDirectoryPath,
      authorization:
        gate.authorization,
      gateInput,
      claimPath,
      validationPath,
      baselineFiles,
      proposedFiles,
      phaseVExecutionSpecification,
      phaseVExecutionVerification,
      gitBefore:
        gitMetadata(repositoryPath)
    };
  }

  function recoveryInput(value) {
    return {
      repositoryPath:
        value.repositoryPath,
      bundleDirectoryPath:
        value.bundleDirectoryPath,
      registryDirectoryPath:
        value.registryDirectoryPath,
      validationWorkspaceParentPath:
        value.validationWorkspaceParentPath,
      authorization:
        value.authorization,
      gateInput:
        value.gateInput,
      consumptionKey:
        value.authorization.consumptionKey
    };
  }

  function assertBaseline(value) {
    for (
      const [file, expected]
      of Object.entries(value.baselineFiles)
    ) {
      assert.equal(
        fs.readFileSync(
          path.join(value.repositoryPath, file),
          "utf8"
        ),
        expected,
        file
      );
    }
  }

  function assertApplied(value) {
    for (
      const [file, expected]
      of Object.entries(value.proposedFiles)
    ) {
      assert.equal(
        fs.readFileSync(
          path.join(value.repositoryPath, file),
          "utf8"
        ),
        expected,
        file
      );
    }
  }

  async function verifyRecoveryReceipt(
    value,
    receipt
  ) {
    const verification =
      await verifyControlledTransactionRecoveryReceipt({
        repositoryPath:
          value.repositoryPath,
        registryDirectoryPath:
          value.registryDirectoryPath,
        receipt,
        authorization:
          value.authorization,
        expectedInspection:
          value.gateInput.expectedInspection
      });

    assert.equal(
      verification.decision,
      "controlled_transaction_recovery_receipt_current",
      JSON.stringify(verification)
    );
  }

  async function spawnKilledApply(
    value,
    name,
    present,
    absent,
    holdAfterApply = false
  ) {
    const payloadPath = path.join(
      value.controlDirectoryPath,
      `${name}-payload.json`
    );
    const resultPath = path.join(
      value.controlDirectoryPath,
      `${name}-result.json`
    );
    const observedMarker = path.join(
      value.controlDirectoryPath,
      `${name}-observed.json`
    );
    const failureMarker = path.join(
      value.controlDirectoryPath,
      `${name}-failed.json`
    );

    fs.writeFileSync(
      payloadPath,
      JSON.stringify({
        mode: "apply",
        applyInput: {
          authorization:
            value.authorization,
          gateInput:
            value.gateInput,
          registryDirectoryPath:
            value.registryDirectoryPath
        },
        resultPath,
        holdAfterApply,
        observedMarker,
        checkpoint:
          holdAfterApply
            ? null
            : {
                name,
                present,
                absent,
                observedMarker,
                failureMarker,
                timeoutMs: 15000
              }
      }),
      { mode: 0o600 }
    );

    const child = spawn(
      process.execPath,
      [workerPath, payloadPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test"
        },
        stdio: "ignore"
      }
    );

    await waitForMarker(
      observedMarker,
      failureMarker,
      child,
      20000
    );
    await killStoppedWorker(child);

    return {
      resultPath,
      observedMarker
    };
  }

  async function spawnValidation(
    value,
    applyReceipt
  ) {
    const payloadPath = path.join(
      value.controlDirectoryPath,
      "resume-validation-payload.json"
    );
    const resultPath = path.join(
      value.controlDirectoryPath,
      "resume-validation-result.json"
    );

    fs.writeFileSync(
      payloadPath,
      JSON.stringify({
        mode: "validation",
        validationInput: {
          applyReceipt,
          authorization:
            value.authorization,
          gateInput:
            value.gateInput,
          registryDirectoryPath:
            value.registryDirectoryPath,
          validationWorkspaceParentPath:
            value.validationWorkspaceParentPath,
          phaseVExecutionSpecification:
            value.phaseVExecutionSpecification,
          phaseVExecutionVerification:
            value.phaseVExecutionVerification
        },
        resultPath
      }),
      { mode: 0o600 }
    );

    const child = spawn(
      process.execPath,
      [workerPath, payloadPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test"
        },
        stdio: "ignore"
      }
    );

    const [code, signal] =
      await once(child, "exit");

    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(
      fs.existsSync(resultPath),
      true
    );

    return readJson(resultPath);
  }

  async function recoverPrewriteCheckpoint(
    name,
    checkpointFactory,
    fixtureOptions
  ) {
    let lastError = null;

    for (
      let attempt = 0;
      attempt < 3;
      attempt += 1
    ) {
      const value =
        await fixture(fixtureOptions);

      try {
        const checkpoint =
          checkpointFactory(value);

        await spawnKilledApply(
          value,
          name,
          checkpoint.present,
          checkpoint.absent
        );

        const inspection =
          await inspectControlledTransactionRecovery(
            recoveryInput(value)
          );

        if (
          inspection.decision !==
            "controlled_transaction_recovery_inspection_ready" ||
          inspection.summary.x4State !==
            "x4_claim_created_prewrite_incomplete"
        ) {
          throw new Error(
            `Checkpoint window missed: ${JSON.stringify({
              decision:
                inspection.decision,
              x4State:
                inspection.summary.x4State,
              issues:
                inspection.issues.map(
                  (entry) => entry.code
                )
            })}`
          );
        }

        const result =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          result.decision,
          "controlled_transaction_recovery_closed_prewrite",
          JSON.stringify(result)
        );
        assert.equal(
          result.receipt.outcome,
          "abandoned_before_repository_write"
        );
        assert.equal(
          result.summary.repositoryWriteAttempted,
          false
        );
        assertBaseline(value);
        assert.deepEqual(
          gitMetadata(value.repositoryPath),
          value.gitBefore
        );
        assert.equal(
          fs.existsSync(value.claimPath),
          true
        );
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  try {
    await check(
      "SIGKILL after durable reservation closes prewrite without repository write",
      async () => {
        await recoverPrewriteCheckpoint(
          "after_reservation",
          (value) => ({
            present: [
              path.join(
                value.claimPath,
                "reservation.json"
              )
            ],
            absent: [
              path.join(
                value.claimPath,
                "transaction.json"
              ),
              path.join(
                value.claimPath,
                "WRITE_STARTED"
              )
            ]
          }),
          {
            fileCount: 400,
            proposedBytes: 0
          }
        );
      }
    );

    await check(
      "SIGKILL after transaction intent closes prewrite without repository write",
      async () => {
        await recoverPrewriteCheckpoint(
          "after_transaction_intent",
          (value) => ({
            present: [
              path.join(
                value.claimPath,
                "transaction.json"
              )
            ],
            absent: [
              path.join(
                value.claimPath,
                "WRITE_STARTED"
              )
            ]
          }),
          {
            fileCount: 160,
            proposedBytes: 0
          }
        );
      }
    );

    await check(
      "SIGKILL after WRITE_STARTED restores exact X1 baseline",
      async () => {
        const value = await fixture({
          fileCount: 24,
          proposedBytes: 512 * 1024
        });

        await spawnKilledApply(
          value,
          "after_write_started",
          [
            path.join(
              value.claimPath,
              "WRITE_STARTED"
            )
          ],
          [
            path.join(
              value.claimPath,
              "steps",
              "000000.json"
            )
          ]
        );

        const inspection =
          await inspectControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          inspection.summary.x4State,
          "x4_write_started_incomplete",
          JSON.stringify(inspection)
        );

        const result =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          result.decision,
          "controlled_transaction_recovery_rolled_back",
          JSON.stringify(result)
        );
        assert.equal(
          result.summary.rollbackSucceeded,
          true
        );
        assertBaseline(value);
        assert.deepEqual(
          gitMetadata(value.repositoryPath),
          value.gitBefore
        );
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
      }
    );

    await check(
      "SIGKILL after first persisted file step restores all files",
      async () => {
        const value = await fixture({
          fileCount: 24,
          proposedBytes: 512 * 1024
        });

        await spawnKilledApply(
          value,
          "after_first_file_write",
          [
            path.join(
              value.claimPath,
              "steps",
              "000000.json"
            )
          ],
          [
            path.join(
              value.claimPath,
              "COMMITTED"
            )
          ]
        );

        const inspection =
          await inspectControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          inspection.summary.x4State,
          "x4_write_started_incomplete",
          JSON.stringify(inspection)
        );

        const result =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          result.decision,
          "controlled_transaction_recovery_rolled_back",
          JSON.stringify(result)
        );
        assert.equal(
          result.summary.rollbackSucceeded,
          true
        );
        assertBaseline(value);
        assert.deepEqual(
          gitMetadata(value.repositoryPath),
          value.gitBefore
        );
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
      }
    );

    await check(
      "SIGKILL after X4 commit resumes X5 in a new process",
      async () => {
        const value = await fixture({
          fileCount: 1,
          proposedBytes: 0,
          withPhaseV: true
        });

        const crashed =
          await spawnKilledApply(
            value,
            "after_apply_complete",
            [],
            [],
            true
          );

        assert.equal(
          fs.existsSync(crashed.resultPath),
          true
        );

        const applyResult =
          readJson(crashed.resultPath);

        assert.equal(
          applyResult.decision,
          "controlled_repository_apply_succeeded",
          JSON.stringify(applyResult)
        );
        assertApplied(value);
        assert.deepEqual(
          gitMetadata(value.repositoryPath),
          value.gitBefore
        );

        const recoveryBeforeValidation =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          recoveryBeforeValidation.decision,
          "controlled_transaction_recovery_awaiting_validation",
          JSON.stringify(
            recoveryBeforeValidation
          )
        );
        assert.equal(
          recoveryBeforeValidation.summary
            .recoveryAttemptCreated,
          false
        );

        const validationResult =
          await spawnValidation(
            value,
            applyResult.receipt
          );

        assert.equal(
          validationResult.decision,
          "controlled_post_apply_validation_finalized",
          JSON.stringify(validationResult)
        );

        const recoveryAfterValidation =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          recoveryAfterValidation.decision,
          "controlled_transaction_recovery_not_required",
          JSON.stringify(
            recoveryAfterValidation
          )
        );
        assert.equal(
          recoveryAfterValidation.summary.x5State,
          "x5_finalized"
        );
        assertApplied(value);
        assert.deepEqual(
          gitMetadata(value.repositoryPath),
          value.gitBefore
        );
      }
    );

    console.log(
      "cross-process X4 crash recovery suite passed (5 checks)"
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
