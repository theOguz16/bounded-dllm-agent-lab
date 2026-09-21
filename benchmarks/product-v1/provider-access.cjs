"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER = "codex";
const AUTH_STOP_CODES = new Set(["usage_limit_exceeded", "authentication_failed"]);
const FAILURE_CODES = Object.freeze([
  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"
]);

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function accountAlias(env = process.env) {
  const alias = env.BOUNDED_CODEX_ACCOUNT_ALIAS;
  if (typeof alias !== "string" || !ACCOUNT_ALIAS.test(alias) || alias.includes("@")) {
    throw gateError("provider_account_alias_missing_or_invalid");
  }
  return alias;
}

function authMode(env = process.env) {
  const mode = env.BOUNDED_CODEX_AUTH_MODE;
  if (mode !== "api_key" && mode !== "codex_home") {
    throw gateError("provider_auth_mode_missing_or_invalid");
  }
  return mode;
}

function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function readAuthState(env, mode) {
  if (mode === "api_key") {
    const key = env.CODEX_API_KEY || env.OPENAI_API_KEY;
    if (typeof key !== "string" || key.trim().length === 0 || /\s/.test(key)) {
      throw gateError("authentication_failed");
    }
    // Never serialize, log, or hash the key. This reference is process-local only.
    return Object.freeze({ mode, key });
  }
  const home = codexHome(env);
  let state;
  try {
    state = fs.statSync(path.join(home, "auth.json"));
  } catch {
    throw gateError("authentication_failed");
  }
  if (!state.isFile() || state.size === 0) throw gateError("authentication_failed");
  return Object.freeze({ mode, home, ino: state.ino, size: state.size, mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs });
}

function sameAuthState(left, right) {
  return left.mode === right.mode && (left.mode === "api_key"
    ? left.key === right.key
    : left.home === right.home && left.ino === right.ino && left.size === right.size &&
      left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
}

function createProviderGate({ model, reasoning, env = process.env, checkAuth = readAuthState } = {}) {
  if (typeof model !== "string" || !MODEL.test(model)) throw gateError("provider_model_invalid");
  if (typeof reasoning !== "string" || !/^[a-z_]+$/.test(reasoning)) {
    throw gateError("provider_reasoning_invalid");
  }
  const alias = accountAlias(env);
  const mode = authMode(env);
  const initial = checkAuth(env, mode);
  let terminalCode = null;
  const identity = Object.freeze({ provider: PROVIDER, model, reasoning, accountAlias: alias, authMode: mode });
  return Object.freeze({
    identity,
    quota: "unknown",
    beforeInvocation(currentEnv = env) {
      if (terminalCode !== null) throw gateError(terminalCode);
      if (accountAlias(currentEnv) !== alias || authMode(currentEnv) !== mode ||
          currentEnv !== env && (currentEnv.BOUNDED_CODEX_MODEL || currentEnv.CODEX_MODEL) !== model) {
        throw gateError("provider_identity_changed");
      }
      const current = checkAuth(currentEnv, mode);
      if (!sameAuthState(initial, current)) throw gateError("provider_identity_changed");
      return identity;
    },
    afterInvocation(currentEnv = env) {
      if (accountAlias(currentEnv) !== alias || authMode(currentEnv) !== mode ||
          !sameAuthState(initial, checkAuth(currentEnv, mode))) {
        terminalCode = "provider_identity_changed";
        throw gateError(terminalCode);
      }
    },
    observeFailure(error) {
      const code = normalizeProviderFailure(error);
      if (AUTH_STOP_CODES.has(code)) terminalCode = code;
      return code;
    },
    stopCode() { return terminalCode; }
  });
}

function normalizeProviderFailure(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    if (typeof current !== "object" && typeof current !== "string") break;
    seen.add(current);
    const status = typeof current === "object" ? current.status ?? current.statusCode : null;
    const code = typeof current === "object" ? String(current.code || current.error?.code || "") : "";
    const message = typeof current === "string" ? current : String(current.message || "");
    const text = `${code} ${message}`.toLowerCase();
    if (status === 401 || /\b(authentication_failed|invalid_api_key|unauthorized|missing bearer|bearer token missing)\b/.test(text)) {
      return "authentication_failed";
    }
    if (/\b(usage_limit_exceeded|insufficient_quota|billing_hard_limit_reached|quota_exceeded)\b/.test(text) ||
        /usage limit exceeded|you have hit your usage limit|quota has been exceeded/i.test(text)) {
      return "usage_limit_exceeded";
    }
    if (status === 503 || /\b(server_overloaded|provider_overloaded|overloaded_error)\b/.test(text) ||
        /server (is )?overloaded|temporarily overloaded/i.test(text)) {
      return "provider_overloaded";
    }
    current = typeof current === "object" ? current.cause : null;
  }
  return "provider_stream_error_unknown";
}

function sameIdentity(left, right) {
  return left && right && ["provider", "model", "reasoning", "accountAlias", "authMode"].every(
    (key) => typeof left[key] === "string" && left[key] === right[key]
  );
}

function assertSameIdentity(expected, actual) {
  if (!sameIdentity(expected, actual)) throw gateError("provider_identity_changed");
  return true;
}

module.exports = {
  FAILURE_CODES,
  accountAlias,
  authMode,
  createProviderGate,
  normalizeProviderFailure,
  sameIdentity,
  assertSameIdentity
};
