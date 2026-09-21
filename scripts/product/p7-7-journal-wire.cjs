#!/usr/bin/env node
'use strict';
// One-shot guarded source integration. Removed once its generated source is
// committed and independently checked at the resulting source SHA.
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8'});
function replaceOnce(source, from, to, context) {
  const i = source.indexOf(from);
  assert(i >= 0 && source.indexOf(from, i + from.length) < 0, `Expected unique ${context}`);
  return source.slice(0,i) + to + source.slice(i+from.length);
}
function write(file, content) { fs.writeFileSync(file, content); git('add','--',file); }
let journal = fs.readFileSync('packages/integrations/src/durable-invocation-journal.ts','utf8');
journal = replaceOnce(journal,
  '      return transaction((db) => {\n        const key = keyOf(input);',
  '      const reservation = transaction((db) => {\n        const key = keyOf(input);', 'reservation transaction');
journal = replaceOnce(journal,
  '          throw new InvocationJournalError("invocation_replay_forbidden", "Provider invocation already reserved; no automatic replay.");',
  '          return null;', 'commit recovered unknown before duplicate rejection');
journal = replaceOnce(journal,
  '        return record;\n      });\n    },\n    start(key: string): InvocationRecord {',
  '        return record;\n      });\n      if (reservation === null) throw new InvocationJournalError("invocation_replay_forbidden", "Provider invocation already reserved; no automatic replay.");\n      return reservation;\n    },\n    start(key: string): InvocationRecord {', 'duplicate rejection after durable commit');
write('packages/integrations/src/durable-invocation-journal.ts',journal);
let adapter = fs.readFileSync('packages/integrations/src/codex-agent-adapter.ts','utf8');
adapter = replaceOnce(adapter,
  'import { fileURLToPath } from "node:url";',
  'import { fileURLToPath } from "node:url";\nimport os from "node:os";\nimport path from "node:path";\nimport { createDurableInvocationJournal, InvocationJournalError } from "./durable-invocation-journal.js";', 'journal import');
adapter = replaceOnce(adapter,
  '  workerForceGraceMs?: number;\n}>;',
  '  workerForceGraceMs?: number;\n  /** Parent-owned durable provider-call authority; never forwarded to the worker. */\n  invocationJournalPath?: string;\n}>;', 'adapter journal option');
adapter = replaceOnce(adapter,
  '  private readonly workerForceGraceMs: number;\n  private readonly now:',
  '  private readonly workerForceGraceMs: number;\n  private readonly invocationJournalPath: string | null;\n  private readonly now:', 'adapter journal field');
adapter = replaceOnce(adapter,
  '    this.workerForceGraceMs = options.workerForceGraceMs ?? DEFAULT_AGENT_WORKER_FORCE_GRACE_MS;\n    this.now = options.now ?? Date.now;',
  '    this.workerForceGraceMs = options.workerForceGraceMs ?? DEFAULT_AGENT_WORKER_FORCE_GRACE_MS;\n    const configuredJournal = options.invocationJournalPath ?? environmentSource.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH;\n    // Fakes are journal-free by default unless their test provides a path. All\n    // real SDK invocations have a persistent parent-owned journal.\n    this.invocationJournalPath = configuredJournal ?? (options.clientFactory || options.workerEntrypoint\n      ? null : path.join(environmentSource.HOME || os.homedir(), ".bounded-agent", "provider-invocations.sqlite"));\n    this.now = options.now ?? Date.now;', 'real adapter durable journal default');
adapter = replaceOnce(adapter,
  '    const threadOptions: ThreadOptions = {',
  `    // Reserve and durably mark a possibly chargeable invocation BEFORE the\n    // real SDK or isolated worker can start. No local preflight proves quota.\n    let invocationJournal: ReturnType<typeof createDurableInvocationJournal> | null = null;\n    let invocationKey: string | null = null;\n    try {\n      if (this.invocationJournalPath !== null) {\n        invocationJournal = createDurableInvocationJournal(this.invocationJournalPath);\n        const reservation = invocationJournal.reserve({\n          runId: request.runId, stage: request.mode, task: request.task,\n          model: request.model, deadlineAt: this.now() + processControl.limits.totalTimeoutMs\n        });\n        invocationKey = reservation.invocationKey;\n        invocationJournal.start(invocationKey);\n      }\n    } catch (error) {\n      if (invocationJournal !== null && invocationKey !== null) {\n        try { invocationJournal.recover(invocationKey); } catch { /* Deny even if recovery cannot be persisted. */ }\n      }\n      processControl.close();\n      const code = error instanceof InvocationJournalError ? error.code : "invocation_journal_unavailable";\n      return emptyResult(request, "rejected", Math.max(0, this.now() - startedAtMs), [\n        diagnostic(code, "error", code)\n      ], code);\n    }\n\n    const threadOptions: ThreadOptions = {`, 'durable invocation call-boundary reservation');
adapter = replaceOnce(adapter,
  '    return {\n      status: providerFailure !== null && finalTermination === "none"',
  `    if (invocationJournal !== null && invocationKey !== null) {\n      const successObserved = finalTermination === "none" && processFailure === null &&\n        providerFailure === null && parsed.status === "completed";\n      const knownFailure = providerFailure === "authentication_failed" || providerFailure === "usage_limit_exceeded";\n      const lifecycle = processControl.lifecycle();\n      try {\n        invocationJournal.finish(invocationKey, successObserved ? "completed" :\n          knownFailure ? "failed" : "outcome_unknown", {\n            failureCode: processFailure?.code ?? providerFailure ??\n              (successObserved ? null : "provider_outcome_ambiguous"),\n            abortRequestedAt: lifecycle.abortRequestedAt,\n            workerExitedAt: lifecycle.workerExitedAt,\n            exitSignal: lifecycle.exitSignal,\n            sessionEvidence: "unknown"\n          });\n      } catch {\n        return emptyResult(request, "failed", Math.max(0, this.now() - startedAtMs), [\n          diagnostic("invocation_journal_unavailable", "error", "invocation_journal_unavailable")\n        ], "invocation_journal_unavailable");\n      }\n    }\n\n    return {\n      status: providerFailure !== null && finalTermination === "none"`, 'terminal journal finalization before successful return');
write('packages/integrations/src/codex-agent-adapter.ts',adapter);
let processControl = fs.readFileSync('packages/integrations/src/agent-process-control.ts','utf8');
processControl = replaceOnce(processControl,
  '  | "worker_termination_failed";',
  '  | "worker_termination_failed"\n  | "invocation_replay_forbidden"\n  | "invocation_journal_unavailable";', 'provider journal failures');
write('packages/integrations/src/agent-process-control.ts',processControl);
let gate = fs.readFileSync('apps/cli/src/commands/codex-compare-provider-gate.ts','utf8');
gate = replaceOnce(gate,
  '  "provider_outcome_ambiguous", "worker_termination_failed"',
  '  "provider_outcome_ambiguous", "worker_termination_failed",\n  "invocation_replay_forbidden", "invocation_journal_unavailable"', 'stop on journal failure without provider reclassification');
write('apps/cli/src/commands/codex-compare-provider-gate.ts',gate);
let compare = fs.readFileSync('apps/cli/src/commands/compare.ts','utf8');
compare = replaceOnce(compare,
  'const P7_7_TERMINAL_FAILURES = new Set(["provider_outcome_ambiguous", "worker_termination_failed"]);',
  'const P7_7_TERMINAL_FAILURES = new Set(["provider_outcome_ambiguous", "worker_termination_failed",\n  "invocation_replay_forbidden", "invocation_journal_unavailable"]);', 'compare journal terminal');
compare = replaceOnce(compare,
  '  const discoveryDurationMs = Math.max(0, Date.now() - discoveryStarted);',
  `  if (discoveryFailure !== null && P7_7_TERMINAL_FAILURES.has(discoveryFailure.failureCode)) {\n    // A possibly charged discovery must never be followed by either arm.\n    throw new CliError(discoveryFailure.failureCode, "Discovery invocation outcome blocks further provider calls.", 4);\n  }\n  const discoveryDurationMs = Math.max(0, Date.now() - discoveryStarted);`, 'discovery failure stop');
write('apps/cli/src/commands/compare.ts',compare);
let dogfood = fs.readFileSync('benchmarks/product-v1/dogfood-resumable-runner.cjs','utf8');
dogfood = replaceOnce(dogfood,
  '    const child = run(process.execPath, [\n      canonicalRunner,',
  '    const child = run(process.execPath, [\n      canonicalRunner,', 'runner call anchor');
dogfood = replaceOnce(dogfood,
  '      `--task-id=${task.taskId}`\n    ]);',
  '      `--task-id=${task.taskId}`\n    ], { env: { ...process.env, BOUNDED_CODEX_INVOCATION_JOURNAL_PATH: `${checkpointFile}.invocations.sqlite` } });', 'single persistent journal per resume checkpoint');
write('benchmarks/product-v1/dogfood-resumable-runner.cjs',dogfood);
git('diff','--cached','--check');
process.stdout.write(JSON.stringify({ok:true,sourceFilesStaged:6,noProviderCalls:true})+'\n');
