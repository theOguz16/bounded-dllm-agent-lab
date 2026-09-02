#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FROZEN_BENCHMARK_SEMANTICS_HASHES,
  Gate6VerifierError,
  computeBenchmarkSemantics
} = require("../../scripts/lib/gate6-verifier.cjs");
const { SCORER_VERSION } = require("../../scripts/lib/gate6-oracle-scorer.cjs");

const ROOT = path.resolve(__dirname, "../..");
const SEMANTICS_PATH = "benchmarks/gate6/benchmark-semantics.json";
const SCORER_PATH = "scripts/lib/gate6-oracle-scorer.cjs";

function expectReject(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof Gate6VerifierError && error.code === code,
    `expected ${code}`
  );
}

function copySemanticBundle(destination) {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, SEMANTICS_PATH), "utf8"));
  for (const relativePath of [SEMANTICS_PATH, ...document.semanticSourceFiles]) {
    const target = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), target);
  }
  return document;
}

function main() {
  const frozen = computeBenchmarkSemantics(ROOT);
  assert.equal(frozen.document.measurementSemantics.oracleScorerVersion, SCORER_VERSION);
  assert.equal(frozen.document.semanticSourceFiles.includes(SCORER_PATH), true);
  assert.equal(
    frozen.benchmarkSemanticsHash,
    FROZEN_BENCHMARK_SEMANTICS_HASHES["gate6-benchmark/v1"]
  );
  process.stdout.write("PASS oracle scorer version and source are frozen in benchmark semantics\n");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gate6-semantic-freeze-"));
  try {
    copySemanticBundle(tempRoot);
    assert.equal(
      computeBenchmarkSemantics(tempRoot).benchmarkSemanticsHash,
      frozen.benchmarkSemanticsHash
    );
    fs.appendFileSync(path.join(tempRoot, SCORER_PATH), "\n// semantic mutation fixture\n");
    expectReject(
      () => computeBenchmarkSemantics(tempRoot),
      "GATE6_VERIFY_BENCHMARK_SEMANTICS_HASH_MISMATCH"
    );
    process.stdout.write("PASS scorer byte or logic change invalidates frozen gate6-benchmark/v1 semantics\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write("Gate 6 benchmark semantic freeze PASS\n");
}

main();
