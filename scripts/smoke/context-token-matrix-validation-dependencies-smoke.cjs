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
  const runtime = await import(pathToFileURL(path.join(repository,
    'research/context-token-matrix-v1/live-runtime.mjs')).href);
  const { initializeBoundedLocalConfig } = await import(pathToFileURL(path.join(repository,
    'dist/apps/cli/src/product-config.js')).href);
  const { validationSpecification } = await import(pathToFileURL(path.join(repository,
    'dist/apps/cli/src/commands/codex.js')).href);
  const { runContainerizedWorkspaceExecution } = await import(pathToFileURL(path.join(repository,
    'dist/packages/product-runtime/src/containerized-workspace-execution-runner.js')).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(repository,
    'research/context-token-matrix-v1/experiment-manifest.json'), 'utf8'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-validation-deps-'));
  const head = source => {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
    assert.equal(result.status, 0); return result.stdout.trim();
  };
  const executeSyntax = async (source, name) => {
    const candidate = path.join(parent, name);
    fs.cpSync(source, candidate, { recursive: true, verbatimSymlinks: true,
      filter: entry => path.basename(entry) !== '.git' });
    fs.mkdirSync(path.join(candidate, '.validation-output'));
    const config = JSON.parse(fs.readFileSync(path.join(source, '.bounded/config.json'), 'utf8'));
    const specification = validationSpecification(config, source);
    assert.deepEqual(specification.commands[0].args, ['run', 'build']);
    assert.equal(specification.validationEnvironment.gitContext, 'candidate-baseline/v1');
    return runContainerizedWorkspaceExecution({ tempWorkspacePath: candidate,
      tempApplyDecision: 'temp_apply_ready', tempWorkspaceCleanedUp: false,
      ...specification, commands: [specification.commands[0]] }, async () => null,
    { runtime: 'docker', sourceRepositoryPath: source });
  };
  try {
    const bareParent = path.join(parent, 'bare');
    fs.mkdirSync(bareParent);
    const bare = runtime.createSourceCheckout(bareParent, manifest.sourceHead);
    await initializeBoundedLocalConfig(bare);
    assert.equal(fs.existsSync(path.join(bare, 'node_modules')), false);
    const before = await executeSyntax(bare, 'bare-candidate');
    assert.equal(before.commandResults[0]?.exitCode, 127);
    assert.match(before.commandResults[0].stderr, /tsc: not found/);
    assert(before.issues.some(issue => issue.code === 'validation_command_failed'));

    const readyParent = path.join(parent, 'ready');
    fs.mkdirSync(readyParent);
    const ready = (await runtime.prepareSourceCheckout(readyParent, manifest)).root;
    assert.equal(head(bare), manifest.sourceHead);
    assert.equal(head(ready), manifest.sourceHead);
    assert.deepEqual(fs.readFileSync(path.join(bare, 'package-lock.json')),
      fs.readFileSync(path.join(ready, 'package-lock.json')));
    assert.equal(runtime.verifySourceIdentity(ready, manifest.sourceHead), '?? .bounded/');
    const after = await executeSyntax(ready, 'ready-candidate');
    assert.equal(after.commandResults[0]?.exitCode, 0);
    assert.equal(after.commandResults[0]?.passed, true);
    assert.equal(after.decision, 'temp_validation_passed');
    assert.deepEqual(after.issues, []);
    console.log('context-token-matrix-validation-dependencies-smoke: PASS (fake provider calls 0)');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
