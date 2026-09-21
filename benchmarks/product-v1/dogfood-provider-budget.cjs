"use strict";

// A diagnostic code is untrusted provider output. Return only bounded,
// non-secret categories; never persist the original message or token value.
const AUTH = new Set([
  "codex_provider_auth", "authentication_failed", "invalid_api_key",
  "unauthorized", "http_401", "401"
]);
const QUOTA = new Set([
  "codex_provider_quota", "usage_limit_exceeded", "insufficient_quota",
  "quota_exceeded", "billing_hard_limit_reached", "http_429", "429"
]);
const CAPACITY = new Set([
  "codex_provider_capacity", "provider_overloaded", "server_overloaded",
  "overloaded_error", "http_503", "503"
]);

function classifyProviderFailure(input = {}) {
  for (const candidate of [input.code, input.diagnosticCode]) {
    if (typeof candidate !== "string") continue;
    const code = candidate.trim().toLowerCase();
    if (AUTH.has(code)) return "auth";
    if (QUOTA.has(code)) return "quota";
    if (CAPACITY.has(code)) return "capacity";
    if (code === "provider_stream_error_unknown" || code === "codex_stream_error" || code === "codex_sdk_error") {
      return "unknown";
    }
  }
  return "unknown";
}

module.exports = { classifyProviderFailure };
