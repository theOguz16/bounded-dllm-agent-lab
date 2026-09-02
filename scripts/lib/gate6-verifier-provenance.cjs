"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const base = require("./gate6-verifier.cjs");
const { FAILURE_CODES, HARNESS_VERSION } = require("./gate6-simulated-coding-harness.cjs");
const {
  SCORER_VERSION,
  SELECTION_EVIDENCE_VERSION,
  normalizeSelectionEvidence,
  scoreGate6SelectionEvidence
} = require("./gate6-oracle-scorer.cjs");

const VERIFIER_VERSION = "gate6-verifier/v3";
const RAW_REPORT_VERSION = "gate6-raw-report/v3";
const EVIDENCE_VERSION = "gate6-evidence/v3";
const SAMPLE_RECEIPT_VERSION = "gate6-simulated-harness-receipt/v3";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ORACLE_FIELDS = Object.freeze([
  "fileScopeSuccess",
  "strictOracleSuccess",
  "exactSymbolSuccess",
  "symbolTruePositiveCount",
  "symbolPredictedCount",
  "symbolRequiredCount",
  "criticalImplementationCoveredCount",
  "criticalImplementationRequiredCount",
  "criticalTestAnchorCoveredCount",
  "criticalTestAnchorRequiredCount"
]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "taskId",
  "repositoryId",
  "commitSha",
  "strategy",
  "repetition",
  "harnessVersion",
  "harnessReportHash",
  "harnessReport",
  "selectionEvidence",
  "selectionEvidenceHash",
  "oracleVerification",
  "oracleVerificationHash",
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
function fail(code, detail) { throw new base.Gate6VerifierError(code, detail); }
function isPlainObject(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function sameKeys(value, expected) { return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function assertNoOracleKeys(value, location = "sampleReceipts") { if (Array.isArray(value)) { value.forEach((child, index) => assertNoOracleKeys(child, `${location}[${index}]`)); return; } if (!isPlainObject(value)) return; for (const [key, child] of Object.entries(value)) { if (ORACLE_ONLY_KEYS.has(key)) fail("GATE6_VERIFY_ORACLE_LEAK_DETECTED", `${location}.${key}`); assertNoOracleKeys(child, `${location}.${key}`); } }
function bool(value, code, detail) { if (typeof value !== "boolean") fail(code, detail); return value; }
function count(value, detail) { if (!Number.isSafeInteger(value) || value < 0) fail("GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID", detail); return value; }
function receiptKey(value) { return `${value.taskId}\0${value.strategy}\0${value.repetition}`; }
function receiptCore(receipt) { const { receiptHash, ...core } = receipt; return core; }

function deriveHarnessOutcome(harnessReport) {
  if (!isPlainObject(harnessReport) || harnessReport.version !== HARNESS_VERSION) fail("GATE6_VERIFY_HARNESS_RECEIPT_REPORT_INVALID");
  if (typeof harnessReport.taskId !== "string" || typeof harnessReport.repositoryId !== "string" || typeof harnessReport.commitSha !== "string" || typeof harnessReport.strategy !== "string") fail("GATE6_VERIFY_HARNESS_RECEIPT_IDENTITY_INVALID");
  if (harnessReport.status !== "accepted" && harnessReport.status !== "rejected") fail("GATE6_VERIFY_HARNESS_RECEIPT_STATUS_INVALID");
  if (harnessReport.failureCode !== null && typeof harnessReport.failureCode !== "string") fail("GATE6_VERIFY_HARNESS_RECEIPT_FAILURE_CODE_INVALID");
  if (!isPlainObject(harnessReport.metrics)) fail("GATE6_VERIFY_HARNESS_RECEIPT_METRICS_INVALID");
  const testsPassed = bool(harnessReport.metrics.testsPassed, "GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", "testsPassed");
  const acceptancePassed = bool(harnessReport.metrics.acceptancePassed, "GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", "acceptancePassed");
  const metricScopeViolation = bool(harnessReport.metrics.scopeViolation, "GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", "scopeViolation");
  const unauthorizedFileMutation = bool(harnessReport.metrics.unauthorizedFileMutation, "GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", "unauthorizedFileMutation");
  const metricHumanIntervention = bool(harnessReport.metrics.humanIntervention, "GATE6_VERIFY_HARNESS_RECEIPT_METRIC_INVALID", "humanIntervention");
  const unauthorizedFilesPresent = Array.isArray(harnessReport.unauthorizedFiles) && harnessReport.unauthorizedFiles.length > 0;
  const scopeViolation = metricScopeViolation || unauthorizedFileMutation || unauthorizedFilesPresent || harnessReport.failureCode === FAILURE_CODES.SCOPE_VIOLATION || harnessReport.failureCode === FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION;
  const authorityViolation = harnessReport.failureCode === FAILURE_CODES.AUTHORITY_VIOLATION;
  const humanIntervention = metricHumanIntervention || harnessReport.originalRepositoryMutated === true || harnessReport.workspaceDisposed !== true;
  if (harnessReport.status === "accepted" && harnessReport.failureCode !== null) fail("GATE6_VERIFY_HARNESS_RECEIPT_ACCEPTED_WITH_FAILURE");
  if (harnessReport.status === "rejected" && harnessReport.failureCode === null) fail("GATE6_VERIFY_HARNESS_RECEIPT_REJECTED_WITHOUT_FAILURE");
  const endToEndAccepted = harnessReport.status === "accepted" && harnessReport.failureCode === null && testsPassed && acceptancePassed && !scopeViolation && !authorityViolation && !humanIntervention;
  if (harnessReport.status === "accepted" && !endToEndAccepted) fail("GATE6_VERIFY_HARNESS_RECEIPT_ACCEPTED_INCONSISTENT");
  return deepFreeze({ endToEndAccepted, testsPassed, acceptancePassed, scopeViolation, authorityViolation, humanIntervention, unauthorizedFileMutation });
}
function validateOracleVerification(value) {
  if (!sameKeys(value, ORACLE_FIELDS)) fail("GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID");
  for (const field of ["fileScopeSuccess", "strictOracleSuccess", "exactSymbolSuccess"]) bool(value[field], "GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID", field);
  for (const field of ORACLE_FIELDS.filter((field) => field.endsWith("Count"))) count(value[field], field);
  if (value.symbolTruePositiveCount > value.symbolPredictedCount || value.symbolTruePositiveCount > value.symbolRequiredCount) fail("GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID", "symbol counts");
  if (value.criticalImplementationCoveredCount > value.criticalImplementationRequiredCount) fail("GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID", "implementation counts");
  if (value.criticalTestAnchorCoveredCount > value.criticalTestAnchorRequiredCount) fail("GATE6_VERIFY_RECEIPT_ORACLE_VERIFICATION_INVALID", "test-anchor counts");
  return value;
}
function createHarnessSampleReceipt({ observation, harnessReport, task, oracle, selectionEvidence }) {
  if (!isPlainObject(observation) || !Number.isInteger(observation.repetition) || observation.repetition < 1) fail("GATE6_VERIFY_RECEIPT_REPETITION_INVALID");
  if (!task || !oracle || task.taskId !== observation.taskId || oracle.taskId !== observation.taskId) fail("GATE6_VERIFY_RECEIPT_ORACLE_IDENTITY_INVALID", observation.taskId);
  const normalizedSelection = normalizeSelectionEvidence(selectionEvidence);
  const oracleVerification = scoreGate6SelectionEvidence({ task, oracle, selectionEvidence: normalizedSelection });
  validateOracleVerification(oracleVerification);
  const derivedOutcome = deriveHarnessOutcome(harnessReport);
  if (harnessReport.taskId !== observation.taskId || harnessReport.repositoryId !== observation.repositoryId || harnessReport.strategy !== observation.strategy || harnessReport.commitSha !== task.commitSha) fail("GATE6_VERIFY_RECEIPT_OBSERVATION_IDENTITY_MISMATCH", observation.taskId);
  const core = { schemaVersion: SAMPLE_RECEIPT_VERSION, taskId: observation.taskId, repositoryId: observation.repositoryId, commitSha: harnessReport.commitSha, strategy: observation.strategy, repetition: observation.repetition, harnessVersion: HARNESS_VERSION, harnessReportHash: base.hashCanonical(harnessReport), harnessReport: structuredClone(harnessReport), selectionEvidence: structuredClone(normalizedSelection), selectionEvidenceHash: base.hashCanonical(normalizedSelection), oracleVerification: structuredClone(oracleVerification), oracleVerificationHash: base.hashCanonical(oracleVerification), derivedOutcome: structuredClone(derivedOutcome) };
  return deepFreeze({ ...core, receiptHash: base.hashCanonical(core) });
}
function validateSampleReceipts({ observations, sampleReceipts, frozen }) {
  if (!Array.isArray(sampleReceipts) || sampleReceipts.length !== observations.length) fail("GATE6_VERIFY_SAMPLE_RECEIPT_COUNT_INVALID", `${sampleReceipts?.length ?? "invalid"}/${observations.length}`);
  assertNoOracleKeys(sampleReceipts);
  const taskById = new Map(frozen.tasks.map((task) => [task.taskId, task]));
  const oracleById = new Map(frozen.oracles.map((oracle) => [oracle.taskId, oracle]));
  const observationByKey = new Map(observations.map((row) => [receiptKey(row), row]));
  const receiptByKey = new Map();
  const receiptHashes = new Set();
  for (const receipt of sampleReceipts) {
    if (!sameKeys(receipt, RECEIPT_FIELDS) || receipt.schemaVersion !== SAMPLE_RECEIPT_VERSION || receipt.harnessVersion !== HARNESS_VERSION) fail("GATE6_VERIFY_SAMPLE_RECEIPT_INVALID");
    if (!SHA256.test(receipt.harnessReportHash) || !SHA256.test(receipt.selectionEvidenceHash) || !SHA256.test(receipt.oracleVerificationHash) || !SHA256.test(receipt.receiptHash)) fail("GATE6_VERIFY_SAMPLE_RECEIPT_HASH_INVALID");
    if (receipt.receiptHash !== base.hashCanonical(receiptCore(receipt))) fail("GATE6_VERIFY_SAMPLE_RECEIPT_HASH_MISMATCH", receiptKey(receipt));
    if (receiptHashes.has(receipt.receiptHash)) fail("GATE6_VERIFY_SAMPLE_RECEIPT_HASH_REUSED", receiptKey(receipt));
    receiptHashes.add(receipt.receiptHash);
    if (receipt.harnessReportHash !== base.hashCanonical(receipt.harnessReport)) fail("GATE6_VERIFY_HARNESS_REPORT_HASH_MISMATCH", receiptKey(receipt));
    let normalizedSelection;
    try { normalizedSelection = normalizeSelectionEvidence(receipt.selectionEvidence); } catch (error) { fail("GATE6_VERIFY_SELECTION_EVIDENCE_INVALID", `${receiptKey(receipt)}:${error.code ?? error.message}`); }
    if (receipt.selectionEvidenceHash !== base.hashCanonical(normalizedSelection)) fail("GATE6_VERIFY_SELECTION_EVIDENCE_HASH_MISMATCH", receiptKey(receipt));
    validateOracleVerification(receipt.oracleVerification);
    if (receipt.oracleVerificationHash !== base.hashCanonical(receipt.oracleVerification)) fail("GATE6_VERIFY_ORACLE_VERIFICATION_HASH_MISMATCH", receiptKey(receipt));
    const key = receiptKey(receipt);
    if (receiptByKey.has(key)) fail("GATE6_VERIFY_DUPLICATE_SAMPLE_RECEIPT", key);
    receiptByKey.set(key, receipt);
  }
  for (const [key, observation] of observationByKey) {
    const receipt = receiptByKey.get(key);
    if (!receipt) fail("GATE6_VERIFY_SAMPLE_RECEIPT_MISSING", key);
    const task = taskById.get(observation.taskId);
    const oracle = oracleById.get(observation.taskId);
    if (!task || !oracle) fail("GATE6_VERIFY_UNKNOWN_TASK", observation.taskId);
    const report = receipt.harnessReport;
    if (receipt.taskId !== observation.taskId || receipt.repositoryId !== observation.repositoryId || receipt.strategy !== observation.strategy || receipt.repetition !== observation.repetition || receipt.commitSha !== task.commitSha || report.taskId !== observation.taskId || report.repositoryId !== observation.repositoryId || report.strategy !== observation.strategy || report.commitSha !== task.commitSha) fail("GATE6_VERIFY_RECEIPT_IDENTITY_MISMATCH", key);
    const derived = deriveHarnessOutcome(report);
    if (base.stableStringify(derived) !== base.stableStringify(receipt.derivedOutcome)) fail("GATE6_VERIFY_RECEIPT_DERIVED_OUTCOME_MISMATCH", key);
    for (const [field, expected] of Object.entries({ endToEndAccepted: derived.endToEndAccepted, testsPassed: derived.testsPassed, scopeViolation: derived.scopeViolation, authorityViolation: derived.authorityViolation, humanIntervention: derived.humanIntervention })) if (observation[field] !== expected) fail("GATE6_VERIFY_RECEIPT_CLAIM_MISMATCH", `${key}:${field}`);
    let recomputedVerification;
    try { recomputedVerification = scoreGate6SelectionEvidence({ task, oracle, selectionEvidence: receipt.selectionEvidence }); } catch (error) { fail("GATE6_VERIFY_ORACLE_SCORE_RECOMPUTE_FAILED", `${key}:${error.code ?? error.message}`); }
    if (base.stableStringify(recomputedVerification) !== base.stableStringify(receipt.oracleVerification)) fail("GATE6_VERIFY_ORACLE_SCORE_RECOMPUTE_MISMATCH", key);
    if (receipt.oracleVerificationHash !== base.hashCanonical(recomputedVerification)) fail("GATE6_VERIFY_ORACLE_VERIFICATION_HASH_MISMATCH", key);
    for (const field of ORACLE_FIELDS) if (observation[field] !== recomputedVerification[field]) fail("GATE6_VERIFY_RECEIPT_ORACLE_CLAIM_MISMATCH", `${key}:${field}`);
  }
  if (receiptByKey.size !== observationByKey.size) fail("GATE6_VERIFY_SAMPLE_RECEIPT_COVERAGE_INVALID");
  return [...receiptByKey.values()].sort((left, right) => receiptKey(left).localeCompare(receiptKey(right)));
}
function createRawReport({ rootPath, config, experimentConfigHash, observations, repositorySnapshots, sampleReceipts }) {
  const baseRaw = base.createRawReport({ rootPath, config, experimentConfigHash, observations, repositorySnapshots });
  const frozen = base.loadFrozenBenchmark(rootPath);
  const normalizedReceipts = validateSampleReceipts({ observations: baseRaw.observations, sampleReceipts, frozen });
  const raw = { schemaVersion: RAW_REPORT_VERSION, experimentConfig: structuredClone(baseRaw.experimentConfig), experimentConfigHash: baseRaw.experimentConfigHash, repositorySnapshots: structuredClone(baseRaw.repositorySnapshots), observations: structuredClone(baseRaw.observations), sampleReceipts: normalizedReceipts.map((receipt) => structuredClone(receipt)), sampleReceiptSetHash: base.hashCanonical(normalizedReceipts.map((receipt) => receipt.receiptHash)), comparativeReport: structuredClone(baseRaw.comparativeReport) };
  assertNoOracleKeys(raw);
  return deepFreeze(raw);
}
function validateRawReport(rootPath, rawReport) {
  if (!sameKeys(rawReport, ["schemaVersion", "experimentConfig", "experimentConfigHash", "repositorySnapshots", "observations", "sampleReceipts", "sampleReceiptSetHash", "comparativeReport"]) || rawReport.schemaVersion !== RAW_REPORT_VERSION || !SHA256.test(rawReport.sampleReceiptSetHash)) fail("GATE6_VERIFY_RAW_REPORT_INVALID");
  const baseRaw = base.createRawReport({ rootPath, config: rawReport.experimentConfig, experimentConfigHash: rawReport.experimentConfigHash, observations: rawReport.observations, repositorySnapshots: rawReport.repositorySnapshots });
  if (base.stableStringify(baseRaw.comparativeReport) !== base.stableStringify(rawReport.comparativeReport)) fail("GATE6_VERIFY_COMPARATIVE_REPORT_MISMATCH");
  const frozen = base.loadFrozenBenchmark(rootPath);
  const normalizedReceipts = validateSampleReceipts({ observations: baseRaw.observations, sampleReceipts: rawReport.sampleReceipts, frozen });
  if (rawReport.sampleReceiptSetHash !== base.hashCanonical(normalizedReceipts.map((receipt) => receipt.receiptHash))) fail("GATE6_VERIFY_SAMPLE_RECEIPT_SET_HASH_MISMATCH");
  return { baseRaw, normalizedReceipts };
}
function buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight }) {
  const { baseRaw, normalizedReceipts } = validateRawReport(rootPath, rawReport);
  const baseEvidence = base.buildEvidence({ rootPath, rawReport: baseRaw, runtimeIdentity, preflight });
  return deepFreeze({ ...structuredClone(baseEvidence), schemaVersion: EVIDENCE_VERSION, verifierVersion: VERIFIER_VERSION, rawReportHash: base.hashCanonical(rawReport), sampleReceiptSetHash: rawReport.sampleReceiptSetHash, provenance: { sampleReceiptVersion: SAMPLE_RECEIPT_VERSION, sampleReceiptCount: normalizedReceipts.length, harnessVersion: HARNESS_VERSION, selectionEvidenceVersion: SELECTION_EVIDENCE_VERSION, oracleScorerVersion: SCORER_VERSION, verifiedHarnessFields: ["endToEndAccepted", "testsPassed", "acceptancePassed", "scopeViolation", "authorityViolation", "humanIntervention"], verifiedOracleFields: [...ORACLE_FIELDS], oracleScoreSource: "selection_evidence_plus_frozen_hidden_oracle_recomputed_by_verifier", unauthorizedMutationCountsAsScopeViolation: true } });
}
function hashFile(filePath) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }
function ensureFresh(outputDir) { if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true }); for (const filename of base.EVIDENCE_FILENAMES) if (existsSync(path.join(outputDir, filename))) fail("GATE6_VERIFY_EVIDENCE_ALREADY_EXISTS", path.join(outputDir, filename)); }
function pretty(value) { return `${JSON.stringify(JSON.parse(base.stableStringify(value)), null, 2)}\n`; }
function writeEvidencePackage({ rootPath, outputDir, rawReport, runtimeIdentity, preflight }) {
  ensureFresh(outputDir); const evidence = buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight });
  const rawPath = path.join(outputDir, "raw-report.json"), evidencePath = path.join(outputDir, "evidence.json"), runtimePath = path.join(outputDir, "runtime-identity.txt"), sumsPath = path.join(outputDir, "SHA256SUMS");
  writeFileSync(rawPath, pretty(rawReport), { flag: "wx" }); writeFileSync(evidencePath, pretty(evidence), { flag: "wx" }); writeFileSync(runtimePath, runtimeIdentity, { flag: "wx" });
  const sums = ["raw-report.json", "evidence.json", "runtime-identity.txt"].map((filename) => `${hashFile(path.join(outputDir, filename))}  ${filename}`).join("\n"); writeFileSync(sumsPath, `${sums}\n`, { flag: "wx" });
  return deepFreeze({ outputDir, files: { rawReport: rawPath, evidence: evidencePath, runtimeIdentity: runtimePath, sha256sums: sumsPath }, evidence });
}
function parseSums(text) { const map = new Map(); const lines = text.split(/\r?\n/).filter(Boolean); if (lines.length !== 3) fail("GATE6_VERIFY_SHA256SUMS_INVALID"); for (const line of lines) { const match = line.match(/^([0-9a-f]{64})  (raw-report\.json|evidence\.json|runtime-identity\.txt)$/); if (!match || map.has(match[2])) fail("GATE6_VERIFY_SHA256SUMS_INVALID", line); map.set(match[2], match[1]); } return map; }
function verifyEvidenceDirectory({ rootPath, evidenceDir, expectedSourceSha = null }) {
  for (const filename of base.EVIDENCE_FILENAMES) if (!existsSync(path.join(evidenceDir, filename))) fail("GATE6_VERIFY_EVIDENCE_FILE_MISSING", filename);
  const sums = parseSums(readFileSync(path.join(evidenceDir, "SHA256SUMS"), "utf8"));
  for (const filename of ["raw-report.json", "evidence.json", "runtime-identity.txt"]) if (sums.get(filename) !== hashFile(path.join(evidenceDir, filename))) fail("GATE6_VERIFY_SHA256SUM_MISMATCH", filename);
  const rawReport = JSON.parse(readFileSync(path.join(evidenceDir, "raw-report.json"), "utf8")); const evidence = JSON.parse(readFileSync(path.join(evidenceDir, "evidence.json"), "utf8")); const runtimeIdentity = readFileSync(path.join(evidenceDir, "runtime-identity.txt"), "utf8");
  if (expectedSourceSha !== null && rawReport.experimentConfig?.sourceSha !== expectedSourceSha) fail("GATE6_VERIFY_SOURCE_SHA_MISMATCH", `${rawReport.experimentConfig?.sourceSha} != ${expectedSourceSha}`);
  if (evidence.schemaVersion !== EVIDENCE_VERSION || evidence.verifierVersion !== VERIFIER_VERSION) fail("GATE6_VERIFY_EVIDENCE_DOCUMENT_INVALID");
  const recomputed = buildEvidence({ rootPath, rawReport, runtimeIdentity, preflight: evidence.preflight });
  if (base.stableStringify(recomputed) !== base.stableStringify(evidence)) fail("GATE6_VERIFY_EVIDENCE_RECOMPUTE_MISMATCH");
  return deepFreeze({ rawReport: deepFreeze(rawReport), evidence: deepFreeze(evidence), runtimeIdentity });
}
module.exports = { ...base, EVIDENCE_VERSION, HARNESS_VERSION, ORACLE_FIELDS, RAW_REPORT_VERSION, SAMPLE_RECEIPT_VERSION, VERIFIER_VERSION, buildEvidence, createHarnessSampleReceipt, createRawReport, deriveHarnessOutcome, validateSampleReceipts, verifyEvidenceDirectory, writeEvidencePackage };
