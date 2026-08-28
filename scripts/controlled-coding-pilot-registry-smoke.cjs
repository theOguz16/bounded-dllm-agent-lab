#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  RUNTIME_BUDGETS,
  VERIFICATION_STAGES,
  resolvePilotConfiguration,
  resolveVerificationProfile
} = require("./controlled-coding-pilot-registry.cjs");
const { STAGE_EXECUTORS } = require("./controlled-coding-pilot-verification.cjs");
const { validateDefinition } = require("./controlled-coding-pilot.cjs");

const root = process.cwd();
const taskPaths = [
  "pilots/controlled-real-coding-v1/runpod-live-help/task.json",
  "pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json",
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json"
];
const definitions = taskPaths.map((path) => JSON.parse(readFileSync(join(root, path), "utf8")));

for (const definition of definitions) {
  assert.equal("acceptanceCommands" in definition, false, definition.pilotId);
  assert.doesNotThrow(() => validateDefinition(definition), definition.pilotId);
  const configuration = resolvePilotConfiguration(definition);
  assert.equal(configuration.profile.providerMode, definition.profile);
  assert.deepEqual(configuration.verificationProfile, definition.verificationProfile);
  assert.equal(configuration.runtimeBudget, RUNTIME_BUDGETS[definition.runtimeBudget]);
}

assert.deepEqual(
  definitions[1].verificationProfile,
  ["typecheck", "build", "test_smoke", "request_id_acceptance"]
);
assert.deepEqual(
  definitions[2].verificationProfile,
  ["typecheck", "build", "test_smoke", "local_json_schema_acceptance"]
);
assert.deepEqual(Object.keys(STAGE_EXECUTORS).sort(), [...VERIFICATION_STAGES].sort());

for (const stageIds of [
  ["typecheck", "arbitrary_shell"],
  ["npm run pwn"],
  ["typecheck", "typecheck"]
]) {
  assert.throws(
    () => resolveVerificationProfile(stageIds),
    (error) => error?.pilotCode === "PILOT_DEFINITION_INVALID"
  );
}

const synthetic = {
  schemaVersion: "bounded.controlled-coding-pilot/v2",
  pilotId: "controlled-real-coding-v2.synthetic-third-task",
  profile: "bounded_text_edits",
  contextPolicy: "task_context_selections_v1",
  runtimeBudget: "v2_default",
  verificationProfile: ["typecheck", "build", "test_smoke"],
  taskTitle: "Synthetic declarative registry fixture",
  taskPrompt: "Apply a bounded synthetic edit using only the declared generic profiles.",
  providerRequirements: [],
  sourceRevisionPolicy: "current-head",
  allowedMutationPaths: ["packages/future-pilot/src/third-task.ts"],
  allowedReadRoots: ["packages/future-pilot/src/third-task.ts"],
  contextSelections: [{
    path: "packages/future-pilot/src/third-task.ts",
    selectors: [{ kind: "symbol", name: "futureSelectorTarget" }]
  }],
  forbiddenPaths: [
    "package.json", "package-lock.json", "dist", ".github", "docs",
    "pilots", "scripts", "apps", "bounded-agent.policy.yml"
  ],
  maxChangedFiles: 1,
  maxPatchLines: 60,
  providerCallBudget: 1,
  retryBudget: 0,
  requiredAssertions: ["synthetic fixture validates without a pilot-id registry entry"]
};
assert.doesNotThrow(() => validateDefinition(synthetic));
const syntheticConfiguration = resolvePilotConfiguration(synthetic);
assert.equal(syntheticConfiguration.profile.providerMode, "bounded_text_edits");
assert.deepEqual(syntheticConfiguration.verificationProfile, [
  "typecheck", "build", "test_smoke"
]);

const unknownStageDefinition = structuredClone(synthetic);
unknownStageDefinition.verificationProfile = ["typecheck", "shell:rm -rf /"];
assert.throws(
  () => validateDefinition(unknownStageDefinition),
  (error) => error?.pilotCode === "PILOT_DEFINITION_INVALID"
);
const arbitraryCommandDefinition = structuredClone(synthetic);
arbitraryCommandDefinition.acceptanceCommands = ["npm run pwn"];
assert.throws(
  () => validateDefinition(arbitraryCommandDefinition),
  (error) => error?.pilotCode === "PILOT_DEFINITION_INVALID"
);

const runnerSource = readFileSync(join(root, "scripts/controlled-coding-pilot.cjs"), "utf8");
assert.equal(runnerSource.includes("PILOT_PROFILES"), false);
assert.equal(runnerSource.includes("definition.pilotId ==="), false);
assert.equal(runnerSource.includes("acceptanceCommands"), false);

process.stdout.write("controlled coding pilot registry smoke: PASS\n");
