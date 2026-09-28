'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { MAX_DOCTOR_BYTES, NORMAL_DOCTOR_ARGS, DoctorPreflightError, parseDoctorResult } = require('./doctor-preflight.cjs');

assert.deepEqual(NORMAL_DOCTOR_ARGS, ['--strict-config', 'doctor', '--json', '-c', 'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="medium"']);
assert.equal(NORMAL_DOCTOR_ARGS.includes('--json'), true);
const report = { schemaVersion: 1, overallStatus: 'ok', codexVersion: 'fixture', checks: {
  'config.load': { status: 'ok', details: { model: 'gpt-5.6-luna', zeroValue: 0 } },
  'network.provider_reachability': { status: 'ok' }
} };
const result = (stdout, overrides = {}) => ({ status: 0, signal: null, error: null, stdout, stderr: '', ...overrides });
const good = parseDoctorResult(result(JSON.stringify(report) + '\n'));
assert.equal(good.report.checks['config.load'].details.zeroValue, 0);
assert.equal(good.diagnostic.exitCode, 0);
assert.equal(good.diagnostic.structuredStream, 'stdout');
assert.equal(good.diagnostic.structuredFormat, 'single-json-document');
assert.equal(good.diagnostic.parseSucceeded, true);
const exitOneReport = { ...report, overallStatus: 'fail' };
assert.deepEqual(Object.keys(good.diagnostic).sort(), ['exitCode', 'signal', 'timedOut', 'stdoutBytes', 'stderrBytes', 'structuredStream', 'structuredFormat', 'parseSucceeded', 'evidenceHash'].sort());
function fails(input, issue, reason) {
  let caught;
  try { parseDoctorResult(input); } catch (error) { caught = error; }
  assert.ok(caught instanceof DoctorPreflightError, `${issue}: typed failure required`);
  assert.equal(caught.issueCode, issue);
  if (reason) assert.equal(caught.reasonCode, reason);
  assert.equal(caught.diagnostic.issueCode, issue);
  assert.equal(caught.diagnostic.structuredStream, 'stdout');
  assert.equal(caught.diagnostic.structuredFormat, 'single-json-document');
  assert.equal(JSON.stringify(caught.diagnostic).includes('SECRET'), false);
  return caught;
}
fails(result(''), 'doctor_empty_output', 'stdout_empty');
fails(result('', { stderr: JSON.stringify(report) }), 'doctor_empty_output', 'stdout_empty_stderr_present');
fails(result('{"schemaVersion":1,'), 'doctor_structured_output_invalid', 'invalid_json_document');
fails(result('{bad json'), 'doctor_structured_output_invalid', 'invalid_json_document');
const rejected = fails(result('', { status: 2, stderr: 'SECRET unsupported flag\n' }), 'doctor_nonzero_exit', 'doctor_exit_not_zero');
assert.equal(rejected.diagnostic.exitCode, 2);
assert.equal(rejected.diagnostic.stdoutBytes, 0);
assert.ok(rejected.diagnostic.stderrBytes > 0);
assert.match(rejected.diagnostic.evidenceHash, /^sha256:[0-9a-f]{64}$/);
fails(result('', { status: null, error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }), 'doctor_timeout');
fails(result(JSON.stringify(report) + ' trailing'), 'doctor_structured_output_invalid', 'invalid_json_document');
fails(result('x'.repeat(MAX_DOCTOR_BYTES + 1)), 'doctor_output_oversized');
fails(result('Doctor report: all good'), 'doctor_wrong_output_format');
fails(result('', { error: { code: 'ENOBUFS' } }), 'doctor_output_truncated');
fails(result(JSON.stringify({ ...report, checks: [] })), 'doctor_schema_invalid');
fails(result(JSON.stringify(exitOneReport), { status: 1 }), 'doctor_nonzero_exit');
fails(result(JSON.stringify(exitOneReport)), 'doctor_report_failed');
fails(result(JSON.stringify(report), { status: null }), 'doctor_process_start_failed');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-preflight-test-'));
try {
  const sessionId = 'robustness-v1-2026-09-29-r91';
  const dir = path.join(scratch, sessionId); fs.mkdirSync(dir);
  const failedPreflight = { ok: false, providerCalls: 0, sessionId, preflightId: `${sessionId}/initial`, issueCode: 'doctor_nonzero_exit' };
  const post = { ok: true, providerCalls: 0, sessionId, preflightId: `${sessionId}/post-push`, benchmarkHead: 'f'.repeat(40) };
  fs.writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify(failedPreflight));
  fs.writeFileSync(path.join(dir, 'post-push-preflight.json'), JSON.stringify(post));
  const runner = cp.spawnSync(process.execPath, [path.join(__dirname, 'run-observation.cjs'), 'R1', 'normal', '--session-id', sessionId], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, ROBUSTNESS_RESULT_ROOT: scratch }, encoding: 'utf8'
  });
  assert.notEqual(runner.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'observations')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ledger.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'infrastructure-stop.json')), false);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log('Codex doctor preflight fixtures: PASS (provider/model calls 0)');
