import path from "node:path";

export const RUNTIME_CONTRACT_VERSION = "runtime-contract/v1" as const;
export const RUNTIME_FAILURE_VERSION = "runtime-failure/v1" as const;
export const CANONICAL_PATH_VERSION = "canonical-repository-path/v1" as const;

export const RUNTIME_STAGES = [
  "repository_intelligence",
  "planning",
  "minimality",
  "coding",
  "verification",
  "apply",
  "validation",
  "delivery"
] as const;

export type RuntimeStage = (typeof RUNTIME_STAGES)[number];

export const RUNTIME_FAILURE_ROUTES = [
  "replan_required",
  "human_review_required",
  "policy_blocked",
  "recovery_required",
  "invalid_input",
  "provider_failure"
] as const;

export type RuntimeFailureRoute = (typeof RUNTIME_FAILURE_ROUTES)[number];

export type RuntimeFailure = Readonly<{
  failureVersion: typeof RUNTIME_FAILURE_VERSION;
  stage: RuntimeStage;
  route: RuntimeFailureRoute;
  code: string;
  message: string;
  retryable: boolean;
  details: Readonly<Record<string, string>>;
}>;

export type RuntimeContractRegistry = Readonly<{
  registryVersion: typeof RUNTIME_CONTRACT_VERSION;
  contracts: Readonly<{
    runtimeFailure: typeof RUNTIME_FAILURE_VERSION;
    canonicalRepositoryPath: typeof CANONICAL_PATH_VERSION;
  }>;
  stages: readonly RuntimeStage[];
  failureRoutes: readonly RuntimeFailureRoute[];
}>;

export type CanonicalRepositoryPathIssueCode =
  | "path_not_string"
  | "path_empty"
  | "path_too_long"
  | "path_has_surrounding_whitespace"
  | "path_has_control_character"
  | "path_is_absolute"
  | "path_is_unc"
  | "path_has_windows_drive"
  | "path_escapes_repository"
  | "path_is_not_canonical";

export class CanonicalRepositoryPathError extends Error {
  readonly version = CANONICAL_PATH_VERSION;

  constructor(
    readonly code: CanonicalRepositoryPathIssueCode,
    message: string,
    readonly input: unknown
  ) {
    super(message);
    this.name = "CanonicalRepositoryPathError";
  }
}

const MAX_PATH_LENGTH = 4_096;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^(?:\\\\|\/\/)/;

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const RUNTIME_CONTRACT_REGISTRY: RuntimeContractRegistry = Object.freeze({
  registryVersion: RUNTIME_CONTRACT_VERSION,
  contracts: Object.freeze({
    runtimeFailure: RUNTIME_FAILURE_VERSION,
    canonicalRepositoryPath: CANONICAL_PATH_VERSION
  }),
  stages: freezeArray(RUNTIME_STAGES),
  failureRoutes: freezeArray(RUNTIME_FAILURE_ROUTES)
});

export function isRuntimeStage(value: unknown): value is RuntimeStage {
  return typeof value === "string" && (RUNTIME_STAGES as readonly string[]).includes(value);
}

export function isRuntimeFailureRoute(value: unknown): value is RuntimeFailureRoute {
  return typeof value === "string" && (RUNTIME_FAILURE_ROUTES as readonly string[]).includes(value);
}

export function createRuntimeFailure(input: {
  stage: RuntimeStage;
  route: RuntimeFailureRoute;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Readonly<Record<string, string>>;
}): RuntimeFailure {
  if (!isRuntimeStage(input.stage)) {
    throw new TypeError("Runtime failure stage is invalid.");
  }
  if (!isRuntimeFailureRoute(input.route)) {
    throw new TypeError("Runtime failure route is invalid.");
  }
  if (typeof input.code !== "string" || !/^[a-z][a-z0-9_]{2,127}$/.test(input.code)) {
    throw new TypeError("Runtime failure code must be a stable snake_case identifier.");
  }
  if (typeof input.message !== "string" || input.message.trim() !== input.message || input.message.length === 0) {
    throw new TypeError("Runtime failure message must be a non-empty trimmed string.");
  }

  const details = input.details ?? {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== "string") {
      throw new TypeError("Runtime failure details must contain stable string fields.");
    }
  }

  return Object.freeze({
    failureVersion: RUNTIME_FAILURE_VERSION,
    stage: input.stage,
    route: input.route,
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    details: Object.freeze({ ...details })
  });
}

export function canonicalizeRepositoryRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new CanonicalRepositoryPathError("path_not_string", "Repository path must be a string.", value);
  }
  if (value.length === 0) {
    throw new CanonicalRepositoryPathError("path_empty", "Repository path must not be empty.", value);
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new CanonicalRepositoryPathError("path_too_long", "Repository path exceeds the hard length limit.", value);
  }
  if (value.trim() !== value) {
    throw new CanonicalRepositoryPathError(
      "path_has_surrounding_whitespace",
      "Repository path must not contain surrounding whitespace.",
      value
    );
  }
  if (ASCII_CONTROL.test(value)) {
    throw new CanonicalRepositoryPathError(
      "path_has_control_character",
      "Repository path must not contain ASCII control characters.",
      value
    );
  }
  if (UNC.test(value)) {
    throw new CanonicalRepositoryPathError("path_is_unc", "UNC repository paths are not allowed.", value);
  }
  if (WINDOWS_DRIVE.test(value)) {
    throw new CanonicalRepositoryPathError(
      "path_has_windows_drive",
      "Windows drive-qualified repository paths are not allowed.",
      value
    );
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new CanonicalRepositoryPathError("path_is_absolute", "Absolute repository paths are not allowed.", value);
  }

  const normalizedSeparators = value.replaceAll("\\", "/");
  const canonical = path.posix.normalize(normalizedSeparators);

  if (canonical === "." || canonical === ".." || canonical.startsWith("../") || canonical.includes("/../")) {
    throw new CanonicalRepositoryPathError(
      "path_escapes_repository",
      "Repository path must not escape the repository root.",
      value
    );
  }
  if (canonical !== normalizedSeparators || value !== normalizedSeparators) {
    throw new CanonicalRepositoryPathError(
      "path_is_not_canonical",
      "Repository path must already use canonical POSIX separators without aliases.",
      value
    );
  }

  return canonical;
}
