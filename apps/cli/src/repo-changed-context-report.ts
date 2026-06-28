import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
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

const reportDir = "reports/repo-context-runtime";
const reportName = "repo-changed-context-report-v1";
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

type ContextMode = "full_repo" | "changed_files_scoped";

type RoleContextSummary = {
  role: WorkspaceRole;
  sufficiency: string;
  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  warningCount: number;
  hasRepoFactsContext: boolean;
  rawRepoFactsEstimatedTokens: number;
  compactRepoFactsEstimatedTokens: number;
  repoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type ContextModeCaseReport = {
  mode: ContextMode;
  workspaceId: string;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  rawRepoFactsEstimatedTokens: number;
  roleViews: RoleContextSummary[];
  roleViewCount: number;
  repoFactsRoleViewCount: number;
  sufficientRoleViewCount: number;
  riskyRoleViewCount: number;
  insufficientRoleViewCount: number;
  totalRoleViewEstimatedTokens: number;
  averageRoleViewEstimatedTokens: number;
  maxRoleViewEstimatedTokens: number;
  averageBudgetUtilization: number;
  totalRawRepoFactsTokensForIncludedViews: number;
  totalCompactRepoFactsTokensForIncludedViews: number;
  totalRepoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type ChangedContextCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  fullRepo: ContextModeCaseReport;
  changedFilesScoped: ContextModeCaseReport;
  delta: {
    changedFileReduction: number;
    ownershipReduction: number;
    moduleBoundaryReduction: number;
    sensitivePatternReduction: number;
    staleFactReduction: number;
    rawRepoFactsTokenReduction: number;
    roleViewTokenReduction: number;
    roleViewTokenReductionRate: number;
    averageRoleViewTokenReduction: number;
    averageBudgetUtilizationReduction: number;
  };
};

type ContextModeAggregate = {
  mode: ContextMode;
  caseCount: number;
  roleCount: number;
  totalRoleViews: number;
  repoFactsRoleViewCount: number;
  sufficiencyCounts: Record<string, number>;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  totalRoleViewEstimatedTokens: number;
  averageRoleViewEstimatedTokens: number;
  maxRoleViewEstimatedTokens: number;
  averageBudgetUtilization: number;
  totalRawRepoFactsTokensForIncludedViews: number;
  totalCompactRepoFactsTokensForIncludedViews: number;
  totalRepoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type ChangedContextAggregate = {
  caseCount: number;
  roleCount: number;
  changedFiles: string[];
  fullRepoScannedFileCount: number;
  changedScopedScannedFileCount: number;
  fullRepoSkippedFileCount: number;
  changedScopedSkippedFileCount: number;
  fullRepo: ContextModeAggregate;
  changedFilesScoped: ContextModeAggregate;
  delta: {
    changedFileReduction: number;
    ownershipReduction: number;
    moduleBoundaryReduction: number;
    sensitivePatternReduction: number;
    staleFactReduction: number;
    rawRepoFactsTokenReduction: number;
    roleViewTokenReduction: number;
    roleViewTokenReductionRate: number;
    averageRoleViewTokenReduction: number;
    averageBudgetUtilizationReduction: number;
  };
};

type ChangedContextReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  roles: WorkspaceRole[];
  changedFiles: string[];
  repo: {
    rootDir: string;
    fullRepoScannedFileCount: number;
    changedScopedScannedFileCount: number;
    fullRepoDiagnostics: string[];
    changedScopedDiagnostics: string[];
  };
  aggregate: ChangedContextAggregate;
  cases: ChangedContextCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before repo changed context report.",
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

  const fullRepoResult = await analyzeRepository({
    rootDir: process.cwd(),
    maxFiles: 1000
  });

  const changedScopedRepoResult = await analyzeRepository({
    rootDir: process.cwd(),
    changedFiles,
    maxFiles: 1000
  });

  const cases = remaskFixtures.map((fixture) =>
    createCaseReport(fixture, fullRepoResult, changedScopedRepoResult)
  );

  const report = createReport(fullRepoResult, changedScopedRepoResult, cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-changed-context-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-changed-context-report.md`);

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
  fullRepoResult: RepoIntelligenceResult,
  changedScopedRepoResult: RepoIntelligenceResult
): ChangedContextCaseReport {
  const fullRepo = createModeCaseReport(fixture, fullRepoResult, "full_repo");
  const changedFilesScoped = createModeCaseReport(
    fixture,
    changedScopedRepoResult,
    "changed_files_scoped"
  );

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    fullRepo,
    changedFilesScoped,
    delta: createCaseDelta(fullRepo, changedFilesScoped)
  };
}

function createModeCaseReport(
  fixture: BenchmarkFixture,
  repoResult: RepoIntelligenceResult,
  mode: ContextMode
): ContextModeCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
    id: `repo-${mode}-context-report-${fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
  const workspaceRepoFacts = summarizeWorkspaceRepoFacts(workspace.repoFacts);
  const rawRepoFactsEstimatedTokens = estimateJsonTokens(workspace.repoFacts);

  const views = composeRoleViews(workspace, roles);
  const roleViews = views.map((view) =>
    summarizeRoleView(view, rawRepoFactsEstimatedTokens)
  );

  const sufficiencyCounts = countBy(roleViews.map((view) => view.sufficiency));

  const totalRoleViewEstimatedTokens = roleViews.reduce(
    (sum, view) => sum + view.estimatedTokens,
    0
  );

  const repoFactsRoleViews = roleViews.filter((view) => view.hasRepoFactsContext);

  const totalRawRepoFactsTokensForIncludedViews = repoFactsRoleViews.reduce(
    (sum, view) => sum + view.rawRepoFactsEstimatedTokens,
    0
  );

  const totalCompactRepoFactsTokensForIncludedViews = repoFactsRoleViews.reduce(
    (sum, view) => sum + view.compactRepoFactsEstimatedTokens,
    0
  );

  const totalRepoFactsTokenSavings =
    totalRawRepoFactsTokensForIncludedViews -
    totalCompactRepoFactsTokensForIncludedViews;

  return {
    mode,
    workspaceId: workspace.id,
    workspaceRepoFacts,
    rawRepoFactsEstimatedTokens,
    roleViews,
    roleViewCount: roleViews.length,
    repoFactsRoleViewCount: repoFactsRoleViews.length,
    sufficientRoleViewCount: sufficiencyCounts.sufficient ?? 0,
    riskyRoleViewCount: sufficiencyCounts.risky ?? 0,
    insufficientRoleViewCount: sufficiencyCounts.insufficient ?? 0,
    totalRoleViewEstimatedTokens,
    averageRoleViewEstimatedTokens: roundRatio(
      totalRoleViewEstimatedTokens / Math.max(roleViews.length, 1)
    ),
    maxRoleViewEstimatedTokens: Math.max(
      0,
      ...roleViews.map((view) => view.estimatedTokens)
    ),
    averageBudgetUtilization: roundRatio(
      roleViews.reduce((sum, view) => sum + view.budgetUtilization, 0) /
        Math.max(roleViews.length, 1)
    ),
    totalRawRepoFactsTokensForIncludedViews,
    totalCompactRepoFactsTokensForIncludedViews,
    totalRepoFactsTokenSavings,
    repoFactsTokenSavingsRate: roundRatio(
      totalRepoFactsTokenSavings /
        Math.max(totalRawRepoFactsTokensForIncludedViews, 1)
    )
  };
}

function summarizeRoleView(
  view: ComposedRoleView,
  rawRepoFactsEstimatedTokens: number
): RoleContextSummary {
  const repoFactsContext = getRepoFactsContext(view);
  const compactRepoFactsEstimatedTokens = repoFactsContext
    ? estimateJsonTokens(repoFactsContext)
    : 0;

  const rawRepoFactsTokensForRole = repoFactsContext
    ? rawRepoFactsEstimatedTokens
    : 0;

  const repoFactsTokenSavings =
    rawRepoFactsTokensForRole - compactRepoFactsEstimatedTokens;

  return {
    role: view.role,
    sufficiency: view.sufficiency,
    estimatedTokens: view.estimatedTokens,
    budgetTokens: view.budgetTokens,
    budgetUtilization: view.budgetUtilization,
    warningCount: view.warnings.length,
    hasRepoFactsContext: Boolean(repoFactsContext),
    rawRepoFactsEstimatedTokens: rawRepoFactsTokensForRole,
    compactRepoFactsEstimatedTokens,
    repoFactsTokenSavings,
    repoFactsTokenSavingsRate: roundRatio(
      repoFactsTokenSavings / Math.max(rawRepoFactsTokensForRole, 1)
    )
  };
}

function createReport(
  fullRepoResult: RepoIntelligenceResult,
  changedScopedRepoResult: RepoIntelligenceResult,
  cases: ChangedContextCaseReport[]
): ChangedContextReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "full-repo-vs-changed-files-context-composer-v1",
    roles,
    changedFiles,
    repo: {
      rootDir: fullRepoResult.rootDir,
      fullRepoScannedFileCount: fullRepoResult.scannedFileCount,
      changedScopedScannedFileCount: changedScopedRepoResult.scannedFileCount,
      fullRepoDiagnostics: fullRepoResult.diagnostics.slice(0, 10),
      changedScopedDiagnostics: changedScopedRepoResult.diagnostics.slice(0, 10)
    },
    aggregate: aggregateCases(fullRepoResult, changedScopedRepoResult, cases),
    cases
  };
}

function aggregateCases(
  fullRepoResult: RepoIntelligenceResult,
  changedScopedRepoResult: RepoIntelligenceResult,
  cases: ChangedContextCaseReport[]
): ChangedContextAggregate {
  const fullRepoAggregate = aggregateMode(
    "full_repo",
    cases.map((item) => item.fullRepo)
  );

  const changedScopedAggregate = aggregateMode(
    "changed_files_scoped",
    cases.map((item) => item.changedFilesScoped)
  );

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    changedFiles,
    fullRepoScannedFileCount: fullRepoResult.scannedFileCount,
    changedScopedScannedFileCount: changedScopedRepoResult.scannedFileCount,
    fullRepoSkippedFileCount: fullRepoResult.skippedFileCount,
    changedScopedSkippedFileCount: changedScopedRepoResult.skippedFileCount,
    fullRepo: fullRepoAggregate,
    changedFilesScoped: changedScopedAggregate,
    delta: createAggregateDelta(fullRepoAggregate, changedScopedAggregate)
  };
}

function aggregateMode(
  mode: ContextMode,
  cases: ContextModeCaseReport[]
): ContextModeAggregate {
  const allRoleViews = cases.flatMap((item) => item.roleViews);
  const firstWorkspaceRepoFacts = cases[0]?.workspaceRepoFacts ?? emptyRepoSummary();
  const sufficiencyCounts = countBy(allRoleViews.map((view) => view.sufficiency));

  const totalRoleViewEstimatedTokens = allRoleViews.reduce(
    (sum, view) => sum + view.estimatedTokens,
    0
  );

  const totalRawRepoFactsTokensForIncludedViews = cases.reduce(
    (sum, item) => sum + item.totalRawRepoFactsTokensForIncludedViews,
    0
  );

  const totalCompactRepoFactsTokensForIncludedViews = cases.reduce(
    (sum, item) => sum + item.totalCompactRepoFactsTokensForIncludedViews,
    0
  );

  const totalRepoFactsTokenSavings =
    totalRawRepoFactsTokensForIncludedViews -
    totalCompactRepoFactsTokensForIncludedViews;

  return {
    mode,
    caseCount: cases.length,
    roleCount: roles.length,
    totalRoleViews: allRoleViews.length,
    repoFactsRoleViewCount: allRoleViews.filter((view) => view.hasRepoFactsContext).length,
    sufficiencyCounts,
    workspaceRepoFacts: firstWorkspaceRepoFacts,
    totalRoleViewEstimatedTokens,
    averageRoleViewEstimatedTokens: roundRatio(
      totalRoleViewEstimatedTokens / Math.max(allRoleViews.length, 1)
    ),
    maxRoleViewEstimatedTokens: Math.max(
      0,
      ...allRoleViews.map((view) => view.estimatedTokens)
    ),
    averageBudgetUtilization: roundRatio(
      allRoleViews.reduce((sum, view) => sum + view.budgetUtilization, 0) /
        Math.max(allRoleViews.length, 1)
    ),
    totalRawRepoFactsTokensForIncludedViews,
    totalCompactRepoFactsTokensForIncludedViews,
    totalRepoFactsTokenSavings,
    repoFactsTokenSavingsRate: roundRatio(
      totalRepoFactsTokenSavings /
        Math.max(totalRawRepoFactsTokensForIncludedViews, 1)
    )
  };
}

function createCaseDelta(
  fullRepo: ContextModeCaseReport,
  changedFilesScoped: ContextModeCaseReport
): ChangedContextCaseReport["delta"] {
  const roleViewTokenReduction =
    fullRepo.totalRoleViewEstimatedTokens -
    changedFilesScoped.totalRoleViewEstimatedTokens;

  return {
    changedFileReduction:
      fullRepo.workspaceRepoFacts.changedFileCount -
      changedFilesScoped.workspaceRepoFacts.changedFileCount,
    ownershipReduction:
      fullRepo.workspaceRepoFacts.ownershipCount -
      changedFilesScoped.workspaceRepoFacts.ownershipCount,
    moduleBoundaryReduction:
      fullRepo.workspaceRepoFacts.moduleBoundaryCount -
      changedFilesScoped.workspaceRepoFacts.moduleBoundaryCount,
    sensitivePatternReduction:
      fullRepo.workspaceRepoFacts.sensitivePatternCount -
      changedFilesScoped.workspaceRepoFacts.sensitivePatternCount,
    staleFactReduction:
      fullRepo.workspaceRepoFacts.staleFactCount -
      changedFilesScoped.workspaceRepoFacts.staleFactCount,
    rawRepoFactsTokenReduction:
      fullRepo.rawRepoFactsEstimatedTokens -
      changedFilesScoped.rawRepoFactsEstimatedTokens,
    roleViewTokenReduction,
    roleViewTokenReductionRate: roundRatio(
      roleViewTokenReduction / Math.max(fullRepo.totalRoleViewEstimatedTokens, 1)
    ),
    averageRoleViewTokenReduction:
      fullRepo.averageRoleViewEstimatedTokens -
      changedFilesScoped.averageRoleViewEstimatedTokens,
    averageBudgetUtilizationReduction: roundRatio(
      fullRepo.averageBudgetUtilization -
        changedFilesScoped.averageBudgetUtilization
    )
  };
}

function createAggregateDelta(
  fullRepo: ContextModeAggregate,
  changedFilesScoped: ContextModeAggregate
): ChangedContextAggregate["delta"] {
  const roleViewTokenReduction =
    fullRepo.totalRoleViewEstimatedTokens -
    changedFilesScoped.totalRoleViewEstimatedTokens;

  return {
    changedFileReduction:
      fullRepo.workspaceRepoFacts.changedFileCount -
      changedFilesScoped.workspaceRepoFacts.changedFileCount,
    ownershipReduction:
      fullRepo.workspaceRepoFacts.ownershipCount -
      changedFilesScoped.workspaceRepoFacts.ownershipCount,
    moduleBoundaryReduction:
      fullRepo.workspaceRepoFacts.moduleBoundaryCount -
      changedFilesScoped.workspaceRepoFacts.moduleBoundaryCount,
    sensitivePatternReduction:
      fullRepo.workspaceRepoFacts.sensitivePatternCount -
      changedFilesScoped.workspaceRepoFacts.sensitivePatternCount,
    staleFactReduction:
      fullRepo.workspaceRepoFacts.staleFactCount -
      changedFilesScoped.workspaceRepoFacts.staleFactCount,
    rawRepoFactsTokenReduction:
      fullRepo.totalRawRepoFactsTokensForIncludedViews -
      changedFilesScoped.totalRawRepoFactsTokensForIncludedViews,
    roleViewTokenReduction,
    roleViewTokenReductionRate: roundRatio(
      roleViewTokenReduction / Math.max(fullRepo.totalRoleViewEstimatedTokens, 1)
    ),
    averageRoleViewTokenReduction:
      fullRepo.averageRoleViewEstimatedTokens -
      changedFilesScoped.averageRoleViewEstimatedTokens,
    averageBudgetUtilizationReduction: roundRatio(
      fullRepo.averageBudgetUtilization -
        changedFilesScoped.averageBudgetUtilization
    )
  };
}

function reportToMarkdown(report: ChangedContextReport): string {
  const lines: string[] = [];

  lines.push(`# Changed Files Context Report`);
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

  lines.push(`## Aggregate Comparison`);
  lines.push("");
  lines.push(`| Metric | Full Repo | Changed Files Scoped | Reduction |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  lines.push(
    `| Changed files | ${report.aggregate.fullRepo.workspaceRepoFacts.changedFileCount} | ${report.aggregate.changedFilesScoped.workspaceRepoFacts.changedFileCount} | ${report.aggregate.delta.changedFileReduction} |`
  );
  lines.push(
    `| Ownership entries | ${report.aggregate.fullRepo.workspaceRepoFacts.ownershipCount} | ${report.aggregate.changedFilesScoped.workspaceRepoFacts.ownershipCount} | ${report.aggregate.delta.ownershipReduction} |`
  );
  lines.push(
    `| Module boundaries | ${report.aggregate.fullRepo.workspaceRepoFacts.moduleBoundaryCount} | ${report.aggregate.changedFilesScoped.workspaceRepoFacts.moduleBoundaryCount} | ${report.aggregate.delta.moduleBoundaryReduction} |`
  );
  lines.push(
    `| Sensitive patterns | ${report.aggregate.fullRepo.workspaceRepoFacts.sensitivePatternCount} | ${report.aggregate.changedFilesScoped.workspaceRepoFacts.sensitivePatternCount} | ${report.aggregate.delta.sensitivePatternReduction} |`
  );
  lines.push(
    `| Stale facts | ${report.aggregate.fullRepo.workspaceRepoFacts.staleFactCount} | ${report.aggregate.changedFilesScoped.workspaceRepoFacts.staleFactCount} | ${report.aggregate.delta.staleFactReduction} |`
  );
  lines.push(
    `| Total role-view tokens | ${report.aggregate.fullRepo.totalRoleViewEstimatedTokens} | ${report.aggregate.changedFilesScoped.totalRoleViewEstimatedTokens} | ${report.aggregate.delta.roleViewTokenReduction} |`
  );
  lines.push(
    `| Avg role-view tokens | ${report.aggregate.fullRepo.averageRoleViewEstimatedTokens} | ${report.aggregate.changedFilesScoped.averageRoleViewEstimatedTokens} | ${report.aggregate.delta.averageRoleViewTokenReduction} |`
  );
  lines.push(
    `| Avg budget utilization | ${report.aggregate.fullRepo.averageBudgetUtilization} | ${report.aggregate.changedFilesScoped.averageBudgetUtilization} | ${report.aggregate.delta.averageBudgetUtilizationReduction} |`
  );
  lines.push("");

  lines.push(
    `- Role-view token reduction rate: \`${report.aggregate.delta.roleViewTokenReductionRate}\``
  );
  lines.push("");

  lines.push(`## Sufficiency`);
  lines.push("");
  lines.push(`| Mode | Sufficiency | Count |`);
  lines.push(`| --- | --- | ---: |`);

  for (const [sufficiency, count] of Object.entries(report.aggregate.fullRepo.sufficiencyCounts)) {
    lines.push(`| full_repo | ${escapeMarkdownCell(sufficiency)} | ${count} |`);
  }

  for (const [sufficiency, count] of Object.entries(report.aggregate.changedFilesScoped.sufficiencyCounts)) {
    lines.push(`| changed_files_scoped | ${escapeMarkdownCell(sufficiency)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(
    `| Case | Full Tokens | Changed Tokens | Reduction | Reduction Rate | Full Avg Util. | Changed Avg Util. |`
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.fullRepo.totalRoleViewEstimatedTokens} | ${item.changedFilesScoped.totalRoleViewEstimatedTokens} | ${item.delta.roleViewTokenReduction} | ${item.delta.roleViewTokenReductionRate} | ${item.fullRepo.averageBudgetUtilization} | ${item.changedFilesScoped.averageBudgetUtilization} |`
    );
  }

  lines.push("");

  for (const item of report.cases) {
    lines.push(`## Case Detail: \`${item.caseId}\``);
    lines.push("");
    lines.push(`- Family: \`${item.family}\``);
    lines.push(`- Task: ${escapeMarkdownText(item.task)}`);
    lines.push(`- Expected result: ${escapeMarkdownText(item.expectedResult)}`);
    lines.push("");

    lines.push(`### Role Views`);
    lines.push("");
    lines.push(`| Mode | Role | Sufficiency | Tokens | Budget | Utilization | Has repoFacts |`);
    lines.push(`| --- | --- | --- | ---: | ---: | ---: | --- |`);

    for (const view of item.fullRepo.roleViews) {
      lines.push(
        `| full_repo | ${view.role} | ${view.sufficiency} | ${view.estimatedTokens} | ${view.budgetTokens} | ${view.budgetUtilization} | ${view.hasRepoFactsContext} |`
      );
    }

    for (const view of item.changedFilesScoped.roleViews) {
      lines.push(
        `| changed_files_scoped | ${view.role} | ${view.sufficiency} | ${view.estimatedTokens} | ${view.budgetTokens} | ${view.budgetUtilization} | ${view.hasRepoFactsContext} |`
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function getRepoFactsContext(view: ComposedRoleView): Record<string, unknown> | null {
  const repoFacts = view.context.repoFacts;

  if (repoFacts && typeof repoFacts === "object" && !Array.isArray(repoFacts)) {
    return repoFacts as Record<string, unknown>;
  }

  return null;
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

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
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