import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  canonicalizeRepositoryRelativePath,
  CanonicalRepositoryPathError
} from "./runtime-contract-foundation.js";
import {
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type WorkspaceMutation
} from "./workspace-mutation.js";

export const DETERMINISTIC_VERIFIER_V2_VERSION = "deterministic-verifier/v2" as const;

export type VerifierSeverity = "error" | "review";
export type VerifierRuleDisposition = "reject" | "needs_review";

export const VERIFIER_V2_RULES = Object.freeze({
  notCoderPatchDraft: Object.freeze({ id: "DV2_ROLE_TARGET_INVALID", severity: "error", disposition: "reject" }),
  patchClaimMissing: Object.freeze({ id: "DV2_PATCH_CLAIM_MISSING", severity: "error", disposition: "reject" }),
  patchClaimInvalid: Object.freeze({ id: "DV2_PATCH_CLAIM_INVALID", severity: "error", disposition: "reject" }),
  pathInvalid: Object.freeze({ id: "DV2_PATH_INVALID", severity: "error", disposition: "reject" }),
  pathSymlink: Object.freeze({ id: "DV2_PATH_SYMLINK", severity: "error", disposition: "reject" }),
  pathOutsideRepository: Object.freeze({ id: "DV2_PATH_OUTSIDE_REPOSITORY", severity: "error", disposition: "reject" }),
  pathMissing: Object.freeze({ id: "DV2_PATH_MISSING", severity: "review", disposition: "needs_review" }),
  touchedClaimMismatch: Object.freeze({ id: "DV2_TOUCHED_CLAIM_MISMATCH", severity: "error", disposition: "reject" }),
  forbiddenFile: Object.freeze({ id: "DV2_FORBIDDEN_FILE", severity: "error", disposition: "reject" }),
  allowlistViolation: Object.freeze({ id: "DV2_ALLOWLIST_VIOLATION", severity: "error", disposition: "reject" }),
  unsafePatch: Object.freeze({ id: "DV2_UNSAFE_PATCH", severity: "error", disposition: "reject" }),
  lowConfidence: Object.freeze({ id: "DV2_LOW_CONFIDENCE", severity: "review", disposition: "needs_review" })
} as const);

export type VerifierV2RuleId = (typeof VERIFIER_V2_RULES)[keyof typeof VERIFIER_V2_RULES]["id"];

export type VerifierV2Issue = Readonly<{
  ruleId: VerifierV2RuleId;
  severity: VerifierSeverity;
  disposition: VerifierRuleDisposition;
  message: string;
  field?: string;
  file?: string;
}>;

export type VerifyPatchDraftMutationV2Input = Readonly<{
  repositoryPath: string;
  mutation: WorkspaceMutation;
  allowedFiles: readonly string[];
  forbiddenFiles?: readonly string[];
  minConfidence?: number;
  requireExistingTouchedFiles?: boolean;
}>;

export type DeterministicVerifierV2Result = Readonly<{
  version: typeof DETERMINISTIC_VERIFIER_V2_VERSION;
  ok: boolean;
  decision: "approve" | "needs_review" | "reject";
  issues: readonly VerifierV2Issue[];
  canonicalTouchedFiles: readonly string[];
  canonicalClaimFiles: readonly string[];
  finding: WorkspaceMutation;
}>;

const UNSAFE_PATCH_NEEDLES = ["process.env", "SECRET", "TOKEN", "PASSWORD", ".env", "rm -rf", "curl ", "wget "] as const;

function issue(
  rule: (typeof VERIFIER_V2_RULES)[keyof typeof VERIFIER_V2_RULES],
  message: string,
  extra: { field?: string; file?: string } = {}
): VerifierV2Issue {
  return Object.freeze({ ...rule, message, ...extra });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
  requireExisting: boolean
): Promise<VerifierV2Issue[]> {
  const issues: VerifierV2Issue[] = [];
  const absolute = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [issue(VERIFIER_V2_RULES.pathOutsideRepository, "Path resolves outside the repository.", { file: relativePath })];
  }

  const segments = relativePath.split("/");
  let cursor = repositoryRoot;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        issues.push(issue(VERIFIER_V2_RULES.pathSymlink, "Touched paths must not traverse symbolic links.", { file: relativePath }));
        return issues;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (requireExisting && index === segments.length - 1) {
          issues.push(issue(VERIFIER_V2_RULES.pathMissing, "Touched file does not exist in the repository snapshot.", { file: relativePath }));
        }
        return issues;
      }
      throw error;
    }
  }

  const resolved = await realpath(absolute);
  const resolvedRelative = path.relative(repositoryRoot, resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    issues.push(issue(VERIFIER_V2_RULES.pathOutsideRepository, "Resolved path escapes the repository root.", { file: relativePath }));
  }
  return issues;
}

function buildFinding(
  mutation: WorkspaceMutation,
  decision: DeterministicVerifierV2Result["decision"],
  issues: readonly VerifierV2Issue[]
): WorkspaceMutation {
  return createWorkspaceMutation({
    role: "verifier",
    target: "verifierFinding",
    summary: decision === "approve" ? "Deterministic verifier v2 approved coder patchDraft." : `Deterministic verifier v2 returned ${decision}.`,
    claims: [{ type: "deterministic_verifier_v2_finding", version: DETERMINISTIC_VERIFIER_V2_VERSION, decision, issues }],
    touchedFiles: [...mutation.touchedFiles],
    confidence: 1
  });
}

export async function verifyPatchDraftMutationV2(
  input: VerifyPatchDraftMutationV2Input
): Promise<DeterministicVerifierV2Result> {
  const issues: VerifierV2Issue[] = [];
  const minConfidence = input.minConfidence ?? 0.5;
  const requireExisting = input.requireExistingTouchedFiles ?? true;

  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(input.repositoryPath);
  } catch {
    repositoryRoot = path.resolve(input.repositoryPath);
    issues.push(issue(VERIFIER_V2_RULES.pathInvalid, "repositoryPath must resolve to an existing repository directory.", { field: "repositoryPath" }));
  }

  const normalize = (value: unknown, field: string): string | null => {
    try {
      return canonicalizeRepositoryRelativePath(value);
    } catch (error) {
      const message = error instanceof CanonicalRepositoryPathError ? `${error.code}: ${error.message}` : "Path is invalid.";
      issues.push(issue(VERIFIER_V2_RULES.pathInvalid, message, { field, file: typeof value === "string" ? value : undefined }));
      return null;
    }
  };

  const allowed = uniqueSorted(input.allowedFiles.map((value, index) => normalize(value, `allowedFiles.${index}`)).filter((value): value is string => value !== null));
  const forbidden = uniqueSorted((input.forbiddenFiles ?? []).map((value, index) => normalize(value, `forbiddenFiles.${index}`)).filter((value): value is string => value !== null));
  const touched = uniqueSorted(input.mutation.touchedFiles.map((value, index) => normalize(value, `mutation.touchedFiles.${index}`)).filter((value): value is string => value !== null));

  if (input.mutation.role !== "coder" || input.mutation.target !== "patchDraft") {
    issues.push(issue(VERIFIER_V2_RULES.notCoderPatchDraft, "Mutation must be a coder patchDraft."));
  }

  const patchClaims = input.mutation.claims.filter((claim) => isRecord(claim) && claim.type === "patch_draft") as Record<string, unknown>[];
  if (patchClaims.length === 0) {
    issues.push(issue(VERIFIER_V2_RULES.patchClaimMissing, "At least one patch_draft claim is required.", { field: "mutation.claims" }));
  }

  const claimFiles: string[] = [];
  for (let index = 0; index < patchClaims.length; index += 1) {
    const claim = patchClaims[index];
    const file = normalize(claim.file, `mutation.claims.${index}.file`);
    if (file !== null) claimFiles.push(file);
    if (typeof claim.description !== "string" || claim.description.trim().length === 0) {
      issues.push(issue(VERIFIER_V2_RULES.patchClaimInvalid, "patch_draft description is required.", { field: `mutation.claims.${index}.description`, file: file ?? undefined }));
    }
    if (typeof claim.proposedPatch !== "string" || claim.proposedPatch.length === 0) {
      issues.push(issue(VERIFIER_V2_RULES.patchClaimInvalid, "patch_draft proposedPatch is required.", { field: `mutation.claims.${index}.proposedPatch`, file: file ?? undefined }));
    } else if (UNSAFE_PATCH_NEEDLES.some((needle) => claim.proposedPatch.includes(needle))) {
      issues.push(issue(VERIFIER_V2_RULES.unsafePatch, "proposedPatch contains an unsafe content marker.", { field: `mutation.claims.${index}.proposedPatch`, file: file ?? undefined }));
    }
  }

  const canonicalClaimFiles = uniqueSorted(claimFiles);
  if (touched.length !== canonicalClaimFiles.length || touched.some((value, index) => value !== canonicalClaimFiles[index])) {
    issues.push(issue(VERIFIER_V2_RULES.touchedClaimMismatch, "touchedFiles and patch claim files must match exactly."));
  }

  const allowedSet = new Set(allowed);
  const forbiddenSet = new Set(forbidden);
  for (const file of touched) {
    if (!allowedSet.has(file)) issues.push(issue(VERIFIER_V2_RULES.allowlistViolation, "Touched file is outside the explicit allowlist.", { file }));
    if (forbiddenSet.has(file)) issues.push(issue(VERIFIER_V2_RULES.forbiddenFile, "Touched file is explicitly forbidden.", { file }));
    issues.push(...await inspectRepositoryPath(repositoryRoot, file, requireExisting));
  }

  if (input.mutation.confidence !== undefined && input.mutation.confidence < minConfidence) {
    issues.push(issue(VERIFIER_V2_RULES.lowConfidence, `Mutation confidence is below ${minConfidence}.`, { field: "mutation.confidence" }));
  }

  let decision: DeterministicVerifierV2Result["decision"] = "approve";
  if (issues.some((entry) => entry.disposition === "reject")) decision = "reject";
  else if (issues.length > 0) decision = "needs_review";

  let finding = buildFinding(input.mutation, decision, issues);
  if (!validateWorkspaceMutationContract(finding).ok) {
    const fallback = issue(VERIFIER_V2_RULES.patchClaimInvalid, "Generated verifier finding failed contract validation.", { field: "finding" });
    issues.push(fallback);
    decision = "reject";
    finding = buildFinding(input.mutation, decision, issues);
  }

  return Object.freeze({
    version: DETERMINISTIC_VERIFIER_V2_VERSION,
    ok: decision === "approve",
    decision,
    issues: Object.freeze([...issues]),
    canonicalTouchedFiles: Object.freeze(touched),
    canonicalClaimFiles: Object.freeze(canonicalClaimFiles),
    finding
  });
}
