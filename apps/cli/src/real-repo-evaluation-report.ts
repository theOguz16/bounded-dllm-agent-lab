import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import { remaskFixtures, validateFixtures, type BenchmarkFixture } from "../../../packages/fixtures/src/index.js";
import { evaluateConflictAwareMerge, type ConflictAwareMergeResult } from "../../../packages/merge-core/src/index.js";
import { runMockOrchestrationFlow, type OrchestrationRunResult } from "../../../packages/orchestration-core/src/index.js";
import { runMockRemaskRepairLoop, type RemaskRepairLoopResult } from "../../../packages/remask-repair-core/src/index.js";
import { analyzeRepository, type RepoIntelligenceResult } from "../../../packages/repo-intelligence/src/index.js";
import {
  parseChangedFilesFromEnv,
  readGitDiff,
  selectChangedFilesForEvaluation,
  type GitDiffSummary
} from "../../../packages/repo-intelligence/src/git-diff-adapter.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts,
  type RepoIntelligenceWorkspaceSummary
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import type { WorkspaceRole } from "../../../packages/workspace-core/src/index.js";

const reportDir = "reports/real-repo-evaluation";
const reportName = "real-repo-evaluation-report-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

const fallbackChangedFiles = [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const roles: WorkspaceRole[] = [
  "planner",
  "coder",
  "verifier",
  "tester",
  "remask",
  "merge"
];

type RealRepoEvaluationCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  changedFiles: string[];
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  orchestration: {
    flowId: string;
    decision: string;
    remaskTriggered: boolean;
    stepCount: number;
    tokenSummary: OrchestrationRunResult["tokenSummary"];
    mutationSummary: OrchestrationRunResult["mutationSummary"];
  };
  merge: {
    decision: string;
    mergeSafe: boolean;
    conflictCount: number;
    conflictKinds: string[];
    requiredActions: string[];
    evidence: ConflictAwareMergeResult["evidence"];
  };
  repair: {
    status: string;
    repairApplied: boolean;
    finalDecision: string;
    finalMergeSafe: boolean;
    secondPassVerifierDecision: string;
    secondPassMergeDecision: string;
    remainingConflictCount: number;
    actionCount: number;
  };
};

type RealRepoEvaluationAggregate = {
  caseCount: number;
  roleCount: number;
  changedFiles: string[];
  repoScannedFileCount: number;
  repoSkippedFileCount: number;
  diffMode: string;
  diffChangedFileCount: number;
  diffExistingChangedFileCount: number;
  diffFileChangeCount: number;
  diffHunkCount: number;
  diffAdditionCount: number;
  diffDeletionCount: number;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  orchestrationDecisionCounts: Record<string, number>;
  mergeDecisionCounts: Record<string, number>;
  repairStatusCounts: Record<string, number>;
  finalDecisionCounts: Record<string, number>;
  remaskTriggeredCount: number;
  initialMergeSafeCount: number;
  initialMergeUnsafeCount: number;
  repairAppliedCount: number;
  finalMergeSafeCount: number;
  finalMergeUnsafeCount: number;
  secondPassApproveCount: number;
  totalInitialConflicts: number;
  totalRemainingConflicts: number;
  conflictCountsByKind: Record<string, number>;
  totalRepairActions: number;
  totalEstimatedTokens: number;
  averageBudgetUtilization: number;
  maxEstimatedTokens: number;
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  mutatedRegions: string[];
};

type RealRepoEvaluationReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  roles: WorkspaceRole[];
  changedFiles: string[];
  diff: GitDiffSummary;
  repo: {
    rootDir: string;
    scannedFileCount: number;
    skippedFileCount: number;
    diagnostics: string[];
  };
  aggregate: RealRepoEvaluationAggregate;
  cases: RealRepoEvaluationCaseReport[];
  diagnostics: string[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before real repo evaluation.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

await runReport();

async function runReport(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const diagnostics: string[] = [];
  const rootDir = process.cwd();

  const diff = readGitDiff({
    rootDir,
    baseRef: process.env.GIT_BASE_REF,
    headRef: process.env.GIT_HEAD_REF,
    diffFilePath: process.env.GIT_DIFF_FILE,
    includeStaged: process.env.GIT_DIFF_STAGED === "1",
    includeUntracked: process.env.GIT_DIFF_INCLUDE_UNTRACKED !== "0"
  });

  diagnostics.push(...diff.diagnostics);

  const changedFiles = selectChangedFilesForEvaluation({
    rootDir,
    diff,
    envChangedFiles: parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES),
    fallbackChangedFiles,
    diagnostics
  });

  const repoResult = await analyzeRepository({
    rootDir,
    changedFiles,
    maxFiles: 1000
  });

  const cases = remaskFixtures.map((fixture) =>
    createCaseReport({
      fixture,
      repoResult,
      changedFiles
    })
  );

  const report = createReport({
    diff,
    repoResult,
    cases,
    changedFiles,
    diagnostics: [...diagnostics, ...repoResult.diagnostics]
  });

  const jsonPath = join(reportDir, `${safeTimestamp}-real-repo-evaluation-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-real-repo-evaluation-report.md`);

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

function createCaseReport(input: {
  fixture: BenchmarkFixture;
  repoResult: RepoIntelligenceResult;
  changedFiles: string[];
}): RealRepoEvaluationCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(input.fixture.packet, {
    id: `real-repo-evaluation-${input.fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, input.repoResult);
  const orchestration = runMockOrchestrationFlow(workspace);
  const merge = evaluateConflictAwareMerge(orchestration);
  const repair = runMockRemaskRepairLoop({
    orchestration,
    merge
  });

  return {
    caseId: input.fixture.case.id,
    family: input.fixture.case.family,
    task: input.fixture.packet.task,
    expectedResult: input.fixture.case.expectedResult,
    workspaceId: workspace.id,
    changedFiles: input.changedFiles,
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    orchestration: summarizeOrchestration(orchestration),
    merge: summarizeMerge(merge),
    repair: summarizeRepair(repair)
  };
}

function summarizeOrchestration(result: OrchestrationRunResult): RealRepoEvaluationCaseReport["orchestration"] {
  return {
    flowId: result.flowId,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    tokenSummary: result.tokenSummary,
    mutationSummary: result.mutationSummary
  };
}

function summarizeMerge(result: ConflictAwareMergeResult): RealRepoEvaluationCaseReport["merge"] {
  return {
    decision: result.decision,
    mergeSafe: result.mergeSafe,
    conflictCount: result.conflicts.length,
    conflictKinds: result.conflicts.map((conflict) => conflict.kind),
    requiredActions: result.requiredActions,
    evidence: result.evidence
  };
}

function summarizeRepair(result: RemaskRepairLoopResult): RealRepoEvaluationCaseReport["repair"] {
  return {
    status: result.status,
    repairApplied: result.repairApplied,
    finalDecision: result.finalDecision,
    finalMergeSafe: result.finalMergeSafe,
    secondPassVerifierDecision: result.secondPass.verifierDecision,
    secondPassMergeDecision: result.secondPass.mergeDecision,
    remainingConflictCount: result.remainingConflicts.length,
    actionCount: result.actions.length
  };
}

function createReport(input: {
  diff: GitDiffSummary;
  repoResult: RepoIntelligenceResult;
  cases: RealRepoEvaluationCaseReport[];
  changedFiles: string[];
  diagnostics: string[];
}): RealRepoEvaluationReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "real-repo-diff-bounded-runtime-evaluation-v1",
    roles,
    changedFiles: input.changedFiles,
    diff: input.diff,
    repo: {
      rootDir: input.repoResult.rootDir,
      scannedFileCount: input.repoResult.scannedFileCount,
      skippedFileCount: input.repoResult.skippedFileCount,
      diagnostics: input.repoResult.diagnostics.slice(0, 20)
    },
    aggregate: aggregateCases(input.diff, input.repoResult, input.cases, input.changedFiles),
    cases: input.cases,
    diagnostics: input.diagnostics.slice(0, 30)
  };
}

function aggregateCases(
  diff: GitDiffSummary,
  repoResult: RepoIntelligenceResult,
  cases: RealRepoEvaluationCaseReport[],
  changedFiles: string[]
): RealRepoEvaluationAggregate {
  const conflicts = cases.flatMap((item) => item.merge.conflictKinds);
  const mutatedRegions = cases.flatMap((item) => item.orchestration.mutationSummary.mutatedRegions);
  const totalEstimatedTokens = cases.reduce(
    (sum, item) => sum + item.orchestration.tokenSummary.totalEstimatedTokens,
    0
  );

  const averageBudgetUtilization = roundRatio(
    cases.reduce(
      (sum, item) => sum + item.orchestration.tokenSummary.averageBudgetUtilization,
      0
    ) / Math.max(cases.length, 1)
  );

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    changedFiles,
    repoScannedFileCount: repoResult.scannedFileCount,
    repoSkippedFileCount: repoResult.skippedFileCount,
    diffMode: diff.mode,
    diffChangedFileCount: diff.changedFiles.length,
    diffExistingChangedFileCount: diff.existingChangedFiles.length,
    diffFileChangeCount: diff.fileChanges.length,
    diffHunkCount: diff.hunkCount,
    diffAdditionCount: diff.additionCount,
    diffDeletionCount: diff.deletionCount,
    workspaceRepoFacts: cases[0]?.workspaceRepoFacts ?? emptyRepoSummary(),
    orchestrationDecisionCounts: countBy(cases.map((item) => item.orchestration.decision)),
    mergeDecisionCounts: countBy(cases.map((item) => item.merge.decision)),
    repairStatusCounts: countBy(cases.map((item) => item.repair.status)),
    finalDecisionCounts: countBy(cases.map((item) => item.repair.finalDecision)),
    remaskTriggeredCount: cases.filter((item) => item.orchestration.remaskTriggered).length,
    initialMergeSafeCount: cases.filter((item) => item.merge.mergeSafe).length,
    initialMergeUnsafeCount: cases.filter((item) => !item.merge.mergeSafe).length,
    repairAppliedCount: cases.filter((item) => item.repair.repairApplied).length,
    finalMergeSafeCount: cases.filter((item) => item.repair.finalMergeSafe).length,
    finalMergeUnsafeCount: cases.filter((item) => !item.repair.finalMergeSafe).length,
    secondPassApproveCount: cases.filter(
      (item) =>
        item.repair.secondPassVerifierDecision === "approve" &&
        item.repair.secondPassMergeDecision === "approve"
    ).length,
    totalInitialConflicts: conflicts.length,
    totalRemainingConflicts: cases.reduce(
      (sum, item) => sum + item.repair.remainingConflictCount,
      0
    ),
    conflictCountsByKind: countBy(conflicts),
    totalRepairActions: cases.reduce((sum, item) => sum + item.repair.actionCount, 0),
    totalEstimatedTokens,
    averageBudgetUtilization,
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
    mutatedRegions: [...new Set(mutatedRegions)]
  };
}

function reportToMarkdown(report: RealRepoEvaluationReport): string {
  const lines: string[] = [];

  lines.push(`# Real Repo Evaluation Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Diff mode: \`${report.aggregate.diffMode}\``);
  lines.push("");

  lines.push(`## Changed Files`);
  lines.push("");
  for (const file of report.changedFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");

  lines.push(`## Diff Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Raw diff bytes | ${report.diff.rawDiffBytes} |`);
  lines.push(`| Diff changed files | ${report.aggregate.diffChangedFileCount} |`);
  lines.push(`| Existing changed files | ${report.aggregate.diffExistingChangedFileCount} |`);
  lines.push(`| File changes | ${report.aggregate.diffFileChangeCount} |`);
  lines.push(`| Hunks | ${report.aggregate.diffHunkCount} |`);
  lines.push(`| Additions | ${report.aggregate.diffAdditionCount} |`);
  lines.push(`| Deletions | ${report.aggregate.diffDeletionCount} |`);
  lines.push("");

  lines.push(`## Repo Facts`);
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
  lines.push(`| Remask triggered | ${report.aggregate.remaskTriggeredCount} |`);
  lines.push(`| Initial merge safe | ${report.aggregate.initialMergeSafeCount} |`);
  lines.push(`| Initial merge unsafe | ${report.aggregate.initialMergeUnsafeCount} |`);
  lines.push(`| Repair applied | ${report.aggregate.repairAppliedCount} |`);
  lines.push(`| Final merge safe | ${report.aggregate.finalMergeSafeCount} |`);
  lines.push(`| Final merge unsafe | ${report.aggregate.finalMergeUnsafeCount} |`);
  lines.push(`| Second-pass approve | ${report.aggregate.secondPassApproveCount} |`);
  lines.push(`| Initial conflicts | ${report.aggregate.totalInitialConflicts} |`);
  lines.push(`| Remaining conflicts | ${report.aggregate.totalRemainingConflicts} |`);
  lines.push(`| Total repair actions | ${report.aggregate.totalRepairActions} |`);
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
    `| Case | Initial Decision | Merge Decision | Merge Safe | Repair Status | Final Decision | Final Safe | Conflicts | Remaining | Actions |`
  );
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.orchestration.decision} | ${item.merge.decision} | ${item.merge.mergeSafe} | ${item.repair.status} | ${item.repair.finalDecision} | ${item.repair.finalMergeSafe} | ${item.merge.conflictCount} | ${item.repair.remainingConflictCount} | ${item.repair.actionCount} |`
    );
  }

  lines.push("");

  if (report.diagnostics.length > 0) {
    lines.push(`## Diagnostics`);
    lines.push("");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${escapeMarkdownText(diagnostic)}`);
    }
    lines.push("");
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