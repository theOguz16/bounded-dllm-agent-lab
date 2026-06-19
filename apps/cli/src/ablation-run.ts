import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { getAblationMode, listAblationModes, type AblationModeId } from "../../../packages/ablation-core/src/index.js";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase,
  type CaseOutputSnapshot
} from "../../../packages/eval-core/src/index.js";
import {
  comparisonArtifactToMarkdown,
  createComparisonArtifact,
  createExperimentConfig,
  createRunManifest,
  validateRunManifest,
  type ExperimentRunManifest
} from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";

const reportDir = "reports";
const suiteName = "ablation-benchmark-v1";
const selectedModeIds = readModeIds();
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const manifests: ExperimentRunManifest[] = [];
const fixtureFailures = validateFixtures(demoFixtures);

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

await mkdir(reportDir, { recursive: true });

for (const modeId of selectedModeIds) {
  const mode = getAblationMode(modeId);
  const scores = [];
  const outputSnapshots: CaseOutputSnapshot[] = [];

  console.error(`[ablation-run] ${mode.id}: ${mode.label}`);

  for (const fixture of demoFixtures) {
    const result = await mode.runFixture(fixture);

    // Ablation koşusunda evaluator hiç değişmez. Sadece aynı fixture'a karşı hangi
    // mimari katmanın workspace ürettiği değişir. Bu sayede farkı modele değil,
    // kapatıp açtığımız architecture layer'a bağlayabiliriz.
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
  const runId = `${safeTimestamp}-ablation-${mode.id}`;
  const jsonPath = join(reportDir, `${runId}.json`);
  const markdownPath = join(reportDir, `${runId}.md`);
  const manifestPath = join(reportDir, `${runId}.manifest.json`);
  const artifact = createBenchmarkArtifact({
    suiteName,
    engineName: mode.id,
    createdAt,
    report,
    outputSnapshots
  });
  const config = createExperimentConfig({
    runId,
    suiteName,
    architectureName: mode.id,
    engineName: mode.id,
    modelName: "controlled-ablation",
    modelVersion: "0.1.0",
    seed: 0,
    maxAttempts: mode.refinementEnabled ? 2 : 1,
    ablation: {
      maskPolicyEnabled: mode.maskPolicyEnabled,
      verifierEnabled: mode.verifierEnabled,
      syntheticContextEnabled: false,
      refinementMaxAttempts: mode.refinementEnabled ? 2 : 1
    },
    maskPolicyVersion: mode.maskPolicyEnabled ? "role-mask-v1" : "none",
    gitCommit: readGitCommit(),
    hardware: {
      platform: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024)
    },
    createdAt
  });
  const manifest = createRunManifest({
    config,
    report,
    reportPaths: {
      jsonPath,
      markdownPath,
      manifestPath
    }
  });
  const failures = validateRunManifest(manifest);

  if (failures.length) {
    throw new Error(JSON.stringify({ ok: false, modeId, failures }, null, 2));
  }

  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  manifests.push(manifest);
}

const comparison = createComparisonArtifact({ createdAt, manifests });
const comparisonJsonPath = join(reportDir, `${safeTimestamp}-ablation-comparison.json`);
const comparisonMarkdownPath = join(reportDir, `${safeTimestamp}-ablation-comparison.md`);

await writeFile(comparisonJsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(comparisonMarkdownPath, comparisonArtifactToMarkdown(comparison));

console.log(
  JSON.stringify(
    {
      ok: true,
      suiteName,
      modeCount: selectedModeIds.length,
      modes: selectedModeIds,
      comparisonJsonPath,
      comparisonMarkdownPath,
      summaries: manifests.map((manifest) => ({
        mode: manifest.architectureName,
        taskSuccessRate: manifest.summary.taskSuccessRate,
        scopeDriftRate: manifest.summary.scopeDriftRate,
        sensitiveLeakageRate: manifest.summary.sensitiveLeakageRate,
        evidenceCoverage: manifest.summary.evidenceCoverage,
        traceCompletenessRate: manifest.summary.traceCompletenessRate
      }))
    },
    null,
    2
  )
);

function readModeIds(): AblationModeId[] {
  const raw = readFlag("--modes");
  const available = new Set(listAblationModes().map((mode) => mode.id));

  if (!raw) return listAblationModes().map((mode) => mode.id);

  return raw.split(",").map((item) => item.trim()).filter((item): item is AblationModeId => {
    if (available.has(item as AblationModeId)) return true;
    throw new Error(`Unknown ablation mode: ${item}`);
  });
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
