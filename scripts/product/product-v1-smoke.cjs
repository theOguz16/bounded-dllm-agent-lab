#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");

const stages = [
  {
    name: "canonical runtime smoke",
    script: "scripts/runtime-generation-boundary-smoke.cjs"
  },
  {
    name: "integrations smoke",
    script: "scripts/smoke/integrations-public-api-smoke.cjs"
  },
  {
    name: "CLI smoke",
    script: "scripts/canonical-cli-smoke.cjs"
  },
  {
    name: "product security smoke",
    script: "scripts/action-input-safety-smoke.cjs"
  }
];

const forbiddenLiveCommand = /(?:runpod|openai|claude|codex|provider-live|live:)/i;

for (const stage of stages) {
  assert.equal(
    forbiddenLiveCommand.test(stage.script),
    false,
    `product v1 CI must not invoke a live/provider script: ${stage.script}`
  );
}

const childEnv = {
  ...process.env,
  BOUNDED_PRODUCT_V1_CI: "1",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  CLAUDE_API_KEY: "",
  RUNPOD_API_KEY: "",
  RUNPOD_ENDPOINT_ID: "",
  CODEX_API_KEY: "",
  LLM_UPSTREAM_URL: "",
  MODEL_WORKER_UPSTREAM_URL: "",
  LLM_UPSTREAM_API_KEY: "",
  MODEL_WORKER_UPSTREAM_API_KEY: ""
};

for (const stage of stages) {
  process.stdout.write(`[product:v1] ${stage.name}\n`);

  const result = spawnSync(process.execPath, [stage.script], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  assert.equal(
    result.status,
    0,
    `${stage.name} failed with exit code ${String(result.status)}`
  );
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  lane: "product-v1",
  deterministic: true,
  externalProviderCalls: false,
  stages: stages.map((stage) => stage.name)
}, null, 2)}\n`);
