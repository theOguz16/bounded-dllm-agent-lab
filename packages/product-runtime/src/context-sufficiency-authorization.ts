import {
  hashCanonicalJson
} from "./agent-event-ledger.js";
import {
  computeGovernedMutationHash,
  deriveGovernedMutationChangedFiles
} from "./controlled-apply-handoff.js";
import {
  validateModelWorkspaceMutation
} from "./model-mutation-validator.js";
import type {
  AdaptiveCoderContextFlowResult
} from "./adaptive-context-orchestrator.js";
import type {
  WorkspaceMutation
} from "./workspace-mutation.js";

export const CONTEXT_SUFFICIENCY_AUTHORIZATION_VERSION =
  "1" as const;

export type ContextAuthorizationDecision =
  | "context_authorization_ready"
  | "context_authorization_blocked"
  | "context_authorization_invalid";

export type ContextAuthorizationRoute =
  | "context_authorized"
  | "replan_required"
  | "human_review_required";

export type ContextAuthorizationIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
};

export type ContextAuthorizationEvidenceBinding = {
  path: string;
  contentHash: string;
  origin:
    | "initial_context"
    | "context_expansion";
  source: string;
};

export type ContextSufficiencyAuthorizationReceipt = {
  authorizationVersion: "1";
  adaptiveFlowVersion: "1";
  adaptiveDecision:
    "adaptive_coder_completed";
  adaptiveRoute: "coder_executed";
  coderDecision:
    "coder_execution_completed";
  mutation: {
    changeKind: "coder_patch_draft";
    mutationHash: string;
    changedFiles: readonly string[];
  };
  context: {
    coderContextHash: string;
    adaptiveTraceHash: string;
    evidenceBindings:
      readonly ContextAuthorizationEvidenceBinding[];
    evidenceBindingHash: string;
  };
  budget: {
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    hardTotalBudgetTokens: number;
    remainingTokens: number;
  };
  expansion: {
    attemptCount: number;
    requestProviderCallCount: number;
    resolverCallCount: number;
    requestedFileCount: number;
    loadedExpansionFileCount: number;
  };
  preconditions: {
    adaptiveFlowCompleted: true;
    coderExecuted: true;
    coderProviderCalledExactlyOnce: true;
    mutationValidated: true;
    mutationIsPatchDraft: true;
    changedFilesVisibleToCoder: true;
    contextWithinHardBudget: true;
  };
  authorizationHash: string;
};

export type ContextAuthorizationResult = {
  decision: ContextAuthorizationDecision;
  route: ContextAuthorizationRoute;
  issues: readonly ContextAuthorizationIssue[];
  authorization:
    ContextSufficiencyAuthorizationReceipt | null;
  mutation: WorkspaceMutation | null;
  summary: {
    adaptiveFlowCompleted: boolean;
    coderExecuted: boolean;
    coderProviderCalledExactlyOnce: boolean;
    mutationValidated: boolean;
    mutationIsPatchDraft: boolean;
    changedFilesVisibleToCoder: boolean;
    contextWithinHardBudget: boolean;
    changedFileCount: number;
    visibleEvidenceCount: number;
  };
};

export type AuthorizeContextSufficientPatchInput = {
  adaptiveResult:
    AdaptiveCoderContextFlowResult<unknown>;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
};

export type ContextAuthorizationVerificationResult = {
  ok: boolean;
  errors: readonly string[];
  mutationHashMatched: boolean;
  changedFilesMatched: boolean;
  authorizationHashMatched: boolean;
};

export type ContextAuthorizedStageResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      code: string;
      message: string;
      route?:
        | "replan_required"
        | "human_review_required";
    };

export type RunContextAuthorizedDeliveryChainInput<
  TPatch,
  THandoff,
  TApply
> = {
  adaptiveResult:
    AdaptiveCoderContextFlowResult<unknown>;
  allowedFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
  patchPipeline: (
    mutation: WorkspaceMutation,
    authorization:
      ContextSufficiencyAuthorizationReceipt
  ) => Promise<
    ContextAuthorizedStageResult<TPatch>
  >;
  handoffPipeline: (
    patchOutput: TPatch,
    mutation: WorkspaceMutation,
    authorization:
      ContextSufficiencyAuthorizationReceipt
  ) => Promise<
    ContextAuthorizedStageResult<THandoff>
  >;
  applyPipeline: (
    handoffOutput: THandoff,
    mutation: WorkspaceMutation,
    authorization:
      ContextSufficiencyAuthorizationReceipt
  ) => Promise<
    ContextAuthorizedStageResult<TApply>
  >;
};

export type ContextAuthorizedDeliveryDecision =
  | "context_authorized_delivery_completed"
  | "context_authorized_delivery_stopped"
  | "context_authorized_delivery_invalid";

export type ContextAuthorizedDeliveryRoute =
  | "apply_completed"
  | "replan_required"
  | "human_review_required";

export type ContextAuthorizedDeliveryResult<
  TPatch,
  THandoff,
  TApply
> = {
  decision:
    ContextAuthorizedDeliveryDecision;
  route: ContextAuthorizedDeliveryRoute;
  issues: readonly ContextAuthorizationIssue[];
  authorization:
    ContextSufficiencyAuthorizationReceipt | null;
  mutation: WorkspaceMutation | null;
  patchOutput: TPatch | null;
  handoffOutput: THandoff | null;
  applyOutput: TApply | null;
  summary: {
    contextAuthorized: boolean;
    patchPipelineCallCount: 0 | 1;
    handoffPipelineCallCount: 0 | 1;
    applyPipelineCallCount: 0 | 1;
  };
};

const HASH =
  /^sha256:[0-9a-f]{64}$/;

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: {
    field?: string;
    filePath?: string;
  } = {}
): ContextAuthorizationIssue {
  return {
    code,
    message,
    severity,
    ...extra
  };
}

function deepFreeze<T>(
  value: T
): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (
      const child of
      Object.values(value)
    ) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

function sortedUnique(
  values: readonly string[]
): string[] {
  return [...new Set(values)]
    .sort((left, right) =>
      left.localeCompare(right)
    );
}

function emptySummary():
  ContextAuthorizationResult["summary"] {
  return {
    adaptiveFlowCompleted: false,
    coderExecuted: false,
    coderProviderCalledExactlyOnce:
      false,
    mutationValidated: false,
    mutationIsPatchDraft: false,
    changedFilesVisibleToCoder:
      false,
    contextWithinHardBudget:
      false,
    changedFileCount: 0,
    visibleEvidenceCount: 0
  };
}

function authorizationFinish(
  decision:
    ContextAuthorizationDecision,
  route: ContextAuthorizationRoute,
  issues:
    readonly ContextAuthorizationIssue[],
  authorization:
    ContextSufficiencyAuthorizationReceipt | null,
  mutation:
    WorkspaceMutation | null,
  summary:
    ContextAuthorizationResult["summary"]
): ContextAuthorizationResult {
  return {
    decision,
    route,
    issues,
    authorization,
    mutation,
    summary
  };
}

function authorizationCore(
  authorization:
    ContextSufficiencyAuthorizationReceipt
): Omit<
  ContextSufficiencyAuthorizationReceipt,
  "authorizationHash"
> {
  const {
    authorizationHash: _,
    ...core
  } = authorization;

  return core;
}

function serializeModelOutput(
  value: unknown
): string {
  const serialized =
    JSON.stringify(value);

  if (
    typeof serialized !== "string"
  ) {
    throw new Error(
      "Coder provider output is not JSON serializable."
    );
  }

  return serialized;
}

function deriveRouteFromAdaptiveResult(
  result:
    AdaptiveCoderContextFlowResult<unknown>
): Exclude<
  ContextAuthorizationRoute,
  "context_authorized"
> {
  return result.route ===
    "replan_required"
    ? "replan_required"
    : "human_review_required";
}

export function authorizeContextSufficientPatch(
  input:
    AuthorizeContextSufficientPatchInput
): ContextAuthorizationResult {
  const summary = emptySummary();

  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.adaptiveResult === null ||
    typeof input.adaptiveResult !==
      "object"
  ) {
    return authorizationFinish(
      "context_authorization_invalid",
      "human_review_required",
      [
        issue(
          "context_authorization_input_invalid",
          "Context authorization input must contain an adaptive result.",
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  const adaptive =
    input.adaptiveResult;

  if (
    adaptive.decision !==
      "adaptive_coder_completed" ||
    adaptive.route !==
      "coder_executed"
  ) {
    return authorizationFinish(
      "context_authorization_blocked",
      deriveRouteFromAdaptiveResult(
        adaptive
      ),
      [
        issue(
          "adaptive_context_not_completed",
          "A stopped adaptive context flow cannot authorize a patch.",
          "review"
        )
      ],
      null,
      null,
      summary
    );
  }

  summary.adaptiveFlowCompleted =
    true;

  const coderResult =
    adaptive.coderResult;

  if (
    coderResult === null ||
    coderResult.decision !==
      "coder_execution_completed" ||
    coderResult.route !==
      "coder_executed" ||
    !coderResult.providerCalled ||
    coderResult.context === null
  ) {
    return authorizationFinish(
      "context_authorization_blocked",
      "human_review_required",
      [
        issue(
          "coder_execution_not_authorizable",
          "Adaptive completion must contain one successful coder execution and its context.",
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  summary.coderExecuted = true;

  const providerCalledExactlyOnce =
    adaptive.summary
      .coderProviderCallCount === 1 &&
    coderResult.summary
      .providerCallCount === 1;

  summary
    .coderProviderCalledExactlyOnce =
    providerCalledExactlyOnce;

  if (!providerCalledExactlyOnce) {
    return authorizationFinish(
      "context_authorization_blocked",
      "human_review_required",
      [
        issue(
          "coder_provider_call_count_invalid",
          "Context authorization requires exactly one successful coder provider call.",
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  let validation;

  try {
    validation =
      validateModelWorkspaceMutation(
        serializeModelOutput(
          coderResult.providerOutput
        ),
        {
          role: "coder",
          allowedFiles:
            input.allowedFiles ===
              undefined
              ? undefined
              : [...input.allowedFiles],
          forbiddenFiles:
            input.forbiddenFiles ===
              undefined
              ? undefined
              : [...input.forbiddenFiles]
        }
      );
  } catch {
    return authorizationFinish(
      "context_authorization_invalid",
      "human_review_required",
      [
        issue(
          "coder_patch_validation_failed",
          "Coder patch validation failed safely.",
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  if (
    !validation.ok ||
    validation.mutation === null
  ) {
    return authorizationFinish(
      "context_authorization_blocked",
      "human_review_required",
      validation.issues.map(
        (entry) =>
          issue(
            `coder_patch_${entry.code}`,
            entry.message,
            "error",
            entry.path === undefined
              ? {}
              : {
                  field:
                    entry.path
                }
          )
      ),
      null,
      null,
      summary
    );
  }

  const mutation =
    validation.mutation;

  summary.mutationValidated = true;

  if (
    mutation.role !== "coder" ||
    mutation.target !== "patchDraft"
  ) {
    return authorizationFinish(
      "context_authorization_blocked",
      "human_review_required",
      [
        issue(
          "coder_output_not_patch_draft",
          "Only a validated coder patchDraft can receive context authorization.",
          "error"
        )
      ],
      null,
      mutation,
      summary
    );
  }

  summary.mutationIsPatchDraft = true;

  let changedFiles:
    readonly string[];

  let mutationHash: string;

  try {
    changedFiles =
      deriveGovernedMutationChangedFiles(
        mutation
      );

    mutationHash =
      computeGovernedMutationHash(
        "coder_patch_draft",
        mutation
      );
  } catch {
    return authorizationFinish(
      "context_authorization_invalid",
      "human_review_required",
      [
        issue(
          "governed_mutation_binding_failed",
          "The validated patch could not be bound to governed mutation evidence.",
          "error"
        )
      ],
      null,
      mutation,
      summary
    );
  }

  summary.changedFileCount =
    changedFiles.length;

  if (changedFiles.length === 0) {
    return authorizationFinish(
      "context_authorization_blocked",
      "replan_required",
      [
        issue(
          "authorized_patch_has_no_changed_files",
          "A context-authorized patch must propose at least one changed file.",
          "review"
        )
      ],
      null,
      mutation,
      summary
    );
  }

  const evidenceBindings =
    coderResult.context.evidence
      .map((entry) => ({
        path: entry.path,
        contentHash:
          entry.contentHash,
        origin: entry.origin,
        source: entry.source
      }))
      .sort((left, right) =>
        left.path.localeCompare(
          right.path
        )
      );

  summary.visibleEvidenceCount =
    evidenceBindings.length;

  const visiblePaths =
    new Set(
      evidenceBindings.map(
        (entry) => entry.path
      )
    );

  const invisibleChangedFiles =
    changedFiles.filter(
      (filePath) =>
        !visiblePaths.has(filePath)
    );

  if (
    invisibleChangedFiles.length > 0
  ) {
    return authorizationFinish(
      "context_authorization_blocked",
      "replan_required",
      invisibleChangedFiles.map(
        (filePath) =>
          issue(
            "changed_file_not_visible_to_coder",
            "A proposed changed file was not present in the authorized coder context.",
            "review",
            { filePath }
          )
      ),
      null,
      mutation,
      summary
    );
  }

  summary
    .changedFilesVisibleToCoder =
    true;

  const budget =
    coderResult.context.budget;

  const contextWithinHardBudget =
    budget.remainingTokens >= 0 &&
    budget.estimatedInputTokens +
      budget.reservedOutputTokens <=
      budget.hardTotalBudgetTokens;

  summary.contextWithinHardBudget =
    contextWithinHardBudget;

  if (!contextWithinHardBudget) {
    return authorizationFinish(
      "context_authorization_blocked",
      "replan_required",
      [
        issue(
          "authorized_context_budget_invalid",
          "Coder context no longer satisfies the hard total budget.",
          "review",
          {
            field:
              "hardTotalBudgetTokens"
          }
        )
      ],
      null,
      mutation,
      summary
    );
  }

  const authorizationWithoutHash:
    Omit<
      ContextSufficiencyAuthorizationReceipt,
      "authorizationHash"
    > = {
    authorizationVersion:
      CONTEXT_SUFFICIENCY_AUTHORIZATION_VERSION,
    adaptiveFlowVersion: "1",
    adaptiveDecision:
      "adaptive_coder_completed",
    adaptiveRoute:
      "coder_executed",
    coderDecision:
      "coder_execution_completed",
    mutation: {
      changeKind:
        "coder_patch_draft",
      mutationHash,
      changedFiles:
        sortedUnique(changedFiles)
    },
    context: {
      coderContextHash:
        hashCanonicalJson(
          coderResult.context
        ),
      adaptiveTraceHash:
        hashCanonicalJson(
          adaptive.traces
        ),
      evidenceBindings,
      evidenceBindingHash:
        hashCanonicalJson(
          evidenceBindings
        )
    },
    budget: {
      estimatedInputTokens:
        budget.estimatedInputTokens,
      reservedOutputTokens:
        budget.reservedOutputTokens,
      hardTotalBudgetTokens:
        budget.hardTotalBudgetTokens,
      remainingTokens:
        budget.remainingTokens
    },
    expansion: {
      attemptCount:
        adaptive.summary
          .expansionAttemptCount,
      requestProviderCallCount:
        adaptive.summary
          .contextRequestProviderCallCount,
      resolverCallCount:
        adaptive.summary
          .resolverCallCount,
      requestedFileCount:
        adaptive.summary
          .requestedFileCount,
      loadedExpansionFileCount:
        adaptive.summary
          .loadedExpansionFileCount
    },
    preconditions: {
      adaptiveFlowCompleted: true,
      coderExecuted: true,
      coderProviderCalledExactlyOnce:
        true,
      mutationValidated: true,
      mutationIsPatchDraft: true,
      changedFilesVisibleToCoder:
        true,
      contextWithinHardBudget:
        true
    }
  };

  const authorization =
    deepFreeze({
      ...authorizationWithoutHash,
      authorizationHash:
        hashCanonicalJson(
          authorizationWithoutHash
        )
    });

  return authorizationFinish(
    "context_authorization_ready",
    "context_authorized",
    [],
    authorization,
    mutation,
    summary
  );
}

export function verifyContextSufficiencyAuthorization(
  authorization:
    ContextSufficiencyAuthorizationReceipt,
  mutation: WorkspaceMutation
): ContextAuthorizationVerificationResult {
  const errors: string[] = [];

  if (
    authorization === null ||
    typeof authorization !==
      "object" ||
    !HASH.test(
      authorization.authorizationHash
    )
  ) {
    return {
      ok: false,
      errors: [
        "Authorization receipt is missing or malformed."
      ],
      mutationHashMatched: false,
      changedFilesMatched: false,
      authorizationHashMatched:
        false
    };
  }

  let currentMutationHash: string | null =
    null;

  let currentChangedFiles:
    readonly string[] = [];

  try {
    currentMutationHash =
      computeGovernedMutationHash(
        "coder_patch_draft",
        mutation
      );

    currentChangedFiles =
      deriveGovernedMutationChangedFiles(
        mutation
      );
  } catch {
    errors.push(
      "Mutation is not a valid governed coder patch."
    );
  }

  const mutationHashMatched =
    currentMutationHash !== null &&
    currentMutationHash ===
      authorization.mutation
        .mutationHash;

  if (!mutationHashMatched) {
    errors.push(
      "Authorization mutation hash does not match the current patch."
    );
  }

  const changedFilesMatched =
    JSON.stringify(
      sortedUnique(
        currentChangedFiles
      )
    ) ===
    JSON.stringify(
      sortedUnique(
        authorization.mutation
          .changedFiles
      )
    );

  if (!changedFilesMatched) {
    errors.push(
      "Authorization changed files do not match the current patch."
    );
  }

  let authorizationHashMatched =
    false;

  try {
    authorizationHashMatched =
      hashCanonicalJson(
        authorizationCore(
          authorization
        )
      ) ===
      authorization.authorizationHash;
  } catch {
    authorizationHashMatched =
      false;
  }

  if (!authorizationHashMatched) {
    errors.push(
      "Authorization receipt integrity verification failed."
    );
  }

  const boundPaths =
    new Set(
      authorization.context
        .evidenceBindings
        .map((entry) => entry.path)
    );

  for (
    const filePath of
    authorization.mutation
      .changedFiles
  ) {
    if (!boundPaths.has(filePath)) {
      errors.push(
        `Authorized changed file is absent from evidence bindings: ${filePath}`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    mutationHashMatched,
    changedFilesMatched,
    authorizationHashMatched
  };
}

function deliveryIssue(
  code: string,
  message: string,
  severity: "error" | "review"
): ContextAuthorizationIssue {
  return issue(
    code,
    message,
    severity
  );
}

function failedStageRoute(
  value:
    | "replan_required"
    | "human_review_required"
    | undefined
): Exclude<
  ContextAuthorizedDeliveryRoute,
  "apply_completed"
> {
  return value ??
    "human_review_required";
}

export async function runContextAuthorizedDeliveryChain<
  TPatch,
  THandoff,
  TApply
>(
  input:
    RunContextAuthorizedDeliveryChainInput<
      TPatch,
      THandoff,
      TApply
    >
): Promise<
  ContextAuthorizedDeliveryResult<
    TPatch,
    THandoff,
    TApply
  >
> {
  let patchPipelineCallCount:
    0 | 1 = 0;

  let handoffPipelineCallCount:
    0 | 1 = 0;

  let applyPipelineCallCount:
    0 | 1 = 0;

  const result = (
    decision:
      ContextAuthorizedDeliveryDecision,
    route:
      ContextAuthorizedDeliveryRoute,
    issues:
      readonly ContextAuthorizationIssue[],
    authorization:
      ContextSufficiencyAuthorizationReceipt | null,
    mutation:
      WorkspaceMutation | null,
    patchOutput:
      TPatch | null,
    handoffOutput:
      THandoff | null,
    applyOutput:
      TApply | null
  ): ContextAuthorizedDeliveryResult<
    TPatch,
    THandoff,
    TApply
  > => ({
    decision,
    route,
    issues,
    authorization,
    mutation,
    patchOutput,
    handoffOutput,
    applyOutput,
    summary: {
      contextAuthorized:
        authorization !== null,
      patchPipelineCallCount,
      handoffPipelineCallCount,
      applyPipelineCallCount
    }
  });

  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.patchPipeline !==
      "function" ||
    typeof input.handoffPipeline !==
      "function" ||
    typeof input.applyPipeline !==
      "function"
  ) {
    return result(
      "context_authorized_delivery_invalid",
      "human_review_required",
      [
        deliveryIssue(
          "context_delivery_input_invalid",
          "Context-authorized delivery requires all downstream pipeline callbacks.",
          "error"
        )
      ],
      null,
      null,
      null,
      null,
      null
    );
  }

  const authorizationResult =
    authorizeContextSufficientPatch({
      adaptiveResult:
        input.adaptiveResult,
      allowedFiles:
        input.allowedFiles,
      forbiddenFiles:
        input.forbiddenFiles
    });

  if (
    authorizationResult.decision !==
      "context_authorization_ready" ||
    authorizationResult.authorization ===
      null ||
    authorizationResult.mutation ===
      null
  ) {
    return result(
      "context_authorized_delivery_stopped",
      authorizationResult.route ===
        "replan_required"
        ? "replan_required"
        : "human_review_required",
      authorizationResult.issues,
      null,
      authorizationResult.mutation,
      null,
      null,
      null
    );
  }

  const authorization =
    authorizationResult.authorization;

  const mutation =
    authorizationResult.mutation;

  const verification =
    verifyContextSufficiencyAuthorization(
      authorization,
      mutation
    );

  if (!verification.ok) {
    return result(
      "context_authorized_delivery_stopped",
      "human_review_required",
      verification.errors.map(
        (message) =>
          deliveryIssue(
            "context_authorization_verification_failed",
            message,
            "error"
          )
      ),
      authorization,
      mutation,
      null,
      null,
      null
    );
  }

  let patchStage:
    ContextAuthorizedStageResult<TPatch>;

  try {
    patchPipelineCallCount = 1;

    patchStage =
      await input.patchPipeline(
        mutation,
        authorization
      );
  } catch {
    return result(
      "context_authorized_delivery_stopped",
      "human_review_required",
      [
        deliveryIssue(
          "patch_pipeline_failed",
          "The context-authorized patch pipeline failed.",
          "error"
        )
      ],
      authorization,
      mutation,
      null,
      null,
      null
    );
  }

  if (!patchStage.ok) {
    return result(
      "context_authorized_delivery_stopped",
      failedStageRoute(
        patchStage.route
      ),
      [
        deliveryIssue(
          patchStage.code,
          patchStage.message,
          patchStage.route ===
            "replan_required"
            ? "review"
            : "error"
        )
      ],
      authorization,
      mutation,
      null,
      null,
      null
    );
  }

  let handoffStage:
    ContextAuthorizedStageResult<THandoff>;

  try {
    handoffPipelineCallCount = 1;

    handoffStage =
      await input.handoffPipeline(
        patchStage.value,
        mutation,
        authorization
      );
  } catch {
    return result(
      "context_authorized_delivery_stopped",
      "human_review_required",
      [
        deliveryIssue(
          "handoff_pipeline_failed",
          "The context-authorized handoff pipeline failed.",
          "error"
        )
      ],
      authorization,
      mutation,
      patchStage.value,
      null,
      null
    );
  }

  if (!handoffStage.ok) {
    return result(
      "context_authorized_delivery_stopped",
      failedStageRoute(
        handoffStage.route
      ),
      [
        deliveryIssue(
          handoffStage.code,
          handoffStage.message,
          handoffStage.route ===
            "replan_required"
            ? "review"
            : "error"
        )
      ],
      authorization,
      mutation,
      patchStage.value,
      null,
      null
    );
  }

  let applyStage:
    ContextAuthorizedStageResult<TApply>;

  try {
    applyPipelineCallCount = 1;

    applyStage =
      await input.applyPipeline(
        handoffStage.value,
        mutation,
        authorization
      );
  } catch {
    return result(
      "context_authorized_delivery_stopped",
      "human_review_required",
      [
        deliveryIssue(
          "apply_pipeline_failed",
          "The context-authorized apply pipeline failed.",
          "error"
        )
      ],
      authorization,
      mutation,
      patchStage.value,
      handoffStage.value,
      null
    );
  }

  if (!applyStage.ok) {
    return result(
      "context_authorized_delivery_stopped",
      failedStageRoute(
        applyStage.route
      ),
      [
        deliveryIssue(
          applyStage.code,
          applyStage.message,
          applyStage.route ===
            "replan_required"
            ? "review"
            : "error"
        )
      ],
      authorization,
      mutation,
      patchStage.value,
      handoffStage.value,
      null
    );
  }

  return result(
    "context_authorized_delivery_completed",
    "apply_completed",
    [],
    authorization,
    mutation,
    patchStage.value,
    handoffStage.value,
    applyStage.value
  );
}
