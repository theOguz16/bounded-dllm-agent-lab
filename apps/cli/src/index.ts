import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import { createMaskedWorkspaceView } from "../../../packages/masking-policy/src/index.js";
import {
  aggregateScores,
  benchmarkArtifactToMarkdown,
  createBenchmarkArtifact,
  scoreCase
} from "../../../packages/eval-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { MockDllmEngine } from "../../../packages/providers/src/index.js";

const engine = new MockDllmEngine();
const scores = [];
const reportDir = "reports";
const fixtureFailures = validateFixtures(demoFixtures);

// Fixture'lar geçersizse CLI hızlıca hata verir. Bu önemli, çünkü bozuk input'a
// sahip bir benchmark modeli yanlış nedenle daha iyi veya daha kötü gösterebilir.
if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
} else {
  for (const fixture of demoFixtures) {
    // Her fixture aynı pipeline'dan geçer: workspace oluştur, gerekli alanı maskele,
    // mock dLLM engine ile refine et, sonra evaluator'a ver. Bu sıralama önemli,
    // çünkü benchmark'ta "hangi model daha iyi?" demeden önce bütün adaylara aynı
    // deney koşulunu vermemiz gerekir.
    const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
    // Issue #6 ile artık doğrudan "şu region'ı maskele" demiyoruz; boundary rolü
    // için tanımlanmış mask view'i oluşturuyoruz. Bu küçük fark ileride aynı fixture'ı
    // planner, implementer, reviewer ve verifier rolleriyle de adil şekilde çalıştırmamızı sağlar.
    const masked = createMaskedWorkspaceView(workspace, "boundary");
    const result = await engine.refineWorkspace(masked.workspace);
    scores.push(scoreCase(fixture.case, result.workspace));
  }

  // Aggregate aşaması tek tek case sonuçlarını araştırma raporuna çevirir.
  // Bir case'in geçmesi tek başına bilimsel sonuç değildir; önemli olan 50 case
  // boyunca drift, leakage, evidence ve trace gibi süreç metriklerinin toplamda
  // nasıl davrandığını görebilmektir.
  const report = aggregateScores(scores);
  const createdAt = new Date().toISOString();
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const artifact = createBenchmarkArtifact({
    suiteName: "demo-bounded-context-v1",
    engineName: engine.name,
    createdAt,
    report
  });
  const jsonPath = join(reportDir, `${safeTimestamp}-demo-bounded-context-v1.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-demo-bounded-context-v1.md`);

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

  // Console çıktısı kısa tutulur; detaylı sonuç dosyalara yazılır. CLI kullanan kişi
  // terminalde rapor yollarını görür, araştırmacı ise JSON/Markdown dosyalarından
  // gerçek analizi yapar.
  console.log(
    JSON.stringify(
      {
        ok: true,
        suiteName: artifact.suiteName,
        engineName: artifact.engineName,
        caseCount: artifact.report.cases.length,
        jsonPath,
        markdownPath,
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
