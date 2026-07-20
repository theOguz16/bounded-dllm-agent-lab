import { createHash } from "node:crypto";
import type {
  ContextExpansionResolution,
  ContextEvidenceEntry
} from "./context-expansion-resolver.js";

export const CODER_CONTEXT_EXECUTION_GATE_VERSION = "1" as const;

export type CoderContextExecutionRoute =
  | "coder_executed"
  | "replan_required"
  | "human_review_required";

export type CoderContextExecutionDecision =
  | "coder_execution_completed"
  | "coder_execution_blocked"
  | "coder_context_invalid"
  | "coder_provider_failed";

export type CoderContextExecutionIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  filePath?: string;
  field?: string;
};

export type InitialCoderContextEvidence = {
  path: string;
  source: string;
  content: string;
  contentHash: string;
  byteLength: number;
  estimatedTokens: number;
  matchedSymbols: readonly string[];
};

export type CoderVisibleEvidence =
  InitialCoderContextEvidence & {
    origin:
      | "initial_context"
      | "context_expansion";
  };

export type CoderProviderContext = {
  version: "1";
  baseContext: unknown;
  evidence: readonly CoderVisibleEvidence[];
  provenance: readonly {
    path: string;
    origin:
      | "initial_context"
      | "context_expansion";
    contentHash: string;
    source: string;
  }[];
  budget: {
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    hardTotalBudgetTokens: number;
    remainingTokens: number;
  };
};

export type ExecuteCoderWithContextGateInput<T> = {
  baseContext: unknown;
  initialEvidence?:
    readonly InitialCoderContextEvidence[];
  expansionResolution?:
    ContextExpansionResolution | null;
  requiredSourceFiles: readonly string[];
  requiredTestFiles?: readonly string[];
  requiredSymbols?: readonly string[];
  authorityPresent: boolean;
  policyPresent: boolean;
  hardTotalBudgetTokens: number;
  reservedOutputTokens?: number;
  provider: (
    context: CoderProviderContext
  ) => Promise<T>;
};

export type CoderContextExecutionResult<T> = {
  decision: CoderContextExecutionDecision;
  route: CoderContextExecutionRoute;
  issues:
    readonly CoderContextExecutionIssue[];
  providerCalled: boolean;
  providerOutput: T | null;
  context: CoderProviderContext | null;
  summary: {
    visibleFileCount: number;
    requiredSourceCount: number;
    requiredTestCount: number;
    requiredSymbolCount: number;
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    hardTotalBudgetTokens: number;
    providerCallCount: 0 | 1;
  };
};

const MAX_TOTAL_CONTEXT_TOKENS = 32_768;
const MAX_RESERVED_OUTPUT_TOKENS = 8_192;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

type EvidenceOrigin =
  CoderVisibleEvidence["origin"];

function hashText(
  value: string | Buffer
): string {
  return `sha256:${createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

function canonicalize(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.keys(
        value as Record<string, unknown>
      )
        .sort()
        .map((key) => [
          key,
          canonicalize(
            (
              value as Record<
                string,
                unknown
              >
            )[key]
          )
        ])
    );
  }

  return value;
}

function hashCanonical(
  value: unknown
): string {
  return hashText(
    JSON.stringify(
      canonicalize(value)
    )
  );
}

function estimateTokens(
  value: unknown
): number {
  return Math.ceil(
    JSON.stringify(value).length / 4
  );
}

function normalizeRelativePath(
  value: string,
  field: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new Error(
      `${field} contains an invalid repository-relative path`
    );
  }

  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized
      .split("/")
      .includes("..")
  ) {
    throw new Error(
      `${field} must not escape the repository`
    );
  }

  return normalized;
}

function normalizePaths(
  values:
    | readonly string[]
    | undefined,
  field: string
): string[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new Error(
      `${field} must be an array`
    );
  }

  return [
    ...new Set(
      values.map((value) =>
        normalizeRelativePath(
          value,
          field
        )
      )
    )
  ];
}

function normalizeSymbols(
  values:
    | readonly string[]
    | undefined
): string[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new Error(
      "requiredSymbols must be an array"
    );
  }

  const normalized = values.map(
    (value) => {
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.trim().length > 256 ||
        CONTROL_CHARACTERS.test(value)
      ) {
        throw new Error(
          "requiredSymbols must contain safe non-empty strings"
        );
      }

      return value.trim();
    }
  );

  return [...new Set(normalized)];
}

function validateBudget(
  value: number,
  field: string,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be an integer between 0 and ${maximum}`
    );
  }

  return value;
}

function issue(
  code: string,
  message: string,
  severity: "error" | "review",
  extra: {
    filePath?: string;
    field?: string;
  } = {}
): CoderContextExecutionIssue {
  return {
    code,
    message,
    severity,
    ...extra
  };
}

function summary(
  requiredSourceCount: number,
  requiredTestCount: number,
  requiredSymbolCount: number,
  hardTotalBudgetTokens: number,
  reservedOutputTokens: number,
  visibleFileCount = 0,
  estimatedInputTokens = 0,
  providerCallCount: 0 | 1 = 0
): CoderContextExecutionResult<
  never
>["summary"] {
  return {
    visibleFileCount,
    requiredSourceCount,
    requiredTestCount,
    requiredSymbolCount,
    estimatedInputTokens,
    reservedOutputTokens,
    hardTotalBudgetTokens,
    providerCallCount
  };
}

function blocked<T>(
  route: Exclude<
    CoderContextExecutionRoute,
    "coder_executed"
  >,
  decision: Exclude<
    CoderContextExecutionDecision,
    "coder_execution_completed"
  >,
  issues:
    readonly CoderContextExecutionIssue[],
  resultSummary:
    CoderContextExecutionResult<
      T
    >["summary"],
  providerCalled = false
): CoderContextExecutionResult<T> {
  return {
    decision,
    route,
    issues,
    providerCalled,
    providerOutput: null,
    context: null,
    summary: resultSummary
  };
}

function validateEvidence(
  evidence:
    InitialCoderContextEvidence,
  origin: EvidenceOrigin
): CoderVisibleEvidence {
  const normalizedPath =
    normalizeRelativePath(
      evidence.path,
      "evidence.path"
    );

  if (
    typeof evidence.source !==
      "string" ||
    evidence.source.trim().length === 0
  ) {
    throw new Error(
      `Evidence source is invalid for ${normalizedPath}`
    );
  }

  if (
    typeof evidence.content !==
      "string" ||
    evidence.content.includes("\0")
  ) {
    throw new Error(
      `Evidence content is invalid for ${normalizedPath}`
    );
  }

  const bytes = Buffer.from(
    evidence.content,
    "utf8"
  );

  const expectedHash =
    hashText(bytes);

  if (
    !HASH.test(evidence.contentHash) ||
    evidence.contentHash !==
      expectedHash
  ) {
    throw new Error(
      `Evidence content hash is invalid for ${normalizedPath}`
    );
  }

  if (
    evidence.byteLength !==
    bytes.length
  ) {
    throw new Error(
      `Evidence byte length is invalid for ${normalizedPath}`
    );
  }

  if (
    !Number.isSafeInteger(
      evidence.estimatedTokens
    ) ||
    evidence.estimatedTokens < 0
  ) {
    throw new Error(
      `Evidence token estimate is invalid for ${normalizedPath}`
    );
  }

  if (
    !Array.isArray(
      evidence.matchedSymbols
    )
  ) {
    throw new Error(
      `Evidence matchedSymbols is invalid for ${normalizedPath}`
    );
  }

  return {
    path: normalizedPath,
    source:
      evidence.source.trim(),
    content: evidence.content,
    contentHash:
      evidence.contentHash,
    byteLength:
      evidence.byteLength,
    estimatedTokens:
      evidence.estimatedTokens,
    matchedSymbols: [
      ...new Set(
        evidence.matchedSymbols
      )
    ],
    origin
  };
}

function expansionEvidence(
  resolution:
    | ContextExpansionResolution
    | null
    | undefined
): {
  evidence:
    CoderVisibleEvidence[];
  issues:
    CoderContextExecutionIssue[];
  route:
    | "replan_required"
    | "human_review_required"
    | null;
} {
  if (
    resolution === null ||
    resolution === undefined
  ) {
    return {
      evidence: [],
      issues: [],
      route: null
    };
  }

  if (
    resolution.decision ===
    "context_expansion_incomplete"
  ) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_incomplete",
          "Context expansion is incomplete and coder execution is not allowed.",
          "review"
        )
      ],
      route: "replan_required"
    };
  }

  if (
    resolution.decision ===
      "context_expansion_blocked" ||
    resolution.decision ===
      "context_expansion_invalid"
  ) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_not_trusted",
          "Context expansion was blocked or invalid.",
          "error"
        )
      ],
      route:
        "human_review_required"
    };
  }

  if (
    resolution.packet === null
  ) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_packet_missing",
          "A ready context expansion must include a packet.",
          "error"
        )
      ],
      route:
        "human_review_required"
    };
  }

  const {
    packetHash,
    ...packetWithoutHash
  } = resolution.packet;

  if (
    !HASH.test(packetHash) ||
    hashCanonical(
      packetWithoutHash
    ) !== packetHash
  ) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_packet_tampered",
          "Context expansion packet integrity verification failed.",
          "error"
        )
      ],
      route:
        "human_review_required"
    };
  }

  if (
    resolution.packet
      .missingFiles.length > 0 ||
    resolution.packet
      .unresolvedSymbols.length > 0
  ) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_unresolved",
          "Context expansion still contains missing files or unresolved symbols.",
          "review"
        )
      ],
      route: "replan_required"
    };
  }

  try {
    return {
      evidence:
        resolution.packet.entries.map(
          (
            entry:
              ContextEvidenceEntry
          ) =>
            validateEvidence(
              entry,
              "context_expansion"
            )
        ),
      issues: [],
      route: null
    };
  } catch (error) {
    return {
      evidence: [],
      issues: [
        issue(
          "context_expansion_evidence_invalid",
          error instanceof Error
            ? error.message
            : "Expansion evidence is invalid.",
          "error"
        )
      ],
      route:
        "human_review_required"
    };
  }
}

export async function executeCoderWithContextGate<T>(
  input:
    ExecuteCoderWithContextGateInput<T>
): Promise<
  CoderContextExecutionResult<T>
> {
  let requiredSourceFiles:
    string[] = [];

  let requiredTestFiles:
    string[] = [];

  let requiredSymbols:
    string[] = [];

  let hardTotalBudgetTokens = 0;
  let reservedOutputTokens = 0;

  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      throw new Error(
        "Coder context gate input must be an object"
      );
    }

    requiredSourceFiles =
      normalizePaths(
        input.requiredSourceFiles,
        "requiredSourceFiles"
      );

    requiredTestFiles =
      normalizePaths(
        input.requiredTestFiles,
        "requiredTestFiles"
      );

    requiredSymbols =
      normalizeSymbols(
        input.requiredSymbols
      );

    hardTotalBudgetTokens =
      validateBudget(
        input.hardTotalBudgetTokens,
        "hardTotalBudgetTokens",
        MAX_TOTAL_CONTEXT_TOKENS
      );

    reservedOutputTokens =
      validateBudget(
        input.reservedOutputTokens ??
          1024,
        "reservedOutputTokens",
        MAX_RESERVED_OUTPUT_TOKENS
      );

    if (
      hardTotalBudgetTokens === 0 ||
      reservedOutputTokens >=
        hardTotalBudgetTokens
    ) {
      throw new Error(
        "hardTotalBudgetTokens must exceed reservedOutputTokens"
      );
    }

    if (
      typeof input.provider !==
      "function"
    ) {
      throw new Error(
        "provider must be a function"
      );
    }
  } catch (error) {
    return blocked(
      "human_review_required",
      "coder_context_invalid",
      [
        issue(
          "coder_context_input_invalid",
          error instanceof Error
            ? error.message
            : "Coder context input is invalid.",
          "error"
        )
      ],
      summary(
        requiredSourceFiles.length,
        requiredTestFiles.length,
        requiredSymbols.length,
        hardTotalBudgetTokens,
        reservedOutputTokens
      )
    );
  }

  const baseSummary = summary(
    requiredSourceFiles.length,
    requiredTestFiles.length,
    requiredSymbols.length,
    hardTotalBudgetTokens,
    reservedOutputTokens
  );

  if (!input.authorityPresent) {
    return blocked(
      "human_review_required",
      "coder_execution_blocked",
      [
        issue(
          "context_authority_missing",
          "Required authority context is missing.",
          "review"
        )
      ],
      baseSummary
    );
  }

  if (!input.policyPresent) {
    return blocked(
      "human_review_required",
      "coder_execution_blocked",
      [
        issue(
          "context_policy_missing",
          "Required policy context is missing.",
          "review"
        )
      ],
      baseSummary
    );
  }

  const expansion =
    expansionEvidence(
      input.expansionResolution
    );

  if (expansion.route !== null) {
    return blocked(
      expansion.route,
      "coder_execution_blocked",
      expansion.issues,
      baseSummary
    );
  }

  const visibleByPath =
    new Map<
      string,
      CoderVisibleEvidence
    >();

  try {
    for (
      const initial of
      input.initialEvidence ?? []
    ) {
      const evidence =
        validateEvidence(
          initial,
          "initial_context"
        );

      visibleByPath.set(
        evidence.path,
        evidence
      );
    }

    for (
      const evidence of
      expansion.evidence
    ) {
      const previous =
        visibleByPath.get(
          evidence.path
        );

      if (
        previous &&
        previous.contentHash !==
          evidence.contentHash
      ) {
        return blocked(
          "human_review_required",
          "coder_execution_blocked",
          [
            issue(
              "context_evidence_conflict",
              "Initial and expanded context disagree for the same file.",
              "error",
              {
                filePath:
                  evidence.path
              }
            )
          ],
          baseSummary
        );
      }

      if (!previous) {
        visibleByPath.set(
          evidence.path,
          evidence
        );
      }
    }
  } catch (error) {
    return blocked(
      "human_review_required",
      "coder_context_invalid",
      [
        issue(
          "context_evidence_invalid",
          error instanceof Error
            ? error.message
            : "Context evidence is invalid.",
          "error"
        )
      ],
      baseSummary
    );
  }

  const visibleEvidence = [
    ...visibleByPath.values()
  ].sort((a, b) =>
    a.path.localeCompare(b.path)
  );

  const visiblePaths =
    new Set(
      visibleEvidence.map(
        (entry) => entry.path
      )
    );

  const missingSourceFiles =
    requiredSourceFiles.filter(
      (file) =>
        !visiblePaths.has(file)
    );

  const missingTestFiles =
    requiredTestFiles.filter(
      (file) =>
        !visiblePaths.has(file)
    );

  const missingSymbols =
    requiredSymbols.filter(
      (symbol) =>
        !visibleEvidence.some(
          (entry) =>
            entry.content.includes(
              symbol
            )
        )
    );

  if (
    missingSourceFiles.length > 0
  ) {
    return blocked(
      "replan_required",
      "coder_execution_blocked",
      missingSourceFiles.map(
        (filePath) =>
          issue(
            "required_source_context_missing",
            "A source file required for the patch is not visible to the coder.",
            "review",
            { filePath }
          )
      ),
      {
        ...baseSummary,
        visibleFileCount:
          visibleEvidence.length
      }
    );
  }

  if (
    missingTestFiles.length > 0
  ) {
    return blocked(
      "replan_required",
      "coder_execution_blocked",
      missingTestFiles.map(
        (filePath) =>
          issue(
            "required_test_context_missing",
            "A required test file is not visible to the coder.",
            "review",
            { filePath }
          )
      ),
      {
        ...baseSummary,
        visibleFileCount:
          visibleEvidence.length
      }
    );
  }

  if (
    missingSymbols.length > 0
  ) {
    return blocked(
      "replan_required",
      "coder_execution_blocked",
      missingSymbols.map(
        (symbol) =>
          issue(
            "required_symbol_context_missing",
            `A required symbol is not visible to the coder: ${symbol}`,
            "review",
            {
              field:
                "requiredSymbols"
            }
          )
      ),
      {
        ...baseSummary,
        visibleFileCount:
          visibleEvidence.length
      }
    );
  }

  const contextCore = {
    version:
      CODER_CONTEXT_EXECUTION_GATE_VERSION,
    baseContext:
      input.baseContext,
    evidence: visibleEvidence,
    provenance:
      visibleEvidence.map(
        (entry) => ({
          path: entry.path,
          origin: entry.origin,
          contentHash:
            entry.contentHash,
          source: entry.source
        })
      )
  } as const;

  let estimatedInputTokens:
    number;

  try {
    estimatedInputTokens =
      estimateTokens(contextCore);
  } catch {
    return blocked(
      "human_review_required",
      "coder_context_invalid",
      [
        issue(
          "base_context_not_serializable",
          "Base context must be JSON serializable.",
          "error"
        )
      ],
      {
        ...baseSummary,
        visibleFileCount:
          visibleEvidence.length
      }
    );
  }

  const remainingTokens =
    hardTotalBudgetTokens -
    estimatedInputTokens -
    reservedOutputTokens;

  const providerContext:
    CoderProviderContext = {
    ...contextCore,
    budget: {
      estimatedInputTokens,
      reservedOutputTokens,
      hardTotalBudgetTokens,
      remainingTokens
    }
  };

  const readySummary = {
    ...baseSummary,
    visibleFileCount:
      visibleEvidence.length,
    estimatedInputTokens
  };

  if (remainingTokens < 0) {
    return blocked(
      "replan_required",
      "coder_execution_blocked",
      [
        issue(
          "coder_context_hard_budget_exceeded",
          "Composed coder context exceeds the hard total token budget.",
          "review",
          {
            field:
              "hardTotalBudgetTokens"
          }
        )
      ],
      readySummary
    );
  }

  try {
    const providerOutput =
      await input.provider(
        providerContext
      );

    return {
      decision:
        "coder_execution_completed",
      route: "coder_executed",
      issues: [],
      providerCalled: true,
      providerOutput,
      context: providerContext,
      summary: {
        ...readySummary,
        providerCallCount: 1
      }
    };
  } catch {
    return blocked(
      "human_review_required",
      "coder_provider_failed",
      [
        issue(
          "coder_provider_failed",
          "Required coder provider call failed and no patch may be accepted.",
          "error"
        )
      ],
      {
        ...readySummary,
        providerCallCount: 1
      },
      true
    );
  }
}
