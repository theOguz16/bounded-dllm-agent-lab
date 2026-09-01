#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  Gate6PreconditionFreezeError,
  validateAttestations
} = require("../../scripts/lib/gate6-precondition-freeze.cjs");

const ROOT = path.resolve(__dirname, "../..");
const EXPECTED_FREEZE_HASH = "sha256:334d7893325c912ab916215131cf4d440152bc1bc7ae0da9575cdef77068c8ac";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}
function loadTasks() {
  const lock = readJson("benchmarks/gate6/taskset.json");
  return lock.taskFiles.flatMap((relativePath) => readJson(relativePath).tasks);
}
function bundle() {
  const document = readJson("benchmarks/gate6/precondition-freeze.json");
  return {
    document,
    input: {
      preconditions: readJson("benchmarks/gate6/preconditions.json"),
      tasks: loadTasks(),
      repositories: readJson("benchmarks/gate6/repositories.json").repositories,
      attestations: structuredClone(document.attestations)
    }
  };
}
function expectReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6PreconditionFreezeError && error.code === code,
    `expected ${code}`
  );
}
function test(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function main() {
  test("persisted 42-task freeze evidence fully revalidates", () => {
    const current = bundle();
    assert.equal(current.document.schemaVersion, "gate6-precondition-freeze-document/v1");
    assert.equal(current.document.status, "verified_42_of_42");
    const freeze = validateAttestations(current.input);
    assert.equal(freeze.taskCount, 42);
    assert.equal(freeze.repositoryCount, 14);
    assert.equal(freeze.passBaselineCount, 6);
    assert.equal(freeze.failBaselineCount, 36);
    assert.equal(freeze.preconditionAttestationHash, EXPECTED_FREEZE_HASH);
    assert.deepEqual(freeze, current.document.freeze);
  });

  test("mutation task must still fail after deterministic injection", () => {
    const current = bundle();
    const attestation = current.input.attestations.find((item) => item.results.some((result) => result.baselineExpected === "fail"));
    const result = attestation.results.find((item) => item.baselineExpected === "fail");
    result.injectedAcceptanceExitCode = 0;
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_ATTESTATION_HASH_INVALID");
  });

  test("hash-bound mutation evidence cannot be rewritten without invalidating attestation", () => {
    const current = bundle();
    const attestation = current.input.attestations.find((item) => item.results.some((result) => result.baselineExpected === "fail"));
    const result = attestation.results.find((item) => item.baselineExpected === "fail");
    result.faultInjection.beforeBlobSha = "0".repeat(40);
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_ATTESTATION_HASH_INVALID");
  });

  test("no-change result cannot acquire fault injection", () => {
    const current = bundle();
    const attestation = current.input.attestations.find((item) => item.results.some((result) => result.baselineExpected === "pass"));
    const result = attestation.results.find((item) => item.baselineExpected === "pass");
    result.faultInjection = { type: "rename_primary_required_symbol" };
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_ATTESTATION_HASH_INVALID");
  });

  test("runner/probe code-hash tampering is rejected by the attestation hash", () => {
    const current = bundle();
    current.input.attestations[1].runnerHash = "sha256:" + "0".repeat(64);
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_ATTESTATION_HASH_INVALID");
  });

  test("missing repository attestation fails closed", () => {
    const current = bundle();
    current.input.attestations.pop();
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_ATTESTATION_COUNT_INVALID");
  });

  test("task coverage cannot be reduced below 42", () => {
    const current = bundle();
    current.input.tasks.pop();
    expectReject(() => validateAttestations(current.input), "GATE6_PRECONDITION_TASKSET_SIZE_INVALID");
  });

  process.stdout.write("Gate 6 precondition freeze PASS\n");
}

main();
