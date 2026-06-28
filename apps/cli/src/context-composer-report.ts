import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeRoleViews,
  type ComposedRoleView,
  type ContextFactKind
} from "../../../packages/context-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures,
  type BenchmarkFixture
} from "../../../packages/fixtures/src/index.js";
import type { WorkspaceRole } from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/context-runtime";
const reportName = "context-composer-report-v1";
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

type ContextComposerAggregate = {
  roleCount: number;
  maxEstimatedTokens: number;
  averageEstimatedTokens: number;
  averageBudgetUtilization: number;
  sufficiencyCounts: Record<string, number>;
  totalSensitiveExclusions: number;
  totalStaleExclusions: number;
};

type ContextComposerCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  aggregate: ContextComposerAggregate;
  roleViews: ContextComposerRoleSummary[];
};

type ContextComposerRoleSummary = {
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
  includedFactKinds: Record<ContextFactKind, number>;
  excludedFactKinds: Record<ContextFactKind, number>;
  sensitiveExclusionCount: number;
  staleExclusionCount: number;
  warnings: string[];
};

type ContextComposerReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  caseCount: number;
  roleCount: number;
  roles: WorkspaceRole[];
  aggregate: ContextComposerAggregate;
  cases: ContextComposerCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before context composer report.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

await runContextComposerReport();

async function runContextComposerReport(): Promise<void> {
  await mkdir(reportDir, {
    recursive: true
  });

  const cases = remaskFixtures.map(createCaseReport);
  const report = createReport(cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-context-composer-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-context-composer-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        caseCount: report.caseCount,
        roleCount: report.roleCount,
        jsonPath,
        markdownPath,
        aggregate: report.aggregate
      },
      null,
      2
    )
  );
}

function createCaseReport(fixture: BenchmarkFixture): ContextComposerCaseReport {
  const workspace = createWorkspaceFromPacket(fixture.packet, {
    id: `context-composer-report-${fixture.case.id}`
  });

  const views = composeRoleViews(workspace, roles);
  const roleViews = views.map(summarizeView);

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,
    aggregate: aggregateRoleViews(roleViews),
    roleViews
  };
}

function createReport(cases: ContextComposerCaseReport[]): ContextComposerReport {
  const allViews = cases.flatMap((item) => item.roleViews);

  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "context-composer-remask-fixtures-v1",
    caseCount: cases.length,
    roleCount: roles.length,
    roles,
    aggregate: aggregateRoleViews(allViews),
    cases
  };
}

function summarizeView(view: ComposedRoleView): ContextComposerRoleSummary {
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
    includedFactKinds: countFactsByKind(view.includedFacts),
    excludedFactKinds: countFactsByKind(view.excludedFacts),
    sensitiveExclusionCount: view.sensitiveExclusions.length,
    staleExclusionCount: view.staleExclusions.length,
    warnings: view.warnings
  };
}

function aggregateRoleViews(
  views: ContextComposerRoleSummary[]
): ContextComposerAggregate {
  const totalEstimatedTokens = views.reduce(
    (sum, view) => sum + view.estimatedTokens,
    0
  );
  const totalBudgetUtilization = views.reduce(
    (sum, view) => sum + view.budgetUtilization,
    0
  );

  return {
    roleCount: views.length,
    maxEstimatedTokens: Math.max(0, ...views.map((view) => view.estimatedTokens)),
    averageEstimatedTokens: roundRatio(totalEstimatedTokens / Math.max(views.length, 1)),
    averageBudgetUtilization: roundRatio(totalBudgetUtilization / Math.max(views.length, 1)),
    sufficiencyCounts: countBy(views.map((view) => view.sufficiency)),
    totalSensitiveExclusions: views.reduce(
      (sum, view) => sum + view.sensitiveExclusionCount,
      0
    ),
    totalStaleExclusions: views.reduce(
      (sum, view) => sum + view.staleExclusionCount,
      0
    )
  };
}

function countFactsByKind(
  facts: Array<{
    kind: ContextFactKind;
  }>
): Record<ContextFactKind, number> {
  const counts: Record<ContextFactKind, number> = {
    current: 0,
    stale: 0,
    correction: 0,
    sensitive: 0,
    uncertain: 0
  };

  for (const fact of facts) {
    counts[fact.kind] += 1;
  }

  return counts;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function reportToMarkdown(report: ContextComposerReport): string {
  const lines: string[] = [];

  lines.push(`# Context Composer Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Cases: \`${report.caseCount}\``);
  lines.push(`- Roles: \`${report.roles.join(", ")}\``);
  lines.push("");

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Total role views | ${report.aggregate.roleCount} |`);
  lines.push(`| Max estimated tokens | ${report.aggregate.maxEstimatedTokens} |`);
  lines.push(`| Average estimated tokens | ${report.aggregate.averageEstimatedTokens} |`);
  lines.push(`| Average budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
  lines.push(`| Total sensitive exclusions | ${report.aggregate.totalSensitiveExclusions} |`);
  lines.push(`| Total stale exclusions | ${report.aggregate.totalStaleExclusions} |`);
  lines.push("");

  lines.push(`### Sufficiency`);
  lines.push("");
  lines.push(`| Sufficiency | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [sufficiency, count] of Object.entries(report.aggregate.sufficiencyCounts)) {
    lines.push(`| ${escapeMarkdownCell(sufficiency)} | ${count} |`);
  }

  lines.push("");

  for (const item of report.cases) {
    lines.push(`## Case: \`${item.caseId}\``);
    lines.push("");
    lines.push(`- Family: \`${item.family}\``);
    lines.push(`- Workspace: \`${item.workspaceId}\``);
    lines.push(`- Task: ${escapeMarkdownText(item.task)}`);
    lines.push(`- Expected result: ${escapeMarkdownText(item.expectedResult)}`);
    lines.push("");

    lines.push(`### Role Views`);
    lines.push("");
    lines.push(
      `| Role | Sufficiency | Tokens | Budget | Utilization | Included facts | Excluded facts | Sensitive excl. | Stale excl. |`
    );
    lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

    for (const view of item.roleViews) {
      lines.push(
        `| ${view.role} | ${view.sufficiency} | ${view.estimatedTokens} | ${view.budgetTokens} | ${view.budgetUtilization} | ${view.includedFactCount} | ${view.excludedFactCount} | ${view.sensitiveExclusionCount} | ${view.staleExclusionCount} |`
      );
    }

    lines.push("");

    lines.push(`### Region Matrix`);
    lines.push("");
    lines.push(`| Role | Included Regions | Excluded Regions |`);
    lines.push(`| --- | --- | --- |`);

    for (const view of item.roleViews) {
      lines.push(
        `| ${view.role} | ${escapeMarkdownCell(view.includedRegions.join(", "))} | ${escapeMarkdownCell(view.excludedRegions.join(", "))} |`
      );
    }

    lines.push("");

    lines.push(`### Warnings`);
    lines.push("");

    const warningRows = item.roleViews.filter((view) => view.warnings.length > 0);

    if (warningRows.length === 0) {
      lines.push(`No warnings.`);
      lines.push("");
      continue;
    }

    lines.push(`| Role | Warnings |`);
    lines.push(`| --- | --- |`);

    for (const view of warningRows) {
      lines.push(`| ${view.role} | ${escapeMarkdownCell(view.warnings.join("; "))} |`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
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