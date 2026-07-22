import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  computeTemporaryWorkspaceExecutionSpecificationHash,
  type TemporaryWorkspaceExecutionSpecification,
  type TemporaryWorkspaceExecutionVerificationEvidence
} from "./temporary-workspace-execution-verifier.js";

export const ACCEPTANCE_CRITERIA_CONTRACT_VERSION = "1" as const;
export const ACCEPTANCE_CRITERIA_EVIDENCE_VERSION = "1" as const;

export type AcceptanceCriterionEvidenceBinding =
  | {
      kind: "test" | "static_check";
      commandId: string;
    }
  | {
      kind: "human_review";
      reviewKey: string;
    };

export type AcceptanceCriterion = {
  id: string;
  description: string;
  required: true;
  evidence: AcceptanceCriterionEvidenceBinding;
};

export type AcceptanceCriteriaContract = {
  contractVersion: "1";
  taskId: string;
  objectiveHash: string;
  criteria: readonly AcceptanceCriterion[];
  contractHash: string;
};

export type AcceptanceCriteriaContractInput = {
  taskId: string;
  objectiveHash: string;
  criteria: readonly AcceptanceCriterion[];
};

export type HumanReviewAcceptanceEvidenceInput = {
  reviewKey: string;
  criterionId: string;
  reviewerIdentityHash: string;
  decision: "approved" | "rejected" | "needs_review";
  reviewedAt: string;
  rationaleHash: string;
};

export type HumanReviewAcceptanceEvidence =
  HumanReviewAcceptanceEvidenceInput & {
    evidenceVersion: "1";
    evidenceHash: string;
  };

export type AcceptanceCriterionAssessment = {
  criterionId: string;
  evidenceKind: AcceptanceCriterionEvidenceBinding["kind"];
  decision: "approved" | "failed" | "needs_review" | "invalid";
  evidenceReference: string;
  evidenceHash: string | null;
  reasonCodes: readonly string[];
};

export type AcceptanceCriteriaEvaluationDecision =
  | "contract_approved"
  | "contract_failed"
  | "contract_needs_review"
  | "contract_invalid";

export type AcceptanceCriteriaCoverageReceipt = {
  receiptVersion: "1";
  decision: Exclude<AcceptanceCriteriaEvaluationDecision, "contract_invalid">;
  contractHash: string;
  validationSpecificationHash: string;
  executionVerificationResultHash: string;
  criteria: readonly AcceptanceCriterionAssessment[];
  requiredCriterionCount: number;
  approvedCriterionCount: number;
  failedCriterionCount: number;
  needsReviewCriterionCount: number;
  coverageComplete: boolean;
  receiptHash: string;
};


export type AcceptanceCriteriaCoverageVerificationResult = {
  decision:
    | "acceptance_coverage_current"
    | "acceptance_coverage_not_approved"
    | "acceptance_coverage_invalid";
  errors: readonly string[];
  receiptIntegrityVerified: boolean;
  contractMatched: boolean;
  executionEvidenceMatched: boolean;
  criterionBindingsMatched: boolean;
  downstreamEligible: boolean;
};

export type AcceptanceCriteriaEvaluationIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  criterionId?: string;
  field?: string;
};

export type EvaluateAcceptanceCriteriaInput = {
  contract: AcceptanceCriteriaContract;
  executionSpecification: TemporaryWorkspaceExecutionSpecification;
  executionEvidence: TemporaryWorkspaceExecutionVerificationEvidence;
  humanReviewEvidence?: readonly HumanReviewAcceptanceEvidence[];
};

export type AcceptanceCriteriaEvaluationResult = {
  decision: AcceptanceCriteriaEvaluationDecision;
  issues: readonly AcceptanceCriteriaEvaluationIssue[];
  receipt: AcceptanceCriteriaCoverageReceipt | null;
  summary: {
    contractIntegrityVerified: boolean;
    executionSpecificationMatched: boolean;
    executionEvidenceIntegrityVerified: boolean;
    requiredCriterionCount: number;
    approvedCriterionCount: number;
    failedCriterionCount: number;
    needsReviewCriterionCount: number;
    invalidCriterionCount: number;
    coverageComplete: boolean;
  };
};

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const MAX_CRITERIA = 100;
const MAX_DESCRIPTION_LENGTH = 1000;

class AcceptanceInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly criterionId?: string
  ) {
    super(message);
  }
}

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

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: { criterionId?: string; field?: string } = {}
): AcceptanceCriteriaEvaluationIssue {
  return { code, message, severity, ...extra };
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcceptanceInputError("acceptance_object_invalid", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AcceptanceInputError("acceptance_object_invalid", `${label} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AcceptanceInputError("acceptance_symbol_property", `${label} cannot contain symbol properties.`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new AcceptanceInputError("acceptance_unknown_field", `${label} contains an unknown field.`, key);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new AcceptanceInputError("acceptance_missing_field", `${label} is missing a required field.`, key);
    }
  }
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AcceptanceInputError("acceptance_identifier_invalid", `${field} must be a bounded identifier.`, field);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new AcceptanceInputError("acceptance_hash_invalid", `${field} must be a sha256 hash.`, field);
  }
  return value;
}

function normalizeCriterion(value: unknown): AcceptanceCriterion {
  const record = requirePlainObject(value, "Acceptance criterion");
  requireExactFields(record, ["id", "description", "required", "evidence"], ["id", "description", "required", "evidence"], "Acceptance criterion");
  const id = record.id;
  if (typeof id !== "string" || !CRITERION_ID.test(id)) {
    throw new AcceptanceInputError("acceptance_criterion_id_invalid", "Criterion id must use lowercase bounded identifier syntax.", "id");
  }
  const description = record.description;
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH ||
    description.trim() !== description ||
    ASCII_CONTROL.test(description)
  ) {
    throw new AcceptanceInputError("acceptance_description_invalid", "Criterion description must be a bounded non-empty string.", "description", id);
  }
  if (record.required !== true) {
    throw new AcceptanceInputError("acceptance_required_must_be_true", "Every version 1 acceptance criterion must be required.", "required", id);
  }
  const evidenceRecord = requirePlainObject(record.evidence, "Acceptance evidence binding");
  const kind = evidenceRecord.kind;
  if (kind === "test" || kind === "static_check") {
    requireExactFields(evidenceRecord, ["kind", "commandId"], ["kind", "commandId"], "Acceptance evidence binding");
    return {
      id,
      description,
      required: true,
      evidence: {
        kind,
        commandId: requireIdentifier(evidenceRecord.commandId, "commandId")
      }
    };
  }
  if (kind === "human_review") {
    requireExactFields(evidenceRecord, ["kind", "reviewKey"], ["kind", "reviewKey"], "Acceptance evidence binding");
    return {
      id,
      description,
      required: true,
      evidence: {
        kind,
        reviewKey: requireIdentifier(evidenceRecord.reviewKey, "reviewKey")
      }
    };
  }
  throw new AcceptanceInputError("acceptance_evidence_kind_invalid", "Evidence kind must be test, static_check, or human_review.", "evidence.kind", id);
}

function contractCore(contract: AcceptanceCriteriaContract): Omit<AcceptanceCriteriaContract, "contractHash"> {
  const { contractHash: _, ...core } = contract;
  return core;
}

function humanReviewCore(evidence: HumanReviewAcceptanceEvidence): Omit<HumanReviewAcceptanceEvidence, "evidenceHash"> {
  const { evidenceHash: _, ...core } = evidence;
  return core;
}

function executionEvidenceCore(
  evidence: TemporaryWorkspaceExecutionVerificationEvidence
): Omit<TemporaryWorkspaceExecutionVerificationEvidence, "verificationResultHash"> {
  const { verificationResultHash: _, ...core } = evidence;
  return core;
}

function stepCore(step: TemporaryWorkspaceExecutionVerificationEvidence["steps"][number]): Omit<typeof step, "stepHash"> {
  const { stepHash: _, ...core } = step;
  return core;
}

export function createAcceptanceCriteriaContract(input: AcceptanceCriteriaContractInput): AcceptanceCriteriaContract {
  const record = requirePlainObject(input, "Acceptance criteria contract input");
  requireExactFields(record, ["taskId", "objectiveHash", "criteria"], ["taskId", "objectiveHash", "criteria"], "Acceptance criteria contract input");
  const taskId = requireIdentifier(record.taskId, "taskId");
  const objectiveHash = requireHash(record.objectiveHash, "objectiveHash");
  if (!Array.isArray(record.criteria) || record.criteria.length === 0 || record.criteria.length > MAX_CRITERIA) {
    throw new AcceptanceInputError("acceptance_criteria_count_invalid", `criteria must contain between 1 and ${MAX_CRITERIA} entries.`, "criteria");
  }
  const criteria = record.criteria.map(normalizeCriterion);
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) {
      throw new AcceptanceInputError("acceptance_criterion_duplicate", "Criterion ids must be unique.", "criteria", criterion.id);
    }
    ids.add(criterion.id);
  }
  const core = {
    contractVersion: ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
    taskId,
    objectiveHash,
    criteria
  } as const;
  return deepFreeze({ ...core, contractHash: hashCanonicalJson(core) });
}

export function createHumanReviewAcceptanceEvidence(
  input: HumanReviewAcceptanceEvidenceInput
): HumanReviewAcceptanceEvidence {
  const record = requirePlainObject(input, "Human review acceptance evidence input");
  requireExactFields(
    record,
    ["reviewKey", "criterionId", "reviewerIdentityHash", "decision", "reviewedAt", "rationaleHash"],
    ["reviewKey", "criterionId", "reviewerIdentityHash", "decision", "reviewedAt", "rationaleHash"],
    "Human review acceptance evidence input"
  );
  const reviewKey = requireIdentifier(record.reviewKey, "reviewKey");
  const criterionId = record.criterionId;
  if (typeof criterionId !== "string" || !CRITERION_ID.test(criterionId)) {
    throw new AcceptanceInputError("acceptance_criterion_id_invalid", "criterionId is invalid.", "criterionId");
  }
  const reviewerIdentityHash = requireHash(record.reviewerIdentityHash, "reviewerIdentityHash");
  const rationaleHash = requireHash(record.rationaleHash, "rationaleHash");
  const decision = record.decision;
  if (decision !== "approved" && decision !== "rejected" && decision !== "needs_review") {
    throw new AcceptanceInputError("acceptance_review_decision_invalid", "Human review decision is invalid.", "decision", criterionId);
  }
  const reviewedAt = record.reviewedAt;
  if (typeof reviewedAt !== "string" || !ISO_8601.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) {
    throw new AcceptanceInputError("acceptance_review_time_invalid", "reviewedAt must be a valid ISO-8601 timestamp.", "reviewedAt", criterionId);
  }
  const core = {
    evidenceVersion: ACCEPTANCE_CRITERIA_EVIDENCE_VERSION,
    reviewKey,
    criterionId,
    reviewerIdentityHash,
    decision,
    reviewedAt,
    rationaleHash
  } as const;
  return deepFreeze({ ...core, evidenceHash: hashCanonicalJson(core) });
}

function verifyExecutionEvidence(
  specification: TemporaryWorkspaceExecutionSpecification,
  evidence: TemporaryWorkspaceExecutionVerificationEvidence
): string[] {
  const errors: string[] = [];
  const specificationHash = computeTemporaryWorkspaceExecutionSpecificationHash(specification);
  if (evidence.validationSpecificationHash !== specificationHash) errors.push("validation_specification_hash_mismatch");
  if (evidence.evidenceVersion !== "1") errors.push("execution_evidence_version_invalid");
  if (evidence.requiredStepCount !== specification.commands.length) errors.push("required_step_count_mismatch");
  if (evidence.steps.length !== specification.commands.length) errors.push("execution_step_count_mismatch");
  if (evidence.completedStepCount !== evidence.steps.length) errors.push("completed_step_count_mismatch");
  const passedCount = evidence.steps.filter((step) => step.passed).length;
  if (evidence.passedStepCount !== passedCount) errors.push("passed_step_count_mismatch");
  for (let index = 0; index < specification.commands.length; index += 1) {
    const command = specification.commands[index];
    const step = evidence.steps[index];
    if (step === undefined) continue;
    const expectedIdentifierHash = hashCanonicalJson({
      artifactType: "temporary_workspace_execution_step_identifier",
      index,
      id: command.id,
      executable: command.executable,
      args: command.args
    });
    if (step.index !== index) errors.push(`execution_step_index_mismatch:${index}`);
    if (step.stepIdentifierHash !== expectedIdentifierHash) errors.push(`execution_step_identifier_mismatch:${index}`);
    if (hashCanonicalJson(stepCore(step)) !== step.stepHash) errors.push(`execution_step_hash_mismatch:${index}`);
  }
  if (hashCanonicalJson(executionEvidenceCore(evidence)) !== evidence.verificationResultHash) {
    errors.push("execution_verification_hash_mismatch");
  }
  if (evidence.cleanupRequired !== true || evidence.cleanupSucceeded !== true) errors.push("execution_cleanup_incomplete");
  if (evidence.decision === "temp_validation_passed" && passedCount !== specification.commands.length) {
    errors.push("execution_pass_decision_inconsistent");
  }
  if (evidence.decision === "temp_validation_failed" && passedCount === specification.commands.length) {
    errors.push("execution_failure_decision_inconsistent");
  }
  return errors;
}

function invalidResult(
  issues: AcceptanceCriteriaEvaluationIssue[],
  summary: AcceptanceCriteriaEvaluationResult["summary"]
): AcceptanceCriteriaEvaluationResult {
  return { decision: "contract_invalid", issues, receipt: null, summary };
}

export function evaluateAcceptanceCriteria(
  input: EvaluateAcceptanceCriteriaInput
): AcceptanceCriteriaEvaluationResult {
  const summary: AcceptanceCriteriaEvaluationResult["summary"] = {
    contractIntegrityVerified: false,
    executionSpecificationMatched: false,
    executionEvidenceIntegrityVerified: false,
    requiredCriterionCount: 0,
    approvedCriterionCount: 0,
    failedCriterionCount: 0,
    needsReviewCriterionCount: 0,
    invalidCriterionCount: 0,
    coverageComplete: false
  };
  const issues: AcceptanceCriteriaEvaluationIssue[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidResult([issue("acceptance_evaluation_input_invalid", "Evaluation input must be an object.", "error")], summary);
  }
  let normalizedContract: AcceptanceCriteriaContract;
  try {
    const core = contractCore(input.contract);
    normalizedContract = createAcceptanceCriteriaContract({
      taskId: core.taskId,
      objectiveHash: core.objectiveHash,
      criteria: core.criteria
    });
  } catch (error) {
    return invalidResult([issue("acceptance_contract_invalid", error instanceof Error ? error.message : "Acceptance contract is invalid.", "error")], summary);
  }
  if (normalizedContract.contractHash !== input.contract.contractHash) {
    return invalidResult([issue("acceptance_contract_hash_mismatch", "Acceptance contract integrity verification failed.", "error")], summary);
  }
  summary.contractIntegrityVerified = true;
  summary.requiredCriterionCount = normalizedContract.criteria.length;
  const specificationHash = computeTemporaryWorkspaceExecutionSpecificationHash(input.executionSpecification);
  summary.executionSpecificationMatched = input.executionEvidence.validationSpecificationHash === specificationHash;
  const executionErrors = verifyExecutionEvidence(input.executionSpecification, input.executionEvidence);
  if (executionErrors.length > 0) {
    return invalidResult(
      executionErrors.map((code) => issue(code, "Temporary execution evidence failed deterministic verification.", "error")),
      summary
    );
  }
  summary.executionEvidenceIntegrityVerified = true;
  const commandIndex = new Map<string, number>();
  for (let index = 0; index < input.executionSpecification.commands.length; index += 1) {
    const commandId = input.executionSpecification.commands[index].id;
    if (commandIndex.has(commandId)) {
      return invalidResult([issue("acceptance_command_id_duplicate", "Execution command ids must be unique.", "error", { field: "commands" })], summary);
    }
    commandIndex.set(commandId, index);
  }
  const reviews = new Map<string, HumanReviewAcceptanceEvidence>();
  for (const review of input.humanReviewEvidence ?? []) {
    if (reviews.has(review.reviewKey)) {
      return invalidResult([issue("acceptance_review_key_duplicate", "Human review evidence keys must be unique.", "error")], summary);
    }
    if (hashCanonicalJson(humanReviewCore(review)) !== review.evidenceHash) {
      return invalidResult([issue("acceptance_review_hash_mismatch", "Human review evidence integrity verification failed.", "error", { criterionId: review.criterionId })], summary);
    }
    reviews.set(review.reviewKey, review);
  }
  const assessments: AcceptanceCriterionAssessment[] = [];
  for (const criterion of normalizedContract.criteria) {
    if (criterion.evidence.kind === "test" || criterion.evidence.kind === "static_check") {
      const index = commandIndex.get(criterion.evidence.commandId);
      if (index === undefined) {
        assessments.push({
          criterionId: criterion.id,
          evidenceKind: criterion.evidence.kind,
          decision: "invalid",
          evidenceReference: criterion.evidence.commandId,
          evidenceHash: null,
          reasonCodes: ["criterion_command_missing"]
        });
        continue;
      }
      const step = input.executionEvidence.steps[index];
      const decision = step.passed
        ? input.executionEvidence.decision === "temp_validation_needs_review"
          ? "needs_review"
          : "approved"
        : "failed";
      assessments.push({
        criterionId: criterion.id,
        evidenceKind: criterion.evidence.kind,
        decision,
        evidenceReference: criterion.evidence.commandId,
        evidenceHash: step.stepHash,
        reasonCodes: decision === "approved" ? [] : [decision === "failed" ? "criterion_command_failed" : "execution_needs_review"]
      });
      continue;
    }
    const humanBinding = criterion.evidence as Extract<
      AcceptanceCriterionEvidenceBinding,
      { kind: "human_review" }
    >;
    const review = reviews.get(humanBinding.reviewKey);
    if (review === undefined) {
      assessments.push({
        criterionId: criterion.id,
        evidenceKind: "human_review",
        decision: "needs_review",
        evidenceReference: humanBinding.reviewKey,
        evidenceHash: null,
        reasonCodes: ["human_review_missing"]
      });
      continue;
    }
    if (review.criterionId !== criterion.id) {
      assessments.push({
        criterionId: criterion.id,
        evidenceKind: "human_review",
        decision: "invalid",
        evidenceReference: humanBinding.reviewKey,
        evidenceHash: review.evidenceHash,
        reasonCodes: ["human_review_criterion_mismatch"]
      });
      continue;
    }
    assessments.push({
      criterionId: criterion.id,
      evidenceKind: "human_review",
      decision: review.decision === "approved" ? "approved" : review.decision === "rejected" ? "failed" : "needs_review",
      evidenceReference: humanBinding.reviewKey,
      evidenceHash: review.evidenceHash,
      reasonCodes: review.decision === "approved" ? [] : [review.decision === "rejected" ? "human_review_rejected" : "human_review_needs_review"]
    });
  }
  summary.approvedCriterionCount = assessments.filter((entry) => entry.decision === "approved").length;
  summary.failedCriterionCount = assessments.filter((entry) => entry.decision === "failed").length;
  summary.needsReviewCriterionCount = assessments.filter((entry) => entry.decision === "needs_review").length;
  summary.invalidCriterionCount = assessments.filter((entry) => entry.decision === "invalid").length;
  summary.coverageComplete = assessments.every((entry) => entry.evidenceHash !== null && entry.decision !== "invalid");
  if (summary.invalidCriterionCount > 0) {
    for (const assessment of assessments.filter((entry) => entry.decision === "invalid")) {
      issues.push(issue("acceptance_criterion_invalid", "Acceptance criterion evidence mapping is invalid.", "error", { criterionId: assessment.criterionId }));
    }
    return invalidResult(issues, summary);
  }
  const decision: Exclude<AcceptanceCriteriaEvaluationDecision, "contract_invalid"> =
    summary.failedCriterionCount > 0
      ? "contract_failed"
      : summary.needsReviewCriterionCount > 0 || !summary.coverageComplete
        ? "contract_needs_review"
        : "contract_approved";
  const receiptCore = {
    receiptVersion: "1" as const,
    decision,
    contractHash: normalizedContract.contractHash,
    validationSpecificationHash: specificationHash,
    executionVerificationResultHash: input.executionEvidence.verificationResultHash,
    criteria: assessments,
    requiredCriterionCount: summary.requiredCriterionCount,
    approvedCriterionCount: summary.approvedCriterionCount,
    failedCriterionCount: summary.failedCriterionCount,
    needsReviewCriterionCount: summary.needsReviewCriterionCount,
    coverageComplete: summary.coverageComplete
  };
  const receipt = deepFreeze({ ...receiptCore, receiptHash: hashCanonicalJson(receiptCore) });
  if (decision === "contract_failed") issues.push(issue("acceptance_contract_failed", "At least one required acceptance criterion failed.", "review"));
  if (decision === "contract_needs_review") issues.push(issue("acceptance_contract_needs_review", "Acceptance evidence is incomplete or requires human review.", "review"));
  return { decision, issues, receipt, summary };
}


function coverageReceiptCore(
  receipt: AcceptanceCriteriaCoverageReceipt
): Omit<AcceptanceCriteriaCoverageReceipt, "receiptHash"> {
  const { receiptHash: _, ...core } = receipt;
  return core;
}

export function verifyAcceptanceCriteriaCoverageReceipt(
  receipt: AcceptanceCriteriaCoverageReceipt,
  contract: AcceptanceCriteriaContract,
  executionEvidence: TemporaryWorkspaceExecutionVerificationEvidence
): AcceptanceCriteriaCoverageVerificationResult {
  const errors: string[] = [];

  let receiptIntegrityVerified = false;
  let contractMatched = false;
  let executionEvidenceMatched = false;
  let criterionBindingsMatched = false;

  try {
    receiptIntegrityVerified =
      HASH.test(receipt.receiptHash) &&
      hashCanonicalJson(
        coverageReceiptCore(receipt)
      ) === receipt.receiptHash;
  } catch {
    receiptIntegrityVerified = false;
  }

  if (!receiptIntegrityVerified) {
    errors.push("acceptance_receipt_hash_mismatch");
  }

  contractMatched =
    receipt.contractHash ===
    contract.contractHash;

  if (!contractMatched) {
    errors.push("acceptance_receipt_contract_mismatch");
  }

  executionEvidenceMatched =
    receipt.executionVerificationResultHash ===
    executionEvidence.verificationResultHash &&
    receipt.validationSpecificationHash ===
    executionEvidence.validationSpecificationHash;

  if (!executionEvidenceMatched) {
    errors.push("acceptance_receipt_execution_mismatch");
  }

  try {
    const expected = contract.criteria
      .map((criterion) => ({
        criterionId: criterion.id,
        evidenceKind: criterion.evidence.kind,
        evidenceReference:
          criterion.evidence.kind === "human_review"
            ? criterion.evidence.reviewKey
            : criterion.evidence.commandId
      }))
      .sort((left, right) =>
        left.criterionId.localeCompare(
          right.criterionId
        )
      );

    const actual = receipt.criteria
      .map((criterion) => ({
        criterionId: criterion.criterionId,
        evidenceKind: criterion.evidenceKind,
        evidenceReference:
          criterion.evidenceReference
      }))
      .sort((left, right) =>
        left.criterionId.localeCompare(
          right.criterionId
        )
      );

    criterionBindingsMatched =
      hashCanonicalJson(expected) ===
      hashCanonicalJson(actual) &&
      receipt.requiredCriterionCount ===
        contract.criteria.length &&
      receipt.approvedCriterionCount ===
        receipt.criteria.filter(
          (entry) =>
            entry.decision === "approved"
        ).length &&
      receipt.failedCriterionCount ===
        receipt.criteria.filter(
          (entry) =>
            entry.decision === "failed"
        ).length &&
      receipt.needsReviewCriterionCount ===
        receipt.criteria.filter(
          (entry) =>
            entry.decision === "needs_review"
        ).length;
  } catch {
    criterionBindingsMatched = false;
  }

  if (!criterionBindingsMatched) {
    errors.push("acceptance_receipt_criteria_mismatch");
  }

  const downstreamEligible =
    errors.length === 0 &&
    receipt.decision === "contract_approved" &&
    receipt.coverageComplete &&
    receipt.failedCriterionCount === 0 &&
    receipt.needsReviewCriterionCount === 0 &&
    receipt.approvedCriterionCount ===
      receipt.requiredCriterionCount;

  return {
    decision:
      errors.length > 0
        ? "acceptance_coverage_invalid"
        : downstreamEligible
          ? "acceptance_coverage_current"
          : "acceptance_coverage_not_approved",
    errors,
    receiptIntegrityVerified,
    contractMatched,
    executionEvidenceMatched,
    criterionBindingsMatched,
    downstreamEligible
  };
}
