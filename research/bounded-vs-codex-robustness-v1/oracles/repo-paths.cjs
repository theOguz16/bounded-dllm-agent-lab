'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const repo = path.resolve(process.argv[2] || process.cwd());
  const pr = await import(pathToFileURL(path.join(repo, 'dist/packages/repo-intelligence/src/pr-changed-files-adapter.js')).href);
  const git = await import(pathToFileURL(path.join(repo, 'dist/packages/repo-intelligence/src/git-diff-adapter.js')).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'robustness-repo-paths-'));
  try {
    const root = path.join(temp, 'repo');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'good file.ts'), 'ok\n');
    fs.writeFileSync(path.join(temp, 'outside.ts'), 'secret\n');
    fs.writeFileSync(path.join(temp, 'outside.diff'), 'diff --git a/outside.ts b/outside.ts\n');
    fs.symlinkSync(path.join(temp, 'outside.ts'), path.join(root, 'link.ts'));
    const summary = pr.createPrChangedFilesSummary({ rootDir: root, prInput: {
      files: [
        { filename: 'good file.ts', status: 'renamed', previous_filename: 'old file.ts', additions: 1 },
        { filename: '../outside.ts', status: 'modified' },
        { filename: '/etc/passwd', status: 'modified' },
        { filename: 'link.ts', status: 'modified' }
      ],
      changedFiles: ['good file.ts', '../outside.ts', '/etc/passwd', 'link.ts']
    }});
    assert.deepEqual(summary.changedFiles, ['good file.ts']);
    assert.deepEqual(summary.existingChangedFiles, ['good file.ts']);
    assert.equal(summary.files[0].previousFile, 'old file.ts');
    assert.deepEqual(git.parseChangedFilesFromEnv('../outside.ts,/etc/passwd,good file.ts'), ['good file.ts']);
    const diff = git.readGitDiff({ rootDir: root, diffFilePath: '../outside.diff', includeUntracked: false });
    assert.equal(diff.mode, 'empty');
    assert.deepEqual(diff.changedFiles, []);
    assert.ok(diff.diagnostics.length > 0);
    process.stdout.write('repository path behavior PASS\n');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
