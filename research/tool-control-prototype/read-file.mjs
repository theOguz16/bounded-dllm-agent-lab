/** Isolated research proof of a repository-owned, coder-visible MCP read_file tool. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { canonicalizeRepositoryRelativePath } from '../../dist/packages/product-runtime/src/runtime-contract-foundation.js';

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 4096;
export const BOUNDED_TRANSFORMATION = Object.freeze({
  version: 'edge-lines-128/v1', edgeLines: 128, marker: '... [omitted N lines] ...'
});
export const BOUNDED_TRANSFORMATION_HASH = `sha256:${createHash('sha256')
  .update(JSON.stringify(BOUNDED_TRANSFORMATION)).digest('hex')}`;
const EDGE_LINES = BOUNDED_TRANSFORMATION.edgeLines;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = code => { throw Error(`research_read_file_${code}`); };

function boundedText(original) {
  const lines = original.split('\n');
  if (lines.length <= EDGE_LINES * 2) return original;
  return [...lines.slice(0, EDGE_LINES),
    `... [omitted ${lines.length - EDGE_LINES * 2} lines] ...`,
    ...lines.slice(-EDGE_LINES)].join('\n');
}

/** Returns dual views in memory. Only `coder.text` is sent by the MCP server. */
export async function executeReadFile({ checkoutRoot, allowedPaths, mode, arguments: args,
  sequence = 1, now = () => performance.now() }) {
  const started = now();
  if (mode !== 'identity' && mode !== 'bounded') fail('mode_invalid');
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).length !== 1 || !Object.hasOwn(args, 'path')) fail('request_invalid');
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_REQUEST_BYTES) fail('request_oversized');
  let relative;
  try { relative = canonicalizeRepositoryRelativePath(args.path); }
  catch { fail('path_invalid'); }
  if (!Array.isArray(allowedPaths) || !allowedPaths.includes(relative)) fail('path_unauthorized');
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('sequence_invalid');
  const declaredRoot = await fs.lstat(checkoutRoot).catch(() => fail('checkout_invalid'));
  if (declaredRoot.isSymbolicLink() || !declaredRoot.isDirectory()) fail('checkout_invalid');
  const root = await fs.realpath(checkoutRoot).catch(() => fail('checkout_invalid'));
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => fail('file_missing'));
    if (stat.isSymbolicLink()) fail('symlink_rejected');
  }
  const resolved = await fs.realpath(current).catch(() => fail('file_missing'));
  if (resolved !== path.join(root, relative)) fail('path_escape');
  const stat = await fs.lstat(resolved);
  if (!stat.isFile()) fail('file_not_regular');
  if (stat.size > MAX_SOURCE_BYTES) fail('source_oversized');
  const bytes = await fs.readFile(resolved);
  if (bytes.length > MAX_SOURCE_BYTES) fail('source_oversized');
  let original;
  try { original = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('content_invalid'); }
  if (original.includes('\0')) fail('content_invalid');
  const coderText = mode === 'identity' ? original : boundedText(original);
  const coderBytes = Buffer.byteLength(coderText);
  const telemetry = Object.freeze({ toolName: 'read_file', sequence, mode,
    request: Object.freeze({ path: relative }), path: relative,
    originalBytes: bytes.length, coderBytes,
    reductionBytes: bytes.length - coderBytes,
    reductionPercent: bytes.length === 0 ? 0 :
      Math.round((bytes.length - coderBytes) / bytes.length * 10000) / 100,
    sourceHash: sha(bytes), resultHash: sha(coderText),
    transformationVersion: BOUNDED_TRANSFORMATION.version,
    transformationHash: BOUNDED_TRANSFORMATION_HASH, durationMs: Math.max(0, now() - started) });
  return Object.freeze({
    trusted: Object.freeze({ path: relative, originalText: original,
      originalBytes: bytes.length, originalHash: sha(bytes) }),
    coder: Object.freeze({ text: coderText }), telemetry
  });
}

/** A deliberately narrow stdio MCP surface: initialize, tools/list, tools/call. */
export async function serveReadFile({ checkoutRoot, allowedPaths, mode,
  input = process.stdin, output = process.stdout }) {
  let sequence = 0;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { continue; }
    if (message?.method === 'notifications/initialized') continue;
    if (message?.id === undefined || message?.jsonrpc !== '2.0') continue;
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'research-read-file', version: '0.0.1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'read_file', description: 'Read one approved repository file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } },
          required: ['path'], additionalProperties: false } }] };
    } else if (message.method === 'tools/call') {
      try {
        if (message.params?.name !== 'read_file') fail('tool_unknown');
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) fail('request_oversized');
        const read = await executeReadFile({ checkoutRoot, allowedPaths, mode,
          arguments: message.params.arguments, sequence: ++sequence });
        // Trusted original stays inside this process; MCP receives only coder text and bounded metadata.
        result = { content: [{ type: 'text', text: read.coder.text }],
          _meta: { researchTelemetry: read.telemetry } };
      } catch (error) {
        result = { content: [{ type: 'text', text: error.message }], isError: true };
      }
    } else {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Method not found' } }) + '\n');
      continue;
    }
    output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkoutRoot, mode, allowedPath] = process.argv.slice(2);
  if (!checkoutRoot || !mode || !allowedPath || process.argv.length !== 5) fail('startup_invalid');
  serveReadFile({ checkoutRoot, mode, allowedPaths: [allowedPath] }).catch(() => { process.exitCode = 2; });
}
