#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
function patch(file, oldText, newText) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, "utf8");
  const first = text.indexOf(oldText);
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`P7.7 exact-match patch missing or ambiguous: ${file}`);
  }
  fs.writeFileSync(full, text.slice(0, first) + newText + text.slice(first + oldText.length));
}
const control = "packages/integrations/src/agent-process-control.ts";
patch(control,
  '  | "agent_model_call_budget_exceeded";',
  '  | "agent_model_call_budget_exceeded"\n  | "provider_outcome_ambiguous"\n  | "worker_termination_failed";');
patch(control,
  '  failure(): AgentProcessFailure | null;\n  usage(): AgentProcessBudgetUsage;',
  '  failure(): AgentProcessFailure | null;\n  timeline(): Readonly<{ deadlineTriggeredAt: number | null; abortRequestedAt: number | null }>;\n  usage(): AgentProcessBudgetUsage;');
patch(control,
  '  let processFailure: AgentProcessFailure | null = null;\n  let closed = false;',
  '  let processFailure: AgentProcessFailure | null = null;\n  let deadlineTriggeredAt: number | null = null;\n  let abortRequestedAt: number | null = null;\n  let closed = false;');
patch(control,
  '      processFailure = Object.freeze({ code, message });\n      controller.abort(new AgentProcessControlError(code, message));',
  '      processFailure = Object.freeze({ code, message });\n      abortRequestedAt ??= Date.now();\n      controller.abort(new AgentProcessControlError(code, message));');
patch(control,
  '    if (!controller.signal.aborted) controller.abort(input.parentSignal?.reason);',
  '    if (!controller.signal.aborted) {\n      abortRequestedAt ??= Date.now();\n      controller.abort(input.parentSignal?.reason);\n    }');
patch(control,
  '    if (closed || controller.signal.aborted) return;\n    setFailure(\n      "agent_timeout",',
  '    if (closed || controller.signal.aborted) return;\n    deadlineTriggeredAt = Date.now();\n    setFailure(\n      "agent_timeout",');
patch(control,
  '    failure() {\n      return processFailure;\n    },',
  '    failure() {\n      return processFailure;\n    },\n    timeline() {\n      return Object.freeze({ deadlineTriggeredAt, abortRequestedAt });\n    },');

const adapterType = "packages/integrations/src/agent-adapter.ts";
patch(adapterType,
  '} from "./agent-process-control.js";',
  '} from "./agent-process-control.js";\nimport type { AgentWorkerLifecycle } from "./isolated-agent-worker.js";');
patch(adapterType,
  '  diagnostics: AgentDiagnostic[];\n}',
  '  diagnostics: AgentDiagnostic[];\n  /** Non-secret timestamps and confirmed worker exit, or absent for legacy fakes. */\n  workerLifecycle?: AgentWorkerLifecycle;\n}');

const adapter = "packages/integrations/src/codex-agent-adapter.ts";
patch(adapter,
  'import {\n  Codex,',
  'import { fileURLToPath } from "node:url";\nimport {\n  Codex,');
patch(adapter,
  'import {\n  CodexProviderAccessGate,',
  'import { runIsolatedAgentWorker, type AgentWorkerLifecycle } from "./isolated-agent-worker.js";\nimport {\n  CodexProviderAccessGate,');
patch(adapter,
  '  private readonly providerGate: CodexProviderAccessGate;\n',
  '  private readonly providerGate: CodexProviderAccessGate;\n  private readonly isolatedWorker: boolean;\n  private readonly workerEnvironment: NodeJS.ProcessEnv;\n');
patch(adapter,
  '    this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));\n    this.now = options.now ?? Date.now;',
  '    this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));\n    this.isolatedWorker = options.clientFactory === undefined;\n    this.workerEnvironment = { ...environment };\n    this.now = options.now ?? Date.now;');
patch(adapter,
  '    let providerFailure: CodexProviderFailureCode | null = null;\n\n    try {\n      const client = this.clientFactory();\n      const thread = client.startThread(threadOptions);\n      const streamed = await thread.runStreamed(request.task, turnOptions);\n      for await (const event of streamed.events) {\n        processControl.observeEvent();\n        const serialized = serializeStreamEvent(event);\n        processControl.observeStdout(serialized);\n        observeCommandTiming(event, this.now(), commandTimings, processControl);\n        lines.push(serialized);\n      }\n    } catch (error) {',
  `    let providerFailure: CodexProviderFailureCode | null = null;
    let lifecycleFailure: "provider_outcome_ambiguous" | "worker_termination_failed" | null = null;
    let workerLifecycle: AgentWorkerLifecycle | undefined;
    const observeEvent = (event: unknown): void => {
      processControl.observeEvent();
      const serialized = serializeStreamEvent(event);
      processControl.observeStdout(serialized);
      observeCommandTiming(event, this.now(), commandTimings, processControl);
      lines.push(serialized);
    };

    try {
      if (this.isolatedWorker) {
        const worker = await runIsolatedAgentWorker({
          workerPath: fileURLToPath(new URL("./codex-sdk-worker.js", import.meta.url)),
          environment: this.workerEnvironment,
          payload: { task: request.task, threadOptions, outputSchema: request.outputSchema },
          signal: processControl.signal,
          deadlineTriggeredAt: () => processControl.timeline().deadlineTriggeredAt,
          onEvent: observeEvent
        });
        workerLifecycle = worker.lifecycle;
        if (worker.failureCode === "provider_outcome_ambiguous" ||
            worker.failureCode === "worker_termination_failed") {
          lifecycleFailure = worker.failureCode;
        } else if (worker.failureCode !== null) {
          providerFailure = this.providerGate.observe({ code: worker.failureCode });
        }
      } else {
        // Explicit clientFactory is test-only: no live SDK instance is created here.
        const client = this.clientFactory();
        const thread = client.startThread(threadOptions);
        const streamed = await thread.runStreamed(request.task, turnOptions);
        for await (const event of streamed.events) observeEvent(event);
      }
    } catch (error) {`);
patch(adapter,
  '    const finalTermination: RunTermination = processFailure?.code === "agent_timeout"',
  '    const finalTermination: RunTermination = lifecycleFailure === "worker_termination_failed"\n      ? "budget_failed" : processFailure?.code === "agent_timeout"');
patch(adapter,
  '        processFailure.code === "agent_timeout"));',
  '        false));');
patch(adapter,
  '    const diagnostics: AgentDiagnostic[] = [',
  '    if (lifecycleFailure !== null) {\n      adapterDiagnostics.push(diagnostic(lifecycleFailure, "error", lifecycleFailure, false));\n    }\n    const diagnostics: AgentDiagnostic[] = [');
patch(adapter,
  '      status: providerFailure !== null && finalTermination === "none"\n        ? "failed" : mapRunStatus(parsed, finalTermination),\n      failureCode: processFailure?.code ?? providerFailure,',
  '      status: (providerFailure !== null || lifecycleFailure !== null) && finalTermination === "none"\n        ? "failed" : mapRunStatus(parsed, finalTermination),\n      failureCode: lifecycleFailure ?? processFailure?.code ?? providerFailure,');
patch(adapter,
  '      fileChanges: mapFileChanges(parsed),\n      diagnostics\n',
  '      fileChanges: mapFileChanges(parsed),\n      diagnostics,\n      ...(workerLifecycle ? { workerLifecycle } : {})\n');

const gate = "apps/cli/src/commands/codex-compare-provider-gate.ts";
patch(gate,
  '  | "provider_stream_error_unknown" | "provider_identity_changed";',
  '  | "provider_stream_error_unknown" | "provider_identity_changed"\n  | "provider_outcome_ambiguous" | "worker_termination_failed";');
patch(gate,
  '  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown"\n]);',
  '  "usage_limit_exceeded", "authentication_failed", "provider_overloaded", "provider_stream_error_unknown",\n  "provider_outcome_ambiguous", "worker_termination_failed"\n]);');
patch(gate,
  '        if (result.status === "failed" || (result.status === "rejected" && result.failureCode)) {\n          const code = result.failureCode && FAILURE_CODES.has(result.failureCode)\n            ? result.failureCode as CompareProviderStopCode\n            : "provider_stream_error_unknown";',
  '        if (result.status !== "completed" || result.workerLifecycle?.workerTerminationVerified === false) {\n          const code = result.failureCode && FAILURE_CODES.has(result.failureCode)\n            ? result.failureCode as CompareProviderStopCode\n            : "provider_outcome_ambiguous";');

const compare = "apps/cli/src/commands/compare.ts";
patch(compare,
  'type ArmRuntimeObservation = Readonly<{\n  status: string;\n  failureCode: string | null;\n  validationFailureCode: string | null;\n}>;',
  'type ArmRuntimeObservation = Readonly<{\n  status: string;\n  failureCode: string | null;\n  validationFailureCode: string | null;\n  workerLifecycle: AgentRunResult["workerLifecycle"] | null;\n}>;');
patch(compare,
  '      validationFailureCode: input.validation.infrastructureFailure?.code ?? null\n',
  '      validationFailureCode: input.validation.infrastructureFailure?.code ?? null,\n      workerLifecycle: input.runs.at(-1)?.workerLifecycle ?? null\n');

console.log("P7.7 exact-match TypeScript integration applied");
