import { parseTextFileUpdates, readTextUpdateSource, validateUpdateSource, MutationContractError, MUTATION_LIMITS, type TextFileUpdateClaimV1 } from "./text-file-update-contract.js";
import { realpath } from "node:fs/promises";
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
import { hashCanonicalJson } from "./agent-event-ledger.js";

export const DETERMINISTIC_VERIFIER_V2_VERSION = "deterministic-verifier/v2" as const;

export type VerifierSeverity = "error" | "review";
export type VerifierRuleDisposition = "reject" | "needs_review";

export const VERIFIER_V2_RULES = Object.freeze({
  notCoderPatchDraft: Object.freeze({ id: "DV2_ROLE_TARGET_INVALID", severity: "error", disposition: "reject" }),
  patchClaimMissing: Object.freeze({ id: "DV2_PATCH_CLAIM_MISSING", severity: "error", disposition: "reject" }),
  patchClaimInvalid: Object.freeze({ id: "DV2_PATCH_CLAIM_INVALID", severity: "error", disposition: "reject" }),
  patchClaimDuplicate: Object.freeze({ id: "DV2_PATCH_CLAIM_DUPLICATE", severity: "error", disposition: "reject" }),
  pathInvalid: Object.freeze({ id: "DV2_PATH_INVALID", severity: "error", disposition: "reject" }),
  pathSymlink: Object.freeze({ id: "DV2_PATH_SYMLINK", severity: "error", disposition: "reject" }),
  pathOutsideRepository: Object.freeze({ id: "DV2_PATH_OUTSIDE_REPOSITORY", severity: "error", disposition: "reject" }),
  sourceHashMismatch: Object.freeze({ id: "DV2_SOURCE_HASH_MISMATCH", severity: "review", disposition: "needs_review" }),
  pathMissing: Object.freeze({ id: "DV2_PATH_MISSING", severity: "review", disposition: "needs_review" }),
  touchedClaimMismatch: Object.freeze({ id: "DV2_TOUCHED_CLAIM_MISMATCH", severity: "error", disposition: "reject" }),
  forbiddenFile: Object.freeze({ id: "DV2_FORBIDDEN_FILE", severity: "error", disposition: "reject" }),
  allowlistViolation: Object.freeze({ id: "DV2_ALLOWLIST_VIOLATION", severity: "error", disposition: "reject" }),
  unsafePatch: Object.freeze({ id: "DV2_UNSAFE_PATCH", severity: "error", disposition: "reject" }),
  lowConfidence: Object.freeze({ id: "DV2_LOW_CONFIDENCE", severity: "review", disposition: "needs_review" }),
  policyBindingInvalid: Object.freeze({ id: "DV2_POLICY_BINDING_INVALID", severity: "error", disposition: "reject" })
} as const);

export type VerifierV2RuleId = (typeof VERIFIER_V2_RULES)[keyof typeof VERIFIER_V2_RULES]["id"];

type VerifierV2Rule = (typeof VERIFIER_V2_RULES)[keyof typeof VERIFIER_V2_RULES];

export type VerifierV2Issue = Readonly<{
  ruleId: VerifierV2RuleId | `MUTATION_${string}`;
  mutationCode?: string;
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
  /** Trusted records from the successful bound context flow, never model output. */
  boundContextFiles?: readonly { path: string; contentHash: string }[];
  /** Canonical policy artifact hash. Older direct callers receive a closed compatibility binding. */
  policyHash?: string;
}>;

export type DeterministicVerifierV2Result = Readonly<{
  version: typeof DETERMINISTIC_VERIFIER_V2_VERSION;
  ok: boolean;
  decision: "approve" | "needs_review" | "reject";
  issues: readonly VerifierV2Issue[];
  canonicalTouchedFiles: readonly string[];
  canonicalClaimFiles: readonly string[];
  policyHash: string;
  finding: WorkspaceMutation;
}>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const LEGACY_POLICY_HASH = hashCanonicalJson({ policyBinding: "legacy-deterministic-verifier-v2" });

const UNSAFE_PATCH_NEEDLES = ["process.env", "SECRET", "TOKEN", "PASSWORD", ".env", "rm -rf", "curl ", "wget "] as const;

function issue(
  rule: VerifierV2Rule,
  message: string,
  extra: { field?: string; file?: string } = {}
): VerifierV2Issue {
  return Object.freeze({
    ruleId: rule.id,
    severity: rule.severity,
    disposition: rule.disposition,
    message,
    ...extra
  });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutationIssue(error: MutationContractError): VerifierV2Issue {
  const review = ["MUTATION_NO_CHANGE", "MUTATION_SOURCE_HASH_MISMATCH"].includes(error.code);
  return { ruleId: error.code as `MUTATION_${string}`, mutationCode: error.code,
    message: error.message, severity: review ? "review" : "error",
    disposition: review ? "needs_review" : "reject", ...(error.file ? { file: error.file } : {}) };
}

function buildFinding(
  mutation: WorkspaceMutation,
  decision: DeterministicVerifierV2Result["decision"],
  issues: readonly VerifierV2Issue[],
  policyHash: string
): WorkspaceMutation {
  return createWorkspaceMutation({
    role: "verifier",
    target: "verifierFinding",
    summary: decision === "approve" ? "Deterministic verifier v2 approved coder patchDraft." : `Deterministic verifier v2 returned ${decision}.`,
    claims: [{ type: "deterministic_verifier_v2_finding", version: DETERMINISTIC_VERIFIER_V2_VERSION, decision, issues, policyHash }],
    touchedFiles: [...mutation.touchedFiles],
    confidence: 1
  });
}

export async function verifyPatchDraftMutationV2(
  input: VerifyPatchDraftMutationV2Input
): Promise<DeterministicVerifierV2Result> {
  const issues: VerifierV2Issue[] = [];
  const policyHash = input.policyHash ?? LEGACY_POLICY_HASH;
  if (!HASH.test(policyHash)) {
    issues.push(issue(VERIFIER_V2_RULES.policyBindingInvalid,
      "Verifier requires a valid canonical policy hash.", { field: "policyHash" }));
  }
  let updates: TextFileUpdateClaimV1[] = [];
  try { updates = parseTextFileUpdates(input.mutation); } catch (error) {
    if (!(error instanceof MutationContractError)) throw error;
    issues.push(mutationIssue(error));
  }
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
    const newContent = claim.newContent;
    if (typeof newContent !== "string") {
      issues.push(issue(VERIFIER_V2_RULES.patchClaimInvalid, "patch_draft newContent is required.", { field: `mutation.claims.${index}.newContent`, file: file ?? undefined }));
    } else if (UNSAFE_PATCH_NEEDLES.some((needle) => newContent.includes(needle))) {
      issues.push(issue(VERIFIER_V2_RULES.unsafePatch, "newContent contains an unsafe content marker.", { field: `mutation.claims.${index}.newContent`, file: file ?? undefined }));
    }
  }

  const seenClaimFiles = new Set<string>();
  for (const file of claimFiles) {
    if (seenClaimFiles.has(file)) {
      issues.push(issue(VERIFIER_V2_RULES.patchClaimDuplicate,
        "Only one patch_draft claim per canonical file is allowed.",
        { field: "mutation.claims", file }));
    }
    seenClaimFiles.add(file);
  }

  const canonicalClaimFiles = uniqueSorted(claimFiles);
  if (touched.length !== canonicalClaimFiles.length || touched.some((value, index) => value !== canonicalClaimFiles[index])) {
    issues.push(issue(VERIFIER_V2_RULES.touchedClaimMismatch, "touchedFiles and patch claim files must match exactly."));
  }

  const allowedSet = new Set(allowed);
  const forbiddenSet = new Set(forbidden);
  let sourceTotal = 0;
  for (const file of touched) {
    if (!allowedSet.has(file)) issues.push(issue(VERIFIER_V2_RULES.allowlistViolation, "Touched file is outside the explicit allowlist.", { file }));
    if (forbiddenSet.has(file)) issues.push(issue(VERIFIER_V2_RULES.forbiddenFile, "Touched file is explicitly forbidden.", { file }));
    // Every new-schema update is checked through the same bounded source reader as apply.
    for (const claim of updates.filter((entry) => entry.file === file)) {
      try {
        const source = await readTextUpdateSource(repositoryRoot, file);
        sourceTotal += source.bytes.length;
        if (sourceTotal > MUTATION_LIMITS.maxTotalBytes) throw new MutationContractError("MUTATION_TOTAL_LIMIT_EXCEEDED", "Source total exceeds 4 MiB.");
        const records = (input.boundContextFiles ?? []).filter((entry) => entry.path === file);
        if (records.length !== 1 || records[0].contentHash !== claim.expectedContentHash) throw new MutationContractError("MUTATION_SOURCE_HASH_MISMATCH", "Claim differs from verified bound context.", file);
        validateUpdateSource(claim, source.bytes);
      } catch (error) {
        if (error instanceof MutationContractError) {
          const missingSnapshotFile = error.code === "MUTATION_CREATE_UNSUPPORTED" && (input.boundContextFiles ?? []).some((entry) => entry.path === file);
          issues.push(mutationIssue(missingSnapshotFile ? new MutationContractError("MUTATION_SOURCE_HASH_MISMATCH", "A bound source file disappeared after context creation.", file) : error));
        }
        else issues.push(mutationIssue(new MutationContractError("MUTATION_SOURCE_HASH_MISMATCH", "Current source could not be verified.", file)));
      }
    }
  }

  if (input.mutation.confidence !== undefined && input.mutation.confidence < minConfidence) {
    issues.push(issue(VERIFIER_V2_RULES.lowConfidence, `Mutation confidence is below ${minConfidence}.`, { field: "mutation.confidence" }));
  }

  let decision: DeterministicVerifierV2Result["decision"] = "approve";
  if (issues.some((entry) => entry.disposition === "reject")) decision = "reject";
  else if (issues.length > 0) decision = "needs_review";

  let finding = buildFinding(input.mutation, decision, issues, policyHash);
  if (!validateWorkspaceMutationContract(finding).ok) {
    const fallback = issue(VERIFIER_V2_RULES.patchClaimInvalid, "Generated verifier finding failed contract validation.", { field: "finding" });
    issues.push(fallback);
    decision = "reject";
    finding = buildFinding(input.mutation, decision, issues, policyHash);
  }

  return Object.freeze({
    version: DETERMINISTIC_VERIFIER_V2_VERSION,
    ok: decision === "approve",
    decision,
    issues: Object.freeze([...issues]),
    canonicalTouchedFiles: Object.freeze(touched),
    canonicalClaimFiles: Object.freeze(canonicalClaimFiles),
    policyHash,
    finding
  });
}
