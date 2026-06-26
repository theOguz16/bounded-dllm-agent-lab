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
  type ExperimentComparisonArtifact,
  type ExperimentComparisonRow,
  type ExperimentRunManifest
} from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, hardFixtures, validateFixtures, type BenchmarkFixture } from "../../../packages/fixtures/src/index.js";

const reportDir = "reports";
const suite = readSuite();
const fixtureSubset = selectFixtures(suite);
const suiteName = `${suite}-ablation-benchmark-v1`;
const selectedModeIds = readModeIds();
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const manifests: ExperimentRunManifest[] = [];
const fixtureFailures = validateFixtures(fixtureSubset, { expectedFamilyCount: suite === "base" ? 10 : 5 });

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

await mkdir(reportDir, { recursive: true });

for (const modeId of selectedModeIds) {
  const mode = getAblationMode(modeId);
  const scores = [];
  const outputSnapshots: CaseOutputSnapshot[] = [];

  console.error(`[ablation-run] ${mode.id}: ${mode.label}`);

  for (const fixture of fixtureSubset) {
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
      finalResult: result.workspace.finalResult?.summary ?? ""
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
const analysis = createAblationAnalysis({
  suite,
  suiteName,
  createdAt,
  comparison
});
const analysisJsonPath = join(reportDir, `${safeTimestamp}-ablation-analysis.json`);
const analysisMarkdownPath = join(reportDir, `${safeTimestamp}-ablation-analysis.md`);

await writeFile(comparisonJsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(comparisonMarkdownPath, comparisonArtifactToMarkdown(comparison));
await writeFile(analysisJsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
await writeFile(analysisMarkdownPath, ablationAnalysisToMarkdown(analysis));

console.log(
  JSON.stringify(
    {
      ok: true,
      suiteName,
      suite,
      scenarioCount: fixtureSubset.length,
      modeCount: selectedModeIds.length,
      modes: selectedModeIds,
      comparisonJsonPath,
      comparisonMarkdownPath,
      analysisJsonPath,
      analysisMarkdownPath,
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

type AblationAnalysis = {
  suite: "base" | "hard";
  suiteName: string;
  createdAt: string;
  observations: string[];
  deltas: {
    rawToBoundedTaskDelta?: number;
    boundedToGroundedEvidenceDelta?: number;
    boundedToGroundedTraceDelta?: number;
    groundedToRefinementTaskDelta?: number;
    groundedToRefinementEvidenceDelta?: number;
    groundedToRefinementTraceDelta?: number;
  };
  warnings: string[];
};

function createAblationAnalysis(input: {
  suite: "base" | "hard";
  suiteName: string;
  createdAt: string;
  comparison: ExperimentComparisonArtifact;
}): AblationAnalysis {
  const raw = findRow(input.comparison, "raw_fact_only");
  const bounded = findRow(input.comparison, "bounded_context");
  const grounded = findRow(input.comparison, "bounded_grounded");
  const refinement = findRow(input.comparison, "bounded_refinement");
  const deltas = {
    rawToBoundedTaskDelta: delta(raw?.taskSuccessRate, bounded?.taskSuccessRate),
    boundedToGroundedEvidenceDelta: delta(bounded?.evidenceCoverage, grounded?.evidenceCoverage),
    boundedToGroundedTraceDelta: delta(bounded?.traceCompletenessRate, grounded?.traceCompletenessRate),
    groundedToRefinementTaskDelta: delta(grounded?.taskSuccessRate, refinement?.taskSuccessRate),
    groundedToRefinementEvidenceDelta: delta(grounded?.evidenceCoverage, refinement?.evidenceCoverage),
    groundedToRefinementTraceDelta: delta(grounded?.traceCompletenessRate, refinement?.traceCompletenessRate)
  };
  const observations = [
    explainDelta("Raw to bounded task success", deltas.rawToBoundedTaskDelta),
    explainDelta("Bounded to grounded evidence coverage", deltas.boundedToGroundedEvidenceDelta),
    explainDelta("Bounded to grounded trace completeness", deltas.boundedToGroundedTraceDelta),
    explainDelta("Grounded to refinement task success", deltas.groundedToRefinementTaskDelta)
  ].filter((item): item is string => Boolean(item));
  const warnings: string[] = [];

  if (bounded && grounded && bounded.taskSuccessRate === grounded.taskSuccessRate && bounded.evidenceCoverage < grounded.evidenceCoverage) {
    warnings.push("Task success alone hides auditability differences; grounded mode preserves success while improving evidence coverage.");
  }

  if (grounded && refinement && grounded.taskSuccessRate === refinement.taskSuccessRate && grounded.evidenceCoverage === refinement.evidenceCoverage && grounded.traceCompletenessRate === refinement.traceCompletenessRate) {
    warnings.push("Current suite does not isolate a measurable refinement-loop advantage over single-pass grounded output.");
  }

  if (input.suite === "hard" && warnings.some((warning) => warning.includes("refinement-loop"))) {
    warnings.push("Next hard-suite iteration should include verifier-fail/remask-required cases where the first pass can fail and a targeted remask can change the score.");
  }

  return {
    suite: input.suite,
    suiteName: input.suiteName,
    createdAt: input.createdAt,
    observations,
    deltas,
    warnings
  };
}

function ablationAnalysisToMarkdown(analysis: AblationAnalysis): string {
  return [
    `# Ablation Analysis: ${analysis.suiteName}`,
    "",
    `- Suite: ${analysis.suite}`,
    `- Created at: ${analysis.createdAt}`,
    "",
    "## Observations",
    "",
    ...analysis.observations.map((item) => `- ${item}`),
    "",
    "## Warnings",
    "",
    ...(analysis.warnings.length ? analysis.warnings.map((item) => `- ${item}`) : ["- No warnings."]),
    ""
  ].join("\n");
}

function findRow(comparison: ExperimentComparisonArtifact, architectureName: string): ExperimentComparisonRow | undefined {
  return comparison.rows.find((row) => row.architectureName === architectureName);
}

function delta(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return Math.round((right - left) * 1000) / 1000;
}

function explainDelta(label: string, value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const direction = value > 0 ? "improved by" : value < 0 ? "decreased by" : "changed by";
  return `${label} ${direction} ${percent(Math.abs(value))}.`;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function readSuite(): "base" | "hard" {
  const value = readFlag("--suite") ?? "base";
  if (value === "base" || value === "hard") return value;
  throw new Error(`Unknown suite: ${value}`);
}

function selectFixtures(selectedSuite: "base" | "hard"): BenchmarkFixture[] {
  return selectedSuite === "hard" ? hardFixtures : demoFixtures;
}

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
