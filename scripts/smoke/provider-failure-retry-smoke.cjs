#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const moduleUrl = (file) => pathToFileURL(path.join(root, "dist/packages/integrations/src", file)).href;
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "provider-failure-retry-"));
const input = (runId, task = "offline synthetic request", stage = "discovery", model = "offline-model") =>
  ({ runId, task, stage, model, deadlineAt: Date.now() + 30_000 });
const decision = (decisionId, supersedesRunId, newRunId, task = "offline synthetic request",
  stage = "discovery", model = "offline-model") =>
  ({ decisionId, supersedesRunId, newRunId, stage, taskHash: hash(task), model });
const readJson = (file, runId) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT record_json FROM provider_invocations WHERE run_id = ?").get(runId);
    return row ? JSON.parse(row.record_json) : null;
  } finally { db.close(); }
};
(async () => {
  const { createDurableInvocationJournal } = await import(moduleUrl("durable-invocation-journal.js"));
  const { CodexAgentAdapter } = await import(moduleUrl("codex-agent-adapter.js"));
  const { createWorkerFailureDiagnostic } = await import(moduleUrl("worker-failure-diagnostic.js"));
  const { createAgentOutputRedactor } = await import(moduleUrl("agent-output-redaction.js"));
  const journalFile = path.join(temp, "retry.sqlite");
  const journal = createDurableInvocationJournal(journalFile);
  const original = journal.reserve(input("prior.unknown"));
  journal.start(original.invocationKey);
  journal.finish(original.invocationKey, "outcome_unknown", { failureCode: "provider_stream_error_unknown" });
  const priorBytes = JSON.stringify(journal.read(original.invocationKey));
  assert.throws(() => journal.reserve(input("new.without.decision")), { code: "invocation_replay_forbidden" });
  const approved = decision("operator.one", "prior.unknown", "new.approved");
  assert.throws(() => journal.reserve({ ...input("new.approved"), retryDecision: approved }),
    { code: "invocation_replay_forbidden" }, "fabricated decision is rejected");
  for (const wrong of [
    decision("wrong.prior", "missing", "new.x"),
    decision("wrong.task", "prior.unknown", "new.x", "different task"),
    decision("wrong.stage", "prior.unknown", "new.x", undefined, "planner"),
    decision("wrong.model", "prior.unknown", "new.x", undefined, "discovery", "other-model")
  ]) assert.throws(() => journal.authorizeRetry(wrong), { code: "invocation_replay_forbidden" });
  journal.authorizeRetry(approved);
  assert.throws(() => journal.authorizeRetry(approved), { code: "invocation_replay_forbidden" });
  for (const changed of [
    { ...approved, supersedesRunId: "wrong" },
    { ...approved, taskHash: hash("other task") },
    { ...approved, stage: "planner" },
    { ...approved, model: "other-model" },
    { ...approved, newRunId: "different-run" }
  ]) assert.throws(() => journal.reserve({ ...input("new.approved"), retryDecision: changed }),
    { code: "invocation_replay_forbidden" });
  const next = journal.reserve({ ...input("new.approved"), retryDecision: approved });
  assert.equal(next.state, "prepared");
  assert.equal(JSON.stringify(journal.read(original.invocationKey)), priorBytes, "prior row is immutable");
  assert.throws(() => journal.reserve({ ...input("new.again"), retryDecision: approved }),
    { code: "invocation_replay_forbidden" });
  journal.start(next.invocationKey);
  journal.finish(next.invocationKey, "completed");
  assert.throws(() => journal.authorizeRetry(decision("completed.retry", "new.approved", "new.other")),
    { code: "invocation_replay_forbidden" });
  const cleanFile = path.join(temp, "first.sqlite");
  assert.equal(createDurableInvocationJournal(cleanFile).reserve(input("first.attempt")).state, "prepared");
  const operatorFile = path.join(temp, "operator.sqlite");
  const operatorJournal = createDurableInvocationJournal(operatorFile);
  const operatorPrior = operatorJournal.reserve(input("operator.prior"));
  operatorJournal.start(operatorPrior.invocationKey);
  operatorJournal.finish(operatorPrior.invocationKey, "outcome_unknown");
  const decisionFile = path.join(temp, "operator-decision.json");
  const operator = spawnSync(process.execPath, [
    path.join(root, "scripts/product/authorize-codex-discovery-retry.cjs"),
    "--journal", operatorFile, "--prior-run-id", "operator.prior",
    "--decision-id", "operator.unique", "--output", decisionFile
  ], { encoding: "utf8" });
  assert.equal(operator.status, 0, operator.stderr);
  const operatorDecision = JSON.parse(fs.readFileSync(decisionFile, "utf8"));
  assert.equal(operatorDecision.taskHash, hash("offline synthetic request"));
  assert.equal(operatorJournal.reserve({
    ...input(operatorDecision.newRunId), retryDecision: operatorDecision
  }).state, "prepared");
  assert.equal(operatorJournal.read(operatorPrior.invocationKey).state, "outcome_unknown");
  const invalidCli = spawnSync(process.execPath, [
    path.join(root, "dist/apps/cli/src/index.js"),
    "codex", "offline task", "--retry-decision", path.join(temp, "missing-decision.json"), "--json"
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(invalidCli.status, 0);
  assert.match(invalidCli.stdout + invalidCli.stderr, /cli_codex_retry_decision_invalid/);

  const fakeWorker = path.join(temp, "fake-worker.cjs");
  const secret = "sk-12345678901234567890";
  const bearer = "Bearer fake-secret-token-123456";
  fs.writeFileSync(fakeWorker, [
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fake-thread"})+"\\n");',
    '  process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n");',
    '  process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"x",type:"agent_message",text:"MODEL_CONTENT_SECRET"}})+"\\n");',
    '  process.stdout.write("not-json MODEL_CONTENT_SECRET\\n");',
    '  process.stderr.write("Authorization: Bearer fake-secret-token-123456\\n");',
    '  process.stderr.write("key sk-12345678901234567890\\n");',
    '  process.stderr.write(JSON.stringify({code:"mystery",message:"offline failure"})+"\\n");',
    '  process.exitCode = 2;',
    '});'
  ].join("\n"));
  const adapterFile = path.join(temp, "worker.sqlite");
  const adapter = new CodexAgentAdapter({
    environment: { HOME: temp, PATH: process.env.PATH },
    authCheck: async () => true, workerEntrypoint: fakeWorker,
    invocationJournalPath: adapterFile
  });
  const result = await adapter.run({
    runId: "worker.failure", agentId: "codex", workingDirectory: temp,
    task: "offline fake process", model: "offline-model", reasoningEffort: "medium",
    mode: "discovery", timeoutMs: 10_000, networkAllowed: false,
    sandboxMode: "read_only", repositoryRequirement: "none"
  });
  assert.equal(result.failureCode, "provider_stream_error_unknown");
  assert.equal(result.workerExitCode, 2);
  const record = readJson(adapterFile, "worker.failure");
  assert.equal(record.state, "outcome_unknown");
  const evidence = record.workerDiagnostic;
  assert.equal(evidence.version, "worker-failure-diagnostic/v1");
  assert.equal(evidence.exitCode, 2);
  assert.equal(evidence.threadStarted, true);
  assert.equal(evidence.turnStarted, true);
  assert.equal(evidence.turnCompleted, false);
  assert.equal(evidence.malformedLineCount, 1);
  assert.equal(evidence.stdoutLineCount, 4);
  assert.equal(evidence.lastRecognizedEventType, "item.completed");
  assert.equal(evidence.parserStatus, "agent_protocol_invalid");
  assert.equal(evidence.stdoutEmpty, false);
  assert.equal(evidence.stderrEmpty, false);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 4096);
  assert.doesNotMatch(JSON.stringify(evidence), /MODEL_CONTENT_SECRET|sk-12345678901234567890|fake-secret-token-123456/);
  assert.match(evidence.stderrExcerpt, /\[REDACTED\]/);

  const redactor = createAgentOutputRedactor();
  const oversized = createWorkerFailureDiagnostic({
    executable: process.execPath, args: [fakeWorker], cwd: temp, redactor,
    worker: { exitCode: 2, exitSignal: null, stderr: "A".repeat(20_000),
      stdoutBytes: 0, stderrBytes: 20_000, stderrTruncated: false },
    stdoutLines: [], parserStatus: "partial", terminalTurnObserved: false
  });
  assert.equal(oversized.stderrExcerpt.length, 2048);
  assert.equal(oversized.stderrTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 4096);
  const truncated = createWorkerFailureDiagnostic({
    executable: process.execPath, args: [fakeWorker], cwd: temp, redactor,
    worker: { exitCode: 2, exitSignal: null, stderr: "sk-12345678901234567890".slice(0, 8),
      stdoutBytes: 0, stderrBytes: 20_000, stderrTruncated: true },
    stdoutLines: [], parserStatus: "partial", terminalTurnObserved: false
  });
  assert.equal(truncated.stderrExcerpt, "", "a raw capture truncated inside a secret is never persisted");
  const echoedTask = "synthetic prompt that must not be retained";
  const promptDiagnostic = createWorkerFailureDiagnostic({
    executable: process.execPath, args: [fakeWorker], cwd: temp, redactor, task: echoedTask,
    worker: { exitCode: 2, exitSignal: null, stderr: `worker rejected ${echoedTask}`,
      stdoutBytes: 0, stderrBytes: 128, stderrTruncated: false },
    stdoutLines: [], parserStatus: "partial", terminalTurnObserved: false
  });
  assert.doesNotMatch(JSON.stringify(promptDiagnostic), /synthetic prompt that must not be retained/);
  console.log("provider failure/retry PASS: bounded redacted evidence, partial/malformed metadata, one-use ambiguous authorization, zero real provider calls");
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
