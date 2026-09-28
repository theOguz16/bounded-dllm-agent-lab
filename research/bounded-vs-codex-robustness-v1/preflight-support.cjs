'use strict';
const LOGIN_MESSAGES = new Set([
  'Logged in using ChatGPT',
  'Logged in using an API key'
]);
function codexLoginReady(result) {
  if (!result || result.error || result.signal || result.status !== 0 ||
      typeof result.stdout !== 'string' || typeof result.stderr !== 'string') return false;
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.length === 1 && LOGIN_MESSAGES.has(lines[0]);
}
module.exports = { codexLoginReady };
