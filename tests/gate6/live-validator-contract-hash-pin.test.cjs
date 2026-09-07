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
const EXPECTED_CONTRACT_HASH = "sha256:33bb4d98da05f1452e4fbabbec97759fadd10481915ead11366e1709ae83ce59";

assert.equal(VALIDATOR_CONTRACT_VERSION, EXPECTED_CONTRACT_VERSION);
assert.equal(VALIDATOR_CONTRACT_HASH, EXPECTED_CONTRACT_HASH);
assert.equal(validatorContractHash(validatorContractDescriptor()), EXPECTED_CONTRACT_HASH);
process.stdout.write("PASS canonical Live Contract Hardening v1.1 validator hash is pinned\n");
