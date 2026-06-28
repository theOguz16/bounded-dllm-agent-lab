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
  WorkspaceDecision,
  WorkspaceRole
} from "../../../packages/workspace-core/src/index.js";

type MergeConflict = ConflictAwareMergeResult["conflicts"][number];

type SafetyScenarioId =
  | "sensitive-boundary-blocks-repair"
  | "permission-violation-blocks-repair"
  | "verifier-rejection-blocks-repair"
  | "blocked-mutation-blocks-repair";

type SafetyScenarioReport = {
  id: SafetyScenarioId;
  description: string;
  expectedFinalDecision: WorkspaceDecision;
  input: {
    orchestrationDecision: string;
    remaskTriggered: boolean;
    blockedMutations: number;
    mergeDecision: string;
    mergeSafe: boolean;
    conflictKinds: string[];
  };
  repair: {
    status: string;
    repairApplied: boolean;
    initialDecision: string;
    finalDecision: string;
    initialMergeSafe: boolean;
    finalMergeSafe: boolean;
    repairableConflictCount: number;
    unrepairedConflictCount: number;
    remainingConflictCount: number;
    actionCount: number;
    secondPassVerifierDecision: string;
    secondPassMergeDecision: string;
    secondPassMergeSafe: boolean;
    remainingConflictKinds: string[];
  };
  passed: boolean;
};

type BaselineSafetyReport = {
  orchestration: {
    decision: string;
    remaskTriggered: boolean;
    blockedMutations: number;
    totalMutations: number;
    appliedMutations: number;
  };
  merge: {
    decision: string;
    mergeSafe: boolean;
    conflictCount: number;
    conflictKinds: string[];
  };
  repair: {
    status: string;
    repairApplied: boolean;
    finalDecision: string;
    finalMergeSafe: boolean;
    remainingConflictCount: number;
    actionCount: number;
  };
  passed: boolean;
};

type RemaskRepairSafetyCaseReport = {
  caseId: string;
  family: string;
  task: string;
  expectedResult: string;
  workspaceId: string;
  changedFiles: string[];
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;
  baseline: BaselineSafetyReport;
  safetyScenarios: SafetyScenarioReport[];
};

type RemaskRepairSafetyAggregate = {
  caseCount: number;
  roleCount: number;
  changedFiles: string[];

  repoScannedFileCount: number;
  repoSkippedFileCount: number;
  workspaceRepoFacts: RepoIntelligenceWorkspaceSummary;

  baselinePassedCount: number;
  baselineFailedCount: number;
  baselineRepairAppliedCount: number;
  baselineFinalMergeSafeCount: number;

  safetyScenarioCount: number;
  safetyScenarioPassedCount: number;
  safetyScenarioFailedCount: number;

  safetyBlockedCount: number;
  safetyRepairAppliedCount: number;
  safetyFinalMergeSafeCount: number;
  safetyRemainingConflictCount: number;

  safetyScenarioCountsById: Record<string, number>;
  safetyStatusCounts: Record<string, number>;
  safetyFinalDecisionCounts: Record<string, number>;
  safetyConflictCountsByKind: Record<string, number>;

  totalBaselineMutations: number;
  totalBaselineAppliedMutations: number;
  totalBaselineBlockedMutations: number;

  overallPassed: boolean;
};

type RemaskRepairSafetyReport = {
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
  aggregate: RemaskRepairSafetyAggregate;
  cases: RemaskRepairSafetyCaseReport[];
};

type SafetyScenarioInput = {
  id: SafetyScenarioId;
  description: string;
  orchestration: OrchestrationRunResult;
  merge: ConflictAwareMergeResult;
  expectedFinalDecision: WorkspaceDecision;
};

const reportDir = "reports/remask-repair-runtime";
const reportName = "remask-repair-safety-report-v1";
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

const defaultChangedFiles = [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const changedFiles =
  parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? defaultChangedFiles;

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before remask repair safety report.",
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

  const failures = validateReport(report);

  if (failures.length) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Remask repair safety report failed validation.",
          failures,
          aggregate: report.aggregate
        },
        null,
        2
      )
    );
  }

  const jsonPath = join(reportDir, `${safeTimestamp}-remask-repair-safety-report.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-remask-repair-safety-report.md`);

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
): RemaskRepairSafetyCaseReport {
  const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
    id: `remask-repair-safety-report-${fixture.case.id}`
  });

  const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
  const orchestrationResult = runMockOrchestrationFlow(workspace);
  const mergeResult = evaluateConflictAwareMerge(orchestrationResult);
  const baselineRepair = runMockRemaskRepairLoop({
    orchestration: orchestrationResult,
    merge: mergeResult
  });

  const baseConflict = mergeResult.conflicts[0];

  if (!baseConflict) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          reason: "Expected baseline merge to contain at least one conflict for safety report.",
          caseId: fixture.case.id,
          mergeDecision: mergeResult.decision,
          mergeSafe: mergeResult.mergeSafe
        },
        null,
        2
      )
    );
  }

  const safetyInputs = createSafetyScenarioInputs(
    orchestrationResult,
    mergeResult,
    baseConflict
  );

  const safetyScenarios = safetyInputs.map((input) => {
    const repair = runMockRemaskRepairLoop({
      orchestration: input.orchestration,
      merge: input.merge
    });

    return summarizeSafetyScenario(input, repair);
  });

  return {
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    workspaceId: workspace.id,
    changedFiles,
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    baseline: summarizeBaseline(orchestrationResult, mergeResult, baselineRepair),
    safetyScenarios
  };
}

function createSafetyScenarioInputs(
  orchestrationResult: OrchestrationRunResult,
  mergeResult: ConflictAwareMergeResult,
  baseConflict: MergeConflict
): SafetyScenarioInput[] {
  return [
    {
      id: "sensitive-boundary-blocks-repair",
      description: "Sensitive boundary conflict must not be auto-repaired.",
      orchestration: orchestrationResult,
      merge: createMergeVariant(mergeResult, {
        decision: "reject",
        conflict: createConflict(baseConflict, {
          kind: "sensitive_boundary",
          severity: "error",
          suggestedDecision: "reject",
          sourceStepIds: ["verifier"],
          evidenceIds: ["synthetic-sensitive-boundary"],
          message: "Synthetic sensitive boundary violation must block remask repair."
        }),
        requiredActions: [
          "Require human review because sensitive boundary conflict is not locally repairable."
        ]
      }),
      expectedFinalDecision: "reject"
    },
    {
      id: "permission-violation-blocks-repair",
      description: "Permission violation conflict must not be auto-repaired.",
      orchestration: orchestrationResult,
      merge: createMergeVariant(mergeResult, {
        decision: "human_review_required",
        conflict: createConflict(baseConflict, {
          kind: "permission_violation",
          severity: "error",
          suggestedDecision: "human_review_required",
          sourceStepIds: ["merge"],
          evidenceIds: ["synthetic-permission-violation"],
          message: "Synthetic permission violation must require human review."
        }),
        requiredActions: [
          "Require human review because permission violation is not locally repairable."
        ]
      }),
      expectedFinalDecision: "human_review_required"
    },
    {
      id: "verifier-rejection-blocks-repair",
      description: "Verifier rejection conflict must not be auto-repaired.",
      orchestration: orchestrationResult,
      merge: createMergeVariant(mergeResult, {
        decision: "reject",
        conflict: createConflict(baseConflict, {
          kind: "verifier_rejection",
          severity: "error",
          suggestedDecision: "reject",
          sourceStepIds: ["verifier"],
          evidenceIds: ["synthetic-verifier-rejection"],
          message: "Synthetic verifier rejection must block repair approval."
        }),
        requiredActions: [
          "Reject because verifier rejection is not a bounded local remask repair."
        ]
      }),
      expectedFinalDecision: "reject"
    },
    {
      id: "blocked-mutation-blocks-repair",
      description: "Blocked mutation must prevent repair approval even with repairable conflicts.",
      orchestration: createBlockedMutationOrchestration(orchestrationResult),
      merge: mergeResult,
      expectedFinalDecision: "remask_required"
    }
  ];
}

function summarizeBaseline(
  orchestrationResult: OrchestrationRunResult,
  mergeResult: ConflictAwareMergeResult,
  repairResult: RemaskRepairLoopResult
): BaselineSafetyReport {
  const passed =
    orchestrationResult.decision === "remask_required" &&
    orchestrationResult.remaskTriggered &&
    orchestrationResult.mutationSummary.blockedMutations === 0 &&
    mergeResult.decision === "remask_required" &&
    !mergeResult.mergeSafe &&
    repairResult.status === "repaired" &&
    repairResult.repairApplied &&
    repairResult.finalDecision === "approve" &&
    repairResult.finalMergeSafe &&
    repairResult.remainingConflicts.length === 0;

  return {
    orchestration: {
      decision: orchestrationResult.decision,
      remaskTriggered: orchestrationResult.remaskTriggered,
      blockedMutations: orchestrationResult.mutationSummary.blockedMutations,
      totalMutations: orchestrationResult.mutationSummary.totalMutations,
      appliedMutations: orchestrationResult.mutationSummary.appliedMutations
    },
    merge: {
      decision: mergeResult.decision,
      mergeSafe: mergeResult.mergeSafe,
      conflictCount: mergeResult.conflicts.length,
      conflictKinds: mergeResult.conflicts.map((conflict) => conflict.kind)
    },
    repair: {
      status: repairResult.status,
      repairApplied: repairResult.repairApplied,
      finalDecision: repairResult.finalDecision,
      finalMergeSafe: repairResult.finalMergeSafe,
      remainingConflictCount: repairResult.remainingConflicts.length,
      actionCount: repairResult.actions.length
    },
    passed
  };
}

function summarizeSafetyScenario(
  input: SafetyScenarioInput,
  repair: RemaskRepairLoopResult
): SafetyScenarioReport {
  const passed =
    repair.status === "blocked" &&
    !repair.repairApplied &&
    repair.finalDecision === input.expectedFinalDecision &&
    !repair.finalMergeSafe &&
    !repair.secondPass.mergeSafe &&
    repair.actions.length === 0 &&
    repair.remainingConflicts.length > 0;

  return {
    id: input.id,
    description: input.description,
    expectedFinalDecision: input.expectedFinalDecision,
    input: {
      orchestrationDecision: input.orchestration.decision,
      remaskTriggered: input.orchestration.remaskTriggered,
      blockedMutations: input.orchestration.mutationSummary.blockedMutations,
      mergeDecision: input.merge.decision,
      mergeSafe: input.merge.mergeSafe,
      conflictKinds: input.merge.conflicts.map((conflict) => conflict.kind)
    },
    repair: {
      status: repair.status,
      repairApplied: repair.repairApplied,
      initialDecision: repair.initialDecision,
      finalDecision: repair.finalDecision,
      initialMergeSafe: repair.initialMergeSafe,
      finalMergeSafe: repair.finalMergeSafe,
      repairableConflictCount: repair.repairableConflictCount,
      unrepairedConflictCount: repair.unrepairedConflictCount,
      remainingConflictCount: repair.remainingConflicts.length,
      actionCount: repair.actions.length,
      secondPassVerifierDecision: repair.secondPass.verifierDecision,
      secondPassMergeDecision: repair.secondPass.mergeDecision,
      secondPassMergeSafe: repair.secondPass.mergeSafe,
      remainingConflictKinds: repair.remainingConflicts.map((conflict) => conflict.kind)
    },
    passed
  };
}

function createReport(
  repoResult: RepoIntelligenceResult,
  cases: RemaskRepairSafetyCaseReport[]
): RemaskRepairSafetyReport {
  return {
    ok: true,
    reportName,
    createdAt,
    suiteName: "changed-files-remask-repair-safety-fixtures-v1",
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
  cases: RemaskRepairSafetyCaseReport[]
): RemaskRepairSafetyAggregate {
  const safetyScenarios = cases.flatMap((item) => item.safetyScenarios);
  const safetyConflictKinds = safetyScenarios.flatMap(
    (item) => item.input.conflictKinds
  );

  const firstWorkspaceRepoFacts = cases[0]?.workspaceRepoFacts ?? emptyRepoSummary();

  return {
    caseCount: cases.length,
    roleCount: roles.length,
    changedFiles,

    repoScannedFileCount: repoResult.scannedFileCount,
    repoSkippedFileCount: repoResult.skippedFileCount,
    workspaceRepoFacts: firstWorkspaceRepoFacts,

    baselinePassedCount: cases.filter((item) => item.baseline.passed).length,
    baselineFailedCount: cases.filter((item) => !item.baseline.passed).length,
    baselineRepairAppliedCount: cases.filter(
      (item) => item.baseline.repair.repairApplied
    ).length,
    baselineFinalMergeSafeCount: cases.filter(
      (item) => item.baseline.repair.finalMergeSafe
    ).length,

    safetyScenarioCount: safetyScenarios.length,
    safetyScenarioPassedCount: safetyScenarios.filter((item) => item.passed).length,
    safetyScenarioFailedCount: safetyScenarios.filter((item) => !item.passed).length,

    safetyBlockedCount: safetyScenarios.filter(
      (item) => item.repair.status === "blocked"
    ).length,
    safetyRepairAppliedCount: safetyScenarios.filter(
      (item) => item.repair.repairApplied
    ).length,
    safetyFinalMergeSafeCount: safetyScenarios.filter(
      (item) => item.repair.finalMergeSafe
    ).length,
    safetyRemainingConflictCount: safetyScenarios.reduce(
      (sum, item) => sum + item.repair.remainingConflictCount,
      0
    ),

    safetyScenarioCountsById: countBy(safetyScenarios.map((item) => item.id)),
    safetyStatusCounts: countBy(safetyScenarios.map((item) => item.repair.status)),
    safetyFinalDecisionCounts: countBy(
      safetyScenarios.map((item) => item.repair.finalDecision)
    ),
    safetyConflictCountsByKind: countBy(safetyConflictKinds),

    totalBaselineMutations: cases.reduce(
      (sum, item) => sum + item.baseline.orchestration.totalMutations,
      0
    ),
    totalBaselineAppliedMutations: cases.reduce(
      (sum, item) => sum + item.baseline.orchestration.appliedMutations,
      0
    ),
    totalBaselineBlockedMutations: cases.reduce(
      (sum, item) => sum + item.baseline.orchestration.blockedMutations,
      0
    ),

    overallPassed:
      cases.every((item) => item.baseline.passed) &&
      safetyScenarios.every((item) => item.passed)
  };
}

function validateReport(report: RemaskRepairSafetyReport): string[] {
  const failures: string[] = [];

  if (report.aggregate.baselineFailedCount !== 0) {
    failures.push(
      `Expected zero baseline failures, got ${report.aggregate.baselineFailedCount}.`
    );
  }

  if (report.aggregate.safetyScenarioFailedCount !== 0) {
    failures.push(
      `Expected zero safety scenario failures, got ${report.aggregate.safetyScenarioFailedCount}.`
    );
  }

  if (report.aggregate.safetyRepairAppliedCount !== 0) {
    failures.push(
      `Expected zero safety repair applications, got ${report.aggregate.safetyRepairAppliedCount}.`
    );
  }

  if (report.aggregate.safetyFinalMergeSafeCount !== 0) {
    failures.push(
      `Expected zero safety final mergeSafe cases, got ${report.aggregate.safetyFinalMergeSafeCount}.`
    );
  }

  if (!report.aggregate.overallPassed) {
    failures.push("Expected overallPassed=true.");
  }

  return failures;
}

function reportToMarkdown(report: RemaskRepairSafetyReport): string {
  const lines: string[] = [];

  lines.push(`# Remask Repair Safety Report`);
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

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Cases | ${report.aggregate.caseCount} |`);
  lines.push(`| Baseline passed | ${report.aggregate.baselinePassedCount} |`);
  lines.push(`| Baseline failed | ${report.aggregate.baselineFailedCount} |`);
  lines.push(`| Baseline repair applied | ${report.aggregate.baselineRepairAppliedCount} |`);
  lines.push(`| Baseline final merge safe | ${report.aggregate.baselineFinalMergeSafeCount} |`);
  lines.push(`| Safety scenarios | ${report.aggregate.safetyScenarioCount} |`);
  lines.push(`| Safety scenarios passed | ${report.aggregate.safetyScenarioPassedCount} |`);
  lines.push(`| Safety scenarios failed | ${report.aggregate.safetyScenarioFailedCount} |`);
  lines.push(`| Safety blocked | ${report.aggregate.safetyBlockedCount} |`);
  lines.push(`| Safety repair applied | ${report.aggregate.safetyRepairAppliedCount} |`);
  lines.push(`| Safety final merge safe | ${report.aggregate.safetyFinalMergeSafeCount} |`);
  lines.push(`| Safety remaining conflicts | ${report.aggregate.safetyRemainingConflictCount} |`);
  lines.push(`| Overall passed | ${report.aggregate.overallPassed} |`);
  lines.push("");

  lines.push(`## Workspace Repo Facts`);
  lines.push("");
  lines.push(`| Fact Bucket | Count |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Changed files | ${report.aggregate.workspaceRepoFacts.changedFileCount} |`);
  lines.push(`| Ownership entries | ${report.aggregate.workspaceRepoFacts.ownershipCount} |`);
  lines.push(`| Module boundaries | ${report.aggregate.workspaceRepoFacts.moduleBoundaryCount} |`);
  lines.push(`| Sensitive patterns | ${report.aggregate.workspaceRepoFacts.sensitivePatternCount} |`);
  lines.push(`| Stale facts | ${report.aggregate.workspaceRepoFacts.staleFactCount} |`);
  lines.push("");

  lines.push(`## Safety Scenario Counts`);
  lines.push("");
  lines.push(`| Scenario | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [scenario, count] of Object.entries(report.aggregate.safetyScenarioCountsById)) {
    lines.push(`| ${escapeMarkdownCell(scenario)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Safety Final Decisions`);
  lines.push("");
  lines.push(`| Decision | Count |`);
  lines.push(`| --- | ---: |`);

  for (const [decision, count] of Object.entries(report.aggregate.safetyFinalDecisionCounts)) {
    lines.push(`| ${escapeMarkdownCell(decision)} | ${count} |`);
  }

  lines.push("");

  lines.push(`## Cases`);
  lines.push("");
  lines.push(
    `| Case | Baseline Passed | Baseline Final Safe | Safety Passed | Safety Failed | Safety Repair Applied | Safety Final Safe |`
  );
  lines.push(`| --- | --- | --- | ---: | ---: | ---: | ---: |`);

  for (const item of report.cases) {
    const passed = item.safetyScenarios.filter((scenario) => scenario.passed).length;
    const failed = item.safetyScenarios.filter((scenario) => !scenario.passed).length;
    const repairApplied = item.safetyScenarios.filter(
      (scenario) => scenario.repair.repairApplied
    ).length;
    const finalSafe = item.safetyScenarios.filter(
      (scenario) => scenario.repair.finalMergeSafe
    ).length;

    lines.push(
      `| ${escapeMarkdownCell(item.caseId)} | ${item.baseline.passed} | ${item.baseline.repair.finalMergeSafe} | ${passed} | ${failed} | ${repairApplied} | ${finalSafe} |`
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

    lines.push(`### Baseline`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Passed | ${item.baseline.passed} |`);
    lines.push(`| Initial merge decision | ${item.baseline.merge.decision} |`);
    lines.push(`| Initial merge safe | ${item.baseline.merge.mergeSafe} |`);
    lines.push(`| Repair status | ${item.baseline.repair.status} |`);
    lines.push(`| Final decision | ${item.baseline.repair.finalDecision} |`);
    lines.push(`| Final merge safe | ${item.baseline.repair.finalMergeSafe} |`);
    lines.push("");

    lines.push(`### Safety Scenarios`);
    lines.push("");
    lines.push(
      `| Scenario | Passed | Status | Repair Applied | Final Decision | Final Safe | Remaining Conflicts |`
    );
    lines.push(`| --- | --- | --- | --- | --- | --- | ---: |`);

    for (const scenario of item.safetyScenarios) {
      lines.push(
        `| ${scenario.id} | ${scenario.passed} | ${scenario.repair.status} | ${scenario.repair.repairApplied} | ${scenario.repair.finalDecision} | ${scenario.repair.finalMergeSafe} | ${scenario.repair.remainingConflictCount} |`
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function createMergeVariant(
  baseMerge: ConflictAwareMergeResult,
  input: {
    decision: WorkspaceDecision;
    conflict: MergeConflict;
    requiredActions: string[];
  }
): ConflictAwareMergeResult {
  return {
    ...baseMerge,
    decision: input.decision,
    mergeSafe: false,
    conflicts: [input.conflict],
    requiredActions: input.requiredActions
  };
}

function createConflict(
  base: MergeConflict,
  overrides: Partial<MergeConflict>
): MergeConflict {
  return {
    ...base,
    ...overrides
  };
}

function createBlockedMutationOrchestration(
  input: OrchestrationRunResult
): OrchestrationRunResult {
  return {
    ...input,
    mutationSummary: {
      ...input.mutationSummary,
      blockedMutations: Math.max(input.mutationSummary.blockedMutations, 1)
    }
  };
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