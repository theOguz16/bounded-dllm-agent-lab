#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runProbe, VERSION } = require("./dogfood-first-live-probe.cjs");

function preflight() {
  return { ok: true, model: "gpt-5.6-luna", reasoning: "none", accountAlias: "test-alias",
    providerEndpoint: { firstAttemptApproved: true, invocationBudget: 1, access: "unverified" },
    quota: { status: "unknown" }, checks: { cliModelReasoningCompatible: true } };
}
function options(dir, adapter, overrides = {}) {
  return { adapter, preflight: preflight(), output: path.join(dir, "probe.json"),
    accountAlias: "test-alias", githubRunId: "12345", githubRunAttempt: "1",
    repositoryRoot: dir, ...overrides };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7-6-first-live-probe-"));
  try {
    let calls = 0;
    const fake = { async run(request) {
      calls += 1;
      assert.equal(request.model, "gpt-5.6-luna");
      assert.equal(request.reasoningEffort, "none");
      assert.equal(request.networkAllowed, false);
      assert.equal(request.sandboxMode, "read_only");
      assert.equal(request.processBudget.maxProviderCalls, 1);
      assert.equal(request.processBudget.maxCommands, 0);
      return { status: "completed", modelId: request.model, commands: [], fileChanges: [] };
    } };
    const first = await runProbe(options(root, fake));
    assert.equal(first.schemaVersion, VERSION);
    assert.equal(first.outcome, "access_observed");
    assert.equal(first.sdkTurnAttemptsReserved, 1);
    assert.equal(first.internalProviderHttpAttempts, null);
    assert.equal(first.quota.status, "unknown");
    assert.equal(calls, 1);
    assert.throws(() => fs.openSync(path.join(root, "probe.json.reservation.json"), "wx"));
    await assert.rejects(() => runProbe(options(root, fake)), /EEXIST/);
    assert.equal(calls, 1, "a second invocation is forbidden even after success");

    for (const [name, overrides] of [
      ["unapproved", { preflight: { ...preflight(), providerEndpoint: { firstAttemptApproved: false, invocationBudget: 1, access: "unverified" } } }],
      ["wrong-model", { preflight: { ...preflight(), model: "gpt-5.6-sol" } }],
      ["wrong-reasoning", { preflight: { ...preflight(), reasoning: "minimal" } }],
      ["wrong-alias", { accountAlias: "other" }],
      ["second-run-attempt", { githubRunAttempt: "2" }],
      ["quota-guessed", { preflight: { ...preflight(), quota: { status: "available" } } }]
    ]) {
      await assert.rejects(() => runProbe(options(path.join(root, name), fake, overrides)));
      assert.equal(calls, 1, `${name} must not reach provider`);
    }

    const failedDir = path.join(root, "failure");
    const sentinel = "secret-should-never-be-persisted";
    const broken = { async run() { calls += 1; throw new Error(sentinel); } };
    const failed = await runProbe(options(failedDir, broken));
    assert.equal(failed.outcome, "outcome_unknown");
    assert.equal(failed.errorCode, "provider_stream_error_unknown");
    assert.equal(fs.readFileSync(path.join(failedDir, "probe.json"), "utf8").includes(sentinel), false);
    await assert.rejects(() => runProbe(options(failedDir, broken)), /EEXIST/);
    assert.equal(calls, 2, "ambiguous provider error must not be replayed");
    console.log(JSON.stringify({ ok: true, contract: VERSION, firstTurnBudget: 1,
      replayForbidden: true, unknownPreserved: true, secretRedaction: true, paidCalls: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
