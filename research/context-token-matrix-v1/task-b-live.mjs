import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_ROOT, MODEL, REASONING, expectedJournalPath, outputParent,
  verifyHarnessIdentity, verifySourceIdentity, verifyJournal, prepareSourceCheckout,
  makeJournalScopedAdapter, annotateCoderTrajectory } from './live-runtime.mjs';
import { calibrateTaskB } from './task-b-calibrate.mjs';
import { createResearchConfig, selectResearchContext, prepareResearchTaskInput } from './policy.mjs';
import { createExperimentResult } from './result.mjs';
import { summarizeCoderTrajectory } from './trajectory-analysis.mjs';
import { codexCommand, validationSpecification } from '../../dist/apps/cli/src/commands/codex.js';
import { runBoundedTask } from '../../dist/packages/product-runtime/src/run-bounded-task.js';
import { runContainerizedWorkspaceExecution, GIT_VALIDATION_CONTAINER_IMAGE } from '../../dist/packages/product-runtime/src/containerized-workspace-execution-runner.js';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';
import { parseTextFileUpdates, validateUpdateSource } from '../../dist/packages/product-runtime/src/text-file-update-contract.js';

const HERE = path.join(HARNESS_ROOT, 'research/context-token-matrix-v1');
const SOURCE = 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9';
const TASK_HASH = 'sha256:6bdb0008f1333479994b0070bb61a14e0cffa0e28c2cf4eb8452f9deea7ca5e0';
const ORDER = Object.freeze(['A:minimal', 'A:current', 'A:expanded',
  'B:current', 'B:expanded', 'B:minimal']);
const FILES = Object.freeze(['packages/integrations/src/codex-event-parser.ts',
  'scripts/smoke/codex-event-parser-smoke.cjs']);
const EXTRAS = Object.freeze(['packages/integrations/src/agent-adapter.ts',
  'packages/integrations/src/agent-telemetry.ts']);
const ORACLE = 'node {benchmark}/oracles/event-order.cjs {candidate}';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = name => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
function gate(ok, message) { if (!ok) throw Error(`task_b_authority_invalid: ${message}`); }
function command(root, executable, args, timeout = 120_000, env = process.env) {
  return spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout,
    env, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function checked(root, executable, args, timeout) {
  const result = command(root, executable, args, timeout);
  gate(!result.error && result.status === 0,
    `${executable} ${args.join(' ')} failed: ${(result.stderr ?? '').slice(-500)}`);
  return result.stdout.trim();
}
function committed(file) {
  const bytes = fs.readFileSync(path.join(HARNESS_ROOT, file));
  const gitBytes = spawnSync('git', ['show', `HEAD:${file}`], { cwd: HARNESS_ROOT,
    maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
  gate(gitBytes.status === 0 && bytes.equals(gitBytes.stdout), `uncommitted frozen file: ${file}`);
  return bytes;
}
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

/** Task B authority is separate from the historical Task A replacement authority. */
export function validateTaskBPlan(proposal, definition, calibration) {
  const task = definition?.sourceTask;
  gate(proposal?.schemaVersion === 'context-token-matrix-two-task-proposal/v1' &&
    proposal.status === 'offline_frozen_proposal_not_live_authority' &&
    proposal.liveExecutionAuthorized === false, 'proposal status');
  gate(definition?.schemaVersion === 'context-token-matrix-task-definition/v2' &&
    definition.liveExecutionAuthorized === false && task?.taskId === 'R4' &&
    task.name === undefined && definition.name === 'Codex event ordering', 'definition identity');
  const { taskHash, ...withoutHash } = task;
  gate(taskHash === TASK_HASH && proposal.taskBHash === TASK_HASH &&
    calibration?.taskHash === TASK_HASH && sha(Buffer.from(JSON.stringify(sorted(withoutHash)))) === TASK_HASH,
  'Task B hash');
  gate(task.sourceHead === SOURCE && proposal.sourceHead === SOURCE &&
    calibration.sourceHead === SOURCE, 'source SHA');
  gate(task.model === MODEL && proposal.model === MODEL && task.reasoning === REASONING &&
    proposal.reasoning === REASONING && same(proposal.variants, ['minimal', 'current', 'expanded']),
  'model/reasoning/variants');
  gate(same(task.allowedFiles, FILES) && same(calibration.seedFiles, FILES) &&
    same(calibration.requiredTestFiles, [FILES[1]]), 'allowed or seed files');
  gate(task.oracle === ORACLE && same(task.validationCommands, [
    'npm run build', 'npm run typecheck', 'npm test', ORACLE]) &&
    definition.oracleCopy === 'research/context-token-matrix-v1/oracles/event-order.cjs' &&
    definition.oracleSha256 === proposal.controlledExecution?.oracleSha256 &&
    definition.oracleSha256 === calibration.oracleSha256, 'behavioral oracle');
  gate(task.providerPrompt.startsWith(task.taskText + '\nAllowed files: ') &&
    task.providerPrompt.includes(`Allowed files: ${FILES.join(', ')}`) &&
    task.providerPrompt.endsWith('The behavioral acceptance described above must also pass.'),
  'task wording');
  gate(same(proposal.stage1Order, ORDER) &&
    same(proposal.stage2ConditionalOrder, ORDER) &&
    proposal.maximumObservations === 12 &&
    proposal.maximumPlannedProviderStageInvocationsPerObservation === 3 &&
    proposal.maximumPlannedProviderStageInvocations === 36, 'execution order or budget');
  const control = proposal.controlledExecution;
  gate(same([control.retry, control.repair, control.apply], [0, 0, 0]) &&
    same([task.policy.retry, task.policy.repair, task.policy.apply], [0, 0, 0]) &&
    control.freshPinnedSourceCheckoutPerObservation === true &&
    control.trajectoryTelemetry === 'codex-coder-trajectory/v1' &&
    control.trajectoryObservationalOnly === true, 'retry/repair/apply or trajectory');
  gate(calibration.schemaVersion === 'context-token-matrix-task-b-calibration/v1' &&
    calibration.providerModelCalls === 0, 'calibration identity');
  for (const variant of ['minimal', 'current', 'expanded']) {
    const cell = calibration.variants?.[variant];
    const expectedFiles = variant === 'expanded' ? [...FILES, ...EXTRAS] : [...FILES];
    const expectedBytes = variant === 'expanded' ? 33962 : 24668;
    const expectedTokens = variant === 'expanded' ? 9435 : 6944;
    gate(same(cell?.selectedFiles, expectedFiles) && cell.selectedFileCount === expectedFiles.length &&
      cell.selectedBytes === expectedBytes && cell.estimatedInitialTokens === expectedTokens &&
      same(cell.selectedFileHashes?.map(item => item.path), expectedFiles) &&
      cell.gateDecision === 'repo_context_binding_completed' &&
      cell.offlineStubInvocations === 1 && cell.withinConfiguredHardLimit === true,
    `${variant} context calibration`);
  }
  gate(same(calibration.variants.minimal, calibration.variants.current) &&
    same(calibration.expandedAdditions.map(item => item.path), EXTRAS),
  'minimal/current equality or expanded additions');
  return { proposal, definition, calibration, task, order: [...ORDER],
    providerBudget: { observations: 6, stageInvocations: 18, perObservation: 3 } };
}

export function loadTaskBPlan({ committedFiles = true } = {}) {
  const proposal = read('task-b-prospective-manifest.json');
  const definition = read('task-b-definition.json');
  const calibration = read('task-b-calibration.json');
  const plan = validateTaskBPlan(proposal, definition, calibration);
  if (committedFiles) committed('research/context-token-matrix-v1/task-b-prospective-manifest.json');
  for (const [file, hash] of [
    [proposal.frozenTaskAManifest, proposal.frozenTaskAManifestSha256],
    [proposal.taskBDefinition, proposal.taskBDefinitionSha256],
    [proposal.taskBCalibration, proposal.taskBCalibrationSha256],
    [definition.oracleCopy, definition.oracleSha256]]) {
    gate(sha(committedFiles ? committed(file) : fs.readFileSync(path.join(HARNESS_ROOT, file))) === hash,
      `frozen file hash: ${file}`);
  }
  return plan;
}

export function selectTask(selection) {
  gate(selection === 'A' || selection === 'B', 'explicit task selection required');
  return selection;
}
export function stage1Slots(plan, sessionId) {
  gate(typeof sessionId === 'string' && /^task-b-stage1-[a-z0-9-]{8,24}$/.test(sessionId) &&
    !/--|-$/.test(sessionId), 'fresh explicit Stage 1 session ID required');
  gate(same(plan.order, ORDER) && plan.providerBudget.observations === 6 &&
    plan.providerBudget.stageInvocations === 18, 'Stage 1 authority');
  return plan.order.map((label, index) => ({ position: index + 1,
    replicate: label[0], variant: label.slice(2),
    observationId: `${sessionId}.${index + 1}.${label.replace(':', '.')}` }));
}
export function createTaskBBudget() {
  const identities = new Set();
  let invocations = 0;
  const perIdentity = new Map();
  return {
    reserveObservation(identity) {
      gate(identities.size < 6 && !identities.has(identity), 'duplicate or extra observation identity');
      identities.add(identity);
    },
    recordInvocation(identity) {
      gate(identities.has(identity), 'provider invocation without reserved observation');
      const count = perIdentity.get(identity) ?? 0;
      gate(count < 3 && invocations < 18, 'provider budget ceiling');
      perIdentity.set(identity, count + 1); invocations++;
    },
    snapshot() { return { observations: identities.size, providerStageInvocations: invocations }; }
  };
}
export function assertFreshTaskBSession(slots, parent, journalPath, { checkDirectory = true } = {}) {
  if (checkDirectory) gate(!fs.existsSync(path.join(parent, slots[0].observationId.split('.')[0])),
    'historical session reuse');
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    for (const slot of slots) {
      const prefix = `matrix.${slot.observationId}.`;
      const row = db.prepare('SELECT count(*) AS n FROM provider_invocations WHERE substr(run_id,1,?)=?')
        .get(prefix.length, prefix);
      gate(row.n === 0, `observation identity consumed: ${slot.observationId}`);
    }
  } finally { db.close(); }
}

function evidence(root, files) {
  return files.map(file => {
    const bytes = fs.readFileSync(path.join(root, file));
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { path: file, source: 'bounded_codex_explicit_scope_v0', content,
      contentHash: sha(bytes), byteLength: bytes.length,
      estimatedTokens: Math.ceil(content.length / 4), matchedSymbols: [] };
  });
}
export async function selectTaskBContext(plan, variant, sourceRoot) {
  const config = createResearchConfig({ experimentId: 'codex-event-ordering', variant,
    model: MODEL, reasoning: REASONING, sourceHead: SOURCE,
    taskHash: TASK_HASH, allowedFiles: plan.task.allowedFiles });
  const selected = await selectResearchContext({ config, repositoryPath: sourceRoot,
    seedFiles: FILES, requiredTestFiles: [FILES[1]], currentEvidence: evidence(sourceRoot, FILES) });
  const frozen = plan.calibration.variants[variant];
  gate(same(selected.selectedFiles, frozen.selectedFiles) &&
    selected.selectedBytes === frozen.selectedBytes &&
    same(selected.initialEvidence.map(item => ({ path: item.path, sha256: item.contentHash,
      bytes: item.byteLength })), frozen.selectedFileHashes), `${variant} selected context drift`);
  return { config, selected };
}

/** Zero-call preparation. This never creates a result session directory. */
export async function preflightTaskB({ sessionId, home = os.homedir(),
  resultParent = outputParent(home), journalPath = expectedJournalPath(home),
  verifyRemote = true } = {}) {
  const plan = loadTaskBPlan();
  const slots = stage1Slots(plan, sessionId);
  const harnessHead = verifyHarnessIdentity();
  const remoteHead = verifyRemote ? checked(HARNESS_ROOT, 'git',
    ['ls-remote', 'origin', 'refs/heads/research/context-token-matrix-v1'], 30_000).split(/\s+/)[0] : null;
  if (verifyRemote) gate(remoteHead === harnessHead, 'remote harness HEAD mismatch');
  gate(fs.existsSync(journalPath), 'persistent journal absent');
  assertFreshTaskBSession(slots, resultParent, journalPath);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-preflight-'));
  try {
    const source = await prepareSourceCheckout(temporary, plan.proposal);
    verifySourceIdentity(source.root, SOURCE);
    const journal = verifyJournal(journalPath, source.root, home);
    const cleanEnv = { ...process.env };
    delete cleanEnv.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH;
    for (const args of [['run', 'build'], ['run', 'typecheck'], ['test']]) {
      const result = command(source.root, 'npm', args, 180_000, cleanEnv);
      gate(!result.error && result.status === 0, `pinned source npm ${args.join(' ')} failed`);
    }
    const unchangedOracle = command(source.root, process.execPath,
      [path.join(HERE, 'oracles/event-order.cjs'), source.root], 30_000, cleanEnv);
    gate(!unchangedOracle.error && unchangedOracle.status === 1 &&
      /AssertionError/.test(unchangedOracle.stderr ?? ''), 'unchanged source oracle rejection');
    const computed = await calibrateTaskB(source.root);
    gate(same(computed, plan.calibration), 'source context bytes or token estimate drift');
    const bindings = {};
    for (const variant of ['minimal', 'current', 'expanded']) {
      const { selected } = await selectTaskBContext(plan, variant, source.root);
      bindings[variant] = { files: selected.selectedFiles, bytes: selected.selectedBytes,
        estimatedTokens: plan.calibration.variants[variant].estimatedInitialTokens };
    }
    const docker = command(HARNESS_ROOT, 'docker', ['info', '--format', '{{.ServerVersion}}'], 15_000);
    gate(!docker.error && docker.status === 0, 'validation Docker daemon unavailable');
    const image = GIT_VALIDATION_CONTAINER_IMAGE;
    const inspect = command(HARNESS_ROOT, 'docker', ['image', 'inspect', image], 15_000);
    gate(!inspect.error && inspect.status === 0, 'required local validation image unavailable');
    const container = command(HARNESS_ROOT, 'docker', ['run', '--rm', '--pull=never',
      '--network', 'none', image, 'node', '-e', 'process.stdout.write("READY")'], 30_000);
    gate(!container.error && container.status === 0 && container.stdout === 'READY',
      'network-disabled validation container unavailable');
    return { schemaVersion: 'context-token-matrix-task-b-preflight/v1', ok: true,
      sessionId, taskHash: TASK_HASH, sourceHead: SOURCE, harnessHead, remoteHead,
      doctor: source.doctor, journal, validationDocker: docker.stdout.trim(),
      validationImage: image,
      dependencyProvisioning: source.dependencyProvisioning, slots, bindings,
      retry: 0, repair: 0, apply: 0, providerModelCalls: 0 };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function mutation(result) {
  return result?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput ?? null;
}
async function checkCandidate(sourceRoot, providerOutput) {
  if (!providerOutput) return { status: 'NOT_RUN', reason: 'candidate_unavailable' };
  let claims;
  try { claims = parseTextFileUpdates(providerOutput); }
  catch (error) { return { status: 'CANDIDATE_INVALID', reason: error.message }; }
  if (claims.length === 0 || claims.some(claim => !FILES.includes(claim.file)))
    return { status: 'CANDIDATE_INVALID', reason: 'Candidate scope violation' };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-candidate-'));
  try {
    const root = path.join(temporary, 'candidate');
    fs.cpSync(sourceRoot, root, { recursive: true, verbatimSymlinks: true,
      filter: entry => path.basename(entry) !== '.git' });
    for (const claim of claims) {
      const target = path.join(root, claim.file);
      gate(fs.realpathSync(target) === target && target.startsWith(root + path.sep), 'Candidate path alias');
      try { validateUpdateSource(claim, fs.readFileSync(target)); }
      catch (error) { return { status: 'CANDIDATE_INVALID', reason: error.message }; }
      fs.writeFileSync(target, claim.newContent);
    }
    fs.mkdirSync(path.join(root, '.validation-output'));
    const configuration = JSON.parse(fs.readFileSync(path.join(sourceRoot, '.bounded/config.json'), 'utf8'));
    const specification = validationSpecification(configuration, sourceRoot);
    gate(same(specification.commands.map(item => item.args),
      [['run', 'build'], ['run', 'typecheck'], ['run', 'test']]), 'validation command drift');
    const validation = await runContainerizedWorkspaceExecution({ tempWorkspacePath: root,
      tempApplyDecision: 'temp_apply_ready', tempWorkspaceCleanedUp: false,
      ...specification }, async () => null, { runtime: 'docker', sourceRepositoryPath: sourceRoot });
    const results = Object.fromEntries(['build', 'typecheck', 'tests'].map((name, index) =>
      [name, { exitCode: validation.commandResults?.[index]?.exitCode ?? null,
        passed: validation.commandResults?.[index]?.passed ?? false }]));
    if (validation.issues?.some(item => /container|docker|runtime|image/i.test(item.code)))
      return { status: 'INFRASTRUCTURE_STOP', results, issues: validation.issues };
    const oracle = command(root, process.execPath,
      [path.join(HERE, 'oracles/event-order.cjs'), root], 30_000);
    results.behavior = { exitCode: oracle.status, error: oracle.error?.message ?? null,
      stderrTail: (oracle.stderr ?? '').slice(-1000) };
    if (oracle.error || oracle.status === null) return { status: 'INFRASTRUCTURE_STOP', results };
    return { status: validation.decision === 'temp_validation_passed' && oracle.status === 0
      ? 'PASS' : 'FAIL', changedFiles: claims.map(claim => claim.file), results,
      issues: validation.issues };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function classifyTaskBObservation(product, bounded, behavior) {
  if (behavior?.status === 'INFRASTRUCTURE_STOP') return 'infrastructure_failure';
  if (behavior?.status === 'CANDIDATE_INVALID') return 'candidate_model_failure';
  if (product?.sourceRepositoryUnchanged !== true || product?.apply !== 'NOT_RUN')
    return 'infrastructure_failure';
  if (product.decision === 'bounded_task_completed' && bounded?.decision === 'bounded_task_completed')
    return behavior?.status === 'PASS' ? 'completed' :
      behavior?.status === 'FAIL' ? 'candidate_validation_failure' : 'ambiguous_failure';
  if (product.failure?.stage === 'coding' &&
      product.failure.code === 'bounded_task_coder_output_invalid') return 'candidate_model_failure';
  if (product.failure?.stage === 'verification' &&
      product.failure.code === 'bounded_task_mutation_scope_violation') return 'candidate_model_failure';
  if (product.failure?.stage === 'validation' && bounded?.verifierResult?.decision === 'approve' &&
      behavior?.status === 'FAIL') return 'candidate_validation_failure';
  return 'ambiguous_failure';
}

async function executeTaskBObservation(plan, slot, sessionRoot, budget, adapterFactory) {
  const cellRoot = path.join(sessionRoot, `${String(slot.position).padStart(2, '0')}-${slot.replicate}-${slot.variant}`);
  fs.mkdirSync(cellRoot, { mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-observation-'));
  try {
    const source = await prepareSourceCheckout(temporary, plan.proposal);
    const before = verifySourceIdentity(source.root, SOURCE);
    const { config, selected } = await selectTaskBContext(plan, slot.variant, source.root);
    const calls = [];
    let trajectory = null;
    const adapter = makeJournalScopedAdapter(adapterFactory(), slot.observationId,
      call => { budget.recordInvocation(slot.observationId); calls.push(call); }, null,
      (mode, result) => { if (mode === 'coder') trajectory = result?.trajectoryTelemetry ?? null; });
    let bounded = null;
    let validationSpecificationHash = null;
    const started = Date.now();
    const commandResult = await codexCommand({ task: plan.task.providerPrompt,
      allowFiles: FILES }, source.root, { adapter, model: MODEL, reasoningEffort: REASONING,
      runTask: async input => {
        gate(input.taskContext?.objective === plan.task.providerPrompt &&
          same(input.allowedChangeFiles, FILES) &&
          !Object.hasOwn(input, 'applyExecutor') && !Object.hasOwn(input, 'governedExecution'),
        'task input or apply drift');
        const bound = await selectTaskBContext(plan, slot.variant, source.root);
        gate(same(bound.selected.selectedFiles, selected.selectedFiles) &&
          bound.selected.selectedBytes === selected.selectedBytes, 'context changed before provider');
        validationSpecificationHash = sha(JSON.stringify(input.draftValidation.executionSpecification));
        bounded = await runBoundedTask(prepareResearchTaskInput(input, selected));
        return bounded;
      } });
    const after = verifySourceIdentity(source.root, SOURCE);
    gate(before === after && commandResult.output?.sourceRepositoryUnchanged === true &&
      commandResult.output?.apply === 'NOT_RUN', 'source changed or apply occurred');
    const behavior = await checkCandidate(source.root, mutation(bounded));
    const traces = bounded?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.traces;
    const expansion = Array.isArray(traces) ? {
      requested: traces.length,
      granted: traces.filter(item => item.resolutionDecision === 'context_expansion_ready').length,
      tokens: traces.every(item => Number.isSafeInteger(item.estimatedTokens) && item.estimatedTokens >= 0)
        ? traces.reduce((sum, item) => sum + item.estimatedTokens, 0) : null,
      bytes: null
    } : null;
    const normalized = createExperimentResult({ config, runId: slot.observationId,
      selectedContext: selected, codexOutput: { ...commandResult.output,
        validation: { ...commandResult.output.validation, behavior: behavior.status } },
      validationProfile: 'existing_function_bug_fix', validationSpecificationHash,
      expansion, providerCalls: calls.length, timing: { taskElapsedMs: Date.now() - started } });
    let annotated = null;
    let trajectorySummary = null;
    try {
      annotated = annotateCoderTrajectory(trajectory, normalized, selected);
      trajectorySummary = annotated ? summarizeCoderTrajectory(annotated) : null;
    } catch { /* Trajectory telemetry is observational and cannot change Candidate outcome. */ }
    const coderInput = normalized.usage.coder?.cumulativeInputTokens ?? null;
    const aggregateInput = normalized.usage.aggregate.input;
    const coderShareOfInput = coderInput === null || aggregateInput === null || aggregateInput === 0
      ? null : Number((coderInput / aggregateInput).toFixed(4));
    const classification = classifyTaskBObservation(commandResult.output, bounded, behavior);
    save(path.join(cellRoot, 'source-status.json'), { before, after });
    save(path.join(cellRoot, 'adapter-calls.json'), calls);
    save(path.join(cellRoot, 'raw-product-result.json'), commandResult.output);
    save(path.join(cellRoot, 'raw-bounded-result.json'), bounded);
    save(path.join(cellRoot, 'selection.json'), { files: selected.selectedFiles,
      bytes: selected.selectedBytes, estimatedTokens: plan.calibration.variants[slot.variant].estimatedInitialTokens });
    save(path.join(cellRoot, 'behavior-check.json'), behavior);
    save(path.join(cellRoot, 'context-expansion.json'), { expansion, traces: traces ?? null });
    save(path.join(cellRoot, 'experiment-result.json'), normalized);
    if (annotated) save(path.join(cellRoot, 'coder-trajectory.json'), annotated);
    save(path.join(cellRoot, 'cell-summary.json'), { ...slot, classification,
      providerStageInvocations: calls.length, behavior: behavior.status,
      trajectorySummary, coderShareOfInput, sourceHead: SOURCE, taskHash: TASK_HASH });
    return { ...slot, classification, providerStageInvocations: calls.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Future explicit execution entry; intentionally never called by offline tests. */
export async function runTaskBStage1({ sessionId, adapterFactory = () => new CodexAgentAdapter() } = {}) {
  gate(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'frozen journal/model environment');
  const preflight = await preflightTaskB({ sessionId });
  const plan = loadTaskBPlan();
  fs.mkdirSync(outputParent(), { recursive: true, mode: 0o700 });
  const sessionRoot = path.join(outputParent(), sessionId);
  fs.mkdirSync(sessionRoot, { recursive: false, mode: 0o700 });
  save(path.join(sessionRoot, 'preflight.json'), preflight);
  save(path.join(sessionRoot, 'proposal.snapshot.json'), plan.proposal);
  save(path.join(sessionRoot, 'definition.snapshot.json'), plan.definition);
  save(path.join(sessionRoot, 'calibration.snapshot.json'), plan.calibration);
  const budget = createTaskBBudget();
  const observations = [];
  let stop = null;
  for (const slot of preflight.slots) {
    try {
      gate(verifyHarnessIdentity() === preflight.harnessHead, 'harness changed');
      assertFreshTaskBSession([slot], outputParent(), expectedJournalPath(), { checkDirectory: false });
      budget.reserveObservation(slot.observationId);
      save(path.join(sessionRoot, `reservation-${slot.position}.json`), slot);
      const result = await executeTaskBObservation(plan, slot, sessionRoot, budget, adapterFactory);
      observations.push(result);
      if (!['completed', 'candidate_model_failure', 'candidate_validation_failure'].includes(result.classification)) {
        stop = result.classification; break;
      }
    } catch (error) {
      stop = `infrastructure_or_ambiguous: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  const report = { sessionId, observations, planned: preflight.slots,
    budget: budget.snapshot(), stop, providerModelCalls: budget.snapshot().providerStageInvocations };
  save(path.join(sessionRoot, 'stage1-summary.json'), report);
  return { sessionRoot, ...report };
}
