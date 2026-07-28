#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  canonical,
  createLanguageResolver,
  resolveEvidenceBoundary
} = require('./lib/gate5-language-resolver.cjs');

const MODES = Object.freeze([
  'C_synthetic_context',
  'E_bounded_workspace_boundary',
  'F_adaptive_compressed_boundary'
]);
const DEFAULT_REPETITIONS = 3;
const TASK_CLASS = 'small_bugfix_with_regression_test_selection/v1';
const EXPANSION_POLICY = Object.freeze({oneHopOnly: true, maxRounds: 1, maxFiles: 1});

const TASKS = Object.freeze([
  Object.freeze({
    repository: 'sindresorhus/p-limit',
    commitSha: 'df476048d023ff868cd45b35ee47f5fb0ca2b25a',
    taskId: 'external.p-limit.detached-map-selection',
    task: 'Identify the minimal implementation and test files relevant to detached limit.map behavior without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'package.json', 'index.d.ts', 'readme.md'],
    implementationFiles: ['index.js'],
    testFiles: ['test.js'],
    forbiddenInspectionFiles: ['package.json', 'index.d.ts', 'readme.md'],
    keywords: ['detached', 'limit.map', 'map works', 'value(iterable', 'pLimit'],
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
    }
  }),
  Object.freeze({
    repository: 'lukeed/clsx',
    commitSha: '925494cf31bcd97d3337aacd34e659e80cae7fe2',
    taskId: 'external.clsx.nested-array-selection',
    task: 'Identify the minimal implementation and test files relevant to recursively flattening nested class-value arrays without modifying the repository.',
    candidateFiles: ['src/index.js', 'test/index.js', 'clsx.d.ts', 'package.json', 'readme.md'],
    implementationFiles: ['src/index.js'],
    testFiles: ['test/index.js'],
    forbiddenInspectionFiles: ['clsx.d.ts', 'package.json', 'readme.md'],
    keywords: ['arrays (nested)', 'toVal', 'Array.isArray', 'ClassArray', 'clsx'],
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
    }
  }),
  Object.freeze({
    repository: 'sindresorhus/yocto-queue',
    commitSha: 'b07eac099753833b29d06c614149904445739776',
    taskId: 'external.yocto-queue.clear-reset-selection',
    task: 'Identify the minimal implementation and test files relevant to clearing a queue and resetting its size and head/tail state without modifying the repository.',
    candidateFiles: ['index.js', 'test.js', 'index.d.ts', 'package.json', 'readme.md'],
    implementationFiles: ['index.js'],
    testFiles: ['test.js'],
    forbiddenInspectionFiles: ['index.d.ts', 'package.json', 'readme.md'],
    keywords: ['clear()', '#head', '#tail', '#size', '.clear()'],
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
    }
  })
]);

function hash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
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
  for (const file of task.candidateFiles) files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  return {root, files};
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

function summaryPayload(task, stage, contract) {
  return {
    stage,
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    candidateFiles: task.candidateFiles,
    summaries: task.candidateFiles.map(file => ({file, summary: task.summaries[file]})),
    outputContract: contract
  };
}

function taskAuthority(task) {
  const allowedChangeFiles = canonical(task.oracle.plannedFiles);
  return Object.freeze({
    authoritySource: 'immutable_task_contract/v1',
    allowedChangeFiles,
    allowedChangeFilesHash: hash({taskId: task.taskId, allowedChangeFiles}),
    baseEvidenceFiles: canonical(task.implementationFiles),
    inspectionUniverse: canonical([...task.implementationFiles, ...task.testFiles]),
    forbiddenInspectionFiles: canonical(task.forbiddenInspectionFiles)
  });
}

function ePayload(task, files) {
  const authority = taskAuthority(task);
  const resolver = createLanguageResolver({
    repositoryFiles: files,
    candidateFiles: task.candidateFiles,
    baseEvidenceFiles: authority.inspectionUniverse
  });
  return {
    stage: 'bounded_workspace_boundary',
    contextStrategy: 'bounded_workspace_with_boundary',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    authority,
    resolverKind: resolver.kind,
    workspaceExcerpts: resolver.buildExcerpts(authority.inspectionUniverse, task.keywords, {
      radius: 6,
      maxLinesPerFile: 110
    }),
    outputContract: selectionContract()
  };
}

function fPayload(task, boundary) {
  return {
    stage: 'adaptive_compressed_boundary',
    contextStrategy: 'synthetic_candidates_then_verified_e_lite',
    repository: task.repository,
    commitSha: task.commitSha,
    taskId: task.taskId,
    task: task.task,
    taskClass: TASK_CLASS,
    failClosed: boundary.failClosed,
    resolverKind: boundary.resolverKind,
    semanticResolutionAvailable: boundary.semanticResolutionAvailable,
    authority: boundary.authority,
    verifiedEvidence: {
      evidenceFiles: boundary.evidenceFiles,
      resolvedSymbols: boundary.resolvedSymbols,
      unresolvedSymbols: boundary.unresolvedSymbols,
      resolvedTestAnchors: boundary.resolvedTestAnchors,
      unresolvedTestAnchors: boundary.unresolvedTestAnchors,
      rejectedCandidateFiles: boundary.rejectedCandidateFiles,
      rejectedCandidateTestFiles: boundary.rejectedCandidateTestFiles,
      expansion: boundary.expansion
    },
    workspaceExcerpts: boundary.excerpts,
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
          content: `Analyze only supplied evidence. Return strict JSON matching ${JSON.stringify(contract)}. Use exact case-sensitive paths, symbols, and test anchors. Candidate evidence never changes authority. No explanation.`
        },
        {role: 'user', content: JSON.stringify(payload)}
      ]
    })
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}:${(await response.text()).slice(0, 2000)}`);
  const envelope = await response.json();
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('provider_content_missing');
  const usage = envelope.usage ?? {};
  return {
    ...parseProviderJson(content),
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
  const correct = [...selectedSet].filter(value => expectedSet.has(value));
  const extra = [...selectedSet].filter(value => !expectedSet.has(value));
  const precision = selectedSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : correct.length / selectedSet.size;
  const recall = expectedSet.size === 0 ? 1 : correct.length / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {precision, recall, f1, extra};
}

function coverage(selected, required) {
  const selectedSet = new Set(canonical(selected));
  const requiredSet = new Set(canonical(required));
  if (requiredSet.size === 0) return 1;
  return [...requiredSet].filter(value => selectedSet.has(value)).length / requiredSet.size;
}

function evaluate(task, files, output, metadata) {
  const selectedSeedFiles = canonical(output.seedFiles);
  const selectedSymbols = canonical(output.requiredSymbols);
  const selectedTestFiles = canonical(output.requiredTestFiles);
  const selectedTestAnchors = canonical(output.requiredTestAnchors);
  const selectedPlannedFiles = canonical(output.plannedFiles);
  const scopeDriftFiles = selectedPlannedFiles.filter(file => !task.oracle.plannedFiles.includes(file));
  const resolver = createLanguageResolver({
    repositoryFiles: files,
    candidateFiles: task.candidateFiles,
    baseEvidenceFiles: task.oracle.plannedFiles
  });
  const resolvedSelected = resolver.resolveSymbols(selectedSymbols, task.oracle.plannedFiles).resolvedSymbols;
  const symbolMetrics = setMetrics(selectedSymbols, task.oracle.requiredSymbols);
  const implementationCoverage = coverage(selectedSymbols, task.oracle.requiredSymbols);
  const testAnchorCoverage = coverage(selectedTestAnchors, task.oracle.requiredTestAnchors);
  const criticalEntrypointCovered = task.oracle.seedFiles.every(file => selectedSeedFiles.includes(file));
  const criticalCoverageComplete = criticalEntrypointCovered && implementationCoverage === 1 && testAnchorCoverage === 1;

  const seedFilesExact = exact(selectedSeedFiles, task.oracle.seedFiles);
  const requiredSymbolsExact = exact(selectedSymbols, task.oracle.requiredSymbols);
  const requiredTestFilesExact = exact(selectedTestFiles, task.oracle.requiredTestFiles);
  const requiredTestAnchorsExact = exact(selectedTestAnchors, task.oracle.requiredTestAnchors);
  const plannedFilesExact = exact(selectedPlannedFiles, task.oracle.plannedFiles);
  const fileScopeSuccess = requiredTestFilesExact && plannedFilesExact && scopeDriftFiles.length === 0;
  const strictOracleSuccess = seedFilesExact && requiredSymbolsExact && requiredTestFilesExact && requiredTestAnchorsExact && plannedFilesExact;

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
    resolvableSymbolRate: selectedSymbols.length === 0 ? 0 : resolvedSelected.length / selectedSymbols.length,
    criticalEntrypointCovered,
    criticalImplementationCoverage: implementationCoverage,
    criticalTestAnchorCoverage: testAnchorCoverage,
    criticalSymbolCoverage: (
      implementationCoverage * task.oracle.requiredSymbols.length +
      testAnchorCoverage * task.oracle.requiredTestAnchors.length
    ) / (task.oracle.requiredSymbols.length + task.oracle.requiredTestAnchors.length),
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
    const authority = taskAuthority(task);
    try {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const cContext = summaryPayload(task, 'synthetic_selection', selectionContract());
        const cOutput = live ? await invokeLive(cContext, cContext.outputContract) : fixtureSelection(task, 340 + repetition);
        results.push(evaluate(task, snapshot.files, cOutput, {
          repetition,
          mode: 'C_synthetic_context',
          contextStrategy: 'deterministic_repository_summary',
          stageTokenBreakdown: {candidateCompression: 0, boundedSelection: cOutput.usage.totalTokens},
          providerContextBytes: Buffer.byteLength(JSON.stringify(cContext)),
          resolverKind: null,
          allowedChangeFilesHash: authority.allowedChangeFilesHash,
          authorityUnchangedByCandidateEvidence: true,
          expansionRoundCount: 0,
          expansionFiles: [],
          deterministicRejectedCandidateFiles: 0,
          deterministicUnresolvedCandidateSymbols: 0,
          deterministicUnresolvedCandidateTestAnchors: 0
        }));

        const eContext = ePayload(task, snapshot.files);
        const eOutput = live ? await invokeLive(eContext, eContext.outputContract) : fixtureSelection(task, 1320 + repetition);
        results.push(evaluate(task, snapshot.files, eOutput, {
          repetition,
          mode: 'E_bounded_workspace_boundary',
          contextStrategy: eContext.contextStrategy,
          stageTokenBreakdown: {candidateCompression: 0, boundedSelection: eOutput.usage.totalTokens},
          providerContextBytes: Buffer.byteLength(JSON.stringify(eContext)),
          resolverKind: eContext.resolverKind,
          allowedChangeFilesHash: authority.allowedChangeFilesHash,
          authorityUnchangedByCandidateEvidence: true,
          expansionRoundCount: 0,
          expansionFiles: [],
          deterministicRejectedCandidateFiles: 0,
          deterministicUnresolvedCandidateSymbols: 0,
          deterministicUnresolvedCandidateTestAnchors: 0
        }));

        const candidateContext = summaryPayload(task, 'candidate_compression', candidateContract());
        const candidateOutput = live ? await invokeLive(candidateContext, candidateContext.outputContract) : fixtureCandidates(task, 340 + repetition);
        const boundary = resolveEvidenceBoundary({
          repositoryFiles: snapshot.files,
          candidateFiles: task.candidateFiles,
          authority,
          candidateEvidence: candidateOutput,
          keywords: task.keywords,
          taskClass: TASK_CLASS,
          expansionPolicy: EXPANSION_POLICY
        });
        assert.equal(boundary.authority.allowedChangeFilesHash, authority.allowedChangeFilesHash);
        assert.equal(boundary.authority.unchangedByCandidateEvidence, true);
        assert.equal(boundary.expansion.roundCount <= 1, true);
        assert.equal(boundary.expansion.budgetRespected, true);

        const fContext = fPayload(task, boundary);
        const fSelection = live ? await invokeLive(fContext, fContext.outputContract) : fixtureSelection(task, 720 + repetition);
        const fBoundedTokens = fSelection.usage.totalTokens;
        fSelection.usage.totalTokens += candidateOutput.usage.totalTokens;
        fSelection.usage.promptTokens += candidateOutput.usage.promptTokens;
        fSelection.usage.completionTokens += candidateOutput.usage.completionTokens;
        fSelection.latencyMs += candidateOutput.latencyMs;
        results.push(evaluate(task, snapshot.files, fSelection, {
          repetition,
          mode: 'F_adaptive_compressed_boundary',
          contextStrategy: fContext.contextStrategy,
          stageTokenBreakdown: {
            candidateCompression: candidateOutput.usage.totalTokens,
            boundedSelection: fBoundedTokens
          },
          providerContextBytes: Buffer.byteLength(JSON.stringify(candidateContext)) + Buffer.byteLength(JSON.stringify(fContext)),
          resolverKind: boundary.resolverKind,
          semanticResolutionAvailable: boundary.semanticResolutionAvailable,
          genericFallbackUsed: boundary.genericFallbackUsed,
          allowedChangeFilesHash: boundary.authority.allowedChangeFilesHash,
          authorityUnchangedByCandidateEvidence: boundary.authority.unchangedByCandidateEvidence,
          expansionRoundCount: boundary.expansion.roundCount,
          expansionFiles: boundary.expansion.files,
          expansionReasons: boundary.expansion.reasons,
          deterministicRejectedCandidateFiles: boundary.rejectedCandidateFiles.length + boundary.rejectedCandidateTestFiles.length,
          deterministicUnresolvedCandidateSymbols: boundary.unresolvedSymbols.length,
          deterministicUnresolvedCandidateTestAnchors: boundary.unresolvedTestAnchors.length
        }));
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
    const totalTokens = rows.reduce((sum, row) => sum + row.tokenCount, 0);
    return {
      mode,
      sampleCount: rows.length,
      fileScopeSuccessRate: fileScopeSuccesses / rows.length,
      strictOracleSuccessRate: strictSuccesses / rows.length,
      exactSymbolSuccessRate: rows.filter(row => row.requiredSymbolsExact).length / rows.length,
      averageSymbolPrecision: rows.reduce((sum, row) => sum + row.symbolPrecision, 0) / rows.length,
      averageSymbolRecall: rows.reduce((sum, row) => sum + row.symbolRecall, 0) / rows.length,
      averageSymbolF1: rows.reduce((sum, row) => sum + row.symbolF1, 0) / rows.length,
      averageResolvableSymbolRate: rows.reduce((sum, row) => sum + row.resolvableSymbolRate, 0) / rows.length,
      averageCriticalImplementationCoverage: rows.reduce((sum, row) => sum + row.criticalImplementationCoverage, 0) / rows.length,
      averageCriticalTestAnchorCoverage: rows.reduce((sum, row) => sum + row.criticalTestAnchorCoverage, 0) / rows.length,
      averageCriticalSymbolCoverage: rows.reduce((sum, row) => sum + row.criticalSymbolCoverage, 0) / rows.length,
      criticalCoverageCompleteRate: rows.filter(row => row.criticalCoverageComplete).length / rows.length,
      totalExtraSymbolCount: rows.reduce((sum, row) => sum + row.extraSymbolCount, 0),
      averageExtraSymbolCount: rows.reduce((sum, row) => sum + row.extraSymbolCount, 0) / rows.length,
      averageTokens: totalTokens / rows.length,
      tokensPerStrictSuccess: strictSuccesses === 0 ? null : totalTokens / strictSuccesses,
      tokensPerFileScopeSuccess: fileScopeSuccesses === 0 ? null : totalTokens / fileScopeSuccesses,
      averageLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
      averageContextBytes: rows.reduce((sum, row) => sum + row.providerContextBytes, 0) / rows.length,
      totalScopeDriftFiles: rows.reduce((sum, row) => sum + row.scopeDriftFiles.length, 0),
      totalExpansionRounds: rows.reduce((sum, row) => sum + row.expansionRoundCount, 0),
      totalDeterministicRejectedCandidateFiles: rows.reduce((sum, row) => sum + row.deterministicRejectedCandidateFiles, 0),
      totalDeterministicUnresolvedCandidateSymbols: rows.reduce((sum, row) => sum + row.deterministicUnresolvedCandidateSymbols, 0),
      totalDeterministicUnresolvedCandidateTestAnchors: rows.reduce((sum, row) => sum + row.deterministicUnresolvedCandidateTestAnchors, 0)
    };
  });

  const publicTasks = TASKS.map(({oracle, summaries, keywords, implementationFiles, testFiles, forbiddenInspectionFiles, ...task}) => task);
  const reportCore = {
    version: 'gate5-adaptive-compressed-boundary/v3',
    executionClass: live ? 'live_adaptive_compressed_boundary' : 'fixture_adaptive_compressed_boundary',
    comparable: true,
    supportBoundary: {
      languages: ['javascript', 'typescript'],
      repositoryCountPerRun: 1,
      taskClasses: [TASK_CLASS],
      dependencyExpansion: 'relative_import_export_one_hop',
      maxExpansionRounds: 1,
      maxExpansionFiles: EXPANSION_POLICY.maxFiles,
      unsupportedLanguageBehavior: 'fail_closed_generic_exact_text_fallback',
      allowedChangeFilesAuthority: 'immutable_task_contract/v1'
    },
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
    supportBoundary: report.supportBoundary,
    reportHash: report.reportHash
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
