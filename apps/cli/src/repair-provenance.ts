import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPolicyRepositoryIdentity,
  hashCanonicalJson,
  parseTextFileUpdates,
  readDurableBoundedTaskArtifact,
  readDurableBoundedTaskState,
  type RunBoundedTaskResult,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";
import { captureCandidateSourceSnapshotHash, type BoundedCandidateHandoff } from "./candidate-handoff.js";
import { codexDurableTaskLocator } from "./run-artifact-store.js";
import type { BoundedLocalConfig } from "./product-config.js";
import {
  deriveCandidateMutation,
  parseRepairMutationArtifact,
  stableBaselineSnapshotHash,
  validateDerivedCandidate,
  type DerivedCandidateValidationReceipt,
  type RepairMutationArtifact
} from "./derived-candidate-validation.js";

export const DERIVED_REPAIR_VERSION = "bounded-derived-repair/v3" as const;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export type DerivedRepairRecord = Readonly<{
  schemaVersion: typeof DERIVED_REPAIR_VERSION;
  originalTaskId: string;
  originalCandidateHash: string;
  validationFailureHash: string;
  repairArtifactHash: string;
  repairMutationArtifactHash: string;
  repairMutationArtifactRawHash: string;
  repairMutationArtifactBytes: number;
  derivedCandidateHash: string;
  boundaryHash: string;
  validationReceipt: DerivedCandidateValidationReceipt;
  sourceSnapshotHash: string;
  repositoryIdentityHash: string;
  baselineSnapshotHash: string;
}>;

function fail(): never {
  throw new CliError("cli_repair_provenance_invalid", "Derived repair provenance is missing, stale, or invalid.", 4);
}

export function artifactBytes(artifact: RepairMutationArtifact): Buffer {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function rawBytesHash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function derivedRepairRecordBytes(record: DerivedRepairRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export const derivedRepairRecordHash = rawBytesHash;

function originalMutation(result: RunBoundedTaskResult): WorkspaceMutation {
  const mutation = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput;
  if (!mutation) return fail();
  parseTextFileUpdates(mutation);
  return mutation;
}

async function readBoundArtifact(directory: string, name: string, expectedBytes: number,
  expectedRawHash: string, maxBytes: number): Promise<Buffer> {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return fail();
  const file = path.join(directory, `${name.slice(7)}.json`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || stat.size !== expectedBytes) return fail();
  const bytes = await readFile(file);
  if (bytes.length !== expectedBytes || rawBytesHash(bytes) !== expectedRawHash) return fail();
  return bytes;
}

/** Full validation before approval; after approval rehash all inputs and bind to the in-memory receipt. */
export async function verifyCandidateProvenance(repositoryRoot: string,
  candidate: BoundedCandidateHandoff, config: BoundedLocalConfig,
  approvedReceiptHash?: string): Promise<string | null> {
  const provenance = candidate.provenance;
  if (!provenance || provenance.kind === "bounded_run") {
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
    return null;
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
    const recordBytes = await readBoundArtifact(path.join(repositoryRoot, ".bounded", "state", "derived-repairs"),
      provenance.derivedCandidateHash, provenance.derivedRepairRecordBytes,
      provenance.derivedRepairRecordHash, MAX_RECORD_BYTES);
    const record = JSON.parse(recordBytes.toString("utf8")) as DerivedRepairRecord;
    const fields = ["schemaVersion", "originalTaskId", "originalCandidateHash", "validationFailureHash",
      "repairArtifactHash", "repairMutationArtifactHash", "repairMutationArtifactRawHash",
      "repairMutationArtifactBytes", "derivedCandidateHash", "boundaryHash", "validationReceipt",
      "sourceSnapshotHash", "repositoryIdentityHash", "baselineSnapshotHash"];
    if (Object.keys(record).sort().join("\0") !== fields.sort().join("\0") ||
        record.schemaVersion !== DERIVED_REPAIR_VERSION ||
        record.originalTaskId !== provenance.originalTaskId ||
        record.originalCandidateHash !== provenance.originalCandidateHash ||
        record.validationFailureHash !== provenance.validationFailureHash ||
        record.repairArtifactHash !== provenance.repairArtifactHash ||
        record.repairMutationArtifactHash !== provenance.repairArtifactHash ||
        record.derivedCandidateHash !== provenance.derivedCandidateHash ||
        record.repositoryIdentityHash !== provenance.repositoryIdentityHash ||
        record.baselineSnapshotHash !== provenance.baselineSnapshotHash ||
        record.sourceSnapshotHash !== candidate.sourceSnapshotHash) return fail();
    const mutationBytes = await readBoundArtifact(path.join(repositoryRoot, ".bounded", "state", "repair-mutations"),
      record.repairMutationArtifactHash, record.repairMutationArtifactBytes,
      record.repairMutationArtifactRawHash, MAX_ARTIFACT_BYTES);
    const artifact = parseRepairMutationArtifact(JSON.parse(mutationBytes.toString("utf8")));
    if (hashCanonicalJson(artifact) !== record.repairArtifactHash) return fail();
    const candidateB = deriveCandidateMutation(original, artifact);
    if (hashCanonicalJson(candidateB) !== hashCanonicalJson(candidate.coderMutation) ||
        hashCanonicalJson({ originalCandidateHash: provenance.originalCandidateHash,
          repairArtifactHash: record.repairArtifactHash, mutation: candidate.coderMutation }) !==
          provenance.derivedCandidateHash) return fail();
    const adaptive = candidate.adaptiveResult as { coderResult?: { providerOutput?: unknown } } | null;
    if (hashCanonicalJson(adaptive?.coderResult?.providerOutput ?? null) !==
        hashCanonicalJson(candidate.coderMutation)) return fail();
    if (!record.validationReceipt || record.validationReceipt.receiptHash !==
        hashCanonicalJson(Object.fromEntries(Object.entries(record.validationReceipt).filter(([key]) =>
          key !== "receiptHash"))) ||
        record.validationReceipt.originalTaskId !== candidate.taskId ||
        record.validationReceipt.derivedCandidateHash !== provenance.derivedCandidateHash ||
        record.validationReceipt.repairArtifactHash !== provenance.repairArtifactHash ||
        record.validationReceipt.boundaryHash !== record.boundaryHash) return fail();
    if (approvedReceiptHash !== undefined) {
      if (record.validationReceipt.receiptHash !== approvedReceiptHash) return fail();
      return approvedReceiptHash;
    }
    const fresh = await validateDerivedCandidate({ repositoryRoot, config, state, result, original, artifact,
      generatedPolicyPaths: [
        `.bounded/state/derived-repairs/${provenance.derivedCandidateHash.slice(7)}.json`,
        `.bounded/state/repair-mutations/${record.repairMutationArtifactHash.slice(7)}.json`,
        ".bounded/state/candidate-handoff.json",
        `.bounded/state/human-decisions/${candidate.handoffHash.slice(7)}.json`
      ] });
    if (fresh.receipt.receiptHash !== record.validationReceipt.receiptHash ||
        hashCanonicalJson(fresh.receipt) !== hashCanonicalJson(record.validationReceipt) ||
        fresh.receipt.derivedCandidateHash !== provenance.derivedCandidateHash ||
        fresh.receipt.boundaryHash !== record.boundaryHash ||
        hashCanonicalJson(fresh.verifier.finding) !== hashCanonicalJson(candidate.verifierFinding)) return fail();
    return fresh.receipt.receiptHash;
  } catch (error) { if (process.env.BOUNDED_DEBUG_REPAIR === "1") console.error(error); return fail(); }
}
