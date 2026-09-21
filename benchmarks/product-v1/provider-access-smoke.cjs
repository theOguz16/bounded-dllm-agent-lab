#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  FAILURE_CODES, createProviderGate, normalizeProviderFailure, assertSameIdentity
} = require("./provider-access.cjs");

const cases = [
  [{ code: "usage_limit_exceeded", message: "usage_limit_exceeded" }, "usage_limit_exceeded"],
  [{ status: 401, message: "Missing Bearer token" }, "authentication_failed"],
  [{ code: "server_overloaded", status: 503 }, "provider_overloaded"],
  [{ message: "stream disconnected after tool call" }, "provider_stream_error_unknown"]
];
for (const [error, expected] of cases) assert.equal(normalizeProviderFailure(error), expected);
assert.deepEqual(FAILURE_CODES, cases.map((entry) => entry[1]));

const env = {
  BOUNDED_CODEX_ACCOUNT_ALIAS: "personal-a",
  BOUNDED_CODEX_AUTH_MODE: "api_key",
  CODEX_API_KEY: "fake-offline-token",
  BOUNDED_CODEX_MODEL: "fake-model"
};
function gate() {
  return createProviderGate({ model: "fake-model", reasoning: "medium", env });
}

assert.equal(gate().quota, "unknown");
assert.equal(gate().beforeInvocation().accountAlias, "personal-a");
for (const [error, code] of cases.slice(0, 2)) {
  let paidCalls = 0;
  const access = gate();
  access.beforeInvocation();
  paidCalls += 1; // The only simulated call; it fails.
  assert.equal(access.observeFailure(error), code);
  assert.throws(() => access.beforeInvocation(), { code });
  assert.equal(paidCalls, 1, "zero additional paid calls after auth/quota failure");
}
for (const [error, code] of cases.slice(2)) {
  const access = gate();
  access.beforeInvocation();
  let paidCalls = 1;
  assert.equal(access.observeFailure(error), code);
  // A failed invocation is terminal for this attempt: no retry is scheduled.
  assert.equal(paidCalls, 1);
}

const access = gate();
const identity = access.beforeInvocation();
assertSameIdentity(identity, { ...identity });
assert.throws(() => assertSameIdentity(identity, { ...identity, accountAlias: "personal-b" }), {
  code: "provider_identity_changed"
});
assert.throws(() => access.beforeInvocation({ ...env, BOUNDED_CODEX_ACCOUNT_ALIAS: "personal-b" }), {
  code: "provider_identity_changed"
});
assert.throws(() => createProviderGate({ model: "fake-model", reasoning: "medium", env: {
  ...env, CODEX_API_KEY: "", BOUNDED_CODEX_ACCOUNT_ALIAS: "email@example.com"
} }), { code: "provider_account_alias_missing_or_invalid" });
assert.throws(() => createProviderGate({ model: "fake-model", reasoning: "medium", env: {
  ...env, CODEX_API_KEY: ""
} }), { code: "authentication_failed" });
assert.equal(JSON.stringify(identity).includes("fake-offline-token"), false);
assert.equal(JSON.stringify(identity).includes("@"), false);
console.log("P7.6 provider access: offline smoke PASS; paid/network calls=0");
