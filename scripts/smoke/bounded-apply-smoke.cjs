#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist/apps/cli/src/index.js");
const candidateModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/candidate-handoff.js")
).href;
const applyModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/apps/cli/src/commands/apply.js")
).href;
const runtimeModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
).href;

const sourceOriginal = [
  "export function refreshExpiry(now: number): number {",
  "  return now + 60;",
  "}",
  ""
].join("\n");
const sourceChanged = [
  "export function refreshExpiry(now: number): number {",
  "  return now + 120;",
  "}",
  ""
].join("\n");
const unrelatedOriginal = "export const sessionName = \"primary\";\n";
const unrelatedChanged = "export const sessionName = \"changed-by-developer\";\n";

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hash(char) {
  return `sha256:${char.repeat(64)}`;
}

function runCli(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...extraEnv }
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepository(root) {
  const repository = path.join(root, "fixture-apply");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  git(repository, ["init", "-q"]);
  await writeJson(path.join(repository, "package.json"), {
    name: "fixture-apply",
    scripts: {
      test: "node --test",
      build: "node --check src/session.js",
      typecheck: "node -e \"process.exit(0)\""
    }
  });
  await fs.writeFile(path.join(repository, "src/session.ts"), sourceOriginal, "utf8");
  await fs.writeFile(path.join(repository, "src/unrelated.ts"), unrelatedOriginal, "utf8");
  const init = runCli(repository, ["init", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  return repository;
}

function mutation() {
  return {
    role: "coder",
    target: "patchDraft",
    summary: "Fix refresh token expiry.",
    claims: [{
      claimVersion: "text-file-update/v1",
      type: "patch_draft",
      operation: "update",
      file: "src/session.ts",
      expectedContentHash: sha256(sourceOriginal),
      newContent: sourceChanged,
      description: "Use the corrected refresh token expiry window."
    }],
    touchedFiles: ["src/session.ts"]
  };
}

function verifierFinding() {
  return {
    role: "verifier",
    target: "verifierFinding",
    summary: "Deterministic verifier approved the candidate.",
    claims: [],
    touchedFiles: ["src/session.ts"]
  };
}

function validationSpecification() {
  return {
    commands: [{
      id: "validation.test",
      checkKind: "behavior_test",
      executable: "node",
      args: ["--test"],
      timeoutMs: 30_000,
      expectedExitCodes: [0]
    }],
    allowedExecutables: ["node"],
    maxCommands: 1,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 30_000,
    maxOutputChars: 20_000,
    environment: { CI: "1" }
  };
}

async function buildCandidate(repository, candidateModule, runtime) {
  const objectiveHash = runtime.hashCanonicalJson({ objective: "Fix refresh token expiry" });
  const taskId = "codex.fixture.apply";
  const acceptanceCriteriaContract = runtime.createAcceptanceCriteriaContract({
    taskId,
    objectiveHash,
    criteria: [{
      id: "requested_behavior",
      description: "Refresh token expiry is corrected.",
      required: true,
      evidence: { kind: "test", commandId: "validation.test" }
    }]
  });
  return candidateModule.createCandidateHandoff({
    taskId,
    objectiveHash,
    sourceSnapshotHash: candidateModule.captureCandidateSourceSnapshotHash(repository),
    planHash: hash("a"),
    contextBindingHash: hash("b"),
    plannerExecutionBindingHash: hash("c"),
    compiledPolicyHash: hash("d"),
    allowedFiles: ["src/session.ts"],
    forbiddenFiles: [],
    acceptanceCriteriaContract,
    validationProfile: "existing_function_bug_fix",
    phaseVExecutionSpecification: validationSpecification(),
    coderMutation: mutation(),
    verifierFinding: verifierFinding(),
    adaptiveResult: { decision: "fixture-adaptive-result" },
    declaredRiskClass: "low",
    candidateFiles: ["src/session.ts"]
  });
}

function successfulGovernedResult() {
  return {
    integratedResult: {
      decision: "integrated_disposable_apply_finalized",
      route: "contract_approved",
      issues: [],
      receipt: { receiptHash: hash("e") },
      applyResult: { receipt: { outcome: "applied", receiptHash: hash("f") } },
      postApplyValidation: { finalReceipt: { outcome: "validated", receiptHash: hash("1") } },
      summary: {
        applyCallCount: 1,
        repositoryFinalState: "validated_applied_state"
      }
    }
  };
}

async function main() {
  const originalCi = process.env.CI;
  delete process.env.CI;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-apply-smoke-"));
  try {
    const repository = await createRepository(root);
    const candidateModule = await import(candidateModuleUrl);
    const applyModule = await import(applyModuleUrl);
    const runtime = await import(runtimeModuleUrl);
    let candidate = await buildCandidate(repository, candidateModule, runtime);
    await candidateModule.writeCandidateHandoff(repository, candidate);

    assert.equal(
      candidateModule.captureCandidateSourceSnapshotHash(repository),
      candidate.sourceSnapshotHash,
      ".bounded/state persistence must not make its own candidate source snapshot stale"
    );
    const roundTrip = await candidateModule.readCandidateHandoff(repository);
    assert.equal(roundTrip.handoffHash, candidate.handoffHash);
    const diff = await candidateModule.renderCandidateDiff(repository, candidate);
    assert.match(diff, /diff --git a\/src\/session\.ts b\/src\/session\.ts/);
    assert.match(diff, /-  return now \+ 60;/);
    assert.match(diff, /\+  return now \+ 120;/);

    let executeCalls = 0;
    const nonInteractive = await applyModule.applyCommand(
      { nonInteractive: true },
      repository,
      {
        approve: async () => {
          throw new Error("approval callback must not run in non-interactive mode");
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("controlled executor must not run without approval");
        },
        runtimeRoot: path.join(root, "runtime-noninteractive")
      }
    );
    assert.equal(nonInteractive.exitCode, 3);
    assert.equal(nonInteractive.output.decision, "approval_required");
    assert.equal(nonInteractive.output.mutationStarted, false);
    assert.equal(executeCalls, 0);

    const cliNonInteractive = runCli(repository, ["apply", "--json"]);
    assert.equal(cliNonInteractive.status, 3, cliNonInteractive.stderr || cliNonInteractive.stdout);
    assert.equal(JSON.parse(cliNonInteractive.stdout).decision, "approval_required");

    const declined = await applyModule.applyCommand(
      {},
      repository,
      {
        approve: async (_candidate, shownDiff) => {
          assert.equal(shownDiff, diff);
          return false;
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("controlled executor must not run after decline");
        },
        runtimeRoot: path.join(root, "runtime-declined")
      }
    );
    assert.equal(declined.exitCode, 0);
    assert.equal(declined.output.decision, "approval_declined");
    assert.equal(declined.output.mutationStarted, false);
    assert.equal(executeCalls, 0);

    await fs.writeFile(path.join(repository, "src/session.ts"), "// developer edit\n", "utf8");
    let approvalCalls = 0;
    const directTargetDrift = await applyModule.applyCommand(
      {},
      repository,
      {
        approve: async () => {
          approvalCalls += 1;
          return true;
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("controlled executor must not run on target drift");
        },
        runtimeRoot: path.join(root, "runtime-target-drift")
      }
    );
    assert.equal(directTargetDrift.exitCode, 4);
    assert.equal(directTargetDrift.output.decision, "recovery_required");
    assert.equal(directTargetDrift.output.mutationStarted, false);
    assert.equal(approvalCalls, 0, "target drift must be caught while rendering candidate diff");
    assert.equal(executeCalls, 0);
    assert.equal(await fs.readFile(path.join(repository, "src/session.ts"), "utf8"), "// developer edit\n");

    await fs.writeFile(path.join(repository, "src/session.ts"), sourceOriginal, "utf8");
    candidate = await buildCandidate(repository, candidateModule, runtime);
    await candidateModule.writeCandidateHandoff(repository, candidate);
    const betweenDiffAndApproval = await applyModule.applyCommand(
      {},
      repository,
      {
        approve: async (_candidate, shownDiff) => {
          assert.match(shownDiff, /return now \+ 120/);
          await fs.writeFile(path.join(repository, "src/unrelated.ts"), unrelatedChanged, "utf8");
          return true;
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("controlled executor must not run after post-diff source drift");
        },
        runtimeRoot: path.join(root, "runtime-post-diff-drift")
      }
    );
    assert.equal(betweenDiffAndApproval.exitCode, 4);
    assert.equal(betweenDiffAndApproval.output.decision, "recovery_required");
    assert.equal(betweenDiffAndApproval.output.mutationStarted, false);
    assert.equal(executeCalls, 0);
    assert.equal(
      await fs.readFile(path.join(repository, "src/unrelated.ts"), "utf8"),
      unrelatedChanged,
      "developer edit must be preserved rather than overwritten"
    );

    await fs.writeFile(path.join(repository, "src/unrelated.ts"), unrelatedOriginal, "utf8");
    candidate = await buildCandidate(repository, candidateModule, runtime);
    await candidateModule.writeCandidateHandoff(repository, candidate);
    const runtimeRoot = path.join(root, "controlled-runtime");
    const success = await applyModule.applyCommand(
      {},
      repository,
      {
        approve: async (_candidate, shownDiff) => {
          assert.match(shownDiff, /Candidate|diff --git/);
          return true;
        },
        execute: async (input) => {
          executeCalls += 1;
          assert.equal(input.repositoryPath, repository);
          assert.equal(input.taskId, candidate.taskId);
          assert.deepEqual(input.allowedFiles, ["src/session.ts"]);
          assert.equal(input.configuration.phaseVExecutionSpecification.commands[0].id, "validation.test");
          for (const directory of [
            input.configuration.registryDirectoryPath,
            input.configuration.rollbackBundleParentPath,
            input.configuration.validationWorkspaceParentPath
          ]) {
            const relative = path.relative(repository, directory);
            assert.equal(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), false,
              "controlled runtime state/rollback/validation directories must be outside the repository");
          }
          return successfulGovernedResult();
        },
        runtimeRoot
      }
    );
    assert.equal(success.exitCode, 0, JSON.stringify(success.output));
    assert.equal(success.output.ok, true);
    assert.equal(success.output.apply, "APPLIED");
    assert.equal(success.output.postApplyValidation, "PASS");
    assert.equal(success.output.receiptHash, hash("e"));
    assert.equal(success.output.controlledApplyReceiptHash, hash("f"));
    assert.equal(success.output.postApplyReceiptHash, hash("1"));
    assert.equal(executeCalls, 1);

    const unexpectedFailure = await applyModule.applyCommand(
      {},
      repository,
      {
        approve: async () => true,
        execute: async () => {
          throw new Error("simulated crash after controlled execution starts");
        },
        runtimeRoot: path.join(root, "runtime-crash")
      }
    );
    assert.equal(unexpectedFailure.exitCode, 4);
    assert.equal(unexpectedFailure.output.decision, "recovery_required");
    assert.equal(unexpectedFailure.output.mutationStarted, true);

    const applySource = await fs.readFile(
      path.join(repoRoot, "apps", "cli", "src", "commands", "apply.ts"),
      "utf8"
    );
    assert.match(applySource, /executeCanonicalGovernedMutation/);
    assert.match(applySource, /Apply to working tree\? \[y\/N\]/);
    assert.doesNotMatch(applySource, /\bwriteFile\b|\.writeFile\(/,
      "apply command must not implement real repository file writes");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      candidateHandoffVersion: "bounded-candidate-handoff/v1",
      applyVersion: "bounded-apply/v1",
      validatedCandidatePersisted: true,
      diffShownBeforeApproval: true,
      defaultAnswerNo: true,
      nonInteractiveApplyStarted: false,
      declinedApplyStarted: false,
      targetDriftApplyStarted: false,
      postDiffDriftApplyStarted: false,
      developerDriftPreserved: true,
      sourceSnapshotRecheckedAfterApproval: true,
      canonicalControlledExecutorWired: true,
      customRealRepositoryWriterAdded: false,
      controlledRuntimeDirectoriesOutsideRepository: true,
      receiptReported: true,
      unexpectedPostStartFailureRequiresRecovery: true,
      realControlledApplyCallsInSmoke: false
    }, null, 2)}\n`);
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
