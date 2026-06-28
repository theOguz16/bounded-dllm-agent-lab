import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type RepoIntelligenceOptions = {
  rootDir: string;

  /**
   * PR/runtime changed files input'u.
   *
   * Verilirse repo intelligence tüm source dosyalarını changedFiles saymaz.
   * Sadece verilen dosyaları changedFiles olarak taşır ve ownership/module/sensitive
   * gibi fact'leri ilgili module root'lara göre daraltır.
   */
  changedFiles?: string[];

  maxFiles?: number;
  maxFileBytes?: number;
  includeExtensions?: string[];
  ignoreDirectories?: string[];
};

export type RepoOwnershipFact = {
  pathPrefix: string;
  owner: string;
  reason: string;
};

export type RepoPairedFileFact = {
  sourceFile: string;
  pairedFile: string;
  reason: string;
};

export type RepoRequiredTestMappingFact = {
  sourceFile: string;
  requiredTestFile: string;
  reason: string;
};

export type RepoModuleBoundaryFact = {
  module: string;
  pathPrefix: string;
  allowedInternalImports: string[];
  reason: string;
};

export type RepoSensitivePatternFact = {
  pattern: string;
  file: string;
  reason: string;
};

export type RepoStaleFact = {
  file: string;
  signal: string;
  reason: string;
};

export type RepoIntelligenceFacts = {
  changedFiles: string[];
  ownership: RepoOwnershipFact[];
  pairedFiles: RepoPairedFileFact[];
  requiredTests: string[];
  requiredTestMappings: RepoRequiredTestMappingFact[];
  moduleBoundaries: RepoModuleBoundaryFact[];
  sensitivePatterns: string[];
  staleFacts: string[];
};

export type RepoIntelligenceResult = {
  rootDir: string;
  scannedFileCount: number;
  skippedFileCount: number;
  scannedFiles: string[];
  facts: RepoIntelligenceFacts;
  diagnostics: string[];
};

const defaultIncludeExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml"
];

const defaultIgnoreDirectories = [
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "reports",
  ".vercel",
  ".expo",
  "benchmarks/repos"
];

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx"];

const testNameFragments = [
  ".test.",
  ".spec.",
  "-test.",
  "-spec."
];

/**
 * Repo Intelligence v2.
 *
 * v1:
 * - repo dosya ağacından lightweight repo facts üretir.
 *
 * v2:
 * - changedFiles input'u varsa PR/runtime davranışına yaklaşır.
 * - tüm source dosyalarını changedFiles gibi göstermeyi bırakır.
 * - ownership/module/sensitive/stale fact'leri changed file module root'larına göre daraltır.
 */
export async function analyzeRepository(
  options: RepoIntelligenceOptions
): Promise<RepoIntelligenceResult> {
  const maxFiles = options.maxFiles ?? 750;
  const maxFileBytes = options.maxFileBytes ?? 64_000;
  const includeExtensions = options.includeExtensions ?? defaultIncludeExtensions;
  const ignoreDirectories = options.ignoreDirectories ?? defaultIgnoreDirectories;
  const explicitChangedFiles = normalizeChangedFiles(options.changedFiles ?? []);

  const diagnostics: string[] = [];
  const scannedFiles = await collectRepoFiles({
    rootDir: options.rootDir,
    includeExtensions,
    ignoreDirectories,
    maxFiles,
    diagnostics
  });

  const scannedFileSet = new Set(scannedFiles);
  const sourceFiles = scannedFiles.filter(isSourceFile).filter((file) => !isTestFile(file));
  const testFiles = scannedFiles.filter(isTestFile);

  const effectiveChangedFiles =
    explicitChangedFiles.length > 0 ? explicitChangedFiles : sourceFiles;

  if (explicitChangedFiles.length > 0) {
    for (const file of explicitChangedFiles) {
      if (!scannedFileSet.has(file)) {
        diagnostics.push(
          `Changed file ${file} was not part of scanned files. It may be ignored, missing, generated, or outside includeExtensions.`
        );
      }
    }
  }

  const relevantFiles =
    explicitChangedFiles.length > 0
      ? filterRelevantFilesForChangedFiles(scannedFiles, effectiveChangedFiles)
      : scannedFiles;

  const contentSignals = await collectContentSignals({
    rootDir: options.rootDir,
    files: relevantFiles,
    maxFileBytes
  });

  const fileSet = new Set(scannedFiles);
  const changedSourceFiles = effectiveChangedFiles
    .filter(isSourceFile)
    .filter((file) => !isTestFile(file));

  const ownership = inferOwnership(effectiveChangedFiles);
  const pairedFiles = inferPairedFiles(changedSourceFiles, testFiles, fileSet);
  const requiredTestMappings = inferRequiredTestMappings(pairedFiles);
  const requiredTests = uniqueSorted(requiredTestMappings.map((item) => item.requiredTestFile));
  const moduleBoundaries = inferModuleBoundaries(relevantFiles);
  const sensitivePatterns = inferSensitivePatterns(relevantFiles, contentSignals);
  const staleFacts = inferStaleFacts(contentSignals);

  return {
    rootDir: options.rootDir,
    scannedFileCount: scannedFiles.length,
    skippedFileCount: diagnostics.length,
    scannedFiles,
    facts: {
      changedFiles: uniqueSorted(effectiveChangedFiles),
      ownership,
      pairedFiles,
      requiredTests,
      requiredTestMappings,
      moduleBoundaries,
      sensitivePatterns,
      staleFacts
    },
    diagnostics
  };
}

type CollectRepoFilesInput = {
  rootDir: string;
  includeExtensions: string[];
  ignoreDirectories: string[];
  maxFiles: number;
  diagnostics: string[];
};

async function collectRepoFiles(input: CollectRepoFilesInput): Promise<string[]> {
  const output: string[] = [];

  await walkDirectory(input.rootDir, input.rootDir, input, output);

  return uniqueSorted(output).slice(0, input.maxFiles);
}

async function walkDirectory(
  rootDir: string,
  currentDir: string,
  input: CollectRepoFilesInput,
  output: string[]
): Promise<void> {
  if (output.length >= input.maxFiles) {
    return;
  }

  let entryNames: string[];

  try {
    entryNames = await readdir(currentDir);
  } catch (error) {
    input.diagnostics.push(
      `Failed to read directory ${safeRelative(rootDir, currentDir)}: ${String(error)}`
    );
    return;
  }

  for (const entryName of entryNames) {
    if (output.length >= input.maxFiles) {
      return;
    }

    const absolutePath = join(currentDir, entryName);
    const relativePath = normalizePath(relative(rootDir, absolutePath));

    let entryStat: Awaited<ReturnType<typeof stat>>;

    try {
      entryStat = await stat(absolutePath);
    } catch (error) {
      input.diagnostics.push(`Failed to stat ${relativePath}: ${String(error)}`);
      continue;
    }

    if (entryStat.isDirectory()) {
      if (shouldIgnoreDirectory(entryName, relativePath, input.ignoreDirectories)) {
        continue;
      }

      await walkDirectory(rootDir, absolutePath, input, output);
      continue;
    }

    if (!entryStat.isFile()) {
      continue;
    }

    if (!input.includeExtensions.some((extension) => relativePath.endsWith(extension))) {
      continue;
    }

    output.push(relativePath);
  }
}

type ContentSignalInput = {
  rootDir: string;
  files: string[];
  maxFileBytes: number;
};

type FileContentSignal = {
  file: string;
  content: string;
};

async function collectContentSignals(input: ContentSignalInput): Promise<FileContentSignal[]> {
  const signals: FileContentSignal[] = [];

  for (const file of input.files) {
    const absolutePath = join(input.rootDir, file);

    try {
      const fileStat = await stat(absolutePath);

      if (fileStat.size > input.maxFileBytes) {
        continue;
      }

      const content = await readFile(absolutePath, "utf8");

      signals.push({
        file,
        content
      });
    } catch {
      /**
       * Repo intelligence için okunamayan dosya fatal değildir.
       * Dosya ağacı sinyali yine kullanılabilir.
       */
    }
  }

  return signals;
}

function inferOwnership(files: string[]): RepoOwnershipFact[] {
  const prefixes = new Set<string>();

  for (const file of files) {
    const parts = file.split("/");

    if (parts[0] === "packages" && parts[1]) {
      prefixes.add(`packages/${parts[1]}`);
      continue;
    }

    if (parts[0] === "apps" && parts[1]) {
      prefixes.add(`apps/${parts[1]}`);
      continue;
    }

    if (parts[0]) {
      prefixes.add(parts[0]);
    }
  }

  return uniqueSorted([...prefixes]).map((pathPrefix) => ({
    pathPrefix,
    owner: inferOwnerFromPathPrefix(pathPrefix),
    reason: "Fallback owner inferred from changed file or top-level repo module path."
  }));
}

function inferPairedFiles(
  sourceFiles: string[],
  testFiles: string[],
  fileSet: Set<string>
): RepoPairedFileFact[] {
  const paired: RepoPairedFileFact[] = [];

  for (const sourceFile of sourceFiles) {
    const candidates = createTestCandidates(sourceFile, testFiles);

    for (const candidate of candidates) {
      if (!fileSet.has(candidate)) {
        continue;
      }

      paired.push({
        sourceFile,
        pairedFile: candidate,
        reason: "Matched source file to nearby test/spec naming convention inside the same module root."
      });

      break;
    }
  }

  return paired;
}

function inferRequiredTestMappings(
  pairedFiles: RepoPairedFileFact[]
): RepoRequiredTestMappingFact[] {
  return pairedFiles.map((pair) => ({
    sourceFile: pair.sourceFile,
    requiredTestFile: pair.pairedFile,
    reason: "Source file has a deterministic paired test file."
  }));
}

function inferModuleBoundaries(files: string[]): RepoModuleBoundaryFact[] {
  const modules = new Set<string>();

  for (const file of files) {
    const parts = file.split("/");

    if (parts[0] === "packages" && parts[1]) {
      modules.add(`packages/${parts[1]}`);
    }

    if (parts[0] === "apps" && parts[1]) {
      modules.add(`apps/${parts[1]}`);
    }
  }

  return uniqueSorted([...modules]).map((modulePath) => ({
    module: modulePath.split("/").at(-1) ?? modulePath,
    pathPrefix: modulePath,
    allowedInternalImports: [modulePath],
    reason: "Module boundary inferred from apps/* or packages/* workspace layout."
  }));
}

function inferSensitivePatterns(
  files: string[],
  contentSignals: FileContentSignal[]
): string[] {
  const patterns: RepoSensitivePatternFact[] = [];

  for (const file of files) {
    const lower = file.toLowerCase();

    if (lower.includes(".env")) {
      patterns.push({
        pattern: "env-file",
        file,
        reason: "Environment file path may contain secrets and should be masked."
      });
    }

    if (lower.includes("secret") || lower.includes("token") || lower.includes("credential")) {
      patterns.push({
        pattern: "sensitive-filename",
        file,
        reason: "Filename contains secret/token/credential indicator."
      });
    }
  }

  for (const signal of contentSignals) {
    const lower = signal.content.toLowerCase();

    if (lower.includes("api_key") || lower.includes("apikey") || lower.includes("api key")) {
      patterns.push({
        pattern: "api-key-reference",
        file: signal.file,
        reason: "File content references API key naming."
      });
    }

    if (lower.includes("secret") || lower.includes("access_token") || lower.includes("refresh_token")) {
      patterns.push({
        pattern: "secret-token-reference",
        file: signal.file,
        reason: "File content references secret or token naming."
      });
    }

    if (lower.includes("password")) {
      patterns.push({
        pattern: "password-reference",
        file: signal.file,
        reason: "File content references password naming."
      });
    }
  }

  return compactSensitivePatterns(patterns);
}

function inferStaleFacts(contentSignals: FileContentSignal[]): string[] {
  const staleFacts: RepoStaleFact[] = [];

  for (const signal of contentSignals) {
    const lower = signal.content.toLowerCase();

    if (lower.includes("deprecated")) {
      staleFacts.push({
        file: signal.file,
        signal: "deprecated",
        reason: "File content contains deprecated marker."
      });
    }

    if (lower.includes("legacy")) {
      staleFacts.push({
        file: signal.file,
        signal: "legacy",
        reason: "File content contains legacy marker."
      });
    }

    if (lower.includes("todo: remove") || lower.includes("remove later")) {
      staleFacts.push({
        file: signal.file,
        signal: "remove-later",
        reason: "File content contains removal/deprecation todo marker."
      });
    }
  }

  return uniqueSorted(
    staleFacts.map(
      (fact) => `${fact.signal} signal in ${fact.file}: ${fact.reason}`
    )
  );
}

function createTestCandidates(sourceFile: string, knownTestFiles: string[]): string[] {
  const candidates = new Set<string>();
  const extension = getExtension(sourceFile);

  if (!extension) {
    return [];
  }

  const withoutExtension = sourceFile.slice(0, -extension.length);

  candidates.add(`${withoutExtension}.test${extension}`);
  candidates.add(`${withoutExtension}.spec${extension}`);

  if (sourceFile.includes("/src/")) {
    candidates.add(sourceFile.replace("/src/", "/test/").replace(extension, `.test${extension}`));
    candidates.add(sourceFile.replace("/src/", "/tests/").replace(extension, `.test${extension}`));
    candidates.add(sourceFile.replace("/src/", "/__tests__/").replace(extension, `.test${extension}`));

    candidates.add(sourceFile.replace("/src/", "/test/").replace(extension, `.spec${extension}`));
    candidates.add(sourceFile.replace("/src/", "/tests/").replace(extension, `.spec${extension}`));
    candidates.add(sourceFile.replace("/src/", "/__tests__/").replace(extension, `.spec${extension}`));
  }

  for (const testFile of knownTestFiles) {
    if (isLikelyTestForSource(sourceFile, testFile)) {
      candidates.add(testFile);
    }
  }

  return [...candidates];
}

function isLikelyTestForSource(sourceFile: string, testFile: string): boolean {
  if (getModuleRoot(sourceFile) !== getModuleRoot(testFile)) {
    return false;
  }

  const sourceBase = getBasenameWithoutExtension(sourceFile);
  const testBase = getBasenameWithoutExtension(testFile)
    .replace(/\.test$/, "")
    .replace(/\.spec$/, "");

  if (sourceBase !== testBase) {
    return false;
  }

  return (
    testFile.includes("/test/") ||
    testFile.includes("/tests/") ||
    testFile.includes("/__tests__/") ||
    testFile.includes(".test.") ||
    testFile.includes(".spec.")
  );
}

function filterRelevantFilesForChangedFiles(
  scannedFiles: string[],
  changedFiles: string[]
): string[] {
  const changedSet = new Set(changedFiles);
  const changedModuleRoots = new Set(
    changedFiles.map(getModuleRoot).filter((root) => root.length > 0)
  );

  return scannedFiles.filter((file) => {
    if (changedSet.has(file)) {
      return true;
    }

    const moduleRoot = getModuleRoot(file);

    return moduleRoot.length > 0 && changedModuleRoots.has(moduleRoot);
  });
}

function normalizeChangedFiles(files: string[]): string[] {
  return uniqueSorted(
    files
      .map((file) => file.trim())
      .filter((file) => file.length > 0)
      .map((file) => file.replace(/\\/g, "/"))
      .map((file) => file.replace(/^\.\//, ""))
  );
}

function compactSensitivePatterns(patterns: RepoSensitivePatternFact[]): string[] {
  const compacted = patterns.map(
    (item) => `${item.pattern} in ${item.file}: ${item.reason}`
  );

  return uniqueSorted(compacted);
}

function inferOwnerFromPathPrefix(pathPrefix: string): string {
  if (pathPrefix.startsWith("packages/")) {
    return `team:${pathPrefix.replace("/", "-")}`;
  }

  if (pathPrefix.startsWith("apps/")) {
    return `team:${pathPrefix.replace("/", "-")}`;
  }

  return `team:${pathPrefix}`;
}

function shouldIgnoreDirectory(
  name: string,
  relativePath: string,
  ignoreDirectories: string[]
): boolean {
  return ignoreDirectories.some(
    (ignored) =>
      name === ignored ||
      relativePath === ignored ||
      relativePath.startsWith(`${ignored}/`)
  );
}

function isSourceFile(file: string): boolean {
  return sourceExtensions.some((extension) => file.endsWith(extension));
}

function isTestFile(file: string): boolean {
  return testNameFragments.some((fragment) => file.includes(fragment));
}

function getModuleRoot(file: string): string {
  const parts = file.split("/");

  if ((parts[0] === "packages" || parts[0] === "apps") && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }

  if (parts[0] === "benchmarks" && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0] ?? "";
}

function getBasenameWithoutExtension(file: string): string {
  const basename = file.split("/").at(-1) ?? file;
  const extension = getExtension(basename);

  if (!extension) {
    return basename;
  }

  return basename.slice(0, -extension.length);
}

function getExtension(file: string): string {
  const index = file.lastIndexOf(".");

  if (index === -1) {
    return "";
  }

  return file.slice(index);
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function safeRelative(rootDir: string, path: string): string {
  const value = normalizePath(relative(rootDir, path));
  return value.length > 0 ? value : ".";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}