"use strict";

const { validateContextSelections } = require("../controlled-coding-pilot-context-selector.cjs");
const {
  DEFINITION_VERSION,
  RUNTIME_BUDGETS,
  V2_DEFINITION_VERSION,
  resolvePilotConfiguration
} = require("./profiles.cjs");
const { canonical } = require("./context.cjs");

const DEFINITION = "pilots/controlled-real-coding-v1/runpod-live-help/task.json";
const V2_DEFINITION = "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json";
const V2_TARGETS = ["packages/worker-contract/src/index.ts", "tests/smoke/contracts.ts"];
const V1_RUNTIME_BUDGET = RUNTIME_BUDGETS.v1_default;
const V2_RUNTIME_BUDGET = RUNTIME_BUDGETS.v2_default;

function invalidDefinition() {
  throw Object.assign(new Error("PILOT_DEFINITION_INVALID"), {
    pilotCode: "PILOT_DEFINITION_INVALID"
  });
}

function validStringArray(value, { nonEmpty = false } = {}) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function validateDefinition(value) {
  const baseKeys = [
    "schemaVersion", "pilotId", "profile", "contextPolicy", "runtimeBudget",
    "verificationProfile", "taskTitle", "taskPrompt", "providerRequirements",
    "sourceRevisionPolicy", "allowedMutationPaths", "allowedReadRoots",
    "forbiddenPaths", "maxChangedFiles", "maxPatchLines",
    "providerCallBudget", "retryBudget", "requiredAssertions"
  ];
  const isV2 = value?.schemaVersion === V2_DEFINITION_VERSION;
  const keys = isV2 ? [...baseKeys, "contextSelections"] : baseKeys;
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical(keys.sort()) ||
    ![DEFINITION_VERSION, V2_DEFINITION_VERSION].includes(value.schemaVersion) ||
    typeof value.pilotId !== "string" || value.pilotId.length === 0 ||
    typeof value.taskTitle !== "string" || value.taskTitle.length === 0 ||
    typeof value.taskPrompt !== "string" || value.taskPrompt.length === 0 ||
    value.sourceRevisionPolicy !== "current-head" ||
    !validStringArray(value.allowedMutationPaths, { nonEmpty: true }) ||
    !validStringArray(value.allowedReadRoots, { nonEmpty: true }) ||
    !validStringArray(value.forbiddenPaths) ||
    !validStringArray(value.providerRequirements) ||
    !validStringArray(value.requiredAssertions, { nonEmpty: true })
  ) invalidDefinition();

  let configuration;
  try {
    configuration = resolvePilotConfiguration(value);
  } catch {
    invalidDefinition();
  }
  if (configuration.contextPolicy.requiresContextSelections) {
    try {
      validateContextSelections(value.contextSelections, {
        requiredPaths: value.allowedMutationPaths,
        allowedReadRoots: value.allowedReadRoots
      });
    } catch {
      invalidDefinition();
    }
  }
  return structuredClone(value);
}

function profileForDefinition(definition) {
  return resolvePilotConfiguration(definition).profile;
}

module.exports = {
  DEFINITION,
  V2_DEFINITION,
  V2_TARGETS,
  V1_RUNTIME_BUDGET,
  V2_RUNTIME_BUDGET,
  invalidDefinition,
  profileForDefinition,
  validateDefinition
};
