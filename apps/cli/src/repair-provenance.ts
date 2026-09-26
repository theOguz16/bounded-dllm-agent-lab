import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPolicyRepositoryIdentity,
  createCanonicalRepositoryContentSnapshot,
  hashCanonicalJson,
  parseTargetedRepairRequest,
  parseTextFileUpdates,
  readDurableBoundedTaskArtifact,
  readDurableBoundedTaskState,
  verifyRepairDraftMutation,
  type RunBoundedTaskResult,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";
import { captureCandidateSourceSnapshotHash, type BoundedCandidateHandoff } from "./candidate-handoff.js";
import { codexDurableTaskLocator } from "./run-artifact-store.js";

export const DERIVED_REPAIR_VERSION = "bounded-derived-repair/v2" as const;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export type DerivedRepairRecord = Readonly<{
  schemaVersion: typeof DERIVED_REPAIR_VERSION;
  originalTaskId: string;
  originalCandidateHash: string;
  validationFailureHash: string;
  repairArtifactHash: string;
  derivedCandidateHash: string;
  boundaryHash: string;
  validationEvidenceHash: string;
  verifierFindingHash: string;
  acceptanceReceiptHash: string;
  sourceSnapshotHash: string;
  repositoryIdentityHash: string;
  baselineSnapshotHash: string;
  request: unknown;
  mutation: WorkspaceMutation;
}>;

function fail(): never {
  throw new CliError("cli_repair_provenance_invalid", "Derived repair provenance is missing, stale, or invalid.", 4);
}

export function stableBaselineSnapshotHash(repositoryRoot: string): string {
  const snapshot = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  const volatile = [".bounded/runs", ".bounded/state", ".bounded/tmp", ".bounded/cache"];
  const records = snapshot.records.filter((record) => !volatile.some((prefix) =>
    record.path === prefix || record.path.startsWith(`${prefix}/`)));
  return hashCanonicalJson({ snapshotVersion: snapshot.snapshotVersion, scope: snapshot.scope,
    records, totalBytes: records.reduce((total, record) => total + record.byteLength, 0) });
}

export function deriveCandidateMutation(original: WorkspaceMutation, repair: WorkspaceMutation): WorkspaceMutation {
  const replacements = new Map(parseTextFileUpdates(repair).map((claim) => [claim.file, claim]));
  const claims = parseTextFileUpdates(original).map((claim) => {
    const replacement = replacements.get(claim.file);
    return replacement === undefined ? claim : {
      ...claim, newContent: replacement.newContent, description: replacement.description
    };
  });
  return { ...original, summary: "Validated deterministic repair of persisted candidate.",
    claims, touchedFiles: [...original.touchedFiles] };
}

export function derivedRepairRecordBytes(record: DerivedRepairRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function derivedRepairRecordHash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function originalMutation(result: RunBoundedTaskResult): WorkspaceMutation {
  const mutation = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput;
  if (!mutation) return fail();
  parseTextFileUpdates(mutation);
  return mutation;
}

/** Runs before approval and again immediately before governed execution. */
export async function verifyCandidateProvenance(repositoryRoot: string,
  candidate: BoundedCandidateHandoff): Promise<void> {
  const provenance = candidate.provenance;
  if (!provenance || provenance.kind === "bounded_run") {
    // A historical v1 handoff has no discriminator. Accept it only for a canonical successful run.
    // New normal handoffs receive the same check, so a failed repair cannot be relabeled normal.
    try {
      const locator = codexDurableTaskLocator(repositoryRoot, candidate.taskId);
      const state = readDurableBoundedTaskState(locator);
      if (state.currentState !== "finalized" || !state.terminalResultReference ||
          state.terminalResultHash !== state.terminalResultReference.contentHash ||
          state.mutationArtifactHash !== hashCanonicalJson(candidate.coderMutation)) return fail();
      const result = readDurableBoundedTaskArtifact<RunBoundedTaskResult>(locator, state,
        state.terminalResultReference);
      if (result.decision !== "bounded_task_completed") return fail();
    } catch { return fail(); }
    return;
  }
  try {
    if (provenance.originalTaskId !== candidate.taskId ||
        provenance.repositoryIdentityHash !== canonicalPolicyRepositoryIdentity(repositoryRoot) ||
        captureCandidateSourceSnapshotHash(repositoryRoot) !== candidate.sourceSnapshotHash) return fail();
    const locator = codexDurableTaskLocator(repositoryRoot, candidate.taskId);
    const state = readDurableBoundedTaskState(locator);
    if (!["human_review_required", "replan_required", "failed"].includes(state.currentState) ||
        !state.terminalResultReference || state.terminalResultHash !== provenance.validationFailureHash ||
        state.terminalResultReference.contentHash !== state.terminalResultHash ||
        state.mutationArtifactHash !== provenance.originalCandidateHash ||
        state.repositoryIdentityHash !== provenance.repositoryIdentityHash ||
        state.baselineSnapshotHash !== provenance.baselineSnapshotHash ||
        stableBaselineSnapshotHash(repositoryRoot) !== state.baselineSnapshotHash) return fail();
    const result = readDurableBoundedTaskArtifact<RunBoundedTaskResult>(locator, state,
      state.terminalResultReference);
    if (result.decision === "bounded_task_completed" || result.failure === null) return fail();
    const original = originalMutation(result);
    if (hashCanonicalJson(original) !== provenance.originalCandidateHash) return fail();
    const directory = path.join(repositoryRoot, ".bounded", "state", "derived-repairs");
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return fail();
    const file = path.join(directory, `${provenance.derivedCandidateHash.slice(7)}.json`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES ||
        stat.size !== provenance.derivedRepairRecordBytes) return fail();
    const bytes = await readFile(file);
    if (bytes.length !== provenance.derivedRepairRecordBytes ||
        derivedRepairRecordHash(bytes) !== provenance.derivedRepairRecordHash) return fail();
    const record = JSON.parse(bytes.toString("utf8")) as DerivedRepairRecord;
    const fields = ["schemaVersion", "originalTaskId", "originalCandidateHash", "validationFailureHash",
      "repairArtifactHash", "derivedCandidateHash", "boundaryHash", "validationEvidenceHash",
      "verifierFindingHash", "acceptanceReceiptHash", "sourceSnapshotHash", "repositoryIdentityHash",
      "baselineSnapshotHash", "request", "mutation"];
    if (Object.keys(record).sort().join("\0") !== fields.sort().join("\0") ||
        record.schemaVersion !== DERIVED_REPAIR_VERSION ||
        record.originalTaskId !== provenance.originalTaskId ||
        record.originalCandidateHash !== provenance.originalCandidateHash ||
        record.validationFailureHash !== provenance.validationFailureHash ||
        record.repairArtifactHash !== provenance.repairArtifactHash ||
        record.derivedCandidateHash !== provenance.derivedCandidateHash ||
        record.repositoryIdentityHash !== provenance.repositoryIdentityHash ||
        record.baselineSnapshotHash !== provenance.baselineSnapshotHash ||
        record.sourceSnapshotHash !== candidate.sourceSnapshotHash ||
        hashCanonicalJson({ request: record.request, mutation: record.mutation }) !== record.repairArtifactHash) return fail();
    const originalFiles = parseTextFileUpdates(original).map((claim) => claim.file).sort();
    const boundary = { originalCandidateHash: provenance.originalCandidateHash,
      originalCandidateFiles: originalFiles,
      policyFiles: [".bounded/policy.yml", "bounded-agent.policy.yml"], acceptanceCriteriaFiles: [] };
    if (hashCanonicalJson(boundary) !== record.boundaryHash) return fail();
    const request = parseTargetedRepairRequest(record.request, boundary);
    const fileContents = Object.fromEntries(parseTextFileUpdates(original).map((claim) =>
      [claim.file, claim.newContent]));
    if (verifyRepairDraftMutation(record.mutation, { fileContents,
      allowedFiles: [...request.allowedFiles], forbiddenFiles: [...request.preserveFiles,
        ".bounded/policy.yml", "bounded-agent.policy.yml"] }).decision !== "approve") return fail();
    const derived = deriveCandidateMutation(original, record.mutation);
    if (hashCanonicalJson(derived) !== hashCanonicalJson(candidate.coderMutation) ||
        hashCanonicalJson({ originalCandidateHash: provenance.originalCandidateHash,
          repairArtifactHash: record.repairArtifactHash, mutation: candidate.coderMutation }) !==
          provenance.derivedCandidateHash) return fail();
    const adaptive = candidate.adaptiveResult as { coderResult?: { providerOutput?: unknown } } | null;
    if (hashCanonicalJson(adaptive?.coderResult?.providerOutput ?? null) !==
        hashCanonicalJson(candidate.coderMutation)) return fail();
  } catch { return fail(); }
}
