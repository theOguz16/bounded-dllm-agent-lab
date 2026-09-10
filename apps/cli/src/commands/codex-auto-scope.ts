import { createInterface } from "node:readline/promises";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCanonicalRepositoryContentSnapshot
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type { AgentAdapter } from "../../../../packages/integrations/src/agent-adapter.js";
import type { ScopeDiscoveryProposal } from "../../../../packages/integrations/src/scope-discovery-contract.js";
import { CliError } from "../cli-errors.js";
import type { CliCommandResult } from "../bounded-task.js";
import { doctorBoundedLocalConfig } from "../product-config.js";
import {
  codexCommand,
  type CodexCommandDependencies
} from "./codex.js";
import {
  CodexScopeDiscoveryError,
  discoverCodexScope,
  type CodexScopeDiscoveryResult
} from "../providers/codex-scope-discovery.js";

export const BOUNDED_CODEX_SCOPE_APPROVAL_VERSION = "bounded-codex-scope-approval/v1" as const;

export type CodexAutoScopeCommandInput = Readonly<{
  task: string;
  allowFiles?: readonly string[];
  nonInteractive?: boolean;
}>;

export type CodexAutoScopeDependencies = Readonly<{
  discoveryAdapter?: AgentAdapter;
  discoveryModel?: string;
  discover?: typeof discoverCodexScope;
  approveScope?: (proposal: ScopeDiscoveryProposal) => Promise<boolean>;
  explicit?: CodexCommandDependencies;
}>;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

function configuredCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

async function resolveModel(override?: string): Promise<string> {
  for (const candidate of [
    override,
    process.env.BOUNDED_CODEX_MODEL,
    process.env.CODEX_MODEL,
    process.env.OPENAI_MODEL
  ]) {
    if (typeof candidate === "string" && MODEL.test(candidate.trim())) return candidate.trim();
  }
  try {
    const data = await readFile(path.join(configuredCodexHome(), "config.toml"));
    if (data.length > 0 && data.length <= MAX_CODEX_CONFIG_BYTES) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
        if (match && MODEL.test(match[1]!)) return match[1]!;
      }
    }
  } catch {
    // The explicit Codex path uses the same model discovery order.
  }
  throw new CliError(
    "cli_codex_model_missing",
    "Codex model is not configured. Set CODEX_MODEL or configure model in CODEX_HOME/config.toml.",
    5
  );
}

function ciMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.CI?.trim().toLocaleLowerCase("en-US");
  return value === "1" || value === "true" || value === "yes";
}

function proposalFiles(proposal: ScopeDiscoveryProposal): string[] {
  return [...proposal.candidateSourceFiles, ...proposal.candidateTestFiles];
}

async function promptApproval(proposal: ScopeDiscoveryProposal): Promise<boolean> {
  process.stdout.write("Suggested mutable scope:\n\n");
  for (const file of proposal.candidateSourceFiles) process.stdout.write(`[x] ${file}\n`);
  for (const file of proposal.candidateTestFiles) process.stdout.write(`[x] ${file}\n`);
  if (proposal.candidateSymbols.length > 0) {
    process.stdout.write(`\nSymbols: ${proposal.candidateSymbols.join(", ")}\n`);
  }
  process.stdout.write(`\nReason: ${proposal.reason}\n\n`);
  if (!process.stdin.isTTY) {
    process.stdout.write("Approve? Y/n n\n");
    return false;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("Approve? Y/n ")).trim().toLocaleLowerCase("en-US");
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function discoveryOutput(
  discovery: CodexScopeDiscoveryResult,
  decision: "approval_required" | "approval_declined"
): CliCommandResult {
  const files = proposalFiles(discovery.proposal);
  return {
    output: {
      ok: true,
      command: "codex",
      phase: "scope_discovery",
      scopeApprovalVersion: BOUNDED_CODEX_SCOPE_APPROVAL_VERSION,
      decision,
      approvalRequired: decision === "approval_required",
      mutationStarted: false,
      agent: "Codex",
      model: discovery.modelId,
      reasoning: "medium",
      suggestedMutableScope: files,
      candidateSourceFiles: discovery.proposal.candidateSourceFiles,
      candidateTestFiles: discovery.proposal.candidateTestFiles,
      candidateSymbols: discovery.proposal.candidateSymbols,
      reason: discovery.proposal.reason,
      discovery: {
        version: discovery.discoveryVersion,
        intelligenceHash: discovery.intelligenceHash,
        repositoryIdentityHash: discovery.repositoryIdentityHash,
        visibleFileCount: discovery.visibleFileCount,
        visibleBytes: discovery.visibleBytes,
        sandbox: discovery.discoverySandbox,
        networkAllowed: discovery.networkAllowed
      },
      sourceRepositoryUnchanged: true,
      apply: "NOT_RUN"
    },
    exitCode: decision === "approval_required" ? 3 : 0
  };
}

export async function codexAutoScopeCommand(
  input: CodexAutoScopeCommandInput,
  startPath = process.cwd(),
  dependencies: CodexAutoScopeDependencies = {}
): Promise<CliCommandResult> {
  const allowFiles = input.allowFiles ?? [];
  if (allowFiles.length > 0) {
    return codexCommand({ task: input.task, allowFiles }, startPath, dependencies.explicit);
  }

  const diagnosed = await doctorBoundedLocalConfig(startPath);
  const repositoryRoot = await realpath(diagnosed.repositoryRoot);
  if (!diagnosed.config.packageJson.detected && !diagnosed.config.typescript.detected) {
    throw new CliError(
      "cli_codex_repository_type_unsupported",
      "bounded codex scope discovery currently supports JavaScript/TypeScript repositories."
    );
  }
  const model = await resolveModel(dependencies.discoveryModel ?? dependencies.explicit?.model);
  const before = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  let discovery: CodexScopeDiscoveryResult;
  try {
    discovery = await (dependencies.discover ?? discoverCodexScope)({
      repositoryPath: repositoryRoot,
      sourceSnapshotHash: before.snapshotHash,
      task: input.task,
      model,
      adapter: dependencies.discoveryAdapter,
      reasoningEffort: "medium",
      timeoutMs: 120_000
    });
  } catch (error) {
    if (error instanceof CodexScopeDiscoveryError) {
      throw new CliError("cli_codex_scope_discovery_failed", error.message, 3);
    }
    throw error;
  }
  const afterDiscovery = createCanonicalRepositoryContentSnapshot(repositoryRoot);
  if (before.snapshotHash !== afterDiscovery.snapshotHash) {
    throw new CliError(
      "cli_codex_source_repository_changed",
      "Source repository changed during read-only scope discovery.",
      4
    );
  }

  const nonInteractive = input.nonInteractive === true || ciMode();
  if (nonInteractive) return discoveryOutput(discovery, "approval_required");

  const approved = await (dependencies.approveScope ?? promptApproval)(discovery.proposal);
  if (!approved) return discoveryOutput(discovery, "approval_declined");

  const approvedFiles = proposalFiles(discovery.proposal);
  return codexCommand(
    { task: input.task, allowFiles: approvedFiles },
    repositoryRoot,
    dependencies.explicit
  );
}
