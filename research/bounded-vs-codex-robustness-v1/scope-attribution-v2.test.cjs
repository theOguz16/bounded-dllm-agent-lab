'use strict';
const assert = require('node:assert/strict');
const { attribute, hash } = require('./scope-attribution-v2.cjs');
const entry = (path, value) => ({ path, sha256: hash(value) });
const implementation = 'src/implementation.ts';
const config = '.bounded/config.json';
const allowedPatch = `diff --git a/${implementation} b/${implementation}\nindex 111..222 100644\n--- a/${implementation}\n+++ b/${implementation}\n@@ -1 +1 @@\n-old\n+new\n`;
const forbiddenPatch = `diff --git a/${config} b/${config}\nnew file mode 100644\n--- /dev/null\n+++ b/${config}\n@@ -0,0 +1 @@\n+new\n`;
const base = {
  system: 'normal', allowedCandidateFiles: [implementation], allowedValidationFiles: ['dist/implementation.js'],
  initialWorkspace: [entry(implementation, 'old')],
  preAgentWorkspace: [entry(implementation, 'old')],
  postAgentWorkspace: [entry(implementation, 'new')],
  candidateEvidence: { kind: 'git_patch', patch: allowedPatch },
  handoffWorkspace: [entry(implementation, 'new')],
  validationWorkspace: [entry(implementation, 'new')]
};
const run = change => attribute({ ...base, ...change });
const clean = run({});
assert.equal(clean.candidatePatchScopePass, true); // 1 clean allowed Candidate
assert.equal(clean.agentWorkspaceMutationScopePass, true);
assert.equal(run({ candidateEvidence: { kind: 'git_patch', patch: allowedPatch + forbiddenPatch } }).candidatePatchScopePass, false); // 2
const prepared = [entry(implementation, 'old'), entry(config, 'harness')];
const deleted = run({ preAgentWorkspace: prepared }); // 3
assert.equal(deleted.preparedWorkspace.created[0].path, config);
assert.equal(deleted.agentWorkspaceMutations.deleted[0].path, config);
assert.equal(deleted.agentWorkspaceMutations.deleted[0].provenance, 'agent_generation');
assert.equal(deleted.candidatePatchScopePass, true);
assert.equal(deleted.agentWorkspaceMutationScopePass, false);
assert.equal(deleted.validationWorkspaceScopePass, true);
const modified = run({ preAgentWorkspace: prepared, postAgentWorkspace: [entry(implementation, 'new'), entry(config, 'agent')] }); // 4
assert.equal(modified.agentWorkspaceMutations.modified.find(x => x.path === config).afterSha256, hash('agent'));
assert.equal(modified.agentWorkspaceMutationScopePass, false);
const runtime = run({ runtimeWorkspace: [entry(implementation, 'new'), entry('dist/runtime.js', 'generated')] }); // 5
assert.equal(runtime.validationRuntimeMutations.runtime.created[0].provenance, 'runtime');
assert.equal(runtime.validationWorkspaceScopePass, false);
const validation = run({ validationWorkspace: [entry(implementation, 'new'), entry('dist/implementation.js', 'built')] }); // 6
assert.equal(validation.validationRuntimeMutations.validation.created[0].provenance, 'validation');
assert.equal(validation.validationWorkspaceScopePass, true);
const agentBounded = run({ postAgentWorkspace: [entry(implementation, 'new'), entry(config, 'agent')] }); // 7
assert.equal(agentBounded.agentWorkspaceMutations.created[0].path, config);
assert.equal(agentBounded.agentWorkspaceMutationScopePass, false);
const untouched = run({ preAgentWorkspace: prepared, postAgentWorkspace: [entry(implementation, 'new'), entry(config, 'harness')] }); // 8
assert.equal(untouched.preparedWorkspace.created[0].path, config);
assert.equal(untouched.agentWorkspaceMutationScopePass, true);
const missing = run({ candidateEvidence: null }); // 9
assert.equal(missing.candidatePatchScopePass, null);
assert.equal(missing.benchmarkV2PrimaryScopePass, false);
assert.equal(missing.candidateEvidenceState, 'unknown');
const workspaceDiff = run({ postAgentWorkspace: [entry(implementation, 'new'), entry('other.txt', 'changed')] }); // 10
assert.equal(workspaceDiff.candidatePatchScopePass, true);
assert.equal(workspaceDiff.agentWorkspaceMutationScopePass, false);
const bounded = run({ system: 'bounded', candidateEvidence: { kind: 'derived_candidate_workspace', before: [entry(implementation, 'old')], after: [entry(implementation, 'new')] } }); // 11
assert.equal(bounded.candidatePatchScopePass, clean.candidatePatchScopePass);
assert.equal(bounded.agentWorkspaceMutationScopePass, clean.agentWorkspaceMutationScopePass);
assert.deepEqual(bounded.candidatePatch.modified.map(x => x.path), clean.candidatePatch.modified.map(x => x.path));
const serialized = JSON.stringify(run({ postAgentWorkspace: [entry(implementation, 'new'), entry(config, 'secret-content')] })); // 12
assert.equal(serialized.includes('secret-content'), false);
assert.equal(serialized.includes('old'), false);
assert.equal(serialized.includes('new'), false);
assert.throws(() => run({ postAgentWorkspace: [entry('../escape', 'x')] }), /invalid path/);
console.log('scope attribution v2: 12 deterministic cases PASS');
