import type { BenchmarkFixture } from "../../fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../masking-policy/src/index.js";
import { MockDllmEngine, type ModelEngine } from "../../providers/src/index.js";
import { runRefinementLoop } from "../../refinement-loop/src/index.js";
import {
  addClaim,
  addVerifierResult,
  setBoundaryDecision,
  setFinalResult,
  type SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";
import { createWorkspace } from "../../workspace-core/src/index.js";

export type AblationModeId =
  | "raw_fact_only"
  | "bounded_context"
  | "bounded_grounded"
  | "bounded_refinement";

export type AblationModeMetadata = {
  id: AblationModeId;
  label: string;
  description: string;
  maskPolicyEnabled: boolean;
  verifierEnabled: boolean;
  groundingEnabled: boolean;
  refinementEnabled: boolean;
};

export type AblationRunOutput = {
  workspace: SharedSemanticWorkspace;
  engineName: string;
};

export type AblationModeRunner = AblationModeMetadata & {
  runFixture(fixture: BenchmarkFixture): Promise<AblationRunOutput>;
};

export const ablationModes: Record<AblationModeId, AblationModeRunner> = {
  raw_fact_only: createRawFactOnlyRunner(),
  bounded_context: createBoundedContextRunner(),
  bounded_grounded: createBoundedGroundedRunner(),
  bounded_refinement: createBoundedRefinementRunner()
};

export function listAblationModes(): AblationModeMetadata[] {
  return Object.values(ablationModes).map(({ runFixture, ...metadata }) => metadata);
}

export function getAblationMode(id: AblationModeId): AblationModeRunner {
  return ablationModes[id];
}

function createRawFactOnlyRunner(): AblationModeRunner {
  return {
    id: "raw_fact_only",
    label: "Raw Fact Only",
    description: "Weak baseline that writes the first available fact without boundary, grounding, or verifier trace.",
    maskPolicyEnabled: false,
    verifierEnabled: false,
    groundingEnabled: false,
    refinementEnabled: false,
    async runFixture(fixture) {
      const createdAt = new Date().toISOString();
      const workspace = createWorkspace(`ablation-raw-${fixture.case.id}`, fixture.packet);
      const firstFact = workspace.packet.facts[0];
      const finalResult = firstFact?.content ?? "insufficient_context";

      // Raw baseline bilinçli olarak zayıftır. İlk fact'i yazar, stale/sensitive/missing
      // ayrımı yapmaz. Böylece "model veya sistem hiçbir boundary katmanı olmadan ne kadar
      // drift/leakage üretir?" sorusuna kontrollü bir alt sınır verir.
      return {
        workspace: setFinalResult(workspace, {
          summary: finalResult,
          createdBy: "implementer",
          createdAt
        }),
        engineName: "ablation-raw-fact-only"
      };
    }
  };
}

function createBoundedContextRunner(): AblationModeRunner {
  return {
    id: "bounded_context",
    label: "Bounded Context",
    description: "Uses bounded packet selection and boundary decisions but does not add evidence claims or verifier results.",
    maskPolicyEnabled: true,
    verifierEnabled: false,
    groundingEnabled: false,
    refinementEnabled: false,
    async runFixture(fixture) {
      const createdAt = new Date().toISOString();
      const workspace = createWorkspace(`ablation-bounded-${fixture.case.id}`, fixture.packet);
      const masked = createMaskedWorkspaceView(workspace, "boundary").workspace;
      const selected = selectBoundedFact(masked);
      const boundaryStatus = shouldRefuse(masked) ? "insufficient_context" : "sufficient_context";
      let refined = setBoundaryDecision(masked, {
        status: boundaryStatus,
        reason: boundaryStatus === "insufficient_context"
          ? "The bounded packet marks required information as missing."
          : "The bounded packet contains enough task-relevant information.",
        missingInformation: boundaryStatus === "insufficient_context" ? masked.packet.mustNotInfer : [],
        decidedBy: "boundary",
        createdAt
      });

      // Bu mod doğru fact seçimini ve boundary kararını ölçer ama evidence claim ve
      // verifier yazmaz. Eğer task başarısı artıp evidence/trace zayıf kalıyorsa,
      // "dar context yardımcı oldu ama sonuç henüz akademik olarak izlenebilir değil"
      // diyebiliriz.
      refined = setFinalResult(refined, {
        summary: boundaryStatus === "insufficient_context" ? "insufficient_context" : selected.content,
        createdBy: "boundary",
        createdAt
      });

      return {
        workspace: refined,
        engineName: "ablation-bounded-context"
      };
    }
  };
}

function createBoundedGroundedRunner(): AblationModeRunner {
  return {
    id: "bounded_grounded",
    label: "Bounded + Grounded",
    description: "Uses bounded packet selection with evidence claims and verifier trace, without multi-attempt refinement.",
    maskPolicyEnabled: true,
    verifierEnabled: true,
    groundingEnabled: true,
    refinementEnabled: false,
    async runFixture(fixture) {
      const engine = new AblationGroundedEngine();
      const workspace = createWorkspace(`ablation-grounded-${fixture.case.id}`, fixture.packet);
      const masked = createMaskedWorkspaceView(workspace, "boundary").workspace;
      const result = await engine.refineWorkspace(masked);

      return {
        workspace: result.workspace,
        engineName: engine.name
      };
    }
  };
}

function createBoundedRefinementRunner(): AblationModeRunner {
  const engine = new MockDllmEngine();

  return {
    id: "bounded_refinement",
    label: "Bounded + Grounded + Refinement",
    description: "Uses the existing refinement loop over the bounded grounded mock engine.",
    maskPolicyEnabled: true,
    verifierEnabled: true,
    groundingEnabled: true,
    refinementEnabled: true,
    async runFixture(fixture) {
      const workspace = createWorkspace(`ablation-refinement-${fixture.case.id}`, fixture.packet);
      const result = await runRefinementLoop({
        workspace,
        engine,
        view: "boundary",
        maxAttempts: 2
      });

      return {
        workspace: result.workspace,
        engineName: "ablation-refinement-loop"
      };
    }
  };
}

class AblationGroundedEngine implements ModelEngine {
  readonly name = "ablation-grounded-engine";
  readonly mode = "dllm" as const;

  async refineWorkspace(workspace: SharedSemanticWorkspace) {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();
    const selected = selectBoundedFact(workspace);
    const boundaryStatus = shouldRefuse(workspace) ? "insufficient_context" : "sufficient_context";
    let refined = setBoundaryDecision(workspace, {
      status: boundaryStatus,
      reason: boundaryStatus === "insufficient_context"
        ? "The bounded packet marks required information as missing."
        : "The bounded packet contains enough task-relevant information.",
      missingInformation: boundaryStatus === "insufficient_context" ? workspace.packet.mustNotInfer : [],
      decidedBy: "boundary",
      createdAt
    });
    const finalResult = boundaryStatus === "insufficient_context" ? "insufficient_context" : selected.content;

    if (selected.evidenceId) {
      refined = addClaim(refined, {
        id: `claim-${selected.id}`,
        region: "final_result",
        actor: "implementer",
        content: finalResult,
        evidenceIds: [selected.evidenceId],
        confidence: selected.confidence,
        state: "accepted",
        createdAt
      });
    }

    // Grounded modun farkı burada görünür: final result sadece yazılmaz, hangi fact'e
    // dayandığı claim ve verifier üzerinden izlenebilir hale gelir. Bu katman olmadan
    // doğru cevap almak mümkün olabilir ama araştırma çıktısı denetlenemez kalır.
    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.packet.id}`,
      status: "pass",
      checkName: "ablation-grounding",
      summary: "Grounded ablation selected a bounded fact and wrote evidence trace.",
      evidenceIds: selected.evidenceId ? [selected.evidenceId] : [],
      failedRegions: [],
      createdAt
    });
    setFinalResult(refined, {
      summary: finalResult,
      createdBy: "implementer",
      createdAt
    });

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}

function selectBoundedFact(workspace: SharedSemanticWorkspace) {
  const facts = workspace.packet.facts;
  const sensitive = facts.find((fact) => fact.kind === "sensitive");
  const current = facts.find((fact) => fact.kind === "correction" || fact.kind === "current");
  const selected = current ?? sensitive ?? facts[0];

  if (!selected) {
    return {
      id: "missing-fact",
      content: "insufficient_context",
      evidenceId: "",
      confidence: 0
    };
  }

  if (selected.kind === "sensitive") {
    return {
      ...selected,
      content: selected.content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context."
    };
  }

  return selected;
}

function shouldRefuse(workspace: SharedSemanticWorkspace): boolean {
  return workspace.packet.mustNotInfer.some((item) => item.toLowerCase().includes("missing"));
}
