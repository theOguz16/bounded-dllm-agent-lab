import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runMockOrchestrationFlow,
  type OrchestrationRunResult
} from "../../../packages/orchestration-core/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures,
  type BenchmarkFixture
} from "../../../packages/fixtures/src/index.js";

const reportDir = "reports/orchestration-runtime";
const reportName = "orchestrator-runtime-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

type OrchestratorCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  decision: string;
  remaskTriggered: boolean;
  stepCount: number;
  verifierResultCount: number;
  finalResult: string | null;
  tokenSummary: OrchestrationRunResult["tokenSummary"];
  mutationSummary: OrchestrationRunResult["mutationSummary"];
  steps: OrchestratorStepSummary[];
};

type OrchestratorStepSummary = {
  id: string;
  role: string;
  status: string;
  decision?: string;
  sufficiency: string;
  estimatedTokens: number;
  budgetTokens: number;
  budgetUtilization: number;
  includedFactCount: number;
  excludedFactCount: number;
  warningCount: number;
  reads: string[];
  writes: string[];
  writeCheckCount: number;
  mutationCount: number;
  mutatedRegions: string[];
};

type OrchestratorAggregate = {
  caseCount: number;
  totalSteps: number;
  totalEstimatedTokens: number;
  totalBudgetTokens: number;
  averageBudgetUtilization: number;
  maxEstimatedTokens: number;
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  remaskTriggeredCount: number;
  decisionCounts: Record<string, number>;
  mutatedRegions: string[];
};

type OrchestratorReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  aggregate: OrchestratorAggregate;
  cases: OrchestratorCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before orchestrator report.",
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

  const cases = remaskFixtures.map(createCaseReport);
  const report = createReport(cases);

  const jsonPath = join(reportDir, `${safeTimestamp}-orchestrator-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-orchestrator-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        caseCount: report.aggregate.caseCount,
        jsonPath,
        markdownPath,
        aggregate: report.aggregate
      },
      null,
      2
    )
  );
}

function createCaseReport(fixture: BenchmarkFixture): OrchestratorCaseReport {
  const workspace = createWorkspaceFromPacket(fixture.packet, {
    id: `orchestrator-report-${fixture.case.id}`
  });

  const result = runMockOrchestrationFlow(workspace);

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    verifierResultCount: result.workspace.verifierResults.length,
    finalResult: result.workspace.finalResult?.summary ?? null,
    tokenSummary: result.tokenSummary,
    mutationSummary: result.mutationSummary,
    steps: result.steps.map((step) => ({
      id: step.id,
      role: step.role,
      status: step.status,
      decision: step.decision,
      sufficiency: step.sufficiency,
      estimatedTokens: step.estimatedTokens,
      budgetTokens: step.budgetTokens,
      budgetUtilization: step.budgetUtilization,
      includedFactCount: step.includedFactCount,
      excludedFactCount: step.excludedFactCount,
      warningCount: step.warnings.length,
      reads: step.reads,
      writes: step.writes,
      writeCheckCount: step.writeChecks.length,
      mutationCount: step.mutations.length,
      mutatedRegions: step.mutations.map((mutation) => mutation.region)
    }))
  };
}

function createReport(cases: OrchestratorCaseReport[]): OrchestratorReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "mock-workspace-verifier-remask-flow-v1",
    aggregate: aggregateCases(cases),
    cases
  };
}

function aggregateCases(cases: OrchestratorCaseReport[]): OrchestratorAggregate {
  const totalSteps = cases.reduce((sum, item) => sum + item.stepCount, 0);
  const totalEstimatedTokens = cases.reduce(
    (sum, item) => sum + item.tokenSummary.totalEstimatedTokens,
    0
  );
  const totalBudgetTokens = cases.reduce(
    (sum, item) => sum + item.tokenSummary.totalBudgetTokens,
    0
  );
  const totalBudgetUtilization = cases.reduce(
    (sum, item) => sum + item.tokenSummary.averageBudgetUtilization,
    0
  );

  const allMutatedRegions = [
    ...new Set(cases.flatMap((item) => item.mutationSummary.mutatedRegions))
  ];

  return {
    caseCount: cases.length,
    totalSteps,
    totalEstimatedTokens,
    totalBudgetTokens,
    averageBudgetUtilization: roundRatio(totalBudgetUtilization / Math.max(cases.length, 1)),
    maxEstimatedTokens: Math.max(0, ...cases.map((item) => item.tokenSummary.maxEstimatedTokens)),
    totalMutations: cases.reduce((sum, item) => sum + item.mutationSummary.totalMutations, 0),
    appliedMutations: cases.reduce((sum, item) => sum + item.mutationSummary.appliedMutations, 0),
    blockedMutations: cases.reduce((sum, item) => sum + item.mutationSummary.blockedMutations, 0),
    remaskTriggeredCount: cases.filter((item) => item.remaskTriggered).length,
    decisionCounts: countBy(cases.map((item) => item.decision)),
    mutatedRegions: allMutatedRegions
  };
}

function reportToMarkdown(report: OrchestratorReport): string {
  const lines: string[] = [];

  lines.push(`# Orchestrator Runtime Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push("");

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Total steps | ${report.aggregate.totalSteps} |`);
  lines.push(`| Total estimated tokens | ${report.aggregate.totalEstimatedTokens} |`);
  lines.push(`| Total budget tokens | ${report.aggregate.totalBudgetTokens} |`);
  lines.push(`| Average budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
  lines.push(`| Max estimated tokens | ${report.aggregate.maxEstimatedTokens} |`);
  lines.push(`| Total mutations | ${report.aggregate.totalMutations} |`);
  lines.push(`| Applied mutations | ${report.aggregate.appliedMutations} |`);
  lines.push(`| Blocked mutations | ${report.aggregate.blockedMutations} |`);
  lines.push(`| Remask triggered count | ${report.aggregate.remaskTriggeredCount} |`);
  lines.push("");

  lines.push(`### Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.decisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Mutated Regions`);
  lines.push("");
  lines.push(report.aggregate.mutatedRegions.map((region) => `- \`${region}\``).join("\n"));
  lines.push("");

  for (const item of report.cases) {
    lines.push(`## Case: \`${item.caseId}\``);
    lines.push("");
    lines.push(`- Family: \`${item.family}\``);
    lines.push(`- Workspace: \`${item.workspaceId}\``);
    lines.push(`- Decision: \`${item.decision}\``);
    lines.push(`- Remask triggered: \`${item.remaskTriggered}\``);
    lines.push(`- Task: ${escapeMarkdownText(item.task)}`);
    lines.push(`- Expected result: ${escapeMarkdownText(item.expectedResult)}`);
    lines.push("");

    lines.push(`### Token Summary`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | ---: |`);
    lines.push(`| Total estimated tokens | ${item.tokenSummary.totalEstimatedTokens} |`);
    lines.push(`| Total budget tokens | ${item.tokenSummary.totalBudgetTokens} |`);
    lines.push(`| Average budget utilization | ${item.tokenSummary.averageBudgetUtilization} |`);
    lines.push(`| Max estimated tokens | ${item.tokenSummary.maxEstimatedTokens} |`);
    lines.push("");

    lines.push(`### Mutation Summary`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | ---: |`);
    lines.push(`| Total mutations | ${item.mutationSummary.totalMutations} |`);
    lines.push(`| Applied mutations | ${item.mutationSummary.appliedMutations} |`);
    lines.push(`| Blocked mutations | ${item.mutationSummary.blockedMutations} |`);
    lines.push("");

    lines.push(`### Steps`);
    lines.push("");
    lines.push(
      `| Step | Role | Status | Decision | Tokens | Budget | Utilization | Mutations | Writes |`
    );
    lines.push(`| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |`);

    for (const step of item.steps) {
      lines.push(
        `| ${step.id} | ${step.role} | ${step.status} | ${step.decision ?? "-"} | ${step.estimatedTokens} | ${step.budgetTokens} | ${step.budgetUtilization} | ${step.mutationCount} | ${escapeMarkdownCell(step.writes.join(", "))} |`
      );
    }

    lines.push("");

    lines.push(`### Read/Write Matrix`);
    lines.push("");
    lines.push(`| Step | Reads | Writes | Mutated Regions |`);
    lines.push(`| --- | --- | --- | --- |`);

    for (const step of item.steps) {
      lines.push(
        `| ${step.id} | ${escapeMarkdownCell(step.reads.join(", "))} | ${escapeMarkdownCell(step.writes.join(", "))} | ${escapeMarkdownCell(step.mutatedRegions.join(", "))} |`
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
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