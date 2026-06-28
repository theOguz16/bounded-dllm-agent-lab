import type { BenchmarkFixture } from "../../fixtures/src/index.js";
import {
  createWorkspaceFromPacket,
  type WorkspaceEvidenceFact
} from "../../context-core/src/workspace-adapter.js";
import { createMaskedWorkspaceView } from "../../masking-policy/src/index.js";
import type { ModelEngine } from "../../providers/src/index.js";
import { runRefinementLoop } from "../../refinement-loop/src/index.js";
import {
  addVerifierResult,
  setFinalResult,
  type SharedSemanticWorkspace
} from "../../workspace-core/src/index.js";

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

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `ablation-raw-${fixture.case.id}`
      });

      const firstFact = selectRawFact(workspace);
      const finalResult = firstFact?.content ?? "insufficient_context";

      /**
       * Raw baseline bilinçli olarak zayıftır.
       * Verifier/evidence trace yazmaz.
       */
      return {
        workspace: setFinalResult(workspace, {
          summary: finalResult,
          createdBy: "coder",
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
    description: "Uses bounded workspace selection without grounded evidence trace.",
    maskPolicyEnabled: true,
    verifierEnabled: false,
    groundingEnabled: false,
    refinementEnabled: false,
    async runFixture(fixture) {
      const createdAt = new Date().toISOString();

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `ablation-bounded-${fixture.case.id}`
      });

      const masked = createMaskedWorkspaceView(workspace, "verifier").workspace;
      const selected = selectBoundedFact(masked);
      const shouldRefuseResult = shouldRefuse(masked);
      const finalResult = shouldRefuseResult ? "insufficient_context" : selected.content;

      /**
       * Bu mod bounded context etkisini ölçer.
       * Grounding kapalı olduğu için evidenceIds bilinçli olarak boş bırakılır.
       */
      let refined = addVerifierResult(masked, {
        id: `verifier-${masked.id}-bounded-context`,
        status: shouldRefuseResult ? "warn" : "pass",
        decision: shouldRefuseResult ? "remask_required" : "approve",
        checkName: "ablation-bounded-context",
        summary: shouldRefuseResult
          ? "The bounded workspace marks required information as missing."
          : "The bounded workspace contains enough task-relevant information.",
        findings: [],
        checkedFiles: masked.scope.changedFiles,
        evidenceIds: [],
        failedRegions: shouldRefuseResult ? ["final_result"] : [],
        createdBy: "verifier",
        createdAt
      });

      refined = setFinalResult(refined, {
        summary: finalResult,
        createdBy: "verifier",
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
    description: "Uses bounded workspace selection with real fixture evidence trace, without multi-attempt refinement.",
    maskPolicyEnabled: true,
    verifierEnabled: true,
    groundingEnabled: true,
    refinementEnabled: false,
    async runFixture(fixture) {
      /**
       * Engine burada oluşturulur.
       * Böylece module init sırasında class tanımlanmadan önce new çalışmaz.
       */
      const engine = new AblationGroundedEngine();

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `ablation-grounded-${fixture.case.id}`
      });

      const masked = createMaskedWorkspaceView(workspace, "verifier").workspace;
      const result = await engine.refineWorkspace(masked);

      return {
        workspace: result.workspace,
        engineName: engine.name
      };
    }
  };
}

function createBoundedRefinementRunner(): AblationModeRunner {
  return {
    id: "bounded_refinement",
    label: "Bounded + Grounded + Refinement",
    description: "Uses the refinement loop over the evidence-aware bounded grounded engine.",
    maskPolicyEnabled: true,
    verifierEnabled: true,
    groundingEnabled: true,
    refinementEnabled: true,
    async runFixture(fixture) {
      /**
       * Önemli fix:
       * Bu engine'i createBoundedRefinementRunner içinde üst seviyede oluşturursak
       * ablationModes module init sırasında çalışır ve class henüz initialization'a
       * girmediği için ReferenceError verir.
       *
       * Bu yüzden engine lazy olarak runFixture içinde oluşturulur.
       */
      const engine = new AblationGroundedEngine();

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `ablation-refinement-${fixture.case.id}`
      });

      const result = await runRefinementLoop({
        workspace,
        engine,
        view: "verifier",
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
    const shouldRefuseResult = shouldRefuse(workspace);
    const finalResult = shouldRefuseResult ? "insufficient_context" : selected.content;

    let refined = workspace;

    /**
     * Grounded mod artık generic evidence id üretmez.
     * Adapter'dan gelen gerçek fixture evidenceId kullanılır.
     */
    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.id}-ablation-grounding`,
      status: shouldRefuseResult ? "warn" : "pass",
      decision: shouldRefuseResult ? "remask_required" : "approve",
      checkName: "ablation-grounding",
      summary: shouldRefuseResult
        ? "The bounded workspace marks required information as missing."
        : "Grounded ablation selected a bounded fact and wrote real fixture evidence trace.",
      findings: [],
      checkedFiles: workspace.scope.changedFiles,
      evidenceIds: selected.evidenceId ? [selected.evidenceId] : [],
      failedRegions: shouldRefuseResult ? ["final_result"] : [],
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

type SelectedBoundedFact = {
  id: string;
  content: string;
  evidenceId: string;
  confidence: number;
};

type WorkspaceWithEvidenceFacts = SharedSemanticWorkspace & {
  authority: SharedSemanticWorkspace["authority"] & {
    evidenceFacts?: WorkspaceEvidenceFact[];
  };
  repoFacts: SharedSemanticWorkspace["repoFacts"] & {
    evidenceFacts?: WorkspaceEvidenceFact[];
  };
};

function selectRawFact(workspace: SharedSemanticWorkspace): SelectedBoundedFact | undefined {
  const firstEvidenceFact = getEvidenceFacts(workspace)[0];

  if (firstEvidenceFact) {
    return evidenceFactToSelectedFact(firstEvidenceFact);
  }

  const authorityFact = workspace.authority.facts[0];

  if (authorityFact) {
    return {
      id: "authority-raw",
      content: authorityFact,
      evidenceId: "workspace-authority",
      confidence: 0.7
    };
  }

  const staleFact = workspace.repoFacts.staleFacts[0];

  if (staleFact) {
    return {
      id: "stale-raw",
      content: staleFact,
      evidenceId: "workspace-repo-stale-fact",
      confidence: 0.45
    };
  }

  const sensitivePattern = workspace.policy.sensitivePatterns[0] ?? workspace.repoFacts.sensitivePatterns[0];

  if (sensitivePattern) {
    return {
      id: "sensitive-raw",
      content: sensitivePattern,
      evidenceId: "workspace-policy-sensitive-pattern",
      confidence: 0.4
    };
  }

  return undefined;
}

function selectBoundedFact(workspace: SharedSemanticWorkspace): SelectedBoundedFact {
  const authorityEvidenceFact = findEvidenceFact(workspace, ["current", "correction"]);

  if (authorityEvidenceFact) {
    return evidenceFactToSelectedFact(authorityEvidenceFact);
  }

  const sensitiveEvidenceFact = findEvidenceFact(workspace, ["sensitive"]);

  if (sensitiveEvidenceFact) {
    return {
      ...evidenceFactToSelectedFact(sensitiveEvidenceFact),
      content: safeSensitiveContent(sensitiveEvidenceFact.content)
    };
  }

  const staleEvidenceFact = findEvidenceFact(workspace, ["stale"]);

  if (staleEvidenceFact) {
    return evidenceFactToSelectedFact(staleEvidenceFact);
  }

  const authorityFact = workspace.authority.facts[0];

  if (authorityFact) {
    return {
      id: "authority-current",
      content: authorityFact,
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

  return {
    id: "missing-fact",
    content: "insufficient_context",
    evidenceId: "",
    confidence: 0
  };
}

function getEvidenceFacts(workspace: SharedSemanticWorkspace): WorkspaceEvidenceFact[] {
  const workspaceWithEvidence = workspace as WorkspaceWithEvidenceFacts;

  return [
    ...(workspaceWithEvidence.authority.evidenceFacts ?? []),
    ...(workspaceWithEvidence.repoFacts.evidenceFacts ?? [])
  ];
}

function findEvidenceFact(
  workspace: SharedSemanticWorkspace,
  kinds: WorkspaceEvidenceFact["kind"][]
): WorkspaceEvidenceFact | undefined {
  return getEvidenceFacts(workspace).find((fact) => kinds.includes(fact.kind));
}

function evidenceFactToSelectedFact(fact: WorkspaceEvidenceFact): SelectedBoundedFact {
  return {
    id: fact.id,
    content: fact.content,
    evidenceId: fact.evidenceId,
    confidence: fact.confidence
  };
}

function shouldRefuse(workspace: SharedSemanticWorkspace): boolean {
  return workspace.authority.missingRules.some((item) =>
    item.toLowerCase().includes("missing")
  );
}

function safeSensitiveContent(content: string): string {
  return content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context.";
}