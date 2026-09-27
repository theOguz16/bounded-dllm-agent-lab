#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const research = path.join(repository, 'research/context-token-matrix-v1');
  const { calibratePilots } = await import(pathToFileURL(path.join(research, 'calibrate.mjs')).href);
  const { buildDryRun, renderDryRun } = await import(pathToFileURL(path.join(research, 'dry-run.mjs')).href);
  const snapshot = JSON.parse(fs.readFileSync(path.join(research, 'calibration.json'), 'utf8'));
  const manifestPath = path.join(research, 'experiment-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'context-token-protocol-'));
  const command = (args, cwd = repository) => {
    const run = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr); return run.stdout;
  };
  try {
    const checkout = path.join(temporary, 'source');
    command(['git', 'clone', '--quiet', '--shared', '--no-checkout', '--', repository, checkout]);
    command(['git', 'checkout', '--quiet', '--detach', snapshot.sourceHead], checkout);
    const fresh = await calibratePilots(checkout);
    assert.deepEqual(fresh, snapshot, 'offline calibration must reproduce from pinned HEAD');
    assert.equal(snapshot.providerModelCalls, 0);
    const [worker, local, help] = snapshot.tasks;
    assert.equal(worker.eligibility.eligible, true);
    assert.equal(worker.minimalEqualsCurrent, true);
    assert.equal(worker.currentEqualsExpanded, false);
    assert.equal(worker.variants.expanded.addedDependencies, 2);
    assert.equal(worker.variants.current.gateDecision, 'repo_context_binding_completed');
    assert.equal(local.eligibility.eligible, false);
    assert.equal(local.variants.current.gateDecision, 'repo_context_binding_stopped');
    assert(local.variants.current.gateIssues.includes('coder_context_hard_budget_exceeded'));
    assert.equal(help.eligibility.eligible, false);
    assert.equal(help.currentEqualsExpanded, true);
    const plan = buildDryRun();
    assert.equal(plan.liveExecutionAuthorized, false);
    assert.deepEqual([plan.stage1Count, plan.conditionalStage2Count, plan.maximumRunCount], [3, 3, 6]);
    assert.deepEqual(plan.rows.map(row => [row.stage, row.variant]), [
      ['stage1', 'minimal'], ['stage1', 'current'], ['stage1', 'expanded'],
      ['stage2_conditional', 'minimal'], ['stage2_conditional', 'current'],
      ['stage2_conditional', 'expanded']]);
    assert(plan.rows.every(row => row.eligible && row.model === 'gpt-5.6-luna' &&
      row.reasoning === 'medium' && row.allowedFiles.length === 2 &&
      row.outputPath.startsWith('.bounded/research/context-token-matrix-v1/')));
    assert.match(renderDryRun(plan), /live authorized: no/);
    assert.equal(JSON.parse(renderDryRun(plan, 'json')).rows.length, 6);
    const cli = command([process.execPath, path.join(research, 'dry-run.mjs'), '--format', 'json']);
    assert.equal(JSON.parse(cli).maximumRunCount, 6);
    const invalid = (change, reason) => {
      const altered = structuredClone(manifest); change(altered);
      const file = path.join(temporary, 'invalid.json');
      fs.writeFileSync(file, JSON.stringify(altered));
      assert.throws(() => buildDryRun(file), /experiment_manifest_invalid/, reason);
    };
    invalid(x => { x.controlledExecution.applyCount = 1; }, 'apply cannot change');
    invalid(x => { x.controlledExecution.retryCount = 1; }, 'retry cannot change');
    invalid(x => { x.model = 'different-model'; }, 'model cannot drift');
    invalid(x => { x.variants = ['current']; }, 'variants cannot drift');
    invalid(x => { x.effectivePolicies.expanded.hardTotalBudgetTokens = 999999; },
      'context policy cannot drift');
    invalid(x => { x.calibrationSha256 = `sha256:${'0'.repeat(64)}`; }, 'calibration must bind');
    invalid(x => { x.selectedTasks[0].taskHash = `sha256:${'0'.repeat(64)}`; }, 'task must bind');
    invalid(x => { x.selectedTasks[0].behaviorCheck = 'skip'; }, 'behavior check must bind');
    invalid(x => { x.requiredMetrics.pop(); }, 'metrics cannot disappear');
    invalid(x => { x.liveExecutionAuthorized = true; }, 'manifest cannot authorize provider use');
    invalid(x => { x.repetitionPlan.maxPlannedRuns = 18; }, 'run count cannot drift');
    assert.equal(fs.existsSync(path.join(temporary, 'source/.bounded')), false,
      'calibration and dry-run must not create live output');
    console.log('context-token-matrix-protocol-smoke: PASS');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
