#!/usr/bin/env node

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
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
  requiredSymbols: Object.freeze(['limitFunction', 'map']),
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

function fixtureOutput(mode) {
  const tokenBase = {
    A_long_context: 2200,
    B_retrieval_context: 1350,
    C_synthetic_context: 980,
    D_bounded_workspace: 760,
    E_bounded_workspace_boundary: 640
  }[mode];
  return {
    seedFiles: ['index.js'],
    requiredSymbols: ['limitFunction', 'map'],
    requiredTestFiles: ['test.js'],
    plannedFiles: ['index.js', 'test.js'],
    usage: { promptTokens: tokenBase, completionTokens: 120, totalTokens: tokenBase + 120 },
    latencyMs: 100 + MODES.indexOf(mode) * 10,
    scopeDriftFiles: 0,
    success: true
  };
}

async function invokeLive(mode, providerPayload) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) {
    throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  }
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.GATE5_API_KEY ? { authorization: `Bearer ${process.env.GATE5_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Return strict JSON with seedFiles, requiredSymbols, requiredTestFiles, and plannedFiles only.' },
        { role: 'user', content: JSON.stringify(providerPayload) }
      ]
    })
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
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
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0
    },
    latencyMs: Date.now() - started,
    scopeDriftFiles: Math.max(0, (parsed.plannedFiles ?? []).filter((file) => !ORACLE.plannedFiles.includes(file)).length),
    success: true
  };
}

async function main() {
  const live = process.argv.includes('--live');
  const model = live ? process.env.GATE5_MODEL : 'fixture-model';
  const provider = live ? new URL(process.env.GATE5_OPENAI_ENDPOINT).origin : 'fixture-provider';
  const oracleHash = hash(ORACLE);
  const results = [];

  for (const mode of MODES) {
    const providerPayload = {
      evidenceMode: mode,
      repository: TARGET.repository,
      commitSha: TARGET.commitSha,
      taskId: TARGET.taskId,
      task: TARGET.task,
      candidateFiles: TARGET.candidateFiles
    };
    const serialized = JSON.stringify(providerPayload);
    assert.equal(serialized.includes('evaluatorOracle'), false);
    assert.equal(serialized.includes('requiredOutcome'), false);
    assert.equal(serialized.includes(oracleHash), false);
    assert.equal(serialized.includes(JSON.stringify(ORACLE.seedFiles)), false);

    const output = live ? await invokeLive(mode, providerPayload) : fixtureOutput(mode);
    const metrics = {
      seedFilesExact: exact(output.seedFiles, ORACLE.seedFiles),
      requiredSymbolsExact: exact(output.requiredSymbols, ORACLE.requiredSymbols),
      requiredTestFilesExact: exact(output.requiredTestFiles, ORACLE.requiredTestFiles),
      plannedFilesExact: exact(output.plannedFiles, ORACLE.plannedFiles),
      selectionSuccess: false,
      tokenCount: output.usage.totalTokens,
      latencyMs: output.latencyMs,
      scopeDriftFiles: output.scopeDriftFiles
    };
    metrics.selectionSuccess = metrics.seedFilesExact && metrics.requiredSymbolsExact && metrics.requiredTestFilesExact && metrics.plannedFilesExact;
    results.push(Object.freeze({
      mode,
      taskId: TARGET.taskId,
      repositoryId: `${TARGET.repository}@${TARGET.commitSha}`,
      model,
      provider,
      providerVisibleOracleLeakage: false,
      ...metrics
    }));
  }

  assert.deepEqual(results.map((result) => result.mode), MODES);
  assert.equal(new Set(results.map((result) => result.taskId)).size, 1);
  assert.equal(new Set(results.map((result) => result.repositoryId)).size, 1);
  assert.equal(new Set(results.map((result) => result.model)).size, 1);
  assert.equal(new Set(results.map((result) => result.provider)).size, 1);
  assert.equal(results.some((result) => result.providerVisibleOracleLeakage), false);

  const report = Object.freeze({
    version: 'gate5-live-external-ablation/v1',
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
    providerVisibleOracleLeakage: false,
    allSelectionsPassed: report.results.every((result) => result.selectionSuccess),
    reportHash: report.reportHash
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
