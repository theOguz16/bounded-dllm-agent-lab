#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const source = path.resolve(process.argv[2]);
  const raw = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const recovery = raw.recovery;
  if (!recovery?.registryRoot || !recovery.idempotencyKey || !raw.taskId) throw Error('Bounded recovery locator is unavailable');
  const api = await import(pathToFileURL(path.join(source, 'dist/packages/product-runtime/src/bounded-task-state-machine.js')).href);
  const locator = { registryRoot: recovery.registryRoot, taskId: raw.taskId, idempotencyKey: recovery.idempotencyKey };
  const state = api.readDurableBoundedTaskState(locator);
  if (!state.terminalResultReference) throw Error('Bounded terminal result is unavailable');
  const result = api.readDurableBoundedTaskArtifact(locator, state, state.terminalResultReference);
  process.stdout.write(JSON.stringify({ state: state.currentState, result }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
