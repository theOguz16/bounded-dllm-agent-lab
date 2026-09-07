#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  PROVIDER_CONTRACT_HASH,
  PROVIDER_CONTRACT_VERSION,
  providerContractHash,
  providerContractDescriptor
} = require("../../scripts/lib/gate6-live-provider-contract.cjs");

const EXPECTED_CONTRACT_VERSION = "gate6-live-provider-contract/v1";
const EXPECTED_CONTRACT_HASH = "sha256:4ab8c303d97b1f6da525a45b1f64f60c4a131618d444a9803d2004954dad1696";

assert.equal(PROVIDER_CONTRACT_VERSION, EXPECTED_CONTRACT_VERSION);
assert.equal(PROVIDER_CONTRACT_HASH, EXPECTED_CONTRACT_HASH);
assert.equal(providerContractHash(providerContractDescriptor()), EXPECTED_CONTRACT_HASH);
process.stdout.write("PASS canonical Live Contract Hardening v1 hash is pinned\n");
