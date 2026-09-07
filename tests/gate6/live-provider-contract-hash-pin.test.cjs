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
const EXPECTED_CONTRACT_HASH = "sha256:1eae2dfe4af825db485527d967b1a24bab17a4bfe5beb21fa49491bb930079ed";

assert.equal(PROVIDER_CONTRACT_VERSION, EXPECTED_CONTRACT_VERSION);
assert.equal(PROVIDER_CONTRACT_HASH, EXPECTED_CONTRACT_HASH);
assert.equal(providerContractHash(providerContractDescriptor()), EXPECTED_CONTRACT_HASH);
process.stdout.write("PASS canonical Live Contract Hardening v1.1 provider hash is pinned\n");
