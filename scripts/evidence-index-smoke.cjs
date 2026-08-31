#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  hashCanonical,
  parseIndex,
  statusFor,
  verifyIndex
} = require("./evidence-index.cjs");

function rehash(index) {
  const { indexHash: _discard, ...core } = index;
  return { ...core, indexHash: hashCanonical(core) };
}

const root = process.cwd();
const index = verifyIndex(parseIndex(root), root);

assert.equal(index.schemaVersion, "bounded.evidence-index/v1");
assert.equal(index.experiments.length, 5);
assert.deepEqual(
  index.experiments.filter((entry) => entry.status === "observed")
    .map((entry) => entry.experimentId).sort(),
  [
    "controlled-coding-pilot-v1-runpod-live-help",
    "legacy-unified-release-v0.1"
  ]
);

const gate5 = statusFor(index, "gate5");
assert.equal(gate5.matchedExperimentCount, 2);
assert.equal(gate5.fullyObserved, false);
assert.equal(gate5.anyObserved, false);
assert.equal(gate5.counts.fixture, 1);
assert.equal(gate5.counts.pending, 1);
assert.deepEqual(
  gate5.experiments.map((entry) => [entry.experimentId, entry.status]),
  [
    ["gate5-a-e-external-ablation", "fixture"],
    ["gate5-mode-f-c-e-f", "pending"]
  ]
);

const v1 = statusFor(index, "controlled_coding_pilot_v1");
assert.equal(v1.fullyObserved, true);
assert.equal(v1.anyObserved, true);
assert.equal(v1.experiments[0].status, "observed");

const v2 = statusFor(index, "controlled_coding_pilot_v2");
assert.equal(v2.fullyObserved, false);
assert.equal(v2.anyObserved, false);
assert.equal(v2.experiments[0].status, "pending");

const badIndexHash = structuredClone(index);
badIndexHash.indexHash = `sha256:${"0".repeat(64)}`;
assert.throws(
  () => verifyIndex(badIndexHash, root),
  (error) => error.code === "EVIDENCE_INDEX_HASH_MISMATCH"
);

const promotedWithoutArtifact = structuredClone(index);
const pendingV2 = promotedWithoutArtifact.experiments.find(
  (entry) => entry.experimentId === "controlled-coding-pilot-v2-suite"
);
pendingV2.status = "observed";
pendingV2.sourceCommit = "b0806231d6ff6dad3bd618b6b1e82fb23559d28b";
pendingV2.provider = "fake-provider";
pendingV2.model = "fake-model";
const promotedRehashed = rehash(promotedWithoutArtifact);
assert.throws(
  () => verifyIndex(promotedRehashed, root),
  (error) => error.code === "EVIDENCE_INDEX_OBSERVED_ARTIFACT_REQUIRED"
);

const badTaskset = structuredClone(index);
const gateRecord = badTaskset.experiments.find(
  (entry) => entry.experimentId === "gate5-a-e-external-ablation"
);
gateRecord.tasksetIdentity.tasks[0].commitSha = "0".repeat(40);
const badTasksetRehashed = rehash(badTaskset);
assert.throws(
  () => verifyIndex(badTasksetRehashed, root),
  (error) => error.code === "EVIDENCE_INDEX_TASKSET_IDENTITY_MISMATCH"
);

process.stdout.write("evidence index smoke: PASS\n");
