import { hashCanonicalJson } from "./agent-event-ledger.js";

export const SOFT_SCOPE_DRIFT_BENCHMARK_VERSION = "1" as const;

export type ScopeBenchmarkStrategy =
  | "direct_large_context"
  | "fixed_bounded_context"
  | "adaptive_bounded_context";

export type ScopeChangeKind =
  | "feature"
  | "bugfix"
  | "test"
  | "refactor"
  | "config"
  | "docs"
  | "dependency";

export type ScopeNecessity =
  | "required"
  | "unnecessary"
  | "uncertain";

export type ScopeHumanReview =
  | "necessary"
  | "unnecessary"
  | "not_reviewed";

export type ScopeFileChangeObservation = {
  filePath: string;
  linesAdded: number;
  linesDeleted: number;
  changeKind: ScopeChangeKind;
  necessity: ScopeNecessity;
  humanReview: ScopeHumanReview;
};

export type ScopeDependencyObservation = {
  name: string;
  requested: boolean;
  justification: string | null;
};

export type ScopeAbstractionObservation = {
  abstractionId: string;
  filePath: string;
  requested: boolean;
  justification: string | null;
};

export type SoftScopeDriftBenchmarkCase = {
  caseId: string;
  strategy: ScopeBenchmarkStrategy;
  expectedFiles: readonly string[];
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  requestedRefactor: boolean;
  actualChanges: readonly ScopeFileChangeObservation[];
  newDependencies: readonly ScopeDependencyObservation[];
  newAbstractions: readonly ScopeAbstractionObservation[];
};

export type SoftScopeCaseDecision =
  | "hard_scope_blocked"
  | "soft_scope_review"
  | "scope_clean";

export type SoftScopeCaseMetrics = {
  expectedFileCount: number;
  actualFileCount: number;
  missingExpectedFiles: readonly string[];
  unexpectedButAllowedFiles: readonly string[];
  forbiddenTouchedFiles: readonly string[];
  outsideAllowedFiles: readonly string[];
  hardViolationCount: number;
  unnecessaryLoc: number;
  uncertainLoc: number;
  unrequestedRefactorCount: number;
  newDependencyCount: number;
  unrequestedDependencyCount: number;
  unjustifiedDependencyCount: number;
  newAbstractionCount: number;
  unrequestedAbstractionCount: number;
  justifiedAbstractionCount: number;
  abstractionJustificationRate: number | null;
  humanUnnecessaryLabelCount: number;
  humanReviewedFileCount: number;
  humanUnnecessaryRate: number | null;
  softSignalCount: number;
};

export type SoftScopeCaseResult = {
  caseId: string;
  strategy: ScopeBenchmarkStrategy;
  decision: SoftScopeCaseDecision;
  metrics: SoftScopeCaseMetrics;
  reasonCodes: readonly string[];
  caseInputHash: string;
  caseResultHash: string;
};

export type SoftScopeStrategyAggregate = {
  strategy: ScopeBenchmarkStrategy;
  caseCount: number;
  cleanCaseCount: number;
  reviewCaseCount: number;
  blockedCaseCount: number;
  hardViolationCount: number;
  unexpectedButAllowedFileCount: number;
  missingExpectedFileCount: number;
  unnecessaryLoc: number;
  uncertainLoc: number;
  unrequestedRefactorCount: number;
  newDependencyCount: number;
  unrequestedDependencyCount: number;
  unjustifiedDependencyCount: number;
  newAbstractionCount: number;
  unrequestedAbstractionCount: number;
  justifiedAbstractionCount: number;
  abstractionJustificationRate: number | null;
  humanUnnecessaryLabelCount: number;
};

export type SoftScopeDriftBenchmarkInput = {
  benchmarkVersion: "1";
  benchmarkId: string;
  evidenceClass: "deterministic_fixture" | "observed_run";
  cases: readonly SoftScopeDriftBenchmarkCase[];
};

export type SoftScopeDriftBenchmarkReport = {
  reportVersion: "1";
  benchmarkId: string;
  evidenceClass: "deterministic_fixture" | "observed_run";
  releaseClaimEligible: boolean;
  sourceInputHash: string;
  caseResults: readonly SoftScopeCaseResult[];
  strategyAggregates: readonly SoftScopeStrategyAggregate[];
  overall: {
    caseCount: number;
    cleanCaseCount: number;
    reviewCaseCount: number;
    blockedCaseCount: number;
    hardViolationCount: number;
    unexpectedButAllowedFileCount: number;
    missingExpectedFileCount: number;
    unnecessaryLoc: number;
    uncertainLoc: number;
    unrequestedRefactorCount: number;
    newDependencyCount: number;
    unrequestedDependencyCount: number;
    unjustifiedDependencyCount: number;
    newAbstractionCount: number;
    unrequestedAbstractionCount: number;
    justifiedAbstractionCount: number;
    abstractionJustificationRate: number | null;
    humanUnnecessaryLabelCount: number;
  };
  reportHash: string;
};

export type BuildSoftScopeDriftBenchmarkResult = {
  decision:
    | "soft_scope_drift_benchmark_ready"
    | "soft_scope_drift_benchmark_invalid";
  report: SoftScopeDriftBenchmarkReport | null;
  errors: readonly string[];
  summary: {
    inputValid: boolean;
    caseCount: number;
    strategyCount: number;
    hardAndSoftSeparated: boolean;
    releaseClaimEligible: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

export type VerifySoftScopeDriftBenchmarkReportResult = {
  decision:
    | "soft_scope_drift_benchmark_report_current"
    | "soft_scope_drift_benchmark_report_invalid";
  reportIntegrityVerified: boolean;
  sourceInputMatched: boolean;
  releaseClaimEligible: boolean;
  errors: readonly string[];
  repositoryWritePerformed: false;
  shellExecuted: false;
  networkAccessed: false;
};

type PlainRecord = Record<string, unknown>;

const STRATEGIES: readonly ScopeBenchmarkStrategy[] = [
  "direct_large_context",
  "fixed_bounded_context",
  "adaptive_bounded_context"
];
const CHANGE_KINDS: readonly ScopeChangeKind[] = [
  "feature",
  "bugfix",
  "test",
  "refactor",
  "config",
  "docs",
  "dependency"
];
const NECESSITIES: readonly ScopeNecessity[] = [
  "required",
  "unnecessary",
  "uncertain"
];
const HUMAN_REVIEWS: readonly ScopeHumanReview[] = [
  "necessary",
  "unnecessary",
  "not_reviewed"
];
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_PACKAGE =
  /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const SAFE_PATH =
  /^(?!\/)(?!.*(?:\\|\u0000|\r|\n))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+-]{1,4096}$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_CASES = 10_000;
const MAX_FILES_PER_CASE = 10_000;
const MAX_OBSERVATIONS_PER_CASE = 10_000;
const MAX_LOC_PER_FILE = 10_000_000;
const MAX_TOTAL_LOC = 1_000_000_000;

const INPUT_FIELDS = new Set([
  "benchmarkVersion",
  "benchmarkId",
  "evidenceClass",
  "cases"
]);
const CASE_FIELDS = new Set([
  "caseId",
  "strategy",
  "expectedFiles",
  "allowedFiles",
  "forbiddenFiles",
  "requestedRefactor",
  "actualChanges",
  "newDependencies",
  "newAbstractions"
]);
const CHANGE_FIELDS = new Set([
  "filePath",
  "linesAdded",
  "linesDeleted",
  "changeKind",
  "necessity",
  "humanReview"
]);
const DEPENDENCY_FIELDS = new Set([
  "name",
  "requested",
  "justification"
]);
const ABSTRACTION_FIELDS = new Set([
  "abstractionId",
  "filePath",
  "requested",
  "justification"
]);

class ScopeBenchmarkFailure extends Error {
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

function sortedUnique(
  values: readonly string[]
): string[] {
  return [...new Set(values)].sort(
    (left, right) => left.localeCompare(right)
  );
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
    throw new ScopeBenchmarkFailure(
      "soft_scope_structure_invalid",
      `${label} must be a plain object.`
    );
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  for (
    const [key, descriptor]
    of Object.entries(descriptors)
  ) {
    if (
      !fields.has(key) ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new ScopeBenchmarkFailure(
        "soft_scope_structure_invalid",
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
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return;
  }
  if (active.has(value)) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_cycle_detected",
      "Soft-scope benchmark input must be acyclic."
    );
  }
  if (visited.has(value)) {
    return;
  }
  active.add(value);
  for (const child of Object.values(value)) {
    assertAcyclic(child, active, visited);
  }
  active.delete(value);
  visited.add(value);
}

function requireString(
  value: unknown,
  label: string,
  maximum = 4096
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value)
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_value_invalid",
      `${label} is invalid.`
    );
  }
  return value;
}

function requireOptionalJustification(
  value: unknown,
  label: string
): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, label, 2000);
}

function requireCount(
  value: unknown,
  label: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_LOC_PER_FILE
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_numeric_invalid",
      `${label} is invalid.`
    );
  }
  return value as number;
}

function requirePath(
  value: unknown,
  label: string
): string {
  const path = requireString(value, label);
  if (!SAFE_PATH.test(path)) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_path_invalid",
      `${label} is invalid.`
    );
  }
  return path;
}

function validatePathSet(
  value: unknown,
  label: string
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FILES_PER_CASE
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_path_set_invalid",
      `${label} is invalid.`
    );
  }
  const paths = value.map(
    (entry, index) =>
      requirePath(
        entry,
        `${label}[${index}]`
      )
  );
  if (new Set(paths).size !== paths.length) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_path_set_duplicate",
      `${label} contains duplicates.`
    );
  }
  return paths.sort(
    (left, right) => left.localeCompare(right)
  );
}

function validateChange(
  value: unknown,
  index: number
): ScopeFileChangeObservation {
  const record = exactRecord(
    value,
    CHANGE_FIELDS,
    `actualChanges[${index}]`
  );
  if (
    !CHANGE_KINDS.includes(
      record.changeKind as ScopeChangeKind
    ) ||
    !NECESSITIES.includes(
      record.necessity as ScopeNecessity
    ) ||
    !HUMAN_REVIEWS.includes(
      record.humanReview as ScopeHumanReview
    )
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_change_invalid",
      "A file-change observation is invalid."
    );
  }
  return {
    filePath: requirePath(
      record.filePath,
      `actualChanges[${index}].filePath`
    ),
    linesAdded: requireCount(
      record.linesAdded,
      `actualChanges[${index}].linesAdded`
    ),
    linesDeleted: requireCount(
      record.linesDeleted,
      `actualChanges[${index}].linesDeleted`
    ),
    changeKind:
      record.changeKind as ScopeChangeKind,
    necessity:
      record.necessity as ScopeNecessity,
    humanReview:
      record.humanReview as ScopeHumanReview
  };
}

function validateDependency(
  value: unknown,
  index: number
): ScopeDependencyObservation {
  const record = exactRecord(
    value,
    DEPENDENCY_FIELDS,
    `newDependencies[${index}]`
  );
  const name = requireString(
    record.name,
    `newDependencies[${index}].name`,
    214
  ).toLowerCase();
  if (
    !SAFE_PACKAGE.test(name) ||
    typeof record.requested !== "boolean"
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_dependency_invalid",
      "A dependency observation is invalid."
    );
  }
  return {
    name,
    requested: record.requested,
    justification:
      requireOptionalJustification(
        record.justification,
        `newDependencies[${index}].justification`
      )
  };
}

function validateAbstraction(
  value: unknown,
  index: number
): ScopeAbstractionObservation {
  const record = exactRecord(
    value,
    ABSTRACTION_FIELDS,
    `newAbstractions[${index}]`
  );
  const abstractionId = requireString(
    record.abstractionId,
    `newAbstractions[${index}].abstractionId`,
    160
  );
  if (
    !SAFE_ID.test(abstractionId) ||
    typeof record.requested !== "boolean"
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_abstraction_invalid",
      "An abstraction observation is invalid."
    );
  }
  return {
    abstractionId,
    filePath: requirePath(
      record.filePath,
      `newAbstractions[${index}].filePath`
    ),
    requested: record.requested,
    justification:
      requireOptionalJustification(
        record.justification,
        `newAbstractions[${index}].justification`
      )
  };
}

function validateCase(
  value: unknown,
  index: number
): SoftScopeDriftBenchmarkCase {
  const record = exactRecord(
    value,
    CASE_FIELDS,
    `cases[${index}]`
  );
  const caseId = requireString(
    record.caseId,
    `cases[${index}].caseId`,
    160
  );
  if (
    !SAFE_ID.test(caseId) ||
    !STRATEGIES.includes(
      record.strategy as ScopeBenchmarkStrategy
    ) ||
    typeof record.requestedRefactor !== "boolean" ||
    !Array.isArray(record.actualChanges) ||
    !Array.isArray(record.newDependencies) ||
    !Array.isArray(record.newAbstractions) ||
    record.actualChanges.length >
      MAX_OBSERVATIONS_PER_CASE ||
    record.newDependencies.length >
      MAX_OBSERVATIONS_PER_CASE ||
    record.newAbstractions.length >
      MAX_OBSERVATIONS_PER_CASE
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_case_invalid",
      `Case ${caseId} is invalid.`
    );
  }

  const expectedFiles = validatePathSet(
    record.expectedFiles,
    `cases[${index}].expectedFiles`
  );
  const allowedFiles = validatePathSet(
    record.allowedFiles,
    `cases[${index}].allowedFiles`
  );
  const forbiddenFiles = validatePathSet(
    record.forbiddenFiles,
    `cases[${index}].forbiddenFiles`
  );

  const allowedSet = new Set(allowedFiles);
  const forbiddenSet = new Set(forbiddenFiles);
  if (
    expectedFiles.some(
      (path) => !allowedSet.has(path)
    ) ||
    allowedFiles.some(
      (path) => forbiddenSet.has(path)
    )
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_contract_invalid",
      `Case ${caseId} has inconsistent expected/allowed/forbidden scope.`
    );
  }

  const actualChanges = record.actualChanges.map(
    validateChange
  );
  const actualPaths = actualChanges.map(
    (entry) => entry.filePath
  );
  if (
    new Set(actualPaths).size !==
      actualPaths.length
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_actual_duplicate",
      `Case ${caseId} contains duplicate actual file observations.`
    );
  }

  const newDependencies =
    record.newDependencies.map(
      validateDependency
    );
  if (
    new Set(
      newDependencies.map((entry) => entry.name)
    ).size !== newDependencies.length
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_dependency_duplicate",
      `Case ${caseId} contains duplicate dependencies.`
    );
  }

  const newAbstractions =
    record.newAbstractions.map(
      validateAbstraction
    );
  if (
    new Set(
      newAbstractions.map(
        (entry) => entry.abstractionId
      )
    ).size !== newAbstractions.length
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_abstraction_duplicate",
      `Case ${caseId} contains duplicate abstractions.`
    );
  }

  return {
    caseId,
    strategy:
      record.strategy as ScopeBenchmarkStrategy,
    expectedFiles,
    allowedFiles,
    forbiddenFiles,
    requestedRefactor:
      record.requestedRefactor,
    actualChanges: actualChanges.sort(
      (left, right) =>
        left.filePath.localeCompare(
          right.filePath
        )
    ),
    newDependencies:
      newDependencies.sort(
        (left, right) =>
          left.name.localeCompare(right.name)
      ),
    newAbstractions:
      newAbstractions.sort(
        (left, right) =>
          left.abstractionId.localeCompare(
            right.abstractionId
          )
      )
  };
}

function validateInput(
  value: unknown
): SoftScopeDriftBenchmarkInput {
  assertAcyclic(value);
  const record = exactRecord(
    value,
    INPUT_FIELDS,
    "soft-scope benchmark input"
  );
  if (
    record.benchmarkVersion !== "1" ||
    typeof record.benchmarkId !== "string" ||
    !SAFE_ID.test(record.benchmarkId) ||
    (
      record.evidenceClass !==
        "deterministic_fixture" &&
      record.evidenceClass !==
        "observed_run"
    ) ||
    !Array.isArray(record.cases) ||
    record.cases.length === 0 ||
    record.cases.length > MAX_CASES
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_input_invalid",
      "Soft-scope benchmark input is invalid."
    );
  }

  const cases = record.cases.map(
    validateCase
  );
  const caseIds = cases.map(
    (entry) => entry.caseId
  );
  if (
    new Set(caseIds).size !==
      caseIds.length
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_case_duplicate",
      "Soft-scope benchmark case IDs must be unique."
    );
  }

  return {
    benchmarkVersion: "1",
    benchmarkId: record.benchmarkId,
    evidenceClass: record.evidenceClass,
    cases: cases.sort(
      (left, right) =>
        left.caseId.localeCompare(
          right.caseId
        )
    )
  };
}

function safeAdd(
  current: number,
  value: number
): number {
  const result = current + value;
  if (
    !Number.isSafeInteger(result) ||
    result > MAX_TOTAL_LOC
  ) {
    throw new ScopeBenchmarkFailure(
      "soft_scope_total_overflow",
      "Soft-scope LOC accounting overflowed."
    );
  }
  return result;
}

function ratio(
  numerator: number,
  denominator: number
): number | null {
  if (denominator === 0) {
    return null;
  }
  return Number(
    (numerator / denominator).toFixed(6)
  );
}

function evaluateCase(
  input: SoftScopeDriftBenchmarkCase
): SoftScopeCaseResult {
  const expectedSet =
    new Set(input.expectedFiles);
  const allowedSet =
    new Set(input.allowedFiles);
  const forbiddenSet =
    new Set(input.forbiddenFiles);
  const actualFiles =
    input.actualChanges.map(
      (entry) => entry.filePath
    );
  const actualSet = new Set(actualFiles);

  const missingExpectedFiles =
    input.expectedFiles.filter(
      (file) => !actualSet.has(file)
    );
  const forbiddenTouchedFiles =
    actualFiles.filter(
      (file) => forbiddenSet.has(file)
    );
  const outsideAllowedFiles =
    actualFiles.filter(
      (file) => !allowedSet.has(file)
    );
  const unexpectedButAllowedFiles =
    actualFiles.filter(
      (file) =>
        allowedSet.has(file) &&
        !forbiddenSet.has(file) &&
        !expectedSet.has(file)
    );

  let unnecessaryLoc = 0;
  let uncertainLoc = 0;
  let unrequestedRefactorCount = 0;
  let humanUnnecessaryLabelCount = 0;
  let humanReviewedFileCount = 0;

  for (const change of input.actualChanges) {
    const loc = safeAdd(
      change.linesAdded,
      change.linesDeleted
    );
    if (change.necessity === "unnecessary") {
      unnecessaryLoc =
        safeAdd(unnecessaryLoc, loc);
    }
    if (change.necessity === "uncertain") {
      uncertainLoc =
        safeAdd(uncertainLoc, loc);
    }
    if (
      change.changeKind === "refactor" &&
      !input.requestedRefactor
    ) {
      unrequestedRefactorCount += 1;
    }
    if (
      change.humanReview !== "not_reviewed"
    ) {
      humanReviewedFileCount += 1;
    }
    if (
      change.humanReview === "unnecessary"
    ) {
      humanUnnecessaryLabelCount += 1;
    }
  }

  const newDependencyCount =
    input.newDependencies.length;
  const unrequestedDependencyCount =
    input.newDependencies.filter(
      (entry) => !entry.requested
    ).length;
  const unjustifiedDependencyCount =
    input.newDependencies.filter(
      (entry) =>
        entry.justification === null
    ).length;

  const newAbstractionCount =
    input.newAbstractions.length;
  const unrequestedAbstractionCount =
    input.newAbstractions.filter(
      (entry) => !entry.requested
    ).length;
  const justifiedAbstractionCount =
    input.newAbstractions.filter(
      (entry) =>
        entry.justification !== null
    ).length;

  const hardViolationFiles =
    sortedUnique([
      ...forbiddenTouchedFiles,
      ...outsideAllowedFiles
    ]);
  const hardViolationCount =
    hardViolationFiles.length;

  const softReasonCodes: string[] = [];
  if (
    unexpectedButAllowedFiles.length > 0
  ) {
    softReasonCodes.push(
      "soft_scope_unexpected_allowed_files"
    );
  }
  if (missingExpectedFiles.length > 0) {
    softReasonCodes.push(
      "soft_scope_expected_files_missing"
    );
  }
  if (unnecessaryLoc > 0) {
    softReasonCodes.push(
      "soft_scope_unnecessary_loc"
    );
  }
  if (uncertainLoc > 0) {
    softReasonCodes.push(
      "soft_scope_uncertain_loc"
    );
  }
  if (unrequestedRefactorCount > 0) {
    softReasonCodes.push(
      "soft_scope_unrequested_refactor"
    );
  }
  if (unrequestedDependencyCount > 0) {
    softReasonCodes.push(
      "soft_scope_unrequested_dependency"
    );
  }
  if (unjustifiedDependencyCount > 0) {
    softReasonCodes.push(
      "soft_scope_unjustified_dependency"
    );
  }
  if (unrequestedAbstractionCount > 0) {
    softReasonCodes.push(
      "soft_scope_unrequested_abstraction"
    );
  }
  if (
    newAbstractionCount >
      justifiedAbstractionCount
  ) {
    softReasonCodes.push(
      "soft_scope_unjustified_abstraction"
    );
  }
  if (humanUnnecessaryLabelCount > 0) {
    softReasonCodes.push(
      "soft_scope_human_unnecessary_label"
    );
  }

  const reasonCodes =
    hardViolationCount > 0
      ? sortedUnique([
          ...softReasonCodes,
          ...(forbiddenTouchedFiles.length > 0
            ? [
                "hard_scope_forbidden_file_touched"
              ]
            : []),
          ...(outsideAllowedFiles.length > 0
            ? [
                "hard_scope_outside_allowed_file"
              ]
            : [])
        ])
      : sortedUnique(softReasonCodes);

  const decision: SoftScopeCaseDecision =
    hardViolationCount > 0
      ? "hard_scope_blocked"
      : reasonCodes.length > 0
        ? "soft_scope_review"
        : "scope_clean";

  const metrics: SoftScopeCaseMetrics = {
    expectedFileCount:
      input.expectedFiles.length,
    actualFileCount: actualFiles.length,
    missingExpectedFiles,
    unexpectedButAllowedFiles:
      sortedUnique(
        unexpectedButAllowedFiles
      ),
    forbiddenTouchedFiles:
      sortedUnique(forbiddenTouchedFiles),
    outsideAllowedFiles:
      sortedUnique(outsideAllowedFiles),
    hardViolationCount,
    unnecessaryLoc,
    uncertainLoc,
    unrequestedRefactorCount,
    newDependencyCount,
    unrequestedDependencyCount,
    unjustifiedDependencyCount,
    newAbstractionCount,
    unrequestedAbstractionCount,
    justifiedAbstractionCount,
    abstractionJustificationRate:
      ratio(
        justifiedAbstractionCount,
        newAbstractionCount
      ),
    humanUnnecessaryLabelCount,
    humanReviewedFileCount,
    humanUnnecessaryRate:
      ratio(
        humanUnnecessaryLabelCount,
        humanReviewedFileCount
      ),
    softSignalCount:
      softReasonCodes.length
  };

  const caseInputHash =
    hashCanonicalJson(input);
  const material = {
    caseId: input.caseId,
    strategy: input.strategy,
    decision,
    metrics,
    reasonCodes,
    caseInputHash
  };

  return deepFreeze({
    ...material,
    caseResultHash:
      hashCanonicalJson(material)
  });
}

function aggregate(
  strategy: ScopeBenchmarkStrategy,
  cases: readonly SoftScopeCaseResult[]
): SoftScopeStrategyAggregate {
  let unnecessaryLoc = 0;
  let uncertainLoc = 0;

  for (const entry of cases) {
    unnecessaryLoc = safeAdd(
      unnecessaryLoc,
      entry.metrics.unnecessaryLoc
    );
    uncertainLoc = safeAdd(
      uncertainLoc,
      entry.metrics.uncertainLoc
    );
  }

  const newAbstractionCount =
    cases.reduce(
      (sum, entry) =>
        sum +
        entry.metrics.newAbstractionCount,
      0
    );
  const justifiedAbstractionCount =
    cases.reduce(
      (sum, entry) =>
        sum +
        entry.metrics
          .justifiedAbstractionCount,
      0
    );

  return {
    strategy,
    caseCount: cases.length,
    cleanCaseCount:
      cases.filter(
        (entry) =>
          entry.decision === "scope_clean"
      ).length,
    reviewCaseCount:
      cases.filter(
        (entry) =>
          entry.decision ===
            "soft_scope_review"
      ).length,
    blockedCaseCount:
      cases.filter(
        (entry) =>
          entry.decision ===
            "hard_scope_blocked"
      ).length,
    hardViolationCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics.hardViolationCount,
        0
      ),
    unexpectedButAllowedFileCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .unexpectedButAllowedFiles
            .length,
        0
      ),
    missingExpectedFileCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .missingExpectedFiles.length,
        0
      ),
    unnecessaryLoc,
    uncertainLoc,
    unrequestedRefactorCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .unrequestedRefactorCount,
        0
      ),
    newDependencyCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics.newDependencyCount,
        0
      ),
    unrequestedDependencyCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .unrequestedDependencyCount,
        0
      ),
    unjustifiedDependencyCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .unjustifiedDependencyCount,
        0
      ),
    newAbstractionCount,
    unrequestedAbstractionCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .unrequestedAbstractionCount,
        0
      ),
    justifiedAbstractionCount,
    abstractionJustificationRate:
      ratio(
        justifiedAbstractionCount,
        newAbstractionCount
      ),
    humanUnnecessaryLabelCount:
      cases.reduce(
        (sum, entry) =>
          sum +
          entry.metrics
            .humanUnnecessaryLabelCount,
        0
      )
  };
}

function reportCore(
  report: SoftScopeDriftBenchmarkReport
): Omit<
  SoftScopeDriftBenchmarkReport,
  "reportHash"
> {
  const { reportHash: _, ...core } =
    report;
  return core;
}

export function buildSoftScopeDriftBenchmark(
  rawInput: SoftScopeDriftBenchmarkInput
): BuildSoftScopeDriftBenchmarkResult {
  try {
    const input = validateInput(rawInput);
    const caseResults =
      input.cases.map(evaluateCase);

    const strategyAggregates =
      STRATEGIES
        .map((strategy) =>
          aggregate(
            strategy,
            caseResults.filter(
              (entry) =>
                entry.strategy === strategy
            )
          )
        )
        .filter(
          (entry) => entry.caseCount > 0
        );

    const overall =
      aggregate(
        "adaptive_bounded_context",
        caseResults
      );
    const overallWithoutStrategy = {
      caseCount: overall.caseCount,
      cleanCaseCount:
        overall.cleanCaseCount,
      reviewCaseCount:
        overall.reviewCaseCount,
      blockedCaseCount:
        overall.blockedCaseCount,
      hardViolationCount:
        overall.hardViolationCount,
      unexpectedButAllowedFileCount:
        overall
          .unexpectedButAllowedFileCount,
      missingExpectedFileCount:
        overall.missingExpectedFileCount,
      unnecessaryLoc:
        overall.unnecessaryLoc,
      uncertainLoc: overall.uncertainLoc,
      unrequestedRefactorCount:
        overall.unrequestedRefactorCount,
      newDependencyCount:
        overall.newDependencyCount,
      unrequestedDependencyCount:
        overall
          .unrequestedDependencyCount,
      unjustifiedDependencyCount:
        overall
          .unjustifiedDependencyCount,
      newAbstractionCount:
        overall.newAbstractionCount,
      unrequestedAbstractionCount:
        overall
          .unrequestedAbstractionCount,
      justifiedAbstractionCount:
        overall
          .justifiedAbstractionCount,
      abstractionJustificationRate:
        overall
          .abstractionJustificationRate,
      humanUnnecessaryLabelCount:
        overall
          .humanUnnecessaryLabelCount
    };

    const releaseClaimEligible =
      input.evidenceClass ===
        "observed_run";

    const material = {
      reportVersion: "1" as const,
      benchmarkId: input.benchmarkId,
      evidenceClass:
        input.evidenceClass,
      releaseClaimEligible,
      sourceInputHash:
        hashCanonicalJson(input),
      caseResults,
      strategyAggregates,
      overall: overallWithoutStrategy
    };
    const report:
      SoftScopeDriftBenchmarkReport = {
        ...material,
        reportHash:
          hashCanonicalJson(material)
      };

    return deepFreeze({
      decision:
        "soft_scope_drift_benchmark_ready",
      report,
      errors: [],
      summary: {
        inputValid: true,
        caseCount: caseResults.length,
        strategyCount:
          strategyAggregates.length,
        hardAndSoftSeparated: true,
        releaseClaimEligible,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  } catch (error) {
    const failure =
      error instanceof
        ScopeBenchmarkFailure
        ? error
        : new ScopeBenchmarkFailure(
            "soft_scope_benchmark_exception",
            "Soft-scope benchmark failed closed."
          );
    return deepFreeze({
      decision:
        "soft_scope_drift_benchmark_invalid",
      report: null,
      errors: [failure.code],
      summary: {
        inputValid: false,
        caseCount: 0,
        strategyCount: 0,
        hardAndSoftSeparated: false,
        releaseClaimEligible: false,
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      }
    });
  }
}

export function verifySoftScopeDriftBenchmarkReport(
  input: SoftScopeDriftBenchmarkInput,
  report: SoftScopeDriftBenchmarkReport
): VerifySoftScopeDriftBenchmarkReportResult {
  try {
    const rebuilt =
      buildSoftScopeDriftBenchmark(input);
    if (
      rebuilt.report === null ||
      !HASH.test(report.reportHash) ||
      report.reportHash !==
        hashCanonicalJson(
          reportCore(report)
        ) ||
      report.sourceInputHash !==
        rebuilt.report.sourceInputHash ||
      report.reportHash !==
        rebuilt.report.reportHash
    ) {
      return deepFreeze({
        decision:
          "soft_scope_drift_benchmark_report_invalid",
        reportIntegrityVerified: false,
        sourceInputMatched: false,
        releaseClaimEligible: false,
        errors: [
          "soft_scope_report_verification_mismatch"
        ],
        repositoryWritePerformed: false,
        shellExecuted: false,
        networkAccessed: false
      });
    }
    return deepFreeze({
      decision:
        "soft_scope_drift_benchmark_report_current",
      reportIntegrityVerified: true,
      sourceInputMatched: true,
      releaseClaimEligible:
        report.releaseClaimEligible,
      errors: [],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  } catch {
    return deepFreeze({
      decision:
        "soft_scope_drift_benchmark_report_invalid",
      reportIntegrityVerified: false,
      sourceInputMatched: false,
      releaseClaimEligible: false,
      errors: [
        "soft_scope_report_verification_exception"
      ],
      repositoryWritePerformed: false,
      shellExecuted: false,
      networkAccessed: false
    });
  }
}
