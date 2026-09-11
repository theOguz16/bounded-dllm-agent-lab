#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { hash: pilotHash } = require("./controlled-coding-pilot.cjs");
const {
  EXPERIMENT_CONFIG_SCHEMA_VERSION,
  OBSERVED_RUN_SCHEMA_VERSION,
  REQUIRED_PILOT_IDS,
  ObservedEvidenceError,
  canonicalJson,
  committedTask,
  hashCanonicalJson,
  publishObservedEvidence,
  reconstructSuppliedContext,
  sha256Bytes,
  sourceTargetRecords,
  verifyObservedEvidence
} = require("./controlled-coding-pilot-observed-evidence.cjs");

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function canonicalFile(path, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  writeFileSync(path, bytes);
  return bytes;
}

function artifactRecord(root, relativePath, kind) {
  const bytes = readFileSync(join(root, relativePath));
  return { kind, relativePath, byteSize: bytes.length, sha256: sha256Bytes(bytes) };
}

function fixtureConfig() {
  return {
    schemaVersion: EXPERIMENT_CONFIG_SCHEMA_VERSION,
    modelId: "fixture-qwen2.5-coder-7b",
    provider: {
      transport: "local_openai_compatible",
      baseUrl: "http://127.0.0.1:18000/v1",
      clientSchemaVersion: "bounded.local-openai-model-client/v1"
    },
    modelParameters: {
      structuredOutputMode: "json_schema",
      temperature: 0,
      maxOutputTokens: 6144,
      requestTimeoutMs: 250000
    },
    runtimeBudget: {
      modelContextTokenLimit: 32768,
      executionRuntimeMs: 270000,
      executorOutputTokenLimit: 6144,
      providerTimeoutMs: 250000,
      providerMaxOutputTokens: 6144
    },
    executionPolicy: {
      providerCallBudget: 1,
      retryBudget: 0,
      taskOrder: [...REQUIRED_PILOT_IDS]
    }
  };
}

function writeRun({ root, repositoryRoot, sourceCommit, pilotId, config, configHash, failed }) {
  const task = committedTask(repositoryRoot, sourceCommit, pilotId);
  const runName = pilotId.replace(/^controlled-real-coding-v2\./, "");
  const runRoot = join(root, "runs", runName);
  mkdirSync(join(runRoot, "pilot-output"), { recursive: true });

  const suppliedContext = reconstructSuppliedContext(repositoryRoot, sourceCommit, task.definition);
  canonicalFile(join(runRoot, "supplied-context.json"), suppliedContext);
  const instruction = canonicalJson({ workspaceFiles: suppliedContext });
  const request = {
    schemaVersion: "bounded.controlled-pilot-provider-request-observation/v1",
    modelId: config.modelId,
    instruction,
    instructionHash: pilotHash(instruction),
    requestKey: `fixture-${runName}`,
    outputSchema: { type: "object" },
    outputTokenLimit: 6144,
    maxOutputBytes: 100000,
    remainingRuntimeMs: 270000
  };
  canonicalFile(join(runRoot, "provider-request.json"), request);
  canonicalFile(join(runRoot, "raw-provider-candidate.json"), {
    schemaVersion: "bounded.controlled-text-edits/v1",
    edits: [{ fixture: runName }],
    summary: failed ? "rejected fixture" : "accepted fixture"
  });
  writeFileSync(join(runRoot, "pilot-output", failed
    ? "rejected-candidate.patch" : "generated.patch"),
    `--- a/${runName}\n+++ b/${runName}\n-${failed ? "old-failed" : "old"}\n+new\n`);

  const status = failed ? "failed" : "completed";
  const failureCode = failed ? "PILOT_VERIFICATION_FAILED" : null;
  const pilotReport = {
    schemaVersion: "bounded.controlled-coding-pilot-report/v1",
    pilotId,
    status,
    sourceCommit,
    pilotDefinitionHash: task.definitionHash,
    providerKind: "fixture",
    modelId: config.modelId,
    providerCallCount: 1,
    retryCount: 0,
    workspaceReceiptHash: null,
    changedFiles: [],
    patchLineCount: 2,
    authorityPassed: true,
    verifierPassed: !failed,
    artifactProduced: !failed,
    artifactValid: !failed,
    sourceWorktreeMutated: false,
    githubMutationObserved: false,
    budgetExceeded: false,
    cleanupCompleted: true,
    failureCode,
    providerDiagnostic: null,
    verifierDiagnostic: failed
      ? { verifierStage: task.definition.verificationProfile.at(-1) }
      : null,
    lifecycle: []
  };
  const pilotReportBytes = Buffer.from(`${JSON.stringify(pilotReport, null, 2)}\n`, "utf8");
  writeFileSync(join(runRoot, "pilot-output", "pilot-report.json"), pilotReportBytes);

  const patchArtifact = failed
    ? "pilot-output/rejected-candidate.patch"
    : "pilot-output/generated.patch";
  const rawCandidateArtifact = "raw-provider-candidate.json";
  const acceptanceStage = task.definition.verificationProfile.at(-1);
  const provenance = {
    schemaVersion: OBSERVED_RUN_SCHEMA_VERSION,
    pilotId,
    sourceCommit,
    experimentConfigHash: configHash,
    taskDefinition: {
      path: task.path,
      definitionHash: task.definitionHash,
      fileHash: task.fileHash,
      gitBlobHash: task.blobHash
    },
    sourceTargets: sourceTargetRecords(repositoryRoot, sourceCommit, task.definition),
    modelId: config.modelId,
    provider: config.provider,
    modelParameters: config.modelParameters,
    runtimeBudget: config.runtimeBudget,
    suppliedContextArtifact: "supplied-context.json",
    suppliedContextHash: hashCanonicalJson(suppliedContext),
    providerRequestArtifact: "provider-request.json",
    providerInstructionHash: request.instructionHash,
    rawCandidateArtifact,
    rawCandidateHash: sha256Bytes(readFileSync(join(runRoot, rawCandidateArtifact))),
    materializedPatchArtifact: patchArtifact,
    materializedPatchHash: sha256Bytes(readFileSync(join(runRoot, patchArtifact))),
    verifierOutcome: failed
      ? { status: "failed", failedStage: acceptanceStage }
      : { status: "passed", failedStage: null },
    acceptanceOutcome: failed
      ? { status: "failed", stage: acceptanceStage, failedStage: acceptanceStage }
      : { status: "passed", stage: acceptanceStage, failedStage: null },
    tokenCounts: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    latencyMs: { providerMs: 12.5, totalRunMs: 27.25 },
    providerRequestId: `fixture-${runName}`,
    providerFailureCode: null,
    providerCallCount: 1,
    retryCount: 0,
    status,
    failureCode,
    sourceWorktreeMutated: false,
    cleanupCompleted: true,
    rejectedCandidateArtifacts: failed ? [
      artifactRecord(runRoot, rawCandidateArtifact, "raw_provider_candidate"),
      artifactRecord(runRoot, patchArtifact, "materialized_rejected_patch")
    ] : [],
    pilotReportArtifact: "pilot-output/pilot-report.json",
    pilotReportHash: sha256Bytes(pilotReportBytes)
  };
  canonicalFile(join(runRoot, "run-provenance.json"), provenance);
  return {
    pilotId,
    status,
    failureCode,
    relativePath: `runs/${runName}/run-provenance.json`,
    runProvenanceHash: hashCanonicalJson(provenance)
  };
}

function main() {
  const repositoryRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const sourceCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const temporary = mkdtempSync(join(tmpdir(), "controlled-observed-evidence-smoke-"));
  const suiteRoot = join(temporary, "suite");
  const evidenceRoot = join(temporary, "published");
  mkdirSync(join(suiteRoot, "runs"), { recursive: true });
  try {
    const config = fixtureConfig();
    const configHash = hashCanonicalJson(config);
    const runs = [
      writeRun({
        root: suiteRoot,
        repositoryRoot,
        sourceCommit,
        pilotId: REQUIRED_PILOT_IDS[0],
        config,
        configHash,
        failed: false
      }),
      writeRun({
        root: suiteRoot,
        repositoryRoot,
        sourceCommit,
        pilotId: REQUIRED_PILOT_IDS[1],
        config,
        configHash,
        failed: true
      })
    ];
    canonicalFile(join(suiteRoot, "experiment-config.json"), config);
    canonicalFile(join(suiteRoot, "suite-summary.json"), {
      schemaVersion: "bounded.controlled-coding-pilot-observed-suite/v1",
      sourceCommit,
      experimentConfigHash: configHash,
      runs
    });

    const published = publishObservedEvidence({
      evidenceRoot,
      suiteDirectory: suiteRoot,
      sourceCommit,
      experimentConfig: config,
      runSummaries: runs
    });
    const verified = verifyObservedEvidence({
      bundleDir: published.finalDirectory,
      expectedSourceCommit: sourceCommit,
      repositoryRoot
    });
    assert.equal(verified.runCount, 2);
    assert.equal(verified.outcomes[REQUIRED_PILOT_IDS[0]], "completed");
    assert.equal(verified.outcomes[REQUIRED_PILOT_IDS[1]], "failed");

    assert.throws(() => publishObservedEvidence({
      evidenceRoot,
      suiteDirectory: suiteRoot,
      sourceCommit,
      experimentConfig: config,
      runSummaries: runs
    }), (error) => error instanceof ObservedEvidenceError &&
      error.code === "OBSERVED_EVIDENCE_IMMUTABLE_COLLISION");

    const failedRunName = REQUIRED_PILOT_IDS[1].replace(/^controlled-real-coding-v2\./, "");
    writeFileSync(
      join(published.finalDirectory, "runs", failedRunName, "raw-provider-candidate.json"),
      "tampered\n"
    );
    assert.throws(() => verifyObservedEvidence({
      bundleDir: published.finalDirectory,
      expectedSourceCommit: sourceCommit,
      repositoryRoot
    }), (error) => error instanceof ObservedEvidenceError);

    process.stdout.write("controlled pilot observed evidence v3 smoke: PASS\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main();
