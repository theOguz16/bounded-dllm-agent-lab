import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { hashCanonicalJson } from "./agent-event-ledger.js";

export const CANONICAL_REPO_INTELLIGENCE_VERSION = "1" as const;

export type CanonicalRepoIntelligenceDecision =
  | "repo_intelligence_ready"
  | "repo_intelligence_blocked"
  | "repo_intelligence_invalid";

export type CanonicalRepoIntelligenceInput = {
  repositoryPath: string;
  seedFiles: readonly string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDependencyDepth?: number;
  maxEdges?: number;
};

export type CanonicalRepoIntelligenceIssue = {
  code: string;
  message: string;
  severity: "error" | "review";
  field?: string;
  filePath?: string;
  specifier?: string;
};

export type CanonicalRepoSymbolKind =
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "namespace"
  | "type"
  | "variable";

export type CanonicalRepoSymbol = {
  name: string;
  kind: CanonicalRepoSymbolKind;
  exported: boolean;
};

export type CanonicalRepoDependencyEdge = {
  from: string;
  to: string;
  specifier: string;
  kind: "dynamic_import" | "import" | "require" | "reexport";
};

export type CanonicalRepoUnresolvedImport = {
  from: string;
  specifier: string;
  reason: "outside_repository" | "target_not_found";
};

export type CanonicalRepoFileFact = {
  path: string;
  language: "javascript" | "json" | "typescript";
  bytes: number;
  contentHash: string;
  imports: readonly string[];
  externalDependencies: readonly string[];
  exports: readonly string[];
  symbols: readonly CanonicalRepoSymbol[];
};

export type CanonicalRepoIntelligence = {
  intelligenceVersion: "1";
  repositoryIdentityHash: string;
  seedFiles: readonly string[];
  scannedFiles: readonly CanonicalRepoFileFact[];
  dependencyEdges: readonly CanonicalRepoDependencyEdge[];
  dependencyClosure: readonly string[];
  unresolvedRelativeImports: readonly CanonicalRepoUnresolvedImport[];
  totalBytes: number;
  intelligenceHash: string;
};

export type CanonicalRepoIntelligenceResult = {
  decision: CanonicalRepoIntelligenceDecision;
  issues: readonly CanonicalRepoIntelligenceIssue[];
  intelligence: CanonicalRepoIntelligence | null;
  summary: {
    repositoryRecognized: boolean;
    seedFilesValid: boolean;
    scannedFileCount: number;
    parsedSourceFileCount: number;
    dependencyEdgeCount: number;
    dependencyClosureCount: number;
    unresolvedRelativeImportCount: number;
    totalBytesRead: number;
    fileLimitReached: boolean;
    byteLimitReached: boolean;
    edgeLimitReached: boolean;
    dependencyDepthLimitReached: boolean;
    symlinkEncountered: boolean;
    repositoryWritePerformed: false;
    shellExecuted: false;
    networkAccessed: false;
  };
};

type Summary = CanonicalRepoIntelligenceResult["summary"];
type Issue = CanonicalRepoIntelligenceIssue;
type PlainRecord = Record<string, unknown>;
type Limits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDependencyDepth: number;
  maxEdges: number;
};
type LoadedFile = {
  path: string;
  content: string;
  bytes: number;
  contentHash: string;
};
type ModuleReference = {
  specifier: string;
  kind: CanonicalRepoDependencyEdge["kind"];
};
type ParsedFile = {
  fact: CanonicalRepoFileFact;
  references: readonly ModuleReference[];
};

const DEFAULT_LIMITS: Limits = {
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDependencyDepth: 12,
  maxEdges: 50_000
};
const HARD_LIMITS: Limits = {
  maxFiles: 20_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDependencyDepth: 64,
  maxEdges: 250_000
};
const INPUT_FIELDS = new Set([
  "repositoryPath",
  "seedFiles",
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxDependencyDepth",
  "maxEdges"
]);
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
] as const;
const DISCOVERABLE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".json"] as const;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  ".expo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "reports"
]);
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^(?:\\\\|\/\/)/;
const MAX_PATH_LENGTH = 4_096;

class RepoIntelligenceFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly decision: "blocked" | "invalid",
    readonly field?: string,
    readonly filePath?: string,
    readonly specifier?: string
  ) {
    super(message);
  }
}

function initialSummary(): Summary {
  return {
    repositoryRecognized: false,
    seedFilesValid: false,
    scannedFileCount: 0,
    parsedSourceFileCount: 0,
    dependencyEdgeCount: 0,
    dependencyClosureCount: 0,
    unresolvedRelativeImportCount: 0,
    totalBytesRead: 0,
    fileLimitReached: false,
    byteLimitReached: false,
    edgeLimitReached: false,
    dependencyDepthLimitReached: false,
    symlinkEncountered: false,
    repositoryWritePerformed: false,
    shellExecuted: false,
    networkAccessed: false
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finish(
  decision: CanonicalRepoIntelligenceDecision,
  issues: Issue[],
  intelligence: CanonicalRepoIntelligence | null,
  summary: Summary
): CanonicalRepoIntelligenceResult {
  return deepFreeze({ decision, issues, intelligence, summary });
}

function issueFromFailure(error: RepoIntelligenceFailure): Issue {
  return {
    code: error.code,
    message: error.message,
    severity: "error",
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.filePath === undefined ? {} : { filePath: error.filePath }),
    ...(error.specifier === undefined ? {} : { specifier: error.specifier })
  };
}

function exactPlainObject(value: unknown): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RepoIntelligenceFailure(
      "invalid_repo_intelligence_input",
      "Repository intelligence input must be a plain object.",
      "invalid"
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RepoIntelligenceFailure(
      "invalid_repo_intelligence_object",
      "Repository intelligence input must not be a class instance or exotic object.",
      "invalid"
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RepoIntelligenceFailure(
      "repo_intelligence_symbol_property",
      "Repository intelligence input must not contain symbol properties.",
      "invalid"
    );
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new RepoIntelligenceFailure(
        "repo_intelligence_accessor_property",
        "Repository intelligence input must not contain accessor properties.",
        "invalid",
        key
      );
    }
    if (!INPUT_FIELDS.has(key)) {
      throw new RepoIntelligenceFailure(
        "unknown_repo_intelligence_field",
        "Repository intelligence input contains an unknown field.",
        "invalid",
        key
      );
    }
  }
  return value as PlainRecord;
}

function requiredField(record: PlainRecord, field: string): unknown {
  if (!Object.hasOwn(record, field)) {
    throw new RepoIntelligenceFailure(
      "missing_repo_intelligence_field",
      "Repository intelligence input is missing a required field.",
      "invalid",
      field
    );
  }
  return record[field];
}

function numericLimit(
  record: PlainRecord,
  field: keyof Limits,
  minimum: number
): number {
  const defaultValue = DEFAULT_LIMITS[field];
  if (!Object.hasOwn(record, field)) return defaultValue;
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > HARD_LIMITS[field]
  ) {
    throw new RepoIntelligenceFailure(
      "invalid_repo_intelligence_limit",
      `${field} must be a safe integer between ${minimum} and ${HARD_LIMITS[field]}.`,
      "invalid",
      field
    );
  }
  return value;
}

function validateRepositoryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value)
  ) {
    throw new RepoIntelligenceFailure(
      "repository_path_invalid",
      "The configured repository path is invalid.",
      "invalid",
      "repositoryPath"
    );
  }
  return path.resolve(value);
}

function normalizeRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.trim() !== value ||
    ASCII_CONTROL.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    WINDOWS_DRIVE.test(value) ||
    UNC.test(value)
  ) {
    throw new RepoIntelligenceFailure(
      "seed_file_invalid",
      "Seed files must be normalized repository-relative paths.",
      "invalid",
      field
    );
  }
  const normalized = value.replaceAll("\\", "/");
  const canonical = path.posix.normalize(normalized);
  if (
    canonical === "." ||
    canonical.startsWith("../") ||
    canonical.includes("/../") ||
    canonical !== normalized
  ) {
    throw new RepoIntelligenceFailure(
      "seed_file_outside_repository",
      "Seed files must not escape or alias the repository root.",
      "invalid",
      field,
      value
    );
  }
  return canonical;
}

function validateSeedFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new RepoIntelligenceFailure(
      "seed_files_invalid",
      "seedFiles must be a non-empty array with at most 1000 entries.",
      "invalid",
      "seedFiles"
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RepoIntelligenceFailure(
      "seed_files_symbol_property",
      "seedFiles must not contain symbol properties.",
      "invalid",
      "seedFiles"
    );
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || !("value" in descriptor)) {
      throw new RepoIntelligenceFailure(
        "seed_files_exotic_property",
        "seedFiles must be a dense data-only array.",
        "invalid",
        "seedFiles"
      );
    }
  }
  return uniqueSorted(value.map((item, index) => normalizeRelativePath(item, `seedFiles[${index}]`)));
}

function parseInput(value: unknown): {
  repositoryPath: string;
  seedFiles: string[];
  limits: Limits;
} {
  const record = exactPlainObject(value);
  return {
    repositoryPath: validateRepositoryPath(requiredField(record, "repositoryPath")),
    seedFiles: validateSeedFiles(requiredField(record, "seedFiles")),
    limits: {
      maxFiles: numericLimit(record, "maxFiles", 1),
      maxFileBytes: numericLimit(record, "maxFileBytes", 1),
      maxTotalBytes: numericLimit(record, "maxTotalBytes", 1),
      maxDependencyDepth: numericLimit(record, "maxDependencyDepth", 0),
      maxEdges: numericLimit(record, "maxEdges", 1)
    }
  };
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isDiscoverableFile(filePath: string): boolean {
  return DISCOVERABLE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

async function collectRepositoryFiles(
  root: string,
  limits: Limits,
  summary: Summary
): Promise<string[]> {
  const output: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      throw new RepoIntelligenceFailure(
        "repository_directory_unreadable",
        "A repository directory could not be read.",
        "blocked",
        undefined,
        normalizePath(path.relative(root, current)) || "."
      );
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = normalizePath(path.relative(root, absolute));

      if (entry.isSymbolicLink()) {
        summary.symlinkEncountered = true;
        throw new RepoIntelligenceFailure(
          "repository_symlink_rejected",
          "Repository intelligence never follows symlinks.",
          "blocked",
          undefined,
          relative
        );
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isDiscoverableFile(relative)) continue;
      if (output.length >= limits.maxFiles) {
        summary.fileLimitReached = true;
        throw new RepoIntelligenceFailure(
          "repository_file_limit_exceeded",
          "Repository file discovery exceeded the configured hard limit.",
          "blocked",
          "maxFiles"
        );
      }
      output.push(relative);
    }
  }

  await walk(root);
  return output;
}

async function loadFiles(
  root: string,
  files: readonly string[],
  limits: Limits,
  summary: Summary
): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const absolute = path.join(root, ...file.split("/"));
    let before;
    try {
      before = await lstat(absolute);
    } catch {
      throw new RepoIntelligenceFailure(
        "repository_file_unreadable",
        "A discovered repository file could not be inspected.",
        "blocked",
        undefined,
        file
      );
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      summary.symlinkEncountered ||= before.isSymbolicLink();
      throw new RepoIntelligenceFailure(
        "repository_file_not_regular",
        "A discovered repository entry is not a regular file.",
        "blocked",
        undefined,
        file
      );
    }
    if (before.size > limits.maxFileBytes) {
      summary.byteLimitReached = true;
      throw new RepoIntelligenceFailure(
        "repository_file_byte_limit_exceeded",
        "A repository file exceeds maxFileBytes.",
        "blocked",
        "maxFileBytes",
        file
      );
    }
    if (totalBytes + before.size > limits.maxTotalBytes) {
      summary.byteLimitReached = true;
      throw new RepoIntelligenceFailure(
        "repository_total_byte_limit_exceeded",
        "Repository reads would exceed maxTotalBytes.",
        "blocked",
        "maxTotalBytes",
        file
      );
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      throw new RepoIntelligenceFailure(
        "repository_file_unreadable",
        "A repository file could not be read.",
        "blocked",
        undefined,
        file
      );
    }
    const after = await lstat(absolute);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      buffer.byteLength !== after.size
    ) {
      throw new RepoIntelligenceFailure(
        "repository_file_changed_during_read",
        "A repository file changed while intelligence was being collected.",
        "blocked",
        undefined,
        file
      );
    }

    totalBytes += buffer.byteLength;
    loaded.push({
      path: file,
      content: buffer.toString("utf8"),
      bytes: buffer.byteLength,
      contentHash: `sha256:${createHash("sha256").update(buffer).digest("hex")}`
    });
  }

  summary.totalBytesRead = totalBytes;
  return loaded;
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function languageFor(filePath: string): CanonicalRepoFileFact["language"] {
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return "javascript";
  }
  return "typescript";
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function isExported(node: ts.Node): boolean {
  return modifiersOf(node).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword ||
      modifier.kind === ts.SyntaxKind.DefaultKeyword
  );
}

function isDefaultExport(node: ts.Node): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

function collectTopLevelSymbols(sourceFile: ts.SourceFile): CanonicalRepoSymbol[] {
  const symbols: CanonicalRepoSymbol[] = [];
  const push = (name: string, kind: CanonicalRepoSymbolKind, exported: boolean): void => {
    symbols.push({ name, kind, exported });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      push(statement.name.text, "class", isExported(statement));
    } else if (ts.isEnumDeclaration(statement)) {
      push(statement.name.text, "enum", isExported(statement));
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      push(statement.name.text, "function", isExported(statement));
    } else if (ts.isInterfaceDeclaration(statement)) {
      push(statement.name.text, "interface", isExported(statement));
    } else if (ts.isModuleDeclaration(statement)) {
      push(statement.name.getText(sourceFile), "namespace", isExported(statement));
    } else if (ts.isTypeAliasDeclaration(statement)) {
      push(statement.name.text, "type", isExported(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          push(name, "variable", isExported(statement));
        }
      }
    }
  }

  return symbols.sort((left, right) =>
    `${left.name}:${left.kind}:${left.exported}`.localeCompare(
      `${right.name}:${right.kind}:${right.exported}`
    )
  );
}

function collectExports(sourceFile: ts.SourceFile, symbols: readonly CanonicalRepoSymbol[]): string[] {
  const names = new Set(symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name));
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) || isDefaultExport(statement)) names.add("default");
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else if (!statement.exportClause) {
        names.add("*");
      }
    }
  }
  return uniqueSorted([...names]);
}

function collectModuleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const add = (specifier: string, kind: ModuleReference["kind"]): void => {
    references.push({ specifier, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, "import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, "reexport");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, "import");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0]!.text, "dynamic_import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0]!.text, "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const unique = new Map<string, ModuleReference>();
  for (const reference of references) {
    unique.set(`${reference.kind}\u0000${reference.specifier}`, reference);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.kind}:${left.specifier}`.localeCompare(`${right.kind}:${right.specifier}`)
  );
}

function parseLoadedFile(file: LoadedFile): ParsedFile {
  if (!isSourceFile(file.path)) {
    return {
      fact: {
        path: file.path,
        language: "json",
        bytes: file.bytes,
        contentHash: file.contentHash,
        imports: [],
        externalDependencies: [],
        exports: [],
        symbols: []
      },
      references: []
    };
  }
  const sourceFile = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(file.path)
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new RepoIntelligenceFailure(
      "source_parse_failed",
      `A source file could not be parsed: ${ts.flattenDiagnosticMessageText(parseDiagnostics[0]!.messageText, " ")}`,
      "blocked",
      undefined,
      file.path
    );
  }
  const symbols = collectTopLevelSymbols(sourceFile);
  const references = collectModuleReferences(sourceFile);
  return {
    fact: {
      path: file.path,
      language: languageFor(file.path),
      bytes: file.bytes,
      contentHash: file.contentHash,
      imports: uniqueSorted(references.map((reference) => reference.specifier)),
      externalDependencies: uniqueSorted(
        references
          .map((reference) => reference.specifier)
          .filter((specifier) => !specifier.startsWith("."))
      ),
      exports: collectExports(sourceFile, symbols),
      symbols
    },
    references
  };
}

function resolutionCandidates(from: string, specifier: string): string[] {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined)) return [];
  const candidates = new Set<string>([joined]);
  const extensionMap: Record<string, readonly string[]> = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".jsx": [".tsx", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"]
  };
  const extension = path.posix.extname(joined);
  if (extensionMap[extension]) {
    const stem = joined.slice(0, -extension.length);
    for (const mapped of extensionMap[extension]) candidates.add(`${stem}${mapped}`);
  }
  if (extension.length === 0) {
    for (const candidateExtension of DISCOVERABLE_EXTENSIONS) {
      candidates.add(`${joined}${candidateExtension}`);
      candidates.add(`${joined}/index${candidateExtension}`);
    }
  }
  return [...candidates];
}

function buildGraph(
  parsedFiles: readonly ParsedFile[],
  fileSet: ReadonlySet<string>,
  limits: Limits,
  summary: Summary
): {
  edges: CanonicalRepoDependencyEdge[];
  unresolved: CanonicalRepoUnresolvedImport[];
} {
  const edges: CanonicalRepoDependencyEdge[] = [];
  const unresolved: CanonicalRepoUnresolvedImport[] = [];

  for (const parsed of parsedFiles) {
    for (const reference of parsed.references) {
      if (!reference.specifier.startsWith(".")) continue;
      const candidates = resolutionCandidates(parsed.fact.path, reference.specifier);
      if (candidates.length === 0) {
        unresolved.push({
          from: parsed.fact.path,
          specifier: reference.specifier,
          reason: "outside_repository"
        });
        continue;
      }
      const target = candidates.find((candidate) => fileSet.has(candidate));
      if (!target) {
        unresolved.push({
          from: parsed.fact.path,
          specifier: reference.specifier,
          reason: "target_not_found"
        });
        continue;
      }
      if (edges.length >= limits.maxEdges) {
        summary.edgeLimitReached = true;
        throw new RepoIntelligenceFailure(
          "repository_edge_limit_exceeded",
          "The dependency graph exceeded maxEdges.",
          "blocked",
          "maxEdges",
          parsed.fact.path,
          reference.specifier
        );
      }
      edges.push({
        from: parsed.fact.path,
        to: target,
        specifier: reference.specifier,
        kind: reference.kind
      });
    }
  }

  return {
    edges: edges.sort((left, right) =>
      `${left.from}:${left.to}:${left.kind}:${left.specifier}`.localeCompare(
        `${right.from}:${right.to}:${right.kind}:${right.specifier}`
      )
    ),
    unresolved: unresolved.sort((left, right) =>
      `${left.from}:${left.specifier}:${left.reason}`.localeCompare(
        `${right.from}:${right.specifier}:${right.reason}`
      )
    )
  };
}

function buildDependencyClosure(
  seedFiles: readonly string[],
  edges: readonly CanonicalRepoDependencyEdge[],
  maxDepth: number,
  summary: Summary
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const current = adjacency.get(edge.from) ?? [];
    current.push(edge.to);
    adjacency.set(edge.from, current);
  }
  for (const targets of adjacency.values()) targets.sort();

  const visited = new Set(seedFiles);
  const queue = seedFiles.map((file) => ({ file, depth: 0 }));
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const targets = adjacency.get(current.file) ?? [];
    for (const target of targets) {
      if (visited.has(target)) continue;
      if (current.depth >= maxDepth) {
        summary.dependencyDepthLimitReached = true;
        throw new RepoIntelligenceFailure(
          "dependency_depth_limit_exceeded",
          "A seed dependency closure exceeds maxDependencyDepth.",
          "blocked",
          "maxDependencyDepth",
          current.file
        );
      }
      visited.add(target);
      queue.push({ file: target, depth: current.depth + 1 });
    }
  }
  return uniqueSorted([...visited]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function intelligenceMaterial(
  value: Omit<CanonicalRepoIntelligence, "intelligenceHash">
): Record<string, unknown> {
  return {
    intelligenceVersion: value.intelligenceVersion,
    repositoryIdentityHash: value.repositoryIdentityHash,
    seedFiles: value.seedFiles,
    scannedFiles: value.scannedFiles,
    dependencyEdges: value.dependencyEdges,
    dependencyClosure: value.dependencyClosure,
    unresolvedRelativeImports: value.unresolvedRelativeImports,
    totalBytes: value.totalBytes
  };
}

function buildIntelligence(
  repositoryIdentityHash: string,
  seedFiles: readonly string[],
  parsedFiles: readonly ParsedFile[],
  edges: readonly CanonicalRepoDependencyEdge[],
  closure: readonly string[],
  unresolved: readonly CanonicalRepoUnresolvedImport[],
  totalBytes: number
): CanonicalRepoIntelligence {
  const withoutHash: Omit<CanonicalRepoIntelligence, "intelligenceHash"> = {
    intelligenceVersion: CANONICAL_REPO_INTELLIGENCE_VERSION,
    repositoryIdentityHash,
    seedFiles,
    scannedFiles: parsedFiles.map((parsed) => parsed.fact),
    dependencyEdges: edges,
    dependencyClosure: closure,
    unresolvedRelativeImports: unresolved,
    totalBytes
  };
  return {
    ...withoutHash,
    intelligenceHash: hashCanonicalJson(intelligenceMaterial(withoutHash))
  };
}

export function verifyCanonicalRepoIntelligence(
  intelligence: CanonicalRepoIntelligence
): boolean {
  try {
    if (intelligence.intelligenceVersion !== CANONICAL_REPO_INTELLIGENCE_VERSION) return false;
    const { intelligenceHash, ...withoutHash } = intelligence;
    return intelligenceHash === hashCanonicalJson(intelligenceMaterial(withoutHash));
  } catch {
    return false;
  }
}

export async function analyzeCanonicalRepository(
  input: CanonicalRepoIntelligenceInput
): Promise<CanonicalRepoIntelligenceResult> {
  const summary = initialSummary();
  const issues: Issue[] = [];

  try {
    const parsedInput = parseInput(input);
    const rootStat = await lstat(parsedInput.repositoryPath).catch(() => null);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      summary.symlinkEncountered = rootStat?.isSymbolicLink() ?? false;
      throw new RepoIntelligenceFailure(
        "repository_root_invalid",
        "repositoryPath must identify a real directory and must not be a symlink.",
        "blocked",
        "repositoryPath"
      );
    }
    const root = await realpath(parsedInput.repositoryPath);
    summary.repositoryRecognized = true;
    const files = await collectRepositoryFiles(root, parsedInput.limits, summary);
    summary.scannedFileCount = files.length;
    const fileSet = new Set(files);
    for (const seed of parsedInput.seedFiles) {
      if (!fileSet.has(seed) || !isSourceFile(seed)) {
        throw new RepoIntelligenceFailure(
          "seed_file_not_found",
          "Every seed file must be a discovered TypeScript or JavaScript source file.",
          "blocked",
          "seedFiles",
          seed
        );
      }
    }
    summary.seedFilesValid = true;

    const loadedFiles = await loadFiles(root, files, parsedInput.limits, summary);
    const parsedFiles = loadedFiles.map(parseLoadedFile);
    summary.parsedSourceFileCount = parsedFiles.filter((file) => isSourceFile(file.fact.path)).length;
    const graph = buildGraph(parsedFiles, fileSet, parsedInput.limits, summary);
    summary.dependencyEdgeCount = graph.edges.length;
    const closure = buildDependencyClosure(
      parsedInput.seedFiles,
      graph.edges,
      parsedInput.limits.maxDependencyDepth,
      summary
    );
    summary.dependencyClosureCount = closure.length;
    const closureSet = new Set(closure);
    const reachableUnresolved = graph.unresolved.filter((item) => closureSet.has(item.from));
    summary.unresolvedRelativeImportCount = reachableUnresolved.length;

    const repositoryIdentityHash = `sha256:${createHash("sha256").update(root, "utf8").digest("hex")}`;
    const intelligence = buildIntelligence(
      repositoryIdentityHash,
      parsedInput.seedFiles,
      parsedFiles,
      graph.edges,
      closure,
      graph.unresolved,
      summary.totalBytesRead
    );

    if (reachableUnresolved.length > 0) {
      issues.push(
        ...reachableUnresolved.map((item) => ({
          code: "reachable_relative_import_unresolved",
          message: "A relative import reachable from a seed file could not be resolved.",
          severity: "error" as const,
          filePath: item.from,
          specifier: item.specifier
        }))
      );
      return finish("repo_intelligence_blocked", issues, intelligence, summary);
    }

    return finish("repo_intelligence_ready", issues, intelligence, summary);
  } catch (error) {
    if (error instanceof RepoIntelligenceFailure) {
      issues.push(issueFromFailure(error));
      return finish(
        error.decision === "invalid" ? "repo_intelligence_invalid" : "repo_intelligence_blocked",
        issues,
        null,
        summary
      );
    }
    issues.push({
      code: "repo_intelligence_internal_failure",
      message: "Repository intelligence failed closed after an unexpected error.",
      severity: "error"
    });
    return finish("repo_intelligence_blocked", issues, null, summary);
  }
}
