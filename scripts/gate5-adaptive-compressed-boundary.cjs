#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const MODES = Object.freeze([
  'C_synthetic_context',
  'E_bounded_workspace_boundary',
  'F_adaptive_compressed_boundary'
]);
const DEFAULT_REPETITIONS = 3;

const TASKS = Object.freeze([
  Object.freeze({
    repository: 'sindresorhus/p-limit',
    commitSha: 'df476048d023ff868cd45b35ee47f5fb0ca2b25a',
    taskId: 'external.p-limit.detached-map-selection',
    task: 'Identify the minimal implementation and test files relevant to detached limit.map behavior without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'package.json', 'index.d.ts', 'readme.md'],
    boundaryFiles: ['index.js', 'test.js'],
    keywords: ['detached', 'limit.map', 'map works', 'value(iterable', 'plimit'],
    summaries: {
      'index.js': 'Primary JavaScript implementation exporting a concurrency limiter with properties and helper exports.',
      'test.js': 'AVA test suite covering concurrency, queue behavior, mapping, and detached API behavior.',
      'package.json': 'Package metadata and scripts.',
      'index.d.ts': 'Public TypeScript declarations.',
      'readme.md': 'Public usage documentation.'
    },
    oracle: {
      seedFiles: ['index.js'],
      requiredSymbols: ['pLimit', 'map'],
      requiredTestFiles: ['test.js'],
      requiredTestAnchors: ['map works with concurrency: 1', 'can be used detached'],
      plannedFiles: ['index.js', 'test.js']
    },
    criticalImplementationSymbols: ['pLimit', 'map'],
    criticalTestAnchors: ['map works with concurrency: 1', 'can be used detached']
  }),
  Object.freeze({
    repository: 'lukeed/clsx',
    commitSha: '925494cf31bcd97d3337aacd34e659e80cae7fe2',
    taskId: 'external.clsx.nested-array-selection',
    task: 'Identify the minimal implementation and test files relevant to recursively flattening nested class-value arrays without modifying the repository.',
    candidateFiles: ['src/index.js', 'test/index.js', 'clsx.d.ts', 'package.json', 'readme.md'],
    boundaryFiles: ['src/index.js', 'test/index.js'],
    keywords: ['arrays (nested)', 'toval', 'array.isarray', 'classarray', 'clsx'],
    summaries: {
      'src/index.js': 'Runtime implementation that recursively converts strings, numbers, objects, and nested arrays into a class string.',
      'test/index.js': 'uvu tests for exports, strings, numbers, objects, arrays, and nested arrays.',
      'clsx.d.ts': 'Type declarations for ClassValue and recursive ClassArray.',
      'package.json': 'Package metadata, exports, and scripts.',
      'readme.md': 'Public usage documentation.'
    },
    oracle: {
      seedFiles: ['src/index.js'],
      requiredSymbols: ['toVal', 'clsx'],
      requiredTestFiles: ['test/index.js'],
      requiredTestAnchors: ['arrays (nested)'],
      plannedFiles: ['src/index.js', 'test/index.js']
    },
    criticalImplementationSymbols: ['toVal', 'clsx'],
    criticalTestAnchors: ['arrays (nested)']
  }),
  Object.freeze({
    repository: 'sindresorhus/yocto-queue',
    commitSha: 'b07eac099753833b29d06c614149904445739776',
    taskId: 'external.yocto-queue.clear-reset-selection',
    task: 'Identify the minimal implementation and test files relevant to clearing a queue and resetting its size and head/tail state without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'index.d.ts', 'package.json', 'readme.md'],
    boundaryFiles: ['index.js', 'test.js'],
    keywords: ['clear()', '#head', '#tail', '#size', "test('.clear()"],
    summaries: {
      'index.js': 'Queue implementation with head, tail, size, enqueue, dequeue, clear, iteration, and drain behavior.',
      'test.js': 'AVA tests for enqueue, dequeue, peek, clear, size, iteration, and drain.',
      'index.d.ts': 'Type declarations for the queue API.',
      'package.json': 'Package metadata and scripts.',
      'readme.md': 'Public usage documentation.'
    },
    oracle: {
      seedFiles: ['index.js'],
      requiredSymbols: ['Queue', 'clear'],
      requiredTestFiles: ['test.js'],
      requiredTestAnchors: ['.clear()'],
      plannedFiles: ['index.js', 'test.js']
    },
    criticalImplementationSymbols: ['Queue', 'clear'],
    criticalTestAnchors: ['.clear()']
  })
]);

function hash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonical(values) {
  return [...new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : [])]
    .sort((left, right) => left.localeCompare(right));
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
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

async function loadSnapshot(task) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-adaptive-compressed-'));
  const checkout = path.join(root, 'repo');
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${task.repository}.git`, checkout]);
  run('git', ['fetch', '--depth', '1', 'origin', task.commitSha], {cwd: checkout});
  run('git', ['checkout', '--detach', task.commitSha], {cwd: checkout});
  assert.equal(run('git', ['rev-parse', 'HEAD'], {cwd: checkout, capture: true}), task.commitSha);
  const files = {};
  for (const file of task.candidateFiles) {
    files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  }
  return {root, files};
}

function scriptKindFor(file) {
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.json')) return ts.ScriptKind.JSON;
  return ts.ScriptKind.JS;
}

function buildAstSymbolIndex(task, files) {
  const symbols = new Set();
  for (const file of task.boundaryFiles) {
    const sourceFile = ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = node => {
      if (ts.isIdentifier(node)) symbols.add(node.text);
      if (ts.isPrivateIdentifier(node)) symbols.add(`#${node.text.replace(/^#/, '')}`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.length <= 120) {
        symbols.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return symbols;
}

function linesAroundMatches(content, terms, radius = 4, maxLines = 80) {
  const lines = content.split('\n');
  const selected = new Set();
  const normalizedTerms = canonical(terms).filter(Boolean).map(term => term.toLowerCase());
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (normalizedTerms.some(term => lower.includes(term))) {
      for (let cursor = Math.max(0, index - radius); cursor <= Math.min(lines.length - 1, index + radius); cursor += 1) {
        selected.add(cursor);
      }
    }
  });
  if (selected.size === 0) {
    for (let index = 0; index < Math.min(lines.length, 24); index += 1) selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, maxLines)
    .map(index => `${index + 1}: ${lines[index]}`)
    .join('\n');
}

function selectionContract() {
  return {
    seedFiles: ['repository-relative implementation path'],
    requiredSymbols: ['exact case-sensitive implementation symbol'],
    requiredTestFiles: ['repository-relative test path'],
    requiredTestAnchors: ['exact test name or anchor visible in supplied context'],
    plannedFiles: ['repository-relative path']
  };
}

function candidateContract() {
  return {
    candidateFiles: ['repository-relative path'],
    candidateSymbols: ['exact case-sensitive implementation symbol'],
    candidateTestFiles: ['repository-relative test path'],
    candidateTestAnchors: ['test name or anchor candidate']
  };
}

function cSelectionPayload(task) {
  return {
    stage: 'synthetic_selection',
    contextStrategy: 'deterministic_repository_summary',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    candidateFiles: task.candidateFiles,
    summaries: task.candidateFiles.map(file => ({file, summary: task.summaries[file]})),
    outputContract: selectionContract()
  };
}

function candidateCompressionPayload(task) {
  return {
    stage: 'candidate_compression',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    candidateFiles: task.candidateFiles,
    summaries: task.candidateFiles.map(file => ({file, summary: task.summaries[file]})),
    outputContract: candidateContract()
  };
}

function ePayload(task, files) {
  return {
    stage: 'bounded_selection',
    contextStrategy: 'bounded_workspace_with_boundary',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    allowedInspectionFiles: task.boundaryFiles,
    forbiddenInspectionFiles: task.candidateFiles.filter(file => !task.boundaryFiles.includes(file)),
    workspaceExcerpts: task.boundaryFiles.map(file => ({
      file,
      content: linesAroundMatches(files[file], task.keywords, 6, 110)
    })),
    outputContract: selectionContract()
  };
}

function resolveCandidateBoundary(task, files, candidate, astSymbols) {
  const proposedFiles = canonical(candidate.candidateFiles).filter(file => task.candidateFiles.includes(file));
  const proposedTests = canonical(candidate.candidateTestFiles).filter(file => task.candidateFiles.includes(file));
  const proposedSymbols = canonical(candidate.candidateSymbols);
  const proposedAnchors = canonical(candidate.candidateTestAnchors);
  const allowedFiles = canonical(task.boundaryFiles);
  const rejectedFiles = proposedFiles.filter(file => !allowedFiles.includes(file));
  const rejectedTestFiles = proposedTests.filter(file => !allowedFiles.includes(file));
  const resolvedSymbols = proposedSymbols.filter(symbol => astSymbols.has(symbol));
  const unresolvedSymbols = proposedSymbols.filter(symbol => !astSymbols.has(symbol));
  const testFiles = allowedFiles.filter(file => /(?:^|\/)(?:test|tests|spec)(?:\/|\.|$)/i.test(file));
  const resolvedTestAnchors = proposedAnchors.filter(anchor => testFiles.some(file => files[file].includes(anchor)));
  const unresolvedTestAnchors = proposedAnchors.filter(anchor => !resolvedTestAnchors.includes(anchor));
  const terms = canonical([...resolvedSymbols, ...resolvedTestAnchors, ...task.keywords]);
  return {
    allowedFiles,
    rejectedFiles,
    rejectedTestFiles,
    resolvedSymbols,
    unresolvedSymbols,
    resolvedTestAnchors,
    unresolvedTestAnchors,
    excerpts: allowedFiles.map(file => ({
      file,
      content: linesAroundMatches(files[file], terms, 3, 55)
    }))
  };
}

function fPayload(task, resolved) {
  return {
    stage: 'adaptive_compressed_boundary',
    contextStrategy: 'synthetic_candidates_then_exact_bounded_excerpts',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    deterministicBoundary: {
      allowedInspectionFiles: resolved.allowedFiles,
      forbiddenInspectionFiles: task.candidateFiles.filter(file => !resolved.allowedFiles.includes(file)),
      rejectedCandidateFiles: resolved.rejectedFiles,
      rejectedCandidateTestFiles: resolved.rejectedTestFiles,
      resolvedCandidateSymbols: resolved.resolvedSymbols,
      unresolvedCandidateSymbols: resolved.unresolvedSymbols,
      resolvedCandidateTestAnchors: resolved.resolvedTestAnchors,
      unresolvedCandidateTestAnchors: resolved.unresolvedTestAnchors
    },
    workspaceExcerpts: resolved.excerpts,
    outputContract: selectionContract()
  };
}

function fixtureSelection(task, tokenCount) {
  return {
    ...task.oracle,
    usage: {promptTokens: tokenCount - 100, completionTokens: 100, totalTokens: tokenCount},
    latencyMs: 100
  };
}

function fixtureCandidates(task, tokenCount) {
  return {
    candidateFiles: task.oracle.plannedFiles,
    candidateSymbols: task.oracle.requiredSymbols,
    candidateTestFiles: task.oracle.requiredTestFiles,
    candidateTestAnchors: task.oracle.requiredTestAnchors,
    usage: {promptTokens: tokenCount - 80, completionTokens: 80, totalTokens: tokenCount},
    latencyMs: 80
  };
}

function parseProviderJson(content) {
  const stripped = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
    throw new Error('provider_json_parse_failed');
  }
}

async function invokeLive(payload, contract) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.GATE5_API_KEY ? {authorization: `Bearer ${process.env.GATE5_API_KEY}`} : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number.parseInt(process.env.GATE5_MAX_COMPLETION_TOKENS ?? '256', 10),
      messages: [
        {
          role: 'system',
          content: `Analyze only supplied context. Return strict JSON matching this contract: ${JSON.stringify(contract)}. Use exact case-sensitive paths, symbols, and test anchors visible in context. No explanation.`
        },
        {role: 'user', content: JSON.stringify(payload)}
      ]
    })
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}:${(await response.text()).slice(0, 2000)}`);
  const envelope = await response.json();
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('provider_content_missing');
  const parsed = parseProviderJson(content);
  const usage = envelope.usage ?? {};
  return {
    ...parsed,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0
    },
    latencyMs: Date.now() - started
  };
}

function setMetrics(selected, expected) {
  const selectedSet = new Set(canonical(selected));
  const expectedSet = new Set(canonical(expected));
  const intersection = [...selectedSet].filter(value => expectedSet.has(value));
  const extra = [...selectedSet].filter(value => !expectedSet.has(value));
  const precision = selectedSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : intersection.length / selectedSet.size;
  const recall = expectedSet.size === 0 ? 1 : intersection.length / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {precision, recall, f1, intersection, extra};
}

function coverage(selected, critical) {
  const selectedSet = new Set(canonical(selected));
  const criticalSet = new Set(canonical(critical));
  if (criticalSet.size === 0) return 1;
  return [...criticalSet].filter(value => selectedSet.has(value)).length / criticalSet.size;
}

function evaluate(task, output, metadata, astSymbols) {
  const selectedSeedFiles = canonical(output.seedFiles);
  const selectedSymbols = canonical(output.requiredSymbols);
  const selectedTestFiles = canonical(output.requiredTestFiles);
  const selectedTestAnchors = canonical(output.requiredTestAnchors);
  const selectedPlannedFiles = canonical(output.plannedFiles);
  const scopeDriftFiles = selectedPlannedFiles.filter(file => !task.oracle.plannedFiles.includes(file));

  const seedFilesExact = exact(selectedSeedFiles, task.oracle.seedFiles);
  const requiredSymbolsExact = exact(selectedSymbols, task.oracle.requiredSymbols);
  const requiredTestFilesExact = exact(selectedTestFiles, task.oracle.requiredTestFiles);
  const requiredTestAnchorsExact = exact(selectedTestAnchors, task.oracle.requiredTestAnchors);
  const plannedFilesExact = exact(selectedPlannedFiles, task.oracle.plannedFiles);
  const fileScopeSuccess = requiredTestFilesExact && plannedFilesExact && scopeDriftFiles.length === 0;
  const strictOracleSuccess = seedFilesExact && requiredSymbolsExact && requiredTestFilesExact && requiredTestAnchorsExact && plannedFilesExact;

  const symbolMetrics = setMetrics(selectedSymbols, task.oracle.requiredSymbols);
  const resolvedSelectedSymbols = selectedSymbols.filter(symbol => astSymbols.has(symbol));
  const unresolvedSelectedSymbols = selectedSymbols.filter(symbol => !astSymbols.has(symbol));
  const resolvableSymbolRate = selectedSymbols.length === 0 ? 0 : resolvedSelectedSymbols.length / selectedSymbols.length;
  const criticalImplementationCoverage = coverage(selectedSymbols, task.criticalImplementationSymbols);
  const criticalTestAnchorCoverage = coverage(selectedTestAnchors, task.criticalTestAnchors);
  const criticalEntrypointCovered = task.oracle.seedFiles.every(file => selectedSeedFiles.includes(file));
  const criticalSymbolCoverage = (
    criticalImplementationCoverage * task.criticalImplementationSymbols.length +
    criticalTestAnchorCoverage * task.criticalTestAnchors.length
  ) / (task.criticalImplementationSymbols.length + task.criticalTestAnchors.length);
  const criticalCoverageComplete = criticalEntrypointCovered && criticalImplementationCoverage === 1 && criticalTestAnchorCoverage === 1;

  return {
    taskId: task.taskId,
    repositoryId: `${task.repository}@${task.commitSha}`,
    ...metadata,
    selectedSeedFiles,
    selectedSymbols,
    selectedTestFiles,
    selectedTestAnchors,
    selectedPlannedFiles,
    seedFilesExact,
    requiredSymbolsExact,
    requiredTestFilesExact,
    requiredTestAnchorsExact,
    plannedFilesExact,
    fileScopeSuccess,
    strictOracleSuccess,
    symbolPrecision: symbolMetrics.precision,
    symbolRecall: symbolMetrics.recall,
    symbolF1: symbolMetrics.f1,
    resolvedSelectedSymbols,
    unresolvedSelectedSymbols,
    resolvableSymbolRate,
    criticalEntrypointCovered,
    criticalImplementationCoverage,
    criticalTestAnchorCoverage,
    criticalSymbolCoverage,
    criticalCoverageComplete,
    extraSymbols: symbolMetrics.extra,
    extraSymbolCount: symbolMetrics.extra.length,
    scopeDriftFiles,
    tokenCount: output.usage.totalTokens,
    latencyMs: output.latencyMs
  };
}

async function main() {
  const live = process.argv.includes('--live');
  const repetitionsArg = process.argv.find(arg => arg.startsWith('--repetitions='));
  const repetitions = repetitionsArg ? Number.parseInt(repetitionsArg.split('=')[1], 10) : DEFAULT_REPETITIONS;
  assert.equal(Number.isInteger(repetitions) && repetitions > 0, true);
  const results = [];

  for (const task of TASKS) {
    const snapshot = await loadSnapshot(task);
    const astSymbols = buildAstSymbolIndex(task, snapshot.files);
    try {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const cContext = cSelectionPayload(task);
        const cOutput = live
          ? await invokeLive(cContext, cContext.outputContract)
          : fixtureSelection(task, 340 + repetition);
        results.push(evaluate(task, cOutput, {
          repetition,
          mode: 'C_synthetic_context',
          contextStrategy: cContext.contextStrategy,
          stageTokenBreakdown: {candidateCompression: 0, boundedSelection: cOutput.usage.totalTokens},
          providerContextBytes: Buffer.byteLength(JSON.stringify(cContext)),
          deterministicRejectedCandidateFiles: 0,
          deterministicUnresolvedCandidateSymbols: 0,
          deterministicUnresolvedCandidateTestAnchors: 0
        }, astSymbols));

        const eContext = ePayload(task, snapshot.files);
        const eOutput = live
          ? await invokeLive(eContext, eContext.outputContract)
          : fixtureSelection(task, 1320 + repetition);
        results.push(evaluate(task, eOutput, {
          repetition,
          mode: 'E_bounded_workspace_boundary',
          contextStrategy: eContext.contextStrategy,
          stageTokenBreakdown: {candidateCompression: 0, boundedSelection: eOutput.usage.totalTokens},
          providerContextBytes: Buffer.byteLength(JSON.stringify(eContext)),
          deterministicRejectedCandidateFiles: 0,
          deterministicUnresolvedCandidateSymbols: 0,
          deterministicUnresolvedCandidateTestAnchors: 0
        }, astSymbols));

        const candidateContext = candidateCompressionPayload(task);
        const candidateOutput = live
          ? await invokeLive(candidateContext, candidateContext.outputContract)
          : fixtureCandidates(task, 340 + repetition);
        const resolved = resolveCandidateBoundary(task, snapshot.files, candidateOutput, astSymbols);
        const adaptiveContext = fPayload(task, resolved);
        const adaptiveOutput = live
          ? await invokeLive(adaptiveContext, adaptiveContext.outputContract)
          : fixtureSelection(task, 720 + repetition);
        const adaptiveSelectionTokens = adaptiveOutput.usage.totalTokens;
        adaptiveOutput.usage.totalTokens += candidateOutput.usage.totalTokens;
        adaptiveOutput.usage.promptTokens += candidateOutput.usage.promptTokens;
        adaptiveOutput.usage.completionTokens += candidateOutput.usage.completionTokens;
        adaptiveOutput.latencyMs += candidateOutput.latencyMs;
        results.push(evaluate(task, adaptiveOutput, {
          repetition,
          mode: 'F_adaptive_compressed_boundary',
          contextStrategy: adaptiveContext.contextStrategy,
          stageTokenBreakdown: {
            candidateCompression: candidateOutput.usage.totalTokens,
            boundedSelection: adaptiveSelectionTokens
          },
          providerContextBytes: Buffer.byteLength(JSON.stringify(candidateContext)) + Buffer.byteLength(JSON.stringify(adaptiveContext)),
          deterministicRejectedCandidateFiles: resolved.rejectedFiles.length + resolved.rejectedTestFiles.length,
          deterministicUnresolvedCandidateSymbols: resolved.unresolvedSymbols.length,
          deterministicUnresolvedCandidateTestAnchors: resolved.unresolvedTestAnchors.length
        }, astSymbols));
      }
    } finally {
      await fs.rm(snapshot.root, {recursive: true, force: true});
    }
  }

  assert.equal(results.length, TASKS.length * MODES.length * repetitions);
  const aggregates = MODES.map(mode => {
    const rows = results.filter(result => result.mode === mode);
    const strictSuccesses = rows.filter(result => result.strictOracleSuccess).length;
    const fileScopeSuccesses = rows.filter(result => result.fileScopeSuccess).length;
    const totalTokens = rows.reduce((sum, result) => sum + result.tokenCount, 0);
    return {
      mode,
      sampleCount: rows.length,
      fileScopeSuccessRate: fileScopeSuccesses / rows.length,
      strictOracleSuccessRate: strictSuccesses / rows.length,
      exactSymbolSuccessRate: rows.filter(result => result.requiredSymbolsExact).length / rows.length,
      averageSymbolPrecision: rows.reduce((sum, result) => sum + result.symbolPrecision, 0) / rows.length,
      averageSymbolRecall: rows.reduce((sum, result) => sum + result.symbolRecall, 0) / rows.length,
      averageSymbolF1: rows.reduce((sum, result) => sum + result.symbolF1, 0) / rows.length,
      averageResolvableSymbolRate: rows.reduce((sum, result) => sum + result.resolvableSymbolRate, 0) / rows.length,
      averageCriticalImplementationCoverage: rows.reduce((sum, result) => sum + result.criticalImplementationCoverage, 0) / rows.length,
      averageCriticalTestAnchorCoverage: rows.reduce((sum, result) => sum + result.criticalTestAnchorCoverage, 0) / rows.length,
      averageCriticalSymbolCoverage: rows.reduce((sum, result) => sum + result.criticalSymbolCoverage, 0) / rows.length,
      criticalCoverageCompleteRate: rows.filter(result => result.criticalCoverageComplete).length / rows.length,
      totalExtraSymbolCount: rows.reduce((sum, result) => sum + result.extraSymbolCount, 0),
      averageExtraSymbolCount: rows.reduce((sum, result) => sum + result.extraSymbolCount, 0) / rows.length,
      averageTokens: totalTokens / rows.length,
      tokensPerStrictSuccess: strictSuccesses === 0 ? null : totalTokens / strictSuccesses,
      tokensPerFileScopeSuccess: fileScopeSuccesses === 0 ? null : totalTokens / fileScopeSuccesses,
      averageLatencyMs: rows.reduce((sum, result) => sum + result.latencyMs, 0) / rows.length,
      averageContextBytes: rows.reduce((sum, result) => sum + result.providerContextBytes, 0) / rows.length,
      totalScopeDriftFiles: rows.reduce((sum, result) => sum + result.scopeDriftFiles.length, 0),
      totalDeterministicRejectedCandidateFiles: rows.reduce((sum, result) => sum + result.deterministicRejectedCandidateFiles, 0),
      totalDeterministicUnresolvedCandidateSymbols: rows.reduce((sum, result) => sum + result.deterministicUnresolvedCandidateSymbols, 0),
      totalDeterministicUnresolvedCandidateTestAnchors: rows.reduce((sum, result) => sum + result.deterministicUnresolvedCandidateTestAnchors, 0)
    };
  });

  const publicTasks = TASKS.map(({oracle, keywords, summaries, boundaryFiles, criticalImplementationSymbols, criticalTestAnchors, ...task}) => task);
  const reportCore = {
    version: 'gate5-adaptive-compressed-boundary/v2',
    executionClass: live ? 'live_adaptive_compressed_boundary' : 'fixture_adaptive_compressed_boundary',
    comparable: true,
    repetitions,
    taskCount: TASKS.length,
    modeCount: MODES.length,
    sampleCount: results.length,
    tasks: publicTasks,
    results,
    aggregates
  };
  const report = {...reportCore, reportHash: hash(reportCore)};
  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  if (outputArg) {
    const outputPath = path.resolve(outputArg.slice('--output='.length));
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    ok: true,
    decision: live ? 'gate5_adaptive_compressed_boundary_completed' : 'gate5_adaptive_compressed_boundary_contract_ready',
    executionClass: report.executionClass,
    taskCount: report.taskCount,
    modeCount: report.modeCount,
    repetitions: report.repetitions,
    sampleCount: report.sampleCount,
    reportHash: report.reportHash
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
