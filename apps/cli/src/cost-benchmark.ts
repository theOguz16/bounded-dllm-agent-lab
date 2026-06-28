import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeRoleViews,
  type ComposedRoleView
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures,
  type BenchmarkFixture
} from "../../../packages/fixtures/src/index.js";
import type {
  SharedSemanticWorkspace,
  WorkspaceRole
} from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/cost-runtime";
const reportName = "bounded-context-cost-benchmark-v1";
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

type CostRoleSummary = {
  role: WorkspaceRole;
  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  sufficiency: string;
  includedRegionCount: number;
  excludedRegionCount: number;
  includedFactCount: number;
  excludedFactCount: number;
  staleExclusionCount: number;
  sensitiveExclusionCount: number;
};

type CostCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;

  fullWorkspaceEstimatedTokens: number;

  /**
   * Naive baseline:
   * Her role/agent full workspace görseydi toplam context maliyeti.
   */
  naiveFullWorkspacePerRoleTokens: number;

  /**
   * Bounded runtime:
   * Her role kendi role-specific bounded view'ini görüyor.
   */
  boundedRoleViewTokens: number;

  tokenSavings: number;
  tokenSavingsRate: number;

  averageRoleViewTokens: number;
  maxRoleViewTokens: number;
  averageBudgetUtilization: number;

  roleViews: CostRoleSummary[];
};

type CostBenchmarkAggregate = {
  caseCount: number;
  roleCount: number;
  totalRoleViews: number;

  totalFullWorkspaceEstimatedTokens: number;
  totalNaiveFullWorkspacePerRoleTokens: number;
  totalBoundedRoleViewTokens: number;

  totalTokenSavings: number;
  tokenSavingsRate: number;

  averageFullWorkspaceEstimatedTokens: number;
  averageBoundedRoleViewTokensPerCase: number;
  averageRoleViewTokens: number;
  maxRoleViewTokens: number;
  averageBudgetUtilization: number;

  sufficiencyCounts: Record<string, number>;
};

type CostBenchmarkReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  roles: WorkspaceRole[];
  aggregate: CostBenchmarkAggregate;
  cases: CostCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before cost benchmark.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

await runCostBenchmark();

async function runCostBenchmark(): Promise<void> {
  await mkdir(reportDir, {
    recursive: true
  });

  const cases = remaskFixtures.map(createCaseReport);
  const report = createReport(cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-cost-benchmark.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-cost-benchmark.md`);

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

function createCaseReport(fixture: BenchmarkFixture): CostCaseReport {
  const workspace = createWorkspaceFromPacket(fixture.packet, {
    id: `cost-benchmark-${fixture.case.id}`
  });

  const views = composeRoleViews(workspace, roles);
  const roleViews = views.map(summarizeRoleView);

  const fullWorkspaceEstimatedTokens = estimateFullWorkspaceTokens(workspace);

  const naiveFullWorkspacePerRoleTokens = fullWorkspaceEstimatedTokens * roles.length;
  const boundedRoleViewTokens = roleViews.reduce(
    (sum, view) => sum + view.estimatedTokens,
    0
  );

  const tokenSavings = naiveFullWorkspacePerRoleTokens - boundedRoleViewTokens;
  const tokenSavingsRate = roundRatio(
    tokenSavings / Math.max(naiveFullWorkspacePerRoleTokens, 1)
  );

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,

    fullWorkspaceEstimatedTokens,
    naiveFullWorkspacePerRoleTokens,
    boundedRoleViewTokens,

    tokenSavings,
    tokenSavingsRate,

    averageRoleViewTokens: roundRatio(
      boundedRoleViewTokens / Math.max(roleViews.length, 1)
    ),
    maxRoleViewTokens: Math.max(0, ...roleViews.map((view) => view.estimatedTokens)),
    averageBudgetUtilization: roundRatio(
      roleViews.reduce((sum, view) => sum + view.budgetUtilization, 0) /
        Math.max(roleViews.length, 1)
    ),

    roleViews
  };
}

function createReport(cases: CostCaseReport[]): CostBenchmarkReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "bounded-context-cost-remask-fixtures-v1",
    roles,
    aggregate: aggregateCases(cases),
    cases
  };
}

function summarizeRoleView(view: ComposedRoleView): CostRoleSummary {
  return {
    role: view.role,
    estimatedTokens: view.estimatedTokens,
    budgetTokens: view.budgetTokens,
    budgetUtilization: view.budgetUtilization,
    sufficiency: view.sufficiency,
    includedRegionCount: view.includedRegions.length,
    excludedRegionCount: view.excludedRegions.length,
    includedFactCount: view.includedFacts.length,
    excludedFactCount: view.excludedFacts.length,
    staleExclusionCount: view.staleExclusions.length,
    sensitiveExclusionCount: view.sensitiveExclusions.length
  };
}

function aggregateCases(cases: CostCaseReport[]): CostBenchmarkAggregate {
  const allRoleViews = cases.flatMap((item) => item.roleViews);

  const totalFullWorkspaceEstimatedTokens = cases.reduce(
    (sum, item) => sum + item.fullWorkspaceEstimatedTokens,
    0
  );

  const totalNaiveFullWorkspacePerRoleTokens = cases.reduce(
    (sum, item) => sum + item.naiveFullWorkspacePerRoleTokens,
    0
  );

  const totalBoundedRoleViewTokens = cases.reduce(
    (sum, item) => sum + item.boundedRoleViewTokens,
    0
  );

  const totalTokenSavings =
    totalNaiveFullWorkspacePerRoleTokens - totalBoundedRoleViewTokens;

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    totalRoleViews: allRoleViews.length,

    totalFullWorkspaceEstimatedTokens,
    totalNaiveFullWorkspacePerRoleTokens,
    totalBoundedRoleViewTokens,

    totalTokenSavings,
    tokenSavingsRate: roundRatio(
      totalTokenSavings / Math.max(totalNaiveFullWorkspacePerRoleTokens, 1)
    ),

    averageFullWorkspaceEstimatedTokens: roundRatio(
      totalFullWorkspaceEstimatedTokens / Math.max(cases.length, 1)
    ),
    averageBoundedRoleViewTokensPerCase: roundRatio(
      totalBoundedRoleViewTokens / Math.max(cases.length, 1)
    ),
    averageRoleViewTokens: roundRatio(
      totalBoundedRoleViewTokens / Math.max(allRoleViews.length, 1)
    ),
    maxRoleViewTokens: Math.max(0, ...allRoleViews.map((view) => view.estimatedTokens)),
    averageBudgetUtilization: roundRatio(
      allRoleViews.reduce((sum, view) => sum + view.budgetUtilization, 0) /
        Math.max(allRoleViews.length, 1)
    ),

    sufficiencyCounts: countBy(allRoleViews.map((view) => view.sufficiency))
  };
}

function estimateFullWorkspaceTokens(workspace: SharedSemanticWorkspace): number {
  /**
   * Full workspace baseline bilinçli olarak canonical runtime object üzerinden
   * hesaplanıyor. Bu "her agent'a tüm workspace'i versek ne olurdu?" sorusunun
   * deterministik baseline'ıdır.
   */
  return estimateJsonTokens({
    id: workspace.id,
    task: workspace.task,
    scope: workspace.scope,
    authority: workspace.authority,
    policy: workspace.policy,
    repoFacts: workspace.repoFacts,
    patchIntent: workspace.patchIntent,
    roleViews: workspace.roleViews,
    claims: workspace.claims,
    verifierResults: workspace.verifierResults,
    conflicts: workspace.conflicts,
    mergeDecision: workspace.mergeDecision,
    finalResult: workspace.finalResult,
    trace: workspace.trace,
    maskedRegions: workspace.maskedRegions
  });
}

function reportToMarkdown(report: CostBenchmarkReport): string {
  const lines: string[] = [];

  lines.push(`# Bounded Context Cost Benchmark`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Roles: \`${report.roles.join(", ")}\``);
  lines.push("");

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Role count | ${report.aggregate.roleCount} |`);
  lines.push(`| Total role views | ${report.aggregate.totalRoleViews} |`);
  lines.push(`| Total full workspace tokens | ${report.aggregate.totalFullWorkspaceEstimatedTokens} |`);
  lines.push(`| Naive full-workspace-per-role tokens | ${report.aggregate.totalNaiveFullWorkspacePerRoleTokens} |`);
  lines.push(`| Bounded role-view tokens | ${report.aggregate.totalBoundedRoleViewTokens} |`);
  lines.push(`| Token savings | ${report.aggregate.totalTokenSavings} |`);
  lines.push(`| Token savings rate | ${report.aggregate.tokenSavingsRate} |`);
  lines.push(`| Avg full workspace tokens | ${report.aggregate.averageFullWorkspaceEstimatedTokens} |`);
  lines.push(`| Avg bounded tokens per case | ${report.aggregate.averageBoundedRoleViewTokensPerCase} |`);
  lines.push(`| Avg role-view tokens | ${report.aggregate.averageRoleViewTokens} |`);
  lines.push(`| Max role-view tokens | ${report.aggregate.maxRoleViewTokens} |`);
  lines.push(`| Avg budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
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
    `| Case | Full Workspace | Naive Full x Roles | Bounded Role Views | Savings | Savings Rate | Avg Role Tokens | Max Role Tokens | Avg Budget Utilization |`
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${item.caseId} | ${item.fullWorkspaceEstimatedTokens} | ${item.naiveFullWorkspacePerRoleTokens} | ${item.boundedRoleViewTokens} | ${item.tokenSavings} | ${item.tokenSavingsRate} | ${item.averageRoleViewTokens} | ${item.maxRoleViewTokens} | ${item.averageBudgetUtilization} |`
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
      `| Role | Tokens | Budget | Utilization | Sufficiency | Included Regions | Excluded Regions | Included Facts | Excluded Facts | Stale Excl. | Sensitive Excl. |`
    );
    lines.push(`| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);

    for (const view of item.roleViews) {
      lines.push(
        `| ${view.role} | ${view.estimatedTokens} | ${view.budgetTokens} | ${view.budgetUtilization} | ${view.sufficiency} | ${view.includedRegionCount} | ${view.excludedRegionCount} | ${view.includedFactCount} | ${view.excludedFactCount} | ${view.staleExclusionCount} | ${view.sensitiveExclusionCount} |`
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
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