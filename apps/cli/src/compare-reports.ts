import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  comparisonArtifactToMarkdown,
  createComparisonArtifact,
  validateRunManifest,
  type ExperimentRunManifest
} from "../../../packages/experiment-core/src/index.js";

const reportDir = "reports";
const files = await readdir(reportDir);
const manifestFiles = files.filter((file) => file.endsWith(".manifest.json")).sort();
const manifests: ExperimentRunManifest[] = [];
const skippedManifests: Array<{ path: string; failures: string[] }> = [];

for (const file of manifestFiles) {
  const path = join(reportDir, file);
  const manifest = JSON.parse(await readFile(path, "utf8")) as ExperimentRunManifest;
  const failures = validateRunManifest(manifest);

  // Comparison komutu bozuk manifest'i tabloya almaz. Eski veya eksik manifest'leri
  // ayrıca raporlar; böylece araştırmacı hem karşılaştırmayı çalıştırabilir hem de
  // hangi run kayıtlarının yeni lab sözleşmesine uymadığını görür.
  if (failures.length) {
    skippedManifests.push({ path, failures });
    continue;
  }

  manifests.push(manifest);
}

if (!manifests.length) {
  throw new Error(JSON.stringify({ ok: false, skippedManifests }, null, 2));
}

const createdAt = new Date().toISOString();
const artifact = createComparisonArtifact({ createdAt, manifests });
const jsonPath = join(reportDir, "comparison-index.json");
const markdownPath = join(reportDir, "comparison-index.md");

await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(markdownPath, comparisonArtifactToMarkdown(artifact));

console.log(
  JSON.stringify(
    {
      ok: true,
      runCount: artifact.runCount,
      skippedCount: skippedManifests.length,
      skippedManifests,
      jsonPath,
      markdownPath
    },
    null,
    2
  )
);
