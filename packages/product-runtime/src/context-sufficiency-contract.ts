export const CONTEXT_EVIDENCE_KINDS = [
  "target_file",
  "direct_dependency",
  "type_definition",
  "caller",
  "required_test",
  "policy",
  "authority",
  "acceptance_criteria"
] as const;

export type ContextEvidenceKind = (typeof CONTEXT_EVIDENCE_KINDS)[number];

export const CONTEXT_SUFFICIENCY_DECISIONS = [
  "context_sufficient",
  "context_expansion_required",
  "replan_required",
  "human_review_required"
] as const;

export type ContextSufficiencyDecision =
  (typeof CONTEXT_SUFFICIENCY_DECISIONS)[number];

export type ContextExpansionRequest = {
  requestedFiles: string[];
  requestedSymbols: string[];
  requestedTests: string[];
  evidenceKinds: ContextEvidenceKind[];
  reason: string;
  scopeExpansionRequested: boolean;
  maxAdditionalTokens: number;
};

export type ContextSufficiencyReport = {
  decision: ContextSufficiencyDecision;
  missingEvidence: string[];
  unresolvedSymbols: string[];
  missingFiles: string[];
  missingTests: string[];
  requestedExpansionTokens: number;
  expansionAttempt: number;
  confidence: number;
};

export type ContextContractValidationResult = {
  ok: boolean;
  errors: string[];
};

const evidenceKindSet = new Set<string>(CONTEXT_EVIDENCE_KINDS);
const decisionSet = new Set<string>(CONTEXT_SUFFICIENCY_DECISIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueTrimmed(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))];
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.includes("\0")) {
    return false;
  }

  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    return false;
  }

  return !value.split(/[\\/]/).includes("..");
}

function validateStringArray(
  value: unknown,
  field: string,
  options: { maxItems: number; pathLike?: boolean }
): string[] {
  const errors: string[] = [];

  if (!Array.isArray(value)) {
    return [`${field} must be an array`];
  }

  if (value.length > options.maxItems) {
    errors.push(`${field} must contain at most ${options.maxItems} items`);
  }

  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${field} must contain non-empty strings`);
      continue;
    }

    const trimmed = item.trim();

    if (trimmed.length > 512 || trimmed.includes("\0")) {
      errors.push(`${field} contains an invalid string`);
    }

    if (options.pathLike && !isSafeRelativePath(trimmed)) {
      errors.push(`${field} must contain safe repository-relative paths`);
    }
  }

  return errors;
}

export function validateContextExpansionRequest(
  value: unknown
): ContextContractValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ["contextRequest must be an object"]
    };
  }

  const errors = [
    ...validateStringArray(value.requestedFiles, "requestedFiles", {
      maxItems: 32,
      pathLike: true
    }),
    ...validateStringArray(value.requestedSymbols, "requestedSymbols", {
      maxItems: 64
    }),
    ...validateStringArray(value.requestedTests, "requestedTests", {
      maxItems: 32,
      pathLike: true
    })
  ];

  if (!Array.isArray(value.evidenceKinds)) {
    errors.push("evidenceKinds must be an array");
  } else {
    if (value.evidenceKinds.length === 0) {
      errors.push("evidenceKinds must not be empty");
    }

    for (const kind of value.evidenceKinds) {
      if (typeof kind !== "string" || !evidenceKindSet.has(kind)) {
        errors.push("evidenceKinds contains an unknown evidence kind");
      }
    }
  }

  if (
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0
  ) {
    errors.push("reason must be a non-empty string");
  } else if (value.reason.trim().length > 1000) {
    errors.push("reason must be at most 1000 characters");
  }

  if (typeof value.scopeExpansionRequested !== "boolean") {
    errors.push("scopeExpansionRequested must be a boolean");
  }

  if (
    !Number.isInteger(value.maxAdditionalTokens) ||
    (value.maxAdditionalTokens as number) < 1 ||
    (value.maxAdditionalTokens as number) > 8192
  ) {
    errors.push(
      "maxAdditionalTokens must be an integer between 1 and 8192"
    );
  }

  const requestedItemCount = [
    value.requestedFiles,
    value.requestedSymbols,
    value.requestedTests
  ].reduce<number>(
    (total, current) =>
      total + (Array.isArray(current) ? current.length : 0),
    0
  );

  if (requestedItemCount === 0) {
    errors.push(
      "contextRequest must request at least one file, symbol, or test"
    );
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function createContextExpansionRequest(
  input: ContextExpansionRequest
): ContextExpansionRequest {
  const validation = validateContextExpansionRequest(input);

  if (!validation.ok) {
    throw new Error(
      `Invalid context expansion request: ${validation.errors.join("; ")}`
    );
  }

  return {
    requestedFiles: uniqueTrimmed(input.requestedFiles),
    requestedSymbols: uniqueTrimmed(input.requestedSymbols),
    requestedTests: uniqueTrimmed(input.requestedTests),
    evidenceKinds: [...new Set(input.evidenceKinds)],
    reason: input.reason.trim(),
    scopeExpansionRequested: input.scopeExpansionRequested,
    maxAdditionalTokens: input.maxAdditionalTokens
  };
}

export function validateContextSufficiencyReport(
  value: unknown
): ContextContractValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ["context sufficiency report must be an object"]
    };
  }

  const errors: string[] = [];

  if (
    typeof value.decision !== "string" ||
    !decisionSet.has(value.decision)
  ) {
    errors.push(
      "decision must be a known context sufficiency decision"
    );
  }

  errors.push(
    ...validateStringArray(
      value.missingEvidence,
      "missingEvidence",
      { maxItems: 64 }
    ),
    ...validateStringArray(
      value.unresolvedSymbols,
      "unresolvedSymbols",
      { maxItems: 64 }
    ),
    ...validateStringArray(value.missingFiles, "missingFiles", {
      maxItems: 64,
      pathLike: true
    }),
    ...validateStringArray(value.missingTests, "missingTests", {
      maxItems: 64,
      pathLike: true
    })
  );

  if (
    !Number.isInteger(value.requestedExpansionTokens) ||
    (value.requestedExpansionTokens as number) < 0 ||
    (value.requestedExpansionTokens as number) > 8192
  ) {
    errors.push(
      "requestedExpansionTokens must be an integer between 0 and 8192"
    );
  }

  if (
    !Number.isInteger(value.expansionAttempt) ||
    (value.expansionAttempt as number) < 0 ||
    (value.expansionAttempt as number) > 2
  ) {
    errors.push(
      "expansionAttempt must be an integer between 0 and 2"
    );
  }

  if (
    typeof value.confidence !== "number" ||
    Number.isNaN(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    errors.push(
      "confidence must be a number between 0 and 1"
    );
  }

  if (
    value.decision === "context_expansion_required" &&
    value.requestedExpansionTokens === 0
  ) {
    errors.push(
      "context_expansion_required must request additional tokens"
    );
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
