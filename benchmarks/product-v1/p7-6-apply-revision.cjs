#!/usr/bin/env node
'use strict';
// One-shot, exact-match patch on PR #238. It must never run against another revision.
const fs = require('node:fs');
const cp = require('node:child_process');
const file = 'apps/cli/src/commands/compare.ts';
const expected = '06b6cc60a20e9193383efb2c09fe6b6bd96697f2';
const sha = cp.execFileSync('git', ['hash-object', file], {encoding:'utf8'}).trim();
if (sha !== expected) throw new Error('Compare source changed: refusing non-atomic patch');
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(oldText, newText) {
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error('Expected unique compare.ts anchor missing or duplicated');
  }
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}
replaceOnce(
'import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";',
'import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";\nimport { CodexCompareProviderGate, type CompareProviderIdentity } from "./codex-compare-provider-gate.js";'
);
replaceOnce('  identityMismatchFields: readonly string[];\n  executionOrder:',
`  identityMismatchFields: readonly string[];
  /** The full v2 comparison contract contains only non-secret operator aliases. */
  providerComparison: ReturnType<typeof createAgentComparisonContract>;
  providerIdentity: CompareProviderIdentity | null;
  quotaStatus: "unknown";
  providerFailureCode: string | null;
  executionOrder:`);
replaceOnce('  adapter?: AgentAdapter;\n  model?: string;\n  discover?: typeof discoverCodexScope;',
'  adapter?: AgentAdapter;\n  model?: string;\n  /** Injected only by deterministic offline tests; live CLI builds its own gate. */\n  providerGate?: CodexCompareProviderGate;\n  discover?: typeof discoverCodexScope;');
replaceOnce('  const adapter = dependencies.adapter ?? new CodexAgentAdapter();',
`  // One shared gate covers discovery and both arms. Fake adapters keep the
  // legacy v1 path unless an offline test explicitly injects a gate.
  let providerGate: CodexCompareProviderGate | null;
  try {
    providerGate = dependencies.providerGate ??
      (dependencies.adapter ? null : new CodexCompareProviderGate(model, BOUNDED_COMPARE_REASONING));
    providerGate?.preflight(); // Local filesystem/env only; no paid SDK call.
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" ? error.code : "authentication_failed";
    throw new CliError(code, "Codex local provider access/identity preflight failed.", 5);
  }
  const rawAdapter = dependencies.adapter ?? new CodexAgentAdapter();
  const adapter = providerGate ? providerGate.wrap(rawAdapter) : rawAdapter;`);
replaceOnce('    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS\n  });\n  const comparison = createAgentComparisonContract({ baseline: identity, bounded: identity });',
`    timeoutBudget: BOUNDED_COMPARE_AGENT_TIMEOUT_MS,
    ...(providerGate ? providerGate.identity : {})
  });`);
replaceOnce('    for (const arm of executionOrder) {\n      if (arm === "baseline") {',
`    for (const arm of executionOrder) {
      // Stop BEFORE starting the other arm, even when the first arm has already
      // consumed quota or returned a partial/ambiguous provider stream.
      if (providerGate?.stoppedCode()) break;
      if (arm === "baseline") {`);
replaceOnce('  if (normalExecution === null || boundedExecution === null) {',
`  const providerFailureCode = providerGate?.stoppedCode() ?? null;
  if (providerFailureCode !== null) {
    // Preserve an explicit non-comparable receipt for the arm that was never
    // invoked. No fake success and no extra paid invocation.
    const blocked = evaluateArm({
      runtimeCompleted: false, runtimeStatus: "blocked",
      runtimeFailureCode: providerFailureCode, validation: emptyValidation(),
      changedFiles: [], approvedMutableFiles, controlAvailable: discovery !== null,
      forbiddenFiles, runs: [], exposedFiles: 0, exposedBytes: 0,
      repairRounds: 0, durationMs: 0
    });
    normalExecution ??= blocked;
    boundedExecution ??= blocked;
  }

  if (normalExecution === null || boundedExecution === null) {`);
replaceOnce('  const output: CompareCodexOutput = Object.freeze({\n    ok: comparison.comparable,',
`  const comparison = createAgentComparisonContract({
    baseline: { ...identity, ...(providerGate ? providerGate.armIdentity("baseline") : {}) },
    bounded: { ...identity, ...(providerGate ? providerGate.armIdentity("bounded") : {}) }
  });
  const comparable = comparison.comparable && providerFailureCode === null;

  const output: CompareCodexOutput = Object.freeze({
    ok: comparable,`);
replaceOnce('    comparable: comparison.comparable,\n    identityMismatchFields: Object.freeze([...comparison.identityMismatchFields]),',
`    comparable,
    identityMismatchFields: Object.freeze([...comparison.identityMismatchFields]),
    providerComparison: comparison,
    providerIdentity: providerGate?.identity ?? null,
    quotaStatus: "unknown",
    providerFailureCode,`);
replaceOnce('  return { output, exitCode: comparison.comparable ? 0 : 4 };',
'  return { output, exitCode: comparable ? 0 : 4 };');
fs.writeFileSync(file, source);
console.log('P7.6 compare source patched; original blob verified; no provider calls');
