#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  CANDIDATE_SELECTION_VERSION,
  ESCALATION_REASON_ORDER,
  createGate6EscalationPolicy,
  resolveEscalatingContext
} = require("../../scripts/lib/gate6-context-escalation.cjs");
const { resolveContext } = require("../../scripts/lib/gate6-context-strategies.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SENTINEL = "GATE6_HIDDEN_ORACLE_SENTINEL";

function task(overrides = {}) {
  const base = {
    schemaVersion: "gate6-task/v1",
    taskId: "external.repo.calculate",
    repositoryId: "owner/repo",
    commitSha: SHA,
    taskClass: "bugfix_with_regression",
    difficulty: "medium",
    objective: "Calculate behavior.",
    candidateFiles: ["src/main.js", "src/decoy.js", "test/main.test.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**"],
      forbiddenInspectionPaths: ["src/private/**"],
      allowedChangePaths: ["src/main.js", "test/**"]
    }
  };
  return { ...base, ...overrides };
}

function snapshot() {
  return {
    schemaVersion: "gate6-repository-snapshot/v1",
    repositoryId: "owner/repo",
    commitSha: SHA,
    files: [
      {
        path: "src/main.js",
        content: "export function calculate(value) {\n  return value + 1;\n}\n"
      },
      {
        path: "src/decoy.js",
        content: "export function legacy(value) {\n  return value - 1;\n}\n"
      },
      {
        path: "test/main.test.js",
        content: "test('calculate regression', () => {\n  expect(calculate(1)).toBe(2);\n});\n"
      },
      {
        path: "src/private/hidden.js",
        content: `export const oracle = "${SENTINEL}";\n`
      }
    ]
  };
}

function selection(overrides = {}) {
  return {
    schemaVersion: CANDIDATE_SELECTION_VERSION,
    candidateFiles: ["src/main.js"],
    candidateSymbols: ["calculate"],
    candidateTestFiles: ["test/main.test.js"],
    candidateTestAnchors: ["calculate regression"],
    ...overrides
  };
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function main() {
  test("C sufficient does not call E", () => {
    const calls = [];
    const policy = createGate6EscalationPolicy({
      strategyResolver(input) {
        calls.push(input.strategy);
        return resolveContext(input);
      }
    });
    const result = policy({
      task: task(),
      repositorySnapshot: snapshot(),
      candidateSelection: selection()
    });
    assert.equal(result.escalated, false);
    assert.equal(result.finalStrategy, "C_synthetic_context");
    assert.deepEqual(calls, ["C_synthetic_context"]);
    assert.deepEqual(result.strategyTrace, ["C_synthetic_context"]);
    assert.deepEqual(result.escalationReasons, []);
    assert.equal(result.totalContextBytes, result.contextBytes);
  });

  test("C insufficient calls E and accounts C plus E", () => {
    const calls = [];
    const policy = createGate6EscalationPolicy({
      strategyResolver(input) {
        calls.push(input.strategy);
        return resolveContext(input);
      }
    });
    const result = policy({
      task: task(),
      repositorySnapshot: snapshot(),
      candidateSelection: selection({ candidateTestAnchors: [] })
    });
    assert.equal(result.escalated, true);
    assert.equal(result.finalStrategy, "E_bounded_workspace_boundary");
    assert.deepEqual(calls, ["C_synthetic_context", "E_bounded_workspace_boundary"]);
    assert.deepEqual(result.escalationReasons, ["missing_test_anchor"]);
    assert.equal(
      result.totalContextBytes,
      result.contextAccounting[0].contextBytes + result.contextAccounting[1].contextBytes
    );
    assert.equal(
      result.totalEstimatedTokens,
      result.contextAccounting[0].estimatedTokens + result.contextAccounting[1].estimatedTokens
    );
  });

  test("multiple reasons use fixed deterministic order", () => {
    const result = resolveEscalatingContext({
      task: task({ objective: "Calculate queue detached mapping." }),
      repositorySnapshot: snapshot(),
      candidateSelection: selection({
        candidateFiles: [],
        candidateSymbols: ["MissingSymbol"],
        candidateTestFiles: [],
        candidateTestAnchors: []
      })
    });
    assert.deepEqual(result.escalationReasons, [
      "missing_required_test_candidate",
      "missing_implementation_candidate",
      "unresolvable_symbol",
      "missing_test_anchor",
      "low_evidence_coverage"
    ]);
    assert.deepEqual(
      result.escalationReasons,
      ESCALATION_REASON_ORDER.filter((reason) => result.escalationReasons.includes(reason))
    );
  });

  test("unresolvable symbol escalates deterministically", () => {
    const result = resolveEscalatingContext({
      task: task(),
      repositorySnapshot: snapshot(),
      candidateSelection: selection({ candidateSymbols: ["notThere"] })
    });
    assert.equal(result.escalated, true);
    assert.deepEqual(result.escalationReasons, ["unresolvable_symbol"]);
  });

  test("missing test candidate escalates", () => {
    const result = resolveEscalatingContext({
      task: task(),
      repositorySnapshot: snapshot(),
      candidateSelection: selection({
        candidateTestFiles: [],
        candidateTestAnchors: []
      })
    });
    assert.equal(result.escalationReasons.includes("missing_required_test_candidate"), true);
    assert.equal(result.escalationReasons.includes("missing_test_anchor"), true);
  });

  test("low public evidence coverage escalates", () => {
    const result = resolveEscalatingContext({
      task: task({ objective: "Queue detached scheduler mapping." }),
      repositorySnapshot: snapshot(),
      candidateSelection: selection()
    });
    assert.deepEqual(result.escalationReasons, ["low_evidence_coverage"]);
    assert.equal(result.sufficiency.evidenceCoverage < 0.5, true);
  });

  test("invalid structured output escalates without echoing raw data", () => {
    const result = resolveEscalatingContext({
      task: task(),
      repositorySnapshot: snapshot(),
      candidateSelection: { ...selection(), hiddenOracle: SENTINEL }
    });
    assert.deepEqual(result.escalationReasons, ["invalid_structured_output"]);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  });

  test("authority and candidate universe remain unchanged after escalation", () => {
    const t = task();
    const s = snapshot();
    const c = resolveContext({ task: t, repositorySnapshot: s, strategy: "C_synthetic_context" });
    const e = resolveContext({ task: t, repositorySnapshot: s, strategy: "E_bounded_workspace_boundary" });
    const result = resolveEscalatingContext({
      task: t,
      repositorySnapshot: s,
      candidateSelection: selection({ candidateTestAnchors: [] })
    });
    assert.equal(result.authorityHash, c.authorityHash);
    assert.equal(result.authorityHash, e.authorityHash);
    assert.equal(result.repositorySnapshotHash, c.repositorySnapshotHash);
    assert.equal(result.repositorySnapshotHash, e.repositorySnapshotHash);
    assert.deepEqual(result.finalIncludedFiles, [...t.candidateFiles].sort());
    assert.equal(result.finalIncludedFiles.every((filePath) => t.candidateFiles.includes(filePath)), true);
  });

  test("oracle sentinel never affects or leaks into escalation decision", () => {
    const baseTask = task();
    const hiddenTask = { ...task(), oracle: { requiredSymbols: [SENTINEL] }, hiddenSentinel: SENTINEL };
    const base = resolveEscalatingContext({
      task: baseTask,
      repositorySnapshot: snapshot(),
      candidateSelection: selection()
    });
    const hidden = resolveEscalatingContext({
      task: hiddenTask,
      repositorySnapshot: snapshot(),
      candidateSelection: selection()
    });
    assert.deepEqual(hidden, base);
    assert.equal(JSON.stringify(hidden).includes(SENTINEL), false);
  });

  test("no_change_needed can accept empty public evidence", () => {
    const result = resolveEscalatingContext({
      task: task({
        taskClass: "no_change_needed",
        objective: "No repository mutation is needed."
      }),
      repositorySnapshot: snapshot(),
      candidateSelection: selection({
        candidateFiles: [],
        candidateSymbols: [],
        candidateTestFiles: [],
        candidateTestAnchors: []
      })
    });
    assert.equal(result.escalated, false);
    assert.equal(result.sufficiency.evidenceCoverage, 1);
  });

  process.stdout.write("Gate 6 deterministic C→E escalation PASS\n");
}

main();
