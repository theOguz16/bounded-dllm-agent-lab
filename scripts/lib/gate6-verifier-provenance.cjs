"use strict";

const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} = require("node:fs");
const path = require("node:path");
const base = require("./gate6-verifier.cjs");

const VERIFIER_VERSION = "gate6-verifier/v2";
const RAW_REPORT_VERSION = "gate6-raw-report/v2";
const EVIDENCE_VERSION = "gate6-evidence/v2";
const SAMPLE_RECEIPT_VERSION = "gate6-simulated-harness-receipt/v1";
const HARNESS_VERSION = "gate6-simulated-coding-harness/v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "taskId",
  "repositoryId",
  "strategy",
  "repetition",
  "harnessVersion",
  "harnessReportHash",
  "observationHash",
  "harnessReport",
  "derivedOutcome",
  "receiptHash"
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

function fail(code, detail) {
  throw new base.Gate6VerifierError(code, detail);
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function booleanMetric(metrics, field) {
  if (typeof metrics[field] !== "boolean") {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", field);
  }
  return metrics[field];
}

function assertNoOracleKeys(value, location = "sampleReceipts") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoOracleKeys(child, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ORACLE_ONLY_KEYS.has(key)) {
      fail("GATE6_VERIFY_ORACLE_LEAK_DETECTED", `${location}.${key}`);
    }
    assertNoOracleKeys(child, `${location}.${key}`);
  }
}

function deriveHarnessOutcome(harnessReport) {
  if (!isPlainObject(harnessReport)) fail("GATE6_VERIFY_HARNESS_RECEIPT_REPORT_INVALID");
  if (harnessReport.version !== HARNESS_VERSION) {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_VERSION_MISMATCH", String(harnessReport.version));
  }
  if (typeof harnessReport.taskId !== "string" || typeof harnessReport.repositoryId !== "string") {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_IDENTITY_INVALID");
  }
  if (typeof harnessReport.strategy !== "string") {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_STRATEGY_INVALID");
  }
  if (harnessReport.status !== "accepted" && harnessReport.status !== "rejected") {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_STATUS_INVALID", String(harnessReport.status));
  }
  if (harnessReport.failureCode !== null && typeof harnessReport.failureCode !== "string") {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_FAILURE_CODE_INVALID");
  }
  if (!isPlainObject(harnessReport.metrics)) {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_METRICS_INVALID");
  }

  const testsPassed = booleanMetric(harnessReport.metrics, "testsPassed");
  const acceptancePassed = booleanMetric(harnessReport.metrics, "acceptancePassed");
  const metricScopeViolation = booleanMetric(harnessReport.metrics, "scopeViolation");
  const unauthorizedFileMutation = booleanMetric(
    harnessReport.metrics,
    "unauthorizedFileMutation"
  );
  const humanIntervention = booleanMetric(harnessReport.metrics, "humanIntervention");
  const unauthorizedFilesPresent =
    Array.isArray(harnessReport.unauthorizedFiles) && harnessReport.unauthorizedFiles.length > 0;
  const scopeViolation =
    metricScopeViolation ||
    unauthorizedFileMutation ||
    unauthorizedFilesPresent ||
    harnessReport.failureCode === "SCOPE_VIOLATION" ||
    harnessReport.failureCode === "UNAUTHORIZED_FILE_MUTATION";
  const authorityViolation = harnessReport.failureCode === "AUTHORITY_VIOLATION";

  if (harnessReport.status === "accepted" && harnessReport.failureCode !== null) {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_ACCEPTED_WITH_FAILURE");
  }
  if (harnessReport.status === "rejected" && harnessReport.failureCode === null) {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_REJECTED_WITHOUT_FAILURE");
  }

  const endToEndAccepted =
    harnessReport.status === "accepted" &&
    harnessReport.failureCode === null &&
    testsPassed &&
    acceptancePassed &&
    !scopeViolation &&
    !authorityViolation &&
    !humanIntervention;

  if (harnessReport.status === "accepted" && !endToEndAccepted) {
    fail("GATE6_VERIFY_HARNESS_RECEIPT_ACCEPTED_INCONSISTENT");
  }

  return deepFreeze({
    endToEndAccepted,
    testsPassed,
    acceptancePassed,
    scopeViolation,
    authorityViolation,
    humanIntervention,
    unauthorizedFileMutation
  });
}

function receiptCore(receipt) {
  const { receiptHash, ...core } = receipt;
  return core;
}

function createHarnessSampleReceipt({ observation, harnessReport }) {
  if (!isPlainObject(observation)) fail("GATE6_VERIFY_OBSERVATION_INVALID");
  if (!Number.isInteger(observation.repetition) || observation.repetition < 1) {
    fail("GATE6_VERIFY_RECEIPT_REPETITION_INVALID");
  }
  const derivedOutcome = deriveHarnessOutcome(harnessReport);
  if (
    harnessReport.taskId !== observation.taskId ||
    harnessReport.repositoryId !== observation.repositoryId ||
    harnessReport.strategy !== observation.strategy
  ) {
    fail("GATE6_VERIFY_RECEIPT_OBSERVATION_IDENTITY_MISMATCH", observation.taskId);
  }
  const core = {
    schemaVersion: SAMPLE_RECEIPT_VERSION,
    taskId: observation.taskId,
    repositoryId: observation.repositoryId,
    strategy: observation.strategy,
    repetition: observation.repetition,
    harnessVersion: HARNESS_VERSION,
    harnessReportHash: base.hashCanonical(harnessReport),
    observationHash: base.hashCanonical(observation),
    harnessReport: structuredClone(harnessReport),
    derivedOutcome: structuredClone(derivedOutcome)
  };
  return deepFreeze({ ...core, receiptHash: base.hashCanonical(core) });
}

function receiptKey(value) {
  return `${value.taskId}\0${value.strategy}\0${value.repetition}`;
}

function validateSampleReceipts({ observations, sampleReceipts, frozen }) {
  if (!Array.isArray(sampleReceipts) || sampleReceipts.length !== observations.length) {
    fail(
      "GATE6_VERIFY_SAMPLE_RECEIPT_COUNT_INVALID",
      `${sampleReceipts?.length ?? "invalid"}/${observations.length}`
    );
  }
  assertNoOracleKeys(sampleReceipts);
  const taskById = new Map(frozen.tasks.map((task) => [task.taskId, task]));
  const observationByKey = new Map(observations.map((row) => [receiptKey(row), row]));
  const receiptByKey = new Map();

  for (const receipt of sampleReceipts) {
    if (!sameKeys(receipt, RECEIPT_FIELDS)) fail("GATE6_VERIFY_SAMPLE_RECEIPT_INVALID");
    if (receipt.schemaVersion !== SAMPLE_RECEIPT_VERSION || receipt.harnessVersion !== HARNESS_VERSION) {
      fail("GATE6_VERIFY_SAMPLE_RECEIPT_VERSION_MISMATCH");
    }
    if (!SHA256.test(receipt.harnessReportHash) || !SHA256.test(receipt.observationHash) || !SHA256.test(receipt.receiptHash)) {
      fail("GATE6_VERIFY_SAMPLE_RECEIPT_HASH_INVALID");
    }
    if (receipt.receiptHash !== base.hashCanonical(receiptCore(receipt))) {
      fail("GATE6_VERIFY_SAMPLE_RECEIPT_HASH_MISMATCH", receiptKey(receipt));
    }
    if (receipt.harnessReportHash !== base.hashCanonical(receipt.harnessReport)) {
      fail("GATE6_VERIFY_HARNESS_REPORT_HASH_MISMATCH", receiptKey(receipt));
    }
    const key = receiptKey(receipt);
    if (receiptByKey.has(key)) fail("GATE6_VERIFY_DUPLICATE_SAMPLE_RECEIPT", key);
    receiptByKey.set(key, receipt);
  }

  for (const [key, observation] of observationByKey) {
    const receipt = receiptByKey.get(key);
    if (!receipt) fail("GATE6_VERIFY_SAMPLE_RECEIPT_MISSING", key);
    if (receipt.observationHash !== base.hashCanonical(observation)) {
      fail("GATE6_VERIFY_RECEIPT_OBSERVATION_HASH_MISMATCH", key);
    }
    const task = taskById.get(observation.taskId);
    if (!task) fail("GATE6_VERIFY_UNKNOWN_TASK", observation.taskId);
    const report = receipt.harnessReport;
    if (
      receipt.taskId !== observation.taskId ||
      receipt.repositoryId !== observation.repositoryId ||
      receipt.strategy !== observation.strategy ||
      receipt.repetition !== observation.repetition ||
      report.taskId !== observation.taskId ||
      report.repositoryId !== observation.repositoryId ||
      report.strategy !== observation.strategy ||
      report.commitSha !== task.commitSha
    ) {
      fail("GATE6_VERIFY_RECEIPT_IDENTITY_MISMATCH", key);
    }

    const derived = deriveHarnessOutcome(report);
    if (base.stableStringify(derived) !== base.stableStringify(receipt.derivedOutcome)) {
      fail("GATE6_VERIFY_RECEIPT_DERIVED_OUTCOME_MISMATCH", key);
    }
    const comparisons = [
      ["endToEndAccepted", observation.endToEndAccepted, derived.endToEndAccepted],
      ["testsPassed", observation.testsPassed, derived.testsPassed],
      ["scopeViolation", observation.scopeViolation, derived.scopeViolation],
      ["authorityViolation", observation.authorityViolation, derived.authorityViolation],
      ["humanIntervention", observation.humanIntervention, derived.humanIntervention]
    ];
    for (const [field, observed, expected] of comparisons) {
      if (observed !== expected) {
        fail(`GATE6_VERIFY_RECEIPT_${field.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}_MISMATCH`, key);
      }
    }
    if (observation.strictOracleSuccess === true && derived.endToEndAccepted !== true) {
      fail("GATE6_VERIFY_RECEIPT_STRICT_ORACLE_SUCCESS_IMPOSSIBLE", key);
    }
  }

  if (receiptByKey.size !== observationByKey.size) {
    fail("GATE6_VERIFY_SAMPLE_RECEIPT_COVERAGE_INVALID");
  }
  return [...receiptByKey.values()].sort((left, right) => {
    const a = receiptKey(left);
    const b = receiptKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function createRawReport({
  rootPath,
  config,
  experimentConfigHash,
  observations,
  repositorySnapshots,
  sampleReceipts
}) {
  const baseRaw = base.createRawReport({
    rootPath,
    config,
    experimentConfigHash,
    observations,
    repositorySnapshots
  });
  const frozen = base.loadFrozenBenchmark(rootPath);
  const normalizedReceipts = validateSampleReceipts({
    observations: baseRaw.observations,
    sampleReceipts,
    frozen
  });
  const raw = {
    schemaVersion: RAW_REPORT_VERSION,
    experimentConfig: structuredClone(baseRaw.experimentConfig),
    experimentConfigHash: baseRaw.experimentConfigHash,
    repositorySnapshots: structuredClone(baseRaw.repositorySnapshots),
    observations: structuredClone(baseRaw.observations),
    sampleReceipts: normalizedReceipts.map((receipt) => structuredClone(receipt)),
    comparativeReport: structuredClone(baseRaw.comparativeReport)
  };
  assertNoOracleKeys(raw);
  return deepFreeze(raw);
}

function validateRawReport(rootPath, rawReport) {
  if (!sameKeys(rawReport, [
    "schemaVersion",
    "experimentConfig",
    "experimentConfigHash",
    "repositorySnapshots",
    "observations",
    "sampleReceipts",
    "comparativeReport"
  ]) || rawReport.schemaVersion !== RAW_REPORT_VERSION) {
    fail("GATE6_VERIFY_RAW_REPORT_INVALID");
  }
  const baseRaw = base.createRawReport({
    rootPath,
    config: rawReport.experimentConfig,
    experimentConfigHash: rawReport.experimentConfigHash,
    observations: rawReport.observations,
    repositorySnapshots: rawReport.repositorySnapshots
  });
  if (base.stableStringify(baseRaw.comparativeReport) !== base.stableStringify(rawReport.comparativeReport)) {
    fail("GATE6_VERIFY_COMPARATIVE_REPORT_MISMATCH");
  }
  const frozen = base.loadFrozenBenchmark(rootPath);
  const normalizedReceipts = validateSampleReceipts({
    observations: baseRaw.observations,
    sampleReceipts: rawReport.sampleReceipts,
    frozen
  });
  return { baseRaw, normalizedReceipts };
}

function buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight }) {
  const { baseRaw, normalizedReceipts } = validateRawReport(rootPath, rawReport);
  const baseEvidence = base.buildEvidence({
    rootPath,
    rawReport: baseRaw,
    runtimeIdentity,
    preflight
  });
  const sampleReceiptHashes = normalizedReceipts.map((receipt) => receipt.receiptHash);
  return deepFreeze({
    ...structuredClone(baseEvidence),
    schemaVersion: EVIDENCE_VERSION,
    verifierVersion: VERIFIER_VERSION,
    rawReportHash: base.hashCanonical(rawReport),
    provenance: {
      sampleReceiptVersion: SAMPLE_RECEIPT_VERSION,
      sampleReceiptCount: normalizedReceipts.length,
      sampleReceiptSetHash: base.hashCanonical(sampleReceiptHashes),
      harnessVersion: HARNESS_VERSION,
      verifiedFields: [
        "endToEndAccepted",
        "testsPassed",
        "scopeViolation",
        "authorityViolation",
        "humanIntervention"
      ],
      acceptanceBoundThroughEndToEnd: true,
      strictOracleSuccessRequiresAcceptedHarness: true,
      unauthorizedMutationCountsAsScopeViolation: true
    }
  });
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function ensureFresh(outputDir) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    return;
  }
  for (const filename of base.EVIDENCE_FILENAMES) {
    if (existsSync(path.join(outputDir, filename))) {
      fail("GATE6_VERIFY_EVIDENCE_ALREADY_EXISTS", path.join(outputDir, filename));
    }
  }
}

function pretty(value) {
  return `${JSON.stringify(JSON.parse(base.stableStringify(value)), null, 2)}\n`;
}

function writeEvidencePackage({ rootPath, outputDir, rawReport, runtimeIdentity, preflight }) {
  ensureFresh(outputDir);
  const evidence = buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight });
  const rawPath = path.join(outputDir, "raw-report.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  const runtimePath = path.join(outputDir, "runtime-identity.txt");
  const sumsPath = path.join(outputDir, "SHA256SUMS");
  writeFileSync(rawPath, pretty(rawReport), { flag: "wx" });
  writeFileSync(evidencePath, pretty(evidence), { flag: "wx" });
  writeFileSync(runtimePath, runtimeIdentity, { flag: "wx" });
  const sums = ["raw-report.json", "evidence.json", "runtime-identity.txt"]
    .map((filename) => `${hashFile(path.join(outputDir, filename))}  ${filename}`)
    .join("\n");
  writeFileSync(sumsPath, `${sums}\n`, { flag: "wx" });
  return deepFreeze({
    outputDir,
    files: { rawReport: rawPath, evidence: evidencePath, runtimeIdentity: runtimePath, sha256sums: sumsPath },
    evidence
  });
}

function parseSums(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) fail("GATE6_VERIFY_SHA256SUMS_INVALID");
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (raw-report\.json|evidence\.json|runtime-identity\.txt)$/);
    if (!match || map.has(match[2])) fail("GATE6_VERIFY_SHA256SUMS_INVALID", line);
    map.set(match[2], match[1]);
  }
  return map;
}

function verifyEvidenceDirectory({ rootPath, evidenceDir, expectedSourceSha = null }) {
  for (const filename of base.EVIDENCE_FILENAMES) {
    if (!existsSync(path.join(evidenceDir, filename))) {
      fail("GATE6_VERIFY_EVIDENCE_FILE_MISSING", filename);
    }
  }
  const sums = parseSums(readFileSync(path.join(evidenceDir, "SHA256SUMS"), "utf8"));
  for (const filename of ["raw-report.json", "evidence.json", "runtime-identity.txt"]) {
    if (sums.get(filename) !== hashFile(path.join(evidenceDir, filename))) {
      fail("GATE6_VERIFY_SHA256SUM_MISMATCH", filename);
    }
  }
  const rawReport = JSON.parse(readFileSync(path.join(evidenceDir, "raw-report.json"), "utf8"));
  const evidence = JSON.parse(readFileSync(path.join(evidenceDir, "evidence.json"), "utf8"));
  const runtimeIdentity = readFileSync(path.join(evidenceDir, "runtime-identity.txt"), "utf8");
  if (expectedSourceSha !== null && rawReport.experimentConfig?.sourceSha !== expectedSourceSha) {
    fail(
      "GATE6_VERIFY_SOURCE_SHA_MISMATCH",
      `${rawReport.experimentConfig?.sourceSha} != ${expectedSourceSha}`
    );
  }
  if (evidence.schemaVersion !== EVIDENCE_VERSION || evidence.verifierVersion !== VERIFIER_VERSION) {
    fail("GATE6_VERIFY_EVIDENCE_DOCUMENT_INVALID");
  }
  const recomputed = buildEvidence({
    rootPath,
    rawReport,
    runtimeIdentity,
    preflight: evidence.preflight
  });
  if (base.stableStringify(recomputed) !== base.stableStringify(evidence)) {
    fail("GATE6_VERIFY_EVIDENCE_RECOMPUTE_MISMATCH");
  }
  return deepFreeze({ rawReport: deepFreeze(rawReport), evidence: deepFreeze(evidence), runtimeIdentity });
}

module.exports = {
  ...base,
  EVIDENCE_VERSION,
  HARNESS_VERSION,
  RAW_REPORT_VERSION,
  SAMPLE_RECEIPT_VERSION,
  VERIFIER_VERSION,
  buildEvidence,
  createHarnessSampleReceipt,
  createRawReport,
  deriveHarnessOutcome,
  validateSampleReceipts,
  verifyEvidenceDirectory,
  writeEvidencePackage
};
