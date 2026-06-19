import assert from "node:assert/strict";
import { getAblationMode, listAblationModes } from "../../packages/ablation-core/src/index.js";
import { createComparisonArtifact, createRunManifest, validateRunManifest } from "../../packages/experiment-core/src/index.js";
import { aggregateScores, createBenchmarkArtifact } from "../../packages/eval-core/src/index.js";
import { demoFixtures, hardFixtures, remaskFixtures, validateFixtures } from "../../packages/fixtures/src/index.js";
import { auditFixturesForOracleLeakage } from "../../packages/oracle-audit/src/index.js";
import { isHealthResponse, isInfillResponse, isResolveConflictResponse } from "../../packages/worker-contract/src/index.js";

const cases = [
  {
    caseId: "smoke-case",
    family: "correction_override" as const,
    taskSuccess: 1 as const,
    requiredTermCoverage: 1,
    forbiddenTermHitCount: 0,
    scopeDrift: 0 as const,
    sensitiveLeakage: 0 as const,
    correctionOverride: 1 as const,
    insufficientContext: 1 as const,
    boundaryAccuracy: 1 as const,
    evidenceCoverage: 1,
    traceCompleteness: 1 as const,
    contextTokens: 100,
    contextBudgetTokens: 500,
    contextBudgetUtilization: 0.2
  }
];
const report = aggregateScores(cases);
const artifact = createBenchmarkArtifact({
  suiteName: "smoke-suite",
  engineName: "smoke-engine",
  createdAt: "2026-01-01T00:00:00.000Z",
  report
});

// Golden smoke test bir modelin kalitesini test etmez. Buradaki amaç rapor ve
// manifest şeklinin sessizce değişmesini yakalamaktır. Gerçek deneyler başlamadan
// önce contract drift'i fark etmek lab güvenilirliği için kritik.
assert.equal(artifact.report.cases.length, 1);
assert.equal(artifact.report.familyBreakdown.length, 1);
assert.equal(artifact.report.familyBreakdown[0].family, "correction_override");

const manifest = createRunManifest({
  config: {
    runId: "smoke-run",
    suiteName: "smoke-suite",
    architectureName: "bounded-dllm-refinement-loop",
    engineName: "smoke-engine",
    modelName: "mock",
    modelVersion: "0.1.0",
    seed: 0,
    maxAttempts: 1,
    ablation: {
      maskPolicyEnabled: true,
      verifierEnabled: true,
      syntheticContextEnabled: false,
      refinementMaxAttempts: 1
    },
    maskPolicyVersion: "role-mask-v1",
    gitCommit: "smoke",
    hardware: {
      platform: "test",
      arch: "test",
      cpuCount: 1,
      totalMemoryMb: 1024
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  report,
  reportPaths: {
    jsonPath: "reports/smoke.json",
    markdownPath: "reports/smoke.md",
    manifestPath: "reports/smoke.manifest.json"
  }
});

assert.deepEqual(validateRunManifest(manifest), []);

const comparison = createComparisonArtifact({
  createdAt: "2026-01-01T00:00:00.000Z",
  manifests: [manifest]
});

assert.equal(comparison.runCount, 1);
assert.equal(comparison.rows[0].architectureName, "bounded-dllm-refinement-loop");
assert.equal(isHealthResponse({ ok: true, workerName: "mock", mode: "mock", version: "0.1.0" }), true);
assert.equal(isInfillResponse({ requestId: "1", region: "patch_intent", content: "x", engineName: "mock", latencyMs: 1 }), true);
assert.equal(isResolveConflictResponse({ requestId: "1", conflictId: "c1", resolution: "x", engineName: "mock", latencyMs: 1 }), true);
assert.equal(isHealthResponse({ ok: true, workerName: "mock", mode: "unknown", version: "0.1.0" }), false);

assert.deepEqual(validateFixtures(demoFixtures), []);
assert.deepEqual(validateFixtures(hardFixtures, { expectedFamilyCount: 5 }), []);
assert.deepEqual(validateFixtures(remaskFixtures, { expectedFamilyCount: undefined }), []);

const oracleAudit = auditFixturesForOracleLeakage([...demoFixtures, ...hardFixtures, ...remaskFixtures]);

// Oracle leakage smoke testi araştırmanın sigortasıdır. Worker'a cevap anahtarı
// sızarsa modelin doğru cevap vermesi başarı değil, deney tasarımı hatası olur.
assert.equal(oracleAudit.ok, true, JSON.stringify(oracleAudit.findings, null, 2));
assert.equal(oracleAudit.fixtureCount, 80);

const ablationModeIds = listAblationModes().map((mode) => mode.id);

// Ablation smoke testi gerçek model kalitesini ölçmez. Sadece bilimsel koşu için
// gerekli mimari varyantların kayıtlı olduğunu ve en zayıf/güçlü kontrollü modların
// aynı fixture sözleşmesiyle workspace üretebildiğini doğrular.
assert.deepEqual(ablationModeIds, ["raw_fact_only", "bounded_context", "bounded_grounded", "bounded_refinement"]);
assert.equal((await getAblationMode("raw_fact_only").runFixture(demoFixtures[0])).workspace.finalResult, "The backend will be Python Flask.");
assert.equal((await getAblationMode("bounded_grounded").runFixture(demoFixtures[0])).workspace.finalResult, "The backend will be TypeScript Fastify.");
assert.equal((await getAblationMode("bounded_grounded").runFixture(hardFixtures[0])).workspace.finalResult, "The hard benchmark should include twenty five adversarial cases.");

console.log(JSON.stringify({ ok: true, checked: ["report", "manifest", "comparison", "worker-contract", "oracle-leakage", "ablation"] }, null, 2));
