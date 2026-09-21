#!/usr/bin/env node
'use strict';
// One-shot integration helper. Preserve the P7.6 production contract when
// transplanting only the reviewed P7.7 worker change; deleted before merge.
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' });
const paths = [
  'benchmarks/product-v1/dogfood-resumable-runner.cjs',
  'benchmarks/product-v1/dogfood-runner.cjs',
  'packages/integrations/src/codex-agent-adapter.ts',
  'scripts/smoke/agent-environment-smoke.cjs'
];
const unresolved = git('diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean).sort();
assert.deepEqual(unresolved, [...paths].sort(), 'Unexpected conflicting files; stop instead of guessing.');
const stage = (number, file) => git('show', `:${number}:${file}`);
function once(text, before, after, label) {
  const at = text.indexOf(before);
  assert(at !== -1 && text.indexOf(before, at + before.length) === -1, `Expected exactly one ${label}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function write(file, content) { fs.writeFileSync(file, content); git('add', '--', file); }
// The resumable checkpoint in P7.6 already forbids re-running in-flight or
// failed tasks. The old P7.7 runner was based on the pre-P7.6 access API.
write(paths[0], stage(2, paths[0]));
// Preserve model/account preflight and truthful failure recording. Prevent the
// canonical non-resumable runner from starting another task after an ambiguous
// or failed invocation; forward explicit worker failure codes in its receipt.
let dogfood = stage(2, paths[1]);
dogfood = once(dogfood,
  '      if (compare.error || compare.status !== 0 || !parsed) {\n        record.failure = redactedFailure(compare);',
  '      if (compare.error || compare.status !== 0 || !parsed) {\n        record.failure = redactedFailure(compare);\n        const terminal = parsed?.terminalFailureCode;\n        if (terminal === "provider_outcome_ambiguous" || terminal === "worker_termination_failed") {\n          record.failure.code = terminal;\n        }', 'dogfood explicit terminal receipt');
dogfood = once(dogfood, '    results.push(record);\n  }',
  '    results.push(record);\n    // A prior task may have consumed provider quota or left an unknown outcome.\n    // Never launch the next task in this process after any failure.\n    if (record.failure !== null) break;\n  }', 'dogfood fail-closed task loop');
write(paths[1], dogfood);
// Use the worker-backed P7.7 adapter as the starting point, then restore every
// affected P7.6 provider-safety and strict Luna/none behavior verbatim.
const current = stage(2, paths[2]);
let adapter = stage(3, paths[2]);
adapter = once(adapter, '    case "none": return "minimal";',
  '    case "none": throw new Error("none is a Codex CLI override, not minimal reasoning");', 'none never maps to minimal');
adapter = once(adapter,
  '      modelReasoningEffort: mapReasoningEffort(request.reasoningEffort),',
  '      ...(request.reasoningEffort === "none" ? {} : { modelReasoningEffort: mapReasoningEffort(request.reasoningEffort) }),', 'no SDK minimal fallback');
// Transfer the stronger P7.6 stream classification and redaction, rather than
// replacing it with the old worker branch's less specific error handling.
function segment(text, begin, end) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end, a + begin.length);
  assert(a >= 0 && b > a, `Missing segment ${begin}`);
  return text.slice(a, b);
}
adapter = once(adapter,
  segment(adapter, '    } catch (error) {\n      streamError = error;', '    } finally {\n      processControl.close();'),
  segment(current, '    } catch (error) {\n      streamError = error;', '    } finally {\n      processControl.close();'), 'P7.6 provider catch');
adapter = once(adapter,
  segment(adapter, '    // Errors can be reported inside JSONL without throwing from the SDK.', '    if (processFailure !== null) {'),
  segment(current, '    // Errors can be reported inside JSONL without throwing from the SDK.', '    if (processFailure !== null) {'), 'P7.6 stream classification');
adapter = once(adapter,
  segment(adapter, '    const diagnostics: AgentDiagnostic[] = [', '    const commands = mapCommands('),
  segment(current, '    const diagnostics: AgentDiagnostic[] = [', '    const commands = mapCommands('), 'P7.6 redacted diagnostics');
write(paths[2], adapter);
let environmentSmoke = stage(2, paths[3]);
environmentSmoke = once(environmentSmoke,
  `  assert.equal(adapterSource.includes('new Codex({ env: { ...environment }, config: { model_reasoning_effort: "none" } })'), true);`,
  '  assert.equal(adapterSource.includes("this.environment = { ...environment };"), true);', 'environment smoke worker boundary');
environmentSmoke = once(environmentSmoke,
  '  process.stdout.write(`${JSON.stringify({',
  `  assert.equal(adapterSource.includes("env: this.environment"), true);\n  const workerSource = readFileSync(resolve(repoRoot, "packages/integrations/src/codex-agent-worker.ts"), "utf8");\n  assert.equal(workerSource.includes('model_reasoning_effort: "none"'), true);\n  assert.equal(workerSource.includes("process.env"), false);\n  process.stdout.write(\`\${JSON.stringify({`, 'environment worker smoke');
write(paths[3], environmentSmoke);
// P7.6 requires the actual child SDK constructor to carry none; no minimal
// replacement and no widened environment in the worker.
const childPath = 'packages/integrations/src/codex-agent-worker.ts';
let child = fs.readFileSync(childPath, 'utf8');
child = once(child, '  const client = new Codex();',
  '  const client = new Codex({ config: { model_reasoning_effort: "none" } });', 'worker SDK none');
write(childPath, child);
assert.equal(git('diff', '--name-only', '--diff-filter=U').trim(), '', 'Conflicts remain.');
git('diff', '--cached', '--check');
process.stdout.write(JSON.stringify({ok: true, resolved: paths, noLiveInvocation: true}) + '\n');
