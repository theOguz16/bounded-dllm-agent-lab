#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
function edit(file, changes) {
  let text = fs.readFileSync(file, "utf8");
  for (const [before, after] of changes) {
    const index = text.indexOf(before);
    if (index < 0 || text.indexOf(before, index + before.length) >= 0) {
      throw new Error(`${file}: expected one match: ${before.slice(0, 75)}`);
    }
    text = text.slice(0, index) + after + text.slice(index + before.length);
  }
  fs.writeFileSync(file, text, "utf8");
}
edit("packages/integrations/src/codex-agent-adapter.ts", [
  ['case "none": return "minimal";', 'case "none": throw new Error("none is a Codex CLI override, not minimal reasoning");'],
  ['this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));', 'this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment }, config: { model_reasoning_effort: "none" } }));'],
  ['modelReasoningEffort: mapReasoningEffort(request.reasoningEffort),', '...(request.reasoningEffort === "none" ? {} : { modelReasoningEffort: mapReasoningEffort(request.reasoningEffort) }),'],
  ['adapterDiagnostics.push(diagnostic(providerFailure, "error", providerFailure));', 'adapterDiagnostics.push(diagnostic(providerFailure, "error", providerFailure));\n          if (this.redactor.redactText(message) !== message) {\n            adapterDiagnostics.push(diagnostic("codex_provider_message_redacted", "info", "[REDACTED]"));\n          }'],
  ['(entry) => entry.code === "codex_stream_error" || entry.code === "codex_turn_failed"', '(entry) => ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(entry.code)'],
  ['const candidate = this.providerGate.observe(entry.message);', 'const candidate = this.providerGate.observe({ code: entry.code === "codex_provider_auth" ? "authentication_failed" : entry.code === "codex_provider_quota" ? "usage_limit_exceeded" : entry.code === "codex_provider_capacity" ? "provider_overloaded" : entry.message });'],
  ['code: code === "codex_stream_error" || code === "codex_turn_failed"', 'code: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code)'],
  ['message: code === "codex_stream_error" || code === "codex_turn_failed"', 'message: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code)'],
  ['retryable: code === "codex_stream_error" || code === "codex_turn_failed" ?', 'retryable: ["codex_stream_error", "codex_turn_failed", "codex_provider_auth", "codex_provider_quota", "codex_provider_capacity"].includes(code) ?']
]);
edit("apps/cli/src/commands/codex-compare-provider-gate.ts", [
  ['reasoning !== "medium"', 'reasoning !== "none"']
]);
edit("apps/cli/src/commands/codex.ts", [
  ['  AgentAdapter,\n  AgentRunRequest,', '  AgentAdapter,\n  AgentReasoningEffort,\n  AgentRunRequest,'],
  ['export type CodexCommandDependencies = Readonly<{\n  adapter?: AgentAdapter;\n  model?: string;', 'export type CodexCommandDependencies = Readonly<{\n  adapter?: AgentAdapter;\n  model?: string;\n  reasoningEffort?: AgentReasoningEffort;'],
  ['plannerReasoningEffort: BOUNDED_CODEX_REASONING,\n    coderReasoningEffort: BOUNDED_CODEX_REASONING,', 'plannerReasoningEffort: dependencies.reasoningEffort ?? BOUNDED_CODEX_REASONING,\n    coderReasoningEffort: dependencies.reasoningEffort ?? BOUNDED_CODEX_REASONING,'],
  ['reasoning: BOUNDED_CODEX_REASONING,', 'reasoning: dependencies.reasoningEffort ?? BOUNDED_CODEX_REASONING,']
]);
edit("apps/cli/src/commands/compare.ts", [
  ['export const BOUNDED_COMPARE_REASONING = "medium" as const;', 'export const BOUNDED_COMPARE_REASONING = "none" as const;'],
  ['              adapter: boundedAdapter,\n              model,\n              validationProfile:', '              adapter: boundedAdapter,\n              model,\n              reasoningEffort: BOUNDED_COMPARE_REASONING,\n              validationProfile:'],
  ['      behaviorSatisfied: behavior,\n      taskSucceeded: succeeded,', '      taskSucceeded: succeeded === false ? false : null,'],
  ['      typecheckPassed: typecheck\n    },\n    control: {', '      typecheckPassed: typecheck\n    },\n    behaviorEvidence: null,\n    control: {']
]);
for (const file of ["benchmarks/product-v1/p7-6-compare-provider-smoke.cjs", "benchmarks/product-v1/p7-6-compare-command-smoke.cjs"]) {
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes('"medium"')) throw new Error(`${file}: old reasoning fixture absent`);
  fs.writeFileSync(file, original.replaceAll('"medium"', '"none"'), "utf8");
}
console.log("P7.6 isolated verified patch prepared without provider access");
