#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { codexLoginReady } = require('./preflight-support.cjs');
const { installObservationOverlay } = require('./observation-overlay.cjs');
const { parseSessionId, sessionPath, assertUnusedSession, observationSlots, preflightRecord } = require('./session-identity.cjs');
const { MAX_DOCTOR_BYTES, NORMAL_DOCTOR_ARGS, parseDoctorResult, persistedDoctorDiagnostic } = require('./doctor-preflight.cjs');
const root = __dirname;
const repo = path.resolve(root, '../..');
const branchName = 'research/bounded-vs-codex-robustness-v1';
const freezeCommit = 'eb0b501ba6d106730ba15c0e7f3dc3a5e4f5b496';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'benchmark-manifest.json'), 'utf8'));
const resultsRoot = process.env.ROBUSTNESS_RESULT_ROOT || path.join(os.homedir(), '.bounded-agent', 'bounded-dllm-agent-lab', 'live-runs', 'bounded-vs-codex-robustness-v1');
const args = process.argv.slice(2);
const sessionId = parseSessionId(args);
const sessionDir = sessionPath(resultsRoot, sessionId);
const postPush = args.includes('--post-push');
const expectedHead = args.find(x => x.startsWith('--expected-head='))?.slice(16);
const expectedRemote = args.find(x => x.startsWith('--expected-remote='))?.slice(18);
const checks = [];
const invoked = [];
let scratch;
let sessionCreated = false;
let doctorDiagnostic = null;
function check(name, ok, detail = '') {
  checks.push({ name, ok: ok === true, detail: String(detail) });
  if (ok !== true) throw Error(`${name}: ${detail}`);
}
function probe(command, commandArgs, cwd = repo, timeout = 120000, env = process.env, maxBuffer = 8 * 1024 * 1024) {
  invoked.push({ command, args: commandArgs });
  return cp.spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', timeout, maxBuffer });
}
function success(result, label) {
  if (result.error || result.signal || result.status !== 0) throw Error(`${label}: ${String(result.error?.message || result.stderr || result.stdout).slice(0, 1200)}`);
  return result.stdout.trim();
}
function run(command, commandArgs, cwd, timeout, env) { return success(probe(command, commandArgs, cwd, timeout, env), command); }
function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
function sha(x) { return `sha256:${crypto.createHash('sha256').update(canon(x)).digest('hex')}`; }
function freezeFile(rel) { return run('git', ['show', `${freezeCommit}:${rel}`], repo); }
function freshSourceCheckout() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'robustness-preflight-'));
  const candidate = path.join(scratch, 'source');
  run('git', ['clone', '--local', '--no-hardlinks', '--quiet', repo, candidate], repo);
  run('git', ['checkout', '--detach', manifest.sourceHead], candidate);
  return candidate;
}
function checkPaths(candidate) {
  const allowed = ['.bounded/.gitignore', '.bounded/config.json', '.bounded/policy.yml'];
  const trackedDiff = run('git', ['diff', '--name-only', 'HEAD'], candidate);
  const extra = run('git', ['ls-files', '--others', '--exclude-standard'], candidate).split('\n').filter(Boolean).sort();
  check('no Candidate source contamination', trackedDiff === '' && JSON.stringify(extra) === JSON.stringify(allowed), JSON.stringify({ trackedDiff, extra }));
}
try {
  check('expected HEAD argument', /^[0-9a-f]{40}$/.test(expectedHead || ''), expectedHead || 'missing');
  check('preflight identity', !!sessionId, sessionId);
  check('persistent output root', path.isAbsolute(resultsRoot) && !resultsRoot.startsWith(repo + path.sep) && !resultsRoot.startsWith('/private/tmp/') && !resultsRoot.startsWith('/tmp/'), resultsRoot);
  if (!postPush) check('unused session directory', assertUnusedSession(resultsRoot, sessionId) === sessionDir, sessionDir);
  const currentBranch = run('git', ['branch', '--show-current'], repo);
  check('benchmark branch', currentBranch === branchName, currentBranch);
  const head = run('git', ['rev-parse', 'HEAD'], repo);
  check('local HEAD', head === expectedHead, head);
  check('local tree clean', run('git', ['status', '--porcelain=v1'], repo) === '', head);
  run('git', ['merge-base', '--is-ancestor', freezeCommit, head], repo);
  const sourceType = run('git', ['cat-file', '-t', manifest.sourceHead], repo);
  check('source SHA', manifest.sourceHead === 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9' && sourceType === 'commit', manifest.sourceHead);
  check('protocol frozen', fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8').trimEnd() === freezeFile('research/bounded-vs-codex-robustness-v1/PROTOCOL.md').trimEnd(), 'exact freeze-commit content');
  const frozen = JSON.parse(freezeFile('research/bounded-vs-codex-robustness-v1/benchmark-manifest.json'));
  const { sessionId: historicalSessionId, ...frozenDefinition } = frozen;
  check('frozen benchmark definition', JSON.stringify(manifest) === JSON.stringify(frozenDefinition), 'all benchmark variables unchanged; historical session excluded');
  check('manifest valid', manifest.benchmarkVersion === frozen.benchmarkVersion && manifest.sourceHead === frozen.sourceHead && manifest.model === 'gpt-5.6-luna' && manifest.reasoning === 'medium', 'schema/source/model');
  check('five frozen tasks', manifest.tasks.length === 5 && JSON.stringify(manifest.tasks) === JSON.stringify(frozen.tasks), 'task entries exactly equal freeze commit');
  check('difficulty labels', manifest.tasks.map(t => t.difficulty).join(',') === 'easy,medium_a,medium_b,medium_c,hard', 'easy/3 medium/hard');
  check('execution order', manifest.tasks.map(t => t.order.join('/')).join(',') === 'normal/bounded,bounded/normal,normal/bounded,bounded/normal,normal/bounded', 'counterbalanced');
  for (const task of manifest.tasks) {
    const { taskHash, ...definition } = task;
    check(`${task.taskId} hash`, sha(definition) === taskHash, taskHash);
    check(`${task.taskId} model/reasoning/source`, task.model === manifest.model && task.reasoning === manifest.reasoning && task.sourceHead === manifest.sourceHead, task.taskId);
    check(`${task.taskId} no retry/repair/apply`, task.policy.retry === 0 && task.policy.repair === 0 && task.policy.apply === 0 && task.policy.boundedContext === 'production-current' && task.policy.plannerBypass === false, task.taskId);
  }
  for (const file of fs.readdirSync(path.join(root, 'oracles'))) {
    const rel = `research/bounded-vs-codex-robustness-v1/oracles/${file}`;
    check(`oracle frozen ${file}`, fs.readFileSync(path.join(root, 'oracles', file), 'utf8').trimEnd() === freezeFile(rel).trimEnd(), file);
  }
  if (postPush) {
    const initial = JSON.parse(fs.readFileSync(path.join(sessionDir, 'preflight.json'), 'utf8'));
    check('initial preflight PASS', initial.ok === true && initial.providerCalls === 0 && initial.benchmarkHead === head && initial.sessionId === sessionId && initial.preflightId === `${sessionId}/initial`, initial.at);
  }
  check('all ten run identities unused', observationSlots(manifest, sessionId).length === 10 && !fs.existsSync(path.join(sessionDir, 'ledger.json')) && !fs.existsSync(path.join(sessionDir, 'observations')), sessionDir);
  if (!postPush) {
    fs.mkdirSync(resultsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionDir, { mode: 0o700 });
    sessionCreated = true;
  }
  fs.accessSync(sessionDir, fs.constants.W_OK);
  check('output root writable', true, sessionDir);
  const journal = path.join(sessionDir, 'provider-invocations.sqlite');
  check('Bounded journal path and unused state', !fs.existsSync(journal) && !journal.startsWith(repo + path.sep), journal);
  const docker = run('docker', ['info', '--format', '{{.ServerVersion}}'], repo);
  check('Docker available', /^\d+\./.test(docker), docker);
  const executable = run('codex', ['--version'], repo);
  check('Normal Codex executable', /^codex-cli \d+\./.test(executable), executable);
  const login = probe('codex', ['login', 'status'], repo, 10000);
  check('Normal Codex authentication', codexLoginReady(login), `exit=${login.status}; accepted status message=${codexLoginReady(login)}`);
  const cliHelp = run('codex', ['exec', '--help'], repo);
  check('Normal explicit model/reasoning capability', cliHelp.includes('--model') && cliHelp.includes('--config'), 'codex exec flags');
  const doctor = probe('codex', NORMAL_DOCTOR_ARGS, repo, 30000, process.env, MAX_DOCTOR_BYTES);
  const parsedDoctor = parseDoctorResult(doctor);
  doctorDiagnostic = parsedDoctor.diagnostic;
  const report = parsedDoctor.report;
  check('Normal exact model config', report.checks?.['config.load']?.status === 'ok' && report.checks?.['config.load']?.details?.model === 'gpt-5.6-luna', 'doctor JSON config');
  check('Normal provider reachability', report.checks?.['network.provider_reachability']?.status === 'ok', 'doctor endpoint');
  check('Bounded reasoning capability', fs.readFileSync(path.join(repo, 'packages/integrations/src/codex-agent-adapter.ts'), 'utf8').includes('case "medium": return "medium";') && fs.readFileSync(path.join(repo, 'packages/integrations/src/codex-agent-adapter.ts'), 'utf8').includes('modelReasoningEffort: mapReasoningEffort(request.reasoningEffort)'), 'baseline SDK adapter maps medium');
  const candidate = freshSourceCheckout();
  check('disposable source checkout', run('git', ['rev-parse', 'HEAD'], candidate) === manifest.sourceHead, candidate);
  run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], candidate);
  check('deterministic pinned dependencies', fs.existsSync(path.join(candidate, 'node_modules/typescript/package.json')), 'npm ci offline');
  run('npm', ['run', 'build'], candidate);
  check('pinned build PASS', fs.existsSync(path.join(candidate, 'dist/apps/cli/src/index.js')), 'compiled CLI');
  run('npm', ['run', 'build'], repo);
  const overlay = installObservationOverlay(candidate, repo);
  check('Bounded observation overlay', overlay.trackedSourceUnchanged === true && overlay.files.length === 3, 'compiled observational modules only');
  run('npm', ['run', 'typecheck'], candidate);
  check('pinned typecheck PASS', true, 'tsc');
  run('npm', ['test'], candidate);
  check('pinned full test PASS', true, 'npm test');
  installObservationOverlay(candidate, repo);
  run('node', [path.join(root, 'prepare-source.cjs'), candidate], candidate);
  const bounded = JSON.parse(run('node', ['dist/apps/cli/src/index.js', 'doctor', '--json'], candidate));
  check('Bounded doctor PASS', bounded.ok === true, bounded.code || 'PASS');
  check('Bounded authentication', bounded.checks?.some(x => x.id === 'codex_authentication' && x.ok === true), bounded.codexAuthenticationSource);
  check('deterministic validation environment', fs.existsSync(path.join(candidate, 'node_modules/.bin/tsc')) && /^\d+\./.test(docker), 'npm and Docker');
  checkPaths(candidate);
  for (const task of manifest.tasks) {
    for (const file of task.allowedFiles) check(`${task.taskId} source ${file}`, fs.statSync(path.join(candidate, file)).isFile(), file);
    const estimate = task.allowedFiles.reduce((n, file) => n + Math.ceil(fs.readFileSync(path.join(candidate, file), 'utf8').length / 4), 0);
    check(`${task.taskId} production context eligibility`, estimate < 10000, `${estimate} initial file tokens before prompt/metadata; 14336 hard input`);
    const parts = task.oracle.replace('{candidate}', candidate).replace('{benchmark}', root).split(' ');
    check(`${task.taskId} oracle available`, parts[0] === 'node' && fs.existsSync(parts[1]), parts[1]);
    const result = probe(parts[0], parts.slice(1), candidate, 30000);
    check(`${task.taskId} unchanged source rejected`, result.status === 1 && !result.error && /AssertionError|ERR_ASSERTION/.test(result.stderr || result.stdout), String(result.stderr || result.stdout).slice(0, 140));
  }
  check('no real provider/model calls', invoked.every(x => x.command !== 'codex' || x.args[0] !== 'exec' || x.args.includes('--help')), `${invoked.length} offline commands`);
  if (postPush) {
    check('expected remote SHA argument', expectedRemote === head, expectedRemote || 'missing');
    const remote = run('git', ['ls-remote', 'origin', `refs/heads/${branchName}`], repo, 30000).split(/\s+/)[0];
    check('direct remote SHA', remote === head, remote);
  }
  const result = preflightRecord(sessionId, postPush ? 'post-push' : 'initial', { at: new Date().toISOString(), benchmarkHead: head, sourceHead: manifest.sourceHead, mode: postPush ? 'post-push-read-only' : 'initial', checks, doctorDiagnostic: persistedDoctorDiagnostic(doctorDiagnostic), providerCalls: 0, ok: true });
  fs.writeFileSync(path.join(sessionDir, postPush ? 'post-push-preflight.json' : 'preflight.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, preflightId: result.preflightId, checks: checks.length, providerCalls: 0, head }) + '\n');
} catch (error) {
  const result = preflightRecord(sessionId, postPush ? 'post-push' : 'initial', { at: new Date().toISOString(), checks, doctorDiagnostic: persistedDoctorDiagnostic(error.diagnostic || doctorDiagnostic), issueCode: error.issueCode || null, reasonCode: error.reasonCode || null, providerCalls: 0, ok: false, error: String(error.message || error) });
  if (!postPush && sessionCreated) {
    try { fs.writeFileSync(path.join(sessionDir, 'preflight.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch {}
  }
  process.stderr.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
} finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
