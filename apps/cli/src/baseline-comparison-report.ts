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
  createPrChangedFilesSummary,
  readPrChangedFilesInput,
  selectChangedFilesForPrEvaluation,
  type PrChangedFilesSummary
} from "../../../packages/repo-intelligence/src/pr-changed-files-adapter.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts,
  type RepoIntelligenceWorkspaceSummary
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";

type BaselineInputKind = "real_diff" | "pr_input";

type BaselineSource = {
  kind: BaselineInputKind;
  label: string;
  changedFiles: string[];
  repoResult: RepoIntelligenceResult;
};

type BoundedPipelineSummary = {
  decision: string;
  mergeDecision: string;
  repairStatus: string;
  finalDecision: string;
  remaskTriggered: boolean;
  initialMergeSafe: boolean;
  finalMergeSafe: boolean;
  repairApplied: boolean;
  secondPassVerifierDecision: string;
  secondPassMergeDecision: string;
  initialConflictCount: number;
  remainingConflictCount: number;
  repairActionCount: number;
  estimatedTokens: number;
  maxEstimatedTokens: number;
  averageBudgetUtilization: number;
  totalMutations: number;
  appliedMutations: number;
  blockedMutations: number;
};

type DirectBaselineSummary = {
  strategy: "direct_broad_context_mock";
  decision: "approve" | "needs_review";
  mergeSafe: boolean;
  repairApplied: false;
  secondPassVerifier: false;
  estimatedTokens: number;
  touchedFileCount: number;
  scopeExpansionFactor: number;
  conflictRiskScore: number;
  safetyRiskScore: number;
  expectedFailureModes: string[];
  verifierMode: "single_pass_mock";
  repairMode: "none";
};

type BaselineComparisonCase = {
  caseId: string;
  family: string;
  inputKind: BaselineInputKind;
  task: string;
  expectedResult: string;
  changedFiles: string[];
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  bounded: BoundedPipelineSummary;
  direct: DirectBaselineSummary;
  comparison: {
    boundedFinalSafe: 0 | 1;
    directFinalSafe: 0 | 1;
    boundedWinsSafety: 0 | 1;
    directWinsSafety: 0 | 1;
    tieSafety: 0 | 1;
    tokenSavingsRate: number;
    directScopeExpansionFactor: number;
    boundedRepairLift: 0 | 1;
    secondPassLift: 0 | 1;
  };
};

type BaselineComparisonAggregate = {
  caseCount: number;
  sourceCount: number;
  fixtureCount: number;
  realDiffCaseCount: number;
  prInputCaseCount: number;
  boundedFinalSafeRate: number;
  directFinalSafeRate: number;
  boundedWinRate: number;
  directWinRate: number;
  tieRate: number;
  boundedRepairAppliedRate: number;
  boundedSecondPassApproveRate: number;
  directNeedsReviewRate: number;
  averageBoundedEstimatedTokens: number;
  averageDirectEstimatedTokens: number;
  averageTokenSavingsRate: number;
  averageDirectScopeExpansionFactor: number;
  totalInitialConflicts: number;
  totalRemainingConflictsBounded: number;
  totalBoundedRepairActions: number;
  totalBoundedMutations: number;
  totalBoundedBlockedMutations: number;
  directFailureModeCounts: Record<string, number>;
  boundedDecisionCounts: Record<string, number>;
  boundedFinalDecisionCounts: Record<string, number>;
  directDecisionCounts: Record<string, number>;
  conflictCountsByKind: Record<string, number>;
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

const fallbackChangedFiles = [
  "apps/cli/src/real-repo-diff-smoke.ts",
  "apps/cli/src/real-repo-evaluation-report.ts",
  "apps/cli/src/real-repo-control-report.ts",
  "apps/cli/src/real-repo-safety-regression-report.ts",
  "apps/cli/src/real-repo-verify.ts",
  "apps/cli/src/pr-changed-files-smoke.ts",
  "apps/cli/src/pr-evaluation-report.ts",
  "apps/cli/src/baseline-comparison-report.ts",
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

  const direct = createDirectBaseline({
    source: input.source,
    fixture: input.fixture,
    merge,
    bounded
  });

  return {
    caseId: input.fixture.case.id,
    family: input.fixture.case.family,
    inputKind: input.source.kind,
    task: input.fixture.packet.task,
    expectedResult: input.fixture.case.expectedResult,
    changedFiles: input.source.changedFiles,
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    bounded,
    direct,
    comparison: comparePipelines({
      bounded,
      direct,
      changedFileCount: input.source.changedFiles.length
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

function createDirectBaseline(input: {
  source: BaselineSource;
  fixture: BenchmarkFixture;
  merge: ConflictAwareMergeResult;
  bounded: BoundedPipelineSummary;
}): DirectBaselineSummary {
  const changedFileCount = Math.max(input.source.changedFiles.length, 1);
  const scannedFileCount = Math.max(input.source.repoResult.scannedFileCount, changedFileCount);
  const sensitivePatternCount = input.source.repoResult.facts.sensitivePatterns.length;
  const staleFactCount = input.source.repoResult.facts.staleFacts.length;
  const moduleBoundaryCount = input.source.repoResult.facts.moduleBoundaries.length;

  const touchedFileCount = Math.min(
    scannedFileCount,
    Math.max(changedFileCount + 3, Math.ceil(changedFileCount * 3))
  );

  const scopeExpansionFactor = roundRatio(touchedFileCount / changedFileCount);
  const conflictRiskScore = roundRatio(Math.min(1, input.merge.conflicts.length / 2));
  const safetyRiskScore = roundRatio(
    Math.min(
      1,
      sensitivePatternCount * 0.02 +
        staleFactCount * 0.08 +
        moduleBoundaryCount * 0.04 +
        scopeExpansionFactor * 0.08
    )
  );

  const expectedFailureModes = deriveDirectFailureModes({
    merge: input.merge,
    scopeExpansionFactor,
    safetyRiskScore,
    staleFactCount,
    sensitivePatternCount
  });

  const mergeSafe = expectedFailureModes.length === 0;
  const decision = mergeSafe ? "approve" : "needs_review";

  const estimatedTokens = Math.round(
    input.bounded.estimatedTokens * (1.7 + Math.min(scopeExpansionFactor, 6) * 0.18) +
      scannedFileCount * 9 +
      sensitivePatternCount * 12 +
      staleFactCount * 35
  );

  return {
    strategy: "direct_broad_context_mock",
    decision,
    mergeSafe,
    repairApplied: false,
    secondPassVerifier: false,
    estimatedTokens,
    touchedFileCount,
    scopeExpansionFactor,
    conflictRiskScore,
    safetyRiskScore,
    expectedFailureModes,
    verifierMode: "single_pass_mock",
    repairMode: "none"
  };
}

function deriveDirectFailureModes(input: {
  merge: ConflictAwareMergeResult;
  scopeExpansionFactor: number;
  safetyRiskScore: number;
  staleFactCount: number;
  sensitivePatternCount: number;
}): string[] {
  const modes: string[] = [];

  for (const conflict of input.merge.conflicts) {
    modes.push(conflict.kind);
  }

  if (input.scopeExpansionFactor >= 2) {
    modes.push("scope_broadening_risk");
  }

  if (input.staleFactCount > 0) {
    modes.push("stale_repo_fact_risk");
  }

  if (input.sensitivePatternCount > 0 && input.safetyRiskScore >= 0.25) {
    modes.push("sensitive_pattern_risk");
  }

  if (input.merge.conflicts.length > 0) {
    modes.push("no_remask_repair");
  }

  return uniqueSorted(modes);
}

function comparePipelines(input: {
  bounded: BoundedPipelineSummary;
  direct: DirectBaselineSummary;
  changedFileCount: number;
}): BaselineComparisonCase["comparison"] {
  const boundedFinalSafe = binary(input.bounded.finalMergeSafe);
  const directFinalSafe = binary(input.direct.mergeSafe);

  return {
    boundedFinalSafe,
    directFinalSafe,
    boundedWinsSafety: binary(boundedFinalSafe === 1 && directFinalSafe === 0),
    directWinsSafety: binary(boundedFinalSafe === 0 && directFinalSafe === 1),
    tieSafety: binary(boundedFinalSafe === directFinalSafe),
    tokenSavingsRate: roundRatio(
      input.direct.estimatedTokens <= 0
        ? 0
        : 1 - input.bounded.estimatedTokens / input.direct.estimatedTokens
    ),
    directScopeExpansionFactor: input.direct.scopeExpansionFactor,
    boundedRepairLift: binary(input.bounded.repairApplied && input.bounded.finalMergeSafe),
    secondPassLift: binary(
      input.bounded.secondPassVerifierDecision === "approve" &&
        input.bounded.secondPassMergeDecision === "approve"
    )
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
    aggregate: aggregateCases(input.sources, input.cases),
    cases: input.cases,
    diagnostics: input.diagnostics.slice(0, 30)
  };
}

function aggregateCases(
  sources: BaselineSource[],
  cases: BaselineComparisonCase[]
): BaselineComparisonAggregate {
  const directFailureModes = cases.flatMap((item) => item.direct.expectedFailureModes);
  const conflictKinds = cases.flatMap((item) => item.direct.expectedFailureModes).filter((mode) =>
    mode === "stale_authority" || mode === "remask_unresolved"
  );

  return {
    caseCount: cases.length,
    sourceCount: sources.length,
    fixtureCount: remaskFixtures.length,
    realDiffCaseCount: cases.filter((item) => item.inputKind === "real_diff").length,
    prInputCaseCount: cases.filter((item) => item.inputKind === "pr_input").length,
    boundedFinalSafeRate: average(cases.map((item) => item.comparison.boundedFinalSafe)),
    directFinalSafeRate: average(cases.map((item) => item.comparison.directFinalSafe)),
    boundedWinRate: average(cases.map((item) => item.comparison.boundedWinsSafety)),
    directWinRate: average(cases.map((item) => item.comparison.directWinsSafety)),
    tieRate: average(cases.map((item) => item.comparison.tieSafety)),
    boundedRepairAppliedRate: average(cases.map((item) => binary(item.bounded.repairApplied))),
    boundedSecondPassApproveRate: average(cases.map((item) => item.comparison.secondPassLift)),
    directNeedsReviewRate: average(cases.map((item) => binary(item.direct.decision === "needs_review"))),
    averageBoundedEstimatedTokens: average(cases.map((item) => item.bounded.estimatedTokens)),
    averageDirectEstimatedTokens: average(cases.map((item) => item.direct.estimatedTokens)),
    averageTokenSavingsRate: average(cases.map((item) => item.comparison.tokenSavingsRate)),
    averageDirectScopeExpansionFactor: average(cases.map((item) => item.comparison.directScopeExpansionFactor)),
    totalInitialConflicts: cases.reduce((sum, item) => sum + item.bounded.initialConflictCount, 0),
    totalRemainingConflictsBounded: cases.reduce((sum, item) => sum + item.bounded.remainingConflictCount, 0),
    totalBoundedRepairActions: cases.reduce((sum, item) => sum + item.bounded.repairActionCount, 0),
    totalBoundedMutations: cases.reduce((sum, item) => sum + item.bounded.totalMutations, 0),
    totalBoundedBlockedMutations: cases.reduce((sum, item) => sum + item.bounded.blockedMutations, 0),
    directFailureModeCounts: countBy(directFailureModes),
    boundedDecisionCounts: countBy(cases.map((item) => item.bounded.decision)),
    boundedFinalDecisionCounts: countBy(cases.map((item) => item.bounded.finalDecision)),
    directDecisionCounts: countBy(cases.map((item) => item.direct.decision)),
    conflictCountsByKind: countBy(conflictKinds)
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

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function binary(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return roundRatio(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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
