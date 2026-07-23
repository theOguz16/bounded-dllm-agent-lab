import { hashCanonicalJson } from "./agent-event-ledger.js";
import type { AcceptanceCriteriaContract } from "./acceptance-criteria-contract.js";
import {
  createTaskToSeedImplementationContract,
  runTaskToSeedBoundCoderFlow,
  type RunTaskToSeedBoundCoderFlowInput,
  type TaskToSeedBoundCoderFlowResult,
  type TaskToSeedImplementationContract
} from "./task-to-seed-implementation-contract.js";

export const BOUNDED_PLANNER_PROPOSAL_VERSION = "1" as const;
export const BOUNDED_PLANNER_EXECUTION_BINDING_VERSION = "1" as const;

export type BoundedPlannerSeedRationale = {
  path: string;
  reasonHash: string;
};

export type BoundedPlannerProposal = {
  proposalVersion: "1";
  taskId: string;
  objectiveHash: string;
  acceptanceContractHash: string;
  authorityHash: string;
  policyHash: string;
  seedFiles: readonly string[];
  seedRationales: readonly BoundedPlannerSeedRationale[];
  requiredSymbols: readonly string[];
  requiredTestFiles: readonly string[];
  maxExpansionAttempts: 1 | 2;
  proposalHash: string;
};

export type BoundedPlannerProposalLimits = {
  maxSeedFiles: number;
  maxRequiredSymbols: number;
  maxRequiredTests: number;
  maxExpansionAttempts: 1 | 2;
};

export type BoundedPlannerProposalIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
};

export type BoundedPlannerProposalDecision =
  | "planner_proposal_ready"
  | "planner_proposal_blocked"
  | "planner_proposal_invalid";

export type BoundedPlannerProposalValidationResult = {
  decision: BoundedPlannerProposalDecision;
  proposal: BoundedPlannerProposal | null;
  implementationContract: TaskToSeedImplementationContract | null;
  issues: readonly BoundedPlannerProposalIssue[];
  summary: {
    proposalIntegrityVerified: boolean;
    identityMatched: boolean;
    authorityMatched: boolean;
    policyMatched: boolean;
    scopeWithinLimits: boolean;
    forbiddenFileConflictCount: number;
    seedCount: number;
    requiredSymbolCount: number;
    requiredTestCount: number;
  };
};

export type BoundedPlannerExecutionBinding = {
  bindingVersion: "1";
  proposalHash: string;
  implementationContractHash: string;
  taskSeedExecutionBindingHash: string;
  bindingHash: string;
};

export type RunBoundedPlannerTaskFlowInput<T> = Omit<
  RunTaskToSeedBoundCoderFlowInput<T>,
  "contract" | "maxExpansionAttempts"
> & {
  taskId: string;
  objectiveHash: string;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  authorityHash: string;
  policyHash: string;
  proposalLimits: BoundedPlannerProposalLimits;
  plannerProvider: (context: {
    version: "1";
    taskId: string;
    objectiveHash: string;
    acceptanceContractHash: string;
    authorityHash: string;
    policyHash: string;
    limits: BoundedPlannerProposalLimits;
    forbiddenFiles: readonly string[];
    taskContext: unknown;
  }) => Promise<unknown>;
};

export type BoundedPlannerTaskFlowResult<T> = {
  decision:
    | "planner_task_completed"
    | "planner_task_stopped"
    | "planner_task_invalid";
  route: "coder_executed" | "replan_required" | "human_review_required";
  issues: readonly BoundedPlannerProposalIssue[];
  proposal: BoundedPlannerProposal | null;
  implementationContract: TaskToSeedImplementationContract | null;
  taskSeedResult: TaskToSeedBoundCoderFlowResult<T> | null;
  executionBinding: BoundedPlannerExecutionBinding | null;
  summary: {
    plannerProviderCallCount: 0 | 1;
    proposalReady: boolean;
    taskSeedFlowCallCount: 0 | 1;
    coderProviderCallCount: number;
    contextRequestProviderCallCount: number;
    executionBindingBuilt: boolean;
  };
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MAX_PATH_LENGTH = 4096;
const MAX_SYMBOL_LENGTH = 256;

class PlannerProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly filePath?: string
  ) {
    super(message);
  }
}

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
  extra: { field?: string; filePath?: string } = {}
): BoundedPlannerProposalIssue {
  return { code, message, severity, ...extra };
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlannerProposalError(
      "planner_proposal_object_invalid",
      `${label} must be a plain object.`
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PlannerProposalError(
      "planner_proposal_object_invalid",
      `${label} must be a plain object.`
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new PlannerProposalError(
      "planner_proposal_symbol_property",
      `${label} must not contain symbol properties.`
    );
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new PlannerProposalError(
        "planner_proposal_accessor_property",
        `${label} must not contain accessors.`
      );
    }
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new PlannerProposalError(
        "planner_proposal_unknown_field",
        `${label} contains an unknown field.`,
        key
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new PlannerProposalError(
        "planner_proposal_missing_field",
        `${label} is missing a required field.`,
        key
      );
    }
  }
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new PlannerProposalError(
      "planner_proposal_hash_invalid",
      `${field} must be a sha256 hash.`,
      field
    );
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new PlannerProposalError(
      "planner_proposal_identifier_invalid",
      `${field} must be a bounded identifier.`,
      field
    );
  }
  return value;
}

function normalizePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.trim() !== value ||
    CONTROL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new PlannerProposalError(
      "planner_proposal_path_invalid",
      `${field} must contain safe repository-relative paths.`,
      field
    );
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new PlannerProposalError(
      "planner_proposal_path_escape",
      `${field} must not escape the repository.`,
      field,
      normalized
    );
  }
  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizePathArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new PlannerProposalError(
      "planner_proposal_path_count_invalid",
      `${field} must contain between ${minimum} and ${maximum} entries.`,
      field
    );
  }
  const normalized = value.map((entry) => normalizePath(entry, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new PlannerProposalError(
      "planner_proposal_duplicate_path",
      `${field} must not contain duplicates.`,
      field
    );
  }
  return uniqueSorted(normalized);
}

function normalizeSymbols(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PlannerProposalError(
      "planner_proposal_symbol_count_invalid",
      `requiredSymbols must contain at most ${maximum} entries.`,
      "requiredSymbols"
    );
  }
  const normalized = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.trim().length > MAX_SYMBOL_LENGTH ||
      CONTROL.test(entry)
    ) {
      throw new PlannerProposalError(
        "planner_proposal_symbol_invalid",
        "requiredSymbols must contain bounded non-empty strings.",
        "requiredSymbols"
      );
    }
    return entry.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new PlannerProposalError(
      "planner_proposal_duplicate_symbol",
      "requiredSymbols must not contain duplicates.",
      "requiredSymbols"
    );
  }
  return uniqueSorted(normalized);
}

function normalizeLimits(value: BoundedPlannerProposalLimits): BoundedPlannerProposalLimits {
  const record = requirePlainObject(value, "Planner proposal limits");
  requireExactFields(
    record,
    ["maxSeedFiles", "maxRequiredSymbols", "maxRequiredTests", "maxExpansionAttempts"],
    ["maxSeedFiles", "maxRequiredSymbols", "maxRequiredTests", "maxExpansionAttempts"],
    "Planner proposal limits"
  );
  const integer = (entry: unknown, field: string, minimum: number, maximum: number): number => {
    if (!Number.isInteger(entry) || (entry as number) < minimum || (entry as number) > maximum) {
      throw new PlannerProposalError(
        "planner_proposal_limit_invalid",
        `${field} must be an integer between ${minimum} and ${maximum}.`,
        field
      );
    }
    return entry as number;
  };
  const maxExpansionAttempts = integer(record.maxExpansionAttempts, "maxExpansionAttempts", 1, 2);
  return deepFreeze({
    maxSeedFiles: integer(record.maxSeedFiles, "maxSeedFiles", 1, 100),
    maxRequiredSymbols: integer(record.maxRequiredSymbols, "maxRequiredSymbols", 0, 500),
    maxRequiredTests: integer(record.maxRequiredTests, "maxRequiredTests", 0, 500),
    maxExpansionAttempts: maxExpansionAttempts as 1 | 2
  });
}

function normalizeSeedRationales(
  value: unknown,
  seedFiles: readonly string[]
): BoundedPlannerSeedRationale[] {
  if (!Array.isArray(value) || value.length !== seedFiles.length) {
    throw new PlannerProposalError(
      "planner_proposal_seed_rationale_count_invalid",
      "seedRationales must contain exactly one entry per seed file.",
      "seedRationales"
    );
  }
  const normalized = value.map((entry) => {
    const record = requirePlainObject(entry, "Seed rationale");
    requireExactFields(record, ["path", "reasonHash"], ["path", "reasonHash"], "Seed rationale");
    return {
      path: normalizePath(record.path, "seedRationales.path"),
      reasonHash: requireHash(record.reasonHash, "seedRationales.reasonHash")
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const rationalePaths = normalized.map((entry) => entry.path);
  if (
    rationalePaths.length !== seedFiles.length ||
    rationalePaths.some((path, index) => path !== seedFiles[index])
  ) {
    throw new PlannerProposalError(
      "planner_proposal_seed_rationale_mismatch",
      "Seed rationale paths must match seedFiles exactly.",
      "seedRationales"
    );
  }
  return normalized;
}

function proposalMaterial(
  proposal: Omit<BoundedPlannerProposal, "proposalHash">
): Record<string, unknown> {
  return {
    proposalVersion: proposal.proposalVersion,
    taskId: proposal.taskId,
    objectiveHash: proposal.objectiveHash,
    acceptanceContractHash: proposal.acceptanceContractHash,
    authorityHash: proposal.authorityHash,
    policyHash: proposal.policyHash,
    seedFiles: proposal.seedFiles,
    seedRationales: proposal.seedRationales,
    requiredSymbols: proposal.requiredSymbols,
    requiredTestFiles: proposal.requiredTestFiles,
    maxExpansionAttempts: proposal.maxExpansionAttempts
  };
}

export function createBoundedPlannerProposal(input: {
  rawProposal: unknown;
  expectedTaskId: string;
  expectedObjectiveHash: string;
  expectedAcceptanceContractHash: string;
  expectedAuthorityHash: string;
  expectedPolicyHash: string;
  limits: BoundedPlannerProposalLimits;
}): BoundedPlannerProposal {
  const limits = normalizeLimits(input.limits);
  const record = requirePlainObject(input.rawProposal, "Planner proposal");
  requireExactFields(
    record,
    [
      "proposalVersion",
      "taskId",
      "objectiveHash",
      "acceptanceContractHash",
      "authorityHash",
      "policyHash",
      "seedFiles",
      "seedRationales",
      "requiredSymbols",
      "requiredTestFiles",
      "maxExpansionAttempts",
      "proposalHash"
    ],
    [
      "proposalVersion",
      "taskId",
      "objectiveHash",
      "acceptanceContractHash",
      "authorityHash",
      "policyHash",
      "seedFiles",
      "seedRationales",
      "requiredSymbols",
      "requiredTestFiles",
      "maxExpansionAttempts",
      "proposalHash"
    ],
    "Planner proposal"
  );
  if (record.proposalVersion !== BOUNDED_PLANNER_PROPOSAL_VERSION) {
    throw new PlannerProposalError(
      "planner_proposal_version_invalid",
      "proposalVersion must be 1.",
      "proposalVersion"
    );
  }
  const taskId = requireIdentifier(record.taskId, "taskId");
  const objectiveHash = requireHash(record.objectiveHash, "objectiveHash");
  const acceptanceContractHash = requireHash(record.acceptanceContractHash, "acceptanceContractHash");
  const authorityHash = requireHash(record.authorityHash, "authorityHash");
  const policyHash = requireHash(record.policyHash, "policyHash");
  if (
    taskId !== input.expectedTaskId ||
    objectiveHash !== input.expectedObjectiveHash ||
    acceptanceContractHash !== input.expectedAcceptanceContractHash
  ) {
    throw new PlannerProposalError(
      "planner_proposal_identity_mismatch",
      "Planner proposal task, objective, and acceptance identity must match the request."
    );
  }
  if (authorityHash !== input.expectedAuthorityHash) {
    throw new PlannerProposalError(
      "planner_proposal_authority_mismatch",
      "Planner proposal authority hash must match the authorized request.",
      "authorityHash"
    );
  }
  if (policyHash !== input.expectedPolicyHash) {
    throw new PlannerProposalError(
      "planner_proposal_policy_mismatch",
      "Planner proposal policy hash must match the active policy.",
      "policyHash"
    );
  }
  const seedFiles = normalizePathArray(record.seedFiles, "seedFiles", 1, limits.maxSeedFiles);
  const requiredSymbols = normalizeSymbols(record.requiredSymbols, limits.maxRequiredSymbols);
  const requiredTestFiles = normalizePathArray(
    record.requiredTestFiles,
    "requiredTestFiles",
    0,
    limits.maxRequiredTests
  );
  const seedRationales = normalizeSeedRationales(record.seedRationales, seedFiles);
  if (
    record.maxExpansionAttempts !== 1 &&
    record.maxExpansionAttempts !== 2
  ) {
    throw new PlannerProposalError(
      "planner_proposal_expansion_attempts_invalid",
      "maxExpansionAttempts must be 1 or 2.",
      "maxExpansionAttempts"
    );
  }
  if (record.maxExpansionAttempts > limits.maxExpansionAttempts) {
    throw new PlannerProposalError(
      "planner_proposal_expansion_budget_exceeded",
      "Planner proposal exceeds the permitted expansion-attempt budget.",
      "maxExpansionAttempts"
    );
  }
  const withoutHash: Omit<BoundedPlannerProposal, "proposalHash"> = {
    proposalVersion: BOUNDED_PLANNER_PROPOSAL_VERSION,
    taskId,
    objectiveHash,
    acceptanceContractHash,
    authorityHash,
    policyHash,
    seedFiles,
    seedRationales,
    requiredSymbols,
    requiredTestFiles,
    maxExpansionAttempts: record.maxExpansionAttempts
  };
  const proposalHash = requireHash(record.proposalHash, "proposalHash");
  if (proposalHash !== hashCanonicalJson(proposalMaterial(withoutHash))) {
    throw new PlannerProposalError(
      "planner_proposal_integrity_invalid",
      "Planner proposal hash verification failed.",
      "proposalHash"
    );
  }
  return deepFreeze({ ...withoutHash, proposalHash });
}

export function verifyBoundedPlannerProposal(proposal: BoundedPlannerProposal): boolean {
  try {
    const { proposalHash, ...withoutHash } = proposal;
    return (
      proposal.proposalVersion === BOUNDED_PLANNER_PROPOSAL_VERSION &&
      HASH.test(proposalHash) &&
      proposalHash === hashCanonicalJson(proposalMaterial(withoutHash))
    );
  } catch {
    return false;
  }
}

function validationSummary(): BoundedPlannerProposalValidationResult["summary"] {
  return {
    proposalIntegrityVerified: false,
    identityMatched: false,
    authorityMatched: false,
    policyMatched: false,
    scopeWithinLimits: false,
    forbiddenFileConflictCount: 0,
    seedCount: 0,
    requiredSymbolCount: 0,
    requiredTestCount: 0
  };
}

export function validateBoundedPlannerProposal(input: {
  rawProposal: unknown;
  taskId: string;
  objectiveHash: string;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  authorityHash: string;
  policyHash: string;
  limits: BoundedPlannerProposalLimits;
  forbiddenFiles?: readonly string[];
}): BoundedPlannerProposalValidationResult {
  const summary = validationSummary();
  let proposal: BoundedPlannerProposal;
  try {
    proposal = createBoundedPlannerProposal({
      rawProposal: input.rawProposal,
      expectedTaskId: input.taskId,
      expectedObjectiveHash: input.objectiveHash,
      expectedAcceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      expectedAuthorityHash: input.authorityHash,
      expectedPolicyHash: input.policyHash,
      limits: input.limits
    });
    summary.proposalIntegrityVerified = verifyBoundedPlannerProposal(proposal);
    summary.identityMatched = true;
    summary.authorityMatched = true;
    summary.policyMatched = true;
    summary.scopeWithinLimits = true;
    summary.seedCount = proposal.seedFiles.length;
    summary.requiredSymbolCount = proposal.requiredSymbols.length;
    summary.requiredTestCount = proposal.requiredTestFiles.length;
  } catch (error) {
    return deepFreeze({
      decision: "planner_proposal_invalid",
      proposal: null,
      implementationContract: null,
      issues: [issue(
        error instanceof PlannerProposalError ? error.code : "planner_proposal_invalid",
        error instanceof Error ? error.message : "Planner proposal is invalid.",
        "error",
        error instanceof PlannerProposalError
          ? {
              ...(error.field === undefined ? {} : { field: error.field }),
              ...(error.filePath === undefined ? {} : { filePath: error.filePath })
            }
          : {}
      )],
      summary
    });
  }

  const forbidden = new Set(
    (input.forbiddenFiles ?? []).map((entry) => normalizePath(entry, "forbiddenFiles"))
  );
  const conflicts = uniqueSorted([
    ...proposal.seedFiles.filter((path) => forbidden.has(path)),
    ...proposal.requiredTestFiles.filter((path) => forbidden.has(path))
  ]);
  summary.forbiddenFileConflictCount = conflicts.length;
  if (conflicts.length > 0) {
    return deepFreeze({
      decision: "planner_proposal_blocked",
      proposal,
      implementationContract: null,
      issues: conflicts.map((filePath) => issue(
        "planner_proposal_forbidden_file_conflict",
        "Planner proposal includes a forbidden repository path.",
        "review",
        { filePath }
      )),
      summary
    });
  }

  try {
    const implementationContract = createTaskToSeedImplementationContract({
      taskId: proposal.taskId,
      objectiveHash: proposal.objectiveHash,
      seedFiles: proposal.seedFiles,
      requiredSymbols: proposal.requiredSymbols,
      requiredTestFiles: proposal.requiredTestFiles,
      acceptanceCriteriaContract: input.acceptanceCriteriaContract
    });
    return deepFreeze({
      decision: "planner_proposal_ready",
      proposal,
      implementationContract,
      issues: [],
      summary
    });
  } catch (error) {
    return deepFreeze({
      decision: "planner_proposal_invalid",
      proposal,
      implementationContract: null,
      issues: [issue(
        "planner_implementation_contract_invalid",
        error instanceof Error ? error.message : "Implementation contract could not be created.",
        "error"
      )],
      summary
    });
  }
}

function executionBindingMaterial(
  binding: Omit<BoundedPlannerExecutionBinding, "bindingHash">
): Record<string, unknown> {
  return {
    bindingVersion: binding.bindingVersion,
    proposalHash: binding.proposalHash,
    implementationContractHash: binding.implementationContractHash,
    taskSeedExecutionBindingHash: binding.taskSeedExecutionBindingHash
  };
}

export function verifyBoundedPlannerExecutionBinding(
  binding: BoundedPlannerExecutionBinding
): boolean {
  try {
    if (binding.bindingVersion !== BOUNDED_PLANNER_EXECUTION_BINDING_VERSION) return false;
    const { bindingHash, ...withoutHash } = binding;
    return bindingHash === hashCanonicalJson(executionBindingMaterial(withoutHash));
  } catch {
    return false;
  }
}

export async function runBoundedPlannerTaskFlow<T>(
  input: RunBoundedPlannerTaskFlowInput<T>
): Promise<BoundedPlannerTaskFlowResult<T>> {
  const emptySummary = {
    plannerProviderCallCount: 0 as 0 | 1,
    proposalReady: false,
    taskSeedFlowCallCount: 0 as 0 | 1,
    coderProviderCallCount: 0,
    contextRequestProviderCallCount: 0,
    executionBindingBuilt: false
  };
  if (!input.authorityPresent || !input.policyPresent) {
    return deepFreeze({
      decision: "planner_task_invalid",
      route: "human_review_required",
      issues: [issue(
        "planner_authority_or_policy_missing",
        "Authority and policy must be present before the planner provider is called.",
        "error"
      )],
      proposal: null,
      implementationContract: null,
      taskSeedResult: null,
      executionBinding: null,
      summary: emptySummary
    });
  }

  let rawProposal: unknown;
  emptySummary.plannerProviderCallCount = 1;
  try {
    rawProposal = await input.plannerProvider({
      version: BOUNDED_PLANNER_PROPOSAL_VERSION,
      taskId: input.taskId,
      objectiveHash: input.objectiveHash,
      acceptanceContractHash: input.acceptanceCriteriaContract.contractHash,
      authorityHash: input.authorityHash,
      policyHash: input.policyHash,
      limits: normalizeLimits(input.proposalLimits),
      forbiddenFiles: input.forbiddenFiles ?? [],
      taskContext: input.taskContext
    });
  } catch (error) {
    return deepFreeze({
      decision: "planner_task_stopped",
      route: "replan_required",
      issues: [issue(
        "planner_provider_failed",
        error instanceof Error ? error.message : "Planner provider failed.",
        "review"
      )],
      proposal: null,
      implementationContract: null,
      taskSeedResult: null,
      executionBinding: null,
      summary: emptySummary
    });
  }

  const validation = validateBoundedPlannerProposal({
    rawProposal,
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    authorityHash: input.authorityHash,
    policyHash: input.policyHash,
    limits: input.proposalLimits,
    forbiddenFiles: input.forbiddenFiles
  });
  if (
    validation.decision !== "planner_proposal_ready" ||
    validation.proposal === null ||
    validation.implementationContract === null
  ) {
    return deepFreeze({
      decision: validation.decision === "planner_proposal_invalid"
        ? "planner_task_invalid"
        : "planner_task_stopped",
      route: validation.decision === "planner_proposal_invalid"
        ? "human_review_required"
        : "replan_required",
      issues: validation.issues,
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      taskSeedResult: null,
      executionBinding: null,
      summary: emptySummary
    });
  }

  emptySummary.proposalReady = true;
  emptySummary.taskSeedFlowCallCount = 1;
  const taskSeedResult = await runTaskToSeedBoundCoderFlow({
    repositoryPath: input.repositoryPath,
    contract: validation.implementationContract,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    taskContext: {
      plannerProposalHash: validation.proposal.proposalHash,
      taskContext: input.taskContext
    },
    initialEvidence: input.initialEvidence,
    forbiddenFiles: input.forbiddenFiles,
    authorityPresent: input.authorityPresent,
    policyPresent: input.policyPresent,
    hardTotalBudgetTokens: input.hardTotalBudgetTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    maxExpansionAttempts: validation.proposal.maxExpansionAttempts,
    maxContextFileBytes: input.maxContextFileBytes,
    maxContextTotalBytes: input.maxContextTotalBytes,
    intelligenceLimits: input.intelligenceLimits,
    contextRequestProvider: input.contextRequestProvider,
    coderProvider: input.coderProvider
  });
  emptySummary.coderProviderCallCount = taskSeedResult.summary.coderProviderCallCount;
  emptySummary.contextRequestProviderCallCount = taskSeedResult.summary.contextRequestProviderCallCount;

  if (
    taskSeedResult.decision !== "task_seed_coder_completed" ||
    taskSeedResult.route !== "coder_executed" ||
    taskSeedResult.executionBinding === null
  ) {
    return deepFreeze({
      decision: taskSeedResult.decision === "task_seed_coder_invalid"
        ? "planner_task_invalid"
        : "planner_task_stopped",
      route: taskSeedResult.route,
      issues: taskSeedResult.issues,
      proposal: validation.proposal,
      implementationContract: validation.implementationContract,
      taskSeedResult,
      executionBinding: null,
      summary: emptySummary
    });
  }

  const withoutHash: Omit<BoundedPlannerExecutionBinding, "bindingHash"> = {
    bindingVersion: BOUNDED_PLANNER_EXECUTION_BINDING_VERSION,
    proposalHash: validation.proposal.proposalHash,
    implementationContractHash: validation.implementationContract.contractHash,
    taskSeedExecutionBindingHash: taskSeedResult.executionBinding.executionBindingHash
  };
  const executionBinding = deepFreeze({
    ...withoutHash,
    bindingHash: hashCanonicalJson(executionBindingMaterial(withoutHash))
  });
  emptySummary.executionBindingBuilt = true;

  return deepFreeze({
    decision: "planner_task_completed",
    route: "coder_executed",
    issues: [],
    proposal: validation.proposal,
    implementationContract: validation.implementationContract,
    taskSeedResult,
    executionBinding,
    summary: emptySummary
  });
}
