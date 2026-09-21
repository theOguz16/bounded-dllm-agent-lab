#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const hash = (character) => `sha256:${character.repeat(64)}`;
const source = fs.readFileSync(path.join(root, "apps/cli/src/commands/compare.ts"), "utf8");
assert.equal(source.includes("if (providerGate?.stoppedCode() || terminalFailureCode !== null) break;"), true);
assert.match(source, /providerComparison: comparison/);
assert.equal(source.includes("terminalFailureCode !== null"), true);

function request(mode) {
  return {
    runId: `offline.${mode}`, agentId: "codex", workingDirectory: "/tmp/p7-6-fake",
    task: "fixture", model: "fake-model", reasoningEffort: "none", mode,
    timeoutMs: 10000, networkAllowed: false, sandboxMode: "workspace_write"
  };
}
function result(code) {
  return {
    status: code ? "failed" : "completed", failureCode: code, quotaStatus: "unknown",
    agentId: "codex", agentVersion: "fake-sdk", modelId: "fake-model",
    durationMs: 0, finalMessage: "", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    commands: [], fileChanges: [], diagnostics: code ? [{ code, severity: "error", message: code, retryable: false }] : []
  };
}
const common = {
  taskHash: hash("a"), sourceRepositorySnapshotHash: hash("b"),
  sourceCommitSha: "c".repeat(40), agentId: "codex", agentVersion: "fake-sdk",
  modelId: "fake-model", reasoningEffort: "none", validationSpecHash: hash("d"),
  networkPolicy: "disabled", timeoutBudget: 300000
};

async function main() {
  const { CodexCompareProviderGate } = await import(pathToFileURL(
    path.join(root, "dist/apps/cli/src/commands/codex-compare-provider-gate.js")
  ).href);
  const { createAgentComparisonContract } = await import(pathToFileURL(
    path.join(root, "dist/packages/product-runtime/src/agent-comparison-contract.js")
  ).href);

  let tested = 0;
  for (const firstArm of ["baseline", "bounded"]) {
    for (const failureCode of ["usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"]) {
      const env = { BOUNDED_CODEX_ACCOUNT_ALIAS: "personal-a", BOUNDED_CODEX_AUTH_MODE: "api_key", CODEX_API_KEY: "fixture-token", BOUNDED_CODEX_MODEL: "fake-model" };
      let paid = 0;
      const gate = new CodexCompareProviderGate("fake-model", "none", () => env);
      assert.equal(gate.quota, "unknown");
      gate.preflight();
      const fake = { agentId: "codex", agentVersion: "fake-sdk", async run() { paid += 1; return result(failureCode); } };
      const adapter = gate.wrap(fake);
      const first = await adapter.run(request(firstArm));
      assert.equal(first.failureCode, failureCode);
      assert.equal(gate.stoppedCode(), failureCode);
      const secondArm = firstArm === "baseline" ? "coder" : "baseline";
      // This is the same gate and adapter shared by compare's two arms.
      const second = await adapter.run(request(secondArm));
      assert.equal(second.status, "rejected");
      assert.equal(paid, 1, "the other arm must not make a new paid provider invocation");
      assert.equal(gate.quota, "unknown");
      tested += 1;
    }
  }

  const env = { BOUNDED_CODEX_ACCOUNT_ALIAS: "personal-a", BOUNDED_CODEX_AUTH_MODE: "api_key", CODEX_API_KEY: "fixture-token", BOUNDED_CODEX_MODEL: "fake-model" };
  let paid = 0;
  const gate = new CodexCompareProviderGate("fake-model", "none", () => env);
  const adapter = gate.wrap({ agentId: "codex", agentVersion: "fake-sdk", async run() { paid += 1; return result(null); } });
  assert.equal((await adapter.run(request("baseline"))).status, "completed");
  env.BOUNDED_CODEX_ACCOUNT_ALIAS = "personal-b";
  assert.equal((await adapter.run(request("coder"))).status, "rejected");
  assert.equal(gate.stoppedCode(), "provider_identity_changed");
  assert.equal(paid, 1);
  const mismatch = createAgentComparisonContract({
    baseline: { ...common, ...gate.armIdentity("baseline") },
    bounded: { ...common, ...gate.armIdentity("bounded") }
  });
  assert.equal(mismatch.schemaVersion, "agent-comparison/v2");
  assert.equal(mismatch.comparable, false);
  assert.deepEqual(mismatch.identityMismatchFields, ["accountAlias"]);

  const identity = { providerId: "codex", accountAlias: "personal-a", authMode: "api_key" };
  assert.equal(createAgentComparisonContract({ baseline: { ...common, ...identity }, bounded: { ...common, ...identity } }).comparable, true);
  assert.throws(() => createAgentComparisonContract({ baseline: common, bounded: { ...common, ...identity } }), /matching exact comparable identity fields/);
  assert.equal(createAgentComparisonContract({ baseline: common, bounded: common }).schemaVersion, "agent-comparison/v1");

  const altered = { ...env, BOUNDED_CODEX_ACCOUNT_ALIAS: "personal-a", CODEX_API_KEY: "replaced-token" };
  let authPaid = 0;
  const authGate = new CodexCompareProviderGate("fake-model", "none", () => altered);
  const authAdapter = authGate.wrap({ agentId: "codex", agentVersion: "fake-sdk", async run() { authPaid++; return result(null); } });
  assert.equal((await authAdapter.run(request("baseline"))).status, "completed");
  altered.CODEX_API_KEY = "switched-token";
  assert.equal((await authAdapter.run(request("coder"))).status, "rejected");
  assert.equal(authGate.stoppedCode(), "provider_identity_changed");
  assert.equal(authPaid, 1);

  assert.throws(() => new CodexCompareProviderGate("fake-model", "none", () => ({
    BOUNDED_CODEX_ACCOUNT_ALIAS: "email@example.com", BOUNDED_CODEX_AUTH_MODE: "api_key", CODEX_API_KEY: "token"
  })), /authentication_failed/);
  assert.equal(JSON.stringify(mismatch).includes("fixture-token"), false);
  assert.equal(JSON.stringify(mismatch).includes("replaced-token"), false);
  console.log(`P7.6 compare fake-provider smoke PASS: ${tested} two-arm failure cases; paid calls after first failure=0; account mismatch noncomparable; quota=unknown; real Codex calls=0`);
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
