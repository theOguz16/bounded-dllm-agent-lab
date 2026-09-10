import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createCanonicalRepositoryContentSnapshot,
  hashCanonicalJson,
  parseTextFileUpdates,
  type AcceptanceCriteriaContract,
  type CanonicalGovernedExecutionInput,
  type TemporaryWorkspaceExecutionSpecification,
  type ValidationProfileId,
  type WorkspaceMutation
} from "../../../packages/product-runtime/src/canonical-runtime.js";
import { CliError } from "./cli-errors.js";

export const BOUNDED_CANDIDATE_HANDOFF_VERSION = "bounded-candidate-handoff/v1" as const;
export const BOUNDED_CANDIDATE_HANDOFF_PATH = ".bounded/state/candidate-handoff.json" as const;

const VOLATILE_BOUNDED_PREFIXES = [
  ".bounded/runs",
  ".bounded/state",
  ".bounded/tmp",
  ".bounded/cache"
] as const;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_HANDOFF_BYTES = 16 * 1024 * 1024;

export type BoundedCandidateHandoff = Readonly<{
  handoffVersion: typeof BOUNDED_CANDIDATE_HANDOFF_VERSION;
  taskId: string;
  objectiveHash: string;
  sourceSnapshotHash: string;
  planHash: string;
  contextBindingHash: string;
  plannerExecutionBindingHash: string;
  compiledPolicyHash: string;
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
  validationProfile: ValidationProfileId;
  phaseVExecutionSpecification: TemporaryWorkspaceExecutionSpecification;
  coderMutation: WorkspaceMutation;
  verifierFinding: WorkspaceMutation;
  adaptiveResult: unknown;
  declaredRiskClass: "low" | "medium" | "high" | "critical";
  candidateFiles: readonly string[];
  handoffHash: string;
}>;

export type CandidateHandoffInput = Omit<BoundedCandidateHandoff, "handoffVersion" | "handoffHash">;

function isVolatileBoundedPath(file: string): boolean {
  return VOLATILE_BOUNDED_PREFIXES.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

export function captureCandidateSourceSnapshotHash(repositoryRoot: string): string {
  const snapshot = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  return hashCanonicalJson({
    snapshotVersion: "bounded-candidate-source-snapshot/v1",
    canonicalSnapshotVersion: snapshot.snapshotVersion,
    scope: snapshot.scope,
    records: snapshot.records.filter((record) => !isVolatileBoundedPath(record.path))
  });
}

function handoffMaterial(value: Omit<BoundedCandidateHandoff, "handoffHash">): unknown {
  return value;
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new CliError("cli_candidate_handoff_invalid", `${field} is not a canonical hash.`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CliError("cli_candidate_handoff_invalid", `${field} must be a string array.`);
  }
}

export function createCandidateHandoff(input: CandidateHandoffInput): BoundedCandidateHandoff {
  const withoutHash: Omit<BoundedCandidateHandoff, "handoffHash"> = {
    handoffVersion: BOUNDED_CANDIDATE_HANDOFF_VERSION,
    ...input,
    allowedFiles: [...input.allowedFiles],
    forbiddenFiles: [...input.forbiddenFiles],
    candidateFiles: [...input.candidateFiles]
  };
  const handoffHash = hashCanonicalJson(handoffMaterial(withoutHash));
  return Object.freeze({ ...withoutHash, handoffHash });
}

export function validateCandidateHandoff(value: unknown): BoundedCandidateHandoff {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("cli_candidate_handoff_invalid", "Candidate handoff must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const fields = [
    "handoffVersion", "taskId", "objectiveHash", "sourceSnapshotHash", "planHash",
    "contextBindingHash", "plannerExecutionBindingHash", "compiledPolicyHash", "allowedFiles",
    "forbiddenFiles", "acceptanceCriteriaContract", "validationProfile",
    "phaseVExecutionSpecification", "coderMutation", "verifierFinding", "adaptiveResult",
    "declaredRiskClass", "candidateFiles", "handoffHash"
  ];
  if (Object.keys(record).sort().join("\u0000") !== [...fields].sort().join("\u0000") ||
      record.handoffVersion !== BOUNDED_CANDIDATE_HANDOFF_VERSION ||
      typeof record.taskId !== "string" || record.taskId.length === 0 ||
      !["structural_draft", "existing_function_bug_fix", "existing_file_behavior_change", "existing_test_regression"].includes(String(record.validationProfile)) ||
      !["low", "medium", "high", "critical"].includes(String(record.declaredRiskClass))) {
    throw new CliError("cli_candidate_handoff_invalid", "Candidate handoff has an invalid shape or version.");
  }
  for (const field of [
    "objectiveHash", "sourceSnapshotHash", "planHash", "contextBindingHash",
    "plannerExecutionBindingHash", "compiledPolicyHash", "handoffHash"
  ]) assertHash(record[field], field);
  assertStringArray(record.allowedFiles, "allowedFiles");
  assertStringArray(record.forbiddenFiles, "forbiddenFiles");
  assertStringArray(record.candidateFiles, "candidateFiles");
  const { handoffHash, ...withoutHash } = record;
  if (hashCanonicalJson(handoffMaterial(withoutHash as Omit<BoundedCandidateHandoff, "handoffHash">)) !== handoffHash) {
    throw new CliError("cli_candidate_handoff_invalid", "Candidate handoff integrity hash does not match.");
  }
  parseTextFileUpdates(record.coderMutation as WorkspaceMutation);
  return value as BoundedCandidateHandoff;
}

async function assertStateDirectorySafe(repositoryRoot: string): Promise<string> {
  const bounded = path.join(repositoryRoot, ".bounded");
  const boundedStat = await lstat(bounded).catch(() => null);
  if (!boundedStat || !boundedStat.isDirectory() || boundedStat.isSymbolicLink()) {
    throw new CliError("cli_candidate_handoff_state_unsafe", ".bounded must be a real directory.");
  }
  const state = path.join(bounded, "state");
  const stateStat = await lstat(state).catch(() => null);
  if (stateStat?.isSymbolicLink()) {
    throw new CliError("cli_candidate_handoff_state_unsafe", ".bounded/state must not be a symlink.");
  }
  if (stateStat && !stateStat.isDirectory()) {
    throw new CliError("cli_candidate_handoff_state_unsafe", ".bounded/state must be a directory.");
  }
  await mkdir(state, { recursive: true });
  return state;
}

export async function writeCandidateHandoff(
  repositoryRoot: string,
  candidate: BoundedCandidateHandoff
): Promise<void> {
  validateCandidateHandoff(candidate);
  const state = await assertStateDirectorySafe(repositoryRoot);
  const target = path.join(state, "candidate-handoff.json");
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new CliError("cli_candidate_handoff_state_unsafe", "Candidate handoff target is unsafe.");
  }
  const temporary = path.join(state, `candidate-handoff.${process.pid}.tmp`);
  const body = `${JSON.stringify(candidate, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_HANDOFF_BYTES) {
    throw new CliError("cli_candidate_handoff_too_large", "Candidate handoff exceeds the local state size limit.");
  }
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof CliError) throw error;
    throw new CliError("cli_candidate_handoff_write_failed", "Validated candidate handoff could not be persisted.");
  }
}

export async function readCandidateHandoff(repositoryRoot: string): Promise<BoundedCandidateHandoff> {
  await assertStateDirectorySafe(repositoryRoot);
  const target = path.join(repositoryRoot, BOUNDED_CANDIDATE_HANDOFF_PATH);
  const stat = await lstat(target).catch(() => null);
  if (!stat) {
    throw new CliError("cli_candidate_handoff_missing", "No validated candidate is available. Run bounded codex first.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HANDOFF_BYTES) {
    throw new CliError("cli_candidate_handoff_invalid", "Candidate handoff state is unsafe or too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new CliError("cli_candidate_handoff_invalid", "Candidate handoff is not valid JSON.");
  }
  return validateCandidateHandoff(parsed);
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function lines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const output = normalized.split("\n");
  if (output.at(-1) === "") output.pop();
  return output;
}

export async function renderCandidateDiff(
  repositoryRoot: string,
  candidate: BoundedCandidateHandoff
): Promise<string> {
  const claims = parseTextFileUpdates(candidate.coderMutation);
  const chunks: string[] = [];
  for (const claim of claims) {
    const absolute = path.join(repositoryRoot, ...claim.file.split("/"));
    let before: string;
    try {
      before = await readFile(absolute, "utf8");
    } catch {
      throw new CliError("cli_candidate_source_drift", `Candidate source is no longer readable: ${claim.file}.`, 4);
    }
    if (sha256Text(before) !== claim.expectedContentHash) {
      throw new CliError("cli_candidate_source_drift", `Candidate source changed since validation: ${claim.file}.`, 4);
    }
    const beforeLines = lines(before);
    const afterLines = lines(claim.newContent);
    chunks.push([
      `diff --git a/${claim.file} b/${claim.file}`,
      `--- a/${claim.file}`,
      `+++ b/${claim.file}`,
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      ...beforeLines.map((line) => `-${line}`),
      ...afterLines.map((line) => `+${line}`)
    ].join("\n"));
  }
  return `${chunks.join("\n\n")}\n`;
}

export function candidateToGovernedInput(
  repositoryRoot: string,
  candidate: BoundedCandidateHandoff,
  configuration: CanonicalGovernedExecutionInput["configuration"]
): CanonicalGovernedExecutionInput {
  return {
    taskId: candidate.taskId,
    objectiveHash: candidate.objectiveHash,
    repositoryPath: repositoryRoot,
    planHash: candidate.planHash,
    contextBindingHash: candidate.contextBindingHash,
    plannerExecutionBindingHash: candidate.plannerExecutionBindingHash,
    compiledPolicyHash: candidate.compiledPolicyHash,
    coderMutation: candidate.coderMutation,
    verifierFinding: candidate.verifierFinding,
    adaptiveResult: candidate.adaptiveResult,
    allowedFiles: candidate.allowedFiles,
    forbiddenFiles: candidate.forbiddenFiles,
    acceptanceCriteriaContract: candidate.acceptanceCriteriaContract,
    declaredRiskClass: candidate.declaredRiskClass,
    configuration
  };
}
