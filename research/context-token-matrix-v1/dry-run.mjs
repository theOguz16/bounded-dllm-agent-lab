#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResearchConfig, VARIANTS } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
const defaultManifest = path.join(here, 'experiment-manifest.json');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireValue(ok, detail) { if (!ok) throw new Error(`experiment_manifest_invalid: ${detail}`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const ORDER = { A: ['minimal', 'current', 'expanded'],
  B: ['current', 'expanded', 'minimal'], C: ['expanded', 'minimal', 'current'] };
const OUTPUT_CONVENTION = '.bounded/research/context-token-matrix-v1/<sourceHead>/<taskId>/<variant>/rep-<nn>.json';
const REQUIRED_METRICS = [
  'outcome', 'validation', 'behavior', 'selectedFiles', 'selectedBytes',
  'initialPromptEstimatedTokens', 'plannerInput', 'plannerCached', 'plannerUncached',
  'plannerOutput', 'plannerTurns', 'plannerTools', 'coderInput', 'coderCached',
  'coderUncached', 'coderOutput', 'coderTurns', 'coderTools', 'aggregateInput',
  'aggregateCached', 'aggregateUncached', 'aggregateOutput', 'aggregateTotal',
  'providerCalls', 'totalTurns', 'totalToolCalls', 'expansionsRequested',
  'expansionsGranted', 'changedFiles', 'scopeViolations', 'sourceRepositoryUnchanged',
  'trustworthyElapsedTiming'
];

/** Read-only plan construction. No agent, adapter, provider, or live runner is imported. */
export function buildDryRun(manifestPath = defaultManifest) {
  const manifest = readJson(manifestPath);
  requireValue(manifest.manifestVersion === 'context-token-matrix-manifest/v1' &&
    manifest.protocolVersion === 'context-token-matrix-protocol/v1', 'version');
  requireValue(manifest.researchBranch === 'research/context-token-matrix-v1' &&
    manifest.researchBranchAnchorSha === '09c22b1afeb18e7d6702d8449b667d525f233103' &&
    manifest.productionBaselineSha === 'ea6bc88e947e78b7539b9614b4c637dd9b2805a9' &&
    manifest.sourceHead === manifest.researchBranchAnchorSha, 'source identity');
  requireValue(manifest.model === 'gpt-5.6-luna' && manifest.reasoning === 'medium' &&
    equal(manifest.variants, VARIANTS), 'model, reasoning, or variants');
  for (const variant of VARIANTS) {
    const expected = createResearchConfig({ experimentId: 'policy-probe', variant,
      model: manifest.model, reasoning: manifest.reasoning, sourceHead: manifest.sourceHead,
      taskHash: `sha256:${'0'.repeat(64)}`, allowedFiles: ['policy-probe.ts'] });
    requireValue(equal(manifest.effectivePolicies?.[variant], expected.effectivePolicy),
      `effective ${variant} policy`);
  }
  requireValue(Object.keys(manifest.effectivePolicies).length === VARIANTS.length,
    'extra effective policy');
  const execution = manifest.controlledExecution;
  requireValue(execution?.retryCount === 0 && execution.repairCount === 0 &&
    execution.applyCount === 0 &&
    execution.plannerPolicy === 'existing-bounded-planner/v1' &&
    execution.coderPolicy === 'existing-bounded-coder/v1; initial context variant only' &&
    execution.providerAuthenticationPath === 'existing-CodexAgentAdapter-host-auth' &&
    execution.invocationJournalPolicy === 'existing-Codex-durable-recovery-bridge' &&
    execution.validationSpecification?.source === 'bounded-codex-explicit-scope/v0' &&
    equal(execution.validationSpecification.commands,
      ['npm run build', 'npm run typecheck', 'npm test']) &&
    execution.validationSpecification.networkPolicy === 'existing-containerized-validation-policy',
  'controlled execution');
  requireValue(manifest.calibrationFile === 'research/context-token-matrix-v1/calibration.json' &&
    /^sha256:[0-9a-f]{64}$/.test(manifest.calibrationSha256), 'calibration binding');
  const calibrationBytes = fs.readFileSync(path.join(repository, manifest.calibrationFile));
  requireValue(sha(calibrationBytes) === manifest.calibrationSha256, 'calibration bytes changed');
  const calibration = JSON.parse(calibrationBytes);
  requireValue(calibration.calibrationSchema === 'context-token-matrix-calibration/v1' &&
    calibration.sourceHead === manifest.sourceHead && calibration.providerModelCalls === 0,
  'calibration source');
  requireValue(manifest.liveExecutionAuthorized === false &&
    manifest.liveRunOutputRootConvention === OUTPUT_CONVENTION &&
    equal(manifest.requiredMetrics, REQUIRED_METRICS), 'execution boundary or metrics');
  requireValue(equal(manifest.executionOrderByCategory, ORDER), 'variant order');
  const plan = manifest.repetitionPlan;
  requireValue(plan?.stage1RepetitionsPerCell === 1 &&
    plan.stage2AdditionalRepetitionsPerCell === 1 &&
    plan.stage2ConditionalOnValidityReview === true &&
    plan.stopStageOnDeterministicInfrastructureFailure === true,
  'repetition policy');
  requireValue(Array.isArray(manifest.selectedTasks) && manifest.selectedTasks.length > 0 &&
    manifest.selectedTasks.length <= 3, 'selected tasks');
  const seen = new Set();
  const rows = [];
  for (const task of manifest.selectedTasks) {
    requireValue(['A', 'B', 'C'].includes(task.category) && !seen.has(task.category),
      'duplicate or invalid task category');
    seen.add(task.category);
    const calibrated = calibration.tasks.find(item => item.taskId === task.taskId);
    requireValue(calibrated?.eligibility?.eligible === true && task.eligible === true &&
      calibrated.taskFile === task.taskFile && calibrated.taskHash === task.taskHash &&
      equal(calibrated.allowedFiles, task.allowedFiles) &&
      equal(calibrated.verificationProfile, task.validationProfile) &&
      (task.category !== 'A' || task.behaviorCheck ===
        'node scripts/controlled-coding-pilot-request-id-check.cjs --repository <candidate-workspace>'),
    'selected task differs from eligible calibration');
    const definition = readJson(path.join(repository, task.taskFile));
    requireValue(sha(Buffer.from(definition.taskPrompt)) === task.taskHash &&
      equal(definition.allowedMutationPaths, task.allowedFiles), 'task definition changed');
    for (let repetition = 1; repetition <= 2; repetition++) {
      for (const variant of ORDER[task.category]) {
        const configuration = createResearchConfig({ experimentId: task.taskId, variant,
          model: manifest.model, reasoning: manifest.reasoning,
          sourceHead: manifest.sourceHead, taskHash: task.taskHash,
          allowedFiles: task.allowedFiles });
        requireValue(equal(configuration.effectivePolicy, manifest.effectivePolicies[variant]),
          'policy changed since manifest freeze');
        const calibratedVariant = calibrated.variants[variant];
        requireValue(calibratedVariant?.gateDecision === 'repo_context_binding_completed' &&
          calibratedVariant.withinConfiguredHardLimit === true, 'context variant not gate eligible');
        rows.push({ stage: repetition === 1 ? 'stage1' : 'stage2_conditional',
          task: task.taskId, category: task.category, variant, repetition,
          model: manifest.model, reasoning: manifest.reasoning,
          selectedContextPolicy: configuration.effectivePolicy.optionalEvidence,
          hardTotalBudgetTokens: configuration.effectivePolicy.hardTotalBudgetTokens,
          reservedOutputTokens: configuration.effectivePolicy.reservedOutputTokens,
          allowedFiles: task.allowedFiles,
          outputPath: `.bounded/research/context-token-matrix-v1/${manifest.sourceHead}/${task.taskId}/${variant}/rep-${String(repetition).padStart(2, '0')}.json`,
          eligible: true });
      }
    }
  }
  requireValue(equal(manifest.unselectedCategories,
    ['A', 'B', 'C'].filter(category => !seen.has(category))) &&
    plan.maxPlannedRuns === rows.length, 'task set or maximum run count');
  return { dryRunSchema: 'context-token-matrix-dry-run/v1',
    protocolVersion: manifest.protocolVersion, sourceHead: manifest.sourceHead,
    liveExecutionAuthorized: false, stage1Count: rows.filter(row => row.stage === 'stage1').length,
    conditionalStage2Count: rows.filter(row => row.stage === 'stage2_conditional').length,
    maximumRunCount: rows.length, rows };
}
export function renderDryRun(plan, format = 'table') {
  if (format === 'json') return JSON.stringify(plan, null, 2) + '\n';
  requireValue(format === 'table', 'format must be table or json');
  return ['stage | task | variant | repetition | model | reasoning | context policy | allowed files | output path | eligible',
    ...plan.rows.map(row => [row.stage, row.task, row.variant, row.repetition,
      row.model, row.reasoning, row.selectedContextPolicy, row.allowedFiles.join(';'),
      row.outputPath, row.eligible].join(' | ')),
    `Stage 1: ${plan.stage1Count}; conditional Stage 2: ${plan.conditionalStage2Count}; maximum: ${plan.maximumRunCount}; live authorized: no`].join('\n') + '\n';
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let format = 'table', manifestPath = defaultManifest;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--format') format = args[++index];
      else if (args[index] === '--manifest') manifestPath = args[++index];
      else throw new Error(`unknown option: ${args[index]}`);
    }
    process.stdout.write(renderDryRun(buildDryRun(manifestPath), format));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
