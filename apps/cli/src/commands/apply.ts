import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  CanonicalGovernedExecutionError,
  executeCanonicalGovernedMutation,
  type CanonicalGovernedExecutionResult
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type { CliCommandResult } from "../bounded-task.js";
import { CliError } from "../cli-errors.js";
import {
  candidateToGovernedInput,
  captureCandidateSourceSnapshotHash,
  readCandidateHandoff,
  renderCandidateDiff,
  type BoundedCandidateHandoff
} from "../candidate-handoff.js";
import { doctorBoundedLocalConfig } from "../product-config.js";

export const BOUNDED_APPLY_COMMAND_VERSION = "bounded-apply/v1" as const;

export type ApplyCommandInput = Readonly<{
  nonInteractive?: boolean;
}>;

export type ApplyCommandDependencies = Readonly<{
  approve?: (candidate: BoundedCandidateHandoff, diff: string) => Promise<boolean>;
  execute?: typeof executeCanonicalGovernedMutation;
  runtimeRoot?: string;
}>;

function ciMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.CI?.trim().toLocaleLowerCase("en-US");
  return value === "1" || value === "true" || value === "yes";
}

async function promptApproval(_candidate: BoundedCandidateHandoff, diff: string): Promise<boolean> {
  process.stdout.write("Candidate diff:\n\n");
  process.stdout.write(diff);
  if (!diff.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n");
  if (!process.stdin.isTTY) {
    process.stdout.write("Apply to working tree? [y/N] n\n");
    return false;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("Apply to working tree? [y/N] "))
      .trim().toLocaleLowerCase("en-US");
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function runtimeDirectory(repositoryRoot: string, override?: string): string {
  if (override) return path.resolve(override);
  const key = createHash("sha256").update(repositoryRoot, "utf8").digest("hex").slice(0, 32);
  return path.join(os.homedir(), ".bounded", "runtime", key);
}

async function runtimeConfiguration(
  repositoryRoot: string,
  candidate: BoundedCandidateHandoff,
  override?: string
) {
  const root = runtimeDirectory(repositoryRoot, override);
  const registryDirectoryPath = path.join(root, "registry");
  const rollbackBundleParentPath = path.join(root, "rollback");
  const validationWorkspaceParentPath = path.join(root, "validation");
  await Promise.all([
    mkdir(registryDirectoryPath, { recursive: true, mode: 0o700 }),
    mkdir(rollbackBundleParentPath, { recursive: true, mode: 0o700 }),
    mkdir(validationWorkspaceParentPath, { recursive: true, mode: 0o700 })
  ]);
  return {
    registryDirectoryPath,
    rollbackBundleParentPath,
    validationWorkspaceParentPath,
    phaseVExecutionSpecification: candidate.phaseVExecutionSpecification
  };
}

function stoppedOutput(
  candidate: BoundedCandidateHandoff,
  decision: "approval_required" | "approval_declined" | "recovery_required",
  message?: string
): CliCommandResult {
  return {
    output: {
      ok: decision === "approval_declined",
      command: "apply",
      applyVersion: BOUNDED_APPLY_COMMAND_VERSION,
      taskId: candidate.taskId,
      candidateHandoffHash: candidate.handoffHash,
      candidateFiles: candidate.candidateFiles,
      decision,
      route: decision === "recovery_required" ? "recovery_required" : "human_approval_required",
      mutationStarted: false,
      apply: "NOT_RUN",
      receiptHash: null,
      ...(message ? { failure: { code: "candidate_source_drift", message } } : {})
    },
    exitCode: decision === "approval_declined" ? 0 : decision === "recovery_required" ? 4 : 3
  };
}

function completedOutput(
  candidate: BoundedCandidateHandoff,
  governed: CanonicalGovernedExecutionResult
): CliCommandResult {
  const integrated = governed.integratedResult;
  const completed = integrated.decision === "integrated_disposable_apply_finalized" &&
    integrated.route === "contract_approved" &&
    integrated.receipt !== null &&
    integrated.applyResult?.receipt?.outcome === "applied" &&
    integrated.postApplyValidation?.finalReceipt?.outcome === "validated" &&
    integrated.summary.repositoryFinalState === "validated_applied_state";
  if (!completed) {
    return {
      output: {
        ok: false,
        command: "apply",
        applyVersion: BOUNDED_APPLY_COMMAND_VERSION,
        taskId: candidate.taskId,
        candidateHandoffHash: candidate.handoffHash,
        candidateFiles: candidate.candidateFiles,
        decision: integrated.decision,
        route: integrated.route,
        mutationStarted: integrated.summary.applyCallCount > 0,
        apply: integrated.applyResult?.receipt?.outcome ?? "NOT_COMPLETED",
        postApplyValidation: integrated.postApplyValidation?.finalReceipt?.outcome ?? "NOT_COMPLETED",
        receiptHash: null,
        failure: integrated.issues[0] ?? null
      },
      exitCode: integrated.route === "recovery_required" ? 4 : 3
    };
  }
  return {
    output: {
      ok: true,
      command: "apply",
      applyVersion: BOUNDED_APPLY_COMMAND_VERSION,
      taskId: candidate.taskId,
      candidateHandoffHash: candidate.handoffHash,
      candidateFiles: candidate.candidateFiles,
      decision: integrated.decision,
      route: integrated.route,
      mutationStarted: true,
      apply: "APPLIED",
      postApplyValidation: "PASS",
      receiptHash: integrated.receipt!.receiptHash,
      controlledApplyReceiptHash: integrated.applyResult!.receipt!.receiptHash,
      postApplyReceiptHash: integrated.postApplyValidation!.finalReceipt!.receiptHash
    },
    exitCode: 0
  };
}

export async function applyCommand(
  input: ApplyCommandInput = {},
  startPath = process.cwd(),
  dependencies: ApplyCommandDependencies = {}
): Promise<CliCommandResult> {
  const diagnosed = await doctorBoundedLocalConfig(startPath);
  const repositoryRoot = diagnosed.repositoryRoot;
  const candidate = await readCandidateHandoff(repositoryRoot);

  let diff: string;
  try {
    diff = await renderCandidateDiff(repositoryRoot, candidate);
  } catch (error) {
    if (error instanceof CliError && error.code === "cli_candidate_source_drift") {
      return stoppedOutput(candidate, "recovery_required", error.message);
    }
    throw error;
  }

  if (input.nonInteractive === true || ciMode()) {
    return stoppedOutput(candidate, "approval_required");
  }

  const approved = await (dependencies.approve ?? promptApproval)(candidate, diff);
  if (!approved) return stoppedOutput(candidate, "approval_declined");

  const currentSnapshotHash = captureCandidateSourceSnapshotHash(repositoryRoot);
  if (currentSnapshotHash !== candidate.sourceSnapshotHash) {
    return stoppedOutput(
      candidate,
      "recovery_required",
      "Repository source snapshot changed after candidate validation; candidate was not applied."
    );
  }

  const configuration = await runtimeConfiguration(repositoryRoot, candidate, dependencies.runtimeRoot);
  try {
    const governed = await (dependencies.execute ?? executeCanonicalGovernedMutation)(
      candidateToGovernedInput(repositoryRoot, candidate, configuration)
    );
    return completedOutput(candidate, governed);
  } catch (error) {
    if (error instanceof CanonicalGovernedExecutionError) {
      return {
        output: {
          ok: false,
          command: "apply",
          applyVersion: BOUNDED_APPLY_COMMAND_VERSION,
          taskId: candidate.taskId,
          candidateHandoffHash: candidate.handoffHash,
          candidateFiles: candidate.candidateFiles,
          decision: error.route === "recovery_required" ? "recovery_required" : "safe_stop",
          route: error.route,
          mutationStarted: error.route === "recovery_required",
          apply: "NOT_COMPLETED",
          receiptHash: null,
          failure: { code: error.code, message: error.message }
        },
        exitCode: error.route === "recovery_required" ? 4 : 3
      };
    }
    throw error;
  }
}
