#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function prepareBoundedConfig(sourceRoot) {
  const absolute = path.resolve(sourceRoot);
  const mod = await import(pathToFileURL(path.join(absolute, 'dist/apps/cli/src/product-config.js')).href);
  const directory = path.join(absolute, '.bounded');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(await mod.detectBoundedLocalConfig(absolute), null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(directory, '.gitignore'), mod.BOUNDED_GITIGNORE_CONTENT, { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'policy.yml'), mod.BOUNDED_DEFAULT_POLICY_CONTENT, { flag: 'wx' });
}
module.exports = { prepareBoundedConfig };
if (require.main === module) prepareBoundedConfig(process.argv[2] || process.cwd()).catch(error => { console.error(error.message); process.exitCode = 1; });
