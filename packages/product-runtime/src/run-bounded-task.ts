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

export const RUN_BOUNDED_TASK_VERSION = "run-bounded-task/v1" as const;
export const BOUNDED_TASK_RECEIPT_VERSION = "bounded-task-receipt/v1" as const;

export type BoundedTaskApplyExecutorResult = Readonly<{
  decision: "apply_completed" | "apply_blocked" | "apply_invalid" | "apply_recovery_required";
  route: "contract_approved" | "replan_required" | "human_review_required" | "recovery_required";
  receiptHash: string | null;
}>;

export type RunBoundedTaskInput = RunPlannerMinimalityBoundCoderFlowInput<WorkspaceMutation> & {
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
  outcome: "verified_draft_ready" | "applied_and_validated";
  plannerExecutionBindingHash: string;
  coderMutationHash: string;
  verifierFindingHash: string;
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

export function verifyBoundedTaskReceipt(receipt: BoundedTaskReceipt): boolean {
  try {
    if (receipt.receiptVersion !== BOUNDED_TASK_RECEIPT_VERSION) return false;
    if (receipt.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION) return false;
    if (!IDENTIFIER.test(receipt.taskId) || !HASH.test(receipt.objectiveHash)) return false;
    if (!HASH.test(receipt.plannerExecutionBindingHash)) return false;
    if (!HASH.test(receipt.coderMutationHash) || !HASH.test(receipt.verifierFindingHash)) return false;
    if (receipt.applyReceiptHash !== null && !HASH.test(receipt.applyReceiptHash)) return false;
    if (receipt.stages.length === 0 || receipt.stages.some((entry) => !HASH.test(entry.evidenceHash))) return false;
    const { receiptHash, ...core } = receipt;
    return HASH.test(receiptHash) && receiptHash === hashCanonicalJson(core);
  } catch {
    return false;
  }
}

export async function runBoundedTask(input: RunBoundedTaskInput): Promise<RunBoundedTaskResult> {
  const summary = {
    plannerCalled: false,
    coderCalled: false,
    verifierCalled: false,
    applyCalled: false,
    stageReceiptCount: 0
  };
  const stages: BoundedTaskStageReceipt[] = [];

  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("runBoundedTask input must be an object.");
    if (!IDENTIFIER.test(input.taskId)) throw new TypeError("taskId is invalid.");
    if (!HASH.test(input.objectiveHash)) throw new TypeError("objectiveHash must be a sha256 hash.");
    if (!Array.isArray(input.allowedChangeFiles)) throw new TypeError("allowedChangeFiles must be an array.");
    for (const value of input.allowedChangeFiles) canonicalizeRepositoryRelativePath(value);
    for (const value of input.forbiddenFiles ?? []) canonicalizeRepositoryRelativePath(value);
    if (typeof input.plannerMinimalityProvider !== "function") throw new TypeError("plannerMinimalityProvider is required.");
    if (typeof input.coderProvider !== "function") throw new TypeError("coderProvider is required.");
    if (input.applyExecutor !== undefined && typeof input.applyExecutor !== "function") throw new TypeError("applyExecutor must be a function.");
  } catch (error) {
    return deepFreeze({
      decision: "bounded_task_invalid",
      route: "human_review_required",
      failure: runtimeFailure(
        "planning",
        "invalid_input",
        "bounded_task_input_invalid",
        error instanceof Error ? error.message : "runBoundedTask input is invalid."
      ),
      receipt: null,
      plannerResult: null,
      verifierResult: null,
      applyResult: null,
      summary
    });
  }

  summary.plannerCalled = true;
  const plannerResult = await runPlannerMinimalityBoundCoderFlow(input);
  summary.coderCalled = plannerResult.summary.coderProviderCallCount > 0;
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
    coderResult?.providerOutput === null ||
    coderResult?.providerOutput === undefined
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

  const mutation = coderResult.providerOutput;
  stages.push(stageReceipt("coding", coderResult.decision, coderResult.route, mutation));

  summary.verifierCalled = true;
  const verifierResult = await verifyPatchDraftMutationV2({
    repositoryPath: input.repositoryPath,
    mutation,
    allowedFiles: input.allowedChangeFiles,
    forbiddenFiles: input.forbiddenFiles ?? [],
    requireExistingTouchedFiles: true
  });
  stages.push(stageReceipt("verification", verifierResult.decision, verifierResult.decision, {
    version: verifierResult.version,
    issues: verifierResult.issues,
    finding: verifierResult.finding
  }));

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

  if (input.applyExecutor === undefined) {
    const receipt = buildReceipt({
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      outcome: "verified_draft_ready",
      plannerExecutionBindingHash,
      coderMutationHash,
      verifierFindingHash,
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

  summary.applyCalled = true;
  let applyResult: BoundedTaskApplyExecutorResult;
  try {
    applyResult = await input.applyExecutor({
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      mutation,
      plannerExecutionBindingHash,
      verifierFindingHash
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

  stages.push(stageReceipt("validation", "validation_completed", "contract_approved", {
    applyReceiptHash: applyResult.receiptHash
  }));
  const receipt = buildReceipt({
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    outcome: "applied_and_validated",
    plannerExecutionBindingHash,
    coderMutationHash,
    verifierFindingHash,
    applyReceiptHash: applyResult.receiptHash,
    stages
  });
  summary.stageReceiptCount = stages.length;
  return deepFreeze({
    decision: "bounded_task_completed",
    route: "contract_approved",
    failure: null,
    receipt,
    plannerResult,
    verifierResult,
    applyResult,
    summary
  });
}
