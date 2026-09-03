"use strict";

const { readFileSync } = require("node:fs");
const base = require("./gate6-live-checkpoint-v1.cjs");
const verifier = require("./gate6-verifier-provenance.cjs");

const CURRENT_PROVIDER_PROMPT_VERSION = "gate6-live-provider-prompt/v2";
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
  "providerPromptVersion",
  "temperature",
  "maxCompletionTokens",
  "repetitions",
  "filters",
  "experimentConfigHash",
  "samplePlanHash"
]);

function fail(code, detail) {
  throw new base.Gate6CheckpointError(code, detail);
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

function normalizeConstructedIdentity(identity) {
  if (isPlainObject(identity) && !Object.hasOwn(identity, "providerPromptVersion")) {
    return { ...identity, providerPromptVersion: CURRENT_PROVIDER_PROMPT_VERSION };
  }
  return identity;
}

function createCheckpointIdentity({
  reportIdentity,
  experimentConfigHash,
  samplePlanHash,
  structuredOutputMode,
  providerPromptVersion
}) {
  const promptVersion = providerPromptVersion ?? reportIdentity?.providerPromptVersion;
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
    providerPromptVersion: promptVersion,
    temperature: reportIdentity.temperature,
    maxCompletionTokens: reportIdentity.maxCompletionTokens,
    repetitions: reportIdentity.repetitions,
    filters: structuredClone(reportIdentity.filters),
    experimentConfigHash,
    samplePlanHash
  };
  if (!sameKeys(identity, IDENTITY_FIELDS) || typeof identity.providerPromptVersion !== "string" || identity.providerPromptVersion.length === 0) {
    fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  }
  if (!SHA256.test(identity.experimentConfigHash) || !SHA256.test(identity.samplePlanHash)) {
    fail("GATE6_CHECKPOINT_IDENTITY_HASH_INVALID");
  }
  return deepFreeze(identity);
}

function createCheckpoint({ identity, completedSamples, checkpointResumeCount = 0 }) {
  const normalizedIdentity = normalizeConstructedIdentity(identity);
  if (!sameKeys(normalizedIdentity, IDENTITY_FIELDS)) fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  if (!Array.isArray(completedSamples)) fail("GATE6_CHECKPOINT_SAMPLES_INVALID");
  if (!Number.isSafeInteger(checkpointResumeCount) || checkpointResumeCount < 0) {
    fail("GATE6_CHECKPOINT_RESUME_COUNT_INVALID");
  }
  const core = {
    schemaVersion: base.CHECKPOINT_SCHEMA_VERSION,
    researchStatus: base.CHECKPOINT_STATUS,
    promotionEligible: false,
    identity: structuredClone(normalizedIdentity),
    completedSamples: completedSamples.map((sample) => structuredClone(sample)),
    checkpointResumeCount
  };
  return deepFreeze({ ...core, checkpointHash: verifier.hashCanonical(core) });
}

function validateCheckpointShape(checkpoint) {
  if (!sameKeys(checkpoint, CHECKPOINT_FIELDS) || checkpoint.schemaVersion !== base.CHECKPOINT_SCHEMA_VERSION) {
    fail("GATE6_CHECKPOINT_SCHEMA_INVALID");
  }
  if (checkpoint.researchStatus !== base.CHECKPOINT_STATUS || checkpoint.promotionEligible !== false) {
    fail("GATE6_CHECKPOINT_PROMOTION_STATE_INVALID");
  }
  if (!sameKeys(checkpoint.identity, IDENTITY_FIELDS) || typeof checkpoint.identity.providerPromptVersion !== "string" || checkpoint.identity.providerPromptVersion.length === 0) {
    fail("GATE6_CHECKPOINT_IDENTITY_INVALID");
  }
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

function projectIdentity(identity) {
  const { providerPromptVersion, ...projected } = identity;
  return projected;
}

function projectCheckpoint(checkpoint) {
  const core = {
    schemaVersion: checkpoint.schemaVersion,
    researchStatus: checkpoint.researchStatus,
    promotionEligible: checkpoint.promotionEligible,
    identity: projectIdentity(checkpoint.identity),
    completedSamples: structuredClone(checkpoint.completedSamples),
    checkpointResumeCount: checkpoint.checkpointResumeCount
  };
  return { ...core, checkpointHash: verifier.hashCanonical(core) };
}

function validateRestoredSamples({ checkpoint, expectedIdentity, plan, frozen }) {
  validateCheckpointShape(checkpoint);
  assertIdentityMatch(checkpoint.identity, expectedIdentity);
  return base.validateRestoredSamples({
    checkpoint: projectCheckpoint(checkpoint),
    expectedIdentity: projectIdentity(expectedIdentity),
    plan,
    frozen
  });
}

function readCheckpoint(checkpointPath) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(checkpointPath, "utf8")); }
  catch (error) { fail("GATE6_CHECKPOINT_READ_FAILED", error.message); }
  return validateCheckpointShape(parsed);
}

module.exports = {
  ...base,
  CURRENT_PROVIDER_PROMPT_VERSION,
  IDENTITY_FIELDS,
  assertIdentityMatch,
  createCheckpoint,
  createCheckpointIdentity,
  readCheckpoint,
  validateCheckpointShape,
  validateRestoredSamples
};
