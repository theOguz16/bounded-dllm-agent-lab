#!/usr/bin/env node
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const core = require("./gate6-live-runner-core.cjs");
const verifier = require("./lib/gate6-verifier-provenance.cjs");
const {
  validateCandidateSelection
} = require("./lib/gate6-context-escalation.cjs");
const {
  validateProposal
} = require("./lib/gate6-simulated-coding-harness.cjs");
const checkpoint = require("./lib/gate6-live-checkpoint.cjs");

const STRUCTURED_OUTPUT_MODE = "json_object_local_strict_validation";
const LIVE_EXPERIMENT_CONFIG_VERSION = "gate6-live-experiment-config/v1";
const PROVIDER_TRACE_SCHEMA_VERSION = "gate6-provider-trace/v2";
const LOCAL_VALIDATION_FAILURE_CODES = Object.freeze({
  CONTENT_MISSING: "CONTENT_MISSING",
  JSON_PARSE_FAILED: "JSON_PARSE_FAILED",
  TOP_LEVEL_SHAPE_INVALID: "TOP_LEVEL_SHAPE_INVALID",
  TOP_LEVEL_SCHEMA_VERSION_INVALID: "TOP_LEVEL_SCHEMA_VERSION_INVALID",
  SELECTION_INVALID: "SELECTION_INVALID",
  PROPOSAL_INVALID: "PROPOSAL_INVALID",
  NONE: "NONE"
});
const LIVE_MODEL_OUTPUT_FIELDS = Object.freeze(["schemaVersion", "selection", "proposal"]);
const CORE_PATH = path.join(__dirname, "gate6-live-runner-core.cjs");

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

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

function terminationClassification(finishReason) {
  if (finishReason === "length") return "output_token_limit";
  if (typeof finishReason === "string" && finishReason.length > 0) return "normal";
  return "unknown";
}

function classifyLiveModelOutputDiagnostic({ result, task, maxCompletionTokens }) {
  const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const finishReason = result?.finishReason ?? null;
  const completionBudgetReached = Number.isFinite(usage.outputTokens) &&
    Number.isFinite(maxCompletionTokens) &&
    usage.outputTokens >= maxCompletionTokens;
  const base = {
    finishReason,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    maxCompletionTokens,
    completionBudgetReached,
    terminationClassification: terminationClassification(finishReason)
  };
  if (result?.diagnosticFailureCode === LOCAL_VALIDATION_FAILURE_CODES.CONTENT_MISSING) {
    return Object.freeze({ ...base, jsonParsed: false, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.CONTENT_MISSING });
  }
  if (result?.diagnosticFailureCode === LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED || result?.kind !== "ok") {
    return Object.freeze({ ...base, jsonParsed: false, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED });
  }
  const value = result.output;
  if (!sameKeys(value, LIVE_MODEL_OUTPUT_FIELDS)) {
    return Object.freeze({ ...base, jsonParsed: true, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SHAPE_INVALID });
  }
  if (value.schemaVersion !== core.LIVE_MODEL_OUTPUT_VERSION) {
    return Object.freeze({ ...base, jsonParsed: true, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.TOP_LEVEL_SCHEMA_VERSION_INVALID });
  }
  if (validateCandidateSelection(value.selection, task) === null) {
    return Object.freeze({ ...base, jsonParsed: true, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.SELECTION_INVALID });
  }
  if (validateProposal(value.proposal) === null) {
    return Object.freeze({ ...base, jsonParsed: true, localContractValid: false, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.PROPOSAL_INVALID });
  }
  return Object.freeze({ ...base, jsonParsed: true, localContractValid: true, localValidationFailureCode: LOCAL_VALIDATION_FAILURE_CODES.NONE });
}

function createObservedOpenAICompatibleProvider(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return Object.freeze({
    async execute(input) {
      let observed = null;
      const observingFetch = async (...args) => {
        const response = await fetchImpl(...args);
        if (!response.ok) return response;
        try {
          const body = JSON.parse(await response.clone().text());
          const content = body?.choices?.[0]?.message?.content;
          let diagnosticFailureCode = null;
          if (typeof content !== "string") diagnosticFailureCode = LOCAL_VALIDATION_FAILURE_CODES.CONTENT_MISSING;
          else {
            try { JSON.parse(content); }
            catch { diagnosticFailureCode = LOCAL_VALIDATION_FAILURE_CODES.JSON_PARSE_FAILED; }
          }
          observed = { finishReason: body?.choices?.[0]?.finish_reason ?? null, diagnosticFailureCode };
        } catch { observed = null; }
        return response;
      };
      const provider = core.createOpenAICompatibleProvider(config, { ...options, fetchImpl: observingFetch });
      const result = await provider.execute(input);
      return Object.freeze({
        ...result,
        finishReason: observed?.finishReason ?? null,
        diagnosticFailureCode: observed?.diagnosticFailureCode ?? result.diagnosticFailureCode ?? null,
        maxCompletionTokens: config.maxCompletionTokens
      });
    }
  });
}

function wrapProvider(provider, options = {}) {
  const diagnostics = options.diagnostics ?? null;
  const maxCompletionTokens = options.maxCompletionTokens ?? null;
  return Object.freeze({
    async execute(input) {
      const result = await provider.execute({ ...input, request: withJsonObjectResponseFormat(input.request) });
      if (diagnostics) {
        diagnostics.push(Object.freeze({
          phase: input.phase,
          strategy: input.contextResult?.strategy ?? input.strategy,
          diagnostic: classifyLiveModelOutputDiagnostic({
            result,
            task: input.task,
            maxCompletionTokens: result?.maxCompletionTokens ?? maxCompletionTokens
          })
        }));
      }
      return result;
    }
  });
}

function createOpenAICompatibleProvider(config, options = {}) {
  return wrapProvider(createObservedOpenAICompatibleProvider(config, options), { maxCompletionTokens: config.maxCompletionTokens });
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

function augmentProviderDiagnostics(report, diagnostics = []) {
  const copy = structuredClone(report);
  let diagnosticIndex = 0;
  for (const outcome of copy.sampleOutcomes ?? []) {
    outcome.providerTrace = (outcome.providerTrace ?? []).map((trace) => {
      if (trace.schemaVersion === PROVIDER_TRACE_SCHEMA_VERSION) return trace;
      const record = diagnostics[diagnosticIndex];
      if (!record) throw new core.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_DIAGNOSTIC_MISSING", String(diagnosticIndex));
      if (record.phase !== trace.phase || record.strategy !== trace.strategy) {
        throw new core.Gate6LiveRunnerError(
          "GATE6_LIVE_PROVIDER_DIAGNOSTIC_ORDER_MISMATCH",
          `${diagnosticIndex}:${record.phase}:${trace.phase}:${record.strategy}:${trace.strategy}`
        );
      }
      diagnosticIndex += 1;
      return { ...trace, schemaVersion: PROVIDER_TRACE_SCHEMA_VERSION, ...record.diagnostic };
    });
  }
  if (diagnosticIndex !== diagnostics.length) {
    throw new core.Gate6LiveRunnerError("GATE6_LIVE_PROVIDER_DIAGNOSTIC_UNUSED", `${diagnosticIndex}:${diagnostics.length}`);
  }
  return copy;
}

function augmentReport(report, structuredOutputMode = STRUCTURED_OUTPUT_MODE, diagnostics = []) {
  const diagnosedReport = augmentProviderDiagnostics(report, diagnostics);
  const experimentConfig = createLiveExperimentConfig(diagnosedReport, structuredOutputMode);
  const experimentConfigHash = hashLiveExperimentConfig(experimentConfig);
  const coreReport = {
    ...diagnosedReport,
    structuredOutputMode,
    providerTraceSchemaVersion: PROVIDER_TRACE_SCHEMA_VERSION,
    experimentConfig,
    experimentConfigHash
  };
  delete coreReport.reportHash;
  return Object.freeze({ ...coreReport, reportHash: verifier.hashCanonical(coreReport) });
}

function addCheckpointProvenance(report, { resumedFromCheckpoint, checkpointResumeCount }) {
  const copy = { ...structuredClone(report), resumedFromCheckpoint, checkpointResumeCount };
  delete copy.reportHash;
  return Object.freeze({ ...copy, reportHash: verifier.hashCanonical(copy) });
}

function stableProjection(report) {
  const copy = core.stableProjection(report);
  for (const outcome of copy.sampleOutcomes ?? []) {
    for (const trace of outcome.providerTrace ?? []) {
      trace.inputTokens = 0;
      trace.outputTokens = 0;
      trace.totalTokens = 0;
    }
  }
  return copy;
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument === name) {
    if (index + 1 >= argv.length) throw new core.Gate6LiveRunnerError("GATE6_LIVE_ARG_VALUE_REQUIRED", name);
    return { value: argv[index + 1], consumed: 1 };
  }
  return null;
}

function parseArgs(argv = process.argv) {
  const forwarded = argv.slice(0, 2);
  let checkpointPath = null;
  let resumeFrom = null;
  for (let index = 2; index < argv.length; index += 1) {
    let parsed = optionValue(argv, index, "--checkpoint");
    if (parsed) {
      if (!parsed.value) throw new core.Gate6LiveRunnerError("GATE6_LIVE_CHECKPOINT_PATH_INVALID");
      checkpointPath = path.resolve(parsed.value);
      index += parsed.consumed;
      continue;
    }
    parsed = optionValue(argv, index, "--resume-from");
    if (parsed) {
      if (!parsed.value) throw new core.Gate6LiveRunnerError("GATE6_LIVE_RESUME_PATH_INVALID");
      resumeFrom = path.resolve(parsed.value);
      index += parsed.consumed;
      continue;
    }
    forwarded.push(argv[index]);
  }
  const options = core.parseArgs(forwarded);
  if (checkpointPath !== null) options.checkpoint = checkpointPath;
  if (resumeFrom !== null) {
    options.resumeFrom = resumeFrom;
    if (checkpointPath === null) options.checkpoint = resumeFrom;
  }
  return options;
}

function checkpointReportIdentity({ plan, frozen, sourceCommit, providerConfig, options }) {
  return Object.freeze({
    sourceCommit,
    tasksetVersion: frozen.tasksetReport.schemaVersion,
    tasksetHash: frozen.tasksetReport.tasksetHash,
    benchmarkSemanticsHash: frozen.semantics.benchmarkSemanticsHash,
    repositoryManifestHash: frozen.tasksetReport.repositoryManifestHash,
    preconditionAttestationHash: frozen.tasksetReport.preconditionAttestationHash,
    model: providerConfig.model,
    endpointClass: "openai_compatible",
    temperature: 0,
    maxCompletionTokens: providerConfig.maxCompletionTokens,
    repetitions: plan.repetitions,
    taskCount: plan.tasks.length,
    strategyCount: plan.strategies.length,
    filters: {
      taskLimit: options.taskLimit ?? null,
      taskId: options.taskId ?? null,
      strategy: options.strategy ?? null
    }
  });
}

function orderedCheckpointSamples(plan, completedByKey) {
  const ordered = [];
  for (const sample of plan.samples) {
    const key = checkpoint.sampleKey(checkpoint.sampleIdentity(sample));
    const completed = completedByKey.get(key);
    if (completed) ordered.push(completed);
  }
  return ordered;
}

async function runGate6LiveBenchmark(options = {}, dependencies = {}) {
  const providerConfig = dependencies.providerConfig ?? core.validateProviderConfig(options.environment ?? process.env);
  const diagnostics = [];
  const baseProvider = dependencies.provider ?? createObservedOpenAICompatibleProvider(providerConfig, dependencies.providerOptions);
  const checkpointMode = Boolean(options.checkpoint || options.resumeFrom);
  const runnerCore = checkpointMode ? checkpoint.loadInstrumentedCore(CORE_PATH) : core;
  let checkpointContext = null;
  let diagnosticCursor = 0;

  function initializeCheckpointContext(hook) {
    if (!checkpointMode) return null;
    if (checkpointContext) return checkpointContext;
    const reportIdentity = checkpointReportIdentity({ ...hook, options });
    const experimentConfig = createLiveExperimentConfig(reportIdentity, STRUCTURED_OUTPUT_MODE);
    const experimentConfigHash = hashLiveExperimentConfig(experimentConfig);
    const samplePlanHash = checkpoint.hashSamplePlan(hook.plan);
    const identity = checkpoint.createCheckpointIdentity({
      reportIdentity,
      experimentConfigHash,
      samplePlanHash,
      structuredOutputMode: STRUCTURED_OUTPUT_MODE
    });
    let completedByKey = new Map();
    let checkpointResumeCount = 0;
    if (options.resumeFrom) {
      const loaded = checkpoint.readCheckpoint(options.resumeFrom);
      const validated = checkpoint.validateRestoredSamples({
        checkpoint: loaded,
        expectedIdentity: identity,
        plan: hook.plan,
        frozen: hook.frozen
      });
      completedByKey = new Map(validated.restored);
      checkpointResumeCount = validated.checkpointResumeCount + 1;
    }
    checkpointContext = { identity, completedByKey, checkpointResumeCount, plan: hook.plan };
    return checkpointContext;
  }

  const report = await runnerCore.runGate6LiveBenchmark(
    { ...options, output: undefined },
    {
      ...dependencies,
      providerConfig,
      provider: wrapProvider(baseProvider, { diagnostics, maxCompletionTokens: providerConfig.maxCompletionTokens }),
      ...(checkpointMode ? {
        restoreSample: async (hook) => {
          const state = initializeCheckpointContext(hook);
          const key = checkpoint.sampleKey(checkpoint.sampleIdentity(hook.sample));
          return state.completedByKey.get(key) ?? null;
        },
        onSampleCompleted: async (hook) => {
          const state = initializeCheckpointContext(hook);
          const traceCount = hook.outcome.providerTrace?.length ?? 0;
          const sampleDiagnostics = diagnostics.slice(diagnosticCursor, diagnosticCursor + traceCount);
          diagnosticCursor += traceCount;
          const diagnosed = augmentProviderDiagnostics({ sampleOutcomes: [hook.outcome] }, sampleDiagnostics).sampleOutcomes[0];
          const identity = checkpoint.sampleIdentity(hook.sample);
          const key = checkpoint.sampleKey(identity);
          state.completedByKey.set(key, Object.freeze({
            ...identity,
            observation: structuredClone(hook.observation),
            receipt: structuredClone(hook.receipt),
            outcome: structuredClone(diagnosed)
          }));
          const document = checkpoint.createCheckpoint({
            identity: state.identity,
            completedSamples: orderedCheckpointSamples(state.plan, state.completedByKey),
            checkpointResumeCount: state.checkpointResumeCount
          });
          checkpoint.atomicWriteCheckpoint(options.checkpoint, document, dependencies.checkpointWriteHooks);
        }
      } : {})
    }
  );
  let augmented = augmentReport(report, STRUCTURED_OUTPUT_MODE, diagnostics.slice(diagnosticCursor));
  if (checkpointMode) {
    const state = checkpointContext;
    augmented = addCheckpointProvenance(augmented, {
      resumedFromCheckpoint: Boolean(options.resumeFrom),
      checkpointResumeCount: state?.checkpointResumeCount ?? 0
    });
  }
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(augmented, null, 2)}\n`);
  }
  return augmented;
}

async function runCli(argv = process.argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  node scripts/gate6-live-runner.cjs --live --repetitions=3 --output=/path/to/raw-report.json",
      "",
      `Structured output: ${STRUCTURED_OUTPUT_MODE}`,
      `Provider trace: ${PROVIDER_TRACE_SCHEMA_VERSION}`,
      "Provider transport uses response_format.type=json_object; Gate 6 contracts are enforced locally.",
      "",
      "Crash-safe execution:",
      "  --checkpoint=/path/to/checkpoint.json",
      "  --resume-from=/path/to/checkpoint.json",
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
    providerTraceSchemaVersion: report.providerTraceSchemaVersion,
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
  ...core,
  CHECKPOINT_SCHEMA_VERSION: checkpoint.CHECKPOINT_SCHEMA_VERSION,
  LIVE_EXPERIMENT_CONFIG_VERSION,
  LOCAL_VALIDATION_FAILURE_CODES,
  PROVIDER_TRACE_SCHEMA_VERSION,
  STRUCTURED_OUTPUT_MODE,
  addCheckpointProvenance,
  augmentProviderDiagnostics,
  augmentReport,
  buildProviderRequest,
  checkpoint,
  classifyLiveModelOutputDiagnostic,
  createLiveExperimentConfig,
  createOpenAICompatibleProvider,
  createObservedOpenAICompatibleProvider,
  hashLiveExperimentConfig,
  parseArgs,
  runCli,
  runGate6LiveBenchmark,
  stableProjection,
  terminationClassification,
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
