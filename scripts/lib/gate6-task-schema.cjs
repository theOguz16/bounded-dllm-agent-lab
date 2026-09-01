"use strict";

const path = require("node:path");

const SCHEMA_VERSION = "gate6-task/v1";
const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
const TASK_CLASSES = Object.freeze(["bugfix_with_regression"]);
const REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "taskId",
  "repositoryId",
  "commitSha",
  "taskClass",
  "difficulty",
  "objective",
  "candidateFiles",
  "authority"
]);
const AUTHORITY_FIELDS = Object.freeze([
  "allowedInspectionPaths",
  "forbiddenInspectionPaths",
  "allowedChangePaths"
]);
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY_ID = /^[^/\s]+\/[^/\s]+$/;
const GLOB_META = /[*?\[\]{}!]/;

class Gate6TaskSchemaError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6TaskSchemaError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6TaskSchemaError(code, detail);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOwn(object, field, code) {
  if (!Object.prototype.hasOwnProperty.call(object, field)) fail(code, field);
}

function assertNonEmptyString(value, code, detail) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code, detail);
}

function assertPath(pathValue, { allowAuthorityRule = false, code, detail }) {
  if (typeof pathValue !== "string" || pathValue.length === 0) fail(code, detail);
  if (pathValue.includes("\\") || pathValue.includes("\0")) fail(code, detail);

  let value = pathValue;
  if (allowAuthorityRule && value.endsWith("/**")) {
    value = value.slice(0, -3);
  }

  if (!value || GLOB_META.test(value)) fail(code, detail);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail(code, detail);

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(code, detail);
  }

  return pathValue;
}

function assertPathArray(value, { field, allowAuthorityRule = false }) {
  if (!Array.isArray(value)) fail("GATE6_TASK_AUTHORITY_FIELD_INVALID", field);
  for (let index = 0; index < value.length; index += 1) {
    assertPath(value[index], {
      allowAuthorityRule,
      code: "GATE6_TASK_PATH_INVALID",
      detail: `${field}[${index}]`
    });
  }
}

function ruleMatchesPath(rule, candidatePath) {
  if (rule.endsWith("/**")) {
    const root = rule.slice(0, -3);
    return candidatePath === root || candidatePath.startsWith(`${root}/`);
  }
  return candidatePath === rule;
}

function assertCandidateAuthority(candidatePath, authority) {
  const allowed = authority.allowedInspectionPaths.some((rule) => ruleMatchesPath(rule, candidatePath));
  const forbidden = authority.forbiddenInspectionPaths.some((rule) => ruleMatchesPath(rule, candidatePath));
  if (!allowed || forbidden) {
    fail("GATE6_TASK_CANDIDATE_OUTSIDE_AUTHORITY", candidatePath);
  }
}

function validateGate6Task(task) {
  if (!isPlainObject(task)) fail("GATE6_TASK_INVALID", "task must be a plain object");

  for (const field of REQUIRED_FIELDS) {
    requireOwn(task, field, "GATE6_TASK_REQUIRED_FIELD_MISSING");
  }

  if (task.schemaVersion !== SCHEMA_VERSION) {
    fail("GATE6_TASK_SCHEMA_VERSION_UNSUPPORTED", String(task.schemaVersion));
  }

  assertNonEmptyString(task.taskId, "GATE6_TASK_ID_INVALID", "taskId");
  assertNonEmptyString(task.repositoryId, "GATE6_TASK_REPOSITORY_ID_INVALID", "repositoryId");
  if (!REPOSITORY_ID.test(task.repositoryId)) {
    fail("GATE6_TASK_REPOSITORY_ID_INVALID", task.repositoryId);
  }
  if (typeof task.commitSha !== "string" || !SHA40.test(task.commitSha)) {
    fail("GATE6_TASK_COMMIT_SHA_INVALID", String(task.commitSha));
  }
  if (!TASK_CLASSES.includes(task.taskClass)) {
    fail("GATE6_TASK_CLASS_UNSUPPORTED", String(task.taskClass));
  }
  if (!DIFFICULTIES.includes(task.difficulty)) {
    fail("GATE6_TASK_DIFFICULTY_UNSUPPORTED", String(task.difficulty));
  }
  assertNonEmptyString(task.objective, "GATE6_TASK_OBJECTIVE_EMPTY", "objective");

  if (!Array.isArray(task.candidateFiles)) {
    fail("GATE6_TASK_CANDIDATE_FILES_INVALID", "candidateFiles");
  }
  if (!isPlainObject(task.authority)) {
    fail("GATE6_TASK_AUTHORITY_INVALID", "authority");
  }
  for (const field of AUTHORITY_FIELDS) {
    requireOwn(task.authority, field, "GATE6_TASK_AUTHORITY_FIELD_MISSING");
    assertPathArray(task.authority[field], { field: `authority.${field}`, allowAuthorityRule: true });
  }

  const seenCandidates = new Set();
  for (let index = 0; index < task.candidateFiles.length; index += 1) {
    const candidatePath = assertPath(task.candidateFiles[index], {
      code: "GATE6_TASK_PATH_INVALID",
      detail: `candidateFiles[${index}]`
    });
    if (seenCandidates.has(candidatePath)) {
      fail("GATE6_TASK_CANDIDATE_DUPLICATE", candidatePath);
    }
    seenCandidates.add(candidatePath);
    assertCandidateAuthority(candidatePath, task.authority);
  }

  return task;
}

function validateGate6Taskset(tasks) {
  if (!Array.isArray(tasks)) fail("GATE6_TASKSET_INVALID", "taskset must be an array");

  const seenTaskIds = new Set();
  for (const task of tasks) {
    validateGate6Task(task);
    if (seenTaskIds.has(task.taskId)) {
      fail("GATE6_TASKSET_DUPLICATE_TASK_ID", task.taskId);
    }
    seenTaskIds.add(task.taskId);
  }

  return tasks;
}

module.exports = {
  AUTHORITY_FIELDS,
  DIFFICULTIES,
  Gate6TaskSchemaError,
  REQUIRED_FIELDS,
  SCHEMA_VERSION,
  TASK_CLASSES,
  validateGate6Task,
  validateGate6Taskset
};
