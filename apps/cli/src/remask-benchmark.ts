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
import { remaskFixtures, validateFixtures, type BenchmarkFixture } from "../../../packages/fixtures/src/index.js";
import { runRefinementLoop } from "../../../packages/refinement-loop/src/index.js";
import {
  addClaim,
  addVerifierResult,
  setBoundaryDecision,
  setFinalResult,
  type SharedSemanticWorkspace,
  type WorkspaceRegion
} from "../../../packages/workspace-core/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import type { ModelEngine } from "../../../packages/providers/src/index.js";

const reportDir = "reports";
const suiteName = "remask-required-benchmark-v1";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const fixtureFailures = validateFixtures(remaskFixtures, { expectedFamilyCount: undefined });

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

async function runBenchmark(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const manifests = [
    await runMode("single_pass_stale", "single-pass-stale-engine", async (fixture) => {
      const engine = new SinglePassStaleEngine();
      const workspace = createWorkspace(`remask-single-${fixture.case.id}`, fixture.packet);
      const result = await engine.refineWorkspace(workspace);
      return { workspace: result.workspace, engineName: engine.name };
    }),
    await runMode("remask_recovery", "remask-recovery-engine", async (fixture) => {
      const engine = new RemaskRecoveryEngine();
      const workspace = createWorkspace(`remask-recovery-${fixture.case.id}`, fixture.packet);
      const result = await runRefinementLoop({
        workspace,
        engine,
        view: "boundary",
        maxAttempts: 2
      });
      return { workspace: result.workspace, engineName: engine.name };
    })
  ];

  const comparison = createComparisonArtifact({ createdAt, manifests });
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
  runFixture: (fixture: BenchmarkFixture) => Promise<{ workspace: SharedSemanticWorkspace; engineName: string }>
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
      finalResult: result.workspace.finalResult ?? ""
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
    const stale = workspace.packet.facts.find((fact) => fact.kind === "stale") ?? workspace.packet.facts[0];
    let refined = setBoundaryDecision(workspace, {
      status: "sufficient_context",
      reason: "Single-pass baseline does not recover after verifier feedback.",
      missingInformation: [],
      decidedBy: "boundary",
      createdAt
    });

    // Bu baseline bilerek ilk/stale cevabı final yapar. Amaç kötü model yazmak değil;
    // refinement recovery koşusunda ikinci pass'in gerçekten skoru değiştirdiğini
    // ölçebileceğimiz kontrollü bir alt sınır oluşturmaktır.
    refined = setFinalResult(refined, stale?.content ?? "insufficient_context", "implementer", createdAt);

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
    const stale = workspace.packet.facts.find((fact) => fact.kind === "stale") ?? workspace.packet.facts[0];
    const correction = workspace.packet.facts.find((fact) => fact.kind === "correction");
    const shouldRecover = workspace.maskedRegions.includes("final_result") && workspace.verifierResults.some((result) => result.status === "fail");
    const selected = shouldRecover && correction ? correction : stale;
    const failedRegions: WorkspaceRegion[] = shouldRecover ? [] : ["final_result"];
    const replacementWorkspace = shouldRecover
      ? {
          ...workspace,
          // Remask recovery yalnızca yeni bir final_result eklemek değildir. Aynı
          // region'daki eski/stale claim'i de kaldırmalıdır; aksi halde evaluator
          // eski forbidden metni hâlâ workspace output zincirinde görür.
          claims: workspace.claims.filter((claim) => claim.region !== "final_result")
        }
      : workspace;
    let refined = setBoundaryDecision(replacementWorkspace, {
      status: "sufficient_context",
      reason: shouldRecover
        ? "Verifier feedback remasked final_result and the engine selected the correction."
        : "First pass intentionally exposes a stale final_result for verifier recovery.",
      missingInformation: [],
      decidedBy: "boundary",
      createdAt
    });

    if (selected) {
      refined = addClaim(refined, {
        id: `claim-${selected.id}-${shouldRecover ? "recovered" : "stale"}`,
        region: "final_result",
        actor: "implementer",
        content: selected.content,
        evidenceIds: [selected.evidenceId],
        confidence: selected.confidence,
        state: shouldRecover ? "accepted" : "proposed",
        createdAt
      });
    }

    refined = addVerifierResult(refined, {
      id: `verifier-${workspace.packet.id}-${shouldRecover ? "pass" : "fail"}`,
      status: shouldRecover ? "pass" : "fail",
      checkName: "remask-required",
      summary: shouldRecover
        ? "Recovered final_result after targeted remasking."
        : "Detected stale final_result and requested targeted remasking.",
      evidenceIds: shouldRecover && correction ? [correction.evidenceId] : [],
      failedRegions,
      createdAt
    });
    refined = setFinalResult(refined, selected?.content ?? "insufficient_context", "implementer", createdAt);

    return {
      workspace: refined,
      latencyMs: Date.now() - started,
      engineName: this.name
    };
  }
}

await runBenchmark();

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
