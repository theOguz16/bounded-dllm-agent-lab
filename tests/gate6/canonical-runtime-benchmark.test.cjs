#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { ORACLE_SENTINEL, VERSION, runCanonicalRuntimeBenchmark } =
  require("../../scripts/canonical-runtime-benchmark.cjs");

(async () => {
  const report = await runCanonicalRuntimeBenchmark();
  assert.equal(report.schemaVersion, VERSION);
  assert.equal(report.schemaVersion, "canonical-runtime-benchmark/v2");
  assert.equal(report.executionClass, "canonical_runtime_offline_fixture");
  assert.equal(report.liveModelEvidence, false);
  assert.equal(JSON.stringify(report).includes(ORACLE_SENTINEL), false);
  assert.equal(report.observations.length, 4);

  const success = report.observations.find((entry) => entry.scenario === "behavior_success");
  const broken = report.observations.find((entry) => entry.scenario === "behavior_failure");
  const noChange = report.observations.find((entry) => entry.scenario === "no_change");
  const timeout = report.observations.find((entry) => entry.scenario === "timeout");
  assert.match(success.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(success.runtimeEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(success.endToEndAccepted, true);
  assert.equal(success.behaviorTest.status, "passed");
  assert.match(success.behaviorTest.assertionHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(broken.fileScopeSuccess, true);
  assert.equal(broken.endToEndAccepted, false, "structural success must not hide broken behavior");
  assert.equal(broken.behaviorTest.status, "failed");
  assert.equal(noChange.behaviorTest.status, "not_run");
  assert.equal(timeout.safeStop, true);
  assert.equal(timeout.route, "replan_required");

  const wrongBehavior = await runCanonicalRuntimeBenchmark({ scenarios: ["behavior_wrong_result"] });
  assert.equal(wrongBehavior.observations[0].fileScopeSuccess, true);
  assert.equal(wrongBehavior.observations[0].behaviorTest.status, "failed");
  assert.equal(wrongBehavior.observations[0].endToEndAccepted, false,
    "scenario labels and structural verification must not fabricate behavior success");
  process.stdout.write("canonical runtime benchmark test passed\n");
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
