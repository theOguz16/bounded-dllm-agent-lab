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
import { demoFixtures, validateFixtures, type BenchmarkFixture } from "../../../packages/fixtures/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import { HttpDllmWorkerEngine } from "../../../packages/providers/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";

const workerUrl = process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765";
const engine = new HttpDllmWorkerEngine(workerUrl, "boundary");
const reportDir = "reports";
const suiteName = "worker-mini-benchmark-v1";
const fixtureSubset = selectOneFixturePerFamily(demoFixtures);
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
for (const fixture of fixtureSubset) {
  const workspace = createWorkspace(`mini-benchmark-${fixture.case.id}`, fixture.packet);
  const masked = createMaskedWorkspaceView(workspace, "boundary");
  const result = await engine.refineWorkspace(masked.workspace);

  // Mini benchmark artık bağlantı kontrolü değildir. Her aileden bir senaryo ile
  // gerçek worker'ın correction, sensitive, scope, insufficient ve conflict hata
  // modlarında ilk davranış sinyalini toplar.
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
const runId = `${createdAt.replace(/[:.]/g, "-")}-worker-mini-benchmark`;
const artifact = createBenchmarkArtifact({
  suiteName,
  engineName: "external-dllm-worker-mini-benchmark",
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
  architectureName: "external-dllm-worker-mini-benchmark",
  engineName: "http-dllm-worker",
  modelName: "Dream-org/Dream-Coder-v0-Instruct-7B",
  modelVersion: "mini-benchmark",
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
      families: fixtureSubset.map((fixture) => fixture.family),
      jsonPath,
      markdownPath,
      manifestPath
    },
    null,
    2
  )
);

function selectOneFixturePerFamily(fixtures: BenchmarkFixture[]): BenchmarkFixture[] {
  const families = [
    "correction_override",
    "sensitive_boundary",
    "scope_drift",
    "insufficient_context",
    "conflict_resolution"
  ] as const;

  // Deterministik seçim yapıyoruz: her aileden ilk fixture. Rastgele seçim ilk gerçek
  // GPU koşusunda sonucu yorumlamayı zorlaştırır; burada amacımız tüm ailelerin pipeline'a
  // girdiğini kontrollü biçimde görmek.
  return families.map((family) => {
    const fixture = fixtures.find((item) => item.family === family);
    if (!fixture) throw new Error(`Missing fixture family: ${family}`);
    return fixture;
  });
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
