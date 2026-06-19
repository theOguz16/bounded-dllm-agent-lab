import {
  addClaim,
  addVerifierResult,
  setBoundaryDecision,
  setFinalResult,
  type SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";
import {
  createRefineRequest,
  isHealthResponse,
  isRefineResponse
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
    const response = await fetch(`${this.baseUrl}/health`);
    const body: unknown = await response.json();

    // Python worker ayrı bir runtime olduğu için sadece HTTP 200'e güvenmiyoruz.
    // Dönen JSON'un beklenen health sözleşmesine uyduğunu da kontrol ediyoruz.
    return response.ok && isHealthResponse(body);
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const request = createRefineRequest({
      requestId: `${workspace.id}-${workspace.version}`,
      view: this.view,
      workspace
    });
    const response = await fetch(`${this.baseUrl}/refine`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    const body: unknown = await response.json();

    // Dil sınırı burada başlıyor: TypeScript tarafında tipler var, Python tarafında
    // JSON var. Bu nedenle refine cevabını kullanmadan önce contract guard ile
    // doğruluyoruz; aksi halde bozuk worker cevabı benchmark sonucunu kirletebilir.
    if (!response.ok || !isRefineResponse(body)) {
      throw new Error(`Invalid dLLM worker response from ${this.baseUrl}/refine`);
    }

    return {
      workspace: body.workspace,
      latencyMs: Date.now() - started,
      engineName: body.engineName
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
    const response = await fetch(`${this.baseUrl}/health`);
    const body: unknown = await response.json();

    // LLM baseline worker da aynı HTTP sözleşmesini konuşur; fark inference
    // ailesindedir. Health guard burada "çalışıyor" ile "beklenen contract"ı ayırır.
    return response.ok && isHealthResponse(body) && body.mode === "llm";
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const request = createRefineRequest({
      requestId: `${workspace.id}-${workspace.version}`,
      view: this.view,
      workspace
    });
    const response = await fetch(`${this.baseUrl}/refine`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });
    const body: unknown = await response.json();

    // Baseline worker dış API kullandığı için bozuk JSON, timeout sonrası yarım cevap
    // veya schema dışı workspace üretme riski taşır. Contract guard bu kirlenmeyi
    // benchmark metriğine sessizce sokmamızı engeller.
    if (!response.ok || !isRefineResponse(body)) {
      throw new Error(`Invalid LLM worker response from ${this.baseUrl}/refine: ${compactWorkerBody(body)}`);
    }

    return {
      workspace: body.workspace,
      latencyMs: Date.now() - started,
      engineName: body.engineName
    };
  }
}

function compactWorkerBody(body: unknown): string {
  const text = JSON.stringify(body);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export class MockDllmEngine implements ModelEngine {
  readonly name = "mock-dllm-engine";
  readonly mode = "dllm";

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();
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
          missingInformation: missing,
          decidedBy: "boundary" as const,
          createdAt
        }
      : {
          status: "sufficient_context" as const,
          reason: "The bounded context packet contains enough task-relevant evidence.",
          missingInformation: [],
          decidedBy: "boundary" as const,
          createdAt
        };
    const finalResult =
      currentFact?.content ??
      (sensitiveFact ? safeSensitiveContent : "No current fact was available in the bounded context packet.");
    let refined = setBoundaryDecision(workspace, boundaryDecision);

    if (selectedFact) {
      refined = addClaim(refined, {
        id: `claim-${selectedFact.id}`,
        region: "final_result",
        actor: "implementer",
        content: selectedFact.kind === "sensitive" ? safeSensitiveContent : selectedFact.content,
        evidenceIds: [selectedFact.evidenceId],
        confidence: selectedFact.confidence,
        state: "accepted",
        createdAt
      });
    }

    // Verifier sonucu burada basit görünüyor ama mimari olarak çok önemli: agent'ın
    // ürettiği claim ile boundary kararı aynı workspace'te doğrulanabilir bir kayıt
    // bırakıyor. Gerçek model geldiğinde bu alan lint, test, policy ve conflict
    // kontrollerinin çıktısını taşıyacak.
    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.packet.id}`,
      status: boundaryDecision.status === "sufficient_context" || boundaryDecision.status === "insufficient_context" ? "pass" : "warn",
      checkName: "bounded-context-safety",
      summary: "Mock verifier checked boundary status and evidence-backed claim production.",
      evidenceIds: selectedFact ? [selectedFact.evidenceId] : [],
      failedRegions: [],
      createdAt
    });
    refined = setFinalResult(refined, finalResult, "implementer", createdAt);

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}
