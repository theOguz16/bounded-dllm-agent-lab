#!/usr/bin/env node
"use strict";
// One-shot, assertion-checked P7.6 fixup. It runs without provider credentials.
const fs = require("node:fs");
function edit(file, changes) {
  let text = fs.readFileSync(file, "utf8");
  for (const [before, after] of changes) {
    const first = text.indexOf(before);
    if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
      throw new Error(`${file}: expected exactly one match: ${before.slice(0, 70)}`);
    }
    text = text.slice(0, first) + after + text.slice(first + before.length);
  }
  fs.writeFileSync(file, text, "utf8");
}
const adapter = "packages/integrations/src/codex-agent-adapter.ts";
edit(adapter, [
  ['case "none": return "minimal";', 'case "none": throw new Error("none must be passed as a Codex CLI config override, not minimal reasoning");'],
  ['this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment } }));', 'this.clientFactory = options.clientFactory ?? (() => new Codex({ env: { ...environment }, config: { model_reasoning_effort: "none" } }));'],
  ['modelReasoningEffort: mapReasoningEffort(request.reasoningEffort),', '...(request.reasoningEffort === "none" ? {} : { modelReasoningEffort: mapReasoningEffort(request.reasoningEffort) }),'],
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
  ['import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";', 'import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";\nimport { CodexCompareProviderGate } from "./codex-compare-provider-gate.js";'],
  ['export type CompareCodexDependencies = Readonly<{\n  adapter?: AgentAdapter;', 'export type CompareCodexDependencies = Readonly<{\n  adapter?: AgentAdapter;\n  providerGate?: CodexCompareProviderGate;'],
  ['  const adapter = dependencies.adapter ?? new CodexAgentAdapter();', '  let providerGate: CodexCompareProviderGate | null;\n  try {\n    providerGate = dependencies.providerGate ??\n      (dependencies.adapter ? null : new CodexCompareProviderGate(model, BOUNDED_COMPARE_REASONING));\n    providerGate?.preflight();\n  } catch (error) {\n    const code = error && typeof error === "object" && "code" in error &&\n      typeof error.code === "string" ? error.code : "authentication_failed";\n    throw new CliError(code, "Local provider identity preflight failed; no invocation was reserved.", 5);\n  }\n  const rawAdapter = dependencies.adapter ?? new CodexAgentAdapter();\n  const adapter = providerGate ? providerGate.wrap(rawAdapter) : rawAdapter;'],
  ['    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS\n  });', '    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS,\n    ...(providerGate ? providerGate.identity : {})\n  });'],
  ['  const discoveryUsage =\n', '  const stoppedDuringDiscovery = providerGate?.stoppedCode() ?? null;\n  if (stoppedDuringDiscovery !== null ||\n      discoveryFailure?.failureCode === "codex_provider_auth" ||\n      discoveryFailure?.failureCode === "codex_provider_quota" ||\n      discoveryFailure?.failureCode === "authentication_failed" ||\n      discoveryFailure?.failureCode === "usage_limit_exceeded") {\n    throw new CliError(stoppedDuringDiscovery ?? discoveryFailure!.failureCode,\n      "Provider failed during scope discovery; no comparison arm may be invoked.", 4);\n  }\n\n  const discoveryUsage =\n'],
  ['    for (const arm of executionOrder) {\n', '    for (const arm of executionOrder) {\n      if (providerGate?.stoppedCode()) {\n        throw new CliError(providerGate.stoppedCode()!, "Provider circuit opened; no further arm invocation.", 4);\n      }\n'],
  ['if (code === "codex_provider_auth" || code === "codex_provider_quota") {', 'if (code === "codex_provider_auth" || code === "codex_provider_quota" ||\n        code === "authentication_failed" || code === "usage_limit_exceeded") {'],
  ['              adapter: boundedAdapter,\n              model,\n              validationProfile:', '              adapter: boundedAdapter,\n              model,\n              reasoningEffort: BOUNDED_COMPARE_REASONING,\n              validationProfile:']
]);
for (const file of ["benchmarks/product-v1/p7-6-compare-provider-smoke.cjs", "benchmarks/product-v1/p7-6-compare-command-smoke.cjs"]) {
  let text = fs.readFileSync(file, "utf8");
  text = text.replaceAll('"medium"', '"none"');
  fs.writeFileSync(file, text);
}
console.log("P7.6 exact Luna/none, provider circuit and discovery fixup applied (offline)");
