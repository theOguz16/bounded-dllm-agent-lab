#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const ORIGINAL_HASH = `sha256:${"a".repeat(64)}`;

async function main() {
  const runtime = await import(pathToFileURL(
    path.join(repoRoot, "dist/packages/product-runtime/src/canonical-runtime.js")
  ).href);

  assert.equal(runtime.TARGETED_REPAIR_REQUEST_VERSION, "targeted-repair-request/v1");
  assert.equal(typeof runtime.parseTargetedRepairRequest, "function");
  assert.equal(runtime.TARGETED_REPAIR_REQUEST_SCHEMA.additionalProperties, false);

  const boundary = {
    originalCandidateHash: ORIGINAL_HASH,
    originalCandidateFiles: [
      "src/auth/session.ts",
      "test/auth/session.test.ts",
      "bounded-agent.policy.yml",
      "acceptance/task.json"
    ],
    policyFiles: ["bounded-agent.policy.yml"],
    acceptanceCriteriaFiles: ["acceptance/task.json"]
  };

  const request = {
    schemaVersion: "targeted-repair-request/v1",
    originalCandidateHash: ORIGINAL_HASH,
    failingFiles: ["src/auth/session.ts"],
    failingChecks: ["typecheck", "test:auth"],
    verifierIssues: [
      {
        code: "refresh_expiry_regression",
        message: "Refresh expiry behavior is still incorrect.",
        file: "src/auth/session.ts"
      }
    ],
    allowedFiles: ["src/auth/session.ts", "test/auth/session.test.ts"],
    preserveFiles: ["bounded-agent.policy.yml", "acceptance/task.json"],
    repairRound: 1
  };

  const parsed = runtime.parseTargetedRepairRequest(request, boundary);
  assert.equal(parsed.schemaVersion, "targeted-repair-request/v1");
  assert.deepEqual(parsed.allowedFiles, ["src/auth/session.ts", "test/auth/session.test.ts"]);
  assert.deepEqual(parsed.preserveFiles, ["acceptance/task.json", "bounded-agent.policy.yml"]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.allowedFiles), true);

  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      allowedFiles: [...request.allowedFiles, "src/auth/index.ts"]
    }, boundary),
    /scope expansion is forbidden/
  );

  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      allowedFiles: [...request.allowedFiles, "src/auth/new-session-helper.ts"]
    }, boundary),
    /scope expansion is forbidden/
  );

  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      allowedFiles: [...request.allowedFiles, "bounded-agent.policy.yml"],
      preserveFiles: ["acceptance/task.json"]
    }, boundary),
    /Policy and acceptance-criteria files cannot be mutable/
  );

  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      allowedFiles: [...request.allowedFiles, "acceptance/task.json"],
      preserveFiles: ["bounded-agent.policy.yml"]
    }, boundary),
    /Policy and acceptance-criteria files cannot be mutable/
  );

  assert.throws(
    () => runtime.parseTargetedRepairRequest({ ...request, newFiles: ["src/auth/helper.ts"] }, boundary),
    /exact contract fields/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({ ...request, policy: { allowed_paths: ["**"] } }, boundary),
    /exact contract fields/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({ ...request, acceptanceCriteria: ["always pass"] }, boundary),
    /exact contract fields/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      originalCandidateHash: `sha256:${"b".repeat(64)}`
    }, boundary),
    /does not match the trusted original candidate/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      failingFiles: ["bounded-agent.policy.yml"]
    }, boundary),
    /failingFiles must be a subset of allowedFiles/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      allowedFiles: ["src/auth/session.ts"],
      preserveFiles: ["src/auth/session.ts", "test/auth/session.test.ts", "bounded-agent.policy.yml", "acceptance/task.json"]
    }, boundary),
    /must be disjoint/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({
      ...request,
      failingChecks: [],
      verifierIssues: []
    }, boundary),
    /requires at least one failing check or verifier issue/
  );
  assert.throws(
    () => runtime.parseTargetedRepairRequest({ ...request, repairRound: 0 }, boundary),
    /positive safe integer/
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    contractVersion: runtime.TARGETED_REPAIR_REQUEST_VERSION,
    modelIndependent: true,
    trustedOriginalCandidateBoundaryRequired: true,
    scopeExpansionRejected: true,
    newFileRequestRejected: true,
    policyMutationRejected: true,
    acceptanceCriteriaMutationRejected: true,
    originalCandidateHashBound: true,
    failingFilesBoundToAllowedFiles: true,
    preserveFilesImmutable: true,
    exactRequestShape: true
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
