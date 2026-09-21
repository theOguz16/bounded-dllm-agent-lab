#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
function patch(file, from, to) {
  const original = fs.readFileSync(file, "utf8");
  const i = original.indexOf(from);
  if (i < 0 || original.indexOf(from, i + from.length) !== -1) {
    throw new Error(`P7.7 runner patch cannot uniquely match ${file}`);
  }
  fs.writeFileSync(file, original.slice(0, i) + to + original.slice(i + from.length));
}
const dogfood = "benchmarks/product-v1/dogfood-runner.cjs";
patch(dogfood,
  'const { pathToFileURL } = require("node:url");',
  'const { pathToFileURL } = require("node:url");\nconst { runIsolatedCommand } = require("./isolated-command-runner.cjs");');
patch(dogfood,
  '    runtime?.bounded?.failureCode,\n    parsed?.failureCode,',
  '    runtime?.bounded?.failureCode,\n    parsed?.providerFailureCode,\n    parsed?.failureCode,');
patch(dogfood,
  '    stderrBytes: Buffer.byteLength(result.stderr)\n',
  '    stderrBytes: Buffer.byteLength(result.stderr),\n    workerLifecycle: result.lifecycle ?? null\n');
patch(dogfood,
  '      pairCompleted: false,\n      result: null,',
  '      pairCompleted: false,\n      workerLifecycle: null,\n      result: null,');
patch(dogfood,
  '    try {\n      assertSameIdentity(providerIdentity, access.beforeInvocation());',
  '    let workerShutdownVerified = true;\n    try {\n      assertSameIdentity(providerIdentity, access.beforeInvocation());');
patch(dogfood,
  '      const compare = run(process.execPath, [',
  '      const compare = await runIsolatedCommand(process.execPath, [');
patch(dogfood,
  '      const parsed = parseCliJson(compare.stdout);\n      const providerCode = providerCodeFromCompare(parsed, compare);',
  `      record.workerLifecycle = compare.lifecycle;
      workerShutdownVerified = compare.lifecycle.workerTerminationVerified;
      if (!workerShutdownVerified) {
        throw Object.assign(new Error("worker_termination_failed"), { code: "worker_termination_failed" });
      }
      const parsed = compare.failureCode ? null : parseCliJson(compare.stdout);
      const providerCode = compare.failureCode ?? providerCodeFromCompare(parsed, compare);`);
patch(dogfood,
  '      fs.rmSync(tempRoot, { recursive: true, force: true });',
  '      // Never delete a workspace while an unverified worker might still mutate it.\n      if (workerShutdownVerified) fs.rmSync(tempRoot, { recursive: true, force: true });');
patch(dogfood,
  '      if (record.failure.code === "authentication_failed" || record.failure.code === "usage_limit_exceeded" ||\n          record.failure.code === "provider_identity_changed") {',
  '      if (record.failure.code === "authentication_failed" || record.failure.code === "usage_limit_exceeded" ||\n          record.failure.code === "provider_identity_changed" ||\n          record.failure.code === "worker_termination_failed" ||\n          record.failure.code === "provider_outcome_ambiguous") {');

const resume = "benchmarks/product-v1/dogfood-resumable-runner.cjs";
patch(resume,
  'const { spawnSync } = require("node:child_process");',
  'const { spawnSync } = require("node:child_process");\nconst { runIsolatedCommand } = require("./isolated-command-runner.cjs");');
patch(resume,
  '    if (!entry.pairCompleted || entry.failure !== null) {',
  '    if (entry.workerLifecycle?.workerTerminationVerified !== true ||\n        entry.outerWorkerLifecycle?.workerTerminationVerified !== true) {\n      throw new Error(`cannot resume: ${entry.taskId} worker exit is not verified`);\n    }\n    if (!entry.pairCompleted || entry.failure !== null) {');
patch(resume,
  '  assert.equal(entry.pairCompleted, true, `${task.taskId}: pair did not complete`);',
  '  assert.equal(entry.workerLifecycle?.workerTerminationVerified, true,\n    `${task.taskId}: inner comparison worker exit unverified`);\n  assert.equal(entry.pairCompleted, true, `${task.taskId}: pair did not complete`);');
patch(resume,
  'function main() {',
  'async function main() {');
patch(resume,
  '    const child = run(process.execPath, [\n      canonicalRunner,',
  '    const child = await runIsolatedCommand(process.execPath, [\n      canonicalRunner,');
patch(resume,
  '    let terminalCode = childReport?.stoppedProviderCode || null;',
  '    let terminalCode = child.failureCode || childReport?.stoppedProviderCode || null;');
patch(resume,
  '    if (child.error || child.status !== 0 || !childReport || identityError !== null) {\n      const code = identityError ? "provider_identity_changed" : terminalCode || "dogfood_child_failed";',
  '    if (child.error || child.status !== 0 || !childReport || identityError !== null ||\n        child.lifecycle.workerTerminationVerified !== true) {\n      const code = child.lifecycle.workerTerminationVerified !== true ? "worker_termination_failed" :\n        identityError ? "provider_identity_changed" : terminalCode || "dogfood_child_failed";');
patch(resume,
  '          processError: child.error ? "process_error" : null\n',
  '          processError: child.error ? "process_error" : null,\n          workerLifecycle: child.lifecycle\n');
patch(resume,
  '    const entry = validateChildReport(childReport, task, suite, args.model, providerIdentity);\n    results.push(entry);',
  '    const entry = validateChildReport(childReport, task, suite, args.model, providerIdentity);\n    results.push({ ...entry, outerWorkerLifecycle: child.lifecycle });');
patch(resume,
  'try { main(); } catch (error) {\n  console.error(error && typeof error.code === "string" ? error.code :\n    error instanceof Error ? error.message : "dogfood_resumable_runner_failed");\n  process.exitCode = 1;\n}',
  'main().catch((error) => {\n  console.error(error && typeof error.code === "string" ? error.code :\n    error instanceof Error ? error.message : "dogfood_resumable_runner_failed");\n  process.exitCode = 1;\n});');
console.log("P7.7 dogfood runners patched");
