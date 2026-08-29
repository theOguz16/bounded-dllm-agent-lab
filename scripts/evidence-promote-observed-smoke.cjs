#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { hashCanonical, parseIndex, verifyIndex } = require("./evidence-index.cjs");
const {
  CONTROLLED_EXPERIMENT,
  MODE_F_EXPERIMENT,
  PromotionError,
  deriveObservedEntry
} = require("./evidence-promote-observed.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitText(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitBytes(args) {
  return execFileSync("git", args, { encoding: null });
}

function currentSourceCommit() {
  return gitText(["rev-parse", "HEAD"]);
}

function pendingExperiment(id) {
  const index = verifyIndex(parseIndex(process.cwd()), process.cwd());
  return index.experiments.find((entry) => entry.experimentId === id);
}

function makeBundle(root, { providerKind = "runpod", modelId = "qwen2.5-coder-7b", mutate } = {}) {
  const pending = pendingExperiment(CONTROLLED_EXPERIMENT);
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

function makeModeF(root, { fixture = false, mutate } = {}) {
  const pending = pendingExperiment(MODE_F_EXPERIMENT);
  const sourceCommit = currentSourceCommit();
  const benchmarkPath = "scripts/evidence-index.cjs";
  const modes = [
    "C_synthetic_context",
    "E_bounded_workspace_boundary",
    "F_adaptive_compressed_boundary"
  ];
  mkdirSync(root, { recursive: true });
  const rawPath = join(root, "mode-f-live-evidence.json.raw.json");
  const raw = {
    executionClass: fixture
      ? "fixture_adaptive_compressed_boundary"
      : "live_adaptive_compressed_boundary",
    taskCount: pending.tasksetIdentity.tasks.length,
    modeCount: modes.length,
    sampleCount: pending.tasksetIdentity.tasks.length * modes.length,
    tasks: clone(pending.tasksetIdentity.tasks),
    results: pending.tasksetIdentity.tasks.flatMap((task) =>
      modes.map((mode) => ({ taskId: task.taskId, mode }))),
    aggregates: modes.map((mode) => ({
      mode,
      sampleCount: pending.tasksetIdentity.tasks.length,
      strictOracleSuccessRate: 1,
      averageContextBytes: mode.startsWith("F_") ? 100 : 200,
      totalScopeDriftFiles: 0
    })),
    reportHash: `sha256:${"1".repeat(64)}`
  };
  writeJson(rawPath, raw);
  const rawBytes = readFileSync(rawPath);
  const config = {
    model: "qwen2.5-coder-7b",
    transport: fixture ? "fixture" : "openai_compatible_http",
    endpoint: fixture ? null : {
      protocol: "https:", hostname: "provider.invalid", port: null, path: "/v1/chat/completions"
    },
    temperature: 0,
    maxCompletionTokens: 256,
    repetitions: 1
  };
  const core = {
    schemaVersion: "gate5-mode-f-live-evidence/v1",
    researchStatus: fixture ? "fixture_contract" : "observed_live_result",
    researchQuestion: "fixture-independent registry promotion test",
    sourceCommit,
    benchmarkPath,
    benchmarkGitBlob: gitText(["rev-parse", `${sourceCommit}:${benchmarkPath}`]),
    benchmarkFileHash: sha256Bytes(gitBytes(["show", `${sourceCommit}:${benchmarkPath}`])),
    experimentConfig: config,
    experimentConfigHash: hashCanonical(config),
    immutableExternalRepositories: clone(pending.tasksetIdentity.tasks),
    rawReportPath: "mode-f-live-evidence.json.raw.json",
    rawReportByteHash: sha256Bytes(rawBytes),
    rawReportHash: raw.reportHash,
    executionClass: raw.executionClass,
    sampleCount: raw.sampleCount,
    aggregates: clone(raw.aggregates)
  };
  const evidence = { ...core, evidenceHash: hashCanonical(core) };
  if (mutate) mutate({ evidence, pending, raw });
  const artifact = join(root, "mode-f-live-evidence.json");
  writeJson(artifact, evidence);
  return { artifact, evidence, pending };
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
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: positive.bundle, deepVerify: false
    });
    const second = deriveObservedEntry({
      root: process.cwd(), experimentId: CONTROLLED_EXPERIMENT,
      artifactPath: positive.bundle, deepVerify: false
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

    const modeF = makeModeF(join(root, "mode-f-positive"));
    const modeFEntry = deriveObservedEntry({
      root: process.cwd(), experimentId: MODE_F_EXPERIMENT, artifactPath: modeF.artifact
    });
    assert.equal(modeFEntry.status, "observed");
    assert.equal(modeFEntry.provider, "openai_compatible_http");
    assert.equal(modeFEntry.model, "qwen2.5-coder-7b");
    assert.equal(modeFEntry.tasksetHash, modeF.pending.tasksetHash);
    assert.equal(modeFEntry.artifactHash, modeF.evidence.evidenceHash);

    const modeFFixture = makeModeF(join(root, "mode-f-fixture"), { fixture: true });
    expectReject(() => deriveObservedEntry({
      root: process.cwd(), experimentId: MODE_F_EXPERIMENT, artifactPath: modeFFixture.artifact
    }), "EVIDENCE_PROMOTION_NON_OBSERVED_ARTIFACT_REJECTED");

    process.stdout.write("observed evidence promotion fail-closed smoke: PASS\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
