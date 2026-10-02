import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_ROOT, MODEL, REASONING, expectedJournalPath, outputParent,
  verifyHarnessIdentity, verifySourceIdentity, verifyJournal, prepareSourceCheckout,
  makeJournalScopedAdapter, assertJournalRunIdentity, annotateCoderTrajectory } from './live-runtime.mjs';
import { calibrateTaskB } from './task-b-calibrate.mjs';
import { createResearchConfig, selectResearchContext, prepareResearchTaskInput } from './policy.mjs';
import { createExperimentResult } from './result.mjs';
import { summarizeCoderTrajectory } from './trajectory-analysis.mjs';
import { codexCommand, validationSpecification } from '../../dist/apps/cli/src/commands/codex.js';
import { runBoundedTask } from '../../dist/packages/product-runtime/src/run-bounded-task.js';
import { runContainerizedWorkspaceExecution, GIT_VALIDATION_CONTAINER_IMAGE } from '../../dist/packages/product-runtime/src/containerized-workspace-execution-runner.js';
import { CodexAgentAdapter } from '../../dist/packages/integrations/src/codex-agent-adapter.js';
import { createTaskBInvocationAuthority } from '../../dist/packages/integrations/src/task-b-invocation-authority.js';
import { inspectTaskBExperimentJournal } from '../../dist/packages/integrations/src/durable-invocation-journal.js';
import { parseTextFileUpdates, validateUpdateSource } from '../../dist/packages/product-runtime/src/text-file-update-contract.js';
import { authorizeCandidateFile, CandidatePathAuthorityError } from './candidate-path-authority.mjs';

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
const ORACLE_COPY = '.task-b-oracle/event-order.cjs';
const BUILT_PARSER = 'dist/packages/integrations/src/codex-event-parser.js';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = name => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
function gate(ok, message) { if (!ok) throw Error(`task_b_authority_invalid: ${message}`); }
function command(root, executable, args, timeout = 120_000, env = process.env) {
  return spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout,
    env, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const REMOTE_REF = 'refs/heads/research/context-token-matrix-v1';
const REMOTE_BACKOFF_MS = [250, 500];

export class TaskBRemoteAuthorityError extends Error {
  constructor(diagnostic) {
    super(`task_b_authority_invalid: ${diagnostic.issueCode}`);
    this.remoteAuthority = diagnostic;
  }
}

function transportFailureCode(result) {
  const code = result?.error?.code;
  if (['EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
    'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return {
    EAI_AGAIN: 'dns_resolution_failure', ETIMEDOUT: 'network_timeout',
    ECONNRESET: 'connection_reset', ECONNREFUSED: 'connection_refused',
    ENETUNREACH: 'remote_unreachable', EHOSTUNREACH: 'remote_unreachable' }[code];
  const stderr = result?.stderr ?? '';
  for (const [pattern, failureCode] of [
    [/could not resolve (?:host|proxy)|temporary failure in name resolution|name or service not known/i,
      'dns_resolution_failure'],
    [/connection reset|recv failure: connection was reset/i, 'connection_reset'],
    [/connection refused/i, 'connection_refused'],
    [/network is unreachable|no route to host|could not connect to server/i, 'remote_unreachable'],
    [/connection timed out|operation timed out/i, 'network_timeout'],
    [/ssl connect error|tls handshake|gnutls_handshake\(\) failed|ssl_error_syscall/i,
      'tls_transport_failure']
  ]) if (pattern.test(stderr)) return failureCode;
  return null;
}

/** Preflight transport retries only; no Candidate or provider operation is retried. */
export async function verifyTaskBRemoteAuthority(expectedHead, {
  root = HARNESS_ROOT, invoke = command,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const transientFailureCodes = [];
  const fail = (attemptCount, issueCode, reasonCode, finalRemoteSha = null,
    successfulAttempt = null) => {
    throw new TaskBRemoteAuthorityError({ attemptCount, successfulAttempt,
      finalStatus: 'FAIL', finalRemoteSha, transientFailureCodes: [...transientFailureCodes],
      issueCode, reasonCode });
  };
  for (let attemptCount = 1; attemptCount <= 3; attemptCount++) {
    const result = invoke(root, 'git', ['ls-remote', 'origin', REMOTE_REF], 30_000);
    if (!result.error && result.status === 0) {
      const match = typeof result.stdout === 'string' &&
        /^([0-9a-f]{40})\t(refs\/heads\/[^\s]+)\r?\n?$/.exec(result.stdout);
      if (!match) fail(attemptCount, 'task_b_remote_output_malformed',
        'malformed_successful_output', null, attemptCount);
      if (match[2] !== REMOTE_REF)
        fail(attemptCount, 'task_b_remote_ref_mismatch', 'wrong_branch_result', match[1], attemptCount);
      if (match[1] !== expectedHead)
        fail(attemptCount, 'task_b_remote_head_mismatch', 'authority_mismatch', match[1], attemptCount);
      return { attemptCount, successfulAttempt: attemptCount, finalStatus: 'PASS',
        finalRemoteSha: match[1], transientFailureCodes, issueCode: null, reasonCode: null };
    }
    const failureCode = transportFailureCode(result);
    if (failureCode === null)
      fail(attemptCount, 'task_b_remote_git_error', 'non_transport_git_failure');
    transientFailureCodes.push(failureCode);
    if (attemptCount === 3)
      fail(attemptCount, 'task_b_remote_transport_exhausted', 'transient_transport_failure');
    await wait(REMOTE_BACKOFF_MS[attemptCount - 1]);
  }
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
/** Preserve the frozen research ID; derive a separate adapter-safe ID from its exact fields. */
export function deriveTaskBRuntimeIdentity({ sessionId, position, replicate, variant }) {
  gate(typeof sessionId === 'string' && /^task-b-stage1-[a-z0-9-]{8,24}$/.test(sessionId) &&
    !/--|-$/.test(sessionId) && Number.isInteger(position) && position >= 1 && position <= 6 &&
    ['A', 'B'].includes(replicate) && ['minimal', 'current', 'expanded'].includes(variant),
  'runtime identity fields');
  return `${sessionId}.task-b.${position}.${replicate.toLowerCase()}.${variant}`;
}
export function assertTaskBRuntimeIdentities(slots) {
  gate(Array.isArray(slots) && slots.length === 6, 'six runtime identities required');
  const seen = new Set();
  for (const slot of slots) {
    assertJournalRunIdentity(slot.runtimeIdentity);
    gate(!seen.has(slot.runtimeIdentity), 'runtime identity normalization collision');
    seen.add(slot.runtimeIdentity);
    gate(slot.runtimeIdentity === deriveTaskBRuntimeIdentity({ sessionId: slot.sessionId,
      position: slot.position, replicate: slot.replicate, variant: slot.variant }),
    'runtime identity derivation changed');
  }
  return slots;
}
export function stage1Slots(plan, sessionId, runtimeIdentityDeriver = deriveTaskBRuntimeIdentity) {
  gate(typeof sessionId === 'string' && /^task-b-stage1-[a-z0-9-]{8,24}$/.test(sessionId) &&
    !/--|-$/.test(sessionId), 'fresh explicit Stage 1 session ID required');
  gate(same(plan.order, ORDER) && plan.providerBudget.observations === 6 &&
    plan.providerBudget.stageInvocations === 18, 'Stage 1 authority');
  const runtimeSlots = plan.order.map((label, index) => {
    const position = index + 1;
    const replicate = label[0];
    const variant = label.slice(2);
    return { position, replicate, variant, sessionId,
      runtimeIdentity: runtimeIdentityDeriver({ sessionId, position, replicate, variant }) };
  });
  assertTaskBRuntimeIdentities(runtimeSlots);
  return runtimeSlots.map(slot => ({ ...slot,
    observationId: `${sessionId}.${slot.position}.${slot.replicate}.${slot.variant}` }));
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
  if (slots.length === 6) assertTaskBRuntimeIdentities(slots);
  else gate(slots.length === 1 &&
    slots[0].runtimeIdentity === deriveTaskBRuntimeIdentity(slots[0]) &&
    assertJournalRunIdentity(slots[0].runtimeIdentity), 'runtime identity for one slot');
  if (checkDirectory) gate(!fs.existsSync(path.join(parent, slots[0].observationId.split('.')[0])),
    'historical session reuse');
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    for (const slot of slots) {
      for (const identity of [slot.runtimeIdentity, slot.observationId]) {
        const prefix = `matrix.${identity}.`;
        const row = db.prepare('SELECT count(*) AS n FROM provider_invocations WHERE substr(run_id,1,?)=?')
          .get(prefix.length, prefix);
        gate(row.n === 0, `observation identity consumed: ${slot.observationId}`);
      }
    }
  } finally { db.close(); }
}
export function preflightTaskBIdentities({ plan, sessionId, resultParent,
  journalPath, runtimeIdentityDeriver = deriveTaskBRuntimeIdentity }) {
  const slots = stage1Slots(plan, sessionId, runtimeIdentityDeriver);
  assertFreshTaskBSession(slots, resultParent, journalPath);
  return slots;
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

/** Capture the exact deterministic planner request with an offline adapter. */
export async function capturePlannerRequest(plan, variant, temporary) {
  const source = await prepareSourceCheckout(temporary, plan.proposal);
  const { selected } = await selectTaskBContext(plan, variant, source.root);
  let captured = null;
  const adapter = { agentId: 'codex', agentVersion: 'offline-task-b-authority',
    async run(request) {
      gate(request.mode === 'planner' && captured === null, 'planner request capture');
      captured = { runId: request.runId, task: request.task };
      throw Error('offline planner authority capture; no provider');
    } };
  await codexCommand({ task: plan.task.providerPrompt, allowFiles: FILES }, source.root,
    { adapter, model: MODEL, reasoningEffort: REASONING,
      runTask: input => runBoundedTask(prepareResearchTaskInput(input, selected)) });
  gate(captured !== null, 'planner request unavailable before observation reservation');
  return { sourceRoot: source.root, ...captured };
}
export async function preflightTaskBJournalAuthority(plan, slots, journalPath, temporary,
  expectedCount = 6) {
  const requests = [];
  const boundSlots = [];
  for (const slot of slots) {
    const root = path.join(temporary, `planner-capture-${slot.position}`);
    fs.mkdirSync(root);
    const captured = await capturePlannerRequest(plan, slot.variant, root);
    const input = { harnessRoot: HARNESS_ROOT, sourceRepositoryPath: captured.sourceRoot,
      sessionId: slot.sessionId, position: slot.position, replicate: slot.replicate,
      variant: slot.variant, replacement: true };
    const planner = createTaskBInvocationAuthority({ ...input, stage: 'planner' });
    const coder = createTaskBInvocationAuthority({ ...input, stage: 'coder' });
    gate(planner.observationId === slot.observationId &&
      planner.runtimeIdentity === slot.runtimeIdentity &&
      coder.observationHash === planner.observationHash &&
      coder.stageHash !== planner.stageHash, 'stage-bound planned observation');
    gate(sha(captured.task) === planner.plannerPayloadHash,
      'frozen planner payload hash');
    requests.push({ authority: planner, sourceRepositoryPath: captured.sourceRoot,
      runId: `matrix.${slot.runtimeIdentity}.${captured.runId}`, task: captured.task });
    boundSlots.push({ ...slot, taskBPlannerAuthority: planner,
      taskBCoderAuthority: coder });
  }
  const inspected = inspectTaskBExperimentJournal(journalPath, requests);
  gate(inspected.length === expectedCount && inspected.every(item =>
    item.authorized && item.coderFutureAdmissible), 'Task B planned journal authority unavailable');
  gate(inspected.every(item => item.status === 'reviewed_replacement_required'),
  'historical Task B slot classification');
  return { slots: boundSlots, inspected };
}
/** Zero-call preparation. This never creates a result session directory. */
export async function preflightTaskB({ sessionId, home = os.homedir(),
  resultParent = outputParent(home), journalPath = expectedJournalPath(home),
  verifyRemote = true } = {}) {
  const plan = loadTaskBPlan();
  gate(fs.existsSync(journalPath), 'persistent journal absent');
  const identitySlots = preflightTaskBIdentities({ plan, sessionId, resultParent, journalPath });
  return preflightTaskBForSlots({ plan, sessionId, identitySlots, home, journalPath,
    verifyRemote });
}

/** Shared zero-call checks; the caller supplies already-authorized ordered slots. */
export async function preflightTaskBForSlots({ plan, sessionId, identitySlots,
  home = os.homedir(), journalPath = expectedJournalPath(home), verifyRemote = true } = {}) {
  gate(fs.existsSync(journalPath) && Array.isArray(identitySlots) &&
    [3, 6].includes(identitySlots.length), 'preflight slot identity');
  const harnessHead = verifyHarnessIdentity();
  const remoteAuthority = verifyRemote ? await verifyTaskBRemoteAuthority(harnessHead) : null;
  const remoteHead = remoteAuthority?.finalRemoteSha ?? null;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-preflight-'));
  try {
    const probeRoot = path.join(temporary, 'candidate-path-probe');
    fs.mkdirSync(probeRoot);
    const probeFile = path.join(probeRoot, 'probe.txt');
    fs.writeFileSync(probeFile, 'offline path authority probe\n');
    const pathProbe = authorizeCandidateFile({ authorityRoot: probeRoot,
      candidatePath: probeFile, expectedCanonicalRoot: fs.realpathSync.native(probeRoot) });
    gate(pathProbe.comparisonOutcome === 'inside_authority', 'Candidate path preflight probe');
    const source = await prepareSourceCheckout(temporary, plan.proposal);
    verifySourceIdentity(source.root, SOURCE);
    const journal = verifyJournal(journalPath, source.root, home);
    const authority = await preflightTaskBJournalAuthority(plan, identitySlots, journalPath,
      temporary, identitySlots.length);
    const slots = authority.slots;
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
    const oracleWorkspace = path.join(temporary, 'oracle-preflight-workspace');
    fs.cpSync(source.root, oracleWorkspace, { recursive: true, verbatimSymlinks: true,
      filter: entry => path.basename(entry) !== '.git' });
    const oracleProbe = await runTaskBValidation(source.root, oracleWorkspace);
    gate(oracleProbe.infrastructurePass === true && oracleProbe.moduleLoaded === true &&
      oracleProbe.assertionsStarted === true && oracleProbe.behaviorPass === false &&
      oracleProbe.issueCode === 'task_b_behavior_assertion_failed',
    'containerized behavior oracle preflight');
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
      remoteAuthority,
      doctor: source.doctor, journal, validationDocker: docker.stdout.trim(),
      validationImage: image,
      candidatePathAuthority: { status: 'PASS', ...pathProbe },
      dependencyProvisioning: source.dependencyProvisioning, slots,
      plannedJournal: authority.inspected, bindings,
      retry: 0, repair: 0, apply: 0, providerModelCalls: 0 };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function mutation(result) {
  return result?.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput ?? null;
}
export function candidateClaimsWithinScope(claims) {
  return Array.isArray(claims) && claims.length > 0 &&
    claims.every(claim => typeof claim?.file === 'string' && FILES.includes(claim.file));
}
async function checkCandidate(sourceRoot, providerOutput, cellRoot) {
  if (!providerOutput) return { status: 'NOT_RUN', reason: 'candidate_unavailable' };
  let claims;
  try { claims = parseTextFileUpdates(providerOutput); }
  catch (error) { return { status: 'CANDIDATE_INVALID', reason: error.message }; }
  if (!candidateClaimsWithinScope(claims))
    return { status: 'CANDIDATE_INVALID', reason: 'Candidate scope violation' };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-candidate-'));
  try {
    const root = path.join(temporary, 'candidate');
    fs.cpSync(sourceRoot, root, { recursive: true, verbatimSymlinks: true,
      filter: entry => path.basename(entry) !== '.git' });
    const canonicalRoot = fs.realpathSync.native(root);
    const pathReceipts = [];
    for (const claim of claims) {
      const target = path.join(root, claim.file);
      let authority;
      try {
        authority = authorizeCandidateFile({ authorityRoot: root, candidatePath: target,
          expectedCanonicalRoot: canonicalRoot });
      } catch (error) {
        if (error instanceof CandidatePathAuthorityError)
          save(path.join(cellRoot, 'candidate-path-authority.json'), { status: 'REJECTED',
            path: claim.file, diagnostic: error.diagnostic });
        throw error;
      }
      pathReceipts.push({ path: claim.file, ...authority });
      try { validateUpdateSource(claim, fs.readFileSync(authority.canonicalNormalizedPath)); }
      catch (error) { return { status: 'CANDIDATE_INVALID', reason: error.message }; }
      fs.writeFileSync(authority.canonicalNormalizedPath, claim.newContent);
    }
    save(path.join(cellRoot, 'candidate-path-authority.json'), { status: 'PASS',
      authorityCanonicalRoot: canonicalRoot, files: pathReceipts });
    try {
      const validation = await runTaskBValidation(sourceRoot, root);
      return { ...validation, changedFiles: claims.map(claim => claim.file) };
    } catch {
      return { status: 'INFRASTRUCTURE_STOP', oracleStarted: false, moduleLoaded: false,
        assertionsStarted: false, assertionsCompleted: false, behaviorPass: false,
        infrastructurePass: false, issueCode: 'task_b_validator_invocation_failed',
        reasonCode: 'validator_infrastructure', changedFiles: claims.map(claim => claim.file) };
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** The immutable oracle runs beside the built Candidate in the isolated validation container. */
export async function runTaskBValidation(sourceRoot, root) {
  fs.mkdirSync(path.join(root, '.validation-output'), { recursive: true });
  const oracleBytes = fs.readFileSync(path.join(HERE, 'oracles/event-order.cjs'));
  gate(sha(oracleBytes) === loadTaskBPlan().definition.oracleSha256, 'oracle copy hash');
  fs.mkdirSync(path.join(root, '.task-b-oracle'), { recursive: true });
  fs.writeFileSync(path.join(root, ORACLE_COPY), oracleBytes);
  const configuration = JSON.parse(fs.readFileSync(path.join(sourceRoot, '.bounded/config.json'), 'utf8'));
  const specification = validationSpecification(configuration, sourceRoot);
  gate(same(specification.commands.map(item => item.args),
    [['run', 'build'], ['run', 'typecheck'], ['run', 'test']]), 'validation command drift');
  const commands = [...specification.commands,
    { id: 'task-b.module-probe', checkKind: 'behavior_test', executable: 'node',
      args: ['-e', `import('/workspace/${BUILT_PARSER}').then(() => process.stdout.write('TASK_B_MODULE_LOADED\\n'))`],
      timeoutMs: 30_000, expectedExitCodes: [0] },
    { id: 'task-b.behavior-oracle', checkKind: 'behavior_test', executable: 'node',
      args: [`/workspace/${ORACLE_COPY}`, '/workspace'], timeoutMs: 30_000,
      expectedExitCodes: [0] }];
  const validation = await runContainerizedWorkspaceExecution({ tempWorkspacePath: root,
    tempApplyDecision: 'temp_apply_ready', tempWorkspaceCleanedUp: false,
    ...specification, commands, allowedExecutables: [...specification.allowedExecutables, 'node'],
    maxCommands: 5 }, async () => null,
  { runtime: 'docker', sourceRepositoryPath: sourceRoot });
  return interpretTaskBValidation(validation);
}

/** Only a loaded oracle that reports an assertion error may fail as Candidate behavior. */
export function interpretTaskBValidation(validation) {
  const entries = validation?.commandResults;
  const results = Object.fromEntries(['build', 'typecheck', 'tests'].map((name, index) =>
    [name, { exitCode: entries?.[index]?.exitCode ?? null,
      passed: entries?.[index]?.passed ?? false }]));
  const base = { oracleStarted: false, moduleLoaded: false, assertionsStarted: false,
    assertionsCompleted: false, behaviorPass: false, infrastructurePass: false,
    issueCode: null, reasonCode: null, results };
  if (!validation || !Array.isArray(entries) || !Array.isArray(validation.issues) ||
      !['temp_validation_passed', 'temp_validation_failed'].includes(validation.decision))
    return { ...base, status: 'INFRASTRUCTURE_STOP', issueCode: 'task_b_validator_result_invalid',
      reasonCode: 'malformed_validator_result' };
  const infrastructureIssues = validation.issues.filter(item => item?.code !== 'validation_command_failed');
  if (infrastructureIssues.length || entries.length === 0)
    return { ...base, status: 'INFRASTRUCTURE_STOP',
      issueCode: infrastructureIssues[0]?.code ?? 'task_b_validator_result_missing',
      reasonCode: 'validator_infrastructure' };
  for (let index = 0; index < 3; index++) {
    if (!entries[index] || entries[index].id !== ['validation.syntax', 'validation.typecheck', 'validation.test'][index] ||
        typeof entries[index].passed !== 'boolean' || !Number.isInteger(entries[index].exitCode))
      return { ...base, status: 'INFRASTRUCTURE_STOP', issueCode: 'task_b_validator_result_invalid',
        reasonCode: 'malformed_validator_result' };
    if (!entries[index].passed)
      return { ...base, status: 'FAIL', infrastructurePass: true,
        issueCode: `task_b_candidate_${['build', 'typecheck', 'test'][index]}_failed`,
        reasonCode: 'candidate_validation_failure' };
  }
  const probe = entries[3];
  if (!probe || probe.id !== 'task-b.module-probe' || typeof probe.passed !== 'boolean' ||
      !Number.isInteger(probe.exitCode))
    return { ...base, status: 'INFRASTRUCTURE_STOP', issueCode: 'task_b_validator_result_invalid',
      reasonCode: 'malformed_validator_result' };
  if (!probe.passed || probe.stdout !== 'TASK_B_MODULE_LOADED\n')
    return { ...base, status: 'INFRASTRUCTURE_STOP', issueCode: 'task_b_oracle_module_load_failed',
      reasonCode: 'module_import_failure' };
  const loaded = { ...base, moduleLoaded: true };
  const oracle = entries[4];
  if (!oracle || oracle.id !== 'task-b.behavior-oracle' || typeof oracle.passed !== 'boolean' ||
      !Number.isInteger(oracle.exitCode))
    return { ...loaded, status: 'INFRASTRUCTURE_STOP', issueCode: 'task_b_validator_result_invalid',
      reasonCode: 'malformed_validator_result' };
  const started = { ...loaded, oracleStarted: true };
  if (oracle.passed && oracle.exitCode === 0 && oracle.stdout === 'event-order behavior PASS\n')
    return { ...started, status: 'PASS', assertionsStarted: true,
      assertionsCompleted: true, behaviorPass: true, infrastructurePass: true };
  if (oracle.exitCode === 1 && /AssertionError/.test(oracle.stderr ?? ''))
    return { ...started, status: 'FAIL', assertionsStarted: true,
      infrastructurePass: true, issueCode: 'task_b_behavior_assertion_failed',
      reasonCode: 'candidate_behavior_failure' };
  return { ...started, status: 'INFRASTRUCTURE_STOP',
    issueCode: 'task_b_oracle_process_failed', reasonCode: 'oracle_runtime_failure' };
}

export function classifyTaskBObservation(product, bounded, behavior) {
  if (behavior?.status === 'INFRASTRUCTURE_STOP') return 'infrastructure_failure';
  if (behavior?.status === 'CANDIDATE_INVALID') return 'candidate_model_failure';
  if (product?.sourceRepositoryUnchanged !== true || product?.apply !== 'NOT_RUN')
    return 'infrastructure_failure';
  if (behavior?.status === 'FAIL' &&
      (behavior.infrastructurePass !== true ||
       !['candidate_validation_failure', 'candidate_behavior_failure'].includes(behavior.reasonCode) ||
       behavior.reasonCode === 'candidate_behavior_failure' &&
         (behavior.moduleLoaded !== true || behavior.assertionsStarted !== true)))
    return 'infrastructure_failure';
  if (behavior?.status === 'PASS' &&
      (behavior.infrastructurePass !== true || behavior.behaviorPass !== true ||
       behavior.assertionsCompleted !== true)) return 'infrastructure_failure';
  if (behavior && !['PASS', 'FAIL', 'CANDIDATE_INVALID', 'NOT_RUN'].includes(behavior.status))
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
export function classifyTaskBStage2Timeout(baseClassification, coderFailureCode,
  candidateAvailable, behaviorStatus) {
  return baseClassification === 'ambiguous_failure' &&
    coderFailureCode === 'agent_timeout' && candidateAvailable === false &&
    behaviorStatus === 'NOT_RUN' ? 'production_product_timeout' : baseClassification;
}
export function taskBMayContinue(classification) {
  return ['completed', 'candidate_model_failure', 'candidate_validation_failure']
    .includes(classification);
}

export async function executeTaskBObservation(plan, slot, sessionRoot, budget, adapterFactory) {
  const cellRoot = path.join(sessionRoot, `${String(slot.position).padStart(2, '0')}-${slot.replicate}-${slot.variant}`);
  fs.mkdirSync(cellRoot, { mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'task-b-observation-'));
  try {
    const source = await prepareSourceCheckout(temporary, plan.proposal);
    const before = verifySourceIdentity(source.root, SOURCE);
    const { config, selected } = await selectTaskBContext(plan, slot.variant, source.root);
    const calls = [];
    let trajectory = null;
    let coderFailureCode = null;
    const adapter = makeJournalScopedAdapter(adapterFactory(), slot.runtimeIdentity,
      call => { budget.recordInvocation(slot.observationId); calls.push(call); }, null,
      (mode, result) => { if (mode === 'coder') {
        trajectory = result?.trajectoryTelemetry ?? null;
        coderFailureCode = result?.failureCode ?? null;
      } },
      slot.matrixAuthorities ? null :
        { planner: slot.taskBPlannerAuthority, coder: slot.taskBCoderAuthority },
      slot.matrixAuthorities ?? null);
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
    const behavior = await checkCandidate(source.root, mutation(bounded), cellRoot);
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
    const baseClassification = classifyTaskBObservation(commandResult.output, bounded, behavior);
    const classification = slot.matrixAuthorities ? classifyTaskBStage2Timeout(
      baseClassification, coderFailureCode, mutation(bounded) !== null, behavior.status) :
      baseClassification;
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
      trajectorySummary, coderShareOfInput, sourceHead: SOURCE, taskHash: TASK_HASH,
      ...(slot.matrixAuthorities ? { replacementEligible: false,
        stopClassification: classification, coderFailureCode } : {}) });
    return { ...slot, classification, providerStageInvocations: calls.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Future explicit execution entry; intentionally never called by offline tests. */
export async function runTaskBStage1({ sessionId, adapterFactory = () => new CodexAgentAdapter() } = {}) {
  gate(process.env.BOUNDED_CODEX_INVOCATION_JOURNAL_PATH === expectedJournalPath() &&
    process.env.BOUNDED_CODEX_MODEL === MODEL, 'frozen journal/model environment');
  const preflight = await preflightTaskB({ sessionId });
  const plan = loadTaskBPlan();
  assertTaskBRuntimeIdentities(preflight.slots);
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
      if (!taskBMayContinue(result.classification)) {
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
