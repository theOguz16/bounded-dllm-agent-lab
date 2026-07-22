import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  evaluateAcceptanceCriteria,
  verifyAcceptanceCriteriaCoverageReceipt,
  type AcceptanceCriteriaContract,
  type AcceptanceCriteriaCoverageReceipt,
  type AcceptanceCriteriaCoverageVerificationResult,
  type AcceptanceCriteriaEvaluationResult,
  type HumanReviewAcceptanceEvidence
} from "./acceptance-criteria-contract.js";
import {
  verifyContextToApplyBindingReceipt,
  type BuildContextToApplyBindingInput,
  type ContextToApplyBindingReceipt,
  type ContextToApplyBindingVerificationResult
} from "./context-to-apply-binding.js";
import type {
  ControlledApplyExecutionAuthorization
} from "./controlled-apply-execution-gate.js";
import {
  executeControlledPostApplyValidation,
  verifyControlledPostApplyFinalReceipt,
  type ControlledPostApplyFinalReceipt,
  type ControlledPostApplyFinalReceiptVerificationResult,
  type ControlledPostApplyValidationResult
} from "./controlled-post-apply-validation.js";
import {
  executeControlledRepositoryApply,
  type ControlledRepositoryApplyReceipt,
  type ControlledRepositoryApplyResult
} from "./controlled-repository-apply.js";
import type {
  TemporaryWorkspaceExecutionSpecification,
  TemporaryWorkspaceExecutionVerificationEvidence
} from "./temporary-workspace-execution-verifier.js";

export const INTEGRATED_DISPOSABLE_APPLY_VERSION = "1" as const;

export type IntegratedDisposableApplyDecision =
  | "integrated_disposable_apply_finalized"
  | "integrated_disposable_apply_rolled_back"
  | "integrated_disposable_apply_blocked"
  | "integrated_disposable_apply_invalid"
  | "integrated_disposable_apply_needs_review"
  | "integrated_disposable_apply_recovery_required";

export type IntegratedDisposableApplyRoute =
  | "contract_approved"
  | "replan_required"
  | "human_review_required"
  | "recovery_required";

export type IntegratedDisposableApplyIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  criterionId?: string;
};

export type IntegratedDisposableApplyReceipt = {
  receiptVersion: "1";
  outcome: "contract_approved";
  contextToApplyBindingHash: string;
  contextAuthorizationHash: string;
  coderMutationHash: string;
  repairMutationHash: string;
  executionAuthorizationHash: string;
  governedArtifactHash: string;
  handoffHash: string;
  consumptionKey: string;
  acceptance: {
    contractHash: string;
    preflightCoverageReceiptHash: string;
    finalCoverageReceiptHash: string;
    requiredCriterionCount: number;
    approvedCriterionCount: number;
    coverageComplete: true;
  };
  apply: {
    x4ApplyReceiptHash: string;
    appliedStateHash: string;
    finalScopeHash: string;
    changedFiles: readonly string[];
  };
  validation: {
    x5FinalReceiptHash: string;
    currentExecutionResultHash: string;
    finalInspectionHash: string;
    finalRepositoryState: "validated_applied_state";
  };
  preconditions: {
    bindingCurrentBeforeWrite: true;
    objectiveMatched: true;
    phaseVArtifactBindingMatched: true;
    acceptancePreflightApproved: true;
    x4ApplySucceeded: true;
    x5ValidationFinalized: true;
    finalAcceptanceApproved: true;
    x5FinalReceiptCurrent: true;
    repositoryValidatedAppliedState: true;
  };
  receiptHash: string;
};

export type RunIntegratedDisposableApplyInput = {
  bindingReceipt: ContextToApplyBindingReceipt;
  bindingInput: BuildContextToApplyBindingInput;
  acceptanceContract: AcceptanceCriteriaContract;
  humanReviewEvidence?: readonly HumanReviewAcceptanceEvidence[];
  registryDirectoryPath: string;
  validationWorkspaceParentPath: string;
  phaseVExecutionSpecification: TemporaryWorkspaceExecutionSpecification;
  phaseVExecutionVerification: TemporaryWorkspaceExecutionVerificationEvidence;
};

export type IntegratedDisposableApplyResult = {
  decision: IntegratedDisposableApplyDecision;
  route: IntegratedDisposableApplyRoute;
  issues: readonly IntegratedDisposableApplyIssue[];
  receipt: IntegratedDisposableApplyReceipt | null;
  bindingVerification: ContextToApplyBindingVerificationResult | null;
  preflightAcceptance: AcceptanceCriteriaEvaluationResult | null;
  preflightCoverageVerification:
    AcceptanceCriteriaCoverageVerificationResult | null;
  applyResult: ControlledRepositoryApplyResult | null;
  postApplyValidation: ControlledPostApplyValidationResult | null;
  finalExecutionEvidence:
    TemporaryWorkspaceExecutionVerificationEvidence | null;
  finalAcceptance: AcceptanceCriteriaEvaluationResult | null;
  finalCoverageVerification:
    AcceptanceCriteriaCoverageVerificationResult | null;
  finalReceiptVerification:
    ControlledPostApplyFinalReceiptVerificationResult | null;
  summary: {
    inputValid: boolean;
    bindingCurrentBeforeWrite: boolean;
    objectiveMatched: boolean;
    phaseVArtifactBindingMatched: boolean;
    acceptancePreflightApproved: boolean;
    validationPreflightReady: boolean;
    applyCallCount: number;
    x4ApplySucceeded: boolean;
    validationCallCount: number;
    x5ValidationFinalized: boolean;
    x5RollbackExecuted: boolean;
    x5RollbackSucceeded: boolean | null;
    finalAcceptanceApproved: boolean;
    finalReceiptCurrent: boolean;
    integratedReceiptBuilt: boolean;
    repositoryFinalState:
      | "validated_applied_state"
      | "restored_x1_baseline"
      | "unsafe_unknown_state"
      | null;
  };
};

export type VerifyIntegratedDisposableApplyReceiptInput = {
  receipt: IntegratedDisposableApplyReceipt;
  bindingReceipt: ContextToApplyBindingReceipt;
  acceptanceContract: AcceptanceCriteriaContract;
  preflightCoverageReceipt: AcceptanceCriteriaCoverageReceipt;
  finalCoverageReceipt: AcceptanceCriteriaCoverageReceipt;
  finalExecutionEvidence: TemporaryWorkspaceExecutionVerificationEvidence;
  applyReceipt: ControlledRepositoryApplyReceipt;
  postApplyFinalReceipt: ControlledPostApplyFinalReceipt;
  executionAuthorization: ControlledApplyExecutionAuthorization;
  bindingInput: BuildContextToApplyBindingInput;
  registryDirectoryPath: string;
};

export type IntegratedDisposableApplyReceiptVerificationDecision =
  | "integrated_disposable_apply_receipt_current"
  | "integrated_disposable_apply_receipt_stale"
  | "integrated_disposable_apply_receipt_invalid"
  | "integrated_disposable_apply_receipt_requires_recovery";

export type IntegratedDisposableApplyReceiptVerificationResult = {
  decision: IntegratedDisposableApplyReceiptVerificationDecision;
  errors: readonly string[];
  receiptIntegrityVerified: boolean;
  evidenceBindingsMatched: boolean;
  acceptanceCoverageCurrent: boolean;
  x5FinalReceiptCurrent: boolean;
  repositoryStateMatched: boolean;
  downstreamEligible: boolean;
  x5Verification: ControlledPostApplyFinalReceiptVerificationResult | null;
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
  extra: { field?: string; criterionId?: string } = {}
): IntegratedDisposableApplyIssue {
  return { code, message, severity, ...extra };
}

function initialSummary(): IntegratedDisposableApplyResult["summary"] {
  return {
    inputValid: false,
    bindingCurrentBeforeWrite: false,
    objectiveMatched: false,
    phaseVArtifactBindingMatched: false,
    acceptancePreflightApproved: false,
    validationPreflightReady: false,
    applyCallCount: 0,
    x4ApplySucceeded: false,
    validationCallCount: 0,
    x5ValidationFinalized: false,
    x5RollbackExecuted: false,
    x5RollbackSucceeded: null,
    finalAcceptanceApproved: false,
    finalReceiptCurrent: false,
    integratedReceiptBuilt: false,
    repositoryFinalState: null
  };
}

function finish(
  decision: IntegratedDisposableApplyDecision,
  route: IntegratedDisposableApplyRoute,
  issues: readonly IntegratedDisposableApplyIssue[],
  receipt: IntegratedDisposableApplyReceipt | null,
  bindingVerification: ContextToApplyBindingVerificationResult | null,
  preflightAcceptance: AcceptanceCriteriaEvaluationResult | null,
  preflightCoverageVerification:
    AcceptanceCriteriaCoverageVerificationResult | null,
  applyResult: ControlledRepositoryApplyResult | null,
  postApplyValidation: ControlledPostApplyValidationResult | null,
  finalExecutionEvidence:
    TemporaryWorkspaceExecutionVerificationEvidence | null,
  finalAcceptance: AcceptanceCriteriaEvaluationResult | null,
  finalCoverageVerification:
    AcceptanceCriteriaCoverageVerificationResult | null,
  finalReceiptVerification:
    ControlledPostApplyFinalReceiptVerificationResult | null,
  summary: IntegratedDisposableApplyResult["summary"]
): IntegratedDisposableApplyResult {
  return deepFreeze({
    decision,
    route,
    issues,
    receipt,
    bindingVerification,
    preflightAcceptance,
    preflightCoverageVerification,
    applyResult,
    postApplyValidation,
    finalExecutionEvidence,
    finalAcceptance,
    finalCoverageVerification,
    finalReceiptVerification,
    summary
  });
}

function receiptCore(
  receipt: IntegratedDisposableApplyReceipt
): Omit<IntegratedDisposableApplyReceipt, "receiptHash"> {
  const { receiptHash: _, ...core } = receipt;
  return core;
}

function bindingReceiptCore(
  receipt: ContextToApplyBindingReceipt
): Omit<ContextToApplyBindingReceipt, "bindingHash"> {
  const { bindingHash: _, ...core } = receipt;
  return core;
}

function validInput(input: RunIntegratedDisposableApplyInput): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    input.bindingReceipt !== null &&
    typeof input.bindingReceipt === "object" &&
    input.bindingInput !== null &&
    typeof input.bindingInput === "object" &&
    input.acceptanceContract !== null &&
    typeof input.acceptanceContract === "object" &&
    typeof input.registryDirectoryPath === "string" &&
    input.registryDirectoryPath.length > 0 &&
    typeof input.validationWorkspaceParentPath === "string" &&
    input.validationWorkspaceParentPath.length > 0 &&
    input.phaseVExecutionSpecification !== null &&
    typeof input.phaseVExecutionSpecification === "object" &&
    input.phaseVExecutionVerification !== null &&
    typeof input.phaseVExecutionVerification === "object"
  );
}

type IntegratedValidationPreflightKind =
  | "ready"
  | "blocked"
  | "review"
  | "invalid";

type IntegratedValidationPreflightResult = {
  kind: IntegratedValidationPreflightKind;
  issues: readonly IntegratedDisposableApplyIssue[];
};

const INTEGRATED_VALIDATION_MAX_OUTPUT_CHARS =
  5 * 1024 * 1024;

const execFileAsync =
  promisify(execFile);

function pathInside(
  root: string,
  candidate: string
): boolean {
  const relative =
    path.relative(root, candidate);

  return (
    relative === "" ||
    (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    )
  );
}

async function pathHasSymlinkSegment(
  configuredPath: string
): Promise<boolean> {
  const absolute =
    path.resolve(configuredPath);
  const parsed =
    path.parse(absolute);
  let current =
    parsed.root;

  for (
    const segment of absolute
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)
  ) {
    current =
      path.join(current, segment);

    const metadata =
      await lstat(current);

    if (metadata.isSymbolicLink()) {
      return true;
    }
  }

  return false;
}

async function pathExists(
  targetPath: string
): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)
        .code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function preflightIntegratedValidation(
  input: RunIntegratedDisposableApplyInput
): Promise<IntegratedValidationPreflightResult> {
  try {
    const configuredParent =
      input.validationWorkspaceParentPath;

    if (
      configuredParent.length > 4096 ||
      configuredParent.trim() !==
        configuredParent ||
      /[\u0000-\u001f\u007f]/.test(
        configuredParent
      )
    ) {
      return {
        kind: "invalid",
        issues: [
          issue(
            "integrated_validation_workspace_path_invalid",
            "Validation workspace parent path is invalid.",
            "error",
            {
              field:
                "validationWorkspaceParentPath"
            }
          )
        ]
      };
    }

    if (
      await pathHasSymlinkSegment(
        configuredParent
      )
    ) {
      return {
        kind: "invalid",
        issues: [
          issue(
            "integrated_validation_workspace_symlink_detected",
            "Validation workspace parent contains a symbolic-link path segment.",
            "error",
            {
              field:
                "validationWorkspaceParentPath"
            }
          )
        ]
      };
    }

    const parentMetadata =
      await lstat(configuredParent);

    if (
      !parentMetadata.isDirectory() ||
      parentMetadata.isSymbolicLink()
    ) {
      return {
        kind: "invalid",
        issues: [
          issue(
            "integrated_validation_workspace_path_invalid",
            "Validation workspace parent must be a real directory.",
            "error",
            {
              field:
                "validationWorkspaceParentPath"
            }
          )
        ]
      };
    }

    const repository =
      await realpath(
        input.bindingInput.gateInput
          .repositoryPath
      );
    const registry =
      await realpath(
        input.registryDirectoryPath
      );
    const bundle =
      await realpath(
        input.bindingInput.gateInput
          .bundleDirectoryPath
      );
    const parent =
      await realpath(
        configuredParent
      );
    const temporaryRoot =
      await realpath(
        os.tmpdir()
      );

    const gitCommonRaw =
      (
        await execFileAsync(
          "git",
          [
            "rev-parse",
            "--git-common-dir"
          ],
          {
            cwd: repository,
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer:
              5 * 1024 * 1024,
            windowsHide: true,
            env: {
              ...process.env,
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0"
            }
          }
        )
      ).stdout.trim();

    const gitCommon =
      await realpath(
        path.resolve(
          repository,
          gitCommonRaw
        )
      );

    if (
      !pathInside(
        temporaryRoot,
        parent
      )
    ) {
      return {
        kind: "review",
        issues: [
          issue(
            "integrated_validation_workspace_not_temporary",
            "Validation workspace parent must be inside the operating-system temporary root.",
            "review",
            {
              field:
                "validationWorkspaceParentPath"
            }
          )
        ]
      };
    }

    const protectedRoots = [
      {
        code:
          "integrated_validation_workspace_overlaps_repository",
        root: repository
      },
      {
        code:
          "integrated_validation_workspace_overlaps_git_directory",
        root: gitCommon
      },
      {
        code:
          "integrated_validation_workspace_overlaps_registry",
        root: registry
      },
      {
        code:
          "integrated_validation_workspace_overlaps_rollback_bundle",
        root: bundle
      }
    ];

    for (
      const protectedRoot of protectedRoots
    ) {
      if (
        pathInside(
          protectedRoot.root,
          parent
        ) ||
        pathInside(
          parent,
          protectedRoot.root
        )
      ) {
        return {
          kind: "invalid",
          issues: [
            issue(
              protectedRoot.code,
              "Validation workspace parent overlaps protected runtime state.",
              "error",
              {
                field:
                  "validationWorkspaceParentPath"
              }
            )
          ]
        };
      }
    }

    const maxOutputChars =
      input.phaseVExecutionSpecification
        .maxOutputChars ??
      20_000;

    if (
      !Number.isSafeInteger(
        maxOutputChars
      ) ||
      maxOutputChars <= 0 ||
      maxOutputChars >
        INTEGRATED_VALIDATION_MAX_OUTPUT_CHARS
    ) {
      return {
        kind: "invalid",
        issues: [
          issue(
            "integrated_validation_output_bound_invalid",
            "Phase V output bound exceeds the integrated X.5 validation limit.",
            "error",
            {
              field:
                "phaseVExecutionSpecification.maxOutputChars"
            }
          )
        ]
      };
    }

    const consumptionKey =
      input.bindingReceipt
        .consumptionKey;

    if (
      !/^sha256:[0-9a-f]{64}$/.test(
        consumptionKey
      )
    ) {
      return {
        kind: "invalid",
        issues: [
          issue(
            "integrated_validation_consumption_key_invalid",
            "Validation consumption key is invalid.",
            "error"
          )
        ]
      };
    }

    const keySuffix =
      consumptionKey.slice(7);
    const workspacePath =
      path.join(
        parent,
        `controlled-post-apply-${keySuffix}.partial`
      );

    if (
      await pathExists(
        workspacePath
      )
    ) {
      return {
        kind: "review",
        issues: [
          issue(
            "integrated_validation_workspace_already_exists",
            "The isolated validation workspace already exists before repository apply.",
            "review"
          )
        ]
      };
    }

    const validationsPath =
      path.join(
        registry,
        "validations"
      );

    if (
      await pathExists(
        validationsPath
      )
    ) {
      const validationsMetadata =
        await lstat(
          validationsPath
        );

      if (
        !validationsMetadata.isDirectory() ||
        validationsMetadata
          .isSymbolicLink() ||
        (
          validationsMetadata.mode &
          0o777
        ) !== 0o700
      ) {
        return {
          kind: "invalid",
          issues: [
            issue(
              "integrated_validation_registry_namespace_invalid",
              "Validation registry namespace is unsafe before repository apply.",
              "error"
            )
          ]
        };
      }

      const transactionPath =
        path.join(
          validationsPath,
          keySuffix
        );

      if (
        await pathExists(
          transactionPath
        )
      ) {
        return {
          kind: "blocked",
          issues: [
            issue(
              "integrated_validation_transaction_already_exists",
              "A validation transaction already exists for this consumption key.",
              "error"
            )
          ]
        };
      }
    }

    return {
      kind: "ready",
      issues: []
    };
  } catch {
    return {
      kind: "invalid",
      issues: [
        issue(
          "integrated_validation_preflight_failed",
          "Validation infrastructure preflight failed without exposing unbounded details.",
          "error"
        )
      ]
    };
  }
}

function preflightStop(
  evaluation: AcceptanceCriteriaEvaluationResult
): {
  decision: IntegratedDisposableApplyDecision;
  route: IntegratedDisposableApplyRoute;
} {
  if (evaluation.decision === "contract_failed") {
    return {
      decision: "integrated_disposable_apply_blocked",
      route: "replan_required"
    };
  }
  if (evaluation.decision === "contract_needs_review") {
    return {
      decision: "integrated_disposable_apply_needs_review",
      route: "human_review_required"
    };
  }
  return {
    decision: "integrated_disposable_apply_invalid",
    route: "human_review_required"
  };
}

function rebuildFinalExecutionEvidence(
  result: ControlledPostApplyValidationResult
): TemporaryWorkspaceExecutionVerificationEvidence | null {
  const record = result.validationRecord;

  if (
    result.decision !==
      "controlled_post_apply_validation_finalized" ||
    record === null ||
    record.decision !== "passed" ||
    record.currentExecutionResultHash === null ||
    !record.workspaceCleanupSucceeded
  ) {
    return null;
  }

  const material = {
    evidenceVersion: "1" as const,
    validationSpecificationHash:
      record.validationSpecificationHash,
    decision: "temp_validation_passed" as const,
    issueCodes: [] as readonly string[],
    steps: record.steps.map((step) => ({ ...step })),
    requiredStepCount: record.requiredStepCount,
    completedStepCount: record.completedStepCount,
    passedStepCount: record.passedStepCount,
    cleanupRequired: true as const,
    cleanupSucceeded: record.workspaceCleanupSucceeded
  };

  if (
    hashCanonicalJson(material) !==
    record.currentExecutionResultHash
  ) {
    return null;
  }

  return deepFreeze({
    ...material,
    verificationResultHash:
      record.currentExecutionResultHash
  });
}

function nonFinalValidationOutcome(
  result: ControlledPostApplyValidationResult
): {
  decision: IntegratedDisposableApplyDecision;
  route: IntegratedDisposableApplyRoute;
} {
  if (
    result.decision ===
      "controlled_post_apply_validation_rolled_back" ||
    result.summary.finalRepositoryState ===
      "restored_x1_baseline"
  ) {
    return {
      decision: "integrated_disposable_apply_rolled_back",
      route: "replan_required"
    };
  }

  if (
    result.decision ===
      "controlled_post_apply_validation_needs_review"
  ) {
    return {
      decision: "integrated_disposable_apply_needs_review",
      route:
        result.summary.finalRepositoryState ===
          "unsafe_unknown_state"
          ? "recovery_required"
          : "human_review_required"
    };
  }

  if (
    result.decision ===
      "controlled_post_apply_validation_rollback_failed" ||
    result.summary.finalRepositoryState ===
      "unsafe_unknown_state"
  ) {
    return {
      decision:
        "integrated_disposable_apply_recovery_required",
      route: "recovery_required"
    };
  }

  return {
    decision:
      "integrated_disposable_apply_recovery_required",
    route: "recovery_required"
  };
}

export async function runIntegratedDisposableApply(
  input: RunIntegratedDisposableApplyInput
): Promise<IntegratedDisposableApplyResult> {
  const summary = initialSummary();

  if (!validInput(input)) {
    return finish(
      "integrated_disposable_apply_invalid",
      "human_review_required",
      [
        issue(
          "integrated_disposable_apply_input_invalid",
          "Integrated disposable apply input is invalid.",
          "error"
        )
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  summary.inputValid = true;

  let bindingVerification:
    ContextToApplyBindingVerificationResult;

  try {
    bindingVerification =
      await verifyContextToApplyBindingReceipt(
        input.bindingReceipt,
        input.bindingInput
      );
  } catch {
    return finish(
      "integrated_disposable_apply_invalid",
      "human_review_required",
      [
        issue(
          "integrated_context_apply_binding_verification_failed",
          "Context-to-apply binding verification failed safely.",
          "error"
        )
      ],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  summary.bindingCurrentBeforeWrite =
    bindingVerification.downstreamEligible &&
    bindingVerification.decision ===
      "context_to_apply_binding_current";

  if (!summary.bindingCurrentBeforeWrite) {
    return finish(
      bindingVerification.decision ===
        "context_to_apply_binding_verification_invalid"
        ? "integrated_disposable_apply_invalid"
        : "integrated_disposable_apply_blocked",
      bindingVerification.currentResult.route ===
        "replan_required"
        ? "replan_required"
        : "human_review_required",
      [
        issue(
          "integrated_context_apply_binding_not_current",
          "The context-to-apply binding is not current for first write.",
          bindingVerification.currentResult.route ===
            "replan_required"
            ? "review"
            : "error"
        ),
        ...bindingVerification.errors.map((code) =>
          issue(
            code,
            "Context-to-apply verification reported a blocking reason.",
            "error"
          )
        )
      ],
      null,
      bindingVerification,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  const artifact =
    input.bindingInput.gateInput.artifact;

  summary.objectiveMatched =
    input.acceptanceContract.objectiveHash ===
    artifact.evidence.objectiveHash;

  if (!summary.objectiveMatched) {
    return finish(
      "integrated_disposable_apply_invalid",
      "human_review_required",
      [
        issue(
          "integrated_acceptance_objective_mismatch",
          "The acceptance contract objective does not match the governed artifact objective.",
          "error",
          { field: "acceptanceContract.objectiveHash" }
        )
      ],
      null,
      bindingVerification,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  summary.phaseVArtifactBindingMatched =
    input.phaseVExecutionVerification
      .verificationResultHash ===
    artifact.change
      .executionVerificationResultHash;

  if (!summary.phaseVArtifactBindingMatched) {
    return finish(
      "integrated_disposable_apply_invalid",
      "human_review_required",
      [
        issue(
          "integrated_phase_v_artifact_binding_mismatch",
          "The supplied Phase V evidence does not match the governed artifact.",
          "error"
        )
      ],
      null,
      bindingVerification,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  const preflightAcceptance =
    evaluateAcceptanceCriteria({
      contract:
        input.acceptanceContract,
      executionSpecification:
        input.phaseVExecutionSpecification,
      executionEvidence:
        input.phaseVExecutionVerification,
      humanReviewEvidence:
        input.humanReviewEvidence
    });

  const preflightCoverageVerification =
    preflightAcceptance.receipt === null
      ? null
      : verifyAcceptanceCriteriaCoverageReceipt(
          preflightAcceptance.receipt,
          input.acceptanceContract,
          input.phaseVExecutionVerification
        );

  summary.acceptancePreflightApproved =
    preflightAcceptance.decision ===
      "contract_approved" &&
    preflightAcceptance.receipt !== null &&
    preflightCoverageVerification !== null &&
    preflightCoverageVerification.downstreamEligible;

  if (!summary.acceptancePreflightApproved) {
    const stopped = preflightStop(
      preflightAcceptance
    );

    return finish(
      stopped.decision,
      stopped.route,
      preflightAcceptance.issues.map(
        (entry) =>
          issue(
            entry.code,
            entry.message,
            entry.severity,
            {
              ...(entry.field === undefined
                ? {}
                : { field: entry.field }),
              ...(entry.criterionId === undefined
                ? {}
                : {
                    criterionId:
                      entry.criterionId
                  })
            }
          )
      ),
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }


  const validationPreflight =
    await preflightIntegratedValidation(
      input
    );

  summary.validationPreflightReady =
    validationPreflight.kind ===
      "ready";

  if (
    !summary.validationPreflightReady
  ) {
    return finish(
      validationPreflight.kind ===
        "blocked"
        ? "integrated_disposable_apply_blocked"
        : validationPreflight.kind ===
              "review"
          ? "integrated_disposable_apply_needs_review"
          : "integrated_disposable_apply_invalid",
      validationPreflight.kind ===
        "blocked"
        ? "human_review_required"
        : validationPreflight.kind ===
              "review"
          ? "human_review_required"
          : "human_review_required",
      validationPreflight.issues,
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      null,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  summary.applyCallCount = 1;

  const applyResult =
    await executeControlledRepositoryApply({
      authorization:
        input.bindingInput
          .executionAuthorization,
      gateInput:
        input.bindingInput.gateInput,
      registryDirectoryPath:
        input.registryDirectoryPath
    });

  summary.x4ApplySucceeded =
    applyResult.decision ===
      "controlled_repository_apply_succeeded" &&
    applyResult.receipt !== null &&
    applyResult.receipt.outcome === "applied";

  if (!summary.x4ApplySucceeded) {
    const rollbackSucceeded =
      applyResult.decision ===
        "controlled_repository_apply_rolled_back" &&
      applyResult.receipt?.outcome ===
        "rolled_back";

    summary.repositoryFinalState =
      rollbackSucceeded
        ? "restored_x1_baseline"
        : applyResult.decision ===
              "controlled_repository_apply_rollback_failed"
          ? "unsafe_unknown_state"
          : null;

    return finish(
      rollbackSucceeded
        ? "integrated_disposable_apply_rolled_back"
        : applyResult.decision ===
              "controlled_repository_apply_rollback_failed"
          ? "integrated_disposable_apply_recovery_required"
          : applyResult.decision ===
                "controlled_repository_apply_needs_review"
            ? "integrated_disposable_apply_needs_review"
            : applyResult.decision ===
                  "controlled_repository_apply_invalid"
              ? "integrated_disposable_apply_invalid"
              : "integrated_disposable_apply_blocked",
      rollbackSucceeded
        ? "replan_required"
        : applyResult.decision ===
              "controlled_repository_apply_rollback_failed"
          ? "recovery_required"
          : "human_review_required",
      applyResult.issues.map(
        (entry) =>
          issue(
            entry.code,
            entry.message,
            entry.severity,
            entry.field === undefined
              ? {}
              : { field: entry.field }
          )
      ),
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      null,
      null,
      null,
      null,
      null,
      summary
    );
  }

  summary.validationCallCount = 1;

  const postApplyValidation =
    await executeControlledPostApplyValidation({
      applyReceipt:
        applyResult.receipt!,
      authorization:
        input.bindingInput
          .executionAuthorization,
      gateInput:
        input.bindingInput.gateInput,
      registryDirectoryPath:
        input.registryDirectoryPath,
      validationWorkspaceParentPath:
        input.validationWorkspaceParentPath,
      phaseVExecutionSpecification:
        input.phaseVExecutionSpecification,
      phaseVExecutionVerification:
        input.phaseVExecutionVerification
    });

  summary.x5ValidationFinalized =
    postApplyValidation.decision ===
      "controlled_post_apply_validation_finalized" &&
    postApplyValidation.finalReceipt?.outcome ===
      "validated";
  summary.x5RollbackExecuted =
    postApplyValidation.summary
      .emergencyRollbackExecuted;
  summary.x5RollbackSucceeded =
    postApplyValidation.summary
      .emergencyRollbackSucceeded;
  summary.repositoryFinalState =
    postApplyValidation.summary
      .finalRepositoryState;

  if (!summary.x5ValidationFinalized) {
    const stopped =
      nonFinalValidationOutcome(
        postApplyValidation
      );

    return finish(
      stopped.decision,
      stopped.route,
      postApplyValidation.issues.map(
        (entry) =>
          issue(
            entry.code,
            entry.message,
            entry.severity,
            entry.field === undefined
              ? {}
              : { field: entry.field }
          )
      ),
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      postApplyValidation,
      null,
      null,
      null,
      null,
      summary
    );
  }

  const finalExecutionEvidence =
    rebuildFinalExecutionEvidence(
      postApplyValidation
    );

  if (finalExecutionEvidence === null) {
    return finish(
      "integrated_disposable_apply_recovery_required",
      "recovery_required",
      [
        issue(
          "integrated_final_execution_evidence_invalid",
          "The finalized X.5 validation record could not be reconstructed as current acceptance evidence.",
          "error"
        )
      ],
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      postApplyValidation,
      null,
      null,
      null,
      null,
      summary
    );
  }

  const finalAcceptance =
    evaluateAcceptanceCriteria({
      contract:
        input.acceptanceContract,
      executionSpecification:
        input.phaseVExecutionSpecification,
      executionEvidence:
        finalExecutionEvidence,
      humanReviewEvidence:
        input.humanReviewEvidence
    });

  const finalCoverageVerification =
    finalAcceptance.receipt === null
      ? null
      : verifyAcceptanceCriteriaCoverageReceipt(
          finalAcceptance.receipt,
          input.acceptanceContract,
          finalExecutionEvidence
        );

  summary.finalAcceptanceApproved =
    finalAcceptance.decision ===
      "contract_approved" &&
    finalAcceptance.receipt !== null &&
    finalCoverageVerification !== null &&
    finalCoverageVerification.downstreamEligible;

  if (!summary.finalAcceptanceApproved) {
    return finish(
      "integrated_disposable_apply_recovery_required",
      "recovery_required",
      [
        issue(
          "integrated_final_acceptance_not_approved",
          "X.5 finalized but the deterministic acceptance contract did not approve the current evidence.",
          "error"
        ),
        ...finalAcceptance.issues.map(
          (entry) =>
            issue(
              entry.code,
              entry.message,
              entry.severity,
              {
                ...(entry.field === undefined
                  ? {}
                  : { field: entry.field }),
                ...(entry.criterionId === undefined
                  ? {}
                  : {
                      criterionId:
                        entry.criterionId
                    })
              }
            )
        )
      ],
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      postApplyValidation,
      finalExecutionEvidence,
      finalAcceptance,
      finalCoverageVerification,
      null,
      summary
    );
  }

  const finalReceiptVerification =
    await verifyControlledPostApplyFinalReceipt({
      repositoryPath:
        input.bindingInput.gateInput
          .repositoryPath,
      registryDirectoryPath:
        input.registryDirectoryPath,
      receipt:
        postApplyValidation.finalReceipt!,
      applyReceipt:
        applyResult.receipt!,
      authorization:
        input.bindingInput
          .executionAuthorization,
      expectedInspection:
        input.bindingInput.gateInput
          .expectedInspection
    });

  summary.finalReceiptCurrent =
    finalReceiptVerification.decision ===
      "controlled_post_apply_final_receipt_current" &&
    finalReceiptVerification
      .repositoryStateMatched;

  if (!summary.finalReceiptCurrent) {
    return finish(
      finalReceiptVerification.decision ===
        "controlled_post_apply_final_receipt_requires_recovery"
        ? "integrated_disposable_apply_recovery_required"
        : "integrated_disposable_apply_invalid",
      finalReceiptVerification.decision ===
        "controlled_post_apply_final_receipt_requires_recovery"
        ? "recovery_required"
        : "human_review_required",
      finalReceiptVerification.reasonCodes.map(
        (code) =>
          issue(
            code,
            "The X.5 final receipt is not current.",
            "error"
          )
      ),
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      postApplyValidation,
      finalExecutionEvidence,
      finalAcceptance,
      finalCoverageVerification,
      finalReceiptVerification,
      summary
    );
  }

  const bindingReceipt =
    input.bindingReceipt;
  const preflightReceipt =
    preflightAcceptance.receipt!;
  const finalCoverageReceipt =
    finalAcceptance.receipt!;
  const x4Receipt =
    applyResult.receipt!;
  const x5Receipt =
    postApplyValidation.finalReceipt!;

  if (
    x4Receipt.after.appliedStateHash === null ||
    x4Receipt.after.finalScopeHash === null ||
    x5Receipt.validation
      .currentExecutionResultHash === null ||
    x5Receipt.repository
      .finalInspectionHash === null ||
    x5Receipt.repository
      .finalRepositoryState !==
      "validated_applied_state"
  ) {
    return finish(
      "integrated_disposable_apply_recovery_required",
      "recovery_required",
      [
        issue(
          "integrated_final_receipt_material_incomplete",
          "Final applied-state evidence is incomplete.",
          "error"
        )
      ],
      null,
      bindingVerification,
      preflightAcceptance,
      preflightCoverageVerification,
      applyResult,
      postApplyValidation,
      finalExecutionEvidence,
      finalAcceptance,
      finalCoverageVerification,
      finalReceiptVerification,
      summary
    );
  }

  const receiptWithoutHash:
    Omit<
      IntegratedDisposableApplyReceipt,
      "receiptHash"
    > = {
    receiptVersion:
      INTEGRATED_DISPOSABLE_APPLY_VERSION,
    outcome:
      "contract_approved",
    contextToApplyBindingHash:
      bindingReceipt.bindingHash,
    contextAuthorizationHash:
      bindingReceipt
        .contextAuthorizationHash,
    coderMutationHash:
      bindingReceipt.coderMutationHash,
    repairMutationHash:
      bindingReceipt.repairMutationHash,
    executionAuthorizationHash:
      bindingReceipt
        .executionAuthorizationHash,
    governedArtifactHash:
      bindingReceipt.governedArtifactHash,
    handoffHash:
      bindingReceipt.handoffHash,
    consumptionKey:
      bindingReceipt.consumptionKey,
    acceptance: {
      contractHash:
        input.acceptanceContract
          .contractHash,
      preflightCoverageReceiptHash:
        preflightReceipt.receiptHash,
      finalCoverageReceiptHash:
        finalCoverageReceipt.receiptHash,
      requiredCriterionCount:
        finalCoverageReceipt
          .requiredCriterionCount,
      approvedCriterionCount:
        finalCoverageReceipt
          .approvedCriterionCount,
      coverageComplete: true
    },
    apply: {
      x4ApplyReceiptHash:
        x4Receipt.receiptHash,
      appliedStateHash:
        x4Receipt.after
          .appliedStateHash,
      finalScopeHash:
        x4Receipt.after
          .finalScopeHash,
      changedFiles:
        [...x4Receipt.mutation
          .changedFiles]
    },
    validation: {
      x5FinalReceiptHash:
        x5Receipt.receiptHash,
      currentExecutionResultHash:
        x5Receipt.validation
          .currentExecutionResultHash,
      finalInspectionHash:
        x5Receipt.repository
          .finalInspectionHash,
      finalRepositoryState:
        "validated_applied_state"
    },
    preconditions: {
      bindingCurrentBeforeWrite: true,
      objectiveMatched: true,
      phaseVArtifactBindingMatched: true,
      acceptancePreflightApproved: true,
      x4ApplySucceeded: true,
      x5ValidationFinalized: true,
      finalAcceptanceApproved: true,
      x5FinalReceiptCurrent: true,
      repositoryValidatedAppliedState: true
    }
  };

  const receipt =
    deepFreeze({
      ...receiptWithoutHash,
      receiptHash:
        hashCanonicalJson(
          receiptWithoutHash
        )
    });

  summary.integratedReceiptBuilt =
    true;

  return finish(
    "integrated_disposable_apply_finalized",
    "contract_approved",
    [],
    receipt,
    bindingVerification,
    preflightAcceptance,
    preflightCoverageVerification,
    applyResult,
    postApplyValidation,
    finalExecutionEvidence,
    finalAcceptance,
    finalCoverageVerification,
    finalReceiptVerification,
    summary
  );
}

export async function verifyIntegratedDisposableApplyReceipt(
  input: VerifyIntegratedDisposableApplyReceiptInput
): Promise<IntegratedDisposableApplyReceiptVerificationResult> {
  const errors: string[] = [];
  let receiptIntegrityVerified = false;
  let evidenceBindingsMatched = false;
  let acceptanceCoverageCurrent = false;
  let x5FinalReceiptCurrent = false;
  let repositoryStateMatched = false;
  let x5Verification:
    ControlledPostApplyFinalReceiptVerificationResult | null =
    null;

  try {
    receiptIntegrityVerified =
      input !== null &&
      typeof input === "object" &&
      input.receipt !== null &&
      typeof input.receipt === "object" &&
      HASH.test(input.receipt.receiptHash) &&
      hashCanonicalJson(
        receiptCore(input.receipt)
      ) === input.receipt.receiptHash;
  } catch {
    receiptIntegrityVerified = false;
  }

  if (!receiptIntegrityVerified) {
    errors.push(
      "integrated_disposable_apply_receipt_hash_mismatch"
    );
  }

  let bindingIntegrity = false;

  try {
    bindingIntegrity =
      HASH.test(
        input.bindingReceipt
          .bindingHash
      ) &&
      hashCanonicalJson(
        bindingReceiptCore(
          input.bindingReceipt
        )
      ) ===
        input.bindingReceipt
          .bindingHash;
  } catch {
    bindingIntegrity = false;
  }

  if (!bindingIntegrity) {
    errors.push(
      "integrated_context_apply_binding_hash_mismatch"
    );
  }

  try {
    evidenceBindingsMatched =
      bindingIntegrity &&
      input.receipt
        .contextToApplyBindingHash ===
        input.bindingReceipt
          .bindingHash &&
      input.receipt
        .contextAuthorizationHash ===
        input.bindingReceipt
          .contextAuthorizationHash &&
      input.receipt
        .coderMutationHash ===
        input.bindingReceipt
          .coderMutationHash &&
      input.receipt
        .repairMutationHash ===
        input.bindingReceipt
          .repairMutationHash &&
      input.receipt
        .executionAuthorizationHash ===
        input.bindingReceipt
          .executionAuthorizationHash &&
      input.receipt
        .governedArtifactHash ===
        input.bindingReceipt
          .governedArtifactHash &&
      input.receipt
        .handoffHash ===
        input.bindingReceipt
          .handoffHash &&
      input.receipt
        .consumptionKey ===
        input.bindingReceipt
          .consumptionKey &&
      input.receipt
        .acceptance.contractHash ===
        input.acceptanceContract
          .contractHash &&
      input.receipt
        .acceptance
        .preflightCoverageReceiptHash ===
        input.preflightCoverageReceipt
          .receiptHash &&
      input.receipt
        .acceptance
        .finalCoverageReceiptHash ===
        input.finalCoverageReceipt
          .receiptHash &&
      input.receipt
        .apply.x4ApplyReceiptHash ===
        input.applyReceipt
          .receiptHash &&
      input.receipt
        .validation.x5FinalReceiptHash ===
        input.postApplyFinalReceipt
          .receiptHash &&
      input.receipt
        .validation
        .currentExecutionResultHash ===
        input.finalExecutionEvidence
          .verificationResultHash &&
      input.receipt
        .executionAuthorizationHash ===
        input.executionAuthorization
          .authorizationHash &&
      canonicalEqual(
        input.receipt
          .apply.changedFiles,
        input.applyReceipt
          .mutation.changedFiles
      );
  } catch {
    evidenceBindingsMatched = false;
  }

  if (!evidenceBindingsMatched) {
    errors.push(
      "integrated_disposable_apply_evidence_binding_mismatch"
    );
  }

  const coverage =
    verifyAcceptanceCriteriaCoverageReceipt(
      input.finalCoverageReceipt,
      input.acceptanceContract,
      input.finalExecutionEvidence
    );

  acceptanceCoverageCurrent =
    coverage.downstreamEligible &&
    coverage.decision ===
      "acceptance_coverage_current";

  if (!acceptanceCoverageCurrent) {
    errors.push(
      ...coverage.errors,
      "integrated_final_acceptance_coverage_not_current"
    );
  }

  try {
    x5Verification =
      await verifyControlledPostApplyFinalReceipt({
        repositoryPath:
          input.bindingInput.gateInput
            .repositoryPath,
        registryDirectoryPath:
          input.registryDirectoryPath,
        receipt:
          input.postApplyFinalReceipt,
        applyReceipt:
          input.applyReceipt,
        authorization:
          input.executionAuthorization,
        expectedInspection:
          input.bindingInput.gateInput
            .expectedInspection
      });

    x5FinalReceiptCurrent =
      x5Verification.decision ===
        "controlled_post_apply_final_receipt_current";
    repositoryStateMatched =
      x5Verification
        .repositoryStateMatched;
  } catch {
    x5FinalReceiptCurrent =
      false;
    repositoryStateMatched =
      false;
  }

  if (!x5FinalReceiptCurrent) {
    errors.push(
      ...(x5Verification?.reasonCodes ?? []),
      "integrated_x5_final_receipt_not_current"
    );
  }

  if (!repositoryStateMatched) {
    errors.push(
      "integrated_repository_state_mismatch"
    );
  }

  const downstreamEligible =
    errors.length === 0 &&
    receiptIntegrityVerified &&
    evidenceBindingsMatched &&
    acceptanceCoverageCurrent &&
    x5FinalReceiptCurrent &&
    repositoryStateMatched &&
    input.receipt.outcome ===
      "contract_approved" &&
    input.receipt.acceptance
      .coverageComplete &&
    input.receipt.acceptance
      .approvedCriterionCount ===
      input.receipt.acceptance
        .requiredCriterionCount;

  return deepFreeze({
    decision:
      !receiptIntegrityVerified ||
      !evidenceBindingsMatched
        ? "integrated_disposable_apply_receipt_invalid"
        : x5Verification?.decision ===
              "controlled_post_apply_final_receipt_requires_recovery"
          ? "integrated_disposable_apply_receipt_requires_recovery"
          : downstreamEligible
            ? "integrated_disposable_apply_receipt_current"
            : "integrated_disposable_apply_receipt_stale",
    errors: [...new Set(errors)].sort(),
    receiptIntegrityVerified,
    evidenceBindingsMatched,
    acceptanceCoverageCurrent,
    x5FinalReceiptCurrent,
    repositoryStateMatched,
    downstreamEligible,
    x5Verification
  });
}
