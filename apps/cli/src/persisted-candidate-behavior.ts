import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDisposableAgentWorkspace } from "../../../packages/integrations/src/disposable-agent-workspace.js";
import {
  createCanonicalRepositoryContentSnapshot,
  evaluateTrustedBehaviorEvidence,
  hashCanonicalJson,
  parseTextFileUpdates,
  readTextUpdateSource,
  trustedBehaviorHash,
  validateUpdateSource,
  type TrustedBehaviorAssessment
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { captureCandidateSourceSnapshotHash, type BoundedCandidateHandoff } from "./candidate-handoff.js";
import type { TrustedBehaviorHost } from "./compare-host-loader.js";
import { CliError } from "./cli-errors.js";

export type PersistedBehaviorReport = TrustedBehaviorAssessment & Readonly<{
  taskId: string;
  taskHash: string;
  candidateHandoffHash: string;
  workspaceHash: string | null;
  sourceTreeHash: string | null;
  receiptHash: string | null;
}>;

function commitSha(repositoryRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 10_000
  });
  const value = String(result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40}$/.test(value)) {
    throw new CliError("cli_candidate_source_commit_unavailable", "Candidate source commit is unavailable.", 4);
  }
  return value;
}

function unknown(candidate: BoundedCandidateHandoff, taskHash: string, reason: string,
  workspaceHash: string | null, sourceTreeHash: string | null = null): PersistedBehaviorReport {
  return Object.freeze({
    taskId: candidate.taskId, taskHash, candidateHandoffHash: candidate.handoffHash,
    workspaceHash, sourceTreeHash, receiptHash: null, behaviorSatisfied: null,
    criterionCount: 0, passedCriterionCount: 0, reason
  });
}

export function unverifiedCandidateBehavior(candidate: BoundedCandidateHandoff,
  reason = "trusted_host_unavailable"): PersistedBehaviorReport {
  const taskHash = hashCanonicalJson({
    taskId: candidate.taskId, objectiveHash: candidate.objectiveHash, handoffHash: candidate.handoffHash
  });
  return unknown(candidate, taskHash, reason, null);
}

/** Both workspaces are independent copies; the source remains available after a real apply. */
export async function createPersistedBehaviorSession(repositoryRoot: string, candidate: BoundedCandidateHandoff) {
  const repositorySnapshotHash = createCanonicalRepositoryContentSnapshot(repositoryRoot).snapshotHash;
  const sourceCommitSha = commitSha(repositoryRoot);
  const taskHash = hashCanonicalJson({
    taskId: candidate.taskId, objectiveHash: candidate.objectiveHash, handoffHash: candidate.handoffHash
  });
  const workspaceInput = {
    repositoryPath: repositoryRoot, sourceSnapshotHash: repositorySnapshotHash,
    visibleFiles: [], changeAllowedFiles: [], forbiddenFiles: [], mode: "baseline" as const
  };
  const source = await createDisposableAgentWorkspace(workspaceInput);
  const sourceTreeHash = createCanonicalRepositoryContentSnapshot(source.workspacePath).snapshotHash;
  let candidateWorkspace: Awaited<ReturnType<typeof createDisposableAgentWorkspace>>;
  try {
    candidateWorkspace = await createDisposableAgentWorkspace(workspaceInput);
    for (const claim of parseTextFileUpdates(candidate.coderMutation)) {
      const original = await readTextUpdateSource(candidateWorkspace.workspacePath, claim.file);
      validateUpdateSource(claim, original.bytes);
      await writeFile(path.join(candidateWorkspace.workspacePath, ...claim.file.split("/")), claim.newContent);
    }
    if (createCanonicalRepositoryContentSnapshot(repositoryRoot).snapshotHash !== repositorySnapshotHash ||
        captureCandidateSourceSnapshotHash(source.workspacePath) !== candidate.sourceSnapshotHash) {
      throw new CliError("cli_candidate_source_drift", "Repository or disposable source changed during trusted workspace preparation.", 4);
    }
  } catch (error) {
    await rm(source.workspacePath, { recursive: true, force: true });
    if (candidateWorkspace!) await rm(candidateWorkspace.workspacePath, { recursive: true, force: true });
    throw error;
  }
  const candidateTreeHash = createCanonicalRepositoryContentSnapshot(candidateWorkspace.workspacePath).snapshotHash;

  async function assess(host: TrustedBehaviorHost, workspacePath: string,
    phase: "candidate" | "post_apply"): Promise<PersistedBehaviorReport> {
    const workspaceHash = createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash;
    if (phase === "candidate" && workspaceHash !== candidateTreeHash) {
      return unknown(candidate, taskHash, "candidate_workspace_changed", workspaceHash, sourceTreeHash);
    }
    try {
      const proof = await host({
        workspacePath, candidateTreeHash: workspaceHash,
        taskId: candidate.taskId, taskHash, sourceCommitSha, sourceTreeHash,
        sourceWorkspacePath: source.workspacePath, phase
      });
      if (createCanonicalRepositoryContentSnapshot(workspacePath).snapshotHash !== workspaceHash ||
          createCanonicalRepositoryContentSnapshot(source.workspacePath).snapshotHash !== sourceTreeHash) {
        return unknown(candidate, taskHash, "workspace_changed_during_trusted_inspection", workspaceHash, sourceTreeHash);
      }
      const assessment = evaluateTrustedBehaviorEvidence(proof.receipt, {
        ...proof.expectation, taskId: candidate.taskId, taskHash,
        sourceCommitSha, sourceTreeHash, candidateTreeHash: workspaceHash
      }, proof.hostKey);
      return Object.freeze({
        ...assessment, taskId: candidate.taskId, taskHash,
        candidateHandoffHash: candidate.handoffHash, workspaceHash, sourceTreeHash,
        receiptHash: proof.receipt ? trustedBehaviorHash(JSON.stringify(proof.receipt)) : null
      });
    } catch {
      return unknown(candidate, taskHash, "trusted_host_execution_unavailable", workspaceHash, sourceTreeHash);
    }
  }

  return Object.freeze({
    candidateTreeHash,
    verifyCandidate: (host: TrustedBehaviorHost) => assess(host, candidateWorkspace.workspacePath, "candidate"),
    verifyPostApply: (host: TrustedBehaviorHost) => assess(host, repositoryRoot, "post_apply"),
    cleanup: async () => {
      await rm(candidateWorkspace.workspacePath, { recursive: true, force: true });
      await rm(source.workspacePath, { recursive: true, force: true });
    }
  });
}
