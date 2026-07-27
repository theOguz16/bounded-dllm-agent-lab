#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

async function main() {
  const sourcePath = path.resolve(__dirname, 'gate5-external-patch-e2e.cjs');
  const runtimeModuleUrl = pathToFileURL(
    path.resolve(__dirname, '../dist/packages/product-runtime/src/canonical-runtime.js')
  ).href;
  let source = await fs.readFile(sourcePath, 'utf8');

  const replacements = [
    [
      "requiredSymbols: Object.freeze(['toVal', 'clsx'])",
      "requiredSymbols: Object.freeze(['clsx', 'toVal'])"
    ],
    [
      "const runtime = await import('../dist/packages/product-runtime/src/canonical-runtime.js');",
      `const runtime = await import(${JSON.stringify(runtimeModuleUrl)});`
    ],
    [
`function buildInitialEvidence(mode, files) {
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
    if (!items.some(item => item.path === required)) push(required, \`Required editable file: \${required}\`, 'required_boundary');
  }
  return items;
}`,
`function buildInitialEvidence(_mode, files) {
  return TASK.allowedChangeFiles.map(file => {
    const content = files[file];
    return {
      path: file,
      source: 'exact_allowed_repository_snapshot',
      content,
      contentHash: hash(content),
      byteLength: Buffer.byteLength(content),
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: file === 'src/index.js' ? canonical(TASK.requiredSymbols) : []
    };
  });
}`
    ],
    [
`      diagnostics.changedFiles = canonical(run('git', ['diff', '--name-only'], {cwd: checkout, capture: true}).stdout.split('\n').map(value => value.trim()).filter(Boolean));
      diagnostics.changedFilesExact = exact(diagnostics.changedFiles, TASK.allowedChangeFiles);
      if (!diagnostics.changedFilesExact) throw new Error('changed_files_do_not_match_required_scope');

      const sourceContent = await fs.readFile(path.join(checkout, 'src/index.js'), 'utf8');
      const testContent = await fs.readFile(path.join(checkout, 'test/index.js'), 'utf8');
      const syntaxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-clsx-syntax-'));
      try {
        await fs.writeFile(path.join(syntaxRoot, 'source.mjs'), sourceContent, 'utf8');
        await fs.writeFile(path.join(syntaxRoot, 'test.mjs'), testContent, 'utf8');
        const syntaxSource = run('node', ['--check', path.join(syntaxRoot, 'source.mjs')], {capture: true, allowFailure: true});
        if (syntaxSource.status !== 0) throw new Error(\`source_syntax_failed:\${syntaxSource.stderr.trim()}\`);
        const syntaxTest = run('node', ['--check', path.join(syntaxRoot, 'test.mjs')], {capture: true, allowFailure: true});
        if (syntaxTest.status !== 0) throw new Error(\`test_syntax_failed:\${syntaxTest.stderr.trim()}\`);
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
      if (semantic.status !== 0) throw new Error(\`semantic_acceptance_failed:\${semantic.stderr.trim()}\`);
      diagnostics.semanticOraclePassed = testContent.includes('1n') && testContent.includes('2n');
      if (!diagnostics.semanticOraclePassed) throw new Error('regression_test_evidence_missing');
      diagnostics.testsPassed = true;`,
`      diagnostics.changedFiles = canonical(run('git', ['diff', '--name-only'], {cwd: checkout, capture: true}).stdout.split('\n').map(value => value.trim()).filter(Boolean));
      diagnostics.changedFilesExact = exact(diagnostics.changedFiles, TASK.allowedChangeFiles);

      const sourceContent = await fs.readFile(path.join(checkout, 'src/index.js'), 'utf8');
      const testContent = await fs.readFile(path.join(checkout, 'test/index.js'), 'utf8');
      const syntaxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-clsx-syntax-'));
      try {
        await fs.writeFile(path.join(syntaxRoot, 'source.mjs'), sourceContent, 'utf8');
        await fs.writeFile(path.join(syntaxRoot, 'test.mjs'), testContent, 'utf8');
        const syntaxSource = run('node', ['--check', path.join(syntaxRoot, 'source.mjs')], {capture: true, allowFailure: true});
        if (syntaxSource.status !== 0) throw new Error(\`source_syntax_failed:\${syntaxSource.stderr.trim()}\`);
        diagnostics.sourceSyntaxPassed = true;

        const semanticScript = [
          "const fs = await import('node:fs/promises');",
          "const source = await fs.readFile('./src/index.js', 'utf8');",
          "const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));",
          "const actual=[mod.clsx(1n),mod.clsx(0n),mod.clsx(1n,2n),mod.clsx(['x',2n])];",
          "const expected=['1','','1 2','x 2'];",
          "if(JSON.stringify(actual)!==JSON.stringify(expected)){throw new Error(JSON.stringify({actual,expected}));}"
        ].join(' ');
        const semantic = run('node', ['--input-type=module', '-e', semanticScript], {cwd: checkout, capture: true, allowFailure: true});
        if (semantic.status !== 0) throw new Error(\`semantic_acceptance_failed:\${semantic.stderr.trim()}\`);
        diagnostics.sourceBehaviorPassed = true;

        const syntaxTest = run('node', ['--check', path.join(syntaxRoot, 'test.mjs')], {capture: true, allowFailure: true});
        if (syntaxTest.status !== 0) throw new Error(\`test_syntax_failed:\${syntaxTest.stderr.trim()}\`);
        diagnostics.testSyntaxPassed = true;
      } finally {
        await fs.rm(syntaxRoot, {recursive: true, force: true});
      }

      const testDiff = run('git', ['diff', '--', 'test/index.js'], {cwd: checkout, capture: true}).stdout;
      const hasBigintExpression = /(?:\\b(?:0[xob][0-9a-f]+|\\d+)n\\b|BigInt\\s*\\()/i.test(testDiff);
      const hasClassInvocation = /\\b(?:fn|clsx)\\s*\\(/.test(testDiff);
      diagnostics.regressionEvidencePassed = diagnostics.changedFiles.includes('test/index.js') && hasBigintExpression && hasClassInvocation;
      diagnostics.semanticOraclePassed = diagnostics.sourceBehaviorPassed === true && diagnostics.regressionEvidencePassed === true;

      if (!diagnostics.changedFilesExact) throw new Error('changed_files_do_not_match_required_scope');
      if (!diagnostics.regressionEvidencePassed) throw new Error('regression_test_evidence_missing');
      diagnostics.testsPassed = true;`
    ],
    [
`function repairPayload(mode, files, initialOutput, firstAttempt) {
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
}`,
`function repairPayload(mode, files, initialOutput, firstAttempt) {
  const diagnostics = firstAttempt.diagnostics ?? {};
  const changedFiles = canonical(diagnostics.changedFiles ?? []);
  const preserveFiles = [];
  if (diagnostics.sourceSyntaxPassed === true && diagnostics.sourceBehaviorPassed === true) preserveFiles.push('src/index.js');
  if (diagnostics.testSyntaxPassed === true && diagnostics.regressionEvidencePassed === true) preserveFiles.push('test/index.js');
  const repairFiles = TASK.allowedChangeFiles.filter(file => !preserveFiles.includes(file));
  const exactAnchorCatalog = [
    {file: 'src/index.js', find: SOURCE_CONDITION, purpose: 'Extend primitive handling to bigint.'},
    {file: 'test/index.js', find: TEST_ANCHOR, purpose: 'Insert a complete syntactically valid bigint regression test immediately before the objects test.'}
  ].filter(entry => repairFiles.includes(entry.file));
  return {
    repairClass: 'failure_directed_masked_repair/v2',
    task: {repository: TASK.repository, commitSha: TASK.commitSha, taskId: TASK.taskId, objective: TASK.objective},
    failure: {
      runtimeDecision: firstAttempt.result.decision,
      runtimeRoute: firstAttempt.result.route,
      stage: firstAttempt.result.failure?.stage ?? null,
      code: firstAttempt.result.failure?.code ?? null,
      message: firstAttempt.result.failure?.message ?? null,
      verifierDecision: firstAttempt.result.verifierResult?.decision ?? null,
      verifierIssues: firstAttempt.result.verifierResult?.issues ?? [],
      applyDiagnostics: diagnostics,
      applyError: diagnostics.error ?? null
    },
    repairInstructions: {
      requiredChangedFiles: TASK.allowedChangeFiles,
      changedFiles,
      preserveFiles,
      repairFiles,
      returnOnlyRepairFiles: true,
      neverRewritePreserveFiles: true,
      useOnlyExactAnchorsFromCatalog: true,
      exactFindMustMatchCatalog: true,
      sourceRequirement: 'When repairing src/index.js, keep the exact existing string/number condition and extend it to accept bigint without changing unrelated logic.',
      testRequirement: 'When repairing test/index.js, replace the exact objects-test anchor with one complete named bigint test followed by the unchanged objects-test anchor. The resulting entire file must parse as JavaScript.'
    },
    exactAnchorCatalog,
    previousOutput: initialOutput,
    remaskedBoundary: buildContext('E_bounded_workspace_boundary', files),
    originalEvidenceMode: mode
  };
}`
    ],
    [
      "? 'Repair the previous patch using only the remasked allowed files and failure evidence. Return strict JSON matching the requested output contract. Use exact find/replace edits, touch no other files, and add no explanation.'",
      "? 'Repair only files listed in repairInstructions.repairFiles. Never return files listed in preserveFiles. Each edit.find must exactly equal the matching exactAnchorCatalog find value. Return complete syntactically valid JavaScript replacements and strict JSON only, with no explanation.'"
    ],
    [
      'async function providerOutputForMode(live, mode, files, repair, repairInput) {',
`function mergePatchOutputs(initialOutput, repairOutput, diagnostics) {
  const initialFiles = new Map((Array.isArray(initialOutput?.files) ? initialOutput.files : [])
    .filter(file => file && TASK.allowedChangeFiles.includes(file.path))
    .map(file => [file.path, file]));
  const repairFiles = new Map((Array.isArray(repairOutput?.files) ? repairOutput.files : [])
    .filter(file => file && TASK.allowedChangeFiles.includes(file.path))
    .map(file => [file.path, file]));
  const preserveFiles = new Set();
  if (diagnostics?.sourceSyntaxPassed === true && diagnostics?.sourceBehaviorPassed === true) preserveFiles.add('src/index.js');
  if (diagnostics?.testSyntaxPassed === true && diagnostics?.regressionEvidencePassed === true) preserveFiles.add('test/index.js');

  const files = [];
  for (const file of TASK.allowedChangeFiles) {
    if (preserveFiles.has(file) && initialFiles.has(file)) files.push(initialFiles.get(file));
    else if (repairFiles.has(file)) files.push(repairFiles.get(file));
    else if (initialFiles.has(file)) files.push(initialFiles.get(file));
  }
  return {
    summary: repairOutput?.summary ?? initialOutput?.summary ?? 'Merged failure-directed repair patch.',
    confidence: typeof repairOutput?.confidence === 'number' ? repairOutput.confidence : (initialOutput?.confidence ?? 0.8),
    files
  };
}

async function providerOutputForMode(live, mode, files, repair, repairInput) {`
    ],
    [
      '      let repairProviderError = null;\n',
      '      let repairProviderError = null;\n      let mergedRepairOutput = null;\n'
    ],
    [
      "        const repairMutation = repairProvider.output ? outputToMutation(repairProvider.output) : providerFailureMutation(repairProviderError ?? 'unknown_repair_provider_failure');",
      "        mergedRepairOutput = repairProvider.output ? mergePatchOutputs(initialProvider.output, repairProvider.output, firstAttempt.diagnostics) : null;\n        const repairMutation = mergedRepairOutput ? outputToMutation(mergedRepairOutput) : providerFailureMutation(repairProviderError ?? 'unknown_repair_provider_failure');"
    ],
    [
      '        initialProviderError,\n',
      '        initialProviderError,\n        initialProviderOutput: initialProvider.output,\n'
    ],
    [
      '        repairProviderError,\n',
      '        repairProviderError,\n        repairProviderOutput: repairProvider?.output ?? null,\n        mergedRepairOutput,\n'
    ],
    [
      '        firstApplyDiagnostics: firstAttempt.diagnostics,\n',
      '        firstApplyDiagnostics: firstAttempt.diagnostics,\n        firstFailureStage: firstAttempt.result.failure?.stage ?? null,\n        firstFailureCode: firstAttempt.result.failure?.code ?? null,\n        firstFailureMessage: firstAttempt.result.failure?.message ?? null,\n        firstPlannerIssues: firstAttempt.result.plannerResult?.issues ?? [],\n'
    ],
    [
      '        finalApplyDiagnostics: finalAttempt.diagnostics,\n',
      '        finalApplyDiagnostics: finalAttempt.diagnostics,\n        finalFailureStage: finalAttempt.result.failure?.stage ?? null,\n        finalFailureCode: finalAttempt.result.failure?.code ?? null,\n        finalFailureMessage: finalAttempt.result.failure?.message ?? null,\n        finalPlannerIssues: finalAttempt.result.plannerResult?.issues ?? [],\n'
    ],
    [
      "version: 'gate5-external-patch-e2e/v1'",
      "version: 'gate5-external-patch-e2e/v4'"
    ]
  ];

  for (const [before, after] of replacements) {
    assert.equal(source.includes(before), true, `expected_v1_fragment_missing:${before.slice(0, 80)}`);
    source = source.replace(before, after);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-external-patch-e2e-v4-'));
  const generatedPath = path.join(root, 'gate5-external-patch-e2e-v4.generated.cjs');
  try {
    await fs.writeFile(generatedPath, source, 'utf8');
    const result = spawnSync(process.execPath, [generatedPath, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
