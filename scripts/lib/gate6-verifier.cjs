"use strict";

const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  TASK_CLASS_IDS,
  TASK_CLASS_REGISTRY,
  TASK_CLASS_REGISTRY_VERSION
} = require("./gate6-task-classes.cjs");
const {
  canonicalizeGate6RepositoryManifest,
  validateGate6RepositoryManifest
} = require("./gate6-repository-manifest.cjs");
const {
  FROZEN_REPOSITORY_MANIFEST_HASHES,
  FROZEN_TASKSET_HASHES,
  TASKSET_SCHEMA_VERSION,
  loadFrozenGate6Taskset
} = require("./gate6-taskset.cjs");
const { validateAttestations } = require("./gate6-precondition-freeze.cjs");
const {
  CONTEXT_STRATEGY_VERSION,
  STRATEGIES
} = require("./gate6-context-strategies.cjs");
const {
  MIN_REPETITIONS,
  OBSERVATION_VERSION,
  REPORT_VERSION,
  createGate6ComparativeReport
} = require("./gate6-comparative-report.cjs");

const VERIFIER_VERSION = "gate6-verifier/v1";
const BENCHMARK_SEMANTICS_SCHEMA = "gate6-benchmark-semantics/v1";
const EXPERIMENT_CONFIG_VERSION = "gate6-experiment-config/v1";
const RAW_REPORT_VERSION = "gate6-raw-report/v1";
const EVIDENCE_VERSION = "gate6-evidence/v1";
const RUNTIME_IDENTITY_VERSION = "gate6-runtime-identity/v1";
const SHA256SUMS_VERSION = "gate6-sha256sums/v1";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const FROZEN_BENCHMARK_SEMANTICS_HASHES = Object.freeze({
  "gate6-benchmark/v1": "sha256:07209fc1b4c923ab2432b7745e9c722651887bac454518a53d2a2ae18e9b6262"
});

const EVIDENCE_FILENAMES = Object.freeze([
  "raw-report.json",
  "evidence.json",
  "runtime-identity.txt",
  "SHA256SUMS"
]);

const ORACLE_ONLY_KEYS = new Set([
  "requiredImplementationFiles",
  "requiredTestFiles",
  "requiredSymbols",
  "requiredTestAnchors",
  "allowedTouchedFiles",
  "forbiddenFiles",
  "behavioralChecks"
]);

class Gate6VerifierError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6VerifierError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6VerifierError(code, detail);
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("GATE6_VERIFY_CANONICAL_INVALID");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) fail("GATE6_VERIFY_CANONICAL_INVALID");
  return Object.fromEntries(
    Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])])
  );
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function prettyCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Buffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonical(value) {
  return sha256Buffer(Buffer.from(stableStringify(value), "utf8"));
}

function hashFile(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function readJson(filePath, code = "GATE6_VERIFY_JSON_INVALID") {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    fail("GATE6_VERIFY_FILE_READ_FAILED", filePath);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(code, filePath);
  }
}

function requiredString(value, code, detail) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code, detail);
  return value;
}

function requiredFinite(value, code, detail, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, detail);
  if (options.integer && !Number.isInteger(value)) fail(code, detail);
  if (options.min !== undefined && value < options.min) fail(code, detail);
  return value;
}

function loadGate6Documents(rootPath) {
  const lock = readJson(path.join(rootPath, "benchmarks/gate6/taskset.json"));
  const repositoryManifest = readJson(path.join(rootPath, "benchmarks/gate6/repositories.json"));
  const tasks = lock.taskFiles.flatMap((relativePath) =>
    readJson(path.join(rootPath, relativePath)).tasks
  );
  const oracles = lock.oracleFiles.flatMap((relativePath) =>
    readJson(path.join(rootPath, relativePath)).oracles
  );
  return { lock, repositoryManifest, tasks, oracles };
}

function validateFrozenPreconditions(rootPath, documents, tasksetReport) {
  const freezeDocument = readJson(path.join(rootPath, "benchmarks/gate6/precondition-freeze.json"));
  const preconditions = readJson(path.join(rootPath, "benchmarks/gate6/preconditions.json"));
  if (
    !isPlainObject(freezeDocument) ||
    freezeDocument.schemaVersion !== "gate6-precondition-freeze-document/v1" ||
    freezeDocument.status !== "verified_42_of_42" ||
    !Array.isArray(freezeDocument.attestations) ||
    !isPlainObject(freezeDocument.freeze)
  ) {
    fail("GATE6_VERIFY_PRECONDITION_FREEZE_DOCUMENT_INVALID");
  }
  const verified = validateAttestations({
    preconditions,
    tasks: documents.tasks,
    repositories: documents.repositoryManifest.repositories,
    attestations: structuredClone(freezeDocument.attestations)
  });
  if (stableStringify(verified) !== stableStringify(freezeDocument.freeze)) {
    fail("GATE6_VERIFY_PRECONDITION_FREEZE_MISMATCH");
  }
  if (verified.preconditionAttestationHash !== tasksetReport.preconditionAttestationHash) {
    fail("GATE6_VERIFY_PRECONDITION_TASKSET_BINDING_MISMATCH");
  }
  return verified;
}

function validateBenchmarkSemanticsDocument(document) {
  const expected = [
    "schemaVersion",
    "benchmarkVersion",
    "promptSemantics",
    "supportBoundary",
    "contextStrategySemantics",
    "measurementSemantics",
    "goNoGoPolicy",
    "semanticSourceFiles"
  ];
  if (!sameKeys(document, expected)) fail("GATE6_VERIFY_BENCHMARK_SEMANTICS_INVALID");
  if (document.schemaVersion !== BENCHMARK_SEMANTICS_SCHEMA) {
    fail("GATE6_VERIFY_BENCHMARK_SEMANTICS_SCHEMA_UNSUPPORTED");
  }
  requiredString(document.benchmarkVersion, "GATE6_VERIFY_BENCHMARK_VERSION_INVALID");
  if (
    !isPlainObject(document.promptSemantics) ||
    !isPlainObject(document.supportBoundary) ||
    !isPlainObject(document.contextStrategySemantics) ||
    !isPlainObject(document.measurementSemantics) ||
    !isPlainObject(document.goNoGoPolicy)
  ) {
    fail("GATE6_VERIFY_BENCHMARK_SEMANTICS_INVALID");
  }
  if (document.contextStrategySemantics.version !== CONTEXT_STRATEGY_VERSION) {
    fail(
      "GATE6_VERIFY_CONTEXT_STRATEGY_VERSION_MISMATCH",
      `${document.contextStrategySemantics.version} != ${CONTEXT_STRATEGY_VERSION}`
    );
  }
  if (
    stableStringify(document.contextStrategySemantics.strategies) !==
    stableStringify(STRATEGIES)
  ) {
    fail("GATE6_VERIFY_CONTEXT_STRATEGIES_MISMATCH");
  }
  if (document.measurementSemantics.version !== REPORT_VERSION) {
    fail("GATE6_VERIFY_COMPARATIVE_REPORT_VERSION_MISMATCH");
  }
  if (document.measurementSemantics.oracleScorerVersion !== "gate6-oracle-scorer/v1") {
    fail("GATE6_VERIFY_ORACLE_SCORER_VERSION_MISMATCH");
  }
  if (document.measurementSemantics.minimumRepetitions !== MIN_REPETITIONS) {
    fail("GATE6_VERIFY_MIN_REPETITIONS_MISMATCH");
  }
  if (
    !Array.isArray(document.semanticSourceFiles) ||
    document.semanticSourceFiles.length === 0 ||
    new Set(document.semanticSourceFiles).size !== document.semanticSourceFiles.length ||
    document.semanticSourceFiles.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail("GATE6_VERIFY_SEMANTIC_SOURCE_LIST_INVALID");
  }
  if (!document.semanticSourceFiles.includes("scripts/lib/gate6-oracle-scorer.cjs")) {
    fail("GATE6_VERIFY_ORACLE_SCORER_NOT_FROZEN");
  }
  return document;
}

function computeBenchmarkSemantics(rootPath) {
  const document = validateBenchmarkSemanticsDocument(
    readJson(path.join(rootPath, "benchmarks/gate6/benchmark-semantics.json"))
  );
  const sourceHashes = document.semanticSourceFiles
    .map((relativePath) => {
      const absolutePath = path.join(rootPath, relativePath);
      if (!existsSync(absolutePath)) fail("GATE6_VERIFY_SEMANTIC_SOURCE_MISSING", relativePath);
      return { path: relativePath, sha256: hashFile(absolutePath) };
    })
    .sort((left, right) => compareText(left.path, right.path));
  const benchmarkSemanticsHash = hashCanonical({
    document,
    sourceHashes
  });
  const frozen = FROZEN_BENCHMARK_SEMANTICS_HASHES[document.benchmarkVersion];
  if (!frozen) fail("GATE6_VERIFY_BENCHMARK_VERSION_NOT_FROZEN", document.benchmarkVersion);
  if (benchmarkSemanticsHash !== frozen) {
    fail(
      "GATE6_VERIFY_BENCHMARK_SEMANTICS_HASH_MISMATCH",
      `${frozen} != ${benchmarkSemanticsHash}`
    );
  }
  return deepFreeze({ document, sourceHashes, benchmarkSemanticsHash });
}

function loadFrozenBenchmark(rootPath) {
  const tasksetReport = loadFrozenGate6Taskset({
    rootPath,
    repositoryManifestPath: path.join(rootPath, "benchmarks/gate6/repositories.json"),
    lockPath: path.join(rootPath, "benchmarks/gate6/taskset.json")
  });
  const documents = loadGate6Documents(rootPath);
  validateGate6RepositoryManifest(documents.repositoryManifest);
  const preconditionFreeze = validateFrozenPreconditions(rootPath, documents, tasksetReport);
  const semantics = computeBenchmarkSemantics(rootPath);

  if (tasksetReport.schemaVersion !== TASKSET_SCHEMA_VERSION) {
    fail("GATE6_VERIFY_TASKSET_VERSION_MISMATCH");
  }
  if (tasksetReport.tasksetHash !== FROZEN_TASKSET_HASHES[TASKSET_SCHEMA_VERSION]) {
    fail("GATE6_VERIFY_TASKSET_HASH_MISMATCH");
  }
  if (
    tasksetReport.repositoryManifestHash !==
    FROZEN_REPOSITORY_MANIFEST_HASHES[TASKSET_SCHEMA_VERSION]
  ) {
    fail("GATE6_VERIFY_REPOSITORY_MANIFEST_HASH_MISMATCH");
  }

  const tasks = [...documents.tasks].sort((left, right) => compareText(left.taskId, right.taskId));
  const oracles = [...documents.oracles].sort((left, right) => compareText(left.taskId, right.taskId));
  const repositoryManifest = canonicalizeGate6RepositoryManifest(documents.repositoryManifest);

  return deepFreeze({
    tasksetReport,
    preconditionFreeze,
    semantics,
    tasks,
    oracles,
    repositoryManifest
  });
}

function assertCleanGitTree(rootPath) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: rootPath,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) fail("GATE6_VERIFY_GIT_STATUS_FAILED", String(result.stderr || "").trim());
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^\?\? evidence\/gate6\/runs\//.test(line));
  if (lines.length > 0) fail("GATE6_VERIFY_GIT_TREE_DIRTY", lines.join(" | "));
  return true;
}

function gitHead(rootPath) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: rootPath,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) fail("GATE6_VERIFY_GIT_HEAD_FAILED");
  const head = String(result.stdout || "").trim();
  if (!SHA40.test(head)) fail("GATE6_VERIFY_SOURCE_SHA_INVALID", head);
  return head;
}

function createRuntimeIdentity(options = {}) {
  const provider = options.provider ?? "offline-fixture";
  const model = options.model ?? "offline-fixture";
  const rows = [
    RUNTIME_IDENTITY_VERSION,
    `provider=${provider}`,
    `model=${model}`,
    `node=${process.version}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `release=${os.release()}`
  ];
  if (options.runtimeTag) rows.push(`runtimeTag=${options.runtimeTag}`);
  return `${rows.join("\n")}\n`;
}

function canonicalTaskClassDefinitions() {
  return TASK_CLASS_IDS.map((id) => ({ ...TASK_CLASS_REGISTRY[id] }));
}

function buildExperimentConfig({
  rootPath,
  sourceSha,
  model,
  runtimeIdentity,
  temperature,
  maxCompletionTokens,
  repetitions
}) {
  if (!SHA40.test(String(sourceSha))) fail("GATE6_VERIFY_SOURCE_SHA_INVALID", String(sourceSha));
  requiredString(model, "GATE6_VERIFY_MODEL_INVALID");
  requiredString(runtimeIdentity, "GATE6_VERIFY_RUNTIME_IDENTITY_INVALID");
  requiredFinite(temperature, "GATE6_VERIFY_TEMPERATURE_INVALID", undefined, { min: 0 });
  requiredFinite(
    maxCompletionTokens,
    "GATE6_VERIFY_MAX_COMPLETION_TOKENS_INVALID",
    undefined,
    { integer: true, min: 1 }
  );
  requiredFinite(repetitions, "GATE6_VERIFY_REPETITIONS_INVALID", undefined, {
    integer: true,
    min: MIN_REPETITIONS
  });

  const frozen = loadFrozenBenchmark(rootPath);
  const config = {
    schemaVersion: EXPERIMENT_CONFIG_VERSION,
    sourceSha,
    model,
    runtimeIdentity,
    runtimeIdentityHash: sha256Buffer(Buffer.from(runtimeIdentity, "utf8")),
    temperature,
    maxCompletionTokens,
    repetitions,
    benchmarkVersion: frozen.semantics.document.benchmarkVersion,
    benchmarkSemanticsHash: frozen.semantics.benchmarkSemanticsHash,
    promptSemantics: structuredClone(frozen.semantics.document.promptSemantics),
    tasksetVersion: frozen.tasksetReport.schemaVersion,
    tasksetHash: frozen.tasksetReport.tasksetHash,
    taskDefinitions: frozen.tasks.map((task) => structuredClone(task)),
    taskClasses: {
      version: TASK_CLASS_REGISTRY_VERSION,
      definitions: canonicalTaskClassDefinitions()
    },
    supportBoundary: structuredClone(frozen.semantics.document.supportBoundary),
    contextStrategySemantics: structuredClone(frozen.semantics.document.contextStrategySemantics),
    repositoryManifestHash: frozen.tasksetReport.repositoryManifestHash,
    repositoryManifest: structuredClone(frozen.repositoryManifest)
  };
  return deepFreeze({
    config: deepFreeze(config),
    experimentConfigHash: hashCanonical(config),
    frozen
  });
}

function validateRepositorySnapshots(repositorySnapshots, repositoryManifest) {
  if (!Array.isArray(repositorySnapshots)) fail("GATE6_VERIFY_REPOSITORY_SNAPSHOTS_INVALID");
  const expected = new Map(repositoryManifest.repositories.map((entry) => [entry.id, entry.commitSha]));
  if (repositorySnapshots.length !== expected.size) {
    fail("GATE6_VERIFY_REPOSITORY_SNAPSHOT_COUNT_INVALID");
  }
  const seen = new Set();
  const normalized = [];
  for (const snapshot of repositorySnapshots) {
    if (!sameKeys(snapshot, ["repositoryId", "commitSha"])) {
      fail("GATE6_VERIFY_REPOSITORY_SNAPSHOT_INVALID");
    }
    if (seen.has(snapshot.repositoryId)) {
      fail("GATE6_VERIFY_REPOSITORY_SNAPSHOT_DUPLICATE", snapshot.repositoryId);
    }
    if (expected.get(snapshot.repositoryId) !== snapshot.commitSha) {
      fail("GATE6_VERIFY_EXTERNAL_REPOSITORY_SHA_MISMATCH", snapshot.repositoryId);
    }
    seen.add(snapshot.repositoryId);
    normalized.push({ repositoryId: snapshot.repositoryId, commitSha: snapshot.commitSha });
  }
  return normalized.sort((left, right) => compareText(left.repositoryId, right.repositoryId));
}

function oracleMap(frozen) {
  return new Map(frozen.oracles.map((oracle) => [oracle.taskId, oracle]));
}

function validateObservationCoverage(observations, config, frozen) {
  if (!Array.isArray(observations)) fail("GATE6_VERIFY_OBSERVATIONS_INVALID");
  const expectedCount = frozen.tasks.length * STRATEGIES.length * config.repetitions;
  if (observations.length !== expectedCount) {
    fail("GATE6_VERIFY_OBSERVATION_COUNT_INVALID", `${observations.length}/${expectedCount}`);
  }
  const taskById = new Map(frozen.tasks.map((task) => [task.taskId, task]));
  const oracleById = oracleMap(frozen);
  const seen = new Set();
  const expectedRepetitions = Array.from({ length: config.repetitions }, (_, index) => index + 1);
  const repetitionsByPair = new Map();

  for (const row of observations) {
    if (!isPlainObject(row)) fail("GATE6_VERIFY_OBSERVATION_INVALID");
    const task = taskById.get(row.taskId);
    if (!task) fail("GATE6_VERIFY_UNKNOWN_TASK", String(row.taskId));
    if (
      row.repositoryId !== task.repositoryId ||
      row.taskClass !== task.taskClass ||
      row.difficulty !== task.difficulty
    ) {
      fail("GATE6_VERIFY_OBSERVATION_TASK_METADATA_MISMATCH", row.taskId);
    }
    const key = `${row.taskId}\0${row.strategy}\0${row.repetition}`;
    if (seen.has(key)) fail("GATE6_VERIFY_DUPLICATE_OBSERVATION", key);
    seen.add(key);

    const pair = `${row.taskId}\0${row.strategy}`;
    const repetitions = repetitionsByPair.get(pair) ?? [];
    repetitions.push(row.repetition);
    repetitionsByPair.set(pair, repetitions);

    const oracle = oracleById.get(row.taskId);
    if (
      row.symbolRequiredCount !== oracle.requiredSymbols.length ||
      row.criticalImplementationRequiredCount !== oracle.requiredImplementationFiles.length ||
      row.criticalTestAnchorRequiredCount !== oracle.requiredTestAnchors.length
    ) {
      fail("GATE6_VERIFY_OBSERVATION_ORACLE_COUNT_MISMATCH", row.taskId);
    }
  }

  for (const task of frozen.tasks) {
    for (const strategy of STRATEGIES) {
      const pair = `${task.taskId}\0${strategy}`;
      const repetitions = (repetitionsByPair.get(pair) ?? []).sort((a, b) => a - b);
      if (stableStringify(repetitions) !== stableStringify(expectedRepetitions)) {
        fail("GATE6_VERIFY_REPETITION_COVERAGE_INVALID", pair);
      }
    }
  }
}

function assertNoOracleKeys(value, location = "raw-report") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoOracleKeys(child, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ORACLE_ONLY_KEYS.has(key)) fail("GATE6_VERIFY_ORACLE_LEAK_DETECTED", `${location}.${key}`);
    assertNoOracleKeys(child, `${location}.${key}`);
  }
}

function createRawReport({
  rootPath,
  config,
  experimentConfigHash,
  observations,
  repositorySnapshots
}) {
  if (!isPlainObject(config) || config.schemaVersion !== EXPERIMENT_CONFIG_VERSION) {
    fail("GATE6_VERIFY_EXPERIMENT_CONFIG_INVALID");
  }
  if (!SHA256.test(experimentConfigHash) || hashCanonical(config) !== experimentConfigHash) {
    fail("GATE6_VERIFY_EXPERIMENT_CONFIG_HASH_INVALID");
  }
  const frozen = loadFrozenBenchmark(rootPath);
  validateObservationCoverage(observations, config, frozen);
  const normalizedSnapshots = validateRepositorySnapshots(
    repositorySnapshots,
    frozen.repositoryManifest
  );
  const comparativeReport = createGate6ComparativeReport(observations, {
    minimumRepetitions: config.repetitions
  });
  const raw = {
    schemaVersion: RAW_REPORT_VERSION,
    experimentConfig: structuredClone(config),
    experimentConfigHash,
    repositorySnapshots: normalizedSnapshots,
    observations: observations.map((row) => structuredClone(row)),
    comparativeReport: structuredClone(comparativeReport)
  };
  assertNoOracleKeys(raw);
  return deepFreeze(raw);
}

function strategyMediumAcceptance(observations, strategy) {
  const rows = observations.filter(
    (row) => row.strategy === strategy && row.difficulty === "medium"
  );
  if (rows.length === 0) return null;
  return rows.filter((row) => row.endToEndAccepted === true).length / rows.length;
}

function ge(value, threshold) {
  return typeof value === "number" && Number.isFinite(value) && value >= threshold;
}

function le(value, threshold) {
  return typeof value === "number" && Number.isFinite(value) && value <= threshold;
}

function lt(value, threshold) {
  return typeof value === "number" && Number.isFinite(value) &&
    typeof threshold === "number" && Number.isFinite(threshold) && value < threshold;
}

function evaluateStrategyThresholds(rawReport, semanticsDocument) {
  const thresholds = semanticsDocument.goNoGoPolicy.thresholds;
  const decisions = {};
  for (const strategy of STRATEGIES) {
    const metrics = rawReport.comparativeReport.aggregates.strategy[strategy];
    const mediumAcceptanceRate = strategyMediumAcceptance(rawReport.observations, strategy);
    const checks = {
      authorityViolationRate: le(metrics.authorityViolationRate, thresholds.authorityViolationRateMax),
      scopeEscapeRate: le(metrics.scopeViolationRate, thresholds.scopeEscapeRateMax),
      fileScopeSuccessRate: ge(metrics.fileScopeSuccessRate, thresholds.fileScopeSuccessRateMin),
      endToEndAcceptanceRate: ge(
        metrics.endToEndAcceptanceRate,
        thresholds.endToEndAcceptanceRateMin
      ),
      mediumEndToEndAcceptanceRate: ge(
        mediumAcceptanceRate,
        thresholds.mediumEndToEndAcceptanceRateMin
      )
    };
    decisions[strategy] = {
      status: Object.values(checks).every(Boolean) ? "GO" : "NO_GO",
      metrics: {
        authorityViolationRate: metrics.authorityViolationRate,
        scopeEscapeRate: metrics.scopeViolationRate,
        fileScopeSuccessRate: metrics.fileScopeSuccessRate,
        endToEndAcceptanceRate: metrics.endToEndAcceptanceRate,
        mediumEndToEndAcceptanceRate: mediumAcceptanceRate
      },
      checks,
      hardTaskPolicy: semanticsDocument.goNoGoPolicy.hardTaskPolicy
    };
  }
  return decisions;
}

function efficiencyImproved(candidate, baseline) {
  const comparisons = [
    ["contextBytesPerStrictSuccess", candidate.contextBytesPerStrictSuccess, baseline.contextBytesPerStrictSuccess],
    ["tokensPerStrictSuccess", candidate.tokensPerStrictSuccess, baseline.tokensPerStrictSuccess],
    ["contextBytesPerAcceptedCodingTask", candidate.contextBytesPerAcceptedCodingTask, baseline.contextBytesPerAcceptedCodingTask],
    ["tokensPerAcceptedCodingTask", candidate.tokensPerAcceptedCodingTask, baseline.tokensPerAcceptedCodingTask]
  ];
  return comparisons.some(([, candidateValue, baselineValue]) => lt(candidateValue, baselineValue));
}

function successMeaningfullyImproved(candidate, baseline, margin) {
  return (
    candidate.strictOracleSuccessRate >= baseline.strictOracleSuccessRate + margin ||
    candidate.endToEndAcceptanceRate >= baseline.endToEndAcceptanceRate + margin
  );
}

function evaluatePromotion(rawReport, semanticsDocument, thresholdDecisions) {
  const policy = semanticsDocument.goNoGoPolicy;
  const baselineStrategy = policy.baselineStrategy;
  const baseline = rawReport.comparativeReport.aggregates.strategy[baselineStrategy];
  if (!baseline) fail("GATE6_VERIFY_BASELINE_STRATEGY_MISSING", baselineStrategy);
  const promotionPolicy = policy.promotion;
  const decisions = {};

  for (const strategy of STRATEGIES.filter((value) => value !== baselineStrategy)) {
    const candidate = rawReport.comparativeReport.aggregates.strategy[strategy];
    const safetyNoWorse =
      candidate.authorityViolationRate <= baseline.authorityViolationRate &&
      candidate.scopeViolationRate <= baseline.scopeViolationRate;
    const acceptanceNonInferior =
      candidate.endToEndAcceptanceRate + promotionPolicy.acceptanceNonInferiorityMargin >=
      baseline.endToEndAcceptanceRate;
    const efficiencyWin = efficiencyImproved(candidate, baseline);
    const successWin = successMeaningfullyImproved(
      candidate,
      baseline,
      promotionPolicy.meaningfulSuccessImprovement
    );
    const scopeDriftNoIncrease = candidate.scopeViolationRate <= baseline.scopeViolationRate;

    let fAdaptiveGuard = null;
    if (strategy === "F_adaptive_compressed_boundary") {
      fAdaptiveGuard = {
        strictOracleSuccessRateAtLeastBaseline:
          candidate.strictOracleSuccessRate >= baseline.strictOracleSuccessRate,
        contextBytesPerStrictSuccessStrictlyBelowBaseline:
          lt(candidate.contextBytesPerStrictSuccess, baseline.contextBytesPerStrictSuccess),
        scopeViolationRateAtMostBaseline:
          candidate.scopeViolationRate <= baseline.scopeViolationRate
      };
    }

    const checks = {
      researchThresholds: thresholdDecisions[strategy].status === "GO",
      safetyNoWorse,
      acceptanceOperationallyNonInferior: acceptanceNonInferior,
      efficiencyOrMeaningfulSuccessWin: efficiencyWin || successWin,
      scopeDriftNoIncrease
    };
    if (fAdaptiveGuard) checks.fAdaptiveGuard = Object.values(fAdaptiveGuard).every(Boolean);

    decisions[strategy] = {
      status: Object.values(checks).every(Boolean) ? "GO" : "NO_GO",
      baselineStrategy,
      method: "operational_noninferiority_and_efficiency",
      checks,
      fAdaptiveGuard,
      deltas: {
        strictOracleSuccessRate:
          candidate.strictOracleSuccessRate - baseline.strictOracleSuccessRate,
        endToEndAcceptanceRate:
          candidate.endToEndAcceptanceRate - baseline.endToEndAcceptanceRate,
        scopeViolationRate:
          candidate.scopeViolationRate - baseline.scopeViolationRate,
        authorityViolationRate:
          candidate.authorityViolationRate - baseline.authorityViolationRate,
        contextBytesPerStrictSuccess:
          candidate.contextBytesPerStrictSuccess === null ||
          baseline.contextBytesPerStrictSuccess === null
            ? null
            : candidate.contextBytesPerStrictSuccess - baseline.contextBytesPerStrictSuccess,
        tokensPerStrictSuccess:
          candidate.tokensPerStrictSuccess === null ||
          baseline.tokensPerStrictSuccess === null
            ? null
            : candidate.tokensPerStrictSuccess - baseline.tokensPerStrictSuccess
      }
    };
  }
  return { baselineStrategy, decisions };
}

function buildEvidence({
  rootPath,
  rawReport,
  runtimeIdentity,
  preflight
}) {
  const frozen = loadFrozenBenchmark(rootPath);
  const expected = buildExperimentConfig({
    rootPath,
    sourceSha: rawReport.experimentConfig.sourceSha,
    model: rawReport.experimentConfig.model,
    runtimeIdentity,
    temperature: rawReport.experimentConfig.temperature,
    maxCompletionTokens: rawReport.experimentConfig.maxCompletionTokens,
    repetitions: rawReport.experimentConfig.repetitions
  });
  if (stableStringify(expected.config) !== stableStringify(rawReport.experimentConfig)) {
    fail("GATE6_VERIFY_EXPERIMENT_CONFIG_FROZEN_MISMATCH");
  }
  if (expected.experimentConfigHash !== rawReport.experimentConfigHash) {
    fail("GATE6_VERIFY_EXPERIMENT_CONFIG_HASH_MISMATCH");
  }
  validateObservationCoverage(rawReport.observations, rawReport.experimentConfig, frozen);
  validateRepositorySnapshots(rawReport.repositorySnapshots, frozen.repositoryManifest);

  const recomputedReport = createGate6ComparativeReport(rawReport.observations, {
    minimumRepetitions: rawReport.experimentConfig.repetitions
  });
  if (stableStringify(recomputedReport) !== stableStringify(rawReport.comparativeReport)) {
    fail("GATE6_VERIFY_COMPARATIVE_REPORT_MISMATCH");
  }
  assertNoOracleKeys(rawReport);

  const thresholdDecisions = evaluateStrategyThresholds(
    rawReport,
    frozen.semantics.document
  );
  const promotion = evaluatePromotion(
    rawReport,
    frozen.semantics.document,
    thresholdDecisions
  );

  return deepFreeze({
    schemaVersion: EVIDENCE_VERSION,
    verifierVersion: VERIFIER_VERSION,
    status: "VERIFIED",
    sourceSha: rawReport.experimentConfig.sourceSha,
    benchmarkVersion: rawReport.experimentConfig.benchmarkVersion,
    benchmarkSemanticsHash: rawReport.experimentConfig.benchmarkSemanticsHash,
    tasksetVersion: rawReport.experimentConfig.tasksetVersion,
    tasksetHash: rawReport.experimentConfig.tasksetHash,
    repositoryManifestHash: rawReport.experimentConfig.repositoryManifestHash,
    experimentConfigHash: rawReport.experimentConfigHash,
    rawReportHash: hashCanonical(rawReport),
    runtimeIdentityHash: sha256Buffer(Buffer.from(runtimeIdentity, "utf8")),
    comparativeReportHash: rawReport.comparativeReport.reportHash,
    preflight: structuredClone(preflight),
    goNoGo: {
      policyVersion: frozen.semantics.document.goNoGoPolicy.version,
      thresholds: structuredClone(frozen.semantics.document.goNoGoPolicy.thresholds),
      strategies: thresholdDecisions,
      promotion
    }
  });
}

function ensureEvidenceDirectoryFresh(outputDir) {
  if (existsSync(outputDir)) {
    for (const filename of EVIDENCE_FILENAMES) {
      if (existsSync(path.join(outputDir, filename))) {
        fail("GATE6_VERIFY_EVIDENCE_ALREADY_EXISTS", path.join(outputDir, filename));
      }
    }
  } else {
    mkdirSync(outputDir, { recursive: true });
  }
}

function sha256sumLine(filePath, filename) {
  return `${hashFile(filePath).slice("sha256:".length)}  ${filename}`;
}

function writeEvidencePackage({
  rootPath,
  outputDir,
  rawReport,
  runtimeIdentity,
  preflight
}) {
  ensureEvidenceDirectoryFresh(outputDir);
  const rawPath = path.join(outputDir, "raw-report.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  const runtimePath = path.join(outputDir, "runtime-identity.txt");
  const sumsPath = path.join(outputDir, "SHA256SUMS");

  writeFileSync(rawPath, prettyCanonicalJson(rawReport), { flag: "wx" });
  writeFileSync(runtimePath, runtimeIdentity, { flag: "wx" });

  const evidence = buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight });
  writeFileSync(evidencePath, prettyCanonicalJson(evidence), { flag: "wx" });

  const sumFiles = ["raw-report.json", "evidence.json", "runtime-identity.txt"];
  const lines = sumFiles.map((filename) =>
    sha256sumLine(path.join(outputDir, filename), filename)
  );
  writeFileSync(sumsPath, `${lines.join("\n")}\n`, { flag: "wx" });

  return deepFreeze({
    outputDir,
    files: {
      rawReport: rawPath,
      evidence: evidencePath,
      runtimeIdentity: runtimePath,
      sha256sums: sumsPath
    },
    evidence
  });
}

function parseSha256Sums(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const expectedNames = ["raw-report.json", "evidence.json", "runtime-identity.txt"];
  if (lines.length !== expectedNames.length) fail("GATE6_VERIFY_SHA256SUMS_INVALID");
  const result = new Map();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match) fail("GATE6_VERIFY_SHA256SUMS_INVALID", line);
    if (result.has(match[2])) fail("GATE6_VERIFY_SHA256SUMS_DUPLICATE", match[2]);
    result.set(match[2], match[1]);
  }
  if (stableStringify([...result.keys()].sort()) !== stableStringify([...expectedNames].sort())) {
    fail("GATE6_VERIFY_SHA256SUMS_FILES_INVALID");
  }
  return result;
}

function verifyEvidenceDirectory({
  rootPath,
  evidenceDir,
  expectedSourceSha = null
}) {
  for (const filename of EVIDENCE_FILENAMES) {
    if (!existsSync(path.join(evidenceDir, filename))) {
      fail("GATE6_VERIFY_EVIDENCE_FILE_MISSING", filename);
    }
  }
  const rawReport = readJson(path.join(evidenceDir, "raw-report.json"));
  const evidence = readJson(path.join(evidenceDir, "evidence.json"));
  const runtimeIdentity = readFileSync(path.join(evidenceDir, "runtime-identity.txt"), "utf8");
  const sums = parseSha256Sums(readFileSync(path.join(evidenceDir, "SHA256SUMS"), "utf8"));

  for (const filename of ["raw-report.json", "evidence.json", "runtime-identity.txt"]) {
    const actual = hashFile(path.join(evidenceDir, filename)).slice("sha256:".length);
    if (sums.get(filename) !== actual) {
      fail("GATE6_VERIFY_SHA256SUM_MISMATCH", filename);
    }
  }

  if (!sameKeys(rawReport, [
    "schemaVersion",
    "experimentConfig",
    "experimentConfigHash",
    "repositorySnapshots",
    "observations",
    "comparativeReport"
  ]) || rawReport.schemaVersion !== RAW_REPORT_VERSION) {
    fail("GATE6_VERIFY_RAW_REPORT_INVALID");
  }
  if (evidence.schemaVersion !== EVIDENCE_VERSION || evidence.status !== "VERIFIED") {
    fail("GATE6_VERIFY_EVIDENCE_DOCUMENT_INVALID");
  }
  if (expectedSourceSha !== null && rawReport.experimentConfig.sourceSha !== expectedSourceSha) {
    fail(
      "GATE6_VERIFY_SOURCE_SHA_MISMATCH",
      `${rawReport.experimentConfig.sourceSha} != ${expectedSourceSha}`
    );
  }
  const recomputed = buildEvidence({
    rootPath,
    rawReport,
    runtimeIdentity,
    preflight: evidence.preflight
  });
  if (stableStringify(recomputed) !== stableStringify(evidence)) {
    fail("GATE6_VERIFY_EVIDENCE_RECOMPUTE_MISMATCH");
  }
  return deepFreeze({
    rawReport: deepFreeze(rawReport),
    evidence: deepFreeze(evidence),
    runtimeIdentity,
    sha256sumsVersion: SHA256SUMS_VERSION
  });
}

function createPreflightRecord({
  rootPath,
  sourceSha,
  mode = "frozen_attestation"
}) {
  const frozen = loadFrozenBenchmark(rootPath);
  return deepFreeze({
    schemaVersion: "gate6-preflight/v1",
    cleanGitTree: true,
    sourceSha,
    tasksetVersion: frozen.tasksetReport.schemaVersion,
    tasksetHash: frozen.tasksetReport.tasksetHash,
    repositoryManifest: "PASS",
    externalRepositoryShas:
      mode === "runtime_checkout" ? "PASS_RUNTIME_EXACT_SHA" : "PASS_FROZEN_ATTESTATION_EXACT_SHA",
    oracleValidation: "PASS",
    oracleLeakTests: "PASS",
    contextStrategyTests: "PASS",
    offlineFixture: "PASS",
    preconditionAttestationHash: frozen.preconditionFreeze.preconditionAttestationHash,
    benchmarkSemanticsHash: frozen.semantics.benchmarkSemanticsHash
  });
}

module.exports = {
  BENCHMARK_SEMANTICS_SCHEMA,
  EVIDENCE_FILENAMES,
  EVIDENCE_VERSION,
  EXPERIMENT_CONFIG_VERSION,
  FROZEN_BENCHMARK_SEMANTICS_HASHES,
  Gate6VerifierError,
  RAW_REPORT_VERSION,
  RUNTIME_IDENTITY_VERSION,
  SHA256SUMS_VERSION,
  VERIFIER_VERSION,
  assertCleanGitTree,
  buildEvidence,
  buildExperimentConfig,
  computeBenchmarkSemantics,
  createPreflightRecord,
  createRawReport,
  createRuntimeIdentity,
  evaluatePromotion,
  evaluateStrategyThresholds,
  gitHead,
  hashCanonical,
  loadFrozenBenchmark,
  stableStringify,
  verifyEvidenceDirectory,
  writeEvidencePackage
};
