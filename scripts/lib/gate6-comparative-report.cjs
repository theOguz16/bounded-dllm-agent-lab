"use strict";

const { createHash } = require("node:crypto");

const REPORT_VERSION = "gate6-comparative-report/v1";
const OBSERVATION_VERSION = "gate6-comparative-observation/v1";
const MIN_REPETITIONS = 3;
const STRATEGIES = Object.freeze([
  "C_synthetic_context",
  "E_bounded_workspace_boundary",
  "F_adaptive_compressed_boundary",
  "CE_escalating_context"
]);
const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
const OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "taskId",
  "repositoryId",
  "taskClass",
  "difficulty",
  "strategy",
  "repetition",
  "fileScopeSuccess",
  "strictOracleSuccess",
  "exactSymbolSuccess",
  "symbolTruePositiveCount",
  "symbolPredictedCount",
  "symbolRequiredCount",
  "criticalImplementationCoveredCount",
  "criticalImplementationRequiredCount",
  "criticalTestAnchorCoveredCount",
  "criticalTestAnchorRequiredCount",
  "contextBytes",
  "tokens",
  "latencyMs",
  "scopeViolation",
  "authorityViolation",
  "endToEndAccepted",
  "testsPassed",
  "humanIntervention",
  "escalation"
]);
const ESCALATION_FIELDS = Object.freeze([
  "escalated",
  "incrementalContextBytes",
  "incrementalTokens",
  "incrementalLatencyMs"
]);

class Gate6ComparativeReportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6ComparativeReportError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6ComparativeReportError(code, detail);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function finiteNonNegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("GATE6_METRICS_NUMBER_INVALID", field);
  }
  return value;
}

function integerNonNegative(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail("GATE6_METRICS_INTEGER_INVALID", field);
  return value;
}

function nonEmptyText(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 512) {
    fail("GATE6_METRICS_TEXT_INVALID", field);
  }
  return value;
}

function bool(value, field) {
  if (typeof value !== "boolean") fail("GATE6_METRICS_BOOLEAN_INVALID", field);
  return value;
}

function validateObservation(value) {
  if (!sameKeys(value, OBSERVATION_FIELDS)) fail("GATE6_METRICS_OBSERVATION_INVALID");
  if (value.schemaVersion !== OBSERVATION_VERSION) {
    fail("GATE6_METRICS_OBSERVATION_SCHEMA_UNSUPPORTED", String(value.schemaVersion));
  }
  nonEmptyText(value.taskId, "taskId");
  nonEmptyText(value.repositoryId, "repositoryId");
  nonEmptyText(value.taskClass, "taskClass");
  if (!DIFFICULTIES.includes(value.difficulty)) fail("GATE6_METRICS_DIFFICULTY_INVALID", String(value.difficulty));
  if (!STRATEGIES.includes(value.strategy)) fail("GATE6_METRICS_STRATEGY_INVALID", String(value.strategy));
  if (!Number.isSafeInteger(value.repetition) || value.repetition < 1) {
    fail("GATE6_METRICS_REPETITION_INVALID", String(value.repetition));
  }

  bool(value.fileScopeSuccess, "fileScopeSuccess");
  bool(value.strictOracleSuccess, "strictOracleSuccess");
  bool(value.exactSymbolSuccess, "exactSymbolSuccess");
  integerNonNegative(value.symbolTruePositiveCount, "symbolTruePositiveCount");
  integerNonNegative(value.symbolPredictedCount, "symbolPredictedCount");
  integerNonNegative(value.symbolRequiredCount, "symbolRequiredCount");
  if (value.symbolTruePositiveCount > value.symbolPredictedCount || value.symbolTruePositiveCount > value.symbolRequiredCount) {
    fail("GATE6_METRICS_SYMBOL_COUNTS_INVALID", value.taskId);
  }

  integerNonNegative(value.criticalImplementationCoveredCount, "criticalImplementationCoveredCount");
  integerNonNegative(value.criticalImplementationRequiredCount, "criticalImplementationRequiredCount");
  integerNonNegative(value.criticalTestAnchorCoveredCount, "criticalTestAnchorCoveredCount");
  integerNonNegative(value.criticalTestAnchorRequiredCount, "criticalTestAnchorRequiredCount");
  if (value.criticalImplementationCoveredCount > value.criticalImplementationRequiredCount) {
    fail("GATE6_METRICS_CRITICAL_IMPLEMENTATION_COUNTS_INVALID", value.taskId);
  }
  if (value.criticalTestAnchorCoveredCount > value.criticalTestAnchorRequiredCount) {
    fail("GATE6_METRICS_CRITICAL_TEST_COUNTS_INVALID", value.taskId);
  }

  integerNonNegative(value.contextBytes, "contextBytes");
  finiteNonNegative(value.tokens, "tokens");
  finiteNonNegative(value.latencyMs, "latencyMs");
  bool(value.scopeViolation, "scopeViolation");
  bool(value.authorityViolation, "authorityViolation");
  bool(value.endToEndAccepted, "endToEndAccepted");
  bool(value.testsPassed, "testsPassed");
  bool(value.humanIntervention, "humanIntervention");

  if (value.strategy === "CE_escalating_context") {
    if (!sameKeys(value.escalation, ESCALATION_FIELDS)) fail("GATE6_METRICS_ESCALATION_INVALID", value.taskId);
    bool(value.escalation.escalated, "escalation.escalated");
    integerNonNegative(value.escalation.incrementalContextBytes, "escalation.incrementalContextBytes");
    finiteNonNegative(value.escalation.incrementalTokens, "escalation.incrementalTokens");
    finiteNonNegative(value.escalation.incrementalLatencyMs, "escalation.incrementalLatencyMs");
    if (!value.escalation.escalated && (
      value.escalation.incrementalContextBytes !== 0 ||
      value.escalation.incrementalTokens !== 0 ||
      value.escalation.incrementalLatencyMs !== 0
    )) {
      fail("GATE6_METRICS_NON_ESCALATED_COST_NONZERO", value.taskId);
    }
  } else if (value.escalation !== null) {
    fail("GATE6_METRICS_ESCALATION_FOR_NON_CE", value.taskId);
  }

  return value;
}

function sum(rows, selector) {
  let total = 0;
  for (const row of rows) total += selector(row);
  return total;
}

function mean(rows, selector) {
  return rows.length === 0 ? null : sum(rows, selector) / rows.length;
}

function rate(rows, selector) {
  return rows.length === 0 ? null : sum(rows, (row) => selector(row) ? 1 : 0) / rows.length;
}

function safeRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function harmonicF1(precision, recall) {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return 2 * precision * recall / (precision + recall);
}

function sampleCriticalImplementationCoverage(row) {
  return safeRatio(row.criticalImplementationCoveredCount, row.criticalImplementationRequiredCount);
}

function sampleCriticalTestAnchorCoverage(row) {
  return safeRatio(row.criticalTestAnchorCoveredCount, row.criticalTestAnchorRequiredCount);
}

function criticalComplete(row) {
  return row.criticalImplementationCoveredCount === row.criticalImplementationRequiredCount &&
    row.criticalTestAnchorCoveredCount === row.criticalTestAnchorRequiredCount;
}

function sampleSymbolPrecision(row) {
  return safeRatio(row.symbolTruePositiveCount, row.symbolPredictedCount);
}

function sampleSymbolRecall(row) {
  return safeRatio(row.symbolTruePositiveCount, row.symbolRequiredCount);
}

function sampleSymbolF1(row) {
  return harmonicF1(sampleSymbolPrecision(row), sampleSymbolRecall(row));
}

function aggregateBase(rows) {
  const strictSuccessCount = sum(rows, (row) => row.strictOracleSuccess ? 1 : 0);
  const acceptedCount = sum(rows, (row) => row.endToEndAccepted ? 1 : 0);
  const totalTokens = sum(rows, (row) => row.tokens);
  const totalContextBytes = sum(rows, (row) => row.contextBytes);
  const symbolTruePositiveCount = sum(rows, (row) => row.symbolTruePositiveCount);
  const symbolPredictedCount = sum(rows, (row) => row.symbolPredictedCount);
  const symbolRequiredCount = sum(rows, (row) => row.symbolRequiredCount);
  const symbolPrecision = safeRatio(symbolTruePositiveCount, symbolPredictedCount);
  const symbolRecall = safeRatio(symbolTruePositiveCount, symbolRequiredCount);
  const criticalImplementationCovered = sum(rows, (row) => row.criticalImplementationCoveredCount);
  const criticalImplementationRequired = sum(rows, (row) => row.criticalImplementationRequiredCount);
  const criticalTestAnchorCovered = sum(rows, (row) => row.criticalTestAnchorCoveredCount);
  const criticalTestAnchorRequired = sum(rows, (row) => row.criticalTestAnchorRequiredCount);

  return {
    sampleCount: rows.length,
    fileScopeSuccessRate: rate(rows, (row) => row.fileScopeSuccess),
    strictOracleSuccessRate: rate(rows, (row) => row.strictOracleSuccess),
    exactSymbolSuccessRate: rate(rows, (row) => row.exactSymbolSuccess),
    symbolPrecision,
    symbolRecall,
    symbolF1: harmonicF1(symbolPrecision, symbolRecall),
    criticalImplementationCoverage: safeRatio(criticalImplementationCovered, criticalImplementationRequired),
    criticalTestAnchorCoverage: safeRatio(criticalTestAnchorCovered, criticalTestAnchorRequired),
    criticalCoverageCompleteRate: rate(rows, criticalComplete),
    contextBytes: mean(rows, (row) => row.contextBytes),
    tokens: mean(rows, (row) => row.tokens),
    latency: mean(rows, (row) => row.latencyMs),
    scopeViolationRate: rate(rows, (row) => row.scopeViolation),
    authorityViolationRate: rate(rows, (row) => row.authorityViolation),
    endToEndAcceptanceRate: rate(rows, (row) => row.endToEndAccepted),
    testPassRate: rate(rows, (row) => row.testsPassed),
    humanInterventionRate: rate(rows, (row) => row.humanIntervention),
    tokensPerStrictSuccess: safeRatio(totalTokens, strictSuccessCount),
    contextBytesPerStrictSuccess: safeRatio(totalContextBytes, strictSuccessCount),
    tokensPerAcceptedCodingTask: safeRatio(totalTokens, acceptedCount),
    contextBytesPerAcceptedCodingTask: safeRatio(totalContextBytes, acceptedCount)
  };
}

function aggregateCE(rows) {
  const escalated = rows.filter((row) => row.escalation.escalated);
  const notEscalated = rows.filter((row) => !row.escalation.escalated);
  return {
    escalationRate: rate(rows, (row) => row.escalation.escalated),
    successfulWithoutEscalationRate: rate(notEscalated, (row) => row.endToEndAccepted),
    successfulAfterEscalationRate: rate(escalated, (row) => row.endToEndAccepted),
    averageEscalationCost: {
      contextBytes: mean(escalated, (row) => row.escalation.incrementalContextBytes),
      tokens: mean(escalated, (row) => row.escalation.incrementalTokens),
      latency: mean(escalated, (row) => row.escalation.incrementalLatencyMs)
    }
  };
}

function aggregate(rows, { includeCE = false } = {}) {
  const base = aggregateBase(rows);
  return includeCE ? { ...base, ...aggregateCE(rows) } : base;
}

function groupBy(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const key = selector(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function sortedObject(groups, mapper) {
  return Object.fromEntries([...groups.keys()].sort(compareText).map((key) => [key, mapper(groups.get(key), key)]));
}

function validateRepeatability(rows, minimumRepetitions) {
  if (!Number.isSafeInteger(minimumRepetitions) || minimumRepetitions < MIN_REPETITIONS) {
    fail("GATE6_METRICS_MIN_REPETITIONS_INVALID", String(minimumRepetitions));
  }
  const taskGroups = groupBy(rows, (row) => row.taskId);
  for (const [taskId, taskRows] of taskGroups) {
    const metadata = new Set(taskRows.map((row) => `${row.repositoryId}\0${row.taskClass}\0${row.difficulty}`));
    if (metadata.size !== 1) fail("GATE6_METRICS_TASK_METADATA_INCONSISTENT", taskId);
    const strategies = groupBy(taskRows, (row) => row.strategy);
    for (const strategy of STRATEGIES) {
      if (!strategies.has(strategy)) fail("GATE6_METRICS_STRATEGY_MISSING", `${taskId}:${strategy}`);
    }
    const referenceRepetitions = null;
    let expected = null;
    for (const strategy of STRATEGIES) {
      const strategyRows = strategies.get(strategy);
      const repetitions = strategyRows.map((row) => row.repetition).sort((a, b) => a - b);
      if (new Set(repetitions).size !== repetitions.length) {
        fail("GATE6_METRICS_DUPLICATE_REPETITION", `${taskId}:${strategy}`);
      }
      if (repetitions.length < minimumRepetitions) {
        fail("GATE6_METRICS_REPETITIONS_INSUFFICIENT", `${taskId}:${strategy}:${repetitions.length}`);
      }
      const serialized = JSON.stringify(repetitions);
      if (expected === null) expected = serialized;
      else if (serialized !== expected) fail("GATE6_METRICS_REPETITION_SET_MISMATCH", taskId);
    }
    void referenceRepetitions;
  }
}

function variance(values) {
  const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numeric.length < 2) return null;
  const average = numeric.reduce((total, value) => total + value, 0) / numeric.length;
  return numeric.reduce((total, value) => total + ((value - average) ** 2), 0) / (numeric.length - 1);
}

function booleanNumber(value) {
  return value ? 1 : 0;
}

function taskVariance(rows) {
  const byTaskStrategy = groupBy(rows, (row) => `${row.taskId}\0${row.strategy}`);
  return [...byTaskStrategy.entries()].map(([key, group]) => {
    const [taskId, strategy] = key.split("\0");
    const first = group[0];
    const ordered = [...group].sort((left, right) => left.repetition - right.repetition);
    return {
      taskId,
      repositoryId: first.repositoryId,
      taskClass: first.taskClass,
      difficulty: first.difficulty,
      strategy,
      repetitionCount: ordered.length,
      repetitions: ordered.map((row) => row.repetition),
      variance: {
        fileScopeSuccessRate: variance(ordered.map((row) => booleanNumber(row.fileScopeSuccess))),
        strictOracleSuccessRate: variance(ordered.map((row) => booleanNumber(row.strictOracleSuccess))),
        exactSymbolSuccessRate: variance(ordered.map((row) => booleanNumber(row.exactSymbolSuccess))),
        symbolPrecision: variance(ordered.map(sampleSymbolPrecision)),
        symbolRecall: variance(ordered.map(sampleSymbolRecall)),
        symbolF1: variance(ordered.map(sampleSymbolF1)),
        criticalImplementationCoverage: variance(ordered.map(sampleCriticalImplementationCoverage)),
        criticalTestAnchorCoverage: variance(ordered.map(sampleCriticalTestAnchorCoverage)),
        criticalCoverageCompleteRate: variance(ordered.map((row) => booleanNumber(criticalComplete(row)))),
        contextBytes: variance(ordered.map((row) => row.contextBytes)),
        tokens: variance(ordered.map((row) => row.tokens)),
        latency: variance(ordered.map((row) => row.latencyMs)),
        scopeViolationRate: variance(ordered.map((row) => booleanNumber(row.scopeViolation))),
        authorityViolationRate: variance(ordered.map((row) => booleanNumber(row.authorityViolation))),
        endToEndAcceptanceRate: variance(ordered.map((row) => booleanNumber(row.endToEndAccepted))),
        testPassRate: variance(ordered.map((row) => booleanNumber(row.testsPassed))),
        humanInterventionRate: variance(ordered.map((row) => booleanNumber(row.humanIntervention)))
      }
    };
  }).sort((left, right) => compareText(left.taskId, right.taskId) || compareText(left.strategy, right.strategy));
}

function createGate6ComparativeReport(observations, options = {}) {
  if (!Array.isArray(observations) || observations.length === 0) fail("GATE6_METRICS_OBSERVATIONS_INVALID");
  const minimumRepetitions = options.minimumRepetitions ?? MIN_REPETITIONS;
  const rows = observations.map((row) => validateObservation(row));
  validateRepeatability(rows, minimumRepetitions);

  const difficultyGroups = groupBy(rows, (row) => row.difficulty);
  const taskClassGroups = groupBy(rows, (row) => row.taskClass);
  const repositoryGroups = groupBy(rows, (row) => row.repositoryId);
  const strategyGroups = groupBy(rows, (row) => row.strategy);

  const aggregates = {
    overall: aggregate(rows),
    easy: aggregate(difficultyGroups.get("easy") ?? []),
    medium: aggregate(difficultyGroups.get("medium") ?? []),
    hard: aggregate(difficultyGroups.get("hard") ?? []),
    taskClass: sortedObject(taskClassGroups, (group) => aggregate(group)),
    repository: sortedObject(repositoryGroups, (group) => aggregate(group)),
    strategy: Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      aggregate(strategyGroups.get(strategy) ?? [], { includeCE: strategy === "CE_escalating_context" })
    ]))
  };

  const repeatability = {
    minimumRepetitions,
    varianceEstimator: "sample_unbiased_n_minus_1",
    taskStrategyPairCount: new Set(rows.map((row) => `${row.taskId}\0${row.strategy}`)).size,
    perTaskVariance: taskVariance(rows)
  };

  const metricSemantics = {
    contextBytes: "arithmetic_mean_per_sample",
    tokens: "arithmetic_mean_per_sample",
    latency: "arithmetic_mean_latency_ms_per_sample",
    symbolPrecision: "micro_true_positive_over_predicted",
    symbolRecall: "micro_true_positive_over_required",
    symbolF1: "harmonic_mean_of_micro_precision_and_recall",
    criticalImplementationCoverage: "micro_covered_over_required",
    criticalTestAnchorCoverage: "micro_covered_over_required",
    criticalCoverageCompleteRate: "fraction_of_samples_with_all_required_implementation_and_test_anchor_evidence_covered",
    costPerSuccess: "sum_cost_divided_by_success_count; null_when_success_count_is_zero",
    successfulWithoutEscalationRate: "accepted_fraction_among_non_escalated_CE_samples; null_when_none",
    successfulAfterEscalationRate: "accepted_fraction_among_escalated_CE_samples; null_when_none",
    averageEscalationCost: "mean_incremental_cost_among_escalated_CE_samples; each field null_when_none"
  };

  const hashPayload = {
    version: REPORT_VERSION,
    observationVersion: OBSERVATION_VERSION,
    strategies: STRATEGIES,
    metricSemantics,
    aggregates,
    repeatability
  };
  return deepFreeze({
    ...hashPayload,
    reportHash: hashCanonical(hashPayload)
  });
}

module.exports = {
  DIFFICULTIES,
  MIN_REPETITIONS,
  OBSERVATION_VERSION,
  REPORT_VERSION,
  STRATEGIES,
  Gate6ComparativeReportError,
  createGate6ComparativeReport,
  validateObservation
};
