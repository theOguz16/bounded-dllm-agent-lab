#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  Gate6OracleError,
  createGate6ProviderDebugRecord,
  createGate6ProviderPayload,
  createGate6PublicReport,
  createPublicGate6Task,
  stringifyGate6ProviderPrompt,
  validateGate6Oracle
} = require("../../scripts/lib/gate6-oracle.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SENTINEL = "GATE6_HIDDEN_ORACLE_SENTINEL";

function validTask(overrides = {}) {
  const base = {
    schemaVersion: "gate6-task/v1",
    taskId: "external.repo.hidden-oracle",
    repositoryId: "owner/repo",
    commitSha: SHA,
    taskClass: "bugfix_with_regression",
    difficulty: "medium",
    objective: "Fix the public regression without using hidden oracle data.",
    candidateFiles: ["src/index.js", "test/index.test.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**"],
      forbiddenInspectionPaths: ["src/private/**"],
      allowedChangePaths: ["src/**", "test/**"]
    }
  };
  return { ...base, ...overrides };
}

function validOracle(overrides = {}) {
  return {
    schemaVersion: "gate6-oracle/v1",
    taskId: "external.repo.hidden-oracle",
    requiredImplementationFiles: ["src/index.js"],
    requiredTestFiles: ["test/index.test.js"],
    requiredSymbols: ["normalizeInput", SENTINEL],
    requiredTestAnchors: ["regression: preserves empty input"],
    allowedTouchedFiles: ["src/index.js", "test/index.test.js"],
    forbiddenFiles: ["src/private/key.js"],
    behavioralChecks: [{ id: "regression-pass", expected: true }],
    ...overrides
  };
}

function expectReject(fn, code) {
  assert.throws(fn, (error) => error instanceof Gate6OracleError && error.code === code);
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function serialized(value) {
  return JSON.stringify(value);
}

function main() {
  test("valid oracle matches public task", () => {
    const task = validTask();
    const oracle = validOracle();
    assert.equal(validateGate6Oracle(oracle, task), oracle);
  });

  test("oracle taskId mismatch fails closed", () => {
    expectReject(() => validateGate6Oracle(validOracle({ taskId: "other/task" }), validTask()), "GATE6_ORACLE_TASK_ID_MISMATCH");
  });

  test("required implementation file must be within change authority", () => {
    expectReject(
      () => validateGate6Oracle(validOracle({ requiredImplementationFiles: ["docs/readme.md"] }), validTask()),
      "GATE6_ORACLE_REQUIRED_FILE_OUTSIDE_AUTHORITY"
    );
  });

  test("required file under forbidden authority fails closed", () => {
    expectReject(
      () => validateGate6Oracle(validOracle({ requiredImplementationFiles: ["src/private/key.js"] }), validTask()),
      "GATE6_ORACLE_REQUIRED_FILE_OUTSIDE_AUTHORITY"
    );
  });

  test("required and forbidden path conflict fails closed", () => {
    expectReject(
      () => validateGate6Oracle(validOracle({ forbiddenFiles: ["src/index.js"] }), validTask()),
      "GATE6_ORACLE_REQUIRED_FORBIDDEN_CONFLICT"
    );
  });

  test("duplicate symbols fail closed", () => {
    expectReject(
      () => validateGate6Oracle(validOracle({ requiredSymbols: ["normalizeInput", "normalizeInput"] }), validTask()),
      "GATE6_ORACLE_DUPLICATE_VALUE"
    );
  });

  test("duplicate paths fail closed", () => {
    expectReject(
      () => validateGate6Oracle(validOracle({ allowedTouchedFiles: ["src/index.js", "src/index.js"] }), validTask()),
      "GATE6_ORACLE_DUPLICATE_PATH"
    );
  });

  test("no_change_needed rejects mutation expectation", () => {
    const task = validTask({ taskClass: "no_change_needed" });
    expectReject(() => validateGate6Oracle(validOracle(), task), "GATE6_ORACLE_NO_CHANGE_MUTATION_EXPECTATION");
    const oracle = validOracle({
      requiredImplementationFiles: [],
      requiredTestFiles: [],
      allowedTouchedFiles: []
    });
    assert.equal(validateGate6Oracle(oracle, task), oracle);
  });

  test("public task stripping is deterministic and removes oracle properties", () => {
    const mixed = { ...validTask(), oracle: validOracle(), hiddenSentinel: SENTINEL };
    const first = createPublicGate6Task(mixed);
    const second = createPublicGate6Task(mixed);
    assert.deepEqual(first, second);
    assert.equal(Object.hasOwn(first, "oracle"), false);
    assert.equal(Object.hasOwn(first, "hiddenSentinel"), false);
    assert.equal(serialized(first).includes(SENTINEL), false);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.authority), true);
    assert.equal(Object.isFrozen(first.candidateFiles), true);
  });

  test("oracle sentinel never leaks to provider payload or prompt", () => {
    const mixed = { ...validTask(), oracle: validOracle(), hiddenSentinel: SENTINEL };
    const payload = createGate6ProviderPayload(mixed);
    const prompt = stringifyGate6ProviderPrompt(mixed);
    assert.equal(serialized(payload).includes(SENTINEL), false);
    assert.equal(prompt.includes(SENTINEL), false);
  });

  test("public report never exposes oracle content", () => {
    const mixed = { ...validTask(), oracle: validOracle(), hiddenSentinel: SENTINEL };
    const report = createGate6PublicReport({ task: mixed, status: "completed", summary: "public summary" });
    assert.equal(serialized(report).includes(SENTINEL), false);
    assert.equal(Object.hasOwn(report.task, "oracle"), false);
  });

  test("provider debug record never exposes oracle content", () => {
    const mixed = { ...validTask(), oracle: validOracle(), hiddenSentinel: SENTINEL };
    const debug = createGate6ProviderDebugRecord({
      task: mixed,
      provider: "fixture-provider",
      requestId: "req-1",
      oracle: validOracle()
    });
    assert.equal(serialized(debug).includes(SENTINEL), false);
    assert.deepEqual(Object.keys(debug).sort(), [
      "candidateFileCount", "provider", "repositoryId", "requestId", "taskClass", "taskId"
    ]);
  });

  test("separation helpers do not mutate mixed input", () => {
    const mixed = { ...validTask(), oracle: validOracle(), hiddenSentinel: SENTINEL };
    const before = structuredClone(mixed);
    createPublicGate6Task(mixed);
    createGate6ProviderPayload(mixed);
    stringifyGate6ProviderPrompt(mixed);
    createGate6PublicReport({ task: mixed, status: "ok", summary: "ok" });
    createGate6ProviderDebugRecord({ task: mixed, provider: "fixture", requestId: "req" });
    assert.deepEqual(mixed, before);
  });

  process.stdout.write("Gate 6 oracle separation PASS\n");
}

main();
