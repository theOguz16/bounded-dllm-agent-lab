#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MODES = [
  'A_long_context',
  'B_retrieval_context',
  'C_synthetic_context',
  'D_bounded_workspace',
  'E_bounded_workspace_boundary'
];

const TARGET = Object.freeze({
  repository: 'sindresorhus/p-limit',
  commitSha: 'df476048d023ff868cd45b35ee47f5fb0ca2b25a',
  taskId: 'external.p-limit.detached-map-selection',
  task: 'Identify the minimal implementation and test files relevant to detached limit.map behavior without modifying the repository.',
  candidateFiles: Object.freeze(['index.js', 'test.js', 'package.json', 'index.d.ts', 'readme.md'])
});

const ORACLE = Object.freeze({
  seedFiles: Object.freeze(['index.js']),
  requiredSymbols: Object.freeze(['pLimit', 'map']),
  requiredTestFiles: Object.freeze(['test.js']),
  plannedFiles: Object.freeze(['index.js', 'test.js'])
});

function hash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonical(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function exact(actual, expected) {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`);
  }
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
      if (keywords.some((keyword) => line.toLowerCase().includes(keyword))) {
        for (let i = Math.max(0, index - radius); i <= Math.min(lines.length - 1, index + radius); i++) selected.add(i);
      }
    });
    if (selected.size > 0) {
      snippets.push({ file, content: [...selected].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join('\n') });
    }
  }
  return snippets;
}

async function loadExternalSnapshot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-real-context-'));
  const checkout = path.join(root, 'repo');
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${TARGET.repository}.git`, checkout]);
  run('git', ['fetch', '--depth', '1', 'origin', TARGET.commitSha], { cwd: checkout });
  run('git', ['checkout', '--detach', TARGET.commitSha], { cwd: checkout });
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout, capture: true }), TARGET.commitSha);

  const files = {};
  for (const file of TARGET.candidateFiles) files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  return { root, checkout, files };
}

function buildContext(mode, files) {
  const common = {
    evidenceMode: mode,
    repository: TARGET.repository,
    commitSha: TARGET.commitSha,
    taskId: TARGET.taskId,
    task: TARGET.task,
    candidateFiles: TARGET.candidateFiles
  };

  if (mode === 'A_long_context') {
    return { ...common, contextStrategy: 'all_candidate_files_full_text', files: Object.entries(files).map(([file, content]) => ({ file, content })) };
  }
  if (mode === 'B_retrieval_context') {
    return { ...common, contextStrategy: 'keyword_retrieval', retrievedSnippets: keywordSnippets(files, ['detached', 'limit.map', 'map works', 'value(iterable', 'plimit']) };
  }
  if (mode === 'C_synthetic_context') {
    return {
      ...common,
      contextStrategy: 'deterministic_repository_summary',
      summaries: [
        { file: 'index.js', summary: 'Primary JavaScript implementation exporting a concurrency limiter with properties and helper exports.' },
        { file: 'test.js', summary: 'AVA test suite covering concurrency, queue behavior, mapping, and detached API behavior.' },
        { file: 'index.d.ts', summary: 'Type declarations for the public limiter API.' },
        { file: 'package.json', summary: 'Package metadata, scripts, dependencies, and runtime constraints.' },
        { file: 'readme.md', summary: 'Public documentation and usage examples.' }
      ]
    };
  }
  if (mode === 'D_bounded_workspace') {
    return {
      ...common,
      contextStrategy: 'bounded_workspace_selected_files',
      workspaceFiles: [
        { file: 'index.js', content: files['index.js'] },
        { file: 'test.js', content: files['test.js'] }
      ]
    };
  }
  return {
    ...common,
    contextStrategy: 'bounded_workspace_with_boundary',
    allowedInspectionFiles: ['index.js', 'test.js'],
    forbiddenInspectionFiles: ['package.json', 'index.d.ts', 'readme.md'],
    boundaryReason: 'The task concerns runtime implementation and its executable regression test; metadata, declarations, and documentation are outside the minimal change boundary.',
    workspaceExcerpts: [
      { file: 'index.js', content: numberedExcerpt(files['index.js'], 68, 123) },
      { file: 'test.js', content: numberedExcerpt(files['test.js'], 219, 258) }
    ]
  };
}

function fixtureOutput(mode) {
  const tokenBase = { A_long_context: 2200, B_retrieval_context: 1350, C_synthetic_context: 980, D_bounded_workspace: 760, E_bounded_workspace_boundary: 640 }[mode];
  return {
    seedFiles: ['index.js'], requiredSymbols: ['pLimit', 'map'], requiredTestFiles: ['test.js'], plannedFiles: ['index.js', 'test.js'],
    usage: { promptTokens: tokenBase, completionTokens: 120, totalTokens: tokenBase + 120 },
    latencyMs: 100 + MODES.indexOf(mode) * 10, scopeDriftFiles: 0, success: true
  };
}

async function invokeLive(providerPayload) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.GATE5_API_KEY ? { authorization: `Bearer ${process.env.GATE5_API_KEY}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number.parseInt(process.env.GATE5_MAX_COMPLETION_TOKENS ?? '256', 10),
      messages: [
        { role: 'system', content: 'Analyze only the supplied repository context. Return strict JSON with seedFiles, requiredSymbols, requiredTestFiles, and plannedFiles only. Use exact case-sensitive file and symbol names visible in the context. Do not add explanations.' },
        { role: 'user', content: JSON.stringify(providerPayload) }
      ]
    })
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`provider_http_${response.status}:${errorBody.slice(0, 2000)}`);
  }
  const envelope = await response.json();
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('provider_content_missing');
  const parsed = JSON.parse(content.replace(/^```json\s*/i, '').replace(/```\s*$/, ''));
  const usage = envelope.usage ?? {};
  return {
    seedFiles: parsed.seedFiles ?? [], requiredSymbols: parsed.requiredSymbols ?? [], requiredTestFiles: parsed.requiredTestFiles ?? [], plannedFiles: parsed.plannedFiles ?? [],
    usage: { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, totalTokens: usage.total_tokens ?? 0 },
    latencyMs: Date.now() - started,
    scopeDriftFiles: Math.max(0, (parsed.plannedFiles ?? []).filter((file) => !ORACLE.plannedFiles.includes(file)).length), success: true
  };
}

async function main() {
  const live = process.argv.includes('--live');
  const model = live ? process.env.GATE5_MODEL : 'fixture-model';
  const provider = live ? new URL(process.env.GATE5_OPENAI_ENDPOINT).origin : 'fixture-provider';
  const oracleHash = hash(ORACLE);
  const snapshot = await loadExternalSnapshot();
  const results = [];

  try {
    for (const mode of MODES) {
      const providerPayload = buildContext(mode, snapshot.files);
      const serialized = JSON.stringify(providerPayload);
      assert.equal(serialized.includes('evaluatorOracle'), false);
      assert.equal(serialized.includes('requiredOutcome'), false);
      assert.equal(serialized.includes(oracleHash), false);
      const output = live ? await invokeLive(providerPayload) : fixtureOutput(mode);
      const metrics = {
        seedFilesExact: exact(output.seedFiles, ORACLE.seedFiles),
        requiredSymbolsExact: exact(output.requiredSymbols, ORACLE.requiredSymbols),
        requiredTestFilesExact: exact(output.requiredTestFiles, ORACLE.requiredTestFiles),
        plannedFilesExact: exact(output.plannedFiles, ORACLE.plannedFiles),
        selectionSuccess: false,
        tokenCount: output.usage.totalTokens,
        latencyMs: output.latencyMs,
        scopeDriftFiles: output.scopeDriftFiles,
        providerContextBytes: Buffer.byteLength(serialized)
      };
      metrics.selectionSuccess = metrics.seedFilesExact && metrics.requiredSymbolsExact && metrics.requiredTestFilesExact && metrics.plannedFilesExact;
      results.push(Object.freeze({ mode, taskId: TARGET.taskId, repositoryId: `${TARGET.repository}@${TARGET.commitSha}`, model, provider, contextStrategy: providerPayload.contextStrategy, providerVisibleOracleLeakage: false, ...metrics }));
    }

    assert.deepEqual(results.map((result) => result.mode), MODES);
    assert.equal(new Set(results.map((result) => result.contextStrategy)).size, MODES.length);
    assert.equal(new Set(results.map((result) => result.providerContextBytes)).size > 1, true);
    assert.equal(new Set(results.map((result) => result.taskId)).size, 1);
    assert.equal(new Set(results.map((result) => result.repositoryId)).size, 1);
    assert.equal(new Set(results.map((result) => result.model)).size, 1);
    assert.equal(new Set(results.map((result) => result.provider)).size, 1);
    assert.equal(results.some((result) => result.providerVisibleOracleLeakage), false);

    const report = Object.freeze({
      version: 'gate5-live-external-ablation/v2',
      executionClass: live ? 'live_external_ablation' : 'fixture_external_ablation',
      evidenceClass: live ? 'comparative_benchmark_candidate' : 'deterministic_fixture',
      comparable: true,
      target: TARGET,
      oracleHash,
      results: Object.freeze(results),
      reportHash: hash({ target: TARGET, oracleHash, results })
    });

    const outputPathArg = process.argv.find((arg) => arg.startsWith('--output='));
    if (outputPathArg) {
      const outputPath = path.resolve(outputPathArg.slice('--output='.length));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    console.log(JSON.stringify({
      ok: true,
      decision: live ? 'gate5_live_external_ablation_completed' : 'gate5_live_external_ablation_contract_ready',
      executionClass: report.executionClass,
      modeCount: report.results.length,
      comparable: report.comparable,
      distinctContextStrategies: new Set(report.results.map((result) => result.contextStrategy)).size,
      providerVisibleOracleLeakage: false,
      allSelectionsPassed: report.results.every((result) => result.selectionSuccess),
      reportHash: report.reportHash
    }, null, 2));
  } finally {
    await fs.rm(snapshot.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
