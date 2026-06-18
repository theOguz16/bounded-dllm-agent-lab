import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { getArchitectureRunner, parseArchitectureId } from "../../../packages/architecture-core/src/index.js";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase
} from "../../../packages/eval-core/src/index.js";
import { createExperimentConfig, createRunManifest, validateRunManifest } from "../../../packages/experiment-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";

const architectureId = parseArchitectureId(readFlag("--architecture") ?? process.env.BOUNDED_DLLM_ARCHITECTURE);
const architecture = getArchitectureRunner(architectureId);
const maxAttempts = readNumberFlag("--max-attempts") ?? 2;
const ablation = {
  maskPolicyEnabled: !hasFlag("--disable-mask-policy"),
  verifierEnabled: !hasFlag("--disable-verifier"),
  syntheticContextEnabled: hasFlag("--enable-synthetic-context"),
  refinementMaxAttempts: maxAttempts
};
const scores = [];
const reportDir = "reports";
const suiteName = "demo-bounded-context-v1";
const fixtureFailures = validateFixtures(demoFixtures);

// Fixture'lar geçersizse CLI hızlıca hata verir. Bu önemli, çünkü bozuk input'a
// sahip bir benchmark modeli yanlış nedenle daha iyi veya daha kötü gösterebilir.
if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
} else {
  for (const fixture of demoFixtures) {
    // Issue #12 ile fixture çalıştırma sorumluluğu architecture runner'a taşındı.
    // Evaluator aynı kalır; sadece "hangi mimari workspace üretti?" değişir. Bu,
    // gerçek deneylerde long-context, RAG, synthetic-context ve bounded dLLM akışlarını
    // aynı case ve aynı metriklerle karşılaştırmanın temelidir.
    const result = await architecture.runFixture(fixture, { maxAttempts });
    scores.push(scoreCase(fixture.case, result.workspace));
  }

  // Aggregate aşaması tek tek case sonuçlarını araştırma raporuna çevirir.
  // Bir case'in geçmesi tek başına bilimsel sonuç değildir; önemli olan 50 case
  // boyunca drift, leakage, evidence ve trace gibi süreç metriklerinin toplamda
  // nasıl davrandığını görebilmektir.
  const report = aggregateScores(scores);
  const createdAt = new Date().toISOString();
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const runId = `${safeTimestamp}-${architecture.id}`;
  const artifact = createBenchmarkArtifact({
    suiteName,
    engineName: architecture.id,
    createdAt,
    report
  });
  const jsonPath = join(reportDir, `${runId}.json`);
  const markdownPath = join(reportDir, `${runId}.md`);
  const manifestPath = join(reportDir, `${runId}.manifest.json`);
  const experimentConfig = createExperimentConfig({
    runId,
    suiteName,
    architectureName: architecture.id,
    engineName: architecture.id,
    modelName: "mock-dllm",
    modelVersion: "0.1.0",
    seed: 0,
    maxAttempts,
    ablation,
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
    config: experimentConfig,
    report,
    reportPaths: {
      jsonPath,
      markdownPath,
      manifestPath
    }
  });
  const manifestFailures = validateRunManifest(manifest);

  if (manifestFailures.length) {
    throw new Error(JSON.stringify({ ok: false, manifestFailures }, null, 2));
  }

  // Issue #4'te stdout çıktısını kalıcı araştırma artifact'ine çeviriyoruz. JSON
  // otomasyon için, Markdown ise insanın hızlı okuması için yazılır. İkisi aynı
  // artifact'ten üretildiği için birbirinden kopuk sonuçlar oluşmaz.
  // Buradaki "artifact" deneyin delil dosyasıdır: ileride aynı benchmark'ı LLM,
  // long-context LLM, RAG tabanlı agent ve bounded dLLM agent üzerinde çalıştırınca
  // hepsi aynı formatta rapor üretecek. Böylece "bence iyi" yerine ölçülebilir
  // karşılaştırma yapabileceğiz.
  await mkdir(reportDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));
  // Issue #11 ile raporun yanına manifest de yazıyoruz. Manifest sonuç metriği değil,
  // deney koşulu kaydıdır. "Bu sonuç hangi commit ve hangi ayarlarla üretildi?"
  // sorusunu cevaplamadığı sürece gerçek model karşılaştırması güvenilir olmaz.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Console çıktısı kısa tutulur; detaylı sonuç dosyalara yazılır. CLI kullanan kişi
  // terminalde rapor yollarını görür, araştırmacı ise JSON/Markdown dosyalarından
  // gerçek analizi yapar.
  console.log(
    JSON.stringify(
      {
        ok: true,
        suiteName: artifact.suiteName,
        architectureName: architecture.id,
        engineName: artifact.engineName,
        caseCount: artifact.report.cases.length,
        jsonPath,
        markdownPath,
        manifestPath,
        summary: {
          taskSuccessRate: artifact.report.taskSuccessRate,
          scopeDriftRate: artifact.report.scopeDriftRate,
          sensitiveLeakageRate: artifact.report.sensitiveLeakageRate,
          evidenceCoverage: artifact.report.evidenceCoverage
        }
      },
      null,
      2
    )
  );
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readNumberFlag(name: string): number | undefined {
  const value = readFlag(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
