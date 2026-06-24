import assert from "node:assert/strict";
import { getAblationMode, listAblationModes } from "../../packages/ablation-core/src/index.js";
import { nanoidCodePatchCases, validateCodePatchCases } from "../../packages/code-benchmark/src/index.js";
import { createComparisonArtifact, createRunManifest, validateRunManifest } from "../../packages/experiment-core/src/index.js";
import { aggregateScores, createBenchmarkArtifact } from "../../packages/eval-core/src/index.js";
import { demoFixtures, hardFixtures, remaskFixtures, validateFixtures } from "../../packages/fixtures/src/index.js";
import { auditFixturesForOracleLeakage } from "../../packages/oracle-audit/src/index.js";
import { parseUnifiedDiff, reviewPatch, type RepoPolicy, type VerifierAdapterOutput } from "../../packages/product-runtime/src/index.js";
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
assert.equal(starterPolicyValidation.qualityGrade, "strong");

const invalidPolicyValidation = validatePolicy({
  ...productPolicy,
  paired_files: [{ source: "package.json", requires: "package.json" }]
});
assert.equal(invalidPolicyValidation.ok, false);
assert.equal(invalidPolicyValidation.findings.some((finding) => finding.code === "self_paired_file_rule"), true);
assert.deepEqual(starterPolicyValidation.policy.paired_files?.[0].changed_when_contains, ["version"]);
assert.deepEqual(starterPolicyValidation.policy.required_test_mappings?.[0].changed_when_contains, ["export function", "export const"]);

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

const conditionalPairedPolicy: RepoPolicy = {
  ...productPolicy,
  paired_files: [
    {
      source: "package.json",
      requires: "jsr.json",
      reason: "only version metadata requires jsr alignment",
      changed_when_contains: ["\"version\""]
    }
  ]
};

const packageBudgetReview = reviewPatch({
  task: productTask,
  policy: conditionalPairedPolicy,
  diff: parseUnifiedDiff("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@\n-      \"limit\": \"90 B\"\n+      \"limit\": \"93 B\"\n")
});

assert.equal(packageBudgetReview.decision, "approve");
assert.equal(packageBudgetReview.findings.some((finding) => finding.category === "paired_file"), false);

const packageVersionReview = reviewPatch({
  task: productTask,
  policy: conditionalPairedPolicy,
  diff: parseUnifiedDiff("diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@\n-  \"version\": \"1.0.0\"\n+  \"version\": \"1.0.1\"\n")
});

assert.equal(packageVersionReview.decision, "remask_required");
assert.equal(packageVersionReview.findings.some((finding) => finding.category === "paired_file"), true);

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
  owner_aliases: {
    "billing-team": ["payments"]
  },
  paired_files: [],
  sensitive_patterns: [],
  required_test_mappings: [],
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

const ownershipAliasApproveReview = reviewPatch({
  task: {
    id: "ownership-alias-approved",
    title: "Update billing retry copy",
    description: "Authority: payments approved this module maintenance update."
  },
  policy: ownershipPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/retry.ts b/packages/billing/retry.ts\n--- a/packages/billing/retry.ts\n+++ b/packages/billing/retry.ts\n@@\n-export const copy = 'old'\n+export const copy = 'new'\n")
});

assert.equal(ownershipAliasApproveReview.decision, "approve");
assert.equal(ownershipAliasApproveReview.metrics.ownershipSafety, 1);

const requiredTestPolicy: RepoPolicy = {
  ...ownershipPolicy,
  required_test_mappings: [
    {
      source: "packages/billing/**",
      test: "packages/billing/**/*.test.ts",
      reason: "billing source changes require billing tests"
    }
  ]
};

const missingMappedTestReview = reviewPatch({
  task: {
    id: "missing-mapped-test",
    title: "Update billing retry copy",
    description: "Authority: billing-team approved this module maintenance update."
  },
  policy: requiredTestPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/retry.ts b/packages/billing/retry.ts\n--- a/packages/billing/retry.ts\n+++ b/packages/billing/retry.ts\n@@\n-export const retry = 2\n+export const retry = 3\n")
});

assert.equal(missingMappedTestReview.decision, "human_review_required");
assert.equal(missingMappedTestReview.findings.some((finding) => finding.category === "test"), true);

const mappedTestPresentReview = reviewPatch({
  task: {
    id: "mapped-test-present",
    title: "Update billing retry copy",
    description: "Authority: billing-team approved this module maintenance update."
  },
  policy: requiredTestPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/retry.ts b/packages/billing/retry.ts\n--- a/packages/billing/retry.ts\n+++ b/packages/billing/retry.ts\n@@\n-export const retry = 2\n+export const retry = 3\ndiff --git a/packages/billing/retry.test.ts b/packages/billing/retry.test.ts\n--- a/packages/billing/retry.test.ts\n+++ b/packages/billing/retry.test.ts\n@@\n-expect(retry).toBe(2)\n+expect(retry).toBe(3)\n")
});

assert.equal(mappedTestPresentReview.decision, "approve");

const moduleBoundaryPolicy: RepoPolicy = {
  allowed_paths: ["packages/billing/**", "packages/auth/**", "packages/shared/**"],
  forbidden_paths: [],
  ownership: {
    "packages/billing/**": "billing-team"
  },
  owner_aliases: {
    "billing-team": ["payments"]
  },
  paired_files: [],
  sensitive_patterns: [],
  required_test_mappings: [],
  module_boundaries: [
    {
      source: "packages/billing/**",
      allowedWith: ["packages/billing/**", "packages/shared/**"],
      authority: "cross-module approved",
      reason: "billing changes should not cross into auth without explicit authority"
    }
  ],
  missing_authority_rules: []
};

const moduleBoundaryRefuseReview = reviewPatch({
  task: {
    id: "module-boundary-refuse",
    title: "Update billing and auth",
    description: "Authority: billing-team approved this billing update."
  },
  policy: moduleBoundaryPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/rule.ts b/packages/billing/rule.ts\n--- a/packages/billing/rule.ts\n+++ b/packages/billing/rule.ts\n@@\n-export const rule = 'old'\n+export const rule = 'new'\ndiff --git a/packages/auth/rule.ts b/packages/auth/rule.ts\n--- a/packages/auth/rule.ts\n+++ b/packages/auth/rule.ts\n@@\n-export const rule = 'old'\n+export const rule = 'new'\n")
});

assert.equal(moduleBoundaryRefuseReview.decision, "refuse");
assert.equal(moduleBoundaryRefuseReview.findings.some((finding) => finding.category === "module_boundary"), true);
assert.equal(moduleBoundaryRefuseReview.metrics.moduleBoundarySafety, 0);

const moduleBoundaryApproveReview = reviewPatch({
  task: {
    id: "module-boundary-approved",
    title: "Update billing and auth",
    description: "Authority: billing-team approved this billing update.\nAuthority: cross-module approved."
  },
  policy: moduleBoundaryPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/rule.ts b/packages/billing/rule.ts\n--- a/packages/billing/rule.ts\n+++ b/packages/billing/rule.ts\n@@\n-export const rule = 'old'\n+export const rule = 'new'\ndiff --git a/packages/auth/rule.ts b/packages/auth/rule.ts\n--- a/packages/auth/rule.ts\n+++ b/packages/auth/rule.ts\n@@\n-export const rule = 'old'\n+export const rule = 'new'\n")
});

assert.equal(moduleBoundaryApproveReview.decision, "approve");
assert.equal(moduleBoundaryApproveReview.metrics.moduleBoundarySafety, 1);

const verifierAdapterOutput: VerifierAdapterOutput = {
  adapterName: "mock-dllm-verifier",
  mode: "mock",
  confidence: 0.9,
  summary: "Mock adapter detected an external verifier concern.",
  findings: [
    {
      category: "verifier_adapter",
      severity: "warning",
      message: "External verifier suggests human review for ambiguous product wording.",
      files: ["packages/billing/rule.ts"],
      suggestedAction: "human_review_required"
    }
  ]
};

const verifierAdapterReview = reviewPatch({
  task: {
    id: "verifier-adapter",
    title: "Update billing copy",
    description: "Authority: billing-team approved this billing update."
  },
  policy: moduleBoundaryPolicy,
  diff: parseUnifiedDiff("diff --git a/packages/billing/rule.ts b/packages/billing/rule.ts\n--- a/packages/billing/rule.ts\n+++ b/packages/billing/rule.ts\n@@\n-export const rule = 'old'\n+export const rule = 'new'\n"),
  verifierAdapterOutput
});

assert.equal(verifierAdapterReview.decision, "human_review_required");
assert.equal(verifierAdapterReview.findings.some((finding) => finding.category === "verifier_adapter"), true);

const humanReview = reviewPatch({
  task: productTask,
  policy: productPolicy,
  diff: parseUnifiedDiff("")
});

assert.equal(humanReview.decision, "human_review_required");
assert.equal(humanReview.riskLevel, "medium");

console.log(JSON.stringify({ ok: true, checked: ["report", "manifest", "comparison", "worker-contract", "oracle-leakage", "ablation", "code-benchmark", "product-runtime", "product-policy", "ownership-policy", "module-boundary-policy", "verifier-adapter-contract"] }, null, 2));
