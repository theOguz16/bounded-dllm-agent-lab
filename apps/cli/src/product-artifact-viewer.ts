import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderArtifactViewerHtml, type ArtifactViewerIndex } from "../../web/src/index.js";
import type { ReviewOutput, TeamMetricsReport } from "../../../packages/product-runtime/src/index.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const dir = args.dir ?? "reports/product-runtime";
const out = args.out ?? join(dir, "index.html");
const files = await readdir(dir).catch(() => []);
const reviewFiles = files.filter((file) => file.endsWith("-product-review.json")).sort();
const reviews = [];

for (const fileName of reviewFiles) {
  const review = JSON.parse(await readFile(join(dir, fileName), "utf8")) as ReviewOutput;
  reviews.push({ fileName, review });
}

const reportIndex = await readOptionalJson<ArtifactViewerIndex>(join(dir, "product-report-index.json"));
const teamMetrics = await readOptionalJson<TeamMetricsReport>(join(dir, "team-metrics.json"));
const html = renderArtifactViewerHtml({
  title: args.title ?? "Bounded Agent Review Artifacts",
  reviews,
  reportIndex,
  teamMetrics
});

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${html}\n`);

console.log(JSON.stringify({
  ok: true,
  reportCount: reviews.length,
  hasTeamMetrics: Boolean(teamMetrics),
  htmlPath: out
}, null, 2));

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Bounded Agent Artifact Viewer

Usage:
  npm run product:artifact-viewer -- --dir reports/product-runtime

Options:
  --dir <path>    Directory containing product runtime artifacts.
  --out <path>    Output HTML path. Default: <dir>/index.html
  --title <text>  Viewer page title.
  --help          Show this help.
`);
}
