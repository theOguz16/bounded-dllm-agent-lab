import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  evaluateConflictAwareMerge,
  type ConflictAwareMergeResult
} from "../../../packages/merge-core/src/index.js";
import {
  runMockOrchestrationFlow,
  type OrchestrationRunResult
} from "../../../packages/orchestration-core/src/index.js";
import {
  analyzeRepository,
  type RepoIntelligenceResult
} from "../../../packages/repo-intelligence/src/index.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts,
  type RepoIntelligenceWorkspaceSummary
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures,
  type BenchmarkFixture
} from "../../../packages/fixtures/src/index.js";
import type {
  WorkspaceRole
} from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/repo-orchestration-runtime";
const reportName = "repo-orchestrator-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

const defaultChangedFiles = [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const changedFiles =
  parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? defaultChangedFiles;

const roles: WorkspaceRole[] = [
  "planner",
  "coder",
  "verifier",
  "tester",
  "remask",
  "merge"
];

type RoleViewSummary = {
  role: WorkspaceRole;
  sufficiency: string;
  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  includedRegionCount: number;
  excludedRegionCount: number;
  includedRegions: string[];
  excludedRegions: string[];
  includedFactCount: number;
  excludedFactCount: number;
  staleExclusionCount: number;
  sensitiveExclusionCount: number;
  warningCount: number;
  hasRepoFactsContext: boolean;
};

type OrchestrationStepSummary = {
  id: string;
  role: WorkspaceRole;
  status: string;
  decision?: string;
  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  sufficiency: string;
  mutationCount: number;
  mutatedRegions: string[];
};

type OrchestrationSummary = {
  flowId: string;
  decision: string;
  remaskTriggered: boolean;
  stepCount: number;
  tokenSummary: OrchestrationRunResult["tokenSummary"];
  mutationSummary: OrchestrationRunResult["mutationSummary"];
  steps: OrchestrationStepSummary[];
};

type MergeSummary = {
  decision: string;
  mergeSafe: boolean;
  conflictCount: number;
  conflicts: Array<{
    kind: string;
    severity: string;
    suggestedDecision: string;
    sourceStepIds: string[];
    evidenceIds: string[];
    message: string;
  }>;
  requiredActions: string[];
  evidence: ConflictAwareMergeResult["evidence"];
};

type RepoOrchestratorCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  changedFiles: string[];
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  roleViews: RoleViewSummary[];
  orchestration: OrchestrationSummary;
  merge: MergeSummary;
};

type RepoOrchestratorAggregate = {
  caseCount: number;
  roleCount: number;
  changedFiles: string[];

  repoScannedFileCount: number;
  repoSkippedFileCount: number;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;

  totalRoleViews: number;
  repoFactsRoleViewCount: number;
  sufficiencyCounts: Record<string, number>;

  orchestrationDecisionCounts: Record<string, number>;
  mergeDecisionCounts: Record<string, number>;

  remaskTriggeredCount: number;
  mergeSafeCount: number;
  mergeUnsafeCount: number;

  totalConflicts: number;
  conflictCountsByKind: Record<string, number>;

  totalEstimatedTokens: number;
  averageBudgetUtilization: number;
  maxEstimatedTokens: number;

  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  mutatedRegions: string[];
};

type RepoOrchestratorReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  roles: WorkspaceRole[];
  changedFiles: string[];
  repo: {
    rootDir: string;
    scannedFileCount: number;
    skippedFileCount: number;
    diagnostics: string[];
  };
  aggregate: RepoOrchestratorAggregate;
  cases: RepoOrchestratorCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before repo orchestrator report.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

await runReport();

async function runReport(): Promise<void> {
  await mkdir(reportDir, {
    recursive: true
  });

  const repoResult = await analyzeRepository({
    rootDir: process.cwd(),
    changedFiles,
    maxFiles: 1000
  });

  const cases = remaskFixtures.map((fixture) => createCaseReport(fixture, repoResult));
  const report = createReport(repoResult, cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-repo-orchestrator-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-repo-orchestrator-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        caseCount: report.aggregate.caseCount,
        roleCount: report.aggregate.roleCount,
        changedFiles,
        jsonPath,
        markdownPath,
        aggregate: report.aggregate
      },
      null,
      2
    )
  );
}

function createCaseReport(
  fixture: BenchmarkFixture,
  repoResult: RepoIntelligenceResult
): RepoOrchestratorCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
    id: `repo-orchestrator-report-${fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
  const roleViews = composeRoleViews(workspace, roles);
  const orchestrationResult = runMockOrchestrationFlow(workspace);
  const mergeResult = evaluateConflictAwareMerge(orchestrationResult);

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,
    changedFiles,
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    roleViews: roleViews.map(summarizeRoleView),
    orchestration: summarizeOrchestration(orchestrationResult),
    merge: summarizeMerge(mergeResult)
  };
}

function summarizeRoleView(view: ComposedRoleView): RoleViewSummary {
  return {
    role: view.role,
    sufficiency: view.sufficiency,
    estimatedTokens: view.estimatedTokens,
    budgetTokens: view.budgetTokens,
    budgetUtilization: view.budgetUtilization,
    includedRegionCount: view.includedRegions.length,
    excludedRegionCount: view.excludedRegions.length,
    includedRegions: view.includedRegions,
    excludedRegions: view.excludedRegions,
    includedFactCount: view.includedFacts.length,
    excludedFactCount: view.excludedFacts.length,
    staleExclusionCount: view.staleExclusions.length,
    sensitiveExclusionCount: view.sensitiveExclusions.length,
    warningCount: view.warnings.length,
    hasRepoFactsContext: Boolean((view.context as Record<string, unknown>).repoFacts)
  };
}

function summarizeOrchestration(result: OrchestrationRunResult): OrchestrationSummary {
  return {
    flowId: result.flowId,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    tokenSummary: result.tokenSummary,
    mutationSummary: result.mutationSummary,
    steps: result.steps.map((step) => ({
      id: step.id,
      role: step.role,
      status: step.status,
      decision: step.decision,
      estimatedTokens: step.estimatedTokens,
      budgetTokens: step.budgetTokens,
      budgetUtilization: step.budgetUtilization,
      sufficiency: step.sufficiency,
      mutationCount: step.mutations.length,
      mutatedRegions: step.mutations.map((mutation) => mutation.region)
    }))
  };
}

function summarizeMerge(result: ConflictAwareMergeResult): MergeSummary {
  return {
    decision: result.decision,
    mergeSafe: result.mergeSafe,
    conflictCount: result.conflicts.length,
    conflicts: result.conflicts.map((conflict) => ({
      kind: conflict.kind,
      severity: conflict.severity,
      suggestedDecision: conflict.suggestedDecision,
      sourceStepIds: conflict.sourceStepIds,
      evidenceIds: conflict.evidenceIds,
      message: conflict.message
    })),
    requiredActions: result.requiredActions,
    evidence: result.evidence
  };
}

function createReport(
  repoResult: RepoIntelligenceResult,
  cases: RepoOrchestratorCaseReport[]
): RepoOrchestratorReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "changed-files-repo-orchestrator-remask-fixtures-v1",
    roles,
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    aggregate: aggregateCases(repoResult, cases),
    cases
  };
}

function aggregateCases(
  repoResult: RepoIntelligenceResult,
  cases: RepoOrchestratorCaseReport[]
): RepoOrchestratorAggregate {
  const allRoleViews = cases.flatMap((item) => item.roleViews);
  const allConflicts = cases.flatMap((item) => item.merge.conflicts);
  const allMutatedRegions = cases.flatMap((item) => item.orchestration.mutationSummary.mutatedRegions);

  const totalEstimatedTokens = cases.reduce(
    (sum, item) => sum + item.orchestration.tokenSummary.totalEstimatedTokens,
    0
  );

  const totalBudgetUtilization = cases.reduce(
    (sum, item) => sum + item.orchestration.tokenSummary.averageBudgetUtilization,
    0
  );

  const firstWorkspaceRepoFacts = cases[0]?.workspaceRepoFacts ?? emptyRepoSummary();

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    changedFiles,

    repoScannedFileCount: repoResult.scannedFileCount,
    repoSkippedFileCount: repoResult.skippedFileCount,
    workspaceRepoFacts: firstWorkspaceRepoFacts,

    totalRoleViews: allRoleViews.length,
    repoFactsRoleViewCount: allRoleViews.filter((view) => view.hasRepoFactsContext).length,
    sufficiencyCounts: countBy(allRoleViews.map((view) => view.sufficiency)),

    orchestrationDecisionCounts: countBy(cases.map((item) => item.orchestration.decision)),
    mergeDecisionCounts: countBy(cases.map((item) => item.merge.decision)),

    remaskTriggeredCount: cases.filter((item) => item.orchestration.remaskTriggered).length,
    mergeSafeCount: cases.filter((item) => item.merge.mergeSafe).length,
    mergeUnsafeCount: cases.filter((item) => !item.merge.mergeSafe).length,

    totalConflicts: allConflicts.length,
    conflictCountsByKind: countBy(allConflicts.map((conflict) => conflict.kind)),

    totalEstimatedTokens,
    averageBudgetUtilization: roundRatio(
      totalBudgetUtilization / Math.max(cases.length, 1)
    ),
    maxEstimatedTokens: Math.max(
      0,
      ...cases.map((item) => item.orchestration.tokenSummary.maxEstimatedTokens)
    ),

    totalMutations: cases.reduce(
      (sum, item) => sum + item.orchestration.mutationSummary.totalMutations,
      0
    ),
    appliedMutations: cases.reduce(
      (sum, item) => sum + item.orchestration.mutationSummary.appliedMutations,
      0
    ),
    blockedMutations: cases.reduce(
      (sum, item) => sum + item.orchestration.mutationSummary.blockedMutations,
      0
    ),
    mutatedRegions: [...new Set(allMutatedRegions)]
  };
}

function reportToMarkdown(report: RepoOrchestratorReport): string {
  const lines: string[] = [];

  lines.push(`# Repo Orchestrator Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Roles: \`${report.roles.join(", ")}\``);
  lines.push("");

  lines.push(`## Changed Files`);
  lines.push("");

  for (const file of report.changedFiles) {
    lines.push(`- \`${file}\``);
  }

  lines.push("");

  lines.push(`## Repo Scan`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Scanned files | ${report.repo.scannedFileCount} |`);
  lines.push(`| Skipped files | ${report.repo.skippedFileCount} |`);
  lines.push("");

  lines.push(`## Workspace Repo Facts`);
  lines.push("");
  lines.push(`| Fact Bucket | Count |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Changed files | ${report.aggregate.workspaceRepoFacts.changedFileCount} |`);
  lines.push(`| Ownership entries | ${report.aggregate.workspaceRepoFacts.ownershipCount} |`);
  lines.push(`| Paired files | ${report.aggregate.workspaceRepoFacts.pairedFileCount} |`);
  lines.push(`| Required tests | ${report.aggregate.workspaceRepoFacts.requiredTestCount} |`);
  lines.push(`| Required test mappings | ${report.aggregate.workspaceRepoFacts.requiredTestMappingCount} |`);
  lines.push(`| Module boundaries | ${report.aggregate.workspaceRepoFacts.moduleBoundaryCount} |`);
  lines.push(`| Sensitive patterns | ${report.aggregate.workspaceRepoFacts.sensitivePatternCount} |`);
  lines.push(`| Stale facts | ${report.aggregate.workspaceRepoFacts.staleFactCount} |`);
  lines.push("");

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Total role views | ${report.aggregate.totalRoleViews} |`);
  lines.push(`| Role views with repoFacts | ${report.aggregate.repoFactsRoleViewCount} |`);
  lines.push(`| Remask triggered | ${report.aggregate.remaskTriggeredCount} |`);
  lines.push(`| Merge safe | ${report.aggregate.mergeSafeCount} |`);
  lines.push(`| Merge unsafe | ${report.aggregate.mergeUnsafeCount} |`);
  lines.push(`| Total conflicts | ${report.aggregate.totalConflicts} |`);
  lines.push(`| Total estimated tokens | ${report.aggregate.totalEstimatedTokens} |`);
  lines.push(`| Max estimated tokens | ${report.aggregate.maxEstimatedTokens} |`);
  lines.push(`| Avg budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
  lines.push(`| Total mutations | ${report.aggregate.totalMutations} |`);
  lines.push(`| Applied mutations | ${report.aggregate.appliedMutations} |`);
  lines.push(`| Blocked mutations | ${report.aggregate.blockedMutations} |`);
  lines.push("");

  lines.push(`### Orchestration Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.orchestrationDecisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Merge Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.mergeDecisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Conflict Counts`);
  lines.push("");
  lines.push(`| Conflict Kind | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [kind, count] of Object.entries(report.aggregate.conflictCountsByKind)) {
    lines.push(`| ${escapeMarkdownCell(kind)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(
    `| Case | Orchestration Decision | Merge Decision | Remask | Merge Safe | Conflicts | Tokens | Blocked Mutations |`
  );
  lines.push(`| --- | --- | --- | --- | --- | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.orchestration.decision} | ${item.merge.decision} | ${item.orchestration.remaskTriggered} | ${item.merge.mergeSafe} | ${item.merge.conflictCount} | ${item.orchestration.tokenSummary.totalEstimatedTokens} | ${item.orchestration.mutationSummary.blockedMutations} |`
    );
  }

  lines.push("");

  for (const item of report.cases) {
    lines.push(`## Case Detail: \`${item.caseId}\``);
    lines.push("");
    lines.push(`- Family: \`${item.family}\``);
    lines.push(`- Workspace: \`${item.workspaceId}\``);
    lines.push(`- Task: ${escapeMarkdownText(item.task)}`);
    lines.push(`- Expected result: ${escapeMarkdownText(item.expectedResult)}`);
    lines.push("");

    lines.push(`### Orchestration Steps`);
    lines.push("");
    lines.push(`| Step | Role | Status | Decision | Tokens | Budget | Utilization | Mutations |`);
    lines.push(`| --- | --- | --- | --- | ---: | ---: | ---: | ---: |`);

    for (const step of item.orchestration.steps) {
      lines.push(
        `| ${step.id} | ${step.role} | ${step.status} | ${step.decision ?? ""} | ${step.estimatedTokens} | ${step.budgetTokens} | ${step.budgetUtilization} | ${step.mutationCount} |`
      );
    }

    lines.push("");

    lines.push(`### Merge Conflicts`);
    lines.push("");

    if (item.merge.conflicts.length === 0) {
      lines.push(`No conflicts.`);
      lines.push("");
    } else {
      lines.push(`| Kind | Severity | Suggested Decision | Source Steps | Evidence IDs | Message |`);
      lines.push(`| --- | --- | --- | --- | --- | --- |`);

      for (const conflict of item.merge.conflicts) {
        lines.push(
          `| ${conflict.kind} | ${conflict.severity} | ${conflict.suggestedDecision} | ${escapeMarkdownCell(conflict.sourceStepIds.join(", "))} | ${escapeMarkdownCell(conflict.evidenceIds.join(", "))} | ${escapeMarkdownCell(conflict.message)} |`
        );
      }

      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function emptyRepoSummary(): RepoIntelligenceWorkspaceSummary {
  return {
    changedFileCount: 0,
    ownershipCount: 0,
    pairedFileCount: 0,
    requiredTestCount: 0,
    requiredTestMappingCount: 0,
    moduleBoundaryCount: 0,
    sensitivePatternCount: 0,
    staleFactCount: 0
  };
}

function parseChangedFilesFromEnv(value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }

  const files = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.replace(/\\/g, "/"))
    .map((item) => item.replace(/^\.\//, ""));

  if (files.length === 0) {
    return null;
  }

  return [...new Set(files)].sort();
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}