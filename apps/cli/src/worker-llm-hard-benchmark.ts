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
import { hardFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import { HttpLlmWorkerEngine } from "../../../packages/providers/src/index.js";
import { isHealthResponse } from "../../../packages/worker-contract/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";

const workerUrl = process.env.LLM_WORKER_URL ?? "http://127.0.0.1:8775";
const engine = new HttpLlmWorkerEngine(workerUrl, "boundary");
const reportDir = "reports";
const suiteName = "llm-hard-baseline-v1";
const fixtureSubset = hardFixtures;
const createdAt = new Date().toISOString();
const runId = await resolveRunId(createdAt);
const checkpointPath = join(reportDir, `${runId}.checkpoint.json`);
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const fixtureFailures = validateFixtures(fixtureSubset, { expectedFamilyCount: 5 });

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

const healthy = await engine.health();
if (!healthy) {
  throw new Error(`LLM worker health check failed for ${workerUrl}`);
}
const workerHealth = await readWorkerHealth(workerUrl);
// Model adı çoğu zaman benchmark terminalinde değil, worker terminalinde env olarak
// tanımlanır. Health metadata'sını okumak manifest'in "hangi model ölçüldü?"
// sorusuna sonradan tahminle değil, çalışan worker'ın kendi beyanıyla cevap verir.
const modelName = process.env.LLM_MODEL ?? workerHealth.modelName ?? "openai-compatible-model";

const checkpoint = await loadCheckpoint();
const runCreatedAt = checkpoint?.createdAt ?? createdAt;
const scores: CaseScore[] = checkpoint?.scores ?? [];
const outputSnapshots: CaseOutputSnapshot[] = checkpoint?.outputSnapshots ?? [];
const completedCaseIds = new Set(checkpoint?.completedCaseIds ?? []);

for (const [index, fixture] of fixtureSubset.entries()) {
  const progress = `${index + 1}/${fixtureSubset.length}`;
  if (completedCaseIds.has(fixture.case.id)) {
    console.error(`[worker-llm-hard-benchmark] ${progress} ${fixture.case.id} skipped from checkpoint`);
    continue;
  }

  console.error(`[worker-llm-hard-benchmark] ${progress} ${fixture.case.id}`);

  const workspace = createWorkspace(`llm-hard-baseline-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await refineWithRetry(masked.workspace, fixture.case.id);

  // Bu runner'ın amacı dLLM worker'ı tekrar ölçmek değil; aynı hard fixture'ları
  // autoregressive LLM worker'a verip model ailesi karşılaştırmasının ilk gerçek
  // kolonunu üretmektir. Input aynı kalır, oracle yine modele gitmez.
  scores.push(scoreCase(fixture.case, result.workspace));
  completedCaseIds.add(fixture.case.id);
  outputSnapshots.push({
    caseId: fixture.case.id,
    family: fixture.case.family,
    task: fixture.packet.task,
    expectedResult: fixture.case.expectedResult,
    requiredTerms: fixture.case.requiredTerms,
    forbiddenTerms: fixture.case.forbiddenTerms,
    finalResult: result.workspace.finalResult ?? ""
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
  engineName: "external-llm-worker-hard-baseline",
  createdAt: runCreatedAt,
  report,
  outputSnapshots
});
const config = createExperimentConfig({
  runId,
  suiteName,
  architectureName: "external-ar-llm-hard-baseline",
  engineName: "http-llm-worker",
  modelName,
  modelVersion: "hard-baseline",
  workerUrl,
  seed: 0,
  maxAttempts: 1,
  ablation: {
    maskPolicyEnabled: true,
    verifierEnabled: false,
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
      modelName,
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

type LlmHardBenchmarkCheckpoint = {
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
      console.error(`[worker-llm-hard-benchmark] ${caseId} attempt ${attempt}/${maxAttempts} failed: ${formatError(error)}`);
      if (attempt < maxAttempts) await sleep(1500 * attempt);
    }
  }

  throw lastError;
}

async function writeCheckpoint(checkpoint: LlmHardBenchmarkCheckpoint): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  // LLM API koşuları GPU koşuları kadar uzun olmasa bile dış servis hatasına açıktır.
  // Checkpoint aynı case'i tekrar ücretlendirmeden kaldığımız yerden sürdürmemizi sağlar.
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function loadCheckpoint(): Promise<LlmHardBenchmarkCheckpoint | undefined> {
  if (process.env.BENCHMARK_RESUME !== "1") return undefined;

  try {
    const raw = await readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(raw) as LlmHardBenchmarkCheckpoint;
    console.error(`[worker-llm-hard-benchmark] resuming ${checkpoint.completedCaseIds.length}/${fixtureSubset.length} from ${checkpointPath}`);
    return checkpoint;
  } catch {
    console.error(`[worker-llm-hard-benchmark] no checkpoint found at ${checkpointPath}; starting fresh`);
    return undefined;
  }
}

async function resolveRunId(createdAt: string): Promise<string> {
  if (process.env.BENCHMARK_RUN_ID) return process.env.BENCHMARK_RUN_ID;

  if (process.env.BENCHMARK_RESUME === "1") {
    const latest = await latestCheckpointRunId();
    if (latest) return latest;
  }

  return `${createdAt.replace(/[:.]/g, "-")}-llm-hard-baseline`;
}

async function latestCheckpointRunId(): Promise<string | undefined> {
  try {
    const files = await readdir(reportDir);
    const checkpoints = files
      .filter((file) => file.endsWith("-llm-hard-baseline.checkpoint.json"))
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

async function readWorkerHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/health`);
  const body: unknown = await response.json();

  if (!response.ok || !isHealthResponse(body) || body.mode !== "llm") {
    throw new Error(`Invalid LLM worker health response from ${baseUrl}/health`);
  }

  return body;
}
