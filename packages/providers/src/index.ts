import {
  addVerifierResult,
  setFinalResult,
  type SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";
import {
  createHttpWorkspaceWorkerClient
} from "../../worker-contract/src/index.js";
import type { MaskView } from "../../masking-policy/src/index.js";

export type ModelMode = "llm" | "dllm";

export type RefinementResult = {
  workspace: SharedSemanticWorkspace;
  latencyMs: number;
  engineName: string;
};

export interface ModelEngine {
  name: string;
  mode: ModelMode;
  refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult>;
}

export class HttpDllmWorkerEngine implements ModelEngine {
  readonly name = "http-dllm-worker";
  readonly mode = "dllm";

  constructor(
    private readonly baseUrl: string,
    private readonly view: MaskView
  ) {}

  async health(): Promise<boolean> {
    try {
      const client = createHttpWorkspaceWorkerClient({
        baseUrl: this.baseUrl
      });

      const health = await client.health();

      return health.mode === "dllm" || health.mode === "mock";
    } catch {
      return false;
    }
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const client = createHttpWorkspaceWorkerClient({
      baseUrl: this.baseUrl
    });

    const response = await client.refine({
      requestId: createWorkerRequestId(workspace),
      workspace
    });

    return {
      workspace: response.workspace,
      latencyMs: response.latencyMs,
      engineName: response.engineName
    };
  }
}

export class HttpLlmWorkerEngine implements ModelEngine {
  readonly name = "http-llm-worker";
  readonly mode = "llm";

  constructor(
    private readonly baseUrl: string,
    private readonly view: MaskView
  ) {}

  async health(): Promise<boolean> {
    try {
      const client = createHttpWorkspaceWorkerClient({
        baseUrl: this.baseUrl
      });

      const health = await client.health();

      return health.mode === "llm";
    } catch {
      return false;
    }
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const client = createHttpWorkspaceWorkerClient({
      baseUrl: this.baseUrl
    });

    const response = await client.refine({
      requestId: createWorkerRequestId(workspace),
      workspace
    });

    return {
      workspace: response.workspace,
      latencyMs: response.latencyMs,
      engineName: response.engineName
    };
  }
}

export class MockDllmEngine implements ModelEngine {
  readonly name = "mock-dllm-engine";
  readonly mode = "dllm";

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();

    const selectedFact = selectWorkspaceFact(workspace);

    const missing = workspace.authority.missingRules.filter((item) =>
      item.toLowerCase().includes("missing")
    );

    const hasMissingInformation = missing.length > 0;

    const finalResult = hasMissingInformation
      ? `insufficient_context: Required information is missing from the bounded workspace. Missing signals: ${missing.join("; ")}`
      : selectedFact?.content ?? "No current fact was available in the bounded workspace.";

    let refined = workspace;

    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.id}-${refined.revision}`,
      decision: hasMissingInformation ? "remask_required" : "approve",
      status: hasMissingInformation ? "warn" : "pass",
      checkName: "bounded-context-safety",
      summary: hasMissingInformation
        ? "Mock verifier detected missing required information."
        : "Mock verifier accepted the evidence-backed workspace result.",
      findings: [],
      checkedFiles: workspace.scope.changedFiles,
      evidenceIds: selectedFact ? [selectedFact.evidenceId] : [],
      failedRegions: hasMissingInformation ? ["final_result"] : [],
      createdBy: "verifier",
      createdAt
    });

    refined = setFinalResult(refined, {
      summary: finalResult,
      createdBy: "coder",
      createdAt
    });

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}

type SelectedWorkspaceFact = {
  id: string;
  content: string;
  evidenceId: string;
  confidence: number;
};

function createWorkerRequestId(workspace: SharedSemanticWorkspace): string {
  return `${workspace.id}-${workspace.revision}`;
}

function selectWorkspaceFact(workspace: SharedSemanticWorkspace): SelectedWorkspaceFact | undefined {
  const currentAuthorityFact = workspace.authority.facts[0];

  if (currentAuthorityFact) {
    return {
      id: "authority-current",
      content: currentAuthorityFact,
      evidenceId: "workspace-authority",
      confidence: 0.9
    };
  }

  const sensitivePattern =
    workspace.policy.sensitivePatterns[0] ?? workspace.repoFacts.sensitivePatterns[0];

  if (sensitivePattern) {
    return {
      id: "sensitive-policy",
      content: safeSensitiveContent(sensitivePattern),
      evidenceId: "workspace-policy-sensitive-pattern",
      confidence: 0.75
    };
  }

  const staleFact = workspace.repoFacts.staleFacts[0];

  if (staleFact) {
    return {
      id: "repo-stale-fact",
      content: staleFact,
      evidenceId: "workspace-repo-stale-fact",
      confidence: 0.45
    };
  }

  return undefined;
}

function safeSensitiveContent(content: string): string {
  return content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context.";
}