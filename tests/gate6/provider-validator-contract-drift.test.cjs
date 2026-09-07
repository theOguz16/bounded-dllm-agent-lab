#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");
const provider = require("../../scripts/lib/gate6-live-provider-contract.cjs");
const validator = require("../../scripts/lib/gate6-live-validator-contract.cjs");

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

async function main() {
  await test("provider and validator contracts expose deterministic semantic identity", () => {
    assert.equal(runner.LIVE_PROVIDER_PROMPT_VERSION, "gate6-live-provider-prompt/v3");
    assert.equal(runner.LIVE_PROVIDER_CONTRACT_VERSION, "gate6-live-provider-contract/v1");
    assert.equal(runner.LIVE_VALIDATOR_CONTRACT_VERSION, "gate6-live-validator-contract/v1");
    assert.match(runner.LIVE_PROVIDER_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
    assert.match(runner.LIVE_VALIDATOR_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
    assert.equal(provider.providerContractHash(provider.providerContractDescriptor()), runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.equal(validator.validatorContractHash(validator.validatorContractDescriptor()), runner.LIVE_VALIDATOR_CONTRACT_HASH);
  });

  await test("provider-facing rule manifest matches validator provider-facing semantics", () => {
    const providerDescriptor = provider.providerContractDescriptor();
    const validatorDescriptor = validator.validatorContractDescriptor();
    assert.deepEqual([...providerDescriptor.ruleManifest].sort(), [...validatorDescriptor.providerFacingRuleIds].sort());
    assert.equal(validator.assertProviderValidatorContractCompatibility(providerDescriptor, validatorDescriptor), true);
    assert.equal(runner.assertProviderValidatorContractCompatibility(), true);
  });

  await test("validator semantic drift fails compatibility before any provider call", () => {
    const providerDescriptor = structuredClone(provider.providerContractDescriptor());
    const validatorDescriptor = structuredClone(validator.validatorContractDescriptor());
    validatorDescriptor.providerFacingRuleIds.push("proposal.future_normative_rule");
    let providerCalls = 0;
    assert.throws(() => {
      validator.assertProviderValidatorContractCompatibility(providerDescriptor, validatorDescriptor);
      providerCalls += 1;
    }, (error) => error?.code === "GATE6_PROVIDER_VALIDATOR_CONTRACT_MISMATCH");
    assert.equal(providerCalls, 0);
  });

  await test("provider contract drift and validator contract drift change their hashes", () => {
    const providerDescriptor = structuredClone(provider.providerContractDescriptor());
    providerDescriptor.ruleManifest.push("selection.drift_sentinel");
    assert.notEqual(provider.providerContractHash(providerDescriptor), runner.LIVE_PROVIDER_CONTRACT_HASH);
    const validatorDescriptor = structuredClone(validator.validatorContractDescriptor());
    validatorDescriptor.preflightNormativeRuleIds.push("proposal.drift_sentinel");
    assert.notEqual(validator.validatorContractHash(validatorDescriptor), runner.LIVE_VALIDATOR_CONTRACT_HASH);
  });

  await test("validator manifest includes selection proposal and preflight normative families", () => {
    const descriptor = validator.validatorContractDescriptor();
    for (const id of [
      "selection.disjoint_implementation_and_test",
      "selection.public_candidate_universe_only",
      "selection.no_duplicates",
      "proposal.exact_schema",
      "proposal.expected_content_hash_required",
      "proposal.public_candidate_universe_only",
      "proposal.authority_allowed_paths_only",
      "proposal.forbidden_paths_rejected",
      "proposal.no_duplicate_edits",
      "proposal.no_overlapping_edits"
    ]) {
      assert.ok(
        descriptor.providerFacingRuleIds.includes(id) ||
        descriptor.selectionNormativeRuleIds.includes(id) ||
        descriptor.proposalNormativeRuleIds.includes(id) ||
        descriptor.preflightNormativeRuleIds.includes(id),
        id
      );
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
