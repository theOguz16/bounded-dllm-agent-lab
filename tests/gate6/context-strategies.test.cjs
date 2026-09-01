#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  Gate6ContextStrategyError,
  REPOSITORY_SNAPSHOT_VERSION,
  STRATEGIES,
  resolveContext
} = require("../../scripts/lib/gate6-context-strategies.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "1123456789abcdef0123456789abcdef01234567";
const FORBIDDEN_SENTINEL = "GATE6_CONTEXT_FORBIDDEN_SENTINEL";

function task(overrides = {}) {
  const base = {
    schemaVersion: "gate6-task/v1",
    taskId: "external.repo.calculate-regression",
    repositoryId: "owner/repo",
    commitSha: SHA,
    taskClass: "bugfix_with_regression",
    difficulty: "medium",
    objective: "Fix calculate regression and preserve helper behavior with regression coverage.",
    candidateFiles: ["src/main.js", "src/decoy.js", "test/main.test.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**"],
      forbiddenInspectionPaths: ["src/private/**"],
      allowedChangePaths: ["src/main.js", "src/helper.js", "test/**"]
    }
  };
  return { ...base, ...overrides };
}

function snapshot(overrides = {}) {
  const files = [
    {
      path: "src/main.js",
      content: "import { helper } from './helper.js';\nexport function calculate(value) {\n  return helper(value) + 1;\n}\n"
    },
    {
      path: "src/helper.js",
      content: "export function helper(value) {\n  return value * 2;\n}\n"
    },
    {
      path: "src/decoy.js",
      content: "export function calculateLegacy(value) {\n  return value - 1;\n}\n"
    },
    {
      path: "test/main.test.js",
      content: "import { calculate } from '../src/main.js';\ntest('calculate regression', () => {\n  expect(calculate(2)).toBe(5);\n});\n"
    },
    {
      path: "src/private/hidden.js",
      content: `export const secret = '${FORBIDDEN_SENTINEL}';\n`
    }
  ];
  return {
    schemaVersion: REPOSITORY_SNAPSHOT_VERSION,
    repositoryId: "owner/repo",
    commitSha: SHA,
    files,
    ...overrides
  };
}

function expectReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6ContextStrategyError && error.code === code,
    `expected ${code}`
  );
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function main() {
  test("all four strategies resolve deterministically with accounting", () => {
    for (const strategy of STRATEGIES) {
      const first = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy });
      const second = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy });
      assert.deepEqual(first, second);
      assert.equal(first.contextBytes, Buffer.byteLength(first.context, "utf8"));
      assert.equal(first.estimatedTokens, Math.ceil(first.contextBytes / 4));
      assert.equal(first.tokenAccounting.estimatedTokens, first.estimatedTokens);
      assert.match(first.providerContextHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(first.authorityHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(first.repositorySnapshotHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(Object.isFrozen(first), true);
    }
  });

  test("repository file order does not change output or hashes", () => {
    const normal = snapshot();
    const reversed = snapshot({ files: [...snapshot().files].reverse() });
    for (const strategy of STRATEGIES) {
      assert.deepEqual(
        resolveContext({ task: task(), repositorySnapshot: normal, strategy }),
        resolveContext({ task: task(), repositorySnapshot: reversed, strategy })
      );
    }
  });

  test("unknown strategy fails closed", () => {
    expectReject(
      () => resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy: "G_unknown" }),
      "GATE6_CONTEXT_STRATEGY_UNSUPPORTED"
    );
  });

  test("repository and commit mismatch fail closed", () => {
    expectReject(
      () => resolveContext({
        task: task(),
        repositorySnapshot: snapshot({ repositoryId: "other/repo" }),
        strategy: "C_synthetic_context"
      }),
      "GATE6_CONTEXT_REPOSITORY_MISMATCH"
    );
    expectReject(
      () => resolveContext({
        task: task(),
        repositorySnapshot: snapshot({ commitSha: OTHER_SHA }),
        strategy: "C_synthetic_context"
      }),
      "GATE6_CONTEXT_COMMIT_MISMATCH"
    );
  });

  test("missing candidate and duplicate snapshot path fail closed", () => {
    expectReject(
      () => resolveContext({
        task: task(),
        repositorySnapshot: snapshot({ files: snapshot().files.filter((file) => file.path !== "src/decoy.js") }),
        strategy: "E_bounded_workspace_boundary"
      }),
      "GATE6_CONTEXT_CANDIDATE_MISSING"
    );
    expectReject(
      () => resolveContext({
        task: task(),
        repositorySnapshot: snapshot({ files: [...snapshot().files, snapshot().files[0]] }),
        strategy: "E_bounded_workspace_boundary"
      }),
      "GATE6_CONTEXT_SNAPSHOT_DUPLICATE_PATH"
    );
  });

  test("forbidden content is never inspected into provider-facing output", () => {
    const changedForbidden = snapshot({
      files: snapshot().files.map((file) => file.path === "src/private/hidden.js"
        ? { ...file, content: "export const secret = 'CHANGED_FORBIDDEN_CONTENT';\n" }
        : file)
    });
    for (const strategy of STRATEGIES) {
      const first = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy });
      const second = resolveContext({ task: task(), repositorySnapshot: changedForbidden, strategy });
      assert.equal(first.context.includes(FORBIDDEN_SENTINEL), false);
      assert.equal(first.context.includes("src/private/hidden.js"), false);
      assert.deepEqual(first, second);
    }
  });

  test("C is synthetic while E carries bounded repository evidence", () => {
    const c = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy: "C_synthetic_context" });
    const e = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy: "E_bounded_workspace_boundary" });
    assert.equal(c.context.includes("return helper(value) + 1"), false);
    assert.equal(c.context.includes("deterministic_repository_summary"), true);
    assert.equal(e.context.includes("return helper(value) + 1"), true);
    assert.equal(e.context.includes("bounded_workspace_with_boundary"), true);
  });

  test("F preserves one-hop one-round one-file expansion for eligible task classes", () => {
    const result = resolveContext({
      task: task({ taskClass: "dependency_following" }),
      repositorySnapshot: snapshot(),
      strategy: "F_adaptive_compressed_boundary"
    });
    assert.equal(result.expansionRounds, 1);
    assert.equal(result.includedFiles.includes("src/helper.js"), true);
    assert.equal(result.context.includes("synthetic_candidates_then_verified_e_lite"), true);
  });

  test("F never expands beyond task authority", () => {
    const dependencyTask = task({
      taskClass: "dependency_following",
      authority: {
        allowedInspectionPaths: ["src/**", "test/**"],
        forbiddenInspectionPaths: ["src/private/**", "src/helper.js"],
        allowedChangePaths: ["src/main.js", "test/**"]
      }
    });
    const result = resolveContext({
      task: dependencyTask,
      repositorySnapshot: snapshot(),
      strategy: "F_adaptive_compressed_boundary"
    });
    assert.equal(result.expansionRounds, 0);
    assert.equal(result.includedFiles.includes("src/helper.js"), false);
    assert.equal(result.context.includes("return value * 2"), false);
  });

  test("task class metadata can prohibit F cross-file expansion", () => {
    const result = resolveContext({
      task: task({ taskClass: "bugfix_with_regression" }),
      repositorySnapshot: snapshot(),
      strategy: "F_adaptive_compressed_boundary"
    });
    assert.equal(result.expansionRounds, 0);
    assert.equal(result.includedFiles.includes("src/helper.js"), false);
  });

  test("CE exposes only deterministic C initial stage before Step 6", () => {
    const result = resolveContext({ task: task(), repositorySnapshot: snapshot(), strategy: "CE_escalating_context" });
    assert.equal(result.expansionRounds, 0);
    assert.equal(result.context.includes("synthetic_initial_pending_escalation"), true);
    assert.equal(result.context.includes('"escalationState":"not_escalated"'), true);
    assert.equal(result.context.includes("return helper(value) + 1"), false);
  });

  process.stdout.write("Gate 6 context strategies PASS\n");
}

main();
