#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResearchConfig, selectResearchContext, VARIANTS } from './policy.mjs';
import { runRepoIntelligenceBoundCoderFlow } from '../../dist/packages/product-runtime/src/repo-intelligence-context-binding.js';

export const PILOT_TASK_FILES = Object.freeze([
  'pilots/controlled-real-coding-v2/worker-request-id-correlation/task.json',
  'pilots/controlled-real-coding-v2/local-json-schema-error-classification/task.json',
  'pilots/controlled-real-coding-v1/runpod-live-help/task.json'
]);
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const isTest = file => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec|[-_.]smoke)\.[^/]+$/i.test(file);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8',
    timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw new Error('source HEAD unavailable');
  return result.stdout.trim();
}
function requireCommittedBytes(root, file) {
  const result = spawnSync('git', ['show', `HEAD:${file}`], { cwd: root,
    timeout: 10_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error ||
    !result.stdout.equals(fs.readFileSync(path.join(root, file))))
    throw new Error(`calibration source differs from HEAD: ${file}`);
}
function evidence(root, file) {
  const absolute = path.join(root, file);
  if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile())
    throw new Error(`unsafe evidence path: ${file}`);
  const bytes = fs.readFileSync(absolute);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (content.includes('\0')) throw new Error(`binary evidence: ${file}`);
  return Object.freeze({ path: file, source: 'bounded_codex_explicit_scope_v0', content,
    contentHash: sha(bytes), byteLength: bytes.length,
    estimatedTokens: Math.ceil(content.length / 4), matchedSymbols: [] });
}
function material(a, b) {
  return !same(a.selectedFiles, b.selectedFiles) || Math.abs(a.selectedBytes - b.selectedBytes) >= 1024 ||
    a.estimatedInitialTokens !== null && b.estimatedInitialTokens !== null &&
    Math.abs(a.estimatedInitialTokens - b.estimatedInitialTokens) >= 256;
}
export async function calibratePilots(sourceCheckout, taskFiles = PILOT_TASK_FILES) {
  const root = fs.realpathSync(sourceCheckout);
  const sourceHead = gitHead(root);
  const tasks = [];
  for (const taskFile of taskFiles) {
    requireCommittedBytes(root, taskFile);
    const definition = JSON.parse(fs.readFileSync(path.join(root, taskFile), 'utf8'));
    const allowedFiles = definition.allowedMutationPaths;
    if (!Array.isArray(allowedFiles) || allowedFiles.length === 0 ||
      typeof definition.taskPrompt !== 'string') throw new Error(`invalid pilot definition: ${taskFile}`);
    const currentEvidence = allowedFiles.map(file => {
      requireCommittedBytes(root, file);
      return evidence(root, file);
    });
    const requiredTestFiles = allowedFiles.filter(isTest);
    const variants = {};
    for (const variant of VARIANTS) {
      const config = createResearchConfig({ experimentId: definition.pilotId, variant,
        model: 'gpt-5.6-luna', reasoning: 'medium', sourceHead,
        taskHash: sha(definition.taskPrompt), allowedFiles });
      const selected = await selectResearchContext({ config, repositoryPath: root,
        seedFiles: allowedFiles, requiredTestFiles, currentEvidence });
      let providerInvocations = 0;
      const flow = await runRepoIntelligenceBoundCoderFlow({ repositoryPath: root,
        seedFiles: allowedFiles, requiredTestFiles, requiredSymbols: [], forbiddenFiles: [],
        baseContext: { version: '1', taskContext: { objective: definition.taskPrompt,
          seedFiles: allowedFiles, requiredTestFiles } },
        initialEvidence: selected.initialEvidence,
        hardTotalBudgetTokens: config.effectivePolicy.hardTotalBudgetTokens,
        reservedOutputTokens: config.effectivePolicy.reservedOutputTokens,
        authorityPresent: true, policyPresent: true,
        contextRequestProvider: async () => { throw new Error('offline calibration cannot expand context'); },
        coderProvider: async () => { providerInvocations++; return { offlineCalibration: true }; } });
      const estimatedInitialTokens = flow.adaptiveResult?.coderResult?.summary?.estimatedInputTokens ?? null;
      variants[variant] = { selectedFiles: selected.selectedFiles,
        selectedFileCount: selected.selectedFileCount, selectedBytes: selected.selectedBytes,
        estimatedInitialTokens, estimateSemantics: 'offline coder-context gate estimate with fixed task-context envelope',
        addedDependencies: selected.selectedFileCount - currentEvidence.length,
        gateDecision: flow.decision, gateIssues: flow.issues.map(issue => issue.code),
        offlineStubInvocations: providerInvocations,
        withinConfiguredHardLimit: estimatedInitialTokens !== null &&
          estimatedInitialTokens <= config.effectivePolicy.hardTotalBudgetTokens -
            config.effectivePolicy.reservedOutputTokens };
    }
    const [minimal, current, expanded] = VARIANTS.map(variant => variants[variant]);
    const fullValidationAvailable = Array.isArray(definition.verificationProfile) &&
      definition.verificationProfile.includes('typecheck') &&
      definition.verificationProfile.length >= 2;
    const behaviorDeterministicallyDemonstrable =
      (definition.providerRequirements ?? []).some(x => /mocked|stubbed|no real network/i.test(x)) ||
      (definition.requiredAssertions ?? []).some(x => /no upstream request/i.test(x));
    const allVariantsPassGate = Object.values(variants).every(value =>
      value.gateDecision === 'repo_context_binding_completed' && value.withinConfiguredHardLimit);
    const materiallySeparated = material(minimal, current) || material(current, expanded);
    tasks.push({ taskId: definition.pilotId, taskFile, taskType: definition.profile,
      taskHash: sha(definition.taskPrompt), allowedFiles, verificationProfile: definition.verificationProfile,
      fullValidationAvailable, behaviorDeterministicallyDemonstrable,
      externalNetworkRequired: false, applyRequired: false,
      eligibility: { sameSourceHead: true, deterministicDefinition: true,
        fullValidationAvailable, noExternalNetworkRequired: true, noApplyRequired: true,
        allVariantsPassGate, materiallySeparated,
        eligible: fullValidationAvailable && behaviorDeterministicallyDemonstrable &&
          allVariantsPassGate && materiallySeparated },
      variants, minimalEqualsCurrent: same(minimal.selectedFiles, current.selectedFiles) &&
        minimal.selectedBytes === current.selectedBytes &&
        minimal.estimatedInitialTokens === current.estimatedInitialTokens,
      currentEqualsExpanded: same(current.selectedFiles, expanded.selectedFiles) &&
        current.selectedBytes === expanded.selectedBytes &&
        current.estimatedInitialTokens === expanded.estimatedInitialTokens,
      materialPairs: { minimalCurrent: material(minimal, current),
        currentExpanded: material(current, expanded), minimalExpanded: material(minimal, expanded) } });
  }
  return { calibrationSchema: 'context-token-matrix-calibration/v1', sourceHead,
    providerModelCalls: 0, tasks };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: calibrate.mjs <pinned-source-checkout>');
    const sourceCheckout = process.argv[2];
    process.stdout.write(JSON.stringify(await calibratePilots(sourceCheckout), null, 2) + '\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
