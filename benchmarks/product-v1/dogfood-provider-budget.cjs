"use strict";

const { normalizeProviderFailure } = require("./provider-access.cjs");

/** Only bounded provider codes enter persisted evidence. No raw provider output. */
const CLASS_BY_CODE = Object.freeze({
  usage_limit_exceeded: "quota",
  codex_provider_quota: "quota",
  authentication_failed: "auth",
  codex_provider_auth: "auth",
  provider_overloaded: "capacity",
  codex_provider_capacity: "capacity",
  provider_stream_error_unknown: "unknown",
  codex_stream_error: "unknown",
  codex_sdk_error: "unknown"
});

function classifyProviderFailure({ code, diagnosticCode, status } = {}) {
  const known = [code, diagnosticCode].find((value) => typeof value === "string" && Object.hasOwn(CLASS_BY_CODE, value));
  if (known) return CLASS_BY_CODE[known];
  if (status === 401) return "auth";
  if (status === 503) return "capacity";
  // An unspecified HTTP 429 does not establish that the account's usage limit is exhausted.
  if (status === 429) return "unknown";
  return "unknown";
}

function canonicalProviderFailure(error) {
  return normalizeProviderFailure(error);
}

module.exports = { classifyProviderFailure, canonicalProviderFailure };
