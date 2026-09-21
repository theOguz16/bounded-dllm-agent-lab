#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const preflight = require("./dogfood-auth-preflight.cjs");

const valid = { mode: "api_key", model: "gpt-5.6-luna", reasoning: "none", accountAlias: "primary",
  runnerEnvironment: "github-hosted", runnerOs: "Linux", runnerArch: "X64", env: { CODEX_API_KEY: "sentinel" },
  firstLiveAttemptApproved: true, firstLiveAttemptBudget: 1 };
const fails = (input, code) => assert.throws(() => preflight.validateInputs(input), (error) => error?.code === code);

assert.deepEqual([...preflight.AUTH_MODES], ["api_key", "codex_home"]);
assert.equal(preflight.REQUIRED_MODEL, "gpt-5.6-luna");
assert.equal(preflight.REQUIRED_REASONING, "none");
assert.equal(preflight.doctorConfirmsModelAccess({ checks: { "config.load": { details: { model: "gpt-5.6-luna", reasoningEffort: "none" } } } }, "gpt-5.6-luna"), true);
fails({ ...valid, env: {} }, "dogfood_preflight_auth_missing");
fails({ ...valid, model: "gpt-5.6-sol" }, "dogfood_preflight_model_mismatch");
fails({ ...valid, reasoning: "minimal" }, "dogfood_preflight_reasoning_mismatch");
fails({ ...valid, firstLiveAttemptApproved: false }, "dogfood_preflight_live_attempt_not_approved");
fails({ ...valid, firstLiveAttemptBudget: 2 }, "dogfood_preflight_live_attempt_not_approved");

const result = preflight.validateInputs(valid);
assert.equal(result.ok, true);
assert.equal(result.quota.status, "unknown");
assert.equal(result.checks.authStatePresent, true);
assert.equal(result.checks.authAccessVerified, false);
assert.equal(result.networkPolicies.providerEndpoint, "approved_first_attempt_only");
assert.equal(result.networkPolicies.agent, "disabled");
assert.equal(result.networkPolicies.validation, "disabled");
assert.equal(result.silentFallback, false);

const runtime = preflight.validateInputs({ ...valid, checkRuntime: true, commandProbe: () => true, compatibilityProbe: () => ({ ok: true }) });
assert.equal(runtime.checks.cliModelReasoningCompatible, true);
fails({ ...valid, checkRuntime: true, commandProbe: () => true, compatibilityProbe: () => ({ ok: false }) }, "dogfood_preflight_cli_model_incompatible");

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-auth-state-"));
try {
  fs.writeFileSync(path.join(fakeHome, "auth.json"), "{}\n", { mode: 0o600 });
  const home = preflight.validateInputs({ ...valid, mode: "codex_home", runnerEnvironment: "self-hosted", env: { CODEX_HOME: fakeHome, PATH: "" } });
  assert.equal(home.checks.authStatePresent, true);
  assert.equal(home.checks.authAccessVerified, false);
} finally { fs.rmSync(fakeHome, { recursive: true, force: true }); }

const diagnosticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-preflight-diagnostic-"));
try {
  const diagnostic = path.join(diagnosticRoot, "diagnostic.json");
  const secret = "credential-token-must-not-leak";
  const child = spawnSync(process.execPath, [path.join(__dirname, "dogfood-auth-preflight.cjs"),
    "--mode=api_key", "--model=gpt-5.6-luna", "--reasoning=none", "--account-alias=primary",
    "--runner-environment=github-hosted", "--runner-os=Linux", "--runner-arch=X64",
    "--approve-first-live-attempt", "--first-live-attempt-budget=1", "--check-runtime", `--output=${diagnostic}`],
  { encoding: "utf8", env: { PATH: "", CODEX_API_KEY: secret } });
  assert.notEqual(child.status, 0);
  const bytes = fs.readFileSync(diagnostic, "utf8");
  assert.equal(bytes.includes(secret), false);
  assert.equal(JSON.parse(bytes).paidModelCalls, 0);
} finally { fs.rmSync(diagnosticRoot, { recursive: true, force: true }); }

process.stdout.write(`${JSON.stringify({ ok: true, model: preflight.REQUIRED_MODEL, reasoning: preflight.REQUIRED_REASONING, quotaUnknownWhenUnqueryable: true, localAuthIsNotAccessProof: true, firstAttemptExplicitlyApprovedAndBudgeted: true, networkPoliciesSeparated: true, credentialSessionTokenLeakage: 0, externalProviderCalls: 0 }, null, 2)}\n`);
