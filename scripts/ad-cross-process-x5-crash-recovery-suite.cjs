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
  GIT_AUTHOR_NAME: "AD2 Fixture",
  GIT_AUTHOR_EMAIL: "ad2@example.invalid",
  GIT_COMMITTER_NAME: "AD2 Fixture",
  GIT_COMMITTER_EMAIL: "ad2@example.invalid"
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

  fs.mkdirSync(
    path.dirname(target),
    { recursive: true }
  );
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o644);
}

function gitMetadata(root) {
  const gitDirectory = path.resolve(
    root,
    git(root, ["rev-parse", "--git-dir"]).trim()
  );

  return {
    head: git(
      root,
      ["rev-parse", "HEAD"]
    ).trim(),
    branch: git(
      root,
      ["branch", "--show-current"]
    ).trim(),
    index: fs
      .readFileSync(
        path.join(gitDirectory, "index")
      )
      .toString("hex"),
    refs: git(root, ["show-ref"]),
    tags: git(root, ["tag", "--list"]),
    config: fs
      .readFileSync(
        path.join(gitDirectory, "config")
      )
      .toString("hex")
  };
}

function directoryHash(
  directory,
  hashCanonicalJson
) {
  function walk(current, relative = "") {
    const result = [];

    for (
      const name
      of fs.readdirSync(current).sort()
    ) {
      const absolute =
        path.join(current, name);
      const childRelative =
        path.posix.join(relative, name);
      const metadata =
        fs.lstatSync(absolute);

      if (
        metadata.isDirectory() &&
        !metadata.isSymbolicLink()
      ) {
        result.push([
          childRelative,
          "directory",
          walk(absolute, childRelative)
        ]);
      } else {
        result.push([
          childRelative,
          "file",
          fs
            .readFileSync(absolute)
            .toString("hex")
        ]);
      }
    }

    return result;
  }

  return hashCanonicalJson(
    walk(directory)
  );
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
  timeoutMs = 25000
) {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt <= timeoutMs
  ) {
    if (fs.existsSync(marker)) {
      return;
    }

    if (fs.existsSync(failureMarker)) {
      throw new Error(
        fs.readFileSync(
          failureMarker,
          "utf8"
        )
      );
    }

    if (
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
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
      throw new Error(
        "SIGKILL worker exit timeout"
      );
    })
  ]);

  const signalSent =
    child.kill("SIGKILL");

  assert.equal(
    signalSent,
    true,
    "SIGKILL could not be sent to the stopped worker"
  );

  const [code, signal] =
    await exitPromise;

  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

function killPidFromFile(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const pid = Number(
    fs.readFileSync(pidFile, "utf8")
  );

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(
      "Validation command PID is invalid."
    );
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }

  return pid;
}

function processExists(pid) {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function waitForProcessExit(
  pid,
  timeoutMs = 5000
) {
  if (pid === null) {
    return;
  }

  const startedAt = Date.now();

  while (
    Date.now() - startedAt <= timeoutMs
  ) {
    if (!processExists(pid)) {
      return;
    }

    await delay(10);
  }

  throw new Error(
    `Validation subprocess ${pid} did not exit.`
  );
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
    executeControlledRepositoryApply,
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
      runId:
        artifact.evidence.runId,
      objectiveHash:
        artifact.evidence.objectiveHash,
      mutationHash:
        artifact.change.mutationHash,
      changedFiles:
        [...artifact.change.changedFiles],
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
        mutationHash:
          computeGovernedMutationHash(
            "repair_draft",
            mutation
          ),
        changedFiles:
          [...mutation.touchedFiles],
        patchDryRunResultHash:
          hash("ad2:dry-run"),
        temporaryApplyResultHash:
          hash("ad2:temporary-apply"),
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
          `ad2-${Date.now()}-${Math.random()}`,
        objectiveHash:
          hash("ad2:objective"),
        preShadowLedgerRootHash:
          hash("ad2:pre-root"),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash:
          hash("ad2:trace"),
        observationHash:
          hash("ad2:observation"),
        governanceHash:
          hash("ad2:governance"),
        adminInvocationPolicyHash:
          hash("ad2:invocation-policy"),
        adminInvocationAssessmentHash:
          hash("ad2:invocation-assessment"),
        adminDecisionHash: null,
        routeHash:
          hash("ad2:route"),
        governancePolicyHash:
          hash("governance-policy"),
        routerPolicyHash:
          hash("router-policy-v2"),
        finalLedgerRootHash:
          hash("ad2:final-root"),
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
    proposedContent
  ) {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ad2-phase-v-"
        )
      )
    );
    roots.push(workspace);

    write(
      workspace,
      "src/a.txt",
      proposedContent
    );

    const result =
      verifyTemporaryWorkspaceExecution({
        tempWorkspacePath:
          workspace,
        tempApplyDecision:
          "temp_apply_ready",
        tempWorkspaceCleanedUp:
          false,
        ...specification
      });

    fs.rmSync(
      workspace,
      {
        recursive: true,
        force: true
      }
    );

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
    fillerFileCount = 0,
    longRunningValidation = false
  } = {}) {
    const repositoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ad2-repo-"
          )
        )
      );
    const bundleParent =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ad2-bundle-"
          )
        )
      );
    const registryDirectoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ad2-registry-"
          )
        )
      );
    const validationWorkspaceParentPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ad2-workspaces-"
          )
        )
      );
    const controlDirectoryPath =
      fs.realpathSync(
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "ad2-control-"
          )
        )
      );

    roots.push(
      repositoryPath,
      bundleParent,
      registryDirectoryPath,
      validationWorkspaceParentPath,
      controlDirectoryPath
    );

    git(
      repositoryPath,
      ["init", "--quiet"]
    );

    const baseline =
      "AD2_BASELINE\n";
    const proposed =
      "AD2_APPLIED\n";

    write(
      repositoryPath,
      "src/a.txt",
      baseline
    );

    for (
      let index = 0;
      index < fillerFileCount;
      index += 1
    ) {
      write(
        repositoryPath,
        `fixtures/filler-${String(index).padStart(4, "0")}.txt`,
        `${"f".repeat(2048)}\n`
      );
    }

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
        "fixture"
      ]
    );

    const commandMarker =
      path.join(
        controlDirectoryPath,
        "validation-command-started"
      );
    const commandPidFile =
      path.join(
        controlDirectoryPath,
        "validation-command.pid"
      );

    const quickCommand = [
      "const fs=require('fs');",
      "const value=fs.readFileSync('src/a.txt','utf8');",
      "process.exit(value==='AD2_APPLIED\\n'?0:1);"
    ].join("");

    const longCommand = [
      "const fs=require('fs');",
      "if(process.cwd().includes('ad2-phase-v-'))process.exit(0);",
      "fs.writeFileSync(process.env.AD2_COMMAND_PID,String(process.pid));",
      "fs.writeFileSync(process.env.AD2_COMMAND_MARKER,'started');",
      "setInterval(()=>{},1000);"
    ].join("");

    const phaseVExecutionSpecification = {
      commands: [
        {
          id: "validate",
          executable: "node",
          args: [
            "-e",
            longRunningValidation
              ? longCommand
              : quickCommand
          ]
        }
      ],
      allowedExecutables: ["node"],
      maxCommands: 5,
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000,
      maxOutputChars: 20000,
      ...(longRunningValidation
        ? {
            environment: {
              AD2_COMMAND_MARKER:
                commandMarker,
              AD2_COMMAND_PID:
                commandPidFile
            }
          }
        : {})
    };

    const phaseVExecutionVerification =
      await phaseVEvidence(
        phaseVExecutionSpecification,
        proposed
      );

    const mutation = {
      role: "remask",
      target: "repairDraft",
      summary:
        "Apply a bounded AD.2 validation fixture.",
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

    const artifact =
      artifactFor(
        mutation,
        phaseVExecutionVerification
          .verificationResultHash
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
      path.join(
        bundleParent,
        "bundle"
      );

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

    const gitBefore =
      gitMetadata(repositoryPath);

    const applied =
      await executeControlledRepositoryApply({
        authorization:
          gate.authorization,
        gateInput,
        registryDirectoryPath
      });

    assert.equal(
      applied.decision,
      "controlled_repository_apply_succeeded",
      JSON.stringify(applied)
    );

    const consumptionSuffix =
      gate.authorization
        .consumptionKey
        .slice(7);
    const claimPath =
      path.join(
        registryDirectoryPath,
        "claims",
        consumptionSuffix
      );
    const validationPath =
      path.join(
        registryDirectoryPath,
        "validations",
        consumptionSuffix
      );
    const validationWorkspacePath =
      path.join(
        validationWorkspaceParentPath,
        `controlled-post-apply-${consumptionSuffix}.partial`
      );

    assert.equal(
      fs.readFileSync(
        path.join(
          repositoryPath,
          "src/a.txt"
        ),
        "utf8"
      ),
      proposed
    );
    assert.deepEqual(
      gitMetadata(repositoryPath),
      gitBefore
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
      applyReceipt:
        applied.receipt,
      claimPath,
      validationPath,
      validationWorkspacePath,
      baseline,
      proposed,
      gitBefore,
      phaseVExecutionSpecification,
      phaseVExecutionVerification,
      commandMarker,
      commandPidFile
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
        value.authorization
          .consumptionKey
    };
  }

  function assertBaseline(value) {
    assert.equal(
      fs.readFileSync(
        path.join(
          value.repositoryPath,
          "src/a.txt"
        ),
        "utf8"
      ),
      value.baseline
    );
    assert.deepEqual(
      gitMetadata(value.repositoryPath),
      value.gitBefore
    );
  }

  function assertApplied(value) {
    assert.equal(
      fs.readFileSync(
        path.join(
          value.repositoryPath,
          "src/a.txt"
        ),
        "utf8"
      ),
      value.proposed
    );
    assert.deepEqual(
      gitMetadata(value.repositoryPath),
      value.gitBefore
    );
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
          value.gateInput
            .expectedInspection
      });

    assert.equal(
      verification.decision,
      "controlled_transaction_recovery_receipt_current",
      JSON.stringify(verification)
    );
  }

  async function spawnKilledValidation(
    value,
    name,
    present,
    absent
  ) {
    const payloadPath =
      path.join(
        value.controlDirectoryPath,
        `${name}-payload.json`
      );
    const resultPath =
      path.join(
        value.controlDirectoryPath,
        `${name}-result.json`
      );
    const observedMarker =
      path.join(
        value.controlDirectoryPath,
        `${name}-observed.json`
      );
    const failureMarker =
      path.join(
        value.controlDirectoryPath,
        `${name}-failed.json`
      );

    fs.writeFileSync(
      payloadPath,
      JSON.stringify({
        mode: "validation",
        validationInput: {
          applyReceipt:
            value.applyReceipt,
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
        resultPath,
        checkpoint: {
          name,
          present,
          absent,
          observedMarker,
          failureMarker,
          timeoutMs: 20000
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
      child
    );
    await killStoppedWorker(child);

    const commandPid =
      killPidFromFile(
        value.commandPidFile
      );
    await waitForProcessExit(
      commandPid
    );

    return {
      resultPath,
      observedMarker,
      commandPid
    };
  }

  async function crashAtIntentOnly() {
    let lastError = null;

    for (
      let attempt = 0;
      attempt < 5;
      attempt += 1
    ) {
      const value = await fixture();

      try {
        await spawnKilledValidation(
          value,
          `intent-only-${attempt}`,
          [
            path.join(
              value.validationPath,
              "validation-intent.json"
            )
          ],
          [
            path.join(
              value.validationPath,
              "VALIDATION_STARTED"
            )
          ]
        );

        const inspection =
          await inspectControlledTransactionRecovery(
            recoveryInput(value)
          );

        if (
          inspection.decision !==
            "controlled_transaction_recovery_inspection_ready" ||
          inspection.summary.x5State !==
            "x5_intent_created_prevalidation_incomplete"
        ) {
          throw new Error(
            `Intent checkpoint window missed: ${JSON.stringify({
              decision:
                inspection.decision,
              x5State:
                inspection.summary.x5State,
              issues:
                inspection.issues.map(
                  (entry) => entry.code
                )
            })}`
          );
        }

        return {
          value,
          inspection
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async function crashAfterValidationStarted({
    fillerFileCount = 160
  } = {}) {
    const value = await fixture({
      fillerFileCount
    });

    await spawnKilledValidation(
      value,
      "after-validation-started",
      [
        path.join(
          value.validationPath,
          "VALIDATION_STARTED"
        )
      ],
      [
        path.join(
          value.validationPath,
          "validation-result.json"
        )
      ]
    );

    const inspection =
      await inspectControlledTransactionRecovery(
        recoveryInput(value)
      );

    assert.equal(
      inspection.decision,
      "controlled_transaction_recovery_inspection_ready",
      JSON.stringify(inspection)
    );
    assert.equal(
      inspection.summary.x5State,
      "x5_validation_started_incomplete"
    );

    return {
      value,
      inspection
    };
  }

  try {
    await check(
      "SIGKILL after X5 intent restores exact X1 baseline",
      async () => {
        const {
          value,
          inspection
        } = await crashAtIntentOnly();

        assert.equal(
          inspection.plan.action,
          "restore_x1_baseline"
        );

        const validationHashBefore =
          directoryHash(
            value.validationPath,
            hashCanonicalJson
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
        assert.equal(
          fs.existsSync(value.claimPath),
          true
        );
        assert.equal(
          directoryHash(
            value.validationPath,
            hashCanonicalJson
          ),
          validationHashBefore
        );
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
      }
    );

    await check(
      "SIGKILL after VALIDATION_STARTED is never accepted as passed",
      async () => {
        const {
          value,
          inspection
        } =
          await crashAfterValidationStarted();

        assert.equal(
          inspection.plan.action,
          "restore_x1_baseline"
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
          result.summary.x5State,
          "x5_validation_started_incomplete"
        );
        assert.equal(
          result.summary.rollbackSucceeded,
          true
        );
        assertBaseline(value);
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
      }
    );

    await check(
      "SIGKILL while validation command runs cleans workspace and restores baseline",
      async () => {
        const value = await fixture({
          fillerFileCount: 40,
          longRunningValidation: true
        });

        const crashed =
          await spawnKilledValidation(
            value,
            "validation-command-running",
            [
              value.commandMarker,
              path.join(
                value.validationPath,
                "VALIDATION_STARTED"
              )
            ],
            [
              path.join(
                value.validationPath,
                "validation-result.json"
              )
            ]
          );

        assert.equal(
          crashed.commandPid === null,
          false
        );
        assert.equal(
          processExists(
            crashed.commandPid
          ),
          false
        );
        assert.equal(
          fs.existsSync(
            value.validationWorkspacePath
          ),
          true
        );

        const inspection =
          await inspectControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          inspection.summary.x5State,
          "x5_validation_started_incomplete",
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
          result.summary
            .validationWorkspaceCleanupAttempted,
          true
        );
        assert.equal(
          result.summary
            .validationWorkspaceCleanupSucceeded,
          true
        );
        assert.equal(
          fs.existsSync(
            value.validationWorkspacePath
          ),
          false
        );
        assertBaseline(value);
        await verifyRecoveryReceipt(
          value,
          result.receipt
        );
      }
    );

    await check(
      "concurrent external drift prevents blind rollback until removed",
      async () => {
        const {
          value
        } =
          await crashAfterValidationStarted({
            fillerFileCount: 80
          });

        write(
          value.repositoryPath,
          "unrelated.txt",
          "AD2_EXTERNAL_DRIFT\n"
        );

        const recoveryRoot =
          path.join(
            value.registryDirectoryPath,
            "recoveries"
          );

        const blocked =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          blocked.decision,
          "controlled_transaction_recovery_needs_review",
          JSON.stringify(blocked)
        );
        assert.equal(
          blocked.summary.repositoryWriteAttempted,
          false
        );
        assert.equal(
          blocked.summary.recoveryAttemptCreated,
          false
        );
        assert.equal(
          fs.existsSync(recoveryRoot),
          false
        );
        assertApplied(value);
        assert.equal(
          fs.readFileSync(
            path.join(
              value.repositoryPath,
              "unrelated.txt"
            ),
            "utf8"
          ),
          "AD2_EXTERNAL_DRIFT\n"
        );

        fs.rmSync(
          path.join(
            value.repositoryPath,
            "unrelated.txt"
          )
        );

        const recovered =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          recovered.decision,
          "controlled_transaction_recovery_rolled_back",
          JSON.stringify(recovered)
        );
        assertBaseline(value);
        await verifyRecoveryReceipt(
          value,
          recovered.receipt
        );
      }
    );

    await check(
      "successful X5 crash recovery replay performs no second write",
      async () => {
        const {
          value
        } =
          await crashAfterValidationStarted({
            fillerFileCount: 80
          });

        const first =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          first.decision,
          "controlled_transaction_recovery_rolled_back",
          JSON.stringify(first)
        );
        assertBaseline(value);

        const recoveryDirectory =
          path.join(
            value.registryDirectoryPath,
            "recoveries",
            value.authorization
              .consumptionKey
              .slice(7)
          );
        const recoveryHashBefore =
          directoryHash(
            recoveryDirectory,
            hashCanonicalJson
          );
        const repositoryBytesBefore =
          fs.readFileSync(
            path.join(
              value.repositoryPath,
              "src/a.txt"
            )
          );

        const second =
          await executeControlledTransactionRecovery(
            recoveryInput(value)
          );

        assert.equal(
          second.decision,
          "controlled_transaction_recovery_not_required",
          JSON.stringify(second)
        );
        assert.equal(
          second.summary.recoveryAttemptCreated,
          false
        );
        assert.equal(
          second.summary.repositoryWriteAttempted,
          false
        );
        assert.equal(
          directoryHash(
            recoveryDirectory,
            hashCanonicalJson
          ),
          recoveryHashBefore
        );
        assert.deepEqual(
          fs.readFileSync(
            path.join(
              value.repositoryPath,
              "src/a.txt"
            )
          ),
          repositoryBytesBefore
        );
        assertBaseline(value);
      }
    );

    console.log(
      "cross-process X5 crash recovery suite passed (5 checks)"
    );
  } finally {
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
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
