#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FROZEN_TASKSET_HASHES,
  Gate6TasksetError,
  TASKSET_SCHEMA_VERSION,
  hashGate6Taskset,
  loadFrozenGate6Taskset,
  validateFrozenGate6Taskset
} = require("../../scripts/lib/gate6-taskset.cjs");

const ROOT = path.resolve(__dirname, "../..");
const PATHS = {
  rootPath: ROOT,
  repositoryManifestPath: path.join(ROOT, "benchmarks/gate6/repositories.json"),
  lockPath: path.join(ROOT, "benchmarks/gate6/taskset.json")
};
function readJson(filePath) { return JSON.parse(require("node:fs").readFileSync(filePath, "utf8")); }
function bundle() {
  const lock = readJson(PATHS.lockPath);
  const tasks = lock.taskFiles.flatMap((relativePath) => readJson(path.join(ROOT, relativePath)).tasks);
  const oracles = lock.oracleFiles.flatMap((relativePath) => readJson(path.join(ROOT, relativePath)).oracles);
  return {
    tasksDocument: { schemaVersion: "gate6-taskset/v1", tasks },
    oraclesDocument: { schemaVersion: "gate6-taskset/v1", oracles },
    repositoryManifest: readJson(PATHS.repositoryManifestPath),
    lock
  };
}
function clone(value) { return structuredClone(value); }
function expectReject(fn, code) {
  assert.throws(fn, (error) => error instanceof Gate6TasksetError && error.code === code, `expected ${code}`);
}
function test(name, fn) { fn(); process.stdout.write(`PASS ${name}\n`); }

function main() {
  test("frozen v1 dataset validates and reports exact target size", () => {
    const report = loadFrozenGate6Taskset(PATHS);
    assert.equal(report.schemaVersion, "gate6-taskset/v1");
    assert.equal(report.taskCount, 42);
    assert.equal(report.repositoryCount, 14);
    assert.equal(report.frozen, true);
    assert.equal(Object.isFrozen(report), true);
  });
  test("all seven task classes have exactly six tasks", () => {
    const report = loadFrozenGate6Taskset(PATHS);
    assert.deepEqual(report.classCounts, {
      bugfix_with_regression: 6,
      cross_file_change: 6,
      dependency_following: 6,
      api_contract_change: 6,
      decoy_file_selection: 6,
      no_change_needed: 6,
      boundary_sensitive_change: 6
    });
  });
  test("difficulty distribution is exactly 13 easy 21 medium 8 hard", () => {
    assert.deepEqual(loadFrozenGate6Taskset(PATHS).difficultyCounts, { easy: 13, medium: 21, hard: 8 });
  });
  test("repository diversity and share stay safely inside the benchmark bound", () => {
    const report = loadFrozenGate6Taskset(PATHS);
    assert.equal(report.repositoryCount, 14);
    assert.equal(report.maxRepositoryTasks, 3);
    assert.equal(report.maxRepositoryShare, 3 / 42);
    assert.equal(report.maxRepositoryShare <= 0.2, true);
    assert.equal(Object.values(report.repositoryCounts).every((count) => count === 3), true);
  });
  test("every task resolves to exactly one hidden oracle and frozen repository SHA", () => {
    const current = bundle();
    const tasks = current.tasksDocument.tasks;
    const oracles = new Map(current.oraclesDocument.oracles.map((oracle) => [oracle.taskId, oracle]));
    const repositories = new Map(current.repositoryManifest.repositories.map((repository) => [repository.id, repository]));
    assert.equal(oracles.size, tasks.length);
    for (const task of tasks) {
      assert.equal(oracles.has(task.taskId), true);
      assert.equal(repositories.get(task.repositoryId).commitSha, task.commitSha);
    }
    validateFrozenGate6Taskset(current);
  });
  test("no-change tasks carry no mutation expectation in hidden oracles", () => {
    const current = bundle();
    const taskById = new Map(current.tasksDocument.tasks.map((task) => [task.taskId, task]));
    const noChange = current.oraclesDocument.oracles.filter((oracle) => taskById.get(oracle.taskId).taskClass === "no_change_needed");
    assert.equal(noChange.length, 6);
    for (const oracle of noChange) {
      assert.deepEqual(oracle.requiredImplementationFiles, []);
      assert.deepEqual(oracle.requiredTestFiles, []);
      assert.deepEqual(oracle.allowedTouchedFiles, []);
    }
  });
  test("taskset hash is canonical and insensitive to top-level dataset ordering", () => {
    const current = bundle();
    const reversed = clone(current);
    reversed.tasksDocument.tasks.reverse();
    reversed.oraclesDocument.oracles.reverse();
    reversed.repositoryManifest.repositories.reverse();
    assert.equal(hashGate6Taskset(current), hashGate6Taskset(reversed));
    assert.equal(hashGate6Taskset(current), FROZEN_TASKSET_HASHES[TASKSET_SCHEMA_VERSION]);
  });
  test("set-like path and symbol ordering does not change the canonical taskset hash", () => {
    const current = bundle();
    const reordered = clone(current);
    const task = reordered.tasksDocument.tasks[0];
    task.candidateFiles.reverse();
    task.authority.allowedInspectionPaths.reverse();
    task.authority.allowedChangePaths.reverse();
    const oracle = reordered.oraclesDocument.oracles[0];
    oracle.requiredImplementationFiles.reverse();
    oracle.requiredTestFiles.reverse();
    oracle.requiredSymbols.reverse();
    oracle.requiredTestAnchors.reverse();
    oracle.allowedTouchedFiles.reverse();
    oracle.forbiddenFiles.reverse();
    oracle.behavioralChecks.reverse();
    assert.equal(hashGate6Taskset(current), hashGate6Taskset(reordered));
  });
  test("near-duplicate task IDs fail closed", () => {
    const current = bundle();
    const first = current.tasksDocument.tasks[0].taskId;
    current.tasksDocument.tasks[1].taskId = first.replaceAll(".", "-");
    current.oraclesDocument.oracles[1].taskId = current.tasksDocument.tasks[1].taskId;
    expectReject(() => validateFrozenGate6Taskset(current), "GATE6_TASKSET_NEAR_DUPLICATE_TASK_ID");
  });
  test("duplicate objectives fail closed rather than creating renamed clones", () => {
    const current = bundle();
    current.tasksDocument.tasks[1].objective = current.tasksDocument.tasks[0].objective;
    expectReject(() => validateFrozenGate6Taskset(current), "GATE6_TASKSET_DUPLICATE_OBJECTIVE");
  });
  test("oracle mutation under gate6-taskset/v1 invalidates the frozen hash", () => {
    const current = bundle();
    current.oraclesDocument.oracles[0].requiredSymbols.push("post_model_oracle_mutation");
    expectReject(() => validateFrozenGate6Taskset(current), "GATE6_TASKSET_FROZEN_HASH_MISMATCH");
  });
  test("public task mutation under gate6-taskset/v1 invalidates the frozen hash", () => {
    const current = bundle();
    current.tasksDocument.tasks[0].objective += " changed after freeze";
    expectReject(() => validateFrozenGate6Taskset(current), "GATE6_TASKSET_FROZEN_HASH_MISMATCH");
  });
  test("changing only the lock hash cannot redefine frozen v1", () => {
    const current = bundle();
    current.lock.tasksetHash = "sha256:" + "0".repeat(64);
    expectReject(() => validateFrozenGate6Taskset(current), "GATE6_TASKSET_LOCK_HASH_MISMATCH");
  });
  test("model outputs are not valid taskset validator inputs", () => {
    const current = bundle();
    expectReject(
      () => validateFrozenGate6Taskset({ ...current, modelOutputs: [{ answer: "seen" }] }),
      "GATE6_TASKSET_MODEL_OUTPUT_INPUT_FORBIDDEN"
    );
  });
  test("lock explicitly records pre-model manual oracle review and version-bump mutation policy", () => {
    const report = loadFrozenGate6Taskset(PATHS);
    assert.equal(report.oracleReviewStatus, "manually_verified_against_exact_repository_commits_before_model_execution");
    assert.equal(report.oracleMutationPolicy, "requires_taskset_version_bump_after_freeze");
  });
  process.stdout.write("Gate 6 frozen taskset PASS\n");
}
main();
