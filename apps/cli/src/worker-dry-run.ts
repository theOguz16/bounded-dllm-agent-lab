import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { aggregateScores, benchmarkArtifactToMarkdown, createBenchmarkArtifact, scoreCase } from "../../../packages/eval-core/src/index.js";
import { createExperimentConfig, createRunManifest, validateRunManifest } from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import { HttpDllmWorkerEngine } from "../../../packages/providers/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";

const workerUrl = process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765";
const engine = new HttpDllmWorkerEngine(workerUrl, "boundary");
const reportDir = "reports";
const suiteName = "worker-dry-run-v1";
const fixtureSubset = demoFixtures.slice(0, 2);
const fixtureFailures = validateFixtures(demoFixtures);

if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
}

const healthy = await engine.health();
if (!healthy) {
  throw new Error(`Worker health check failed for ${workerUrl}`);
}

const scores = [];
for (const fixture of fixtureSubset) {
  const workspace = createWorkspace(`dry-run-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await engine.refineWorkspace(masked.workspace);

  // Dry-run tam benchmark değildir. Burada amaç gerçek worker URL'inin health ve
  // refine sözleşmesini taşıdığını görmek. Skorlar yine üretilir ama model kalitesi
  // yorumu için değil, pipeline'ın rapor/manifest üretebildiğini kanıtlamak içindir.
  scores.push(scoreCase(fixture.case, result.workspace));
}

const report = aggregateScores(scores);
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-worker-dry-run`;
const artifact = createBenchmarkArtifact({
  suiteName,
  engineName: "external-dllm-worker-dry-run",
  createdAt,
  report
});
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const config = createExperimentConfig({
  runId,
  suiteName,
  architectureName: "external-dllm-worker-dry-run",
  engineName: "http-dllm-worker",
  modelName: "external-worker",
  modelVersion: "dry-run",
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
      caseCount: fixtureSubset.length,
      jsonPath,
      markdownPath,
      manifestPath
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
