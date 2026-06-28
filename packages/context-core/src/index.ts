import type {
  SharedSemanticWorkspace,
  WorkspaceRegion,
  WorkspaceRole
} from "../../workspace-core/src/index.js";

export type ContextFactKind = "current" | "stale" | "correction" | "sensitive" | "uncertain";

// Scope region, çalışmanın sınırlandırılmış bir alanıdır. Bu alan bir dosya,
// modül, API yüzeyi, doküman bölümü veya kavramsal sınır olabilir. Benchmark
// case'leri agent'ın izin verilen çalışma alanında kalıp kalmadığını bununla ölçer.
export type ContextScopeRegion = {
  id: string;
  label: string;
  path?: string;
  reason: string;
};

// Fact, modelin ihtiyaç duyabileceği tekil bir bağlam bilgisidir. Buradaki kind
// alanı önemlidir: current ve correction genelde kazanmalı, stale genelde
// kaybetmeli, sensitive genelde gizli kalmalı, uncertain ise agent'ı eminmiş gibi
// tahmin yürütmek yerine boundary decision üretmeye itmelidir.
export type ContextFact = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
};

// Bu packet, araştırma projesinin merkezi input nesnesidir. Karşılaştırdığımız
// her mimari, model çağrısına farklı formatta hazırlasa bile aynı semantik
// bilgiyi bu nesne üzerinden almalıdır.
export type BoundedContextPacket = {
  id: string;
  task: string;
  goal: string;
  allowedScope: ContextScopeRegion[];
  forbiddenScope: ContextScopeRegion[];
  facts: ContextFact[];
  mustNotInfer: string[];
  responseContract: string;
  contextBudgetTokens: number;
};

export type ContextSufficiency = "sufficient" | "risky" | "insufficient";

export type ContextComposerOptions = {
  /**
   * Role view için token bütçesi.
   * Verilmezse role-specific default budget kullanılır.
   */
  budgetTokens?: number;

  /**
   * Normalde sensitive fact raw olarak role view içine alınmaz.
   * Bu flag sadece test/debug için vardır.
   */
  includeSensitive?: boolean;

  /**
   * Coder/planner gibi roller için stale fact default olarak dışarıda kalır.
   * Debug veya verifier dışı deneyler için açılabilir.
   */
  includeStale?: boolean;
};

export type ContextComposerProvenance = {
  region: WorkspaceRegion;
  reason: string;
};

export type ComposedContextFact = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
  source: "authority" | "repo_facts" | "policy" | "fallback";
  included: boolean;
  reason: string;
};

export type ComposedRoleView = {
  role: WorkspaceRole;
  workspaceId: string;
  includedRegions: WorkspaceRegion[];
  excludedRegions: WorkspaceRegion[];
  includedFacts: ComposedContextFact[];
  excludedFacts: ComposedContextFact[];
  sensitiveExclusions: ComposedContextFact[];
  staleExclusions: ComposedContextFact[];

  /**
   * Agent'a verilecek bounded working memory payload'ı.
   * Bu bir chat transcript değildir; role-specific structured context'tir.
   */
  context: Record<string, unknown>;

  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  sufficiency: ContextSufficiency;
  warnings: string[];
  provenance: ContextComposerProvenance[];
};

type WorkspaceFactLike = {
  id: string;
  kind: ContextFactKind;
  content: string;
  evidenceId: string;
  confidence: number;
};

type WorkspaceWithEvidenceFacts = SharedSemanticWorkspace & {
  authority: SharedSemanticWorkspace["authority"] & {
    evidenceFacts?: WorkspaceFactLike[];
  };
  repoFacts: SharedSemanticWorkspace["repoFacts"] & {
    evidenceFacts?: WorkspaceFactLike[];
  };
};

const ALL_WORKSPACE_REGIONS: WorkspaceRegion[] = [
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
];

/**
 * Context Composer v1.
 *
 * Bu fonksiyon ürün roadmap'indeki Bounded Working Memory + Context Composer
 * hedefinin ilk canonical entrypoint'idir.
 *
 * Amaç:
 * - aynı workspace'ten farklı agent rolleri için farklı view üretmek,
 * - sensitive/stale bilgiyi role'e göre filtrelemek,
 * - hangi bilginin dahil/dışarıda kaldığını raporlamak,
 * - token budget sinyali üretmek,
 * - agent'a "her şeyi" değil, minimum yeterli context vermektir.
 */
export function composeRoleView(
  workspace: SharedSemanticWorkspace,
  role: WorkspaceRole,
  options: ContextComposerOptions = {}
): ComposedRoleView {
  const includedRegions = getIncludedRegionsForRole(role);
  const excludedRegions = ALL_WORKSPACE_REGIONS.filter(
    (region) => !includedRegions.includes(region)
  );

  const budgetTokens = options.budgetTokens ?? defaultBudgetForRole(role);
  const allFacts = collectWorkspaceFacts(workspace);
  const facts = selectFactsForRole(role, allFacts, options);

  const context = buildRoleContext(workspace, role, includedRegions, facts.included);
  const estimatedTokens = estimateJsonTokens(context);
  const budgetUtilization = roundRatio(estimatedTokens / Math.max(budgetTokens, 1));
  const warnings = buildContextWarnings(workspace, role, estimatedTokens, budgetTokens, facts);
  const sufficiency = resolveContextSufficiency(workspace, estimatedTokens, budgetTokens, facts, warnings);

  return {
    role,
    workspaceId: workspace.id,
    includedRegions,
    excludedRegions,
    includedFacts: facts.included,
    excludedFacts: facts.excluded,
    sensitiveExclusions: facts.sensitiveExclusions,
    staleExclusions: facts.staleExclusions,
    context,
    estimatedTokens,
    budgetTokens,
    budgetUtilization,
    sufficiency,
    warnings,
    provenance: buildProvenance(role, includedRegions, facts)
  };
}

/**
 * Birden fazla role view'i tek seferde üretmek için küçük yardımcı.
 * Orchestrator v1 geldiğinde flow başlangıcında kullanılabilir.
 */
export function composeRoleViews(
  workspace: SharedSemanticWorkspace,
  roles: WorkspaceRole[],
  options: ContextComposerOptions = {}
): ComposedRoleView[] {
  return roles.map((role) => composeRoleView(workspace, role, options));
}

// Bu token tahmini bilinçli olarak basit tutuldu. Issue #1 için tokenizer'a tam
// uyan bir sayıdan çok, deterministik bir bütçe sinyali gerekiyor. İleride gerekirse
// bunu model bazlı tokenizer'larla değiştirebiliriz.
export function estimateContextTokens(packet: BoundedContextPacket): number {
  const text = JSON.stringify(packet);
  return Math.ceil(text.length / 4);
}

export function estimateRoleViewTokens(view: ComposedRoleView): number {
  return estimateJsonTokens(view.context);
}

// Bu yardımcı fonksiyonlar benchmark kodunu okunur tutar. Aynı zamanda şu zihinsel
// modeli öğretir: fact'ler sadece metin parçaları değildir; policy rolleri vardır.
export function sensitiveFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "sensitive");
}

export function staleFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "stale");
}

export function currentFacts(packet: BoundedContextPacket): ContextFact[] {
  return packet.facts.filter((fact) => fact.kind === "current" || fact.kind === "correction");
}

function getIncludedRegionsForRole(role: WorkspaceRole): WorkspaceRegion[] {
  switch (role) {
    case "workspace_builder":
      return ["task", "scope", "authority", "policy", "repo_facts", "patch_intent"];

    case "context_composer":
      return ["task", "scope", "authority", "policy", "repo_facts", "patch_intent", "role_view"];

    case "orchestrator":
      return [
        "task",
        "scope",
        "authority",
        "policy",
        "patch_intent",
        "role_view",
        "verifier_result",
        "remask_request",
        "conflict",
        "merge_decision",
        "final_result"
      ];

    case "planner":
      return ["task", "scope", "authority", "policy", "repo_facts", "patch_intent"];

    case "coder":
      return ["task", "scope", "authority", "policy", "repo_facts", "patch_intent", "patch_plan"];

    case "verifier":
      return [
        "task",
        "scope",
        "authority",
        "policy",
        "repo_facts",
        "patch_intent",
        "claim",
        "patch_plan",
        "patch_draft",
        "verifier_result"
      ];

    case "tester":
      return ["task", "scope", "policy", "repo_facts", "patch_intent", "patch_draft", "test_signal"];

    case "remask":
      return [
        "task",
        "scope",
        "authority",
        "policy",
        "patch_draft",
        "verifier_result",
        "remask_request"
      ];

    case "merge":
      return [
        "task",
        "scope",
        "authority",
        "policy",
        "claim",
        "patch_plan",
        "patch_draft",
        "verifier_result",
        "test_signal",
        "conflict",
        "merge_decision"
      ];

    case "system":
      return ALL_WORKSPACE_REGIONS;
  }
}

function defaultBudgetForRole(role: WorkspaceRole): number {
  switch (role) {
    case "workspace_builder":
      return 1600;

    case "context_composer":
      return 1400;

    case "orchestrator":
      return 1600;

    case "planner":
      return 1400;

    case "coder":
      return 2200;

    case "verifier":
      return 2000;

    case "tester":
      return 1400;

    case "remask":
      return 1200;

    case "merge":
      return 1800;

    case "system":
      return 3000;
  }
}

function collectWorkspaceFacts(workspace: SharedSemanticWorkspace): ComposedContextFact[] {
  const workspaceWithEvidence = workspace as WorkspaceWithEvidenceFacts;
  const evidenceFacts = dedupeFacts([
    ...(workspaceWithEvidence.authority.evidenceFacts ?? []),
    ...(workspaceWithEvidence.repoFacts.evidenceFacts ?? [])
  ]);

  if (evidenceFacts.length > 0) {
    return evidenceFacts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      content: fact.kind === "sensitive" ? sanitizeSensitiveContent(fact.content) : fact.content,
      evidenceId: fact.evidenceId,
      confidence: fact.confidence,
      source: sourceForFactKind(fact.kind),
      included: false,
      reason: "Collected from workspace evidence metadata."
    }));
  }

  return collectFallbackWorkspaceFacts(workspace);
}

function collectFallbackWorkspaceFacts(workspace: SharedSemanticWorkspace): ComposedContextFact[] {
  const authorityFacts = workspace.authority.facts.map((content, index) => ({
    id: `authority-fact-${index}`,
    kind: "current" as const,
    content,
    evidenceId: `workspace-authority-${index}`,
    confidence: 0.9,
    source: "authority" as const,
    included: false,
    reason: "Collected from workspace.authority.facts fallback."
  }));

  const staleFactsFromWorkspace = workspace.repoFacts.staleFacts.map((content, index) => ({
    id: `stale-fact-${index}`,
    kind: "stale" as const,
    content,
    evidenceId: `workspace-stale-${index}`,
    confidence: 0.45,
    source: "repo_facts" as const,
    included: false,
    reason: "Collected from workspace.repoFacts.staleFacts fallback."
  }));

  const sensitivePatterns = [
    ...workspace.policy.sensitivePatterns,
    ...workspace.repoFacts.sensitivePatterns
  ].map((content, index) => ({
    id: `sensitive-fact-${index}`,
    kind: "sensitive" as const,
    content: sanitizeSensitiveContent(content),
    evidenceId: `workspace-sensitive-${index}`,
    confidence: 0.75,
    source: "policy" as const,
    included: false,
    reason: "Collected from sensitive pattern fallback."
  }));

  return dedupeComposedFacts([
    ...authorityFacts,
    ...staleFactsFromWorkspace,
    ...sensitivePatterns
  ]);
}

function selectFactsForRole(
  role: WorkspaceRole,
  facts: ComposedContextFact[],
  options: ContextComposerOptions
): {
  included: ComposedContextFact[];
  excluded: ComposedContextFact[];
  sensitiveExclusions: ComposedContextFact[];
  staleExclusions: ComposedContextFact[];
} {
  const included: ComposedContextFact[] = [];
  const excluded: ComposedContextFact[] = [];
  const sensitiveExclusions: ComposedContextFact[] = [];
  const staleExclusions: ComposedContextFact[] = [];

  for (const fact of facts) {
    const decision = shouldIncludeFactForRole(role, fact, options);
    const nextFact: ComposedContextFact = {
      ...fact,
      included: decision.include,
      reason: decision.reason
    };

    if (decision.include) {
      included.push(nextFact);
      continue;
    }

    excluded.push(nextFact);

    if (fact.kind === "sensitive") {
      sensitiveExclusions.push(nextFact);
    }

    if (fact.kind === "stale") {
      staleExclusions.push(nextFact);
    }
  }

  return {
    included,
    excluded,
    sensitiveExclusions,
    staleExclusions
  };
}

function shouldIncludeFactForRole(
  role: WorkspaceRole,
  fact: ComposedContextFact,
  options: ContextComposerOptions
): {
  include: boolean;
  reason: string;
} {
  if (fact.kind === "sensitive" && !options.includeSensitive) {
    if (role === "verifier" || role === "merge" || role === "system") {
      return {
        include: true,
        reason: "Sensitive pattern included only as sanitized verifier/merge boundary signal."
      };
    }

    return {
      include: false,
      reason: "Sensitive fact excluded from this role view by default."
    };
  }

  if (fact.kind === "stale" && !options.includeStale) {
    if (role === "verifier" || role === "merge" || role === "system") {
      return {
        include: true,
        reason: "Stale fact included for verification/merge safety checks."
      };
    }

    return {
      include: false,
      reason: "Stale fact excluded to avoid stale authority leakage into active agent context."
    };
  }

  if (fact.kind === "uncertain") {
    if (role === "planner" || role === "verifier" || role === "merge" || role === "system") {
      return {
        include: true,
        reason: "Uncertain fact included so the role can avoid unsupported inference."
      };
    }

    return {
      include: false,
      reason: "Uncertain fact excluded from execution-oriented role view."
    };
  }

  return {
    include: true,
    reason: "Fact is role-safe and task-relevant."
  };
}

function buildRoleContext(
  workspace: SharedSemanticWorkspace,
  role: WorkspaceRole,
  includedRegions: WorkspaceRegion[],
  includedFacts: ComposedContextFact[]
): Record<string, unknown> {
  const record = workspace as unknown as Record<string, unknown>;

  const context: Record<string, unknown> = {
    role,
    workspaceId: workspace.id,
    includedFacts: includedFacts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      content: fact.content,
      evidenceId: fact.evidenceId,
      confidence: fact.confidence,
      source: fact.source
    }))
  };

  if (includedRegions.includes("task")) {
    context.task = workspace.task;
  }

  if (includedRegions.includes("scope")) {
    context.scope = workspace.scope;
  }

  if (includedRegions.includes("authority")) {
    context.authority = {
      facts: workspace.authority.facts,
      missingRules: workspace.authority.missingRules
    };
  }

  if (includedRegions.includes("policy")) {
    context.policy = {
      allowedPaths: workspace.policy.allowedPaths,
      forbiddenPaths: workspace.policy.forbiddenPaths,
      ownership: workspace.policy.ownership,
      ownerAliases: workspace.policy.ownerAliases,
      pairedFiles: workspace.policy.pairedFiles,
      requiredTests: workspace.policy.requiredTests,
      requiredTestMappings: workspace.policy.requiredTestMappings,
      moduleBoundaries: workspace.policy.moduleBoundaries,
      missingAuthorityRules: workspace.policy.missingAuthorityRules,

      /**
       * Policy içinde sensitivePatterns varsa role view'e raw değil sanitize edilmiş
       * haliyle girer.
       */
      sensitivePatterns: workspace.policy.sensitivePatterns.map(sanitizeSensitiveContent)
    };
  }

  if (includedRegions.includes("repo_facts")) {
    context.repoFacts = {
      changedFiles: workspace.repoFacts.changedFiles,
      ownership: workspace.repoFacts.ownership,
      pairedFiles: workspace.repoFacts.pairedFiles,
      requiredTests: workspace.repoFacts.requiredTests,
      requiredTestMappings: workspace.repoFacts.requiredTestMappings,
      moduleBoundaries: workspace.repoFacts.moduleBoundaries,
      sensitivePatterns: workspace.repoFacts.sensitivePatterns.map(sanitizeSensitiveContent),

      /**
       * Stale facts sadece includedFacts üzerinden role policy'ye göre girer.
       * Burada raw staleFacts tekrar taşınmaz.
       */
      staleFacts: includedFacts
        .filter((fact) => fact.kind === "stale")
        .map((fact) => fact.content)
    };
  }

  if (includedRegions.includes("patch_intent")) {
    context.patchIntent = workspace.patchIntent;
  }

  if (includedRegions.includes("role_view")) {
    context.roleViews = record.roleViews ?? [];
  }

  if (includedRegions.includes("claim")) {
    context.claims = workspace.claims;
  }

  if (includedRegions.includes("patch_plan")) {
    context.patchPlan = record.patchPlan ?? null;
  }

  if (includedRegions.includes("patch_draft")) {
    context.patchDraft = record.patchDraft ?? null;
  }

  if (includedRegions.includes("verifier_result")) {
    context.verifierResults = workspace.verifierResults;
  }

  if (includedRegions.includes("test_signal")) {
    context.testSignals = workspace.testSignals;
  }

  if (includedRegions.includes("remask_request")) {
    context.remaskRequests = workspace.remaskRequests;
  }

  if (includedRegions.includes("conflict")) {
    context.conflicts = workspace.conflicts;
  }

  if (includedRegions.includes("merge_decision")) {
    context.mergeDecision = workspace.mergeDecision ?? null;
  }

  if (includedRegions.includes("final_result")) {
    context.finalResult = workspace.finalResult ?? null;
  }

  return context;
}

function buildContextWarnings(
  workspace: SharedSemanticWorkspace,
  role: WorkspaceRole,
  estimatedTokens: number,
  budgetTokens: number,
  facts: {
    included: ComposedContextFact[];
    excluded: ComposedContextFact[];
    sensitiveExclusions: ComposedContextFact[];
    staleExclusions: ComposedContextFact[];
  }
): string[] {
  const warnings: string[] = [];

  if (estimatedTokens > budgetTokens) {
    warnings.push(`Role view exceeds token budget: ${estimatedTokens}/${budgetTokens}.`);
  }

  if (workspace.authority.missingRules.length > 0) {
    warnings.push("Workspace has missing authority rules.");
  }

  if (facts.included.length === 0 && role !== "tester") {
    warnings.push("No facts included for this role view.");
  }

  if (facts.sensitiveExclusions.length > 0) {
    warnings.push(`${facts.sensitiveExclusions.length} sensitive fact(s) excluded.`);
  }

  if (facts.staleExclusions.length > 0) {
    warnings.push(`${facts.staleExclusions.length} stale fact(s) excluded.`);
  }

  return warnings;
}

function resolveContextSufficiency(
  workspace: SharedSemanticWorkspace,
  estimatedTokens: number,
  budgetTokens: number,
  facts: {
    included: ComposedContextFact[];
  },
  warnings: string[]
): ContextSufficiency {
  if (facts.included.length === 0 && workspace.authority.missingRules.length > 0) {
    return "insufficient";
  }

  if (estimatedTokens > budgetTokens) {
    return "risky";
  }

  if (warnings.some((warning) => warning.includes("missing authority"))) {
    return "risky";
  }

  if (facts.included.length === 0) {
    return "risky";
  }

  return "sufficient";
}

function buildProvenance(
  role: WorkspaceRole,
  includedRegions: WorkspaceRegion[],
  facts: {
    included: ComposedContextFact[];
    excluded: ComposedContextFact[];
  }
): ContextComposerProvenance[] {
  return [
    ...includedRegions.map((region) => ({
      region,
      reason: `${role} role requires ${region} for bounded working memory.`
    })),
    ...facts.included.map((fact) => ({
      region: regionForFactSource(fact.source),
      reason: `Included fact ${fact.id}: ${fact.reason}`
    })),
    ...facts.excluded.map((fact) => ({
      region: regionForFactSource(fact.source),
      reason: `Excluded fact ${fact.id}: ${fact.reason}`
    }))
  ];
}

function sourceForFactKind(kind: ContextFactKind): ComposedContextFact["source"] {
  if (kind === "current" || kind === "correction" || kind === "uncertain") {
    return "authority";
  }

  if (kind === "stale") {
    return "repo_facts";
  }

  if (kind === "sensitive") {
    return "policy";
  }

  return "fallback";
}

function regionForFactSource(source: ComposedContextFact["source"]): WorkspaceRegion {
  if (source === "authority") {
    return "authority";
  }

  if (source === "repo_facts") {
    return "repo_facts";
  }

  if (source === "policy") {
    return "policy";
  }

  return "repo_facts";
}

function dedupeFacts(facts: WorkspaceFactLike[]): WorkspaceFactLike[] {
  const seen = new Set<string>();
  const deduped: WorkspaceFactLike[] = [];

  for (const fact of facts) {
    const key = `${fact.evidenceId}:${fact.kind}:${fact.content}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(fact);
  }

  return deduped;
}

function dedupeComposedFacts(facts: ComposedContextFact[]): ComposedContextFact[] {
  const seen = new Set<string>();
  const deduped: ComposedContextFact[] = [];

  for (const fact of facts) {
    const key = `${fact.evidenceId}:${fact.kind}:${fact.content}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(fact);
  }

  return deduped;
}

function sanitizeSensitiveContent(content: string): string {
  return content.split(" Raw value:")[0] ?? "Sensitive information must stay out of default context.";
}

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}