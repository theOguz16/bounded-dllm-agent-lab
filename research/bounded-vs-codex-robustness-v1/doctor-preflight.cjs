'use strict';
const crypto = require('node:crypto');

const MAX_DOCTOR_BYTES = 1024 * 1024;
const NORMAL_DOCTOR_ARGS = Object.freeze([
  '--strict-config', 'doctor', '--json', '-c', 'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="medium"'
]);

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
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === 'string' ? result.signal : null,
    timedOut: result?.error?.code === 'ETIMEDOUT',
    stdoutBytes,
    stderrBytes,
    structuredStream: 'stdout',
    structuredFormat: 'single-json-document',
    parseSucceeded: false,
    evidenceHash: `sha256:${crypto.createHash('sha256').update(evidence).digest('hex')}`
  };
  const fail = (issue, reason) => { throw new DoctorPreflightError(issue, reason, diagnostic); };
  if (diagnostic.timedOut) fail('doctor_timeout', 'process_timeout');
  if (result?.error?.code === 'ENOBUFS') fail('doctor_output_truncated', 'spawn_buffer_limit');
  if (!result || result.error || diagnostic.exitCode === null) fail('doctor_process_start_failed', 'spawn_error');
  if (diagnostic.signal) fail('doctor_signaled', 'process_signal');
  if (stdoutBytes > MAX_DOCTOR_BYTES || stderrBytes > MAX_DOCTOR_BYTES) fail('doctor_output_oversized', 'output_limit');
  if (result.status !== 0) fail('doctor_nonzero_exit', 'doctor_exit_not_zero');
  if (stdoutBytes === 0) fail('doctor_empty_output', stderrBytes > 0 ? 'stdout_empty_stderr_present' : 'stdout_empty');
  if (!stdout.trimStart().startsWith('{')) fail('doctor_wrong_output_format', 'not_json_document');
  let report;
  try { report = JSON.parse(stdout); }
  catch {
    fail('doctor_structured_output_invalid', 'invalid_json_document');
  }
  diagnostic.parseSucceeded = true;
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.schemaVersion !== 1 ||
      !['ok', 'warn', 'fail'].includes(report.overallStatus) ||
      !report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks)) {
    fail('doctor_schema_invalid', 'report_shape');
  }
  if (report.overallStatus !== 'ok') fail('doctor_report_failed', 'overall_status_not_ok');
  return { report, diagnostic };
}

module.exports = { MAX_DOCTOR_BYTES, NORMAL_DOCTOR_ARGS, DoctorPreflightError, parseDoctorResult };
