#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MODES = ['A_long_context', 'B_retrieval_context', 'C_synthetic_context', 'D_bounded_workspace', 'E_bounded_workspace_boundary'];
const DEFAULT_REPETITIONS = 3;

const TASKS = Object.freeze([
  Object.freeze({
    repository: 'sindresorhus/p-limit',
    commitSha: 'df476048d023ff868cd45b35ee47f5fb0ca2b25a',
    taskId: 'external.p-limit.detached-map-selection',
    task: 'Identify the minimal implementation and test files relevant to detached limit.map behavior without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'package.json', 'index.d.ts', 'readme.md'],
    implementationFiles: ['index.js'],
    testFiles: ['test.js'],
    keywords: ['detached', 'limit.map', 'map works', 'value(iterable', 'plimit'],
    summaries: {
      'index.js': 'Primary JavaScript implementation exporting a concurrency limiter with properties and helper exports.',
      'test.js': 'AVA test suite covering concurrency, queue behavior, mapping, and detached API behavior.',
      'package.json': 'Package metadata and scripts.',
      'index.d.ts': 'Public TypeScript declarations.',
      'readme.md': 'Public usage documentation.'
    },
    excerpts: {'index.js': [68, 123], 'test.js': [219, 258]},
    oracle: {seedFiles: ['index.js'], requiredSymbols: ['pLimit', 'map'], requiredTestFiles: ['test.js'], plannedFiles: ['index.js', 'test.js']}
  }),
  Object.freeze({
    repository: 'lukeed/clsx',
    commitSha: '925494cf31bcd97d3337aacd34e659e80cae7fe2',
    taskId: 'external.clsx.nested-array-selection',
    task: 'Identify the minimal implementation and test files relevant to recursively flattening nested class-value arrays without modifying the repository.',
    candidateFiles: ['src/index.js', 'test/index.js', 'clsx.d.ts', 'package.json', 'readme.md'],
    implementationFiles: ['src/index.js'],
    testFiles: ['test/index.js'],
    keywords: ['arrays (nested)', 'toval', 'array.isarray', 'classarray', 'clsx'],
    summaries: {
      'src/index.js': 'Runtime implementation that recursively converts strings, numbers, objects, and nested arrays into a class string.',
      'test/index.js': 'uvu tests for exports, strings, numbers, objects, arrays, and nested arrays.',
      'clsx.d.ts': 'Type declarations for ClassValue and recursive ClassArray.',
      'package.json': 'Package metadata, exports, and scripts.',
      'readme.md': 'Public usage documentation.'
    },
    excerpts: {'src/index.js': [1, 45], 'test/index.js': [64, 82]},
    oracle: {seedFiles: ['src/index.js'], requiredSymbols: ['toVal', 'clsx'], requiredTestFiles: ['test/index.js'], plannedFiles: ['src/index.js', 'test/index.js']}
  }),
  Object.freeze({
    repository: 'sindresorhus/yocto-queue',
    commitSha: 'b07eac099753833b29d06c614149904445739776',
    taskId: 'external.yocto-queue.clear-reset-selection',
    task: 'Identify the minimal implementation and test files relevant to clearing a queue and resetting its size and head/tail state without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'index.d.ts', 'package.json', 'readme.md'],
    implementationFiles: ['index.js'],
    testFiles: ['test.js'],
    keywords: ['clear()', '#head', '#tail', '#size', "test('.clear()"],
    summaries: {
      'index.js': 'Queue implementation with head, tail, size, enqueue, dequeue, clear, iteration, and drain behavior.',
      'test.js': 'AVA tests for enqueue, dequeue, peek, clear, size, iteration, and drain.',
      'index.d.ts': 'Type declarations for the queue API.',
      'package.json': 'Package metadata and scripts.',
      'readme.md': 'Public usage documentation.'
    },
    excerpts: {'index.js': [17, 76], 'test.js': [38, 66]},
    oracle: {seedFiles: ['index.js'], requiredSymbols: ['Queue', 'clear'], requiredTestFiles: ['test.js'], plannedFiles: ['index.js', 'test.js']}
  })
]);

function hash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonical(values) {
  return [...new Set(Array.isArray(values) ? values : [])].sort((a, b) => a.localeCompare(b));
}

function exact(actual, expected) {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

function numberedExcerpt(content, startLine, endLine) {
  return content.split('\n').slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function keywordSnippets(files, keywords, radius = 3) {
  const snippets = [];
  for (const [file, content] of Object.entries(files)) {
    const lines = content.split('\n');
    const selected = new Set();
    lines.forEach((line, index) => {
      if (keywords.some(keyword => line.toLowerCase().includes(keyword.toLowerCase()))) {
        for (let i = Math.max(0, index - radius); i <= Math.min(lines.length - 1, index + radius); i++) selected.add(i);
      }
    });
    if (selected.size > 0) snippets.push({file, content: [...selected].sort((a, b) => a - b).map(index => `${index + 1}: ${lines[index]}`).join('\n')});
  }
  return snippets;
}

async function loadSnapshot(task) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-multi-external-'));
  const checkout = path.join(root, 'repo');
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${task.repository}.git`, checkout]);
  run('git', ['fetch', '--depth', '1', 'origin', task.commitSha], {cwd: checkout});
  run('git', ['checkout', '--detach', task.commitSha], {cwd: checkout});
  assert.equal(run('git', ['rev-parse', 'HEAD'], {cwd: checkout, capture: true}), task.commitSha);
  const files = {};
  for (const file of task.candidateFiles) files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  return {root, files};
}

function buildContext(task, mode, files) {
  const common = {
    evidenceMode: mode,
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    candidateFiles: task.candidateFiles
  };
  if (mode === 'A_long_context') return {...common, contextStrategy: 'all_candidate_files_full_text', files: Object.entries(files).map(([file, content]) => ({file, content}))};
  if (mode === 'B_retrieval_context') return {...common, contextStrategy: 'keyword_retrieval', retrievedSnippets: keywordSnippets(files, task.keywords)};
  if (mode === 'C_synthetic_context') return {...common, contextStrategy: 'deterministic_repository_summary', summaries: task.candidateFiles.map(file => ({file, summary: task.summaries[file]}))};
  if (mode === 'D_bounded_workspace') return {...common, contextStrategy: 'bounded_workspace_selected_files', workspaceFiles: [...task.implementationFiles, ...task.testFiles].map(file => ({file, content: files[file]}))};
  return {
    ...common,
    contextStrategy: 'bounded_workspace_with_boundary',
    allowedInspectionFiles: [...task.implementationFiles, ...task.testFiles],
    forbiddenInspectionFiles: task.candidateFiles.filter(file => !task.implementationFiles.includes(file) && !task.testFiles.includes(file)),
    boundaryReason: 'The benchmark task concerns runtime implementation and executable regression tests; metadata, declarations, and documentation remain outside the minimal inspection boundary.',
    workspaceExcerpts: Object.entries(task.excerpts).map(([file, [start, end]]) => ({file, content: numberedExcerpt(files[file], start, end)}))
  };
}

function fixtureOutput(task, mode, repetition) {
  const base = {A_long_context: 2200, B_retrieval_context: 1350, C_synthetic_context: 980, D_bounded_workspace: 760, E_bounded_workspace_boundary: 640}[mode];
  return {
    ...task.oracle,
    usage: {promptTokens: base + repetition, completionTokens: 120, totalTokens: base + repetition + 120},
    latencyMs: 100 + MODES.indexOf(mode) * 10 + repetition
  };
}

async function invokeLive(providerPayload) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(process.env.GATE5_API_KEY ? {authorization: `Bearer ${process.env.GATE5_API_KEY}`} : {})},
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number.parseInt(process.env.GATE5_MAX_COMPLETION_TOKENS ?? '256', 10),
      messages: [
        {role: 'system', content: 'Analyze only the supplied repository context. Return strict JSON with seedFiles, requiredSymbols, requiredTestFiles, and plannedFiles only. Use exact case-sensitive file and symbol names visible in the context. Do not add explanations.'},
        {role: 'user', content: JSON.stringify(providerPayload)}
      ]
    })
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}:${(await response.text()).slice(0, 2000)}`);
  const envelope = await response.json();
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('provider_content_missing');
  const parsed = JSON.parse(content.replace(/^```json\s*/i, '').replace(/```\s*$/, ''));
  const usage = envelope.usage ?? {};
  return {
    seedFiles: parsed.seedFiles ?? [],
    requiredSymbols: parsed.requiredSymbols ?? [],
    requiredTestFiles: parsed.requiredTestFiles ?? [],
    plannedFiles: parsed.plannedFiles ?? [],
    usage: {promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, totalTokens: usage.total_tokens ?? 0},
    latencyMs: Date.now() - started
  };
}

async function main() {
  const live = process.argv.includes('--live');
  const repetitionsArg = process.argv.find(arg => arg.startsWith('--repetitions='));
  const repetitions = repetitionsArg ? Number.parseInt(repetitionsArg.split('=')[1], 10) : DEFAULT_REPETITIONS;
  assert.equal(Number.isInteger(repetitions) && repetitions > 0, true);
  const model = live ? process.env.GATE5_MODEL : 'fixture-model';
  const provider = live ? new URL(process.env.GATE5_OPENAI_ENDPOINT).origin : 'fixture-provider';
  const results = [];

  for (const task of TASKS) {
    const snapshot = await loadSnapshot(task);
    const oracleHash = hash(task.oracle);
    try {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const mode of MODES) {
          const payload = buildContext(task, mode, snapshot.files);
          const serialized = JSON.stringify(payload);
          assert.equal(serialized.includes(oracleHash), false);
          assert.equal(serialized.includes('requiredOutcome'), false);
          const output = live ? await invokeLive(payload) : fixtureOutput(task, mode, repetition);
          const selectedSeedFiles = canonical(output.seedFiles);
          const selectedSymbols = canonical(output.requiredSymbols);
          const selectedTestFiles = canonical(output.requiredTestFiles);
          const selectedPlannedFiles = canonical(output.plannedFiles);
          const scopeDriftFiles = selectedPlannedFiles.filter(file => !task.oracle.plannedFiles.includes(file)).length;
          const seedFilesExact = exact(selectedSeedFiles, task.oracle.seedFiles);
          const requiredSymbolsExact = exact(selectedSymbols, task.oracle.requiredSymbols);
          const requiredTestFilesExact = exact(selectedTestFiles, task.oracle.requiredTestFiles);
          const plannedFilesExact = exact(selectedPlannedFiles, task.oracle.plannedFiles);
          const fileScopeSuccess = requiredTestFilesExact && plannedFilesExact && scopeDriftFiles === 0;
          const symbolIdentificationSuccess = requiredSymbolsExact;
          const strictOracleSuccess = seedFilesExact && requiredSymbolsExact && requiredTestFilesExact && plannedFilesExact;
          results.push(Object.freeze({
            taskId: task.taskId,
            repositoryId: `${task.repository}@${task.commitSha}`,
            repetition,
            mode,
            contextStrategy: payload.contextStrategy,
            model,
            provider,
            providerVisibleOracleLeakage: false,
            selectedSeedFiles,
            selectedSymbols,
            selectedTestFiles,
            selectedPlannedFiles,
            seedFilesExact,
            requiredSymbolsExact,
            requiredTestFilesExact,
            plannedFilesExact,
            fileScopeSuccess,
            symbolIdentificationSuccess,
            strictOracleSuccess,
            tokenCount: output.usage.totalTokens,
            latencyMs: output.latencyMs,
            scopeDriftFiles,
            providerContextBytes: Buffer.byteLength(serialized)
          }));
        }
      }
    } finally {
      await fs.rm(snapshot.root, {recursive: true, force: true});
    }
  }

  assert.equal(results.length, TASKS.length * MODES.length * repetitions);
  assert.equal(new Set(results.map(result => result.taskId)).size, TASKS.length);
  assert.equal(new Set(results.map(result => result.contextStrategy)).size, MODES.length);
  assert.equal(results.some(result => result.providerVisibleOracleLeakage), false);
  if (!live) assert.equal(results.every(result => result.strictOracleSuccess), true);

  const aggregates = MODES.map(mode => {
    const modeResults = results.filter(result => result.mode === mode);
    return {
      mode,
      contextStrategy: modeResults[0].contextStrategy,
      sampleCount: modeResults.length,
      fileScopeSuccessRate: modeResults.filter(result => result.fileScopeSuccess).length / modeResults.length,
      symbolIdentificationSuccessRate: modeResults.filter(result => result.symbolIdentificationSuccess).length / modeResults.length,
      strictOracleSuccessRate: modeResults.filter(result => result.strictOracleSuccess).length / modeResults.length,
      averageTokens: modeResults.reduce((sum, result) => sum + result.tokenCount, 0) / modeResults.length,
      averageLatencyMs: modeResults.reduce((sum, result) => sum + result.latencyMs, 0) / modeResults.length,
      averageContextBytes: modeResults.reduce((sum, result) => sum + result.providerContextBytes, 0) / modeResults.length,
      totalScopeDriftFiles: modeResults.reduce((sum, result) => sum + result.scopeDriftFiles, 0)
    };
  });

  const publicTasks = TASKS.map(({oracle, keywords, summaries, excerpts, implementationFiles, testFiles, ...task}) => task);
  const report = {
    version: 'gate5-multi-external-benchmark/v1',
    executionClass: live ? 'live_multi_external_ablation' : 'fixture_multi_external_ablation',
    evidenceClass: live ? 'comparative_benchmark_candidate' : 'deterministic_fixture',
    comparable: true,
    repetitions,
    taskCount: TASKS.length,
    modeCount: MODES.length,
    sampleCount: results.length,
    tasks: publicTasks,
    taskOracleHashes: Object.fromEntries(TASKS.map(task => [task.taskId, hash(task.oracle)])),
    results,
    aggregates,
    reportHash: hash({repetitions, tasks: publicTasks, results, aggregates})
  };

  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  if (outputArg) {
    const outputPath = path.resolve(outputArg.slice('--output='.length));
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify({
    ok: true,
    decision: live ? 'gate5_multi_external_benchmark_completed' : 'gate5_multi_external_benchmark_contract_ready',
    executionClass: report.executionClass,
    taskCount: report.taskCount,
    modeCount: report.modeCount,
    repetitions: report.repetitions,
    sampleCount: report.sampleCount,
    providerVisibleOracleLeakage: false,
    allFixtureStrictOraclePassed: live ? null : results.every(result => result.strictOracleSuccess),
    reportHash: report.reportHash
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
