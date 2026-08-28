#!/usr/bin/env node
"use strict";

const DEFINITION_VERSION = "bounded.controlled-coding-pilot/v1";
const V2_DEFINITION_VERSION = "bounded.controlled-coding-pilot/v2";

const RUNTIME_BUDGETS = Object.freeze({
  v1_default: Object.freeze({
    modelContextTokenLimit: 16_384,
    executionRuntimeMs: 120_000,
    executorOutputTokenLimit: 6_144,
    providerTimeoutMs: 45_000,
    providerMaxOutputTokens: 1_024
  }),
  v2_default: Object.freeze({
    modelContextTokenLimit: 32_768,
    executionRuntimeMs: 270_000,
    executorOutputTokenLimit: 6_144,
    providerTimeoutMs: 250_000,
    providerMaxOutputTokens: 6_144
  })
});

const PROFILES = Object.freeze({
  controlled_help_copy: Object.freeze({
    schemaVersions: Object.freeze([DEFINITION_VERSION]),
    providerMode: "controlled_help_copy",
    executorMaxChangedFiles: 1,
    maxChangedFilesCap: 2,
    maxPatchLinesCap: 120,
    providerCallBudgetCap: 1,
    retryBudgetCap: 1
  }),
  bounded_text_edits: Object.freeze({
    schemaVersions: Object.freeze([V2_DEFINITION_VERSION]),
    providerMode: "bounded_text_edits",
    executorMaxChangedFiles: 2,
    maxChangedFilesCap: 2,
    maxPatchLinesCap: 120,
    providerCallBudgetCap: 1,
    retryBudgetCap: 0,
    requiredForbiddenPaths: Object.freeze([
      "package.json", "package-lock.json", "dist", ".github", "docs",
      "pilots", "scripts", "apps", "bounded-agent.policy.yml"
    ])
  })
});

const CONTEXT_POLICIES = Object.freeze({
  controlled_help_anchor_v1: Object.freeze({
    schemaVersions: Object.freeze([DEFINITION_VERSION]),
    requiresContextSelections: false
  }),
  task_context_selections_v1: Object.freeze({
    schemaVersions: Object.freeze([V2_DEFINITION_VERSION]),
    requiresContextSelections: true
  })
});

const VERIFICATION_STAGES = Object.freeze([
  "typecheck",
  "build",
  "test_smoke",
  "help_acceptance",
  "normal_missing_env",
  "runpod_proxy_smoke",
  "request_id_acceptance",
  "local_json_schema_acceptance"
]);
const VERIFICATION_STAGE_SET = new Set(VERIFICATION_STAGES);

function invalidDefinition() {
  throw Object.assign(new Error("PILOT_DEFINITION_INVALID"), {
    pilotCode: "PILOT_DEFINITION_INVALID"
  });
}

function resolveNamed(registry, id) {
  if (typeof id !== "string" || !Object.hasOwn(registry, id)) invalidDefinition();
  return registry[id];
}

function resolveVerificationProfile(stageIds) {
  if (!Array.isArray(stageIds) || stageIds.length === 0) invalidDefinition();
  if (new Set(stageIds).size !== stageIds.length) invalidDefinition();
  for (const stageId of stageIds) {
    if (typeof stageId !== "string" || !VERIFICATION_STAGE_SET.has(stageId)) {
      invalidDefinition();
    }
  }
  return [...stageIds];
}

function resolvePilotConfiguration(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    invalidDefinition();
  }
  const profile = resolveNamed(PROFILES, definition.profile);
  const contextPolicy = resolveNamed(CONTEXT_POLICIES, definition.contextPolicy);
  const runtimeBudget = resolveNamed(RUNTIME_BUDGETS, definition.runtimeBudget);
  const verificationProfile = resolveVerificationProfile(definition.verificationProfile);

  if (!profile.schemaVersions.includes(definition.schemaVersion)) invalidDefinition();
  if (!contextPolicy.schemaVersions.includes(definition.schemaVersion)) invalidDefinition();
  if (
    !Number.isSafeInteger(definition.maxChangedFiles) || definition.maxChangedFiles < 1 ||
    definition.maxChangedFiles > profile.maxChangedFilesCap ||
    !Number.isSafeInteger(definition.maxPatchLines) || definition.maxPatchLines < 1 ||
    definition.maxPatchLines > profile.maxPatchLinesCap ||
    !Number.isSafeInteger(definition.providerCallBudget) || definition.providerCallBudget < 1 ||
    definition.providerCallBudget > profile.providerCallBudgetCap ||
    !Number.isSafeInteger(definition.retryBudget) || definition.retryBudget < 0 ||
    definition.retryBudget > profile.retryBudgetCap
  ) invalidDefinition();
  if ((profile.requiredForbiddenPaths ?? []).some(
    (path) => !definition.forbiddenPaths?.includes(path)
  )) invalidDefinition();
  if (
    runtimeBudget.providerTimeoutMs > runtimeBudget.executionRuntimeMs ||
    runtimeBudget.providerMaxOutputTokens > runtimeBudget.executorOutputTokenLimit
  ) invalidDefinition();

  return {
    profile: {
      ...profile,
      requiredMutationPaths: [...definition.allowedMutationPaths],
      allowedMutationPaths: [...definition.allowedMutationPaths],
      maxChangedFiles: definition.maxChangedFiles,
      maxPatchLines: definition.maxPatchLines,
      providerCallBudget: definition.providerCallBudget,
      retryBudget: definition.retryBudget,
      providerRequirements: [...(definition.providerRequirements ?? [])]
    },
    contextPolicy,
    runtimeBudget,
    verificationProfile
  };
}

module.exports = {
  CONTEXT_POLICIES,
  DEFINITION_VERSION,
  PROFILES,
  RUNTIME_BUDGETS,
  V2_DEFINITION_VERSION,
  VERIFICATION_STAGES,
  resolvePilotConfiguration,
  resolveVerificationProfile
};
