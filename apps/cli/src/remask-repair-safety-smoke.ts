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
  analyzeRepository
} from "../../../packages/repo-intelligence/src/index.js";
import {
  attachRepoIntelligenceToWorkspace,
  summarizeWorkspaceRepoFacts
} from "../../../packages/repo-intelligence/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import type {
  WorkspaceDecision
} from "../../../packages/workspace-core/src/index.js";

type MergeConflict = ConflictAwareMergeResult["conflicts"][number];

type SafetyCase = {
  id: string;
  description: string;
  orchestration: OrchestrationRunResult;
  merge: ConflictAwareMergeResult;
  expectedFinalDecision: WorkspaceDecision;
};

const changedFiles = parseChangedFilesFromEnv(process.env.REPO_CHANGED_FILES) ?? [
  "packages/context-core/src/index.ts",
  "packages/repo-intelligence/src/workspace-adapter.ts"
];

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before remask repair safety smoke.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

const fixture = remaskFixtures[0];

if (!fixture) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "No fixture found for remask repair safety smoke."
      },
      null,
      2
    )
  );
}

const repoResult = await analyzeRepository({
  rootDir: process.cwd(),
  changedFiles,
  maxFiles: 1000
});

const baseWorkspace = createWorkspaceFromPacket(fixture.packet, {
  id: `remask-repair-safety-smoke-${fixture.case.id}`
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
        reason: "Expected baseline merge to contain at least one conflict for safety smoke.",
        summary: summarizeBaseline()
      },
      null,
      2
    )
  );
}

const safetyCases: SafetyCase[] = [
  {
    id: "sensitive-boundary-blocks-repair",
    description: "Sensitive boundary conflict must not be auto-repaired.",
    orchestration: orchestrationResult,
    merge: createMergeVariant({
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
    merge: createMergeVariant({
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
    merge: createMergeVariant({
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

const safetyResults = safetyCases.map((safetyCase) => ({
  case: safetyCase,
  repair: runMockRemaskRepairLoop({
    orchestration: safetyCase.orchestration,
    merge: safetyCase.merge
  })
}));

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Remask repair safety smoke failed.",
        caseId: fixture.case.id,
        workspaceId: workspace.id,
        failures,
        summary: summarizeResult()
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      smokeName: "remask-repair-safety-smoke",
      caseId: fixture.case.id,
      workspaceId: workspace.id,
      summary: summarizeResult()
    },
    null,
    2
  )
);

function validateResult(): string[] {
  const failures: string[] = [];
  const repoSummary = summarizeWorkspaceRepoFacts(workspace.repoFacts);

  if (repoSummary.changedFileCount !== changedFiles.length) {
    failures.push(
      `Expected ${changedFiles.length} changed files, got ${repoSummary.changedFileCount}.`
    );
  }

  if (mergeResult.decision !== "remask_required") {
    failures.push(`Expected baseline merge decision remask_required, got ${mergeResult.decision}.`);
  }

  if (mergeResult.mergeSafe) {
    failures.push("Expected baseline mergeSafe=false before baseline repair.");
  }

  if (baselineRepair.status !== "repaired") {
    failures.push(`Expected baseline repair status repaired, got ${baselineRepair.status}.`);
  }

  if (baselineRepair.finalDecision !== "approve") {
    failures.push(`Expected baseline final decision approve, got ${baselineRepair.finalDecision}.`);
  }

  if (!baselineRepair.finalMergeSafe) {
    failures.push("Expected baseline finalMergeSafe=true.");
  }

  for (const item of safetyResults) {
    const repair = item.repair;

    if (repair.status !== "blocked") {
      failures.push(
        `Safety case ${item.case.id}: expected status blocked, got ${repair.status}.`
      );
    }

    if (repair.repairApplied) {
      failures.push(
        `Safety case ${item.case.id}: expected repairApplied=false.`
      );
    }

    if (repair.finalDecision !== item.case.expectedFinalDecision) {
      failures.push(
        `Safety case ${item.case.id}: expected finalDecision ${item.case.expectedFinalDecision}, got ${repair.finalDecision}.`
      );
    }

    if (repair.finalMergeSafe) {
      failures.push(
        `Safety case ${item.case.id}: expected finalMergeSafe=false.`
      );
    }

    if (repair.secondPass.mergeSafe) {
      failures.push(
        `Safety case ${item.case.id}: expected secondPass.mergeSafe=false.`
      );
    }

    if (repair.actions.length !== 0) {
      failures.push(
        `Safety case ${item.case.id}: expected zero repair actions, got ${repair.actions.length}.`
      );
    }

    if (repair.remainingConflicts.length <= 0) {
      failures.push(
        `Safety case ${item.case.id}: expected remaining conflicts to stay non-empty.`
      );
    }
  }

  return failures;
}

function summarizeResult(): Record<string, unknown> {
  return {
    changedFiles,
    repo: {
      rootDir: repoResult.rootDir,
      scannedFileCount: repoResult.scannedFileCount,
      skippedFileCount: repoResult.skippedFileCount,
      diagnostics: repoResult.diagnostics.slice(0, 10)
    },
    workspaceRepoFacts: summarizeWorkspaceRepoFacts(workspace.repoFacts),
    baseline: summarizeBaseline(),
    safetyCases: safetyResults.map((item) => summarizeSafetyCase(item.case, item.repair))
  };
}

function summarizeBaseline(): Record<string, unknown> {
  return {
    orchestration: {
      decision: orchestrationResult.decision,
      remaskTriggered: orchestrationResult.remaskTriggered,
      mutationSummary: orchestrationResult.mutationSummary
    },
    merge: {
      decision: mergeResult.decision,
      mergeSafe: mergeResult.mergeSafe,
      conflictCount: mergeResult.conflicts.length,
      conflictKinds: mergeResult.conflicts.map((conflict) => conflict.kind)
    },
    repair: {
      status: baselineRepair.status,
      repairApplied: baselineRepair.repairApplied,
      finalDecision: baselineRepair.finalDecision,
      finalMergeSafe: baselineRepair.finalMergeSafe,
      remainingConflictCount: baselineRepair.remainingConflicts.length,
      actionCount: baselineRepair.actions.length
    }
  };
}

function summarizeSafetyCase(
  safetyCase: SafetyCase,
  repair: RemaskRepairLoopResult
): Record<string, unknown> {
  return {
    id: safetyCase.id,
    description: safetyCase.description,
    input: {
      orchestrationDecision: safetyCase.orchestration.decision,
      remaskTriggered: safetyCase.orchestration.remaskTriggered,
      blockedMutations: safetyCase.orchestration.mutationSummary.blockedMutations,
      mergeDecision: safetyCase.merge.decision,
      mergeSafe: safetyCase.merge.mergeSafe,
      conflictKinds: safetyCase.merge.conflicts.map((conflict) => conflict.kind)
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
      secondPass: repair.secondPass
    }
  };
}

function createMergeVariant(input: {
  decision: WorkspaceDecision;
  conflict: MergeConflict;
  requiredActions: string[];
}): ConflictAwareMergeResult {
  return {
    ...mergeResult,
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