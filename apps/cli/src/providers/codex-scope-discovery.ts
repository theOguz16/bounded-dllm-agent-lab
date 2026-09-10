import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm, realpath } from "node:fs/promises";

import {
  analyzeCanonicalRepository,
  verifyCanonicalRepoIntelligence,
  type CanonicalRepoFileFact
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type {
  AgentAdapter,
  AgentReasoningEffort,
  AgentUsage
} from "../../../../packages/integrations/src/agent-adapter.js";
import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";
import { createDisposableAgentWorkspace } from "../../../../packages/integrations/src/disposable-agent-workspace.js";
import {
  parseScopeDiscoveryProposal,
  SCOPE_DISCOVERY_OUTPUT_SCHEMA,
  type ScopeDiscoveryProposal
} from "../../../../packages/integrations/src/scope-discovery-contract.js";

export const CODEX_SCOPE_DISCOVERY_VERSION = "codex-scope-discovery/v1" as const;

export type CodexScopeDiscoveryInput = Readonly<{
  repositoryPath: string;
  sourceSnapshotHash: string;
  task: string;
  model: string;
  adapter?: AgentAdapter;
  reasoningEffort?: AgentReasoningEffort;
  timeoutMs?: number;
}>;

export type CodexScopeDiscoveryResult = Readonly<{
  discoveryVersion: typeof CODEX_SCOPE_DISCOVERY_VERSION;
  proposal: ScopeDiscoveryProposal;
  modelId: string;
  usage: AgentUsage;
  intelligenceHash: string;
  repositoryIdentityHash: string;
  visibleFileCount: number;
  visibleBytes: number;
  sourceRepositoryWritePerformed: false;
  discoverySandbox: "read_only";
  networkAllowed: false;
}>;

export class CodexScopeDiscoveryError extends Error {
  readonly code = "codex_scope_discovery_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodexScopeDiscoveryError";
  }
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_INVENTORY_PROMPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function looksLikeTestPath(file: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(file);
}

function protectedDiscoveryPath(file: string): boolean {
  const lower = file.toLocaleLowerCase("en-US");
  const segments = lower.split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.includes(".git") || segments.includes("node_modules")) return true;
  if (segments.includes("dist") || segments.includes("build")) return true;
  if (segments.includes("credentials")) return true;
  if (segments.includes("oracle") || segments.includes("oracles")) return true;
  if (segments.some((segment) => /(^|[._-])secrets?([._-]|$)/.test(segment))) return true;
  if (/ground[-_]?truth|hidden[-_]?oracle|expected[-_]?(?:change|changed|patch|diff)/.test(basename)) {
    return true;
  }
  if (
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx")
  ) {
    return true;
  }
  return false;
}

function trackedSourceAnchor(repositoryRoot: string): string {
  const result = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new CodexScopeDiscoveryError("Git tracked-file inventory could not be read for scope discovery.");
  }
  const candidates = String(result.stdout)
    .split("\u0000")
    .filter((file) => SOURCE_EXTENSION.test(file) && !protectedDiscoveryPath(file))
    .sort((left, right) => left.localeCompare(right, "en"));
  const anchor = candidates[0];
  if (!anchor) {
    throw new CodexScopeDiscoveryError(
      "Scope discovery requires at least one tracked JavaScript or TypeScript source file."
    );
  }
  return anchor;
}

function workspaceStatus(workspacePath: string): string {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new CodexScopeDiscoveryError("Disposable discovery workspace state could not be verified.");
  }
  return String(result.stdout);
}

function safeFacts(files: readonly CanonicalRepoFileFact[]): CanonicalRepoFileFact[] {
  return files.filter(
    (file) =>
      (file.language === "javascript" || file.language === "typescript") &&
      SOURCE_EXTENSION.test(file.path) &&
      !protectedDiscoveryPath(file.path)
  );
}

function publicInventory(
  files: readonly CanonicalRepoFileFact[],
  dependencyEdges: readonly Readonly<{ from: string; to: string; kind: string; specifier: string }>[]
): Readonly<Record<string, unknown>> {
  const allowed = new Set(files.map((file) => file.path));
  return Object.freeze({
    files: files.map((file) => ({
      path: file.path,
      language: file.language,
      bytes: file.bytes,
      imports: file.imports,
      exports: file.exports,
      symbols: file.symbols
    })),
    dependencyEdges: dependencyEdges
      .filter((edge) => allowed.has(edge.from) && allowed.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        specifier: edge.specifier
      }))
  });
}

function discoveryPrompt(task: string, intelligenceHash: string, inventory: Readonly<Record<string, unknown>>): string {
  const evidence = JSON.stringify({
    task,
    canonicalRepository: {
      intelligenceHash,
      ...inventory
    }
  });
  if (Buffer.byteLength(evidence, "utf8") > MAX_INVENTORY_PROMPT_BYTES) {
    throw new CodexScopeDiscoveryError("Canonical discovery inventory exceeds the bounded prompt limit.");
  }
  return [
    "You are the read-only scope discovery phase for Bounded Codex.",
    "Inspect only the provided canonical repository facts and files available in the read-only workspace.",
    "Do not modify, create, delete, rename, or chmod files.",
    "Do not seek, infer from, or use any ground-truth patch, expected changed-files list, hidden benchmark oracle, solution artifact, or acceptance oracle.",
    "Propose the smallest plausible mutable scope for the user's task.",
    "candidateSourceFiles must contain implementation files; candidateTestFiles must contain regression/behavior test files.",
    "candidateSymbols must name top-level symbols that actually exist in the proposed files; it may be empty.",
    "Return only the exact structured output required by the supplied JSON schema.",
    evidence
  ].join("\n");
}

function parseFinalMessage(value: string): ScopeDiscoveryProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CodexScopeDiscoveryError("Codex scope discovery returned invalid JSON.");
  }
  try {
    return parseScopeDiscoveryProposal(parsed);
  } catch (error) {
    throw new CodexScopeDiscoveryError(
      error instanceof Error ? error.message : "Codex scope discovery output violated its contract."
    );
  }
}

function validateGrounding(proposal: ScopeDiscoveryProposal, facts: readonly CanonicalRepoFileFact[]): void {
  const byPath = new Map(facts.map((file) => [file.path, file]));
  for (const file of proposal.candidateSourceFiles) {
    if (!byPath.has(file)) {
      throw new CodexScopeDiscoveryError(`Discovered source candidate is outside public repository intelligence: ${file}.`);
    }
    if (looksLikeTestPath(file)) {
      throw new CodexScopeDiscoveryError(`A test-shaped path was returned as a source candidate: ${file}.`);
    }
  }
  for (const file of proposal.candidateTestFiles) {
    if (!byPath.has(file)) {
      throw new CodexScopeDiscoveryError(`Discovered test candidate is outside public repository intelligence: ${file}.`);
    }
    if (!looksLikeTestPath(file)) {
      throw new CodexScopeDiscoveryError(`A non-test-shaped path was returned as a test candidate: ${file}.`);
    }
  }
  const selected = new Set([...proposal.candidateSourceFiles, ...proposal.candidateTestFiles]);
  const symbols = new Set(
    facts
      .filter((file) => selected.has(file.path))
      .flatMap((file) => file.symbols.map((symbol) => symbol.name))
  );
  for (const symbol of proposal.candidateSymbols) {
    if (!symbols.has(symbol)) {
      throw new CodexScopeDiscoveryError(
        `Discovered symbol is not grounded in the proposed candidate files: ${symbol}.`
      );
    }
  }
}

function runId(task: string, intelligenceHash: string): string {
  return `scope-discovery-${createHash("sha256")
    .update(`${intelligenceHash}\u0000${task}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function discoverCodexScope(
  input: CodexScopeDiscoveryInput
): Promise<CodexScopeDiscoveryResult> {
  const repositoryRoot = await realpath(input.repositoryPath).catch(() => null);
  if (!repositoryRoot) {
    throw new CodexScopeDiscoveryError("Repository path could not be resolved for scope discovery.");
  }
  if (typeof input.task !== "string" || input.task.trim().length === 0 || input.task !== input.task.trim()) {
    throw new CodexScopeDiscoveryError("Scope discovery task must be a non-empty trimmed string.");
  }
  if (typeof input.sourceSnapshotHash !== "string" || input.sourceSnapshotHash.length === 0) {
    throw new CodexScopeDiscoveryError("Scope discovery requires a source snapshot hash.");
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new CodexScopeDiscoveryError("Scope discovery requires an explicit Codex model.");
  }

  const anchor = trackedSourceAnchor(repositoryRoot);
  const intelligenceResult = await analyzeCanonicalRepository({
    repositoryPath: repositoryRoot,
    seedFiles: [anchor],
    maxFiles: 5_000,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxDependencyDepth: 12,
    maxEdges: 50_000
  });
  if (
    intelligenceResult.decision !== "repo_intelligence_ready" ||
    intelligenceResult.intelligence === null ||
    !verifyCanonicalRepoIntelligence(intelligenceResult.intelligence)
  ) {
    const issue = intelligenceResult.issues[0];
    throw new CodexScopeDiscoveryError(
      issue ? `Canonical repository intelligence blocked discovery: ${issue.code}.` :
        "Canonical repository intelligence did not produce a verified result."
    );
  }

  const intelligence = intelligenceResult.intelligence;
  const facts = safeFacts(intelligence.scannedFiles);
  if (facts.length === 0) {
    throw new CodexScopeDiscoveryError("No public JavaScript/TypeScript source files are eligible for discovery.");
  }
  const inventory = publicInventory(facts, intelligence.dependencyEdges);
  const visibleFiles = facts.map((file) => file.path).sort((left, right) => left.localeCompare(right, "en"));
  const workspace = await createDisposableAgentWorkspace({
    repositoryPath: repositoryRoot,
    sourceSnapshotHash: input.sourceSnapshotHash,
    visibleFiles,
    changeAllowedFiles: [],
    forbiddenFiles: [],
    mode: "bounded"
  });

  try {
    const beforeStatus = workspaceStatus(workspace.workspacePath);
    if (beforeStatus.length !== 0) {
      throw new CodexScopeDiscoveryError("Disposable discovery workspace was not clean before model execution.");
    }
    const adapter = input.adapter ?? new CodexAgentAdapter();
    const result = await adapter.run({
      runId: runId(input.task, intelligence.intelligenceHash),
      agentId: "codex",
      workingDirectory: workspace.workspacePath,
      task: discoveryPrompt(input.task, intelligence.intelligenceHash, inventory),
      model: input.model,
      reasoningEffort: input.reasoningEffort ?? "medium",
      mode: "discovery",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      networkAllowed: false,
      sandboxMode: "read_only",
      outputSchema: SCOPE_DISCOVERY_OUTPUT_SCHEMA
    });
    const afterStatus = workspaceStatus(workspace.workspacePath);
    if (afterStatus.length !== 0 || result.fileChanges.length !== 0) {
      throw new CodexScopeDiscoveryError("Read-only scope discovery attempted to mutate its disposable workspace.");
    }
    if (result.status !== "completed") {
      throw new CodexScopeDiscoveryError(`Codex scope discovery did not complete successfully: ${result.status}.`);
    }
    const proposal = parseFinalMessage(result.finalMessage);
    validateGrounding(proposal, facts);
    return Object.freeze({
      discoveryVersion: CODEX_SCOPE_DISCOVERY_VERSION,
      proposal,
      modelId: result.modelId,
      usage: Object.freeze({ ...result.usage }),
      intelligenceHash: intelligence.intelligenceHash,
      repositoryIdentityHash: intelligence.repositoryIdentityHash,
      visibleFileCount: workspace.exposedFileCount,
      visibleBytes: workspace.exposedBytes,
      sourceRepositoryWritePerformed: false,
      discoverySandbox: "read_only",
      networkAllowed: false
    });
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
  }
}
