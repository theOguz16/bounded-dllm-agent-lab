import { hashCanonicalJson } from "./agent-event-ledger.js";

export const EXTERNAL_REPOSITORY_TASK_CONTRACT_VERSION = "external-repository-task/v1" as const;

export type ExternalRepositoryTaskManifest = Readonly<{
  version: typeof EXTERNAL_REPOSITORY_TASK_CONTRACT_VERSION;
  repository: Readonly<{
    owner: string;
    name: string;
    commitSha: string;
  }>;
  taskId: string;
  taskDescription: string;
  providerVisibleContextHash: string;
  evaluatorOracleHash: string;
  acceptanceCommands: readonly string[];
  allowedChangeFiles: readonly string[];
  forbiddenFiles: readonly string[];
  manifestHash: string;
}>;

export type ExternalRepositoryTaskValidation = Readonly<{
  ok: boolean;
  reasons: readonly string[];
}>;

const SHA40 = /^[0-9a-f]{40}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b)));
}

function core(input: Omit<ExternalRepositoryTaskManifest, "version" | "manifestHash">) {
  return {
    version: EXTERNAL_REPOSITORY_TASK_CONTRACT_VERSION,
    repository: Object.freeze({ ...input.repository }),
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    providerVisibleContextHash: input.providerVisibleContextHash,
    evaluatorOracleHash: input.evaluatorOracleHash,
    acceptanceCommands: sortedUnique(input.acceptanceCommands),
    allowedChangeFiles: sortedUnique(input.allowedChangeFiles),
    forbiddenFiles: sortedUnique(input.forbiddenFiles)
  } as const;
}

export function createExternalRepositoryTaskManifest(
  input: Omit<ExternalRepositoryTaskManifest, "version" | "manifestHash">
): ExternalRepositoryTaskManifest {
  const value = core(input);
  const manifest = Object.freeze({ ...value, manifestHash: hashCanonicalJson(value) });
  const validation = validateExternalRepositoryTaskManifest(manifest);
  if (!validation.ok) throw new TypeError(`External repository task manifest is invalid: ${validation.reasons.join(", ")}`);
  return manifest;
}

export function validateExternalRepositoryTaskManifest(value: unknown): ExternalRepositoryTaskValidation {
  const reasons: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ ok: false, reasons: Object.freeze(["manifest_not_object"]) });
  }
  const manifest = value as Partial<ExternalRepositoryTaskManifest>;
  if (manifest.version !== EXTERNAL_REPOSITORY_TASK_CONTRACT_VERSION) reasons.push("version_invalid");
  if (!manifest.repository || typeof manifest.repository !== "object") reasons.push("repository_missing");
  else {
    if (!STABLE_ID.test(manifest.repository.owner ?? "")) reasons.push("repository_owner_invalid");
    if (!STABLE_ID.test(manifest.repository.name ?? "")) reasons.push("repository_name_invalid");
    if (!SHA40.test(manifest.repository.commitSha ?? "")) reasons.push("commit_sha_invalid");
  }
  if (!STABLE_ID.test(manifest.taskId ?? "")) reasons.push("task_id_invalid");
  if (typeof manifest.taskDescription !== "string" || manifest.taskDescription.trim() !== manifest.taskDescription || manifest.taskDescription.length < 8) reasons.push("task_description_invalid");
  if (!HASH.test(manifest.providerVisibleContextHash ?? "")) reasons.push("provider_context_hash_invalid");
  if (!HASH.test(manifest.evaluatorOracleHash ?? "")) reasons.push("evaluator_oracle_hash_invalid");
  for (const [field, items] of [["acceptance", manifest.acceptanceCommands], ["allowed", manifest.allowedChangeFiles], ["forbidden", manifest.forbiddenFiles]] as const) {
    if (!Array.isArray(items) || items.length === 0) reasons.push(`${field}_list_invalid`);
    else if (items.some((entry) => typeof entry !== "string" || entry.trim() !== entry || entry.length === 0)) reasons.push(`${field}_entry_invalid`);
  }
  if (Array.isArray(manifest.allowedChangeFiles) && Array.isArray(manifest.forbiddenFiles)) {
    const forbidden = new Set(manifest.forbiddenFiles);
    if (manifest.allowedChangeFiles.some((file) => forbidden.has(file))) reasons.push("scope_overlap");
  }
  if (reasons.length === 0) {
    const expected = hashCanonicalJson(core({
      repository: manifest.repository!,
      taskId: manifest.taskId!,
      taskDescription: manifest.taskDescription!,
      providerVisibleContextHash: manifest.providerVisibleContextHash!,
      evaluatorOracleHash: manifest.evaluatorOracleHash!,
      acceptanceCommands: manifest.acceptanceCommands!,
      allowedChangeFiles: manifest.allowedChangeFiles!,
      forbiddenFiles: manifest.forbiddenFiles!
    }));
    if (manifest.manifestHash !== expected) reasons.push("manifest_hash_invalid");
  }
  return Object.freeze({ ok: reasons.length === 0, reasons: Object.freeze(reasons) });
}
