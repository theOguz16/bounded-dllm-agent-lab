import { createWorkspace, type SharedSemanticWorkspace } from "../../workspace-core/src/index.js";
import { createMaskedWorkspaceView } from "../../masking-policy/src/index.js";
import type { BenchmarkFixture } from "../../fixtures/src/index.js";
import { MockDllmEngine } from "../../providers/src/index.js";
import { runRefinementLoop } from "../../refinement-loop/src/index.js";

export type ArchitectureId =
  | "bounded-dllm-refinement-loop"
  | "long-context-llm-mock"
  | "rag-llm-mock"
  | "synthetic-context-llm-mock";

export type ArchitectureMetadata = {
  id: ArchitectureId;
  label: string;
  family: "bounded_dllm" | "long_context_llm" | "rag_llm" | "synthetic_context_llm";
  isMock: boolean;
  description: string;
};

export type ArchitectureRunResult = {
  workspace: SharedSemanticWorkspace;
  engineName: string;
};

export type ArchitectureRunOptions = {
  maxAttempts: number;
};

export type ArchitectureRunner = ArchitectureMetadata & {
  runFixture(fixture: BenchmarkFixture, options: ArchitectureRunOptions): Promise<ArchitectureRunResult>;
};

export const architectureRegistry: Record<ArchitectureId, ArchitectureRunner> = {
  "bounded-dllm-refinement-loop": createBoundedDllmRunner(),
  "long-context-llm-mock": createBaselineRunner({
    id: "long-context-llm-mock",
    label: "Long Context LLM Mock",
    family: "long_context_llm",
    description: "Mock baseline that represents sending broad context to one general LLM."
  }),
  "rag-llm-mock": createBaselineRunner({
    id: "rag-llm-mock",
    label: "RAG LLM Mock",
    family: "rag_llm",
    description: "Mock baseline that represents retrieval before general LLM generation."
  }),
  "synthetic-context-llm-mock": createBaselineRunner({
    id: "synthetic-context-llm-mock",
    label: "Synthetic Context LLM Mock",
    family: "synthetic_context_llm",
    description: "Mock baseline that represents synthetic context enrichment before generation."
  })
};

export function getArchitectureRunner(id: ArchitectureId): ArchitectureRunner {
  return architectureRegistry[id];
}

export function listArchitectures(): ArchitectureMetadata[] {
  return Object.values(architectureRegistry).map(({ runFixture, ...metadata }) => metadata);
}

export function parseArchitectureId(value: string | undefined): ArchitectureId {
  if (value && value in architectureRegistry) return value as ArchitectureId;
  return "bounded-dllm-refinement-loop";
}

function createBoundedDllmRunner(): ArchitectureRunner {
  const engine = new MockDllmEngine();

  return {
    id: "bounded-dllm-refinement-loop",
    label: "Bounded dLLM Refinement Loop",
    family: "bounded_dllm",
    isMock: true,
    description: "Current bounded-context architecture with mask views and verifier-guided refinement.",
    async runFixture(fixture, options) {
      const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
      const result = await runRefinementLoop({
        workspace,
        engine,
        view: "boundary",
        maxAttempts: options.maxAttempts
      });

      return {
        workspace: result.workspace,
        engineName: engine.name
      };
    }
  };
}

function createBaselineRunner(input: Omit<ArchitectureMetadata, "isMock">): ArchitectureRunner {
  const engine = new MockDllmEngine();

  return {
    ...input,
    isMock: true,
    async runFixture(fixture) {
      const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
      const masked = createMaskedWorkspaceView(workspace, "boundary");
      const result = await engine.refineWorkspace(masked.workspace);

      // Bu baseline runner'lar henüz gerçek mimari davranışı iddia etmez. Ama aynı
      // BenchmarkFixture -> Workspace output sözleşmesini kullanırlar. Böylece lab,
      // gerçek long-context/RAG/synthetic provider geldiğinde runner değiştirmeden
      // adil karşılaştırma yapabilecek hale gelir.
      return {
        workspace: result.workspace,
        engineName: `${input.id}:${engine.name}`
      };
    }
  };
}
