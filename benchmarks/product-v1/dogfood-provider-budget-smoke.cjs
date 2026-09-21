#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { classifyProviderFailure } = require("./dogfood-provider-budget.cjs");

for (const [code, expected] of [
  ["codex_provider_auth", "auth"],
  ["authentication_failed", "auth"],
  ["401", "auth"],
  ["codex_provider_quota", "quota"],
  ["usage_limit_exceeded", "quota"],
  ["429", "quota"],
  ["codex_provider_capacity", "capacity"],
  ["server_overloaded", "capacity"],
  ["503", "capacity"],
  ["provider_stream_error_unknown", "unknown"],
  ["codex_sdk_error", "unknown"],
  ["", "unknown"]
]) {
  assert.equal(classifyProviderFailure({ code }), expected, code);
  assert.equal(classifyProviderFailure({ diagnosticCode: code }), expected, `diagnostic ${code}`);
}
assert.equal(classifyProviderFailure({ code: "dogfood_agent_execution_failure", diagnosticCode: "usage_limit_exceeded" }), "quota");
assert.equal(classifyProviderFailure({ code: "dogfood_agent_execution_failure", diagnosticCode: "authentication_failed" }), "auth");
assert.equal(classifyProviderFailure({ code: "dogfood_agent_execution_failure", diagnosticCode: "provider_overloaded" }), "capacity");
assert.equal(classifyProviderFailure({ code: "dogfood_agent_execution_failure", diagnosticCode: "secret-sentinel" }), "unknown");
console.log("P7.6 offline provider failure classification: PASS");
