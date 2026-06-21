export type ReviewDecision =
  | "approve"
  | "refuse"
  | "reject"
  | "remask_required"
  | "human_review_required";

export type RiskLevel = "low" | "medium" | "high";
export type FindingSeverity = "info" | "warning" | "error";
export type AgentRoleView = "planner" | "coder" | "verifier" | "tester" | "remask";

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
};

export type RepoPolicy = {
  allowed_paths: string[];
  forbidden_paths: string[];
  ownership?: Record<string, string>;
  paired_files?: PairedFileRule[];
  sensitive_patterns?: string[];
  required_tests?: string[];
  missing_authority_rules?: string[];
};

export type SharedWorkspaceSnapshot = {
  id: string;
  task: TaskSpec;
  policy: RepoPolicy;
  diff: PatchDiff;
  roleViews: Record<AgentRoleView, BoundedRoleView>;
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
    | "sensitive_boundary"
    | "paired_file"
    | "test"
    | "trace";
  message: string;
  files: string[];
  suggestedAction: ReviewDecision;
};

export type RemaskRegion = {
  id: string;
  reason: string;
  files: string[];
  instruction: string;
};

export type ProductTraceEvent = {
  id: string;
  actor: "workspace_builder" | "context_composer" | "verifier" | "remask_planner" | "system";
  action: string;
  summary: string;
};

export type ReviewMetrics = {
  scopeSafety: 0 | 1;
  authoritySafety: 0 | 1;
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
};

export type ReviewOutput = {
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  metrics: ReviewMetrics;
  decisionPriority: ReviewDecision[];
  findings: Finding[];
  remaskRegions: RemaskRegion[];
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
    ...findSensitiveBoundaryFindings(input),
    ...findPairedFileFindings(input),
    ...findTestFindings(input)
  ];
  const remaskRegions = createRemaskRegions(findings);
  const decision = decide(findings, input.diff);
  const riskLevel = toRiskLevel(decision, findings);
  const metrics = createMetrics(input, findings, workspace);
  const decisionPriority = createDecisionPriority(findings, input.diff);
  const trace = [
    ...workspace.trace,
    {
      id: `${workspace.id}-trace-verifier`,
      actor: "verifier" as const,
      action: "review_completed",
      summary: `Verifier decision is ${decision}.`
    }
  ];
  const markdownReport = createMarkdownReport({
    decision,
    riskLevel,
    metrics,
    decisionPriority,
    findings,
    remaskRegions,
    trace,
    workspace
  });

  return {
    decision,
    riskLevel,
    metrics,
    decisionPriority,
    findings,
    remaskRegions,
    trace,
    workspace: { ...workspace, trace },
    markdownReport
  };
}

export function createSharedWorkspaceSnapshot(input: ReviewInput): SharedWorkspaceSnapshot {
  const id = `workspace-${slugify(input.task.id || input.task.title)}`;
  const roleViews = createRoleViews(input);

  return {
    id,
    task: input.task,
    policy: input.policy,
    diff: input.diff,
    roleViews,
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
    "## Findings",
    "",
    table(["ID", "Severity", "Category", "Message", "Files", "Action"], findingRows),
    "",
    "## Remask Regions",
    "",
    table(["ID", "Reason", "Files", "Instruction"], remaskRows),
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
      visibleFields: ["task", "diff", "policy", "authorityFacts"],
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

function findSensitiveBoundaryFindings(input: ReviewInput): Finding[] {
  const raw = input.diff.raw.toLowerCase();

  return (input.policy.sensitive_patterns ?? [])
    .filter((pattern) => raw.includes(pattern.toLowerCase()))
    .map((pattern) => createFinding("sensitive_boundary", "error", `Sensitive pattern appears in patch: ${pattern}`, [], "reject"));
}

function findPairedFileFindings(input: ReviewInput): Finding[] {
  return (input.policy.paired_files ?? [])
    .filter((rule) => input.diff.changedFiles.includes(rule.source) && !input.diff.changedFiles.includes(rule.requires))
    .map((rule) => createFinding(
      "paired_file",
      "warning",
      rule.reason ?? `${rule.source} requires paired update in ${rule.requires}.`,
      [rule.source, rule.requires],
      "remask_required"
    ));
}

function findTestFindings(input: ReviewInput): Finding[] {
  if (!input.policy.required_tests?.length) return [];
  const raw = input.diff.raw.toLowerCase();

  return input.policy.required_tests
    .filter((test) => !raw.includes(test.toLowerCase()))
    .map((test) => createFinding("test", "warning", `Required test signal is missing: ${test}`, [], "human_review_required"));
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
    sensitiveBoundarySafety: hasCategory("sensitive_boundary") ? 0 : 1,
    pairedFileCompleteness: hasCategory("paired_file") ? 0 : 1,
    remaskNeed: findings.some((finding) => finding.suggestedAction === "remask_required") ? 1 : 0,
    traceCompleteness: traceCompleteness ? 1 : 0,
    changedFileCount: input.diff.changedFiles.length,
    findingCount: findings.length
  };
}

function createFinding(
  category: Finding["category"],
  severity: FindingSeverity,
  message: string,
  files: string[],
  suggestedAction: ReviewDecision
): Finding {
  return {
    id: `${category}-${slugify(message).slice(0, 48)}`,
    severity,
    category,
    message,
    files,
    suggestedAction
  };
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(file, pattern));
}

function matchesPattern(file: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLE_STAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLE_STAR§/g, ".*");
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

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "review";
}
