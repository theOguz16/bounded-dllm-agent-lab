#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { classifyProviderFailure, canonicalProviderFailure } = require("./dogfood-provider-budget.cjs");

const cases = [
  [{ code: "usage_limit_exceeded" }, "usage_limit_exceeded", "quota"],
  [{ status: 401, message: "Missing Bearer token" }, "authentication_failed", "auth"],
  [{ code: "server_overloaded", status: 503 }, "provider_overloaded", "capacity"],
  [{ message: "stream disconnected" }, "provider_stream_error_unknown", "unknown"]
];
for (const [error, canonical, category] of cases) {
  assert.equal(canonicalProviderFailure(error), canonical);
  assert.equal(classifyProviderFailure({ code: canonical }), category);
}
assert.equal(classifyProviderFailure({ code: "codex_provider_auth" }), "auth");
assert.equal(classifyProviderFailure({ diagnosticCode: "codex_provider_quota" }), "quota");
assert.equal(classifyProviderFailure({ status: 429 }), "unknown");
assert.equal(classifyProviderFailure({ code: "something_else" }), "unknown");
assert.equal(JSON.stringify(cases.map(([error]) => ({ code: canonicalProviderFailure(error) }))).includes("Bearer"), false);
process.stdout.write("P7.6 provider-budget smoke PASS (offline)\n");
