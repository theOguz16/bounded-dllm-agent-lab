#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { hashCanonical, parseIndex, verifyIndex } = require("./evidence-index.cjs");
const {
  CONTROLLED_EXPERIMENT,
  PromotionError,
  deriveObservedEntry
} = require("./evidence-promote-observed.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function currentSourceCommit() {
  return require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

function pendingControlled() {
  const index = verifyIndex(parseIndex(process.cwd()), process.cwd());
  return index.experiments.find((entry) => entry.experimentId === CONTROLLED_EXPERIMENT);
}

function makeBundle(root, { providerKind = "runpod", modelId = "qwen2.5-coder-7b", mutate } = {}) {
  const pending = pendingControlled();
  const sourceCommit = currentSourceCommit();
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "runs"), { recursive: true });
  const config = {
    schemaVersion: "bounded.controlled-coding-pilot-observed-config/v1",
    modelId,
    provider: {
      transport: providerKind,
      baseUrl: "https://provider.invalid/v1",
      clientSchemaVersion: "test-client/v1"
    },
    modelParameters: { temperature: 0, maxOutputTokens: 6144 },
    runtimeBudget: { providerMaxOutputTokens: 6144 },
    executionPolicy: { taskOrder: pending.tasksetIdentity.tasks.map((entry) => entry.pilotId) }
  };
  const experimentConfigHash = hashCanonical(config);
  const runs = [];
  for (const task of pending.tasksetIdentity.tasks) {
    const runName = task.pilotId.split(".").at(-1);
    const runRoot = join(bundle, "runs", runName);
    mkdirSync(runRoot, { recursive: true });
    const pilotReport = {
      pilotId: task.pilotId,
      status: "completed",
      sourceCommit,
      providerKind,
      modelId
    };
    writeJson(join(runRoot, "pilot-report.json"), pilotReport);
    const provenance = {
      schemaVersion: "bounded.controlled-coding-pilot-observed-run/v1",
      pilotId: task.pilotId,
      sourceCommit,
      experimentConfigHash,
      taskDefinition: { path: task.path },
      modelId,
      provider: config.provider,
      status: "completed",
      rejectedCandidateArtifacts: [],
      rawCandidateArtifact: "raw-provider-candidate.json",
      materializedPatchArtifact: "generated.patch",
      pilotReportArtifact: "pilot-report.json"
    };
    writeJson(join(runRoot, "run-provenance.json"), provenance);
    runs.push({
      pilotId: task.pilotId,
      status: "completed",
      failureCode: null,
      relativePath: `runs/${runName}/run-provenance.json`,
      runProvenanceHash: hashCanonical(provenance)
    });
  }
  const core = {
    schemaVersion: "bounded.controlled-coding-pilot-observed-evidence/v3",
    sourceCommit,
    experimentConfigHash,
    experimentConfig: config,
    runCount: runs.length,
    runs,
    files: []
  };
  const manifest = { ...core, evidenceHash: hashCanonical(core) };
  if (mutate) mutate({ manifest, pending, bundle, sourceCommit });
  writeJson(join(bundle, "evidence-manifest.json"), manifest);
  return { bundle, manifest, pending };
}

function expectReject(fn, code) {
  assert.throws(fn, (error) => error instanceof PromotionError && error.code === code,
    `expected rejection ${code}`);
}

function main() {
  const root = join(process.cwd(), "pilots/controlled-real-coding-v2/observed-runs/.promotion-smoke");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    const positive = makeBundle(join(root, "positive"));
    const first = deriveObservedEntry({
      root: process.cwd(),
      experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: positive.bundle,
      deepVerify: false
    });
    const second = deriveObservedEntry({
      root: process.cwd(),
      experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: positive.bundle,
      deepVerify: false
    });
    assert.deepEqual(first, second);
    assert.equal(first.status, "observed");
    assert.equal(first.sourceCommit, currentSourceCommit());
    assert.equal(first.tasksetHash, positive.pending.tasksetHash);
    assert.equal(first.provider, "runpod");
    assert.equal(first.model, "qwen2.5-coder-7b");
    assert.equal(first.artifactHash, positive.manifest.evidenceHash);
    assert.equal(first.artifactHashKind, "json_field:evidenceHash");

    const fixture = makeBundle(join(root, "fixture"), { providerKind: "fixture" });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: fixture.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_PROVIDER_INVALID");

    const wrongTaskset = makeBundle(join(root, "wrong-taskset"), {
      mutate({ manifest }) {
        manifest.runs[0].pilotId = "controlled-real-coding-v2.not-registered";
        const core = { ...manifest };
        delete core.evidenceHash;
        manifest.evidenceHash = hashCanonical(core);
      }
    });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: wrongTaskset.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_TASKSET_MISMATCH");

    const badHash = makeBundle(join(root, "bad-hash"), {
      mutate({ manifest }) { manifest.evidenceHash = `sha256:${"0".repeat(64)}`; }
    });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: badHash.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_ARTIFACT_HASH_INVALID");

    const missingModel = makeBundle(join(root, "missing-model"), { modelId: "fixture" });
    missingModel.manifest.experimentConfig.modelId = "";
    const missingModelCore = clone(missingModel.manifest);
    delete missingModelCore.evidenceHash;
    missingModel.manifest.experimentConfigHash = hashCanonical(missingModel.manifest.experimentConfig);
    missingModelCore.experimentConfigHash = missingModel.manifest.experimentConfigHash;
    missingModelCore.experimentConfig = missingModel.manifest.experimentConfig;
    missingModel.manifest.evidenceHash = hashCanonical(missingModelCore);
    writeJson(join(missingModel.bundle, "evidence-manifest.json"), missingModel.manifest);
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: missingModel.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_MODEL_MISSING");

    const dryRun = makeBundle(join(root, "dry-run"), { providerKind: "dry_run" });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: dryRun.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_PROVIDER_INVALID");

    const synthetic = makeBundle(join(root, "synthetic"), { providerKind: "synthetic-provider" });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: synthetic.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_PROVIDER_INVALID");

    const missingSource = makeBundle(join(root, "missing-source"), {
      mutate({ manifest }) {
        manifest.sourceCommit = null;
        const core = { ...manifest };
        delete core.evidenceHash;
        manifest.evidenceHash = hashCanonical(core);
      }
    });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: missingSource.bundle, deepVerify: false
    }), "EVIDENCE_PROMOTION_SOURCE_COMMIT_MISSING");

    process.stdout.write("observed evidence promotion fail-closed smoke: PASS\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
