import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildValidationEvidence,
  buildTemporaryWorkspaceExecutionVerificationEvidence,
  canonicalPolicyRepositoryIdentity,
  compileCanonicalPolicy,
  createAcceptanceCriteriaContract,
  createCanonicalRepositoryContentSnapshot,
  evaluateAcceptanceCriteria,
  hashCanonicalJson,
  mutationContentHash,
  parseTextFileUpdates,
  readTextUpdateSource,
  runContainerizedWorkspaceExecution,
  verifyPatchDraftMutationV2,
  verifyRepairDraftMutation,
  verifyValidationEvidence,
  type DurableBoundedTaskState,
  type RunBoundedTaskResult,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";
import { captureCandidateSourceSnapshotHash } from "./candidate-handoff.js";
import { BOUNDED_POLICY_PATH, type BoundedLocalConfig } from "./product-config.js";
import { BOUNDED_CODEX_VALIDATION_PROFILE, validationSpecification } from "./commands/codex.js";

export const REPAIR_MUTATION_ARTIFACT_VERSION = "bounded-repair-mutation-artifact/v1" as const;
export const DERIVED_VALIDATION_RECEIPT_VERSION = "bounded-derived-validation-receipt/v1" as const;

export type RepairMutationArtifact = Readonly<{
  schemaVersion: typeof REPAIR_MUTATION_ARTIFACT_VERSION;
  claims: readonly Readonly<{ file: string; expectedContentHash: string; newContent: string }>[];
}>;

export type DerivedCandidateValidationReceipt = Readonly<{
  receiptVersion: typeof DERIVED_VALIDATION_RECEIPT_VERSION;
  originalTaskId: string;
  originalCandidateHash: string;
  repairArtifactHash: string;
  derivedCandidateHash: string;
  repositoryIdentityHash: string;
  baselineSnapshotHash: string;
  sourceSnapshotHash: string;
  boundaryHash: string;
  verifierFindingHash: string;
  executionResultHash: string;
  validationResultHash: string;
  acceptanceResultHash: string;
  profileResultHash: string;
  decision: "validated";
  receiptHash: string;
}>;

function reject(code: string, message: string): never { throw new CliError(code, message, 4); }

export function createRepairMutationArtifact(repair: WorkspaceMutation): RepairMutationArtifact {
  return { schemaVersion: REPAIR_MUTATION_ARTIFACT_VERSION,
    claims: parseTextFileUpdates(repair).map((claim) => ({ file: claim.file,
      expectedContentHash: claim.expectedContentHash, newContent: claim.newContent })) };
}

export function parseRepairMutationArtifact(value: unknown): RepairMutationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("cli_repair_artifact_invalid", "Repair artifact is invalid.");
  const artifact = value as Record<string, unknown>;
  if (Object.keys(artifact).sort().join("\0") !== "claims\0schemaVersion" ||
      artifact.schemaVersion !== REPAIR_MUTATION_ARTIFACT_VERSION || !Array.isArray(artifact.claims) ||
      artifact.claims.length < 1 || artifact.claims.length > 32 || artifact.claims.some((claim) =>
        !claim || typeof claim !== "object" || Array.isArray(claim) ||
        Object.keys(claim).sort().join("\0") !== "expectedContentHash\0file\0newContent")) {
    return reject("cli_repair_artifact_invalid", "Repair artifact has an invalid shape.");
  }
  const parsed = artifact as RepairMutationArtifact;
  parseTextFileUpdates(repairMutationFromArtifact(parsed));
  return parsed;
}

export function repairMutationFromArtifact(artifact: RepairMutationArtifact): WorkspaceMutation {
  return { role: "remask", target: "repairDraft", summary: "Deterministic governed repair.",
    claims: artifact.claims.map((claim) => ({ claimVersion: "text-file-update/v1",
      type: "repair_draft", operation: "update", file: claim.file,
      expectedContentHash: claim.expectedContentHash, newContent: claim.newContent,
      description: "Apply the bounded repair." })),
    touchedFiles: artifact.claims.map((claim) => claim.file), confidence: 1 } as WorkspaceMutation;
}

export function deriveCandidateMutation(original: WorkspaceMutation, artifact: RepairMutationArtifact): WorkspaceMutation {
  const replacements = new Map(artifact.claims.map((claim) => [claim.file, claim]));
  const claims = parseTextFileUpdates(original).map((claim) => {
    const replacement = replacements.get(claim.file);
    return replacement === undefined ? claim : { ...claim, newContent: replacement.newContent,
      description: "Apply the bounded repair." };
  });
  return { ...original, summary: "Validated deterministic repair of persisted candidate.",
    claims, touchedFiles: [...original.touchedFiles] };
}

export function headHash(repositoryRoot: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return hashCanonicalJson({ head });
  } catch { return hashCanonicalJson({ head: null }); }
}

export function stableBaselineSnapshotHash(repositoryRoot: string): string {
  const snapshot = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  const volatile = [".bounded/runs", ".bounded/state", ".bounded/tmp", ".bounded/cache"];
  const records = snapshot.records.filter((record) => !volatile.some((prefix) =>
    record.path === prefix || record.path.startsWith(`${prefix}/`)));
  return hashCanonicalJson({ snapshotVersion: snapshot.snapshotVersion, scope: snapshot.scope,
    records, totalBytes: records.reduce((total, record) => total + record.byteLength, 0) });
}

export function originalAcceptanceContract(result: RunBoundedTaskResult, expectedHash: string) {
  const objectiveHash = result.plannerResult?.implementationContract?.objectiveHash;
  if (!objectiveHash) return reject("cli_repair_original_missing", "Original objective is missing.");
  const matches: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === "objective" && typeof item === "string" &&
          hashCanonicalJson({ objective: item }) === objectiveHash) matches.push(item);
      else visit(item, depth + 1);
    }
  };
  visit(result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.context?.baseContext, 0);
  for (const task of matches) {
    const contract = createAcceptanceCriteriaContract({ taskId: result.plannerResult!.implementationContract!.taskId,
      objectiveHash, criteria: [{ id: "requested_behavior",
        description: task.replace(/[ \t\r\n]+/g, " ").slice(0, 1000).trim(),
        required: true, evidence: { kind: "test", commandId: "validation.test" } }] });
    if (contract.contractHash === expectedHash) return contract;
  }
  return reject("cli_repair_acceptance_unavailable", "Original acceptance contract cannot be reconstructed and verified.");
}

export async function validateDerivedCandidate(input: Readonly<{
  repositoryRoot: string;
  config: BoundedLocalConfig;
  state: DurableBoundedTaskState;
  result: RunBoundedTaskResult;
  original: WorkspaceMutation;
  artifact: RepairMutationArtifact;
  generatedPolicyPaths?: readonly string[];
}>) {
  const { repositoryRoot, state, result, original } = input;
  const artifact = parseRepairMutationArtifact(input.artifact);
  const repair = repairMutationFromArtifact(artifact);
  const originalHash = hashCanonicalJson(original);
  if (originalHash !== state.mutationArtifactHash || result.decision === "bounded_task_completed" ||
      result.failure === null || canonicalPolicyRepositoryIdentity(repositoryRoot) !== state.repositoryIdentityHash ||
      headHash(repositoryRoot) !== state.baselineHeadHash ||
      stableBaselineSnapshotHash(repositoryRoot) !== state.baselineSnapshotHash) {
    return reject("cli_repair_source_stale", "Original candidate or repository source is stale.");
  }
  const originalClaims = parseTextFileUpdates(original);
  const originalFiles = originalClaims.map((claim) => claim.file).sort();
  const boundary = { originalCandidateHash: originalHash, originalCandidateFiles: originalFiles,
    policyFiles: [BOUNDED_POLICY_PATH, "bounded-agent.policy.yml"], acceptanceCriteriaFiles: [] };
  const boundaryHash = hashCanonicalJson(boundary);
  const acceptanceCriteriaContract = originalAcceptanceContract(result, state.acceptanceCriteriaContractHash);
  const policyWorkspace = await mkdtemp(path.join(os.tmpdir(), "bounded-repair-policy-"));
  let policy;
  try {
    await cp(repositoryRoot, policyWorkspace, { recursive: true, filter: (source) => {
      const relative = path.relative(repositoryRoot, source).split(path.sep).join("/");
      return relative !== ".git" && !relative.startsWith(".git/") &&
        !(input.generatedPolicyPaths ?? []).includes(relative);
    } });
    policy = compileCanonicalPolicy({ repositoryPath: policyWorkspace,
      policyFilePath: path.join(policyWorkspace, BOUNDED_POLICY_PATH) });
  } finally { await rm(policyWorkspace, { recursive: true, force: true }); }
  if (policy.compiledPolicyHash !== state.compiledPolicyHash ||
      originalFiles.some((file) => !policy.allowedPaths.includes(file) || policy.forbiddenPaths.includes(file))) {
    return reject("cli_repair_policy_stale", "Original mutable scope is no longer authorized by policy.");
  }
  const sourceBefore = captureCandidateSourceSnapshotHash(repositoryRoot);
  const fileContents: Record<string, string> = {};
  for (const claim of originalClaims) {
    const source = await readTextUpdateSource(repositoryRoot, claim.file);
    if (mutationContentHash(source.bytes) !== claim.expectedContentHash) {
      return reject("cli_repair_source_stale", `Source changed since candidate creation: ${claim.file}.`);
    }
    fileContents[claim.file] = claim.newContent;
  }
  const coder = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult;
  if (!coder?.runtimeContext) return reject("cli_repair_original_missing", "Original context evidence is missing.");
  for (const evidence of coder.runtimeContext.evidence) {
    const source = await readTextUpdateSource(repositoryRoot, evidence.path);
    if (mutationContentHash(source.bytes) !== evidence.contentHash) {
      return reject("cli_repair_source_stale", `Bound context changed: ${evidence.path}.`);
    }
  }
  const allowedFiles = artifact.claims.map((claim) => claim.file);
  if (allowedFiles.some((file) => !originalFiles.includes(file) ||
      [BOUNDED_POLICY_PATH, "bounded-agent.policy.yml"].includes(file))) {
    return reject("cli_repair_scope_invalid", "Repair artifact widens the original mutable scope.");
  }
  const preserveFiles = originalFiles.filter((file) => !allowedFiles.includes(file));
  const repairVerification = verifyRepairDraftMutation(repair, { fileContents,
    allowedFiles, forbiddenFiles: [...preserveFiles, BOUNDED_POLICY_PATH, "bounded-agent.policy.yml"] });
  if (repairVerification.decision !== "approve") {
    return reject("cli_repair_boundary_rejected", "Deterministic repair draft verifier did not approve the repair.");
  }
  const candidateB = deriveCandidateMutation(original, artifact);
  const verifier = await verifyPatchDraftMutationV2({ repositoryPath: repositoryRoot,
    mutation: candidateB, allowedFiles: originalFiles, forbiddenFiles: policy.forbiddenPaths,
    boundContextFiles: originalClaims.map((claim) => ({ path: claim.file,
      contentHash: claim.expectedContentHash })), policyHash: policy.compiledPolicyHash,
    requireExistingTouchedFiles: true });
  if (verifier.decision !== "approve" ||
      verifier.canonicalTouchedFiles.join("\0") !== originalFiles.join("\0")) {
    return reject("cli_repair_candidate_rejected", "Derived candidate failed deterministic verification.");
  }
  const specification = validationSpecification(input.config);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bounded-derived-repair-"));
  let execution;
  try {
    await cp(repositoryRoot, workspace, { recursive: true, filter: (source) => {
      const relative = path.relative(repositoryRoot, source).split(path.sep).join("/");
      return relative !== ".git" && !relative.startsWith(".git/") &&
        ![".bounded/runs", ".bounded/state", ".bounded/tmp", ".bounded/cache"].some(
          (prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
    } });
    for (const claim of parseTextFileUpdates(candidateB)) {
      await writeFile(path.join(workspace, ...claim.file.split("/")), claim.newContent, "utf8");
    }
    await mkdir(path.join(workspace, ".validation-output"), { recursive: true });
    execution = await runContainerizedWorkspaceExecution({ tempWorkspacePath: workspace,
      tempApplyDecision: "temp_apply_ready", tempWorkspaceCleanedUp: false, ...specification },
    async () => null, { runtime: "docker" });
  } finally { await rm(workspace, { recursive: true, force: true }); }
  if (!execution) return reject("cli_repair_validation_failed", "Validation did not execute.");
  const executionEvidence = buildTemporaryWorkspaceExecutionVerificationEvidence(specification, execution, true);
  const validation = buildValidationEvidence({ profile: BOUNDED_CODEX_VALIDATION_PROFILE,
    structuralPassed: true, specification, executionResult: execution, executionEvidence });
  const acceptance = evaluateAcceptanceCriteria({ contract: acceptanceCriteriaContract,
    executionSpecification: specification, executionEvidence });
  if (!verifyValidationEvidence(validation) || !validation.profileSatisfied ||
      acceptance.decision !== "contract_approved" || acceptance.receipt === null ||
      captureCandidateSourceSnapshotHash(repositoryRoot) !== sourceBefore ||
      headHash(repositoryRoot) !== state.baselineHeadHash) {
    return reject("cli_repair_validation_failed", "Derived candidate failed full profile, acceptance, or currentness validation.");
  }
  const repairArtifactHash = hashCanonicalJson(artifact);
  const derivedCandidateHash = hashCanonicalJson({ originalCandidateHash: originalHash,
    repairArtifactHash, mutation: candidateB });
  const receiptMaterial = { receiptVersion: DERIVED_VALIDATION_RECEIPT_VERSION,
    originalTaskId: state.taskId, originalCandidateHash: originalHash, repairArtifactHash,
    derivedCandidateHash, repositoryIdentityHash: state.repositoryIdentityHash,
    baselineSnapshotHash: state.baselineSnapshotHash, sourceSnapshotHash: sourceBefore,
    boundaryHash, verifierFindingHash: hashCanonicalJson(verifier.finding),
    executionResultHash: hashCanonicalJson({ commands: execution.commandResults.map((command) => ({
      id: command.id, passed: command.passed, exitCode: command.exitCode,
      signal: command.signal, timedOut: command.timedOut })),
      issues: execution.issues.map((issue) => issue.code) }),
    validationResultHash: hashCanonicalJson({ profile: validation.profile,
      validationSpecificationHash: validation.validationSpecificationHash,
      checks: validation.checks.map((check) => ({ kind: check.kind, required: check.required,
        status: check.status, commandIds: check.commandIds, reasonCodes: check.reasonCodes })),
      profileSatisfied: validation.profileSatisfied }),
    acceptanceResultHash: hashCanonicalJson({ decision: acceptance.decision,
      summary: acceptance.summary }),
    profileResultHash: hashCanonicalJson({ profile: BOUNDED_CODEX_VALIDATION_PROFILE,
      profileSatisfied: validation.profileSatisfied }), decision: "validated" as const };
  const receipt: DerivedCandidateValidationReceipt = { ...receiptMaterial,
    receiptHash: hashCanonicalJson(receiptMaterial) };
  return { candidateB, verifier, receipt, validationEvidenceHash: validation.evidenceHash,
    acceptanceCriteriaContract, specification, policy,
    sourceBefore, originalFiles };
}
