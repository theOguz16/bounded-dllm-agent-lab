"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { TASK_CLASS_IDS } = require("./gate6-task-classes.cjs");
const { validateGate6Taskset } = require("./gate6-task-schema.cjs");
const { validateGate6Oracle } = require("./gate6-oracle.cjs");
const {
  canonicalizeGate6RepositoryManifest,
  hashGate6RepositoryManifest,
  validateGate6RepositoryManifest
} = require("./gate6-repository-manifest.cjs");

const TASKSET_SCHEMA_VERSION = "gate6-taskset/v1";
const TASKS_DOCUMENT_FIELDS = Object.freeze(["schemaVersion", "tasks"]);
const ORACLES_DOCUMENT_FIELDS = Object.freeze(["schemaVersion", "oracles"]);
const TASK_SHARD_FIELDS = Object.freeze(["schemaVersion", "taskClass", "tasks"]);
const ORACLE_SHARD_FIELDS = Object.freeze(["schemaVersion", "taskClass", "oracles"]);
const TASK_SHARD_SCHEMA_VERSION = "gate6-taskset-shard/v1";
const ORACLE_SHARD_SCHEMA_VERSION = "gate6-oracle-shard/v1";
const LOCK_FIELDS = Object.freeze([
  "schemaVersion", "frozen", "taskCount", "repositoryCount", "taskFiles", "oracleFiles",
  "classCounts", "difficultyCounts", "repositoryManifestHash", "tasksetHash",
  "oracleReviewStatus", "oracleMutationPolicy"
]);
const BUNDLE_INPUT_FIELDS = Object.freeze([
  "tasksDocument", "oraclesDocument", "repositoryManifest", "lock"
]);
const V1_EXPECTED_CLASS_COUNT = 6;
const V1_EXPECTED_TASK_COUNT = 42;
const V1_EXPECTED_DIFFICULTY_COUNTS = Object.freeze({ easy: 13, medium: 21, hard: 8 });
const MIN_REPOSITORY_COUNT = 10;
const MAX_REPOSITORY_SHARE = 0.2;
const FROZEN_TASKSET_HASHES = Object.freeze({
  "gate6-taskset/v1": "sha256:c73b390eb4c7293791097e7fbdf35117bdc819b961c6d15ab38b0459e5b8b5a9"
});
const FROZEN_REPOSITORY_MANIFEST_HASHES = Object.freeze({
  "gate6-taskset/v1": "sha256:4f132ec98b0c85ac597d93209a923977ea1dc6bacbc6bbfe3f1bb098154c9b85"
});
const ORACLE_REVIEW_STATUS = "manually_verified_against_exact_repository_commits_before_model_execution";
const ORACLE_MUTATION_POLICY = "requires_taskset_version_bump_after_freeze";

class Gate6TasksetError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6TasksetError";
    this.code = code;
  }
}

function fail(code, detail) { throw new Gate6TasksetError(code, detail); }
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sameKeys(value, expected) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("GATE6_TASKSET_CANONICAL_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) fail("GATE6_TASKSET_CANONICAL_INVALID");
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function sortedStrings(values) { return [...values].sort(compareText); }
function canonicalTask(task) {
  return {
    schemaVersion: task.schemaVersion,
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    commitSha: task.commitSha,
    taskClass: task.taskClass,
    difficulty: task.difficulty,
    objective: task.objective,
    candidateFiles: sortedStrings(task.candidateFiles),
    authority: {
      allowedInspectionPaths: sortedStrings(task.authority.allowedInspectionPaths),
      forbiddenInspectionPaths: sortedStrings(task.authority.forbiddenInspectionPaths),
      allowedChangePaths: sortedStrings(task.authority.allowedChangePaths)
    }
  };
}
function canonicalOracle(oracle) {
  return {
    schemaVersion: oracle.schemaVersion,
    taskId: oracle.taskId,
    requiredImplementationFiles: sortedStrings(oracle.requiredImplementationFiles),
    requiredTestFiles: sortedStrings(oracle.requiredTestFiles),
    requiredSymbols: sortedStrings(oracle.requiredSymbols),
    requiredTestAnchors: sortedStrings(oracle.requiredTestAnchors),
    allowedTouchedFiles: sortedStrings(oracle.allowedTouchedFiles),
    forbiddenFiles: sortedStrings(oracle.forbiddenFiles),
    behavioralChecks: [...oracle.behavioralChecks].sort((left, right) => compareText(canonical(left), canonical(right)))
  };
}
function canonicalTasksetCore({ tasksDocument, oraclesDocument, repositoryManifest }) {
  const manifest = canonicalizeGate6RepositoryManifest(repositoryManifest);
  return {
    schemaVersion: TASKSET_SCHEMA_VERSION,
    repositoryManifest: {
      schemaVersion: manifest.schemaVersion,
      repositories: manifest.repositories.map((repository) => ({ ...repository }))
    },
    tasks: tasksDocument.tasks.map(canonicalTask).sort((left, right) => compareText(left.taskId, right.taskId)),
    oracles: oraclesDocument.oracles.map(canonicalOracle).sort((left, right) => compareText(left.taskId, right.taskId))
  };
}
function hashGate6Taskset({ tasksDocument, oraclesDocument, repositoryManifest }) {
  return hashCanonical(canonicalTasksetCore({ tasksDocument, oraclesDocument, repositoryManifest }));
}
function parseJsonDocument(text, code) {
  if (typeof text !== "string") fail(code);
  try { return JSON.parse(text); } catch { fail(code); }
}
function normalizeNearDuplicateId(taskId) { return String(taskId).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normalizeObjective(objective) { return String(objective).toLowerCase().replace(/\s+/g, " ").trim(); }
function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
function assertExactCounts(actual, expected, code) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      fail(code, `${key}: expected ${expected[key] ?? 0}, got ${actual[key] ?? 0}`);
    }
  }
}
function validateDocuments(tasksDocument, oraclesDocument) {
  if (!sameKeys(tasksDocument, TASKS_DOCUMENT_FIELDS)) fail("GATE6_TASKSET_TASKS_DOCUMENT_INVALID");
  if (!sameKeys(oraclesDocument, ORACLES_DOCUMENT_FIELDS)) fail("GATE6_TASKSET_ORACLES_DOCUMENT_INVALID");
  if (tasksDocument.schemaVersion !== TASKSET_SCHEMA_VERSION || oraclesDocument.schemaVersion !== TASKSET_SCHEMA_VERSION) {
    fail("GATE6_TASKSET_SCHEMA_UNSUPPORTED");
  }
  if (!Array.isArray(tasksDocument.tasks) || !Array.isArray(oraclesDocument.oracles)) {
    fail("GATE6_TASKSET_DOCUMENT_ARRAY_INVALID");
  }
}
function validateLock(lock) {
  if (!sameKeys(lock, LOCK_FIELDS)) fail("GATE6_TASKSET_LOCK_INVALID");
  if (lock.schemaVersion !== TASKSET_SCHEMA_VERSION) fail("GATE6_TASKSET_LOCK_SCHEMA_MISMATCH");
  if (lock.frozen !== true) fail("GATE6_TASKSET_NOT_FROZEN");
  if (!Array.isArray(lock.taskFiles) || !Array.isArray(lock.oracleFiles) ||
      lock.taskFiles.length !== TASK_CLASS_IDS.length || lock.oracleFiles.length !== TASK_CLASS_IDS.length) {
    fail("GATE6_TASKSET_LOCK_SHARDS_INVALID");
  }
  if (!isPlainObject(lock.classCounts) || !isPlainObject(lock.difficultyCounts)) {
    fail("GATE6_TASKSET_LOCK_COUNTS_INVALID");
  }
  if (lock.oracleReviewStatus !== ORACLE_REVIEW_STATUS) fail("GATE6_TASKSET_ORACLE_REVIEW_STATUS_INVALID");
  if (lock.oracleMutationPolicy !== ORACLE_MUTATION_POLICY) fail("GATE6_TASKSET_ORACLE_MUTATION_POLICY_INVALID");
}
function validateFrozenGate6Taskset(input) {
  if (!sameKeys(input, BUNDLE_INPUT_FIELDS)) {
    fail(
      Object.prototype.hasOwnProperty.call(input ?? {}, "modelOutput") ||
      Object.prototype.hasOwnProperty.call(input ?? {}, "modelOutputs")
        ? "GATE6_TASKSET_MODEL_OUTPUT_INPUT_FORBIDDEN"
        : "GATE6_TASKSET_BUNDLE_INPUT_INVALID"
    );
  }
  const { tasksDocument, oraclesDocument, repositoryManifest, lock } = input;
  validateDocuments(tasksDocument, oraclesDocument);
  validateLock(lock);
  validateGate6RepositoryManifest(repositoryManifest);
  try { validateGate6Taskset(tasksDocument.tasks); }
  catch (error) { fail("GATE6_TASKSET_PUBLIC_TASK_INVALID", error instanceof Error ? error.message : String(error)); }
  if (tasksDocument.tasks.length < 30 || tasksDocument.tasks.length > 50) {
    fail("GATE6_TASKSET_TASK_COUNT_OUT_OF_RANGE", String(tasksDocument.tasks.length));
  }
  if (TASKSET_SCHEMA_VERSION === "gate6-taskset/v1" && tasksDocument.tasks.length !== V1_EXPECTED_TASK_COUNT) {
    fail("GATE6_TASKSET_V1_TASK_COUNT_INVALID", String(tasksDocument.tasks.length));
  }
  if (oraclesDocument.oracles.length !== tasksDocument.tasks.length) fail("GATE6_TASKSET_ORACLE_COUNT_MISMATCH");

  const manifestById = new Map(repositoryManifest.repositories.map((repository) => [repository.id, repository]));
  const taskById = new Map(tasksDocument.tasks.map((task) => [task.taskId, task]));
  const oracleById = new Map();
  for (const oracle of oraclesDocument.oracles) {
    if (!isPlainObject(oracle) || typeof oracle.taskId !== "string") fail("GATE6_TASKSET_ORACLE_INVALID");
    if (oracleById.has(oracle.taskId)) fail("GATE6_TASKSET_DUPLICATE_ORACLE_ID", oracle.taskId);
    oracleById.set(oracle.taskId, oracle);
  }

  const nearIds = new Map();
  const objectives = new Map();
  for (const task of tasksDocument.tasks) {
    const repository = manifestById.get(task.repositoryId);
    if (!repository) fail("GATE6_TASKSET_REPOSITORY_NOT_FROZEN", task.repositoryId);
    if (repository.commitSha !== task.commitSha) fail("GATE6_TASKSET_REPOSITORY_SHA_MISMATCH", task.taskId);

    const nearKey = normalizeNearDuplicateId(task.taskId);
    const previousNear = nearIds.get(nearKey);
    if (previousNear && previousNear !== task.taskId) {
      fail("GATE6_TASKSET_NEAR_DUPLICATE_TASK_ID", `${previousNear} <> ${task.taskId}`);
    }
    nearIds.set(nearKey, task.taskId);

    const objectiveKey = normalizeObjective(task.objective);
    const previousObjective = objectives.get(objectiveKey);
    if (previousObjective) fail("GATE6_TASKSET_DUPLICATE_OBJECTIVE", `${previousObjective} <> ${task.taskId}`);
    objectives.set(objectiveKey, task.taskId);

    const oracle = oracleById.get(task.taskId);
    if (!oracle) fail("GATE6_TASKSET_ORACLE_MISSING", task.taskId);
    try { validateGate6Oracle(oracle, task); }
    catch (error) { fail("GATE6_TASKSET_ORACLE_INVALID", error instanceof Error ? error.message : String(error)); }
  }
  for (const oracleId of oracleById.keys()) {
    if (!taskById.has(oracleId)) fail("GATE6_TASKSET_ORACLE_WITHOUT_TASK", oracleId);
  }

  const classCounts = countBy(tasksDocument.tasks, (task) => task.taskClass);
  const difficultyCounts = countBy(tasksDocument.tasks, (task) => task.difficulty);
  const repositoryCounts = countBy(tasksDocument.tasks, (task) => task.repositoryId);
  if (TASKSET_SCHEMA_VERSION === "gate6-taskset/v1") {
    const expectedClassCounts = Object.fromEntries(TASK_CLASS_IDS.map((taskClass) => [taskClass, V1_EXPECTED_CLASS_COUNT]));
    assertExactCounts(classCounts, expectedClassCounts, "GATE6_TASKSET_V1_CLASS_DISTRIBUTION_INVALID");
    assertExactCounts(difficultyCounts, V1_EXPECTED_DIFFICULTY_COUNTS, "GATE6_TASKSET_V1_DIFFICULTY_DISTRIBUTION_INVALID");
  }
  const repositoryCount = Object.keys(repositoryCounts).length;
  if (repositoryCount < MIN_REPOSITORY_COUNT) fail("GATE6_TASKSET_REPOSITORY_DIVERSITY_INVALID", String(repositoryCount));
  const maxRepositoryTasks = Math.max(...Object.values(repositoryCounts));
  const maxRepositoryShare = maxRepositoryTasks / tasksDocument.tasks.length;
  if (maxRepositoryShare > MAX_REPOSITORY_SHARE) fail("GATE6_TASKSET_REPOSITORY_SHARE_INVALID", String(maxRepositoryShare));

  const repositoryManifestHash = hashGate6RepositoryManifest(repositoryManifest);
  const tasksetHash = hashGate6Taskset({ tasksDocument, oraclesDocument, repositoryManifest });
  const frozenTasksetHash = FROZEN_TASKSET_HASHES[TASKSET_SCHEMA_VERSION];
  const frozenManifestHash = FROZEN_REPOSITORY_MANIFEST_HASHES[TASKSET_SCHEMA_VERSION];
  if (!frozenTasksetHash || !frozenManifestHash) fail("GATE6_TASKSET_VERSION_NOT_FROZEN", TASKSET_SCHEMA_VERSION);
  if (tasksetHash !== frozenTasksetHash) fail("GATE6_TASKSET_FROZEN_HASH_MISMATCH", `${frozenTasksetHash} != ${tasksetHash}`);
  if (repositoryManifestHash !== frozenManifestHash) {
    fail("GATE6_TASKSET_FROZEN_REPOSITORY_HASH_MISMATCH", `${frozenManifestHash} != ${repositoryManifestHash}`);
  }
  if (lock.taskCount !== tasksDocument.tasks.length) fail("GATE6_TASKSET_LOCK_TASK_COUNT_MISMATCH");
  if (lock.repositoryCount !== repositoryCount) fail("GATE6_TASKSET_LOCK_REPOSITORY_COUNT_MISMATCH");
  assertExactCounts(lock.classCounts, classCounts, "GATE6_TASKSET_LOCK_CLASS_COUNTS_MISMATCH");
  assertExactCounts(lock.difficultyCounts, difficultyCounts, "GATE6_TASKSET_LOCK_DIFFICULTY_COUNTS_MISMATCH");
  if (lock.repositoryManifestHash !== repositoryManifestHash) fail("GATE6_TASKSET_LOCK_REPOSITORY_HASH_MISMATCH");
  if (lock.tasksetHash !== tasksetHash) fail("GATE6_TASKSET_LOCK_HASH_MISMATCH");

  return deepFreeze({
    schemaVersion: TASKSET_SCHEMA_VERSION,
    frozen: true,
    taskCount: tasksDocument.tasks.length,
    repositoryCount,
    classCounts: { ...classCounts },
    difficultyCounts: { ...difficultyCounts },
    repositoryCounts: { ...repositoryCounts },
    maxRepositoryTasks,
    maxRepositoryShare,
    repositoryManifestHash,
    tasksetHash,
    oracleReviewStatus: lock.oracleReviewStatus,
    oracleMutationPolicy: lock.oracleMutationPolicy
  });
}

function loadFrozenGate6Taskset({ rootPath, repositoryManifestPath, lockPath }) {
  const repositoryManifest = parseJsonDocument(readFileSync(repositoryManifestPath, "utf8"), "GATE6_TASKSET_REPOSITORY_JSON_INVALID");
  const lock = parseJsonDocument(readFileSync(lockPath, "utf8"), "GATE6_TASKSET_LOCK_JSON_INVALID");
  validateLock(lock);
  const tasks = [];
  const oracles = [];
  const seenTaskClasses = new Set();
  const seenOracleClasses = new Set();
  for (const relativePath of lock.taskFiles) {
    const shard = parseJsonDocument(
      readFileSync(require("node:path").join(rootPath, relativePath), "utf8"),
      "GATE6_TASKSET_TASKS_JSON_INVALID"
    );
    if (!sameKeys(shard, TASK_SHARD_FIELDS) || shard.schemaVersion !== TASK_SHARD_SCHEMA_VERSION ||
        !TASK_CLASS_IDS.includes(shard.taskClass) || !Array.isArray(shard.tasks) ||
        shard.tasks.some((task) => task.taskClass !== shard.taskClass) || seenTaskClasses.has(shard.taskClass)) {
      fail("GATE6_TASKSET_TASK_SHARD_INVALID", relativePath);
    }
    seenTaskClasses.add(shard.taskClass);
    tasks.push(...shard.tasks);
  }
  for (const relativePath of lock.oracleFiles) {
    const shard = parseJsonDocument(
      readFileSync(require("node:path").join(rootPath, relativePath), "utf8"),
      "GATE6_TASKSET_ORACLES_JSON_INVALID"
    );
    if (!sameKeys(shard, ORACLE_SHARD_FIELDS) || shard.schemaVersion !== ORACLE_SHARD_SCHEMA_VERSION ||
        !TASK_CLASS_IDS.includes(shard.taskClass) || !Array.isArray(shard.oracles) || seenOracleClasses.has(shard.taskClass)) {
      fail("GATE6_TASKSET_ORACLE_SHARD_INVALID", relativePath);
    }
    seenOracleClasses.add(shard.taskClass);
    oracles.push(...shard.oracles);
  }
  if (seenTaskClasses.size !== TASK_CLASS_IDS.length || seenOracleClasses.size !== TASK_CLASS_IDS.length) {
    fail("GATE6_TASKSET_SHARD_CLASS_COVERAGE_INVALID");
  }
  return validateFrozenGate6Taskset({
    tasksDocument: { schemaVersion: TASKSET_SCHEMA_VERSION, tasks },
    oraclesDocument: { schemaVersion: TASKSET_SCHEMA_VERSION, oracles },
    repositoryManifest,
    lock
  });
}

module.exports = {
  FROZEN_REPOSITORY_MANIFEST_HASHES,
  FROZEN_TASKSET_HASHES,
  Gate6TasksetError,
  MAX_REPOSITORY_SHARE,
  MIN_REPOSITORY_COUNT,
  ORACLE_MUTATION_POLICY,
  ORACLE_REVIEW_STATUS,
  TASKSET_SCHEMA_VERSION,
  V1_EXPECTED_DIFFICULTY_COUNTS,
  V1_EXPECTED_TASK_COUNT,
  canonicalTasksetCore,
  hashGate6Taskset,
  loadFrozenGate6Taskset,
  validateFrozenGate6Taskset
};
