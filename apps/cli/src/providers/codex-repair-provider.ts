import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  createAcceptanceCriteriaContract,
  createWorkspaceMutation,
  hashCanonicalJson,
  parseTargetedRepairRequest,
  parseTextFileUpdates,
  validateUpdateSourceMap,
  type AcceptanceCriterion,
  type TargetedRepairBoundary,
  type TargetedRepairRequest,
  type WorkspaceMutation
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import type {
  AgentAdapter,
  AgentReasoningEffort,
  AgentRunResult,
  AgentUsage
} from "../../../../packages/integrations/src/agent-adapter.js";
import {
  AgentMutationCaptureError,
  captureAgentMutations
} from "../../../../packages/integrations/src/agent-mutation-capture.js";
import { CodexAgentAdapter } from "../../../../packages/integrations/src/codex-agent-adapter.js";
import {
  DisposableAgentWorkspaceError,
  createDisposableAgentWorkspace
} from "../../../../packages/integrations/src/disposable-agent-workspace.js";

export const CODEX_REPAIR_PROVIDER_VERSION = "codex-targeted-repair-provider/v1" as const;
export const MAX_REPAIR_ROUNDS = 1 as const;

export type CodexRepairProviderOptions = Readonly<{
  model: string;
  adapter?: AgentAdapter;
  reasoningEffort?: AgentReasoningEffort;
  timeoutMs?: number;
}>;

export type CodexRepairProviderInput = Readonly<{
  request: TargetedRepairRequest;
  boundary: TargetedRepairBoundary;
  originalCandidate: WorkspaceMutation;
  acceptanceCriterion: AcceptanceCriterion;
  signal?: AbortSignal;
}>;

export type CodexRepairContextSummary = Readonly<{
  failingFiles: readonly string[];
  preserveFiles: readonly string[];
  failingChecks: readonly string[];
  verifierIssueCount: number;
  acceptanceCriterionId: string;
  visibleFileCount: number;
  visibleBytes: number;
  wholeRepositoryProvided: false;
}>;

export type CodexRepairReadyResult = Readonly<{
  providerVersion: typeof CODEX_REPAIR_PROVIDER_VERSION;
  maxRepairRounds: typeof MAX_REPAIR_ROUNDS;
  decision: "repair_candidate_ready";
  route: "continue";
  repairRound: 1;
  repairMutation: WorkspaceMutation;
  modelCalled: true;
  modelId: string;
  usage: AgentUsage;
  context: CodexRepairContextSummary;
}>;

export type CodexRepairStoppedResult = Readonly<{
  providerVersion: typeof CODEX_REPAIR_PROVIDER_VERSION;
  maxRepairRounds: typeof MAX_REPAIR_ROUNDS;
  decision: "repair_stopped";
  route: "human_review_required" | "replan_required";
  reasonCode: string;
  message: string;
  repairRound: number;
  modelCalled: boolean;
  modelId: string | null;
  usage: AgentUsage | null;
  context: CodexRepairContextSummary | null;
}>;

export type CodexRepairProviderResult = CodexRepairReadyResult | CodexRepairStoppedResult;

export type CodexRepairProvider = Readonly<{
  providerVersion: typeof CODEX_REPAIR_PROVIDER_VERSION;
  maxRepairRounds: typeof MAX_REPAIR_ROUNDS;
  repair(input: CodexRepairProviderInput): Promise<CodexRepairProviderResult>;
}>;

export class CodexRepairProviderError extends Error {
  readonly code = "codex_repair_provider_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodexRepairProviderError";
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function normalizeOptions(input: CodexRepairProviderOptions): Readonly<{
  model: string;
  adapter: AgentAdapter;
  reasoningEffort: AgentReasoningEffort;
  timeoutMs: number;
}> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new CodexRepairProviderError("Codex repair provider options must be an object.");
  }
  if (typeof input.model !== "string" || !IDENTIFIER.test(input.model)) {
    throw new CodexRepairProviderError("model must be a bounded identifier.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new CodexRepairProviderError("timeoutMs must be an integer from 1 to 600000.");
  }
  return Object.freeze({
    model: input.model,
    adapter: input.adapter ?? new CodexAgentAdapter(),
    reasoningEffort: input.reasoningEffort ?? "medium",
    timeoutMs
  });
}

function normalizeCriterion(
  criterion: AcceptanceCriterion,
  objectiveHash: string
): AcceptanceCriterion {
  try {
    const normalized = createAcceptanceCriteriaContract({
      taskId: "targeted-repair",
      objectiveHash,
      criteria: [criterion]
    });
    return normalized.criteria[0]!;
  } catch (error) {
    throw new CodexRepairProviderError(
      error instanceof Error ? `acceptanceCriterion is invalid: ${error.message}` :
        "acceptanceCriterion is invalid."
    );
  }
}

function stop(
  request: TargetedRepairRequest,
  route: CodexRepairStoppedResult["route"],
  reasonCode: string,
  message: string,
  extra: Readonly<{
    modelCalled?: boolean;
    modelId?: string | null;
    usage?: AgentUsage | null;
    context?: CodexRepairContextSummary | null;
  }> = {}
): CodexRepairStoppedResult {
  return Object.freeze({
    providerVersion: CODEX_REPAIR_PROVIDER_VERSION,
    maxRepairRounds: MAX_REPAIR_ROUNDS,
    decision: "repair_stopped",
    route,
    reasonCode,
    message,
    repairRound: request.repairRound,
    modelCalled: extra.modelCalled ?? false,
    modelId: extra.modelId ?? null,
    usage: extra.usage ?? null,
    context: extra.context ?? null
  });
}

function candidateClaims(input: CodexRepairProviderInput, request: TargetedRepairRequest) {
  let claims;
  try {
    claims = parseTextFileUpdates(input.originalCandidate);
  } catch (error) {
    throw new CodexRepairProviderError(
      error instanceof Error ? `originalCandidate is invalid: ${error.message}` :
        "originalCandidate is invalid."
    );
  }
  const actualHash = hashCanonicalJson(input.originalCandidate);
  if (actualHash !== request.originalCandidateHash) {
    throw new CodexRepairProviderError(
      "originalCandidateHash does not match the supplied originalCandidate mutation."
    );
  }
  const claimFiles = claims.map((claim) => claim.file).sort((left, right) =>
    left.localeCompare(right, "en")
  );
  const boundaryFiles = [...input.boundary.originalCandidateFiles].sort((left, right) =>
    left.localeCompare(right, "en")
  );
  if (!sameSet(claimFiles, boundaryFiles)) {
    throw new CodexRepairProviderError(
      "originalCandidate files do not match the trusted targeted-repair boundary."
    );
  }
  return claims;
}

function localizationStop(request: TargetedRepairRequest): Readonly<{
  route: CodexRepairStoppedResult["route"];
  reasonCode: string;
  message: string;
}> | null {
  if (request.repairRound > MAX_REPAIR_ROUNDS) {
    return Object.freeze({
      route: "human_review_required",
      reasonCode: "repair_round_limit_exhausted",
      message: `Targeted repair V1 permits at most ${MAX_REPAIR_ROUNDS} repair round.`
    });
  }
  if (request.failingFiles.length === 0) {
    return Object.freeze({
      route: "human_review_required",
      reasonCode: "repair_failure_not_localized",
      message: "Targeted repair requires at least one explicit failing file."
    });
  }
  if (!sameSet(request.allowedFiles, request.failingFiles)) {
    return Object.freeze({
      route: "replan_required",
      reasonCode: "repair_scope_not_targeted",
      message: "Targeted repair V1 only permits the explicitly failing files to remain mutable."
    });
  }

  const candidateFiles = new Set([...request.allowedFiles, ...request.preserveFiles]);
  const failingSet = new Set(request.failingFiles);
  for (const issue of request.verifierIssues) {
    if (issue.file === undefined) continue;
    if (!candidateFiles.has(issue.file)) {
      return Object.freeze({
        route: "replan_required",
        reasonCode: "repair_verifier_issue_outside_candidate",
        message: `Verifier issue references a file outside the original candidate: ${issue.file}.`
      });
    }
    if (!failingSet.has(issue.file)) {
      return Object.freeze({
        route: "replan_required",
        reasonCode: "repair_preserve_file_has_failure",
        message: `A preserved accepted edit is still named by a verifier issue: ${issue.file}.`
      });
    }
  }

  if (request.failingFiles.length > 1) {
    const issueFiles = new Set(
      request.verifierIssues.flatMap((issue) => issue.file === undefined ? [] : [issue.file])
    );
    const unresolved = request.failingFiles.filter((file) => !issueFiles.has(file));
    if (unresolved.length > 0) {
      return Object.freeze({
        route: "human_review_required",
        reasonCode: "repair_multi_file_failure_ambiguous",
        message: `Multi-file repair is not reliably localized: ${unresolved.join(", ")}.`
      });
    }
  }
  return null;
}

async function buildCandidateSeed(
  claims: ReturnType<typeof parseTextFileUpdates>
): Promise<Readonly<{
  root: string;
  contents: Readonly<Record<string, string>>;
  descriptions: ReadonlyMap<string, string>;
}>> {
  const root = await mkdtemp(join(tmpdir(), "bounded-codex-repair-seed-"));
  const contents: Record<string, string> = {};
  const descriptions = new Map<string, string>();
  try {
    for (const claim of claims) {
      const target = join(root, ...claim.file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, claim.newContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
      contents[claim.file] = claim.newContent;
      descriptions.set(claim.file, claim.description);
    }
    return Object.freeze({ root, contents: Object.freeze(contents), descriptions });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function repairPrompt(
  request: TargetedRepairRequest,
  criterion: AcceptanceCriterion,
  descriptions: ReadonlyMap<string, string>
): string {
  const context = {
    repair_scope: request.failingFiles,
    failure: {
      checks: request.failingChecks,
      verifierIssues: request.verifierIssues
    },
    preserve: request.preserveFiles.map((file) => ({
      file,
      acceptedEdit: descriptions.get(file) ?? "Accepted candidate edit; preserve exactly."
    })),
    acceptanceCriterion: criterion
  };
  return [
    "You are the Codex targeted repair provider for one bounded candidate.",
    "This is one repair attempt only. Do not retry, replan, or broaden scope.",
    "The workspace contains only the candidate files relevant to this repair; it is not the repository.",
    `Modify ONLY these failing files: ${JSON.stringify(request.failingFiles)}.`,
    `Do NOT modify these accepted files: ${JSON.stringify(request.preserveFiles)}.`,
    "Only modify existing regular UTF-8 files. Never add, delete, rename, copy, chmod, or create symlinks.",
    "Do not request or edit policy. Do not change or reinterpret the acceptance criterion.",
    "Use the failure evidence below to make the smallest local repair. If the evidence is insufficient, make no speculative changes.",
    JSON.stringify(context)
  ].join("\n");
}

function runId(request: TargetedRepairRequest): string {
  return `repair-${createHash("sha256")
    .update(`${request.originalCandidateHash}\u0000${request.repairRound}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function contextSummary(
  request: TargetedRepairRequest,
  criterion: AcceptanceCriterion,
  visibleFileCount: number,
  visibleBytes: number
): CodexRepairContextSummary {
  return Object.freeze({
    failingFiles: Object.freeze([...request.failingFiles]),
    preserveFiles: Object.freeze([...request.preserveFiles]),
    failingChecks: Object.freeze([...request.failingChecks]),
    verifierIssueCount: request.verifierIssues.length,
    acceptanceCriterionId: criterion.id,
    visibleFileCount,
    visibleBytes,
    wholeRepositoryProvided: false
  });
}

function repairMutationFromCapture(
  captured: Awaited<ReturnType<typeof captureAgentMutations>>
): WorkspaceMutation {
  const claims = captured.claims.map((claim) => Object.freeze({
    ...claim,
    type: "repair_draft" as const,
    description: `Targeted repair: ${claim.description}`
  }));
  const mutation = createWorkspaceMutation({
    role: "remask",
    target: "repairDraft",
    summary: "Codex produced one targeted repair against the original candidate state.",
    claims,
    touchedFiles: [...captured.changedFiles]
  });
  parseTextFileUpdates(mutation);
  return mutation;
}

function completedUsage(result: AgentRunResult): AgentUsage {
  return Object.freeze({ ...result.usage });
}

export function createCodexRepairProvider(
  input: CodexRepairProviderOptions
): CodexRepairProvider {
  const options = normalizeOptions(input);

  return Object.freeze({
    providerVersion: CODEX_REPAIR_PROVIDER_VERSION,
    maxRepairRounds: MAX_REPAIR_ROUNDS,
    async repair(providerInput: CodexRepairProviderInput): Promise<CodexRepairProviderResult> {
      let request: TargetedRepairRequest;
      try {
        request = parseTargetedRepairRequest(providerInput.request, providerInput.boundary);
      } catch (error) {
        throw new CodexRepairProviderError(
          error instanceof Error ? `Targeted repair request is invalid: ${error.message}` :
            "Targeted repair request is invalid."
        );
      }
      const criterion = normalizeCriterion(providerInput.acceptanceCriterion, request.originalCandidateHash);
      const claims = candidateClaims(providerInput, request);
      const localStop = localizationStop(request);
      if (localStop !== null) {
        return stop(request, localStop.route, localStop.reasonCode, localStop.message);
      }

      const seed = await buildCandidateSeed(claims);
      let workspacePath: string | null = null;
      try {
        let workspace;
        try {
          workspace = await createDisposableAgentWorkspace({
            repositoryPath: seed.root,
            sourceSnapshotHash: request.originalCandidateHash,
            visibleFiles: [...request.failingFiles, ...request.preserveFiles],
            changeAllowedFiles: request.failingFiles,
            forbiddenFiles: [],
            mode: "bounded"
          });
        } catch (error) {
          if (error instanceof DisposableAgentWorkspaceError) {
            return stop(
              request,
              "human_review_required",
              "repair_context_not_safe",
              error.message
            );
          }
          throw error;
        }
        workspacePath = workspace.workspacePath;
        const summary = contextSummary(
          request,
          criterion,
          workspace.exposedFileCount,
          workspace.exposedBytes
        );

        const result = await options.adapter.run({
          runId: runId(request),
          agentId: options.adapter.agentId,
          workingDirectory: workspace.workspacePath,
          task: repairPrompt(request, criterion, seed.descriptions),
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          mode: "repair",
          timeoutMs: options.timeoutMs,
          networkAllowed: false,
          sandboxMode: "workspace_write",
          ...(providerInput.signal === undefined ? {} : { abortSignal: providerInput.signal })
        });
        const usage = completedUsage(result);
        if (result.status !== "completed") {
          return stop(
            request,
            "human_review_required",
            "repair_model_did_not_complete",
            `Codex repair ended with status=${result.status}; blind retry is disabled.`,
            { modelCalled: true, modelId: result.modelId, usage, context: summary }
          );
        }

        let captured;
        try {
          captured = await captureAgentMutations({
            workspacePath: workspace.workspacePath,
            sourceManifest: workspace.manifest
          });
        } catch (error) {
          if (error instanceof AgentMutationCaptureError) {
            return stop(
              request,
              "human_review_required",
              error.code === "agent_mutation_no_changes" ?
                "repair_model_made_no_change" : "repair_mutation_invalid",
              `${error.message} Blind retry is disabled.`,
              { modelCalled: true, modelId: result.modelId, usage, context: summary }
            );
          }
          throw error;
        }

        const allowed = new Set(request.failingFiles);
        const outsideScope = captured.changedFiles.filter((file) => !allowed.has(file));
        if (outsideScope.length > 0) {
          return stop(
            request,
            "human_review_required",
            "repair_scope_violation",
            `Codex changed preserved or unauthorized files: ${outsideScope.join(", ")}.`,
            { modelCalled: true, modelId: result.modelId, usage, context: summary }
          );
        }

        const mutation = repairMutationFromCapture(captured);
        try {
          validateUpdateSourceMap(parseTextFileUpdates(mutation), seed.contents as Record<string, string>);
        } catch (error) {
          return stop(
            request,
            "human_review_required",
            "repair_candidate_validation_failed",
            `${error instanceof Error ? error.message : "Repair candidate validation failed."} Blind retry is disabled.`,
            { modelCalled: true, modelId: result.modelId, usage, context: summary }
          );
        }

        return Object.freeze({
          providerVersion: CODEX_REPAIR_PROVIDER_VERSION,
          maxRepairRounds: MAX_REPAIR_ROUNDS,
          decision: "repair_candidate_ready",
          route: "continue",
          repairRound: 1,
          repairMutation: mutation,
          modelCalled: true,
          modelId: result.modelId,
          usage,
          context: summary
        });
      } finally {
        if (workspacePath !== null) {
          await rm(workspacePath, { recursive: true, force: true });
        }
        await rm(seed.root, { recursive: true, force: true });
      }
    }
  });
}
