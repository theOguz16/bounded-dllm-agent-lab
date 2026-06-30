import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aggregateBaselineComparison,
  compareBoundedVsDirect,
  createDirectBroadContextMockStrategy,
  runBaselineStrategy,
  type BaselineComparisonAggregate,
  type BaselineComparisonCase,
  type BaselineInputKind,
  type BoundedPipelineSummary
} from "../../../packages/baseline-core/src/index.js";
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
  createPrChangedFilesSummary,
  readPrChangedFilesInput,
  selectChangedFilesForPrEvaluation,
  type PrChangedFilesSummary
} from "../../../packages/repo-intelligence/src/pr-changed-files-adapter.js";
import { attachRepoIntelligenceToWorkspace } from "../../../packages/repo-intelligence/src/workspace-adapter.js";

type BaselineSource = {
  kind: BaselineInputKind;
  label: string;
  changedFiles: string[];
  repoResult: RepoIntelligenceResult;
};

type BaselineComparisonReport = {
  ok: true;
  reportName: string;
  createdAt: string;
  suiteName: string;
  realDiff: {
    mode: string;
    baseRef: string | null;
    headRef: string | null;
    diffFilePath: string | null;
    rawDiffBytes: number;
    changedFiles: string[];
    existingChangedFiles: string[];
    fileChangeCount: number;
    hunkCount: number;
    additionCount: number;
    deletionCount: number;
  };
  pr: {
    sourcePath: string | null;
    repo: string | null;
    prNumber: number | null;
    baseRef: string | null;
    headRef: string | null;
    title: string | null;
    changedFiles: string[];
    existingChangedFiles: string[];
    fileCount: number;
    additionCount: number;
    deletionCount: number;
    patchLineCount: number;
  };
  sources: Array<{
    kind: BaselineInputKind;
    label: string;
    changedFiles: string[];
    repo: {
      scannedFileCount: number;
      skippedFileCount: number;
      changedFileCount: number;
      ownershipCount: number;
      pairedFileCount: number;
      requiredTestCount: number;
      requiredTestMappingCount: number;
      moduleBoundaryCount: number;
      sensitivePatternCount: number;
      staleFactCount: number;
      diagnostics: string[];
    };
  }>;
  aggregate: BaselineComparisonAggregate;
  cases: BaselineComparisonCase[];
  diagnostics: string[];
};

const reportName = "baseline-comparison-report-v1";
const suiteName = "phase-k-model-free-bounded-vs-direct-baseline";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const reportDir = "reports/baseline-comparison";
const rootDir = process.cwd();
const prInputPath = process.env.PR_INPUT_FILE ?? "examples/real-repo-evaluation/github-pr-input.example.json";
const baselineStrategy = createDirectBroadContextMockStrategy();

const fallbackChangedFiles = [
  "apps/cli/src/real-repo-diff-smoke.ts",
  "apps/cli/src/real-repo-evaluation-report.ts",
  "apps/cli/src/real-repo-control-report.ts",
  "apps/cli/src/real-repo-safety-regression-report.ts",
  "apps/cli/src/real-repo-verify.ts",
  "apps/cli/src/pr-changed-files-smoke.ts",
  "apps/cli/src/pr-evaluation-report.ts",
  "apps/cli/src/baseline-comparison-report.ts",
  "packages/baseline-core/src/index.ts",
  "packages/repo-intelligence/src/git-diff-adapter.ts",
  "packages/repo-intelligence/src/pr-changed-files-adapter.ts",
  "examples/real-repo-evaluation/real-repo-evaluation-fixtures.json",
  "examples/real-repo-evaluation/github-pr-input.example.json",
  "package.json"
];

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before baseline comparison.",
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

  const realDiff = readGitDiff({
    rootDir,
    baseRef: process.env.GIT_BASE_REF,
    headRef: process.env.GIT_HEAD_REF,
    diffFilePath: process.env.GIT_DIFF_FILE,
    includeStaged: process.env.GIT_DIFF_STAGED === "1",
    includeUntracked: process.env.GIT_DIFF_INCLUDE_UNTRACKED !== "0"
  });

  diagnostics.push(...realDiff.diagnostics);

  const realDiffChangedFiles = selectChangedFilesForEvaluation({
    rootDir,
    diff: realDiff,
    envChangedFiles: parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES),
    fallbackChangedFiles,
    diagnostics
  });

  const realDiffRepo = await analyzeRepository({
    rootDir,
    changedFiles: realDiffChangedFiles,
    maxFiles: 1000
  });

  const prInput = readPrChangedFilesInput(prInputPath);
  const pr = createPrChangedFilesSummary({
    rootDir,
    sourcePath: prInputPath,
    prInput
  });

  diagnostics.push(...pr.diagnostics);

  const prChangedFiles = selectChangedFilesForPrEvaluation({
    pr,
    fallbackChangedFiles,
    diagnostics
  });

  const prRepo = await analyzeRepository({
    rootDir,
    changedFiles: prChangedFiles,
    maxFiles: 1000
  });

  const sources: BaselineSource[] = [
    {
      kind: "real_diff",
      label: "Current git working tree diff",
      changedFiles: realDiffChangedFiles,
      repoResult: realDiffRepo
    },
    {
      kind: "pr_input",
      label: "GitHub-style PR JSON input",
      changedFiles: prChangedFiles,
      repoResult: prRepo
    }
  ];

  const cases = sources.flatMap((source) =>
    remaskFixtures.map((fixture) =>
      createComparisonCase({
        source,
        fixture
      })
    )
  );

  const report = createReport({
    realDiff,
    pr,
    sources,
    cases,
    diagnostics: [...diagnostics, ...realDiffRepo.diagnostics, ...prRepo.diagnostics]
  });

  const jsonPath = join(reportDir, `${safeTimestamp}-baseline-comparison-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-baseline-comparison-report.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        suiteName,
        caseCount: report.aggregate.caseCount,
        sourceCount: report.aggregate.sourceCount,
        fixtureCount: report.aggregate.fixtureCount,
        boundedFinalSafeRate: report.aggregate.boundedFinalSafeRate,
        directFinalSafeRate: report.aggregate.directFinalSafeRate,
        boundedWinRate: report.aggregate.boundedWinRate,
        averageTokenSavingsRate: report.aggregate.averageTokenSavingsRate,
        averageDirectScopeExpansionFactor: report.aggregate.averageDirectScopeExpansionFactor,
        jsonPath,
        markdownPath,
        aggregate: report.aggregate
      },
      null,
      2
    )
  );
}

function createComparisonCase(input: {
  source: BaselineSource;
  fixture: BenchmarkFixture;
}): BaselineComparisonCase {
  const baseWorkspace = createWorkspaceFromPacket(input.fixture.packet, {
    id: `baseline-comparison-${input.source.kind}-${input.fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, input.source.repoResult);
  const orchestration = runMockOrchestrationFlow(workspace);
  const merge = evaluateConflictAwareMerge(orchestration);
  const repair = runMockRemaskRepairLoop({
    orchestration,
    merge
  });

  const bounded = summarizeBoundedPipeline({
    orchestration,
    merge,
    repair
  });

  const directResult = runBaselineStrategy({
    strategy: baselineStrategy,
    baselineInput: {
      changedFiles: input.source.changedFiles,
      scannedFileCount: input.source.repoResult.scannedFileCount,
      sensitivePatternCount: input.source.repoResult.facts.sensitivePatterns.length,
      staleFactCount: input.source.repoResult.facts.staleFacts.length,
      moduleBoundaryCount: input.source.repoResult.facts.moduleBoundaries.length,
      conflicts: merge.conflicts.map((conflict) => ({
        kind: conflict.kind
      })),
      bounded
    }
  });

  const direct = directResult.output;

  return {
    caseId: input.fixture.case.id,
    family: input.fixture.case.family,
    inputKind: input.source.kind,
    task: input.fixture.packet.task,
    expectedResult: input.fixture.case.expectedResult,
    changedFiles: input.source.changedFiles,
    workspaceRepoFacts: workspace.repoFacts,
    bounded,
    direct,
    comparison: compareBoundedVsDirect({
      bounded,
      direct
    })
  };
}

function summarizeBoundedPipeline(input: {
  orchestration: OrchestrationRunResult;
  merge: ConflictAwareMergeResult;
  repair: RemaskRepairLoopResult;
}): BoundedPipelineSummary {
  return {
    decision: input.orchestration.decision,
    mergeDecision: input.merge.decision,
    repairStatus: input.repair.status,
    finalDecision: input.repair.finalDecision,
    remaskTriggered: input.orchestration.remaskTriggered,
    initialMergeSafe: input.merge.mergeSafe,
    finalMergeSafe: input.repair.finalMergeSafe,
    repairApplied: input.repair.repairApplied,
    secondPassVerifierDecision: input.repair.secondPass.verifierDecision,
    secondPassMergeDecision: input.repair.secondPass.mergeDecision,
    initialConflictCount: input.merge.conflicts.length,
    remainingConflictCount: input.repair.remainingConflicts.length,
    repairActionCount: input.repair.actions.length,
    estimatedTokens: input.orchestration.tokenSummary.totalEstimatedTokens,
    maxEstimatedTokens: input.orchestration.tokenSummary.maxEstimatedTokens,
    averageBudgetUtilization: input.orchestration.tokenSummary.averageBudgetUtilization,
    totalMutations: input.orchestration.mutationSummary.totalMutations,
    appliedMutations: input.orchestration.mutationSummary.appliedMutations,
    blockedMutations: input.orchestration.mutationSummary.blockedMutations
  };
}

function createReport(input: {
  realDiff: GitDiffSummary;
  pr: PrChangedFilesSummary;
  sources: BaselineSource[];
  cases: BaselineComparisonCase[];
  diagnostics: string[];
}): BaselineComparisonReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName,
    realDiff: {
      mode: input.realDiff.mode,
      baseRef: input.realDiff.baseRef,
      headRef: input.realDiff.headRef,
      diffFilePath: input.realDiff.diffFilePath,
      rawDiffBytes: input.realDiff.rawDiffBytes,
      changedFiles: input.realDiff.changedFiles,
      existingChangedFiles: input.realDiff.existingChangedFiles,
      fileChangeCount: input.realDiff.fileChanges.length,
      hunkCount: input.realDiff.hunkCount,
      additionCount: input.realDiff.additionCount,
      deletionCount: input.realDiff.deletionCount
    },
    pr: {
      sourcePath: input.pr.sourcePath,
      repo: input.pr.repo,
      prNumber: input.pr.prNumber,
      baseRef: input.pr.baseRef,
      headRef: input.pr.headRef,
      title: input.pr.title,
      changedFiles: input.pr.changedFiles,
      existingChangedFiles: input.pr.existingChangedFiles,
      fileCount: input.pr.fileCount,
      additionCount: input.pr.additionCount,
      deletionCount: input.pr.deletionCount,
      patchLineCount: input.pr.patchLineCount
    },
    sources: input.sources.map((source) => ({
      kind: source.kind,
      label: source.label,
      changedFiles: source.changedFiles,
      repo: {
        scannedFileCount: source.repoResult.scannedFileCount,
        skippedFileCount: source.repoResult.skippedFileCount,
        changedFileCount: source.repoResult.facts.changedFiles.length,
        ownershipCount: source.repoResult.facts.ownership.length,
        pairedFileCount: source.repoResult.facts.pairedFiles.length,
        requiredTestCount: source.repoResult.facts.requiredTests.length,
        requiredTestMappingCount: source.repoResult.facts.requiredTestMappings.length,
        moduleBoundaryCount: source.repoResult.facts.moduleBoundaries.length,
        sensitivePatternCount: source.repoResult.facts.sensitivePatterns.length,
        staleFactCount: source.repoResult.facts.staleFacts.length,
        diagnostics: source.repoResult.diagnostics.slice(0, 20)
      }
    })),
    aggregate: aggregateBaselineComparison({
      cases: input.cases,
      sourceCount: input.sources.length,
      fixtureCount: remaskFixtures.length
    }),
    cases: input.cases,
    diagnostics: input.diagnostics.slice(0, 30)
  };
}

function reportToMarkdown(report: BaselineComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# Baseline Comparison Report`);
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Sources | ${report.aggregate.sourceCount} |`);
  lines.push(`| Fixtures | ${report.aggregate.fixtureCount} |`);
  lines.push(`| Bounded final safe rate | ${percent(report.aggregate.boundedFinalSafeRate)} |`);
  lines.push(`| Direct final safe rate | ${percent(report.aggregate.directFinalSafeRate)} |`);
  lines.push(`| Bounded win rate | ${percent(report.aggregate.boundedWinRate)} |`);
  lines.push(`| Direct win rate | ${percent(report.aggregate.directWinRate)} |`);
  lines.push(`| Tie rate | ${percent(report.aggregate.tieRate)} |`);
  lines.push(`| Bounded repair applied rate | ${percent(report.aggregate.boundedRepairAppliedRate)} |`);
  lines.push(`| Bounded second-pass approve rate | ${percent(report.aggregate.boundedSecondPassApproveRate)} |`);
  lines.push(`| Direct needs-review rate | ${percent(report.aggregate.directNeedsReviewRate)} |`);
  lines.push(`| Avg bounded estimated tokens | ${report.aggregate.averageBoundedEstimatedTokens} |`);
  lines.push(`| Avg direct estimated tokens | ${report.aggregate.averageDirectEstimatedTokens} |`);
  lines.push(`| Avg token savings rate | ${percent(report.aggregate.averageTokenSavingsRate)} |`);
  lines.push(`| Avg direct scope expansion | ${report.aggregate.averageDirectScopeExpansionFactor}x |`);
  lines.push(`| Initial conflicts | ${report.aggregate.totalInitialConflicts} |`);
  lines.push(`| Remaining conflicts bounded | ${report.aggregate.totalRemainingConflictsBounded} |`);
  lines.push(`| Bounded repair actions | ${report.aggregate.totalBoundedRepairActions} |`);
  lines.push("");

  lines.push(`## Sources`);
  lines.push("");
  lines.push(`| Source | Changed Files | Scanned Files | Ownership | Module Boundaries | Sensitive Patterns | Stale Facts |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const source of report.sources) {
    lines.push(
      `| ${escapeMarkdownCell(source.kind)} | ${source.repo.changedFileCount} | ${source.repo.scannedFileCount} | ${source.repo.ownershipCount} | ${source.repo.moduleBoundaryCount} | ${source.repo.sensitivePatternCount} | ${source.repo.staleFactCount} |`
    );
  }
  lines.push("");

  lines.push(`## Direct Baseline Failure Modes`);
  lines.push("");
  lines.push(`| Mode | Count |`);
  lines.push(`| --- | ---: |`);
  for (const [mode, count] of Object.entries(report.aggregate.directFailureModeCounts)) {
    lines.push(`| ${escapeMarkdownCell(mode)} | ${count} |`);
  }
  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(`| Input | Case | Bounded Final Safe | Direct Safe | Bounded Wins | Token Savings | Direct Scope | Direct Decision | Direct Failure Modes |`);
  lines.push(`| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |`);
  for (const item of report.cases) {
    lines.push(
      `| ${item.inputKind} | ${escapeMarkdownCell(item.caseId)} | ${passFail(item.comparison.boundedFinalSafe)} | ${passFail(item.comparison.directFinalSafe)} | ${passFail(item.comparison.boundedWinsSafety)} | ${percent(item.comparison.tokenSavingsRate)} | ${item.comparison.directScopeExpansionFactor}x | ${item.direct.decision} | ${escapeMarkdownCell(item.direct.expectedFailureModes.join(", ") || "(none)")} |`
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

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function passFail(value: 0 | 1): string {
  return value ? "pass" : "fail";
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}
