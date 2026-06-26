import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
  printHelp();
  process.exit(0);
}

const outDir = args["out-dir"] ?? "reports/product-runtime-dogfood";
await mkdir(outDir, { recursive: true });

const actionSmoke = await runCli("product-action-smoke.js", ["--out-dir", outDir]);
const workflowText = await readFile(".github/workflows/bounded-review.yml", "utf8");
const actionText = await readFile("action.yml", "utf8");
const checks = [
  check("workflow_dispatch", workflowText.includes("workflow_dispatch:")),
  check("local_action_uses_repo_root", workflowText.includes("uses: ./")),
  check("pr_comment_upsert", workflowText.includes("updateComment") && workflowText.includes("createComment")),
  check("viewer_output", actionText.includes("viewer-path") && workflowText.includes("viewer-path")),
  check("team_metrics_output", actionText.includes("team-metrics-markdown-path") && workflowText.includes("team-metrics-markdown-path")),
  check("action_smoke_ok", actionSmoke.ok === true)
];
const report = {
  ok: checks.every((item) => item.ok),
  createdAt: new Date().toISOString(),
  actionSmoke,
  checks
};
const jsonPath = join(outDir, "dogfood-validation.json");
const markdownPath = join(outDir, "dogfood-validation.md");

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, `${toMarkdown(report)}\n`);

console.log(JSON.stringify({
  ok: report.ok,
  checkCount: checks.length,
  jsonPath,
  markdownPath,
  actionSmokeOutDir: outDir
}, null, 2));

if (args["fail-on-error"] === "true" && !report.ok) {
  process.exitCode = 1;
}

async function runCli(fileName: string, values: string[]): Promise<Record<string, unknown>> {
  const { spawn } = await import("node:child_process");
  const cliPath = new URL(`./${fileName}`, import.meta.url);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...values], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${fileName} failed with code ${code ?? "unknown"}: ${stderr}`));
        return;
      }
      const jsonStart = stdout.indexOf("{");
      resolve(JSON.parse(stdout.slice(jsonStart)) as Record<string, unknown>);
    });
  });
}

function check(name: string, ok: boolean): { name: string; ok: boolean } {
  return { name, ok };
}

type DogfoodValidationReport = {
  ok: boolean;
  createdAt: string;
  actionSmoke: Record<string, unknown>;
  checks: Array<{ name: string; ok: boolean }>;
};

function toMarkdown(report: DogfoodValidationReport): string {
  return [
    "# Dogfood Action Validation",
    "",
    `- Created at: ${report.createdAt}`,
    `- Status: ${report.ok ? "pass" : "fail"}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...report.checks.map((item) => `| ${item.name} | ${item.ok ? "pass" : "fail"} |`),
    "",
    "## Action Smoke",
    "",
    `- Output directory: ${String(report.actionSmoke.outDir ?? "(unknown)")}`,
    `- Decision: ${String(report.actionSmoke.decision ?? "(unknown)")}`,
    `- Viewer: ${String(report.actionSmoke.viewerPath ?? "(unknown)")}`
  ].join("\n");
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
  console.log(`Bounded Agent Dogfood Validation

Usage:
  npm run product:dogfood-validation

Options:
  --out-dir <path>     Output directory. Default: reports/product-runtime-dogfood
  --fail-on-error      Exit non-zero when a dogfood check fails.
  --help               Show this help.
`);
}
