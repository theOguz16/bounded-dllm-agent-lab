import {
  hashCanonicalJson,
  type DurableBoundedTaskState,
  type RunBoundedTaskResult,
  type TargetedRepairRequest
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import type { RepairMutationArtifact } from "./derived-candidate-validation.js";
import { CliError } from "./cli-errors.js";

export const REPAIR_REQUEST_BINDING_VERSION = "bounded-repair-request-binding/v1" as const;
const HASH = /^sha256:[0-9a-f]{64}$/;

export type RepairRequestBinding = Readonly<{
  version: typeof REPAIR_REQUEST_BINDING_VERSION;
  originalTaskId: string;
  originalCandidateHash: string;
  failureEvidenceHash: string;
  repairBoundaryHash: string;
  targetFileSetHash: string;
  repositoryIdentityHash: string;
  sourceSnapshotHash: string;
  repairArtifactHash: string;
  matchedFailedCheckHash: string | null;
  verifierIssueHashes: readonly string[];
  bindingHash: string;
}>;

function failedChecks(result: RunBoundedTaskResult): Set<string> {
  const checks = new Set<string>();
  if (result.failure) checks.add(result.failure.code);
  for (const check of result.verifierResult?.validationEvidence.checks ?? []) {
    if (check.status === "passed") continue;
    checks.add(check.kind);
    for (const id of check.commandIds) checks.add(id);
    for (const reason of check.reasonCodes) checks.add(reason);
  }
  return checks;
}

function issueHash(issue: { code: string; message: string; file?: string }): string {
  return hashCanonicalJson({ code: issue.code, message: issue.message, file: issue.file ?? null });
}

function originalIssueHashes(result: RunBoundedTaskResult): Set<string> {
  return new Set((result.verifierResult?.issues ?? []).map((issue) =>
    issueHash({ code: issue.ruleId, message: issue.message, file: issue.file })));
}

export function failureEvidenceHash(result: RunBoundedTaskResult): string {
  return hashCanonicalJson({ failure: result.failure,
    validationEvidence: result.verifierResult?.validationEvidence ?? null,
    issues: result.verifierResult?.issues ?? [] });
}

export function repairTargetFileSetHash(artifact: RepairMutationArtifact): string {
  return hashCanonicalJson([...artifact.claims.map((claim) => claim.file)].sort());
}

export function createRepairRequestBinding(input: Readonly<{
  request: TargetedRepairRequest;
  state: DurableBoundedTaskState;
  result: RunBoundedTaskResult;
  boundaryHash: string;
  artifact: RepairMutationArtifact;
}>): RepairRequestBinding {
  const { request, state, result, boundaryHash, artifact } = input;
  const availableChecks = failedChecks(result);
  const selected = request.failingChecks.find((check) => availableChecks.has(check)) ?? null;
  if (request.failingChecks.length > 0 && selected === null) {
    throw new CliError("cli_repair_failure_binding_invalid",
      "Repair request does not identify persisted failure evidence.", 4);
  }
  const verifierIssueHashes = request.verifierIssues.map(issueHash).sort();
  const availableIssues = originalIssueHashes(result);
  if (verifierIssueHashes.some((hash) => !availableIssues.has(hash)) ||
      selected === null && verifierIssueHashes.length === 0 ||
      repairTargetFileSetHash(artifact) !== hashCanonicalJson([...request.allowedFiles].sort())) {
    throw new CliError("cli_repair_request_binding_invalid",
      "Repair request does not match persisted failure or target evidence.", 4);
  }
  const material = { version: REPAIR_REQUEST_BINDING_VERSION,
    originalTaskId: state.taskId, originalCandidateHash: state.mutationArtifactHash!,
    failureEvidenceHash: failureEvidenceHash(result), repairBoundaryHash: boundaryHash,
    targetFileSetHash: repairTargetFileSetHash(artifact),
    repositoryIdentityHash: state.repositoryIdentityHash,
    sourceSnapshotHash: state.baselineSnapshotHash,
    repairArtifactHash: hashCanonicalJson(artifact),
    matchedFailedCheckHash: selected === null ? null : hashCanonicalJson({ check: selected }),
    verifierIssueHashes };
  return { ...material, bindingHash: hashCanonicalJson(material) };
}

export function verifyRepairRequestBinding(binding: RepairRequestBinding, input: Readonly<{
  state: DurableBoundedTaskState;
  result: RunBoundedTaskResult;
  boundaryHash: string;
  artifact: RepairMutationArtifact;
}>): boolean {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const fields = ["version", "originalTaskId", "originalCandidateHash", "failureEvidenceHash",
    "repairBoundaryHash", "targetFileSetHash", "repositoryIdentityHash", "sourceSnapshotHash",
    "repairArtifactHash", "matchedFailedCheckHash", "verifierIssueHashes", "bindingHash"];
  if (Object.keys(binding).sort().join("\0") !== fields.sort().join("\0") ||
      binding.version !== REPAIR_REQUEST_BINDING_VERSION ||
      binding.originalTaskId !== input.state.taskId ||
      binding.originalCandidateHash !== input.state.mutationArtifactHash ||
      binding.failureEvidenceHash !== failureEvidenceHash(input.result) ||
      binding.repairBoundaryHash !== input.boundaryHash ||
      binding.targetFileSetHash !== repairTargetFileSetHash(input.artifact) ||
      binding.repositoryIdentityHash !== input.state.repositoryIdentityHash ||
      binding.sourceSnapshotHash !== input.state.baselineSnapshotHash ||
      binding.repairArtifactHash !== hashCanonicalJson(input.artifact) ||
      !Array.isArray(binding.verifierIssueHashes) ||
      binding.verifierIssueHashes.length > 128 ||
      binding.verifierIssueHashes.some((hash) => !HASH.test(hash)) ||
      binding.verifierIssueHashes.join("\0") !== [...binding.verifierIssueHashes].sort().join("\0")) return false;
  const availableCheckHashes = new Set([...failedChecks(input.result)].map((check) =>
    hashCanonicalJson({ check })));
  const availableIssues = originalIssueHashes(input.result);
  if (binding.matchedFailedCheckHash !== null &&
      (!HASH.test(binding.matchedFailedCheckHash) ||
        !availableCheckHashes.has(binding.matchedFailedCheckHash)) ||
      binding.verifierIssueHashes.some((hash) => !availableIssues.has(hash)) ||
      binding.matchedFailedCheckHash === null && binding.verifierIssueHashes.length === 0) return false;
  const { bindingHash, ...material } = binding;
  return bindingHash === hashCanonicalJson(material);
}
