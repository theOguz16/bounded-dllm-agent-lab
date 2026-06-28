import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase,
  type CaseOutputSnapshot,
  type CaseScore
} from "../../../packages/eval-core/src/index.js";
import {
  comparisonArtifactToMarkdown,
  createComparisonArtifact,
  createExperimentConfig,
  createRunManifest,
  validateRunManifest,
  type ExperimentRunManifest
} from "../../../packages/experiment-core/src/index.js";
import {
  remaskFixtures,
  validateFixtures,
  type BenchmarkFixture
} from "../../../packages/fixtures/src/index.js";
import {
  createWorkspaceFromPacket,
  type WorkspaceEvidenceFact
} from "../../../packages/context-core/src/workspace-adapter.js";
import { runRefinementLoop } from "../../../packages/refinement-loop/src/index.js";
import {
  addVerifierResult,
  setFinalResult,
  type SharedSemanticWorkspace,
  type WorkspaceRegion
} from "../../../packages/workspace-core/src/index.js";
import type { ModelEngine } from "../../../packages/providers/src/index.js";

const reportDir = "reports";
const suiteName = "remask-required-benchmark-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

async function runBenchmark(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const manifests = [
    await runMode("single_pass_stale", "single-pass-stale-engine", async (fixture) => {
      const engine = new SinglePassStaleEngine();

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `remask-single-${fixture.case.id}`
      });

      const result = await engine.refineWorkspace(workspace);

      return {
        workspace: result.workspace,
        engineName: engine.name
      };
    }),

    await runMode("remask_recovery", "remask-recovery-engine", async (fixture) => {
      const engine = new RemaskRecoveryEngine();

      const workspace = createWorkspaceFromPacket(fixture.packet, {
        id: `remask-recovery-${fixture.case.id}`
      });

      const result = await runRefinementLoop({
        workspace,
        engine,
        view: "verifier",
        maxAttempts: 2
      });

      return {
        workspace: result.workspace,
        engineName: engine.name
      };
    })
  ];

  const comparison = createComparisonArtifact({
    createdAt,
    manifests
  });

  const comparisonJsonPath = join(reportDir, `${safeTimestamp}-remask-comparison.json`);
  const comparisonMarkdownPath = join(reportDir, `${safeTimestamp}-remask-comparison.md`);

  await writeFile(comparisonJsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(comparisonMarkdownPath, comparisonArtifactToMarkdown(comparison));

  console.log(
    JSON.stringify(
      {
        ok: true,
        suiteName,
        scenarioCount: remaskFixtures.length,
        comparisonJsonPath,
        comparisonMarkdownPath,
        summaries: manifests.map((manifest) => ({
          mode: manifest.architectureName,
          taskSuccessRate: manifest.summary.taskSuccessRate,
          evidenceCoverage: manifest.summary.evidenceCoverage,
          traceCompletenessRate: manifest.summary.traceCompletenessRate
        }))
      },
      null,
      2
    )
  );
}

async function runMode(
  architectureName: string,
  engineName: string,
  runFixture: (fixture: BenchmarkFixture) => Promise<{
    workspace: SharedSemanticWorkspace;
    engineName: string;
  }>
): Promise<ExperimentRunManifest> {
  const scores: CaseScore[] = [];
  const outputSnapshots: CaseOutputSnapshot[] = [];

  for (const fixture of remaskFixtures) {
    const result = await runFixture(fixture);

    scores.push(scoreCase(fixture.case, result.workspace));

    outputSnapshots.push({
      caseId: fixture.case.id,
      family: fixture.case.family,
      task: fixture.packet.task,
      expectedResult: fixture.case.expectedResult,
      requiredTerms: fixture.case.requiredTerms,
      forbiddenTerms: fixture.case.forbiddenTerms,
      finalResult: result.workspace.finalResult?.summary ?? ""
    });
  }

  const report = aggregateScores(scores);
  const runId = `${safeTimestamp}-remask-${architectureName}`;
  const jsonPath = join(reportDir, `${runId}.json`);
  const markdownPath = join(reportDir, `${runId}.md`);
  const manifestPath = join(reportDir, `${runId}.manifest.json`);

  const artifact = createBenchmarkArtifact({
    suiteName,
    engineName,
    createdAt,
    report,
    outputSnapshots
  });

  const manifest = createRunManifest({
    config: createExperimentConfig({
      runId,
      suiteName,
      architectureName,
      engineName,
      modelName: "controlled-remask",
      modelVersion: "0.1.0",
      seed: 0,
      maxAttempts: architectureName === "remask_recovery" ? 2 : 1,
      ablation: {
        maskPolicyEnabled: true,
        verifierEnabled: true,
        syntheticContextEnabled: false,
        refinementMaxAttempts: architectureName === "remask_recovery" ? 2 : 1
      },
      maskPolicyVersion: "role-mask-v1",
      gitCommit: readGitCommit(),
      hardware: {
        platform: platform(),
        arch: arch(),
        cpuCount: cpus().length,
        totalMemoryMb: Math.round(totalmem() / 1024 / 1024)
      },
      createdAt
    }),
    report,
    reportPaths: {
      jsonPath,
      markdownPath,
      manifestPath
    }
  });

  const failures = validateRunManifest(manifest);

  if (failures.length) {
    throw new Error(JSON.stringify({ ok: false, architectureName, failures }, null, 2));
  }

  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

class SinglePassStaleEngine implements ModelEngine {
  readonly name = "single-pass-stale-engine";
  readonly mode = "dllm" as const;

  async refineWorkspace(workspace: SharedSemanticWorkspace) {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();
    const stale = selectStaleFact(workspace);
    const fallback = selectCorrectionFact(workspace);
    const selected = stale ?? fallback;

    let refined = workspace;

    /**
     * Single-pass baseline bilerek stale cevabı kabul eder.
     * Evidence id artık generic değil; adapter'dan gelen gerçek stale evidenceId kullanılır.
     */
    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.id}-single-pass-stale`,
      status: "pass",
      decision: "approve",
      checkName: "single-pass-stale-baseline",
      summary: "Single-pass baseline accepts the first available stale result and does not recover.",
      findings: [],
      checkedFiles: workspace.scope.changedFiles,
      evidenceIds: selected ? [selected.evidenceId] : [],
      failedRegions: [],
      createdBy: "verifier",
      createdAt
    });

    refined = setFinalResult(refined, {
      summary: selected?.content ?? "insufficient_context",
      createdBy: "coder",
      createdAt
    });

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}

class RemaskRecoveryEngine implements ModelEngine {
  readonly name = "remask-recovery-engine";
  readonly mode = "dllm" as const;

  async refineWorkspace(workspace: SharedSemanticWorkspace) {
    const started = Date.now();
    const createdAt = new Date(started).toISOString();

    const stale = selectStaleFact(workspace);
    const correction = selectCorrectionFact(workspace);

    /**
     * İlk pass'te stale seçilir ve final_result remask_required olur.
     * İkinci pass'te final_result maskelendiği ve önceki fail görüldüğü için correction seçilir.
     */
    const shouldRecover =
      workspace.maskedRegions.includes("final_result") &&
      workspace.verifierResults.some((result) => result.status === "fail");

    const selected = shouldRecover && correction ? correction : stale ?? correction;
    const failedRegions: WorkspaceRegion[] = shouldRecover ? [] : ["final_result"];

    let refined = workspace;

    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.id}-${shouldRecover ? "pass" : "fail"}`,
      status: shouldRecover ? "pass" : "fail",
      decision: shouldRecover ? "approve" : "remask_required",
      checkName: "remask-required",
      summary: shouldRecover
        ? "Recovered final_result after targeted remasking."
        : "Detected stale final_result and requested targeted remasking.",
      findings: shouldRecover
        ? []
        : [
            {
              id: `finding-${workspace.id}-stale-final-result`,
              severity: "error",
              category: "authority",
              message: "The first pass selected stale evidence for final_result.",
              files: workspace.scope.changedFiles,
              suggestedAction: "remask_required"
            }
          ],
      checkedFiles: workspace.scope.changedFiles,
      evidenceIds: selected ? [selected.evidenceId] : [],
      failedRegions,
      createdBy: "verifier",
      createdAt
    });

    refined = setFinalResult(refined, {
      summary: selected?.content ?? "insufficient_context",
      createdBy: "coder",
      createdAt
    });

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}

type ControlledEvidence = {
  id: string;
  content: string;
  evidenceId: string;
};

type WorkspaceWithEvidenceFacts = SharedSemanticWorkspace & {
  authority: SharedSemanticWorkspace["authority"] & {
    evidenceFacts?: WorkspaceEvidenceFact[];
  };
  repoFacts: SharedSemanticWorkspace["repoFacts"] & {
    evidenceFacts?: WorkspaceEvidenceFact[];
  };
};

function selectStaleFact(workspace: SharedSemanticWorkspace): ControlledEvidence | undefined {
  const staleEvidenceFact = findEvidenceFact(workspace, ["stale"]);

  if (staleEvidenceFact) {
    return {
      id: staleEvidenceFact.id,
      content: staleEvidenceFact.content,
      evidenceId: staleEvidenceFact.evidenceId
    };
  }

  const stale = workspace.repoFacts.staleFacts[0];

  if (!stale) {
    return undefined;
  }

  return {
    id: "stale-fact",
    content: stale,
    evidenceId: "workspace-repo-stale-fact"
  };
}

function selectCorrectionFact(workspace: SharedSemanticWorkspace): ControlledEvidence | undefined {
  const correctionEvidenceFact = findEvidenceFact(workspace, ["correction", "current"]);

  if (correctionEvidenceFact) {
    return {
      id: correctionEvidenceFact.id,
      content: correctionEvidenceFact.content,
      evidenceId: correctionEvidenceFact.evidenceId
    };
  }

  const correction = workspace.authority.facts[0];

  if (!correction) {
    return undefined;
  }

  return {
    id: "correction-fact",
    content: correction,
    evidenceId: "workspace-authority-correction"
  };
}

function getEvidenceFacts(workspace: SharedSemanticWorkspace): WorkspaceEvidenceFact[] {
  const workspaceWithEvidence = workspace as WorkspaceWithEvidenceFacts;

  return [
    ...(workspaceWithEvidence.authority.evidenceFacts ?? []),
    ...(workspaceWithEvidence.repoFacts.evidenceFacts ?? [])
  ];
}

function findEvidenceFact(
  workspace: SharedSemanticWorkspace,
  kinds: WorkspaceEvidenceFact["kind"][]
): WorkspaceEvidenceFact | undefined {
  return getEvidenceFacts(workspace).find((fact) => kinds.includes(fact.kind));
}

await runBenchmark();

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}