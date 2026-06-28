import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  runMockRemaskRepairLoop,
  type RemaskRepairLoopResult
} from "../../../packages/remask-repair-core/src/index.js";
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

const reportDir = "reports/remask-repair-runtime";
const reportName = "remask-repair-report-v1";
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

type InitialOrchestrationSummary = {
  flowId: string;
  decision: string;
  remaskTriggered: boolean;
  stepCount: number;
  tokenSummary: OrchestrationRunResult["tokenSummary"];
  mutationSummary: OrchestrationRunResult["mutationSummary"];
};

type InitialMergeSummary = {
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

type RepairSummary = {
  status: string;
  repairApplied: boolean;
  initialDecision: string;
  finalDecision: string;
  initialMergeSafe: boolean;
  finalMergeSafe: boolean;
  remaskTriggered: boolean;
  repairableConflictCount: number;
  unrepairedConflictCount: number;
  remainingConflictCount: number;
  actionCount: number;
  actions: RemaskRepairLoopResult["actions"];
  secondPass: RemaskRepairLoopResult["secondPass"];
  remainingConflicts: RemaskRepairLoopResult["remainingConflicts"];
  evidence: RemaskRepairLoopResult["evidence"];
};

type RemaskRepairCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  changedFiles: string[];
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  initialOrchestration: InitialOrchestrationSummary;
  initialMerge: InitialMergeSummary;
  repair: RepairSummary;
};

type RemaskRepairAggregate = {
  caseCount: number;
  roleCount: number;
  changedFiles: string[];

  repoScannedFileCount: number;
  repoSkippedFileCount: number;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;

  initialOrchestrationDecisionCounts: Record<string, number>;
  initialMergeDecisionCounts: Record<string, number>;
  repairStatusCounts: Record<string, number>;
  finalDecisionCounts: Record<string, number>;
  secondPassVerifierDecisionCounts: Record<string, number>;
  secondPassMergeDecisionCounts: Record<string, number>;

  initialRemaskRequiredCount: number;
  initialMergeUnsafeCount: number;
  initialMergeSafeCount: number;

  repairAppliedCount: number;
  repairBlockedCount: number;
  repairNotNeededCount: number;

  secondPassApproveCount: number;
  finalMergeSafeCount: number;
  finalMergeUnsafeCount: number;

  initialConflictCount: number;
  remainingConflictCount: number;
  initialConflictCountsByKind: Record<string, number>;
  remainingConflictCountsByKind: Record<string, number>;

  totalRepairActions: number;
  repairActionCountsByKind: Record<string, number>;

  totalEstimatedTokens: number;
  averageBudgetUtilization: number;
  maxEstimatedTokens: number;

  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
  mutatedRegions: string[];
};

type RemaskRepairReport = {
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
  aggregate: RemaskRepairAggregate;
  cases: RemaskRepairCaseReport[];
};

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before remask repair report.",
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

  const jsonPath = join(reportDir, `${safeTimestamp}-remask-repair-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-remask-repair-report.md`);

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
): RemaskRepairCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
    id: `remask-repair-report-${fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
  const orchestrationResult = runMockOrchestrationFlow(workspace);
  const mergeResult = evaluateConflictAwareMerge(orchestrationResult);
  const repairResult = runMockRemaskRepairLoop({
    orchestration: orchestrationResult,
    merge: mergeResult
  });

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,
    changedFiles,
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    initialOrchestration: summarizeInitialOrchestration(orchestrationResult),
    initialMerge: summarizeInitialMerge(mergeResult),
    repair: summarizeRepair(repairResult)
  };
}

function summarizeInitialOrchestration(
  result: OrchestrationRunResult
): InitialOrchestrationSummary {
  return {
    flowId: result.flowId,
    decision: result.decision,
    remaskTriggered: result.remaskTriggered,
    stepCount: result.steps.length,
    tokenSummary: result.tokenSummary,
    mutationSummary: result.mutationSummary
  };
}

function summarizeInitialMerge(result: ConflictAwareMergeResult): InitialMergeSummary {
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

function summarizeRepair(result: RemaskRepairLoopResult): RepairSummary {
  return {
    status: result.status,
    repairApplied: result.repairApplied,
    initialDecision: result.initialDecision,
    finalDecision: result.finalDecision,
    initialMergeSafe: result.initialMergeSafe,
    finalMergeSafe: result.finalMergeSafe,
    remaskTriggered: result.remaskTriggered,
    repairableConflictCount: result.repairableConflictCount,
    unrepairedConflictCount: result.unrepairedConflictCount,
    remainingConflictCount: result.remainingConflicts.length,
    actionCount: result.actions.length,
    actions: result.actions,
    secondPass: result.secondPass,
    remainingConflicts: result.remainingConflicts,
    evidence: result.evidence
  };
}

function createReport(
  repoResult: RepoIntelligenceResult,
  cases: RemaskRepairCaseReport[]
): RemaskRepairReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "changed-files-remask-repair-loop-fixtures-v1",
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
  cases: RemaskRepairCaseReport[]
): RemaskRepairAggregate {
  const initialConflicts = cases.flatMap((item) => item.initialMerge.conflicts);
  const remainingConflicts = cases.flatMap((item) => item.repair.remainingConflicts);
  const repairActions = cases.flatMap((item) => item.repair.actions);
  const mutatedRegions = cases.flatMap(
    (item) => item.initialOrchestration.mutationSummary.mutatedRegions
  );

  const totalEstimatedTokens = cases.reduce(
    (sum, item) => sum + item.initialOrchestration.tokenSummary.totalEstimatedTokens,
    0
  );

  const averageBudgetUtilization = roundRatio(
    cases.reduce(
      (sum, item) => sum + item.initialOrchestration.tokenSummary.averageBudgetUtilization,
      0
    ) / Math.max(cases.length, 1)
  );

  const firstWorkspaceRepoFacts = cases[0]?.workspaceRepoFacts ?? emptyRepoSummary();

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    changedFiles,

    repoScannedFileCount: repoResult.scannedFileCount,
    repoSkippedFileCount: repoResult.skippedFileCount,
    workspaceRepoFacts: firstWorkspaceRepoFacts,

    initialOrchestrationDecisionCounts: countBy(
      cases.map((item) => item.initialOrchestration.decision)
    ),
    initialMergeDecisionCounts: countBy(
      cases.map((item) => item.initialMerge.decision)
    ),
    repairStatusCounts: countBy(cases.map((item) => item.repair.status)),
    finalDecisionCounts: countBy(cases.map((item) => item.repair.finalDecision)),
    secondPassVerifierDecisionCounts: countBy(
      cases.map((item) => item.repair.secondPass.verifierDecision)
    ),
    secondPassMergeDecisionCounts: countBy(
      cases.map((item) => item.repair.secondPass.mergeDecision)
    ),

    initialRemaskRequiredCount: cases.filter(
      (item) => item.initialOrchestration.decision === "remask_required"
    ).length,
    initialMergeUnsafeCount: cases.filter((item) => !item.initialMerge.mergeSafe).length,
    initialMergeSafeCount: cases.filter((item) => item.initialMerge.mergeSafe).length,

    repairAppliedCount: cases.filter((item) => item.repair.repairApplied).length,
    repairBlockedCount: cases.filter((item) => item.repair.status === "blocked").length,
    repairNotNeededCount: cases.filter((item) => item.repair.status === "not_needed").length,

    secondPassApproveCount: cases.filter(
      (item) =>
        item.repair.secondPass.verifierDecision === "approve" &&
        item.repair.secondPass.mergeDecision === "approve"
    ).length,
    finalMergeSafeCount: cases.filter((item) => item.repair.finalMergeSafe).length,
    finalMergeUnsafeCount: cases.filter((item) => !item.repair.finalMergeSafe).length,

    initialConflictCount: initialConflicts.length,
    remainingConflictCount: remainingConflicts.length,
    initialConflictCountsByKind: countBy(initialConflicts.map((conflict) => conflict.kind)),
    remainingConflictCountsByKind: countBy(
      remainingConflicts.map((conflict) => conflict.kind)
    ),

    totalRepairActions: repairActions.length,
    repairActionCountsByKind: countBy(repairActions.map((action) => action.kind)),

    totalEstimatedTokens,
    averageBudgetUtilization,
    maxEstimatedTokens: Math.max(
      0,
      ...cases.map((item) => item.initialOrchestration.tokenSummary.maxEstimatedTokens)
    ),

    totalMutations: cases.reduce(
      (sum, item) => sum + item.initialOrchestration.mutationSummary.totalMutations,
      0
    ),
    appliedMutations: cases.reduce(
      (sum, item) => sum + item.initialOrchestration.mutationSummary.appliedMutations,
      0
    ),
    blockedMutations: cases.reduce(
      (sum, item) => sum + item.initialOrchestration.mutationSummary.blockedMutations,
      0
    ),
    mutatedRegions: [...new Set(mutatedRegions)]
  };
}

function reportToMarkdown(report: RemaskRepairReport): string {
  const lines: string[] = [];

  lines.push(`# Remask Repair Report`);
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
  lines.push(`| Initial remask required | ${report.aggregate.initialRemaskRequiredCount} |`);
  lines.push(`| Initial merge unsafe | ${report.aggregate.initialMergeUnsafeCount} |`);
  lines.push(`| Repair applied | ${report.aggregate.repairAppliedCount} |`);
  lines.push(`| Repair blocked | ${report.aggregate.repairBlockedCount} |`);
  lines.push(`| Repair not needed | ${report.aggregate.repairNotNeededCount} |`);
  lines.push(`| Second-pass approve | ${report.aggregate.secondPassApproveCount} |`);
  lines.push(`| Final merge safe | ${report.aggregate.finalMergeSafeCount} |`);
  lines.push(`| Final merge unsafe | ${report.aggregate.finalMergeUnsafeCount} |`);
  lines.push(`| Initial conflicts | ${report.aggregate.initialConflictCount} |`);
  lines.push(`| Remaining conflicts | ${report.aggregate.remainingConflictCount} |`);
  lines.push(`| Total repair actions | ${report.aggregate.totalRepairActions} |`);
  lines.push(`| Total estimated tokens | ${report.aggregate.totalEstimatedTokens} |`);
  lines.push(`| Max estimated tokens | ${report.aggregate.maxEstimatedTokens} |`);
  lines.push(`| Avg budget utilization | ${report.aggregate.averageBudgetUtilization} |`);
  lines.push(`| Total mutations | ${report.aggregate.totalMutations} |`);
  lines.push(`| Applied mutations | ${report.aggregate.appliedMutations} |`);
  lines.push(`| Blocked mutations | ${report.aggregate.blockedMutations} |`);
  lines.push("");

  lines.push(`### Initial Orchestration Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.initialOrchestrationDecisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Repair Status`);
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [status, count] of Object.entries(report.aggregate.repairStatusCounts)) {
    lines.push(`| ${escapeMarkdownCell(status)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Final Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.finalDecisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Initial Conflict Counts`);
  lines.push("");
  lines.push(`| Conflict Kind | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [kind, count] of Object.entries(report.aggregate.initialConflictCountsByKind)) {
    lines.push(`| ${escapeMarkdownCell(kind)} | ${count} |`);
  }

  lines.push("");

  lines.push(`### Repair Action Counts`);
  lines.push("");
  lines.push(`| Action Kind | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [kind, count] of Object.entries(report.aggregate.repairActionCountsByKind)) {
    lines.push(`| ${escapeMarkdownCell(kind)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(
    `| Case | Initial Decision | Initial Merge Safe | Repair Status | Final Decision | Final Merge Safe | Initial Conflicts | Remaining Conflicts | Actions |`
  );
  lines.push(`| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.initialOrchestration.decision} | ${item.initialMerge.mergeSafe} | ${item.repair.status} | ${item.repair.finalDecision} | ${item.repair.finalMergeSafe} | ${item.initialMerge.conflictCount} | ${item.repair.remainingConflictCount} | ${item.repair.actionCount} |`
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

    lines.push(`### Initial Merge Conflicts`);
    lines.push("");

    if (item.initialMerge.conflicts.length === 0) {
      lines.push(`No initial conflicts.`);
      lines.push("");
    } else {
      lines.push(`| Kind | Severity | Suggested Decision | Evidence IDs | Message |`);
      lines.push(`| --- | --- | --- | --- | --- |`);

      for (const conflict of item.initialMerge.conflicts) {
        lines.push(
          `| ${conflict.kind} | ${conflict.severity} | ${conflict.suggestedDecision} | ${escapeMarkdownCell(conflict.evidenceIds.join(", "))} | ${escapeMarkdownCell(conflict.message)} |`
        );
      }

      lines.push("");
    }

    lines.push(`### Repair Actions`);
    lines.push("");

    if (item.repair.actions.length === 0) {
      lines.push(`No repair actions.`);
      lines.push("");
    } else {
      lines.push(`| Kind | Summary | Evidence IDs | Reason |`);
      lines.push(`| --- | --- | --- | --- |`);

      for (const action of item.repair.actions) {
        lines.push(
          `| ${action.kind} | ${escapeMarkdownCell(action.summary)} | ${escapeMarkdownCell(action.evidenceIds.join(", "))} | ${escapeMarkdownCell(action.reason)} |`
        );
      }

      lines.push("");
    }

    lines.push(`### Second Pass`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Verifier decision | ${item.repair.secondPass.verifierDecision} |`);
    lines.push(`| Merge decision | ${item.repair.secondPass.mergeDecision} |`);
    lines.push(`| Merge safe | ${item.repair.secondPass.mergeSafe} |`);
    lines.push(`| Remaining conflicts | ${item.repair.remainingConflictCount} |`);
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