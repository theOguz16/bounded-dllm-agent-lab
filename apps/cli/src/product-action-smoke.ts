import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUnifiedDiff, reviewPatch } from "../../../packages/product-runtime/src/index.js";
import { parsePolicy } from "./product-policy-utils.js";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? await mkdtemp(join(tmpdir(), "bounded-action-smoke-"));
const keep = args.keep === "true" || Boolean(args["out-dir"]);
const marker = args.marker ?? "<!-- bounded-agent-review -->";

try {
  await runSmoke(outDir, marker);
} finally {
  if (!keep) await rm(outDir, { recursive: true, force: true });
}

async function runSmoke(outDir: string, marker: string): Promise<void> {
  const taskPath = "examples/product-runtime/tasks/repo-dogfood.md";
  const diffPath = "examples/product-runtime/diffs/repo-package-remask.diff";
  const policyPath = "bounded-agent.policy.yml";
  const taskText = await readFile(taskPath, "utf8");
  const diffText = await readFile(diffPath, "utf8");
  const policyText = await readFile(policyPath, "utf8");
  const review = reviewPatch({
    task: {
      id: "action-smoke",
      title: "Action smoke bounded review",
      description: taskText,
      authorityFacts: taskText
        .split("\n")
        .filter((line) => line.toLowerCase().includes("authority:"))
        .map((line) => line.trim())
    },
    diff: parseUnifiedDiff(diffText),
    policy: parsePolicy(policyText, policyPath)
  });

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const reviewPath = join(outDir, "action-smoke-product-review.json");
  const markdownPath = join(outDir, "action-smoke-product-review.md");
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  await writeFile(markdownPath, `${review.markdownReport}\n`);

  await runCli("product-comment.js", [
    "--review",
    reviewPath,
    "--out",
    join(outDir, "pr-comment.md"),
    "--marker",
    marker
  ]);
  await runCli("product-report-index.js", [
    "--dir",
    outDir,
    "--out-dir",
    outDir
  ]);
  await runCli("product-team-metrics.js", [
    "--dir",
    outDir,
    "--out-dir",
    outDir
  ]);
  await runCli("product-artifact-viewer.js", [
    "--dir",
    outDir,
    "--out",
    join(outDir, "index.html"),
    "--title",
    "Bounded Agent Action Smoke"
  ]);

  const comment = await readFile(join(outDir, "pr-comment.md"), "utf8");
  const indexJson = JSON.parse(await readFile(join(outDir, "product-report-index.json"), "utf8")) as { count?: number };
  const teamMetricsJson = JSON.parse(await readFile(join(outDir, "team-metrics.json"), "utf8")) as { artifactCount?: number };
  const viewerHtml = await readFile(join(outDir, "index.html"), "utf8");

  if (review.decision !== "remask_required") {
    throw new Error(`Expected remask_required action smoke decision, got ${review.decision}`);
  }
  if (!comment.includes(marker)) {
    throw new Error("PR comment artifact does not include the configured marker.");
  }
  if (indexJson.count !== 1) {
    throw new Error(`Expected report index count=1, got ${String(indexJson.count)}`);
  }
  if (teamMetricsJson.artifactCount !== 1) {
    throw new Error(`Expected team metrics artifactCount=1, got ${String(teamMetricsJson.artifactCount)}`);
  }
  if (!viewerHtml.includes("Bounded Agent Action Smoke")) {
    throw new Error("Artifact viewer HTML was not generated with the expected title.");
  }

  console.log(JSON.stringify({
    ok: true,
    outDir,
    decision: review.decision,
    commentPath: join(outDir, "pr-comment.md"),
    indexJsonPath: join(outDir, "product-report-index.json"),
    indexMarkdownPath: join(outDir, "product-report-index.md"),
    teamMetricsJsonPath: join(outDir, "team-metrics.json"),
    teamMetricsMarkdownPath: join(outDir, "team-metrics.md"),
    viewerPath: join(outDir, "index.html")
  }, null, 2));
}

async function runCli(fileName: string, values: string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cliPath = new URL(`./${fileName}`, import.meta.url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...values], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${fileName} failed with code ${code ?? "unknown"}: ${stderr}`));
    });
  });
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Bounded Agent Action Smoke

Usage:
  npm run product:action-smoke
  npm run product:action-smoke -- --out-dir /tmp/bounded-action-smoke

Options:
  --out-dir <path>  Keep generated artifacts in this directory.
  --marker <text>   Expected PR comment marker.
  --keep            Keep temp output when --out-dir is not supplied.
  --help            Show this help.
`);
}
