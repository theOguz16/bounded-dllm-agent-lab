import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildValidationEvidence,
  buildTemporaryWorkspaceExecutionVerificationEvidence,
  BoundedTaskStateError,
  canonicalPolicyRepositoryIdentity,
  compileCanonicalPolicy,
  createAcceptanceCriteriaContract,
  createCanonicalRepositoryContentSnapshot,
  evaluateAcceptanceCriteria,
  hashCanonicalJson,
  mutationContentHash,
  parseTargetedRepairRequest,
  parseTextFileUpdates,
  readDurableBoundedTaskArtifact,
  readDurableBoundedTaskState,
  readTextUpdateSource,
  runContainerizedWorkspaceExecution,
  verifyPatchDraftMutationV2,
  verifyRepairDraftMutation,
  verifyValidationEvidence,
  type RunBoundedTaskResult,
  type TargetedRepairBoundary,
  type WorkspaceMutation
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "../cli-errors.js";
import type { CliCommandResult } from "../bounded-task.js";
import {
  captureCandidateSourceSnapshotHash,
  createCandidateHandoff,
  readCandidateHandoff,
  writeCandidateHandoff
} from "../candidate-handoff.js";
import { doctorBoundedLocalConfig, BOUNDED_POLICY_PATH } from "../product-config.js";
import { codexDurableTaskLocator } from "../run-artifact-store.js";
import { BOUNDED_CODEX_VALIDATION_PROFILE, validationSpecification } from "./codex.js";

export const DERIVED_REPAIR_VERSION = "bounded-derived-repair/v1" as const;
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

function headHash(repositoryRoot: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return hashCanonicalJson({ head });
  } catch { return hashCanonicalJson({ head: null }); }
}

function stableBaselineSnapshotHash(repositoryRoot: string): string {
  const snapshot = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  const volatile = [".bounded/runs", ".bounded/state", ".bounded/tmp", ".bounded/cache"];
  const records = snapshot.records.filter((record) => !volatile.some((prefix) =>
    record.path === prefix || record.path.startsWith(`${prefix}/`)));
  return hashCanonicalJson({ snapshotVersion: snapshot.snapshotVersion, scope: snapshot.scope,
    records, totalBytes: records.reduce((total, record) => total + record.byteLength, 0) });
}

function coderMutation(result: RunBoundedTaskResult): WorkspaceMutation {
  const mutation = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput;
  if (!mutation) return reject("cli_repair_original_missing", "Terminal task has no persisted coder candidate.");
  parseTextFileUpdates(mutation);
  return mutation;
}

function derivedMutation(original: WorkspaceMutation, repair: WorkspaceMutation): WorkspaceMutation {
  const replacements = new Map(parseTextFileUpdates(repair).map((claim) => [claim.file, claim]));
  const claims = parseTextFileUpdates(original).map((claim) => {
    const replacement = replacements.get(claim.file);
    return replacement === undefined ? claim : {
      ...claim, newContent: replacement.newContent,
      description: replacement.description
    };
  });
  return { ...original, summary: "Validated deterministic repair of persisted candidate.",
    claims, touchedFiles: [...original.touchedFiles] };
}

function updatedAdaptiveResult(result: RunBoundedTaskResult, mutation: WorkspaceMutation): unknown {
  const adaptive = result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult;
  if (!adaptive?.coderResult) return reject("cli_repair_original_missing", "Original adaptive result is missing.");
  return { ...adaptive, coderResult: { ...adaptive.coderResult, providerOutput: mutation } };
}

function originalAcceptanceContract(result: RunBoundedTaskResult, expectedHash: string) {
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
  if (canonicalPolicyRepositoryIdentity(repositoryRoot) !== state.repositoryIdentityHash ||
      headHash(repositoryRoot) !== state.baselineHeadHash ||
      stableBaselineSnapshotHash(repositoryRoot) !== state.baselineSnapshotHash) {
    return reject("cli_repair_source_stale", "Source repository identity or HEAD changed since the original run.");
  }
  const policy = compileCanonicalPolicy({ repositoryPath: repositoryRoot,
    policyFilePath: path.join(repositoryRoot, BOUNDED_POLICY_PATH) });
  if (policy.compiledPolicyHash !== state.compiledPolicyHash ||
      originalFiles.some((file) => !policy.allowedPaths.includes(file) || policy.forbiddenPaths.includes(file))) {
    return reject("cli_repair_policy_stale", "Original mutable scope is no longer authorized by policy.");
  }
  const sourceBefore = captureCandidateSourceSnapshotHash(repositoryRoot);
  const originalByFile = new Map(originalClaims.map((claim) => [claim.file, claim]));
  const fileContents: Record<string, string> = {};
  for (const claim of originalClaims) {
    const source = await readTextUpdateSource(repositoryRoot, claim.file);
    if (mutationContentHash(source.bytes) !== claim.expectedContentHash) {
      return reject("cli_repair_source_stale", `Source changed since candidate creation: ${claim.file}.`);
    }
    fileContents[claim.file] = claim.newContent;
  }
  for (const evidence of coder.runtimeContext.evidence) {
    const source = await readTextUpdateSource(repositoryRoot, evidence.path);
    if (mutationContentHash(source.bytes) !== evidence.contentHash) {
      return reject("cli_repair_source_stale", `Bound context changed: ${evidence.path}.`);
    }
  }
  for (const claim of repairClaims) {
    if (!originalByFile.has(claim.file)) return reject("cli_repair_scope_invalid", "Repair adds a candidate file.");
  }
  const repairVerification = verifyRepairDraftMutation(repair, {
    fileContents, allowedFiles: [...request.allowedFiles], forbiddenFiles: [...request.preserveFiles,
      BOUNDED_POLICY_PATH, "bounded-agent.policy.yml"]
  });
  if (repairVerification.decision !== "approve") {
    return reject("cli_repair_boundary_rejected", "Deterministic repair draft verifier did not approve the repair.");
  }
  const candidateB = derivedMutation(original, repair);
  const boundContextFiles = originalClaims.map((claim) => ({ path: claim.file,
    contentHash: claim.expectedContentHash }));
  const verifier = await verifyPatchDraftMutationV2({ repositoryPath: repositoryRoot,
    mutation: candidateB, allowedFiles: originalFiles, forbiddenFiles: policy.forbiddenPaths,
    boundContextFiles, policyHash: policy.compiledPolicyHash, requireExistingTouchedFiles: true });
  if (verifier.decision !== "approve" ||
      verifier.canonicalTouchedFiles.join("\0") !== originalFiles.join("\0")) {
    throw new CliError("cli_repair_candidate_rejected", "Derived candidate failed deterministic verification.", 4,
      { verifierIssues: verifier.issues.map((issue) => issue.ruleId) });
  }
  const specification = validationSpecification(diagnosed.config);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bounded-derived-repair-"));
  let execution;
  try {
    await cp(repositoryRoot, workspace, { recursive: true,
      filter: (source) => {
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
    throw new CliError("cli_repair_validation_failed",
      "Derived candidate did not pass full profile, acceptance, or source currentness validation.", 4,
      { checks: validation.checks.map((check) => ({ kind: check.kind, status: check.status })),
        acceptance: acceptance.decision, executionIssues: execution.issues.map((issue) => ({ code: issue.code,
          message: issue.message })) });
  }
  const risk = plan.riskClass;
  if (!["low", "medium", "high", "critical"].includes(String(risk))) {
    return reject("cli_repair_handoff_invalid", "Original plan risk class is invalid.");
  }
  const repairArtifactHash = hashCanonicalJson({ request, mutation: repair });
  const derivedCandidateHash = hashCanonicalJson({ originalCandidateHash: originalHash,
    repairArtifactHash, mutation: candidateB });
  const candidate = createCandidateHandoff({ taskId: state.taskId,
    objectiveHash: acceptanceCriteriaContract.objectiveHash,
    sourceSnapshotHash: sourceBefore, planHash: plan.planHash,
    contextBindingHash: hashCanonicalJson(coder.context),
    plannerExecutionBindingHash: planner.executionBinding.bindingHash,
    compiledPolicyHash: policy.compiledPolicyHash,
    allowedFiles: originalFiles, forbiddenFiles: policy.forbiddenPaths,
    acceptanceCriteriaContract,
    validationProfile: BOUNDED_CODEX_VALIDATION_PROFILE,
    phaseVExecutionSpecification: specification, coderMutation: candidateB,
    verifierFinding: verifier.finding, adaptiveResult: updatedAdaptiveResult(result, candidateB),
    declaredRiskClass: risk as "low" | "medium" | "high" | "critical",
    candidateFiles: originalFiles });
  try {
    const existing = await readCandidateHandoff(repositoryRoot);
    if (existing.handoffHash !== candidate.handoffHash) {
      return reject("cli_repair_handoff_binding_mismatch", "A different candidate handoff already exists.");
    }
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "cli_candidate_handoff_missing") throw error;
  }
  const record = { schemaVersion: DERIVED_REPAIR_VERSION, originalTaskId: state.taskId,
    originalCandidateHash: originalHash, validationFailureHash: state.terminalResultHash,
    repairArtifactHash, derivedCandidateHash, boundaryHash: hashCanonicalJson(boundary),
    validationEvidenceHash: validation.evidenceHash, verifierFindingHash: hashCanonicalJson(verifier.finding),
    acceptanceReceiptHash: acceptance.receipt.receiptHash,
    handoffHash: candidate.handoffHash, sourceSnapshotHash: sourceBefore };
  const stateDirectory = path.join(repositoryRoot, ".bounded", "state");
  const stateStat = await lstat(stateDirectory).catch(() => null);
  if (stateStat && (!stateStat.isDirectory() || stateStat.isSymbolicLink())) {
    return reject("cli_repair_state_unsafe", "Candidate state directory is unsafe.");
  }
  const directory = path.join(stateDirectory, "derived-repairs");
  const directoryStat = await lstat(directory).catch(() => null);
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) {
    return reject("cli_repair_state_unsafe", "Derived repair directory is unsafe.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${derivedCandidateHash.slice(7)}.json`),
    `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeCandidateHandoff(repositoryRoot, candidate);
  return { output: { ok: true, command: "repair", taskId: state.taskId,
    originalCandidateHash: originalHash, repairArtifactHash, derivedCandidateHash,
    validationEvidenceHash: validation.evidenceHash, candidateHandoffHash: candidate.handoffHash,
    decision: "bounded_task_completed", apply: "NOT_RUN", providerCalls: 0 }, exitCode: 0 };
}
