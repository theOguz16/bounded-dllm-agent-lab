#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const changed = [];
function replace(file, before, after, count = 1) {
  const absolute = path.join(root, file);
  const original = fs.readFileSync(absolute, "utf8");
  const parts = original.split(before);
  if (parts.length !== count + 1) throw new Error(`${file}: expected ${count} anchor(s), found ${parts.length - 1}`);
  fs.writeFileSync(absolute, parts.join(after), "utf8");
  if (!changed.includes(file)) changed.push(file);
}
const gate = "apps/cli/src/commands/codex-compare-provider-gate.ts";
replace(gate, 'reasoning !== "medium"', 'reasoning !== "none"');
replace(gate,
  '        if (result.status === "failed" || (result.status === "rejected" && result.failureCode)) {\n          const code = result.failureCode && FAILURE_CODES.has(result.failureCode)\n            ? result.failureCode as CompareProviderStopCode\n            : "provider_stream_error_unknown";\n          this.terminal = code;\n        }',
  '        if (result.status !== "completed" || result.diagnostics.some((item) => item.severity === "error")) {\n          const observed = result.failureCode ?? result.diagnostics.find((item) => item.severity === "error")?.code ?? "";\n          const canonical = observed === "codex_provider_auth" ? "authentication_failed"\n            : observed === "codex_provider_quota" ? "usage_limit_exceeded"\n            : observed === "codex_provider_capacity" ? "provider_overloaded"\n            : observed;\n          this.terminal = FAILURE_CODES.has(canonical)\n            ? canonical as CompareProviderStopCode : "provider_stream_error_unknown";\n        }');
const compare = "apps/cli/src/commands/compare.ts";
replace(compare,
  'import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";',
  'import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";\nimport { CodexCompareProviderGate, type CompareProviderIdentity } from "./codex-compare-provider-gate.js";');
replace(compare,
  '  identityMismatchFields: readonly string[];\n  executionOrder:',
  '  identityMismatchFields: readonly string[];\n  providerComparison: ReturnType<typeof createAgentComparisonContract>;\n  providerIdentity: CompareProviderIdentity | null;\n  quotaStatus: "unknown";\n  providerFailureCode: string | null;\n  executionOrder:');
replace(compare,
  '  model?: string;\n  discover?: typeof discoverCodexScope;',
  '  model?: string;\n  /** Fake adapters must explicitly inject a gate for offline provider tests. */\n  providerGate?: CodexCompareProviderGate;\n  discover?: typeof discoverCodexScope;');
replace(compare,
  '  const adapter = dependencies.adapter ?? new CodexAgentAdapter();',
  '  let providerGate: CodexCompareProviderGate | null;\n  try {\n    providerGate = dependencies.providerGate ??\n      (dependencies.adapter ? null : new CodexCompareProviderGate(model, BOUNDED_COMPARE_REASONING));\n    providerGate?.preflight(); // Local-only presence and identity check, not provider access evidence.\n  } catch (error) {\n    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"\n      ? error.code : "authentication_failed";\n    throw new CliError(code, "Codex provider identity preflight failed.", 5);\n  }\n  const rawAdapter = dependencies.adapter ?? new CodexAgentAdapter();\n  const adapter = providerGate ? providerGate.wrap(rawAdapter) : rawAdapter;');
replace(compare,
  '      discoveryFailure = error;\n      // A failed discovery may already have consumed a provider invocation.',
  '      discoveryFailure = error;\n      if (providerGate?.stoppedCode()) {\n        throw new CliError(providerGate.stoppedCode()!,\n          "Codex provider discovery failed; no subsequent invocation is allowed.", 4);\n      }\n      // A failed discovery may already have consumed a provider invocation.');
replace(compare,
  '    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS\n  });\n  const comparison = createAgentComparisonContract({ baseline: identity, bounded: identity });',
  '    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS,\n    ...(providerGate ? providerGate.identity : {})\n  });');
replace(compare,
  '  const stopAfterProviderFailure = (code: string | null): void => {\n    if (code ===',
  '  const stopAfterProviderFailure = (code: string | null): void => {\n    if (providerGate) return; // Shared gate owns all real-provider termination and receipts.\n    if (code ===');
replace(compare,
  '    for (const arm of executionOrder) {\n      if (arm === "baseline") {',
  '    for (const arm of executionOrder) {\n      if (providerGate?.stoppedCode()) break;\n      if (arm === "baseline") {');
replace(compare,
  '  if (normalExecution === null || boundedExecution === null) {',
  '  const providerFailureCode = providerGate?.stoppedCode() ?? null;\n  if (providerFailureCode !== null) {\n    const blocked = evaluateArm({\n      runtimeCompleted: false, runtimeStatus: "blocked", runtimeFailureCode: providerFailureCode,\n      validation: emptyValidation(), changedFiles: [], approvedMutableFiles,\n      controlAvailable: discovery !== null, forbiddenFiles, runs: [],\n      exposedFiles: 0, exposedBytes: 0, repairRounds: 0, durationMs: 0\n    });\n    normalExecution ??= blocked;\n    boundedExecution ??= blocked;\n  }\n\n  if (normalExecution === null || boundedExecution === null) {');
replace(compare,
  '  const output: CompareCodexOutput = Object.freeze({\n    ok: comparison.comparable,',
  '  const comparison = createAgentComparisonContract({\n    baseline: { ...identity, ...(providerGate ? providerGate.armIdentity("baseline") : {}) },\n    bounded: { ...identity, ...(providerGate ? providerGate.armIdentity("bounded") : {}) }\n  });\n  const comparable = comparison.comparable && providerFailureCode === null;\n  const output: CompareCodexOutput = Object.freeze({\n    ok: comparable,');
replace(compare,
  '    comparable: comparison.comparable,\n    identityMismatchFields: Object.freeze([...comparison.identityMismatchFields]),',
  '    comparable,\n    identityMismatchFields: Object.freeze([...comparison.identityMismatchFields]),\n    providerComparison: comparison,\n    providerIdentity: providerGate?.identity ?? null,\n    quotaStatus: "unknown",\n    providerFailureCode,');
replace(compare,
  '  return { output, exitCode: comparison.comparable ? 0 : 4 };',
  '  return { output, exitCode: comparable ? 0 : 4 };');
for (const test of ["benchmarks/product-v1/p7-6-compare-provider-smoke.cjs", "benchmarks/product-v1/p7-6-compare-command-smoke.cjs"]) {
  replace(test, '"medium"', '"none"', test === "benchmarks/product-v1/p7-6-compare-provider-smoke.cjs" ? 8 : 1);
}
console.log(JSON.stringify({ ok: true, changed }));
