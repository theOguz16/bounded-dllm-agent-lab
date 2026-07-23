import { hashCanonicalJson } from "./agent-event-ledger.js";
import {
  buildSoftScopeDriftBenchmark,
  type ScopeAbstractionObservation,
  type ScopeDependencyObservation,
  type ScopeFileChangeObservation,
  type ScopeBenchmarkStrategy,
  type SoftScopeCaseDecision,
  type SoftScopeDriftBenchmarkReport
} from "./soft-scope-drift-benchmark.js";

export const OBSERVED_SOFT_SCOPE_RELEASE_VERSION = "1" as const;
export const SOFT_SCOPE_PR_SECTION_HEADING = "## Soft Scope Drift" as const;
export const SOFT_SCOPE_PR_MARKER_PREFIX = "<!-- bounded-soft-scope:" as const;

export type ObservedScopeSourceClass =
  | "disposable_repository_observation"
  | "canonical_runtime_observation";

export type ObservedSoftScopeReleaseInput = {
  releaseBindingVersion: "1";
  runId: string;
  strategy: ScopeBenchmarkStrategy;
  sourceClass: ObservedScopeSourceClass;
  integratedReceiptHash: string;
  applyReceiptHash: string;
  deliveryContractHash: string;
  expectedFiles: readonly string[];
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  requestedRefactor: boolean;
  actualChanges: readonly ScopeFileChangeObservation[];
  newDependencies: readonly ScopeDependencyObservation[];
  newAbstractions: readonly ScopeAbstractionObservation[];
};

export type ObservedSoftScopePrSummary = {
  summaryVersion: "1";
  decision: SoftScopeCaseDecision;
  hardViolationCount: number;
  unexpectedButAllowedFileCount: number;
  missingExpectedFileCount: number;
  unnecessaryLoc: number;
  uncertainLoc: number;
  unrequestedRefactorCount: number;
  unrequestedDependencyCount: number;
  unrequestedAbstractionCount: number;
  humanUnnecessaryLabelCount: number;
  summaryHash: string;
  markdown: string;
};

export type ObservedSoftScopeReleaseReport = {
  reportVersion: "1";
  evidenceClass: "observed_run";
  releaseClaimEligible: true;
  sourceClass: ObservedScopeSourceClass;
  runId: string;
  binding: {
    integratedReceiptHash: string;
    applyReceiptHash: string;
    deliveryContractHash: string;
    bindingHash: string;
  };
  benchmarkReport: SoftScopeDriftBenchmarkReport;
  prSummary: ObservedSoftScopePrSummary;
  reportHash: string;
};

export type BuildObservedSoftScopeReleaseResult = {
  decision:
    | "observed_soft_scope_release_ready"
    | "observed_soft_scope_release_invalid";
  report: ObservedSoftScopeReleaseReport | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    observedRunVerified: boolean;
    receiptBindingVerified: boolean;
    hardAndSoftSeparated: boolean;
    prSummaryBuilt: boolean;
    releaseClaimEligible: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type BindObservedSoftScopePrBodyResult = {
  decision:
    | "observed_soft_scope_pr_body_bound"
    | "observed_soft_scope_pr_body_invalid";
  body: string | null;
  bodyHash: string | null;
  errors: readonly string[];
};

export type VerifyObservedSoftScopeReleaseResult = {
  decision:
    | "observed_soft_scope_release_current"
    | "observed_soft_scope_release_invalid";
  reportIntegrityVerified: boolean;
  sourceInputMatched: boolean;
  prSummaryVerified: boolean;
  releaseClaimEligible: boolean;
  errors: readonly string[];
  repositoryWritePerformed: false;
  shellExecuted: false;
  networkAccessed: false;
};

type PlainRecord = Record<string, unknown>;

const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_BODY_BYTES = 200_000;
const INPUT_FIELDS = new Set([
  "releaseBindingVersion",
  "runId",
  "strategy",
  "sourceClass",
  "integratedReceiptHash",
  "applyReceiptHash",
  "deliveryContractHash",
  "expectedFiles",
  "allowedFiles",
  "forbiddenFiles",
  "requestedRefactor",
  "actualChanges",
  "newDependencies",
  "newAbstractions"
]);

class ObservedScopeFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function exactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string
): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_structure_invalid",
      `${label} must be a plain object.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !fields.has(key) ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_structure_invalid",
        `${label} contains an unknown or accessor field.`
      );
    }
  }
  return value as PlainRecord;
}

function assertAcyclic(
  value: unknown,
  active = new WeakSet<object>(),
  visited = new WeakSet<object>()
): void {
  if (value === null || typeof value !== "object") return;
  if (active.has(value)) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_cycle_detected",
      "Observed soft-scope input must be acyclic."
    );
  }
  if (visited.has(value)) return;
  active.add(value);
  for (const child of Object.values(value)) {
    assertAcyclic(child, active, visited);
  }
  active.delete(value);
  visited.add(value);
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_hash_invalid",
      `${field} must be a SHA-256 hash.`
    );
  }
  return value;
}

function requireRunId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value)
  ) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_run_id_invalid",
      "runId is invalid."
    );
  }
  return value;
}

function validateInput(
  value: ObservedSoftScopeReleaseInput
): ObservedSoftScopeReleaseInput {
  assertAcyclic(value);
  const record = exactRecord(
    value,
    INPUT_FIELDS,
    "observed soft-scope input"
  );

  if (
    record.releaseBindingVersion !== "1" ||
    (
      record.sourceClass !== "disposable_repository_observation" &&
      record.sourceClass !== "canonical_runtime_observation"
    ) ||
    ![
      "direct_large_context",
      "fixed_bounded_context",
      "adaptive_bounded_context"
    ].includes(record.strategy as string) ||
    typeof record.requestedRefactor !== "boolean" ||
    !Array.isArray(record.expectedFiles) ||
    !Array.isArray(record.allowedFiles) ||
    !Array.isArray(record.forbiddenFiles) ||
    !Array.isArray(record.actualChanges) ||
    !Array.isArray(record.newDependencies) ||
    !Array.isArray(record.newAbstractions)
  ) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_input_invalid",
      "Observed soft-scope input is invalid."
    );
  }

  return {
    releaseBindingVersion: "1",
    runId: requireRunId(record.runId),
    strategy: record.strategy as ScopeBenchmarkStrategy,
    sourceClass: record.sourceClass as ObservedScopeSourceClass,
    integratedReceiptHash: requireHash(
      record.integratedReceiptHash,
      "integratedReceiptHash"
    ),
    applyReceiptHash: requireHash(
      record.applyReceiptHash,
      "applyReceiptHash"
    ),
    deliveryContractHash: requireHash(
      record.deliveryContractHash,
      "deliveryContractHash"
    ),
    expectedFiles: record.expectedFiles as readonly string[],
    allowedFiles: record.allowedFiles as readonly string[],
    forbiddenFiles: record.forbiddenFiles as readonly string[],
    requestedRefactor: record.requestedRefactor,
    actualChanges:
      record.actualChanges as readonly ScopeFileChangeObservation[],
    newDependencies:
      record.newDependencies as readonly ScopeDependencyObservation[],
    newAbstractions:
      record.newAbstractions as readonly ScopeAbstractionObservation[]
  };
}

function summaryCore(
  summary: ObservedSoftScopePrSummary
): Omit<ObservedSoftScopePrSummary, "summaryHash" | "markdown"> {
  return {
    summaryVersion: summary.summaryVersion,
    decision: summary.decision,
    hardViolationCount: summary.hardViolationCount,
    unexpectedButAllowedFileCount:
      summary.unexpectedButAllowedFileCount,
    missingExpectedFileCount:
      summary.missingExpectedFileCount,
    unnecessaryLoc: summary.unnecessaryLoc,
    uncertainLoc: summary.uncertainLoc,
    unrequestedRefactorCount:
      summary.unrequestedRefactorCount,
    unrequestedDependencyCount:
      summary.unrequestedDependencyCount,
    unrequestedAbstractionCount:
      summary.unrequestedAbstractionCount,
    humanUnnecessaryLabelCount:
      summary.humanUnnecessaryLabelCount
  };
}

function renderSummaryMarkdown(
  core: Omit<ObservedSoftScopePrSummary, "summaryHash" | "markdown">,
  summaryHash: string
): string {
  return [
    SOFT_SCOPE_PR_SECTION_HEADING,
    "",
    `- Decision: \`${core.decision}\``,
    `- Hard violations: ${core.hardViolationCount}`,
    `- Unexpected but allowed files: ${core.unexpectedButAllowedFileCount}`,
    `- Missing expected files: ${core.missingExpectedFileCount}`,
    `- Unnecessary LOC: ${core.unnecessaryLoc}`,
    `- Uncertain LOC: ${core.uncertainLoc}`,
    `- Unrequested refactors: ${core.unrequestedRefactorCount}`,
    `- Unrequested dependencies: ${core.unrequestedDependencyCount}`,
    `- Unrequested abstractions: ${core.unrequestedAbstractionCount}`,
    `- Human unnecessary labels: ${core.humanUnnecessaryLabelCount}`,
    "",
    `${SOFT_SCOPE_PR_MARKER_PREFIX}${summaryHash} -->`
  ].join("\n");
}

function buildPrSummary(
  report: SoftScopeDriftBenchmarkReport
): ObservedSoftScopePrSummary {
  const caseResult = report.caseResults[0];
  if (!caseResult || report.caseResults.length !== 1) {
    throw new ObservedScopeFailure(
      "observed_soft_scope_case_count_invalid",
      "Observed release report must contain exactly one run case."
    );
  }

  const core = {
    summaryVersion: "1" as const,
    decision: caseResult.decision,
    hardViolationCount:
      caseResult.metrics.hardViolationCount,
    unexpectedButAllowedFileCount:
      caseResult.metrics.unexpectedButAllowedFiles.length,
    missingExpectedFileCount:
      caseResult.metrics.missingExpectedFiles.length,
    unnecessaryLoc:
      caseResult.metrics.unnecessaryLoc,
    uncertainLoc:
      caseResult.metrics.uncertainLoc,
    unrequestedRefactorCount:
      caseResult.metrics.unrequestedRefactorCount,
    unrequestedDependencyCount:
      caseResult.metrics.unrequestedDependencyCount,
    unrequestedAbstractionCount:
      caseResult.metrics.unrequestedAbstractionCount,
    humanUnnecessaryLabelCount:
      caseResult.metrics.humanUnnecessaryLabelCount
  };
  const summaryHash = hashCanonicalJson(core);

  return deepFreeze({
    ...core,
    summaryHash,
    markdown:
      renderSummaryMarkdown(core, summaryHash)
  });
}

function reportCore(
  report: ObservedSoftScopeReleaseReport
): Omit<ObservedSoftScopeReleaseReport, "reportHash"> {
  const { reportHash: _, ...core } = report;
  return core;
}

export function buildObservedSoftScopeReleaseReport(
  rawInput: ObservedSoftScopeReleaseInput
): BuildObservedSoftScopeReleaseResult {
  try {
    const input = validateInput(rawInput);

    const benchmarkResult =
      buildSoftScopeDriftBenchmark({
        benchmarkVersion: "1",
        benchmarkId:
          `observed-soft-scope:${input.runId}`,
        evidenceClass: "observed_run",
        cases: [
          {
            caseId: input.runId,
            strategy: input.strategy,
            expectedFiles: input.expectedFiles,
            allowedFiles: input.allowedFiles,
            forbiddenFiles: input.forbiddenFiles,
            requestedRefactor:
              input.requestedRefactor,
            actualChanges: input.actualChanges,
            newDependencies:
              input.newDependencies,
            newAbstractions:
              input.newAbstractions
          }
        ]
      });

    if (
      benchmarkResult.report === null ||
      benchmarkResult.decision !==
        "soft_scope_drift_benchmark_ready" ||
      benchmarkResult.report.evidenceClass !==
        "observed_run" ||
      benchmarkResult.report.releaseClaimEligible !==
        true
    ) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_benchmark_invalid",
        "Observed benchmark could not be built."
      );
    }

    const bindingMaterial = {
      runId: input.runId,
      integratedReceiptHash:
        input.integratedReceiptHash,
      applyReceiptHash:
        input.applyReceiptHash,
      deliveryContractHash:
        input.deliveryContractHash,
      benchmarkReportHash:
        benchmarkResult.report.reportHash
    };
    const bindingHash =
      hashCanonicalJson(bindingMaterial);
    const prSummary =
      buildPrSummary(benchmarkResult.report);

    const material = {
      reportVersion: "1" as const,
      evidenceClass: "observed_run" as const,
      releaseClaimEligible: true as const,
      sourceClass: input.sourceClass,
      runId: input.runId,
      binding: {
        integratedReceiptHash:
          input.integratedReceiptHash,
        applyReceiptHash:
          input.applyReceiptHash,
        deliveryContractHash:
          input.deliveryContractHash,
        bindingHash
      },
      benchmarkReport:
        benchmarkResult.report,
      prSummary
    };
    const report: ObservedSoftScopeReleaseReport = {
      ...material,
      reportHash:
        hashCanonicalJson(material)
    };

    return deepFreeze({
      decision:
        "observed_soft_scope_release_ready",
      report,
      errors: [],
      summary: {
        inputValid: true,
        observedRunVerified: true,
        receiptBindingVerified: true,
        hardAndSoftSeparated: true,
        prSummaryBuilt: true,
        releaseClaimEligible: true,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  } catch (error) {
    const failure =
      error instanceof ObservedScopeFailure
        ? error
        : new ObservedScopeFailure(
            "observed_soft_scope_release_exception",
            "Observed soft-scope release build failed closed."
          );
    return deepFreeze({
      decision:
        "observed_soft_scope_release_invalid",
      report: null,
      errors: [failure.code],
      summary: {
        inputValid: false,
        observedRunVerified: false,
        receiptBindingVerified: false,
        hardAndSoftSeparated: false,
        prSummaryBuilt: false,
        releaseClaimEligible: false,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  }
}

export function bindObservedSoftScopePrBody(
  body: string,
  report: ObservedSoftScopeReleaseReport
): BindObservedSoftScopePrBodyResult {
  try {
    if (
      typeof body !== "string" ||
      body.length === 0 ||
      Buffer.byteLength(body, "utf8") >
        MAX_BODY_BYTES ||
      ASCII_CONTROL.test(
        body.replace(/\r?\n/g, "")
      ) ||
      body.includes(
        SOFT_SCOPE_PR_SECTION_HEADING
      ) ||
      body.includes(
        SOFT_SCOPE_PR_MARKER_PREFIX
      )
    ) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_pr_body_invalid",
        "Draft PR body is invalid or already contains a soft-scope section."
      );
    }

    const integrityVerified =
      HASH.test(report.reportHash) &&
      report.reportHash ===
        hashCanonicalJson(
          reportCore(report)
        ) &&
      report.prSummary.summaryHash ===
        hashCanonicalJson(
          summaryCore(report.prSummary)
        ) &&
      report.prSummary.markdown ===
        renderSummaryMarkdown(
          summaryCore(report.prSummary),
          report.prSummary.summaryHash
        );
    if (!integrityVerified) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_report_invalid",
        "Observed soft-scope report integrity is invalid."
      );
    }

    const normalizedBody =
      body.endsWith("\n")
        ? body.slice(0, -1)
        : body;
    const boundBody =
      `${normalizedBody}\n\n${report.prSummary.markdown}\n`;

    if (
      Buffer.byteLength(boundBody, "utf8") >
        MAX_BODY_BYTES
    ) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_pr_body_too_large",
        "Bound draft PR body exceeds its byte limit."
      );
    }

    return deepFreeze({
      decision:
        "observed_soft_scope_pr_body_bound",
      body: boundBody,
      bodyHash: hashCanonicalJson({
        artifactType:
          "observed_soft_scope_pr_body",
        body: boundBody
      }),
      errors: []
    });
  } catch (error) {
    const failure =
      error instanceof ObservedScopeFailure
        ? error
        : new ObservedScopeFailure(
            "observed_soft_scope_pr_body_exception",
            "Observed soft-scope PR body binding failed closed."
          );
    return deepFreeze({
      decision:
        "observed_soft_scope_pr_body_invalid",
      body: null,
      bodyHash: null,
      errors: [failure.code]
    });
  }
}

export function verifyObservedSoftScopePrBody(
  body: string,
  report: ObservedSoftScopeReleaseReport
): boolean {
  if (
    typeof body !== "string" ||
    !body.endsWith(
      `${report.prSummary.markdown}\n`
    )
  ) {
    return false;
  }
  const marker =
    `${SOFT_SCOPE_PR_MARKER_PREFIX}${report.prSummary.summaryHash} -->`;
  return (
    body.includes(
      SOFT_SCOPE_PR_SECTION_HEADING
    ) &&
    body.includes(marker) &&
    body.indexOf(
      SOFT_SCOPE_PR_SECTION_HEADING
    ) ===
      body.lastIndexOf(
        SOFT_SCOPE_PR_SECTION_HEADING
      ) &&
    body.indexOf(marker) ===
      body.lastIndexOf(marker)
  );
}

export function verifyObservedSoftScopeReleaseReport(
  input: ObservedSoftScopeReleaseInput,
  report: ObservedSoftScopeReleaseReport,
  requireSourceInputMatch = true
): VerifyObservedSoftScopeReleaseResult {
  try {
    const integrityVerified =
      HASH.test(report.reportHash) &&
      report.reportHash ===
        hashCanonicalJson(
          reportCore(report)
        ) &&
      report.evidenceClass ===
        "observed_run" &&
      report.releaseClaimEligible === true &&
      report.prSummary.summaryHash ===
        hashCanonicalJson(
          summaryCore(report.prSummary)
        ) &&
      report.prSummary.markdown ===
        renderSummaryMarkdown(
          summaryCore(report.prSummary),
          report.prSummary.summaryHash
        );

    if (!integrityVerified) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_report_integrity_mismatch",
        "Observed soft-scope report integrity mismatch."
      );
    }

    let sourceInputMatched = true;
    if (requireSourceInputMatch) {
      const rebuilt =
        buildObservedSoftScopeReleaseReport(
          input
        );
      sourceInputMatched =
        rebuilt.report !== null &&
        rebuilt.report.reportHash ===
          report.reportHash;
    }

    if (!sourceInputMatched) {
      throw new ObservedScopeFailure(
        "observed_soft_scope_source_input_mismatch",
        "Observed soft-scope source input mismatch."
      );
    }

    return deepFreeze({
      decision:
        "observed_soft_scope_release_current",
      reportIntegrityVerified: true,
      sourceInputMatched,
      prSummaryVerified: true,
      releaseClaimEligible: true,
      errors: [],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  } catch (error) {
    const failure =
      error instanceof ObservedScopeFailure
        ? error
        : new ObservedScopeFailure(
            "observed_soft_scope_verification_exception",
            "Observed soft-scope verification failed closed."
          );
    return deepFreeze({
      decision:
        "observed_soft_scope_release_invalid",
      reportIntegrityVerified: false,
      sourceInputMatched: false,
      prSummaryVerified: false,
      releaseClaimEligible: false,
      errors: [failure.code],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  }
}
