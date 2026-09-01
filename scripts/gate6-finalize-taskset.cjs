#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TASKSET_PATH = path.join(ROOT, "benchmarks/gate6/taskset.json");
const FREEZE_PATH = path.join(ROOT, "benchmarks/gate6/precondition-freeze.json");
const MODULE_PATH = path.join(ROOT, "scripts/lib/gate6-taskset.cjs");
const EXPECTED_TASKSET_HASH = "sha256:e3e1e93b662fbd6ec0600787c462601a00540c4b56dd8fa72338882fad13f071";
const EXPECTED_PRECONDITION_HASH = "sha256:334d7893325c912ab916215131cf4d440152bc1bc7ae0da9575cdef77068c8ac";
const OLD_TASKSET_HASH = "sha256:c73b390eb4c7293791097e7fbdf35117bdc819b961c6d15ab38b0459e5b8b5a9";

function fail(code) {
  throw new Error(code);
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function replaceOnce(source, before, after, code) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  if (count !== 1) fail(code);
  return source.replace(before, after);
}

function main() {
  const freezeDocument = readJson(FREEZE_PATH);
  if (freezeDocument.schemaVersion !== "gate6-precondition-freeze-document/v1" ||
      freezeDocument.status !== "verified_42_of_42" ||
      freezeDocument.freeze?.taskCount !== 42 ||
      freezeDocument.freeze?.repositoryCount !== 14 ||
      freezeDocument.freeze?.passBaselineCount !== 6 ||
      freezeDocument.freeze?.failBaselineCount !== 36 ||
      freezeDocument.freeze?.preconditionAttestationHash !== EXPECTED_PRECONDITION_HASH ||
      !Array.isArray(freezeDocument.attestations) || freezeDocument.attestations.length !== 14) {
    fail("GATE6_FINALIZE_PRECONDITION_FREEZE_INVALID");
  }

  const taskset = readJson(TASKSET_PATH);
  if (taskset.schemaVersion !== "gate6-taskset/v1" || taskset.taskCount !== 42 || taskset.repositoryCount !== 14) {
    fail("GATE6_FINALIZE_TASKSET_LOCK_INVALID");
  }
  taskset.frozen = true;
  taskset.tasksetHash = EXPECTED_TASKSET_HASH;
  taskset.preconditionAttestationHash = EXPECTED_PRECONDITION_HASH;
  fs.writeFileSync(TASKSET_PATH, `${JSON.stringify(taskset, null, 2)}\n`);

  let source = fs.readFileSync(MODULE_PATH, "utf8");
  source = replaceOnce(
    source,
    '  "classCounts", "difficultyCounts", "repositoryManifestHash", "tasksetHash",\n  "oracleReviewStatus", "oracleMutationPolicy"',
    '  "classCounts", "difficultyCounts", "repositoryManifestHash", "tasksetHash",\n  "preconditionAttestationHash", "oracleReviewStatus", "oracleMutationPolicy"',
    "GATE6_FINALIZE_LOCK_FIELDS_PATCH_INVALID"
  );
  source = replaceOnce(source, OLD_TASKSET_HASH, EXPECTED_TASKSET_HASH, "GATE6_FINALIZE_TASKSET_HASH_PATCH_INVALID");
  source = replaceOnce(
    source,
    'const FROZEN_REPOSITORY_MANIFEST_HASHES = Object.freeze({',
    `const FROZEN_PRECONDITION_ATTESTATION_HASHES = Object.freeze({\n  "gate6-taskset/v1": "${EXPECTED_PRECONDITION_HASH}"\n});\nconst FROZEN_REPOSITORY_MANIFEST_HASHES = Object.freeze({`,
    "GATE6_FINALIZE_PRECONDITION_CONSTANT_PATCH_INVALID"
  );
  source = replaceOnce(
    source,
    '  if (lock.oracleReviewStatus !== ORACLE_REVIEW_STATUS) fail("GATE6_TASKSET_ORACLE_REVIEW_STATUS_INVALID");',
    `  const frozenPreconditionHash = FROZEN_PRECONDITION_ATTESTATION_HASHES[lock.schemaVersion];\n  if (!frozenPreconditionHash || lock.preconditionAttestationHash !== frozenPreconditionHash) {\n    fail("GATE6_TASKSET_PRECONDITION_FREEZE_HASH_MISMATCH");\n  }\n  if (lock.oracleReviewStatus !== ORACLE_REVIEW_STATUS) fail("GATE6_TASKSET_ORACLE_REVIEW_STATUS_INVALID");`,
    "GATE6_FINALIZE_PRECONDITION_VALIDATION_PATCH_INVALID"
  );
  source = replaceOnce(
    source,
    '    tasksetHash,\n    oracleReviewStatus: lock.oracleReviewStatus,',
    '    tasksetHash,\n    preconditionAttestationHash: lock.preconditionAttestationHash,\n    oracleReviewStatus: lock.oracleReviewStatus,',
    "GATE6_FINALIZE_PRECONDITION_REPORT_PATCH_INVALID"
  );
  fs.writeFileSync(MODULE_PATH, source);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    frozen: true,
    tasksetHash: EXPECTED_TASKSET_HASH,
    preconditionAttestationHash: EXPECTED_PRECONDITION_HASH
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
