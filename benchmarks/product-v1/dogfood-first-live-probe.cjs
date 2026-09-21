#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REQUIRED_MODEL = "gpt-5.6-luna";
const REQUIRED_REASONING = "none";
const VERSION = "dogfood-first-live-probe/v1";
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertPreflight(preflight, accountAlias) {
  if (!preflight || preflight.ok !== true || preflight.model !== REQUIRED_MODEL ||
      preflight.reasoning !== REQUIRED_REASONING || preflight.accountAlias !== accountAlias ||
      !ALIAS.test(accountAlias || "") ||
      preflight.providerEndpoint?.firstAttemptApproved !== true ||
      preflight.providerEndpoint?.invocationBudget !== 1 ||
      preflight.providerEndpoint?.access !== "unverified" ||
      preflight.quota?.status !== "unknown" ||
      preflight.checks?.cliModelReasoningCompatible !== true) {
    throw new Error("First-live probe requires a matching, approved, exact Luna/none runtime preflight.");
  }
}

function persist(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * This reserves one application-level SDK turn before contacting the provider.
 * It does not claim knowledge of internal SDK HTTP retries or remaining quota.
 * A crash after reservation remains unknown, never automatically replayed.
 */
async function runProbe({ adapter, preflight, output, accountAlias, githubRunId, githubRunAttempt,
  repositoryRoot, now = () => new Date() }) {
  assertPreflight(preflight, accountAlias);
  if (!/^[0-9]+$/.test(String(githubRunId || "")) || Number(githubRunAttempt) !== 1) {
    throw new Error("First-live access requires a new explicitly approved workflow_dispatch run; reruns are forbidden.");
  }
  if (typeof output !== "string" || !path.isAbsolute(output) || output.includes("\0")) {
    throw new Error("First-live receipt requires an absolute output path.");
  }
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error("First-live probe requires an absolute repository root.");
  }
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const startedAt = now().toISOString();
  // Exclusive reservation is written before any provider SDK call. Never remove it
  // on errors: a lost stream or crash cannot justify automatic replay.
  persist(`${output}.reservation.json`, {
    schemaVersion: VERSION, runId: String(githubRunId), accountAlias,
    model: REQUIRED_MODEL, reasoning: REQUIRED_REASONING, reservedAt: startedAt,
    maximumAdapterTurnAttempts: 1, state: "outcome_unknown_until_receipt"
  });
  let outcome = "outcome_unknown";
  let errorCode = "provider_stream_error_unknown";
  try {
    const result = await adapter.run({
      runId: `first-live-${githubRunId}`,
      agentId: "codex",
      workingDirectory: repositoryRoot,
      task: "Return exactly OK. Do not read, modify, or execute repository files or tools.",
      model: REQUIRED_MODEL,
      reasoningEffort: REQUIRED_REASONING,
      mode: "discovery",
      timeoutMs: 60_000,
      processBudget: { maxProviderCalls: 1, maxModelCalls: 1, maxCommands: 0 },
      networkAllowed: false,
      sandboxMode: "read_only"
    });
    if (result?.status === "completed" && result?.modelId === REQUIRED_MODEL &&
        Array.isArray(result.commands) && result.commands.length === 0 &&
        Array.isArray(result.fileChanges) && result.fileChanges.length === 0) {
      outcome = "access_observed";
      errorCode = null;
    } else {
      const known = new Set(["authentication_failed", "usage_limit_exceeded", "provider_overloaded", "provider_stream_error_unknown"]);
      errorCode = known.has(result?.failureCode) ? result.failureCode : "provider_stream_error_unknown";
    }
  } catch {
    // Raw exceptions and credentials must never enter the receipt or CI output.
  }
  const receipt = {
    schemaVersion: VERSION, runId: String(githubRunId), accountAlias,
    model: REQUIRED_MODEL, reasoning: REQUIRED_REASONING,
    startedAt, finishedAt: now().toISOString(),
    sdkTurnAttemptsReserved: 1, sdkTurnAttemptsMade: 1,
    internalProviderHttpAttempts: null, quota: { status: "unknown" },
    outcome, errorCode, automaticRetry: false
  };
  persist(output, receipt);
  return Object.freeze(receipt);
}

async function main() {
  const [preflightPath, output] = process.argv.slice(2);
  if (!preflightPath || !output) throw new Error("Usage: dogfood-first-live-probe.cjs PREFLIGHT_JSON ABSOLUTE_RECEIPT_JSON");
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("First-live access is permitted only by an explicit workflow_dispatch.");
  }
  const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  const repoRoot = path.resolve(__dirname, "../..");
  const { CodexAgentAdapter } = await import(pathToFileURL(
    path.join(repoRoot, "dist/packages/integrations/src/codex-agent-adapter.js")
  ).href);
  const receipt = await runProbe({ adapter: new CodexAgentAdapter(), preflight,
    output, accountAlias: process.env.DOGFOOD_ACCOUNT_ALIAS,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    repositoryRoot: repoRoot });
  process.stdout.write(JSON.stringify({ schemaVersion: VERSION, outcome: receipt.outcome,
    errorCode: receipt.errorCode, sdkTurnAttemptsReserved: 1,
    quota: { status: "unknown" } }) + "\n");
  if (receipt.outcome !== "access_observed") process.exitCode = 1;
}

module.exports = { VERSION, REQUIRED_MODEL, assertPreflight, runProbe };
if (require.main === module) main().catch(() => {
  console.error("First-live probe blocked; no automatic retry is permitted.");
  process.exitCode = 1;
});
