import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateConflictAwareMerge,
  type ConflictAwareMergeResult,
  type MergeConflictKind
} from "../../../packages/merge-core/src/index.js";
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
import type { WorkspaceDecision } from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/merge-runtime";
const reportName = "conflict-aware-merge-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

type MergeCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;

  orchestrationDecision: WorkspaceDecision;
  mergeDecision: WorkspaceDecision;
  mergeSafe: boolean;
  remaskTriggered: boolean;

  conflictCount: number;
  conflicts: MergeConflictSummary[];
  reasons: string[];
  requiredActions: string[];

  tokenSummary: OrchestrationRunResult["tokenSummary"];
  mutationSummary: OrchestrationRunResult["mutationSummary"];
  evidence: ConflictAwareMergeResult["evidence"];
};

type MergeConflictSummary = {
  id: string;
  kind: MergeConflictKind;
  severity: string;
  message: string;
  sourceStepIds: string[];
  evidenceIds: string[];
  suggestedDecision: WorkspaceDecision;
};

type MergeReportAggregate = {
  caseCount: number;
  mergeSafeCount: number;
  mergeUnsafeCount: number;
  remaskTriggeredCount: number;
  totalConflicts: number;
  averageConflictsPerCase: number;
  conflictCountsByKind: Record<string, number>;
  decisionCounts: Record<string, number>;
  requiredActionCounts: Record<string, number>;
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  mutatedRegions: string[];
};

type MergeReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  aggregate: MergeReportAggregate;
  cases: MergeCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before conflict-aware merge report.",
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

  const jsonPath = join(reportDir, `${safeTimestamp}-merge-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-merge-report.md`);

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

function createCaseReport(fixture: BenchmarkFixture): MergeCaseReport {
  const workspace = createWorkspaceFromPacket(fixture.packet, {
    id: `merge-report-${fixture.case.id}`
  });

  const orchestrationResult = runMockOrchestrationFlow(workspace);
  const mergeResult = evaluateConflictAwareMerge(orchestrationResult);

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,

    orchestrationDecision: orchestrationResult.decision,
    mergeDecision: mergeResult.decision,
    mergeSafe: mergeResult.mergeSafe,
    remaskTriggered: orchestrationResult.remaskTriggered,

    conflictCount: mergeResult.conflicts.length,
    conflicts: mergeResult.conflicts.map((conflict) => ({
      id: conflict.id,
      kind: conflict.kind,
      severity: conflict.severity,
      message: conflict.message,
      sourceStepIds: conflict.sourceStepIds,
      evidenceIds: conflict.evidenceIds,
      suggestedDecision: conflict.suggestedDecision
    })),
    reasons: mergeResult.reasons,
    requiredActions: mergeResult.requiredActions,

    tokenSummary: orchestrationResult.tokenSummary,
    mutationSummary: orchestrationResult.mutationSummary,
    evidence: mergeResult.evidence
  };
}

function createReport(cases: MergeCaseReport[]): MergeReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "conflict-aware-merge-remask-fixtures-v1",
    aggregate: aggregateCases(cases),
    cases
  };
}

function aggregateCases(cases: MergeCaseReport[]): MergeReportAggregate {
  const allConflicts = cases.flatMap((item) => item.conflicts);
  const allRequiredActions = cases.flatMap((item) => item.requiredActions);

  return {
    caseCount: cases.length,
    mergeSafeCount: cases.filter((item) => item.mergeSafe).length,
    mergeUnsafeCount: cases.filter((item) => !item.mergeSafe).length,
    remaskTriggeredCount: cases.filter((item) => item.remaskTriggered).length,
    totalConflicts: allConflicts.length,
    averageConflictsPerCase: roundRatio(allConflicts.length / Math.max(cases.length, 1)),
    conflictCountsByKind: countBy(allConflicts.map((conflict) => conflict.kind)),
    decisionCounts: countBy(cases.map((item) => item.mergeDecision)),
    requiredActionCounts: countBy(allRequiredActions),
    totalMutations: cases.reduce((sum, item) => sum + item.mutationSummary.totalMutations, 0),
    appliedMutations: cases.reduce((sum, item) => sum + item.mutationSummary.appliedMutations, 0),
    blockedMutations: cases.reduce((sum, item) => sum + item.mutationSummary.blockedMutations, 0),
    mutatedRegions: [
      ...new Set(cases.flatMap((item) => item.mutationSummary.mutatedRegions))
    ]
  };
}

function reportToMarkdown(report: MergeReport): string {
  const lines: string[] = [];

  lines.push(`# Conflict-Aware Merge Report`);
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
  lines.push(`| Merge safe | ${report.aggregate.mergeSafeCount} |`);
  lines.push(`| Merge unsafe | ${report.aggregate.mergeUnsafeCount} |`);
  lines.push(`| Remask triggered | ${report.aggregate.remaskTriggeredCount} |`);
  lines.push(`| Total conflicts | ${report.aggregate.totalConflicts} |`);
  lines.push(`| Average conflicts per case | ${report.aggregate.averageConflictsPerCase} |`);
  lines.push(`| Total mutations | ${report.aggregate.totalMutations} |`);
  lines.push(`| Applied mutations | ${report.aggregate.appliedMutations} |`);
  lines.push(`| Blocked mutations | ${report.aggregate.blockedMutations} |`);
  lines.push("");

  lines.push(`### Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.decisionCounts)) {
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

  lines.push(`### Required Actions`);
  lines.push("");
  lines.push(`| Required Action | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [action, count] of Object.entries(report.aggregate.requiredActionCounts)) {
    lines.push(`| ${escapeMarkdownCell(action)} | ${count} |`);
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
    lines.push(`- Orchestration decision: \`${item.orchestrationDecision}\``);
    lines.push(`- Merge decision: \`${item.mergeDecision}\``);
    lines.push(`- Merge safe: \`${item.mergeSafe}\``);
    lines.push(`- Remask triggered: \`${item.remaskTriggered}\``);
    lines.push(`- Task: ${escapeMarkdownText(item.task)}`);
    lines.push(`- Expected result: ${escapeMarkdownText(item.expectedResult)}`);
    lines.push("");

    lines.push(`### Evidence`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Flow ID | \`${item.evidence.flowId}\` |`);
    lines.push(`| Verifier decisions | \`${item.evidence.verifierDecisions.join(", ")}\` |`);
    lines.push(`| Total mutations | ${item.evidence.totalMutations} |`);
    lines.push(`| Applied mutations | ${item.evidence.appliedMutations} |`);
    lines.push(`| Blocked mutations | ${item.evidence.blockedMutations} |`);
    lines.push(`| Mutated regions | ${escapeMarkdownCell(item.evidence.mutatedRegions.join(", "))} |`);
    lines.push("");

    lines.push(`### Conflicts`);
    lines.push("");

    if (item.conflicts.length === 0) {
      lines.push(`No conflicts.`);
      lines.push("");
    } else {
      lines.push(`| Kind | Severity | Suggested Decision | Source Steps | Evidence IDs | Message |`);
      lines.push(`| --- | --- | --- | --- | --- | --- |`);

      for (const conflict of item.conflicts) {
        lines.push(
          `| ${conflict.kind} | ${conflict.severity} | ${conflict.suggestedDecision} | ${escapeMarkdownCell(conflict.sourceStepIds.join(", "))} | ${escapeMarkdownCell(conflict.evidenceIds.join(", "))} | ${escapeMarkdownCell(conflict.message)} |`
        );
      }

      lines.push("");
    }

    lines.push(`### Required Actions`);
    lines.push("");

    if (item.requiredActions.length === 0) {
      lines.push(`No required actions.`);
    } else {
      for (const action of item.requiredActions) {
        lines.push(`- ${escapeMarkdownText(action)}`);
      }
    }

    lines.push("");

    lines.push(`### Reasons`);
    lines.push("");

    for (const reason of item.reasons) {
      lines.push(`- ${escapeMarkdownText(reason)}`);
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