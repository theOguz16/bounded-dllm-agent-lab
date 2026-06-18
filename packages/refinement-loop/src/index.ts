import {
  createMaskedWorkspaceView,
  remaskAfterFailure,
  type MaskView
} from "../../masking-policy/src/index.js";
import type { ModelEngine } from "../../providers/src/index.js";
import type {
  SharedSemanticWorkspace,
  VerifierResult,
  VerifierStatus,
  WorkspaceRegion
} from "../../workspace-core/src/index.js";

export type RefinementLoopAttempt = {
  attempt: number;
  view: MaskView;
  verifierStatus?: VerifierStatus;
  failedRegions: WorkspaceRegion[];
  remasked: boolean;
};

export type RefinementLoopResult = {
  workspace: SharedSemanticWorkspace;
  attempts: RefinementLoopAttempt[];
  completed: boolean;
  engineName: string;
};

export type RefinementLoopInput = {
  workspace: SharedSemanticWorkspace;
  engine: ModelEngine;
  view: MaskView;
  maxAttempts?: number;
  remaskOnStatuses?: VerifierStatus[];
};

export async function runRefinementLoop(input: RefinementLoopInput): Promise<RefinementLoopResult> {
  const maxAttempts = input.maxAttempts ?? 2;
  const remaskOnStatuses = input.remaskOnStatuses ?? ["fail", "warn"];
  let current = createMaskedWorkspaceView(input.workspace, input.view).workspace;
  const attempts: RefinementLoopAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await input.engine.refineWorkspace(current);
    current = result.workspace;
    const verifierResult = latestVerifierResult(current);
    const failedRegions = resolveFailedRegions(verifierResult);
    const shouldRemask = Boolean(
      verifierResult &&
        remaskOnStatuses.includes(verifierResult.status) &&
        failedRegions.length &&
        attempt < maxAttempts
    );

    // Refinement loop'un araştırmadaki anlamı şudur: verifier bir alanı sorunlu
    // bulursa modelden bütün workspace'i yeniden yazmasını istemiyoruz. Sadece
    // sorunlu region tekrar maskeleniyor. Bu, dLLM'in masked refinement doğasına
    // LLM-style "baştan cevap üret" yaklaşımından daha yakın bir akıştır.
    attempts.push({
      attempt,
      view: input.view,
      verifierStatus: verifierResult?.status,
      failedRegions,
      remasked: shouldRemask
    });

    if (!shouldRemask) {
      return {
        workspace: current,
        attempts,
        completed: !verifierResult || !remaskOnStatuses.includes(verifierResult.status) || failedRegions.length === 0,
        engineName: result.engineName
      };
    }

    // Burada bütün context penceresini büyütmek veya sohbet geçmişini şişirmek yerine,
    // verifier'ın işaret ettiği küçük alanı tekrar açıyoruz. Dar context araştırması
    // açısından kritik fark bu: problem nerede ise sadece orası yeniden düşünülür.
    current = remaskAfterFailure(current, failedRegions);
  }

  return {
    workspace: current,
    attempts,
    completed: false,
    engineName: input.engine.name
  };
}

function latestVerifierResult(workspace: SharedSemanticWorkspace): VerifierResult | undefined {
  return workspace.verifierResults.at(-1);
}

function resolveFailedRegions(verifierResult: VerifierResult | undefined): WorkspaceRegion[] {
  if (!verifierResult) return [];
  return verifierResult.failedRegions;
}
