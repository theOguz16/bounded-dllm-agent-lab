#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const H = (c) => `sha256:${c.repeat(64)}`;

function rawReport() {
  return {
    schemaVersion: "gate6-live-run/v1",
    executionClass: "live",
    researchStatus: "diagnostic_live_smoke",
    promotionEligible: false,
    sourceCommit: SHA,
    tasksetVersion: "gate6-taskset/v1",
    tasksetHash: H("1"),
    benchmarkSemanticsHash: H("2"),
    repositoryManifestHash: H("3"),
    preconditionAttestationHash: H("4"),
    oracleScorerVersion: "gate6-oracle-scorer/v1",
    receiptVersion: "gate6-simulated-harness-receipt/v3",
    model: "fixture-model",
    endpointClass: "openai_compatible",
    temperature: 0,
    maxCompletionTokens: 4096,
    repetitions: 1,
    taskCount: 1,
    strategyCount: 4,
    sampleCount: 4,
    expectedFullSampleCount: 504,
    filters: { taskLimit: 1, taskId: null, strategy: null },
    observations: [], receipts: [], receiptSetHash: H("5"), sampleOutcomes: [], comparativeReport: null, aggregates: {}, reportHash: H("6")
  };
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

async function main() {
  await test("experiment config binds prompt provider and validator contract identities", () => {
    const current = runner.createLiveExperimentConfig(rawReport());
    assert.equal(current.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.equal(current.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.equal(current.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.equal(current.validatorContractVersion, runner.LIVE_VALIDATOR_CONTRACT_VERSION);
    assert.equal(current.validatorContractHash, runner.LIVE_VALIDATOR_CONTRACT_HASH);

    const variants = [
      runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, "gate6-live-provider-prompt/v999"),
      runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION, "gate6-live-provider-contract/v999"),
      runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION, runner.LIVE_PROVIDER_CONTRACT_VERSION, H("a")),
      runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION, runner.LIVE_PROVIDER_CONTRACT_VERSION, runner.LIVE_PROVIDER_CONTRACT_HASH, "gate6-live-validator-contract/v999"),
      runner.createLiveExperimentConfig(rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION, runner.LIVE_PROVIDER_CONTRACT_VERSION, runner.LIVE_PROVIDER_CONTRACT_HASH, runner.LIVE_VALIDATOR_CONTRACT_VERSION, H("b"))
    ];
    const currentHash = runner.hashLiveExperimentConfig(current);
    for (const variant of variants) assert.notEqual(runner.hashLiveExperimentConfig(variant), currentHash);
  });

  await test("checkpoint identity binds both contracts and rejects old validator identity", () => {
    const report = rawReport();
    const experimentConfigHash = runner.hashLiveExperimentConfig(runner.createLiveExperimentConfig(report));
    const current = runner.checkpoint.createCheckpointIdentity({
      reportIdentity: report,
      experimentConfigHash,
      samplePlanHash: H("9"),
      structuredOutputMode: runner.STRUCTURED_OUTPUT_MODE,
      providerPromptVersion: runner.LIVE_PROVIDER_PROMPT_VERSION,
      providerContractVersion: runner.LIVE_PROVIDER_CONTRACT_VERSION,
      providerContractHash: runner.LIVE_PROVIDER_CONTRACT_HASH,
      validatorContractVersion: runner.LIVE_VALIDATOR_CONTRACT_VERSION,
      validatorContractHash: runner.LIVE_VALIDATOR_CONTRACT_HASH
    });
    assert.equal(current.validatorContractVersion, runner.LIVE_VALIDATOR_CONTRACT_VERSION);
    assert.equal(current.validatorContractHash, runner.LIVE_VALIDATOR_CONTRACT_HASH);
    for (const stale of [
      { ...current, providerPromptVersion: "gate6-live-provider-prompt/v2" },
      { ...current, providerContractVersion: "gate6-live-provider-contract/v0" },
      { ...current, providerContractHash: H("c") },
      { ...current, validatorContractVersion: "gate6-live-validator-contract/v0" },
      { ...current, validatorContractHash: H("d") }
    ]) {
      assert.throws(() => runner.checkpoint.assertIdentityMatch(stale, current), /GATE6_CHECKPOINT_IDENTITY_MISMATCH/);
    }
  });

  await test("final report carries both contract identities", () => {
    const report = runner.augmentReport(rawReport());
    assert.equal(report.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.equal(report.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.equal(report.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.equal(report.validatorContractVersion, runner.LIVE_VALIDATOR_CONTRACT_VERSION);
    assert.equal(report.validatorContractHash, runner.LIVE_VALIDATOR_CONTRACT_HASH);
    assert.equal(report.experimentConfig.validatorContractHash, runner.LIVE_VALIDATOR_CONTRACT_HASH);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
