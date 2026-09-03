"use strict";

const { createHash } = require("node:crypto");
const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const verifier = require("./gate6-verifier-provenance.cjs");
const { validateObservation } = require("./gate6-comparative-report.cjs");

const CHECKPOINT_SCHEMA_VERSION = "gate6-live-checkpoint/v1";
const CHECKPOINT_STATUS = "incomplete_live_checkpoint";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CHECKPOINT_FIELDS = Object.freeze([
  "schemaVersion",
  "researchStatus",
  "promotionEligible",
  "identity",
  "completedSamples",
  "checkpointResumeCount",
  "checkpointHash"
]);
const IDENTITY_FIELDS = Object.freeze([
  "sourceCommit",
  "tasksetVersion",
  "tasksetHash",
  "benchmarkSemanticsHash",
  "repositoryManifestHash",
  "preconditionAttestationHash",
  "model",
  "endpointClass",
  "structuredOutputMode",
  "temperature",
  "maxCompletionTokens",
  "repetitions",
  "filters",
  "experimentConfigHash",
  "samplePlanHash"
]);
const SAMPLE_FIELDS = Object.freeze(["taskId", "strategy", "repetition", "observation", "receipt", "outcome"]);

class Gate6CheckpointError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6CheckpointError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6CheckpointError(code, detail);
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function checkpointCore(checkpoint) {
  const { checkpointHash, ...core } = checkpoint;
  return core;
}

function sampleKey(value) {
  return `${value.taskId}\0${value.strategy}\0${value.repetition}`;
}

function sampleIdentity(sample) {
  return Object.freeze({
    taskId: sample.task.taskId,
    strategy: sample.strategy,
    repetition: sample.repetition
  });
}

function hashSamplePlan(plan) {
  return verifier.hashCanonical(plan.samples.map((sample) => sampleIdentity(sample)));
}

function createCheckpointIdentity({ reportIdentity, experimentConfigHash, samplePlanHash, structuredOutputMode }) {
  const identity = {
    sourceCommit: reportIdentity.sourceCommit,
    tasksetVersion: reportIdentity.tasksetVersion,
    tasksetHash: reportIdentity.tasksetHash,
    benchmarkSemanticsHash: reportIdentity.benchmarkSemanticsHash,
    repositoryManifestHash: reportIdentity.repositoryManifestHash,
    preconditionAttestationHash: reportIdentity.preconditionAttestationHash,
    model: reportIdentity.model,
    endpointClass: reportIdentity.endpointClass,
    structuredOutputMode,
    temperature: reportIdentity.temperature,
    maxCompletionTokens: reportIdentity.maxCompletionTokens,
    repetitions: reportIdentity.repetitions,
    filters: structuredClone(reportIdentity.filters),
    experimentConfigHash,
    samplePlanHash
  };
  if (!sameKeys(identity, IDENTITY_FIELDS)) fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  if (!SHA256.test(identity.experimentConfigHash) || !SHA256.test(identity.samplePlanHash)) {
    fail("GATE6_CHECKPOINT_IDENTITY_HASH_INVALID");
  }
  return deepFreeze(identity);
}

function createCheckpoint({ identity, completedSamples, checkpointResumeCount = 0 }) {
  if (!sameKeys(identity, IDENTITY_FIELDS)) fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  if (!Array.isArray(completedSamples)) fail("GATE6_CHECKPOINT_SAMPLES_INVALID");
  if (!Number.isSafeInteger(checkpointResumeCount) || checkpointResumeCount < 0) {
    fail("GATE6_CHECKPOINT_RESUME_COUNT_INVALID");
  }
  const core = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    researchStatus: CHECKPOINT_STATUS,
    promotionEligible: false,
    identity: structuredClone(identity),
    completedSamples: completedSamples.map((sample) => structuredClone(sample)),
    checkpointResumeCount
  };
  return deepFreeze({ ...core, checkpointHash: verifier.hashCanonical(core) });
}

function validateCheckpointShape(checkpoint) {
  if (!sameKeys(checkpoint, CHECKPOINT_FIELDS) || checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    fail("GATE6_CHECKPOINT_SCHEMA_INVALID");
  }
  if (checkpoint.researchStatus !== CHECKPOINT_STATUS || checkpoint.promotionEligible !== false) {
    fail("GATE6_CHECKPOINT_PROMOTION_STATE_INVALID");
  }
  if (!sameKeys(checkpoint.identity, IDENTITY_FIELDS)) fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  if (!Array.isArray(checkpoint.completedSamples)) fail("GATE6_CHECKPOINT_SAMPLES_INVALID");
  if (!Number.isSafeInteger(checkpoint.checkpointResumeCount) || checkpoint.checkpointResumeCount < 0) {
    fail("GATE6_CHECKPOINT_RESUME_COUNT_INVALID");
  }
  if (!SHA256.test(checkpoint.checkpointHash) || checkpoint.checkpointHash !== verifier.hashCanonical(checkpointCore(checkpoint))) {
    fail("GATE6_CHECKPOINT_HASH_MISMATCH");
  }
  return checkpoint;
}

function assertIdentityMatch(actual, expected) {
  if (verifier.stableStringify(actual) !== verifier.stableStringify(expected)) {
    for (const field of IDENTITY_FIELDS) {
      if (verifier.stableStringify(actual?.[field]) !== verifier.stableStringify(expected?.[field])) {
        fail("GATE6_CHECKPOINT_IDENTITY_MISMATCH", field);
      }
    }
    fail("GATE6_CHECKPOINT_IDENTITY_MISMATCH");
  }
  return true;
}

function validateOutcome(sample, receipt) {
  const outcome = sample.outcome;
  if (!isPlainObject(outcome)) fail("GATE6_CHECKPOINT_OUTCOME_INVALID", sampleKey(sample));
  const report = receipt.harnessReport;
  const derived = verifier.deriveHarnessOutcome(report);
  if (outcome.failureCode !== report.failureCode ||
      outcome.failureDomain !== report.failureDomain ||
      outcome.providerFailureCode !== report.providerFailureCode ||
      outcome.modelCapabilityFailure !== report.modelCapabilityFailure ||
      outcome.acceptancePassed !== report.metrics.acceptancePassed) {
    fail("GATE6_CHECKPOINT_OUTCOME_PROVENANCE_MISMATCH", sampleKey(sample));
  }
  if (derived.authorityViolation || sample.observation.authorityViolation) {
    fail("GATE6_CHECKPOINT_RESTORED_AUTHORITY_VIOLATION", sampleKey(sample));
  }
  return true;
}

function validateRestoredSamples({ checkpoint, expectedIdentity, plan, frozen }) {
  validateCheckpointShape(checkpoint);
  assertIdentityMatch(checkpoint.identity, expectedIdentity);
  const planKeys = new Set(plan.samples.map((sample) => sampleKey(sampleIdentity(sample))));
  const seen = new Set();
  const observations = [];
  const receipts = [];
  const restored = new Map();
  for (const sample of checkpoint.completedSamples) {
    if (!sameKeys(sample, SAMPLE_FIELDS)) fail("GATE6_CHECKPOINT_SAMPLE_INVALID");
    const key = sampleKey(sample);
    if (seen.has(key)) fail("GATE6_CHECKPOINT_DUPLICATE_SAMPLE", key);
    seen.add(key);
    if (!planKeys.has(key)) fail("GATE6_CHECKPOINT_SAMPLE_OUTSIDE_PLAN", key);
    let observation;
    try { observation = validateObservation(sample.observation); }
    catch (error) { fail("GATE6_CHECKPOINT_OBSERVATION_INVALID", `${key}:${error.code ?? error.message}`); }
    if (observation.taskId !== sample.taskId || observation.strategy !== sample.strategy || observation.repetition !== sample.repetition) {
      fail("GATE6_CHECKPOINT_OBSERVATION_IDENTITY_MISMATCH", key);
    }
    observations.push(observation);
    receipts.push(sample.receipt);
    restored.set(key, deepFreeze({
      observation: structuredClone(observation),
      receipt: structuredClone(sample.receipt),
      outcome: structuredClone(sample.outcome)
    }));
  }
  try { verifier.validateSampleReceipts({ observations, sampleReceipts: receipts, frozen }); }
  catch (error) { fail("GATE6_CHECKPOINT_RECEIPT_REVALIDATION_FAILED", error.code ?? error.message); }
  for (const sample of checkpoint.completedSamples) validateOutcome(sample, sample.receipt);
  return deepFreeze({ restored, checkpointResumeCount: checkpoint.checkpointResumeCount });
}

function readCheckpoint(checkpointPath) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(checkpointPath, "utf8")); }
  catch (error) { fail("GATE6_CHECKPOINT_READ_FAILED", error.message); }
  return validateCheckpointShape(parsed);
}

function atomicWriteCheckpoint(checkpointPath, checkpoint, hooks = {}) {
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const tempPath = `${checkpointPath}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tempPath, "w", 0o600);
    const payload = `${JSON.stringify(checkpoint, null, 2)}\n`;
    writeSync(fd, payload, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (typeof hooks.beforeRename === "function") hooks.beforeRename({ tempPath, checkpointPath });
    renameSync(tempPath, checkpointPath);
    try {
      const directoryFd = openSync(path.dirname(checkpointPath), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch {}
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    throw error;
  }
  return checkpoint;
}

function loadInstrumentedCore(corePath) {
  let source = readFileSync(corePath, "utf8");
  const original = `    for (const sample of plan.samples) {\n      const result = await executeSample({\n        sample,\n        oracle: oracleById.get(sample.task.taskId),\n        frozen,\n        freezeDocument,\n        provider,\n        providerConfig,\n        workspaceFactory,\n        testRunner: dependencies.relevantTestRunner ?? relevantTestRunner,\n        acceptance: dependencies.acceptanceRunner ?? acceptanceRunner,\n        contextResolver: dependencies.contextResolver ?? resolveContext,\n        escalationResolver: dependencies.escalationResolver ?? resolveEscalatingContext\n      });\n      observations.push(result.observation);\n      receipts.push(result.receipt);\n      sampleOutcomes.push(Object.freeze({\n        taskId: sample.task.taskId,\n        strategy: sample.strategy,\n        repetition: sample.repetition,\n        ...result.outcome\n      }));\n    }`;
  const replacement = `    for (const sample of plan.samples) {\n      const restored = typeof dependencies.restoreSample === \"function\"\n        ? await dependencies.restoreSample({ sample, plan, frozen, sourceCommit, providerConfig })\n        : null;\n      const result = restored ?? await executeSample({\n        sample,\n        oracle: oracleById.get(sample.task.taskId),\n        frozen,\n        freezeDocument,\n        provider,\n        providerConfig,\n        workspaceFactory,\n        testRunner: dependencies.relevantTestRunner ?? relevantTestRunner,\n        acceptance: dependencies.acceptanceRunner ?? acceptanceRunner,\n        contextResolver: dependencies.contextResolver ?? resolveContext,\n        escalationResolver: dependencies.escalationResolver ?? resolveEscalatingContext\n      });\n      observations.push(result.observation);\n      receipts.push(result.receipt);\n      const completedOutcome = Object.freeze({\n        taskId: sample.task.taskId,\n        strategy: sample.strategy,\n        repetition: sample.repetition,\n        ...result.outcome\n      });\n      sampleOutcomes.push(completedOutcome);\n      if (restored === null && typeof dependencies.onSampleCompleted === \"function\") {\n        await dependencies.onSampleCompleted({\n          sample, plan, frozen, sourceCommit, providerConfig,\n          observation: result.observation, receipt: result.receipt, outcome: completedOutcome\n        });\n      }\n    }`;
  if (!source.includes(original)) fail("GATE6_CHECKPOINT_CORE_INSTRUMENTATION_MISMATCH");
  source = source.replace(original, replacement);
  const loaded = new Module(corePath, module);
  loaded.filename = corePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(corePath));
  loaded._compile(source, corePath);
  return loaded.exports;
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_STATUS,
  Gate6CheckpointError,
  atomicWriteCheckpoint,
  assertIdentityMatch,
  createCheckpoint,
  createCheckpointIdentity,
  hashSamplePlan,
  loadInstrumentedCore,
  readCheckpoint,
  sampleIdentity,
  sampleKey,
  validateCheckpointShape,
  validateRestoredSamples
};
