export const PRODUCT_TASK_CONTRACT_VERSION = "product-task/v1" as const;

export const PRODUCT_TASK_FAMILIES = Object.freeze([
  "existing_function_bug_fix",
  "bounded_behavior_change",
  "regression_test_addition"
] as const);

export type ProductTaskFamily = (typeof PRODUCT_TASK_FAMILIES)[number];

export type ProductTask = Readonly<{
  schemaVersion: typeof PRODUCT_TASK_CONTRACT_VERSION;
  taskId: string;
  family: ProductTaskFamily;
  repo: string;
  commitSha: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  validationCommands: readonly string[];
}>;

export type ProductTaskValidation = Readonly<{
  ok: boolean;
  reasons: readonly string[];
}>;

export class ProductTaskContractError extends Error {
  readonly code = "product_task_invalid" as const;

  constructor(readonly reasons: readonly string[]) {
    super(`Product benchmark task is invalid: ${reasons.join(", ")}`);
  }
}

const EXACT_KEYS = Object.freeze([
  "schemaVersion",
  "taskId",
  "family",
  "repo",
  "commitSha",
  "objective",
  "acceptanceCriteria",
  "validationCommands"
] as const);
const EXACT_KEY_SET = new Set<string>(EXACT_KEYS);
const TASK_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const MAX_OBJECTIVE_CHARS = 4096;
const MAX_CRITERIA = 32;
const MAX_CRITERION_CHARS = 1024;
const MAX_VALIDATION_COMMANDS = 16;
const MAX_COMMAND_CHARS = 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExactKeys(value: Record<string, unknown>, reasons: string[]): void {
  const keys = Object.keys(value);
  for (const key of EXACT_KEYS) {
    if (!Object.hasOwn(value, key)) reasons.push(`missing_${key}`);
  }
  for (const key of keys) {
    if (!EXACT_KEY_SET.has(key)) reasons.push(`unexpected_${key}`);
  }
}

function validateStringList(
  value: unknown,
  field: "acceptanceCriteria" | "validationCommands",
  maxItems: number,
  maxChars: number,
  reasons: string[]
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    reasons.push(`${field}_invalid`);
    return;
  }

  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.trim() !== entry ||
      entry.length === 0 ||
      entry.length > maxChars ||
      entry.includes("\0")
    ) {
      reasons.push(`${field}_entry_invalid`);
      continue;
    }
    if (seen.has(entry)) reasons.push(`${field}_duplicate`);
    seen.add(entry);
  }
}

export function validateProductTask(value: unknown): ProductTaskValidation {
  const reasons: string[] = [];
  if (!isObject(value)) {
    return Object.freeze({
      ok: false,
      reasons: Object.freeze(["task_not_object"])
    });
  }

  validateExactKeys(value, reasons);

  if (value.schemaVersion !== PRODUCT_TASK_CONTRACT_VERSION) {
    reasons.push("schema_version_invalid");
  }
  if (typeof value.taskId !== "string" || !TASK_ID.test(value.taskId)) {
    reasons.push("task_id_invalid");
  }
  if (
    typeof value.family !== "string" ||
    !(PRODUCT_TASK_FAMILIES as readonly string[]).includes(value.family)
  ) {
    reasons.push("family_invalid");
  }
  if (typeof value.repo !== "string" || !REPO.test(value.repo)) {
    reasons.push("repo_invalid");
  }
  if (typeof value.commitSha !== "string" || !SHA40.test(value.commitSha)) {
    reasons.push("commit_sha_invalid");
  }
  if (
    typeof value.objective !== "string" ||
    value.objective.trim() !== value.objective ||
    value.objective.length < 8 ||
    value.objective.length > MAX_OBJECTIVE_CHARS ||
    value.objective.includes("\0")
  ) {
    reasons.push("objective_invalid");
  }

  validateStringList(
    value.acceptanceCriteria,
    "acceptanceCriteria",
    MAX_CRITERIA,
    MAX_CRITERION_CHARS,
    reasons
  );
  validateStringList(
    value.validationCommands,
    "validationCommands",
    MAX_VALIDATION_COMMANDS,
    MAX_COMMAND_CHARS,
    reasons
  );

  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)])
  });
}

export function parseProductTask(value: unknown): ProductTask {
  const validation = validateProductTask(value);
  if (!validation.ok) throw new ProductTaskContractError(validation.reasons);

  const task = value as Record<string, unknown>;
  return Object.freeze({
    schemaVersion: PRODUCT_TASK_CONTRACT_VERSION,
    taskId: task.taskId as string,
    family: task.family as ProductTaskFamily,
    repo: task.repo as string,
    commitSha: task.commitSha as string,
    objective: task.objective as string,
    acceptanceCriteria: Object.freeze([...(task.acceptanceCriteria as string[])]),
    validationCommands: Object.freeze([...(task.validationCommands as string[])])
  });
}

/**
 * Provider-visible input is deliberately identical to the strict public task
 * contract. Hidden evaluator/oracle data must be loaded through a separate
 * benchmark evaluator path and can never be smuggled through extra task keys.
 */
export function createProductTaskProviderInput(value: unknown): ProductTask {
  return parseProductTask(value);
}
