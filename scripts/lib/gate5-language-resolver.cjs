'use strict';

const path = require('node:path');
const ts = require('typescript');

const JS_TS_EXTENSIONS = Object.freeze([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'
]);

function canonical(values) {
  return [...new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : [])]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRepositoryPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function scriptKindFor(file) {
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isJavaScriptOrTypeScript(file) {
  return JS_TS_EXTENSIONS.some(extension => file.endsWith(extension));
}

function isTestFile(file) {
  return /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|\.|$)/i.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

function linesAroundMatches(content, terms, radius = 3, maxLines = 55) {
  const lines = content.split('\n');
  const normalizedTerms = canonical(terms).filter(Boolean).map(term => term.toLowerCase());
  const selected = new Set();
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (normalizedTerms.some(term => lower.includes(term))) {
      for (let cursor = Math.max(0, index - radius); cursor <= Math.min(lines.length - 1, index + radius); cursor += 1) {
        selected.add(cursor);
      }
    }
  });
  if (selected.size === 0) {
    for (let index = 0; index < Math.min(lines.length, 20); index += 1) selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, maxLines)
    .map(index => `${index + 1}: ${lines[index]}`)
    .join('\n');
}

function resolveRelativeModule(fromFile, specifier, repositoryFiles) {
  if (!specifier.startsWith('.')) return null;
  const repositoryPaths = new Set(Object.keys(repositoryFiles).map(normalizeRepositoryPath));
  const base = normalizeRepositoryPath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  const candidates = [
    base,
    ...JS_TS_EXTENSIONS.map(extension => `${base}${extension}`),
    ...JS_TS_EXTENSIONS.map(extension => `${base}/index${extension}`)
  ];
  return candidates.find(candidate => repositoryPaths.has(candidate)) ?? null;
}

class JavaScriptTypeScriptResolver {
  constructor(repositoryFiles, candidateFiles) {
    this.kind = 'typescript_javascript_ast/v1';
    this.semantic = true;
    this.supportedLanguages = ['javascript', 'typescript'];
    this.repositoryFiles = repositoryFiles;
    this.candidateFiles = canonical(candidateFiles);
    this.symbolToFiles = new Map();
    this.stringLiteralToFiles = new Map();
    this.dependencies = new Map();
    this.reverseDependencies = new Map();
    this.indexedFiles = [];
    this.#buildIndex();
  }

  supports(file) {
    return isJavaScriptOrTypeScript(file);
  }

  #addIndexEntry(index, value, file) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 160) return;
    const files = index.get(value) ?? new Set();
    files.add(file);
    index.set(value, files);
  }

  #buildIndex() {
    for (const file of this.candidateFiles) {
      if (!this.supports(file) || typeof this.repositoryFiles[file] !== 'string') continue;
      this.indexedFiles.push(file);
      const sourceFile = ts.createSourceFile(
        file,
        this.repositoryFiles[file],
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(file)
      );
      const dependencies = new Set();
      const visit = node => {
        if (ts.isIdentifier(node)) this.#addIndexEntry(this.symbolToFiles, node.text, file);
        if (ts.isPrivateIdentifier(node)) this.#addIndexEntry(this.symbolToFiles, node.text, file);
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          this.#addIndexEntry(this.stringLiteralToFiles, node.text, file);
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const resolved = resolveRelativeModule(file, node.moduleSpecifier.text, this.repositoryFiles);
          if (resolved) dependencies.add(resolved);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const resolved = resolveRelativeModule(file, node.arguments[0].text, this.repositoryFiles);
          if (resolved) dependencies.add(resolved);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      this.dependencies.set(file, dependencies);
    }

    for (const [fromFile, dependencies] of this.dependencies.entries()) {
      for (const dependency of dependencies) {
        const reverse = this.reverseDependencies.get(dependency) ?? new Set();
        reverse.add(fromFile);
        this.reverseDependencies.set(dependency, reverse);
      }
    }
  }

  resolveSymbols(symbols, inspectionFiles) {
    const allowed = new Set(canonical(inspectionFiles));
    const resolved = [];
    const unresolved = [];
    const definitionFiles = new Set();
    for (const symbol of canonical(symbols)) {
      const files = [...(this.symbolToFiles.get(symbol) ?? [])].filter(file => allowed.has(file));
      if (files.length > 0) {
        resolved.push(symbol);
        files.forEach(file => definitionFiles.add(file));
      } else {
        unresolved.push(symbol);
      }
    }
    return {
      resolvedSymbols: resolved,
      unresolvedSymbols: unresolved,
      definitionFiles: canonical([...definitionFiles])
    };
  }

  resolveTestAnchors(anchors, inspectionFiles) {
    const allowedTests = new Set(canonical(inspectionFiles).filter(isTestFile));
    const resolved = [];
    const unresolved = [];
    const anchorFiles = new Set();
    for (const anchor of canonical(anchors)) {
      const exactFiles = [...(this.stringLiteralToFiles.get(anchor) ?? [])].filter(file => allowedTests.has(file));
      const textFiles = [...allowedTests].filter(file => this.repositoryFiles[file].includes(anchor));
      const files = canonical([...exactFiles, ...textFiles]);
      if (files.length > 0) {
        resolved.push(anchor);
        files.forEach(file => anchorFiles.add(file));
      } else {
        unresolved.push(anchor);
      }
    }
    return {
      resolvedTestAnchors: resolved,
      unresolvedTestAnchors: unresolved,
      anchorFiles: canonical([...anchorFiles])
    };
  }

  getOneHopDependencies(fromFiles, inspectionUniverse, maxFiles) {
    const universe = new Set(canonical(inspectionUniverse));
    const start = new Set(canonical(fromFiles));
    const candidates = new Set();
    for (const file of start) {
      for (const dependency of this.dependencies.get(file) ?? []) {
        if (universe.has(dependency) && !start.has(dependency)) candidates.add(dependency);
      }
      for (const dependent of this.reverseDependencies.get(file) ?? []) {
        if (universe.has(dependent) && !start.has(dependent)) candidates.add(dependent);
      }
    }
    return canonical([...candidates]).slice(0, maxFiles);
  }

  buildExcerpts(files, terms, options = {}) {
    return canonical(files).map(file => ({
      file,
      source: 'exact_repository_excerpt',
      content: linesAroundMatches(
        this.repositoryFiles[file],
        terms,
        options.radius ?? 3,
        options.maxLinesPerFile ?? 55
      )
    }));
  }
}

class GenericTextResolver {
  constructor(repositoryFiles, candidateFiles) {
    this.kind = 'generic_exact_text_fallback/v1';
    this.semantic = false;
    this.supportedLanguages = [];
    this.repositoryFiles = repositoryFiles;
    this.candidateFiles = canonical(candidateFiles);
    this.indexedFiles = this.candidateFiles.filter(file => typeof repositoryFiles[file] === 'string');
  }

  supports() {
    return true;
  }

  resolveSymbols(symbols, inspectionFiles) {
    const files = canonical(inspectionFiles);
    const resolvedSymbols = canonical(symbols).filter(symbol => files.some(file => this.repositoryFiles[file].includes(symbol)));
    const unresolvedSymbols = canonical(symbols).filter(symbol => !resolvedSymbols.includes(symbol));
    const definitionFiles = files.filter(file => resolvedSymbols.some(symbol => this.repositoryFiles[file].includes(symbol)));
    return {resolvedSymbols, unresolvedSymbols, definitionFiles};
  }

  resolveTestAnchors(anchors, inspectionFiles) {
    const files = canonical(inspectionFiles).filter(isTestFile);
    const resolvedTestAnchors = canonical(anchors).filter(anchor => files.some(file => this.repositoryFiles[file].includes(anchor)));
    const unresolvedTestAnchors = canonical(anchors).filter(anchor => !resolvedTestAnchors.includes(anchor));
    const anchorFiles = files.filter(file => resolvedTestAnchors.some(anchor => this.repositoryFiles[file].includes(anchor)));
    return {resolvedTestAnchors, unresolvedTestAnchors, anchorFiles};
  }

  getOneHopDependencies() {
    return [];
  }

  buildExcerpts(files, terms, options = {}) {
    return canonical(files).map(file => ({
      file,
      source: 'exact_repository_excerpt_generic_fallback',
      content: linesAroundMatches(
        this.repositoryFiles[file],
        terms,
        options.radius ?? 2,
        options.maxLinesPerFile ?? 40
      )
    }));
  }
}

function createLanguageResolver({repositoryFiles, candidateFiles, baseEvidenceFiles}) {
  const jsTs = new JavaScriptTypeScriptResolver(repositoryFiles, candidateFiles);
  const baseFiles = canonical(baseEvidenceFiles);
  if (baseFiles.length > 0 && baseFiles.every(file => jsTs.supports(file))) return jsTs;
  return new GenericTextResolver(repositoryFiles, candidateFiles);
}

function resolveEvidenceBoundary({
  repositoryFiles,
  candidateFiles,
  authority,
  candidateEvidence,
  keywords,
  taskClass,
  expansionPolicy
}) {
  if (taskClass !== 'small_bugfix_with_regression_test_selection/v1') {
    throw new Error(`unsupported_task_class:${taskClass}`);
  }
  if (expansionPolicy.maxRounds !== 1 || expansionPolicy.oneHopOnly !== true) {
    throw new Error('resolver_requires_one_hop_single_round_policy');
  }

  const existingFiles = new Set(Object.keys(repositoryFiles));
  const candidateUniverse = canonical(candidateFiles).filter(file => existingFiles.has(file));
  const immutableAllowedChangeFiles = canonical(authority.allowedChangeFiles);
  const baseEvidenceFiles = canonical(authority.baseEvidenceFiles).filter(file => existingFiles.has(file));
  const inspectionUniverse = canonical(authority.inspectionUniverse).filter(file => existingFiles.has(file));
  const forbiddenInspectionFiles = canonical(authority.forbiddenInspectionFiles);
  const resolver = createLanguageResolver({repositoryFiles, candidateFiles: candidateUniverse, baseEvidenceFiles});

  const proposedFiles = canonical(candidateEvidence.candidateFiles).filter(file => existingFiles.has(file));
  const proposedTestFiles = canonical(candidateEvidence.candidateTestFiles).filter(file => existingFiles.has(file));
  const rejectedCandidateFiles = proposedFiles.filter(file => !inspectionUniverse.includes(file));
  const rejectedCandidateTestFiles = proposedTestFiles.filter(file => !inspectionUniverse.includes(file));

  let evidenceFiles = canonical(baseEvidenceFiles);
  let symbolResolution = resolver.resolveSymbols(candidateEvidence.candidateSymbols, evidenceFiles);
  let anchorResolution = resolver.resolveTestAnchors(candidateEvidence.candidateTestAnchors, evidenceFiles);
  const expansionReasons = [];
  if (symbolResolution.unresolvedSymbols.length > 0) expansionReasons.push('unresolved_candidate_symbols');
  if (anchorResolution.unresolvedTestAnchors.length > 0) expansionReasons.push('unresolved_candidate_test_anchors');

  let expansionFiles = [];
  let expansionRoundCount = 0;
  if (expansionReasons.length > 0 && resolver.semantic && expansionPolicy.maxFiles > 0) {
    const expansionStarts = canonical([
      ...baseEvidenceFiles,
      ...symbolResolution.definitionFiles,
      ...anchorResolution.anchorFiles
    ]);
    expansionFiles = resolver.getOneHopDependencies(
      expansionStarts,
      inspectionUniverse.filter(file => !forbiddenInspectionFiles.includes(file)),
      expansionPolicy.maxFiles
    );
    if (expansionFiles.length > 0) {
      expansionRoundCount = 1;
      evidenceFiles = canonical([...evidenceFiles, ...expansionFiles]);
      symbolResolution = resolver.resolveSymbols(candidateEvidence.candidateSymbols, evidenceFiles);
      anchorResolution = resolver.resolveTestAnchors(candidateEvidence.candidateTestAnchors, evidenceFiles);
    }
  }

  const exactTerms = canonical([
    ...symbolResolution.resolvedSymbols,
    ...anchorResolution.resolvedTestAnchors,
    ...keywords
  ]);
  const excerpts = resolver.buildExcerpts(evidenceFiles, exactTerms, {
    radius: 3,
    maxLinesPerFile: 55
  });

  return {
    resolverKind: resolver.kind,
    semanticResolutionAvailable: resolver.semantic,
    genericFallbackUsed: !resolver.semantic,
    failClosed: true,
    taskClass,
    authority: {
      allowedChangeFiles: immutableAllowedChangeFiles,
      allowedChangeFilesHash: authority.allowedChangeFilesHash,
      authoritySource: authority.authoritySource,
      unchangedByCandidateEvidence: true,
      inspectionUniverse,
      forbiddenInspectionFiles
    },
    proposedFiles,
    proposedTestFiles,
    rejectedCandidateFiles,
    rejectedCandidateTestFiles,
    evidenceFiles,
    resolvedSymbols: symbolResolution.resolvedSymbols,
    unresolvedSymbols: symbolResolution.unresolvedSymbols,
    resolvedTestAnchors: anchorResolution.resolvedTestAnchors,
    unresolvedTestAnchors: anchorResolution.unresolvedTestAnchors,
    expansion: {
      oneHopOnly: true,
      maxRounds: 1,
      maxFiles: expansionPolicy.maxFiles,
      roundCount: expansionRoundCount,
      triggered: expansionRoundCount > 0,
      reasons: expansionReasons,
      files: expansionFiles,
      budgetRespected: expansionFiles.length <= expansionPolicy.maxFiles
    },
    excerpts
  };
}

module.exports = {
  JS_TS_EXTENSIONS,
  canonical,
  createLanguageResolver,
  isJavaScriptOrTypeScript,
  isTestFile,
  resolveEvidenceBoundary
};
