"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { validateGate6Task } = require("./gate6-task-schema.cjs");
const { getGate6TaskClass } = require("./gate6-task-classes.cjs");

const CONTEXT_STRATEGY_VERSION = "gate6-context-strategies/v1";
const REPOSITORY_SNAPSHOT_VERSION = "gate6-repository-snapshot/v1";
const STRATEGIES = Object.freeze([
  "C_synthetic_context",
  "E_bounded_workspace_boundary",
  "F_adaptive_compressed_boundary",
  "CE_escalating_context"
]);
const SNAPSHOT_FIELDS = Object.freeze(["schemaVersion", "repositoryId", "commitSha", "files"]);
const SNAPSHOT_FILE_FIELDS = Object.freeze(["path", "content"]);
const SHA40 = /^[0-9a-f]{40}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b/;
const METHOD = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const RESERVED_METHOD_NAMES = new Set(["if", "for", "while", "switch", "catch", "function"]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "without", "should", "task",
  "change", "file", "files", "behavior", "relevant", "implementation", "test", "tests", "public"
]);

class Gate6ContextStrategyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6ContextStrategyError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6ContextStrategyError(code, detail);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonical(value) {
  return hashText(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertSafePath(value, detail) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
    path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || WINDOWS_DRIVE.test(value)
  ) fail("GATE6_CONTEXT_SNAPSHOT_PATH_INVALID", detail);

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("GATE6_CONTEXT_SNAPSHOT_PATH_INVALID", detail);
  }
  return value;
}

function ruleMatchesPath(rule, candidatePath) {
  if (rule.endsWith("/**")) {
    const root = rule.slice(0, -3);
    return candidatePath === root || candidatePath.startsWith(`${root}/`);
  }
  return candidatePath === rule;
}

function canInspect(task, candidatePath) {
  return task.authority.allowedInspectionPaths.some((rule) => ruleMatchesPath(rule, candidatePath)) &&
    !task.authority.forbiddenInspectionPaths.some((rule) => ruleMatchesPath(rule, candidatePath));
}

function validateSnapshot(task, snapshot) {
  if (!sameKeys(snapshot, SNAPSHOT_FIELDS)) fail("GATE6_CONTEXT_SNAPSHOT_INVALID");
  if (snapshot.schemaVersion !== REPOSITORY_SNAPSHOT_VERSION) {
    fail("GATE6_CONTEXT_SNAPSHOT_SCHEMA_UNSUPPORTED", String(snapshot.schemaVersion));
  }
  if (snapshot.repositoryId !== task.repositoryId) {
    fail("GATE6_CONTEXT_REPOSITORY_MISMATCH", String(snapshot.repositoryId));
  }
  if (typeof snapshot.commitSha !== "string" || !SHA40.test(snapshot.commitSha)) {
    fail("GATE6_CONTEXT_SNAPSHOT_SHA_INVALID", String(snapshot.commitSha));
  }
  if (snapshot.commitSha !== task.commitSha) {
    fail("GATE6_CONTEXT_COMMIT_MISMATCH", snapshot.commitSha);
  }
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    fail("GATE6_CONTEXT_SNAPSHOT_FILES_INVALID");
  }

  const byPath = new Map();
  for (let index = 0; index < snapshot.files.length; index += 1) {
    const file = snapshot.files[index];
    if (!sameKeys(file, SNAPSHOT_FILE_FIELDS)) fail("GATE6_CONTEXT_SNAPSHOT_FILE_INVALID", `files[${index}]`);
    const filePath = assertSafePath(file.path, `files[${index}].path`);
    if (typeof file.content !== "string") fail("GATE6_CONTEXT_SNAPSHOT_FILE_INVALID", `files[${index}].content`);
    if (byPath.has(filePath)) fail("GATE6_CONTEXT_SNAPSHOT_DUPLICATE_PATH", filePath);
    byPath.set(filePath, file);
  }

  for (const candidatePath of task.candidateFiles) {
    if (!byPath.has(candidatePath)) fail("GATE6_CONTEXT_CANDIDATE_MISSING", candidatePath);
  }

  const visibleFiles = [...byPath.values()]
    .filter((file) => canInspect(task, file.path))
    .sort((left, right) => compareText(left.path, right.path));

  const visibleSnapshotHash = hashCanonical({
    schemaVersion: snapshot.schemaVersion,
    repositoryId: snapshot.repositoryId,
    commitSha: snapshot.commitSha,
    files: visibleFiles.map((file) => ({
      path: file.path,
      contentHash: hashText(file.content),
      byteLength: Buffer.byteLength(file.content, "utf8")
    }))
  });

  return { byPath, visibleFiles, visibleSnapshotHash };
}

function extractSymbols(content) {
  const symbols = new Set();
  for (const line of content.split(/\r?\n/)) {
    const declaration = line.match(DECLARATION);
    if (declaration) symbols.add(declaration[1]);
    const method = line.match(METHOD);
    if (method && !RESERVED_METHOD_NAMES.has(method[1])) symbols.add(method[1]);
  }
  return [...symbols].sort(compareText);
}

function tokenizeObjective(objective) {
  const tokens = String(objective).toLowerCase().match(/[a-z0-9_$.-]+/g) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))].sort(compareText);
}

function fileKind(filePath) {
  const lower = filePath.toLowerCase();
  if (/(^|\/)(__tests__|test|tests|spec|specs)(\/|\.|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)) return "test";
  if (/\.(d\.ts|d\.mts|d\.cts)$/.test(lower)) return "declaration";
  if (/(^|\/)(readme|docs?)(\.|\/|$)/.test(lower) || /\.md$/.test(lower)) return "documentation";
  if (/(^|\/)(package\.json|tsconfig\.json|pyproject\.toml|cargo\.toml)$/.test(lower)) return "metadata";
  return "implementation";
}

function syntheticSummary(file) {
  const byteLength = Buffer.byteLength(file.content, "utf8");
  const lineCount = file.content.length === 0 ? 0 : file.content.split(/\r?\n/).length;
  const symbols = extractSymbols(file.content).slice(0, 16);
  return {
    path: file.path,
    kind: fileKind(file.path),
    byteLength,
    lineCount,
    symbols,
    summary: `${fileKind(file.path)} candidate; ${lineCount} lines; ${byteLength} bytes; symbols: ${symbols.join(", ") || "none detected"}`
  };
}

function lineSymbol(line) {
  const declaration = line.match(DECLARATION);
  if (declaration) return declaration[1];
  const method = line.match(METHOD);
  if (method && !RESERVED_METHOD_NAMES.has(method[1])) return method[1];
  return null;
}

function boundedExcerpt(file, objectiveTokens, options = {}) {
  const radius = options.radius ?? 5;
  const maxLines = options.maxLines ?? 100;
  const lines = file.content.split(/\r?\n/);
  const selected = new Set();
  const lowerTokens = objectiveTokens.map((token) => token.toLowerCase());

  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    const symbol = lineSymbol(lines[index]);
    const relevant = lowerTokens.some((token) => lower.includes(token)) || symbol !== null;
    if (!relevant) continue;
    for (let cursor = Math.max(0, index - radius); cursor <= Math.min(lines.length - 1, index + radius); cursor += 1) selected.add(cursor);
  }

  if (selected.size === 0) {
    for (let index = 0; index < Math.min(lines.length, Math.min(maxLines, 60)); index += 1) selected.add(index);
  }

  const indexes = [...selected].sort((left, right) => left - right).slice(0, maxLines);
  const symbols = new Set();
  for (const index of indexes) {
    const symbol = lineSymbol(lines[index]);
    if (symbol) symbols.add(symbol);
  }

  return {
    path: file.path,
    kind: fileKind(file.path),
    contentHash: hashText(file.content),
    excerpt: indexes.map((index) => `${index + 1}: ${lines[index]}`).join("\n"),
    symbols: [...symbols].sort(compareText)
  };
}

function authorityView(task) {
  return {
    allowedInspectionPaths: [...task.authority.allowedInspectionPaths],
    forbiddenInspectionPaths: [...task.authority.forbiddenInspectionPaths],
    allowedChangePaths: [...task.authority.allowedChangePaths]
  };
}

function candidateFiles(task, snapshotState) {
  return [...task.candidateFiles].sort(compareText).map((filePath) => snapshotState.byPath.get(filePath));
}

function buildSyntheticPayload(task, snapshotState, strategy) {
  const summaries = candidateFiles(task, snapshotState).map(syntheticSummary);
  return {
    version: CONTEXT_STRATEGY_VERSION,
    strategy,
    contextStrategy: strategy === "CE_escalating_context" ? "synthetic_initial_pending_escalation" : "deterministic_repository_summary",
    repositoryId: task.repositoryId,
    commitSha: task.commitSha,
    taskId: task.taskId,
    taskClass: task.taskClass,
    objective: task.objective,
    authority: authorityView(task),
    candidateFiles: [...task.candidateFiles].sort(compareText),
    summaries,
    ...(strategy === "CE_escalating_context" ? { escalationState: "not_escalated" } : {})
  };
}

function buildEPayload(task, snapshotState) {
  const tokens = tokenizeObjective(task.objective);
  const excerpts = candidateFiles(task, snapshotState).map((file) => boundedExcerpt(file, tokens, { radius: 6, maxLines: 110 }));
  return {
    version: CONTEXT_STRATEGY_VERSION,
    strategy: "E_bounded_workspace_boundary",
    contextStrategy: "bounded_workspace_with_boundary",
    repositoryId: task.repositoryId,
    commitSha: task.commitSha,
    taskId: task.taskId,
    taskClass: task.taskClass,
    objective: task.objective,
    authority: authorityView(task),
    workspaceExcerpts: excerpts
  };
}

function scoreSummary(summary, file, objectiveTokens, taskClass) {
  const lowerPath = summary.path.toLowerCase();
  const lowerContent = file.content.toLowerCase();
  const lowerSymbols = summary.symbols.map((symbol) => symbol.toLowerCase());
  let score = 0;
  for (const token of objectiveTokens) {
    if (lowerPath.includes(token)) score += 8;
    if (lowerSymbols.some((symbol) => symbol.includes(token) || token.includes(symbol))) score += 6;
    if (lowerContent.includes(token)) score += 1;
  }
  if (taskClass.requiresImplementationFile && summary.kind === "implementation") score += 3;
  if (taskClass.requiresTestFile && summary.kind === "test") score += 3;
  return score;
}

function selectCompressedCandidates(task, snapshotState) {
  const taskClass = getGate6TaskClass(task.taskClass);
  const objectiveTokens = tokenizeObjective(task.objective);
  const rows = candidateFiles(task, snapshotState).map((file) => {
    const summary = syntheticSummary(file);
    return { file, summary, score: scoreSummary(summary, file, objectiveTokens, taskClass) };
  });
  rows.sort((left, right) => right.score - left.score || compareText(left.file.path, right.file.path));

  const selected = [];
  const add = (row) => {
    if (row && !selected.some((entry) => entry.file.path === row.file.path)) selected.push(row);
  };
  if (taskClass.requiresImplementationFile) add(rows.find((row) => row.summary.kind === "implementation"));
  if (taskClass.requiresTestFile) add(rows.find((row) => row.summary.kind === "test"));
  for (const row of rows) {
    if (selected.length >= 2) break;
    add(row);
  }
  if (selected.length === 0 && rows.length > 0) add(rows[0]);
  return { taskClass, objectiveTokens, rows, selected };
}

function relativeDependencySpecs(content) {
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) specs.add(match[1]);
  return [...specs].sort(compareText);
}

function resolveDependencyPath(fromPath, spec, availablePaths) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
  if (base === ".." || base.startsWith("../")) return null;
  const variants = [
    base,
    `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, `${base}.jsx`, `${base}.tsx`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.mjs`, `${base}/index.cjs`
  ];
  return variants.find((candidate) => availablePaths.has(candidate)) ?? null;
}

function resolveOneHopExpansion(task, snapshotState, selectedRows, taskClass) {
  if (!taskClass.allowsCrossFileExpansion) return { rounds: 0, files: [] };
  const availablePaths = new Set(snapshotState.visibleFiles.map((file) => file.path));
  const selectedPaths = new Set(selectedRows.map((row) => row.file.path));
  const candidates = [];
  for (const row of selectedRows.filter((entry) => entry.summary.kind !== "test")) {
    for (const spec of relativeDependencySpecs(row.file.content)) {
      const dependencyPath = resolveDependencyPath(row.file.path, spec, availablePaths);
      if (dependencyPath && !selectedPaths.has(dependencyPath) && canInspect(task, dependencyPath)) candidates.push(dependencyPath);
    }
  }
  const unique = [...new Set(candidates)].sort(compareText);
  return unique.length === 0 ? { rounds: 0, files: [] } : { rounds: 1, files: [unique[0]] };
}

function buildFPayload(task, snapshotState) {
  const selection = selectCompressedCandidates(task, snapshotState);
  const expansion = resolveOneHopExpansion(task, snapshotState, selection.selected, selection.taskClass);
  const evidencePaths = [...new Set([...selection.selected.map((row) => row.file.path), ...expansion.files])].sort(compareText);
  const evidence = evidencePaths.map((filePath) => boundedExcerpt(snapshotState.byPath.get(filePath), selection.objectiveTokens, { radius: 4, maxLines: 72 }));
  return {
    payload: {
      version: CONTEXT_STRATEGY_VERSION,
      strategy: "F_adaptive_compressed_boundary",
      contextStrategy: "synthetic_candidates_then_verified_e_lite",
      repositoryId: task.repositoryId,
      commitSha: task.commitSha,
      taskId: task.taskId,
      taskClass: task.taskClass,
      objective: task.objective,
      stages: [
        {
          stage: "candidate_compression",
          summaries: selection.rows.map((row) => row.summary),
          selectedCandidates: selection.selected.map((row) => row.file.path).sort(compareText)
        },
        {
          stage: "verified_e_lite",
          authority: authorityView(task),
          expansionPolicy: { oneHopOnly: true, maxRounds: 1, maxFiles: 1 },
          expansionRounds: expansion.rounds,
          expansionFiles: expansion.files,
          workspaceExcerpts: evidence
        }
      ]
    },
    expansionRounds: expansion.rounds
  };
}

function includedFromPayload(payload) {
  const files = new Set();
  const symbols = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isPlainObject(value)) return;
    if (typeof value.path === "string" && typeof value.excerpt === "string") files.add(value.path);
    if (Array.isArray(value.symbols)) for (const symbol of value.symbols) symbols.add(symbol);
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  for (const summary of payload.summaries ?? []) {
    files.add(summary.path);
    for (const symbol of summary.symbols ?? []) symbols.add(symbol);
  }
  for (const stage of payload.stages ?? []) {
    for (const summary of stage.summaries ?? []) {
      files.add(summary.path);
      for (const symbol of summary.symbols ?? []) symbols.add(symbol);
    }
  }
  return { includedFiles: [...files].sort(compareText), includedSymbols: [...symbols].sort(compareText) };
}

function resolveContext({ task, repositorySnapshot, strategy } = {}) {
  if (!STRATEGIES.includes(strategy)) fail("GATE6_CONTEXT_STRATEGY_UNSUPPORTED", String(strategy));
  try {
    validateGate6Task(task);
  } catch (error) {
    fail("GATE6_CONTEXT_TASK_INVALID", error instanceof Error ? error.message : String(error));
  }
  const snapshotState = validateSnapshot(task, repositorySnapshot);
  let payload;
  let expansionRounds = 0;
  if (strategy === "C_synthetic_context" || strategy === "CE_escalating_context") {
    payload = buildSyntheticPayload(task, snapshotState, strategy);
  } else if (strategy === "E_bounded_workspace_boundary") {
    payload = buildEPayload(task, snapshotState);
  } else {
    const built = buildFPayload(task, snapshotState);
    payload = built.payload;
    expansionRounds = built.expansionRounds;
  }
  const { includedFiles, includedSymbols } = includedFromPayload(payload);
  for (const filePath of includedFiles) if (!canInspect(task, filePath)) fail("GATE6_CONTEXT_AUTHORITY_VIOLATION", filePath);
  const context = stableStringify(payload);
  const contextBytes = Buffer.byteLength(context, "utf8");
  const estimatedTokens = Math.ceil(contextBytes / 4);
  return deepFreeze({
    version: CONTEXT_STRATEGY_VERSION,
    strategy,
    context,
    includedFiles,
    includedSymbols,
    contextBytes,
    estimatedTokens,
    tokenAccounting: { method: "ceil_utf8_bytes_div_4", estimatedTokens },
    providerContextHash: hashText(context),
    authorityHash: hashCanonical(authorityView(task)),
    repositorySnapshotHash: snapshotState.visibleSnapshotHash,
    expansionRounds
  });
}

module.exports = {
  CONTEXT_STRATEGY_VERSION,
  Gate6ContextStrategyError,
  REPOSITORY_SNAPSHOT_VERSION,
  STRATEGIES,
  resolveContext
};
