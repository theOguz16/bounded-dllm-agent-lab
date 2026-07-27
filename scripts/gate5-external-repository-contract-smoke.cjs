#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const hash = (value) => runtime.hashCanonicalJson(value);

  const manifest = runtime.createExternalRepositoryTaskManifest({
    repository: {
      owner: "sindresorhus",
      name: "p-limit",
      commitSha: "0123456789abcdef0123456789abcdef01234567"
    },
    taskId: "p-limit.issue-98",
    taskDescription: "Implement the bounded external repository task without changing package metadata.",
    providerVisibleContextHash: hash({ task: "public task context" }),
    evaluatorOracleHash: hash({ expected: ["index.js"] }),
    acceptanceCommands: ["npm test", "npm run lint"],
    allowedChangeFiles: ["index.js", "test.js"],
    forbiddenFiles: ["package.json"]
  });

  assert.equal(manifest.version, "external-repository-task/v1");
  assert.match(manifest.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(runtime.validateExternalRepositoryTaskManifest(manifest).ok, true);
  assert(Object.isFrozen(manifest));

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.repository.commitSha = "main";
  const invalidCommit = runtime.validateExternalRepositoryTaskManifest(tampered);
  assert.equal(invalidCommit.ok, false);
  assert(invalidCommit.reasons.includes("commit_sha_invalid"));

  const overlap = JSON.parse(JSON.stringify(manifest));
  overlap.forbiddenFiles = ["index.js"];
  overlap.manifestHash = hash({ altered: true });
  const invalidScope = runtime.validateExternalRepositoryTaskManifest(overlap);
  assert.equal(invalidScope.ok, false);
  assert(invalidScope.reasons.includes("scope_overlap"));

  const changedOracle = JSON.parse(JSON.stringify(manifest));
  changedOracle.evaluatorOracleHash = hash({ expected: ["other.js"] });
  const invalidHash = runtime.validateExternalRepositoryTaskManifest(changedOracle);
  assert.equal(invalidHash.ok, false);
  assert(invalidHash.reasons.includes("manifest_hash_invalid"));

  console.log(JSON.stringify({
    ok: true,
    decision: "gate5_external_repository_contract_ready",
    immutableCommit: true,
    provenanceBound: true,
    scopeFailClosed: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
