#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizeCandidateFile } from './candidate-path-authority.mjs';
import { candidateClaimsWithinScope, loadTaskBPlan, stage1Slots } from './task-b-live.mjs';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-path-authority-'));
try {
  const root = path.join(parent, 'candidate');
  const sibling = path.join(parent, 'candidate2');
  const outside = path.join(parent, 'outside');
  for (const directory of [root, sibling, outside]) fs.mkdirSync(directory);
  const file = path.join(root, 'file.txt');
  const siblingFile = path.join(sibling, 'file.txt');
  const outsideFile = path.join(outside, 'file.txt');
  for (const name of [file, siblingFile, outsideFile]) fs.writeFileSync(name, 'fixture\n');
  const canonicalRoot = fs.realpathSync.native(root);
  const canonicalFile = fs.realpathSync.native(file);
  if (os.tmpdir().startsWith('/var/')) {
    assert.notEqual(root, canonicalRoot, 'the host /var alias must reproduce the r2 mismatch');
    assert.ok(canonicalRoot.startsWith('/private/var/'));
  }
  const aliased = authorizeCandidateFile({ authorityRoot: root,
    candidatePath: file, expectedCanonicalRoot: canonicalRoot });
  assert.equal(aliased.lexicalNormalizedPath, file);
  assert.equal(aliased.canonicalNormalizedPath, canonicalFile);
  assert.equal(aliased.authorityCanonicalRoot, canonicalRoot);
  assert.equal(aliased.comparisonOutcome, 'inside_authority');
  assert.equal(authorizeCandidateFile({ authorityRoot: root,
    candidatePath: canonicalFile, expectedCanonicalRoot: canonicalRoot }).comparisonOutcome,
  'inside_authority');
  const rejected = (candidatePath, code, authorityRoot = root, expected = canonicalRoot) =>
    assert.throws(() => authorizeCandidateFile({ authorityRoot, candidatePath,
      expectedCanonicalRoot: expected }), error => error.code === code &&
      error.diagnostic.comparisonOutcome === 'rejected');
  rejected(root, 'lexical_outside_authority');
  rejected(`${root}/../outside/file.txt`, 'parent_traversal');
  rejected(siblingFile, 'lexical_outside_authority');
  rejected(path.join(root, 'missing', 'file.txt'), 'candidate_path_unavailable');
  fs.symlinkSync(outsideFile, path.join(root, 'escape.txt'));
  rejected(path.join(root, 'escape.txt'), 'symlink_component');
  const aliasRoot = path.join(parent, 'authorized-alias');
  fs.symlinkSync(root, aliasRoot, 'dir');
  assert.equal(authorizeCandidateFile({ authorityRoot: aliasRoot,
    candidatePath: path.join(aliasRoot, 'file.txt'),
    expectedCanonicalRoot: canonicalRoot }).canonicalNormalizedPath, canonicalFile);
  const wrongAlias = path.join(parent, 'wrong-alias');
  fs.symlinkSync(outside, wrongAlias, 'dir');
  rejected(path.join(wrongAlias, 'file.txt'), 'authority_root_changed', wrongAlias, canonicalRoot);
  assert.equal(candidateClaimsWithinScope([
    { file: 'packages/integrations/src/codex-event-parser.ts' },
    { file: 'scripts/smoke/codex-event-parser-smoke.cjs' }]), true);
  assert.equal(candidateClaimsWithinScope([{ file: 'packages/integrations/src/other.ts' }]), false);
  assert.equal(candidateClaimsWithinScope([{ file: '../escape.txt' }]), false);
  const plan = loadTaskBPlan();
  assert.equal(plan.task.taskHash,
    'sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0');
  assert.deepEqual(stage1Slots(plan, 'task-b-stage1-offline-path').map(x => `${x.replicate}:${x.variant}`),
    ['A:minimal', 'A:current', 'A:expanded', 'B:current', 'B:expanded', 'B:minimal']);
  console.log('Task B canonical Candidate path authority and r2 host alias: PASS (provider/model calls 0)');
} finally { fs.rmSync(parent, { recursive: true, force: true }); }
