"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { getGate6TaskClass } = require("./gate6-task-classes.cjs");
const { resolveContext } = require("./gate6-context-strategies.cjs");

const ESCALATION_POLICY_VERSION = "gate6-ce-escalation/v1";
const CANDIDATE_SELECTION_VERSION = "gate6-candidate-selection/v1";
const INITIAL_STRATEGY = "C_synthetic_context";
const ESCALATED_STRATEGY = "E_bounded_workspace_boundary";
const MIN_EVIDENCE_COVERAGE = 0.5;
const SELECTION_FIELDS = Object.freeze([
  "schemaVersion",
  "candidateFiles",
  "candidateSymbols",
  "candidateTestFiles",
  "candidateTestAnchors"
]);
const ESCALATION_REASON_ORDER = Object.freeze([
  "missing_required_test_candidate",
  "missing_implementation_candidate",
  "unresolvable_symbol",
  "missing_test_anchor",
  "low_evidence_coverage",
  "invalid_structured_output"
]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "without", "should",
  "task", "change", "changed", "file", "files", "behavior", "relevant", "implementation",
  "test", "tests", "public", "fix", "fixed", "regression", "preserve", "coverage", "candidate",
  "candidates", "required", "ensure", "update", "correct", "correctly"
]);

class Gate6EscalationPolicyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6EscalationPolicyError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6EscalationPolicyError(code, detail);
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

function hashCanonicalStringArray(values) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([...values].sort(compareText)))
    .digest("hex")}`;
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function canonicalStringArray(value, { maxItems, pathLike = false, allowedPaths = null } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.trim() !== item || item.length > 512) {
      return null;
    }
    if (pathLike && !safeRelativePath(item)) return null;
    if (allowedPaths !== null && !allowedPaths.has(item)) return null;
    if (seen.has(item)) return null;
    seen.add(item);
    result.push(item);
  }
  return result.sort(compareText);
}

function validateCandidateSelection(candidateSelection, task) {
  if (!sameKeys(candidateSelection, SELECTION_FIELDS)) return null;
  if (candidateSelection.schemaVersion !== CANDIDATE_SELECTION_VERSION) return null;

  const universe = new Set(task.candidateFiles);
  const candidateFiles = canonicalStringArray(candidateSelection.candidateFiles, {
    maxItems: 32,
    pathLike: true,
    allowedPaths: universe
  });
  const candidateSymbols = canonicalStringArray(candidateSelection.candidateSymbols, { maxItems: 64 });
  const candidateTestFiles = canonicalStringArray(candidateSelection.candidateTestFiles, {
    maxItems: 32,
    pathLike: true,
    allowedPaths: universe
  });
  const candidateTestAnchors = canonicalStringArray(candidateSelection.candidateTestAnchors, { maxItems: 64 });

  if (
    candidateFiles === null ||
    candidateSymbols === null ||
    candidateTestFiles === null ||
    candidateTestAnchors === null
  ) return null;

  const implementationSet = new Set(candidateFiles);
  if (candidateTestFiles.some((filePath) => implementationSet.has(filePath))) return null;

  return Object.freeze({
    schemaVersion: CANDIDATE_SELECTION_VERSION,
    candidateFiles: Object.freeze(candidateFiles),
    candidateSymbols: Object.freeze(candidateSymbols),
    candidateTestFiles: Object.freeze(candidateTestFiles),
    candidateTestAnchors: Object.freeze(candidateTestAnchors)
  });
}

function parseSyntheticContext(initialResult) {
  let payload;
  try {
    payload = JSON.parse(initialResult.context);
  } catch {
    fail("GATE6_CE_INITIAL_CONTEXT_INVALID");
  }
  if (
    !isPlainObject(payload) ||
    payload.strategy !== INITIAL_STRATEGY ||
    payload.contextStrategy !== "deterministic_repository_summary" ||
    !Array.isArray(payload.summaries)
  ) {
    fail("GATE6_CE_INITIAL_CONTEXT_INVALID");
  }
  const summaries = new Map();
  for (const summary of payload.summaries) {
    if (
      !isPlainObject(summary) ||
      typeof summary.path !== "string" ||
      typeof summary.kind !== "string" ||
      typeof summary.summary !== "string" ||
      !Array.isArray(summary.symbols) ||
      summaries.has(summary.path)
    ) {
      fail("GATE6_CE_INITIAL_CONTEXT_INVALID");
    }
    summaries.set(summary.path, {
      path: summary.path,
      kind: summary.kind,
      summary: summary.summary,
      symbols: summary.symbols.filter((symbol) => typeof symbol === "string").sort(compareText)
    });
  }
  return summaries;
}

function snapshotByPath(repositorySnapshot) {
  const byPath = new Map();
  if (!repositorySnapshot || !Array.isArray(repositorySnapshot.files)) return byPath;
  for (const entry of repositorySnapshot.files) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.path === "string" &&
      typeof entry.content === "string" &&
      !byPath.has(entry.path)
    ) {
      byPath.set(entry.path, entry.content);
    }
  }
  return byPath;
}

function objectiveTokens(objective) {
  const matches = String(objective).toLowerCase().match(/[\p{L}\p{N}_$.-]+/gu) ?? [];
  return [...new Set(
    matches.filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
  )].sort(compareText);
}

function evidenceCoverage(task, selection, summaries, taskClass) {
  const noChangeSelection =
    taskClass.allowsNoChange &&
    selection.candidateFiles.length === 0 &&
    selection.candidateSymbols.length === 0 &&
    selection.candidateTestFiles.length === 0 &&
    selection.candidateTestAnchors.length === 0;

  if (noChangeSelection) return { coverage: 1, matched: 0, total: 0 };

  const tokens = objectiveTokens(task.objective);
  if (tokens.length === 0) return { coverage: 1, matched: 0, total: 0 };

  const evidenceParts = [];
  for (const filePath of [...selection.candidateFiles, ...selection.candidateTestFiles]) {
    const summary = summaries.get(filePath);
    if (!summary) continue;
    evidenceParts.push(summary.path, summary.kind, summary.summary, ...summary.symbols);
  }
  evidenceParts.push(...selection.candidateSymbols, ...selection.candidateTestAnchors);
  const evidenceText = evidenceParts.join("\n").toLowerCase();
  const matched = tokens.filter((token) => evidenceText.includes(token)).length;
  return {
    coverage: matched / tokens.length,
    matched,
    total: tokens.length
  };
}

function sortReasons(reasons) {
  const unique = new Set(reasons);
  return ESCALATION_REASON_ORDER.filter((reason) => unique.has(reason));
}

function evaluateSufficiency({ task, repositorySnapshot, candidateSelection, initialResult }) {
  const selection = validateCandidateSelection(candidateSelection, task);
  if (selection === null) {
    return {
      reasons: ["invalid_structured_output"],
      report: Object.freeze({
        structuredOutputValid: false,
        evidenceCoverage: 0,
        matchedObjectiveTokenCount: 0,
        objectiveTokenCount: 0,
        selectedImplementationCandidateCount: 0,
        selectedTestCandidateCount: 0,
        candidateSymbolCount: 0,
        resolvedSymbolCount: 0,
        candidateTestAnchorCount: 0,
        resolvedTestAnchorCount: 0
      })
    };
  }

  const taskClass = getGate6TaskClass(task.taskClass);
  const summaries = parseSyntheticContext(initialResult);
  const repositoryFiles = snapshotByPath(repositorySnapshot);
  const reasons = [];

  const implementationCandidates = selection.candidateFiles
    .filter((filePath) => summaries.get(filePath)?.kind === "implementation");
  const testCandidates = selection.candidateTestFiles
    .filter((filePath) => summaries.get(filePath)?.kind === "test");

  if (taskClass.requiresTestFile && testCandidates.length === 0) {
    reasons.push("missing_required_test_candidate");
  }
  if (taskClass.requiresImplementationFile && implementationCandidates.length === 0) {
    reasons.push("missing_implementation_candidate");
  }

  const symbolUniverse = new Set();
  for (const filePath of selection.candidateFiles) {
    for (const symbol of summaries.get(filePath)?.symbols ?? []) symbolUniverse.add(symbol);
  }
  const resolvedSymbols = selection.candidateSymbols
    .filter((symbol) => symbolUniverse.has(symbol));

  if (
    selection.candidateSymbols.length > resolvedSymbols.length ||
    (taskClass.requiresImplementationFile && selection.candidateSymbols.length === 0)
  ) {
    reasons.push("unresolvable_symbol");
  }

  let resolvedTestAnchors = 0;
  for (const anchor of selection.candidateTestAnchors) {
    const found = selection.candidateTestFiles.some((filePath) => {
      const content = repositoryFiles.get(filePath);
      return typeof content === "string" && content.includes(anchor);
    });
    if (found) resolvedTestAnchors += 1;
  }
  if (
    selection.candidateTestAnchors.length > resolvedTestAnchors ||
    (taskClass.requiresTestFile && selection.candidateTestAnchors.length === 0)
  ) {
    reasons.push("missing_test_anchor");
  }

  const coverage = evidenceCoverage(task, selection, summaries, taskClass);
  if (coverage.coverage < MIN_EVIDENCE_COVERAGE) {
    reasons.push("low_evidence_coverage");
  }

  return {
    reasons: sortReasons(reasons),
    report: Object.freeze({
      structuredOutputValid: true,
      evidenceCoverage: coverage.coverage,
      matchedObjectiveTokenCount: coverage.matched,
      objectiveTokenCount: coverage.total,
      selectedImplementationCandidateCount: implementationCandidates.length,
      selectedTestCandidateCount: testCandidates.length,
      candidateSymbolCount: selection.candidateSymbols.length,
      resolvedSymbolCount: resolvedSymbols.length,
      candidateTestAnchorCount: selection.candidateTestAnchors.length,
      resolvedTestAnchorCount: resolvedTestAnchors
    })
  };
}

function assertCandidateUniverse(task, result) {
  const universe = new Set(task.candidateFiles);
  for (const filePath of result.includedFiles) {
    if (!universe.has(filePath)) {
      fail("GATE6_CE_CANDIDATE_UNIVERSE_EXPANDED", filePath);
    }
  }
}

function accountingEntry(result) {
  return Object.freeze({
    strategy: result.strategy,
    contextBytes: result.contextBytes,
    estimatedTokens: result.estimatedTokens,
    providerContextHash: result.providerContextHash,
    authorityHash: result.authorityHash,
    repositorySnapshotHash: result.repositorySnapshotHash
  });
}

function createGate6EscalationPolicy({ strategyResolver = resolveContext } = {}) {
  if (typeof strategyResolver !== "function") {
    fail("GATE6_CE_STRATEGY_RESOLVER_INVALID");
  }

  return function resolveEscalatingContext({ task, repositorySnapshot, candidateSelection } = {}) {
    const initial = strategyResolver({
      task,
      repositorySnapshot,
      strategy: INITIAL_STRATEGY
    });
    assertCandidateUniverse(task, initial);

    const sufficiency = evaluateSufficiency({
      task,
      repositorySnapshot,
      candidateSelection,
      initialResult: initial
    });

    const escalated = sufficiency.reasons.length > 0;
    let finalResult = initial;
    const strategyTrace = [INITIAL_STRATEGY];

    if (escalated) {
      const expanded = strategyResolver({
        task,
        repositorySnapshot,
        strategy: ESCALATED_STRATEGY
      });
      assertCandidateUniverse(task, expanded);
      if (expanded.authorityHash !== initial.authorityHash) {
        fail("GATE6_CE_AUTHORITY_CHANGED");
      }
      if (expanded.repositorySnapshotHash !== initial.repositorySnapshotHash) {
        fail("GATE6_CE_SNAPSHOT_CHANGED");
      }
      finalResult = expanded;
      strategyTrace.push(ESCALATED_STRATEGY);
    }

    const contextAccounting = [
      accountingEntry(initial),
      ...(escalated ? [accountingEntry(finalResult)] : [])
    ];
    const totalContextBytes = contextAccounting
      .reduce((total, entry) => total + entry.contextBytes, 0);
    const totalEstimatedTokens = contextAccounting
      .reduce((total, entry) => total + entry.estimatedTokens, 0);
    const candidateUniverse = [...task.candidateFiles].sort(compareText);

    const output = {
      version: ESCALATION_POLICY_VERSION,
      initialStrategy: INITIAL_STRATEGY,
      finalStrategy: finalResult.strategy,
      escalated,
      escalationReasons: Object.freeze([...sufficiency.reasons]),
      sufficiency: sufficiency.report,
      context: finalResult.context,
      contextBytes: finalResult.contextBytes,
      estimatedTokens: finalResult.estimatedTokens,
      totalContextBytes,
      totalEstimatedTokens,
      contextAccounting: Object.freeze(contextAccounting),
      initialProviderContextHash: initial.providerContextHash,
      finalProviderContextHash: finalResult.providerContextHash,
      providerContextHash: finalResult.providerContextHash,
      authorityHash: initial.authorityHash,
      repositorySnapshotHash: initial.repositorySnapshotHash,
      candidateUniverseHash: hashCanonicalStringArray(candidateUniverse),
      candidateUniverseSize: candidateUniverse.length,
      finalIncludedFiles: Object.freeze([...finalResult.includedFiles]),
      strategyTrace: Object.freeze(strategyTrace)
    };

    return Object.freeze(output);
  };
}

const defaultPolicy = createGate6EscalationPolicy();

function resolveEscalatingContext(input) {
  return defaultPolicy(input);
}

module.exports = {
  CANDIDATE_SELECTION_VERSION,
  ESCALATION_POLICY_VERSION,
  ESCALATION_REASON_ORDER,
  Gate6EscalationPolicyError,
  MIN_EVIDENCE_COVERAGE,
  createGate6EscalationPolicy,
  resolveEscalatingContext,
  validateCandidateSelection
};
