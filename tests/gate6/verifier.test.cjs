#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Gate6VerifierError,
  buildExperimentConfig,
  createHarnessSampleReceipt,
  createPreflightRecord,
  createRawReport,
  createRuntimeIdentity,
  evaluatePromotion,
  evaluateStrategyThresholds,
  loadFrozenBenchmark,
  verifyEvidenceDirectory,
  writeEvidencePackage
} = require("../../scripts/lib/gate6-verifier-provenance.cjs");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
function expectReject(fn, code) { assert.throws(fn, (error) => error instanceof Gate6VerifierError && error.code === code, `expected ${code}`); }
function test(name, fn) { fn(); process.stdout.write(`PASS ${name}\n`); }
function oracleVerification(observation, overrides = {}) {
  return {
    fileScopeSuccess: observation.fileScopeSuccess,
    strictOracleSuccess: observation.strictOracleSuccess,
    exactSymbolSuccess: observation.exactSymbolSuccess,
    symbolTruePositiveCount: observation.symbolTruePositiveCount,
    symbolPredictedCount: observation.symbolPredictedCount,
    symbolRequiredCount: observation.symbolRequiredCount,
    criticalImplementationCoveredCount: observation.criticalImplementationCoveredCount,
    criticalImplementationRequiredCount: observation.criticalImplementationRequiredCount,
    criticalTestAnchorCoveredCount: observation.criticalTestAnchorCoveredCount,
    criticalTestAnchorRequiredCount: observation.criticalTestAnchorRequiredCount,
    ...overrides
  };
}
function harnessReport(task, strategy, overrides = {}) {
  const base = {
    version: "gate6-simulated-coding-harness/v1", taskId: task.taskId, repositoryId: task.repositoryId,
    commitSha: task.commitSha, workspaceId: `fixture:${task.taskId}`, strategy, status: "accepted",
    failureCode: null, failureDomain: null, failureDetail: null, providerFailureCode: null,
    modelCapabilityFailure: false, proposalAction: task.taskClass === "no_change_needed" ? "no_change" : "patch",
    contextStrategy: strategy, contextBytes: 1, providerContextHash: "sha256:" + "1".repeat(64),
    metrics: { proposalGenerated: true, verifierReached: true, verifierAccepted: true, verifierRejected: false,
      patchApplied: task.taskClass !== "no_change_needed", relevantTestsExecuted: true, testsPassed: true,
      acceptancePassed: true, rollbackRequired: false, rollbackCompleted: false, scopeViolation: false,
      unauthorizedFileMutation: false, humanIntervention: false, noChangeAccepted: task.taskClass === "no_change_needed" },
    changedFiles: [], unauthorizedFiles: [], baselineChangedFiles: [], originalRepositoryMutationMeasured: true,
    originalRepositoryMutated: false, originalRepositoryFingerprintBefore: null, originalRepositoryFingerprintAfter: null,
    workspaceDisposed: true, lifecycle: ["sample.started", "sample.finished"]
  };
  return { ...base, ...overrides, metrics: { ...base.metrics, ...(overrides.metrics ?? {}) } };
}
function fixtureBundle(options = {}) {
  const model = options.model ?? "offline-fixture-model";
  const runtimeIdentity = options.runtimeIdentity ?? createRuntimeIdentity({ provider: "offline-fixture", model, runtimeTag: "gate6-verifier-test" });
  const built = buildExperimentConfig({ rootPath: ROOT, sourceSha: SOURCE_SHA, model, runtimeIdentity, temperature: options.temperature ?? 0, maxCompletionTokens: options.maxCompletionTokens ?? 2048, repetitions: options.repetitions ?? 3 });
  const oracleByTask = new Map(built.frozen.oracles.map((oracle) => [oracle.taskId, oracle]));
  const cost = { C_synthetic_context: { contextBytes: 1200, tokens: 600, latencyMs: 30 }, E_bounded_workspace_boundary: { contextBytes: 1000, tokens: 500, latencyMs: 28 }, F_adaptive_compressed_boundary: { contextBytes: 700, tokens: 350, latencyMs: 24 }, CE_escalating_context: { contextBytes: 800, tokens: 400, latencyMs: 26 }, ...(options.cost ?? {}) };
  const observations = [], receiptInputs = [];
  for (const task of built.frozen.tasks) {
    const oracle = oracleByTask.get(task.taskId);
    for (const strategy of built.config.contextStrategySemantics.strategies) for (let repetition = 1; repetition <= built.config.repetitions; repetition += 1) {
      const overrides = options.observationOverride?.({ task, strategy, repetition }) ?? {};
      const escalated = strategy === "CE_escalating_context" && repetition % 2 === 0;
      const observation = { schemaVersion: "gate6-comparative-observation/v1", taskId: task.taskId, repositoryId: task.repositoryId, taskClass: task.taskClass, difficulty: task.difficulty, strategy, repetition, fileScopeSuccess: true, strictOracleSuccess: true, exactSymbolSuccess: true, symbolTruePositiveCount: oracle.requiredSymbols.length, symbolPredictedCount: oracle.requiredSymbols.length, symbolRequiredCount: oracle.requiredSymbols.length, criticalImplementationCoveredCount: oracle.requiredImplementationFiles.length, criticalImplementationRequiredCount: oracle.requiredImplementationFiles.length, criticalTestAnchorCoveredCount: oracle.requiredTestAnchors.length, criticalTestAnchorRequiredCount: oracle.requiredTestAnchors.length, contextBytes: cost[strategy].contextBytes, tokens: cost[strategy].tokens, latencyMs: cost[strategy].latencyMs, scopeViolation: false, authorityViolation: false, endToEndAccepted: true, testsPassed: true, humanIntervention: false, escalation: strategy === "CE_escalating_context" ? { escalated, incrementalContextBytes: escalated ? 180 : 0, incrementalTokens: escalated ? 90 : 0, incrementalLatencyMs: escalated ? 4 : 0 } : null, ...overrides };
      observations.push(observation);
      receiptInputs.push({
        observation,
        harnessReport: harnessReport(task, strategy, options.receiptOverride?.({ task, strategy, repetition, observation }) ?? {}),
        oracleVerification: oracleVerification(observation, options.oracleVerificationOverride?.({ task, strategy, repetition, observation }) ?? {})
      });
    }
  }
  const sampleReceipts = receiptInputs.map(createHarnessSampleReceipt);
  const repositorySnapshots = built.config.repositoryManifest.repositories.map((repository) => ({ repositoryId: repository.id, commitSha: repository.commitSha }));
  const rawReport = createRawReport({ rootPath: ROOT, config: built.config, experimentConfigHash: built.experimentConfigHash, observations, repositorySnapshots, sampleReceipts });
  const preflight = createPreflightRecord({ rootPath: ROOT, sourceSha: SOURCE_SHA, mode: "frozen_attestation" });
  return { ...built, rawReport, runtimeIdentity, preflight };
}
function withTempDir(fn) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate6-verifier-")); try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
function rebuild(fixture, observations, receipts, snapshots = fixture.rawReport.repositorySnapshots) { return createRawReport({ rootPath: ROOT, config: fixture.config, experimentConfigHash: fixture.experimentConfigHash, observations, repositorySnapshots: snapshots, sampleReceipts: receipts }); }
function matchingObservation(observations, receipt) { return observations.find((row) => row.taskId === receipt.taskId && row.strategy === receipt.strategy && row.repetition === receipt.repetition); }
function main() {
  test("frozen benchmark identity loads exact taskset and semantic freeze", () => { const frozen = loadFrozenBenchmark(ROOT); assert.equal(frozen.tasksetReport.frozen, true); assert.equal(frozen.tasksetReport.taskCount, 42); assert.equal(frozen.tasksetReport.repositoryCount, 14); assert.match(frozen.semantics.benchmarkSemanticsHash, /^sha256:[0-9a-f]{64}$/); });
  test("experiment config hash binds model runtime generation knobs and benchmark semantics", () => { const first = fixtureBundle(), second = fixtureBundle({ model: "different-model" }), third = fixtureBundle({ temperature: 0.1 }), fourth = fixtureBundle({ maxCompletionTokens: 4096 }); assert.notEqual(first.experimentConfigHash, second.experimentConfigHash); assert.notEqual(first.experimentConfigHash, third.experimentConfigHash); assert.notEqual(first.experimentConfigHash, fourth.experimentConfigHash); });
  test("offline fixture produces immutable four-file evidence package and verifies receipts", () => { const fixture = fixtureBundle(); withTempDir((parent) => { const outputDir = path.join(parent, "run"); const written = writeEvidencePackage({ rootPath: ROOT, outputDir, rawReport: fixture.rawReport, runtimeIdentity: fixture.runtimeIdentity, preflight: fixture.preflight }); assert.deepEqual(fs.readdirSync(outputDir).sort(), ["SHA256SUMS", "evidence.json", "raw-report.json", "runtime-identity.txt"].sort()); const verified = verifyEvidenceDirectory({ rootPath: ROOT, evidenceDir: outputDir, expectedSourceSha: SOURCE_SHA }); assert.equal(verified.evidence.status, "VERIFIED"); assert.equal(verified.evidence.provenance.sampleReceiptCount, 504); assert.equal(verified.evidence.goNoGo.promotion.decisions.F_adaptive_compressed_boundary.status, "GO"); assert.equal(written.evidence.experimentConfigHash, fixture.experimentConfigHash); }); });
  test("SHA256SUMS tamper fails closed", () => { const fixture = fixtureBundle(); withTempDir((parent) => { const outputDir = path.join(parent, "run"); writeEvidencePackage({ rootPath: ROOT, outputDir, rawReport: fixture.rawReport, runtimeIdentity: fixture.runtimeIdentity, preflight: fixture.preflight }); fs.appendFileSync(path.join(outputDir, "runtime-identity.txt"), "tampered=true\n"); expectReject(() => verifyEvidenceDirectory({ rootPath: ROOT, evidenceDir: outputDir }), "GATE6_VERIFY_SHA256SUM_MISMATCH"); }); });
  test("runtime repository snapshot SHA mismatch fails closed", () => { const fixture = fixtureBundle(); const snapshots = fixture.rawReport.repositorySnapshots.map((entry) => ({ ...entry })); snapshots[0].commitSha = "0".repeat(40); expectReject(() => rebuild(fixture, fixture.rawReport.observations, fixture.rawReport.sampleReceipts, snapshots), "GATE6_VERIFY_EXTERNAL_REPOSITORY_SHA_MISMATCH"); });
  test("normalized observation required counts are bound back to hidden oracle counts", () => { const fixture = fixtureBundle(); const observations = fixture.rawReport.observations.map((row) => ({ ...row })); observations[0].symbolRequiredCount += 1; expectReject(() => rebuild(fixture, observations, fixture.rawReport.sampleReceipts), "GATE6_VERIFY_OBSERVATION_ORACLE_COUNT_MISMATCH"); });
  test("harness FAIL plus observation endToEndAccepted true is rejected", () => { const fixture = fixtureBundle(); const observations = fixture.rawReport.observations.map((row) => ({ ...row })); const old = fixture.rawReport.sampleReceipts[0]; const observation = matchingObservation(observations, old); const task = fixture.frozen.tasks.find((t) => t.taskId === old.taskId); const report = harnessReport(task, old.strategy, { status: "rejected", failureCode: "TEST_FAILURE", failureDomain: "verification", metrics: { testsPassed: false, acceptancePassed: false } }); const receipts = fixture.rawReport.sampleReceipts.map((r, i) => i === 0 ? createHarnessSampleReceipt({ observation, harnessReport: report, oracleVerification: oracleVerification(observation) }) : r); expectReject(() => rebuild(fixture, observations, receipts), "GATE6_VERIFY_RECEIPT_CLAIM_MISMATCH"); });
  test("unauthorized mutation receipt plus scopeViolation false is rejected", () => { const fixture = fixtureBundle(); const observations = fixture.rawReport.observations.map((row) => ({ ...row })); const old = fixture.rawReport.sampleReceipts[0]; const observation = matchingObservation(observations, old); observation.endToEndAccepted = false; observation.strictOracleSuccess = false; const task = fixture.frozen.tasks.find((t) => t.taskId === old.taskId); const report = harnessReport(task, old.strategy, { status: "rejected", failureCode: "UNAUTHORIZED_FILE_MUTATION", failureDomain: "policy", unauthorizedFiles: ["src/side-effect.js"], metrics: { unauthorizedFileMutation: true, acceptancePassed: false } }); const receipts = fixture.rawReport.sampleReceipts.map((r, i) => i === 0 ? createHarnessSampleReceipt({ observation, harnessReport: report, oracleVerification: oracleVerification(observation) }) : r); expectReject(() => rebuild(fixture, observations, receipts), "GATE6_VERIFY_RECEIPT_CLAIM_MISMATCH"); });
  test("different task or repetition receipt hash is rejected", () => { const fixture = fixtureBundle(); const receipts = fixture.rawReport.sampleReceipts.map((r) => structuredClone(r)); receipts[0].repetition = 2; expectReject(() => rebuild(fixture, fixture.rawReport.observations, receipts), "GATE6_VERIFY_SAMPLE_RECEIPT_HASH_MISMATCH"); });
  test("strict oracle success cannot be invented against receipt oracle verification", () => { const fixture = fixtureBundle(); const observations = fixture.rawReport.observations.map((row) => ({ ...row })); const old = fixture.rawReport.sampleReceipts[0]; const observation = matchingObservation(observations, old); const task = fixture.frozen.tasks.find((t) => t.taskId === old.taskId); const receipts = fixture.rawReport.sampleReceipts.map((r, i) => i === 0 ? createHarnessSampleReceipt({ observation, harnessReport: harnessReport(task, old.strategy), oracleVerification: oracleVerification(observation, { strictOracleSuccess: false }) }) : r); expectReject(() => rebuild(fixture, observations, receipts), "GATE6_VERIFY_RECEIPT_ORACLE_CLAIM_MISMATCH"); });
  test("research thresholds enforce meaningful medium success", () => { const fixture = fixtureBundle({ observationOverride: ({ task, strategy }) => strategy === "F_adaptive_compressed_boundary" && task.difficulty === "medium" ? { endToEndAccepted: false, strictOracleSuccess: false } : {}, receiptOverride: ({ task, strategy }) => strategy === "F_adaptive_compressed_boundary" && task.difficulty === "medium" ? { status: "rejected", failureCode: "ACCEPTANCE_FAILURE", failureDomain: "verification", metrics: { acceptancePassed: false } } : {} }); const decisions = evaluateStrategyThresholds(fixture.rawReport, fixture.frozen.semantics.document); assert.equal(decisions.F_adaptive_compressed_boundary.status, "NO_GO"); });
  test("F cannot promote unless strict success is non-inferior context cost is lower and scope does not drift", () => { const expensive = fixtureBundle({ cost: { F_adaptive_compressed_boundary: { contextBytes: 1400, tokens: 350, latencyMs: 24 } } }); const thresholds = evaluateStrategyThresholds(expensive.rawReport, expensive.frozen.semantics.document); const promotion = evaluatePromotion(expensive.rawReport, expensive.frozen.semantics.document, thresholds); assert.equal(promotion.decisions.F_adaptive_compressed_boundary.status, "NO_GO"); });
  test("source SHA mismatch rejects otherwise valid evidence", () => { const fixture = fixtureBundle(); withTempDir((parent) => { const outputDir = path.join(parent, "run"); writeEvidencePackage({ rootPath: ROOT, outputDir, rawReport: fixture.rawReport, runtimeIdentity: fixture.runtimeIdentity, preflight: fixture.preflight }); expectReject(() => verifyEvidenceDirectory({ rootPath: ROOT, evidenceDir: outputDir, expectedSourceSha: "f".repeat(40) }), "GATE6_VERIFY_SOURCE_SHA_MISMATCH"); }); });
  process.stdout.write("Gate 6 verifier receipt provenance offline fixture PASS\n");
}
main();
