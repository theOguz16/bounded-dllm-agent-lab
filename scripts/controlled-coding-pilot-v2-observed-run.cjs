#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { basename, join, relative, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  V2_RUNTIME_BUDGET,
  liveProviderConfiguration,
  pilotProviderClientConfiguration,
  runControlledCodingPilot
} = require("./controlled-coding-pilot.cjs");
const {
  EXPERIMENT_CONFIG_SCHEMA_VERSION,
  OBSERVED_RUN_SCHEMA_VERSION,
  PILOT_DEFINITIONS,
  REQUIRED_PILOT_IDS,
  canonicalJson,
  committedTask,
  hashCanonicalJson,
  publishObservedEvidence,
  sha256Bytes,
  sourceTargetRecords,
  verifyObservedEvidence
} = require("./controlled-coding-pilot-observed-evidence.cjs");

const RUN_ATTESTATION = "I_CONFIRM_REAL_PROVIDER_CALLS";
const DEFAULT_EVIDENCE_ROOT =
  "pilots/controlled-real-coding-v2/observed-runs";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail("OBSERVED_RUN_ARGUMENT_INVALID");
  return value;
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    fail("OBSERVED_RUN_GIT_FAILED");
  }
}

function ensureCleanSource(root) {
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail("OBSERVED_RUN_SOURCE_NOT_CLEAN");
}

function safeProvider(providerConfig) {
  return {
    transport: providerConfig.transport,
    baseUrl: providerConfig.baseUrl
  };
}

function serializeCanonicalFile(path, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  writeFileSync(path, bytes, { flag: "wx" });
  return { bytes, sha256: sha256Bytes(bytes) };
}

function artifactRecord(runRoot, relativePath, kind) {
  const path = resolve(runRoot, relativePath);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) fail("OBSERVED_RUN_ARTIFACT_INVALID");
  const bytes = readFileSync(path);
  return {
    kind,
    relativePath: relativePath.split("\\").join("/"),
    byteSize: bytes.length,
    sha256: sha256Bytes(bytes)
  };
}

function copyPilotArtifactsIntoRun(pilotOutput, runRoot) {
  const destination = join(runRoot, "pilot-output");
  mkdirSync(destination, { recursive: true });
  const { cpSync, readdirSync } = require("node:fs");
  for (const name of readdirSync(pilotOutput)) {
    cpSync(join(pilotOutput, name), join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
  }
  return destination;
}

function deriveOutcomes(definition, report) {
  const acceptanceStage = definition.verificationProfile.at(-1);
  const failedStage = report.verifierDiagnostic?.verifierStage ?? null;
  if (report.status === "completed") {
    return {
      verifierOutcome: { status: "passed", failedStage: null },
      acceptanceOutcome: { status: "passed", stage: acceptanceStage, failedStage: null }
    };
  }
  if (report.failureCode === "PILOT_VERIFICATION_FAILED") {
    return {
      verifierOutcome: { status: "failed", failedStage },
      acceptanceOutcome: failedStage === acceptanceStage
        ? { status: "failed", stage: acceptanceStage, failedStage }
        : { status: "not_run", stage: acceptanceStage, failedStage: null }
    };
  }
  return {
    verifierOutcome: { status: "not_run", failedStage: null },
    acceptanceOutcome: { status: "not_run", stage: acceptanceStage, failedStage: null }
  };
}

function candidateArtifacts(runRoot, report, observation) {
  const records = [];
  if (report.status === "completed") return records;
  if (observation.rawCandidateArtifact) {
    records.push(artifactRecord(runRoot, observation.rawCandidateArtifact, "raw_provider_candidate"));
  }
  if (observation.materializedPatchArtifact) {
    records.push(artifactRecord(runRoot, observation.materializedPatchArtifact,
      "materialized_rejected_patch"));
  }
  const extra = [
    ["pilot-output/rejected-candidate.patch", "runner_rejected_patch"],
    ["pilot-output/rejected-provider-output.json", "runner_rejected_provider_output"],
    ["pilot-output/verifier-error.json", "verifier_error"]
  ];
  for (const [path, kind] of extra) {
    if (existsSync(join(runRoot, path)) && !records.some((entry) => entry.relativePath === path)) {
      records.push(artifactRecord(runRoot, path, kind));
    }
  }
  return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function makeConcreteClient(providerConfig) {
  const credentials = {
    async getCredential() { return providerConfig.credential; }
  };
  if (providerConfig.transport === "local_openai_compatible") {
    const local = await import(
      "../dist/packages/integrations/src/local-openai-compatible-model-client.js"
    );
    return {
      client: new local.LocalOpenAICompatibleModelClient(
        pilotProviderClientConfiguration(
          local.LOCAL_OPENAI_MODEL_CLIENT_VERSION,
          providerConfig,
          V2_RUNTIME_BUDGET
        ),
        credentials
      ),
      clientSchemaVersion: local.LOCAL_OPENAI_MODEL_CLIENT_VERSION
    };
  }
  const runpod = await import(
    "../dist/packages/integrations/src/runpod-openai-compatible-model-client.js"
  );
  return {
    client: new runpod.RunpodOpenAICompatibleModelClient(
      pilotProviderClientConfiguration(
        runpod.RUNPOD_MODEL_CLIENT_VERSION,
        providerConfig,
        V2_RUNTIME_BUDGET
      ),
      credentials
    ),
    clientSchemaVersion: runpod.RUNPOD_MODEL_CLIENT_VERSION
  };
}

function experimentConfig(providerConfig, clientSchemaVersion) {
  return {
    schemaVersion: EXPERIMENT_CONFIG_SCHEMA_VERSION,
    modelId: providerConfig.modelId,
    provider: {
      ...safeProvider(providerConfig),
      clientSchemaVersion
    },
    modelParameters: {
      structuredOutputMode: "json_schema",
      temperature: 0,
      maxOutputTokens: V2_RUNTIME_BUDGET.providerMaxOutputTokens,
      requestTimeoutMs: V2_RUNTIME_BUDGET.providerTimeoutMs
    },
    runtimeBudget: { ...V2_RUNTIME_BUDGET },
    executionPolicy: {
      providerCallBudget: 1,
      retryBudget: 0,
      taskOrder: [...REQUIRED_PILOT_IDS]
    }
  };
}

async function runOne({
  sourceRoot,
  sourceCommit,
  suiteRoot,
  pilotId,
  providerConfig,
  concreteClient,
  config,
  configHash
}) {
  const task = committedTask(sourceRoot, sourceCommit, pilotId);
  const definitionPath = task.path;
  const runName = pilotId.replace(/^controlled-real-coding-v2\./, "");
  const runRoot = join(suiteRoot, "runs", runName);
  const pilotOutput = join(suiteRoot, ".runtime", runName, "pilot-output");
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(pilotOutput, { recursive: true });

  const observation = {
    providerRequestArtifact: null,
    suppliedContextArtifact: null,
    rawCandidateArtifact: null,
    materializedPatchArtifact: null,
    providerRequestId: null,
    tokenCounts: { inputTokens: null, outputTokens: null, totalTokens: null },
    providerMs: null,
    providerFailureCode: null
  };

  const observedClient = {
    async execute(request, options) {
      const safeRequest = {
        schemaVersion: "bounded.controlled-pilot-provider-request-observation/v1",
        modelId: request.modelId,
        instruction: request.instruction,
        instructionHash: request.instructionHash,
        requestKey: request.requestKey,
        outputSchema: request.outputSchema,
        outputTokenLimit: request.outputTokenLimit ?? null,
        maxOutputBytes: request.maxOutputBytes,
        remainingRuntimeMs: request.remainingRuntimeMs
      };
      serializeCanonicalFile(join(runRoot, "provider-request.json"), safeRequest);
      observation.providerRequestArtifact = "provider-request.json";
      let instruction;
      try { instruction = JSON.parse(request.instruction); }
      catch { fail("OBSERVED_RUN_PROVIDER_INSTRUCTION_INVALID"); }
      if (!Array.isArray(instruction.workspaceFiles)) {
        fail("OBSERVED_RUN_SUPPLIED_CONTEXT_INVALID");
      }
      serializeCanonicalFile(join(runRoot, "supplied-context.json"), instruction.workspaceFiles);
      observation.suppliedContextArtifact = "supplied-context.json";

      const started = performance.now();
      try {
        const response = await concreteClient.execute(request, options);
        observation.providerMs = performance.now() - started;
        const candidate = serializeCanonicalFile(
          join(runRoot, "raw-provider-candidate.json"), response.output
        );
        observation.rawCandidateArtifact = "raw-provider-candidate.json";
        observation.rawCandidateHash = candidate.sha256;
        observation.providerRequestId = response.providerRequestId ?? null;
        if (response.usage && typeof response.usage === "object") {
          observation.tokenCounts = {
            inputTokens: response.usage.inputTokens ?? null,
            outputTokens: response.usage.outputTokens ?? null,
            totalTokens: response.usage.totalTokens ?? null
          };
        }
        return response;
      } catch (error) {
        observation.providerMs = performance.now() - started;
        observation.providerFailureCode = typeof error?.code === "string"
          ? error.code : null;
        throw error;
      }
    }
  };

  const totalStarted = performance.now();
  const returnedReport = await runControlledCodingPilot({
    sourceRoot,
    definitionPath,
    output: pilotOutput,
    executeProvider: true,
    confirmLive: true,
    modelClient: observedClient,
    modelId: providerConfig.modelId
  });
  const totalRunMs = performance.now() - totalStarted;
  copyPilotArtifactsIntoRun(pilotOutput, runRoot);

  const reportPath = join(runRoot, "pilot-output", "pilot-report.json");
  const pilotReportBytes = readFileSync(reportPath);
  let report;
  try { report = JSON.parse(pilotReportBytes.toString("utf8")); }
  catch { fail("OBSERVED_RUN_PILOT_REPORT_INVALID"); }
  if (report.status !== returnedReport.status || report.pilotId !== pilotId ||
      report.sourceCommit !== sourceCommit) {
    fail("OBSERVED_RUN_PILOT_REPORT_MISMATCH");
  }

  if (existsSync(join(runRoot, "pilot-output", "generated.patch"))) {
    observation.materializedPatchArtifact = "pilot-output/generated.patch";
  } else if (existsSync(join(runRoot, "pilot-output", "rejected-candidate.patch"))) {
    observation.materializedPatchArtifact = "pilot-output/rejected-candidate.patch";
  }

  const suppliedContextBytes = readFileSync(join(runRoot, observation.suppliedContextArtifact));
  const suppliedContext = JSON.parse(suppliedContextBytes.toString("utf8"));
  const providerRequest = JSON.parse(readFileSync(
    join(runRoot, observation.providerRequestArtifact), "utf8"
  ));
  const patchHash = observation.materializedPatchArtifact
    ? sha256Bytes(readFileSync(join(runRoot, observation.materializedPatchArtifact)))
    : null;
  const rawCandidateHash = observation.rawCandidateArtifact
    ? sha256Bytes(readFileSync(join(runRoot, observation.rawCandidateArtifact)))
    : null;
  const outcomes = deriveOutcomes(task.definition, report);

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
    sourceTargets: sourceTargetRecords(sourceRoot, sourceCommit, task.definition),
    modelId: config.modelId,
    provider: config.provider,
    modelParameters: config.modelParameters,
    runtimeBudget: config.runtimeBudget,
    suppliedContextArtifact: observation.suppliedContextArtifact,
    suppliedContextHash: hashCanonicalJson(suppliedContext),
    providerRequestArtifact: observation.providerRequestArtifact,
    providerInstructionHash: providerRequest.instructionHash,
    rawCandidateArtifact: observation.rawCandidateArtifact,
    rawCandidateHash,
    materializedPatchArtifact: observation.materializedPatchArtifact,
    materializedPatchHash: patchHash,
    verifierOutcome: outcomes.verifierOutcome,
    acceptanceOutcome: outcomes.acceptanceOutcome,
    tokenCounts: observation.tokenCounts,
    latencyMs: {
      providerMs: observation.providerMs,
      totalRunMs
    },
    providerRequestId: observation.providerRequestId,
    providerFailureCode: observation.providerFailureCode,
    providerCallCount: report.providerCallCount,
    retryCount: report.retryCount,
    status: report.status,
    failureCode: report.failureCode,
    sourceWorktreeMutated: report.sourceWorktreeMutated,
    cleanupCompleted: report.cleanupCompleted,
    rejectedCandidateArtifacts: candidateArtifacts(runRoot, report, observation),
    pilotReportArtifact: "pilot-output/pilot-report.json",
    pilotReportHash: sha256Bytes(pilotReportBytes)
  };
  serializeCanonicalFile(join(runRoot, "run-provenance.json"), provenance);
  const runProvenanceHash = hashCanonicalJson(provenance);
  return {
    pilotId,
    status: report.status,
    failureCode: report.failureCode,
    relativePath: `runs/${runName}/run-provenance.json`,
    runProvenanceHash
  };
}

async function main() {
  const sourceRoot = resolve(argument("--source-root") ?? process.cwd());
  const evidenceRoot = resolve(sourceRoot, argument("--evidence-root") ?? DEFAULT_EVIDENCE_ROOT);
  if (!process.argv.includes("--execute-provider") ||
      !process.argv.includes("--confirm-live") ||
      process.env.CONTROLLED_OBSERVED_RUN_ATTESTATION !== RUN_ATTESTATION) {
    fail("OBSERVED_RUN_CONFIRMATION_REQUIRED");
  }
  ensureCleanSource(sourceRoot);
  const sourceCommit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const providerConfig = liveProviderConfiguration(process.env);
  if (!providerConfig) fail("OBSERVED_RUN_PROVIDER_CONFIGURATION_MISSING");

  const concrete = await makeConcreteClient(providerConfig);
  const config = experimentConfig(providerConfig, concrete.clientSchemaVersion);
  const configHash = hashCanonicalJson(config);
  const temporary = await mkdtemp(join(tmpdir(), "controlled-pilot-v2-observed-"));
  const suiteRoot = join(temporary, "suite");
  mkdirSync(join(suiteRoot, "runs"), { recursive: true });
  mkdirSync(join(suiteRoot, ".runtime"), { recursive: true });
  const runSummaries = [];

  try {
    for (const pilotId of REQUIRED_PILOT_IDS) {
      runSummaries.push(await runOne({
        sourceRoot,
        sourceCommit,
        suiteRoot,
        pilotId,
        providerConfig,
        concreteClient: concrete.client,
        config,
        configHash
      }));
    }
    writeFileSync(join(suiteRoot, "experiment-config.json"), `${canonicalJson(config)}\n`, {
      flag: "wx"
    });
    writeFileSync(join(suiteRoot, "suite-summary.json"), `${canonicalJson({
      schemaVersion: "bounded.controlled-coding-pilot-observed-suite/v1",
      sourceCommit,
      experimentConfigHash: configHash,
      runs: runSummaries
    })}\n`, { flag: "wx" });
    await rm(join(suiteRoot, ".runtime"), { recursive: true, force: true });

    const published = publishObservedEvidence({
      evidenceRoot,
      suiteDirectory: suiteRoot,
      sourceCommit,
      experimentConfig: config,
      runSummaries
    });
    const verified = verifyObservedEvidence({
      bundleDir: published.finalDirectory,
      expectedSourceCommit: sourceCommit,
      repositoryRoot: sourceRoot
    });
    process.stdout.write([
      "CONTROLLED_PILOT_V2_OBSERVED=PASS",
      `sourceCommit=${sourceCommit}`,
      `modelId=${providerConfig.modelId}`,
      `transport=${providerConfig.transport}`,
      `experimentConfigHash=${published.experimentConfigHash}`,
      `evidenceHash=${published.evidenceHash}`,
      `evidenceDirectory=${relative(sourceRoot, published.finalDirectory).split("\\").join("/")}`,
      ...runSummaries.map((run) => `${run.pilotId}=${run.status}${
        run.failureCode ? `:${run.failureCode}` : ""
      }`),
      `verifiedRunCount=${verified.runCount}`
    ].join("\n") + "\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`CONTROLLED_PILOT_V2_OBSERVED=FAIL\nerrorCode=${
      typeof error?.code === "string" ? error.code : "OBSERVED_RUN_INTERNAL_ERROR"
    }\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EVIDENCE_ROOT,
  RUN_ATTESTATION,
  deriveOutcomes,
  experimentConfig
};
