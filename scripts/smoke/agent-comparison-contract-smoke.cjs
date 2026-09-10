#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const hash = (character) => `sha256:${character.repeat(64)}`;

async function main() {
  const runtime = await import(pathToFileURL(
    path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
  ).href);

  assert.equal(runtime.AGENT_COMPARISON_VERSION, "agent-comparison/v1");
  assert.deepEqual([...runtime.AGENT_COMPARISON_ARMS], ["baseline", "bounded"]);
  assert.deepEqual([...runtime.AGENT_COMPARABLE_IDENTITY_FIELDS], [
    "taskHash",
    "sourceRepositorySnapshotHash",
    "sourceCommitSha",
    "agentId",
    "agentVersion",
    "modelId",
    "reasoningEffort",
    "validationSpecHash",
    "networkPolicy",
    "timeoutBudget"
  ]);
  assert.equal(runtime.COMPARATIVE_EVIDENCE_VERSION, "comparative-evidence/v1");
  assert.deepEqual([...runtime.ABLATION_MODES], [
    "A_long_context",
    "B_retrieval_context",
    "C_synthetic_context",
    "D_bounded_workspace",
    "E_bounded_workspace_boundary"
  ]);

  const identity = {
    taskHash: hash("a"),
    sourceRepositorySnapshotHash: hash("b"),
    sourceCommitSha: "c".repeat(40),
    agentId: "codex",
    agentVersion: "codex-cli/1",
    modelId: "gpt-5.6-codex",
    reasoningEffort: "medium",
    validationSpecHash: hash("d"),
    networkPolicy: "disabled",
    timeoutBudget: 120000
  };

  const comparable = runtime.createAgentComparisonContract({
    baseline: identity,
    bounded: { ...identity }
  });
  assert.equal(comparable.schemaVersion, "agent-comparison/v1");
  assert.equal(comparable.arms.baseline.arm, "baseline");
  assert.equal(comparable.arms.bounded.arm, "bounded");
  assert.equal(comparable.comparable, true);
  assert.deepEqual(comparable.identityMismatchFields, []);
  assert.equal(Object.isFrozen(comparable), true);
  assert.equal(Object.isFrozen(comparable.arms), true);
  assert.equal(Object.isFrozen(comparable.arms.baseline), true);
  assert.equal(Object.isFrozen(comparable.identityMismatchFields), true);

  const mismatchValues = {
    taskHash: hash("e"),
    sourceRepositorySnapshotHash: hash("f"),
    sourceCommitSha: "1".repeat(40),
    agentId: "codex-other",
    agentVersion: "codex-cli/2",
    modelId: "gpt-other",
    reasoningEffort: "high",
    validationSpecHash: hash("9"),
    networkPolicy: "enabled",
    timeoutBudget: 60000
  };

  for (const field of runtime.AGENT_COMPARABLE_IDENTITY_FIELDS) {
    const result = runtime.createAgentComparisonContract({
      baseline: identity,
      bounded: { ...identity, [field]: mismatchValues[field] }
    });
    assert.equal(result.comparable, false, `${field} mismatch must make comparison non-comparable`);
    assert.deepEqual(result.identityMismatchFields, [field]);
  }

  const allMismatch = runtime.createAgentComparisonContract({
    baseline: identity,
    bounded: { ...mismatchValues }
  });
  assert.equal(allMismatch.comparable, false);
  assert.deepEqual(
    allMismatch.identityMismatchFields,
    [...runtime.AGENT_COMPARABLE_IDENTITY_FIELDS]
  );

  assert.throws(
    () => runtime.createAgentComparisonContract({
      baseline: { ...identity, extra: true },
      bounded: identity
    }),
    /exact comparable identity fields/
  );
  assert.throws(
    () => runtime.createAgentComparisonContract({
      baseline: { ...identity, taskHash: "bad-hash" },
      bounded: identity
    }),
    /SHA-256 hash/
  );
  assert.throws(
    () => runtime.createAgentComparisonContract({
      baseline: { ...identity, sourceCommitSha: "ABC" },
      bounded: identity
    }),
    /Git commit SHA/
  );
  assert.throws(
    () => runtime.createAgentComparisonContract({
      baseline: { ...identity, timeoutBudget: 0 },
      bounded: identity
    }),
    /positive safe integer/
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    contractVersion: runtime.AGENT_COMPARISON_VERSION,
    arms: [...runtime.AGENT_COMPARISON_ARMS],
    comparableIdentityFields: [...runtime.AGENT_COMPARABLE_IDENTITY_FIELDS],
    exactIdentityRequired: true,
    everyIdentityMismatchRejectsComparability: true,
    researchComparativeEvidenceUntouched: runtime.COMPARATIVE_EVIDENCE_VERSION === "comparative-evidence/v1"
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
