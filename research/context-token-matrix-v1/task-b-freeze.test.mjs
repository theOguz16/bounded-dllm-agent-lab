#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateTaskB } from './task-b-calibrate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const read = name => JSON.parse(fs.readFileSync(path.join(here, name), 'utf8'));
const bytes = name => fs.readFileSync(path.join(root, name));
let scratch = null;
const sourceCheckout = process.argv[2] || (() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-freeze-'));
  process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
  const checkout = path.join(scratch, 'source');
  for (const [command, args, cwd] of [
    ['git', ['clone', '--local', '--no-hardlinks', '--quiet', root, checkout], root],
    ['git', ['checkout', '--detach', 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9'], checkout],
    ['npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], checkout],
    ['npm', ['run', 'build'], checkout]
  ]) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `${command} ${args[0]}: ${result.stderr}`);
  }
  return checkout;
})();
const proposal = read('task-b-prospective-manifest.json');
const definition = read('task-b-definition.json');
const calibration = read('task-b-calibration.json');
for (const [file, digest] of [
  [proposal.frozenTaskAManifest, proposal.frozenTaskAManifestSha256],
  [proposal.taskBDefinition, proposal.taskBDefinitionSha256],
  [proposal.taskBCalibration, proposal.taskBCalibrationSha256]
]) assert.equal(sha(bytes(file)), digest);
assert.equal(sha(fs.readFileSync(path.join(here, 'oracles/event-order.cjs'))), definition.oracleSha256);
assert.equal(proposal.controlledExecution.oracleSha256, definition.oracleSha256);
assert.equal(proposal.taskBHash, definition.sourceTask.taskHash);
assert.equal(proposal.sourceHead, definition.sourceTask.sourceHead);
assert.equal(proposal.model, 'gpt-5.6-luna');
assert.equal(proposal.reasoning, 'medium');
assert.deepEqual([proposal.controlledExecution.retry, proposal.controlledExecution.repair,
  proposal.controlledExecution.apply], [0, 0, 0]);
assert.equal(proposal.controlledExecution.freshPinnedSourceCheckoutPerObservation, true);
assert.equal(proposal.controlledExecution.trajectoryTelemetry, 'codex-coder-trajectory/v1');
assert.equal(proposal.liveExecutionAuthorized, false);
assert.equal(definition.liveExecutionAuthorized, false);
assert.deepEqual(proposal.stage1Order,
  ['A:minimal', 'A:current', 'A:expanded', 'B:current', 'B:expanded', 'B:minimal']);
assert.deepEqual(proposal.stage2ConditionalOrder, proposal.stage1Order);
assert.equal(proposal.maximumObservations, 12);
assert.equal(proposal.maximumPlannedProviderStageInvocations, 36);
assert.deepEqual(definition.sourceTask.allowedFiles,
  ['packages/integrations/src/codex-event-parser.ts', 'scripts/smoke/codex-event-parser-smoke.cjs']);
assert.equal(definition.sourceTask.oracle, 'node {benchmark}/oracles/event-order.cjs {candidate}');
assert.deepEqual(definition.sourceTask.validationCommands, [
  'npm run build', 'npm run typecheck', 'npm test',
  'node {benchmark}/oracles/event-order.cjs {candidate}'
]);
const computed = await calibrateTaskB(sourceCheckout);
assert.deepEqual(computed, calibration);
assert.deepEqual(computed.variants.minimal.selectedFiles, computed.variants.current.selectedFiles);
assert.equal(computed.variants.minimal.selectedBytes, computed.variants.current.selectedBytes);
assert.deepEqual(computed.expandedAdditions.map(x => x.path),
  ['packages/integrations/src/agent-adapter.ts', 'packages/integrations/src/agent-telemetry.ts']);
assert.ok(computed.expandedAdditions.every(x => x.directEdges.some(edge => edge.kind === 'import')));
assert.ok(Object.values(computed.variants).every(x => x.gateDecision === 'repo_context_binding_completed' &&
  x.withinConfiguredHardLimit && x.offlineStubInvocations === 1));
const oracle = spawnSync(process.execPath, [path.join(here, 'oracles/event-order.cjs'), sourceCheckout],
  { encoding: 'utf8', timeout: 30_000 });
assert.equal(oracle.status, 1, 'unchanged source must fail the independent behavior oracle');
assert.match(oracle.stderr, /AssertionError/);
console.log('Task B frozen definition, context, hashes, gate, and oracle rejection: PASS (provider/model calls 0)');
