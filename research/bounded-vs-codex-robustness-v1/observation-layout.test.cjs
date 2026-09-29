'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeObservationDirectory, ObservationLayoutError } = require('./observation-layout.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'robustness-layout-test-'));
const previous = path.join(scratch, 'robustness-v1-2026-09-29-r8');
const fresh = path.join(scratch, 'robustness-v1-2026-09-29-r9');
const historical = path.join(previous, 'infrastructure-stop.json');
const typed = (action, code) => assert.throws(action, error =>
  error instanceof ObservationLayoutError && error.code === code);
try {
  fs.mkdirSync(previous);
  fs.writeFileSync(historical, 'historical evidence stays immutable\n');
  const originalEvidence = fs.readFileSync(historical);
  fs.mkdirSync(fresh);
  const first = path.join(fresh, 'observations', 'R1-normal');
  const second = path.join(fresh, 'observations', 'R1-bounded');
  assert.equal(fs.existsSync(path.dirname(first)), false);
  assert.throws(() => fs.mkdirSync(first), { code: 'ENOENT' }); // exact r8 failure

  let providerCalls = 0;
  const guardedProviderStart = (sessionDir, obsId) => {
    initializeObservationDirectory(sessionDir, obsId);
    providerCalls++;
  };
  assert.equal(initializeObservationDirectory(fresh, 'R1-normal'), first);
  assert.equal(fs.statSync(first).isDirectory(), true);
  assert.equal(providerCalls, 0);
  assert.equal(fs.existsSync(path.join(fresh, 'ledger.json')), false);
  typed(() => initializeObservationDirectory(fresh, 'R1-normal'), 'observation_directory_exists');
  assert.equal(providerCalls, 0);
  typed(() => initializeObservationDirectory(path.join(scratch, 'missing'), 'R1-normal'), 'session_root_missing');
  const fileRoot = path.join(scratch, 'file-root'); fs.writeFileSync(fileRoot, 'x');
  typed(() => initializeObservationDirectory(fileRoot, 'R1-normal'), 'session_root_not_directory');
  typed(() => guardedProviderStart(fileRoot, 'R1-normal'), 'session_root_not_directory');
  assert.equal(providerCalls, 0);

  const noRootWrite = { ...fs, accessSync(target, mode) {
    if (target === fresh) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.accessSync(target, mode);
  } };
  typed(() => initializeObservationDirectory(fresh, 'R2-normal', noRootWrite), 'session_root_unwritable');
  assert.equal(fs.existsSync(path.join(fresh, 'observations', 'R2-normal')), false);
  const noParentWrite = { ...fs, accessSync(target, mode) {
    if (target === path.join(fresh, 'observations')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.accessSync(target, mode);
  } };
  typed(() => initializeObservationDirectory(fresh, 'R2-normal', noParentWrite), 'observation_parent_unwritable');
  assert.equal(fs.existsSync(path.join(fresh, 'observations', 'R2-normal')), false);
  assert.equal(fs.existsSync(path.join(fresh, 'ledger.json')), false);
  assert.equal(providerCalls, 0);
  assert.equal(initializeObservationDirectory(fresh, 'R1-bounded'), second);
  assert.equal(fs.statSync(second).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(historical), originalEvidence);
  assert.deepEqual(fs.readdirSync(previous), ['infrastructure-stop.json']);
  typed(() => initializeObservationDirectory(fresh, '../R3-normal'), 'invalid_observation_path');

  const runner = fs.readFileSync(path.join(__dirname, 'run-observation.cjs'), 'utf8');
  const setup = runner.indexOf(' initializeObservationDirectory(sessionDir,obsId);');
  const reservation = runner.indexOf(' ledger.push({sessionId,observationId');
  const generation = runner.indexOf(' generation=run(command,args');
  assert.ok(setup > 0 && setup < reservation && reservation < generation,
    'filesystem setup must precede ledger reservation and provider execution');
  assert.equal(providerCalls, 0);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log('robustness observation layout: PASS (provider/model calls 0)');
