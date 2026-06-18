import type { SharedSemanticWorkspace } from "../../workspace-core/src/index.js";

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

export class MockDllmEngine implements ModelEngine {
  readonly name = "mock-dllm-engine";
  readonly mode = "dllm";

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const currentFact = workspace.packet.facts.find((fact) => fact.kind === "correction" || fact.kind === "current");
    const sensitiveFact = workspace.packet.facts.find((fact) => fact.kind === "sensitive");
    const selectedFact = currentFact ?? sensitiveFact;
    const missing = workspace.packet.mustNotInfer.filter((item) => item.toLowerCase().includes("missing"));
    const boundaryDecision = missing.length
      ? {
          status: "insufficient_context" as const,
          reason: "Required information is missing from the bounded context packet.",
          missingInformation: missing
        }
      : {
          status: "sufficient_context" as const,
          reason: "The bounded context packet contains enough task-relevant evidence.",
          missingInformation: []
        };

    return {
      workspace: {
        ...workspace,
        claims: selectedFact
          ? [
              ...workspace.claims,
              {
                id: `claim-${selectedFact.id}`,
                region: "final_result",
                content: selectedFact.kind === "sensitive" ? "Sensitive information must stay out of default context." : selectedFact.content,
                evidenceIds: [selectedFact.evidenceId],
                confidence: selectedFact.confidence
              }
            ]
          : workspace.claims,
        boundaryDecision,
        finalResult:
          currentFact?.content ??
          (sensitiveFact ? "Sensitive information must stay out of default context." : "No current fact was available in the bounded context packet.")
      },
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}
