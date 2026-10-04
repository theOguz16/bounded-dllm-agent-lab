#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { executeReadFile } from './read-file.mjs';

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'research-owned-read-file-'));
const checkout = path.join(temp, 'checkout');
const original = ['alpha', 'beta', ...Array.from({ length: 20 }, (_, i) =>
  `middle-${String(i).padStart(2, '0')}-${'x'.repeat(20)}`), 'epsilon', 'zeta'].join('\n');
const serverPath = fileURLToPath(new URL('./read-file.mjs', import.meta.url));
const repoPath = 'src/example.txt';

async function fakeCoderCall(mode) {
  const child = spawn(process.execPath, [serverPath, checkout, mode, repoPath],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const iterator = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const next = await Promise.race([iterator.next(), new Promise((_, reject) =>
      setTimeout(() => reject(Error('offline MCP response timeout')), 2000))]);
    assert.equal(next.done, false);
    const response = JSON.parse(next.value);
    assert.equal(response.id, id);
    return response.result;
  };
  try {
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.serverInfo.name, 'research-read-file');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request(2, 'tools/list');
    assert.deepEqual(tools.tools.map(tool => tool.name), ['read_file']);
    const result = await request(3, 'tools/call',
      { name: 'read_file', arguments: { path: repoPath } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    // Fake coder carries the repository-constructed tool text into its next message.
    const nextCoderMessage = { role: 'tool', content: result.content[0].text };
    return { nextCoderMessage, telemetry: result._meta.researchTelemetry };
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.once('exit', resolve));
  }
}

try {
  await fs.mkdir(path.join(checkout, 'src'), { recursive: true });
  await fs.writeFile(path.join(checkout, repoPath), original);
  await fs.writeFile(path.join(checkout, 'src/other.txt'), 'outside authority');
  await fs.writeFile(path.join(temp, 'outside.txt'), 'outside checkout');
  await fs.symlink(path.join(temp, 'outside.txt'), path.join(checkout, 'src/link.txt'));
  await fs.symlink(temp, path.join(checkout, 'src/linkdir'));
  const options = { checkoutRoot: checkout, allowedPaths: [repoPath],
    arguments: { path: repoPath }, now: () => 10 };
  const identity = await executeReadFile({ ...options, mode: 'identity' });
  const bounded = await executeReadFile({ ...options, mode: 'bounded' });
  const boundedAgain = await executeReadFile({ ...options, mode: 'bounded' });
  assert.equal(identity.coder.text, original);
  assert.equal(identity.trusted.originalText, original);
  assert.equal(bounded.trusted.originalText, original);
  assert.equal(bounded.trusted.originalHash, sha(original));
  assert.equal(bounded.coder.text, 'alpha\nbeta\n... [omitted 20 lines] ...\nepsilon\nzeta');
  assert.notEqual(bounded.coder.text, original);
  assert.ok(Buffer.byteLength(bounded.coder.text) < Buffer.byteLength(original));
  assert.equal(bounded.coder.text, boundedAgain.coder.text);
  assert.equal(bounded.telemetry.originalBytes, Buffer.byteLength(original));
  assert.equal(bounded.telemetry.coderBytes, Buffer.byteLength(bounded.coder.text));
  assert.equal(bounded.telemetry.reductionBytes,
    bounded.telemetry.originalBytes - bounded.telemetry.coderBytes);
  assert.equal(bounded.telemetry.toolName, 'read_file');
  assert.equal(bounded.telemetry.mode, 'bounded');
  assert.equal(bounded.telemetry.resultHash, sha(bounded.coder.text));
  assert.equal(JSON.stringify(bounded.telemetry).includes(original), false);
  assert.equal(identity.telemetry.reductionBytes, 0);
  for (const [args, allowedPaths] of [
    [{ path: '../outside.txt' }, [repoPath]],
    [{ path: '/etc/passwd' }, [repoPath]],
    [{ path: 'src/other.txt' }, [repoPath]],
    [{ path: 'src/missing.txt' }, ['src/missing.txt']],
    [{ path: 'src/link.txt' }, ['src/link.txt']],
    [{ path: 'src/linkdir/outside.txt' }, ['src/linkdir/outside.txt']],
    [{ path: repoPath, extra: 'x' }, [repoPath]],
    [{ path: 'x'.repeat(5000) }, [repoPath]]
  ]) await assert.rejects(executeReadFile({ ...options, arguments: args, allowedPaths,
    mode: 'identity' }));
  await fs.writeFile(path.join(checkout, 'src/binary.txt'), Buffer.from([0xff, 0x00]));
  await assert.rejects(executeReadFile({ ...options, arguments: { path: 'src/binary.txt' },
    allowedPaths: ['src/binary.txt'], mode: 'identity' }));
  const identityMcp = await fakeCoderCall('identity');
  const boundedMcp = await fakeCoderCall('bounded');
  assert.equal(identityMcp.nextCoderMessage.content, original);
  assert.equal(boundedMcp.nextCoderMessage.content, bounded.coder.text);
  assert.notEqual(identityMcp.nextCoderMessage.content, boundedMcp.nextCoderMessage.content);
  assert.equal(boundedMcp.telemetry.originalBytes, Buffer.byteLength(original));
  assert.equal(boundedMcp.telemetry.coderBytes, Buffer.byteLength(bounded.coder.text));
  assert.deepEqual((await fs.readdir(temp)).sort(), ['checkout', 'outside.txt']);
  console.log('repository-owned read_file offline PASS; provider/model calls 0; native shell interception 0');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
