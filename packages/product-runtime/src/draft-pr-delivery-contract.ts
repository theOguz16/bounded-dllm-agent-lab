import { hashCanonicalJson } from "./agent-event-ledger.js";
import type {
  IntegratedDisposableApplyReceipt
} from "./integrated-disposable-apply-coordinator.js";
import type {
  ControlledRepositoryApplyReceipt
} from "./controlled-repository-apply.js";

export const DRAFT_PR_DELIVERY_CONTRACT_VERSION = "1" as const;

export type DraftPrReceiptEvidenceType =
  | "integrated_apply"
  | "context_to_apply"
  | "acceptance_contract"
  | "preflight_coverage"
  | "final_coverage"
  | "x4_apply"
  | "x5_final";

export type DraftPrReceiptEvidenceReference = {
  kind: "receipt";
  evidenceId: string;
  receiptType: DraftPrReceiptEvidenceType;
  receiptHash: string;
};

export type DraftPrFileEvidenceReference = {
  kind: "file";
  evidenceId: string;
  filePath: string;
  contentHash: string;
  sourceApplyReceiptHash: string;
};

export type DraftPrTestEvidenceReference = {
  kind: "test";
  evidenceId: string;
  commandId: string;
  resultHash: string;
  sourceValidationReceiptHash: string;
};

export type DraftPrEvidenceReference =
  | DraftPrReceiptEvidenceReference
  | DraftPrFileEvidenceReference
  | DraftPrTestEvidenceReference;

export type DraftPrDeliveryContract = {
  contractVersion: "1";
  deliveryKey: string;
  repository: {
    owner: string;
    name: string;
    repositoryIdentityHash: string;
    baseBranch: string;
    baseRevisionHash: string;
  };
  source: {
    integratedApplyReceiptHash: string;
    consumptionKey: string;
    governedArtifactHash: string;
    handoffHash: string;
    contextToApplyBindingHash: string;
    acceptanceContractHash: string;
    x4ApplyReceiptHash: string;
    x5FinalReceiptHash: string;
  };
  branch: {
    name: string;
    deterministic: true;
    baseBranchMustRemainUnchanged: true;
  };
  commit: {
    message: string;
    changedFiles: readonly string[];
    changedFileCount: number;
  };
  pullRequest: {
    draft: true;
    title: string;
    body: string;
    baseBranch: string;
    headBranch: string;
  };
  evidence: {
    references: readonly DraftPrEvidenceReference[];
    referenceCount: number;
    receiptReferenceCount: number;
    fileReferenceCount: number;
    testReferenceCount: number;
    evidenceSetHash: string;
    complete: true;
  };
  preconditions: {
    integratedReceiptIntegrityVerified: true;
    integratedOutcomeApproved: true;
    applyReceiptIntegrityVerified: true;
    appliedStateBound: true;
    exactChangedFileCoverage: true;
    typedEvidenceComplete: true;
    duplicateDeliveryForbidden: true;
    mainRepositoryMutationAllowed: false;
    gitWritePerformedByBuilder: false;
    githubWritePerformedByBuilder: false;
  };
  contractHash: string;
};

export type BuildDraftPrDeliveryContractInput = {
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
  repository: {
    owner: string;
    name: string;
    baseBranch: string;
  };
  commit: {
    message: string;
  };
  pullRequest: {
    title: string;
    body: string;
  };
  evidenceReferences: readonly DraftPrEvidenceReference[];
};

export type DraftPrDeliveryContractIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  evidenceId?: string;
};

export type BuildDraftPrDeliveryContractDecision =
  | "draft_pr_delivery_contract_ready"
  | "draft_pr_delivery_contract_invalid"
  | "draft_pr_delivery_contract_blocked";

export type BuildDraftPrDeliveryContractResult = {
  decision: BuildDraftPrDeliveryContractDecision;
  contract: DraftPrDeliveryContract | null;
  issues: readonly DraftPrDeliveryContractIssue[];
  summary: {
    inputValid: boolean;
    integratedReceiptIntegrityVerified: boolean;
    integratedOutcomeApproved: boolean;
    applyReceiptIntegrityVerified: boolean;
    applyReceiptBound: boolean;
    repositoryTargetValid: boolean;
    deliveryTextValid: boolean;
    evidenceReferencesValid: boolean;
    requiredReceiptEvidenceComplete: boolean;
    exactChangedFileCoverage: boolean;
    finalValidationEvidencePresent: boolean;
    contractBuilt: boolean;
    gitWritePerformed: false;
    githubWritePerformed: false;
  };
};

export type VerifyDraftPrDeliveryContractInput = {
  contract: DraftPrDeliveryContract;
  integratedReceipt: IntegratedDisposableApplyReceipt;
  applyReceipt: ControlledRepositoryApplyReceipt;
};

export type DraftPrDeliveryContractVerificationDecision =
  | "draft_pr_delivery_contract_current"
  | "draft_pr_delivery_contract_stale"
  | "draft_pr_delivery_contract_invalid";

export type DraftPrDeliveryContractVerificationResult = {
  decision: DraftPrDeliveryContractVerificationDecision;
  contractIntegrityVerified: boolean;
  sourceReceiptsMatched: boolean;
  evidenceBindingsMatched: boolean;
  downstreamEligible: boolean;
  staleFields: readonly string[];
  errors: readonly string[];
  gitWritePerformed: false;
  githubWritePerformed: false;
};

type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*(?:\/\/|\.{2}|@\{|\\|\s|[\u0000-\u001f\u007f~^:?*\[]))(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,180}$/;
const EVIDENCE_ID = /^[a-z][a-z0-9._-]{2,100}$/;
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_TEXT = 20_000;
const MAX_REFERENCES = 10_000;
const MAX_NODES = 250_000;

const REQUIRED_RECEIPTS: readonly DraftPrReceiptEvidenceType[] = [
  "integrated_apply",
  "context_to_apply",
  "acceptance_contract",
  "preflight_coverage",
  "final_coverage",
  "x4_apply",
  "x5_final"
];

class ContractFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: "invalid" | "blocked" = "invalid",
    readonly field?: string,
    readonly evidenceId?: string
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

function safeClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
  count = { value: 0 }
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new ContractFailure(
      "invalid_draft_pr_delivery_contract_object",
      "Unsupported delivery contract value."
    );
  }
  count.value += 1;
  if (count.value > MAX_NODES) {
    throw new ContractFailure(
      "draft_pr_delivery_contract_structure_too_large",
      "Delivery contract input exceeds its bounded structure."
    );
  }
  if (ancestors.has(value)) {
    throw new ContractFailure(
      "invalid_draft_pr_delivery_contract_object",
      "Cyclic delivery contract input is invalid."
    );
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype) ||
    (!array &&
      prototype !== Object.prototype &&
      prototype !== null)
  ) {
    throw new ContractFailure(
      "invalid_draft_pr_delivery_contract_object",
      "Exotic delivery contract input is invalid."
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ContractFailure(
      "draft_pr_delivery_contract_symbol_property",
      "Symbol properties are forbidden."
    );
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw new ContractFailure(
        "draft_pr_delivery_contract_accessor_property",
        "Accessor properties are forbidden."
      );
    }
  }
  ancestors.add(value);
  try {
    if (array) {
      const keys = Object.keys(descriptors)
        .filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some(
          (key, index) => key !== String(index)
        )
      ) {
        throw new ContractFailure(
          "invalid_draft_pr_delivery_contract_object",
          "Sparse or extended arrays are invalid."
        );
      }
      return value.map((entry) =>
        safeClone(entry, ancestors, count)
      );
    }
    const result: PlainRecord = {};
    for (
      const [key, descriptor]
      of Object.entries(descriptors)
    ) {
      result[key] = safeClone(
        descriptor.value,
        ancestors,
        count
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function hashWithout(
  value: PlainRecord,
  field: string
): string {
  const material = { ...value };
  delete material[field];
  return hashCanonicalJson(material);
}

function canonicalEqual(
  left: unknown,
  right: unknown
): boolean {
  try {
    return (
      hashCanonicalJson(left) ===
      hashCanonicalJson(right)
    );
  } catch {
    return false;
  }
}

function sortedUnique(
  values: readonly string[]
): string[] {
  return [...new Set(values)].sort(
    (left, right) => left.localeCompare(right)
  );
}

function validText(
  value: unknown,
  maximum: number,
  allowNewlines: boolean
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
      value
    ) &&
    (allowNewlines || !/[\r\n]/.test(value))
  );
}

function validPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".."
  );
}

function issue(
  failure: ContractFailure
): DraftPrDeliveryContractIssue {
  return {
    code: failure.code,
    message: failure.message,
    severity:
      failure.kind === "blocked"
        ? "review"
        : "error",
    ...(failure.field
      ? { field: failure.field }
      : {}),
    ...(failure.evidenceId
      ? { evidenceId: failure.evidenceId }
      : {})
  };
}

function initialSummary():
BuildDraftPrDeliveryContractResult["summary"] {
  return {
    inputValid: false,
    integratedReceiptIntegrityVerified: false,
    integratedOutcomeApproved: false,
    applyReceiptIntegrityVerified: false,
    applyReceiptBound: false,
    repositoryTargetValid: false,
    deliveryTextValid: false,
    evidenceReferencesValid: false,
    requiredReceiptEvidenceComplete: false,
    exactChangedFileCoverage: false,
    finalValidationEvidencePresent: false,
    contractBuilt: false,
    gitWritePerformed: false,
    githubWritePerformed: false
  };
}

function expectedReceiptHashes(
  receipt: IntegratedDisposableApplyReceipt
): Record<DraftPrReceiptEvidenceType, string> {
  return {
    integrated_apply:
      receipt.receiptHash,
    context_to_apply:
      receipt.contextToApplyBindingHash,
    acceptance_contract:
      receipt.acceptance.contractHash,
    preflight_coverage:
      receipt.acceptance
        .preflightCoverageReceiptHash,
    final_coverage:
      receipt.acceptance
        .finalCoverageReceiptHash,
    x4_apply:
      receipt.apply.x4ApplyReceiptHash,
    x5_final:
      receipt.validation.x5FinalReceiptHash
  };
}

function validateIntegratedReceipt(
  receipt: IntegratedDisposableApplyReceipt
): void {
  if (
    receipt.receiptVersion !== "1" ||
    receipt.outcome !== "contract_approved" ||
    !HASH.test(receipt.receiptHash) ||
    receipt.receiptHash !==
      hashWithout(
        receipt as unknown as PlainRecord,
        "receiptHash"
      )
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_integrated_receipt_invalid",
      "Integrated apply receipt integrity is invalid."
    );
  }
  const hashes = [
    receipt.contextToApplyBindingHash,
    receipt.contextAuthorizationHash,
    receipt.coderMutationHash,
    receipt.repairMutationHash,
    receipt.executionAuthorizationHash,
    receipt.governedArtifactHash,
    receipt.handoffHash,
    receipt.consumptionKey,
    receipt.acceptance.contractHash,
    receipt.acceptance.preflightCoverageReceiptHash,
    receipt.acceptance.finalCoverageReceiptHash,
    receipt.apply.x4ApplyReceiptHash,
    receipt.apply.appliedStateHash,
    receipt.apply.finalScopeHash,
    receipt.validation.x5FinalReceiptHash,
    receipt.validation.currentExecutionResultHash,
    receipt.validation.finalInspectionHash
  ];
  if (
    hashes.some((value) => !HASH.test(value)) ||
    receipt.validation.finalRepositoryState !==
      "validated_applied_state" ||
    receipt.acceptance.coverageComplete !== true ||
    receipt.preconditions
      .repositoryValidatedAppliedState !== true
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_integrated_receipt_invalid",
      "Integrated apply receipt is not delivery eligible."
    );
  }
}

function validateApplyReceipt(
  receipt: ControlledRepositoryApplyReceipt,
  integrated:
    IntegratedDisposableApplyReceipt
): Map<string, string> {
  if (
    receipt.receiptVersion !== "1" ||
    receipt.outcome !== "applied" ||
    !HASH.test(receipt.receiptHash) ||
    receipt.receiptHash !==
      hashWithout(
        receipt as unknown as PlainRecord,
        "receiptHash"
      ) ||
    receipt.receiptHash !==
      integrated.apply.x4ApplyReceiptHash ||
    receipt.after.appliedStateHash !==
      integrated.apply.appliedStateHash ||
    receipt.after.finalScopeHash !==
      integrated.apply.finalScopeHash ||
    !canonicalEqual(
      receipt.mutation.changedFiles,
      integrated.apply.changedFiles
    ) ||
    receipt.execution.mutationApplied !== true ||
    receipt.execution.gitIndexMutated !== false ||
    receipt.execution.gitHistoryMutated !== false
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_apply_receipt_invalid",
      "X.4 apply receipt does not bind to the integrated receipt."
    );
  }
  if (
    !HASH.test(
      receipt.before.repositoryIdentityHash
    ) ||
    !HASH.test(
      receipt.before.baseRevisionHash
    )
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_apply_receipt_invalid",
      "Repository target hashes are invalid."
    );
  }
  const result = new Map<string, string>();
  for (const entry of receipt.after.appliedFiles) {
    if (
      !validPath(entry.filePath) ||
      entry.finalState !== "regular_file" ||
      !HASH.test(entry.finalContentHash ?? "") ||
      result.has(entry.filePath)
    ) {
      throw new ContractFailure(
        "draft_pr_delivery_apply_receipt_invalid",
        "Applied file evidence is incomplete."
      );
    }
    result.set(
      entry.filePath,
      entry.finalContentHash!
    );
  }
  if (
    result.size !==
      integrated.apply.changedFiles.length ||
    integrated.apply.changedFiles.some(
      (file) => !result.has(file)
    )
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_apply_receipt_invalid",
      "Applied file evidence does not cover the exact governed scope."
    );
  }
  return result;
}

function normalizeReferences(
  references: readonly DraftPrEvidenceReference[],
  integrated: IntegratedDisposableApplyReceipt,
  applyReceipt: ControlledRepositoryApplyReceipt,
  appliedFiles: ReadonlyMap<string, string>
): DraftPrEvidenceReference[] {
  if (
    !Array.isArray(references) ||
    references.length === 0 ||
    references.length > MAX_REFERENCES
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_evidence_invalid",
      "Evidence reference set is empty or exceeds its bound.",
      "invalid",
      "evidenceReferences"
    );
  }
  const expectedReceipts =
    expectedReceiptHashes(integrated);
  const ids = new Set<string>();
  const receiptTypes =
    new Set<DraftPrReceiptEvidenceType>();
  const filePaths = new Set<string>();
  let finalValidationEvidence = false;
  const normalized:
    DraftPrEvidenceReference[] = [];

  for (const reference of references) {
    if (
      reference === null ||
      typeof reference !== "object" ||
      Array.isArray(reference) ||
      Object.getPrototypeOf(reference) !==
        Object.prototype ||
      !EVIDENCE_ID.test(reference.evidenceId) ||
      ids.has(reference.evidenceId)
    ) {
      throw new ContractFailure(
        "draft_pr_delivery_evidence_invalid",
        "Evidence reference identifier is invalid or duplicated.",
        "invalid",
        "evidenceReferences",
        typeof reference?.evidenceId === "string"
          ? reference.evidenceId
          : undefined
      );
    }
    ids.add(reference.evidenceId);

    if (reference.kind === "receipt") {
      const keys = Object.keys(reference).sort();
      if (
        !canonicalEqual(
          keys,
          [
            "evidenceId",
            "kind",
            "receiptHash",
            "receiptType"
          ]
        ) ||
        !REQUIRED_RECEIPTS.includes(
          reference.receiptType
        ) ||
        receiptTypes.has(reference.receiptType) ||
        reference.receiptHash !==
          expectedReceipts[
            reference.receiptType as
              DraftPrReceiptEvidenceType
          ]
      ) {
        throw new ContractFailure(
          "draft_pr_delivery_receipt_evidence_invalid",
          "Receipt evidence does not match its source receipt.",
          "invalid",
          "evidenceReferences",
          reference.evidenceId
        );
      }
      receiptTypes.add(reference.receiptType);
      normalized.push({ ...reference });
      continue;
    }

    if (reference.kind === "file") {
      const keys = Object.keys(reference).sort();
      if (
        !canonicalEqual(
          keys,
          [
            "contentHash",
            "evidenceId",
            "filePath",
            "kind",
            "sourceApplyReceiptHash"
          ]
        ) ||
        !validPath(reference.filePath) ||
        filePaths.has(reference.filePath) ||
        reference.sourceApplyReceiptHash !==
          applyReceipt.receiptHash ||
        reference.contentHash !==
          appliedFiles.get(reference.filePath)
      ) {
        throw new ContractFailure(
          "draft_pr_delivery_file_evidence_invalid",
          "File evidence does not match the X.4 applied file state.",
          "invalid",
          "evidenceReferences",
          reference.evidenceId
        );
      }
      filePaths.add(reference.filePath);
      normalized.push({ ...reference });
      continue;
    }

    if (reference.kind === "test") {
      const keys = Object.keys(reference).sort();
      if (
        !canonicalEqual(
          keys,
          [
            "commandId",
            "evidenceId",
            "kind",
            "resultHash",
            "sourceValidationReceiptHash"
          ]
        ) ||
        !COMMAND_ID.test(reference.commandId) ||
        reference.resultHash !==
          integrated.validation.currentExecutionResultHash ||
        reference.sourceValidationReceiptHash !==
          integrated.validation.x5FinalReceiptHash ||
        finalValidationEvidence
      ) {
        throw new ContractFailure(
          "draft_pr_delivery_test_evidence_invalid",
          "Final validation evidence does not match the integrated result.",
          "invalid",
          "evidenceReferences",
          reference.evidenceId
        );
      }
      finalValidationEvidence = true;
      normalized.push({ ...reference });
      continue;
    }

    throw new ContractFailure(
      "draft_pr_delivery_evidence_invalid",
      "Unknown evidence reference kind.",
      "invalid",
      "evidenceReferences",
      (reference as { evidenceId?: string }).evidenceId
    );
  }

  if (
    REQUIRED_RECEIPTS.some(
      (type) => !receiptTypes.has(type)
    )
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_required_receipt_evidence_missing",
      "Required receipt evidence is incomplete.",
      "blocked",
      "evidenceReferences"
    );
  }
  if (
    filePaths.size !== appliedFiles.size ||
    [...appliedFiles.keys()].some(
      (file) => !filePaths.has(file)
    )
  ) {
    throw new ContractFailure(
      "draft_pr_delivery_file_coverage_incomplete",
      "File evidence must cover every governed changed file exactly once.",
      "blocked",
      "evidenceReferences"
    );
  }
  if (!finalValidationEvidence) {
    throw new ContractFailure(
      "draft_pr_delivery_validation_evidence_missing",
      "Final validation test evidence is required.",
      "blocked",
      "evidenceReferences"
    );
  }

  return normalized.sort((left, right) =>
    left.evidenceId.localeCompare(
      right.evidenceId
    )
  );
}

function deterministicBranch(
  consumptionKey: string,
  receiptHash: string
): string {
  return `bounded/${consumptionKey.slice(7, 23)}-${receiptHash.slice(7, 19)}`;
}

function finish(
  decision: BuildDraftPrDeliveryContractDecision,
  contract: DraftPrDeliveryContract | null,
  issues: readonly DraftPrDeliveryContractIssue[],
  summary:
    BuildDraftPrDeliveryContractResult["summary"]
): BuildDraftPrDeliveryContractResult {
  return deepFreeze({
    decision,
    contract,
    issues: [...issues],
    summary
  });
}

export function buildDraftPrDeliveryContract(
  rawInput: BuildDraftPrDeliveryContractInput
): BuildDraftPrDeliveryContractResult {
  const summary = initialSummary();
  try {
    const input =
      safeClone(rawInput) as
        BuildDraftPrDeliveryContractInput;
    summary.inputValid = true;

    validateIntegratedReceipt(
      input.integratedReceipt
    );
    summary.integratedReceiptIntegrityVerified =
      true;
    summary.integratedOutcomeApproved = true;

    const appliedFiles =
      validateApplyReceipt(
        input.applyReceipt,
        input.integratedReceipt
      );
    summary.applyReceiptIntegrityVerified =
      true;
    summary.applyReceiptBound = true;

    if (
      !OWNER.test(input.repository.owner) ||
      !REPOSITORY.test(input.repository.name) ||
      !BRANCH.test(input.repository.baseBranch)
    ) {
      throw new ContractFailure(
        "draft_pr_delivery_repository_target_invalid",
        "Repository owner, name, or base branch is invalid.",
        "invalid",
        "repository"
      );
    }
    summary.repositoryTargetValid = true;

    if (
      !validText(
        input.commit.message,
        240,
        false
      ) ||
      !validText(
        input.pullRequest.title,
        240,
        false
      ) ||
      !validText(
        input.pullRequest.body,
        MAX_TEXT,
        true
      )
    ) {
      throw new ContractFailure(
        "draft_pr_delivery_text_invalid",
        "Commit or pull request text is invalid.",
        "invalid",
        "commit"
      );
    }
    summary.deliveryTextValid = true;

    const references = normalizeReferences(
      input.evidenceReferences,
      input.integratedReceipt,
      input.applyReceipt,
      appliedFiles
    );
    summary.evidenceReferencesValid = true;
    summary.requiredReceiptEvidenceComplete =
      true;
    summary.exactChangedFileCoverage = true;
    summary.finalValidationEvidencePresent =
      true;

    const branchName = deterministicBranch(
      input.integratedReceipt.consumptionKey,
      input.integratedReceipt.receiptHash
    );
    if (
      !BRANCH.test(branchName) ||
      branchName ===
        input.repository.baseBranch
    ) {
      throw new ContractFailure(
        "draft_pr_delivery_branch_invalid",
        "Derived delivery branch is invalid."
      );
    }

    const evidenceSetHash =
      hashCanonicalJson({
        artifactType:
          "draft_pr_delivery_evidence_set",
        references
      });
    const deliveryKey =
      hashCanonicalJson({
        artifactType:
          "draft_pr_delivery_key",
        repositoryOwner:
          input.repository.owner,
        repositoryName:
          input.repository.name,
        repositoryIdentityHash:
          input.applyReceipt.before
            .repositoryIdentityHash,
        baseBranch:
          input.repository.baseBranch,
        baseRevisionHash:
          input.applyReceipt.before
            .baseRevisionHash,
        integratedApplyReceiptHash:
          input.integratedReceipt.receiptHash,
        branchName,
        evidenceSetHash
      });

    const receiptCount =
      references.filter(
        (entry) => entry.kind === "receipt"
      ).length;
    const fileCount =
      references.filter(
        (entry) => entry.kind === "file"
      ).length;
    const testCount =
      references.filter(
        (entry) => entry.kind === "test"
      ).length;

    const material = {
      contractVersion: "1" as const,
      deliveryKey,
      repository: {
        owner:
          input.repository.owner,
        name:
          input.repository.name,
        repositoryIdentityHash:
          input.applyReceipt.before
            .repositoryIdentityHash,
        baseBranch:
          input.repository.baseBranch,
        baseRevisionHash:
          input.applyReceipt.before
            .baseRevisionHash
      },
      source: {
        integratedApplyReceiptHash:
          input.integratedReceipt.receiptHash,
        consumptionKey:
          input.integratedReceipt.consumptionKey,
        governedArtifactHash:
          input.integratedReceipt
            .governedArtifactHash,
        handoffHash:
          input.integratedReceipt.handoffHash,
        contextToApplyBindingHash:
          input.integratedReceipt
            .contextToApplyBindingHash,
        acceptanceContractHash:
          input.integratedReceipt.acceptance
            .contractHash,
        x4ApplyReceiptHash:
          input.integratedReceipt.apply
            .x4ApplyReceiptHash,
        x5FinalReceiptHash:
          input.integratedReceipt.validation
            .x5FinalReceiptHash
      },
      branch: {
        name: branchName,
        deterministic: true as const,
        baseBranchMustRemainUnchanged:
          true as const
      },
      commit: {
        message:
          input.commit.message,
        changedFiles:
          sortedUnique(
            input.integratedReceipt.apply
              .changedFiles
          ),
        changedFileCount:
          input.integratedReceipt.apply
            .changedFiles.length
      },
      pullRequest: {
        draft: true as const,
        title:
          input.pullRequest.title,
        body:
          input.pullRequest.body,
        baseBranch:
          input.repository.baseBranch,
        headBranch:
          branchName
      },
      evidence: {
        references,
        referenceCount:
          references.length,
        receiptReferenceCount:
          receiptCount,
        fileReferenceCount:
          fileCount,
        testReferenceCount:
          testCount,
        evidenceSetHash,
        complete: true as const
      },
      preconditions: {
        integratedReceiptIntegrityVerified:
          true as const,
        integratedOutcomeApproved:
          true as const,
        applyReceiptIntegrityVerified:
          true as const,
        appliedStateBound:
          true as const,
        exactChangedFileCoverage:
          true as const,
        typedEvidenceComplete:
          true as const,
        duplicateDeliveryForbidden:
          true as const,
        mainRepositoryMutationAllowed:
          false as const,
        gitWritePerformedByBuilder:
          false as const,
        githubWritePerformedByBuilder:
          false as const
      }
    };
    const contract:
      DraftPrDeliveryContract = {
        ...material,
        contractHash:
          hashCanonicalJson(material)
      };
    summary.contractBuilt = true;

    return finish(
      "draft_pr_delivery_contract_ready",
      contract,
      [],
      summary
    );
  } catch (error) {
    const failure =
      error instanceof ContractFailure
        ? error
        : new ContractFailure(
            "draft_pr_delivery_contract_exception",
            "Draft PR delivery contract failed without exposing unbounded details."
          );
    return finish(
      failure.kind === "blocked"
        ? "draft_pr_delivery_contract_blocked"
        : "draft_pr_delivery_contract_invalid",
      null,
      [issue(failure)],
      summary
    );
  }
}

export function verifyDraftPrDeliveryContract(
  rawInput: VerifyDraftPrDeliveryContractInput
): DraftPrDeliveryContractVerificationResult {
  const errors: string[] = [];
  const staleFields: string[] = [];
  try {
    const input =
      safeClone(rawInput) as
        VerifyDraftPrDeliveryContractInput;
    const contract = input.contract;

    if (
      contract.contractVersion !== "1" ||
      !HASH.test(contract.contractHash) ||
      contract.contractHash !==
        hashWithout(
          contract as unknown as PlainRecord,
          "contractHash"
        )
    ) {
      errors.push(
        "draft_pr_delivery_contract_hash_mismatch"
      );
      return deepFreeze({
        decision:
          "draft_pr_delivery_contract_invalid",
        contractIntegrityVerified: false,
        sourceReceiptsMatched: false,
        evidenceBindingsMatched: false,
        downstreamEligible: false,
        staleFields,
        errors,
        gitWritePerformed: false,
        githubWritePerformed: false
      });
    }

    const rebuilt =
      buildDraftPrDeliveryContract({
        integratedReceipt:
          input.integratedReceipt,
        applyReceipt:
          input.applyReceipt,
        repository: {
          owner:
            contract.repository.owner,
          name:
            contract.repository.name,
          baseBranch:
            contract.repository.baseBranch
        },
        commit: {
          message:
            contract.commit.message
        },
        pullRequest: {
          title:
            contract.pullRequest.title,
          body:
            contract.pullRequest.body
        },
        evidenceReferences:
          contract.evidence.references
      });

    if (
      rebuilt.decision !==
        "draft_pr_delivery_contract_ready" ||
      rebuilt.contract === null
    ) {
      errors.push(
        ...rebuilt.issues.map(
          (entry) => entry.code
        )
      );
      return deepFreeze({
        decision:
          "draft_pr_delivery_contract_invalid",
        contractIntegrityVerified: true,
        sourceReceiptsMatched: false,
        evidenceBindingsMatched: false,
        downstreamEligible: false,
        staleFields,
        errors: sortedUnique(errors),
        gitWritePerformed: false,
        githubWritePerformed: false
      });
    }

    if (
      contract.source
        .integratedApplyReceiptHash !==
        input.integratedReceipt.receiptHash
    ) {
      staleFields.push(
        "integratedApplyReceiptHash"
      );
    }
    if (
      contract.source.x4ApplyReceiptHash !==
        input.applyReceipt.receiptHash
    ) {
      staleFields.push(
        "x4ApplyReceiptHash"
      );
    }
    if (
      contract.repository.baseRevisionHash !==
        input.applyReceipt.before
          .baseRevisionHash
    ) {
      staleFields.push(
        "baseRevisionHash"
      );
    }

    const evidenceBindingsMatched =
      rebuilt.contract.evidence
        .evidenceSetHash ===
        contract.evidence.evidenceSetHash;
    const exactMatch =
      canonicalEqual(
        rebuilt.contract,
        contract
      );
    if (!evidenceBindingsMatched) {
      errors.push(
        "draft_pr_delivery_evidence_binding_mismatch"
      );
    }
    if (!exactMatch) {
      errors.push(
        "draft_pr_delivery_contract_material_mismatch"
      );
    }

    const stale =
      staleFields.length > 0;
    return deepFreeze({
      decision:
        stale
          ? "draft_pr_delivery_contract_stale"
          : exactMatch &&
              evidenceBindingsMatched
            ? "draft_pr_delivery_contract_current"
            : "draft_pr_delivery_contract_invalid",
      contractIntegrityVerified: true,
      sourceReceiptsMatched: !stale,
      evidenceBindingsMatched,
      downstreamEligible:
        !stale &&
        exactMatch &&
        evidenceBindingsMatched,
      staleFields:
        sortedUnique(staleFields),
      errors:
        sortedUnique(errors),
      gitWritePerformed: false,
      githubWritePerformed: false
    });
  } catch {
    return deepFreeze({
      decision:
        "draft_pr_delivery_contract_invalid",
      contractIntegrityVerified: false,
      sourceReceiptsMatched: false,
      evidenceBindingsMatched: false,
      downstreamEligible: false,
      staleFields: [],
      errors: [
        "draft_pr_delivery_contract_verification_exception"
      ],
      gitWritePerformed: false,
      githubWritePerformed: false
    });
  }
}
