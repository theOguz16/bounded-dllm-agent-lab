import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  computeGovernedMutationHash,
  deriveGovernedMutationChangedFiles
} from "./controlled-apply-handoff.js";
import {
  verifyControlledApplyExecutionAuthorization,
  type ControlledApplyExecutionAuthorization,
  type ControlledApplyExecutionAuthorizationVerificationResult,
  type ControlledApplyExecutionGateInput
} from "./controlled-apply-execution-gate.js";
import {
  verifyContextSufficiencyAuthorization,
  type ContextSufficiencyAuthorizationReceipt
} from "./context-sufficiency-authorization.js";
import {
  validateWorkspaceMutationContract,
  type WorkspaceMutation
} from "./workspace-mutation.js";

export const CONTEXT_TO_APPLY_BINDING_VERSION = "1" as const;

export type ContextToApplyBindingDecision =
  | "context_to_apply_binding_ready"
  | "context_to_apply_binding_blocked"
  | "context_to_apply_binding_invalid";

export type ContextToApplyBindingRoute =
  | "apply_authorized"
  | "replan_required"
  | "human_review_required";

export type ContextToApplyBindingIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
};

export type ContextToApplyBindingReceipt = {
  bindingVersion: "1";
  contextAuthorizationHash: string;
  coderMutationHash: string;
  repairMutationHash: string;
  executionAuthorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  consumptionKey: string;
  sourceChangedFiles: readonly string[];
  repairChangedFiles: readonly string[];
  scope: {
    relation: "repair_subset_of_context_authorized_scope";
    sourceChangedFileCount: number;
    repairChangedFileCount: number;
    scopeExpansionObserved: false;
  };
  evidence: {
    contextEvidenceBindingHash: string;
    contextEvidencePaths: readonly string[];
    executionTargetHash: string;
    executionEvidenceHash: string;
  };
  preconditions: {
    contextAuthorizationCurrent: true;
    coderPatchValidated: true;
    executionAuthorizationCurrent: true;
    repairMutationValidated: true;
    repairMutationBoundToExecutionAuthorization: true;
    repairScopeWithinContextAuthorizedScope: true;
    repairFilesVisibleInCoderContext: true;
  };
  bindingHash: string;
};

export type BuildContextToApplyBindingInput = {
  contextAuthorization: ContextSufficiencyAuthorizationReceipt;
  coderMutation: WorkspaceMutation;
  executionAuthorization: ControlledApplyExecutionAuthorization;
  gateInput: ControlledApplyExecutionGateInput;
};

export type ContextToApplyBindingResult = {
  decision: ContextToApplyBindingDecision;
  route: ContextToApplyBindingRoute;
  issues: readonly ContextToApplyBindingIssue[];
  receipt: ContextToApplyBindingReceipt | null;
  executionAuthorizationVerification:
    ControlledApplyExecutionAuthorizationVerificationResult | null;
  summary: {
    contextAuthorizationCurrent: boolean;
    coderPatchValidated: boolean;
    executionAuthorizationCurrent: boolean;
    repairMutationValidated: boolean;
    repairMutationBoundToExecutionAuthorization: boolean;
    repairScopeWithinContextAuthorizedScope: boolean;
    repairFilesVisibleInCoderContext: boolean;
    sourceChangedFileCount: number;
    repairChangedFileCount: number;
  };
};

export type ContextToApplyBindingVerificationDecision =
  | "context_to_apply_binding_current"
  | "context_to_apply_binding_stale"
  | "context_to_apply_binding_verification_invalid";

export type ContextToApplyBindingVerificationResult = {
  decision: ContextToApplyBindingVerificationDecision;
  errors: readonly string[];
  receiptIntegrityVerified: boolean;
  currentBindingMatched: boolean;
  downstreamEligible: boolean;
  currentResult: ContextToApplyBindingResult;
};

const HASH = /^sha256:[0-9a-f]{64}$/;

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return hashCanonicalJson(left) === hashCanonicalJson(right);
  } catch {
    return false;
  }
}

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: { field?: string; filePath?: string } = {}
): ContextToApplyBindingIssue {
  return { code, message, severity, ...extra };
}

function initialSummary(): ContextToApplyBindingResult["summary"] {
  return {
    contextAuthorizationCurrent: false,
    coderPatchValidated: false,
    executionAuthorizationCurrent: false,
    repairMutationValidated: false,
    repairMutationBoundToExecutionAuthorization: false,
    repairScopeWithinContextAuthorizedScope: false,
    repairFilesVisibleInCoderContext: false,
    sourceChangedFileCount: 0,
    repairChangedFileCount: 0
  };
}

function finish(
  decision: ContextToApplyBindingDecision,
  route: ContextToApplyBindingRoute,
  issues: readonly ContextToApplyBindingIssue[],
  receipt: ContextToApplyBindingReceipt | null,
  executionAuthorizationVerification:
    ControlledApplyExecutionAuthorizationVerificationResult | null,
  summary: ContextToApplyBindingResult["summary"]
): ContextToApplyBindingResult {
  return deepFreeze({
    decision,
    route,
    issues,
    receipt,
    executionAuthorizationVerification,
    summary
  });
}

function receiptCore(
  receipt: ContextToApplyBindingReceipt
): Omit<ContextToApplyBindingReceipt, "bindingHash"> {
  const { bindingHash: _, ...core } = receipt;
  return core;
}

function validateTopLevelInput(
  input: BuildContextToApplyBindingInput
): string | null {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return "Context-to-apply binding input must be an object.";
  }
  if (
    input.contextAuthorization === null ||
    typeof input.contextAuthorization !== "object" ||
    input.coderMutation === null ||
    typeof input.coderMutation !== "object" ||
    input.executionAuthorization === null ||
    typeof input.executionAuthorization !== "object" ||
    input.gateInput === null ||
    typeof input.gateInput !== "object"
  ) {
    return "Context, mutation, execution authorization, and gate input are required.";
  }
  return null;
}

export async function buildContextToApplyBinding(
  input: BuildContextToApplyBindingInput
): Promise<ContextToApplyBindingResult> {
  const summary = initialSummary();
  const inputError = validateTopLevelInput(input);

  if (inputError !== null) {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "context_to_apply_binding_input_invalid",
          inputError,
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  const contextVerification =
    verifyContextSufficiencyAuthorization(
      input.contextAuthorization,
      input.coderMutation
    );

  summary.contextAuthorizationCurrent =
    contextVerification.ok;

  if (!contextVerification.ok) {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      contextVerification.errors.map((message) =>
        issue(
          "context_authorization_not_current",
          message,
          "error"
        )
      ),
      null,
      null,
      summary
    );
  }

  const coderValidation =
    validateWorkspaceMutationContract(
      input.coderMutation
    );

  summary.coderPatchValidated =
    coderValidation.ok &&
    input.coderMutation.role === "coder" &&
    input.coderMutation.target === "patchDraft";

  if (!summary.coderPatchValidated) {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "context_source_mutation_invalid",
          "The source mutation must be a validated coder patchDraft.",
          "error",
          { field: "coderMutation" }
        )
      ],
      null,
      null,
      summary
    );
  }

  const repairMutation = input.gateInput.mutation;
  const repairValidation =
    validateWorkspaceMutationContract(
      repairMutation
    );

  summary.repairMutationValidated =
    repairValidation.ok &&
    repairMutation.role === "remask" &&
    repairMutation.target === "repairDraft";

  if (!summary.repairMutationValidated) {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "context_apply_mutation_invalid",
          "The apply mutation must be a validated remask repairDraft.",
          "error",
          { field: "gateInput.mutation" }
        )
      ],
      null,
      null,
      summary
    );
  }

  let executionVerification:
    ControlledApplyExecutionAuthorizationVerificationResult;

  try {
    executionVerification =
      await verifyControlledApplyExecutionAuthorization({
        authorization:
          input.executionAuthorization,
        gateInput:
          input.gateInput
      });
  } catch {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "execution_authorization_verification_failed",
          "The controlled apply execution authorization could not be verified safely.",
          "error"
        )
      ],
      null,
      null,
      summary
    );
  }

  summary.executionAuthorizationCurrent =
    executionVerification.decision ===
      "controlled_apply_execution_authorization_current" &&
    executionVerification.firstWriteEligible;

  if (!summary.executionAuthorizationCurrent) {
    return finish(
      "context_to_apply_binding_blocked",
      "human_review_required",
      [
        issue(
          "execution_authorization_not_current",
          "The controlled apply execution authorization is stale, consumed, blocked, or invalid.",
          "error"
        ),
        ...executionVerification.reasonCodes.map(
          (code) =>
            issue(
              code,
              "Execution authorization verification reported a blocking reason.",
              "error"
            )
        )
      ],
      null,
      executionVerification,
      summary
    );
  }

  let repairMutationHash: string;
  let repairChangedFiles: readonly string[];

  try {
    repairMutationHash =
      computeGovernedMutationHash(
        "repair_draft",
        repairMutation
      );
    repairChangedFiles =
      deriveGovernedMutationChangedFiles(
        repairMutation
      );
  } catch {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "repair_mutation_binding_failed",
          "The repair mutation could not be deterministically bound.",
          "error"
        )
      ],
      null,
      executionVerification,
      summary
    );
  }

  const sourceChangedFiles =
    sortedUnique(
      input.contextAuthorization
        .mutation.changedFiles
    );
  const normalizedRepairFiles =
    sortedUnique(repairChangedFiles);

  summary.sourceChangedFileCount =
    sourceChangedFiles.length;
  summary.repairChangedFileCount =
    normalizedRepairFiles.length;

  if (normalizedRepairFiles.length === 0) {
    return finish(
      "context_to_apply_binding_blocked",
      "replan_required",
      [
        issue(
          "repair_mutation_empty",
          "An empty repair mutation cannot enter real repository apply.",
          "review"
        )
      ],
      null,
      executionVerification,
      summary
    );
  }

  summary.repairMutationBoundToExecutionAuthorization =
    input.executionAuthorization
      .mutation.changeKind ===
      "repair_draft" &&
    input.executionAuthorization
      .mutation.mutationHash ===
      repairMutationHash &&
    canonicalEqual(
      input.executionAuthorization
        .mutation.changedFiles,
      normalizedRepairFiles
    ) &&
    input.executionAuthorization
      .mutation.changedFileCount ===
      normalizedRepairFiles.length;

  if (
    !summary
      .repairMutationBoundToExecutionAuthorization
  ) {
    return finish(
      "context_to_apply_binding_invalid",
      "human_review_required",
      [
        issue(
          "repair_execution_authorization_mismatch",
          "The repair mutation does not match the current X.3 execution authorization.",
          "error"
        )
      ],
      null,
      executionVerification,
      summary
    );
  }

  const sourceScope =
    new Set(sourceChangedFiles);

  const expandedFiles =
    normalizedRepairFiles.filter(
      (filePath) =>
        !sourceScope.has(filePath)
    );

  summary.repairScopeWithinContextAuthorizedScope =
    expandedFiles.length === 0;

  if (
    !summary
      .repairScopeWithinContextAuthorizedScope
  ) {
    return finish(
      "context_to_apply_binding_blocked",
      "replan_required",
      expandedFiles.map((filePath) =>
        issue(
          "repair_scope_expands_context_authorized_scope",
          "The repair mutation attempts to write a file outside the context-authorized coder patch scope.",
          "review",
          { filePath }
        )
      ),
      null,
      executionVerification,
      summary
    );
  }

  const contextEvidencePaths =
    sortedUnique(
      input.contextAuthorization
        .context.evidenceBindings
        .map((entry) => entry.path)
    );
  const visibleScope =
    new Set(contextEvidencePaths);
  const invisibleRepairFiles =
    normalizedRepairFiles.filter(
      (filePath) =>
        !visibleScope.has(filePath)
    );

  summary.repairFilesVisibleInCoderContext =
    invisibleRepairFiles.length === 0;

  if (
    !summary
      .repairFilesVisibleInCoderContext
  ) {
    return finish(
      "context_to_apply_binding_blocked",
      "replan_required",
      invisibleRepairFiles.map(
        (filePath) =>
          issue(
            "repair_file_not_visible_in_coder_context",
            "The final repair would write a file that was not visible in the authorized coder context.",
            "review",
            { filePath }
          )
      ),
      null,
      executionVerification,
      summary
    );
  }

  const receiptWithoutHash:
    Omit<
      ContextToApplyBindingReceipt,
      "bindingHash"
    > = {
    bindingVersion:
      CONTEXT_TO_APPLY_BINDING_VERSION,
    contextAuthorizationHash:
      input.contextAuthorization
        .authorizationHash,
    coderMutationHash:
      input.contextAuthorization
        .mutation.mutationHash,
    repairMutationHash,
    executionAuthorizationHash:
      input.executionAuthorization
        .authorizationHash,
    governedArtifactHash:
      input.executionAuthorization
        .governedArtifactHash,
    handoffHash:
      input.executionAuthorization
        .handoffHash,
    consumptionKey:
      input.executionAuthorization
        .consumptionKey,
    sourceChangedFiles,
    repairChangedFiles:
      normalizedRepairFiles,
    scope: {
      relation:
        "repair_subset_of_context_authorized_scope",
      sourceChangedFileCount:
        sourceChangedFiles.length,
      repairChangedFileCount:
        normalizedRepairFiles.length,
      scopeExpansionObserved:
        false
    },
    evidence: {
      contextEvidenceBindingHash:
        input.contextAuthorization
          .context.evidenceBindingHash,
      contextEvidencePaths,
      executionTargetHash:
        hashCanonicalJson(
          input.executionAuthorization
            .target
        ),
      executionEvidenceHash:
        hashCanonicalJson(
          input.executionAuthorization
            .evidence
        )
    },
    preconditions: {
      contextAuthorizationCurrent: true,
      coderPatchValidated: true,
      executionAuthorizationCurrent: true,
      repairMutationValidated: true,
      repairMutationBoundToExecutionAuthorization:
        true,
      repairScopeWithinContextAuthorizedScope:
        true,
      repairFilesVisibleInCoderContext:
        true
    }
  };

  const receipt =
    deepFreeze({
      ...receiptWithoutHash,
      bindingHash:
        hashCanonicalJson(
          receiptWithoutHash
        )
    });

  return finish(
    "context_to_apply_binding_ready",
    "apply_authorized",
    [],
    receipt,
    executionVerification,
    summary
  );
}

export async function verifyContextToApplyBindingReceipt(
  receipt: ContextToApplyBindingReceipt,
  input: BuildContextToApplyBindingInput
): Promise<ContextToApplyBindingVerificationResult> {
  const errors: string[] = [];
  let receiptIntegrityVerified = false;

  try {
    receiptIntegrityVerified =
      receipt !== null &&
      typeof receipt === "object" &&
      HASH.test(receipt.bindingHash) &&
      hashCanonicalJson(
        receiptCore(receipt)
      ) === receipt.bindingHash;
  } catch {
    receiptIntegrityVerified = false;
  }

  if (!receiptIntegrityVerified) {
    errors.push(
      "context_to_apply_binding_receipt_hash_mismatch"
    );
  }

  const currentResult =
    await buildContextToApplyBinding(
      input
    );

  const currentBindingMatched =
    currentResult.receipt !== null &&
    receiptIntegrityVerified &&
    currentResult.receipt
      .bindingHash ===
      receipt.bindingHash &&
    canonicalEqual(
      currentResult.receipt,
      receipt
    );

  if (!currentBindingMatched) {
    errors.push(
      "context_to_apply_binding_current_state_mismatch"
    );
  }

  const downstreamEligible =
    errors.length === 0 &&
    currentResult.decision ===
      "context_to_apply_binding_ready" &&
    currentResult.route ===
      "apply_authorized";

  return deepFreeze({
    decision:
      !receiptIntegrityVerified
        ? "context_to_apply_binding_verification_invalid"
        : downstreamEligible
          ? "context_to_apply_binding_current"
          : "context_to_apply_binding_stale",
    errors,
    receiptIntegrityVerified,
    currentBindingMatched,
    downstreamEligible,
    currentResult
  });
}
