import { parseTextFileUpdates, validateUpdateSourceMap, MutationContractError } from "./text-file-update-contract.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export type PatchDryRunDecision =
  | "ready_to_apply"
  | "needs_review"
  | "reject";

export type PatchDryRunIssue = {
  code: string;
  message: string;
  file?: string;
  severity: "review" | "reject";
};

export type PatchDryRunFilePreview = {
  file: string;
  originalContent: string;
  proposedContent: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  diffPreview: string;
};

export type PatchApplicationDryRunContext = {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  fileContents: Record<string, string>;
  requiredRepairVerifierDecision?: "approve";
  maxFileBytes?: number;
  maxDiffPreviewLines?: number;
};

export type PatchApplicationDryRunResult = {
  decision: PatchDryRunDecision;
  issues: PatchDryRunIssue[];
  previews: PatchDryRunFilePreview[];
  summary: {
    totalFiles: number;
    changedFiles: number;
    unchangedFiles: number;
    totalAddedLines: number;
    totalRemovedLines: number;
  };
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

const defaultMaxFileBytes = 1024 * 1024;
const defaultMaxDiffPreviewLines = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: PatchDryRunIssue[],
  code: string,
  message: string,
  severity: PatchDryRunIssue["severity"],
  file?: string
): void {
  issues.push({
    code,
    message,
    severity,
    ...(file === undefined ? {} : { file })
  });
}

function selectDecision(issues: PatchDryRunIssue[]): PatchDryRunDecision {
  if (issues.some((issue) => issue.severity === "reject")) {
    return "reject";
  }

  if (issues.some((issue) => issue.severity === "review")) {
    return "needs_review";
  }

  return "ready_to_apply";
}

function addScopeIssues(
  issues: PatchDryRunIssue[],
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

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split(/\r?\n/);
}

function countChangedLines(
  originalContent: string,
  proposedContent: string
): { addedLines: number; removedLines: number } {
  const originalLines = splitLines(originalContent);
  const proposedLines = splitLines(proposedContent);
  const maxLines = Math.max(originalLines.length, proposedLines.length);
  let addedLines = 0;
  let removedLines = 0;

  for (let index = 0; index < maxLines; index += 1) {
    const originalLine = originalLines[index];
    const proposedLine = proposedLines[index];

    if (originalLine === proposedLine) {
      continue;
    }

    if (originalLine !== undefined) {
      removedLines += 1;
    }

    if (proposedLine !== undefined) {
      addedLines += 1;
    }
  }

  return { addedLines, removedLines };
}

function buildDiffPreview(
  file: string,
  originalContent: string,
  proposedContent: string,
  maxDiffPreviewLines: number
): string {
  const originalLines = splitLines(originalContent);
  const proposedLines = splitLines(proposedContent);
  const lines = [`--- ${file}`, `+++ ${file}`];
  const maxLines = Math.max(originalLines.length, proposedLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    if (lines.length >= maxDiffPreviewLines) {
      break;
    }

    const originalLine = originalLines[index];
    const proposedLine = proposedLines[index];

    if (originalLine === proposedLine) {
      continue;
    }

    if (originalLine !== undefined && lines.length < maxDiffPreviewLines) {
      lines.push(`- ${originalLine}`);
    }

    if (proposedLine !== undefined && lines.length < maxDiffPreviewLines) {
      lines.push(`+ ${proposedLine}`);
    }
  }

  return lines.join("\n");
}

function findRepairVerifierDecision(finding: WorkspaceMutation): unknown {
  const claimList = Array.isArray(finding.claims) ? finding.claims : [];

  for (const claim of claimList) {
    if (
      isRecord(claim) &&
      claim.type === "deterministic_repair_draft_verifier_finding"
    ) {
      return claim.decision;
    }
  }

  return undefined;
}

function dryRunPatchApplicationUnchecked(
  repairDraftMutation: WorkspaceMutation,
  repairVerifierFinding: WorkspaceMutation,
  context: PatchApplicationDryRunContext
): PatchApplicationDryRunResult {
  const issues: PatchDryRunIssue[] = [];
  const previews: PatchDryRunFilePreview[] = [];
  const allowedFiles = new Set(context.allowedFiles ?? []);
  const forbiddenFiles = new Set(context.forbiddenFiles ?? []);
  const maxFileBytes =
    context.maxFileBytes ?? defaultMaxFileBytes;
  const maxDiffPreviewLines =
    context.maxDiffPreviewLines ?? defaultMaxDiffPreviewLines;
  const requiredRepairVerifierDecision =
    context.requiredRepairVerifierDecision ?? "approve";
  const fileContents = isRecord(context.fileContents) ? context.fileContents : {};
  const touchedFileList = Array.isArray(repairDraftMutation.touchedFiles)
    ? repairDraftMutation.touchedFiles
    : [];
  const touchedFiles = new Set(touchedFileList);
  const repairClaimFiles = new Set<string>();

  if (repairDraftMutation.role !== "remask") {
    addIssue(
      issues,
      "not_remask_repair_draft",
      'Mutation role must be "remask" for patch application dry-run.',
      "reject"
    );
  }

  if (repairDraftMutation.target !== "repairDraft") {
    addIssue(
      issues,
      "not_repair_draft_target",
      'Mutation target must be "repairDraft" for patch application dry-run.',
      "reject"
    );
  }

  if (repairVerifierFinding.role !== "verifier") {
    addIssue(
      issues,
      "missing_repair_verifier_approval",
      'repairVerifierFinding role must be "verifier".',
      "reject"
    );
  }

  if (repairVerifierFinding.target !== "verifierFinding") {
    addIssue(
      issues,
      "missing_repair_verifier_approval",
      'repairVerifierFinding target must be "verifierFinding".',
      "reject"
    );
  }

  const repairVerifierDecision = findRepairVerifierDecision(repairVerifierFinding);

  if (repairVerifierDecision === undefined) {
    addIssue(
      issues,
      "missing_repair_verifier_approval",
      "Missing deterministic repairDraft verifier approval claim.",
      "reject"
    );
  } else if (repairVerifierDecision !== requiredRepairVerifierDecision) {
    addIssue(
      issues,
      "repair_verifier_not_approved",
      `Repair verifier decision must be ${requiredRepairVerifierDecision}, got ${String(repairVerifierDecision)}.`,
      "reject"
    );
  }

  const claimList = Array.isArray(repairDraftMutation.claims)
    ? repairDraftMutation.claims
    : [];
  const repairDraftClaims: Record<string, unknown>[] = [];

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
    const newContent = claim.newContent;

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

      if (!Object.prototype.hasOwnProperty.call(fileContents, file)) {
        addIssue(
          issues,
          "missing_original_file_content",
          `Missing original file content for repair draft file: ${file}`,
          "review",
          file
        );
      }

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

    if (newContent === undefined) {
      addIssue(
        issues,
        "missing_repair_proposed_patch",
        "repair_draft claim must include newContent.",
        "review",
        file || undefined
      );
    } else if (typeof newContent !== "string") {
      addIssue(
        issues,
        "invalid_repair_proposed_patch",
        "repair_draft newContent must be a string.",
        "review",
        file || undefined
      );
    } else {
      if (typeof claim.newContent !== "string") {
        addIssue(
          issues,
          "missing_repair_proposed_patch",
          "repair_draft claim must include newContent.",
          "review",
          file || undefined
        );
      }

      if (Buffer.byteLength(newContent, "utf8") > maxFileBytes) {
        addIssue(
          issues,
          "proposed_patch_too_large",
          `newContent exceeds maxFileBytes: ${Buffer.byteLength(newContent, "utf8")} > ${maxFileBytes}`,
          "review",
          file || undefined
        );
      }

      for (const needle of unsafeRepairPatchNeedles) {
        if (newContent.includes(needle)) {
          addIssue(
            issues,
            "unsafe_repair_patch_content",
            `newContent contains unsafe content marker: ${needle}`,
            "reject",
            file || undefined
          );
          break;
        }
      }

      if (
        file.length > 0 &&
        Object.prototype.hasOwnProperty.call(fileContents, file)
      ) {
        const originalContent = String(fileContents[file]);
        const { addedLines, removedLines } = countChangedLines(
          originalContent,
          newContent
        );

        if (originalContent === newContent) {
          addIssue(
            issues,
            "no_op_patch",
            `newContent is identical to original content: ${file}`,
            "review",
            file
          );
        }

        previews.push({
          file,
          originalContent,
          proposedContent: newContent,
          changed: originalContent !== newContent,
          addedLines,
          removedLines,
          diffPreview: buildDiffPreview(
            file,
            originalContent,
            newContent,
            maxDiffPreviewLines
          )
        });
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

  const totalAddedLines = previews.reduce(
    (total, preview) => total + preview.addedLines,
    0
  );
  const totalRemovedLines = previews.reduce(
    (total, preview) => total + preview.removedLines,
    0
  );
  const changedFiles = previews.filter((preview) => preview.changed).length;

  return {
    decision: selectDecision(issues),
    issues,
    previews,
    summary: {
      totalFiles: previews.length,
      changedFiles,
      unchangedFiles: previews.length - changedFiles,
      totalAddedLines,
      totalRemovedLines
    }
  };
}

export function dryRunPatchApplication(mutation: WorkspaceMutation, finding: WorkspaceMutation, context: PatchApplicationDryRunContext): PatchApplicationDryRunResult {
  try { validateUpdateSourceMap(parseTextFileUpdates(mutation), context.fileContents); }
  catch (error) {
    if (!(error instanceof MutationContractError)) throw error;
    const review = ["MUTATION_NO_CHANGE", "MUTATION_SOURCE_HASH_MISMATCH"].includes(error.code);
    return { decision: review ? "needs_review" : "reject", issues: [{ code: error.code, message: error.message, severity: review ? "review" : "reject", ...(error.file ? { file: error.file } : {}) }], previews: [], summary: { totalFiles: 0, changedFiles: 0, unchangedFiles: 0, totalAddedLines: 0, totalRemovedLines: 0 } };
  }
  return dryRunPatchApplicationUnchecked(mutation, finding, context);
}
