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
import {
  HUMAN_DECISION_REASONS,
  HUMAN_DECISIONS,
  isHumanDecision,
  isHumanDecisionReason,
  recordHumanDecision,
  type BoundedHumanDecisionRecord,
  type HumanDecisionSelection
} from "../human-decision.js";
import { doctorBoundedLocalConfig } from "../product-config.js";

export const BOUNDED_APPLY_COMMAND_VERSION = "bounded-apply/v1" as const;

export type ApplyCommandInput = Readonly<{
  nonInteractive?: boolean;
}>;

export type ApplyCommandDependencies = Readonly<{
  decide?: (candidate: BoundedCandidateHandoff, diff: string) => Promise<HumanDecisionSelection>;
  approve?: (candidate: BoundedCandidateHandoff, diff: string) => Promise<boolean>;
  execute?: typeof executeCanonicalGovernedMutation;
  runtimeRoot?: string;
}>;

function ciMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.CI?.trim().toLocaleLowerCase("en-US");
  return value === "1" || value === "true" || value === "yes";
}

async function promptHumanDecision(
  _candidate: BoundedCandidateHandoff,
  diff: string
): Promise<HumanDecisionSelection> {
  process.stdout.write("Candidate diff:\n\n");
  process.stdout.write(diff);
  if (!diff.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n");
  if (!process.stdin.isTTY) {
    process.stdout.write(`Decision [${HUMAN_DECISIONS.join("/")}]: reject\n`);
    return { decision: "reject", reason: null };
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let decision: HumanDecisionSelection["decision"];
    while (true) {
      const answer = (await readline.question(`Decision [${HUMAN_DECISIONS.join("/")}]: `))
        .trim().toLocaleLowerCase("en-US");
      // Legacy safety contract: "Apply to working tree? [y/N]" defaulted to no.
      if (answer === "") {
        decision = "reject";
        break;
      }
      if (isHumanDecision(answer)) {
        decision = answer;
        break;
      }
      process.stdout.write("Choose accept, reject, or needs_manual_edit.\n");
    }
    while (true) {
      const answer = (await readline.question(
        `Reason (optional: ${HUMAN_DECISION_REASONS.join("/")}): `
      )).trim().toLocaleLowerCase("en-US");
      if (answer === "") return { decision, reason: null };
      if (isHumanDecisionReason(answer)) return { decision, reason: answer };
      process.stdout.write("Choose one of the listed reasons or leave blank.\n");
    }
  } finally {
    readline.close();
  }
}

async function resolveHumanDecision(
  candidate: BoundedCandidateHandoff,
  diff: string,
  dependencies: ApplyCommandDependencies
): Promise<HumanDecisionSelection> {
  if (dependencies.decide) return dependencies.decide(candidate, diff);
  if (dependencies.approve) {
    return (await dependencies.approve(candidate, diff))
      ? { decision: "accept", reason: null }
      : { decision: "reject", reason: null };
  }
  return promptHumanDecision(candidate, diff);
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

function humanDecisionOutput(record?: BoundedHumanDecisionRecord) {
  if (!record) return {};
  return {
    humanDecision: {
      schemaVersion: record.schemaVersion,
      decision: record.decision,
      reason: record.reason,
      recordedAt: record.recordedAt,
      decisionHash: record.decisionHash
    }
  };
}

function stoppedOutput(
  candidate: BoundedCandidateHandoff,
  decision: "approval_required" | "approval_declined" | "recovery_required",
  message?: string,
  humanDecision?: BoundedHumanDecisionRecord
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
      ...humanDecisionOutput(humanDecision),
      ...(message ? { failure: { code: "candidate_source_drift", message } } : {})
    },
    exitCode: decision === "approval_declined" ? 0 : decision === "recovery_required" ? 4 : 3
  };
}

function completedOutput(
  candidate: BoundedCandidateHandoff,
  governed: CanonicalGovernedExecutionResult,
  humanDecision: BoundedHumanDecisionRecord
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
        ...humanDecisionOutput(humanDecision),
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
      postApplyReceiptHash: integrated.postApplyValidation!.finalReceipt!.receiptHash,
      ...humanDecisionOutput(humanDecision)
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

  const selection = await resolveHumanDecision(candidate, diff, dependencies);
  const humanDecision = await recordHumanDecision(repositoryRoot, candidate, selection);
  if (humanDecision.decision !== "accept") {
    return stoppedOutput(candidate, "approval_declined", undefined, humanDecision);
  }

  const currentSnapshotHash = captureCandidateSourceSnapshotHash(repositoryRoot);
  if (currentSnapshotHash !== candidate.sourceSnapshotHash) {
    return stoppedOutput(
      candidate,
      "recovery_required",
      "Repository source snapshot changed after candidate validation; candidate was not applied.",
      humanDecision
    );
  }

  const configuration = await runtimeConfiguration(repositoryRoot, candidate, dependencies.runtimeRoot);
  try {
    const governed = await (dependencies.execute ?? executeCanonicalGovernedMutation)(
      candidateToGovernedInput(repositoryRoot, candidate, configuration)
    );
    return completedOutput(candidate, governed, humanDecision);
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
          mutationStarted: true,
          apply: "NOT_COMPLETED",
          receiptHash: null,
          ...humanDecisionOutput(humanDecision),
          failure: { code: error.code, message: error.message }
        },
        exitCode: error.route === "recovery_required" ? 4 : 3
      };
    }
    return {
      output: {
        ok: false,
        command: "apply",
        applyVersion: BOUNDED_APPLY_COMMAND_VERSION,
        taskId: candidate.taskId,
        candidateHandoffHash: candidate.handoffHash,
        candidateFiles: candidate.candidateFiles,
        decision: "recovery_required",
        route: "recovery_required",
        mutationStarted: true,
        apply: "NOT_COMPLETED",
        receiptHash: null,
        ...humanDecisionOutput(humanDecision),
        failure: {
          code: "controlled_apply_unexpected_failure",
          message: error instanceof Error ? error.message : "Controlled apply failed after execution began."
        }
      },
      exitCode: 4
    };
  }
}
