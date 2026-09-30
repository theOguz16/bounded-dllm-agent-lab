#!/usr/bin/env node
import { preflightTaskBSuffix, runTaskBSuffix } from './task-b-suffix-executor.mjs';

const args = process.argv.slice(2);
async function main() {
  if (args.length !== 3 || args[1] !== '--session-id' ||
      !['preflight', 'live'].includes(args[0]))
    throw Error('usage: run-task-b-suffix.mjs preflight|live --session-id ID');
  const result = args[0] === 'preflight'
    ? await preflightTaskBSuffix({ sessionId: args[2] })
    : await runTaskBSuffix({ sessionId: args[2] });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: error.message,
    providerModelCalls: args[0] === 'preflight' ? 0 : null }) + '\n');
  process.exitCode = 1;
});
