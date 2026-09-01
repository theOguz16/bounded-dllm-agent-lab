#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  Gate6TaskClassRegistryError,
  TASK_CLASS_IDS,
  TASK_CLASS_REGISTRY,
  TASK_CLASS_REGISTRY_VERSION,
  getGate6TaskClass,
  hasGate6TaskClass
} = require("../../scripts/lib/gate6-task-classes.cjs");
const {
  TASK_CLASSES,
  validateGate6Task
} = require("../../scripts/lib/gate6-task-schema.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const EXPECTED = Object.freeze({
  bugfix_with_regression: {
    id: "bugfix_with_regression",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: true,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  },
  cross_file_change: {
    id: "cross_file_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  dependency_following: {
    id: "dependency_following",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  api_contract_change: {
    id: "api_contract_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: true,
    allowsNoChange: false,
    allowsCrossFileExpansion: true
  },
  decoy_file_selection: {
    id: "decoy_file_selection",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  },
  no_change_needed: {
    id: "no_change_needed",
    version: 1,
    requiresImplementationFile: false,
    requiresTestFile: false,
    allowsNoChange: true,
    allowsCrossFileExpansion: false
  },
  boundary_sensitive_change: {
    id: "boundary_sensitive_change",
    version: 1,
    requiresImplementationFile: true,
    requiresTestFile: false,
    allowsNoChange: false,
    allowsCrossFileExpansion: false
  }
});

function validTask(taskClass) {
  return {
    schemaVersion: "gate6-task/v1",
    taskId: `external.repo.${taskClass}`,
    repositoryId: "owner/repo",
    commitSha: SHA,
    taskClass,
    difficulty: "medium",
    objective: `Exercise ${taskClass} behavior.`,
    candidateFiles: ["src/index.js", "test/index.test.js"],
    authority: {
      allowedInspectionPaths: ["src/**", "test/**"],
      forbiddenInspectionPaths: ["secrets/**"],
      allowedChangePaths: ["src/**", "test/**"]
    }
  };
}

function expectRegistryReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6TaskClassRegistryError && error.code === code,
    `expected registry rejection ${code}`
  );
}

function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function main() {
  test("registry is versioned", () => {
    assert.equal(TASK_CLASS_REGISTRY_VERSION, "gate6-task-classes/v1");
  });

  test("registry exports exactly the supported task classes", () => {
    assert.deepEqual(TASK_CLASS_IDS, Object.keys(EXPECTED));
    assert.deepEqual(Object.keys(TASK_CLASS_REGISTRY), Object.keys(EXPECTED));
  });

  for (const [taskClass, metadata] of Object.entries(EXPECTED)) {
    test(`${taskClass} has the expected versioned metadata`, () => {
      assert.equal(hasGate6TaskClass(taskClass), true);
      assert.deepEqual(getGate6TaskClass(taskClass), metadata);
      assert.equal(Object.isFrozen(getGate6TaskClass(taskClass)), true);
    });
  }

  test("registry exports are immutable", () => {
    assert.equal(Object.isFrozen(TASK_CLASS_IDS), true);
    assert.equal(Object.isFrozen(TASK_CLASS_REGISTRY), true);
    assert.throws(() => { TASK_CLASS_IDS.push("unexpected"); }, TypeError);
    assert.throws(() => { TASK_CLASS_REGISTRY.unexpected = {}; }, TypeError);
    assert.throws(() => { getGate6TaskClass("bugfix_with_regression").version = 2; }, TypeError);
    assert.equal(getGate6TaskClass("bugfix_with_regression").version, 1);
  });

  test("unknown class fails closed", () => {
    assert.equal(hasGate6TaskClass("unknown_class"), false);
    expectRegistryReject(
      () => getGate6TaskClass("unknown_class"),
      "GATE6_TASK_CLASS_UNSUPPORTED"
    );
  });

  test("task schema derives task classes from the central registry", () => {
    assert.equal(TASK_CLASSES, TASK_CLASS_IDS);
    for (const taskClass of TASK_CLASS_IDS) {
      const task = validTask(taskClass);
      assert.equal(validateGate6Task(task), task);
    }
  });

  process.stdout.write("Gate 6 task class registry PASS\n");
}

main();
