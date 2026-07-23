import { createHash } from "node:crypto";
import {
  hashCanonicalJson
} from "./agent-event-ledger.js";
import {
  analyzeCanonicalRepository,
  verifyCanonicalRepoIntelligence,
  type CanonicalRepoFileFact,
  type CanonicalRepoIntelligence,
  type CanonicalRepoIntelligenceIssue
} from "./canonical-repo-intelligence.js";
import {
  runAdaptiveCoderContextFlow,
  type AdaptiveCoderContextFlowResult,
  type AdaptiveContextRequestState,
  type RunAdaptiveCoderContextFlowInput
} from "./adaptive-context-orchestrator.js";
import type {
  CoderProviderContext,
  InitialCoderContextEvidence
} from "./coder-context-execution-gate.js";

export const REPO_INTELLIGENCE_CONTEXT_BINDING_VERSION = "1" as const;

export type RepoIntelligenceContextBindingDecision =
  | "repo_context_binding_completed"
  | "repo_context_binding_stopped"
  | "repo_context_binding_invalid";

export type RepoIntelligenceContextBindingRoute =
  | "coder_executed"
  | "replan_required"
  | "human_review_required";

export type RepoIntelligenceContextBindingIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
};

export type RepoIntelligenceEvidenceBinding = {
  path: string;
  contentHash: string;
  byteLength: number;
  matchedSymbols: readonly string[];
};

export type RepoIntelligenceContextBindingReceipt = {
  bindingVersion: "1";
  intelligenceVersion: "1";
  intelligenceHash: string;
  repositoryIdentityHash: string;
  seedFiles: readonly string[];
  requiredSourceFiles: readonly string[];
  requiredTestFiles: readonly string[];
  requiredSymbols: readonly string[];
  allowedContextFiles: readonly string[];
  initialEvidence: readonly RepoIntelligenceEvidenceBinding[];
  bindingHash: string;
};

export type RepoIntelligenceBoundBaseContext = {
  version: "1";
  taskContext: unknown;
  repositoryIntelligence: {
    bindingHash: string;
    intelligenceHash: string;
    repositoryIdentityHash: string;
    seedFiles: readonly string[];
    dependencyClosure: readonly string[];
    dependencyEdges: CanonicalRepoIntelligence["dependencyEdges"];
    files: readonly {
      path: string;
      contentHash: string;
      imports: readonly string[];
      externalDependencies: readonly string[];
      exports: readonly string[];
      symbols: CanonicalRepoFileFact["symbols"];
    }[];
  };
};

export type RunRepoIntelligenceBoundCoderFlowInput<T> = {
  repositoryPath: string;
  seedFiles: readonly string[];
  baseContext: unknown;
  initialEvidence?: readonly InitialCoderContextEvidence[];
  requiredTestFiles?: readonly string[];
  requiredSymbols?: readonly string[];
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

export type RepoIntelligenceBoundCoderFlowResult<T> = {
  decision: RepoIntelligenceContextBindingDecision;
  route: RepoIntelligenceContextBindingRoute;
  issues: readonly RepoIntelligenceContextBindingIssue[];
  binding: RepoIntelligenceContextBindingReceipt | null;
  intelligence: CanonicalRepoIntelligence | null;
  adaptiveResult: AdaptiveCoderContextFlowResult<T> | null;
  summary: {
    intelligenceCallCount: 0 | 1;
    intelligenceReady: boolean;
    intelligenceVerified: boolean;
    bindingBuilt: boolean;
    bindingVerified: boolean;
    adaptiveFlowCallCount: 0 | 1;
    coderProviderCallCount: number;
    contextRequestProviderCallCount: number;
    requiredSourceCount: number;
    requiredTestCount: number;
    allowedContextFileCount: number;
    visibleEvidenceCount: number;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

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
    throw new Error(`${field} must contain safe repository-relative paths.`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`${field} must not escape the repository.`);
  }
  return normalized;
}

function normalizePaths(values: readonly string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  return uniqueSorted(values.map((value) => normalizePath(value, field)));
}

function normalizeSymbols(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error("requiredSymbols must be an array.");
  return uniqueSorted(values.map((value) => {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > 256 ||
      CONTROL.test(value)
    ) {
      throw new Error("requiredSymbols must contain safe non-empty strings.");
    }
    return value.trim();
  }));
}

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: { field?: string; filePath?: string } = {}
): RepoIntelligenceContextBindingIssue {
  return { code, message, severity, ...extra };
}

function fromIntelligenceIssue(
  value: CanonicalRepoIntelligenceIssue
): RepoIntelligenceContextBindingIssue {
  return {
    code: value.code,
    message: value.message,
    severity: value.severity,
    ...(value.field === undefined ? {} : { field: value.field }),
    ...(value.filePath === undefined ? {} : { filePath: value.filePath })
  };
}

function emptySummary(): RepoIntelligenceBoundCoderFlowResult<never>["summary"] {
  return {
    intelligenceCallCount: 0,
    intelligenceReady: false,
    intelligenceVerified: false,
    bindingBuilt: false,
    bindingVerified: false,
    adaptiveFlowCallCount: 0,
    coderProviderCallCount: 0,
    contextRequestProviderCallCount: 0,
    requiredSourceCount: 0,
    requiredTestCount: 0,
    allowedContextFileCount: 0,
    visibleEvidenceCount: 0,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function finish<T>(
  decision: RepoIntelligenceContextBindingDecision,
  route: RepoIntelligenceContextBindingRoute,
  issues: readonly RepoIntelligenceContextBindingIssue[],
  binding: RepoIntelligenceContextBindingReceipt | null,
  intelligence: CanonicalRepoIntelligence | null,
  adaptiveResult: AdaptiveCoderContextFlowResult<T> | null,
  summary: RepoIntelligenceBoundCoderFlowResult<T>["summary"]
): RepoIntelligenceBoundCoderFlowResult<T> {
  return deepFreeze({
    decision,
    route,
    issues,
    binding,
    intelligence,
    adaptiveResult,
    summary
  });
}

function receiptMaterial(
  receipt: Omit<RepoIntelligenceContextBindingReceipt, "bindingHash">
): Record<string, unknown> {
  return {
    bindingVersion: receipt.bindingVersion,
    intelligenceVersion: receipt.intelligenceVersion,
    intelligenceHash: receipt.intelligenceHash,
    repositoryIdentityHash: receipt.repositoryIdentityHash,
    seedFiles: receipt.seedFiles,
    requiredSourceFiles: receipt.requiredSourceFiles,
    requiredTestFiles: receipt.requiredTestFiles,
    requiredSymbols: receipt.requiredSymbols,
    allowedContextFiles: receipt.allowedContextFiles,
    initialEvidence: receipt.initialEvidence
  };
}

export function verifyRepoIntelligenceContextBinding(
  receipt: RepoIntelligenceContextBindingReceipt
): boolean {
  try {
    if (receipt.bindingVersion !== REPO_INTELLIGENCE_CONTEXT_BINDING_VERSION) return false;
    const { bindingHash, ...withoutHash } = receipt;
    return bindingHash === hashCanonicalJson(receiptMaterial(withoutHash));
  } catch {
    return false;
  }
}

function buildBinding(
  intelligence: CanonicalRepoIntelligence,
  requiredTestFiles: readonly string[],
  requiredSymbols: readonly string[],
  evidence: readonly InitialCoderContextEvidence[]
): RepoIntelligenceContextBindingReceipt {
  const requiredSourceFiles = uniqueSorted(intelligence.dependencyClosure);
  const allowedContextFiles = uniqueSorted([
    ...requiredSourceFiles,
    ...requiredTestFiles
  ]);
  const initialEvidence = [...evidence]
    .map((entry) => ({
      path: entry.path,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
      matchedSymbols: uniqueSorted(entry.matchedSymbols)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const withoutHash: Omit<RepoIntelligenceContextBindingReceipt, "bindingHash"> = {
    bindingVersion: REPO_INTELLIGENCE_CONTEXT_BINDING_VERSION,
    intelligenceVersion: intelligence.intelligenceVersion,
    intelligenceHash: intelligence.intelligenceHash,
    repositoryIdentityHash: intelligence.repositoryIdentityHash,
    seedFiles: uniqueSorted(intelligence.seedFiles),
    requiredSourceFiles,
    requiredTestFiles,
    requiredSymbols,
    allowedContextFiles,
    initialEvidence
  };
  return {
    ...withoutHash,
    bindingHash: hashCanonicalJson(receiptMaterial(withoutHash))
  };
}

function buildBoundBaseContext(
  taskContext: unknown,
  intelligence: CanonicalRepoIntelligence,
  binding: RepoIntelligenceContextBindingReceipt
): RepoIntelligenceBoundBaseContext {
  const closure = new Set(binding.requiredSourceFiles);
  const files = intelligence.scannedFiles
    .filter((file) => closure.has(file.path))
    .map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      imports: file.imports,
      externalDependencies: file.externalDependencies,
      exports: file.exports,
      symbols: file.symbols
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const dependencyEdges = intelligence.dependencyEdges.filter(
    (edge) => closure.has(edge.from) && closure.has(edge.to)
  );
  return deepFreeze({
    version: REPO_INTELLIGENCE_CONTEXT_BINDING_VERSION,
    taskContext,
    repositoryIntelligence: {
      bindingHash: binding.bindingHash,
      intelligenceHash: intelligence.intelligenceHash,
      repositoryIdentityHash: intelligence.repositoryIdentityHash,
      seedFiles: binding.seedFiles,
      dependencyClosure: binding.requiredSourceFiles,
      dependencyEdges,
      files
    }
  });
}

function verifyInitialEvidence(
  evidence: readonly InitialCoderContextEvidence[],
  fileFacts: ReadonlyMap<string, CanonicalRepoFileFact>,
  allowed: ReadonlySet<string>
): RepoIntelligenceContextBindingIssue[] {
  const issues: RepoIntelligenceContextBindingIssue[] = [];
  const seen = new Set<string>();
  for (const entry of evidence) {
    let normalized: string;
    try {
      normalized = normalizePath(entry.path, "initialEvidence.path");
    } catch (error) {
      issues.push(issue(
        "repo_context_evidence_path_invalid",
        error instanceof Error ? error.message : "Initial evidence path is invalid.",
        "error"
      ));
      continue;
    }
    if (seen.has(normalized)) {
      issues.push(issue(
        "repo_context_evidence_duplicate",
        "Initial evidence must not contain duplicate paths.",
        "error",
        { filePath: normalized }
      ));
      continue;
    }
    seen.add(normalized);
    if (!allowed.has(normalized)) {
      issues.push(issue(
        "repo_context_evidence_outside_intelligence",
        "Initial evidence is outside the intelligence-derived context boundary.",
        "error",
        { filePath: normalized }
      ));
      continue;
    }
    const fact = fileFacts.get(normalized);
    if (!fact) {
      issues.push(issue(
        "repo_context_evidence_file_unknown",
        "Initial evidence does not map to an intelligence file fact.",
        "error",
        { filePath: normalized }
      ));
      continue;
    }
    const bytes = Buffer.from(entry.content, "utf8");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (
      entry.contentHash !== fact.contentHash ||
      entry.contentHash !== hash ||
      entry.byteLength !== fact.bytes ||
      entry.byteLength !== bytes.length
    ) {
      issues.push(issue(
        "repo_context_evidence_content_mismatch",
        "Initial evidence bytes do not match the repository intelligence snapshot.",
        "error",
        { filePath: normalized }
      ));
    }
  }
  return issues;
}

function validateCompletedAdaptiveResult<T>(
  result: AdaptiveCoderContextFlowResult<T>,
  allowed: ReadonlySet<string>,
  fileFacts: ReadonlyMap<string, CanonicalRepoFileFact>
): RepoIntelligenceContextBindingIssue[] {
  if (
    result.decision !== "adaptive_coder_completed" ||
    result.route !== "coder_executed"
  ) {
    return [];
  }
  if (
    result.coderResult === null ||
    result.coderResult.context === null ||
    !result.coderResult.providerCalled
  ) {
    return [issue(
      "repo_context_completed_without_coder_context",
      "A completed adaptive result must contain one coder context and provider call.",
      "error"
    )];
  }
  const issues: RepoIntelligenceContextBindingIssue[] = [];
  for (const evidence of result.coderResult.context.evidence) {
    if (!allowed.has(evidence.path)) {
      issues.push(issue(
        "repo_context_coder_evidence_outside_boundary",
        "Coder context contains evidence outside the intelligence boundary.",
        "error",
        { filePath: evidence.path }
      ));
      continue;
    }
    const fact = fileFacts.get(evidence.path);
    if (!fact || fact.contentHash !== evidence.contentHash) {
      issues.push(issue(
        "repo_context_coder_evidence_hash_mismatch",
        "Coder context evidence does not match the intelligence snapshot.",
        "error",
        { filePath: evidence.path }
      ));
    }
  }
  return issues;
}

export async function runRepoIntelligenceBoundCoderFlow<T>(
  input: RunRepoIntelligenceBoundCoderFlowInput<T>
): Promise<RepoIntelligenceBoundCoderFlowResult<T>> {
  const summary = emptySummary();
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.contextRequestProvider !== "function" ||
    typeof input.coderProvider !== "function"
  ) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      [issue(
        "repo_context_binding_input_invalid",
        "Repository context binding input and providers must be valid.",
        "error"
      )],
      null,
      null,
      null,
      summary
    );
  }

  let requiredTestFiles: string[];
  let requiredSymbols: string[];
  let forbiddenFiles: string[];
  try {
    requiredTestFiles = normalizePaths(input.requiredTestFiles, "requiredTestFiles");
    requiredSymbols = normalizeSymbols(input.requiredSymbols);
    forbiddenFiles = normalizePaths(input.forbiddenFiles, "forbiddenFiles");
  } catch (error) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      [issue(
        "repo_context_binding_input_invalid",
        error instanceof Error ? error.message : "Repository context binding input is invalid.",
        "error"
      )],
      null,
      null,
      null,
      summary
    );
  }

  summary.intelligenceCallCount = 1;
  const intelligenceResult = await analyzeCanonicalRepository({
    repositoryPath: input.repositoryPath,
    seedFiles: input.seedFiles,
    ...input.intelligenceLimits
  });
  if (
    intelligenceResult.decision !== "repo_intelligence_ready" ||
    intelligenceResult.intelligence === null
  ) {
    return finish(
      intelligenceResult.decision === "repo_intelligence_invalid"
        ? "repo_context_binding_invalid"
        : "repo_context_binding_stopped",
      intelligenceResult.decision === "repo_intelligence_invalid"
        ? "human_review_required"
        : "replan_required",
      intelligenceResult.issues.map(fromIntelligenceIssue),
      null,
      intelligenceResult.intelligence,
      null,
      summary
    );
  }

  const intelligence = intelligenceResult.intelligence;
  summary.intelligenceReady = true;
  summary.intelligenceVerified = verifyCanonicalRepoIntelligence(intelligence);
  if (!summary.intelligenceVerified) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      [issue(
        "repo_intelligence_integrity_invalid",
        "Repository intelligence integrity verification failed.",
        "error"
      )],
      null,
      intelligence,
      null,
      summary
    );
  }

  const fileFacts = new Map(intelligence.scannedFiles.map((file) => [file.path, file]));
  const missingTests = requiredTestFiles.filter((file) => !fileFacts.has(file));
  if (missingTests.length > 0) {
    return finish(
      "repo_context_binding_stopped",
      "replan_required",
      missingTests.map((filePath) => issue(
        "required_test_not_in_intelligence",
        "A required test file was not discovered by repository intelligence.",
        "review",
        { filePath }
      )),
      null,
      intelligence,
      null,
      summary
    );
  }

  const allowedContextFiles = uniqueSorted([
    ...intelligence.dependencyClosure,
    ...requiredTestFiles
  ]);
  const allowed = new Set(allowedContextFiles);
  const overlap = forbiddenFiles.filter((file) => allowed.has(file));
  if (overlap.length > 0) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      overlap.map((filePath) => issue(
        "repo_context_allowed_forbidden_conflict",
        "A file cannot be both intelligence-allowed and forbidden.",
        "error",
        { filePath }
      )),
      null,
      intelligence,
      null,
      summary
    );
  }

  const initialEvidence = [...(input.initialEvidence ?? [])];
  const evidenceIssues = verifyInitialEvidence(initialEvidence, fileFacts, allowed);
  if (evidenceIssues.length > 0) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      evidenceIssues,
      null,
      intelligence,
      null,
      summary
    );
  }

  const binding = buildBinding(
    intelligence,
    requiredTestFiles,
    requiredSymbols,
    initialEvidence
  );
  summary.bindingBuilt = true;
  summary.bindingVerified = verifyRepoIntelligenceContextBinding(binding);
  summary.requiredSourceCount = binding.requiredSourceFiles.length;
  summary.requiredTestCount = binding.requiredTestFiles.length;
  summary.allowedContextFileCount = binding.allowedContextFiles.length;
  summary.visibleEvidenceCount = initialEvidence.length;
  if (!summary.bindingVerified) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      [issue(
        "repo_context_binding_integrity_invalid",
        "Repository context binding receipt failed integrity verification.",
        "error"
      )],
      binding,
      intelligence,
      null,
      summary
    );
  }

  const boundBaseContext = buildBoundBaseContext(input.baseContext, intelligence, binding);
  summary.adaptiveFlowCallCount = 1;
  let adaptiveResult: AdaptiveCoderContextFlowResult<T>;
  try {
    const adaptiveInput: RunAdaptiveCoderContextFlowInput<T> = {
      repositoryPath: input.repositoryPath,
      baseContext: boundBaseContext,
      initialEvidence,
      requiredSourceFiles: binding.requiredSourceFiles,
      requiredTestFiles: binding.requiredTestFiles,
      requiredSymbols: binding.requiredSymbols,
      authorityPresent: input.authorityPresent,
      policyPresent: input.policyPresent,
      allowedContextFiles: binding.allowedContextFiles,
      forbiddenFiles,
      hardTotalBudgetTokens: input.hardTotalBudgetTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      maxExpansionAttempts: input.maxExpansionAttempts,
      maxFileBytes: input.maxContextFileBytes,
      maxTotalBytes: input.maxContextTotalBytes,
      contextRequestProvider: input.contextRequestProvider,
      coderProvider: input.coderProvider
    };
    adaptiveResult = await runAdaptiveCoderContextFlow(adaptiveInput);
  } catch {
    return finish(
      "repo_context_binding_stopped",
      "human_review_required",
      [issue(
        "repo_context_adaptive_flow_failed",
        "The required adaptive context flow failed closed.",
        "error"
      )],
      binding,
      intelligence,
      null,
      summary
    );
  }

  summary.coderProviderCallCount = adaptiveResult.summary.coderProviderCallCount;
  summary.contextRequestProviderCallCount = adaptiveResult.summary.contextRequestProviderCallCount;
  const completionIssues = validateCompletedAdaptiveResult(adaptiveResult, allowed, fileFacts);
  if (completionIssues.length > 0) {
    return finish(
      "repo_context_binding_invalid",
      "human_review_required",
      completionIssues,
      binding,
      intelligence,
      adaptiveResult,
      summary
    );
  }

  if (
    adaptiveResult.decision === "adaptive_coder_completed" &&
    adaptiveResult.route === "coder_executed"
  ) {
    return finish(
      "repo_context_binding_completed",
      "coder_executed",
      [],
      binding,
      intelligence,
      adaptiveResult,
      summary
    );
  }

  return finish(
    adaptiveResult.decision === "adaptive_context_invalid"
      ? "repo_context_binding_invalid"
      : "repo_context_binding_stopped",
    adaptiveResult.route === "coder_executed"
      ? "human_review_required"
      : adaptiveResult.route,
    adaptiveResult.issues.map((entry) => issue(
      entry.code,
      entry.message,
      entry.severity,
      {
        ...(entry.field === undefined ? {} : { field: entry.field }),
        ...(entry.filePath === undefined ? {} : { filePath: entry.filePath })
      }
    )),
    binding,
    intelligence,
    adaptiveResult,
    summary
  );
}
