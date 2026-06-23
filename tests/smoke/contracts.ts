import assert from "node:assert/strict";
import { getAblationMode, listAblationModes } from "../../packages/ablation-core/src/index.js";
import { nanoidCodePatchCases, validateCodePatchCases } from "../../packages/code-benchmark/src/index.js";
import { createComparisonArtifact, createRunManifest, validateRunManifest } from "../../packages/experiment-core/src/index.js";
import { aggregateScores, createBenchmarkArtifact } from "../../packages/eval-core/src/index.js";
import { demoFixtures, hardFixtures, remaskFixtures, validateFixtures } from "../../packages/fixtures/src/index.js";
import { auditFixturesForOracleLeakage } from "../../packages/oracle-audit/src/index.js";
import { parseUnifiedDiff, reviewPatch, type RepoPolicy } from "../../packages/product-runtime/src/index.js";
import { isHealthResponse, isInfillResponse, isResolveConflictResponse } from "../../packages/worker-contract/src/index.js";
import { parsePolicy, starterPolicyYaml, validatePolicy } from "../../apps/cli/src/product-policy-utils.js";

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

assert.deepEqual(validateCodePatchCases(nanoidCodePatchCases), []);
assert.equal(nanoidCodePatchCases[0].repoId, "nanoid");
assert.equal(nanoidCodePatchCases[0].baseCommit, "e4b7a9a7323006474ec939112aec68944b0da097");

const productPolicy: RepoPolicy = {
  allowed_paths: ["package.json", "jsr.json"],
  forbidden_paths: ["index.js"],
  ownership: {},
  paired_files: [
    {
      source: "package.json",
      requires: "jsr.json",
      reason: "release metadata must stay consistent"
    }
  ],
  sensitive_patterns: ["SECRET"],
  missing_authority_rules: []
};

const starterPolicyValidation = validatePolicy(parsePolicy(starterPolicyYaml, "bounded-agent.policy.yml"));
assert.equal(starterPolicyValidation.ok, true);
assert.equal(starterPolicyValidation.errorCount, 0);

const invalidPolicyValidation = validatePolicy({
  ...productPolicy,
  paired_files: [{ source: "package.json", requires: "package.json" }]
});
assert.equal(invalidPolicyValidation.ok, false);
assert.equal(invalidPolicyValidation.findings.some((finding) => finding.code === "self_paired_file_rule"), true);

const productTask = {
  id: "product-smoke",
  title: "Update release metadata",
  description: "Authority: release metadata update is approved.",
  authorityFacts: ["release metadata update is approved"]
};

const remaskReview = reviewPatch({
  task: productTask,
  policy: productPolicy,
  diff: parseUnifiedDiff("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@\n-  \"version\": \"1.0.0\"\n+  \"version\": \"1.0.1\"\n")
});

assert.equal(remaskReview.decision, "remask_required");
assert.equal(remaskReview.remaskRegions.length, 1);
assert.equal(remaskReview.repairProposals.length, 1);
assert.equal(remaskReview.repairProposals[0].kind, "paired_file_update");
assert.equal(remaskReview.workspace.roleViews.verifier.role, "verifier");
assert.equal(remaskReview.metrics.remaskNeed, 1);
assert.equal(remaskReview.metrics.pairedFileCompleteness, 0);
assert.equal(remaskReview.metrics.ownershipSafety, 1);

const rejectReview = reviewPatch({
  task: productTask,
  policy: productPolicy,
  diff: parseUnifiedDiff("diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@\n-export const x = 1\n+export const x = 'SECRET'\n")
});

assert.equal(rejectReview.decision, "reject");
assert.equal(rejectReview.findings.some((finding) => finding.category === "sensitive_boundary"), true);
assert.equal(rejectReview.metrics.scopeSafety, 0);
assert.equal(rejectReview.metrics.sensitiveBoundarySafety, 0);

const approveReview = reviewPatch({
  task: productTask,
  policy: productPolicy,
  diff: parseUnifiedDiff("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\ndiff --git a/jsr.json b/jsr.json\n--- a/jsr.json\n+++ b/jsr.json\n")
});

assert.equal(approveReview.decision, "approve");
assert.equal(approveReview.riskLevel, "low");
assert.equal(approveReview.metrics.scopeSafety, 1);
assert.equal(approveReview.metrics.traceCompleteness, 1);

const refuseReview = reviewPatch({
  task: {
    id: "missing-authority",
    title: "Change runtime default",
    description: "Change the runtime default to the new product default."
  },
  policy: {
    ...productPolicy,
    allowed_paths: ["index.js"],
    forbidden_paths: [],
    paired_files: [],
    missing_authority_rules: ["approved product default"]
  },
  diff: parseUnifiedDiff("diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@\n-export const size = 21\n+export const size = 24\n")
});

assert.equal(refuseReview.decision, "refuse");
assert.equal(refuseReview.metrics.authoritySafety, 0);

const ownershipPolicy: RepoPolicy = {
  allowed_paths: ["packages/billing/**"],
  forbidden_paths: [],
  ownership: {
    "packages/billing/**": "billing-team"
  },
  paired_files: [],
  sensitive_patterns: [],
  missing_authority_rules: []
};

const ownershipRefuseReview = reviewPatch({
  task: {
    id: "ownership-missing",
    title: "Update billing retry copy",
    description: "Authority: product maintenance update is approved."
  },
  policy: ownershipPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/retry.ts b/packages/billing/retry.ts\n--- a/packages/billing/retry.ts\n+++ b/packages/billing/retry.ts\n@@\n-export const copy = 'old'\n+export const copy = 'new'\n")
});

assert.equal(ownershipRefuseReview.decision, "refuse");
assert.equal(ownershipRefuseReview.findings.some((finding) => finding.category === "ownership"), true);
assert.equal(ownershipRefuseReview.metrics.ownershipSafety, 0);

const ownershipApproveReview = reviewPatch({
  task: {
    id: "ownership-approved",
    title: "Update billing retry copy",
    description: "Authority: billing-team approved this module maintenance update."
  },
  policy: ownershipPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/retry.ts b/packages/billing/retry.ts\n--- a/packages/billing/retry.ts\n+++ b/packages/billing/retry.ts\n@@\n-export const copy = 'old'\n+export const copy = 'new'\n")
});

assert.equal(ownershipApproveReview.decision, "approve");
assert.equal(ownershipApproveReview.metrics.ownershipSafety, 1);

const humanReview = reviewPatch({
  task: productTask,
  policy: productPolicy,
  diff: parseUnifiedDiff("")
});

assert.equal(humanReview.decision, "human_review_required");
assert.equal(humanReview.riskLevel, "medium");

console.log(JSON.stringify({ ok: true, checked: ["report", "manifest", "comparison", "worker-contract", "oracle-leakage", "ablation", "code-benchmark", "product-runtime", "product-policy", "ownership-policy"] }, null, 2));
