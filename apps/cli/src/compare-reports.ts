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

for (const file of manifestFiles) {
  const path = join(reportDir, file);
  const manifest = JSON.parse(await readFile(path, "utf8")) as ExperimentRunManifest;
  const failures = validateRunManifest(manifest);

  // Comparison komutu kötü manifest'i görmezden gelmez. Çünkü karşılaştırma tablosu
  // bozuk bir run'ı içeri alırsa araştırmacı mimarileri yanlış yorumlayabilir.
  if (failures.length) {
    throw new Error(JSON.stringify({ ok: false, path, failures }, null, 2));
  }

  manifests.push(manifest);
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
      jsonPath,
      markdownPath
    },
    null,
    2
  )
);
