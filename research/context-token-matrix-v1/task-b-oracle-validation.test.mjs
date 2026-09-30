#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTaskBPlan, runTaskBValidation, interpretTaskBValidation,
  classifyTaskBObservation, taskBMayContinue } from './task-b-live.mjs';
import { prepareSourceCheckout } from './live-runtime.mjs';
import { parseTextFileUpdates } from '../../dist/packages/product-runtime/src/text-file-update-contract.js';

let providerCalls = 0;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-oracle-fixture-'));
try {
  const historic = path.join(os.homedir(), '.bounded-agent/bounded-dllm-agent-lab/live-runs',
    'context-token-matrix-v1/task-b-stage1-20260930-r4/01-A-minimal');
  const previous = JSON.parse(fs.readFileSync(path.join(historic, 'behavior-check.json')));
  assert.equal(previous.status, 'FAIL');
  assert.ok(previous.results.behavior.stderrTail.includes(
    'candidate/dist/packages/integrations/src/codex-event-parser.js'));
  assert.ok(previous.results.behavior.stderrTail.includes('imported from'));
  assert.ok(!previous.results.behavior.stderrTail.includes('AssertionError'));
  const product = { sourceRepositoryUnchanged: true, apply: 'NOT_RUN',
    decision: 'bounded_task_completed' };
  const bounded = { decision: 'bounded_task_completed' };
  const entry = (id, passed, exitCode, stdout = '', stderr = '') =>
    ({ id, passed, exitCode, stdout, stderr });
  const good = [entry('validation.syntax', true, 0),
    entry('validation.typecheck', true, 0), entry('validation.test', true, 0),
    entry('task-b.module-probe', true, 0, 'TASK_B_MODULE_LOADED\n'),
    entry('task-b.behavior-oracle', true, 0, 'event-order behavior PASS\n')];
  const value = commandResults => ({ decision: 'temp_validation_failed',
    issues: [{ code: 'validation_command_failed' }], commandResults });
  const pass = interpretTaskBValidation({ decision: 'temp_validation_passed',
    issues: [], commandResults: good });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.assertionsCompleted, true);
  const assertion = interpretTaskBValidation(value([...good.slice(0, 4),
    entry('task-b.behavior-oracle', false, 1, '', 'AssertionError: expected behavior')]));
  assert.equal(assertion.status, 'FAIL');
  assert.equal(assertion.issueCode, 'task_b_behavior_assertion_failed');
  assert.equal(classifyTaskBObservation(product, bounded, assertion), 'candidate_validation_failure');
  assert.equal(taskBMayContinue('candidate_validation_failure'), true);
  const missing = interpretTaskBValidation(value([...good.slice(0, 3),
    entry('task-b.module-probe', false, 1, '', 'ERR_MODULE_NOT_FOUND')]));
  assert.equal(missing.status, 'INFRASTRUCTURE_STOP');
  assert.equal(missing.issueCode, 'task_b_oracle_module_load_failed');
  assert.equal(classifyTaskBObservation(product, bounded, missing), 'infrastructure_failure');
  assert.equal(taskBMayContinue('infrastructure_failure'), false);
  let attemptedObservations = 0;
  for (const planned of Array(6)) {
    attemptedObservations++;
    const classification = classifyTaskBObservation(product, bounded, missing);
    if (!taskBMayContinue(classification)) break;
  }
  assert.equal(attemptedObservations, 1, 'no second observation after oracle infrastructure failure');
  assert.equal(interpretTaskBValidation(value([...good.slice(0, 4),
    entry('task-b.behavior-oracle', false, 1, '', 'unexpected runtime crash')])).status,
  'INFRASTRUCTURE_STOP');
  assert.equal(interpretTaskBValidation(null).status, 'INFRASTRUCTURE_STOP');
  assert.equal(interpretTaskBValidation(value(good.slice(0, 3))).status,
  'INFRASTRUCTURE_STOP');
  const build = interpretTaskBValidation(value([entry('validation.syntax', false, 1)]));
  assert.equal(build.status, 'FAIL');
  assert.equal(build.reasonCode, 'candidate_validation_failure');
  assert.equal(classifyTaskBObservation(product, bounded, build), 'candidate_validation_failure');
  const plan = loadTaskBPlan();
  const source = await prepareSourceCheckout(temp, plan.proposal);
  const hostBuild = spawnSync('npm', ['run', 'build'], { cwd: source.root,
    encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(hostBuild.status, 0, hostBuild.stderr);
  const preflightRoot = path.join(temp, 'preflight-candidate');
  fs.cpSync(source.root, preflightRoot, { recursive: true, verbatimSymlinks: true,
    filter: item => path.basename(item) !== '.git' });
  const preflightProbe = await runTaskBValidation(source.root, preflightRoot);
  assert.equal(preflightProbe.status, 'FAIL', JSON.stringify(preflightProbe));
  assert.equal(preflightProbe.issueCode, 'task_b_behavior_assertion_failed');
  const root = path.join(temp, 'candidate');
  fs.cpSync(source.root, root, { recursive: true, verbatimSymlinks: true,
    filter: item => path.basename(item) !== '.git' });
  const historical = JSON.parse(fs.readFileSync(path.join(historic, 'raw-bounded-result.json')));
  const output = historical.plannerResult.taskSeedResult.repoResult.adaptiveResult.coderResult.providerOutput;
  for (const claim of parseTextFileUpdates(output))
    fs.writeFileSync(path.join(root, claim.file), claim.newContent);
  const fixed = await runTaskBValidation(source.root, root);
  assert.equal(fixed.status, 'PASS', JSON.stringify(fixed));
  assert.equal(fixed.moduleLoaded, true);
  assert.equal(fixed.assertionsCompleted, true);
  assert.equal(fixed.infrastructurePass, true);
  assert.equal(providerCalls, 0);
  console.log('Task B oracle environment/classification: PASS (saved r4 Candidate; provider/model calls 0)');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
