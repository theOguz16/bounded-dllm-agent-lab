import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  createAcceptanceCriteriaContract,
  type AcceptanceCriteriaContract
} from "./acceptance-criteria-contract.js";
import {
  analyzeCanonicalRepository,
  verifyCanonicalRepoIntelligence,
  type CanonicalRepoFileFact,
  type CanonicalRepoIntelligence
} from "./canonical-repo-intelligence.js";
import {
  runRepoIntelligenceBoundCoderFlow,
  type RepoIntelligenceBoundCoderFlowResult
} from "./repo-intelligence-context-binding.js";
import type {
  AdaptiveContextRequestState
} from "./adaptive-context-orchestrator.js";
import type {
  CoderProviderContext,
  InitialCoderContextEvidence
} from "./coder-context-execution-gate.js";

export const TASK_TO_SEED_IMPLEMENTATION_CONTRACT_VERSION = "1" as const;
export const TASK_TO_SEED_IMPLEMENTATION_AUDIT_VERSION = "1" as const;
export const TASK_TO_SEED_EXECUTION_BINDING_VERSION = "1" as const;

export type TaskToSeedImplementationContract = {
  contractVersion: "1";
  taskId: string;
  objectiveHash: string;
  seedFiles: readonly string[];
  requiredSymbols: readonly string[];
  requiredTestFiles: readonly string[];
  acceptanceContractHash: string;
  contractHash: string;
};

export type TaskToSeedImplementationContractInput = {
  taskId: string;
  objectiveHash: string;
  seedFiles: readonly string[];
  requiredSymbols?: readonly string[];
  requiredTestFiles?: readonly string[];
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
};

export type TaskToSeedImplementationAuditDecision =
  | "implementation_contract_ready"
  | "implementation_contract_blocked"
  | "implementation_contract_invalid";

export type TaskToSeedImplementationIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
  symbol?: string;
};

export type TaskToSeedSymbolBinding = {
  symbol: string;
  files: readonly string[];
};

export type TaskToSeedImplementationAuditReceipt = {
  auditVersion: "1";
  contractHash: string;
  acceptanceContractHash: string;
  intelligenceHash: string;
  repositoryIdentityHash: string;
  seedFiles: readonly string[];
  dependencyClosure: readonly string[];
  requiredTestFiles: readonly string[];
  symbolBindings: readonly TaskToSeedSymbolBinding[];
  auditHash: string;
};

export type TaskToSeedImplementationAuditResult = {
  decision: TaskToSeedImplementationAuditDecision;
  issues: readonly TaskToSeedImplementationIssue[];
  contract: TaskToSeedImplementationContract | null;
  intelligence: CanonicalRepoIntelligence | null;
  audit: TaskToSeedImplementationAuditReceipt | null;
  summary: {
    contractVerified: boolean;
    acceptanceContractVerified: boolean;
    intelligenceCallCount: 0 | 1;
    intelligenceReady: boolean;
    intelligenceVerified: boolean;
    seedFileCount: number;
    dependencyClosureCount: number;
    requiredSymbolCount: number;
    resolvedSymbolCount: number;
    requiredTestCount: number;
    resolvedTestCount: number;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type TaskToSeedExecutionBindingReceipt = {
  executionBindingVersion: "1";
  contractHash: string;
  auditHash: string;
  intelligenceHash: string;
  repoContextBindingHash: string;
  coderContextHash: string;
  executionBindingHash: string;
};

export type RunTaskToSeedBoundCoderFlowInput<T> = {
  repositoryPath: string;
  contract: TaskToSeedImplementationContract;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  taskContext: unknown;
  initialEvidence?: readonly InitialCoderContextEvidence[];
  forbiddenFiles?: readonly string[];
  authorityPresent: boolean;
  policyPresent: boolean;
  hardTotalBudgetTokens: number;
  reservedOutputTokens?: number;
  maxExpansionAttempts?: 1 | 2;
  maxContextFileBytes?: number;
  maxContextTotalBytes?: number;
  intelligenceLimits?: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxDependencyDepth?: number;
    maxEdges?: number;
  };
  contextRequestProvider: (
    state: AdaptiveContextRequestState
  ) => Promise<unknown>;
  coderProvider: (
    context: CoderProviderContext
  ) => Promise<T>;
};

export type TaskToSeedBoundCoderFlowDecision =
  | "task_seed_coder_completed"
  | "task_seed_coder_stopped"
  | "task_seed_coder_invalid";

export type TaskToSeedBoundCoderFlowResult<T> = {
  decision: TaskToSeedBoundCoderFlowDecision;
  route: "coder_executed" | "replan_required" | "human_review_required";
  issues: readonly TaskToSeedImplementationIssue[];
  audit: TaskToSeedImplementationAuditReceipt | null;
  repoResult: RepoIntelligenceBoundCoderFlowResult<T> | null;
  executionBinding: TaskToSeedExecutionBindingReceipt | null;
  summary: {
    auditReady: boolean;
    repoFlowCallCount: 0 | 1;
    coderProviderCallCount: number;
    contextRequestProviderCallCount: number;
    executionBindingBuilt: boolean;
  };
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MAX_PATHS = 1000;
const MAX_SYMBOLS = 1000;

class ImplementationContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string
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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImplementationContractError("implementation_contract_object_invalid", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ImplementationContractError("implementation_contract_object_invalid", `${label} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ImplementationContractError("implementation_contract_symbol_property", `${label} must not contain symbol properties.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new ImplementationContractError("implementation_contract_accessor_property", `${label} must not contain accessors.`);
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
      throw new ImplementationContractError("implementation_contract_unknown_field", `${label} contains an unknown field.`, key);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new ImplementationContractError("implementation_contract_missing_field", `${label} is missing a required field.`, key);
    }
  }
}

function normalizePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    CONTROL.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new ImplementationContractError("implementation_contract_path_invalid", `${field} must contain safe repository-relative paths.`, field);
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new ImplementationContractError("implementation_contract_path_escape", `${field} must not escape the repository.`, field);
  }
  return normalized;
}

function normalizePaths(
  value: unknown,
  field: string,
  minimum: number
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_PATHS) {
    throw new ImplementationContractError(
      "implementation_contract_path_count_invalid",
      `${field} must contain between ${minimum} and ${MAX_PATHS} entries.`,
      field
    );
  }
  return uniqueSorted(value.map((entry) => normalizePath(entry, field)));
}

function normalizeSymbols(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SYMBOLS) {
    throw new ImplementationContractError(
      "implementation_contract_symbol_count_invalid",
      `requiredSymbols must contain at most ${MAX_SYMBOLS} entries.`,
      "requiredSymbols"
    );
  }
  return uniqueSorted(value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.trim().length > 256 ||
      CONTROL.test(entry)
    ) {
      throw new ImplementationContractError(
        "implementation_contract_symbol_invalid",
        "requiredSymbols must contain bounded non-empty strings.",
        "requiredSymbols"
      );
    }
    return entry.trim();
  }));
}

function normalizeAcceptanceContract(
  contract: AcceptanceCriteriaContract
): AcceptanceCriteriaContract {
  const record = requirePlainObject(contract, "Acceptance criteria contract");
  requireExactFields(
    record,
    ["contractVersion", "taskId", "objectiveHash", "criteria", "contractHash"],
    ["contractVersion", "taskId", "objectiveHash", "criteria", "contractHash"],
    "Acceptance criteria contract"
  );
  const normalized = createAcceptanceCriteriaContract({
    taskId: record.taskId as string,
    objectiveHash: record.objectiveHash as string,
    criteria: record.criteria as AcceptanceCriteriaContract["criteria"]
  });
  if (normalized.contractHash !== record.contractHash) {
    throw new ImplementationContractError(
      "acceptance_contract_integrity_invalid",
      "Acceptance criteria contract integrity verification failed.",
      "acceptanceCriteriaContract"
    );
  }
  return normalized;
}

function contractMaterial(
  contract: Omit<TaskToSeedImplementationContract, "contractHash">
): Record<string, unknown> {
  return {
    contractVersion: contract.contractVersion,
    taskId: contract.taskId,
    objectiveHash: contract.objectiveHash,
    seedFiles: contract.seedFiles,
    requiredSymbols: contract.requiredSymbols,
    requiredTestFiles: contract.requiredTestFiles,
    acceptanceContractHash: contract.acceptanceContractHash
  };
}

export function createTaskToSeedImplementationContract(
  input: TaskToSeedImplementationContractInput
): TaskToSeedImplementationContract {
  const record = requirePlainObject(input, "Implementation contract input");
  requireExactFields(
    record,
    ["taskId", "objectiveHash", "seedFiles", "requiredSymbols", "requiredTestFiles", "acceptanceCriteriaContract"],
    ["taskId", "objectiveHash", "seedFiles", "acceptanceCriteriaContract"],
    "Implementation contract input"
  );
  if (typeof record.taskId !== "string" || !IDENTIFIER.test(record.taskId)) {
    throw new ImplementationContractError(
      "implementation_contract_task_id_invalid",
      "taskId must be a bounded identifier.",
      "taskId"
    );
  }
  if (typeof record.objectiveHash !== "string" || !HASH.test(record.objectiveHash)) {
    throw new ImplementationContractError(
      "implementation_contract_objective_hash_invalid",
      "objectiveHash must be a sha256 hash.",
      "objectiveHash"
    );
  }
  const acceptance = normalizeAcceptanceContract(
    record.acceptanceCriteriaContract as AcceptanceCriteriaContract
  );
  if (acceptance.taskId !== record.taskId || acceptance.objectiveHash !== record.objectiveHash) {
    throw new ImplementationContractError(
      "implementation_acceptance_identity_mismatch",
      "Acceptance criteria must bind to the same task and objective.",
      "acceptanceCriteriaContract"
    );
  }
  const withoutHash: Omit<TaskToSeedImplementationContract, "contractHash"> = {
    contractVersion: TASK_TO_SEED_IMPLEMENTATION_CONTRACT_VERSION,
    taskId: record.taskId,
    objectiveHash: record.objectiveHash,
    seedFiles: normalizePaths(record.seedFiles, "seedFiles", 1),
    requiredSymbols: normalizeSymbols(record.requiredSymbols ?? []),
    requiredTestFiles: normalizePaths(record.requiredTestFiles ?? [], "requiredTestFiles", 0),
    acceptanceContractHash: acceptance.contractHash
  };
  return deepFreeze({
    ...withoutHash,
    contractHash: hashCanonicalJson(contractMaterial(withoutHash))
  });
}

export function verifyTaskToSeedImplementationContract(
  contract: TaskToSeedImplementationContract,
  acceptanceCriteriaContract: AcceptanceCriteriaContract
): boolean {
  try {
    const normalized = createTaskToSeedImplementationContract({
      taskId: contract.taskId,
      objectiveHash: contract.objectiveHash,
      seedFiles: contract.seedFiles,
      requiredSymbols: contract.requiredSymbols,
      requiredTestFiles: contract.requiredTestFiles,
      acceptanceCriteriaContract
    });
    return normalized.contractHash === contract.contractHash;
  } catch {
    return false;
  }
}

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: { field?: string; filePath?: string; symbol?: string } = {}
): TaskToSeedImplementationIssue {
  return { code, message, severity, ...extra };
}

function emptyAuditSummary(): TaskToSeedImplementationAuditResult["summary"] {
  return {
    contractVerified: false,
    acceptanceContractVerified: false,
    intelligenceCallCount: 0,
    intelligenceReady: false,
    intelligenceVerified: false,
    seedFileCount: 0,
    dependencyClosureCount: 0,
    requiredSymbolCount: 0,
    resolvedSymbolCount: 0,
    requiredTestCount: 0,
    resolvedTestCount: 0,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function auditMaterial(
  audit: Omit<TaskToSeedImplementationAuditReceipt, "auditHash">
): Record<string, unknown> {
  return {
    auditVersion: audit.auditVersion,
    contractHash: audit.contractHash,
    acceptanceContractHash: audit.acceptanceContractHash,
    intelligenceHash: audit.intelligenceHash,
    repositoryIdentityHash: audit.repositoryIdentityHash,
    seedFiles: audit.seedFiles,
    dependencyClosure: audit.dependencyClosure,
    requiredTestFiles: audit.requiredTestFiles,
    symbolBindings: audit.symbolBindings
  };
}

export function verifyTaskToSeedImplementationAudit(
  audit: TaskToSeedImplementationAuditReceipt
): boolean {
  try {
    if (audit.auditVersion !== TASK_TO_SEED_IMPLEMENTATION_AUDIT_VERSION) return false;
    const { auditHash, ...withoutHash } = audit;
    return auditHash === hashCanonicalJson(auditMaterial(withoutHash));
  } catch {
    return false;
  }
}

function filesForSymbol(
  symbol: string,
  closure: ReadonlySet<string>,
  facts: readonly CanonicalRepoFileFact[]
): string[] {
  return uniqueSorted(
    facts
      .filter((file) => closure.has(file.path))
      .filter((file) =>
        file.symbols.some((entry) => entry.name === symbol) ||
        file.exports.includes(symbol)
      )
      .map((file) => file.path)
  );
}

export async function auditTaskToSeedImplementationContract(
  input: {
    repositoryPath: string;
    contract: TaskToSeedImplementationContract;
    acceptanceCriteriaContract: AcceptanceCriteriaContract;
    intelligenceLimits?: RunTaskToSeedBoundCoderFlowInput<unknown>["intelligenceLimits"];
  }
): Promise<TaskToSeedImplementationAuditResult> {
  const summary = emptyAuditSummary();
  let contract: TaskToSeedImplementationContract;
  let acceptance: AcceptanceCriteriaContract;
  try {
    acceptance = normalizeAcceptanceContract(input.acceptanceCriteriaContract);
    summary.acceptanceContractVerified = true;
    contract = createTaskToSeedImplementationContract({
      taskId: input.contract.taskId,
      objectiveHash: input.contract.objectiveHash,
      seedFiles: input.contract.seedFiles,
      requiredSymbols: input.contract.requiredSymbols,
      requiredTestFiles: input.contract.requiredTestFiles,
      acceptanceCriteriaContract: acceptance
    });
    if (contract.contractHash !== input.contract.contractHash) {
      throw new ImplementationContractError(
        "implementation_contract_integrity_invalid",
        "Implementation contract integrity verification failed."
      );
    }
    summary.contractVerified = true;
    summary.seedFileCount = contract.seedFiles.length;
    summary.requiredSymbolCount = contract.requiredSymbols.length;
    summary.requiredTestCount = contract.requiredTestFiles.length;
  } catch (error) {
    return deepFreeze({
      decision: "implementation_contract_invalid",
      issues: [issue(
        error instanceof ImplementationContractError ? error.code : "implementation_contract_invalid",
        error instanceof Error ? error.message : "Implementation contract is invalid.",
        "error",
        error instanceof ImplementationContractError && error.field ? { field: error.field } : {}
      )],
      contract: null,
      intelligence: null,
      audit: null,
      summary
    });
  }

  summary.intelligenceCallCount = 1;
  const intelligenceResult = await analyzeCanonicalRepository({
    repositoryPath: input.repositoryPath,
    seedFiles: contract.seedFiles,
    ...input.intelligenceLimits
  });
  if (
    intelligenceResult.decision !== "repo_intelligence_ready" ||
    intelligenceResult.intelligence === null
  ) {
    return deepFreeze({
      decision: intelligenceResult.decision === "repo_intelligence_invalid"
        ? "implementation_contract_invalid"
        : "implementation_contract_blocked",
      issues: intelligenceResult.issues.map((entry) => issue(
        entry.code,
        entry.message,
        entry.severity,
        {
          ...(entry.field === undefined ? {} : { field: entry.field }),
          ...(entry.filePath === undefined ? {} : { filePath: entry.filePath })
        }
      )),
      contract,
      intelligence: intelligenceResult.intelligence,
      audit: null,
      summary
    });
  }

  const intelligence = intelligenceResult.intelligence;
  summary.intelligenceReady = true;
  summary.intelligenceVerified = verifyCanonicalRepoIntelligence(intelligence);
  if (!summary.intelligenceVerified) {
    return deepFreeze({
      decision: "implementation_contract_invalid",
      issues: [issue(
        "implementation_intelligence_integrity_invalid",
        "Repository intelligence integrity verification failed.",
        "error"
      )],
      contract,
      intelligence,
      audit: null,
      summary
    });
  }

  const fileFacts = new Map(intelligence.scannedFiles.map((file) => [file.path, file]));
  const missingTests = contract.requiredTestFiles.filter((file) => !fileFacts.has(file));
  summary.resolvedTestCount = contract.requiredTestFiles.length - missingTests.length;
  const closure = new Set(intelligence.dependencyClosure);
  const symbolBindings = contract.requiredSymbols.map((symbol) => ({
    symbol,
    files: filesForSymbol(symbol, closure, intelligence.scannedFiles)
  }));
  const missingSymbols = symbolBindings.filter((binding) => binding.files.length === 0);
  summary.resolvedSymbolCount = symbolBindings.length - missingSymbols.length;
  summary.dependencyClosureCount = intelligence.dependencyClosure.length;

  const issues: TaskToSeedImplementationIssue[] = [
    ...missingTests.map((filePath) => issue(
      "implementation_required_test_missing",
      "A required test file was not discovered by repository intelligence.",
      "review",
      { filePath }
    )),
    ...missingSymbols.map((binding) => issue(
      "implementation_required_symbol_unresolved",
      "A required symbol was not found in the seed dependency closure.",
      "review",
      { symbol: binding.symbol }
    ))
  ];
  if (issues.length > 0) {
    return deepFreeze({
      decision: "implementation_contract_blocked",
      issues,
      contract,
      intelligence,
      audit: null,
      summary
    });
  }

  const withoutHash: Omit<TaskToSeedImplementationAuditReceipt, "auditHash"> = {
    auditVersion: TASK_TO_SEED_IMPLEMENTATION_AUDIT_VERSION,
    contractHash: contract.contractHash,
    acceptanceContractHash: contract.acceptanceContractHash,
    intelligenceHash: intelligence.intelligenceHash,
    repositoryIdentityHash: intelligence.repositoryIdentityHash,
    seedFiles: contract.seedFiles,
    dependencyClosure: intelligence.dependencyClosure,
    requiredTestFiles: contract.requiredTestFiles,
    symbolBindings
  };
  const audit = deepFreeze({
    ...withoutHash,
    auditHash: hashCanonicalJson(auditMaterial(withoutHash))
  });
  return deepFreeze({
    decision: "implementation_contract_ready",
    issues: [],
    contract,
    intelligence,
    audit,
    summary
  });
}

function executionMaterial(
  receipt: Omit<TaskToSeedExecutionBindingReceipt, "executionBindingHash">
): Record<string, unknown> {
  return {
    executionBindingVersion: receipt.executionBindingVersion,
    contractHash: receipt.contractHash,
    auditHash: receipt.auditHash,
    intelligenceHash: receipt.intelligenceHash,
    repoContextBindingHash: receipt.repoContextBindingHash,
    coderContextHash: receipt.coderContextHash
  };
}

export function verifyTaskToSeedExecutionBinding(
  receipt: TaskToSeedExecutionBindingReceipt
): boolean {
  try {
    if (receipt.executionBindingVersion !== TASK_TO_SEED_EXECUTION_BINDING_VERSION) return false;
    const { executionBindingHash, ...withoutHash } = receipt;
    return executionBindingHash === hashCanonicalJson(executionMaterial(withoutHash));
  } catch {
    return false;
  }
}

export async function runTaskToSeedBoundCoderFlow<T>(
  input: RunTaskToSeedBoundCoderFlowInput<T>
): Promise<TaskToSeedBoundCoderFlowResult<T>> {
  const auditResult = await auditTaskToSeedImplementationContract({
    repositoryPath: input.repositoryPath,
    contract: input.contract,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    intelligenceLimits: input.intelligenceLimits
  });
  if (auditResult.decision !== "implementation_contract_ready" || auditResult.audit === null) {
    return deepFreeze({
      decision: auditResult.decision === "implementation_contract_invalid"
        ? "task_seed_coder_invalid"
        : "task_seed_coder_stopped",
      route: auditResult.decision === "implementation_contract_invalid"
        ? "human_review_required"
        : "replan_required",
      issues: auditResult.issues,
      audit: auditResult.audit,
      repoResult: null,
      executionBinding: null,
      summary: {
        auditReady: false,
        repoFlowCallCount: 0,
        coderProviderCallCount: 0,
        contextRequestProviderCallCount: 0,
        executionBindingBuilt: false
      }
    });
  }

  const audit = auditResult.audit;
  const repoResult = await runRepoIntelligenceBoundCoderFlow({
    repositoryPath: input.repositoryPath,
    seedFiles: input.contract.seedFiles,
    baseContext: {
      version: TASK_TO_SEED_IMPLEMENTATION_CONTRACT_VERSION,
      taskContext: input.taskContext,
      implementationContract: {
        contractHash: input.contract.contractHash,
        auditHash: audit.auditHash,
        taskId: input.contract.taskId,
        objectiveHash: input.contract.objectiveHash,
        acceptanceContractHash: input.contract.acceptanceContractHash
      }
    },
    initialEvidence: input.initialEvidence,
    requiredTestFiles: input.contract.requiredTestFiles,
    requiredSymbols: input.contract.requiredSymbols,
    forbiddenFiles: input.forbiddenFiles,
    authorityPresent: input.authorityPresent,
    policyPresent: input.policyPresent,
    hardTotalBudgetTokens: input.hardTotalBudgetTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    maxExpansionAttempts: input.maxExpansionAttempts,
    maxContextFileBytes: input.maxContextFileBytes,
    maxContextTotalBytes: input.maxContextTotalBytes,
    requiredIntelligenceHash: audit.intelligenceHash,
    intelligenceLimits: input.intelligenceLimits,
    contextRequestProvider: input.contextRequestProvider,
    coderProvider: input.coderProvider
  });

  const summary = {
    auditReady: true,
    repoFlowCallCount: 1 as const,
    coderProviderCallCount: repoResult.summary.coderProviderCallCount,
    contextRequestProviderCallCount: repoResult.summary.contextRequestProviderCallCount,
    executionBindingBuilt: false
  };
  if (
    repoResult.decision !== "repo_context_binding_completed" ||
    repoResult.route !== "coder_executed" ||
    repoResult.binding === null ||
    repoResult.adaptiveResult?.coderResult?.context === null ||
    repoResult.adaptiveResult?.coderResult?.context === undefined
  ) {
    return deepFreeze({
      decision: repoResult.decision === "repo_context_binding_invalid"
        ? "task_seed_coder_invalid"
        : "task_seed_coder_stopped",
      route: repoResult.route,
      issues: repoResult.issues.map((entry) => issue(
        entry.code,
        entry.message,
        entry.severity,
        {
          ...(entry.field === undefined ? {} : { field: entry.field }),
          ...(entry.filePath === undefined ? {} : { filePath: entry.filePath })
        }
      )),
      audit,
      repoResult,
      executionBinding: null,
      summary
    });
  }

  const withoutHash: Omit<TaskToSeedExecutionBindingReceipt, "executionBindingHash"> = {
    executionBindingVersion: TASK_TO_SEED_EXECUTION_BINDING_VERSION,
    contractHash: input.contract.contractHash,
    auditHash: audit.auditHash,
    intelligenceHash: audit.intelligenceHash,
    repoContextBindingHash: repoResult.binding.bindingHash,
    coderContextHash: hashCanonicalJson(repoResult.adaptiveResult.coderResult.context)
  };
  const executionBinding = deepFreeze({
    ...withoutHash,
    executionBindingHash: hashCanonicalJson(executionMaterial(withoutHash))
  });
  summary.executionBindingBuilt = true;

  return deepFreeze({
    decision: "task_seed_coder_completed",
    route: "coder_executed",
    issues: [],
    audit,
    repoResult,
    executionBinding,
    summary
  });
}
