import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BoundedTaskStateError,
  hashCanonicalJson,
  parseTargetedRepairRequest,
  parseTextFileUpdates,
  readDurableBoundedTaskArtifact,
  readDurableBoundedTaskState,
  type RunBoundedTaskResult,
  type TargetedRepairBoundary,
  type WorkspaceMutation
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "../cli-errors.js";
import type { CliCommandResult } from "../bounded-task.js";
import { createCandidateHandoff, readCandidateHandoff, writeCandidateHandoff } from "../candidate-handoff.js";
import { doctorBoundedLocalConfig, BOUNDED_POLICY_PATH } from "../product-config.js";
import { codexDurableTaskLocator } from "../run-artifact-store.js";
import { createRepairMutationArtifact, originalAcceptanceContract,
  validateDerivedCandidate } from "../derived-candidate-validation.js";
import { createRepairRequestBinding } from "../repair-request-binding.js";
import { inheritedCandidateAuthorityHash, projectInheritedHandoffAuthority } from "../inherited-candidate-authority.js";
import { DERIVED_REPAIR_VERSION, artifactBytes, derivedRepairRecordBytes,
  derivedRepairRecordHash, rawBytesHash, type DerivedRepairRecord } from "../repair-provenance.js";
import { BOUNDED_CODEX_VALIDATION_PROFILE, validationSpecification } from "./codex.js";

export { DERIVED_REPAIR_VERSION } from "../repair-provenance.js";
const HASH = /^sha256:[0-9a-f]{64}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type RepairImport = Readonly<{
  schemaVersion: "bounded-repair-import/v1";
  taskId: string;
  originalCandidateHash: string;
  sourceSnapshotHash: string;
  validationFailureHash: string;
  boundaryHash: string;
  request: unknown;
  mutation: WorkspaceMutation;
}>;

function reject(code: string, message: string): never {
  throw new CliError(code, message, 4);
}

function parseImport(value: unknown): RepairImport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return reject("cli_repair_draft_invalid", "Repair draft must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const fields = ["schemaVersion", "taskId", "originalCandidateHash", "sourceSnapshotHash",
    "validationFailureHash", "boundaryHash", "request", "mutation"];
  if (Object.keys(record).sort().join("\0") !== fields.sort().join("\0") ||
      record.schemaVersion !== "bounded-repair-import/v1" ||
      typeof record.taskId !== "string" || !TASK.test(record.taskId) ||
      [record.originalCandidateHash, record.sourceSnapshotHash,
        record.validationFailureHash, record.boundaryHash].some((item) =>
        typeof item !== "string" || !HASH.test(item))) {
    return reject("cli_repair_draft_invalid", "Repair draft identity or shape is invalid.");
  }
  return record as RepairImport;
}

function coderMutation(result: RunBoundedTaskResult): WorkspaceMutation {
  // The hash-bound terminal result is Candidate A authority. The separate
  // validated-mutation artifact is auxiliary evidence, never an input here.
  const mutation = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput;
  if (!mutation) return reject("cli_repair_original_missing", "Terminal task has no persisted coder candidate.");
  parseTextFileUpdates(mutation);
  return mutation;
}

function updatedAdaptiveResult(result: RunBoundedTaskResult, mutation: WorkspaceMutation): unknown {
  const adaptive = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult;
  if (!adaptive?.coderResult) return reject("cli_repair_original_missing", "Original adaptive result is missing.");
  return { ...adaptive, coderResult: { ...adaptive.coderResult, providerOutput: mutation } };
}

export async function repairCommand(input: Readonly<{ taskId: string; repairDraftFile: string }>,
  startPath = process.cwd()): Promise<CliCommandResult> {
  if (!TASK.test(input.taskId) || !path.isAbsolute(input.repairDraftFile)) {
    return reject("cli_repair_argument_invalid", "Repair requires a persisted task ID and absolute JSON path.");
  }
  const diagnosed = await doctorBoundedLocalConfig(startPath);
  const repositoryRoot = diagnosed.repositoryRoot;
  const locator = codexDurableTaskLocator(repositoryRoot, input.taskId);
  let state;
  try { state = readDurableBoundedTaskState(locator); }
  catch (error) {
    if (error instanceof BoundedTaskStateError && error.code === "bounded_task_state_missing") {
      return reject("cli_repair_original_missing", "Persisted terminal task does not exist.");
    }
    throw error;
  }
  if (state.taskId !== input.taskId || !["human_review_required", "replan_required", "failed"].includes(state.currentState) ||
      !state.terminalResultReference || !state.terminalResultHash || !state.mutationArtifactHash) {
    return reject("cli_repair_original_missing", "Task has no eligible persisted terminal candidate.");
  }
  const result = readDurableBoundedTaskArtifact<RunBoundedTaskResult>(locator, state, state.terminalResultReference);
  const original = coderMutation(result);
  const originalHash = hashCanonicalJson(original);
  if (originalHash !== state.mutationArtifactHash ||
      state.terminalResultReference.contentHash !== state.terminalResultHash ||
      result.decision === "bounded_task_completed" || result.failure === null) {
    return reject("cli_repair_original_binding_invalid", "Terminal failure and candidate binding do not match.");
  }
  const planner = result.plannerResult;
  const plan = planner?.minimalityResult?.plan;
  const coder = planner?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult;
  if (!planner?.executionBinding || !plan || !coder?.context || !coder.runtimeContext) {
    return reject("cli_repair_original_missing", "Original candidate lacks canonical planner or context evidence.");
  }
  const originalClaims = parseTextFileUpdates(original);
  const originalFiles = originalClaims.map((claim) => claim.file).sort();
  const boundary: TargetedRepairBoundary = {
    originalCandidateHash: originalHash, originalCandidateFiles: originalFiles,
    policyFiles: [BOUNDED_POLICY_PATH, "bounded-agent.policy.yml"], acceptanceCriteriaFiles: []
  };
  const acceptanceCriteriaContract = originalAcceptanceContract(result, state.acceptanceCriteriaContractHash);
  const stat = await lstat(input.repairDraftFile).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    return reject("cli_repair_draft_invalid", "Repair draft file is missing, unsafe, or too large.");
  }
  let document: RepairImport;
  try { document = parseImport(JSON.parse(await readFile(input.repairDraftFile, "utf8"))); }
  catch (error) {
    if (error instanceof CliError) throw error;
    return reject("cli_repair_draft_invalid", "Repair draft is malformed JSON.");
  }
  if (document.taskId !== state.taskId || document.originalCandidateHash !== originalHash ||
      document.sourceSnapshotHash !== state.baselineSnapshotHash ||
      document.validationFailureHash !== state.terminalResultHash ||
      document.boundaryHash !== hashCanonicalJson(boundary)) {
    return reject("cli_repair_binding_mismatch", "Repair draft does not match canonical task, candidate, failure, or boundary.");
  }
  const request = parseTargetedRepairRequest(document.request, boundary);
  const failedChecks = new Set<string>([result.failure.code]);
  for (const check of result.verifierResult?.validationEvidence.checks ?? []) {
    if (check.status !== "passed") {
      failedChecks.add(check.kind);
      for (const commandId of check.commandIds) failedChecks.add(commandId);
      for (const reason of check.reasonCodes) failedChecks.add(reason);
    }
  }
  if (request.failingChecks.length > 0 &&
      !request.failingChecks.some((check) => failedChecks.has(check))) {
    return reject("cli_repair_failure_binding_invalid", "Repair request does not identify persisted validation failure evidence.");
  }
  const originalIssues = result.verifierResult?.issues ?? [];
  if (request.verifierIssues.some((issue) => !originalIssues.some((originalIssue) =>
    originalIssue.ruleId === issue.code && originalIssue.message === issue.message &&
      originalIssue.file === issue.file))) {
    return reject("cli_repair_failure_binding_invalid", "Repair request verifier issues differ from persisted evidence.");
  }
  const repair = document.mutation;
  const repairClaims = parseTextFileUpdates(repair);
  if (repairClaims.some((claim) => !request.allowedFiles.includes(claim.file)) ||
      request.allowedFiles.some((file) => !repairClaims.some((claim) => claim.file === file))) {
    return reject("cli_repair_scope_invalid", "Repair mutation does not match the targeted mutable scope.");
  }
  const artifact = createRepairMutationArtifact(repair);
  const requestBinding = createRepairRequestBinding({ request, state, result,
    boundaryHash: hashCanonicalJson(boundary), artifact });
  const specification = validationSpecification(diagnosed.config);
  const validated = await validateDerivedCandidate({ repositoryRoot, specification,
    validationProfile: BOUNDED_CODEX_VALIDATION_PROFILE, requestBinding,
    state, result, original, artifact });
  const { candidateB, verifier, receipt, policy, sourceBefore,
    originalFiles: validatedFiles, inheritedAuthority } = validated;
  if (validatedFiles.join("\0") !== originalFiles.join("\0") ||
      receipt.boundaryHash !== hashCanonicalJson(boundary) ||
      request.allowedFiles.some((file) => !artifact.claims.some((claim) => claim.file === file))) {
    return reject("cli_repair_lineage_invalid", "Derived repair boundary is inconsistent.");
  }
  const risk = inheritedAuthority.declaredRiskClass;
  if (!["low", "medium", "high", "critical"].includes(String(risk))) {
    return reject("cli_repair_handoff_invalid", "Original plan risk class is invalid.");
  }
  const repairArtifactHash = receipt.repairArtifactHash;
  const derivedCandidateHash = receipt.derivedCandidateHash;
  const mutationBytes = artifactBytes(artifact);
  const record: DerivedRepairRecord = { schemaVersion: DERIVED_REPAIR_VERSION,
    originalTaskId: state.taskId, originalCandidateHash: originalHash,
    validationFailureHash: state.terminalResultHash, repairArtifactHash, derivedCandidateHash,
    repairMutationArtifactHash: repairArtifactHash,
    repairMutationArtifactRawHash: rawBytesHash(mutationBytes),
    repairMutationArtifactBytes: mutationBytes.length,
    boundaryHash: receipt.boundaryHash,
    inheritedCandidateAuthorityHash: receipt.inheritedCandidateAuthorityHash,
    requestBinding, validationReceipt: receipt,
    sourceSnapshotHash: sourceBefore, repositoryIdentityHash: state.repositoryIdentityHash,
    baselineSnapshotHash: state.baselineSnapshotHash };
  const recordBytes = derivedRepairRecordBytes(record);
  const recordHash = derivedRepairRecordHash(recordBytes);
  if (mutationBytes.length > 5 * 1024 * 1024 || recordBytes.length > 16 * 1024 * 1024 ||
      hashCanonicalJson({ originalCandidateHash: originalHash, repairArtifactHash,
        mutation: candidateB }) !== derivedCandidateHash) {
    return reject("cli_repair_lineage_invalid", "Derived candidate lineage is inconsistent.");
  }
  const candidate = createCandidateHandoff({ taskId: state.taskId,
    objectiveHash: inheritedAuthority.objectiveHash,
    sourceSnapshotHash: inheritedAuthority.sourceSnapshotHash,
    planHash: inheritedAuthority.planHash,
    contextBindingHash: inheritedAuthority.contextBindingHash,
    plannerExecutionBindingHash: inheritedAuthority.plannerExecutionBindingHash,
    compiledPolicyHash: inheritedAuthority.compiledPolicyHash,
    allowedFiles: originalFiles, forbiddenFiles: policy.forbiddenPaths,
    acceptanceCriteriaContract,
    validationProfile: BOUNDED_CODEX_VALIDATION_PROFILE,
    phaseVExecutionSpecification: specification, coderMutation: candidateB,
    verifierFinding: verifier.finding, adaptiveResult: updatedAdaptiveResult(result, candidateB),
    declaredRiskClass: risk as "low" | "medium" | "high" | "critical",
    candidateFiles: originalFiles,
    provenance: { kind: "derived_repair", originalTaskId: state.taskId,
      originalCandidateHash: originalHash, repairArtifactHash, derivedCandidateHash,
      derivedRepairRecordHash: recordHash, derivedRepairRecordBytes: recordBytes.length,
      validationFailureHash: state.terminalResultHash,
      repositoryIdentityHash: state.repositoryIdentityHash,
      baselineSnapshotHash: state.baselineSnapshotHash,
      inheritedCandidateAuthorityHash: receipt.inheritedCandidateAuthorityHash } });
  if (inheritedCandidateAuthorityHash(projectInheritedHandoffAuthority(candidate)) !==
      receipt.inheritedCandidateAuthorityHash) {
    return reject("cli_repair_inherited_authority_invalid", "Derived handoff changed inherited Candidate A authority.");
  }
  try {
    const existing = await readCandidateHandoff(repositoryRoot);
    if (existing.handoffHash !== candidate.handoffHash) {
      return reject("cli_repair_handoff_binding_mismatch", "A different candidate handoff already exists.");
    }
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "cli_candidate_handoff_missing") throw error;
  }
  const stateDirectory = path.join(repositoryRoot, ".bounded", "state");
  const stateStat = await lstat(stateDirectory).catch(() => null);
  if (stateStat && (!stateStat.isDirectory() || stateStat.isSymbolicLink())) {
    return reject("cli_repair_state_unsafe", "Candidate state directory is unsafe.");
  }
  const directory = path.join(stateDirectory, "derived-repairs");
  const mutationDirectory = path.join(stateDirectory, "repair-mutations");
  const directoryStat = await lstat(directory).catch(() => null);
  const mutationDirectoryStat = await lstat(mutationDirectory).catch(() => null);
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) ||
      mutationDirectoryStat && (!mutationDirectoryStat.isDirectory() || mutationDirectoryStat.isSymbolicLink())) {
    return reject("cli_repair_state_unsafe", "Derived repair directory is unsafe.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(mutationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(mutationDirectory, `${repairArtifactHash.slice(7)}.json`),
    mutationBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, `${derivedCandidateHash.slice(7)}.json`),
    recordBytes, { flag: "wx", mode: 0o600 });
  await writeCandidateHandoff(repositoryRoot, candidate);
  return { output: { ok: true, command: "repair", taskId: state.taskId,
    originalCandidateHash: originalHash, repairArtifactHash, derivedCandidateHash,
    validationEvidenceHash: validated.validationEvidenceHash,
    validationReceiptHash: receipt.receiptHash, candidateHandoffHash: candidate.handoffHash,
    decision: "bounded_task_completed", apply: "NOT_RUN", providerCalls: 0 }, exitCode: 0 };
}
