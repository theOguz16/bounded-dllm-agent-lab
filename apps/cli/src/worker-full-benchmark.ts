import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const createdAt = new Date().toISOString();
const runId = await resolveRunId(createdAt);
const checkpointPath = join(reportDir, `${runId}.checkpoint.json`);
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const fixtureFailures = validateFixtures(demoFixtures);

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

const healthy = await engine.health();
if (!healthy) {
  throw new Error(`Worker health check failed for ${workerUrl}`);
}

const checkpoint = await loadCheckpoint();
const runCreatedAt = checkpoint?.createdAt ?? createdAt;
const scores: CaseScore[] = checkpoint?.scores ?? [];
const outputSnapshots: CaseOutputSnapshot[] = checkpoint?.outputSnapshots ?? [];
const completedCaseIds = new Set(checkpoint?.completedCaseIds ?? []);

for (const [index, fixture] of fixtureSubset.entries()) {
  const progress = `${index + 1}/${fixtureSubset.length}`;
  if (completedCaseIds.has(fixture.case.id)) {
    console.error(`[worker-full-benchmark] ${progress} ${fixture.case.id} skipped from checkpoint`);
    continue;
  }

  console.error(`[worker-full-benchmark] ${progress} ${fixture.case.id}`);

  const workspace = createWorkspace(`full-benchmark-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await refineWithRetry(masked.workspace, fixture.case.id);

  // Full benchmark bütün fixture dataset'ini gerçek worker'a gönderir. Bu artık
  // smoke/dry-run değildir; araştırma hipotezinin dataset geneline yayılıp yayılmadığını
  // görmek için kullanılan ilk tam canlı koşudur.
  scores.push(scoreCase(fixture.case, result.workspace));
  completedCaseIds.add(fixture.case.id);
  outputSnapshots.push({
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    requiredTerms: fixture.case.requiredTerms,
    forbiddenTerms: fixture.case.forbiddenTerms,
    finalResult: result.workspace.finalResult?.summary ?? ""
  });
  await writeCheckpoint({
    runId,
    suiteName,
    workerUrl,
    createdAt: runCreatedAt,
    completedCaseIds: Array.from(completedCaseIds),
    scores,
    outputSnapshots
  });
}

const report = aggregateScores(scores);
const artifact = createBenchmarkArtifact({
  suiteName,
  engineName: "external-dllm-worker-full-benchmark",
  createdAt: runCreatedAt,
  report,
  outputSnapshots
});
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
  createdAt: runCreatedAt
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
      checkpointPath,
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

type FullBenchmarkCheckpoint = {
  runId: string;
  suiteName: string;
  workerUrl: string;
  createdAt: string;
  completedCaseIds: string[];
  scores: CaseScore[];
  outputSnapshots: CaseOutputSnapshot[];
};

async function refineWithRetry(workspace: Parameters<typeof engine.refineWorkspace>[0], caseId: string) {
  const maxAttempts = Number(process.env.BENCHMARK_RETRY_ATTEMPTS ?? "3");
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await engine.refineWorkspace(workspace);
    } catch (error) {
      lastError = error;
      console.error(`[worker-full-benchmark] ${caseId} attempt ${attempt}/${maxAttempts} failed: ${formatError(error)}`);
      if (attempt < maxAttempts) await sleep(1500 * attempt);
    }
  }

  throw lastError;
}

async function writeCheckpoint(checkpoint: FullBenchmarkCheckpoint): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  // Checkpoint her senaryodan sonra yazılır. Uzun GPU koşusunda web terminal,
  // worker veya ağ koparsa aynı run id ile kaldığımız yerden devam edebiliriz.
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function loadCheckpoint(): Promise<FullBenchmarkCheckpoint | undefined> {
  if (process.env.BENCHMARK_RESUME !== "1") return undefined;

  try {
    const raw = await readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(raw) as FullBenchmarkCheckpoint;
    console.error(`[worker-full-benchmark] resuming ${checkpoint.completedCaseIds.length}/${fixtureSubset.length} from ${checkpointPath}`);
    return checkpoint;
  } catch {
    console.error(`[worker-full-benchmark] no checkpoint found at ${checkpointPath}; starting fresh`);
    return undefined;
  }
}

async function resolveRunId(createdAt: string): Promise<string> {
  if (process.env.BENCHMARK_RUN_ID) return process.env.BENCHMARK_RUN_ID;

  if (process.env.BENCHMARK_RESUME === "1") {
    const latest = await latestCheckpointRunId();
    if (latest) return latest;
  }

  return `${createdAt.replace(/[:.]/g, "-")}-worker-full-benchmark`;
}

async function latestCheckpointRunId(): Promise<string | undefined> {
  try {
    const files = await readdir(reportDir);
    const checkpoints = files
      .filter((file) => file.endsWith("-worker-full-benchmark.checkpoint.json"))
      .sort()
      .reverse();
    return checkpoints[0]?.replace(/\.checkpoint\.json$/, "");
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
