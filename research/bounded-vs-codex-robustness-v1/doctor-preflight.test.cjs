'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { MAX_DOCTOR_BYTES, NORMAL_DOCTOR_ARGS, DoctorPreflightError, parseDoctorResult } = require('./doctor-preflight.cjs');

assert.deepEqual(NORMAL_DOCTOR_ARGS, ['--strict-config', 'doctor', '--json', '-c',
  'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="medium"']);
const required = ['auth.credentials', 'config.load', 'network.provider_reachability',
  'runtime.provenance', 'git.environment', 'state.paths'];
const terminalDetails = { TERM: 'dumb', terminal: 'dumb', 'stdin is terminal': 'false',
  'stdout is terminal': 'false', 'stderr is terminal': 'false' };
const terminalIssues = [{ severity: 'fail', fields: ['TERM'] }];
function report(overrides = {}) {
  const checks = Object.fromEntries(required.map(id => [id, { status: 'ok' }]));
  checks['config.load'].details = { model: 'gpt-5.6-luna', zeroValue: 0 };
  return { schemaVersion: 1, overallStatus: 'ok', codexVersion: '0.154.0',
    checks: { ...checks, ...overrides } };
}
const processResult = (value, overrides = {}) => ({ status: 0, signal: null, error: null,
  stdout: typeof value === 'string' ? value : JSON.stringify(value) + '\n', stderr: '', ...overrides });
function fails(input, issue, reason) {
  let caught;
  try { parseDoctorResult(input); } catch (error) { caught = error; }
  assert.ok(caught instanceof DoctorPreflightError, `${issue}: typed failure required`);
  assert.equal(caught.issueCode, issue);
  if (reason) assert.equal(caught.reasonCode, reason);
  assert.equal(caught.diagnostic.issueCode, issue);
  assert.equal(caught.diagnostic.structuredStream, 'stdout');
  assert.equal(JSON.stringify(caught.diagnostic).includes('SECRET'), false);
  return caught;
}
const good = parseDoctorResult(processResult(report()));
assert.equal(good.report.checks['config.load'].details.zeroValue, 0);
assert.equal(good.diagnostic.benchmarkDoctorReady, true);
assert.equal(good.diagnostic.okCount, 6);
assert.equal(good.diagnostic.invocationStatus, 'valid_report');
assert.equal(good.diagnostic.parseSucceeded, true);
assert.equal(good.diagnostic.exitCode, 0);

const warning = report({ 'terminal.env': { status: 'warn', details: terminalDetails } });
warning.overallStatus = 'warn';
const warningError = fails(processResult(warning), 'doctor_benchmark_not_ready');
assert.equal(warningError.diagnostic.warningCount, 1);
assert.deepEqual(warningError.diagnostic.warningCheckIds, ['terminal.env']);
assert.deepEqual(warningError.diagnostic.reviewedNonBlockingFailures, []);

const terminalFail = report({ 'terminal.env': { status: 'fail', details: terminalDetails, issues: terminalIssues } });
terminalFail.overallStatus = 'fail';
const tolerated = parseDoctorResult(processResult(terminalFail, { status: 1 }));
assert.equal(tolerated.diagnostic.invocationStatus, 'valid_report');
assert.equal(tolerated.diagnostic.parseSucceeded, true);
assert.equal(tolerated.diagnostic.failCount, 1);
assert.deepEqual(tolerated.diagnostic.failedCheckIds, ['terminal.env']);
assert.deepEqual(tolerated.diagnostic.reviewedNonBlockingFailures, ['terminal.env']);
assert.equal(tolerated.diagnostic.benchmarkDoctorReady, true);

const critical = report({ 'auth.credentials': { status: 'fail' } }); critical.overallStatus = 'fail';
const criticalError = fails(processResult(critical, { status: 1 }), 'doctor_benchmark_not_ready', 'critical_check_failed');
assert.deepEqual(criticalError.diagnostic.benchmarkCriticalFailures, ['auth.credentials']);
const multiple = report({ 'terminal.env': { status: 'fail', details: terminalDetails, issues: terminalIssues },
  'state.paths': { status: 'fail' } }); multiple.overallStatus = 'fail';
const multipleError = fails(processResult(multiple, { status: 1 }), 'doctor_benchmark_not_ready');
assert.deepEqual(multipleError.diagnostic.benchmarkCriticalFailures, ['state.paths']);
assert.deepEqual(multipleError.diagnostic.reviewedNonBlockingFailures, ['terminal.env']);
const unknown = report({ 'new.SECRET.check': { status: 'fail' },
  'terminal.env': { status: 'fail', details: terminalDetails, issues: terminalIssues } }); unknown.overallStatus = 'fail';
const unknownError = fails(processResult(unknown, { status: 1 }), 'doctor_benchmark_not_ready', 'unknown_check_not_reviewed');
assert.match(unknownError.diagnostic.benchmarkCriticalFailures[0], /^unknown:[0-9a-f]{12}$/);
assert.equal(JSON.stringify(unknownError.diagnostic).includes('SECRET'), false);
const otherTerminal = report({ 'terminal.env': { status: 'fail', details: { ...terminalDetails, TERM: 'xterm' }, issues: terminalIssues } });
otherTerminal.overallStatus = 'fail';
fails(processResult(otherTerminal, { status: 1 }), 'doctor_benchmark_not_ready');
const unrelatedTerminalIssue = report({ 'terminal.env': { status: 'fail', details: terminalDetails,
  issues: [...terminalIssues, { severity: 'fail', fields: ['terminal size'] }] } });
unrelatedTerminalIssue.overallStatus = 'fail';
fails(processResult(unrelatedTerminalIssue, { status: 1 }), 'doctor_benchmark_not_ready');
const wrongModel = report(); wrongModel.checks['config.load'].details.model = 'another-model';
assert.deepEqual(fails(processResult(wrongModel), 'doctor_benchmark_not_ready').diagnostic.benchmarkCriticalFailures, ['config.load']);

fails(processResult(''), 'doctor_empty_output');
fails(processResult('', { stderr: JSON.stringify(report()) }), 'doctor_empty_output');
fails(processResult('{"schemaVersion":1,'), 'doctor_structured_output_invalid');
fails(processResult('{bad json'), 'doctor_structured_output_invalid');
fails(processResult(JSON.stringify(report()) + ' trailing'), 'doctor_structured_output_invalid');
fails(processResult('x'.repeat(MAX_DOCTOR_BYTES + 1)), 'doctor_output_oversized');
fails(processResult('Doctor report: all good'), 'doctor_wrong_output_format');
fails(processResult('', { error: { code: 'ENOBUFS' } }), 'doctor_output_truncated');
fails(processResult('', { status: null, error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }), 'doctor_timeout');
fails(processResult(report(), { signal: 'SIGKILL' }), 'doctor_signaled');
fails(processResult('', { status: 2, stderr: 'SECRET unsupported flag' }), 'doctor_nonzero_exit', 'unsupported_exit_code');
fails(processResult({ ...report(), schemaVersion: 2 }), 'doctor_schema_invalid');
fails(processResult({ ...report(), checks: {} }), 'doctor_schema_invalid');
fails(processResult({ ...report(), codexVersion: null }), 'doctor_schema_invalid');
fails(processResult(terminalFail), 'doctor_exit_report_mismatch');
fails(processResult(report(), { status: 1 }), 'doctor_exit_report_mismatch');
fails(processResult(warning, { status: 1 }), 'doctor_exit_report_mismatch');
fails(processResult(report(), { status: null }), 'doctor_process_start_failed');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-preflight-test-'));
try {
  const sessionId = 'robustness-v1-2026-09-29-r91';
  const dir = path.join(scratch, sessionId); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ ok: false, providerCalls: 0,
    sessionId, preflightId: `${sessionId}/initial`, issueCode: 'doctor_benchmark_not_ready' }));
  fs.writeFileSync(path.join(dir, 'post-push-preflight.json'), JSON.stringify({ ok: true, providerCalls: 0,
    sessionId, preflightId: `${sessionId}/post-push`, benchmarkHead: 'f'.repeat(40) }));
  const runner = cp.spawnSync(process.execPath, [path.join(__dirname, 'run-observation.cjs'), 'R1', 'normal', '--session-id', sessionId], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, ROBUSTNESS_RESULT_ROOT: scratch }, encoding: 'utf8'
  });
  assert.notEqual(runner.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'observations')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ledger.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'infrastructure-stop.json')), false);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log('Codex doctor health and invocation fixtures: PASS (provider/model calls 0)');
