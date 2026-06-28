import {
  addVerifierResult,
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

    /**
     * Python worker ayrı bir runtime olduğu için sadece HTTP 200'e güvenmiyoruz.
     * Dönen JSON'un beklenen health sözleşmesine uyduğunu da kontrol ediyoruz.
     */
    return response.ok && isHealthResponse(body);
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();

    const request = createRefineRequest({
      requestId: `${workspace.id}-${workspace.revision}`,
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

    /**
     * Dil sınırı burada başlıyor: TypeScript tarafında tipler var, Python tarafında
     * JSON var. Bu nedenle refine cevabını kullanmadan önce contract guard ile
     * doğruluyoruz; aksi halde bozuk worker cevabı benchmark sonucunu kirletebilir.
     */
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

    /**
     * LLM baseline worker da aynı HTTP sözleşmesini konuşur; fark inference
     * ailesindedir. Health guard burada "çalışıyor" ile "beklenen contract"ı ayırır.
     */
    return response.ok && isHealthResponse(body) && body.mode === "llm";
  }

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();

    const request = createRefineRequest({
      requestId: `${workspace.id}-${workspace.revision}`,
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

    /**
     * Baseline worker dış API kullandığı için bozuk JSON, timeout sonrası yarım cevap
     * veya schema dışı workspace üretme riski taşır. Contract guard bu kirlenmeyi
     * benchmark metriğine sessizce sokmamızı engeller.
     */
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

export class MockDllmEngine implements ModelEngine {
  readonly name = "mock-dllm-engine";
  readonly mode = "dllm";

  async refineWorkspace(workspace: SharedSemanticWorkspace): Promise<RefinementResult> {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();

    /**
     * Eski mock engine workspace.packet.facts okuyordu.
     * Yeni canonical workspace modelinde authority/current bilgi workspace.authority,
     * sensitive bilgi policy/repoFacts, eksik bilgi sinyali ise authority.missingRules
     * altında tutulur.
     */
    const selectedFact = selectWorkspaceFact(workspace);

    const missing = workspace.authority.missingRules.filter((item) =>
      item.toLowerCase().includes("missing")
    );

    const hasMissingInformation = missing.length > 0;

    const finalResult = hasMissingInformation
      ? `insufficient_context: Required information is missing from the bounded workspace. Missing signals: ${missing.join("; ")}`
      : selectedFact?.content ?? "No current fact was available in the bounded workspace.";

    let refined = workspace;

    /**
     * addClaim kaldırıldı.
     *
     * Bu mock provider için claim zorunlu değil; evaluator ve benchmark için
     * verifierResult + finalResult yeterli canonical sinyali üretir.
     * WorkspaceClaim shape'i değiştiği için burada claim yazmak gereksiz type
     * kırılmasına sebep oluyordu.
     */
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

  const sensitivePattern = workspace.policy.sensitivePatterns[0] ?? workspace.repoFacts.sensitivePatterns[0];

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
  /**
   * Fixture'larda sensitive content bazen "Raw value:" ile gerçek sırrı taşıyordu.
   * Mock engine deterministik kalsın ama raw secret output'a kopyalanmasın diye
   * bu kısmı kırpıyoruz.
   */
  return content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context.";
}

function compactWorkerBody(body: unknown): string {
  const text = JSON.stringify(body);

  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}