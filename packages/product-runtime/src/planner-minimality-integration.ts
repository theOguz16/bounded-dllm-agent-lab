import { hashCanonicalJson } from "./agent-event-ledger.js";
import type { AcceptanceCriteriaContract } from "./acceptance-criteria-contract.js";
import {
  validateBoundedPlannerProposal,
  type BoundedPlannerProposal,
  type BoundedPlannerProposalLimits
} from "./bounded-planner-proposal-contract.js";
import {
  auditTaskToSeedImplementationContract,
  runTaskToSeedBoundCoderFlow,
  type RunTaskToSeedBoundCoderFlowInput,
  type TaskToSeedBoundCoderFlowResult,
  type TaskToSeedImplementationAuditReceipt,
  type TaskToSeedImplementationContract
} from "./task-to-seed-implementation-contract.js";
import {
  createPreventiveMinimalityPlan,
  evaluatePreventiveMinimalityPlan,
  verifyPreventiveMinimalityPolicy,
  type EvaluatePreventiveMinimalityResult,
  type PreventiveMinimalityPolicy
} from "./preventive-minimality-contract.js";

export const PLANNER_MINIMALITY_INTEGRATION_VERSION = "1" as const;
export const PLANNER_MINIMALITY_EXECUTION_BINDING_VERSION = "1" as const;

export type PlannerMinimalityProviderContext = {
  version: "1";
  taskId: string;
  objectiveHash: string;
  acceptanceContractHash: string;
  authorityHash: string;
  policyHash: string;
  limits: BoundedPlannerProposalLimits;
  allowedChangeFiles: readonly string[];
  forbiddenFiles: readonly string[];
  minimalityPolicy: PreventiveMinimalityPolicy;
  taskContext: unknown;
};

export type PlannerMinimalityProviderOutput = {
  proposal: unknown;
  minimalityPlan: unknown;
};

export type PlannerMinimalityIntegrationIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
  itemName?: string;
};

export type PlannerMinimalityExecutionBinding = {
  bindingVersion: "1";
  proposalHash: string;
  implementationContractHash: string;
  implementationAuditHash: string;
  intelligenceHash: string;
  minimalityPolicyHash: string;
  minimalityPlanHash: string;
  minimalityReceiptHash: string;
  minimalityBaselineHash: string;
  taskSeedExecutionBindingHash: string;
  bindingHash: string;
};

export type RunPlannerMinimalityBoundCoderFlowInput<T> = Omit<
  RunTaskToSeedBoundCoderFlowInput<T>,
  "contract" | "maxExpansionAttempts" | "requiredIntelligenceHash"
> & {
  taskId: string;
  objectiveHash: string;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  authorityHash: string;
  policyHash: string;
  proposalLimits: BoundedPlannerProposalLimits;
  minimalityPolicy: PreventiveMinimalityPolicy;
  allowedChangeFiles: readonly string[];
  plannerMinimalityProvider: (
    context: PlannerMinimalityProviderContext
  ) => Promise<unknown>;
};

export type PlannerMinimalityBoundCoderFlowResult<T> = {
  decision:
    | "planner_minimality_task_completed"
    | "planner_minimality_task_stopped"
    | "planner_minimality_task_invalid";
  route: "coder_executed" | "replan_required" | "human_review_required";
  issues: readonly PlannerMinimalityIntegrationIssue[];
  proposal: BoundedPlannerProposal | null;
  implementationContract: TaskToSeedImplementationContract | null;
  implementationAudit: TaskToSeedImplementationAuditReceipt | null;
  minimalityResult: EvaluatePreventiveMinimalityResult | null;
  taskSeedResult: TaskToSeedBoundCoderFlowResult<T> | null;
  executionBinding: PlannerMinimalityExecutionBinding | null;
  summary: {
    plannerProviderCallCount: 0 | 1;
    proposalReady: boolean;
    preMinimalityAuditCallCount: 0 | 1;
    implementationAuditReady: boolean;
    minimalityGateCallCount: 0 | 1;
    minimalityReady: boolean;
    policyBypassed: boolean;
    taskSeedFlowCallCount: 0 | 1;
    coderProviderCallCount: number;
    contextRequestProviderCallCount: number;
    executionBindingBuilt: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessedByIntegration: false;
  };
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: { field?: string; filePath?: string; itemName?: string } = {}
): PlannerMinimalityIntegrationIssue {
  return { code, message, severity, ...extra };
}

function normalizeRequest(input: {
  taskId: string;
  objectiveHash: string;
  authorityHash: string;
  policyHash: string;
  acceptanceContractHash: string;
  proposalLimits: BoundedPlannerProposalLimits;
  allowedChangeFiles: readonly string[];
  forbiddenFiles?: readonly string[];
}): {
  limits: BoundedPlannerProposalLimits;
  allowedChangeFiles: readonly string[];
  forbiddenFiles: readonly string[];
} {
  if (!IDENTIFIER.test(input.taskId)) throw new TypeError("taskId is invalid.");
  for (const [field, value] of [
    ["objectiveHash", input.objectiveHash],
    ["authorityHash", input.authorityHash],
    ["policyHash", input.policyHash],
    ["acceptanceContractHash", input.acceptanceContractHash]
  ] as const) {
    if (!HASH.test(value)) throw new TypeError(`${field} must be a sha256 hash.`);
  }
  if (
    input.proposalLimits === null ||
    typeof input.proposalLimits !== "object" ||
    Array.isArray(input.proposalLimits) ||
    Object.keys(input.proposalLimits).sort().join(",") !==
      "maxExpansionAttempts,maxRequiredSymbols,maxRequiredTests,maxSeedFiles"
  ) {
    throw new TypeError("proposalLimits must contain the exact bounded planner limit fields.");
  }
  const boundedInteger = (value: number, minimum: number, maximum: number, field: string): number => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${field} is outside its permitted range.`);
    }
    return value;
  };
  const maxExpansionAttempts = boundedInteger(
    input.proposalLimits.maxExpansionAttempts,
    1,
    2,
    "maxExpansionAttempts"
  );
  const limits = deepFreeze({
    maxSeedFiles: boundedInteger(input.proposalLimits.maxSeedFiles, 1, 100, "maxSeedFiles"),
    maxRequiredSymbols: boundedInteger(
      input.proposalLimits.maxRequiredSymbols,
      0,
      500,
      "maxRequiredSymbols"
    ),
    maxRequiredTests: boundedInteger(
      input.proposalLimits.maxRequiredTests,
      0,
      500,
      "maxRequiredTests"
    ),
    maxExpansionAttempts: maxExpansionAttempts as 1 | 2
  });
  const normalizePath = (value: unknown, field: string): string => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4_096 ||
      value.trim() !== value ||
      CONTROL.test(value) ||
      value.startsWith("/") ||
      value.startsWith("\\") ||
      WINDOWS_DRIVE.test(value)
    ) {
      throw new TypeError(`${field} contains an invalid repository path.`);
    }
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.split("/").includes("..")
    ) {
      throw new TypeError(`${field} contains a repository path escape.`);
    }
    return normalized;
  };
  const normalizePaths = (values: readonly string[], field: string): string[] => {
    if (!Array.isArray(values) || values.length > 1_000) {
      throw new TypeError(`${field} exceeds its bounded count.`);
    }
    const normalized = values.map((entry) => normalizePath(entry, field));
    if (new Set(normalized).size !== normalized.length) {
      throw new TypeError(`${field} must not contain duplicates.`);
    }
    return normalized.sort((left, right) => left.localeCompare(right));
  };
  const allowedChangeFiles = normalizePaths(input.allowedChangeFiles, "allowedChangeFiles");
  const forbiddenFiles = normalizePaths(input.forbiddenFiles ?? [], "forbiddenFiles");
  if (allowedChangeFiles.length === 0) {
    throw new TypeError("allowedChangeFiles must contain at least one path.");
  }
  const forbidden = new Set(forbiddenFiles);
  if (allowedChangeFiles.some((entry) => forbidden.has(entry))) {
    throw new TypeError("allowedChangeFiles and forbiddenFiles must not overlap.");
  }
  return deepFreeze({ limits, allowedChangeFiles, forbiddenFiles });
}

function normalizeProviderOutput(value: unknown): PlannerMinimalityProviderOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Planner-minimality provider output must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Planner-minimality provider output must be a plain object.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Planner-minimality provider output must not contain symbol properties.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== "minimalityPlan" || keys[1] !== "proposal") {
    throw new TypeError("Planner-minimality provider output must contain exactly proposal and minimalityPlan.");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError("Planner-minimality provider output must not contain accessors.");
    }
  }
  const record = value as Record<string, unknown>;
  return { proposal: record.proposal, minimalityPlan: record.minimalityPlan };
}

function bindingMaterial(
  binding: Omit<PlannerMinimalityExecutionBinding, "bindingHash">
): Record<string, unknown> {
  return {
    bindingVersion: binding.bindingVersion,
    proposalHash: binding.proposalHash,
    implementationContractHash: binding.implementationContractHash,
    implementationAuditHash: binding.implementationAuditHash,
    intelligenceHash: binding.intelligenceHash,
    minimalityPolicyHash: binding.minimalityPolicyHash,
    minimalityPlanHash: binding.minimalityPlanHash,
    minimalityReceiptHash: binding.minimalityReceiptHash,
    minimalityBaselineHash: binding.minimalityBaselineHash,
    taskSeedExecutionBindingHash: binding.taskSeedExecutionBindingHash
  };
}

export function verifyPlannerMinimalityExecutionBinding(
  binding: PlannerMinimalityExecutionBinding
): boolean {
  try {
    if (binding.bindingVersion !== PLANNER_MINIMALITY_EXECUTION_BINDING_VERSION) return false;
    const { bindingHash, ...withoutHash } = binding;
    return HASH.test(bindingHash) && bindingHash === hashCanonicalJson(bindingMaterial(withoutHash));
  } catch {
    return false;
  }
}

function emptySummary(): PlannerMinimalityBoundCoderFlowResult<unknown>["summary"] {
  return {
    plannerProviderCallCount: 0,
    proposalReady: false,
    preMinimalityAuditCallCount: 0,
    implementationAuditReady: false,
    minimalityGateCallCount: 0,
    minimalityReady: false,
    policyBypassed: false,
    taskSeedFlowCallCount: 0,
    coderProviderCallCount: 0,
    contextRequestProviderCallCount: 0,
    executionBindingBuilt: false,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessedByIntegration: false
  };
}

function plannerIssues(
  entries: readonly { code: string; message: string; severity: "error" | "review"; field?: string; filePath?: string }[]
): PlannerMinimalityIntegrationIssue[] {
  return entries.map((entry) => issue(entry.code, entry.message, entry.severity, {
    ...(entry.field === undefined ? {} : { field: entry.field }),
    ...(entry.filePath === undefined ? {} : { filePath: entry.filePath })
  }));
}

function minimalityIssues(
  result: EvaluatePreventiveMinimalityResult
): PlannerMinimalityIntegrationIssue[] {
  return result.issues.map((entry) => issue(
    entry.code,
    entry.message,
    entry.action === "stop_invalid" ? "error" : "review",
    {
      ...(entry.field === undefined ? {} : { field: entry.field }),
      ...(entry.filePath === undefined ? {} : { filePath: entry.filePath }),
      ...(entry.itemName === undefined ? {} : { itemName: entry.itemName })
    }
  ));
}

export async function runPlannerMinimalityBoundCoderFlow<T>(
  input: RunPlannerMinimalityBoundCoderFlowInput<T>
): Promise<PlannerMinimalityBoundCoderFlowResult<T>> {
  const summary = emptySummary();
  if (!input.authorityPresent || !input.policyPresent) {
    return deepFreeze({
      decision: "planner_minimality_task_invalid",
      route: "human_review_required",
      issues: [issue(
        "planner_minimality_authority_or_policy_missing",
        "Authority and policy must be present before the planner-minimality provider is called.",
        "error"
      )],
      proposal: null,
      implementationContract: null,
      implementationAudit: null,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  if (!verifyPreventiveMinimalityPolicy(input.minimalityPolicy)) {
    return deepFreeze({
      decision: "planner_minimality_task_invalid",
      route: "human_review_required",
      issues: [issue(
        "planner_minimality_policy_invalid",
        "Preventive minimality policy integrity verification failed before provider execution.",
        "error"
      )],
      proposal: null,
      implementationContract: null,
      implementationAudit: null,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }

  let normalizedRequest: ReturnType<typeof normalizeRequest>;
  try {
    normalizedRequest = normalizeRequest({
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      authorityHash: input.authorityHash,
      policyHash: input.policyHash,
      acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      proposalLimits: input.proposalLimits,
      allowedChangeFiles: input.allowedChangeFiles,
      forbiddenFiles: input.forbiddenFiles
    });
  } catch (error) {
    return deepFreeze({
      decision: "planner_minimality_task_invalid",
      route: "human_review_required",
      issues: [issue(
        "planner_minimality_request_invalid",
        error instanceof Error ? error.message : "Planner-minimality request is invalid.",
        "error"
      )],
      proposal: null,
      implementationContract: null,
      implementationAudit: null,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }

  let providerOutput: PlannerMinimalityProviderOutput;
  summary.plannerProviderCallCount = 1;
  try {
    providerOutput = normalizeProviderOutput(await input.plannerMinimalityProvider({
      version: PLANNER_MINIMALITY_INTEGRATION_VERSION,
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      authorityHash: input.authorityHash,
      policyHash: input.policyHash,
      limits: normalizedRequest.limits,
      allowedChangeFiles: normalizedRequest.allowedChangeFiles,
      forbiddenFiles: normalizedRequest.forbiddenFiles,
      minimalityPolicy: input.minimalityPolicy,
      taskContext: input.taskContext
    }));
  } catch (error) {
    return deepFreeze({
      decision: "planner_minimality_task_stopped",
      route: "replan_required",
      issues: [issue(
        "planner_minimality_provider_failed",
        error instanceof Error ? error.message : "Planner-minimality provider failed.",
        "review"
      )],
      proposal: null,
      implementationContract: null,
      implementationAudit: null,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }

  const validation = validateBoundedPlannerProposal({
    rawProposal: providerOutput.proposal,
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    authorityHash: input.authorityHash,
    policyHash: input.policyHash,
    limits: normalizedRequest.limits,
    forbiddenFiles: normalizedRequest.forbiddenFiles
  });
  if (
    validation.decision !== "planner_proposal_ready" ||
    validation.proposal === null ||
    validation.implementationContract === null
  ) {
    return deepFreeze({
      decision: validation.decision === "planner_proposal_invalid"
        ? "planner_minimality_task_invalid"
        : "planner_minimality_task_stopped",
      route: validation.decision === "planner_proposal_invalid"
        ? "human_review_required"
        : "replan_required",
      issues: plannerIssues(validation.issues),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: null,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  summary.proposalReady = true;

  summary.preMinimalityAuditCallCount = 1;
  const auditResult = await auditTaskToSeedImplementationContract({
    repositoryPath: input.repositoryPath,
    contract: validation.implementationContract,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    intelligenceLimits: input.intelligenceLimits
  });
  if (
    auditResult.decision !== "implementation_contract_ready" ||
    auditResult.audit === null
  ) {
    return deepFreeze({
      decision: auditResult.decision === "implementation_contract_invalid"
        ? "planner_minimality_task_invalid"
        : "planner_minimality_task_stopped",
      route: auditResult.decision === "implementation_contract_invalid"
        ? "human_review_required"
        : "replan_required",
      issues: plannerIssues(auditResult.issues),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  summary.implementationAuditReady = true;

  let minimalityPlan;
  try {
    minimalityPlan = createPreventiveMinimalityPlan({
      rawPlan: providerOutput.minimalityPlan,
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      plannerProposalHash: validation.proposal.proposalHash,
      intelligenceHash: auditResult.audit.intelligenceHash,
      policyHash: input.minimalityPolicy.policyHash
    });
  } catch (error) {
    return deepFreeze({
      decision: "planner_minimality_task_invalid",
      route: "human_review_required",
      issues: [issue(
        "planner_minimality_plan_invalid",
        error instanceof Error ? error.message : "Planner minimality plan is invalid.",
        "error"
      )],
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult: null,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }

  summary.minimalityGateCallCount = 1;
  const minimalityResult = await evaluatePreventiveMinimalityPlan({
    repositoryPath: input.repositoryPath,
    expectedTaskId: input.taskId,
    expectedObjectiveHash: input.objectiveHash,
    expectedPlannerProposalHash: validation.proposal.proposalHash,
    expectedIntelligenceHash: auditResult.audit.intelligenceHash,
    policy: input.minimalityPolicy,
    plan: minimalityPlan,
    allowedFiles: normalizedRequest.allowedChangeFiles,
    forbiddenFiles: normalizedRequest.forbiddenFiles
  });
  if (
    minimalityResult.decision === "minimality_plan_invalid" ||
    minimalityResult.receipt === null ||
    minimalityResult.baseline === null
  ) {
    return deepFreeze({
      decision: "planner_minimality_task_invalid",
      route: "human_review_required",
      issues: minimalityIssues(minimalityResult),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  summary.policyBypassed = minimalityResult.route === "policy_bypassed";
  if (minimalityResult.route === "request_planner_revision") {
    return deepFreeze({
      decision: "planner_minimality_task_stopped",
      route: "replan_required",
      issues: minimalityIssues(minimalityResult),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  if (minimalityResult.route === "human_review") {
    return deepFreeze({
      decision: "planner_minimality_task_stopped",
      route: "human_review_required",
      issues: minimalityIssues(minimalityResult),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult,
      taskSeedResult: null,
      executionBinding: null,
      summary
    });
  }
  summary.minimalityReady = true;

  summary.taskSeedFlowCallCount = 1;
  const taskSeedResult = await runTaskToSeedBoundCoderFlow({
    repositoryPath: input.repositoryPath,
    contract: validation.implementationContract,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    taskContext: {
      plannerProposalHash: validation.proposal.proposalHash,
      minimality: {
        decision: minimalityResult.decision,
        route: minimalityResult.route,
        policyHash: input.minimalityPolicy.policyHash,
        planHash: minimalityPlan.planHash,
        dependencyInventoryHash: minimalityResult.receipt.dependencyInventoryHash,
        baselineHash: minimalityResult.baseline.baselineHash,
        receiptHash: minimalityResult.receipt.receiptHash
      },
      taskContext: input.taskContext
    },
    initialEvidence: input.initialEvidence,
    forbiddenFiles: normalizedRequest.forbiddenFiles,
    authorityPresent: input.authorityPresent,
    policyPresent: input.policyPresent,
    hardTotalBudgetTokens: input.hardTotalBudgetTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    maxExpansionAttempts: validation.proposal.maxExpansionAttempts,
    maxContextFileBytes: input.maxContextFileBytes,
    maxContextTotalBytes: input.maxContextTotalBytes,
    intelligenceLimits: input.intelligenceLimits,
    requiredIntelligenceHash: auditResult.audit.intelligenceHash,
    contextRequestProvider: input.contextRequestProvider,
    coderProvider: input.coderProvider
  });
  summary.coderProviderCallCount = taskSeedResult.summary.coderProviderCallCount;
  summary.contextRequestProviderCallCount = taskSeedResult.summary.contextRequestProviderCallCount;
  if (
    taskSeedResult.decision !== "task_seed_coder_completed" ||
    taskSeedResult.route !== "coder_executed" ||
    taskSeedResult.executionBinding === null
  ) {
    return deepFreeze({
      decision: taskSeedResult.decision === "task_seed_coder_invalid"
        ? "planner_minimality_task_invalid"
        : "planner_minimality_task_stopped",
      route: taskSeedResult.route,
      issues: plannerIssues(taskSeedResult.issues),
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      implementationAudit: auditResult.audit,
      minimalityResult,
      taskSeedResult,
      executionBinding: null,
      summary
    });
  }

  const withoutHash: Omit<PlannerMinimalityExecutionBinding, "bindingHash"> = {
    bindingVersion: PLANNER_MINIMALITY_EXECUTION_BINDING_VERSION,
    proposalHash: validation.proposal.proposalHash,
    implementationContractHash: validation.implementationContract.contractHash,
    implementationAuditHash: auditResult.audit.auditHash,
    intelligenceHash: auditResult.audit.intelligenceHash,
    minimalityPolicyHash: input.minimalityPolicy.policyHash,
    minimalityPlanHash: minimalityPlan.planHash,
    minimalityReceiptHash: minimalityResult.receipt.receiptHash,
    minimalityBaselineHash: minimalityResult.baseline.baselineHash,
    taskSeedExecutionBindingHash: taskSeedResult.executionBinding.executionBindingHash
  };
  const executionBinding = deepFreeze({
    ...withoutHash,
    bindingHash: hashCanonicalJson(bindingMaterial(withoutHash))
  });
  summary.executionBindingBuilt = true;

  return deepFreeze({
    decision: "planner_minimality_task_completed",
    route: "coder_executed",
    issues: [],
    proposal: validation.proposal,
    implementationContract: validation.implementationContract,
    implementationAudit: auditResult.audit,
    minimalityResult,
    taskSeedResult,
    executionBinding,
    summary
  });
}
