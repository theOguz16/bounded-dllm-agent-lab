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
      "diagnostics.semanticOraclePassed = testContent.includes('1n') && testContent.includes('2n');",
      "diagnostics.semanticOraclePassed = /test\\s*\\(\\s*['\"](?:bigint|bigints|supports bigint)/i.test(testContent) && /(?:\\b\\d+n\\b|BigInt\\s*\\()/i.test(testContent);"
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
  const changedFiles = canonical(firstAttempt.diagnostics?.changedFiles ?? []);
  const missingRequiredFiles = TASK.allowedChangeFiles.filter(file => !changedFiles.includes(file));
  const failureError = firstAttempt.diagnostics?.error ?? null;
  return {
    repairClass: 'failure_directed_masked_repair/v1',
    task: {repository: TASK.repository, commitSha: TASK.commitSha, taskId: TASK.taskId, objective: TASK.objective},
    failure: {
      runtimeDecision: firstAttempt.result.decision,
      runtimeRoute: firstAttempt.result.route,
      stage: firstAttempt.result.failure?.stage ?? null,
      code: firstAttempt.result.failure?.code ?? null,
      message: firstAttempt.result.failure?.message ?? null,
      verifierDecision: firstAttempt.result.verifierResult?.decision ?? null,
      verifierIssues: firstAttempt.result.verifierResult?.issues ?? [],
      applyDiagnostics: firstAttempt.diagnostics,
      applyError: failureError
    },
    repairInstructions: {
      requiredChangedFiles: TASK.allowedChangeFiles,
      alreadyChangedFiles: changedFiles,
      missingRequiredFiles,
      preserveValidPreviousEdits: true,
      returnAllRequiredFiles: true,
      useOnlyExactAnchorsFromCatalog: true,
      testRequirement: 'Add a named bigint regression test using bigint literals such as 1n and 2n, or BigInt(1) and BigInt(2). Ensure the complete test file remains syntactically valid.'
    },
    exactAnchorCatalog: [
      {file: 'src/index.js', find: SOURCE_CONDITION, purpose: 'Extend primitive handling to bigint.'},
      {file: 'test/index.js', find: TEST_ANCHOR, purpose: 'Insert the complete bigint regression test immediately before the objects test.'}
    ],
    previousOutput: initialOutput,
    remaskedBoundary: buildContext('E_bounded_workspace_boundary', files),
    originalEvidenceMode: mode
  };
}`
    ],
    [
      'async function providerOutputForMode(live, mode, files, repair, repairInput) {',
`function mergePatchOutputs(initialOutput, repairOutput) {
  const initialFiles = Array.isArray(initialOutput?.files) ? initialOutput.files : [];
  const repairFiles = Array.isArray(repairOutput?.files) ? repairOutput.files : [];
  const byPath = new Map();
  for (const file of initialFiles) {
    if (file && TASK.allowedChangeFiles.includes(file.path)) byPath.set(file.path, file);
  }
  for (const file of repairFiles) {
    if (file && TASK.allowedChangeFiles.includes(file.path)) byPath.set(file.path, file);
  }
  return {
    summary: repairOutput?.summary ?? initialOutput?.summary ?? 'Merged failure-directed repair patch.',
    confidence: typeof repairOutput?.confidence === 'number' ? repairOutput.confidence : (initialOutput?.confidence ?? 0.8),
    files: TASK.allowedChangeFiles.map(file => byPath.get(file)).filter(Boolean)
  };
}

async function providerOutputForMode(live, mode, files, repair, repairInput) {`
    ],
    [
      "        const repairMutation = repairProvider.output ? outputToMutation(repairProvider.output) : providerFailureMutation(repairProviderError ?? 'unknown_repair_provider_failure');",
      "        const mergedRepairOutput = repairProvider.output ? mergePatchOutputs(initialProvider.output, repairProvider.output) : null;\n        const repairMutation = mergedRepairOutput ? outputToMutation(mergedRepairOutput) : providerFailureMutation(repairProviderError ?? 'unknown_repair_provider_failure');"
    ],
    [
      '        initialProviderError,\n',
      '        initialProviderError,\n        initialProviderOutput: initialProvider.output,\n'
    ],
    [
      '        repairProviderError,\n',
      '        repairProviderError,\n        repairProviderOutput: repairProvider?.output ?? null,\n'
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
      "version: 'gate5-external-patch-e2e/v3'"
    ]
  ];

  for (const [before, after] of replacements) {
    assert.equal(source.includes(before), true, `expected_v1_fragment_missing:${before.slice(0, 80)}`);
    source = source.replace(before, after);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-external-patch-e2e-v3-'));
  const generatedPath = path.join(root, 'gate5-external-patch-e2e-v3.generated.cjs');
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
