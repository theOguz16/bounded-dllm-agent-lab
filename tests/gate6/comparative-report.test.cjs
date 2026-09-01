#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  MIN_REPETITIONS,
  OBSERVATION_VERSION,
  REPORT_VERSION,
  STRATEGIES,
  createGate6ComparativeReport
} = require("../../scripts/lib/gate6-comparative-report.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

function observation(overrides = {}) {
  const strategy = overrides.strategy ?? "C_synthetic_context";
  const escalated = overrides.escalated ?? false;
  return {
    schemaVersion: OBSERVATION_VERSION,
    taskId: overrides.taskId ?? "task.easy.alpha",
    repositoryId: overrides.repositoryId ?? "owner/repo-a@" + "a".repeat(40),
    taskClass: overrides.taskClass ?? "bugfix_with_regression",
    difficulty: overrides.difficulty ?? "easy",
    strategy,
    repetition: overrides.repetition ?? 1,
    fileScopeSuccess: overrides.fileScopeSuccess ?? true,
    strictOracleSuccess: overrides.strictOracleSuccess ?? true,
    exactSymbolSuccess: overrides.exactSymbolSuccess ?? true,
    symbolTruePositiveCount: overrides.symbolTruePositiveCount ?? 2,
    symbolPredictedCount: overrides.symbolPredictedCount ?? 2,
    symbolRequiredCount: overrides.symbolRequiredCount ?? 2,
    criticalImplementationCoveredCount: overrides.criticalImplementationCoveredCount ?? 1,
    criticalImplementationRequiredCount: overrides.criticalImplementationRequiredCount ?? 1,
    criticalTestAnchorCoveredCount: overrides.criticalTestAnchorCoveredCount ?? 1,
    criticalTestAnchorRequiredCount: overrides.criticalTestAnchorRequiredCount ?? 1,
    contextBytes: overrides.contextBytes ?? 1000,
    tokens: overrides.tokens ?? 250,
    latencyMs: overrides.latencyMs ?? 100,
    scopeViolation: overrides.scopeViolation ?? false,
    authorityViolation: overrides.authorityViolation ?? false,
    endToEndAccepted: overrides.endToEndAccepted ?? true,
    testsPassed: overrides.testsPassed ?? true,
    humanIntervention: overrides.humanIntervention ?? false,
    escalation: strategy === "CE_escalating_context" ? {
      escalated,
      incrementalContextBytes: escalated ? (overrides.incrementalContextBytes ?? 400) : 0,
      incrementalTokens: escalated ? (overrides.incrementalTokens ?? 80) : 0,
      incrementalLatencyMs: escalated ? (overrides.incrementalLatencyMs ?? 30) : 0
    } : null
  };
}

function matrixForTask(taskOverrides = {}, transform = (row) => row) {
  const rows = [];
  for (const strategy of STRATEGIES) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      rows.push(transform(observation({ ...taskOverrides, strategy, repetition }), strategy, repetition));
    }
  }
  return rows;
}

async function main() {
  await test("report emits all mandatory metrics and breakdowns", () => {
    const rows = [
      ...matrixForTask({ taskId: "task.easy.alpha", difficulty: "easy", repositoryId: "repo/a", taskClass: "bugfix_with_regression" }),
      ...matrixForTask({ taskId: "task.medium.beta", difficulty: "medium", repositoryId: "repo/b", taskClass: "cross_file_change" }),
      ...matrixForTask({ taskId: "task.hard.gamma", difficulty: "hard", repositoryId: "repo/c", taskClass: "api_contract_change" })
    ];
    const report = createGate6ComparativeReport(rows);
    assert.equal(report.version, REPORT_VERSION);
    assert.equal(report.observationVersion, OBSERVATION_VERSION);
    assert.equal(report.repeatability.minimumRepetitions, MIN_REPETITIONS);
    assert.equal(report.aggregates.overall.sampleCount, 36);
    assert.equal(report.aggregates.easy.sampleCount, 12);
    assert.equal(report.aggregates.medium.sampleCount, 12);
    assert.equal(report.aggregates.hard.sampleCount, 12);
    assert.deepEqual(Object.keys(report.aggregates.strategy), [...STRATEGIES]);
    assert.equal(report.aggregates.taskClass.bugfix_with_regression.sampleCount, 12);
    assert.equal(report.aggregates.repository["repo/a"].sampleCount, 12);

    const required = [
      "sampleCount", "fileScopeSuccessRate", "strictOracleSuccessRate", "exactSymbolSuccessRate",
      "symbolPrecision", "symbolRecall", "symbolF1", "criticalImplementationCoverage",
      "criticalTestAnchorCoverage", "criticalCoverageCompleteRate", "contextBytes", "tokens", "latency",
      "scopeViolationRate", "authorityViolationRate", "endToEndAcceptanceRate", "testPassRate",
      "humanInterventionRate", "tokensPerStrictSuccess", "contextBytesPerStrictSuccess",
      "tokensPerAcceptedCodingTask", "contextBytesPerAcceptedCodingTask"
    ];
    for (const field of required) assert.equal(Object.hasOwn(report.aggregates.overall, field), true, field);
    assert.match(report.reportHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(report), true);
  });

  await test("micro symbol and critical coverage metrics are mathematically correct", () => {
    const rows = matrixForTask({}, (row, strategy, repetition) => {
      if (strategy === "C_synthetic_context" && repetition === 1) {
        return {
          ...row,
          exactSymbolSuccess: false,
          symbolTruePositiveCount: 1,
          symbolPredictedCount: 2,
          symbolRequiredCount: 4,
          criticalImplementationCoveredCount: 1,
          criticalImplementationRequiredCount: 2,
          criticalTestAnchorCoveredCount: 0,
          criticalTestAnchorRequiredCount: 1
        };
      }
      return row;
    });
    const report = createGate6ComparativeReport(rows);
    const c = report.aggregates.strategy.C_synthetic_context;
    assert.equal(c.sampleCount, 3);
    assert.equal(c.exactSymbolSuccessRate, 2 / 3);
    assert.equal(c.symbolPrecision, 5 / 6);
    assert.equal(c.symbolRecall, 5 / 8);
    assert.equal(c.symbolF1, 2 * (5 / 6) * (5 / 8) / ((5 / 6) + (5 / 8)));
    assert.equal(c.criticalImplementationCoverage, 3 / 4);
    assert.equal(c.criticalTestAnchorCoverage, 2 / 3);
    assert.equal(c.criticalCoverageCompleteRate, 2 / 3);
  });

  await test("cost per success is null when success count is zero", () => {
    const rows = matrixForTask({}, (row, strategy) => strategy === "F_adaptive_compressed_boundary"
      ? { ...row, strictOracleSuccess: false, endToEndAccepted: false, testsPassed: false }
      : row);
    const report = createGate6ComparativeReport(rows);
    const f = report.aggregates.strategy.F_adaptive_compressed_boundary;
    assert.equal(f.strictOracleSuccessRate, 0);
    assert.equal(f.endToEndAcceptanceRate, 0);
    assert.equal(f.tokensPerStrictSuccess, null);
    assert.equal(f.contextBytesPerStrictSuccess, null);
    assert.equal(f.tokensPerAcceptedCodingTask, null);
    assert.equal(f.contextBytesPerAcceptedCodingTask, null);
  });

  await test("CE reports escalation rates and incremental escalation cost", () => {
    const rows = matrixForTask({}, (row, strategy, repetition) => {
      if (strategy !== "CE_escalating_context") return row;
      if (repetition === 1) return observation({ ...row, strategy, repetition, escalated: false, endToEndAccepted: true });
      if (repetition === 2) return observation({ ...row, strategy, repetition, escalated: true, endToEndAccepted: true, incrementalContextBytes: 300, incrementalTokens: 60, incrementalLatencyMs: 20 });
      return observation({ ...row, strategy, repetition, escalated: true, endToEndAccepted: false, incrementalContextBytes: 500, incrementalTokens: 100, incrementalLatencyMs: 40 });
    });
    const report = createGate6ComparativeReport(rows);
    const ce = report.aggregates.strategy.CE_escalating_context;
    assert.equal(ce.escalationRate, 2 / 3);
    assert.equal(ce.successfulWithoutEscalationRate, 1);
    assert.equal(ce.successfulAfterEscalationRate, 1 / 2);
    assert.deepEqual(ce.averageEscalationCost, { contextBytes: 400, tokens: 80, latency: 30 });
  });

  await test("minimum three aligned repetitions are mandatory", () => {
    const insufficient = matrixForTask().filter((row) => !(row.strategy === "C_synthetic_context" && row.repetition === 3));
    assert.throws(() => createGate6ComparativeReport(insufficient), /GATE6_METRICS_REPETITIONS_INSUFFICIENT/);

    const mismatch = matrixForTask().map((row) => row.strategy === "E_bounded_workspace_boundary" && row.repetition === 3
      ? { ...row, repetition: 4 }
      : row);
    assert.throws(() => createGate6ComparativeReport(mismatch), /GATE6_METRICS_REPETITION_SET_MISMATCH/);
  });

  await test("per-task variance is reported for every task and strategy", () => {
    const rows = matrixForTask({}, (row, strategy, repetition) => strategy === "C_synthetic_context"
      ? { ...row, strictOracleSuccess: repetition !== 2, tokens: 100 * repetition, contextBytes: 1000 * repetition }
      : row);
    const report = createGate6ComparativeReport(rows);
    assert.equal(report.repeatability.taskStrategyPairCount, 4);
    assert.equal(report.repeatability.perTaskVariance.length, 4);
    const c = report.repeatability.perTaskVariance.find((entry) => entry.strategy === "C_synthetic_context");
    assert.deepEqual(c.repetitions, [1, 2, 3]);
    assert.equal(c.variance.strictOracleSuccessRate, 1 / 3);
    assert.equal(c.variance.tokens, 10000);
    assert.equal(c.variance.contextBytes, 1000000);
  });

  await test("invalid escalation accounting fails closed", () => {
    const rows = matrixForTask();
    rows[9] = {
      ...rows[9],
      escalation: { escalated: false, incrementalContextBytes: 1, incrementalTokens: 0, incrementalLatencyMs: 0 }
    };
    assert.throws(() => createGate6ComparativeReport(rows), /GATE6_METRICS_NON_ESCALATED_COST_NONZERO/);
  });

  process.stdout.write("Gate 6 comparative report PASS\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
