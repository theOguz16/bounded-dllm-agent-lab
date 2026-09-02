#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");

const verifier = require("./lib/gate6-verifier-provenance.cjs");
const {
  STRATEGIES,
  resolveContext
} = require("./lib/gate6-context-strategies.cjs");
const {
  CANDIDATE_SELECTION_VERSION,
  resolveEscalatingContext,
  validateCandidateSelection
} = require("./lib/gate6-context-escalation.cjs");
const {
  FAILURE_CODES,
  PROPOSAL_VERSION,
  createGate6SimulatedCodingHarness,
  providerFailure,
  validateProposal
} = require("./lib/gate6-simulated-coding-harness.cjs");
const {
  createDisposableWorkspaceFactory
} = require("./lib/gate6-simulated-workspace.cjs");
const {
  SCORER_VERSION,
  SELECTION_EVIDENCE_VERSION,
  scoreGate6SelectionEvidence
} = require("./lib/gate6-oracle-scorer.cjs");
const {
  MIN_REPETITIONS,
  OBSERVATION_VERSION,
  createGate6ComparativeReport,
  validateObservation
} = require("./lib/gate6-comparative-report.cjs");
const { createPublicGate6Task } = require("./lib/gate6-oracle.cjs");
const { getProbe } = require("./lib/gate6-precondition-probes.cjs");

const ROOT = path.resolve(__dirname, "..");
const LIVE_RUN_VERSION = "gate6-live-run/v1";
const LIVE_MODEL_OUTPUT_VERSION = "gate6-live-model-output/v1";
const DIAGNOSTIC_STATUS = "diagnostic_live_smoke";
const FULL_STATUS = "full_live_candidate";
const DEFAULT_REPETITIONS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const STRATEGY_ALIASES = Object.freeze({
  C: "C_synthetic_context",
  E: "E_bounded_workspace_boundary",
  F: "F_adaptive_compressed_boundary",
  CE: "CE_escalating_context"
});
const LIVE_MODEL_OUTPUT_FIELDS = Object.freeze(["schemaVersion", "selection", "proposal"]);

class Gate6LiveRunnerError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6LiveRunnerError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6LiveRunnerError(code, detail);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parsePositiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(code, String(value));
  return parsed;
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument === name) {
    if (index + 1 >= argv.length) fail("GATE6_LIVE_ARG_VALUE_REQUIRED", name);
    return { value: argv[index + 1], consumed: 1 };
  }
  return null;
}

function parseArgs(argv = process.argv) {
  const options = { live: false, repetitions: DEFAULT_REPETITIONS };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live") {
      options.live = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    let parsed = optionValue(argv, index, "--task-limit");
    if (parsed) {
      options.taskLimit = parsePositiveInteger(parsed.value, "GATE6_LIVE_TASK_LIMIT_INVALID");
      index += parsed.consumed;
      continue;
    }
    parsed = optionValue(argv, index, "--task-id");
    if (parsed) {
      if (!parsed.value) fail("GATE6_LIVE_TASK_ID_INVALID");
      options.taskId = parsed.value;
      index += parsed.consumed;
      continue;
    }
    parsed = optionValue(argv, index, "--strategy");
    if (parsed) {
      const strategy = STRATEGY_ALIASES[parsed.value] ?? parsed.value;
      if (!STRATEGIES.includes(strategy)) fail("GATE6_LIVE_STRATEGY_INVALID", parsed.value);
      options.strategy = strategy;
      index += parsed.consumed;
      continue;
    }
    parsed = optionValue(argv, index, "--repetitions");
    if (parsed) {
      options.repetitions = parsePositiveInteger(parsed.value, "GATE6_LIVE_REPETITIONS_INVALID");
      index += parsed.consumed;
      continue;
    }
    parsed = optionValue(argv, index, "--output");
    if (parsed) {
      if (!parsed.value) fail("GATE6_LIVE_OUTPUT_INVALID");
      options.output = path.resolve(parsed.value);
      index += parsed.consumed;
      continue;
    }
    fail("GATE6_LIVE_ARG_UNKNOWN", argument);
  }
  return options;
}

function calculateExpectedSampleCount(taskCount = 42, strategyCount = 4, repetitions = 3) {
  for (const [name, value] of Object.entries({ taskCount, strategyCount, repetitions })) {
    if (!Number.isSafeInteger(value) || value < 1) fail("GATE6_LIVE_SAMPLE_COUNT_INPUT_INVALID", name);
  }
  return taskCount * strategyCount * repetitions;
}

function sampleKey(sample) {
  return `${sample.task.taskId}\0${sample.strategy}\0${sample.repetition}`;
}

function assertUniqueSampleIdentities(samples) {
  const seen = new Set();
  for (const sample of samples) {
    const key = sampleKey(sample);
    if (seen.has(key)) fail("GATE6_LIVE_DUPLICATE_SAMPLE_IDENTITY", key.replaceAll("\0", ":"));
    seen.add(key);
  }
  return true;
}

function selectTasks(tasks, options = {}) {
  let selected = [...tasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (options.taskId) {
    selected = selected.filter((task) => task.taskId === options.taskId);
    if (selected.length !== 1) fail("GATE6_LIVE_TASK_NOT_FOUND", options.taskId);
  }
  if (options.taskLimit !== undefined) selected = selected.slice(0, options.taskLimit);
  if (selected.length === 0) fail("GATE6_LIVE_NO_TASKS_SELECTED");
  return selected;
}

function buildSamplePlan(tasks, options = {}) {
  const selectedTasks = selectTasks(tasks, options);
  const strategies = options.strategy ? [options.strategy] : [...STRATEGIES];
  const repetitions = options.repetitions ?? DEFAULT_REPETITIONS;
  const samples = [];
  for (const task of selectedTasks) {
    for (const strategy of strategies) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        samples.push(Object.freeze({ task, strategy, repetition }));
      }
    }
  }
  assertUniqueSampleIdentities(samples);
  return Object.freeze({
    tasks: Object.freeze(selectedTasks),
    strategies: Object.freeze(strategies),
    repetitions,
    samples: Object.freeze(samples)
  });
}

function validateProviderConfig(environment = process.env) {
  const endpoint = environment.GATE6_OPENAI_ENDPOINT;
  const model = environment.GATE6_MODEL;
  const apiKey = environment.GATE6_API_KEY;
  const maxCompletionTokens = Number(environment.GATE6_MAX_COMPLETION_TOKENS);
  if (typeof endpoint !== "string" || endpoint.length === 0) fail("GATE6_LIVE_PROVIDER_ENDPOINT_INVALID");
  let parsed;
  try { parsed = new URL(endpoint); }
  catch { fail("GATE6_LIVE_PROVIDER_ENDPOINT_INVALID"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("GATE6_LIVE_PROVIDER_ENDPOINT_INVALID");
  if (typeof model !== "string" || model.trim().length === 0) fail("GATE6_LIVE_PROVIDER_MODEL_INVALID");
  if (typeof apiKey !== "string" || apiKey.length === 0) fail("GATE6_LIVE_PROVIDER_CREDENTIAL_INVALID");
  if (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 1) {
    fail("GATE6_LIVE_PROVIDER_MAX_COMPLETION_TOKENS_INVALID");
  }
  return Object.freeze({ endpoint, model: model.trim(), apiKey, maxCompletionTokens });
}

function liveOutputJsonSchema() {
  const stringArray = { type: "array", items: { type: "string" }, maxItems: 64 };
  return {
    name: "gate6_live_model_output",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [...LIVE_MODEL_OUTPUT_FIELDS],
      properties: {
        schemaVersion: { type: "string", const: LIVE_MODEL_OUTPUT_VERSION },
        selection: {
          type: "object",
          additionalProperties: false,
          required: ["schemaVersion", "candidateFiles", "candidateSymbols", "candidateTestFiles", "candidateTestAnchors"],
          properties: {
            schemaVersion: { type: "string", const: CANDIDATE_SELECTION_VERSION },
            candidateFiles: stringArray,
            candidateSymbols: stringArray,
            candidateTestFiles: stringArray,
            candidateTestAnchors: stringArray
          }
        },
        proposal: {
          type: "object",
          additionalProperties: false,
          required: ["schemaVersion", "action", "edits", "summary"],
          properties: {
            schemaVersion: { type: "string", const: PROPOSAL_VERSION },
            action: { type: "string", enum: ["patch", "no_change"] },
            edits: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "expectedContentHash", "oldText", "newText"],
                properties: {
                  path: { type: "string" },
                  expectedContentHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
                  oldText: { type: "string" },
                  newText: { type: "string" }
                }
              }
            },
            summary: { type: "string", maxLength: 2000 }
          }
        }
      }
    }
  };
}

function buildProviderRequest({ config, task, contextResult, phase }) {
  const publicTask = createPublicGate6Task(task);
  let resolvedContext;
  try { resolvedContext = JSON.parse(contextResult.context); }
  catch { fail("GATE6_LIVE_CONTEXT_NOT_JSON", task.taskId); }
  const instruction = {
    benchmark: "Gate 6 live benchmark",
    phase,
    rules: [
      "Return only JSON matching the supplied response schema.",
      "Selection must contain only candidates justified by the public task and resolved context.",
      "Proposal edits must be minimal and stay inside the public authority and candidate universe.",
      "Do not invent hidden acceptance criteria or hidden oracle data."
    ],
    publicTask,
    resolvedContext
  };
  return Object.freeze({
    endpoint: config.endpoint,
    body: {
      model: config.model,
      messages: [
        { role: "system", content: "You are executing a frozen coding benchmark. Output strict JSON only." },
        { role: "user", content: JSON.stringify(instruction) }
      ],
      temperature: 0,
      max_tokens: config.maxCompletionTokens,
      n: 1,
      stream: false,
      response_format: { type: "json_schema", json_schema: liveOutputJsonSchema() }
    }
  });
}

function responseUsage(body) {
  const usage = isPlainObject(body?.usage) ? body.usage : {};
  const inputTokens = Number.isFinite(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0
    ? usage.total_tokens
    : inputTokens + outputTokens;
  return Object.freeze({ inputTokens, outputTokens, totalTokens });
}

function createOpenAICompatibleProvider(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") fail("GATE6_LIVE_FETCH_UNAVAILABLE");
  return Object.freeze({
    async execute({ request }) {
      const started = process.hrtime.bigint();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(request.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(request.body),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) throw providerFailure("GATE6_PROVIDER_TIMEOUT", "provider request timed out");
        throw providerFailure("GATE6_PROVIDER_NETWORK_ERROR", error?.message ?? "provider network error");
      } finally {
        clearTimeout(timer);
      }
      const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const responseText = await response.text();
      if (!response.ok) {
        throw providerFailure(`GATE6_PROVIDER_HTTP_${response.status}`, `provider returned HTTP ${response.status}`);
      }
      let body;
      try { body = JSON.parse(responseText); }
      catch { throw providerFailure("GATE6_PROVIDER_PROTOCOL_INVALID", "provider response body is not JSON"); }
      const content = body?.choices?.[0]?.message?.content;
      const usage = responseUsage(body);
      const providerRequestId = response.headers.get("x-request-id") ?? null;
      if (typeof content !== "string") {
        return Object.freeze({
          kind: "model_output_invalid",
          usage,
          latencyMs,
          responseHash: sha256(responseText),
          providerRequestId
        });
      }
      let output;
      try { output = JSON.parse(content); }
      catch {
        return Object.freeze({
          kind: "model_output_invalid",
          usage,
          latencyMs,
          responseHash: sha256(content),
          providerRequestId
        });
      }
      return Object.freeze({
        kind: "ok",
        output,
        usage,
        latencyMs,
        responseHash: sha256(content),
        providerRequestId
      });
    }
  });
}

function validateProviderResult(result) {
  if (!isPlainObject(result)) fail("GATE6_LIVE_PROVIDER_RESULT_INVALID");
  if (result.kind !== "ok" && result.kind !== "model_output_invalid") {
    fail("GATE6_LIVE_PROVIDER_RESULT_INVALID");
  }
  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0) {
      fail("GATE6_LIVE_PROVIDER_USAGE_INVALID", key);
    }
  }
  if (typeof result.latencyMs !== "number" || !Number.isFinite(result.latencyMs) || result.latencyMs < 0) {
    fail("GATE6_LIVE_PROVIDER_LATENCY_INVALID");
  }
  return result;
}

function normalizeLiveModelOutput(value, task) {
  if (!sameKeys(value, LIVE_MODEL_OUTPUT_FIELDS) || value.schemaVersion !== LIVE_MODEL_OUTPUT_VERSION) return null;
  const selection = validateCandidateSelection(value.selection, task);
  const proposal = validateProposal(value.proposal);
  if (selection === null || proposal === null) return null;
  return Object.freeze({ selection, proposal });
}

function emptySelectionEvidence() {
  return Object.freeze({
    schemaVersion: SELECTION_EVIDENCE_VERSION,
    selectedFiles: Object.freeze([]),
    selectedSymbols: Object.freeze([]),
    selectedTestFiles: Object.freeze([]),
    selectedTestAnchors: Object.freeze([])
  });
}

function selectionEvidence(selection) {
  if (selection === null) return emptySelectionEvidence();
  return Object.freeze({
    schemaVersion: SELECTION_EVIDENCE_VERSION,
    selectedFiles: Object.freeze([...selection.candidateFiles]),
    selectedSymbols: Object.freeze([...selection.candidateSymbols]),
    selectedTestFiles: Object.freeze([...selection.candidateTestFiles]),
    selectedTestAnchors: Object.freeze([...selection.candidateTestAnchors])
  });
}

function invalidProposal() {
  return Object.freeze({ invalid: true });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...(options.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000
  });
  return Object.freeze({
    exitCode: result.status === null ? 255 : result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ? String(result.error.message ?? result.error) : null
  });
}

function walkFiles(directory, callback) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) walkFiles(fullPath, callback);
    else callback(fullPath);
  }
}

function transformTypeScriptRuntime(workspaceRoot) {
  const sourceRoot = path.join(workspaceRoot, "source");
  if (!existsSync(sourceRoot)) fail("GATE6_LIVE_TYPESCRIPT_SOURCE_MISSING", workspaceRoot);
  const outputRoot = path.join(workspaceRoot, ".gate6-runtime/source");
  walkFiles(sourceRoot, (sourcePath) => {
    if (!sourcePath.endsWith(".ts")) return;
    const relative = path.relative(sourceRoot, sourcePath);
    const target = path.join(outputRoot, relative.replace(/\.ts$/, ".js"));
    mkdirSync(path.dirname(target), { recursive: true });
    let code;
    try {
      code = stripTypeScriptTypes(readFileSync(sourcePath, "utf8"), { mode: "transform", sourceMap: false });
    } catch (error) {
      fail("GATE6_LIVE_TYPESCRIPT_TRANSFORM_FAILED", `${relative}:${error.message}`);
    }
    code = code.replace(/(["'])((?:\.\.?\/)[^"']+)\.ts\1/g, "$1$2.js$1");
    writeFileSync(target, code);
  });
}

function attestationMap(freezeDocument) {
  return new Map((freezeDocument?.attestations ?? []).map((attestation) => [attestation.repositoryId, attestation]));
}

function createRuntimeCache(freezeDocument) {
  const root = mkdtempSync(path.join(tmpdir(), "gate6-live-runtime-cache-"));
  const byRepository = new Map();
  for (const attestation of freezeDocument?.attestations ?? []) {
    const dependencies = Array.isArray(attestation.exactRuntimeDependencies)
      ? [...attestation.exactRuntimeDependencies]
      : [];
    if (dependencies.length === 0) continue;
    const cacheRoot = path.join(root, attestation.repositoryId.replaceAll("/", "__"));
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(path.join(cacheRoot, "package.json"), "{\"private\":true}\n");
    const result = runCommand("npm", [
      "install",
      "--no-save",
      "--package-lock=false",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...dependencies
    ], { cwd: cacheRoot, timeoutMs: 10 * 60_000 });
    if (result.exitCode !== 0) {
      fail("GATE6_LIVE_RUNTIME_DEPENDENCY_SETUP_FAILED", `${attestation.repositoryId}:${result.stderr.slice(-1000)}`);
    }
    byRepository.set(attestation.repositoryId, path.join(cacheRoot, "node_modules"));
  }
  return Object.freeze({
    root,
    byRepository,
    dispose() { rmSync(root, { recursive: true, force: true }); }
  });
}

function prepareWorkspace({ workspace, task, runtimeCache }) {
  const cachedNodeModules = runtimeCache?.byRepository?.get(task.repositoryId);
  if (cachedNodeModules) {
    const target = path.join(workspace.root, "node_modules");
    if (!existsSync(target)) symlinkSync(cachedNodeModules, target, "dir");
  }
  const probe = getProbe(task.taskId);
  if (probe.includes("./.gate6-runtime/source/")) transformTypeScriptRuntime(workspace.root);
  writeFileSync(path.join(workspace.root, ".gate6-live-probe.mjs"), `${probe}\n`);
  return workspace;
}

function wrapWorkspaceFactory(baseFactory, runtimeCache) {
  return Object.freeze({
    async create(input) {
      const workspace = await baseFactory.create(input);
      try { return prepareWorkspace({ workspace, task: input.task, runtimeCache }); }
      catch (error) {
        try { await workspace.dispose(); } catch {}
        throw error;
      }
    }
  });
}

async function performExternalRepositoryPreflight({ plan, freezeDocument, workspaceFactory }) {
  const taskByRepository = new Map();
  for (const task of plan.tasks) if (!taskByRepository.has(task.repositoryId)) taskByRepository.set(task.repositoryId, task);
  for (const task of taskByRepository.values()) {
    const workspace = await workspaceFactory.create({ task, freezeDocument });
    try {
      const snapshot = await workspace.repositorySnapshot();
      if (snapshot.repositoryId !== task.repositoryId || snapshot.commitSha !== task.commitSha) {
        fail("GATE6_LIVE_EXTERNAL_REPOSITORY_SHA_MISMATCH", task.repositoryId);
      }
    } finally {
      const disposed = await workspace.dispose();
      if (disposed !== true) fail("GATE6_LIVE_EXTERNAL_PREFLIGHT_DISPOSE_FAILED", task.repositoryId);
    }
  }
  return true;
}

function livePreflight(rootPath) {
  verifier.assertCleanGitTree(rootPath);
  const frozen = verifier.loadFrozenBenchmark(rootPath);
  const sourceCommit = verifier.gitHead(rootPath);
  const freezeDocumentPath = path.join(rootPath, "benchmarks/gate6/precondition-freeze.json");
  const freezeDocument = JSON.parse(readFileSync(freezeDocumentPath, "utf8"));
  return Object.freeze({ sourceCommit, frozen, freezeDocument });
}

function relevantTestRunner({ workspace, proposal }) {
  const diffCheck = runCommand("git", ["diff", "--check"], { cwd: workspace.root });
  if (diffCheck.exitCode !== 0) return { passed: false, detail: "git_diff_check_failed" };
  for (const edit of proposal.edits) {
    if (!/\.(?:c|m)?js$/.test(edit.path)) continue;
    const syntax = runCommand(process.execPath, ["--check", edit.path], { cwd: workspace.root });
    if (syntax.exitCode !== 0) return { passed: false, detail: `syntax_check_failed:${edit.path}` };
  }
  return { passed: true, detail: null };
}

function acceptanceRunner({ workspace }) {
  const result = runCommand(process.execPath, [".gate6-live-probe.mjs"], { cwd: workspace.root, timeoutMs: 60_000 });
  return {
    passed: result.exitCode === 0,
    detail: result.exitCode === 0 ? null : `frozen_probe_failed:${result.exitCode}`
  };
}

function makeProviderTraceEntry({ phase, contextResult, result }) {
  return Object.freeze({
    phase,
    strategy: contextResult.strategy,
    contextBytes: contextResult.contextBytes,
    contextHash: contextResult.providerContextHash,
    tokens: result.usage.totalTokens,
    latencyMs: result.latencyMs,
    responseHash: result.responseHash ?? null,
    providerRequestId: result.providerRequestId ?? null,
    modelOutputValid: result.kind === "ok"
  });
}

function publicFailureSample({ harnessReport, providerTrace, escalation }) {
  return Object.freeze({
    failureCode: harnessReport.failureCode,
    failureDomain: harnessReport.failureDomain,
    providerFailureCode: harnessReport.providerFailureCode,
    modelCapabilityFailure: harnessReport.modelCapabilityFailure,
    acceptancePassed: harnessReport.metrics.acceptancePassed,
    escalated: escalation?.escalated ?? false,
    escalationReasons: Object.freeze([...(escalation?.escalationReasons ?? [])]),
    initialContextBytes: escalation?.initialContextBytes ?? harnessReport.contextBytes ?? 0,
    incrementalEscalationContextBytes: escalation?.incrementalContextBytes ?? 0,
    totalContextBytes: escalation?.totalContextBytes ?? harnessReport.contextBytes ?? 0,
    providerTrace: Object.freeze(providerTrace.map((entry) => Object.freeze({ ...entry })))
  });
}

function createObservation({ task, strategy, repetition, oracleScore, outcome, accounting }) {
  const observation = {
    schemaVersion: OBSERVATION_VERSION,
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    taskClass: task.taskClass,
    difficulty: task.difficulty,
    strategy,
    repetition,
    fileScopeSuccess: oracleScore.fileScopeSuccess,
    strictOracleSuccess: oracleScore.strictOracleSuccess,
    exactSymbolSuccess: oracleScore.exactSymbolSuccess,
    symbolTruePositiveCount: oracleScore.symbolTruePositiveCount,
    symbolPredictedCount: oracleScore.symbolPredictedCount,
    symbolRequiredCount: oracleScore.symbolRequiredCount,
    criticalImplementationCoveredCount: oracleScore.criticalImplementationCoveredCount,
    criticalImplementationRequiredCount: oracleScore.criticalImplementationRequiredCount,
    criticalTestAnchorCoveredCount: oracleScore.criticalTestAnchorCoveredCount,
    criticalTestAnchorRequiredCount: oracleScore.criticalTestAnchorRequiredCount,
    contextBytes: accounting.contextBytes,
    tokens: accounting.tokens,
    latencyMs: accounting.latencyMs,
    scopeViolation: outcome.scopeViolation,
    authorityViolation: outcome.authorityViolation,
    endToEndAccepted: outcome.endToEndAccepted,
    testsPassed: outcome.testsPassed,
    humanIntervention: outcome.humanIntervention,
    escalation: strategy === "CE_escalating_context" ? {
      escalated: accounting.escalated,
      incrementalContextBytes: accounting.incrementalContextBytes,
      incrementalTokens: accounting.incrementalTokens,
      incrementalLatencyMs: accounting.incrementalLatencyMs
    } : null
  };
  return validateObservation(observation);
}

async function executeSample({
  sample,
  oracle,
  frozen,
  freezeDocument,
  provider,
  providerConfig,
  workspaceFactory,
  testRunner,
  acceptance,
  contextResolver = resolveContext,
  escalationResolver = resolveEscalatingContext
}) {
  const providerTrace = [];
  let selected = null;
  let ceAccounting = null;
  const harness = createGate6SimulatedCodingHarness({
    workspaceFactory,
    contextResolver,
    relevantTestRunner: testRunner,
    acceptanceRunner: acceptance,
    modelProposalProvider: async ({ task, contextResult, repositorySnapshot }) => {
      const call = async (phase, resolved) => {
        const request = buildProviderRequest({ config: providerConfig, task, contextResult: resolved, phase });
        const result = validateProviderResult(await provider.execute({ request, task, contextResult: resolved, strategy: sample.strategy, phase }));
        providerTrace.push(makeProviderTraceEntry({ phase, contextResult: resolved, result }));
        return result;
      };

      if (sample.strategy !== "CE_escalating_context") {
        const result = await call("single", contextResult);
        if (result.kind !== "ok") return invalidProposal();
        const normalized = normalizeLiveModelOutput(result.output, task);
        if (normalized === null) return invalidProposal();
        selected = normalized.selection;
        return normalized.proposal;
      }

      const initialContext = contextResolver({ task, repositorySnapshot, strategy: "C_synthetic_context" });
      const initialResult = await call("ce_initial_c", initialContext);
      const rawSelection = initialResult.kind === "ok" && isPlainObject(initialResult.output)
        ? initialResult.output.selection
        : null;
      const escalation = escalationResolver({ task, repositorySnapshot, candidateSelection: rawSelection });
      const incrementalContextBytes = escalation.escalated
        ? escalation.totalContextBytes - initialContext.contextBytes
        : 0;
      ceAccounting = {
        escalated: escalation.escalated,
        escalationReasons: [...escalation.escalationReasons],
        initialContextBytes: initialContext.contextBytes,
        incrementalContextBytes,
        totalContextBytes: escalation.totalContextBytes,
        incrementalTokens: 0,
        incrementalLatencyMs: 0
      };

      if (!escalation.escalated) {
        if (initialResult.kind !== "ok") return invalidProposal();
        const normalized = normalizeLiveModelOutput(initialResult.output, task);
        if (normalized === null) return invalidProposal();
        selected = normalized.selection;
        return normalized.proposal;
      }

      const expandedContext = contextResolver({ task, repositorySnapshot, strategy: "E_bounded_workspace_boundary" });
      const expandedResult = await call("ce_escalated_e", expandedContext);
      ceAccounting.incrementalTokens = expandedResult.usage.totalTokens;
      ceAccounting.incrementalLatencyMs = expandedResult.latencyMs;
      if (expandedResult.kind !== "ok") return invalidProposal();
      const normalized = normalizeLiveModelOutput(expandedResult.output, task);
      if (normalized === null) return invalidProposal();
      selected = normalized.selection;
      return normalized.proposal;
    }
  });

  const harnessReport = await harness({
    task: sample.task,
    freezeDocument,
    strategy: sample.strategy
  });
  const outcome = verifier.deriveHarnessOutcome(harnessReport);
  const evidence = selectionEvidence(selected);
  const oracleScore = scoreGate6SelectionEvidence({ task: sample.task, oracle, selectionEvidence: evidence });
  const totalTokens = providerTrace.reduce((total, entry) => total + entry.tokens, 0);
  const totalLatencyMs = providerTrace.reduce((total, entry) => total + entry.latencyMs, 0);
  const accounting = sample.strategy === "CE_escalating_context"
    ? {
        contextBytes: ceAccounting?.totalContextBytes ?? harnessReport.contextBytes ?? 0,
        tokens: totalTokens,
        latencyMs: totalLatencyMs,
        escalated: ceAccounting?.escalated ?? false,
        incrementalContextBytes: ceAccounting?.incrementalContextBytes ?? 0,
        incrementalTokens: ceAccounting?.incrementalTokens ?? 0,
        incrementalLatencyMs: ceAccounting?.incrementalLatencyMs ?? 0
      }
    : {
        contextBytes: harnessReport.contextBytes ?? 0,
        tokens: totalTokens,
        latencyMs: totalLatencyMs,
        escalated: false,
        incrementalContextBytes: 0,
        incrementalTokens: 0,
        incrementalLatencyMs: 0
      };
  const observation = createObservation({
    task: sample.task,
    strategy: sample.strategy,
    repetition: sample.repetition,
    oracleScore,
    outcome,
    accounting
  });
  const receipt = verifier.createHarnessSampleReceipt({
    observation,
    harnessReport,
    task: sample.task,
    oracle,
    selectionEvidence: evidence
  });
  verifier.validateSampleReceipts({ observations: [observation], sampleReceipts: [receipt], frozen });

  if (outcome.authorityViolation) fail("GATE6_LIVE_REPOSITORY_AUTHORITY_ESCAPE", sampleKey(sample));
  if (outcome.humanIntervention || harnessReport.failureDomain === "infrastructure" || harnessReport.failureCode === FAILURE_CODES.CONTEXT_RESOLUTION_FAILURE) {
    fail("GATE6_LIVE_INFRASTRUCTURE_FAILURE", `${sampleKey(sample)}:${harnessReport.failureCode ?? "human_intervention"}`);
  }

  return Object.freeze({
    observation,
    receipt,
    outcome: publicFailureSample({
      harnessReport,
      providerTrace,
      escalation: ceAccounting
    })
  });
}

function fullRun(plan, frozen, options) {
  return !options.taskId && options.taskLimit === undefined && !options.strategy &&
    plan.tasks.length === frozen.tasks.length &&
    plan.strategies.length === STRATEGIES.length &&
    plan.repetitions === MIN_REPETITIONS &&
    plan.samples.length === calculateExpectedSampleCount(frozen.tasks.length, STRATEGIES.length, MIN_REPETITIONS);
}

function stableProjection(report) {
  const copy = structuredClone(report);
  delete copy.reportHash;
  for (const observation of copy.observations ?? []) {
    observation.latencyMs = 0;
    observation.tokens = 0;
    if (observation.escalation) {
      observation.escalation.incrementalLatencyMs = 0;
      observation.escalation.incrementalTokens = 0;
    }
  }
  for (const outcome of copy.sampleOutcomes ?? []) {
    for (const trace of outcome.providerTrace ?? []) {
      trace.latencyMs = 0;
      trace.tokens = 0;
      trace.responseHash = null;
      trace.providerRequestId = null;
    }
  }
  if (copy.comparativeReport) {
    copy.comparativeReport = null;
    copy.aggregates = {};
  }
  return copy;
}

async function runGate6LiveBenchmark(options = {}, dependencies = {}) {
  if (options.live !== true) fail("GATE6_LIVE_FLAG_REQUIRED");
  const rootPath = options.rootPath ?? ROOT;
  const providerConfig = dependencies.providerConfig ?? validateProviderConfig(options.environment ?? process.env);
  const preflight = dependencies.preflight
    ? await dependencies.preflight({ rootPath, options })
    : livePreflight(rootPath);
  const { frozen, sourceCommit, freezeDocument } = preflight;
  if (!frozen || !Array.isArray(frozen.tasks) || !Array.isArray(frozen.oracles)) fail("GATE6_LIVE_FROZEN_STATE_INVALID");
  const plan = buildSamplePlan(frozen.tasks, options);
  const oracleById = new Map(frozen.oracles.map((oracle) => [oracle.taskId, oracle]));
  for (const task of plan.tasks) if (!oracleById.has(task.taskId)) fail("GATE6_LIVE_ORACLE_MISSING", task.taskId);

  let runtimeCache = null;
  let workspaceFactory = dependencies.workspaceFactory;
  try {
    if (!workspaceFactory) {
      runtimeCache = dependencies.runtimeCache ?? createRuntimeCache(freezeDocument);
      workspaceFactory = wrapWorkspaceFactory(createDisposableWorkspaceFactory(), runtimeCache);
    }
    const externalPreflight = dependencies.externalPreflight ?? performExternalRepositoryPreflight;
    await externalPreflight({ plan, freezeDocument, workspaceFactory });

    const provider = dependencies.provider ?? createOpenAICompatibleProvider(providerConfig, dependencies.providerOptions);
    const observations = [];
    const receipts = [];
    const sampleOutcomes = [];
    for (const sample of plan.samples) {
      const result = await executeSample({
        sample,
        oracle: oracleById.get(sample.task.taskId),
        frozen,
        freezeDocument,
        provider,
        providerConfig,
        workspaceFactory,
        testRunner: dependencies.relevantTestRunner ?? relevantTestRunner,
        acceptance: dependencies.acceptanceRunner ?? acceptanceRunner,
        contextResolver: dependencies.contextResolver ?? resolveContext,
        escalationResolver: dependencies.escalationResolver ?? resolveEscalatingContext
      });
      observations.push(result.observation);
      receipts.push(result.receipt);
      sampleOutcomes.push(Object.freeze({
        taskId: sample.task.taskId,
        strategy: sample.strategy,
        repetition: sample.repetition,
        ...result.outcome
      }));
    }

    verifier.validateSampleReceipts({ observations, sampleReceipts: receipts, frozen });
    const isFull = fullRun(plan, frozen, options);
    const comparativeReport = plan.repetitions >= MIN_REPETITIONS && plan.strategies.length === STRATEGIES.length
      ? createGate6ComparativeReport(observations, { minimumRepetitions: MIN_REPETITIONS })
      : null;
    const core = {
      schemaVersion: LIVE_RUN_VERSION,
      executionClass: "live",
      researchStatus: isFull ? FULL_STATUS : DIAGNOSTIC_STATUS,
      promotionEligible: isFull,
      sourceCommit,
      tasksetVersion: frozen.tasksetReport.schemaVersion,
      tasksetHash: frozen.tasksetReport.tasksetHash,
      benchmarkSemanticsHash: frozen.semantics.benchmarkSemanticsHash,
      repositoryManifestHash: frozen.tasksetReport.repositoryManifestHash,
      preconditionAttestationHash: frozen.tasksetReport.preconditionAttestationHash,
      oracleScorerVersion: SCORER_VERSION,
      receiptVersion: verifier.SAMPLE_RECEIPT_VERSION,
      model: providerConfig.model,
      endpointClass: "openai_compatible",
      temperature: 0,
      maxCompletionTokens: providerConfig.maxCompletionTokens,
      repetitions: plan.repetitions,
      taskCount: plan.tasks.length,
      strategyCount: plan.strategies.length,
      sampleCount: plan.samples.length,
      expectedFullSampleCount: calculateExpectedSampleCount(42, 4, 3),
      filters: {
        taskLimit: options.taskLimit ?? null,
        taskId: options.taskId ?? null,
        strategy: options.strategy ?? null
      },
      observations,
      receipts,
      receiptSetHash: verifier.hashCanonical(receipts.map((receipt) => receipt.receiptHash)),
      sampleOutcomes,
      comparativeReport,
      aggregates: comparativeReport?.aggregates ?? {}
    };
    const report = Object.freeze({ ...core, reportHash: verifier.hashCanonical(core) });
    if (options.output) {
      mkdirSync(path.dirname(options.output), { recursive: true });
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    if (runtimeCache && runtimeCache !== dependencies.runtimeCache) runtimeCache.dispose();
  }
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/gate6-live-runner.cjs --live --repetitions=3 --output=/path/to/raw-report.json",
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
  ].join("\n");
}

async function runCli(argv = process.argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return null;
  }
  const report = await runGate6LiveBenchmark(options, dependencies);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: report.schemaVersion,
    researchStatus: report.researchStatus,
    sampleCount: report.sampleCount,
    output: options.output ?? null,
    reportHash: report.reportHash
  })}\n`);
  return report;
}

module.exports = {
  DIAGNOSTIC_STATUS,
  FULL_STATUS,
  Gate6LiveRunnerError,
  LIVE_MODEL_OUTPUT_VERSION,
  LIVE_RUN_VERSION,
  STRATEGY_ALIASES,
  assertUniqueSampleIdentities,
  buildProviderRequest,
  buildSamplePlan,
  calculateExpectedSampleCount,
  createOpenAICompatibleProvider,
  emptySelectionEvidence,
  liveOutputJsonSchema,
  normalizeLiveModelOutput,
  parseArgs,
  runCli,
  runGate6LiveBenchmark,
  selectionEvidence,
  stableProjection,
  validateProviderConfig
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
