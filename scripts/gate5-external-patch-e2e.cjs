#!/usr/bin/env node

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MODES = Object.freeze([
  'A_long_context',
  'B_retrieval_context',
  'C_synthetic_context',
  'D_bounded_workspace',
  'E_bounded_workspace_boundary'
]);

const TASK = Object.freeze({
  repository: 'lukeed/clsx',
  commitSha: '925494cf31bcd97d3337aacd34e659e80cae7fe2',
  taskId: 'external.clsx.bigint-runtime-patch',
  objective: 'Support bigint class values in the clsx runtime consistently with the existing TypeScript declaration, and add focused regression coverage.',
  candidateFiles: Object.freeze(['src/index.js', 'test/index.js', 'clsx.d.ts', 'package.json', 'readme.md']),
  allowedChangeFiles: Object.freeze(['src/index.js', 'test/index.js']),
  forbiddenFiles: Object.freeze(['clsx.d.ts', 'package.json', 'readme.md']),
  requiredSymbols: Object.freeze(['clsx', 'toVal']),
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
  const material = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

function canonical(values) {
  return [...new Set(Array.isArray(values) ? values : [])]
    .sort((left, right) => left.localeCompare(right));
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
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr ?? ''}`
    );
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function numberedExcerpt(content, startLine, endLine) {
  return content
    .split('\n')
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
}

function keywordSnippets(files, keywords, radius = 4) {
  const snippets = [];

  for (const [file, content] of Object.entries(files)) {
    const lines = content.split('\n');
    const selected = new Set();

    lines.forEach((line, index) => {
      if (keywords.some(keyword => line.toLowerCase().includes(keyword.toLowerCase()))) {
        for (
          let cursor = Math.max(0, index - radius);
          cursor <= Math.min(lines.length - 1, index + radius);
          cursor += 1
        ) {
          selected.add(cursor);
        }
      }
    });

    if (selected.size > 0) {
      snippets.push({
        file,
        content: [...selected]
          .sort((left, right) => left - right)
          .map(index => `${index + 1}: ${lines[index]}`)
          .join('\n')
      });
    }
  }

  return snippets;
}

async function loadSnapshot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate5-external-patch-e2e-'));
  const checkout = path.join(root, 'repo');

  run('git', [
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    `https://github.com/${TASK.repository}.git`,
    checkout
  ]);
  run('git', ['fetch', '--depth', '1', 'origin', TASK.commitSha], {cwd: checkout});
  run('git', ['checkout', '--detach', TASK.commitSha], {cwd: checkout});

  const head = run('git', ['rev-parse', 'HEAD'], {
    cwd: checkout,
    capture: true
  }).stdout.trim();
  assert.equal(head, TASK.commitSha);

  const files = {};
  for (const file of TASK.candidateFiles) {
    files[file] = await fs.readFile(path.join(checkout, file), 'utf8');
  }

  return {root, checkout, files};
}

function outputContract() {
  return {
    summary: 'non-empty string',
    confidence: 'number from 0 to 1',
    files: [{
      path: 'repository-relative path',
      description: 'non-empty string',
      edits: [{
        find: 'exact existing text',
        replace: 'replacement text'
      }]
    }]
  };
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
    outputContract: outputContract()
  };

  if (mode === 'A_long_context') {
    return {
      ...common,
      contextStrategy: 'all_candidate_files_full_text',
      files: Object.entries(files).map(([file, content]) => ({file, content}))
    };
  }

  if (mode === 'B_retrieval_context') {
    return {
      ...common,
      contextStrategy: 'keyword_retrieval',
      retrievedSnippets: keywordSnippets(files, [
        'typeof mix',
        "test('numbers",
        "test('objects",
        'classvalue',
        'bigint',
        'toval',
        'clsx'
      ])
    };
  }

  if (mode === 'C_synthetic_context') {
    return {
      ...common,
      contextStrategy: 'deterministic_summary_with_edit_anchors',
      summaries: [
        {
          file: 'src/index.js',
          summary: 'toVal recursively converts supported primitive, object, and nested-array class values; clsx joins non-empty conversions.'
        },
        {
          file: 'test/index.js',
          summary: 'uvu regression tests cover strings, numbers, objects, arrays, nested arrays, and exports.'
        },
        {
          file: 'clsx.d.ts',
          summary: 'ClassValue already includes bigint, so the declaration does not require a change.'
        },
        {
          file: 'package.json',
          summary: 'Package metadata and scripts; outside the requested change boundary.'
        },
        {
          file: 'readme.md',
          summary: 'Documentation; outside the requested change boundary.'
        }
      ],
      editableAnchors: [
        {file: 'src/index.js', exactText: SOURCE_CONDITION},
        {file: 'test/index.js', exactText: TEST_ANCHOR}
      ]
    };
  }

  if (mode === 'D_bounded_workspace') {
    return {
      ...common,
      contextStrategy: 'bounded_workspace_selected_files',
      workspaceFiles: TASK.allowedChangeFiles.map(file => ({
        file,
        content: files[file]
      }))
    };
  }

  return {
    ...common,
    contextStrategy: 'bounded_workspace_with_boundary',
    allowedInspectionFiles: TASK.allowedChangeFiles,
    forbiddenInspectionFiles: TASK.forbiddenFiles,
    boundaryReason: 'The runtime implementation and focused executable regression test are the complete minimal change boundary. Type declarations already contain bigint.',
    workspaceExcerpts: [
      {
        file: 'src/index.js',
        content: numberedExcerpt(files['src/index.js'], 1, 45)
      },
      {
        file: 'test/index.js',
        content: numberedExcerpt(files['test/index.js'], 19, 56)
      },
      {
        file: 'clsx.d.ts',
        content: numberedExcerpt(files['clsx.d.ts'], 1, 12)
      }
    ]
  };
}

function buildInitialEvidence(files) {
  return TASK.allowedChangeFiles.map(file => {
    const content = files[file];
    return {
      path: file,
      source: 'exact_allowed_repository_snapshot',
      content,
      contentHash: hash(content),
      byteLength: Buffer.byteLength(content),
      estimatedTokens: Math.ceil(content.length / 4),
      matchedSymbols: file === 'src/index.js' ? TASK.requiredSymbols : []
    };
  });
}

function correctFixtureFile(file) {
  if (file === 'src/index.js') {
    return {
      path: file,
      description: 'Treat bigint values like strings and numbers in toVal.',
      edits: [{
        find: SOURCE_CONDITION,
        replace: SOURCE_REPLACEMENT
      }]
    };
  }

  if (file === 'test/index.js') {
    return {
      path: file,
      description: 'Add focused regression tests for bigint values.',
      edits: [{
        find: TEST_ANCHOR,
        replace: TEST_REPLACEMENT
      }]
    };
  }

  throw new Error(`unsupported_fixture_file:${file}`);
}

function correctFixtureModelOutput(files = TASK.allowedChangeFiles) {
  return {
    summary: 'Support bigint runtime values and add focused regression coverage.',
    confidence: 0.98,
    files: files.map(correctFixtureFile)
  };
}

function fixtureInitialOutput(mode) {
  if (mode === 'A_long_context') {
    return correctFixtureModelOutput(['src/index.js']);
  }

  if (mode === 'B_retrieval_context') {
    return {
      summary: 'Unsafe fixture draft to exercise deterministic verifier remask.',
      confidence: 0.98,
      files: [{
        path: 'package.json',
        description: 'Incorrect out-of-scope change.',
        edits: [{
          find: '"version": "2.1.1"',
          replace: '"version": "2.1.2"'
        }]
      }]
    };
  }

  return correctFixtureModelOutput();
}

function fixtureRepairOutput(repairInput) {
  const repairFiles = repairInput?.repairInstructions?.repairFiles;
  if (!Array.isArray(repairFiles) || repairFiles.length === 0) {
    throw new Error('fixture_repair_files_missing');
  }
  return correctFixtureModelOutput(repairFiles);
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`);
  }
  return value;
}

function normalizeProviderOutput(rawOutput, repairSpec = null) {
  const output = requirePlainObject(rawOutput, 'provider_output');
  const files = output.files;

  if (!Array.isArray(files) || files.length === 0 || files.length > 5) {
    throw new Error('provider_output_files_invalid');
  }

  const seen = new Set();
  const normalizedFiles = files.map((rawFile, fileIndex) => {
    const file = requirePlainObject(rawFile, `provider_file_${fileIndex}`);
    const filePath = file.path;

    if (
      typeof filePath !== 'string' ||
      !TASK.candidateFiles.includes(filePath) ||
      seen.has(filePath)
    ) {
      throw new Error(`provider_output_file_path_invalid:${String(filePath)}`);
    }
    seen.add(filePath);

    if (
      repairSpec !== null &&
      !repairSpec.repairFiles.includes(filePath)
    ) {
      throw new Error(`repair_returned_unrequested_file:${filePath}`);
    }

    if (!Array.isArray(file.edits) || file.edits.length === 0 || file.edits.length > 5) {
      throw new Error(`provider_output_edits_invalid:${filePath}`);
    }

    const expectedAnchor = repairSpec?.anchorByFile?.get(filePath);
    const edits = file.edits.map((rawEdit, editIndex) => {
      const edit = requirePlainObject(rawEdit, `provider_edit_${fileIndex}_${editIndex}`);
      if (
        typeof edit.find !== 'string' ||
        edit.find.length === 0 ||
        typeof edit.replace !== 'string'
      ) {
        throw new Error(`provider_output_edit_invalid:${filePath}:${editIndex}`);
      }
      if (expectedAnchor !== undefined && edit.find !== expectedAnchor) {
        throw new Error(`repair_anchor_mismatch:${filePath}`);
      }
      return {find: edit.find, replace: edit.replace};
    });

    return {
      path: filePath,
      description: typeof file.description === 'string' && file.description.trim().length > 0
        ? file.description.trim()
        : `Edit ${filePath}.`,
      edits
    };
  });

  return {
    summary: typeof output.summary === 'string' && output.summary.trim().length > 0
      ? output.summary.trim()
      : 'Model generated an external repository patch.',
    confidence: typeof output.confidence === 'number' &&
      Number.isFinite(output.confidence) &&
      output.confidence >= 0 &&
      output.confidence <= 1
      ? output.confidence
      : 0.8,
    files: normalizedFiles
  };
}

function outputToMutation(output, role = 'coder', target = 'patchDraft') {
  const claims = output.files.map(file => ({
    type: 'patch_draft',
    file: file.path,
    description: file.description,
    proposedPatch: JSON.stringify({
      format: 'exact_replacements/v1',
      edits: file.edits
    })
  }));

  return {
    role,
    target,
    summary: output.summary,
    claims,
    touchedFiles: claims.map(claim => claim.file),
    confidence: output.confidence
  };
}

function parseJsonContent(content) {
  const stripped = content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw new Error('provider_json_parse_failed');
  }
}

async function invokeLive(payload, options = {}) {
  const endpoint = process.env.GATE5_OPENAI_ENDPOINT;
  const model = process.env.GATE5_MODEL;
  if (!endpoint || !model) {
    throw new Error('live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL');
  }

  const repair = options.repair === true;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.GATE5_API_KEY
        ? {authorization: `Bearer ${process.env.GATE5_API_KEY}`}
        : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number.parseInt(
        process.env.GATE5_MAX_COMPLETION_TOKENS ?? '768',
        10
      ),
      messages: [
        {
          role: 'system',
          content: repair
            ? [
                'Repair only files listed in repairInstructions.repairFiles.',
                'Never return files listed in repairInstructions.preserveFiles.',
                'Every edit.find must exactly equal the matching exactAnchorCatalog find value.',
                'Return complete syntactically valid JavaScript replacements.',
                'Return strict JSON matching outputContract and no explanation.'
              ].join(' ')
            : [
                'Generate the smallest correct patch using only supplied repository evidence.',
                'Return strict JSON matching outputContract.',
                'Use exact find/replace edits, touch no forbidden files, and add no explanation.'
              ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify(payload)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(
      `provider_http_${response.status}:${(await response.text()).slice(0, 2000)}`
    );
  }

  const envelope = await response.json();
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('provider_content_missing');
  }

  const usage = envelope.usage ?? {};
  return {
    output: parseJsonContent(content),
    rawContent: content,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0
    },
    latencyMs: Date.now() - started
  };
}

function providerFailureMutation(message) {
  return {
    role: 'coder',
    target: 'patchDraft',
    summary: `Provider failed before producing a valid patch: ${message}`,
    claims: [],
    touchedFiles: [],
    confidence: 0
  };
}

function exactReplacementApply(content, edit) {
  if (
    edit === null ||
    typeof edit !== 'object' ||
    typeof edit.find !== 'string' ||
    edit.find.length === 0 ||
    typeof edit.replace !== 'string'
  ) {
    throw new Error('invalid_exact_replacement_edit');
  }

  const first = content.indexOf(edit.find);
  if (first < 0) {
    throw new Error('replacement_anchor_not_found');
  }
  if (content.indexOf(edit.find, first + edit.find.length) >= 0) {
    throw new Error('replacement_anchor_not_unique');
  }

  return content.slice(0, first) +
    edit.replace +
    content.slice(first + edit.find.length);
}

async function resetCheckout(checkout) {
  run('git', ['reset', '--hard', TASK.commitSha], {
    cwd: checkout,
    capture: true
  });
  run('git', ['clean', '-fd'], {
    cwd: checkout,
    capture: true
  });
}

function safeTargetPath(checkout, relativePath) {
  const target = path.resolve(checkout, relativePath);
  const rootPrefix = `${path.resolve(checkout)}${path.sep}`;
  if (!target.startsWith(rootPrefix)) {
    throw new Error('patch_path_outside_checkout');
  }
  return target;
}

function syntaxCheck(content, label) {
  const root = require('node:fs').mkdtempSync(
    path.join(os.tmpdir(), `gate5-clsx-${label}-`)
  );
  const target = path.join(root, `${label}.mjs`);

  try {
    require('node:fs').writeFileSync(target, content, 'utf8');
    const result = run('node', ['--check', target], {
      capture: true,
      allowFailure: true
    });
    return {
      passed: result.status === 0,
      error: result.status === 0
        ? null
        : `${label}_syntax_failed:${result.stderr.trim()}`
    };
  } finally {
    require('node:fs').rmSync(root, {recursive: true, force: true});
  }
}

function runSourceSemanticCheck(checkout) {
  const semanticScript = [
    "const fs = await import('node:fs/promises');",
    "const source = await fs.readFile('./src/index.js', 'utf8');",
    "const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));",
    "const actual=[mod.clsx(1n),mod.clsx(0n),mod.clsx(1n,2n),mod.clsx(['x',2n])];",
    "const expected=['1','','1 2','x 2'];",
    "if(JSON.stringify(actual)!==JSON.stringify(expected)){throw new Error(JSON.stringify({actual,expected}));}"
  ].join(' ');

  const result = run('node', ['--input-type=module', '-e', semanticScript], {
    cwd: checkout,
    capture: true,
    allowFailure: true
  });

  return {
    passed: result.status === 0,
    error: result.status === 0
      ? null
      : `semantic_acceptance_failed:${result.stderr.trim()}`
  };
}

function checkRegressionEvidence(checkout, changedFiles) {
  if (!changedFiles.includes('test/index.js')) {
    return false;
  }

  const diff = run('git', ['diff', '--unified=0', '--', 'test/index.js'], {
    cwd: checkout,
    capture: true
  }).stdout;

  const addedLines = diff
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');

  const hasBigintExpression =
    /(?:\b(?:0[xob][0-9a-f]+|\d+)n\b|BigInt\s*\()/i.test(addedLines);
  const hasClassInvocation = /\b(?:fn|clsx)\s*\(/.test(addedLines);
  const hasAssertion =
    /\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(/.test(addedLines);

  return hasBigintExpression && hasClassInvocation && hasAssertion;
}

function makeApplyExecutor(checkout, diagnosticsRef, runtime) {
  return async ({mutation, plannerExecutionBindingHash, verifierFindingHash}) => {
    const diagnostics = {
      changedFiles: [],
      changedFilesExact: false,
      sourceSyntaxPassed: false,
      sourceBehaviorPassed: false,
      testSyntaxPassed: false,
      regressionEvidencePassed: false,
      semanticOraclePassed: false,
      testsPassed: false,
      errors: [],
      error: null
    };
    diagnosticsRef.current = diagnostics;

    try {
      const staged = new Map();

      for (const claim of mutation.claims) {
        if (
          claim === null ||
          typeof claim !== 'object' ||
          claim.type !== 'patch_draft' ||
          typeof claim.file !== 'string' ||
          typeof claim.proposedPatch !== 'string'
        ) {
          throw new Error('invalid_patch_claim');
        }

        if (!TASK.allowedChangeFiles.includes(claim.file)) {
          throw new Error(`apply_out_of_scope_file:${claim.file}`);
        }

        const parsed = JSON.parse(claim.proposedPatch);
        if (
          parsed.format !== 'exact_replacements/v1' ||
          !Array.isArray(parsed.edits) ||
          parsed.edits.length === 0
        ) {
          throw new Error('unsupported_patch_format');
        }

        const target = safeTargetPath(checkout, claim.file);
        let content = staged.has(claim.file)
          ? staged.get(claim.file)
          : await fs.readFile(target, 'utf8');

        for (const edit of parsed.edits) {
          content = exactReplacementApply(content, edit);
        }
        staged.set(claim.file, content);
      }

      for (const [file, content] of staged.entries()) {
        await fs.writeFile(safeTargetPath(checkout, file), content, 'utf8');
      }

      diagnostics.changedFiles = canonical(
        run('git', ['diff', '--name-only'], {
          cwd: checkout,
          capture: true
        }).stdout
          .split('\n')
          .map(value => value.trim())
          .filter(Boolean)
      );
      diagnostics.changedFilesExact = exact(
        diagnostics.changedFiles,
        TASK.allowedChangeFiles
      );

      const sourceContent = await fs.readFile(
        path.join(checkout, 'src/index.js'),
        'utf8'
      );
      const testContent = await fs.readFile(
        path.join(checkout, 'test/index.js'),
        'utf8'
      );

      const sourceSyntax = syntaxCheck(sourceContent, 'source');
      diagnostics.sourceSyntaxPassed = sourceSyntax.passed;
      if (!sourceSyntax.passed) {
        diagnostics.errors.push(sourceSyntax.error);
      } else {
        const semantic = runSourceSemanticCheck(checkout);
        diagnostics.sourceBehaviorPassed = semantic.passed;
        if (!semantic.passed) {
          diagnostics.errors.push(semantic.error);
        }
      }

      const testSyntax = syntaxCheck(testContent, 'test');
      diagnostics.testSyntaxPassed = testSyntax.passed;
      if (!testSyntax.passed) {
        diagnostics.errors.push(testSyntax.error);
      } else {
        diagnostics.regressionEvidencePassed = checkRegressionEvidence(
          checkout,
          diagnostics.changedFiles
        );
        if (!diagnostics.regressionEvidencePassed) {
          diagnostics.errors.push('regression_test_evidence_missing');
        }
      }

      if (!diagnostics.changedFilesExact) {
        diagnostics.errors.push('changed_files_do_not_match_required_scope');
      }

      diagnostics.semanticOraclePassed =
        diagnostics.sourceBehaviorPassed &&
        diagnostics.regressionEvidencePassed;
      diagnostics.testsPassed = diagnostics.errors.length === 0;

      if (!diagnostics.testsPassed) {
        diagnostics.error = diagnostics.errors[0];
        return {
          decision: 'apply_blocked',
          route: 'replan_required',
          receiptHash: null
        };
      }

      const receiptHash = runtime.hashCanonicalJson({
        taskId: TASK.taskId,
        commitSha: TASK.commitSha,
        changedFiles: diagnostics.changedFiles,
        testsPassed: diagnostics.testsPassed,
        semanticOraclePassed: diagnostics.semanticOraclePassed,
        plannerExecutionBindingHash,
        verifierFindingHash,
        diffHash: hash(
          run('git', ['diff', '--binary'], {
            cwd: checkout,
            capture: true
          }).stdout
        )
      });

      return {
        decision: 'apply_completed',
        route: 'contract_approved',
        receiptHash
      };
    } catch (error) {
      diagnostics.error = error instanceof Error
        ? error.message
        : String(error);
      diagnostics.errors = [diagnostics.error];
      return {
        decision: 'apply_blocked',
        route: 'replan_required',
        receiptHash: null
      };
    }
  };
}

function buildRuntimeInput(runtime, checkout, files, mode, mutation, diagnosticsRef) {
  const objectiveHash = runtime.hashCanonicalJson({task: TASK.objective});
  const authorityHash = runtime.hashCanonicalJson({
    authority: 'gate5_external_patch_e2e'
  });
  const policyHash = runtime.hashCanonicalJson({
    policy: 'gate5_external_patch_e2e'
  });

  const acceptanceCriteriaContract = runtime.createAcceptanceCriteriaContract({
    taskId: TASK.taskId,
    objectiveHash,
    criteria: [
      {
        id: 'bigint_runtime_behavior',
        description: 'Bigint class values are handled consistently with the existing declaration.',
        required: true,
        evidence: {
          kind: 'test',
          commandId: 'node.semantic.bigint'
        }
      },
      {
        id: 'focused_regression_coverage',
        description: 'Focused regression coverage is added without changing files outside the explicit boundary.',
        required: true,
        evidence: {
          kind: 'test',
          commandId: 'node.syntax.and.test.evidence'
        }
      }
    ]
  });

  const minimalityPolicy = runtime.createPreventiveMinimalityPolicy({
    policyVersion: '1',
    policyId: 'gate5.external.patch.e2e',
    preferExistingCode: true,
    preferStandardLibrary: true,
    preferNativePlatform: true,
    preferInstalledDependencies: true,
    newDependencyRequiresJustification: true,
    newDependencyRequiresAlternatives: true,
    newAbstractionRequiresJustification: true,
    newAbstractionMinReuseSites: 2,
    unrequestedDependencyBehavior: 'human_review',
    unrequestedAbstractionBehavior: 'human_review',
    unrequestedRefactorBehavior: 'replan',
    highRiskBehavior: 'disabled',
    maxPlannedFiles: 2,
    maxNewDependencies: 0,
    maxNewAbstractions: 0
  });

  const proposalCore = {
    proposalVersion: '1',
    taskId: TASK.taskId,
    objectiveHash,
    acceptanceContractHash: acceptanceCriteriaContract.contractHash,
    authorityHash,
    policyHash,
    seedFiles: ['src/index.js'],
    seedRationales: [{
      path: 'src/index.js',
      reasonHash: runtime.hashCanonicalJson({
        reason: 'Existing runtime implementation boundary.'
      })
    }],
    requiredSymbols: TASK.requiredSymbols,
    requiredTestFiles: TASK.requiredTestFiles,
    maxExpansionAttempts: 1
  };
  const proposal = {
    ...proposalCore,
    proposalHash: runtime.hashCanonicalJson(proposalCore)
  };

  return {
    repositoryPath: checkout,
    taskId: TASK.taskId,
    objectiveHash,
    acceptanceCriteriaContract,
    authorityHash,
    policyHash,
    proposalLimits: {
      maxSeedFiles: 1,
      maxRequiredSymbols: 2,
      maxRequiredTests: 1,
      maxExpansionAttempts: 1
    },
    minimalityPolicy,
    allowedChangeFiles: TASK.allowedChangeFiles,
    forbiddenFiles: TASK.forbiddenFiles,
    taskContext: {
      task: TASK.objective,
      mode
    },
    initialEvidence: buildInitialEvidence(files),
    authorityPresent: true,
    policyPresent: true,
    hardTotalBudgetTokens: 20000,
    plannerMinimalityProvider: async () => ({
      proposal,
      minimalityPlan: {
        planVersion: '1',
        riskClass: 'low',
        taskExplicitlyRequestsRefactor: false,
        plannedFiles: [
          {
            path: 'src/index.js',
            changeKind: 'bugfix',
            requested: true,
            justification: null
          },
          {
            path: 'test/index.js',
            changeKind: 'test',
            requested: true,
            justification: null
          }
        ],
        newDependencies: [],
        newAbstractions: []
      }
    }),
    contextRequestProvider: async () => ({
      requestedFiles: [],
      requiredSymbols: [],
      reason: 'unused'
    }),
    coderProvider: async () => mutation,
    applyExecutor: makeApplyExecutor(checkout, diagnosticsRef, runtime)
  };
}

async function runAttempt(runtime, snapshot, mode, mutation) {
  await resetCheckout(snapshot.checkout);
  const diagnosticsRef = {current: null};
  const result = await runtime.runBoundedTask(
    buildRuntimeInput(
      runtime,
      snapshot.checkout,
      snapshot.files,
      mode,
      mutation,
      diagnosticsRef
    )
  );
  return {
    result,
    diagnostics: diagnosticsRef.current
  };
}

function attemptPassed(runtime, attempt) {
  return attempt.result.decision === 'bounded_task_completed' &&
    attempt.result.route === 'contract_approved' &&
    attempt.result.receipt?.outcome === 'applied_and_validated' &&
    runtime.verifyBoundedTaskReceipt(attempt.result.receipt) &&
    attempt.diagnostics?.testsPassed === true &&
    attempt.diagnostics?.changedFilesExact === true;
}

function validatedFilesFromDiagnostics(diagnostics) {
  const preserve = [];

  if (
    diagnostics?.sourceSyntaxPassed === true &&
    diagnostics?.sourceBehaviorPassed === true
  ) {
    preserve.push('src/index.js');
  }

  if (
    diagnostics?.testSyntaxPassed === true &&
    diagnostics?.regressionEvidencePassed === true
  ) {
    preserve.push('test/index.js');
  }

  return canonical(preserve);
}

function repairPayload(mode, files, currentOutput, attempt, repairNumber) {
  const diagnostics = attempt.diagnostics ?? {};
  const preserveFiles = validatedFilesFromDiagnostics(diagnostics);
  const repairFiles = TASK.allowedChangeFiles.filter(
    file => !preserveFiles.includes(file)
  );
  const exactAnchorCatalog = [
    {
      file: 'src/index.js',
      find: SOURCE_CONDITION,
      purpose: 'Extend primitive class handling to bigint without changing unrelated logic.'
    },
    {
      file: 'test/index.js',
      find: TEST_ANCHOR,
      purpose: 'Insert one complete syntactically valid bigint regression test immediately before the objects test.'
    }
  ].filter(entry => repairFiles.includes(entry.file));

  return {
    repairClass: 'failure_directed_masked_repair/v3',
    repairNumber,
    task: {
      repository: TASK.repository,
      commitSha: TASK.commitSha,
      taskId: TASK.taskId,
      objective: TASK.objective
    },
    failure: {
      runtimeDecision: attempt.result.decision,
      runtimeRoute: attempt.result.route,
      stage: attempt.result.failure?.stage ?? null,
      code: attempt.result.failure?.code ?? null,
      message: attempt.result.failure?.message ?? null,
      verifierDecision: attempt.result.verifierResult?.decision ?? null,
      verifierIssues: attempt.result.verifierResult?.issues ?? [],
      applyDiagnostics: diagnostics
    },
    repairInstructions: {
      requiredChangedFiles: TASK.allowedChangeFiles,
      preserveFiles,
      repairFiles,
      returnOnlyRepairFiles: true,
      neverRewritePreserveFiles: true,
      useOnlyExactAnchorsFromCatalog: true,
      sourceRequirement: 'Truthy bigint values must stringify as class names; 0n must remain omitted.',
      testRequirement: 'Add focused assertions covering truthy bigint, 0n, and multiple bigint values. The resulting entire test file must parse as JavaScript.'
    },
    exactAnchorCatalog,
    repairContextFiles: repairFiles.map(file => ({
      file,
      content: files[file]
    })),
    previousOutput: currentOutput,
    originalEvidenceMode: mode,
    outputContract: outputContract()
  };
}

function repairSpecFromPayload(payload) {
  return {
    repairFiles: payload.repairInstructions.repairFiles,
    anchorByFile: new Map(
      payload.exactAnchorCatalog.map(entry => [entry.file, entry.find])
    )
  };
}

function mergePatchOutputs(currentOutput, repairOutput, diagnostics) {
  const currentByPath = new Map(
    currentOutput.files.map(file => [file.path, file])
  );
  const repairByPath = new Map(
    repairOutput.files.map(file => [file.path, file])
  );
  const preserveFiles = new Set(validatedFilesFromDiagnostics(diagnostics));

  const files = [];
  for (const file of TASK.allowedChangeFiles) {
    if (preserveFiles.has(file) && currentByPath.has(file)) {
      files.push(currentByPath.get(file));
      continue;
    }
    if (repairByPath.has(file)) {
      files.push(repairByPath.get(file));
    }
  }

  return {
    summary: repairOutput.summary ||
      currentOutput.summary ||
      'Merged failure-directed repair patch.',
    confidence: repairOutput.confidence,
    files
  };
}

async function providerOutputForMode(live, mode, files, options = {}) {
  const repairInput = options.repairInput ?? null;

  if (!live) {
    const rawOutput = repairInput
      ? fixtureRepairOutput(repairInput)
      : fixtureInitialOutput(mode);
    return {
      output: normalizeProviderOutput(
        rawOutput,
        repairInput ? repairSpecFromPayload(repairInput) : null
      ),
      rawContent: null,
      usage: {
        promptTokens: repairInput ? 500 : 400,
        completionTokens: 120,
        totalTokens: repairInput ? 620 : 520
      },
      latencyMs: repairInput ? 130 : 100
    };
  }

  const provider = await invokeLive(
    repairInput ?? buildContext(mode, files),
    {repair: repairInput !== null}
  );

  return {
    ...provider,
    output: normalizeProviderOutput(
      provider.output,
      repairInput ? repairSpecFromPayload(repairInput) : null
    )
  };
}

function emptyProviderResult() {
  return {
    output: null,
    rawContent: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    },
    latencyMs: 0
  };
}

function remaskReasonForAttempt(attempt) {
  if (
    attempt.result.verifierResult !== null &&
    attempt.result.verifierResult !== undefined &&
    attempt.result.verifierResult.decision !== 'approve'
  ) {
    return 'verification';
  }
  if (attempt.result.summary.applyCalled) {
    return 'apply';
  }
  return attempt.result.failure?.stage ?? 'runtime';
}

function extractTouchedFiles(attempt) {
  return canonical(
    attempt.result.plannerResult
      ?.taskSeedResult
      ?.repoResult
      ?.adaptiveResult
      ?.coderResult
      ?.providerOutput
      ?.touchedFiles ?? []
  );
}

async function main() {
  const live = process.argv.includes('--live');
  if (
    live &&
    (!process.env.GATE5_OPENAI_ENDPOINT || !process.env.GATE5_MODEL)
  ) {
    throw new Error(
      'live_mode_requires_GATE5_OPENAI_ENDPOINT_and_GATE5_MODEL'
    );
  }

  const configuredRepairAttempts = Number.parseInt(
    process.env.GATE5_MAX_REPAIR_ATTEMPTS ?? '2',
    10
  );
  if (
    !Number.isSafeInteger(configuredRepairAttempts) ||
    configuredRepairAttempts < 0 ||
    configuredRepairAttempts > 3
  ) {
    throw new Error('GATE5_MAX_REPAIR_ATTEMPTS_must_be_between_0_and_3');
  }

  const snapshot = await loadSnapshot();
  const runtime = await import(
    '../dist/packages/product-runtime/src/canonical-runtime.js'
  );
  const results = [];

  try {
    for (const mode of MODES) {
      const providerPayload = buildContext(mode, snapshot.files);
      const providerPayloadText = JSON.stringify(providerPayload);

      assert.equal(providerPayloadText.includes(SOURCE_REPLACEMENT), false);
      assert.equal(providerPayloadText.includes(TEST_REPLACEMENT), false);

      let initialProvider = emptyProviderResult();
      let initialProviderError = null;

      try {
        initialProvider = await providerOutputForMode(
          live,
          mode,
          snapshot.files
        );
      } catch (error) {
        initialProviderError = error instanceof Error
          ? error.message
          : String(error);
      }

      let currentOutput = initialProvider.output;
      let currentMutation = currentOutput
        ? outputToMutation(currentOutput)
        : providerFailureMutation(
            initialProviderError ?? 'unknown_provider_failure'
          );
      let currentAttempt = await runAttempt(
        runtime,
        snapshot,
        mode,
        currentMutation
      );

      const firstAttempt = currentAttempt;
      const repairHistory = [];
      const initialRemaskReason = attemptPassed(runtime, currentAttempt)
        ? null
        : remaskReasonForAttempt(currentAttempt);

      let repairAttemptCount = 0;
      while (
        !attemptPassed(runtime, currentAttempt) &&
        repairAttemptCount < configuredRepairAttempts
      ) {
        repairAttemptCount += 1;

        const payload = repairPayload(
          mode,
          snapshot.files,
          currentOutput,
          currentAttempt,
          repairAttemptCount
        );
        let repairProvider = emptyProviderResult();
        let repairProviderError = null;

        try {
          repairProvider = await providerOutputForMode(
            live,
            mode,
            snapshot.files,
            {repairInput: payload}
          );
        } catch (error) {
          repairProviderError = error instanceof Error
            ? error.message
            : String(error);
        }

        let mergedOutput = null;
        if (currentOutput && repairProvider.output) {
          mergedOutput = mergePatchOutputs(
            currentOutput,
            repairProvider.output,
            currentAttempt.diagnostics
          );
        } else if (repairProvider.output) {
          mergedOutput = repairProvider.output;
        }

        const repairMutation = mergedOutput
          ? outputToMutation(mergedOutput)
          : providerFailureMutation(
              repairProviderError ?? 'unknown_repair_provider_failure'
            );
        const repairedAttempt = await runAttempt(
          runtime,
          snapshot,
          mode,
          repairMutation
        );

        repairHistory.push({
          repairNumber: repairAttemptCount,
          payload,
          providerError: repairProviderError,
          providerOutput: repairProvider.output,
          rawContent: repairProvider.rawContent,
          usage: repairProvider.usage,
          latencyMs: repairProvider.latencyMs,
          mergedOutput,
          decision: repairedAttempt.result.decision,
          route: repairedAttempt.result.route,
          verifierDecision:
            repairedAttempt.result.verifierResult?.decision ?? null,
          diagnostics: repairedAttempt.diagnostics,
          failureStage: repairedAttempt.result.failure?.stage ?? null,
          failureCode: repairedAttempt.result.failure?.code ?? null,
          failureMessage: repairedAttempt.result.failure?.message ?? null
        });

        currentOutput = mergedOutput;
        currentAttempt = repairedAttempt;
      }

      const finalPassed = attemptPassed(runtime, currentAttempt);
      const finalTouchedFiles = extractTouchedFiles(currentAttempt);
      const scopeDriftFiles = finalTouchedFiles.filter(
        file => !TASK.allowedChangeFiles.includes(file)
      );
      const totalTokens =
        initialProvider.usage.totalTokens +
        repairHistory.reduce(
          (sum, entry) => sum + entry.usage.totalTokens,
          0
        );
      const totalLatencyMs =
        initialProvider.latencyMs +
        repairHistory.reduce(
          (sum, entry) => sum + entry.latencyMs,
          0
        );
      const repairContextBytes = repairHistory.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload)),
        0
      );

      results.push(Object.freeze({
        mode,
        contextStrategy: providerPayload.contextStrategy,
        repositoryId: `${TASK.repository}@${TASK.commitSha}`,
        taskId: TASK.taskId,
        model: live ? process.env.GATE5_MODEL : 'fixture-model',
        provider: live
          ? new URL(process.env.GATE5_OPENAI_ENDPOINT).origin
          : 'fixture-provider',
        providerVisibleOracleLeakage: false,

        initialProviderError,
        initialProviderOutput: initialProvider.output,
        initialRawContent: initialProvider.rawContent,

        firstDecision: firstAttempt.result.decision,
        firstRoute: firstAttempt.result.route,
        firstVerifierDecision:
          firstAttempt.result.verifierResult?.decision ?? null,
        firstApplyCalled: firstAttempt.result.summary.applyCalled,
        firstApplyDiagnostics: firstAttempt.diagnostics,
        firstFailureStage: firstAttempt.result.failure?.stage ?? null,
        firstFailureCode: firstAttempt.result.failure?.code ?? null,
        firstFailureMessage: firstAttempt.result.failure?.message ?? null,
        firstPlannerIssues: firstAttempt.result.plannerResult?.issues ?? [],

        remaskTriggered: repairAttemptCount > 0,
        remaskReason: initialRemaskReason,
        repairAttemptCount,
        repairHistory,

        finalDecision: currentAttempt.result.decision,
        finalRoute: currentAttempt.result.route,
        finalVerifierDecision:
          currentAttempt.result.verifierResult?.decision ?? null,
        finalApplyDiagnostics: currentAttempt.diagnostics,
        finalFailureStage: currentAttempt.result.failure?.stage ?? null,
        finalFailureCode: currentAttempt.result.failure?.code ?? null,
        finalFailureMessage: currentAttempt.result.failure?.message ?? null,
        finalPlannerIssues:
          currentAttempt.result.plannerResult?.issues ?? [],
        finalOutput: currentOutput,
        finalTouchedFiles,
        scopeDriftFiles,
        taskSucceeded: finalPassed,
        runtimeReceiptHash:
          currentAttempt.result.receipt?.receiptHash ?? null,

        totalTokens,
        totalLatencyMs,
        providerContextBytes: Buffer.byteLength(providerPayloadText),
        repairContextBytes
      }));
    }

    assert.equal(results.length, MODES.length);
    assert.equal(
      results.some(result => result.providerVisibleOracleLeakage),
      false
    );

    if (!live) {
      assert.equal(
        results.every(result => result.taskSucceeded),
        true,
        JSON.stringify(results, null, 2)
      );
      assert.equal(
        results.some(result => result.remaskReason === 'verification'),
        true
      );
      assert.equal(
        results.some(result => result.remaskReason === 'apply'),
        true
      );
    }

    const reportCore = {
      version: 'gate5-external-patch-e2e/v5',
      executionClass: live
        ? 'live_external_patch_e2e'
        : 'fixture_external_patch_e2e',
      evidenceClass: live
        ? 'external_patch_e2e_candidate'
        : 'deterministic_fixture',
      comparable: true,
      maxRepairAttempts: configuredRepairAttempts,
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
        verifierRemaskCount: results.filter(
          result => result.remaskReason === 'verification'
        ).length,
        applyRemaskCount: results.filter(
          result => result.remaskReason === 'apply'
        ).length,
        totalRepairAttempts: results.reduce(
          (sum, result) => sum + result.repairAttemptCount,
          0
        ),
        totalTokens: results.reduce(
          (sum, result) => sum + result.totalTokens,
          0
        ),
        totalScopeDriftFiles: results.reduce(
          (sum, result) => sum + result.scopeDriftFiles.length,
          0
        )
      }
    };

    const report = {
      ...reportCore,
      reportHash: hash(reportCore)
    };

    const outputArg = process.argv.find(arg => arg.startsWith('--output='));
    if (outputArg) {
      const outputPath = path.resolve(
        outputArg.slice('--output='.length)
      );
      await fs.mkdir(path.dirname(outputPath), {recursive: true});
      await fs.writeFile(
        outputPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
      );
    }

    console.log(JSON.stringify({
      ok: true,
      decision: live
        ? 'gate5_external_patch_e2e_completed'
        : 'gate5_external_patch_e2e_contract_ready',
      executionClass: report.executionClass,
      modeCount: report.results.length,
      successfulModes: report.aggregates.successfulModes,
      remaskCount: report.aggregates.remaskCount,
      verifierRemaskCount: report.aggregates.verifierRemaskCount,
      applyRemaskCount: report.aggregates.applyRemaskCount,
      totalRepairAttempts: report.aggregates.totalRepairAttempts,
      providerVisibleOracleLeakage: false,
      totalScopeDriftFiles:
        report.aggregates.totalScopeDriftFiles,
      reportHash: report.reportHash
    }, null, 2));
  } finally {
    await resetCheckout(snapshot.checkout).catch(() => {});
    await fs.rm(snapshot.root, {
      recursive: true,
      force: true
    });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
