'use strict';
const crypto = require('node:crypto');

const VERSION = 'robustness-scope-attribution/v2';
const PHASES = ['validation', 'runtime', 'telemetry', 'generated_output'];
function hash(value) { return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex'); }
function pathName(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) throw Error('invalid path');
  const parts = value.split('/');
  if (value.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')) throw Error('invalid path');
  return value;
}
function manifest(entries) {
  if (entries === null || entries === undefined) return null;
  if (!Array.isArray(entries)) throw Error('manifest must be an array');
  const result = new Map();
  for (const entry of entries) {
    const path = pathName(entry.path);
    if (result.has(path) || !/^sha256:[0-9a-f]{64}$/.test(entry.sha256)) throw Error('invalid manifest entry');
    result.set(path, entry.sha256);
  }
  return result;
}
function changes(before, after, provenance) {
  if (!before || !after) return null;
  const out = { created: [], modified: [], deleted: [] };
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldHash = before.get(path), newHash = after.get(path);
    if (oldHash === newHash) continue;
    const operation = oldHash === undefined ? 'created' : newHash === undefined ? 'deleted' : 'modified';
    out[operation].push({ path, beforeSha256: oldHash ?? null, afterSha256: newHash ?? null, provenance });
  }
  return out;
}
function patchFiles(evidence) {
  if (evidence === null || evidence === undefined) return null;
  if (evidence.kind === 'derived_candidate_workspace') {
    return changes(manifest(evidence.before), manifest(evidence.after), 'candidate_patch');
  }
  if (evidence.kind === 'git_patch') {
    if (typeof evidence.patch !== 'string') throw Error('patch evidence missing');
    const blocks = evidence.patch.split(/^diff --git a\//m).slice(1);
    if (!blocks.length) return { created: [], modified: [], deleted: [] };
    const out = { created: [], modified: [], deleted: [] };
    for (const block of blocks) {
      const line = block.split('\n', 1)[0];
      const match = line.match(/^(.*?) b\/(.*)$/);
      if (!match || match[1] !== match[2]) throw Error('unsupported patch header');
      const path = pathName(match[1]);
      const operation = /^new file mode /m.test(block) ? 'created' : /^deleted file mode /m.test(block) ? 'deleted' : 'modified';
      out[operation].push({ path, provenance: 'candidate_patch', evidenceKind: evidence.kind });
    }
    return out;
  }
  if (evidence.kind === 'bounded_mutation_claims') {
    if (!Array.isArray(evidence.claims)) throw Error('claims missing');
    const out = { created: [], modified: [], deleted: [] };
    for (const claim of evidence.claims) {
      if (!['created', 'modified', 'deleted'].includes(claim.operation)) throw Error('claim operation missing');
      out[claim.operation].push({ path: pathName(claim.file), provenance: 'candidate_patch', evidenceKind: evidence.kind });
    }
    return out;
  }
  throw Error('unsupported Candidate evidence');
}
function paths(delta) { return delta ? Object.values(delta).flat().map(item => item.path) : []; }
function grade(delta, allowed) { return delta === null ? null : paths(delta).every(path => allowed.has(path)); }
function attribute(input) {
  if (!['normal', 'bounded'].includes(input.system)) throw Error('unknown arm');
  const initial = manifest(input.initialWorkspace), prepared = manifest(input.preAgentWorkspace);
  const afterAgent = manifest(input.postAgentWorkspace);
  const preparedWorkspace = changes(initial, prepared, 'benchmark_preparation');
  const agentWorkspaceMutations = changes(prepared, afterAgent, 'agent_generation');
  const candidatePatch = patchFiles(input.candidateEvidence);
  const allowed = new Set((input.allowedCandidateFiles || []).map(pathName));
  const allowedValidation = new Set((input.allowedValidationFiles || []).map(pathName));
  const validationRuntimeMutations = {};
  let previous = manifest(input.handoffWorkspace);
  for (const phase of PHASES) {
    const next = manifest(input[phase + 'Workspace']);
    validationRuntimeMutations[phase] = changes(previous, next, phase);
    if (next) previous = next;
  }
  const validationDeltas = Object.values(validationRuntimeMutations);
  const validationWorkspaceScopePass = validationDeltas.some(Boolean)
    ? validationDeltas.filter(Boolean).every(delta => grade(delta, allowedValidation)) : null;
  return {
    schemaVersion: VERSION, system: input.system,
    preparedWorkspace, agentWorkspaceMutations, candidatePatch, validationRuntimeMutations,
    candidatePatchScopePass: grade(candidatePatch, allowed),
    agentWorkspaceMutationScopePass: grade(agentWorkspaceMutations, allowed),
    validationWorkspaceScopePass,
    benchmarkV2PrimaryScopePass: candidatePatch === null ? false : grade(candidatePatch, allowed),
    candidateEvidenceState: candidatePatch === null ? 'unknown' : 'observed',
    metadataOnly: true
  };
}
module.exports = { VERSION, PHASES, hash, pathName, manifest, changes, patchFiles, attribute };
