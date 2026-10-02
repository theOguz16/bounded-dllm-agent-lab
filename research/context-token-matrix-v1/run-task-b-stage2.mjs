#!/usr/bin/env node
import { preflightTaskBStage2, runTaskBStage2 } from './task-b-stage2-executor.mjs';
const args = process.argv.slice(2);
try {
  if (![3, 5].includes(args.length) || args[1] !== '--session-id' ||
      (args.length === 5 && args[3] !== '--plan-path') ||
      !['preflight', 'live'].includes(args[0]))
    throw Error('usage: run-task-b-stage2.mjs preflight|live --session-id ID [--plan-path PATH]');
  const options = { sessionId: args[2], ...(args.length === 5 ? { planPath: args[4] } : {}) };
  const result = args[0] === 'preflight'
    ? await preflightTaskBStage2(options)
    : await runTaskBStage2(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: error.message,
    providerModelCalls: args[0] === 'preflight' ? 0 : null }) + '\n');
  process.exitCode = 1;
}
