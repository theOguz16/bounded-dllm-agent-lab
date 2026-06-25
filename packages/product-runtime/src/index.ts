export type ReviewDecision =
  | "approve"
  | "refuse"
  | "reject"
  | "remask_required"
  | "human_review_required";

export type RiskLevel = "low" | "medium" | "high";
export type FindingSeverity = "info" | "warning" | "error";
export type AgentRoleView = "planner" | "coder" | "verifier" | "tester" | "remask";
export type WorkspaceActor = AgentRoleView | "workspace_builder" | "context_composer" | "verifier_adapter" | "orchestrator" | "merge" | "system";
export type ContextSufficiencyRisk = "low" | "medium" | "high";

export type TaskSpec = {
  id: string;
  title: string;
  description: string;
  authorityFacts?: string[];
};

export type PatchDiff = {
  raw: string;
  changedFiles: string[];
};

export type PairedFileRule = {
  source: string;
  requires: string;
  reason?: string;
  changed_when_contains?: string[];
};

export type RequiredTestMappingRule = {
  source: string;
  test: string;
  reason?: string;
  changed_when_contains?: string[];
};

export type ModuleBoundaryRule = {
  source: string;
  allowedWith: string[];
  authority?: string;
  reason?: string;
};

export type RepoPolicy = {
  allowed_paths: string[];
  forbidden_paths: string[];
  ownership?: Record<string, string>;
  owner_aliases?: Record<string, string[]>;
  paired_files?: PairedFileRule[];
  sensitive_patterns?: string[];
  required_tests?: string[];
  required_test_mappings?: RequiredTestMappingRule[];
  module_boundaries?: ModuleBoundaryRule[];
  missing_authority_rules?: string[];
};

export type WorkspaceScope = {
  allowed: string[];
  forbidden: string[];
  changedFiles: string[];
};

export type WorkspaceAuthority = {
  facts: string[];
  missingRules: string[];
};

export type WorkspaceRepoFacts = {
  changedFiles: string[];
  ownership: Record<string, string>;
  pairedFiles: PairedFileRule[];
  requiredTests: string[];
  requiredTestMappings: RequiredTestMappingRule[];
  moduleBoundaries: ModuleBoundaryRule[];
  sensitivePatterns: string[];
  staleFacts: string[];
  intelligence?: RepoIntelligenceReport;
};

export type RepoFileKind = "source" | "test" | "docs" | "config" | "generated" | "build" | "public_api" | "unknown";

export type RepoFileClassification = {
  path: string;
  kind: RepoFileKind;
  reason: string;
};

export type RepoIntelligenceReport = {
  packageManagers: string[];
  files: RepoFileClassification[];
  sourceFiles: string[];
  testFiles: string[];
  docsFiles: string[];
  configFiles: string[];
  generatedFiles: string[];
  buildOutputPaths: string[];
  likelyPairedFiles: PairedFileRule[];
  likelyPublicApiFiles: string[];
  likelyTestMappings: RequiredTestMappingRule[];
  suggestedPolicy: RepoPolicy;
};

export type WorkspaceClaimStatus = "proposed" | "accepted" | "rejected";

export type AgentClaim = {
  id: string;
  actor: AgentRoleView;
  target:
    | "task"
    | "scope"
    | "authority"
    | "repo_facts"
    | "patch_plan"
    | "verifier_result"
    | "remask_request"
    | "merge_decision";
  summary: string;
  status: WorkspaceClaimStatus;
  evidence: string[];
  writableRegions?: string[];
  baseEventIndex?: number;
};

export type PatchPlan = {
  summary: string;
  files: string[];
  allowedEditRegions: string[];
  forbiddenEditRegions: string[];
  requiredSignals: string[];
};

export type WorkspaceVerifierResult = {
  decision: ReviewDecision;
  findings: Finding[];
  checkedFiles: string[];
};

export type WorkspaceRemaskRequest = {
  required: boolean;
  regions: RemaskRegion[];
};

export type WorkspaceMergeDecision = {
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  reason: string;
  safetyReport?: MergeSafetyReport;
};

export type WorkspaceConflictRecord = {
  id: string;
  kind: "claim_conflict" | "authority_conflict" | "scope_conflict" | "patch_conflict";
  summary: string;
  claimIds: string[];
  severity: RiskLevel;
};

export type MergeSafetyFinding = {
  id: string;
  kind: WorkspaceConflictRecord["kind"] | "stale_claim" | "unsafe_overwrite";
  severity: RiskLevel;
  summary: string;
  claimIds: string[];
  files: string[];
};

export type MergeSafetyReport = {
  ok: boolean;
  findings: MergeSafetyFinding[];
  conflictCount: number;
  staleClaimCount: number;
  unsafeOverwriteCount: number;
  authorityViolationCount: number;
};

export type CostBenchmarkFlow =
  | "direct_large_context"
  | "bounded_workspace"
  | "workspace_verifier"
  | "workspace_verifier_remask";

export type CostBenchmarkFixture = {
  id: string;
  input: ReviewInput;
  expectedDecision?: ReviewDecision;
};

export type FlowCostMeasurement = {
  fixtureId: string;
  flow: CostBenchmarkFlow;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  totalEstimatedTokens: number;
  roleViewTokens: number;
  budgetUtilization: number;
  remaskExtraTokens: number;
  decision: ReviewDecision;
  taskSuccess: 0 | 1;
  scopeDrift: 0 | 1;
  missedBlocker: 0 | 1;
  falseBlocker: 0 | 1;
};

export type CostTokenBenchmarkReport = {
  id: string;
  createdAt: string;
  fixtureCount: number;
  flows: CostBenchmarkFlow[];
  measurements: FlowCostMeasurement[];
  flowSummaries: Array<{
    flow: CostBenchmarkFlow;
    averageInputTokens: number;
    averageOutputTokens: number;
    averageTotalTokens: number;
    averageBudgetUtilization: number;
    totalRemaskExtraTokens: number;
    taskSuccessRate: number;
    scopeDriftRate: number;
    missedBlockerRate: number;
    falseBlockerRate: number;
  }>;
  markdownReport: string;
};

export type WorkspaceEvent = {
  id: string;
  actor: WorkspaceActor;
  action:
    | "workspace_created"
    | "role_views_created"
    | "claim_added"
    | "conflict_recorded"
    | "flow_started"
    | "step_completed"
    | "step_failed"
    | "patch_plan_recorded"
    | "verifier_result_recorded"
    | "remask_request_recorded"
    | "merge_decision_recorded";
  summary: string;
  target?: AgentClaim["target"] | "workspace";
  relatedIds: string[];
};

export type ContextFactSelection = {
  field: string;
  reason: string;
};

export type ContextFactExclusion = {
  field: string;
  reason: string;
};

export type ViewProvenance = {
  workspaceId: string;
  sourceFields: string[];
  composerVersion: "context-composer-v1";
};

export type ContextComposerReport = {
  role: AgentRoleView;
  budgetTokens: number;
  estimatedTokens: number;
  budgetUtilization: number;
  includedFacts: ContextFactSelection[];
  excludedFacts: ContextFactExclusion[];
  provenance: ViewProvenance;
  contextSufficiencyRisk: ContextSufficiencyRisk;
};

export type SharedWorkspaceSnapshot = {
  id: string;
  version: 1;
  task: TaskSpec;
  scope: WorkspaceScope;
  authority: WorkspaceAuthority;
  policy: RepoPolicy;
  repoFacts: WorkspaceRepoFacts;
  diff: PatchDiff;
  roleViews: Record<AgentRoleView, BoundedRoleView>;
  claims: AgentClaim[];
  conflicts: WorkspaceConflictRecord[];
  patchPlan: PatchPlan;
  verifierResult?: WorkspaceVerifierResult;
  remaskRequest?: WorkspaceRemaskRequest;
  mergeDecision?: WorkspaceMergeDecision;
  events: WorkspaceEvent[];
  trace: ProductTraceEvent[];
};

export type BoundedRoleView = {
  role: AgentRoleView;
  visibleFields: string[];
  writableFields: string[];
  tokenBudget: number;
  estimatedTokens: number;
  budgetUtilization: number;
  includedFacts: ContextFactSelection[];
  excludedFacts: ContextFactExclusion[];
  provenance: ViewProvenance;
  contextSufficiencyRisk: ContextSufficiencyRisk;
  composerReport: ContextComposerReport;
  summary: string;
};

export type Finding = {
  id: string;
  severity: FindingSeverity;
  category:
    | "scope"
    | "authority"
    | "ownership"
    | "module_boundary"
    | "sensitive_boundary"
    | "paired_file"
    | "test"
    | "trace"
    | "verifier_adapter";
  message: string;
  files: string[];
  suggestedAction: ReviewDecision;
  metadata?: Record<string, string>;
};

export type RemaskRegion = {
  id: string;
  reason: string;
  files: string[];
  instruction: string;
};

export type RepairProposal = {
  id: string;
  kind: "paired_file_update" | "manual_follow_up";
  files: string[];
  summary: string;
  instruction: string;
  patchOutline: string[];
};

export type ProductTraceEvent = {
  id: string;
  actor: WorkspaceActor | "remask_planner";
  action: string;
  summary: string;
};

export type ReviewMetrics = {
  scopeSafety: 0 | 1;
  authoritySafety: 0 | 1;
  ownershipSafety: 0 | 1;
  moduleBoundarySafety: 0 | 1;
  sensitiveBoundarySafety: 0 | 1;
  pairedFileCompleteness: 0 | 1;
  remaskNeed: 0 | 1;
  traceCompleteness: 0 | 1;
  changedFileCount: number;
  findingCount: number;
};

export type ReviewInput = {
  task: TaskSpec;
  diff: PatchDiff;
  policy: RepoPolicy;
  repoFiles?: string[];
  repoIntelligence?: RepoIntelligenceReport;
  contextBudgets?: Partial<Record<AgentRoleView, number>>;
  roleAdapters?: Partial<Record<ModelAdapterRole, RoleAdapter>>;
  workspace?: SharedWorkspaceSnapshot;
  verifierAdapterOutput?: VerifierAdapterOutput;
};

export type VerifierAdapterFinding = {
  category: Finding["category"];
  severity: FindingSeverity;
  message: string;
  files: string[];
  suggestedAction: ReviewDecision;
  metadata?: Record<string, string>;
};

export type VerifierAdapterInput = {
  task: TaskSpec;
  diff: PatchDiff;
  policy: RepoPolicy;
  workspace: SharedWorkspaceSnapshot;
  deterministicFindings: Finding[];
};

export type VerifierAdapterOutput = {
  adapterName: string;
  mode: "llm" | "dllm" | "deterministic" | "mock";
  findings: VerifierAdapterFinding[];
  confidence: number;
  summary: string;
};

export type VerifierAdapter = {
  name: string;
  mode: VerifierAdapterOutput["mode"];
  verify(input: VerifierAdapterInput): Promise<VerifierAdapterOutput>;
};

export type ModelAdapterRole = "coder" | "verifier" | "remask";
export type ModelAdapterMode = "mock" | "local" | "openai_compatible" | "llm" | "dllm" | "deterministic";

export type RoleAdapterInput = {
  role: ModelAdapterRole;
  task: TaskSpec;
  diff: PatchDiff;
  policy: RepoPolicy;
  workspace: SharedWorkspaceSnapshot;
  roleView: BoundedRoleView;
};

export type RoleAdapterOutput = {
  adapterName: string;
  role: ModelAdapterRole;
  mode: ModelAdapterMode;
  confidence: number;
  summary: string;
  claims: AgentClaim[];
  patchPlan?: PatchPlan;
  verifierFindings?: VerifierAdapterFinding[];
  remaskRegions?: RemaskRegion[];
  rawOutput?: string;
};

export type RoleAdapterValidationResult = {
  ok: boolean;
  errors: string[];
};

export type RoleAdapter = {
  name: string;
  role: ModelAdapterRole;
  mode: ModelAdapterMode;
  execute(input: RoleAdapterInput): RoleAdapterOutput;
};

export type SyntheticWorkspacePacket = {
  id: string;
  role: "direct_patch" | "verifier" | "remask";
  contextWidth: "narrow" | "broad";
  workspaceId: string;
  visibleFields: string[];
  maskedFields: string[];
  lockedFields: string[];
  prompt: string;
  tokenEstimate: number;
};

export type DllmStyleExperimentRole = SyntheticWorkspacePacket["role"];
export type DllmStyleContextWidth = SyntheticWorkspacePacket["contextWidth"];

export type DllmStyleExperimentFixture = {
  id: string;
  input: ReviewInput;
  expectedDecision: ReviewDecision;
};

export type DllmStyleExperimentMeasurement = {
  fixtureId: string;
  role: DllmStyleExperimentRole;
  contextWidth: DllmStyleContextWidth;
  tokenEstimate: number;
  decision: ReviewDecision;
  scopeDrift: 0 | 1;
  repairSuccess: 0 | 1;
  costDeltaTokens: number;
};

export type DllmStyleExperimentReport = {
  id: string;
  createdAt: string;
  measurements: DllmStyleExperimentMeasurement[];
  summaries: Array<{
    role: DllmStyleExperimentRole;
    contextWidth: DllmStyleContextWidth;
    averageTokens: number;
    scopeDriftRate: number;
    repairSuccessRate: number;
    averageCostDeltaTokens: number;
  }>;
  markdownReport: string;
};

export type ProductRuntimeArtifactV1 = {
  schemaVersion: "product-runtime-artifact/v1";
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  metrics: ReviewMetrics;
  findingCount: number;
  remaskRegionCount: number;
  repairProposalCount: number;
  workspaceId: string;
  traceEventCount: number;
};

export type TeamMetricArtifact = Pick<ReviewOutput, "decision" | "riskLevel" | "metrics" | "findings" | "remaskRegions" | "workspace"> & {
  createdAt?: string;
};

export type TeamMetricsReport = {
  schemaVersion: "team-metrics/v1";
  createdAt: string;
  artifactCount: number;
  aiPatchCount: number;
  boundaryGuessCount: number;
  falseBlockerCount: number;
  missedBlockerCount: number;
  remaskRequiredCount: number;
  remaskSuccessCount: number;
  averageTokenBudget: number;
  averageRoleViewSize: number;
  scopeDriftCount: number;
  ownershipMissCount: number;
  moduleBoundaryFindingCount: number;
  riskTrend: Array<{ bucket: string; low: number; medium: number; high: number }>;
  costTrend: Array<{ bucket: string; averageTokenBudget: number; averageRoleViewSize: number }>;
  policyConsoleModel: {
    ownership: Record<string, string>;
    allowedPaths: string[];
    pairedFiles: PairedFileRule[];
  };
  markdownReport: string;
};

export type ReviewOutput = {
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  metrics: ReviewMetrics;
  decisionPriority: ReviewDecision[];
  findings: Finding[];
  remaskRegions: RemaskRegion[];
  repairProposals: RepairProposal[];
  trace: ProductTraceEvent[];
  workspace: SharedWorkspaceSnapshot;
  markdownReport: string;
};

export type OrchestrationStepId =
  | "workspace:create"
  | "planner:claim"
  | "coder:patch_plan"
  | "verifier:decision"
  | "remask:optional"
  | "merge:final";

export type OrchestrationStepStatus = "completed" | "skipped" | "failed";

export type WorkspacePermission = {
  role: WorkspaceActor;
  read: string[];
  write: string[];
};

export type OrchestrationStepDefinition = {
  id: OrchestrationStepId;
  actor: WorkspaceActor;
  required: boolean;
  permission: WorkspacePermission;
};

export type OrchestrationFlowDefinition = {
  id: "mock-bounded-workspace-flow-v1";
  description: string;
  steps: OrchestrationStepDefinition[];
};

export type OrchestrationStepResult = {
  stepId: OrchestrationStepId;
  actor: WorkspaceActor;
  status: OrchestrationStepStatus;
  summary: string;
  claimIds: string[];
  eventIds: string[];
  error?: string;
};

export type RoleExecutionContext = {
  input: ReviewInput;
  workspace: SharedWorkspaceSnapshot;
  step: OrchestrationStepDefinition;
};

export type RoleExecutionResult = {
  workspace: SharedWorkspaceSnapshot;
  result: OrchestrationStepResult;
};

export type MockRoleAgent = {
  role: WorkspaceActor;
  execute(context: RoleExecutionContext): RoleExecutionResult;
};

export type OrchestrationOutput = {
  flow: OrchestrationFlowDefinition;
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  findings: Finding[];
  remaskRegions: RemaskRegion[];
  repairProposals: RepairProposal[];
  steps: OrchestrationStepResult[];
  workspace: SharedWorkspaceSnapshot;
  trace: ProductTraceEvent[];
  markdownTrace: string;
};

export function parseUnifiedDiff(raw: string): PatchDiff {
  const changedFiles = Array.from(new Set(
    raw
      .split("\n")
      .flatMap((line) => {
        if (line.startsWith("diff --git ")) {
          const parts = line.trim().split(/\s+/);
          return parts[3]?.startsWith("b/") ? [parts[3].slice(2)] : [];
        }
        if (line.startsWith("+++ b/")) return [line.slice("+++ b/".length).trim()];
        return [];
      })
      .filter(Boolean)
  )).sort();

  return { raw, changedFiles };
}

export function reviewPatch(input: ReviewInput): ReviewOutput {
  const workspace = input.workspace ?? createSharedWorkspaceSnapshot(input);
  const findings = [
    ...findScopeFindings(input),
    ...findAuthorityFindings(input),
    ...findOwnershipFindings(input),
    ...findModuleBoundaryFindings(input),
    ...findSensitiveBoundaryFindings(input),
    ...findPairedFileFindings(input),
    ...findTestFindings(input),
    ...normalizeVerifierAdapterFindings(input.verifierAdapterOutput)
  ];
  const remaskRegions = createRemaskRegions(findings);
  const repairProposals = createRepairProposals(findings);
  const decision = decide(findings, input.diff);
  const riskLevel = toRiskLevel(decision, findings);
  const metrics = createMetrics(input, findings, workspace);
  const decisionPriority = createDecisionPriority(findings, input.diff);
  const workspaceWithVerifier = recordVerifierResult(workspace, {
    decision,
    findings,
    checkedFiles: input.diff.changedFiles
  });
  const workspaceWithRemask = recordRemaskRequest(workspaceWithVerifier, {
    required: remaskRegions.length > 0,
    regions: remaskRegions
  });
  const finalWorkspace = recordMergeDecision(workspaceWithRemask, {
    decision,
    riskLevel,
    reason: explainDecision(decision)
  });
  const trace = finalWorkspace.trace;
  const markdownReport = createMarkdownReport({
    decision,
    riskLevel,
    metrics,
    decisionPriority,
    findings,
    remaskRegions,
    repairProposals,
    trace,
    workspace: finalWorkspace
  });

  return {
    decision,
    riskLevel,
    metrics,
    decisionPriority,
    findings,
    remaskRegions,
    repairProposals,
    trace,
    workspace: finalWorkspace,
    markdownReport
  };
}

export function createMockOrchestrationFlowDefinition(): OrchestrationFlowDefinition {
  return {
    id: "mock-bounded-workspace-flow-v1",
    description: "Deterministic bounded workspace orchestration flow for Sprint 3.",
    steps: [
      {
        id: "workspace:create",
        actor: "workspace_builder",
        required: true,
        permission: { role: "workspace_builder", read: ["task", "diff", "policy"], write: ["workspace"] }
      },
      {
        id: "planner:claim",
        actor: "planner",
        required: true,
        permission: { role: "planner", read: ["task", "scope", "authority", "policy"], write: ["claims", "patchPlan.summary"] }
      },
      {
        id: "coder:patch_plan",
        actor: "coder",
        required: true,
        permission: { role: "coder", read: ["task", "scope", "repoFacts.changedFiles", "patchPlan"], write: ["claims", "patchPlan"] }
      },
      {
        id: "verifier:decision",
        actor: "verifier",
        required: true,
        permission: { role: "verifier", read: ["task", "diff", "policy", "authority", "repoFacts", "claims"], write: ["verifierResult"] }
      },
      {
        id: "remask:optional",
        actor: "remask",
        required: false,
        permission: { role: "remask", read: ["verifierResult", "remaskRequest", "patchPlan", "scope"], write: ["claims", "remaskRequest"] }
      },
      {
        id: "merge:final",
        actor: "merge",
        required: true,
        permission: { role: "merge", read: ["claims", "verifierResult", "remaskRequest"], write: ["mergeDecision"] }
      }
    ]
  };
}

export function runMockOrchestration(input: ReviewInput): OrchestrationOutput {
  const flow = createMockOrchestrationFlowDefinition();
  const agents = createMockRoleAgents();
  let workspace = createSharedWorkspaceSnapshot(input);
  let findings: Finding[] = [];
  let remaskRegions: RemaskRegion[] = [];
  let repairProposals: RepairProposal[] = [];
  let decision: ReviewDecision = "human_review_required";
  let riskLevel: RiskLevel = "medium";
  const steps: OrchestrationStepResult[] = [];

  workspace = appendWorkspaceEvent(workspace, {
    id: `${workspace.id}-event-flow-started`,
    actor: "orchestrator",
    action: "flow_started",
    target: "workspace",
    summary: `${flow.id} started.`,
    relatedIds: []
  });
  steps.push(createStepResult("workspace:create", "workspace_builder", "completed", "SharedWorkspace v1 was created.", [], [lastEventId(workspace)]));

  for (const step of flow.steps.slice(1)) {
    const eventCountBefore = workspace.events.length;

    try {
      if (step.id === "remask:optional" && createRemaskRegions(workspace.verifierResult?.findings ?? []).length === 0) {
        workspace = appendWorkspaceEvent(workspace, {
          id: `${workspace.id}-event-remask-skipped-${workspace.events.length + 1}`,
          actor: "remask",
          action: "step_completed",
          target: "remask_request",
          summary: "Remask step skipped because verifier did not request a local repair.",
          relatedIds: []
        });
        steps.push(createStepResult(step.id, step.actor, "skipped", "Verifier did not request remask.", [], createdEventIds(workspace, eventCountBefore)));
        continue;
      }

      const agent = agents[step.actor];
      if (!agent) throw new Error(`No mock agent registered for ${step.actor}.`);
      const execution = agent.execute({ input, workspace, step });
      workspace = execution.workspace;
      steps.push({
        ...execution.result,
        eventIds: createdEventIds(workspace, eventCountBefore)
      });
    } catch (error) {
      const message = formatError(error);
      workspace = appendWorkspaceEvent(workspace, {
        id: `${workspace.id}-event-failed-${slugify(step.id)}-${workspace.events.length + 1}`,
        actor: step.actor,
        action: "step_failed",
        target: "workspace",
        summary: message,
        relatedIds: []
      });
      steps.push(createStepResult(step.id, step.actor, "failed", message, [], createdEventIds(workspace, eventCountBefore), message));
      if (step.required) break;
    }

    if (step.id === "verifier:decision" && workspace.verifierResult) {
      findings = workspace.verifierResult.findings;
      remaskRegions = createRemaskRegions(findings);
      repairProposals = createRepairProposals(findings);
      decision = workspace.verifierResult.decision;
      riskLevel = toRiskLevel(decision, findings);
    }
    if (step.id === "merge:final" && workspace.mergeDecision) {
      decision = workspace.mergeDecision.decision;
      riskLevel = workspace.mergeDecision.riskLevel;
    }
  }

  return {
    flow,
    decision,
    riskLevel,
    findings,
    remaskRegions,
    repairProposals,
    steps,
    workspace,
    trace: workspace.trace,
    markdownTrace: createOrchestrationMarkdownTrace(flow, steps, workspace)
  };
}

export function estimateTextTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

export function analyzeRepositoryFiles(files: string[]): RepoIntelligenceReport {
  const normalizedFiles = Array.from(new Set(files.map(normalizeRepoPath).filter(Boolean))).sort();
  const classifications = normalizedFiles.map(classifyRepoFile);
  const sourceFiles = classifications.filter((file) => file.kind === "source" || file.kind === "public_api").map((file) => file.path);
  const testFiles = classifications.filter((file) => file.kind === "test").map((file) => file.path);
  const docsFiles = classifications.filter((file) => file.kind === "docs").map((file) => file.path);
  const configFiles = classifications.filter((file) => file.kind === "config").map((file) => file.path);
  const generatedFiles = classifications.filter((file) => file.kind === "generated").map((file) => file.path);
  const buildOutputPaths = classifications.filter((file) => file.kind === "build").map((file) => file.path);
  const likelyPublicApiFiles = classifications.filter((file) => file.kind === "public_api").map((file) => file.path);
  const likelyPairedFiles = inferLikelyPairedFiles(normalizedFiles);
  const likelyTestMappings = inferLikelyTestMappings(sourceFiles, testFiles);
  const packageManagers = detectPackageManagers(normalizedFiles);
  const suggestedPolicy: RepoPolicy = {
    allowed_paths: inferAllowedPaths(sourceFiles, testFiles, docsFiles, configFiles, likelyPublicApiFiles),
    forbidden_paths: Array.from(new Set([".env", ".env.*", "secrets/**", ...buildOutputPaths, ...generatedFiles])),
    ownership: {},
    owner_aliases: {},
    paired_files: likelyPairedFiles,
    sensitive_patterns: ["SECRET", "API_KEY", "TOKEN=", "PRIVATE_KEY"],
    required_tests: [],
    required_test_mappings: likelyTestMappings,
    module_boundaries: [],
    missing_authority_rules: ["Authority:"]
  };

  return {
    packageManagers,
    files: classifications,
    sourceFiles,
    testFiles,
    docsFiles,
    configFiles,
    generatedFiles,
    buildOutputPaths,
    likelyPairedFiles,
    likelyPublicApiFiles,
    likelyTestMappings,
    suggestedPolicy
  };
}

export function createCostTokenBenchmarkReport(fixtures: CostBenchmarkFixture[]): CostTokenBenchmarkReport {
  const flows: CostBenchmarkFlow[] = ["direct_large_context", "bounded_workspace", "workspace_verifier", "workspace_verifier_remask"];
  const measurements = fixtures.flatMap((fixture) => flows.map((flow) => measureFlowCost(fixture, flow)));
  const flowSummaries = flows.map((flow) => {
    const rows = measurements.filter((measurement) => measurement.flow === flow);
    return {
      flow,
      averageInputTokens: average(rows.map((row) => row.estimatedInputTokens)),
      averageOutputTokens: average(rows.map((row) => row.estimatedOutputTokens)),
      averageTotalTokens: average(rows.map((row) => row.totalEstimatedTokens)),
      averageBudgetUtilization: average(rows.map((row) => row.budgetUtilization)),
      totalRemaskExtraTokens: sum(rows.map((row) => row.remaskExtraTokens)),
      taskSuccessRate: average(rows.map((row) => row.taskSuccess)),
      scopeDriftRate: average(rows.map((row) => row.scopeDrift)),
      missedBlockerRate: average(rows.map((row) => row.missedBlocker)),
      falseBlockerRate: average(rows.map((row) => row.falseBlocker))
    };
  });
  const reportWithoutMarkdown = {
    id: "cost-token-benchmark-v1",
    createdAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    flows,
    measurements,
    flowSummaries
  };

  return {
    ...reportWithoutMarkdown,
    markdownReport: costTokenBenchmarkToMarkdown(reportWithoutMarkdown)
  };
}

export function createSyntheticWorkspacePacket(
  workspace: SharedWorkspaceSnapshot,
  role: DllmStyleExperimentRole,
  contextWidth: DllmStyleContextWidth
): SyntheticWorkspacePacket {
  const visibleFields = role === "direct_patch"
    ? ["task", "scope", "patchPlan"]
    : role === "verifier"
      ? ["task", "diff", "policy", "authority", "repoFacts"]
      : ["verifierResult", "remaskRequest", "patchPlan", "scope"];
  const broadExtras = contextWidth === "broad" ? ["diff.raw", "claims", "events", "roleViews"] : [];
  const maskedFields = role === "direct_patch" ? ["patchPlan"] : role === "verifier" ? ["verifierResult"] : ["remaskRequest"];
  const lockedFields = ["task", "scope.forbidden", "policy.forbidden_paths"];
  const packet = {
    role,
    contextWidth,
    workspaceId: workspace.id,
    visibleFields: [...visibleFields, ...broadExtras],
    maskedFields,
    lockedFields,
    prompt: `${role} ${contextWidth} synthetic workspace packet for ${workspace.task.title}.`
  };

  return {
    id: `${workspace.id}-${role}-${contextWidth}-packet`,
    ...packet,
    tokenEstimate: estimateTextTokens(packet)
  };
}

export function createDllmStyleExperimentReport(fixtures: DllmStyleExperimentFixture[]): DllmStyleExperimentReport {
  const roles: DllmStyleExperimentRole[] = ["direct_patch", "verifier", "remask"];
  const widths: DllmStyleContextWidth[] = ["narrow", "broad"];
  const measurements = fixtures.flatMap((fixture) => roles.flatMap((role) =>
    widths.map((contextWidth) => measureDllmStyleExperiment(fixture, role, contextWidth))
  ));
  const summaries = roles.flatMap((role) => widths.map((contextWidth) => {
    const rows = measurements.filter((measurement) => measurement.role === role && measurement.contextWidth === contextWidth);
    return {
      role,
      contextWidth,
      averageTokens: average(rows.map((row) => row.tokenEstimate)),
      scopeDriftRate: average(rows.map((row) => row.scopeDrift)),
      repairSuccessRate: average(rows.map((row) => row.repairSuccess)),
      averageCostDeltaTokens: average(rows.map((row) => row.costDeltaTokens))
    };
  }));
  const reportWithoutMarkdown = {
    id: "dllm-style-adapter-experiment-v1",
    createdAt: new Date().toISOString(),
    measurements,
    summaries
  };

  return {
    ...reportWithoutMarkdown,
    markdownReport: dllmStyleExperimentToMarkdown(reportWithoutMarkdown)
  };
}

export function createProductRuntimeArtifactV1(review: ReviewOutput): ProductRuntimeArtifactV1 {
  return {
    schemaVersion: "product-runtime-artifact/v1",
    decision: review.decision,
    riskLevel: review.riskLevel,
    metrics: review.metrics,
    findingCount: review.findings.length,
    remaskRegionCount: review.remaskRegions.length,
    repairProposalCount: review.repairProposals.length,
    workspaceId: review.workspace.id,
    traceEventCount: review.trace.length
  };
}

export function createTeamMetricsReport(artifacts: TeamMetricArtifact[]): TeamMetricsReport {
  const createdAt = new Date().toISOString();
  const allFindings = artifacts.flatMap((artifact) => artifact.findings);
  const roleViews = artifacts.flatMap((artifact) => Object.values(artifact.workspace.roleViews));
  const tokenBudgets = roleViews.map((view) => view.tokenBudget);
  const roleViewSizes = roleViews.map((view) => view.estimatedTokens);
  const riskTrend = createRiskTrend(artifacts);
  const costTrend = createCostTrend(artifacts);
  const policyConsoleModel = createPolicyConsoleModel(artifacts);
  const reportWithoutMarkdown = {
    schemaVersion: "team-metrics/v1" as const,
    createdAt,
    artifactCount: artifacts.length,
    aiPatchCount: artifacts.length,
    boundaryGuessCount: artifacts.filter((artifact) => artifact.decision === "refuse" || artifact.decision === "human_review_required").length,
    falseBlockerCount: 0,
    missedBlockerCount: 0,
    remaskRequiredCount: artifacts.filter((artifact) => artifact.decision === "remask_required").length,
    remaskSuccessCount: artifacts.filter((artifact) => artifact.remaskRegions.length > 0 && artifact.decision !== "reject").length,
    averageTokenBudget: average(tokenBudgets),
    averageRoleViewSize: average(roleViewSizes),
    scopeDriftCount: artifacts.filter((artifact) => artifact.metrics.scopeSafety === 0).length,
    ownershipMissCount: allFindings.filter((finding) => finding.category === "ownership").length,
    moduleBoundaryFindingCount: allFindings.filter((finding) => finding.category === "module_boundary").length,
    riskTrend,
    costTrend,
    policyConsoleModel
  };

  return {
    ...reportWithoutMarkdown,
    markdownReport: teamMetricsToMarkdown(reportWithoutMarkdown)
  };
}

export function createSharedWorkspaceSnapshot(input: ReviewInput): SharedWorkspaceSnapshot {
  const id = `workspace-${slugify(input.task.id || input.task.title)}`;
  const roleViews = createRoleViews(input, id);
  const repoIntelligence = input.repoIntelligence ?? (input.repoFiles ? analyzeRepositoryFiles(input.repoFiles) : undefined);
  const scope: WorkspaceScope = {
    allowed: input.policy.allowed_paths,
    forbidden: input.policy.forbidden_paths,
    changedFiles: input.diff.changedFiles
  };
  const authority: WorkspaceAuthority = {
    facts: input.task.authorityFacts ?? [],
    missingRules: input.policy.missing_authority_rules ?? []
  };
  const repoFacts: WorkspaceRepoFacts = {
    changedFiles: input.diff.changedFiles,
    ownership: input.policy.ownership ?? {},
    pairedFiles: input.policy.paired_files ?? [],
    requiredTests: input.policy.required_tests ?? [],
    requiredTestMappings: input.policy.required_test_mappings ?? [],
    moduleBoundaries: input.policy.module_boundaries ?? [],
    sensitivePatterns: input.policy.sensitive_patterns ?? [],
    staleFacts: [],
    intelligence: repoIntelligence
  };
  const patchPlan: PatchPlan = {
    summary: input.diff.changedFiles.length
      ? `Review proposed changes in ${input.diff.changedFiles.join(", ")}.`
      : "No changed files were detected; automatic patch planning is blocked.",
    files: input.diff.changedFiles,
    allowedEditRegions: input.policy.allowed_paths,
    forbiddenEditRegions: input.policy.forbidden_paths,
    requiredSignals: [
      ...(input.policy.required_tests ?? []),
      ...(input.policy.required_test_mappings ?? []).map((rule) => rule.test)
    ]
  };
  const events: WorkspaceEvent[] = [
    {
      id: `${id}-event-created`,
      actor: "workspace_builder",
      action: "workspace_created",
      target: "workspace",
      summary: "Task, scope, authority, repo facts, policy and patch intent were converted into SharedWorkspace v1.",
      relatedIds: []
    },
    {
      id: `${id}-event-role-views`,
      actor: "context_composer",
      action: "role_views_created",
      target: "workspace",
      summary: "Role-specific bounded working memory views were created from the shared workspace.",
      relatedIds: []
    }
  ];

  return {
    id,
    version: 1,
    task: input.task,
    scope,
    authority,
    policy: input.policy,
    repoFacts,
    diff: input.diff,
    roleViews,
    claims: [],
    conflicts: [],
    patchPlan,
    events,
    trace: [
      {
        id: `${id}-trace-created`,
        actor: "workspace_builder",
        action: "workspace_created",
        summary: "Task, diff and policy were converted into a shared semantic workspace."
      },
      {
        id: `${id}-trace-role-views`,
        actor: "context_composer",
        action: "role_views_created",
        summary: "Role-specific bounded working memory views were created."
      }
    ]
  };
}

export function addAgentClaim(workspace: SharedWorkspaceSnapshot, claim: AgentClaim): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    claims: [...workspace.claims, claim]
  }, {
    id: `${workspace.id}-event-claim-${claim.id}`,
    actor: claim.actor,
    action: "claim_added",
    target: claim.target,
    summary: claim.summary,
    relatedIds: [claim.id]
  });
}

export function addWorkspaceConflict(
  workspace: SharedWorkspaceSnapshot,
  conflict: WorkspaceConflictRecord
): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    conflicts: [...workspace.conflicts, conflict]
  }, {
    id: `${workspace.id}-event-conflict-${conflict.id}`,
    actor: "merge",
    action: "conflict_recorded",
    target: "workspace",
    summary: conflict.summary,
    relatedIds: conflict.claimIds
  });
}

export function recordVerifierResult(
  workspace: SharedWorkspaceSnapshot,
  verifierResult: WorkspaceVerifierResult
): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    verifierResult
  }, {
    id: `${workspace.id}-event-verifier-${workspace.events.length + 1}`,
    actor: "verifier",
    action: "verifier_result_recorded",
    target: "verifier_result",
    summary: `Verifier decision is ${verifierResult.decision}.`,
    relatedIds: verifierResult.findings.map((finding) => finding.id)
  });
}

export function recordRemaskRequest(
  workspace: SharedWorkspaceSnapshot,
  remaskRequest: WorkspaceRemaskRequest
): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    remaskRequest
  }, {
    id: `${workspace.id}-event-remask-${workspace.events.length + 1}`,
    actor: "remask",
    action: "remask_request_recorded",
    target: "remask_request",
    summary: remaskRequest.required
      ? `Verifier requested ${remaskRequest.regions.length} local remask region(s).`
      : "Verifier did not request remask.",
    relatedIds: remaskRequest.regions.map((region) => region.id)
  });
}

export function recordMergeDecision(
  workspace: SharedWorkspaceSnapshot,
  mergeDecision: WorkspaceMergeDecision
): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    mergeDecision
  }, {
    id: `${workspace.id}-event-merge-${workspace.events.length + 1}`,
    actor: "merge",
    action: "merge_decision_recorded",
    target: "merge_decision",
    summary: `Final workspace decision is ${mergeDecision.decision}.`,
    relatedIds: []
  });
}

export function evaluateMergeSafety(workspace: SharedWorkspaceSnapshot): MergeSafetyReport {
  const findings = [
    ...findConflictingClaims(workspace),
    ...findStaleClaims(workspace),
    ...findUnsafeOverwrites(workspace),
    ...findPatchAuthorityViolations(workspace)
  ];

  return {
    ok: findings.every((finding) => finding.severity !== "high"),
    findings,
    conflictCount: findings.filter((finding) => finding.kind === "claim_conflict").length,
    staleClaimCount: findings.filter((finding) => finding.kind === "stale_claim").length,
    unsafeOverwriteCount: findings.filter((finding) => finding.kind === "unsafe_overwrite").length,
    authorityViolationCount: findings.filter((finding) => finding.kind === "scope_conflict" || finding.kind === "authority_conflict").length
  };
}

export function recordMergeSafety(workspace: SharedWorkspaceSnapshot, report: MergeSafetyReport): SharedWorkspaceSnapshot {
  return report.findings.reduce((nextWorkspace, finding) => addWorkspaceConflict(nextWorkspace, {
    id: finding.id,
    kind: finding.kind === "stale_claim" || finding.kind === "unsafe_overwrite" ? "claim_conflict" : finding.kind,
    summary: finding.summary,
    claimIds: finding.claimIds,
    severity: finding.severity
  }), workspace);
}

export function recordPatchPlan(workspace: SharedWorkspaceSnapshot, patchPlan: PatchPlan, actor: AgentRoleView): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent({
    ...workspace,
    patchPlan
  }, {
    id: `${workspace.id}-event-patch-plan-${workspace.events.length + 1}`,
    actor,
    action: "patch_plan_recorded",
    target: "patch_plan",
    summary: patchPlan.summary,
    relatedIds: []
  });
}

export function serializeSharedWorkspace(workspace: SharedWorkspaceSnapshot): string {
  return `${JSON.stringify(workspace, null, 2)}\n`;
}

export function deserializeSharedWorkspace(raw: string): SharedWorkspaceSnapshot {
  const parsed = JSON.parse(raw) as SharedWorkspaceSnapshot;
  if (!parsed.id || parsed.version !== 1 || !parsed.task || !parsed.scope || !parsed.repoFacts || !Array.isArray(parsed.events)) {
    throw new Error("Invalid SharedWorkspace v1 payload.");
  }
  return parsed;
}

export function validateRoleAdapterOutput(output: RoleAdapterOutput, expectedRole: ModelAdapterRole): RoleAdapterValidationResult {
  const errors: string[] = [];
  if (output.role !== expectedRole) errors.push(`Expected role ${expectedRole}, got ${output.role}.`);
  if (!output.adapterName.trim()) errors.push("adapterName is required.");
  if (output.confidence < 0 || output.confidence > 1) errors.push("confidence must be between 0 and 1.");
  if (!output.summary.trim()) errors.push("summary is required.");
  if (!Array.isArray(output.claims)) errors.push("claims must be an array.");
  if (output.patchPlan && expectedRole !== "coder") errors.push("Only coder adapters can return patchPlan.");
  if (output.verifierFindings && expectedRole !== "verifier") errors.push("Only verifier adapters can return verifierFindings.");
  if (output.remaskRegions && expectedRole !== "remask") errors.push("Only remask adapters can return remaskRegions.");
  return { ok: errors.length === 0, errors };
}

export function createMockRoleAdapter(role: ModelAdapterRole, mode: ModelAdapterMode = "mock"): RoleAdapter {
  return {
    name: `mock-${role}-adapter`,
    role,
    mode,
    execute(input) {
      const claim: AgentClaim = {
        id: `${input.workspace.id}-${role}-adapter-claim`,
        actor: role,
        target: role === "verifier" ? "verifier_result" : role === "remask" ? "remask_request" : "patch_plan",
        summary: `Mock ${role} adapter wrote a bounded workspace proposal.`,
        status: "accepted",
        evidence: input.diff.changedFiles
      };
      return {
        adapterName: `mock-${role}-adapter`,
        role,
        mode,
        confidence: 0.9,
        summary: `Mock ${role} adapter output.`,
        claims: [claim],
        patchPlan: role === "coder" ? input.workspace.patchPlan : undefined,
        verifierFindings: role === "verifier" ? [] : undefined,
        remaskRegions: role === "remask" ? input.workspace.remaskRequest?.regions ?? [] : undefined
      };
    }
  };
}

function executeRoleAdapterIfPresent(
  input: ReviewInput,
  workspace: SharedWorkspaceSnapshot,
  role: ModelAdapterRole
): RoleAdapterOutput | undefined {
  const adapter = input.roleAdapters?.[role];
  if (!adapter) return undefined;
  const output = adapter.execute({
    role,
    task: input.task,
    diff: input.diff,
    policy: input.policy,
    workspace,
    roleView: workspace.roleViews[role]
  });
  const validation = validateRoleAdapterOutput(output, role);
  if (!validation.ok) {
    throw new Error(`Invalid ${role} adapter output: ${validation.errors.join("; ")}`);
  }
  return output;
}

function applyRoleAdapterOutput(workspace: SharedWorkspaceSnapshot, output: RoleAdapterOutput): SharedWorkspaceSnapshot {
  const withPatchPlan = output.patchPlan ? recordPatchPlan(workspace, output.patchPlan, "coder") : workspace;
  return output.claims.reduce((nextWorkspace, claim) => addAgentClaim(nextWorkspace, claim), withPatchPlan);
}

function createMockRoleAgents(): Partial<Record<WorkspaceActor, MockRoleAgent>> {
  return {
    planner: {
      role: "planner",
      execute({ workspace, step }) {
        assertWritePermission(step, "claims");
        const claim: AgentClaim = {
          id: `${workspace.id}-planner-claim`,
          actor: "planner",
          target: "patch_plan",
          summary: `Plan task inside allowed scope: ${workspace.scope.allowed.join(", ") || "(none)"}.`,
          status: "accepted",
          evidence: ["task", "scope.allowed", "scope.forbidden"]
        };
        const nextWorkspace = appendStepCompleted(addAgentClaim(workspace, claim), step, "Planner claim was written.");
        return {
          workspace: nextWorkspace,
          result: createStepResult(step.id, step.actor, "completed", "Planner claim was written.", [claim.id], [])
        };
      }
    },
    coder: {
      role: "coder",
      execute({ input, workspace, step }) {
        assertWritePermission(step, "patchPlan");
        const adapterOutput = executeRoleAdapterIfPresent(input, workspace, "coder");
        if (adapterOutput) {
          const adapterWorkspace = applyRoleAdapterOutput(workspace, adapterOutput);
          const nextWorkspace = appendStepCompleted(adapterWorkspace, step, `Coder adapter ${adapterOutput.adapterName} recorded a patch proposal.`);
          return {
            workspace: nextWorkspace,
            result: createStepResult(step.id, step.actor, "completed", `Coder adapter ${adapterOutput.adapterName} recorded a patch proposal.`, adapterOutput.claims.map((claim) => claim.id), [])
          };
        }
        const patchPlan: PatchPlan = {
          ...workspace.patchPlan,
          summary: workspace.patchPlan.files.length
            ? `Mock coder patch plan stays inside ${workspace.patchPlan.files.join(", ")}.`
            : "Mock coder cannot create a patch plan without changed files.",
          allowedEditRegions: workspace.scope.allowed,
          forbiddenEditRegions: workspace.scope.forbidden
        };
        const claim: AgentClaim = {
          id: `${workspace.id}-coder-claim`,
          actor: "coder",
          target: "patch_plan",
          summary: patchPlan.summary,
          status: "accepted",
          evidence: patchPlan.files
        };
        const withPlan = recordPatchPlan(workspace, patchPlan, "coder");
        const withClaim = addAgentClaim(withPlan, claim);
        const nextWorkspace = appendStepCompleted(withClaim, step, "Coder patch plan was recorded.");
        return {
          workspace: nextWorkspace,
          result: createStepResult(step.id, step.actor, "completed", "Coder patch plan was recorded.", [claim.id], [])
        };
      }
    },
    verifier: {
      role: "verifier",
      execute({ input, workspace, step }) {
        assertWritePermission(step, "verifierResult");
        const adapterOutput = executeRoleAdapterIfPresent(input, workspace, "verifier");
        const adapterFindings = adapterOutput?.verifierFindings?.map((finding) => createFinding(
          finding.category,
          finding.severity,
          finding.message,
          finding.files,
          finding.suggestedAction,
          {
            ...(finding.metadata ?? {}),
            adapterName: adapterOutput.adapterName,
            adapterMode: adapterOutput.mode,
            adapterConfidence: String(adapterOutput.confidence)
          }
        )) ?? [];
        const workspaceWithAdapterClaims = adapterOutput ? applyRoleAdapterOutput(workspace, adapterOutput) : workspace;
        const findings = [...createDeterministicFindings(input), ...adapterFindings];
        const decision = decide(findings, input.diff);
        const nextWorkspace = appendStepCompleted(recordVerifierResult(workspaceWithAdapterClaims, {
          decision,
          findings,
          checkedFiles: input.diff.changedFiles
        }), step, adapterOutput ? `Verifier adapter ${adapterOutput.adapterName} contributed; decision is ${decision}.` : `Verifier decision is ${decision}.`);
        return {
          workspace: nextWorkspace,
          result: createStepResult(step.id, step.actor, "completed", `Verifier decision is ${decision}.`, [], [])
        };
      }
    },
    remask: {
      role: "remask",
      execute({ input, workspace, step }) {
        assertWritePermission(step, "remaskRequest");
        const adapterOutput = executeRoleAdapterIfPresent(input, workspace, "remask");
        const workspaceWithAdapterClaims = adapterOutput ? applyRoleAdapterOutput(workspace, adapterOutput) : workspace;
        const regions = adapterOutput?.remaskRegions ?? workspaceWithAdapterClaims.remaskRequest?.regions ?? createRemaskRegions(workspaceWithAdapterClaims.verifierResult?.findings ?? []);
        const withRequest = recordRemaskRequest(workspaceWithAdapterClaims, {
          required: regions.length > 0,
          regions
        });
        const claim: AgentClaim = {
          id: `${workspace.id}-remask-claim`,
          actor: "remask",
          target: "remask_request",
          summary: regions.length
            ? `Repair only verifier-marked region(s): ${regions.map((region) => region.id).join(", ")}.`
            : "No remask region was required.",
          status: "accepted",
          evidence: regions.map((region) => region.id)
        };
        const withClaim = regions.length ? addAgentClaim(withRequest, claim) : withRequest;
        const nextWorkspace = appendStepCompleted(withClaim, step, regions.length ? "Remask request was claimed." : "Remask was not required.");
        return {
          workspace: nextWorkspace,
          result: createStepResult(step.id, step.actor, regions.length ? "completed" : "skipped", nextWorkspace.trace.at(-1)?.summary ?? "Remask step completed.", regions.length ? [claim.id] : [], [])
        };
      }
    },
    merge: {
      role: "merge",
      execute({ workspace, step }) {
        assertWritePermission(step, "mergeDecision");
        const safetyReport = evaluateMergeSafety(workspace);
        const workspaceWithSafety = recordMergeSafety(workspace, safetyReport);
        const verifierDecision = workspace.verifierResult?.decision ?? "human_review_required";
        const decision = safetyReport.ok ? verifierDecision : "human_review_required";
        const riskLevel = safetyReport.ok ? toRiskLevel(decision, workspace.verifierResult?.findings ?? []) : "high";
        const nextWorkspace = appendStepCompleted(recordMergeDecision(workspaceWithSafety, {
          decision,
          riskLevel,
          reason: safetyReport.ok ? explainDecision(decision) : "Merge safety found conflicting, stale or unsafe workspace writes.",
          safetyReport
        }), step, `Final merge decision is ${decision}.`);
        return {
          workspace: nextWorkspace,
          result: createStepResult(step.id, step.actor, "completed", `Final merge decision is ${decision}.`, [], [])
        };
      }
    }
  };
}

function measureFlowCost(fixture: CostBenchmarkFixture, flow: CostBenchmarkFlow): FlowCostMeasurement {
  const review = reviewPatch(fixture.input);
  const expectedDecision = fixture.expectedDecision ?? review.decision;
  const decision = flow === "direct_large_context" ? directBaselineDecision(fixture.input) : review.decision;
  const roleViewTokens = flow === "direct_large_context" ? 0 : sum(Object.values(review.workspace.roleViews).map((view) => view.estimatedTokens));
  const remaskExtraTokens = flow === "workspace_verifier_remask" && review.remaskRegions.length
    ? review.workspace.roleViews.remask.estimatedTokens + estimateTextTokens(review.remaskRegions)
    : 0;
  const estimatedInputTokens = estimateFlowInputTokens(fixture.input, review, flow);
  const estimatedOutputTokens = estimateFlowOutputTokens(review, flow);
  const blockerExpected = expectedDecision !== "approve";
  const blockerFound = decision !== "approve";

  return {
    fixtureId: fixture.id,
    flow,
    estimatedInputTokens,
    estimatedOutputTokens,
    totalEstimatedTokens: estimatedInputTokens + estimatedOutputTokens + remaskExtraTokens,
    roleViewTokens,
    budgetUtilization: flow === "direct_large_context" ? 1 : average(Object.values(review.workspace.roleViews).map((view) => view.budgetUtilization)),
    remaskExtraTokens,
    decision,
    taskSuccess: decision === expectedDecision ? 1 : 0,
    scopeDrift: decision === "approve" && review.findings.some((finding) => finding.suggestedAction === "reject") ? 1 : 0,
    missedBlocker: blockerExpected && !blockerFound ? 1 : 0,
    falseBlocker: !blockerExpected && blockerFound ? 1 : 0
  };
}

function measureDllmStyleExperiment(
  fixture: DllmStyleExperimentFixture,
  role: DllmStyleExperimentRole,
  contextWidth: DllmStyleContextWidth
): DllmStyleExperimentMeasurement {
  const review = reviewPatch(fixture.input);
  const packet = createSyntheticWorkspacePacket(review.workspace, role, contextWidth);
  const decision = role === "direct_patch" ? directBaselineDecision(fixture.input) : review.decision;
  const repairSuccess = role === "remask" && review.remaskRegions.length > 0 && decision === fixture.expectedDecision ? 1 : 0;
  const scopeDrift = decision === "approve" && fixture.expectedDecision !== "approve" ? 1 : 0;
  const broadBaseline = createSyntheticWorkspacePacket(review.workspace, role, "broad").tokenEstimate;

  return {
    fixtureId: fixture.id,
    role,
    contextWidth,
    tokenEstimate: packet.tokenEstimate,
    decision,
    scopeDrift,
    repairSuccess,
    costDeltaTokens: packet.tokenEstimate - broadBaseline
  };
}

function dllmStyleExperimentToMarkdown(input: Omit<DllmStyleExperimentReport, "markdownReport">): string {
  return [
    "# dLLM-Style Adapter Experiment v1",
    "",
    `- Created at: ${input.createdAt}`,
    "",
    "## Summary",
    "",
    table(
      ["Role", "Context", "Avg Tokens", "Scope Drift", "Repair Success", "Avg Cost Delta"],
      input.summaries.map((summary) => [
        summary.role,
        summary.contextWidth,
        summary.averageTokens.toString(),
        percentDecimal(summary.scopeDriftRate),
        percentDecimal(summary.repairSuccessRate),
        summary.averageCostDeltaTokens.toString()
      ])
    ),
    "",
    "## Measurements",
    "",
    table(
      ["Fixture", "Role", "Context", "Tokens", "Decision", "Scope Drift", "Repair Success", "Cost Delta"],
      input.measurements.map((measurement) => [
        measurement.fixtureId,
        measurement.role,
        measurement.contextWidth,
        measurement.tokenEstimate.toString(),
        measurement.decision,
        measurement.scopeDrift.toString(),
        measurement.repairSuccess.toString(),
        measurement.costDeltaTokens.toString()
      ])
    )
  ].join("\n");
}

function createRiskTrend(artifacts: TeamMetricArtifact[]): Array<{ bucket: string; low: number; medium: number; high: number }> {
  const buckets = new Map<string, { bucket: string; low: number; medium: number; high: number }>();
  artifacts.forEach((artifact, index) => {
    const bucket = artifact.createdAt?.slice(0, 10) || `run-${index + 1}`;
    const row = buckets.get(bucket) ?? { bucket, low: 0, medium: 0, high: 0 };
    row[artifact.riskLevel] += 1;
    buckets.set(bucket, row);
  });
  return Array.from(buckets.values());
}

function createCostTrend(artifacts: TeamMetricArtifact[]): Array<{ bucket: string; averageTokenBudget: number; averageRoleViewSize: number }> {
  const buckets = new Map<string, TeamMetricArtifact[]>();
  artifacts.forEach((artifact, index) => {
    const bucket = artifact.createdAt?.slice(0, 10) || `run-${index + 1}`;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), artifact]);
  });
  return Array.from(buckets.entries()).map(([bucket, rows]) => {
    const views = rows.flatMap((row) => Object.values(row.workspace.roleViews));
    return {
      bucket,
      averageTokenBudget: average(views.map((view) => view.tokenBudget)),
      averageRoleViewSize: average(views.map((view) => view.estimatedTokens))
    };
  });
}

function createPolicyConsoleModel(artifacts: TeamMetricArtifact[]): TeamMetricsReport["policyConsoleModel"] {
  return {
    ownership: Object.assign({}, ...artifacts.map((artifact) => artifact.workspace.policy.ownership ?? {})),
    allowedPaths: Array.from(new Set(artifacts.flatMap((artifact) => artifact.workspace.policy.allowed_paths))).sort(),
    pairedFiles: artifacts.flatMap((artifact) => artifact.workspace.policy.paired_files ?? [])
  };
}

function teamMetricsToMarkdown(input: Omit<TeamMetricsReport, "markdownReport">): string {
  return [
    "# Team Metrics v1",
    "",
    `- Artifact count: ${input.artifactCount}`,
    `- AI patch count: ${input.aiPatchCount}`,
    `- Remask required: ${input.remaskRequiredCount}`,
    `- Scope drift: ${input.scopeDriftCount}`,
    `- Ownership misses: ${input.ownershipMissCount}`,
    `- Module boundary findings: ${input.moduleBoundaryFindingCount}`,
    "",
    "## Summary",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Boundary guess count", input.boundaryGuessCount.toString()],
        ["False blocker count", input.falseBlockerCount.toString()],
        ["Missed blocker count", input.missedBlockerCount.toString()],
        ["Remask success count", input.remaskSuccessCount.toString()],
        ["Average token budget", input.averageTokenBudget.toString()],
        ["Average role view size", input.averageRoleViewSize.toString()]
      ]
    ),
    "",
    "## Risk Trend",
    "",
    table(
      ["Bucket", "Low", "Medium", "High"],
      input.riskTrend.map((row) => [row.bucket, row.low.toString(), row.medium.toString(), row.high.toString()])
    ),
    "",
    "## Cost Trend",
    "",
    table(
      ["Bucket", "Average Token Budget", "Average Role View Size"],
      input.costTrend.map((row) => [row.bucket, row.averageTokenBudget.toString(), row.averageRoleViewSize.toString()])
    )
  ].join("\n");
}

function detectPackageManagers(files: string[]): string[] {
  const managers: string[] = [];
  if (files.includes("package-lock.json")) managers.push("npm");
  if (files.includes("pnpm-lock.yaml")) managers.push("pnpm");
  if (files.includes("yarn.lock")) managers.push("yarn");
  if (files.includes("bun.lockb") || files.includes("bun.lock")) managers.push("bun");
  if (files.includes("pyproject.toml") || files.includes("poetry.lock")) managers.push("python");
  if (files.includes("go.mod")) managers.push("go");
  if (files.includes("Cargo.toml")) managers.push("rust");
  return managers;
}

function classifyRepoFile(path: string): RepoFileClassification {
  if (isGeneratedPath(path)) return { path, kind: "generated", reason: "Path matches generated artifact conventions." };
  if (isBuildOutputPath(path)) return { path, kind: "build", reason: "Path matches build output conventions." };
  if (isTestPath(path)) return { path, kind: "test", reason: "Path or filename matches test conventions." };
  if (isDocsPath(path)) return { path, kind: "docs", reason: "Path is documentation-like." };
  if (isConfigPath(path)) return { path, kind: "config", reason: "Path is configuration or package metadata." };
  if (isPublicApiPath(path)) return { path, kind: "public_api", reason: "Path looks like a package entrypoint or public type surface." };
  if (isSourcePath(path)) return { path, kind: "source", reason: "Path is under a source/package/app directory or has a source extension." };
  return { path, kind: "unknown", reason: "No v1 repo intelligence classifier matched." };
}

function inferLikelyPairedFiles(files: string[]): PairedFileRule[] {
  const rules: PairedFileRule[] = [];
  if (files.includes("package.json") && files.includes("package-lock.json")) {
    rules.push({
      source: "package.json",
      requires: "package-lock.json",
      reason: "npm package metadata changes usually require lockfile alignment",
      changed_when_contains: ["version", "dependencies", "devDependencies"]
    });
  }
  if (files.includes("package.json") && files.includes("pnpm-lock.yaml")) {
    rules.push({
      source: "package.json",
      requires: "pnpm-lock.yaml",
      reason: "pnpm package metadata changes usually require lockfile alignment",
      changed_when_contains: ["version", "dependencies", "devDependencies"]
    });
  }
  if (files.includes("package.json") && files.includes("yarn.lock")) {
    rules.push({
      source: "package.json",
      requires: "yarn.lock",
      reason: "yarn package metadata changes usually require lockfile alignment",
      changed_when_contains: ["version", "dependencies", "devDependencies"]
    });
  }
  if (files.includes("tsconfig.json") && files.includes("package.json")) {
    rules.push({
      source: "tsconfig.json",
      requires: "package.json",
      reason: "TypeScript config changes may require script or package metadata review",
      changed_when_contains: ["compilerOptions", "paths", "references"]
    });
  }
  return rules;
}

function inferLikelyTestMappings(sourceFiles: string[], testFiles: string[]): RequiredTestMappingRule[] {
  const mappings: RequiredTestMappingRule[] = [];
  const roots = Array.from(new Set(sourceFiles.map((file) => topModuleRoot(file)).filter(Boolean)));

  for (const root of roots) {
    const hasTests = testFiles.some((file) => file.startsWith(`${root}/`) || file.startsWith(`tests/${root}/`));
    if (!hasTests) continue;
    mappings.push({
      source: `${root}/**`,
      test: `${root}/**/*.test.ts`,
      reason: `${root} source changes should include nearby tests`,
      changed_when_contains: ["export function", "export const", "class "]
    });
  }

  return mappings;
}

function inferAllowedPaths(...groups: string[][]): string[] {
  const roots = groups.flatMap((group) => group.map((file) => topModuleRoot(file)).filter(Boolean));
  const allowed = Array.from(new Set(roots.map((root) => `${root}/**`)));
  return allowed.length ? allowed : ["src/**", "packages/**", "apps/**", "docs/**"];
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim();
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(generated|__generated__|coverage)\//.test(path) || /\.(generated|gen)\.[cm]?[jt]sx?$/.test(path);
}

function isBuildOutputPath(path: string): boolean {
  return /(^|\/)(dist|build|out|target|\.next|\.turbo)\//.test(path);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isDocsPath(path: string): boolean {
  return path.startsWith("docs/") || path.toLowerCase().endsWith(".md") || path.toLowerCase().endsWith(".mdx");
}

function isConfigPath(path: string): boolean {
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json|vite\.config\.[jt]s|next\.config\.[jt]s|eslint\.config\.[jt]s|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(path);
}

function isPublicApiPath(path: string): boolean {
  return /(^|\/)(index|main|mod)\.[cm]?[jt]sx?$/.test(path) || /\.d\.ts$/.test(path);
}

function isSourcePath(path: string): boolean {
  return /(^|\/)(src|packages|apps|lib)\//.test(path) || /\.[cm]?[jt]sx?$/.test(path);
}

function topModuleRoot(path: string): string {
  const parts = path.split("/");
  if (["packages", "apps"].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (["src", "lib", "docs", "test", "tests"].includes(parts[0])) return parts[0];
  if (path.includes("/")) return parts[0];
  return "";
}

function estimateFlowInputTokens(input: ReviewInput, review: ReviewOutput, flow: CostBenchmarkFlow): number {
  if (flow === "direct_large_context") return estimateTextTokens({ task: input.task, diff: input.diff, policy: input.policy, mode: "direct_large_context" });
  if (flow === "bounded_workspace") return sum([
    review.workspace.roleViews.planner.estimatedTokens,
    review.workspace.roleViews.coder.estimatedTokens
  ]);
  if (flow === "workspace_verifier") return sum([
    review.workspace.roleViews.planner.estimatedTokens,
    review.workspace.roleViews.coder.estimatedTokens,
    review.workspace.roleViews.verifier.estimatedTokens
  ]);
  return sum(Object.values(review.workspace.roleViews).map((view) => view.estimatedTokens));
}

function estimateFlowOutputTokens(review: ReviewOutput, flow: CostBenchmarkFlow): number {
  if (flow === "direct_large_context") return 450;
  if (flow === "bounded_workspace") return estimateTextTokens(review.workspace.patchPlan);
  if (flow === "workspace_verifier") return estimateTextTokens({ findings: review.findings, decision: review.decision });
  return estimateTextTokens({ findings: review.findings, remaskRegions: review.remaskRegions, decision: review.decision });
}

function directBaselineDecision(input: ReviewInput): ReviewDecision {
  return input.diff.changedFiles.length ? "approve" : "human_review_required";
}

function costTokenBenchmarkToMarkdown(input: Omit<CostTokenBenchmarkReport, "markdownReport">): string {
  return [
    "# Cost/Token Benchmark v1",
    "",
    `- Fixtures: ${input.fixtureCount}`,
    `- Created at: ${input.createdAt}`,
    "",
    "## Flow Summary",
    "",
    table(
      ["Flow", "Avg Input", "Avg Output", "Avg Total", "Avg Budget", "Remask Extra", "Task Success", "Scope Drift", "Missed Blocker", "False Blocker"],
      input.flowSummaries.map((summary) => [
        summary.flow,
        summary.averageInputTokens.toString(),
        summary.averageOutputTokens.toString(),
        summary.averageTotalTokens.toString(),
        percentDecimal(summary.averageBudgetUtilization),
        summary.totalRemaskExtraTokens.toString(),
        percentDecimal(summary.taskSuccessRate),
        percentDecimal(summary.scopeDriftRate),
        percentDecimal(summary.missedBlockerRate),
        percentDecimal(summary.falseBlockerRate)
      ])
    ),
    "",
    "## Measurements",
    "",
    table(
      ["Fixture", "Flow", "Input", "Output", "Total", "Remask Extra", "Decision"],
      input.measurements.map((measurement) => [
        measurement.fixtureId,
        measurement.flow,
        measurement.estimatedInputTokens.toString(),
        measurement.estimatedOutputTokens.toString(),
        measurement.totalEstimatedTokens.toString(),
        measurement.remaskExtraTokens.toString(),
        measurement.decision
      ])
    )
  ].join("\n");
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return roundRatio(sum(values) / values.length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentDecimal(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function createDeterministicFindings(input: ReviewInput): Finding[] {
  return [
    ...findScopeFindings(input),
    ...findAuthorityFindings(input),
    ...findOwnershipFindings(input),
    ...findModuleBoundaryFindings(input),
    ...findSensitiveBoundaryFindings(input),
    ...findPairedFileFindings(input),
    ...findTestFindings(input),
    ...normalizeVerifierAdapterFindings(input.verifierAdapterOutput)
  ];
}

function findConflictingClaims(workspace: SharedWorkspaceSnapshot): MergeSafetyFinding[] {
  const findings: MergeSafetyFinding[] = [];

  for (let leftIndex = 0; leftIndex < workspace.claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workspace.claims.length; rightIndex += 1) {
      const left = workspace.claims[leftIndex];
      const right = workspace.claims[rightIndex];
      if (left.target !== right.target) continue;
      if (left.actor === right.actor) continue;
      const writableOverlap = intersect(left.writableRegions ?? [], right.writableRegions ?? []);
      const hasExplicitConflictSignal = writableOverlap.length > 0 || left.status !== right.status;
      if (!hasExplicitConflictSignal) continue;
      if (normalizeClaimText(left.summary) === normalizeClaimText(right.summary) && left.status === right.status) continue;
      findings.push({
        id: `merge-conflict-${slugify(left.id)}-${slugify(right.id)}`,
        kind: "claim_conflict",
        severity: "high",
        summary: `Conflicting claims on ${left.target}: ${left.actor} and ${right.actor}.`,
        claimIds: [left.id, right.id],
        files: Array.from(new Set([...left.evidence, ...right.evidence]))
      });
    }
  }

  return findings;
}

function findStaleClaims(workspace: SharedWorkspaceSnapshot): MergeSafetyFinding[] {
  return workspace.claims
    .filter((claim) => claim.baseEventIndex !== undefined && claim.baseEventIndex < lastEventIndexForTarget(workspace, claim.target))
    .map((claim) => ({
      id: `merge-stale-${slugify(claim.id)}`,
      kind: "stale_claim",
      severity: "medium",
      summary: `Claim ${claim.id} was based on an older workspace event index.`,
      claimIds: [claim.id],
      files: claim.evidence
    }));
}

function findUnsafeOverwrites(workspace: SharedWorkspaceSnapshot): MergeSafetyFinding[] {
  const findings: MergeSafetyFinding[] = [];

  for (let leftIndex = 0; leftIndex < workspace.claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workspace.claims.length; rightIndex += 1) {
      const left = workspace.claims[leftIndex];
      const right = workspace.claims[rightIndex];
      if (left.actor === right.actor) continue;
      const overlap = intersect(left.writableRegions ?? [], right.writableRegions ?? []);
      if (!overlap.length) continue;
      findings.push({
        id: `merge-overwrite-${slugify(left.id)}-${slugify(right.id)}`,
        kind: "unsafe_overwrite",
        severity: "high",
        summary: `Claims ${left.id} and ${right.id} both write ${overlap.join(", ")}.`,
        claimIds: [left.id, right.id],
        files: overlap
      });
    }
  }

  return findings;
}

function findPatchAuthorityViolations(workspace: SharedWorkspaceSnapshot): MergeSafetyFinding[] {
  const violatingFiles = workspace.patchPlan.files.filter((file) =>
    matchesAny(file, workspace.scope.forbidden) ||
    (workspace.scope.allowed.length > 0 && !matchesAny(file, workspace.scope.allowed))
  );

  if (!violatingFiles.length) return [];

  return [{
    id: `${workspace.id}-merge-scope-conflict`,
    kind: "scope_conflict",
    severity: "high",
    summary: `Patch plan includes files outside merge authority: ${violatingFiles.join(", ")}.`,
    claimIds: workspace.claims.filter((claim) => claim.target === "patch_plan").map((claim) => claim.id),
    files: violatingFiles
  }];
}

function lastEventIndexForTarget(workspace: SharedWorkspaceSnapshot, target: AgentClaim["target"]): number {
  let lastIndex = -1;
  workspace.events.forEach((event, index) => {
    if (event.target === target || event.relatedIds.some((id) => workspace.claims.some((claim) => claim.id === id && claim.target === target))) {
      lastIndex = index;
    }
  });
  return lastIndex;
}

function normalizeClaimText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((item) => rightSet.has(item))));
}

function appendStepCompleted(
  workspace: SharedWorkspaceSnapshot,
  step: OrchestrationStepDefinition,
  summary: string
): SharedWorkspaceSnapshot {
  return appendWorkspaceEvent(workspace, {
    id: `${workspace.id}-event-step-${slugify(step.id)}-${workspace.events.length + 1}`,
    actor: step.actor,
    action: "step_completed",
    target: "workspace",
    summary,
    relatedIds: []
  });
}

function assertWritePermission(step: OrchestrationStepDefinition, field: string): void {
  if (!step.permission.write.includes(field)) {
    throw new Error(`${step.id} cannot write ${field}.`);
  }
}

function createStepResult(
  stepId: OrchestrationStepId,
  actor: WorkspaceActor,
  status: OrchestrationStepStatus,
  summary: string,
  claimIds: string[],
  eventIds: string[],
  error?: string
): OrchestrationStepResult {
  return { stepId, actor, status, summary, claimIds, eventIds, error };
}

function createdEventIds(workspace: SharedWorkspaceSnapshot, startIndex: number): string[] {
  return workspace.events.slice(startIndex).map((event) => event.id);
}

function lastEventId(workspace: SharedWorkspaceSnapshot): string {
  return workspace.events.at(-1)?.id ?? "";
}

function createOrchestrationMarkdownTrace(
  flow: OrchestrationFlowDefinition,
  steps: OrchestrationStepResult[],
  workspace: SharedWorkspaceSnapshot
): string {
  return [
    `# ${flow.id}`,
    "",
    flow.description,
    "",
    "## Steps",
    "",
    table(
      ["Step", "Actor", "Status", "Summary"],
      steps.map((step) => [step.stepId, step.actor, step.status, step.summary])
    ),
    "",
    "## Workspace",
    "",
    `- Workspace: ${workspace.id}`,
    `- Claims: ${workspace.claims.length}`,
    `- Events: ${workspace.events.length}`,
    `- Decision: ${workspace.mergeDecision?.decision ?? "(none)"}`,
    "",
    "## Trace",
    "",
    workspace.trace.map((event) => `- ${event.actor}: ${event.action} - ${event.summary}`).join("\n")
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMarkdownReport(output: Omit<ReviewOutput, "markdownReport">): string {
  const findingRows = output.findings.length
    ? output.findings.map((finding) => [
        finding.id,
        finding.severity,
        finding.category,
        finding.message,
        finding.files.join(", ") || "(none)",
        finding.suggestedAction
      ])
    : [["(none)", "info", "trace", "No verifier findings.", "(none)", "approve"]];
  const remaskRows = output.remaskRegions.length
    ? output.remaskRegions.map((region) => [region.id, region.reason, region.files.join(", "), region.instruction])
    : [["(none)", "(none)", "(none)", "(none)"]];
  const roleRows = Object.values(output.workspace.roleViews).map((view) => [
    view.role,
    view.tokenBudget.toString(),
    view.estimatedTokens.toString(),
    `${Math.round(view.budgetUtilization * 100)}%`,
    view.contextSufficiencyRisk,
    view.visibleFields.join(", "),
    view.writableFields.join(", "),
    view.excludedFacts.map((fact) => fact.field).join(", ")
  ]);

  return [
    "# Bounded Agent Runtime Review",
    "",
    `> **Decision:** ${output.decision}  `,
    `> **Risk:** ${output.riskLevel}  `,
    `> **Suggested next action:** ${suggestNextAction(output.decision)}`,
    "",
    `- Decision: ${output.decision}`,
    `- Risk: ${output.riskLevel}`,
    `- Changed files: ${output.metrics.changedFileCount}`,
    `- Findings: ${output.metrics.findingCount}`,
    `- Workspace: ${output.workspace.id}`,
    "",
    "## Summary Metrics",
    "",
    table(
      ["Metric", "Value"],
      [
        ["Scope safety", percentFlag(output.metrics.scopeSafety)],
        ["Authority safety", percentFlag(output.metrics.authoritySafety)],
        ["Ownership safety", percentFlag(output.metrics.ownershipSafety)],
        ["Module boundary safety", percentFlag(output.metrics.moduleBoundarySafety)],
        ["Sensitive boundary safety", percentFlag(output.metrics.sensitiveBoundarySafety)],
        ["Paired-file completeness", percentFlag(output.metrics.pairedFileCompleteness)],
        ["Remask need", output.metrics.remaskNeed ? "yes" : "no"],
        ["Trace completeness", percentFlag(output.metrics.traceCompleteness)]
      ]
    ),
    "",
    "## Decision Priority",
    "",
    output.decisionPriority.map((decision, index) => `${index + 1}. ${decision}`).join("\n"),
    "",
    "## Why This Matters",
    "",
    explainDecision(output.decision),
    "",
    "## Findings",
    "",
    table(["ID", "Severity", "Category", "Message", "Files", "Action"], findingRows),
    "",
    "## Remask Regions",
    "",
    table(["ID", "Reason", "Files", "Instruction"], remaskRows),
    "",
    "## Repair Proposals",
    "",
    table(
      ["ID", "Kind", "Files", "Summary", "Instruction"],
      output.repairProposals.length
        ? output.repairProposals.map((proposal) => [
            proposal.id,
            proposal.kind,
            proposal.files.join(", "),
            proposal.summary,
            `${proposal.instruction} Outline: ${proposal.patchOutline.join(" ")}`
          ])
        : [["(none)", "(none)", "(none)", "(none)", "(none)"]]
    ),
    "",
    "## Role-Specific Bounded Views",
    "",
    table(["Role", "Budget", "Estimated", "Utilization", "Risk", "Visible Fields", "Writable Fields", "Excluded Facts"], roleRows),
    "",
    "## Trace",
    "",
    output.trace.map((event) => `- ${event.actor}: ${event.action} - ${event.summary}`).join("\n")
  ].join("\n");
}

function createRoleViews(input: ReviewInput, workspaceId: string): Record<AgentRoleView, BoundedRoleView> {
  const changedFileSummary = input.diff.changedFiles.length
    ? `Changed files: ${input.diff.changedFiles.join(", ")}`
    : "No changed files were detected.";

  return {
    planner: composeRoleView({
      input,
      workspaceId,
      role: "planner",
      visibleFields: ["task", "scope.allowed", "scope.forbidden", "authority.missingRules", "policy.module_boundaries"],
      writableFields: ["claims", "patchPlan.summary"],
      defaultBudget: 1_500,
      summary: `Plan the bounded task: ${input.task.title}`,
      includedFacts: [
        includeFact("task", "Planner needs the task intent and business goal."),
        includeFact("scope.allowed", "Planner must shape work inside allowed paths."),
        includeFact("scope.forbidden", "Planner must keep forbidden scope visible as a hard boundary."),
        includeFact("authority.missingRules", "Planner must know when the task lacks product, owner, platform or compliance authority."),
        includeFact("policy.module_boundaries", "Planner needs cross-module risk notes before patch planning.")
      ],
      excludedFacts: [
        excludeFact("diff.raw", "Planner receives changed-file summary instead of full raw diff to avoid implementation-level noise."),
        excludeFact("repoFacts.sensitivePatterns", "Sensitive pattern rules are reserved for verifier view in v1."),
        excludeFact("repoFacts.staleFacts", "Stale facts are excluded from planning context by policy.")
      ]
    }),
    coder: composeRoleView({
      input,
      workspaceId,
      role: "coder",
      visibleFields: ["task", "scope.allowed", "scope.forbidden", "repoFacts.changedFiles", "patchPlan"],
      writableFields: ["claims", "patchPlan", "patchDraft"],
      defaultBudget: 4_000,
      summary: `Implement only inside allowed scope. ${changedFileSummary}`,
      includedFacts: [
        includeFact("task", "Coder needs the requested change and authority summary."),
        includeFact("scope.allowed", "Coder must know the writable file boundary."),
        includeFact("scope.forbidden", "Coder must avoid forbidden paths without seeing unrelated repo state."),
        includeFact("repoFacts.changedFiles", "Coder gets the minimal changed-file set instead of the full repo."),
        includeFact("patchPlan", "Coder writes and refines the bounded patch plan.")
      ],
      excludedFacts: [
        excludeFact("repoFacts.sensitivePatterns", "Sensitive pattern definitions are not sent to coder view; verifier checks them after proposal."),
        excludeFact("policy.owner_aliases", "Owner alias expansion is verifier/runtime authority context, not implementation context."),
        excludeFact("repoFacts.staleFacts", "Stale facts are excluded so coder does not implement from outdated context.")
      ]
    }),
    verifier: composeRoleView({
      input,
      workspaceId,
      role: "verifier",
      visibleFields: ["task", "diff", "policy", "authority", "repoFacts", "claims"],
      writableFields: ["verifierResult", "findings", "remaskRequest"],
      defaultBudget: 2_500,
      summary: "Check scope, authority, sensitive boundaries and paired-file consistency.",
      includedFacts: [
        includeFact("task", "Verifier needs task intent for scope and authority checks."),
        includeFact("diff", "Verifier needs the proposed patch surface."),
        includeFact("policy", "Verifier enforces allowed, forbidden, ownership, module, paired-file, test and sensitive rules."),
        includeFact("authority", "Verifier decides refusal when required authority is absent."),
        includeFact("repoFacts", "Verifier sees repo policy facts needed for deterministic boundary checks.")
      ],
      excludedFacts: [
        excludeFact("patchDraft.fullModelReasoning", "Verifier should inspect patch facts, not private model chain-of-thought."),
        excludeFact("repoFacts.staleFacts", "Stale facts are excluded from verifier evidence unless a later stale-fact adapter explicitly reintroduces them.")
      ]
    }),
    tester: composeRoleView({
      input,
      workspaceId,
      role: "tester",
      visibleFields: ["repoFacts.changedFiles", "repoFacts.requiredTests", "repoFacts.requiredTestMappings", "diff.changedFiles"],
      writableFields: ["claims", "testSignal"],
      defaultBudget: 1_200,
      summary: "Verify whether required tests are represented for the changed scope.",
      includedFacts: [
        includeFact("repoFacts.changedFiles", "Tester maps changed files to required test signals."),
        includeFact("repoFacts.requiredTests", "Tester checks global required test signals."),
        includeFact("repoFacts.requiredTestMappings", "Tester checks source-to-test mapping rules."),
        includeFact("diff.changedFiles", "Tester only needs file-level diff presence for v1.")
      ],
      excludedFacts: [
        excludeFact("diff.raw", "Tester v1 does not need full raw hunks for configured test-signal checks."),
        excludeFact("repoFacts.sensitivePatterns", "Sensitive boundary checks belong to verifier view."),
        excludeFact("repoFacts.staleFacts", "Stale facts are unrelated to test signal selection.")
      ]
    }),
    remask: composeRoleView({
      input,
      workspaceId,
      role: "remask",
      visibleFields: ["verifierResult", "remaskRequest", "patchPlan", "scope.allowed", "scope.forbidden"],
      writableFields: ["claims", "repairProposal", "patchDraft"],
      defaultBudget: 1_500,
      summary: "Repair only verifier-marked safe local failed regions.",
      includedFacts: [
        includeFact("verifierResult", "Remask starts only from verifier-marked failure."),
        includeFact("remaskRequest", "Remask must stay inside the local failed region."),
        includeFact("patchPlan", "Remask preserves the original bounded patch intent."),
        includeFact("scope.allowed", "Remask can only repair allowed files."),
        includeFact("scope.forbidden", "Remask must not broaden into forbidden scope.")
      ],
      excludedFacts: [
        excludeFact("diff.raw.fullPatch", "Remask receives failed-region context, not a full patch rewrite prompt."),
        excludeFact("repoFacts.sensitivePatterns", "Sensitive pattern definitions remain verifier-owned."),
        excludeFact("repoFacts.staleFacts", "Stale facts are excluded from repair context.")
      ]
    })
  };
}

function composeRoleView(input: {
  input: ReviewInput;
  workspaceId: string;
  role: AgentRoleView;
  visibleFields: string[];
  writableFields: string[];
  defaultBudget: number;
  summary: string;
  includedFacts: ContextFactSelection[];
  excludedFacts: ContextFactExclusion[];
}): BoundedRoleView {
  const tokenBudget = input.input.contextBudgets?.[input.role] ?? input.defaultBudget;
  const sourceFields = Array.from(new Set(input.includedFacts.map((fact) => fact.field)));
  const estimatedTokens = estimateRoleViewTokens(input);
  const budgetUtilization = roundRatio(estimatedTokens / tokenBudget);
  const contextSufficiencyRisk = estimateContextSufficiencyRisk({
    changedFileCount: input.input.diff.changedFiles.length,
    budgetUtilization,
    missingAuthorityRuleCount: input.input.policy.missing_authority_rules?.length ?? 0,
    role: input.role
  });
  const provenance: ViewProvenance = {
    workspaceId: input.workspaceId,
    sourceFields,
    composerVersion: "context-composer-v1"
  };
  const composerReport: ContextComposerReport = {
    role: input.role,
    budgetTokens: tokenBudget,
    estimatedTokens,
    budgetUtilization,
    includedFacts: input.includedFacts,
    excludedFacts: input.excludedFacts,
    provenance,
    contextSufficiencyRisk
  };

  return {
    role: input.role,
    visibleFields: input.visibleFields,
    writableFields: input.writableFields,
    tokenBudget,
    estimatedTokens,
    budgetUtilization,
    includedFacts: input.includedFacts,
    excludedFacts: input.excludedFacts,
    provenance,
    contextSufficiencyRisk,
    composerReport,
    summary: input.summary
  };
}

function includeFact(field: string, reason: string): ContextFactSelection {
  return { field, reason };
}

function excludeFact(field: string, reason: string): ContextFactExclusion {
  return { field, reason };
}

function estimateRoleViewTokens(input: {
  input: ReviewInput;
  role: AgentRoleView;
  visibleFields: string[];
  writableFields: string[];
  summary: string;
  includedFacts: ContextFactSelection[];
  excludedFacts: ContextFactExclusion[];
}): number {
  const payload = {
    role: input.role,
    summary: input.summary,
    visibleFields: input.visibleFields,
    writableFields: input.writableFields,
    includedFacts: input.includedFacts,
    task: input.input.task,
    changedFiles: input.input.diff.changedFiles,
    policySignals: {
      allowed_paths: input.input.policy.allowed_paths,
      forbidden_paths: input.input.policy.forbidden_paths,
      ownership: input.input.policy.ownership,
      paired_files: input.input.policy.paired_files,
      required_tests: input.input.policy.required_tests,
      required_test_mappings: input.input.policy.required_test_mappings,
      module_boundaries: input.input.policy.module_boundaries
    }
  };

  return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4));
}

function estimateContextSufficiencyRisk(input: {
  changedFileCount: number;
  budgetUtilization: number;
  missingAuthorityRuleCount: number;
  role: AgentRoleView;
}): ContextSufficiencyRisk {
  if (input.budgetUtilization > 1 || input.changedFileCount === 0) return "high";
  if (input.budgetUtilization > 0.85) return "medium";
  if (input.role !== "verifier" && input.missingAuthorityRuleCount > 0) return "medium";
  return "low";
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function appendWorkspaceEvent(workspace: SharedWorkspaceSnapshot, event: WorkspaceEvent): SharedWorkspaceSnapshot {
  const traceEvent: ProductTraceEvent = {
    id: event.id.replace("-event-", "-trace-"),
    actor: event.actor,
    action: event.action,
    summary: event.summary
  };

  return {
    ...workspace,
    events: [...workspace.events, event],
    trace: [...workspace.trace, traceEvent]
  };
}

function findScopeFindings(input: ReviewInput): Finding[] {
  const findings: Finding[] = [];

  for (const file of input.diff.changedFiles) {
    if (matchesAny(file, input.policy.forbidden_paths)) {
      findings.push(createFinding("scope", "error", `Forbidden path touched: ${file}`, [file], "reject"));
      continue;
    }

    if (input.policy.allowed_paths.length > 0 && !matchesAny(file, input.policy.allowed_paths)) {
      findings.push(createFinding("scope", "error", `File is outside allowed scope: ${file}`, [file], "reject"));
    }
  }

  return findings;
}

function findAuthorityFindings(input: ReviewInput): Finding[] {
  const authorityText = `${input.task.title}\n${input.task.description}\n${(input.task.authorityFacts ?? []).join("\n")}`.toLowerCase();

  return (input.policy.missing_authority_rules ?? [])
    .filter((rule) => !authorityText.includes(rule.toLowerCase()))
    .map((rule) => createFinding("authority", "error", `Missing authority for rule: ${rule}`, [], "refuse"));
}

function findOwnershipFindings(input: ReviewInput): Finding[] {
  const ownership = input.policy.ownership ?? {};
  const authorityText = `${input.task.description}\n${(input.task.authorityFacts ?? []).join("\n")}`.toLowerCase();
  const findings: Finding[] = [];

  for (const file of input.diff.changedFiles) {
    for (const [pattern, owner] of Object.entries(ownership)) {
      if (!matchesPattern(file, pattern)) continue;
      if (hasOwnerAuthority(authorityText, owner, input.policy.owner_aliases?.[owner] ?? [])) continue;
      findings.push(createFinding(
        "ownership",
        "error",
        `Missing ownership authority for ${owner} on ${file}`,
        [file],
        "refuse",
        { owner, pattern }
      ));
    }
  }

  return findings;
}

function findModuleBoundaryFindings(input: ReviewInput): Finding[] {
  const authorityText = `${input.task.description}\n${(input.task.authorityFacts ?? []).join("\n")}`.toLowerCase();
  const findings: Finding[] = [];

  for (const rule of input.policy.module_boundaries ?? []) {
    const sourceTouched = input.diff.changedFiles.some((file) => matchesPattern(file, rule.source));
    if (!sourceTouched) continue;

    const boundaryViolations = input.diff.changedFiles.filter((file) => {
      if (matchesPattern(file, rule.source)) return false;
      return !rule.allowedWith.some((allowedPattern) => matchesPattern(file, allowedPattern));
    });

    if (!boundaryViolations.length) continue;
    if (rule.authority && authorityText.includes(rule.authority.toLowerCase())) continue;

    findings.push(createFinding(
      "module_boundary",
      "error",
      rule.reason ?? `Module boundary crossed from ${rule.source} without explicit authority.`,
      boundaryViolations,
      "refuse",
      {
        source: rule.source,
        allowedWith: rule.allowedWith.join(", "),
        authority: rule.authority ?? ""
      }
    ));
  }

  return findings;
}

function findSensitiveBoundaryFindings(input: ReviewInput): Finding[] {
  const raw = input.diff.raw.toLowerCase();

  return (input.policy.sensitive_patterns ?? [])
    .filter((pattern) => raw.includes(pattern.toLowerCase()))
    .map((pattern) => createFinding("sensitive_boundary", "error", `Sensitive pattern appears in patch: ${pattern}`, [], "reject"));
}

function findPairedFileFindings(input: ReviewInput): Finding[] {
  return (input.policy.paired_files ?? [])
    .filter((rule) =>
      input.diff.changedFiles.includes(rule.source) &&
      ruleConditionMatches(input.diff, rule.changed_when_contains) &&
      !input.diff.changedFiles.includes(rule.requires)
    )
    .map((rule) => createFinding(
      "paired_file",
      "warning",
      rule.reason ?? `${rule.source} requires paired update in ${rule.requires}.`,
      [rule.source, rule.requires],
      "remask_required",
      {
        source: rule.source,
        requires: rule.requires,
        rule: "paired_file"
      }
    ));
}

function findTestFindings(input: ReviewInput): Finding[] {
  const raw = input.diff.raw.toLowerCase();
  const globalFindings = (input.policy.required_tests ?? [])
    .filter((test) => !raw.includes(test.toLowerCase()))
    .map((test) => createFinding("test", "warning", `Required test signal is missing: ${test}`, [], "human_review_required"));
  const mappingFindings = (input.policy.required_test_mappings ?? [])
    .filter((rule) => input.diff.changedFiles.some((file) => matchesPattern(file, rule.source)))
    .filter((rule) => ruleConditionMatches(input.diff, rule.changed_when_contains))
    .filter((rule) => !input.diff.changedFiles.some((file) => matchesPattern(file, rule.test)) && !raw.includes(rule.test.toLowerCase()))
    .map((rule) => createFinding(
      "test",
      "warning",
      rule.reason ?? `Required mapped test signal is missing for ${rule.source}: ${rule.test}`,
      [],
      "human_review_required",
      { source: rule.source, test: rule.test }
    ));

  return [...globalFindings, ...mappingFindings];
}

function ruleConditionMatches(diff: PatchDiff, changedWhenContains: string[] | undefined): boolean {
  if (!changedWhenContains?.length) return true;
  const changedText = diff.raw
    .split("\n")
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )
    .join("\n")
    .toLowerCase();
  return changedWhenContains.some((signal) => changedText.includes(signal.toLowerCase()));
}

function createRemaskRegions(findings: Finding[]): RemaskRegion[] {
  return findings
    .filter((finding) => finding.suggestedAction === "remask_required")
    .map((finding, index) => ({
      id: `remask-${index + 1}`,
      reason: finding.message,
      files: finding.files,
      instruction: "Repair only the missing paired/local region without broadening scope."
    }));
}

function createRepairProposals(findings: Finding[]): RepairProposal[] {
  return findings
    .filter((finding) => finding.suggestedAction === "remask_required")
    .map((finding, index) => ({
      id: `repair-${index + 1}`,
      kind: finding.category === "paired_file" ? "paired_file_update" : "manual_follow_up",
      files: finding.files,
      summary: finding.category === "paired_file"
        ? "Add the missing paired-file update while keeping the current scope."
        : "A human or remask agent should repair the verifier-marked local region.",
      instruction: "Generate a minimal patch that touches only the listed repair files and preserves the original task authority.",
      patchOutline: createPatchOutline(finding)
    }));
}

function decide(findings: Finding[], diff: PatchDiff): ReviewDecision {
  return createDecisionPriority(findings, diff)[0] ?? "approve";
}

function toRiskLevel(decision: ReviewDecision, findings: Finding[]): RiskLevel {
  if (decision === "reject" || decision === "refuse") return "high";
  if (decision === "remask_required" || decision === "human_review_required") return "medium";
  return findings.some((finding) => finding.severity === "warning") ? "medium" : "low";
}

function createDecisionPriority(findings: Finding[], diff: PatchDiff): ReviewDecision[] {
  const priority: ReviewDecision[] = [];
  if (findings.some((finding) => finding.suggestedAction === "reject")) priority.push("reject");
  if (findings.some((finding) => finding.suggestedAction === "refuse")) priority.push("refuse");
  if (findings.some((finding) => finding.suggestedAction === "remask_required")) priority.push("remask_required");
  if (!diff.changedFiles.length || findings.some((finding) => finding.suggestedAction === "human_review_required")) {
    priority.push("human_review_required");
  }
  priority.push("approve");
  return Array.from(new Set(priority));
}

function createMetrics(input: ReviewInput, findings: Finding[], workspace: SharedWorkspaceSnapshot): ReviewMetrics {
  const hasCategory = (category: Finding["category"]) => findings.some((finding) => finding.category === category);
  const traceCompleteness = workspace.trace.some((event) => event.actor === "workspace_builder") &&
    workspace.trace.some((event) => event.actor === "context_composer") &&
    Object.keys(workspace.roleViews).length === 5;

  return {
    scopeSafety: hasCategory("scope") ? 0 : 1,
    authoritySafety: hasCategory("authority") ? 0 : 1,
    ownershipSafety: hasCategory("ownership") ? 0 : 1,
    moduleBoundarySafety: hasCategory("module_boundary") ? 0 : 1,
    sensitiveBoundarySafety: hasCategory("sensitive_boundary") ? 0 : 1,
    pairedFileCompleteness: hasCategory("paired_file") ? 0 : 1,
    remaskNeed: findings.some((finding) => finding.suggestedAction === "remask_required") ? 1 : 0,
    traceCompleteness: traceCompleteness ? 1 : 0,
    changedFileCount: input.diff.changedFiles.length,
    findingCount: findings.length
  };
}

function normalizeVerifierAdapterFindings(output: VerifierAdapterOutput | undefined): Finding[] {
  if (!output) return [];

  return output.findings.map((finding) => createFinding(
    finding.category,
    finding.severity,
    finding.message,
    finding.files,
    finding.suggestedAction,
    {
      ...(finding.metadata ?? {}),
      adapterName: output.adapterName,
      adapterMode: output.mode,
      adapterConfidence: String(output.confidence)
    }
  ));
}

function createFinding(
  category: Finding["category"],
  severity: FindingSeverity,
  message: string,
  files: string[],
  suggestedAction: ReviewDecision,
  metadata?: Record<string, string>
): Finding {
  return {
    id: `${category}-${slugify(message).slice(0, 48)}`,
    severity,
    category,
    message,
    files,
    suggestedAction,
    metadata
  };
}

function createPatchOutline(finding: Finding): string[] {
  if (finding.category === "paired_file" && finding.metadata?.source && finding.metadata.requires) {
    return [
      `Inspect ${finding.metadata.source} for the intended metadata/version/config change.`,
      `Apply the equivalent minimal update to ${finding.metadata.requires}.`,
      "Do not touch files outside the repair proposal file list.",
      "Re-run the bounded review after repair."
    ];
  }

  return [
    "Inspect the verifier finding.",
    "Repair only the listed files.",
    "Do not broaden scope.",
    "Re-run the bounded review after repair."
  ];
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(file, pattern));
}

function hasOwnerAuthority(authorityText: string, owner: string, aliases: string[]): boolean {
  const candidates = [owner, ...aliases].map((value) => value.toLowerCase());
  const authorityLines = authorityText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("authority:"));

  return authorityLines.some((line) => candidates.some((candidate) =>
    line.startsWith(`authority: ${candidate}`) ||
    line.includes(`approved by ${candidate}`)
  ));
}

function matchesPattern(file: string, pattern: string): boolean {
  const doubleStarSlash = "__DOUBLE_STAR_SLASH__";
  const doubleStar = "__DOUBLE_STAR__";
  const escaped = pattern
    .replace(/\*\*\//g, doubleStarSlash)
    .replace(/\*\*/g, doubleStar)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replaceAll(doubleStarSlash, "(?:.*/)?")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`)
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function percentFlag(value: 0 | 1): string {
  return value ? "100%" : "0%";
}

function suggestNextAction(decision: ReviewDecision): string {
  if (decision === "approve") return "Proceed to normal review.";
  if (decision === "refuse") return "Stop and request the missing product, owner, platform, or compliance decision.";
  if (decision === "reject") return "Reject this patch before merge; unsafe scope or sensitive boundary was detected.";
  if (decision === "remask_required") return "Run a targeted repair only on the verifier-marked region.";
  return "Ask a human reviewer to provide the missing signal.";
}

function explainDecision(decision: ReviewDecision): string {
  if (decision === "approve") {
    return "The patch stayed inside the declared policy boundaries. This does not replace human review; it means the runtime found no configured scope, authority, sensitive, or paired-file blocker.";
  }
  if (decision === "refuse") {
    return "The runtime found missing authority. In the product philosophy, the agent should not guess product, platform, owner, or compliance decisions.";
  }
  if (decision === "reject") {
    return "The runtime found a forbidden scope or sensitive boundary risk. This is stronger than a repair case because the patch crossed a configured safety boundary.";
  }
  if (decision === "remask_required") {
    return "The patch appears locally repairable without broadening scope. The runtime recommends targeted remask instead of a full retry.";
  }
  return "The runtime could not collect enough signal for an automatic product decision. Human review should provide the missing context.";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "review";
}
