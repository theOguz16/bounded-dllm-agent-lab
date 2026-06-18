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
    // Sensitive fact'lerde content içinde hem güvenli politika cümlesi hem de raw değer
    // bulunabilir. Mock engine gerçek bir model değil; pipeline'ı test eden deterministik
    // bir motor. Bu yüzden raw değeri özellikle kırpıyoruz. Böylece sensitive leakage
    // metriği "input'ta sır var" diye değil, "output'a sır kopyalandı mı" diye ölçülür.
    const safeSensitiveContent = sensitiveFact?.content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context.";
    const missing = workspace.packet.mustNotInfer.filter((item) => item.toLowerCase().includes("missing"));
    // mustNotInfer içinde missing sinyali varsa doğru davranış doğrudan cevap vermek değil,
    // boundaryDecision üretmektir. Bu, ileride BoundaryMask rolünün simüle ettiği davranışın
    // en küçük deterministik karşılığıdır.
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
                content: selectedFact.kind === "sensitive" ? safeSensitiveContent : selectedFact.content,
                evidenceIds: [selectedFact.evidenceId],
                confidence: selectedFact.confidence
              }
            ]
          : workspace.claims,
        boundaryDecision,
        finalResult:
          currentFact?.content ??
          (sensitiveFact ? safeSensitiveContent : "No current fact was available in the bounded context packet.")
      },
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}
