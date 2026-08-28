#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const {
  V2_DEFINITION,
  boundedTextEditOutputSchema,
  materializeBoundedTextEdits,
  validateDefinition
} = require("./controlled-coding-pilot.cjs");
const { resolvePilotConfiguration } = require("./controlled-coding-pilot-registry.cjs");

const root = process.cwd();
const V1_DEFINITION = "pilots/controlled-real-coding-v1/runpod-live-help/task.json";
const V2_LOCAL_JSON_DEFINITION =
  "pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json";

function loadDefinition(path) {
  return validateDefinition(JSON.parse(readFileSync(join(root, path), "utf8")));
}

function runNode(script) {
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      LLM_UPSTREAM_URL: "",
      MODEL_WORKER_UPSTREAM_URL: "",
      LLM_UPSTREAM_API_KEY: "",
      MODEL_WORKER_UPSTREAM_API_KEY: "",
      OPENAI_API_KEY: "",
      RUNPOD_API_KEY: ""
    }
  });
  assert.equal(
    result.status,
    0,
    `${script} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

const v1 = loadDefinition(V1_DEFINITION);
assert.equal(v1.schemaVersion, "bounded.controlled-coding-pilot/v1");
assert.equal(v1.profile, "controlled_help_copy");
assert.equal(v1.contextPolicy, "controlled_help_anchor_v1");
assert.deepEqual(resolvePilotConfiguration(v1).verificationProfile, [
  "typecheck",
  "help_acceptance",
  "normal_missing_env",
  "runpod_proxy_smoke"
]);

for (const path of [V2_DEFINITION, V2_LOCAL_JSON_DEFINITION]) {
  const definition = loadDefinition(path);
  assert.equal(definition.schemaVersion, "bounded.controlled-coding-pilot/v2");
  assert.equal(definition.profile, "bounded_text_edits");
  assert.equal(definition.contextPolicy, "task_context_selections_v1");
  assert.equal(definition.runtimeBudget, "v2_default");
  assert.ok(Array.isArray(definition.contextSelections));
  assert.ok(definition.contextSelections.length > 0);
}

const schema = boundedTextEditOutputSchema();
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.required, ["schemaVersion", "edits", "summary"]);
assert.equal(schema.properties.schemaVersion.const, "bounded.controlled-text-edits/v1");
assert.equal(schema.properties.edits.minItems, 1);
assert.equal(schema.properties.edits.items.additionalProperties, false);

const profile = {
  allowedMutationPaths: ["packages/example/src/a.ts", "packages/example/src/b.ts"],
  requiredMutationPaths: ["packages/example/src/a.ts", "packages/example/src/b.ts"],
  maxChangedFiles: 2,
  maxPatchLines: 120,
  providerRequirements: []
};
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
        content: "export const a = 1;\n",
        contentHash: "sha256:a",
        authority: "change_allowed",
        relatedSymbols: ["symbol:a"]
      },
      {
        path: "packages/example/src/b.ts",
        content: "export const b = 1;\n",
        contentHash: "sha256:b",
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
      expectedContentHash: "sha256:a",
      oldText: "a = 1",
      newText: "a = 2"
    },
    {
      path: "packages/example/src/b.ts",
      expectedContentHash: "sha256:b",
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
assert.throws(
  () => materializeBoundedTextEdits(request, {
    schemaVersion: "bounded.controlled-text-edits/v1",
    edits: [{
      path: "package.json",
      expectedContentHash: "sha256:a",
      oldText: "a = 1",
      newText: "a = 2"
    }],
    summary: "Unauthorized edit."
  }, profile),
  (error) => error.pilotCode === "PILOT_AUTHORITY_VIOLATION" ||
    error.pilotCode === "PILOT_MODEL_RESPONSE_INVALID"
);

for (const script of [
  "scripts/controlled-coding-pilot-registry-smoke.cjs",
  "scripts/controlled-coding-pilot-context-selector-smoke.cjs",
  "scripts/controlled-coding-pilot-v2-smoke.cjs",
  "scripts/controlled-coding-pilot-evidence-smoke.cjs",
  "scripts/controlled-coding-pilot-evidence-verify-smoke.cjs",
  "scripts/controlled-coding-pilot-local-json-evidence-smoke.cjs",
  "scripts/controlled-coding-pilot-loopback-transport-smoke.cjs"
]) runNode(script);

process.stdout.write("controlled pilot v2 offline gate smoke: PASS\n");
