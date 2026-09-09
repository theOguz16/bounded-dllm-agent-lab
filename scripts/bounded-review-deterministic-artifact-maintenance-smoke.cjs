#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

async function main() {
  const maintenance = await import(
    "../dist/apps/cli/src/deterministic-artifact-maintenance.js"
  );
  const exact = [...maintenance.DETERMINISTIC_AG_ARTIFACT_PATHS];
  const hash = `sha256:${"0".repeat(64)}`;
  const validReceipt = () => ({
    schemaVersion: "bounded-review-deterministic-artifact-verification/v1",
    semanticVerifier: maintenance.DETERMINISTIC_AG_SEMANTIC_VERIFIER,
    byteVerifier: maintenance.DETERMINISTIC_AG_BYTE_VERIFIER,
    sourceMutationDetected: false,
    artifacts: exact.map((artifactPath) => ({ path: artifactPath, sha256: hash }))
  });
  const policy = {
    allowed_paths: [...exact, "docs/**"],
    forbidden_paths: ["reports/**"],
    ownership: {},
    paired_files: [],
    sensitive_patterns: [],
    required_tests: [],
    required_test_mappings: [],
    module_boundaries: [],
    missing_authority_rules: []
  };

  const resolved = maintenance.resolveDeterministicArtifactMaintenancePolicy({
    policy,
    diff: { raw: "", changedFiles: exact },
    verifier: validReceipt
  });
  assert.equal(resolved.applied, true);
  assert.deepEqual(resolved.verifiedPaths, exact);
  assert(policy.forbidden_paths.includes("reports/**"));
  assert(!resolved.policy.forbidden_paths.includes("reports/**"));
  assert.deepEqual(resolved.policy.allowed_paths, policy.allowed_paths);
  assert.equal(resolved.receipt.semanticVerifier, "npm run verify:ag3c");
  assert.equal(resolved.receipt.sourceMutationDetected, false);

  const wildcardOnly = maintenance.resolveDeterministicArtifactMaintenancePolicy({
    policy: { ...policy, allowed_paths: ["reports/ag/**", "docs/**"] },
    diff: { raw: "", changedFiles: exact },
    verifier: () => { throw new Error("wildcard policy must not reach verifier"); }
  });
  assert.equal(wildcardOnly.applied, false);
  assert(wildcardOnly.policy.forbidden_paths.includes("reports/**"));

  const thirdReport = maintenance.resolveDeterministicArtifactMaintenancePolicy({
    policy,
    diff: { raw: "", changedFiles: [exact[0], "reports/ag/UNRELATED.json"] },
    verifier: () => { throw new Error("third report must not reach verifier"); }
  });
  assert.equal(thirdReport.applied, false);
  assert(thirdReport.policy.forbidden_paths.includes("reports/**"));

  assert.throws(() => maintenance.resolveDeterministicArtifactMaintenancePolicy({
    policy,
    diff: { raw: "", changedFiles: [exact[0]] },
    verifier: () => ({ ...validReceipt(), sourceMutationDetected: true })
  }), /verification receipt is invalid/i);

  assert.throws(() => maintenance.resolveDeterministicArtifactMaintenancePolicy({
    policy,
    diff: { raw: "", changedFiles: [exact[0]] },
    verifier: () => { throw new Error("semantic verifier failed"); }
  }), /semantic verifier failed/);

  const root = path.resolve(__dirname, "..");
  const real = spawnSync(process.execPath, [
    path.join(root, "scripts", "verify-bounded-review-deterministic-artifacts.cjs")
  ], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024
  });
  assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
  const receipt = maintenance.validateDeterministicArtifactVerificationReceipt(JSON.parse(real.stdout));
  assert.equal(receipt.semanticVerifier, "npm run verify:ag3c");
  assert.equal(receipt.byteVerifier, "canonical-json-serialization/v1");
  assert.equal(receipt.sourceMutationDetected, false);
  assert.deepEqual(receipt.artifacts.map((entry) => entry.path), exact);

  process.stdout.write("bounded review deterministic artifact maintenance smoke: PASS\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
