import {
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type WorkspaceMutation
} from "./workspace-mutation.js";

export type RepairDraftVerifierDecision =
  | "approve"
  | "needs_review"
  | "reject";

export type RepairDraftVerifierIssue = {
  code: string;
  message: string;
  file?: string;
  severity: "review" | "reject";
};

export type RepairDraftVerifierContext = {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  requiredIssueCodes?: string[];
  minConfidence?: number;
};

export type RepairDraftVerifierResult = {
  decision: RepairDraftVerifierDecision;
  issues: RepairDraftVerifierIssue[];
  finding: WorkspaceMutation;
};

const unsafeRepairPatchNeedles = [
  "process.env",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  ".env",
  "rm -rf",
  "curl ",
  "wget ",
  "child_process",
  "exec(",
  "spawn(",
  "eval(",
  "Function("
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: RepairDraftVerifierIssue[],
  code: string,
  message: string,
  severity: RepairDraftVerifierIssue["severity"],
  file?: string
): void {
  issues.push({
    code,
    message,
    severity,
    ...(file === undefined ? {} : { file })
  });
}

function selectDecision(
  issues: RepairDraftVerifierIssue[]
): RepairDraftVerifierDecision {
  if (issues.some((issue) => issue.severity === "reject")) {
    return "reject";
  }

  if (issues.some((issue) => issue.severity === "review")) {
    return "needs_review";
  }

  return "approve";
}

function buildFinding(
  mutation: WorkspaceMutation,
  decision: RepairDraftVerifierDecision,
  issues: RepairDraftVerifierIssue[]
): WorkspaceMutation {
  return createWorkspaceMutation({
    role: "verifier",
    target: "verifierFinding",
    summary: `Deterministic repairDraft verifier returned ${decision}.`,
    claims: [
      {
        type: "deterministic_repair_draft_verifier_finding",
        decision,
        issues
      }
    ],
    touchedFiles: Array.isArray(mutation.touchedFiles) ? mutation.touchedFiles : [],
    confidence: 1
  });
}

function addScopeIssues(
  issues: RepairDraftVerifierIssue[],
  file: string,
  allowedFiles: Set<string>,
  forbiddenFiles: Set<string>
): void {
  if (allowedFiles.size > 0 && !allowedFiles.has(file)) {
    addIssue(
      issues,
      "scope_violation",
      `Repair draft file is outside allowedFiles: ${file}`,
      "review",
      file
    );
  }

  if (forbiddenFiles.size > 0 && forbiddenFiles.has(file)) {
    addIssue(
      issues,
      "forbidden_file_touch",
      `Repair draft file is forbidden: ${file}`,
      "reject",
      file
    );
  }
}

export function verifyRepairDraftMutation(
  mutation: WorkspaceMutation,
  context: RepairDraftVerifierContext = {}
): RepairDraftVerifierResult {
  const issues: RepairDraftVerifierIssue[] = [];
  const allowedFiles = new Set(context.allowedFiles ?? []);
  const forbiddenFiles = new Set(context.forbiddenFiles ?? []);
  const requiredIssueCodes = context.requiredIssueCodes ?? [];
  const minConfidence = context.minConfidence ?? 0.5;
  const touchedFileList = Array.isArray(mutation.touchedFiles) ? mutation.touchedFiles : [];
  const touchedFiles = new Set(touchedFileList);
  const repairClaimFiles = new Set<string>();
  const addressedIssueCodes = new Set<string>();

  if (mutation.role !== "remask") {
    addIssue(
      issues,
      "not_remask_repair_draft",
      'Mutation role must be "remask" for repairDraft verification.',
      "reject"
    );
  }

  if (mutation.target !== "repairDraft") {
    addIssue(
      issues,
      "not_repair_draft_target",
      'Mutation target must be "repairDraft" for repairDraft verification.',
      "reject"
    );
  }

  const repairDraftClaims: Record<string, unknown>[] = [];
  const claimList = Array.isArray(mutation.claims) ? mutation.claims : [];

  for (const claim of claimList) {
    if (isRecord(claim) && claim.type === "repair_draft") {
      repairDraftClaims.push(claim);
    }
  }

  if (claimList.length === 0) {
    addIssue(
      issues,
      "empty_repair_claims",
      "repairDraft mutation must include at least one claim.",
      "review"
    );
  } else if (repairDraftClaims.length === 0) {
    addIssue(
      issues,
      "missing_repair_draft_claim",
      'repairDraft mutation must include at least one "repair_draft" claim.',
      "review"
    );
  }

  for (const claim of repairDraftClaims) {
    const file = typeof claim.file === "string" ? claim.file.trim() : "";
    const description =
      typeof claim.description === "string" ? claim.description.trim() : "";
    const proposedPatch =
      typeof claim.proposedPatch === "string" ? claim.proposedPatch : "";
    const addressesIssueCodes = claim.addressesIssueCodes;

    if (file.length === 0) {
      addIssue(
        issues,
        "missing_repair_file",
        "repair_draft claim must include file.",
        "review"
      );
    } else {
      repairClaimFiles.add(file);
      addScopeIssues(issues, file, allowedFiles, forbiddenFiles);

      if (!touchedFiles.has(file)) {
        addIssue(
          issues,
          "repair_claim_outside_touched_files",
          `Repair draft claim file is not listed in touchedFiles: ${file}`,
          "review",
          file
        );
      }
    }

    if (description.length === 0) {
      addIssue(
        issues,
        "missing_repair_description",
        "repair_draft claim must include description.",
        "review",
        file || undefined
      );
    }

    if (proposedPatch.length === 0) {
      addIssue(
        issues,
        "missing_repair_proposed_patch",
        "repair_draft claim must include proposedPatch.",
        "review",
        file || undefined
      );
    } else {
      for (const needle of unsafeRepairPatchNeedles) {
        if (proposedPatch.includes(needle)) {
          addIssue(
            issues,
            "unsafe_repair_patch_content",
            `proposedPatch contains unsafe content marker: ${needle}`,
            "reject",
            file || undefined
          );
          break;
        }
      }
    }

    if (addressesIssueCodes === undefined) {
      addIssue(
        issues,
        "missing_addressed_issue_codes",
        "repair_draft claim must include addressesIssueCodes.",
        "review",
        file || undefined
      );
    } else if (!Array.isArray(addressesIssueCodes)) {
      addIssue(
        issues,
        "invalid_addressed_issue_codes",
        "repair_draft addressesIssueCodes must be an array.",
        "review",
        file || undefined
      );
    } else if (addressesIssueCodes.length === 0) {
      addIssue(
        issues,
        "empty_addressed_issue_codes",
        "repair_draft addressesIssueCodes must include at least one issue code.",
        "review",
        file || undefined
      );
    } else {
      for (const issueCode of addressesIssueCodes) {
        if (typeof issueCode === "string" && issueCode.trim().length > 0) {
          addressedIssueCodes.add(issueCode.trim());
        }
      }
    }
  }

  for (const file of touchedFileList) {
    addScopeIssues(issues, file, allowedFiles, forbiddenFiles);

    if (!repairClaimFiles.has(file)) {
      addIssue(
        issues,
        "touched_file_without_repair_claim",
        `Touched file has no matching repair_draft claim: ${file}`,
        "review",
        file
      );
    }
  }

  for (const requiredIssueCode of requiredIssueCodes) {
    if (!addressedIssueCodes.has(requiredIssueCode)) {
      addIssue(
        issues,
        "required_issue_code_not_addressed",
        `Required issue code is not addressed by repairDraft: ${requiredIssueCode}`,
        "review"
      );
    }
  }

  if (mutation.confidence !== undefined && mutation.confidence < minConfidence) {
    addIssue(
      issues,
      "low_confidence",
      `Mutation confidence is below minConfidence: ${mutation.confidence} < ${minConfidence}`,
      "review"
    );
  }

  let decision = selectDecision(issues);
  let finding = buildFinding(mutation, decision, issues);
  const findingValidation = validateWorkspaceMutationContract(finding);

  if (!findingValidation.ok) {
    const rejectedIssues: RepairDraftVerifierIssue[] = [
      ...issues,
      {
        code: "generated_finding_contract_invalid",
        message: `Generated verifier finding failed WorkspaceMutation validation: ${findingValidation.errors.join("; ")}`,
        severity: "reject"
      }
    ];
    decision = "reject";
    finding = buildFinding(mutation, decision, rejectedIssues);

    return {
      decision,
      issues: rejectedIssues,
      finding
    };
  }

  return {
    decision,
    issues,
    finding
  };
}
