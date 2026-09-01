"use strict";

const path = require("node:path");
const { validateGate6Task } = require("./gate6-task-schema.cjs");

const SCHEMA_VERSION = "gate6-oracle/v1";
const ORACLE_FIELDS = Object.freeze([
  "schemaVersion",
  "taskId",
  "requiredImplementationFiles",
  "requiredTestFiles",
  "requiredSymbols",
  "requiredTestAnchors",
  "allowedTouchedFiles",
  "forbiddenFiles",
  "behavioralChecks"
]);
const PUBLIC_TASK_FIELDS = Object.freeze([
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
const GLOB_META = /[*?\[\]{}!]/;

class Gate6OracleError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6OracleError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6OracleError(code, detail);
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

function assertPath(value, label) {
  if (typeof value !== "string" || value.length === 0) fail("GATE6_ORACLE_PATH_INVALID", label);
  if (value.includes("\\") || value.includes("\0") || GLOB_META.test(value)) {
    fail("GATE6_ORACLE_PATH_INVALID", label);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail("GATE6_ORACLE_PATH_INVALID", label);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("GATE6_ORACLE_PATH_INVALID", label);
  }
  return value;
}

function assertUniqueStringArray(value, field, { pathValues = false } = {}) {
  if (!Array.isArray(value)) fail("GATE6_ORACLE_FIELD_INVALID", field);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      fail("GATE6_ORACLE_FIELD_INVALID", `${field}[${index}]`);
    }
    if (pathValues) assertPath(item, `${field}[${index}]`);
    if (seen.has(item)) {
      fail(pathValues ? "GATE6_ORACLE_DUPLICATE_PATH" : "GATE6_ORACLE_DUPLICATE_VALUE", `${field}: ${item}`);
    }
    seen.add(item);
  }
}

function assertBehavioralChecks(value) {
  if (!Array.isArray(value)) fail("GATE6_ORACLE_FIELD_INVALID", "behavioralChecks");
  for (let index = 0; index < value.length; index += 1) {
    const check = value[index];
    if (typeof check === "string") {
      if (check.trim().length === 0) fail("GATE6_ORACLE_FIELD_INVALID", `behavioralChecks[${index}]`);
      continue;
    }
    if (!isPlainObject(check)) fail("GATE6_ORACLE_FIELD_INVALID", `behavioralChecks[${index}]`);
  }
}

function ruleMatchesPath(rule, filePath) {
  if (rule.endsWith("/**")) {
    const root = rule.slice(0, -3);
    return filePath === root || filePath.startsWith(`${root}/`);
  }
  return filePath === rule;
}

function isAllowedChangePath(publicTask, filePath) {
  const allowed = publicTask.authority.allowedChangePaths.some((rule) => ruleMatchesPath(rule, filePath));
  const forbidden = publicTask.authority.forbiddenInspectionPaths.some((rule) => ruleMatchesPath(rule, filePath));
  return allowed && !forbidden;
}

function validateRequiredAuthority(publicTask, oracle) {
  const fields = ["requiredImplementationFiles", "requiredTestFiles", "allowedTouchedFiles"];
  for (const field of fields) {
    for (const filePath of oracle[field]) {
      if (!isAllowedChangePath(publicTask, filePath)) {
        fail("GATE6_ORACLE_REQUIRED_FILE_OUTSIDE_AUTHORITY", `${field}: ${filePath}`);
      }
    }
  }
}

function validateRequiredForbiddenSeparation(oracle) {
  const forbidden = new Set(oracle.forbiddenFiles);
  for (const field of ["requiredImplementationFiles", "requiredTestFiles", "allowedTouchedFiles"]) {
    for (const filePath of oracle[field]) {
      if (forbidden.has(filePath)) {
        fail("GATE6_ORACLE_REQUIRED_FORBIDDEN_CONFLICT", filePath);
      }
    }
  }
}

function validateNoChangeExpectation(publicTask, oracle) {
  if (publicTask.taskClass !== "no_change_needed") return;
  for (const field of ["requiredImplementationFiles", "requiredTestFiles", "allowedTouchedFiles"]) {
    if (oracle[field].length > 0) fail("GATE6_ORACLE_NO_CHANGE_MUTATION_EXPECTATION", field);
  }
}

function validateGate6Oracle(oracle, publicTask) {
  validateGate6Task(publicTask);
  if (!sameKeys(oracle, ORACLE_FIELDS)) fail("GATE6_ORACLE_INVALID");
  if (oracle.schemaVersion !== SCHEMA_VERSION) {
    fail("GATE6_ORACLE_SCHEMA_UNSUPPORTED", String(oracle.schemaVersion));
  }
  if (typeof oracle.taskId !== "string" || oracle.taskId.trim().length === 0) {
    fail("GATE6_ORACLE_TASK_ID_INVALID");
  }
  if (oracle.taskId !== publicTask.taskId) {
    fail("GATE6_ORACLE_TASK_ID_MISMATCH", oracle.taskId);
  }

  assertUniqueStringArray(oracle.requiredImplementationFiles, "requiredImplementationFiles", { pathValues: true });
  assertUniqueStringArray(oracle.requiredTestFiles, "requiredTestFiles", { pathValues: true });
  assertUniqueStringArray(oracle.requiredSymbols, "requiredSymbols");
  assertUniqueStringArray(oracle.requiredTestAnchors, "requiredTestAnchors");
  assertUniqueStringArray(oracle.allowedTouchedFiles, "allowedTouchedFiles", { pathValues: true });
  assertUniqueStringArray(oracle.forbiddenFiles, "forbiddenFiles", { pathValues: true });
  assertBehavioralChecks(oracle.behavioralChecks);

  validateRequiredAuthority(publicTask, oracle);
  validateRequiredForbiddenSeparation(oracle);
  validateNoChangeExpectation(publicTask, oracle);
  return oracle;
}

function clonePublicAuthority(authority) {
  const result = {};
  for (const field of AUTHORITY_FIELDS) result[field] = Object.freeze([...authority[field]]);
  return Object.freeze(result);
}

function createPublicGate6Task(taskLike) {
  const candidate = {};
  for (const field of PUBLIC_TASK_FIELDS) {
    if (field === "candidateFiles") candidate.candidateFiles = [...taskLike.candidateFiles];
    else if (field === "authority") candidate.authority = {
      allowedInspectionPaths: [...taskLike.authority.allowedInspectionPaths],
      forbiddenInspectionPaths: [...taskLike.authority.forbiddenInspectionPaths],
      allowedChangePaths: [...taskLike.authority.allowedChangePaths]
    };
    else candidate[field] = taskLike[field];
  }
  validateGate6Task(candidate);
  candidate.candidateFiles = Object.freeze(candidate.candidateFiles);
  candidate.authority = clonePublicAuthority(candidate.authority);
  return Object.freeze(candidate);
}

function createGate6ProviderPayload(taskLike) {
  return Object.freeze({ task: createPublicGate6Task(taskLike) });
}

function stringifyGate6ProviderPrompt(taskLike) {
  return JSON.stringify(createGate6ProviderPayload(taskLike));
}

function createGate6PublicReport({ task, status, summary }) {
  return Object.freeze({
    task: createPublicGate6Task(task),
    status: typeof status === "string" ? status : "unknown",
    summary: typeof summary === "string" ? summary : ""
  });
}

function createGate6ProviderDebugRecord({ task, provider, requestId }) {
  const publicTask = createPublicGate6Task(task);
  return Object.freeze({
    taskId: publicTask.taskId,
    repositoryId: publicTask.repositoryId,
    taskClass: publicTask.taskClass,
    provider: typeof provider === "string" ? provider : "unknown",
    requestId: typeof requestId === "string" ? requestId : "",
    candidateFileCount: publicTask.candidateFiles.length
  });
}

module.exports = {
  Gate6OracleError,
  ORACLE_FIELDS,
  PUBLIC_TASK_FIELDS,
  SCHEMA_VERSION,
  createGate6ProviderDebugRecord,
  createGate6ProviderPayload,
  createGate6PublicReport,
  createPublicGate6Task,
  stringifyGate6ProviderPrompt,
  validateGate6Oracle
};
