export type ReviewDecision =
  | "approve"
  | "refuse"
  | "reject"
  | "remask_required"
  | "human_review_required";

export type RiskLevel = "low" | "medium" | "high";
export type FindingSeverity = "info" | "warning" | "error";
export type AgentRoleView = "planner" | "coder" | "verifier" | "tester" | "remask";
export type WorkspaceActor = AgentRoleView | "workspace_builder" | "context_composer" | "verifier_adapter" | "merge" | "system";

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
};

export type WorkspaceConflictRecord = {
  id: string;
  kind: "claim_conflict" | "authority_conflict" | "scope_conflict" | "patch_conflict";
  summary: string;
  claimIds: string[];
  severity: RiskLevel;
};

export type WorkspaceEvent = {
  id: string;
  actor: WorkspaceActor;
  action:
    | "workspace_created"
    | "role_views_created"
    | "claim_added"
    | "conflict_recorded"
    | "verifier_result_recorded"
    | "remask_request_recorded"
    | "merge_decision_recorded";
  summary: string;
  target?: AgentClaim["target"] | "workspace";
  relatedIds: string[];
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

export function createSharedWorkspaceSnapshot(input: ReviewInput): SharedWorkspaceSnapshot {
  const id = `workspace-${slugify(input.task.id || input.task.title)}`;
  const roleViews = createRoleViews(input);
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
    sensitivePatterns: input.policy.sensitive_patterns ?? []
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
    view.visibleFields.join(", "),
    view.writableFields.join(", ")
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
    table(["Role", "Token Budget", "Visible Fields", "Writable Fields"], roleRows),
    "",
    "## Trace",
    "",
    output.trace.map((event) => `- ${event.actor}: ${event.action} - ${event.summary}`).join("\n")
  ].join("\n");
}

function createRoleViews(input: ReviewInput): Record<AgentRoleView, BoundedRoleView> {
  const changedFileSummary = input.diff.changedFiles.length
    ? `Changed files: ${input.diff.changedFiles.join(", ")}`
    : "No changed files were detected.";

  return {
    planner: {
      role: "planner",
      visibleFields: ["task", "policy.allowed_paths", "policy.forbidden_paths"],
      writableFields: ["plan", "risk_notes"],
      tokenBudget: 1_500,
      summary: `Plan the bounded task: ${input.task.title}`
    },
    coder: {
      role: "coder",
      visibleFields: ["task", "allowed_paths", "relevant_diff"],
      writableFields: ["patch_plan"],
      tokenBudget: 4_000,
      summary: `Implement only inside allowed scope. ${changedFileSummary}`
    },
    verifier: {
      role: "verifier",
      visibleFields: ["task", "diff", "policy", "authorityFacts", "module_boundaries"],
      writableFields: ["verifier_decision", "findings"],
      tokenBudget: 2_500,
      summary: "Check scope, authority, sensitive boundaries and paired-file consistency."
    },
    tester: {
      role: "tester",
      visibleFields: ["changed_files", "required_tests"],
      writableFields: ["test_signal"],
      tokenBudget: 1_200,
      summary: "Verify whether required tests are represented for the changed scope."
    },
    remask: {
      role: "remask",
      visibleFields: ["verifier_failure", "failed_region", "repair_files"],
      writableFields: ["repair_patch"],
      tokenBudget: 1_500,
      summary: "Repair only verifier-marked safe local failed regions."
    }
  };
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
