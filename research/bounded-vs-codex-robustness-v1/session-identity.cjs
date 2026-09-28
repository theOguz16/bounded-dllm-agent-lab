'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SESSION_PATTERN = /^robustness-v1-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-r[1-9]\d*$/;
function parseSessionId(args) {
  const values = args.flatMap((arg, index) => arg === '--session-id' ? [args[index + 1]] : arg.startsWith('--session-id=') ? [arg.slice(13)] : []);
  if (values.length !== 1 || !values[0] || !SESSION_PATTERN.test(values[0]) ||
      args.some((arg, index) => arg === '--session-id' && (!args[index + 1] || args[index + 1].startsWith('--')))) {
    throw Error('exactly one valid --session-id robustness-v1-YYYY-MM-DD-rN is required');
  }
  return values[0];
}
function sessionPath(resultsRoot, sessionId) {
  if (!SESSION_PATTERN.test(sessionId)) throw Error('invalid session ID');
  return path.join(resultsRoot, sessionId);
}
function assertUnusedSession(resultsRoot, sessionId) {
  const dir = sessionPath(resultsRoot, sessionId);
  if (fs.existsSync(dir)) throw Error(`session identity already exists and cannot be resumed: ${sessionId}`);
  return dir;
}
function observationSlots(manifest, sessionId) {
  if (!SESSION_PATTERN.test(sessionId)) throw Error('invalid session ID');
  return manifest.tasks.flatMap((task, taskIndex) => task.order.map((system, armIndex) => ({
    observationId: `${sessionId}/${manifest.benchmarkVersion}/${task.taskHash}/${system}/${taskIndex * 2 + armIndex + 1}`,
    obsId: `${task.taskId}-${system}`, taskId: task.taskId, taskHash: task.taskHash,
    system, executionPosition: taskIndex * 2 + armIndex + 1
  })));
}
function assertPreflightBinding(pre, post, sessionId, head) {
  if (!pre?.ok || !post?.ok || pre.providerCalls !== 0 || post.providerCalls !== 0 ||
      pre.sessionId !== sessionId || post.sessionId !== sessionId ||
      pre.preflightId !== `${sessionId}/initial` || post.preflightId !== `${sessionId}/post-push` ||
      pre.benchmarkHead !== post.benchmarkHead || (head && post.benchmarkHead !== head)) {
    throw Error('preflight session identity or gates mismatch');
  }
}
function preflightRecord(sessionId, mode, fields) {
  if (!SESSION_PATTERN.test(sessionId) || !['initial', 'post-push'].includes(mode)) throw Error('invalid preflight identity');
  return { ...fields, schemaVersion: 'robustness-preflight/v2', preflightId: `${sessionId}/${mode}`, sessionId };
}
function assertObservationAvailable(ledger, slots, obsId, obsDir) {
  if (!Array.isArray(ledger) || ledger.length >= slots.length || slots[ledger.length].obsId !== obsId ||
      ledger.some((entry, index) => entry.sessionId !== slots[index].observationId.split('/')[0] ||
        entry.observationId !== slots[index].observationId || entry.obsId !== slots[index].obsId || entry.state !== 'completed') ||
      fs.existsSync(obsDir)) throw Error('observation order or identity already consumed');
}
module.exports = { parseSessionId, sessionPath, assertUnusedSession, observationSlots, assertPreflightBinding, preflightRecord, assertObservationAvailable };
