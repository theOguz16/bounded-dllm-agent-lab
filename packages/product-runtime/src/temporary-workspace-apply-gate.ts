import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PatchApplicationDryRunResult } from "./patch-application-dry-run-gate.js";
import type { WorkspaceMutation } from "./workspace-mutation.js";

export type TempWorkspaceApplyDecision =
  | "temp_apply_ready"
  | "temp_apply_needs_review"
  | "temp_apply_rejected";

export type TempWorkspaceApplyIssue = {
  code: string;
  message: string;
  file?: string;
  severity: "review" | "reject";
};

export type TempWorkspaceAppliedFile = {
  file: string;
  tempPath: string;
  originalContent: string;
  appliedContent: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  diffPreview: string;
};

export type TemporaryWorkspaceApplyContext = {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  fileContents: Record<string, string>;
  tempRoot?: string;
  cleanup?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxDiffPreviewLines?: number;
};

export type TemporaryWorkspaceApplyResult = {
  decision: TempWorkspaceApplyDecision;
  issues: TempWorkspaceApplyIssue[];
  tempWorkspacePath: string | null;
  appliedFiles: TempWorkspaceAppliedFile[];
  summary: {
    totalFiles: number;
    changedFiles: number;
    unchangedFiles: number;
    totalAddedLines: number;
    totalRemovedLines: number;
    cleanedUp: boolean;
  };
};

const defaultMaxFiles = 10;
const defaultMaxFileBytes = 100_000;
const defaultMaxDiffPreviewLines = 80;

type RepairDraftClaim = {
  file: string;
  proposedPatch: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: TempWorkspaceApplyIssue[],
  code: string,
  message: string,
  severity: TempWorkspaceApplyIssue["severity"],
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
  issues: TempWorkspaceApplyIssue[]
): TempWorkspaceApplyDecision {
  if (issues.some((issue) => issue.severity === "reject")) {
    return "temp_apply_rejected";
  }

  if (issues.some((issue) => issue.severity === "review")) {
    return "temp_apply_needs_review";
  }

  return "temp_apply_ready";
}

function emptyResult(
  issues: TempWorkspaceApplyIssue[],
  tempWorkspacePath: string | null = null,
  cleanedUp = false
): TemporaryWorkspaceApplyResult {
  return {
    decision: selectDecision(issues),
    issues,
    tempWorkspacePath,
    appliedFiles: [],
    summary: {
      totalFiles: 0,
      changedFiles: 0,
      unchangedFiles: 0,
      totalAddedLines: 0,
      totalRemovedLines: 0,
      cleanedUp
    }
  };
}

function isUnsafeFilePath(file: string): boolean {
  return (
    file.length === 0 ||
    path.isAbsolute(file) ||
    file.startsWith("/") ||
    file === ".git" ||
    file.startsWith(".git/") ||
    file.includes("..") ||
    file.includes("\\")
  );
}

function addPathSafetyIssue(
  issues: TempWorkspaceApplyIssue[],
  file: string
): void {
  if (isUnsafeFilePath(file)) {
    addIssue(
      issues,
      "unsafe_file_path",
      `File path is unsafe for temporary workspace apply: ${file}`,
      "reject",
      file
    );
  }
}

function addScopeIssues(
  issues: TempWorkspaceApplyIssue[],
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

function findApprovedRepairVerifierClaim(finding: WorkspaceMutation): boolean {
  const claimList = Array.isArray(finding.claims) ? finding.claims : [];

  for (const claim of claimList) {
    if (
      isRecord(claim) &&
      claim.type === "deterministic_repair_draft_verifier_finding" &&
      claim.decision === "approve"
    ) {
      return true;
    }
  }

  return false;
}

function collectRepairDraftClaims(
  repairDraftMutation: WorkspaceMutation
): RepairDraftClaim[] {
  const claimList = Array.isArray(repairDraftMutation.claims)
    ? repairDraftMutation.claims
    : [];
  const claims: RepairDraftClaim[] = [];

  for (const claim of claimList) {
    if (!isRecord(claim) || claim.type !== "repair_draft") {
      continue;
    }

    const file = typeof claim.file === "string" ? claim.file.trim() : "";
    const proposedPatch =
      typeof claim.proposedPatch === "string" ? claim.proposedPatch : "";

    claims.push({ file, proposedPatch });
  }

  return claims;
}

function hasChangedPatchDryRunPreview(
  patchDryRunResult: PatchApplicationDryRunResult
): boolean {
  if (!Array.isArray(patchDryRunResult.previews)) {
    return false;
  }

  return patchDryRunResult.previews.some((preview) => preview.changed);
}

function addPatchDryRunPreviewPathIssues(
  issues: TempWorkspaceApplyIssue[],
  patchDryRunResult: PatchApplicationDryRunResult
): void {
  if (!Array.isArray(patchDryRunResult.previews)) {
    return;
  }

  for (const preview of patchDryRunResult.previews) {
    addPathSafetyIssue(issues, typeof preview.file === "string" ? preview.file : "");
  }
}

function isWithinTempWorkspace(tempWorkspacePath: string, targetPath: string): boolean {
  const relativePath = path.relative(tempWorkspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function cleanupTempWorkspace(tempWorkspacePath: string | null): boolean {
  if (tempWorkspacePath === null) {
    return false;
  }

  fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
  return true;
}

export function applyToTemporaryWorkspace(
  repairDraftMutation: WorkspaceMutation,
  repairVerifierFinding: WorkspaceMutation,
  patchDryRunResult: PatchApplicationDryRunResult,
  context: TemporaryWorkspaceApplyContext
): TemporaryWorkspaceApplyResult {
  const issues: TempWorkspaceApplyIssue[] = [];
  const allowedFiles = new Set(context.allowedFiles ?? []);
  const forbiddenFiles = new Set(context.forbiddenFiles ?? []);
  const fileContents = isRecord(context.fileContents) ? context.fileContents : {};
  const cleanup = context.cleanup ?? true;
  const maxFiles = context.maxFiles ?? defaultMaxFiles;
  const maxFileBytes = context.maxFileBytes ?? defaultMaxFileBytes;
  const maxDiffPreviewLines =
    context.maxDiffPreviewLines ?? defaultMaxDiffPreviewLines;

  if (repairDraftMutation.role !== "remask") {
    addIssue(
      issues,
      "not_remask_repair_draft",
      'Mutation role must be "remask" for temporary workspace apply.',
      "reject"
    );
  }

  if (repairDraftMutation.target !== "repairDraft") {
    addIssue(
      issues,
      "not_repair_draft_target",
      'Mutation target must be "repairDraft" for temporary workspace apply.',
      "reject"
    );
  }

  const repairDraftClaims = collectRepairDraftClaims(repairDraftMutation);

  if (repairDraftClaims.length === 0) {
    addIssue(
      issues,
      "missing_repair_draft_claim",
      'repairDraft mutation must include at least one "repair_draft" claim.',
      "review"
    );
  }

  if (
    repairVerifierFinding.role !== "verifier" ||
    repairVerifierFinding.target !== "verifierFinding" ||
    !findApprovedRepairVerifierClaim(repairVerifierFinding)
  ) {
    addIssue(
      issues,
      "repair_verifier_not_approved",
      "repairVerifierFinding must be an approved deterministic repairDraft verifier finding.",
      "reject"
    );
  }

  if (patchDryRunResult.decision !== "ready_to_apply") {
    addIssue(
      issues,
      "patch_dry_run_not_ready",
      'patchDryRunResult decision must be "ready_to_apply".',
      "reject"
    );
  }

  if (!hasChangedPatchDryRunPreview(patchDryRunResult)) {
    addIssue(
      issues,
      "missing_patch_dry_run_preview",
      "patchDryRunResult previews must include at least one changed file.",
      "review"
    );
  }

  addPatchDryRunPreviewPathIssues(issues, patchDryRunResult);

  if (repairDraftClaims.length > maxFiles) {
    addIssue(
      issues,
      "too_many_files",
      `repair_draft file count exceeds maxFiles: ${repairDraftClaims.length} > ${maxFiles}`,
      "review"
    );
  }

  for (const claim of repairDraftClaims) {
    const { file, proposedPatch } = claim;
    addPathSafetyIssue(issues, file);

    if (file.length > 0) {
      addScopeIssues(issues, file, allowedFiles, forbiddenFiles);

      if (!Object.prototype.hasOwnProperty.call(fileContents, file)) {
        addIssue(
          issues,
          "missing_original_file_content",
          `Missing original file content for repair draft file: ${file}`,
          "review",
          file
        );
      } else if (fileContents[file] === proposedPatch) {
        addIssue(
          issues,
          "no_op_patch",
          `proposedPatch is identical to original content: ${file}`,
          "review",
          file
        );
      }
    }

    if (Buffer.byteLength(proposedPatch, "utf8") > maxFileBytes) {
      addIssue(
        issues,
        "proposed_patch_too_large",
        `proposedPatch byte length exceeds maxFileBytes: ${Buffer.byteLength(proposedPatch, "utf8")} > ${maxFileBytes}`,
        "review",
        file || undefined
      );
    }
  }

  if (issues.length > 0) {
    return emptyResult(issues);
  }

  let tempWorkspacePath: string | null = null;
  const appliedFiles: TempWorkspaceAppliedFile[] = [];
  let cleanedUp = false;

  try {
    const tempParent = path.resolve(context.tempRoot ?? os.tmpdir());
    tempWorkspacePath = fs.mkdtempSync(path.join(tempParent, "bounded-dllm-temp-apply-"));
    const resolvedTempWorkspacePath = path.resolve(tempWorkspacePath);

    for (const claim of repairDraftClaims) {
      const originalContent = String(fileContents[claim.file]);
      const appliedContent = claim.proposedPatch;
      const targetPath = path.resolve(resolvedTempWorkspacePath, claim.file);

      if (!isWithinTempWorkspace(resolvedTempWorkspacePath, targetPath)) {
        addIssue(
          issues,
          "temp_workspace_escape_attempt",
          `Resolved temp target path escapes temporary workspace: ${claim.file}`,
          "reject",
          claim.file
        );
        cleanedUp = cleanupTempWorkspace(tempWorkspacePath);
        return emptyResult(issues, tempWorkspacePath, cleanedUp);
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, originalContent, "utf8");
      fs.writeFileSync(targetPath, appliedContent, "utf8");

      const { addedLines, removedLines } = countChangedLines(
        originalContent,
        appliedContent
      );

      appliedFiles.push({
        file: claim.file,
        tempPath: targetPath,
        originalContent,
        appliedContent,
        changed: originalContent !== appliedContent,
        addedLines,
        removedLines,
        diffPreview: buildDiffPreview(
          claim.file,
          originalContent,
          appliedContent,
          maxDiffPreviewLines
        )
      });
    }

    if (cleanup) {
      cleanedUp = cleanupTempWorkspace(tempWorkspacePath);
    }
  } catch (error) {
    addIssue(
      issues,
      "temp_workspace_apply_failed",
      `Temporary workspace apply failed: ${error instanceof Error ? error.message : String(error)}`,
      "reject"
    );

    if (cleanup) {
      cleanedUp = cleanupTempWorkspace(tempWorkspacePath);
    }

    return emptyResult(issues, tempWorkspacePath, cleanedUp);
  }

  const totalAddedLines = appliedFiles.reduce(
    (total, appliedFile) => total + appliedFile.addedLines,
    0
  );
  const totalRemovedLines = appliedFiles.reduce(
    (total, appliedFile) => total + appliedFile.removedLines,
    0
  );
  const changedFiles = appliedFiles.filter((appliedFile) => appliedFile.changed).length;

  return {
    decision: selectDecision(issues),
    issues,
    tempWorkspacePath,
    appliedFiles,
    summary: {
      totalFiles: appliedFiles.length,
      changedFiles,
      unchangedFiles: appliedFiles.length - changedFiles,
      totalAddedLines,
      totalRemovedLines,
      cleanedUp
    }
  };
}
