import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import { defaultMaskingPolicy, applyMaskingPolicy } from "../../../packages/masking-policy/src/index.js";
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
    const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
    const masked = applyMaskingPolicy(workspace, defaultMaskingPolicy("boundary"));
    const result = await engine.refineWorkspace(masked);
    scores.push(scoreCase(fixture.case, result.workspace));
  }

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
  await mkdir(reportDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(markdownPath, benchmarkArtifactToMarkdown(artifact));

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
