import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  validateContextExpansionRequest,
  type ContextExpansionRequest
} from "./context-sufficiency-contract.js";

export const CONTEXT_EXPANSION_RESOLVER_VERSION = "1" as const;

export type ContextExpansionDecision =
  | "context_expansion_ready"
  | "context_expansion_incomplete"
  | "context_expansion_blocked"
  | "context_expansion_invalid";

export type ContextEvidenceSource =
  | "requested_file"
  | "requested_test"
  | "requested_file_and_test";

export type ContextExpansionIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  filePath?: string;
  field?: string;
};

export type ContextEvidenceEntry = {
  path: string;
  source: ContextEvidenceSource;
  content: string;
  contentHash: string;
  byteLength: number;
  estimatedTokens: number;
  matchedSymbols: readonly string[];
};

export type BoundedContextExpansionPacket = {
  version: "1";
  expansionAttempt: number;
  requestHash: string;
  repositoryIdentityHash: string;
  budgetTokens: number;
  estimatedTokens: number;
  entries: readonly ContextEvidenceEntry[];
  missingFiles: readonly string[];
  unresolvedSymbols: readonly string[];
  packetHash: string;
};

export type ResolveContextExpansionInput = {
  repositoryPath: string;
  request: ContextExpansionRequest;
  expansionAttempt: number;
  allowedContextFiles?: readonly string[];
  forbiddenFiles?: readonly string[];
  previouslyRequestedFiles?: readonly string[];
  scopeExpansionApproved?: boolean;
  hardBudgetTokens?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export type ContextExpansionResolution = {
  decision: ContextExpansionDecision;
  issues: readonly ContextExpansionIssue[];
  packet: BoundedContextExpansionPacket | null;
  summary: {
    requestedPathCount: number;
    loadedFileCount: number;
    missingFileCount: number;
    unresolvedSymbolCount: number;
    totalBytesRead: number;
    estimatedTokens: number;
    budgetTokens: number;
    expansionAttempt: number;
    repositoryWritePerformed: false;
  };
};

const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const HARD_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024;
const HARD_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_BUDGET_TOKENS = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

class ResolverFailure extends Error {
  constructor(
    readonly decision:
      | "context_expansion_blocked"
      | "context_expansion_invalid",
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly filePath?: string
  ) {
    super(message);
  }
}

function issueFromFailure(
  error: ResolverFailure
): ContextExpansionIssue {
  return {
    code: error.code,
    message: error.message,
    severity:
      error.decision === "context_expansion_blocked"
        ? "review"
        : "error",
    ...(error.field === undefined
      ? {}
      : { field: error.field }),
    ...(error.filePath === undefined
      ? {}
      : { filePath: error.filePath })
  };
}

function hashText(value: string | Buffer): string {
  return `sha256:${createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize(
            (value as Record<string, unknown>)[key]
          )
        ])
    );
  }

  return value;
}

function hashCanonical(value: unknown): string {
  return hashText(
    JSON.stringify(canonicalize(value))
  );
}

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(
    JSON.stringify(value).length / 4
  );
}

function normalizeRepositoryRelativePath(
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
    throw new ResolverFailure(
      "context_expansion_invalid",
      "context_path_invalid",
      "Context path must be a safe repository-relative path.",
      field
    );
  }

  const normalized = path.posix.normalize(
    value.replace(/\\/g, "/")
  );

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new ResolverFailure(
      "context_expansion_invalid",
      "context_path_invalid",
      "Context path must not escape the repository.",
      field
    );
  }

  return normalized.replace(/^\.\//, "");
}

function normalizePathList(
  values: readonly string[] | undefined,
  field: string
): string[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new ResolverFailure(
      "context_expansion_invalid",
      "context_path_list_invalid",
      `${field} must be an array.`,
      field
    );
  }

  return [
    ...new Set(
      values.map((value) =>
        normalizeRepositoryRelativePath(
          value,
          field
        )
      )
    )
  ];
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  field: string
): number {
  const selected = value ?? fallback;

  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > hardMaximum
  ) {
    throw new ResolverFailure(
      "context_expansion_invalid",
      "context_limit_invalid",
      `${field} must be a positive safe integer no greater than ${hardMaximum}.`,
      field
    );
  }

  return selected;
}

function matchesPolicyPath(
  candidate: string,
  rule: string
): boolean {
  return (
    candidate === rule ||
    candidate.startsWith(`${rule}/`)
  );
}

function isInside(
  root: string,
  candidate: string
): boolean {
  const relative = path.relative(
    root,
    candidate
  );

  return (
    relative === "" ||
    (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    )
  );
}

async function inspectPathWithoutSymlinks(
  root: string,
  relativePath: string
): Promise<"file" | "missing"> {
  let current = root;
  const segments = relativePath.split("/");

  for (
    let index = 0;
    index < segments.length;
    index += 1
  ) {
    current = path.join(
      current,
      segments[index]
    );

    let entry;

    try {
      entry = await lstat(current);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return "missing";
      }

      throw error;
    }

    if (entry.isSymbolicLink()) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_symlink_rejected",
        "Context expansion does not follow symbolic links.",
        "request",
        relativePath
      );
    }

    const last =
      index === segments.length - 1;

    if (!last && !entry.isDirectory()) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_parent_not_directory",
        "A context path parent is not a directory.",
        "request",
        relativePath
      );
    }

    if (last && !entry.isFile()) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_entry_not_regular_file",
        "Requested context must be a regular file.",
        "request",
        relativePath
      );
    }
  }

  return "file";
}

async function readBoundedUtf8File(
  root: string,
  relativePath: string,
  maxFileBytes: number
): Promise<{
  content: string;
  bytes: Buffer;
}> {
  const absolutePath = path.resolve(
    root,
    ...relativePath.split("/")
  );

  if (!isInside(root, absolutePath)) {
    throw new ResolverFailure(
      "context_expansion_blocked",
      "context_path_outside_repository",
      "Requested context resolved outside the repository.",
      "request",
      relativePath
    );
  }

  const state =
    await inspectPathWithoutSymlinks(
      root,
      relativePath
    );

  if (state === "missing") {
    throw Object.assign(
      new Error("missing"),
      {
        code: "CONTEXT_FILE_MISSING"
      }
    );
  }

  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;

  let handle;

  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | noFollow
    );
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      throw Object.assign(
        new Error("missing"),
        {
          code: "CONTEXT_FILE_MISSING"
        }
      );
    }

    if (code === "ELOOP") {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_symlink_rejected",
        "Context expansion does not follow symbolic links.",
        "request",
        relativePath
      );
    }

    throw error;
  }

  try {
    const fileStat = await handle.stat();

    if (!fileStat.isFile()) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_entry_not_regular_file",
        "Requested context must remain a regular file while being read.",
        "request",
        relativePath
      );
    }

    if (fileStat.size > maxFileBytes) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_file_too_large",
        `Requested context file exceeds the ${maxFileBytes} byte limit.`,
        "request",
        relativePath
      );
    }

    const bytes =
      await handle.readFile();

    if (bytes.length > maxFileBytes) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_file_too_large",
        `Requested context file exceeds the ${maxFileBytes} byte limit.`,
        "request",
        relativePath
      );
    }

    if (bytes.includes(0)) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_binary_file_rejected",
        "Binary files cannot be added to model context.",
        "request",
        relativePath
      );
    }

    let content: string;

    try {
      content = new TextDecoder(
        "utf-8",
        { fatal: true }
      ).decode(bytes);
    } catch {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_non_utf8_file_rejected",
        "Only valid UTF-8 files can be added to model context.",
        "request",
        relativePath
      );
    }

    return {
      content,
      bytes
    };
  } finally {
    await handle.close();
  }
}

function finish(
  decision: ContextExpansionDecision,
  issues: readonly ContextExpansionIssue[],
  packet:
    | BoundedContextExpansionPacket
    | null,
  summary:
    ContextExpansionResolution["summary"]
): ContextExpansionResolution {
  return {
    decision,
    issues,
    packet,
    summary
  };
}

export async function resolveContextExpansion(
  input: ResolveContextExpansionInput
): Promise<ContextExpansionResolution> {
  const emptySummary:
    ContextExpansionResolution["summary"] = {
      requestedPathCount: 0,
      loadedFileCount: 0,
      missingFileCount: 0,
      unresolvedSymbolCount: 0,
      totalBytesRead: 0,
      estimatedTokens: 0,
      budgetTokens: 0,
      expansionAttempt:
        Number.isInteger(
          input?.expansionAttempt
        )
          ? input.expansionAttempt
          : 0,
      repositoryWritePerformed: false
    };

  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      throw new ResolverFailure(
        "context_expansion_invalid",
        "context_expansion_input_invalid",
        "Context expansion input must be an object."
      );
    }

    const requestValidation =
      validateContextExpansionRequest(
        input.request
      );

    if (!requestValidation.ok) {
      throw new ResolverFailure(
        "context_expansion_invalid",
        "context_request_invalid",
        requestValidation.errors.join("; "),
        "request"
      );
    }

    if (
      !Number.isInteger(
        input.expansionAttempt
      ) ||
      input.expansionAttempt < 1 ||
      input.expansionAttempt > 2
    ) {
      throw new ResolverFailure(
        "context_expansion_invalid",
        "context_expansion_attempt_invalid",
        "expansionAttempt must be 1 or 2.",
        "expansionAttempt"
      );
    }

    if (
      typeof input.repositoryPath !==
        "string" ||
      input.repositoryPath.trim().length ===
        0
    ) {
      throw new ResolverFailure(
        "context_expansion_invalid",
        "context_repository_path_invalid",
        "repositoryPath must be a non-empty string.",
        "repositoryPath"
      );
    }

    const root = await realpath(
      path.resolve(input.repositoryPath)
    );

    const rootStat = await lstat(root);

    if (!rootStat.isDirectory()) {
      throw new ResolverFailure(
        "context_expansion_invalid",
        "context_repository_not_directory",
        "repositoryPath must resolve to a directory.",
        "repositoryPath"
      );
    }

    const maxFileBytes =
      positiveInteger(
        input.maxFileBytes,
        DEFAULT_MAX_FILE_BYTES,
        HARD_MAX_FILE_BYTES,
        "maxFileBytes"
      );

    const maxTotalBytes =
      positiveInteger(
        input.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        HARD_MAX_TOTAL_BYTES,
        "maxTotalBytes"
      );

    const hardBudgetTokens =
      positiveInteger(
        input.hardBudgetTokens,
        input.request.maxAdditionalTokens,
        MAX_BUDGET_TOKENS,
        "hardBudgetTokens"
      );

    const budgetTokens = Math.min(
      hardBudgetTokens,
      input.request.maxAdditionalTokens
    );

    const allowedContextFiles =
      normalizePathList(
        input.allowedContextFiles,
        "allowedContextFiles"
      );

    const forbiddenFiles =
      normalizePathList(
        input.forbiddenFiles,
        "forbiddenFiles"
      );

    const previouslyRequestedFiles =
      new Set(
        normalizePathList(
          input.previouslyRequestedFiles,
          "previouslyRequestedFiles"
        )
      );

    const sourceByPath =
      new Map<
        string,
        ContextEvidenceSource
      >();

    for (
      const requestedFile of
      input.request.requestedFiles
    ) {
      const normalized =
        normalizeRepositoryRelativePath(
          requestedFile,
          "request.requestedFiles"
        );

      sourceByPath.set(
        normalized,
        "requested_file"
      );
    }

    for (
      const requestedTest of
      input.request.requestedTests
    ) {
      const normalized =
        normalizeRepositoryRelativePath(
          requestedTest,
          "request.requestedTests"
        );

      sourceByPath.set(
        normalized,
        sourceByPath.has(normalized)
          ? "requested_file_and_test"
          : "requested_test"
      );
    }

    const requestedPaths = [
      ...sourceByPath.keys()
    ].sort();

    emptySummary.requestedPathCount =
      requestedPaths.length;

    emptySummary.budgetTokens =
      budgetTokens;

    emptySummary.expansionAttempt =
      input.expansionAttempt;

    for (
      const requestedPath of
      requestedPaths
    ) {
      if (
        previouslyRequestedFiles.has(
          requestedPath
        )
      ) {
        throw new ResolverFailure(
          "context_expansion_blocked",
          "context_request_repeated",
          "The same context file cannot be requested in multiple expansion attempts.",
          "previouslyRequestedFiles",
          requestedPath
        );
      }

      if (
        forbiddenFiles.some((rule) =>
          matchesPolicyPath(
            requestedPath,
            rule
          )
        )
      ) {
        throw new ResolverFailure(
          "context_expansion_blocked",
          "context_file_forbidden",
          "Requested context is forbidden by repository policy.",
          "forbiddenFiles",
          requestedPath
        );
      }

      const insideAllowedScope =
        allowedContextFiles.length === 0 ||
        allowedContextFiles.some((rule) =>
          matchesPolicyPath(
            requestedPath,
            rule
          )
        );

      if (
        !insideAllowedScope &&
        !input.request
          .scopeExpansionRequested
      ) {
        throw new ResolverFailure(
          "context_expansion_blocked",
          "context_scope_expansion_not_requested",
          "Requested context is outside allowedContextFiles and no scope expansion was requested.",
          "allowedContextFiles",
          requestedPath
        );
      }

      if (
        !insideAllowedScope &&
        !input.scopeExpansionApproved
      ) {
        throw new ResolverFailure(
          "context_expansion_blocked",
          "context_scope_expansion_not_approved",
          "Requested context is outside allowedContextFiles but scope expansion was not approved.",
          "scopeExpansionApproved",
          requestedPath
        );
      }
    }

    const entries:
      ContextEvidenceEntry[] = [];

    const missingFiles: string[] = [];

    let totalBytesRead = 0;

    for (
      const requestedPath of
      requestedPaths
    ) {
      try {
        const {
          content,
          bytes
        } = await readBoundedUtf8File(
          root,
          requestedPath,
          maxFileBytes
        );

        totalBytesRead += bytes.length;

        if (
          totalBytesRead >
          maxTotalBytes
        ) {
          throw new ResolverFailure(
            "context_expansion_blocked",
            "context_total_bytes_exceeded",
            `Context expansion exceeds the ${maxTotalBytes} byte total limit.`,
            "maxTotalBytes"
          );
        }

        const matchedSymbols =
          input.request.requestedSymbols
            .filter((symbol) =>
              content.includes(symbol)
            )
            .sort();

        entries.push({
          path: requestedPath,
          source:
            sourceByPath.get(
              requestedPath
            ) ?? "requested_file",
          content,
          contentHash:
            hashText(bytes),
          byteLength: bytes.length,
          estimatedTokens:
            Math.ceil(
              content.length / 4
            ),
          matchedSymbols
        });
      } catch (error) {
        if (
          (
            error as
              NodeJS.ErrnoException
          ).code ===
          "CONTEXT_FILE_MISSING"
        ) {
          missingFiles.push(
            requestedPath
          );
          continue;
        }

        throw error;
      }
    }

    const unresolvedSymbols =
      input.request.requestedSymbols
        .filter(
          (symbol) =>
            !entries.some((entry) =>
              entry.matchedSymbols.includes(
                symbol
              )
            )
        )
        .sort();

    const packetCore = {
      version:
        CONTEXT_EXPANSION_RESOLVER_VERSION,
      expansionAttempt:
        input.expansionAttempt,
      requestHash:
        hashCanonical(input.request),
      repositoryIdentityHash:
        hashText(root),
      budgetTokens,
      entries,
      missingFiles:
        [...missingFiles].sort(),
      unresolvedSymbols
    } as const;

    const estimatedTokens =
      estimateJsonTokens(packetCore);

    if (
      estimatedTokens > budgetTokens
    ) {
      throw new ResolverFailure(
        "context_expansion_blocked",
        "context_expansion_budget_exceeded",
        `Context expansion requires approximately ${estimatedTokens} tokens but the hard budget is ${budgetTokens}.`,
        "hardBudgetTokens"
      );
    }

    const packetWithoutHash = {
      ...packetCore,
      estimatedTokens
    };

    const packet:
      BoundedContextExpansionPacket = {
        ...packetWithoutHash,
        packetHash:
          hashCanonical(
            packetWithoutHash
          )
      };

    const issues:
      ContextExpansionIssue[] = [
        ...missingFiles.map(
          (filePath) => ({
            code:
              "context_file_missing",
            message:
              "A requested context file does not exist.",
            severity:
              "review" as const,
            filePath
          })
        ),
        ...unresolvedSymbols.map(
          (symbol) => ({
            code:
              "context_symbol_unresolved",
            message:
              `Requested symbol was not found in the loaded context: ${symbol}`,
            severity:
              "review" as const,
            field:
              "request.requestedSymbols"
          })
        )
      ];

    const summary:
      ContextExpansionResolution["summary"] =
      {
        requestedPathCount:
          requestedPaths.length,
        loadedFileCount:
          entries.length,
        missingFileCount:
          missingFiles.length,
        unresolvedSymbolCount:
          unresolvedSymbols.length,
        totalBytesRead,
        estimatedTokens,
        budgetTokens,
        expansionAttempt:
          input.expansionAttempt,
        repositoryWritePerformed:
          false
      };

    return finish(
      issues.length === 0
        ? "context_expansion_ready"
        : "context_expansion_incomplete",
      issues,
      packet,
      summary
    );
  } catch (error) {
    const failure =
      error instanceof ResolverFailure
        ? error
        : new ResolverFailure(
            "context_expansion_invalid",
            "context_expansion_unexpected_error",
            "Context expansion failed before a safe packet could be produced."
          );

    return finish(
      failure.decision,
      [issueFromFailure(failure)],
      null,
      emptySummary
    );
  }
}
