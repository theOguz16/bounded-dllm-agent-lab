import {
  canRoleWriteWorkspaceMutationTarget,
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type ModelRole,
  type WorkspaceMutation,
  type WorkspaceMutationTarget
} from "./workspace-mutation.js";

export type ModelMutationValidationIssueCode =
  | "invalid_json"
  | "invalid_shape"
  | "missing_required_field"
  | "unknown_role"
  | "unknown_target"
  | "role_target_violation"
  | "empty_summary"
  | "claims_not_array"
  | "touched_files_not_array"
  | "invalid_confidence"
  | "scope_violation"
  | "forbidden_file_touch";

export type ModelMutationValidationIssue = {
  code: ModelMutationValidationIssueCode;
  message: string;
  path?: string;
};

export type ModelMutationValidationContext = {
  role: ModelRole;
  allowedFiles?: string[];
  forbiddenFiles?: string[];
};

export type ModelMutationValidationResult = {
  ok: boolean;
  blocked: boolean;
  mutation: WorkspaceMutation | null;
  issues: ModelMutationValidationIssue[];
};

const knownRoles = new Set<ModelRole>(["planner", "coder", "verifier", "remask"]);
const knownTargets = new Set<WorkspaceMutationTarget>([
  "plan",
  "patchDraft",
  "verifierFinding",
  "remaskRequest",
  "repairDraft"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ModelMutationValidationIssue[],
  code: ModelMutationValidationIssueCode,
  message: string,
  path?: string
): void {
  issues.push(path === undefined ? { code, message } : { code, message, path });
}

function addMissingRequiredFieldIssue(
  issues: ModelMutationValidationIssue[],
  candidate: Record<string, unknown>,
  field: keyof WorkspaceMutation
): void {
  if (!(field in candidate)) {
    addIssue(issues, "missing_required_field", `${field} is required`, field);
  }
}

function hasIssueCode(
  issues: ModelMutationValidationIssue[],
  code: ModelMutationValidationIssueCode
): boolean {
  return issues.some((issue) => issue.code === code);
}

function mapContractError(error: string): ModelMutationValidationIssueCode {
  if (error.includes("known model role")) {
    return "unknown_role";
  }

  if (error.includes("known workspace mutation target")) {
    return "unknown_target";
  }

  if (error.includes("role cannot write target")) {
    return "role_target_violation";
  }

  if (error.includes("summary")) {
    return "empty_summary";
  }

  if (error.includes("claims")) {
    return "claims_not_array";
  }

  if (error.includes("touchedFiles")) {
    return "touched_files_not_array";
  }

  if (error.includes("confidence")) {
    return "invalid_confidence";
  }

  return "invalid_shape";
}

export function parseModelWorkspaceMutationOutput(rawOutput: string): {
  ok: boolean;
  value: unknown;
  issues: ModelMutationValidationIssue[];
} {
  try {
    return {
      ok: true,
      value: JSON.parse(rawOutput.trim()) as unknown,
      issues: []
    };
  } catch {
    return {
      ok: false,
      value: null,
      issues: [
        {
          code: "invalid_json",
          message: "Model output must be strict JSON."
        }
      ]
    };
  }
}

export function validateWorkspaceMutationScope(
  mutation: WorkspaceMutation,
  context: ModelMutationValidationContext
): ModelMutationValidationIssue[] {
  const issues: ModelMutationValidationIssue[] = [];
  const allowedFiles = new Set(context.allowedFiles ?? []);
  const forbiddenFiles = new Set(context.forbiddenFiles ?? []);

  if (allowedFiles.size > 0) {
    for (const file of mutation.touchedFiles) {
      if (!allowedFiles.has(file)) {
        addIssue(
          issues,
          "scope_violation",
          `Touched file is outside allowedFiles: ${file}`,
          "touchedFiles"
        );
      }
    }
  }

  if (forbiddenFiles.size > 0) {
    for (const file of mutation.touchedFiles) {
      if (forbiddenFiles.has(file)) {
        addIssue(
          issues,
          "forbidden_file_touch",
          `Touched file is forbidden: ${file}`,
          "touchedFiles"
        );
      }
    }
  }

  return issues;
}

export function validateModelWorkspaceMutation(
  rawOutput: string,
  context: ModelMutationValidationContext
): ModelMutationValidationResult {
  const parsed = parseModelWorkspaceMutationOutput(rawOutput);

  if (!parsed.ok) {
    return {
      ok: false,
      blocked: true,
      mutation: null,
      issues: parsed.issues
    };
  }

  if (!isRecord(parsed.value)) {
    return {
      ok: false,
      blocked: true,
      mutation: null,
      issues: [
        {
          code: "invalid_shape",
          message: "Workspace mutation output must be a JSON object."
        }
      ]
    };
  }

  const candidate = parsed.value;
  const issues: ModelMutationValidationIssue[] = [];

  addMissingRequiredFieldIssue(issues, candidate, "role");
  addMissingRequiredFieldIssue(issues, candidate, "target");
  addMissingRequiredFieldIssue(issues, candidate, "summary");
  addMissingRequiredFieldIssue(issues, candidate, "claims");
  addMissingRequiredFieldIssue(issues, candidate, "touchedFiles");

  const role = candidate.role as ModelRole;
  const target = candidate.target as WorkspaceMutationTarget;

  if ("role" in candidate && !knownRoles.has(role)) {
    addIssue(issues, "unknown_role", "role must be a known model role", "role");
  }

  if ("role" in candidate && knownRoles.has(role) && role !== context.role) {
    addIssue(
      issues,
      "role_target_violation",
      `role must match expected context role: ${context.role}`,
      "role"
    );
  }

  if ("target" in candidate && !knownTargets.has(target)) {
    addIssue(issues, "unknown_target", "target must be a known workspace mutation target", "target");
  }

  if (
    "role" in candidate &&
    "target" in candidate &&
    knownRoles.has(role) &&
    knownTargets.has(target) &&
    !canRoleWriteWorkspaceMutationTarget(role, target)
  ) {
    addIssue(issues, "role_target_violation", "role cannot write target", "target");
  }

  if ("summary" in candidate) {
    const summary = candidate.summary;

    if (typeof summary !== "string") {
      addIssue(issues, "invalid_shape", "summary must be a string", "summary");
    } else if (summary.trim().length === 0) {
      addIssue(issues, "empty_summary", "summary must be non-empty", "summary");
    }
  }

  if ("claims" in candidate && !Array.isArray(candidate.claims)) {
    addIssue(issues, "claims_not_array", "claims must be an array", "claims");
  }

  if ("touchedFiles" in candidate && !Array.isArray(candidate.touchedFiles)) {
    addIssue(
      issues,
      "touched_files_not_array",
      "touchedFiles must be an array",
      "touchedFiles"
    );
  }

  if (
    "confidence" in candidate &&
    candidate.confidence !== undefined &&
    (typeof candidate.confidence !== "number" ||
      Number.isNaN(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1)
  ) {
    addIssue(issues, "invalid_confidence", "confidence must be a number between 0 and 1", "confidence");
  }

  if (issues.length > 0) {
    return {
      ok: false,
      blocked: true,
      mutation: null,
      issues
    };
  }

  const mutation = createWorkspaceMutation(candidate as WorkspaceMutation);
  const contractValidation = validateWorkspaceMutationContract(mutation);

  for (const error of contractValidation.errors) {
    const code = mapContractError(error);

    if (!hasIssueCode(issues, code)) {
      addIssue(issues, code, error);
    }
  }

  issues.push(...validateWorkspaceMutationScope(mutation, context));

  if (issues.length > 0) {
    return {
      ok: false,
      blocked: true,
      mutation: null,
      issues
    };
  }

  return {
    ok: true,
    blocked: false,
    mutation,
    issues: []
  };
}
