/** Narrow, per-run Codex MCP registration for the identity integration proof. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVED_SOURCE_PATH = 'packages/integrations/src/codex-event-parser.ts';
export const MCP_SERVER_NAME = 'research_read_file';
export const MCP_TOOL_NAME = 'read_file';
export const MCP_SCRIPT_PATH = fileURLToPath(new URL('./read-file.mjs', import.meta.url));

export function readFileMcpConfig(checkoutRoot, mode, nodeExecutable = process.execPath) {
  if (mode !== 'identity' && mode !== 'bounded') throw Error('MCP mode invalid');
  if (!path.isAbsolute(checkoutRoot) || !path.isAbsolute(nodeExecutable)) {
    throw Error('identity MCP requires absolute checkout and executable paths');
  }
  return { mcp_servers: { [MCP_SERVER_NAME]: {
    command: nodeExecutable,
    args: [MCP_SCRIPT_PATH, checkoutRoot, mode, APPROVED_SOURCE_PATH],
    tools: { [MCP_TOOL_NAME]: { approval_mode: 'approve' } }
  } } };
}

export function identityMcpConfig(checkoutRoot, nodeExecutable = process.execPath) {
  return readFileMcpConfig(checkoutRoot, 'identity', nodeExecutable);
}
