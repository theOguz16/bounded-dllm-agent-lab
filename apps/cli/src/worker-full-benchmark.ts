import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase,
  type CaseOutputSnapshot
} from "../../../packages/eval-core/src/index.js";
import { createExperimentConfig, createRunManifest, validateRunManifest } from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import { HttpDllmWorkerEngine } from "../../../packages/providers/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";

const workerUrl = process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765";
const engine = new HttpDllmWorkerEngine(workerUrl, "boundary");
const reportDir = "reports";
const suiteName = "worker-full-benchmark-v1";
const fixtureSubset = demoFixtures;
const fixtureFailures = validateFixtures(demoFixtures);

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

const healthy = await engine.health();
if (!healthy) {
  throw new Error(`Worker health check failed for ${workerUrl}`);
}

const scores = [];
const outputSnapshots: CaseOutputSnapshot[] = [];
for (const [index, fixture] of fixtureSubset.entries()) {
  const progress = `${index + 1}/${fixtureSubset.length}`;
  console.error(`[worker-full-benchmark] ${progress} ${fixture.case.id}`);

  const workspace = createWorkspace(`full-benchmark-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await engine.refineWorkspace(masked.workspace);

  // Full benchmark bütün fixture dataset'ini gerçek worker'a gönderir. Bu artık
  // smoke/dry-run değildir; araştırma hipotezinin dataset geneline yayılıp yayılmadığını
  // görmek için kullanılan ilk tam canlı koşudur.
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
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-worker-full-benchmark`;
const artifact = createBenchmarkArtifact({
  suiteName,
  engineName: "external-dllm-worker-full-benchmark",
  createdAt,
  report,
  outputSnapshots
});
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const config = createExperimentConfig({
  runId,
  suiteName,
  architectureName: "external-dllm-worker-full-benchmark",
  engineName: "http-dllm-worker",
  modelName: "Dream-org/Dream-Coder-v0-Instruct-7B",
  modelVersion: "full-benchmark",
  workerUrl,
  seed: 0,
  maxAttempts: 1,
  ablation: {
    maskPolicyEnabled: true,
    verifierEnabled: true,
    syntheticContextEnabled: false,
    refinementMaxAttempts: 1
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
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      workerUrl,
      scenarioCount: fixtureSubset.length,
      jsonPath,
      markdownPath,
      manifestPath,
      summary: {
        taskSuccessRate: report.taskSuccessRate,
        scopeDriftRate: report.scopeDriftRate,
        sensitiveLeakageRate: report.sensitiveLeakageRate,
        evidenceCoverage: report.evidenceCoverage,
        traceCompletenessRate: report.traceCompletenessRate
      }
    },
    null,
    2
  )
);

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
