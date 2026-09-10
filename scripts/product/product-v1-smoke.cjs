#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");

const childStages = [
  {
    name: "integrations smoke",
    script: "scripts/smoke/integrations-public-api-smoke.cjs"
  },
  {
    name: "agent telemetry smoke",
    script: "scripts/smoke/agent-telemetry-smoke.cjs"
  },
  {
    name: "Codex event parser smoke",
    script: "scripts/smoke/codex-event-parser-smoke.cjs"
  },
  {
    name: "disposable agent workspace smoke",
    script: "scripts/smoke/disposable-agent-workspace-smoke.cjs"
  },
  {
    name: "context exposure report smoke",
    script: "scripts/smoke/context-exposure-report-smoke.cjs"
  },
  {
    name: "agent mutation capture smoke",
    script: "scripts/smoke/agent-mutation-capture-smoke.cjs"
  },
  {
    name: "Codex bounded provider smoke",
    script: "scripts/smoke/codex-bounded-provider-smoke.cjs"
  },
  {
    name: "bounded init/doctor smoke",
    script: "scripts/smoke/bounded-init-smoke.cjs"
  },
  {
    name: "bounded Codex explicit-scope smoke",
    script: "scripts/smoke/bounded-codex-explicit-scope-smoke.cjs"
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
const deterministicProviderParserSmokes = new Set([
  "scripts/smoke/codex-event-parser-smoke.cjs",
  "scripts/smoke/codex-bounded-provider-smoke.cjs",
  "scripts/smoke/bounded-codex-explicit-scope-smoke.cjs"
]);

for (const stage of childStages) {
  assert.equal(
    forbiddenLiveCommand.test(stage.script) &&
      !deterministicProviderParserSmokes.has(stage.script),
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

async function main() {
  process.stdout.write("[product:v1] canonical runtime smoke\n");

  const runtimeUrl = pathToFileURL(
    resolve(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
  ).href;
  const runtime = await import(runtimeUrl);

  assert.equal(typeof runtime.runBoundedTask, "function");
  assert.equal(typeof runtime.resumeBoundedTask, "function");
  assert.equal(typeof runtime.compileCanonicalPolicy, "function");

  const invalidTaskResult = await runtime.runBoundedTask({});
  assert.equal(invalidTaskResult.decision, "bounded_task_invalid");

  for (const stage of childStages) {
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
    stages: [
      "canonical runtime smoke",
      ...childStages.map((stage) => stage.name)
    ]
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});