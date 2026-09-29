#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResearchConfig, selectResearchContext, VARIANTS } from './policy.mjs';
import { runRepoIntelligenceBoundCoderFlow } from '../../dist/packages/product-runtime/src/repo-intelligence-context-binding.js';
import { analyzeCanonicalRepository } from '../../dist/packages/product-runtime/src/canonical-repo-intelligence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, timeout: 10_000, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) throw Error(`git ${args[0]} failed`);
  return result.stdout;
}
function committedEvidence(root, file) {
  const bytes = fs.readFileSync(path.join(root, file));
  if (!bytes.equals(git(root, ['show', `HEAD:${file}`])) || fs.realpathSync(path.join(root, file)) !== path.join(root, file))
    throw Error(`source evidence changed: ${file}`);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { path: file, source: 'pinned_source', content, contentHash: sha(bytes),
    byteLength: bytes.length, estimatedTokens: Math.ceil(content.length / 4), matchedSymbols: [] };
}
export async function calibrateTaskB(sourceCheckout) {
  const root = fs.realpathSync(sourceCheckout);
  const definition = JSON.parse(fs.readFileSync(path.join(here, 'task-b-definition.json')));
  const task = definition.sourceTask;
  if (definition.schemaVersion !== 'context-token-matrix-task-definition/v2' || definition.liveExecutionAuthorized !== false ||
      git(root, ['rev-parse', 'HEAD']).toString().trim() !== task.sourceHead) throw Error('Task B source binding');
  const { taskHash, ...withoutHash } = task;
  if (sha(Buffer.from(JSON.stringify(sorted(withoutHash)))) !== taskHash) throw Error('Task B hash mismatch');
  if (sha(fs.readFileSync(path.join(here, 'oracles/event-order.cjs'))) !== definition.oracleSha256)
    throw Error('Task B oracle changed');
  const currentEvidence = task.allowedFiles.map(file => committedEvidence(root, file));
  const requiredTestFiles = ['scripts/smoke/codex-event-parser-smoke.cjs'];
  const intelligence = await analyzeCanonicalRepository({ repositoryPath: root, seedFiles: task.allowedFiles });
  if (intelligence.decision !== 'repo_intelligence_ready') throw Error('repository intelligence unavailable');
  const edges = intelligence.intelligence.dependencyEdges;
  const variants = {};
  for (const variant of VARIANTS) {
    const config = createResearchConfig({ experimentId: 'codex-event-ordering', variant,
      model: task.model, reasoning: task.reasoning, sourceHead: task.sourceHead,
      taskHash, allowedFiles: task.allowedFiles });
    const selected = await selectResearchContext({ config, repositoryPath: root,
      seedFiles: task.allowedFiles, requiredTestFiles, currentEvidence });
    let offlineStubInvocations = 0;
    const flow = await runRepoIntelligenceBoundCoderFlow({ repositoryPath: root,
      seedFiles: task.allowedFiles, requiredTestFiles, requiredSymbols: [], forbiddenFiles: [],
      baseContext: { version: '1', taskContext: { objective: task.providerPrompt,
        seedFiles: task.allowedFiles, requiredTestFiles } },
      initialEvidence: selected.initialEvidence,
      hardTotalBudgetTokens: config.effectivePolicy.hardTotalBudgetTokens,
      reservedOutputTokens: config.effectivePolicy.reservedOutputTokens,
      authorityPresent: true, policyPresent: true,
      contextRequestProvider: async () => { throw Error('offline calibration cannot expand context'); },
      coderProvider: async () => { offlineStubInvocations++; return { offlineCalibration: true }; } });
    const estimatedInitialTokens = flow.adaptiveResult?.coderResult?.summary?.estimatedInputTokens ?? null;
    variants[variant] = {
      selectedFiles: selected.selectedFiles,
      selectedFileCount: selected.selectedFileCount,
      selectedBytes: selected.selectedBytes,
      estimatedInitialTokens,
      estimateSemantics: 'offline coder-context gate estimate using frozen Task B provider prompt',
      selectedFileHashes: selected.initialEvidence.map(e => ({ path: e.path, sha256: e.contentHash, bytes: e.byteLength })),
      gateDecision: flow.decision, gateIssues: flow.issues.map(issue => issue.code),
      offlineStubInvocations,
      withinConfiguredHardLimit: estimatedInitialTokens !== null &&
        estimatedInitialTokens <= config.effectivePolicy.hardTotalBudgetTokens - config.effectivePolicy.reservedOutputTokens
    };
  }
  const current = new Set(variants.current.selectedFiles);
  const expandedAdditions = variants.expanded.selectedFiles.filter(file => !current.has(file)).map(file => ({
    path: file,
    directEdges: edges.filter(edge => task.allowedFiles.includes(edge.from) && edge.to === file)
      .map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind ?? null }))
  }));
  return { schemaVersion: 'context-token-matrix-task-b-calibration/v1',
    sourceHead: task.sourceHead, taskHash, oracleSha256: definition.oracleSha256,
    providerModelCalls: 0, seedFiles: task.allowedFiles, requiredTestFiles,
    variants, expandedAdditions };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw Error('usage: task-b-calibrate.mjs <pinned-source-checkout>');
    process.stdout.write(JSON.stringify(await calibrateTaskB(process.argv[2]), null, 2) + '\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
