import { createTaskProviderDeadline, TaskProviderInterruption, type TaskProviderControl } from "./task-provider-deadline.js";
export type { TaskProviderControl } from "./task-provider-deadline.js";
import { validateModelWorkspaceMutationValue } from "./model-mutation-validator.js";
import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  runPlannerMinimalityBoundCoderFlow,
  type PlannerMinimalityBoundCoderFlowResult,
  type RunPlannerMinimalityBoundCoderFlowInput
} from "./planner-minimality-integration.js";
import {
  verifyPatchDraftMutationV2,
  type DeterministicVerifierV2Result
} from "./deterministic-verifier-v2.js";
import {
  canonicalizeRepositoryRelativePath,
  createRuntimeFailure,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeFailure,
  type RuntimeStage
} from "./runtime-contract-foundation.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";
import {
  CanonicalGovernedExecutionError,
  executeCanonicalGovernedMutation,
  verifyCanonicalNoChangeAcceptance,
  type CanonicalGovernedExecutionConfiguration
} from "./canonical-governed-execution-adapter.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BoundedTaskStateError,
  BoundedTaskStateSession,
  type DurableBoundedTaskConfiguration
} from "./bounded-task-state-machine.js";
import { executeControlledTransactionRecovery } from "./controlled-transaction-recovery.js";
import { executeControlledPostApplyValidation } from "./controlled-post-apply-validation.js";
import {
  CanonicalPolicyError,
  compileCanonicalPolicy,
  evaluateCanonicalPolicy,
  verifyCanonicalCompiledPolicy,
  canonicalPolicyRepositoryIdentity,
  type CanonicalCompiledPolicy,
  type CanonicalPolicyAuthority
} from "./canonical-policy-compiler.js";

export const RUN_BOUNDED_TASK_VERSION = "run-bounded-task/v1" as const;
export const BOUNDED_TASK_RECEIPT_VERSION = "bounded-task-receipt/v1" as const;

export type BoundedTaskApplyExecutorResult = Readonly<{
  decision: "apply_completed" | "apply_blocked" | "apply_invalid" | "apply_recovery_required";
  route: "contract_approved" | "replan_required" | "human_review_required" | "recovery_required";
  receiptHash: string | null;
}>;

type BoundedTaskFlowInput = RunPlannerMinimalityBoundCoderFlowInput<WorkspaceMutation>;
export type RunBoundedTaskInput = Omit<BoundedTaskFlowInput,
  "plannerMinimalityProvider" | "coderProvider" | "contextRequestProvider"> & {
  /** Shared task budget, default 120 seconds, maximum 10 minutes. */
  timeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  durableTask?: DurableBoundedTaskConfiguration;
  plannerMinimalityProvider: (context: Parameters<BoundedTaskFlowInput["plannerMinimalityProvider"]>[0], control: TaskProviderControl) => Promise<unknown>;
  coderProvider: (context: Parameters<BoundedTaskFlowInput["coderProvider"]>[0], control: TaskProviderControl) => Promise<WorkspaceMutation>;
  contextRequestProvider: (context: Parameters<BoundedTaskFlowInput["contextRequestProvider"]>[0], control: TaskProviderControl) => ReturnType<BoundedTaskFlowInput["contextRequestProvider"]>;

  governedExecution?: CanonicalGovernedExecutionConfiguration;

  canonicalPolicy?: Readonly<{
    policyFilePath?: string;
    policyDocument?: unknown;
    compiledPolicy?: CanonicalCompiledPolicy;
    authority?: CanonicalPolicyAuthority;
  }>;

  applyExecutor?: (input: Readonly<{
    taskId: string;
    objectiveHash: string;
    mutation: WorkspaceMutation;
    plannerExecutionBindingHash: string;
    verifierFindingHash: string;
  }>) => Promise<BoundedTaskApplyExecutorResult>;
};

export type BoundedTaskStageReceipt = Readonly<{
  stage: RuntimeStage;
  decision: string;
  route: string;
  evidenceHash: string;
}>;

export type BoundedTaskReceipt = Readonly<{
  receiptVersion: typeof BOUNDED_TASK_RECEIPT_VERSION;
  runtimeContractVersion: typeof RUNTIME_CONTRACT_VERSION;
  taskId: string;
  objectiveHash: string;
  outcome: "verified_draft_ready" | "applied_and_validated" | "validated_no_change";
  plannerExecutionBindingHash: string;
  coderMutationHash: string;
  verifierFindingHash: string;
  compiledPolicyHash: string;
  applyReceiptHash: string | null;
  stages: readonly BoundedTaskStageReceipt[];
  receiptHash: string;
}>;

export type BoundedTaskRoute =
  | "verified_draft_ready"
  | "contract_approved"
  | "replan_required"
  | "human_review_required"
  | "recovery_required";

export type RunBoundedTaskResult = Readonly<{
  decision: "bounded_task_completed" | "bounded_task_stopped" | "bounded_task_invalid";
  route: BoundedTaskRoute;
  failure: RuntimeFailure | null;
  receipt: BoundedTaskReceipt | null;
  plannerResult: PlannerMinimalityBoundCoderFlowResult<WorkspaceMutation> | null;
  verifierResult: DeterministicVerifierV2Result | null;
  applyResult: BoundedTaskApplyExecutorResult | null;
  summary: Readonly<{
    plannerCalled: boolean;
    coderCalled: boolean;
    verifierCalled: boolean;
    applyCalled: boolean;
    stageReceiptCount: number;
  }>;
}>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function isApplyExecutorResult(value: unknown): value is BoundedTaskApplyExecutorResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.decision === "string" &&
    ["apply_completed", "apply_blocked", "apply_invalid", "apply_recovery_required"].includes(candidate.decision) &&
    typeof candidate.route === "string" &&
    ["contract_approved", "replan_required", "human_review_required", "recovery_required"].includes(candidate.route) &&
    (candidate.receiptHash === null ||
      (typeof candidate.receiptHash === "string" && HASH.test(candidate.receiptHash)));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stageReceipt(stage: RuntimeStage, decision: string, route: string, evidence: unknown): BoundedTaskStageReceipt {
  return deepFreeze({ stage, decision, route, evidenceHash: hashCanonicalJson(evidence) });
}

function runtimeFailure(
  stage: RuntimeStage,
  route: RuntimeFailure["route"],
  code: string,
  message: string,
  details: Readonly<Record<string, string>> = {}
): RuntimeFailure {
  return createRuntimeFailure({ stage, route, code, message, details });
}

function verifierFailureCode(result: DeterministicVerifierV2Result): string {
  return result.issues[0]?.ruleId.toLowerCase() ?? "deterministic_verifier_v2_not_approved";
}

function stoppedRoute(result: PlannerMinimalityBoundCoderFlowResult<WorkspaceMutation>): BoundedTaskRoute {
  return result.route === "replan_required" ? "replan_required" : "human_review_required";
}

function plannerFailure(result: PlannerMinimalityBoundCoderFlowResult<WorkspaceMutation>): RuntimeFailure {
  const issue = result.issues[0];
  const stage: RuntimeStage = result.summary.plannerProviderCallCount === 0
    ? "planning"
    : result.summary.minimalityGateCallCount === 0
      ? "planning"
      : result.summary.taskSeedFlowCallCount === 0
        ? "minimality"
        : "coding";
  return runtimeFailure(
    stage,
    result.route === "replan_required"
      ? "replan_required"
      : result.decision === "planner_minimality_task_invalid"
        ? "invalid_input"
        : "human_review_required",
    issue?.code ?? "planner_minimality_flow_stopped",
    issue?.message ?? "Planner-minimality flow stopped before a verified coder mutation was produced.",
    { decision: result.decision, route: result.route }
  );
}

function buildReceipt(input: Omit<BoundedTaskReceipt, "receiptVersion" | "runtimeContractVersion" | "receiptHash">): BoundedTaskReceipt {
  const core = {
    receiptVersion: BOUNDED_TASK_RECEIPT_VERSION,
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    ...input
  };
  return deepFreeze({ ...core, receiptHash: hashCanonicalJson(core) });
}

function resolvePolicy(input: RunBoundedTaskInput): {
  policy: CanonicalCompiledPolicy;
  verifyFresh: () => boolean;
} {
  const configured = input.canonicalPolicy;
  if (configured?.compiledPolicy !== undefined) {
    if (configured.policyFilePath !== undefined || configured.policyDocument !== undefined ||
        !verifyCanonicalCompiledPolicy(configured.compiledPolicy, input.repositoryPath)) {
      throw new CanonicalPolicyError("canonical_policy_compiled_artifact_invalid",
        "Compiled policy artifact is invalid or stale.");
    }
    return { policy: configured.compiledPolicy,
      verifyFresh: () => verifyCanonicalCompiledPolicy(configured.compiledPolicy!, input.repositoryPath) };
  }
  let compilerInput: Parameters<typeof compileCanonicalPolicy>[0];
  if (configured?.policyDocument !== undefined) {
    if (configured.policyFilePath !== undefined) throw new CanonicalPolicyError(
      "canonical_policy_source_invalid", "Choose a policy file or document, not both.");
    compilerInput = { repositoryPath: input.repositoryPath, policyDocument: configured.policyDocument };
  } else {
    const selected = configured?.policyFilePath ?? "bounded-agent.policy.yml";
    const candidate = path.resolve(input.repositoryPath, selected);
    if (!fs.existsSync(candidate)) throw new CanonicalPolicyError(
      "canonical_policy_source_required",
      "Canonical execution requires policyFilePath, policyDocument, or a verified compiledPolicy.");
    compilerInput = { repositoryPath: input.repositoryPath, policyFilePath: selected };
  }
  const policy = compileCanonicalPolicy(compilerInput);
  return { policy, verifyFresh: () => {
    try { return compileCanonicalPolicy(compilerInput).compiledPolicyHash === policy.compiledPolicyHash; }
    catch { return false; }
  } };
}

function canonicalTaskInputBinding(input: RunBoundedTaskInput, repository: string,
  policy: CanonicalCompiledPolicy): { taskInputHash: string; effectiveAllowedFiles: readonly string[];
    effectiveForbiddenFiles: readonly string[] } {
  const callerAllowed = new Set(input.allowedChangeFiles.map(canonicalizeRepositoryRelativePath));
  const callerForbidden = new Set((input.forbiddenFiles ?? []).map(canonicalizeRepositoryRelativePath));
  const effectiveAllowedFiles = policy.allowedPaths
    .filter((file) => callerAllowed.has(file) && !callerForbidden.has(file)).sort();
  const effectiveForbiddenFiles = [...new Set([...policy.forbiddenPaths, ...callerForbidden])].sort();
  const repositoryIdentityHash = canonicalPolicyRepositoryIdentity(repository);
  const baselineHeadHash = repositoryHeadHash(repository);
  return { effectiveAllowedFiles, effectiveForbiddenFiles, taskInputHash: hashCanonicalJson({
    version: "canonical-task-input/v1",
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    acceptanceCriteriaContractHash: input.acceptanceCriteriaContract.contractHash,
    authorityHash: input.authorityHash,
    canonicalAuthorityDocumentHash: input.canonicalPolicy?.authority?.authorityHash ?? null,
    compiledPolicyHash: policy.compiledPolicyHash,
    repositoryIdentityHash,
    baselineHeadHash,
    baselineSnapshotHash: policy.repositorySnapshotHash,
    effectiveAllowedFiles,
    effectiveForbiddenFiles,
    minimalityPolicyHash: input.minimalityPolicy.policyHash,
    governedValidationSpecificationHash: input.governedExecution === undefined ? null :
      hashCanonicalJson(input.governedExecution.phaseVExecutionSpecification),
    providerIdempotencySupport: Object.fromEntries(Object.entries(
      input.durableTask?.providerIdempotencySupport ?? {}).sort(([left], [right]) => left.localeCompare(right, "en"))),
    executionMode: input.governedExecution !== undefined ? "governed" :
      input.applyExecutor !== undefined ? "external_executor" : "verified_draft"
  }) };
}

export function verifyBoundedTaskReceipt(receipt: BoundedTaskReceipt): boolean {
  try {
    if (receipt.receiptVersion !== BOUNDED_TASK_RECEIPT_VERSION) return false;
    if (receipt.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION) return false;
    if (!IDENTIFIER.test(receipt.taskId) || !HASH.test(receipt.objectiveHash)) return false;
    if (!["verified_draft_ready", "applied_and_validated", "validated_no_change"].includes(receipt.outcome)) return false;
    if (!HASH.test(receipt.plannerExecutionBindingHash)) return false;
    if (!HASH.test(receipt.coderMutationHash) || !HASH.test(receipt.verifierFindingHash)) return false;
    if (receipt.applyReceiptHash !== null && !HASH.test(receipt.applyReceiptHash)) return false;
    if (!HASH.test(receipt.compiledPolicyHash)) return false;
    if (receipt.stages.length === 0 || receipt.stages.some((entry) => !HASH.test(entry.evidenceHash))) return false;
    const stageNames = new Set(receipt.stages.map((entry) => entry.stage));
    if (receipt.outcome === "verified_draft_ready" && receipt.applyReceiptHash !== null) return false;
    if (receipt.outcome === "applied_and_validated" &&
        (receipt.applyReceiptHash === null || !stageNames.has("apply") || !stageNames.has("validation"))) return false;
    if (receipt.outcome === "validated_no_change" &&
        (receipt.applyReceiptHash === null || stageNames.has("apply") || !stageNames.has("validation"))) return false;
    const { receiptHash, ...core } = receipt;
    return HASH.test(receiptHash) && receiptHash === hashCanonicalJson(core);
  } catch {
    return false;
  }
}

async function runBoundedTaskOnce(input: RunBoundedTaskInput,
  durableSession?: BoundedTaskStateSession): Promise<RunBoundedTaskResult> {
  const startedAt = Date.now();
  const summary = {
    plannerCalled: false,
    coderCalled: false,
    verifierCalled: false,
    applyCalled: false,
    stageReceiptCount: 0
  };
  const stages: BoundedTaskStageReceipt[] = [];
  let policyBinding: ReturnType<typeof resolvePolicy>;
  let effectiveAllowedFiles: readonly string[];
  let effectiveForbiddenFiles: readonly string[];

  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("runBoundedTask input must be an object.");
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 600_000)) throw new TypeError("timeoutMs must be an integer from 1 to 600000.");
    if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0)) throw new TypeError("deadlineAt must be a non-negative Unix timestamp in milliseconds.");
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
    if (!IDENTIFIER.test(input.taskId)) throw new TypeError("taskId is invalid.");
    if (!HASH.test(input.objectiveHash)) throw new TypeError("objectiveHash must be a sha256 hash.");
    if (!Array.isArray(input.allowedChangeFiles)) throw new TypeError("allowedChangeFiles must be an array.");
    for (const value of input.allowedChangeFiles) canonicalizeRepositoryRelativePath(value);
    for (const value of input.forbiddenFiles ?? []) canonicalizeRepositoryRelativePath(value);
    if (typeof input.plannerMinimalityProvider !== "function") throw new TypeError("plannerMinimalityProvider is required.");
    if (typeof input.coderProvider !== "function") throw new TypeError("coderProvider is required.");
    if (input.applyExecutor !== undefined && typeof input.applyExecutor !== "function") throw new TypeError("applyExecutor must be a function.");
    if (input.applyExecutor !== undefined && input.governedExecution !== undefined) throw new TypeError("Choose governedExecution or applyExecutor, not both.");
    policyBinding = resolvePolicy(input);
    const scope = canonicalTaskInputBinding(input, fs.realpathSync(input.repositoryPath), policyBinding.policy);
    effectiveAllowedFiles = scope.effectiveAllowedFiles;
    effectiveForbiddenFiles = scope.effectiveForbiddenFiles;
    if (effectiveAllowedFiles.length === 0) throw new CanonicalPolicyError(
      "canonical_policy_effective_scope_empty", "Policy and caller scope intersection is empty.");
  } catch (error) {
    return deepFreeze({
      decision: "bounded_task_invalid",
      route: "human_review_required",
      failure: runtimeFailure(
        "planning",
        "invalid_input",
        error instanceof CanonicalPolicyError ? error.code : "bounded_task_input_invalid",
        error instanceof Error ? error.message : "runBoundedTask input is invalid."
      ),
      receipt: null,
      plannerResult: null,
      verifierResult: null,
      applyResult: null,
      summary
    });
  }

  const deadlineAt = Math.min(startedAt + (input.timeoutMs ?? 120_000), input.deadlineAt ?? Infinity);
  const budget = createTaskProviderDeadline(deadlineAt, input.signal);
  try {
    budget.check();
    const plannerResult = await runPlannerMinimalityBoundCoderFlow({
      ...input,
      policyHash: policyBinding.policy.compiledPolicyHash,
      allowedChangeFiles: effectiveAllowedFiles,
      forbiddenFiles: effectiveForbiddenFiles,
      plannerMinimalityProvider: (context) => budget.call("planning", (control) => {
        durableSession?.advance("planning_started");
        return durableSession ? durableSession.cachedProvider("planner", context, async (providerIdempotencyKey) => {
          summary.plannerCalled = true; return input.plannerMinimalityProvider(context,
            { ...control, providerIdempotencyKey });
        }).then(({ value }) => { durableSession.advance("planning_completed"); return value; }) :
          (summary.plannerCalled = true, input.plannerMinimalityProvider(context, control));
      }),
      coderProvider: (context) => budget.call("coding", (control) => {
        durableSession?.advance("context_authorized", { contextEvidenceHash: hashCanonicalJson(context) });
        durableSession?.advance("coding_started");
        return durableSession ? durableSession.cachedProvider("coder", context, async (providerIdempotencyKey) => {
          summary.coderCalled = true; return input.coderProvider(context, { ...control, providerIdempotencyKey });
        }).then(({ value }) => { durableSession.advance("coding_completed", {
          mutationArtifactHash: hashCanonicalJson(value) }); return value; }) :
          (summary.coderCalled = true, input.coderProvider(context, control));
      }),
      contextRequestProvider: (context) => budget.call("repository_intelligence", (control) =>
        durableSession ? durableSession.cachedProvider("context", context, async (providerIdempotencyKey) =>
          await input.contextRequestProvider(context, { ...control, providerIdempotencyKey })).then(({ value }) => value) :
          input.contextRequestProvider(context, control))
    });
    // Lower-level flows can convert callback rejections into their own failures.
    budget.check();
    if (!durableSession) summary.coderCalled = plannerResult.summary.coderProviderCallCount > 0;
    stages.push(stageReceipt("planning", plannerResult.decision, plannerResult.route, {
      proposalHash: plannerResult.proposal?.proposalHash ?? null,
      issues: plannerResult.issues
    }));
    if (plannerResult.minimalityResult !== null) {
      stages.push(stageReceipt("minimality", plannerResult.minimalityResult.decision, plannerResult.minimalityResult.route, {
        receiptHash: plannerResult.minimalityResult.receipt?.receiptHash ?? null,
        baselineHash: plannerResult.minimalityResult.baseline?.baselineHash ?? null
      }));
    }

    const coderResult = plannerResult.taskSeedResult?.repoResult?.adaptiveResult?.coderResult;
    if (
      plannerResult.decision !== "planner_minimality_task_completed" ||
      plannerResult.route !== "coder_executed" ||
      plannerResult.executionBinding === null ||
      coderResult === undefined || coderResult === null
    ) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: plannerResult.decision === "planner_minimality_task_invalid" ? "bounded_task_invalid" : "bounded_task_stopped",
        route: stoppedRoute(plannerResult),
        failure: plannerFailure(plannerResult),
        receipt: null,
        plannerResult,
        verifierResult: null,
        applyResult: null,
        summary
      });
    }

    const mutationValidation = validateModelWorkspaceMutationValue(coderResult.providerOutput, { role: "coder" });
    if (!mutationValidation.ok || mutationValidation.mutation === null) {
      const issue = mutationValidation.issues[0];
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: "bounded_task_invalid",
        route: "human_review_required",
        failure: runtimeFailure(
          "coding",
          "invalid_input",
          "bounded_task_coder_output_invalid",
          issue?.message ?? "Coder output must be a workspace mutation.",
          issue === undefined ? {} : { issueCode: issue.code, path: issue.path ?? "" }
        ),
        receipt: null,
        plannerResult,
        verifierResult: null,
        applyResult: null,
        summary
      });
    }
    const mutation = mutationValidation.mutation;
    if (durableSession) {
      durableSession.writeArtifact("validated-mutation", mutation);
      durableSession.advance("coding_completed", { mutationArtifactHash: hashCanonicalJson(mutation),
        planHash: plannerResult.minimalityResult?.plan?.planHash ?? null,
        contextEvidenceHash: coderResult.context ? hashCanonicalJson(coderResult.context) : null });
    }
    stages.push(stageReceipt("coding", coderResult.decision, coderResult.route, mutation));

    if (!policyBinding.verifyFresh()) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({ decision: "bounded_task_stopped", route: "replan_required",
        failure: runtimeFailure("verification", "replan_required",
          "bounded_task_policy_changed", "Canonical policy or repository snapshot changed after planning.",
          { compiledPolicyHash: policyBinding.policy.compiledPolicyHash }),
        receipt: null, plannerResult, verifierResult: null, applyResult: null, summary });
    }
    budget.setStage("verification");
    budget.check();
    summary.verifierCalled = true;
    const verifierResult = await verifyPatchDraftMutationV2({
      repositoryPath: input.repositoryPath,
      mutation,
      allowedFiles: effectiveAllowedFiles,
      forbiddenFiles: effectiveForbiddenFiles,
      boundContextFiles: coderResult.context?.evidence.map(({ path, contentHash }) => ({ path, contentHash })) ?? [],
      policyHash: policyBinding.policy.compiledPolicyHash,
      requireExistingTouchedFiles: true
    });
    stages.push(stageReceipt("verification", verifierResult.decision, verifierResult.decision, {
      version: verifierResult.version,
      issues: verifierResult.issues,
      finding: verifierResult.finding
    }));
    if (verifierResult.decision === "approve" && durableSession) {
      const verified = durableSession.writeArtifact("verified-mutation", {
        mutation, finding: verifierResult.finding });
      durableSession.advance("mutation_verified", { verifiedMutationHash: verified.contentHash });
    }

    budget.check();
    const allowedMutationFiles = new Set(plannerResult.executionBinding.allowedMutationFiles);
    const outsideBoundary = [...new Set([
      ...verifierResult.canonicalTouchedFiles,
      ...verifierResult.canonicalClaimFiles
    ])].filter((file) => !allowedMutationFiles.has(file));
    // Preserve structural and safety rejections; scope-only drift requires a new plan.
    if (outsideBoundary.length > 0 && verifierResult.issues.every((issue) =>
      issue.ruleId === "DV2_ALLOWLIST_VIOLATION" || issue.disposition === "needs_review"
    )) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: "bounded_task_stopped",
        route: "replan_required",
        failure: runtimeFailure(
          "verification",
          "replan_required",
          "bounded_task_mutation_scope_violation",
          "Mutation files must be caller-allowed, planned, and backed by verified bound context.",
          { files: outsideBoundary.join(", ") }
        ),
        receipt: null,
        plannerResult,
        verifierResult,
        applyResult: null,
        summary
      });
    }

    const noChange = verifierResult.issues.length > 0 && verifierResult.issues.every((entry) =>
      entry.mutationCode === "MUTATION_NO_CHANGE");
    if (verifierResult.decision !== "approve" && !noChange) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: verifierResult.decision === "reject" ? "bounded_task_invalid" : "bounded_task_stopped",
        route: verifierResult.decision === "reject" ? "human_review_required" : "replan_required",
        failure: runtimeFailure("verification",
          verifierResult.decision === "reject" ? "policy_blocked" : "replan_required",
          verifierFailureCode(verifierResult),
          verifierResult.issues[0]?.message ?? "Deterministic verifier v2 did not approve the coder mutation.",
          { decision: verifierResult.decision, verifierVersion: verifierResult.version,
            ...(verifierResult.issues[0] === undefined ? {} : { ruleId: verifierResult.issues[0].ruleId }) }),
        receipt: null, plannerResult, verifierResult, applyResult: null, summary
      });
    }

    const policyEvaluation = evaluateCanonicalPolicy({ policy: policyBinding.policy,
      changedFiles: mutation.touchedFiles, authority: input.canonicalPolicy?.authority,
      repositoryIdentityHash: canonicalPolicyRepositoryIdentity(input.repositoryPath),
      taskId: input.taskId, mutation });
    stages.push(stageReceipt("verification", "canonical_policy_evaluated",
      policyEvaluation.decision, { compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
        evaluationHash: policyEvaluation.evaluationHash, reasonCodes: policyEvaluation.reasonCodes }));
    if (policyEvaluation.decision !== "allow") {
      summary.stageReceiptCount = stages.length;
      const pairMissing = policyEvaluation.reasonCodes.includes("canonical_policy_paired_file_missing");
      return deepFreeze({ decision: "bounded_task_stopped",
        route: pairMissing ? "replan_required" : "human_review_required",
        failure: runtimeFailure("verification", pairMissing ? "replan_required" : "policy_blocked",
          policyEvaluation.reasonCodes[0] ?? "bounded_task_policy_rejected",
          "Canonical policy rejected the proposed mutation.",
          { compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
            evaluationHash: policyEvaluation.evaluationHash }),
        receipt: null, plannerResult, verifierResult, applyResult: null, summary });
    }

    if (verifierResult.decision !== "approve" && noChange && input.governedExecution !== undefined) {
      if (!policyBinding.verifyFresh()) {
        summary.stageReceiptCount = stages.length;
        return deepFreeze({ decision: "bounded_task_stopped", route: "replan_required",
          failure: runtimeFailure("verification", "replan_required", "bounded_task_policy_changed",
            "Canonical policy or repository snapshot changed before no-change acceptance.",
            { compiledPolicyHash: policyBinding.policy.compiledPolicyHash }),
          receipt: null, plannerResult, verifierResult, applyResult: null, summary });
      }
      budget.check();
      budget.dispose();
      let accepted;
      try {
        accepted = await verifyCanonicalNoChangeAcceptance({ taskId: input.taskId,
          objectiveHash: input.objectiveHash, repositoryPath: input.repositoryPath,
          touchedFiles: mutation.touchedFiles,
          specification: input.governedExecution.phaseVExecutionSpecification });
      } catch (error) {
        stages.push(stageReceipt("validation", "no_change_acceptance_failed",
          "recovery_required", { code: "bounded_task_no_change_acceptance_error" }));
        summary.stageReceiptCount = stages.length;
        return deepFreeze({ decision: "bounded_task_stopped", route: "recovery_required",
          failure: runtimeFailure("validation", "recovery_required",
            "bounded_task_no_change_acceptance_error",
            error instanceof Error ? error.message : "No-change acceptance failed."),
          receipt: null, plannerResult, verifierResult, applyResult: null, summary });
      }
      stages.push(stageReceipt("validation", accepted.decision,
        accepted.decision === "no_change_accepted" ? "contract_approved" : "replan_required", accepted));
      summary.stageReceiptCount = stages.length;
      if (accepted.decision !== "no_change_accepted" || accepted.receiptHash === null) return deepFreeze({
        decision: "bounded_task_stopped", route: "replan_required",
        failure: runtimeFailure("validation", "replan_required",
          "bounded_task_no_change_acceptance_failed", "No-change acceptance did not pass."),
        receipt: null, plannerResult, verifierResult, applyResult: null, summary
      });
      const receipt = buildReceipt({ taskId: input.taskId, objectiveHash: input.objectiveHash,
        outcome: "validated_no_change", plannerExecutionBindingHash: plannerResult.executionBinding.bindingHash,
        coderMutationHash: hashCanonicalJson(mutation), verifierFindingHash: hashCanonicalJson(verifierResult.finding),
        compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
        applyReceiptHash: accepted.receiptHash, stages });
      return deepFreeze({ decision: "bounded_task_completed", route: "contract_approved",
        failure: null, receipt, plannerResult, verifierResult, applyResult: null, summary });
    }

    if (verifierResult.decision !== "approve") {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: verifierResult.decision === "reject" ? "bounded_task_invalid" : "bounded_task_stopped",
        route: verifierResult.decision === "reject" ? "human_review_required" : "replan_required",
        failure: runtimeFailure(
          "verification",
          verifierResult.decision === "reject" ? "policy_blocked" : "replan_required",
          verifierFailureCode(verifierResult),
          verifierResult.issues[0]?.message ?? "Deterministic verifier v2 did not approve the coder mutation.",
          {
            decision: verifierResult.decision,
            verifierVersion: verifierResult.version,
            ...(verifierResult.issues[0] === undefined ? {} : { ruleId: verifierResult.issues[0].ruleId })
          }
        ),
        receipt: null,
        plannerResult,
        verifierResult,
        applyResult: null,
        summary
      });
    }

    const plannerExecutionBindingHash = plannerResult.executionBinding.bindingHash;
    const coderMutationHash = hashCanonicalJson(mutation);
    const verifierFindingHash = hashCanonicalJson(verifierResult.finding);

    if (input.governedExecution !== undefined) {
      if (!policyBinding.verifyFresh()) {
        summary.stageReceiptCount = stages.length;
        return deepFreeze({ decision: "bounded_task_stopped", route: "replan_required",
          failure: runtimeFailure("verification", "replan_required", "bounded_task_policy_changed",
            "Canonical policy or repository snapshot changed immediately before governed apply.",
            { compiledPolicyHash: policyBinding.policy.compiledPolicyHash }),
          receipt: null, plannerResult, verifierResult, applyResult: null, summary });
      }
      budget.check();
      budget.dispose();
      summary.applyCalled = true;
      const adaptiveResult = plannerResult.taskSeedResult?.repoResult?.adaptiveResult;
      if (!adaptiveResult || !plannerResult.minimalityResult?.plan) throw new TypeError("Governed execution requires adaptive context and a minimality plan.");
      let governed;
      try {
        if (durableSession) durableSession.writeArtifact("preapply-runtime", {
          plannerResult, verifierResult, stages, plannerExecutionBindingHash,
          coderMutationHash, verifierFindingHash });
        governed = await executeCanonicalGovernedMutation({ taskId: input.taskId,
          objectiveHash: input.objectiveHash, repositoryPath: input.repositoryPath,
          planHash: plannerResult.minimalityResult.plan.planHash,
          contextBindingHash: hashCanonicalJson(coderResult.context),
          plannerExecutionBindingHash,
          compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
          coderMutation: mutation,
          verifierFinding: verifierResult.finding,
          adaptiveResult, allowedFiles: effectiveAllowedFiles,
          forbiddenFiles: effectiveForbiddenFiles, configuration: input.governedExecution,
          durableCheckpoint: durableSession === undefined ? undefined : async (state, artifact) => {
            const ref = durableSession.writeArtifact(state, artifact);
            if (state === "governed_apply_prepared") durableSession.advance(state);
            else if (state === "x4_committed") durableSession.advance(state, { x4Reference: ref });
            else if (state === "validation_started") durableSession.advance(state, { x5IntentReference: ref });
            else if (state === "validation_completed") durableSession.advance(state, { x5ReceiptReference: ref });
            else durableSession.advance(state);
          } });
      } catch (error) {
        const governedError = error instanceof CanonicalGovernedExecutionError ? error : null;
        const route = governedError?.route ?? "recovery_required";
        stages.push(stageReceipt("apply", "governed_execution_failed", route, {
          code: governedError?.code ?? "canonical_governed_execution_failed"
        }));
        summary.stageReceiptCount = stages.length;
        return deepFreeze({ decision: "bounded_task_stopped", route,
          failure: runtimeFailure("apply", route === "recovery_required" ? "recovery_required" :
            route === "replan_required" ? "replan_required" : "policy_blocked",
          governedError?.code ?? "canonical_governed_execution_failed",
          error instanceof Error ? error.message : "Governed execution failed."),
          receipt: null, plannerResult, verifierResult, applyResult: null, summary });
      }
      const actual = governed.integratedResult;
      const completed = actual.decision === "integrated_disposable_apply_finalized" &&
        actual.route === "contract_approved" && actual.receipt !== null &&
        actual.applyResult?.receipt?.outcome === "applied" &&
        actual.postApplyValidation?.finalReceipt?.outcome === "validated" &&
        actual.finalAcceptance?.decision === "contract_approved" &&
        actual.finalReceiptVerification?.decision === "controlled_post_apply_final_receipt_current" &&
        actual.summary.finalReceiptCurrent &&
        actual.summary.repositoryFinalState === "validated_applied_state";
      const applyResult: BoundedTaskApplyExecutorResult = completed ? {
        decision: "apply_completed", route: "contract_approved",
        receiptHash: actual.receipt!.receiptHash
      } : {
        decision: actual.route === "recovery_required" ? "apply_recovery_required" : "apply_blocked",
        route: actual.route === "recovery_required" ? "recovery_required" :
          actual.route === "replan_required" ? "replan_required" : "human_review_required",
        receiptHash: null
      };
      stages.push(stageReceipt("apply", actual.decision, actual.route, {
        adapterReceiptHash: governed.adapterReceipt.receiptHash,
        compiledPolicyHash: governed.adapterReceipt.compiledPolicyHash,
        coderVerifierFindingHash: hashCanonicalJson(governed.governanceReceipts.coderVerifierFinding),
        repairVerifierFindingHash: hashCanonicalJson(governed.governanceReceipts.repairVerifierFinding),
        phaseVExecutionVerificationHash:
          governed.governanceReceipts.phaseVExecutionVerification.verificationResultHash,
        finalLedgerRootHash: governed.governanceReceipts.finalLedger.rootHash,
        governanceHash: governed.governanceReceipts.governanceAssessment.governanceHash,
        adminInvocationAssessmentHash:
          governed.governanceReceipts.adminInvocationAssessment.assessmentHash,
        approvalRouteHash: governed.governanceReceipts.approvalRouteAssessment.routeHash,
        governedArtifactHash: governed.governanceReceipts.governedArtifact.governedArtifactHash,
        x4ReceiptHash: actual.applyResult?.receipt?.receiptHash ?? null
      }));
      stages.push(stageReceipt("validation", actual.postApplyValidation?.decision ?? "not_run",
        actual.route, { x5ReceiptHash: actual.postApplyValidation?.finalReceipt?.receiptHash ?? null,
          finalAcceptanceHash: actual.finalAcceptance?.receipt?.receiptHash ?? null,
          finalReceiptCurrent: actual.summary.finalReceiptCurrent }));
      summary.stageReceiptCount = stages.length;
      if (!completed) return deepFreeze({ decision: actual.decision.includes("invalid")
        ? "bounded_task_invalid" : "bounded_task_stopped", route: applyResult.route,
        failure: runtimeFailure("validation", applyResult.route === "recovery_required"
          ? "recovery_required" : applyResult.route === "replan_required" ? "replan_required" : "policy_blocked",
        "bounded_task_governed_execution_not_completed",
        actual.issues[0]?.message ?? "Governed apply and validation did not complete."),
        receipt: null, plannerResult, verifierResult, applyResult, summary });
      const receipt = buildReceipt({ taskId: input.taskId, objectiveHash: input.objectiveHash,
        outcome: "applied_and_validated", plannerExecutionBindingHash, coderMutationHash,
        verifierFindingHash, compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
        applyReceiptHash: actual.receipt!.receiptHash, stages });
      return deepFreeze({ decision: "bounded_task_completed", route: "contract_approved",
        failure: null, receipt, plannerResult, verifierResult, applyResult, summary });
    }

    if (input.applyExecutor === undefined) {
      const receipt = buildReceipt({
        taskId: input.taskId,
        objectiveHash: input.objectiveHash,
        outcome: "verified_draft_ready",
        plannerExecutionBindingHash,
        coderMutationHash,
        verifierFindingHash,
        compiledPolicyHash: policyBinding.policy.compiledPolicyHash,
        applyReceiptHash: null,
        stages
      });
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: "bounded_task_completed",
        route: "verified_draft_ready",
        failure: null,
        receipt,
        plannerResult,
        verifierResult,
        applyResult: null,
        summary
      });
    }

    if (!policyBinding.verifyFresh()) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({ decision: "bounded_task_stopped", route: "replan_required",
        failure: runtimeFailure("verification", "replan_required", "bounded_task_policy_changed",
          "Canonical policy or repository snapshot changed immediately before apply.",
          { compiledPolicyHash: policyBinding.policy.compiledPolicyHash }),
        receipt: null, plannerResult, verifierResult, applyResult: null, summary });
    }
    budget.check();
    // Once mutation may start, await the executor's outcome/recovery contract.
    // Cancellation must not abandon an in-flight repository write.
    budget.dispose();
    summary.applyCalled = true;
    let applyResult: BoundedTaskApplyExecutorResult;
    try {
      durableSession?.advance("governed_apply_prepared");
      durableSession?.advance("governed_apply_started");
      const candidate: unknown = await input.applyExecutor({
        taskId: input.taskId,
        objectiveHash: input.objectiveHash,
        mutation,
        plannerExecutionBindingHash,
        verifierFindingHash
      });
      if (!isApplyExecutorResult(candidate)) {
        throw new TypeError("Apply executor returned an invalid result.");
      }
      // Receipt evidence contains only the validated executor contract, not metadata.
      applyResult = {
        decision: candidate.decision,
        route: candidate.route,
        receiptHash: candidate.receiptHash
      };

      stages.push(stageReceipt("apply", applyResult.decision, applyResult.route, applyResult));
      if (
        applyResult.decision !== "apply_completed" ||
        applyResult.route !== "contract_approved" ||
        applyResult.receiptHash === null ||
        !HASH.test(applyResult.receiptHash)
      ) {
        summary.stageReceiptCount = stages.length;
        const recovery = applyResult.decision === "apply_recovery_required" || applyResult.route === "recovery_required";
        return deepFreeze({
          decision: applyResult.decision === "apply_invalid" ? "bounded_task_invalid" : "bounded_task_stopped",
          route: recovery
            ? "recovery_required"
            : applyResult.route === "replan_required"
              ? "replan_required"
              : "human_review_required",
          failure: runtimeFailure(
            "apply",
            recovery ? "recovery_required" : applyResult.decision === "apply_invalid" ? "invalid_input" : "policy_blocked",
            "bounded_task_apply_not_completed",
            "Apply executor did not produce a current approved receipt.",
            { decision: applyResult.decision, route: applyResult.route }
          ),
          receipt: null,
          plannerResult,
          verifierResult,
          applyResult,
          summary
        });
      }
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: "bounded_task_invalid",
        route: "human_review_required",
        failure: runtimeFailure("apply", "policy_blocked",
          "bounded_task_unverified_apply_receipt",
          "A caller-provided receipt hash cannot prove governed apply and validation."),
        receipt: null,
        plannerResult,
        verifierResult,
        applyResult,
        summary
      });
    } catch (error) {
      summary.stageReceiptCount = stages.length;
      return deepFreeze({
        decision: "bounded_task_stopped",
        route: "recovery_required",
        failure: runtimeFailure(
          "apply",
          "recovery_required",
          "bounded_task_apply_executor_failed",
          error instanceof Error ? error.message : "Apply executor failed."
        ),
        receipt: null,
        plannerResult,
        verifierResult,
        applyResult: null,
        summary
      });
    }

  } catch (error) {
    if (!(error instanceof TaskProviderInterruption)) throw error;
    summary.stageReceiptCount = stages.length;
    return deepFreeze({
      decision: "bounded_task_stopped",
      route: error.code === "bounded_task_deadline_exceeded" ? "replan_required" : "human_review_required",
      failure: runtimeFailure(error.stage,
        error.code === "bounded_task_deadline_exceeded" ? "replan_required" : "human_review_required",
        error.code, error.message, { deadlineAt: String(deadlineAt), stage: error.stage }),
      receipt: null,
      plannerResult: null,
      verifierResult: null,
      applyResult: null,
      summary
    });
  } finally {
    budget.dispose();
  }

}

function durableFailure(input: Partial<RunBoundedTaskInput>, code: string,
  message: string): RunBoundedTaskResult {
  return deepFreeze({ decision: "bounded_task_stopped", route: "recovery_required",
    failure: runtimeFailure("planning", "recovery_required", code, message), receipt: null,
    plannerResult: null, verifierResult: null, applyResult: null,
    summary: { plannerCalled: false, coderCalled: false, verifierCalled: false,
      applyCalled: false, stageReceiptCount: 0 } });
}

function repositoryHeadHash(repositoryPath: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath,
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return hashCanonicalJson({ head });
  } catch { return hashCanonicalJson({ head: null }); }
}

function terminalStateFor(result: RunBoundedTaskResult): "finalized" | "failed" |
  "replan_required" | "human_review_required" | "recovery_required" {
  if (result.decision === "bounded_task_completed") return "finalized";
  if (result.route === "replan_required") return "replan_required";
  if (result.route === "human_review_required") return "human_review_required";
  if (result.route === "recovery_required") return "recovery_required";
  return "failed";
}

async function resumeGovernedState(session: BoundedTaskStateSession): Promise<RunBoundedTaskResult> {
  const prepared = session.getArtifact<any>("governed_apply_prepared");
  if (!prepared?.recoveryInput) return durableFailure({}, "bounded_task_recovery_artifact_missing",
    "Governed recovery evidence is missing.");
  const recovery = await executeControlledTransactionRecovery(prepared.recoveryInput);
  if (["controlled_transaction_recovery_rolled_back",
      "controlled_transaction_recovery_closed_prewrite"].includes(recovery.decision)) {
    return deepFreeze({ ...durableFailure({}, "bounded_task_governed_transaction_recovered",
      "Incomplete governed transaction was safely restored."), route: "replan_required" as const,
      failure: runtimeFailure("apply", "replan_required", "bounded_task_governed_transaction_recovered",
        "Incomplete governed transaction was safely restored.") });
  }
  let validation = session.getArtifact<any>("validation_completed")?.artifact ?? null;
  if (recovery.decision === "controlled_transaction_recovery_awaiting_validation") {
    const x4 = session.getArtifact<any>("x4_committed")?.artifact;
    if (!x4?.receipt) return durableFailure({}, "bounded_task_x4_receipt_missing",
      "Committed X.4 state has no verified apply receipt.");
    validation = await executeControlledPostApplyValidation({ applyReceipt: x4.receipt,
      authorization: prepared.recoveryInput.authorization, gateInput: prepared.recoveryInput.gateInput,
      registryDirectoryPath: prepared.recoveryInput.registryDirectoryPath,
      validationWorkspaceParentPath: prepared.recoveryInput.validationWorkspaceParentPath,
      phaseVExecutionSpecification: prepared.phaseVExecutionSpecification,
      phaseVExecutionVerification: prepared.phaseVExecutionVerification });
    const ref = session.writeArtifact("validation_completed", {
      recoveryInput: prepared.recoveryInput, artifact: validation });
    session.advance("validation_completed", { x5ReceiptReference: ref });
  } else if (recovery.decision !== "controlled_transaction_recovery_not_required") {
    return durableFailure({}, recovery.issues[0]?.code ?? "bounded_task_x6_recovery_required",
      "Governed transaction recovery requires operator attention.");
  }
  if (validation?.decision !== "controlled_post_apply_validation_finalized" ||
      validation.finalReceipt?.outcome !== "validated") return durableFailure({},
    "bounded_task_resumed_validation_not_finalized", "Resumed validation did not finalize successfully.");
  const pre = session.getArtifact<any>("preapply-runtime");
  if (!pre?.plannerResult || !pre?.verifierResult) return durableFailure({},
    "bounded_task_preapply_artifact_missing", "Pre-apply task evidence is missing.");
  const applyResult: BoundedTaskApplyExecutorResult = { decision: "apply_completed",
    route: "contract_approved", receiptHash: validation.finalReceipt.receiptHash };
  const stages: BoundedTaskStageReceipt[] = [...pre.stages,
    stageReceipt("apply", "x4_committed", "contract_approved",
      { receiptHash: session.snapshot.x4Reference?.contentHash ?? null }),
    stageReceipt("validation", validation.decision, "contract_approved",
      { receiptHash: validation.finalReceipt.receiptHash })];
  const receipt = buildReceipt({ taskId: session.snapshot.taskId,
    objectiveHash: pre.plannerResult.proposal.objectiveHash, outcome: "applied_and_validated",
    plannerExecutionBindingHash: pre.plannerExecutionBindingHash,
    coderMutationHash: pre.coderMutationHash, verifierFindingHash: pre.verifierFindingHash,
    compiledPolicyHash: session.snapshot.compiledPolicyHash,
    applyReceiptHash: validation.finalReceipt.receiptHash, stages });
  return deepFreeze({ decision: "bounded_task_completed", route: "contract_approved",
    failure: null, receipt, plannerResult: pre.plannerResult, verifierResult: pre.verifierResult,
    applyResult, summary: { plannerCalled: false, coderCalled: false, verifierCalled: false,
      applyCalled: false, stageReceiptCount: stages.length } });
}

export async function runBoundedTask(input: RunBoundedTaskInput): Promise<RunBoundedTaskResult> {
  if (!input?.durableTask) return runBoundedTaskOnce(input);
  let session: BoundedTaskStateSession | null = null;
  try {
    const policy = resolvePolicy(input).policy;
    const repository = fs.realpathSync(input.repositoryPath);
    const binding = canonicalTaskInputBinding(input, repository, policy);
    session = new BoundedTaskStateSession(input.durableTask, { taskId: input.taskId,
      repositoryPath: repository,
      repositoryIdentityHash: canonicalPolicyRepositoryIdentity(repository),
      baselineSnapshotHash: policy.repositorySnapshotHash,
      baselineHeadHash: repositoryHeadHash(repository),
      compiledPolicyHash: policy.compiledPolicyHash,
      taskInputHash: binding.taskInputHash });
    const terminal = session.terminalResult<RunBoundedTaskResult>();
    if (terminal !== null) {
      if (terminal.receipt !== null && !verifyBoundedTaskReceipt(terminal.receipt)) throw new BoundedTaskStateError(
        "bounded_task_terminal_receipt_invalid", "Stored terminal receipt is invalid.");
      return deepFreeze(terminal);
    }
    session.assertProviderResumeSafe();
    const applyStartedIndex = ["governed_apply_started", "x4_committed", "validation_started",
      "validation_completed"].indexOf(session.snapshot.currentState);
    if (applyStartedIndex >= 0) {
      const recovered = await resumeGovernedState(session);
      if (recovered.decision === "bounded_task_completed" || recovered.route !== "recovery_required") {
        session.finalize(terminalStateFor(recovered), recovered);
      }
      return recovered;
    }
    const durableInput: RunBoundedTaskInput = { ...input, repositoryPath: repository,
      plannerMinimalityProvider: async (context, control) => input.plannerMinimalityProvider(context, control),
      coderProvider: async (context, control) => input.coderProvider(context, control),
      contextRequestProvider: (context, control) => input.contextRequestProvider(context, control) };
    const result = await runBoundedTaskOnce(durableInput, session);
    session.finalize(terminalStateFor(result), result);
    return result;
  } catch (error) {
    if (error instanceof BoundedTaskStateError) return durableFailure(input, error.code, error.message);
    return durableFailure(input, "bounded_task_state_initialization_failed",
      "Durable task state initialization failed.");
  } finally { session?.release(); }
}

export async function resumeBoundedTask(input: RunBoundedTaskInput): Promise<RunBoundedTaskResult> {
  if (!input?.durableTask) return durableFailure(input, "bounded_task_resume_configuration_missing",
    "resumeBoundedTask requires durableTask configuration.");
  return runBoundedTask({ ...input, durableTask: { ...input.durableTask, resume: true } });
}
