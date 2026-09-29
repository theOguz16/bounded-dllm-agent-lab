'use strict';
const crypto = require('node:crypto');

const MAX_DOCTOR_BYTES = 1024 * 1024;
const NORMAL_DOCTOR_ARGS = Object.freeze([
  '--strict-config', 'doctor', '--json', '-c', 'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="medium"'
]);
// Check IDs observed in the installed Codex 0.154.0 structured report.
const KNOWN_CHECK_IDS = new Set([
  'app_server.status', 'auth.credentials', 'config.load', 'desktop.app.version',
  'desktop.app_server.handshake', 'desktop.security.enforcement', 'git.environment',
  'installation', 'mcp.config', 'network.env', 'network.provider_reachability',
  'network.websocket_reachability', 'runtime.provenance', 'runtime.search',
  'sandbox.helpers', 'security.endpoint', 'state.paths', 'state.rollout_db_parity',
  'system.disk', 'system.environment', 'terminal.env', 'terminal.title', 'updates.status'
]);
const REQUIRED_CHECK_IDS = ['auth.credentials', 'config.load', 'network.provider_reachability',
  'runtime.provenance', 'git.environment', 'state.paths'];

class DoctorPreflightError extends Error {
  constructor(issueCode, reasonCode, diagnostic) {
    super(`Codex doctor preflight failed: ${issueCode}/${reasonCode}`);
    this.name = 'DoctorPreflightError';
    this.issueCode = issueCode;
    this.reasonCode = reasonCode;
    this.diagnostic = { ...diagnostic, issueCode, reasonCode };
  }
}

function parseDoctorResult(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const stdoutBytes = Buffer.byteLength(stdout);
  const stderrBytes = Buffer.byteLength(stderr);
  const evidence = Buffer.concat([
    Buffer.from(stdout).subarray(0, 4096), Buffer.from([0]), Buffer.from(stderr).subarray(0, 4096)
  ]);
  const diagnostic = {
    invocationStatus: 'invalid',
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === 'string' ? result.signal : null,
    timedOut: result?.error?.code === 'ETIMEDOUT',
    stdoutBytes,
    stderrBytes,
    structuredStream: 'stdout',
    structuredFormat: 'single-json-document',
    parseSucceeded: false,
    schemaVersion: null,
    overallStatus: null,
    codexVersion: null,
    okCount: 0,
    warningCount: 0,
    failCount: 0,
    failedCheckIds: [],
    warningCheckIds: [],
    benchmarkCriticalFailures: [],
    reviewedNonBlockingFailures: [],
    benchmarkDoctorReady: false,
    evidenceHash: `sha256:${crypto.createHash('sha256').update(evidence).digest('hex')}`
  };
  const fail = (issue, reason) => { throw new DoctorPreflightError(issue, reason, diagnostic); };
  if (diagnostic.timedOut) fail('doctor_timeout', 'process_timeout');
  if (result?.error?.code === 'ENOBUFS') fail('doctor_output_truncated', 'spawn_buffer_limit');
  if (!result || result.error || diagnostic.exitCode === null) fail('doctor_process_start_failed', 'spawn_error');
  if (diagnostic.signal) fail('doctor_signaled', 'process_signal');
  if (stdoutBytes > MAX_DOCTOR_BYTES || stderrBytes > MAX_DOCTOR_BYTES) fail('doctor_output_oversized', 'output_limit');
  if (result.status !== 0 && result.status !== 1) fail('doctor_nonzero_exit', 'unsupported_exit_code');
  if (stdoutBytes === 0) fail('doctor_empty_output', stderrBytes > 0 ? 'stdout_empty_stderr_present' : 'stdout_empty');
  if (!stdout.trimStart().startsWith('{')) fail('doctor_wrong_output_format', 'not_json_document');
  let report;
  try { report = JSON.parse(stdout); }
  catch { fail('doctor_structured_output_invalid', 'invalid_json_document'); }
  diagnostic.parseSucceeded = true;
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.schemaVersion !== 1 ||
      !['ok', 'warn', 'fail'].includes(report.overallStatus) ||
      typeof report.codexVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(report.codexVersion) ||
      !report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks) ||
      Object.keys(report.checks).length === 0 ||
      REQUIRED_CHECK_IDS.some(id => !Object.hasOwn(report.checks, id))) {
    fail('doctor_schema_invalid', 'report_shape');
  }
  diagnostic.schemaVersion = report.schemaVersion;
  diagnostic.overallStatus = report.overallStatus;
  diagnostic.codexVersion = report.codexVersion;
  const checks = Object.entries(report.checks);
  if (checks.length > 64 || checks.some(([id, check]) => !id ||
      !check || typeof check !== 'object' || Array.isArray(check) ||
      !['ok', 'warn', 'fail'].includes(check.status) ||
      (check.category !== undefined && typeof check.category !== 'string'))) {
    fail('doctor_schema_invalid', 'check_shape');
  }
  const safeId = id => KNOWN_CHECK_IDS.has(id) ? id :
    `unknown:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
  for (const [id, check] of checks) {
    if (check.status === 'ok') diagnostic.okCount++;
    else if (check.status === 'warn') { diagnostic.warningCount++; diagnostic.warningCheckIds.push(safeId(id)); }
    else { diagnostic.failCount++; diagnostic.failedCheckIds.push(safeId(id)); }
  }
  const expectedOverall = diagnostic.failCount ? 'fail' : diagnostic.warningCount ? 'warn' : 'ok';
  if (report.overallStatus !== expectedOverall ||
      !((result.status === 0 && expectedOverall !== 'fail') ||
        (result.status === 1 && expectedOverall === 'fail'))) {
    fail('doctor_exit_report_mismatch', 'exit_or_health_inconsistent');
  }
  diagnostic.invocationStatus = 'valid_report';
  // codex exec --json is headless. Only this measured noninteractive condition
  // is reviewed as unrelated to structured execution, telemetry, and isolation.
  const terminalCheck = report.checks['terminal.env'];
  const details = terminalCheck?.details;
  const terminalIssues = terminalCheck?.issues;
  const reviewedTerminal = details && details.TERM === 'dumb' && details.terminal === 'dumb' &&
    details['stdin is terminal'] === 'false' && details['stdout is terminal'] === 'false' &&
    details['stderr is terminal'] === 'false' &&
    Array.isArray(terminalIssues) && terminalIssues.length === 1 &&
    terminalIssues[0]?.severity === 'fail' &&
    Array.isArray(terminalIssues[0].fields) && terminalIssues[0].fields.length === 1 &&
    terminalIssues[0].fields[0] === 'TERM';
  for (const [id, check] of checks) {
    if (check.status === 'ok') continue;
    if (id === 'terminal.env' && check.status === 'fail' && reviewedTerminal) diagnostic.reviewedNonBlockingFailures.push(id);
    else diagnostic.benchmarkCriticalFailures.push(safeId(id));
  }
  if (report.checks['config.load'].details?.model !== 'gpt-5.6-luna' &&
      !diagnostic.benchmarkCriticalFailures.includes('config.load')) {
    diagnostic.benchmarkCriticalFailures.push('config.load');
  }
  diagnostic.benchmarkDoctorReady = diagnostic.benchmarkCriticalFailures.length === 0;
  if (!diagnostic.benchmarkDoctorReady) fail('doctor_benchmark_not_ready',
    diagnostic.benchmarkCriticalFailures.some(id => id.startsWith('unknown:')) ?
      'unknown_check_not_reviewed' : 'critical_check_failed');
  return { report, diagnostic };
}

const PERSISTED_DIAGNOSTIC_FIELDS = Object.freeze([
  'invocationStatus', 'exitCode', 'signal', 'timedOut', 'stdoutBytes', 'stderrBytes',
  'structuredStream', 'structuredFormat', 'reportParsed', 'schemaVersion',
  'overallStatus', 'codexVersion',
  'okCount', 'warningCount', 'failCount', 'failedCheckIds', 'warningCheckIds',
  'benchmarkCriticalFailures', 'reviewedNonBlockingFailures', 'benchmarkDoctorReady',
  'issueCode', 'reasonCode', 'evidenceHash'
]);
function persistedDoctorDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  const source = { ...diagnostic, reportParsed: diagnostic.parseSucceeded,
    issueCode: diagnostic.issueCode ?? null, reasonCode: diagnostic.reasonCode ?? null };
  return Object.fromEntries(PERSISTED_DIAGNOSTIC_FIELDS.map(field => [field, source[field]]));
}

module.exports = { MAX_DOCTOR_BYTES, NORMAL_DOCTOR_ARGS, DoctorPreflightError,
  parseDoctorResult, persistedDoctorDiagnostic, PERSISTED_DIAGNOSTIC_FIELDS };
