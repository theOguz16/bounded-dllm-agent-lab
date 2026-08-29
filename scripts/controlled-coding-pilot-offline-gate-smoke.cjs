#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  V2_DEFINITION,
  boundedTextEditOutputSchema,
  materializeBoundedTextEdits,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");
const { resolvePilotConfiguration } = require("./controlled-coding-pilot-registry.cjs");
const { hash } = require("./controlled-pilot/context.cjs");

const root = process.cwd();
const V1_DEFINITION = "pilots/controlled-real-coding-v1/runpod-live-help/task.json";
const V2_LOCAL_JSON_DEFINITION =
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json";

function loadDefinition(path) {
  return validateDefinition(JSON.parse(readFileSync(join(root, path), "utf8")));
}

const v1 = loadDefinition(V1_DEFINITION);
assert.equal(v1.schemaVersion, "bounded.controlled-coding-pilot/v1");
assert.equal(v1.profile, "controlled_help_copy");
assert.equal(v1.contextPolicy, "controlled_help_anchor_v1");
assert.equal(v1.runtimeBudget, "v1_default");
assert.deepEqual(resolvePilotConfiguration(v1).verificationProfile, [
  "typecheck",
  "help_acceptance",
  "normal_missing_env",
  "runpod_proxy_smoke"
]);

for (const [path, expectedStage] of [
  [V2_DEFINITION, "request_id_acceptance"],
  [V2_LOCAL_JSON_DEFINITION, "local_json_schema_acceptance"]
]) {
  const definition = loadDefinition(path);
  const configuration = resolvePilotConfiguration(definition);
  assert.equal(definition.schemaVersion, "bounded.controlled-coding-pilot/v2");
  assert.equal(definition.profile, "bounded_text_edits");
  assert.equal(definition.contextPolicy, "task_context_selections_v1");
  assert.equal(definition.runtimeBudget, "v2_default");
  assert.ok(Array.isArray(definition.contextSelections));
  assert.ok(definition.contextSelections.length > 0);
  assert.deepEqual(configuration.verificationProfile.slice(0, 3), [
    "typecheck",
    "build",
    "test_smoke"
  ]);
  assert.equal(configuration.verificationProfile.at(-1), expectedStage);
}

const schema = boundedTextEditOutputSchema();
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.required, ["schemaVersion", "edits", "summary"]);
assert.equal(schema.properties.schemaVersion.const, "bounded.controlled-text-edits/v1");
assert.equal(schema.properties.edits.minItems, 1);
assert.equal(schema.properties.edits.items.additionalProperties, false);
assert.deepEqual(schema.properties.edits.items.required, [
  "path", "expectedContentHash", "oldText", "newText"
]);

const profile = {
  allowedMutationPaths: ["packages/example/src/a.ts", "packages/example/src/b.ts"],
  requiredMutationPaths: ["packages/example/src/a.ts", "packages/example/src/b.ts"],
  maxChangedFiles: 2,
  maxPatchLines: 120,
  providerRequirements: []
};
const aContent = "export const a = 1;\n";
const bContent = "export const b = 1;\n";
const aHash = hash(aContent);
const bHash = hash(bContent);
const request = {
  instruction: JSON.stringify({
    existingPlan: {
      steps: [{
        stepId: "step-1",
        targetPaths: profile.requiredMutationPaths
      }]
    },
    workspaceFiles: [
      {
        path: "packages/example/src/a.ts",
        content: aContent,
        contentHash: aHash,
        authority: "change_allowed",
        relatedSymbols: ["symbol:a"]
      },
      {
        path: "packages/example/src/b.ts",
        content: bContent,
        contentHash: bHash,
        authority: "change_allowed",
        relatedSymbols: ["symbol:b"]
      }
    ]
  })
};
const materialized = materializeBoundedTextEdits(request, {
  schemaVersion: "bounded.controlled-text-edits/v1",
  edits: [
    {
      path: "packages/example/src/a.ts",
      expectedContentHash: aHash,
      oldText: "a = 1",
      newText: "a = 2"
    },
    {
      path: "packages/example/src/b.ts",
      expectedContentHash: bHash,
      oldText: "b = 1",
      newText: "b = 2"
    }
  ],
  summary: "Update both bounded targets."
}, profile);
assert.equal(materialized.output.mutations.length, 2);
assert.deepEqual(materialized.editCounts, {
  "packages/example/src/a.ts": 1,
  "packages/example/src/b.ts": 1
});
assert.match(materialized.output.mutations[0].newContent, /a = 2/);
assert.match(materialized.output.mutations[1].newContent, /b = 2/);

assert.throws(
  () => materializeBoundedTextEdits(request, {
    schemaVersion: "bounded.controlled-text-edits/v1",
    edits: [{
      path: "package.json",
      expectedContentHash: aHash,
      oldText: "a = 1",
      newText: "a = 2"
    }],
    summary: "Unauthorized edit."
  }, profile),
  (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION"
);

assert.throws(
  () => materializeBoundedTextEdits(request, {
    schemaVersion: "bounded.controlled-text-edits/v1",
    edits: [{
      path: "packages/example/src/a.ts",
      expectedContentHash: aHash,
      oldText: "not-present",
      newText: "a = 2"
    }, {
      path: "packages/example/src/b.ts",
      expectedContentHash: bHash,
      oldText: "b = 1",
      newText: "b = 2"
    }],
    summary: "Non-materializable edit."
  }, profile),
  (error) => error.pilotCode === "PILOT_MODEL_RESPONSE_INVALID"
);

process.stdout.write("controlled pilot v2 definition/parser/materializer gate: PASS\n");
