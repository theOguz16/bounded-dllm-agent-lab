#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { sourceOriginal } = require("./codex-v1-fixture.cjs");
const { createCompareTrustedFixture } = require("./codex-v1-compare-trusted-fixture.cjs");

async function main() {
  const projectRoot = path.resolve(__dirname, "../..");
  const compare = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/commands/compare.js")));
  const fixture = await createCompareTrustedFixture(projectRoot);
  const reports = [];
  for (const variant of ["valid", "missing", "corrupt", "wrong_candidate"]) {
    const before = fixture.counters.trusted;
    const result = await compare.compareCodexCommand(
      { task: "Make calculate multiply by three." }, fixture.repository,
      {
        adapter: fixture.adapter, model: "fixture-model",
        prepareValidationSubstrate: fixture.prepareValidationSubstrate,
        trustedBehavior: (candidate) => fixture.trustedBehavior(variant, candidate)
      }
    );
    assert.equal(fixture.counters.trusted, before + 1, `${variant}: trusted host not invoked`);
    assert.equal(result.exitCode, 0, `${variant}: ${JSON.stringify(result.output)}`);
    const report = result.output;
    const candidate = report.boundedCandidate;
    const firstReceipt = fixture.firstReceipt();
    assert.ok(candidate && candidate.taskId && candidate.taskHash && candidate.handoffHash);
    assert.equal(candidate.candidateTreeHash, firstReceipt.candidateTreeHash);
    assert.equal(candidate.taskId, firstReceipt.taskId);
    assert.equal(candidate.taskHash, firstReceipt.taskHash);
    assert.equal(report.evaluations.bounded.schemaVersion, "product-comparison-evaluation/v3");
    assert.equal(report.evaluations.bounded.correctness.behaviorSatisfied, variant === "valid" ? true : null);
    assert.equal(report.evaluations.bounded.correctness.taskSucceeded, variant === "valid" ? true : null);
    assert.equal(report.sourceRepositoryUnchanged, true);
    assert.equal(await fs.readFile(path.join(fixture.repository, "src/calculate.js"), "utf8"), sourceOriginal);
    reports.push({ variant, taskId: candidate.taskId, taskHash: candidate.taskHash,
      handoffHash: candidate.handoffHash, candidateTreeHash: candidate.candidateTreeHash,
      schemaVersion: report.evaluations.bounded.schemaVersion,
      behavior: report.evaluations.bounded.behavior,
      taskSucceeded: report.evaluations.bounded.correctness.taskSucceeded });
  }
  assert.equal(fixture.snapshot(fixture.repository), fixture.sourceTreeHash);
  assert.equal(fixture.counters.discovery, 4);
  assert.equal(fixture.counters.baseline, 4);
  assert.ok(fixture.counters.execution >= 2, "real bounded candidate execution was not observed");
  process.stdout.write(`${JSON.stringify({ result: "PASS", sourceCommitSha: fixture.sourceCommitSha,
    sourceTreeHash: fixture.sourceTreeHash, counters: fixture.counters,
    reports, evidenceDirectory: fixture.evidenceDirectory, fixtureRoot: fixture.parent }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
