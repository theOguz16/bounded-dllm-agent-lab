#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  Gate6TaskSchemaError,
  validateGate6Task,
  validateGate6Taskset
} = require("../../scripts/lib/gate6-task-schema.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";

function validTask(overrides = {}) {
  const base = {
    schemaVersion: "gate6-task/v1",
    taskId: "external.repo.fix-regression",
    repositoryId: "owner/repo",
    commitSha: SHA,
    taskClass: "bugfix_with_regression",
    difficulty: "easy",
    objective: "Fix the regression without changing unrelated behavior.",
    candidateFiles: ["src/index.js", "test/index.test.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**", "package.json"],
      forbiddenInspectionPaths: ["secrets/**"],
      allowedChangePaths: ["src/**", "test/**"]
    }
  };
  return { ...base, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6TaskSchemaError && error.code === code,
    `expected rejection ${code}`
  );
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function main() {
  test("1 valid task is accepted", () => {
    const task = validTask();
    assert.equal(validateGate6Task(task), task);
  });

  test("2 missing required field is rejected", () => {
    const task = validTask();
    delete task.repositoryId;
    expectReject(() => validateGate6Task(task), "GATE6_TASK_REQUIRED_FIELD_MISSING");
  });

  test("3 invalid SHA is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ commitSha: "abc123" })),
      "GATE6_TASK_COMMIT_SHA_INVALID"
    );
  });

  test("4 unknown schema version is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ schemaVersion: "gate6-task/v2" })),
      "GATE6_TASK_SCHEMA_VERSION_UNSUPPORTED"
    );
  });

  test("5 unknown task class is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ taskClass: "feature" })),
      "GATE6_TASK_CLASS_UNSUPPORTED"
    );
  });

  test("6 unknown difficulty is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ difficulty: "extreme" })),
      "GATE6_TASK_DIFFICULTY_UNSUPPORTED"
    );
  });

  test("7 path traversal is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ candidateFiles: ["src/../secret.txt"] })),
      "GATE6_TASK_PATH_INVALID"
    );
  });

  test("8 absolute paths are rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ candidateFiles: ["/etc/passwd"] })),
      "GATE6_TASK_PATH_INVALID"
    );
    expectReject(
      () => validateGate6Task(validTask({ candidateFiles: ["C:\\Windows\\system.ini"] })),
      "GATE6_TASK_PATH_INVALID"
    );
  });

  test("9 duplicate candidate path is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ candidateFiles: ["src/index.js", "src/index.js"] })),
      "GATE6_TASK_CANDIDATE_DUPLICATE"
    );
  });

  test("10 duplicate task ID is rejected at taskset level", () => {
    const first = validTask();
    const second = validTask({ repositoryId: "another/repo" });
    expectReject(
      () => validateGate6Taskset([first, second]),
      "GATE6_TASKSET_DUPLICATE_TASK_ID"
    );
  });

  test("11 validation is deterministic", () => {
    const invalid = validTask({ difficulty: "extreme" });
    const errors = [];
    for (let index = 0; index < 5; index += 1) {
      try {
        validateGate6Task(invalid);
      } catch (error) {
        errors.push({ name: error.name, code: error.code, message: error.message });
      }
    }
    assert.equal(errors.length, 5);
    for (const error of errors.slice(1)) assert.deepEqual(error, errors[0]);
  });

  test("12 validator does not mutate input", () => {
    const task = validTask();
    const before = clone(task);
    validateGate6Task(task);
    assert.deepEqual(task, before);
  });

  test("empty objective is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ objective: "   " })),
      "GATE6_TASK_OBJECTIVE_EMPTY"
    );
  });

  test("candidate outside inspection authority is rejected", () => {
    expectReject(
      () => validateGate6Task(validTask({ candidateFiles: ["docs/design.md"] })),
      "GATE6_TASK_CANDIDATE_OUTSIDE_AUTHORITY"
    );
  });

  test("candidate under forbidden inspection authority is rejected", () => {
    const task = validTask({
      candidateFiles: ["src/private/key.js"],
      authority: {
        allowedInspectionPaths: ["src/**"],
        forbiddenInspectionPaths: ["src/private/**"],
        allowedChangePaths: ["src/**"]
      }
    });
    expectReject(() => validateGate6Task(task), "GATE6_TASK_CANDIDATE_OUTSIDE_AUTHORITY");
  });

  test("authority path traversal is rejected", () => {
    const task = validTask({
      authority: {
        allowedInspectionPaths: ["../src/**"],
        forbiddenInspectionPaths: [],
        allowedChangePaths: ["src/**"]
      }
    });
    expectReject(() => validateGate6Task(task), "GATE6_TASK_PATH_INVALID");
  });

  process.stdout.write("Gate 6 task schema validation PASS\n");
}

main();
