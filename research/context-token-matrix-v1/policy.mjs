import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeCanonicalRepository, verifyCanonicalRepoIntelligence } from '../../dist/packages/product-runtime/src/canonical-repo-intelligence.js';

export const EXPERIMENT_SCHEMA = 'context-token-matrix/v1';
export const SYSTEM_HARD_MAXIMUM_TOKENS = 32_768;
export const VARIANTS = Object.freeze(['minimal', 'current', 'expanded']);
const SETTINGS = Object.freeze({
  minimal: Object.freeze({ hardTotalBudgetTokens: 16_384, reservedOutputTokens: 2_048,
    optionalEvidence: 'required-only', maxAddedFiles: 0, maxAddedBytes: 0 }),
  current: Object.freeze({ hardTotalBudgetTokens: 16_384, reservedOutputTokens: 2_048,
    optionalEvidence: 'production-initial-evidence', maxAddedFiles: 0, maxAddedBytes: 0 }),
  expanded: Object.freeze({ hardTotalBudgetTokens: 32_768, reservedOutputTokens: 2_048,
    optionalEvidence: 'direct-dependencies', maxAddedFiles: 4, maxAddedBytes: 12_288 })
});
const SHA = /^sha256:[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/;
const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\x00-\x1f\x7f]+$/;
function fail(message) { throw new Error(`research_context_policy_invalid: ${message}`); }
function paths(values, name) {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string' ||
    !RELATIVE.test(v) || v.split('/').some(part => !part || part === '.'))) fail(`${name} must be safe paths`);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}
function sha(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function evidenceFromFile(root, relative, fact) {
  const absolute = path.join(root, relative);
  const real = fs.realpathSync(absolute);
  if (real !== path.join(root, relative) || !real.startsWith(`${root}${path.sep}`)) fail('context path alias');
  const bytes = fs.readFileSync(real);
  if (sha(bytes) !== fact.contentHash || bytes.length !== fact.bytes) fail('repository intelligence changed');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Object.freeze({ path: relative, source: 'research_authorized_direct_dependency', content,
    contentHash: fact.contentHash, byteLength: bytes.length,
    estimatedTokens: Math.ceil(content.length / 4), matchedSymbols: [] });
}

export function createResearchConfig({ experimentId, variant, model, reasoning, sourceHead,
  taskHash, allowedFiles }) {
  if (typeof experimentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(experimentId) ||
    !VARIANTS.includes(variant) || typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(model) ||
    !['low','medium','high','xhigh','max','ultra'].includes(reasoning) || !HEAD.test(sourceHead) ||
    !SHA.test(taskHash)) fail('configuration fields');
  const allowed = paths(allowedFiles, 'allowedFiles');
  if (allowed.length === 0) fail('allowedFiles cannot be empty');
  const setting = SETTINGS[variant];
  if (setting.hardTotalBudgetTokens > SYSTEM_HARD_MAXIMUM_TOKENS ||
    setting.reservedOutputTokens >= setting.hardTotalBudgetTokens) fail('budget exceeds system hard maximum');
  return Object.freeze({ schemaVersion: EXPERIMENT_SCHEMA, experimentId, variant, model, reasoning,
    sourceHead, taskHash, allowedFiles: Object.freeze(allowed),
    effectivePolicy: Object.freeze({ ...setting,
      systemHardMaximumTokens: SYSTEM_HARD_MAXIMUM_TOKENS,
      expansionPolicy: 'existing-bounded-request/v1' }) });
}

/** The sole experiment-policy boundary. It changes initial model evidence and the gate budget only. */
export async function selectResearchContext({ config, repositoryPath, seedFiles,
  requiredTestFiles = [], forbiddenFiles = [], currentEvidence }) {
  if (config?.schemaVersion !== EXPERIMENT_SCHEMA) fail('schema version');
  const expected = createResearchConfig(config);
  if (!config.effectivePolicy || JSON.stringify(config.effectivePolicy) !==
      JSON.stringify(expected.effectivePolicy)) fail('untrusted effective policy');
  const root = fs.realpathSync(repositoryPath);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_') &&
    !['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL'].includes(key)) delete gitEnv[key];
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv,
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore','pipe','pipe'] });
  if (head.error || head.status !== 0 || head.stdout.trim() !== config.sourceHead)
    fail('source HEAD does not match experiment configuration');
  const seeds = paths(seedFiles, 'seedFiles');
  const tests = paths(requiredTestFiles, 'requiredTestFiles');
  const forbidden = paths(forbiddenFiles, 'forbiddenFiles');
  if ([...seeds, ...tests].some(p => !config.allowedFiles.includes(p)))
    fail('required files must remain in the explicit task scope');
  const required = new Set([...seeds, ...tests]);
  if (!Array.isArray(currentEvidence) || currentEvidence.length === 0) fail('current evidence is required');
  const current = new Map();
  for (const entry of currentEvidence) {
    if (!entry || typeof entry !== 'object' || !paths([entry.path], 'evidence path').length ||
      current.has(entry.path) || typeof entry.content !== 'string' || !SHA.test(entry.contentHash) ||
      Buffer.byteLength(entry.content) !== entry.byteLength ||
      sha(Buffer.from(entry.content)) !== entry.contentHash) fail('current evidence integrity');
    current.set(entry.path, entry);
  }
  if ([...required].some(p => !current.has(p))) fail('required evidence missing');
  const analysis = await analyzeCanonicalRepository({ repositoryPath: root, seedFiles: seeds });
  if (analysis.decision !== 'repo_intelligence_ready' || !analysis.intelligence ||
    !verifyCanonicalRepoIntelligence(analysis.intelligence)) fail('repository intelligence unavailable');
  const intelligence = analysis.intelligence;
  const allowed = new Set([...intelligence.dependencyClosure, ...tests]);
  if ([...current.keys()].some(p => !allowed.has(p) || forbidden.includes(p)))
    fail('current evidence outside authorized context');
  const facts = new Map(intelligence.scannedFiles.map(f => [f.path, f]));
  for (const [name, entry] of current) {
    const fact = facts.get(name);
    if (!fact || fact.contentHash !== entry.contentHash || fact.bytes !== entry.byteLength) fail('current evidence differs from repository');
  }
  let selected = config.variant === 'minimal'
    ? [...current.values()].filter(e => required.has(e.path)) : [...current.values()];
  if (config.variant === 'expanded') {
    const direct = new Set(intelligence.dependencyEdges
      .filter(e => required.has(e.from) && allowed.has(e.to) && !current.has(e.to) &&
        !forbidden.includes(e.to))
      .map(e => e.to));
    let addedBytes = 0;
    let addedFiles = 0;
    for (const name of [...direct].sort((a, b) => a.localeCompare(b, 'en'))) {
      const fact = facts.get(name);
      if (!fact || fact.bytes > config.effectivePolicy.maxAddedBytes - addedBytes) continue;
      selected.push(evidenceFromFile(root, name, fact));
      addedBytes += fact.bytes;
      if (++addedFiles >= config.effectivePolicy.maxAddedFiles) break;
    }
  }
  const selectedFiles = Object.freeze(selected.map(e => e.path));
  return Object.freeze({ config, initialEvidence: Object.freeze(selected), selectedFiles,
    currentEvidenceBinding: Object.freeze([...current.values()].map(e => `${e.path}:${e.contentHash}`)),
    forbiddenBinding: Object.freeze(forbidden),
    selectedFileCount: selected.length,
    selectedBytes: selected.reduce((sum, e) => sum + e.byteLength, 0),
    intelligenceHash: intelligence.intelligenceHash,
    // Runtime-only facts from the analyzer pass already required for both conditions.
    intelligence,
    policyOverrides: Object.freeze({ initialEvidence: Object.freeze(selected),
      hardTotalBudgetTokens: config.effectivePolicy.hardTotalBudgetTokens,
      reservedOutputTokens: config.effectivePolicy.reservedOutputTokens }) });
}

/** Apply the selected research policy to an existing task input; all other authority fields pass through. */
export function prepareResearchTaskInput(input, selection) {
  const expected = selection?.config ? createResearchConfig(selection.config) : null;
  if (!input || !selection?.config || !Array.isArray(input.initialEvidence) ||
      JSON.stringify(selection.config.effectivePolicy) !== JSON.stringify(expected.effectivePolicy) ||
      selection.policyOverrides?.hardTotalBudgetTokens !== expected.effectivePolicy.hardTotalBudgetTokens ||
      selection.policyOverrides?.reservedOutputTokens !== expected.effectivePolicy.reservedOutputTokens ||
      selection.policyOverrides?.initialEvidence !== selection.initialEvidence ||
      JSON.stringify(paths(input.allowedChangeFiles, 'allowedChangeFiles')) !==
        JSON.stringify(selection.config.allowedFiles)) fail('task authority differs from research configuration');
  const original = input.initialEvidence.map(e => `${e.path}:${e.contentHash}`);
  if (JSON.stringify(original) !== JSON.stringify(selection.currentEvidenceBinding))
    fail('task initial evidence differs from selected baseline');
  if (JSON.stringify(paths(input.forbiddenFiles ?? [], 'forbiddenFiles')) !==
      JSON.stringify(selection.forbiddenBinding)) fail('task forbidden boundary changed');
  if (selection.config.variant === 'current') {
    if (JSON.stringify(original) !== JSON.stringify(selection.initialEvidence.map(e => `${e.path}:${e.contentHash}`)) ||
        input.hardTotalBudgetTokens !== selection.config.effectivePolicy.hardTotalBudgetTokens ||
        input.reservedOutputTokens !== selection.config.effectivePolicy.reservedOutputTokens)
      fail('current variant must be production-equivalent');
    return input;
  }
  return { ...input, ...selection.policyOverrides };
}
