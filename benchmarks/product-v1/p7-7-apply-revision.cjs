#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");

function file(name) { return path.join(root, name); }
function read(name) { return fs.readFileSync(file(name), "utf8"); }
function write(name, text) { fs.writeFileSync(file(name), text); }
function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`P7.7 patch anchor missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`P7.7 patch anchor duplicated: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function patchProcessControl() {
  const name = "packages/integrations/src/agent-process-control.ts";
  let text = read(name);
  text = replaceOnce(text,
`    markWorkerTerminationFailed(message = "Isolated agent worker could not be confirmed terminated.") {
      setFailure("worker_termination_failed", message);
    },`,
`    markWorkerTerminationFailed(message = "Isolated agent worker could not be confirmed terminated.") {
      // Termination failure supersedes the original timeout/budget reason: the worker is not confirmed dead.
      processFailure = Object.freeze({ code: "worker_termination_failed", message });
      requestAbort(new AgentProcessControlError("worker_termination_failed", message));
    },`, "termination failure precedence");
  write(name, text);
}

function patchAdapter() {
  const name = "packages/integrations/src/codex-agent-adapter.ts";
  let text = read(name);
  text = replaceOnce(text,
`import {
  Codex,
  type ModelReasoningEffort,
  type ThreadOptions,
  type TurnOptions
} from "@openai/codex-sdk";`,
`import { fileURLToPath } from "node:url";
import type {
  ModelReasoningEffort,
  ThreadOptions,
  TurnOptions
} from "@openai/codex-sdk";`, "adapter imports");
  text = replaceOnce(text,
`} from "./agent-process-control.js";
import {
  CodexProviderAccessGate,`,
`} from "./agent-process-control.js";
import {
  DEFAULT_AGENT_WORKER_FORCE_GRACE_MS,
  DEFAULT_AGENT_WORKER_GRACE_MS,
  runIsolatedAgentWorker
} from "./isolated-agent-worker.js";
import {
  CodexProviderAccessGate,`, "isolated worker import");
  text = replaceOnce(text,
`  /** Allows fake providers to supply a local, offline preflight in tests. */
  authCheck?: CodexLocalAuthCheck;
}>;`,
`  /** Allows fake providers to supply a local, offline preflight in tests. */
  authCheck?: CodexLocalAuthCheck;
  /** Offline fake-hang tests may substitute the worker entrypoint; live use keeps the bundled worker. */
  workerEntrypoint?: string;
  workerGraceMs?: number;
  workerForceGraceMs?: number;
}>;`, "adapter options");
  text = replaceOnce(text,
`  private readonly clientFactory: () => CodexSdkClientLike;
  private readonly now: () => number;
  private readonly redactor: AgentOutputRedactor;
  private readonly providerGate: CodexProviderAccessGate;`,
`  private readonly clientFactory: (() => CodexSdkClientLike) | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workerEntrypoint: string;
  private readonly workerGraceMs: number;
  private readonly workerForceGraceMs: number;
  private readonly now: () => number;
  private readonly redactor: AgentOutputRedactor;
  private readonly providerGate: CodexProviderAccessGate;`, "adapter fields");
  text = replaceOnce(text,
`    this.redactor = createAgentOutputRedactor({ environment: environmentSource });
    this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));
    this.now = options.now ?? Date.now;`,
`    this.redactor = createAgentOutputRedactor({ environment: environmentSource });
    this.clientFactory = options.clientFactory ?? null;
    this.environment = { ...environment };
    this.workerEntrypoint = options.workerEntrypoint ?? fileURLToPath(new URL("./codex-agent-worker.js", import.meta.url));
    this.workerGraceMs = options.workerGraceMs ?? DEFAULT_AGENT_WORKER_GRACE_MS;
    this.workerForceGraceMs = options.workerForceGraceMs ?? DEFAULT_AGENT_WORKER_FORCE_GRACE_MS;
    this.now = options.now ?? Date.now;`, "adapter constructor");
  text = replaceOnce(text,
`    let streamError: unknown = null;
    let providerFailure: CodexProviderFailureCode | null = null;

    try {
      const client = this.clientFactory();
      const thread = client.startThread(threadOptions);
      const streamed = await thread.runStreamed(request.task, turnOptions);
      for await (const event of streamed.events) {
        processControl.observeEvent();
        const serialized = serializeStreamEvent(event);
        processControl.observeStdout(serialized);
        observeCommandTiming(event, this.now(), commandTimings, processControl);
        lines.push(serialized);
      }
    } catch (error) {`,
`    let streamError: unknown = null;
    let providerFailure: CodexProviderFailureCode | "provider_outcome_ambiguous" | null = null;

    try {
      if (this.clientFactory !== null) {
        const client = this.clientFactory();
        const thread = client.startThread(threadOptions);
        const streamed = await thread.runStreamed(request.task, turnOptions);
        for await (const event of streamed.events) {
          processControl.observeEvent();
          const serialized = serializeStreamEvent(event);
          processControl.observeStdout(serialized);
          observeCommandTiming(event, this.now(), commandTimings, processControl);
          lines.push(serialized);
        }
      } else {
        const worker = await runIsolatedAgentWorker({
          command: process.execPath,
          args: [this.workerEntrypoint],
          cwd: request.workingDirectory,
          env: this.environment,
          stdin: JSON.stringify({
            protocolVersion: "codex-agent-worker/v1",
            task: request.task,
            threadOptions,
            outputSchema: request.outputSchema
          }),
          processControl,
          graceMs: this.workerGraceMs,
          forceGraceMs: this.workerForceGraceMs,
          onStdoutLine: (line) => {
            processControl.observeEvent();
            observeCommandTiming(line, this.now(), commandTimings, processControl);
            lines.push(line);
          }
        });
        if (!worker.terminationConfirmed && processControl.failure()?.code !== "worker_termination_failed") {
          processControl.markWorkerTerminationFailed();
        } else if (processControl.failure()?.code === "agent_timeout") {
          providerFailure = "provider_outcome_ambiguous";
        } else if (worker.exitCode !== 0 && processControl.failure() === null && !request.abortSignal?.aborted) {
          providerFailure = this.providerGate.observe(worker.stderr || { code: "provider_stream_error_unknown" });
          adapterDiagnostics.push(diagnostic(providerFailure, "error", providerFailure));
        }
      }
    } catch (error) {`, "adapter isolated execution");
  text = replaceOnce(text,
`      failureCode: processFailure?.code ?? providerFailure,
      quotaStatus: "unknown",
      agentId: CODEX_AGENT_ID,`,
`      failureCode: processFailure?.code === "agent_timeout"
        ? "provider_outcome_ambiguous"
        : processFailure?.code ?? providerFailure,
      quotaStatus: "unknown",
      workerLifecycle: this.clientFactory === null ? processControl.lifecycle() : null,
      agentId: CODEX_AGENT_ID,`, "adapter result lifecycle");
  write(name, text);
}

function patchCompare() {
  const name = "apps/cli/src/commands/compare.ts";
  let text = read(name);
  text = replaceOnce(text,
`export const BOUNDED_COMPARE_NETWORK_POLICY = "disabled" as const;

const MODEL =`,
`export const BOUNDED_COMPARE_NETWORK_POLICY = "disabled" as const;
const P7_7_TERMINAL_FAILURES = new Set(["provider_outcome_ambiguous", "worker_termination_failed"]);

const MODEL =`, "compare terminal set");
  text = replaceOnce(text,
`  providerFailureCode: string | null;
  executionOrder: ComparativeAgentExecutionOrder;`,
`  providerFailureCode: string | null;
  terminalFailureCode: string | null;
  executionOrder: ComparativeAgentExecutionOrder;`, "compare output field");
  text = replaceOnce(text,
`  let normalExecution: ArmExecution | null = null;
  let boundedExecution: ArmExecution | null = null;
  try {
    for (const arm of executionOrder) {`,
`  let normalExecution: ArmExecution | null = null;
  let boundedExecution: ArmExecution | null = null;
  let terminalFailureCode: string | null = null;
  try {
    for (const arm of executionOrder) {`, "compare terminal state");
  text = replaceOnce(text,
`      if (providerGate?.stoppedCode()) break;`,
`      if (providerGate?.stoppedCode() || terminalFailureCode !== null) break;`, "compare stop check");
  text = replaceOnce(text,
`        normalExecution = evaluateArm({
          runtimeCompleted: run.status === "completed",
          runtimeStatus: run.status,
          runtimeFailureCode,
          validation,
          changedFiles: files,
          approvedMutableFiles,
          controlAvailable: discovery !== null,
          forbiddenFiles,
          runs: [run],
          exposedFiles: baselineWorkspace.exposedFileCount,
          exposedBytes: baselineWorkspace.exposedBytes,
          repairRounds: 0,
          durationMs: Math.max(0, Date.now() - started - validation.durationMs)
        });
        continue;`,
`        normalExecution = evaluateArm({
          runtimeCompleted: run.status === "completed",
          runtimeStatus: run.status,
          runtimeFailureCode,
          validation,
          changedFiles: files,
          approvedMutableFiles,
          controlAvailable: discovery !== null,
          forbiddenFiles,
          runs: [run],
          exposedFiles: baselineWorkspace.exposedFileCount,
          exposedBytes: baselineWorkspace.exposedBytes,
          repairRounds: 0,
          durationMs: Math.max(0, Date.now() - started - validation.durationMs)
        });
        if (runtimeFailureCode !== null && P7_7_TERMINAL_FAILURES.has(runtimeFailureCode)) {
          terminalFailureCode = runtimeFailureCode;
          break;
        }
        continue;`, "compare baseline stop");
  text = replaceOnce(text,
`      boundedExecution = evaluateArm({
        runtimeCompleted: boundedCandidateReady,
        runtimeStatus: boundedResult?.decision ?? (boundedFailureCode === null ? "not_run" : "failed"),
        runtimeFailureCode: boundedFailureCode,
        validation,
        changedFiles: boundedChangedFiles,
        approvedMutableFiles,
        controlAvailable: discovery !== null,
        forbiddenFiles,
        runs: boundedRuns,
        additionalUsage: discoveryUsage ?? undefined,
        exposedFiles: Math.max(exposure.files, discoveryVisibleFileCount),
        exposedBytes: Math.max(exposure.bytes, discoveryVisibleBytes),
        repairRounds: 0,
        durationMs: Math.max(
          0,
          Date.now() - started - validation.durationMs + discoveryDurationMs
        )
      });`,
`      boundedExecution = evaluateArm({
        runtimeCompleted: boundedCandidateReady,
        runtimeStatus: boundedResult?.decision ?? (boundedFailureCode === null ? "not_run" : "failed"),
        runtimeFailureCode: boundedFailureCode,
        validation,
        changedFiles: boundedChangedFiles,
        approvedMutableFiles,
        controlAvailable: discovery !== null,
        forbiddenFiles,
        runs: boundedRuns,
        additionalUsage: discoveryUsage ?? undefined,
        exposedFiles: Math.max(exposure.files, discoveryVisibleFileCount),
        exposedBytes: Math.max(exposure.bytes, discoveryVisibleBytes),
        repairRounds: 0,
        durationMs: Math.max(
          0,
          Date.now() - started - validation.durationMs + discoveryDurationMs
        )
      });
      const boundedTerminal = boundedRuns.find((entry) =>
        typeof entry.failureCode === "string" && P7_7_TERMINAL_FAILURES.has(entry.failureCode)
      )?.failureCode ?? null;
      if (boundedTerminal !== null) {
        terminalFailureCode = boundedTerminal;
        break;
      }`, "compare bounded stop");
  text = replaceOnce(text,
`  const providerFailureCode = providerGate?.stoppedCode() ?? null;
  if (providerFailureCode !== null) {`,
`  const providerFailureCode = providerGate?.stoppedCode() ?? null;
  const stopFailureCode = providerFailureCode ?? terminalFailureCode;
  if (stopFailureCode !== null) {`, "compare stop code");
  text = replaceOnce(text,
`      runtimeFailureCode: providerFailureCode, validation: emptyValidation(),`,
`      runtimeFailureCode: stopFailureCode, validation: emptyValidation(),`, "compare blocked code");
  text = replaceOnce(text,
`  const comparable = comparison.comparable && providerFailureCode === null;`,
`  const comparable = comparison.comparable && stopFailureCode === null;`, "compare comparable");
  text = replaceOnce(text,
`    providerFailureCode,
    executionOrder,`,
`    providerFailureCode,
    terminalFailureCode: stopFailureCode,
    executionOrder,`, "compare output terminal");
  write(name, text);
}

function patchDogfood() {
  const name = "benchmarks/product-v1/dogfood-runner.cjs";
  let text = read(name);
  text = replaceOnce(text,
`const PROVIDER_FAILURES = new Set([
  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"
]);`,
`const PROVIDER_FAILURES = new Set([
  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"
]);
const TERMINAL_FAILURES = new Set([...PROVIDER_FAILURES, "provider_outcome_ambiguous", "worker_termination_failed"]);`, "dogfood terminal set");
  text = replaceOnce(text,
`    parsed?.failureCode,
    parsed?.providerCode
  ];
  for (const code of candidates) {
    if (typeof code === "string" && PROVIDER_FAILURES.has(code)) return code;`,
`    parsed?.failureCode,
    parsed?.providerCode,
    parsed?.terminalFailureCode
  ];
  for (const code of candidates) {
    if (typeof code === "string" && TERMINAL_FAILURES.has(code)) return code;`, "dogfood terminal extraction");
  text = replaceOnce(text,
`      if (providerCode !== null) {
        record.failure = redactedFailure(compare, access.observeFailure({ code: providerCode }));
        stoppedProviderCode = providerCode;`,
`      if (providerCode !== null) {
        const terminalCode = PROVIDER_FAILURES.has(providerCode)
          ? access.observeFailure({ code: providerCode })
          : providerCode;
        record.failure = redactedFailure(compare, terminalCode);
        stoppedProviderCode = terminalCode;`, "dogfood fail closed");
  write(name, text);
}

function patchResumable() {
  const name = "benchmarks/product-v1/dogfood-resumable-runner.cjs";
  let text = read(name);
  text = replaceOnce(text,
`const CHILD_TIMEOUT_MS = 60 * 60 * 1000;`,
`const CHILD_TIMEOUT_MS = 60 * 60 * 1000;
const PROVIDER_FAILURES = new Set([
  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"
]);`, "resumable provider set");
  text = replaceOnce(text,
`    if (terminalCode !== null) access.observeFailure({ code: terminalCode });`,
`    if (terminalCode !== null && PROVIDER_FAILURES.has(terminalCode)) access.observeFailure({ code: terminalCode });`, "resumable fail closed");
  write(name, text);
}

function patchProcessSmoke() {
  const name = "scripts/smoke/agent-process-control-smoke.cjs";
  let text = read(name);
  text = replaceOnce(text,
`  assert.equal(AGENT_PROCESS_CONTROL_VERSION, "agent-process-control/v1");`,
`  assert.equal(AGENT_PROCESS_CONTROL_VERSION, "agent-process-control/v2");`, "process smoke version");
  text = replaceOnce(text,
`  assert.equal(timeout.failure().code, "agent_timeout");
  assert.throws(`,
`  assert.equal(timeout.failure().code, "agent_timeout");
  const timeoutLifecycle = timeout.lifecycle();
  assert.equal(typeof timeoutLifecycle.deadlineTriggeredAt, "number");
  assert.equal(typeof timeoutLifecycle.abortRequestedAt, "number");
  assert.equal(timeoutLifecycle.workerExitedAt, null);
  assert.equal(timeoutLifecycle.forcedTermination, false);
  assert.throws(`, "process smoke lifecycle");
  write(name, text);
}

patchProcessControl();
patchAdapter();
patchCompare();
patchDogfood();
patchResumable();
patchProcessSmoke();
console.log("P7.7 revision applied");
