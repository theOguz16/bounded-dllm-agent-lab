import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  analyzeRepository
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
  SharedSemanticWorkspace,
  WorkspaceRole
} from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/repo-context-runtime";
const reportName = "repo-context-composer-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

const roles: WorkspaceRole[] = [
  "planner",
  "coder",
  "verifier",
  "tester",
  "remask",
  "merge"
];

type RepoContextRoleReport = {
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
  warnings: string[];

  hasRepoFactsContext: boolean;

  /**
   * Bu role repo_facts region'ını görüyorsa:
   * rawRepoFactsEstimatedTokens = tüm workspace.repoFacts token tahmini
   * compactRepoFactsEstimatedTokens = role view içine giren compact repoFacts token tahmini
   */
  rawRepoFactsEstimatedTokens: number;
  compactRepoFactsEstimatedTokens: number;
  repoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type RepoContextCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;

  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  rawRepoFactsEstimatedTokens: number;

  roleViews: RepoContextRoleReport[];

  roleViewCount: number;
  repoFactsRoleViewCount: number;
  sufficientRoleViewCount: number;
  riskyRoleViewCount: number;
  insufficientRoleViewCount: number;

  totalRoleViewEstimatedTokens: number;
  maxRoleViewEstimatedTokens: number;
  averageRoleViewEstimatedTokens: number;
  averageBudgetUtilization: number;

  totalRawRepoFactsTokensForIncludedViews: number;
  totalCompactRepoFactsTokensForIncludedViews: number;
  totalRepoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type RepoContextAggregate = {
  caseCount: number;
  roleCount: number;
  totalRoleViews: number;
  repoFactsRoleViewCount: number;

  repoScannedFileCount: number;
  repoSkippedFileCount: number;

  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;

  sufficiencyCounts: Record<string, number>;

  totalRoleViewEstimatedTokens: number;
  averageRoleViewEstimatedTokens: number;
  maxRoleViewEstimatedTokens: number;
  averageBudgetUtilization: number;

  totalRawRepoFactsTokensForIncludedViews: number;
  totalCompactRepoFactsTokensForIncludedViews: number;
  totalRepoFactsTokenSavings: number;
  repoFactsTokenSavingsRate: number;
};

type RepoContextReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  roles: WorkspaceRole[];
  repo: {
    rootDir: string;
    scannedFileCount: number;
    skippedFileCount: number;
    scannedFileSamples: string[];
  };
  aggregate: RepoContextAggregate;
  cases: RepoContextCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before repo context composer report.",
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
    maxFiles: 1000
  });

  const cases = remaskFixtures.map((fixture) => createCaseReport(fixture, repoResult));
  const report = createReport(repoResult, cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-repo-context-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-repo-context-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        caseCount: report.aggregate.caseCount,
        roleCount: report.aggregate.roleCount,
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
  repoResult: Awaited<ReturnType<typeof analyzeRepository>>
): RepoContextCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
    id: `repo-context-report-${fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
  const workspaceRepoFacts = summarizeWorkspaceRepoFacts(workspace.repoFacts);
  const rawRepoFactsEstimatedTokens = estimateJsonTokens(workspace.repoFacts);

  const views = composeRoleViews(workspace, roles);
  const roleViews = views.map((view) =>
    summarizeRoleView(view, workspace, rawRepoFactsEstimatedTokens)
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
    totalRawRepoFactsTokensForIncludedViews - totalCompactRepoFactsTokensForIncludedViews;

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
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
    maxRoleViewEstimatedTokens: Math.max(0, ...roleViews.map((view) => view.estimatedTokens)),
    averageRoleViewEstimatedTokens: roundRatio(
      totalRoleViewEstimatedTokens / Math.max(roleViews.length, 1)
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
  workspace: SharedSemanticWorkspace,
  rawRepoFactsEstimatedTokens: number
): RepoContextRoleReport {
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

    includedRegionCount: view.includedRegions.length,
    excludedRegionCount: view.excludedRegions.length,
    includedRegions: view.includedRegions,
    excludedRegions: view.excludedRegions,

    includedFactCount: view.includedFacts.length,
    excludedFactCount: view.excludedFacts.length,
    staleExclusionCount: view.staleExclusions.length,
    sensitiveExclusionCount: view.sensitiveExclusions.length,
    warningCount: view.warnings.length,
    warnings: view.warnings,

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
  repoResult: Awaited<ReturnType<typeof analyzeRepository>>,
  cases: RepoContextCaseReport[]
): RepoContextReport {
  const aggregate = aggregateCases(repoResult, cases);

  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "real-repo-intelligence-context-composer-v1",
    roles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      scannedFileSamples: repoResult.scannedFiles.slice(0, 10)
    },
    aggregate,
    cases
  };
}

function aggregateCases(
  repoResult: Awaited<ReturnType<typeof analyzeRepository>>,
  cases: RepoContextCaseReport[]
): RepoContextAggregate {
  const allRoleViews = cases.flatMap((item) => item.roleViews);
  const firstWorkspaceRepoFacts = cases[0]?.workspaceRepoFacts ?? {
    changedFileCount: 0,
    ownershipCount: 0,
    pairedFileCount: 0,
    requiredTestCount: 0,
    requiredTestMappingCount: 0,
    moduleBoundaryCount: 0,
    sensitivePatternCount: 0,
    staleFactCount: 0
  };

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
    totalRawRepoFactsTokensForIncludedViews - totalCompactRepoFactsTokensForIncludedViews;

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    totalRoleViews: allRoleViews.length,
    repoFactsRoleViewCount: allRoleViews.filter((view) => view.hasRepoFactsContext).length,

    repoScannedFileCount: repoResult.scannedFileCount,
    repoSkippedFileCount: repoResult.skippedFileCount,

    workspaceRepoFacts: firstWorkspaceRepoFacts,

    sufficiencyCounts,

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

function reportToMarkdown(report: RepoContextReport): string {
  const lines: string[] = [];

  lines.push(`# Repo Context Composer Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Roles: \`${report.roles.join(", ")}\``);
  lines.push("");

  lines.push(`## Repo Scan`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Scanned files | ${report.repo.scannedFileCount} |`);
  lines.push(`| Skipped files | ${report.repo.skippedFileCount} |`);
  lines.push("");

  lines.push(`### Scanned File Samples`);
  lines.push("");

  for (const file of report.repo.scannedFileSamples) {
    lines.push(`- \`${file}\``);
  }

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
  lines.push(`| Role count | ${report.aggregate.roleCount} |`);
  lines.push(`| Total role views | ${report.aggregate.totalRoleViews} |`);
  lines.push(`| Role views with repoFacts | ${report.aggregate.repoFactsRoleViewCount} |`);
  lines.push(`| Total role-view tokens | ${report.aggregate.totalRoleViewEstimatedTokens} |`);
  lines.push(`| Avg role-view tokens | ${report.aggregate.averageRoleViewEstimatedTokens} |`);
  lines.push(`| Max role-view tokens | ${report.aggregate.maxRoleViewEstimatedTokens} |`);
  lines.push(`| Avg budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
  lines.push(`| Raw repoFacts tokens for included views | ${report.aggregate.totalRawRepoFactsTokensForIncludedViews} |`);
  lines.push(`| Compact repoFacts tokens for included views | ${report.aggregate.totalCompactRepoFactsTokensForIncludedViews} |`);
  lines.push(`| RepoFacts token savings | ${report.aggregate.totalRepoFactsTokenSavings} |`);
  lines.push(`| RepoFacts token savings rate | ${report.aggregate.repoFactsTokenSavingsRate} |`);
  lines.push("");

  lines.push(`### Sufficiency`);
  lines.push("");
  lines.push(`| Sufficiency | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [sufficiency, count] of Object.entries(report.aggregate.sufficiencyCounts)) {
    lines.push(`| ${escapeMarkdownCell(sufficiency)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(
    `| Case | Role Views | Sufficient | Risky | Insufficient | Avg Tokens | Max Tokens | Avg Budget Util. | RepoFacts Savings Rate |`
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.roleViewCount} | ${item.sufficientRoleViewCount} | ${item.riskyRoleViewCount} | ${item.insufficientRoleViewCount} | ${item.averageRoleViewEstimatedTokens} | ${item.maxRoleViewEstimatedTokens} | ${item.averageBudgetUtilization} | ${item.repoFactsTokenSavingsRate} |`
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

    lines.push(`### Role Views`);
    lines.push("");
    lines.push(
      `| Role | Sufficiency | Tokens | Budget | Utilization | Has repoFacts | Raw repoFacts | Compact repoFacts | Savings | Savings Rate | Warnings |`
    );
    lines.push(`| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |`);

    for (const view of item.roleViews) {
      lines.push(
        `| ${view.role} | ${view.sufficiency} | ${view.estimatedTokens} | ${view.budgetTokens} | ${view.budgetUtilization} | ${view.hasRepoFactsContext} | ${view.rawRepoFactsEstimatedTokens} | ${view.compactRepoFactsEstimatedTokens} | ${view.repoFactsTokenSavings} | ${view.repoFactsTokenSavingsRate} | ${view.warningCount} |`
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