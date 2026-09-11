const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "../..");
const integrationsPackagePath = join(repoRoot, "packages/integrations/package.json");
const integrationsIndexPath = join(repoRoot, "packages/integrations/src/index.ts");
const integrationsPackage = JSON.parse(readFileSync(integrationsPackagePath, "utf8"));
const integrationsIndex = readFileSync(integrationsIndexPath, "utf8");

assert.equal(integrationsPackage.name, "@bounded/integrations");
assert.equal(integrationsPackage.main, "src/index.ts");
assert.equal(integrationsPackage.exports?.["."], "./src/index.ts");

const expectedPublicModules = [
  "agent-environment",
  "agent-isolation-policy",
  "agent-output-redaction",
  "coding-executor",
  "comparative-agent-runner",
  "local-openai-compatible-model-client",
  "runpod-openai-compatible-model-client",
  "provider-execution-error"
];

for (const moduleName of expectedPublicModules) {
  const exportStatement = `export * from "./${moduleName}.js";`;
  assert.equal(
    integrationsIndex.split("\n").includes(exportStatement),
    true,
    `missing integrations public export: ${moduleName}`
  );
}

const tempDirectory = mkdtempSync(join(repoRoot, ".tmp-integrations-public-api-"));
const consumerPath = join(tempDirectory, "consumer.mts");
const tscPath = join(repoRoot, "node_modules/typescript/bin/tsc");

try {
  writeFileSync(
    consumerPath,
    `import {
  AGENT_ENVIRONMENT_VERSION,
  createAgentEnvironment,
  AGENT_ISOLATION_POLICY_VERSION,
  resolveAgentIsolationPolicy,
  AGENT_OUTPUT_REDACTION_VERSION,
  createAgentOutputRedactor,
  CODING_EXECUTOR_REQUEST_VERSION,
  COMPARATIVE_AGENT_RUNNER_VERSION,
  runComparativeAgentSample,
  LOCAL_OPENAI_MODEL_CLIENT_VERSION,
  RUNPOD_MODEL_CLIENT_VERSION,
  PRODUCTION_MODEL_FAILURE_CODES
} from "@bounded/integrations";

void [
  AGENT_ENVIRONMENT_VERSION,
  createAgentEnvironment,
  AGENT_ISOLATION_POLICY_VERSION,
  resolveAgentIsolationPolicy,
  AGENT_OUTPUT_REDACTION_VERSION,
  createAgentOutputRedactor,
  CODING_EXECUTOR_REQUEST_VERSION,
  COMPARATIVE_AGENT_RUNNER_VERSION,
  runComparativeAgentSample,
  LOCAL_OPENAI_MODEL_CLIENT_VERSION,
  RUNPOD_MODEL_CLIENT_VERSION,
  PRODUCTION_MODEL_FAILURE_CODES
];
`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      "--noEmit",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      consumerPath
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(
    result.status,
    0,
    [
      "@bounded/integrations consumer import failed",
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n")
  );
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  package: "@bounded/integrations",
  checkedModules: expectedPublicModules
}, null, 2));
