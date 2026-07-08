import {
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type WorkspaceMutation
} from "./workspace-mutation.js";

export type RemaskRepairability =
  | "repairable"
  | "not_repairable"
  | "not_needed";

export type RemaskRequestIssueCode =
  | "verifier_approved"
  | "verifier_rejected"
  | "missing_verifier_finding"
  | "missing_verifier_decision"
  | "missing_verifier_issues"
  | "missing_original_patch_draft"
  | "original_not_coder_patch_draft"
  | "unsafe_or_forbidden_issue"
  | "no_repairable_issues"
  | "invalid_remask_request";

export type RemaskRequestIssue = {
  code: RemaskRequestIssueCode;
  message: string;
  path?: string;
  file?: string;
};

export type RemaskRequestContext = {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  maxRepairSteps?: number;
};

export type BuildRemaskRequestResult = {
  ok: boolean;
  repairability: RemaskRepairability;
  remaskRequest: WorkspaceMutation | null;
  issues: RemaskRequestIssue[];
};

type VerifierFindingClaim = {
  type: "deterministic_verifier_finding";
  decision?: unknown;
  issues?: unknown;
};

type VerifierIssue = {
  code: string;
  message: string;
  path?: string;
  file?: string;
};

const repairableVerifierIssueCodes = new Set([
  "empty_patch_claims",
  "missing_patch_description",
  "missing_patch_file",
  "missing_proposed_patch",
  "touched_file_without_patch_claim",
  "patch_claim_outside_touched_files",
  "scope_violation",
  "low_confidence"
]);

const unsafeOrForbiddenVerifierIssueCodes = new Set([
  "forbidden_file_touch",
  "unsafe_patch_content",
  "not_coder_patch_draft"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: RemaskRequestIssueCode,
  message: string,
  options: { path?: string; file?: string } = {}
): RemaskRequestIssue {
  return {
    code,
    message,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.file === undefined ? {} : { file: options.file })
  };
}

function failure(
  code: RemaskRequestIssueCode,
  message: string,
  options: { path?: string; file?: string } = {}
): BuildRemaskRequestResult {
  return {
    ok: false,
    repairability: "not_repairable",
    remaskRequest: null,
    issues: [issue(code, message, options)]
  };
}

function safeStop(
  repairability: Exclude<RemaskRepairability, "repairable">,
  code: RemaskRequestIssueCode,
  message: string,
  options: { path?: string; file?: string } = {}
): BuildRemaskRequestResult {
  return {
    ok: true,
    repairability,
    remaskRequest: null,
    issues: [issue(code, message, options)]
  };
}

function findVerifierFindingClaim(
  verifierFinding: WorkspaceMutation
): VerifierFindingClaim | null {
  for (const claim of verifierFinding.claims) {
    if (isRecord(claim) && claim.type === "deterministic_verifier_finding") {
      return claim as VerifierFindingClaim;
    }
  }

  return null;
}

function normalizeVerifierIssue(value: unknown): VerifierIssue | null {
  if (!isRecord(value) || typeof value.code !== "string") {
    return null;
  }

  return {
    code: value.code,
    message: typeof value.message === "string" ? value.message : "",
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.file === "string" ? { file: value.file } : {})
  };
}

function uniqueIssueCodes(issues: VerifierIssue[]): string[] {
  return [...new Set(issues.map((verifierIssue) => verifierIssue.code))];
}

function addContextScopeIssues(
  verifierIssues: VerifierIssue[],
  originalPatchDraft: WorkspaceMutation,
  context: RemaskRequestContext
): VerifierIssue[] {
  const allowedFiles = new Set(context.allowedFiles ?? []);

  if (allowedFiles.size === 0) {
    return verifierIssues;
  }

  const nextIssues = [...verifierIssues];
  for (const file of originalPatchDraft.touchedFiles) {
    if (
      !allowedFiles.has(file) &&
      !nextIssues.some((verifierIssue) => verifierIssue.code === "scope_violation" && verifierIssue.file === file)
    ) {
      nextIssues.push({
        code: "scope_violation",
        message: `Touched file is outside allowedFiles: ${file}`,
        path: "touchedFiles",
        file
      });
    }
  }

  return nextIssues;
}

export function buildRemaskRequestFromVerifierFinding(
  originalPatchDraft: WorkspaceMutation,
  verifierFinding: WorkspaceMutation,
  context: RemaskRequestContext = {}
): BuildRemaskRequestResult {
  if (originalPatchDraft === undefined || originalPatchDraft === null) {
    return failure(
      "missing_original_patch_draft",
      "Original patchDraft mutation is required."
    );
  }

  if (originalPatchDraft.role !== "coder" || originalPatchDraft.target !== "patchDraft") {
    return failure(
      "original_not_coder_patch_draft",
      "Original mutation must be a coder patchDraft workspace mutation."
    );
  }

  if (
    verifierFinding === undefined ||
    verifierFinding === null ||
    verifierFinding.role !== "verifier" ||
    verifierFinding.target !== "verifierFinding" ||
    !Array.isArray(verifierFinding.claims)
  ) {
    return failure(
      "missing_verifier_finding",
      "Verifier finding must be a verifier verifierFinding workspace mutation."
    );
  }

  const findingClaim = findVerifierFindingClaim(verifierFinding);
  if (findingClaim === null) {
    return failure(
      "missing_verifier_finding",
      "Verifier finding must include a deterministic_verifier_finding claim.",
      { path: "claims" }
    );
  }

  if (
    findingClaim.decision !== "approve" &&
    findingClaim.decision !== "needs_review" &&
    findingClaim.decision !== "reject"
  ) {
    return failure(
      "missing_verifier_decision",
      "Verifier finding claim must include a valid decision.",
      { path: "claims.decision" }
    );
  }

  if (!Array.isArray(findingClaim.issues)) {
    return failure(
      "missing_verifier_issues",
      "Verifier finding claim must include issues.",
      { path: "claims.issues" }
    );
  }

  if (findingClaim.decision === "approve") {
    return safeStop(
      "not_needed",
      "verifier_approved",
      "Verifier approved the coder patchDraft; no remask is needed."
    );
  }

  if (findingClaim.decision === "reject") {
    return safeStop(
      "not_repairable",
      "verifier_rejected",
      "Verifier rejected the coder patchDraft; remask repair is not allowed."
    );
  }

  const verifierIssues = addContextScopeIssues(
    findingClaim.issues
      .map((verifierIssue) => normalizeVerifierIssue(verifierIssue))
      .filter((verifierIssue): verifierIssue is VerifierIssue => verifierIssue !== null),
    originalPatchDraft,
    context
  );

  const unsafeIssue = verifierIssues.find((verifierIssue) =>
    unsafeOrForbiddenVerifierIssueCodes.has(verifierIssue.code)
  );
  if (unsafeIssue !== undefined) {
    return safeStop(
      "not_repairable",
      "unsafe_or_forbidden_issue",
      `Verifier issue is unsafe or forbidden: ${unsafeIssue.code}`,
      { path: unsafeIssue.path, file: unsafeIssue.file }
    );
  }

  const repairableIssues = verifierIssues.filter((verifierIssue) =>
    repairableVerifierIssueCodes.has(verifierIssue.code)
  );

  if (repairableIssues.length === 0) {
    return safeStop(
      "not_repairable",
      "no_repairable_issues",
      "Verifier finding does not contain repairable issues."
    );
  }

  const maxRepairSteps = context.maxRepairSteps ?? 3;
  const remaskRequest = createWorkspaceMutation({
    role: "verifier",
    target: "remaskRequest",
    summary: "Request a bounded remask repair for coder patchDraft.",
    claims: [
      {
        type: "remask_request",
        reason: "deterministic_verifier_needs_review",
        repairableIssueCodes: uniqueIssueCodes(repairableIssues),
        repairableIssues,
        originalSummary: originalPatchDraft.summary,
        verifierSummary: verifierFinding.summary,
        allowedFiles: context.allowedFiles ?? [],
        forbiddenFiles: context.forbiddenFiles ?? [],
        maxRepairSteps
      }
    ],
    touchedFiles: originalPatchDraft.touchedFiles,
    confidence: 1
  });

  const validation = validateWorkspaceMutationContract(remaskRequest);
  if (!validation.ok) {
    return failure(
      "invalid_remask_request",
      `Generated remaskRequest failed WorkspaceMutation validation: ${validation.errors.join("; ")}`,
      { path: "remaskRequest" }
    );
  }

  return {
    ok: true,
    repairability: "repairable",
    remaskRequest,
    issues: []
  };
}
