import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  evaluateConflictAwareMerge
} from "../../../packages/merge-core/src/index.js";
import {
  runMockOrchestrationFlow
} from "../../../packages/orchestration-core/src/index.js";
import {
  runMockRemaskRepairLoop
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
        reason: "Fixture validation failed before remask repair smoke.",
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
        reason: "No fixture found for remask repair smoke."
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
  id: `remask-repair-smoke-${fixture.case.id}`
});

const workspace = attachRepoIntelligenceToWorkspace(baseWorkspace, repoResult);
const orchestrationResult = runMockOrchestrationFlow(workspace);
const mergeResult = evaluateConflictAwareMerge(orchestrationResult);
const repairResult = runMockRemaskRepairLoop({
  orchestration: orchestrationResult,
  merge: mergeResult
});

const failures = validateResult();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Remask repair smoke failed.",
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
      smokeName: "remask-repair-smoke",
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

  if (orchestrationResult.decision !== "remask_required") {
    failures.push(
      `Expected initial orchestration remask_required, got ${orchestrationResult.decision}.`
    );
  }

  if (!orchestrationResult.remaskTriggered) {
    failures.push("Expected initial orchestration to trigger remask.");
  }

  if (mergeResult.decision !== "remask_required") {
    failures.push(`Expected initial merge remask_required, got ${mergeResult.decision}.`);
  }

  if (mergeResult.mergeSafe) {
    failures.push("Expected initial mergeSafe=false before repair.");
  }

  if (mergeResult.conflicts.length <= 0) {
    failures.push("Expected initial merge conflicts before repair.");
  }

  if (repairResult.status !== "repaired") {
    failures.push(`Expected repair status repaired, got ${repairResult.status}.`);
  }

  if (!repairResult.repairApplied) {
    failures.push("Expected repairApplied=true.");
  }

  if (repairResult.finalDecision !== "approve") {
    failures.push(`Expected final decision approve, got ${repairResult.finalDecision}.`);
  }

  if (!repairResult.finalMergeSafe) {
    failures.push("Expected finalMergeSafe=true after repair.");
  }

  if (repairResult.remainingConflicts.length !== 0) {
    failures.push(
      `Expected zero remaining conflicts, got ${repairResult.remainingConflicts.length}.`
    );
  }

  if (repairResult.secondPass.verifierDecision !== "approve") {
    failures.push(
      `Expected second-pass verifier approve, got ${repairResult.secondPass.verifierDecision}.`
    );
  }

  if (repairResult.secondPass.mergeDecision !== "approve") {
    failures.push(
      `Expected second-pass merge approve, got ${repairResult.secondPass.mergeDecision}.`
    );
  }

  if (!repairResult.secondPass.mergeSafe) {
    failures.push("Expected second-pass mergeSafe=true.");
  }

  if (repairResult.actions.length <= 0) {
    failures.push("Expected at least one repair action.");
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
    initialOrchestration: {
      decision: orchestrationResult.decision,
      remaskTriggered: orchestrationResult.remaskTriggered,
      tokenSummary: orchestrationResult.tokenSummary,
      mutationSummary: orchestrationResult.mutationSummary
    },
    initialMerge: {
      decision: mergeResult.decision,
      mergeSafe: mergeResult.mergeSafe,
      conflictCount: mergeResult.conflicts.length,
      conflicts: mergeResult.conflicts.map((conflict) => ({
        kind: conflict.kind,
        severity: conflict.severity,
        suggestedDecision: conflict.suggestedDecision,
        evidenceIds: conflict.evidenceIds,
        message: conflict.message
      })),
      requiredActions: mergeResult.requiredActions
    },
    repair: {
      status: repairResult.status,
      repairApplied: repairResult.repairApplied,
      initialDecision: repairResult.initialDecision,
      finalDecision: repairResult.finalDecision,
      initialMergeSafe: repairResult.initialMergeSafe,
      finalMergeSafe: repairResult.finalMergeSafe,
      repairableConflictCount: repairResult.repairableConflictCount,
      unrepairedConflictCount: repairResult.unrepairedConflictCount,
      actionCount: repairResult.actions.length,
      actions: repairResult.actions,
      secondPass: repairResult.secondPass,
      evidence: repairResult.evidence
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