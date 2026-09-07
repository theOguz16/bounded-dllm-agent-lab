#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  VALIDATOR_CONTRACT_HASH,
  VALIDATOR_CONTRACT_VERSION,
  validatorContractDescriptor,
  validatorContractHash
} = require("../../scripts/lib/gate6-live-validator-contract.cjs");

const EXPECTED_CONTRACT_VERSION = "gate6-live-validator-contract/v1";

assert.equal(VALIDATOR_CONTRACT_VERSION, EXPECTED_CONTRACT_VERSION);
assert.match(VALIDATOR_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
assert.equal(validatorContractHash(validatorContractDescriptor()), VALIDATOR_CONTRACT_HASH);
process.stdout.write(`PASS canonical validator contract identity is deterministic: ${VALIDATOR_CONTRACT_HASH}\n`);
