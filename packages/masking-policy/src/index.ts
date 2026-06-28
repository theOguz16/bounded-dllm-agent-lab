import {
  markRegionsMasked,
  type SharedSemanticWorkspace,
  type WorkspaceRegion,
  type WorkspaceRole
} from "../../workspace-core/src/index.js";

export type MaskView =
  | "planner"
  | "coder"
  | "verifier"
  | "tester"
  | "remask"
  | "merge";

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

/**
 * Canonical workspace regions.
 *
 * Eski yapıdaki plan / review / risk_analysis / boundary_decision /
 * verifier_feedback alanlarını burada tutmuyoruz.
 *
 * Yeni mimaride:
 * - plan              -> patch_plan
 * - review            -> verifier_result
 * - risk_analysis     -> verifier_result.findings
 * - boundary_decision -> verifier_result veya merge_decision
 * - verifier_feedback -> verifier_result
 */
const allRegions = [
  "task",
  "scope",
  "authority",
  "policy",
  "repo_facts",
  "patch_intent",
  "role_view",
  "claim",
  "patch_plan",
  "patch_draft",
  "verifier_result",
  "test_signal",
  "remask_request",
  "conflict",
  "merge_decision",
  "final_result"
] satisfies WorkspaceRegion[];

/**
 * Mask view artık eski research rolleriyle değil, runtime rolleriyle çalışır.
 * implementer / reviewer / boundary kaldırıldı.
 */
export const maskViewDefinitions: Record<MaskView, MaskViewDefinition> = {
  planner: createMaskViewDefinition({
    view: "planner",
    purpose: "Planner görevi, task/scope/authority/policy bilgisinden güvenli patch plan üretir.",
    writableRegions: ["claim", "patch_plan"],
    readableRegions: ["task", "scope", "authority", "policy", "repo_facts", "patch_intent"],
    lockedRegions: ["patch_draft", "verifier_result", "test_signal", "remask_request", "merge_decision", "final_result"]
  }),

  coder: createMaskViewDefinition({
    view: "coder",
    purpose: "Coder görevi, patch planı scope dışına çıkmadan patch draft'a dönüştürür.",
    writableRegions: ["claim", "patch_draft"],
    readableRegions: ["task", "scope", "authority", "policy", "repo_facts", "patch_intent", "patch_plan"],
    lockedRegions: ["verifier_result", "test_signal", "remask_request", "merge_decision", "final_result"]
  }),

  verifier: createMaskViewDefinition({
    view: "verifier",
    purpose: "Verifier görevi, patch plan/draft zincirini scope, authority, ownership, test ve sensitive boundary açısından denetler.",
    writableRegions: ["verifier_result", "claim"],
    readableRegions: [
      "task",
      "scope",
      "authority",
      "policy",
      "repo_facts",
      "patch_intent",
      "patch_plan",
      "patch_draft",
      "test_signal",
      "remask_request"
    ],
    lockedRegions: ["merge_decision", "final_result"]
  }),

  tester: createMaskViewDefinition({
    view: "tester",
    purpose: "Tester görevi, değişen dosyalar ve policy üzerinden test sinyali üretir.",
    writableRegions: ["test_signal", "claim"],
    readableRegions: ["task", "scope", "policy", "repo_facts", "patch_intent", "patch_plan", "patch_draft"],
    lockedRegions: ["verifier_result", "remask_request", "merge_decision", "final_result"]
  }),

  remask: createMaskViewDefinition({
    view: "remask",
    purpose: "Remask görevi, verifier'ın işaretlediği failed region'ları lokal olarak yeniden üretime açar.",
    writableRegions: ["remask_request", "patch_draft", "claim"],
    readableRegions: [
      "task",
      "scope",
      "authority",
      "policy",
      "patch_plan",
      "patch_draft",
      "verifier_result",
      "test_signal"
    ],
    lockedRegions: ["merge_decision", "final_result"]
  }),

  merge: createMaskViewDefinition({
    view: "merge",
    purpose: "Merge görevi, claim/verifier/test/remask sinyallerini birleştirip final karar üretir.",
    writableRegions: ["conflict", "merge_decision", "final_result"],
    readableRegions: [
      "task",
      "scope",
      "authority",
      "policy",
      "repo_facts",
      "patch_intent",
      "claim",
      "patch_plan",
      "patch_draft",
      "verifier_result",
      "test_signal",
      "remask_request"
    ],
    lockedRegions: []
  })
};

export function defaultMaskingPolicy(view: MaskView): MaskingPolicy {
  const definition = maskViewDefinitions[view];

  return {
    view,
    regions: definition.maskedRegions,
    reason: `${view} view refines ${definition.maskedRegions.join(", ")}.`
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

  /**
   * MaskedWorkspaceView model prompt'u değildir.
   * Bu, role-specific workspace contract'tır.
   */
  return {
    view,
    definition,
    workspace: applyMaskingPolicy(workspace, defaultMaskingPolicy(view))
  };
}

export function canWriteRegion(view: MaskView, region: WorkspaceRegion): boolean {
  return maskViewDefinitions[view].writableRegions.includes(region);
}

export function applyMaskingPolicy(
  workspace: SharedSemanticWorkspace,
  policy: MaskingPolicy
): SharedSemanticWorkspace {
  /**
   * Masking sessiz bir array update'i değildir.
   * Hangi rolün hangi region'ı yeniden üretime açtığını workspace trace'e yazıyoruz.
   */
  return markRegionsMasked(
    workspace,
    policy.regions,
    policy.view satisfies WorkspaceRole,
    policy.reason
  );
}

export function remaskAfterFailure(
  workspace: SharedSemanticWorkspace,
  failedRegions: WorkspaceRegion[]
): SharedSemanticWorkspace {
  return markRegionsMasked(
    workspace,
    failedRegions,
    "verifier",
    "Verifier requested failed regions to be remasked."
  );
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

  /**
   * Writable region aynı zamanda masked region'dır.
   * Çünkü dLLM/remask yaklaşımında model bütün workspace'i yazmaz;
   * sadece kendisine açılan lokal boşluğu doldurur.
   */
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