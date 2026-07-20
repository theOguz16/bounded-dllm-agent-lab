import {
  createContextExpansionRequest,
  type ContextExpansionRequest
} from "./context-sufficiency-contract.js";
import {
  resolveContextExpansion,
  type ContextExpansionResolution
} from "./context-expansion-resolver.js";
import {
  executeCoderWithContextGate,
  type CoderContextExecutionIssue,
  type CoderContextExecutionResult,
  type CoderProviderContext,
  type InitialCoderContextEvidence
} from "./coder-context-execution-gate.js";

export const ADAPTIVE_CONTEXT_ORCHESTRATOR_VERSION = "1" as const;

export type AdaptiveContextFlowDecision =
  | "adaptive_coder_completed"
  | "adaptive_coder_stopped"
  | "adaptive_context_invalid";

export type AdaptiveContextFlowRoute =
  | "coder_executed"
  | "replan_required"
  | "human_review_required";

export type AdaptiveContextFlowIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  attempt?: number;
  filePath?: string;
  field?: string;
};

export type AdaptiveContextRequestState = {
  version: "1";
  attempt: number;
  remainingAttempts: number;
  baseContext: unknown;
  requiredSourceFiles: readonly string[];
  requiredTestFiles: readonly string[];
  requiredSymbols: readonly string[];
  visibleEvidence: readonly {
    path: string;
    source: string;
    contentHash: string;
    matchedSymbols: readonly string[];
  }[];
  gateIssues: readonly CoderContextExecutionIssue[];
  previouslyRequestedFiles: readonly string[];
};

export type AdaptiveScopeApprovalState = {
  attempt: number;
  request: ContextExpansionRequest;
  allowedContextFiles: readonly string[];
};

export type AdaptiveExpansionTrace = {
  attempt: number;
  request: ContextExpansionRequest;
  scopeExpansionApproved: boolean;
  resolutionDecision: ContextExpansionResolution["decision"];
  requestedFiles: readonly string[];
  loadedFiles: readonly string[];
  missingFiles: readonly string[];
  unresolvedSymbols: readonly string[];
  estimatedTokens: number;
};

export type RunAdaptiveCoderContextFlowInput<T> = {
  repositoryPath: string;
  baseContext: unknown;
  initialEvidence?: readonly InitialCoderContextEvidence[];
  requiredSourceFiles: readonly string[];
  requiredTestFiles?: readonly string[];
  requiredSymbols?: readonly string[];
  authorityPresent: boolean;
  policyPresent: boolean;
  allowedContextFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
  hardTotalBudgetTokens: number;
  reservedOutputTokens?: number;
  maxExpansionAttempts?: 1 | 2;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  contextRequestProvider: (
    state: AdaptiveContextRequestState
  ) => Promise<unknown>;
  scopeExpansionApprovalProvider?: (
    state: AdaptiveScopeApprovalState
  ) => Promise<boolean>;
  coderProvider: (
    context: CoderProviderContext
  ) => Promise<T>;
};

export type AdaptiveCoderContextFlowResult<T> = {
  decision: AdaptiveContextFlowDecision;
  route: AdaptiveContextFlowRoute;
  issues: readonly AdaptiveContextFlowIssue[];
  coderResult: CoderContextExecutionResult<T> | null;
  traces: readonly AdaptiveExpansionTrace[];
  summary: {
    expansionAttemptCount: number;
    contextRequestProviderCallCount: number;
    scopeApprovalProviderCallCount: number;
    resolverCallCount: number;
    coderProviderCallCount: number;
    requestedFileCount: number;
    loadedExpansionFileCount: number;
  };
};

const EXPANDABLE_GATE_ISSUES = new Set([
  "required_source_context_missing",
  "required_test_context_missing",
  "required_symbol_context_missing"
]);

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: {
    attempt?: number;
    filePath?: string;
    field?: string;
  } = {}
): AdaptiveContextFlowIssue {
  return {
    code,
    message,
    severity,
    ...extra
  };
}

function normalizeRequestedPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function summarize<T>(
  traces: readonly AdaptiveExpansionTrace[],
  requestCalls: number,
  approvalCalls: number,
  resolverCalls: number,
  coderResult: CoderContextExecutionResult<T> | null,
  requestedFiles: ReadonlySet<string>
): AdaptiveCoderContextFlowResult<T>["summary"] {
  return {
    expansionAttemptCount: traces.length,
    contextRequestProviderCallCount: requestCalls,
    scopeApprovalProviderCallCount: approvalCalls,
    resolverCallCount: resolverCalls,
    coderProviderCallCount:
      coderResult?.summary.providerCallCount ?? 0,
    requestedFileCount: requestedFiles.size,
    loadedExpansionFileCount: traces.reduce(
      (total, trace) => total + trace.loadedFiles.length,
      0
    )
  };
}

function finish<T>(
  decision: AdaptiveContextFlowDecision,
  route: AdaptiveContextFlowRoute,
  issues: readonly AdaptiveContextFlowIssue[],
  coderResult: CoderContextExecutionResult<T> | null,
  traces: readonly AdaptiveExpansionTrace[],
  requestCalls: number,
  approvalCalls: number,
  resolverCalls: number,
  requestedFiles: ReadonlySet<string>
): AdaptiveCoderContextFlowResult<T> {
  return {
    decision,
    route,
    issues,
    coderResult,
    traces,
    summary: summarize(
      traces,
      requestCalls,
      approvalCalls,
      resolverCalls,
      coderResult,
      requestedFiles
    )
  };
}

function gateIssues(
  issues: readonly CoderContextExecutionIssue[]
): AdaptiveContextFlowIssue[] {
  return issues.map((entry) => ({
    code: entry.code,
    message: entry.message,
    severity: entry.severity,
    ...(entry.filePath === undefined
      ? {}
      : { filePath: entry.filePath }),
    ...(entry.field === undefined
      ? {}
      : { field: entry.field })
  }));
}

function canExpand(
  result: CoderContextExecutionResult<unknown>
): boolean {
  return (
    result.route === "replan_required" &&
    result.issues.length > 0 &&
    result.issues.every((entry) =>
      EXPANDABLE_GATE_ISSUES.has(entry.code)
    )
  );
}

function visibleEvidenceState(
  evidence: readonly InitialCoderContextEvidence[]
): AdaptiveContextRequestState["visibleEvidence"] {
  return evidence.map((entry) => ({
    path: entry.path,
    source: entry.source,
    contentHash: entry.contentHash,
    matchedSymbols: entry.matchedSymbols
  }));
}

function mergeExpansionEvidence(
  accumulated: InitialCoderContextEvidence[],
  resolution: ContextExpansionResolution
): void {
  if (
    resolution.decision !== "context_expansion_ready" ||
    resolution.packet === null
  ) {
    return;
  }

  const existing = new Set(
    accumulated.map((entry) => entry.path)
  );

  for (const entry of resolution.packet.entries) {
    if (!existing.has(entry.path)) {
      accumulated.push(entry);
      existing.add(entry.path);
    }
  }
}

export async function runAdaptiveCoderContextFlow<T>(
  input: RunAdaptiveCoderContextFlowInput<T>
): Promise<AdaptiveCoderContextFlowResult<T>> {
  const traces: AdaptiveExpansionTrace[] = [];
  const requestedFiles = new Set<string>();
  let requestCalls = 0;
  let approvalCalls = 0;
  let resolverCalls = 0;

  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.contextRequestProvider !== "function" ||
    typeof input.coderProvider !== "function"
  ) {
    return finish(
      "adaptive_context_invalid",
      "human_review_required",
      [
        issue(
          "adaptive_context_input_invalid",
          "Adaptive context flow input and providers must be valid.",
          "error"
        )
      ],
      null,
      traces,
      requestCalls,
      approvalCalls,
      resolverCalls,
      requestedFiles
    );
  }

  const maxExpansionAttempts =
    input.maxExpansionAttempts ?? 2;

  if (
    !Number.isInteger(maxExpansionAttempts) ||
    maxExpansionAttempts < 1 ||
    maxExpansionAttempts > 2
  ) {
    return finish(
      "adaptive_context_invalid",
      "human_review_required",
      [
        issue(
          "adaptive_expansion_limit_invalid",
          "maxExpansionAttempts must be 1 or 2.",
          "error",
          { field: "maxExpansionAttempts" }
        )
      ],
      null,
      traces,
      requestCalls,
      approvalCalls,
      resolverCalls,
      requestedFiles
    );
  }

  const accumulatedEvidence:
    InitialCoderContextEvidence[] = [
    ...(input.initialEvidence ?? [])
  ];

  let pendingResolution:
    ContextExpansionResolution | null = null;

  while (true) {
    const coderResult =
      await executeCoderWithContextGate({
        baseContext: input.baseContext,
        initialEvidence: accumulatedEvidence,
        expansionResolution: pendingResolution,
        requiredSourceFiles:
          input.requiredSourceFiles,
        requiredTestFiles:
          input.requiredTestFiles,
        requiredSymbols:
          input.requiredSymbols,
        authorityPresent:
          input.authorityPresent,
        policyPresent:
          input.policyPresent,
        hardTotalBudgetTokens:
          input.hardTotalBudgetTokens,
        reservedOutputTokens:
          input.reservedOutputTokens,
        provider: input.coderProvider
      });

    if (coderResult.route === "coder_executed") {
      return finish(
        "adaptive_coder_completed",
        "coder_executed",
        [],
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    if (
      coderResult.route ===
      "human_review_required"
    ) {
      return finish(
        "adaptive_coder_stopped",
        "human_review_required",
        gateIssues(coderResult.issues),
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    if (pendingResolution !== null) {
      mergeExpansionEvidence(
        accumulatedEvidence,
        pendingResolution
      );

      pendingResolution = null;
    }

    if (!canExpand(coderResult)) {
      return finish(
        "adaptive_coder_stopped",
        "replan_required",
        gateIssues(coderResult.issues),
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    if (
      traces.length >=
      maxExpansionAttempts
    ) {
      return finish(
        "adaptive_coder_stopped",
        "replan_required",
        [
          ...gateIssues(
            coderResult.issues
          ),
          issue(
            "adaptive_context_expansion_limit_reached",
            "The maximum number of context expansion attempts was reached.",
            "review"
          )
        ],
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    const attempt =
      traces.length + 1;

    let rawRequest: unknown;

    try {
      requestCalls += 1;

      rawRequest =
        await input.contextRequestProvider({
          version:
            ADAPTIVE_CONTEXT_ORCHESTRATOR_VERSION,
          attempt,
          remainingAttempts:
            maxExpansionAttempts - attempt,
          baseContext:
            input.baseContext,
          requiredSourceFiles:
            input.requiredSourceFiles,
          requiredTestFiles:
            input.requiredTestFiles ?? [],
          requiredSymbols:
            input.requiredSymbols ?? [],
          visibleEvidence:
            visibleEvidenceState(
              accumulatedEvidence
            ),
          gateIssues:
            coderResult.issues,
          previouslyRequestedFiles:
            [...requestedFiles].sort()
        });
    } catch {
      return finish(
        "adaptive_coder_stopped",
        "human_review_required",
        [
          issue(
            "context_request_provider_failed",
            "The required context request provider failed.",
            "error",
            { attempt }
          )
        ],
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    let request:
      ContextExpansionRequest;

    try {
      request =
        createContextExpansionRequest(
          rawRequest as
            ContextExpansionRequest
        );
    } catch (error) {
      return finish(
        "adaptive_coder_stopped",
        "human_review_required",
        [
          issue(
            "context_request_provider_output_invalid",
            error instanceof Error
              ? error.message
              : "The context request provider returned invalid output.",
            "error",
            { attempt }
          )
        ],
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    if (
      request.requestedFiles.length === 0 &&
      request.requestedTests.length === 0
    ) {
      return finish(
        "adaptive_coder_stopped",
        "replan_required",
        [
          issue(
            "context_request_requires_explicit_paths",
            "Deterministic repository expansion requires at least one requested file or test path.",
            "review",
            { attempt }
          )
        ],
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    let scopeExpansionApproved = false;

    if (
      request.scopeExpansionRequested
    ) {
      if (
        typeof input
          .scopeExpansionApprovalProvider ===
        "function"
      ) {
        try {
          approvalCalls += 1;

          scopeExpansionApproved =
            await input
              .scopeExpansionApprovalProvider({
                attempt,
                request,
                allowedContextFiles:
                  input.allowedContextFiles ??
                  []
              });

          if (
            typeof scopeExpansionApproved !==
            "boolean"
          ) {
            throw new Error(
              "Approval result must be boolean."
            );
          }
        } catch {
          return finish(
            "adaptive_coder_stopped",
            "human_review_required",
            [
              issue(
                "scope_expansion_approval_provider_failed",
                "Scope expansion approval could not be resolved safely.",
                "error",
                { attempt }
              )
            ],
            coderResult,
            traces,
            requestCalls,
            approvalCalls,
            resolverCalls,
            requestedFiles
          );
        }
      }
    }

    resolverCalls += 1;

    const resolution =
      await resolveContextExpansion({
        repositoryPath:
          input.repositoryPath,
        request,
        expansionAttempt: attempt,
        allowedContextFiles:
          input.allowedContextFiles,
        forbiddenFiles:
          input.forbiddenFiles,
        previouslyRequestedFiles:
          [...requestedFiles],
        scopeExpansionApproved,
        hardBudgetTokens:
          request.maxAdditionalTokens,
        maxFileBytes:
          input.maxFileBytes,
        maxTotalBytes:
          input.maxTotalBytes
      });

    const normalizedRequestedFiles = [
      ...request.requestedFiles,
      ...request.requestedTests
    ].map(normalizeRequestedPath);

    for (
      const file of
      normalizedRequestedFiles
    ) {
      requestedFiles.add(file);
    }

    traces.push({
      attempt,
      request,
      scopeExpansionApproved,
      resolutionDecision:
        resolution.decision,
      requestedFiles: [
        ...new Set(
          normalizedRequestedFiles
        )
      ].sort(),
      loadedFiles:
        resolution.packet?.entries
          .map((entry) => entry.path)
          .sort() ?? [],
      missingFiles:
        resolution.packet
          ?.missingFiles ?? [],
      unresolvedSymbols:
        resolution.packet
          ?.unresolvedSymbols ?? [],
      estimatedTokens:
        resolution.packet
          ?.estimatedTokens ?? 0
    });

    if (
      resolution.decision ===
      "context_expansion_ready"
    ) {
      pendingResolution =
        resolution;

      continue;
    }

    if (
      resolution.decision ===
      "context_expansion_incomplete"
    ) {
      return finish(
        "adaptive_coder_stopped",
        "replan_required",
        resolution.issues.map(
          (entry) =>
            issue(
              entry.code,
              entry.message,
              entry.severity,
              {
                attempt,
                ...(entry.filePath ===
                undefined
                  ? {}
                  : {
                      filePath:
                        entry.filePath
                    }),
                ...(entry.field ===
                undefined
                  ? {}
                  : {
                      field:
                        entry.field
                    })
              }
            )
        ),
        coderResult,
        traces,
        requestCalls,
        approvalCalls,
        resolverCalls,
        requestedFiles
      );
    }

    return finish(
      "adaptive_coder_stopped",
      "human_review_required",
      resolution.issues.map(
        (entry) =>
          issue(
            entry.code,
            entry.message,
            entry.severity,
            {
              attempt,
              ...(entry.filePath ===
              undefined
                ? {}
                : {
                    filePath:
                      entry.filePath
                  }),
              ...(entry.field ===
              undefined
                ? {}
                : {
                    field:
                      entry.field
                  })
            }
          )
      ),
      coderResult,
      traces,
      requestCalls,
      approvalCalls,
      resolverCalls,
      requestedFiles
    );
  }
}
