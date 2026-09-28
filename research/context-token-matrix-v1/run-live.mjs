#!/usr/bin/env node
import { expectedJournalPath, preflight, preflightStage2, runStage1, runStage2, MODEL } from './live-runtime.mjs';

async function main(args) {
  if (args.length === 1 && args[0] === 'preflight') {
    const result = await preflight();
    process.stderr.write(`PASS: pinned source, doctor, journal, order, and fake-provider context binding; provider calls 0\n`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (args.length === 3 && args[0] === 'live' && args[1] === '--stage' && args[2] === '1') {
    if (process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH !== expectedJournalPath() ||
        process.env.BOUNDED_CODEX_MODEL !== MODEL)
      throw new Error('live execution requires the frozen persistent journal path and model environment');
    const result = await runStage1();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (args.length === 2 && args[0] === 'preflight' && args[1] === '--stage=2') {
    const result = await preflightStage2();
    process.stderr.write('PASS: frozen Stage 2 repetition, journal, source, Docker, and fake-provider binding; provider calls 0\n');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (args.length === 3 && args[0] === 'live' && args[1] === '--stage' && args[2] === '2') {
    if (process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH !== expectedJournalPath() ||
        process.env.BOUNDED_CODEX_MODEL !== MODEL)
      throw new Error('live execution requires the frozen persistent journal path and model environment');
    const result = await runStage2();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  throw new Error('usage: run-live.mjs preflight [--stage=2] | live --stage 1|2');
}
const invokedArguments = process.argv.slice(2);
main(invokedArguments).catch(error => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.stdout.write(JSON.stringify({ preflightSchema: 'context-token-matrix-preflight/v1',
    ok: false, error: error.message,
    providerModelCalls: invokedArguments[0] === 'preflight' ? 0 : null }) + '\n');
  process.exitCode = 1;
});
