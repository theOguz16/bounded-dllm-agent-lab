import { canonicalizeJson } from "./agent-event-ledger.js";
import {
  canRoleWriteWorkspaceMutationTarget,
  createWorkspaceMutation,
  validateWorkspaceMutationContract,
  type ModelRole,
  type WorkspaceMutation,
  type WorkspaceMutationTarget
} from "./workspace-mutation.js";
import {
  validateContextExpansionRequest
} from "./context-sufficiency-contract.js";

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
  | "context_request_missing"
  | "context_request_invalid"
  | "context_request_touches_files"
  | "context_request_scope_violation"
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
  allowedContextFiles?: string[];
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
  "contextRequest",
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

  if (error.includes("contextRequest is required")) {
    return "context_request_missing";
  }

  if (error.includes("cannot touch files")) {
    return "context_request_touches_files";
  }

  if (error.includes("contextRequest")) {
    return "context_request_invalid";
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

  if (
    mutation.target === "contextRequest" &&
    mutation.contextRequest
  ) {
    const allowedContextFiles = new Set(
      context.allowedContextFiles ?? []
    );

    const requestedContextFiles = new Set([
      ...mutation.contextRequest.requestedFiles,
      ...mutation.contextRequest.requestedTests
    ]);

    for (const file of requestedContextFiles) {
      if (forbiddenFiles.has(file)) {
        addIssue(
          issues,
          "context_request_scope_violation",
          `Requested context file is forbidden: ${file}`,
          "contextRequest"
        );
      }

      if (
        allowedContextFiles.size > 0 &&
        !allowedContextFiles.has(file) &&
        !mutation.contextRequest.scopeExpansionRequested
      ) {
        addIssue(
          issues,
          "context_request_scope_violation",
          `Requested context file is outside allowedContextFiles without explicit scope expansion: ${file}`,
          "contextRequest"
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

  return validateModelWorkspaceMutationValue(parsed.value, context);
}

export function validateModelWorkspaceMutationValue(
  value: unknown,
  context: ModelMutationValidationContext
): ModelMutationValidationResult {
  if (!isRecord(value)) {
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

  const candidate = value;
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

  if (Array.isArray(candidate.touchedFiles) &&
      candidate.touchedFiles.some((file) => typeof file !== "string")) {
    addIssue(issues, "invalid_shape", "touchedFiles entries must be strings", "touchedFiles");
  }

  if ("target" in candidate && target === "contextRequest") {
    if (!("contextRequest" in candidate)) {
      addIssue(
        issues,
        "context_request_missing",
        "contextRequest is required for contextRequest target",
        "contextRequest"
      );
    } else {
      const contextRequestValidation =
        validateContextExpansionRequest(candidate.contextRequest);

      for (const error of contextRequestValidation.errors) {
        addIssue(
          issues,
          "context_request_invalid",
          `contextRequest: ${error}`,
          "contextRequest"
        );
      }
    }

    if (
      Array.isArray(candidate.touchedFiles) &&
      candidate.touchedFiles.length > 0
    ) {
      addIssue(
        issues,
        "context_request_touches_files",
        "contextRequest mutation cannot touch files",
        "touchedFiles"
      );
    }
  } else if ("contextRequest" in candidate) {
    addIssue(
      issues,
      "context_request_invalid",
      "contextRequest is only allowed for contextRequest target",
      "contextRequest"
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

  try {
    canonicalizeJson(candidate.claims);
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      mutation: null,
      issues: [{
        code: "invalid_shape",
        message: error instanceof Error ? error.message : "claims must contain canonical JSON values",
        path: "claims"
      }]
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
