#!/usr/bin/env node
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}
async function main() {
  const journalPath = option("--journal");
  const priorRunId = option("--prior-run-id");
  const decisionId = option("--decision-id");
  const output = option("--output");
  if (!journalPath || !path.isAbsolute(journalPath) || !priorRunId || !decisionId ||
      !output || !path.isAbsolute(output) || process.argv.length !== 10) {
    throw Error("Usage: authorize-codex-discovery-retry --journal <absolute-sqlite> --prior-run-id <id> --decision-id <id> --output <absolute-json>");
  }
  const root = path.resolve(__dirname, "../..");
  const { createDurableInvocationJournal } = await import(pathToFileURL(path.join(
    root, "dist/packages/integrations/src/durable-invocation-journal.js")).href);
  const { deriveCodexScopeDiscoveryRetryRunId } = await import(pathToFileURL(path.join(
    root, "dist/apps/cli/src/providers/codex-scope-discovery.js")).href);
  const journal = createDurableInvocationJournal(journalPath);
  const key = "sha256:" + createHash("sha256").update(JSON.stringify([priorRunId, "discovery"])).digest("hex");
  const prior = journal.read(key);
  if (!prior || prior.runId !== priorRunId || prior.stage !== "discovery" ||
      prior.state !== "outcome_unknown") throw Error("Prior discovery invocation must be outcome_unknown.");
  const decision = {
    decisionId, supersedesRunId: priorRunId,
    newRunId: deriveCodexScopeDiscoveryRetryRunId(priorRunId, decisionId),
    stage: "discovery", taskHash: prior.taskHash, model: prior.model
  };
  const descriptor = fs.openSync(output, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(decision) + "\n");
    fs.closeSync(descriptor);
    journal.authorizeRetry(decision);
  } catch (error) {
    try { fs.closeSync(descriptor); } catch {}
    fs.rmSync(output, { force: true });
    throw error;
  }
  process.stdout.write(JSON.stringify({
    decisionId, supersedesRunId: priorRunId, newRunId: decision.newRunId,
    decisionFile: output, journal: journalPath
  }) + "\n");
}
main().catch((error) => { console.error(error.code ?? error.message); process.exitCode = 1; });
