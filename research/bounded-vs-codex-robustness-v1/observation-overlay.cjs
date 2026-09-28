'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const SOURCE = 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9';
const FILES = [
  'packages/integrations/src/codex-coder-trajectory.js',
  'packages/integrations/src/codex-agent-adapter.js',
  'apps/cli/src/commands/codex.js'
];

function installObservationOverlay(checkout, harness = path.resolve(__dirname, '../..')) {
  const head = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== SOURCE) throw Error('overlay source SHA mismatch');
  const copied = [];
  for (const relative of FILES) {
    const source = path.join(harness, 'dist', relative);
    const target = path.join(checkout, 'dist', relative);
    if (!fs.statSync(source).isFile() || !fs.statSync(path.dirname(target)).isDirectory())
      throw Error(`overlay artifact unavailable: ${relative}`);
    fs.copyFileSync(source, target);
    copied.push(relative);
  }
  const status = cp.spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: checkout, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim() !== '')
    throw Error('overlay changed source checkout state');
  return Object.freeze({ schemaVersion: 'robustness-bounded-observation-overlay/v1',
    sourceHead: SOURCE, files: copied, trackedSourceUnchanged: true });
}
module.exports = { installObservationOverlay, FILES, SOURCE };
