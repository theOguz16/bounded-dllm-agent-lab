#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");

function request(overrides = {}) {
  return {
    mode: "coder",
    workingDirectory: "/tmp/bounded-workspace",
    sandboxMode: "workspace_write",
    networkAllowed: false,
    ...overrides
  };
}

async function main() {
  const policyModule = await import(pathToFileURL(
    path.join(repoRoot, "dist/packages/integrations/src/agent-isolation-policy.js")
  ).href);
  const {
    AGENT_ISOLATION_POLICY_VERSION,
    AgentIsolationPolicyError,
    resolveAgentIsolationPolicy
  } = policyModule;

  assert.equal(AGENT_ISOLATION_POLICY_VERSION, "agent-isolation-policy/v1");

  const coder = resolveAgentIsolationPolicy(request());
  assert.deepEqual(coder, {
    policyVersion: "agent-isolation-policy/v1",
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    additionalDirectories: []
  });
  assert.equal(Object.isFrozen(coder), true);
  assert.equal(Object.isFrozen(coder.additionalDirectories), true);

  const planner = resolveAgentIsolationPolicy(request({
    mode: "planner",
    sandboxMode: "read_only"
  }));
  assert.equal(planner.sandboxMode, "read-only");
  assert.equal(planner.networkAccessEnabled, false);
  assert.equal(planner.webSearchMode, "disabled");
  assert.equal(planner.approvalPolicy, "never");
  assert.deepEqual(planner.additionalDirectories, []);

  assert.throws(
    () => resolveAgentIsolationPolicy(request({ sandboxMode: "full_access" })),
    (error) => error instanceof AgentIsolationPolicyError && error.reason === "danger_full_access"
  );

  assert.throws(
    () => resolveAgentIsolationPolicy(request({
      mode: "planner",
      sandboxMode: "workspace_write"
    })),
    (error) => error instanceof AgentIsolationPolicyError && error.reason === "sandbox_escalation"
  );

  assert.throws(
    () => resolveAgentIsolationPolicy(request({ networkAllowed: true })),
    (error) => error instanceof AgentIsolationPolicyError && error.reason === "network_policy_required"
  );

  const explicitlyNetworked = resolveAgentIsolationPolicy(request({
    networkAllowed: true,
    networkPolicy: "enabled"
  }));
  assert.equal(explicitlyNetworked.networkAccessEnabled, true);
  assert.equal(explicitlyNetworked.webSearchMode, "disabled");

  assert.throws(
    () => resolveAgentIsolationPolicy(request({
      additionalDirectories: ["/tmp/other"]
    })),
    (error) => error instanceof AgentIsolationPolicyError &&
      error.reason === "additional_directory_source_context_required"
  );

  for (const additionalDirectory of [
    "/tmp/source-repository",
    "/tmp/source-repository/subdir",
    "/tmp"
  ]) {
    assert.throws(
      () => resolveAgentIsolationPolicy(request({
        sourceRepositoryPath: "/tmp/source-repository",
        additionalDirectories: [additionalDirectory]
      })),
      (error) => error instanceof AgentIsolationPolicyError &&
        error.reason === "additional_directory_source_overlap"
    );
  }

  const safeAdditional = resolveAgentIsolationPolicy(request({
    sourceRepositoryPath: "/tmp/source-repository",
    additionalDirectories: ["/tmp/bounded-shared"]
  }));
  assert.deepEqual(safeAdditional.additionalDirectories, ["/tmp/bounded-shared"]);

  assert.throws(
    () => resolveAgentIsolationPolicy(request({
      sourceRepositoryPath: "/tmp/source-repository",
      additionalDirectories: ["../bounded-shared", "/tmp/bounded-shared"]
    })),
    (error) => error instanceof AgentIsolationPolicyError && error.reason === "additional_directory_invalid"
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: AGENT_ISOLATION_POLICY_VERSION,
    coderSandbox: coder.sandboxMode,
    plannerSandbox: planner.sandboxMode,
    networkDefault: coder.networkAccessEnabled,
    webSearch: coder.webSearchMode,
    approval: coder.approvalPolicy,
    additionalDirectoriesDefault: coder.additionalDirectories,
    dangerFullAccessRejected: true,
    realRepositoryAdditionalDirectoryRejected: true,
    networkRequiresExplicitPolicy: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
