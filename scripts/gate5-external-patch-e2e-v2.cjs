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
      '        firstApplyDiagnostics: firstAttempt.diagnostics,\n',
      '        firstApplyDiagnostics: firstAttempt.diagnostics,\n        firstFailureStage: firstAttempt.result.failure?.stage ?? null,\n        firstFailureCode: firstAttempt.result.failure?.code ?? null,\n        firstFailureMessage: firstAttempt.result.failure?.message ?? null,\n        firstPlannerIssues: firstAttempt.result.plannerResult?.issues ?? [],\n'
    ],
    [
      '        finalApplyDiagnostics: finalAttempt.diagnostics,\n',
      '        finalApplyDiagnostics: finalAttempt.diagnostics,\n        finalFailureStage: finalAttempt.result.failure?.stage ?? null,\n        finalFailureCode: finalAttempt.result.failure?.code ?? null,\n        finalFailureMessage: finalAttempt.result.failure?.message ?? null,\n        finalPlannerIssues: finalAttempt.result.plannerResult?.issues ?? [],\n'
    ],
    [
      "version: 'gate5-external-patch-e2e/v1'",
      "version: 'gate5-external-patch-e2e/v2'"
    ]
  ];

  for (const [before, after] of replacements) {
    assert.equal(source.includes(before), true, `expected_v1_fragment_missing:${before.slice(0, 80)}`);
    source = source.replace(before, after);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-external-patch-e2e-v2-'));
  const generatedPath = path.join(root, 'gate5-external-patch-e2e-v2.generated.cjs');
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
