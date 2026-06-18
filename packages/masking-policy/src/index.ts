import { markRegionsMasked, type SharedSemanticWorkspace, type WorkspaceRegion } from "../../workspace-core/src/index.js";

export type MaskView = "planner" | "implementer" | "reviewer" | "verifier" | "boundary";
export type RegionAccess = "read" | "write" | "locked" | "masked";

export type MaskingPolicy = {
  view: MaskView;
  regions: WorkspaceRegion[];
  reason: string;
};

export type MaskRegionRule = {
  region: WorkspaceRegion;
  access: RegionAccess;
  reason: string;
};

export type MaskViewDefinition = {
  view: MaskView;
  purpose: string;
  readableRegions: WorkspaceRegion[];
  writableRegions: WorkspaceRegion[];
  lockedRegions: WorkspaceRegion[];
  maskedRegions: WorkspaceRegion[];
  rules: MaskRegionRule[];
};

export type MaskedWorkspaceView = {
  view: MaskView;
  definition: MaskViewDefinition;
  workspace: SharedSemanticWorkspace;
};

const allRegions = [
  "plan",
  "patch_intent",
  "risk_analysis",
  "review",
  "boundary_decision",
  "verifier_feedback",
  "final_result"
] satisfies WorkspaceRegion[];

export const maskViewDefinitions: Record<MaskView, MaskViewDefinition> = {
  planner: createMaskViewDefinition({
    view: "planner",
    purpose: "Plan görevi, dar context içinde yapılacak işi ve riskleri sınırlar.",
    writableRegions: ["plan", "risk_analysis"],
    readableRegions: ["boundary_decision", "verifier_feedback"],
    lockedRegions: ["patch_intent", "review", "final_result"]
  }),
  implementer: createMaskViewDefinition({
    view: "implementer",
    purpose: "Implementer görevi, planı bozmadan patch intent veya çözüm niyeti üretir.",
    writableRegions: ["patch_intent", "final_result"],
    readableRegions: ["plan", "risk_analysis", "boundary_decision", "verifier_feedback"],
    lockedRegions: ["review"]
  }),
  reviewer: createMaskViewDefinition({
    view: "reviewer",
    purpose: "Reviewer görevi, üretilen iddialarda conflict, scope drift ve risk arar.",
    writableRegions: ["review", "risk_analysis"],
    readableRegions: ["plan", "patch_intent", "boundary_decision", "verifier_feedback", "final_result"],
    lockedRegions: []
  }),
  verifier: createMaskViewDefinition({
    view: "verifier",
    purpose: "Verifier görevi, claim ve final result zincirini test/kanıt/policy açısından denetler.",
    writableRegions: ["verifier_feedback"],
    readableRegions: ["plan", "patch_intent", "risk_analysis", "review", "boundary_decision", "final_result"],
    lockedRegions: []
  }),
  boundary: createMaskViewDefinition({
    view: "boundary",
    purpose: "Boundary görevi, context yeterli mi, scope güvenli mi, hassas bilgi var mı sorularını cevaplar.",
    writableRegions: ["boundary_decision"],
    readableRegions: ["plan", "risk_analysis", "verifier_feedback"],
    lockedRegions: ["patch_intent", "review", "final_result"]
  })
};

export function defaultMaskingPolicy(view: MaskView): MaskingPolicy {
  const definition = maskViewDefinitions[view];

  return {
    view,
    regions: definition.maskedRegions,
    reason: `${view} view refines ${definition.maskedRegions.join(", ")}`
  };
}

export function getMaskViewDefinition(view: MaskView): MaskViewDefinition {
  return maskViewDefinitions[view];
}

export function createMaskedWorkspaceView(
  workspace: SharedSemanticWorkspace,
  view: MaskView
): MaskedWorkspaceView {
  const definition = getMaskViewDefinition(view);

  // MaskedWorkspaceView doğrudan model prompt'u değildir; modelin görebileceği ve
  // doldurabileceği workspace sözleşmesidir. Böylece planner, implementer veya
  // verifier aynı shared state'i kullanır ama herkes aynı alanı ezmeye çalışmaz.
  return {
    view,
    definition,
    workspace: applyMaskingPolicy(workspace, defaultMaskingPolicy(view))
  };
}

export function canWriteRegion(view: MaskView, region: WorkspaceRegion): boolean {
  return maskViewDefinitions[view].writableRegions.includes(region);
}

export function applyMaskingPolicy(workspace: SharedSemanticWorkspace, policy: MaskingPolicy): SharedSemanticWorkspace {
  // Masking artık sessiz bir array güncellemesi değil. Ortak workspace'te hangi rolün
  // hangi alanı yeniden üretime açtığını trace'e yazıyoruz. Bu bilgi olmadan çoklu
  // agent akışında "kim neyi ezdi?" sorusunu sonradan ölçmek zorlaşır.
  return markRegionsMasked(workspace, policy.regions, policy.view, policy.reason);
}

export function remaskAfterFailure(workspace: SharedSemanticWorkspace, failedRegions: WorkspaceRegion[]): SharedSemanticWorkspace {
  return markRegionsMasked(workspace, failedRegions, "verifier", "Verifier requested failed regions to be remasked.");
}

function createMaskViewDefinition(input: {
  view: MaskView;
  purpose: string;
  readableRegions: WorkspaceRegion[];
  writableRegions: WorkspaceRegion[];
  lockedRegions: WorkspaceRegion[];
}): MaskViewDefinition {
  const readableRegions = unique([...input.readableRegions, ...input.writableRegions]);
  const lockedRegions = unique(input.lockedRegions);
  const maskedRegions = unique(input.writableRegions);

  // Writable region aynı zamanda masked region'dır. Çünkü dLLM yaklaşımında modelin
  // görevi bütün cevabı baştan yazmak değil, kendisine açılan boşluğu/refinement
  // alanını doldurmaktır. Locked region ise agent'ın görse bile değiştirmemesi
  // gereken alandır; bu scope drift'i azaltmak için kritik.
  const rules = allRegions.map((region) => ({
    region,
    access: resolveAccess(region, readableRegions, maskedRegions, lockedRegions),
    reason: explainAccess(region, input.view, readableRegions, maskedRegions, lockedRegions)
  }));

  return {
    view: input.view,
    purpose: input.purpose,
    readableRegions,
    writableRegions: maskedRegions,
    lockedRegions,
    maskedRegions,
    rules
  };
}

function resolveAccess(
  region: WorkspaceRegion,
  readableRegions: WorkspaceRegion[],
  maskedRegions: WorkspaceRegion[],
  lockedRegions: WorkspaceRegion[]
): RegionAccess {
  if (maskedRegions.includes(region)) return "masked";
  if (lockedRegions.includes(region)) return "locked";
  if (readableRegions.includes(region)) return "read";
  return "locked";
}

function explainAccess(
  region: WorkspaceRegion,
  view: MaskView,
  readableRegions: WorkspaceRegion[],
  maskedRegions: WorkspaceRegion[],
  lockedRegions: WorkspaceRegion[]
): string {
  if (maskedRegions.includes(region)) return `${view} can refine ${region}.`;
  if (readableRegions.includes(region)) return `${view} can read ${region} for context.`;
  if (lockedRegions.includes(region)) return `${view} must not edit ${region}.`;
  return `${view} has no task-relevant access to ${region}.`;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
