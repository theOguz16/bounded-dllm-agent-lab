"use strict";

const { createHash } = require("node:crypto");

const PRECONDITION_SCHEMA = "gate6-preconditions/v1";
const ATTESTATION_SCHEMA = "gate6-precondition-attestation/v1";
const FREEZE_SCHEMA = "gate6-precondition-freeze/v1";
const EXPECTED_TASK_COUNT = 42;
const EXPECTED_REPOSITORY_COUNT = 14;

class Gate6PreconditionFreezeError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6PreconditionFreezeError";
    this.code = code;
  }
}

function fail(code, detail) { throw new Gate6PreconditionFreezeError(code, detail); }
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value) {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("GATE6_PRECONDITION_CANONICAL_INVALID");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isPlainObject(value)) fail("GATE6_PRECONDITION_CANONICAL_INVALID");
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hash(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function orderedJsonHash(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateSpec(preconditions, tasks) {
  if (!isPlainObject(preconditions) || preconditions.schemaVersion !== PRECONDITION_SCHEMA || !Array.isArray(preconditions.entries)) fail("GATE6_PRECONDITION_SPEC_INVALID");
  if (!Array.isArray(tasks) || tasks.length !== EXPECTED_TASK_COUNT) fail("GATE6_PRECONDITION_TASKSET_SIZE_INVALID");
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const entries = new Map();
  for (const entry of preconditions.entries) {
    if (!isPlainObject(entry) || typeof entry.taskId !== "string") fail("GATE6_PRECONDITION_ENTRY_INVALID");
    if (entries.has(entry.taskId)) fail("GATE6_PRECONDITION_DUPLICATE_TASK", entry.taskId);
    const task = taskById.get(entry.taskId);
    if (!task) fail("GATE6_PRECONDITION_UNKNOWN_TASK", entry.taskId);
    const expected = task.taskClass === "no_change_needed" ? "pass" : "fail";
    if (entry.baselineExpected !== expected) fail("GATE6_PRECONDITION_EXPECTATION_INVALID", entry.taskId);
    if (!isPlainObject(entry.acceptanceCheck) || entry.acceptanceCheck.type !== "node_probe" || entry.acceptanceCheck.probeId !== entry.taskId) {
      fail("GATE6_PRECONDITION_ACCEPTANCE_INVALID", entry.taskId);
    }
    if (expected === "pass" && entry.faultInjection !== null) fail("GATE6_PRECONDITION_NO_CHANGE_FAULT_FORBIDDEN", entry.taskId);
    if (expected === "fail" && (!isPlainObject(entry.faultInjection) || entry.faultInjection.type !== "rename_primary_required_symbol")) {
      fail("GATE6_PRECONDITION_MUTATION_FAULT_REQUIRED", entry.taskId);
    }
    entries.set(entry.taskId, entry);
  }
  if (entries.size !== EXPECTED_TASK_COUNT) fail("GATE6_PRECONDITION_COVERAGE_INVALID", `${entries.size}/${EXPECTED_TASK_COUNT}`);
  return entries;
}

function validateAttestations({ preconditions, tasks, repositories, attestations }) {
  const entries = validateSpec(preconditions, tasks);
  if (!Array.isArray(repositories) || repositories.length !== EXPECTED_REPOSITORY_COUNT) fail("GATE6_PRECONDITION_REPOSITORY_COUNT_INVALID");
  if (!Array.isArray(attestations) || attestations.length !== EXPECTED_REPOSITORY_COUNT) fail("GATE6_PRECONDITION_ATTESTATION_COUNT_INVALID");
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const attestationByRepository = new Map();
  const resultByTask = new Map();
  let runnerHash;
  let probeCatalogHash;

  for (const attestation of attestations) {
    if (!isPlainObject(attestation) || attestation.schemaVersion !== ATTESTATION_SCHEMA) fail("GATE6_PRECONDITION_ATTESTATION_INVALID");
    if (attestationByRepository.has(attestation.repositoryId)) fail("GATE6_PRECONDITION_DUPLICATE_ATTESTATION", attestation.repositoryId);
    const repository = repositoryById.get(attestation.repositoryId);
    if (!repository || repository.commitSha !== attestation.commitSha) fail("GATE6_PRECONDITION_ATTESTATION_REPOSITORY_MISMATCH", attestation.repositoryId);
    if (attestation.acceptanceType !== "node_probe" || !Array.isArray(attestation.results)) fail("GATE6_PRECONDITION_ATTESTATION_COMMAND_INVALID", attestation.repositoryId);
    for (const field of ["runnerHash", "probeCatalogHash"]) {
      if (typeof attestation[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(attestation[field])) fail("GATE6_PRECONDITION_ATTESTATION_CODE_HASH_INVALID", `${attestation.repositoryId}:${field}`);
    }
    runnerHash ??= attestation.runnerHash;
    probeCatalogHash ??= attestation.probeCatalogHash;
    if (runnerHash !== attestation.runnerHash || probeCatalogHash !== attestation.probeCatalogHash) fail("GATE6_PRECONDITION_ATTESTATION_CODE_HASH_DIVERGED", attestation.repositoryId);
    const { attestationHash, ...core } = attestation;
    if (attestationHash !== orderedJsonHash(core)) fail("GATE6_PRECONDITION_ATTESTATION_HASH_INVALID", attestation.repositoryId);

    for (const result of attestation.results) {
      if (!isPlainObject(result) || typeof result.taskId !== "string") fail("GATE6_PRECONDITION_RESULT_INVALID");
      if (resultByTask.has(result.taskId)) fail("GATE6_PRECONDITION_DUPLICATE_RESULT", result.taskId);
      const entry = entries.get(result.taskId);
      if (!entry) fail("GATE6_PRECONDITION_RESULT_UNKNOWN_TASK", result.taskId);
      if (result.repositoryId !== attestation.repositoryId || result.commitSha !== attestation.commitSha) fail("GATE6_PRECONDITION_RESULT_REPOSITORY_MISMATCH", result.taskId);
      if (result.probeId !== entry.acceptanceCheck.probeId) fail("GATE6_PRECONDITION_PROBE_MISMATCH", result.taskId);
      if (result.cleanAcceptanceExitCode !== 0) fail("GATE6_PRECONDITION_CLEAN_BASELINE_NOT_PASSING", result.taskId);
      if (result.baselineExpected !== entry.baselineExpected || result.baselineObserved !== entry.baselineExpected) fail("GATE6_PRECONDITION_BASELINE_EXPECTATION_MISMATCH", result.taskId);
      if (!isPlainObject(result.evidence) || !Array.isArray(result.evidence.testFiles) || !Array.isArray(result.evidence.behavioralChecks) || result.evidence.behavioralChecks.length === 0) {
        fail("GATE6_PRECONDITION_BEHAVIOR_EVIDENCE_MISSING", result.taskId);
      }
      if (entry.baselineExpected === "pass") {
        if (result.faultInjection !== null || result.injectedAcceptanceExitCode !== null) fail("GATE6_PRECONDITION_NO_CHANGE_RESULT_INVALID", result.taskId);
      } else {
        if (typeof result.injectedAcceptanceExitCode !== "number" || result.injectedAcceptanceExitCode === 0) fail("GATE6_PRECONDITION_MUTATION_DID_NOT_FAIL", result.taskId);
        const fault = result.faultInjection;
        if (!isPlainObject(fault) || fault.type !== "rename_primary_required_symbol" || typeof fault.beforeBlobSha !== "string" || !/^[0-9a-f]{40}$/.test(fault.beforeBlobSha)) {
          fail("GATE6_PRECONDITION_FAULT_HASH_BINDING_INVALID", result.taskId);
        }
        for (const field of ["beforeContentHash", "afterContentHash", "injectionId"]) {
          if (typeof fault[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(fault[field])) fail("GATE6_PRECONDITION_FAULT_HASH_BINDING_INVALID", `${result.taskId}:${field}`);
        }
        if (fault.beforeContentHash === fault.afterContentHash) fail("GATE6_PRECONDITION_FAULT_NOOP", result.taskId);
      }
      resultByTask.set(result.taskId, result);
    }
    attestationByRepository.set(attestation.repositoryId, attestation);
  }

  if (resultByTask.size !== EXPECTED_TASK_COUNT) fail("GATE6_PRECONDITION_RESULT_COVERAGE_INVALID", `${resultByTask.size}/${EXPECTED_TASK_COUNT}`);
  for (const task of tasks) if (!resultByTask.has(task.taskId)) fail("GATE6_PRECONDITION_RESULT_MISSING", task.taskId);
  const canonicalAttestations = [...attestations].sort((a, b) => compareText(a.repositoryId, b.repositoryId));
  const freezeCore = {
    schemaVersion: FREEZE_SCHEMA,
    taskCount: EXPECTED_TASK_COUNT,
    repositoryCount: EXPECTED_REPOSITORY_COUNT,
    passBaselineCount: tasks.filter((task) => task.taskClass === "no_change_needed").length,
    failBaselineCount: tasks.filter((task) => task.taskClass !== "no_change_needed").length,
    preconditionSpecHash: hash(preconditions),
    runnerHash,
    probeCatalogHash,
    attestationHashes: canonicalAttestations.map((attestation) => ({ repositoryId: attestation.repositoryId, attestationHash: attestation.attestationHash }))
  };
  return deepFreeze({ ...freezeCore, preconditionAttestationHash: hash(freezeCore) });
}

module.exports = { ATTESTATION_SCHEMA, EXPECTED_REPOSITORY_COUNT, EXPECTED_TASK_COUNT, FREEZE_SCHEMA, Gate6PreconditionFreezeError, PRECONDITION_SCHEMA, validateAttestations };
