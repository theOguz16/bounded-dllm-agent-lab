#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const REPORT_VERSION = "product-dogfood-report/v1";
const LIVE_RUN_VERSION = "product-dogfood-live-run/v1";
const COMPARISON_EVALUATION_VERSION = "product-comparison-evaluation/v1";
const FAILURE_TAXONOMY = Object.freeze([
  "agent_wrong_file",
  "agent_bad_change",
  "agent_incomplete_change",
  "agent_protocol_failure",
  "runtime_scope_block",
  "runtime_policy_block",
  "runtime_validation_failure",
  "runtime_recovery_required",
  "insufficient_context",
  "task_unsupported",
  "human_rejected"
]);
const FAILURE_TAXONOMY_SET = new Set(FAILURE_TAXONOMY);

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function parseArgs(argv) {
  const args = {
    input: null,
    outputDir: path.join(repoRoot, "reports/product-v1"),
    selfTest: false
  };
  for (const arg of argv) {
    if (arg === "--self-test") {
      args.selfTest = true;
    } else if (arg.startsWith("--input=")) {
      args.input = path.resolve(arg.slice("--input=".length));
    } else if (arg.startsWith("--output-dir=")) {
      args.outputDir = path.resolve(arg.slice("--output-dir=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.selfTest && args.input === null) {
    throw new Error("dogfood report requires --input=<product-dogfood-v1-live.json>");
  }
  return args;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isObject(value)) throw new TypeError(`${field} must be an object.`);
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableBoolean(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  throw new TypeError(`${field} must be boolean or null.`);
}

function nullableNumber(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new TypeError(`${field} must be a finite non-negative number or null.`);
}

function requireLiveRun(value) {
  const live = requireObject(value, "live dogfood evidence");
  if (live.schemaVersion !== LIVE_RUN_VERSION) {
    throw new TypeError(`live dogfood evidence schemaVersion must be ${LIVE_RUN_VERSION}.`);
  }
  if (typeof live.suiteId !== "string" || live.suiteId.length === 0) {
    throw new TypeError("live dogfood evidence suiteId must be a non-empty string.");
  }
  if (!Array.isArray(live.results)) {
    throw new TypeError("live dogfood evidence results must be an array.");
  }
  if (live.retryPolicy !== "none") {
    throw new TypeError('retryPolicy must be exactly "none".');
  }
  if (live.promptMutationAfterFailure !== false) {
    throw new TypeError("promptMutationAfterFailure must be false.");
  }
  if (live.hiddenHintInjection !== false) {
    throw new TypeError("hiddenHintInjection must be false.");
  }
  const taskCount = requireNonNegativeInteger(live.taskCount, "taskCount");
  const completedPairCount = requireNonNegativeInteger(live.completedPairCount, "completedPairCount");
  const expectedAgentRuns = requireNonNegativeInteger(live.expectedAgentRuns, "expectedAgentRuns");
  const completedAgentRuns = requireNonNegativeInteger(live.completedAgentRuns, "completedAgentRuns");
  if (live.completedAgentPairs !== undefined) {
    const completedAgentPairs = requireNonNegativeInteger(live.completedAgentPairs, "completedAgentPairs");
    if (completedAgentPairs !== completedPairCount) {
      throw new TypeError("completedAgentPairs must equal completedPairCount when present.");
    }
  }
  if (taskCount !== live.results.length) throw new TypeError("taskCount must equal results.length.");
  if (expectedAgentRuns !== taskCount * 2) throw new TypeError("expectedAgentRuns must equal taskCount * 2.");
  if (completedAgentRuns !== completedPairCount * 2) {
    throw new TypeError("completedAgentRuns must equal completedPairCount * 2.");
  }

  const ids = new Set();
  let observedCompletedPairs = 0;
  for (const [index, entryValue] of live.results.entries()) {
    const entry = requireObject(entryValue, `results[${index}]`);
    if (typeof entry.taskId !== "string" || entry.taskId.length === 0) {
      throw new TypeError(`results[${index}].taskId must be a non-empty string.`);
    }
    if (ids.has(entry.taskId)) throw new TypeError(`duplicate taskId: ${entry.taskId}`);
    ids.add(entry.taskId);
    if (entry.attempt !== 1 || entry.retryCount !== 0) {
      throw new TypeError(`results[${index}] must preserve the one-attempt/no-retry dogfood contract.`);
    }
    if (entry.hiddenHintsInjected !== false || entry.promptMutatedAfterFailure !== false) {
      throw new TypeError(`results[${index}] violates the frozen prompt/evaluator boundary.`);
    }
    if (typeof entry.pairCompleted !== "boolean") {
      throw new TypeError(`results[${index}].pairCompleted must be boolean.`);
    }
    if (entry.pairCompleted) {
      observedCompletedPairs += 1;
      if (entry.failure !== null) {
        throw new TypeError(`completed results[${index}] must have failure === null.`);
      }
      const comparison = requireObject(entry.result, `results[${index}].result`);
      if (comparison.comparable !== true) {
        throw new TypeError(`completed results[${index}] must be comparable.`);
      }
      if (!Array.isArray(comparison.identityMismatchFields) || comparison.identityMismatchFields.length !== 0) {
        throw new TypeError(`completed results[${index}].result.identityMismatchFields must be exactly [].`);
      }
      const evaluations = requireObject(comparison.evaluations, `results[${index}].result.evaluations`);
      for (const arm of ["normal", "bounded"]) {
        const evaluation = requireObject(evaluations[arm], `results[${index}].result.evaluations.${arm}`);
        if (evaluation.schemaVersion !== COMPARISON_EVALUATION_VERSION) {
          throw new TypeError(`results[${index}] ${arm} evaluation schema is invalid.`);
        }
        requireObject(evaluation.correctness, `results[${index}] ${arm}.correctness`);
        requireObject(evaluation.control, `results[${index}] ${arm}.control`);
        requireObject(evaluation.efficiency, `results[${index}] ${arm}.efficiency`);
        requireObject(comparison[arm], `results[${index}].result.${arm}`);
      }
    }
  }
  if (completedPairCount !== observedCompletedPairs) {
    throw new TypeError("completedPairCount does not match completed task records.");
  }
  return live;
}

function humanDecision(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["accept", "accepted", "approve", "approved", "apply", "applied"].includes(normalized)) return true;
  if (["reject", "rejected", "deny", "denied", "decline", "declined"].includes(normalized)) return false;
  return null;
}

function firstHumanDecision(...values) {
  for (const value of values) {
    const decision = humanDecision(value);
    if (decision !== null) return decision;
  }
  return null;
}

function observationForArm(taskRecord, arm) {
  const comparison = isObject(taskRecord.result) ? taskRecord.result : null;
  if (comparison === null || !isObject(comparison.evaluations) || !isObject(comparison.evaluations[arm])) {
    return Object.freeze({
      taskId: taskRecord.taskId,
      arm,
      taskSucceeded: null,
      controlPassed: null,
      behaviorSatisfied: null,
      testsPassed: null,
      buildPassed: null,
      typecheckPassed: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      exposedFiles: null,
      exposedBytes: null,
      durationMs: null,
      scopeViolationCount: null,
      forbiddenTouchCount: null,
      unsupportedMutationCount: null,
      changedFiles: null,
      humanAccepted: null
    });
  }

  const evaluation = comparison.evaluations[arm];
  const correctness = requireObject(evaluation.correctness, `${taskRecord.taskId}.${arm}.correctness`);
  const control = requireObject(evaluation.control, `${taskRecord.taskId}.${arm}.control`);
  const efficiency = requireObject(evaluation.efficiency, `${taskRecord.taskId}.${arm}.efficiency`);
  const display = requireObject(comparison[arm], `${taskRecord.taskId}.${arm}.display`);
  const humanAcceptance = isObject(comparison.humanAcceptance) ? comparison.humanAcceptance : {};
  const humanLabels = isObject(comparison.humanLabels) ? comparison.humanLabels : {};
  const taskHumanAcceptance = isObject(taskRecord.humanAcceptance) ? taskRecord.humanAcceptance : {};
  const taskHumanLabels = isObject(taskRecord.humanLabels) ? taskRecord.humanLabels : {};

  return Object.freeze({
    taskId: taskRecord.taskId,
    arm,
    taskSucceeded: nullableBoolean(correctness.taskSucceeded, `${taskRecord.taskId}.${arm}.taskSucceeded`),
    controlPassed: nullableBoolean(correctness.controlPassed, `${taskRecord.taskId}.${arm}.controlPassed`),
    behaviorSatisfied: nullableBoolean(correctness.behaviorSatisfied, `${taskRecord.taskId}.${arm}.behaviorSatisfied`),
    testsPassed: nullableBoolean(correctness.testsPassed, `${taskRecord.taskId}.${arm}.testsPassed`),
    buildPassed: nullableBoolean(correctness.buildPassed, `${taskRecord.taskId}.${arm}.buildPassed`),
    typecheckPassed: nullableBoolean(correctness.typecheckPassed, `${taskRecord.taskId}.${arm}.typecheckPassed`),
    inputTokens: nullableNumber(efficiency.inputTokens, `${taskRecord.taskId}.${arm}.inputTokens`),
    outputTokens: nullableNumber(efficiency.outputTokens, `${taskRecord.taskId}.${arm}.outputTokens`),
    totalTokens: nullableNumber(efficiency.totalTokens, `${taskRecord.taskId}.${arm}.totalTokens`),
    exposedFiles: nullableNumber(efficiency.exposedFiles, `${taskRecord.taskId}.${arm}.exposedFiles`),
    exposedBytes: nullableNumber(efficiency.exposedBytes, `${taskRecord.taskId}.${arm}.exposedBytes`),
    durationMs: nullableNumber(efficiency.durationMs, `${taskRecord.taskId}.${arm}.durationMs`),
    scopeViolationCount: nullableNumber(control.scopeViolationCount, `${taskRecord.taskId}.${arm}.scopeViolationCount`),
    forbiddenTouchCount: nullableNumber(control.forbiddenTouchCount, `${taskRecord.taskId}.${arm}.forbiddenTouchCount`),
    unsupportedMutationCount: nullableNumber(control.unsupportedMutationCount, `${taskRecord.taskId}.${arm}.unsupportedMutationCount`),
    changedFiles: nullableNumber(display.changedFiles, `${taskRecord.taskId}.${arm}.changedFiles`),
    humanAccepted: firstHumanDecision(
      display.humanAccepted,
      display.humanAcceptance,
      display.humanDecision,
      humanAcceptance[arm],
      humanLabels[arm],
      taskHumanAcceptance[arm],
      taskHumanLabels[arm]
    )
  });
}

function booleanSummary(values) {
  const observed = values.filter((value) => typeof value === "boolean");
  const passed = observed.filter(Boolean).length;
  return Object.freeze({
    observed: observed.length,
    passed,
    failed: observed.length - passed,
    rate: observed.length === 0 ? null : passed / observed.length
  });
}

function numericSummary(values) {
  const observed = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (observed.length === 0) return Object.freeze({ observed: 0, median: null, total: null });
  const sorted = [...observed].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Object.freeze({
    observed: observed.length,
    median,
    total: observed.reduce((sum, value) => sum + value, 0)
  });
}

function armAggregate(observations) {
  const scopeCounts = observations.map((entry) => entry.scopeViolationCount);
  const observedScope = scopeCounts.filter((value) => typeof value === "number");
  const runsWithViolation = observedScope.filter((value) => value > 0).length;
  return Object.freeze({
    success: booleanSummary(observations.map((entry) => entry.taskSucceeded)),
    control: booleanSummary(observations.map((entry) => entry.controlPassed)),
    behavior: booleanSummary(observations.map((entry) => entry.behaviorSatisfied)),
    tokens: Object.freeze({
      input: numericSummary(observations.map((entry) => entry.inputTokens)),
      output: numericSummary(observations.map((entry) => entry.outputTokens)),
      total: numericSummary(observations.map((entry) => entry.totalTokens))
    }),
    context: Object.freeze({
      exposedFiles: numericSummary(observations.map((entry) => entry.exposedFiles)),
      exposedBytes: numericSummary(observations.map((entry) => entry.exposedBytes))
    }),
    scope: Object.freeze({
      observed: observedScope.length,
      runsWithViolation,
      violationRate: observedScope.length === 0 ? null : runsWithViolation / observedScope.length,
      violationCount: numericSummary(scopeCounts),
      forbiddenTouchCount: numericSummary(observations.map((entry) => entry.forbiddenTouchCount)),
      unsupportedMutationCount: numericSummary(observations.map((entry) => entry.unsupportedMutationCount))
    }),
    duration: numericSummary(observations.map((entry) => entry.durationMs)),
    humanAcceptance: booleanSummary(observations.map((entry) => entry.humanAccepted))
  });
}

function failureCodeCategory(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (FAILURE_TAXONOMY_SET.has(code)) return code;
  if (/protocol|jsonl|malformed_event|event_parser/.test(code)) return "agent_protocol_failure";
  if (/scope.*block|scope_violation|outside.*scope|mutation.*scope/.test(code)) return "runtime_scope_block";
  if (/policy|forbidden|sandbox|isolation|network.*denied|network.*disabled/.test(code)) return "runtime_policy_block";
  if (/validation|typecheck|build_failed|test_failed/.test(code)) return "runtime_validation_failure";
  if (/recovery|resume|provider_outcome_ambiguous|ambiguous_provider/.test(code)) return "runtime_recovery_required";
  if (/insufficient.*context|context.*insufficient|missing.*context|scope_discovery/.test(code)) return "insufficient_context";
  if (/unsupported|not_supported/.test(code)) return "task_unsupported";
  return null;
}

function failureCodeFromRecord(record) {
  if (!isObject(record.failure)) return null;
  for (const candidate of [record.failure.code, record.failure.failureCode, record.failure.errorCode]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function createFailureTaxonomy(records, observationsByArm) {
  const buckets = Object.fromEntries(
    FAILURE_TAXONOMY.map((category) => [category, { count: 0, occurrences: [] }])
  );
  const unclassified = { count: 0, occurrences: [] };

  function add(category, taskId, arm, evidence) {
    const target = category && buckets[category] ? buckets[category] : unclassified;
    target.count += 1;
    target.occurrences.push(Object.freeze({ taskId, arm, evidence }));
  }

  for (const record of records) {
    if (!record.pairCompleted) {
      const code = failureCodeFromRecord(record);
      add(failureCodeCategory(code), record.taskId, "pair", code || "pair_incomplete_without_safe_failure_code");
    }
  }

  for (const arm of ["normal", "bounded"]) {
    for (const observation of observationsByArm[arm]) {
      if (observation.taskSucceeded === true && observation.humanAccepted !== false) continue;
      const categories = new Set();
      if (observation.humanAccepted === false) categories.add("human_rejected");
      const scopeEvidence = [
        observation.scopeViolationCount,
        observation.forbiddenTouchCount,
        observation.unsupportedMutationCount
      ].some((value) => typeof value === "number" && value > 0);
      if (scopeEvidence) categories.add("agent_wrong_file");
      if (observation.behaviorSatisfied === false) {
        if (observation.changedFiles === 0) categories.add("agent_incomplete_change");
        else if (!scopeEvidence) categories.add("agent_bad_change");
      } else if (observation.taskSucceeded === false && observation.changedFiles === 0) {
        categories.add("agent_incomplete_change");
      }
      if (categories.size === 0 && observation.taskSucceeded === false) {
        add(null, observation.taskId, arm, "task_failed_without_classifiable_observed_evidence");
        continue;
      }
      for (const category of categories) {
        let evidence = "observed_failure";
        if (category === "human_rejected") evidence = "human_acceptance=false";
        else if (category === "agent_wrong_file") evidence = "scope_or_forbidden_mutation_count>0";
        else if (category === "agent_incomplete_change") evidence = "behavior_failed_with_zero_changed_files";
        else if (category === "agent_bad_change") evidence = "behavior_failed_after_one_or_more_changes";
        add(category, observation.taskId, arm, evidence);
      }
    }
  }

  return Object.freeze({
    categories: Object.freeze(Object.fromEntries(
      FAILURE_TAXONOMY.map((category) => [
        category,
        Object.freeze({
          count: buckets[category].count,
          occurrences: Object.freeze([...buckets[category].occurrences])
        })
      ])
    )),
    unclassified: Object.freeze({
      count: unclassified.count,
      occurrences: Object.freeze([...unclassified.occurrences])
    })
  });
}

function buildDogfoodReport(value, sourceHash) {
  const live = requireLiveRun(value);
  const observationsByArm = {
    normal: live.results.map((record) => observationForArm(record, "normal")),
    bounded: live.results.map((record) => observationForArm(record, "bounded"))
  };
  const normal = armAggregate(observationsByArm.normal);
  const bounded = armAggregate(observationsByArm.bounded);
  const pairSuccessValues = live.results.map((record, index) => {
    if (!record.pairCompleted) return null;
    const normalSuccess = observationsByArm.normal[index].taskSucceeded;
    const boundedSuccess = observationsByArm.bounded[index].taskSucceeded;
    if (normalSuccess === null || boundedSuccess === null) return null;
    return normalSuccess && boundedSuccess;
  });
  const comparablePairCount = live.results.filter(
    (record) => record.pairCompleted && isObject(record.result) && record.result.comparable === true
  ).length;

  return Object.freeze({
    schemaVersion: REPORT_VERSION,
    source: Object.freeze({
      schemaVersion: live.schemaVersion,
      suiteId: live.suiteId,
      evidenceSha256: sourceHash,
      startedAt: live.startedAt ?? null,
      completedAt: live.completedAt ?? null,
      model: live.model ?? null,
      reasoningEffort: live.reasoningEffort ?? null
    }),
    overallSuccess: Object.freeze({
      taskCount: live.taskCount,
      completedPairCount: live.completedPairCount,
      comparablePairCount,
      completionRate: live.taskCount === 0 ? null : live.completedPairCount / live.taskCount,
      fullSuiteCompleted: live.completedPairCount === live.taskCount,
      pair: booleanSummary(pairSuccessValues),
      normal: normal.success,
      bounded: bounded.success
    }),
    control: Object.freeze({ normal: normal.control, bounded: bounded.control }),
    behavior: Object.freeze({ normal: normal.behavior, bounded: bounded.behavior }),
    tokens: Object.freeze({ normal: normal.tokens, bounded: bounded.tokens }),
    context: Object.freeze({ normal: normal.context, bounded: bounded.context }),
    scope: Object.freeze({ normal: normal.scope, bounded: bounded.scope }),
    duration: Object.freeze({ normal: normal.duration, bounded: bounded.duration }),
    humanAcceptance: Object.freeze({ normal: normal.humanAcceptance, bounded: bounded.humanAcceptance }),
    failureTaxonomy: createFailureTaxonomy(live.results, observationsByArm)
  });
}

function pct(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function number(value) {
  return value === null ? "N/A" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function bytes(value) {
  if (value === null) return "N/A";
  if (Math.abs(value) < 1024) return `${number(value)} B`;
  if (Math.abs(value) < 1024 * 1024) return `${number(value / 1024)} KB`;
  return `${number(value / (1024 * 1024))} MB`;
}

function duration(value) {
  if (value === null) return "N/A";
  if (value < 1000) return `${number(value)} ms`;
  return `${number(value / 1000)} s`;
}

function statusTable(section) {
  return [
    "| Arm | Observed | Passed | Failed | Rate |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...["normal", "bounded"].map((arm) => {
      const row = section[arm];
      return `| ${arm === "normal" ? "Normal" : "Bounded"} | ${row.observed} | ${row.passed} | ${row.failed} | ${pct(row.rate)} |`;
    })
  ].join("\n");
}

function renderMarkdown(report) {
  const taxonomyRows = FAILURE_TAXONOMY.map(
    (category) => `| ${category} | ${report.failureTaxonomy.categories[category].count} |`
  );
  taxonomyRows.push(`| unclassified | ${report.failureTaxonomy.unclassified.count} |`);
  const occurrenceLines = [];
  for (const category of FAILURE_TAXONOMY) {
    for (const occurrence of report.failureTaxonomy.categories[category].occurrences) {
      occurrenceLines.push(`- \`${category}\` — ${occurrence.taskId} / ${occurrence.arm}: ${occurrence.evidence}`);
    }
  }
  for (const occurrence of report.failureTaxonomy.unclassified.occurrences) {
    occurrenceLines.push(`- \`unclassified\` — ${occurrence.taskId} / ${occurrence.arm}: ${occurrence.evidence}`);
  }

  return `${[
    "# Product V1 Dogfood Report",
    "",
    `- Suite: \`${report.source.suiteId}\``,
    `- Evidence: \`${report.source.evidenceSha256}\``,
    `- Model: ${report.source.model ?? "N/A"}`,
    `- Reasoning: ${report.source.reasoningEffort ?? "N/A"}`,
    "",
    "## Overall success",
    "",
    `- Completed pairs: ${report.overallSuccess.completedPairCount}/${report.overallSuccess.taskCount} (${pct(report.overallSuccess.completionRate)})`,
    `- Comparable pairs: ${report.overallSuccess.comparablePairCount}/${report.overallSuccess.taskCount}`,
    `- Full suite completed: ${report.overallSuccess.fullSuiteCompleted ? "YES" : "NO"}`,
    `- Pair success: ${report.overallSuccess.pair.passed}/${report.overallSuccess.pair.observed} (${pct(report.overallSuccess.pair.rate)})`,
    "",
    statusTable({ normal: report.overallSuccess.normal, bounded: report.overallSuccess.bounded }),
    "",
    "## Control",
    "",
    statusTable(report.control),
    "",
    "## Behavior",
    "",
    statusTable(report.behavior),
    "",
    "## Tokens",
    "",
    "| Metric | Normal | Bounded |",
    "| --- | ---: | ---: |",
    `| Median input tokens | ${number(report.tokens.normal.input.median)} | ${number(report.tokens.bounded.input.median)} |`,
    `| Median output tokens | ${number(report.tokens.normal.output.median)} | ${number(report.tokens.bounded.output.median)} |`,
    `| Median total tokens | ${number(report.tokens.normal.total.median)} | ${number(report.tokens.bounded.total.median)} |`,
    `| Total observed tokens | ${number(report.tokens.normal.total.total)} | ${number(report.tokens.bounded.total.total)} |`,
    "",
    "## Context",
    "",
    "| Metric | Normal | Bounded |",
    "| --- | ---: | ---: |",
    `| Median exposed files | ${number(report.context.normal.exposedFiles.median)} | ${number(report.context.bounded.exposedFiles.median)} |`,
    `| Median exposed bytes | ${bytes(report.context.normal.exposedBytes.median)} | ${bytes(report.context.bounded.exposedBytes.median)} |`,
    "",
    "## Scope",
    "",
    "| Metric | Normal | Bounded |",
    "| --- | ---: | ---: |",
    `| Runs with scope violation | ${report.scope.normal.runsWithViolation}/${report.scope.normal.observed} | ${report.scope.bounded.runsWithViolation}/${report.scope.bounded.observed} |`,
    `| Scope violation rate | ${pct(report.scope.normal.violationRate)} | ${pct(report.scope.bounded.violationRate)} |`,
    `| Total scope violations | ${number(report.scope.normal.violationCount.total)} | ${number(report.scope.bounded.violationCount.total)} |`,
    `| Total forbidden touches | ${number(report.scope.normal.forbiddenTouchCount.total)} | ${number(report.scope.bounded.forbiddenTouchCount.total)} |`,
    `| Total unsupported mutations | ${number(report.scope.normal.unsupportedMutationCount.total)} | ${number(report.scope.bounded.unsupportedMutationCount.total)} |`,
    "",
    "## Duration",
    "",
    "| Metric | Normal | Bounded |",
    "| --- | ---: | ---: |",
    `| Median duration | ${duration(report.duration.normal.median)} | ${duration(report.duration.bounded.median)} |`,
    `| Total observed duration | ${duration(report.duration.normal.total)} | ${duration(report.duration.bounded.total)} |`,
    "",
    "## Human acceptance",
    "",
    statusTable(report.humanAcceptance),
    "",
    "Missing human labels remain N/A and are never imputed as rejection.",
    "",
    "## Failure taxonomy",
    "",
    "| Category | Count |",
    "| --- | ---: |",
    ...taxonomyRows,
    "",
    ...(occurrenceLines.length === 0 ? ["No classified failure occurrences."] : occurrenceLines),
    ""
  ].join("\n")}\n`;
}

function writeReport(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "dogfood-report.json");
  const markdownPath = path.join(outputDir, "dogfood-report.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderMarkdown(report), { mode: 0o600 });
  return { jsonPath, markdownPath };
}

function syntheticEvaluation({ success, control = true, behavior = true, changedFiles = 1, scope = 0 }) {
  return {
    schemaVersion: COMPARISON_EVALUATION_VERSION,
    correctness: {
      controlPassed: control,
      behaviorSatisfied: behavior,
      taskSucceeded: success,
      testsPassed: behavior,
      buildPassed: true,
      typecheckPassed: true
    },
    control: {
      scopeViolationCount: scope,
      forbiddenTouchCount: 0,
      unsupportedMutationCount: 0,
      unnecessaryChangedFileCount: null
    },
    efficiency: {
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      reasoningTokens: null,
      totalTokens: 120,
      exposedFiles: 4,
      exposedBytes: 2000,
      commandCount: 2,
      failedCommandCount: behavior ? 0 : 1,
      repairRounds: 0,
      durationMs: 500
    },
    __changedFiles: changedFiles
  };
}

function syntheticComparison(normalSpec, boundedSpec, humanAcceptance) {
  const normal = syntheticEvaluation(normalSpec);
  const bounded = syntheticEvaluation(boundedSpec);
  const normalChangedFiles = normal.__changedFiles;
  const boundedChangedFiles = bounded.__changedFiles;
  delete normal.__changedFiles;
  delete bounded.__changedFiles;
  return {
    comparable: true,
    identityMismatchFields: [],
    evaluations: { normal, bounded },
    normal: { changedFiles: normalChangedFiles },
    bounded: { changedFiles: boundedChangedFiles },
    ...(humanAcceptance === undefined ? {} : { humanAcceptance })
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectRejected(evidence, mutate) {
  const candidate = clone(evidence);
  mutate(candidate);
  assert.throws(() => buildDogfoodReport(candidate, sha256(JSON.stringify(candidate))));
}

function selfTest() {
  const results = [
    {
      taskId: "task.success",
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: true,
      result: syntheticComparison({ success: true }, { success: true }),
      failure: null
    },
    {
      taskId: "task.bad-and-wrong",
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: true,
      result: syntheticComparison(
        { success: false, behavior: false, changedFiles: 1 },
        { success: false, control: false, behavior: false, changedFiles: 1, scope: 1 },
        { bounded: false }
      ),
      failure: null
    },
    {
      taskId: "task.incomplete",
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: true,
      result: syntheticComparison(
        { success: false, behavior: false, changedFiles: 0 },
        { success: true }
      ),
      failure: null
    },
    {
      taskId: "task.context-failure",
      attempt: 1,
      retryCount: 0,
      hiddenHintsInjected: false,
      promptMutatedAfterFailure: false,
      pairCompleted: false,
      result: null,
      failure: { code: "insufficient_context" }
    }
  ];
  const evidence = {
    schemaVersion: LIVE_RUN_VERSION,
    suiteId: "self-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    model: "self-test-model",
    reasoningEffort: "medium",
    taskCount: 4,
    completedPairCount: 3,
    expectedAgentRuns: 8,
    completedAgentRuns: 6,
    completedAgentPairs: 3,
    retryPolicy: "none",
    promptMutationAfterFailure: false,
    hiddenHintInjection: false,
    results
  };
  const raw = JSON.stringify(evidence);
  const report = buildDogfoodReport(evidence, sha256(raw));
  assert.equal(report.overallSuccess.completedPairCount, 3);
  assert.equal(report.failureTaxonomy.categories.agent_bad_change.count, 1);
  assert.equal(report.failureTaxonomy.categories.agent_wrong_file.count, 1);
  assert.equal(report.failureTaxonomy.categories.agent_incomplete_change.count, 1);
  assert.equal(report.failureTaxonomy.categories.human_rejected.count, 1);
  assert.equal(report.failureTaxonomy.categories.insufficient_context.count, 1);
  assert.equal(report.humanAcceptance.bounded.observed, 1);
  assert.equal(report.humanAcceptance.bounded.passed, 0);
  for (const category of FAILURE_TAXONOMY) {
    assert.equal(Object.hasOwn(report.failureTaxonomy.categories, category), true);
  }
  const markdown = renderMarkdown(report);
  for (const heading of ["Overall success", "Control", "Behavior", "Tokens", "Context", "Scope", "Duration", "Human acceptance", "Failure taxonomy"]) {
    assert.equal(markdown.includes(`## ${heading}`), true);
  }

  const mutations = [
    (candidate) => { candidate.results[0].result.identityMismatchFields = ["modelId"]; },
    (candidate) => { delete candidate.results[0].result.identityMismatchFields; },
    (candidate) => { candidate.results[0].failure = { code: "agent_protocol_failure" }; },
    (candidate) => { candidate.retryPolicy = "retry_once"; },
    (candidate) => { candidate.promptMutationAfterFailure = true; },
    (candidate) => { candidate.hiddenHintInjection = true; },
    (candidate) => { candidate.completedAgentPairs = candidate.completedPairCount - 1; }
  ];
  for (const mutate of mutations) expectRejected(evidence, mutate);

  const withoutCompletedAgentPairs = clone(evidence);
  delete withoutCompletedAgentPairs.completedAgentPairs;
  assert.doesNotThrow(() => buildDogfoodReport(withoutCompletedAgentPairs, sha256(JSON.stringify(withoutCompletedAgentPairs))));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportVersion: REPORT_VERSION,
    taxonomy: FAILURE_TAXONOMY,
    failClosedMutationsChecked: mutations.length,
    optionalCompletedAgentPairsAccepted: true
  }, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  const raw = fs.readFileSync(args.input, "utf8");
  const evidence = JSON.parse(raw);
  const report = buildDogfoodReport(evidence, sha256(raw));
  const written = writeReport(report, args.outputDir);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportVersion: REPORT_VERSION,
    input: args.input,
    outputDir: args.outputDir,
    json: written.jsonPath,
    markdown: written.markdownPath,
    fullSuiteCompleted: report.overallSuccess.fullSuiteCompleted,
    completedPairCount: report.overallSuccess.completedPairCount,
    taskCount: report.overallSuccess.taskCount
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
