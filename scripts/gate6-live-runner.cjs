#!/usr/bin/env node
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const core = require("./gate6-live-runner-core.cjs");
const verifier = require("./lib/gate6-verifier-provenance.cjs");

const STRUCTURED_OUTPUT_MODE = "json_object_local_strict_validation";
const LIVE_EXPERIMENT_CONFIG_VERSION = "gate6-live-experiment-config/v1";

function withJsonObjectResponseFormat(request) {
  return Object.freeze({
    ...request,
    body: Object.freeze({
      ...request.body,
      response_format: Object.freeze({ type: "json_object" })
    })
  });
}

function buildProviderRequest(input) {
  return withJsonObjectResponseFormat(core.buildProviderRequest(input));
}

function wrapProvider(provider) {
  return Object.freeze({
    async execute(input) {
      return provider.execute({
        ...input,
        request: withJsonObjectResponseFormat(input.request)
      });
    }
  });
}

function createOpenAICompatibleProvider(config, options = {}) {
  return wrapProvider(core.createOpenAICompatibleProvider(config, options));
}

function createLiveExperimentConfig(report, structuredOutputMode = STRUCTURED_OUTPUT_MODE) {
  if (typeof structuredOutputMode !== "string" || structuredOutputMode.length === 0) {
    throw new core.Gate6LiveRunnerError("GATE6_LIVE_STRUCTURED_OUTPUT_MODE_INVALID");
  }
  return Object.freeze({
    schemaVersion: LIVE_EXPERIMENT_CONFIG_VERSION,
    sourceCommit: report.sourceCommit,
    tasksetVersion: report.tasksetVersion,
    tasksetHash: report.tasksetHash,
    benchmarkSemanticsHash: report.benchmarkSemanticsHash,
    repositoryManifestHash: report.repositoryManifestHash,
    preconditionAttestationHash: report.preconditionAttestationHash,
    model: report.model,
    endpointClass: report.endpointClass,
    structuredOutputMode,
    temperature: report.temperature,
    maxCompletionTokens: report.maxCompletionTokens,
    repetitions: report.repetitions,
    taskCount: report.taskCount,
    strategyCount: report.strategyCount,
    filters: structuredClone(report.filters)
  });
}

function hashLiveExperimentConfig(experimentConfig) {
  return verifier.hashCanonical(experimentConfig);
}

function augmentReport(report, structuredOutputMode = STRUCTURED_OUTPUT_MODE) {
  const experimentConfig = createLiveExperimentConfig(report, structuredOutputMode);
  const experimentConfigHash = hashLiveExperimentConfig(experimentConfig);
  const coreReport = {
    ...structuredClone(report),
    structuredOutputMode,
    experimentConfig,
    experimentConfigHash
  };
  delete coreReport.reportHash;
  return Object.freeze({
    ...coreReport,
    reportHash: verifier.hashCanonical(coreReport)
  });
}

async function runGate6LiveBenchmark(options = {}, dependencies = {}) {
  const providerConfig = dependencies.providerConfig ??
    core.validateProviderConfig(options.environment ?? process.env);
  const baseProvider = dependencies.provider ??
    core.createOpenAICompatibleProvider(providerConfig, dependencies.providerOptions);
  const report = await core.runGate6LiveBenchmark(
    { ...options, output: undefined },
    {
      ...dependencies,
      providerConfig,
      provider: wrapProvider(baseProvider)
    }
  );
  const augmented = augmentReport(report);
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(augmented, null, 2)}\n`);
  }
  return augmented;
}

async function runCli(argv = process.argv, dependencies = {}) {
  const options = core.parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  node scripts/gate6-live-runner.cjs --live --repetitions=3 --output=/path/to/raw-report.json",
      "",
      `Structured output: ${STRUCTURED_OUTPUT_MODE}`,
      "Provider transport uses response_format.type=json_object; Gate 6 contracts are enforced locally.",
      "",
      "Filters:",
      "  --task-limit=N",
      "  --task-id=<id>",
      "  --strategy=<C|E|F|CE>",
      "  --repetitions=N",
      "",
      "Environment:",
      "  GATE6_OPENAI_ENDPOINT",
      "  GATE6_MODEL",
      "  GATE6_API_KEY",
      "  GATE6_MAX_COMPLETION_TOKENS"
    ].join("\n") + "\n");
    return null;
  }
  const report = await runGate6LiveBenchmark(options, dependencies);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: report.schemaVersion,
    researchStatus: report.researchStatus,
    structuredOutputMode: report.structuredOutputMode,
    experimentConfigHash: report.experimentConfigHash,
    sampleCount: report.sampleCount,
    output: options.output ?? null,
    reportHash: report.reportHash
  })}\n`);
  return report;
}

module.exports = {
  ...core,
  LIVE_EXPERIMENT_CONFIG_VERSION,
  STRUCTURED_OUTPUT_MODE,
  augmentReport,
  buildProviderRequest,
  createLiveExperimentConfig,
  createOpenAICompatibleProvider,
  hashLiveExperimentConfig,
  runCli,
  runGate6LiveBenchmark,
  withJsonObjectResponseFormat,
  wrapProvider
};

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "GATE6_LIVE_UNEXPECTED",
      message: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  });
}
