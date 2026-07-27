#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MODES = [
  'A_long_context',
  'B_retrieval_context',
  'C_synthetic_context',
  'D_bounded_workspace',
  'E_bounded_workspace_boundary'
];

const TASK = Object.freeze({
  repository: 'lukeed/clsx',
  commitSha: '925494cf31bcd97d3337aacd34e659e80cae7fe2',
  taskId: 'external.clsx.bigint-runtime-patch',
  objective: 'Support bigint class values in the clsx runtime consistently with the existing TypeScript declaration, and add focused regression coverage.',
  candidateFiles: Object.freeze(['src/index.js', 'test/index.js', 'clsx.d.ts', 'package.json', 'readme.md']),
  allowedChangeFiles: Object.freeze(['src/index.js', 'test/index.js']),
  forbiddenFiles: Object.freeze(['clsx.d.ts', 'package.json', 'readme.md']),
  requiredSymbols: Object.freeze(['toVal', 'clsx']),
  requiredTestFiles: Object.freeze(['test/index.js'])
});

const SOURCE_CONDITION = "typeof mix === 'string' || typeof mix === 'number'";
const SOURCE_REPLACEMENT = "typeof mix === 'string' || typeof mix === 'number' || typeof mix === 'bigint'";
const TEST_ANCHOR = "test('objects', () => {";
const TEST_REPLACEMENT = `test('bigints', () => {
\tassert.is(fn(1n), '1');
\tassert.is(fn(0n), '');
\tassert.is(fn(1n, 2n), '1 2');
});

test('objects', () => {`;

function hash(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
}

function canonical(values) {
  return [...new Set(Array.isArray(values) ? values : [])].sort((a, b) => a.localeCompare(b));
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
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`);
  }
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

function numberedExcerpt(content, startLine, endLine) {
  return content.split('\n').slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function keywordSnippets(files, keywords, radius = 4) {
  const snippets = [];
  for (const [file, content] of Object.entries(files)) {
    const lines = content.split('\n');
    const selected = new Set();
    lines.forEach((line, index) => {
      if (keywords.some(keyword => line.toLowerCase().includes(keyword.toLowerCase()))) {
        for (let i = Math.max(0, index - radius); i <= Math.min(lines.length - 1, index + radius); i += 1) selected.add(i);
      }
    });
    if (selected.size > 0) {
      snippets.push({
        file,
        content: [...selected].sort((a, b) => a - b).map(index => `${index + 1}: ${lines[index]}`).join('\n')
      });
    }
  }
  return snippets;
}

async function loadSnapshot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-external-patch-e2e-'));
  const checkout = path.join(root, 'repo');
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${TASK.repository}.git`, checkout]);
  run('git', ['fetch', '--depth', '1', 'origin', TASK.commitSha], {cwd: checkout});
  run('git', ['checkout', '--detach', TASK.commitSha], {cwd: checkout});
  const head = run('git', ['rev-parse', 'HEAD'], {cwd: checkout, capture: true}).stdout.trim();
  assert.equal(head, TASK.commitSha);
  const files = {};
  for (const file of TASK.candidateFiles) files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  return {root, checkout, files};
}

function buildContext(mode, files) {
  const common = {
    evidenceMode: mode,
    repository: TASK.repository,
    commitSha: TASK.commitSha,
    taskId: TASK.taskId,
    objective: TASK.objective,
    candidateFiles: TASK.candidateFiles,
    allowedChangeFiles: TASK.allowedChangeFiles,
    forbiddenFiles: TASK.forbiddenFiles,
    outputContract: {
      summary: 'non-empty string',
      confidence: 'number from 0 to 1',
      files: [{path: 'repository-relative path', description: 'non-empty string', edits: [{find: 'exact existing text', replace: 'replacement text'}]}]
    }
  };
  if (mode === 'A_long_context') {
    return {...common, contextStrategy: 'all_candidate_files_full_text', files: Object.entries(files).map(([file, content]) => ({file, content}))};
  }
  if (mode === 'B_retrieval_context') {
    return {
      ...common,
      contextStrategy: 'keyword_retrieval',
      retrievedSnippets: keywordSnippets(files, ['typeof mix', "test('numbers", "test('objects", 'classvalue', 'bigint', 'toval', 'clsx'])
    };
  }
  if (mode === 'C_synthetic_context') {
    return {
      ...common,
      contextStrategy: 'deterministic_summary_with_edit_anchors',
      summaries: [
        {file: 'src/index.js', summary: 'toVal recursively converts supported primitive, object, and nested-array class values; clsx joins non-empty conversions.'},
        {file: 'test/index.js', summary: 'uvu regression tests cover strings, numbers, objects, arrays, nested arrays, and exports.'},
        {file: 'clsx.d.ts', summary: 'ClassValue already includes bigint, so the declaration does not require a change.'},
        {file: 'package.json', summary: 'Package metadata and scripts; outside the requested change boundary.'},
        {file: 'readme.md', summary: 'Documentation; outside the requested change boundary.'}
      ],
      editableAnchors: [
        {file: 'src/index.js', exactText: SOURCE_CONDITION},
        {file: 'test/index.js', exactText: TEST_ANCHOR}
      ]
    };
  }
  if (mode === 'D_bounded_workspace') {
    return {...common, contextStrategy: 'bounded_workspace_selected_files', workspaceFiles: TASK.allowedChangeFiles.map(file => ({file, content: files[file]}))};
  }
  return {
    ...common,
    contextStrategy: 'bounded_workspace_with_boundary',
    allowedInspectionFiles: TASK.allowedChangeFiles,
    forbiddenInspectionFiles: TASK.forbiddenFiles,
    boundaryReason: 'The runtime implementation and focused executable regression test are the complete minimal change boundary. Type declarations already contain bigint.',
    workspaceExcerpts: [
      {file: 'src/index.js', content: numberedExcerpt(files['src/index.js'], 1, 45)},
      {file: 'test/index.js', content: numberedExcerpt(files['test/index.js'], 19, 56)},
      {file: 'clsx.d.ts', content: numberedExcerpt(files['clsx.d.ts'], 1, 12)}
    ]
  };
}

function buildInitialEvidence(mode, files) {
  const payload = buildContext(mode, files);
  const items = [];
  const push = (file, content, source) => items.push({
    path: file,
    source,
    content,
    contentHash: hash(content),
    byteLength: Buffer.byteLength(content),
    estimatedTokens: Math.ceil(content.length / 4),
    matchedSymbols: file === 'src/index.js' ? ['toVal', 'clsx'] : []
  });
  if (payload.files) for (const item of payload.files) push(item.file, item.content, 'long_context');
  else if (payload.retrievedSnippets) for (const item of payload.retrievedSnippets) push(item.file, item.content, 'retrieval_context');
  else if (payload.summaries) for (const item of payload.summaries) push(item.file, item.summary, 'synthetic_context');
  else if (payload.workspaceFiles) for (const item of payload.workspaceFiles) push(item.file, item.content, 'bounded_workspace');
  else for (const item of payload.workspaceExcerpts) push(item.file, item.content, 'bounded_boundary');
  for (const required of TASK.allowedChangeFiles) {
    if (!items.some(item => item.path === required)) push(required, `Required editable file: ${required}`, 'required_boundary');
  }
  return items;
}

function correctFixtureModelOutput() {
  return {
    summary: 'Support bigint runtime values and add focused regression coverage.',
    confidence: 0.98,
    files: [
      {path: 'src/index.js', description: 'Treat bigint values like strings and numbers in toVal.', edits: [{find: SOURCE_CONDITION, replace: SOURCE_REPLACEMENT}]},
      {path: 'test/index.js', description: 'Add regression tests for bigint values.', edits: [{find: TEST_ANCHOR, replace: TEST_REPLACEMENT}]}
    ]
  };
}

function fixtureInitialOutput(mode) {
  if (mode === 'A_long_context') {
    const output = correctFixtureModelOutput();
    return {...output, files: output.files.filter(file => file.path === 'src/index.js')};
  }
  if (mode === 'B_retrieval_context') {
    return {
      summary: 'Unsafe fixture draft to exercise deterministic verifier remask.',
      confidence: 0.98,
      files: [{path: 'package.json', description: 'Incorrect out-of-scope change.', edits: [{find: '"version": "2.1.1"', replace: '"version": "2.1.2"'}]}]
    };
  }
  return correctFixtureModelOutput();
}

function outputToMutation(output, role = 'coder', target = 'patchDraft') {
  const files = Array.isArray(output?.files) ? output.files : [];
  const claims = files.filter(file => file && typeof file.path === 'string').map(file => ({
    type: 'patch_draft',
    file: file.path,
    description: typeof file.description === 'string' && file.description.trim().length > 0 ? file.description : `Edit ${file.path}.`,
    proposedPatch: JSON.stringify({format: 'exact_replacements/v1', edits: Array.isArray(file.edits) ? file.edits : []})
  }));
  return {
    role,
    target,
    summary: typeof output?.summary === 'string' && output.summary.trim().length > 0 ? output.summary : 'Model generated an external repository patch draft.',
    claims,
    touchedFiles: claims.map(claim => claim.file),
    confidence: typeof output?.confidence === 'number' ? output.confidence : 0.8
  };
}

function parseJsonContent(content) {
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

async function invokeLive(payload, repair = false) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(process.env.GATE5_API_KEY ? {authorization: `Bearer ${process.env.GATE5_API_KEY}`} : {})},
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number.parseInt(process.env.GATE5_MAX_COMPLETION_TOKENS ?? '768', 10),
      messages: [
        {
          role: 'system',
          content: repair
            ? 'Repair the previous patch using only the remasked allowed files and failure evidence. Return strict JSON matching the requested output contract. Use exact find/replace edits, touch no other files, and add no explanation.'
            : 'Generate the smallest correct patch using only supplied repository evidence. Return strict JSON matching the requested output contract. Use exact find/replace edits, touch no forbidden files, and add no explanation.'
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
    output: parseJsonContent(content),
    rawContent: content,
    usage: {promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, totalTokens: usage.total_tokens ?? 0},
    latencyMs: Date.now() - started
  };
}

function providerFailureMutation(message) {
  return {role: 'coder', target: 'patchDraft', summary: `Provider failed before producing a valid patch: ${message}`, claims: [], touchedFiles: [], confidence: 0};
}

function exactReplacementApply(content, edit) {
  if (!edit || typeof edit.find !== 'string' || edit.find.length === 0 || typeof edit.replace !== 'string') throw new Error('invalid_exact_replacement_edit');
  const first = content.indexOf(edit.find);
  if (first < 0) throw new Error('replacement_anchor_not_found');
  if (content.indexOf(edit.find, first + edit.find.length) >= 0) throw new Error('replacement_anchor_not_unique');
  return content.slice(0, first) + edit.replace + content.slice(first + edit.find.length);
}

async function resetCheckout(checkout) {
  run('git', ['reset', '--hard', TASK.commitSha], {cwd: checkout, capture: true});
  run('git', ['clean', '-fd'], {cwd: checkout, capture: true});
}

function makeApplyExecutor(checkout, diagnosticsRef, runtime) {
  return async ({mutation, plannerExecutionBindingHash, verifierFindingHash}) => {
    const diagnostics = {changedFiles: [], changedFilesExact: false, testsPassed: false, semanticOraclePassed: false, error: null};
    diagnosticsRef.current = diagnostics;
    try {
      for (const claim of mutation.claims) {
        if (!claim || claim.type !== 'patch_draft' || typeof claim.file !== 'string' || typeof claim.proposedPatch !== 'string') throw new Error('invalid_patch_claim');
        const parsed = JSON.parse(claim.proposedPatch);
        if (parsed.format !== 'exact_replacements/v1' || !Array.isArray(parsed.edits) || parsed.edits.length === 0) throw new Error('unsupported_patch_format');
        const target = path.join(checkout, claim.file);
        let content = await fs.readFile(target, 'utf8');
        for (const edit of parsed.edits) content = exactReplacementApply(content, edit);
        await fs.writeFile(target, content, 'utf8');
      }
      diagnostics.changedFiles = canonical(run('git', ['diff', '--name-only'], {cwd: checkout, capture: true}).stdout.split('\n').map(value => value.trim()).filter(Boolean));
      diagnostics.changedFilesExact = exact(diagnostics.changedFiles, TASK.allowedChangeFiles);
      if (!diagnostics.changedFilesExact) throw new Error('changed_files_do_not_match_required_scope');

      const sourceContent = await fs.readFile(path.join(checkout, 'src/index.js'), 'utf8');
      const testContent = await fs.readFile(path.join(checkout, 'test/index.js'), 'utf8');
      const syntaxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-clsx-syntax-'));
      try {
        await fs.writeFile(path.join(syntaxRoot, 'source.mjs'), sourceContent, 'utf8');
        await fs.writeFile(path.join(syntaxRoot, 'test.mjs'), testContent, 'utf8');
        const syntaxSource = run('node', ['--check', path.join(syntaxRoot, 'source.mjs')], {capture: true, allowFailure: true});
        if (syntaxSource.status !== 0) throw new Error(`source_syntax_failed:${syntaxSource.stderr.trim()}`);
        const syntaxTest = run('node', ['--check', path.join(syntaxRoot, 'test.mjs')], {capture: true, allowFailure: true});
        if (syntaxTest.status !== 0) throw new Error(`test_syntax_failed:${syntaxTest.stderr.trim()}`);
      } finally {
        await fs.rm(syntaxRoot, {recursive: true, force: true});
      }

      const semanticScript = [
        "const fs = await import('node:fs/promises');",
        "const source = await fs.readFile('./src/index.js', 'utf8');",
        "const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));",
        "const actual=[mod.clsx(1n),mod.clsx(0n),mod.clsx(1n,2n),mod.clsx(['x',2n])];",
        "const expected=['1','','1 2','x 2'];",
        "if(JSON.stringify(actual)!==JSON.stringify(expected)){throw new Error(JSON.stringify({actual,expected}));}"
      ].join(' ');
      const semantic = run('node', ['--input-type=module', '-e', semanticScript], {cwd: checkout, capture: true, allowFailure: true});
      if (semantic.status !== 0) throw new Error(`semantic_acceptance_failed:${semantic.stderr.trim()}`);
      diagnostics.semanticOraclePassed = testContent.includes('1n') && testContent.includes('2n');
      if (!diagnostics.semanticOraclePassed) throw new Error('regression_test_evidence_missing');
      diagnostics.testsPassed = true;
      const receiptHash = runtime.hashCanonicalJson({
        taskId: TASK.taskId,
        commitSha: TASK.commitSha,
        changedFiles: diagnostics.changedFiles,
        testsPassed: diagnostics.testsPassed,
        semanticOraclePassed: diagnostics.semanticOraclePassed,
        plannerExecutionBindingHash,
        verifierFindingHash,
        diffHash: hash(run('git', ['diff', '--binary'], {cwd: checkout, capture: true}).stdout)
      });
      return {decision: 'apply_completed', route: 'contract_approved', receiptHash};
    } catch (error) {
      diagnostics.error = error instanceof Error ? error.message : String(error);
      return {decision: 'apply_blocked', route: 'replan_required', receiptHash: null};
    }
  };
}

function buildRuntimeInput(runtime, checkout, files, mode, mutation, diagnosticsRef) {
  const objectiveHash = runtime.hashCanonicalJson({task: TASK.objective});
  const authorityHash = runtime.hashCanonicalJson({authority: 'gate5_external_patch_e2e'});
  const policyHash = runtime.hashCanonicalJson({policy: 'gate5_external_patch_e2e'});
  const acceptanceCriteriaContract = runtime.createAcceptanceCriteriaContract({
    taskId: TASK.taskId,
    objectiveHash,
    criteria: [
      {id: 'bigint_runtime_behavior', description: 'Bigint class values are handled consistently with the existing declaration.', required: true, evidence: {kind: 'test', commandId: 'node.semantic.bigint'}},
      {id: 'focused_regression_coverage', description: 'Focused regression coverage is added without changing files outside the explicit boundary.', required: true, evidence: {kind: 'test', commandId: 'node.syntax.and.test.evidence'}}
    ]
  });
  const minimalityPolicy = runtime.createPreventiveMinimalityPolicy({
    policyVersion: '1', policyId: 'gate5.external.patch.e2e', preferExistingCode: true, preferStandardLibrary: true,
    preferNativePlatform: true, preferInstalledDependencies: true, newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true, newAbstractionRequiresJustification: true, newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: 'human_review', unrequestedAbstractionBehavior: 'human_review',
    unrequestedRefactorBehavior: 'replan', highRiskBehavior: 'disabled', maxPlannedFiles: 2,
    maxNewDependencies: 0, maxNewAbstractions: 0
  });
  const proposalCore = {
    proposalVersion: '1', taskId: TASK.taskId, objectiveHash, acceptanceContractHash: acceptanceCriteriaContract.contractHash,
    authorityHash, policyHash, seedFiles: ['src/index.js'],
    seedRationales: [{path: 'src/index.js', reasonHash: runtime.hashCanonicalJson({reason: 'Existing runtime implementation boundary.'})}],
    requiredSymbols: TASK.requiredSymbols, requiredTestFiles: TASK.requiredTestFiles, maxExpansionAttempts: 1
  };
  const proposal = {...proposalCore, proposalHash: runtime.hashCanonicalJson(proposalCore)};
  return {
    repositoryPath: checkout,
    taskId: TASK.taskId,
    objectiveHash,
    acceptanceCriteriaContract,
    authorityHash,
    policyHash,
    proposalLimits: {maxSeedFiles: 1, maxRequiredSymbols: 2, maxRequiredTests: 1, maxExpansionAttempts: 1},
    minimalityPolicy,
    allowedChangeFiles: TASK.allowedChangeFiles,
    forbiddenFiles: TASK.forbiddenFiles,
    taskContext: {task: TASK.objective, mode},
    initialEvidence: buildInitialEvidence(mode, files),
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: 20000,
    plannerMinimalityProvider: async () => ({
      proposal,
      minimalityPlan: {
        planVersion: '1', riskClass: 'low', taskExplicitlyRequestsRefactor: false,
        plannedFiles: [
          {path: 'src/index.js', changeKind: 'bugfix', requested: true, justification: null},
          {path: 'test/index.js', changeKind: 'test', requested: true, justification: null}
        ],
        newDependencies: [], newAbstractions: []
      }
    }),
    contextRequestProvider: async () => ({requestedFiles: [], requiredSymbols: [], reason: 'unused'}),
    coderProvider: async () => mutation,
    applyExecutor: makeApplyExecutor(checkout, diagnosticsRef, runtime)
  };
}

async function runAttempt(runtime, snapshot, mode, mutation) {
  await resetCheckout(snapshot.checkout);
  const diagnosticsRef = {current: null};
  const result = await runtime.runBoundedTask(buildRuntimeInput(runtime, snapshot.checkout, snapshot.files, mode, mutation, diagnosticsRef));
  return {result, diagnostics: diagnosticsRef.current};
}

function repairPayload(mode, files, initialOutput, firstAttempt) {
  return {
    repairClass: 'verifier_or_apply_guided_remask',
    task: {repository: TASK.repository, commitSha: TASK.commitSha, taskId: TASK.taskId, objective: TASK.objective},
    failure: {
      runtimeDecision: firstAttempt.result.decision,
      runtimeRoute: firstAttempt.result.route,
      stage: firstAttempt.result.failure?.stage ?? null,
      code: firstAttempt.result.failure?.code ?? null,
      message: firstAttempt.result.failure?.message ?? null,
      verifierDecision: firstAttempt.result.verifierResult?.decision ?? null,
      verifierIssues: firstAttempt.result.verifierResult?.issues ?? [],
      applyDiagnostics: firstAttempt.diagnostics
    },
    previousOutput: initialOutput,
    remaskedBoundary: buildContext('E_bounded_workspace_boundary', files),
    originalEvidenceMode: mode
  };
}

async function providerOutputForMode(live, mode, files, repair, repairInput) {
  if (!live) {
    return {
      output: repair ? correctFixtureModelOutput() : fixtureInitialOutput(mode),
      rawContent: null,
      usage: {promptTokens: repair ? 500 : 400, completionTokens: 120, totalTokens: repair ? 620 : 520},
      latencyMs: repair ? 130 : 100
    };
  }
  return invokeLive(repair ? repairInput : buildContext(mode, files), repair);
}

async function main() {
  const live = process.argv.includes('--live');
  if (live && (!process.env.GATE5_OPENAI_ENDPOINT || !process.env.GATE5_MODEL)) throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  const snapshot = await loadSnapshot();
  const runtime = await import('../dist/packages/product-runtime/src/canonical-runtime.js');
  const results = [];
  try {
    for (const mode of MODES) {
      const providerPayload = buildContext(mode, snapshot.files);
      const providerPayloadText = JSON.stringify(providerPayload);
      assert.equal(providerPayloadText.includes(SOURCE_REPLACEMENT), false);
      assert.equal(providerPayloadText.includes(TEST_REPLACEMENT), false);

      let initialProvider;
      let initialProviderError = null;
      try {
        initialProvider = await providerOutputForMode(live, mode, snapshot.files, false, null);
      } catch (error) {
        initialProviderError = error instanceof Error ? error.message : String(error);
        initialProvider = {output: null, rawContent: null, usage: {promptTokens: 0, completionTokens: 0, totalTokens: 0}, latencyMs: 0};
      }
      const initialMutation = initialProvider.output ? outputToMutation(initialProvider.output) : providerFailureMutation(initialProviderError ?? 'unknown_provider_failure');
      const firstAttempt = await runAttempt(runtime, snapshot, mode, initialMutation);
      const firstPassed = firstAttempt.result.decision === 'bounded_task_completed'
        && firstAttempt.result.route === 'contract_approved'
        && firstAttempt.result.receipt?.outcome === 'applied_and_validated'
        && runtime.verifyBoundedTaskReceipt(firstAttempt.result.receipt)
        && firstAttempt.diagnostics?.testsPassed === true;

      let repairProvider = null;
      let repairProviderError = null;
      let finalAttempt = firstAttempt;
      let remaskTriggered = false;
      let remaskReason = null;
      if (!firstPassed) {
        remaskTriggered = true;
        remaskReason = firstAttempt.result.verifierResult?.decision !== 'approve'
          ? 'verification'
          : firstAttempt.result.summary.applyCalled ? 'apply' : firstAttempt.result.failure?.stage ?? 'runtime';
        const payload = repairPayload(mode, snapshot.files, initialProvider.output, firstAttempt);
        try {
          repairProvider = await providerOutputForMode(live, mode, snapshot.files, true, payload);
        } catch (error) {
          repairProviderError = error instanceof Error ? error.message : String(error);
          repairProvider = {output: null, rawContent: null, usage: {promptTokens: 0, completionTokens: 0, totalTokens: 0}, latencyMs: 0};
        }
        const repairMutation = repairProvider.output ? outputToMutation(repairProvider.output) : providerFailureMutation(repairProviderError ?? 'unknown_repair_provider_failure');
        finalAttempt = await runAttempt(runtime, snapshot, mode, repairMutation);
      }

      const finalPassed = finalAttempt.result.decision === 'bounded_task_completed'
        && finalAttempt.result.route === 'contract_approved'
        && finalAttempt.result.receipt?.outcome === 'applied_and_validated'
        && runtime.verifyBoundedTaskReceipt(finalAttempt.result.receipt)
        && finalAttempt.diagnostics?.testsPassed === true
        && finalAttempt.diagnostics?.changedFilesExact === true;
      const finalTouched = canonical(finalAttempt.result.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerOutput?.touchedFiles ?? []);
      const scopeDriftFiles = finalTouched.filter(file => !TASK.allowedChangeFiles.includes(file));
      const totalTokens = initialProvider.usage.totalTokens + (repairProvider?.usage.totalTokens ?? 0);
      const totalLatencyMs = initialProvider.latencyMs + (repairProvider?.latencyMs ?? 0);
      const repairContextBytes = remaskTriggered ? Buffer.byteLength(JSON.stringify(buildContext('E_bounded_workspace_boundary', snapshot.files))) : 0;

      results.push(Object.freeze({
        mode,
        contextStrategy: providerPayload.contextStrategy,
        repositoryId: `${TASK.repository}@${TASK.commitSha}`,
        taskId: TASK.taskId,
        model: live ? process.env.GATE5_MODEL : 'fixture-model',
        provider: live ? new URL(process.env.GATE5_OPENAI_ENDPOINT).origin : 'fixture-provider',
        providerVisibleOracleLeakage: false,
        firstDecision: firstAttempt.result.decision,
        firstRoute: firstAttempt.result.route,
        firstVerifierDecision: firstAttempt.result.verifierResult?.decision ?? null,
        firstApplyCalled: firstAttempt.result.summary.applyCalled,
        firstApplyDiagnostics: firstAttempt.diagnostics,
        initialProviderError,
        remaskTriggered,
        remaskReason,
        repairProviderError,
        finalDecision: finalAttempt.result.decision,
        finalRoute: finalAttempt.result.route,
        finalVerifierDecision: finalAttempt.result.verifierResult?.decision ?? null,
        finalApplyDiagnostics: finalAttempt.diagnostics,
        finalTouchedFiles: finalTouched,
        scopeDriftFiles,
        taskSucceeded: finalPassed,
        runtimeReceiptHash: finalAttempt.result.receipt?.receiptHash ?? null,
        totalTokens,
        totalLatencyMs,
        providerContextBytes: Buffer.byteLength(providerPayloadText),
        repairContextBytes
      }));
    }

    assert.equal(results.length, MODES.length);
    assert.equal(results.some(result => result.providerVisibleOracleLeakage), false);
    if (!live) {
      assert.equal(results.every(result => result.taskSucceeded), true, JSON.stringify(results, null, 2));
      assert.equal(results.some(result => result.remaskReason === 'verification'), true);
      assert.equal(results.some(result => result.remaskReason === 'apply'), true);
    }

    const reportCore = {
      version: 'gate5-external-patch-e2e/v1',
      executionClass: live ? 'live_external_patch_e2e' : 'fixture_external_patch_e2e',
      evidenceClass: live ? 'external_patch_e2e_candidate' : 'deterministic_fixture',
      comparable: true,
      target: {
        repository: TASK.repository,
        commitSha: TASK.commitSha,
        taskId: TASK.taskId,
        objective: TASK.objective,
        allowedChangeFiles: TASK.allowedChangeFiles,
        forbiddenFiles: TASK.forbiddenFiles
      },
      results,
      aggregates: {
        modeCount: results.length,
        successfulModes: results.filter(result => result.taskSucceeded).length,
        remaskCount: results.filter(result => result.remaskTriggered).length,
        verifierRemaskCount: results.filter(result => result.remaskReason === 'verification').length,
        applyRemaskCount: results.filter(result => result.remaskReason === 'apply').length,
        totalTokens: results.reduce((sum, result) => sum + result.totalTokens, 0),
        totalScopeDriftFiles: results.reduce((sum, result) => sum + result.scopeDriftFiles.length, 0)
      }
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
      decision: live ? 'gate5_external_patch_e2e_completed' : 'gate5_external_patch_e2e_contract_ready',
      executionClass: report.executionClass,
      modeCount: report.results.length,
      successfulModes: report.aggregates.successfulModes,
      remaskCount: report.aggregates.remaskCount,
      verifierRemaskCount: report.aggregates.verifierRemaskCount,
      applyRemaskCount: report.aggregates.applyRemaskCount,
      providerVisibleOracleLeakage: false,
      totalScopeDriftFiles: report.aggregates.totalScopeDriftFiles,
      reportHash: report.reportHash
    }, null, 2));
  } finally {
    await resetCheckout(snapshot.checkout).catch(() => {});
    await fs.rm(snapshot.root, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
