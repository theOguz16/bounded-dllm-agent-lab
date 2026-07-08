import {
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type WorkspaceMutation
} from "./workspace-mutation.js";

export type DeterministicVerifierDecision =
  | "approve"
  | "needs_review"
  | "reject";

export type DeterministicVerifierIssueCode =
  | "not_coder_patch_draft"
  | "empty_patch_claims"
  | "missing_patch_description"
  | "missing_patch_file"
  | "missing_proposed_patch"
  | "touched_file_without_patch_claim"
  | "patch_claim_outside_touched_files"
  | "forbidden_file_touch"
  | "scope_violation"
  | "unsafe_patch_content"
  | "low_confidence";

export type DeterministicVerifierIssue = {
  code: DeterministicVerifierIssueCode;
  message: string;
  path?: string;
  file?: string;
};

export type DeterministicVerifierContext = {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  minConfidence?: number;
};

export type DeterministicVerifierResult = {
  ok: boolean;
  decision: DeterministicVerifierDecision;
  issues: DeterministicVerifierIssue[];
  finding: WorkspaceMutation;
};

const unsafePatchNeedles = [
  "process.env",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  ".env",
  "rm -rf",
  "curl ",
  "wget "
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: DeterministicVerifierIssue[],
  code: DeterministicVerifierIssueCode,
  message: string,
  options: { path?: string; file?: string } = {}
): void {
  issues.push({
    code,
    message,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.file === undefined ? {} : { file: options.file })
  });
}

function hasIssueCode(
  issues: DeterministicVerifierIssue[],
  code: DeterministicVerifierIssueCode
): boolean {
  return issues.some((issue) => issue.code === code);
}

function selectDecision(
  issues: DeterministicVerifierIssue[]
): DeterministicVerifierDecision {
  if (issues.length === 0) {
    return "approve";
  }

  if (
    hasIssueCode(issues, "not_coder_patch_draft") ||
    hasIssueCode(issues, "forbidden_file_touch") ||
    hasIssueCode(issues, "unsafe_patch_content")
  ) {
    return "reject";
  }

  return "needs_review";
}

function buildFinding(
  mutation: WorkspaceMutation,
  decision: DeterministicVerifierDecision,
  issues: DeterministicVerifierIssue[]
): WorkspaceMutation {
  return createWorkspaceMutation({
    role: "verifier",
    target: "verifierFinding",
    summary:
      decision === "approve"
        ? "Deterministic verifier approved coder patchDraft."
        : `Deterministic verifier returned ${decision} for coder patchDraft.`,
    claims: [
      {
        type: "deterministic_verifier_finding",
        decision,
        issues
      }
    ],
    touchedFiles: mutation.touchedFiles,
    confidence: 1
  });
}

export function verifyPatchDraftMutation(
  mutation: WorkspaceMutation,
  context: DeterministicVerifierContext = {}
): DeterministicVerifierResult {
  const issues: DeterministicVerifierIssue[] = [];
  const allowedFiles = new Set(context.allowedFiles ?? []);
  const forbiddenFiles = new Set(context.forbiddenFiles ?? []);
  const minConfidence = context.minConfidence ?? 0.5;
  const touchedFiles = new Set(mutation.touchedFiles);
  const patchClaimFiles = new Set<string>();

  if (mutation.role !== "coder" || mutation.target !== "patchDraft") {
    addIssue(
      issues,
      "not_coder_patch_draft",
      "Mutation must be a coder patchDraft workspace mutation."
    );
  }

  const patchDraftClaims: Record<string, unknown>[] = [];

  for (const claim of mutation.claims) {
    if (isRecord(claim) && claim.type === "patch_draft") {
      patchDraftClaims.push(claim);
    }
  }

  if (mutation.claims.length === 0 || patchDraftClaims.length === 0) {
    addIssue(
      issues,
      "empty_patch_claims",
      "Mutation must include at least one patch_draft claim.",
      { path: "claims" }
    );
  }

  for (let index = 0; index < patchDraftClaims.length; index += 1) {
    const claim = patchDraftClaims[index];
    const path = `claims.${index}`;
    const file = typeof claim.file === "string" ? claim.file.trim() : "";
    const description =
      typeof claim.description === "string" ? claim.description.trim() : "";
    const proposedPatch =
      typeof claim.proposedPatch === "string" ? claim.proposedPatch : "";

    if (file.length === 0) {
      addIssue(issues, "missing_patch_file", "patch_draft claim must include file.", {
        path: `${path}.file`
      });
    } else {
      patchClaimFiles.add(file);

      if (!touchedFiles.has(file)) {
        addIssue(
          issues,
          "patch_claim_outside_touched_files",
          `Patch claim file is not listed in touchedFiles: ${file}`,
          { path: `${path}.file`, file }
        );
      }
    }

    if (description.length === 0) {
      addIssue(
        issues,
        "missing_patch_description",
        "patch_draft claim must include description.",
        { path: `${path}.description`, file: file || undefined }
      );
    }

    if (proposedPatch.length === 0) {
      addIssue(
        issues,
        "missing_proposed_patch",
        "patch_draft claim must include proposedPatch.",
        { path: `${path}.proposedPatch`, file: file || undefined }
      );
    } else {
      for (const needle of unsafePatchNeedles) {
        if (proposedPatch.includes(needle)) {
          addIssue(
            issues,
            "unsafe_patch_content",
            `proposedPatch contains unsafe content marker: ${needle}`,
            { path: `${path}.proposedPatch`, file: file || undefined }
          );
          break;
        }
      }
    }
  }

  for (const file of mutation.touchedFiles) {
    if (!patchClaimFiles.has(file)) {
      addIssue(
        issues,
        "touched_file_without_patch_claim",
        `Touched file has no matching patch_draft claim: ${file}`,
        { path: "touchedFiles", file }
      );
    }

    if (allowedFiles.size > 0 && !allowedFiles.has(file)) {
      addIssue(
        issues,
        "scope_violation",
        `Touched file is outside allowedFiles: ${file}`,
        { path: "touchedFiles", file }
      );
    }

    if (forbiddenFiles.size > 0 && forbiddenFiles.has(file)) {
      addIssue(
        issues,
        "forbidden_file_touch",
        `Touched file is forbidden: ${file}`,
        { path: "touchedFiles", file }
      );
    }
  }

  if (mutation.confidence !== undefined && mutation.confidence < minConfidence) {
    addIssue(
      issues,
      "low_confidence",
      `Mutation confidence is below minConfidence: ${mutation.confidence} < ${minConfidence}`,
      { path: "confidence" }
    );
  }

  let decision = selectDecision(issues);
  let finding = buildFinding(mutation, decision, issues);
  const findingValidation = validateWorkspaceMutationContract(finding);

  if (!findingValidation.ok) {
    const validationIssue: DeterministicVerifierIssue = {
      code: "scope_violation",
      message: `Generated verifier finding failed WorkspaceMutation validation: ${findingValidation.errors.join("; ")}`,
      path: "finding"
    };
    const rejectedIssues = [...issues, validationIssue];
    decision = "reject";
    finding = buildFinding(mutation, decision, rejectedIssues);

    return {
      ok: false,
      decision,
      issues: rejectedIssues,
      finding
    };
  }

  return {
    ok: decision === "approve",
    decision,
    issues,
    finding
  };
}
