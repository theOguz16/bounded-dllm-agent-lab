import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { getArchitectureRunner, parseArchitectureId } from "../../../packages/architecture-core/src/index.js";
import { aggregateScores, benchmarkArtifactToMarkdown, createBenchmarkArtifact,
  scoreCase } from "../../../packages/eval-core/src/index.js";
import { createExperimentConfig, createRunManifest,
  validateRunManifest } from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}
function present(name: string): boolean { return process.argv.includes(name); }
function numberFlag(name: string): number | undefined {
  const value = flag(name); const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function gitCommit(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const architectureId = parseArchitectureId(flag("--architecture") ?? process.env.BOUNDED_DLLM_ARCHITECTURE);
const architecture = getArchitectureRunner(architectureId);
const maxAttempts = numberFlag("--max-attempts") ?? 2;
const fixtureFailures = validateFixtures(demoFixtures);
if (fixtureFailures.length) throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));

const scores = [];
for (const fixture of demoFixtures) {
  const result = await architecture.runFixture(fixture, { maxAttempts });
  scores.push(scoreCase(fixture.case, result.workspace));
}
const report = aggregateScores(scores);
const createdAt = new Date().toISOString();
const runId = `${createdAt.replace(/[:.]/g, "-")}-${architecture.id}`;
const artifact = createBenchmarkArtifact({ suiteName: "demo-bounded-context-v1",
  engineName: architecture.id, createdAt, report });
const reportDir = "reports";
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);
const manifestPath = join(reportDir, `${runId}.manifest.json`);
const config = createExperimentConfig({ runId, suiteName: artifact.suiteName,
  architectureName: architecture.id, engineName: architecture.id, modelName: "mock-dllm",
  modelVersion: "0.1.0", seed: 0, maxAttempts,
  ablation: { maskPolicyEnabled: !present("--disable-mask-policy"),
    verifierEnabled: !present("--disable-verifier"),
    syntheticContextEnabled: present("--enable-synthetic-context"), refinementMaxAttempts: maxAttempts },
  maskPolicyVersion: "role-mask-v1", gitCommit: gitCommit(),
  hardware: { platform: platform(), arch: arch(), cpuCount: cpus().length,
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024) }, createdAt });
const manifest = createRunManifest({ config, report,
  reportPaths: { jsonPath, markdownPath, manifestPath } });
const manifestFailures = validateRunManifest(manifest);
if (manifestFailures.length) throw new Error(JSON.stringify({ ok: false, manifestFailures }, null, 2));
await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, suiteName: artifact.suiteName,
  architectureName: architecture.id, engineName: artifact.engineName,
  caseCount: artifact.report.cases.length, jsonPath, markdownPath, manifestPath,
  summary: { taskSuccessRate: artifact.report.taskSuccessRate,
    scopeDriftRate: artifact.report.scopeDriftRate,
    sensitiveLeakageRate: artifact.report.sensitiveLeakageRate,
    evidenceCoverage: artifact.report.evidenceCoverage } }, null, 2));
