import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDryRun } from './dry-run.mjs';
import { calibratePilots } from './calibrate.mjs';
import { createResearchConfig, prepareResearchTaskInput, selectResearchContext } from './policy.mjs';
import { createExperimentResult } from './result.mjs';
import { classifyCell, shouldContinueAfterCell } from './classification.mjs';
import { initializeBoundedLocalConfig } from '../../dist/apps/cli/src/product-config.js';
import { doctorCommand } from '../../dist/apps/cli/src/commands/doctor.js';
import { codexCommand } from '../../dist/apps/cli/src/commands/codex.js';
import { runBoundedTask } from '../../dist/packages/product-runtime/src/run-bounded-task.js';
import { runRepoIntelligenceBoundCoderFlow } from '../../dist/packages/product-runtime/src/repo-intelligence-context-binding.js';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';
import { createPlannedContextMatrixAuthority, readPlannedReplacementReview, readPlannedFinalReplacementReview, readPlannedStage2Review } from '../../dist/packages/integrations/src/planned-experiment-authority.js';
import { createDurableInvocationJournal, inspectPlannedExperimentJournal } from '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { parseTextFileUpdates, validateUpdateSource } from '../../dist/packages/product-runtime/src/text-file-update-contract.js';

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MODEL = 'gpt-5.6-luna';
export const REASONING = 'medium';
const BASELINE = '5bc84d195a1a896a5022590378b294561accbabe';
const SOURCE = 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireValue(ok, message) { if (!ok) throw new Error(`context_matrix_preflight_invalid: ${message}`); }
function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() ?? result.error?.message}`);
  return result;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function status(root) { return git(root, ['status', '--short']).stdout.trim(); }
function head(root) { return git(root, ['rev-parse', 'HEAD']).stdout.trim(); }
export function expectedJournalPath(home = os.homedir()) {
  return path.join(home, '.bounded-agent/bounded-dllm-agent-lab/provider-invocations.sqlite');
}
export function outputParent(home = os.homedir()) {
  return path.join(home, '.bounded-agent/bounded-dllm-agent-lab/live-runs/context-token-matrix-v1');
}
export function verifyReplacementEvidence(home = os.homedir()) {
  const review = readPlannedReplacementReview(path.join(HARNESS_ROOT,
    'research/context-token-matrix-v1/experiment-manifest.json'));
  const root = path.join(outputParent(home), review.failedSessionId);
  const files = [
    ['stage1-summary.json', 'stage1SummarySha256'],
    ['01-minimal/cell-summary.json', 'cellSummarySha256'],
    ['01-minimal/raw-product-result.json', 'rawProductSha256'],
    ['01-minimal/adapter-calls.json', 'adapterCallsSha256']
  ];
  for (const [relative, key] of files)
    requireValue(sha(fs.readFileSync(path.join(root, relative))) === review.evidence[key],
      `replacement evidence changed: ${relative}`);
  const summary = json(path.join(root, 'stage1-summary.json'));
  const cell = json(path.join(root, '01-minimal/cell-summary.json'));
  const product = json(path.join(root, '01-minimal/raw-product-result.json'));
  const calls = json(path.join(root, '01-minimal/adapter-calls.json'));
  requireValue(summary.cellsAttempted === 1 && summary.cellsCompleted === 1 &&
    same(summary.order, ['minimal']) && summary.stoppedClassification === 'ambiguous_failure' &&
    cell.cellHash === review.failedCellHash && cell.harnessHead === review.failedHarnessHead &&
    product.failure?.code === 'coder_provider_failed' &&
    product.candidate?.changedFileCount === 0 && product.apply === 'NOT_RUN' &&
    product.sourceRepositoryUnchanged === true &&
    calls.length === 2 && calls[0].mode === 'planner' && calls[1].mode === 'coder',
  'replacement terminal evidence');
  return { failedSessionId: review.failedSessionId,
    terminalClassification: review.terminalClassification, defect: review.defect,
    fixCommit: review.fixCommit, replacementAttemptIndex: review.replacementAttemptIndex };
}
export function verifyFinalReplacementEvidence(home = os.homedir()) {
  const review = readPlannedFinalReplacementReview(path.join(HARNESS_ROOT,
    'research/context-token-matrix-v1/experiment-manifest.json'));
  const root = path.join(outputParent(home), review.priorSessionId);
  for (const [relative, key] of [
    ['stage1-summary.json', 'stage1SummarySha256'],
    ['01-minimal/cell-summary.json', 'cellSummarySha256'],
    ['01-minimal/raw-product-result.json', 'rawProductSha256'],
    ['01-minimal/raw-bounded-result.json', 'rawBoundedSha256'],
    ['01-minimal/experiment-result.json', 'experimentResultSha256']])
    requireValue(sha(fs.readFileSync(path.join(root, relative))) === review.evidence[key],
      `final replacement evidence changed: ${relative}`);
  const summary = json(path.join(root, 'stage1-summary.json'));
  const cell = json(path.join(root, '01-minimal/cell-summary.json'));
  const product = json(path.join(root, '01-minimal/raw-product-result.json'));
  const bounded = json(path.join(root, '01-minimal/raw-bounded-result.json'));
  const syntax = bounded.verifierResult?.validationEvidence?.checks?.find(check => check.kind === 'syntax');
  requireValue(summary.cellsAttempted === 1 && summary.cellsCompleted === 1 &&
    same(summary.order, ['minimal']) && summary.stoppedClassification === 'ambiguous_failure' &&
    cell.cellHash === review.priorCellHash && cell.sessionHash === review.priorSessionHash &&
    cell.harnessHead === review.priorHarnessHead &&
    product.candidate?.changedFileCount === 2 && product.apply === 'NOT_RUN' &&
    product.sourceRepositoryUnchanged === true &&
    product.failure?.code === 'bounded_task_required_validation_not_run' &&
    syntax?.status === 'failed' && syntax.evidenceHashes?.includes(review.syntaxEvidenceHash),
  'final replacement terminal evidence');
  return { failedSessionId: review.priorSessionId,
    terminalClassification: review.terminalClassification, defect: review.defect,
    fixCommit: review.fixCommit, replacementAttemptIndex: review.finalAttemptIndex };
}
export function verifyStage1ForStage2(home = os.homedir()) {
  const review = readPlannedStage2Review(path.join(HARNESS_ROOT,
    'research/context-token-matrix-v1/experiment-manifest.json'));
  const root = path.join(outputParent(home), review.priorStage1SessionId);
  requireValue(sha(fs.readFileSync(path.join(root, 'stage1-summary.json'))) ===
    review.priorStage1SummarySha256, 'Stage 1 summary bytes changed');
  const summary = json(path.join(root, 'stage1-summary.json'));
  requireValue(summary.cellsAttempted === 3 && summary.cellsCompleted === 3 &&
    same(summary.order, review.stage2Order) && summary.stoppedClassification === null,
  'Stage 1 validity review');
  for (const [index, variant] of review.stage2Order.entries()) {
    const dir = path.join(root, `0${index + 1}-${variant}`);
    const cell = review.stage1Cells[variant];
    requireValue(sha(fs.readFileSync(path.join(dir, 'cell-summary.json'))) ===
      cell.cellSummarySha256 &&
      sha(fs.readFileSync(path.join(dir, 'experiment-result.json'))) ===
      cell.experimentResultSha256, `Stage 1 ${variant} bytes changed`);
    const observed = json(path.join(dir, 'cell-summary.json'));
    const result = json(path.join(dir, 'experiment-result.json'));
    const calls = json(path.join(dir, 'adapter-calls.json'));
    requireValue(observed.classification === 'completed' && observed.cellHash === cell.cellHash &&
      observed.sessionHash === review.priorStage1SessionHash &&
      result.outcome?.status === 'completed' && result.outcome?.behavior === 'PASS' &&
      Object.values(result.outcome?.validation ?? {}).every(value => value === 'PASS') &&
      result.outcome?.sourceRepositoryUnchanged === true &&
      calls.length === 2 && calls[0].runId === cell.plannerRunId &&
      calls[1].runId === cell.coderRunId, `Stage 1 ${variant} validity`);
  }
  return { sessionId: review.priorStage1SessionId, reviewHash: sha(fs.readFileSync(
    path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/stage2-review.json'))),
    cellsCompleted: 3 };
}
export function verifyHarnessIdentity(root = HARNESS_ROOT) {
  requireValue(git(root, ['branch', '--show-current']).stdout.trim() ===
    'research/context-token-matrix-v1', 'harness branch');
  const harnessHead = head(root);
  requireValue(git(root, ['merge-base', '--is-ancestor', BASELINE, harnessHead],
    { allowFailure: true }).status === 0, 'harness baseline ancestry');
  const tracked = git(root, ['status', '--porcelain=v1', '--untracked-files=no']).stdout.trim();
  requireValue(tracked.length === 0, 'harness tracked files are dirty');
  const untracked = status(root);
  requireValue(untracked === '' || untracked === '?? .bounded/', 'harness has unexpected untracked files');
  return harnessHead;
}
export function verifySourceIdentity(root, expectedHead = SOURCE) {
  requireValue(head(root) === expectedHead, 'source HEAD mismatch');
  const actual = status(root);
  requireValue(actual === '' || actual === '?? .bounded/', `source status changed: ${actual}`);
  return actual;
}
export function verifyJournal(file, sourceRoot, home = os.homedir()) {
  requireValue(path.isAbsolute(file) && file === expectedJournalPath(home), 'journal path');
  const real = fs.realpathSync(file);
  const source = fs.realpathSync(sourceRoot);
  requireValue(real !== source && !real.startsWith(`${source}${path.sep}`), 'journal inside source');
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'journal file type');
  const descriptor = fs.openSync(file, 'r');
  try { const header = Buffer.alloc(16); fs.readSync(descriptor, header, 0, 16, 0);
    requireValue(header.toString('utf8') === 'SQLite format 3\0', 'journal header');
  } finally { fs.closeSync(descriptor); }
  return { path: real, sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
}
export function verifyOutputWritable(root = outputParent()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const probe = path.join(root, `.preflight-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
  try { fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); }
  finally { fs.rmSync(probe, { force: true }); }
  return fs.realpathSync(root);
}
export function createSourceCheckout(parent, sourceHead = SOURCE, harness = HARNESS_ROOT) {
  requireValue(sourceHead === SOURCE, 'source SHA is not the frozen production baseline');
  const root = path.join(parent, 'source');
  requireValue(!fs.existsSync(root), 'source checkout already exists');
  git(harness, ['clone', '--quiet', '--shared', '--no-checkout', '--', harness, root]);
  git(root, ['checkout', '--quiet', '--detach', sourceHead]);
  requireValue(status(root) === '', 'new source checkout is not clean');
  return fs.realpathSync(root);
}
export async function prepareSourceCheckout(parent, manifest, harness = HARNESS_ROOT) {
  const root = createSourceCheckout(parent, manifest.sourceHead, harness);
  await initializeBoundedLocalConfig(root);
  // The configured validator runs npm scripts inside a disposable copy of this
  // source checkout. Install its own lockfile dependencies before that copy is
  // made; the research harness's node_modules is not Candidate input authority.
  const install = spawnSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  requireValue(install.error === undefined && install.status === 0 &&
    fs.realpathSync(path.join(root, 'node_modules/.bin/tsc')).startsWith(`${root}${path.sep}`),
  'pinned source lockfile dependencies unavailable offline');
  requireValue(verifySourceIdentity(root, manifest.sourceHead) === '?? .bounded/',
    'source local config did not remain untracked');
  const doctor = await doctorCommand(root);
  requireValue(doctor.exitCode === 0 && doctor.output?.ok === true &&
    doctor.output.repositoryRoot === fs.realpathSync(root), 'source doctor failed');
  return { root, doctor: doctor.output, dependencyProvisioning: 'PASS' };
}
export function makeConfig(manifest, task, variant) {
  requireValue(manifest.sourceHead === SOURCE && manifest.model === MODEL &&
    manifest.reasoning === REASONING && manifest.variants.includes(variant), 'manifest execution values');
  const config = createResearchConfig({ experimentId: task.taskId, variant,
    model: manifest.model, reasoning: manifest.reasoning,
    sourceHead: manifest.sourceHead, taskHash: task.taskHash, allowedFiles: task.allowedFiles });
  requireValue(same(config.effectivePolicy, manifest.effectivePolicies[variant]), 'variant policy drift');
  return config;
}
export async function bindTaskInput(input, { manifest, task, variant, sourceRoot }) {
  const config = makeConfig(manifest, task, variant);
  requireValue(fs.realpathSync(input.repositoryPath) === fs.realpathSync(sourceRoot) &&
    input.taskContext?.objective === json(path.join(sourceRoot, task.taskFile)).taskPrompt &&
    !Object.hasOwn(input, 'applyExecutor') && !Object.hasOwn(input, 'governedExecution'),
  'task/source/apply binding');
  const selected = await selectResearchContext({ config, repositoryPath: sourceRoot,
    seedFiles: input.taskContext.seedFiles,
    requiredTestFiles: input.taskContext.requiredTestFiles,
    forbiddenFiles: input.forbiddenFiles, currentEvidence: input.initialEvidence });
  const prepared = prepareResearchTaskInput(input, selected);
  requireValue(prepared.durableTask === input.durableTask &&
    prepared.draftValidation === input.draftValidation &&
    prepared.taskId === input.taskId && prepared.objectiveHash === input.objectiveHash &&
    prepared.acceptanceCriteriaContract === input.acceptanceCriteriaContract &&
    prepared.canonicalPolicy === input.canonicalPolicy &&
    prepared.plannerMinimalityProvider === input.plannerMinimalityProvider &&
    prepared.coderProvider === input.coderProvider &&
    prepared.contextRequestProvider === input.contextRequestProvider,
  'authority, validation, or provider changed');
  return { config, selected, prepared };
}
function currentEvidence(root, files) {
  return files.map(file => { const bytes = fs.readFileSync(path.join(root, file));
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { path: file, source: 'bounded_codex_explicit_scope_v0', content,
      contentHash: sha(bytes), byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4), matchedSymbols: [] }; });
}
export async function proveVariantPayloads(root, manifest, task) {
  const payloads = {};
  const runtimeBoundaries = {};
  const evidence = currentEvidence(root, task.allowedFiles);
  for (const variant of manifest.variants) {
    const config = makeConfig(manifest, task, variant);
    const selected = await selectResearchContext({ config, repositoryPath: root,
      seedFiles: task.allowedFiles,
      requiredTestFiles: task.allowedFiles.filter(file => /(?:^|\/)tests?\//.test(file)),
      currentEvidence: evidence });
    let calls = 0;
    const flow = await runRepoIntelligenceBoundCoderFlow({ repositoryPath: root,
      seedFiles: task.allowedFiles,
      requiredTestFiles: task.allowedFiles.filter(file => /(?:^|\/)tests?\//.test(file)),
      requiredSymbols: [], forbiddenFiles: [], authorityPresent: true, policyPresent: true,
      baseContext: { version: '1', taskContext: { objective: json(path.join(root, task.taskFile)).taskPrompt,
        seedFiles: task.allowedFiles } }, initialEvidence: selected.initialEvidence,
      hardTotalBudgetTokens: config.effectivePolicy.hardTotalBudgetTokens,
      reservedOutputTokens: config.effectivePolicy.reservedOutputTokens,
      contextRequestProvider: async () => { throw Error('offline payload probe cannot expand'); },
      coderProvider: async (context, runtime) => {
        calls++; payloads[variant] = context; runtimeBoundaries[variant] = runtime;
        return { offlineProbe: true };
      } });
    requireValue(flow.decision === 'repo_context_binding_completed' && calls === 1,
      `${variant} fake-provider gate failed`);
    requireValue(selected.selectedFileCount ===
      json(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/calibration.json'))
        .tasks.find(item => item.taskId === task.taskId).variants[variant].selectedFileCount,
    `${variant} calibrated file count changed`);
  }
  requireValue(same(payloads.minimal, payloads.current), 'minimal/current model payload differs');
  const expandedText = JSON.stringify(payloads.expanded);
  requireValue(!same(payloads.current, payloads.expanded) &&
    expandedText.includes('apps/web/src/index.ts') &&
    expandedText.includes('packages/integrations/src/index.ts'), 'expanded dependencies not model-facing');
  for (const variant of manifest.variants) {
    requireValue(!Object.hasOwn(payloads[variant], 'readableFiles') &&
      !JSON.stringify(payloads[variant]).includes('contentHash') &&
      Array.isArray(runtimeBoundaries[variant].readableFiles),
    'runtime-only authority serialized');
  }
  return Object.fromEntries(manifest.variants.map(variant => [variant,
    { modelPayloadHash: sha(JSON.stringify(payloads[variant])),
      selectedPaths: payloads[variant].evidence.map(item => item.path),
      runtimeReadableFiles: runtimeBoundaries[variant].readableFiles }]));
}
export async function preflight({ keepSource = false, attemptIndex = 3, harnessRoot = HARNESS_ROOT,
  home = os.homedir(), resultParent = outputParent(home) } = {}) {
  requireValue([1, 2, 3].includes(attemptIndex), 'replacement attempt index');
  const plan = buildDryRun();
  const manifest = json(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'));
  const harnessHead = verifyHarnessIdentity(harnessRoot);
  const remoteHead = attemptIndex === 3 ? git(harnessRoot,
    ['ls-remote', 'origin', 'refs/heads/research/context-token-matrix-v1']).stdout.trim().split(/\s+/)[0] : null;
  if (attemptIndex === 3) requireValue(remoteHead === harnessHead, 'remote harness HEAD mismatch');
  const replacementEvidence = attemptIndex === 2 ? verifyReplacementEvidence(home) :
    attemptIndex === 3 ? verifyFinalReplacementEvidence(home) : null;
  requireValue(fs.statSync(path.join(HARNESS_ROOT, 'node_modules')).isDirectory(),
    'local dependencies unavailable for candidate behavior check');
  requireValue(plan.rows.filter(row => row.stage === 'stage1').length === 3 &&
    same(plan.rows.filter(row => row.stage === 'stage1').map(row => row.variant),
      ['minimal', 'current', 'expanded']), 'Stage 1 order');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'context-token-matrix-v1-preflight-'));
  try {
    const source = await prepareSourceCheckout(parent, manifest, harnessRoot);
    const journal = verifyJournal(expectedJournalPath(home), source.root, home);
    const calibration = await calibratePilots(source.root);
    requireValue(same(calibration,
      json(path.join(HARNESS_ROOT, manifest.calibrationFile))), 'source calibration drift');
    const task = manifest.selectedTasks[0];
    const providerBinding = await proveVariantPayloads(source.root, manifest, task);
    const sessionId = `stage1-${randomBytes(12).toString('hex')}`;
    const plannedAuthority = ['minimal', 'current', 'expanded'].map(variant =>
      createPlannedContextMatrixAuthority({
        manifestPath: path.join(harnessRoot, 'research/context-token-matrix-v1/experiment-manifest.json'),
        sourceRepositoryPath: source.root, sessionId, harnessHead, variant,
        repetitionIndex: 1, ...(replacementEvidence === null ? {} : {
          replacementAttemptIndex: attemptIndex,
          replacesSessionId: replacementEvidence.failedSessionId }) }));
    const plannedCells = inspectPlannedExperimentJournal(journal.path,
      plannedAuthority.map(authority => ({ authority, sourceRepositoryPath: source.root })));
    requireValue(plannedCells.every(cell => cell.authorized && !cell.replayForbidden),
      'Stage 1 planned authority unavailable');
    if (attemptIndex === 3) requireValue(plannedCells.every(cell =>
      cell.availability === 'final_replacement_authorized' && !cell.consumed &&
      cell.plannerState === null && cell.coderState === null),
    'final replacement cells already consumed');
    const outputRoot = verifyOutputWritable(resultParent);
    const sourceStatus = verifySourceIdentity(source.root, manifest.sourceHead);
    const result = { preflightSchema: 'context-token-matrix-preflight/v1', ok: true,
      protocolVersion: manifest.protocolVersion, harnessHead, remoteHead,
      remoteHeadVerified: attemptIndex === 3, sourceHead: manifest.sourceHead,
      sourceStatus, doctor: source.doctor, journal, outputRoot,
      sessionId, sessionHash: plannedAuthority[0].sessionHash,
      plannedCells, replacementEvidence,
      finalReplacementAuthorized: attemptIndex === 3,
      dependencyProvisioning: source.dependencyProvisioning,
      retryCount: 0, repairCount: 0, applyCount: 0,
      stage1Order: ['minimal', 'current', 'expanded'], providerBinding,
      providerModelCalls: 0 };
    if (keepSource) result.sourceCheckout = source.root;
    return result;
  } finally { if (!keepSource) fs.rmSync(parent, { recursive: true, force: true }); }
}

export function assertJournalRunIdentity(identity) {
  requireValue(/^[a-z0-9][a-z0-9.-]{1,63}$/.test(identity), 'run identity');
  return identity;
}

export function makeJournalScopedAdapter(adapter, identity, onCall, plannedAuthority = null,
  onResult = null, taskBAuthorities = null) {
  assertJournalRunIdentity(identity);
  const counts = new Map();
  return { agentId: adapter.agentId, agentVersion: adapter.agentVersion,
    async run(request) {
      requireValue(request.model === MODEL && request.reasoningEffort === REASONING &&
        ['planner', 'coder'].includes(request.mode), 'provider settings drift');
      const count = counts.get(request.mode) ?? 0;
      requireValue(count === 0, 'automatic provider retry forbidden');
      counts.set(request.mode, count + 1);
      const runId = `matrix.${identity}.${request.runId}`;
      requireValue(runId.length <= 159, 'journal run ID too long');
      onCall?.({ mode: request.mode, runId, model: request.model,
        reasoning: request.reasoningEffort });
      const result = await adapter.run({ ...request, runId,
        ...(plannedAuthority === null ? {} : { plannedExperiment: plannedAuthority }),
        ...(taskBAuthorities === null ? {} : { plannedTaskB: taskBAuthorities[request.mode] }) });
      try { onResult?.(request.mode, result); } catch { /* Telemetry cannot alter provider result. */ }
      return result;
    } };
}

export function annotateCoderTrajectory(trajectory, normalized, selected) {
  if (trajectory?.schemaVersion !== 'codex-coder-trajectory/v1') return null;
  const initialEstimate = normalized.usage.coder?.initialPromptEstimatedTokens ?? null;
  const turns = trajectory.turns.map(turn => ({ ...turn,
    promptEstimatedTokensBeforeTurn: turn.turnIndex === 1 ? initialEstimate : null,
    selectedContextFileCount: turn.turnIndex === 1 ? selected.selectedFileCount : null,
    selectedContextBytes: turn.turnIndex === 1 ? selected.selectedBytes : null,
    provenance: { ...turn.provenance,
      promptEstimate: turn.turnIndex === 1 && initialEstimate !== null ? 'estimated' :
        'unavailable' } }));
  return { ...trajectory, turns, selectedContextSemantics: 'initial-selection-only',
    promptEstimateSemantics: 'first-provider-turn-only; later SDK turns unavailable',
    toolResultCarryForwardSemantics: 'bytes observed; later prompt inclusion unavailable' };
}

function mutationFromResult(result) {
  return result?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput ?? null;
}
export { classifyCell, shouldContinueAfterCell };
export function stage1Rows(plan) {
  const rows = plan?.rows?.filter(item => item.stage === 'stage1');
  requireValue(Array.isArray(rows) && rows.length === 3 &&
    same(rows.map(item => item.variant), ['minimal', 'current', 'expanded']) &&
    rows.every(item => item.eligible === true && item.repetition === 1),
  'Stage 1 order or maximum cell count');
  return rows;
}
export function stage2Rows(plan) {
  const rows = plan?.rows?.filter(item => item.stage === 'stage2_conditional');
  requireValue(Array.isArray(rows) && rows.length === 3 &&
    same(rows.map(item => item.variant), ['minimal', 'current', 'expanded']) &&
    rows.every(item => item.eligible === true && item.repetition === 2),
  'Stage 2 frozen order or maximum cell count');
  return rows;
}

function compilerDiagnostic(result, commandId, candidateFiles) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const compilerDiagnostics = [...output.matchAll(/^([^\n]+)\((\d+),(\d+)\): error (TS\d+):/gm)]
    .map(match => ({ file: match[1], line: Number(match[2]),
      column: Number(match[3]), code: match[4] }))
    .filter(item => candidateFiles.includes(item.file));
  const missing = result.error?.code === 'ENOENT' ||
    (result.status === 127 && /(?:command not found|not found)/i.test(output));
  return { commandId, executed: result.error === undefined && result.status !== null,
    exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT',
    outputTruncated: result.error?.code === 'ENOBUFS',
    failureKind: missing ? 'missing_executable' : compilerDiagnostics.length > 0
      ? 'typescript_diagnostic' : 'unknown', compilerDiagnostics };
}

export async function behaviorOnCandidate(sourceRoot, mutation, sessionRoot, task, checks) {
  if (!mutation) return { status: 'NOT_RUN', reason: 'candidate_unavailable' };
  const claims = parseTextFileUpdates(mutation);
  requireValue(claims.every(claim => task.allowedFiles.includes(claim.file)), 'behavior candidate outside allowed files');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'context-token-candidate-check-'));
  try {
    const candidate = createSourceCheckout(parent);
    for (const claim of claims) {
      const target = path.join(candidate, claim.file);
      requireValue(fs.realpathSync(target) === target &&
        target.startsWith(`${candidate}${path.sep}`) &&
        fs.lstatSync(target).isFile(), 'candidate behavior path alias');
      validateUpdateSource(claim, fs.readFileSync(target));
      fs.writeFileSync(target, claim.newContent);
    }
    const modules = path.join(HARNESS_ROOT, 'node_modules');
    requireValue(fs.statSync(modules).isDirectory(), 'local dependencies unavailable');
    fs.symlinkSync(modules, path.join(candidate, 'node_modules'), 'dir');
    const build = spawnSync('npm', ['run', 'build'], { cwd: candidate, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 1024 * 1024 });
    const check = build.status === 0 ? spawnSync(process.execPath,
      [path.join(candidate, 'scripts/controlled-coding-pilot-request-id-check.cjs'),
        '--repository', candidate], { cwd: candidate, encoding: 'utf8',
        timeout: 30_000, maxBuffer: 1024 * 1024 }) : null;
    const failedKind = checks.find(item => item.required && item.status === 'failed')?.kind;
    let validationDiagnostic = failedKind === 'syntax'
      ? compilerDiagnostic(build, 'validation.syntax', claims.map(claim => claim.file)) : null;
    if (failedKind === 'typecheck' && build.status === 0) {
      const typecheck = spawnSync('npm', ['run', 'typecheck'], { cwd: candidate,
        encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
      validationDiagnostic = compilerDiagnostic(typecheck, 'validation.typecheck',
        claims.map(claim => claim.file));
    }
    if ((failedKind === 'behavior_test' || failedKind === undefined && check?.status !== 0) && check) {
      validationDiagnostic = { commandId: 'validation.test',
        executed: check.error === undefined && check.status !== null,
        exitCode: check.status, timedOut: check.error?.code === 'ETIMEDOUT',
        outputTruncated: check.error?.code === 'ENOBUFS',
        failureKind: check.error?.code === 'ENOENT' ? 'missing_executable'
          : check.status !== 0 && /^ERR_ASSERTION\s*$/m.test(check.stderr ?? '')
            ? 'candidate_assertion' : 'unknown', checker: 'request_id_acceptance' };
    }
    const report = { status: check?.status === 0 ? 'PASS' : 'FAIL',
      buildExitCode: build.status, checkerExitCode: check?.status ?? null,
      checkerOutput: check?.status === 0 ? check.stdout.trim() : null,
      reason: check?.status === 0 ? null : 'candidate_behavior_check_failed',
      validationDiagnostic };
    save(path.join(sessionRoot, 'behavior-check.json'), report);
    return report;
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

export async function executeCell({ manifest, task, variant, sessionRoot, runIndex,
  sessionId, harnessHead, replacesSessionId, repetitionIndex = 1,
  replacementAttemptIndex = repetitionIndex === 2 ? undefined : 3,
  adapterFactory = () => new CodexAgentAdapter() }) {
  requireValue(['minimal', 'current', 'expanded'][runIndex] === variant &&
    runIndex >= 0 && runIndex < 3, 'Stage 1 cell order or limit');
  const cellRoot = path.join(sessionRoot, `0${runIndex + 1}-${variant}`);
  fs.mkdirSync(cellRoot, { mode: 0o700 });
  const checkoutParent = fs.mkdtempSync(path.join(os.tmpdir(), `context-token-matrix-v1-${variant}-`));
  try {
    const source = await prepareSourceCheckout(checkoutParent, manifest);
    save(path.join(cellRoot, 'doctor.json'), source.doctor);
    const before = verifySourceIdentity(source.root, manifest.sourceHead);
    fs.writeFileSync(path.join(cellRoot, 'source-status-before.txt'), before + '\n');
    const definition = json(path.join(source.root, task.taskFile));
    requireValue(sha(Buffer.from(definition.taskPrompt)) === task.taskHash &&
      same(definition.allowedMutationPaths, task.allowedFiles), 'task definition changed');
    const adapterCalls = [];
    let coderTrajectory = null;
    const plannedAuthority = createPlannedContextMatrixAuthority({
      manifestPath: path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'),
      sourceRepositoryPath: source.root, sessionId, harnessHead, variant,
      repetitionIndex, replacementAttemptIndex, replacesSessionId });
    save(path.join(cellRoot, 'planned-authority.json'), plannedAuthority);
    const adapter = makeJournalScopedAdapter(adapterFactory(),
      `${sha(sessionRoot).slice(7, 23)}.${variant}`, call => adapterCalls.push(call),
      plannedAuthority, (mode, result) => {
        if (mode === 'coder') coderTrajectory = result?.trajectoryTelemetry ?? null;
      });
    let binding = null;
    let rawTaskResult = null;
    let validationSpecificationHash = null;
    const started = Date.now();
    const command = await codexCommand({ task: definition.taskPrompt,
      allowFiles: task.allowedFiles }, source.root,
    { adapter, model: manifest.model, reasoningEffort: manifest.reasoning,
      runTask: async input => {
        binding = await bindTaskInput(input, { manifest, task, variant, sourceRoot: source.root });
        validationSpecificationHash = sha(JSON.stringify(input.draftValidation.executionSpecification));
        rawTaskResult = await runBoundedTask(binding.prepared);
        return rawTaskResult;
      } });
    const after = verifySourceIdentity(source.root, manifest.sourceHead);
    fs.writeFileSync(path.join(cellRoot, 'source-status-after.txt'), after + '\n');
    requireValue(before === after && command.output?.sourceRepositoryUnchanged === true &&
      command.output?.apply === 'NOT_RUN', 'source/apply invariant');
    save(path.join(cellRoot, 'raw-product-result.json'), command.output);
    save(path.join(cellRoot, 'raw-bounded-result.json'), rawTaskResult);
    save(path.join(cellRoot, 'adapter-calls.json'), adapterCalls);
    requireValue(binding !== null, 'context policy never bound');
    const selected = binding.selected;
    save(path.join(cellRoot, 'selection.json'), {
      variant, files: selected.selectedFiles, bytes: selected.selectedBytes,
      hashes: selected.initialEvidence.map(item => ({ path: item.path, hash: item.contentHash })),
      policy: binding.config.effectivePolicy, intelligenceHash: selected.intelligenceHash });
    const mutation = mutationFromResult(rawTaskResult);
    const checks = rawTaskResult?.verifierResult?.validationEvidence?.checks ?? [];
    const behavior = rawTaskResult?.verifierResult?.decision === 'approve'
      ? await behaviorOnCandidate(source.root, mutation, cellRoot, task, checks)
      : { status: 'NOT_RUN', reason: 'candidate_not_structurally_approved' };
    const syntax = checks.find(item => item.kind === 'syntax');
    const normalizedOutput = { ...command.output,
      validation: { ...command.output.validation, behavior: behavior.status } };
    const normalized = createExperimentResult({ config: binding.config,
      runId: `${path.basename(sessionRoot)}.${variant}`,
      selectedContext: selected, codexOutput: normalizedOutput,
      validationProfile: 'existing_function_bug_fix',
      validationSpecificationHash,
      validationDetail: { syntax: syntax?.status === 'passed' ? 'PASS' :
        syntax?.status === 'failed' ? 'FAIL' : 'NOT_RUN' },
      providerCalls: adapterCalls.length,
      timing: { taskElapsedMs: Date.now() - started } });
    try {
      const annotated = annotateCoderTrajectory(coderTrajectory, normalized, selected);
      if (annotated !== null) save(path.join(cellRoot, 'coder-trajectory.json'), annotated);
    } catch { /* Research telemetry must not change the cell outcome. */ }
    save(path.join(cellRoot, 'experiment-result.json'), normalized);
    const classification = classifyCell({ product: command.output, bounded: rawTaskResult,
      diagnostic: behavior.validationDiagnostic ?? null, behaviorStatus: behavior.status,
      sourceBefore: before,
      sourceAfter: after, allowedFiles: task.allowedFiles });
    save(path.join(cellRoot, 'cell-summary.json'), { variant, runIndex, repetitionIndex,
      classification, taskId: command.output.taskId,
      durableTaskDirectory: command.output.recovery?.registryRoot ?? null,
      providerAdapterCalls: adapterCalls.length, behavior: behavior.status,
      validationDiagnostic: behavior.validationDiagnostic ?? null,
      cellId: plannedAuthority.cellId, cellHash: plannedAuthority.cellHash,
      planSlotHash: plannedAuthority.planSlotHash,
      sessionHash: plannedAuthority.sessionHash,
      sourceHead: manifest.sourceHead, harnessHead: head(HARNESS_ROOT) });
    return { classification, normalized, cellRoot };
  } finally { fs.rmSync(checkoutParent, { recursive: true, force: true }); }
}

export async function runStage1() {
  requireValue(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'frozen journal path or model environment');
  const pre = await preflight({ keepSource: true });
  try {
    const authority = createPlannedContextMatrixAuthority({
      manifestPath: path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'),
      sourceRepositoryPath: pre.sourceCheckout, sessionId: pre.sessionId,
      harnessHead: pre.harnessHead, variant: 'minimal', repetitionIndex: 1,
      replacementAttemptIndex: 3, replacesSessionId: pre.replacementEvidence.failedSessionId });
    createDurableInvocationJournal(expectedJournalPath()).authorizePlannedFinalReplacement(
      authority, pre.sourceCheckout);
  } finally { fs.rmSync(path.dirname(pre.sourceCheckout), { recursive: true, force: true }); }
  const manifest = json(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'));
  const plan = buildDryRun();
  const task = manifest.selectedTasks[0];
  const sessionRoot = path.join(outputParent(), pre.sessionId);
  fs.mkdirSync(sessionRoot, { mode: 0o700 });
  fs.chmodSync(sessionRoot, 0o700);
  save(path.join(sessionRoot, 'manifest.snapshot.json'), manifest);
  fs.copyFileSync(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/PROTOCOL.md'),
    path.join(sessionRoot, 'PROTOCOL.snapshot.md'));
  fs.copyFileSync(path.join(HARNESS_ROOT, manifest.calibrationFile),
    path.join(sessionRoot, 'calibration.snapshot.json'));
  save(path.join(sessionRoot, 'preflight.json'), pre);
  save(path.join(sessionRoot, 'identities.json'), { harnessHead: pre.harnessHead,
    sourceHead: manifest.sourceHead, protocolVersion: manifest.protocolVersion,
    sessionId: pre.sessionId, sessionHash: pre.sessionHash });
  const completed = [];
  let stoppedError = null;
  let cellsAttempted = 0;
  for (const [index, row] of stage1Rows(plan).entries()) {
    requireValue(index < 3 && row.variant === ['minimal', 'current', 'expanded'][index],
      'Stage 1 order changed');
    cellsAttempted++;
    try {
      const result = await executeCell({ manifest, task, variant: row.variant, sessionRoot,
        runIndex: index, sessionId: pre.sessionId, harnessHead: pre.harnessHead,
        replacesSessionId: pre.replacementEvidence.failedSessionId });
      completed.push(result);
      requireValue(verifyHarnessIdentity() === pre.harnessHead, 'harness changed after cell');
      if (!shouldContinueAfterCell(result.classification)) break;
    } catch (error) {
      stoppedError = error instanceof Error ? error.message : 'unknown infrastructure failure';
      save(path.join(sessionRoot, 'stopped-error.json'), { variant: row.variant,
        classification: 'infrastructure_or_unclear_stop', message: stoppedError });
      break;
    }
  }
  save(path.join(sessionRoot, 'stage1-summary.json'), { cellsAttempted, cellsCompleted: completed.length,
    order: completed.map(item => item.normalized.context.variant),
    stoppedForInfrastructure: stoppedError !== null ||
      completed.at(-1)?.classification === 'infrastructure_failure',
    stoppedClassification: stoppedError !== null ? 'infrastructure_failure' :
      completed.length < 3 ? completed.at(-1)?.classification ?? null : null,
    stoppedError });
  if (completed.length > 0) {
    const { compareExperimentResults, renderComparison } = await import('./compare.mjs');
    const comparison = compareExperimentResults(completed.map(item => item.normalized));
    fs.writeFileSync(path.join(sessionRoot, 'comparison.txt'), renderComparison(comparison, 'table'));
    fs.writeFileSync(path.join(sessionRoot, 'comparison.csv'), renderComparison(comparison, 'csv'));
    fs.writeFileSync(path.join(sessionRoot, 'comparison.json'), renderComparison(comparison, 'json'));
  }
  return { sessionRoot, cellsAttempted, cellsCompleted: completed.length,
    classifications: completed.map(item => item.classification) };
}

/** Conditional, separately reviewed repetition 2 of the three frozen cells. */
export async function preflightStage2({ keepSource = false, harnessRoot = HARNESS_ROOT,
  home = os.homedir(), resultParent = outputParent(home) } = {}) {
  const plan = buildDryRun();
  const rows = stage2Rows(plan);
  const manifestPath = path.join(harnessRoot, 'research/context-token-matrix-v1/experiment-manifest.json');
  const manifest = json(manifestPath);
  const harnessHead = verifyHarnessIdentity(harnessRoot);
  const remoteHead = git(harnessRoot,
    ['ls-remote', 'origin', 'refs/heads/research/context-token-matrix-v1']).stdout.trim().split(/\s+/)[0];
  requireValue(remoteHead === harnessHead, 'remote harness HEAD mismatch');
  requireValue(same(rows.map(row => row.variant), manifest.executionOrderByCategory.A) &&
    manifest.repetitionPlan.stage2AdditionalRepetitionsPerCell === 1 &&
    manifest.repetitionPlan.stage2ConditionalOnValidityReview === true,
  'frozen Stage 2 plan');
  const prior = verifyStage1ForStage2(home);
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  requireValue(docker.status === 0 && docker.stdout.trim().length > 0,
    'validation Docker environment unavailable');
  requireValue(fs.statSync(path.join(HARNESS_ROOT, 'node_modules')).isDirectory(),
    'local dependencies unavailable for candidate behavior check');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'context-token-matrix-v1-stage2-preflight-'));
  try {
    const source = await prepareSourceCheckout(parent, manifest, harnessRoot);
    const journal = verifyJournal(expectedJournalPath(home), source.root, home);
    const calibration = await calibratePilots(source.root);
    requireValue(same(calibration, json(path.join(harnessRoot, manifest.calibrationFile))),
      'source calibration drift');
    const task = manifest.selectedTasks[0];
    const providerBinding = await proveVariantPayloads(source.root, manifest, task);
    const sessionId = `stage2-${randomBytes(12).toString('hex')}`;
    const authorities = rows.map(row => createPlannedContextMatrixAuthority({
      manifestPath, sourceRepositoryPath: source.root, sessionId, harnessHead,
      variant: row.variant, repetitionIndex: 2 }));
    const plannedCells = inspectPlannedExperimentJournal(journal.path,
      authorities.map(authority => ({ authority, sourceRepositoryPath: source.root })));
    requireValue(plannedCells.every(cell => cell.authorized && !cell.consumed &&
      !cell.replayForbidden && cell.availability === 'stage2_authorized' &&
      cell.plannerState === null && cell.coderState === null),
    'Stage 2 planned authority unavailable');
    const outputRoot = verifyOutputWritable(resultParent);
    const sourceStatus = verifySourceIdentity(source.root, manifest.sourceHead);
    const result = { preflightSchema: 'context-token-matrix-stage2-preflight/v1', ok: true,
      protocolVersion: manifest.protocolVersion, harnessHead, remoteHead,
      remoteHeadVerified: true, sourceHead: manifest.sourceHead, sourceStatus,
      doctor: source.doctor, dependencyProvisioning: source.dependencyProvisioning,
      validationDocker: 'PASS', journal, outputRoot, priorStage1: prior,
      sessionId, sessionHash: authorities[0].sessionHash, plannedCells,
      stage2Order: rows.map(row => row.variant), repetitionIndex: 2,
      retryCount: 0, repairCount: 0, applyCount: 0, providerBinding,
      providerModelCalls: 0 };
    if (keepSource) result.sourceCheckout = source.root;
    return result;
  } finally { if (!keepSource) fs.rmSync(parent, { recursive: true, force: true }); }
}

export async function runStage2() {
  requireValue(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'frozen journal path or model environment');
  const pre = await preflightStage2({ keepSource: true });
  try {
    const authority = createPlannedContextMatrixAuthority({
      manifestPath: path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'),
      sourceRepositoryPath: pre.sourceCheckout, sessionId: pre.sessionId,
      harnessHead: pre.harnessHead, variant: 'minimal', repetitionIndex: 2 });
    createDurableInvocationJournal(expectedJournalPath()).authorizePlannedStage2(
      authority, pre.sourceCheckout);
  } finally { fs.rmSync(path.dirname(pre.sourceCheckout), { recursive: true, force: true }); }
  const manifest = json(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/experiment-manifest.json'));
  const rows = stage2Rows(buildDryRun());
  const task = manifest.selectedTasks[0];
  const sessionRoot = path.join(outputParent(), pre.sessionId);
  fs.mkdirSync(sessionRoot, { mode: 0o700 });
  fs.chmodSync(sessionRoot, 0o700);
  save(path.join(sessionRoot, 'manifest.snapshot.json'), manifest);
  fs.copyFileSync(path.join(HARNESS_ROOT, 'research/context-token-matrix-v1/PROTOCOL.md'),
    path.join(sessionRoot, 'PROTOCOL.snapshot.md'));
  fs.copyFileSync(path.join(HARNESS_ROOT, manifest.calibrationFile),
    path.join(sessionRoot, 'calibration.snapshot.json'));
  save(path.join(sessionRoot, 'preflight.json'), pre);
  save(path.join(sessionRoot, 'identities.json'), { harnessHead: pre.harnessHead,
    sourceHead: manifest.sourceHead, protocolVersion: manifest.protocolVersion,
    sessionId: pre.sessionId, sessionHash: pre.sessionHash, repetitionIndex: 2 });
  const completed = [];
  let stoppedError = null;
  let cellsAttempted = 0;
  for (const [index, row] of rows.entries()) {
    cellsAttempted++;
    try {
      const result = await executeCell({ manifest, task, variant: row.variant, sessionRoot,
        runIndex: index, sessionId: pre.sessionId, harnessHead: pre.harnessHead,
        replacementAttemptIndex: undefined, repetitionIndex: 2 });
      completed.push(result);
      requireValue(verifyHarnessIdentity() === pre.harnessHead, 'harness changed after cell');
      if (!shouldContinueAfterCell(result.classification)) break;
    } catch (error) {
      stoppedError = error instanceof Error ? error.message : 'unknown infrastructure failure';
      save(path.join(sessionRoot, 'stopped-error.json'), { variant: row.variant,
        classification: 'infrastructure_or_unclear_stop', message: stoppedError });
      break;
    }
  }
  save(path.join(sessionRoot, 'stage2-summary.json'), { cellsAttempted,
    cellsCompleted: completed.length, order: completed.map(item => item.normalized.context.variant),
    stoppedForInfrastructure: stoppedError !== null ||
      completed.at(-1)?.classification === 'infrastructure_failure',
    stoppedClassification: stoppedError !== null ? 'infrastructure_failure' :
      completed.length < 3 ? completed.at(-1)?.classification ?? null : null,
    stoppedError });
  return { sessionRoot, cellsAttempted, cellsCompleted: completed.length,
    classifications: completed.map(item => item.classification) };
}
