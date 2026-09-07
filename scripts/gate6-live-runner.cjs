#!/usr/bin/env node
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const base = require("./gate6-live-runner-v3.cjs");
const verifier = require("./lib/gate6-verifier-provenance.cjs");
const {
  PROVIDER_CONTRACT_HASH,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_PROMPT_VERSION,
  providerContractDescriptor,
  providerContractRules,
  providerStructuralExample
} = require("./lib/gate6-live-provider-contract.cjs");
const {
  PROPOSAL_VALIDATION_FAILURE_CODES,
  classifyProposalDiagnostic
} = require("./lib/gate6-proposal-validation-diagnostics.cjs");

const STRUCTURED_OUTPUT_MODE = base.STRUCTURED_OUTPUT_MODE;
const LIVE_PROVIDER_PROMPT_VERSION = PROVIDER_PROMPT_VERSION;
const LIVE_PROVIDER_CONTRACT_VERSION = PROVIDER_CONTRACT_VERSION;
const LIVE_PROVIDER_CONTRACT_HASH = PROVIDER_CONTRACT_HASH;
const PROPOSAL_DIAGNOSTIC_FIELDS = Object.freeze([
  "proposalValidationFailureCode",
  "proposalSchemaVersionValid",
  "proposalAction",
  "proposalEditCount",
  "proposalSummaryLength",
  "invalidEditIndex"
]);

base.checkpoint.configureProviderContractIdentity(
  LIVE_PROVIDER_CONTRACT_VERSION,
  LIVE_PROVIDER_CONTRACT_HASH
);

function withCanonicalProviderContract(request) {
  const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
  const userIndex = messages.findIndex((message) => message?.role === "user" && typeof message?.content === "string");
  if (userIndex < 0) throw new base.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_PROMPT_USER_MESSAGE_MISSING");
  let priorInstruction;
  try { priorInstruction = JSON.parse(messages[userIndex].content); }
  catch { throw new base.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_PROMPT_INSTRUCTION_INVALID"); }
  const descriptor = providerContractDescriptor();
  const instruction = {
    benchmark: priorInstruction.benchmark ?? "Gate 6 live benchmark",
    providerPromptVersion: LIVE_PROVIDER_PROMPT_VERSION,
    providerContractVersion: LIVE_PROVIDER_CONTRACT_VERSION,
    providerContractHash: LIVE_PROVIDER_CONTRACT_HASH,
    phase: priorInstruction.phase,
    rules: structuredClone(descriptor.rules),
    outputContract: structuredClone(descriptor.outputContract),
    structuralExample: structuredClone(descriptor.structuralExample),
    publicTask: structuredClone(priorInstruction.publicTask),
    resolvedContext: structuredClone(priorInstruction.resolvedContext)
  };
  const nextMessages = messages.map((message, index) => index === userIndex
    ? { ...message, content: JSON.stringify(instruction) }
    : { ...message });
  return Object.freeze({
    ...request,
    body: Object.freeze({
      ...request.body,
      messages: Object.freeze(nextMessages),
      response_format: Object.freeze({ type: "json_object" })
    })
  });
}

function buildProviderRequest(input) {
  return withCanonicalProviderContract(base.buildProviderRequest(input));
}

function proposalDiagnosticForResult(result) {
  if (result?.kind !== "ok" || !result.output || typeof result.output !== "object" || Array.isArray(result.output)) {
    return Object.freeze({
      proposalValidationFailureCode: null,
      proposalSchemaVersionValid: false,
      proposalAction: null,
      proposalEditCount: null,
      proposalSummaryLength: null,
      invalidEditIndex: null
    });
  }
  return classifyProposalDiagnostic(result.output.proposal);
}

function wrapProviderWithCanonicalContract(provider, records = []) {
  return Object.freeze({
    async execute(input) {
      const request = withCanonicalProviderContract(input.request);
      const result = await provider.execute({ ...input, request });
      records.push(Object.freeze({
        phase: input.phase,
        strategy: input.contextResult?.strategy ?? input.strategy,
        responseHash: result?.responseHash ?? null,
        providerRequestId: result?.providerRequestId ?? null,
        diagnostic: proposalDiagnosticForResult(result)
      }));
      return result;
    }
  });
}

function createOpenAICompatibleProvider(config, options = {}) {
  return wrapProviderWithCanonicalContract(base.createOpenAICompatibleProvider(config, options), []);
}

function traceMatchesRecord(trace, record) {
  if (record.providerRequestId !== null && trace.providerRequestId !== null) {
    return record.providerRequestId === trace.providerRequestId;
  }
  return record.responseHash !== null &&
    record.responseHash === trace.responseHash &&
    record.phase === trace.phase &&
    record.strategy === trace.strategy;
}

function attachProposalDiagnostics(report, records) {
  const copy = structuredClone(report);
  const used = new Set();
  for (const outcome of copy.sampleOutcomes ?? []) {
    outcome.providerTrace = (outcome.providerTrace ?? []).map((trace) => {
      const index = records.findIndex((record, candidateIndex) =>
        !used.has(candidateIndex) && traceMatchesRecord(trace, record));
      if (index < 0) return trace;
      used.add(index);
      return { ...trace, ...records[index].diagnostic };
    });
  }
  if (used.size !== records.length) {
    throw new base.Gate6LiveRunnerError("GATE6_LIVE_PROPOSAL_DIAGNOSTIC_UNUSED", `${used.size}:${records.length}`);
  }
  return copy;
}

function createLiveExperimentConfig(
  report,
  structuredOutputMode = STRUCTURED_OUTPUT_MODE,
  providerPromptVersion = LIVE_PROVIDER_PROMPT_VERSION,
  providerContractVersion = LIVE_PROVIDER_CONTRACT_VERSION,
  providerContractHash = LIVE_PROVIDER_CONTRACT_HASH
) {
  const prior = base.createLiveExperimentConfig(report, structuredOutputMode, providerPromptVersion);
  if (typeof providerContractVersion !== "string" || providerContractVersion.length === 0) {
    throw new base.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_CONTRACT_VERSION_INVALID");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(providerContractHash)) {
    throw new base.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_CONTRACT_HASH_INVALID");
  }
  return Object.freeze({
    ...structuredClone(prior),
    providerContractVersion,
    providerContractHash
  });
}

function hashLiveExperimentConfig(experimentConfig) {
  return verifier.hashCanonical(experimentConfig);
}

function hardenReport(report, proposalDiagnostics) {
  const diagnosed = attachProposalDiagnostics(report, proposalDiagnostics);
  const experimentConfig = createLiveExperimentConfig(
    diagnosed,
    diagnosed.structuredOutputMode,
    diagnosed.providerPromptVersion,
    LIVE_PROVIDER_CONTRACT_VERSION,
    LIVE_PROVIDER_CONTRACT_HASH
  );
  const core = {
    ...diagnosed,
    providerContractVersion: LIVE_PROVIDER_CONTRACT_VERSION,
    providerContractHash: LIVE_PROVIDER_CONTRACT_HASH,
    experimentConfig,
    experimentConfigHash: hashLiveExperimentConfig(experimentConfig)
  };
  delete core.reportHash;
  return Object.freeze({ ...core, reportHash: verifier.hashCanonical(core) });
}

function augmentReport(report, structuredOutputMode = STRUCTURED_OUTPUT_MODE, diagnostics = []) {
  const prior = base.augmentReport(report, structuredOutputMode, diagnostics);
  return hardenReport(prior, []);
}

function stableProjection(report) {
  const copy = base.stableProjection(report);
  for (const outcome of copy.sampleOutcomes ?? []) {
    for (const trace of outcome.providerTrace ?? []) {
      for (const field of PROPOSAL_DIAGNOSTIC_FIELDS) delete trace[field];
    }
  }
  return copy;
}

async function runGate6LiveBenchmark(options = {}, dependencies = {}) {
  const providerConfig = dependencies.providerConfig ?? base.validateProviderConfig(options.environment ?? process.env);
  const proposalDiagnostics = [];
  const underlyingProvider = dependencies.provider ?? base.createObservedOpenAICompatibleProvider(
    providerConfig,
    dependencies.providerOptions
  );
  const report = await base.runGate6LiveBenchmark(
    { ...options, output: undefined },
    {
      ...dependencies,
      providerConfig,
      provider: wrapProviderWithCanonicalContract(underlyingProvider, proposalDiagnostics)
    }
  );
  const hardened = hardenReport(report, proposalDiagnostics);
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(hardened, null, 2)}\n`);
  }
  return hardened;
}

async function runCli(argv = process.argv, dependencies = {}) {
  const options = base.parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  node scripts/gate6-live-runner.cjs --live --repetitions=3 --output=/path/to/raw-report.json",
      "",
      `Structured output: ${STRUCTURED_OUTPUT_MODE}`,
      `Provider prompt: ${LIVE_PROVIDER_PROMPT_VERSION}`,
      `Provider contract: ${LIVE_PROVIDER_CONTRACT_VERSION}`,
      `Provider contract hash: ${LIVE_PROVIDER_CONTRACT_HASH}`,
      "Provider transport uses response_format.type=json_object; the canonical versioned provider contract is enforced locally with no repair, sanitizer, or retry fallback."
    ].join("\n") + "\n");
    return null;
  }
  const report = await runGate6LiveBenchmark(options, dependencies);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: report.schemaVersion,
    researchStatus: report.researchStatus,
    structuredOutputMode: report.structuredOutputMode,
    providerPromptVersion: report.providerPromptVersion,
    providerContractVersion: report.providerContractVersion,
    providerContractHash: report.providerContractHash,
    experimentConfigHash: report.experimentConfigHash,
    sampleCount: report.sampleCount,
    resumedFromCheckpoint: report.resumedFromCheckpoint ?? false,
    checkpointResumeCount: report.checkpointResumeCount ?? 0,
    output: options.output ?? null,
    reportHash: report.reportHash
  })}\n`);
  return report;
}

module.exports = {
  ...base,
  LIVE_PROVIDER_CONTRACT_HASH,
  LIVE_PROVIDER_CONTRACT_VERSION,
  LIVE_PROVIDER_PROMPT_VERSION,
  PROPOSAL_VALIDATION_FAILURE_CODES,
  STRUCTURED_OUTPUT_MODE,
  attachProposalDiagnostics,
  augmentReport,
  buildProviderRequest,
  classifyProposalDiagnostic,
  createLiveExperimentConfig,
  createOpenAICompatibleProvider,
  hashLiveExperimentConfig,
  hardenReport,
  providerContractDescriptor,
  providerContractRules,
  providerStructuralExample,
  runCli,
  runGate6LiveBenchmark,
  stableProjection,
  withCanonicalProviderContract,
  wrapProviderWithCanonicalContract
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
